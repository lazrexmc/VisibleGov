# Task review — da69a44 `mo-2026-session-merge` (TODO 25)

Reviewer: independent task-review agent, 2026-08-01. Gate: is it safe to hand the operator the
live command?

- **Spec verdict: MEETS SPEC.** Every clause of `brief.md` is implemented, including the
  discretionary ones (excluded from `all`, `bill_actions` added defensively, dry-run-and-stop).
- **Quality verdict: GOOD.** Deletion path is genuinely defensive and fail-safe at the DB level.
  Two real divergences from the live comparison it claims to reuse (both latent in this batch),
  one un-rerunnable-Phase-B hazard, and a public-rendering consequence the brief never considered.
- **SHIP** — with a mandatory operator briefing (see "Before the operator runs it").

## Test suite (run by this reviewer, bare `node --test` from repo root)

```
ℹ tests 2131
ℹ suites 0
ℹ pass 2131
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21813.0447
```

Matches the claim (2131 = 2114 baseline + 17 new).

---

## Q2 — The deletion safety chain

**(a) Does a duplicate bill ever get deleted before its vote redirect is confirmed complete? NO.**

`src/cli/correct-data.js:519-651` (`processDuplicateBill`) executes strictly in this order, with an
early `return` on every failure:

1. `:520` twin lookup (exact `identifier` + canonical `session_id`); `!== 1` → `stopped`, no writes.
2. `:534-552` four live count-only checks; any non-zero → `stopped`, no writes.
3. `:554` select the dup bill's votes.
4. `:582` **dry-run returns here** — before any write.
5. `:601` `UPDATE votes SET bill_id=canonical WHERE bill_id=dup` (single statement).
6. `:613` **live re-count** `votes WHERE bill_id = dup`; `> 0` → `failed` (`vote_redirect_incomplete`),
   **no delete**.
7. `:632` `DELETE bills WHERE id = dup RETURNING id`; `length !== 1` → `failed`
   (`bill_delete_guard_mismatch`).

The delete at `:632` is unreachable unless the live re-count at `:613` returned 0. Correct.

**(b) TOCTOU on the related-table checks — a real gap, but fail-safe at the database level.**

The four `bill_texts`/`bill_sponsors`/`summaries`/`bill_actions` counts (`:534-552`) run *before*
the vote redirect and are **not** re-checked immediately before the delete at `:632`. A concurrent
writer inserting into one of those tables in that window would not be caught by application logic.

It is nonetheless safe, because the schema makes it fail closed. I enumerated **every** FK to
`bills(id)` across all migrations:

| Table | Migration | On delete |
|---|---|---|
| `bill_actions` | `0001_core_schema.sql:56` | (default NO ACTION) |
| `bill_texts` | `0001_core_schema.sql:66` | (default NO ACTION) |
| `votes` | `0001_core_schema.sql:78` | (default NO ACTION) |
| `summaries` | `0001_core_schema.sql:100` | (default NO ACTION) |
| `bill_sponsors` | `0014_bill_sponsors.sql:17` | (default NO ACTION) |

That is exactly the four in `DUP_BILL_MUST_BE_EMPTY_TABLES` (`:503`) plus `votes` (redirected).
**No FK anywhere declares `ON DELETE CASCADE`**, so a race-inserted child row makes the `DELETE`
raise `23503` rather than silently destroying data — caught at `:633` and reported as
`bill_delete_failed`. Coverage is complete and the residual race is fail-safe, not data-losing.

**(c) Is the session delete guarded by a live re-count? YES.**

`:745-747` issues a fresh `count: 'exact', head: true` on `bills WHERE session_id = dup.id`
immediately before the delete at `:750`. It does **not** use `sessionDeletionEligible` (the
in-memory bookkeeping at `:741`) as the gate — that value is reported only. `remainingBillCount > 0`
→ no delete, no failure (`:760-762`), which is the guard behaving correctly. `sessions(id)` is
referenced only by `bills(session_id)` (`0001_core_schema.sql:45`), so an empty bill count is a
complete precondition, and that FK is also NO ACTION, so a raced bill insert fails the delete
rather than orphaning it.

**(d) Does one bad bill corrupt the batch? NO.**

