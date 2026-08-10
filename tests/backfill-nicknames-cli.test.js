import {
  mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  listCachedDatasetFiles,
  extractNicknamePeople,
  readCachedDatasetPeople,
  resolveNicknamePatch,
  runBackfillNicknames,
} from '../src/cli/backfill-nicknames.js';
import { assertCacheManifestConsistent } from './support/real-legiscan-cache.js';

// Nickname amendment (.superpowers/sdd/2026-07-29-identity-merge/progress.md, last entry):
// migration 0013 (draft) adds legislators.nickname; this CLI backfills it from the 31 dataset ZIPs
// ALREADY cached under .superpowers/artifacts/legiscan-datasets/ (a prior ingest-legiscan.js
// sweep's own local cache) — ZERO LegiScan API queries, ZERO live DB writes anywhere in this test
// file (fake client throughout; the one real-filesystem test below reads the repo's own already-
// committed-locally cache directory, never the network).

const REAL_CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';

async function withScratchDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'visiblegov-nickname-backfill-'));
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

test('real legiscan-datasets cache manifest: if the cache exists at all, session 1608 must be in it', () => {
  assertCacheManifestConsistent(['1608-']);
});

// ---- listCachedDatasetFiles ----

test('listCachedDatasetFiles: the real repo cache dir has exactly the 32 cached dataset ZIPs this task is scoped to', (t) => {
  // Bumped 31 -> 32 (2026-08-03), 32 -> 33 (2026-08-10): LegiScan datasets refresh weekly, so
  // this real cache dir grows over time (a fresh 2239 weekly dataset landed 2026-08-09) — this
  // snapshot needs periodic bumps, same as every other "real cache dir" count in this test suite.
  //
  // Senior engineering audit (2026-08-03, finding 15): guarded to skip honestly (not fail
  // confusingly at 0 !== 32) on a fresh clone, where this gitignored, weekly-mutating cache is
  // absent entirely.
  const files = listCachedDatasetFiles(REAL_CACHE_DIR);
  if (files.length === 0) {
    t.skip('real legiscan-datasets cache not present locally (gitignored, expected on a fresh clone)');
    return;
  }
  assert.equal(files.length, 33);
  assert.ok(files.every((f) => f.endsWith('.json')));
  assert.ok(files.every((f) => f.startsWith(`${REAL_CACHE_DIR}/`)));
});

test('listCachedDatasetFiles: a missing cache dir returns zero files honestly, never throws, never fetches', () => {
  assert.deepEqual(listCachedDatasetFiles('.superpowers/artifacts/does-not-exist-nickname-backfill'), []);
});

test('listCachedDatasetFiles: MINOR (fix round 1) — the result is sorted lexicographically, independent of directory-entry order, so multi-session nickname precedence (first-processed-wins under additivePatch) is deterministic run-to-run', async () => {
  await withScratchDirAsync(async (dir) => {
    // Written deliberately out of order — readdirSync's own ordering is filesystem-dependent and
    // must never be relied on directly.
    writeFileSync(join(dir, '2216-zzz.json'), '{}');
    writeFileSync(join(dir, '71-aaa.json'), '{}');
    writeFileSync(join(dir, '1608-mmm.json'), '{}');
    const files = listCachedDatasetFiles(dir);
    const names = files.map((f) => f.slice(dir.length + 1));
    assert.deepEqual(names, ['1608-mmm.json', '2216-zzz.json', '71-aaa.json'], 'plain lexicographic sort, matching Array.prototype.sort default');
  });
});

test('listCachedDatasetFiles: an empty real directory returns zero files; non-.json entries are ignored', async () => {
  await withScratchDirAsync(async (dir) => {
    writeFileSync(join(dir, 'README.md'), 'not a dataset');
    writeFileSync(join(dir, '1608-abc.json'), '{}');
    const files = listCachedDatasetFiles(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('1608-abc.json'));
  });
});

// ---- extractNicknamePeople (pure) ----

test('extractNicknamePeople: includes a person whose nickname differs from first_name', () => {
  const out = extractNicknamePeople([
    {
      people_id: 16351, first_name: 'Robert', nickname: 'Bob',
    },
  ]);
  assert.deepEqual(out, [{ peopleId: 16351, nickname: 'Bob' }]);
});

