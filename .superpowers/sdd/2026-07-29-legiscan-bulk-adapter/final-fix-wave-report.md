# Final-review fix wave — report

Branch `legiscan-bulk-adapter`, base HEAD `da14ddb`. Fixes all 7 confirmed defects from
`final-review-findings.md` (3 Critical, 4 Important). No live LegiScan API queries, no live DB
writes at any point — every test runs against the existing fake-Supabase-shaped clients already
established by this branch's own test infrastructure.

## CRITICAL 1 — monthly query-budget ledger erased by closeRun

**Root cause confirmed**: `recordQueryUsage` (write-ahead) persists `detail.queries_used`
(snake_case) during the run. `main()`'s own `closeRun` calls on both success and failure never
included that key — success spread `result.counts` (which carries `queriesUsed`, camelCase, a
different field) and failure sent only `{ error }`. `closeRun` replaces `detail` wholesale, so
either path silently zeroed the ledger `getMonthlyQueryUsage` reads.

**Fix direction chosen**: carry-forward in `main()`, NOT a `closeRun` merge-semantics change.
`src/lib/db.js`'s `closeRun` is untouched. Verified via `grep -rn "closeRun("  src/` that 9 other
CLI drivers (`ingest-mo-senate.js`, `ingest-mo-house.js`, `verify.js`, `extract-terms.js`,
`auto-publish-glossary.js`, `gloss.js`, `summarize.js`, `ingest.js`) all call `closeRun` assuming
wholesale replace with a caller-constructed complete detail object — changing that contract would
be a repo-wide behavior change to fix one file's bug. This matches the instructed guidance and is
the safer, smaller-blast-radius fix.

**Changed**: `src/cli/ingest-legiscan.js`
- `recordQueryUsage` now exported (:617, was module-private) — same "extract for direct
  testability" precedent as `assertRunUnderBudget`.
- New `buildSuccessCloseDetail(counts)` (:~909) — returns `{ ...counts, attribution, queries_used:
  counts.queriesUsed }`.
- New `buildFailureCloseDetail(client, runId, err)` (:~918) — best-effort re-reads
  `ingestion_runs.detail.queries_used` (survives even if `runLegiscanIngest` never completed, since
  the write-ahead write happens before the live call it counts) and returns
  `{ error: String(err), queries_used }`. A re-read failure is swallowed so it never masks the
  original error.
- `main()`'s success/catch `closeRun` calls now use these two helpers instead of ad-hoc payloads.

**New tests** (`tests/ingest-legiscan-cli.test.js`):
- "close-then-read round trip" — `recordQueryUsage` → `closeRun(buildSuccessCloseDetail(...))` →
  `getMonthlyQueryUsage` returns the real count (2), not 0.
- `buildSuccessCloseDetail` unit test (camelCase preserved alongside new snake_case key).
- `buildFailureCloseDetail` reads back usage-so-far after a simulated mid-flight throw, and reads 0
  honestly when nothing was ever spent.
- Full failure-path composition: `recordQueryUsage` → `closeRun('failed', buildFailureCloseDetail(...))`
  → `getMonthlyQueryUsage` still shows 1, proving Ruling 3 ("crash must overcount, never undercount").

**Evidence**: all 5 tests pass; full suite green (see bottom).

## CRITICAL 2 — quarantine is insert-time-only, no retraction

**Fix**: `src/cli/ingest-legiscan.js:405` — new exported `retractLegiscanVoteIfStored(client,
sourceKey)`. Guards `sourceKey.startsWith('legiscan-')` (throws otherwise — "the one sanctioned
delete in this codebase," commented as such, per the controller amendment), looks the vote up by
`source_key`, and on a hit deletes `vote_casts` (by `vote_id`) THEN `votes` (by `id`) — FK order, as
directed. No-op (not an error) when nothing is stored yet.

Wired into `ingestLegiscanRollCalls`'s quarantine branch (:540-559): every `crossCheck.quarantine`
now calls this before counting. `result.retractedVotes`/`result.retractedRollCalls` are new,
distinct counters (only incremented when a row was ACTUALLY found+deleted, not on a fresh
insert-time quarantine) — both flow through to `runLegiscanIngest`'s `counts`.

**Disclosed complication (see Concerns)**: after Findings 3+5 land (same commit), no branch of
`crossCheckAgainstPrimarySource` can produce `quarantine:true` from real correspondence evidence
anymore. To still directly test the driver's retraction behavior end-to-end (not just as an
isolated helper), I added a `crossCheckFn` injectable dependency to `runLegiscanIngest`/
`ingestLegiscanRollCalls` (defaults to the real `crossCheckAgainstPrimarySource`, mirrors the
existing `getDatasetListFn`/`getDatasetFn` convention exactly). This is the ONE new public-surface
addition in this fix wave beyond what the findings literally asked for, and exists purely for
testability.

