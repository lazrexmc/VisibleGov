import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  getClient, openRun, closeRun, selectAll,
} from '../lib/db.js';
import { SourceFetchError } from '../lib/errors.js';
import { fetchMemberPage, parseMemberList, congressLimiter } from '../adapters/us-congress.js';
import { loadTermIndex, loadLegislatorBioguideIndex } from './backfill-term-states.js';

// backfill-federal-names — Task 8b of the public-site plan
// (.superpowers/sdd/2026-07-30-public-site/task-8b-brief.md, findings D2 + D3). Task 8's own
// review surfaced D2 live: 442/940 federal legislator rows have full_name === bioguide_id — a
// synthetic placeholder this codebase creates itself (ingest.js's persistUsCongress/
// persistUsSenate: `unknown.map((c) => ({ full_name: c.bioguide_id, bioguide_id: c.bioguide_id,
// ... }))`, also `enrich-federal-bills.js`'s own comment on the same pattern) whenever a vote cast
// names a bioguide_id this codebase has not resolved to a real name yet. The current-member fill
// (`ensureFederalMemberMetadata`) only ever pages the CURRENT roster, so it structurally can never
// fix a departed member's placeholder — this CLI closes that gap via congress.gov's own
// `/member/congress/{congress}` endpoint, which returns every member who EVER served in the named
// congress, current or departed.
//
// D2 SAFETY (brief, explicit): correcting our OWN synthetic bioguide-as-name placeholder is NOT
// the Lance-gated real-value-overwrite class this codebase otherwise enforces everywhere else — a
// bioguide_id string ("W000812") was never a real person's actual name, so there is no genuine
// value being lost. The update itself still carries `.eq('full_name', bioguide_id)` as its OWN
// structural guard (not merely a TOCTOU nicety): a real name can never equal its own bioguide id,
// so even a logic bug that reached this write path with an already-real row would patch zero rows,
// never overwrite one — caught here and counted `alreadyReal`, same TOCTOU-detection shape as
// `src/review/server.js`'s own `.update(...).eq(...).is(...).select('id')` race-guard precedent
// (checking the returned row count rather than trusting the pre-write read).
//
// D2 REUSE (brief, explicit — "if hardwired to the current-member endpoint, add the minimal
// parameter, do not fork the parser"): `fetchMemberPage` (src/adapters/us-congress.js) grew ONE
// new optional 4th parameter (`congress`) so it can route to `/member/congress/{congress}` instead
// of the unfiltered `/member` list — every existing caller is unaffected (nobody else passes a 4th
// argument). `parseMemberList` is unchanged and untouched: the response shape is identical either
// way, so the SAME parser (not a second one) handles both endpoints.
//
// D3 (adapter change lives in src/adapters/us-congress.js's parseMemberList; this file only carries
// the RETROACTIVE fills-null half): us-congress house terms with `district IS NULL` and `state` in
// the six-state at-large set (AK/DE/ND/SD/VT/WY — states with exactly one, statewide congressional
// district in the 119th Congress; same list documented at site/js/districts.js's matchReps at-large
// bridge, mirrored verbatim by the adapter's own AT_LARGE_STATE_NAMES) get `district` filled to
// '0' (Census CD '00' convention — see site/js/districts.js's own normalizeDistrict/matchReps
// comments for why '0', not '00' or null, is the destination value the client-side matcher already
// expects). Reuses `loadTermIndex` VERBATIM from backfill-term-states.js — the exact same bulk
// `terms` read, the exact same migration-0016 `state`-column gate (`gatedMissingColumn`, honestly
// counted per shape-matching candidate only, never a blanket "every term" count) — not a parallel
// terms loader. The site's own null-bridge (site/js/districts.js's matchReps, `t.district == null
// && cd === '0'`) stays in place for any row this backfill has not yet reached; this CLI is
// additive and narrows that gap over time, it does not replace the bridge.
//
// SCALE: `loadPlaceholderLegislators` bulk-loads the WHOLE `legislators` table via `selectAll`
// (~1,576+ rows, past the 1,000-row single-page cap — Global Constraints) exactly once, then
// filters in memory — mirrors `enrich-federal-bills.js`'s own `loadLegislatorIndexByBioguide`
// shape. The federal member roster fetch (~2,694+ members across the 119th Congress / 250 per
// page) is skipped ENTIRELY when zero placeholders exist (a repeat run after a first full fill
// pays zero network cost), same "only pay for what's actually needed" discipline as
// backfill-term-states.js's own `needsFederalRoster` gate.
//
// T8c (coordinator follow-on, 2026-07-30): a live smoke test found US Senate rendering 11 honest
// candidates for a MO address — every undated historical MO senator matches site/js/districts.js's
// matchReps with no date evidence to tell them apart. `runFederalTermDatesBackfill` fills
// `terms.start_date`/`end_date` (fills-null only, additive, both columns guarded `.is(col, null)`
// on the update) for `us-congress` terms whose legislator has an EXACT bioguide_id match in the
// `unitedstates/congress-legislators` dataset, from that member's own REAL per-term dates for the
// SAME CHAMBER as the term.
//
// FIX ROUND (controller-owned MAJOR, T8c review): the FIRST implementation of this pass derived
// dates from congress.gov's own member-list payload, which is YEAR-ONLY — it mechanically
// synthesized both start_date AND end_date as `${year}-01-03` (the 20th Amendment's congressional
// turnover day). That convention produced PROVABLY FALSE personal dates: Payne, Donald M.
// (P000604) was rendered with end_date 2024-01-03, when he actually died in office on 2024-04-24;
// start_date 2012-01-03, when the seat was still held by his father (Donald Payne Sr., who died
// 2012-03-06) until Payne Jr. won the special election and was sworn in 2012-11-15. Lance approved
// the fix (2026-07-30): swap the DATE SOURCE entirely to the unitedstates/congress-legislators
// dataset (public domain, CC0-licensed, bioguide-keyed, REAL per-term DAY-precision dates sourced
// from the House/Senate Biographical Directory) — never a synthesized calendar convention again.
// The guard/chamber-isolation/honest-count mechanics from the first round were verified correct by
// review and are UNCHANGED; only the date SOURCE and its derivation function changed.
//
// DATASET SHAPE (verified against the real files, downloaded 2026-07-30 from the URLs below —
// tests/fixtures/congress-legislators/ holds small excerpts of the SAME real records, not
// reconstructed data): each record is `{ id: { bioguide }, name: {...}, terms: [...] }`; each term
// is `{ type: 'rep'|'sen', start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', state, district|class, party,
// ... }`, terms listed chronologically (oldest first). `legislators-current.json` holds ONLY
// currently-serving members (each entry's `terms[]` still carries their FULL career, not just the
// active term); `legislators-historical.json` holds everyone whose service has ended — a person
// appears in exactly one of the two files, never both. Real-verified: Hawley (H001089)'s CURRENT
// term in legislators-current.json carries a real `end` of '2031-01-03' — the term's own
// CONSTITUTIONALLY-SCHEDULED end, not "when he actually left" (he hasn't) — so presence in
// legislators-current, not a term's own `end` field, is what this pass uses to decide "still
// serving" (see OPEN SERVICE below); the scheduled-but-not-yet-real end date is never written.
//
// CACHE DISCIPLINE (mirrors the LegiScan ZIP-cache discipline exactly — backfill-nicknames.js's
// own header comment): `legislators-current.json` (~1.4MB) and `legislators-historical.json`
// (~13.5MB) are downloaded ONCE into `.superpowers/artifacts/congress-legislators/` with a dated
// filename (this task's own one-time download: `legislators-current-2026-07-30.json`,
// `legislators-historical-2026-07-30.json` — from https://unitedstates.github.io/congress-
// legislators/legislators-current.json and .../legislators-historical.json).
// `readCongressLegislatorsCache` below reads ONLY from that cache directory (picks the
// lexicographically-latest dated file per prefix — an ISO-dated filename sorts chronologically) —
// this file makes ZERO live HTTP requests for date data, ever. A missing/unreadable cache is
// honestly skip-counted
// (`noMemberFound`, this pass's existing catch-all — Counts unchanged in shape per the fix round's
// own instruction), never a reason to fetch. The two large files are NEVER committed (gitignored
// under `.superpowers/`); only the small excerpt fixtures (Payne, Shuster, Hawley — real records,
// trimmed of non-essential contact-info fields) are committed, under `tests/fixtures/congress-
// legislators/`.
//
// OPEN SERVICE: a member present in `legislators-current.json` whose OWN LAST (most recent) term
// is of the SAME type as the term being resolved is "open" for that chamber — `end_date` stays
// null (the site already renders "(end date unrecorded)" honestly for that case,
// site/js/districts.js's termDateEvidence). Every other case (closed career, or a chamber-mismatch
// — e.g. a member who moved from the House to the Senate has a CLOSED House stint even though they
// are still serving overall) uses the real MIN start / MAX end across that member's OWN terms of
// the matching type only.

