import {
  mkdtempSync, rmSync, writeFileSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  readCachedDatasetBills,
  mapSponsorType,
  extractBillSponsorCandidates,
  loadSessionIndex,
  loadLegislatorIndex,
  loadBillIndex,
  loadSponsorIndex,
  runBackfillMoBillMeta,
} from '../src/cli/backfill-mo-bill-meta.js';
import { listCachedDatasetFiles } from '../src/cli/backfill-nicknames.js';
import { normalizeBillIdentifier } from '../src/adapters/legiscan-dataset.js';

// Task 2 of the profile-completeness plan
// (.superpowers/sdd/2026-07-29-profile-completeness/task-2-brief.md): MO sponsors + bill-status
// backfill from the SAME 31 already-cached LegiScan dataset ZIPs backfill-nicknames.js reads — ZERO
// LegiScan API queries, ZERO live DB writes anywhere in this test file (fake client throughout; the
// real-filesystem tests below read the repo's own already-committed-locally cache directory and the
// two committed research fixtures, never the network).
//
// A live pre-flight probe (see the module's own SCALE header comment) found 37,756 real bill
// payloads and 45,792 real sponsor entries across the 31 cached ZIPs, against a live `bills` table
// of 38,250+ rows — this file's orchestration tests inject pre-built index Maps directly (mirroring
// how ingest-legiscan-cli.test.js injects getDatasetListFn/getDatasetFn) rather than driving a full
// selectAll-shaped fake client through the orchestrator; the four loadXIndex bulk-loader functions
// get their OWN dedicated tests against a minimal selectAll-shaped fake client instead.

const REAL_CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';
const FIXDIR = 'tests/fixtures/research/legiscan';

async function withScratchDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'visiblegov-mo-bill-meta-backfill-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- parseArgs ----

test('parseArgs defaults dryRun to false and accepts --dry-run', () => {
  assert.equal(parseArgs([]).dryRun, false);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

// ---- readCachedDatasetBills ----

test('readCachedDatasetBills: real fixture — the actual cached session-1608 archive (2018 2nd Special Session) decodes to exactly the 9 real bills, verified independently against the source ZIP', async () => {
  const files = listCachedDatasetFiles(REAL_CACHE_DIR).filter((f) => f.includes('1608-'));
  assert.equal(files.length, 1, 'session 1608 is one of the 31 cached datasets');
  const decoded = await readCachedDatasetBills(files[0]);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.sessionId, 1608);
  assert.equal(decoded.bills.length, 9);
  assert.deepEqual(
    decoded.bills.map((b) => b.bill_number).sort(),
    ['HB1', 'HB2', 'HB3', 'HR1', 'SB1', 'SCR1', 'SR10', 'SR15', 'SR16'],
  );
  const sb1 = decoded.bills.find((b) => b.bill_number === 'SB1');
  assert.equal(sb1.sponsors.length, 4, 'real SB1 fixture: 1 primary + 3 cosponsors');
});

test('readCachedDatasetBills: real fixture — session 1579 (2018 1st Special Session) decodes to exactly 18 real bills, all carrying a numeric status (never null in the real source)', async () => {
  const files = listCachedDatasetFiles(REAL_CACHE_DIR).filter((f) => f.includes('1579-'));
  assert.equal(files.length, 1);
  const decoded = await readCachedDatasetBills(files[0]);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.sessionId, 1579);
  assert.equal(decoded.bills.length, 18);
  assert.ok(decoded.bills.every((b) => b.status !== null && b.status !== undefined));
});

test('readCachedDatasetBills: a nonexistent file path is honestly reported ok:false, never throws', async () => {
  const decoded = await readCachedDatasetBills('.superpowers/artifacts/legiscan-datasets/does-not-exist.json');
  assert.deepEqual(decoded, { ok: false, filePath: '.superpowers/artifacts/legiscan-datasets/does-not-exist.json' });
});

test('readCachedDatasetBills: malformed JSON on disk is honestly reported ok:false, never throws', async () => {
  await withScratchDirAsync(async (dir) => {
    const filePath = join(dir, 'bad.json');
    writeFileSync(filePath, '{not valid json');
    const decoded = await readCachedDatasetBills(filePath);
    assert.deepEqual(decoded, { ok: false, filePath });
  });
});

test('readCachedDatasetBills: valid JSON but an undecodable/garbage zip field is honestly reported ok:false, never throws', async () => {
  await withScratchDirAsync(async (dir) => {
    const filePath = join(dir, 'garbage-zip.json');
    writeFileSync(filePath, JSON.stringify({ session_id: 999, zip: Buffer.from('not a real zip').toString('base64') }));
    const decoded = await readCachedDatasetBills(filePath);
    assert.deepEqual(decoded, { ok: false, filePath });
  });
});

