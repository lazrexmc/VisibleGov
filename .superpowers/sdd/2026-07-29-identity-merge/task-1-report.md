# Task 1 report — cluster pass + linker CLI

Branch `identity-merge`, commit `286f727` — `feat: person clustering + linker CLI (auto + flags)`.

## Files

- **`src/lib/person-identity.js`** (modified, zero-import purity preserved) — added the cluster
  pass: `surnameKey`, `evidencePairStatus`/`rowPairStatus` (internal), `clusterLegislators`
  (exported, pure), and the display-name helpers `reorderCommaName`, `pickDisplayName`,
  `NoDisplayNameSourceError` (exported). Existing exports (`normalizePersonName`, `eraOverlaps`,
  `matchLegislator`) untouched.
- **`src/cli/link-persons.js`** (new) — the linker CLI. `parseArgs`, `loadLegislators`/`loadTerms`
  (selectAll), `partitionByLinkStatus`, `buildEvidenceRows`, `writeAutoCluster`,
  `writeIdentityFlag`, the testable orchestration seam `runLink(client, {dryRun, runId})`, and
  `main()`. `PersonLinkConflictError` typed error.
- **`tests/link-persons-cli.test.js`** (new) — 32 tests, fake-client only (no network, no live DB
  writes), covering both the pure `person-identity.js` additions and the CLI.
- **`package.json`** — added `"link:persons": "node --env-file=.env src/cli/link-persons.js"`.

## Cluster-rule decisions, with examples

**Candidate pairing key (`surnameKey`).** Uses the `surname` column when populated (MO-driver
rows only, migration 0006); otherwise derives it structurally as the last token of
`normalizePersonName(full_name)` — reuses the existing comma-reorder fold, so `'Onder, Robert F.'`
and `'Bob Onder'` both key to `'onder'` without needing per-source nickname data (which isn't
persisted on the `legislators` row at all — confirmed live: LegiScan's `nickname:"Bob"` is used by
`legiscan-identity.js` only at *resolution* time, never written to the row). A coincidentally wrong
derived key only ever costs a missed pairing, never a wrong merge, since the key is only the first,
broad gate — full pairwise evidence compatibility still gates everything downstream.

**Evidence compatibility (`evidencePairStatus`).** Two evidence entries (each `{jurisdiction_id,
chamber, district, start_date, end_date}`, sourced from `terms` rows *and* `mo_house_id`/
`mo_senate_id` columns — both count, per the plan) are:
- **`compatible` (vacuous)** if `jurisdiction_id` or `chamber` differ — a federal/state or
  House/Senate difference is a career, not a contradiction (the plan's own ruling, extended
  symmetrically to MO House↔Senate for the identical reason).
- **`contradiction`** if jurisdiction_id and chamber match, and both sides print a *concrete*
  district that differs — a hard, structural fact.
- **`ambiguous`** if jurisdiction_id/chamber/district all agree (or district is unknown on either
  side) but `eraOverlaps` says the two windows provably don't touch.
- **`compatible`** otherwise (including when either side has zero evidence at all — nothing to
  contradict, honestly).

**Grouping.** Within a same-surname-key group, rows are unioned (union-find) whenever their
combined `rowPairStatus` (max across every evidence-entry cross-product) is *not* `contradiction`.
Each resulting connected component is then **re-scanned exhaustively over every internal pair**
(not just the union-find edges) — this is the safety net for a real, live-observed failure mode: a
third, evidence-free row can vacuously bridge two rows that *do* directly contradict each other,
and without the re-scan the contradiction would be silently absorbed into a "clean" component. Any
internal contradiction anywhere → flagged `internal_contradiction`; else any internal `ambiguous` →
flagged `ambiguous_era`; else → a clean auto cluster.

