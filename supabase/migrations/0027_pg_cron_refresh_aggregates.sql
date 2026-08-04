-- 0027 (draft — Lance applies). Moves refresh_vote_aggregates() off the synchronous HTTP/RPC path
-- entirely for its routine, scheduled case.
--
-- FOUND LIVE (2026-08-04): the manual `npm run refresh:aggregates` RPC call started failing
-- consistently after the vote-dedup backfill — not PostgREST's old ~8s role-level timeout
-- (0018a/0026's own fix, still correct and still preserved below) but a NEW, separate, shorter
-- ceiling: Supabase's own edge/gateway infrastructure (Cloudflare in front of the whole API
-- surface) kills any synchronous REST/RPC request at a hard ~120-125s. Confirmed by bypassing
-- supabase-js entirely with a raw fetch (a 5-minute client-side abort — it still died at
-- 125,374ms with HTTP 504, `server: cloudflare`, `sb-gateway-version`/`sb-project-ref` headers,
-- body literally "upstream request timeout"). This is independent of the function's own 600s
-- statement_timeout — the HTTP connection watching the request dies first, regardless of what
-- Postgres itself is doing; the underlying REFRESH statements are very likely completing
-- successfully server-side in every failed attempt, with nobody left to see the response (a
-- second failed attempt hit "lock timeout" seconds later, consistent with the FIRST attempt's
-- REFRESH CONCURRENTLY still running server-side after its own connection had already been
-- gateway-killed).
--
-- This isn't a one-off: the SAME function completed in ~19s earlier the same day (right after
-- 0026 landed, verified live) and now consistently exceeds the gateway ceiling as vote_casts
-- (~1.47M rows) keeps growing via the scheduler. A per-call code fix (e.g. splitting the three
-- REFRESH statements into three separate RPC calls) would buy time, not remove the ceiling, and
-- the ceiling only gets harder to stay under as the dataset keeps growing.
--
-- FIX: schedule the refresh as a native pg_cron job running DIRECTLY inside Postgres, on a fixed
-- interval — no HTTP, no PostgREST, no gateway, so this class of timeout becomes structurally
-- impossible for the routine case. The manual RPC path (scripts/refresh-aggregates.js, `npm run
-- refresh:aggregates`) stays available as an on-demand escape hatch and can still occasionally
-- hit the same gateway ceiling — that's now a rare, non-blocking inconvenience rather than the
-- primary freshness mechanism.
--
-- Since pg_cron calls this function directly (no scripts/refresh-aggregates.js wrapper in the
-- loop for the scheduled case), the function now keeps its OWN durable ingestion_runs record
-- (source='refresh-aggregates') — open before, close after, matching what
-- scripts/refresh-aggregates.js's Node-side wrapper used to do on its behalf (senior engineering
-- audit, 2026-08-03, finding 4; that Node-side wrapping is removed in this same pass — see the
-- script's own updated comment — to avoid writing two records per manual invocation now that the
-- function does its own bookkeeping unconditionally). This also makes the manual path MORE
-- reliable than before: even if the HTTP response times out at the gateway, the function's own
-- record (written within the same transaction as the refresh itself, before Postgres would ever
-- send that response back) still reflects the true outcome — `npm run status` / public_freshness
-- is now the authoritative signal for this function's outcome, not the RPC call's own
-- success/failure. Converts the function from `language sql` to `language plpgsql` to get
-- exception handling (needed to record a 'failed' row honestly on a genuine error, rather than
-- leaving one stuck at 'running' forever).
--
-- GENUINE UNKNOWN, flagged rather than assumed: this project has never run REFRESH MATERIALIZED
-- VIEW CONCURRENTLY inside a PL/pgSQL BEGIN/EXCEPTION block before (0018a's own comment records
-- that an earlier reviewer specifically worried about "CONCURRENTLY inside a function" and it did
-- NOT fire for the plain `language sql` case — but a BEGIN/EXCEPTION block adds an implicit
-- subtransaction/savepoint, a materially different context that hasn't been proven here). Verify
-- this actually works by running `select refresh_vote_aggregates();` manually in the SQL editor
-- once after applying this migration (or waiting for the first cron tick and checking
-- `select * from cron.job_run_details order by start_time desc limit 5;` plus
-- `select * from ingestion_runs where source = 'refresh-aggregates' order by started_at desc
-- limit 5;`) before trusting the schedule silently works. If it errors on the CONCURRENTLY
-- statements specifically, the fix is to drop the exception handler (accept a genuine failure
-- aborts the whole transaction, including the 'running' row — an honest missing record rather
-- than a false 'succeeded' one) rather than force bookkeeping around a command that turns out not
-- to tolerate it.
--
-- REMINDER FOR ANY FUTURE REDEFINITION OF THIS FUNCTION (finding 12's own lesson, now the THIRD
-- migration to touch this function's config): copy this file's `set search_path` / `set
-- statement_timeout` clauses verbatim. A CREATE OR REPLACE FUNCTION silently drops config set by
-- a prior SEPARATE ALTER FUNCTION (0022's real production outage, fixed by 0026) — folding it
-- into the function's own declaration, preserved again here, is what makes it survive.

-- Idempotent (create extension if not exists) — Supabase Cron documents this as creating a `cron`
-- schema; harmless no-op if Lance already enabled it via the dashboard's Database > Extensions
-- toggle before applying this file.
create extension if not exists pg_cron with schema cron;

create or replace function refresh_vote_aggregates()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '600s'
as $$
declare
  v_run_id uuid;
begin
  insert into ingestion_runs (source, status)
  values ('refresh-aggregates', 'running')
  returning id into v_run_id;

  refresh materialized view concurrently public_position_totals;
  refresh materialized view concurrently public_party_alignment;
  refresh materialized view concurrently public_party_position_totals;

  update ingestion_runs
  set status = 'succeeded', finished_at = now()
  where id = v_run_id;
exception
  when others then
    update ingestion_runs
    set status = 'failed', finished_at = now(), detail = jsonb_build_object('error', sqlerrm)
    where id = v_run_id;
    raise;
end;
$$;

revoke all on function refresh_vote_aggregates() from public;
revoke all on function refresh_vote_aggregates() from anon;
grant execute on function refresh_vote_aggregates() to service_role;

-- Scheduled every 30 minutes — frequent enough to bound public-chart staleness far tighter than
-- the 14-hour undetected outage this project already had once, infrequent enough not to waste
-- cycles on REFRESH CONCURRENTLY passes when nothing changed (REFRESH CONCURRENTLY still
-- re-executes the full underlying query to diff against the existing rows, so it is not free even
-- on a no-op). cron.schedule() runs jobs as the role that called it (pg_cron's own documented
-- behavior: "jobs are executed... with the same permissions as the current user") — the Supabase
-- SQL editor connects as `postgres` (superuser), so the scheduled job runs with full privileges
-- regardless of the EXECUTE revoke/grant above (superusers bypass GRANT/REVOKE checks entirely);
-- no separate grant on the `cron` schema itself is needed for that same reason. Unschedule-then-
-- reschedule by name makes this statement itself safe to re-run (e.g. after a schema rebuild)
-- without erroring or leaving a duplicate job.
select cron.unschedule(jobid) from cron.job where jobname = 'refresh-vote-aggregates';
select cron.schedule('refresh-vote-aggregates', '*/30 * * * *', 'select refresh_vote_aggregates();');
