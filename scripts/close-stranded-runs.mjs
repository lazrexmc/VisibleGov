// scripts/close-stranded-runs.mjs — close ingestion_runs rows that started and never finished.
//
// WHY THIS IS A SCRIPT AND NOT A ONE-OFF SQL STATEMENT (2026-08-29). The first stranded row this
// project found — `correct-data`, status='running' since 2026-08-03 — was closed by hand against
// the live database. The values were right, but the operation left NO artifact in the repo: nothing
// anyone can read to see what was done, nothing to review before it runs again, and nothing to run
// the second time it happens. A repair you cannot reproduce from the repo is a repair you have to
// re-derive under pressure, and re-deriving a destructive-ish edit from memory is how the wrong row
// gets touched. `npm run status` now detects these; this closes them.
//
// WHY status='failed' AND NOT 'succeeded': the run did not finish. Recording it as succeeded would
// launder a crash into a success in the permanent record that `public_freshness` reads.
//
// WHY finished_at = started_at: the true end time is unknowable — the process died without saying
// when. A zero-length run is visibly wrong in a way that invites investigation; a plausible invented
// duration is not, and would quietly corrupt any future analysis of run durations.
//
// WHY NOT DELETE THE ROW: it is the evidence that a crash happened. The detector exists because 25
// days of nobody noticing was the defect; deleting the artifact recreates that blindness.
//
// Usage:
//   node --env-file=.env scripts/close-stranded-runs.mjs              # dry run, prints the plan
//   node --env-file=.env scripts/close-stranded-runs.mjs --apply      # writes
//   node --env-file=.env scripts/close-stranded-runs.mjs --hours 12   # override the 6h threshold

// 6h matches scripts/data-status.js's detector. The longest legitimate run in this project is the
// LegiScan child, whose declared timeout is 75 minutes (set from observed runs plus headroom), so
// 6h is a comfortable multiple of the declared per-source ceiling and cannot fire on healthy work.
import { expectArray } from './check-ingest-health.mjs';
import { PER_TICK_CAP_USD, currentWeekKey } from './scheduled-summaries.js';

const DEFAULT_HOURS = 6;

// The conservative charge recorded for a crashed BILLED tick, taken from the scheduler's own hard
// default rather than restated, so the two cannot drift into disagreeing about what an unknown tick
// cost.
export const STRANDED_TICK_CHARGE_USD = PER_TICK_CAP_USD;

// ISO-8601 week key for a timestamp. Delegates to the scheduler's own currentWeekKey instead of
// reimplementing the calculation: two copies of a week derivation will eventually disagree, and then
// a charge lands in a week that nothing sums.
export function isoWeekKeyOf(startedAt) {
  const d = new Date(startedAt);
  return Number.isNaN(d.getTime()) ? null : currentWeekKey(d);
}

function parseArgs(argv) {
  const out = { apply: false, hours: DEFAULT_HOURS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--hours') {
      const v = Number(argv[i += 1]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`--hours must be a positive number, got ${argv[i]}`);
      out.hours = v;
    } else throw new Error(`unknown flag: ${argv[i]}`);
  }
  return out;
}

