import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClient } from '../lib/db.js';
import { parseBullets } from './verify.js';
import { pickBillText } from '../review/server.js';
import { getAnthropicClient, summarizeBill, PROMPT_VERSION } from '../lib/summarizer.js';

// Golden-set mechanism (Task 8): snapshot approved/published summaries as a structural baseline,
// then --check re-runs the CURRENT prompt against the SAME stored bill text and diffs the two
// summary shapes. Holding the input text constant isolates prompt drift from text drift — see
// runCheck below, which looks up bill_texts by the golden's own bill_text_hash, not "current" text.
const SNAPSHOT_STATUSES = ['approved', 'published'];
const COST_PER_BILL_USD = 0.11;
const DRIFT_THRESHOLD = 0.3; // >30% of golden section citations missing from fresh => drift

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDENS_DIR = path.join(__dirname, '..', '..', 'goldens');

export function parseArgs(argv) {
  const out = { mode: null };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--snapshot' || key === '--check') {
      if (out.mode) throw new Error(`only one of --snapshot or --check may be given (got --snapshot and --check)`);
      out.mode = key === '--snapshot' ? 'snapshot' : 'check';
      i += 1;
      continue;
    }
    throw new Error(`unknown flag: ${key}`);
  }
  if (!out.mode) throw new Error('one of --snapshot or --check is required');
  return out;
}

// ---- structural comparison (pure, exported) ----

function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// golden/fresh are summary JSON shapes: {what_it_does: [{point, section}], stated_purpose, classification}.
// Controller ruling: a null golden.classification means "not recoverable from the stored body_md"
// (see buildGoldenJson) — treated as not comparable, never a drift signal on its own.
export function compareSummaries(golden, fresh) {
  const classificationChanged = golden.classification !== null
    && golden.classification !== fresh.classification;

  const purposeChanged = normalizeWhitespace(golden.stated_purpose) !== normalizeWhitespace(fresh.stated_purpose);

  const goldenSections = (golden.what_it_does || []).map((b) => b.section);
  const freshSections = new Set((fresh.what_it_does || []).map((b) => b.section));
  const missingSections = goldenSections.filter((s) => !freshSections.has(s));
  const missingRatio = goldenSections.length === 0 ? 0 : missingSections.length / goldenSections.length;

  const bulletCountDelta = (fresh.what_it_does || []).length - (golden.what_it_does || []).length;
  const drift = classificationChanged || purposeChanged || missingRatio > DRIFT_THRESHOLD;

  return { classificationChanged, purposeChanged, bulletCountDelta, missingSections, drift };
}

// ---- golden JSON reconstruction from a stored summary row (snapshot side) ----

const STATED_PURPOSE_MARKER = '**Stated purpose (from the bill):**';

// renderMarkdown (summarizer.js) writes stated_purpose as a trailing paragraph after this exact
// marker, only when non-empty. This is its inverse — parseBullets is already the inverse for
// what_it_does, reused (not reimplemented) from verify.js.
export function parseStatedPurpose(bodyMd) {
  const text = String(bodyMd || '');
  const idx = text.indexOf(STATED_PURPOSE_MARKER);
  if (idx === -1) return '';
  return text.slice(idx + STATED_PURPOSE_MARKER.length).trim();
}

// classification is NEVER written into body_md by renderMarkdown, so it is not recoverable from
// a stored summary row — stored null. compareSummaries treats a null golden classification as
// "not comparable" rather than drift (see above).
export function buildGoldenJson(bodyMd) {
  const what_it_does = parseBullets(bodyMd).map(({ point, section }) => ({ point, section }));
  return { what_it_does, stated_purpose: parseStatedPurpose(bodyMd), classification: null };
}

export function goldenFilename(identifier) {
  return `${identifier.replace(/ /g, '-')}.json`;
}

// ---- DB-facing helpers ----

async function loadGoldenCandidates(client) {
  const { data, error } = await client
    .from('summaries')
    .select('id,bill_id,status,body_md,bill_text_hash,prompt_version,created_at,bills(identifier)')
    .in('status', SNAPSHOT_STATUSES)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`summaries lookup failed: ${error.message}`);
  return data ?? [];
}

function readGoldenFiles() {
  if (!fs.existsSync(GOLDENS_DIR)) return [];
  return fs.readdirSync(GOLDENS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(GOLDENS_DIR, f), 'utf8')));
}

// ---- --snapshot: DB reads + local file writes only, no model calls ----

