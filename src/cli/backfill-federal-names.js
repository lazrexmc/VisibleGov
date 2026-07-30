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
// matchReps with no date evidence to tell them apart (the site already RENDERS each candidate's
// own date evidence honestly; this pass is what gives that evidence something real to show, for
// every legislator the 119th-Congress roster can still resolve). `runFederalTermDatesBackfill`
// fills `terms.start_date`/`end_date` (fills-null only, additive) for `us-congress` terms whose
// legislator has an EXACT bioguide_id match in the `/member/congress/119` pages, from that
// member's own service years for the SAME CHAMBER as the term.
//
// PAYLOAD GRANULARITY (verified against the real committed fixture, tests/fixtures/us-congress/
// member-page-unfiltered.json — all 20 real members): every `terms.item` entry is YEAR-ONLY
// (`startYear`/optional `endYear` — no month or day anywhere in the payload), and congress.gov
// COLLAPSES consecutive same-chamber terms into ONE item spanning the whole stint — e.g. Payne,
// Donald M. (P000604) shows a SINGLE House item `{startYear:2012, endYear:2024}` covering what was
// actually six separate 2-year House terms, not six items; Shuster, Bill (S001154) the same
// (`{startYear:2001, endYear:2019}`, one item for a stint that spanned nine 2-year terms). No
// member in the fixture carries more than one item for the SAME chamber. `congressionalTermDate`
// below documents the year -> real-date mapping this granularity forces.
//
// EFFICIENCY NOTE: this pass fetches the SAME `/member/congress/119` roster the D2 name-fill pass
// fetches, via its OWN independent gate/fetch — mirrors `runAtLargeBackfill`'s existing
// independence from D2, rather than threading one shared fetch through three differently-shaped
// passes. A live run needing BOTH D2 fills AND date fills therefore pays for the ~11-request
// roster page TWICE (~80s total, throttled, still $0) — a real but bounded, one-time operational
// cost, ledgered here rather than hidden; not a correctness concern (both fetches read the exact
// same live data).

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

function classifyServiceChamber(rawChamber) {
  if (/senate/i.test(rawChamber ?? '')) return 'senate';
  if (/house/i.test(rawChamber ?? '')) return 'house';
  return null;
}

// extractServiceRanges — one raw member's `terms.item[]` -> `{ house: [...], senate: [...] }`, one
// entry per SOURCE item, UNCOLLAPSED and untouched by parseMemberList's own single-latest-chamber
// reduction (T8c's date-fill pass needs every stint per chamber, not just the member's current
// one). See the T8c header comment (PAYLOAD GRANULARITY) for what the real fixture actually shows.
function extractServiceRanges(rawMember) {
  const ranges = { house: [], senate: [] };
  for (const item of rawMember.terms?.item ?? []) {
    const chamber = classifyServiceChamber(item.chamber);
    if (!chamber) continue;
    ranges[chamber].push({ startYear: item.startYear ?? null, endYear: item.endYear ?? null });
  }
  return ranges;
}

// loadFederalMemberIndex -> Map<bioguide_id, { full_name, party, service }> for EVERY member who
// served in the given congress (current AND departed — the whole reason this uses `/member/
// congress/{congress}` rather than the current-member-only `/member` endpoint every other caller
// in this codebase pages). Deliberately does NOT filter through isCurrentMember (ingest.js) — a
// departed member is exactly who D2 needs to find, and T8c's date-fill pass needs their FULL
// per-chamber service history either way. `service` (extractServiceRanges, above) is captured in
// the SAME pass/fetch that already builds `full_name`/`party` for D2 — one roster page read serves
// both this function's own two callers, not a second read.
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
    // parsed[i] corresponds positionally to withTerms[i] — parseMemberList is a pure .map() over
    // its input array (src/adapters/us-congress.js), so the two stay index-aligned whenever
    // parsed is non-empty (a thrown error empties `parsed` entirely for the WHOLE page, per the
    // catch above — never a partial/misaligned result).
    for (let i = 0; i < parsed.length; i += 1) {
      const m = parsed[i];
      index.set(m.bioguide_id, {
        full_name: m.full_name, party: m.party, service: extractServiceRanges(withTerms[i]),
      });
    }
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

// ---- T8c: federal term dates from member service years (fills-null) — see header comment ----

const CONGRESS_START_YEAR = 2025; // 119th Congress: Jan 2025 - Jan 2027 (20th Amendment turnover)

// congressionalTermDate — the 20th Amendment fixes BOTH a new Congress's term START and the
// OUTGOING term's END at noon, January 3rd (odd-numbered years) — the constitutional turnover day.
// Since the source payload is year-only (PAYLOAD GRANULARITY, header comment), this is the
// documented, non-guessed mapping from a bare year to a real calendar date, used identically for
// both `start_date` and `end_date`.
function congressionalTermDate(year) {
  return `${year}-01-03`;
}