const SOURCE = 'backfill-federal-names';
const CONGRESS = 119; // hardcoded current-congress convention, matches ingest.js/enrich-federal-bills.js
const MEMBER_PAGE_SIZE = 250;
const FEDERAL_JURISDICTION = 'us-congress';
const HOUSE_CHAMBER = 'house';

// AT_LARGE_STATES (D3) — 2-letter USPS codes, since terms.state stores codes (not full state
// names — contrast src/adapters/us-congress.js's own AT_LARGE_STATE_NAMES, which matches against
// congress.gov's full-name field instead). Source: states with a single congressional district in
// the 119th Congress (same six states site/js/districts.js's matchReps at-large-bridge comment
// documents).
export const AT_LARGE_STATES = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);

export function parseArgs(argv) {
  const out = { dryRun: false };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

// ---- D2: placeholder legislators + the full-history federal roster ----

// loadPlaceholderLegislators -> the subset of legislators rows whose full_name is literally its
// own bioguide_id (our own synthetic placeholder, never a real person's name — see header comment).
export async function loadPlaceholderLegislators(client) {
  const { data, error } = await selectAll(client, 'legislators', 'id,full_name,bioguide_id,party');
  if (error) throw new Error(`backfill-federal-names: legislators bulk load failed: ${error.message}`);
  return data.filter((row) => row.bioguide_id != null && row.full_name === row.bioguide_id);
}

// loadFederalMemberIndex -> Map<bioguide_id, { full_name, party }> for EVERY member who served in
// the given congress (current AND departed — the whole reason this uses `/member/congress/
// {congress}` rather than the current-member-only `/member` endpoint every other caller in this
// codebase pages). Deliberately does NOT filter through isCurrentMember (ingest.js) — a departed
// member is exactly who D2 needs to find. D2-only (T8c's date-fill pass, below, reads real
// per-term dates from the unitedstates/congress-legislators cache instead — see that section's own
// header comment for why congress.gov's own year-only payload was replaced as a date source).
export async function loadFederalMemberIndex({
  fetchMemberPageFn = fetchMemberPage, congress = CONGRESS,
} = {}) {
  const index = new Map();
  const failures = [];
  let offset = 0;
  for (;;) {
    let json;
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential paging, same precedent as every
      // other member-roster loader in this codebase (backfill-term-states.js's
      // loadFederalMemberStateIndex, enrich-federal-bills.js's ensureFederalMemberMetadata).
      json = await fetchMemberPageFn(offset, MEMBER_PAGE_SIZE, congressLimiter, congress);
    } catch (err) {
      if (!(err instanceof SourceFetchError)) throw err;
      failures.push({ step: `member page offset=${offset}`, message: err.message });
      break;
    }
    const raw = json.members ?? [];
    // parseMemberList throws on ANY member with no terms at all — pre-filter so one odd record
    // can't kill the whole page (same brief ruling every other roster loader here follows).
    const withTerms = raw.filter((m) => (m.terms?.item ?? []).length > 0);
    if (withTerms.length < raw.length) {
      failures.push({ step: `member page offset=${offset}`, message: `${raw.length - withTerms.length} member(s) with no terms skipped (not fatal)` });
    }
    let parsed = [];
    try {
      parsed = parseMemberList({ members: withTerms });
    } catch (err) {
      failures.push({ step: `member page offset=${offset}`, message: err.message });
    }
    for (const m of parsed) index.set(m.bioguide_id, { full_name: m.full_name, party: m.party });
    if (raw.length < MEMBER_PAGE_SIZE) break;
    offset += MEMBER_PAGE_SIZE;
  }
  return { index, failures };
}

