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
  parseUsHouseRoll, parseUsSenateVote, computeRollWindow,
  isExpectedTailProbeOutcome, countsShowRowsWritten,
  parseChildOutput,
  queryLatestStartedAt, queryLatestRun,
  resolveLegiscanSessionId, resolveUsCongressRollWindow, resolveUsSenateVoteWindow, buildRegistry,
  runChildCli, recordSchedulerAttemptFailure, runChosenSource,
  getSchedulerClient, envIntervalMs,
  MAX_RUN_DURATION_MS, CHILD_TIMEOUT_MS, CHILD_MAX_BUFFER,
  US_CONGRESS_CONGRESS, US_CONGRESS_ROLL_WINDOW, US_SENATE_SESSION, US_SENATE_VOTE_WINDOW,
} from '../scripts/scheduled-ingest.js';
import { MO_SENATE_MIN_INTERVAL_MS } from '../src/adapters/mo-senate-web.js';
import { MO_HOUSE_MIN_INTERVAL_MS, DEFAULT_MO_HOUSE_SESSION } from '../src/adapters/mo-house-xml.js';

// ---- parseArgs ----

test('parseArgs defaults to live, no --only', () => {
  const out = parseArgs([]);
  assert.equal(out.dryRun, false);
  assert.equal(out.only, null);
});

test('parseArgs accepts --dry-run and --only <source>, including the new us-senate source', () => {
  assert.equal(parseArgs(['--dry-run', '--only', 'mo-senate-web']).only, 'mo-senate-web');
  assert.equal(parseArgs(['--only', 'us-senate']).only, 'us-senate');
});

test('parseArgs rejects an unknown --only value (never silently runs the wrong source)', () => {
  assert.throws(() => parseArgs(['--only', 'bogus-source']), /unknown source/);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--wat']), /unknown flag/);
});

// ---- envIntervalMs: the mechanical floor behind US_CONGRESS_MIN_INTERVAL_MS/US_SENATE_MIN_INTERVAL_MS/LEGISCAN_MIN_INTERVAL_MS ----

test('envIntervalMs floors a configured value at the minimum, never letting it go lower', () => {
  assert.equal(envIntervalMs('__NOPE__', 1000, 5000), 5000, 'unset env falls back to default, then floored');
  assert.equal(envIntervalMs('__NOPE__', 10000, 5000), 10000, 'unset env default above floor is kept');
});

// ---- isLockStale / acquireLock / releaseLock — single-instance lock discipline, ownership-checked (I1) ----

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

test('acquireLock: fresh lock succeeds, writes pid+timestamp+nonce; a second attempt while it is live is refused', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'nested', 'scheduler.lock.json');
    const first = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
    assert.equal(first.acquired, true);
    assert.equal(first.reason, 'fresh');
    assert.ok(first.nonce, 'a fresh lock must carry a nonce for I1\'s ownership check');
    assert.ok(existsSync(lockPath));
    const written = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(written.pid, process.pid);
    assert.equal(written.startedAt, '2026-07-31T12:00:00.000Z');
    assert.equal(written.nonce, first.nonce);

    const second = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:01:00.000Z') });
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'already-running');
    assert.equal(second.lock.pid, process.pid);
  });
});

test('acquireLock: a lock older than the max run duration is reclaimed, not trusted forever, and gets a FRESH nonce', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    const first = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });

    const muchLater = Date.parse('2026-07-31T12:00:00.000Z') + MAX_RUN_DURATION_MS + 1;
    const reclaimed = acquireLock(lockPath, { now: muchLater });
    assert.equal(reclaimed.acquired, true);
    assert.equal(reclaimed.reason, 'reclaimed-stale');
    assert.ok(reclaimed.staleLock, 'the reclaimed lock\'s own prior contents are surfaced for the warning log');
    assert.notEqual(reclaimed.nonce, first.nonce, 'a reclaimed lock must not reuse the stale owner\'s nonce');
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

