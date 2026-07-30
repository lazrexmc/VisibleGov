import {
  getClient, openRun, closeRun, selectAll, isMissingColumnError,
} from '../lib/db.js';
import { SourceFetchError } from '../lib/errors.js';
import { fetchMemberPage, parseMemberList } from '../adapters/us-congress.js';
import { stateAbbreviation } from '../adapters/us-senate.js';
import { isCurrentMember } from './ingest.js';

// backfill-term-states — Task 2 of the public-site plan
// (.superpowers/sdd/2026-07-30-public-site/task-2-brief.md). Fills `terms.state` (migration 0016,
// draft-then-apply — Lance's call when to run it): US House terms only ever stored a bare numeric
// district ('2'), never a state, which makes them unmatchable from a constituent's address without
// this column. Three fill rules, all additive (state is written ONLY where it is currently null):
//
//   - us-congress / house: the member's 2-letter state code, resolved via an EXACT bioguide_id
//     match against the CURRENT congress.gov member roster.
//   - us-congress / senate: a MECHANICAL COPY of the term's own `district` value — Senate terms
//     have stored the state's USPS abbreviation THERE since ensureSenateMembers/
//     ensureFederalMemberMetadata first created them (terms.district-as-state convention,
//     documented in ingest.js's loadCurrentSenators and enrich-federal-bills.js's
//     ensureFederalMemberMetadata) — no fetch needed, no new lookup, just read the column that is
//     already sitting there.
//   - mo-legislature (any chamber): the constant 'MO' — MO is this codebase's only non-federal
//     jurisdiction (verified: 'us-congress' and 'mo-legislature' are the only two jurisdiction_id
//     values written anywhere in this codebase), so no fetch is needed there either.
//
// REUSE, NOT REIMPLEMENT (brief's own instruction): the house-state lookup reuses
// fetchMemberPage/parseMemberList from src/adapters/us-congress.js and isCurrentMember from
// src/cli/ingest.js — the EXACT SAME fetch+parse+current-member-filter pipeline
// ensureFederalMemberMetadata (src/cli/enrich-federal-bills.js) already runs to build House/Senate
// terms in the first place. loadFederalMemberStateIndex below is a thin wrapper around that same
// pipeline, not a parallel member parser.
//
// SCALE: selectAll (src/lib/db.js) for every multi-row DB read (Global Constraints: "everything is
// past or near the 1,000-row cap") — terms/legislators are bulk-loaded ONCE per run into in-memory
// Maps, then every candidate is resolved as a pure Map lookup. The federal member roster
// (~2,694 members / 250 per page) is fetched at most once per run too, and ONLY when at least one
// house term actually needs it (a MO-only or already-fully-filled run never pays for it).
//
// GATING: migration 0016 is draft-then-apply — `terms.state` may not exist on the live DB yet.
// loadTermIndex is the ONE place this is decided: it tries the real bulk read WITH `state`
// included; if that 42703/PGRST204s (isMissingColumnError, src/lib/db.js), it falls back to the
// SAME bulk read minus `state` (which always succeeds — every other column here predates 0016) so
// termsSeen/gatedMissingColumn stay honest counts instead of unknown ones. Unlike
// backfill-mo-bill-meta.js's loadSponsorIndex gate (whose own "seen" count comes from an
// independent file source untouched by the gate), terms.state has no such independent source — the
// fallback read is what keeps termsSeen truthful here. Once gated, every remaining candidate is
// counted gatedMissingColumn without any further live query (mirrors backfill-nicknames.js's
// columnKnownMissing short-circuit), and neither the legislators bulk load nor the federal member
// roster fetch is even attempted.

const SOURCE = 'backfill-term-states';
const FEDERAL_JURISDICTION = 'us-congress';
const MO_JURISDICTION = 'mo-legislature';
const MO_STATE_CONSTANT = 'MO';
const MEMBER_PAGE_SIZE = 250;

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

// ---- federal roster: bioguide_id -> 2-letter state code ----