async function runSnapshot(client) {
  const rows = await loadGoldenCandidates(client);

  // A bill can accumulate more than one approved/published row over time (each generation is a
  // fresh insert — see summarize.js); last-by-created_at wins, same "current" convention used
  // elsewhere (planWork, pickBillText).
  const byIdentifier = new Map();
  for (const row of rows) {
    const identifier = row.bills ? row.bills.identifier : null;
    if (!identifier) continue;
    byIdentifier.set(identifier, row);
  }

  fs.mkdirSync(GOLDENS_DIR, { recursive: true });
  const written = [];
  for (const [identifier, row] of byIdentifier) {
    const golden = {
      identifier,
      bill_text_hash: row.bill_text_hash,
      prompt_version: row.prompt_version,
      json: buildGoldenJson(row.body_md),
    };
    fs.writeFileSync(path.join(GOLDENS_DIR, goldenFilename(identifier)), `${JSON.stringify(golden, null, 2)}\n`);
    written.push(identifier);
  }

  console.log(JSON.stringify({
    mode: 'snapshot',
    counts: { candidates: rows.length, distinctBills: byIdentifier.size, written: written.length },
    written,
  }, null, 2));
}

// ---- --check: re-runs the CURRENT prompt per golden and diffs. NOT run live by this task — see
// task-8-report.md. Costs real money per bill; gated on GOLDEN_CHECK_APPROVED per the owner's
// standing per-run-approval policy for any live model call. ----

async function runCheck(client) {
  const goldens = readGoldenFiles();
  if (goldens.length === 0) {
    console.log(JSON.stringify({ mode: 'check', note: 'no goldens found in goldens/ — run --snapshot first' }, null, 2));
    return;
  }

  const estimate = (goldens.length * COST_PER_BILL_USD).toFixed(2);
  console.log(`Cost estimate: ${goldens.length} bill(s) x ~$${COST_PER_BILL_USD.toFixed(2)} = ~$${estimate} in live model calls.`);

  if (process.env.GOLDEN_CHECK_APPROVED !== 'yes') {
    console.log(
      'BLOCKED: --check makes live, billed Anthropic API calls. Per the owner\'s standing policy, '
      + 'each run requires his explicit per-run approval — set GOLDEN_CHECK_APPROVED=yes to proceed.',
    );
    process.exitCode = 1;
    return;
  }

  const anthropic = getAnthropicClient();
  if (!anthropic) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'ANTHROPIC_API_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const results = [];
  let anyDrift = false;
  for (const golden of goldens) {
    const { data: billRows, error: billErr } = await client
      .from('bills').select('id,title').eq('identifier', golden.identifier).limit(1);
    if (billErr) throw new Error(`bills lookup failed: ${billErr.message}`);
    const bill = billRows && billRows[0];
    if (!bill) {
      results.push({ identifier: golden.identifier, result: 'ERROR', message: 'no bill found for identifier' });
      anyDrift = true;
      console.log(`ERROR ${golden.identifier}: no bill found for identifier`);
      continue;
    }

    const { data: texts, error: tErr } = await client
      .from('bill_texts').select('content,content_hash,retrieved_at').eq('bill_id', bill.id);
    if (tErr) throw new Error(`bill_texts lookup failed: ${tErr.message}`);
    const textRow = pickBillText(texts ?? [], golden.bill_text_hash);
    if (!textRow) {
      results.push({ identifier: golden.identifier, result: 'ERROR', message: 'no bill text on file' });
      anyDrift = true;
      console.log(`ERROR ${golden.identifier}: no bill text on file`);
      continue;
    }
    if (textRow.content_hash !== golden.bill_text_hash) {
      // pickBillText fell back to the most-recently-retrieved row — the bill text itself moved
      // since this golden was snapshotted, so any drift found below is confounded with a text
      // change, not isolated to the prompt. Surface it rather than silently treating it as pure
      // prompt drift.
      results.push({ identifier: golden.identifier, result: 'ERROR', message: 'stored bill text no longer matches golden.bill_text_hash — re-snapshot needed before this comparison is meaningful' });
      anyDrift = true;
      console.log(`ERROR ${golden.identifier}: bill_text_hash mismatch, re-snapshot needed`);
      continue;
    }

    const { json: freshJson } = await summarizeBill(anthropic, {
      identifier: golden.identifier, title: bill.title, text: textRow.content,
    });
    const comparison = compareSummaries(golden.json, freshJson);
    const result = comparison.drift ? 'DRIFT' : 'PASS';
    results.push({ identifier: golden.identifier, result, comparison });
    if (comparison.drift) anyDrift = true;
    console.log(`${result} ${golden.identifier}`);
  }

  console.log(JSON.stringify({ mode: 'check', prompt_version: PROMPT_VERSION, results }, null, 2));
  if (anyDrift) process.exitCode = 2;
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (args.mode === 'snapshot') {
    await runSnapshot(client);
    return;
  }
  await runCheck(client);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
