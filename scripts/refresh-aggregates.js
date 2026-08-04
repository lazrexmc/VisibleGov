// scripts/refresh-aggregates.js — manually triggers the three vote-aggregate materialized views
// (migration 0018: public_position_totals, public_party_alignment, public_party_position_totals)
// via the service-role-only refresh_vote_aggregates() SQL function. Run standalone (`npm run
// refresh:aggregates`, i.e. `node --env-file=.env scripts/refresh-aggregates.js`) for an on-demand
// refresh right after a bulk data correction — the ROUTINE refresh no longer depends on this
// script at all (migration 0027 schedules the same function directly inside Postgres via pg_cron,
// no HTTP/PostgREST/gateway layer involved), so this is now an escape hatch, not the primary
// freshness mechanism.
//
// Uses the same service-role client helper as every other write-side script (src/lib/db.js's
// getClient(): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment, null if unset —
// null is treated as a dry-run/blocked report here, never a silent no-op). PLAYBOOK_DELTA §7.4:
// Supabase's edge rejects a secret key sent with a browser-shaped user agent — @supabase/
// supabase-js's own fetch (used by getClient()) is not browser-shaped, so this is safe run from
// Node, unlike a raw PowerShell Invoke-RestMethod call.
//
// PLAYBOOK_DELTA lesson 26 (2026-08-04): a manual invocation of this RPC can still occasionally
// hit Supabase's own edge-gateway ~120s timeout on synchronous REST/RPC requests (a real,
// confirmed-live ceiling, separate from and shorter than the function's own 600s DB-side
// statement_timeout). If THIS SCRIPT reports `mode: 'failed'` with a timeout-shaped reason, that
// does NOT necessarily mean the refresh itself failed — refresh_vote_aggregates() now keeps its
// OWN durable ingestion_runs record (source='refresh-aggregates', written inside the same
// transaction as the refresh, before Postgres would ever send the HTTP response back), so
// `npm run status` / public_freshness is the authoritative signal for whether it actually
// succeeded, not this script's own exit code.

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
  // exist) instead of throwing, so this can report a clean structured failure either way. The
  // function's own bookkeeping (migration 0027) is unconditional — it happens whether this call
  // ultimately reports success, failure, or times out client-side, so no openRun/closeRun
  // wrapping belongs here anymore (that would write a SECOND, redundant ingestion_runs row on top
  // of the function's own — this script no longer owns that responsibility).
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
