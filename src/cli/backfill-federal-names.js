import {
  getClient, openRun, closeRun, selectAll,
} from '../lib/db.js';
import { SourceFetchError } from '../lib/errors.js';
import { fetchMemberPage, parseMemberList, congressLimiter } from '../adapters/us-congress.js';
import { loadTermIndex } from './backfill-term-states.js';

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
// member is exactly who this backfill needs to find.
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

// ---- orchestration (D2 + D3 combined into one run/report) ----

// runBackfillFederalNames — the testable seam. dryRun:true performs every read live mode would
// (placeholder scan, federal roster fetch when needed, terms bulk load) but never writes —
// `filled`/`atLarge.filled` stay 0, and every row that WOULD be written lands in `plan` instead
// (mirrors every other backfill CLI in this codebase).
export async function runBackfillFederalNames(client, {
  dryRun = false, runId = null,
  loadPlaceholderLegislatorsFn = loadPlaceholderLegislators,
  loadFederalMemberIndexFn = loadFederalMemberIndex,
  loadTermIndexFn = loadTermIndex,
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

  return {
    mode: dryRun ? 'dry-run' : 'live',
    counts,
    atLarge: atLarge.counts,
    failures: roster.failures,
    plan: dryRun ? { ...plan, atLarge: atLarge.plan } : undefined,
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
      counts: report.counts, atLarge: report.atLarge, failures: report.failures,
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
