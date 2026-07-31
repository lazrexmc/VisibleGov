# Final whole-branch review — fix wave report

**Status: COMPLETE.** All 7 confirmed findings fixed, TDD'd, and committed as the brief's three
commits. Branch `profile-completeness`, base `2b95712`.

Full suite: **1208 passing / 0 failing** via bare `node --test` from `F:\VisibleGov`
(baseline was 1180 — 28 tests added, no test removed or weakened).

| Commit | Findings | Files |
| --- | --- | --- |
| `abf53e7` | 1, 2, 3 | `src/cli/link-persons.js`, `src/review/server.js`, +2 test files |
| `8b11785` | 4, 5, 7 | `src/cli/summary-queue.js`, +1 test file |
| `1e5de42` | 6 | `src/lib/errors.js`, `src/cli/enrich-federal-bills.js`, `src/cli/summary-queue.js`, +2 test files |

Every fix followed the required order: the named uncovered test case was written first and watched
fail against the unfixed code, then the code changed. No new dependencies. All multi-row DB reads
still go through `selectAll`.

---

## 1 — CRITICAL — `applyAttachCrossCheck` had no contradiction veto

**Changed.** The demotion path's `personGroupIsCompatible`/`findCompatibleExistingPersons` pair is
gone. Both attach paths now call one shared private helper, `evaluateRowAgainstPerson(row, members,
keepSeparatePairs)`, which returns `{ ruling, contradicted, matchedMembers }` for one candidate row
against one already-linked person. It carries the module's stated doctrine verbatim: surname-key
pre-filter (same permissive gate `clusterLegislators` uses), then a keep-separate check, then
`finalPairStatus` per member — a `'contradiction'` against ANY member vetoes the whole person
outright, `'compatible'` is the only qualifying edge, `'ambiguous'`/`'no-pair'` fall through
silently (fix round 1 CRITICAL 3's tightening, preserved).

`findDemotionTargetPersons` (which replaced `findCompatibleExistingPersons`) aggregates that
verdict across every cluster member for every person and returns only persons that are BOTH
un-vetoed and matched. Deliberately no early break on the first veto, so the reported blocking
ruling is a ruling that actually blocked a person rather than whichever one happened to be scanned
first.

With every matching person vetoed, the cluster falls into `safeClusters` and writes as its own new
person — fail-toward-duplicates, the module's asymmetric-cost rule.

Tests (`tests/link-persons-cli.test.js`): the reviewer's Jane Smith repro as a premise sanity check
on `finalPairStatus`, a unit test on `applyAttachCrossCheck` (which also re-asserts
`buildAttachCandidates`' refusal on the same data, so the fix reads as a parity fix rather than a
new rule), and the end-to-end `runLink` dry-run repro.

## 2 — CRITICAL — `applyAttachCrossCheck` ignored keep-separate rulings

**Changed.** `applyAttachCrossCheck` now takes `keepSeparatePairs` as a fifth parameter and
`runLink` passes the same map it already had in scope. The parameter is deliberately **not**
defaulted: a caller that forgets it throws a `TypeError` loudly rather than silently re-proposing
merges Lance rejected. The five pre-existing 4-arg call sites in the test file were updated to pass
`new Map()` explicitly, matching `buildAttachCandidates`' own convention.

The ruling check is the same `blockedByRuling` lookup the singleton path used, now living inside the
shared `evaluateRowAgainstPerson` — there is no second copy of it. When a demotion still fires for
some other person, the flag carries `keepSeparateRuling` (flagId/clusterKey/note/decidedAt/the exact
pair), the identical citation `applyKeepSeparateRulings` attaches to its own downgrades;
`writeIdentityFlag` already persists that field, so nothing there changed.

Tests: a unit test proving the delta (same cluster demotes without a ruling, does not with one), a
two-person test proving the un-ruled person still demotes AND carries the ruling citation, and the
brief's named case — the existing singleton-suppression scenario arriving as a 2-row cluster.

## 3 — IMPORTANT — keep-separate on an attach flag recorded no durable "X is not P" fact

**Changed, both sides of the round trip.**

`src/review/server.js`: the keep-separate branch now detects an `attach_candidate` flag (via a new
`readExistingPersons(evidence)` helper, which the `attach` branch was also switched to use so the two
can never drift), fetches the target persons' member legislator ids server-side with
`fetchPersonMemberLegislatorIds` — `selectAll` over `legislators` then filter in JS, the same
fetch-all-then-filter convention `handleIdentityQueue` documents, and `legislators.person_id` is the
same authoritative membership column the auto path's `groupAlreadyLinkedByPerson` reads — and writes
an explicit `legislatorIdPairs` array on the resolution: each still-unlinked candidate × each member
of every person the flag named. `legislatorIds` is unchanged (still the honest audit of which
candidates this decision covered), so every existing assertion about it still holds.

`src/cli/link-persons.js`: `buildKeepSeparatePairs` treats an explicit `legislatorIdPairs` list as
**authoritative when present** and skips the cross-product in that case. That is what keeps a
multi-candidate attach flag from mis-recording "A is not B" as a side effect of a decision about P.
A resolution without the field behaves exactly as before.

Tests (`tests/review-logic.test.js`, driven through the real HTTP round trip with the existing
`identityFakeClient`): 1-candidate attach → the candidate×member pairs and nothing from an unrelated
person-Q; multi-candidate → the four candidate×member pairs and explicitly no candidate×candidate
pair; plus a regression test locking the non-attach cross-product. All three assert the round trip
(route writes evidence → `buildKeepSeparatePairs` reads it), which is the actual contract; the test
file now imports that function from the CLI module for exactly that reason.

## 4 — IMPORTANT — record gate bound verdicts to a summary by count only

**Changed.** New exported `validateVerdictBinding(verdicts, whatItDoes)` in `summary-queue.js`,
derived from `VERIFY_SCHEMA` (`VERDICT_FIELDS`/`VERDICT_REQUIRED` read off the schema, not
hand-duplicated — the same anti-drift discipline `validateSummaryShape` applies to
`SUMMARY_SCHEMA`). It checks each verdict's item shape (required fields, no extras, primitive types)
and requires the verdict's `section` to equal the section of the bullet it names.

**One deliberate deviation from the brief's literal wording**, flagged here for review: the brief
wrote `verdicts[i].section === summary.what_it_does[i].section` (array position). The implementation
matches on `bullet_index` instead — `whatItDoes[v.bullet_index].section`. Rationale: `bullet_index`
is the verdict's own claim about which bullet it verified, and `assessVerdicts` has already proven
the indices are a complete, gap-free, in-range bijection onto the bullets, so this is strictly more
correct and reduces to the brief's form whenever the array is in order. Documented in the code.

Any failure routes to `flagDraft` with `overall: 'flagged'` — never publish, never crash — with a
`gateReason` carried on the decision.

Tests: cross-bill section mismatch → flagged; hollow verdict (only `bullet_index` + `supported`,
against a 1-bullet summary so it clears `assessVerdicts` as complete/clean) → flagged; plus a test
that a correctly-bound clean verdict set still publishes.

## 5 — IMPORTANT — `stated_purpose` published with zero verdict coverage

**Changed.** The `bill_texts` select in `classifyRecordItem` now reads `content` alongside
`content_hash` — one query, one hash-pinned row, so the purpose can only ever be checked against the
exact bytes the already-verified hash covers. New exported `checkStatedPurposeGrounding` requires a
non-empty `stated_purpose` to be a substring of that content after collapsing `\s+` → single space
on both sides and nothing else (no case folding, no punctuation smoothing — facts-only). Empty stays
allowed. A row with null/empty content cannot ground a non-empty purpose, so it flags rather than
publishing an unverifiable field.

The ledgered long-title inconsistency is noted in a code comment as expected-to-flag, correct
behavior.

Tests: verbatim substring → publish; paraphrase → flagged with an honest reason; wrapped/indented
stored text still matches (the whitespace-collapse case); empty → publish; null content → flagged.

**Gate reasons are surfaced, not swallowed:** `describeDecision` emits `gate_reason` in the
`--dry-run` preview, `applyRecordDecision` returns it on a `flaggedDraft`, and `main()`'s live path
collects a new `gated` array (bill_id / summary_id / reason) into both the printed JSON and the run
record, with a `gated` count. A mechanical gate whose reason never reaches the operator is a gate
nobody can audit.

## 6 — IMPORTANT — `--limit` failed open silently

**Changed.** New `InvalidFlagValueError` + `parsePositiveIntegerFlag(rawValue, flag)` in
`src/lib/errors.js`. Placed in the shared errors module rather than declared twice because two
copies of the same predicate across two CLIs would eventually disagree on the same input. Guard:
`!Number.isInteger(n) || n < 1`, plus explicit rejection of a missing/blank value (`--limit` with
nothing after it is the same `NaN`). Wired into both `enrich-federal-bills.js` and
`summary-queue.js` `parseArgs`.

Tests in both test files: `--limit 5O` throws (with `err.flag`/`err.value` asserted), `0` / negative
/ fraction / empty / missing all throw, `--limit 12` still parses to `12`.

## 7 — IMPORTANT — newline inside a `what_it_does` point injects extra public bullets

**Changed.** `validateSummaryShape` now rejects `\n` or `\r` in every structural field:
`what_it_does[].point`, `what_it_does[].section`, `stated_purpose`, `referenced_terms[].term` and
`referenced_terms[].citation_raw`. It is a shape failure, so it takes the existing
`MalformedSummaryError` reject path before any DB read. Rejecting rather than escaping or stripping
at render time is deliberate: it keeps the stored fact and the rendered fact identical, which is the
whole premise of the receipts model.

Tests: newline in a point rejected; newline in `stated_purpose` rejected (the forged-block probe);
`\r` and a newline in `section` rejected; `referenced_terms` fields rejected; a clean multi-bullet
summary still passes; and a `classifyRecordItem` test proving the reject fires before any DB call.

---

## Concerns / things Lance should know

1. **Finding 4's binding key is `bullet_index`, not array position** — a conscious, documented
   deviation from the brief's literal wording. See §4 above. If the intent really was positional,
   this is the one line to change.

2. **Finding 5 will flag existing drafts.** This is called out in the brief as correct behavior, but
   it is worth restating operationally: any summary whose `stated_purpose` paraphrases rather than
   quotes the bill will now land as a flagged draft instead of auto-publishing. The gate reason is
   printed per item, so a `--dry-run` over the existing queue will show exactly how many before any
   live run.

3. **Pre-existing record-mode test fixtures were updated, not just added to.** The `bill_texts`
   fixtures in `tests/summary-queue-cli.test.js` previously carried no `content` at all, which under
   finding 5's gate means "we cannot verify this purpose". They now carry a `BILL_TEXT_CONTENT`
   constant that prints `goodSummary`'s `stated_purpose` verbatim, the way a real bill's own purpose
   section would — i.e. the fixtures now represent what a real record item always actually had. No
   assertion was weakened.

4. **`applyAttachCrossCheck`'s arity changed** (4 → 5, no default). Any caller outside this repo
   would break loudly. That is the intended trade: a defaulted empty map would silently restore the
   finding-2 bug.

5. **The cross-check now surname-key-prefilters** person members before comparing, matching
   `buildAttachCandidates` exactly. Previously it compared every cluster member against every
   already-linked member regardless of surname. This is a narrowing, and it fails toward flags/
   duplicates (more clusters stay writable, fewer demotions), never toward merges. It also prevents
   a different-surnamed member's seat contradiction from vetoing a person for no name-related
   reason.

6. **Not changed, still true:** the check-then-act race in `classifyRecordItem`'s
   `alreadySummarized` lookup (already ledgered as accepted — one serial controller session), and
   `identity_flags` still has no unique index on `cluster_key` (the app-level check-then-insert plus
   23505 tolerance remains the only dedup, unchanged by this wave).

---

# Round 2

The scoped re-review confirmed all 7 round-1 findings CLOSED and ruled round-1 concerns 1-4 SOUND,
but found 2 Importants **introduced by the round-1 wave** plus 2 Minors. All 4 fixed.

**Status: COMPLETE.** Full suite **1220 passing / 0 failing** via bare `node --test` from
`F:\VisibleGov` (round-1 baseline 1208 — 12 tests added, none removed or weakened).

| Commit | Items | Files |
| --- | --- | --- |
| `83dec75` | R2-1, R2-2, R2-3 | `src/cli/link-persons.js`, `src/review/server.js`, +2 test files |
| `e2eb637` | R2-4 | 4 files, three bytes each |

## R2-1 — IMPORTANT — keep-separate on a demoted attach flag silently un-blocked the cluster's own merge

**Changed, both sides.** The two attach-flag producers are now distinguishable by an origin marker on
the flag evidence:

- `buildAttachFlags` → `evidence.origin = 'singleton'` — every candidate arrived alone;
  `clusterLegislators` found no same-run partner for any of them, so they were deliberately never
  paired with each other.
- `applyAttachCrossCheck` → `evidence.origin = 'cross_check_demotion'` — the candidates *did* form one
  coherent cluster and only the cross-check pulled them apart to ask about the person.

`writeIdentityFlag` persists it; `runLink`'s dry-run report surfaces it. The server's keep-separate
branch now records candidate x candidate pairs **in addition to** candidate x member pairs for
anything that is not singleton-origin. The controller's adjudication is recorded verbatim in comments
on both sides: on a demoted flag "keep whole flag separate" is genuinely ambiguous between "these are
not P" and "these are all different people", and per the asymmetric-cost law the machine must never
resolve that ambiguity toward a silent merge — the extra pairs keep the cluster in the flag queue,
where Lance decides. Singleton-origin behavior is unchanged; that part of the round-1 fix stands.

**One decision beyond the brief, flagged for review:** a flag carrying **no** origin marker (written
before this existed — possibly already sitting in the live queue) is treated as the demotion case, not
the singleton case. Rationale: an unknown producer might be the demotion one, and only one of the two
possible mistakes is silent. The cost of guessing wrong on a genuinely singleton-origin flag is a
future merge landing in the flag queue instead of auto-linking — benign. There is a dedicated test
naming this default explicitly.

Tests: (a) demoted-flag keep-separate records both pair sets — and, asserted directly rather than
inferred, `findKeepSeparateConflict(['leg-x','leg-y'], pairs)` (the exact lookup the next
`link-persons` run performs) returns a conflict citing Lance's own note; (b) the repro's next-run
shape through real `runLink` — `clusters: 0`, exactly one flag,
`reason: 'conflicts_with_keep_separate_ruling'`, ruling cited; (c) singleton-origin still records no
candidate x candidate pair; plus the unknown-origin default. Note (b) passed pre-fix: the
pair-*consumption* side already worked in round 1, the bug was purely that the pair was never
written. (a) is the test that failed, and its `findKeepSeparateConflict` assertion is what closes the
causal chain between the two.

## R2-2 — IMPORTANT — both attach vetoes were surname-key-scoped

**Changed, once, in the shared helper — so both callers got it.** In `evaluateRowAgainstPerson` the
surname-key prefilter now applies to **match qualification only**; both vetoes (contradiction and
keep-separate ruling) consult **every** member of the person, unfiltered.

The prefilter is a name-shaped heuristic, and a person's own members routinely do not share a surname
key — the reviewer's repro is the real Mary Bono / Mary Bono Mack shape, where `surnameKey` gives
`'bono'` and `'mack'` for two rows of the same person and the differently-keyed row holds the hard
seat fact (CA-44 against the fresh cluster's CA-45). Match qualification keeps the prefilter because
there it is a permissive gate on finding a reason *to* pair — the same role it plays in
`clusterLegislators`' own grouping — not a gate on hearing a reason *not* to.

**This reverses my round-1 concern #5, which was wrong on this point.** I wrote that the prefilter
"prevents a different-surnamed member's seat contradiction from vetoing a person for no name-related
reason". That reasoning does not hold: every member of an already-linked person is by construction the
*same person*, so a seat contradiction against any of them is a fact about that person and needs no
name-based justification at all. `finalPairStatus` already treats a seat contradiction as
unconditional for exactly this reason. The rest of concern #5 stands — the widening produces fewer
suggestions and fewer demotions, i.e. it fails toward flags and duplicate persons.

Tests: the Bono repro vetoed in **both** paths (no attach candidate, no demotion), with premise sanity
checks on `surnameKey` and `finalPairStatus` so the empty results are visibly the veto rather than a
coincidence; plus a ruling recorded against *only* the differently-surnamed member vetoing both paths,
with a no-ruling premise assertion proving the delta.

## R2-3 — MINOR — a missing member row degraded silently

**Changed.** New typed, exported `MissingMemberRowError`. `applyAttachCrossCheck` throws it while
resolving `cluster.memberIds` through `memberRowsById` (naming both the legislator id and the cluster
key — only there are both known), with a backstop `if (!row) throw` inside `evaluateRowAgainstPerson`
itself so neither caller can reach the helper with nothing. Previously `surnameKey(undefined)`
returned `''` and the no-derivable-name branch swallowed the miss, dropping both of that row's vetoes
on the one path whose failure mode is a wrong merge.

## R2-4 — MINOR — UTF-8 BOM

**Changed.** Stripped from `src/cli/link-persons.js`, `tests/link-persons-cli.test.js`,
`tests/summary-queue-cli.test.js`, `tests/enrich-federal-bills-cli.test.js` — introduced by the
round-1 edits going through a PowerShell write path that emits UTF-8 *with* a mark. Byte-level check
after: all four begin with the plain `import` (`105 109 112 111 114 116` = `i m p o r t`). A repo-wide
sweep of `src/`, `tests/` and `supabase/` for `*.js`/`*.json`/`*.md`/`*.sql` found no remaining BOM
anywhere. The diff is three bytes per file; content untouched.

## Round 2 concerns

1. **The unknown-origin default is a judgment call** (see R2-1 above). If Lance would rather have
   legacy attach flags treated as singleton-origin, it is one condition to flip — but it trades a
   benign outcome for a silent one, which is why it went the other way.

2. **Round-1 concern #5 was partly wrong and is now corrected in code** (see R2-2). Worth noting as a
   pattern: I justified a narrowing on name-shaped reasoning in a place where the fact being narrowed
   away was not name-shaped at all. The prefilter is legitimate for "is there a reason to pair these"
   and illegitimate for "is there a reason not to".

3. **`evaluateRowAgainstPerson` now calls `finalPairStatus` against every member of every person**
   rather than the same-surname-key subset. Bounded and cheap at current scale (persons is 7 rows
   live, legislators 1,576, and this runs once per cluster member per person), but it is a real
   widening of the inner loop if `persons` ever grows by orders of magnitude.

4. **Unverified against live data.** Everything above is proven against fixtures and the fake clients
   only — no live DB reads or writes, no model calls, consistent with the standing policies. The
   `--dry-run` over the real queue is still the next step before anything runs live, and R2-1's origin
   marker means existing unresolved attach flags in the live queue will take the unknown-origin path
   described above until they are re-generated by a fresh `link-persons` run.