test('releaseLock: deletes an existing lock file when the nonce matches, and is a safe no-op when nothing is there', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    const lock = acquireLock(lockPath, { now: Date.now() });
    assert.ok(existsSync(lockPath));
    releaseLock(lockPath, lock.nonce);
    assert.ok(!existsSync(lockPath));
    assert.doesNotThrow(() => releaseLock(lockPath, lock.nonce)); // already gone — must not throw
  });
});

// ---- I1 (fix round 1) red-first: a slow run must never delete a NEWER tick's reclaimed lock ----

test('I1: releaseLock only deletes when the nonce matches — a late release from a reclaimed-away lock is a safe no-op, never deletes the newer owner\'s lock', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    const tickA = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
    assert.equal(tickA.acquired, true);

    // Tick A's child hangs past MAX_RUN_DURATION_MS; tick B reclaims the now-stale lock.
    const muchLater = Date.parse('2026-07-31T12:00:00.000Z') + MAX_RUN_DURATION_MS + 1;
    const tickB = acquireLock(lockPath, { now: muchLater });
    assert.equal(tickB.acquired, true);
    assert.notEqual(tickB.nonce, tickA.nonce);

    // Tick A finally "returns" and its finally-block releases with ITS OWN (now-stale) nonce —
    // must NOT delete tick B's live lock. This is the exact defect: without the nonce check, this
    // unlinkSync would blindly remove whatever file is at lockPath, which is now tick B's.
    releaseLock(lockPath, tickA.nonce);
    assert.ok(existsSync(lockPath), 'tick B\'s lock must survive tick A\'s late release');
    const stillThere = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(stillThere.nonce, tickB.nonce, 'the surviving lock must still be tick B\'s, unmodified');

    // Tick B's own release, with its own correct nonce, DOES work.
    releaseLock(lockPath, tickB.nonce);
    assert.ok(!existsSync(lockPath));
  });
});

test('I1: releaseLock with no nonce (or the wrong nonce) never deletes anything', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    acquireLock(lockPath, { now: Date.now() });
    releaseLock(lockPath, null);
    assert.ok(existsSync(lockPath));
    releaseLock(lockPath); // no second arg at all
    assert.ok(existsSync(lockPath));
    releaseLock(lockPath, 'totally-wrong-nonce');
    assert.ok(existsSync(lockPath));
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
  assert.equal(e.remainingMs, 20 * 60 * 1000);
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
    { key: 'c', due: false, resolvable: true, elapsedMs: 999999 },
  ];
  assert.equal(pickMostOverdue(entries).key, 'b');
});

