import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePersonYaml, loadCachedRoster, readCachedDatasetFull, buildLegiscanPresenceIndex, earliestLegiscanYear, matchRoster, lastNameOf, reconcile, parseArgs, runBackfillMoTermDates, citationString, updateTermStartDate, loadAdjudicationFile, runApplyOverrides } from '../src/cli/backfill-mo-term-dates.js';

const crossleyYaml = readFileSync('tests/fixtures/openstates-people/Aaron-Crossley-ba6eb394-0402-49ba-9917-c5618d8a1589.yml', 'utf8');
const schneltingYaml = readFileSync('tests/fixtures/openstates-people/Adam-Schnelting-f436aa10-c006-4128-9748-050bf50c4e21.yml', 'utf8');

test('parsePersonYaml maps a current House member with a day-precision start_date', () => {
  const p = parsePersonYaml(crossleyYaml);
  assert.equal(p.full_name, 'Aaron Crossley');
  assert.equal(p.family_name, 'Crossley');
  assert.match(p.openstates_id, /^ocd-person\//);
  const role = p.roles.find((r) => r.chamber === 'house');
  assert.equal(role.district, '29');
  assert.equal(role.start_date, '2023-01-04');
  assert.equal(role.end_date, null);
});

test('parsePersonYaml keeps full role history for a House→Senate transition member', () => {
  const p = parsePersonYaml(schneltingYaml);
  const senate = p.roles.find((r) => r.chamber === 'senate');
  assert.equal(senate.district, '23');
  assert.equal(senate.start_date, '2025-01-08');
  assert.equal(senate.end_date, null);
  const endedHouse = p.roles.filter((r) => r.chamber === 'house' && r.end_date);
  assert.ok(endedHouse.length >= 1, 'prior house roles carry end dates');
});

test('loadCachedRoster parses every yml in a dir and throws on a missing/empty dir', () => {
  const people = loadCachedRoster('tests/fixtures/openstates-people');
  assert.equal(people.length, 2);
  assert.ok(people.every((p) => p.openstates_id && Array.isArray(p.roles)));
  assert.throws(() => loadCachedRoster('tests/fixtures/does-not-exist'), /openstates-people cache/);
});

// The committed LegiScan fixture stores its envelope under `.dataset` (see legiscan-dataset.test.js).
// readCachedDatasetFull expects a top-level `.zip` field (the cache-file envelope shape), so build one.
// Uses 1608 fixture (8 roll calls) rather than 1579 (0 roll calls) to test the full bill/people/rollCalls path.
function writeCacheEnvelope() {
  const src = JSON.parse(readFileSync('tests/fixtures/research/legiscan/mo-2018-dataset-1608.json', 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'vg-ds-'));
  const path = join(dir, 'sess.json');
  writeFileSync(path, JSON.stringify({ session_id: 1608, year_start: 2018, zip: src.dataset.zip }));
  return path;
}

test('readCachedDatasetFull returns people AND rollCalls plus the envelope year', async () => {
  const path = writeCacheEnvelope();
  const out = await readCachedDatasetFull(path);
  assert.equal(out.ok, true);
  assert.equal(out.yearStart, 2018);
  assert.ok(Array.isArray(out.people) && out.people.length > 0);
  assert.ok(Array.isArray(out.rollCalls) && out.rollCalls.length > 0);
  assert.ok(out.rollCalls[0].chamber === 'H' || out.rollCalls[0].chamber === 'S');
});

test('readCachedDatasetFull returns ok:false on unreadable file (no throw)', async () => {
  const out = await readCachedDatasetFull('does/not/exist.json');
  assert.equal(out.ok, false);
});

const SESSIONS = [
  { yearStart: 2011, people: [{ people_id: 1 }], rollCalls: [] }, // presence only, pre-2015 (no roll calls)
  { yearStart: 2019, people: [{ people_id: 1 }, { people_id: 2 }],
    rollCalls: [
      { chamber: 'S', votes: [{ people_id: 1 }] },   // person 1 votes in Senate 2019
      { chamber: 'H', votes: [{ people_id: 2 }] },   // person 2 votes in House 2019
    ] },
  { yearStart: 2023, people: [{ people_id: 1 }],
    rollCalls: [{ chamber: 'S', votes: [{ people_id: 1 }] }] },
];

test('earliestLegiscanYear uses the chamber-matched vote year (defeats person.role), earliest wins', () => {
  const idx = buildLegiscanPresenceIndex(SESSIONS);
  assert.equal(earliestLegiscanYear(idx, 1, 'senate'), 2019); // first Senate vote, not 2011 presence
  assert.equal(earliestLegiscanYear(idx, 2, 'house'), 2019);
});

test('earliestLegiscanYear falls back to earliest presence year when no chamber-matched vote', () => {
  const idx = buildLegiscanPresenceIndex(SESSIONS);
  // person 1 never votes in the House -> fall back to earliest presence (2011)
  assert.equal(earliestLegiscanYear(idx, 1, 'house'), 2011);
});

test('earliestLegiscanYear returns null for an unknown people_id', () => {
  const idx = buildLegiscanPresenceIndex(SESSIONS);
  assert.equal(earliestLegiscanYear(idx, 999, 'senate'), null);
});

test('buildLegiscanPresenceIndex over the real 2018 fixture places Onder (16351) in the Senate that year', async () => {
  const src = JSON.parse(readFileSync('tests/fixtures/research/legiscan/mo-2018-dataset-1608.json', 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'vg-ds2-'));
  const path = join(dir, 'sess.json');
  writeFileSync(path, JSON.stringify({ session_id: 1608, year_start: 2018, zip: src.dataset.zip }));

  const decoded = await readCachedDatasetFull(path);
  const idx = buildLegiscanPresenceIndex([{ yearStart: decoded.yearStart, people: decoded.people, rollCalls: decoded.rollCalls }]);
  assert.equal(earliestLegiscanYear(idx, 16351, 'senate'), 2018);
});

const ROSTER = [
  { openstates_id: 'os-1', full_name: 'Jane Adams', family_name: 'Adams',
    roles: [{ chamber: 'house', district: '60', start_date: '2019-01-09', end_date: null }] },
  { openstates_id: 'os-2', full_name: 'Bob Baker', family_name: 'Baker',
    roles: [
      { chamber: 'senate', district: '2', start_date: '2023-01-04', end_date: null },
      { chamber: 'house', district: '60', start_date: '2017-01-04', end_date: '2023-01-03' }, // ended — must NOT steal seat house|60
    ] },
];

test('matchRoster joins by (chamber, district) on OPEN roles only and carries the role start_date', () => {
  const terms = [
    { termId: 't1', legislatorId: 'l1', chamber: 'house', district: '60', surname: 'Adams', legiscanPeopleId: 11 },
  ];
  const { matches, unmatchedTerms } = matchRoster(terms, ROSTER);
  assert.equal(matches.length, 1);
  assert.equal(unmatchedTerms.length, 0);
  assert.equal(matches[0].openStatesId, 'os-1'); // Adams, not Baker's ended house-60 role
  assert.equal(matches[0].startDate, '2019-01-09');
  assert.equal(matches[0].surnameOk, true);
});

test('matchRoster: a seat held by a different person yields surnameOk=false (retired Onder D2 case)', () => {
  const terms = [
    { termId: 't-onder', legislatorId: 'l-onder', chamber: 'senate', district: '2', surname: 'Onder', legiscanPeopleId: 16351 },
  ];
  const { matches, unmatchedTerms } = matchRoster(terms, ROSTER); // roster D2 senator is Baker, surname differs
  assert.equal(matches.length, 1);
  assert.equal(matches[0].surnameOk, false); // matched the seat but the surname disagrees -> flaggable
  assert.equal(unmatchedTerms.length, 0);
});

test('matchRoster: a term whose seat has no OPEN roster role goes to unmatchedTerms', () => {
  const terms = [
    { termId: 't-gone', legislatorId: 'l-gone', chamber: 'house', district: '99', surname: 'Ghost', legiscanPeopleId: 12 },
  ];
  const { matches, unmatchedTerms } = matchRoster(terms, ROSTER);
  assert.equal(matches.length, 0);
  assert.equal(unmatchedTerms.length, 1);
  assert.equal(unmatchedTerms[0].termId, 't-gone');
});

test('reconcile: matching years with a good surname agrees', () => {
  assert.deepEqual(reconcile({ startDate: '2019-01-09', legiscanYear: 2019, surnameOk: true }),
    { verdict: 'agree', reason: null });
});

test('reconcile flags a year mismatch', () => {
  assert.deepEqual(reconcile({ startDate: '2023-01-04', legiscanYear: 2019, surnameOk: true }),
    { verdict: 'flag', reason: 'year-mismatch' });
});

test('reconcile flags a missing OpenStates date before anything else', () => {
  assert.deepEqual(reconcile({ startDate: null, legiscanYear: 2019, surnameOk: true }),
    { verdict: 'flag', reason: 'no-openstates-date' });
});

test('reconcile flags a surname mismatch (e.g. matched seat, wrong person)', () => {
  assert.deepEqual(reconcile({ startDate: '2023-01-04', legiscanYear: 2023, surnameOk: false }),
    { verdict: 'flag', reason: 'surname-mismatch' });
});

test('reconcile flags when the cross-check has no year', () => {
  assert.deepEqual(reconcile({ startDate: '2019-01-09', legiscanYear: null, surnameOk: true }),
    { verdict: 'flag', reason: 'no-legiscan-year' });
});

test('parseArgs defaults apply to false and accepts --apply', () => {
  assert.equal(parseArgs([]).apply, false);
  assert.equal(parseArgs(['--apply']).apply, true);
});
test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

function fakeDeps() {
  return {
    loadTermsFn: async () => ([
      { termId: 't-house', legislatorId: 'l-house', chamber: 'house', district: '60' },
      { termId: 't-onder', legislatorId: 'l-onder', chamber: 'senate', district: '2' }, // retired, not in roster
    ]),
    loadLegislatorsFn: async () => new Map([
      ['l-house', { surname: 'Adams', legiscanPeopleId: 11 }],
      ['l-onder', { surname: 'Onder', legiscanPeopleId: 16351 }],
    ]),
    loadRosterFn: () => ([
      { openstates_id: 'os-1', full_name: 'Jane Adams', family_name: 'Adams',
        roles: [{ chamber: 'house', district: '60', start_date: '2019-01-09', end_date: null }] },
      // NOTE: no senate D2 member -> Onder's seat is unmatched
    ]),
    loadManifestFn: () => ({ commit: 'abc1234def', retrieved: '2026-08-06' }),
    loadPresenceIndexFn: async () => new Map([[11, {
      presenceYears: new Set([2019]), chamberVoteYears: { house: new Set([2019]), senate: new Set() },
    }]]),
  };
}

test('dry-run: an agreeing current member is planned (not written); Onder is unmatched and never written', async () => {
  const written = [];
  const report = await runBackfillMoTermDates(null, {
    apply: false, ...fakeDeps(),
    updateTermFn: async (_c, _r, row) => { written.push(row); return { written: true }; },
  });
  assert.equal(report.mode, 'dry-run');
  assert.equal(written.length, 0, 'dry-run writes nothing');
  assert.equal(report.plan.length, 1);
  assert.equal(report.plan[0].termId, 't-house');
  assert.equal(report.plan[0].startDate, '2019-01-09');
  assert.equal(report.counts.agreed, 1);
  // Onder: seat absent from roster -> unmatched flag, never planned/written
  assert.ok(report.flags.some((f) => f.termId === 't-onder' && f.reason === 'unmatched'));
  assert.ok(!report.plan.some((p) => p.termId === 't-onder'));
});

test('apply: an agreeing member is written via updateTermFn; end_date is never in the patch', async () => {
  const written = [];
  const report = await runBackfillMoTermDates(null, {
    apply: true, runId: 'run-9', ...fakeDeps(),
    updateTermFn: async (_c, runId, row) => { written.push({ runId, ...row }); return { written: true }; },
  });
  assert.equal(report.mode, 'live');
  assert.equal(written.length, 1);
  assert.equal(written[0].termId, 't-house');
  assert.equal(written[0].startDate, '2019-01-09');
  assert.equal(written[0].runId, 'run-9');
  assert.equal('endDate' in written[0], false); // end_date is never touched
  assert.equal(report.counts.written, 1);
  assert.equal(report.citations.length, 1);
  assert.match(report.citations[0].citation, /openstates\/people@abc1234def/);
});

// apply requires a real source-commit SHA for citations: an unreadable/missing manifest must
// block --apply entirely rather than silently write rows citing "@unknown" (dry-run may still
// show @unknown — it never writes).
test('runBackfillMoTermDates: apply:true with a missing/unreadable manifest (commit:null) refuses to apply', async () => {
  await assert.rejects(
    () => runBackfillMoTermDates(null, {
      apply: true, runId: 'run-9', ...fakeDeps(),
      loadManifestFn: () => ({ commit: null, retrieved: null }),
      updateTermFn: async () => { throw new Error('must not be called — apply should refuse before any write'); },
    }),
    /refusing to apply/,
  );
});

test('runBackfillMoTermDates: dry-run proceeds even with a missing manifest (commit:null) — plan is still built, citation shows @unknown', async () => {
  const report = await runBackfillMoTermDates(null, {
    apply: false, ...fakeDeps(),
    loadManifestFn: () => ({ commit: null, retrieved: null }),
  });
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.plan.length, 1);
  assert.match(report.plan[0].citation, /openstates\/people@unknown/);
});

