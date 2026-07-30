import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  AT_LARGE_STATES,
  loadPlaceholderLegislators,
  loadFederalMemberIndex,
  runAtLargeBackfill,
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

function makeFakeTermWriteClient() {
  const calls = [];
  return {
    calls,
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => ({
          is: async (col2, val2) => {
            calls.push({
              table, patch, eq: { col, val }, is: { col: col2, val: val2 },
            });
            return { error: null };
          },
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
    dryRun: false, runId: 'run-1', loadPlaceholderLegislatorsFn, loadFederalMemberIndexFn, loadTermIndexFn,
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
    dryRun: false, runId: 'run-1', loadPlaceholderLegislatorsFn, loadFederalMemberIndexFn, loadTermIndexFn: async () => ({ gated: false, rows: [] }),
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
    dryRun: false, runId: 'run-1', loadPlaceholderLegislatorsFn, loadFederalMemberIndexFn, loadTermIndexFn: async () => ({ gated: false, rows: [] }),
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
    dryRun: false, runId: 'run-1', loadPlaceholderLegislatorsFn, loadFederalMemberIndexFn, loadTermIndexFn: async () => ({ gated: false, rows: [] }),
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
    dryRun: false, runId: 'run-1', loadPlaceholderLegislatorsFn, loadFederalMemberIndexFn, loadTermIndexFn: async () => ({ gated: false, rows: [] }),
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
    dryRun: true, loadPlaceholderLegislatorsFn, loadFederalMemberIndexFn, loadTermIndexFn,
  });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.counts.filled, 0, 'dry-run performs zero writes');
  assert.equal(report.plan.fills.length, 1);
  assert.equal(report.plan.fills[0].fullName, 'Ann Wagner');
  assert.equal(report.atLarge.candidatesSeen, 1);
  assert.equal(report.atLarge.filled, 0, 'dry-run performs zero at-large writes either');
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
    dryRun: false, runId: 'run-1', loadPlaceholderLegislatorsFn, loadFederalMemberIndexFn, loadTermIndexFn,
  });

  assert.equal(report.counts.filled, 1);
  assert.equal(report.atLarge.filled, 1);
  assert.equal(atLargeClient.calls[0].patch.district, '0');
});
