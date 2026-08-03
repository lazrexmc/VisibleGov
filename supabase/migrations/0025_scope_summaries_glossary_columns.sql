-- 0025 (draft — Lance applies). Column-scope anon access to `summaries` and `glossary_terms`
-- (Cloudflare deploy-readiness review, 2026-08-03, TODO.md's Cloudflare Pages gameplan entry —
-- "one thing to fix before deploy").
--
-- Both tables' RLS already correctly restricts anon to PUBLISHED ROWS
-- (`anon_read_published ... using (status = 'published')`, 0001/0007) — that part is not broken
-- and is unchanged here. What was never restricted is COLUMNS: RLS controls row visibility, not
-- column visibility, so a bare `select=*` (or any explicit selection of an internal column) from
-- the anon role has always returned every column on every published row, including internal
-- pipeline metadata: `model`, `prompt_version`, `bill_text_hash`, `run_id` on `summaries`;
-- `model`, `prompt_version`, `source_hash`, `run_id`, `needs_mapping` on `glossary_terms`. The
-- site's own JS is disciplined (glossary_terms is already explicitly column-scoped in every real
-- query; summaries' one broad query only ever reads `id`/`bill_id`/`status`/`body_md`/`model`) —
-- but the underlying table grant does not enforce that discipline, so a caller bypassing the
-- site's own JS and querying the anon-exposed table directly gets everything.
--
-- This is the exact same class of exposure migration 0019 already fixed for
-- `public_verification_notes` (stripping `prompt_version`, "an internal pipeline identifier...
-- must stay off the public surface") — never applied to these two base tables until now.
--
-- Fix: Postgres column-level privileges (`grant select (col, col, ...) on ...`), NOT a rename to a
-- new view name — site/js/*.js already queries `summaries`/`glossary_terms` directly by these
-- exact names in three files (bill-page.js, person-page.js, trust-page.js); a view-based fix would
-- require updating and re-testing every one of those call sites for zero additional benefit over
-- a column grant. `status = 'published'`, plus every column and filter/order key each real site
-- query actually references, was checked directly against site/js source before drafting the
-- column lists below — nothing site code uses is removed.
--
-- `model` stays PUBLIC on `summaries` (deliberately, unlike `prompt_version`): bill-page.js
-- displays it verbatim in the trust-model receipt ("Summary by claude-opus-5, adversarially
-- verified..." — buildVerificationNote, bill-page.js:203-208) — this is attribution, not an
-- internal identifier, the same distinction 0019's own comment draws for `public_verification_
-- notes.model`.

revoke select on summaries from anon, authenticated;
grant select (id, bill_id, status, body_md, model, published_at, created_at) on summaries to anon, authenticated;

revoke select on glossary_terms from anon, authenticated;
grant select (id, term, kind, citation, gloss_md, supported_by_quote, source_url, status) on glossary_terms to anon, authenticated;