test('readCachedDatasetBills: an injected readFileFn that throws is honestly reported ok:false', async () => {
  const decoded = await readCachedDatasetBills('anything.json', {
    readFileFn: () => { throw new Error('disk error'); },
  });
  assert.deepEqual(decoded, { ok: false, filePath: 'anything.json' });
});

// ---- mapSponsorType (pure — Task 2 fix round 1: all four values verified against LegiScan's own
// API manual, tests/fixtures/research/legiscan/LegiScan_API_User_Manual.pdf page 42, "Static
// Values > Sponsor Types" table, independently re-extracted via pdfjs-dist — not the two committed
// dataset fixtures alone, which only ever show 1/2) ----

test('mapSponsorType: 1 -> primary, 2 -> cosponsor (the only two values observed in either real dataset fixture)', () => {
  assert.equal(mapSponsorType(1), 'primary');
  assert.equal(mapSponsorType(2), 'cosponsor');
});

test('mapSponsorType: 0 -> unspecified, 3 -> joint (LegiScan\'s own "Sponsor (Generic / Unspecified)" and "Joint Sponsor" — absent from the two small fixtures but real in the wider 31-file live cache, migration 0015\'s whole reason for existing)', () => {
  assert.equal(mapSponsorType(0), 'unspecified');
  assert.equal(mapSponsorType(3), 'joint');
});

test('mapSponsorType: a value genuinely outside LegiScan\'s documented {0,1,2,3} maps to null — never guessed, never forced into migration 0015\'s widened check constraint', () => {
  assert.equal(mapSponsorType(4), null);
  assert.equal(mapSponsorType(999), null);
  assert.equal(mapSponsorType(undefined), null);
  assert.equal(mapSponsorType(null), null);
});

// ---- extractBillSponsorCandidates (pure — real fixture data) ----

const hb1_1579 = JSON.parse(readFileSync(`${FIXDIR}/dataset-2018/MO/2018-2018_1st_Special_Session/bill/HB1.json`, 'utf8')).bill;
const sb1_1608 = JSON.parse(readFileSync(`${FIXDIR}/dataset-2018-1608/MO/2018-2018_2nd_Special_Session/bill/SB1.json`, 'utf8')).bill;

test('extractBillSponsorCandidates: real HB1 (1579) fixture — one primary sponsor, raw people_id/sponsor_type_id passed through unmapped', () => {
  const out = extractBillSponsorCandidates(hb1_1579);
  assert.deepEqual(out, [{ peopleId: 14179, sponsorTypeId: 1 }]);
});

test('extractBillSponsorCandidates: real SB1 (1608) fixture — 1 primary + 3 cosponsors, in source order, unfiltered', () => {
  const out = extractBillSponsorCandidates(sb1_1608);
  assert.deepEqual(out, [
    { peopleId: 14996, sponsorTypeId: 1 },
    { peopleId: 12974, sponsorTypeId: 2 },
    { peopleId: 14182, sponsorTypeId: 2 },
    { peopleId: 7622, sponsorTypeId: 2 },
  ]);
});

test('extractBillSponsorCandidates: a bill with no sponsors array (or an empty one) yields empty output, never throws', () => {
  assert.deepEqual(extractBillSponsorCandidates({ sponsors: [] }), []);
  assert.deepEqual(extractBillSponsorCandidates({}), []);
  assert.deepEqual(extractBillSponsorCandidates(undefined), []);
});

// ---- minimal selectAll-shaped fake client: select().order().range(), for the 4 loadXIndex tests ----

function relationMissingError(table) {
  return { code: '42P01', message: `relation "${table}" does not exist` };
}

function makeSelectAllFakeClient(seed = {}, { forceMissingRelations = [] } = {}) {
  const tables = {
    sessions: [], legislators: [], bills: [], bill_sponsors: [], ...seed,
  };
  const missing = new Set(forceMissingRelations);
  return {
    tables,
    from(table) {
      return {
        select: () => ({
          order: () => ({
            range: async (from, to) => {
              if (missing.has(table)) return { data: null, error: relationMissingError(table) };
              return { data: tables[table].slice(from, to + 1).map((r) => ({ ...r })), error: null };
            },
          }),
        }),
      };
    },
  };
}

// ---- loadSessionIndex ----

test('loadSessionIndex: builds a Map keyed by legiscan_session_id, skipping rows where it is null', async () => {
  const client = makeSelectAllFakeClient({
    sessions: [
      { id: 'sess-1608', legiscan_session_id: 1608 },
      { id: 'sess-1579', legiscan_session_id: 1579 },
      { id: 'sess-other', legiscan_session_id: null },
    ],
  });
  const index = await loadSessionIndex(client);
  assert.equal(index.size, 2);
  assert.deepEqual(index.get(1608), { id: 'sess-1608' });
  assert.deepEqual(index.get(1579), { id: 'sess-1579' });
  assert.equal(index.has(null), false);
});

