import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {
  parseArgs, isLockStale, acquireLock, releaseLock,
  computeSourceDueness, pickMostOverdue,
  parseUsHouseRoll, computeRollWindow,
  parseChildOutput, runWroteSomething,
  queryLatestStartedAt, resolveLegiscanSessionId, resolveUsCongressRollWindow, buildRegistry,
  runChildCli, envIntervalMs,
  MAX_RUN_DURATION_MS, US_CONGRESS_CONGRESS, US_CONGRESS_ROLL_WINDOW,
} from '../scripts/scheduled-ingest.js';
import { MO_SENATE_MIN_INTERVAL_MS } from '../src/adapters/mo-senate-web.js';
import { MO_HOUSE_MIN_INTERVAL_MS, DEFAULT_MO_HOUSE_SESSION } from '../src/adapters/mo-house-xml.js';

// ---- parseArgs ----

test('parseArgs defaults to live, no --only', () => {
  const out = parseArgs([]);
  assert.equal(out.dryRun, false);
  assert.equal(out.only, null);
});

test('parseArgs accepts --dry-run and --only <source>', () => {
  const out = parseArgs(['--dry-run', '--only', 'mo-senate-web']);
  assert.equal(out.dryRun, true);
  assert.equal(out.only, 'mo-senate-web');
});

test('parseArgs rejects an unknown --only value (never silently runs the wrong source)', () => {
  assert.throws(() => parseArgs(['--only', 'bogus-source']), /unknown source/);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--wat']), /unknown flag/);
});

// ---- envIntervalMs: the mechanical floor behind US_CONGRESS_MIN_INTERVAL_MS/LEGISCAN_MIN_INTERVAL_MS ----

test('envIntervalMs floors a configured value at the minimum, never letting it go lower', () => {
  assert.equal(envIntervalMs('__NOPE__', 1000, 5000), 5000, 'unset env falls back to default, then floored');
  assert.equal(envIntervalMs('__NOPE__', 10000, 5000), 10000, 'unset env default above floor is kept');
});

// ---- isLockStale / acquireLock / releaseLock — single-instance lock discipline ----

test('isLockStale: false when within the max run duration, true once past it', () => {
  const now = Date.parse('2026-07-31T12:10:00.000Z');
  const lock = { startedAt: '2026-07-31T12:00:00.000Z', pid: 123 };
  assert.equal(isLockStale(lock, now, 20 * 60 * 1000), false); // 10 min elapsed, 20 min ceiling
  assert.equal(isLockStale(lock, now, 5 * 60 * 1000), true); // 10 min elapsed, 5 min ceiling
});

test('isLockStale: an unparseable startedAt is treated as stale, not trusted', () => {
  assert.equal(isLockStale({ startedAt: 'not-a-date' }, Date.now(), MAX_RUN_DURATION_MS), true);
});

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vg-scheduler-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('acquireLock: fresh lock succeeds and writes pid+timestamp; a second attempt while it is live is refused', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'nested', 'scheduler.lock.json');
    const first = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
    assert.equal(first.acquired, true);
    assert.equal(first.reason, 'fresh');
    assert.ok(existsSync(lockPath));
    const written = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(written.pid, process.pid);
    assert.equal(written.startedAt, '2026-07-31T12:00:00.000Z');

    // Second attempt 1 minute later, well within MAX_RUN_DURATION_MS — must be refused, never
    // silently proceed (this is the exact "no stacked overlapping processes" guarantee).
    const second = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:01:00.000Z') });
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'already-running');
    assert.equal(second.lock.pid, process.pid);
  });
});

test('acquireLock: a lock older than the max run duration is reclaimed, not trusted forever', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });

    const muchLater = Date.parse('2026-07-31T12:00:00.000Z') + MAX_RUN_DURATION_MS + 1;
    const reclaimed = acquireLock(lockPath, { now: muchLater });
    assert.equal(reclaimed.acquired, true);
    assert.equal(reclaimed.reason, 'reclaimed-stale');
    assert.ok(reclaimed.staleLock, 'the reclaimed lock\'s own prior contents are surfaced for the warning log');
  });
});

