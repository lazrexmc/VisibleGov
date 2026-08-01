import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {
  parseArgs, isLockStale, acquireLock, releaseLock, updateLockMaxDuration,
  computeSourceDueness, pickMostOverdue,
  parseUsHouseRoll, parseUsSenateVote, computeRollWindow,
  isExpectedTailProbeOutcome,
  moSenateWroteSomething, usCongressWroteSomething, usSenateWroteSomething, moHouseWroteSomething,
  legiscanWroteSomething, defaultWroteSomething,
  parseChildOutput,
  queryLatestStartedAt, queryLatestRun,
  resolveLegiscanSessionId, resolveUsCongressRollWindow, resolveUsSenateVoteWindow, buildRegistry,
  runChildCli, recordSchedulerAttemptFailure, closeOrphanedRunningRows, runChosenSource,
  getSchedulerClient, envIntervalMs,
  MAX_RUN_DURATION_MS, MAX_LOCK_DURATION_MS, CHILD_TIMEOUT_MS, CHILD_MAX_BUFFER,
  LEGISCAN_CHILD_TIMEOUT_MS, LOCK_GRACE_MS, ORPHAN_CLOSE_SKEW_GRACE_MS,
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

// ---- Round 2, finding 2 RED-FIRST: the lock's stale-reclaim window must be the LOCK'S OWN
// declared maxDurationMs, not one fixed constant — a 75-min legiscan run and a fixed 10-min
// window cannot coexist. Exactly the coordinator's three named cases. ----

test('ROUND 2 RED-FIRST: a lock declaring 75 minutes (legiscan) is NOT reclaimed at 15 minutes', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    const t0 = Date.parse('2026-07-31T12:00:00.000Z');
    const tickA = acquireLock(lockPath, { now: t0 });
    // Selection has finished and legiscan (75 min timeout + 1 min grace) was chosen — declare
    // the real duration BEFORE spawning, exactly as main() does.
    updateLockMaxDuration(lockPath, tickA.nonce, LEGISCAN_CHILD_TIMEOUT_MS + LOCK_GRACE_MS);

    const fifteenMinLater = t0 + 15 * 60 * 1000;
    const tickB = acquireLock(lockPath, { now: fifteenMinLater });
    assert.equal(tickB.acquired, false, 'a 76-min declared lock must not be reclaimed at 15 minutes — a fixed 10-min window would have wrongly reclaimed it here');
    assert.equal(tickB.reason, 'already-running');
  });
});

test('ROUND 2 RED-FIRST: a lock declaring 480s (the default family) IS still reclaimed at 15 minutes', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    const t0 = Date.parse('2026-07-31T12:00:00.000Z');
    const tickA = acquireLock(lockPath, { now: t0 });
    updateLockMaxDuration(lockPath, tickA.nonce, 480 * 1000); // exactly CHILD_TIMEOUT_MS, no grace

    const fifteenMinLater = t0 + 15 * 60 * 1000;
    const tickB = acquireLock(lockPath, { now: fifteenMinLater });
    assert.equal(tickB.acquired, true, 'a lock declaring only 8 minutes must be reclaimable well past that');
    assert.equal(tickB.reason, 'reclaimed-stale');
  });
});

test('ROUND 2 RED-FIRST: a corrupt lock file is STILL reclaimed at 15 minutes (fail-safe fallback to MAX_RUN_DURATION_MS, unaffected by the new per-lock duration)', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, 'not json at all{{{');
    const t0 = Date.parse('2026-07-31T12:00:00.000Z');
    const result = acquireLock(lockPath, { now: t0 + 15 * 60 * 1000 });
    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'reclaimed-stale');
  });
});

test('isLockStale directly: missing/non-numeric/non-positive maxDurationMs all fall back to fallbackMaxDurationMs, never trusted as "wait forever"', () => {
  const now = Date.parse('2026-07-31T12:15:00.000Z'); // 15 min after startedAt below — past the 10-min default
  const startedAt = '2026-07-31T12:00:00.000Z';
  assert.equal(isLockStale({ startedAt }, now), true, 'no maxDurationMs field at all (old-format lock)');
  assert.equal(isLockStale({ startedAt, maxDurationMs: 'not-a-number' }, now), true);
  assert.equal(isLockStale({ startedAt, maxDurationMs: -5 }, now), true);
  assert.equal(isLockStale({ startedAt, maxDurationMs: 0 }, now), true);
});

test('isLockStale directly: a valid maxDurationMs on the lock is honored over the fallback', () => {
  const now = Date.parse('2026-07-31T12:15:00.000Z'); // 15 min elapsed
  const startedAt = '2026-07-31T12:00:00.000Z';
  assert.equal(isLockStale({ startedAt, maxDurationMs: 75 * 60 * 1000 }, now), false);
  assert.equal(isLockStale({ startedAt, maxDurationMs: 8 * 60 * 1000 }, now), true);
});