`processDuplicateBill` returns a tagged result object per bill; the driver loop (`:723-734`) routes
it to `merges` / `stopped` / `failures` and continues. Verified by tests at
`tests/correct-data.test.js:732` (no twin) and `:754` (non-zero related table) — the offending bill
survives, the run continues, and `sessionDeletionEligible` goes false.

Caveat: `processDuplicateBill` has no `try/catch`. supabase-js returns `{error}` for query errors
(handled), but a *transport* rejection (network blip) propagates and aborts the loop mid-run. The
partial state is safe and the run is idempotent-forward, so a re-run finishes the job. Minor.

## Q3 — The one-request / atomicity invariant

**No orphan is reachable.** The redirect (`:601`) is a single `UPDATE ... WHERE bill_id = <dup>` —
all-or-nothing in Postgres. The delete happens only after a *separate live* confirmation that zero
votes remain. Every crash point leaves a consistent, forward-recoverable state:

| Dies… | State | Re-run |
|---|---|---|
| before redirect | dup bill + its votes intact | re-merges cleanly |
| after redirect, before delete | dup bill with 0 votes | re-processes; re-count is 0; deletes |
| after bill delete, before session delete | session with N−k bills | live recount blocks delete until 0 |
| mid-Phase-B | Phase A fully applied | see Important 2 below |

`--limit` cannot strand anything: it caps *which bills* are processed, and each bill is redirected
in full before its own delete. A limited pass leaves the session non-empty, and `:745`'s recount
correctly refuses the session delete (`tests/correct-data.test.js:799`). Bill ordering is
deterministic (`:718`, sort by id).

Nit (Minor): `redirectedCount` at `:611` uses `updatedVotes.length` rather than the `count` the
same call requests. PostgREST's `db-max-rows` would truncate the RETURNING set on a very large
redirect and under-report. Irrelevant at 31 rows, and it does not affect delete safety (the `:613`
recount is the real guard) — reporting accuracy only.

## Q4 — Forbidden-function check (verified independently, not from the test)

`grep -rn "crossCheckAgainstPrimarySource\|retractLegiscanVoteIfStored" src/` — in
`src/cli/correct-data.js` both identifiers appear **only** at lines 32, 35, 37, 335, 355, 787, and
every one is inside a `//` comment explaining why they are *not* called. No import, no call.
Confirmed clean.

The enforcing test (`tests/correct-data.test.js:664`) is **adequate**:

- Reads the right file: `new URL('../src/cli/correct-data.js', import.meta.url)` from `tests/` →
  correct path (and it currently passes, which proves the path resolves).
- `/\bcrossCheckAgainstPrimarySource\(/` catches direct calls **and** namespace calls
  (`ls.crossCheckAgainstPrimarySource(` still contains the word boundary + paren).
- `/import\s*\{[^}]*\bcrossCheckAgainstPrimarySource\b/` catches renamed named imports
  (`{ crossCheckAgainstPrimarySource as x }`) because the original identifier still appears inside
  the braces, and catches multi-line import blocks (`[^}]*` matches newlines).

Evasion that would slip through: `const { crossCheckAgainstPrimarySource: f } = await import(...)`
followed by `f()`, or reaching it through a *different* module. Both are contrived and the second
is out of scope (the whole new code path lives in this one file). Good enough for its purpose.

## Q5 — Reconciliation correctness vs. the live caller

**Argument order and field mapping are correct — no swap.** Side-by-side against
`legiscan-votes.js:679` (the live single-candidate branch):

| | Live (`legiscan-votes.js`) | New (`correct-data.js`) | |
|---|---|---|---|
| call | `compareTalliesForCrossCheck(legiscanTallies, hardCompareCounts)` `:679` | `compareTalliesForCrossCheck(legiscanTallies, primaryCounts)` `:865` | order ✔ |
| arg 1 shape | `{tallies:{yea,nay,not_voting,absent},chamber,date,runId,rollCallId}` | same, built `:855-862` | ✔ |
| arg 2 shape | `summarizePrimaryCastPositions(castRows)` (6 keys) | same, `:853` | ✔ |
| `source_a` | hardcoded `'legiscan'` inside `writeReconciliationFlag` `:527` | same function reused | ✔ |
| `sourceB` | `primarySourceLabel(source_key)` → `'mo-senate-web'` | literal `'mo-senate-web'` `:898` | ✔ equal |
| `voteId` | the **primary** row's id `:714` | `dupVote.id` (mo-senate-web) `:898` | ✔ same convention |
| `rollCallId` | `legiscanTallies.rollCallId` | parsed back out of the LegiScan `source_key` `:495-500` | ✔ inverse of `buildLegiscanVoteSourceKey` |
| `reason` | `hard`/`soft_mismatch` `:712` | identical `:876` | ✔ |