test('acquireLock: a corrupt/unreadable lock file is treated as stale and reclaimed, never crashes', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, 'not json{{{');
    const result = acquireLock(lockPath, { now: Date.now() });
    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'reclaimed-stale');
  });
});

test('releaseLock: deletes an existing lock file, and is a safe no-op when nothing is there', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    acquireLock(lockPath, { now: Date.now() });
    assert.ok(existsSync(lockPath));
    releaseLock(lockPath);
    assert.ok(!existsSync(lockPath));
    assert.doesNotThrow(() => releaseLock(lockPath)); // already gone — must not throw
  });
});

// ---- computeSourceDueness / pickMostOverdue ----

test('computeSourceDueness: never-run source (lastStartedAtIso null) is due, with infinite elapsed', () => {
  const now = Date.now();
  const e = computeSourceDueness({ key: 'x', minIntervalMs: 1000, lastStartedAtIso: null }, now);
  assert.equal(e.due, true);
  assert.equal(e.remainingMs, 0);
  assert.equal(e.elapsedMs, Infinity);
});

test('computeSourceDueness: recently-run source is not due; remainingMs matches remainingCooldownMs\'s own arithmetic', () => {
  const now = Date.parse('2026-07-31T12:30:00.000Z');
  const e = computeSourceDueness({ key: 'x', minIntervalMs: 30 * 60 * 1000, lastStartedAtIso: '2026-07-31T12:20:00.000Z' }, now);
  assert.equal(e.due, false);
  assert.equal(e.remainingMs, 20 * 60 * 1000); // 30 min interval - 10 min elapsed
  assert.equal(e.elapsedMs, 10 * 60 * 1000);
});

test('computeSourceDueness: a source whose cooldown has fully elapsed is due', () => {
  const now = Date.parse('2026-07-31T13:00:00.000Z');
  const e = computeSourceDueness({ key: 'x', minIntervalMs: 30 * 60 * 1000, lastStartedAtIso: '2026-07-31T12:00:00.000Z' }, now);
  assert.equal(e.due, true);
  assert.equal(e.remainingMs, 0);
});

test('pickMostOverdue: chooses the due source with the longest elapsed time, never a not-due one', () => {
  const entries = [
    { key: 'a', due: true, resolvable: true, elapsedMs: 1000 },
    { key: 'b', due: true, resolvable: true, elapsedMs: 5000 },
    { key: 'c', due: false, resolvable: true, elapsedMs: 999999 }, // not due — must never win despite huge elapsed
  ];
  assert.equal(pickMostOverdue(entries).key, 'b');
});

test('pickMostOverdue: an unresolvable source (e.g. legiscan with no session id) is never chosen even if due and most overdue', () => {
  const entries = [
    { key: 'a', due: true, resolvable: true, elapsedMs: 10 },
    { key: 'legiscan', due: true, resolvable: false, elapsedMs: Infinity },
  ];
  assert.equal(pickMostOverdue(entries).key, 'a');
});

test('pickMostOverdue: null when nothing is due', () => {
  const entries = [{ key: 'a', due: false, resolvable: true, elapsedMs: 10 }];
  assert.equal(pickMostOverdue(entries), null);
});

test('pickMostOverdue: a source that has never run (Infinity elapsed) outranks every source with a real timestamp', () => {
  const entries = [
    { key: 'seen', due: true, resolvable: true, elapsedMs: 99 * 24 * 60 * 60 * 1000 },
    { key: 'never', due: true, resolvable: true, elapsedMs: Infinity },
  ];
  assert.equal(pickMostOverdue(entries).key, 'never');
});

// ---- parseUsHouseRoll / computeRollWindow ----

test('parseUsHouseRoll extracts the trailing roll number from a us-house source_key', () => {
  assert.equal(parseUsHouseRoll('us-house-119-2026-350'), 350);
  assert.equal(parseUsHouseRoll('us-house-119-2026-7'), 7);
});

test('parseUsHouseRoll returns null for anything that isn\'t that exact shape (never a false roll number)', () => {
  assert.equal(parseUsHouseRoll('us-senate-119-1-616'), null);
  assert.equal(parseUsHouseRoll(''), null);
  assert.equal(parseUsHouseRoll(null), null);
  assert.equal(parseUsHouseRoll(undefined), null);
});