// resolveServiceRangeForChamber — picks ONE range to use for a term. The real fixture never shows
// more than one range per chamber (PAYLOAD GRANULARITY, header comment), so the multi-range branch
// below is a documented defensive fallback, not a behavior exercised by any committed fixture data.
function resolveServiceRangeForChamber(ranges) {
  if (!ranges || ranges.length === 0) return null;
  if (ranges.length === 1) return ranges[0];
  // Multiple stints in the SAME chamber (a gap then a return, or a future API shape not observed
  // today): prefer whichever range actually COVERS the 119th Congress. If none do (a stale or
  // incomplete response), fall back to the most-recently-started range rather than guessing an
  // arbitrary one.
  const covering = ranges.find((r) => r.startYear != null && r.startYear <= CONGRESS_START_YEAR
    && (r.endYear == null || r.endYear >= CONGRESS_START_YEAR));
  if (covering) return covering;
  return ranges.reduce((latest, r) => ((r.startYear ?? -Infinity) > (latest.startYear ?? -Infinity) ? r : latest));
}

// resolveTermDates — pure. `term` needs `jurisdiction_id`/`chamber`/`legislator_id`; returns
// `{ start_date, end_date }` (end_date null for an open/current service — no endYear on file) or
// null when nothing can be honestly resolved (never guessed): not a federal term, no bioguide
// match, bioguide not in the fetched roster, or the member has no service range at all for THIS
// specific chamber (e.g. a House-only member whose term row is, oddly, chamber:'senate').
export function resolveTermDates(term, { legislatorBioguideIndex, memberIndex }) {
  if (term.jurisdiction_id !== FEDERAL_JURISDICTION) return null;
  const bioguideId = legislatorBioguideIndex.get(term.legislator_id);
  if (!bioguideId) return null;
  const member = memberIndex.get(bioguideId);
  if (!member) return null;
  const range = resolveServiceRangeForChamber(member.service?.[term.chamber] ?? []);
  if (!range || range.startYear == null) return null;
  return {
    start_date: congressionalTermDate(range.startYear),
    end_date: range.endYear != null ? congressionalTermDate(range.endYear) : null,
  };
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
// independent gate, independent fetch — see EFFICIENCY NOTE, header comment). dryRun:true performs
// every read live mode would (terms bulk load, legislator bioguide index, the roster fetch when at
// least one real candidate needs it) but never writes — `datesFilled`/`partialFilled` stay 0, and
// every row that WOULD be written lands in `plan` instead.
export async function runFederalTermDatesBackfill(client, {
  dryRun = false, runId = null,
  loadTermDateIndexFn = loadTermDateIndex,
  loadLegislatorBioguideIndexFn = loadLegislatorBioguideIndex,
  loadFederalMemberIndexFn = loadFederalMemberIndex,
} = {}) {
  const counts = emptyDateCounts();
  const plan = [];

  const rows = await loadTermDateIndexFn(client);
  counts.termsSeen = rows.length;

  const legislatorBioguideIndex = await loadLegislatorBioguideIndexFn(client);
  const needsRoster = rows.some((t) => t.jurisdiction_id === FEDERAL_JURISDICTION && t.start_date == null
    && legislatorBioguideIndex.has(t.legislator_id));
  const roster = needsRoster ? await loadFederalMemberIndexFn() : { index: new Map(), failures: [] };

  for (const term of rows) {
    if (term.start_date != null) { counts.alreadyDated += 1; continue; }
    // Non-federal (mo-legislature) undated terms have no bioguide identity to resolve against at
    // all — folded into the same catch-all `noMemberFound` bucket backfill-term-states.js's own
    // `memberNotFound` uses for its own out-of-scope cases, rather than inventing a 6th bucket the
    // brief's honest-count list does not ask for.
    if (term.jurisdiction_id !== FEDERAL_JURISDICTION) { counts.noMemberFound += 1; continue; }

    const resolved = resolveTermDates(term, { legislatorBioguideIndex, memberIndex: roster.index });
    if (!resolved) { counts.noMemberFound += 1; continue; }

    if (dryRun) { plan.push({ termId: term.id, ...resolved }); continue; }

    const patch = { start_date: resolved.start_date, run_id: runId };
    // end_date stays additive/absent (never guarded/written) when the member's service is still
    // open (no endYear on file) — the site already renders "(end date unrecorded)" honestly for
    // that case (site/js/districts.js's termDateEvidence).
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

  return { counts, plan: dryRun ? plan : undefined, failures: roster.failures };
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
    dryRun, runId, loadTermDateIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberIndexFn,
  });

  return {
    mode: dryRun ? 'dry-run' : 'live',
    counts,
    atLarge: atLarge.counts,
    dates: dates.counts,
    failures: [...roster.failures, ...dates.failures],
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
