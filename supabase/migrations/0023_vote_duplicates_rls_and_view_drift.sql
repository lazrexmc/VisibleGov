-- 0023 (draft — Lance applies). Two findings from the comprehensive accuracy audit (2026-08-03,
-- docs/audits/2026-08-03-comprehensive-accuracy-audit.md), both in the anon/RLS-exposure domain:
--
-- (1) IMPORTANT, CONFIRMED: 0022_vote_duplicates.sql creates `vote_duplicates` with no
--     `enable row level security` statement anywhere in the file — the ONLY table in this entire
--     schema missing one (grep across every migration confirms 24 of 25 created tables have one).
--     Live production DOES have RLS enabled on it, but that was done out-of-band (at apply time,
--     or via a dashboard default) and is recorded nowhere in the repo — CLAUDE.md/TODO.md still
--     describe 0022 as the file it is, not what actually ran. A fresh apply of this schema (a
--     staging copy, a rebuild) would produce `vote_duplicates` with RLS OFF. This project's anon
--     role holds Supabase's default table grants everywhere RLS is the only wall (proven live:
--     every RLS-denied table returns HTTP 200 `[]`, not a permission error) — with RLS off, an
--     anonymous user could silently INSERT a row naming any real vote as `superseded_vote_id`,
--     hiding it from every public surface with no trace. This one line closes that gap for any
--     future rebuild; it is a no-op against the current live database (RLS is already on there).
--
-- (2) The audit's OWN adversarial re-verification also found (and refuted, with live planner-cost
--     evidence) a DIFFERENT, scarier-sounding claim — that 0022's `security_invoker = true` on
--     `public_vote_feed`/`public_votes` makes the vote_duplicates exclusion structurally inert for
--     anonymous readers (an invoker view running under anon's own RLS on a locked table would see
--     zero rows in the join, so the exclusion could never fire). That claim is FALSE for what is
--     actually deployed right now: live measurement proves both views are functioning as
--     owner-bypass (the exclusion genuinely works for anon). But that means the SQL Lance actually
--     ran differs from the committed 0022 file, which still says `security_invoker = true` — so
--     re-applying 0022 verbatim to a fresh database WOULD recreate the (real, if not currently
--     live) inertness bug the audit described. This migration corrects the file to match what is
--     proven live and was always the design's own intent (spec: docs/superpowers/specs/
--     2026-08-03-vote-duplicate-dedup-design.md:99-100 — "the public_freshness/
--     public_reconciliation_flags 'the view IS the policy' pattern", i.e. owner-bypass, the same
--     posture 0016/0019 already use for every other internal-table-backed public view).
--     public_vote_feed's own `security_invoker = true` was carried forward from 0016 unchanged —
--     correct there (0016's version touched only anon-readable base tables), wrong once a
--     locked table (vote_duplicates) entered the join in 0022.

alter table vote_duplicates enable row level security;

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
left join vote_duplicates vd on vd.superseded_vote_id = v.id
where vd.id is null;
grant select on public_vote_feed to anon, authenticated;

drop view if exists public_votes;
create view public_votes as
select
  v.id, v.bill_id, v.jurisdiction_id, v.chamber, v.vote_date, v.question, v.result,
  v.source_url, v.source_key
from votes v
left join vote_duplicates vd on vd.superseded_vote_id = v.id
where vd.id is null;
grant select on public_votes to anon, authenticated;
