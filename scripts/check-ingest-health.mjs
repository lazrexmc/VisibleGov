// scripts/check-ingest-health.mjs — decide whether ingestion is actually WORKING, from the durable
// record rather than from an exit code.
//
// WHY THIS EXISTS (2026-08-29). `.github/workflows/ingest.yml` originally gated on the exit status
// of `node scripts/scheduled-ingest.js --only <source>`. That check is close to inert, because that
// scheduler exits 0 on operational failure BY DESIGN — its own comment at line ~1253 says so
// outright: "a transient/expected operational outcome exits 0 and relies on an honest log record,
// never process.exitCode, to surface itself ... the SAME treatment a failed ingest child already
// gets (selfRecordedFailure stays exit 0 by design)".
//
// That convention is correct for a local scheduler and I am not changing it. But it means a green
// Actions run proved only that node did not crash. A status that never varies carries zero bits
// (PLAYBOOK lesson 51) — and this project has already been bitten by exactly this shape once, when
// us-congress and us-senate closed 121 of 121 runs `partial` while perfectly healthy. This is the
// mirror image: permanently green while possibly broken.
//
// The scheduler names its three real signals: aggregatesHealthy, the healthcheck ping, and the
// durable ingestion_runs record. This script reads the third.
//
// WHAT IT DELIBERATELY DOES NOT DO: fail on a single failed run. Government sites 500 and time out;
// that is weather, not a defect. Failing hourly on transient noise trains an operator to ignore the
// only channel that will ever tell them something real, which is worse than not checking at all.
// So a source must be persistently broken (PERSISTENT_FAILURES in a row) before this exits 1.
//
// AND THE OTHER HALF, which is the easier one to forget: a source that stops being ATTEMPTED
// altogether looks perfect here — no failures, because no runs. "Absence reported as unknown
// disarms the detector." So silence is its own alarm: no run at all inside SILENT_AFTER_HOURS is a
// failure even though nothing failed.
//
// Usage: node scripts/check-ingest-health.mjs        (reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
//        node scripts/check-ingest-health.mjs --json
//        node scripts/check-ingest-health.mjs --only legiscan
//        node scripts/check-ingest-health.mjs --only mo-senate-web,us-senate

// legiscan is IN this list. It was missing until 2026-08-29 and that was the same defect this file
// exists to fix, still live in the daily workflow: ingest-legiscan.yml gated only on the scheduler's
// deliberately-inert exit code, so a broken LegiScan feed would have stayed green indefinitely.
// Fixing signal death for the hourly path and leaving it in the daily path is not fixing it.
const SOURCES = ['mo-senate-web', 'mo-house-xml', 'us-congress', 'us-senate', 'legiscan'];

// 3 consecutive failures: one is weather, two is suspicious, three is a broken feed. At hourly
// cadence that is a ~3 hour detection window, which is proportionate for legislative data.
const PERSISTENT_FAILURES = 3;

// Silence thresholds are PER SOURCE, because the sources do not share a cadence and a single number
// would be wrong for someone. The hourly sources are due-gated internally (mo-senate-web paces
// itself, us-congress probes a window), so a quiet few hours is normal; a full day is not.
//
// legiscan gets 50h, and the derivation matters because the first value here (30h) was WRONG in a
// way no amount of watching a healthy system would have revealed:
//
//   * its interval is floored at 24h (scheduled-ingest.js), and
//   * due-ness is measured from the previous run's `started_at` — stamped AFTER checkout and
//     npm ci — not from the cron's scheduled time, and
//   * the cron is a fixed daily time while GitHub's scheduler is best-effort.
//
// So whenever a day's drift is smaller than the previous day's drift plus install time, legiscan is
// not yet due when its workflow fires, the tick writes NO ROW, and the feed legitimately SKIPS A
// DAY. Its newest row then ages past 30h while the source is perfectly healthy. 50h = two 24h
// intervals plus ~2h of drift: one skipped cycle is tolerated, two consecutive misses still alarm.
//
// The general rule, which is the part worth carrying elsewhere: derive a silence window from the
// interval TIMES THE NUMBER OF CYCLES YOU ARE WILLING TO LOSE, never from the bare interval. A
// threshold set to the nominal interval alarms on every legitimate miss, and an alarm that fires on
// normal operation is the one everybody learns to ignore.
const SILENT_AFTER_HOURS_DEFAULT = 25;
const SILENT_AFTER_HOURS = { legiscan: 50 };
export const silenceThreshold = (source) => SILENT_AFTER_HOURS[source] ?? SILENT_AFTER_HOURS_DEFAULT;

