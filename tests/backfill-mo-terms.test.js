import {
  mkdtempSync, rmSync, writeFileSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  readDatasetEnvelopeMeta,
  resolveLatestMoDatasetFile,
  findExistingMoTerm,
  insertMoTermRow,
  runBackfillMoTerms,
} from '../src/cli/backfill-mo-terms.js';
import { listCachedDatasetFiles, readCachedDatasetPeople } from '../src/cli/backfill-nicknames.js';

// Task 8b of the public-site plan (.superpowers/sdd/2026-07-30-public-site/task-8b-brief.md,
// finding D1): mo-legislature terms are ~unpopulated (1 row live) because no driver has ever
// written a `terms` row per LegiScan-sourced MO legislator — the MO address lookup on the site
// returns "not found" for virtually every real MO address as a result. This CLI fills that gap
// from the LATEST MO LegiScan session's cached people records only (walk-back ruling: a current-
// roster fix, not a historical-terms project) — ZERO LegiScan API queries, ZERO live DB writes
// anywhere in this test file (fake client throughout; the real-filesystem tests below read the
// repo's own already-committed-locally cache directory and its real envelope metadata, never the
// network).
//
// Dates stay null throughout (session-derived dates would invent term boundaries the source does
// not actually assert) — every insert/check here is null-start_date shaped, and idempotency is
// enforced by check-then-insert (findExistingMoTerm), never the table's own unique constraint
// (which cannot dedupe null start_date values — Postgres treats every NULL as distinct).

const REAL_CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';

async function withScratchDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'visiblegov-mo-terms-backfill-'));
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

// ---- readDatasetEnvelopeMeta (cheap metadata read — no zip decode) ----

test('readDatasetEnvelopeMeta: real cached envelope — session_id/year_start/session_title/dataset_date read straight off the top-level envelope fields, no ZIP decode needed', () => {
  const files = listCachedDatasetFiles(REAL_CACHE_DIR).filter((f) => f.includes('2239-'));
  assert.equal(files.length, 1, 'the 2026 Regular Session dataset (2239) must be cached');
  const meta = readDatasetEnvelopeMeta(files[0]);
  assert.equal(meta.ok, true);
  assert.equal(meta.sessionId, 2239);
  assert.equal(meta.yearStart, 2026);
  assert.equal(meta.sessionTitle, '2026 Regular Session');
  assert.equal(meta.datasetDate, '2026-07-26');
});

test('readDatasetEnvelopeMeta: a nonexistent file path is honestly reported ok:false, never throws', () => {
  const meta = readDatasetEnvelopeMeta('.superpowers/artifacts/legiscan-datasets/does-not-exist.json');
  assert.deepEqual(meta, { ok: false, filePath: '.superpowers/artifacts/legiscan-datasets/does-not-exist.json' });
});

test('readDatasetEnvelopeMeta: malformed JSON on disk is honestly reported ok:false, never throws', async () => {
  await withScratchDirAsync(async (dir) => {
    const filePath = join(dir, 'bad.json');
    writeFileSync(filePath, '{not valid json');
    const meta = readDatasetEnvelopeMeta(filePath);
    assert.deepEqual(meta, { ok: false, filePath });
  });
});

test('readDatasetEnvelopeMeta: an envelope missing session_id or year_start is honestly reported ok:false', async () => {
  await withScratchDirAsync(async (dir) => {
    const filePath = join(dir, 'incomplete.json');
    writeFileSync(filePath, JSON.stringify({ session_id: 123 })); // no year_start
    const meta = readDatasetEnvelopeMeta(filePath);
    assert.deepEqual(meta, { ok: false, filePath });
  });
});

// ---- resolveLatestMoDatasetFile (mechanical pick: highest year_start among cached datasets) ----

test('resolveLatestMoDatasetFile: the real 31-file cache — 2239 (2026 Regular Session, year_start 2026) is the mechanical winner', () => {
  const { best, filesConsidered, skippedUnreadable } = resolveLatestMoDatasetFile(REAL_CACHE_DIR);
  assert.equal(filesConsidered, 31);
  assert.equal(skippedUnreadable, 0);
  assert.equal(best.sessionId, 2239);
  assert.equal(best.yearStart, 2026);
  assert.equal(best.sessionTitle, '2026 Regular Session');
});

