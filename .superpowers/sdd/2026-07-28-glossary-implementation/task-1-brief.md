### Task 1: Migration 0007 (glossary schema)

**Files:** Create `supabase/migrations/0007_glossary.sql`
- Transcribe the design doc's schema EXACTLY (glossary_terms with unique (kind, citation), summary_terms join table) plus: `alter` nothing else; RLS enabled both tables; policies: glossary_terms anon SELECT where status='published'; summary_terms anon SELECT (join rows are harmless ids); NO anon writes. Add a `needs_mapping boolean default false` column to glossary_terms (design-consistent addition for unparseable citations — document in the commit).
- [ ] Write SQL → commit `feat: migration 0007 - glossary tables (draft; Lance applies)` → GATE noted (Lance applies; later tasks degrade gracefully until then).


## CONTROLLER RULINGS (binding, appended per playbook §7 lesson)

1. The schema source of truth is the design doc's SQL block: docs/superpowers/specs/2026-07-28-glossary-design.md (glossary_terms + summary_terms) — transcribe it, PLUS the additions below.
2. Add to glossary_terms: `needs_mapping boolean default false` (for citations parseCitation can't resolve — no guessing).
3. ALSO create (required by Tasks 5-6, same migration):
   - `glossary_verifications` — same shape as summary_verifications (0004) but `term_id uuid not null references glossary_terms(id)` instead of summary_id; RLS enabled, NO anon policy.
   - `glossary_notes` — same shape as summary_notes (0003) but term_id FK; action check same enum; RLS enabled, NO anon policy.
4. RLS: glossary_terms anon SELECT only where status='published'; summary_terms anon SELECT (true); no anon writes anywhere.
5. SQL only — do NOT apply (Lance's draft-then-apply gate). Run npm test once (278/278 expected — nothing should break).
