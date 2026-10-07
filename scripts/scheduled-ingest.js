// scripts/scheduled-ingest.js — the first unattended, OS-scheduled process in this repo (TODO
// build-queue item 13). Every prior "recurring" ingestion was a bash loop inside a Claude Code
// session: it died the moment the session ended, so data staleness was real. This script is meant
// to be registered with Windows Task Scheduler (registration itself is Lance's own step — see
// docs/SCHEDULED_INGESTION.md — never run schtasks from an agent) and to run forever, unattended,
// with no human watching a single invocation. That changes the design bar entirely:
//
//   - NEVER CALLS A MODEL. This file imports no Anthropic client, no lib/summarizer.js, no
//     lib/verifier.js — nothing that can bill Lance's account. It only ever spawns the five
//     read-mostly ingestion CLIs below plus scripts/refresh-aggregates.js. This comment, and the
//     import list actually enforcing it, are the whole guarantee — verify by inspection any time
//     this file changes.
//   - INCAPABLE OF VIOLATING A PUBLISHED RATE LIMIT. The two MO cadences (MO_SENATE_MIN_INTERVAL_MS,
//     MO_HOUSE_MIN_INTERVAL_MS) are imported verbatim from the adapters that already encode
//     senate.mo.gov's/house.mo.gov's real published terms — never redefined here, never
//     env-overridable, so a typo'd environment variable cannot shorten them. The intervals this
//     script DOES get to choose (us-congress, us-senate, legiscan) are env-overridable but
//     mechanically floored at a conservative minimum (envIntervalMs) — configurable upward only.
//   - INCAPABLE OF STACKING OVERLAPPING PROCESSES. A single-instance, ownership-checked lock file
//     (.superpowers/artifacts/scheduler.lock.json) is required before anything else happens; a
//     live lock means "already running," logged and exited 0 — an overlapping tick is expected
//     (Task Scheduler is recommended at a 15-min cadence, shorter than every source's own
//     interval, see docs/SCHEDULED_INGESTION.md) and must never read as a scheduler failure. Every
//     child process runs under a PER-SOURCE bounded timeout (fix round 2 — see CHILD_TIMEOUT_MS/
//     LEGISCAN_CHILD_TIMEOUT_MS; legiscan alone can legitimately run up to 75 minutes on a real
//     dataset-hash change, evidenced from real ingestion_runs history), and the lock itself
//     carries THAT source's own declared max duration (updateLockMaxDuration, written after
//     selection, before spawn) — so the stale-reclaim window judges each run against its own real
//     bound rather than one fixed number, which is what makes the lock's ownership check
//     (nonce-based, fix round 1 — see acquireLock/releaseLock) actually sufficient rather than
//     theoretical. A forceful kill (timeout or buffer overflow) that strands a source's own
//     ingestion_runs row at status='running' is closed honestly afterward, scoped to only the
//     rows this exact tick could have created (fix round 2 — see closeOrphanedRunningRows).
//   - INCAPABLE OF LETTING ONE FAILING SOURCE STARVE THE OTHERS. The ingest CLIs do not exit when
//     their ToU cooldown hasn't elapsed — they SLEEP until it has (enforceDurableCooldown,
//     ingest-mo-senate.js:446; same pattern in ingest-mo-house.js) — so this script decides
//     due-ness itself, BEFORE ever launching a child, by importing the exported
//     remainingCooldownMs and querying ingestion_runs directly. But `ingest.js` (us-congress/
//     us-senate) does real network work BEFORE it ever calls openRun — a persistent upstream
//     failure there would otherwise leave NO ingestion_runs row, freezing that source's due-ness
//     signal and letting it monopolize every future tick forever (fix round 1, finding C1). So
//     after every live run this script re-checks whether a new row actually appeared for the
//     chosen source; if not, it writes its own HONEST failed attempt row (never a fake success) —
//     see runChosenSource/recordSchedulerAttemptFailure below.
//   - Leaves an honest, dated (UTC) log a human can read to confirm it is alive (see writeLog /
//     npm run status's freshness block).
//
// Entry: node --env-file=.env scripts/scheduled-ingest.js [--dry-run] [--only <source>]

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

