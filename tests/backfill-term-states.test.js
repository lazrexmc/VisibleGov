import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  loadFederalMemberStateIndex,
  loadLegislatorBioguideIndex,
  loadTermIndex,
  runBackfillTermStates,
} from '../src/cli/backfill-term-states.js';
import { SourceFetchError } from '../src/lib/errors.js';

// Task 2 of the public-site plan
// (.superpowers/sdd/2026-07-30-public-site/task-2-brief.md): terms.state backfill (migration 0016,
// draft-then-apply — the column does not exist on the live DB yet, so this whole file is
// fixture/fake-client-tested only; ZERO live Supabase writes, ZERO live congress.gov requests
// anywhere in this test file). House states come from us-congress.js's own member fetch+parse
// (the SAME fetchMemberPage/parseMemberList pair ensureFederalMemberMetadata in
// enrich-federal-bills.js already uses — reused here, not reimplemented). Senate states are a
// mechanical copy of the term's own existing `district` value (already a USPS state abbreviation,
// per ensureSenateMembers'/ensureFederalMemberMetadata's own terms.district-as-state convention).
// MO terms get the constant 'MO'. Additive-only throughout: state is filled ONLY where it is
// currently null.

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

// ---- loadFederalMemberStateIndex (reuses us-congress.js's fetch+parse; no parallel parser) ----

test('loadFederalMemberStateIndex: real member-page-unfiltered.json fixture — current members map bioguide_id -> 2-letter state code, historical members (endYear set) are excluded', async () => {
  const page = loadFixture('member-page-unfiltered.json');
  const fetchMemberPageFn = async () => page;
  const { index, failures } = await loadFederalMemberStateIndex({ fetchMemberPageFn });

  assert.equal(failures.length, 0);
  assert.equal(index.get('G000607'), 'CA', 'Gallagher — current (no endYear), California');
  assert.equal(index.get('M001245'), 'TX', 'Menefee — current, Texas');
  assert.equal(index.get('M001236'), 'NC', 'Moore — current, North Carolina');
  assert.equal(index.has('P000604'), false, 'Payne — endYear 2024, historical, excluded');
  assert.equal(index.has('S001154'), false, 'Shuster — endYear 2019, historical, excluded');
  assert.equal(index.has('H001092'), false, 'Hall — endYear 2021, historical, excluded');
  assert.equal(index.has('M000843'), false, 'Molinari — endYear 1999, historical, excluded');
});

test('loadFederalMemberStateIndex: real members-mo.json fixture — Ann Wagner (current MO House member) resolves to state abbreviation MO', async () => {
  const page = loadFixture('members-mo.json');
  const fetchMemberPageFn = async () => page;
  const { index } = await loadFederalMemberStateIndex({ fetchMemberPageFn });

  assert.equal(index.get('W000812'), 'MO');
});

test('loadFederalMemberStateIndex: pages until a short page — a full 250-member page triggers a second fetch at offset 250', async () => {
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

  const { index } = await loadFederalMemberStateIndex({ fetchMemberPageFn });

  assert.deepEqual(calls, [0, 250]);
  assert.equal(index.size, 251);
  assert.equal(index.get('Q000001'), 'MO');
});

test('loadFederalMemberStateIndex: a page-fetch SourceFetchError stops pagination and is reported as a typed failure, never a crash', async () => {
  const fetchMemberPageFn = async () => { throw new SourceFetchError('HTTP 500', { source: 'us-congress' }); };

  const { index, failures } = await loadFederalMemberStateIndex({ fetchMemberPageFn });

  assert.equal(index.size, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /HTTP 500/);
});

// ---- selectAll-shaped fake client (mirrors backfill-mo-bill-meta-cli.test.js / enrich-federal-bills-cli.test.js) ----

function missingColumnError(column, table) {
  return { code: '42703', message: `column "${column}" of relation "${table}" does not exist` };
}

function makeSelectAllFakeClient(seed = {}, { forceMissingColumns = [] } = {}) {
  const tables = { terms: [], legislators: [], ...seed };
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
                const hit = forceMissingColumns.find((m) => m.table === table && columns.includes(m.column));
                if (hit) return { data: null, error: missingColumnError(hit.column, table) };
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

// ---- loadLegislatorBioguideIndex ----

test('loadLegislatorBioguideIndex: Map keyed by legislator id -> bioguide_id, skipping rows where it is null (MO-only legislators)', async () => {
  const client = makeSelectAllFakeClient({
    legislators: [
      { id: 'leg-1', bioguide_id: 'W000812' },
      { id: 'leg-2', bioguide_id: null },
    ],
  });
  const index = await loadLegislatorBioguideIndex(client);
  assert.equal(index.size, 1);
  assert.equal(index.get('leg-1'), 'W000812');
  assert.equal(index.has('leg-2'), false);
});

// ---- loadTermIndex (migration 0016 gate) ----

test('loadTermIndex: migration 0016 applied — bulk read includes the real state column, gated:false', async () => {
  const client = makeSelectAllFakeClient({
    terms: [{
      id: 't1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', district: '2', state: null,
    }],
  });
  const { gated, rows } = await loadTermIndex(client);
  assert.equal(gated, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 't1');
});

test('loadTermIndex: migration 0016 unapplied (terms.state column missing) -> gated:true, falls back to a state-less bulk read so termsSeen stays honest instead of unknown', async () => {
  const client = makeSelectAllFakeClient(
    {
      terms: [
        {
          id: 't1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', district: '2', state: null,
        },
        {
          id: 't2', legislator_id: 'leg-2', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '5', state: null,
        },
      ],
    },
    { forceMissingColumns: [{ table: 'terms', column: 'state' }] },
  );
  const { gated, rows } = await loadTermIndex(client);
  assert.equal(gated, true);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.state === null));
});

