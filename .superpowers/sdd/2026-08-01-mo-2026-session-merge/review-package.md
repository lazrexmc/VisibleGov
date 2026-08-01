# Review package — TODO-25 session merge (5ecd938..da69a44)

da69a44 feat: mo-2026-session-merge correction CLI (TODO 25) — built, dry-run-verified against live DB, not run live

## Stat
 .../sdd/2026-08-01-mo-2026-session-merge/brief.md  | 128 +++++
 src/adapters/legiscan-votes.js                     |  13 +-
 src/cli/correct-data.js                            | 539 ++++++++++++++++++++-
 tests/correct-data.test.js                         | 482 +++++++++++++++++-
 4 files changed, 1145 insertions(+), 17 deletions(-)

## Full diff (-U10)
diff --git a/.superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md b/.superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md
new file mode 100644
index 0000000..e49596f
--- /dev/null
+++ b/.superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md
@@ -0,0 +1,128 @@
+# Task brief — TODO 25: merge the duplicate MO 2026 session
+
+Approved by Lance (2026-08-01: "make the corrections"), following a full controller investigation
+recorded in this session's transcript. Everything below is VERIFIED against live data, not assumed —
+re-verify at execution time anyway (the DB has grown since; do not hardcode counts).
+
+## The defect
+
+`sessions` has two rows for one real MO 2026 session:
+- `'261'` (canonical): `legiscan_session_id=2239`, LegiScan-sourced, ~3,162 bills.
+- `'2026'` (duplicate): `legiscan_session_id=NULL` — the only MO session missing one — created by
+  `ingest-mo-senate.js:472`'s own `insertIfAbsent` on every Senate-journal run, independent of the
+  LegiScan-sourced row. ~34 bills as of this brief, actively growing.
+
+**Every one of the duplicate's bills already exists under the canonical session by exact identifier
+match** (verified: 34/34 collide, zero exceptions). `bill_texts`, `bill_sponsors`, `summaries` are
+all confirmed at zero on the duplicate side — nothing to redirect there. `votes` is the only table
+with real data hanging off the duplicate bills (31 rows, all `source_key` prefixed `mo-senate-web-`).
+
+## Two separable phases
+
+### Phase A — bill/session merge (mechanical, exact-match only, do this regardless of Phase B)
+
+For each duplicate bill (session `'2026'`):
+1. Find its canonical twin: `bills` row with the SAME `identifier`, `session_id` = the canonical
+   `'261'` row's id. This MUST be an exact string match — if a duplicate bill's identifier has no
+   canonical twin, STOP and report it (do not invent a merge target; do not fall back to creating
+   one). Re-verify live that this is still 34/34 — if it isn't, the fix must still work correctly
+   for whatever the real live set is.
+2. Redirect every `votes.bill_id` pointing at the duplicate bill to the canonical bill's id.
+3. Re-verify LIVE (never trust this brief's counts) that `bill_texts`/`bill_sponsors`/`summaries`
+   are still zero for this duplicate bill_id. If any are non-zero, STOP for that bill and report it
+   — do not silently redirect a table this brief didn't anticipate.
+4. Delete the duplicate bill row ONLY after confirming zero remaining references to its id anywhere
+   you touched (which, at minimum, means the `votes` redirect above completed and step 3's re-check
+   passed).
+5. After all 34 (or however many are live) are merged, delete the now-empty duplicate `'2026'`
+   session row — guarded by an explicit `.eq('id', dupSessionId)` re-check that its bill count is
+   genuinely zero first (never delete a session row that still owns bills).
+
+### Phase B — vote reconciliation (read-only on votes/casts, additive-only on flags, NO deletes)
+
+The 31 redirected votes are almost certainly the same real floor actions LegiScan already recorded
+independently (verified: all 31 share an exact calendar date with an existing LegiScan vote on the
+same now-merged bill; sampled 4 pairs — same real action, near-identical cast counts). This is NOT
+resolved by guessing/deleting — it's resolved by running the SAME reconciliation comparison this
+codebase already built, reviewed, and uses for 17 other open flags right now:
+`crossCheckAgainstPrimarySource` (`src/adapters/legiscan-votes.js`) and its private helpers.
+
+**Reuse, do not reimplement.** Add `export` to these currently-private functions in
+`legiscan-votes.js` (pure additive change — just the keyword, zero behavior change, verify the full
+suite stays green after this alone before writing anything new):
+`summarizePrimaryCastPositions`, `compareTalliesForCrossCheck`, `writeReconciliationFlag`,
+`sameCalendarDate`. `PRIMARY_SOURCE_KEY_PREFIXES` and `buildLegiscanVoteSourceKey` are already
+exported.
+
+**Do NOT call `crossCheckAgainstPrimarySource` itself or `retractLegiscanVoteIfStored`.** The first
+is designed to run BEFORE a LegiScan vote is written (it decides whether to store it); both
+LegiScan votes here are already stored and already public — running the live function against
+already-published data is not the scenario it was built for. The second is this repo's own-
+documented **ONE sanctioned delete, explicitly "never a precedent for a delete anywhere else in
+this repo"** (its own header comment) — Phase B must never invoke it, must never delete or modify
+either vote or its casts, regardless of what the comparison finds. A genuine hard mismatch, if one
+turns up, becomes a flag for Lance — not an automatic retraction. This backfill is a one-off
+comparison, not a live-ingest run, and does not get that function's sanctioned exception.
+
+For each of the (live-verified) redirected `mo-senate-web` votes, now on a merged bill_id:
+1. Find the matching LegiScan vote(s): `votes` where `bill_id` = this vote's (now-merged) bill_id,
+   `jurisdiction_id='mo-legislature'`, same `chamber`, `source_key` starting `'legiscan-'`, and
+   `sameCalendarDate` true against this vote's own `vote_date`. Handle 0 matches (report, no flag —
+   nothing to compare against) and >1 matches (report as ambiguous, same spirit as the live system's
+   own multi-candidate handling — do not guess which one corresponds) honestly; do not silently pick
+   one.
+2. On exactly one match: pull both votes' own `vote_casts`, summarize each via
+   `summarizePrimaryCastPositions` (it's generic over any `position` set, not primary-source-
+   specific — reuse it for the LegiScan side too). Build the `legiscanTallies`-shaped input
+   (`{ tallies: {yea,nay,not_voting,absent}, chamber, date, runId, rollCallId }` — parse
+   `rollCallId` back out of the LegiScan vote's own `source_key`, format
+   `legiscan-<sessionId>-rollcall-<rollCallId>`, matching `buildLegiscanVoteSourceKey`'s own
+   format exactly — never guess it).
+3. Run `compareTalliesForCrossCheck(legiscanTallies, primaryCounts)`.
+4. **Clean match (0 hard, 0 soft mismatches): write NOTHING** — this mirrors
+   `crossCheckAgainstPrimarySource`'s own clean-match branch exactly (`matched:true, flag:null`).
+   Report it as confirmed-same-event for Lance's visibility, no DB write.
+5. **Any mismatch: write a `vote_reconciliation_flags` row** via the reused `writeReconciliationFlag`
+   (idempotent — it already re-checks for an existing identical flag before inserting, do not
+   duplicate that check). `voteId` = the mo-senate-web vote's own id (matches the live system's
+   convention: `vote_id` always points at the PRIMARY-source row). `sourceB = 'mo-senate-web'`.
+   `reason` = `'hard_mismatch'` or `'soft_mismatch'` — reuse the SAME vocabulary the live system
+   uses (the discrepancy shape is identical; inventing a new reason string would fragment reporting
+   that already reads these two values). `discrepancy` shape matches the live system's own
+   (`source_a_tallies`, `source_b_tallies`, `source_b_result`, `source_b_vote_id`,
+   `source_b_source_key`, `hard_mismatches`, `soft_mismatches`, plus `PRESENT_CATEGORY_CAVEAT` when
+   `softMismatches.length > 0` — same field, already exported as a constant).
+
+## CLI shape — fold into `correct-data.js`, matching its existing convention exactly
+
+Add `mo-2026-session-merge` as a third `<which>` value (alongside `mo-status`, `mo-1969-dates`,
+`all` — decide whether this new one joins `all` or stays deliberately excluded from it given its
+higher stakes; lean toward EXCLUDING it from `all` so it always requires being named explicitly,
+and say so in a comment). Same `--dry-run`/`--limit` flag shape, same `openRun`/`closeRun` source
+tagging, same honest-counts-object return shape as `runCorrectMoStatus`/`runCorrectMo1969Dates`.
+
+**This file's own header states the standing convention: "built READY... Lance runs the live pass
+himself — nothing in this repo invokes it live." Follow that convention exactly for this task too**
+— build it, verify thoroughly with `--dry-run` against the real live DB (report the full counts:
+bills merged, votes redirected, session deleted or not, reconciliation clean-matches vs flags
+written vs ambiguous/no-match cases), and STOP at dry-run verification. Do not run it live yourself.
+
+## Constraints
+
+- TDD red-first. Fixture/mock-client tests only — no live DB writes from tests. Given this touches
+  deletes and FK redirects, test the edge cases explicitly: a duplicate bill with no canonical twin
+  (must report, never invent one); a duplicate bill with non-zero bill_texts/sponsors/summaries
+  (must stop and report, never silently redirect); zero/one/multiple reconciliation candidates;
+  the session-delete guard refusing when bills remain.
+- `selectAll` for any multi-row read. Typed errors matching this repo's conventions.
+- Bare `node --test` from repo root; baseline currently 2114, must stay green (both after the
+  additive-export-only change AND after the new correction lands — verify both checkpoints).
+- Extract the literal `ℹ fail` line yourself; commit ONLY at 0 (lesson 14 — never gate on a
+  pipeline's exit status).
+- Commit message explains the defect and the fix, ends with:
+
+Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
+
+Return: status, commit hash, fail-count line verbatim, the FULL `--dry-run` output against the
+real live DB, and concerns — especially anything that surprised you about the live data versus
+what this brief assumed (re-verify, don't trust the brief's specific numbers).
diff --git a/src/adapters/legiscan-votes.js b/src/adapters/legiscan-votes.js
index 021c8c7..d09eb19 100644
--- a/src/adapters/legiscan-votes.js
+++ b/src/adapters/legiscan-votes.js
@@ -352,37 +352,42 @@ export const PRIMARY_SOURCE_KEY_PREFIXES = ['mo-house-xml-', 'mo-senate-web-'];
 // (source_a_tallies/source_b_tallies) are the actual evidence a human reviewer should weigh, not
 // this caveat standing in for that judgment.
 export const PRESENT_CATEGORY_CAVEAT = 'LegiScan\'s ls_vote schema has no distinct "Present" vote_id '
   + '(only Yea/Nay/NotVoting/Absent) while MO House\'s own roll-call PDFs print a distinct "Present" '
   + 'category (Y/N/P/@) — a disagreement in the combined non-yea/non-nay bucket below MAY be that '
   + 'category-vocabulary difference (an accounting difference, not a contradiction), but it can also '
   + 'be a genuine missing- or extra-voter defect on either side; this comparison alone cannot tell '
   + 'the two apart. The raw tallies recorded in this flag are the evidence — check for Present casts '
   + 'on the primary-source side, but do not assume that alone explains it.';
 
-function sameCalendarDate(a, b) {
+// EXPORTED (2026-08-01, .superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md): this and
+// summarizePrimaryCastPositions/compareTalliesForCrossCheck/writeReconciliationFlag below are the
+// pure-comparison/write helpers correct-data.js's mo-2026-session-merge reconciliation phase
+// reuses directly, rather than re-implementing the same tally/date comparison a second time. Pure
+// additive change — just the `export` keyword, zero behavior change to any existing caller.
+export function sameCalendarDate(a, b) {
   if (a == null || b == null) return false;
   return String(a).slice(0, 10) === String(b).slice(0, 10);
 }
 
 // primarySourceLabel — the flag row's `source_b` value: the matching prefix with its trailing
 // dash stripped ('mo-house-xml-' -> 'mo-house-xml'), or 'unknown-primary-source' for a source_key
 // that somehow passed the PRIMARY_SOURCE_KEY_PREFIXES filter but doesn't literally start with
 // either prefix (defensive — not reachable via this module's own filtering, but a flag row should
 // never silently mislabel its source if that ever changes). Shared by every branch below that
 // writes a flag against a specific primary-source candidate.
 function primarySourceLabel(sourceKey) {
   const matchedPrefix = PRIMARY_SOURCE_KEY_PREFIXES.find((prefix) => sourceKey.startsWith(prefix));
   return matchedPrefix ? matchedPrefix.replace(/-$/, '') : 'unknown-primary-source';
 }
 
-function summarizePrimaryCastPositions(castRows) {
+export function summarizePrimaryCastPositions(castRows) {
   const counts = {
     yea: 0, nay: 0, present: 0, absent: 0, not_voting: 0, other: 0,
   };
   for (const row of castRows) {
     const key = Object.prototype.hasOwnProperty.call(counts, row.position) ? row.position : 'other';
     counts[key] += 1;
   }
   return counts;
 }
 
@@ -425,21 +430,21 @@ function isPrimaryCastDataComparable(aggregate, totalPrimaryCasts) {
 // deliberately treated differently by the caller:
 //   - HARD (yea/nay): both sources define these two categories identically and they determine the
 //     vote's outcome/attribution — a difference here is a REAL divergence, never explained away by
 //     a category-vocabulary quirk. Compared category-for-category, no caveat attached.
 //   - SOFT (the combined "non-yea/non-nay" bucket: LegiScan not_voting+absent vs primary
 //     present+absent+not_voting+other): folded into ONE combined value rather than compared
 //     sub-bucket-by-sub-bucket, precisely BECAUSE of the Present-category caveat (comparing
 //     present/absent/not_voting 1:1 would manufacture false mismatches out of a real
 //     category-vocabulary difference between the two sources, not an actual data disagreement) — an
 //     accounting difference, not a contradiction (see PRESENT_CATEGORY_CAVEAT above).
-function compareTalliesForCrossCheck(legiscanTallies, primaryCounts) {
+export function compareTalliesForCrossCheck(legiscanTallies, primaryCounts) {
   const hardMismatches = [];
   if (legiscanTallies.tallies.yea !== primaryCounts.yea) {
     hardMismatches.push(`yea: legiscan ${legiscanTallies.tallies.yea} vs primary ${primaryCounts.yea}`);
   }
   if (legiscanTallies.tallies.nay !== primaryCounts.nay) {
     hardMismatches.push(`nay: legiscan ${legiscanTallies.tallies.nay} vs primary ${primaryCounts.nay}`);
   }
 
   const softMismatches = [];
   const legiscanNonVote = legiscanTallies.tallies.not_voting + legiscanTallies.tallies.absent;
@@ -494,21 +499,21 @@ async function findExistingReconciliationFlag(client, {
 }
 
 // writeReconciliationFlag — Draft-then-apply degradation (Global Constraints, plan doc): migration
 // 0010 (vote_reconciliation_flags) is draft-only until Lance applies it. A discrepancy detected
 // before that point is never silently dropped — it's returned with gated:true and the SAME
 // discrepancy payload, so a caller can log/report it even though it couldn't be durably recorded
 // yet; a re-run after the migration lands re-detects and this time persists it. `rollCallId`/
 // `reason` (both now REQUIRED, every call site below supplies them explicitly) are the idempotency
 // key described above — stamped onto the stored `discrepancy` itself (`roll_call_id`/`reason`
 // fields) so the key is self-describing to a human reviewer too, not just an internal lookup detail.
-async function writeReconciliationFlag(client, {
+export async function writeReconciliationFlag(client, {
   voteId, sourceB, discrepancy, runId, rollCallId, reason,
 }) {
   const keyedDiscrepancy = { ...discrepancy, roll_call_id: rollCallId, reason };
 
   const lookup = await findExistingReconciliationFlag(client, {
     voteId, sourceA: 'legiscan', sourceB, rollCallId, reason,
   });
   if (lookup.existing) {
     // IDEMPOTENT RE-RUN: the identical discrepancy (same vote, same LegiScan roll call, same
     // classification) was already durably recorded by a prior run — including if a human has since
diff --git a/src/cli/correct-data.js b/src/cli/correct-data.js
index ebe96a7..e652111 100644
--- a/src/cli/correct-data.js
+++ b/src/cli/correct-data.js
@@ -1,61 +1,82 @@
 import {
-  getClient, openRun, closeRun,
+  getClient, openRun, closeRun, selectAll,
 } from '../lib/db.js';
 import { parsePositiveIntegerFlag } from '../lib/errors.js';
 import { journalPdfBasename } from './ingest-mo-senate.js';
-import { PRIMARY_SOURCE_KEY_PREFIXES } from '../adapters/legiscan-votes.js';
+import {
+  PRIMARY_SOURCE_KEY_PREFIXES,
+  sameCalendarDate,
+  summarizePrimaryCastPositions,
+  compareTalliesForCrossCheck,
+  writeReconciliationFlag,
+  PRESENT_CATEGORY_CAVEAT,
+} from '../adapters/legiscan-votes.js';
 
-// correct-data — data-correction CLI (.superpowers/sdd/2026-07-31-data-corrections/brief.md).
-// Two REVERSIBLE production-data corrections (both re-derivable from cached LegiScan datasets /
-// the primary MO Senate journal source, which is exactly what makes them safe to draft):
+// correct-data — data-correction CLI (.superpowers/sdd/2026-07-31-data-corrections/brief.md,
+// .superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md).
+// THREE REVERSIBLE-OR-CAREFULLY-GUARDED production-data corrections:
 //   A) mo-status: ~37,662 MO bills whose bills.status is a bare LegiScan numeric lifecycle code
 //      (ingest-legiscan.js/backfill-mo-bill-meta.js both stored `String(bill.status)` verbatim, by
 //      design at the time — "no house-style label mapping exists... inventing one would be a
 //      guess") instead of the printed word LegiScan's OWN manual documents for that code.
 //   B) mo-1969-dates: 10 `votes` rows carrying LegiScan's own 1969-12-31 missing-date sentinel
 //      (legiscan-votes.js's LegiscanRollCallDateError header comment names these ten explicitly —
 //      "stored verbatim, exactly as designed... the correction of the rows already stored is
 //      Lance-gated and deliberately NOT done here [t]here").
+//   C) mo-2026-session-merge (TODO 25): the MO 2026 session is split across TWO `sessions` rows —
+//      '261' (canonical, LegiScan-sourced) and '2026' (duplicate, legiscan_session_id=NULL, created
+//      by ingest-mo-senate.js's own insertIfAbsent on every Senate-journal run). Phase A merges each
+//      duplicate bill into its exact-identifier canonical twin (redirecting votes, deleting the now-
+//      empty duplicate rows); Phase B reconciles the redirected mo-senate-web votes against LegiScan's
+//      independently-recorded votes on the same now-merged bill, reusing (never reimplementing) the
+//      SAME comparison legiscan-votes.js's crossCheckAgainstPrimarySource already uses for its own
+//      17 live flags. HIGHER STAKES than A/B (deletes + FK redirects, not just in-place rewrites) —
+//      deliberately excluded from `all` below; an operator must name it explicitly.
+//      DOES NOT call crossCheckAgainstPrimarySource itself (that function is the live pre-store
+//      gate — both LegiScan votes here are already stored/public, not the scenario it decides) or
+//      retractLegiscanVoteIfStored (ingest-legiscan.js's own-documented ONE sanctioned delete,
+//      explicitly "never a precedent for a delete anywhere else in this repo") — Phase B only ever
+//      reads votes/casts and additively writes vote_reconciliation_flags rows, never a delete.
 //
 // DRAFT-THEN-APPLY (Global Constraints / CLAUDE.md standing policy): this CLI is built READY, with
 // a real --dry-run, but Lance runs the live pass himself — nothing in this repo invokes it live.
 //
 // CLI: `node --env-file=.env src/cli/correct-data.js <which> [--dry-run] [--limit N]`
-// `<which>` is REQUIRED (mo-status | mo-1969-dates | all) — no default, so an operator can never
-// accidentally run every correction at once by omitting an argument.
+// `<which>` is REQUIRED (mo-status | mo-1969-dates | mo-2026-session-merge | all) — no default, so
+// an operator can never accidentally run every correction at once by omitting an argument.
 
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
-      `correct-data: requires exactly one <which> argument (mo-status | mo-1969-dates | all), got ${positionals.length} — `
+      `correct-data: requires exactly one <which> argument (mo-status | mo-1969-dates | mo-2026-session-merge | all), got ${positionals.length} — `
         + 'no default, so an operator can never accidentally run every correction at once',
     );
   }
   const [which] = positionals;
-  if (!['mo-status', 'mo-1969-dates', 'all'].includes(which)) {
-    throw new Error(`correct-data: unknown <which> "${which}" — expected mo-status | mo-1969-dates | all`);
+  if (!['mo-status', 'mo-1969-dates', 'mo-2026-session-merge', 'all'].includes(which)) {
+    throw new Error(`correct-data: unknown <which> "${which}" — expected mo-status | mo-1969-dates | mo-2026-session-merge | all`);
   }
   out.which = which;
   return out;
 }
 
 // ============================================================================================
 // Correction A — mo-status: numeric LegiScan status codes -> their printed words
 // ============================================================================================
 
 // MO_STATUS_WORD_MAP — SOURCED, not invented: LegiScan API User Manual, page 42
@@ -443,38 +464,536 @@ export async function runCorrectMo1969Dates(client, {
         voteId: row.id, reason: result.reason, error: String(result.error?.message ?? result.error),
       });
     }
   }
 
   return {
     seen: rows.length, deletedAsDuplicate, redatedFromSource, unresolvableDate, matches, failures,
   };
 }
 
+// ============================================================================================
+// Correction C — mo-2026-session-merge: the MO 2026 session split (TODO 25)
+// ============================================================================================
+//
+// CANONICAL_MO_2026_SESSION_IDENTIFIER / DUPLICATE_MO_2026_SESSION_IDENTIFIER — the brief's own
+// verified pair: '261' (legiscan_session_id=2239, LegiScan-sourced, the real session) vs '2026'
+// (legiscan_session_id=NULL — the only MO session missing one, created by ingest-mo-senate.js's
+// own ensureSessionRow/insertIfAbsent on every Senate-journal run, independent of the LegiScan
+// import). Named identifiers, not derived — this correction is scoped to exactly this one known
+// split, never a general "find any two sessions that look alike" heuristic.
+export const CANONICAL_MO_2026_SESSION_IDENTIFIER = '261';
+export const DUPLICATE_MO_2026_SESSION_IDENTIFIER = '2026';
+
+// DUP_BILL_MUST_BE_EMPTY_TABLES — the brief names bill_texts/bill_sponsors/summaries explicitly
+// (all confirmed zero on the duplicate side at brief-writing time, re-verified live below, never
+// trusted from the brief's own numbers). bill_actions is ALSO a bills(id) foreign key this brief's
+// prose doesn't name — added here defensively (same "never silently redirect a table this brief
+// didn't anticipate" spirit the brief states for the other three): if it's ever non-zero, this
+// STOPS and reports that bill too, exactly like the three named tables, rather than assuming its
+// silence means "safe to ignore."
+export const DUP_BILL_MUST_BE_EMPTY_TABLES = ['bill_texts', 'bill_sponsors', 'summaries', 'bill_actions'];
+
+const MO_JURISDICTION_ID = 'mo-legislature';
+
+// parseLegiscanRollCallSourceKey — the exact inverse of legiscan-votes.js's own
+// buildLegiscanVoteSourceKey('legiscan-<sessionId>-rollcall-<rollCallId>'), so Phase B never
+// guesses a LegiScan roll_call_id: it parses it back out of the LegiScan vote's own stored
+// source_key. Any source_key that doesn't cleanly match this exact shape returns null (an honest
+// "can't parse", counted separately below) rather than a best-effort guess.
+const LEGISCAN_ROLLCALL_SOURCE_KEY_PATTERN = /^legiscan-(\d+)-rollcall-(\d+)$/;
+export function parseLegiscanRollCallSourceKey(sourceKey) {
+  const m = LEGISCAN_ROLLCALL_SOURCE_KEY_PATTERN.exec(String(sourceKey ?? ''));
+  if (!m) return null;
+  return { legiscanSessionId: m[1], rollCallId: m[2] };
+}
+
+// processDuplicateBill — one duplicate bill (session '2026') -> 'merged' | 'stopped' | 'failed'.
+// Brief step 1: the canonical twin is found by an EXACT `identifier` match under the canonical
+// session — the `bills` table's own `unique (session_id, identifier)` constraint (migration 0001)
+// guarantees at most one twin can ever exist per session, so only 0-vs-1 needs handling here (>1
+// is unreachable given that constraint, but checked anyway — never assumed from a comment).
+// dryRun performs every READ this would (twin lookup, related-table counts, the vote rows that
+// WOULD be redirected) but never an update/delete — `voteRows` is still returned, projected onto
+// the canonical bill id, so Phase B can run its own read-only comparison against what a live pass
+// would actually produce.
+async function processDuplicateBill(client, dupBill, canonicalSessionId, { dryRun, runId }) {
+  const { data: twins, error: twinErr } = await client
+    .from('bills').select('id').eq('session_id', canonicalSessionId).eq('identifier', dupBill.identifier);
+  if (twinErr) {
+    return {
+      outcome: 'failed',
+      detail: {
+        billId: dupBill.id, identifier: dupBill.identifier, reason: 'twin_lookup_failed', error: String(twinErr.message ?? twinErr),
+      },
+    };
+  }
+  if (!twins || twins.length !== 1) {
+    return {
+      outcome: 'stopped',
+      detail: {
+        billId: dupBill.id,
+        identifier: dupBill.identifier,
+        reason: twins && twins.length > 1 ? 'multiple_canonical_twins' : 'no_canonical_twin',
+      },
+    };
+  }
+  const canonicalBillId = twins[0].id;
+
+  const nonZeroTables = [];
+  for (const table of DUP_BILL_MUST_BE_EMPTY_TABLES) {
+    // eslint-disable-next-line no-await-in-loop -- four small count-only checks per bill, same
+    // "small/infrequent, sequential" precedent as the rest of this file's per-row loops.
+    const { count, error } = await client
+      .from(table).select('id', { count: 'exact', head: true }).eq('bill_id', dupBill.id);
+    if (error) {
+      return {
+        outcome: 'failed',
+        detail: {
+          billId: dupBill.id, identifier: dupBill.identifier, reason: `${table}_check_failed`, error: String(error.message ?? error),
+        },
+      };
+    }
+    if ((count ?? 0) > 0) nonZeroTables.push({ table, count });
+  }
+  if (nonZeroTables.length > 0) {
+    return {
+      outcome: 'stopped',
+      detail: {
+        billId: dupBill.id, identifier: dupBill.identifier, reason: 'non_zero_related_tables', nonZeroTables,
+      },
+    };
+  }
+
+  const { data: dupVoteRows, error: voteSelErr } = await client
+    .from('votes').select('id,bill_id,chamber,vote_date,source_key,result').eq('bill_id', dupBill.id);
+  if (voteSelErr) {
+    return {
+      outcome: 'failed',
+      detail: {
+        billId: dupBill.id, identifier: dupBill.identifier, reason: 'votes_lookup_failed', error: String(voteSelErr.message ?? voteSelErr),
+      },
+    };
+  }
+  // Projected onto the canonical bill id in EVERY branch (dry-run and live) — in live mode this is
+  // simply true after the redirect below; in dry-run mode nothing actually moved, but Phase B needs
+  // to know what WOULD be true post-redirect to look up LegiScan candidates on the right bill.
+  const projectedVoteRows = (dupVoteRows ?? []).map((v) => ({ ...v, bill_id: canonicalBillId }));
+
+  if (dryRun) {
+    return {
+      outcome: 'merged',
+      votesRedirected: projectedVoteRows.length,
+      detail: {
+        billId: dupBill.id,
+        identifier: dupBill.identifier,
+        canonicalBillId,
+        votesRedirected: projectedVoteRows.length,
+        voteRows: projectedVoteRows,
+        billDeleted: false,
+        dryRun: true,
+      },
+    };
+  }
+
+  const { data: updatedVotes, error: updErr } = await client
+    .from('votes').update({ bill_id: canonicalBillId, run_id: runId }).eq('bill_id', dupBill.id).select('id', { count: 'exact' });
+  if (updErr) {
+    return {
+      outcome: 'failed',
+      detail: {
+        billId: dupBill.id, identifier: dupBill.identifier, reason: 'vote_redirect_failed', error: String(updErr.message ?? updErr),
+      },
+    };
+  }
+  const redirectedCount = updatedVotes ? updatedVotes.length : 0;
+
+  // Re-verify LIVE (brief step 4): zero remaining votes.bill_id references to the duplicate bill —
+  // the actual guard the delete below depends on, not just an assumption that the update above
+  // matched everything.
+  const { count: remainingVotes, error: remErr } = await client
+    .from('votes').select('id', { count: 'exact', head: true }).eq('bill_id', dupBill.id);
+  if (remErr) {
+    return {
+      outcome: 'failed',
+      detail: {
+        billId: dupBill.id, identifier: dupBill.identifier, reason: 'vote_redirect_recheck_failed', error: String(remErr.message ?? remErr),
+      },
+    };
+  }
+  if ((remainingVotes ?? 0) > 0) {
+    return {
+      outcome: 'failed',
+      detail: {
+        billId: dupBill.id, identifier: dupBill.identifier, reason: 'vote_redirect_incomplete', remaining: remainingVotes,
+      },
+    };
+  }
+
+  const { data: deletedBills, error: delErr } = await client.from('bills').delete().eq('id', dupBill.id).select('id');
+  if (delErr) {
+    return {
+      outcome: 'failed',
+      detail: {
+        billId: dupBill.id, identifier: dupBill.identifier, reason: 'bill_delete_failed', error: String(delErr.message ?? delErr),
+      },
+    };
+  }
+  if (!deletedBills || deletedBills.length !== 1) {
+    return {
+      outcome: 'failed',
+      detail: {
+        billId: dupBill.id, identifier: dupBill.identifier, reason: 'bill_delete_guard_mismatch', got: deletedBills?.length ?? 0,
+      },
+    };
+  }
+
+  return {
+    outcome: 'merged',
+    votesRedirected: redirectedCount,
+    detail: {
+      billId: dupBill.id,
+      identifier: dupBill.identifier,
+      canonicalBillId,
+      votesRedirected: redirectedCount,
+      voteRows: projectedVoteRows,
+      billDeleted: true,
+      dryRun: false,
+    },
+  };
+}
+
+// runMergeMo2026Session — Phase A. `merges[]` doubles as the human-review surface (same "≤ a few
+// dozen rows, Lance can eyeball every decision" precedent as runCorrectMo1969Dates's own `matches`)
+// AND the input Phase B consumes (each entry's `voteRows`, already projected onto the canonical
+// bill id) — one pass produces both, never two independently-derived views of the same merge.
+export async function runMergeMo2026Session(client, {
+  dryRun = false, limit = null, runId = null,
+} = {}) {
+  const { data: sessionRows, error: sessErr } = await client
+    .from('sessions').select('id,identifier,legiscan_session_id')
+    .eq('jurisdiction_id', MO_JURISDICTION_ID)
+    .in('identifier', [CANONICAL_MO_2026_SESSION_IDENTIFIER, DUPLICATE_MO_2026_SESSION_IDENTIFIER]);
+  if (sessErr) throw new Error(`mo-2026-session-merge: session lookup failed: ${sessErr.message}`);
+  const canonical = (sessionRows ?? []).find((r) => r.identifier === CANONICAL_MO_2026_SESSION_IDENTIFIER);
+  const dup = (sessionRows ?? []).find((r) => r.identifier === DUPLICATE_MO_2026_SESSION_IDENTIFIER);
+
+  const emptyReport = (overrides) => ({
+    canonicalSessionFound: !!canonical,
+    dupSessionFound: !!dup,
+    canonicalSessionId: canonical?.id ?? null,
+    dupSessionId: dup?.id ?? null,
+    dupBillsTotal: 0,
+    dupBillsSeen: 0,
+    billsMerged: 0,
+    votesRedirected: 0,
+    sessionDeleted: false,
+    sessionDeletionEligible: false,
+    stopped: [],
+    merges: [],
+    failures: [],
+    ...overrides,
+  });
+
+  // Canonical session missing entirely is a red flag worth surfacing (it's supposed to be the real,
+  // populated session) — but ONLY if a duplicate is also present (i.e. there's actually something
+  // this correction would need the canonical row for); if BOTH are absent there's simply nothing to
+  // do (a prior run may have already fully merged and cleaned up), never an error.
+  if (!canonical) {
+    return emptyReport({
+      failures: dup ? [{ reason: 'canonical_session_missing_but_duplicate_present', dupSessionId: dup.id }] : [],
+    });
+  }
+  if (!dup) return emptyReport({});
+
+  const { data: dupBillsAll, error: dupBillsErr } = await selectAll(client, 'bills', 'id,identifier', {
+    filter: (q) => q.eq('session_id', dup.id),
+  });
+  if (dupBillsErr) throw new Error(`mo-2026-session-merge: duplicate bill lookup failed: ${dupBillsErr.message}`);
+  const dupBillsTotal = (dupBillsAll ?? []).length;
+  const sortedDupBills = [...(dupBillsAll ?? [])].sort((a, b) => (a.id > b.id ? 1 : -1));
+  const dupBillsScoped = limit != null ? sortedDupBills.slice(0, limit) : sortedDupBills;
+
+  const stopped = [];
+  const merges = [];
+  const failures = [];
+  let billsMerged = 0;
+  let votesRedirected = 0;
+
+  for (const b of dupBillsScoped) {
+    // eslint-disable-next-line no-await-in-loop -- sequential over at most a few dozen bills (brief:
+    // ~34), same "small/infrequent backlog" precedent as this file's other corrections.
+    const result = await processDuplicateBill(client, b, canonical.id, { dryRun, runId });
+    if (result.outcome === 'merged') {
+      billsMerged += 1;
+      votesRedirected += result.votesRedirected;
+      merges.push(result.detail);
+    } else if (result.outcome === 'stopped') {
+      stopped.push(result.detail);
+    } else {
+      failures.push(result.detail);
+    }
+  }
+
+  // sessionDeletionEligible — every duplicate bill (not just the ones a --limit scoped in) merged
+  // cleanly, with nothing stopped or failed. Reported honestly in BOTH modes (brief: "report...
+  // session deleted or not"); only LIVE mode ever acts on it, and even then via its own independent
+  // re-check immediately below (brief step 5's own guard), never by trusting this in-memory count.
+  const sessionDeletionEligible = dupBillsScoped.length === dupBillsTotal && stopped.length === 0 && failures.length === 0;
+  let sessionDeleted = false;
+
+  if (!dryRun) {
+    const { count: remainingBillCount, error: remErr } = await client
+      .from('bills').select('id', { count: 'exact', head: true }).eq('session_id', dup.id);
+    if (remErr) {
+      failures.push({ reason: 'session_bill_recount_failed', error: String(remErr.message ?? remErr) });
+    } else if ((remainingBillCount ?? 0) === 0) {
+      const { data: deletedSessions, error: sessDelErr } = await client
+        .from('sessions').delete().eq('id', dup.id).select('id');
+      if (sessDelErr) {
+        failures.push({ reason: 'session_delete_failed', error: String(sessDelErr.message ?? sessDelErr) });
+      } else if (deletedSessions && deletedSessions.length === 1) {
+        sessionDeleted = true;
+      } else {
+        failures.push({ reason: 'session_delete_guard_mismatch', got: deletedSessions?.length ?? 0 });
+      }
+    }
+    // remainingBillCount > 0: the session still owns bills (a stopped bill, a failure, or a
+    // --limit-truncated pass) — never deleted, no failure either; this is the guard doing exactly
+    // what it's for.
+  }
+
+  return {
+    canonicalSessionFound: true,
+    dupSessionFound: true,
+    canonicalSessionId: canonical.id,
+    dupSessionId: dup.id,
+    dupBillsTotal,
+    dupBillsSeen: dupBillsScoped.length,
+    billsMerged,
+    votesRedirected,
+    sessionDeleted,
+    sessionDeletionEligible,
+    stopped,
+    merges,
+    failures,
+  };
+}
+
+// reconcileOneVote — Phase B, one redirected mo-senate-web vote (already on its merged/canonical
+// bill_id). Brief step 1: matching LegiScan vote(s) by (bill_id, jurisdiction, chamber,
+// sameCalendarDate) — 0 -> 'no_match', >1 -> 'ambiguous', both honestly reported, never guessed.
+// On exactly one match, reuses summarizePrimaryCastPositions (generic over any position set, per
+// the brief, applied to BOTH sides) and compareTalliesForCrossCheck (the SAME hard/soft comparison
+// crossCheckAgainstPrimarySource's own single-candidate branch uses) — never a hand-rolled second
+// comparison. Clean (0 hard, 0 soft) writes nothing. Any mismatch writes ONE vote_reconciliation_flags
+// row via the reused, idempotent writeReconciliationFlag — `voteId` is the mo-senate-web vote's OWN
+// id (matches the live system's "vote_id always points at the PRIMARY-source row" convention),
+// `sourceB: 'mo-senate-web'`. dryRun never calls writeReconciliationFlag at all (that function isn't
+// dry-run-aware — this file's own DRAFT-THEN-APPLY convention keeps the actual write client-side,
+// gated here, not inside the reused function).
+async function reconcileOneVote(client, dupVote, { dryRun, runId }) {
+  const { data: candidateRows, error: candErr } = await client
+    .from('votes').select('id,vote_date,chamber,source_key,result')
+    .eq('bill_id', dupVote.bill_id).eq('jurisdiction_id', MO_JURISDICTION_ID).eq('chamber', dupVote.chamber)
+    .like('source_key', 'legiscan-%');
+  if (candErr) {
+    return {
+      outcome: 'failed',
+      detail: { voteId: dupVote.id, reason: 'legiscan_candidate_lookup_failed', error: String(candErr.message ?? candErr) },
+    };
+  }
+
+  const candidates = (candidateRows ?? []).filter((c) => sameCalendarDate(c.vote_date, dupVote.vote_date));
+
+  if (candidates.length === 0) {
+    return {
+      outcome: 'no_match',
+      detail: {
+        voteId: dupVote.id, billId: dupVote.bill_id, chamber: dupVote.chamber, voteDate: dupVote.vote_date,
+      },
+    };
+  }
+  if (candidates.length > 1) {
+    return {
+      outcome: 'ambiguous',
+      detail: {
+        voteId: dupVote.id,
+        billId: dupVote.bill_id,
+        candidates: candidates.map((c) => ({ id: c.id, source_key: c.source_key, vote_date: c.vote_date })),
+      },
+    };
+  }
+
+  const legiscanVote = candidates[0];
+  const parsedRollCall = parseLegiscanRollCallSourceKey(legiscanVote.source_key);
+  if (!parsedRollCall) {
+    return {
+      outcome: 'unparseable',
+      detail: { voteId: dupVote.id, legiscanVoteId: legiscanVote.id, sourceKey: legiscanVote.source_key },
+    };
+  }
+
+  const { data: primaryCastRows, error: primaryCastErr } = await client
+    .from('vote_casts').select('position').eq('vote_id', dupVote.id);
+  if (primaryCastErr) {
+    return {
+      outcome: 'failed',
+      detail: { voteId: dupVote.id, reason: 'primary_casts_lookup_failed', error: String(primaryCastErr.message ?? primaryCastErr) },
+    };
+  }
+  const { data: legiscanCastRows, error: legiscanCastErr } = await client
+    .from('vote_casts').select('position').eq('vote_id', legiscanVote.id);
+  if (legiscanCastErr) {
+    return {
+      outcome: 'failed',
+      detail: { voteId: dupVote.id, reason: 'legiscan_casts_lookup_failed', error: String(legiscanCastErr.message ?? legiscanCastErr) },
+    };
+  }
+
+  const primaryCounts = summarizePrimaryCastPositions(primaryCastRows ?? []);
+  const legiscanCounts = summarizePrimaryCastPositions(legiscanCastRows ?? []);
+  const legiscanTallies = {
+    tallies: {
+      yea: legiscanCounts.yea, nay: legiscanCounts.nay, not_voting: legiscanCounts.not_voting, absent: legiscanCounts.absent,
+    },
+    chamber: dupVote.chamber,
+    date: legiscanVote.vote_date,
+    runId,
+    rollCallId: parsedRollCall.rollCallId,
+  };
+
+  const { hardMismatches, softMismatches } = compareTalliesForCrossCheck(legiscanTallies, primaryCounts);
+
+  if (hardMismatches.length === 0 && softMismatches.length === 0) {
+    return {
+      outcome: 'clean',
+      detail: {
+        voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, chamber: dupVote.chamber, matched: true, flag: null,
+      },
+    };
+  }
+
+  const discrepancy = {
+    source_a_tallies: legiscanTallies.tallies,
+    source_b_tallies: primaryCounts,
+    source_b_result: dupVote.result ?? null,
+    source_b_vote_id: dupVote.id,
+    source_b_source_key: dupVote.source_key,
+    hard_mismatches: hardMismatches,
+    soft_mismatches: softMismatches,
+  };
+  if (softMismatches.length > 0) discrepancy.caveat = PRESENT_CATEGORY_CAVEAT;
+  const reason = hardMismatches.length > 0 ? 'hard_mismatch' : 'soft_mismatch';
+
+  if (dryRun) {
+    return {
+      outcome: 'flagged',
+      detail: {
+        voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, reason, discrepancy, wouldWrite: true,
+      },
+    };
+  }
+
+  const flag = await writeReconciliationFlag(client, {
+    voteId: dupVote.id, sourceB: 'mo-senate-web', discrepancy, runId, rollCallId: parsedRollCall.rollCallId, reason,
+  });
+
+  return {
+    outcome: 'flagged',
+    detail: {
+      voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, reason, flag,
+    },
+  };
+}
+
+// runReconcileMo2026Votes — Phase B driver. Only ever looks at mo-senate-web-prefixed votes among
+// `mergedBills[].voteRows` (defensive: the brief's live verification found all 31 redirected votes
+// were mo-senate-web, but this never assumes that holds forever) — never touches a vote this run
+// didn't itself just merge.
+export async function runReconcileMo2026Votes(client, {
+  dryRun = false, runId = null, mergedBills = [],
+} = {}) {
+  const votesToCheck = mergedBills.flatMap((m) => (m.voteRows ?? [])
+    .filter((v) => String(v.source_key ?? '').startsWith('mo-senate-web-')));
+
+  const cleanMatchDetails = [];
+  const flagged = [];
+  const noMatch = [];
+  const ambiguous = [];
+  const unparseable = [];
+  const failures = [];
+
+  for (const dupVote of votesToCheck) {
+    // eslint-disable-next-line no-await-in-loop -- sequential over at most a few dozen votes (brief:
+    // 31), same "small/infrequent backlog" precedent as the rest of this file.
+    const result = await reconcileOneVote(client, dupVote, { dryRun, runId });
+    if (result.outcome === 'clean') cleanMatchDetails.push(result.detail);
+    else if (result.outcome === 'flagged') flagged.push(result.detail);
+    else if (result.outcome === 'no_match') noMatch.push(result.detail);
+    else if (result.outcome === 'ambiguous') ambiguous.push(result.detail);
+    else if (result.outcome === 'unparseable') unparseable.push(result.detail);
+    else failures.push(result.detail);
+  }
+
+  return {
+    votesChecked: votesToCheck.length,
+    cleanMatches: cleanMatchDetails.length,
+    flaggedCount: flagged.length,
+    noMatchCount: noMatch.length,
+    ambiguousCount: ambiguous.length,
+    unparseableCount: unparseable.length,
+    cleanMatchDetails,
+    flagged,
+    noMatch,
+    ambiguous,
+    unparseable,
+    failures,
+  };
+}
+
+// runCorrectMo2026SessionMerge — Phase A then Phase B, combined report + combined failures.
+export async function runCorrectMo2026SessionMerge(client, {
+  dryRun = false, limit = null, runId = null,
+} = {}) {
+  const merge = await runMergeMo2026Session(client, { dryRun, limit, runId });
+  const reconciliation = await runReconcileMo2026Votes(client, { dryRun, runId, mergedBills: merge.merges });
+  return {
+    merge, reconciliation, failures: [...merge.failures, ...reconciliation.failures],
+  };
+}
+
 // ============================================================================================
 // Top-level dispatcher
 // ============================================================================================
 
 export async function runCorrectData(client, {
   which, dryRun = false, limit = null, runId = null,
 } = {}) {
   const out = { mode: dryRun ? 'dry-run' : 'live', which };
   const failures = [];
 
   if (which === 'mo-status' || which === 'all') {
     out.moStatus = await runCorrectMoStatus(client, { dryRun, limit, runId });
     failures.push(...out.moStatus.failures);
   }
   if (which === 'mo-1969-dates' || which === 'all') {
     out.mo1969Dates = await runCorrectMo1969Dates(client, { dryRun, limit, runId });
     failures.push(...out.mo1969Dates.failures);
   }
+  // Deliberately EXCLUDED from 'all' (brief, explicit): bill/session merge + FK redirect + guarded
+  // deletes is higher-stakes than A/B's in-place rewrites — an operator must name this one, never
+  // sweep it in by omission.
+  if (which === 'mo-2026-session-merge') {
+    out.mo2026SessionMerge = await runCorrectMo2026SessionMerge(client, { dryRun, limit, runId });
+    failures.push(...out.mo2026SessionMerge.failures);
+  }
 
   out.failures = failures;
   return out;
 }
 
 // ---- main ----
 
 async function main() {
   const args = parseArgs(process.argv.slice(2));
   const client = getClient();
diff --git a/tests/correct-data.test.js b/tests/correct-data.test.js
index 6c234f5..b0ae5c2 100644
--- a/tests/correct-data.test.js
+++ b/tests/correct-data.test.js
@@ -1,92 +1,121 @@
 import { test } from 'node:test';
 import assert from 'node:assert/strict';
+import { readFileSync } from 'node:fs';
 import {
   parseArgs,
   MO_STATUS_WORD_MAP,
   MO_STATUS_MAPPED_CODES,
   MO_STATUS_PROGRESS_ONLY_CODES,
   MO_STATUS_UNMAPPED_CODE,
   mapMoStatusCode,
   parseMoSenateJournalDateFromUrl,
   VOTE_DATE_1969_SENTINEL,
   runCorrectMoStatus,
   runCorrectMo1969Dates,
   runCorrectData,
+  CANONICAL_MO_2026_SESSION_IDENTIFIER,
+  DUPLICATE_MO_2026_SESSION_IDENTIFIER,
+  DUP_BILL_MUST_BE_EMPTY_TABLES,
+  runMergeMo2026Session,
+  runReconcileMo2026Votes,
+  runCorrectMo2026SessionMerge,
 } from '../src/cli/correct-data.js';
 
 // Data-corrections CLI (.superpowers/sdd/2026-07-31-data-corrections/brief.md). Two REVERSIBLE
 // production-data corrections (both re-derivable from cached LegiScan datasets / the primary MO
 // Senate journal source), draft-then-apply — this test file proves the dry-run/live orchestration
 // logic entirely against a fake in-memory client; ZERO live DB writes anywhere in this file, and no
 // live run is ever performed from this repo (Lance's own separate explicit word, per the brief).
 
 // ---- fake Supabase-ish client: eq/in/order/limit + select/update/delete, thenable builder ----
 // A single generic in-memory fake (not one bespoke mock per call site) because both corrections
 // issue a handful of genuinely different call shapes (plain select, count-only head select,
 // update+select(count:exact), delete+select) against three small tables (bills, votes,
 // vote_casts) — mirrors real supabase-js closely enough (fluent + thenable) to exercise this
 // module's actual query construction, not just its counting arithmetic.
+function likeToRegExp(pattern) {
+  const escaped = String(pattern).split('%').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
+  return new RegExp(`^${escaped.join('.*')}$`);
+}
+
 function makeFakeClient(seed = {}, { forceError = null, afterExecute = null } = {}) {
-  const tables = { bills: [], votes: [], vote_casts: [], ...seed };
+  const tables = {
+    bills: [],
+    votes: [],
+    vote_casts: [],
+    sessions: [],
+    bill_texts: [],
+    bill_sponsors: [],
+    summaries: [],
+    bill_actions: [],
+    vote_reconciliation_flags: [],
+    ...seed,
+  };
   for (const t of Object.keys(tables)) tables[t] = tables[t].map((r) => ({ ...r }));
   const calls = [];
+  let insertCounter = 0;
 
   function matchesFilters(row, filters) {
     return filters.every((f) => {
       if (f.op === 'eq') return row[f.col] === f.val;
       if (f.op === 'in') return f.vals.includes(row[f.col]);
+      if (f.op === 'like') return likeToRegExp(f.val).test(String(row[f.col] ?? ''));
       return true;
     });
   }
 
   function makeBuilder(table, mode, patch) {
     const filters = [];
     let orderCol = null;
     let orderAsc = true;
     let limitVal = null;
+    let rangeVal = null;
     let selectCols = null;
     let selectOpts = {};
 
     const builder = {
       eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
       in(col, vals) { filters.push({ op: 'in', col, vals }); return builder; },
+      like(col, val) { filters.push({ op: 'like', col, val }); return builder; },
       order(col, { ascending = true } = {}) { orderCol = col; orderAsc = ascending; return builder; },
       limit(n) { limitVal = n; return builder; },
+      range(from, to) { rangeVal = [from, to]; return builder; },
       select(cols, opts = {}) { selectCols = cols; selectOpts = opts; return builder; },
       then(resolve, reject) {
         try {
           resolve(execute());
         } catch (e) {
           if (reject) reject(e); else throw e;
         }
       },
     };
 
     function execute() {
       const callInfo = {
-        table, mode, patch, filters: [...filters], select: selectCols, selectOpts, orderCol, limitVal,
+        table, mode, patch, filters: [...filters], select: selectCols, selectOpts, orderCol, limitVal, rangeVal,
       };
       calls.push(callInfo);
       const injected = forceError && forceError(table, mode, filters);
       if (injected) return { data: null, error: injected, count: null };
 
       const rows = tables[table];
       let matched = rows.filter((r) => matchesFilters(r, filters));
       let result;
 
       if (mode === 'select') {
         if (orderCol) {
           matched = [...matched].sort((a, b) => (a[orderCol] > b[orderCol] ? 1 : -1) * (orderAsc ? 1 : -1));
         }
         let out = matched;
-        if (limitVal != null) out = out.slice(0, limitVal);
+        if (rangeVal) out = out.slice(rangeVal[0], rangeVal[1] + 1);
+        else if (limitVal != null) out = out.slice(0, limitVal);
         if (selectOpts.head) result = { data: null, error: null, count: matched.length };
         else if (selectOpts.count === 'exact') result = { data: out.map((r) => ({ ...r })), error: null, count: matched.length };
         else result = { data: out.map((r) => ({ ...r })), error: null };
       } else if (mode === 'update') {
         for (const row of matched) Object.assign(row, patch);
         if (selectCols) {
           const data = matched.map((r) => ({ id: r.id }));
           result = selectOpts.count === 'exact' ? { data, error: null, count: matched.length } : { data, error: null };
         } else {
           result = { data: null, error: null };
@@ -104,28 +133,54 @@ function makeFakeClient(seed = {}, { forceError = null, afterExecute = null } =
       // writer racing between two awaited calls (e.g. mutating a row's status right after an
       // id-select returns, so a LATER update in the same code path sees the raced-away state).
       if (afterExecute) afterExecute(callInfo, tables);
 
       return result;
     }
 
     return builder;
   }
 
+  // makeInsertBuilder — only vote_reconciliation_flags (via legiscan-votes.js's own
+  // writeReconciliationFlag, reused unmodified by the mo-2026-session-merge reconciliation phase)
+  // ever inserts through this fake client. Mirrors tests/legiscan-votes.test.js's own
+  // makeFakeVotesDb insert shape (`.insert(row).select().single()`) closely enough to drive that
+  // real function's actual call chain, not a bespoke re-derivation of it.
+  function makeInsertBuilder(table, row) {
+    return {
+      select: () => ({
+        single: async () => {
+          const injected = forceError && forceError(table, 'insert', []);
+          if (injected) return { data: null, error: injected };
+          insertCounter += 1;
+          const inserted = {
+            id: `${table}-${insertCounter}`, resolved: false, created_at: 'test-time', ...row,
+          };
+          tables[table].push(inserted);
+          calls.push({
+            table, mode: 'insert', patch: row, filters: [], select: null, selectOpts: {}, orderCol: null, limitVal: null, rangeVal: null,
+          });
+          return { data: { ...inserted }, error: null };
+        },
+      }),
+    };
+  }
+
   return {
     tables,
     calls,
     from(table) {
       return {
         select: (cols, opts) => makeBuilder(table, 'select', null).select(cols, opts),
         update: (patch) => makeBuilder(table, 'update', patch),
         delete: () => makeBuilder(table, 'delete', null),
+        insert: (row) => makeInsertBuilder(table, row),
       };
     },
   };
 }
 
 // ---- parseArgs ----
 
 test('parseArgs: requires exactly one <which> positional, no default (no accidental "all" run)', () => {
   assert.throws(() => parseArgs([]), /requires exactly one/);
   assert.throws(() => parseArgs(['--dry-run']), /requires exactly one/);
@@ -580,10 +635,431 @@ test('runCorrectData: "mo-status" runs only the status correction; "mo-1969-date
   const datesOnly = await runCorrectData(makeFakeClient(seed), { which: 'mo-1969-dates', dryRun: true });
   assert.equal(datesOnly.moStatus, undefined);
   assert.ok(datesOnly.mo1969Dates);
 
   const both = await runCorrectData(makeFakeClient(seed), { which: 'all', dryRun: true });
   assert.ok(both.moStatus);
   assert.ok(both.mo1969Dates);
   assert.equal(both.failures.length, 0);
   assert.equal(both.mode, 'dry-run');
 });
+
+// ============================================================================================
+// mo-2026-session-merge (TODO 25 / .superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md) —
+// Phase A (bill/session merge) + Phase B (vote reconciliation, additive-only, NO deletes).
+// ============================================================================================
+
+test('parseArgs: accepts mo-2026-session-merge as a fourth <which> value', () => {
+  assert.equal(parseArgs(['mo-2026-session-merge']).which, 'mo-2026-session-merge');
+  assert.equal(parseArgs(['mo-2026-session-merge', '--dry-run']).dryRun, true);
+});
+
+test('CANONICAL_MO_2026_SESSION_IDENTIFIER / DUPLICATE_MO_2026_SESSION_IDENTIFIER / DUP_BILL_MUST_BE_EMPTY_TABLES: pinned to the brief\'s verified values', () => {
+  assert.equal(CANONICAL_MO_2026_SESSION_IDENTIFIER, '261');
+  assert.equal(DUPLICATE_MO_2026_SESSION_IDENTIFIER, '2026');
+  assert.ok(DUP_BILL_MUST_BE_EMPTY_TABLES.includes('bill_texts'));
+  assert.ok(DUP_BILL_MUST_BE_EMPTY_TABLES.includes('bill_sponsors'));
+  assert.ok(DUP_BILL_MUST_BE_EMPTY_TABLES.includes('summaries'));
+});
+
+test('correct-data.js source: never IMPORTS or CALLS crossCheckAgainstPrimarySource or retractLegiscanVoteIfStored — the two sanctioned-elsewhere functions the brief forbids this file from invoking (a bare mention in an explanatory comment, documenting WHY they are never called, is fine)', () => {
+  const src = readFileSync(new URL('../src/cli/correct-data.js', import.meta.url), 'utf8');
+  assert.equal(/\bcrossCheckAgainstPrimarySource\(/.test(src), false, 'must never CALL the live pre-store gate against already-published data');
+  assert.equal(/import\s*\{[^}]*\bcrossCheckAgainstPrimarySource\b/.test(src), false, 'must never IMPORT it either');
+  assert.equal(/\bretractLegiscanVoteIfStored\(/.test(src), false, 'must never CALL this repo\'s one sanctioned delete — Phase B never deletes anything');
+  assert.equal(/import\s*\{[^}]*\bretractLegiscanVoteIfStored\b/.test(src), false, 'must never IMPORT it either');
+});
+
+function sessionRow(id, identifier, legiscanSessionId = null) {
+  return {
+    id, jurisdiction_id: 'mo-legislature', identifier, legiscan_session_id: legiscanSessionId,
+  };
+}
+function moBillRow(id, sessionId, identifier) {
+  return { id, session_id: sessionId, identifier };
+}
+function moVoteRow(overrides) {
+  return {
+    jurisdiction_id: 'mo-legislature', chamber: 'senate', result: null, ...overrides,
+  };
+}
+function castRow(id, voteId, position, legislatorId) {
+  return {
+    id, vote_id: voteId, position, legislator_id: legislatorId,
+  };
+}
+
+const CANON = sessionRow('sess-261', '261', 2239);
+const DUP = sessionRow('sess-2026', '2026', null);
+
+// ---- runMergeMo2026Session (Phase A) ----
+
+test('runMergeMo2026Session: happy path — exact-identifier twin found, zero related tables, votes redirected, duplicate bill deleted, session deleted once empty', async () => {
+  const client = makeFakeClient({
+    sessions: [CANON, DUP],
+    bills: [
+      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
+      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
+    ],
+    votes: [moVoteRow({
+      id: 'vote-dup-1', bill_id: 'bill-dup-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
+    })],
+    vote_casts: [],
+  });
+
+  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.canonicalSessionFound, true);
+  assert.equal(report.dupSessionFound, true);
+  assert.equal(report.dupBillsTotal, 1);
+  assert.equal(report.dupBillsSeen, 1);
+  assert.equal(report.billsMerged, 1);
+  assert.equal(report.votesRedirected, 1);
+  assert.equal(report.stopped.length, 0);
+  assert.equal(report.failures.length, 0);
+  assert.equal(report.sessionDeletionEligible, true);
+  assert.equal(report.sessionDeleted, true);
+
+  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), false, 'duplicate bill deleted');
+  assert.equal(client.tables.bills.some((b) => b.id === 'bill-canon-1'), true, 'canonical bill untouched');
+  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), false, 'duplicate session deleted');
+  assert.equal(client.tables.votes.find((v) => v.id === 'vote-dup-1').bill_id, 'bill-canon-1', 'vote redirected to the canonical bill');
+
+  assert.equal(report.merges.length, 1);
+  assert.equal(report.merges[0].canonicalBillId, 'bill-canon-1');
+  assert.equal(report.merges[0].billDeleted, true);
+});
+
+test('runMergeMo2026Session: no canonical twin for a duplicate identifier — STOPS and reports, never invents a merge target, bill/session untouched', async () => {
+  const client = makeFakeClient({
+    sessions: [CANON, DUP],
+    bills: [
+      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
+      moBillRow('bill-dup-orphan', 'sess-2026', 'SB 99'), // no SB 99 under the canonical session
+    ],
+    votes: [],
+  });
+
+  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.billsMerged, 0);
+  assert.equal(report.stopped.length, 1);
+  assert.equal(report.stopped[0].reason, 'no_canonical_twin');
+  assert.equal(report.stopped[0].billId, 'bill-dup-orphan');
+  assert.equal(report.sessionDeletionEligible, false, 'a stopped bill blocks session-delete eligibility');
+  assert.equal(report.sessionDeleted, false);
+  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-orphan'), true, 'never deleted — no twin to redirect its votes to');
+  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), true, 'session not deleted — still owns a bill');
+});
+
+test('runMergeMo2026Session: a duplicate bill with a non-zero related table (bill_texts here) STOPS and reports, never silently redirects', async () => {
+  const client = makeFakeClient({
+    sessions: [CANON, DUP],
+    bills: [
+      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
+      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
+    ],
+    bill_texts: [{
+      id: 'bt-1', bill_id: 'bill-dup-1', version: 'introduced',
+    }],
+    votes: [],
+  });
+
+  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.billsMerged, 0);
+  assert.equal(report.stopped.length, 1);
+  assert.equal(report.stopped[0].reason, 'non_zero_related_tables');
+  assert.deepEqual(report.stopped[0].nonZeroTables, [{ table: 'bill_texts', count: 1 }]);
+  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), true, 'never deleted — a table this brief didn\'t anticipate redirecting is non-zero');
+});
+
+test('runMergeMo2026Session: --dry-run performs ZERO writes but reports the same honest counts a live run would produce', async () => {
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
+  const before = JSON.stringify([client.tables.bills, client.tables.votes, client.tables.sessions]);
+
+  const report = await runMergeMo2026Session(client, { dryRun: true });
+
+  assert.equal(report.billsMerged, 1);
+  assert.equal(report.votesRedirected, 1);
+  assert.equal(report.sessionDeletionEligible, true);
+  assert.equal(report.sessionDeleted, false, 'dry-run never actually deletes the session, even when eligible');
+  assert.equal(JSON.stringify([client.tables.bills, client.tables.votes, client.tables.sessions]), before, 'zero writes — every table byte-for-byte unchanged');
+  assert.equal(client.calls.some((c) => c.mode === 'update' || c.mode === 'delete'), false);
+});
+
+test('runMergeMo2026Session: --limit caps how many duplicate bills are processed; a partial pass never deletes the still-non-empty session', async () => {
+  const client = makeFakeClient({
+    sessions: [CANON, DUP],
+    bills: [
+      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
+      moBillRow('bill-canon-2', 'sess-261', 'SB 2'),
+      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
+      moBillRow('bill-dup-2', 'sess-2026', 'SB 2'),
+    ],
+    votes: [],
+  });
+
+  const report = await runMergeMo2026Session(client, { dryRun: false, limit: 1, runId: 'run-1' });
+
+  assert.equal(report.dupBillsTotal, 2);
+  assert.equal(report.dupBillsSeen, 1);
+  assert.equal(report.billsMerged, 1);
+  assert.equal(report.sessionDeletionEligible, false, 'the limit left a bill unprocessed');
+  assert.equal(report.sessionDeleted, false);
+  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), true, 'session still owns bill-dup-2 — the guard refuses');
+});
+
+test('runMergeMo2026Session: no duplicate session present -> nothing to do, clean empty report, never an error', async () => {
+  const client = makeFakeClient({
+    sessions: [CANON],
+    bills: [moBillRow('bill-canon-1', 'sess-261', 'SB 1')],
+  });
+
+  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.dupSessionFound, false);
+  assert.equal(report.billsMerged, 0);
+  assert.equal(report.sessionDeleted, false);
+  assert.deepEqual(report.failures, []);
+});
+
+// ---- runReconcileMo2026Votes (Phase B) ----
+
+test('runReconcileMo2026Votes: exactly one same-day LegiScan candidate with matching tallies -> clean match, writes NOTHING', async () => {
+  const client = makeFakeClient({
+    votes: [
+      moVoteRow({
+        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
+      }),
+    ],
+    vote_casts: [
+      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
+      castRow('c2', 'vote-dup-1', 'yea', 'L2'),
+      castRow('c3', 'vote-dup-1', 'nay', 'L3'),
+      castRow('c4', 'vote-ls-1', 'yea', 'L1'),
+      castRow('c5', 'vote-ls-1', 'yea', 'L2'),
+      castRow('c6', 'vote-ls-1', 'nay', 'L3'),
+    ],
+  });
+  const mergedBills = [{
+    billId: 'bill-dup-1',
+    canonicalBillId: 'bill-canon-1',
+    voteRows: [moVoteRow({
+      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
+    })],
+  }];
+
+  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
+
+  assert.equal(report.votesChecked, 1);
+  assert.equal(report.cleanMatches, 1);
+  assert.equal(report.flaggedCount, 0);
+  assert.equal(client.tables.vote_reconciliation_flags.length, 0, 'a clean match writes nothing to the DB');
+});
+
+test('runReconcileMo2026Votes: a HARD (yea/nay) mismatch writes a vote_reconciliation_flags row keyed on the mo-senate-web vote\'s own id, reason hard_mismatch', async () => {
+  const client = makeFakeClient({
+    votes: [
+      moVoteRow({
+        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
+      }),
+    ],
+    vote_casts: [
+      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
+      castRow('c2', 'vote-dup-1', 'yea', 'L2'),
+      castRow('c3', 'vote-dup-1', 'nay', 'L3'),
+      // legiscan side: all three yea — a real hard yea/nay divergence
+      castRow('c4', 'vote-ls-1', 'yea', 'L1'),
+      castRow('c5', 'vote-ls-1', 'yea', 'L2'),
+      castRow('c6', 'vote-ls-1', 'yea', 'L3'),
+    ],
+  });
+  const mergedBills = [{
+    billId: 'bill-dup-1',
+    canonicalBillId: 'bill-canon-1',
+    voteRows: [moVoteRow({
+      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
+    })],
+  }];
+
+  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
+
+  assert.equal(report.cleanMatches, 0);
+  assert.equal(report.flaggedCount, 1);
+  assert.equal(client.tables.vote_reconciliation_flags.length, 1);
+  const flag = client.tables.vote_reconciliation_flags[0];
+  assert.equal(flag.vote_id, 'vote-dup-1', 'vote_id points at the PRIMARY-source (mo-senate-web) row, matching the live system\'s own convention');
+  assert.equal(flag.source_a, 'legiscan');
+  assert.equal(flag.source_b, 'mo-senate-web');
+  assert.equal(flag.discrepancy.reason, 'hard_mismatch');
+  assert.ok(flag.discrepancy.hard_mismatches.length > 0);
+  assert.deepEqual(flag.discrepancy.source_b_tallies.yea !== undefined, true);
+  assert.equal(flag.discrepancy.source_b_vote_id, 'vote-dup-1');
+  assert.equal(flag.discrepancy.source_b_source_key, 'mo-senate-web-2026-x-vote1');
+});
+
+test('runReconcileMo2026Votes: a SOFT-only mismatch (yea/nay agree, non-yea/non-nay bucket differs) writes reason soft_mismatch with the PRESENT_CATEGORY_CAVEAT attached', async () => {
+  const client = makeFakeClient({
+    votes: [
+      moVoteRow({
+        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
+      }),
+    ],
+    vote_casts: [
+      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
+      castRow('c2', 'vote-dup-1', 'yea', 'L2'),
+      castRow('c3', 'vote-dup-1', 'nay', 'L3'),
+      castRow('c4', 'vote-dup-1', 'present', 'L4'), // primary-only category, no LegiScan analog
+      castRow('c5', 'vote-ls-1', 'yea', 'L1'),
+      castRow('c6', 'vote-ls-1', 'yea', 'L2'),
+      castRow('c7', 'vote-ls-1', 'nay', 'L3'),
+    ],
+  });
+  const mergedBills = [{
+    billId: 'bill-dup-1',
+    canonicalBillId: 'bill-canon-1',
+    voteRows: [moVoteRow({
+      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
+    })],
+  }];
+
+  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
+
+  assert.equal(report.flaggedCount, 1);
+  const flag = client.tables.vote_reconciliation_flags[0];
+  assert.equal(flag.discrepancy.reason, 'soft_mismatch');
+  assert.equal(flag.discrepancy.hard_mismatches.length, 0);
+  assert.ok(flag.discrepancy.soft_mismatches.length > 0);
+  assert.ok(flag.discrepancy.caveat, 'the Present-category caveat is attached whenever a soft mismatch is present');
+});
+
+test('runReconcileMo2026Votes: zero LegiScan candidates -> honest no-match report, no flag written', async () => {
+  const client = makeFakeClient({ votes: [], vote_casts: [] });
+  const mergedBills = [{
+    billId: 'bill-dup-1',
+    canonicalBillId: 'bill-canon-1',
+    voteRows: [moVoteRow({
+      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
+    })],
+  }];
+
+  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
+
+  assert.equal(report.noMatchCount, 1);
+  assert.equal(report.flaggedCount, 0);
+  assert.equal(client.tables.vote_reconciliation_flags.length, 0);
+});
+
+test('runReconcileMo2026Votes: more than one same-day LegiScan candidate -> reported ambiguous, never guessed, no flag written', async () => {
+  const client = makeFakeClient({
+    votes: [
+      moVoteRow({
+        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
+      }),
+      moVoteRow({
+        id: 'vote-ls-2', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641860',
+      }),
+    ],
+    vote_casts: [],
+  });
+  const mergedBills = [{
+    billId: 'bill-dup-1',
+    canonicalBillId: 'bill-canon-1',
+    voteRows: [moVoteRow({
+      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
+    })],
+  }];
+
+  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
+
+  assert.equal(report.ambiguousCount, 1);
+  assert.equal(report.flaggedCount, 0);
+  assert.equal(client.tables.vote_reconciliation_flags.length, 0);
+});
+
+test('runReconcileMo2026Votes: --dry-run performs ZERO writes even on a mismatch, reports wouldWrite honestly', async () => {
+  const client = makeFakeClient({
+    votes: [
+      moVoteRow({
+        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
+      }),
+    ],
+    vote_casts: [
+      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
+      castRow('c4', 'vote-ls-1', 'yea', 'L1'),
+      castRow('c5', 'vote-ls-1', 'nay', 'L2'), // hard mismatch: primary has no nay caster at all
+    ],
+  });
+  const mergedBills = [{
+    billId: 'bill-dup-1',
+    canonicalBillId: 'bill-canon-1',
+    voteRows: [moVoteRow({
+      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
+    })],
+  }];
+
+  const report = await runReconcileMo2026Votes(client, { dryRun: true, mergedBills });
+
+  assert.equal(report.flaggedCount, 1);
+  assert.equal(report.flagged[0].wouldWrite, true);
+  assert.equal(client.tables.vote_reconciliation_flags.length, 0, 'dry-run never writes a flag row');
+});
+
+// ---- runCorrectMo2026SessionMerge (combined) + runCorrectData dispatcher wiring ----
+
+test('runCorrectMo2026SessionMerge: runs Phase A then Phase B against the bills Phase A actually merged, combining failures', async () => {
+  const client = makeFakeClient({
+    sessions: [CANON, DUP],
+    bills: [
+      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
+      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
+    ],
+    votes: [
+      moVoteRow({
+        id: 'vote-dup-1', bill_id: 'bill-dup-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
+      }),
+      moVoteRow({
+        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
+      }),
+    ],
+    vote_casts: [
+      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
+      castRow('c2', 'vote-ls-1', 'yea', 'L1'),
+    ],
+  });
+
+  const report = await runCorrectMo2026SessionMerge(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.merge.billsMerged, 1);
+  assert.equal(report.merge.sessionDeleted, true);
+  assert.equal(report.reconciliation.votesChecked, 1);
+  assert.equal(report.reconciliation.cleanMatches, 1);
+  assert.deepEqual(report.failures, []);
+});
+
+test('runCorrectData: "mo-2026-session-merge" runs only when explicitly named — "all" never sweeps it in, given its higher stakes (deletes + FK redirects)', async () => {
+  const seed = {
+    sessions: [CANON, DUP],
+    bills: [
+      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
+      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
+    ],
+    votes: [],
+  };
+
+  const explicit = await runCorrectData(makeFakeClient(seed), { which: 'mo-2026-session-merge', dryRun: true });
+  assert.ok(explicit.mo2026SessionMerge);
+
+  const all = await runCorrectData(makeFakeClient(seed), { which: 'all', dryRun: true });
+  assert.equal(all.mo2026SessionMerge, undefined, '"all" must never run the session-merge correction implicitly');
+  assert.equal(all.moStatus !== undefined && all.mo1969Dates !== undefined, true, 'the other two corrections are unaffected');
+});
