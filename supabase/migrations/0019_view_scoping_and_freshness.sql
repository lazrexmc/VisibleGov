-- Draft (Lance applies — draft-then-apply). Final whole-branch review, findings 2 and 4.
--
-- Both views below are recreated with the SAME owner-bypass posture migration 0016 gave them
-- (deliberately NO security_invoker): the base tables are locked to anon and the view's own
-- column list + WHERE clause ARE the policy. That posture is exactly why finding 2 was reachable —
-- an owner-bypass view over a locked table exposes whatever it selects, so what it selects has to
-- be right.

-- ---------------------------------------------------------------------------
-- (a) FINDING 2 — public_verification_notes leaked 23 UNPUBLISHED summaries' verification rows to
-- anon, including all 9 flagged verdicts still awaiting Lance's review. summary_verifications has
-- no anon policy of its own (0004: "service role only"), and 0016's view selected the whole table,
-- so the view handed anon exactly the rows the table's RLS was written to withhold. summaries
-- itself is anon-scoped to status='published' (0001's anon_read_published policy) — the view now
-- carries that SAME scoping, so the receipt surface can never be wider than the summaries surface
-- it is a receipt FOR.
--
-- prompt_version also leaves the view: it is an internal pipeline identifier (which prompt build
-- ran), never rendered by the bill page's receipt line, and publishing it tells the world nothing
-- about whether a claim is supported. Smallest public surface that still serves the receipt.
-- ---------------------------------------------------------------------------
-- SUPERSEDED-BY 0021 (via an intermediate redefinition in 0020): 0021 is the current, correct
-- definition. This version is dead schema history.
drop view if exists public_verification_notes;
create view public_verification_notes as
select sv.summary_id, sv.model, sv.overall, sv.created_at
from summary_verifications sv
where exists (
  select 1 from summaries s
  where s.id = sv.summary_id
    and s.status = 'published'
);
grant select on public_verification_notes to anon, authenticated;

-- ---------------------------------------------------------------------------
-- (b) FINDING 4 — public_freshness served the NEWEST run per source, finished or not. During every
-- ingestion run that source's row flipped to status='running' with finished_at NULL and
-- quarantined_days 0, so the public freshness box rendered "last finished (never)" and a
-- quarantine count of zero — two false facts, live, on every page carrying the box, for the whole
-- duration of every run.
--
-- The fix splits the two questions the box actually asks, because they have two different answers:
--   - "when was this source last actually finished, and what was standing quarantined then?"
--     -> the latest run WITH a finished_at. Never masked by a run in flight.
--   - "is something happening right now?" -> the newest run's status, carried alongside.
-- `status` keeps its old meaning exactly (newest run's status, by started_at) so a pre-apply
-- renderer reading it is not silently changed underneath; finished_at/quarantined_days are the
-- columns whose SEMANTICS change, and last_finished_status is the new column that lets the site
-- feature-detect which shape it is talking to (site/js/freshness.js's own fallback, which retires
-- once this migration is applied).
--
-- A source with runs but none ever finished keeps finished_at NULL — that is a genuinely honest
-- "(no completed runs)", not the false "(never)" a run-in-flight used to produce.
-- ---------------------------------------------------------------------------
drop view if exists public_freshness;
create view public_freshness as
with latest_finished as (
  select distinct on (source)
    source,
    finished_at,
    status as last_finished_status,
    coalesce(jsonb_array_length(detail->'counts'->'quarantined_days'), 0) as quarantined_days
  from ingestion_runs
  where finished_at is not null
  order by source, finished_at desc
),
latest_run as (
  select distinct on (source)
    source,
    status
  from ingestion_runs
  order by source, started_at desc nulls last
)
select
  lr.source,
  lr.status,
  lf.finished_at,
  coalesce(lf.quarantined_days, 0) as quarantined_days,
  lf.last_finished_status
from latest_run lr
left join latest_finished lf on lf.source = lr.source;
grant select on public_freshness to anon, authenticated;