**New tests** (`tests/ingest-legiscan-cli.test.js`):
- "a LegiScan vote already stored by a PRIOR run is RETRACTED ... with NO manual wipe step between
  runs" — pass 1 stores all 8 real roll calls normally (no primary rows exist); pass 2, WITHOUT
  wiping `tables.votes`/`tables.vote_casts`, injects a `crossCheckFn` that forces
  `quarantine:true` for roll call 774411 only (every other roll call runs the REAL
  `crossCheckAgainstPrimarySource`, unmodified). Asserts: `retractedVotes===1`,
  `retractedRollCalls` names 774411, the vote row AND its casts are gone, and all 7 other roll
  calls remain untouched. This is the literal "persisted-store re-run WITHOUT the manual wipe" test
  the task named, and it directly supersedes the old test at the ~621 line range that only passed
  via a manual `tables.votes.splice(...)` wipe.
- 3 direct unit tests of `retractLegiscanVoteIfStored` — FK-order delete + untouched-sibling-row
  proof, no-op on absent source_key, and the `legiscan-` prefix guard throwing on a non-legiscan key.

**Evidence**: all 4 tests pass.

## CRITICAL 3 — cast-less/partial-cast primary rows produce false hard quarantines

**Fix**: `src/adapters/legiscan-votes.js` — new `parsePrimaryResultAggregate(result)` (parses
mo-house's `"<yea>-<nay>"` `result` string) and `isPrimaryCastDataComparable(aggregate,
totalPrimaryCasts)`, implementing the controller amendment's literal two conditions: NOT
comparable when (a) an aggregate exists and stored casts are short of `aggregate.yea +
aggregate.nay`, or (b) no aggregate exists (mo-senate's `result: null` by ruling) and casts are
zero. The `votes` select in `crossCheckAgainstPrimarySource` now also fetches `result` (:447) so
Branch B (the `candidates.length===1 && siblingTallies.length===0` block, :570-649) can read it.

Branch B now checks comparability FIRST, before any hard/soft comparison: not-comparable →
store + soft-flag (`reason: 'primary_cast_data_not_comparable'`), never touches
`compareTalliesForCrossCheck` at all. When comparable, the HARD (yea/nay) comparison prefers the
printed aggregate over the (possibly still-partial) cast-derived count — the soft bucket still
comes from `castRows`, which comparability just established are sufficient.

Scope note: this gate is applied ONLY in Branch B (the ordinary singleton/singleton path). The
other three branches (C: N=1 primary + siblings; D: N>1 primary candidates) select their compared
candidate BY tally equality first — a candidate whose casts are so undercounted it can't
possibly tally-match a real LegiScan roll call simply never gets selected there, so it falls into
those branches' existing `no_tally_corresponding_primary`/`ambiguous_tally_match` outcomes
(already non-quarantining) rather than needing this gate too. Confirmed by re-reading all three
branches' selection logic — see Concerns for the one theoretical edge case this doesn't cover.

`src/cli/ingest-legiscan.js`'s `classifyCrossCheckFlagReason` (:352) and both `crossCheckFlags`
shape literals (now unified into one `emptyRollCallResult()`, :425) gained a
`primary_cast_data_not_comparable` bucket, so this is surfaced distinctly in run detail rather than
falling into the `other` catch-all.

**New tests** (`tests/legiscan-votes.test.js`):
- Zero-cast, mo-senate shape (`result: null`, 0 casts) → not comparable, store+soft-flag,
  `quarantine:false`.
- Partial-cast, mo-house shape (`result: "119-23"`, only 5 yea casts landed) → not comparable even
  though a naive cast-only compare would show a wild "5 vs 119" mismatch.
- "aggregate preferred" — casts sufficient in TOTAL (237 ≥ 133) but deliberately WRONG (200 yea
  casts) vs a printed aggregate of "110-23"; asserts the flagged hard mismatch is `"legiscan 119 vs
  primary 110"` (the aggregate's own number), not `"vs primary 200"` — proves comparability
  resuming doesn't mean trusting stale/wrong cast data once aggregate-preference kicks in, and that
  a real mismatch is still caught, never permanently exempted.