import { selectAll, openRun, closeRun } from '../src/lib/db.js';
// Reused, not reimplemented (brief's own explicit instruction): the exact arithmetic every ingest
// CLI's own enforceDurableCooldown already relies on — generic (lastStartedAtIso, minIntervalMs,
// now), not specific to any one source; used here for all five registry sources' due-ness.
// Senior engineering audit (2026-08-03, finding 17): this used to import straight from
// ingest-mo-senate.js — a 1,322-line CLI file, meaning this production scheduler's own due-ness
// computation for ALL FIVE sources depended on undeclared identity with whichever copy of this
// logic happened to live in that one chamber's CLI. Now sourced from src/lib, where both
// ingest-mo-house.js and ingest-mo-senate.js get it from too — one definition, not a convention.
import { remainingCooldownMs, formatCooldownWait } from '../src/lib/durable-cooldown.js';
import { MO_SENATE_MIN_INTERVAL_MS } from '../src/adapters/mo-senate-web.js';
import { MO_HOUSE_MIN_INTERVAL_MS, DEFAULT_MO_HOUSE_SESSION } from '../src/adapters/mo-house-xml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Computed from this file's own location, NEVER from process.cwd() — Task Scheduler's default
// working directory is not guaranteed to be the repo root (docs/SCHEDULED_INGESTION.md recommends
// setting "Start in" anyway, but this script does not depend on it either way).
export const REPO_ROOT = path.join(__dirname, '..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, '.superpowers', 'artifacts');
const LOCK_PATH = path.join(ARTIFACTS_DIR, 'scheduler.lock.json');
// UTC-dated (entry.timestamp is an ISO-Z string sliced at 0,10) — see docs/SCHEDULED_INGESTION.md
// for why "today's file" needs a UTC caveat in any timezone west of Greenwich (fix round 1, M1).
const LOG_DIR = path.join(ARTIFACTS_DIR, 'scheduler-logs');

// Stale-lock reclaim threshold. A normal invocation is one child CLI at --limit 1 (cooldown
// already confirmed elapsed by this script, so the child's own enforceDurableCooldown should not
// actually sleep) plus, sometimes, one refresh-aggregates.js call — realistically seconds, well
// under a minute. 10 minutes is a generous ceiling for slow network/retries while staying safely
// below the 15-minute recommended Task Scheduler tick, so a genuinely crashed/killed prior run
// cannot wedge the schedule for more than one missed tick.
export const MAX_RUN_DURATION_MS = 10 * 60 * 1000;

// I2 (fix round 1): explicit timeout so a stalled child cannot hang the scheduler — and therefore
// hold the lock — indefinitely, which was precisely the precondition I1's ownership-blind
// releaseLock() turned into unbounded process stacking. This is the DEFAULT, used by the four
// sources whose real observed durations never came close to it (mo-senate-web max 9.6s observed
// across 151 historical runs; us-congress/us-senate max well under a minute across their small
// sample; mo-house-xml's apparent ~30-min outliers turned out to be enforceDurableCooldown
// SLEEPING out the old manual-loop's premature invocations — exact 1800.0s multiples in
// ingestion_runs, not real work, and structurally impossible under this scheduler's own due-ness
// gate, which never invokes a CLI before its cooldown has elapsed).
export const CHILD_TIMEOUT_MS = 8 * 60 * 1000; // 8 min

// Round 2 fix: legiscan needed its own, much larger timeout. Real ingestion_runs history showed
// its runs against the scheduler's actual target session ('261', legiscan_session_id 2239) took
// 449.3s and 475.7s — uncomfortably close to the old single 480s (8 min) budget — and a separate
// historical run (a real dataset-hash-changed reprocessing, not a cheap hash-match skip) took
// 3168.5s (~52.8 min). 75 minutes (4500s) is that observed max plus ~40% headroom
// (3168.5 * 1.4 ≈ 4436s), rounded up. A per-source timeoutMs field (see buildRegistry) is what
// makes this safe to raise for just this one source without loosening the default for the rest.
export const LEGISCAN_CHILD_TIMEOUT_MS = 75 * 60 * 1000; // 75 min — see derivation above

// Round 2 fix: the lock's own declared max duration (see acquireLock/updateLockMaxDuration) is
// the chosen source's timeoutMs PLUS this grace — cleanup after a timeout-kill (closing an
// orphaned 'running' row, writing the log) takes at most a few seconds, but a small buffer keeps
// the stale-reclaim window from being able to fire in the split second between spawnSync's own
// kill and this process's cleanup finishing.
export const LOCK_GRACE_MS = 60 * 1000; // 1 min

// Round 3, NEW-2: an upper ceiling on a lock's declared maxDurationMs. Without this, isLockStale's
// only validation was "finite and positive" — a lock somehow declaring an absurd value (hand-edited,
// or a future bug) would be honored as-is and never go stale, permanently wedging every future tick
// into "already-running" + exit 0, indistinguishable in Task Scheduler's history from a healthy
// quiet period. 2 hours comfortably exceeds LEGISCAN_CHILD_TIMEOUT_MS + LOCK_GRACE_MS (the largest
// legitimate declared duration today, 76 min) while still being a real, enforced ceiling — a
// declared duration beyond this is treated exactly like a missing/corrupt one (isLockStale falls
// back to fallbackMaxDurationMs).
export const MAX_LOCK_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours

// Round 3, NEW-4: tolerance subtracted from tickStartIso before scoping closeOrphanedRunningRows —
// see runChosenSource's own comment at the call site for the full safety argument (every registry
// interval is >=30 min, so this cannot capture pre-existing history).
export const ORPHAN_CLOSE_SKEW_GRACE_MS = 5 * 60 * 1000; // 5 min

// M2 (fix round 1): Node's spawnSync default maxBuffer (1 MB) is small enough that a chatty child
// (the ingest CLIs have 2-11 console.error progress lines) could overflow it, which SILENTLY
// kills the child and reports ENOBUFS as `result.error` — runChildCli used to fold that into the
// same "could not launch" message as a bad path, which is a misdiagnosis on the one process
// nobody is watching. 16 MB is generous headroom; overflow is now reported with its own distinct
// message (see runChildCli).
export const CHILD_MAX_BUFFER = 16 * 1024 * 1024;

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

// envIntervalMs: the mechanical floor behind US_CONGRESS_MIN_INTERVAL_MS/US_SENATE_MIN_INTERVAL_MS/
// LEGISCAN_MIN_INTERVAL_MS below — these intervals are OUR OWN conservative policy choice
// (Congress.gov and LegiScan publish no per-request cadence the way house.mo.gov/senate.mo.gov
// do), so, unlike the two MO constants above, they are env-overridable. But an override can only
// raise the interval, never lower it below the floor — a bad or typo'd env value can only make
// this script MORE conservative, never less.
export function envIntervalMs(envVar, defaultMs, floorMs) {
  const raw = Number(process.env[envVar]);
  const configured = Number.isFinite(raw) && raw > 0 ? raw : defaultMs;
  return Math.max(configured, floorMs);
}

// us-congress / us-senate: no published rate limit exists to violate (Congress.gov's/senate.gov's
// own polite limiters are already enforced inside src/adapters/us-congress.js's congressLimiter /
// us-senate.js's senateLimiter) — >=1h is this script's own conservative choice, since new roll
// calls arrive on a legislative-day cadence, not continuously. Separate env vars per source (same
// "own named interval per registry entry" convention as every other source here), same family.
export const US_CONGRESS_MIN_INTERVAL_MS = envIntervalMs('US_CONGRESS_MIN_INTERVAL_MS', ONE_HOUR_MS, ONE_HOUR_MS);
export const US_SENATE_MIN_INTERVAL_MS = envIntervalMs('US_SENATE_MIN_INTERVAL_MS', ONE_HOUR_MS, ONE_HOUR_MS);
// legiscan: datasets refresh weekly (Sunday 5am ET per docs/research/2026-07-28-legiscan-terms.md)
// — >=24h is deliberately far more frequent than strictly necessary, still cheap because
// ingest-legiscan.js's own dataset_hash gate (⛔ suspension-level rule, decodeDatasetHashGate)
// makes a same-dataset invocation a single cheap list-check, not a real download.
export const LEGISCAN_MIN_INTERVAL_MS = envIntervalMs('LEGISCAN_MIN_INTERVAL_MS', ONE_DAY_MS, ONE_DAY_MS);

// Matches the hardcoded convention already used throughout this repo (ingest.js,
// backfill-federal-names.js, enrich-federal-bills.js all hardcode 119) — no dynamic
// "current congress" formula exists anywhere in this codebase; update all four together when the
// 120th Congress convenes.
export const US_CONGRESS_CONGRESS = 119;
// Senate.gov numbers each Congress's two annual sessions 1/2 by calendar year (119th Congress:
// session 1 = 2025, session 2 = 2026) — same hardcoded-"current" convention as the congress
// number above; update alongside it when the session rolls over.
export const US_SENATE_SESSION = 2;
// Small, conservative forward-delta window past the highest roll/vote number already on file —
// see resolveUsCongressRollWindow/resolveUsSenateVoteWindow's own comments for why this is safe
// to overlap/overshoot.
export const US_CONGRESS_ROLL_WINDOW = 10;
export const US_SENATE_VOTE_WINDOW = 10;

const SOURCE_KEYS = ['mo-senate-web', 'mo-house-xml', 'us-congress', 'us-senate', 'legiscan'];

// ---- pure: args ----

export function parseArgs(argv) {
  const out = { dryRun: false, only: null };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') {
      out.dryRun = true;
      i += 1;
      continue;
    }
    if (key === '--only') {
      out.only = argv[i + 1];
      if (!SOURCE_KEYS.includes(out.only)) {
        throw new Error(`unknown source: ${out.only} (expected one of ${SOURCE_KEYS.join(', ')})`);
      }
      i += 2;
      continue;
    }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

// ---- pure: single-instance lock (I1 fix round 1: ownership-checked via nonce; round 2: the
// stale-reclaim window is the LOCK'S OWN declared duration, not one fixed constant) ----

// isLockStale (round 2): a fixed 10-minute stale-reclaim window and a legiscan run that can
// legitimately need 75 minutes cannot coexist — a tick at +15 min would reclaim a still-live
// legiscan lock, starting a SECOND concurrent child, exactly the stacking I1 closed. So the lock
// itself carries `maxDurationMs` (written by acquireLock, updated by updateLockMaxDuration once
// the chosen source — and therefore its real timeout — is known), and staleness is judged against
// THAT declared value. `fallbackMaxDurationMs` (still MAX_RUN_DURATION_MS by default) is used
// whenever the lock has no VALID `maxDurationMs` of its own — missing, corrupt, non-numeric,
// non-positive, or (round 3, NEW-2) beyond MAX_LOCK_DURATION_MS — which is the fail-safe
// direction: an unrecognized OR out-of-range lock is judged by the conservative 10-minute
// default, never trusted to mean "wait indefinitely."
export function isLockStale(lock, nowMs, fallbackMaxDurationMs = MAX_RUN_DURATION_MS) {
  const startedMs = Date.parse(lock.startedAt);
  if (!Number.isFinite(startedMs)) return true; // unparseable timestamp — never trusted, treated as stale
  const declared = Number(lock.maxDurationMs);
  // Round 3, NEW-2: a declared duration beyond MAX_LOCK_DURATION_MS is treated exactly like a
  // missing/corrupt one — an out-of-range value (hand-edited lock file, a future bug) must never
  // be honored as "never go stale."
  const maxDurationMs = Number.isFinite(declared) && declared > 0 && declared <= MAX_LOCK_DURATION_MS
    ? declared
    : fallbackMaxDurationMs;
  return nowMs - startedMs > maxDurationMs;
}

// acquireLock: an atomic create ('wx' — fails with EEXIST if the file already exists) is tried
// first, closing the check-then-act race a plain existsSync()-then-writeFileSync() pair would
// leave open between two schedulers starting within milliseconds of each other. Falls back to
// reading the existing lock only on EEXIST; a corrupt/unreadable lock is treated exactly like a
// stale one (reclaimed + the caller logs a warning) rather than either trusting it blindly or
// crashing — a half-written lock from a killed process must not permanently wedge every future
// tick. Every lock this process writes carries a fresh random `nonce` (crypto.randomUUID) — the
// caller MUST thread the returned nonce through to releaseLock, which is the other half of I1's
// fix (see that function).
//
// Round 2: the lock also carries `maxDurationMs`, initialized here to `maxRunDurationMs`
// (MAX_RUN_DURATION_MS by default) — at acquire time the chosen source (and therefore its real
// per-source timeout) isn't known yet, so this initial value only has to cover the SELECTION
// phase (a handful of bounded DB lookups, realistically seconds) and every non-live tick shape
// (nothing-due/already-running/dry-run/blocked, none of which spawn a child at all). The caller
// MUST call updateLockMaxDuration once a source is chosen and BEFORE spawning it, so the
// stale-reclaim window covers that child's REAL declared timeout, not this placeholder.
export function acquireLock(lockPath = LOCK_PATH, { now = Date.now(), maxRunDurationMs = MAX_RUN_DURATION_MS } = {}) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const nonce = randomUUID();
  const payload = JSON.stringify({
    pid: process.pid, startedAt: new Date(now).toISOString(), nonce, maxDurationMs: maxRunDurationMs,
  }, null, 2);

  try {
    writeFileSync(lockPath, payload, { flag: 'wx' });
    return {
      acquired: true, reason: 'fresh', nonce,
    };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  let existing;
  try {
    existing = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    existing = {
      startedAt: new Date(0).toISOString(), pid: null, nonce: null, corrupt: true,
    };
  }
  if (!isLockStale(existing, now, maxRunDurationMs)) {
    return { acquired: false, reason: 'already-running', lock: existing };
  }
  // Stale: a plain overwrite is fine here — the prior owner is already established to be long
  // past any plausible run duration, so losing a 'wx'-style race at this exact point is not a
  // realistic concern.
  writeFileSync(lockPath, payload);
  return {
    acquired: true, reason: 'reclaimed-stale', staleLock: existing, nonce,
  };
}

// releaseLock: ownership-checked (I1, fix round 1) — re-reads the lock and deletes ONLY when its
// nonce matches the one THIS process was given when it acquired the lock. Without this, the
// defect was concrete: tick A takes the lock and its child hangs past MAX_RUN_DURATION_MS; tick B
// reclaims the (now-stale) lock and starts its own child; tick A finally returns and its
// `finally` deletes what it thinks is "its" lock — but that file is now B's, mid-run — leaving no
// lock at all for tick C to find, so THREE children end up running concurrently. A missing file,
// an unreadable/corrupt file, or a present-but-non-matching nonce are all safe no-ops — this
// function must never delete something it cannot prove it owns, and never throws.
export function releaseLock(lockPath = LOCK_PATH, nonce = null) {
  if (!existsSync(lockPath)) return;
  let existing;
  try {
    existing = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return; // corrupt/unreadable — cannot prove ownership, so never delete
  }
  if (!nonce || existing.nonce !== nonce) return; // not (verifiably) ours — leave it alone
  unlinkSync(lockPath);
}

// updateLockMaxDuration (round 2): rewrites the lock's declared `maxDurationMs` once the chosen
// source — and therefore its real per-source timeout — is known, so the stale-reclaim window
// (isLockStale) judges THIS run against its own real bound rather than the generic
// selection-phase placeholder acquireLock wrote. Must be called AFTER source selection and
// BEFORE the child is spawned. Ownership-checked the same way releaseLock is (nonce match) —
// never overwrites a lock this process cannot prove it still owns; a missing/corrupt/
// non-matching lock is a safe no-op (returns false) rather than a throw, since a scheduler that
// somehow lost its own lock between acquiring it and choosing a source has a bigger problem than
// this write failing.
export function updateLockMaxDuration(lockPath = LOCK_PATH, nonce = null, maxDurationMs) {
  if (!existsSync(lockPath)) return false;
  let existing;
  try {
    existing = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return false;
  }
  if (!nonce || existing.nonce !== nonce) return false;
  writeFileSync(lockPath, JSON.stringify({ ...existing, maxDurationMs }, null, 2));
  return true;
}

// ---- pure: due-ness + selection ----

// computeSourceDueness: remainingMs comes straight from the shared, imported remainingCooldownMs
// — never reimplemented. elapsedMs (Infinity for a source with no prior run at all) is the
// separate "how overdue" ranking signal pickMostOverdue uses below; remainingMs alone cannot rank
// two already-due sources against each other since Math.max(0, ...) clamps both to 0.
export function computeSourceDueness(entry, now) {
  const remainingMs = remainingCooldownMs(entry.lastStartedAtIso, entry.minIntervalMs, now);
  const elapsedMs = entry.lastStartedAtIso ? now - Date.parse(entry.lastStartedAtIso) : Infinity;
  return {
    ...entry, remainingMs, elapsedMs, due: remainingMs <= 0,
  };
}

// pickMostOverdue: among due AND resolvable entries (legiscan with no legiscan_session_id on
// file, or any source whose lookup failed this tick — I3 — is due but never resolvable; see
// buildRegistry), the one that has gone longest since its last (or ever) run wins. A source with
// zero prior runs (elapsedMs=Infinity) outranks everything else — seeding an unseen source is the
// most urgent thing to do. Ties keep registry order (reduce never replaces `best` on an equal
// elapsedMs). C1's fix (runChosenSource, below) is what keeps a persistently-failing source from
// winning this EVERY tick forever — see that function's own comment.
export function pickMostOverdue(entries) {
  const candidates = entries.filter((e) => e.due && e.resolvable);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, e) => (e.elapsedMs > best.elapsedMs ? e : best));
}

