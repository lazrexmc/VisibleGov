// scripts/scheduled-ingest.js — the first unattended, OS-scheduled process in this repo (TODO
// build-queue item 13). Every prior "recurring" ingestion was a bash loop inside a Claude Code
// session: it died the moment the session ended, so data staleness was real. This script is meant
// to be registered with Windows Task Scheduler (registration itself is Lance's own step — see
// docs/SCHEDULED_INGESTION.md — never run schtasks from an agent) and to run forever, unattended,
// with no human watching a single invocation. That changes the design bar entirely:
//
//   - NEVER CALLS A MODEL. This file imports no Anthropic client, no lib/summarizer.js, no
//     lib/verifier.js — nothing that can bill Lance's account. It only ever spawns the four
//     read-mostly ingestion CLIs below plus scripts/refresh-aggregates.js. This comment, and the
//     import list actually enforcing it, are the whole guarantee — verify by inspection any time
//     this file changes.
//   - INCAPABLE OF VIOLATING A PUBLISHED RATE LIMIT. The two MO cadences (MO_SENATE_MIN_INTERVAL_MS,
//     MO_HOUSE_MIN_INTERVAL_MS) are imported verbatim from the adapters that already encode
//     senate.mo.gov's/house.mo.gov's real published terms — never redefined here, never
//     env-overridable, so a typo'd environment variable cannot shorten them. The two intervals
//     this script DOES get to choose (us-congress, legiscan) are env-overridable but mechanically
//     floored at the brief's own conservative minimum (envIntervalMs) — configurable upward only.
//   - INCAPABLE OF STACKING OVERLAPPING PROCESSES. A single-instance lock file
//     (.superpowers/artifacts/scheduler.lock.json) is required before anything else happens; a
//     live lock means "already running," logged and exited 0 — an overlapping tick is expected
//     (Task Scheduler is recommended at a 15-min cadence, shorter than every source's own
//     interval, see docs/SCHEDULED_INGESTION.md) and must never read as a scheduler failure.
//   - The CRITICAL constraint from the brief: the ingest CLIs do not exit when their ToU cooldown
//     hasn't elapsed — they SLEEP until it has (enforceDurableCooldown, ingest-mo-senate.js:446;
//     same pattern in ingest-mo-house.js). A scheduler that blindly invoked them every tick would
//     stack sleeping processes. So THIS script decides due-ness itself, BEFORE ever launching a
//     child, by importing the exported remainingCooldownMs and querying ingestion_runs directly —
//     the same durable, cross-process signal the CLIs' own enforceDurableCooldown reads. A CLI is
//     only ever launched once its own cooldown has fully elapsed; in normal operation the child's
//     own enforceDurableCooldown check should therefore always see remaining<=0 immediately and
//     never actually sleep.
//   - Leaves an honest, dated log a human can read to confirm it is alive (see writeLog / npm run
//     status's freshness block).
//
// Entry: node --env-file=.env scripts/scheduled-ingest.js [--dry-run] [--only <source>]

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getClient, selectAll } from '../src/lib/db.js';
// Reused, not reimplemented (brief's own explicit instruction): the exact arithmetic every ingest
// CLI's own enforceDurableCooldown already relies on. Both ingest-mo-senate.js and
// ingest-mo-house.js export an identical copy (the latter ported from the former, see that file's
// own comment) — either is a correct, generic (lastStartedAtIso, minIntervalMs, now) function, not
// specific to MO Senate; imported once here and reused for all four registry sources.
import { remainingCooldownMs, formatCooldownWait } from '../src/cli/ingest-mo-senate.js';
import { MO_SENATE_MIN_INTERVAL_MS } from '../src/adapters/mo-senate-web.js';
import { MO_HOUSE_MIN_INTERVAL_MS, DEFAULT_MO_HOUSE_SESSION } from '../src/adapters/mo-house-xml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Computed from this file's own location, NEVER from process.cwd() — Task Scheduler's default
// working directory is not guaranteed to be the repo root (docs/SCHEDULED_INGESTION.md recommends
// setting "Start in" anyway, but this script does not depend on it either way).
export const REPO_ROOT = path.join(__dirname, '..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, '.superpowers', 'artifacts');
const LOCK_PATH = path.join(ARTIFACTS_DIR, 'scheduler.lock.json');
const LOG_DIR = path.join(ARTIFACTS_DIR, 'scheduler-logs');

// Stale-lock reclaim threshold. A normal invocation is one child CLI at --limit 1 (cooldown
// already confirmed elapsed by this script, so the child's own enforceDurableCooldown should not
// actually sleep) plus, sometimes, one refresh-aggregates.js call — realistically seconds, well
// under a minute. 10 minutes is a generous ceiling for slow network/retries while staying safely
// below the 15-minute recommended Task Scheduler tick, so a genuinely crashed/killed prior run
// cannot wedge the schedule for more than one missed tick.
export const MAX_RUN_DURATION_MS = 10 * 60 * 1000;

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

// envIntervalMs: the mechanical floor behind US_CONGRESS_MIN_INTERVAL_MS/LEGISCAN_MIN_INTERVAL_MS
// below — these two intervals are OUR OWN conservative policy choice (Congress.gov and LegiScan
// publish no per-request cadence the way house.mo.gov/senate.mo.gov do), so, unlike the two MO
// constants above, they are env-overridable. But an override can only raise the interval, never
// lower it below the floor the brief itself specifies (>=1h / >=24h) — a bad or typo'd env value
// can only make this script MORE conservative, never less.
export function envIntervalMs(envVar, defaultMs, floorMs) {
  const raw = Number(process.env[envVar]);
  const configured = Number.isFinite(raw) && raw > 0 ? raw : defaultMs;
  return Math.max(configured, floorMs);
}

// us-congress: no published rate limit exists to violate (Congress.gov's own polite limiter is
// already enforced inside src/adapters/us-congress.js's congressLimiter) — >=1h is this script's
// own conservative choice, since new House roll calls arrive on a legislative-day cadence, not
// continuously; there is no benefit to checking more often than that.
export const US_CONGRESS_MIN_INTERVAL_MS = envIntervalMs('US_CONGRESS_MIN_INTERVAL_MS', ONE_HOUR_MS, ONE_HOUR_MS);
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
// Small, conservative forward-delta window past the highest roll number already on file — see
// resolveUsCongressRollWindow's own comment for why this is safe to overlap/overshoot.
export const US_CONGRESS_ROLL_WINDOW = 10;

const SOURCE_KEYS = ['mo-senate-web', 'mo-house-xml', 'us-congress', 'legiscan'];

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

// ---- pure: single-instance lock ----

export function isLockStale(lock, nowMs, maxRunDurationMs = MAX_RUN_DURATION_MS) {
  const startedMs = Date.parse(lock.startedAt);
  if (!Number.isFinite(startedMs)) return true; // unparseable timestamp — never trusted, treated as stale
  return nowMs - startedMs > maxRunDurationMs;
}

// acquireLock: an atomic create ('wx' — fails with EEXIST if the file already exists) is tried
// first, closing the check-then-act race a plain existsSync()-then-writeFileSync() pair would
// leave open between two schedulers starting within milliseconds of each other. Unlikely at a
// 15-minute tick cadence, but free to close. Falls back to reading the existing lock only on
// EEXIST; a corrupt/unreadable lock is treated exactly like a stale one (reclaimed + the caller
// logs a warning) rather than either trusting it blindly or crashing — a half-written lock from a
// killed process must not permanently wedge every future tick.
export function acquireLock(lockPath = LOCK_PATH, { now = Date.now(), maxRunDurationMs = MAX_RUN_DURATION_MS } = {}) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() }, null, 2);

  try {
    writeFileSync(lockPath, payload, { flag: 'wx' });
    return { acquired: true, reason: 'fresh' };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  let existing;
  try {
    existing = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    existing = { startedAt: new Date(0).toISOString(), pid: null, corrupt: true };
  }
  if (!isLockStale(existing, now, maxRunDurationMs)) {
    return { acquired: false, reason: 'already-running', lock: existing };
  }
  // Stale: a plain overwrite is fine here — the prior owner is already established to be long
  // past any plausible run duration, so losing a 'wx'-style race at this exact point is not a
  // realistic concern.
  writeFileSync(lockPath, payload);
  return { acquired: true, reason: 'reclaimed-stale', staleLock: existing };
}