function emptyCounts() {
  return {
    placeholdersSeen: 0, filled: 0, noMemberFound: 0, alreadyReal: 0,
  };
}

// ---- D3: at-large fills-null (reuses loadTermIndex verbatim — see header comment) ----

function emptyAtLargeCounts() {
  return {
    candidatesSeen: 0, filled: 0, alreadyFilled: 0, gatedMissingColumn: 0,
  };
}

function isAtLargeCandidateShape(term) {
  return term.jurisdiction_id === FEDERAL_JURISDICTION && term.chamber === HOUSE_CHAMBER && term.district == null;
}

export async function runAtLargeBackfill(client, {
  dryRun = false, runId = null, loadTermIndexFn = loadTermIndex,
} = {}) {
  const counts = emptyAtLargeCounts();
  const plan = [];
  const { gated, rows } = await loadTermIndexFn(client);

  if (gated) {
    // Migration 0016 unapplied: `state` is unknowable for every row, so no shape-matching
    // candidate can be confirmed at-large or ruled out — every genuinely-candidate SHAPE (house,
    // us-congress, null district) is honestly counted gated, never a blanket "every term" count
    // (mirrors backfill-term-states.js's own loadTermIndex gate philosophy).
    counts.gatedMissingColumn = rows.filter(isAtLargeCandidateShape).length;
    return { counts, plan: dryRun ? plan : undefined };
  }

  for (const term of rows) {
    if (!isAtLargeCandidateShape(term)) continue;
    if (!AT_LARGE_STATES.has(term.state)) continue;
    counts.candidatesSeen += 1;

    if (dryRun) { plan.push({ termId: term.id, district: '0' }); continue; }

    // eslint-disable-next-line no-await-in-loop -- sequential, same "small/infrequent backlog"
    // precedent as every other batch CLI in this codebase.
    const { data, error } = await client.from('terms')
      .update({ district: '0', run_id: runId })
      .eq('id', term.id)
      .is('district', null) // TOCTOU guard: only writes if district is STILL null at write time.
      .select('id'); // Micro-fix (task-8b review, MODERATE): without .select(), a zero-rows-affected
      // response (the .is() guard filtering everything out under a race) is INDISTINGUISHABLE from
      // success — both come back error:null. Checking the returned row count is what actually
      // confirms the write happened, same shape as D2's own `.eq('full_name', bioguide_id)
      // .select('id')` race-guard above and src/review/server.js's `.update(...).eq(...).is(...)
      // .select('id')` precedent this mirrors.
    if (error) throw new Error(`backfill-federal-names: at-large district patch failed for terms.id=${term.id}: ${error.message}`);
    if (!data || data.length === 0) { counts.alreadyFilled += 1; continue; }
    counts.filled += 1;
  }

  return { counts, plan: dryRun ? plan : undefined };
}