test('loadSessionIndex: an unrelated DB error is thrown, never silently swallowed', async () => {
  const client = { from: () => ({ select: () => ({ order: () => ({ range: async () => ({ data: null, error: { code: '500', message: 'connection reset' } }) }) }) }) };
  await assert.rejects(() => loadSessionIndex(client), /connection reset/);
});

// ---- loadLegislatorIndex ----

test('loadLegislatorIndex: builds a Map keyed by legiscan_people_id, skipping rows where it is null', async () => {
  const client = makeSelectAllFakeClient({
    legislators: [
      { id: 'leg-1', legiscan_people_id: 14179 },
      { id: 'leg-2', legiscan_people_id: null }, // federal-only legislator, no LegiScan identity
    ],
  });
  const index = await loadLegislatorIndex(client);
  assert.equal(index.size, 1);
  assert.equal(index.get(14179), 'leg-1');
});

// ---- loadBillIndex ----

test('loadBillIndex: builds a Map keyed by "sessionRowId|identifier", carrying id and status', async () => {
  const client = makeSelectAllFakeClient({
    bills: [
      {
        id: 'bill-hb1', session_id: 'sess-1608', identifier: 'HB 1', status: null,
      },
      {
        id: 'bill-hb2', session_id: 'sess-1608', identifier: 'HB 2', status: '4',
      },
    ],
  });
  const index = await loadBillIndex(client);
  assert.equal(index.size, 2);
  assert.deepEqual(index.get('sess-1608|HB 1'), { id: 'bill-hb1', status: null });
  assert.deepEqual(index.get('sess-1608|HB 2'), { id: 'bill-hb2', status: '4' });
});

// ---- loadSponsorIndex ----

test('loadSponsorIndex: builds a Map keyed by "billRowId|legislatorId" when migration 0014 is applied', async () => {
  const client = makeSelectAllFakeClient({
    bill_sponsors: [{ id: 'bs-1', bill_id: 'bill-hb1', legislator_id: 'leg-1' }],
  });
  const result = await loadSponsorIndex(client);
  assert.equal(result.gated, false);
  assert.equal(result.index.size, 1);
  assert.deepEqual(result.index.get('bill-hb1|leg-1'), { id: 'bs-1' });
});

test('loadSponsorIndex: migration 0014 unapplied (bill_sponsors relation missing) -> gated:true, index:null, never thrown', async () => {
  const client = makeSelectAllFakeClient({}, { forceMissingRelations: ['bill_sponsors'] });
  const result = await loadSponsorIndex(client);
  assert.deepEqual(result, { gated: true, index: null });
});

test('loadSponsorIndex: an unrelated DB error is thrown, never silently swallowed', async () => {
  const client = { from: () => ({ select: () => ({ order: () => ({ range: async () => ({ data: null, error: { code: '500', message: 'connection reset' } }) }) }) }) };
  await assert.rejects(() => loadSponsorIndex(client), /connection reset/);
});

// ---- fake write-only client: .from(table).update(patch).eq(col,val) / .upsert(row, opts) ----
// ---- (reads are injected directly as pre-built index Maps in the orchestration tests below) ----

