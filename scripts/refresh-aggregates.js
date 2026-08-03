// scripts/refresh-aggregates.js — refreshes the three vote-aggregate materialized views (migration
// 0018: public_position_totals, public_party_alignment, public_party_position_totals) via the
// service-role-only refresh_vote_aggregates() SQL function. Run standalone (`npm run
// refresh:aggregates`, i.e. `node --env-file=.env scripts/refresh-aggregates.js`) after applying
// 0018, and again any time the underlying vote_casts/votes/legislators rows change materially.
//
// The ingest/backfill CLIs' own batch loops (src/cli/ingest-legiscan.js, ingest.js, etc.) should
// call refresh_vote_aggregates() at the end of each batch (via getClient().rpc(...), same pattern
// as this script) — added HERE as a documented follow-up, not silently wired into every CLI in
// this same commit (that's a separate, per-CLI change with its own review surface, out of scope
// for task 6b's page/migration work).
//
// Uses the same service-role client helper as every other write-side script (src/lib/db.js's
// getClient(): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment, null if unset —
// null is treated as a dry-run/blocked report here, never a silent no-op). PLAYBOOK_DELTA §7.4:
// Supabase's edge rejects a secret key sent with a browser-shaped user agent — @supabase/
// supabase-js's own fetch (used by getClient()) is not browser-shaped, so this is safe run from
// Node, unlike a raw PowerShell Invoke-RestMethod call.

import { getClient, openRun, closeRun } from '../src/lib/db.js';

// SOURCE: this script's own durable ingestion_runs identity (senior engineering audit, 2026-08-03,
// finding 4). Before this, a refresh's outcome lived ONLY in this script's stdout / the
// scheduler's own gitignored log file — `npm run status` reads public_freshness (migration 0016),
// which is distinct-on-source over ingestion_runs, and nothing refresh-related ever wrote a row
// there, so the exact class of outage 0026 fixed (refreshes silently failing for 14+ hours) would
// have remained fully invisible to `npm run status` even after 0026 shipped. Writing a real row
// under its own source name means the EXISTING freshness surface (and any future one built on
// public_freshness) picks up refresh staleness for free — no new UI, no new query, just an honest
// record where one was structurally missing before.
const SOURCE = 'refresh-aggregates';

async function main() {
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const startedAt = new Date().toISOString();
  // openRun's own failure is deliberately NOT caught here — if we can't even open a durable run
  // record, something is wrong enough (DB unreachable, ingestion_runs missing/locked) that the
  // refresh attempt below would almost certainly fail too, and main().catch() below still reports
  // it as a clean, structured `mode: 'failed'` — this script's contract every OTHER exit path
  // already honors — rather than a raw stack trace.
  const runId = await openRun(client, SOURCE);

  // Same open-then-try/catch-then-close shape as every other CLI's main() in this repo (e.g.
  // src/cli/correct-data.js) — an unexpected throw from the RPC call (network-level failure, not
  // just PostgREST's own {error} response shape) must still close this run as 'failed' rather than
  // leaving it stuck at status='running' forever; the outer main().catch() below only reports
  // clean JSON, it does not know about runId and cannot close it.
  try {
    // refresh_vote_aggregates() is `returns void` — supabase-js's .rpc() posts to
    // /rest/v1/rpc/refresh_vote_aggregates with the service-role key, exactly the call the review
    // specified; `error` carries the typed PostgREST failure (e.g. permission denied if this ever
    // runs against a stale schema cache, or before the unique indexes REFRESH CONCURRENTLY needs
    // exist) instead of throwing, so this can report a clean structured failure either way.
    const { error } = await client.rpc('refresh_vote_aggregates');
    const finishedAt = new Date().toISOString();

    if (error) {
      await closeRun(client, runId, 'failed', { startedAt, finishedAt, reason: error.message });
      console.log(JSON.stringify({
        mode: 'failed', startedAt, finishedAt, reason: error.message,
      }, null, 2));
      process.exitCode = 1;
      return;
    }

    await closeRun(client, runId, 'succeeded', { startedAt, finishedAt });
    console.log(JSON.stringify({ mode: 'refreshed', startedAt, finishedAt }, null, 2));
  } catch (err) {
    await closeRun(client, runId, 'failed', { startedAt, error: String(err && err.message ? err.message : err) });
    throw err;
  }
}

// N-H(d) (task 6b review, fix round 2): main() itself could throw on something the `error`-check
// above never sees (e.g. getClient()'s own createClient() call, or a genuinely unexpected
// exception) — without a top-level .catch(), that would surface as a raw unhandled-rejection
// stack trace instead of the same clean, structured JSON every OTHER exit path in this script
// already produces. Mirrors the `mode: 'failed'` shape above so a caller parsing this script's
// stdout never has to handle two different failure shapes.
main().catch((err) => {
  console.log(JSON.stringify({ mode: 'failed', reason: err.message }, null, 2));
  process.exitCode = 1;
});