test('computeRollWindow: starts one past the max known roll, spans windowSize', () => {
  assert.deepEqual(computeRollWindow(350, 10), { lo: 351, hi: 360 });
});

test('computeRollWindow: zero/no prior rolls on file starts the window at roll 1', () => {
  assert.deepEqual(computeRollWindow(0, 10), { lo: 1, hi: 10 });
  assert.deepEqual(computeRollWindow(undefined, 10), { lo: 1, hi: 10 });
});

test('computeRollWindow defaults windowSize to US_CONGRESS_ROLL_WINDOW', () => {
  assert.deepEqual(computeRollWindow(0), { lo: 1, hi: US_CONGRESS_ROLL_WINDOW });
});

// ---- parseChildOutput / runWroteSomething ----

test('parseChildOutput parses a CLI\'s pretty-printed JSON.stringify(..., null, 2) stdout', () => {
  const stdout = JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 3 } }, null, 2);
  const { parsed, parseError } = parseChildOutput(stdout);
  assert.equal(parseError, null);
  assert.equal(parsed.mode, 'live');
  assert.equal(parsed.counts.votes, 3);
});

test('parseChildOutput reports a parse error instead of throwing on unparseable stdout', () => {
  const { parsed, parseError } = parseChildOutput('not json at all');
  assert.equal(parsed, null);
  assert.ok(parseError);
});

test('runWroteSomething: true only for a live run reporting succeeded/partial', () => {
  assert.equal(runWroteSomething({ mode: 'live', status: 'succeeded' }), true);
  assert.equal(runWroteSomething({ mode: 'live', status: 'partial' }), true);
});

test('runWroteSomething: false for blocked/dry-run modes, and for a null/unparsed result', () => {
  assert.equal(runWroteSomething({ mode: 'blocked', status: 'succeeded' }), false);
  assert.equal(runWroteSomething({ mode: 'dry-run' }), false);
  assert.equal(runWroteSomething(null), false);
  assert.equal(runWroteSomething(undefined), false);
});

test('runWroteSomething: false for a live run whose status is neither succeeded nor partial', () => {
  assert.equal(runWroteSomething({ mode: 'live', status: 'failed' }), false);
});

// ---- DB-facing helpers: fakeClient (same shape as summarize-cli.test.js's own fakeClient) ----

function fakeQuery(result) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    like: () => builder,
    order: () => builder,
    limit: () => builder,
    range: () => builder,
    maybeSingle: () => builder,
    single: () => builder,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function fakeClient(resultsByTable) {
  return { from: (table) => fakeQuery(resultsByTable[table] ?? { data: null, error: null }) };
}

test('queryLatestStartedAt returns the latest started_at for the given source, null when none exists', async () => {
  const client = fakeClient({ ingestion_runs: { data: { started_at: '2026-07-31T10:00:00.000Z' }, error: null } });
  assert.equal(await queryLatestStartedAt(client, 'mo-senate-web'), '2026-07-31T10:00:00.000Z');

  const emptyClient = fakeClient({ ingestion_runs: { data: null, error: null } });
  assert.equal(await queryLatestStartedAt(emptyClient, 'mo-senate-web'), null);
});

test('queryLatestStartedAt throws a plain descriptive Error on a real lookup failure (never silently swallowed)', async () => {
  const client = fakeClient({ ingestion_runs: { data: null, error: { message: 'boom' } } });
  await assert.rejects(() => queryLatestStartedAt(client, 'legiscan'), /ingestion_runs lookup failed.*legiscan.*boom/s);
});

test('resolveLegiscanSessionId returns the current MO session\'s legiscan_session_id when on file', async () => {
  const client = fakeClient({ sessions: { data: { legiscan_session_id: 2239 }, error: null } });
  assert.equal(await resolveLegiscanSessionId(client), 2239);
});

test('resolveLegiscanSessionId returns null (never guesses) when the session row or its legiscan_session_id is missing', async () => {
  const missingRow = fakeClient({ sessions: { data: null, error: null } });
  assert.equal(await resolveLegiscanSessionId(missingRow), null);

  const nullColumn = fakeClient({ sessions: { data: { legiscan_session_id: null }, error: null } });
  assert.equal(await resolveLegiscanSessionId(nullColumn), null);
});

