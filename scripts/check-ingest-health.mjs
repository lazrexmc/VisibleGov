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
// MEASURED AGAINST THE REAL POPULATION 2026-08-30 00:09 CDT, after league's 6.15 withdrew a window
// computed over the wrong one. The right measure is not the longest RUN, it is the longest GAP
// BETWEEN successful runs, which is what a silence window actually bounds.
//
// Gaps > 20h over 60 days, and what they turned out to be. All timestamps below are UTC, as
// stored in ingestion_runs; the prose dates in this comment are CDT. Mixing the two silently is
// exactly the confusion Lance flagged, so both are labelled:
//
//   us-congress    94.3h   2026-07-28 -> 08-01 UTC
//   us-senate      92.7h   2026-07-28 -> 08-01 UTC
//   legiscan       37.8h   2026-07-29 -> 07-31 UTC
//   mo-house-xml   26.8h   2026-07-31 -> 08-01 UTC
//
// EVERY ONE ENDS ON 08-01 UTC, the day scheduled-ingest.js was registered as a Windows task. They are
// the startup pass, not steady state. Taking max-gap at face value would have widened every window
// past 95h and blinded the detector for four days at a stretch - the exact error league made and
// withdrew. The population that matters begins 2026-08-01.
//
// Steady state since then:
//   hourly sources   no gap above 20h at all; p99 is 1.5-3.2h
//   legiscan         24.1-24.3h every cycle, with ONE excursion to 28.3h (08-12 -> 08-13 UTC)
//
// So both windows hold, and legiscan's holds for the reason it was derived rather than by luck:
// a normal cycle is 24.2h, so ONE skipped cycle lands at ~48.4h, just inside 50h, and two land at
// ~72.6h, well outside. The skip-a-day mechanism reasoned about when this was set is real and the
// number was sized correctly for it. 25h for the hourly sources has roughly 8x margin on p99.
//
// Re-run the measurement before changing either number, and exclude anything before 2026-08-01 UTC.
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

// A PostgREST list endpoint returns an array. When it does not, every caller here measures
// `.length` on undefined, which is falsy, and the check reports HEALTHY on a response it could not
// read. That is "absence reported as unknown disarms the detector" at the transport layer: this
// file enforces the rule for feeds and then trusted the wire itself.
//
// Throwing reaches main()'s catch and exits 2, which is the honest code. 1 would say "checked, and
// something is broken"; 2 says "could not check", and those must never collapse into each other.
//
// Exported so the tests can drive it directly rather than staging a malformed HTTP response.
export function expectArray(body, context) {
  if (!Array.isArray(body)) {
    throw Object.assign(
      new Error(`${context}: expected an array from PostgREST, got ${body === null ? 'null' : typeof body}`),
      { exitCode: 2 },
    );
  }
  return body;
}

async function recentRuns({ url, key }, source, limit) {
  const path = `ingestion_runs?source=eq.${encodeURIComponent(source)}`
    + `&select=status,started_at,finished_at&order=started_at.desc&limit=${limit}`;
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`ingestion_runs query failed for ${source}: HTTP ${r.status}`);
  return expectArray(await r.json(), 'recentRuns');
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

// STRANDED RUNS -- a row that started and never closed.
//
// This lives here, in the thing that runs hourly in CI, and NOT only in `npm run status`, because
// of a correction from the league session: a sentinel is necessary but not sufficient -- the
// finding needs a branch that ACTS on it. `npm run status` printed stranded runs beautifully and
// nothing ever read that output unless a human chose to look, which is precisely the condition
// that let a `correct-data` row sit at status='running' for 25 DAYS while every heartbeat stayed
// green. Detecting it and requiring a human to notice the detection is the same failure one level
// up.
//
// DELIBERATELY NOT SCOPED BY --only, unlike the per-source feed checks above. Those answer "is the
// feed I own alive", which is a question each workflow should only ask about its own sources. This
// answers "did some process crash and leave a row open", which nothing else observes at all -- the
// original stranded row was `correct-data`, a manual CLI that no workflow owns, so a scoped check
// would never have caught it. The hourly job is the only thing running regularly enough to be the
// watchdog, so it watches everything.
//
// 6h matches scripts/data-status.js. The longest legitimate run is the LegiScan child at a declared
// 75-minute timeout, so 6h is a comfortable multiple and cannot fire on healthy work. The CI job's
// own in-flight row is minutes old and never trips it.
const STRANDED_AFTER_HOURS = 6;

async function strandedRuns({ url, key }, { now = Date.now() } = {}) {
  const cutoff = new Date(now - STRANDED_AFTER_HOURS * 3600000).toISOString();
  const path = `ingestion_runs?status=eq.running&started_at=lt.${cutoff}`
    + '&select=source,started_at&order=started_at.asc';
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`stranded-run query failed: HTTP ${r.status}`);
  return expectArray(await r.json(), 'strandedRuns');
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

// THE ACTING BRANCH, extracted so it can be unit-tested rather than described.
//
// A sentinel is necessary but not sufficient: the finding needs something that ACTS on it (league
// session, 2026-08-30). Exiting non-zero fails the workflow, which notifies. Both axes must be able
// to trigger it independently -- a dead feed with no stranded rows, and a stranded row while every
// feed is healthy, are each a real failure, and the second is the one that went unnoticed for 25
// days precisely because nothing was checking it on a schedule.
export function exitCodeFor({ results = [], stranded = [] } = {}) {
  const bad = results.filter((r) => r.state === 'BROKEN' || r.state === 'SILENT' || r.state === 'NEVER_RAN');
  return (bad.length > 0 || stranded.length > 0) ? 1 : 0;
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

  const stranded = await strandedRuns(creds);
  const bad = results.filter((r) => r.state === 'BROKEN' || r.state === 'SILENT' || r.state === 'NEVER_RAN');

  if (asJson) {
    console.log(JSON.stringify({ healthy: bad.length === 0 && stranded.length === 0, results, stranded }, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.state.padEnd(10)} ${r.source.padEnd(16)} ${r.detail}`);
    }
    for (const r of stranded) {
      const hours = Math.floor((Date.now() - new Date(r.started_at).getTime()) / 3600000);
      console.log(`STRANDED   ${String(r.source).padEnd(16)} running ${hours}h, since ${String(r.started_at).slice(0, 19)}`);
    }
    if (stranded.length > 0) {
      console.log('');
      for (const r of stranded) {
        console.log(`::error::stranded run: ${r.source} started ${String(r.started_at).slice(0, 19)} and never closed`);
      }
      console.log('A run that never closed is a CRASH, not activity. Close it with');
      console.log('`npm run close-stranded` (dry-run; add -- --apply to write) rather than deleting');
      console.log('it -- the row is the evidence of what happened.');
    }
    if (bad.length > 0) {
      console.log('');
      for (const r of bad) console.log(`::error::ingest health: ${r.source} is ${r.state} — ${r.detail}`);
      console.log('A source is only reported broken after sustained failure or a full day of silence.');
      console.log('This did NOT come from an exit code: scheduled-ingest.js exits 0 on operational');
      console.log('failure by design, so ingestion_runs is the only honest signal.');
    }
  }
  process.exitCode = exitCodeFor({ results, stranded });
}

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) main().catch((err) => { console.error(err.message ?? err); process.exitCode = err?.exitCode ?? 2; });
