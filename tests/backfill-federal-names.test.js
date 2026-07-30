import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  AT_LARGE_STATES,
  loadPlaceholderLegislators,
  loadFederalMemberIndex,
  runAtLargeBackfill,
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
  assert.deepEqual(index.get('P000604'), {
    full_name: 'Payne, Donald M.',
    party: 'Democratic',
    service: { house: [{ startYear: 2012, endYear: 2024 }], senate: [] },
  }, 'Payne — endYear 2024, departed, MUST still be found, with the T8c per-chamber service range attached');
  assert.deepEqual(index.get('S001154'), {
    full_name: 'Shuster, Bill',
    party: 'Republican',
    service: { house: [{ startYear: 2001, endYear: 2019 }], senate: [] },
  }, 'Shuster — endYear 2019, departed');
  assert.equal(index.get('G000607').full_name, 'Gallagher, James', 'a current member is still found too');
  assert.deepEqual(index.get('G000607').service.house, [{ startYear: 2026, endYear: null }], 'Gallagher is still serving — no endYear');
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

// ---- T8c: resolveTermDates (pure) ----

test('resolveTermDates: a house term with a bioguide match and a CLOSED service range fills both start_date and end_date via the January-3rd congressional-turnover convention', () => {
  const legislatorBioguideIndex = new Map([['leg-1', 'P000604']]);
  const memberIndex = new Map([['P000604', {
    full_name: 'Payne, Donald M.', party: 'Democratic', service: { house: [{ startYear: 2012, endYear: 2024 }], senate: [] },
  }]]);
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'us-congress', chamber: 'house', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex, memberIndex },
  );
  assert.deepEqual(result, { start_date: '2012-01-03', end_date: '2024-01-03' });
});

test('resolveTermDates: an OPEN (current) service range — no endYear on file — fills start_date only, end_date stays null', () => {
  const legislatorBioguideIndex = new Map([['leg-1', 'H000273']]);
  const memberIndex = new Map([['H000273', {
    full_name: 'Josh Hawley', party: 'Republican', service: { house: [], senate: [{ startYear: 2019, endYear: null }] },
  }]]);
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'us-congress', chamber: 'senate', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex, memberIndex },
  );
  assert.deepEqual(result, { start_date: '2019-01-03', end_date: null });
});

test('resolveTermDates: a non-us-congress (mo-legislature) term is never resolved — null, no bioguide identity applies there at all', () => {
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'mo-legislature', chamber: 'house', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex: new Map([['leg-1', 'X000001']]), memberIndex: new Map([['X000001', { service: { house: [{ startYear: 2020, endYear: null }] } }]]) },
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

test('resolveTermDates: a bioguide_id not present in the fetched 119th-Congress roster resolves to null (a truly historical/pre-119th member — honestly out of reach for this pass)', () => {
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'us-congress', chamber: 'senate', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex: new Map([['leg-1', 'B000000']]), memberIndex: new Map() },
  );
  assert.equal(result, null);
});

test('resolveTermDates: a member found in the roster but with NO service range for THIS specific chamber resolves to null (never borrows the other chamber\'s range)', () => {
  const legislatorBioguideIndex = new Map([['leg-1', 'W000812']]);
  const memberIndex = new Map([['W000812', { service: { house: [{ startYear: 2013, endYear: null }], senate: [] } }]]);
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'us-congress', chamber: 'senate', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex, memberIndex },
  );
  assert.equal(result, null, 'Wagner has a House range but no Senate range — a senate term row must not borrow it');
});

test('resolveTermDates: multiple stints in the same chamber — the range covering the 119th Congress (2025-2027) wins, not the first/last in array order', () => {
  const legislatorBioguideIndex = new Map([['leg-1', 'M000001']]);
  const memberIndex = new Map([['M000001', {
    service: {
      house: [
        { startYear: 1999, endYear: 2003 }, // an old, unrelated stint
        { startYear: 2023, endYear: null }, // covers the 119th — this one wins
      ],
      senate: [],
    },
  }]]);
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'us-congress', chamber: 'house', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex, memberIndex },
  );
  assert.deepEqual(result, { start_date: '2023-01-03', end_date: null });
});