// ---- updateTermStartDate (the real writer — direct test on the query chain, not just via the
// orchestrator's injected fake) ----

function makeUpdateTermFakeClient({ data = [{ id: 'term-1' }], error = null } = {}) {
  const calls = {
    table: null, patch: null, eq: null, is: null, selectCol: null,
  };
  return {
    calls,
    from: (table) => {
      calls.table = table;
      return {
        update: (patch) => {
          calls.patch = patch;
          const builder = {
            eq: (col, val) => { calls.eq = [col, val]; return builder; },
            is: (col, val) => { calls.is = [col, val]; return builder; },
            select: (col) => { calls.selectCol = col; return { data, error }; },
          };
          return builder;
        },
      };
    },
  };
}

test('updateTermStartDate: patch is EXACTLY {start_date, run_id} (no end_date), scoped by .eq(id,termId).is(start_date,null), then .select(id); non-empty data -> written:true', async () => {
  const client = makeUpdateTermFakeClient({ data: [{ id: 'term-1' }] });
  const result = await updateTermStartDate(client, 'run-1', { termId: 'term-1', startDate: '2019-01-09' });
  assert.equal(client.calls.table, 'terms');
  assert.deepEqual(client.calls.patch, { start_date: '2019-01-09', run_id: 'run-1' });
  assert.equal(Object.keys(client.calls.patch).length, 2, 'exactly two keys — no end_date');
  assert.ok(!('end_date' in client.calls.patch));
  assert.deepEqual(client.calls.eq, ['id', 'term-1']);
  assert.deepEqual(client.calls.is, ['start_date', null]);
  assert.equal(client.calls.selectCol, 'id');
  assert.deepEqual(result, { written: true });
});