// Credentials are read INSIDE main(), never at module scope. This file's pure classifier is
// unit-tested, and this repo's established convention (serve-site.js, every src/cli/*.js) is that
// importing a module for its exports must never touch the network, read env vars, or call
// process.exit. An env check at module scope violated all three: importing it from a test killed
// the test process outright, which is how this was caught.
function credentials() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // 2, not 1: "could not check" must never be mistaken for "checked and healthy".
    const err = new Error('check-ingest-health: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    err.exitCode = 2;
    throw err;
  }
  return { url, key };
}

async function recentRuns({ url, key }, source, limit) {
  const path = `ingestion_runs?source=eq.${encodeURIComponent(source)}`
    + `&select=status,started_at,finished_at&order=started_at.desc&limit=${limit}`;
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`ingestion_runs query failed for ${source}: HTTP ${r.status}`);
  return r.json();
}

export function classify(runs, { now = Date.now(), silentAfterHours = SILENT_AFTER_HOURS_DEFAULT } = {}) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return { state: 'NEVER_RAN', detail: 'no ingestion_runs rows at all' };
  }
  const newest = runs[0];
  const ageHours = (now - new Date(newest.started_at).getTime()) / 3600000;
  if (ageHours > silentAfterHours) {
    return { state: 'SILENT', detail: `no run attempted for ${Math.floor(ageHours)}h (threshold ${silentAfterHours}h)` };
  }
  // Only terminal statuses count toward a failure streak. A row still at 'running' is this tick's
  // own in-flight work, not evidence either way -- counting it as a failure would make the check
  // fail against itself.
  const terminal = runs.filter((r) => r.status !== 'running');
  const streak = [];
  for (const r of terminal) {
    if (r.status === 'failed') streak.push(r);
    else break;
  }
  if (streak.length >= PERSISTENT_FAILURES) {
    return { state: 'BROKEN', detail: `${streak.length} consecutive failed runs` };
  }
  if (streak.length > 0) {
    return { state: 'transient', detail: `${streak.length} recent failure(s), below the ${PERSISTENT_FAILURES}-run threshold` };
  }
  return { state: 'ok', detail: `last run ${newest.status}, ${Math.floor(ageHours)}h ago` };
}

// A workflow must only assert on the sources it is responsible for. Without this the HOURLY
// workflow also checked legiscan, and would report a DAILY feed SILENT every hour during a
// legitimate skipped day -- an alarm firing on normal operation is the kind everybody learns to
// ignore, which is how a real one gets missed later.
export function selectSources(argv, available = SOURCES) {
  const i = argv.indexOf('--only');
  if (i === -1) return available;
  const raw = argv[i + 1];
  if (!raw) throw new Error('--only requires a comma-separated source list');
  const asked = raw.split(',').map((x) => x.trim()).filter(Boolean);
  const unknown = asked.filter((x) => !available.includes(x));
  // Fail loudly rather than silently checking nothing: a typo'd source name that quietly narrowed
  // the check to an empty set would make this script pass by not looking, which is the exact
  // failure mode the script exists to prevent.
  if (unknown.length > 0) {
    throw new Error(`--only: unknown source(s) ${unknown.join(', ')} (expected ${available.join(', ')})`);
  }
  return asked;
}

async function main() {
  const creds = credentials();
  const asJson = process.argv.includes('--json');
  const selected = selectSources(process.argv.slice(2));
  const results = [];
  for (const source of selected) {
    // eslint-disable-next-line no-await-in-loop -- a handful of sequential reads; ordering keeps the log diffable
    const runs = await recentRuns(creds, source, PERSISTENT_FAILURES + 2);
    results.push({ source, ...classify(runs, { silentAfterHours: silenceThreshold(source) }) });
  }

  const bad = results.filter((r) => r.state === 'BROKEN' || r.state === 'SILENT' || r.state === 'NEVER_RAN');

  if (asJson) {
    console.log(JSON.stringify({ healthy: bad.length === 0, results }, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.state.padEnd(10)} ${r.source.padEnd(16)} ${r.detail}`);
    }
    if (bad.length > 0) {
      console.log('');
      for (const r of bad) console.log(`::error::ingest health: ${r.source} is ${r.state} — ${r.detail}`);
      console.log('A source is only reported broken after sustained failure or a full day of silence.');
      console.log('This did NOT come from an exit code: scheduled-ingest.js exits 0 on operational');
      console.log('failure by design, so ingestion_runs is the only honest signal.');
    }
  }
  process.exitCode = bad.length > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) main().catch((err) => { console.error(err.message ?? err); process.exitCode = err?.exitCode ?? 2; });