// ---- pure: us-congress/us-senate probe-window math ----

const US_HOUSE_ROLL_RE = /^us-house-\d+-\d+-(\d+)$/;
const US_SENATE_VOTE_RE = /^us-senate-\d+-\d+-(\d+)$/;

export function parseUsHouseRoll(sourceKey) {
  const m = US_HOUSE_ROLL_RE.exec(String(sourceKey ?? ''));
  return m ? Number(m[1]) : null;
}

export function parseUsSenateVote(sourceKey) {
  const m = US_SENATE_VOTE_RE.exec(String(sourceKey ?? ''));
  return m ? Number(m[1]) : null;
}

export function computeRollWindow(maxKnownRoll, windowSize = US_CONGRESS_ROLL_WINDOW) {
  const base = Number.isFinite(maxKnownRoll) && maxKnownRoll > 0 ? maxKnownRoll : 0;
  // lo starts AT the last known roll, not one past it (2026-08-26 audit, defect D2). Re-probing one
  // roll call we already hold is a CANARY, and it is what separates "no new votes yet" from "the
  // source moved out from under us": if clerk.house.gov changed its URL structure, every roll in a
  // window that only looked PAST the edge would 404, which at the ingest layer is indistinguishable
  // from a recess. The canary must come back 200. Every roll past the edge 404ing is routine; the
  // canary 404ing is a regression (findRegressedAbsences). Re-ingesting a roll already on file is
  // idempotent - insertIfAbsent all the way down - so this costs exactly one extra request a tick.
  return { lo: Math.max(1, base), hi: base + windowSize };
}

// isExpectedTailProbeOutcome (I4a, fix round 1): the probe window is DESIGNED to overshoot — most
// ticks 404 on every roll/vote past the real edge, which is confirmation nothing new has landed
// yet, not a failure. True only when EVERY recorded failure is a roll/vote failure (never a
// bill-detail failure, a different step, or a roll/vote AT OR BELOW the previously-known edge —
// any of those would be a genuine regression) strictly past windowMaxKnown. `failures` is the
// run's own detail.failures array (ingest.js's exact `{step: 'roll <N>'}` / `{step: 'vote <N>'}`
// shape). Returns false (never "expected") for any non-windowed source, or when there are no
// failures to begin with (nothing to explain away).
const TAIL_FAILURE_STEP_RE = {
  'us-congress': /^roll (\d+)$/,
  'us-senate': /^vote (\d+)$/,
};

// highestPresentInWindow — the run's OWN achieved edge, not the one it inherited.
//
// WHY THIS EXISTS (RapidForge review, 2026-10-06). Both judgements below compared a roll number
// against windowMaxKnown, the max BEFORE this run. Take a run probing 313-317 where 315 comes back
// absent and 316 comes back present: 315 > windowMaxKnown(314), so findRegressedAbsences did not
// flag it and isExpectedTailProbeOutcome called it an expected tail. The next window then starts
// past 316, so **315 is never probed again — a real roll call skipped forever, silently.** That is
// not hypothetical for us-congress: clerk.house.gov serves an HTTP 200 "Error sanitizing file" stub
// that says "Please try again", so the same number can be absent on one tick and present on the
// next.
//
// The discriminator is simple and needs no new data: anything missing BELOW a number that came back
// PRESENT in the same run is a hole, never a tail. Scans the probed window downward for the first
// number that is neither absent nor failed. Returns null when nothing in the window was present, in
// which case the inherited edge is all there is to judge against.
//
// Checked when written: 314 House rolls stored for 2026, highest 314, zero missing below it — so the
// hole was reachable but had not yet opened.
export function highestPresentInWindow(sourceKey, { absent, failures, lo, hi }) {
  const re = TAIL_FAILURE_STEP_RE[sourceKey];
  if (!re || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const missing = new Set();
  for (const entry of [...(absent ?? []), ...(failures ?? [])]) {
    const m = re.exec(entry?.step ?? '');
    if (m) missing.add(Number(m[1]));
  }
  for (let n = hi; n >= lo; n -= 1) if (!missing.has(n)) return n;
  return null;
}

export function isExpectedTailProbeOutcome(sourceKey, failures, windowMaxKnown, presentMax = null) {
  const re = TAIL_FAILURE_STEP_RE[sourceKey];
  if (!re || windowMaxKnown === undefined || windowMaxKnown === null) return false;
  if (!failures || failures.length === 0) return false;
  return failures.every((f) => {
    const m = re.exec(f?.step ?? '');
    if (m === null) return false;
    const n = Number(m[1]);
    // A failure below something this run actually fetched is a hole, whatever the inherited edge says.
    if (presentMax !== null && n < presentMax) return false;
    return n > windowMaxKnown;
  });
}

// findRegressedAbsences - the other half of D2's fix, and the reason computeRollWindow now probes
// the canary. ingest.js can tell "the source answered, and says this record does not exist" from
// "we could not get an answer" (isAbsentRecordError), and files the first kind under detail.absent
// instead of detail.failures - which is why a recess tick now closes `succeeded` rather than
// `partial`. What ingest.js CANNOT tell is an expected absence from an alarming one, because only
// the scheduler knows where the real edge is.
//
// That judgement is here: an absence at or below windowMaxKnown means a roll call we already hold
// has vanished from the source. That is never routine - it is the shape a URL-structure change, a
// silently retired endpoint, or an auth change makes - so it forces the tick unhealthy even though
// the child process exited 0 and its run row says `succeeded`.
export function findRegressedAbsences(sourceKey, absent, windowMaxKnown, presentMax = null) {
  const re = TAIL_FAILURE_STEP_RE[sourceKey];
  if (!re || windowMaxKnown === undefined || windowMaxKnown === null) return [];
  return (absent ?? []).filter((a) => {
    const m = re.exec(a?.step ?? '');
    if (m === null) return false;
    const n = Number(m[1]);
    // Below the inherited edge: a record we already hold went missing. Below this run's own achieved
    // edge: a gap under something just fetched. Either is a regression; only the tail is expected.
    return n <= windowMaxKnown || (presentMax !== null && n < presentMax);
  });
}

// wroteSomething predicates (round 3, NEW-1 fix): ONE PER REGISTRY SOURCE, each source declaring
// how to read ITS OWN real close-detail shape — attached to its registry entry below (buildRegistry)
// and invoked as `chosen.wroteSomething(detail, status)` from runChosenSource. This replaces
// the single fix-round-1 `countsShowRowsWritten(sourceKey, detail)`, whose fallthrough
// `detail.counts.votes` was WRONG for legiscan: measured against all 52 real legiscan
// `ingestion_runs` rows, it evaluated true for ZERO of them, so refresh-aggregates.js never fired
// after a legiscan run — a real regression (pre-fix-round-1, the refresh always fired) that
// silently reintroduced the exact 2026-07-31 chart-drift defect for the single largest vote writer
// in the database (legiscan is 82.3% of all `votes` rows). The fix-round-1 comment here claimed
// "verified against each one's real closeRun() call site, not guessed" — true for four of five,
// but legiscan's mapping was inferred by analogy with the other four, not actually measured, and
// the inference was wrong. This round's version really was checked against real fixture rows
// (tests/scheduled-ingest.test.js pulls them from live `ingestion_runs`) for all five.
//
// Every predicate below FAILS OPEN (returns true) for a succeeded/partial run whose detail
// doesn't match its own expected shape — refreshing anyway is the accepted-safe direction (cheap,
// idempotent SQL); silently never refreshing is the one this whole mechanism exists to prevent.
// A 'failed' run never fails open (nothing to refresh after a genuine failure) — the accepted risk
// is "occasionally refresh when nothing changed," not "refresh after every failure too."
export function moSenateWroteSomething(detail, status) {
  const votes = detail?.counts?.votes;
  if (typeof votes === 'number') return votes > 0;
  return status === 'succeeded' || status === 'partial';
}

export function usCongressWroteSomething(detail, status) {
  const votes = detail?.counts?.votes;
  if (typeof votes === 'number') return votes > 0;
  return status === 'succeeded' || status === 'partial';
}

export function usSenateWroteSomething(detail, status) {
  const votes = detail?.counts?.votes;
  if (typeof votes === 'number') return votes > 0;
  return status === 'succeeded' || status === 'partial';
}

// mo-house-xml: unchanged shape from round 1 (re-verified against real fixtures this round,
// including all 5 real 'bill-xml' rows on file — every real 'rollcall-pdf' row on file already
// checked by the reviewer's own re-review). document_type-dependent — the rollcall-pdf branch
// writes CASTS (detail.rollCallResult.castCount, a SIBLING of counts, not inside it — see
// processRollCallPdf's return shape), the bill-xml branch writes BILL rows
// (detail.counts.bills_detailed). Falls open for a document_type this predicate doesn't
// recognize (a future third branch) rather than assuming nothing was written.
export function moHouseWroteSomething(detail, status) {
  const documentType = detail?.counts?.document_type;
  if (documentType === 'rollcall-pdf') {
    const castCount = detail?.rollCallResult?.castCount;
    if (typeof castCount === 'number') return castCount > 0;
  } else if (documentType === 'bill-xml') {
    const billsDetailed = detail?.counts?.bills_detailed;
    if (typeof billsDetailed === 'number') return billsDetailed > 0;
  }
  return status === 'succeeded' || status === 'partial';
}

// legiscan (the actual NEW-1 fix): `ingest-legiscan.js`'s own `buildSuccessCloseDetail` (that
// file's own :961-963) is `return {...counts, attribution, queries_used: counts.queriesUsed}` —
// it spreads `result.counts` at the TOP LEVEL of `detail`, never nested under a `.counts` key.
// Verified against all 50 real `ingest-legiscan.js` rows on file: `detail.votes` (top-level) is a
// genuine, reliable counter, observed 0-659 — this is the honest signal the old code's
// `detail.counts.votes` lookup could never have matched (there is no `detail.counts` for this
// CLI's own runs at all, which is the actual root cause of NEW-1's 0/52).
//
// UPDATE (TODO-33, .superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md): at the time
// this predicate was written, `src/cli/ingest-legiscan-texts.js` ALSO wrote to `source='legiscan'`
// (its own header comment used to say so explicitly, "SAME source as ingest-legiscan.js") — a
// manual texts run between scheduler ticks could pollute `queryLatestRun`'s read for
// source='legiscan' with that CLI's own COMPLETELY different, votes-unrelated close-detail shape
// (billsPlanned/docCacheHits/alreadyHasVersion/... — text-cache counters, nested under
// `detail.counts`, no votes field anywhere), which this predicate would see with no honest votes
// signal to read, falling through to the same fail-open default as any unrecognized shape — accepted
// at the time as fail-safe (delay only, never skip or advance) but a real, unnecessary imprecision.
// TODO-33 gives `ingest-legiscan-texts.js` its own distinct `source='legiscan-texts'` label going
// forward (with the historical rows relabeled too) — this scenario can no longer happen: every row
// this predicate ever reads for source='legiscan' is now genuinely, exclusively an
// `ingest-legiscan.js` row. `legiscanWroteSomething`'s own final fallback (below) stays exactly as
// it was — defensive, in case a SIXTH source is ever added without its own predicate wired in — that
// is a different, still-valid concern, unrelated to this one now-closed scenario. SOURCE_KEYS
// (below) and this registry's own scheduling logic are untouched: the scheduler never invoked
// `ingest-legiscan-texts.js` before this fix and still doesn't — only what THAT CLI itself writes to
// `ingestion_runs.source` has changed.
export function legiscanWroteSomething(detail, status) {
  const votes = detail?.votes;
  if (typeof votes === 'number') return votes > 0;
  return status === 'succeeded' || status === 'partial';
}

// defaultWroteSomething: fail-open fallback for a registry entry with no predicate wired at all
// (should never happen with the five fixed entries below — defensive only, e.g. against a future
// sixth source added without also wiring its own predicate).
export function defaultWroteSomething(detail, status) {
  return status === 'succeeded' || status === 'partial';
}

// ---- DB-facing helpers ----

export async function queryLatestStartedAt(client, source) {
  const { data, error } = await client
    .from('ingestion_runs')
    .select('started_at')
    .eq('source', source)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`ingestion_runs lookup failed for source=${source}: ${error.message}`);
  return data ? data.started_at : null;
}