test('resolveLatestMoDatasetFile: highest year_start wins regardless of file order', () => {
  const listFilesFn = () => ['a.json', 'b.json', 'c.json'];
  const metaByFile = {
    'a.json': {
      ok: true, filePath: 'a.json', sessionId: 100, yearStart: 2020, sessionTitle: '2020', datasetDate: '2021-01-01',
    },
    'b.json': {
      ok: true, filePath: 'b.json', sessionId: 200, yearStart: 2025, sessionTitle: '2025', datasetDate: '2025-06-01',
    },
    'c.json': {
      ok: true, filePath: 'c.json', sessionId: 300, yearStart: 2022, sessionTitle: '2022', datasetDate: '2022-01-01',
    },
  };
  const { best } = resolveLatestMoDatasetFile('irrelevant', { listFilesFn, readMetaFn: (f) => metaByFile[f] });
  assert.equal(best.sessionId, 200);
  assert.equal(best.yearStart, 2025);
});

test('resolveLatestMoDatasetFile: a tie on year_start is broken by the later dataset_date, then by the higher legiscan session_id', () => {
  const listFilesFn = () => ['reg.json', 'special.json'];
  const metaByFile = {
    'reg.json': {
      ok: true, filePath: 'reg.json', sessionId: 500, yearStart: 2025, sessionTitle: 'Regular', datasetDate: '2025-12-07',
    },
    'special.json': {
      ok: true, filePath: 'special.json', sessionId: 600, yearStart: 2025, sessionTitle: 'Special', datasetDate: '2025-12-07',
    },
  };
  const { best } = resolveLatestMoDatasetFile('irrelevant', { listFilesFn, readMetaFn: (f) => metaByFile[f] });
  assert.equal(best.sessionId, 600, 'same year_start, same dataset_date -> higher legiscan session_id wins, deterministically');
});

test('resolveLatestMoDatasetFile: unreadable/incomplete envelopes are skipped honestly, never crash the resolution', () => {
  const listFilesFn = () => ['good.json', 'bad.json'];
  const metaByFile = {
    'good.json': {
      ok: true, filePath: 'good.json', sessionId: 1, yearStart: 2018, sessionTitle: '2018', datasetDate: '2018-01-01',
    },
    'bad.json': { ok: false, filePath: 'bad.json' },
  };
  const { best, skippedUnreadable } = resolveLatestMoDatasetFile('irrelevant', { listFilesFn, readMetaFn: (f) => metaByFile[f] });
  assert.equal(best.sessionId, 1);
  assert.equal(skippedUnreadable, 1);
});

test('resolveLatestMoDatasetFile: zero cached files -> best is null, honestly, never throws', () => {
  const { best, filesConsidered } = resolveLatestMoDatasetFile('irrelevant', { listFilesFn: () => [] });
  assert.equal(best, null);
  assert.equal(filesConsidered, 0);
});

// ---- findExistingMoTerm (check-then-insert — the terms unique constraint cannot dedupe null
// start_date, per the brief; this is the honest idempotency check that stands in for it) ----

function makeTermsSelectFakeClient(existingRows) {
  return {
    from: (table) => {
      assert.equal(table, 'terms');
      return {
        select: () => {
          const filters = [];
          const builder = {
            eq: (col, val) => { filters.push((r) => r[col] === val); return builder; },
            is: (col, val) => {
              filters.push((r) => (val === null ? r[col] == null : r[col] === val));
              return {
                maybeSingle: async () => {
                  const hits = existingRows.filter((r) => filters.every((f) => f(r)));
                  if (hits.length > 1) return { data: null, error: { message: 'multiple rows returned' } };
                  return { data: hits[0] ?? null, error: null };
                },
              };
            },
          };
          return builder;
        },
      };
    },
  };
}

test('findExistingMoTerm: an existing null-start_date row for the same legislator/chamber/district is found', async () => {
  const client = makeTermsSelectFakeClient([
    {
      id: 'term-1', legislator_id: 'leg-1', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '60', start_date: null,
    },
  ]);
  const row = await findExistingMoTerm(client, { legislatorId: 'leg-1', chamber: 'house', district: '60' });
  assert.equal(row.id, 'term-1');
});

test('findExistingMoTerm: no matching row -> null, never guessed', async () => {
  const client = makeTermsSelectFakeClient([]);
  const row = await findExistingMoTerm(client, { legislatorId: 'leg-1', chamber: 'house', district: '60' });
  assert.equal(row, null);
});