export function releaseLock(lockPath = LOCK_PATH) {
  if (existsSync(lockPath)) unlinkSync(lockPath);
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

// pickMostOverdue: among due AND resolvable entries (legiscan with no legiscan_session_id on file
// is due but never resolvable — see buildRegistry), the one that has gone longest since its last
// (or ever) run wins. A source with zero prior runs (elapsedMs=Infinity) outranks everything else
// — seeding an unseen source is the most urgent thing to do. Ties keep registry order (reduce
// never replaces `best` on an equal elapsedMs).
export function pickMostOverdue(entries) {
  const candidates = entries.filter((e) => e.due && e.resolvable);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, e) => (e.elapsedMs > best.elapsedMs ? e : best));
}

// ---- pure: us-congress roll-delta window ----

const US_HOUSE_ROLL_RE = /^us-house-\d+-\d+-(\d+)$/;

export function parseUsHouseRoll(sourceKey) {
  const m = US_HOUSE_ROLL_RE.exec(String(sourceKey ?? ''));
  return m ? Number(m[1]) : null;
}

export function computeRollWindow(maxKnownRoll, windowSize = US_CONGRESS_ROLL_WINDOW) {
  const base = Number.isFinite(maxKnownRoll) && maxKnownRoll > 0 ? maxKnownRoll : 0;
  return { lo: base + 1, hi: base + windowSize };
}

