import { getClient, openRun, closeRun, isMissingRelationError } from '../lib/db.js';
import { assertRunApproved, RunNotApprovedError } from '../lib/errors.js';
import { pickBillText } from '../review/server.js';
import {
  getAnthropicClient, MAX_TEXT_CHARS,
  OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
} from '../lib/summarizer.js';
import {
  verifyBill, VERIFIER_MODEL, VERIFY_PROMPT_VERSION, assessVerdicts, VerificationIncompleteError,
} from '../lib/verifier.js';
import { parseBullets } from '../../site/js/summary-parse.js';

export { parseBullets };

// M4 (task review fix round 1): verifyBill is a comparably-sized bill-level call to the
// summarizeBill golden.js/summarize.js already estimate at $0.11 — same order of magnitude, no
// independently-metered figure exists for verification alone, so the same estimate is reused
// rather than invented from nothing.
export const VERIFY_COST_PER_SUMMARY_USD = 0.11;
const FAILURE_TYPES = [OversizeTextError, SummaryRefusedError, SummaryTruncatedError, VerificationIncompleteError];
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

// Raw '- ' line count, independent of parseBullets' stricter well-formedness requirement (must
// also end in ')' with a recoverable ' (' split point). A bullet edited to drop its trailing
// '(section)' still matches this but not parseBullets — that gap is exactly what checkBulletCoverage
// below catches (pre-merge finding 2).
function countRawBulletLines(bodyMd) {
  return String(bodyMd || '').split('\n').filter((raw) => /^- /.test(raw.trim())).length;
}

// A body_md bullet edited to lose its trailing '(section)' silently vanishes from parseBullets'
// output — and therefore from verification — while still rendering publicly on the review page.
// Comparing parseBullets' count against a raw '- ' line count catches that drop before the
// (now-incomplete) bullet set is even sent to the verifier model. Pure, throws.
export function checkBulletCoverage(identifier, bodyMd, bullets) {
  const raw = countRawBulletLines(bodyMd);
  if (bullets.length !== raw) {
    throw new VerificationIncompleteError(
      `summary for ${identifier}: body_md has ${raw} raw '- ' bullet line(s) but only ${bullets.length} parsed as citable — an edited/uncited bullet is invisible to verification`,
      { identifier, raw, parsed: bullets.length },
    );
  }
}

// isMissingRelationError itself now lives in ../lib/db.js (shared with the review server — see
// that module for why). In --dry-run mode a missing table is tolerated (controller ruling #3);
// in live mode it is deliberately NOT caught anywhere — it's a gate.

function isTypedFailure(err) {
  return FAILURE_TYPES.some((T) => err instanceof T);
}

// checkVerifyApproval (task 1, 2026-07-31): the mechanical per-run spend gate verify.js lacked —
// this file bills Lance's Anthropic account (adversarial summary verification) and previously ran
// with no gate at all, against the owner's standing spend hold and against CLAUDE.md's own stated
// policy ("Mechanical enforcement exists where possible — extend that pattern to new
// model-calling tools"). Thin, exported wrapper around the shared assertRunApproved (lib/errors.js)
// so this exact wiring — env var name, action wording — is directly testable without needing a
// fake DB/Anthropic client at all. See main() below for the call site: fires after the --dry-run
// branch has already returned and before getAnthropicClient() is called.
export function checkVerifyApproval(envValue) {
  assertRunApproved(envValue, {
    envVar: 'VERIFY_RUN_APPROVED', action: 'verification', detail: 'adversarial summary verification',
  });
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
  const identifier = summary.bills ? summary.bills.identifier : summary.bill_id;
  const bullets = parseBullets(summary.body_md);
  // Fail fast, before any DB text lookup or model call, if an edited bullet already lost its
  // citation and vanished from what parseBullets recognized (finding 2).
  checkBulletCoverage(identifier, summary.body_md, bullets);

  const { data: texts, error: tErr } = await client
    .from('bill_texts').select('content,content_hash,retrieved_at').eq('bill_id', summary.bill_id);
  if (tErr) throw new Error(`bill_texts lookup failed: ${tErr.message}`);
  const textRow = pickBillText(texts ?? [], summary.bill_text_hash);
  if (!textRow) throw new Error(`no bill text on file for bill ${summary.bill_id}`);

  const { json } = await verifyBill(anthropic, { identifier, bullets, text: textRow.content });

  // Mechanical completeness gate (finding 1): overall is DERIVED here, never trusted from the
  // model's own json.overall. An incomplete/inconsistent verdict set stores nothing — it's
  // recorded as a typed failure instead, leaving the summary honestly 'unverified'.
  const { complete, overall } = assessVerdicts(json.verdicts, bullets.length);
  if (!complete) {
    throw new VerificationIncompleteError(
      `summary for ${identifier} (id ${summary.id}): verifier returned an incomplete or inconsistent verdict set for ${bullets.length} bullet(s)`,
      { identifier, summaryId: summary.id, bulletCount: bullets.length },
    );
  }

  const { error: insErr } = await client.from(VERIFICATIONS_TABLE).insert({
    summary_id: summary.id, verdicts: json.verdicts, overall,
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

  // M4 (task review fix round 1): cost estimate printed before the gate, gloss.js's own voice —
  // both files already know their candidate count at this point (unverified.length).
  const estimate = (unverified.length * VERIFY_COST_PER_SUMMARY_USD).toFixed(2);
  console.log(`Cost estimate: ${unverified.length} summary(ies) x ~$${VERIFY_COST_PER_SUMMARY_USD.toFixed(2)} = ~$${estimate} in live model calls (adversarial summary verification).`);

  // Mechanical per-run approval gate (task 1) — same standing policy as GLOSS_RUN_APPROVED in
  // gloss.js/extract-terms.js and GOLDEN_CHECK_APPROVED in golden.js: no live, billed Anthropic
  // call runs without Lance's explicit per-run opt-in. Caught locally (not left to propagate to
  // main().catch below) so the CLI prints the same clean single BLOCKED line gloss.js does,
  // never a raw stack trace.
  try {
    checkVerifyApproval(process.env.VERIFY_RUN_APPROVED);
  } catch (err) {
    if (err instanceof RunNotApprovedError) {
      console.log(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
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