test('loadTermIndex: an unrelated bulk-load error is thrown, never silently gated', async () => {
  const client = {
    from: () => ({
      select: () => ({
        order: () => ({ range: async () => ({ data: null, error: { code: '500', message: 'connection reset' } }) }),
      }),
    }),
  };
  await assert.rejects(() => loadTermIndex(client), /connection reset/);
});

// ---- runBackfillTermStates (orchestration; injected loaders, mirrors backfill-mo-bill-meta-cli.test.js) ----

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

test('runBackfillTermStates: a house term with null state is filled from the federal member-state index via bioguide exact match', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', district: '2', state: null,
    }],
  });
  const loadLegislatorBioguideIndexFn = async () => new Map([['leg-1', 'W000812']]);
  const loadFederalMemberStateIndexFn = async () => ({ index: new Map([['W000812', 'MO']]), failures: [] });

  const report = await runBackfillTermStates(client, {
    dryRun: false, runId: 'run-1', loadTermIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberStateIndexFn,
  });

  assert.equal(report.counts.termsSeen, 1);
  assert.equal(report.counts.filled, 1);
  assert.equal(client.calls.length, 1);
  const call = client.calls[0];
  assert.equal(call.table, 'terms');
  assert.equal(call.patch.state, 'MO');
  assert.equal(call.patch.run_id, 'run-1');
  assert.deepEqual(call.eq, { col: 'id', val: 'term-1' });
  assert.deepEqual(call.is, { col: 'state', val: null }, 'TOCTOU guard: only writes where state is still null');
});

test('runBackfillTermStates: a senate term with null state is filled by mechanically copying its existing district value (already a state abbreviation); no member fetch is consulted', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-2', legislator_id: 'leg-2', jurisdiction_id: 'us-congress', chamber: 'senate', district: 'MO', state: null,
    }],
  });
  const loadLegislatorBioguideIndexFn = async () => new Map();
  let federalIndexCalled = false;
  const loadFederalMemberStateIndexFn = async () => { federalIndexCalled = true; return { index: new Map(), failures: [] }; };

  const report = await runBackfillTermStates(client, {
    dryRun: false, runId: 'run-1', loadTermIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberStateIndexFn,
  });

  assert.equal(report.counts.filled, 1);
  assert.equal(client.calls[0].patch.state, 'MO');
  assert.equal(federalIndexCalled, false, 'senate state is a mechanical copy of district — never needs the federal roster fetch');
});

test('runBackfillTermStates: a senate term with no district on file has nothing to copy — honestly counted memberNotFound, never filled with an empty value', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-2b', legislator_id: 'leg-2b', jurisdiction_id: 'us-congress', chamber: 'senate', district: null, state: null,
    }],
  });
  const loadLegislatorBioguideIndexFn = async () => new Map();
  const loadFederalMemberStateIndexFn = async () => ({ index: new Map(), failures: [] });

  const report = await runBackfillTermStates(client, {
    dryRun: false, runId: 'run-1', loadTermIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberStateIndexFn,
  });

  assert.equal(report.counts.memberNotFound, 1);
  assert.equal(report.counts.filled, 0);
  assert.deepEqual(client.calls, []);
});

test('runBackfillTermStates: a mo-legislature term with null state is filled with the constant MO; no member fetch is consulted', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-3', legislator_id: 'leg-3', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '10', state: null,
    }],
  });
  const loadLegislatorBioguideIndexFn = async () => new Map();
  let federalIndexCalled = false;
  const loadFederalMemberStateIndexFn = async () => { federalIndexCalled = true; return { index: new Map(), failures: [] }; };

  const report = await runBackfillTermStates(client, {
    dryRun: false, runId: 'run-1', loadTermIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberStateIndexFn,
  });

  assert.equal(report.counts.filled, 1);
  assert.equal(client.calls[0].patch.state, 'MO');
  assert.equal(federalIndexCalled, false, 'MO constant fill never needs the federal roster fetch');
});