// queryLatestRun: same query as queryLatestStartedAt but the FULL row (status + detail), used by
// runChosenSource (C1/I4, fix round 1) to (a) detect whether a genuinely new row appeared after
// invoking a child, and (b) read that row's own honest status/counts/failures rather than trust
// the child's stdout alone (which can be absent entirely on a hard crash).
export async function queryLatestRun(client, source) {
  const { data, error } = await client
    .from('ingestion_runs')
    .select('started_at,status,detail')
    .eq('source', source)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`ingestion_runs lookup failed for source=${source}: ${error.message}`);
  return data ?? null;
}

// resolveLegiscanSessionId: reuses mo-house-xml.js's OWN DEFAULT_MO_HOUSE_SESSION as "the current
// MO session identifier" — never a second, separately-maintained notion of "current" — and looks
// up that session's legiscan_session_id column directly by key. Returns null (never a guess, never
// an ORDER BY/"most recent" heuristic over `sessions`) when that row or its legiscan_session_id
// doesn't exist yet. TODO.md item 25 documents a real, currently-open duplicate-MO-session defect
// in this exact area of the data model; guessing here is exactly the kind of thing that could make
// it worse. The registry (below) treats a null result as "not configured" and skips legiscan
// honestly rather than risk feeding that defect a second way.
export async function resolveLegiscanSessionId(client) {
  const { data, error } = await client
    .from('sessions')
    .select('legiscan_session_id')
    .eq('jurisdiction_id', 'mo-legislature')
    .eq('identifier', DEFAULT_MO_HOUSE_SESSION)
    .maybeSingle();
  if (error) throw new Error(`sessions lookup failed for legiscan_session_id: ${error.message}`);
  return data && data.legiscan_session_id != null ? data.legiscan_session_id : null;
}

// resolveUsCongressRollWindow: src/cli/ingest.js has no built-in delta mode (--rolls is a
// caller-chosen explicit range) and this source had never had scheduled ingestion (brief) — this
// is the scheduler's own minimal, honest "what's new" computation: the highest US House roll
// number already on file for this congress+year, plus a small forward window. Every candidate roll
// in that window that doesn't exist yet simply 404s inside collectUsCongress (a typed, non-fatal
// SourceFetchError recorded in failures[] — see ingest.js's own per-roll try/catch) and every roll
// that already exists is a harmless insertIfAbsent no-op (votes.source_key is the conflict key) —
// so overlapping an already-ingested roll, or probing one that hasn't happened yet, is always
// safe, just occasionally wasted requests against Congress.gov's own already-polite limiter (see
// I4a — that tolerance is now correctly reported as healthy, not a failure). Routed through
// selectAll (project law: no bare .select() on a multi-row table). Returns maxKnown alongside
// {lo,hi} so callers (buildRegistry) can pass it through for I4a's tail-probe classification.
export async function resolveUsCongressRollWindow(client, {
  congress = US_CONGRESS_CONGRESS, year, windowSize = US_CONGRESS_ROLL_WINDOW,
} = {}) {
  const prefix = `us-house-${congress}-${year}-`;
  const { data, error } = await selectAll(client, 'votes', 'source_key', {
    filter: (q) => q.eq('jurisdiction_id', 'us-congress').like('source_key', `${prefix}%`),
  });
  if (error) throw new Error(`votes lookup failed for us-congress roll window: ${error.message}`);
  const maxKnown = (data ?? [])
    .map((r) => parseUsHouseRoll(r.source_key))
    .filter((n) => n !== null)
    .reduce((max, n) => Math.max(max, n), 0);
  return { ...computeRollWindow(maxKnown, windowSize), maxKnown };
}

// resolveUsSenateVoteWindow (I5, fix round 1): same rationale as resolveUsCongressRollWindow
// above — ingest.js's us-senate path ALSO has no delta mode, and omitting --votes entirely means
// "refetch and reparse the WHOLE session's vote menu" (hundreds of XML fetches), clearly wrong
// for a scheduled tick. jurisdiction_id is 'us-congress' for Senate rows too (see
// persistUsSenate) — only source_key's own 'us-senate-' prefix distinguishes chamber.
export async function resolveUsSenateVoteWindow(client, {
  congress = US_CONGRESS_CONGRESS, session = US_SENATE_SESSION, windowSize = US_SENATE_VOTE_WINDOW,
} = {}) {
  const prefix = `us-senate-${congress}-${session}-`;
  const { data, error } = await selectAll(client, 'votes', 'source_key', {
    filter: (q) => q.eq('jurisdiction_id', 'us-congress').like('source_key', `${prefix}%`),
  });
  if (error) throw new Error(`votes lookup failed for us-senate vote window: ${error.message}`);
  const maxKnown = (data ?? [])
    .map((r) => parseUsSenateVote(r.source_key))
    .filter((n) => n !== null)
    .reduce((max, n) => Math.max(max, n), 0);
  return { ...computeRollWindow(maxKnown, windowSize), maxKnown };
}

