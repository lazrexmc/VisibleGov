-- 0029 (draft — Lance applies). Fixes the REAL root cause behind Layer 3 of the refresh-aggregates
-- saga: a Postgres query-planner misestimation, not a compute/scale problem at all.
--
-- FOUND LIVE (2026-08-04): with Layers 1 (edge-gateway timeout, 0027) and 2 (statement_timeout
-- arm-timing, 0028) both fixed and confirmed, pg_cron's `refresh_vote_aggregates()` ticks kept
-- failing anyway — now genuinely hitting the real 600s statement_timeout ceiling on actual query
-- duration, always on the exact same line: `refresh materialized view concurrently
-- public_party_alignment`. Confirmed reproducible across 5+ consecutive real ticks. A live debug
-- run (bypassing pg_cron's own ceiling via a temporarily-raised database default) showed the
-- underlying computation was STILL actively running (not blocked/stuck — confirmed via
-- pg_stat_activity's wait_event being null) past 40 minutes elapsed for a query over ~1.47M rows —
-- wildly disproportionate for a straightforward join/aggregate on modern hardware.
--
-- ROOT CAUSE (confirmed via `explain`, not guessed — a plain EXPLAIN with no ANALYZE returns
-- instantly regardless of true execution time, and should have been the FIRST diagnostic reached
-- for, not the last): all three matviews exclude superseded votes via the classic
-- `left join vote_duplicates vd on vd.superseded_vote_id = v.id ... where vd.id is null` anti-join
-- idiom (added by 0022). Postgres's planner catastrophically misestimated this specific pattern's
-- selectivity as **1 row** (`Hash Left Join ... rows=1`) when the honest answer, given `votes` has
-- ~10,103 rows and `vote_duplicates` only 59, is ~10,044 rows (99.4% of votes are NOT superseded).
-- This is a known, documented Postgres planner limitation: a post-join `IS NULL` filter on a
-- LEFT-JOIN-introduced column often gets its selectivity estimated from the joined column's OWN
-- null-fraction statistic (here, `vote_duplicates.id`, a primary key — 0% null, always) instead of
-- correctly modeling how often the join itself fails to match and produces a null-extended row.
-- That single 10,044-times-too-low estimate cascades through the ENTIRE downstream plan: every
-- later join gets planned as a Nested Loop (cheap for ~1 row, catastrophic for the true
-- ~1.34-million-row reality once vote_casts and legislators join in) — this is exactly what turns a
-- query that should take low single-digit seconds into 40+ minutes and climbing.
--
-- Confirmed via a second `explain`: rewriting the SAME exclusion as `not exists (select 1 from
-- vote_duplicates vd where vd.superseded_vote_id = v.id)` produces a correct `Hash Anti Join`
-- estimate of exactly 10,044 rows, and the full plan resolves to proper Hash Joins throughout
-- (cascading to a correctly-estimated ~1,341,493-row final join) instead of nested loops. Same
-- semantics, same excluded rows, different (correct) plan shape — this is a pure query-shape fix,
-- not a data or index change. `public_party_alignment` hit the wall first only because its extra
-- CTEs and self-join amplify nested-loop damage the most; `public_position_totals` and
-- `public_party_position_totals` carry the identical latent risk as vote_casts keeps growing and
-- are fixed here too, before either one actually fails the same way.
--
-- Materialized views can't be ALTERed to change their defining query — all three are dropped and
-- recreated in full, exactly as 0022 already did for the same reason. Every column, GROUP BY,
-- unique index, and grant below is otherwise IDENTICAL to 0022's versions — only the anti-join
-- shape changes. refresh_vote_aggregates() itself is NOT touched by this migration: it calls
-- `refresh materialized view concurrently <name>` as opaque text inside its body, which Postgres
-- does not track as a formal dependency on the matview's own definition, so dropping/recreating the
-- three matviews does not cascade into the function and does not risk re-triggering finding 12's
-- own lesson (a CREATE OR REPLACE FUNCTION silently dropping the function's `set statement_timeout`
-- — irrelevant here since the function isn't being redefined at all).
--
-- NOT bundled into this migration (deliberately, to keep this fix focused and unblock the actual
-- production issue first): the separate, already-documented bug in 0027's exception handler (an
-- `update ... 'failed' ...; raise;` that can never actually leave a row behind, since PL/pgSQL's
-- implicit per-EXCEPTION-block savepoint rolls back the earlier 'running' insert before the handler
-- even runs, and the trailing `raise;` then aborts the whole transaction including the handler's own
-- no-op update). That bug makes genuine failures invisible to `ingestion_runs`/`npm run status` —
-- real, but strictly an observability gap, not a cause of the timeouts themselves, and now that this
-- migration should make the routine case complete in seconds rather than exceed any timeout at all,
-- it's lower priority. Left as an open, documented follow-up (see TODO.md) rather than widening this
-- migration's blast radius while the actual outage is still live.

drop materialized view if exists public_position_totals cascade;
create materialized view public_position_totals as
select
  vc.legislator_id,
  v.jurisdiction_id,
  v.chamber,
  date_part('year', v.vote_date)::int as year,
  vc.position,
  case l.party
    when 'R' then 'Republican'
    when 'D' then 'Democratic'
    when 'I' then 'Independent'
    else l.party
  end as party,
  count(*)::int as casts
from vote_casts vc
join votes v on v.id = vc.vote_id
join legislators l on l.id = vc.legislator_id
where not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id = v.id)
group by 1, 2, 3, 4, 5, 6;

create unique index public_position_totals_uq
  on public_position_totals (legislator_id, jurisdiction_id, chamber, year, position);
grant select on public_position_totals to anon, authenticated;

drop materialized view if exists public_party_alignment cascade;
create materialized view public_party_alignment as
with caster_casts as (
  select
    vc.vote_id,
    vc.legislator_id,
    vc.position,
    case l.party
      when 'R' then 'Republican'
      when 'D' then 'Democratic'
      when 'I' then 'Independent'
      else l.party
    end as party,
    v.vote_date,
    v.chamber
  from vote_casts vc
  join legislators l on l.id = vc.legislator_id
  join votes v on v.id = vc.vote_id
  where vc.position in ('yea', 'nay')
    and not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id = v.id)
),
normalized_casts as (
  select * from caster_casts where party in ('Republican', 'Democratic', 'Independent')
),
party_tallies as (
  select
    vote_id,
    party,
    count(*) filter (where position = 'yea')::int as party_yea,
    count(*) filter (where position = 'nay')::int as party_nay
  from normalized_casts
  group by vote_id, party
),
party_majority as (
  select
    vote_id,
    party,
    party_yea,
    party_nay,
    case
      when party_yea > party_nay then 'yea'
      when party_nay > party_yea then 'nay'
      else null
    end as majority_position
  from party_tallies
)
select
  cc.legislator_id,
  date_part('year', cc.vote_date)::int as year,
  cc.chamber,
  count(*)::int as comparable,
  count(*) filter (where cc.position = pm.majority_position)::int as matched