test('runBackfillTermStates: a term with state already set is counted alreadySet and never overwritten (additive-only, fills-null)', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-4', legislator_id: 'leg-4', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '5', state: 'MO',
    }],
  });
  const loadLegislatorBioguideIndexFn = async () => new Map();
  const loadFederalMemberStateIndexFn = async () => ({ index: new Map(), failures: [] });

  const report = await runBackfillTermStates(client, {
    dryRun: false, runId: 'run-1', loadTermIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberStateIndexFn,
  });

  assert.equal(report.counts.alreadySet, 1);
  assert.equal(report.counts.filled, 0);
  assert.deepEqual(client.calls, []);
});

test('runBackfillTermStates: a house term whose legislator has no bioguide match in the current roster is honestly counted memberNotFound, never guessed', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-5', legislator_id: 'leg-5', jurisdiction_id: 'us-congress', chamber: 'house', district: '9', state: null,
    }],
  });
  const loadLegislatorBioguideIndexFn = async () => new Map([['leg-5', 'X999999']]); // has a bioguide, but not in the current roster
  const loadFederalMemberStateIndexFn = async () => ({ index: new Map(), failures: [] });

  const report = await runBackfillTermStates(client, {
    dryRun: false, runId: 'run-1', loadTermIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberStateIndexFn,
  });

  assert.equal(report.counts.memberNotFound, 1);
  assert.deepEqual(client.calls, []);
});

test('runBackfillTermStates: --dry-run performs the same resolution as live mode but never writes; filled stays 0 (mirrors every other backfill CLI), would-fill rows land in plan', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [
      {
        id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', district: '2', state: null,
      },
      {
        id: 'term-3', legislator_id: 'leg-3', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '10', state: null,
      },
      {
        id: 'term-4', legislator_id: 'leg-4', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '5', state: 'MO',
      },
    ],
  });
  const loadLegislatorBioguideIndexFn = async () => new Map([['leg-1', 'W000812']]);
  const loadFederalMemberStateIndexFn = async () => ({ index: new Map([['W000812', 'MO']]), failures: [] });

  const report = await runBackfillTermStates(client, {
    dryRun: true, loadTermIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberStateIndexFn,
  });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.counts.filled, 0, 'dry-run performs zero writes');
  assert.equal(report.counts.alreadySet, 1);
  assert.equal(report.plan.length, 2);
  assert.deepEqual(report.plan.map((p) => p.termId).sort(), ['term-1', 'term-3']);
  assert.deepEqual(client.calls, [], 'zero writes reachable from dry-run');
});

test('runBackfillTermStates: migration 0016 unapplied (terms.state column missing) — every term row is honestly gated, zero writes attempted, legislator/federal loaders never consulted', async () => {
  const client = makeFakeTermWriteClient();
  const loadTermIndexFn = async () => ({
    gated: true,
    rows: [
      {
        id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', district: '2', state: null,
      },
      {
        id: 'term-2', legislator_id: 'leg-2', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '5', state: null,
      },
    ],
  });
  const loadLegislatorBioguideIndexFn = async () => { throw new Error('must not be called once gated'); };
  const loadFederalMemberStateIndexFn = async () => { throw new Error('must not be called once gated'); };

  const report = await runBackfillTermStates(client, {
    dryRun: false, runId: 'run-1', loadTermIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberStateIndexFn,
  });

  assert.equal(report.counts.termsSeen, 2);
  assert.equal(report.counts.gatedMissingColumn, 2);
  assert.equal(report.counts.filled, 0);
  assert.deepEqual(client.calls, []);
});

test('runBackfillTermStates: an update-time missing-column error (race with the pre-flight load) is honestly counted gatedMissingColumn, never thrown', async () => {
  const client = {
    calls: [],
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => ({
          is: async (col2, val2) => {
            client.calls.push({
              table, patch, col, val, col2, val2,
            });
            return { error: { code: '42703', message: 'column "state" of relation "terms" does not exist' } };
          },
        }),
      }),
    }),
  };
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '1', state: null,
    }],
  });
  const loadLegislatorBioguideIndexFn = async () => new Map();
  const loadFederalMemberStateIndexFn = async () => ({ index: new Map(), failures: [] });

  const report = await runBackfillTermStates(client, {
    dryRun: false, runId: 'run-1', loadTermIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberStateIndexFn,
  });

  assert.equal(report.counts.gatedMissingColumn, 1);
  assert.equal(report.counts.filled, 0);
});

test('runBackfillTermStates: an unrelated update error is thrown, never silently swallowed', async () => {
  const client = {
    from: () => ({
      update: () => ({
        eq: () => ({
          is: async () => ({ error: { code: '500', message: 'connection reset' } }),
        }),
      }),
    }),
  };
  const loadTermIndexFn = async () => ({
    gated: false,
    rows: [{
      id: 't1', legislator_id: 'l1', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '1', state: null,
    }],
  });
  const loadLegislatorBioguideIndexFn = async () => new Map();
  const loadFederalMemberStateIndexFn = async () => ({ index: new Map(), failures: [] });

  await assert.rejects(() => runBackfillTermStates(client, {
    dryRun: false, runId: 'run-1', loadTermIndexFn, loadLegislatorBioguideIndexFn, loadFederalMemberStateIndexFn,
  }), /connection reset/);
});
