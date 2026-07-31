# Task 5 report — summary priority queue (code)

**Status:** complete.

**Commit SHA(s):** cc67514 (branch `profile-completeness`)

**Test summary:** 1170/1170 green, bare `node --test` (1114 baseline + 56 new, all in
`tests/summary-queue-cli.test.js`). Zero live DB writes/network from tests (fake Supabase-shaped
clients only); zero model calls anywhere in `src/cli/summary-queue.js` or its tests.

**Concerns:**
- `plan` mode's JSON worklist deliberately omits full bill text content (identifier, title,
  bill_text_hash, priority, text_length only) — the controller must do its own small read for the
  actual text before dispatching an author subagent. Not in the brief's explicit scope; flagged in
  case the controller session expects text inline.
- `record` mode's idempotency short-circuit (`alreadySummarized` at a matching hash, status in
  draft/approved/published) means a bill left `unverifiedDraft` by one batch cannot be re-verified
  by calling `record` again with the same bill_id/hash — same limitation summarize.js/verify.js's
  two-CLI split already has today; the existing `verify.js` CLI (API-gated) remains the recovery
  path. Not a new gap, but worth the controller knowing before relying on `record` for retry.
- No live/dry-run pass performed against a real DB (no Supabase credentials in this environment,
  and out of this task's scope — Task 6 is the live-slice task). Proven only against fixtures/fake
  clients, including two `selectAll`-pagination tests past the 1000-row server cap for `bills` and
  `votes` specifically (named in Global Constraints as already past/near that cap).

---

## Fix round 1

**Status:** complete — 1 CRITICAL + 2 IMPORTANT findings fixed, all execution-proven; 1 Minor
finding acknowledged with a note-only comment, not fixed (accepted, inherited shape).

**Commit SHA:** 1ed8365 (branch `profile-completeness`)

**Test summary:** 1180/1180 green, bare `node --test` (1114 baseline + 66 in
`tests/summary-queue-cli.test.js`, up from 56 — 10 new).

**Fixes:**
1. **CRITICAL (vacuous-empty payload):** `{what_it_does: [], verdicts: []}` vacuously satisfied
   both `checkCitationsPresent`'s missing-section loop (nothing to iterate) and `assessVerdicts`'
   documented zero-bullets/zero-verdicts "clean" case, so a payload asserting nothing would
   auto-publish with a false "clean verification" note — this codebase's third encounter with the
   empty-set-vacuously-passes class (the glossary pipeline hit the identical shape as its own
   final-review finding 4). Fixed: `checkCitationsPresent` now rejects `what_it_does.length === 0`
   as `MalformedSummaryError` before `assessVerdicts` ever runs.
2. **IMPORTANT (provenance format):** `author_model`/`verifier_model`, if supplied, must be a
   non-empty string not already carrying this file's own `'subagent:'` prefix — an empty string
   used to slip past the `?? MODEL` default (which only falls back on null/undefined) and produce
   a stored provenance label of the bare string `'subagent:'`; an already-prefixed value would
   double-prefix. Fixed via a new `validateModelLabel` check inside `validateEnvelope`.
3. **IMPORTANT (real passage-vote corpus):** `PASSAGE_QUESTION_RE` missed real corpus shapes —
   MO LegiScan's `"House: SB 894  SBs 3rd READ - INFORMAL"` and MO OpenStates'
   `"Third Read and Passed (H) -"` motion_text (both verbatim from this repo's own fixtures).
   Widened from `/passage|third reading/i` to `/passage|third\s+read|3rd\s+read/i`; tested against
   both real fixture strings verbatim and the original clean-room forms (no regression).
4. **Minor (note-only):** documented, not fixed — a check-then-act race in the already-summarized
   lookup (two concurrent `record` calls for the same bill could both pass the check before either
   writes). Accepted: this file's design is a single controller session feeding `record` serially.
