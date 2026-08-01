import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTitleIndex, resolveBillTitle, runBackfill,
} from '../src/cli/backfill-bill-titles.js';
import { parsePositiveIntegerFlag } from '../src/lib/errors.js';

// buildTitleIndex consumes the SAME shape readCachedDatasetBills (backfill-mo-bill-meta.js)
// returns for a successfully-parsed cache file: { ok: true, sessionId, bills: [...] } — and the
// SAME loadSessionIndex Map<legiscan_session_id, {id}> the other backfill CLIs already use for
// exact-match-only session resolution (never create/patch — that write path belongs solely to
// ingest-legiscan.js, per the brief's TODO-25 sensitivity).

function fakeExtractedBills() {
  return [
    { bill_id: 1, bill_number: 'HB1', title: 'Appropriates money to the Board of Fund Commissioners' },
    { bill_id: 2, bill_number: 'HB2', title: '' }, // empty title — must not "resolve"
    { bill_id: 3, bill_number: 'SB10', title: 'Modifies provisions relating to taxation' },
  ];
}

test('buildTitleIndex keys by (dbSessionId, normalizedIdentifier), skips empty titles', () => {
  const sessionIndex = new Map([[1009, { id: 'db-abc' }]]);
  const cachedFiles = [{ ok: true, sessionId: 1009, bills: fakeExtractedBills() }];
  const index = buildTitleIndex(cachedFiles, sessionIndex);
  assert.equal(index.get('db-abc|HB 1'), 'Appropriates money to the Board of Fund Commissioners');
  assert.equal(index.get('db-abc|SB 10'), 'Modifies provisions relating to taxation');
  assert.equal(index.has('db-abc|HB 2'), false, 'empty-title bill must not enter the index');
});

test('buildTitleIndex excludes an entire dataset when its session has no exact legiscan_session_id match (never guesses/creates)', () => {
  const sessionIndex = new Map(); // no DB session carries legiscan_session_id 9999
  const cachedFiles = [{ ok: true, sessionId: 9999, bills: fakeExtractedBills() }];
  const index = buildTitleIndex(cachedFiles, sessionIndex);
  assert.equal(index.size, 0);
});

test('buildTitleIndex skips a dataset file that failed to parse (ok:false), without throwing', () => {
  const sessionIndex = new Map([[1009, { id: 'db-abc' }]]);
  const cachedFiles = [{ ok: false, filePath: 'bad.json' }, { ok: true, sessionId: 1009, bills: fakeExtractedBills() }];
  const index = buildTitleIndex(cachedFiles, sessionIndex);
  assert.equal(index.get('db-abc|HB 1'), 'Appropriates money to the Board of Fund Commissioners');
});

test('resolveBillTitle: found -> title; unresolved -> honest reason', () => {
  const index = new Map([['db-abc|HB 1', 'Real Title']]);
  assert.deepEqual(resolveBillTitle(index, { session_id: 'db-abc', identifier: 'HB 1' }), { found: true, title: 'Real Title' });
  assert.deepEqual(resolveBillTitle(index, { session_id: 'db-abc', identifier: 'HB 99' }), { found: false, reason: 'no matching dataset entry' });
  assert.deepEqual(resolveBillTitle(index, { session_id: 'db-zzz', identifier: 'HB 1' }), { found: false, reason: 'no matching dataset entry' });
});

test('parsePositiveIntegerFlag (shared repo primitive, re-verified here since --limit depends on it) rejects NaN/0/negative', () => {
  assert.throws(() => parsePositiveIntegerFlag('0', '--limit'));
  assert.throws(() => parsePositiveIntegerFlag('-3', '--limit'));
  assert.throws(() => parsePositiveIntegerFlag('abc', '--limit'));
  assert.equal(parsePositiveIntegerFlag('5', '--limit'), 5);
});

test('runBackfill dry-run: reports counts, makes zero writes', async () => {
  const nullTitleBills = [
    { id: 'b1', session_id: 'db-abc', identifier: 'HB 1' },
    { id: 'b2', session_id: 'db-abc', identifier: 'HB 99' }, // unresolved
  ];
  const index = new Map([['db-abc|HB 1', 'Real Title']]);
  const writes = [];
  const report = await runBackfill({
    nullTitleBills,
    titleIndex: index,
    dryRun: true,
    limit: null,
    writeTitle: async (id, title) => { writes.push({ id, title }); },
  });
  assert.equal(writes.length, 0, 'dry-run must never call writeTitle');
  assert.equal(report.nullTitleBills, 2);
  assert.equal(report.resolvable, 1);
  assert.equal(report.unresolved.count, 1);
  assert.deepEqual(report.unresolved.byReason, { 'no matching dataset entry': 1 });
});

test('runBackfill live: writes only resolvable titles, respects --limit, reports honest counts', async () => {
  const nullTitleBills = [
    { id: 'b1', session_id: 'db-abc', identifier: 'HB 1' },
    { id: 'b2', session_id: 'db-abc', identifier: 'SB 10' },
    { id: 'b3', session_id: 'db-abc', identifier: 'HB 99' },
  ];
  const index = new Map([['db-abc|HB 1', 'Title One'], ['db-abc|SB 10', 'Title Ten']]);
  const writes = [];
  const report = await runBackfill({
    nullTitleBills, titleIndex: index, dryRun: false, limit: 1,
    writeTitle: async (id, title) => { writes.push({ id, title }); },
  });
  assert.equal(writes.length, 1, '--limit 1 caps live writes to 1');
  assert.equal(report.written, 1);
  assert.equal(report.unresolved.count, 1, 'HB 99 still counted honestly even though limit stopped early');
});

test('runBackfill live, no limit: writes every resolvable bill exactly once', async () => {
  const nullTitleBills = [
    { id: 'b1', session_id: 'db-abc', identifier: 'HB 1' },
    { id: 'b2', session_id: 'db-abc', identifier: 'SB 10' },
  ];
  const index = new Map([['db-abc|HB 1', 'Title One'], ['db-abc|SB 10', 'Title Ten']]);
  const writes = [];
  const report = await runBackfill({
    nullTitleBills, titleIndex: index, dryRun: false, limit: null,
    writeTitle: async (id, title) => { writes.push({ id, title }); },
  });
  assert.equal(writes.length, 2);
  assert.equal(report.written, 2);
  assert.equal(report.unresolved.count, 0);
});

test('runBackfill: a writeTitle failure is caught and counted, does not abort the batch', async () => {
  const nullTitleBills = [
    { id: 'b1', session_id: 'db-abc', identifier: 'HB 1' },
    { id: 'b2', session_id: 'db-abc', identifier: 'SB 10' },
  ];
  const index = new Map([['db-abc|HB 1', 'Title One'], ['db-abc|SB 10', 'Title Ten']]);
  const writes = [];
  const report = await runBackfill({
    nullTitleBills, titleIndex: index, dryRun: false, limit: null,
    writeTitle: async (id, title) => {
      if (id === 'b1') throw new Error('simulated DB error');
      writes.push({ id, title });
    },
  });
  assert.equal(writes.length, 1, 'b2 still gets written despite b1 failing');
  assert.equal(report.written, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].id, 'b1');
});
