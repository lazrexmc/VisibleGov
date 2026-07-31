# Task 4 report — `src/adapters/mo-senate-journal-pdf.js` (multi-vote journal parser + reconcile gate + resolution)

## Files

- **Created:** `src/adapters/mo-senate-journal-pdf.js` (325 lines) — `JournalParseError`,
  `extractJournalText`, `extractBillRefs` (exported bonus, used internally by the parser and unit
  tested directly), `parseJournalVotes`, `resolveMoSenator`.
- **Created:** `tests/mo-senate-journal-pdf.test.js` (42 tests, all against real fixtures except a
  handful of documented synthetic edge cases).
- **Not touched:** `src/cli/*`, `src/lib/db.js`, `package.json` (no new dependencies), any other
  adapter file.

## Extraction order decision (empirical, not assumed)

**Coordinate-based row reconstruction is REQUIRED** for these journal PDFs — ported verbatim from
`mo-rollcall-pdf.js`'s `reconstructPageText` (group text items into rows by descending y, sort each
row left-to-right by x). This is the opposite finding from `mo-rollcall-pdf.js`'s own grid PDF,
where plain stream-order concatenation happened to already match reading order.

Evidence (measured before writing any parsing logic, by counting occurrences of the anchor phrase
`by the following vote:`, tolerant of an internal line-wrap, under both extraction strategies
against both real fixtures):

| Fixture | Coordinate reconstruction | Plain stream order | Known ground truth |
|---|---|---|---|
| 2018 Day 37 | 13 anchors found | 9 anchors found | 13 votes |
| 2026 Day 39 | 11 anchors found | 9 anchors found | 11 votes |

Plain stream order silently drops 4 of 13 (Day 37) and 2 of 11 (Day 39) anchor matches — the
underlying content stream interleaves some text items out of visual order, splitting "following"
and "vote" apart. This is documented as a comment directly above `reconstructPageText` in the
source.

## Real-fixture numbers (both fixtures parse to 0 failures)

**2018 Day 37 — 13/13 blocks parse, 0 failures.** AbsentWithLeave is `Kehoe, Sater` (count 2) in
every block; Vacancies is 1 in every block (matches task-1's independent 31+2+1=34 attendance
cross-check).

| Ord | bill_refs | yeas | nays | absent |
|---|---|---|---|---|
| 1 | SB 632, SB 675 | 28 | 3 | 0 |
| 2 | SB 882 | 30 | 0 | 1 |
| 3 | SB 600 | 28 | 3 | 0 |
| 4 | SB 793 | 31 | 0 | 0 |
| 5 | SB 881 | 31 | 0 | 0 |
| 6 | SB 894, SB 921 | 31 | 0 | 0 |
| 7 | SB 592 | 25 | 6 | 0 |
| 8 | SB 627, SB 925 | 24 | 7 | 0 |
| 9 | SB 683 | 31 | 0 | 0 |
| 10 | SB 768 | 23 | 8 | 0 |
| 11 | SB 631 | 30 | 0 | 1 |
| 12 | SB 946, SB 947 | 30 | 0 | 1 |
| 13 | SB 819 | 30 | 0 | 1 |

Block 6 (SBs 894 & 921) — the brief's named test case — has Onder in `yeas`, `bill_refs = ['SB 894',
'SB 921']`, motion verbatim: `"On motion of Senator Libla, SS for SCS for SBs 894 and 921 was read
the 3rd time and passed by the following vote:"` (real separator is `"and"`, not `"&"` — the
brief's `&` example is illustrative, not literal to this fixture).

**2026 Day 39 — 11/11 blocks parse, 0 failures** (CONTROLLER RULING 1's exact ground truth: 10
third-reading passages + 1 emergency-clause adoption). AbsentWithLeave is `Roberts` (count 1) in
every block; Vacancies is 0 (`—None`) in every block.

| Ord | bill_refs | yeas | nays | absent |
|---|---|---|---|---|
| 1 | SB 834 | 32 | 0 | 1 |
| 2 | SB 1119 | 24 | 8 | 1 |
| 3 | SB 1383 | 31 | 1 | 1 |
| 4 | SB 959 | 32 | 0 | 1 |
| 5 | SB 907, SB 1154, SB 1272 | 32 | 0 | 1 |
| 6 | SB 1066, SB 1088 | 30 | 3 | 0 |
| 7 | SJR 87 | 24 | 7 | 2 |
| 8 | SB 1421 | 33 | 0 | 0 |
| 9 | **[]** (emergency clause) | 33 | 0 | 0 |
| 10 | SB 945 | 28 | 5 | 0 |
| 11 | SB 1015 | 33 | 0 | 0 |