// ---- T8c: federal term dates from the unitedstates/congress-legislators dataset — see header
// comment (FIX ROUND / DATASET SHAPE / CACHE DISCIPLINE / OPEN SERVICE) ----

const CONGRESS_LEGISLATORS_CACHE_DIR = '.superpowers/artifacts/congress-legislators';
const CURRENT_FILE_PREFIX = 'legislators-current-';
const HISTORICAL_FILE_PREFIX = 'legislators-historical-';

// CHAMBER_TERM_TYPE — this repo's own 'house'/'senate' chamber vocabulary (terms.chamber) mapped
// onto the dataset's own printed term `type` ('rep'/'sen' — verified against all three real
// excerpt records, tests/fixtures/congress-legislators/).
const CHAMBER_TERM_TYPE = { house: 'rep', senate: 'sen' };

// listCachedLegislatorFiles — every *.json file directly under the cache dir whose name starts
// with the given prefix, lexicographically sorted (a dated filename, e.g.
// 'legislators-current-2026-07-30.json', sorts chronologically — the LAST entry is always the
// latest snapshot on file). Mirrors listCachedDatasetFiles's own "sorted, not readdirSync's raw
// order" discipline (backfill-nicknames.js) for the identical determinism reason.
function listCachedLegislatorFiles(cacheDir, prefix) {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
    .map((name) => `${cacheDir}/${name}`);
}