**Worked example — the real four-Onder rows** (live-fetched, read-only orientation query,
2026-07-29; recorded as literals in the test): bioguide `'Onder, Robert F.'` (O000177, zero
evidence), openstates `'Bob Onder'` (zero evidence), mo_senate `'Bob Onder'`/mo_senate_id `'2'`
(one real `terms` row: mo-legislature/senate/district 2), legiscan `'Robert Onder'`
(legiscan_people_id 16351, zero evidence). All four key to `'onder'`. Only one row carries real
evidence, so every pair is vacuously `compatible` → one clean cluster, all 4 members.
`pickDisplayName` picks the bioguide row (highest priority) and reorders its comma form:
`display_name: 'Robert F. Onder'`, `display_name_source: 'bioguide'` — matches the brief's ruling
exactly (word-reorder of the bioguide row's own printed parts, nothing invented).

**Brown(16)/Brown(26).** Two rows, both surname `'Brown'`, real differing districts (mo_senate_id
`'16'` vs `'26'`, same jurisdiction+chamber) → `evidencePairStatus` = `contradiction` → no union
edge is ever drawn between them → each becomes its own singleton component → **two singletons,
never clustered, never even flagged** (verified against this exact literal test, and separately
against the three real, unrelated live US Senators surnamed Brown — Sherrod/OH, Hank/CO, Scott
P./MA — who are correctly kept as three singletons by the identical rule).

**Same-name, same-seat, non-overlapping eras.** Two synthetic `'Jane Smith'` rows, same
jurisdiction/chamber/district, eras 2001–2005 vs 2018–2022 (both bounded, non-overlapping) →
`ambiguous` → flagged `ambiguous_era`, never auto-linked (could be a re-elected same person or an
unrelated same-named successor; never guessed).

## Live dry-run evidence (read-only; zero writes — migration 0012 confirmed applied and empty)

`npm run link:persons -- --dry-run` against the real 1,576-row table: `clusters: 96, flagged: 12,
alreadyLinked: 0, singletons: 1284`. Member counts add up exactly: 224 (clusters) + 68 (flagged) +
1284 (singletons) = 1576. The real Onder cluster (`0a5acc15…`, `487d4713…`, `70776fb0…`,
`b6a8d7be…` — the exact four live ids) forms correctly as a 4-member cluster. No `brown:`-keyed
cluster exists (0 of them); Brown rows only ever appear inside a `flagged` entry, never a
`clusters` entry.

## Test evidence

`node --test`: **841 passed, 0 failed** (baseline 809 + 32 new). Onder cluster, Brown separation,
and cross-era flagging are each directly asserted in `tests/link-persons-cli.test.js` (see
`clusterLegislators: the real four-Onder rows form ONE cluster…`, `clusterLegislators: Brown(16)
and Brown(26)…`, `clusterLegislators: same name, same seat, non-overlapping eras -> flagged…`),
plus the real three-Brown US Senate case, `already-linked skip` (`partitionByLinkStatus` unit test
+ `runLink` counting `leg-already` correctly), and `dry-run zero-write` (`runLink --dry-run`
asserts the fake client's call log contains zero `insert`/`update` operations at all).

## Concerns

1. **Common-surname flags bridge into large multi-person blobs.** Live dry-run: 12 flags, sizes
   `[3,3,3,4,4,4,4,5,5,5,14,14]` — the two 14-member flags are `brown` and `smith`. This happens
   when several genuinely-unrelated same-surname rows carry *zero* chamber/district evidence at
   all (common for legiscan-only rows with no `terms`/column data) — each bridges vacuously to
   every evidenced row, and once any two evidenced rows in the group really contradict (e.g. three
   different US Senators named Brown, real different states), the whole transitively-connected set
   gets flagged as one blob rather than split into smaller, more actionable groups. This is
   **safe** (nothing is ever wrongly auto-linked — exactly the asymmetric-cost doctrine) but not
   maximally useful for Lance's review queue (Task 2). A tighter algorithm (e.g. clique-partitioning
   the *evidenced* members before deciding where evidence-free members land) could shrink these,
   but it's a real jump in complexity beyond what Task 1's explicit test matrix (Onder cluster,
   Brown(16)/Brown(26) as *two* singletons, cross-era flag) requires — flagging it here rather than
   building it speculatively. Worth Task 2/3 attention if 14-member flags prove unreviewable.
2. **`ambiguous_era` never fires on live data today.** All 12 live flags are `internal_contradiction`
   — MO `terms` rows currently carry null start/end dates almost everywhere, and column-derived
   evidence is always dateless by construction, so era-based ambiguity has no live data to trigger
   on yet. The path is real and unit-tested (synthetic fixture) but unverified against production
   data; worth re-checking once term dates are backfilled.
3. `person_links.evidence`/`identity_flags.evidence` store the full per-member evidence objects
   (`legislatorId, fullName, surnameKeyUsed, sourceKeys, chamberDistrictEra`) — this is verbose but
   matches the brief's "the audit IS the product's trust story" instruction; not trimmed.

## Status

Complete. Task 2 (review-server identity tab) and Task 3 (live run) are next per the plan; this
task performed **zero live writes** (dry-run only, migration 0012 confirmed applied/empty via
read-only orientation queries, cleaned up before commit).

## Fix round 1

**CRITICAL — `evidencePairStatus` conflated "no evidence of overlap" with "no evidence of
non-overlap."** A same-seat evidence pair (same `jurisdiction_id`+`chamber`, matching/unknown
district) whose eras couldn't be concretely compared — because a date was simply *missing*, not
because it was known to overlap — defaulted to `'compatible'`. Live MO `terms` dates are null
almost everywhere and every column-derived evidence entry (`mo_senate_id`/`mo_house_id`) is
null-dated by construction, so this was reachable, not an edge case: a same-surname district
successor could silently auto-link to their predecessor on nothing but a missing date. This is the
5th appearance of this project's cross-era class (after `src/cli/ingest-mo-senate.js`'s
district-reuse bug and migration 0009's fix).