// rejectSponsorTypes — fix round 1: simulates migration 0015 NOT yet applied. Any bill_sponsors
// upsert whose sponsor_type is in this set fails with a real-shaped Postgres check_violation
// (23514), the same error a live run would actually hit against the OLD, narrower
// bill_sponsors_sponsor_type_check constraint — lets the pre-0015 tolerance path be tested without
// a real DB.
function makeFakeWriteClient({ rejectSponsorTypes = [] } = {}) {
  const tables = { bills: [], bill_sponsors: [] };
  const calls = [];
  const rejectSet = new Set(rejectSponsorTypes);
  return {
    calls,
    tables,
    from(table) {
      return {
        update: (patch) => ({
          eq: async (col, val) => {
            calls.push({
              op: 'update', table, patch, col, val,
            });
            return { error: null };
          },
        }),
        upsert: (row, opts = {}) => {
          calls.push({
            op: 'upsert', table, row, opts,
          });
          if (table === 'bill_sponsors' && rejectSet.has(row.sponsor_type)) {
            return Promise.resolve({
              error: {
                code: '23514',
                message: 'new row for relation "bill_sponsors" violates check constraint "bill_sponsors_sponsor_type_check"',
              },
            });
          }
          tables[table].push({ id: `bs-${tables[table].length + 1}`, ...row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

function fakeDataset({ sessionId, bills }) {
  return { ok: true, sessionId, bills };
}

function billFixture({
  billNumber, status, sponsors = [],
}) {
  return { bill_number: billNumber, status, sponsors };
}

// ---- runBackfillMoBillMeta: orchestration ----

test('runBackfillMoBillMeta: --dry-run performs the bulk index loads but zero writes — statusPatched/sponsorInserted stay 0, plan carries what WOULD be written', async () => {
  const files = ['a.json', 'missing.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async (filePath) => {
    if (filePath === 'a.json') {
      return fakeDataset({
        sessionId: 1608,
        bills: [
          billFixture({
            billNumber: 'HB1',
            status: 1,
            sponsors: [{ people_id: 100, sponsor_type_id: 1 }, { people_id: 200, sponsor_type_id: 2 }],
          }),
          billFixture({ billNumber: 'HB2', status: 4, sponsors: [] }), // no matching bills row
        ],
      });
    }
    return { ok: false, filePath }; // missing.json
  };
  const client = makeFakeWriteClient();
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  const loadLegislatorIndexFn = async () => new Map([[100, 'leg-100'], [200, 'leg-200']]);
  const loadBillIndexFn = async () => new Map([
    [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-hb1', status: null }],
  ]);
  const loadSponsorIndexFn = async () => ({ gated: false, index: new Map() });

  const report = await runBackfillMoBillMeta(client, {
    dryRun: true,
    listFilesFn,
    readDatasetFn,
    loadSessionIndexFn,
    loadLegislatorIndexFn,
    loadBillIndexFn,
    loadSponsorIndexFn,
  });

  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.counts, {
    billsSeen: 2,
    sessionNotFound: 0,
    billNotFound: 1,
    statusMissingInSource: 0,
    statusAlreadySet: 0,
    statusPatched: 0,
    sponsorsSeen: 2,
    sponsorTypeUnknown: 0,
    sponsorLegislatorNotFound: 0,
    sponsorAlreadyExists: 0,
    sponsorGated: 0,
    sponsorType0015Gated: 0,
    sponsorInserted: 0,
    cacheMissing: 1,
  });
  assert.equal(report.cacheFilesFound, 2);
  assert.deepEqual(report.sessionsSeen, [1608]);
  assert.equal(report.plan.statusPatches.length, 1);
  assert.deepEqual(report.plan.statusPatches[0].patch, { status: '1' });
  assert.equal(report.plan.sponsorInserts.length, 2);
  assert.deepEqual(client.calls, [], 'zero writes reachable from dry-run');
});

test('runBackfillMoBillMeta: live mode patches bills.status additively (fills null only) and inserts both sponsors', async () => {
  const files = ['a.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async () => fakeDataset({
    sessionId: 1608,
    bills: [billFixture({
      billNumber: 'HB1',
      status: 1,
      sponsors: [{ people_id: 100, sponsor_type_id: 1 }, { people_id: 200, sponsor_type_id: 2 }],
    })],
  });
  const client = makeFakeWriteClient();
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  const loadLegislatorIndexFn = async () => new Map([[100, 'leg-100'], [200, 'leg-200']]);
  const loadBillIndexFn = async () => new Map([
    [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-hb1', status: null }],
  ]);
  const loadSponsorIndexFn = async () => ({ gated: false, index: new Map() });

  const report = await runBackfillMoBillMeta(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn,
    readDatasetFn,
    loadSessionIndexFn,
    loadLegislatorIndexFn,
    loadBillIndexFn,
    loadSponsorIndexFn,
  });

  assert.equal(report.mode, 'live');
  assert.equal(report.counts.statusPatched, 1);
  assert.equal(report.counts.sponsorInserted, 2);
  assert.equal(report.plan, undefined, 'plan is a dry-run-only preview');
  const updateOps = client.calls.filter((c) => c.op === 'update');
  assert.equal(updateOps.length, 1);
  assert.equal(updateOps[0].patch.status, '1', 'LegiScan\'s own printed status code, stringified verbatim');
  assert.equal(updateOps[0].patch.run_id, 'run-1', 'run_id stamped on the status write, same convention as every other additivePatch call site');
  const upsertOps = client.calls.filter((c) => c.op === 'upsert');
  assert.equal(upsertOps.length, 2);
  assert.ok(upsertOps.some((c) => c.row.legislator_id === 'leg-100' && c.row.sponsor_type === 'primary'));
  assert.ok(upsertOps.some((c) => c.row.legislator_id === 'leg-200' && c.row.sponsor_type === 'cosponsor'));
  assert.ok(upsertOps.every((c) => c.row.run_id === 'run-1'), 'run_id stamped on every sponsor insert');
  assert.ok(upsertOps.every((c) => c.opts.onConflict === 'bill_id,legislator_id' && c.opts.ignoreDuplicates === true));
});

test('runBackfillMoBillMeta: bills.status is NEVER overwritten — a bill already carrying a MO primary-source status is left untouched, even though LegiScan\'s own status differs', async () => {
  const files = ['a.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async () => fakeDataset({
    sessionId: 1608,
    bills: [billFixture({ billNumber: 'HB1', status: 4, sponsors: [] })],
  });
  const client = makeFakeWriteClient();
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  const loadLegislatorIndexFn = async () => new Map();
  const loadBillIndexFn = async () => new Map([
    [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-hb1', status: 'Signed by Governor' }],
  ]);
  const loadSponsorIndexFn = async () => ({ gated: false, index: new Map() });

  const report = await runBackfillMoBillMeta(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn,
    readDatasetFn,
    loadSessionIndexFn,
    loadLegislatorIndexFn,
    loadBillIndexFn,
    loadSponsorIndexFn,
  });

  assert.equal(report.counts.statusAlreadySet, 1);
  assert.equal(report.counts.statusPatched, 0);
  assert.deepEqual(client.calls, [], 'the primary source\'s own status is never clobbered by LegiScan\'s — no write at all, the additive patch was empty');
});

test('runBackfillMoBillMeta: a re-run is fully idempotent — the second pass sees status already set and the sponsor row already present (via the freshly-reloaded index), zero further writes', async () => {
  const files = ['a.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async () => fakeDataset({
    sessionId: 1608,
    bills: [billFixture({ billNumber: 'HB1', status: 1, sponsors: [{ people_id: 100, sponsor_type_id: 1 }] })],
  });
  const client = makeFakeWriteClient();
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  const loadLegislatorIndexFn = async () => new Map([[100, 'leg-100']]);
  // Simulates the SECOND run's fresh bulk load seeing what the first run actually wrote.
  const loadBillIndexFn = async () => new Map([
    [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-hb1', status: '1' }],
  ]);
  const loadSponsorIndexFn = async () => ({ gated: false, index: new Map([['bill-hb1|leg-100', { id: 'bs-1' }]]) });

  const report = await runBackfillMoBillMeta(client, {
    dryRun: false,
    runId: 'run-2',
    listFilesFn,
    readDatasetFn,
    loadSessionIndexFn,
    loadLegislatorIndexFn,
    loadBillIndexFn,
    loadSponsorIndexFn,
  });

  assert.equal(report.counts.statusAlreadySet, 1);
  assert.equal(report.counts.statusPatched, 0);
  assert.equal(report.counts.sponsorAlreadyExists, 1);
  assert.equal(report.counts.sponsorInserted, 0);
  assert.deepEqual(client.calls, [], 'zero writes on a fully-caught-up re-run');
});

test('runBackfillMoBillMeta: within a SINGLE run, the in-memory sponsor index is kept consistent after a live insert — a duplicate sponsor entry later in the same run is already_exists, never a second insert attempt', async () => {
  const files = ['a.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async () => fakeDataset({
    sessionId: 1608,
    bills: [
      billFixture({ billNumber: 'HB1', status: null, sponsors: [{ people_id: 100, sponsor_type_id: 1 }] }),
      billFixture({ billNumber: 'HB2', status: null, sponsors: [{ people_id: 100, sponsor_type_id: 1 }] }),
    ],
  });
  const client = makeFakeWriteClient();
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  const loadLegislatorIndexFn = async () => new Map([[100, 'leg-100']]);
  const loadBillIndexFn = async () => new Map([
    [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-shared', status: null }],
    [`sess-1608|${normalizeBillIdentifier('HB2')}`, { id: 'bill-shared', status: null }], // contrived: both map to the same bill row id
  ]);
  const loadSponsorIndexFn = async () => ({ gated: false, index: new Map() });

  const report = await runBackfillMoBillMeta(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn,
    readDatasetFn,
    loadSessionIndexFn,
    loadLegislatorIndexFn,
    loadBillIndexFn,
    loadSponsorIndexFn,
  });

  assert.equal(report.counts.sponsorInserted, 1);
  assert.equal(report.counts.sponsorAlreadyExists, 1);
  const upsertOps = client.calls.filter((c) => c.op === 'upsert');
  assert.equal(upsertOps.length, 1, 'exactly one live upsert, not one per (bill,sponsor) occurrence');
});

test('runBackfillMoBillMeta: migration 0014 unapplied — every sponsor candidate across every bill is gated (decided ONCE, up front, by loadSponsorIndex — never a per-candidate live query); bills.status backfill is unaffected (ungated)', async () => {
  const files = ['a.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async () => fakeDataset({
    sessionId: 1608,
    bills: [
      billFixture({
        billNumber: 'HB1', status: 1, sponsors: [{ people_id: 100, sponsor_type_id: 1 }, { people_id: 200, sponsor_type_id: 2 }],
      }),
      billFixture({ billNumber: 'HB2', status: 4, sponsors: [{ people_id: 100, sponsor_type_id: 1 }] }),
    ],
  });
  const client = makeFakeWriteClient();
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  const loadLegislatorIndexFn = async () => new Map([[100, 'leg-100'], [200, 'leg-200']]);
  const loadBillIndexFn = async () => new Map([
    [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-hb1', status: null }],
    [`sess-1608|${normalizeBillIdentifier('HB2')}`, { id: 'bill-hb2', status: null }],
  ]);
  const loadSponsorIndexFn = async () => ({ gated: true, index: null }); // migration 0014 unapplied

  const report = await runBackfillMoBillMeta(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn,
    readDatasetFn,
    loadSessionIndexFn,
    loadLegislatorIndexFn,
    loadBillIndexFn,
    loadSponsorIndexFn,
  });

  assert.equal(report.counts.sponsorGated, 3, 'all three sponsor candidates across both bills gated');
  assert.equal(report.counts.statusPatched, 2, 'status backfill is a separate, ungated write path — unaffected by the sponsor-table gate');
  assert.deepEqual(client.calls.filter((c) => c.table === 'bill_sponsors'), [], 'zero bill_sponsors writes attempted once gated');
});

test('runBackfillMoBillMeta: a sponsor_type_id genuinely outside LegiScan\'s documented {0,1,2,3} is a typed, counted skip — never guessed, and never even reaches the legislator index (0/1/2/3 are now all mapped, per fix round 1 — this uses 99, never observed anywhere)', async () => {
  const files = ['a.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async () => fakeDataset({
    sessionId: 1608,
    bills: [billFixture({ billNumber: 'HB1', status: null, sponsors: [{ people_id: 100, sponsor_type_id: 99 }] })],
  });
  const client = makeFakeWriteClient();
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  let legislatorIndexTouched = false;
  const loadLegislatorIndexFn = async () => { legislatorIndexTouched = true; return new Map([[100, 'leg-100']]); };
  const loadBillIndexFn = async () => new Map([
    [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-hb1', status: null }],
  ]);
  const loadSponsorIndexFn = async () => ({ gated: false, index: new Map() });

  const report = await runBackfillMoBillMeta(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn,
    readDatasetFn,
    loadSessionIndexFn,
    loadLegislatorIndexFn,
    loadBillIndexFn,
    loadSponsorIndexFn,
  });

  assert.equal(report.counts.sponsorTypeUnknown, 1);
  assert.equal(report.counts.statusMissingInSource, 1);
  assert.ok(legislatorIndexTouched, 'the index is still bulk-loaded once per run regardless (cheap), just never CONSULTED for this candidate');
  assert.equal(report.counts.sponsorLegislatorNotFound, 0);
});

test('runBackfillMoBillMeta: an unmatched legiscan_people_id is an honest count, never name-matched', async () => {
  const files = ['a.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async () => fakeDataset({
    sessionId: 1608,
    bills: [billFixture({ billNumber: 'HB1', status: null, sponsors: [{ people_id: 999, sponsor_type_id: 1 }] })],
  });
  const client = makeFakeWriteClient();
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  const loadLegislatorIndexFn = async () => new Map([[1, 'leg-other']]);
  const loadBillIndexFn = async () => new Map([
    [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-hb1', status: null }],
  ]);
  const loadSponsorIndexFn = async () => ({ gated: false, index: new Map() });

  const report = await runBackfillMoBillMeta(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn,
    readDatasetFn,
    loadSessionIndexFn,
    loadLegislatorIndexFn,
    loadBillIndexFn,
    loadSponsorIndexFn,
  });

  assert.equal(report.counts.sponsorLegislatorNotFound, 1);
  assert.deepEqual(client.calls, []);
});

test('runBackfillMoBillMeta: a dataset session with no matching sessions row is honestly counted (sessionNotFound) — never guessed, never a per-bill lookup attempted', async () => {
  const files = ['a.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async () => fakeDataset({
    sessionId: 9999,
    bills: [billFixture({ billNumber: 'HB1', status: 1, sponsors: [{ people_id: 100, sponsor_type_id: 1 }] })],
  });
  const client = makeFakeWriteClient();
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  const loadLegislatorIndexFn = async () => new Map([[100, 'leg-100']]);
  const loadBillIndexFn = async () => new Map();
  const loadSponsorIndexFn = async () => ({ gated: false, index: new Map() });

  const report = await runBackfillMoBillMeta(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn,
    readDatasetFn,
    loadSessionIndexFn,
    loadLegislatorIndexFn,
    loadBillIndexFn,
    loadSponsorIndexFn,
  });

  assert.equal(report.counts.sessionNotFound, 1);
  assert.equal(report.counts.billNotFound, 0, 'never even attempted a bill lookup without a resolved session');
  assert.deepEqual(client.calls, []);
});

