-- 0035: expose votes.vote_date_provenance on the public views.
--
-- Why: 0032 added the column and closed its own note with this exact gap — "the public views
-- (public_votes / public_vote_feed, 0023/0031) list columns explicitly and do NOT include it, so
-- the site will serve the 185 derived dates without an inline receipt until the view and bill page
-- carry it — a captured TODO, not an oversight." This is that TODO.
--
-- Measured live 2026-08-28 (read-only, anon + service):
--   votes total .......................................... 10,195
--   votes with a derived date (vote_date_provenance not null)  185
--   public_votes columns ....... id, bill_id, jurisdiction_id, chamber, vote_date, question,
--                                result, source_url, source_key       (no provenance)
--   public_vote_feed columns ... cast_id, legislator_id, position, vote_id, vote_date, chamber,
--                                question, result, source_url, jurisdiction_id, bill_id,
--                                bill_identifier, bill_title, session_id  (no provenance)
--
-- This is a trust-model gap, which is why it is worth a migration: 185 votes render a date the
-- reader cannot audit. Every other fact on a profile row already carries its receipt — the source
-- link, the roll-call identifier — and a DERIVED date is precisely the fact that most needs one,
-- because it was not printed on the roll call at all. The repo's own rule (docs/superpowers/specs/
-- 2026-07-30-public-site-design.md §1) is "nothing renders that is not in the DB with provenance."
--
-- WHERE THE GAP IS ACTUALLY VISIBLE (measured, not assumed). Only the PROFILE page renders a vote
-- date: site/js/person-page.js renderVoteRow builds its meta line from
-- [vote_date, result, rollCallLabel(source_url)]. The BILL page does not render a date at all —
-- bill-page.js renderVotes emits chamber, question, result, tally, source link and flag badge, and
-- reads vote_date only to ORDER the list. So the live gap is public_vote_feed alone.
--
-- BOTH views are updated anyway, deliberately: this repo has already been bitten by the two public
-- surfaces drifting apart (migration 0023 is named "vote_duplicates_rls_and_view_drift"). Adding
-- the column to one and not the other recreates exactly that class of bug the first time anyone
-- renders a date on the bill page. The cost is one column on a view nothing reads yet.
--
-- SHAPE: create or replace, not drop+create. The column is APPENDED at the end of each select
-- list, which is the one change `create or replace view` permits — and it PRESERVES the existing
-- grants, so unlike 0031 (which changed a WHERE clause and therefore had to drop) this migration
-- does not need to re-grant. No data is touched. Metadata-only, instant, no lock risk against the
-- 30-minute pg_cron aggregate refresh.
--
-- VISIBILITY: anon already holds a table-level select on votes (0001 anon_read; 0025 scoped only
-- summaries/glossary_terms), so this column is already anon-readable on the base table today —
-- 0032 said so. This migration changes what the VIEWS project, not who may read the column.
-- The payload is public source text: the source's own dated history action and its printed tally.
--
-- ORDER OF OPERATIONS — checked, and gentler than it first looks. PostgREST returns 400 for an
-- unknown column in a select list, so a select-list consumer must never ask for this column before
-- the view carries it. Verified 2026-08-28: the profile page is NOT such a consumer —
-- profile-model.js voteFilterQuery builds public_vote_feed URLs with filters and an order but NO
-- select= parameter, so PostgREST returns every column and the page simply receives one more field
-- it may ignore. The bill page IS a select-list consumer (bill-page.js VOTES_SELECT, an explicit
-- list) and is deliberately left untouched by this change.
--
-- So this migration is safe to apply on its own, and the site render can ship before or after it:
-- before, the field is absent and the renderer returns null (rendering nothing, which is correct);
-- after, the receipt appears. No deploy ordering is forced. Apply, verify below, then deploy.
--
-- VERIFY AFTER APPLYING (as anon — expect 200, and the column present):
--   curl -s "$SUPABASE_URL/rest/v1/public_vote_feed?select=cast_id,vote_date,vote_date_provenance&vote_date_provenance=not.is.null&limit=2" \
--     -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
--   -- expect two rows whose vote_date_provenance is an object with source/printed_date/action.
--
--   curl -s -o /dev/null -w "%{http_code}\n" "$SUPABASE_URL/rest/v1/public_votes?select=id,vote_date_provenance&limit=1" \
--     -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY"
--   -- expect 200.
--
-- Draft-then-apply: Lance applies.

create or replace view public_vote_feed as
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
  b.session_id,
  v.vote_date_provenance
from vote_casts vc
join votes v on v.id = vc.vote_id
left join bills b on b.id = v.bill_id
where not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id = v.id);

create or replace view public_votes as
select
  v.id, v.bill_id, v.jurisdiction_id, v.chamber, v.vote_date, v.question, v.result,
  v.source_url, v.source_key,
  v.vote_date_provenance
from votes v
where not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id = v.id);
