import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  AT_LARGE_STATES,
  loadPlaceholderLegislators,
  loadFederalMemberIndex,
  runAtLargeBackfill,
  readCongressLegislatorsCache,
  resolveTermDates,
  loadTermDateIndex,
  runFederalTermDatesBackfill,
  runBackfillFederalNames,
} from '../src/cli/backfill-federal-names.js';
import { SourceFetchError } from '../src/lib/errors.js';

// Task 8b of the public-site plan (.superpowers/sdd/2026-07-30-public-site/task-8b-brief.md,
// findings D2 + D3). ZERO live congress.gov requests anywhere in this test file — every
// loadFederalMemberIndex test injects a fetchMemberPageFn stub; the real fixture used below
// (member-page-unfiltered.json) already carries BOTH current and departed (endYear-set) members,
// which is exactly the shape `/member/congress/119` (this task's endpoint) returns and the
// current-member-only `/member` endpoint used elsewhere in this codebase cannot — no new fixture
// capture was needed since parseMemberList does not care which endpoint produced the JSON.
//
// D2: fills full_name/party for legislators.full_name === legislators.bioguide_id (our OWN
// synthetic placeholder from vote-cast ingestion, ingest.js's persistUsCongress/persistUsSenate —
// never a real person's actual name, by construction). The update itself carries
// .eq('full_name', bioguide_id) as its own safety net — a real name can never equal its own
// bioguide id, so a race (or a logic bug) that reaches this code path with an already-real row
// simply patches zero rows (counted `alreadyReal`), never overwrites real data.
//
// D3: us-congress house terms with district IS NULL and state in the six-state at-large set
// (AK/DE/ND/SD/VT/WY — same list site/js/districts.js's matchReps documents, mirrored in
// src/adapters/us-congress.js's parseMemberList change) get district filled to '0'. Reuses
// loadTermIndex verbatim from backfill-term-states.js (same migration-0016 gate, same bulk read),
// not a parallel terms loader.

function loadFixture(name) {
  return JSON.parse(readFileSync(`tests/fixtures/us-congress/${name}`, 'utf8'));
}

// ---- parseArgs ----

test('parseArgs defaults dryRun to false and accepts --dry-run', () => {
  assert.equal(parseArgs([]).dryRun, false);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

// ---- AT_LARGE_STATES (D3 constant) ----

test('AT_LARGE_STATES: exactly the six single-congressional-district states of the 119th Congress', () => {
  assert.deepEqual([...AT_LARGE_STATES].sort(), ['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);
});

// ---- selectAll-shaped fake client (mirrors backfill-term-states.test.js's own convention) ----

function makeSelectAllFakeClient(seed = {}) {
  const tables = { legislators: [], terms: [], ...seed };
  return {
    tables,
    from(table) {
      return {
        select: (columns) => {
          const state = { filters: [] };
          const builder = {
            eq: (col, val) => { state.filters.push((r) => r[col] === val); return builder; },
            order: () => ({
              range: async (from, to) => {
                const filtered = tables[table].filter((r) => state.filters.every((f) => f(r)));
                return { data: filtered.slice(from, to + 1).map((r) => ({ ...r })), error: null };
              },
            }),
          };
          return builder;
        },
      };
    },
  };
}

// ---- loadPlaceholderLegislators ----

test('loadPlaceholderLegislators: rows where full_name === bioguide_id are placeholders; a row with a real name, or no bioguide_id, is not', async () => {
  const client = makeSelectAllFakeClient({
    legislators: [
      { id: 'leg-1', full_name: 'W000812', bioguide_id: 'W000812', party: null },
      { id: 'leg-2', full_name: 'Ann Wagner', bioguide_id: 'W000812x', party: 'Republican' },
      { id: 'leg-3', full_name: 'Some MO Legislator', bioguide_id: null, party: 'R' },
    ],
  });
  const placeholders = await loadPlaceholderLegislators(client);
  assert.equal(placeholders.length, 1);
  assert.equal(placeholders[0].id, 'leg-1');
});

test('loadPlaceholderLegislators: zero placeholders on an empty/clean table returns an empty array, never throws', async () => {
  const client = makeSelectAllFakeClient({ legislators: [] });
  const placeholders = await loadPlaceholderLegislators(client);
  assert.deepEqual(placeholders, []);
});

// ---- loadFederalMemberIndex (D2: pages /member/congress/{congress}, NOT filtered to current members) ----

test('loadFederalMemberIndex: real member-page-unfiltered.json fixture — BOTH current and departed (endYear-set) members land in the index (the whole point of this endpoint vs. the current-member-only one)', async () => {
  const page = loadFixture('member-page-unfiltered.json');
  const fetchMemberPageFn = async () => page;
  const { index, failures } = await loadFederalMemberIndex({ fetchMemberPageFn });

  assert.equal(failures.length, 0);
  assert.equal(index.size, 20);
  assert.deepEqual(index.get('P000604'), { full_name: 'Payne, Donald M.', party: 'Democratic' }, 'Payne — endYear 2024, departed, MUST still be found');
  assert.deepEqual(index.get('S001154'), { full_name: 'Shuster, Bill', party: 'Republican' }, 'Shuster — endYear 2019, departed');
  assert.equal(index.get('G000607').full_name, 'Gallagher, James', 'a current member is still found too');
});

test('loadFederalMemberIndex: passes the requested congress through to fetchMemberPageFn on every page', async () => {
  const seenArgs = [];
  const fetchMemberPageFn = async (offset, limit, limiter, congress) => {
    seenArgs.push({ offset, limit, congress });
    return { members: [] };
  };
  await loadFederalMemberIndex({ fetchMemberPageFn, congress: 119 });
  assert.equal(seenArgs.length, 1);
  assert.equal(seenArgs[0].congress, 119);
  assert.equal(seenArgs[0].offset, 0);
});

test('loadFederalMemberIndex: pages until a short page — a full 250-member page triggers a second fetch at offset 250', async () => {
  function rawMember(bioguideId) {
    return {
      bioguideId, name: `Member, ${bioguideId}`, partyName: 'Republican', state: 'Missouri', district: 1,
      terms: { item: [{ chamber: 'House of Representatives', startYear: 2025 }] },
    };
  }
  const page0 = { members: Array.from({ length: 250 }, (_, i) => rawMember(`P${String(i).padStart(6, '0')}`)) };
  const page1 = { members: [rawMember('Q000001')] };
  const calls = [];
  const fetchMemberPageFn = async (offset) => {
    calls.push(offset);
    return offset === 0 ? page0 : page1;
  };

  const { index } = await loadFederalMemberIndex({ fetchMemberPageFn });

  assert.deepEqual(calls, [0, 250]);
  assert.equal(index.size, 251);
  assert.ok(index.has('Q000001'));
});

test('loadFederalMemberIndex: a page-fetch SourceFetchError stops pagination and is reported as a typed failure, never a crash', async () => {
  const fetchMemberPageFn = async () => { throw new SourceFetchError('HTTP 500', { source: 'us-congress' }); };

  const { index, failures } = await loadFederalMemberIndex({ fetchMemberPageFn });

  assert.equal(index.size, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /HTTP 500/);
});

test('loadFederalMemberIndex: a member with zero term items is skipped (never reaches parseMemberList) and counted as a non-fatal failure', async () => {
  const fetchMemberPageFn = async () => ({
    members: [{
      bioguideId: 'Z000001', name: 'No Terms', partyName: 'I', terms: { item: [] },
    }],
  });
  const { index, failures } = await loadFederalMemberIndex({ fetchMemberPageFn });
  assert.equal(index.size, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /1 member\(s\) with no terms skipped/);
});

// ---- runAtLargeBackfill (D3) ----

// updateResults, keyed by the term's id (the `.eq('id', term.id)` value) — mirrors
// makeFakeLegislatorUpdateClient's own keyed-by-id override convention below. Default (no
// override) simulates the normal case: the guard matched and one row was updated.
function makeFakeTermWriteClient(updateResults = {}) {
  const calls = [];
  return {
    calls,
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => ({
          is: (col2, val2) => ({
            select: async (cols) => {
              calls.push({
                table, patch, eq: { col, val }, is: { col: col2, val: val2 }, select: cols,
              });
              const result = updateResults[val];
              return result ?? { data: [{ id: val }], error: null };
            },
          }),
        }),
      }),
    }),
  };
}

