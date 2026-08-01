# Task brief — TODO 25: merge the duplicate MO 2026 session

Approved by Lance (2026-08-01: "make the corrections"), following a full controller investigation
recorded in this session's transcript. Everything below is VERIFIED against live data, not assumed —
re-verify at execution time anyway (the DB has grown since; do not hardcode counts).

## The defect

`sessions` has two rows for one real MO 2026 session:
- `'261'` (canonical): `legiscan_session_id=2239`, LegiScan-sourced, ~3,162 bills.
- `'2026'` (duplicate): `legiscan_session_id=NULL` — the only MO session missing one — created by
  `ingest-mo-senate.js:472`'s own `insertIfAbsent` on every Senate-journal run, independent of the
  LegiScan-sourced row. ~34 bills as of this brief, actively growing.

**Every one of the duplicate's bills already exists under the canonical session by exact identifier
match** (verified: 34/34 collide, zero exceptions). `bill_texts`, `bill_sponsors`, `summaries` are
all confirmed at zero on the duplicate side — nothing to redirect there. `votes` is the only table
with real data hanging off the duplicate bills (31 rows, all `source_key` prefixed `mo-senate-web-`).

## Two separable phases

### Phase A — bill/session merge (mechanical, exact-match only, do this regardless of Phase B)

For each duplicate bill (session `'2026'`):
1. Find its canonical twin: `bills` row with the SAME `identifier`, `session_id` = the canonical
   `'261'` row's id. This MUST be an exact string match — if a duplicate bill's identifier has no
   canonical twin, STOP and report it (do not invent a merge target; do not fall back to creating
   one). Re-verify live that this is still 34/34 — if it isn't, the fix must still work correctly
   for whatever the real live set is.
2. Redirect every `votes.bill_id` pointing at the duplicate bill to the canonical bill's id.
3. Re-verify LIVE (never trust this brief's counts) that `bill_texts`/`bill_sponsors`/`summaries`
   are still zero for this duplicate bill_id. If any are non-zero, STOP for that bill and report it
   — do not silently redirect a table this brief didn't anticipate.
4. Delete the duplicate bill row ONLY after confirming zero remaining references to its id anywhere
   you touched (which, at minimum, means the `votes` redirect above completed and step 3's re-check
   passed).
5. After all 34 (or however many are live) are merged, delete the now-empty duplicate `'2026'`
   session row — guarded by an explicit `.eq('id', dupSessionId)` re-check that its bill count is
   genuinely zero first (never delete a session row that still owns bills).

### Phase B — vote reconciliation (read-only on votes/casts, additive-only on flags, NO deletes)

The 31 redirected votes are almost certainly the same real floor actions LegiScan already recorded
independently (verified: all 31 share an exact calendar date with an existing LegiScan vote on the
same now-merged bill; sampled 4 pairs — same real action, near-identical cast counts). This is NOT
resolved by guessing/deleting — it's resolved by running the SAME reconciliation comparison this
codebase already built, reviewed, and uses for 17 other open flags right now:
`crossCheckAgainstPrimarySource` (`src/adapters/legiscan-votes.js`) and its private helpers.

**Reuse, do not reimplement.** Add `export` to these currently-private functions in
`legiscan-votes.js` (pure additive change — just the keyword, zero behavior change, verify the full
suite stays green after this alone before writing anything new):
`summarizePrimaryCastPositions`, `compareTalliesForCrossCheck`, `writeReconciliationFlag`,
`sameCalendarDate`. `PRIMARY_SOURCE_KEY_PREFIXES` and `buildLegiscanVoteSourceKey` are already
exported.

**Do NOT call `crossCheckAgainstPrimarySource` itself or `retractLegiscanVoteIfStored`.** The first
is designed to run BEFORE a LegiScan vote is written (it decides whether to store it); both
LegiScan votes here are already stored and already public — running the live function against
already-published data is not the scenario it was built for. The second is this repo's own-
documented **ONE sanctioned delete, explicitly "never a precedent for a delete anywhere else in
this repo"** (its own header comment) — Phase B must never invoke it, must never delete or modify
either vote or its casts, regardless of what the comparison finds. A genuine hard mismatch, if one
turns up, becomes a flag for Lance — not an automatic retraction. This backfill is a one-off
comparison, not a live-ingest run, and does not get that function's sanctioned exception.

For each of the (live-verified) redirected `mo-senate-web` votes, now on a merged bill_id:
1. Find the matching LegiScan vote(s): `votes` where `bill_id` = this vote's (now-merged) bill_id,
   `jurisdiction_id='mo-legislature'`, same `chamber`, `source_key` starting `'legiscan-'`, and
   `sameCalendarDate` true against this vote's own `vote_date`. Handle 0 matches (report, no flag —
   nothing to compare against) and >1 matches (report as ambiguous, same spirit as the live system's
   own multi-candidate handling — do not guess which one corresponds) honestly; do not silently pick
   one.