test('resolveUsCongressRollWindow computes the window from the max roll number found in votes.source_key', async () => {
  const client = fakeClient({
    votes: {
      data: [
        { source_key: 'us-house-119-2026-40' },
        { source_key: 'us-house-119-2026-355' },
        { source_key: 'us-house-119-2026-12' },
      ],
      error: null,
    },
  });
  const window = await resolveUsCongressRollWindow(client, { congress: 119, year: 2026, windowSize: 10 });
  assert.deepEqual(window, { lo: 356, hi: 365 });
});

test('resolveUsCongressRollWindow starts at roll 1 when nothing is on file yet for this congress/year', async () => {
  const client = fakeClient({ votes: { data: [], error: null } });
  const window = await resolveUsCongressRollWindow(client, { congress: 119, year: 2026, windowSize: 10 });
  assert.deepEqual(window, { lo: 1, hi: 10 });
});

// ---- buildRegistry: the full four-source registry, with the TODO-31 mo-house-xml restriction and
// the legiscan fail-safe both structurally verified, not just documented ----

function fakeRegistryClient({ legiscanSessionId = 2239, votesRows = [], lastStartedAtBySource = {} } = {}) {
  return {
    from(table) {
      if (table === 'ingestion_runs') {
        // Own closure variable per .from('ingestion_runs') call (queryLatestStartedAt makes one
        // fresh call per source) — NOT `this` inside arrow functions, which would capture the
        // outer fakeRegistryClient object instead of this inner chainable builder.
        let sourceFilter = null;
        const builder = {
          select: () => builder,
          eq: (col, val) => { sourceFilter = val; return builder; },
          order: () => builder,
          limit: () => builder,
          maybeSingle: () => builder,
          then: (resolve, reject) => {
            const started = lastStartedAtBySource[sourceFilter] ?? null;
            return Promise.resolve({ data: started ? { started_at: started } : null, error: null }).then(resolve, reject);
          },
        };
        return builder;
      }
      if (table === 'sessions') {
        return fakeQuery({
          data: legiscanSessionId != null ? { legiscan_session_id: legiscanSessionId } : null,
          error: null,
        });
      }
      if (table === 'votes') {
        return fakeQuery({ data: votesRows, error: null });
      }
      return fakeQuery({ data: null, error: null });
    },
  };
}

test('buildRegistry: all four sources, correct scripts + static args, legiscan resolved', async () => {
  const client = fakeRegistryClient({ legiscanSessionId: 2239 });
  const registry = await buildRegistry(client, { now: Date.parse('2026-07-31T12:00:00.000Z'), year: 2026 });

  assert.equal(registry.length, 4);
  const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));

  assert.equal(byKey['mo-senate-web'].minIntervalMs, MO_SENATE_MIN_INTERVAL_MS);
  assert.equal(byKey['mo-senate-web'].scriptPath, 'src/cli/ingest-mo-senate.js');
  assert.deepEqual(byKey['mo-senate-web'].cliArgs, ['--year', '2026', '--limit', '1']);
  assert.equal(byKey['mo-senate-web'].resolvable, true);

  assert.equal(byKey['mo-house-xml'].minIntervalMs, MO_HOUSE_MIN_INTERVAL_MS);
  assert.equal(byKey['mo-house-xml'].scriptPath, 'src/cli/ingest-mo-house.js');
  assert.deepEqual(byKey['mo-house-xml'].cliArgs, ['--limit', '1']);

  assert.equal(byKey['us-congress'].scriptPath, 'src/cli/ingest.js');
  assert.deepEqual(byKey['us-congress'].cliArgs, ['--source', 'us-congress', '--year', '2026', '--rolls', '1-10']);

  assert.equal(byKey.legiscan.scriptPath, 'src/cli/ingest-legiscan.js');
  assert.deepEqual(byKey.legiscan.cliArgs, ['--session', '2239']);
  assert.equal(byKey.legiscan.resolvable, true);
});