test('runAtLargeBackfill: a house term with null district and an at-large-set state is filled with "0"', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', district: null, state: 'WY',
    }],
  });
  const { counts } = await runAtLargeBackfill(client, { dryRun: false, runId: 'run-1', loadTermIndexFn });
  assert.equal(counts.candidatesSeen, 1);
  assert.equal(counts.filled, 1);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].patch.district, '0');
  assert.equal(client.calls[0].patch.run_id, 'run-1');
  assert.deepEqual(client.calls[0].eq, { col: 'id', val: 'term-1' });
  assert.deepEqual(client.calls[0].is, { col: 'district', val: null });
});

test('runAtLargeBackfill: a zero-rows-affected update (the .is(district, null) guard matched nothing at write time — a race with something else that already filled it) is honestly counted alreadyFilled, never filled', async () => {
  const client = makeFakeTermWriteClient({ 'term-1': { data: [], error: null } });
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', district: null, state: 'WY',
    }],
  });
  const { counts } = await runAtLargeBackfill(client, { dryRun: false, runId: 'run-1', loadTermIndexFn });
  assert.equal(counts.candidatesSeen, 1);
  assert.equal(counts.filled, 0);
  assert.equal(counts.alreadyFilled, 1);
  assert.equal(client.calls.length, 1);
});

test('runAtLargeBackfill: a house term with null district but a NON-at-large state is left untouched', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', district: null, state: 'MO',
    }],
  });
  const { counts } = await runAtLargeBackfill(client, { dryRun: false, runId: 'run-1', loadTermIndexFn });
  assert.equal(counts.candidatesSeen, 0);
  assert.equal(counts.filled, 0);
  assert.deepEqual(client.calls, []);
});

test('runAtLargeBackfill: a house term that already has a real district value is never touched, even for an at-large state', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', district: '5', state: 'WY',
    }],
  });
  const { counts } = await runAtLargeBackfill(client, { dryRun: false, runId: 'run-1', loadTermIndexFn });
  assert.equal(counts.candidatesSeen, 0);
  assert.deepEqual(client.calls, []);
});

test('runAtLargeBackfill: a SENATE term with null district and an at-large state is never touched — House only', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'senate', district: null, state: 'WY',
    }],
  });
  const { counts } = await runAtLargeBackfill(client, { dryRun: false, runId: 'run-1', loadTermIndexFn });
  assert.equal(counts.candidatesSeen, 0);
  assert.deepEqual(client.calls, []);
});

test('runAtLargeBackfill: a mo-legislature term with null district is never touched — us-congress only', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'mo-legislature', chamber: 'house', district: null, state: 'WY',
    }],
  });
  const { counts } = await runAtLargeBackfill(client, { dryRun: false, runId: 'run-1', loadTermIndexFn });
  assert.equal(counts.candidatesSeen, 0);
  assert.deepEqual(client.calls, []);
});