test('runBackfillMoBillMeta: a missing/corrupt cache file is skipped with an honest cacheMissing count — the other real sessions still process (skip != empty)', async () => {
  const files = ['good.json', 'bad.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async (filePath) => {
    if (filePath === 'good.json') {
      return fakeDataset({ sessionId: 1608, bills: [billFixture({ billNumber: 'HB1', status: 1, sponsors: [] })] });
    }
    return { ok: false, filePath };
  };
  const client = makeFakeWriteClient();
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  const loadLegislatorIndexFn = async () => new Map();
  const loadBillIndexFn = async () => new Map([
    [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-hb1', status: null }],
  ]);
  const loadSponsorIndexFn = async () => ({ gated: false, index: new Map() });

  const report = await runBackfillMoBillMeta(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn,
    readDatasetFn,
    loadSessionIndexFn,
    loadLegislatorIndexFn,
    loadBillIndexFn,
    loadSponsorIndexFn,
  });

  assert.equal(report.counts.cacheMissing, 1);
  assert.equal(report.counts.statusPatched, 1, 'the other real session still processed');
});

test('runBackfillMoBillMeta: zero cache files found (cache dir missing/empty) -> all-zero counts, no client calls at all, never fetches — the 4 bulk index loads still run once (cheap, run-level setup)', async () => {
  const client = makeFakeWriteClient();
  let loadsCalled = 0;
  const bumpAndReturn = (value) => async () => { loadsCalled += 1; return value; };
  const report = await runBackfillMoBillMeta(client, {
    dryRun: false,
    listFilesFn: () => [],
    loadSessionIndexFn: bumpAndReturn(new Map()),
    loadLegislatorIndexFn: bumpAndReturn(new Map()),
    loadBillIndexFn: bumpAndReturn(new Map()),
    loadSponsorIndexFn: bumpAndReturn({ gated: false, index: new Map() }),
  });
  assert.deepEqual(report.counts, {
    billsSeen: 0,
    sessionNotFound: 0,
    billNotFound: 0,
    statusMissingInSource: 0,
    statusAlreadySet: 0,
    statusPatched: 0,
    sponsorsSeen: 0,
    sponsorTypeUnknown: 0,
    sponsorLegislatorNotFound: 0,
    sponsorAlreadyExists: 0,
    sponsorGated: 0,
    sponsorType0015Gated: 0,
    sponsorInserted: 0,
    cacheMissing: 0,
  });
  assert.equal(report.cacheFilesFound, 0);
  assert.deepEqual(client.calls, []);
  assert.equal(loadsCalled, 4);
});