test('findExistingMoTerm: a DATED row (start_date not null) for the same seat does not count as already-present — the check is start_date IS NULL specifically', async () => {
  const client = makeTermsSelectFakeClient([
    {
      id: 'term-old', legislator_id: 'leg-1', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '60', start_date: '2019-01-09',
    },
  ]);
  const row = await findExistingMoTerm(client, { legislatorId: 'leg-1', chamber: 'house', district: '60' });
  assert.equal(row, null, 'a dated historical term must not block inserting the current null-dated roster row');
});

// ---- insertMoTermRow (state:'MO' when the column exists; graceful fallback when migration 0016
// is not yet applied — never blocks the primary insert on a secondary/enrichment field) ----

function makeInsertFakeClient({ failOnState = false } = {}) {
  const calls = [];
  return {
    calls,
    from: (table) => ({
      insert: async (row) => {
        calls.push({ table, row });
        if (failOnState && Object.prototype.hasOwnProperty.call(row, 'state')) {
          return { error: { code: '42703', message: 'column "state" of relation "terms" does not exist' } };
        }
        return { error: null };
      },
    }),
  };
}

test('insertMoTermRow: includeState:true writes state:"MO" alongside the null-dated term row', async () => {
  const client = makeInsertFakeClient();
  const result = await insertMoTermRow(client, 'run-1', {
    legislatorId: 'leg-1', chamber: 'house', district: '60', party: 'R', includeState: true,
  });
  assert.equal(result.stateColumnMissing, false);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].row, {
    legislator_id: 'leg-1',
    jurisdiction_id: 'mo-legislature',
    chamber: 'house',
    district: '60',
    party: 'R',
    start_date: null,
    end_date: null,
    run_id: 'run-1',
    state: 'MO',
  });
});

test('insertMoTermRow: a missing terms.state column (migration 0016 unapplied) falls back to inserting without state — the term row still lands, never blocked on the enrichment field', async () => {
  const client = makeInsertFakeClient({ failOnState: true });
  const result = await insertMoTermRow(client, 'run-1', {
    legislatorId: 'leg-1', chamber: 'senate', district: '2', party: 'D', includeState: true,
  });
  assert.equal(result.stateColumnMissing, true);
  assert.equal(client.calls.length, 2, 'one failed attempt with state, one successful retry without it');
  assert.ok(!Object.prototype.hasOwnProperty.call(client.calls[1].row, 'state'));
  assert.equal(client.calls[1].row.legislator_id, 'leg-1');
});

test('insertMoTermRow: includeState:false skips the state field entirely on the first attempt (caller already knows the column is missing)', async () => {
  const client = makeInsertFakeClient();
  const result = await insertMoTermRow(client, 'run-1', {
    legislatorId: 'leg-1', chamber: 'house', district: '1', party: null, includeState: false,
  });
  assert.equal(result.stateColumnMissing, false);
  assert.equal(client.calls.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(client.calls[0].row, 'state'));
});

test('insertMoTermRow: an unrelated insert error is thrown, never silently swallowed', async () => {
  const client = {
    from: () => ({ insert: async () => ({ error: { code: '500', message: 'connection reset' } }) }),
  };
  await assert.rejects(
    () => insertMoTermRow(client, 'run-1', {
      legislatorId: 'leg-1', chamber: 'house', district: '1', party: null, includeState: true,
    }),
    /connection reset/,
  );
});

// ---- runBackfillMoTerms (orchestration; injected loaders/resolvers) ----

function fakeResolution(sessionId, yearStart, filePath = 'fake.json') {
  return {
    best: {
      ok: true, filePath, sessionId, yearStart, sessionTitle: `${yearStart} Regular Session`, datasetDate: `${yearStart}-01-01`,
    },
    filesConsidered: 1,
    skippedUnreadable: 0,
  };
}

function person({
  peopleId, role, district, party = 'R', name = 'Test Person',
}) {
  return {
    people_id: peopleId, role, district, party, name,
  };
}