test('runAtLargeBackfill: migration 0016 unapplied (terms.state missing) — every shape-matching candidate is honestly gated, zero writes attempted', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: true,
    rows: [
      {
        id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', district: null, state: null,
      },
      {
        id: 'term-2', legislator_id: 'leg-2', jurisdiction_id: 'us-congress', chamber: 'senate', district: null, state: null,
      },
      {
        id: 'term-3', legislator_id: 'leg-3', jurisdiction_id: 'us-congress', chamber: 'house', district: '2', state: null,
      },
    ],
  });
  const { counts } = await runAtLargeBackfill(client, { dryRun: false, runId: 'run-1', loadTermIndexFn });
  assert.equal(counts.gatedMissingColumn, 1, 'only the house+null-district shape is a genuine candidate; senate and non-null-district rows are not counted even when gated');
  assert.equal(counts.filled, 0);
  assert.deepEqual(client.calls, []);
});

test('runAtLargeBackfill: --dry-run performs the same resolution but never writes; plan carries the would-fill rows', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', district: null, state: 'AK',
    }],
  });
  const { counts, plan } = await runAtLargeBackfill(client, { dryRun: true, loadTermIndexFn });
  assert.equal(counts.filled, 0);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].termId, 'term-1');
  assert.equal(plan[0].district, '0');
  assert.deepEqual(client.calls, []);
});

// ---- T8c: readCongressLegislatorsCache (mirrors the LegiScan ZIP-cache discipline exactly) ----

const CONGRESS_LEGISLATORS_FIXTURE_DIR = 'tests/fixtures/congress-legislators';

test('readCongressLegislatorsCache: real excerpt fixture dir — Payne/Shuster (historical) and Hawley (current) all resolve, isCurrent set correctly', () => {
  const { ok, index } = readCongressLegislatorsCache({ cacheDir: CONGRESS_LEGISLATORS_FIXTURE_DIR });
  assert.equal(ok, true);
  assert.equal(index.size, 3);
  assert.equal(index.get('P000604').isCurrent, false);
  assert.equal(index.get('S001154').isCurrent, false);
  assert.equal(index.get('H001089').isCurrent, true);
  assert.equal(index.get('P000604').terms.length, 7);
  assert.equal(index.get('H001089').terms.length, 2);
});

test('readCongressLegislatorsCache: a missing cache dir is honestly reported ok:false with an empty index, never throws, never fetches', () => {
  const { ok, index } = readCongressLegislatorsCache({ cacheDir: '.superpowers/artifacts/does-not-exist-congress-legislators' });
  assert.equal(ok, false);
  assert.equal(index.size, 0);
});

test('readCongressLegislatorsCache: only ONE of the two required files present is honestly ok:false (both current AND historical are required)', () => {
  const listFilesFn = (cacheDir, prefix) => (prefix === 'legislators-current-' ? [`${cacheDir}/legislators-current-x.json`] : []);
  const { ok } = readCongressLegislatorsCache({ cacheDir: 'irrelevant', listFilesFn });
  assert.equal(ok, false);
});

test('readCongressLegislatorsCache: malformed JSON in either file is honestly ok:false, never throws', () => {
  const listFilesFn = (cacheDir, prefix) => [`${cacheDir}/${prefix}x.json`];
  const readFileFn = (filePath) => (filePath.includes('historical') ? '{not valid json' : '[]');
  const { ok } = readCongressLegislatorsCache({ cacheDir: 'irrelevant', listFilesFn, readFileFn });
  assert.equal(ok, false);
});

test('readCongressLegislatorsCache: picks the LEXICOGRAPHICALLY-LATEST dated file per prefix when multiple snapshots are cached', () => {
  const listFilesFn = (cacheDir, prefix) => [`${cacheDir}/${prefix}2020-01-01.json`, `${cacheDir}/${prefix}2026-07-30.json`];
  const seenPaths = [];
  const readFileFn = (filePath) => { seenPaths.push(filePath); return '[]'; };
  readCongressLegislatorsCache({ cacheDir: 'c', listFilesFn, readFileFn });
  assert.ok(seenPaths.every((p) => p.includes('2026-07-30')), `expected only the latest-dated files read, got: ${seenPaths}`);
});

// ---- T8c: resolveTermDates (pure) — real Payne/Shuster/Hawley shapes, real verified dates ----

test('resolveTermDates: Payne — a CLOSED House career (died in office) — start_date/end_date are the REAL min/max term dates, never a synthesized convention', () => {
  const legislatorBioguideIndex = new Map([['leg-1', 'P000604']]);
  const memberIndex = new Map([['P000604', {
    isCurrent: false,
    terms: [
      { type: 'rep', start: '2012-11-15', end: '2013-01-03' },
      { type: 'rep', start: '2013-01-03', end: '2015-01-03' },
      { type: 'rep', start: '2015-01-06', end: '2017-01-03' },
      { type: 'rep', start: '2017-01-03', end: '2019-01-03' },
      { type: 'rep', start: '2019-01-03', end: '2021-01-03' },
      { type: 'rep', start: '2021-01-03', end: '2023-01-03' },
      { type: 'rep', start: '2023-01-03', end: '2024-04-24' },
    ],
  }]]);
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'us-congress', chamber: 'house', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex, memberIndex },
  );
  assert.deepEqual(result, { start_date: '2012-11-15', end_date: '2024-04-24' }, 'the canonical wrong-approach-breaker: NOT 2012-01-03/2024-01-03');
});

test('resolveTermDates: Shuster — a CLOSED House career (special-election start, real bounds)', () => {
  const legislatorBioguideIndex = new Map([['leg-1', 'S001154']]);
  const memberIndex = new Map([['S001154', {
    isCurrent: false,
    terms: [
      { type: 'rep', start: '2001-05-17', end: '2003-01-03' },
      { type: 'rep', start: '2003-01-07', end: '2005-01-03' },
      { type: 'rep', start: '2017-01-03', end: '2019-01-03' },
    ],
  }]]);
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'us-congress', chamber: 'house', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex, memberIndex },
  );
  assert.deepEqual(result, { start_date: '2001-05-17', end_date: '2019-01-03' });
});