test('extractNicknamePeople: excludes a person whose nickname equals first_name (zero new information)', () => {
  const out = extractNicknamePeople([{ people_id: 1, first_name: 'Robert', nickname: 'Robert' }]);
  assert.deepEqual(out, []);
});

test('extractNicknamePeople: MINOR (fix round 1) — the redundancy check is normalized (case/whitespace/punctuation-folded), so a casing-only quirk like nickname:"BOB" on first_name:"Bob" is also correctly excluded as redundant, not treated as a genuine alternate name', () => {
  const out = extractNicknamePeople([
    { people_id: 1, first_name: 'Bob', nickname: 'BOB' },
    { people_id: 2, first_name: ' Robert ', nickname: 'robert' },
  ]);
  assert.deepEqual(out, []);
});

test('extractNicknamePeople: the redundancy check is normalized for comparison ONLY — the persisted nickname value is still the source\'s own verbatim casing/punctuation, never folded', () => {
  const out = extractNicknamePeople([{ people_id: 16351, first_name: 'Robert', nickname: 'Bob' }]);
  assert.deepEqual(out, [{ peopleId: 16351, nickname: 'Bob' }]);
});

test('extractNicknamePeople: excludes a person with no nickname (absent, empty, or whitespace-only)', () => {
  const out = extractNicknamePeople([
    { people_id: 1, first_name: 'A' },
    { people_id: 2, first_name: 'B', nickname: '' },
    { people_id: 3, first_name: 'C', nickname: '   ' },
    { people_id: 4, first_name: 'D', nickname: null },
  ]);
  assert.deepEqual(out, []);
});

test('extractNicknamePeople: empty/absent input yields empty output, never throws', () => {
  assert.deepEqual(extractNicknamePeople([]), []);
  assert.deepEqual(extractNicknamePeople(undefined), []);
});

test('extractNicknamePeople: real fixture — the live LegiScan Onder record (people_id 16351, nickname "Bob") is included among several non-nickname records', () => {
  const out = extractNicknamePeople([
    {
      people_id: 16351, first_name: 'Robert', last_name: 'Onder', nickname: 'Bob',
    },
    { people_id: 1, first_name: 'Jane', last_name: 'Smith', nickname: '' },
  ]);
  assert.deepEqual(out, [{ peopleId: 16351, nickname: 'Bob' }]);
});

// ---- readCachedDatasetPeople ----

test('readCachedDatasetPeople: real fixture — the actual cached session-1608 archive decodes to 189 people including the real Onder nickname record', async (t) => {
  const files = listCachedDatasetFiles(REAL_CACHE_DIR).filter((f) => f.includes('1608-'));
  if (files.length === 0) {
    t.skip('real legiscan-datasets cache not present locally (gitignored, expected on a fresh clone)');
    return;
  }
  assert.equal(files.length, 1, 'session 1608 (2018 2nd Special Session) is one of the 31 cached datasets');
  const decoded = await readCachedDatasetPeople(files[0]);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.sessionId, 1608);
  assert.equal(decoded.people.length, 189);
  const onder = decoded.people.find((p) => p.last_name === 'Onder');
  assert.equal(onder.people_id, 16351);
  assert.equal(onder.first_name, 'Robert');
  assert.equal(onder.nickname, 'Bob');
});

test('readCachedDatasetPeople: a nonexistent file path is honestly reported ok:false, never throws', async () => {
  const decoded = await readCachedDatasetPeople('.superpowers/artifacts/legiscan-datasets/does-not-exist.json');
  assert.deepEqual(decoded, { ok: false, filePath: '.superpowers/artifacts/legiscan-datasets/does-not-exist.json' });
});

test('readCachedDatasetPeople: malformed JSON on disk is honestly reported ok:false, never throws', async () => {
  await withScratchDirAsync(async (dir) => {
    const filePath = join(dir, 'bad.json');
    writeFileSync(filePath, '{not valid json');
    const decoded = await readCachedDatasetPeople(filePath);
    assert.deepEqual(decoded, { ok: false, filePath });
  });
});

