# Nickname amendment — report

**Status:** Complete. All four deliverables implemented and tested; zero live DB writes; zero
LegiScan API queries. Migration is a DRAFT (Lance applies, per 0008-0012 precedent) — not yet
applied to any live database. The backfill CLI has not been run live (per the task's explicit
scope: "the backfill runs live LATER, controller-operated, after Lance applies 0013").

**Commit SHA(s):** `93aa143ef57073be2396380a308629b0bb02cdc0` (branch `identity-merge`) — single
commit containing migration 0013 (draft), `src/cli/backfill-nicknames.js`, the
`src/lib/person-identity.js` nickname-variant amendment, and both test files.

**Test summary:** 941/941 passing via bare `node --test` (912 baseline + 3 new clusterLegislators
nickname-bridge tests in `tests/link-persons-cli.test.js` + 26 new tests in
`tests/backfill-nicknames-cli.test.js`); both the WITH-nickname (four-Onder rows → ONE cluster)
and WITHOUT-nickname (current two-cluster split) behaviors are regression-locked.

**Concerns:**

1. **`src/cli/link-persons.js` is not wired to nicknames yet — this amendment has zero live
   effect until it is.** `loadLegislators`'s `SELECT` doesn't include `nickname`, so
   `clusterLegislators` never actually receives it from a real run today, and `writeAutoCluster`'s
   structural BELT (`fullNameVariantMatch(memberRows[a].full_name, memberRows[b].full_name)`,
   no nickname) would throw `ClusterNameVariantViolationError` on a legitimately nickname-bridged
   cluster if one ever reached it un-updated. Deliberately left untouched: (a) it wasn't in the
   task's 3-file deliverable list, (b) migration 0013 isn't applied yet, so adding `nickname` to a
   live `SELECT` now would break every real `link-persons.js` invocation (dry-run included) until
   Lance applies it. Flagging so the wiring isn't forgotten before the next bridged dry-run.
2. The given-name nickname equivalence in `clusterLegislators` is scoped to one `surnameKey` group
   per call — correct and tested (an unrelated same-run "Bob Smith"/"Robert Smith" pair does not
   bridge off Onder's nickname), but worth stating explicitly: it is a per-batch union, not
   persisted or cached across runs, so a nickname added to `legislators` by the backfill CLI takes
   effect the next time `clusterLegislators` runs, not sooner.
3. `backfill-nicknames.js` processes cache files independently and does not de-duplicate
   `legiscan_people_id` across the 31 sessions before touching the DB — correct and idempotent
   (`additivePatch` makes every repeat encounter after the first a no-op `already_set`, tested),
   but it does mean up to 31 redundant `SELECT`s for a person appearing in every session. Not
   optimized, since this CLI is explicitly a one-time/occasional backfill, not a hot path.

---

## Fix round 1

**Status:** Complete. Addresses the review's 1 Critical (execution-proven) + 1 Important + 2
Minor findings. Context supplied by the coordinator at review time: `src/cli/link-persons.js` was
wired to select `nickname` and migration 0013 was applied live in a separate commit (`f69aca2`,
not authored by this task), and `backfill-nicknames.js` was run live (52 nicknames patched,
source-printed, data correct) — but no linker run has consumed them yet.

**Commit SHA:** `f768eccb07c208e4f0b86d19fc250cbf456ce388` (branch `identity-merge`).

**Test summary:** 954/954 passing via bare `node --test` (941 prior + 13 new: `nameSetEdgeBasis`
unit tests, the reviewer's exact (a)/(b)/(c) repro scenarios, a positive direct-bridge cluster
test, `auditClusterCoherence` edge-basis tests, and two minor-fix regression tests).

**What changed:**

- **CRITICAL, fixed:** `buildGivenNicknameEquivalence`'s union-find over given-name tokens is
  removed entirely. Replaced with pairwise printed-name-set intersection (`nameSetEdgeBasis`,
  now exported): each row's name-set is `{its own given, its own nickname if present}` — fixed
  data about that row alone, never merged with another row's set via any shared pivot token.
  Every matching pair is classified `residual_identical_name` (both sides' plain given names are
  literally identical — the pre-existing, nickname-unrelated accepted residual) or `direct_name`
  (the two rows' own printed sets intersect only because of an actual nickname). Reworked-through
  consequence for the original four-Onder scenario: the legiscan row's own two printed forms
  create real direct edges to bioguide (via identical given) and to openstates/mosenate (via the
  nickname), but bioguide and openstates/mosenate never share a token with EACH OTHER — so the
  pre-existing exhaustive-pairwise-recheck safety net (unchanged, the same mechanism that already
  handles the "John Duncan" suffix-omission bridge) now correctly FLAGS that group
  (`internal_no_name_variant`) rather than silently auto-clustering it. This is a behavior change
  from fix round 0 (which wrongly auto-clustered it via the fabricated equivalence) — regression-
  locked with the reviewer's exact (a) 4-hub repro (component connects transitively via real edges
  but is flagged, never auto-clustered), (b) the discriminating case (hubs with different given
  names — component genuinely splits into two clean clusters), and (c) two bare rows with no hub
  at all (never connect). A new positive test proves the mechanism still produces a clean
  auto-cluster when a nickname directly and completely bridges a 2-row group.
- **AUDIT INDEPENDENCE, added:** `auditClusterCoherence` now recomputes `nameSetEdgeBasis` per
  pair directly from each cluster's own `fullName`/`nickname` evidence (no shared/rebuilt
  equivalence structure — genuinely independent for this class now) and reports
  `clusterEdgeBasis: [{clusterKey, direct_name_edges, residual_identical_name_edges}, ...]` plus
  `residualOnlyClusters: [clusterKey, ...]` — visibility for the operator into which clusters rest
  entirely on the pre-existing identical-name residual, not a new pass/fail gate.
