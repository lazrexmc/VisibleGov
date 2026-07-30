import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  loadVotedBillIds,
  loadFederalBillIndex,
  loadLegislatorIndexByBioguide,
  loadTextIndex,
  planBillWork,
  fetchAndStoreBillText,
  processBillLive,
  ensureFederalMemberMetadata,
  runEnrichFederalBills,
  dryRunFederalBillPlan,
} from '../src/cli/enrich-federal-bills.js';
import { SourceFetchError } from '../src/lib/errors.js';
import { MAX_TEXT_CHARS, OversizeTextError } from '../src/lib/summarizer.js';

// Task 3 of the profile-completeness plan
// (.superpowers/sdd/2026-07-29-profile-completeness/task-3-brief.md): ZERO live congress.gov
// requests, ZERO live DB writes anywhere in this test file (fake clients + injected fetch/loader
// functions throughout — mirrors backfill-mo-bill-meta-cli.test.js's own convention exactly).

// ---- parseArgs ----

test('parseArgs defaults dryRun to false and limit to null', () => {
  const out = parseArgs([]);
  assert.equal(out.dryRun, false);
  assert.equal(out.limit, null);
});

test('parseArgs accepts --dry-run and --limit at any position', () => {
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  assert.equal(parseArgs(['--limit', '5']).limit, 5);
  const both = parseArgs(['--limit', '10', '--dry-run']);
  assert.equal(both.dryRun, true);
  assert.equal(both.limit, 10);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

// ---- minimal selectAll-shaped fake client (mirrors backfill-mo-bill-meta-cli.test.js) ----

function relationMissingError(table) {
  return { code: '42P01', message: `relation "${table}" does not exist` };
}

function makeSelectAllFakeClient(seed = {}, { forceMissingRelations = [] } = {}) {
  const tables = {
    votes: [], sessions: [], bills: [], legislators: [], bill_texts: [], bill_sponsors: [], ...seed,
  };
  const missing = new Set(forceMissingRelations);
  return {
    tables,
    from(table) {
      return {
        select: () => {
          const state = { filters: [] };
          const builder = {
            eq: (col, val) => { state.filters.push((r) => r[col] === val); return builder; },
            not: (col, op, val) => { state.filters.push((r) => (val === null ? r[col] != null : true)); return builder; },
            in: (col, vals) => { const set = new Set(vals); state.filters.push((r) => set.has(r[col])); return builder; },
            order: () => ({
              range: async (from, to) => {
                if (missing.has(table)) return { data: null, error: relationMissingError(table) };
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

// ---- loadVotedBillIds ----

test('loadVotedBillIds: distinct bill_id Set, filtered to us-congress votes with a non-null bill_id', async () => {
  const client = makeSelectAllFakeClient({
    votes: [
      { jurisdiction_id: 'us-congress', bill_id: 'b1' },
      { jurisdiction_id: 'us-congress', bill_id: 'b1' }, // duplicate — same bill, two votes
      { jurisdiction_id: 'us-congress', bill_id: 'b2' },
      { jurisdiction_id: 'us-congress', bill_id: null }, // procedural, no bill — excluded
      { jurisdiction_id: 'mo-legislature', bill_id: 'b3' }, // different jurisdiction — excluded
    ],
  });
  const ids = await loadVotedBillIds(client);
  assert.deepEqual([...ids].sort(), ['b1', 'b2']);
});

test('loadVotedBillIds: an unrelated DB error is thrown, never silently swallowed', async () => {
  const client = {
    from: () => ({
      select: () => {
        const builder = {
          eq: () => builder,
          not: () => builder,
          order: () => ({ range: async () => ({ data: null, error: { code: '500', message: 'connection reset' } }) }),
        };
        return builder;
      },
    }),
  };
  await assert.rejects(() => loadVotedBillIds(client), /connection reset/);
});

// ---- loadFederalBillIndex ----

test('loadFederalBillIndex: joins sessions+bills, keyed by bill id, carrying congress from the session identifier', async () => {
  const client = makeSelectAllFakeClient({
    sessions: [
      { id: 'sess-119', jurisdiction_id: 'us-congress', identifier: '119' },
      { id: 'sess-mo', jurisdiction_id: 'mo-legislature', identifier: '2022' },
    ],
    bills: [
      { id: 'bill-1', session_id: 'sess-119', identifier: 'HR 498', status: null },
      { id: 'bill-2', session_id: 'sess-119', identifier: 'HR 845', status: 'Signed' },
      { id: 'bill-mo', session_id: 'sess-mo', identifier: 'HB 1', status: null }, // excluded — not a us-congress session
    ],
  });
  const index = await loadFederalBillIndex(client);
  assert.equal(index.size, 2);
  assert.deepEqual(index.get('bill-1'), {
    id: 'bill-1', identifier: 'HR 498', status: null, congress: '119',
  });
  assert.equal(index.get('bill-2').status, 'Signed');
  assert.equal(index.has('bill-mo'), false);
});

test('loadFederalBillIndex: zero us-congress sessions -> empty Map, never a crashing empty .in() query', async () => {
  const client = makeSelectAllFakeClient({ sessions: [] });
  const index = await loadFederalBillIndex(client);
  assert.equal(index.size, 0);
});

// ---- loadLegislatorIndexByBioguide ----

test('loadLegislatorIndexByBioguide: Map keyed by bioguide_id, skipping rows where it is null (MO-only legislators)', async () => {
  const client = makeSelectAllFakeClient({
    legislators: [
      { id: 'leg-1', bioguide_id: 'O000177', party: null },
      { id: 'leg-2', bioguide_id: null, party: 'Democratic' }, // MO-only, no bioguide
    ],
  });
  const index = await loadLegislatorIndexByBioguide(client);
  assert.equal(index.size, 1);
  assert.deepEqual(index.get('O000177'), { id: 'leg-1', party: null });
});

// ---- loadTextIndex ----

test('loadTextIndex: Set of bill_ids with at least one bill_texts row', async () => {
  const client = makeSelectAllFakeClient({
    bill_texts: [{ bill_id: 'b1' }, { bill_id: 'b1' }, { bill_id: 'b2' }],
  });
  const index = await loadTextIndex(client);
  assert.deepEqual([...index].sort(), ['b1', 'b2']);
});

// ---- planBillWork (pure) ----

test('planBillWork: a bill missing everything needs sponsors+status+text, needsDetail true', () => {
  const billIndex = new Map([['b1', { id: 'b1', identifier: 'HR 1', status: null, congress: '119' }]]);
  const { needsWork, skippedComplete, billRowNotFound } = planBillWork(new Set(['b1']), billIndex, new Set(), new Set());
  assert.equal(needsWork.length, 1);
  assert.deepEqual(needsWork[0], {
    billId: 'b1', bill: billIndex.get('b1'), needsSponsors: true, needsStatus: true, needsText: true, needsDetail: true,
  });
  assert.equal(skippedComplete, 0);
  assert.equal(billRowNotFound, 0);
});

test('planBillWork: a bill with status set and a sponsor already recorded still needs text alone; needsDetail is false', () => {
  const billIndex = new Map([['b1', { id: 'b1', identifier: 'HR 1', status: 'Passed', congress: '119' }]]);
  const { needsWork } = planBillWork(new Set(['b1']), billIndex, new Set(['b1']), new Set());
  assert.equal(needsWork.length, 1);
  assert.equal(needsWork[0].needsSponsors, false);
  assert.equal(needsWork[0].needsStatus, false);
  assert.equal(needsWork[0].needsText, true);
  assert.equal(needsWork[0].needsDetail, false, 'detail fetch is not worth making for text-only work');
});

test('planBillWork: a fully-enriched bill costs zero work — the DB-keyed resumability this file relies on', () => {
  const billIndex = new Map([['b1', { id: 'b1', identifier: 'HR 1', status: 'Passed', congress: '119' }]]);
  const { needsWork, skippedComplete } = planBillWork(new Set(['b1']), billIndex, new Set(['b1']), new Set(['b1']));
  assert.equal(needsWork.length, 0);
  assert.equal(skippedComplete, 1);
});

test('planBillWork: a voted-on bill_id with no matching bills row is honestly counted, never crashes', () => {
  const { needsWork, billRowNotFound } = planBillWork(new Set(['ghost']), new Map(), new Set(), new Set());
  assert.equal(needsWork.length, 0);
  assert.equal(billRowNotFound, 1);
});

// ---- fetchAndStoreBillText ----

function textVersionsFixture(url) {
  return {
    textVersions: [{ type: 'Introduced in House', date: '2025-01-01', formats: [{ type: 'Formatted Text', url }] }],
  };
}

function makeBillTextWriteClient() {
  const calls = [];
  return {
    calls,
    from: (table) => ({
      upsert: (rows, opts) => {
        calls.push({ table, rows, opts });
        return Promise.resolve({ error: null });
      },
    }),
  };
}

test('fetchAndStoreBillText: happy path fetches versions+body, strips html, hashes, and inserts a bill_texts row', async () => {
  const client = makeBillTextWriteClient();
  const bill = { id: 'bill-1', identifier: 'HR 1', congress: '119' };
  const row = await fetchAndStoreBillText(client, 'run-1', bill, {
    fetchBillTextVersionsFn: async () => textVersionsFixture('https://www.congress.gov/119/bills/hr1/text.htm'),
    fetchTextBodyFn: async () => '<p>Section 1. Hello world.</p>',
  });
  assert.equal(row.bill_id, 'bill-1');
  assert.equal(row.version, 'Introduced in House');
  assert.match(row.content, /Section 1\. Hello world\./);
  assert.match(row.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.source_url, 'https://www.congress.gov/119/bills/hr1/text.htm');
  assert.equal(row.run_id, 'run-1');
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].table, 'bill_texts');
  assert.deepEqual(client.calls[0].opts, { onConflict: 'bill_id,version', ignoreDuplicates: true });
});

test('fetchAndStoreBillText: oversize content throws OversizeTextError and never reaches the DB — the honored oversize gate', async () => {
  const client = makeBillTextWriteClient();
  const bill = { id: 'bill-1', identifier: 'HR 1', congress: '119' };
  await assert.rejects(
    () => fetchAndStoreBillText(client, 'run-1', bill, {
      fetchBillTextVersionsFn: async () => textVersionsFixture('https://www.congress.gov/119/bills/hr1/text.htm'),
      fetchTextBodyFn: async () => 'x'.repeat(MAX_TEXT_CHARS + 1),
    }),
    (err) => err instanceof OversizeTextError,
  );
  assert.deepEqual(client.calls, [], 'oversize text is never written, never truncated silently');
});

test('fetchAndStoreBillText: no fetchable text format is wrapped as a typed SourceFetchError (source us-congress)', async () => {
  const client = makeBillTextWriteClient();
  const bill = { id: 'bill-1', identifier: 'HR 1', congress: '119' };
  await assert.rejects(
    () => fetchAndStoreBillText(client, 'run-1', bill, {
      fetchBillTextVersionsFn: async () => ({ textVersions: [{ type: 'X', date: null, formats: [] }] }),
      fetchTextBodyFn: async () => { throw new Error('should never be called'); },
    }),
    (err) => err instanceof SourceFetchError && err.source === 'us-congress' && /no fetchable text format/.test(err.message),
  );
  assert.deepEqual(client.calls, []);
});

// ---- processBillLive ----

function makeProcessWriteClient({ rejectSponsorMissingRelation = false } = {}) {
  const calls = [];
  return {
    calls,
    from: (table) => ({
      update: (patch) => ({
        eq: async (col, val) => {
          calls.push({
            op: 'update', table, patch, col, val,
          });
          return { error: null };
        },
      }),
      upsert: (row, opts) => {
        calls.push({
          op: 'upsert', table, row, opts,
        });
        if (table === 'bill_sponsors' && rejectSponsorMissingRelation) {
          return Promise.resolve({ error: { code: '42P01', message: 'relation "bill_sponsors" does not exist' } });
        }
        return Promise.resolve({ error: null });
      },
    }),
  };
}

function makeWork(overrides = {}) {
  return {
    billId: 'bill-1',
    bill: {
      id: 'bill-1', identifier: 'HR 1', status: null, congress: '119',
    },
    needsSponsors: true,
    needsStatus: true,
    needsText: true,
    needsDetail: true,
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    legislatorIndex: new Map([['C001120', { id: 'leg-1', party: 'R' }]]),
    sponsorIndex: new Map(),
    sponsorGatedRef: { gated: false },
    counts: {
      billDetailFetched: 0, billDetailFailed: 0, statusPatched: 0, statusAlreadySet: 0, statusMissingInSource: 0,
      sponsorsSeen: 0, sponsorInserted: 0, sponsorAlreadyExists: 0, sponsorLegislatorNotFound: 0, sponsorGated: 0,
      textFetched: 0, textOversizeRefused: 0, textFormatMissing: 0, textFetchFailed: 0,
    },
    failures: [],
    ...overrides,
  };
}

test('processBillLive: happy path — status patched, sponsor inserted, text fetched', async () => {
  const client = makeProcessWriteClient();
  const deps = baseDeps({
    fetchTextFn: async () => ({}),
  });
  // Inject a fake detail via fetchBillDetailFn + rely on the REAL us.parseBillDetail by shaping
  // json exactly as parseBillDetail expects.
  const detailJson = {
    bill: {
      type: 'HR', number: '1', congress: 119, title: 'A Bill', latestAction: { text: 'Passed the House' }, sponsors: [{ bioguideId: 'C001120' }],
    },
  };
  await processBillLive(client, 'run-1', makeWork(), {
    ...deps, fetchBillDetailFn: async () => detailJson,
  });
  assert.equal(deps.counts.billDetailFetched, 1);
  assert.equal(deps.counts.statusPatched, 1);
  assert.equal(deps.counts.sponsorInserted, 1);
  assert.equal(deps.counts.textFetched, 1);
  const statusUpdate = client.calls.find((c) => c.op === 'update' && c.table === 'bills');
  assert.equal(statusUpdate.patch.status, 'Passed the House');
  assert.equal(statusUpdate.patch.run_id, 'run-1');
  const sponsorUpsert = client.calls.find((c) => c.op === 'upsert' && c.table === 'bill_sponsors');
  assert.equal(sponsorUpsert.row.legislator_id, 'leg-1');
  assert.equal(sponsorUpsert.row.sponsor_type, 'primary');
});

test('processBillLive: bill detail fetch failure is counted and skips BOTH status and sponsor writes, but text is independent', async () => {
  const client = makeProcessWriteClient();
  const deps = baseDeps({
    fetchTextFn: async () => ({}),
  });
  await processBillLive(client, 'run-1', makeWork(), {
    ...deps,
    fetchBillDetailFn: async () => { throw new SourceFetchError('HTTP 500', { source: 'us-congress' }); },
  });
  assert.equal(deps.counts.billDetailFailed, 1);
  assert.equal(deps.counts.statusPatched, 0);
  assert.equal(deps.counts.sponsorInserted, 0);
  assert.equal(deps.failures.length, 1);
  assert.match(deps.failures[0].step, /bill detail HR 1/);
  assert.equal(deps.counts.textFetched, 1, 'text-fetch is independent of bill-detail outcome');
});

test('processBillLive: source status null -> statusMissingInSource, never a write', async () => {
  const client = makeProcessWriteClient();
  const deps = baseDeps({
    fetchTextFn: async () => ({}),
  });
  const detailJson = {
    bill: {
      type: 'HR', number: '1', congress: 119, title: 'A Bill', latestAction: null, sponsors: [],
    },
  };
  await processBillLive(client, 'run-1', makeWork({ needsSponsors: false }), {
    ...deps, fetchBillDetailFn: async () => detailJson,
  });
  assert.equal(deps.counts.statusMissingInSource, 1);
  assert.equal(deps.counts.statusPatched, 0);
  assert.equal(client.calls.filter((c) => c.table === 'bills').length, 0);
});

test('processBillLive: an unmatched sponsor bioguide_id is an honest count, never guessed/created', async () => {
  const client = makeProcessWriteClient();
  const deps = baseDeps({
    legislatorIndex: new Map(), // empty — nothing resolves
    fetchTextFn: async () => ({}),
  });
  const detailJson = {
    bill: {
      type: 'HR', number: '1', congress: 119, title: 'A Bill', latestAction: { text: 'x' }, sponsors: [{ bioguideId: 'Z999999' }],
    },
  };
  await processBillLive(client, 'run-1', makeWork({ needsStatus: false }), {
    ...deps, fetchBillDetailFn: async () => detailJson,
  });
  assert.equal(deps.counts.sponsorLegislatorNotFound, 1);
  assert.equal(deps.counts.sponsorInserted, 0);
  assert.deepEqual(client.calls.filter((c) => c.table === 'bill_sponsors'), []);
});

test('processBillLive: a sponsor already recorded (sponsorIndex hit) is sponsorAlreadyExists, never a duplicate upsert', async () => {
  const client = makeProcessWriteClient();
  const deps = baseDeps({
    sponsorIndex: new Map([['bill-1|leg-1', { id: 'bs-1' }]]),
    fetchTextFn: async () => ({}),
  });
  const detailJson = {
    bill: {
      type: 'HR', number: '1', congress: 119, title: 'A Bill', latestAction: { text: 'x' }, sponsors: [{ bioguideId: 'C001120' }],
    },
  };
  await processBillLive(client, 'run-1', makeWork({ needsStatus: false }), {
    ...deps, fetchBillDetailFn: async () => detailJson,
  });
  assert.equal(deps.counts.sponsorAlreadyExists, 1);
  assert.deepEqual(client.calls.filter((c) => c.table === 'bill_sponsors'), []);
});

test('processBillLive: migration 0014 unapplied — sponsor upsert 42P01s, sets sponsorGatedRef, and a SECOND sponsor in the same bill short-circuits without a further live attempt', async () => {
  const client = makeProcessWriteClient({ rejectSponsorMissingRelation: true });
  const deps = baseDeps({
    legislatorIndex: new Map([['C1', { id: 'leg-1' }], ['C2', { id: 'leg-2' }]]),
    fetchTextFn: async () => ({}),
  });
  const detailJson = {
    bill: {
      type: 'HR',
      number: '1',
      congress: 119,
      title: 'A Bill',
      latestAction: { text: 'x' },
      sponsors: [{ bioguideId: 'C1' }, { bioguideId: 'C2' }],
    },
  };
  await processBillLive(client, 'run-1', makeWork({ needsStatus: false }), {
    ...deps, fetchBillDetailFn: async () => detailJson,
  });
  assert.equal(deps.sponsorGatedRef.gated, true);
  assert.equal(deps.counts.sponsorGated, 2, 'both sponsors gated — the second never even attempts a live upsert');
  const sponsorUpserts = client.calls.filter((c) => c.table === 'bill_sponsors');
  assert.equal(sponsorUpserts.length, 1, 'exactly one live attempt: the first, which discovers the gate');
});

test('processBillLive: text oversize is counted textOversizeRefused with a failure entry, never thrown out of the function', async () => {
  const client = makeProcessWriteClient();
  const deps = baseDeps({ needsDetail: false });
  await processBillLive(client, 'run-1', makeWork({ needsSponsors: false, needsStatus: false, needsDetail: false }), {
    ...deps,
    fetchTextFn: async () => { throw new OversizeTextError('too big', { identifier: 'HR 1', length: 999999 }); },
  });
  assert.equal(deps.counts.textOversizeRefused, 1);
  assert.equal(deps.failures.length, 1);
  assert.match(deps.failures[0].step, /text HR 1/);
});

test('processBillLive: text "no fetchable format" is classified textFormatMissing, distinct from a generic fetch failure', async () => {
  const client = makeProcessWriteClient();
  const deps = baseDeps();
  await processBillLive(client, 'run-1', makeWork({ needsSponsors: false, needsStatus: false, needsDetail: false }), {
    ...deps,
    fetchTextFn: async () => { throw new SourceFetchError('no fetchable text format in text versions', { source: 'us-congress' }); },
  });
  assert.equal(deps.counts.textFormatMissing, 1);
  assert.equal(deps.counts.textFetchFailed, 0);
});

test('processBillLive: a generic text SourceFetchError is textFetchFailed', async () => {
  const client = makeProcessWriteClient();
  const deps = baseDeps();
  await processBillLive(client, 'run-1', makeWork({ needsSponsors: false, needsStatus: false, needsDetail: false }), {
    ...deps,
    fetchTextFn: async () => { throw new SourceFetchError('HTTP 500 from us-congress', { source: 'us-congress' }); },
  });
  assert.equal(deps.counts.textFetchFailed, 1);
  assert.equal(deps.counts.textFormatMissing, 0);
});

test('processBillLive: needsDetail false and needsText false is a safe no-op (defensive — planBillWork never actually emits this)', async () => {
  const client = makeProcessWriteClient();
  const deps = baseDeps();
  await processBillLive(client, 'run-1', makeWork({
    needsSponsors: false, needsStatus: false, needsText: false, needsDetail: false,
  }), deps);
  assert.deepEqual(client.calls, []);
  assert.deepEqual(deps.failures, []);
});

// ---- ensureFederalMemberMetadata ----

function makeMemberWriteClient() {
  const calls = [];
  // Stateful for the 'legislators' table only: ensureFederalMemberMetadata's own newly-inserted-
  // member path RELOADS the legislator index after insertIfAbsent (Task 2 bulk-reload pattern) —
  // a dumb always-empty loader stub can't reflect that, so this fake tracks real inserted rows.
  const legislators = new Map();
  return {
    calls,
    legislators,
    from: (table) => ({
      update: (patch) => ({
        eq: async (col, val) => {
          calls.push({
            op: 'update', table, patch, col, val,
          });
          if (table === 'legislators' && col === 'id') {
            for (const row of legislators.values()) if (row.id === val) Object.assign(row, patch);
          }
          return { error: null };
        },
      }),
      upsert: (rows, opts) => {
        calls.push({
          op: 'upsert', table, rows, opts,
        });
        if (table === 'legislators') {
          for (const row of rows) {
            if (!legislators.has(row.bioguide_id)) {
              legislators.set(row.bioguide_id, {
                id: `leg-${legislators.size + 1}`, bioguide_id: row.bioguide_id, party: row.party ?? null,
              });
            }
          }
        }
        return Promise.resolve({ error: null });
      },
    }),
  };
}

// Reads the SAME legislators Map the fake client's own upsert/update handlers mutate — so a test
// that lets ensureFederalMemberMetadata insert a new member and then RELOAD (newMembers.length > 0
// branch) sees the just-created row, exactly like a real selectAll re-read would.
function loadLegislatorIndexFromClient(client) {
  return async () => {
    const index = new Map();
    for (const [bioguideId, row] of client.legislators) index.set(bioguideId, { id: row.id, party: row.party });
    return index;
  };
}

function rawMember({
  bioguideId, name, party, state, district, chamber = 'House of Representatives', endYear,
}) {
  return {
    bioguideId,
    name,
    partyName: party,
    state,
    district,
    terms: { item: [{ chamber, startYear: 2025, endYear }] },
  };
}

test('ensureFederalMemberMetadata: pages until a short page, filters historical members, creates a missing legislator, patches null party, and creates a House term keyed by numeric district', async () => {
  const client = makeMemberWriteClient();
  const page0 = {
    members: [
      rawMember({
        bioguideId: 'NEW001', name: 'New, Person', party: 'Republican', state: 'Missouri', district: 3,
      }),
      rawMember({
        bioguideId: 'OLD001', name: 'Old, Person', party: 'Democratic', state: 'Ohio', district: 1, endYear: 2019,
      }), // historical — filtered
    ],
  };
  const fetchMemberPageFn = async (offset) => {
    if (offset === 0) return page0;
    return { members: [] };
  };
  const loadLegislatorIndexFn = loadLegislatorIndexFromClient(client); // nobody exists yet, but reflects inserts
  const upsertTermFn = async (c, r, { legislatorId, role }) => {
    client.calls.push({ op: 'upsertTerm', legislatorId, role });
    return { created: true };
  };

  const { counts, failures } = await ensureFederalMemberMetadata(client, 'run-1', {
    fetchMemberPageFn, loadLegislatorIndexFn, upsertTermFn,
  });

  assert.equal(counts.membersPaged, 2);
  assert.equal(counts.membersHistoricalFiltered, 1);
  assert.equal(counts.membersCurrent, 1);
  assert.equal(counts.legislatorCreated, 1);
  assert.equal(failures.length, 0);
  const legislatorInsert = client.calls.find((c) => c.op === 'upsert' && c.table === 'legislators');
  assert.equal(legislatorInsert.rows[0].bioguide_id, 'NEW001');
  assert.equal(legislatorInsert.rows[0].party, 'Republican');
  const termCall = client.calls.find((c) => c.op === 'upsertTerm');
  assert.equal(termCall.role.chamber, 'house');
  assert.equal(termCall.role.district, '3');
  assert.equal(counts.termCreated, 1);
});

test('ensureFederalMemberMetadata: a current Senate member gets district set to the state ABBREVIATION (terms.district-as-state convention), and party is left alone when already set', async () => {
  const client = makeMemberWriteClient();
  const page0 = {
    members: [rawMember({
      bioguideId: 'SEN001', name: 'Senator, Some', party: 'Republican', state: 'Missouri', chamber: 'Senate',
    })],
  };
  const fetchMemberPageFn = async () => page0;
  const loadLegislatorIndexFn = async () => new Map([['SEN001', { id: 'leg-sen', party: 'Republican' }]]); // already has party
  const upsertTermFn = async (c, r, { role }) => { client.calls.push({ op: 'upsertTerm', role }); return { created: false }; };

  const { counts } = await ensureFederalMemberMetadata(client, 'run-1', {
    fetchMemberPageFn, loadLegislatorIndexFn, upsertTermFn,
  });

  assert.equal(counts.legislatorCreated, 0, 'already existed — no legislators insert needed');
  assert.equal(counts.partyPatched, 0);
  assert.equal(counts.partyAlreadySet, 1);
  assert.deepEqual(client.calls.filter((c) => c.op === 'update' && c.table === 'legislators'), []);
  const termCall = client.calls.find((c) => c.op === 'upsertTerm');
  assert.equal(termCall.role.chamber, 'senate');
  assert.equal(termCall.role.district, 'MO');
  assert.equal(counts.termAlreadyExists, 1);
});

test('ensureFederalMemberMetadata: an existing legislator with a null party gets patched (fills-null), never overwritten when already set', async () => {
  const client = makeMemberWriteClient();
  const page0 = { members: [rawMember({ bioguideId: 'X001', name: 'Doe, John', party: 'Democratic', state: 'Ohio', district: 5 })] };
  const fetchMemberPageFn = async () => page0;
  const loadLegislatorIndexFn = async () => new Map([['X001', { id: 'leg-x', party: null }]]); // placeholder from vote-cast ingestion
  const upsertTermFn = async () => ({ created: true });

  const { counts } = await ensureFederalMemberMetadata(client, 'run-1', {
    fetchMemberPageFn, loadLegislatorIndexFn, upsertTermFn,
  });

  assert.equal(counts.partyPatched, 1);
  const partyUpdate = client.calls.find((c) => c.op === 'update' && c.table === 'legislators');
  assert.equal(partyUpdate.patch.party, 'Democratic');
  assert.equal(partyUpdate.col, 'id');
  assert.equal(partyUpdate.val, 'leg-x');
});

test('ensureFederalMemberMetadata: a member-page fetch failure is a typed, counted failure — pagination stops, not a crash', async () => {
  const client = makeMemberWriteClient();
  const fetchMemberPageFn = async () => { throw new SourceFetchError('HTTP 500', { source: 'us-congress' }); };
  const loadLegislatorIndexFn = async () => new Map();
  const upsertTermFn = async () => ({ created: true });

  const { counts, failures } = await ensureFederalMemberMetadata(client, 'run-1', {
    fetchMemberPageFn, loadLegislatorIndexFn, upsertTermFn,
  });
  assert.equal(counts.membersPaged, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].step, /member page offset=0/);
});

test('ensureFederalMemberMetadata: a member with zero term items is skipped (never reaches isCurrentMember/parseMemberList) and counted, not fatal', async () => {
  const client = makeMemberWriteClient();
  const page0 = { members: [{ bioguideId: 'NOTERM', name: 'No, Terms', terms: { item: [] } }] };
  const fetchMemberPageFn = async () => page0;
  const loadLegislatorIndexFn = async () => new Map();
  const upsertTermFn = async () => ({ created: true });

  const { counts } = await ensureFederalMemberMetadata(client, 'run-1', {
    fetchMemberPageFn, loadLegislatorIndexFn, upsertTermFn,
  });
  assert.equal(counts.membersWithoutTerms, 1);
  assert.equal(counts.membersCurrent, 0);
});

// ---- runEnrichFederalBills (top-level composition) ----

test('runEnrichFederalBills: composes member-metadata ensure + bill worklist, aggregates counts honestly, and respects --limit', async () => {
  const client = { from: () => ({}) }; // never touched directly — every DB call goes through injected fns
  const billIndex = new Map([
    ['b1', {
      id: 'b1', identifier: 'HR 1', status: 'Passed', congress: '119',
    }],
    ['b2', {
      id: 'b2', identifier: 'HR 2', status: 'Passed', congress: '119',
    }],
  ]);
  const deps = {
    ensureFederalMemberMetadataFn: async () => ({
      counts: { membersCurrent: 5 }, failures: [],
    }),
    loadVotedBillIdsFn: async () => new Set(['b1', 'b2']),
    loadFederalBillIndexFn: async () => billIndex,
    loadLegislatorIndexFn: async () => new Map(),
    // Both bills already have a recorded sponsor — status is also already set above — so
    // needsDetail is false for both and fetchBillDetailFn (deliberately NOT stubbed here) is
    // never reached; only the text step below is exercised.
    loadSponsorIndexFn: async () => ({ gated: false, index: new Map([['b1|leg-x', {}], ['b2|leg-x', {}]]) }),
    loadTextIndexFn: async () => new Set(), // neither bill has text yet
    fetchTextFn: async () => ({}),
  };

  const result = await runEnrichFederalBills(client, 'run-1', { limit: 1, deps });

  assert.equal(result.counts.billsInWorklist, 2);
  assert.equal(result.counts.billsNeedingWork, 2, 'both bills need text (status/sponsors already satisfied)');
  assert.equal(result.counts.billsProcessed, 1, '--limit 1 slices the needs-work list');
  assert.equal(result.counts.textFetched, 1);
  assert.equal(result.counts.memberMetadata.membersCurrent, 5);
  assert.deepEqual(result.failures, []);
});

test('runEnrichFederalBills: failures from member-metadata and bill processing are both surfaced in the combined failures list', async () => {
  const client = { from: () => ({}) };
  const deps = {
    ensureFederalMemberMetadataFn: async () => ({
      counts: {}, failures: [{ step: 'member page offset=0', message: 'boom' }],
    }),
    loadVotedBillIdsFn: async () => new Set(['b1']),
    loadFederalBillIndexFn: async () => new Map([['b1', {
      id: 'b1', identifier: 'HR 1', status: null, congress: '119',
    }]]),
    loadLegislatorIndexFn: async () => new Map(),
    loadSponsorIndexFn: async () => ({ gated: false, index: new Map() }),
    loadTextIndexFn: async () => new Set(['b1']), // text already present — only detail is needed
    fetchBillDetailFn: async () => { throw new SourceFetchError('HTTP 500', { source: 'us-congress' }); },
  };

  const result = await runEnrichFederalBills(client, 'run-1', { deps });
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.some((f) => f.message === 'boom'));
  assert.ok(result.failures.some((f) => /bill detail HR 1/.test(f.step)));
});

// ---- dryRunFederalBillPlan ----

test('dryRunFederalBillPlan: computed purely from injected DB-state loaders — no fetchMemberPageFn/fetchBillDetailFn dependency exists on this function at all', async () => {
  const client = { from: () => ({}) };
  const billIndex = new Map([
    ['b1', {
      id: 'b1', identifier: 'HR 1', status: null, congress: '119',
    }],
    ['b2', {
      id: 'b2', identifier: 'HR 2', status: 'Passed', congress: '119',
    }],
  ]);
  const deps = {
    loadVotedBillIdsFn: async () => new Set(['b1', 'b2']),
    loadFederalBillIndexFn: async () => billIndex,
    loadSponsorIndexFn: async () => ({ gated: false, index: new Map([['b2|leg-1', { id: 'bs-1' }]]) }),
    loadTextIndexFn: async () => new Set(),
  };

  const report = await dryRunFederalBillPlan(client, { deps });
  assert.equal(report.counts.billsInWorklist, 2);
  assert.equal(report.counts.needingSponsors, 1, 'only b1 lacks a recorded sponsor');
  assert.equal(report.counts.needingStatus, 1, 'only b1 lacks status');
  assert.equal(report.counts.needingText, 2, 'neither bill has text yet');
  assert.equal(report.counts.sponsorTableGated, false);
  assert.ok(report.notes.some((n) => /LIVE-ONLY/.test(n)));
  assert.ok(report.notes.some((n) => /zero congress\.gov requests/.test(n)));
});

test('dryRunFederalBillPlan: --limit caps the sample but not the honest totals', async () => {
  const client = { from: () => ({}) };
  const billIndex = new Map([
    ['b1', {
      id: 'b1', identifier: 'HR 1', status: null, congress: '119',
    }],
    ['b2', {
      id: 'b2', identifier: 'HR 2', status: null, congress: '119',
    }],
  ]);
  const deps = {
    loadVotedBillIdsFn: async () => new Set(['b1', 'b2']),
    loadFederalBillIndexFn: async () => billIndex,
    loadSponsorIndexFn: async () => ({ gated: false, index: new Map() }),
    loadTextIndexFn: async () => new Set(['b1', 'b2']),
  };
  const report = await dryRunFederalBillPlan(client, { limit: 1, deps });
  assert.equal(report.counts.billsNeedingWork, 2);
  assert.equal(report.counts.billsWouldProcess, 1);
  assert.equal(report.sample.length, 1);
});

test('dryRunFederalBillPlan: migration 0014 unapplied surfaces sponsorTableGated honestly', async () => {
  const client = { from: () => ({}) };
  const deps = {
    loadVotedBillIdsFn: async () => new Set(['b1']),
    loadFederalBillIndexFn: async () => new Map([['b1', {
      id: 'b1', identifier: 'HR 1', status: 'Passed', congress: '119',
    }]]),
    loadSponsorIndexFn: async () => ({ gated: true, index: null }),
    loadTextIndexFn: async () => new Set(['b1']),
  };
  const report = await dryRunFederalBillPlan(client, { deps });
  assert.equal(report.counts.sponsorTableGated, true);
  assert.equal(report.counts.needingSponsors, 1, 'every bill needs sponsors while gated — never silently hidden');
});