Fixed per the refined ruling: a same-seat pair now only reads `'compatible'` off an
unknown/missing date when the two rows' own printed full names also agree
(`fullNameVariantMatch` — suffix-aware: a suffix printed on only one side doesn't block a match,
but two DIFFERENT printed suffixes, e.g. `'John Duncan Jr.'` vs `'John Duncan Sr.'`, is a positive
disqualifying signal); otherwise `'ambiguous'` (flagged, never linked). Two sides that are BOTH
concretely dated and genuinely overlapping still read `'compatible'` unconditionally (real
corroboration, no gate needed) — the gate applies only to the "can't rule out because a date is
missing" case, and only when a genuine same-seat evidence pair exists to compare (the Onder rows'
own pairs stay vacuous — three of the four carry zero evidence entries at all — so the gate never
engages for them; a broader "any unresolved pair needs a name match" rule was considered and
rejected per the refined ruling, since it would have flooded the queue with legitimate cross-source
clusters exactly like Onder). **Accepted residual, documented in the module comment above
`evidencePairStatus`:** a genuine dynastic succession at the same seat, printed with the identical
full name (no suffix, or a suffix stripped by every source that reached the row), with no dates
recorded anywhere, is still mechanically indistinguishable and still auto-links — `namesMatch` is
true either way. The durable cure is term-date backfill; until then, Lance's review-tab unlink
(Task 2) is the correction path. This is strictly a narrowing of the old false-`'compatible'`
surface, never a widening of it.

New tests (`tests/link-persons-cli.test.js`): `fullNameVariantMatch` unit coverage (exact match,
different given names, suffix-omission-tolerant, same-suffix match, different-suffix disqualify);
`clusterLegislators` — smith-sr/smith-jr (surname-only, dateless, same seat) → flagged; jones-sr
dated + jones-jr dateless, same seat, surname-only → flagged; the accepted-residual case
(identical full name, dateless, same seat) → still compatible/auto-links, locked with a
comment-referencing test; suffix mismatch (`'John Duncan Jr.'`/`'John Duncan Sr.'`) → ambiguous;
an explicit regression test confirming the real four-Onder cluster still auto-links (vacuous
evidence, gate never engages).

**Live re-run (read-only, zero writes) — the delta is the audit of what the old rule would have
wrongly linked:**

| | old (pre-fix) | new (post-fix) | delta |
|---|---|---|---|
| clusters | 96 | 87 | −9 |
| flagged | 12 | 21 | **+9** |
| singletons | 1284 | 1284 | 0 |

Member-count totals still reconcile exactly (206 cluster + 86 flagged + 1284 singleton = 1576,
both before and after). All 9 newly-flagged groups are `reason: 'ambiguous_era'` (0 existed before
the fix; the pre-fix 12 flags were all `'internal_contradiction'`, unaffected by this fix since
that check runs before the dateless gate). The real four-Onder cluster is confirmed still present
and still auto-linked, all 4 members, in the live re-run.