// buildCongressLegislatorsIndex -> Map<bioguide, { terms, isCurrent }>. `isCurrent` distinguishes
// a legislators-current.json record (still serving — see OPEN SERVICE, header comment) from a
// legislators-historical.json one (career closed). A bioguide with no `id.bioguide` field
// (malformed/unexpected record shape) is skipped, never indexed under `undefined`.
function buildCongressLegislatorsIndex(currentRecords, historicalRecords) {
  const index = new Map();
  for (const rec of historicalRecords ?? []) {
    const bioguide = rec?.id?.bioguide;
    if (!bioguide) continue;
    index.set(bioguide, { terms: rec.terms ?? [], isCurrent: false });
  }
  for (const rec of currentRecords ?? []) {
    const bioguide = rec?.id?.bioguide;
    if (!bioguide) continue;
    index.set(bioguide, { terms: rec.terms ?? [], isCurrent: true }); // a real person is never in
    // both files at once (verified against the real downloaded data), but current wins on the
    // (unexpected) chance of an overlap rather than leaving it to insertion order.
  }
  return index;
}

// readCongressLegislatorsCache -> { ok, index }. `ok:false` (empty index) when either file is
// missing from the cache dir, or either is unreadable/malformed — counted honestly by the caller
// (this pass's own `noMemberFound` catch-all — see CACHE DISCIPLINE, header comment), NEVER a
// reason to fetch. Synchronous (a local file read, unlike every network-backed loader in this
// file) — matches backfill-mo-terms.js's own resolveLatestMoDatasetFile precedent for a sync
// cache-resolution seam.
export function readCongressLegislatorsCache({
  cacheDir = CONGRESS_LEGISLATORS_CACHE_DIR,
  listFilesFn = listCachedLegislatorFiles,
  readFileFn = readFileSync,
} = {}) {
  const currentFiles = listFilesFn(cacheDir, CURRENT_FILE_PREFIX);
  const historicalFiles = listFilesFn(cacheDir, HISTORICAL_FILE_PREFIX);
  if (currentFiles.length === 0 || historicalFiles.length === 0) return { ok: false, index: new Map() };
  let currentRecords;
  let historicalRecords;
  try {
    currentRecords = JSON.parse(readFileFn(currentFiles[currentFiles.length - 1], 'utf8'));
    historicalRecords = JSON.parse(readFileFn(historicalFiles[historicalFiles.length - 1], 'utf8'));
  } catch {
    return { ok: false, index: new Map() };
  }
  return { ok: true, index: buildCongressLegislatorsIndex(currentRecords, historicalRecords) };
}

// resolveTermDates — pure. `term` needs `jurisdiction_id`/`chamber`/`legislator_id`; returns
// `{ start_date, end_date }` (real day-precision 'YYYY-MM-DD' strings; `end_date` null for an open
// service — see OPEN SERVICE, header comment) or null when nothing can be honestly resolved (never
// guessed): not a federal term, no bioguide match, bioguide absent from BOTH dataset files, or the
// member has no term of THIS specific chamber's type at all (e.g. a House-only member whose term
// row is, oddly, chamber:'senate' — never borrows the other chamber's dates).
export function resolveTermDates(term, { legislatorBioguideIndex, memberIndex }) {
  if (term.jurisdiction_id !== FEDERAL_JURISDICTION) return null;
  const bioguideId = legislatorBioguideIndex.get(term.legislator_id);
  if (!bioguideId) return null;
  const member = memberIndex.get(bioguideId);
  if (!member) return null;
  const type = CHAMBER_TERM_TYPE[term.chamber];
  if (!type) return null;

  const matching = (member.terms ?? []).filter((t) => t.type === type && t.start);
  if (matching.length === 0) return null;

  const start_date = matching.reduce((min, t) => (t.start < min ? t.start : min), matching[0].start);

  const lastTerm = member.terms[member.terms.length - 1];
  const openService = member.isCurrent && lastTerm?.type === type;
  const end_date = openService
    ? null
    : matching.reduce((max, t) => (t.end && (!max || t.end > max) ? t.end : max), null);

  return { start_date, end_date };
}

