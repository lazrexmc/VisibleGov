-- 0031 (draft — Lance applies; URGENT: profile vote lists are currently BROKEN for anonymous
-- visitors on the freshly-deployed production site). The 0029 planner fix, applied to the two
-- VIEWS that 0029's own sweep missed.
--
-- FOUND LIVE (2026-08-05, ~01:17 UTC 08-06): the very first real-browser walk of the deployed site
-- (visiblegov.pages.dev, Phase 2 of docs/CLOUDFLARE_DEPLOY.md) hit a console error on a person
-- profile: the page's `public_vote_feed` fetch returned HTTP 500. Reproduced directly:
--
--   as anon (the browser's role):  {"code":"57014","message":"canceling statement due to
--                                   statement timeout"} after ~3.2s
--   as service_role, same query:   200 in ~2.2s
--
-- anon's role-level statement_timeout is 3s (see 0028's header for the role-timeout inventory).
-- The vote-list query now costs more than that, so every anonymous profile view loses its vote
-- list — the core surface of the product.
--
-- ROOT CAUSE — the SAME planner trap 0029 root-caused and fixed, in the two objects its sweep did
-- not cover. `public_vote_feed` and `public_votes` (live definitions: 0023) still exclude
-- superseded votes via the classic anti-join idiom:
--
--     left join vote_duplicates vd on vd.superseded_vote_id = v.id
--     where vd.id is null;
--
-- 0029 established (via EXPLAIN against the live database, not conjecture) that Postgres
-- catastrophically misestimates this pattern's selectivity — it estimated 1 row where the honest
-- answer was ~10,044, because the post-join IS NULL filter gets estimated from the joined
-- column's own null fraction (vote_duplicates.id is a PK: 0% null) rather than the join's real
-- match rate — and that the misestimate cascades into nested-loop joins over what is truly a
-- ~1.4M-row workload. 0029 rewrote the three vote-aggregate MATVIEWS to `NOT EXISTS` and the
-- refresh dropped from 40+ minutes (timeout) to ~19 seconds. The two plain VIEWS carrying the
-- identical idiom were not part of that migration, and the regression test written alongside it
-- (tests/vote-duplicates-antijoin-migration.test.js) covered only the matviews — a scoping gap,
-- now closed in the same commit as this file (the test enforces the views too).
--
-- WHY IT SURFACES ONLY NOW, in honest sequence: when the site was browser-verified locally on
-- 2026-08-03, `vote_duplicates` held 0 rows — with nothing to anti-join against, the bad plan had
-- nothing to be slow about. The 59-pair backfill landed later that day; live ingest has since
-- marked 3 more (62 now); `vote_casts` kept growing (~1.468M). Somewhere in there the misplanned
-- query crossed anon's 3s budget. The first PRODUCTION browser walk was simply the first check to
-- run as anon against current data volumes. Nothing about the Cloudflare deploy caused this — the
-- deploy is what finally exercised it.
--
-- THE FIX: byte-identical view definitions to 0023 — same columns, same owner-bypass posture (NO
-- security_invoker; that is 0023's own load-bearing correction, see its header), same grants —
-- with ONLY the anti-join rewritten to `NOT EXISTS`, exactly as 0029 did for the matviews.
-- Semantically identical output: `vote_duplicates.superseded_vote_id` is UNIQUE (0022), so
-- "no matching row exists" and "the left-joined row is null" select precisely the same set. What
-- changes is only the plan shape Postgres chooses: NOT EXISTS engages the dedicated hash
-- anti-join estimator that 0029 verified produces correct row estimates and hash joins.
--
-- Safe to re-run (drop view if exists → create). No data touched. Applying is a metadata-only
-- operation, instant, no lock risk against the 30-min pg_cron matview refresh.
--
-- VERIFY AFTER APPLYING (the exact query that failed, as anon — expect 200 well under a second):
--   curl -s -w "\nHTTP %{http_code} in %{time_total}s\n" \
--     "$SUPABASE_URL/rest/v1/public_vote_feed?legislator_id=in.(968daa4a-cd8e-4fff-b497-5e99c3caa35d,a19a3bd2-51d9-44cc-8db8-d5fb3a727ae8)&order=vote_date.desc.nullslast,cast_id.desc&limit=5" \
--     -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"

drop view if exists public_vote_feed;
create view public_vote_feed as
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
where not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id = v.id);
grant select on public_vote_feed to anon, authenticated;

drop view if exists public_votes;
create view public_votes as
select
  v.id, v.bill_id, v.jurisdiction_id, v.chamber, v.vote_date, v.question, v.result,
  v.source_url, v.source_key
from votes v
where not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id = v.id);
grant select on public_votes to anon, authenticated;