Spot-checked 4 of the 9 newly-caught pairs directly against their evidence (read-only): every one
is a real political-dynasty same-seat succession, previously silently auto-linked, now correctly
flagged —
- `Bayh, Evan` / `Bayh, Birch` — US Senate, IN (father/son, different eras)
- `Chafee, John H.` / `Chafee, Lincoln` — US Senate, RI (father/son, different eras)
- `Humphrey, Hubert H.` / `Humphrey, Muriel` — US Senate, MN (Muriel succeeded Hubert's seat after
  his death — his widow, not the same person)
- `Graham, Darline` / `Graham, Lindsey` — US Senate, SC

This is real, concrete confirmation of the bug the fix closes: all four were wrong-merge risks
under the old rule (same seat, no dates recorded, differing given names) and are now honestly
queued for Lance's review instead of silently linked.

**IMPORTANT — `reorderCommaName` corrupted multi-comma bioguide suffix names.** A three-segment
printed name (`'Duncan, John J., Jr.'` — family, given, suffix) produced `'John J., Jr. Duncan'`
under the original two-way split. Fixed to split on every comma: segment 0 = family, segment 1 =
given, any remaining segments = suffixes, re-appended after the family name with their own comma
(`'John J. Duncan, Jr.'`). The plain two-segment case (`'Onder, Robert F.'` → `'Robert F. Onder'`,
`'Smith, Jane'` → `'Jane Smith'`) is unaffected — regression test added alongside the fix.

**Minors.**
3. `surnameKey`'s doc comment now notes explicitly that the structural surname-derivation fallback
   widens the same-key candidate pool, and that the same-seat/dateless name-variant gate (this fix
   round) is what actually keeps a same-surname-different-person pairing from silently auto-linking
   — not the key itself, which is deliberately permissive.