test('updateTermStartDate: an empty data array (row no longer matches the null-start_date scope) yields written:false', async () => {
  const client = makeUpdateTermFakeClient({ data: [] });
  const result = await updateTermStartDate(client, 'run-1', { termId: 'term-1', startDate: '2019-01-09' });
  assert.deepEqual(result, { written: false });
});

test('updateTermStartDate: a DB error throws /start_date patch failed/', async () => {
  const client = makeUpdateTermFakeClient({ data: null, error: { message: 'connection reset' } });
  await assert.rejects(
    () => updateTermStartDate(client, 'run-1', { termId: 'term-1', startDate: '2019-01-09' }),
    /start_date patch failed/,
  );
});

// ---- adjudicated-overrides path (Lance ruling 2026-08-06: start_date = current-term start) ----

test('parseArgs accepts --apply-overrides <path>, composing with --apply', () => {
  assert.deepEqual(parseArgs(['--apply-overrides', 'f.json']), { apply: false, overridesPath: 'f.json' });
  assert.deepEqual(parseArgs(['--apply-overrides', 'f.json', '--apply']), { apply: true, overridesPath: 'f.json' });
  assert.equal(parseArgs([]).overridesPath, null);
  assert.throws(() => parseArgs(['--apply-overrides']), /requires a file path/);
});

