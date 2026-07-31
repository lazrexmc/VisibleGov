# Task 1 report — migration 0007 (glossary schema)

**Status:** done. `supabase/migrations/0007_glossary.sql` created (SQL only, not applied — Lance's
draft-then-apply gate, per controller ruling #5). Transcribes glossary_terms + summary_terms from
the design doc exactly, adds `needs_mapping boolean default false` to glossary_terms per ruling
#2, and adds glossary_verifications + glossary_notes per ruling #3 (same shape as 0004's
summary_verifications / 0003's summary_notes, term_id FK in place of summary_id). RLS enabled on
all four tables; glossary_terms anon SELECT gated on `status = 'published'`; summary_terms anon
SELECT unrestricted (join table of ids); glossary_verifications and glossary_notes have no anon
policy (service-role only), matching 0003/0004's staff-only posture and commenting style.
Constraint names left as Postgres defaults throughout — no explicit `constraint` clauses added.
Table creation order verified: glossary_terms first, then summary_terms / glossary_verifications /
glossary_notes (all three reference glossary_terms(id)), so it runs cleanly appended after
0001-0006.

**Commit:** `922bd3496258f4da668990f823c87a9f2a0ab385` — "feat: migration 0007 - glossary tables
(draft; Lance applies)", pushed to `glossary-implementation`.

**Test summary:** `npm test` run once, 278/278 pass, 0 fail — nothing broken (SQL-only change, no
code touched).

**Concerns:** none blocking. One judgment call worth flagging for review: `unique (kind, citation)`
is transcribed exactly as the design doc specifies, but `citation` is nullable — Postgres treats
multiple NULLs as distinct under a unique constraint, so two glossary_terms rows with the same
`kind` and both NULL `citation` would NOT collide. That's consistent with the design doc as
written (not a deviation), just noting it since a future task filling in `citation` values could
change dedup behavior unexpectedly if that's ever relied on.

---

## Follow-up: review-routed fix (same session)

**Status:** done. Coordinator review confirmed the NULL-dedup concern above is a real problem for
the Task-4 pipeline (unmapped, popular-name-only terms would mint a duplicate glossary_terms row
per referencing bill, defeating the write-once reuse cost model). Added to
`supabase/migrations/0007_glossary.sql`, immediately after the `glossary_terms` table:

```sql
create unique index glossary_terms_unmapped_uidx on glossary_terms (kind, term) where citation is null;
```

with a comment explaining why NULLs escape the base unique constraint and why `NULLS NOT
DISTINCT` was considered and rejected (it dedupes on the constraint's existing columns globally —
`kind` + citation-is-null — which would collapse ALL same-kind unmapped rows into one slot
regardless of `term`, incorrectly merging unrelated acts that both happen to be unmapped; the
partial index dedupes on `(kind, term)` instead, scoped to `citation is null`, so distinct
unmapped terms of the same kind stay distinct). No other changes made to the file.

**Commit:** `92ae14bd3facc2fe80cbd1f6d1593a48d54cc65a` — "fix: partial unique index for unmapped
glossary terms", pushed to `glossary-implementation`.

**Test summary:** `npm test` run once, 278/278 pass, 0 fail.

**Concerns:** none. Still SQL only, not applied — draft-then-apply gate unchanged.
