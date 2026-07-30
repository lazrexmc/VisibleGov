-- Draft (Lance applies — draft-then-apply). Task 6b, design spec §3 amendment "Vote aggregates"
-- (docs/superpowers/specs/2026-07-30-public-site-design.md) + task-6b-brief.md.
--
-- FIX ROUND 1 (review verdict, spec FAIL -> corrected here): both views are now MATERIALIZED, not
-- plain views. The reviewer proved no per-legislator qualifier can prune public_party_alignment's
-- majority CTEs (every row requires the FULL party-majority computation over every yea/nay cast
-- before a WHERE clause on legislator_id could ever apply) — so a plain view's query cost would
-- be paid on every single anon request, not just occasionally. Materialized is the destination,
-- not an escalation. Both bases (vote_casts, votes, legislators) stay directly anon-readable;
-- matviews take grants directly (no RLS on a matview — the same reasoning migration 0016 used for
-- views over already-public tables, just with data now pre-computed at refresh time instead of
-- query time).
--
-- Refreshed by scripts/refresh-aggregates.js (service-role RPC) — see refresh_vote_aggregates()
-- at the bottom of this file. Until the first refresh (or Lance's apply-time refresh), a
-- materialized view IS populated immediately by CREATE MATERIALIZED VIEW ... AS (Postgres
-- default is WITH DATA), so the site has real numbers from the moment this migration lands, not a
-- window of empty tables.

-- Party normalization (C1+C2, CORRECTED RULING): both views' party handling uses this SAME CASE
-- mapping — 'R'->'Republican', 'D'->'Democratic', 'I'->'Independent'; every other value (including
-- 'Independent Democrat', '', and null) passes through UNCHANGED (never invented, never guessed).
-- Verified live against real data (task 6b, read-only probe + the review's own citation): current
-- distinct `legislators.party` counts are Republican 464 / R 391 / Democratic 456 / D 209 /
-- Democrat 0 — the bare-letter abbreviations are LegiScan-side (MO), the full printed forms are
-- Congress.gov-side (US); this CASE is what makes a Missouri Republican and a US House Republican
-- actually group together for the party-comparison and cohesion metrics, instead of silently
-- splitting into two undercounted groups over a purely cosmetic source difference. This is
-- normalization of a KNOWN, DOCUMENTED equivalence (R=Republican, D=Democratic, I=Independent),
-- never a guess at what an unfamiliar party label "probably" means — every other raw value passes
-- through untouched, and METRIC_DEFINITIONS (site/js/vote-charts.js) states this caveat verbatim
-- on the trust page.

-- 1) Position distribution — one row per (legislator, jurisdiction, chamber, year, position), with
-- the cast count AND the legislator's normalized party. The profile fetches ALL of a legislator's
-- OWN rows unfiltered (this is small) and sums/filters client-side by the current chamber/year UI
-- filters (site/js/vote-charts.js's summarizeTotals). Carrying `party` here directly is what lets
-- the party-comparison fetch be ONE indexed query on THIS SAME matview (`party=eq....&
-- jurisdiction_id=in.(...)&chamber=eq....`) instead of a PostgREST embed through an aggregate view
-- (fragile, unverifiable pre-apply — H1/H5 from the review) or N separate per-legislator queries.
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
group by 1, 2, 3, 4, 5, 6;

-- `party` is functionally dependent on `legislator_id` (one party value per legislators row) so it
-- adds no distinguishing dimension here — this index is still a true one-row-per-key guarantee,
-- exactly what REFRESH ... CONCURRENTLY requires.
create unique index public_position_totals_uq
  on public_position_totals (legislator_id, jurisdiction_id, chamber, year, position);
grant select on public_position_totals to anon, authenticated;

-- 2) Party-line alignment — one row per (legislator, year, chamber): how many roll calls that
-- legislator's OWN party had a resolvable strict yea/nay majority on (comparable), and how many of
-- those the legislator's own cast matched (matched). Semantics (design spec §3, exact neutrality-
-- wall language, plus the review's two corrections):
-- - "party majority = strict majority of that party's yea/nay casts on the roll call" — computed
--   over the party's NORMALIZED label (same CASE as above), so a party's casters are never
--   silently split across a source-formatting difference.
-- - "not-voting/absent excluded from cohesion's numerator and denominator" — and, more precisely,
--   ANY position other than yea/nay (present/other included) is excluded at the source, in
--   caster_casts below.
-- - "ties = no majority = roll call excluded" (party_majority's null case).
-- - H3 (review): grouped by (legislator_id, year, CHAMBER) — the vote's own chamber — so a chamber
--   filter on the profile page scopes cohesion honestly instead of mixing a merged career's
--   chambers into one figure.
-- - M2 (review, RULING): a roll call where the member is their party's ONLY yea/nay caster is
--   EXCLUDED from comparable — a "majority" of one caster (themselves) is not a party-line signal,
--   it is a tautology (they always "match" their own only vote). Without this, a lone Independent
--   (or the only same-party member in a chamber) would render a fabricated 100% cohesion figure
--   instead of the honest "not computable" — this is the review's explicit example and the SQL
--   below produces exactly that outcome (see the final WHERE clause).
-- - M3 (review, RULING): a null or non-normalized party (anything that isn't exactly 'Republican',
--   'Democratic', or 'Independent' after the CASE above) is excluded at the source
--   (normalized_casts below) — such a member simply never appears in this view at all, for any
--   year/chamber: no figure, never a fabricated one. METRIC_DEFINITIONS states this plainly.
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
),
-- M3: only the three normalized, well-populated party labels are ever eligible to form a
-- comparison group at all — a fringe/unrecognized/null party label is not a statistically
-- meaningful "party" for this metric, and is dropped here rather than silently grouped alone.
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
      else null -- tie (or, degenerately, 0-0) -> no majority -> this roll call/party pair excluded
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
  -- M2: (party_yea + party_nay) = 1 means exactly one caster produced this "majority" — and since
  -- cc is itself one of that party's casters on this exact roll call, that one caster IS cc. A
  -- roll call where a legislator is their party's only voting member never counts as comparable.
  and (pm.party_yea + pm.party_nay) > 1
group by cc.legislator_id, date_part('year', cc.vote_date)::int, cc.chamber;

create unique index public_party_alignment_uq
  on public_party_alignment (legislator_id, year, chamber);
grant select on public_party_alignment to anon, authenticated;

-- 3) Refresh function — the ONLY way either matview updates after this migration lands. Runs both
-- refreshes CONCURRENTLY (no read lock against anon traffic; requires the unique indexes above).
-- security definer so it can run with the privileges needed to refresh (matview refresh requires
-- ownership/appropriate privilege, which anon/authenticated never have) while the function itself
-- exposes nothing but "refresh, return nothing" — revoked from public/anon explicitly, executable
-- only by service_role. Called by scripts/refresh-aggregates.js; the ingest/backfill CLIs' batch
-- loops call it at batch end (script's own header comment) so the aggregates never drift far
-- behind the underlying vote_casts/votes/legislators data.
create function refresh_vote_aggregates()
returns void
language sql
security definer
as $$
  refresh materialized view concurrently public_position_totals;
  refresh materialized view concurrently public_party_alignment;
$$;

revoke all on function refresh_vote_aggregates() from public;
revoke all on function refresh_vote_aggregates() from anon;
grant execute on function refresh_vote_aggregates() to service_role;