const VALID_ADJUDICATION = {
  ruling: 'start_date means the start of the current term/stint',
  rulingDate: '2026-08-06',
  entries: [
    { termId: 't1', surname: 'Cook', chamber: 'house', district: '143', startDate: '2023-01-04', citation: 'openstates/people@abc … adjudicated per ruling' },
    { termId: 't2', surname: 'Crawford', chamber: 'senate', district: '28', startDate: '2017-09-13', citation: 'openstates/people@abc … adjudicated per ruling' },
  ],
};

test('loadAdjudicationFile parses a valid file and rejects malformed entries', () => {
  const readFileFn = () => JSON.stringify(VALID_ADJUDICATION);
  const adj = loadAdjudicationFile('adj.json', { readFileFn });
  assert.equal(adj.entries.length, 2);
  assert.match(adj.ruling, /current term/);

  const missingDate = { ...VALID_ADJUDICATION, entries: [{ termId: 't1', citation: 'c' }] };
  assert.throws(() => loadAdjudicationFile('adj.json', { readFileFn: () => JSON.stringify(missingDate) }), /invalid adjudication entry/);
  const badDate = { ...VALID_ADJUDICATION, entries: [{ termId: 't1', startDate: 'January 2023', citation: 'c' }] };
  assert.throws(() => loadAdjudicationFile('adj.json', { readFileFn: () => JSON.stringify(badDate) }), /invalid adjudication entry/);
  const noRuling = { ...VALID_ADJUDICATION, ruling: '' };
  assert.throws(() => loadAdjudicationFile('adj.json', { readFileFn: () => JSON.stringify(noRuling) }), /ruling/);
});