test('resolveTermDates: Hawley — an OPEN Senate service (present in legislators-current, last term type matches) — end_date stays null despite the dataset\'s own scheduled 2031 end', () => {
  const legislatorBioguideIndex = new Map([['leg-1', 'H001089']]);
  const memberIndex = new Map([['H001089', {
    isCurrent: true,
    terms: [
      { type: 'sen', start: '2019-01-03', end: '2025-01-03' },
      { type: 'sen', start: '2025-01-03', end: '2031-01-03' },
    ],
  }]]);
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'us-congress', chamber: 'senate', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex, memberIndex },
  );
  assert.deepEqual(result, { start_date: '2019-01-03', end_date: null }, 'the scheduled-but-not-real 2031-01-03 end must never be written');
});

test('resolveTermDates: a non-us-congress (mo-legislature) term is never resolved — null, no bioguide identity applies there at all', () => {
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'mo-legislature', chamber: 'house', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex: new Map([['leg-1', 'X000001']]), memberIndex: new Map([['X000001', { isCurrent: true, terms: [{ type: 'rep', start: '2020-01-03' }] }]]) },
  );
  assert.equal(result, null);
});

test('resolveTermDates: a legislator with no bioguide_id on file resolves to null, never guessed', () => {
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'us-congress', chamber: 'house', legislator_id: 'leg-mo-only',
    },
    { legislatorBioguideIndex: new Map(), memberIndex: new Map() },
  );
  assert.equal(result, null);
});

test('resolveTermDates: a bioguide_id absent from BOTH dataset files resolves to null (a bioguide absent from both files → noMemberFound at the orchestration level)', () => {
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'us-congress', chamber: 'senate', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex: new Map([['leg-1', 'B000000']]), memberIndex: new Map() },
  );
  assert.equal(result, null);
});

test('resolveTermDates: a member found in the dataset but with NO term of THIS specific chamber\'s type resolves to null (never borrows the other chamber\'s dates)', () => {
  const legislatorBioguideIndex = new Map([['leg-1', 'W000812']]);
  const memberIndex = new Map([['W000812', { isCurrent: true, terms: [{ type: 'rep', start: '2013-01-03' }] }]]);
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'us-congress', chamber: 'senate', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex, memberIndex },
  );
  assert.equal(result, null, 'Wagner has a House term but no Senate term — a senate term row must not borrow it');
});

test('resolveTermDates: a member who moved chambers (House then Senate, currently serving Senate) — the CLOSED House stint gets real min/max dates, never null-ended, even though the member overall is still serving', () => {
  const legislatorBioguideIndex = new Map([['leg-1', 'M000001']]);
  const memberIndex = new Map([['M000001', {
    isCurrent: true,
    terms: [
      { type: 'rep', start: '2011-01-05', end: '2019-01-03' },
      { type: 'sen', start: '2019-01-03', end: '2025-01-03' }, // LAST term — this is what makes the member "open" for SENATE only
    ],
  }]]);
  const houseResult = resolveTermDates(
    {
      id: 'term-house', jurisdiction_id: 'us-congress', chamber: 'house', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex, memberIndex },
  );
  assert.deepEqual(houseResult, { start_date: '2011-01-05', end_date: '2019-01-03' }, 'House service is CLOSED (not the member\'s current chamber) — real end date, not null');
  const senateResult = resolveTermDates(
    {
      id: 'term-senate', jurisdiction_id: 'us-congress', chamber: 'senate', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex, memberIndex },
  );
  assert.deepEqual(senateResult, { start_date: '2019-01-03', end_date: null }, 'Senate IS the member\'s current/open chamber');
});

// ---- T8c: loadTermDateIndex (ungated — start_date/end_date exist since migration 0001) ----

function makeSelectAllTermsFakeClient(rows) {
  return {
    from: (table) => {
      assert.equal(table, 'terms');
      return {
        select: () => ({
          order: () => ({
            range: async (from, to) => ({ data: rows.slice(from, to + 1), error: null }),
          }),
        }),
      };
    },
  };
}

test('loadTermDateIndex: bulk-reads the full terms table including start_date/end_date, ungated', async () => {
  const client = makeSelectAllTermsFakeClient([
    {
      id: 't1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'senate', start_date: null, end_date: null,
    },
  ]);
  const rows = await loadTermDateIndex(client);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 't1');
});

test('loadTermDateIndex: an unrelated bulk-load error is thrown, never silently swallowed', async () => {
  const client = { from: () => ({ select: () => ({ order: () => ({ range: async () => ({ data: null, error: { message: 'connection reset' } }) }) }) }) };
  await assert.rejects(() => loadTermDateIndex(client), /connection reset/);
});

// ---- T8c: runFederalTermDatesBackfill (orchestration) ----

function makeFakeTermDateWriteClient(updateResults = {}) {
  const calls = [];
  return {
    calls,
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => {
          const guard = { conditions: [] };
          const chain = {
            is: (col2, val2) => {
              guard.conditions.push({ col: col2, val: val2 });
              return {
                is: chain.is, // supports a SECOND chained .is() (start_date AND end_date both null)
                select: async (cols) => {
                  calls.push({
                    table, patch, eq: { col, val }, is: [...guard.conditions], select: cols,
                  });
                  const result = updateResults[val];
                  return result ?? { data: [{ id: val }], error: null };
                },
              };
            },
          };
          return chain;
        },
      }),
    }),
  };
}