// ---- pure: child-CLI output ----

export function parseChildOutput(stdout) {
  try {
    return { parsed: JSON.parse(String(stdout ?? '').trim()), parseError: null };
  } catch (err) {
    return { parsed: null, parseError: err.message };
  }
}

// runWroteSomething: deliberately generous, not a byte-exact "were rows actually inserted" oracle
// — the four registry CLIs' count shapes are heterogeneous (mo-senate/mo-house's document-shaped
// counts vs. us-congress's legislators/bills/votes/casts vs. legiscan's own), so this reads the one
// field every one of them shares (mode/status, the same repo-wide main() convention every CLI in
// this codebase follows). A 'live' run that reached succeeded/partial opened and closed a real
// ingestion_runs row — it genuinely attempted writes, even on a tick where every upsert happened to
// be a no-op. Treating that as "wrote something" means the aggregate refresh below sometimes runs
// when nothing actually changed (cheap, idempotent SQL) rather than risk the opposite: skipping a
// refresh that WAS needed, which is the exact user-visible chart-drift defect from 2026-07-31 that
// refresh-aggregates.js's own header describes this standing practice as preventing.
export function runWroteSomething(parsedOutput) {
  if (!parsedOutput || parsedOutput.mode !== 'live') return false;
  return parsedOutput.status === 'succeeded' || parsedOutput.status === 'partial';
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
// caller-chosen explicit range) and this source has never had scheduled ingestion (brief) — this
// is the scheduler's own minimal, honest "what's new" computation: the highest US House roll
// number already on file for this congress+year, plus a small forward window. Every candidate roll
// in that window that doesn't exist yet simply 404s inside collectUsCongress (a typed, non-fatal
// SourceFetchError recorded in failures[] — see ingest.js's own per-roll try/catch) and every roll
// that already exists is a harmless insertIfAbsent no-op (votes.source_key is the conflict key) —
// so overlapping an already-ingested roll, or probing one that hasn't happened yet, is always
// safe, just occasionally wasted requests against Congress.gov's own already-polite limiter.
// Routed through selectAll (project law: no bare .select() on a multi-row table — this table is
// already ~10,000+ rows overall, well past Supabase's 1000-row cap, even though this query's own
// WHERE clause keeps any single congress+year's result set small).
export async function resolveUsCongressRollWindow(client, {
  congress = US_CONGRESS_CONGRESS, year, windowSize = US_CONGRESS_ROLL_WINDOW,
} = {}) {
  const prefix = `us-house-${congress}-${year}-`;
  const { data, error } = await selectAll(client, 'votes', 'source_key', {
    filter: (q) => q.eq('jurisdiction_id', 'us-congress').like('source_key', `${prefix}%`),
  });
  if (error) throw new Error(`votes lookup failed for us-congress roll window: ${error.message}`);
  const maxRoll = (data ?? [])
    .map((r) => parseUsHouseRoll(r.source_key))
    .filter((n) => n !== null)
    .reduce((max, n) => Math.max(max, n), 0);
  return computeRollWindow(maxRoll, windowSize);
}

// ---- registry ----
//
// Each entry: { key, minIntervalMs, lastStartedAtIso, resolvable, unresolvedReason, scriptPath,
// cliArgs }. scriptPath is repo-root-relative, matching every "node --env-file=.env <path>" npm
// script already in package.json.
export async function buildRegistry(client, { now = Date.now(), year = new Date(now).getFullYear() } = {}) {
  const [moSenateLast, moHouseLast, usCongressLast, legiscanLast, legiscanSessionId, rollWindow] = await Promise.all([
    queryLatestStartedAt(client, 'mo-senate-web'),
    queryLatestStartedAt(client, 'mo-house-xml'),
    queryLatestStartedAt(client, 'us-congress'),
    queryLatestStartedAt(client, 'legiscan'),
    resolveLegiscanSessionId(client),
    resolveUsCongressRollWindow(client, { year }),
  ]);

  return [
    {
      key: 'mo-senate-web',
      minIntervalMs: MO_SENATE_MIN_INTERVAL_MS,
      lastStartedAtIso: moSenateLast,
      resolvable: true,
      unresolvedReason: null,
      scriptPath: 'src/cli/ingest-mo-senate.js',
      cliArgs: ['--year', String(year), '--limit', '1'],
    },
    {
      key: 'mo-house-xml',
      minIntervalMs: MO_HOUSE_MIN_INTERVAL_MS,
      lastStartedAtIso: moHouseLast,
      resolvable: true,
      unresolvedReason: null,
      scriptPath: 'src/cli/ingest-mo-house.js',
      // RESTRICTION (TODO 31 — do not violate): current-session ingestion ONLY. mo_house_id is
      // declared table-wide `unique` (migration 0005) against a current-only roster, so a
      // historical/multi-era backfill would silently misattribute a successor's votes to their
      // predecessor. NEVER add --session (or any year/era flag) here — --limit 1 alone lets the
      // CLI fall through to its own DEFAULT_MO_HOUSE_SESSION, which is the current session.
      cliArgs: ['--limit', '1'],
    },
    {
      key: 'us-congress',
      minIntervalMs: US_CONGRESS_MIN_INTERVAL_MS,
      lastStartedAtIso: usCongressLast,
      resolvable: true,
      unresolvedReason: null,
      scriptPath: 'src/cli/ingest.js',
      cliArgs: ['--source', 'us-congress', '--year', String(year), '--rolls', `${rollWindow.lo}-${rollWindow.hi}`],
    },
    {
      key: 'legiscan',
      minIntervalMs: LEGISCAN_MIN_INTERVAL_MS,
      lastStartedAtIso: legiscanLast,
      resolvable: legiscanSessionId != null,
      unresolvedReason: legiscanSessionId != null
        ? null
        : `no legiscan_session_id on file for MO session '${DEFAULT_MO_HOUSE_SESSION}' (sessions.legiscan_session_id) — `
          + 'see TODO.md item 25; not guessed, skipped honestly until resolved',
      scriptPath: 'src/cli/ingest-legiscan.js',
      // ⛔ dataset_hash comparison happens INSIDE ingest-legiscan.js (decodeDatasetHashGate) —
      // never re-implemented here. This registry entry only ever supplies --session; the
      // suspension-level gate itself is entirely the CLI's own responsibility, invoked, not
      // reimplemented.
      cliArgs: legiscanSessionId != null ? ['--session', String(legiscanSessionId)] : [],
    },
  ];
}

// ---- process orchestration ----

function defaultSpawn(command, args, options) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

// runChildCli: every ingestion CLI in this repo (and refresh-aggregates.js) speaks the same "API"
// — one console.log(JSON.stringify(...)) as its terminal line to stdout, progress on stderr, the
// same repo-wide main() convention verified across all four registry sources. No CLI in this repo
// exports its main() (checked before writing this file), so a child process — not an in-process
// import — is the only way to invoke one. spawnFn is injectable so tests never launch a real
// subprocess against real network/DB state; the real default really does spawn `node
// --env-file=.env <scriptPath> ...cliArgs`, matching every "node --env-file=.env ..." npm script.
export function runChildCli(scriptPath, cliArgs, { cwd = REPO_ROOT, spawnFn = defaultSpawn } = {}) {
  const result = spawnFn(process.execPath, ['--env-file=.env', scriptPath, ...cliArgs], { cwd });
  if (result.error) {
    // The child could not even be launched (e.g. a bad path) — unlike a child that launched and
    // reported its own typed failures, this IS a real scheduler-level error.
    throw new Error(`could not launch ${scriptPath}: ${result.error.message}`);
  }
  const { parsed, parseError } = parseChildOutput(result.stdout);
  return {
    scriptPath, cliArgs, exitStatus: result.status, stdout: result.stdout, stderr: result.stderr, parsed, parseError,
  };
}

// ---- logging ----

function nowIso() {
  return new Date().toISOString();
}

// writeLog: appends the SAME pretty-printed JSON this script prints to stdout into a dated file
// under .superpowers/artifacts/scheduler-logs/ (gitignored, matches the existing cached-artifact
// subdirectory convention) — "Lance must be able to read one file and know it is alive" (brief).
// One entry per invocation; every branch of main() below funnels through this single function so
// the file and stdout can never drift out of sync with each other.
function writeLog(entry) {
  mkdirSync(LOG_DIR, { recursive: true });
  const day = entry.timestamp.slice(0, 10); // YYYY-MM-DD
  const logPath = path.join(LOG_DIR, `${day}.log`);
  const block = `=== ${entry.timestamp} ===\n${JSON.stringify(entry, null, 2)}\n\n`;
  appendFileSync(logPath, block);
  console.log(JSON.stringify(entry, null, 2));
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();

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
    const client = getClient();
    if (!client) {
      writeLog({
        timestamp: nowIso(),
        mode: 'blocked',
        reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — cannot compute source due-ness without reading ingestion_runs',
        lockReclaimed,
      });
      process.exitCode = 1;
      return;
    }

    const year = new Date(now).getFullYear();
    const registry = await buildRegistry(client, { now, year });
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
      });
      return;
    }

    const childResult = runChildCli(chosen.scriptPath, chosen.cliArgs);
    const wroteSomething = runWroteSomething(childResult.parsed);

    // Standing practice from the ledger (brief): every ingest batch ends with an aggregate
    // refresh, else public_position_totals/public_party_alignment silently drift behind the vote
    // lists — a real user-visible defect on 2026-07-31. Skipped only when nothing was written
    // (runWroteSomething), and its own outcome NEVER overrides the primary ingest run's already-
    // recorded result below, mirroring summarize.js's persistReferencedTermsGracefully: a
    // secondary, best-effort follow-up must never make an otherwise-successful tick look failed.
    let aggregatesResult = null;
    if (wroteSomething) {
      const refreshResult = runChildCli('scripts/refresh-aggregates.js', []);
      aggregatesResult = {
        exitStatus: refreshResult.exitStatus, parsed: refreshResult.parsed, parseError: refreshResult.parseError,
      };
    }

    writeLog({
      timestamp: nowIso(),
      mode: 'live',
      chosen: chosen.key,
      reason,
      result: {
        exitStatus: childResult.exitStatus,
        mode: childResult.parsed?.mode ?? null,
        status: childResult.parsed?.status ?? null,
        counts: childResult.parsed?.counts ?? null,
        failures: childResult.parsed?.failures ?? null,
        parseError: childResult.parseError,
      },
      aggregatesRefreshed: wroteSomething,
      aggregatesResult,
      sources: sourcesSummary,
      lockReclaimed,
    });
  } finally {
    // Always released, including on throw — an overlapping tick after a genuine crash would
    // otherwise be permanently blocked until MAX_RUN_DURATION_MS's stale-reclaim kicks in.
    releaseLock(LOCK_PATH);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
