# Glossary Implementation Plan (per the APPROVED 2026-07-28 design)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Referenced laws in bill summaries get plain-language Background glosses generated FROM their own official text (uscode.house.gov / govinfo), adversarially verified, Lance-adjudicated once, reused everywhere — per the approved A+C hybrid design.

**Architecture:** migration 0007 (glossary_terms + summary_terms) → US Code fetcher (fixture-first) → summarizer prompt v2 (adds structured referenced_terms extraction) → extraction backfill for existing summaries → glosser + gloss-verifier (same author/verifier split and completeness derivation as summaries) → review-server glossary queue → gated E2E.

**Tech stack:** existing Node ESM project; NO new dependencies; approved fetch sources uscode.house.gov + govinfo.gov (free, no keys); models: claude-opus-5 authors glosses, claude-sonnet-5 refutes — same pair as summaries.

## Global Constraints

- **Every model-calling run gates on Lance's per-run approval with cost stated** (established policy; the GOLDEN_CHECK_APPROVED-style mechanical gate pattern extends to new CLIs: env GLOSS_RUN_APPROVED=yes required for live gloss/extract runs).
- Facts-only discipline extends to glosses: every gloss sentence traceable to the fetched source excerpt; the verifier refutes against the excerpt ALONE; completeness always derived, never model-self-reported.
- Draft-then-apply: 0007 written + committed; Lance applies. Graceful missing-relation degradation everywhere (established isMissingRelationError pattern) so nothing 500s pre-apply.
- Fixture-first for the new fetch source; fixtures are real captured payloads; fail-loud citation parsing (unparseable citation → 'needs_mapping' state recorded, never guessed).
- Prompt v2 bumps PROMPT_VERSION; the golden drift check (3 goldens, ~$0.35) runs before v2 summarizes anything new — Lance-approved run.
- Background label everywhere (schema comment, review page, future site): "Background — from the referenced law's official text".
- node:test discipline; typed errors; provenance (model, prompt_version, source_hash, run_id) on every gloss row; commits end with Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: Migration 0007 (glossary schema)

**Files:** Create `supabase/migrations/0007_glossary.sql`
- Transcribe the design doc's schema EXACTLY (glossary_terms with unique (kind, citation), summary_terms join table) plus: `alter` nothing else; RLS enabled both tables; policies: glossary_terms anon SELECT where status='published'; summary_terms anon SELECT (join rows are harmless ids); NO anon writes. Add a `needs_mapping boolean default false` column to glossary_terms (design-consistent addition for unparseable citations — document in the commit).
- [ ] Write SQL → commit `feat: migration 0007 - glossary tables (draft; Lance applies)` → GATE noted (Lance applies; later tasks degrade gracefully until then).

### Task 2: US Code fetcher (fixture-first)

**Files:** Create `src/adapters/uscode.js`, `tests/fixtures/uscode/` (real captures), `tests/uscode.test.js`
- Capture (polite, ~1s spacing): the official text for 42 U.S.C. 1396b — try uscode.house.gov's download/API surface first (the OLRC site offers per-section RSS/XHTML exports; investigate the real URL shape and DOCUMENT it), falling back to govinfo's USCODE collection API. THE FIXTURE IS THE SOURCE OF TRUTH; the brief's URL guesses are research-derived.
- Produces: `parseCitation(raw) → {title, section} | null` (handles '42 U.S.C. 1396b', '42 USC 1396b', 'section 1396b of title 42'; null for popular-name-only refs like 'the Social Security Act' — those become needs_mapping); `fetchUscSection(title, section) → {url, excerptText}` via fetchWithLimit + a dedicated polite limiter (2s); `excerptHash` via existing sha256. Excerpt = the section text trimmed to MAX_EXCERPT_CHARS = 100000 with a typed OversizeExcerptError beyond (fail loud, same convention).
- [ ] Fixture capture → failing tests (parseCitation matrix incl. null cases; fixture parse yields substantial text mentioning 'medical assistance' [1396b is Medicaid payments — verify against the real text]; hash stability) → implement → green → commit.

### Task 3: Summarizer prompt v2 (term extraction)

