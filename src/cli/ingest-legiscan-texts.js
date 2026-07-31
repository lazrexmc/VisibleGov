import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { basename } from 'node:path';
import { getClient, openRun, closeRun } from '../lib/db.js';
import { parsePositiveIntegerFlag, SourceFetchError, RateLimitedError } from '../lib/errors.js';
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
// NOT REUSED WHOLESALE: backfill-mo-bill-texts.js's own exported `planBillTextWork` is still not
// imported directly — its HOST filter (skippedNonStateHost) genuinely does not apply here (this CLI
// never fetches from the state's own server at all — the PDF bytes come straight from the LegiScan
// getBillText response's own base64 `doc` field, keyed by doc_id alone, so a proxy-placeholder
// state_link bill is exactly the kind of bill this path exists to unblock). Its MIME filter
// (skippedNonPdf), however, IS restored below as `skippedNonPdfMime` — FIX (MED-1, controller
// ruling on the fix-round review, corpus-verified, overriding this file's original launch
// decision): measurement showed ZERO of the 2,202 real proxy-placeholder targets are non-PDF, and
// every one of the corpus's 6,225 text/html bills sits on a state host the sibling CLI can already
// reach directly — so spending a query (20.8% of one month's budget for that count alone) to store
// nothing has no upside. planLegiscanTextWork below reuses the SAME building blocks (
// pickLatestTextEntry, the two bulk indexes, normalizeBillIdentifier) as the sibling but keeps its
// own routing rules: mime IS gated at planning time again, host is not.
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
// `.superpowers/` rule, same as the dataset ZIP cache). Only a verified status:'OK' response whose
// own identity matches what was asked for (see IDENTITY CHECK below) is ever written there, and the
// write itself is atomic (temp file + rename — MED-2, fix-round review: a crash mid-write must
// never leave a truncated file at the real path, which would otherwise brick every future run
// against that doc_id with a bare, unrecoverable SyntaxError). An ERROR response is never cached
// (caching a failure would permanently block a legitimate future retry, which Rule 7 is not asking
// for). A cache HIT is a pure, zero-cost filesystem fact and costs no query — see the BUDGET
// REFUSAL comment below for why cache hits still process even during a budget-refused run.
//
// DEDUP (HIGH-1, fix-round review, suspension-level — Rule 7 violation, review-executed): the same
// doc_id could previously appear TWICE in one run's own worklist. Real trigger: ingest-legiscan.js's
// own dataset cache never deletes a prior hash's file (`${sessionId}-${hash}.json`), and --session's
// own startsWith match reads EVERY cache file for that session — a regenerated dataset means the
// SAME bill's SAME selected doc_id is seen twice, once per cache file. Fixed in BOTH places: (1)
// planLegiscanTextWork dedupes by doc_id before a worklist entry is ever created; (2) the
// orchestrator's own per-item loop re-checks existsSync(docCachePath(...)) FRESH at the point of
// deciding whether to query — never trusting a snapshot taken once before the loop — so even a cache
// file that appears mid-run (this run's own earlier iteration, or any other process) is honored for
// every later item, never invisible past a stale classification.
//
// IDENTITY CHECK (HIGH-2, fix-round review — "wrong-text", review-executed): the response's own
// doc_id/bill_id are cross-checked against what was actually asked for (work.docId/
// work.legiscanBillId, the latter carried from the planner's own candidate bill.bill_id) BEFORE the
// response is trusted for anything — stored OR cached. A mismatch (a swapped/corrupted cache file,
// or a live response that doesn't correspond to the request) is refused and counted
// (identityMismatch), never silently stored under the wrong bill and never written to the doc_id
// cache (Rule 7 says a doc_id can never be re-fetched once cached — caching a mismatched response
// would permanently poison that cache entry with no way to ever correct it). Mirrors
// resolveDatasetBytes's own established standard: "a swapped or corrupted local cache file is never
// trusted silently".
//
// RATE-LIMIT / CIRCUIT BREAKER (HIGH-3, fix-round review, terms-level — review-executed: 500
// requests issued at 1/s for 8 minutes after a 429, plus 500 more against a repeating
// "Subscription monthly query limit exceeded" status:ERROR): a RateLimitedError (HTTP 429) ABORTS
// the entire run immediately — LegiScan saying "stop" is never something this CLI continues past,
// even once. Separately, MAX_CONSECUTIVE_STATUS_ERRORS (5, documented below) consecutive
// LegiScanApiError/SourceFetchError query failures ALSO abort the run — N=5 independently-broken
// documents in a row is far less likely than one systemic condition (an exhausted subscription
// quota, an outage), so retrying blind past that point only burns budget for no chance of success.
// Both abort paths throw (propagate out of runIngestLegiscanTexts, through main()'s own failure
// close path) rather than returning a graceful report — unlike a budget refusal, this is not
// knowable in advance, so it cannot be pre-empted before the loop starts; queries_used still
// survives via the SAME write-ahead persistence used everywhere else (recordQueryUsage already
// wrote it BEFORE the query that triggered the abort was even issued). Every typed query failure's
// own err.alertMessage (LegiScan's own human-readable reason, e.g. the subscription-limit text
// above) is carried into failures[] so an operator can see WHY, not just that something failed.
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