// safeLookup (I3, fix round 1): wraps ONE DB lookup so a rejection degrades to {ok:false, error}
// instead of rejecting the whole buildRegistry() call. Previously all six (now eight) lookups ran
// inside a single Promise.all — one Supabase hiccup on ANY of them (a transient network blip, an
// RLS/permissions change, anything) rejected the whole thing, propagated out of main(), and
// exited 1 with NO source run that tick — directly contradicting the doc's "does not block the
// other sources" claim, which was true only for the null/not-configured path, not a thrown error.
async function safeLookup(shouldRun, fn) {
  if (!shouldRun) return { ok: true, value: null }; // M3: not needed this tick (--only excludes it) — never attempted
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function skipReason(result) {
  return result.ok ? null : `skipped this tick: ${result.error.message}`;
}

// ---- registry ----
//
// Each entry: { key, minIntervalMs, lastStartedAtIso, resolvable, unresolvedReason, scriptPath,
// cliArgs, timeoutMs, windowMaxKnown? }. scriptPath is repo-root-relative, matching every
// "node --env-file=.env <path>" npm script already in package.json. `only` (M3, fix round 1)
// skips every lookup not needed for the requested source, rather than running all eight and
// discarding six of them every tick. `timeoutMs` (round 2) is CHILD_TIMEOUT_MS for every source
// except legiscan, which gets LEGISCAN_CHILD_TIMEOUT_MS — see that constant's own comment for the
// real-duration evidence behind the 75-minute figure.
export async function buildRegistry(client, { now = Date.now(), year = new Date(now).getFullYear(), only = null } = {}) {
  const need = (key) => !only || only === key;

  const [
    moSenateLast, moHouseLast, usCongressLast, usSenateLast, legiscanLast,
    legiscanSessionId, rollWindow, voteWindow,
  ] = await Promise.all([
    safeLookup(need('mo-senate-web'), () => queryLatestStartedAt(client, 'mo-senate-web')),
    safeLookup(need('mo-house-xml'), () => queryLatestStartedAt(client, 'mo-house-xml')),
    safeLookup(need('us-congress'), () => queryLatestStartedAt(client, 'us-congress')),
    safeLookup(need('us-senate'), () => queryLatestStartedAt(client, 'us-senate')),
    safeLookup(need('legiscan'), () => queryLatestStartedAt(client, 'legiscan')),
    safeLookup(need('legiscan'), () => resolveLegiscanSessionId(client)),
    safeLookup(need('us-congress'), () => resolveUsCongressRollWindow(client, { year })),
    safeLookup(need('us-senate'), () => resolveUsSenateVoteWindow(client, {})),
  ]);

  const legiscanResolvedId = legiscanSessionId.ok ? legiscanSessionId.value : null;
  const legiscanResolvable = legiscanLast.ok && legiscanSessionId.ok && legiscanResolvedId != null;

  return [
    {
      key: 'mo-senate-web',
      minIntervalMs: MO_SENATE_MIN_INTERVAL_MS,
      lastStartedAtIso: moSenateLast.ok ? moSenateLast.value : null,
      resolvable: moSenateLast.ok,
      unresolvedReason: skipReason(moSenateLast),
      scriptPath: 'src/cli/ingest-mo-senate.js',
      cliArgs: ['--year', String(year), '--limit', '1'],
      timeoutMs: CHILD_TIMEOUT_MS,
      wroteSomething: moSenateWroteSomething,
    },
    {
      key: 'mo-house-xml',
      minIntervalMs: MO_HOUSE_MIN_INTERVAL_MS,
      lastStartedAtIso: moHouseLast.ok ? moHouseLast.value : null,
      resolvable: moHouseLast.ok,
      unresolvedReason: skipReason(moHouseLast),
      scriptPath: 'src/cli/ingest-mo-house.js',
      // RESTRICTION (TODO 31 — do not violate): current-session ingestion ONLY. mo_house_id is
      // declared table-wide `unique` (migration 0005) against a current-only roster, so a
      // historical/multi-era backfill would silently misattribute a successor's votes to their
      // predecessor. NEVER add --session (or any year/era flag) here — --limit 1 alone lets the
      // CLI fall through to its own DEFAULT_MO_HOUSE_SESSION, which is the current session.
      cliArgs: ['--limit', '1'],
      timeoutMs: CHILD_TIMEOUT_MS,
      wroteSomething: moHouseWroteSomething,
    },
    {
      key: 'us-congress',
      minIntervalMs: US_CONGRESS_MIN_INTERVAL_MS,
      lastStartedAtIso: usCongressLast.ok ? usCongressLast.value : null,
      resolvable: usCongressLast.ok && rollWindow.ok && rollWindow.value != null,
      unresolvedReason: skipReason(usCongressLast) ?? skipReason(rollWindow),
      scriptPath: 'src/cli/ingest.js',
      // rollWindow.value is null both on a genuine failure (rollWindow.ok===false, handled by
      // skipReason above) AND on a lookup skipped outright because --only excluded this source
      // (rollWindow.ok===true, value:null, per safeLookup) — either way, no real window exists to
      // build --rolls from, so cliArgs must stay empty rather than dereference a null value.
      cliArgs: rollWindow.value != null
        ? ['--source', 'us-congress', '--year', String(year), '--rolls', `${rollWindow.value.lo}-${rollWindow.value.hi}`]
        : [],
      timeoutMs: CHILD_TIMEOUT_MS,
      windowMaxKnown: rollWindow.value != null ? rollWindow.value.maxKnown : undefined,
      windowLo: rollWindow.value != null ? rollWindow.value.lo : undefined,
      windowHi: rollWindow.value != null ? rollWindow.value.hi : undefined,
      wroteSomething: usCongressWroteSomething,
    },
    {
      key: 'us-senate',
      minIntervalMs: US_SENATE_MIN_INTERVAL_MS,
      lastStartedAtIso: usSenateLast.ok ? usSenateLast.value : null,
      resolvable: usSenateLast.ok && voteWindow.ok && voteWindow.value != null,
      unresolvedReason: skipReason(usSenateLast) ?? skipReason(voteWindow),
      scriptPath: 'src/cli/ingest.js',
      cliArgs: voteWindow.value != null
        ? ['--source', 'us-senate', '--session', String(US_SENATE_SESSION), '--votes', `${voteWindow.value.lo}-${voteWindow.value.hi}`]
        : [],
      timeoutMs: CHILD_TIMEOUT_MS,
      windowMaxKnown: voteWindow.value != null ? voteWindow.value.maxKnown : undefined,
      windowLo: voteWindow.value != null ? voteWindow.value.lo : undefined,
      windowHi: voteWindow.value != null ? voteWindow.value.hi : undefined,
      wroteSomething: usSenateWroteSomething,
    },
    {
      key: 'legiscan',
      minIntervalMs: LEGISCAN_MIN_INTERVAL_MS,
      lastStartedAtIso: legiscanLast.ok ? legiscanLast.value : null,
      resolvable: legiscanResolvable,
      unresolvedReason: skipReason(legiscanLast) ?? skipReason(legiscanSessionId) ?? (legiscanResolvedId == null
        ? `no legiscan_session_id on file for MO session '${DEFAULT_MO_HOUSE_SESSION}' (sessions.legiscan_session_id) — `
          + 'see TODO.md item 25; not guessed, skipped honestly until resolved'
        : null),
      scriptPath: 'src/cli/ingest-legiscan.js',
      // ⛔ dataset_hash comparison happens INSIDE ingest-legiscan.js (decodeDatasetHashGate) —
      // never re-implemented here. This registry entry only ever supplies --session; the
      // suspension-level gate itself is entirely the CLI's own responsibility, invoked, not
      // reimplemented.
      cliArgs: legiscanResolvedId != null ? ['--session', String(legiscanResolvedId)] : [],
      timeoutMs: LEGISCAN_CHILD_TIMEOUT_MS,
      wroteSomething: legiscanWroteSomething,
    },
  ];
}

// ---- process orchestration ----

function defaultSpawn(command, args, options) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

// runChildCli: every ingestion CLI in this repo (and refresh-aggregates.js) speaks the same "API"
// — one console.log(JSON.stringify(...)) as its terminal line to stdout, progress on stderr, the
// same repo-wide main() convention verified across all registry sources. No CLI in this repo
// exports its main() (checked before writing this file), so a child process — not an in-process
// import — is the only way to invoke one. spawnFn is injectable so tests never launch a real
// subprocess against real network/DB state; the real default really does spawn `node
// --env-file=.env <scriptPath> ...cliArgs`, matching every "node --env-file=.env ..." npm script.
//
// timeoutMs (round 2): per-call, defaulting to CHILD_TIMEOUT_MS — the caller (runChosenSource)
// passes the CHOSEN SOURCE's own registry.timeoutMs, so legiscan's 75-minute budget is honored
// without loosening the 8-minute default every other source uses.
// `--env-file=.env` is passed ONLY when that file actually exists, and the reason is a cutover
// blocker found in review 2026-08-29 before it could bite.
//
// Node treats a missing --env-file as fatal: `node --env-file=missing.env -e 1` prints
// "missing.env: not found" and EXITS 9 — it never runs the script. On a GitHub Actions runner there
// is no .env: it is gitignored and no workflow step writes one. So once the pre-cutover guard
// opened, the scheduler itself would have started fine (it reads process.env directly) while EVERY
// child CLI — the part that actually reads CONGRESS_API_KEY and writes ingestion_runs — died at
// spawn. The health check would have reported every source BROKEN after three ticks, which is
// honest, but the cutover's "one real run wrote to the DB" could never have been reached.
//
// Dropping the flag when the file is absent is the smallest fix and the only one that does not make
// things worse: a child spawned WITHOUT an `env` option inherits process.env (verified), so on the
// runner the secrets already reach it through the environment. The alternative of having the
// workflow write a .env from secrets would materialise the service-role key to disk on the runner —
// the exact thing this migration exists to stop doing.
//
// envFileExists is injectable so tests can pin BOTH branches without depending on the filesystem.
export function runChildCli(scriptPath, cliArgs, {
  cwd = REPO_ROOT, spawnFn = defaultSpawn, timeoutMs = CHILD_TIMEOUT_MS,
  envFileExists = existsSync(path.join(cwd, '.env')),
} = {}) {
  const args = envFileExists
    ? ['--env-file=.env', scriptPath, ...cliArgs]
    : [scriptPath, ...cliArgs];
  const result = spawnFn(process.execPath, args, {
    cwd, timeout: timeoutMs, maxBuffer: CHILD_MAX_BUFFER,
  });
  if (result.error) {
    // I2: a timeout throws here too now (result.error.code === 'ETIMEDOUT', result.killed true) —
    // this IS a real scheduler-level condition, distinctly reported so it is never confused with
    // a bad path. M2: a maxBuffer overflow (ENOBUFS) also lands here and gets its own message
    // instead of the misleading "could not launch". Both are tagged with `.code` and (for
    // ETIMEDOUT) `.timeoutMs` on the thrown Error — round 2, finding 3: runChosenSource uses this
    // to know a forceful kill happened and that source's own ingestion_runs row may need to be
    // closed (a graceful crash inside the CLI's own try/catch already self-closes; only a
    // SIGTERM/SIGKILL from spawnSync bypasses that).
    if (result.error.code === 'ETIMEDOUT') {
      const err = new Error(`${scriptPath} exceeded its ${timeoutMs}ms timeout and was killed (ETIMEDOUT)`);
      err.code = 'ETIMEDOUT';
      err.timeoutMs = timeoutMs;
      throw err;
    }
    if (result.error.code === 'ENOBUFS') {
      const err = new Error(`${scriptPath} exceeded the ${CHILD_MAX_BUFFER}-byte output buffer and was killed mid-run (ENOBUFS) — raise maxBuffer or investigate excessive stdout/stderr output`);
      err.code = 'ENOBUFS';
      err.timeoutMs = timeoutMs;
      throw err;
    }
    throw new Error(`could not launch ${scriptPath}: ${result.error.message}`);
  }
  const { parsed, parseError } = parseChildOutput(result.stdout);
  return {
    scriptPath, cliArgs, exitStatus: result.status, stdout: result.stdout, stderr: result.stderr, parsed, parseError,
  };
}

export function parseChildOutput(stdout) {
  try {
    return { parsed: JSON.parse(String(stdout ?? '').trim()), parseError: null };
  } catch (err) {
    return { parsed: null, parseError: err.message };
  }
}

// recordSchedulerAttemptFailure (C1, fix round 1): writes an HONEST failed ingestion_runs row on
// the scheduler's own behalf, using the SAME openRun/closeRun helpers every CLI uses (reused, not
// reinvented) — never a fake success, always status='failed' with real diagnostic detail. This is
// what advances the durable due-ness signal when the chosen CLI failed before ever reaching its
// own openRun call (ingest.js's collect() does all network work first — see ingest.js:536 vs
// :556 — so a persistent congress.gov/senate.gov failure would otherwise leave NO row at all,
// freezing that source's `elapsedMs` and letting pickMostOverdue return it on every tick forever,
// starving mo-senate-web/mo-house-xml/legiscan while hammering the failing source at 4x its
// declared interval — this was live on day one: us-congress sat ~91h overdue at review time).
export async function recordSchedulerAttemptFailure(client, source, childResult, launchError = null) {
  const runId = await openRun(client, source);
  const stderrTail = String(childResult.stderr ?? '').slice(-2000); // bounded — never an unbounded write
  await closeRun(client, runId, 'failed', {
    scheduler_attempt: true,
    exitCode: childResult.exitStatus,
    stderrTail,
    parseError: childResult.parseError,
    launchError: launchError ? launchError.message : null,
  });
  return runId;
}

// closeOrphanedRunningRows (round 2, finding 3): three of the five CLIs (mo-senate-web,
// mo-house-xml, legiscan) call openRun BEFORE their long work, unlike ingest.js — so a forceful
// kill (I2's ETIMEDOUT, M2's ENOBUFS: both SIGTERM the child before it ever reaches its own
// try/catch's closeRun) leaves that row stranded at status='running' forever. Left alone, this
// lies twice over: public_freshness would show the source as permanently "running", and the
// row's own started_at silently keeps advancing the durable due-ness signal (queryLatestStartedAt
// has no status filter, by design — see its own comment) even though nothing is actually
// happening. Closed here as status='failed' with real diagnostic detail — never left open, never
// silently deleted.
//
// Scoped to `sinceIso` (the TICK's own start time, captured once in main() before anything else
// runs) — `started_at >= sinceIso` — so this can only ever touch a row THIS tick's own child could
// plausibly have created. A 'running' row from any earlier tick is a different, unrelated
// question this function must never touch (if a previous tick's kill-cleanup already ran, that
// row is 'failed' already, not 'running'; if this is somehow the first time it's being noticed,
// that is its own separate investigation, not something to paper over here).
//
// Routed through selectAll (project law: no bare multi-row .select()) even though the realistic
// result size is 0 or 1 — the whole point of that law is not re-deriving "is this one small
// enough to skip it" per call site.
export async function closeOrphanedRunningRows(client, source, { sinceIso, timeoutMs, note }) {
  const { data, error } = await selectAll(client, 'ingestion_runs', 'id', {
    filter: (q) => q.eq('source', source).eq('status', 'running').gte('started_at', sinceIso),
  });
  if (error) throw new Error(`orphaned-run lookup failed for source=${source}: ${error.message}`);
  const closedIds = [];
  for (const row of data ?? []) {
    await closeRun(client, row.id, 'failed', { scheduler_kill: true, timeoutMs, note });
    closedIds.push(row.id);
  }
  return closedIds;
}

// runChosenSource: invokes the chosen source's CLI, then reconciles the durable signal against
// what actually landed in ingestion_runs. This is where C1 and I4 both live, since both need to
// read the SAME post-run row (the "honest counts channel," per the review's own framing).
//
// C1: if the child throws (a genuine launch failure, an I2 timeout, or an M2 buffer overflow —
// ALL of these are exactly "the child never got as far as reaching its own openRun", the scenario
// C1 exists for) the error is caught HERE, not left to propagate — because propagating it would
// skip the "did a new row appear" check entirely and defeat the whole point of the fix. Whether
// the child threw or merely exited non-zero, if `ingestion_runs` shows no NEW row for this source
// since before this call, the scheduler writes its own failed attempt row. Never rethrown — a
// failing source is logged and reported, never a scheduler crash (the original, still-valid
// design principle).
//
// I4: classifies the outcome from the run's OWN detail — never mode/status alone. `healthy` folds
// in the tail-probe case (I4a): a windowed source (us-congress/us-senate) whose ONLY failures are
// expected past-the-edge 404s reads as healthy, not alarming. `wroteRows` (I4b, round 3 NEW-1 fix)
// is what gates the aggregate refresh in main() — read via chosen.wroteSomething, THIS source's
// own registry-declared predicate (see buildRegistry / the wroteSomething functions above), so a
// tick where every probe 404s and zero rows landed correctly does NOT trigger a refresh, while a
// shape a predicate doesn't recognize fails open (refreshes anyway) rather than silently never.
// tickStartIso (round 2, finding 3): this TICK's own start time (main() captures `now` once,
// before anything else runs, and passes its ISO form through) — the ONLY thing
// closeOrphanedRunningRows below is allowed to treat as "this run's own row." Required whenever a
// forceful kill is possible; the existing round-1 tests never reach that branch, so they are
// unaffected by its absence.
export async function runChosenSource(client, chosen, { runChildCliFn = runChildCli, tickStartIso } = {}) {
  let childResult;
  let launchError = null;
  let killedByScheduler = false;
  try {
    childResult = runChildCliFn(chosen.scriptPath, chosen.cliArgs, { timeoutMs: chosen.timeoutMs });
  } catch (err) {
    launchError = err;
    // Round 2, finding 3: ETIMEDOUT (I2) and ENOBUFS (M2) both SIGTERM the child — it never
    // reaches its own try/catch's closeRun, unlike a graceful in-process crash (which every CLI
    // already self-closes as 'failed'). Only these two forceful-kill codes can strand a
    // pre-opened run row at status='running'.
    killedByScheduler = err.code === 'ETIMEDOUT' || err.code === 'ENOBUFS';
    childResult = {
      scriptPath: chosen.scriptPath,
      cliArgs: chosen.cliArgs,
      exitStatus: null,
      stdout: '',
      stderr: err.message,
      parsed: null,
      parseError: err.message,
    };
  }

  let killClosedRunIds = [];
  if (killedByScheduler) {
    // mo-senate-web/mo-house-xml/legiscan all call openRun BEFORE their long work — for those,
    // this closes the row the kill stranded at 'running'. For us-congress/us-senate (which open
    // LATE, the actual C1 root cause), this correctly finds nothing and is a harmless no-op; the
    // existing self-record path below handles that case instead.
    //
    // Round 3, NEW-4: sinceIso is tickStartIso MINUS a skew-tolerance grace, not tickStartIso
    // itself. tickStartIso comes from this process's LOCAL clock (Date.now() in main(), captured
    // before anything else runs); started_at is DB-assigned (Postgres column default now(), the
    // Supabase server's clock). If the local clock runs even slightly ahead of the server's, a row
    // the CHOSEN source opens a second or two into this very tick could land with
    // started_at < tickStartIso — the exact row this mechanism exists to find would then silently
    // fail the >= filter, with killClosedRunIds:[] reading identically to "nothing needed closing".
    // Safety argument for why 5 minutes of grace cannot capture stale, pre-existing history: every
    // registry source's own minIntervalMs is >=30 minutes, so a 'running' row for THIS source
    // dated within 5 minutes before tick start would mean that source was invoked well inside its
    // own cooldown — impossible, since pickMostOverdue only ever selects a DUE source, and a
    // source invoked <30min ago cannot be due under a >=30min interval. Any 'running' row this
    // grace additionally captures must therefore be from the invocation THIS tick just made, never
    // an older one.
    killClosedRunIds = await closeOrphanedRunningRows(client, chosen.key, {
      sinceIso: new Date(Date.parse(tickStartIso) - ORPHAN_CLOSE_SKEW_GRACE_MS).toISOString(),
      timeoutMs: launchError.timeoutMs ?? chosen.timeoutMs,
      note: `${launchError.code}: ${launchError.message}`,
    });
  }

  const latestRun = await queryLatestRun(client, chosen.key);
  const newRowAppeared = latestRun !== null && latestRun.started_at !== chosen.lastStartedAtIso;

  let selfRecordedFailure = false;
  let selfRecordedRunId = null;
  if (!newRowAppeared) {
    selfRecordedRunId = await recordSchedulerAttemptFailure(client, chosen.key, childResult, launchError);
    selfRecordedFailure = true;
  }

  const detail = selfRecordedFailure ? {} : (latestRun?.detail ?? {});
  const status = selfRecordedFailure ? 'failed' : (latestRun?.status ?? null);
  const failures = detail.failures ?? [];
  // detail.absent: records the source affirmatively says do not exist (ingest.js recordMiss). These
  // are NOT failures and no longer degrade the run's status - but an absence at or below the known
  // edge is a regression, so they are still read, just judged differently. See findRegressedAbsences.
  const absent = detail.absent ?? [];
  // Round 3, NEW-1 fix: chosen.wroteSomething is THIS source's own registry-declared predicate
  // (buildRegistry) — never a generic key-dispatched function guessing at a shape it was never
  // checked against. defaultWroteSomething is the fail-open fallback for the (should-never-happen)
  // case where a registry entry has no predicate wired at all.
  const wroteRows = !selfRecordedFailure && (chosen.wroteSomething ?? defaultWroteSomething)(detail, status);
  // The run's own achieved edge, so a gap under a number this tick actually fetched is judged a
  // regression rather than an expected tail. See highestPresentInWindow.
  const presentMax = highestPresentInWindow(chosen.key, {
    absent, failures, lo: chosen.windowLo, hi: chosen.windowHi,
  });
  const tailProbeOnly = !selfRecordedFailure && status === 'partial'
    && isExpectedTailProbeOutcome(chosen.key, failures, chosen.windowMaxKnown, presentMax);
  // Kept alongside the newer absent-list path on purpose: isExpectedTailProbeOutcome still governs
  // run rows written BEFORE this fix, and any manual `--rolls` invocation whose misses land in
  // failures for a reason other than a 404.
  const regressedAbsences = selfRecordedFailure
    ? [] : findRegressedAbsences(chosen.key, absent, chosen.windowMaxKnown, presentMax);
  const healthy = !selfRecordedFailure && !killedByScheduler && regressedAbsences.length === 0
    && (status === 'succeeded' || tailProbeOnly);

  let note = null;
  if (killedByScheduler) {
    note = `scheduler killed this run (${launchError.code}) after its ${formatCooldownWait(launchError.timeoutMs ?? chosen.timeoutMs)} timeout — `
      + `${killClosedRunIds.length} orphaned 'running' row(s) closed honestly`;
  } else if (regressedAbsences.length > 0) {
    const unit = chosen.key === 'us-congress' ? 'roll' : 'vote';
    note = `REGRESSION: ${regressedAbsences.length} ${unit}(s) at or below the known edge `
      + `(${unit} ${chosen.windowMaxKnown}) came back absent — ${regressedAbsences.map((a) => a.step).join(', ')}. `
      + 'Records already on file have vanished from the source; suspect a changed URL structure, a '
      + 'retired endpoint, or an auth change, NOT a quiet week.';
  } else if (absent.length > 0 && status === 'succeeded') {
    const unit = chosen.key === 'us-congress' ? 'roll' : 'vote';
    note = `${absent.length} ${unit}(s) past ${unit} ${chosen.windowMaxKnown} absent, canary OK — `
      + 'nothing new published yet. Healthy.';
  } else if (tailProbeOnly) {
    note = `${failures.length} tail 404(s) past ${chosen.key === 'us-congress' ? 'roll' : 'vote'} ${chosen.windowMaxKnown} — expected from the probe window, not a failure`;
  }

  return {
    childResult,
    latestRun,
    selfRecordedFailure,
    selfRecordedRunId,
    killedByScheduler,
    killClosedRunIds,
    launchError: launchError ? launchError.message : null,
    outcome: {
      status, healthy, wroteRows, tailProbeOnly, absentCount: absent.length,
      regressedAbsences: regressedAbsences.map((a) => a.step), note,
    },
  };
}

// ---- logging ----

function nowIso() {
  return new Date().toISOString();
}

// ---- optional dead-man's-switch alerting (senior engineering audit, 2026-08-03, finding 2) ----
//
// This project had NO alerting anywhere — a 14-hour production outage (the 0026 regression) was
// found only by accident. Fully opt-in and inert until Lance sets HEALTHCHECK_PING_URL (a
// healthchecks.io/ntfy.sh-style check URL): same "unset env var = nothing happens" contract as
// getSchedulerClient() above, so this ships without needing any account/setup right now. Pinging
// on EVERY real tick (not just failures) is what makes this a dead-man's switch, not just a
// failure notifier — a scheduler that stops running entirely (machine off, task disabled, this
// script crashing before it can log) is exactly the failure mode an exit code can never signal,
// and it's the ONE already-observed failure class in this project's history (a background loop
// that silently died with its own session). Fire-and-forget: a ping failure (network blip, the
// monitoring service itself being down) must never affect this scheduler's own exit code or lock —
// it only ever augments the existing log, never replaces it.
const HEALTHCHECK_PING_TIMEOUT_MS = 10 * 1000;

export function pingHealthcheck(healthy) {
  const baseUrl = process.env.HEALTHCHECK_PING_URL;
  if (!baseUrl) return; // not configured — complete no-op, same as today
  const url = healthy ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/fail`;
  try {
    // try/catch (not just the .catch() below) because a malformed URL can make fetch() itself
    // throw synchronously, before ever returning a promise to attach .catch() to.
    fetch(url, { method: 'GET', signal: AbortSignal.timeout(HEALTHCHECK_PING_TIMEOUT_MS) }).catch(() => {});
  } catch { /* fire-and-forget — a ping failure must never affect the scheduler itself */ }
}

// writeLog: appends the SAME pretty-printed JSON this script prints to stdout into a dated
// (UTC — see LOG_DIR's own comment) file under .superpowers/artifacts/scheduler-logs/ (gitignored,
// matches the existing cached-artifact subdirectory convention) — "Lance must be able to read one
// file and know it is alive" (brief). One entry per invocation; every branch of main() below
// funnels through this single function so the file and stdout can never drift out of sync.
// `healthy` (default true) and `skipPing` (dry-run only — must never touch the real heartbeat)
// drive the optional ping above; every real branch below states its own value explicitly rather
// than relying on the default, so a reviewer can see the health verdict at each call site.
function writeLog(entry, { healthy = true, skipPing = false } = {}) {
  mkdirSync(LOG_DIR, { recursive: true });
  const day = entry.timestamp.slice(0, 10); // YYYY-MM-DD, UTC
  const logPath = path.join(LOG_DIR, `${day}.log`);
  const block = `=== ${entry.timestamp} ===\n${JSON.stringify(entry, null, 2)}\n\n`;
  appendFileSync(logPath, block);
  console.log(JSON.stringify(entry, null, 2));
  if (!skipPing) pingHealthcheck(healthy);
}

// ---- scheduler's own Supabase client (I2, fix round 1) ----

// A single Supabase REST round-trip should take well under a second; 30s is generous headroom
// while still bounding the worst case. Applied to every fetch this process's OWN client makes
// (due-ness lookups, registry resolution) — NOT to the ingest CLIs' own fetches to
// house.mo.gov/congress.gov/etc, which are untouched (their own limiters + this file's
// CHILD_TIMEOUT_MS already bound those from the outside).
const SCHEDULER_FETCH_TIMEOUT_MS = 30 * 1000;

function timedFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(SCHEDULER_FETCH_TIMEOUT_MS) });
}

// getSchedulerClient: deliberately NOT src/lib/db.js's shared getClient() — this needs a fetch
// timeout applied (I2), and getClient() is imported by every interactive CLI in the repo;
// changing ITS defaults would widen an unattended-only decision's blast radius repo-wide (the
// review's own instruction: "Do NOT change shared http.js defaults — blast radius stays inside
// the scheduler", extended here to lib/db.js for the same reason). Mirrors getClient()'s own
// env-var/null-if-unconfigured contract exactly otherwise.
export function getSchedulerClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false }, global: { fetch: timedFetch } });
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();
  // Captured once, before anything else runs — the ONLY timestamp closeOrphanedRunningRows
  // (round 2, finding 3) is allowed to treat as "this tick's own" when scoping which orphaned
  // 'running' rows it may close.
  const nowIsoAtTickStart = new Date(now).toISOString();

  const lockResult = acquireLock(LOCK_PATH, { now });
  if (!lockResult.acquired) {
    // NOT an error — an overlapping tick is normal (Task Scheduler's 15-min cadence is shorter
    // than every source's own interval by design) and must never surface as a scheduler failure.
    writeLog({
      timestamp: nowIso(),
      mode: 'already-running',
      note: `a live lock (pid ${lockResult.lock.pid}, started ${lockResult.lock.startedAt}) already exists — skipping this tick`,
    });
    return;
  }

  const lockReclaimed = lockResult.reason === 'reclaimed-stale' ? lockResult.staleLock : null;
  if (lockReclaimed) {
    console.error(
      `[${nowIso()}] WARNING: reclaimed a stale lock (pid ${lockReclaimed.pid}, started `
        + `${lockReclaimed.startedAt}, older than ${formatCooldownWait(MAX_RUN_DURATION_MS)}) — a prior run may have crashed without releasing it`,
    );
  }

  try {
    const client = getSchedulerClient();
    if (!client) {
      writeLog({
        timestamp: nowIso(),
        mode: 'blocked',
        reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — cannot compute source due-ness without reading ingestion_runs',
        lockReclaimed,
      }, { healthy: false });
      process.exitCode = 1;
      return;
    }

    const year = new Date(now).getFullYear();
    const registry = await buildRegistry(client, { now, year, only: args.only });
    const scoped = args.only ? registry.filter((e) => e.key === args.only) : registry;
    const withDueness = scoped.map((e) => computeSourceDueness(e, now));
    const chosen = pickMostOverdue(withDueness);

    const sourcesSummary = withDueness.map((e) => ({
      key: e.key,
      due: e.due,
      remainingMs: e.remainingMs,
      remainingHuman: e.remainingMs > 0 ? formatCooldownWait(e.remainingMs) : '0s',
      resolvable: e.resolvable,
      unresolvedReason: e.unresolvedReason,
      lastStartedAt: e.lastStartedAtIso,
    }));

    // Senior engineering audit (2026-08-03, finding 5): a revoked/rotated service-role key (or a
    // persistent DB outage) makes EVERY source's own due-ness lookup fail — buildRegistry's
    // safeLookup degrades each one individually to resolvable:false rather than throwing, so
    // pickMostOverdue correctly returns null and this used to fall straight into the 'nothing-due'
    // branch below: a total, persistent failure reading back identically to a genuinely quiet tick,
    // forever. This check fires ONLY when every scoped source is unresolvable — mechanically
    // reproduced (see the audit report) to require a systemic cause; a source that's merely not yet
    // configured (e.g. legiscan with no legiscan_session_id on file) never takes every OTHER
    // source down with it, so this cannot fire on that already-accepted partial-degradation state.
    const allUnresolvable = withDueness.length > 0 && withDueness.every((e) => !e.resolvable);
    if (allUnresolvable) {
      writeLog({
        timestamp: nowIso(),
        mode: 'all-lookups-failed',
        chosen: null,
        reason: 'every scoped source failed its own due-ness lookup this tick — a systemic cause (revoked/'
          + 'rotated service-role key, persistent DB outage), never a normal quiet period; see each '
          + "source's own unresolvedReason below",
        sources: sourcesSummary,
        lockReclaimed,
      }, { healthy: false });
      process.exitCode = 1;
      return;
    }

    if (!chosen) {
      writeLog({
        timestamp: nowIso(),
        mode: 'nothing-due',
        chosen: null,
        reason: args.only ? `'${args.only}' is not due yet (or not configured)` : 'no registry source is currently due',
        sources: sourcesSummary,
        lockReclaimed,
      });
      return;
    }

    const reason = `most overdue due source (elapsed ${chosen.elapsedMs === Infinity ? 'never run' : formatCooldownWait(chosen.elapsedMs)}, `
      + `min interval ${formatCooldownWait(chosen.minIntervalMs)})`;

    if (args.dryRun) {
      writeLog({
        timestamp: nowIso(),
        mode: 'dry-run',
        chosen: chosen.key,
        reason,
        wouldRun: { scriptPath: chosen.scriptPath, cliArgs: chosen.cliArgs },
        sources: sourcesSummary,
        note: 'zero fetches, zero writes — --dry-run',
        lockReclaimed,
      }, { skipPing: true }); // a manual/local dry-run must never touch the real production heartbeat
      return;
    }

    // Round 2, finding 2: the lock's declared duration must cover THIS source's real timeout
    // before we spawn it — written after selection (now that we know chosen.timeoutMs), before
    // the child starts, so a later tick's stale-reclaim check judges this run against its actual
    // bound (e.g. legiscan's 75 min) rather than the generic selection-phase placeholder
    // acquireLock wrote.
    //
    // Round 3, NEW-3: its return value MUST be acted on. Round 2 called this purely for effect —
    // if it failed (lock missing/corrupt/no-longer-nonce-matched between acquire and here, an
    // edge case but a real one), the child would still have been spawned under the stale
    // selection-phase placeholder, reopening the exact mid-run-reclaim window round 2 exists to
    // close. Fail-safe beats limping: if the lock can't record the run's real declared duration,
    // do not spawn it at all — log honestly, release the lock (still via the outer finally), exit
    // 0, and let the next tick retry (the source's own due-ness is untouched, since nothing ran).
    const durationRecorded = updateLockMaxDuration(LOCK_PATH, lockResult.nonce, chosen.timeoutMs + LOCK_GRACE_MS);
    if (!durationRecorded) {
      writeLog({
        timestamp: nowIso(),
        // Distinct from the exit-1 'blocked' branch above: this one is transient and exits 0
        // (next tick retries), so the log must not read like the fatal case (review R3-1).
        mode: 'lock-record-failed',
        chosen: chosen.key,
        reason: `could not record ${chosen.key}'s declared run duration on the lock before spawning — refusing to start a run the stale-reclaim window would not correctly protect; next tick retries`,
        sources: sourcesSummary,
        lockReclaimed,
      });
      return;
    }

    // Senior engineering audit (2026-08-03, finding 5, second half): everything from here through
    // the 'live' writeLog call below used to run OUTSIDE any try/catch — an unexpected DB failure
    // during post-run reconciliation (queryLatestRun, recordSchedulerAttemptFailure,
    // closeOrphanedRunningRows, all called inside runChosenSource) would propagate straight past
    // writeLog to the top-level main().catch(), which only console.error()s — breaking this file's
    // own documented "one log entry per invocation" invariant for exactly the tick that most needed
    // a log entry. Wrapped so a failure here still produces one, same as every other branch.
    try {
      const run = await runChosenSource(client, chosen, { tickStartIso: nowIsoAtTickStart });

      // I4b: refresh-aggregates fires ONLY when the run's own detail.counts show rows actually
      // written (run.outcome.wroteRows) — never the old "mode==='live' && succeeded/partial"
      // heuristic, which was true even on a tick where every us-congress probe 404s and nothing
      // landed, so the refresh used to fire unconditionally every hour regardless.
      let aggregatesResult = null;
      if (run.outcome.wroteRows) {
        const refreshResult = runChildCli('scripts/refresh-aggregates.js', []);
        aggregatesResult = {
          exitStatus: refreshResult.exitStatus, parsed: refreshResult.parsed, parseError: refreshResult.parseError,
        };
      }

      // Senior engineering audit (2026-08-03, finding 3): a failed refresh used to leave
      // aggregatesRefreshed:true (it only ever meant "a refresh was ATTEMPTED", never "it
      // succeeded") and the tick's own top-level healthy field never looked at the refresh outcome
      // at all — every one of the 13 ticks in the real 0026 outage logged healthy:true,
      // aggregatesRefreshed:true while refresh_vote_aggregates() was failing on a timeout.
      // aggregatesAttempted keeps the old (honestly-named) "was a refresh due" signal;
      // aggregatesHealthy is the new tri-state (null = not attempted this tick, so no verdict;
      // true/false = the refresh's own reported outcome) that field was missing entirely.
      // Deliberately does NOT flip process.exitCode: this scheduler's own established philosophy
      // (see the 'lock-record-failed' branch's comment below) is that a transient/expected
      // operational outcome exits 0 and relies on an honest log record, never process.exitCode, to
      // surface itself — the SAME treatment a failed ingest child already gets (selfRecordedFailure
      // stays exit 0 by design). aggregatesHealthy plus the ping above plus the durable
      // ingestion_runs record refresh-aggregates.js now writes are the three real signals; exit
      // code is deliberately left alone here to avoid contradicting that existing convention.
      const aggregatesAttempted = run.outcome.wroteRows;
      const aggregatesHealthy = aggregatesResult === null ? null : (aggregatesResult.parsed?.mode === 'refreshed');
      const tickHealthy = run.outcome.healthy && aggregatesHealthy !== false;

      writeLog({
        timestamp: nowIso(),
        mode: 'live',
        chosen: chosen.key,
        reason,
        selfRecordedFailure: run.selfRecordedFailure,
        killedByScheduler: run.killedByScheduler,
        killClosedRunIds: run.killClosedRunIds,
        result: {
          exitStatus: run.childResult.exitStatus,
          mode: run.childResult.parsed?.mode ?? null,
          status: run.outcome.status,
          healthy: run.outcome.healthy,
          note: run.outcome.note,
          counts: run.childResult.parsed?.counts ?? null,
          failures: run.childResult.parsed?.failures ?? null,
          parseError: run.childResult.parseError,
          launchError: run.launchError,
        },
        aggregatesAttempted,
        aggregatesHealthy,
        aggregatesResult,
        sources: sourcesSummary,
        lockReclaimed,
      }, { healthy: tickHealthy });
    } catch (err) {
      writeLog({
        timestamp: nowIso(),
        mode: 'run-failed',
        chosen: chosen.key,
        reason: 'an unexpected error interrupted this tick after a source was chosen and spawned (e.g. a '
          + 'DB failure during post-run reconciliation) — the child process may have already run to '
          + 'completion; see error below',
        error: String(err && err.message ? err.message : err),
        sources: sourcesSummary,
        lockReclaimed,
      }, { healthy: false });
      process.exitCode = 1;
    }
  } finally {
    // Always released, including on throw — an overlapping tick after a genuine crash would
    // otherwise be permanently blocked until MAX_RUN_DURATION_MS's stale-reclaim kicks in.
    // Ownership-checked (I1) via the nonce this same process was given when it acquired the lock.
    releaseLock(LOCK_PATH, lockResult.nonce);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
