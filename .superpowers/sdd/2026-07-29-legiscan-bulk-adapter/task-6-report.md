# Task 6 report — LegiScan votes/casts (reconcile-or-throw + primary-source cross-check)

Commit: `cc85306` — `feat: legiscan votes/casts - reconcile-or-throw + primary-source cross-check,
collision-safe source_key`

## Module design

New `src/adapters/legiscan-votes.js` (pure logic + one DB-touching function tested with a fake
client), `tests/legiscan-votes.test.js` (29 tests). No live DB writes, no network, anywhere.

### The empirically-derived `VOTE_ID_MAP`

Per CONTROLLER RULING 1 ("derive from vote_text ... do not trust recalled docs"): checked every
single cast's own `vote_id`/`vote_text` pair across **all 8 real roll calls in dataset-2018-1608**
(loaded via Task 4's own `decodeDatasetZip`/`extractDatasetFiles` pipeline, not a parallel raw-JSON
read) **plus** the standalone real `roll-call-747209` fixture (a separate, earlier live capture) —
**1163 real casts total** (1002 across the 8 dataset roll calls + 161 in 747209):

```
VOTE_ID_MAP = { 1: 'yea', 2: 'nay', 3: 'not_voting', 4: 'absent' }
```

`vote_id` 1 -> `vote_text:"Yea"`, 2 -> `"Nay"`, 4 -> `"Absent"` hold with **zero exceptions** across
all 1163 casts (`tests/legiscan-votes.test.js`'s dedicated consistency test asserts this directly,
not just as a side effect of the reconcile gate passing). **`vote_id` 3 ("Not Voting") has NO
example anywhere in this repo's real captured LegiScan data** — its entry in `VOTE_ID_MAP` rests
solely on `docs/research/2026-07-27-mo-data-sources.md` Q2's citation of LegiScan's own
`schema-mysql.sql` (`ls_vote` lookup table), a verified-by-payload *source document*, not on
recalled training-data memory of the API — this gap is documented in the module's header comment,
never papered over with a fabricated test for an unobserved value.

### The dual reconcile gates (CONTROLLER RULING 1)