// loadTermDateIndex -> the FULL `terms` bulk read, `start_date`/`end_date` included. UNGATED —
// unlike D3's `state` (migration 0016, draft-then-apply), `start_date`/`end_date` have existed
// since migration 0001 (already live everywhere this codebase runs) — no missing-column path
// exists to guard against.
export async function loadTermDateIndex(client) {
  const { data, error } = await selectAll(client, 'terms', 'id,legislator_id,jurisdiction_id,chamber,start_date,end_date');
  if (error) throw new Error(`backfill-federal-names: terms bulk load (dates) failed: ${error.message}`);
  return data;
}

function emptyDateCounts() {
  return {
    termsSeen: 0, datesFilled: 0, partialFilled: 0, noMemberFound: 0, alreadyDated: 0,
  };
}

// runFederalTermDatesBackfill — the testable seam (mirrors runAtLargeBackfill's own shape:
// independent gate, independent cache read). dryRun:true performs every read live mode would
// (terms bulk load, legislator bioguide index, the cache read when at least one real candidate
// needs it) but never writes — `datesFilled`/`partialFilled` stay 0, and every row that WOULD be
// written lands in `plan` instead.
export async function runFederalTermDatesBackfill(client, {
  dryRun = false, runId = null,
  loadTermDateIndexFn = loadTermDateIndex,
  loadLegislatorBioguideIndexFn = loadLegislatorBioguideIndex,
  loadCongressLegislatorsIndexFn = readCongressLegislatorsCache,
} = {}) {
  const counts = emptyDateCounts();
  const plan = [];

  const rows = await loadTermDateIndexFn(client);
  counts.termsSeen = rows.length;

  const legislatorBioguideIndex = await loadLegislatorBioguideIndexFn(client);
  const needsDataset = rows.some((t) => t.jurisdiction_id === FEDERAL_JURISDICTION && t.start_date == null
    && legislatorBioguideIndex.has(t.legislator_id));
  const dataset = needsDataset ? loadCongressLegislatorsIndexFn() : { ok: true, index: new Map() };

  for (const term of rows) {
    if (term.start_date != null) { counts.alreadyDated += 1; continue; }
    // Non-federal (mo-legislature) undated terms have no bioguide identity to resolve against at
    // all — folded into the same catch-all `noMemberFound` bucket backfill-term-states.js's own
    // `memberNotFound` uses for its own out-of-scope cases, rather than inventing a 6th bucket.
    if (term.jurisdiction_id !== FEDERAL_JURISDICTION) { counts.noMemberFound += 1; continue; }

    // Cache missing/unreadable entirely (CACHE DISCIPLINE, header comment): every genuine
    // candidate folds into the same noMemberFound catch-all — never a fetch, never a crash.
    if (!dataset.ok) { counts.noMemberFound += 1; continue; }

    const resolved = resolveTermDates(term, { legislatorBioguideIndex, memberIndex: dataset.index });
    if (!resolved) { counts.noMemberFound += 1; continue; }

    if (dryRun) { plan.push({ termId: term.id, ...resolved }); continue; }

    const patch = { start_date: resolved.start_date, run_id: runId };
    // end_date stays additive/absent (never guarded/written) for an open service (OPEN SERVICE,
    // header comment) — the site already renders "(end date unrecorded)" honestly for that case
    // (site/js/districts.js's termDateEvidence).
    const hasEndDate = resolved.end_date != null;
    if (hasEndDate) patch.end_date = resolved.end_date;

    let query = client.from('terms').update(patch).eq('id', term.id).is('start_date', null);
    if (hasEndDate) query = query.is('end_date', null);

    // eslint-disable-next-line no-await-in-loop -- sequential, same "small/infrequent backlog"
    // precedent as every other batch CLI in this codebase.
    const { data, error } = await query.select('id'); // row-count race check — see D2/D3's
    // identical `.select('id')` precedent in this same file (task-8b review MODERATE fix): a
    // zero-rows response here means something else dated this row between our read and this write
    // (functionally now "already dated"), never silently counted as a fill that didn't happen.
    if (error) throw new Error(`backfill-federal-names: term-date patch failed for terms.id=${term.id}: ${error.message}`);
    if (!data || data.length === 0) { counts.alreadyDated += 1; continue; }
    if (hasEndDate) counts.datesFilled += 1;
    else counts.partialFilled += 1;
  }

  return { counts, plan: dryRun ? plan : undefined };
}