// loadFederalMemberStateIndex: pages the FULL current House+Senate roster via fetchMemberPage,
// filters to current members via isCurrentMember (ingest.js), then parses via parseMemberList
// (us-congress.js) — the SAME three functions ensureFederalMemberMetadata (enrich-federal-bills.js)
// already calls to build these members' terms rows in the first place. parseMemberList's `state`
// is congress.gov's full state name ('Missouri'); stateAbbreviation (us-senate.js) is the SAME
// bridge to the 2-letter code ensureFederalMemberMetadata already uses for Senate district values.
export async function loadFederalMemberStateIndex({ fetchMemberPageFn = fetchMemberPage } = {}) {
  const index = new Map();
  const failures = [];
  let offset = 0;
  for (;;) {
    let json;
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential paging, same precedent as
      // ensureFederalMemberMetadata (enrich-federal-bills.js), which this loop mirrors.
      json = await fetchMemberPageFn(offset, MEMBER_PAGE_SIZE);
    } catch (err) {
      if (!(err instanceof SourceFetchError)) throw err;
      failures.push({ step: `member page offset=${offset}`, message: err.message });
      break;
    }
    const raw = json.members ?? [];
    // parseMemberList throws on ANY member with no terms at all — pre-filter so one odd historical
    // record can't kill the whole page (same ruling ensureFederalMemberMetadata follows).
    const withTerms = raw.filter((m) => (m.terms?.item ?? []).length > 0);
    const current = withTerms.filter(isCurrentMember);
    let parsed = [];
    try {
      parsed = parseMemberList({ members: current });
    } catch (err) {
      failures.push({ step: `member page offset=${offset}`, message: err.message });
    }
    for (const m of parsed) {
      const abbrev = stateAbbreviation(m.state);
      if (abbrev) index.set(m.bioguide_id, abbrev);
    }
    if (raw.length < MEMBER_PAGE_SIZE) break;
    offset += MEMBER_PAGE_SIZE;
  }
  return { index, failures };
}

// ---- bulk index loaders (selectAll — see SCALE header comment) ----

// loadLegislatorBioguideIndex -> Map<legislator.id, bioguide_id>. Rows with no bioguide_id
// (MO-only legislators) are simply not indexed — never guessed.
export async function loadLegislatorBioguideIndex(client) {
  const { data, error } = await selectAll(client, 'legislators', 'id,bioguide_id');
  if (error) throw new Error(`backfill-term-states: legislators bulk load failed: ${error.message}`);
  const index = new Map();
  for (const row of data) {
    if (row.bioguide_id != null) index.set(row.id, row.bioguide_id);
  }
  return index;
}

// loadTermIndex -> { gated, rows }. See GATING header comment for the fallback rationale.
export async function loadTermIndex(client) {
  const { data, error } = await selectAll(client, 'terms', 'id,legislator_id,jurisdiction_id,chamber,district,state');
  if (!error) return { gated: false, rows: data };
  if (!isMissingColumnError(error, 'state')) {
    throw new Error(`backfill-term-states: terms bulk load failed: ${error.message}`);
  }
  const fallback = await selectAll(client, 'terms', 'id,legislator_id,jurisdiction_id,chamber,district');
  if (fallback.error) throw new Error(`backfill-term-states: terms bulk load failed: ${fallback.error.message}`);
  return { gated: true, rows: fallback.data.map((r) => ({ ...r, state: null })) };
}

// ---- orchestration ----

function emptyCounts() {
  return {
    termsSeen: 0, filled: 0, alreadySet: 0, memberNotFound: 0, gatedMissingColumn: 0,
  };
}

// resolveFillValue: pure — the three fill rules from the header comment, given one term row and
// the two prebuilt indexes. Returns the state string to fill, or null if nothing is resolvable
// (honestly counted memberNotFound by the caller, never guessed).
export function resolveFillValue(term, { legislatorIndex, federalMemberStateIndex }) {
  if (term.jurisdiction_id === MO_JURISDICTION) return MO_STATE_CONSTANT;
  if (term.jurisdiction_id === FEDERAL_JURISDICTION && term.chamber === 'house') {
    const bioguideId = legislatorIndex.get(term.legislator_id);
    if (!bioguideId) return null;
    return federalMemberStateIndex.get(bioguideId) ?? null;
  }
  if (term.jurisdiction_id === FEDERAL_JURISDICTION && term.chamber === 'senate') {
    return term.district ?? null; // mechanical copy — already a USPS state abbreviation
  }
  return null;
}