test('resolveTermDates: multiple stints, NONE covering the 119th Congress — falls back to the most-recently-started range rather than guessing an arbitrary one', () => {
  const legislatorBioguideIndex = new Map([['leg-1', 'M000001']]);
  const memberIndex = new Map([['M000001', {
    service: {
      house: [
        { startYear: 1989, endYear: 1993 },
        { startYear: 1999, endYear: 2003 },
      ],
      senate: [],
    },
  }]]);
  const result = resolveTermDates(
    {
      id: 'term-1', jurisdiction_id: 'us-congress', chamber: 'house', legislator_id: 'leg-1',
    },
    { legislatorBioguideIndex, memberIndex },
  );
  assert.deepEqual(result, { start_date: '1999-01-03', end_date: '2003-01-03' });
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

test('runFederalTermDatesBackfill: a null-start_date term with a bioguide match and a CLOSED range fills both dates and is counted datesFilled', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', start_date: null, end_date: null,
  }];
  const loadLegislatorBioguideIndexFn = async () => new Map([['leg-1', 'P000604']]);
  const loadFederalMemberIndexFn = async () => ({
    index: new Map([['P000604', { service: { house: [{ startYear: 2012, endYear: 2024 }], senate: [] } }]]),
    failures: [],
  });

  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false, runId: 'run-1', loadTermDateIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberIndexFn,
  });

  assert.equal(report.counts.termsSeen, 1);
  assert.equal(report.counts.datesFilled, 1);
  assert.equal(client.calls.length, 1);
  const call = client.calls[0];
  assert.equal(call.patch.start_date, '2012-01-03');
  assert.equal(call.patch.end_date, '2024-01-03');
  assert.equal(call.patch.run_id, 'run-1');
  assert.deepEqual(call.eq, { col: 'id', val: 'term-1' });
  assert.deepEqual(call.is, [{ col: 'start_date', val: null }, { col: 'end_date', val: null }], 'both columns guarded .is(col, null)');
});

test('runFederalTermDatesBackfill: an OPEN service range fills start_date only — counted partialFilled, end_date never written or guarded', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'senate', start_date: null, end_date: null,
  }];
  const loadLegislatorBioguideIndexFn = async () => new Map([['leg-1', 'H000273']]);
  const loadFederalMemberIndexFn = async () => ({
    index: new Map([['H000273', { service: { house: [], senate: [{ startYear: 2019, endYear: null }] } }]]),
    failures: [],
  });

  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false, runId: 'run-1', loadTermDateIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberIndexFn,
  });

  assert.equal(report.counts.partialFilled, 1);
  assert.equal(report.counts.datesFilled, 0);
  const call = client.calls[0];
  assert.equal(call.patch.start_date, '2019-01-03');
  assert.ok(!Object.prototype.hasOwnProperty.call(call.patch, 'end_date'));
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
    loadFederalMemberIndexFn: async () => { throw new Error('must not be called — already dated'); },
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
    loadFederalMemberIndexFn: async () => { throw new Error('must not be called — not us-congress'); },
  });
  assert.equal(report.counts.noMemberFound, 1);
  assert.deepEqual(client.calls, []);
});

test('runFederalTermDatesBackfill: an undated us-congress term whose legislator has no bioguide_id is counted noMemberFound; the roster fetch is never worth paying for when it is the ONLY candidate', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-mo-only', jurisdiction_id: 'us-congress', chamber: 'house', start_date: null, end_date: null,
  }];
  let rosterCalled = false;
  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false,
    runId: 'run-1',
    loadTermDateIndexFn,
    loadLegislatorBioguideIndexFn: async () => new Map(),
    loadFederalMemberIndexFn: async () => { rosterCalled = true; return { index: new Map(), failures: [] }; },
  });
  assert.equal(report.counts.noMemberFound, 1);
  assert.equal(rosterCalled, false);
});

test('runFederalTermDatesBackfill: a bioguide match with no roster entry at all (pre-119th departure) is counted noMemberFound', async () => {
  const client = makeFakeTermDateWriteClient();
  const loadTermDateIndexFn = async () => [{
    id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'senate', start_date: null, end_date: null,
  }];
  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false,
    runId: 'run-1',
    loadTermDateIndexFn,
    loadLegislatorBioguideIndexFn: async () => new Map([['leg-1', 'B000000']]),
    loadFederalMemberIndexFn: async () => ({ index: new Map(), failures: [] }),
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
    loadFederalMemberIndexFn: async () => ({
      index: new Map([['P000604', { service: { house: [{ startYear: 2012, endYear: 2024 }], senate: [] } }]]),
      failures: [],
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
    loadFederalMemberIndexFn: async () => ({
      index: new Map([['P000604', { service: { house: [{ startYear: 2012, endYear: 2024 }], senate: [] } }]]),
      failures: [],
    }),
  });
  assert.equal(report.counts.datesFilled, 0, 'dry-run performs zero writes');
  assert.equal(report.plan.length, 1);
  assert.equal(report.plan[0].start_date, '2012-01-03');
  assert.equal(report.plan[0].end_date, '2024-01-03');
  assert.deepEqual(client.calls, []);
});