// MAX_CONSECUTIVE_STATUS_ERRORS — HIGH-3, documented per the fix-round review's explicit ask: N=5.
// Only real, typed query-step failures (LegiScanApiError/SourceFetchError) increment this counter;
// a successful query resets it to 0. A cache hit, identity mismatch, or downstream decode/extract
// failure never touches it — this breaker is specifically about API-level health, not document
// quality.
const MAX_CONSECUTIVE_STATUS_ERRORS = 5;

export class BillTextDecodeError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'BillTextDecodeError';
    Object.assign(this, meta);
  }
}

export class BillTextIdentityMismatchError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'BillTextIdentityMismatchError';
    Object.assign(this, meta);
  }
}

export class MissingSourceUrlError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'MissingSourceUrlError';
    Object.assign(this, meta);
  }
}

export class TooManyConsecutiveQueryFailuresError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'TooManyConsecutiveQueryFailuresError';
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

// ---- identity check (HIGH-2) — a response is never trusted (stored OR cached) unless its own
// printed doc_id/bill_id match what was actually requested. ----

export function assertBillTextIdentity(work, text) {
  if (text?.doc_id !== work.docId || text?.bill_id !== work.legiscanBillId) {
    throw new BillTextIdentityMismatchError(
      `getBillText identity mismatch: requested doc_id=${work.docId} bill_id=${work.legiscanBillId} `
        + `(${work.identifier} ${work.version}) but the response reports doc_id=${text?.doc_id} `
        + `bill_id=${text?.bill_id} — refusing to store or cache a response that does not match what `
        + 'was asked for',
      {
        identifier: work.identifier,
        docId: work.docId,
        expectedBillId: work.legiscanBillId,
        responseDocId: text?.doc_id,
        responseBillId: text?.bill_id,
      },
    );
  }
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

// ---- pure planning: cached-dataset bills -> a doc_id worklist. See the file header's "NOT REUSED
// WHOLESALE" comment: mime IS gated here (restored, MED-1), host is not. ----

export function planLegiscanTextWork(candidates, { billIndex, textVersionIndex, passageBillIds }) {
  const counts = {
    billsSeen: 0,
    billMatched: 0,
    billUnmatched: 0,
    noTextEntry: 0,
    noDocId: 0,
    alreadyHasVersion: 0,
    skippedNonPdfMime: 0,
    duplicateDocId: 0,
  };
  const toFetch = [];
  const seenDocIds = new Set();

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

    // MED-1 (controller ruling, corpus-verified — see file header): restored planning-time mime
    // gate. The runtime mime check inside decodeAndStoreBillText stays too, as a backstop for the
    // rare case where a live response disagrees with the dataset's own advertised mime.
    if (entry.mime !== 'application/pdf') { counts.skippedNonPdfMime += 1; continue; }

    // HIGH-1, half 1 of 2 (see file header) — dedupe by doc_id before it ever reaches a worklist.
    if (seenDocIds.has(entry.doc_id)) { counts.duplicateDocId += 1; continue; }
    seenDocIds.add(entry.doc_id);

    const priority = passageBillIds.has(billRow.id) ? 'passage' : 'other';
    toFetch.push({
      billId: billRow.id, identifier, version: entry.type, docId: entry.doc_id, legiscanBillId: bill.bill_id, priority,
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

// ---- doc cache (Rule 7) — atomic write (MED-2): a temp file + rename means the FINAL path either
// doesn't exist yet or holds a complete, valid write — a crash mid-write can never leave a
// truncated file visible at docCachePath, which is exactly what used to brick every future run
// against that doc_id with a bare SyntaxError. ----

function docCachePath(cacheDir, docId) {
  return `${cacheDir}/${docId}.json`;
}

function atomicWriteJson(path, obj) {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, JSON.stringify(obj));
  renameSync(tmpPath, path);
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
    identityMismatch: 0, // HIGH-2
    cacheCorrupt: 0, // MED-2
    missingSourceUrl: 0, // MED-3
  };
}

// ---- one bill's already-in-hand, IDENTITY-VERIFIED `text` payload -> decode -> extract -> hash ->
// insert-if-absent. Shared by BOTH the cache-hit and fresh-query paths in the orchestrator below
// (identical from this point on regardless of where `text` came from — the identity check and the
// cache write both already happened in the caller, before this is reached). Never touches the query
// budget or the doc cache itself. ----

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

  // MED-3: a stored row with no openable receipt violates the receipts rule — refused and counted,
  // never stored with a null/empty source_url.
  const sourceUrl = resolveTextSourceUrl(text);
  if (!sourceUrl || String(sourceUrl).trim() === '') {
    throw new MissingSourceUrlError(
      `no usable source_url (neither a real state host nor LegiScan's own printed url) for `
        + `doc_id=${work.docId} (${work.identifier} ${work.version}) — refusing to store a receipt-less row`,
      { identifier: work.identifier, docId: work.docId },
    );
  }

  const row = {
    bill_id: work.billId,
    version: work.version, // VERBATIM from the planning-selected entry's own `type`
    content: extracted,
    content_hash: sha256(extracted),
    source_url: sourceUrl,
    retrieved_at: new Date().toISOString(),
    run_id: runId,
  };
  const { error } = await client.from('bill_texts').insert(row);
  if (error) {
    if (isUniqueViolation(error)) return { outcome: 'alreadyPresent' };
    // A genuinely unrelated DB error (connection reset, etc.) is thrown, never silently swallowed —
    // same tested convention as backfill-mo-bill-texts.js's own fetchAndStoreMoBillText. Only a
    // 23505 is tolerated as a counted, non-fatal outcome; anything else escalates and stops the run.
    // LOW fix (fix-round review): 'insert' is dropped from the failures[].step vocabulary — a
    // non-23505 insert error is, by this same design, never reachable as a counted failures[] entry
    // (it always escalates instead), so documenting it as a real step value would be misleading.
    throw new Error(`bill_texts insert failed for bill_id=${work.billId} version=${work.version} doc_id=${work.docId}: ${error.message}`);
  }
  return { outcome: 'inserted', row };
}

// applyOutcome — LOW fix (fix-round review): nonPdfMime now also gets a failures[] entry. It is not
// a thrown error (a non-PDF mime is an honest, expected v1-scope limit, not a bug), but a run that
// spent queries and stored nothing for a batch of these must never silently close 'succeeded' —
// main()'s own status computation already derives 'partial' from any non-empty failures[], so this
// is the whole fix.
function applyOutcome(counts, failures, work, outcome) {
  if (outcome === 'nonPdfMime') {
    counts.nonPdfMime += 1;
    failures.push({
      step: 'nonPdfMime', billId: work.billId, identifier: work.identifier, docId: work.docId, message: `getBillText response mime is not application/pdf for doc_id=${work.docId}`,
    });
  } else if (outcome === 'inserted') counts.inserted += 1;
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
  } else if (err instanceof MissingSourceUrlError) {
    counts.missingSourceUrl += 1;
    failures.push({
      step: 'sourceUrl', billId: work.billId, identifier: work.identifier, docId: work.docId, message: err.message,
    });
  } else if (err instanceof BillTextIdentityMismatchError) {
    counts.identityMismatch += 1;
    failures.push({
      step: 'identity', billId: work.billId, identifier: work.identifier, docId: work.docId, message: err.message,
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
  maxConsecutiveStatusErrors = MAX_CONSECUTIVE_STATUS_ERRORS,
} = {}) {
  let files = listFilesFn(datasetCacheDir);
  // --session scopes the READ to one cached dataset file (same convention as backfill-mo-bill-
  // texts.js's own --session: ingest-legiscan.js's own cachePath naming, `${session}-${hash}.json`,
  // makes this a safe, mechanical, zero-decode filter). NOTE (HIGH-1): a regenerated dataset means
  // MULTIPLE files can match the SAME session via this startsWith — that is exactly the scenario
  // planLegiscanTextWork's own doc_id dedup exists to handle; this filter is deliberately left as
  // startsWith (not tightened to an exact single-file match) since a real regenerated dataset's
  // bills can differ between hashes and both are legitimately worth reading.
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

  // Pre-loop cache classification is a PURE filesystem snapshot (existsSync only, no read) used
  // ONLY for: (a) dry-run's own docCacheHits report (the loop below never runs in dry-run), and (b)
  // the budget pre-flight gate's plannedFreshQueries estimate. HIGH-1, half 2 of 2: the LIVE loop
  // below does NOT rely on this snapshot to decide per-item behavior — every live iteration
  // re-checks existsSync immediately before deciding to query, so a cache file that appears mid-run
  // is always honored, never invisible past a stale classification.
  const docCacheHitSnapshot = toProcess.filter((w) => existsSync(docCachePath(cacheDir, w.docId))).length;
  const plannedFreshQueries = toProcess.length - docCacheHitSnapshot;

  const counts = emptyCounts();
  counts.billsPlanned = toProcess.length;
  counts.alreadyHasVersion = plan.counts.alreadyHasVersion;

  const baseReport = {
    passagePriority: plan.passagePriority,
    planCounts: plan.counts, // MED-4: the raw planning-time breakdown, a sibling of counts (never folded into the closed list)
    worklistPreview: toProcess.slice(0, 10).map((w) => ({
      identifier: w.identifier, version: w.version, docId: w.docId, priority: w.priority,
    })),
    toProcessCount: toProcess.length,
    datasetsRead,
    datasetsMissing,
    sessionUncached,
  };

  if (dryRun) {
    counts.docCacheHits = docCacheHitSnapshot;
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
  let consecutiveStatusErrors = 0;

  for (const work of toProcess) {
    const cachePath = docCachePath(cacheDir, work.docId);
    let text;
    let fromCache = false;

    if (existsSync(cachePath)) {
      counts.docCacheHits += 1;
      let raw;
      try {
        raw = JSON.parse(readFileSync(cachePath, 'utf8'));
      } catch (err) {
        // MED-2: a truncated/corrupt cache file is refused and counted — Rule 7 forbids re-fetching
        // a doc_id that already has a cache file, corrupt or not, so this NEVER falls through to a
        // live query. The run continues to the next item.
        counts.cacheCorrupt += 1;
        failures.push({
          step: 'cacheCorrupt', billId: work.billId, identifier: work.identifier, docId: work.docId, message: `cached doc_id=${work.docId} is corrupt/unparseable: ${err.message}`,
        });
        continue;
      }
      text = raw.text;
      fromCache = true;
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
        consecutiveStatusErrors = 0; // HIGH-3: any successful query resets the breaker
      } catch (err) {
        // HIGH-3: a 429 (RateLimitedError) ABORTS the whole run immediately — LegiScan saying "stop"
        // is never continued past, even once. This throw propagates out of runIngestLegiscanTexts
        // entirely, through main()'s own failure close path; queries_used already survived via the
        // write-ahead persist just above.
        if (err instanceof RateLimitedError) throw err;
        // Only the query step's own OTHER real, typed failure modes (a non-OK/ERROR status or
        // missing-key from checkStatus/buildUrl, or a network-level SourceFetchError) are counted
        // and continue the run — a genuinely unexpected error (a bug) still propagates.
        if (!(err instanceof LegiScanApiError) && !(err instanceof SourceFetchError)) throw err;
        counts.statusError += 1;
        consecutiveStatusErrors += 1;
        failures.push({
          step: 'query', billId: work.billId, identifier: work.identifier, docId: work.docId, message: err.message, alertMessage: err.alertMessage ?? null,
        });
        // HIGH-3: circuit breaker — N consecutive typed query failures in a row is far more likely a
        // systemic condition (an exhausted subscription quota, an outage) than N independently-
        // broken documents; abort rather than burning the rest of the budget retrying blind.
        if (consecutiveStatusErrors >= maxConsecutiveStatusErrors) {
          throw new TooManyConsecutiveQueryFailuresError(
            `aborting after ${consecutiveStatusErrors} consecutive query failures (limit `
              + `${maxConsecutiveStatusErrors}) — a systemic condition is far more likely than this `
              + 'many independently-broken documents; never worth burning the rest of the budget '
              + 'retrying blind',
            { consecutiveFailures: consecutiveStatusErrors },
          );
        }
        continue;
      }
    }

    try {
      // HIGH-2: identity check BEFORE the response is trusted for anything — stored OR cached.
      assertBillTextIdentity(work, text);
      if (!fromCache) {
        // Rule 7 + MED-2: cache the WRITE only now — after identity passed — and atomically.
        mkdirSync(cacheDir, { recursive: true });
        atomicWriteJson(cachePath, { status: 'OK', text });
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await decodeAndStoreBillText(client, runId, work, text, { extractFn });
      applyOutcome(counts, failures, work, result.outcome);
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
      planCounts: report.planCounts,
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
