import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { basename } from 'node:path';
import { getClient, openRun, closeRun } from '../lib/db.js';
import { parsePositiveIntegerFlag, SourceFetchError } from '../lib/errors.js';
import { MAX_TEXT_CHARS, OversizeTextError } from '../lib/summarizer.js';
import { sha256 } from '../adapters/us-congress-text.js';
import { extractPdfText } from '../adapters/pdf-text.js';
import { normalizeBillIdentifier } from '../adapters/legiscan-dataset.js';
import {
  SOURCE, ATTRIBUTION, getBillText, LegiScanApiError, QueryBudgetExceededError,
} from '../adapters/legiscan.js';
import {
  assertRunUnderBudget, recordQueryUsage, buildFailureCloseDetail,
} from './ingest-legiscan.js';
import { listCachedDatasetFiles } from './backfill-nicknames.js';
import { readCachedDatasetBills, loadSessionIndex, loadBillIndex } from './backfill-mo-bill-meta.js';
import {
  pickLatestTextEntry, loadBillTextVersionIndex, loadPassageBillIds, pickLimiterForUrl, EmptyExtractionError,
} from './backfill-mo-bill-texts.js';
import { isUniqueViolation } from './link-persons.js';

// ingest-legiscan-texts — LegiScan getBillText volume path
// (.superpowers/sdd/2026-07-31-legiscan-bill-text/brief.md). Closes the gap backfill-mo-bill-
// texts.js's own state-HTTP fetcher cannot: house.mo.gov's ToU caps automated pulls at once per 30
// minutes (382 days for 18,336 bills), and 2,202 bills' cached state_link is one shared
// reflect.legiscan.com/proxy2.legiscan.com placeholder with NO usable state document at all — the
// LegiScan API (getBillText, keyed by doc_id) is their only source. Lance approved this path
// 2026-07-31 over direct state fetching for exactly that reason.
//
// REUSE, NOT REIMPLEMENT: decodeDatasetZip/extractDatasetFiles/normalizeBillIdentifier
// (legiscan-dataset.js), listCachedDatasetFiles (backfill-nicknames.js), readCachedDatasetBills/
// loadSessionIndex/loadBillIndex (backfill-mo-bill-meta.js — the SAME (session_id, identifier) join
// key that CREATED these bills rows), pickLatestTextEntry/loadBillTextVersionIndex/
// loadPassageBillIds/pickLimiterForUrl/EmptyExtractionError (backfill-mo-bill-texts.js — the
// sibling's own robust version-selection comparator, alreadyHasVersion index, passage-priority
// signal, host classification, and parse/extract-failure error type), isUniqueViolation
// (link-persons.js), sha256 (us-congress-text.js), MAX_TEXT_CHARS/OversizeTextError
// (summarizer.js), extractPdfText (pdf-text.js), assertRunUnderBudget/recordQueryUsage/
// buildFailureCloseDetail (ingest-legiscan.js — THE existing write-ahead budget machinery this
// task's binding rule 1 requires reusing "exactly", not reimplementing a second copy of).
//
// NOT REUSED WHOLESALE: backfill-mo-bill-texts.js's own exported `planBillTextWork` is deliberately
// NOT imported here — it hard-filters to PDF-mime selected entries and to state_link hosts this
// codebase already has a polite limiter for (skippedNonPdf/skippedNonStateHost), because THAT
// planner feeds a direct HTTP fetch to the state's own server. This CLI never fetches from the
// state's server at all — the PDF bytes come straight from the LegiScan getBillText response's own
// base64 `doc` field, keyed by doc_id alone — so neither filter applies; a non-PDF selected entry or
// a proxy-placeholder state_link bill is exactly the kind of bill THIS path exists to unblock (see
// header above). planLegiscanTextWork below is a small, deliberately different planner reusing the
// SAME building blocks (pickLatestTextEntry, the two bulk indexes, normalizeBillIdentifier) minus
// those two inapplicable filters.
//
// BUDGET SOURCE (critical, easy to get wrong): this run's own ingestion_runs.source MUST be the
// SAME `SOURCE` ('legiscan') ingest-legiscan.js already writes — getMonthlyQueryUsage sums usage
// PER SOURCE, and both this CLI and ingest-legiscan.js spend queries against the SAME real LegiScan
// account/monthly quota. Using a distinct source string here (e.g. 'ingest-legiscan-texts') would
// silently let the two CLIs each think they had the FULL cap to themselves, doubling the effective
// budget against the one real account limit — exactly the terms violation binding rule 1 exists to
// prevent. openRun/closeRun/assertRunUnderBudget/recordQueryUsage below all use the imported
// `SOURCE` constant for this reason, never a bespoke label.
//
// DOC CACHE (Rule 7, suspension-level): a document blob is downloaded at most once per doc_id,
// EVER — .superpowers/artifacts/legiscan-texts/<doc_id>.json (gitignored via the repo's blanket
// `.superpowers/` rule, same as the dataset ZIP cache). Only a verified status:'OK' response is ever
// written there (an ERROR response is never cached — caching a failure would permanently block a
// legitimate future retry, which Rule 7 is not asking for; Rule 7 is about never re-downloading a
// document already successfully obtained). A cache HIT is a pure, zero-cost filesystem fact and
// costs no query — see the BUDGET REFUSAL comment below for why cache hits still process even
// during a budget-refused run.
//
// BUDGET REFUSAL SHAPE (rule 1: "refuses to start"): plannedQueries for the pre-flight
// assertRunUnderBudget check counts ONLY the doc_ids that would need a FRESH query (cache hits are
// free and never counted against the cap). If that check throws QueryBudgetExceededError, this
// function does NOT let it propagate — it is caught here and folded into an honest
// `counts.budgetRefused` bucket instead, so --dry-run-style "here is exactly what would happen" JSON
// reporting works uniformly whether or not the run actually proceeds (the brief's own "assert
// reconciliation in a test" ask needs a real counts object to reconcile against, not a thrown
// error). Already-cached doc_ids in the SAME worklist still process normally in this scenario —
// refusing free, zero-query work just because unrelated fresh queries would breach the cap would be
// stricter than the actual rule (the rule is about the QUERY budget, not about "any work at all").
// main() below still surfaces this as run status 'failed' so an operator watching ingestion_runs
// sees it as a real refusal, not a quiet partial success.

