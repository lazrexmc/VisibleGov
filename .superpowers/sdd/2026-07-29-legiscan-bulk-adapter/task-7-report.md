# Task 7 report: substitute-vehicle attribution investigation

**Status:** complete. Bounded investigation only, per CONTROLLER RULING 2 — no production code
changed (deliverable is evidence + a ruling recommendation for the controller to approve before
Task 9's brief is written).

**Commit:** `eddab84f5ac4caa120f36a770f4c07c1eada6b50` — "research: legiscan substitute-vehicle
attribution - investigated, not assumed" (docs/research/2026-07-29-legiscan-substitute-vehicles.md,
tests/fixtures/research/legiscan/mo-2018-SB921.json, tests/fixtures/research/SOURCES.md). Full
suite: 744/744 green.

**Queries spent:** 1 of ≤3 budgeted. `getBill` for SB921 (`https://api.legiscan.com/?key=REDACTED
&op=getBill&id=1061416`, 200 OK) — bill_id already known from the held masterlist fixture, no list
re-query. The planned follow-up `getRollCall` query was never needed (SB921's `votes[]` came back
empty, so there was no roll call id to fetch) — 2 of 3 budgeted queries unused.

**One-paragraph answer:** The combined vehicle's real Senate roll call (`SS for SCS for SBs 894 &
921`, a genuine individually-named 31-0 vote on 2018-03-08 — confirmed via the real
`mo-senate-journal-pdf.js` parser against the Day 37 journal fixture, so it was NOT a voice vote)
lives in neither SB894's nor SB921's LegiScan record — SB921's `votes[]` and `sasts[]` are both
empty and its `history` stops at the 2018-02-20 combination event, while SB894's own `votes[]` has
only the unrelated House roll call (747209). This is a genuine LegiScan coverage gap, not an
attribution-elsewhere case — and structurally LegiScan's own `ls_bill_vote.bill_id` is a single
scalar FK (confirmed from the already-held `legiscan-current.tar.gz`'s `schema-mysql.sql`), so
LegiScan's data model could never have attributed one roll call to both siblings simultaneously
even if it had captured this vote. Recommended rule for Task 9: single-bill-primary attribution —
use `roll_call.bill_id` verbatim as `votes.bill_id`, store `roll_call.desc`/motion text verbatim in
`votes.question` (already carries sibling bill numbers when relevant), and never synthesize a
second `votes`/`vote_casts` row for a sibling bill_id; this is not a new pattern but already shipped
precedent in `src/cli/ingest-mo-senate.js` (`bill_refs[0]` as primary `bill_id`, full sibling list
gets `bills` stub rows, `question` carries the verbatim motion text) — a duplicated `vote_casts` set
per sibling would double-count one real floor action in any per-legislator aggregate, which is
exactly the double-counting failure mode the plan's Q6 ruling asked this task to rule out before
Task 9 is written.

**Concerns:**
- The brief's own framing ("both 2018-05-03") collapsed two distinct Senate events on SB894 — the
  real March 8 initial passage (captured, ground-truthed) and a separate May 3 concurrence/Truly-
  Agreed-To-and-Finally-Passed vote (not captured by any held fixture). Whether the May 3 vote was
  *also* individually recorded in that day's Senate journal is UNKNOWN — resolving it would need a
  `senate.mo.gov` journal fetch (not a LegiScan query, so out of this task's budget and scope), and
  doesn't change the finding above (LegiScan has zero Senate roll calls for this bill regardless).
- This repo holds zero real-payload examples of a populated `sasts` array anywhere (checked every
  bill file in both committed dataset-ZIP fixtures, 27 files, all empty) — the `sasts` field's
  documented shape (from LegiScan's own schema, type enum 1-9, no "Combined" type) is
  DOCUMENTED-UNVERIFIED, not confirmed against a real non-empty payload. Not blocking for the Task 9
  recommendation (which doesn't depend on `sasts` at all), but worth knowing before anyone builds
  code that assumes `sasts` is how LegiScan tracks bill combinations — in this real case it wasn't
  used at all; the relationship was recorded only as free text in `history`/`last_action`.
- The recommendation leaves a known, deliberate display-layer gap for Plan 3: a sibling bill's own
  page (e.g. SB921's) won't surface a combined-vehicle vote via a plain `votes.bill_id` lookup,
  since the row lives under the primary sibling. Per the plan's explicit ruling this is not built
  now — flagged in the research doc for whoever picks up Plan 3's bill-page rendering.