**Evidence**: all 3 tests pass.

## IMPORTANT 4 — `--limit` truncates the sibling-tally pool

**Fix**: `src/cli/ingest-legiscan.js`'s `ingestLegiscanRollCalls` (:451) now takes `allRollCalls`
(always the full parsed dataset) and `rollCallsToProcess` (the possibly `--limit`-sliced subset)
separately. Phase 1 reconciles `allRollCalls` in full — every reconciling roll call, selected or
not, feeds Phase 2's `groupReconciledRollCallsByTuple` — so a roll call's sibling-tuple knowledge is
never blind to a same-tuple roll call `--limit` sliced away. `reconciliationFailures`/
`reconciliationFailureDetails`/`voteId3SpotVerify` and Phase 3 (cross-check + store) still only
apply to `rollCallsToProcess` — `--limit` continues to govern what the run itself touches/reports
on; only the grouping INPUT widened.

**Verified the real repro directly**: read the actual dataset-2018-1608 fixture's roll-call array
order (`node -e` against `extractDatasetFiles`) — it is `774311, 774412, 774312, 774313, 774314,
774315, 774316, 774411`, so `--limit 3` selects exactly `[774311, 774412, 774312]`, excluding
774313-774316 (774312's real same-tuple siblings) entirely. This matches
final-review-findings.md's literal repro description.

**New test** (`tests/ingest-legiscan-cli.test.js`): seeds a primary row with 774313's TRUE tallies
(36-92, not 774312's own 119-23), runs `--limit 3`. Asserts `quarantinedVotes:0` and
`crossCheckFlags.hard_mismatch:0` — 774312 must resolve as honestly uncorresponded
(`corresponds_to_sibling`, since 774313's own printed tallies are still visible to the sibling pool
even though 774313 itself isn't processed this run), never compared directly against the
mismatched primary row. A second, full run (`limit: null`) over identical seeded state confirms
774313 itself verifies cleanly (`tally_unique_match`) once it IS processed.

**Evidence**: test passes; the pre-fix code would have shown `crossCheckFlags.hard_mismatch:1`
(confirmed by reasoning through the old code path, not by reverting and re-running — see Concerns).

**Deliberately not implemented**: the finding's own hedged "consider including reconcile-failed
siblings in sibling-count knowledge" — the sibling pool only includes roll calls that PASS internal
gate (a). Not needed to close the literal repro (none of the 8 real 1608 roll calls fail internal
reconciliation), and adding it would mean inventing sibling-tally data from a roll call whose own
numbers don't even internally add up — judged out of scope; disclosed, not silently dropped.

## IMPORTANT 5 — Branch B infers correspondence from singleton-ness alone

**Fix**: `src/adapters/legiscan-votes.js`, the `siblingTallies.length === 0` block (:570-649,
"Branch B"). A hard (yea/nay) mismatch there no longer sets `quarantine: true` — it always stores +
flags (`reason: 'hard_mismatch'` or `'soft_mismatch'`), exactly mirroring branches C/D's own
zero-/ambiguous-match treatment. Comment documents the "align branch B with C/D semantics" ruling
and the reasoning: branches C/D only ever run their hard/soft comparison AFTER selecting a
candidate BY tally equality, so `hardMismatches` there is *always* empty by construction — meaning
after this fix, **no branch of `crossCheckAgainstPrimarySource` can produce `quarantine:true` from
real correspondence evidence anymore**. I re-verified this by re-reading every return path in the
function (not just Branch B) — every branch either hardcodes `quarantine:false` or derives it from
a hard-mismatch check that branch's own selection filter guarantees is empty. See Concerns — this
is disclosed prominently, not a quiet side effect.

**Rewrote 4 existing tests** in `tests/legiscan-votes.test.js` that asserted `quarantine:true` for
Branch B hard mismatches (YEA-only, NAY-only, mixed hard+soft, and the no-4th-arg/no-siblings
case) — now assert `quarantine:false`, `matched:false`, store+flag, `discrepancy.reason:
'hard_mismatch'`. Also rewrote the "migration 0010 not applied" degraded-gate test (was asserting
"quarantine STILL reported correctly" as `true`; now `false`, with the comment explaining the
quarantine DECISION, not just the flag durability, changed).

**Driver-level rewrite** (`tests/ingest-legiscan-cli.test.js`): the exact test
final-review-findings.md cites by line range (~621, the manual-wipe one) is superseded — its
premise (a fresh hard mismatch quarantines) is now simply false. Split into two tests: one proving
the NEW real behavior (774411 stores + flags, `quarantinedVotes:0`), and the separate CRITICAL-2
retraction test described above (which needed the `crossCheckFn` injection precisely because this
fix removed the only real path to `quarantine:true`).

**Evidence**: all rewritten + new tests pass (7 in legiscan-votes.test.js, 2 in
ingest-legiscan-cli.test.js touch this finding directly).

## IMPORTANT 6 — vote_reconciliation_flags writes are non-idempotent

**Fix**: `src/adapters/legiscan-votes.js` — `writeReconciliationFlag` (:439) now requires
`rollCallId`/`reason` at every one of its 8 call sites (all updated) and stamps them into the
stored `discrepancy` itself (`discrepancy.roll_call_id`, `discrepancy.reason` — self-describing to
a human reviewer, not just an internal lookup key). New `findExistingReconciliationFlag` runs a
pre-insert check on `(vote_id, source_a, source_b)` and filters client-side for a matching
`(roll_call_id, reason)` — app-level check-then-insert, single-process-driver race-safe per the
controller amendment. A `resolved:true` row is returned untouched (never re-inserted,
`resolved:false`, on re-detection). New `isUniqueViolation` (23505) handling: if migration 0011's
own index catches a race the app-level check missed, the insert's 23505 error is caught and the
function re-selects/returns the row that won, instead of throwing.

**Migration** (draft, Lance applies): `supabase/migrations/0011_flag_idempotency.sql`. **Design
choice, disclosed**: rather than adding physical `roll_call_id`/`flag_reason` columns (which the
amendment's phrasing could be read as implying), the migration adds a unique EXPRESSION index
directly over the existing `discrepancy` jsonb column: `(vote_id, source_a, source_b,
((discrepancy->>'roll_call_id')::integer), (discrepancy->>'reason'))`. No new columns, no backfill,
no dual-shape insert path — `discrepancy` has carried these fields since the app-level fix landed
(same commit), so the SAME insert shape works whether or not 0011 has been applied yet, trivially
satisfying "the insert path must tolerate both pre- and post-0011." Deliberately excludes
`resolved` from the index (a resolved row must keep blocking a fresh unresolved duplicate — that
IS the bug being closed).

**New tests** (`tests/legiscan-votes.test.js`):
- 3 identical re-runs of the same discrepancy → exactly 1 flag row.
- A human-resolved flag stays resolved across a re-run (no new `resolved:false` duplicate).
- Two genuinely different LegiScan roll calls (774411, 774412) both contradicting the same primary
  row → 2 distinct flags (the key includes `roll_call_id`, never collapses distinct discrepancies).
- A simulated 23505 unique-violation (fake DB inserts a "raced-in" row directly, then returns 23505
  on the original insert attempt) → caught, re-selected, returned — never thrown, no duplicate.

**Evidence**: all 4 tests pass. Migration SQL syntax reasoned through carefully (expression-index
parenthesization, jsonb `->>` + cast precedence) but **not verified against a live Postgres
instance** — no DB access this session; Lance should sanity-check on apply.

## IMPORTANT 7 — cache path never re-verifies dataset hash; fresh path silently skips on null hash

**Fix**: `src/cli/ingest-legiscan.js`'s `resolveDatasetBytes` (:625).
- Cache branch (`!gate.shouldFetch`, :651): after reading the cached envelope, now decodes +
  extracts it (same `extractDatasetFiles` Task 4 surface) and compares its own in-archive
  `hash.md5` against `ledgerRow.dataset_hash`. Mismatch → `DatasetHashMismatchError` (never parsed/
  processed). Hashless cached archive → `gate.hashVerification = { verified: false, reason:
  'cached_archive_missing_hash_md5' }` (loud, counted, not thrown — a genuinely hashless archive
  isn't itself evidence of tampering).
- Fresh-fetch branch (:~715): `verifyParse.datasetHash == null` is now its own explicit branch
  (`gate.hashVerification = { verified: false, reason: 'fetched_archive_missing_hash_md5' }`)
  instead of the old `datasetHash != null && ...` silent-skip. A matching-hash fresh fetch now
  reports `{ verified: true }` explicitly too (previously implicit/unrecorded).

`gate.hashVerification` flows through unchanged into `counts.datasetGate` in run detail — no
separate plumbing needed.

**New tests** (`tests/ingest-legiscan-cli.test.js`), using a synthetic minimal ZIP builder
(`buildMinimalDatasetZipBase64`, reusing the file's existing `buildStoredZip`):
- Cache branch, swapped/stale file (ledger claims `hash-A`, on-disk archive's real hash is
  `hash-B`) → throws `DatasetHashMismatchError` naming both.
- Cache branch, hashless cached archive → `{ verified: false, reason:
  'cached_archive_missing_hash_md5' }`, no throw.
- Fresh branch, hashless fetched archive → `{ verified: false, reason:
  'fetched_archive_missing_hash_md5' }`, no throw, AND the dataset is still cached + ledgered
  (`tables.legiscan_datasets.length===1`).
- Fresh branch, matching hash (regression guard on the pre-existing happy path) → `{ verified:
  true }`.

**Evidence**: all 4 tests pass.

## Test summary

`node --test` (bare, no directory arg — Node 24/Windows constraint, PLAYBOOK_DELTA §7.1): **808
pass / 808 total / 0 fail** (baseline 787 + 21 new: legiscan-votes.test.js 40→47, +7;
ingest-legiscan-cli.test.js 36→50, +14). Every required test shape from the task brief is present:
close-then-read round-trip; persisted-store re-run without the manual wipe; zero-cast and
partial-cast primary; `--limit` with a seeded primary; branch-B hard-mismatch store+flag;
3-runs-1-flag idempotency + resolved-stays-resolved; cache-branch hash mismatch + null-hash loud
path. No live API queries, no live DB writes at any point — all fake-client-based.

## Files touched

- `src/adapters/legiscan-votes.js` — Findings 3, 5, 6.
- `src/cli/ingest-legiscan.js` — Findings 1, 2, 4, 7.
- `supabase/migrations/0011_flag_idempotency.sql` — draft, Finding 6 (Lance applies).
- `tests/legiscan-votes.test.js` — new/rewritten tests for Findings 3, 5, 6.
- `tests/ingest-legiscan-cli.test.js` — new/rewritten tests for Findings 1, 2, 4, 5, 7; fake-client
  `delete()` support added.
- `src/lib/db.js` — **untouched** (carry-forward approach chosen over closeRun-merge for Finding 1;
  see that section above for the justification).

## Concerns (full disclosure)

1. **After this fix wave, `crossCheckAgainstPrimarySource` cannot itself produce `quarantine:true`
   from any of its own branches, given real correspondence evidence.** This is the single most
   important thing to understand about this commit set. Finding 5's own fix direction ("reserve
   quarantine for corroborated correspondence") collides with the fact that branches C/D's only
   form of corroboration (tally-equality selection) makes a hard mismatch on the selected candidate
   mathematically impossible by construction — so removing Branch B's ability to quarantine (the
   only branch that DIDN'T select-by-tally-match first) removes the last real path to
   `quarantine:true` anywhere in the module. I verified this by re-reading every return statement
   in the function, not just asserting it from the diff. Practical effect: Critical 2's retraction
   logic (`retractLegiscanVoteIfStored`, wired into the driver) is fully implemented and directly
   tested, but under the CURRENT mechanical evidence this codebase can produce, it will not fire in
   a real production run — it is defense-in-depth / API-contract preservation, not something that
   currently protects against an ordinarily-reachable state. If a future change reintroduces a real
   corroboration signal that can coexist with a hard mismatch (e.g., cross-referencing a third
   source), this machinery is ready for it; until then it is not exercised by any live code path.
   I flagged this explicitly in code comments in both files, but it deserves it here too since it
   is the kind of finding-interaction a reviewer skimming diffs in isolation could easily miss.

2. **New public API surface**: `runLegiscanIngest`'s `deps` now accepts `crossCheckFn` (defaults to
   the real `crossCheckAgainstPrimarySource`). Added SOLELY to make (1) directly testable at the
   driver-composition level, mirroring the existing `getDatasetListFn`/`getDatasetFn` convention.
   `main()` never passes it, so no behavior change for any real invocation — but it is new surface
   a future reader should know exists and why.

3. **Migration 0011 uses an expression index over jsonb, not new physical columns** — a deliberate
   reading of the controller amendment that I judged cleaner (see Finding 6 section above), but it
   IS a judgment call, not the only valid reading. Flagging for Lance's review before applying.

4. **Migration 0011's SQL was reasoned through, not executed against a live Postgres.** No DB
   access this session (Supabase MCP unauthenticated; policy also forbids live DB writes for this
   task). Standard draft-then-apply — Lance should sanity-check the expression-index syntax on
   apply, though I'm confident in it.

5. **`--limit`'s fix keeps `reconciliationFailures`/`voteId3SpotVerify` scoped to the `--limit`-
   selected subset** — only the sibling-tuple GROUPING widened to the full dataset. This is a
   deliberate, minimal read of "apply --limit only to which ones are processed" (preserves existing
   `--limit` semantics for every counter except the one that was actually broken). A different,
   more aggressive reading (widen ALL counters to reflect the full dataset regardless of `--limit`)
   was not implemented.

6. **The "reconcile-failed siblings" extension Finding 4 hedged with "consider" was not
   implemented** — sibling knowledge only includes roll calls that pass internal reconciliation
   gate (a). Not needed for the literal repro (all 8 real 1608 roll calls reconcile internally);
   would require inventing sibling-tally data from a roll call whose own numbers don't add up.
   Disclosed, not silently dropped.

7. **Idempotency (Finding 6) is keyed on classification, not content.** If the SAME
   `(vote_id, roll_call_id, reason)` triple is re-detected on a later run with DIFFERENT specific
   discrepancy numbers (e.g., the primary source's own cast count changed between runs, still
   classified as `hard_mismatch`), the fix treats it as the same discrepancy and does NOT insert an
   updated row — the original numbers stay durably recorded. This matches the literal controller
   amendment (keyed on `roll_call_id`+`reason`, not full content) but means a content-level drift
   between runs is invisible unless a human inspects the discrepancy JSON directly. Worth knowing,
   not fixed here — the amendment's key shape is binding, not my own design choice.

8. **`buildFailureCloseDetail` adds one new DB read to the failure path** (`ingestion_runs.select
   ('detail')` inside `main()`'s catch block) that didn't exist before. Wrapped in its own
   best-effort try/catch so a read failure can never mask the original error, but it is a genuine
   new read on every failed run, worth knowing about for anyone reasoning about this driver's query
   footprint (it is NOT a LegiScan API query, only a Supabase read, so it does not affect the
   30,000/month LegiScan budget itself).

9. **Commit granularity**: I could not safely split this into 7 per-finding commits — several
   findings land in the literal same code block (3+5 in Branch B; 2+4 both restructure
   `ingestLegiscanRollCalls`) and the two test files assert behavior that depends on BOTH source
   files' new state simultaneously (e.g., the driver-level retraction test needs Finding 5's
   quarantine-removal AND Finding 2's retraction wiring both present to make sense; the `--limit`
   sibling test needs Finding 4's grouping fix and would false-fail differently under old vs. new
   Finding 5 quarantine semantics). Splitting by file/finding would produce intermediate commits
   with a red test suite, which the "full suite green" requirement rules out. Committed as 2
   logical groups instead: (a) all interdependent app+test code in one commit, (b) the standalone
   migration draft in a second, independent commit (touches no app code, changes nothing test-run
   behavior since Lance hasn't applied it).

No other known issues. No live API/DB calls were made at any point in this work.