// ---- ROUND 3, NEW-2 RED-FIRST: a declared duration beyond MAX_LOCK_DURATION_MS is treated like
// missing/corrupt — never honored as "never go stale" ----

test('ROUND 3 RED-FIRST (NEW-2): an absurdly large declared maxDurationMs (e.g. hand-edited to ~31 years) is NOT honored — falls back to the default, so the lock CAN still go stale', () => {
  const startedAt = '2026-07-31T12:00:00.000Z';
  const wellPastDefault = Date.parse(startedAt) + MAX_RUN_DURATION_MS + 60 * 1000; // 1 min past the 10-min default

  // Without the NEW-2 fix, 1e12 ms (~31 years) would be honored verbatim and this would read false.
  assert.equal(isLockStale({ startedAt, maxDurationMs: 1e12 }, wellPastDefault), true);
});

test('ROUND 3 (NEW-2): a value right at MAX_LOCK_DURATION_MS is still honored; one msec beyond it falls back to the default', () => {
  const startedAt = '2026-07-31T12:00:00.000Z';
  const withinCeiling = Date.parse(startedAt) + MAX_LOCK_DURATION_MS - 1000; // 1s before the ceiling elapses
  assert.equal(isLockStale({ startedAt, maxDurationMs: MAX_LOCK_DURATION_MS }, withinCeiling), false);

  const beyondDefaultButNotCeiling = Date.parse(startedAt) + MAX_RUN_DURATION_MS + 1000; // past the 10-min default
  assert.equal(
    isLockStale({ startedAt, maxDurationMs: MAX_LOCK_DURATION_MS + 1 }, beyondDefaultButNotCeiling),
    true,
    'a duration one msec beyond the ceiling must fall back to the (much smaller) default, not be honored',
  );
});

test('ROUND 3 (NEW-2): MAX_LOCK_DURATION_MS comfortably exceeds the largest real declared duration (legiscan + grace)', () => {
  assert.ok(MAX_LOCK_DURATION_MS > LEGISCAN_CHILD_TIMEOUT_MS + LOCK_GRACE_MS);
});

test('acquireLock writes the initial maxDurationMs (MAX_RUN_DURATION_MS, the selection-phase default) into a fresh lock', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    acquireLock(lockPath, { now: Date.now() });
    const written = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(written.maxDurationMs, MAX_RUN_DURATION_MS);
  });
});

test('updateLockMaxDuration rewrites the declared duration when the nonce matches, preserving pid/startedAt/nonce', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    const lock = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
    const ok = updateLockMaxDuration(lockPath, lock.nonce, 75 * 60 * 1000);
    assert.equal(ok, true);
    const written = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(written.maxDurationMs, 75 * 60 * 1000);
    assert.equal(written.pid, process.pid);
    assert.equal(written.nonce, lock.nonce);
    assert.equal(written.startedAt, '2026-07-31T12:00:00.000Z');
  });
});