2. On exactly one match: pull both votes' own `vote_casts`, summarize each via
   `summarizePrimaryCastPositions` (it's generic over any `position` set, not primary-source-
   specific — reuse it for the LegiScan side too). Build the `legiscanTallies`-shaped input
   (`{ tallies: {yea,nay,not_voting,absent}, chamber, date, runId, rollCallId }` — parse
   `rollCallId` back out of the LegiScan vote's own `source_key`, format
   `legiscan-<sessionId>-rollcall-<rollCallId>`, matching `buildLegiscanVoteSourceKey`'s own
   format exactly — never guess it).
3. Run `compareTalliesForCrossCheck(legiscanTallies, primaryCounts)`.
4. **Clean match (0 hard, 0 soft mismatches): write NOTHING** — this mirrors
   `crossCheckAgainstPrimarySource`'s own clean-match branch exactly (`matched:true, flag:null`).
   Report it as confirmed-same-event for Lance's visibility, no DB write.
5. **Any mismatch: write a `vote_reconciliation_flags` row** via the reused `writeReconciliationFlag`
   (idempotent — it already re-checks for an existing identical flag before inserting, do not
   duplicate that check). `voteId` = the mo-senate-web vote's own id (matches the live system's
   convention: `vote_id` always points at the PRIMARY-source row). `sourceB = 'mo-senate-web'`.
   `reason` = `'hard_mismatch'` or `'soft_mismatch'` — reuse the SAME vocabulary the live system
   uses (the discrepancy shape is identical; inventing a new reason string would fragment reporting
   that already reads these two values). `discrepancy` shape matches the live system's own
   (`source_a_tallies`, `source_b_tallies`, `source_b_result`, `source_b_vote_id`,
   `source_b_source_key`, `hard_mismatches`, `soft_mismatches`, plus `PRESENT_CATEGORY_CAVEAT` when
   `softMismatches.length > 0` — same field, already exported as a constant).

## CLI shape — fold into `correct-data.js`, matching its existing convention exactly

Add `mo-2026-session-merge` as a third `<which>` value (alongside `mo-status`, `mo-1969-dates`,
`all` — decide whether this new one joins `all` or stays deliberately excluded from it given its
higher stakes; lean toward EXCLUDING it from `all` so it always requires being named explicitly,
and say so in a comment). Same `--dry-run`/`--limit` flag shape, same `openRun`/`closeRun` source
tagging, same honest-counts-object return shape as `runCorrectMoStatus`/`runCorrectMo1969Dates`.

**This file's own header states the standing convention: "built READY... Lance runs the live pass
himself — nothing in this repo invokes it live." Follow that convention exactly for this task too**
— build it, verify thoroughly with `--dry-run` against the real live DB (report the full counts:
bills merged, votes redirected, session deleted or not, reconciliation clean-matches vs flags
written vs ambiguous/no-match cases), and STOP at dry-run verification. Do not run it live yourself.

## Constraints

- TDD red-first. Fixture/mock-client tests only — no live DB writes from tests. Given this touches
  deletes and FK redirects, test the edge cases explicitly: a duplicate bill with no canonical twin
  (must report, never invent one); a duplicate bill with non-zero bill_texts/sponsors/summaries
  (must stop and report, never silently redirect); zero/one/multiple reconciliation candidates;
  the session-delete guard refusing when bills remain.
- `selectAll` for any multi-row read. Typed errors matching this repo's conventions.
- Bare `node --test` from repo root; baseline currently 2114, must stay green (both after the
  additive-export-only change AND after the new correction lands — verify both checkpoints).
- Extract the literal `ℹ fail` line yourself; commit ONLY at 0 (lesson 14 — never gate on a
  pipeline's exit status).
- Commit message explains the defect and the fix, ends with:

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

Return: status, commit hash, fail-count line verbatim, the FULL `--dry-run` output against the
real live DB, and concerns — especially anything that surprised you about the live data versus
what this brief assumed (re-verify, don't trust the brief's specific numbers).
