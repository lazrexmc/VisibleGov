-- 0022 (draft — Lance applies). Cross-adapter vote duplicate dedup (docs/superpowers/specs/
-- 2026-08-03-vote-duplicate-dedup-design.md): implements CONTROLLER RULING 3
-- (docs/superpowers/plans/2026-07-29-legiscan-bulk-adapter.md:604-609) — "the primary-source
-- (journal/PDF) row wins for display whenever both exist for the same (chamber, date, bill,
-- tallies)" — never built until now. Both LegiScan and MO's own primary-source adapters can
-- legitimately each write their own `votes` row for the same real floor vote; this migration adds a
-- non-destructive way to mark one the winner and exclude the other from every public read, without
-- ever deleting or rewriting either row.
--
-- Non-destructive precedent this mirrors: persons/person_links (migration 0012) — "source
-- legislator rows are never deleted or rewritten; a person groups them at read time." Same here:
-- both votes rows stay forever, fully traceable. This is explicitly NOT the codebase's one
-- sanctioned delete (retractLegiscanVoteIfStored, src/cli/ingest-legiscan.js) — that function is
-- scoped to genuine LegiScan-vs-primary CONTRADICTIONS and throws if called on anything else; this
-- table is for legitimately AGREEING duplicates, a different case, never conflated.
--
-- SUPERSEDED-BY notice (senior engineering audit, 2026-08-03, finding 12): two definitions in
-- THIS file are no longer current — public_vote_feed/public_votes below (superseded by 0023) and
-- refresh_vote_aggregates() below (superseded by 0026, after 0022 silently dropped 0018a's
-- statement_timeout setting and caused a real ~14-hour production outage). Each superseded block
-- carries its own inline note. Applying this file's CREATE TABLE section again is safe (no `if not
-- exists`, so a re-run fails loudly and rolls back rather than reapplying anything) — the real
-- hazard is copying an individual section out of this file into a NEW migration, which would
-- silently reintroduce either bug with no error at all. Always check a block's own inline note
-- (and 0023/0026 directly) before reusing anything from this file.

create table vote_duplicates (
  id                 uuid primary key default gen_random_uuid(),
  canonical_vote_id  uuid not null references votes(id),
  superseded_vote_id uuid not null unique references votes(id),
  reason             text not null,
  created_at         timestamptz default now()
);
-- No anon-facing grant on this table itself — it's an internal marking table. The three consumers
-- below expose its EFFECT (exclusion), never its own rows, matching this schema's existing
-- "the view is the policy" posture for internal tables (e.g. summary_verifications, 0004).

-- public_vote_feed (0016_public_read_surface.sql): add the exclusion. Everything else about this
-- view is UNCHANGED from 0016's own definition.
-- SUPERSEDED-BY 0023: joining the newly-locked vote_duplicates table into an invoker view makes
-- security_invoker=true structurally inert for anon (the join sees zero vote_duplicates rows under
-- anon's own RLS, so the exclusion below can never fire). 0023 is the current, correct definition
-- (owner-bypass, no security_invoker). Do not copy this block forward.
drop view if exists public_vote_feed;
create view public_vote_feed with (security_invoker = true) as
select
  vc.id            as cast_id,
  vc.legislator_id,
  vc.position,
  v.id             as vote_id,
  v.vote_date,
  v.chamber,
  v.question,
  v.result,
  v.source_url,
  v.jurisdiction_id,
  b.id             as bill_id,
  b.identifier     as bill_identifier,
  b.title          as bill_title,
  b.session_id
from vote_casts vc
join votes v on v.id = vc.vote_id
left join bills b on b.id = v.bill_id
left join vote_duplicates vd on vd.superseded_vote_id = v.id
where vd.id is null;
grant select on public_vote_feed to anon, authenticated;

-- public_votes: a new view for site/js/bill-page.js, which queries the raw `votes` table directly
-- today (not through any view) — the one consumer that needs a new access path. Same columns
-- bill-page.js's own VOTES_SELECT already asks for, plus the same exclusion. votes' own existing
-- direct anon grant is left untouched (known residual, spec §4 — out of scope to audit every other
-- consumer of that grant here).
-- SUPERSEDED-BY 0023: same security_invoker inertness issue as public_vote_feed above. 0023 is the
-- current, correct definition. Do not copy this block forward.
create view public_votes with (security_invoker = true) as
select
  v.id, v.bill_id, v.jurisdiction_id, v.chamber, v.vote_date, v.question, v.result,
  v.source_url, v.source_key
from votes v
left join vote_duplicates vd on vd.superseded_vote_id = v.id
where vd.id is null;
grant select on public_votes to anon, authenticated;

-- The three vote-aggregate matviews (0018_vote_aggregates.sql): same exclusion added to each base
-- join chain. This is the half of the fix that corrects the actual double-counted percentages, not
-- just a display list. Recreated in full (materialized views can't be ALTERed to add a join) —
-- every other column/grouping/index/grant below is IDENTICAL to 0018's own definition, only the
-- join chain changes.
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
left join vote_duplicates vd on vd.superseded_vote_id = v.id
where vd.id is null
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
  left join vote_duplicates vd on vd.superseded_vote_id = v.id
  where vc.position in ('yea', 'nay') and vd.id is null
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
  left join vote_duplicates vd on vd.superseded_vote_id = v.id
  where vd.id is null
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

-- refresh_vote_aggregates (0018): UNCHANGED — recreated here only because CREATE OR REPLACE FUNCTION
-- must follow its dependent matviews being recreated above, not because its own body changed.
-- THIS "UNCHANGED" CLAIM WAS THE BUG: 0018a had separately ALTERed this function to add
-- `set statement_timeout = '600s'`, and CREATE OR REPLACE FUNCTION does not carry forward config a
-- prior ALTER FUNCTION set — recreating it here silently dropped that timeout and caused a real
-- ~14-hour production outage (refreshes failing on the default timeout, public charts stale) before
-- anyone noticed. SUPERSEDED-BY 0026, which folds the SET clause directly into this function's own
-- declaration so a future CREATE OR REPLACE can't drop it silently again. Do not copy this block
-- forward without checking whether the target function has any separate ALTER FUNCTION on it first.
create or replace function refresh_vote_aggregates()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  refresh materialized view concurrently public_position_totals;
  refresh materialized view concurrently public_party_alignment;
  refresh materialized view concurrently public_party_position_totals;
$$;

revoke all on function refresh_vote_aggregates() from public;
revoke all on function refresh_vote_aggregates() from anon;
grant execute on function refresh_vote_aggregates() to service_role;