test('runBackfillMoTerms: a Rep with a matching legislator inserts a house term, district normalized to bare digits', async () => {
  const inserted = [];
  const resolveLatestDatasetFileFn = () => fakeResolution(2239, 2026);
  const readDatasetFn = async () => ({
    ok: true, sessionId: 2239, people: [person({ peopleId: 100, role: 'Rep', district: 'HD-060', party: 'R' })],
  });
  const loadLegislatorIndexFn = async () => new Map([[100, 'leg-100']]);
  const findExistingTermFn = async () => null;
  const insertTermFn = async (client, runId, args) => { inserted.push(args); return { stateColumnMissing: false }; };

  const report = await runBackfillMoTerms(null, {
    dryRun: false,
    runId: 'run-1',
    resolveLatestDatasetFileFn,
    readDatasetFn,
    loadLegislatorIndexFn,
    findExistingTermFn,
    insertTermFn,
  });

  assert.equal(report.counts.peopleSeen, 1);
  assert.equal(report.counts.termsInserted, 1);
  assert.equal(inserted.length, 1);
  assert.deepEqual(inserted[0], {
    legislatorId: 'leg-100', chamber: 'house', district: '60', party: 'R', includeState: true,
  });
  assert.equal(report.session.legiscanSessionId, 2239);
  assert.equal(report.session.yearStart, 2026);
});

test('runBackfillMoTerms: a Sen with a matching legislator inserts a senate term, district normalized', async () => {
  const inserted = [];
  const readDatasetFn = async () => ({
    ok: true, sessionId: 2239, people: [person({ peopleId: 200, role: 'Sen', district: 'SD-02', party: 'D' })],
  });
  const report = await runBackfillMoTerms(null, {
    dryRun: false,
    runId: 'run-1',
    resolveLatestDatasetFileFn: () => fakeResolution(2239, 2026),
    readDatasetFn,
    loadLegislatorIndexFn: async () => new Map([[200, 'leg-200']]),
    findExistingTermFn: async () => null,
    insertTermFn: async (client, runId, args) => { inserted.push(args); return { stateColumnMissing: false }; },
  });
  assert.equal(report.counts.termsInserted, 1);
  assert.deepEqual(inserted[0], {
    legislatorId: 'leg-200', chamber: 'senate', district: '2', party: 'D', includeState: true,
  });
});

test('runBackfillMoTerms: a role that maps to neither chamber is counted skippedNonLegislator, never guessed, never throws', async () => {
  const readDatasetFn = async () => ({
    ok: true,
    sessionId: 2239,
    people: [
      person({
        peopleId: 300, role: 'Lobbyist', district: 'HD-001', party: null,
      }),
      person({ peopleId: 301, role: 'Rep', district: 'HD-002' }),
    ],
  });
  const report = await runBackfillMoTerms(null, {
    dryRun: false,
    runId: 'run-1',
    resolveLatestDatasetFileFn: () => fakeResolution(2239, 2026),
    readDatasetFn,
    loadLegislatorIndexFn: async () => new Map([[301, 'leg-301']]),
    findExistingTermFn: async () => null,
    insertTermFn: async () => ({ stateColumnMissing: false }),
  });
  assert.equal(report.counts.peopleSeen, 2);
  assert.equal(report.counts.skippedNonLegislator, 1);
  assert.equal(report.counts.termsInserted, 1);
});

test('runBackfillMoTerms: a legiscan_people_id with no matching legislator row is counted noMatchingLegislator, never guessed', async () => {
  const readDatasetFn = async () => ({
    ok: true, sessionId: 2239, people: [person({ peopleId: 999, role: 'Rep', district: 'HD-001' })],
  });
  const report = await runBackfillMoTerms(null, {
    dryRun: false,
    runId: 'run-1',
    resolveLatestDatasetFileFn: () => fakeResolution(2239, 2026),
    readDatasetFn,
    loadLegislatorIndexFn: async () => new Map(), // empty — no legislators mapped
    findExistingTermFn: async () => { throw new Error('must not be called — no legislator to check against'); },
    insertTermFn: async () => { throw new Error('must not be called'); },
  });
  assert.equal(report.counts.noMatchingLegislator, 1);
  assert.equal(report.counts.termsInserted, 0);
});

test('runBackfillMoTerms: an already-present null-dated term is counted alreadyPresent, never re-inserted', async () => {
  const readDatasetFn = async () => ({
    ok: true, sessionId: 2239, people: [person({ peopleId: 100, role: 'Rep', district: 'HD-060' })],
  });
  const report = await runBackfillMoTerms(null, {
    dryRun: false,
    runId: 'run-1',
    resolveLatestDatasetFileFn: () => fakeResolution(2239, 2026),
    readDatasetFn,
    loadLegislatorIndexFn: async () => new Map([[100, 'leg-100']]),
    findExistingTermFn: async () => ({ id: 'existing-term' }),
    insertTermFn: async () => { throw new Error('must not be called — already present'); },
  });
  assert.equal(report.counts.alreadyPresent, 1);
  assert.equal(report.counts.termsInserted, 0);
});

