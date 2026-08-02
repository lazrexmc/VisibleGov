import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';
import { selectAll } from '../lib/db.js';

// LegiScan bulk adapter — API client core (Task 2 of docs/superpowers/plans/2026-07-29-legiscan-
// bulk-adapter.md). This module owns: status-checking (skip≠empty, typed errors), the mandatory
// dataset_hash gate (suspension-level per docs/research/2026-07-28-legiscan-terms.md rule 2), the
// shared per-source limiter, and the monthly query-budget refusal. NO ZIP decoding here (Task 3,
// gated on Lance's yauzl approval) — getDataset returns the raw envelope including the still-
// Base64-encoded zip field untouched.

export const SOURCE = 'legiscan';
export const ATTRIBUTION = { license: 'CC BY 4.0', holder: 'LegiScan', url: 'https://legiscan.com' };

// LEGISCAN_TEXTS_SOURCE / ALL_LEGISCAN_SOURCES — TODO-33 (source split,
// .superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md). ingest-legiscan-texts.js
// (doc-blob text fetches) writes its OWN distinct ingestion_runs.source label going forward
// ('legiscan-texts') instead of sharing SOURCE with ingest-legiscan.js (votes/bills) — but both
// CLIs still spend queries against the SAME real LegiScan account and the SAME real 30,000/month
// cap (docs/research/2026-07-28-legiscan-terms.md, Rule 1, binding). Splitting the label WITHOUT
// also making the budget check sum across BOTH labels would be actively dangerous: each CLI's own
// pre-flight getMonthlyQueryUsage/assertRunUnderBudget call would then only ever see its OWN half
// of the real spend, silently letting the TRUE combined total exceed the real account cap without
// either CLI ever refusing — the exact terms violation the shared key was originally built to
// prevent. ALL_LEGISCAN_SOURCES is the one canonical combined set both CLIs' own budget checks must
// pass as `source` — defined once, here (next to SOURCE), so neither CLI hardcodes the pair
// separately (which could silently drift if a source label is ever renamed again).
export const LEGISCAN_TEXTS_SOURCE = 'legiscan-texts';
export const ALL_LEGISCAN_SOURCES = [SOURCE, LEGISCAN_TEXTS_SOURCE];

// Pull API base per the LegiScan API Manual (Task 2 WebFetch, see LEGISCAN_MIN_INTERVAL_MS comment
// below for provenance): "https://api.legiscan.com/?key=APIKEY&op=OPERATION&PARAMS".
const BASE = 'https://api.legiscan.com/';

// LEGISCAN_MIN_INTERVAL_MS — resolved via the one permitted WebFetch (Global Constraints #6 /
// ruling Q3, .superpowers/sdd/legiscan-plan-draft-notes.md): fetched
// https://api.legiscan.com/dl/ (reachable, NOT Cloudflare-blocked, confirming prior research) which
// links straight to https://api.legiscan.com/dl/LegiScan_API_User_Manual.pdf (rev 20250317,
// 43 pages). Extracted the PDF's real text with pdfjs-dist (already a project dependency, same
// legacy-build extraction pattern as mo-rollcall-pdf.js/mo-senate-journal-pdf.js) and read every
// page, not just page 7.
//
// REAL FINDING: Page 7 ("API Operations") does NOT contain a per-request throttle/rate-limit
// value. Its "Frequency" column (getSessionList: Daily, getMasterList: 1 hour, getBill: 3 hours,
// getDataset: Weekly, getRollCall: Static, ...) is explicitly described by the manual's own text as
// "the minimum time resolution that could include changes in data" — i.e. how often the underlying
// DATA could plausibly change / when a cached response goes stale — not the minimum wait between
// consecutive HTTP requests a client is allowed to send. A full-text search of all 43 pages for
// rate/throttle/concurrent/simultaneous/"per second"/"per minute"/delay/interval/suspend/abuse
// found no explicit request-pacing guidance anywhere in the document (the one "Concurrent" hit was
// "Concurrent Resolution", a bill-type enum value, not rate-limiting text).
//
// This is exactly the case ruling Q3 anticipated ("if unreachable or the guidance isn't found"):
// the manual was reachable, but no per-request timing guidance exists to extract. Per the ruling,
// falls back to a clearly-labeled 1000ms placeholder.
// TODO(Q3, .superpowers/sdd/legiscan-plan-draft-notes.md): if LegiScan ever publishes an explicit
// per-request rate-limit/throttle value (this manual revision doesn't have one), replace this
// placeholder with the real value. Until then this IS the resolved fallback, not an open guess.
export const LEGISCAN_MIN_INTERVAL_MS = 1000;