const DATASET_CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';
const TEXT_CACHE_DIR = '.superpowers/artifacts/legiscan-texts'; // gitignored (Rule 7)

export class BillTextDecodeError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'BillTextDecodeError';
    Object.assign(this, meta);
  }
}

// ---- CLI arg parsing ----

export function parseArgs(argv) {
  const out = {
    dryRun: false, limit: null, session: null, priorityOnly: false,
  };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
    if (key === '--priority-only') { out.priorityOnly = true; i += 1; continue; }
    if (key === '--limit') { out.limit = parsePositiveIntegerFlag(argv[i + 1], '--limit'); i += 2; continue; }
    if (key === '--session') { out.session = parsePositiveIntegerFlag(argv[i + 1], '--session'); i += 2; continue; }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

// ---- base64 decode (typed failure — Buffer.from(..., 'base64') never throws on its own, per
// legiscan-dataset.js's own decodeDatasetZip precedent, so an absent/empty/unusable `doc` field
// must be checked explicitly rather than trusted to surface as a native exception) ----

export function decodeBillTextDoc(text) {
  if (typeof text?.doc !== 'string' || text.doc.trim() === '') {
    throw new BillTextDecodeError(
      `getBillText doc_id=${text?.doc_id}: no usable base64 'doc' field in the response`,
      { docId: text?.doc_id },
    );
  }
  const buf = Buffer.from(text.doc, 'base64');
  if (buf.length === 0) {
    throw new BillTextDecodeError(
      `getBillText doc_id=${text.doc_id}: base64 'doc' decoded to zero bytes`,
      { docId: text.doc_id },
    );
  }
  return buf;
}

// ---- provenance: source_url resolution — prefer the real state host, else LegiScan's OWN printed
// `url` field (never hand-constructed — this response prints a ready-made
// https://legiscan.com/MO/text/<bill>/id/<doc_id> link itself, verified live probe, see
// getBillText's own header comment in src/adapters/legiscan.js) ----

export function resolveTextSourceUrl(text) {
  try {
    pickLimiterForUrl(text.state_link);
    return text.state_link;
  } catch (err) {
    if (!(err instanceof SourceFetchError)) throw err;
    return text.url;
  }
}

// ---- pure planning: cached-dataset bills -> a doc_id worklist. Deliberately NOT
// backfill-mo-bill-texts.js's own planBillTextWork — see the file header's "NOT REUSED WHOLESALE"
// comment for why (mime/state-host gates that apply to a direct HTTP fetch do not apply to a
// doc_id-keyed API fetch). Reuses pickLatestTextEntry/normalizeBillIdentifier verbatim. ----

export function planLegiscanTextWork(candidates, { billIndex, textVersionIndex, passageBillIds }) {
  const counts = {
    billsSeen: 0, billMatched: 0, billUnmatched: 0, noTextEntry: 0, noDocId: 0, alreadyHasVersion: 0,
  };
  const toFetch = [];

  for (const { sessionRowId, bill } of candidates) {
    counts.billsSeen += 1;
    const identifier = normalizeBillIdentifier(bill.bill_number);
    const billRow = sessionRowId != null ? billIndex.get(`${sessionRowId}|${identifier}`) : undefined;
    if (!billRow) { counts.billUnmatched += 1; continue; }
    counts.billMatched += 1;

    const entry = pickLatestTextEntry(bill.texts);
    if (!entry) { counts.noTextEntry += 1; continue; }
    if (entry.doc_id == null) { counts.noDocId += 1; continue; } // never observed in real fixtures; honest, not guessed

    if (textVersionIndex.has(`${billRow.id}|${entry.type}`)) { counts.alreadyHasVersion += 1; continue; }

    const priority = passageBillIds.has(billRow.id) ? 'passage' : 'other';
    toFetch.push({
      billId: billRow.id, identifier, version: entry.type, docId: entry.doc_id, priority,
    });
  }

  const passageItems = toFetch.filter((w) => w.priority === 'passage');
  const otherItems = toFetch.filter((w) => w.priority === 'other');
  return {
    counts,
    toFetch: [...passageItems, ...otherItems],
    passagePriority: { passage: passageItems.length, other: otherItems.length },
  };
}

// ---- doc cache (Rule 7) ----

function docCachePath(cacheDir, docId) {
  return `${cacheDir}/${docId}.json`;
}

// ---- honest counts ----

function emptyCounts() {
  return {
    billsPlanned: 0,
    alreadyHasVersion: 0,
    docCacheHits: 0,
    queriesSpent: 0,
    statusError: 0,
    decodeFailed: 0,
    nonPdfMime: 0,
    extractEmpty: 0,
    oversizeRefused: 0,
    inserted: 0,
    alreadyPresent: 0,
    budgetRefused: 0,
  };
}

// ---- one bill's already-in-hand `text` payload -> decode -> extract -> hash -> insert-if-absent.
// Shared by BOTH the cache-hit and fresh-query paths in the orchestrator below (identical from this
// point on regardless of where `text` came from). Never touches the query budget or the doc cache
// itself — those are the orchestrator's job, since only IT knows whether this text came from disk
// (free) or a query that was just write-ahead-recorded (not free). ----

async function decodeAndStoreBillText(client, runId, work, text, { extractFn = extractPdfText } = {}) {
  if (text.mime !== 'application/pdf') {
    return { outcome: 'nonPdfMime' };
  }

  const docBuffer = decodeBillTextDoc(text); // throws BillTextDecodeError — caller buckets it

  let extracted;
  try {
    extracted = await extractFn(docBuffer);
  } catch (cause) {
    throw new EmptyExtractionError(
      `could not extract text from doc_id=${work.docId} (${work.identifier} ${work.version}): ${cause.message}`,
      {
        identifier: work.identifier, version: work.version, docId: work.docId, step: 'parse',
      },
    );
  }
  if (!extracted || extracted.trim() === '') {
    throw new EmptyExtractionError(
      `extracted zero characters of text for doc_id=${work.docId} (${work.identifier} ${work.version})`,
      {
        identifier: work.identifier, version: work.version, docId: work.docId, step: 'extract',
      },
    );
  }
  if (extracted.length > MAX_TEXT_CHARS) {
    throw new OversizeTextError(
      `bill text ${extracted.length} chars exceeds ${MAX_TEXT_CHARS} for doc_id=${work.docId} `
        + `(${work.identifier} ${work.version}); refusing to store — never truncated silently`,
      { identifier: work.identifier, length: extracted.length },
    );
  }

  const row = {
    bill_id: work.billId,
    version: work.version, // VERBATIM from the planning-selected entry's own `type`
    content: extracted,
    content_hash: sha256(extracted),
    source_url: resolveTextSourceUrl(text),
    retrieved_at: new Date().toISOString(),
    run_id: runId,
  };
  const { error } = await client.from('bill_texts').insert(row);
  if (error) {
    if (isUniqueViolation(error)) return { outcome: 'alreadyPresent' };
    // A genuinely unrelated DB error (connection reset, etc.) is thrown, never silently swallowed —
    // same tested convention as backfill-mo-bill-texts.js's own fetchAndStoreMoBillText. `insert` is
    // a real step in this task's own failures[].step vocabulary, but (mirroring that sibling's
    // reviewed idiom exactly) only a 23505 is tolerated as a counted, non-fatal outcome; anything
    // else escalates and stops the run rather than being silently bucketed.
    throw new Error(`bill_texts insert failed for bill_id=${work.billId} version=${work.version} doc_id=${work.docId}: ${error.message}`);
  }
  return { outcome: 'inserted', row };
}

function applyOutcome(counts, outcome) {
  if (outcome === 'nonPdfMime') counts.nonPdfMime += 1;
  else if (outcome === 'inserted') counts.inserted += 1;
  else if (outcome === 'alreadyPresent') counts.alreadyPresent += 1;
}

function applyError(counts, failures, work, err) {
  if (err instanceof BillTextDecodeError) {
    counts.decodeFailed += 1;
    failures.push({
      step: 'decode', billId: work.billId, identifier: work.identifier, docId: work.docId, message: err.message,
    });
  } else if (err instanceof EmptyExtractionError) {
    counts.extractEmpty += 1;
    failures.push({
      step: err.step ?? 'extract', billId: work.billId, identifier: work.identifier, docId: work.docId, message: err.message,
    });
  } else if (err instanceof OversizeTextError) {
    counts.oversizeRefused += 1;
    failures.push({
      step: 'oversize', billId: work.billId, identifier: work.identifier, docId: work.docId, message: err.message,
    });
  } else {
    throw err;
  }
}

// ---- orchestration: the testable seam ----

export async function runIngestLegiscanTexts(client, {
  dryRun = false, limit = null, priorityOnly = false, session = null, runId = null,
  cacheDir = TEXT_CACHE_DIR, datasetCacheDir = DATASET_CACHE_DIR,
  listFilesFn = listCachedDatasetFiles, readDatasetFn = readCachedDatasetBills,
  loadSessionIndexFn = loadSessionIndex, loadBillIndexFn = loadBillIndex,
  loadTextVersionIndexFn = loadBillTextVersionIndex, loadPassageBillIdsFn = loadPassageBillIds,
  getBillTextFn = getBillText, apiKey = process.env.LEGISCAN_API_KEY, extractFn = extractPdfText,
  assertBudgetFn = assertRunUnderBudget, recordQueryUsageFn = recordQueryUsage, capPerMonth,
} = {}) {
  let files = listFilesFn(datasetCacheDir);
  // --session scopes the READ to one cached dataset file (same convention as backfill-mo-bill-
  // texts.js's own --session: ingest-legiscan.js's own cachePath naming, `${session}-${hash}.json`,
  // makes this a safe, mechanical, zero-decode filter).
  let sessionUncached = false;
  if (session != null) {
    const matched = files.filter((f) => basename(f).startsWith(`${session}-`));
    sessionUncached = matched.length === 0;
    files = matched;
  }

  const sessionIndex = await loadSessionIndexFn(client);
  const billIndex = await loadBillIndexFn(client);
  const textVersionIndex = await loadTextVersionIndexFn(client);
  const passageBillIds = await loadPassageBillIdsFn(client);

  let datasetsRead = 0;
  let datasetsMissing = 0;
  const candidates = [];
  for (const filePath of files) {
    // eslint-disable-next-line no-await-in-loop -- sequential, same "small/infrequent backlog"
    // precedent as every other batch CLI in this codebase.
    const decoded = await readDatasetFn(filePath);
    if (!decoded.ok) { datasetsMissing += 1; continue; }
    datasetsRead += 1;
    const sessionRow = sessionIndex.get(decoded.sessionId);
    for (const bill of decoded.bills) {
      candidates.push({ sessionRowId: sessionRow ? sessionRow.id : null, bill });
    }
  }

  const plan = planLegiscanTextWork(candidates, { billIndex, textVersionIndex, passageBillIds });
  let toProcess = priorityOnly ? plan.toFetch.filter((w) => w.priority === 'passage') : plan.toFetch;
  if (typeof limit === 'number' && limit > 0) toProcess = toProcess.slice(0, limit);

  // Cache-hit classification is a PURE filesystem fact — computed unconditionally (dry-run or live)
  // so --dry-run can honestly report "how many doc_ids are already cached" without ever querying.
  // The live run's own planned FRESH-query count is derivable as (billsPlanned - docCacheHits),
  // deliberately not given its own separate field.
  const classified = toProcess.map((work) => ({ work, cached: existsSync(docCachePath(cacheDir, work.docId)) }));
  const docCacheHitCount = classified.filter((c) => c.cached).length;
  const plannedFreshQueries = toProcess.length - docCacheHitCount;

  const counts = emptyCounts();
  counts.billsPlanned = toProcess.length;
  counts.alreadyHasVersion = plan.counts.alreadyHasVersion;
  counts.docCacheHits = docCacheHitCount;

  const baseReport = {
    passagePriority: plan.passagePriority,
    worklistPreview: toProcess.slice(0, 10).map((w) => ({
      identifier: w.identifier, version: w.version, docId: w.docId, priority: w.priority,
    })),
    toProcessCount: toProcess.length,
    datasetsRead,
    datasetsMissing,
    sessionUncached,
  };

  if (dryRun) {
    return {
      mode: 'dry-run', counts, failures: [], ...baseReport,
    };
  }

  // Pre-flight budget gate (binding rule 1: "refuses to start") — ONLY when a fresh query is
  // actually needed; a worklist fully satisfied by the doc cache never touches the budget check at
  // all. plannedFreshQueries is exact (a real filesystem fact, not a worst-case guess), matching
  // "an overcount is safe, an undercount is a terms violation" with no slack needed either way.
  let budgetOk = true;
  let budgetError;
  if (plannedFreshQueries > 0) {
    try {
      await assertBudgetFn(client, { plannedQueries: plannedFreshQueries, capPerMonth });
    } catch (err) {
      if (!(err instanceof QueryBudgetExceededError)) throw err;
      budgetOk = false;
      budgetError = {
        usage: err.usage, plannedQueries: err.plannedQueries, capPerMonth: err.capPerMonth, projected: err.projected,
      };
    }
  }

  const detail = { queries_used: 0 };
  const failures = [];

  for (const { work, cached } of classified) {
    let text;
    if (cached) {
      const raw = JSON.parse(readFileSync(docCachePath(cacheDir, work.docId), 'utf8'));
      text = raw.text;
    } else if (!budgetOk) {
      counts.budgetRefused += 1;
      continue;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await recordQueryUsageFn(client, runId, detail); // write-ahead BEFORE the query — Ruling 3
      counts.queriesSpent += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        text = await getBillTextFn(work.docId, { key: apiKey });
      } catch (err) {
        // Only the query step's own real, typed failure modes (a non-OK/ERROR status or missing-key
        // from checkStatus/buildUrl, or a network-level SourceFetchError/RateLimitedError from
        // fetchWithLimit) are counted and continue the run — a genuinely unexpected error (a bug)
        // still propagates rather than being silently swallowed into this bucket.
        if (!(err instanceof LegiScanApiError) && !(err instanceof SourceFetchError)) throw err;
        counts.statusError += 1;
        failures.push({
          step: 'query', billId: work.billId, identifier: work.identifier, docId: work.docId, message: err.message,
        });
        continue;
      }
      // Rule 7: cache ONLY a verified-OK payload — an ERROR response is never cached, so a future
      // retry (this run or any later one) is never permanently blocked by a transient failure.
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(docCachePath(cacheDir, work.docId), JSON.stringify({ status: 'OK', text }));
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await decodeAndStoreBillText(client, runId, work, text, { extractFn });
      applyOutcome(counts, result.outcome);
    } catch (err) {
      applyError(counts, failures, work, err);
    }
  }

  return {
    mode: 'live',
    counts,
    failures,
    refused: !budgetOk,
    budgetError,
    queriesUsed: detail.queries_used,
    ...baseReport,
  };
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

  if (args.dryRun) {
    const report = await runIngestLegiscanTexts(client, {
      dryRun: true, limit: args.limit, session: args.session, priorityOnly: args.priorityOnly,
    });
    console.log(JSON.stringify({ source: SOURCE, ...report }, null, 2));
    return;
  }

  const runId = await openRun(client, SOURCE); // SAME source as ingest-legiscan.js — see file header
  try {
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId, limit: args.limit, session: args.session, priorityOnly: args.priorityOnly,
    });
    const status = report.refused ? 'failed' : (report.failures.length === 0 ? 'succeeded' : 'partial');
    await closeRun(client, runId, status, {
      counts: report.counts,
      passagePriority: report.passagePriority,
      failures: report.failures,
      budgetError: report.budgetError,
      queries_used: report.counts.queriesSpent,
      attribution: ATTRIBUTION,
    });
    console.log(JSON.stringify({
      source: SOURCE, run_id: runId, status, ...report,
    }, null, 2));
    if (status !== 'succeeded') process.exitCode = 2;
  } catch (err) {
    await closeRun(client, runId, 'failed', await buildFailureCloseDetail(client, runId, err));
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