// ---- fix round 1: sponsorTypeBreakdown (requirement 3) + pre-0015 tolerance (requirement 2) ----

test('runBackfillMoBillMeta: sponsorTypeBreakdown reports the real per-type composition of the source data (all 4 widened-enum types), in BOTH dry-run and live mode, independent of match/write outcome — an unmatched-legislator candidate still counts toward its type, a genuinely-unknown type does not', async () => {
  const files = ['a.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async () => fakeDataset({
    sessionId: 1608,
    bills: [billFixture({
      billNumber: 'HB1',
      status: null,
      sponsors: [
        { people_id: 100, sponsor_type_id: 1 }, // primary
        { people_id: 200, sponsor_type_id: 2 }, // cosponsor
        { people_id: 300, sponsor_type_id: 3 }, // joint
        { people_id: 400, sponsor_type_id: 0 }, // unspecified
        { people_id: 999, sponsor_type_id: 1 }, // primary, unmatched legislator — still in the breakdown
        { people_id: 500, sponsor_type_id: 77 }, // genuinely unknown — excluded from the breakdown
      ],
    })],
  });
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  const loadLegislatorIndexFn = async () => new Map([
    [100, 'leg-100'], [200, 'leg-200'], [300, 'leg-300'], [400, 'leg-400'],
  ]);
  const loadBillIndexFn = async () => new Map([
    [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-hb1', status: null }],
  ]);
  const loadSponsorIndexFn = async () => ({ gated: false, index: new Map() });
  const deps = {
    listFilesFn, readDatasetFn, loadSessionIndexFn, loadLegislatorIndexFn, loadBillIndexFn, loadSponsorIndexFn,
  };
  const expectedBreakdown = {
    primary: 2, cosponsor: 1, joint: 1, unspecified: 1,
  };

  const dryReport = await runBackfillMoBillMeta(makeFakeWriteClient(), { dryRun: true, ...deps });
  assert.deepEqual(dryReport.sponsorTypeBreakdown, expectedBreakdown);

  const liveReport = await runBackfillMoBillMeta(makeFakeWriteClient(), { dryRun: false, runId: 'run-1', ...deps });
  assert.deepEqual(liveReport.sponsorTypeBreakdown, expectedBreakdown);
});

