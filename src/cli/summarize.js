import { getClient, openRun, closeRun, insertIfAbsent, isMissingRelationError } from '../lib/db.js';
import { SourceFetchError } from '../lib/errors.js';
import { billTypeSlug } from '../adapters/us-congress.js';
import { parseTextVersions, pickTextUrl, stripHtml, sha256, fetchBillTextVersions, fetchTextBody } from '../adapters/us-congress-text.js';
import {
  getAnthropicClient, summarizeBill, MODEL, PROMPT_VERSION,
  OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
} from '../lib/summarizer.js';
import {
  persistReferencedTerms, GLOSSARY_TERMS_TABLE, SUMMARY_TERMS_TABLE,
} from '../lib/glossary-terms.js';

const JURISDICTION = 'us-congress';
const FAILURE_TYPES = [SourceFetchError, OversizeTextError, SummaryRefusedError, SummaryTruncatedError];
// A summary in any of these statuses, at the current text hash, is "already summarized" — skip
// it. 'approved' means an editor signed off but hasn't published yet; it must not be
// re-summarized (would duplicate a paid API call and insert a redundant draft row).
const ALREADY_SUMMARIZED_STATUSES = new Set(['draft', 'approved', 'published']);

export function parseArgs(argv) {
  const out = { dryRun: false, bill: null };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') {
      out.dryRun = true;
      i += 1;
      continue;
    }
    if (key === '--bill') {
      out.bill = argv[i + 1];
      i += 2;
      continue;
    }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

// Pure routing logic (no I/O). bills: {id, identifier}[]; texts: {bill_id, content_hash}[]
// (one row per bill — the caller has already resolved "current" text per bill, e.g. the most
// recently retrieved version); summaries: {bill_id, bill_text_hash, status}[] (assumed ordered
// oldest-first so the last entry per bill_id wins as "current" — matches how they're loaded by
// created_at ascending in main()).
export function planWork(bills, texts, summaries) {
  const textByBill = new Map(texts.map((t) => [t.bill_id, t]));
  const summaryByBill = new Map();
  for (const s of summaries) summaryByBill.set(s.bill_id, s); // last wins = most recent

  const needText = [];
  const needSummary = [];
  const stale = [];

  for (const bill of bills) {
    const text = textByBill.get(bill.id);
    if (!text) {
      needText.push(bill); // no current text at all — can't summarize until fetched
      continue;
    }
    const summary = summaryByBill.get(bill.id);
    if (!summary) {
      needSummary.push(bill);
      continue;
    }
    if (summary.bill_text_hash !== text.content_hash) {
      stale.push(summary); // existing summary no longer matches the current text — mark stale
      needSummary.push(bill); // ...and regenerate
      continue;
    }
    if (!ALREADY_SUMMARIZED_STATUSES.has(summary.status)) {
      // e.g. 'rejected' at the current hash — not "already summarized", needs a fresh draft
      needSummary.push(bill);
    }
    // else: draft/approved/published summary already matches the current text — nothing to do
  }

  return { needText, needSummary, stale };
}

// ---- DB-facing helpers ----

async function loadFederalBills(client, billFilter) {
  const { data: sessions, error: sessionsErr } = await client.from('sessions').select('id,identifier').eq('jurisdiction_id', JURISDICTION);
  if (sessionsErr) throw new Error(`sessions lookup failed: ${sessionsErr.message}`);
  const sessionIds = sessions.map((s) => s.id);
  if (sessionIds.length === 0) return [];
  const sessionIdentifierById = new Map(sessions.map((s) => [s.id, s.identifier]));

  let billQuery = client.from('bills').select('id,identifier,title,canonical_url,session_id').in('session_id', sessionIds);
  if (billFilter) billQuery = billQuery.eq('identifier', billFilter);
  const { data: billRows, error: billsErr } = await billQuery;
  if (billsErr) throw new Error(`bills lookup failed: ${billsErr.message}`);

  let eligibleIds = null; // null = no vote filter applied (named-bill mode)
  if (!billFilter) {
    const { data: voteRows, error: votesErr } = await client.from('votes').select('bill_id').not('bill_id', 'is', null);
    if (votesErr) throw new Error(`votes lookup failed: ${votesErr.message}`);
    eligibleIds = new Set(voteRows.map((v) => v.bill_id));
  }

  return billRows
    .filter((b) => eligibleIds === null || eligibleIds.has(b.id))
    .map((b) => ({
      id: b.id, identifier: b.identifier, title: b.title, canonical_url: b.canonical_url,
      congress: sessionIdentifierById.get(b.session_id),
    }));
}