test('runFederalTermDatesBackfill: a null-start_date term with a bioguide match and a CLOSED career fills both REAL dates and is counted datesFilled', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', start_date: null, end_date: null,
  }];
  const loadLegislatorBioguideIndexFn = async () => new Map([['leg-1', 'P000604']]);
  const loadCongressLegislatorsIndexFn = () => ({
    ok: true,
    index: new Map([['P000604', {
      isCurrent: false,
      terms: [
        { type: 'rep', start: '2012-11-15', end: '2013-01-03' },
        { type: 'rep', start: '2023-01-03', end: '2024-04-24' },
      ],
    }]]),
  });

  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false, runId: 'run-1', loadTermDateIndexFn, loadLegislatorBioguideIndexFn, loadCongressLegislatorsIndexFn,
  });

  assert.equal(report.counts.termsSeen, 1);
  assert.equal(report.counts.datesFilled, 1);
  assert.equal(client.calls.length, 1);
  const call = client.calls[0];
  assert.equal(call.patch.start_date, '2012-11-15');
  assert.equal(call.patch.end_date, '2024-04-24');
  assert.equal(call.patch.run_id, 'run-1');
  assert.deepEqual(call.eq, { col: 'id', val: 'term-1' });
  assert.deepEqual(call.is, [{ col: 'start_date', val: null }, { col: 'end_date', val: null }], 'both columns guarded .is(col, null)');
});

test('runFederalTermDatesBackfill: an OPEN service (current member, matching last term type) fills start_date only — counted partialFilled, end_date never written or guarded', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'senate', start_date: null, end_date: null,
  }];
  const loadLegislatorBioguideIndexFn = async () => new Map([['leg-1', 'H001089']]);
  const loadCongressLegislatorsIndexFn = () => ({
    ok: true,
    index: new Map([['H001089', {
      isCurrent: true,
      terms: [
        { type: 'sen', start: '2019-01-03', end: '2025-01-03' },
        { type: 'sen', start: '2025-01-03', end: '2031-01-03' },
      ],
    }]]),
  });

  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false, runId: 'run-1', loadTermDateIndexFn, loadLegislatorBioguideIndexFn, loadCongressLegislatorsIndexFn,
  });

  assert.equal(report.counts.partialFilled, 1);
  assert.equal(report.counts.datesFilled, 0);
  const call = client.calls[0];
  assert.equal(call.patch.start_date, '2019-01-03');
  assert.ok(!Object.prototype.hasOwnProperty.call(call.patch, 'end_date'), 'the scheduled-but-not-real 2031 end must never be written');
  assert.deepEqual(call.is, [{ col: 'start_date', val: null }], 'end_date is never guarded since it is never written');
});

test('runFederalTermDatesBackfill: a term with start_date already set is counted alreadyDated and never touched', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', start_date: '2013-01-03', end_date: null,
  }];
  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false,
    runId: 'run-1',
    loadTermDateIndexFn,
    loadLegislatorBioguideIndexFn: async () => new Map(),
    loadCongressLegislatorsIndexFn: () => { throw new Error('must not be called — already dated'); },
  });
  assert.equal(report.counts.alreadyDated, 1);
  assert.deepEqual(client.calls, []);
});

test('runFederalTermDatesBackfill: a non-us-congress undated term is counted noMemberFound, never resolved', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'mo-legislature', chamber: 'house', start_date: null, end_date: null,
  }];
  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false,
    runId: 'run-1',
    loadTermDateIndexFn,
    loadLegislatorBioguideIndexFn: async () => new Map(),
    loadCongressLegislatorsIndexFn: () => { throw new Error('must not be called — not us-congress'); },
  });
  assert.equal(report.counts.noMemberFound, 1);
  assert.deepEqual(client.calls, []);
});

test('runFederalTermDatesBackfill: an undated us-congress term whose legislator has no bioguide_id is counted noMemberFound; the cache read is never worth paying for when it is the ONLY candidate', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-mo-only', jurisdiction_id: 'us-congress', chamber: 'house', start_date: null, end_date: null,
  }];
  let cacheRead = false;
  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false,
    runId: 'run-1',
    loadTermDateIndexFn,
    loadLegislatorBioguideIndexFn: async () => new Map(),
    loadCongressLegislatorsIndexFn: () => { cacheRead = true; return { ok: true, index: new Map() }; },
  });
  assert.equal(report.counts.noMemberFound, 1);
  assert.equal(cacheRead, false);
});

test('runFederalTermDatesBackfill: a bioguide match absent from the dataset (not in either file) is counted noMemberFound', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'senate', start_date: null, end_date: null,
  }];
  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false,
    runId: 'run-1',
    loadTermDateIndexFn,
    loadLegislatorBioguideIndexFn: async () => new Map([['leg-1', 'B000000']]),
    loadCongressLegislatorsIndexFn: () => ({ ok: true, index: new Map() }),
  });
  assert.equal(report.counts.noMemberFound, 1);
  assert.deepEqual(client.calls, []);
});

test('runFederalTermDatesBackfill: the cache is entirely missing/unreadable (ok:false) — every genuine candidate is counted noMemberFound, never a fetch, never a crash', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', start_date: null, end_date: null,
  }];
  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false,
    runId: 'run-1',
    loadTermDateIndexFn,
    loadLegislatorBioguideIndexFn: async () => new Map([['leg-1', 'P000604']]),
    loadCongressLegislatorsIndexFn: () => ({ ok: false, index: new Map() }),
  });
  assert.equal(report.counts.noMemberFound, 1);
  assert.deepEqual(client.calls, []);
});