test('runBackfillMoBillMeta: pre-0015 tolerance — a live "joint"/"unspecified" insert that 23514s against the OLD (0014-only) check constraint is caught and named sponsorType0015Gated, never thrown; primary/cosponsor writes are completely unaffected; the gate (once discovered by ANY widened-type candidate) short-circuits every later widened-type candidate without a further live query', async () => {
  const files = ['a.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async () => fakeDataset({
    sessionId: 1608,
    bills: [billFixture({
      billNumber: 'HB1',
      status: null,
      sponsors: [
        { people_id: 100, sponsor_type_id: 1 }, // primary — always succeeds
        { people_id: 200, sponsor_type_id: 3 }, // joint — 23514s live, discovers the gate
        { people_id: 300, sponsor_type_id: 3 }, // joint — short-circuited, no 2nd live attempt
        { people_id: 400, sponsor_type_id: 0 }, // unspecified — ALSO short-circuited by the SAME gate
      ],
    })],
  });
  const client = makeFakeWriteClient({ rejectSponsorTypes: ['joint', 'unspecified'] });
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  const loadLegislatorIndexFn = async () => new Map([
    [100, 'leg-100'], [200, 'leg-200'], [300, 'leg-300'], [400, 'leg-400'],
  ]);
  const loadBillIndexFn = async () => new Map([
    [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-hb1', status: null }],
  ]);
  const loadSponsorIndexFn = async () => ({ gated: false, index: new Map() }); // 0014 IS applied

  const report = await runBackfillMoBillMeta(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn,
    readDatasetFn,
    loadSessionIndexFn,
    loadLegislatorIndexFn,
    loadBillIndexFn,
    loadSponsorIndexFn,
  });

  assert.equal(report.counts.sponsorInserted, 1, 'only the primary sponsor actually wrote');
  assert.equal(report.counts.sponsorType0015Gated, 3, 'joint x2 + unspecified x1, all named as the 0015 gate');
  assert.equal(report.counts.sponsorGated, 0, 'this is NOT the 0014 whole-table gate — that one is unaffected');
  const sponsorUpserts = client.calls.filter((c) => c.op === 'upsert' && c.table === 'bill_sponsors');
  assert.equal(sponsorUpserts.length, 2, 'exactly 2 live attempts: the successful primary + the FIRST joint (which fails and discovers the gate) — the second joint and the unspecified candidate never re-attempt a live write');
});