test('buildRegistry: TODO-31 restriction — mo-house-xml args NEVER include --session, regardless of anything else', async () => {
  const client = fakeRegistryClient({});
  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
  const house = registry.find((e) => e.key === 'mo-house-xml');
  assert.ok(!house.cliArgs.includes('--session'), 'mo-house-xml must never receive a --session flag from the scheduler');
});

test('buildRegistry: legiscan with no legiscan_session_id on file is marked unresolvable and gets an honest reason, never a guessed session', async () => {
  const client = fakeRegistryClient({ legiscanSessionId: null });
  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
  const legiscan = registry.find((e) => e.key === 'legiscan');
  assert.equal(legiscan.resolvable, false);
  assert.ok(legiscan.unresolvedReason, 'must explain WHY it is skipped');
  assert.deepEqual(legiscan.cliArgs, []);
});

test('buildRegistry: every source\'s lastStartedAtIso reflects ingestion_runs, per source', async () => {
  const client = fakeRegistryClient({
    lastStartedAtBySource: {
      'mo-senate-web': '2026-07-31T11:00:00.000Z',
      'mo-house-xml': '2026-07-31T11:29:00.000Z',
    },
  });
  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
  const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));
  assert.equal(byKey['mo-senate-web'].lastStartedAtIso, '2026-07-31T11:00:00.000Z');
  assert.equal(byKey['mo-house-xml'].lastStartedAtIso, '2026-07-31T11:29:00.000Z');
  assert.equal(byKey['us-congress'].lastStartedAtIso, null);
});

// ---- runChildCli: process orchestration, spawnFn injectable so no real subprocess in most tests ----

test('runChildCli: parses a faked child\'s stdout and passes through its exit status', () => {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 1 } }), stderr: '' };
  };
  const result = runChildCli('src/cli/ingest-mo-senate.js', ['--year', '2026', '--limit', '1'], { cwd: '/repo', spawnFn });
  assert.equal(result.exitStatus, 0);
  assert.equal(result.parsed.status, 'succeeded');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ['--env-file=.env', 'src/cli/ingest-mo-senate.js', '--year', '2026', '--limit', '1']);
  assert.equal(calls[0].options.cwd, '/repo');
});

test('runChildCli: a non-zero exit (typed CLI failures) is reported, never thrown — "never crashes the scheduler run"', () => {
  const spawnFn = () => ({ status: 2, stdout: JSON.stringify({ mode: 'live', status: 'partial', counts: {}, failures: [{ message: 'x' }] }), stderr: '' });
  const result = runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn });
  assert.equal(result.exitStatus, 2);
  assert.equal(result.parsed.status, 'partial');
});

test('runChildCli: a genuine launch failure (spawnFn returns .error) throws — this IS a real scheduler-level error', () => {
  const spawnFn = () => ({ error: new Error('ENOENT'), status: null, stdout: '', stderr: '' });
  assert.throws(() => runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn }), /could not launch/);
});

// Real subprocess smoke test (no network, no DB) — proves the actual `node --env-file=.env <path>
// <args>` spawn plumbing runChildCli builds works end to end, not just the fake spawnFn used
// everywhere else above. Runs from its own temp dir with a throwaway .env — real .env is
// gitignored (never present on a fresh checkout), so this must not depend on the repo's own copy.
test('runChildCli: real subprocess smoke test (no network, no DB) — proves the actual spawn plumbing works, not just the fake', () => {
  withTmpDir((dir) => {
    writeFileSync(path.join(dir, '.env'), 'SCHEDULED_INGEST_SMOKE_TEST=1\n');
    const scriptPath = path.join(dir, 'fake-cli.js');
    writeFileSync(scriptPath, "console.log(JSON.stringify({mode:'live',status:'succeeded',counts:{x:1}}));\n");

    const result = runChildCli(
      'fake-cli.js',
      [],
      { cwd: dir, spawnFn: (command, args, options) => spawnSync(command, args, { encoding: 'utf8', ...options }) },
    );
    assert.equal(result.exitStatus, 0);
    assert.equal(result.parsed.mode, 'live');
    assert.equal(result.parsed.counts.x, 1);
  });
});