test('pickMostOverdue: an unresolvable source (e.g. legiscan with no session id, or a failed lookup) is never chosen even if due and most overdue', () => {
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

// ---- parseUsHouseRoll / parseUsSenateVote / computeRollWindow ----

test('parseUsHouseRoll extracts the trailing roll number from a us-house source_key', () => {
  assert.equal(parseUsHouseRoll('us-house-119-2026-350'), 350);
  assert.equal(parseUsHouseRoll('us-house-119-2026-7'), 7);
});

test('parseUsHouseRoll returns null for anything that isn\'t that exact shape', () => {
  assert.equal(parseUsHouseRoll('us-senate-119-1-616'), null);
  assert.equal(parseUsHouseRoll(''), null);
  assert.equal(parseUsHouseRoll(null), null);
  assert.equal(parseUsHouseRoll(undefined), null);
});

test('parseUsSenateVote extracts the trailing vote number from a us-senate source_key (I5)', () => {
  assert.equal(parseUsSenateVote('us-senate-119-2-661'), 661);
  assert.equal(parseUsSenateVote('us-senate-119-1-1'), 1);
});

test('parseUsSenateVote returns null for a us-house key or anything else', () => {
  assert.equal(parseUsSenateVote('us-house-119-2026-350'), null);
  assert.equal(parseUsSenateVote(''), null);
  assert.equal(parseUsSenateVote(null), null);
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

// ---- I4a (fix round 1) red-first: isExpectedTailProbeOutcome ----

test('isExpectedTailProbeOutcome: true when every failure is a roll/vote strictly past the window edge', () => {
  assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 291' }, { step: 'roll 292' }], 283), true);
  assert.equal(isExpectedTailProbeOutcome('us-senate', [{ step: 'vote 661' }], 660), true);
});

test('isExpectedTailProbeOutcome: false when a failure is NOT a roll/vote step (e.g. a bill-detail failure) — a real regression, not overshoot', () => {
  assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 291' }, { step: 'bill HR 1' }], 283), false);
});

test('isExpectedTailProbeOutcome: false when a roll/vote failure is AT OR BELOW the previously-known edge', () => {
  assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 283' }], 283), false);
  assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 200' }], 283), false);
});

test('isExpectedTailProbeOutcome: false for a non-windowed source, or when there are no failures to explain away', () => {
  assert.equal(isExpectedTailProbeOutcome('mo-senate-web', [{ step: 'roll 291' }], 283), false);
  assert.equal(isExpectedTailProbeOutcome('us-congress', [], 283), false);
  assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 291' }], undefined), false);
});

// ---- I4b (fix round 1) red-first: countsShowRowsWritten replaces the old mode/status heuristic ----

test('countsShowRowsWritten: mo-senate-web/us-congress/us-senate/legiscan all read detail.counts.votes', () => {
  assert.equal(countsShowRowsWritten('us-congress', { counts: { votes: 3 } }), true);
  assert.equal(countsShowRowsWritten('us-congress', { counts: { votes: 0 } }), false);
  assert.equal(countsShowRowsWritten('mo-senate-web', { counts: { votes: 1 } }), true);
  assert.equal(countsShowRowsWritten('us-senate', { counts: { votes: 2 } }), true);
  assert.equal(countsShowRowsWritten('legiscan', { counts: { votes: 5 } }), true);
});

test('countsShowRowsWritten: THE I4b REGRESSION CASE — a live/partial run whose probe window found nothing must read as "wrote nothing", not "wrote something"', () => {
  // This is exactly the shape a us-congress tick has on a typical hour: mode 'live', status
  // 'partial' (every probed roll 404d), counts.votes still 0. The OLD heuristic
  // (mode==='live' && status in succeeded/partial) returned true here — this must return false.
  assert.equal(countsShowRowsWritten('us-congress', { counts: { votes: 0, casts: 0, failures: 10 } }), false);
});

test('countsShowRowsWritten: mo-house-xml rollcall-pdf branch reads rollCallResult.castCount, a SIBLING of counts, not a field inside it', () => {
  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'rollcall-pdf' }, rollCallResult: { castCount: 5 } }), true);
  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'rollcall-pdf' }, rollCallResult: { castCount: 0 } }), false);
  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'rollcall-pdf' } }), false, 'missing rollCallResult must not throw or default to true');
});

test('countsShowRowsWritten: mo-house-xml bill-xml branch reads counts.bills_detailed', () => {
  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'bill-xml', bills_detailed: 2 } }), true);
  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'bill-xml', bills_detailed: 0 } }), false);
});

test('countsShowRowsWritten: a missing/empty detail never throws, reads as false', () => {
  assert.equal(countsShowRowsWritten('us-congress', {}), false);
  assert.equal(countsShowRowsWritten('us-congress', null), false);
  assert.equal(countsShowRowsWritten('mo-house-xml', {}), false);
});

// ---- parseChildOutput ----

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

test('queryLatestRun returns the full row (started_at, status, detail), null when none exists', async () => {
  const row = { started_at: '2026-07-31T10:00:00.000Z', status: 'succeeded', detail: { counts: { votes: 2 } } };
  const client = fakeClient({ ingestion_runs: { data: row, error: null } });
  assert.deepEqual(await queryLatestRun(client, 'us-congress'), row);

  const emptyClient = fakeClient({ ingestion_runs: { data: null, error: null } });
  assert.equal(await queryLatestRun(emptyClient, 'us-congress'), null);
});