**Files:** Modify `src/lib/summarizer.js`; test additions
- SUMMARY_SCHEMA gains `referenced_terms`: array of {term (as the bill names it), kind (statute|act|agency|program|public_law), citation_raw (verbatim from bill text, '' if none printed)} — all required, additionalProperties false. SYSTEM_PROMPT gains an extraction instruction (facts-only: extract ONLY names/citations the bill text itself prints; never infer). PROMPT_VERSION → 'v2'.
- renderMarkdown UNCHANGED (terms don't render in the summary body — they feed the glossary pipeline).
- [ ] Pure tests (schema shape; prompt markers incl. 'never infer'; v2 pin) → implement → green → commit.
- [ ] **GATE (Lance, ~$0.35): `npm run golden -- --check`** under the mechanical approval env — v1 goldens vs v2 prompt; structural drift beyond the additive field should NOT occur (extraction is additive); report results honestly. If DRIFT fires, STOP and surface to Lance before any v2 summarize run.

### Task 4: Extraction backfill CLI

**Files:** Create `src/cli/extract-terms.js`; package.json script; tests for pure parts
- For summaries lacking summary_terms rows: load bill text, run an extraction-only call (claude-sonnet-5, EXTRACT_PROMPT_VERSION 'v1', tiny output) producing referenced_terms; upsert glossary_terms stubs (status draft, needs_mapping per parseCitation) + summary_terms joins. Typed failures; --dry-run zero-call planning; mechanical approval env GLOSS_RUN_APPROVED=yes for live.
- [ ] TDD pure parts → implement → green → dry-run against live DB (lists ~25 candidates) → commit. LIVE RUN GATES on Lance (~25 × ~$0.03 ≈ $0.75).

### Task 5: Glosser + gloss verifier

**Files:** Create `src/lib/glosser.js`, `src/cli/gloss.js`; tests
- glosser: for glossary_terms with a parsed citation and no gloss: fetchUscSection → opus-5 authors {gloss_md (1-2 sentences), supported_by_quote} via JSON schema from the EXCERPT ONLY (system prompt: facts-only, no characterization, plain language, 'from this excerpt alone'); store with source_url/source_hash/provenance. Typed refusal/truncation/oversize errors (reuse conventions).
- verifier: sonnet-5 refutes each gloss sentence against the same excerpt; assessVerdicts-style derived overall; results into summary_verifications? NO — new rows in a glossary_verifications table? AVOID second migration: store verdicts in glossary_terms-adjacent... RULING: reuse `summary_verifications`? Its FK targets summaries — wrong. ADD glossary_verifications to migration 0007 (Task 1): same shape as summary_verifications but FK glossary_terms. (Task 1 implementer: include it.)
- needs_mapping terms are SKIPPED with honest counts (they await curation/mapping — surfaced in the review page).
- [ ] TDD pure parts → implement → green → commit. LIVE RUN GATES on Lance (unique terms × ~$0.16 authoring+verify).

### Task 6: Review server glossary queue

**Files:** Modify `src/review/server.js`, `src/review/page.html`; tests
- New section/tab: glossary drafts + their verification strips + needs_mapping list; approve/reject/publish with the same gated-transition pattern (draft→approved→published; publish requires approved); decisions logged (reuse summary_notes? FK mismatch — glossary_notes table in 0007 OR a generic notes table... RULING: add `glossary_notes` to 0007, same shape as summary_notes). Same CSRF guard applies (existing isAllowedDecisionRequest covers new POST route via the same origin/content-type rules — extend the route allowlist).
- Escaping discipline: gloss text + quotes render via textContent/escaped renderer (model output).
- [ ] TDD transitions/pure parts → implement → green → smoke (0007-gated paths degrade gracefully pre-apply) → commit.

### Task 7: Gated E2E (Lance in the loop)

- [ ] Confirm 0007 applied (probe) → Lance approves extraction backfill (~$0.75) → run → Lance approves gloss batch (N unique terms × ~$0.16, state N first) → run → Lance adjudicates glosses in the review page → publish → anon probes (published glosses readable; drafts/notes/verifications not) → docs checkpoint (CHATLOG/TODO), commit, push.

### Task 8: Final review + merge

- [ ] Whole-branch review (most capable model) → fix wave if needed → merge menu to Lance.

## Self-review notes (write time)

- Task 5/6 add glossary_verifications + glossary_notes to migration 0007 — Task 1's implementer must include BOTH (this note is binding on the Task 1 brief; the design doc's schema block is extended accordingly).
- The popular-name mapping problem (SSA §1903 → 42 USC 1396b) is honestly deferred: v1 glosses only what carries a parseable USC cite; needs_mapping surfaces the rest for curation. No guessing.
- Prompt v2 is additive; goldens should pass the drift check — but the check RUNS (gated) rather than being assumed.
