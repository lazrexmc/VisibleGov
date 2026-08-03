-- Draft (Lance applies — draft-then-apply). Completeness axis (.superpowers/sdd/
-- 2026-07-31-completeness-axis/brief.md, trust model v3): today's verification proves every claim
-- in a summary is TRUE of the bill; nothing proves the summary COVERS the bill. This migration adds
-- the second axis's storage: completeness checks are their own row in summary_verifications
-- (kind='completeness'), sitting alongside the existing adversarial-verification rows
-- (kind='support', the correct label for every row 0004 ever wrote), and the public receipt view is
-- recreated so a bill page can eventually say a summary was checked for accuracy AND for coverage.

-- ---------------------------------------------------------------------------
-- (a) kind: distinguishes a support (fact-checking) row from a completeness (coverage) row.
-- Existing rows predate this axis entirely and are all support rows — the default backfills them
-- correctly, no guessed metadata (PLAYBOOK_DELTA §3.3: never backfill provenance with a guess; here
-- there is nothing to guess, every pre-0020 row genuinely IS a support row by construction, since
-- kind didn't exist yet for anything else to have been written as).
-- ---------------------------------------------------------------------------
alter table summary_verifications add column kind text not null default 'support'
  check (kind in ('support','completeness'));

-- ---------------------------------------------------------------------------
-- (b) overall's vocabulary is kind-specific: a support row's overall is the adversarial
-- verification's own clean/flagged result (0004, unchanged); a completeness row's overall is
-- assessCompleteness's re-derived complete/incomplete (never 'malformed' — a malformed completeness
-- check is rejected by the record gate before any row is ever written, same as a malformed summary
-- is rejected before any write; see src/cli/summary-queue.js's classifyRecordItem). The compound
-- constraint below refuses a support row claiming 'complete' and a completeness row claiming
-- 'clean' just as firmly as it refuses either row an unrecognized value — kind and overall must
-- agree, mechanically, not just by convention.
-- ---------------------------------------------------------------------------
alter table summary_verifications drop constraint summary_verifications_overall_check;
alter table summary_verifications add constraint summary_verifications_overall_check
  check (
    (kind = 'support' and overall in ('clean','flagged'))
    or (kind = 'completeness' and overall in ('complete','incomplete'))
  );

-- ---------------------------------------------------------------------------
-- (c) public_verification_notes recreated to carry `kind` so the public receipt can distinguish
-- the two axes — everything else about migration 0019's fix (findings 2 and 4 of that migration's
-- own review) is preserved EXACTLY, on purpose, because regressing either re-opens a leak that was
-- already closed:
--   - scoped to PUBLISHED summaries only (the `exists` subquery, unchanged) — summary_verifications
--     itself carries no anon policy (0004: service-role only), so this view's own WHERE clause IS
--     the access-control wall; widening it back to all rows hands anon every unpublished draft's
--     flagged verdicts again, the exact leak 0019 fixed.
--   - still free of prompt_version (0019: an internal pipeline identifier, never rendered by the
--     bill page, tells the world nothing about whether a claim is supported) — NOT re-added here for
--     either kind of row.
-- A published summary can now legitimately have up to two rows in this view (one per kind) where it
-- used to have at most one — see this task's report for what that means for
-- src/review/server.js/site/js/bill-page.js callers that assumed exactly one row.
-- ---------------------------------------------------------------------------
-- SUPERSEDED-BY 0021: 0021 is the current, correct definition. This version is dead schema
-- history.
drop view if exists public_verification_notes;
create view public_verification_notes as
select sv.summary_id, sv.kind, sv.model, sv.overall, sv.created_at
from summary_verifications sv
where exists (
  select 1 from summaries s
  where s.id = sv.summary_id
    and s.status = 'published'
);
grant select on public_verification_notes to anon, authenticated;
