// scripts/refresh-aggregates.js — refreshes the two vote-aggregate materialized views (migration
// 0018: public_position_totals, public_party_alignment) via the service-role-only
// refresh_vote_aggregates() SQL function. Run standalone (`npm run refresh:aggregates`, i.e.
// `node --env-file=.env scripts/refresh-aggregates.js`) after applying 0018, and again any time
// the underlying vote_casts/votes/legislators rows change materially.
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

import { getClient } from '../src/lib/db.js';

async function main() {
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const startedAt = new Date().toISOString();
  // refresh_vote_aggregates() is `returns void` — supabase-js's .rpc() posts to
  // /rest/v1/rpc/refresh_vote_aggregates with the service-role key, exactly the call the review
  // specified; `error` carries the typed PostgREST failure (e.g. permission denied if this ever
  // runs against a stale schema cache, or before the unique indexes REFRESH CONCURRENTLY needs
  // exist) instead of throwing, so this can report a clean structured failure either way.
  const { error } = await client.rpc('refresh_vote_aggregates');
  const finishedAt = new Date().toISOString();

  if (error) {
    console.log(JSON.stringify({
      mode: 'failed', startedAt, finishedAt, reason: error.message,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ mode: 'refreshed', startedAt, finishedAt }, null, 2));
}

main();