test('runBackfillMoTerms: --dry-run performs the same resolution (including the existing-row check) but never inserts; plan carries the would-insert rows', async () => {
  const readDatasetFn = async () => ({
    ok: true,
    sessionId: 2239,
    people: [
      person({ peopleId: 100, role: 'Rep', district: 'HD-060' }),
      person({ peopleId: 200, role: 'Sen', district: 'SD-02' }),
    ],
  });
  const report = await runBackfillMoTerms(null, {
    dryRun: true,
    resolveLatestDatasetFileFn: () => fakeResolution(2239, 2026),
    readDatasetFn,
    loadLegislatorIndexFn: async () => new Map([[100, 'leg-100'], [200, 'leg-200']]),
    findExistingTermFn: async (client, { legislatorId }) => (legislatorId === 'leg-200' ? { id: 'existing' } : null),
    insertTermFn: async () => { throw new Error('must not be called in dry-run'); },
  });
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.counts.termsInserted, 0, 'dry-run performs zero writes');
  assert.equal(report.counts.alreadyPresent, 1);
  assert.equal(report.plan.length, 1);
  assert.equal(report.plan[0].legislatorId, 'leg-100');
});

test('runBackfillMoTerms: after one migration-0016-missing insert, the orchestrator stops re-attempting state on subsequent inserts in the same run', async () => {
  const includeStateSeen = [];
  const readDatasetFn = async () => ({
    ok: true,
    sessionId: 2239,
    people: [
      person({ peopleId: 100, role: 'Rep', district: 'HD-060' }),
      person({ peopleId: 200, role: 'Sen', district: 'SD-02' }),
    ],
  });
  let calls = 0;
  const report = await runBackfillMoTerms(null, {
    dryRun: false,
    runId: 'run-1',
    resolveLatestDatasetFileFn: () => fakeResolution(2239, 2026),
    readDatasetFn,
    loadLegislatorIndexFn: async () => new Map([[100, 'leg-100'], [200, 'leg-200']]),
    findExistingTermFn: async () => null,
    insertTermFn: async (client, runId, args) => {
      calls += 1;
      includeStateSeen.push(args.includeState);
      return { stateColumnMissing: calls === 1 };
    },
  });
  assert.equal(report.counts.termsInserted, 2);
  assert.deepEqual(includeStateSeen, [true, false]);
});

test('runBackfillMoTerms: no cached MO dataset envelopes found -> honest zero counts, session:null, never throws', async () => {
  const report = await runBackfillMoTerms(null, {
    dryRun: false,
    resolveLatestDatasetFileFn: () => ({ best: null, filesConsidered: 0, skippedUnreadable: 0 }),
  });
  assert.equal(report.session, null);
  assert.equal(report.counts.peopleSeen, 0);
  assert.equal(report.counts.termsInserted, 0);
});

test('runBackfillMoTerms: the chosen dataset file cannot be decoded (corrupt cache) -> honest zero counts, session identified but no people processed', async () => {
  const report = await runBackfillMoTerms(null, {
    dryRun: false,
    resolveLatestDatasetFileFn: () => fakeResolution(2239, 2026),
    readDatasetFn: async () => ({ ok: false, filePath: 'fake.json' }),
  });
  assert.equal(report.session.legiscanSessionId, 2239);
  assert.equal(report.counts.peopleSeen, 0);
});

// ---- real-fixture end-to-end smoke (real cache dir + real decode, fake DB layer only) ----

test('runBackfillMoTerms: real cache dir end-to-end — resolves the real 2026 session, decodes real people, and only inserts for people with a legislator match', async () => {
  const inserted = [];
  const report = await runBackfillMoTerms(null, {
    dryRun: false,
    runId: 'run-1',
    cacheDir: REAL_CACHE_DIR,
    readDatasetFn: readCachedDatasetPeople,
    loadLegislatorIndexFn: async () => new Map(), // no legislators in this fake DB — everyone noMatchingLegislator
    findExistingTermFn: async () => { throw new Error('must not be called — nothing matched'); },
    insertTermFn: async (client, runId, args) => { inserted.push(args); return { stateColumnMissing: false }; },
  });
  assert.equal(report.session.legiscanSessionId, 2239);
  assert.ok(report.counts.peopleSeen > 100, 'a real MO legislature roster has well over 100 people records');
  assert.equal(report.counts.noMatchingLegislator, report.counts.peopleSeen - report.counts.skippedNonLegislator);
  assert.equal(inserted.length, 0);
});
