# Profile Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the data gaps between what the database holds and what a politician's profile page needs — sponsored bills, bill status, member display metadata, bill texts, attach-to-existing identity, and plain-language summaries at scale for $0 API spend — per the two-steps-ahead walk-back Lance approved 2026-07-29 (in CHATLOG).

**Architecture:** one migration (bill_sponsors); two $0 backfills from the LegiScan cached ZIPs (MO sponsors + MO bill status); one polite free Congress.gov fetch pass serving four needs at once (federal sponsors, status, texts, member metadata); the identity system's attach-to-existing path (hard deadline: before the Jan 2027 session rollover splits every returning member); and a resumable, passage-first priority queue driving opus/sonnet SUBAGENTS (Claude Code plan, not the metered API) through the existing summary prompts, schemas, and mechanical gates.

**Tech stack:** existing Node ESM; NO new dependencies; zero Anthropic API spend anywhere in this plan (subagent orchestration is operated by the controller session, not by CLI code — see Task 5's split).

## Global Constraints

- Zero metered-API model calls. The GOLDEN_CHECK/GLOSS gates stay closed. Congress.gov + cached-ZIP reads only; every fetch through the existing polite limiters.
- Additive writes only (insertIfAbsent/additivePatch); selectAll for every multi-row read (legislators 1,576; bills 38,250; votes 9,900+ — everything is past or near the 1,000 cap); provenance run_id everywhere; typed errors; skip≠empty; honest counts.
- DESIGN FREEZE (two-steps-ahead ruling): no new per-state identity columns, ever — future states ride legiscan_people_id + terms. 0014's comments state this.
- Draft-then-apply: 0014 written + committed; Lance applies; everything gated via isMissingRelationError until then.
- Identity invariants are law: full-name-variant necessity, asymmetric cost, writer BELT, pairwise name-sets. Attach-to-existing must reuse the same matcher primitives — no parallel matching logic.
- node:test bare invocation; 979 baseline stays green; fixtures-first (cached ZIPs and real Congress.gov captures are the fixtures). Commits end: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: Migration 0014 — bill_sponsors (CONTROLLER-DRAFTED, Lance applies)

Already drafted alongside this plan: `supabase/migrations/0014_bill_sponsors.sql` — bill_sponsors(bill_id FK, legislator_id FK, sponsor_type check ('primary','cosponsor'), run_id, created_at, unique(bill_id, legislator_id)); RLS enabled; anon SELECT (display table); design-freeze comment.
- [ ] Lance applies; probe verifies.

### Task 2: MO sponsors + bill status backfill (cached ZIPs, $0, 0 queries)

**Files:** Create `src/cli/backfill-mo-bill-meta.js`, tests.
- Reads the 31 cached dataset ZIPs (skip-with-count if missing, NEVER fetch); per bill payload: sponsors[] (people_id + sponsor_type/primary flag — verify the REAL field names against the fixtures first) → bill_sponsors rows via legiscan_people_id → legislator lookup (exact key only; unmatched → honest count, never guessed); status/status_date + last history entry → additivePatch bills.status (fills null only — never overwrites; bills.status semantics: LegiScan's own printed status string, source-labeled).
- Gated on 0014 for sponsor writes (isMissingRelationError → honest gated count); status writes ungated (column exists).
- [ ] TDD off the two committed dataset fixtures (1579/1608 — real sponsor shapes) → implement → full suite green → dry-run → commit. Live run controller-operated.

### Task 3: Federal fetch pass — sponsors + status + texts + member metadata (Congress.gov, free)

**Files:** Extend `src/adapters/us-congress.js` (bill-detail + member-detail parsing, fixture-first — capture 2-3 real payloads politely); Create `src/cli/enrich-federal-bills.js`, tests.
- Worklist: distinct voted-on federal bills (selectAll over votes → bill ids). Per bill (existing polite limiter, X-Api-Key header discipline): bill detail → sponsors (bioguide → legislator exact match) + latestAction/status (additivePatch bills.status) + text-version URL → fetch text (existing bill_texts conventions, content_hash; oversize gate honored).
- Member metadata: current members endpoint → party/state/district (additivePatch legislators fills-null; bioguide photo URL constructed mechanically from bioguide_id, stored... legislators needs no new column: photo URL is DERIVABLE from bioguide_id at render time — DO NOT add a column; note this in the report).
- Durable progress (artifact or DB-keyed) so the pass resumes across restarts; --limit for chunking; honest per-category counts.
- [ ] TDD parsers off captured fixtures → implement → suite green → dry-run → commit. Live pass controller-operated in background chunks.

### Task 4: Attach-to-existing (identity; pre-rollover deadline)

**Files:** Modify `src/cli/link-persons.js`, `src/lib/person-identity.js` (only if a primitive is missing), `src/review/server.js` + `page.html`, tests.
- Linker gains an attach pass: unlinked rows are compared (same pairwise matcher, same evidence rules) against LINKED rows' name+evidence; a qualifying match emits an `attach_candidate` identity_flag (never auto-attaches — Lance decides; evidence carries the existing person_id + display_name).
- Review server: the identity decision route gains action 'attach' {flag_id, legislator_ids, person_id} — links selected rows into the EXISTING person (person_links decided_by 'lance', additivePatch person_id with the TOCTOU guard pattern), no new persons row. Keep-separate unchanged.
- The keep-separate-binding check (final-wave item 2) must also gate attach candidates.
- [ ] TDD: attach flag emitted for an Onder-shaped fifth row; attach decision links into the existing person (fake client, per-row assertions); TOCTOU-guarded; keep-separate-ruled pairs never attach-flag. Full suite green → commit.

### Task 5: Summary priority queue (code) — subagent orchestration stays with the controller

**Files:** Create `src/cli/summary-queue.js`, tests.
- CODE side (this task): a queue planner + result writer, NO model calls: `plan` mode emits the prioritized worklist (passage-vote bills first — question ~ /passage|third reading/i — then others; excludes: already-summarized, no-text, oversize per MAX_TEXT_CHARS) as JSON; `record` mode accepts one bill's {summary_json, verifier_verdicts} (produced by the controller's subagents), runs the SAME mechanical gates the API pipeline uses (schema shape, completeness derivation via assessVerdicts, section-citation checks), writes summaries/summary_verifications with provenance model='subagent:<model>' + prompt_version, and (clean) auto-publishes per trust-model v3 / (flagged) leaves draft. Idempotent; resumable; honest counts.
- ORCHESTRATION side (NOT this task's code): the controller session dispatches opus-subagent author + sonnet-subagent verifier per queued bill using the canonical SYSTEM_PROMPT/SUMMARY_SCHEMA/verify prompts exported from summarizer.js/verifier.js, then feeds `record`. Overnight chunks, throttled.
- [ ] TDD the planner (priority, exclusions) + record gates (rejects malformed/incomplete; never trusts self-reports) → implement → suite green → commit.

### Task 6: Live slices + docs

- [ ] MO backfill live (0 queries) → verify sponsor counts + status fill-rate. Federal pass chunk 1 live → verify. Attach pass dry-run → live → flags to Lance. First summary overnight chunk (controller-operated) → report real clean/flagged counts.
- [ ] Docs checkpoint (CHATLOG/TODO; freshness + Plan 3 requirements notes carried forward) → commit, push.

### Task 7: Final review + merge

- [ ] Whole-branch review (most capable model, workflow) → fix wave → merge menu to Lance.

## Self-review notes (write time)

- Task 5 deliberately splits code (gates/writer, testable, $0) from orchestration (controller-driven subagents) so no CLI ever needs an Anthropic key for this path; the trust chain's mechanical parts stay IN CODE where reviews can attack them.
- Task 3's photo decision (derive from bioguide_id, no column) recorded here so no task invents schema.
- Task 4 reuses matcher primitives verbatim — any new matching logic is a review-rejectable defect.
- The federal fetch pass is the long pole (500+ bills, polite pacing) — chunked and resumable by design.
