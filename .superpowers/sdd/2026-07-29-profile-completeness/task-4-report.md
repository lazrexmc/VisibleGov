# Task 4 report — attach-to-existing

**Status:** complete.

**Commit SHA(s):** 4fe47c3c3ed056b0b6c807ec617e3eec28f13946 (branch `profile-completeness`)

**Test summary:** 1011/1011 green, bare `node --test` (979 baseline + 32 new tests: 21 in
tests/link-persons-cli.test.js, 24 in tests/review-logic.test.js, 4 in
tests/review-page-decisions.test.js — some tests also extend/annotate 3 pre-existing assertions).
Zero live DB writes/network from tests (fake Supabase-shaped clients only).

**Concerns:**
- Attach pass is scoped to clusterLegislators' own `singletons` output, not every unlinked row —
  a row that lands in a NEW same-run cluster or a matcher/keep-separate flag is not also attach-
  checked in that same run. Documented as a deliberate scope decision (avoids two competing
  suggestions for one row in one run); directly covers the named deadline scenario (a returning
  legislator's lone fresh session row). Not literally "every unlinked row" per the brief's opening
  sentence — flagged for controller review.
- attach_candidate flags inherit the same cluster_key-drift residual already ledgered for Task 1's
  normal flags (partial resolution across re-runs can leave an old flag row orphaned alongside a
  new one covering the shrunk candidate set) — same accepted, documented behavior, not new.
- No live linker run performed (Task 6's job per the plan, not Task 4's) — attach pass is untested
  against real data, only fixtures (including a literal Onder-shaped fifth-row worked example).

---

## Fix round 1

**Status:** complete — all 3 reviewer-confirmed CRITICALs fixed, execution-proven by new tests
reproducing each exploit shape.

**Commit SHA:** 80ae5316981056ae0b450daeb769c3bb0c17388a (branch `profile-completeness`)

**Test summary:** 1020/1020 green, bare `node --test`, own scope (1011 prior + 9 new: 7 in
tests/link-persons-cli.test.js, 2 in tests/review-logic.test.js). One unrelated file
(`tests/backfill-mo-bill-meta-cli.test.js`, a different in-flight task's untracked work-in-progress
on the same shared branch, not touched by this task) was mid-edit and red at the moment of the
whole-tree run; excluded from the count above as out of this task's scope — not a regression here.

**Fixes (all reviewer-ruled, all landed exactly as ruled):**
1. **CRITICAL 1 (server-side validation gap):** the reviewer's language was precise — the route
   trusted a client-supplied `person_id` in isolation, so a plain non-attach flag plus an unrelated
   `person_id` produced real writes (HTTP 200), not just a benign miss. Fixed: before any write,
   the route now requires `flag.evidence.reason === 'attach_candidate'` AND
   `person_id === flag.evidence.existingPerson.personId`; violation → 400, zero writes. Two new
   tests reproduce the reviewer's exact exploit shape (plain flag + unrelated but real person_id)
   and the narrower variant (a genuine attach_candidate flag, wrong person_id) — both 400, zero
   writes proven via the call log.
2. **CRITICAL 2 (singletons-only scope resurrected an automatic, unreviewed WRITE — not a benign
   miss, per the reviewer's correction of my own softer framing):** two fresh same-person rows
   arriving in one run formed a clean 2-cluster (never a singleton, so the singleton-only attach
   pass never saw them) and would have sailed through `writeAutoCluster` untouched, silently
   minting a second `persons` row for someone already linked — zero flag, zero review. Fixed: new
   `applyAttachCrossCheck` (src/cli/link-persons.js) cross-checks every clean cluster's members
   against every already-linked person's members (via `finalPairStatus`, verbatim primitives,
   zero parallel matching logic) before any cluster is treated as safe to write; a single
   `'compatible'` edge anywhere demotes the WHOLE cluster to an `attach_candidate` flag citing that
   person — never partially written, never auto-attached. A `runLink`-level test reproduces the
   reviewer's exact two-fresh-Onder-rows scenario: zero persons written, one `attach_candidate`
   flag covering both rows citing the existing person.
3. **CRITICAL 3 (dynasty attach trap):** `buildAttachCandidates` (and, after fix 2, the new
   cross-check) accepted `'ambiguous'` as a qualifying edge — a fresh dynasty singleton (the real
   Bayh shape) could get suggested against the wrong family member's person. Fixed: attach
   candidacy now requires `'compatible'` ONLY. Because `'compatible'` is only reachable through
   `finalPairStatus`'s own unconditional full-name-variant gate, this structurally closes the
   "brand-new row id has no keep-separate ruling on file yet" gap for the whole dynasty class for
   free (documented in-code) — differing given names can never produce `'compatible'`, so a fresh
   family-member row is never suggested against the wrong person even with zero prior adjudication
   history for that specific row. Tests reproduce the real Bayh shape (same dateless Indiana Senate
   seat, differing given names, zero keep-separate ruling on file) for both the attach pass and the
   cross-check, plus the sibling `'ambiguous'` shape (matching names, provably non-overlapping
   eras).

**Concerns (updated):**
- The singletons-only scope concern from the original report is now closed for the write-risk
  class it actually posed: `applyAttachCrossCheck` cross-checks every clean cluster, not just
  singletons, before any write. The remaining residual is narrower and benign: a row that lands in
  a MATCHER-flagged group (`ambiguous_era`/`internal_contradiction`/`internal_no_name_variant`/
  `conflicts_with_keep_separate_ruling`) alongside other unlinked rows is not additionally
  cross-checked for an attach hint — but that row already reaches Lance via the flag itself
  (`writeAutoCluster` is never called for a flagged group), so this is a missing annotation, not an
  unreviewed-write risk.
- attach_candidate flags (both the singleton attach pass and the new cross-check demotion) inherit
  the same cluster_key-drift residual already ledgered for Task 1's normal flags.
- No live linker run performed (Task 6's job per the plan) — fixtures only, including the
  reviewer's own exploit shapes reproduced as regression tests.

---

## Micro-round (re-review, information-gap finding — non-blocking)

**Status:** complete. Re-review confirmed all 3 fix-round-1 Criticals ALL CLEAR; one non-blocking
gap closed: `findCompatibleExistingPerson` stopped at the first matching existing person, so a
cross-check-demoted cluster's flag cited only ONE candidate when TWO existing persons genuinely
matched — the sibling singleton attach pass already surfaced every match (as separate per-person
flags); this path needed to surface the same completeness, just within one flag.

**Commit SHA:** 46aaa56be7e5082ef28f5b3fe750de7cb5f3ce9f (branch `profile-completeness`)

**Test summary:** 1070/1070 green, bare `node --test`, whole tree (includes a concurrent
unrelated task's files on the same shared branch, untouched by this commit).

**Change:**
- `findCompatibleExistingPersons` (renamed, plural — src/cli/link-persons.js) now collects EVERY
  compatible existing person, not just the first.
- Both flag-creation paths (`buildAttachFlags`, `applyAttachCrossCheck`) now emit
  `evidence.existingPersons: [{personId, displayName}, ...]` — the full matched set — with
  `existingPerson` kept as `existingPersons[0]` for back-compat with anything still reading the
  singular field.
- `buildAttachClusterKey` accepts a single personId or an array; a 1-element array collapses to
  the identical key string a bare id would, so the single-match case (the overwhelming majority)
  is byte-for-byte unchanged.
- `src/review/server.js`'s `'attach'` validation now checks `person_id` membership in
  `existingPersons`' ids (defensively falls back to wrapping the singular `existingPerson` if
  `existingPersons` is ever absent) rather than exact-equality against one value.
- `page.html` gained a `#identity-attach-target` picker: hidden and unused when 0–1 targets exist
  (the common case), shown and populated with every candidate's `displayName (personId)` when 2+
  genuinely match; the meta line lists all targets; the Attach click posts whichever one Lance
  selected.

**Tests added:** two-matching-persons scenario at the pure-matcher level (`applyAttachCrossCheck`),
end-to-end through `runLink`, at the server decision route (accepts either listed person, still
400s an unlisted one), at the queue-read level (`existing_persons` surfaces both), and in the
jsdom UI (picker renders both options, posts the selected one; single-target flags keep the
picker hidden). Regression test confirms the single-match `clusterKey` format is unchanged.