test('readCachedDatasetPeople: valid JSON but an undecodable/garbage zip field is honestly reported ok:false, never throws', async () => {
  await withScratchDirAsync(async (dir) => {
    const filePath = join(dir, 'garbage-zip.json');
    writeFileSync(filePath, JSON.stringify({ session_id: 999, zip: Buffer.from('not a real zip').toString('base64') }));
    const decoded = await readCachedDatasetPeople(filePath);
    assert.deepEqual(decoded, { ok: false, filePath });
  });
});

test('readCachedDatasetPeople: an injected readFileFn that throws is honestly reported ok:false', async () => {
  const decoded = await readCachedDatasetPeople('anything.json', {
    readFileFn: () => { throw new Error('disk error'); },
  });
  assert.deepEqual(decoded, { ok: false, filePath: 'anything.json' });
});

// ---- fake Supabase-shaped client (legislators table only: select/eq/maybeSingle + update/eq) ----

function isMissingColumnShapedError(column) {
  return { code: 'PGRST204', message: `Could not find the '${column}' column of 'legislators' in the schema cache` };
}

function makeFakeClient({ legislatorRows = [], forceMissingNicknameColumn = false } = {}) {
  const state = { legislators: legislatorRows.map((r) => ({ ...r })) };
  const calls = [];
  return {
    calls,
    state,
    from(table) {
      if (table !== 'legislators') throw new Error(`fake client: unexpected table "${table}"`);
      return {
        select() {
          return {
            eq: (col, val) => ({
              maybeSingle: async () => {
                calls.push({
                  op: 'select', col, val,
                });
                if (forceMissingNicknameColumn) {
                  return { data: null, error: isMissingColumnShapedError('nickname') };
                }
                const row = state.legislators.find((r) => r[col] === val);
                return { data: row ? { ...row } : null, error: null };
              },
            }),
          };
        },
        update(patch) {
          return {
            eq: async (col, val) => {
              calls.push({
                op: 'update', patch, col, val,
              });
              if (forceMissingNicknameColumn) return { error: isMissingColumnShapedError('nickname') };
              const found = state.legislators.find((r) => r[col] === val);
              if (found) Object.assign(found, patch);
              return { error: null };
            },
          };
        },
      };
    },
  };
}

// ---- resolveNicknamePatch ----

test('resolveNicknamePatch: an exact legiscan_people_id match with nickname currently null -> would_patch, carrying the additive patch payload', async () => {
  const client = makeFakeClient({ legislatorRows: [{ id: 'leg-onder', legiscan_people_id: 16351, nickname: null }] });
  const result = await resolveNicknamePatch(client, 16351, 'Bob');
  assert.deepEqual(result, { outcome: 'would_patch', legislatorId: 'leg-onder', patch: { nickname: 'Bob' } });
});

test('resolveNicknamePatch: nickname already set on the matched row -> already_set, NEVER overwritten (additive-only)', async () => {
  const client = makeFakeClient({ legislatorRows: [{ id: 'leg-onder', legiscan_people_id: 16351, nickname: 'Bobby' }] });
  const result = await resolveNicknamePatch(client, 16351, 'Bob');
  assert.deepEqual(result, { outcome: 'already_set', legislatorId: 'leg-onder' });
});

test('resolveNicknamePatch: no legislators row carries this legiscan_people_id -> no_matching_row, never guessed via name matching', async () => {
  const client = makeFakeClient({ legislatorRows: [{ id: 'leg-other', legiscan_people_id: 1, nickname: null }] });
  const result = await resolveNicknamePatch(client, 16351, 'Bob');
  assert.deepEqual(result, { outcome: 'no_matching_row' });
});

test('resolveNicknamePatch: migration 0013 unapplied (missing "nickname" column) -> gated, never thrown', async () => {
  const client = makeFakeClient({ forceMissingNicknameColumn: true });
  const result = await resolveNicknamePatch(client, 16351, 'Bob');
  assert.deepEqual(result, { outcome: 'gated' });
});