export function closureFor(run, { now = new Date() } = {}) {
  const startedMs = new Date(run.started_at).getTime();
  const stuckHours = Math.floor((now.getTime() - startedMs) / 3600000);
  return {
    status: 'failed',
    finished_at: run.started_at,
    detail: {
      ...(run.detail && typeof run.detail === 'object' ? run.detail : {}),
      closed_by: 'scripts/close-stranded-runs.mjs',
      closed_at: now.toISOString(),
      // PRESERVE THE SPEND CHARGE ACROSS CLOSURE (2026-11-04). Closing a row used to make its
      // spend VANISH from the billed scheduler's weekly ledger. summarizeWeekSpend charges a
      // status='running' row the conservative per-tick cap, but reads a CLOSED row's
      // detail.spent_usd - which this function never wrote - so a closed crash counted as $0.
      //
      // That made closing a row the UNSAFE direction: a tick that died after spending real money
      // became free in the books, and the weekly cap quietly stopped being the cap. Six
      // scheduled-summaries rows were closed on 2026-11-04, each having spent up to the cap, and
      // all six read as $0 afterwards.
      //
      // The true figure is unknowable - the cost tracker died with the process - so the conservative
      // cap is recorded, which is exactly what the ledger was already charging while the row sat
      // open. week_key travels with it because the ledger skips any row whose week_key does not
      // match the week being summed; without it the value would be written and never read.
      //
      // Scoped to the billed runner ONLY. Other sources have no spend ledger, and inventing a
      // dollar figure for an unbilled ingest run would fabricate a cost that never existed.
      ...(run.source === 'scheduled-summaries' && run.detail?.spent_usd == null
        ? {
          spent_usd: STRANDED_TICK_CHARGE_USD,
          week_key: run.detail?.week_key ?? isoWeekKeyOf(run.started_at),
          spend_is_estimated: true,
          spend_estimate_basis: 'the per-tick cap in force at closure; the real figure died with the process',
        }
        : {}),
      reason: `process died without closing the run; row sat at status='running' for ${stuckHours}h. `
        + 'finished_at set to started_at because the true end time is unknowable — inventing one '
        + 'would corrupt duration analysis. Recorded failed, not succeeded: it did not finish.',
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const err = new Error('close-stranded-runs: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    err.exitCode = 2;
    throw err;
  }
  return closeStranded({ url, key, hours: args.hours, apply: args.apply });
}

// Extracted from main() and given an injectable fetch, 2026-08-29, so the two things most likely to
// regress silently can actually be tested: that a dry run writes NOTHING, and that the write is
// guarded by id AND status.
//
// Neither is provable from the outside. A dry run that quietly issued a PATCH would look identical
// to a correct one in the console, and the status filter only matters in a race that is impractical
// to stage against a live database. Both were listed as untested for two review rounds; this is
// what closes them.
export async function closeStranded({
  url, key, hours = DEFAULT_HOURS, apply = false, fetchFn = fetch, log = console.log,
} = {}) {
  const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  const listRes = await fetchFn(
    `${url}/rest/v1/ingestion_runs?status=eq.running&started_at=lt.${cutoff}`
    + '&select=id,source,started_at,detail&order=started_at.asc',
    { headers: H },
  );
  if (!listRes.ok) throw new Error(`ingestion_runs query failed: HTTP ${listRes.status}`);
  const stranded = expectArray(await listRes.json(), 'close-stranded list');

  if (stranded.length === 0) {
    log(`no stranded runs older than ${hours}h — nothing to close`);
    return { found: 0, closed: 0, skipped: 0, wrote: false };
  }

  log(`${stranded.length} stranded run(s) older than ${hours}h:\n`);
  for (const run of stranded) {
    const c = closureFor(run);
    log(`  ${run.source}  started ${String(run.started_at).slice(0, 19)}`);
    log(`    -> status=${c.status}, finished_at=${String(c.finished_at).slice(0, 19)}`);
  }

  if (!apply) {
    log('\nDRY RUN — nothing written. Re-run with --apply to close these.');
    return { found: stranded.length, closed: 0, skipped: 0, wrote: false };
  }

  let closed = 0;
  let skipped = 0;
  for (const run of stranded) {
    const c = closureFor(run);
    // Guarded by id AND status: if the row closed itself between the read above and this write
    // (a slow run that finally finished), the status filter makes this a no-op rather than
    // overwriting a real, successful outcome with a fabricated failure.
    // eslint-disable-next-line no-await-in-loop -- sequential; the list is tiny and order aids the log
    const res = await fetchFn(`${url}/rest/v1/ingestion_runs?id=eq.${run.id}&status=eq.running`, {
      method: 'PATCH',
      headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify(c),
    });
    if (!res.ok) throw new Error(`failed to close ${run.id}: HTTP ${res.status} ${await res.text()}`);
    // return=representation gives the rows actually written. A non-array here would make
    // `rows.length === 0` false and count an unreadable response as a SUCCESSFUL close, which is
    // the worst of the three fail-open cases: it reports a repair that may not have happened.
    const rows = expectArray(await res.json(), 'close-stranded PATCH result');
    if (rows.length === 0) {
      skipped += 1;
      log(`  SKIPPED ${run.source} — it closed itself between the read and the write`);
    } else {
      closed += 1;
    }
  }
  log(`\nclosed ${closed} of ${stranded.length}`);
  return { found: stranded.length, closed, skipped, wrote: true };
}

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) main().catch((err) => { console.error(err.message ?? err); process.exitCode = err?.exitCode ?? 2; });
