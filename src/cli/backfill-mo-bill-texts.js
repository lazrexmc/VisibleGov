import { basename } from 'node:path';
import {
  getClient, openRun, closeRun, selectAll,
} from '../lib/db.js';
import { SourceFetchError, parsePositiveIntegerFlag } from '../lib/errors.js';
import { fetchWithLimit } from '../lib/http.js';
import { MAX_TEXT_CHARS, OversizeTextError } from '../lib/summarizer.js';
import { sha256 } from '../adapters/us-congress-text.js';
import { extractPdfText } from '../adapters/pdf-text.js';
import { normalizeBillIdentifier } from '../adapters/legiscan-dataset.js';
import { listCachedDatasetFiles } from './backfill-nicknames.js';
import { readCachedDatasetBills, loadSessionIndex, loadBillIndex } from './backfill-mo-bill-meta.js';
import { isPassageVote } from './summary-queue.js';
import { isUniqueViolation } from './link-persons.js';
import { SOURCE as MO_HOUSE_SOURCE, moHouseLimiter } from '../adapters/mo-house-xml.js';
import { SOURCE as MO_SENATE_SOURCE, moSenateLimiter } from '../adapters/mo-senate-web.js';

// backfill-mo-bill-texts — MO bill-text fetcher (.superpowers/sdd/2026-07-31-mo-bill-texts/
// brief.md). Closes the highest-leverage bottleneck in the project: summaries are gated on having a
// bill's official text, and only 154 of 3,280 accountability-relevant bills have it. Every bill in
// the 31 already-cached LegiScan dataset ZIPs (read by ingest-legiscan.js's prior sweep — this file
// makes ZERO LegiScan API queries, ever) carries a `texts[]` array whose `state_link` points at the
// STATE'S OWN official PDF (documents.house.mo.gov / senate.mo.gov) — never LegiScan's own `url`
// (their HTML viewer, bound by their API terms). Pure $0 polite fetching: no model calls, no
// LegiScan queries, just the cached ZIPs already on disk + two document servers this codebase
// already fetches from politely (mo-rollcall-pdf.js / mo-house-xml.js, mo-senate-web.js).
//
// REUSE, NOT REIMPLEMENT (per the brief's own module list): decodeDatasetZip/extractDatasetFiles/
// normalizeBillIdentifier (legiscan-dataset.js), listCachedDatasetFiles (backfill-nicknames.js),
// loadSessionIndex/loadBillIndex (backfill-mo-bill-meta.js — same (session_id, identifier) join key
// that CREATED these bills rows in the first place), isPassageVote (summary-queue.js — the SAME
// passage/third-reading regex that already prioritizes the summarization queue, not a second,
// driftable copy), isUniqueViolation (link-persons.js — the SAME 23505-tolerance idiom already
// established for writeIdentityFlag's check-then-insert race), sha256 (us-congress-text.js — the
// SAME hashing convention enrich-federal-bills.js's own fetchAndStoreBillText uses for bill_texts.
// content_hash), MAX_TEXT_CHARS/OversizeTextError (summarizer.js — the SAME oversize-refusal law),
// extractPdfText (pdf-text.js — the shared pdfjs core factored out of mo-rollcall-pdf.js/
// mo-senate-journal-pdf.js by THIS task specifically so a bill-PDF consumer would not become a
// third hand-copy of that plumbing; see that module's own header).
//
// POLITENESS: state_link URLs resolve to exactly the two hosts mo-rollcall-pdf.js (documents.
// house.mo.gov, via mo-house-xml.js's moHouseLimiter) and mo-senate-web.js (senate.mo.gov, via its
// own moSenateLimiter) already fetch from — pickLimiterForUrl below reuses those SAME shared
// singleton limiter instances (not new ones), which is what makes house.mo.gov's documented
// half-hour ToU cooldown durable across every document type fetched in one process, exactly the way
// mo-rollcall-pdf.js's own header comment describes for roll-call PDFs. A state_link resolving to
// neither known host is refused loudly (fetchFailed, never fetched through an ungated path).
//
// VERSION SELECTION (v1 ruling, verbatim from the brief): the LATEST text entry by date (ties ->
// highest doc_id) is selected first — the most operative form of the bill — and `version` is stored
// as that entry's own printed `type` string verbatim, never invented or normalized. ONLY THEN is
// the selected entry's mime checked: a non-PDF selected entry is skippedNonPdf in v1 (HTML text
// versions are a later task) — an earlier PDF entry never "rescues" a non-PDF latest entry; v1 does
// not fetch multiple versions per bill (the (bill_id, version) unique key means a later run adding
// earlier versions will not conflict, but this run only ever attempts the one selected entry).
//
// PRIORITY: bills carrying a passage/third-reading vote (loadPassageBillIds, via summary-queue.js's
// own isPassageVote over votes.question) are sorted ahead of the rest before --limit slices the
// worklist — so a chunked/limited run spends its fetch budget on the bills readers most want
// explained first, same rationale summary-queue.js's own planQueue documents.
//
// HONEST COUNTS: exactly the 13 fields the brief names, nothing invented — `fetched` counts every
// bill whose HTTP fetch itself technically succeeded (non-empty 200 body), regardless of what
// happens next; `extractEmpty`/`oversizeRefused`/`inserted`/`alreadyPresent` exhaustively partition
// THAT subset (a raw pdfjs parse exception on corrupted-but-successfully-fetched bytes is folded
// into extractEmpty — "fetched, but no usable text resulted" — rather than invented a 14th bucket);
// `fetchFailed` covers everything that failed BEFORE a usable body was obtained (non-200, network
// error, 429, or a genuinely empty response body) and is mutually exclusive with `fetched`.
// `passagePriority` and `failures[]` are siblings of `counts`, not nested inside it — the brief's
// own wording ("plus a passagePriority breakdown, and a failures[] array") is read literally here.

const CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';
const SOURCE = 'backfill-mo-bill-texts';

export class EmptyExtractionError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'EmptyExtractionError';
    Object.assign(this, meta);
  }
}

// ---- CLI arg parsing ----

export function parseArgs(argv) {
  const out = { dryRun: false, limit: null, session: null };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
    // Same shared fail-loud positive-integer validation as enrich-federal-bills.js/summary-
    // queue.js's own --limit (src/lib/errors.js's parsePositiveIntegerFlag) — a malformed value
    // throws, never silently means "no limit". --session (a legiscan_session_id) is a positive
    // integer too, so it gets the same guard rather than a bespoke, drifting parser.
    if (key === '--limit') { out.limit = parsePositiveIntegerFlag(argv[i + 1], '--limit'); i += 2; continue; }
    if (key === '--session') { out.session = parsePositiveIntegerFlag(argv[i + 1], '--session'); i += 2; continue; }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

// ---- local cache: decode (zero network, zero API queries). readCachedDatasetBills is imported
// verbatim from backfill-mo-bill-meta.js (same decode surface this file needs: one cache file ->
// { ok, filePath, sessionId, bills }) rather than re-declared here — a second hand-copy of that
// same JSON.parse -> decodeDatasetZip -> extractDatasetFiles wrapper would be exactly the kind of
// duplication the brief's pdfjs-triple-copy warning calls out, just in a different module. ----

// ---- version selection (v1 ruling) ----

export function pickLatestTextEntry(texts) {
  if (!texts || texts.length === 0) return null;
  return texts.reduce((best, entry) => {
    if (!best) return entry;
    if (entry.date > best.date) return entry;
    if (entry.date === best.date && entry.doc_id > best.doc_id) return entry;
    return best;
  }, null);
}

// ---- politeness: which shared, already-established limiter a state_link's host maps to ----

export function pickLimiterForUrl(rawUrl) {
  let hostname;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch (cause) {
    throw new SourceFetchError(`state_link is not a valid URL: ${rawUrl}`, { url: rawUrl, cause });
  }
  const isHouse = hostname === 'house.mo.gov' || hostname.endsWith('.house.mo.gov');
  const isSenate = hostname === 'senate.mo.gov' || hostname.endsWith('.senate.mo.gov');
  if (isHouse) return { source: MO_HOUSE_SOURCE, limiter: moHouseLimiter };
  if (isSenate) return { source: MO_SENATE_SOURCE, limiter: moSenateLimiter };
  throw new SourceFetchError(`no known MO rate limiter for host "${hostname}" — refusing to fetch ungated`, { url: rawUrl });
}

// ---- pure planning (no I/O) ----
//
// planBillTextWork: one flattened list of { sessionRowId, bill } candidates (the caller has already
// resolved each dataset's own legiscan_session_id to a sessions row id, or null if unresolved) ->
// { counts, toFetch, passagePriority }. `toFetch` is priority-sorted (passage bills first, stable
// order otherwise preserved within each group — same filter+concat idiom summary-queue.js's own
// planQueue uses). A session that never resolved (sessionRowId null) can never match any bill —
// folded into billUnmatched rather than a separate bucket, since the brief's honest-count list has
// no dedicated "sessionNotFound" field for this task (unlike backfill-mo-bill-meta.js's).
export function planBillTextWork(candidates, { billIndex, textVersionIndex, passageBillIds }) {
  const counts = {
    billsSeen: 0, billMatched: 0, billUnmatched: 0, alreadyHasVersion: 0, skippedNonPdf: 0,
  };
  const toFetch = [];

  for (const { sessionRowId, bill } of candidates) {
    counts.billsSeen += 1;
    const identifier = normalizeBillIdentifier(bill.bill_number);
    const billRow = sessionRowId != null ? billIndex.get(`${sessionRowId}|${identifier}`) : undefined;
    if (!billRow) { counts.billUnmatched += 1; continue; }
    counts.billMatched += 1;

    const entry = pickLatestTextEntry(bill.texts);
    // A matched bill with zero text entries at all is not observed in the verified real data (every
    // bill in session 2239 carries >=1), but is handled here rather than assumed away: nothing to
    // plan, no new count bucket invented, never a crash.
    if (!entry) continue;

    if (textVersionIndex.has(`${billRow.id}|${entry.type}`)) { counts.alreadyHasVersion += 1; continue; }
    if (entry.mime !== 'application/pdf') { counts.skippedNonPdf += 1; continue; }

    const priority = passageBillIds.has(billRow.id) ? 'passage' : 'other';
    toFetch.push({
      billId: billRow.id, identifier, version: entry.type, url: entry.state_link, priority,
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

// ---- bulk index loaders (selectAll — Global Constraints: everything past or near the 1,000-row
// cap) ----

// loadBillTextVersionIndex -> Set<"billId|version"> for every existing bill_texts row. Version-
// granular (unlike enrich-federal-bills.js's own loadTextIndex, which only tracks bill_id presence)
// because this task's own skip rule is per-version: "skip bills that already have a bill_texts row
// for the version we would write."
export async function loadBillTextVersionIndex(client) {
  const { data, error } = await selectAll(client, 'bill_texts', 'bill_id,version');
  if (error) throw new Error(`backfill-mo-bill-texts: bill_texts bulk load failed: ${error.message}`);
  return new Set(data.map((row) => `${row.bill_id}|${row.version}`));
}

// loadPassageBillIds -> Set<bill_id> for every bill carrying at least one passage/third-reading
// vote — reuses summary-queue.js's OWN isPassageVote over votes.question (imported, never a second
// regex) so this queue's priority signal can never silently drift from the summarization queue's.
export async function loadPassageBillIds(client) {
  const { data, error } = await selectAll(client, 'votes', 'bill_id,question');
  if (error) throw new Error(`backfill-mo-bill-texts: votes bulk load failed: ${error.message}`);
  const ids = new Set();
  for (const row of data) {
    if (row.bill_id && isPassageVote(row.question)) ids.add(row.bill_id);
  }
  return ids;
}

// ---- fetch -> extract -> hash -> insert-if-absent, one bill's selected text version ----
//
// Mirrors enrich-federal-bills.js's own fetchAndStoreBillText contract (throws a typed error for
// every distinct failure mode, the caller buckets counts) as closely as this task's own extra
// insert-if-absent-with-visible-23505 requirement allows. That requirement (an explicit
// `alreadyPresent` outcome, not just a silent ignoreDuplicates no-op) is why this uses a plain
// `.insert()` + isUniqueViolation catch rather than src/lib/db.js's insertIfAbsent helper: upsert-
// with-ignoreDuplicates:true never reports back whether a row was actually written, which is
// exactly the distinction the brief's honest-count contract (inserted vs alreadyPresent) needs.
export async function fetchAndStoreMoBillText(client, runId, work, {
  fetchFn = fetchWithLimit, extractFn = extractPdfText, pickLimiterFn = pickLimiterForUrl,
} = {}) {
  const {
    billId, identifier, version, url,
  } = work;
  const { source, limiter } = pickLimiterFn(url);

  const arrayBuffer = await fetchFn(url, { source, limiter, as: 'arrayBuffer' });
  if (!arrayBuffer || arrayBuffer.byteLength === 0) {
    throw new SourceFetchError(`empty response body fetching bill text for ${identifier} (${version})`, { source, url });
  }

  let text;
  try {
    text = await extractFn(arrayBuffer);
  } catch (cause) {
    // A raw pdfjs parse exception (corrupted/non-PDF bytes despite a successful, non-empty fetch)
    // is folded into the SAME EmptyExtractionError bucket as a genuinely-empty text layer — both
    // mean "bytes were obtained, but no usable text resulted," and the brief's closed honest-count
    // list has no separate bucket for this rarer failure mode. The underlying cause is preserved in
    // the message for failures[] visibility.
    throw new EmptyExtractionError(
      `could not extract text from the PDF for ${identifier} (${version}): ${cause.message}`,
      { identifier, version, cause },
    );
  }
  if (!text || text.trim() === '') {
    throw new EmptyExtractionError(`extracted zero characters of text for ${identifier} (${version})`, { identifier, version });
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new OversizeTextError(
      `bill text ${text.length} chars exceeds ${MAX_TEXT_CHARS} for ${identifier} (${version}); refusing to store — never truncated silently`,
      { identifier, length: text.length },
    );
  }

  const row = {
    bill_id: billId,
    version,
    content: text,
    content_hash: sha256(text),
    source_url: url,
    retrieved_at: new Date().toISOString(),
    run_id: runId,
  };
  const { error } = await client.from('bill_texts').insert(row);
  if (error) {
    if (isUniqueViolation(error)) return { outcome: 'alreadyPresent', identifier, version };
    throw new Error(`bill_texts insert failed for bill_id=${billId} version=${version}: ${error.message}`);
  }
  return { outcome: 'inserted', identifier, version, row };
}

// ---- orchestration ----

function emptyCounts() {
  return {
    datasetsRead: 0,
    datasetsMissing: 0,
    billsSeen: 0,
    billMatched: 0,
    billUnmatched: 0,
    alreadyHasVersion: 0,
    skippedNonPdf: 0,
    fetched: 0,
    fetchFailed: 0,
    extractEmpty: 0,
    oversizeRefused: 0,
    inserted: 0,
    alreadyPresent: 0,
  };
}

// runBackfillMoBillTexts — the testable seam. Resumable by construction (DB-keyed, no artifact
// state file): loadBillTextVersionIndex is re-read fresh every invocation, so an interrupted run
// simply resumes as "already has version" for everything it already wrote.
export async function runBackfillMoBillTexts(client, {
  dryRun = false, limit = null, session = null, runId = null, cacheDir = CACHE_DIR,
  listFilesFn = listCachedDatasetFiles,
  readDatasetFn = readCachedDatasetBills,
  loadSessionIndexFn = loadSessionIndex,
  loadBillIndexFn = loadBillIndex,
  loadTextVersionIndexFn = loadBillTextVersionIndex,
  loadPassageBillIdsFn = loadPassageBillIds,
  fetchTextFn = fetchAndStoreMoBillText,
} = {}) {
  let files = listFilesFn(cacheDir);
  // --session scopes the READ itself down to one file (not a post-decode filter) — ingest-
  // legiscan.js's own documented cachePath convention (`${legiscanSessionId}-${datasetHash}.json`,
  // src/cli/ingest-legiscan.js) makes this a safe, mechanical, zero-decode filter.
  if (session != null) files = files.filter((f) => basename(f).startsWith(`${session}-`));

  const sessionIndex = await loadSessionIndexFn(client);
  const billIndex = await loadBillIndexFn(client);
  const textVersionIndex = await loadTextVersionIndexFn(client);
  const passageBillIds = await loadPassageBillIdsFn(client);

  const counts = emptyCounts();
  const candidates = [];
  for (const filePath of files) {
    // eslint-disable-next-line no-await-in-loop -- sequential, same "small/infrequent backlog"
    // precedent as every other batch CLI in this codebase.
    const decoded = await readDatasetFn(filePath);
    if (!decoded.ok) { counts.datasetsMissing += 1; continue; }
    counts.datasetsRead += 1;
    const sessionRow = sessionIndex.get(decoded.sessionId);
    for (const bill of decoded.bills) {
      candidates.push({ sessionRowId: sessionRow ? sessionRow.id : null, bill });
    }
  }

  const plan = planBillTextWork(candidates, { billIndex, textVersionIndex, passageBillIds });
  Object.assign(counts, plan.counts);
  const toProcess = (typeof limit === 'number' && limit > 0) ? plan.toFetch.slice(0, limit) : plan.toFetch;

  const failures = [];
  if (!dryRun) {
    for (const work of toProcess) {
      // eslint-disable-next-line no-await-in-loop -- sequential, same precedent as every other
      // batch CLI in this codebase; also required so the shared MO House/Senate limiters actually
      // serialize requests to the same host across bills.
      try {
        const result = await fetchTextFn(client, runId, work);
        counts.fetched += 1;
        if (result.outcome === 'inserted') counts.inserted += 1;
        else counts.alreadyPresent += 1;
      } catch (err) {
        if (err instanceof SourceFetchError) {
          counts.fetchFailed += 1;
          failures.push({ step: 'fetch', identifier: work.identifier, message: err.message });
        } else if (err instanceof EmptyExtractionError) {
          counts.fetched += 1;
          counts.extractEmpty += 1;
          failures.push({ step: 'extract', identifier: work.identifier, message: err.message });
        } else if (err instanceof OversizeTextError) {
          counts.fetched += 1;
          counts.oversizeRefused += 1;
          failures.push({ step: 'extract', identifier: work.identifier, message: err.message });
        } else {
          throw err;
        }
      }
    }
  }

  return {
    mode: dryRun ? 'dry-run' : 'live',
    counts,
    passagePriority: plan.passagePriority,
    worklistPreview: plan.toFetch.slice(0, 10).map((w) => ({
      identifier: w.identifier, version: w.version, priority: w.priority, url: w.url,
    })),
    toProcessCount: toProcess.length,
    failures,
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
    const report = await runBackfillMoBillTexts(client, { dryRun: true, limit: args.limit, session: args.session });
    console.log(JSON.stringify({ source: SOURCE, ...report }, null, 2));
    return;
  }

  const runId = await openRun(client, SOURCE);
  try {
    const report = await runBackfillMoBillTexts(client, {
      dryRun: false, runId, limit: args.limit, session: args.session,
    });
    const status = report.failures.length === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { counts: report.counts, passagePriority: report.passagePriority, failures: report.failures });
    console.log(JSON.stringify({
      source: SOURCE, run_id: runId, status, ...report,
    }, null, 2));
    if (report.failures.length > 0) process.exitCode = 2;
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