// runBackfillTermStates — the testable seam. dryRun:true performs every read live mode would (the
// term/legislator bulk loads, and the federal roster fetch when a house term needs it) but never
// calls .update() — `filled` stays 0 (mirrors backfill-mo-bill-meta.js/backfill-nicknames.js: the
// literal count of writes actually performed), and every row that WOULD be filled is instead
// collected into `plan`.
export async function runBackfillTermStates(client, {
  dryRun = false, runId = null,
  loadTermIndexFn = loadTermIndex,
  loadLegislatorBioguideIndexFn = loadLegislatorBioguideIndex,
  loadFederalMemberStateIndexFn = loadFederalMemberStateIndex,
} = {}) {
  const counts = emptyCounts();
  const plan = [];

  const { gated, rows } = await loadTermIndexFn(client);
  counts.termsSeen = rows.length;

  if (gated) {
    // Migration 0016 unapplied — a run-wide fact, not a per-row one (same "decided once, up front"
    // shape as backfill-mo-bill-meta.js's loadSponsorIndex gate). Neither bulk loader below is
    // worth calling: the legislators load is cheap but pointless with nothing to resolve against,
    // and the federal roster fetch is the one genuinely expensive call this file makes — never pay
    // for it on a run that cannot write anyway.
    counts.gatedMissingColumn = rows.length;
    return {
      mode: dryRun ? 'dry-run' : 'live', counts, failures: [], plan: dryRun ? plan : undefined,
    };
  }

  const legislatorIndex = await loadLegislatorBioguideIndexFn(client);
  const needsFederalRoster = rows.some(
    (t) => t.jurisdiction_id === FEDERAL_JURISDICTION && t.chamber === 'house' && t.state == null,
  );
  const federalRoster = needsFederalRoster
    ? await loadFederalMemberStateIndexFn()
    : { index: new Map(), failures: [] };

  let columnKnownMissing = false;

  for (const term of rows) {
    if (term.state != null) { counts.alreadySet += 1; continue; }

    const fillValue = resolveFillValue(term, {
      legislatorIndex, federalMemberStateIndex: federalRoster.index,
    });
    if (!fillValue) { counts.memberNotFound += 1; continue; }

    if (dryRun) {
      plan.push({ termId: term.id, state: fillValue });
      continue;
    }

    if (columnKnownMissing) { counts.gatedMissingColumn += 1; continue; }

    // eslint-disable-next-line no-await-in-loop -- sequential, same "small/infrequent backlog"
    // precedent as every other batch CLI in this codebase.
    const { error: updErr } = await client.from('terms')
      .update({ state: fillValue, run_id: runId })
      .eq('id', term.id)
      .is('state', null); // TOCTOU guard: only writes if state is STILL null at write time.
    if (updErr) {
      if (isMissingColumnError(updErr, 'state')) {
        columnKnownMissing = true;
        counts.gatedMissingColumn += 1;
        continue;
      }
      throw new Error(`backfill-term-states: state patch failed for terms.id=${term.id}: ${updErr.message}`);
    }
    counts.filled += 1;
  }

  return {
    mode: dryRun ? 'dry-run' : 'live', counts, failures: federalRoster.failures, plan: dryRun ? plan : undefined,
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
    const report = await runBackfillTermStates(client, { dryRun: true });
    console.log(JSON.stringify({ source: SOURCE, ...report }, null, 2));
    return;
  }

  const runId = await openRun(client, SOURCE);
  try {
    const report = await runBackfillTermStates(client, { dryRun: false, runId });
    await closeRun(client, runId, 'succeeded', { counts: report.counts, failures: report.failures });
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