async function loadCurrentState(client, bills) {
  const billIds = bills.map((b) => b.id);
  if (billIds.length === 0) return { currentTexts: [], textRowByBill: new Map(), summaries: [] };

  const { data: textRows, error: textsErr } = await client.from('bill_texts')
    .select('bill_id,version,content,content_hash,retrieved_at').in('bill_id', billIds);
  if (textsErr) throw new Error(`bill_texts lookup failed: ${textsErr.message}`);

  const { data: summaryRows, error: summariesErr } = await client.from('summaries')
    .select('bill_id,status,bill_text_hash,created_at').in('bill_id', billIds).order('created_at', { ascending: true });
  if (summariesErr) throw new Error(`summaries lookup failed: ${summariesErr.message}`);

  // "Current" text per bill = the most recently retrieved row (a bill can accumulate rows
  // across multiple text-version types over time; only the newest matters for staleness).
  const textRowByBill = new Map();
  for (const row of textRows ?? []) {
    const existing = textRowByBill.get(row.bill_id);
    if (!existing || (row.retrieved_at ?? '') > (existing.retrieved_at ?? '')) textRowByBill.set(row.bill_id, row);
  }
  const currentTexts = [...textRowByBill.values()].map((r) => ({ bill_id: r.bill_id, content_hash: r.content_hash }));

  return { currentTexts, textRowByBill, summaries: summaryRows ?? [] };
}

// pickTextUrl throws a plain Error ('no fetchable text format...') when a bill's text versions
// have no fetchable format — that is a per-bill data-shape problem, not a code bug, so it must
// be recorded in failures[] like any other source problem (skip != empty), never abort the
// whole batch. Wrap it as a typed SourceFetchError so the isTypedFailure() gate at the call
// site catches it; pass any already-typed error straight through.
export function wrapTextFormatError(err) {
  if (err instanceof SourceFetchError) return err;
  return new SourceFetchError(err.message, { source: 'us-congress' });
}

// Fetches + stores text for a bill with none yet. Honors "don't refetch a version_type already
// stored" by checking bill_texts before making the (network) body fetch.
async function ensureText(client, runId, bill) {
  const slug = billTypeSlug(bill.identifier);
  const number = bill.identifier.split(' ')[1];
  const versionsJson = await fetchBillTextVersions(bill.congress, slug, number);
  let picked;
  try {
    picked = pickTextUrl(parseTextVersions(versionsJson));
  } catch (err) {
    throw wrapTextFormatError(err);
  }

  const { data: existing, error: existingErr } = await client.from('bill_texts')
    .select('bill_id,version,content,content_hash')
    .eq('bill_id', bill.id).eq('version', picked.version_type).maybeSingle();
  if (existingErr) throw new Error(`bill_texts lookup failed: ${existingErr.message}`);
  if (existing) return existing;

  const body = await fetchTextBody(picked.url);
  const content = stripHtml(body);
  const content_hash = sha256(content);
  const row = {
    bill_id: bill.id, version: picked.version_type, content, content_hash,
    source_url: picked.url, retrieved_at: new Date().toISOString(), run_id: runId,
  };
  await insertIfAbsent(client, 'bill_texts', [row], 'bill_id,version');
  return row;
}

async function markStale(client, staleSummaries) {
  for (const s of staleSummaries) {
    const { error } = await client.from('summaries').update({ status: 'stale' })
      .eq('bill_id', s.bill_id).eq('status', s.status);
    if (error) throw new Error(`marking summary stale for bill ${s.bill_id} failed: ${error.message}`);
  }
}

// persistReferencedTermsGracefully: the summarize.js-specific policy wrapper around
// glossary-terms.js's persistReferencedTerms — factored out (same rationale as gloss.js's
// persistGloss/extract-terms.js's other pure/DB-only pieces) so it's unit-testable with a fake
// client alone, no anthropic faking required.
//
// Fix wave (final review, Important finding 2), CRITICAL constraint: this is called AFTER the
// summary draft row already exists (see createDraftSummary below) — that row must stay committed
// no matter what happens here. glossary_terms/summary_terms may not exist yet (0007 is still an
// unapplied draft — see that migration's own header comment), so a missing-relation error is
// caught here, turned into an honest, counted warning (never silently swallowed, never a thrown
// error that would crash this bill's summarize run), and the caller moves on. Nothing is lost:
// extract-terms.js's own backfill self-heals this later — once 0007 is applied, running it finds
// this summary has no summary_terms row yet and extracts its terms retroactively, exactly as it
// already does today for every summary that predates this fix. Any OTHER (non-missing-relation)
// DB error is a real bug, not an expected pre-0007 condition, so it propagates unchanged — same
// as extract-terms.js's own persistence errors do.
export async function persistReferencedTermsGracefully(client, runId, { bill, summaryId, referencedTerms }) {
  try {
    const { termsUpserted } = await persistReferencedTerms(client, runId, { summaryId, referencedTerms });
    return { termsUpserted, warning: null };
  } catch (err) {
    if (isMissingRelationError(err, GLOSSARY_TERMS_TABLE) || isMissingRelationError(err, SUMMARY_TERMS_TABLE)) {
      return {
        termsUpserted: 0,
        warning: `referenced_terms not persisted for bill ${bill.identifier}: migration 0007 not applied (glossary_terms/summary_terms missing) — extract-terms.js's backfill will pick this summary up once 0007 is applied`,
      };
    }
    throw err;
  }
}