test('queryLatestRun throws a plain descriptive Error on a real lookup failure', async () => {
  const client = fakeClient({ ingestion_runs: { data: null, error: { message: 'boom' } } });
  await assert.rejects(() => queryLatestRun(client, 'us-congress'), /ingestion_runs lookup failed.*us-congress.*boom/s);
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

test('resolveUsCongressRollWindow computes {lo,hi,maxKnown} from the max roll number found in votes.source_key', async () => {
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
  assert.deepEqual(window, { lo: 356, hi: 365, maxKnown: 355 });
});

test('resolveUsCongressRollWindow starts at roll 1 when nothing is on file yet for this congress/year', async () => {
  const client = fakeClient({ votes: { data: [], error: null } });
  const window = await resolveUsCongressRollWindow(client, { congress: 119, year: 2026, windowSize: 10 });
  assert.deepEqual(window, { lo: 1, hi: 10, maxKnown: 0 });
});

test('resolveUsSenateVoteWindow (I5) computes {lo,hi,maxKnown} from the max vote number found in votes.source_key, ignoring House keys', async () => {
  const client = fakeClient({
    votes: {
      data: [
        { source_key: 'us-senate-119-2-655' },
        { source_key: 'us-senate-119-2-661' },
        { source_key: 'us-house-119-2026-999' }, // must be ignored — different chamber/prefix
      ],
      error: null,
    },
  });
  const window = await resolveUsSenateVoteWindow(client, { congress: 119, session: 2, windowSize: 10 });
  assert.deepEqual(window, { lo: 662, hi: 671, maxKnown: 661 });
});

test('resolveUsSenateVoteWindow defaults to US_CONGRESS_CONGRESS/US_SENATE_SESSION/US_SENATE_VOTE_WINDOW', async () => {
  const client = fakeClient({ votes: { data: [], error: null } });
  const window = await resolveUsSenateVoteWindow(client, {});
  assert.deepEqual(window, { lo: 1, hi: US_SENATE_VOTE_WINDOW, maxKnown: 0 });
});

// ---- buildRegistry: the full five-source registry ----

function fakeRegistryClient({
  legiscanSessionId = 2239, houseVotesRows = [], senateVotesRows = [],
  lastStartedAtBySource = {}, sessionsError = null, onCall = null,
} = {}) {
  return {
    from(table) {
      if (table === 'ingestion_runs') {
        let sourceFilter = null;
        const builder = {
          select: () => builder,
          eq: (col, val) => { sourceFilter = val; return builder; },
          order: () => builder,
          limit: () => builder,
          maybeSingle: () => builder,
          then: (resolve, reject) => {
            if (onCall) onCall(`ingestion_runs:${sourceFilter}`);
            const started = lastStartedAtBySource[sourceFilter] ?? null;
            return Promise.resolve({ data: started ? { started_at: started } : null, error: null }).then(resolve, reject);
          },
        };
        return builder;
      }
      if (table === 'sessions') {
        if (onCall) onCall('sessions');
        return fakeQuery(sessionsError
          ? { data: null, error: sessionsError }
          : { data: legiscanSessionId != null ? { legiscan_session_id: legiscanSessionId } : null, error: null });
      }
      if (table === 'votes') {
        if (onCall) onCall('votes');
        // Real filtering isn't implemented by this fake — both resolveUsCongressRollWindow and
        // resolveUsSenateVoteWindow query 'votes' and each filters via its OWN regex
        // (parseUsHouseRoll / parseUsSenateVote), which naturally ignores the other chamber's
        // keys — so returning the UNION of both rows to either caller is safe.
        return fakeQuery({ data: [...houseVotesRows, ...senateVotesRows], error: null });
      }
      return fakeQuery({ data: null, error: null });
    },
  };
}

test('buildRegistry: all five sources, correct scripts + static args, legiscan resolved', async () => {
  const client = fakeRegistryClient({ legiscanSessionId: 2239 });
  const registry = await buildRegistry(client, { now: Date.parse('2026-07-31T12:00:00.000Z'), year: 2026 });

  assert.equal(registry.length, 5);
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
  assert.equal(byKey['us-congress'].windowMaxKnown, 0);

  assert.equal(byKey['us-senate'].scriptPath, 'src/cli/ingest.js');
  assert.deepEqual(byKey['us-senate'].cliArgs, ['--source', 'us-senate', '--session', String(US_SENATE_SESSION), '--votes', `1-${US_SENATE_VOTE_WINDOW}`]);
  assert.equal(byKey['us-senate'].windowMaxKnown, 0);

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
  assert.match(legiscan.unresolvedReason, new RegExp(DEFAULT_MO_HOUSE_SESSION), 'names the actual session identifier it looked up, not a vague message');
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

// ---- I3 (fix round 1) red-first: one rejected lookup must not abort the whole tick ----

test('I3: buildRegistry survives a rejected lookup (legiscan session resolution throws) — never rejects, the other sources still resolve normally', async () => {
  const client = fakeRegistryClient({ sessionsError: { message: 'connection reset by peer' } });
  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 }); // must NOT throw
  const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));

  assert.equal(byKey['mo-senate-web'].resolvable, true);
  assert.equal(byKey['mo-house-xml'].resolvable, true);
  assert.equal(byKey['us-congress'].resolvable, true);
  assert.equal(byKey['us-senate'].resolvable, true);

  assert.equal(byKey.legiscan.resolvable, false);
  assert.match(byKey.legiscan.unresolvedReason, /skipped this tick:.*connection reset/);
});