test('resolveNicknamePatch: an unrelated DB error is thrown, never silently swallowed', async () => {
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: { code: '500', message: 'connection reset' } }),
        }),
      }),
    }),
  };
  await assert.rejects(() => resolveNicknamePatch(client, 16351, 'Bob'), /connection reset/);
});

// ---- runBackfillNicknames: orchestration ----

function fakeDataset({ sessionId, people }) {
  return { ok: true, sessionId, people };
}

test('runBackfillNicknames: --dry-run performs zero writes — patched stays 0, plan carries what WOULD be patched, gated/noMatchingRow/cacheMissing are honestly computed via read-only lookups', async () => {
  const files = ['a.json', 'b.json', 'missing.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async (filePath) => {
    if (filePath === 'a.json') {
      return fakeDataset({
        sessionId: 1608,
        people: [
          {
            people_id: 16351, first_name: 'Robert', last_name: 'Onder', nickname: 'Bob',
          },
          { people_id: 999, first_name: 'Ghost', last_name: 'NoRow', nickname: 'Casper' }, // no matching legislators row
          { people_id: 1, first_name: 'Jane', last_name: 'Smith', nickname: '' }, // no nickname at all -> not withNickname
        ],
      });
    }
    if (filePath === 'b.json') {
      return fakeDataset({
        sessionId: 1579,
        people: [
          {
            people_id: 16351, first_name: 'Robert', last_name: 'Onder', nickname: 'Bob',
          }, // same real person, a second session — should also resolve to would_patch again (dry-run never writes, so this row's nickname is STILL null on this read)
        ],
      });
    }
    return { ok: false, filePath }; // missing.json
  };
  const client = makeFakeClient({ legislatorRows: [{ id: 'leg-onder', legiscan_people_id: 16351, nickname: null }] });

  const report = await runBackfillNicknames(client, {
    dryRun: true, listFilesFn, readDatasetFn,
  });

  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.counts, {
    peopleSeen: 4, withNickname: 3, patched: 0, gated: 0, noMatchingRow: 1, cacheMissing: 1,
  });
  assert.equal(report.cacheFilesFound, 3);
  assert.deepEqual(report.sessionsSeen.sort(), [1579, 1608]);
  assert.equal(report.plan.length, 2, 'both sessions\' Onder record would be patched (dry-run never writes, so the row never actually gains a nickname mid-run)');
  assert.ok(report.plan.every((p) => p.legiscanPeopleId === 16351 && p.nickname === 'Bob'));
  const writeOps = client.calls.filter((c) => c.op === 'update');
  assert.deepEqual(writeOps, [], 'zero writes reachable from dry-run');
  assert.equal(client.state.legislators[0].nickname, null, 'unwritten');
});

test('runBackfillNicknames: live mode patches the real Onder row exactly ONCE across two sessions that both mention people_id 16351 — the second occurrence is additively a no-op (already_set), never double-counted or double-written', async () => {
  const files = ['a.json', 'b.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async (filePath) => {
    const people = [{
      people_id: 16351, first_name: 'Robert', last_name: 'Onder', nickname: 'Bob',
    }];
    return fakeDataset({ sessionId: filePath === 'a.json' ? 1608 : 1579, people });
  };
  const client = makeFakeClient({ legislatorRows: [{ id: 'leg-onder', legiscan_people_id: 16351, nickname: null }] });

  const report = await runBackfillNicknames(client, {
    dryRun: false, runId: 'run-1', listFilesFn, readDatasetFn,
  });

  assert.equal(report.mode, 'live');
  assert.deepEqual(report.counts, {
    peopleSeen: 2, withNickname: 2, patched: 1, gated: 0, noMatchingRow: 0, cacheMissing: 0,
  });
  assert.equal(report.plan, undefined, 'plan is a dry-run-only preview');
  assert.equal(client.state.legislators[0].nickname, 'Bob');
  const updateOps = client.calls.filter((c) => c.op === 'update');
  assert.equal(updateOps.length, 1, 'exactly one live UPDATE, not one per session mention');
  assert.equal(updateOps[0].patch.run_id, 'run-1', 'run_id is stamped on the write, same convention as every other additivePatch call site in this codebase');
});