- **IMPORTANT, documented:** a "RESIDUAL WIDENING" note beside the existing ACCEPTED RESIDUAL
  comment in `person-identity.js` — nickname bridging can pull more rows into one connected
  component than before, giving the pre-existing identical-full-name residual (unrelated to
  nicknames itself) more opportunities to fire on pairs the nickname evidence never actually
  spoke to. Not gated; `auditClusterCoherence`'s residual-edge visibility is the operator's window
  into it.
- **MINORS, fixed:** `extractNicknamePeople`'s redundancy filter (nickname vs. first_name) now
  compares via `normalizePersonName` instead of raw strings, so a casing/punctuation-only quirk
  reads as redundant rather than a false new-information nickname (the persisted value itself
  stays the source's verbatim string). `listCachedDatasetFiles` now sorts its output
  lexicographically, so multi-session nickname precedence (first-processed-wins under
  `additivePatch`) is deterministic run-to-run instead of dependent on filesystem iteration order.

**Concerns (fix round 1):**

1. **New, surfaced by this fix round:** `link-persons.js`'s `writeAutoCluster` BELT
   (`fullNameVariantMatch(memberRows[a].full_name, memberRows[b].full_name)`) still has no
   nickname awareness. Since `nickname` is now live-selected and 0013 is applied, a genuinely
   `direct_name`-matched 2-row cluster from `clusterLegislators` would reach `writeAutoCluster` and
   incorrectly throw `ClusterNameVariantViolationError` rather than write — safe/fail-loud
   direction (no wrong-merge risk, just an availability/correctness gap: a legitimate cluster
   becomes unwritable until this is patched), but real and live-relevant given the pending dry-run.
   Not fixed here: outside this review's stated scope (the review's findings were about
   `person-identity.js`/`backfill-nicknames.js` only), and `link-persons.js` is now separately
   controller-owned/live-modified territory. Recommend a follow-up before the next live linker run
   consumes the 52 already-patched nicknames.
2. Concerns 1-3 from the original report (link-persons.js wiring, per-batch equivalence scope,
   redundant per-session SELECTs) are otherwise superseded/resolved by the above, except that the
   equivalence-scoping note (concern 2) no longer applies literally — there is no
   equivalence/index structure left to scope; matching is now purely pairwise per-row.

---

## Fix round 2

**Status:** Complete. Addresses the coordinator's controller-adjudicated scope extension: fix
round 1's own concern #1 (the `writeAutoCluster` BELT drift) is now fixed, not just flagged.

**Commit SHA:** `8c3734a2d644f205570a17b05dfb6442284a1f3c` (branch `identity-merge`).

**Test summary:** 956/956 passing via bare `node --test` (954 prior + 2 new `writeAutoCluster`
tests: a nickname-bridged 2-row cluster passes the BELT and writes on a fake client; a genuinely
name-incoherent cluster — nickname present on one side, still no shared printed token — still
throws `ClusterNameVariantViolationError`). All prior BELT tests (from fix round 0 and the
original amendment) stay green, unchanged.

**What changed:**

- `src/lib/person-identity.js`: `rowNameVariantMatch` (row-shaped, nickname-aware pairwise
  printed-name-set matcher — the SAME function `finalPairStatus` uses inside `clusterLegislators`
  itself, fix round 1's own gate) is now exported, with its doc comment extended to describe the
  fix-round-2 alignment: a residual_identical_name edge is exactly as valid for a coherence check
  as a direct_name edge — that distinction only exists for `auditClusterCoherence`'s own operator-
  visibility reporting (`clusterEdgeBasis`/`residualOnlyClusters`), never for deciding whether a
  pair is coherent at all.
- `src/cli/link-persons.js`: `writeAutoCluster`'s structural BELT now calls
  `rowNameVariantMatch(memberRows[a], memberRows[b])` (full row objects, so `nickname` — already
  selected by `loadLegislators` per the controller's separate live commit `f69aca2` — participates)
  in place of the narrower `fullNameVariantMatch(memberRows[a].full_name, memberRows[b].full_name)`
  it used before. The BELT now validates EXACTLY the property `clusterLegislators` guarantees for
  any cluster it produces, so a real, matcher-legal, nickname-bridged cluster (the "Robert Onder"/
  nickname "Bob" + "Bob Onder" shape) no longer wrongly fails this check and refuses to write —
  closing the availability gap fix round 1 identified and left as a concern rather than a fix
  (deliberately, since it was outside that round's reviewed scope; the coordinator has now
  explicitly extended scope to cover it).

**Concerns:** None outstanding from this round. The nickname amendment is now internally
consistent end-to-end (`person-identity.js`'s matcher, `auditClusterCoherence`'s independent
re-verification, and `link-persons.js`'s structural write-time BELT all share the same pairwise
printed-name-set semantics) and ready for the next live `link-persons.js --dry-run` to actually
exercise the 52 already-patched nicknames — that dry-run itself has not been run as part of this
task (no live DB writes anywhere in this task's own work, per the original hard rule).