4. Fixed the stale comment on `legiscanSurname` (`src/adapters/legiscan-identity.js`) — it referred
   to "a future surname-based resolver" as hypothetical; that resolver now exists
   (`src/lib/person-identity.js`'s `surnameKey`, Task 1) and depends on exactly this field, live-
   verified on the real legiscan-sourced Onder row (`surname: 'Onder'`).
5. Ledger note only (no code), added to `.superpowers/sdd/2026-07-29-identity-merge/progress.md`:
   `identity_flags.cluster_key` is deterministic over the candidate id SET, so a later run that
   changes a flagged group's membership produces a NEW cluster_key rather than updating the old
   row — the old flag is orphaned (unresolved, superseded), not merged or retired automatically.
   Not a Task 1 correctness issue (nothing is ever wrongly auto-linked either way), but Task 2/3
   should be aware the queue can accumulate stale, superseded flags across runs.

Full suite: 809 (baseline) → 841 (Task 1) → **853** (fix round 1), all green throughout.

## Fix round 2

**CRITICAL — execution-proven, real wrong merges on the live run.** After Task 1's dry-run report,
a live run was executed (by the controller) and produced real wrong merges, caught by the plan's
own post-run spot-check: `'Symington, Stuart'` (Senate) + `'Symington, James W.'` (House —
father/son, real DATED evidence on both sides, but different chamber); `'Brock Adams'` +
`'Joe Adams'` (different jurisdiction); `'Cora Walker'` + `'Nathan Walker'` (both evidence-free).
Full rollback was executed — all three identity tables emptied, `person_id` nulled, DB restored to
pre-run state.

**Root cause:** fix round 1's full-name-variant gate only applied to the "same-seat, can't rule
out overlap because a date is missing" branch. A pair with NO comparable seat evidence at all —
different chamber, different jurisdiction, or one/both sides entirely evidence-free — skipped
straight to a vacuous `'compatible'` verdict without ever checking names, exactly the plan's own
wording ("candidate pairing on surname/name-variant equality") being read too permissively.

**Ruling implemented (unambiguous form):** a full-name-variant match (given+family — see below) is
now a NECESSARY condition for ANY auto-cluster pair, unconditionally, regardless of chamber,
jurisdiction, era, or whether comparable evidence exists at all. Rebuilt the whole evidence/name
pipeline around one unified outer gate rather than threading name checks through the inner
evidence comparison (round 1's shape):
- `seatEvidencePairStatus`/`rowSeatStatus` (renamed from `evidencePairStatus`/`rowPairStatus`):
  now purely evidence-based, 4-way (`'no-evidence' | 'contradiction' | 'ambiguous' | 'compatible'`)
  — `'no-evidence'` is a NEW, explicit outcome for different-chamber/different-jurisdiction pairs,
  previously folded silently into `'compatible'` (exactly the gap that let Symington through).
- `finalPairStatus`: the single unconditional gate. Hard `'contradiction'` still wins outright
  regardless of names (a recorded, concrete fact beats a name match too). `'no-evidence'` requires
  a full-name-variant match to become `'compatible'`; otherwise `'no-pair'` — the pair simply
  doesn't pair at all (no edge; a bare surname collision is not evidence of shared identity, and
  flagging every one would drown the review queue, per the refined ruling). Real comparable
  evidence (`'ambiguous'`/`'compatible'` from `rowSeatStatus`) downgrades to `'ambiguous'`
  whenever names disagree — affirmative shared-identity evidence with disagreeing names always
  goes to Lance, never silently linked.
- `fullNameVariantMatch`: redefined from "whole normalized string" (round 1) to **given (first
  token) + family (last non-suffix token)**, deliberately ignoring middle names/initials — the
  ruling's own words, "given+family." This is a structural extraction of the row's own printed
  parts, never an invented equivalence, and does NOT bridge nicknames (`'Bob'` never equals
  `'Robert'` — CONTROLLER RULING 3 stands, re-verified). Still suffix-aware per fix round 1.
- `clusterLegislators`: an edge is now blocked by EITHER `'contradiction'` OR `'no-pair'`. The
  transitive-bridge safety net (full pairwise re-scan per component) gained a third failure mode,
  `'internal_no_name_variant'`, alongside `'internal_contradiction'` and `'ambiguous_era'`.
- `auditClusterCoherence` (new, exported, pure): re-verifies independently, off `clusterLegislators`'
  own output, that every member pair of every proposed cluster shares a full-name variant. Wired
  into `runLink`'s report (`coherenceAudit: {ok, violations}`) for BOTH dry-run and live calls, and
  printed by `main()` as a **permanent line in the CLI's dry-run output** — the operator sees it
  before any live run is ever considered, independent of the clustering logic's own guarantee.
- **BELT:** `writeAutoCluster` (`src/cli/link-persons.js`) now validates, structurally, that every
  member pair of a cluster shares a full-name variant BEFORE any write — `ClusterNameVariantViolationError`
  otherwise, writing nothing. This is enforced even though `clusterLegislators`'s own construction
  should make it unreachable — a second, independent layer against a future matcher bug. (The
  review-server link path, Task 2, already requires Lance's own judgment before writing anything,
  so it is exempt by design — the ruling's own words.)

**Consequence for the real four-Onder fixture (now explicitly tested, not assumed):** the four
rows no longer form ONE cluster. `'Bob Onder'` (openstates) literally equals `'Bob Onder'`
(mo_senate) — that pair still clusters. `'Onder, Robert F.'` (bioguide) matches `'Robert Onder'`
(legiscan) on given+family (middle initial `'F.'` ignored) — that pair also clusters. But `'Bob'`
never equals `'Robert'`, so nothing connects the two pairs to each other. Result: **two clean,
safe 2-member clusters**, never one wrongly-bridged 4-member cluster, and never a false flag
either — the honest outcome for what the persisted data actually supports without inventing a
nickname lookup (a future ingestion change persisting a source-printed nickname — the way
`legiscan-identity.js`'s own per-record resolution already does — could reunite these two; out of
scope for the cluster pass itself, and flagged below as a concern for explicit sign-off).

**Tests added** (`tests/link-persons-cli.test.js`): the three real wrong-merge shapes (Symington
cross-chamber/dated, Adams cross-jurisdiction, Walker evidence-free) → each stays two singletons,
never flagged, never clustered; the four-Onder fixture updated to assert the new, correct
two-cluster outcome; the 9→10 dynasty `ambiguous_era` flags still flag (unchanged mechanism, now
reached via the unified gate); the transitive-bridge safety net re-verified with a same-full-name
bridging fixture (still fires, `internal_contradiction`) and a NEW suffix-omission bridging fixture
(`'John Duncan'` bridges `'...Jr.'` and `'...Sr.'` individually without ever making them match each
other — `internal_no_name_variant`); `fullNameVariantMatch`'s given+family (middle-ignored) and
still-no-nickname-table behavior directly; `auditClusterCoherence` unit tests including a
hand-built incoherent cluster bypassing `clusterLegislators` entirely; `writeAutoCluster`'s BELT
throw (`ClusterNameVariantViolationError`, zero writes). 56 tests in this file (was 44); full suite
853 → **912**, all green.

**Live re-run (READ-ONLY dry-run only — no live run; the controller runs live after reviewing
this):**

| | round 1 (96/12/1284) | round 2 (new) | delta |
|---|---|---|---|
| clusters | 96 | **8** | −88 |
| flagged | 12 | **10** | −2 (net; shape changed completely — see below) |
| singletons | 1284 | **1540** | +256 |

Member-count totals reconcile exactly (16 cluster + 20 flagged + 1540 singleton = 1576).
**`coherenceAudit.ok === true`, 0 violations** — the live cluster set is independently confirmed
name-coherent.

The magnitude of the drop (96→8 clusters) is itself the audit of how much the round-1 gap was
actually exploited: nearly every one of the old 96 "clusters" was a bare surname collision with no
real corroborating evidence and non-matching given names — exactly the Symington/Adams/Walker
shape — now correctly recognized as NOT identity evidence and left as singletons. The old 12
`internal_contradiction` flags (including the two 14-member `brown`/`smith` blobs flagged as a
concern in the original Task 1 report) are now **zero** — those blobs were themselves an artifact
of the same vacuous-bridging gap (evidence-free rows silently bridging real contradictions
regardless of name) and have dissolved into correct singletons. All **10** remaining flags are
`ambiguous_era`, spot-checked directly against live evidence, and every one is a genuine political
dynasty at the same seat: Bayh (Evan/Birch, IN), Chafee (John H./Lincoln, RI), Humphrey (Hubert
H./Muriel, MN), Graham (Darline/Lindsey, SC), plus newly-visible (previously buried inside a larger
blob or otherwise unclustered) Allen (Maryon/James B.), Warner (Mark R./John), Murkowski (Frank
H./Lisa), Bennett (Robert F./Wallace F.), Burdick (Jocelyn/Quentin N.), Pryor (David H./Mark L.) —
all real US Senate father/child, spouse, or same-seat-succession pairs. All **8** clusters were
spot-checked and are genuine same-person, same-print-variant matches (e.g. `'Eric Schmitt'` /
`'Schmitt, Eric'`; `'Shalonn "Kiki" Curls'` / `'Shalonn Curls'` — the quoted middle nickname is
naturally ignored by the given+family match key, an emergent, structurally-justified win, not an
invented equivalence) plus the two Onder pairs.

## Concerns (fix round 2)

1. **The real Onder person is now split across two clusters** (bioguide+legiscan vs
   mo_senate+openstates) rather than unified — see "Consequence for the real four-Onder fixture"
   above. This is safe (never a wrong merge) but is a real, honest reduction in linking power
   versus Task 1's original design goal, caused entirely by the lack of any persisted nickname
   data on `legislators` rows. Flagging explicitly for sign-off: closing this gap would require
   either (a) accepting it as a Task 2 manual-link case for Lance, or (b) a future schema/ingestion
   change to persist a source-printed nickname (LegiScan already surfaces one at resolution time;
   it is simply never written to the row today). Not fixed here — fixing it would mean inventing a
   nickname-matching mechanism inside the cluster pass, which is exactly the kind of guess the
   whole doctrine this fix round exists to prevent.
2. **Prior "common-surname blob" concern is resolved as a side effect** — the two 14-member
   `brown`/`smith` blobs flagged as a concern in the original Task 1 report no longer exist; they
   were themselves downstream of the same vacuous-bridging bug fix round 2 closes.
3. Carried over: the accepted residual (fix round 1) — an identical-full-name, no-suffix,
   no-dates-anywhere same-seat succession still auto-links until term-date backfill or a Lance
   unlink. Unaffected by fix round 2 (still requires and gets a full-name-variant match).
4. Carried over: `cluster_key` drift on membership change orphans old flags across re-runs (ledger
   note in `progress.md`, no code change) — Task 2/3 awareness.

Full suite: 809 → 841 → 853 → **912**, all green throughout all three rounds.

## Final wave

Whole-branch final review, 9 confirmed findings. This report covers the 6 items assigned to this
task's owner (3 controller-adjudicated fast-follows — non-transactional sequence, attach-to-
existing, and the unlink-route build-out itself — are ledgered separately, NOT implemented here).
Substantial work landed on this branch between fix round 2 (912/912) and this wave — Task 2 (the
review-tab identity queue + decision routes), and two rounds of a nickname amendment (migration
0013, `src/cli/backfill-nicknames.js`, `clusterLegislators`' pairwise printed-name-set matching,
live backfill of 52 nicknames, and Lance's own live adjudication of the flag queue) — all covered
by their own reports/ledger entries in `progress.md`, not re-documented here; this section covers
only the 6 final-wave items themselves, starting from a 956/956 baseline.

**Item 1 (CRITICAL, `df3487e`) — comma-form suffix defeat.** `normalizePersonName` reordered a
comma-form name on the FIRST comma only, so `'Duncan, John J., Jr.'` carried its suffix
mid-string (`'John J., Jr. Duncan'`) instead of at the true end — `splitGivenFamilySuffix`'s
last-token-only suffix check silently parsed `suffix: null` on BOTH sides of a comma-form Jr./Sr.
pair, so the disqualifier never fired, and a comma-form dynasty pair could have auto-merged
through the matcher, the `writeAutoCluster` BELT, and `auditClusterCoherence` alike (all three
share this one parse). Fixed by extracting the comma-segment split into one shared helper
(`splitCommaNameSegments`) used by both `normalizePersonName` (suffix segments now re-appended at
the true end, space-joined) and `reorderCommaName` (unchanged comma-joined display form) — they had
already drifted apart on this once before. Follow-on fix: `surnameKey`'s fallback used to grab a
bare last token, which would have started picking up the relocated suffix as the "surname" —
switched to `splitGivenFamilySuffix(...).family`. Bundled in the same commit: 2 stale doc-comment
fixes the nickname re-review had noted (a `buildGivenNicknameEquivalence` reference to removed
union-find machinery; "equivalence-rebuild" wording describing a structure that no longer exists)
plus item 6's comment correction (below) and one more staleness caught in passing (the nickname
banner's claim the backfill "has not run live yet" — it has, per `progress.md`).

**Item 6 (comment only, bundled into `df3487e`) — the residual comment's stale correction path.**
The ACCEPTED RESIDUAL comment (above `finalPairStatus`) claimed "Lance's review-tab unlink (Task
2) is the correction path" — no such route exists. Replaced with the honest current state: a
controller-executed SQL runbook (ledgered in `progress.md` — this is literally what corrected
Lance's live Bayh mis-adjudication: person deleted, links deleted, `person_id`s nulled, by hand); a
proper unlink route is a scheduled fast-follow (finding 6's own controller-adjudicated item, not
built here).

**Item 4 / finding 8 (`c2f1da8`) — persist nickname at ingest time.**
`resolveOrCreateLegiscanPerson`'s two insert sites (no_candidate, ambiguous FAIL LOUD) now write
`nickname: legiscanPerson.nickname ?? null` alongside surname/party — dissolves the
backfill-ordering dependency for every NEW row from here on (a fresh LegiScan person with a
printed nickname is immediately visible to the cluster pass; `backfill-nicknames.js` remains the
correction path for rows already ingested before this fix). Real-fixture validation: Libla's real
record prints `nickname:"Doug"` (previously untested) — updated the existing exact-shape
assertion, added one test per insert site plus the absent-on-source null case for both.

**Item 5 / finding 9 (`9852b2f`) — test-honesty lock.** The linker test fake's `select(cols)`
ignored its own `cols` argument and always returned full fixture rows regardless of what was
actually requested — a real regression dropping `nickname` from `loadLegislators`' own SELECT
string would have passed every existing test silently (verified this WAS true by execution).
Fixed: the fake now projects to the caller's actual requested columns, same as a real Supabase
select. Added a `runLink`-level test (through the REAL `loadLegislators` SELECT, not a hand-built
rows array) asserting the `internal_no_name_variant` flag a persisted nickname should produce.
Verified by execution: temporarily stripping `nickname` from the real select string makes this new
test fail loud (wrong cluster/singleton counts) — confirmed, then reverted.

**Item 2 (`4a2d504`) — keep-separate rulings bind the auto path.** Previously, a keep-separate
decision only ever affected that one flag's own future decisions — it had no effect on the next
automated `link-persons` run. If the matcher's own verdict later changed (a newly-backfilled
nickname, a data correction), a pair Lance had explicitly ruled "different people" could silently
auto-cluster on a subsequent run. Fixed in `link-persons.js` (pure DB-shape-adjacent helpers, kept
out of the zero-import matcher): `buildKeepSeparatePairs` scans every `identity_flags` row's
`evidence.resolutions` for `'keep-separate'` entries and builds a Map keyed on every
LEGISLATOR-ID PAIR named — deliberately NOT `cluster_key`, which drifts across runs (the ledgered
`cluster_key`-drift note) and would silently stop protecting the exact pair Lance ruled on.
`applyKeepSeparateRulings` runs immediately after `clusterLegislators`, in both dry-run and live
mode, before `writeAutoCluster` ever sees a cluster: a hit downgrades that cluster to a flag
(reason `'conflicts_with_keep_separate_ruling'`), citing the specific prior ruling
(flagId/note/decidedAt/the exact pair) in the new flag's evidence. Test proves the headline
scenario end-to-end: a same-full-name dateless pair (the accepted-residual shape that WOULD
auto-cluster on its own, verified by a sanity check against the identical fixture without the
ruling) instead flags with Lance's ruling cited, live writes untouched for both legislators.

**Item 3 (`bd4d10c`) — TOCTOU guard on the identity link decision route.** The `'link'` decision
route validated every selected legislator's `person_id` against a SELECT snapshot, then wrote
unconditionally — a concurrent request (double-submit, or two admins on the same flag) landing in
the gap could link a row to a different person unnoticed, or collide on `person_links`' own
`unique(legislator_id)` constraint and surface as a raw 500. Fixed: the `legislators` update is now
guarded at write time too (`.eq('id', row.id).is('person_id', null).select('id')`) — zero affected
rows means a concurrent writer won the race, not just failed the earlier read; a `person_links`
23505 (the same race caught one step later) maps to the same path. Both throw the new
`PersonLinkRaceError`, mapped to 409 (never 500). If detected before any member of this decision
has actually linked, the just-created orphaned `persons` row is deleted; if an earlier member
already linked for real, that stays — an honest partial state, never silently undone.
`link-persons.js`'s `isUniqueViolation` is now exported and reused here instead of a private
duplicate. `page.html`: `postIdentityDecision` disables both decision buttons for the duration of
an in-flight request (restored via a `finally` block, correct on both success and failure paths) —
the cheap client-side line of defense the server-side guard is the durable backstop for. Tests:
three double-submit interleave scenarios against a fake simulating a concurrent writer winning the
race mid-request (second member races — partial link stays, person not deleted; first/only member
races — person is deleted; `person_links` race — maps to 409); two jsdom tests against the real
shipped script proving button-disable/restore on both success and failure paths.

**Test summary:** 956 → 962 (item 1) → 965 (item 4) → 966 (item 5) → 973 (item 2) → **978** (item
3), all green throughout. `node --test`: 978/978.

**Concerns (final wave).**
1. The 3 controller-adjudicated fast-follows (non-transactional sequence, attach-to-existing,
   unlink route) remain open, ledgered, not implemented in this task.
2. Item 2's keep-separate binding checks pairs from `evidence.resolutions` across ALL
   `identity_flags` rows (not just resolved ones) — correct per the current data model (a
   keep-separate resolution only ever exists on an already-resolved flag, verified from
   `server.js`'s own `handleIdentityDecision`), but relies on that invariant holding; if a future
   change ever let a keep-separate resolution land on a still-open flag, this would still find it
   correctly (no filter excludes it), so the invariant isn't load-bearing for correctness, only
   documented as the reason no `resolved`-filter was added.
3. Item 3's TOCTOU fix is scoped to the identity `'link'` decision route specifically (per the
   finding); the summary/glossary decision routes were not audited for the same class of race in
   this wave.
