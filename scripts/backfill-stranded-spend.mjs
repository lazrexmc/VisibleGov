// scripts/backfill-stranded-spend.mjs — put the spend charge back on scheduled-summaries rows that
// were closed BEFORE closureFor learned to record one.
//
// WHY THIS EXISTS (2026-11-05). Six crashed billed ticks sat at status='running' from 2026-10-20 to
// 2026-11-04. While they sat open, summarizeWeekSpend charged each of them the conservative
// per-tick cap — that is its documented doctrine, unknown spend is treated as spent. On 2026-11-04
// they were closed by scripts/close-stranded-runs.mjs, which at that moment wrote no spent_usd and
// no week_key. The ledger reads a CLOSED row's detail.spent_usd, so all six dropped to $0 the
// instant they were tidied up. The scheduler's own logs record the swing: ISO week 2026-W45 read
// total=$11.41 on 11-02 and total=$6.92 on 11-04, having spent MORE money in between.
//
// closureFor was fixed the same day, so any FUTURE closure carries its charge. These six predate
// the fix and are the only rows that need repairing. This script is that repair, written as a
// reviewable artifact rather than a hand-typed UPDATE, for the same reason close-stranded-runs.mjs
// is a script: a repair you cannot read in the repo is one you have to re-derive under pressure.
//
// WHAT IT WILL AND WILL NOT TOUCH. Only rows that are ALL of: source='scheduled-summaries' (no
// other source has a spend ledger, and inventing a cost for an unbilled ingest run would fabricate
// a number that never existed), closed by close-stranded-runs.mjs (so the crash is established by
// an artifact, not inferred from a status), and carrying NO spent_usd (a tick that recorded its own
// figure knows better than this script does, and a measured number is never overwritten by an
// estimate).
//
// THE FIGURE IS AN ESTIMATE AND SAYS SO IN THE ROW. spend_is_estimated:true travels with it. The
// true cost died with the process; the cap is what the ledger was already enforcing against these
// rows while they were open, so recording it changes nothing about what was allowed to be spent —
// it only stops a later reader concluding the crashes were free.
//
// WHAT IT ACTUALLY CHANGES IN PRACTICE, stated plainly because the honest answer is "less than it
// looks": the scheduler sums only the last 10 days (scheduled-summaries.js's tenDaysAgoIso), so of
// the six rows only the recent ones can still affect what a live tick is allowed to spend. The
// older ones are being repaired for the permanent record and for any later analysis of what the
// billed lane cost, not to gate anything.
//
// Usage:
//   node --env-file=.env scripts/backfill-stranded-spend.mjs           # dry run, prints the plan
//   node --env-file=.env scripts/backfill-stranded-spend.mjs --apply   # writes

import { expectArray } from './check-ingest-health.mjs';
import { strandedSpendPatch, STRANDED_TICK_CHARGE_USD } from './close-stranded-runs.mjs';
import { WEEKLY_CAP_USD } from './scheduled-summaries.js';

// ONE filter expression, used for the read AND the write. Writing it twice is how a dry run comes
// to preview a different set of rows than the apply touches; and because `spent_usd=is.null` is part
// of it, re-running --apply is a no-op rather than a second charge. That idempotence is the whole
// reason the guard lives in the query instead of in a JavaScript check after the read.
export const TARGET_FILTER = 'source=eq.scheduled-summaries'
  + '&detail->>closed_by=eq.scripts/close-stranded-runs.mjs'
  + '&detail->>spent_usd=is.null';

function parseArgs(argv) {
  const out = { apply: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

// The patch body: the spend fields only, plus a marker naming what wrote them. Deliberately does
// NOT touch status, finished_at or reason — those were set correctly at closure and re-deriving
// them now, from a `now` 1 to 16 days later, would rewrite a stuck-duration that was right.
export function backfillFor(run) {
  const patch = strandedSpendPatch(run);
  if (Object.keys(patch).length === 0) return null;
  return {
    detail: {
      ...(run.detail && typeof run.detail === 'object' ? run.detail : {}),
      ...patch,
      spend_backfilled_by: 'scripts/backfill-stranded-spend.mjs',
    },
  };
}

export async function backfillStrandedSpend({
  url, key, apply = false, fetchFn = fetch, log = console.log,
} = {}) {
  const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  const listRes = await fetchFn(
    `${url}/rest/v1/ingestion_runs?${TARGET_FILTER}&select=id,source,status,started_at,detail&order=started_at.asc`,
    { headers: H },
  );
  if (!listRes.ok) throw new Error(`ingestion_runs query failed: HTTP ${listRes.status} ${await listRes.text()}`);
  const targets = expectArray(await listRes.json(), 'backfill-stranded-spend list');

  if (targets.length === 0) {
    log('no closed stranded billed ticks are missing a spend charge — nothing to backfill');
    return { found: 0, written: 0, skipped: 0, wrote: false, byWeek: {} };
  }

  const byWeek = {};
  log(`${targets.length} closed stranded tick(s) missing a spend charge:\n`);
  for (const run of targets) {
    const patch = backfillFor(run);
    const wk = patch.detail.week_key;
    byWeek[wk] = (byWeek[wk] ?? 0) + Number(patch.detail.spent_usd);
    log(`  ${String(run.started_at).slice(0, 19)}  status=${run.status}`);
    log(`    -> spent_usd=$${Number(patch.detail.spent_usd).toFixed(2)}  week_key=${wk}  (estimated)`);
  }

  log('\nweeks affected:');
  for (const [wk, add] of Object.entries(byWeek).sort()) {
    log(`  ${wk}  +$${add.toFixed(2)} against the $${WEEKLY_CAP_USD.toFixed(2)} cap`);
  }

  if (!apply) {
    log('\nDRY RUN — nothing written. Re-run with --apply to record these charges.');
    return { found: targets.length, written: 0, skipped: 0, wrote: false, byWeek };
  }

  let written = 0;
  let skipped = 0;
  for (const run of targets) {
    const patch = backfillFor(run);
    // Guarded by id AND the same spent_usd=is.null condition the read used, so a row that acquired
    // a figure between the read and this write is left alone rather than overwritten.
    // eslint-disable-next-line no-await-in-loop -- sequential; the list is tiny and order aids the log
    const res = await fetchFn(
      `${url}/rest/v1/ingestion_runs?id=eq.${run.id}&detail->>spent_usd=is.null`,
      { method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(patch) },
    );
    if (!res.ok) throw new Error(`failed to backfill ${run.id}: HTTP ${res.status} ${await res.text()}`);
    // return=representation gives the rows actually written. A non-array would make
    // `rows.length === 0` false and count an unreadable response as a successful write — reporting a
    // repair that may not have happened, which is the worst of the fail-open cases.
    const rows = expectArray(await res.json(), 'backfill-stranded-spend PATCH result');
    if (rows.length === 0) {
      skipped += 1;
      log(`  SKIPPED ${String(run.started_at).slice(0, 19)} — it acquired a spend figure between the read and the write`);
    } else {
      written += 1;
    }
  }
  log(`\nbackfilled ${written} of ${targets.length} at $${STRANDED_TICK_CHARGE_USD.toFixed(2)} each`);
  return { found: targets.length, written, skipped, wrote: true, byWeek };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const err = new Error('backfill-stranded-spend: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    err.exitCode = 2;
    throw err;
  }
  return backfillStrandedSpend({ url, key, apply: args.apply });
}

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) main().catch((err) => { console.error(err.message ?? err); process.exitCode = err?.exitCode ?? 2; });
