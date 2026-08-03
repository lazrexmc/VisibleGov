-- 0026 (draft — Lance applies, URGENT: fixes an ongoing production outage). Restores
-- refresh_vote_aggregates()'s statement_timeout, silently dropped by migration 0022.
--
-- FOUND LIVE (doc-refresh pass, 2026-08-03 ~18:30 UTC): scripts/scheduled-ingest.js's own
-- aggregate-refresh step has been failing on EVERY attempt since 2026-08-03T05:00:12Z — 11
-- consecutive failures by the time this was found, all `57014 canceling statement due to
-- statement timeout`, all ~8-12s (last real success was 04:00:25Z, over 14 hours stale at
-- discovery). Root cause traced exactly: migration 0018a_refresh_timeout.sql fixed this SAME
-- symptom on 2026-07-30 via a separate `alter function ... set statement_timeout = '600s'` — but
-- migration 0022 (applied 2026-08-03) later ran `create or replace function
-- refresh_vote_aggregates() ...` to add the vote-duplicate exclusion join to the three matviews,
-- and Postgres's own documented behavior is that CREATE OR REPLACE FUNCTION resets ALL
-- function-level configuration parameters set by a prior, separate ALTER FUNCTION unless the new
-- definition explicitly re-declares them. 0022's own comment ("refresh_vote_aggregates (0018):
-- UNCHANGED") was accurate about the function BODY (the three refresh statements are identical)
-- but did not account for 0018a's later, separate configuration patch — an easy trap: "the body
-- is unchanged" does not mean "nothing about this function changed."
--
-- Practical effect while broken: public_position_totals, public_party_alignment, and
-- public_party_position_totals (the profile/party-alignment charts on the public site) stopped
-- auto-refreshing; new votes since ~04:00 UTC today are in the base tables but were not reflected
-- on those charts. Not data loss or corruption — purely staleness, and self-healing the moment
-- this migration lands (the very next scheduled tick that writes new rows will refresh cleanly).
--
-- FIX, made durable this time: statement_timeout is now set DIRECTLY in the function's own `set`
-- clause (alongside search_path), not via a separate ALTER FUNCTION statement. A function-level
-- SET clause declared in the CREATE FUNCTION statement itself IS preserved by any future
-- CREATE OR REPLACE that copies this same header — the failure mode above specifically requires a
-- SEPARATE ALTER FUNCTION to be forgotten by a later redefinition; folding it into the function's
-- own declaration removes that separate, easy-to-forget step entirely. Any future migration that
-- needs to touch this function's join chain again should copy this file's `set` clause verbatim.

create or replace function refresh_vote_aggregates()
returns void
language sql
security definer
set search_path = public, pg_temp
set statement_timeout = '600s'
as $$
  refresh materialized view concurrently public_position_totals;
  refresh materialized view concurrently public_party_alignment;
  refresh materialized view concurrently public_party_position_totals;
$$;

revoke all on function refresh_vote_aggregates() from public;
revoke all on function refresh_vote_aggregates() from anon;
grant execute on function refresh_vote_aggregates() to service_role;