// Exported (unlike gloss.js's glossOne/extract-terms.js's extractOne, which stay unexported
// because THEIR non-DB dependency is real network I/O with no clean fake boundary) — this
// function's only non-DB dependency is the single summarizeBill call, cleanly fakeable at the SDK
// boundary (client.messages.create), so an end-to-end test can prove the CRITICAL constraint
// itself: a missing glossary_terms/summary_terms relation must never stop the summary draft from
// succeeding. See tests/summarize-cli.test.js.
export async function createDraftSummary(client, runId, { bill, textRow, anthropic }) {
  const { json, markdown } = await summarizeBill(anthropic, { identifier: bill.identifier, title: bill.title, text: textRow.content });
  // summaries has no unique constraint to upsert against — each generation is a fresh row,
  // matching the summary_notes history model (draft/approve/publish/reject as separate events).
  // .select('id').single() (new — the insert alone used to be fire-and-forget): the join row
  // persistReferencedTermsGracefully writes below needs this summary's own id.
  const { data, error } = await client.from('summaries').insert({
    bill_id: bill.id, status: 'draft', body_md: markdown, model: MODEL,
    prompt_version: PROMPT_VERSION, bill_text_hash: textRow.content_hash, run_id: runId,
  }).select('id').single();
  if (error) throw new Error(`summary insert failed for bill ${bill.id}: ${error.message}`);

  // Fix wave (final review, Important finding 2): persist json.referenced_terms right here — v2
  // SUMMARY_SCHEMA already asks opus-5 for these in this SAME billed call that authored markdown
  // above (near-zero added cost, per the design doc's own "rides in the same call" framing), so
  // realize that design instead of letting them go straight to the floor and requiring a second,
  // separately-billed extract-terms.js pass to rediscover them later.
  return persistReferencedTermsGracefully(client, runId, { bill, summaryId: data.id, referencedTerms: json.referenced_terms ?? [] });
}

function isTypedFailure(err) {
  return FAILURE_TYPES.some((T) => err instanceof T);
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

  const bills = await loadFederalBills(client, args.bill);
  const { currentTexts, textRowByBill, summaries } = await loadCurrentState(client, bills);
  const plan = planWork(bills, currentTexts, summaries);

  if (args.dryRun) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      counts: { bills: bills.length, needText: plan.needText.length, needSummary: plan.needSummary.length, stale: plan.stale.length },
      needText: plan.needText.map((b) => b.identifier),
      needSummary: plan.needSummary.map((b) => b.identifier),
      stale: plan.stale.map((s) => s.bill_id),
    }, null, 2));
    return;
  }

  const anthropic = getAnthropicClient();
  if (!anthropic) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'ANTHROPIC_API_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const runId = await openRun(client, 'summarize');
  const failures = [];
  try {
    // Bills with no current text: fetch + store, then they're eligible for summarization too.
    const summaryTargets = [];
    for (const bill of plan.needText) {
      try {
        const textRow = await ensureText(client, runId, bill);
        summaryTargets.push({ bill, textRow });
      } catch (err) {
        if (isTypedFailure(err)) failures.push({ identifier: bill.identifier, error: err.name, message: err.message });
        else throw err;
      }
    }
    // Bills that already had current text on file (planWork guarantees a textRowByBill hit).
    for (const bill of plan.needSummary) {
      const textRow = textRowByBill.get(bill.id);
      summaryTargets.push({ bill, textRow });
    }

    await markStale(client, plan.stale);

    let summariesCreated = 0;
    let glossaryTermsPersisted = 0;
    // Fix wave (final review, Important finding 2): glossaryWarnings is DISTINCT from failures —
    // a warning means the summary draft itself succeeded (counted in summariesCreated) but its
    // referenced_terms could not be persisted (pre-0007 degradation, see
    // persistReferencedTermsGracefully above). Recorded honestly in the run detail either way,
    // never silently dropped.
    const glossaryWarnings = [];
    for (const { bill, textRow } of summaryTargets) {
      try {
        const { termsUpserted, warning } = await createDraftSummary(client, runId, { bill, textRow, anthropic });
        summariesCreated += 1;
        glossaryTermsPersisted += termsUpserted;
        if (warning) glossaryWarnings.push({ identifier: bill.identifier, warning });
      } catch (err) {
        if (isTypedFailure(err)) failures.push({ identifier: bill.identifier, error: err.name, message: err.message });
        else throw err;
      }
    }

    const counts = {
      bills: bills.length, textsFetched: plan.needText.length, staleMarked: plan.stale.length,
      summariesCreated, glossaryTermsPersisted, glossaryPersistWarnings: glossaryWarnings.length,
      failures: failures.length,
    };
    const status = failures.length === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { counts, failures, glossaryWarnings });
    console.log(JSON.stringify({ mode: 'live', run_id: runId, status, counts, failures, glossaryWarnings }, null, 2));
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