// ---- T8c: real-fixture end-to-end (real member-page-unfiltered.json, fake terms/legislator layer) ----

test('runFederalTermDatesBackfill: real fixture end-to-end — Payne (closed House stint) fills both dates; a current member with no endYear fills start_date only', async () => {
  const client = makeFakeTermDateWriteClient();
  const page = loadFixture('member-page-unfiltered.json');
  const fetchMemberPageFn = async () => page;
  const loadTermDateIndexFn = async () => [
    {
      id: 'term-payne', legislator_id: 'leg-payne', jurisdiction_id: 'us-congress', chamber: 'house', start_date: null, end_date: null,
    },
    {
      id: 'term-gallagher', legislator_id: 'leg-gallagher', jurisdiction_id: 'us-congress', chamber: 'house', start_date: null, end_date: null,
    },
  ];
  const loadLegislatorBioguideIndexFn = async () => new Map([
    ['leg-payne', 'P000604'],
    ['leg-gallagher', 'G000607'],
  ]);
  const loadFederalMemberIndexFn = async () => loadFederalMemberIndex({ fetchMemberPageFn });

  const report = await runFederalTermDatesBackfill(client, {
    dryRun: false, runId: 'run-1', loadTermDateIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberIndexFn,
  });

  assert.equal(report.counts.datesFilled, 1, 'Payne — closed stint');
  assert.equal(report.counts.partialFilled, 1, 'Gallagher — currently serving, no endYear');
  const payneCall = client.calls.find((c) => c.eq.val === 'term-payne');
  assert.equal(payneCall.patch.start_date, '2012-01-03');
  assert.equal(payneCall.patch.end_date, '2024-01-03');
  const gallagherCall = client.calls.find((c) => c.eq.val === 'term-gallagher');
  assert.equal(gallagherCall.patch.start_date, '2026-01-03');
  assert.ok(!Object.prototype.hasOwnProperty.call(gallagherCall.patch, 'end_date'));
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
  const dateClient = makeFakeTermWriteClient(); // reused verbatim: same .update().eq().is().select() shape
  const combinedClient = {
    from: (table) => (table === 'terms' ? dateClient.from(table) : client.from(table)),
  };
  const loadPlaceholderLegislatorsFn = async () => [
    {
      id: 'leg-1', full_name: 'W000812', bioguide_id: 'W000812', party: null,
    },
  ];
  // ONE roster stub serves BOTH D2's name-fill (bioguide W000812) and T8c's date-fill (bioguide
  // H000273) — the orchestrator passes the SAME `loadFederalMemberIndexFn` into both sub-passes,
  // exactly mirroring how a real congress.gov response would carry every bioguide either pass
  // might need.
  const loadFederalMemberIndexFn = async () => ({
    index: new Map([
      ['W000812', {
        full_name: 'Ann Wagner', party: 'Republican', service: { house: [{ startYear: 2013, endYear: null }], senate: [] },
      }],
      ['H000273', {
        full_name: 'Josh Hawley', party: 'Republican', service: { house: [], senate: [{ startYear: 2019, endYear: null }] },
      }],
    ]),
    failures: [],
  });
  const loadTermIndexFn = async () => ({ gated: false, rows: [] }); // D3: nothing at-large-shaped in this test
  const loadTermDateIndexFn = async () => [{
    id: 'term-date-1', legislator_id: 'leg-2', jurisdiction_id: 'us-congress', chamber: 'senate', start_date: null, end_date: null,
  }];
  const loadLegislatorBioguideIndexFn = async () => new Map([['leg-2', 'H000273']]);

  const report = await runBackfillFederalNames(combinedClient, {
    dryRun: false,
    runId: 'run-1',
    loadPlaceholderLegislatorsFn,
    loadFederalMemberIndexFn,
    loadTermIndexFn,
    loadTermDateIndexFn,
    loadLegislatorBioguideIndexFn,
  });

  assert.equal(report.counts.filled, 1, 'D2: Ann Wagner\'s placeholder name filled');
  assert.equal(report.atLarge.candidatesSeen, 0);
  assert.equal(report.dates.partialFilled, 1, 'T8c: Hawley\'s open Senate service fills start_date only');
  assert.equal(dateClient.calls.length, 1);
  assert.equal(dateClient.calls[0].patch.start_date, '2019-01-03');
  assert.ok(!Object.prototype.hasOwnProperty.call(dateClient.calls[0].patch, 'end_date'), 'open service never writes end_date');
});
