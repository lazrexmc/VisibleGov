-- Draft (Lance applies — draft-then-apply). Task 6b, design spec §3 amendment "Vote aggregates"
-- (docs/superpowers/specs/2026-07-30-public-site-design.md) + task-6b-brief.md. Two views, both
-- security_invoker=true over already-anon-readable bases (vote_casts, votes, legislators are all
-- directly anon-readable today, verified live against migration 0016's real surface, task 6b) —
-- same reasoning as public_vote_feed in 0016: the view IS convenience/aggregation, not a policy
-- boundary, since anon can already read every underlying row directly.
--
-- COST NOTE (controller measures after apply, per the brief): public_position_totals is a light
-- GROUP BY over vote_casts/votes and should be cheap. public_party_alignment is materially
-- heavier — three chained aggregations over all 1.4M+ vote_casts rows (yea/nay casts only, but
-- still the full cast table) before it ever reaches a WHERE clause a caller supplies, because a
-- per-legislator query still needs the FULL party-majority computation to know each roll call's
-- own party majority. ITS COST IS UNMEASURED. The controller measures anon-side latency after
-- apply; if it breaches the anon statement timeout, a materialized-view escalation (migration
-- 0019, refreshed from the ingest CLIs) is pre-planned, not a surprise.

-- 1) Position distribution — one row per (legislator, jurisdiction, chamber, year, position),
-- with the cast count. The profile fetches ALL of a legislator's rows unfiltered (this is small —
-- years × chambers × positions per legislator) and sums/filters client-side by the current
-- chamber/year UI filters (site/js/vote-charts.js's summarizeTotals).
create view public_position_totals with (security_invoker = true) as
select
  vc.legislator_id,
  v.jurisdiction_id,
  v.chamber,
  date_part('year', v.vote_date)::int as year,
  vc.position,
  count(*)::int as casts
from vote_casts vc
join votes v on v.id = vc.vote_id
group by 1, 2, 3, 4, 5;
grant select on public_position_totals to anon, authenticated;

-- 2) Party-line alignment — one row per (legislator, year): how many roll calls that legislator's
-- OWN party had a resolvable strict yea/nay majority on (comparable), and how many of those the
-- legislator's own cast matched (matched). Semantics (design spec §3, exact neutrality-wall
-- language): "party majority = strict majority of that party's yea/nay casts on the roll call;
-- not-voting/absent excluded from cohesion's numerator and denominator; ties = no majority = roll
-- call excluded; party = as recorded in our data, with that caveat published." legislators.party
-- is read AS RECORDED (no historical-party tracking, no cross-source normalization) — the same
-- caveat migration 0018's own METRIC_DEFINITIONS (site/js/vote-charts.js) publishes on the trust
-- page.
--
-- caster_casts: every yea/nay cast, joined to the CASTER's own recorded party and the vote's date
-- (not_voting/absent/present/other are excluded here, at the source — never part of either the
-- majority computation or a member's own comparable/matched count).
-- party_tallies: per (roll call, party), how many of that party's own casters voted yea vs nay.
-- party_majority: per (roll call, party), the strict majority position, or null on a tie (or, in
-- principle, a party with zero yea/nay casters on that roll call — never a false majority).
-- Final select: for each caster's own yea/nay cast, look up THEIR OWN party's majority on that
-- SAME roll call; a null majority (tie) excludes that roll call entirely, for that member, from
-- both comparable and matched — never counted, never silently defaulted.
create view public_party_alignment with (security_invoker = true) as
with caster_casts as (
  select
    vc.vote_id,
    vc.legislator_id,
    vc.position,
    l.party,
    v.vote_date
  from vote_casts vc
  join legislators l on l.id = vc.legislator_id
  join votes v on v.id = vc.vote_id
  where vc.position in ('yea', 'nay')
),
party_tallies as (
  select
    vote_id,
    party,
    count(*) filter (where position = 'yea') as party_yea,
    count(*) filter (where position = 'nay') as party_nay
  from caster_casts
  group by vote_id, party
),
party_majority as (
  select
    vote_id,
    party,
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
  count(*) as comparable,
  count(*) filter (where cc.position = pm.majority_position) as matched
from caster_casts cc
join party_majority pm on pm.vote_id = cc.vote_id and pm.party = cc.party
where pm.majority_position is not null
group by cc.legislator_id, date_part('year', cc.vote_date)::int;
grant select on public_party_alignment to anon, authenticated;