Block 9's motion is exactly `"The emergency clause was adopted by the following vote:"` — no bill
token at all, so `bill_refs = []` (mechanical extraction, never forced non-empty). Block 1's yeas
contains the district-suffix collisions as distinct tokens: `{surname:'Brown',district:'16'}`,
`{surname:'Brown',district:'26'}`, `{surname:'Gregory',district:'15'}`,
`{surname:'Gregory',district:'21'}`.

## A real bug found and fixed via the Day 37 fixture (not hypothetical)

First run against real text: Day 37 came back **12 votes, 1 failure** — block 4 (SB 793) reported
"parsed yeas count (35) does not reconcile with the printed count (31)". Root cause: that block's
YEAS list wraps across a page boundary, and the reconstructed text literally reads `"...Riddle
Rizzo\n\nThirty-Seventh Day—Thursday, March 8, 2018 591\nRomine Rowden..."` — the page's running
header/footer chrome landed mid-list and tokenized as 4 bogus surnames (Thirty-Seventh, Day,
Thursday, March — exactly 31+4=35). Fixed by adding `stripPageChrome()` inside
`extractJournalText`, stripping (globally, before any parsing): bare page-number-only lines,
`"Journal of the Senate"` headers/footers (including the page-number-glued variant
`"588Journal of the Senate"`), and `"<Ordinal> Day<dash><Weekday>, <Month> <D>, <Year>"` running
headers (both the 2018 em-dash-tight style and the 2026 hyphen-with-spaces style). After the fix,
Day 37 is 13/13, 0 failures. `stripPageChrome` is internal (not exported) — not in the brief's
interface list, but necessary for correctness; it wasn't discoverable without running the real
parser against the real fixture.

## Test results

`node --test` (bare, no flags): **486 tests, 486 passing, 0 failing** (444 baseline + 42 new in
`tests/mo-senate-journal-pdf.test.js`). Full suite confirmed green, not just the new file.

New-file coverage: `extractJournalText` (3), `parseJournalVotes` against the real Day 37 fixture
(13-block count/ordinals/full-shape-deepEqual on the SBs-894-&-921 block/reconcile-across-all-13/
AbsentWithLeave-ground-truth/singular-category/`—None`-category/bill-ref-separator-variety) (11),
`parseJournalVotes` against the real Day 39 fixture (block count/reconcile-across-all-11/emergency-
clause-zero-bill-refs/3-bill-Oxford-comma/district-suffix-collisions/SJR) (6), the real-fixture
corruption test (1, surgical single-name removal scoped to one block's own YEAS span via
marker-bounded slicing, never a blind global replace since several blocks share near-identical
rosters), synthetic edge cases (anchor line-wrap, all-`—None` block, one-bad-block-among-good-
blocks, missing-category-header, empty document, `JournalParseError` shape) (6), `extractBillRefs`
unit tests including two real substrings pulled verbatim from the fixture's SECOND READING lists
(7), `resolveMoSenator` (9), one end-to-end resolution test against real Day 39 tokens (1).

## Concerns / documented deviations