**Two real divergences from the live path (both latent in this batch, neither triggered):**

1. **The `isPrimaryCastDataComparable` gate is not reproduced.** `legiscan-votes.js:652-670` runs
   `parsePrimaryResultAggregate` + `isPrimaryCastDataComparable` **before** any hard/soft
   comparison, precisely so a primary row whose casts have not landed yet is flagged
   `primary_cast_data_not_comparable` rather than hard-flagged. `reconcileOneVote` (`:853-865`)
   skips this entirely. Because mo-senate-web stores `result: null` unconditionally
   (`legiscan-votes.js:408-410`), the gate degenerates to "zero casts ⇒ not comparable" for these
   rows. I checked this live: **0 of the 29 flagged votes have zero primary casts**, so no flag in
   this batch is mislabeled. It remains a latent semantic divergence if this code is reused.
2. **`source_a_tallies` is derived from LegiScan's *stored casts*, not LegiScan's *printed*
   roll-call tallies.** The live caller passes the payload's own tallies; the new code re-derives
   them by counting `vote_casts` (`:854`). Additionally `:856-858` copies only
   `yea/nay/not_voting/absent` out of the 6-key summary, so a LegiScan-side `present`/`other` cast
   would silently vanish from the non-vote bucket and manufacture a soft mismatch. Not reachable
   today (LegiScan's `VOTE_ID_MAP` only produces those four positions), but undocumented.

**Minor shape divergence:** the live discrepancy payload includes a `quarantine` key
(`legiscan-votes.js:709`); the new one omits it (`:868-875`). Anything reading flags for a
`quarantine` field will see `undefined` on these 29 rows.

**Idempotency: structurally guaranteed, but NOT exercised by any test.** `writeReconciliationFlag`'s
own dedupe (`legiscan-votes.js:514-522`, keyed on vote_id/source_a/source_b/roll_call_id/reason) is
reused unmodified, and separately Phase B can only ever see votes Phase A merged *in the same run*
— so a second live run finds no duplicate session, reconciles nothing, and cannot double-flag. No
new test calls `runReconcileMo2026Votes` twice against the same fake client. See Important 2 for
the flip side of that same structure.

## Q6 — The 2 ambiguous cases

**Confirmed: it genuinely refuses to guess.** `:816-826` returns `outcome: 'ambiguous'` with *both*
candidates listed and never touches `writeReconciliationFlag`. Test at
`tests/correct-data.test.js:962` asserts `flaggedCount 0` and an empty flags table. The live
dry-run's own ambiguous case is real: vote `1e57a6cf…` on bill `098dfd46…` has two same-day LegiScan
roll calls (`legiscan-2239-rollcall-1641859` and `-1641860`, both 2026-02-23). Note this is a
*weaker* disambiguation than the live system, which would try tally-identity selection
(`legiscan-votes.js` FIX ROUND 2) — but "report, don't guess" is exactly what the brief asked for
and is the conservative direction.

## Q7 — `--dry-run` makes zero writes (re-verified by this reviewer against the live DB)

I ran `runCorrectData(client, { which: 'mo-2026-session-merge', dryRun: true })` against the real
database with a full before/after row-count snapshot on all ten affected tables:

```
BEFORE == AFTER (diff list empty):
  sessions 33 | bills 38288 | votes 10006 | vote_casts 1466496
  vote_reconciliation_flags 17 | ingestion_runs 465
  bill_texts 3630 | bill_sponsors 46268 | summaries 213 | bill_actions 831
  duplicate session '2026' (4b75c3d3-…) still present, still owns 34 bills
```

Structurally too: `processDuplicateBill` returns at `:582` before any write; the session-delete
block is inside `if (!dryRun)` (`:744`); `reconcileOneVote` returns at `:888` before
`writeReconciliationFlag`. And `main()` skips `openRun` entirely on `--dry-run`, so **not even an
`ingestion_runs` row is written** (confirmed: 465 → 465).

Report reproduced identically to the commit message: 34/34 merged, 31 votes redirected,
`sessionDeletionEligible: true`, `sessionDeleted: false`, 0 stopped, 0 failures; reconciliation
0 clean / 29 hard_mismatch / 2 ambiguous / 0 no-match / 0 unparseable.

## Q8 — File convention and `all` exclusion

**Preserved.** `main()` (`src/cli/correct-data.js`, `---- main ----`) has exactly two paths: the
`--dry-run` branch (no `openRun`, no writes) and the live branch, both reached only from
`process.argv`. Nothing in `src/` or `tests/` invokes `runCorrectMo2026SessionMerge` live — the
17 new tests all drive the in-memory fake. The `invokedDirectly` guard means importing the module
never runs `main()`.

**Excluded from `all`: confirmed.** `:923-928` gates on `which === 'mo-2026-session-merge'` only
(the other two use `|| which === 'all'`), with the rationale in the comment. Pinned by
`tests/correct-data.test.js:1049`, which asserts `all.mo2026SessionMerge === undefined`. Verified in
the live dry-run too — a `which: 'all'` run would not have produced the merge report.

## Q9 — Test quality

The 17 new tests do pin the named dangerous edges: no canonical twin (`:732`), non-zero
`bill_texts` on a dup bill (`:754`), the session-delete guard refusing a partial pass (`:799`),
multiple reconciliation candidates (`:962`), zero candidates (`:945`), both dry-run zero-write
paths (`:776`, `:989`), and the `all`-exclusion (`:1049`).

**What they would NOT catch (Important 3 below):**

- **The delete-ordering safety chain is not pinned.** No test drives `forceError` on the `votes`
  update (or on the `:613` re-count) to prove the bill delete is *skipped*. The fake client already
  supports `forceError`, so this was cheap. A regression that deleted the bill before redirecting
  its votes would still pass `:696` — that test asserts the end state (vote redirected, bill gone)
  and is order-blind.
- No test for `vote_redirect_incomplete` (`:623`) or `bill_delete_guard_mismatch` (`:633`) — the two
  guards standing between a redirect failure and a destructive delete.
- No test for `multiple_canonical_twins` (`:530`), `unparseable` source_key (`:836`), or the
  `session_bill_recount_failed` / `session_delete_failed` failure branches.
- No re-run/idempotency test for the flag write.
- `:656` asserts only 3 of the 4 entries in `DUP_BILL_MUST_BE_EMPTY_TABLES` — `bill_actions`, the
  one added beyond the brief, is unpinned and could be silently dropped.

---

## Findings

### Critical
None. No path deletes anything without a live, immediately-preceding confirmation, and the schema
has no cascading FK to turn a missed check into data loss.

### Important

1. **The merge publishes a known-contradictory pair of roll calls onto one public bill page.**
   `site/js/bill-page.js:500` fetches `votes?bill_id=eq.<billId>`. Today the 31 mo-senate-web votes
   hang off the duplicate bills; after Phase A they land on the canonical bills alongside LegiScan's
   own vote for the same real floor action. 29 of those 31 pairs *disagree*. The public bill page
   will therefore render two roll calls for one action with different tallies. The brief scopes
   Phase B to "write a flag for Lance" and never considers that Phase A itself changes what the
   site shows. This is an operator decision, not a code defect — but it must be made before the
   live run, not after.

2. **Phase B is one-shot and cannot be re-run after Phase A succeeds.** `runReconcileMo2026Votes`
   (`:928`, driven from `:911`) only ever sees `merge.merges[].voteRows` — bills merged *in this
   run*. Once the duplicate session is gone, a re-run merges nothing and reconciles nothing.
   Combined with the fact that `writeReconciliationFlag` **throws** on an unexpected error
   (`legiscan-votes.js:551`) and that throw is not caught in `reconcileOneVote` (`:897`), a single
   transient DB error partway through the flag loop permanently loses the remaining reconciliations
   with no re-run path. No data is lost (both votes survive); the *flags* are. Suggested mitigation
   for the operator: none needed in code, but if the live run aborts mid-Phase-B, say so — do not
   assume a re-run will finish it.

3. **The deletion-ordering chain is untested** (detail in Q9). The safety property this whole review
   turns on is the one property no test pins.

4. **The live comparison is not byte-for-byte the live path** (detail in Q5, items 1–2). Latent
   today, verified non-triggering in this batch (0 zero-cast primary rows).

5. **Root cause is not fixed — the duplicate session will regrow.** The brief itself names
   `ingest-mo-senate.js:472`'s `insertIfAbsent` as the creator of the `'2026'` row. Nothing in this
   commit changes that. The next Senate-journal run re-creates the duplicate session and starts
   re-accumulating duplicate bills. This correction is a cleanup, not a fix, and should be logged
   as such in TODO.

### Minor

6. `:611` `redirectedCount` from `updatedVotes.length` instead of the requested `count` — reporting
   only, no safety impact (`:613` is the real guard).
7. `:601` overwrites `votes.run_id` with the correction run id, replacing the original ingest
   provenance. Consistent with the file's other corrections, but worth knowing it is not reversible
   from the row itself.
8. `processDuplicateBill` has no `try/catch`; a transport-layer rejection aborts the loop (state
   stays safe and forward-recoverable).
9. Discrepancy payload omits the live shape's `quarantine` key (Q5).

---

## Diagnostic: what the 29 hard mismatches actually are

Not asked for, but material to the operator decision, and it changes how the 29 flags should be
read. I compared the two votes' `vote_casts` name-by-name across all 29 flagged pairs (read-only):

```
29x  travis fitzwater :: legiscan=yea, absent from the mo-senate-web record entirely
21x  mary coleman      :: legiscan=yea  } same human, two legislators rows
21x  mary elizabeth coleman :: primary=yea }  (cancels in the tallies)
 6x  rick brattin      :: primary=absent, absent from the LegiScan record
 5x  steven roberts    :: primary=absent, absent from the LegiScan record
 4x  mike moon         :: primary=nay,    absent from the LegiScan record
 …
```

Two conclusions:

- **All 29 hard mismatches are the same single defect**: LegiScan records a `yea` for Sen. Travis
  Fitzwater on all 29 roll calls and the mo-senate-web journal parse has **no cast for him at all**
  — exactly the "roster-gating / dropped unresolved-surname casts" undercount
  `legiscan-votes.js:399-400` already documents for that pipeline. The compensating +1 in the
  primary's non-vote bucket comes from assorted members LegiScan omits entirely. So this is 29 rows
  recording one root cause, and the mo-senate-web side is the demonstrably incomplete one.
- **Separately, the MO Senate roster is duplicated in `legislators`**: every senator has a
  LegiScan-sourced row (party populated) and a mo-senate-web-sourced row (party `null`), plus at
  least one name-variant pair ("Mary Coleman" / "Mary Elizabeth Coleman"). Casts for the same human
  on the same real vote point at different rows depending on source. This does not affect the merge
  or the tallies (it cancels), but it is a live identity defect worth its own TODO entry.

The comparison machinery therefore did its job correctly — it found a real, systematic primary-source
undercount. The flags are legitimate. They are just 29 instances of one thing.

---

## Verdict

**SHIP** — the destructive path is safe to hand to the operator. Verified: no delete without an
immediately-preceding live confirmation; complete FK coverage with no cascade anywhere; per-bill
failure isolation; crash-safe and idempotent-forward at every step; genuine zero writes in
`--dry-run` re-confirmed against the live DB; forbidden functions independently confirmed absent;
excluded from `all`; nothing in the repo runs it live.

### Before the operator runs it, tell him

1. Phase A will put 31 mo-senate-web votes onto canonical bill pages next to LegiScan's own vote for
   the same action, and 29 of those pairs disagree publicly. Decide what should happen to those 31
   votes *before* running, not after (Important 1).
2. All 29 mismatches are one root cause — Sen. Travis Fitzwater's `yea` missing from every
   mo-senate-web roll call. The 29 flags are not 29 independent problems (Diagnostic).
3. If the run aborts partway through Phase B, the remaining reconciliations cannot be recovered by
   re-running the command (Important 2).
4. The duplicate `'2026'` session will be re-created by the next `ingest-mo-senate` run — this
   cleans up, it does not fix (Important 5).