test('runFederalTermDatesBackfill: a zero-rows-affected update (raced by something else that already dated the row) is honestly counted alreadyDated, never datesFilled/partialFilled', async () => {
  const client = makeFakeTermDateWriteClient({ 'term-1': { data: [], error: null } });
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', start_date: null, end_date: null,
  }];
  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false,
    runId: 'run-1',
    loadTermDateIndexFn,
    loadLegislatorBioguideIndexFn: async () => new Map([['leg-1', 'P000604']]),
    loadCongressLegislatorsIndexFn: () => ({
      ok: true,
      index: new Map([['P000604', { isCurrent: false, terms: [{ type: 'rep', start: '2012-11-15', end: '2024-04-24' }] }]]),
    }),
  });
  assert.equal(report.counts.alreadyDated, 1);
  assert.equal(report.counts.datesFilled, 0);
  assert.equal(report.counts.partialFilled, 0);
});

test('runFederalTermDatesBackfill: --dry-run performs the same resolution but never writes; plan carries the would-fill rows', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', start_date: null, end_date: null,
  }];
  const report = await runFederalTermDatesBackfill(client, {
    dryRun: true,
    loadTermDateIndexFn,
    loadLegislatorBioguideIndexFn: async () => new Map([['leg-1', 'P000604']]),
    loadCongressLegislatorsIndexFn: () => ({
      ok: true,
      index: new Map([['P000604', { isCurrent: false, terms: [{ type: 'rep', start: '2012-11-15', end: '2024-04-24' }] }]]),
    }),
  });
  assert.equal(report.counts.datesFilled, 0, 'dry-run performs zero writes');
  assert.equal(report.plan.length, 1);
  assert.equal(report.plan[0].start_date, '2012-11-15');
  assert.equal(report.plan[0].end_date, '2024-04-24');
  assert.deepEqual(client.calls, []);
});

// ---- T8c: real-fixture end-to-end (real congress-legislators excerpt dir, fake terms/legislator layer) ----

test('runFederalTermDatesBackfill: real excerpt fixture end-to-end — Payne (closed, died in office) and Shuster (closed, special-election start) fill real dates; Hawley (open Senate service) fills start_date only', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [
    {
      id: 'term-payne', legislator_id: 'leg-payne', jurisdiction_id: 'us-congress', chamber: 'house', start_date: null, end_date: null,
    },
    {
      id: 'term-shuster', legislator_id: 'leg-shuster', jurisdiction_id: 'us-congress', chamber: 'house', start_date: null, end_date: null,
    },
    {
      id: 'term-hawley', legislator_id: 'leg-hawley', jurisdiction_id: 'us-congress', chamber: 'senate', start_date: null, end_date: null,
    },
  ];
  const loadLegislatorBioguideIndexFn = async () => new Map([
    ['leg-payne', 'P000604'],
    ['leg-shuster', 'S001154'],
    ['leg-hawley', 'H001089'],
  ]);
  const loadCongressLegislatorsIndexFn = () => readCongressLegislatorsCache({ cacheDir: CONGRESS_LEGISLATORS_FIXTURE_DIR });

  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false, runId: 'run-1', loadTermDateIndexFn, loadLegislatorBioguideIndexFn, loadCongressLegislatorsIndexFn,
  });

  assert.equal(report.counts.datesFilled, 2, 'Payne + Shuster — both closed careers');
  assert.equal(report.counts.partialFilled, 1, 'Hawley — currently serving');

  const payneCall = client.calls.find((c) => c.eq.val === 'term-payne');
  assert.equal(payneCall.patch.start_date, '2012-11-15');
  assert.equal(payneCall.patch.end_date, '2024-04-24', 'the canonical wrong-approach-breaker, live-verified end to end');

  const shusterCall = client.calls.find((c) => c.eq.val === 'term-shuster');
  assert.equal(shusterCall.patch.start_date, '2001-05-17');
  assert.equal(shusterCall.patch.end_date, '2019-01-03');

  const hawleyCall = client.calls.find((c) => c.eq.val === 'term-hawley');
  assert.equal(hawleyCall.patch.start_date, '2019-01-03');
  assert.ok(!Object.prototype.hasOwnProperty.call(hawleyCall.patch, 'end_date'));
});

test('runFederalTermDatesBackfill: real excerpt fixture — a bioguide absent from both files is counted noMemberFound', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-unknown', legislator_id: 'leg-unknown', jurisdiction_id: 'us-congress', chamber: 'house', start_date: null, end_date: null,
  }];
  const loadLegislatorBioguideIndexFn = async () => new Map([['leg-unknown', 'Z999999']]);
  const loadCongressLegislatorsIndexFn = () => readCongressLegislatorsCache({ cacheDir: CONGRESS_LEGISLATORS_FIXTURE_DIR });

  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false, runId: 'run-1', loadTermDateIndexFn, loadLegislatorBioguideIndexFn, loadCongressLegislatorsIndexFn,
  });

  assert.equal(report.counts.noMemberFound, 1);
  assert.deepEqual(client.calls, []);
});

// ---- runBackfillFederalNames (D2 orchestration + D3 folded in) ----

function makeFakeLegislatorUpdateClient(updateResults = {}) {
  const calls = [];
  return {
    calls,
    from: (table) => ({
      update: (patch) => ({
        eq: (col1, val1) => ({
          eq: (col2, val2) => ({
            select: async (cols) => {
              calls.push({
                table, patch, eq1: { col: col1, val: val1 }, eq2: { col: col2, val: val2 }, select: cols,
              });
              const key = val1;
              const result = updateResults[key];
              return result ?? { data: [{ id: val1 }], error: null };
            },
          }),
        }),
      }),
    }),
  };
}