1. **`resolveMoSenator` signature deviates from the brief's literal ASCII sketch**
   (`resolveMoSenator(surname, roster)`). Implemented as `resolveMoSenator(nameToken, roster)`
   where `nameToken = { surname, district }` — required by CONTROLLER RULING 2's explicit
   "resolveMoSenator gains the House's two-branch logic" (district-aware matching needs district
   info per call, which a bare surname string can't carry). This exactly mirrors
   `mo-rollcall-pdf.js`'s `resolveMoRep(cast, roster)`, whose first argument is likewise the whole
   token, not a bare string. Documented in a code comment at the function and reiterated here per
   the task's report instructions.
2. **Vote-array elements are `{ surname, district }` objects, not bare strings** — the brief's
   Task-4-section interface comment says "arrays of bare surnames as printed," but CONTROLLER
   RULING 2 explicitly says the token is "carried as `{ surname, district }`." Went with the
   ruling (binding, appended later) over the earlier section's shorthand comment; the two aren't
   reconcilable as literally-bare-strings once district disambiguation is required.
3. **`tallies` only carries `{ yeas, nays, absent }`**, per the literal type in the brief, even
   though Absent-with-leave and Vacancies also print — and are reconciled against — their own
   counts. Those counts are enforced by the reconcile gate (a mismatch still throws) but not
   surfaced in the returned `tallies` object, matching the brief's exact signature rather than
   extending it.
4. `extractBillRefs` is exported even though it wasn't in Task 4's original interface list —
   useful and independently testable, used internally by `parseVoteBlock`; a strictly additive,
   low-risk export.
5. No fetch function or `SOURCE` export in this module — Task 3's `mo-senate-web.js` already
   exports `fetchSenateJournalPdf` for this exact PDF type, and Task 4's interface list doesn't
   request a duplicate. Consistent with the task's "no network, parser + resolver only" hard rule.

## Verification

`node --test` run from repo root, no path argument (per PLAYBOOK_DELTA note that a directory arg
breaks default discovery on Node 24 Windows): 486/486 passing, 0 failures, 0 skipped.

## Fix round 1 (code review: 2 Important + 1 Minor)

**Finding 1 (Important) — `stripPageChrome`'s bare-digit stripper was content-blind.** Fixed by
context-anchoring: a digits-only line is now stripped ONLY when its nearest non-blank neighbor
(checked on both sides, skipping the blank page-join line) is itself a `JOURNAL_HEADER_RE` or
`DAY_HEADER_RE` match — never by shape alone. Added the explicit invariant comment the finding
requested ("chrome stripping must be provably unable to match vote content"). Verified the
adjacency actually holds for both real fixtures' only two bare-digit-only lines (Day 37's `'587'`,
next non-blank neighbor `'588Journal of the Senate'`; Day 39's `'772'`, next non-blank neighbor
`'773 Thirty-Ninth Day - Wednesday, March 25, 2026'`) before relying on it. `stripPageChrome` is
now exported (same low-risk-additive-export rationale as `extractBillRefs`) so its adjacency logic
is directly unit-testable without a real PDF. New tests (4): real chrome adjacent to a
`Journal of the Senate` header still stripped; real chrome adjacent to a day-header still stripped;
an isolated digit with no chrome neighbor survives; an end-to-end `parseJournalVotes` case where an
isolated count digit (simulating a page break landing between the em-dash and the digit) still
reconciles correctly.

**A second real, pre-existing bug surfaced while writing that second test**: `DAY_HEADER_RE`
required the dash to sit immediately against `"Day"` with no space (`Day[—-]`), matching the 2018
fixture's em-dash-tight style (`"...DAY—THURSDAY..."`) but silently failing to match the 2026
fixture's hyphen-with-spaces style (`"...Day - Wednesday..."`). This was in the original
implementation, not introduced by the finding-1 fix — it just had never been exercised by a test
that isolated the 2026 header shape on its own. Fixed (`Day\s*[—-]`) and both fixtures'
`extractJournalText` output re-verified unchanged (Day 37 still 13/13, Day 39 still 10 votes + 1
failure — see finding 2 below for why 10, not 11).

**Finding 2 (Important) — `extractMotionSentence`'s period boundary had no gate, and nothing
validated the result.** Checked for a real risk pattern first: bill-description prose in both real
fixtures spells `"RSMo,"` with a comma, never a period — an earlier draft comment in the source
incorrectly claimed `"RSMo."` as an example; corrected. No real dotted token precedes any of the 24
real motion sentences in either fixture, so there was nothing concrete to special-case. Implemented
the ruling's load-bearing fix instead: `parseVoteBlock` now calls `requireBillRefs(motion, ordinal)`
first, which throws `JournalParseError` (caught into `failures`, never `votes`) when
`extractBillRefs(motion)` returns `[]`, with `category: 'bill_refs'` and
`reason: 'no bill reference found in motion - needs human review'`.

**Concrete effect on the real Day 39 fixture**: the emergency-clause-adoption block (ordinal 9,
motion `"The emergency clause was adopted by the following vote:"`, no bill token anywhere in that
sentence) now lands in `failures`, not `votes`. **Day 39 is therefore 10 votes + 1 failure**, not
11 votes + 0 failures as reported in the original submission — the 11-block ground truth from
CONTROLLER RULING 1 is still fully accounted for (`votes.length + failures.length === 11`), just
split across the two arrays as the ruling requires. Day 37 is unaffected (all 13 real blocks have
at least one bill reference).

New tests (2, both required by the finding): (a) a synthetic motion with an internal period BEFORE
the bill reference (`"On motion of Sen. Test, SB 400 was read..."`) proves the boundary heuristic
IS imperfect — `motion` really does truncate to start after `"Sen."` — but `bill_refs` still comes
out correct (`['SB 400']`) because the reference sits after the false boundary, not before it; (b)
a synthetic genuinely bill-less motion lands in `failures` with the exact reason string. Plus the
Day 39 real-fixture test was rewritten to assert the new split explicitly.