export const legiscanLimiter = createLimiter({ minIntervalMs: LEGISCAN_MIN_INTERVAL_MS });

export class LegiScanApiError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LegiScanApiError';
    Object.assign(this, meta);
  }
}

// Defensive: guards against the dataset_hash that gated a fetch decision changing between the
// gate check and the live getDataset call actually landing (a real mid-run race, e.g. a weekly
// dataset regenerating while a backfill run is in flight). Defined/exported here per this task's
// interface spec; decodeDatasetHashGate below is the pure pre-fetch gate itself and does not throw
// this — the actual throw site (comparing a fetched dataset's own reported dataset_hash against the
// value that justified fetching it) belongs to the driver that performs the live getDataset call
// (Task 9), which is the only place both values are available at once.
export class DatasetHashMismatchError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'DatasetHashMismatchError';
    Object.assign(this, meta);
  }
}

export class QueryBudgetExceededError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'QueryBudgetExceededError';
    Object.assign(this, meta);
  }
}

// Pull API query string per the manual: key first, then op, then operation-specific PARAMS, in
// that order — matches every Pull API Template example in the manual verbatim. undefined/null/''
// param values are omitted (LegiScan's own optional params, e.g. getSessionList's `state`).
// Fail-fast on a missing API key (Task 9 review item (c), T2 review round): building a URL with
// no `key=` value would still "succeed" syntactically and only fail much later as an opaque
// LegiScan-side auth error off a bare fetch — this catches the real, common misconfiguration
// (LEGISCAN_API_KEY unset in .env) at the one place both the operation name and the caller's
// intent are still in scope, before any network call is attempted.
function buildUrl(op, params, key) {
  if (!key) {
    throw new LegiScanApiError(`legiscan buildUrl(${op}): missing API key — LEGISCAN_API_KEY is not set`, { op });
  }
  const usp = new URLSearchParams();
  usp.set('key', key);
  usp.set('op', op);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') usp.set(name, String(value));
  }
  return `${BASE}?${usp.toString()}`;
}

// Skip≠empty (Global Constraints #3 / terms doc rule 4): every LegiScan response's status is
// checked before any field is read. status is case-sensitive ('OK' | 'ERROR') per the manual's own
// Status Response section. Returns the payload unchanged on success so callers can chain straight
// into field access — this function IS the "parsing" this task's fixture tests exercise directly
// (no separate reshaping layer for LegiScan payloads: THE FIXTURE IS THE SOURCE OF TRUTH, field
// names pass through verbatim, no house-style renaming at this layer — see Task 4+ for the
// eventual DB-row reshaping).
export function checkStatus(payload) {
  if (!payload || payload.status !== 'OK') {
    throw new LegiScanApiError(`LegiScan API error: status=${payload && payload.status}`, {
      status: payload && payload.status,
      alertMessage: payload && payload.alert && payload.alert.message,
    });
  }
  return payload;
}

// getSessionList — real fixture: tests/fixtures/research/legiscan/mo-sessions.json (31 MO
// sessions, 2010-2026, Regular + Special). Returns the unwrapped sessions[] array.
export async function getSessionList(state, { key, limiter = legiscanLimiter } = {}) {
  const url = buildUrl('getSessionList', { state }, key);
  const payload = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'json' });
  return checkStatus(payload).sessions;
}

// getDatasetList — returns datasetlist[], each entry carrying session_id/dataset_hash/access_key.
// access_key is REQUIRED by getDataset below (confirmed by this task's manual WebFetch, Page 25/26
// — resolves the getDataset signature's flagged research-derived guess: it is real, not a guess).
export async function getDatasetList(state, { key, limiter = legiscanLimiter } = {}) {
  const url = buildUrl('getDatasetList', { state }, key);
  const payload = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'json' });
  return checkStatus(payload).datasetlist;
}

// getDataset — id is the LegiScan session_id; accessKey is the SAME session's own access_key from
// getDatasetList (NOT the API key) — confirmed against the manual's real getDataset Input
// Parameters table: "access_key: Access key from getDatasetList for the session_id being
// requested". Returns the unwrapped dataset object; `dataset.zip` is still Base64-encoded ZIP
// bytes — decoding is explicitly Task 3/4's job, not this one.
export async function getDataset(sessionId, accessKey, { key, limiter = legiscanLimiter } = {}) {
  const url = buildUrl('getDataset', { id: sessionId, access_key: accessKey }, key);
  const payload = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'json' });
  return checkStatus(payload).dataset;
}