test('updateLockMaxDuration never overwrites a lock it does not (verifiably) own, and never throws when the file is missing', () => {
  withTmpDir((dir) => {
    const lockPath = path.join(dir, 'scheduler.lock.json');
    acquireLock(lockPath, { now: Date.now() });
    assert.equal(updateLockMaxDuration(lockPath, 'wrong-nonce', 999), false);
    assert.equal(updateLockMaxDuration(lockPath, null, 999), false);
    const unchanged = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(unchanged.maxDurationMs, MAX_RUN_DURATION_MS, 'the rejected attempts must leave the lock completely untouched');

    assert.equal(updateLockMaxDuration(path.join(dir, 'nope.json'), 'any-nonce', 999), false);
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

// ---- ROUND 3, NEW-1 RED-FIRST: per-source wroteSomething predicates, verified against REAL
// ingestion_runs fixture rows (fetched read-only from the live DB during this fix round, trimmed
// to the fields that matter) — not invented shapes. This is what caught the original bug:
// fix-round-1's countsShowRowsWritten claimed "verified against each one's real closeRun() call
// site" but legiscan's mapping was actually inferred by analogy, and measured 0/52 true against
// real data. Every fixture below is a REAL observed shape. ----

// ---- mo-senate-web: real detail.counts.votes, both the "wrote something" and early-close
// "wrote nothing" (roster/journal-index slot, votes always 0) shapes really occur ----

const REAL_MO_SENATE_WROTE_VOTES = {
  status: 'succeeded',
  detail: {
    counts: {
      days: 1, casts: 231, gated: false, votes: 7, failures: 0, unresolved: 7,
    },
  },
};
const REAL_MO_SENATE_JOURNAL_INDEX_SLOT = {
  status: 'succeeded',
  detail: {
    counts: {
      days: 0, slot: 'journal-index', casts: 0, gated: false, votes: 0, failures: 0, unresolved: 0,
    },
  },
};

test('moSenateWroteSomething: real "wrote votes" row -> true; real journal-index early-close slot (votes always 0) -> false', () => {
  assert.equal(moSenateWroteSomething(REAL_MO_SENATE_WROTE_VOTES.detail, REAL_MO_SENATE_WROTE_VOTES.status), true);
  assert.equal(moSenateWroteSomething(REAL_MO_SENATE_JOURNAL_INDEX_SLOT.detail, REAL_MO_SENATE_JOURNAL_INDEX_SLOT.status), false);
});

test('moSenateWroteSomething: an unrecognized shape fails OPEN on a completed run, but never on a failed one', () => {
  assert.equal(moSenateWroteSomething({ somethingElse: true }, 'succeeded'), true);
  assert.equal(moSenateWroteSomething({ somethingElse: true }, 'partial'), true);
  assert.equal(moSenateWroteSomething({ somethingElse: true }, 'failed'), false);
  assert.equal(moSenateWroteSomething(null, 'succeeded'), true);
});

// ---- us-congress / us-senate: real detail.counts.votes ----

const REAL_US_CONGRESS_PARTIAL_WITH_FAILURES = {
  status: 'partial',
  detail: {
    notes: [], counts: {
      bills: 173, casts: 122129, votes: 283, failures: 2, legislators: 53,
    }, failures: [{ step: 'roll 999', message: 'HTTP 404' }, { step: 'roll 1000', message: 'HTTP 404' }],
  },
};
const REAL_US_CONGRESS_SUCCEEDED = {
  status: 'succeeded',
  detail: {
    notes: [], counts: {
      bills: 3, casts: 2165, votes: 5, failures: 0, legislators: 53,
    }, failures: [],
  },
};

test('usCongressWroteSomething: real succeeded row (votes:5) -> true; real partial-with-failures row (votes:283, the tail-probe shape) -> ALSO true, since votes really did land', () => {
  assert.equal(usCongressWroteSomething(REAL_US_CONGRESS_SUCCEEDED.detail, REAL_US_CONGRESS_SUCCEEDED.status), true);
  assert.equal(usCongressWroteSomething(REAL_US_CONGRESS_PARTIAL_WITH_FAILURES.detail, REAL_US_CONGRESS_PARTIAL_WITH_FAILURES.status), true);
});

test('usCongressWroteSomething: THE I4b REGRESSION CASE — a live/partial run whose probe window found nothing (votes:0) must read as "wrote nothing"', () => {
  assert.equal(usCongressWroteSomething({ counts: { votes: 0, casts: 0, failures: 10 } }, 'partial'), false);
});

test('usCongressWroteSomething: an unrecognized shape fails OPEN on a completed run, never on a failed one', () => {
  assert.equal(usCongressWroteSomething({}, 'succeeded'), true);
  assert.equal(usCongressWroteSomething({}, 'failed'), false);
});

const REAL_US_SENATE_WROTE_VOTES = {
  status: 'succeeded',
  detail: {
    counts: {
      bills: 44, casts: 20997, votes: 210, failures: 0, resolved: 20997, unresolved: 0, senate_members_ensured: 100, senate_members_filtered_historical: 2157,
    },
    failures: [],
    unresolved: [],
  },
};

test('usSenateWroteSomething: real succeeded row (votes:210) -> true; a zero-vote instance of the same real shape -> false', () => {
  assert.equal(usSenateWroteSomething(REAL_US_SENATE_WROTE_VOTES.detail, REAL_US_SENATE_WROTE_VOTES.status), true);
  const zeroVotes = { counts: { ...REAL_US_SENATE_WROTE_VOTES.detail.counts, votes: 0 } };
  assert.equal(usSenateWroteSomething(zeroVotes, 'succeeded'), false);
});

test('usSenateWroteSomething: an unrecognized shape fails OPEN on a completed run, never on a failed one', () => {
  assert.equal(usSenateWroteSomething({}, 'partial'), true);
  assert.equal(usSenateWroteSomething({}, 'failed'), false);
});

// ---- mo-house-xml: real rollcall-pdf (rollCallResult.castCount) and bill-xml
// (counts.bills_detailed) shapes, both branches ----

const REAL_MO_HOUSE_ROLLCALL_PDF = {
  status: 'succeeded',
  detail: {
    counts: {
      failures: 0, document_type: 'rollcall-pdf', skipped_failed_pdfs: 0, skipped_failed_pdf_keys: [],
    },
    rollCallResult: {
      mode: 'live', gated: false, resolved: 1, castCount: 158, persisted: true, unresolved: 157,
    },
  },
};
const REAL_MO_HOUSE_BILL_XML = {
  status: 'succeeded',
  detail: {
    counts: {
      roster: {}, failures: 0, bills_listed: 2099, document_type: 'bill-xml', bills_detailed: 1, list_fetch_mode: 'live', skipped_failed_pdfs: 0, skipped_failed_pdf_keys: [],
    },
    failures: [],
    billResults: [{}],
  },
};

test('moHouseWroteSomething: real rollcall-pdf row (castCount:158) -> true; a zero-cast instance of the same real shape -> false', () => {
  assert.equal(moHouseWroteSomething(REAL_MO_HOUSE_ROLLCALL_PDF.detail, REAL_MO_HOUSE_ROLLCALL_PDF.status), true);
  const zeroCast = { ...REAL_MO_HOUSE_ROLLCALL_PDF.detail, rollCallResult: { ...REAL_MO_HOUSE_ROLLCALL_PDF.detail.rollCallResult, castCount: 0 } };
  assert.equal(moHouseWroteSomething(zeroCast, 'succeeded'), false);
});

test('moHouseWroteSomething: real bill-xml row (bills_detailed:1) -> true; a zero instance of the same real shape -> false', () => {
  assert.equal(moHouseWroteSomething(REAL_MO_HOUSE_BILL_XML.detail, REAL_MO_HOUSE_BILL_XML.status), true);
  const zeroBills = { ...REAL_MO_HOUSE_BILL_XML.detail, counts: { ...REAL_MO_HOUSE_BILL_XML.detail.counts, bills_detailed: 0 } };
  assert.equal(moHouseWroteSomething(zeroBills, 'succeeded'), false);
});

test('moHouseWroteSomething: an unrecognized document_type fails OPEN on a completed run, never on a failed one', () => {
  assert.equal(moHouseWroteSomething({ counts: { document_type: 'some-future-branch' } }, 'succeeded'), true);
  assert.equal(moHouseWroteSomething({ counts: { document_type: 'some-future-branch' } }, 'failed'), false);
  assert.equal(moHouseWroteSomething({}, 'partial'), true);
});

// ---- legiscan: THE ACTUAL NEW-1 FIX. Real ingest-legiscan.js shape has `votes` at the TOP
// LEVEL of detail (never nested under .counts) — the old code's detail.counts.votes lookup could
// never match it. ALSO real: ingest-legiscan-texts.js writes to the SAME source='legiscan' key
// with a totally different, votes-free shape (nested under .counts this time) — and a real
// failed-run shape with no votes field at all. ----

const REAL_LEGISCAN_WROTE_VOTES = {
  status: 'succeeded',
  detail: {
    bills: 3146,
    casts: 70465,
    votes: 604,
    people: { gated: 0, created: 0, matched: 193, ambiguous: 0 },
    session: { id: 'bf3c7f23-358d-4399-8279-3a8e60a96eda', gated: false, reason: 'exact_key', identifier: '261' },
    sessions: 1,
    datasetGate: { reason: 'hash_unchanged', shouldFetch: false },
    queriesUsed: 1,
    queries_used: 1,
    votesByChamber: { house: 404, senate: 200 },
    reconciliationFailures: 0,
  },
};
// The ingest-legiscan-texts.js shape — real, but votes-unrelated (document/text-cache counters).
const REAL_LEGISCAN_TEXTS_SHAPE = {
  status: 'partial',
  detail: {
    counts: {
      inserted: 3140, nonPdfMime: 0, statusError: 0, billsPlanned: 3152, cacheCorrupt: 0, datasetsRead: 31, decodeFailed: 0, docCacheHits: 0, extractEmpty: 1, queriesSpent: 3152, budgetRefused: 0, alreadyPresent: 0, datasetsMissing: 0, oversizeRefused: 11, identityMismatch: 0, missingSourceUrl: 0, alreadyHasVersion: 25,
    },
    failures: new Array(12).fill({ step: 'x' }),
    attribution: { url: 'https://legiscan.com', holder: 'LegiScan', license: 'CC BY 4.0' },
    queries_used: 3152,
  },
};
const REAL_LEGISCAN_FAILED = {
  status: 'failed',
  detail: {
    error: 'Error: insertIfAbsent(votes) failed: date/time field value out of range: "0000-00-00"',
    queries_used: 1,
  },
};

test('legiscanWroteSomething THE NEW-1 FIX: real ingest-legiscan.js row (top-level detail.votes:604) -> true — this is exactly the shape the old detail.counts.votes lookup measured 0/52 true against', () => {
  assert.equal(legiscanWroteSomething(REAL_LEGISCAN_WROTE_VOTES.detail, REAL_LEGISCAN_WROTE_VOTES.status), true);
});

test('legiscanWroteSomething: a zero-vote instance of the real ingest-legiscan.js shape -> false', () => {
  const zeroVotes = { ...REAL_LEGISCAN_WROTE_VOTES.detail, votes: 0 };
  assert.equal(legiscanWroteSomething(zeroVotes, 'succeeded'), false);
});

test('legiscanWroteSomething: the real ingest-legiscan-texts.js shape (same source=\'legiscan\' key, no votes field anywhere) fails OPEN because the run genuinely completed', () => {
  assert.equal(legiscanWroteSomething(REAL_LEGISCAN_TEXTS_SHAPE.detail, REAL_LEGISCAN_TEXTS_SHAPE.status), true);
});

test('legiscanWroteSomething: the real failed-run shape (no votes field, status failed) -> false, never fails open on a genuine failure', () => {
  assert.equal(legiscanWroteSomething(REAL_LEGISCAN_FAILED.detail, REAL_LEGISCAN_FAILED.status), false);
});

// ---- defaultWroteSomething: the fallback for a registry entry with no predicate wired at all ----

test('defaultWroteSomething fails open for any completed run, never for a failed one', () => {
  assert.equal(defaultWroteSomething({ anything: true }, 'succeeded'), true);
  assert.equal(defaultWroteSomething({ anything: true }, 'partial'), true);
  assert.equal(defaultWroteSomething({ anything: true }, 'failed'), false);
  assert.equal(defaultWroteSomething(null, null), false);
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

test('ROUND 3 (NEW-1): buildRegistry wires each entry to ITS OWN wroteSomething predicate — never a shared/generic one', async () => {
  const client = fakeRegistryClient({ legiscanSessionId: 2239 });
  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
  const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));

  assert.equal(byKey['mo-senate-web'].wroteSomething, moSenateWroteSomething);
  assert.equal(byKey['mo-house-xml'].wroteSomething, moHouseWroteSomething);
  assert.equal(byKey['us-congress'].wroteSomething, usCongressWroteSomething);
  assert.equal(byKey['us-senate'].wroteSomething, usSenateWroteSomething);
  assert.equal(byKey.legiscan.wroteSomething, legiscanWroteSomething);

  // Each predicate must be independently callable and produce source-specific answers even
  // against the SAME detail shape — proves they are genuinely distinct functions, not one
  // dispatcher pretending to be five.
  assert.equal(byKey.legiscan.wroteSomething({ votes: 3 }, 'succeeded'), true); // top-level votes
  assert.equal(byKey['us-congress'].wroteSomething({ votes: 3 }, 'succeeded'), true); // fails open — no .counts.votes here, but a completed run
  assert.equal(byKey['us-congress'].wroteSomething({ counts: { votes: 0 } }, 'succeeded'), false); // the real, precise signal
});

test('ROUND 2: buildRegistry gives every source EXCEPT legiscan the default CHILD_TIMEOUT_MS, and legiscan its own much larger LEGISCAN_CHILD_TIMEOUT_MS', async () => {
  const client = fakeRegistryClient({ legiscanSessionId: 2239 });
  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
  const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));

  assert.equal(byKey['mo-senate-web'].timeoutMs, CHILD_TIMEOUT_MS);
  assert.equal(byKey['mo-house-xml'].timeoutMs, CHILD_TIMEOUT_MS);
  assert.equal(byKey['us-congress'].timeoutMs, CHILD_TIMEOUT_MS);
  assert.equal(byKey['us-senate'].timeoutMs, CHILD_TIMEOUT_MS);
  assert.equal(byKey.legiscan.timeoutMs, LEGISCAN_CHILD_TIMEOUT_MS);
  assert.ok(byKey.legiscan.timeoutMs > byKey['mo-senate-web'].timeoutMs, 'legiscan\'s timeout must be strictly larger than the default family');
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
  assert.equal(calls[0].options.timeout, CHILD_TIMEOUT_MS, 'defaults to CHILD_TIMEOUT_MS when no per-source timeoutMs is given');
  assert.equal(calls[0].options.maxBuffer, CHILD_MAX_BUFFER);
});

test('ROUND 2: runChildCli honors a per-call timeoutMs (this is what lets legiscan get its own 75-min budget)', () => {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 1 } }), stderr: '' };
  };
  runChildCli('src/cli/ingest-legiscan.js', ['--session', '2239'], { cwd: '/repo', spawnFn, timeoutMs: LEGISCAN_CHILD_TIMEOUT_MS });
  assert.equal(calls[0].options.timeout, LEGISCAN_CHILD_TIMEOUT_MS);
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