test('runBackfillFederalNames: a placeholder legislator found in the roster gets full_name+party filled, guarded by eq(full_name, bioguide_id)', async () => {
  const client = makeFakeLegislatorUpdateClient();
  const loadPlaceholderLegislatorsFn = async () => [
    {
      id: 'leg-1', full_name: 'W000812', bioguide_id: 'W000812', party: null,
    },
  ];
  const loadFederalMemberIndexFn = async () => ({
    index: new Map([['W000812', { full_name: 'Ann Wagner', party: 'Republican' }]]),
    failures: [],
  });
  const loadTermIndexFn = async () => ({ gated: false, rows: [] });

  const report = await runBackfillFederalNames(client, {
    dryRun: false,
    runId: 'run-1',
    loadPlaceholderLegislatorsFn,
    loadFederalMemberIndexFn,
    loadTermIndexFn,
    loadTermDateIndexFn: async () => [],
    loadLegislatorBioguideIndexFn: async () => new Map(),
  });

  assert.equal(report.counts.placeholdersSeen, 1);
  assert.equal(report.counts.filled, 1);
  assert.equal(client.calls.length, 1);
  const call = client.calls[0];
  assert.equal(call.patch.full_name, 'Ann Wagner');
  assert.equal(call.patch.party, 'Republican');
  assert.equal(call.patch.run_id, 'run-1');
  assert.deepEqual(call.eq1, { col: 'id', val: 'leg-1' });
  assert.deepEqual(call.eq2, { col: 'full_name', val: 'W000812' }, 'guard: a real name never equals its own bioguide id');
});

test('runBackfillFederalNames: a placeholder with an already-set party keeps its own party (additive — never overwritten by the roster fetch)', async () => {
  const client = makeFakeLegislatorUpdateClient();
  const loadPlaceholderLegislatorsFn = async () => [
    {
      id: 'leg-1', full_name: 'W000812', bioguide_id: 'W000812', party: 'Independent',
    },
  ];
  const loadFederalMemberIndexFn = async () => ({
    index: new Map([['W000812', { full_name: 'Ann Wagner', party: 'Republican' }]]),
    failures: [],
  });
  const report = await runBackfillFederalNames(client, {
    dryRun: false,
    runId: 'run-1',
    loadPlaceholderLegislatorsFn,
    loadFederalMemberIndexFn,
    loadTermIndexFn: async () => ({ gated: false, rows: [] }),
    loadTermDateIndexFn: async () => [],
    loadLegislatorBioguideIndexFn: async () => new Map(),
  });
  assert.equal(report.counts.filled, 1);
  assert.equal(client.calls[0].patch.full_name, 'Ann Wagner');
  assert.ok(!Object.prototype.hasOwnProperty.call(client.calls[0].patch, 'party'), 'party must not appear in the patch — already set, additive-only');
});

test('runBackfillFederalNames: a placeholder with no roster match is counted noMemberFound, never guessed', async () => {
  const client = makeFakeLegislatorUpdateClient();
  const loadPlaceholderLegislatorsFn = async () => [
    {
      id: 'leg-1', full_name: 'X999999', bioguide_id: 'X999999', party: null,
    },
  ];
  const loadFederalMemberIndexFn = async () => ({ index: new Map(), failures: [] });
  const report = await runBackfillFederalNames(client, {
    dryRun: false,
    runId: 'run-1',
    loadPlaceholderLegislatorsFn,
    loadFederalMemberIndexFn,
    loadTermIndexFn: async () => ({ gated: false, rows: [] }),
    loadTermDateIndexFn: async () => [],
    loadLegislatorBioguideIndexFn: async () => new Map(),
  });
  assert.equal(report.counts.noMemberFound, 1);
  assert.equal(report.counts.filled, 0);
  assert.deepEqual(client.calls, []);
});

test('runBackfillFederalNames: a TOCTOU race (row no longer matches the eq(full_name, bioguide_id) guard at write time) is honestly counted alreadyReal, never thrown', async () => {
  const client = makeFakeLegislatorUpdateClient({ 'leg-1': { data: [], error: null } });
  const loadPlaceholderLegislatorsFn = async () => [
    {
      id: 'leg-1', full_name: 'W000812', bioguide_id: 'W000812', party: null,
    },
  ];
  const loadFederalMemberIndexFn = async () => ({
    index: new Map([['W000812', { full_name: 'Ann Wagner', party: 'Republican' }]]),
    failures: [],
  });
  const report = await runBackfillFederalNames(client, {
    dryRun: false,
    runId: 'run-1',
    loadPlaceholderLegislatorsFn,
    loadFederalMemberIndexFn,
    loadTermIndexFn: async () => ({ gated: false, rows: [] }),
    loadTermDateIndexFn: async () => [],
    loadLegislatorBioguideIndexFn: async () => new Map(),
  });
  assert.equal(report.counts.alreadyReal, 1);
  assert.equal(report.counts.filled, 0);
});

test('runBackfillFederalNames: zero placeholders never triggers the federal roster fetch at all', async () => {
  const client = makeFakeLegislatorUpdateClient();
  const loadPlaceholderLegislatorsFn = async () => [];
  let rosterCalled = false;
  const loadFederalMemberIndexFn = async () => { rosterCalled = true; return { index: new Map(), failures: [] }; };
  const report = await runBackfillFederalNames(client, {
    dryRun: false,
    runId: 'run-1',
    loadPlaceholderLegislatorsFn,
    loadFederalMemberIndexFn,
    loadTermIndexFn: async () => ({ gated: false, rows: [] }),
    loadTermDateIndexFn: async () => [],
    loadLegislatorBioguideIndexFn: async () => new Map(),
  });
  assert.equal(report.counts.placeholdersSeen, 0);
  assert.equal(rosterCalled, false, 'no placeholders -> the (relatively expensive) federal roster fetch is never worth paying for');
  assert.deepEqual(client.calls, []);
});