// getBill — verification/spot-check use, not the bulk path (Task 9 reads bills out of the decoded
// dataset ZIP instead). Real fixture: tests/fixtures/research/legiscan/mo-2018-SB894.json.
export async function getBill(billId, { key, limiter = legiscanLimiter } = {}) {
  const url = buildUrl('getBill', { id: billId }, key);
  const payload = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'json' });
  return checkStatus(payload).bill;
}

// getRollCall — verification/spot-check use, not the bulk path. Real fixture:
// tests/fixtures/research/legiscan/mo-2018-rollcall-747209.json. NOTE: the manual's own Pull API
// Template example literally writes "op=getRollcall" (lowercase c) while every other reference in
// the manual (table of contents, operations table, data dictionary) and this codebase's own naming
// uses "getRollCall". Operations are documented as case-insensitive ("Keys, operations, state
// abbreviations and bill numbers are case-insensitive", manual Page 6), so the canonical spelling
// is used here without risk.
export async function getRollCall(rollCallId, { key, limiter = legiscanLimiter } = {}) {
  const url = buildUrl('getRollCall', { id: rollCallId }, key);
  const payload = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'json' });
  return checkStatus(payload).roll_call;
}

// getBillText — LegiScan bill-text volume path (.superpowers/sdd/2026-07-31-legiscan-bill-text/
// brief.md). Fetches ONE document blob by its own `doc_id` (NOT a bill_id) — LegiScan's own
// getBillText Pull API operation. REAL response shape (the ONE live probe this task is permitted,
// captured against a known-real MO doc_id already sitting in the committed mo-2018-SB894.json
// fixture's own texts[] array — never guessed): tests/fixtures/research/legiscan/
// mo-2018-SB894-billtext-1680835.json —
//   {status:'OK', text:{doc_id, bill_id, date, type, type_id, mime, mime_id, url, state_link,
//     text_size, text_hash, doc:'<base64>', alt_bill_text, alt_mime, alt_mime_id, alt_state_link,
//     alt_text_size, alt_text_hash, alt_doc}}
// This DIFFERS from the brief's own originally-assumed shape in two ways, both real and verbatim,
// never renamed: (1) `url` and `state_link` are ALSO present directly on the text object (not just
// on the dataset ZIP's texts[] entry) — `url` is LegiScan's own ready-made
// https://legiscan.com/MO/text/<bill>/id/<doc_id> link, reused verbatim as this task's fallback
// source_url rather than hand-constructed; (2) a full `alt_*` sibling-document family (an
// alternate-format companion, e.g. an HTML version alongside a PDF) — empty/0 on this probe's
// PDF-only bill, never observed non-empty yet, so v1 does not attempt to use it.
export async function getBillText(docId, { key, limiter = legiscanLimiter } = {}) {
  const url = buildUrl('getBillText', { id: docId }, key);
  const payload = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'json' });
  return checkStatus(payload).text;
}

// decodeDatasetHashGate — THE mandatory suspension-level gate (terms doc rule 2: "failure to do so
// will result in suspended access"). Pure, no DB/network — ledgerRow is whatever the caller already
// read from legiscan_datasets for this legiscan_session_id (or null if never fetched). sessionId is
// accepted for interface/documentation symmetry with the caller's own lookup key; it is not
// re-compared against ledgerRow here because the caller's own query is what scopes ledgerRow to
// this session in the first place (a single-row lookup by the legiscan_datasets primary key,
// migration 0010) — there is nothing left to cross-check at this pure layer.
// Task 9 review item (c): a one-line defensive assert, sessionId vs ledgerRow.legiscan_session_id
// — the caller's own query is what SHOULD scope ledgerRow to this session (see the comment above),
// but "should" is exactly the kind of unverified assumption that has caused real bugs elsewhere in
// this codebase (cross-jurisdiction terms collisions, cross-era mo_senate_id reuse); a mismatched
// row here would silently gate a fetch decision against the WRONG session's hash. Cheap to check,
// never worth skipping.
export function decodeDatasetHashGate(sessionId, reportedHash, ledgerRow) {
  if (!ledgerRow) return { shouldFetch: true, reason: 'never_fetched' };
  if (ledgerRow.legiscan_session_id !== sessionId) {
    throw new Error(
      `decodeDatasetHashGate: ledgerRow.legiscan_session_id=${ledgerRow.legiscan_session_id} does not `
        + `match the requested sessionId=${sessionId} — the caller scoped its own lookup incorrectly; `
        + 'never gating a fetch decision against the wrong session\'s ledger row',
    );
  }
  if (ledgerRow.dataset_hash === reportedHash) return { shouldFetch: false, reason: 'hash_unchanged' };
  return { shouldFetch: true, reason: 'hash_changed' };
}