- **(a) Internal — `reconcileLegiscanTallies(rollCall)`**: maps every cast via `VOTE_ID_MAP`
  (unmapped `vote_id` -> `VoteIdMapError`, immediate, never `'other'`), counts per position, and
  requires counted `yea`/`nay`/`not_voting`/`absent`/**`total`** to equal the roll call's own five
  printed fields exactly, or throws `LegiscanRollCallReconcileError` (an `Error` subclass shaped
  like `mo-rollcall-pdf.js`'s `RollCallParseError`: message + `{ rollCallId, tallies, counted,
  mismatches, castCount }`). Verified `total` is actually checked (not just implied by the other
  four) with a dedicated mutation test that disturbs only `total`.
- **(b) Cross-source — `crossCheckAgainstPrimarySource(client, billId, legiscanTallies)`**: looks
  up an existing primary-source `votes` row by `(jurisdiction_id='mo-legislature', chamber,
  bill_id)` server-side, then filters client-side to rows whose `source_key` starts with a real
  primary-source prefix AND whose `vote_date` falls on the same calendar day as LegiScan's own
  `date` (day-only compare, not a bare `.eq()` timestamptz match, since the two sources don't
  control time-of-day components consistently). Zero matches -> `checked:false` (opportunistic, not
  blocking — most LegiScan-covered sessions have no primary-source counterpart at all). >1 match ->
  ambiguous, a flag row is written (`source_b:'ambiguous'`, `reason:'ambiguous_primary_source_match'`),
  never guessed which one is "right". Exactly 1 match -> its `vote_casts` are aggregated by
  position and compared: `yea`/`nay` category-for-category (both sources map these unambiguously);
  everything else as a **combined** non-yea/non-nay bucket (LegiScan `not_voting+absent` vs primary
  `present+absent+not_voting+other`) — this combined-bucket design is deliberate, see the caveat
  below. A mismatch writes a `vote_reconciliation_flags` row (migration 0010) with both sides'
  tallies, the concrete `mismatches` list, and `PRESENT_CATEGORY_CAVEAT` always attached (not
  conditionally) — `matched:false`, but **the LegiScan vote itself is never touched or quarantined**
  (its own internal gate already passed; directly tested — the fake DB's `votes`/`vote_casts` row
  counts are asserted unchanged after a flagged mismatch).

### Known cross-check caveat, recorded not just implied

LegiScan's `ls_vote` schema has no distinct "Present" `vote_id` (only Yea/Nay/NotVoting/Absent)
while MO House's own roll-call PDFs print a genuine distinct "Present" category
(`mo-rollcall-pdf.js`'s `Y/N/P/@`). A real Present cast on the primary side therefore has no
LegiScan analog and can only ever surface as a disagreement in the combined bucket — which is *not*
necessarily a real data error. Every flag row this function ever writes carries the caveat text
verbatim (`PRESENT_CATEGORY_CAVEAT`, exported so a test — or a future reviewer UI — can assert on
it directly rather than free text). A dedicated test constructs a real-shaped scenario (yea/nay
match exactly, 8 genuine Present + 10 Absent casts on the primary side vs LegiScan's `nv=0,
absent=14`) and confirms the resulting flag's `mismatches` names only the combined bucket, never
`yea`/`nay`, with the caveat attached.

### `buildLegiscanVoteSourceKey` — CONTROLLER RULING 2, a real interface change

The brief's own **non-appended** "Interfaces (Produces)" section (and the plan doc's Task 6
description) proposed a 1-argument `buildLegiscanVoteSourceKey(rollCallId) ->
'legiscan-mo-<roll_call_id>'`. **CONTROLLER RULING 2 (binding, appended) supersedes this**: the
required scheme is `'legiscan-<legiscan_session_id>-rollcall-<roll_call_id>'`, which needs the
session id as a second argument. Implemented as:

```js
buildLegiscanVoteSourceKey(legiscanSessionId, rollCallId)
// buildLegiscanVoteSourceKey(1608, 774312) -> 'legiscan-1608-rollcall-774312'
```

Collision-safety against `/^mo-senate-web-/` / `/^mo-house-xml-/` is directly tested for every one
of the 8 real `roll_call_id`s in the fixture, not just asserted narratively.

### `PRIMARY_SOURCE_KEY_PREFIXES` — corrected against the real driver code

Both the brief's own interface text ("mo-house-xml or mo-senate-journal-pdf source_key prefix") and
the plan doc's Task 6 description name `mo-senate-journal-pdf` as a source_key prefix. **That
string does not appear anywhere in the live code.** Reading `src/cli/ingest-mo-senate.js` directly:
`buildVoteSourceKey(year, pdfBasename, ordinal)` returns
`` `mo-senate-web-${year}-${pdfBasename}-vote${ordinal}` `` — the driver's own `SOURCE` constant is
`'mo-senate-web'`. `mo-senate-journal-pdf.js` is the *parser* module and never builds a source_key
at all (that's the driver's job, same as every other adapter/driver split in this repo). Corrected
here: `PRIMARY_SOURCE_KEY_PREFIXES = ['mo-house-xml-', 'mo-senate-web-']`, with the discrepancy
documented in the module's own comment (verify current state, don't trust a stale doc, per project
convention). A dedicated test confirms `mo-senate-web-*` primary rows are recognized correctly.

### `buildLegiscanVoteCasts` — CONTROLLER RULING 3 (additive export)

Ruling 3 ("Casts resolve via Task 5's mapping ... an unmapped people_id is an unresolved cast
(honest count + sample), never guessed") describes cast-resolution behavior that isn't otherwise
covered by the brief's original 5-item export list, so it's implemented as a small additive export
(same "strictly additive, low-risk export" justification precedent as
`mo-senate-journal-pdf.js`'s `stripPageChrome`/`extractBillRefs`). Deliberately **pure** — takes a
pre-built `Map<people_id, legislator_id>` rather than querying per cast, since by the time a roll
call's casts are built the driver has already run `resolveOrCreateLegiscanPerson` (Task 5) once per
unique `people_id` across the whole session (sponsors + every roll call's voters) and already has
this map in hand; a per-cast DB query would be a real N+1 cost this plan's own 30,000-query/month
budget can't afford. Unresolved casts get an honest `{ count, sample }` (sample capped at 10, same
convention as `ingest-mo-senate.js`'s own `unresolvedSample` slicing).

## Real fixture numbers — all 8 roll calls, dataset-2018-1608

| roll_call_id | bill (LegiScan bill_id) | chamber | date | yea | nay | nv | absent | total |
|---|---|---|---|---|---|---|---|---|
| 774311 | HB 2 (1126109) | house | 2018-09-12 | 141 | 1 | 0 | 14 | 156 |
| 774312 | HB 3 (1126108) | house | 2018-09-12 | 119 | 23 | 0 | 14 | 156 |
| 774313 | HB 3 (1126108) | house | 2018-09-12 | 36 | 92 | 0 | 28 | 156 |
| 774314 | HB 3 (1126108) | house | 2018-09-12 | 33 | 103 | 0 | 20 | 156 |
| 774315 | HB 3 (1126108) | house | 2018-09-12 | 41 | 100 | 0 | 15 | 156 |
| 774316 | HB 3 (1126108) | house | 2018-09-12 | 96 | 38 | 0 | 22 | 156 |
| 774411 | HB 3 (1126108) | senate | 2018-09-14 | 28 | 1 | 0 | 4 | 33 |
| 774412 | HB 2 (1126109) | senate | 2018-09-14 | 29 | 0 | 0 | 4 | 33 |

All 8 reconcile exactly (parsed counts == printed fields, `votes.length == total` in every case).
`nv=0` on all 8 (and on the standalone 747209 fixture) — LegiScan's `not_voting` category is never
actually populated in any real MO payload captured in this repo so far. Bonus real-fixture coverage
(not part of the controller-ruled 8-roll-call test bed, but genuinely real, separately captured
data): roll-call-747209 (House, 2018-05-02, bill_id 1050440) — yea=121, nay=19, nv=0, absent=21,
total=161, 161 casts, also reconciles exactly.

**Finding, not previously documented in this plan**: each bill's own `votes[]` summary array (e.g.
`HB3.json`'s `bill.votes[]`) carries a `url` field per roll call
(`https://legiscan.com/MO/rollcall/HB3/id/774312`) — but the **roll_call payload itself** (the
`vote/774312.json` record `reconcileLegiscanTallies` actually consumes) does **not** carry a `url`
field at all. Task 9's own plan text guesses `roll_call.url` as the `source_url` provenance field —
that guess is wrong; the real `source_url` must come from cross-referencing the bill's `votes[]`
array by `roll_call_id`, not from the roll_call record directly. Flagged here since it affects
Task 9, not this task's own function set.

## Test suite

29 new tests in `tests/legiscan-votes.test.js`, fixture-backed (real dataset-2018-1608 + real
747209) and fake-client (no live DB, no network): `VOTE_ID_MAP` shape + the 1163-cast
vote_id/vote_text consistency proof; `mapLegiscanChamber` (H/S verified-exhaustive against all 8
real roll calls: 6 H, 2 S); `buildLegiscanVoteSourceKey` incl. collision-safety across all 8 real
roll_call_ids; `reconcileLegiscanTallies` passing on all 8 real roll calls + 747209 with their exact
real totals, plus mutation tests (dropped Yea cast, total-only mismatch, synthetic
unrecognized-vote_id-5, cast-order independence); `buildLegiscanVoteCasts` (resolved/unresolved,
10-item sample cap, an end-to-end pass against real roll call 774312's 156 casts); and 11
`crossCheckAgainstPrimarySource` tests (no counterpart, matching tallies, disagreeing tallies with
caveat verification, the Present-category caveat scenario in detail, ambiguous match, wrong-date
non-match, non-primary-source non-match, `mo-senate-web` prefix recognition, migration-0010-missing
graceful degradation, and a genuine DB-error passthrough that must never be swallowed as
`checked:false`).

**Full suite: 737/737 green** (`node --test`, bare invocation) — 708 baseline + 29 new. No live DB
writes, no network calls anywhere in the new code or tests.

## Concerns / forward flags

1. **Task 9's `source_url` guess needs correcting** (see the "Finding" above) — the roll_call
   payload itself has no `url` field; the real per-roll-call URL lives on the parent bill's own
   `votes[]` summary array, keyed by `roll_call_id`. Not a defect in this task's own function set
   (none of Task 6's declared functions build a full `votes` row or touch `source_url`), but
   load-bearing for whoever writes Task 9's driver.
2. **`crossCheckAgainstPrimarySource`'s `billId`/`legiscanTallies.voteId` contract is a documented
   convention, not something the type system enforces.** `billId` must be OUR canonical `bills.id`
   (uuid), and `legiscanTallies` must have a `voteId` (the already-inserted LegiScan `votes.id`)
   attached by the caller before this function runs — `reconcileLegiscanTallies` is pure and can
   never know a DB-generated id itself. This is documented in the module's own comment and exercised
   correctly in every cross-check test, but a future Task 9 driver author needs to read that comment
   rather than infer the contract from the 3-argument signature alone.
3. **The combined non-yea/non-nay bucket comparison is a deliberate design tradeoff**, not the only
   possible one: it avoids manufacturing false mismatches purely from the Present/Absent category
   vocabulary gap, but as a consequence it can only ever flag a real total-count-level disagreement
   between the two sources, not a "6 people classified differently but totals still balance" case.
   Given the caveat is exactly about not over-trusting sub-bucket comparisons here, this was judged
   the more defensible default; flagged in case Lance wants finer-grained (but caveat-noisier)
   comparison later.
4. **`vote_id` 3 ("Not Voting") remains untested against any real payload** — every real MO roll
   call captured in this repo so far (9 total across two separate captures) uses `nv=0`
   universally. `VOTE_ID_MAP`'s `3: 'not_voting'` entry is correct per the cited schema source but
   has zero empirical confirmation; if a future session's dataset ever populates it, worth a
   dedicated real-fixture test at that point rather than assuming today's zero-example gap stays
   permanently unpopulated.

## Fix round 1 (controller ruling)

Commit: `e7c1d33` — `fix: legiscan votes - hard (yea/nay) mismatch quarantines, soft (bucket)
mismatch flags-and-stores`

**The original design deviated from binding ruling 1(b)** ("discrepancy -> the vote quarantined ...
never silently resolved either way") — it flagged every disagreement but never withheld storage.
The controller's fix-round message adjudicated this as a real deviation, but also validated the
Present-category insight as legitimate, and REFINED the ruling rather than restoring it verbatim:
split the comparison into hard (yea/nay) vs soft (the combined present/not_voting/absent bucket)
mismatches, with different consequences for each.

### What changed

- **`compareTalliesForCrossCheck`** now returns `{ hardMismatches, softMismatches }` instead of one
  flat `mismatches` array. `hardMismatches` = yea/nay compared category-for-category (both sources
  define these identically; they determine the vote's outcome and carry the attribution stakes — a
  difference here is never explained away by a category-vocabulary quirk). `softMismatches` = the
  combined non-yea/non-nay bucket (LegiScan `not_voting+absent` vs primary
  `present+absent+not_voting+other`), unchanged in shape from the original design — still folded
  into one value rather than compared sub-bucket-by-sub-bucket, for the same Present-category
  reason as before.
- **`crossCheckAgainstPrimarySource` now returns a fourth field, `quarantine: boolean`**:
  - Any hard mismatch present -> `quarantine:true` — the LegiScan vote/casts must NEVER be stored.
    `votes`/`vote_casts` are anon-readable per migration 0001's RLS policy; possibly-contradicted
    data must never be publicly reachable, mirroring "never store what you can't reconcile" (the
    same rule `reconcileLegiscanTallies` already enforces for gate (a)).
  - Only soft mismatches present (hard mismatches empty) -> `quarantine:false`, vote stores anyway
    — documented as an accounting difference between the two sources' own category vocabularies,
    not a contradiction of the vote's actual outcome, both in a code comment above the branch and
    in the flag row's own `discrepancy.quarantine` field.
  - Ambiguous (>1 primary-source candidate) -> `quarantine:false` — the LegiScan vote is internally
    reconciled (gate (a) already passed) and not contradicted by any SPECIFIC candidate, so it
    stores; the ambiguity itself is durably flagged (`reason: 'ambiguous_cross_reference'`,
    corrected from the original `'ambiguous_primary_source_match'` string to match the ruling's own
    wording) for human review.
  - No primary-source counterpart -> `quarantine:false` (unchanged — "your no-match behavior
    stands").
- **`PRESENT_CATEGORY_CAVEAT` is now attached conditionally**, only when `softMismatches.length >
  0` — a pure yea/nay divergence isn't explained by the category-vocabulary quirk, so attaching the
  caveat there would misleadingly soften what is actually a real, quarantine-worthy contradiction.
  A mixed case (both a hard AND a soft mismatch) still gets the caveat, since the soft piece genuinely
  is part of what's being flagged even though the vote is quarantined for the hard piece
  regardless — verified with a dedicated test.
- **Flag-row `vote_id` attachment changed from the LegiScan vote's id to the PRIMARY-source vote's
  id** — this is a genuine simplification, not just a side effect of the quarantine logic:
  `vote_reconciliation_flags.vote_id` is `NOT NULL references votes(id)`, and a `quarantine:true`
  vote never gets a `votes.id` at all (it's never inserted) — there is no LegiScan-side id to
  reference in that branch. The primary-source vote's id, by contrast, always exists in every
  branch this function reaches (it's the very thing being compared against). This retires the
  original design's requirement that the caller pre-attach `legiscanTallies.voteId` before calling
  this function, which was flagged as concern 2 in the original report — no longer applicable.
  **Flow implication for Task 9** (not built yet, but worth stating explicitly): this function is
  now meant to run BEFORE the driver calls `insertIfAbsent('votes', ...)` for the LegiScan side,
  consulting `quarantine` to decide whether to store at all — not as an after-the-fact audit of an
  already-stored row, which was the original design's implicit ordering.
  In the ambiguous branch specifically, the flag anchors to the first candidate found (an anchor
  point only, never an endorsement of which candidate is "correct" — every candidate's
  `source_key` is still listed in full in `discrepancy.candidate_source_keys`).

### New tests (5 new in `tests/legiscan-votes.test.js`, 31 total, up from 29)

Realistic tally shapes built from real roll call 774312 (house, 2018-09-12, HB 3: yea=119, nay=23,
not_voting=0, absent=14) with one or two primary-source cast counts deliberately altered:
1. **Yea mismatch** (primary yea=115, nay=23 matching, bucket=14 matching) -> `quarantine:true`,
   flag attaches to the primary vote's id, `discrepancy.caveat` is `undefined` (correctly absent —
   nothing soft disagrees), and the fake DB's `votes`/`vote_casts` arrays are asserted unchanged
   (nothing LegiScan-sourced is ever written).
2. **Nay mismatch** (primary nay=25, yea=119 matching, bucket=14 matching) -> same treatment,
   `discrepancy.soft_mismatches` explicitly asserted empty.
3. **Mixed hard+soft mismatch** (yea AND the bucket both disagree) -> still `quarantine:true` (any
   hard mismatch quarantines regardless of what else differs), but `discrepancy.caveat` IS attached
   this time since the soft bucket genuinely is part of the real disagreement.
4. **Bucket-only (soft) mismatch** (the original Present-category scenario, retained and
   re-asserted under the new contract) -> `quarantine:false`, stores, flagged, caveat attached,
   `discrepancy.hard_mismatches` explicitly asserted empty.
5. **Ambiguous** (2 primary-source candidates) -> `quarantine:false`, stores, flagged with
   `reason: 'ambiguous_cross_reference'`, flag's `vote_id` asserted to be one of the two candidates.

Also updated: the migration-0010-missing (gated) test now asserts `result.quarantine` is still
correctly reported even when the flag itself couldn't be durably recorded — "the quarantine
DECISION is independent of whether the flag could be durably recorded" — a gated flags table must
never silently let a contradicted vote through uncaught.

**Full suite: 739/739 green** (`node --test`, bare invocation) — 708 baseline + 31 in
`tests/legiscan-votes.test.js` (29 original + 2 net new after replacing one test with three more
granular ones). No live DB writes, no network calls anywhere in the new or changed code or tests.

## Fix round 2 (review: 1 Important + 2 minors)

Commit: `a53feec` — `fix: legiscan votes - same-day tally disambiguation, per-record vote_text
lock, softened caveat`

### IMPORTANT — same-day multi-roll-call blindness

**The false assumption traced back to the plan's own brief text** ("at most one primary-source
vote per real roll call"), not to anything this task invented — the reviewer traced it to the
fixture's own real pattern: HB 3 has **5 separate real House roll calls, all on 2018-09-12**
(774312-774316, the full 5-amendment perfection sequence + third reading). Fix round 1's
`candidates.length > 1` branch treated every such multi-match as one flat "ambiguous" bucket,
never actually comparing tallies to see if a real correspondence could be established.

**Ruling, implemented as designed**: disambiguate by TALLY IDENTITY — `(yea, nay)`, the two
categories both sources define identically (the same pair `compareTalliesForCrossCheck`'s hard
mismatch already treats as authoritative). The semantics are explicitly built to avoid
circularity — a candidate is never both the thing SELECTED by tally agreement and ALSO reported
as contradicting that same tally:

- **Exactly one candidate's `(yea, nay)` equals LegiScan's** → `matched:true`,
  `reason: 'tally_unique_match'` at the top level (no flag row exists in this branch, so the
  reason has nowhere else to live) — finding that one candidate IS the verification passing, not
  a "pick one, then check" two-step. Stores, no flag.
- **Zero candidates match** → no 1:1 correspondence is mechanically assertable, so no hard
  contradiction is assertable either → stores (internally reconciled by gate (a), uncontradicted
  by anything specific), flags `reason: 'no_tally_corresponding_primary'` in the flag's
  `discrepancy`, listing every same-day candidate's own `(source_key, vote_id, tallies)` for human
  review.
- **More than one candidate matches** → genuinely possible (two same-day procedural votes sharing
  an identical head count, not assumed impossible) — stores, flags
  `reason: 'ambiguous_tally_match'` with just the matching subset listed in
  `discrepancy.matching_candidates`.
- The **existing single-candidate path is completely unchanged** — round 1's semantics (incl.
  hard-mismatch quarantine) still apply there, since a 1:1 correspondence is directly assertable
  without needing tally disambiguation when only one candidate exists at all.

**Quarantine is asserted ONLY where a 1:1 correspondence is assertable** — never in any branch of
the multi-candidate path, even the zero-match case where something on that day demonstrably
disagrees with LegiScan. This is deliberate, not a gap: quarantine requires knowing WHAT is being
contradicted, and a same-day discrepancy this function cannot mechanically pin to one specific row
can only ever cap out at flag-for-human, documented explicitly in the code (both the module header
and the branch's own comment carry this rationale, not just this report).

The flag-writing helper gained a small `primarySourceLabel(sourceKey)` extraction (shared across
all three branches that write a flag against a known candidate/source_key) to avoid duplicating
the prefix-to-label logic three times over.

### MINOR 1 — per-record vote_id↔vote_text runtime lock

`reconcileLegiscanTallies` now also checks, per cast, that a PRESENT `vote_text` matches the
English label `VOTE_ID_MAP`'s own `vote_id` predicts (new shared `VOTE_TEXT_BY_ID` constant —
`{1:'Yea',2:'Nay',3:'Not Voting',4:'Absent'}`, kept as one constant rather than two
independently-hand-maintained copies so the corpus-level test and this runtime check can never
silently drift apart). Absent/empty `vote_text` → no check (never guessed at; some payload shapes
may omit the field). A mismatch throws `VoteIdMapError` naming both the printed and expected text
— reusing the same typed-error class as an unrecognized `vote_id`, since both mean "this cast's
`vote_id` cannot be trusted as printed." This locks, per-record and at runtime, the same guarantee
the corpus-wide test already proves empirically (1163 real casts, zero exceptions) — a future
malformed record would now be caught the moment it's parsed, not just statistically implied by a
one-time historical check.

### MINOR 2 — softened `PRESENT_CATEGORY_CAVEAT`

The reviewer's adversarial case: the original caveat's opening clause read as asserting that a
soft-bucket mismatch IS an accounting difference, when that's only one possible explanation — the
same numeric disagreement can equally be a genuine missing- or extra-voter defect on either side,
which this comparison alone cannot mechanically distinguish from a vocabulary quirk. The caveat
text (and its header comment) now says so explicitly, and points the reader at the raw
`source_a_tallies`/`source_b_tallies` already recorded in every flag row as the actual evidence to
weigh — the caveat clarifies a possibility, it doesn't stand in for that judgment.

### New/changed tests (4 new in `tests/legiscan-votes.test.js`, 35 total, up from 31)

Built from the REAL 5 HB 3 house roll calls' true tallies (774312: 119/23, 774313: 36/92, 774314:
33/103, 774315: 41/100, 774316: 96/38 — all house, all 2018-09-12) via a small
`buildHb3HouseCandidates` test helper:
1. The real pattern itself — LegiScan's real 774312 tallies against all 5 real candidates →
   `tally_unique_match`, `matched:true`, no flag.
2. A doctored zero-match case (LegiScan tallies that match none of the 5) → stored + flagged
   `no_tally_corresponding_primary`, all 5 candidates listed.
3. A doctored two-identical-tallies case (774313's candidate row doctored to also carry 774312's
   real 119/23) → stored + flagged `ambiguous_tally_match`, exactly the 2-item matching subset
   listed.
4. MINOR 1: a mutated `vote_text` (`vote_id:1` but printed `"Nay"` instead of `"Yea"`) → typed
   `VoteIdMapError` naming both the printed and expected text; a companion test confirms
   absent/empty `vote_text` never throws.

**Full suite: 743/743 green** (`node --test`, bare invocation) — 708 baseline + 35 in
`tests/legiscan-votes.test.js`. No live DB writes, no network calls anywhere in the new or changed
code or tests.

## Fix round 3 (re-review — a real regression, caught by execution, not just reading)

Commit: `62f1cf8` — `fix: legiscan votes - tally-unique selection still runs the full soft-bucket
check`

### The regression

Round 2's `tallyMatches.length === 1` branch returned `matched:true, flag:null` the instant
exactly one same-day candidate's `(yea, nay)` matched LegiScan's — it never ran that candidate's
own soft-bucket comparison at all. **The re-reviewer proved this was a real bug by executing it,
not just reading the code**: a uniquely-tally-matched candidate doctored with 500 extra Present
casts (a wildly corrupted bucket, present+absent+not_voting+other = 514 vs LegiScan's own
not_voting+absent = 14) still returned `matched:true` with zero flags — while the exact same degree
of soft-bucket corruption on a SINGLE-candidate day (no disambiguation needed at all) correctly
gets flagged by the single-candidate path's own `compareTalliesForCrossCheck` call. Two paths that
should produce identical behavior on an identical mismatch shape were silently producing different
results — the round-2 comment's claim that tally-uniqueness "IS the verification passing" was
simply wrong, and the re-reviewer named that specific phrase as the inaccurate claim.

### The fix — TALLY-UNIQUE SELECTION IS SELECTION, NOT VERIFICATION

`(yea, nay)` agreement only identifies WHICH same-day candidate corresponds to LegiScan's roll
call — it says nothing about whether the rest of that candidate's own tallies also agree. Once
selected, the candidate now runs through the **exact same `compareTalliesForCrossCheck` call** the
single-candidate path already uses (reused directly, not a second hand-rolled comparison — this
closes the class of bug where two copies of similar logic silently drift apart, which is exactly
what let this regression happen in the first place). Since `tallyMatches` was filtered on
`yea === yea && nay === nay`, `hardMismatches` is provably empty for the selected candidate — but
the code proves this by reusing the shared function and deriving `quarantine` from its actual
output (`hardMismatches.length > 0`), not by hardcoding `quarantine: false` and hoping the
invariant holds forever:

- **Soft-clean** (both hard and soft mismatches empty) → `matched:true`,
  `reason: 'tally_unique_match'`, no flag — the real happy path, unchanged in outcome from round 2
  when the selected candidate genuinely has nothing wrong with it.
- **Soft-mismatch** → `matched:false`, stores (never quarantined for a soft-only mismatch, same
  rule as the single-candidate path), flags with the identical `hard_mismatches`/`soft_mismatches`/
  `caveat` shape the single-candidate path produces, **plus a `note`** documenting that this
  candidate was identified via tally-unique selection among N same-day candidates — so a reviewer
  seeing this flag understands the disambiguation mechanism that picked this specific row, not just
  the bare mismatch.

Both the branch's own comment and the circularity-guard comment immediately above the multi-
candidate loop were rewritten to describe what the code now actually does (the re-reviewer's
specific complaint: "nothing weaker" — it WAS weaker, and the old comment's "verification passing,
nothing to review" language was the inaccurate claim being called out).

### New test

Mirrors the re-reviewer's own control case directly: the 5 real HB 3 house candidates, with 500
extra `present` casts doctored onto the uniquely-tally-matching candidate (774312's mirror). Asserts
`matched:false` (not silently waved through), `quarantine:false` (still a soft-only mismatch —
yea/nay themselves are untouched and still agree exactly), a flag row IS written with
`hard_mismatches: []` and a non-empty `soft_mismatches`, `caveat` equal to
`PRESENT_CATEGORY_CAVEAT`, and a `note` matching `/tally-unique/` and naming the same-day candidate
count. The existing clean-match test (all 5 real HB 3 tallies, no doctoring) stays green unchanged,
confirming the real happy path still behaves identically.

**Full suite: 744/744 green** (`node --test`, bare invocation) — 708 baseline + 36 in
`tests/legiscan-votes.test.js`. No live DB writes, no network calls anywhere in the new or changed
code or tests.