test('runBackfillFederalNames: --dry-run performs the same resolution but never writes; plan carries the would-fill rows, atLarge sub-report included', async () => {
  const client = makeFakeLegislatorUpdateClient();
  const loadPlaceholderLegislatorsFn = async () => [
    {
      id: 'leg-1', full_name: 'W000812', bioguide_id: 'W000812', party: null,
    },
  ];
  const loadFederalMemberIndexFn = async () => ({
    index: new Map([['W000812', { full_name: 'Ann Wagner', party: 'Republican' }]]),
    failures: [],
  });
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-1', legislator_id: 'leg-2', jurisdiction_id: 'us-congress', chamber: 'house', district: null, state: 'VT',
    }],
  });

  const report = await runBackfillFederalNames(client, {
    dryRun: true,
    loadPlaceholderLegislatorsFn,
    loadFederalMemberIndexFn,
    loadTermIndexFn,
    loadTermDateIndexFn: async () => [],
    loadLegislatorBioguideIndexFn: async () => new Map(),
  });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.counts.filled, 0, 'dry-run performs zero writes');
  assert.equal(report.plan.fills.length, 1);
  assert.equal(report.plan.fills[0].fullName, 'Ann Wagner');
  assert.equal(report.atLarge.candidatesSeen, 1);
  assert.equal(report.atLarge.filled, 0, 'dry-run performs zero at-large writes either');
  assert.equal(report.dates.termsSeen, 0, 'zero term-date rows injected for this test');
  assert.deepEqual(client.calls, []);
});

test('runBackfillFederalNames: a live run combines D2 fills and D3 at-large fills into one report', async () => {
  const client = makeFakeLegislatorUpdateClient();
  const atLargeClient = makeFakeTermWriteClient();
  const combinedClient = {
    from: (table) => (table === 'terms' ? atLargeClient.from(table) : client.from(table)),
  };
  const loadPlaceholderLegislatorsFn = async () => [
    {
      id: 'leg-1', full_name: 'W000812', bioguide_id: 'W000812', party: null,
    },
  ];
  const loadFederalMemberIndexFn = async () => ({
    index: new Map([['W000812', { full_name: 'Ann Wagner', party: 'Republican' }]]),
    failures: [],
  });
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-1', legislator_id: 'leg-2', jurisdiction_id: 'us-congress', chamber: 'house', district: null, state: 'SD',
    }],
  });

  const report = await runBackfillFederalNames(combinedClient, {
    dryRun: false,
    runId: 'run-1',
    loadPlaceholderLegislatorsFn,
    loadFederalMemberIndexFn,
    loadTermIndexFn,
    loadTermDateIndexFn: async () => [],
    loadLegislatorBioguideIndexFn: async () => new Map(),
  });

  assert.equal(report.counts.filled, 1);
  assert.equal(report.atLarge.filled, 1);
  assert.equal(atLargeClient.calls[0].patch.district, '0');
});

test('runBackfillFederalNames: a live run combines D2 fills, D3 at-large fills, AND T8c date fills into one report', async () => {
  const client = makeFakeLegislatorUpdateClient();
  const dateClient = makeFakeTermDateWriteClient(); // T8c's own compound .is().is().select() shape
  const combinedClient = {
    from: (table) => (table === 'terms' ? dateClient.from(table) : client.from(table)),
  };
  const loadPlaceholderLegislatorsFn = async () => [
    {
      id: 'leg-1', full_name: 'W000812', bioguide_id: 'W000812', party: null,
    },
  ];
  // D2's roster (congress.gov shape, name/party only) and T8c's dataset (congress-legislators
  // shape, real per-term dates) are now DECOUPLED — separate loaders, separate stubs, exactly as
  // the source file's own two independent fetch/read paths.
  const loadFederalMemberIndexFn = async () => ({
    index: new Map([['W000812', { full_name: 'Ann Wagner', party: 'Republican' }]]),
    failures: [],
  });
  const loadTermIndexFn = async () => ({ gated: false, rows: [] }); // D3: nothing at-large-shaped in this test
  const loadTermDateIndexFn = async () => [{
    id: 'term-date-1', legislator_id: 'leg-2', jurisdiction_id: 'us-congress', chamber: 'senate', start_date: null, end_date: null,
  }];
  const loadLegislatorBioguideIndexFn = async () => new Map([['leg-2', 'H001089']]);
  const loadCongressLegislatorsIndexFn = () => ({
    ok: true,
    index: new Map([['H001089', {
      isCurrent: true,
      terms: [{ type: 'sen', start: '2019-01-03', end: '2025-01-03' }, { type: 'sen', start: '2025-01-03', end: '2031-01-03' }],
    }]]),
  });

  const report = await runBackfillFederalNames(combinedClient, {
    dryRun: false,
    runId: 'run-1',
    loadPlaceholderLegislatorsFn,
    loadFederalMemberIndexFn,
    loadTermIndexFn,
    loadTermDateIndexFn,
    loadLegislatorBioguideIndexFn,
    loadCongressLegislatorsIndexFn,
  });

  assert.equal(report.counts.filled, 1, 'D2: Ann Wagner\'s placeholder name filled');
  assert.equal(report.atLarge.candidatesSeen, 0);
  assert.equal(report.dates.partialFilled, 1, 'T8c: Hawley\'s open Senate service fills start_date only');
  assert.equal(dateClient.calls.length, 1);
  assert.equal(dateClient.calls[0].patch.start_date, '2019-01-03');
  assert.ok(!Object.prototype.hasOwnProperty.call(dateClient.calls[0].patch, 'end_date'), 'open service never writes end_date');
});