test('I3: after a rejected lookup, the tick can still PICK among the sources that resolved fine', async () => {
  const client = fakeRegistryClient({
    sessionsError: { message: 'connection reset by peer' },
    lastStartedAtBySource: { 'mo-senate-web': '2020-01-01T00:00:00.000Z' }, // long overdue
  });
  const now = Date.now();
  const registry = await buildRegistry(client, { now, year: 2026 });
  const withDueness = registry.map((e) => computeSourceDueness(e, now));
  const chosen = pickMostOverdue(withDueness);
  assert.ok(chosen, 'a tick must still be able to choose a source even when legiscan\'s lookup failed');
  assert.notEqual(chosen.key, 'legiscan', 'the failed lookup must never be chosen');
});

// ---- M3 (fix round 1): --only skips lookups that are not needed this tick ----

test('M3: buildRegistry with --only mo-senate-web fires ONLY that source\'s own ingestion_runs lookup — not the other four sources\' lookups, not sessions, not votes', async () => {
  const calls = [];
  const client = fakeRegistryClient({ onCall: (c) => calls.push(c) });
  await buildRegistry(client, { now: Date.now(), year: 2026, only: 'mo-senate-web' });
  assert.deepEqual(calls, ['ingestion_runs:mo-senate-web']);
});

test('M3: buildRegistry with --only us-congress fires that source\'s ingestion_runs lookup AND its roll-window votes lookup, nothing else', async () => {
  const calls = [];
  const client = fakeRegistryClient({ onCall: (c) => calls.push(c) });
  await buildRegistry(client, { now: Date.now(), year: 2026, only: 'us-congress' });
  assert.deepEqual(calls.sort(), ['ingestion_runs:us-congress', 'votes'].sort());
});

test('M3: buildRegistry with --only legiscan fires that source\'s ingestion_runs lookup AND the sessions lookup, nothing else', async () => {
  const calls = [];
  const client = fakeRegistryClient({ onCall: (c) => calls.push(c) });
  await buildRegistry(client, { now: Date.now(), year: 2026, only: 'legiscan' });
  assert.deepEqual(calls.sort(), ['ingestion_runs:legiscan', 'sessions'].sort());
});