// ---- orchestration (D2 + D3 + T8c combined into one run/report) ----

// runBackfillFederalNames — the testable seam. dryRun:true performs every read live mode would
// (placeholder scan, federal roster fetch when needed, terms bulk load) but never writes —
// `filled`/`atLarge.filled` stay 0, and every row that WOULD be written lands in `plan` instead
// (mirrors every other backfill CLI in this codebase).
export async function runBackfillFederalNames(client, {
  dryRun = false, runId = null,
  loadPlaceholderLegislatorsFn = loadPlaceholderLegislators,
  loadFederalMemberIndexFn = loadFederalMemberIndex,
  loadTermIndexFn = loadTermIndex,
  loadTermDateIndexFn = loadTermDateIndex,
  loadLegislatorBioguideIndexFn = loadLegislatorBioguideIndex,
  loadCongressLegislatorsIndexFn = readCongressLegislatorsCache,
} = {}) {
  const counts = emptyCounts();
  const plan = { fills: [] };

  const placeholders = await loadPlaceholderLegislatorsFn(client);
  counts.placeholdersSeen = placeholders.length;

  const roster = placeholders.length > 0
    ? await loadFederalMemberIndexFn()
    : { index: new Map(), failures: [] };

  for (const row of placeholders) {
    const member = roster.index.get(row.bioguide_id);
    if (!member) { counts.noMemberFound += 1; continue; }

    if (dryRun) {
      plan.fills.push({
        legislatorId: row.id, bioguideId: row.bioguide_id, fullName: member.full_name, party: member.party,
      });
      continue;
    }

    const patch = { full_name: member.full_name, run_id: runId };
    // party stays additive (fills-null only) even though full_name is an intentional placeholder
    // overwrite — a placeholder row's party is virtually always null (never set at creation), but
    // if it somehow already carries one, it is never clobbered by the roster fetch.
    if (row.party == null && member.party != null) patch.party = member.party;

    // eslint-disable-next-line no-await-in-loop -- sequential, same "small/infrequent backlog"
    // precedent as every other batch CLI in this codebase.
    const { data, error } = await client.from('legislators')
      .update(patch)
      .eq('id', row.id)
      .eq('full_name', row.bioguide_id) // guard: see D2 SAFETY header comment
      .select('id');
    if (error) throw new Error(`backfill-federal-names: name fill failed for legislator_id=${row.id}: ${error.message}`);
    if (!data || data.length === 0) { counts.alreadyReal += 1; continue; }
    counts.filled += 1;
  }

  const atLarge = await runAtLargeBackfill(client, { dryRun, runId, loadTermIndexFn });
  const dates = await runFederalTermDatesBackfill(client, {
    dryRun, runId, loadTermDateIndexFn, loadLegislatorBioguideIndexFn, loadCongressLegislatorsIndexFn,
  });

  return {
    mode: dryRun ? 'dry-run' : 'live',
    counts,
    atLarge: atLarge.counts,
    dates: dates.counts,
    failures: roster.failures,
    plan: dryRun ? { ...plan, atLarge: atLarge.plan, dates: dates.plan } : undefined,
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
    const report = await runBackfillFederalNames(client, { dryRun: true });
    console.log(JSON.stringify({ source: SOURCE, ...report }, null, 2));
    return;
  }

  const runId = await openRun(client, SOURCE);
  try {
    const report = await runBackfillFederalNames(client, { dryRun: false, runId });
    await closeRun(client, runId, 'succeeded', {
      counts: report.counts, atLarge: report.atLarge, dates: report.dates, failures: report.failures,
    });
    console.log(JSON.stringify({ source: SOURCE, run_id: runId, ...report }, null, 2));
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
