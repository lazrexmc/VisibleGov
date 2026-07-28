import { getClient, openRun, closeRun } from '../lib/db.js';
import { pickBillText } from '../review/server.js';
import {
  getAnthropicClient, MAX_TEXT_CHARS,
  OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
} from '../lib/summarizer.js';
import { verifyBill, VERIFIER_MODEL, VERIFY_PROMPT_VERSION } from '../lib/verifier.js';

const FAILURE_TYPES = [OversizeTextError, SummaryRefusedError, SummaryTruncatedError];
// Same target set as summarize.js's staleness handling: a draft is the normal unreviewed state,
// stale means the text moved out from under an existing draft — both need a fresh verification.
// approved/published/rejected summaries are out of scope for this pass.
const TARGET_STATUSES = ['draft', 'stale'];
const VERIFICATIONS_TABLE = 'summary_verifications';

export function parseArgs(argv) {
  const out = { dryRun: false };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') {
      out.dryRun = true;
      i += 1;
      continue;
    }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

// The renderer's inverse (summarizer.js's renderMarkdown): bullets render as
// `- <point> (<section>)`. Section strings can themselves contain parentheses (e.g. "Sec. 2(b)"),
// so the point/section split point is the LAST ' (' before the line end, not the first
// (controller ruling #2) — that's the one renderMarkdown itself always inserts as the wrapper.
export function parseBullets(bodyMd) {
  const lines = String(bodyMd || '').split('\n');
  const bullets = [];
  let index = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('- ') || !line.endsWith(')')) continue;
    const rest = line.slice(2);
    const splitAt = rest.lastIndexOf(' (');
    if (splitAt === -1) continue;
    bullets.push({ index, point: rest.slice(0, splitAt), section: rest.slice(splitAt + 2, -1) });
    index += 1;
  }
  return bullets;
}

// Detects "relation does not exist", whether reported as a raw Postgres error (undefined_table,
// 42P01) or PostgREST's own "not in schema cache" shape (seen when a table was never created —
// e.g. before migration 0004 is applied). Callers decide what to do with it; this is pure
// detection only. In --dry-run mode a missing table is tolerated (controller ruling #3); in live
// mode it is deliberately NOT caught anywhere — it's a gate.
export function isMissingRelationError(error, table) {
  if (!error) return false;
  const code = error.code;
  const msg = String(error.message || '').toLowerCase();
  const mentionsTable = msg.includes(table.toLowerCase());
  // The Postgres/PostgREST error codes for "relation doesn't exist" are the same regardless of
  // WHICH relation — the table name only shows up in the message — so even a code match must
  // still be confirmed against the message to avoid matching a different missing table.
  if (code === '42P01' || code === 'PGRST205') return mentionsTable;
  return mentionsTable && (msg.includes('does not exist') || msg.includes('could not find the table'));
}

function isTypedFailure(err) {
  return FAILURE_TYPES.some((T) => err instanceof T);
}

// ---- DB-facing helpers ----

async function loadCandidateSummaries(client) {
  const { data, error } = await client
    .from('summaries')
    .select('id,bill_id,status,body_md,bill_text_hash,created_at,bills(identifier,title)')
    .in('status', TARGET_STATUSES)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`summaries lookup failed: ${error.message}`);
  return data ?? [];
}

// Returns {verifiedIds, tableMissing}. Missing-table tolerance applies ONLY when dryRun is true
// (controller ruling #3 amendment) — in live mode the error propagates and aborts the run before
// any model calls are made.
async function loadAlreadyVerifiedIds(client, summaryIds, dryRun) {
  if (summaryIds.length === 0) return { verifiedIds: new Set(), tableMissing: false };
  const { data, error } = await client
    .from(VERIFICATIONS_TABLE).select('summary_id').in('summary_id', summaryIds);
  if (error) {
    if (dryRun && isMissingRelationError(error, VERIFICATIONS_TABLE)) {
      return { verifiedIds: new Set(), tableMissing: true };
    }
    throw new Error(`${VERIFICATIONS_TABLE} lookup failed: ${error.message}`);
  }
  return { verifiedIds: new Set((data ?? []).map((r) => r.summary_id)), tableMissing: false };
}

async function verifyOne(client, summary, anthropic) {
  const bullets = parseBullets(summary.body_md);
  const { data: texts, error: tErr } = await client
    .from('bill_texts').select('content,content_hash,retrieved_at').eq('bill_id', summary.bill_id);
  if (tErr) throw new Error(`bill_texts lookup failed: ${tErr.message}`);
  const textRow = pickBillText(texts ?? [], summary.bill_text_hash);
  if (!textRow) throw new Error(`no bill text on file for bill ${summary.bill_id}`);

  const identifier = summary.bills ? summary.bills.identifier : summary.bill_id;
  const { json } = await verifyBill(anthropic, { identifier, bullets, text: textRow.content });

  const { error: insErr } = await client.from(VERIFICATIONS_TABLE).insert({
    summary_id: summary.id, verdicts: json.verdicts, overall: json.overall,
    model: VERIFIER_MODEL, prompt_version: VERIFY_PROMPT_VERSION,
  });
  if (insErr) throw new Error(`${VERIFICATIONS_TABLE} insert failed for summary ${summary.id}: ${insErr.message}`);
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

  const summaries = await loadCandidateSummaries(client);
  const { verifiedIds, tableMissing } = await loadAlreadyVerifiedIds(client, summaries.map((s) => s.id), args.dryRun);
  const unverified = summaries.filter((s) => !verifiedIds.has(s.id));

  if (args.dryRun) {
    const out = {
      mode: 'dry-run',
      counts: { candidates: summaries.length, unverified: unverified.length },
      unverified: unverified.map((s) => ({ id: s.id, status: s.status, identifier: s.bills ? s.bills.identifier : null })),
    };
    if (tableMissing) out.note = '(summary_verifications missing — 0004 not applied; treating all as unverified)';
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const anthropic = getAnthropicClient();
  if (!anthropic) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'ANTHROPIC_API_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const runId = await openRun(client, 'verify');
  const failures = [];
  try {
    let verified = 0;
    for (const summary of unverified) {
      try {
        await verifyOne(client, summary, anthropic);
        verified += 1;
      } catch (err) {
        if (isTypedFailure(err)) {
          failures.push({ id: summary.id, error: err.name, message: err.message });
        } else {
          throw err;
        }
      }
    }

    const counts = { candidates: summaries.length, verified, failures: failures.length };
    const status = failures.length === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { counts, failures });
    console.log(JSON.stringify({ mode: 'live', run_id: runId, status, counts, failures }, null, 2));
    if (failures.length > 0) process.exitCode = 2;
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