test('M3: buildRegistry with no --only still fires every lookup (nothing is scoped away for a full tick)', async () => {
  const calls = [];
  const client = fakeRegistryClient({ onCall: (c) => calls.push(c) });
  await buildRegistry(client, { now: Date.now(), year: 2026 });
  assert.equal(calls.filter((c) => c.startsWith('ingestion_runs:')).length, 5);
  assert.equal(calls.filter((c) => c === 'sessions').length, 1);
  assert.equal(calls.filter((c) => c === 'votes').length, 2); // us-congress roll window + us-senate vote window
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

test('runChildCli: a genuine launch failure (spawnFn returns .error with no known code) throws "could not launch"', () => {
  const spawnFn = () => ({ error: new Error('ENOENT'), status: null, stdout: '', stderr: '' });
  assert.throws(() => runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn }), /could not launch/);
});

// ---- I2/M2 (fix round 1): timeout and buffer-overflow are reported distinctly, never as "could not launch" ----

test('I2: a spawnSync timeout (ETIMEDOUT) is reported distinctly — never confused with a bad path', () => {
  const spawnFn = () => ({
    error: Object.assign(new Error('spawnSync src/cli/ingest.js ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    status: null, stdout: '', stderr: '', signal: 'SIGTERM',
  });
  assert.throws(() => runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn }), /exceeded its .*timeout/);
});

test('M2: a maxBuffer overflow (ENOBUFS) is reported distinctly — never confused with a bad path', () => {
  const spawnFn = () => ({
    error: Object.assign(new Error('spawnSync src/cli/ingest.js ENOBUFS'), { code: 'ENOBUFS' }),
    status: null, stdout: '', stderr: '',
  });
  assert.throws(() => runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn }), /output buffer.*ENOBUFS/);
});