**Minor 3** — added the two-word-surname caveat (House's `FOUNTAIN HENDERS`/`WALSH MOORE` gap,
`mo-rollcall-pdf.js`'s `CAST_RE` comment) as a comment directly on `NAME_TOKEN_RE`, noting it's not
observed in either Senate fixture and would fail the reconcile gate loudly (not silently) if it
ever occurred.

**Final numbers after fix round 1**: `node --test`, no path argument: **492/492 passing, 0
failures** (444 original baseline + 48 in `tests/mo-senate-journal-pdf.test.js`, up from 42 — 6 new
tests for findings 1 and 2 combined, plus the day-header bug fix). Day 37: 13 votes, 0 failures.
Day 39: 10 votes, 1 failure (ordinal 9, category `bill_refs`).

## Fix round 2 (controller ruling: emergency-clause votes must not permanently fail)

**The ruling**: round 1's blanket zero-bill-refs-fails-loud gate had an unintended consequence -
Day 39's real emergency-clause-adoption block (ordinal 9) now permanently failed, and since every
emergency-clause bill gets a genuine recorded EC vote, a day containing one would never satisfy
Task 5's planned day-completeness rule. The controller ruled this a real product gap: the journal
DOES print the attribution mechanically (via context, not the EC motion sentence itself), so
reading it is not a guess and round 1's gate was too blunt for this one specific, real,
structurally-recognizable case.

**Verified the ruling's own example phrasing against real bytes first** (same discipline as round
1's "RSMo." correction) - `'SB 1421, with SCS, was taken up by Senator X'` does **not** appear in
either real fixture. Grepped every `"taken up"` occurrence in both (36 total across the two
fixtures - see the full context dump in this task's working notes) and confirmed: every real
"taken up" sentence is bare (`"Was taken up."`, `"Was taken up by Senator Dixon."`, `"Was called
from the Consent Calendar and taken up."`) - none of them name a bill. The bill name sits in an
EARLIER, separate run of text (`'<bill ref>[, introduced by Senator X][, with SCS], entitled:'`
followed by the bill's title block and its own `'An Act ...'` description) - **two** real sentences
separate "taken up" from the bill name, not one. A first implementation attempt reused
`extractMotionSentence`'s single-period lookback from the "taken up" occurrence and got only `"Was
taken up."` back (still zero bill refs) - caught immediately by running it against the real Day 39
fixture, not asserted correct a priori. Corrected to a direct backward scan for the nearest
`BILL_TOKEN_RE` match before the "taken up" occurrence (`nearestBillRefBefore`, bounded below by the
start of the preceding vote block's own motion-preamble region - two anchors back - so a stale,
unrelated bill from earlier in the day can never be picked up by accident), which correctly
resolves `SS for SB 1421` -> `SB 1421`.

**Implementation** (`resolveBillAttribution` in `src/adapters/mo-senate-journal-pdf.js`, called from
`parseJournalVotes` before `parseVoteBlock`): for a motion yielding zero bill_refs, if it matches
`/emergency\s+clause/i`, look backward for the nearest `"taken up"` occurrence, then the nearest
bill token before THAT; if the immediately preceding vote block exists (its own ordinal is exactly
`ordinal - 1`), cross-check its `bill_refs[0]` against the taken-up-derived ref - any disagreement
throws, naming both values. Any OTHER zero-ref motion (not matching `/emergency\s+clause/i`) still
gets round 1's unchanged behavior: a typed failure with the human-review reason. Every vote object
now carries a new `attribution: 'motion' | 'preceding_taken_up'` field; `motion` itself is never
edited - attribution provenance lives entirely in the new field.

**Real-fixture ground truth after this fix** (all asserted in tests): **Day 39 = 11 votes, 0
failures** - the EC block (ordinal 9) has `bill_refs: ['SB 1421']`, `attribution:
'preceding_taken_up'`, motion still verbatim `"The emergency clause was adopted by the following
vote:"`. Cross-checked against SB 1421's own passage vote (ordinal 8), which independently has
`bill_refs[0] === 'SB 1421'` - the two sources agree on the real fixture, not just individually
non-empty. **Day 37 = 13 votes, 0 failures, all `attribution: 'motion'`** (no emergency-clause
continuations exist in that fixture).

New tests (6): (a)+(b) real Day 39 - 11/0 split with attribution field validity, and the EC block's
exact bill_refs/attribution/verbatim-motion plus the cross-check against ordinal 8; (c) real Day 37
- all votes `attribution: 'motion'`; (d) synthetic - an EC block with NO preceding `"taken up"` line
anywhere in the text still fails loud (the fallback is not a silent default); (e) synthetic - an EC
block whose nearest `"taken up"` line names a DIFFERENT bill than the immediately preceding vote
block's primary ref fails loud, naming both values in `takenUpRef`/`precedingVoteRef` meta. The
existing round-1 Day-39 tests were rewritten (10/1 split superseded by 11/0) rather than deleted, so
the git history shows the exact behavior change.

**Final numbers after fix round 2**: `node --test`, no path argument: **496/496 passing, 0
failures** (444 baseline + 52 in `tests/mo-senate-journal-pdf.test.js`, up from 48). Day 37: 13
votes, 0 failures, all `attribution: 'motion'`. Day 39: 11 votes, 0 failures; ordinal 9 (`SB 1421`
emergency clause) is `attribution: 'preceding_taken_up'`, the other 10 are `'motion'`.

## Fix round 3 (controller ruling: the cross-check is required, not optional)

**The gap**: round 2's `resolveBillAttribution` only cross-checked the taken-up-derived bill ref
against the immediately preceding vote block `if (precedingVote)` - i.e. only when one happened to
be available. Two real cases fell through that condition with no independent verification at all:
(1) the immediately preceding block itself FAILED (reconcile mismatch, missing category, etc.), so
`precedingVote` is `null` even though ordinal-1 exists in the text; (2) an emergency-clause block
at ordinal 1 or 2, where there is no real preceding vote (or none has been confirmed yet), and the
backward-scan window (`precedingWindowStart`) would collapse toward document start - a bound that
was structurally incidental (an artifact of `i < 2`) rather than a deliberate, commented decision.
In both cases the single backward scan could in principle still "succeed" (find *a* "taken up" line
and *a* bill reference near it) with nothing independent confirming it found the RIGHT one.

**The fix**: `resolveBillAttribution` now checks `if (!precedingVote)` immediately after confirming
the motion matches `/emergency\s+clause/i` - BEFORE the backward "taken up" scan even runs, since
without a successful preceding vote there is nothing to verify against regardless of what the scan
would find. Throws `JournalParseError` with `category: 'bill_refs'`, `reason: 'emergency-clause
attribution unverifiable - preceding vote block missing or failed'`. The final cross-check
(`precedingVote.bill_refs[0] !== takenUpRefs[0]`) no longer needs its `precedingVote &&` guard,
since by the time it runs `precedingVote` is now guaranteed non-null. The `precedingWindowStart`
computation itself is unchanged (still `i >= 2 ? anchors[i-2]... : 0`), but is now commented
explicitly per the ruling's point 2: the `i < 2` fallback to `0` is safe specifically BECAUSE the
mandatory `precedingVote` check gates it - ordinal 1 always has `precedingVote === null` (fails
before the scan runs at all), and ordinal 2's wide-open window is only ever consulted when block 1
already parsed successfully, so block 1's own `bill_refs[0]` still cross-checks whatever that wide
window finds.

**Real-fixture ground truth unchanged**: Day 37 = 13 votes, 0 failures. Day 39 = 11 votes, 0
failures; ordinal 9 = `SB 1421`, `attribution: 'preceding_taken_up'`, cross-checked against ordinal
8. Neither fixture has an EC block with a failed or missing preceding vote, so round 3 changes no
real-fixture outcome - it only closes an untested gap in synthetic/hypothetical input.

New tests (2, both required by the ruling): (a) an EC block whose immediately preceding block
FAILS a reconcile check (doctored Absent-with-leave count) - even though a genuine "taken up" line
and bill reference both still exist nearby in the raw text, the EC block now fails with the
unverifiable reason rather than attributing off the single unconfirmed scan; (b) an EC block as the
very first block in the day (ordinal 1) - even with a "taken up" phrase and bill reference
deliberately placed in the preceding prose, the block fails immediately (no preceding vote can
exist at ordinal 1 by construction) rather than ever reaching the scan.

**Final numbers after fix round 3**: `node --test`, no path argument: **498/498 passing, 0
failures** (444 baseline + 54 in `tests/mo-senate-journal-pdf.test.js`, up from 52). Day 37: 13
votes, 0 failures. Day 39: 11 votes, 0 failures, `SB 1421` emergency-clause attribution unchanged.