test('runBackfillNicknames: migration 0013 unapplied — the FIRST candidate hits the gate, every remaining withNickname candidate (same file and later files) is counted gated WITHOUT a further live query', async () => {
  const files = ['a.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async () => fakeDataset({
    sessionId: 1608,
    people: [
      { people_id: 1, first_name: 'A', nickname: 'AA' },
      { people_id: 2, first_name: 'B', nickname: 'BB' },
      { people_id: 3, first_name: 'C', nickname: 'CC' },
    ],
  });
  const client = makeFakeClient({ forceMissingNicknameColumn: true });

  const report = await runBackfillNicknames(client, {
    dryRun: false, runId: 'run-1', listFilesFn, readDatasetFn,
  });

  assert.deepEqual(report.counts, {
    peopleSeen: 3, withNickname: 3, patched: 0, gated: 3, noMatchingRow: 0, cacheMissing: 0,
  });
  const selectOps = client.calls.filter((c) => c.op === 'select');
  assert.equal(selectOps.length, 1, 'only ONE live lookup was attempted before the gate short-circuited the rest');
});

test('runBackfillNicknames: a missing/corrupt cache file is skipped with an honest cacheMissing count — the OTHER 30 real sessions still process (skip != empty)', async () => {
  const files = ['good.json', 'bad.json'];
  const listFilesFn = () => files;
  const readDatasetFn = async (filePath) => {
    if (filePath === 'good.json') {
      return fakeDataset({
        sessionId: 1608,
        people: [{
          people_id: 16351, first_name: 'Robert', last_name: 'Onder', nickname: 'Bob',
        }],
      });
    }
    return { ok: false, filePath };
  };
  const client = makeFakeClient({ legislatorRows: [{ id: 'leg-onder', legiscan_people_id: 16351, nickname: null }] });

  const report = await runBackfillNicknames(client, {
    dryRun: false, runId: 'run-1', listFilesFn, readDatasetFn,
  });

  assert.deepEqual(report.counts, {
    peopleSeen: 1, withNickname: 1, patched: 1, gated: 0, noMatchingRow: 0, cacheMissing: 1,
  });
});

test('runBackfillNicknames: zero cache files found (cache dir missing/empty) -> all-zero counts, no client calls at all, never fetches', async () => {
  const client = makeFakeClient();
  const report = await runBackfillNicknames(client, { dryRun: false, listFilesFn: () => [] });
  assert.deepEqual(report.counts, {
    peopleSeen: 0, withNickname: 0, patched: 0, gated: 0, noMatchingRow: 0, cacheMissing: 0,
  });
  assert.equal(report.cacheFilesFound, 0);
  assert.deepEqual(client.calls, []);
});

// ---- real end-to-end file decode (no live DB — a fake client that never matches anything, just
// proving the FILE side of the pipeline is correct against the actual 31 cached archives) ----

test('runBackfillNicknames: real cache dir end-to-end file decode — peopleSeen/withNickname are computed from the actual 31 cached archives, zero API queries, zero writes (no legislators row ever matches this fake, empty roster)', async (t) => {
  if (listCachedDatasetFiles(REAL_CACHE_DIR).length === 0) {
    t.skip('real legiscan-datasets cache not present locally (gitignored, expected on a fresh clone)');
    return;
  }
  const client = makeFakeClient({ legislatorRows: [] });
  const report = await runBackfillNicknames(client, { dryRun: false, cacheDir: REAL_CACHE_DIR });
  // Not hardcoded to a fixed file count — LegiScan datasets refresh weekly and this real cache dir
  // grows over time (32 as of 2026-08-03, up from 31 at task-writing time).
  assert.equal(report.cacheFilesFound, listCachedDatasetFiles(REAL_CACHE_DIR).length);
  assert.equal(report.counts.cacheMissing, 0, 'every real cache file decodes cleanly');
  assert.ok(report.counts.peopleSeen > 0);
  assert.ok(report.counts.withNickname > 0, 'the real dataset ZIPs really do contain nickname-bearing records (e.g. Onder)');
  assert.equal(report.counts.patched, 0, 'empty fake legislators roster: nothing to match, so nothing written');
  assert.equal(report.counts.noMatchingRow, report.counts.withNickname);
});