test('I2/M2: CHILD_TIMEOUT_MS is strictly less than both MAX_RUN_DURATION_MS and the 15-min recommended tick; CHILD_MAX_BUFFER is raised above Node\'s 1MB default', () => {
  assert.ok(CHILD_TIMEOUT_MS < MAX_RUN_DURATION_MS, 'child timeout must be strictly less than the stale-reclaim window');
  assert.ok(CHILD_TIMEOUT_MS < 15 * 60 * 1000, 'child timeout must be strictly less than the recommended 15-min tick');
  assert.ok(CHILD_MAX_BUFFER > 1024 * 1024, 'maxBuffer must be raised above Node\'s 1MB default');
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

// ---- C1 (fix round 1) red-first: a source whose CLI fails before openRun must not be able to
// monopolize the picker forever ----

// A minimal, STATEFUL fake for 'ingestion_runs' covering the three real shapes openRun/closeRun/
// queryLatestRun actually use (insert().select('id').single(), update().eq('id',x),
// select().eq().order().limit().maybeSingle()) — realistic enough to prove recordSchedulerAttemptFailure
// really does advance the durable signal queryLatestRun/queryLatestStartedAt both read from.
function fakeIngestionRunsClient(initialRow) {
  let latestRow = initialRow; // {started_at, status, detail} | null
  const byId = new Map();
  let nextId = 1;

  return {
    from(table) {
      if (table !== 'ingestion_runs') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({ maybeSingle: () => Promise.resolve({ data: latestRow, error: null }) }),
            }),
          }),
        }),
        insert: (row) => ({
          select: () => ({
            single: () => {
              const id = `run-${nextId}`; nextId += 1;
              const startedAt = new Date().toISOString();
              const stored = {
                id, source: row.source, status: row.status, started_at: startedAt, detail: null,
              };
              byId.set(id, stored);
              latestRow = { started_at: startedAt, status: row.status, detail: null };
              return Promise.resolve({ data: { id }, error: null });
            },
          }),
        }),
        update: (patch) => ({
          eq: (col, id) => {
            const stored = byId.get(id);
            if (stored) {
              stored.status = patch.status;
              stored.detail = patch.detail;
              if (latestRow && latestRow.started_at === stored.started_at) {
                latestRow = { started_at: stored.started_at, status: patch.status, detail: patch.detail };
              }
            }
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
}

test('recordSchedulerAttemptFailure writes an HONEST failed row via the same openRun/closeRun helpers every CLI uses — never a fake success', async () => {
  const client = fakeIngestionRunsClient(null);
  const childResult = {
    exitStatus: 1, stderr: 'x'.repeat(3000) + 'TAIL_MARKER', parseError: 'Unexpected token', stdout: '',
  };
  const runId = await recordSchedulerAttemptFailure(client, 'us-congress', childResult, new Error('fetchMemberList failed'));
  assert.ok(runId);

  const latest = await queryLatestRun(client, 'us-congress');
  assert.equal(latest.status, 'failed');
  assert.equal(latest.detail.scheduler_attempt, true);
  assert.equal(latest.detail.exitCode, 1);
  assert.equal(latest.detail.launchError, 'fetchMemberList failed');
  assert.ok(latest.detail.stderrTail.endsWith('TAIL_MARKER'), 'stderr tail must be bounded but keep the most recent content');
  assert.ok(latest.detail.stderrTail.length <= 2000);
});

test('C1 RED-FIRST: when the child fails and writes NO new ingestion_runs row, runChosenSource self-records an honest failed attempt — and the source is no longer most-overdue on the next computation', async () => {
  const oldStartedAt = '2026-07-28T04:40:00.000Z'; // matches the live incident's real timestamp
  const chosen = {
    key: 'us-congress',
    minIntervalMs: 60 * 60 * 1000,
    lastStartedAtIso: oldStartedAt,
    resolvable: true,
    scriptPath: 'src/cli/ingest.js',
    cliArgs: ['--source', 'us-congress', '--year', '2026', '--rolls', '284-293'],
    windowMaxKnown: 283,
  };

  // The fake starts already seeded with the OLD row (matching chosen.lastStartedAtIso) — the
  // child "fails before openRun" (ingest.js's fetchMemberList throws), so nothing INSERTs a new
  // row on its own; only recordSchedulerAttemptFailure (invoked internally by runChosenSource)
  // will change what queryLatestRun sees next.
  const client = fakeIngestionRunsClient({ started_at: oldStartedAt, status: 'succeeded', detail: {} });

  // Simulates a hard crash: congress.gov down, ingest.js throws before ever printing JSON —
  // non-zero exit, empty/non-JSON stdout.
  const spawnFn = () => ({ status: 1, stdout: '', stderr: 'SourceFetchError: HTTP 503 from us-congress' });

  const result = await runChosenSource(client, chosen, {
    runChildCliFn: (scriptPath, cliArgs) => runChildCli(scriptPath, cliArgs, { spawnFn }),
  });

  assert.equal(result.selfRecordedFailure, true, 'must detect that no new row appeared and self-record');
  assert.equal(result.outcome.status, 'failed');
  assert.equal(result.outcome.healthy, false);
  assert.equal(result.outcome.wroteRows, false, 'a self-recorded failure must never trigger the aggregate refresh');

  // The durable signal now reflects the self-recorded attempt, not the frozen 2026-07-28 timestamp.
  const latest = await queryLatestRun(client, 'us-congress');
  assert.notEqual(latest.started_at, oldStartedAt);
  assert.equal(latest.status, 'failed');
  assert.equal(latest.detail.scheduler_attempt, true);

  // THE ACTUAL PROOF: recomputing due-ness with the NEW lastStartedAtIso, one Task Scheduler tick
  // later, shows the source is no longer due — it will rotate to another source next time,
  // instead of being picked again on every 15-minute tick forever.
  const nextTickNow = Date.now() + 15 * 60 * 1000;
  const duenessAfter = computeSourceDueness({ ...chosen, lastStartedAtIso: latest.started_at }, nextTickNow);
  assert.equal(duenessAfter.due, false, 'the source must not be immediately due again after a self-recorded attempt');
});

test('runChosenSource: a NORMAL successful child (which writes its own row) is NOT self-recorded — the child\'s own row is trusted', async () => {
  const chosen = {
    key: 'mo-senate-web',
    minIntervalMs: 30 * 60 * 1000,
    lastStartedAtIso: '2026-07-31T11:00:00.000Z',
    resolvable: true,
    scriptPath: 'src/cli/ingest-mo-senate.js',
    cliArgs: ['--year', '2026', '--limit', '1'],
  };
  const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });

  const spawnFn = () => ({ status: 0, stdout: JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 4, casts: 200 } }), stderr: '' });
  // Pre-seed what the child "would have written" by inserting directly through the same fake —
  // runChosenSource only OBSERVES ingestion_runs, it doesn't care who wrote the row.
  const inserted = await client.from('ingestion_runs').insert({ source: 'mo-senate-web', status: 'running' }).select('id').single();
  await client.from('ingestion_runs').update({ status: 'succeeded', detail: { counts: { votes: 4, casts: 200 } } }).eq('id', inserted.data.id);

  const result = await runChosenSource(client, chosen, {
    runChildCliFn: (scriptPath, cliArgs) => runChildCli(scriptPath, cliArgs, { spawnFn }),
  });

  assert.equal(result.selfRecordedFailure, false);
  assert.equal(result.outcome.status, 'succeeded');
  assert.equal(result.outcome.healthy, true);
  assert.equal(result.outcome.wroteRows, true);
});