// getMonthlyQueryUsage — sums ingestion_runs.detail.queries_used for `source` within the current
// calendar month. Reads via selectAll (src/lib/db.js:85), NOT a bare .select() — a busy month's
// ingestion_runs rows could plausibly exceed the 1000-row PostgREST page default, and an
// unpaginated read would silently UNDERCOUNT usage, letting a run blow past the configured monthly
// query cap (Global Constraints #2 / terms doc rule 1) — the exact shape of bug selectAll itself
// was written to close (see src/lib/db.js's own "finding 1" comment).
//
// TODO-33 (source split, .superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md,
// part 2 — the LOAD-BEARING part of that fix): `source` may now be EITHER a single source string
// (every existing caller, behavior byte-for-byte unchanged — still a plain `.eq('source', source)`)
// OR an array of sources, summed TOGETHER via `.in('source', sources)`. This exists so
// ingest-legiscan.js and ingest-legiscan-texts.js — two CLIs writing two DISTINCT source labels but
// spending queries against the SAME real LegiScan account/30,000-per-month cap — can each pass
// ALL_LEGISCAN_SOURCES (above) and see the TRUE combined total, not just their own half. A caller
// that split its own source label without also switching its budget check to the array form would
// silently undercount real usage — see ALL_LEGISCAN_SOURCES's own header comment for why that is a
// genuine terms violation, not just an accounting nicety.
//
// Month boundary is UTC (ruling Q5, .superpowers/sdd/legiscan-plan-draft-notes.md) — LegiScan's own
// reset is "resets the 1st" against its ET-based billing clock, so a run within a few hours of
// midnight ET around the month edge could be scoped to the "wrong" UTC month by this boundary.
// Accepted imprecision per Q5: low-stakes given the 5,000/30,000 headroom (Global Constraints #2) —
// worst case this is off by a few hours' worth of queries right at the edge, nowhere near enough to
// matter against a default 5,000/month cap.
//
// ingestion_runs has no created_at column (supabase/migrations/0001_core_schema.sql) — started_at
// is the real per-run timestamp and is what every run's month is scoped by here.
export async function getMonthlyQueryUsage(client, { source = SOURCE, now = new Date() } = {}) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  const sources = Array.isArray(source) ? source : [source];
  const { data, error } = await selectAll(client, 'ingestion_runs', 'detail', {
    filter: (q) => {
      const withSource = sources.length === 1 ? q.eq('source', sources[0]) : q.in('source', sources);
      return withSource
        .gte('started_at', monthStart.toISOString())
        .lt('started_at', monthEnd.toISOString());
    },
  });
  if (error) throw new Error(`getMonthlyQueryUsage: could not read ingestion_runs: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + (Number(row?.detail?.queries_used) || 0), 0);
}

// assertUnderBudget — pure hard-refusal gate (Global Constraints #2 / ruling Q2, APPROVED as
// drafted): a run refuses to START if usage-so-far plus this run's own planned query count would
// plausibly exceed capPerMonth. capPerMonth is the caller's job to supply (default 5,000/month,
// overridable via LEGISCAN_MONTHLY_QUERY_CAP per Q2 — that env-reading belongs to the CLI driver,
// Task 9, not this pure function).
// Minor 2 (progress.md ruling, folded into Task 9 per the controller): refuse AT the cap, not
// only strictly past it — `>=`, not `>`. "Well under the limit" is the intent (Global Constraints
// #2); a run that would land EXACTLY on the configured cap has zero headroom left for anything
// else that month and should refuse the same as one that would exceed it.
export function assertUnderBudget(usage, plannedQueries, capPerMonth) {
  const projected = usage + plannedQueries;
  if (projected >= capPerMonth) {
    throw new QueryBudgetExceededError(
      `LegiScan monthly query budget would be exceeded: ${usage} used + ${plannedQueries} planned `
        + `= ${projected} > cap ${capPerMonth}`,
      {
        usage, plannedQueries, capPerMonth, projected,
      },
    );
  }
}