from normalized_casts cc
join party_majority pm on pm.vote_id = cc.vote_id and pm.party = cc.party
where pm.majority_position is not null
  and (pm.party_yea + pm.party_nay) > 1
group by cc.legislator_id, date_part('year', cc.vote_date)::int, cc.chamber;

create unique index public_party_alignment_uq
  on public_party_alignment (legislator_id, year, chamber);
grant select on public_party_alignment to anon, authenticated;

drop materialized view if exists public_party_position_totals cascade;
create materialized view public_party_position_totals as
with normalized as (
  select
    case l.party
      when 'R' then 'Republican'
      when 'D' then 'Democratic'
      when 'I' then 'Independent'
      else l.party
    end as party,
    v.jurisdiction_id,
    v.chamber,
    v.vote_date,
    vc.position
  from vote_casts vc
  join votes v on v.id = vc.vote_id
  join legislators l on l.id = vc.legislator_id
  where not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id = v.id)
)
select
  party,
  jurisdiction_id,
  chamber,
  date_part('year', vote_date)::int as year,
  position,
  count(*)::int as casts
from normalized
where party in ('Republican', 'Democratic', 'Independent')
group by 1, 2, 3, 4, 5;

create unique index public_party_position_totals_uq
  on public_party_position_totals (party, jurisdiction_id, chamber, year, position);
grant select on public_party_position_totals to anon, authenticated;