test('ROUND 2: the thrown ETIMEDOUT error carries .code and .timeoutMs -- this is what runChosenSource uses to know a forceful kill happened', () => {
  const spawnFn2 = () => ({
    error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    status: null, stdout: '', stderr: '',
  });
  try {
    runChildCli('src/cli/ingest-legiscan.js', [], { cwd: '/repo', spawnFn: spawnFn2, timeoutMs: LEGISCAN_CHILD_TIMEOUT_MS });
    assert.fail('expected a throw');
  } catch (err) {
    assert.equal(err.code, 'ETIMEDOUT');
    assert.equal(err.timeoutMs, LEGISCAN_CHILD_TIMEOUT_MS);
  }
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

// A minimal, STATEFUL fake for 'ingestion_runs' covering the real shapes openRun/closeRun/
// queryLatestRun/closeOrphanedRunningRows (via selectAll) actually use — realistic enough to
// prove recordSchedulerAttemptFailure and closeOrphanedRunningRows really do advance/correct the
// durable signal queryLatestRun/queryLatestStartedAt both read from.
//
// Single source of truth: `byId`. "Latest" is ALWAYS computed fresh (max by started_at) from
// whatever is currently in `byId` — never a separately-tracked shadow variable. An earlier
// version of this fake tracked `latestRow` as its own mutable variable, updated only by the
// insert()/update() code paths; a row added via `_seed` (bypassing insert()) never touched that
// variable, so a test seeding an orphaned row and then closing it via closeOrphanedRunningRows
// would have queryLatestRun still returning the STALE pre-seed value — a real bug this fake
// caught in itself during round 2. Computing it fresh every time closes that class of bug
// entirely, matching how a real `ORDER BY started_at DESC LIMIT 1` query behaves regardless of
// which code path wrote a row.
//
// Two DIFFERENT terminal shapes share the same .select() entry point: queryLatestRun ends in
// .maybeSingle() (the freshest-by-started_at row across everything seeded/inserted — round-1
// tests only ever exercise one source per test, so this has never needed to also filter by the
// chained .eq('source', ...)); closeOrphanedRunningRows's selectAll call ends in a bare `then`
// (an array of ALL rows matching every .eq()/.gte() filter actually chained, mirroring real
// Postgrest AND semantics, and IS source-aware — round 2 addition). `_seed`/`_get` are test-only
// escape hatches for precise control over a row's started_at (the real insert() path always uses
// `new Date()`, which real callers never override either — only tests need to simulate "a row
// from an earlier tick").
function fakeIngestionRunsClient(initialRow) {
  const byId = new Map();
  let nextId = 1;
  if (initialRow) byId.set('initial', { id: 'initial', ...initialRow });

  function latestRow() {
    let best = null;
    for (const r of byId.values()) {
      if (!best || (r.started_at ?? '') > (best.started_at ?? '')) best = r;
    }
    return best;
  }

  return {
    _seed(row) {
      const id = row.id ?? `seed-${nextId}`; nextId += 1;
      byId.set(id, { id, ...row });
      return id;
    },
    _get(id) {
      return byId.get(id);
    },
    from(table) {
      if (table !== 'ingestion_runs') throw new Error(`unexpected table ${table}`);
      return {
        select: () => {
          const eqFilters = {};
          const gteFilters = {};
          const builder = {
            eq: (col, val) => { eqFilters[col] = val; return builder; },
            gte: (col, val) => { gteFilters[col] = val; return builder; },
            order: () => builder,
            range: () => builder,
            limit: () => builder,
            maybeSingle: () => Promise.resolve({ data: latestRow(), error: null }),
            then: (resolve, reject) => {
              const rows = [...byId.values()].filter((r) => {
                for (const [col, val] of Object.entries(eqFilters)) if (r[col] !== val) return false;
                for (const [col, val] of Object.entries(gteFilters)) if (!(r[col] >= val)) return false;
                return true;
              });
              return Promise.resolve({ data: rows.map((r) => ({ id: r.id })), error: null }).then(resolve, reject);
            },
          };
          return builder;
        },
        insert: (row) => ({
          select: () => ({
            single: () => {
              const id = `run-${nextId}`; nextId += 1;
              const startedAt = new Date().toISOString();
              const stored = {
                id, source: row.source, status: row.status, started_at: startedAt, detail: null,
              };
              byId.set(id, stored);
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

// ---- Round 2, finding 3 RED-FIRST: a forceful kill must close an orphaned 'running' row it
// stranded — never leave it lying about state, never touch a row from before the tick ----

test('closeOrphanedRunningRows closes running rows for the given source scoped to sinceIso, honestly, and reports their ids', async () => {
  const client = fakeIngestionRunsClient(null);
  const staleId = client._seed({
    source: 'legiscan', status: 'running', started_at: '2026-07-31T11:00:00.000Z', detail: null,
  }); // BEFORE this tick — must never be touched
  const orphanId = client._seed({
    source: 'legiscan', status: 'running', started_at: '2026-07-31T12:05:00.000Z', detail: null,
  }); // DURING this tick — the one the kill actually stranded

  const closed = await closeOrphanedRunningRows(client, 'legiscan', {
    sinceIso: '2026-07-31T12:00:00.000Z', timeoutMs: 75 * 60 * 1000, note: 'ETIMEDOUT: boom',
  });

  assert.deepEqual(closed, [orphanId]);
  const closedRow = client._get(orphanId);
  assert.equal(closedRow.status, 'failed');
  assert.equal(closedRow.detail.scheduler_kill, true);
  assert.equal(closedRow.detail.timeoutMs, 75 * 60 * 1000);
  assert.match(closedRow.detail.note, /ETIMEDOUT/);

  // The pre-tick row is untouched — this is the "never touch rows from before the tick" rule.
  assert.equal(client._get(staleId).status, 'running');
});

test('closeOrphanedRunningRows only touches the named source — a running row for a DIFFERENT source is left alone', async () => {
  const client = fakeIngestionRunsClient(null);
  const otherId = client._seed({
    source: 'mo-house-xml', status: 'running', started_at: '2026-07-31T12:05:00.000Z', detail: null,
  });
  const closed = await closeOrphanedRunningRows(client, 'legiscan', {
    sinceIso: '2026-07-31T12:00:00.000Z', timeoutMs: 1000, note: 'x',
  });
  assert.deepEqual(closed, []);
  assert.equal(client._get(otherId).status, 'running');
});

test('closeOrphanedRunningRows is a harmless no-op for a source that never opened a run before being killed (e.g. us-congress, the actual C1 root cause)', async () => {
  const client = fakeIngestionRunsClient(null);
  const closed = await closeOrphanedRunningRows(client, 'us-congress', {
    sinceIso: '2026-07-31T12:00:00.000Z', timeoutMs: 1000, note: 'x',
  });
  assert.deepEqual(closed, []);
});

test('ROUND 2 RED-FIRST (finding 3): a timeout-killed legiscan run (which had already opened its own row) gets that row closed honestly — never stranded at running, never double-recorded by C1', async () => {
  const tickStartIso = '2026-07-31T12:00:00.000Z';
  const chosen = {
    key: 'legiscan',
    minIntervalMs: 24 * 60 * 60 * 1000,
    lastStartedAtIso: '2026-07-30T07:00:00.000Z', // yesterday's run — unrelated to this tick
    resolvable: true,
    scriptPath: 'src/cli/ingest-legiscan.js',
    cliArgs: ['--session', '2239'],
    timeoutMs: 75 * 60 * 1000,
    wroteSomething: legiscanWroteSomething,
  };
  const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
  // Simulate: legiscan's own openRun already fired (a real row exists, 'running') before the
  // 75-minute timeout killed it mid-dataset-processing.
  const orphanId = client._seed({
    source: 'legiscan', status: 'running', started_at: '2026-07-31T12:03:00.000Z', detail: null,
  });

  const spawnFn = () => ({
    error: Object.assign(new Error('spawnSync ingest-legiscan.js ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    status: null, stdout: '', stderr: 'a lot of progress output before the kill',
  });

  const result = await runChosenSource(client, chosen, {
    runChildCliFn: (scriptPath, cliArgs, opts) => runChildCli(scriptPath, cliArgs, { ...opts, spawnFn }),
    tickStartIso,
  });

  assert.equal(result.killedByScheduler, true);
  assert.deepEqual(result.killClosedRunIds, [orphanId]);
  assert.equal(result.selfRecordedFailure, false, 'the orphaned-row close already accounts for this — C1 must not ALSO write a second failure row');
  assert.equal(result.outcome.status, 'failed');
  assert.equal(result.outcome.healthy, false);
  assert.equal(result.outcome.wroteRows, false);
  assert.match(result.outcome.note, /scheduler killed this run/);

  const closedRow = client._get(orphanId);
  assert.equal(closedRow.status, 'failed');
  assert.equal(closedRow.detail.scheduler_kill, true);
  assert.equal(closedRow.detail.timeoutMs, 75 * 60 * 1000);
});

test('ROUND 3 RED-FIRST (NEW-4): a forward-skewed local clock (this tick\'s row lands slightly BEFORE the literal tickStartIso) is still found and closed, thanks to the skew-tolerance grace', async () => {
  const tickStartIso = '2026-07-31T12:00:00.000Z';
  const chosen = {
    key: 'legiscan',
    minIntervalMs: 24 * 60 * 60 * 1000,
    lastStartedAtIso: '2026-07-30T07:00:00.000Z',
    resolvable: true,
    scriptPath: 'src/cli/ingest-legiscan.js',
    cliArgs: ['--session', '2239'],
    timeoutMs: 75 * 60 * 1000,
    wroteSomething: legiscanWroteSomething,
  };
  const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
  // The DB (server clock) timestamped this row 90 SECONDS BEFORE the local tickStartIso — a
  // plausible forward local-clock skew. Without the grace, the plain `>= tickStartIso` filter
  // would miss it entirely (killClosedRunIds: [], silently indistinguishable from "nothing
  // needed closing"). It is well within ORPHAN_CLOSE_SKEW_GRACE_MS (5 min), so it must still be found.
  const orphanId = client._seed({
    source: 'legiscan', status: 'running', started_at: '2026-07-31T11:58:30.000Z', detail: null,
  });

  const spawnFn = () => ({
    error: Object.assign(new Error('spawnSync ingest-legiscan.js ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    status: null, stdout: '', stderr: '',
  });
  const result = await runChosenSource(client, chosen, {
    runChildCliFn: (scriptPath, cliArgs, opts) => runChildCli(scriptPath, cliArgs, { ...opts, spawnFn }),
    tickStartIso,
  });

  assert.deepEqual(result.killClosedRunIds, [orphanId], 'the skew-tolerant grace must still find a row timestamped slightly before tickStartIso');
  assert.equal(client._get(orphanId).status, 'failed');
});

test('ROUND 3 (NEW-4): the skew grace is bounded — a row from BEFORE the grace window (genuinely older, pre-existing history) is still correctly excluded', async () => {
  const tickStartIso = '2026-07-31T12:00:00.000Z';
  const chosen = {
    key: 'legiscan',
    minIntervalMs: 24 * 60 * 60 * 1000,
    lastStartedAtIso: '2026-07-30T07:00:00.000Z',
    resolvable: true,
    scriptPath: 'src/cli/ingest-legiscan.js',
    cliArgs: ['--session', '2239'],
    timeoutMs: 75 * 60 * 1000,
    wroteSomething: legiscanWroteSomething,
  };
  const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
  // 6 minutes before tick start — outside the 5-minute grace. Per the safety argument (every
  // registry interval is >=30 min), this could not be a row THIS tick's invocation created, and
  // must never be touched.
  const staleId = client._seed({
    source: 'legiscan', status: 'running', started_at: '2026-07-31T11:54:00.000Z', detail: null,
  });

  const spawnFn = () => ({
    error: Object.assign(new Error('spawnSync ingest-legiscan.js ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    status: null, stdout: '', stderr: '',
  });
  const result = await runChosenSource(client, chosen, {
    runChildCliFn: (scriptPath, cliArgs, opts) => runChildCli(scriptPath, cliArgs, { ...opts, spawnFn }),
    tickStartIso,
  });

  assert.deepEqual(result.killClosedRunIds, [], 'a row older than the grace window must never be touched');
  assert.equal(client._get(staleId).status, 'running', 'genuinely pre-existing history is left completely alone');
});

test('ROUND 2: a timeout-killed us-congress run (which never reached its own openRun) still falls through to C1\'s self-record — closeOrphanedRunningRows correctly finds nothing to close', async () => {
  const tickStartIso = '2026-07-31T12:00:00.000Z';
  const chosen = {
    key: 'us-congress',
    minIntervalMs: 60 * 60 * 1000,
    lastStartedAtIso: '2026-07-28T04:40:00.000Z',
    resolvable: true,
    scriptPath: 'src/cli/ingest.js',
    cliArgs: ['--source', 'us-congress', '--rolls', '284-293'],
    timeoutMs: 8 * 60 * 1000,
    windowMaxKnown: 283,
    wroteSomething: usCongressWroteSomething,
  };
  const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
  const spawnFn = () => ({
    error: Object.assign(new Error('spawnSync ingest.js ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    status: null, stdout: '', stderr: 'stuck fetching member list',
  });

  const result = await runChosenSource(client, chosen, {
    runChildCliFn: (scriptPath, cliArgs, opts) => runChildCli(scriptPath, cliArgs, { ...opts, spawnFn }),
    tickStartIso,
  });

  assert.equal(result.killedByScheduler, true);
  assert.deepEqual(result.killClosedRunIds, [], 'nothing to close — this source never opened a row before the kill');
  assert.equal(result.selfRecordedFailure, true, 'C1\'s existing self-record mechanism must still catch this case');
  assert.equal(result.outcome.status, 'failed');
  assert.equal(result.outcome.healthy, false);
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
    wroteSomething: usCongressWroteSomething,
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
    wroteSomething: moSenateWroteSomething,
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
    wroteSomething: usCongressWroteSomething, // round 3: what buildRegistry actually attaches
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
