# Task 8 report: coexistence policy (revised)

**Status:** complete. Documentation/comments + one comment-level wiring note, per the CONTROLLER
RULINGS appended to `task-8-brief.md` (Senate journals pipeline stays completeness-critical, NOT
demoted; House exposure documented as UNKNOWN pending Task 10; scope stays small; display-dedup
rule documented as a comment, not code). No functional/behavioral change, no new CLI/UI, no live
calls, no DB writes.

**Commit:** `298dd5f5d8dd7bf5a0d38102f60319111285c6e7` — "docs: coexistence policy revised - MO
Senate journals stay completeness-critical (Task 7 evidence), House exposure unknown pending Task
10, display-dedup rule documented". Files: `docs/superpowers/plans/2026-07-29-legiscan-bulk-
adapter.md`, `src/adapters/legiscan-votes.js`, `src/cli/ingest-mo-house.js`,
`src/cli/ingest-mo-senate.js`.

**Test summary:** full suite 744/744 green, before and after (comment-only changes; no test count
change).

**Concerns:**
- The checklist's "exercise `crossCheckAgainstPrimarySource` end-to-end against a synthetic
  mismatch scenario" item is satisfied by Task 6's own existing tests
  (`tests/legiscan-votes.test.js`, e.g. the "YEA mismatch" and "Present-category caveat" cases,
  both against a `mo-house-xml-*`-sourced primary vote row with deliberately mismatched tallies) —
  confirmed still green, not duplicated with a new Task-8-local test, since it would be redundant
  coverage of the exact same code path.
- Task 10 (per-chamber count comparison, cited in both the House driver comment and the plan doc)
  is referenced as the mechanism that will eventually resolve the House pipeline's UNKNOWN
  exposure — that comparison itself is not built here; Task 10's own brief will need to define it.
- The plan doc's original Task 8 text is kept below the new REVISED callout (marked superseded)
  rather than deleted, so the pre-Task-7 reasoning stays visible for anyone reading history; if a
  cleaner rewrite is preferred later that's a trivial follow-up, not a blocker.
