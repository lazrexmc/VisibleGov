### Task 4: Extraction backfill CLI

**Files:** Create `src/cli/extract-terms.js`; package.json script; tests for pure parts
- For summaries lacking summary_terms rows: load bill text, run an extraction-only call (claude-sonnet-5, EXTRACT_PROMPT_VERSION 'v1', tiny output) producing referenced_terms; upsert glossary_terms stubs (status draft, needs_mapping per parseCitation) + summary_terms joins. Typed failures; --dry-run zero-call planning; mechanical approval env GLOSS_RUN_APPROVED=yes for live.
- [ ] TDD pure parts → implement → green → dry-run against live DB (lists ~25 candidates) → commit. LIVE RUN GATES on Lance (~25 × ~$0.03 ≈ $0.75).


## CONTROLLER RULINGS (binding, appended)

1. Full requirements: the plan's Task 4 section. Extraction model claude-sonnet-5, EXTRACT_PROMPT_VERSION 'v1', JSON-schema output mirroring SUMMARY_SCHEMA's referenced_terms shape; GLOSS_RUN_APPROVED=yes mechanical gate for live; --dry-run zero-call planning from DB state.
2. UPSERT MUST BRANCH (ledgered from Task 1's review): glossary_terms lookup by (kind, citation) when parseCitation resolves a citation; by (kind, term) when citation is null (needs_mapping true). Use insert-on-absent semantics compatible with BOTH the base unique constraint and the partial index glossary_terms_unmapped_uidx. Term text normalization caveat: normalize ONLY trivially (trim, collapse internal whitespace) — never rewrite the term (verbatim-from-bill discipline); exact-string dedup limits are accepted and documented.
3. Migration 0007 is NOT applied on the live DB — every DB path degrades via the established isMissingRelationError pattern (dry-run reports honestly; live mode hard-fails on missing tables since 0007 is its gate).
4. NO Anthropic calls in this task (account currently has no credits — another reason the gate exists). Implement fully; STOP at READY_FOR_LIVE_GATE.
