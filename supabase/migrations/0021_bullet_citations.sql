-- 0021 (draft — Lance applies). Bullet citation exposure (docs/superpowers/specs/
-- 2026-08-02-bullet-citation-exposure-design.md, adversarially reviewed by Claude Fable 5): exposes
-- verifier.js's own evidence_quote per what_it_does bullet so the public bill page can show a
-- reader the bill's exact words behind each bullet, not just a section citation. This is a
-- DELIBERATE REVERSAL of migration 0019's documented posture ("verification detail... is a staff
-- review tool, not a public-facing claim in its own right") — named explicitly here so it never
-- reads as an oversight to a future reader of that comment.
--
-- Recreates public_verification_notes (same posture as 0019/0020: deliberately NO security_invoker
-- — summary_verifications stays service-role-only per 0004, and this view's own WHERE clause,
-- scoped to summaries.status='published', is the entire access wall) adding one computed column:
--
--   citations: for a support-kind row whose overall is 'clean', a jsonb array of
--   {bullet_index, section, evidence_quote} stripped out of verdicts — deliberately never
--   `reason` (the verifier's own free-text commentary, not a fact from the bill) or `supported`
--   (redundant once gated, and itself the leak vector if handled carelessly). null for every
--   completeness-kind row (verdicts holds an unrelated {key_provisions, coverage} shape there) and
--   for any support-kind row whose overall isn't 'clean'.
--
-- THE GATE IS LOAD-BEARING, NOT DECORATION (Fable 5 adversarial review, 2026-08-02): gating only on
-- kind='support' and relying on "status='published' implies overall='clean'" is NOT mechanically
-- true — that invariant holds for the classifyRecordItem/autoPublishSummary auto-publish path
-- (src/cli/summary-queue.js) but is NEVER CHECKED by the staff review server's manual
-- approve/publish transition (src/review/server.js), which is the review queue's own designed exit
-- for the ~100 items sitting there flagged. The moment a human manually publishes a flagged summary,
-- its support row's verdicts can contain supported:false entries whose evidence_quote is a quote
-- that CONTRADICTS the bullet (VERIFY_SCHEMA allows this by design — the field exists to show what
-- the verifier checked, pass or fail) — stripping reason/supported from that row would present a
-- refuting quote as if it supports the claim. Gating citations on overall='clean' directly closes
-- this mechanically, independent of which publish path was used and independent of whether a future
-- publish path remembers to re-check verification at all.
drop view if exists public_verification_notes;
create view public_verification_notes as
select
  sv.summary_id,
  sv.kind,
  sv.model,
  sv.overall,
  sv.created_at,
  case
    when sv.kind = 'support' and sv.overall = 'clean' then (
      select jsonb_agg(jsonb_build_object(
        'bullet_index', (v->>'bullet_index')::int,
        'section', v->>'section',
        'evidence_quote', v->>'evidence_quote'
      ))
      from jsonb_array_elements(sv.verdicts) as v
    )
    else null
  end as citations
from summary_verifications sv
where exists (
  select 1 from summaries s
  where s.id = sv.summary_id
    and s.status = 'published'
);
grant select on public_verification_notes to anon, authenticated;