test('runBackfillMoBillMeta: pre-0015 tolerance does not apply in dry-run — dry-run never attempts a write, so it cannot discover the constraint; joint/unspecified candidates land in plan.sponsorInserts like any other, a documented dry-run limitation', async () => {
  const files = ['a.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async () => fakeDataset({
    sessionId: 1608,
    bills: [billFixture({ billNumber: 'HB1', status: null, sponsors: [{ people_id: 200, sponsor_type_id: 3 }] })],
  });
  const client = makeFakeWriteClient({ rejectSponsorTypes: ['joint'] });
  const loadSessionIndexFn = async () => new Map([[1608, { id: 'sess-1608' }]]);
  const loadLegislatorIndexFn = async () => new Map([[200, 'leg-200']]);
  const loadBillIndexFn = async () => new Map([
    [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-hb1', status: null }],
  ]);
  const loadSponsorIndexFn = async () => ({ gated: false, index: new Map() });

  const report = await runBackfillMoBillMeta(client, {
    dryRun: true, listFilesFn, readDatasetFn, loadSessionIndexFn, loadLegislatorIndexFn, loadBillIndexFn, loadSponsorIndexFn,
  });

  assert.equal(report.counts.sponsorType0015Gated, 0);
  assert.equal(report.plan.sponsorInserts.length, 1);
  assert.equal(report.plan.sponsorInserts[0].sponsorType, 'joint');
  assert.deepEqual(client.calls, [], 'zero writes reachable from dry-run, so the 23514 is never even seen');
});

// ---- real end-to-end file decode (no live DB — empty index maps, just proving the FILE side of
// the pipeline is correct against the actual 31 cached archives) ----

test('runBackfillMoBillMeta: real cache dir end-to-end file decode — billsSeen/sponsorsSeen are computed from the actual 31 cached archives, zero API queries, zero writes (empty session index -> nothing resolves deeper)', async () => {
  const client = makeFakeWriteClient();
  const report = await runBackfillMoBillMeta(client, {
    dryRun: false,
    cacheDir: REAL_CACHE_DIR,
    loadSessionIndexFn: async () => new Map(),
    loadLegislatorIndexFn: async () => new Map(),
    loadBillIndexFn: async () => new Map(),
    loadSponsorIndexFn: async () => ({ gated: false, index: new Map() }),
  });
  assert.equal(report.cacheFilesFound, 31);
  assert.equal(report.counts.cacheMissing, 0, 'every one of the 31 real cache files decodes cleanly');
  assert.ok(report.counts.billsSeen > 0);
  assert.equal(report.counts.sessionNotFound, report.counts.billsSeen, 'empty session index: every bill\'s session goes unresolved, so every bill is counted there and nothing deeper is ever attempted');
  assert.equal(report.counts.billNotFound, 0);
  assert.equal(report.counts.sponsorsSeen, 0, 'never reached — no session ever resolved');
  assert.equal(report.counts.statusPatched, 0);
  assert.equal(report.counts.sponsorInserted, 0);
  assert.deepEqual(client.calls, []);
});
