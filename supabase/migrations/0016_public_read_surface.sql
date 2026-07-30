-- Draft (Lance applies — draft-then-apply). Public read surface for the site (spec §7).
-- Two lock-downs, one additive column, four views. The views over LOCKED tables are
-- DELIBERATELY security_definer-style (no security_invoker): the view IS the policy — it
-- exposes only the named columns, and anon gets SELECT on the view, not the table.
-- public_vote_feed sits over already-public tables and uses security_invoker=true.

-- 1) Lock-downs (spec: bill_texts raw text and ingestion_runs internals are not public).
drop policy anon_read on bill_texts;
drop policy if exists anon_read on ingestion_runs;
-- Note: 0003 already dropped anon_read on ingestion_runs (line 21); if-exists is historical documentation.

-- 2) terms.state (additive; fills-null backfill in the next task). US House terms store bare
-- district numbers ('2') with no state — unmatchable from an address without this.
alter table terms add column state text;

-- 3) The vote feed: one paged query serves a profile's vote list, newest first, without
-- PostgREST embedded-ordering tricks. Bases are all anon-readable; invoker semantics apply.
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
left join bills b on b.id = v.bill_id;
grant select on public_vote_feed to anon, authenticated;

-- 4) Freshness: latest run per source + the quarantined-day COUNT only (never the detail
-- payload). Owner-bypass over the now-locked ingestion_runs; the column list is the wall.
-- Supersedes ingestion_freshness (created in 0003); one public freshness surface, not two.
drop view if exists ingestion_freshness;
create view public_freshness as
select distinct on (source)
  source,
  status,
  finished_at,
  coalesce(jsonb_array_length(detail->'counts'->'quarantined_days'), 0) as quarantined_days
from ingestion_runs
order by source, started_at desc nulls last;
grant select on public_freshness to anon, authenticated;

-- 5) Verification notes: exactly what the bill page's receipt renders, nothing more.
create view public_verification_notes as
select summary_id, model, prompt_version, overall, created_at
from summary_verifications;
grant select on public_verification_notes to anon, authenticated;

-- 6) Reconciliation flags: the factual discrepancy record, minus provenance internals.
create view public_reconciliation_flags as
select vote_id, source_a, source_b, discrepancy, resolved, created_at
from vote_reconciliation_flags;
grant select on public_reconciliation_flags to anon, authenticated;
