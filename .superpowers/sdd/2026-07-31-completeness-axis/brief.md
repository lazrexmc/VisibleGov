# Task brief — the completeness axis (summaries: prove nothing important is missing)

**The gap this closes.** Today's verification proves every claim in a summary is *supported* by the
bill text. Nothing proves the summary *covers* the bill. A summary can be 100% supported, publish
clean, and omit the single most consequential provision — and the reader has no way to know. For a
project whose promise is "understand what a bill actually does," an omission is as damaging as a
fabrication, and it is currently unguarded. Lance chose this as the first quality investment
(2026-07-31), ahead of prompt rewrites, because it protects every summary generated afterward.

**Zero metered spend.** No Anthropic API calls anywhere in this code. The prompts and schemas you
export are used by CONTROLLER-ORCHESTRATED SUBAGENTS (the $0 path), exactly as
`SYSTEM_PROMPT`/`SUMMARY_SCHEMA`/`VERIFY_SYSTEM_PROMPT` already are. Your code never calls a model.

## The doctrine that binds this (trust model v3)

Never trust a checker's self-report. The existing `assessVerdicts` re-derives `overall` from the
per-bullet verdicts rather than believing the verifier's own summary judgment. **Do the same here:
`assessCompleteness` must re-derive the outcome mechanically from the structured coverage data, and
the record gate must re-run that derivation itself rather than trusting anything the subagent said.**

## What to build

### 1. `src/lib/verifier.js` — the completeness prompt + schema + mechanical assessor

Export, alongside the existing verification exports:

- `COMPLETENESS_SYSTEM_PROMPT` — instructs a checker to work in two phases and to cite sections:
  - **Phase 1 (provisions):** given ONLY the bill text, list the provisions a reader must know to
    understand what this bill does — bounded to 3–7, each with the section it lives in and a short
    factual statement of what it does. Facts only, no significance language beyond what the text
    supports ("bars judicial review of the reissuance" — not "an alarming limitation").
  - **Phase 2 (coverage):** given that provision list AND the summary's bullets, mark each provision
    covered or not, and when covered, cite the bullet index that covers it.
  The prompt must state explicitly that phase 1 is formed WITHOUT reference to the summary — the
  controller enforces this by dispatching phase 1 with the bill text only, then sending the summary
  in a second message. Document that orchestration contract in the export's comment.
- `COMPLETENESS_SCHEMA` — a JSON Schema with `key_provisions: [{ section, provision }]` and
  `coverage: [{ provision_index, covered, bullet_index|null, note }]`. `additionalProperties: false`
  throughout, all fields required, `bullet_index` null exactly when `covered` is false.
- `assessCompleteness(completeness, bulletCount, billText)` → pure, no I/O, returns
  `{ overall: 'complete'|'incomplete'|'malformed', missing: [...], reasons: [...] }`:
  - **malformed** (never publish) when: `coverage.length !== key_provisions.length`; any
    `provision_index` out of range or duplicated; `covered === true` with a null/out-of-range
    `bullet_index`; `covered === false` with a non-null `bullet_index`; zero `key_provisions`
    (the vacuous-empty class — this codebase has hit it four times; a checker that finds no
    provisions has not checked anything).
  - **grounding check (the anti-hallucination gate on the CHECKER itself):** every
    `key_provisions[].section` must appear in `billText` (same normalize-whitespace-then-substring
    discipline `checkStatedPurposeGrounding` already uses — read it and match it). A provision citing
    a section that isn't in the bill means the checker invented it → `malformed`.
  - **incomplete** when any `coverage[].covered === false` — with `missing` naming those provisions.
  - **complete** only when well-formed, grounded, and every provision covered.

### 2. `src/cli/summary-queue.js` — the record gate gains the second axis

The record item may now carry `completeness` alongside `verdicts`. Rules:
- `completeness` is REQUIRED for `publish`. An item without it can still be recorded, but lands as
  a flagged draft with an honest reason (`completeness_check_absent`) — never auto-published. This
  is the safe default while the orchestration is being rolled out.
- Re-derive with `assessCompleteness` against the summary's own bullet count and the hash-pinned
  bill text the gate already fetches for `checkStatedPurposeGrounding` (it is already in hand — do
  not fetch it twice).
- `malformed` → reject (same class as a malformed summary — the checker's own output is untrustworthy).
- `incomplete` → flagged draft, reason naming the missing provisions.
- `complete` AND the existing support verification clean → publish, per trust model v3.
- Counts gain honest buckets; failures carry the reason. Keep the closed-reconciliation discipline.

### 3. Migration 0020 (DRAFT ONLY — Lance applies)

`supabase/migrations/0020_completeness_checks.sql`:
- `alter table summary_verifications add column kind text not null default 'support'
   check (kind in ('support','completeness'));` — existing rows are correctly 'support'.
- Store completeness results as their own row (kind='completeness', `verdicts` holding the
  structured coverage payload, `overall` holding the re-derived value).
- Recreate `public_verification_notes` so the public receipt reflects BOTH axes — the bill page
  should be able to say a summary was checked for accuracy *and* for coverage. Keep it scoped to
  published summaries and free of `prompt_version` (both properties migration 0019 established —
  read 0019 first and preserve them; a regression there re-opens a leak that was already fixed).
- Follow the existing migration conventions exactly (drop-if-exists guards, grants to anon +
  authenticated, comments explaining the reasoning).

### 4. `src/review/server.js` + the site's bill page

Out of scope for THIS task except one thing: do not break them. The bill page reads
`public_verification_notes`; if 0020 changes its shape, note precisely what a follow-up task must
update, in your report. Do not edit `site/` in this task.

## Tests (TDD, failing first)

`tests/completeness.test.js` plus additions to the summary-queue suite:
malformed on count mismatch / duplicate index / covered-with-null-bullet / uncovered-with-bullet /
zero provisions; grounding rejection when a cited section is absent from the bill text; grounding
acceptance across whitespace/wrapping differences; incomplete naming the right missing provisions;
complete only when all conditions hold; the record gate refusing to publish without a completeness
payload; the gate re-deriving rather than trusting a supplied `overall` (feed it a payload whose
self-reported overall says 'complete' while the coverage data says otherwise — the gate must flag);
counts reconcile.

Full suite: bare `node --test` from repo root, baseline **1881** stays green.

## Out of scope

Prompt v3 (headline field, consequence ordering, tiered depth) — a separate, later task. Any live
model call. Any `site/` edit. Regenerating existing summaries.

Commit: `feat: completeness axis - prove a summary covers the bill, not just that it is true`
ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
