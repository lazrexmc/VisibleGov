# Scoped re-review — fix round 1 (da69a44..ed866f6)

ed866f6 fix: mo-2026-session-merge review round — Phase B failure isolation + standalone re-run, delete-ordering tests (TODO 25)

## Stat
 .../sdd/2026-08-01-mo-2026-session-merge/brief.md  |   86 ++
 .../review-package.md                              | 1491 ++++++++++++++++++++
 .../task-review.md                                 |  354 +++++
 src/adapters/legiscan-votes.js                     |    9 +-
 src/cli/correct-data.js                            |  175 ++-
 tests/correct-data.test.js                         |  406 +++++-
 6 files changed, 2491 insertions(+), 30 deletions(-)

## Full diff (-U10)
diff --git a/.superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md b/.superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md
index e49596f..e371874 100644
--- a/.superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md
+++ b/.superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md
@@ -119,10 +119,96 @@ written vs ambiguous/no-match cases), and STOP at dry-run verification. Do not r
   additive-export-only change AND after the new correction lands — verify both checkpoints).
 - Extract the literal `ℹ fail` line yourself; commit ONLY at 0 (lesson 14 — never gate on a
   pipeline's exit status).
 - Commit message explains the defect and the fix, ends with:
 
 Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
 
 Return: status, commit hash, fail-count line verbatim, the FULL `--dry-run` output against the
 real live DB, and concerns — especially anything that surprised you about the live data versus
 what this brief assumed (re-verify, don't trust the brief's specific numbers).
+
+---
+
+## Ledger — review round 1 (SHIP, with required fixes + operator decisions)
+
+Review verdict: MEETS SPEC / GOOD / SHIP. Fail-count verified independently (2131/0). Full
+mechanical re-verification of the deletion safety chain: redirect-before-delete strictly ordered,
+no CASCADE on any bills(id) FK (raced child rows raise 23503, caught not silently lost), session
+delete gated on a LIVE re-count not a cached one, per-bill failure isolation confirmed correct.
+Forbidden-function check independently re-verified (grep, comments only). Ambiguous-case refusal
+confirmed on the real SB 1233 pair. Dry-run re-verified zero writes on 10 tables before/after.
+
+**The 29-vote mystery is SOLVED, not open:** every one of the 29 hard mismatches is the same
+single cause — Sen. Travis Fitzwater's yea vote is present in LegiScan on all 29 roll calls and
+absent from every mo-senate-web cast (a known roster-gating undercount in that pipeline, not a
+new defect). Also surfaced, unprompted: the MO Senate roster is DUPLICATED in `legislators`
+(LegiScan row + mo-senate-web row per senator; one name-variant pair, Mary Coleman / Mary
+Elizabeth Coleman) — cancels out in tally comparisons but is a live identity defect. **New TODO
+item needed** (not scoped to this brief — controller to add after this correction ships).
+
+**Fixing now (fast-follow, same implementer):**
+- Important 2: writeReconciliationFlag throws uncaught mid-Phase-B-loop — one failure loses every
+  remaining flag with no re-run path. Fix: per-vote try/catch (Phase A's own isolation pattern)
+  + a standalone re-run mode for Phase B against already-merged bills.
+- Important 3: no test pins the delete-ordering safety chain directly (order-sensitive redirect-
+  before-delete, forceError on the redirect step specifically).
+- Latent (implementer's call, must be disclosed either way): isPrimaryCastDataComparable gate not
+  reproduced (harmless this batch, 0/29 affected); source_a_tallies from stored casts not printed
+  tallies (fidelity gap vs the live path, currently invisible).
+
+**NOT being fixed here — operator decisions, surfaced not resolved:**
+- Important 1: once bills merge, canonical bill pages will show BOTH votes (LegiScan's + the
+  Senate-journal's) for the same real action, and 29 of 31 pairs actively disagree — this reads
+  as a bug on the public site until Lance's queue clears those 29 flags. Not addressed by this
+  correction; his call whether that's acceptable in the interim.
+- Important 5: root cause unfixed. `ingest-mo-senate.js:472` will recreate the '2026' duplicate
+  session on its next scheduled run — this correction is a one-time fix, not a prevention. A
+  companion fix (resolve onto the canonical session the same way other MO sessions already do,
+  per the LegiScan-pivot Task 9 ruling) is a separate, connected task, not scoped here.
+
+## Ledger — fix round 2 (Important 2 + Important 3 closed, Important 4 folded in)
+
+Both mandatory findings closed, 13 new tests (55/55 in this file, 2144/2144 repo-wide, 0 fail).
+
+- **Important 2 closed two ways.** (a) `writeReconciliationFlag`'s real DB call is now wrapped in a
+  per-vote try/catch inside `reconcileOneVote` — an unexpected failure is recorded as
+  `{reason:'flag_write_failed'}` in `failures` and the loop continues, exactly mirroring Phase A's
+  own per-bill isolation. (b) new `runReconcileMo2026VotesStandalone` (CLI: `mo-2026-vote-reconcile`,
+  also excluded from `all`) re-discovers already-merged mo-senate-web-2026 votes directly by their
+  own `source_key` prefix (`mo-senate-web-2026-*`) rather than depending on Phase A's in-memory
+  merge result — so Phase B can be re-run any time after a live Phase A pass, including after a
+  partial-failure abort. Both share one extracted loop (`reconcileVoteBatch`), never two copies.
+  Re-run safety proven by test: a forced failure on vote 2 of 3 loses nothing for votes 1/3; a
+  clean re-run afterward completes vote 2's flag without duplicating the other two (dedupe via
+  `writeReconciliationFlag`'s own idempotency check, reused unmodified).
+- **Important 3 closed.** New tests prove the delete-ordering chain directly rather than reading
+  it: call-order assertion (redirect UPDATE -> live re-count -> bill DELETE, indices strictly
+  increasing); a simulated race that inserts a vote onto the duplicate bill between redirect and
+  delete is caught by the LIVE re-count, not the update's own stale count
+  (`vote_redirect_incomplete`, bill never deleted); `forceError` specifically on the redirect
+  UPDATE for one bill in a two-bill batch — that bill fails and is never deleted, its sibling
+  merges normally (per-bill isolation on the redirect step, not just the twin/table-check steps
+  already covered). Also closed the cheaper Q9 gaps found while there: `multiple_canonical_twins`,
+  `bill_delete_guard_mismatch` (a bill vanishing between re-count and delete), a failed session
+  bill-recount, a failed session DELETE, and an explicit pin that all four
+  `DUP_BILL_MUST_BE_EMPTY_TABLES` entries (including `bill_actions`) are enforced, not just three.
+- **Important 4 (latent, reviewer's discretion) — folded in, not deferred.** The live path's
+  `isPrimaryCastDataComparable` gate (never hard-flag a primary row whose casts haven't landed
+  yet) is reused here via two newly-exported `legiscan-votes.js` functions
+  (`parsePrimaryResultAggregate`, `isPrimaryCastDataComparable` — pure additive `export`, same
+  pattern as round 1). A gated vote now reports a `not_comparable` outcome, never written as a
+  flag. Live re-verification: `notComparableCount: 0` on the real 31-vote batch — matches the
+  reviewer's own finding, confirms the fold-in is safe and non-disruptive.
+- **Two smaller latent items left as documented residuals** (reviewer's own framing: "not
+  blocking, implementer's call"), explicitly, per that instruction: (1) `source_a_tallies` is
+  derived from LegiScan's stored `vote_casts` rather than the original dataset payload's printed
+  tallies — this backfill only has the DB to work from, not the original LegiScan dataset fetch;
+  re-deriving printed tallies would mean re-fetching LegiScan's archive, outside a DB-only
+  backfill's scope. (2) the discrepancy payload omits the live shape's `quarantine` key — Phase B
+  never quarantines anything (nothing to quarantine, both votes are already stored), so the field
+  would always read `false` and adds no information. Both documented in `correct-data.js`'s own
+  header comment, not silently dropped.
+- **Re-confirmed, explicitly, after this round's changes:** `crossCheckAgainstPrimarySource` and
+  `retractLegiscanVoteIfStored` are still neither imported nor called anywhere in
+  `correct-data.js` — every occurrence is inside a `//` comment. Verified by both a fresh `grep`
+  and the existing regression test (`tests/correct-data.test.js`), which still passes unmodified.
diff --git a/.superpowers/sdd/2026-08-01-mo-2026-session-merge/review-package.md b/.superpowers/sdd/2026-08-01-mo-2026-session-merge/review-package.md
new file mode 100644
index 0000000..f1a350c
--- /dev/null
+++ b/.superpowers/sdd/2026-08-01-mo-2026-session-merge/review-package.md
@@ -0,0 +1,1491 @@
+# Review package — TODO-25 session merge (5ecd938..da69a44)
+
+da69a44 feat: mo-2026-session-merge correction CLI (TODO 25) — built, dry-run-verified against live DB, not run live
+
+## Stat
+ .../sdd/2026-08-01-mo-2026-session-merge/brief.md  | 128 +++++
+ src/adapters/legiscan-votes.js                     |  13 +-
+ src/cli/correct-data.js                            | 539 ++++++++++++++++++++-
+ tests/correct-data.test.js                         | 482 +++++++++++++++++-
+ 4 files changed, 1145 insertions(+), 17 deletions(-)
+
+## Full diff (-U10)
+diff --git a/.superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md b/.superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md
+new file mode 100644
+index 0000000..e49596f
+--- /dev/null
++++ b/.superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md
+@@ -0,0 +1,128 @@
++# Task brief — TODO 25: merge the duplicate MO 2026 session
++
++Approved by Lance (2026-08-01: "make the corrections"), following a full controller investigation
++recorded in this session's transcript. Everything below is VERIFIED against live data, not assumed —
++re-verify at execution time anyway (the DB has grown since; do not hardcode counts).
++
++## The defect
++
++`sessions` has two rows for one real MO 2026 session:
++- `'261'` (canonical): `legiscan_session_id=2239`, LegiScan-sourced, ~3,162 bills.
++- `'2026'` (duplicate): `legiscan_session_id=NULL` — the only MO session missing one — created by
++  `ingest-mo-senate.js:472`'s own `insertIfAbsent` on every Senate-journal run, independent of the
++  LegiScan-sourced row. ~34 bills as of this brief, actively growing.
++
++**Every one of the duplicate's bills already exists under the canonical session by exact identifier
++match** (verified: 34/34 collide, zero exceptions). `bill_texts`, `bill_sponsors`, `summaries` are
++all confirmed at zero on the duplicate side — nothing to redirect there. `votes` is the only table
++with real data hanging off the duplicate bills (31 rows, all `source_key` prefixed `mo-senate-web-`).
++
++## Two separable phases
++
++### Phase A — bill/session merge (mechanical, exact-match only, do this regardless of Phase B)
++
++For each duplicate bill (session `'2026'`):
++1. Find its canonical twin: `bills` row with the SAME `identifier`, `session_id` = the canonical
++   `'261'` row's id. This MUST be an exact string match — if a duplicate bill's identifier has no
++   canonical twin, STOP and report it (do not invent a merge target; do not fall back to creating
++   one). Re-verify live that this is still 34/34 — if it isn't, the fix must still work correctly
++   for whatever the real live set is.
++2. Redirect every `votes.bill_id` pointing at the duplicate bill to the canonical bill's id.
++3. Re-verify LIVE (never trust this brief's counts) that `bill_texts`/`bill_sponsors`/`summaries`
++   are still zero for this duplicate bill_id. If any are non-zero, STOP for that bill and report it
++   — do not silently redirect a table this brief didn't anticipate.
++4. Delete the duplicate bill row ONLY after confirming zero remaining references to its id anywhere
++   you touched (which, at minimum, means the `votes` redirect above completed and step 3's re-check
++   passed).
++5. After all 34 (or however many are live) are merged, delete the now-empty duplicate `'2026'`
++   session row — guarded by an explicit `.eq('id', dupSessionId)` re-check that its bill count is
++   genuinely zero first (never delete a session row that still owns bills).
++
++### Phase B — vote reconciliation (read-only on votes/casts, additive-only on flags, NO deletes)
++
++The 31 redirected votes are almost certainly the same real floor actions LegiScan already recorded
++independently (verified: all 31 share an exact calendar date with an existing LegiScan vote on the
++same now-merged bill; sampled 4 pairs — same real action, near-identical cast counts). This is NOT
++resolved by guessing/deleting — it's resolved by running the SAME reconciliation comparison this
++codebase already built, reviewed, and uses for 17 other open flags right now:
++`crossCheckAgainstPrimarySource` (`src/adapters/legiscan-votes.js`) and its private helpers.
++
++**Reuse, do not reimplement.** Add `export` to these currently-private functions in
++`legiscan-votes.js` (pure additive change — just the keyword, zero behavior change, verify the full
++suite stays green after this alone before writing anything new):
++`summarizePrimaryCastPositions`, `compareTalliesForCrossCheck`, `writeReconciliationFlag`,
++`sameCalendarDate`. `PRIMARY_SOURCE_KEY_PREFIXES` and `buildLegiscanVoteSourceKey` are already
++exported.
++
++**Do NOT call `crossCheckAgainstPrimarySource` itself or `retractLegiscanVoteIfStored`.** The first
++is designed to run BEFORE a LegiScan vote is written (it decides whether to store it); both
++LegiScan votes here are already stored and already public — running the live function against
++already-published data is not the scenario it was built for. The second is this repo's own-
++documented **ONE sanctioned delete, explicitly "never a precedent for a delete anywhere else in
++this repo"** (its own header comment) — Phase B must never invoke it, must never delete or modify
++either vote or its casts, regardless of what the comparison finds. A genuine hard mismatch, if one
++turns up, becomes a flag for Lance — not an automatic retraction. This backfill is a one-off
++comparison, not a live-ingest run, and does not get that function's sanctioned exception.
++
++For each of the (live-verified) redirected `mo-senate-web` votes, now on a merged bill_id:
++1. Find the matching LegiScan vote(s): `votes` where `bill_id` = this vote's (now-merged) bill_id,
++   `jurisdiction_id='mo-legislature'`, same `chamber`, `source_key` starting `'legiscan-'`, and
++   `sameCalendarDate` true against this vote's own `vote_date`. Handle 0 matches (report, no flag —
++   nothing to compare against) and >1 matches (report as ambiguous, same spirit as the live system's
++   own multi-candidate handling — do not guess which one corresponds) honestly; do not silently pick
++   one.
++2. On exactly one match: pull both votes' own `vote_casts`, summarize each via
++   `summarizePrimaryCastPositions` (it's generic over any `position` set, not primary-source-
++   specific — reuse it for the LegiScan side too). Build the `legiscanTallies`-shaped input
++   (`{ tallies: {yea,nay,not_voting,absent}, chamber, date, runId, rollCallId }` — parse
++   `rollCallId` back out of the LegiScan vote's own `source_key`, format
++   `legiscan-<sessionId>-rollcall-<rollCallId>`, matching `buildLegiscanVoteSourceKey`'s own
++   format exactly — never guess it).
++3. Run `compareTalliesForCrossCheck(legiscanTallies, primaryCounts)`.
++4. **Clean match (0 hard, 0 soft mismatches): write NOTHING** — this mirrors
++   `crossCheckAgainstPrimarySource`'s own clean-match branch exactly (`matched:true, flag:null`).
++   Report it as confirmed-same-event for Lance's visibility, no DB write.
++5. **Any mismatch: write a `vote_reconciliation_flags` row** via the reused `writeReconciliationFlag`
++   (idempotent — it already re-checks for an existing identical flag before inserting, do not
++   duplicate that check). `voteId` = the mo-senate-web vote's own id (matches the live system's
++   convention: `vote_id` always points at the PRIMARY-source row). `sourceB = 'mo-senate-web'`.
++   `reason` = `'hard_mismatch'` or `'soft_mismatch'` — reuse the SAME vocabulary the live system
++   uses (the discrepancy shape is identical; inventing a new reason string would fragment reporting
++   that already reads these two values). `discrepancy` shape matches the live system's own
++   (`source_a_tallies`, `source_b_tallies`, `source_b_result`, `source_b_vote_id`,
++   `source_b_source_key`, `hard_mismatches`, `soft_mismatches`, plus `PRESENT_CATEGORY_CAVEAT` when
++   `softMismatches.length > 0` — same field, already exported as a constant).
++
++## CLI shape — fold into `correct-data.js`, matching its existing convention exactly
++
++Add `mo-2026-session-merge` as a third `<which>` value (alongside `mo-status`, `mo-1969-dates`,
++`all` — decide whether this new one joins `all` or stays deliberately excluded from it given its
++higher stakes; lean toward EXCLUDING it from `all` so it always requires being named explicitly,
++and say so in a comment). Same `--dry-run`/`--limit` flag shape, same `openRun`/`closeRun` source
++tagging, same honest-counts-object return shape as `runCorrectMoStatus`/`runCorrectMo1969Dates`.
++
++**This file's own header states the standing convention: "built READY... Lance runs the live pass
++himself — nothing in this repo invokes it live." Follow that convention exactly for this task too**
++— build it, verify thoroughly with `--dry-run` against the real live DB (report the full counts:
++bills merged, votes redirected, session deleted or not, reconciliation clean-matches vs flags
++written vs ambiguous/no-match cases), and STOP at dry-run verification. Do not run it live yourself.
++
++## Constraints
++
++- TDD red-first. Fixture/mock-client tests only — no live DB writes from tests. Given this touches
++  deletes and FK redirects, test the edge cases explicitly: a duplicate bill with no canonical twin
++  (must report, never invent one); a duplicate bill with non-zero bill_texts/sponsors/summaries
++  (must stop and report, never silently redirect); zero/one/multiple reconciliation candidates;
++  the session-delete guard refusing when bills remain.
++- `selectAll` for any multi-row read. Typed errors matching this repo's conventions.
++- Bare `node --test` from repo root; baseline currently 2114, must stay green (both after the
++  additive-export-only change AND after the new correction lands — verify both checkpoints).
++- Extract the literal `ℹ fail` line yourself; commit ONLY at 0 (lesson 14 — never gate on a
++  pipeline's exit status).
++- Commit message explains the defect and the fix, ends with:
++
++Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
++
++Return: status, commit hash, fail-count line verbatim, the FULL `--dry-run` output against the
++real live DB, and concerns — especially anything that surprised you about the live data versus
++what this brief assumed (re-verify, don't trust the brief's specific numbers).
+diff --git a/src/adapters/legiscan-votes.js b/src/adapters/legiscan-votes.js
+index 021c8c7..d09eb19 100644
+--- a/src/adapters/legiscan-votes.js
++++ b/src/adapters/legiscan-votes.js
+@@ -352,37 +352,42 @@ export const PRIMARY_SOURCE_KEY_PREFIXES = ['mo-house-xml-', 'mo-senate-web-'];
+ // (source_a_tallies/source_b_tallies) are the actual evidence a human reviewer should weigh, not
+ // this caveat standing in for that judgment.
+ export const PRESENT_CATEGORY_CAVEAT = 'LegiScan\'s ls_vote schema has no distinct "Present" vote_id '
+   + '(only Yea/Nay/NotVoting/Absent) while MO House\'s own roll-call PDFs print a distinct "Present" '
+   + 'category (Y/N/P/@) — a disagreement in the combined non-yea/non-nay bucket below MAY be that '
+   + 'category-vocabulary difference (an accounting difference, not a contradiction), but it can also '
+   + 'be a genuine missing- or extra-voter defect on either side; this comparison alone cannot tell '
+   + 'the two apart. The raw tallies recorded in this flag are the evidence — check for Present casts '
+   + 'on the primary-source side, but do not assume that alone explains it.';
+ 
+-function sameCalendarDate(a, b) {
++// EXPORTED (2026-08-01, .superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md): this and
++// summarizePrimaryCastPositions/compareTalliesForCrossCheck/writeReconciliationFlag below are the
++// pure-comparison/write helpers correct-data.js's mo-2026-session-merge reconciliation phase
++// reuses directly, rather than re-implementing the same tally/date comparison a second time. Pure
++// additive change — just the `export` keyword, zero behavior change to any existing caller.
++export function sameCalendarDate(a, b) {
+   if (a == null || b == null) return false;
+   return String(a).slice(0, 10) === String(b).slice(0, 10);
+ }
+ 
+ // primarySourceLabel — the flag row's `source_b` value: the matching prefix with its trailing
+ // dash stripped ('mo-house-xml-' -> 'mo-house-xml'), or 'unknown-primary-source' for a source_key
+ // that somehow passed the PRIMARY_SOURCE_KEY_PREFIXES filter but doesn't literally start with
+ // either prefix (defensive — not reachable via this module's own filtering, but a flag row should
+ // never silently mislabel its source if that ever changes). Shared by every branch below that
+ // writes a flag against a specific primary-source candidate.
+ function primarySourceLabel(sourceKey) {
+   const matchedPrefix = PRIMARY_SOURCE_KEY_PREFIXES.find((prefix) => sourceKey.startsWith(prefix));
+   return matchedPrefix ? matchedPrefix.replace(/-$/, '') : 'unknown-primary-source';
+ }
+ 
+-function summarizePrimaryCastPositions(castRows) {
++export function summarizePrimaryCastPositions(castRows) {
+   const counts = {
+     yea: 0, nay: 0, present: 0, absent: 0, not_voting: 0, other: 0,
+   };
+   for (const row of castRows) {
+     const key = Object.prototype.hasOwnProperty.call(counts, row.position) ? row.position : 'other';
+     counts[key] += 1;
+   }
+   return counts;
+ }
+ 
+@@ -425,21 +430,21 @@ function isPrimaryCastDataComparable(aggregate, totalPrimaryCasts) {
+ // deliberately treated differently by the caller:
+ //   - HARD (yea/nay): both sources define these two categories identically and they determine the
+ //     vote's outcome/attribution — a difference here is a REAL divergence, never explained away by
+ //     a category-vocabulary quirk. Compared category-for-category, no caveat attached.
+ //   - SOFT (the combined "non-yea/non-nay" bucket: LegiScan not_voting+absent vs primary
+ //     present+absent+not_voting+other): folded into ONE combined value rather than compared
+ //     sub-bucket-by-sub-bucket, precisely BECAUSE of the Present-category caveat (comparing
+ //     present/absent/not_voting 1:1 would manufacture false mismatches out of a real
+ //     category-vocabulary difference between the two sources, not an actual data disagreement) — an
+ //     accounting difference, not a contradiction (see PRESENT_CATEGORY_CAVEAT above).
+-function compareTalliesForCrossCheck(legiscanTallies, primaryCounts) {
++export function compareTalliesForCrossCheck(legiscanTallies, primaryCounts) {
+   const hardMismatches = [];
+   if (legiscanTallies.tallies.yea !== primaryCounts.yea) {
+     hardMismatches.push(`yea: legiscan ${legiscanTallies.tallies.yea} vs primary ${primaryCounts.yea}`);
+   }
+   if (legiscanTallies.tallies.nay !== primaryCounts.nay) {
+     hardMismatches.push(`nay: legiscan ${legiscanTallies.tallies.nay} vs primary ${primaryCounts.nay}`);
+   }
+ 
+   const softMismatches = [];
+   const legiscanNonVote = legiscanTallies.tallies.not_voting + legiscanTallies.tallies.absent;
+@@ -494,21 +499,21 @@ async function findExistingReconciliationFlag(client, {
+ }
+ 
+ // writeReconciliationFlag — Draft-then-apply degradation (Global Constraints, plan doc): migration
+ // 0010 (vote_reconciliation_flags) is draft-only until Lance applies it. A discrepancy detected
+ // before that point is never silently dropped — it's returned with gated:true and the SAME
+ // discrepancy payload, so a caller can log/report it even though it couldn't be durably recorded
+ // yet; a re-run after the migration lands re-detects and this time persists it. `rollCallId`/
+ // `reason` (both now REQUIRED, every call site below supplies them explicitly) are the idempotency
+ // key described above — stamped onto the stored `discrepancy` itself (`roll_call_id`/`reason`
+ // fields) so the key is self-describing to a human reviewer too, not just an internal lookup detail.
+-async function writeReconciliationFlag(client, {
++export async function writeReconciliationFlag(client, {
+   voteId, sourceB, discrepancy, runId, rollCallId, reason,
+ }) {
+   const keyedDiscrepancy = { ...discrepancy, roll_call_id: rollCallId, reason };
+ 
+   const lookup = await findExistingReconciliationFlag(client, {
+     voteId, sourceA: 'legiscan', sourceB, rollCallId, reason,
+   });
+   if (lookup.existing) {
+     // IDEMPOTENT RE-RUN: the identical discrepancy (same vote, same LegiScan roll call, same
+     // classification) was already durably recorded by a prior run — including if a human has since
+diff --git a/src/cli/correct-data.js b/src/cli/correct-data.js
+index ebe96a7..e652111 100644
+--- a/src/cli/correct-data.js
++++ b/src/cli/correct-data.js
+@@ -1,61 +1,82 @@
+ import {
+-  getClient, openRun, closeRun,
++  getClient, openRun, closeRun, selectAll,
+ } from '../lib/db.js';
+ import { parsePositiveIntegerFlag } from '../lib/errors.js';
+ import { journalPdfBasename } from './ingest-mo-senate.js';
+-import { PRIMARY_SOURCE_KEY_PREFIXES } from '../adapters/legiscan-votes.js';
++import {
++  PRIMARY_SOURCE_KEY_PREFIXES,
++  sameCalendarDate,
++  summarizePrimaryCastPositions,
++  compareTalliesForCrossCheck,
++  writeReconciliationFlag,
++  PRESENT_CATEGORY_CAVEAT,
++} from '../adapters/legiscan-votes.js';
+ 
+-// correct-data — data-correction CLI (.superpowers/sdd/2026-07-31-data-corrections/brief.md).
+-// Two REVERSIBLE production-data corrections (both re-derivable from cached LegiScan datasets /
+-// the primary MO Senate journal source, which is exactly what makes them safe to draft):
++// correct-data — data-correction CLI (.superpowers/sdd/2026-07-31-data-corrections/brief.md,
++// .superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md).
++// THREE REVERSIBLE-OR-CAREFULLY-GUARDED production-data corrections:
+ //   A) mo-status: ~37,662 MO bills whose bills.status is a bare LegiScan numeric lifecycle code
+ //      (ingest-legiscan.js/backfill-mo-bill-meta.js both stored `String(bill.status)` verbatim, by
+ //      design at the time — "no house-style label mapping exists... inventing one would be a
+ //      guess") instead of the printed word LegiScan's OWN manual documents for that code.
+ //   B) mo-1969-dates: 10 `votes` rows carrying LegiScan's own 1969-12-31 missing-date sentinel
+ //      (legiscan-votes.js's LegiscanRollCallDateError header comment names these ten explicitly —
+ //      "stored verbatim, exactly as designed... the correction of the rows already stored is
+ //      Lance-gated and deliberately NOT done here [t]here").
++//   C) mo-2026-session-merge (TODO 25): the MO 2026 session is split across TWO `sessions` rows —
++//      '261' (canonical, LegiScan-sourced) and '2026' (duplicate, legiscan_session_id=NULL, created
++//      by ingest-mo-senate.js's own insertIfAbsent on every Senate-journal run). Phase A merges each
++//      duplicate bill into its exact-identifier canonical twin (redirecting votes, deleting the now-
++//      empty duplicate rows); Phase B reconciles the redirected mo-senate-web votes against LegiScan's
++//      independently-recorded votes on the same now-merged bill, reusing (never reimplementing) the
++//      SAME comparison legiscan-votes.js's crossCheckAgainstPrimarySource already uses for its own
++//      17 live flags. HIGHER STAKES than A/B (deletes + FK redirects, not just in-place rewrites) —
++//      deliberately excluded from `all` below; an operator must name it explicitly.
++//      DOES NOT call crossCheckAgainstPrimarySource itself (that function is the live pre-store
++//      gate — both LegiScan votes here are already stored/public, not the scenario it decides) or
++//      retractLegiscanVoteIfStored (ingest-legiscan.js's own-documented ONE sanctioned delete,
++//      explicitly "never a precedent for a delete anywhere else in this repo") — Phase B only ever
++//      reads votes/casts and additively writes vote_reconciliation_flags rows, never a delete.
+ //
+ // DRAFT-THEN-APPLY (Global Constraints / CLAUDE.md standing policy): this CLI is built READY, with
+ // a real --dry-run, but Lance runs the live pass himself — nothing in this repo invokes it live.
+ //
+ // CLI: `node --env-file=.env src/cli/correct-data.js <which> [--dry-run] [--limit N]`
+-// `<which>` is REQUIRED (mo-status | mo-1969-dates | all) — no default, so an operator can never
+-// accidentally run every correction at once by omitting an argument.
++// `<which>` is REQUIRED (mo-status | mo-1969-dates | mo-2026-session-merge | all) — no default, so
++// an operator can never accidentally run every correction at once by omitting an argument.
+ 
+ const SOURCE = 'correct-data';
+ 
+ // ---- args ----
+ 
+ export function parseArgs(argv) {
+   const out = { dryRun: false, limit: null, which: null };
+   const positionals = [];
+   let i = 0;
+   while (i < argv.length) {
+     const key = argv[i];
+     if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
+     if (key === '--limit') { out.limit = parsePositiveIntegerFlag(argv[i + 1], '--limit'); i += 2; continue; }
+     if (key.startsWith('--')) throw new Error(`unknown flag: ${key}`);
+     positionals.push(key);
+     i += 1;
+   }
+   if (positionals.length !== 1) {
+     throw new Error(
+-      `correct-data: requires exactly one <which> argument (mo-status | mo-1969-dates | all), got ${positionals.length} — `
++      `correct-data: requires exactly one <which> argument (mo-status | mo-1969-dates | mo-2026-session-merge | all), got ${positionals.length} — `
+         + 'no default, so an operator can never accidentally run every correction at once',
+     );
+   }
+   const [which] = positionals;
+-  if (!['mo-status', 'mo-1969-dates', 'all'].includes(which)) {
+-    throw new Error(`correct-data: unknown <which> "${which}" — expected mo-status | mo-1969-dates | all`);
++  if (!['mo-status', 'mo-1969-dates', 'mo-2026-session-merge', 'all'].includes(which)) {
++    throw new Error(`correct-data: unknown <which> "${which}" — expected mo-status | mo-1969-dates | mo-2026-session-merge | all`);
+   }
+   out.which = which;
+   return out;
+ }
+ 
+ // ============================================================================================
+ // Correction A — mo-status: numeric LegiScan status codes -> their printed words
+ // ============================================================================================
+ 
+ // MO_STATUS_WORD_MAP — SOURCED, not invented: LegiScan API User Manual, page 42
+@@ -443,38 +464,536 @@ export async function runCorrectMo1969Dates(client, {
+         voteId: row.id, reason: result.reason, error: String(result.error?.message ?? result.error),
+       });
+     }
+   }
+ 
+   return {
+     seen: rows.length, deletedAsDuplicate, redatedFromSource, unresolvableDate, matches, failures,
+   };
+ }
+ 
++// ============================================================================================
++// Correction C — mo-2026-session-merge: the MO 2026 session split (TODO 25)
++// ============================================================================================
++//
++// CANONICAL_MO_2026_SESSION_IDENTIFIER / DUPLICATE_MO_2026_SESSION_IDENTIFIER — the brief's own
++// verified pair: '261' (legiscan_session_id=2239, LegiScan-sourced, the real session) vs '2026'
++// (legiscan_session_id=NULL — the only MO session missing one, created by ingest-mo-senate.js's
++// own ensureSessionRow/insertIfAbsent on every Senate-journal run, independent of the LegiScan
++// import). Named identifiers, not derived — this correction is scoped to exactly this one known
++// split, never a general "find any two sessions that look alike" heuristic.
++export const CANONICAL_MO_2026_SESSION_IDENTIFIER = '261';
++export const DUPLICATE_MO_2026_SESSION_IDENTIFIER = '2026';
++
++// DUP_BILL_MUST_BE_EMPTY_TABLES — the brief names bill_texts/bill_sponsors/summaries explicitly
++// (all confirmed zero on the duplicate side at brief-writing time, re-verified live below, never
++// trusted from the brief's own numbers). bill_actions is ALSO a bills(id) foreign key this brief's
++// prose doesn't name — added here defensively (same "never silently redirect a table this brief
++// didn't anticipate" spirit the brief states for the other three): if it's ever non-zero, this
++// STOPS and reports that bill too, exactly like the three named tables, rather than assuming its
++// silence means "safe to ignore."
++export const DUP_BILL_MUST_BE_EMPTY_TABLES = ['bill_texts', 'bill_sponsors', 'summaries', 'bill_actions'];
++
++const MO_JURISDICTION_ID = 'mo-legislature';
++
++// parseLegiscanRollCallSourceKey — the exact inverse of legiscan-votes.js's own
++// buildLegiscanVoteSourceKey('legiscan-<sessionId>-rollcall-<rollCallId>'), so Phase B never
++// guesses a LegiScan roll_call_id: it parses it back out of the LegiScan vote's own stored
++// source_key. Any source_key that doesn't cleanly match this exact shape returns null (an honest
++// "can't parse", counted separately below) rather than a best-effort guess.
++const LEGISCAN_ROLLCALL_SOURCE_KEY_PATTERN = /^legiscan-(\d+)-rollcall-(\d+)$/;
++export function parseLegiscanRollCallSourceKey(sourceKey) {
++  const m = LEGISCAN_ROLLCALL_SOURCE_KEY_PATTERN.exec(String(sourceKey ?? ''));
++  if (!m) return null;
++  return { legiscanSessionId: m[1], rollCallId: m[2] };
++}
++
++// processDuplicateBill — one duplicate bill (session '2026') -> 'merged' | 'stopped' | 'failed'.
++// Brief step 1: the canonical twin is found by an EXACT `identifier` match under the canonical
++// session — the `bills` table's own `unique (session_id, identifier)` constraint (migration 0001)
++// guarantees at most one twin can ever exist per session, so only 0-vs-1 needs handling here (>1
++// is unreachable given that constraint, but checked anyway — never assumed from a comment).
++// dryRun performs every READ this would (twin lookup, related-table counts, the vote rows that
++// WOULD be redirected) but never an update/delete — `voteRows` is still returned, projected onto
++// the canonical bill id, so Phase B can run its own read-only comparison against what a live pass
++// would actually produce.
++async function processDuplicateBill(client, dupBill, canonicalSessionId, { dryRun, runId }) {
++  const { data: twins, error: twinErr } = await client
++    .from('bills').select('id').eq('session_id', canonicalSessionId).eq('identifier', dupBill.identifier);
++  if (twinErr) {
++    return {
++      outcome: 'failed',
++      detail: {
++        billId: dupBill.id, identifier: dupBill.identifier, reason: 'twin_lookup_failed', error: String(twinErr.message ?? twinErr),
++      },
++    };
++  }
++  if (!twins || twins.length !== 1) {
++    return {
++      outcome: 'stopped',
++      detail: {
++        billId: dupBill.id,
++        identifier: dupBill.identifier,
++        reason: twins && twins.length > 1 ? 'multiple_canonical_twins' : 'no_canonical_twin',
++      },
++    };
++  }
++  const canonicalBillId = twins[0].id;
++
++  const nonZeroTables = [];
++  for (const table of DUP_BILL_MUST_BE_EMPTY_TABLES) {
++    // eslint-disable-next-line no-await-in-loop -- four small count-only checks per bill, same
++    // "small/infrequent, sequential" precedent as the rest of this file's per-row loops.
++    const { count, error } = await client
++      .from(table).select('id', { count: 'exact', head: true }).eq('bill_id', dupBill.id);
++    if (error) {
++      return {
++        outcome: 'failed',
++        detail: {
++          billId: dupBill.id, identifier: dupBill.identifier, reason: `${table}_check_failed`, error: String(error.message ?? error),
++        },
++      };
++    }
++    if ((count ?? 0) > 0) nonZeroTables.push({ table, count });
++  }
++  if (nonZeroTables.length > 0) {
++    return {
++      outcome: 'stopped',
++      detail: {
++        billId: dupBill.id, identifier: dupBill.identifier, reason: 'non_zero_related_tables', nonZeroTables,
++      },
++    };
++  }
++
++  const { data: dupVoteRows, error: voteSelErr } = await client
++    .from('votes').select('id,bill_id,chamber,vote_date,source_key,result').eq('bill_id', dupBill.id);
++  if (voteSelErr) {
++    return {
++      outcome: 'failed',
++      detail: {
++        billId: dupBill.id, identifier: dupBill.identifier, reason: 'votes_lookup_failed', error: String(voteSelErr.message ?? voteSelErr),
++      },
++    };
++  }
++  // Projected onto the canonical bill id in EVERY branch (dry-run and live) — in live mode this is
++  // simply true after the redirect below; in dry-run mode nothing actually moved, but Phase B needs
++  // to know what WOULD be true post-redirect to look up LegiScan candidates on the right bill.
++  const projectedVoteRows = (dupVoteRows ?? []).map((v) => ({ ...v, bill_id: canonicalBillId }));
++
++  if (dryRun) {
++    return {
++      outcome: 'merged',
++      votesRedirected: projectedVoteRows.length,
++      detail: {
++        billId: dupBill.id,
++        identifier: dupBill.identifier,
++        canonicalBillId,
++        votesRedirected: projectedVoteRows.length,
++        voteRows: projectedVoteRows,
++        billDeleted: false,
++        dryRun: true,
++      },
++    };
++  }
++
++  const { data: updatedVotes, error: updErr } = await client
++    .from('votes').update({ bill_id: canonicalBillId, run_id: runId }).eq('bill_id', dupBill.id).select('id', { count: 'exact' });
++  if (updErr) {
++    return {
++      outcome: 'failed',
++      detail: {
++        billId: dupBill.id, identifier: dupBill.identifier, reason: 'vote_redirect_failed', error: String(updErr.message ?? updErr),
++      },
++    };
++  }
++  const redirectedCount = updatedVotes ? updatedVotes.length : 0;
++
++  // Re-verify LIVE (brief step 4): zero remaining votes.bill_id references to the duplicate bill —
++  // the actual guard the delete below depends on, not just an assumption that the update above
++  // matched everything.
++  const { count: remainingVotes, error: remErr } = await client
++    .from('votes').select('id', { count: 'exact', head: true }).eq('bill_id', dupBill.id);
++  if (remErr) {
++    return {
++      outcome: 'failed',
++      detail: {
++        billId: dupBill.id, identifier: dupBill.identifier, reason: 'vote_redirect_recheck_failed', error: String(remErr.message ?? remErr),
++      },
++    };
++  }
++  if ((remainingVotes ?? 0) > 0) {
++    return {
++      outcome: 'failed',
++      detail: {
++        billId: dupBill.id, identifier: dupBill.identifier, reason: 'vote_redirect_incomplete', remaining: remainingVotes,
++      },
++    };
++  }
++
++  const { data: deletedBills, error: delErr } = await client.from('bills').delete().eq('id', dupBill.id).select('id');
++  if (delErr) {
++    return {
++      outcome: 'failed',
++      detail: {
++        billId: dupBill.id, identifier: dupBill.identifier, reason: 'bill_delete_failed', error: String(delErr.message ?? delErr),
++      },
++    };
++  }
++  if (!deletedBills || deletedBills.length !== 1) {
++    return {
++      outcome: 'failed',
++      detail: {
++        billId: dupBill.id, identifier: dupBill.identifier, reason: 'bill_delete_guard_mismatch', got: deletedBills?.length ?? 0,
++      },
++    };
++  }
++
++  return {
++    outcome: 'merged',
++    votesRedirected: redirectedCount,
++    detail: {
++      billId: dupBill.id,
++      identifier: dupBill.identifier,
++      canonicalBillId,
++      votesRedirected: redirectedCount,
++      voteRows: projectedVoteRows,
++      billDeleted: true,
++      dryRun: false,
++    },
++  };
++}
++
++// runMergeMo2026Session — Phase A. `merges[]` doubles as the human-review surface (same "≤ a few
++// dozen rows, Lance can eyeball every decision" precedent as runCorrectMo1969Dates's own `matches`)
++// AND the input Phase B consumes (each entry's `voteRows`, already projected onto the canonical
++// bill id) — one pass produces both, never two independently-derived views of the same merge.
++export async function runMergeMo2026Session(client, {
++  dryRun = false, limit = null, runId = null,
++} = {}) {
++  const { data: sessionRows, error: sessErr } = await client
++    .from('sessions').select('id,identifier,legiscan_session_id')
++    .eq('jurisdiction_id', MO_JURISDICTION_ID)
++    .in('identifier', [CANONICAL_MO_2026_SESSION_IDENTIFIER, DUPLICATE_MO_2026_SESSION_IDENTIFIER]);
++  if (sessErr) throw new Error(`mo-2026-session-merge: session lookup failed: ${sessErr.message}`);
++  const canonical = (sessionRows ?? []).find((r) => r.identifier === CANONICAL_MO_2026_SESSION_IDENTIFIER);
++  const dup = (sessionRows ?? []).find((r) => r.identifier === DUPLICATE_MO_2026_SESSION_IDENTIFIER);
++
++  const emptyReport = (overrides) => ({
++    canonicalSessionFound: !!canonical,
++    dupSessionFound: !!dup,
++    canonicalSessionId: canonical?.id ?? null,
++    dupSessionId: dup?.id ?? null,
++    dupBillsTotal: 0,
++    dupBillsSeen: 0,
++    billsMerged: 0,
++    votesRedirected: 0,
++    sessionDeleted: false,
++    sessionDeletionEligible: false,
++    stopped: [],
++    merges: [],
++    failures: [],
++    ...overrides,
++  });
++
++  // Canonical session missing entirely is a red flag worth surfacing (it's supposed to be the real,
++  // populated session) — but ONLY if a duplicate is also present (i.e. there's actually something
++  // this correction would need the canonical row for); if BOTH are absent there's simply nothing to
++  // do (a prior run may have already fully merged and cleaned up), never an error.
++  if (!canonical) {
++    return emptyReport({
++      failures: dup ? [{ reason: 'canonical_session_missing_but_duplicate_present', dupSessionId: dup.id }] : [],
++    });
++  }
++  if (!dup) return emptyReport({});
++
++  const { data: dupBillsAll, error: dupBillsErr } = await selectAll(client, 'bills', 'id,identifier', {
++    filter: (q) => q.eq('session_id', dup.id),
++  });
++  if (dupBillsErr) throw new Error(`mo-2026-session-merge: duplicate bill lookup failed: ${dupBillsErr.message}`);
++  const dupBillsTotal = (dupBillsAll ?? []).length;
++  const sortedDupBills = [...(dupBillsAll ?? [])].sort((a, b) => (a.id > b.id ? 1 : -1));
++  const dupBillsScoped = limit != null ? sortedDupBills.slice(0, limit) : sortedDupBills;
++
++  const stopped = [];
++  const merges = [];
++  const failures = [];
++  let billsMerged = 0;
++  let votesRedirected = 0;
++
++  for (const b of dupBillsScoped) {
++    // eslint-disable-next-line no-await-in-loop -- sequential over at most a few dozen bills (brief:
++    // ~34), same "small/infrequent backlog" precedent as this file's other corrections.
++    const result = await processDuplicateBill(client, b, canonical.id, { dryRun, runId });
++    if (result.outcome === 'merged') {
++      billsMerged += 1;
++      votesRedirected += result.votesRedirected;
++      merges.push(result.detail);
++    } else if (result.outcome === 'stopped') {
++      stopped.push(result.detail);
++    } else {
++      failures.push(result.detail);
++    }
++  }
++
++  // sessionDeletionEligible — every duplicate bill (not just the ones a --limit scoped in) merged
++  // cleanly, with nothing stopped or failed. Reported honestly in BOTH modes (brief: "report...
++  // session deleted or not"); only LIVE mode ever acts on it, and even then via its own independent
++  // re-check immediately below (brief step 5's own guard), never by trusting this in-memory count.
++  const sessionDeletionEligible = dupBillsScoped.length === dupBillsTotal && stopped.length === 0 && failures.length === 0;
++  let sessionDeleted = false;
++
++  if (!dryRun) {
++    const { count: remainingBillCount, error: remErr } = await client
++      .from('bills').select('id', { count: 'exact', head: true }).eq('session_id', dup.id);
++    if (remErr) {
++      failures.push({ reason: 'session_bill_recount_failed', error: String(remErr.message ?? remErr) });
++    } else if ((remainingBillCount ?? 0) === 0) {
++      const { data: deletedSessions, error: sessDelErr } = await client
++        .from('sessions').delete().eq('id', dup.id).select('id');
++      if (sessDelErr) {
++        failures.push({ reason: 'session_delete_failed', error: String(sessDelErr.message ?? sessDelErr) });
++      } else if (deletedSessions && deletedSessions.length === 1) {
++        sessionDeleted = true;
++      } else {
++        failures.push({ reason: 'session_delete_guard_mismatch', got: deletedSessions?.length ?? 0 });
++      }
++    }
++    // remainingBillCount > 0: the session still owns bills (a stopped bill, a failure, or a
++    // --limit-truncated pass) — never deleted, no failure either; this is the guard doing exactly
++    // what it's for.
++  }
++
++  return {
++    canonicalSessionFound: true,
++    dupSessionFound: true,
++    canonicalSessionId: canonical.id,
++    dupSessionId: dup.id,
++    dupBillsTotal,
++    dupBillsSeen: dupBillsScoped.length,
++    billsMerged,
++    votesRedirected,
++    sessionDeleted,
++    sessionDeletionEligible,
++    stopped,
++    merges,
++    failures,
++  };
++}
++
++// reconcileOneVote — Phase B, one redirected mo-senate-web vote (already on its merged/canonical
++// bill_id). Brief step 1: matching LegiScan vote(s) by (bill_id, jurisdiction, chamber,
++// sameCalendarDate) — 0 -> 'no_match', >1 -> 'ambiguous', both honestly reported, never guessed.
++// On exactly one match, reuses summarizePrimaryCastPositions (generic over any position set, per
++// the brief, applied to BOTH sides) and compareTalliesForCrossCheck (the SAME hard/soft comparison
++// crossCheckAgainstPrimarySource's own single-candidate branch uses) — never a hand-rolled second
++// comparison. Clean (0 hard, 0 soft) writes nothing. Any mismatch writes ONE vote_reconciliation_flags
++// row via the reused, idempotent writeReconciliationFlag — `voteId` is the mo-senate-web vote's OWN
++// id (matches the live system's "vote_id always points at the PRIMARY-source row" convention),
++// `sourceB: 'mo-senate-web'`. dryRun never calls writeReconciliationFlag at all (that function isn't
++// dry-run-aware — this file's own DRAFT-THEN-APPLY convention keeps the actual write client-side,
++// gated here, not inside the reused function).
++async function reconcileOneVote(client, dupVote, { dryRun, runId }) {
++  const { data: candidateRows, error: candErr } = await client
++    .from('votes').select('id,vote_date,chamber,source_key,result')
++    .eq('bill_id', dupVote.bill_id).eq('jurisdiction_id', MO_JURISDICTION_ID).eq('chamber', dupVote.chamber)
++    .like('source_key', 'legiscan-%');
++  if (candErr) {
++    return {
++      outcome: 'failed',
++      detail: { voteId: dupVote.id, reason: 'legiscan_candidate_lookup_failed', error: String(candErr.message ?? candErr) },
++    };
++  }
++
++  const candidates = (candidateRows ?? []).filter((c) => sameCalendarDate(c.vote_date, dupVote.vote_date));
++
++  if (candidates.length === 0) {
++    return {
++      outcome: 'no_match',
++      detail: {
++        voteId: dupVote.id, billId: dupVote.bill_id, chamber: dupVote.chamber, voteDate: dupVote.vote_date,
++      },
++    };
++  }
++  if (candidates.length > 1) {
++    return {
++      outcome: 'ambiguous',
++      detail: {
++        voteId: dupVote.id,
++        billId: dupVote.bill_id,
++        candidates: candidates.map((c) => ({ id: c.id, source_key: c.source_key, vote_date: c.vote_date })),
++      },
++    };
++  }
++
++  const legiscanVote = candidates[0];
++  const parsedRollCall = parseLegiscanRollCallSourceKey(legiscanVote.source_key);
++  if (!parsedRollCall) {
++    return {
++      outcome: 'unparseable',
++      detail: { voteId: dupVote.id, legiscanVoteId: legiscanVote.id, sourceKey: legiscanVote.source_key },
++    };
++  }
++
++  const { data: primaryCastRows, error: primaryCastErr } = await client
++    .from('vote_casts').select('position').eq('vote_id', dupVote.id);
++  if (primaryCastErr) {
++    return {
++      outcome: 'failed',
++      detail: { voteId: dupVote.id, reason: 'primary_casts_lookup_failed', error: String(primaryCastErr.message ?? primaryCastErr) },
++    };
++  }
++  const { data: legiscanCastRows, error: legiscanCastErr } = await client
++    .from('vote_casts').select('position').eq('vote_id', legiscanVote.id);
++  if (legiscanCastErr) {
++    return {
++      outcome: 'failed',
++      detail: { voteId: dupVote.id, reason: 'legiscan_casts_lookup_failed', error: String(legiscanCastErr.message ?? legiscanCastErr) },
++    };
++  }
++
++  const primaryCounts = summarizePrimaryCastPositions(primaryCastRows ?? []);
++  const legiscanCounts = summarizePrimaryCastPositions(legiscanCastRows ?? []);
++  const legiscanTallies = {
++    tallies: {
++      yea: legiscanCounts.yea, nay: legiscanCounts.nay, not_voting: legiscanCounts.not_voting, absent: legiscanCounts.absent,
++    },
++    chamber: dupVote.chamber,
++    date: legiscanVote.vote_date,
++    runId,
++    rollCallId: parsedRollCall.rollCallId,
++  };
++
++  const { hardMismatches, softMismatches } = compareTalliesForCrossCheck(legiscanTallies, primaryCounts);
++
++  if (hardMismatches.length === 0 && softMismatches.length === 0) {
++    return {
++      outcome: 'clean',
++      detail: {
++        voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, chamber: dupVote.chamber, matched: true, flag: null,
++      },
++    };
++  }
++
++  const discrepancy = {
++    source_a_tallies: legiscanTallies.tallies,
++    source_b_tallies: primaryCounts,
++    source_b_result: dupVote.result ?? null,
++    source_b_vote_id: dupVote.id,
++    source_b_source_key: dupVote.source_key,
++    hard_mismatches: hardMismatches,
++    soft_mismatches: softMismatches,
++  };
++  if (softMismatches.length > 0) discrepancy.caveat = PRESENT_CATEGORY_CAVEAT;
++  const reason = hardMismatches.length > 0 ? 'hard_mismatch' : 'soft_mismatch';
++
++  if (dryRun) {
++    return {
++      outcome: 'flagged',
++      detail: {
++        voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, reason, discrepancy, wouldWrite: true,
++      },
++    };
++  }
++
++  const flag = await writeReconciliationFlag(client, {
++    voteId: dupVote.id, sourceB: 'mo-senate-web', discrepancy, runId, rollCallId: parsedRollCall.rollCallId, reason,
++  });
++
++  return {
++    outcome: 'flagged',
++    detail: {
++      voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, reason, flag,
++    },
++  };
++}
++
++// runReconcileMo2026Votes — Phase B driver. Only ever looks at mo-senate-web-prefixed votes among
++// `mergedBills[].voteRows` (defensive: the brief's live verification found all 31 redirected votes
++// were mo-senate-web, but this never assumes that holds forever) — never touches a vote this run
++// didn't itself just merge.
++export async function runReconcileMo2026Votes(client, {
++  dryRun = false, runId = null, mergedBills = [],
++} = {}) {
++  const votesToCheck = mergedBills.flatMap((m) => (m.voteRows ?? [])
++    .filter((v) => String(v.source_key ?? '').startsWith('mo-senate-web-')));
++
++  const cleanMatchDetails = [];
++  const flagged = [];
++  const noMatch = [];
++  const ambiguous = [];
++  const unparseable = [];
++  const failures = [];
++
++  for (const dupVote of votesToCheck) {
++    // eslint-disable-next-line no-await-in-loop -- sequential over at most a few dozen votes (brief:
++    // 31), same "small/infrequent backlog" precedent as the rest of this file.
++    const result = await reconcileOneVote(client, dupVote, { dryRun, runId });
++    if (result.outcome === 'clean') cleanMatchDetails.push(result.detail);
++    else if (result.outcome === 'flagged') flagged.push(result.detail);
++    else if (result.outcome === 'no_match') noMatch.push(result.detail);
++    else if (result.outcome === 'ambiguous') ambiguous.push(result.detail);
++    else if (result.outcome === 'unparseable') unparseable.push(result.detail);
++    else failures.push(result.detail);
++  }
++
++  return {
++    votesChecked: votesToCheck.length,
++    cleanMatches: cleanMatchDetails.length,
++    flaggedCount: flagged.length,
++    noMatchCount: noMatch.length,
++    ambiguousCount: ambiguous.length,
++    unparseableCount: unparseable.length,
++    cleanMatchDetails,
++    flagged,
++    noMatch,
++    ambiguous,
++    unparseable,
++    failures,
++  };
++}
++
++// runCorrectMo2026SessionMerge — Phase A then Phase B, combined report + combined failures.
++export async function runCorrectMo2026SessionMerge(client, {
++  dryRun = false, limit = null, runId = null,
++} = {}) {
++  const merge = await runMergeMo2026Session(client, { dryRun, limit, runId });
++  const reconciliation = await runReconcileMo2026Votes(client, { dryRun, runId, mergedBills: merge.merges });
++  return {
++    merge, reconciliation, failures: [...merge.failures, ...reconciliation.failures],
++  };
++}
++
+ // ============================================================================================
+ // Top-level dispatcher
+ // ============================================================================================
+ 
+ export async function runCorrectData(client, {
+   which, dryRun = false, limit = null, runId = null,
+ } = {}) {
+   const out = { mode: dryRun ? 'dry-run' : 'live', which };
+   const failures = [];
+ 
+   if (which === 'mo-status' || which === 'all') {
+     out.moStatus = await runCorrectMoStatus(client, { dryRun, limit, runId });
+     failures.push(...out.moStatus.failures);
+   }
+   if (which === 'mo-1969-dates' || which === 'all') {
+     out.mo1969Dates = await runCorrectMo1969Dates(client, { dryRun, limit, runId });
+     failures.push(...out.mo1969Dates.failures);
+   }
++  // Deliberately EXCLUDED from 'all' (brief, explicit): bill/session merge + FK redirect + guarded
++  // deletes is higher-stakes than A/B's in-place rewrites — an operator must name this one, never
++  // sweep it in by omission.
++  if (which === 'mo-2026-session-merge') {
++    out.mo2026SessionMerge = await runCorrectMo2026SessionMerge(client, { dryRun, limit, runId });
++    failures.push(...out.mo2026SessionMerge.failures);
++  }
+ 
+   out.failures = failures;
+   return out;
+ }
+ 
+ // ---- main ----
+ 
+ async function main() {
+   const args = parseArgs(process.argv.slice(2));
+   const client = getClient();
+diff --git a/tests/correct-data.test.js b/tests/correct-data.test.js
+index 6c234f5..b0ae5c2 100644
+--- a/tests/correct-data.test.js
++++ b/tests/correct-data.test.js
+@@ -1,92 +1,121 @@
+ import { test } from 'node:test';
+ import assert from 'node:assert/strict';
++import { readFileSync } from 'node:fs';
+ import {
+   parseArgs,
+   MO_STATUS_WORD_MAP,
+   MO_STATUS_MAPPED_CODES,
+   MO_STATUS_PROGRESS_ONLY_CODES,
+   MO_STATUS_UNMAPPED_CODE,
+   mapMoStatusCode,
+   parseMoSenateJournalDateFromUrl,
+   VOTE_DATE_1969_SENTINEL,
+   runCorrectMoStatus,
+   runCorrectMo1969Dates,
+   runCorrectData,
++  CANONICAL_MO_2026_SESSION_IDENTIFIER,
++  DUPLICATE_MO_2026_SESSION_IDENTIFIER,
++  DUP_BILL_MUST_BE_EMPTY_TABLES,
++  runMergeMo2026Session,
++  runReconcileMo2026Votes,
++  runCorrectMo2026SessionMerge,
+ } from '../src/cli/correct-data.js';
+ 
+ // Data-corrections CLI (.superpowers/sdd/2026-07-31-data-corrections/brief.md). Two REVERSIBLE
+ // production-data corrections (both re-derivable from cached LegiScan datasets / the primary MO
+ // Senate journal source), draft-then-apply — this test file proves the dry-run/live orchestration
+ // logic entirely against a fake in-memory client; ZERO live DB writes anywhere in this file, and no
+ // live run is ever performed from this repo (Lance's own separate explicit word, per the brief).
+ 
+ // ---- fake Supabase-ish client: eq/in/order/limit + select/update/delete, thenable builder ----
+ // A single generic in-memory fake (not one bespoke mock per call site) because both corrections
+ // issue a handful of genuinely different call shapes (plain select, count-only head select,
+ // update+select(count:exact), delete+select) against three small tables (bills, votes,
+ // vote_casts) — mirrors real supabase-js closely enough (fluent + thenable) to exercise this
+ // module's actual query construction, not just its counting arithmetic.
++function likeToRegExp(pattern) {
++  const escaped = String(pattern).split('%').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
++  return new RegExp(`^${escaped.join('.*')}$`);
++}
++
+ function makeFakeClient(seed = {}, { forceError = null, afterExecute = null } = {}) {
+-  const tables = { bills: [], votes: [], vote_casts: [], ...seed };
++  const tables = {
++    bills: [],
++    votes: [],
++    vote_casts: [],
++    sessions: [],
++    bill_texts: [],
++    bill_sponsors: [],
++    summaries: [],
++    bill_actions: [],
++    vote_reconciliation_flags: [],
++    ...seed,
++  };
+   for (const t of Object.keys(tables)) tables[t] = tables[t].map((r) => ({ ...r }));
+   const calls = [];
++  let insertCounter = 0;
+ 
+   function matchesFilters(row, filters) {
+     return filters.every((f) => {
+       if (f.op === 'eq') return row[f.col] === f.val;
+       if (f.op === 'in') return f.vals.includes(row[f.col]);
++      if (f.op === 'like') return likeToRegExp(f.val).test(String(row[f.col] ?? ''));
+       return true;
+     });
+   }
+ 
+   function makeBuilder(table, mode, patch) {
+     const filters = [];
+     let orderCol = null;
+     let orderAsc = true;
+     let limitVal = null;
++    let rangeVal = null;
+     let selectCols = null;
+     let selectOpts = {};
+ 
+     const builder = {
+       eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
+       in(col, vals) { filters.push({ op: 'in', col, vals }); return builder; },
++      like(col, val) { filters.push({ op: 'like', col, val }); return builder; },
+       order(col, { ascending = true } = {}) { orderCol = col; orderAsc = ascending; return builder; },
+       limit(n) { limitVal = n; return builder; },
++      range(from, to) { rangeVal = [from, to]; return builder; },
+       select(cols, opts = {}) { selectCols = cols; selectOpts = opts; return builder; },
+       then(resolve, reject) {
+         try {
+           resolve(execute());
+         } catch (e) {
+           if (reject) reject(e); else throw e;
+         }
+       },
+     };
+ 
+     function execute() {
+       const callInfo = {
+-        table, mode, patch, filters: [...filters], select: selectCols, selectOpts, orderCol, limitVal,
++        table, mode, patch, filters: [...filters], select: selectCols, selectOpts, orderCol, limitVal, rangeVal,
+       };
+       calls.push(callInfo);
+       const injected = forceError && forceError(table, mode, filters);
+       if (injected) return { data: null, error: injected, count: null };
+ 
+       const rows = tables[table];
+       let matched = rows.filter((r) => matchesFilters(r, filters));
+       let result;
+ 
+       if (mode === 'select') {
+         if (orderCol) {
+           matched = [...matched].sort((a, b) => (a[orderCol] > b[orderCol] ? 1 : -1) * (orderAsc ? 1 : -1));
+         }
+         let out = matched;
+-        if (limitVal != null) out = out.slice(0, limitVal);
++        if (rangeVal) out = out.slice(rangeVal[0], rangeVal[1] + 1);
++        else if (limitVal != null) out = out.slice(0, limitVal);
+         if (selectOpts.head) result = { data: null, error: null, count: matched.length };
+         else if (selectOpts.count === 'exact') result = { data: out.map((r) => ({ ...r })), error: null, count: matched.length };
+         else result = { data: out.map((r) => ({ ...r })), error: null };
+       } else if (mode === 'update') {
+         for (const row of matched) Object.assign(row, patch);
+         if (selectCols) {
+           const data = matched.map((r) => ({ id: r.id }));
+           result = selectOpts.count === 'exact' ? { data, error: null, count: matched.length } : { data, error: null };
+         } else {
+           result = { data: null, error: null };
+@@ -104,28 +133,54 @@ function makeFakeClient(seed = {}, { forceError = null, afterExecute = null } =
+       // writer racing between two awaited calls (e.g. mutating a row's status right after an
+       // id-select returns, so a LATER update in the same code path sees the raced-away state).
+       if (afterExecute) afterExecute(callInfo, tables);
+ 
+       return result;
+     }
+ 
+     return builder;
+   }
+ 
++  // makeInsertBuilder — only vote_reconciliation_flags (via legiscan-votes.js's own
++  // writeReconciliationFlag, reused unmodified by the mo-2026-session-merge reconciliation phase)
++  // ever inserts through this fake client. Mirrors tests/legiscan-votes.test.js's own
++  // makeFakeVotesDb insert shape (`.insert(row).select().single()`) closely enough to drive that
++  // real function's actual call chain, not a bespoke re-derivation of it.
++  function makeInsertBuilder(table, row) {
++    return {
++      select: () => ({
++        single: async () => {
++          const injected = forceError && forceError(table, 'insert', []);
++          if (injected) return { data: null, error: injected };
++          insertCounter += 1;
++          const inserted = {
++            id: `${table}-${insertCounter}`, resolved: false, created_at: 'test-time', ...row,
++          };
++          tables[table].push(inserted);
++          calls.push({
++            table, mode: 'insert', patch: row, filters: [], select: null, selectOpts: {}, orderCol: null, limitVal: null, rangeVal: null,
++          });
++          return { data: { ...inserted }, error: null };
++        },
++      }),
++    };
++  }
++
+   return {
+     tables,
+     calls,
+     from(table) {
+       return {
+         select: (cols, opts) => makeBuilder(table, 'select', null).select(cols, opts),
+         update: (patch) => makeBuilder(table, 'update', patch),
+         delete: () => makeBuilder(table, 'delete', null),
++        insert: (row) => makeInsertBuilder(table, row),
+       };
+     },
+   };
+ }
+ 
+ // ---- parseArgs ----
+ 
+ test('parseArgs: requires exactly one <which> positional, no default (no accidental "all" run)', () => {
+   assert.throws(() => parseArgs([]), /requires exactly one/);
+   assert.throws(() => parseArgs(['--dry-run']), /requires exactly one/);
+@@ -580,10 +635,431 @@ test('runCorrectData: "mo-status" runs only the status correction; "mo-1969-date
+   const datesOnly = await runCorrectData(makeFakeClient(seed), { which: 'mo-1969-dates', dryRun: true });
+   assert.equal(datesOnly.moStatus, undefined);
+   assert.ok(datesOnly.mo1969Dates);
+ 
+   const both = await runCorrectData(makeFakeClient(seed), { which: 'all', dryRun: true });
+   assert.ok(both.moStatus);
+   assert.ok(both.mo1969Dates);
+   assert.equal(both.failures.length, 0);
+   assert.equal(both.mode, 'dry-run');
+ });
++
++// ============================================================================================
++// mo-2026-session-merge (TODO 25 / .superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md) —
++// Phase A (bill/session merge) + Phase B (vote reconciliation, additive-only, NO deletes).
++// ============================================================================================
++
++test('parseArgs: accepts mo-2026-session-merge as a fourth <which> value', () => {
++  assert.equal(parseArgs(['mo-2026-session-merge']).which, 'mo-2026-session-merge');
++  assert.equal(parseArgs(['mo-2026-session-merge', '--dry-run']).dryRun, true);
++});
++
++test('CANONICAL_MO_2026_SESSION_IDENTIFIER / DUPLICATE_MO_2026_SESSION_IDENTIFIER / DUP_BILL_MUST_BE_EMPTY_TABLES: pinned to the brief\'s verified values', () => {
++  assert.equal(CANONICAL_MO_2026_SESSION_IDENTIFIER, '261');
++  assert.equal(DUPLICATE_MO_2026_SESSION_IDENTIFIER, '2026');
++  assert.ok(DUP_BILL_MUST_BE_EMPTY_TABLES.includes('bill_texts'));
++  assert.ok(DUP_BILL_MUST_BE_EMPTY_TABLES.includes('bill_sponsors'));
++  assert.ok(DUP_BILL_MUST_BE_EMPTY_TABLES.includes('summaries'));
++});
++
++test('correct-data.js source: never IMPORTS or CALLS crossCheckAgainstPrimarySource or retractLegiscanVoteIfStored — the two sanctioned-elsewhere functions the brief forbids this file from invoking (a bare mention in an explanatory comment, documenting WHY they are never called, is fine)', () => {
++  const src = readFileSync(new URL('../src/cli/correct-data.js', import.meta.url), 'utf8');
++  assert.equal(/\bcrossCheckAgainstPrimarySource\(/.test(src), false, 'must never CALL the live pre-store gate against already-published data');
++  assert.equal(/import\s*\{[^}]*\bcrossCheckAgainstPrimarySource\b/.test(src), false, 'must never IMPORT it either');
++  assert.equal(/\bretractLegiscanVoteIfStored\(/.test(src), false, 'must never CALL this repo\'s one sanctioned delete — Phase B never deletes anything');
++  assert.equal(/import\s*\{[^}]*\bretractLegiscanVoteIfStored\b/.test(src), false, 'must never IMPORT it either');
++});
++
++function sessionRow(id, identifier, legiscanSessionId = null) {
++  return {
++    id, jurisdiction_id: 'mo-legislature', identifier, legiscan_session_id: legiscanSessionId,
++  };
++}
++function moBillRow(id, sessionId, identifier) {
++  return { id, session_id: sessionId, identifier };
++}
++function moVoteRow(overrides) {
++  return {
++    jurisdiction_id: 'mo-legislature', chamber: 'senate', result: null, ...overrides,
++  };
++}
++function castRow(id, voteId, position, legislatorId) {
++  return {
++    id, vote_id: voteId, position, legislator_id: legislatorId,
++  };
++}
++
++const CANON = sessionRow('sess-261', '261', 2239);
++const DUP = sessionRow('sess-2026', '2026', null);
++
++// ---- runMergeMo2026Session (Phase A) ----
++
++test('runMergeMo2026Session: happy path — exact-identifier twin found, zero related tables, votes redirected, duplicate bill deleted, session deleted once empty', async () => {
++  const client = makeFakeClient({
++    sessions: [CANON, DUP],
++    bills: [
++      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
++      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
++    ],
++    votes: [moVoteRow({
++      id: 'vote-dup-1', bill_id: 'bill-dup-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
++    })],
++    vote_casts: [],
++  });
++
++  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
++
++  assert.equal(report.canonicalSessionFound, true);
++  assert.equal(report.dupSessionFound, true);
++  assert.equal(report.dupBillsTotal, 1);
++  assert.equal(report.dupBillsSeen, 1);
++  assert.equal(report.billsMerged, 1);
++  assert.equal(report.votesRedirected, 1);
++  assert.equal(report.stopped.length, 0);
++  assert.equal(report.failures.length, 0);
++  assert.equal(report.sessionDeletionEligible, true);
++  assert.equal(report.sessionDeleted, true);
++
++  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), false, 'duplicate bill deleted');
++  assert.equal(client.tables.bills.some((b) => b.id === 'bill-canon-1'), true, 'canonical bill untouched');
++  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), false, 'duplicate session deleted');
++  assert.equal(client.tables.votes.find((v) => v.id === 'vote-dup-1').bill_id, 'bill-canon-1', 'vote redirected to the canonical bill');
++
++  assert.equal(report.merges.length, 1);
++  assert.equal(report.merges[0].canonicalBillId, 'bill-canon-1');
++  assert.equal(report.merges[0].billDeleted, true);
++});
++
++test('runMergeMo2026Session: no canonical twin for a duplicate identifier — STOPS and reports, never invents a merge target, bill/session untouched', async () => {
++  const client = makeFakeClient({
++    sessions: [CANON, DUP],
++    bills: [
++      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
++      moBillRow('bill-dup-orphan', 'sess-2026', 'SB 99'), // no SB 99 under the canonical session
++    ],
++    votes: [],
++  });
++
++  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
++
++  assert.equal(report.billsMerged, 0);
++  assert.equal(report.stopped.length, 1);
++  assert.equal(report.stopped[0].reason, 'no_canonical_twin');
++  assert.equal(report.stopped[0].billId, 'bill-dup-orphan');
++  assert.equal(report.sessionDeletionEligible, false, 'a stopped bill blocks session-delete eligibility');
++  assert.equal(report.sessionDeleted, false);
++  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-orphan'), true, 'never deleted — no twin to redirect its votes to');
++  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), true, 'session not deleted — still owns a bill');
++});
++
++test('runMergeMo2026Session: a duplicate bill with a non-zero related table (bill_texts here) STOPS and reports, never silently redirects', async () => {
++  const client = makeFakeClient({
++    sessions: [CANON, DUP],
++    bills: [
++      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
++      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
++    ],
++    bill_texts: [{
++      id: 'bt-1', bill_id: 'bill-dup-1', version: 'introduced',
++    }],
++    votes: [],
++  });
++
++  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
++
++  assert.equal(report.billsMerged, 0);
++  assert.equal(report.stopped.length, 1);
++  assert.equal(report.stopped[0].reason, 'non_zero_related_tables');
++  assert.deepEqual(report.stopped[0].nonZeroTables, [{ table: 'bill_texts', count: 1 }]);
++  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), true, 'never deleted — a table this brief didn\'t anticipate redirecting is non-zero');
++});
++
++test('runMergeMo2026Session: --dry-run performs ZERO writes but reports the same honest counts a live run would produce', async () => {
++  const client = makeFakeClient({
++    sessions: [CANON, DUP],
++    bills: [
++      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
++      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
++    ],
++    votes: [moVoteRow({
++      id: 'vote-dup-1', bill_id: 'bill-dup-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
++    })],
++  });
++  const before = JSON.stringify([client.tables.bills, client.tables.votes, client.tables.sessions]);
++
++  const report = await runMergeMo2026Session(client, { dryRun: true });
++
++  assert.equal(report.billsMerged, 1);
++  assert.equal(report.votesRedirected, 1);
++  assert.equal(report.sessionDeletionEligible, true);
++  assert.equal(report.sessionDeleted, false, 'dry-run never actually deletes the session, even when eligible');
++  assert.equal(JSON.stringify([client.tables.bills, client.tables.votes, client.tables.sessions]), before, 'zero writes — every table byte-for-byte unchanged');
++  assert.equal(client.calls.some((c) => c.mode === 'update' || c.mode === 'delete'), false);
++});
++
++test('runMergeMo2026Session: --limit caps how many duplicate bills are processed; a partial pass never deletes the still-non-empty session', async () => {
++  const client = makeFakeClient({
++    sessions: [CANON, DUP],
++    bills: [
++      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
++      moBillRow('bill-canon-2', 'sess-261', 'SB 2'),
++      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
++      moBillRow('bill-dup-2', 'sess-2026', 'SB 2'),
++    ],
++    votes: [],
++  });
++
++  const report = await runMergeMo2026Session(client, { dryRun: false, limit: 1, runId: 'run-1' });
++
++  assert.equal(report.dupBillsTotal, 2);
++  assert.equal(report.dupBillsSeen, 1);
++  assert.equal(report.billsMerged, 1);
++  assert.equal(report.sessionDeletionEligible, false, 'the limit left a bill unprocessed');
++  assert.equal(report.sessionDeleted, false);
++  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), true, 'session still owns bill-dup-2 — the guard refuses');
++});
++
++test('runMergeMo2026Session: no duplicate session present -> nothing to do, clean empty report, never an error', async () => {
++  const client = makeFakeClient({
++    sessions: [CANON],
++    bills: [moBillRow('bill-canon-1', 'sess-261', 'SB 1')],
++  });
++
++  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
++
++  assert.equal(report.dupSessionFound, false);
++  assert.equal(report.billsMerged, 0);
++  assert.equal(report.sessionDeleted, false);
++  assert.deepEqual(report.failures, []);
++});
++
++// ---- runReconcileMo2026Votes (Phase B) ----
++
++test('runReconcileMo2026Votes: exactly one same-day LegiScan candidate with matching tallies -> clean match, writes NOTHING', async () => {
++  const client = makeFakeClient({
++    votes: [
++      moVoteRow({
++        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
++      }),
++    ],
++    vote_casts: [
++      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
++      castRow('c2', 'vote-dup-1', 'yea', 'L2'),
++      castRow('c3', 'vote-dup-1', 'nay', 'L3'),
++      castRow('c4', 'vote-ls-1', 'yea', 'L1'),
++      castRow('c5', 'vote-ls-1', 'yea', 'L2'),
++      castRow('c6', 'vote-ls-1', 'nay', 'L3'),
++    ],
++  });
++  const mergedBills = [{
++    billId: 'bill-dup-1',
++    canonicalBillId: 'bill-canon-1',
++    voteRows: [moVoteRow({
++      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
++    })],
++  }];
++
++  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
++
++  assert.equal(report.votesChecked, 1);
++  assert.equal(report.cleanMatches, 1);
++  assert.equal(report.flaggedCount, 0);
++  assert.equal(client.tables.vote_reconciliation_flags.length, 0, 'a clean match writes nothing to the DB');
++});
++
++test('runReconcileMo2026Votes: a HARD (yea/nay) mismatch writes a vote_reconciliation_flags row keyed on the mo-senate-web vote\'s own id, reason hard_mismatch', async () => {
++  const client = makeFakeClient({
++    votes: [
++      moVoteRow({
++        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
++      }),
++    ],
++    vote_casts: [
++      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
++      castRow('c2', 'vote-dup-1', 'yea', 'L2'),
++      castRow('c3', 'vote-dup-1', 'nay', 'L3'),
++      // legiscan side: all three yea — a real hard yea/nay divergence
++      castRow('c4', 'vote-ls-1', 'yea', 'L1'),
++      castRow('c5', 'vote-ls-1', 'yea', 'L2'),
++      castRow('c6', 'vote-ls-1', 'yea', 'L3'),
++    ],
++  });
++  const mergedBills = [{
++    billId: 'bill-dup-1',
++    canonicalBillId: 'bill-canon-1',
++    voteRows: [moVoteRow({
++      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
++    })],
++  }];
++
++  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
++
++  assert.equal(report.cleanMatches, 0);
++  assert.equal(report.flaggedCount, 1);
++  assert.equal(client.tables.vote_reconciliation_flags.length, 1);
++  const flag = client.tables.vote_reconciliation_flags[0];
++  assert.equal(flag.vote_id, 'vote-dup-1', 'vote_id points at the PRIMARY-source (mo-senate-web) row, matching the live system\'s own convention');
++  assert.equal(flag.source_a, 'legiscan');
++  assert.equal(flag.source_b, 'mo-senate-web');
++  assert.equal(flag.discrepancy.reason, 'hard_mismatch');
++  assert.ok(flag.discrepancy.hard_mismatches.length > 0);
++  assert.deepEqual(flag.discrepancy.source_b_tallies.yea !== undefined, true);
++  assert.equal(flag.discrepancy.source_b_vote_id, 'vote-dup-1');
++  assert.equal(flag.discrepancy.source_b_source_key, 'mo-senate-web-2026-x-vote1');
++});
++
++test('runReconcileMo2026Votes: a SOFT-only mismatch (yea/nay agree, non-yea/non-nay bucket differs) writes reason soft_mismatch with the PRESENT_CATEGORY_CAVEAT attached', async () => {
++  const client = makeFakeClient({
++    votes: [
++      moVoteRow({
++        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
++      }),
++    ],
++    vote_casts: [
++      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
++      castRow('c2', 'vote-dup-1', 'yea', 'L2'),
++      castRow('c3', 'vote-dup-1', 'nay', 'L3'),
++      castRow('c4', 'vote-dup-1', 'present', 'L4'), // primary-only category, no LegiScan analog
++      castRow('c5', 'vote-ls-1', 'yea', 'L1'),
++      castRow('c6', 'vote-ls-1', 'yea', 'L2'),
++      castRow('c7', 'vote-ls-1', 'nay', 'L3'),
++    ],
++  });
++  const mergedBills = [{
++    billId: 'bill-dup-1',
++    canonicalBillId: 'bill-canon-1',
++    voteRows: [moVoteRow({
++      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
++    })],
++  }];
++
++  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
++
++  assert.equal(report.flaggedCount, 1);
++  const flag = client.tables.vote_reconciliation_flags[0];
++  assert.equal(flag.discrepancy.reason, 'soft_mismatch');
++  assert.equal(flag.discrepancy.hard_mismatches.length, 0);
++  assert.ok(flag.discrepancy.soft_mismatches.length > 0);
++  assert.ok(flag.discrepancy.caveat, 'the Present-category caveat is attached whenever a soft mismatch is present');
++});
++
++test('runReconcileMo2026Votes: zero LegiScan candidates -> honest no-match report, no flag written', async () => {
++  const client = makeFakeClient({ votes: [], vote_casts: [] });
++  const mergedBills = [{
++    billId: 'bill-dup-1',
++    canonicalBillId: 'bill-canon-1',
++    voteRows: [moVoteRow({
++      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
++    })],
++  }];
++
++  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
++
++  assert.equal(report.noMatchCount, 1);
++  assert.equal(report.flaggedCount, 0);
++  assert.equal(client.tables.vote_reconciliation_flags.length, 0);
++});
++
++test('runReconcileMo2026Votes: more than one same-day LegiScan candidate -> reported ambiguous, never guessed, no flag written', async () => {
++  const client = makeFakeClient({
++    votes: [
++      moVoteRow({
++        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
++      }),
++      moVoteRow({
++        id: 'vote-ls-2', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641860',
++      }),
++    ],
++    vote_casts: [],
++  });
++  const mergedBills = [{
++    billId: 'bill-dup-1',
++    canonicalBillId: 'bill-canon-1',
++    voteRows: [moVoteRow({
++      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
++    })],
++  }];
++
++  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
++
++  assert.equal(report.ambiguousCount, 1);
++  assert.equal(report.flaggedCount, 0);
++  assert.equal(client.tables.vote_reconciliation_flags.length, 0);
++});
++
++test('runReconcileMo2026Votes: --dry-run performs ZERO writes even on a mismatch, reports wouldWrite honestly', async () => {
++  const client = makeFakeClient({
++    votes: [
++      moVoteRow({
++        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
++      }),
++    ],
++    vote_casts: [
++      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
++      castRow('c4', 'vote-ls-1', 'yea', 'L1'),
++      castRow('c5', 'vote-ls-1', 'nay', 'L2'), // hard mismatch: primary has no nay caster at all
++    ],
++  });
++  const mergedBills = [{
++    billId: 'bill-dup-1',
++    canonicalBillId: 'bill-canon-1',
++    voteRows: [moVoteRow({
++      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
++    })],
++  }];
++
++  const report = await runReconcileMo2026Votes(client, { dryRun: true, mergedBills });
++
++  assert.equal(report.flaggedCount, 1);
++  assert.equal(report.flagged[0].wouldWrite, true);
++  assert.equal(client.tables.vote_reconciliation_flags.length, 0, 'dry-run never writes a flag row');
++});
++
++// ---- runCorrectMo2026SessionMerge (combined) + runCorrectData dispatcher wiring ----
++
++test('runCorrectMo2026SessionMerge: runs Phase A then Phase B against the bills Phase A actually merged, combining failures', async () => {
++  const client = makeFakeClient({
++    sessions: [CANON, DUP],
++    bills: [
++      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
++      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
++    ],
++    votes: [
++      moVoteRow({
++        id: 'vote-dup-1', bill_id: 'bill-dup-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
++      }),
++      moVoteRow({
++        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
++      }),
++    ],
++    vote_casts: [
++      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
++      castRow('c2', 'vote-ls-1', 'yea', 'L1'),
++    ],
++  });
++
++  const report = await runCorrectMo2026SessionMerge(client, { dryRun: false, runId: 'run-1' });
++
++  assert.equal(report.merge.billsMerged, 1);
++  assert.equal(report.merge.sessionDeleted, true);
++  assert.equal(report.reconciliation.votesChecked, 1);
++  assert.equal(report.reconciliation.cleanMatches, 1);
++  assert.deepEqual(report.failures, []);
++});
++
++test('runCorrectData: "mo-2026-session-merge" runs only when explicitly named — "all" never sweeps it in, given its higher stakes (deletes + FK redirects)', async () => {
++  const seed = {
++    sessions: [CANON, DUP],
++    bills: [
++      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
++      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
++    ],
++    votes: [],
++  };
++
++  const explicit = await runCorrectData(makeFakeClient(seed), { which: 'mo-2026-session-merge', dryRun: true });
++  assert.ok(explicit.mo2026SessionMerge);
++
++  const all = await runCorrectData(makeFakeClient(seed), { which: 'all', dryRun: true });
++  assert.equal(all.mo2026SessionMerge, undefined, '"all" must never run the session-merge correction implicitly');
++  assert.equal(all.moStatus !== undefined && all.mo1969Dates !== undefined, true, 'the other two corrections are unaffected');
++});
diff --git a/.superpowers/sdd/2026-08-01-mo-2026-session-merge/task-review.md b/.superpowers/sdd/2026-08-01-mo-2026-session-merge/task-review.md
new file mode 100644
index 0000000..ddd5e93
--- /dev/null
+++ b/.superpowers/sdd/2026-08-01-mo-2026-session-merge/task-review.md
@@ -0,0 +1,354 @@
+# Task review — da69a44 `mo-2026-session-merge` (TODO 25)
+
+Reviewer: independent task-review agent, 2026-08-01. Gate: is it safe to hand the operator the
+live command?
+
+- **Spec verdict: MEETS SPEC.** Every clause of `brief.md` is implemented, including the
+  discretionary ones (excluded from `all`, `bill_actions` added defensively, dry-run-and-stop).
+- **Quality verdict: GOOD.** Deletion path is genuinely defensive and fail-safe at the DB level.
+  Two real divergences from the live comparison it claims to reuse (both latent in this batch),
+  one un-rerunnable-Phase-B hazard, and a public-rendering consequence the brief never considered.
+- **SHIP** — with a mandatory operator briefing (see "Before the operator runs it").
+
+## Test suite (run by this reviewer, bare `node --test` from repo root)
+
+```
+ℹ tests 2131
+ℹ suites 0
+ℹ pass 2131
+ℹ fail 0
+ℹ cancelled 0
+ℹ skipped 0
+ℹ todo 0
+ℹ duration_ms 21813.0447
+```
+
+Matches the claim (2131 = 2114 baseline + 17 new).
+
+---
+
+## Q2 — The deletion safety chain
+
+**(a) Does a duplicate bill ever get deleted before its vote redirect is confirmed complete? NO.**
+
+`src/cli/correct-data.js:519-651` (`processDuplicateBill`) executes strictly in this order, with an
+early `return` on every failure:
+
+1. `:520` twin lookup (exact `identifier` + canonical `session_id`); `!== 1` → `stopped`, no writes.
+2. `:534-552` four live count-only checks; any non-zero → `stopped`, no writes.
+3. `:554` select the dup bill's votes.
+4. `:582` **dry-run returns here** — before any write.
+5. `:601` `UPDATE votes SET bill_id=canonical WHERE bill_id=dup` (single statement).
+6. `:613` **live re-count** `votes WHERE bill_id = dup`; `> 0` → `failed` (`vote_redirect_incomplete`),
+   **no delete**.
+7. `:632` `DELETE bills WHERE id = dup RETURNING id`; `length !== 1` → `failed`
+   (`bill_delete_guard_mismatch`).
+
+The delete at `:632` is unreachable unless the live re-count at `:613` returned 0. Correct.
+
+**(b) TOCTOU on the related-table checks — a real gap, but fail-safe at the database level.**
+
+The four `bill_texts`/`bill_sponsors`/`summaries`/`bill_actions` counts (`:534-552`) run *before*
+the vote redirect and are **not** re-checked immediately before the delete at `:632`. A concurrent
+writer inserting into one of those tables in that window would not be caught by application logic.
+
+It is nonetheless safe, because the schema makes it fail closed. I enumerated **every** FK to
+`bills(id)` across all migrations:
+
+| Table | Migration | On delete |
+|---|---|---|
+| `bill_actions` | `0001_core_schema.sql:56` | (default NO ACTION) |
+| `bill_texts` | `0001_core_schema.sql:66` | (default NO ACTION) |
+| `votes` | `0001_core_schema.sql:78` | (default NO ACTION) |
+| `summaries` | `0001_core_schema.sql:100` | (default NO ACTION) |
+| `bill_sponsors` | `0014_bill_sponsors.sql:17` | (default NO ACTION) |
+
+That is exactly the four in `DUP_BILL_MUST_BE_EMPTY_TABLES` (`:503`) plus `votes` (redirected).
+**No FK anywhere declares `ON DELETE CASCADE`**, so a race-inserted child row makes the `DELETE`
+raise `23503` rather than silently destroying data — caught at `:633` and reported as
+`bill_delete_failed`. Coverage is complete and the residual race is fail-safe, not data-losing.
+
+**(c) Is the session delete guarded by a live re-count? YES.**
+
+`:745-747` issues a fresh `count: 'exact', head: true` on `bills WHERE session_id = dup.id`
+immediately before the delete at `:750`. It does **not** use `sessionDeletionEligible` (the
+in-memory bookkeeping at `:741`) as the gate — that value is reported only. `remainingBillCount > 0`
+→ no delete, no failure (`:760-762`), which is the guard behaving correctly. `sessions(id)` is
+referenced only by `bills(session_id)` (`0001_core_schema.sql:45`), so an empty bill count is a
+complete precondition, and that FK is also NO ACTION, so a raced bill insert fails the delete
+rather than orphaning it.
+
+**(d) Does one bad bill corrupt the batch? NO.**
+
+`processDuplicateBill` returns a tagged result object per bill; the driver loop (`:723-734`) routes
+it to `merges` / `stopped` / `failures` and continues. Verified by tests at
+`tests/correct-data.test.js:732` (no twin) and `:754` (non-zero related table) — the offending bill
+survives, the run continues, and `sessionDeletionEligible` goes false.
+
+Caveat: `processDuplicateBill` has no `try/catch`. supabase-js returns `{error}` for query errors
+(handled), but a *transport* rejection (network blip) propagates and aborts the loop mid-run. The
+partial state is safe and the run is idempotent-forward, so a re-run finishes the job. Minor.
+
+## Q3 — The one-request / atomicity invariant
+
+**No orphan is reachable.** The redirect (`:601`) is a single `UPDATE ... WHERE bill_id = <dup>` —
+all-or-nothing in Postgres. The delete happens only after a *separate live* confirmation that zero
+votes remain. Every crash point leaves a consistent, forward-recoverable state:
+
+| Dies… | State | Re-run |
+|---|---|---|
+| before redirect | dup bill + its votes intact | re-merges cleanly |
+| after redirect, before delete | dup bill with 0 votes | re-processes; re-count is 0; deletes |
+| after bill delete, before session delete | session with N−k bills | live recount blocks delete until 0 |
+| mid-Phase-B | Phase A fully applied | see Important 2 below |
+
+`--limit` cannot strand anything: it caps *which bills* are processed, and each bill is redirected
+in full before its own delete. A limited pass leaves the session non-empty, and `:745`'s recount
+correctly refuses the session delete (`tests/correct-data.test.js:799`). Bill ordering is
+deterministic (`:718`, sort by id).
+
+Nit (Minor): `redirectedCount` at `:611` uses `updatedVotes.length` rather than the `count` the
+same call requests. PostgREST's `db-max-rows` would truncate the RETURNING set on a very large
+redirect and under-report. Irrelevant at 31 rows, and it does not affect delete safety (the `:613`
+recount is the real guard) — reporting accuracy only.
+
+## Q4 — Forbidden-function check (verified independently, not from the test)
+
+`grep -rn "crossCheckAgainstPrimarySource\|retractLegiscanVoteIfStored" src/` — in
+`src/cli/correct-data.js` both identifiers appear **only** at lines 32, 35, 37, 335, 355, 787, and
+every one is inside a `//` comment explaining why they are *not* called. No import, no call.
+Confirmed clean.
+
+The enforcing test (`tests/correct-data.test.js:664`) is **adequate**:
+
+- Reads the right file: `new URL('../src/cli/correct-data.js', import.meta.url)` from `tests/` →
+  correct path (and it currently passes, which proves the path resolves).
+- `/\bcrossCheckAgainstPrimarySource\(/` catches direct calls **and** namespace calls
+  (`ls.crossCheckAgainstPrimarySource(` still contains the word boundary + paren).
+- `/import\s*\{[^}]*\bcrossCheckAgainstPrimarySource\b/` catches renamed named imports
+  (`{ crossCheckAgainstPrimarySource as x }`) because the original identifier still appears inside
+  the braces, and catches multi-line import blocks (`[^}]*` matches newlines).
+
+Evasion that would slip through: `const { crossCheckAgainstPrimarySource: f } = await import(...)`
+followed by `f()`, or reaching it through a *different* module. Both are contrived and the second
+is out of scope (the whole new code path lives in this one file). Good enough for its purpose.
+
+## Q5 — Reconciliation correctness vs. the live caller
+
+**Argument order and field mapping are correct — no swap.** Side-by-side against
+`legiscan-votes.js:679` (the live single-candidate branch):
+
+| | Live (`legiscan-votes.js`) | New (`correct-data.js`) | |
+|---|---|---|---|
+| call | `compareTalliesForCrossCheck(legiscanTallies, hardCompareCounts)` `:679` | `compareTalliesForCrossCheck(legiscanTallies, primaryCounts)` `:865` | order ✔ |
+| arg 1 shape | `{tallies:{yea,nay,not_voting,absent},chamber,date,runId,rollCallId}` | same, built `:855-862` | ✔ |
+| arg 2 shape | `summarizePrimaryCastPositions(castRows)` (6 keys) | same, `:853` | ✔ |
+| `source_a` | hardcoded `'legiscan'` inside `writeReconciliationFlag` `:527` | same function reused | ✔ |
+| `sourceB` | `primarySourceLabel(source_key)` → `'mo-senate-web'` | literal `'mo-senate-web'` `:898` | ✔ equal |
+| `voteId` | the **primary** row's id `:714` | `dupVote.id` (mo-senate-web) `:898` | ✔ same convention |
+| `rollCallId` | `legiscanTallies.rollCallId` | parsed back out of the LegiScan `source_key` `:495-500` | ✔ inverse of `buildLegiscanVoteSourceKey` |
+| `reason` | `hard`/`soft_mismatch` `:712` | identical `:876` | ✔ |
+
+**Two real divergences from the live path (both latent in this batch, neither triggered):**
+
+1. **The `isPrimaryCastDataComparable` gate is not reproduced.** `legiscan-votes.js:652-670` runs
+   `parsePrimaryResultAggregate` + `isPrimaryCastDataComparable` **before** any hard/soft
+   comparison, precisely so a primary row whose casts have not landed yet is flagged
+   `primary_cast_data_not_comparable` rather than hard-flagged. `reconcileOneVote` (`:853-865`)
+   skips this entirely. Because mo-senate-web stores `result: null` unconditionally
+   (`legiscan-votes.js:408-410`), the gate degenerates to "zero casts ⇒ not comparable" for these
+   rows. I checked this live: **0 of the 29 flagged votes have zero primary casts**, so no flag in
+   this batch is mislabeled. It remains a latent semantic divergence if this code is reused.
+2. **`source_a_tallies` is derived from LegiScan's *stored casts*, not LegiScan's *printed*
+   roll-call tallies.** The live caller passes the payload's own tallies; the new code re-derives
+   them by counting `vote_casts` (`:854`). Additionally `:856-858` copies only
+   `yea/nay/not_voting/absent` out of the 6-key summary, so a LegiScan-side `present`/`other` cast
+   would silently vanish from the non-vote bucket and manufacture a soft mismatch. Not reachable
+   today (LegiScan's `VOTE_ID_MAP` only produces those four positions), but undocumented.
+
+**Minor shape divergence:** the live discrepancy payload includes a `quarantine` key
+(`legiscan-votes.js:709`); the new one omits it (`:868-875`). Anything reading flags for a
+`quarantine` field will see `undefined` on these 29 rows.
+
+**Idempotency: structurally guaranteed, but NOT exercised by any test.** `writeReconciliationFlag`'s
+own dedupe (`legiscan-votes.js:514-522`, keyed on vote_id/source_a/source_b/roll_call_id/reason) is
+reused unmodified, and separately Phase B can only ever see votes Phase A merged *in the same run*
+— so a second live run finds no duplicate session, reconciles nothing, and cannot double-flag. No
+new test calls `runReconcileMo2026Votes` twice against the same fake client. See Important 2 for
+the flip side of that same structure.
+
+## Q6 — The 2 ambiguous cases
+
+**Confirmed: it genuinely refuses to guess.** `:816-826` returns `outcome: 'ambiguous'` with *both*
+candidates listed and never touches `writeReconciliationFlag`. Test at
+`tests/correct-data.test.js:962` asserts `flaggedCount 0` and an empty flags table. The live
+dry-run's own ambiguous case is real: vote `1e57a6cf…` on bill `098dfd46…` has two same-day LegiScan
+roll calls (`legiscan-2239-rollcall-1641859` and `-1641860`, both 2026-02-23). Note this is a
+*weaker* disambiguation than the live system, which would try tally-identity selection
+(`legiscan-votes.js` FIX ROUND 2) — but "report, don't guess" is exactly what the brief asked for
+and is the conservative direction.
+
+## Q7 — `--dry-run` makes zero writes (re-verified by this reviewer against the live DB)
+
+I ran `runCorrectData(client, { which: 'mo-2026-session-merge', dryRun: true })` against the real
+database with a full before/after row-count snapshot on all ten affected tables:
+
+```
+BEFORE == AFTER (diff list empty):
+  sessions 33 | bills 38288 | votes 10006 | vote_casts 1466496
+  vote_reconciliation_flags 17 | ingestion_runs 465
+  bill_texts 3630 | bill_sponsors 46268 | summaries 213 | bill_actions 831
+  duplicate session '2026' (4b75c3d3-…) still present, still owns 34 bills
+```
+
+Structurally too: `processDuplicateBill` returns at `:582` before any write; the session-delete
+block is inside `if (!dryRun)` (`:744`); `reconcileOneVote` returns at `:888` before
+`writeReconciliationFlag`. And `main()` skips `openRun` entirely on `--dry-run`, so **not even an
+`ingestion_runs` row is written** (confirmed: 465 → 465).
+
+Report reproduced identically to the commit message: 34/34 merged, 31 votes redirected,
+`sessionDeletionEligible: true`, `sessionDeleted: false`, 0 stopped, 0 failures; reconciliation
+0 clean / 29 hard_mismatch / 2 ambiguous / 0 no-match / 0 unparseable.
+
+## Q8 — File convention and `all` exclusion
+
+**Preserved.** `main()` (`src/cli/correct-data.js`, `---- main ----`) has exactly two paths: the
+`--dry-run` branch (no `openRun`, no writes) and the live branch, both reached only from
+`process.argv`. Nothing in `src/` or `tests/` invokes `runCorrectMo2026SessionMerge` live — the
+17 new tests all drive the in-memory fake. The `invokedDirectly` guard means importing the module
+never runs `main()`.
+
+**Excluded from `all`: confirmed.** `:923-928` gates on `which === 'mo-2026-session-merge'` only
+(the other two use `|| which === 'all'`), with the rationale in the comment. Pinned by
+`tests/correct-data.test.js:1049`, which asserts `all.mo2026SessionMerge === undefined`. Verified in
+the live dry-run too — a `which: 'all'` run would not have produced the merge report.
+
+## Q9 — Test quality
+
+The 17 new tests do pin the named dangerous edges: no canonical twin (`:732`), non-zero
+`bill_texts` on a dup bill (`:754`), the session-delete guard refusing a partial pass (`:799`),
+multiple reconciliation candidates (`:962`), zero candidates (`:945`), both dry-run zero-write
+paths (`:776`, `:989`), and the `all`-exclusion (`:1049`).
+
+**What they would NOT catch (Important 3 below):**
+
+- **The delete-ordering safety chain is not pinned.** No test drives `forceError` on the `votes`
+  update (or on the `:613` re-count) to prove the bill delete is *skipped*. The fake client already
+  supports `forceError`, so this was cheap. A regression that deleted the bill before redirecting
+  its votes would still pass `:696` — that test asserts the end state (vote redirected, bill gone)
+  and is order-blind.
+- No test for `vote_redirect_incomplete` (`:623`) or `bill_delete_guard_mismatch` (`:633`) — the two
+  guards standing between a redirect failure and a destructive delete.
+- No test for `multiple_canonical_twins` (`:530`), `unparseable` source_key (`:836`), or the
+  `session_bill_recount_failed` / `session_delete_failed` failure branches.
+- No re-run/idempotency test for the flag write.
+- `:656` asserts only 3 of the 4 entries in `DUP_BILL_MUST_BE_EMPTY_TABLES` — `bill_actions`, the
+  one added beyond the brief, is unpinned and could be silently dropped.
+
+---
+
+## Findings
+
+### Critical
+None. No path deletes anything without a live, immediately-preceding confirmation, and the schema
+has no cascading FK to turn a missed check into data loss.
+
+### Important
+
+1. **The merge publishes a known-contradictory pair of roll calls onto one public bill page.**
+   `site/js/bill-page.js:500` fetches `votes?bill_id=eq.<billId>`. Today the 31 mo-senate-web votes
+   hang off the duplicate bills; after Phase A they land on the canonical bills alongside LegiScan's
+   own vote for the same real floor action. 29 of those 31 pairs *disagree*. The public bill page
+   will therefore render two roll calls for one action with different tallies. The brief scopes
+   Phase B to "write a flag for Lance" and never considers that Phase A itself changes what the
+   site shows. This is an operator decision, not a code defect — but it must be made before the
+   live run, not after.
+
+2. **Phase B is one-shot and cannot be re-run after Phase A succeeds.** `runReconcileMo2026Votes`
+   (`:928`, driven from `:911`) only ever sees `merge.merges[].voteRows` — bills merged *in this
+   run*. Once the duplicate session is gone, a re-run merges nothing and reconciles nothing.
+   Combined with the fact that `writeReconciliationFlag` **throws** on an unexpected error
+   (`legiscan-votes.js:551`) and that throw is not caught in `reconcileOneVote` (`:897`), a single
+   transient DB error partway through the flag loop permanently loses the remaining reconciliations
+   with no re-run path. No data is lost (both votes survive); the *flags* are. Suggested mitigation
+   for the operator: none needed in code, but if the live run aborts mid-Phase-B, say so — do not
+   assume a re-run will finish it.
+
+3. **The deletion-ordering chain is untested** (detail in Q9). The safety property this whole review
+   turns on is the one property no test pins.
+
+4. **The live comparison is not byte-for-byte the live path** (detail in Q5, items 1–2). Latent
+   today, verified non-triggering in this batch (0 zero-cast primary rows).
+
+5. **Root cause is not fixed — the duplicate session will regrow.** The brief itself names
+   `ingest-mo-senate.js:472`'s `insertIfAbsent` as the creator of the `'2026'` row. Nothing in this
+   commit changes that. The next Senate-journal run re-creates the duplicate session and starts
+   re-accumulating duplicate bills. This correction is a cleanup, not a fix, and should be logged
+   as such in TODO.
+
+### Minor
+
+6. `:611` `redirectedCount` from `updatedVotes.length` instead of the requested `count` — reporting
+   only, no safety impact (`:613` is the real guard).
+7. `:601` overwrites `votes.run_id` with the correction run id, replacing the original ingest
+   provenance. Consistent with the file's other corrections, but worth knowing it is not reversible
+   from the row itself.
+8. `processDuplicateBill` has no `try/catch`; a transport-layer rejection aborts the loop (state
+   stays safe and forward-recoverable).
+9. Discrepancy payload omits the live shape's `quarantine` key (Q5).
+
+---
+
+## Diagnostic: what the 29 hard mismatches actually are
+
+Not asked for, but material to the operator decision, and it changes how the 29 flags should be
+read. I compared the two votes' `vote_casts` name-by-name across all 29 flagged pairs (read-only):
+
+```
+29x  travis fitzwater :: legiscan=yea, absent from the mo-senate-web record entirely
+21x  mary coleman      :: legiscan=yea  } same human, two legislators rows
+21x  mary elizabeth coleman :: primary=yea }  (cancels in the tallies)
+ 6x  rick brattin      :: primary=absent, absent from the LegiScan record
+ 5x  steven roberts    :: primary=absent, absent from the LegiScan record
+ 4x  mike moon         :: primary=nay,    absent from the LegiScan record
+ …
+```
+
+Two conclusions:
+
+- **All 29 hard mismatches are the same single defect**: LegiScan records a `yea` for Sen. Travis
+  Fitzwater on all 29 roll calls and the mo-senate-web journal parse has **no cast for him at all**
+  — exactly the "roster-gating / dropped unresolved-surname casts" undercount
+  `legiscan-votes.js:399-400` already documents for that pipeline. The compensating +1 in the
+  primary's non-vote bucket comes from assorted members LegiScan omits entirely. So this is 29 rows
+  recording one root cause, and the mo-senate-web side is the demonstrably incomplete one.
+- **Separately, the MO Senate roster is duplicated in `legislators`**: every senator has a
+  LegiScan-sourced row (party populated) and a mo-senate-web-sourced row (party `null`), plus at
+  least one name-variant pair ("Mary Coleman" / "Mary Elizabeth Coleman"). Casts for the same human
+  on the same real vote point at different rows depending on source. This does not affect the merge
+  or the tallies (it cancels), but it is a live identity defect worth its own TODO entry.
+
+The comparison machinery therefore did its job correctly — it found a real, systematic primary-source
+undercount. The flags are legitimate. They are just 29 instances of one thing.
+
+---
+
+## Verdict
+
+**SHIP** — the destructive path is safe to hand to the operator. Verified: no delete without an
+immediately-preceding live confirmation; complete FK coverage with no cascade anywhere; per-bill
+failure isolation; crash-safe and idempotent-forward at every step; genuine zero writes in
+`--dry-run` re-confirmed against the live DB; forbidden functions independently confirmed absent;
+excluded from `all`; nothing in the repo runs it live.
+
+### Before the operator runs it, tell him
+
+1. Phase A will put 31 mo-senate-web votes onto canonical bill pages next to LegiScan's own vote for
+   the same action, and 29 of those pairs disagree publicly. Decide what should happen to those 31
+   votes *before* running, not after (Important 1).
+2. All 29 mismatches are one root cause — Sen. Travis Fitzwater's `yea` missing from every
+   mo-senate-web roll call. The 29 flags are not 29 independent problems (Diagnostic).
+3. If the run aborts partway through Phase B, the remaining reconciliations cannot be recovered by
+   re-running the command (Important 2).
+4. The duplicate `'2026'` session will be re-created by the next `ingest-mo-senate` run — this
+   cleans up, it does not fix (Important 5).
diff --git a/src/adapters/legiscan-votes.js b/src/adapters/legiscan-votes.js
index d09eb19..8a8204b 100644
--- a/src/adapters/legiscan-votes.js
+++ b/src/adapters/legiscan-votes.js
@@ -403,32 +403,37 @@ export function summarizePrimaryCastPositions(castRows) {
 // nothing but the primary pipeline's own backlog.
 //
 // CONTROLLER AMENDMENT (final-review-findings.md, Finding 3): mo-house-xml.js's buildMoVoteRows
 // prints the vote's own complete aggregate as `result: "<yea>-<nay>"` at vote-creation time,
 // independent of whether casts have landed yet — prefer it for the hard comparison once available.
 // mo-senate-web (src/cli/ingest-mo-senate.js) stores result:null unconditionally by ruling (its
 // journal-PDF text has no equivalent aggregate line to parse); for those rows there is no aggregate
 // to fall back on, so zero casts is the only mechanically-detectable "not landed yet" signal.
 const PRIMARY_RESULT_AGGREGATE_PATTERN = /^(\d+)-(\d+)$/;
 
-function parsePrimaryResultAggregate(result) {
+// EXPORTED (2026-08-01, task-review.md Important 4 / this file's own header comment above):
+// correct-data.js's mo-2026-session-merge reconciliation phase reuses these two directly so a
+// primary row whose casts haven't landed yet (routine two-phase-ingestion backlog state, not an
+// anomaly) is never mistaken for a real hard mismatch — pure additive change, zero behavior change
+// to any existing caller.
+export function parsePrimaryResultAggregate(result) {
   if (typeof result !== 'string') return null;
   const m = PRIMARY_RESULT_AGGREGATE_PATTERN.exec(result.trim());
   if (!m) return null;
   return { yea: Number(m[1]), nay: Number(m[2]) };
 }
 
 // Never hard-quarantine (or hard-flag) on a primary row whose own cast data is incomplete relative
 // to its printed aggregate (mo-house shape — casts still short of aggregate.yea+aggregate.nay), or
 // whose aggregate is null (mo-senate shape) and casts are zero — the LITERAL two conditions the
 // controller amendment names.
-function isPrimaryCastDataComparable(aggregate, totalPrimaryCasts) {
+export function isPrimaryCastDataComparable(aggregate, totalPrimaryCasts) {
   if (aggregate) return totalPrimaryCasts >= (aggregate.yea + aggregate.nay);
   return totalPrimaryCasts > 0;
 }
 
 // compareTalliesForCrossCheck — FIX ROUND 1 (controller ruling): splits mismatches into two kinds,
 // deliberately treated differently by the caller:
 //   - HARD (yea/nay): both sources define these two categories identically and they determine the
 //     vote's outcome/attribution — a difference here is a REAL divergence, never explained away by
 //     a category-vocabulary quirk. Compared category-for-category, no caveat attached.
 //   - SOFT (the combined "non-yea/non-nay" bucket: LegiScan not_voting+absent vs primary
diff --git a/src/cli/correct-data.js b/src/cli/correct-data.js
index e652111..d782b9c 100644
--- a/src/cli/correct-data.js
+++ b/src/cli/correct-data.js
@@ -3,20 +3,22 @@ import {
 } from '../lib/db.js';
 import { parsePositiveIntegerFlag } from '../lib/errors.js';
 import { journalPdfBasename } from './ingest-mo-senate.js';
 import {
   PRIMARY_SOURCE_KEY_PREFIXES,
   sameCalendarDate,
   summarizePrimaryCastPositions,
   compareTalliesForCrossCheck,
   writeReconciliationFlag,
   PRESENT_CATEGORY_CAVEAT,
+  parsePrimaryResultAggregate,
+  isPrimaryCastDataComparable,
 } from '../adapters/legiscan-votes.js';
 
 // correct-data — data-correction CLI (.superpowers/sdd/2026-07-31-data-corrections/brief.md,
 // .superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md).
 // THREE REVERSIBLE-OR-CAREFULLY-GUARDED production-data corrections:
 //   A) mo-status: ~37,662 MO bills whose bills.status is a bare LegiScan numeric lifecycle code
 //      (ingest-legiscan.js/backfill-mo-bill-meta.js both stored `String(bill.status)` verbatim, by
 //      design at the time — "no house-style label mapping exists... inventing one would be a
 //      guess") instead of the printed word LegiScan's OWN manual documents for that code.
 //   B) mo-1969-dates: 10 `votes` rows carrying LegiScan's own 1969-12-31 missing-date sentinel
@@ -31,52 +33,82 @@ import {
 //      independently-recorded votes on the same now-merged bill, reusing (never reimplementing) the
 //      SAME comparison legiscan-votes.js's crossCheckAgainstPrimarySource already uses for its own
 //      17 live flags. HIGHER STAKES than A/B (deletes + FK redirects, not just in-place rewrites) —
 //      deliberately excluded from `all` below; an operator must name it explicitly.
 //      DOES NOT call crossCheckAgainstPrimarySource itself (that function is the live pre-store
 //      gate — both LegiScan votes here are already stored/public, not the scenario it decides) or
 //      retractLegiscanVoteIfStored (ingest-legiscan.js's own-documented ONE sanctioned delete,
 //      explicitly "never a precedent for a delete anywhere else in this repo") — Phase B only ever
 //      reads votes/casts and additively writes vote_reconciliation_flags rows, never a delete.
 //
+//      REVIEW FIX ROUND (task-review.md, 2026-08-01, SHIP verdict with two Important findings
+//      closed before the operator briefing):
+//        - Important 2: `writeReconciliationFlag` (a real DB call) is now wrapped in a per-vote
+//          try/catch inside the Phase B loop — an unexpected failure on one vote's flag write is
+//          recorded in `failures` (matching Phase A's own per-bill isolation) and the loop
+//          continues, never losing the remaining votes' flags. Separately, Phase B previously could
+//          only ever see votes merged in the SAME invocation (`merge.merges[].voteRows`) — once the
+//          duplicate session is gone, nothing re-discovers them. `runReconcileMo2026VotesStandalone`
+//          (new `mo-2026-vote-reconcile` <which> value) re-runs the identical comparison directly
+//          against already-merged mo-senate-web votes, found by their own source_key
+//          (`mo-senate-web-2026-*` — no dependency on the duplicate session or Phase A's in-memory
+//          result). `writeReconciliationFlag`'s own idempotency dedupe (reused unmodified) makes
+//          re-running it safe: already-written flags are found and skipped, never duplicated.
+//        - Important 4 (folded in, not deferred): the live path's own `isPrimaryCastDataComparable`
+//          gate (never hard-flag on a primary row whose casts haven't landed yet) is now reused here
+//          too — a `not_comparable` outcome, reported honestly, never written as a flag.
+//      Two smaller latent divergences from the live comparison (task-review.md Q5, item 2, and the
+//      `quarantine` key) are left as DOCUMENTED RESIDUALS, not folded in: `source_a_tallies` here is
+//      derived from LegiScan's stored `vote_casts` rather than the original dataset payload's
+//      printed tallies (this backfill only has the DB to work from, not the original LegiScan
+//      dataset fetch — re-deriving printed tallies would mean re-fetching LegiScan's archive, well
+//      outside a DB-only backfill's scope) and the discrepancy payload omits the live shape's
+//      `quarantine` key (Phase B never quarantines anything — there is nothing to quarantine, both
+//      votes are already stored — so the field would always be `false` and adds no information).
+//      Both are non-triggering against the live 31-vote batch (task-review.md confirmed 0/29 flagged
+//      votes had zero primary casts even before this fix; the diagnostic in task-review.md found all
+//      29 hard mismatches share one real root cause — a systematically dropped legislator on the
+//      mo-senate-web side — unrelated to either residual).
+//
 // DRAFT-THEN-APPLY (Global Constraints / CLAUDE.md standing policy): this CLI is built READY, with
 // a real --dry-run, but Lance runs the live pass himself — nothing in this repo invokes it live.
 //
 // CLI: `node --env-file=.env src/cli/correct-data.js <which> [--dry-run] [--limit N]`
-// `<which>` is REQUIRED (mo-status | mo-1969-dates | mo-2026-session-merge | all) — no default, so
-// an operator can never accidentally run every correction at once by omitting an argument.
+// `<which>` is REQUIRED (mo-status | mo-1969-dates | mo-2026-session-merge | mo-2026-vote-reconcile
+// | all) — no default, so an operator can never accidentally run every correction at once by
+// omitting an argument.
 
 const SOURCE = 'correct-data';
 
 // ---- args ----
 
 export function parseArgs(argv) {
   const out = { dryRun: false, limit: null, which: null };
   const positionals = [];
   let i = 0;
   while (i < argv.length) {
     const key = argv[i];
     if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
     if (key === '--limit') { out.limit = parsePositiveIntegerFlag(argv[i + 1], '--limit'); i += 2; continue; }
     if (key.startsWith('--')) throw new Error(`unknown flag: ${key}`);
     positionals.push(key);
     i += 1;
   }
   if (positionals.length !== 1) {
     throw new Error(
-      `correct-data: requires exactly one <which> argument (mo-status | mo-1969-dates | mo-2026-session-merge | all), got ${positionals.length} — `
+      `correct-data: requires exactly one <which> argument (mo-status | mo-1969-dates | mo-2026-session-merge | mo-2026-vote-reconcile | all), got ${positionals.length} — `
         + 'no default, so an operator can never accidentally run every correction at once',
     );
   }
   const [which] = positionals;
-  if (!['mo-status', 'mo-1969-dates', 'mo-2026-session-merge', 'all'].includes(which)) {
-    throw new Error(`correct-data: unknown <which> "${which}" — expected mo-status | mo-1969-dates | mo-2026-session-merge | all`);
+  if (!['mo-status', 'mo-1969-dates', 'mo-2026-session-merge', 'mo-2026-vote-reconcile', 'all'].includes(which)) {
+    throw new Error(`correct-data: unknown <which> "${which}" — expected mo-status | mo-1969-dates | mo-2026-session-merge | mo-2026-vote-reconcile | all`);
   }
   out.which = which;
   return out;
 }
 
 // ============================================================================================
 // Correction A — mo-status: numeric LegiScan status codes -> their printed words
 // ============================================================================================
 
 // MO_STATUS_WORD_MAP — SOURCED, not invented: LegiScan API User Manual, page 42
@@ -488,20 +520,30 @@ export const DUPLICATE_MO_2026_SESSION_IDENTIFIER = '2026';
 // (all confirmed zero on the duplicate side at brief-writing time, re-verified live below, never
 // trusted from the brief's own numbers). bill_actions is ALSO a bills(id) foreign key this brief's
 // prose doesn't name — added here defensively (same "never silently redirect a table this brief
 // didn't anticipate" spirit the brief states for the other three): if it's ever non-zero, this
 // STOPS and reports that bill too, exactly like the three named tables, rather than assuming its
 // silence means "safe to ignore."
 export const DUP_BILL_MUST_BE_EMPTY_TABLES = ['bill_texts', 'bill_sponsors', 'summaries', 'bill_actions'];
 
 const MO_JURISDICTION_ID = 'mo-legislature';
 
+// MO_SENATE_2026_VOTE_SOURCE_KEY_PREFIX — ingest-mo-senate.js's own buildVoteSourceKey format
+// (`mo-senate-web-${year}-${pdfBasename}-vote${ordinal}`, per legiscan-votes.js's own
+// PRIMARY_SOURCE_KEY_PREFIXES comment) scoped to the 2026 year specifically. Used two ways: (1) as
+// the defensive filter on votes Phase A itself just redirected (narrower and more precise than a
+// bare 'mo-senate-web-' prefix), and (2) as the STANDALONE discovery key for
+// runReconcileMo2026VotesStandalone below — a source_key is a durable, source-derived fact that
+// survives the duplicate session's own deletion, unlike depending on Phase A's in-memory merge
+// result (task-review.md Important 2).
+const MO_SENATE_2026_VOTE_SOURCE_KEY_PREFIX = 'mo-senate-web-2026-';
+
 // parseLegiscanRollCallSourceKey — the exact inverse of legiscan-votes.js's own
 // buildLegiscanVoteSourceKey('legiscan-<sessionId>-rollcall-<rollCallId>'), so Phase B never
 // guesses a LegiScan roll_call_id: it parses it back out of the LegiScan vote's own stored
 // source_key. Any source_key that doesn't cleanly match this exact shape returns null (an honest
 // "can't parse", counted separately below) rather than a best-effort guess.
 const LEGISCAN_ROLLCALL_SOURCE_KEY_PATTERN = /^legiscan-(\d+)-rollcall-(\d+)$/;
 export function parseLegiscanRollCallSourceKey(sourceKey) {
   const m = LEGISCAN_ROLLCALL_SOURCE_KEY_PATTERN.exec(String(sourceKey ?? ''));
   if (!m) return null;
   return { legiscanSessionId: m[1], rollCallId: m[2] };
@@ -834,20 +876,39 @@ async function reconcileOneVote(client, dupVote, { dryRun, runId }) {
   }
 
   const { data: primaryCastRows, error: primaryCastErr } = await client
     .from('vote_casts').select('position').eq('vote_id', dupVote.id);
   if (primaryCastErr) {
     return {
       outcome: 'failed',
       detail: { voteId: dupVote.id, reason: 'primary_casts_lookup_failed', error: String(primaryCastErr.message ?? primaryCastErr) },
     };
   }
+
+  // task-review.md Important 4 (folded in): the SAME gate crossCheckAgainstPrimarySource's own
+  // single-candidate branch runs BEFORE any hard/soft comparison — a primary (mo-senate-web) row
+  // whose casts have not landed yet relative to its own printed result aggregate (mo-house shape)
+  // or whose aggregate is null and casts are zero (mo-senate-web shape, since it stores result:null
+  // unconditionally) is NOT COMPARABLE. Comparing against an undercounted castRows summary would
+  // manufacture a false hard mismatch out of the primary pipeline's own backlog, not a real
+  // divergence — checked here BEFORE fetching the LegiScan side at all (also saves that query).
+  const primaryAggregate = parsePrimaryResultAggregate(dupVote.result);
+  const totalPrimaryCasts = (primaryCastRows ?? []).length;
+  if (!isPrimaryCastDataComparable(primaryAggregate, totalPrimaryCasts)) {
+    return {
+      outcome: 'not_comparable',
+      detail: {
+        voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, totalPrimaryCasts, result: dupVote.result ?? null,
+      },
+    };
+  }
+
   const { data: legiscanCastRows, error: legiscanCastErr } = await client
     .from('vote_casts').select('position').eq('vote_id', legiscanVote.id);
   if (legiscanCastErr) {
     return {
       outcome: 'failed',
       detail: { voteId: dupVote.id, reason: 'legiscan_casts_lookup_failed', error: String(legiscanCastErr.message ?? legiscanCastErr) },
     };
   }
 
   const primaryCounts = summarizePrimaryCastPositions(primaryCastRows ?? []);
@@ -887,78 +948,132 @@ async function reconcileOneVote(client, dupVote, { dryRun, runId }) {
 
   if (dryRun) {
     return {
       outcome: 'flagged',
       detail: {
         voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, reason, discrepancy, wouldWrite: true,
       },
     };
   }
 
-  const flag = await writeReconciliationFlag(client, {
-    voteId: dupVote.id, sourceB: 'mo-senate-web', discrepancy, runId, rollCallId: parsedRollCall.rollCallId, reason,
-  });
-
-  return {
-    outcome: 'flagged',
-    detail: {
-      voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, reason, flag,
-    },
-  };
+  // task-review.md Important 2: writeReconciliationFlag is a real DB call and THROWS on an
+  // unexpected error (legiscan-votes.js's own doc comment on it — a missing-relation is handled
+  // internally, but anything else propagates). Uncaught, that would abort this WHOLE loop mid-batch
+  // and silently lose every remaining vote's reconciliation with no re-run path (Phase B could only
+  // ever see votes merged in the SAME invocation before runReconcileMo2026VotesStandalone existed).
+  // Caught here and turned into a per-vote `failed` result — matching Phase A's own per-bill
+  // isolation pattern exactly — so ONE flag-write failure never loses the rest of the batch, and a
+  // later re-run (live, or via the standalone entry point) can pick up exactly the vote that failed
+  // without re-writing (writeReconciliationFlag's own idempotency dedupe, reused unmodified) the
+  // ones that already succeeded.
+  try {
+    const flag = await writeReconciliationFlag(client, {
+      voteId: dupVote.id, sourceB: 'mo-senate-web', discrepancy, runId, rollCallId: parsedRollCall.rollCallId, reason,
+    });
+    return {
+      outcome: 'flagged',
+      detail: {
+        voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, reason, flag,
+      },
+    };
+  } catch (err) {
+    return {
+      outcome: 'failed',
+      detail: {
+        voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, reason: 'flag_write_failed', error: String(err.message ?? err),
+      },
+    };
+  }
 }
 
-// runReconcileMo2026Votes — Phase B driver. Only ever looks at mo-senate-web-prefixed votes among
-// `mergedBills[].voteRows` (defensive: the brief's live verification found all 31 redirected votes
-// were mo-senate-web, but this never assumes that holds forever) — never touches a vote this run
-// didn't itself just merge.
-export async function runReconcileMo2026Votes(client, {
-  dryRun = false, runId = null, mergedBills = [],
-} = {}) {
-  const votesToCheck = mergedBills.flatMap((m) => (m.voteRows ?? [])
-    .filter((v) => String(v.source_key ?? '').startsWith('mo-senate-web-')));
-
+// reconcileVoteBatch — the shared Phase B loop, extracted (task-review.md Important 2) so BOTH the
+// same-run path (runReconcileMo2026Votes, fed by Phase A's own merge output) and the standalone
+// re-run path (runReconcileMo2026VotesStandalone, fed by an independent DB query) drive the exact
+// SAME per-vote logic — never two copies that could drift. `not_comparable` (Important 4) is its
+// own honest bucket, distinct from both `clean` (verified matching) and `flagged` (a real
+// discrepancy) — never written to the DB, never counted as either.
+async function reconcileVoteBatch(client, votesToCheck, { dryRun, runId }) {
   const cleanMatchDetails = [];
   const flagged = [];
   const noMatch = [];
   const ambiguous = [];
   const unparseable = [];
+  const notComparable = [];
   const failures = [];
 
   for (const dupVote of votesToCheck) {
     // eslint-disable-next-line no-await-in-loop -- sequential over at most a few dozen votes (brief:
     // 31), same "small/infrequent backlog" precedent as the rest of this file.
     const result = await reconcileOneVote(client, dupVote, { dryRun, runId });
     if (result.outcome === 'clean') cleanMatchDetails.push(result.detail);
     else if (result.outcome === 'flagged') flagged.push(result.detail);
     else if (result.outcome === 'no_match') noMatch.push(result.detail);
     else if (result.outcome === 'ambiguous') ambiguous.push(result.detail);
     else if (result.outcome === 'unparseable') unparseable.push(result.detail);
+    else if (result.outcome === 'not_comparable') notComparable.push(result.detail);
     else failures.push(result.detail);
   }
 
   return {
     votesChecked: votesToCheck.length,
     cleanMatches: cleanMatchDetails.length,
     flaggedCount: flagged.length,
     noMatchCount: noMatch.length,
     ambiguousCount: ambiguous.length,
     unparseableCount: unparseable.length,
+    notComparableCount: notComparable.length,
     cleanMatchDetails,
     flagged,
     noMatch,
     ambiguous,
     unparseable,
+    notComparable,
     failures,
   };
 }
 
-// runCorrectMo2026SessionMerge — Phase A then Phase B, combined report + combined failures.
+// runReconcileMo2026Votes — Phase B, same-run path. Only ever looks at 2026 mo-senate-web votes
+// among `mergedBills[].voteRows` (defensive: the brief's live verification found all 31 redirected
+// votes were mo-senate-web, but this never assumes that holds forever) — never touches a vote this
+// run didn't itself just merge.
+export async function runReconcileMo2026Votes(client, {
+  dryRun = false, runId = null, mergedBills = [],
+} = {}) {
+  const votesToCheck = mergedBills.flatMap((m) => (m.voteRows ?? [])
+    .filter((v) => String(v.source_key ?? '').startsWith(MO_SENATE_2026_VOTE_SOURCE_KEY_PREFIX)));
+  return reconcileVoteBatch(client, votesToCheck, { dryRun, runId });
+}
+
+// runReconcileMo2026VotesStandalone — Phase B, STANDALONE re-run path (task-review.md Important 2:
+// "Phase B is one-shot and cannot be re-run after Phase A succeeds"). Once the duplicate session and
+// its bill rows are gone, `mergedBills[].voteRows` no longer exists for a later invocation to read —
+// so this discovers the SAME votes independently, straight from the DB, by their own durable
+// source_key (`mo-senate-web-2026-*`, ingest-mo-senate.js's own buildVoteSourceKey format) rather
+// than depending on Phase A's in-memory result. Runs the IDENTICAL reconcileOneVote/reconcileVoteBatch
+// logic (never a second copy) — safe to re-run even against votes already reconciled once, because
+// writeReconciliationFlag's own idempotency dedupe (reused unmodified, keyed on vote_id/source_a/
+// source_b/roll_call_id/reason) finds and returns the existing flag rather than duplicating it; a
+// prior partial failure (Important 2's flag_write_failed) simply completes on THIS pass instead.
+export async function runReconcileMo2026VotesStandalone(client, {
+  dryRun = false, limit = null, runId = null,
+} = {}) {
+  const { data: rows, error } = await selectAll(client, 'votes', 'id,bill_id,chamber,vote_date,source_key,result', {
+    filter: (q) => q.eq('jurisdiction_id', MO_JURISDICTION_ID).like('source_key', `${MO_SENATE_2026_VOTE_SOURCE_KEY_PREFIX}%`),
+  });
+  if (error) throw new Error(`mo-2026-vote-reconcile: standalone vote lookup failed: ${error.message}`);
+  const sorted = [...(rows ?? [])].sort((a, b) => (a.id > b.id ? 1 : -1));
+  const scoped = limit != null ? sorted.slice(0, limit) : sorted;
+  return reconcileVoteBatch(client, scoped, { dryRun, runId });
+}
+
+// runCorrectMo2026SessionMerge — Phase A then Phase B (same-run path), combined report + combined
+// failures.
 export async function runCorrectMo2026SessionMerge(client, {
   dryRun = false, limit = null, runId = null,
 } = {}) {
   const merge = await runMergeMo2026Session(client, { dryRun, limit, runId });
   const reconciliation = await runReconcileMo2026Votes(client, { dryRun, runId, mergedBills: merge.merges });
   return {
     merge, reconciliation, failures: [...merge.failures, ...reconciliation.failures],
   };
 }
 
@@ -980,20 +1095,28 @@ export async function runCorrectData(client, {
     out.mo1969Dates = await runCorrectMo1969Dates(client, { dryRun, limit, runId });
     failures.push(...out.mo1969Dates.failures);
   }
   // Deliberately EXCLUDED from 'all' (brief, explicit): bill/session merge + FK redirect + guarded
   // deletes is higher-stakes than A/B's in-place rewrites — an operator must name this one, never
   // sweep it in by omission.
   if (which === 'mo-2026-session-merge') {
     out.mo2026SessionMerge = await runCorrectMo2026SessionMerge(client, { dryRun, limit, runId });
     failures.push(...out.mo2026SessionMerge.failures);
   }
+  // mo-2026-vote-reconcile — the standalone Phase B re-run (task-review.md Important 2), for after
+  // the duplicate session is already gone (a live mo-2026-session-merge pass either succeeded fully,
+  // or aborted partway through Phase B and left some reconciliations undone). Also excluded from
+  // `all`: it only makes sense to run once the merge has already happened.
+  if (which === 'mo-2026-vote-reconcile') {
+    out.mo2026VoteReconcile = await runReconcileMo2026VotesStandalone(client, { dryRun, limit, runId });
+    failures.push(...out.mo2026VoteReconcile.failures);
+  }
 
   out.failures = failures;
   return out;
 }
 
 // ---- main ----
 
 async function main() {
   const args = parseArgs(process.argv.slice(2));
   const client = getClient();
diff --git a/tests/correct-data.test.js b/tests/correct-data.test.js
index b0ae5c2..94867a3 100644
--- a/tests/correct-data.test.js
+++ b/tests/correct-data.test.js
@@ -11,20 +11,21 @@ import {
   parseMoSenateJournalDateFromUrl,
   VOTE_DATE_1969_SENTINEL,
   runCorrectMoStatus,
   runCorrectMo1969Dates,
   runCorrectData,
   CANONICAL_MO_2026_SESSION_IDENTIFIER,
   DUPLICATE_MO_2026_SESSION_IDENTIFIER,
   DUP_BILL_MUST_BE_EMPTY_TABLES,
   runMergeMo2026Session,
   runReconcileMo2026Votes,
+  runReconcileMo2026VotesStandalone,
   runCorrectMo2026SessionMerge,
 } from '../src/cli/correct-data.js';
 
 // Data-corrections CLI (.superpowers/sdd/2026-07-31-data-corrections/brief.md). Two REVERSIBLE
 // production-data corrections (both re-derivable from cached LegiScan datasets / the primary MO
 // Senate journal source), draft-then-apply — this test file proves the dry-run/live orchestration
 // logic entirely against a fake in-memory client; ZERO live DB writes anywhere in this file, and no
 // live run is ever performed from this repo (Lance's own separate explicit word, per the brief).
 
 // ---- fake Supabase-ish client: eq/in/order/limit + select/update/delete, thenable builder ----
@@ -88,21 +89,25 @@ function makeFakeClient(seed = {}, { forceError = null, afterExecute = null } =
           if (reject) reject(e); else throw e;
         }
       },
     };
 
     function execute() {
       const callInfo = {
         table, mode, patch, filters: [...filters], select: selectCols, selectOpts, orderCol, limitVal, rangeVal,
       };
       calls.push(callInfo);
-      const injected = forceError && forceError(table, mode, filters);
+      // 4th arg (selectOpts) is new — lets a test distinguish two calls that share the same
+      // table/mode/filters shape but differ in intent (e.g. a plain multi-row select vs. a
+      // count-only `head:true` recount against the SAME table/filter). Every EXISTING forceError
+      // callback in this file only reads the first 3 params, so this is purely additive.
+      const injected = forceError && forceError(table, mode, filters, selectOpts);
       if (injected) return { data: null, error: injected, count: null };
 
       const rows = tables[table];
       let matched = rows.filter((r) => matchesFilters(r, filters));
       let result;
 
       if (mode === 'select') {
         if (orderCol) {
           matched = [...matched].sort((a, b) => (a[orderCol] > b[orderCol] ? 1 : -1) * (orderAsc ? 1 : -1));
         }
@@ -142,21 +147,25 @@ function makeFakeClient(seed = {}, { forceError = null, afterExecute = null } =
 
   // makeInsertBuilder — only vote_reconciliation_flags (via legiscan-votes.js's own
   // writeReconciliationFlag, reused unmodified by the mo-2026-session-merge reconciliation phase)
   // ever inserts through this fake client. Mirrors tests/legiscan-votes.test.js's own
   // makeFakeVotesDb insert shape (`.insert(row).select().single()`) closely enough to drive that
   // real function's actual call chain, not a bespoke re-derivation of it.
   function makeInsertBuilder(table, row) {
     return {
       select: () => ({
         single: async () => {
-          const injected = forceError && forceError(table, 'insert', []);
+          // 4th arg (the row being inserted) is new — lets a test selectively fail ONE insert (e.g.
+          // "the flag write for vote-2 only") without a bespoke mock, by inspecting `row` inside its
+          // own forceError callback. Every EXISTING forceError callback in this file only reads the
+          // first 3 params, so this is purely additive.
+          const injected = forceError && forceError(table, 'insert', [], row);
           if (injected) return { data: null, error: injected };
           insertCounter += 1;
           const inserted = {
             id: `${table}-${insertCounter}`, resolved: false, created_at: 'test-time', ...row,
           };
           tables[table].push(inserted);
           calls.push({
             table, mode: 'insert', patch: row, filters: [], select: null, selectOpts: {}, orderCol: null, limitVal: null, rangeVal: null,
           });
           return { data: { ...inserted }, error: null };
@@ -1056,10 +1065,403 @@ test('runCorrectData: "mo-2026-session-merge" runs only when explicitly named 
     votes: [],
   };
 
   const explicit = await runCorrectData(makeFakeClient(seed), { which: 'mo-2026-session-merge', dryRun: true });
   assert.ok(explicit.mo2026SessionMerge);
 
   const all = await runCorrectData(makeFakeClient(seed), { which: 'all', dryRun: true });
   assert.equal(all.mo2026SessionMerge, undefined, '"all" must never run the session-merge correction implicitly');
   assert.equal(all.moStatus !== undefined && all.mo1969Dates !== undefined, true, 'the other two corrections are unaffected');
 });
+
+// ============================================================================================
+// Review fix round (task-review.md, 2026-08-01 — SHIP verdict, two Important findings closed
+// before the operator briefing): Important 2 (Phase B isolation + standalone re-run) and
+// Important 3 (the delete-ordering safety chain was previously untested). Important 4 (the
+// isPrimaryCastDataComparable gate) folded in too — see correct-data.js's own header comment for
+// the two smaller items left as documented residuals.
+// ============================================================================================
+
+// ---- Important 3: the delete-ordering chain, proven by test, not just read ----
+
+test('runMergeMo2026Session: the vote redirect UPDATE and its live re-count both complete BEFORE the bill DELETE fires — order-sensitive proof, not just an end-state assertion', async () => {
+  const client = makeFakeClient({
+    sessions: [CANON, DUP],
+    bills: [
+      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
+      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
+    ],
+    votes: [moVoteRow({
+      id: 'vote-dup-1', bill_id: 'bill-dup-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
+    })],
+  });
+
+  await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
+
+  const votesUpdateIdx = client.calls.findIndex((c) => c.table === 'votes' && c.mode === 'update' && c.patch?.bill_id === 'bill-canon-1');
+  const votesRecountIdx = client.calls.findIndex((c, i) => (
+    i > votesUpdateIdx && c.table === 'votes' && c.mode === 'select' && c.selectOpts.head
+    && c.filters.some((f) => f.op === 'eq' && f.col === 'bill_id' && f.val === 'bill-dup-1')
+  ));
+  const billDeleteIdx = client.calls.findIndex((c) => c.table === 'bills' && c.mode === 'delete');
+
+  assert.notEqual(votesUpdateIdx, -1, 'the redirect update call happened');
+  assert.notEqual(votesRecountIdx, -1, 'a live re-count select happened after the update');
+  assert.notEqual(billDeleteIdx, -1, 'the bill delete happened');
+  assert.ok(votesUpdateIdx < votesRecountIdx, 'redirect fires before the re-count');
+  assert.ok(votesRecountIdx < billDeleteIdx, 're-count fires before the delete — the delete never races ahead of its own guard');
+});
+
+test('runMergeMo2026Session: a race that inserts a NEW vote onto the duplicate bill between the redirect and the delete is caught by the LIVE re-count (not trusted from the update\'s own result) — bill reported vote_redirect_incomplete, never deleted', async () => {
+  const client = makeFakeClient(
+    {
+      sessions: [CANON, DUP],
+      bills: [
+        moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
+        moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
+      ],
+      votes: [moVoteRow({
+        id: 'vote-dup-1', bill_id: 'bill-dup-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
+      })],
+    },
+    {
+      afterExecute(callInfo, tables) {
+        // Right after the redirect UPDATE for bill-dup-1 executes (its own result already computed),
+        // a "concurrent writer" lands a brand-new vote row still pointing at the duplicate bill —
+        // the exact TOCTOU window task-review.md Q2(b) names. The re-count immediately after MUST
+        // see this, proving it is a fresh live query, not the update's own stale count.
+        if (callInfo.table === 'votes' && callInfo.mode === 'update' && callInfo.patch?.bill_id === 'bill-canon-1') {
+          tables.votes.push({
+            id: 'vote-raced-in', bill_id: 'bill-dup-1', chamber: 'senate', vote_date: '2026-02-24T00:00:00+00:00', jurisdiction_id: 'mo-legislature', source_key: 'mo-senate-web-2026-race-vote1', result: null,
+          });
+        }
+      },
+    },
+  );
+
+  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.billsMerged, 0);
+  assert.equal(report.failures.length, 1);
+  assert.equal(report.failures[0].reason, 'vote_redirect_incomplete');
+  assert.equal(report.failures[0].remaining, 1);
+  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), true, 'never deleted — the live re-count refused it');
+  assert.equal(client.calls.some((c) => c.table === 'bills' && c.mode === 'delete'), false, 'delete never even attempted');
+});
+
+test('runMergeMo2026Session: a forced failure on the vote redirect UPDATE for one bill reports that bill failed and NEVER deletes it, while a sibling bill in the same batch still merges cleanly (per-bill isolation on the redirect step specifically)', async () => {
+  const client = makeFakeClient(
+    {
+      sessions: [CANON, DUP],
+      bills: [
+        moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
+        moBillRow('bill-canon-2', 'sess-261', 'SB 2'),
+        moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
+        moBillRow('bill-dup-2', 'sess-2026', 'SB 2'),
+      ],
+      votes: [],
+    },
+    {
+      forceError: (table, mode, filters) => (
+        table === 'votes' && mode === 'update' && filters.some((f) => f.op === 'eq' && f.col === 'bill_id' && f.val === 'bill-dup-1')
+          ? { message: 'connection reset' }
+          : null
+      ),
+    },
+  );
+
+  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.billsMerged, 1, 'bill-dup-2 still merges despite bill-dup-1\'s redirect failure');
+  assert.equal(report.failures.length, 1);
+  assert.equal(report.failures[0].billId, 'bill-dup-1');
+  assert.equal(report.failures[0].reason, 'vote_redirect_failed');
+  assert.match(report.failures[0].error, /connection reset/);
+
+  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), true, 'never deleted — the redirect it depends on failed');
+  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-2'), false, 'the sibling bill was deleted normally — one bill\'s failure does not corrupt the batch');
+  assert.equal(report.sessionDeleted, false, 'session still owns bill-dup-1');
+});
+
+test('runMergeMo2026Session: a bill vanishing (raced away) between the live re-count and the delete itself is caught by the delete\'s own RETURNING-row guard, never silently treated as success', async () => {
+  const client = makeFakeClient(
+    {
+      sessions: [CANON, DUP],
+      bills: [
+        moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
+        moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
+      ],
+      votes: [],
+    },
+    {
+      afterExecute(callInfo, tables) {
+        // Simulates a concurrent process deleting bill-dup-1 itself in the window between the
+        // redirect re-count (which found 0 remaining votes, correctly) and this run's own delete.
+        if (callInfo.table === 'votes' && callInfo.mode === 'select' && callInfo.selectOpts.head
+          && callInfo.filters.some((f) => f.op === 'eq' && f.col === 'bill_id' && f.val === 'bill-dup-1')) {
+          tables.bills = tables.bills.filter((b) => b.id !== 'bill-dup-1');
+        }
+      },
+    },
+  );
+
+  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.billsMerged, 0);
+  assert.equal(report.failures.length, 1);
+  assert.equal(report.failures[0].reason, 'bill_delete_guard_mismatch');
+  assert.equal(report.failures[0].got, 0);
+});
+
+test('runMergeMo2026Session: two canonical rows sharing one identifier (defensive — the DB\'s own unique constraint should prevent this in production) is reported multiple_canonical_twins, never guessed at', async () => {
+  const client = makeFakeClient({
+    sessions: [CANON, DUP],
+    bills: [
+      moBillRow('bill-canon-1a', 'sess-261', 'SB 1'),
+      moBillRow('bill-canon-1b', 'sess-261', 'SB 1'),
+      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
+    ],
+    votes: [],
+  });
+
+  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.stopped.length, 1);
+  assert.equal(report.stopped[0].reason, 'multiple_canonical_twins');
+  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), true, 'never deleted — ambiguous, never guessed');
+});
+
+test('runMergeMo2026Session: a failed live re-count of the duplicate session\'s remaining bills is an honest failure, never silently treated as "safe to delete"', async () => {
+  const client = makeFakeClient(
+    {
+      sessions: [CANON, DUP],
+      bills: [moBillRow('bill-canon-1', 'sess-261', 'SB 1'), moBillRow('bill-dup-1', 'sess-2026', 'SB 1')],
+      votes: [],
+    },
+    {
+      // head:true disambiguates the FINAL recount (a count-only select) from the initial selectAll
+      // load of duplicate bills earlier in the same run, which shares the same table/filter shape
+      // but is a plain multi-row select, not a head-count.
+      forceError: (table, mode, filters, selectOpts) => (
+        table === 'bills' && mode === 'select' && selectOpts?.head
+        && filters.some((f) => f.op === 'eq' && f.col === 'session_id' && f.val === 'sess-2026')
+          ? { message: 'timeout' }
+          : null
+      ),
+    },
+  );
+
+  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.billsMerged, 1, 'the bill itself still merged');
+  assert.equal(report.sessionDeleted, false);
+  assert.ok(report.failures.some((f) => f.reason === 'session_bill_recount_failed'));
+  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), true, 'never deleted on an unconfirmed recount');
+});
+
+test('runMergeMo2026Session: a failed session DELETE (after a genuinely zero recount) is an honest failure, session row untouched', async () => {
+  const client = makeFakeClient(
+    {
+      sessions: [CANON, DUP],
+      bills: [moBillRow('bill-canon-1', 'sess-261', 'SB 1'), moBillRow('bill-dup-1', 'sess-2026', 'SB 1')],
+      votes: [],
+    },
+    {
+      forceError: (table, mode) => (table === 'sessions' && mode === 'delete' ? { message: 'lock timeout' } : null),
+    },
+  );
+
+  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.billsMerged, 1);
+  assert.equal(report.sessionDeleted, false);
+  assert.ok(report.failures.some((f) => f.reason === 'session_delete_failed'));
+  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), true);
+});
+
+test('DUP_BILL_MUST_BE_EMPTY_TABLES: all four entries are actually enforced, including bill_actions (the one the brief\'s own prose does not name) — not just bill_texts/bill_sponsors/summaries', async () => {
+  assert.deepEqual(DUP_BILL_MUST_BE_EMPTY_TABLES, ['bill_texts', 'bill_sponsors', 'summaries', 'bill_actions']);
+
+  const client = makeFakeClient({
+    sessions: [CANON, DUP],
+    bills: [
+      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
+      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
+    ],
+    bill_actions: [{
+      id: 'ba-1', bill_id: 'bill-dup-1', action_date: '2026-01-01', description: 'x',
+    }],
+    votes: [],
+  });
+
+  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.stopped.length, 1);
+  assert.equal(report.stopped[0].reason, 'non_zero_related_tables');
+  assert.deepEqual(report.stopped[0].nonZeroTables, [{ table: 'bill_actions', count: 1 }]);
+  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), true, 'never deleted — bill_actions alone is enough to stop it');
+});
+
+// ---- Important 2: Phase B per-vote flag-write isolation + standalone re-run ----
+
+test('runReconcileMo2026Votes: an unexpected writeReconciliationFlag failure for ONE vote is isolated — recorded in failures, does not lose the remaining votes\' flags; a clean re-run afterward completes the missing flag WITHOUT duplicating the ones that already wrote', async () => {
+  let allowVote2Failure = true;
+  const client = makeFakeClient(
+    {
+      votes: [
+        moVoteRow({
+          id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
+        }),
+        moVoteRow({
+          id: 'vote-ls-2', bill_id: 'bill-canon-2', vote_date: '2026-02-24T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641900',
+        }),
+        moVoteRow({
+          id: 'vote-ls-3', bill_id: 'bill-canon-3', vote_date: '2026-02-25T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1642000',
+        }),
+      ],
+      vote_casts: [
+        // each pair is a deliberate hard mismatch (legiscan has an extra yea caster) so every vote
+        // reaches the flag-write step.
+        castRow('c1', 'vote-dup-1', 'yea', 'L1'),
+        castRow('c2', 'vote-ls-1', 'yea', 'L1'),
+        castRow('c3', 'vote-ls-1', 'yea', 'L2'),
+        castRow('c4', 'vote-dup-2', 'yea', 'L1'),
+        castRow('c5', 'vote-ls-2', 'yea', 'L1'),
+        castRow('c6', 'vote-ls-2', 'yea', 'L2'),
+        castRow('c7', 'vote-dup-3', 'yea', 'L1'),
+        castRow('c8', 'vote-ls-3', 'yea', 'L1'),
+        castRow('c9', 'vote-ls-3', 'yea', 'L2'),
+      ],
+    },
+    {
+      forceError: (table, mode, filters, row) => (
+        table === 'vote_reconciliation_flags' && mode === 'insert' && row?.vote_id === 'vote-dup-2' && allowVote2Failure
+          ? { message: 'connection reset mid-write' }
+          : null
+      ),
+    },
+  );
+  const mergedBills = [{
+    voteRows: [
+      moVoteRow({
+        id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
+      }),
+      moVoteRow({
+        id: 'vote-dup-2', bill_id: 'bill-canon-2', vote_date: '2026-02-24T00:00:00+00:00', source_key: 'mo-senate-web-2026-y-vote1',
+      }),
+      moVoteRow({
+        id: 'vote-dup-3', bill_id: 'bill-canon-3', vote_date: '2026-02-25T00:00:00+00:00', source_key: 'mo-senate-web-2026-z-vote1',
+      }),
+    ],
+  }];
+
+  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
+
+  assert.equal(report.flaggedCount, 2, 'votes 1 and 3 still got their flags written despite vote 2 failing mid-batch');
+  assert.equal(report.failures.length, 1);
+  assert.equal(report.failures[0].voteId, 'vote-dup-2');
+  assert.equal(report.failures[0].reason, 'flag_write_failed');
+  assert.match(report.failures[0].error, /connection reset mid-write/);
+  assert.equal(client.tables.vote_reconciliation_flags.length, 2, 'votes 1 and 3 wrote; vote 2 did not');
+  assert.equal(client.tables.vote_reconciliation_flags.some((f) => f.vote_id === 'vote-dup-1'), true);
+  assert.equal(client.tables.vote_reconciliation_flags.some((f) => f.vote_id === 'vote-dup-3'), true);
+
+  // A clean re-run (the transient error has cleared) must complete the missing flag for vote-dup-2
+  // WITHOUT duplicating the two that already wrote — writeReconciliationFlag's own idempotency
+  // dedupe (reused unmodified) must hold through this plumbing.
+  allowVote2Failure = false;
+  const rerun = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-2', mergedBills });
+  assert.equal(rerun.flaggedCount, 3, 'all three report flagged on re-run (2 deduped, 1 newly written)');
+  assert.equal(rerun.failures.length, 0);
+  assert.equal(client.tables.vote_reconciliation_flags.length, 3, 'exactly 3 flag rows total — no duplicates for votes 1/3, the missing one for vote 2 now exists');
+});
+
+test('runReconcileMo2026VotesStandalone: re-runs the SAME reconciliation comparison directly against already-merged mo-senate-web-2026 votes, found by their own source_key — no Phase-A merge object needed (the concrete fix for "Phase B cannot be re-run once the duplicate session is gone")', async () => {
+  const client = makeFakeClient({
+    votes: [
+      moVoteRow({
+        id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
+      }),
+      // a DIFFERENT year's mo-senate-web vote — must NOT be swept in by the standalone query.
+      moVoteRow({
+        id: 'vote-other-year', bill_id: 'bill-canon-1', vote_date: '2018-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2018-x-vote1',
+      }),
+      moVoteRow({
+        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
+      }),
+    ],
+    vote_casts: [
+      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
+      castRow('c2', 'vote-dup-1', 'nay', 'L2'),
+      castRow('c3', 'vote-ls-1', 'yea', 'L1'),
+      castRow('c4', 'vote-ls-1', 'nay', 'L2'),
+    ],
+  });
+
+  const report = await runReconcileMo2026VotesStandalone(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.votesChecked, 1, 'only the 2026 mo-senate-web vote is picked up — the 2018 one is a different year, never swept in');
+  assert.equal(report.cleanMatches, 1);
+  assert.equal(client.tables.vote_reconciliation_flags.length, 0);
+});
+
+test('runReconcileMo2026VotesStandalone: --dry-run performs zero writes; --limit caps how many votes are checked', async () => {
+  const client = makeFakeClient({
+    votes: [
+      moVoteRow({
+        id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-a-vote1',
+      }),
+      moVoteRow({
+        id: 'vote-dup-2', bill_id: 'bill-canon-2', vote_date: '2026-02-24T00:00:00+00:00', source_key: 'mo-senate-web-2026-b-vote1',
+      }),
+    ],
+    vote_casts: [],
+  });
+
+  const limited = await runReconcileMo2026VotesStandalone(client, { dryRun: true, limit: 1 });
+  assert.equal(limited.votesChecked, 1);
+  assert.equal(client.tables.vote_reconciliation_flags.length, 0, 'dry-run never writes, even against a real DB query path');
+});
+
+test('runCorrectData: "mo-2026-vote-reconcile" is a distinct, explicit <which> value — also excluded from "all"', async () => {
+  const seed = {
+    votes: [
+      moVoteRow({
+        id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-a-vote1',
+      }),
+    ],
+    vote_casts: [],
+  };
+  const explicit = await runCorrectData(makeFakeClient(seed), { which: 'mo-2026-vote-reconcile', dryRun: true });
+  assert.ok(explicit.mo2026VoteReconcile);
+
+  const all = await runCorrectData(makeFakeClient(seed), { which: 'all', dryRun: true });
+  assert.equal(all.mo2026VoteReconcile, undefined);
+});
+
+// ---- Important 4 (folded in): the isPrimaryCastDataComparable gate ----
+
+test('reconcileOneVote (via runReconcileMo2026Votes): a primary (mo-senate-web) row whose casts have not landed yet is reported not_comparable, never mistaken for a real hard mismatch', async () => {
+  const client = makeFakeClient({
+    votes: [
+      moVoteRow({
+        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
+      }),
+    ],
+    vote_casts: [
+      // legiscan side fully cast; primary (mo-senate-web) side: ZERO casts landed yet.
+      castRow('c1', 'vote-ls-1', 'yea', 'L1'),
+      castRow('c2', 'vote-ls-1', 'nay', 'L2'),
+    ],
+  });
+  const mergedBills = [{
+    voteRows: [moVoteRow({
+      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1', result: null,
+    })],
+  }];
+
+  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
+
+  assert.equal(report.flaggedCount, 0, 'never hard-flags on incomplete primary cast data');
+  assert.equal(report.notComparableCount, 1);
+  assert.equal(client.tables.vote_reconciliation_flags.length, 0);
+});