test('runChosenSource: a windowed source whose ONLY failures are expected tail 404s reads as healthy (I4a), and wroteRows reflects the real counts (I4b) independently', async () => {
  const chosen = {
    key: 'us-congress',
    minIntervalMs: 60 * 60 * 1000,
    lastStartedAtIso: '2026-07-31T10:00:00.000Z',
    resolvable: true,
    scriptPath: 'src/cli/ingest.js',
    cliArgs: ['--source', 'us-congress', '--year', '2026', '--rolls', '284-293'],
    windowMaxKnown: 283,
  };
  const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });

  const failures = Array.from({ length: 10 }, (_, i) => ({ step: `roll ${284 + i}`, message: 'HTTP 404' }));
  const inserted = await client.from('ingestion_runs').insert({ source: 'us-congress', status: 'running' }).select('id').single();
  await client.from('ingestion_runs').update({
    status: 'partial', detail: { counts: { votes: 0, casts: 0, failures: 10 }, failures },
  }).eq('id', inserted.data.id);

  const spawnFn = () => ({
    status: 2, stdout: JSON.stringify({ mode: 'live', status: 'partial', counts: { votes: 0 }, failures }), stderr: '',
  });
  const result = await runChosenSource(client, chosen, {
    runChildCliFn: (scriptPath, cliArgs) => runChildCli(scriptPath, cliArgs, { spawnFn }),
  });

  assert.equal(result.selfRecordedFailure, false, 'the child DID write a row — this is not a C1 scenario');
  assert.equal(result.outcome.status, 'partial');
  assert.equal(result.outcome.tailProbeOnly, true);
  assert.equal(result.outcome.healthy, true, 'all-tail-404s must read as healthy, not alarming (I4a)');
  assert.equal(result.outcome.wroteRows, false, 'zero votes actually landed — must not trigger a refresh (I4b)');
  assert.match(result.outcome.note, /tail 404/);
});

// ---- getSchedulerClient (I2): null-if-unconfigured contract, mirrors lib/db.js's getClient() ----

test('getSchedulerClient returns null when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are not set', () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    assert.equal(getSchedulerClient(), null);
  } finally {
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl; else delete process.env.SUPABASE_URL;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey; else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

test('getSchedulerClient returns a truthy client when both env vars are set (construction only — no network call happens)', () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key-for-construction-only';
  try {
    assert.ok(getSchedulerClient());
  } finally {
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl; else delete process.env.SUPABASE_URL;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey; else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

// ---- sanity: hardcoded "current" congress/session constants exist and are the documented values ----

test('US_CONGRESS_CONGRESS/US_SENATE_SESSION match the repo-wide hardcoded-current convention', () => {
  assert.equal(US_CONGRESS_CONGRESS, 119);
  assert.equal(US_SENATE_SESSION, 2);
});