test('runApplyOverrides dry-run: plans every entry, writes nothing', async () => {
  const written = [];
  const report = await runApplyOverrides(null, {
    overrides: VALID_ADJUDICATION,
    apply: false,
    updateTermFn: async (_c, _r, row) => { written.push(row); return { written: true }; },
  });
  assert.equal(report.mode, 'dry-run');
  assert.equal(written.length, 0);
  assert.equal(report.plan.length, 2);
  assert.equal(report.plan[0].termId, 't1');
  assert.equal(report.counts.written, 0);
});

test('runApplyOverrides apply: writes each entry via updateTermFn, counts already-dated as skipped', async () => {
  const written = [];
  const report = await runApplyOverrides(null, {
    overrides: VALID_ADJUDICATION,
    apply: true,
    runId: 'run-ov',
    updateTermFn: async (_c, runId, row) => {
      written.push({ runId, ...row });
      return { written: row.termId !== 't2' }; // t2 simulates a row already dated (race / re-run)
    },
  });
  assert.equal(report.mode, 'live');
  assert.equal(written.length, 2);
  assert.equal(written[0].runId, 'run-ov');
  assert.equal('endDate' in written[0], false);
  assert.equal(report.counts.written, 1);
  assert.equal(report.counts.skippedAlreadyDated, 1);
  assert.equal(report.citations.length, 1);
  assert.equal(report.citations[0].termId, 't1');
  assert.match(report.citations[0].citation, /adjudicated per ruling/);
});
