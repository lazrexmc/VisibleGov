# Task review — f692b34 "mo-house one-request-per-run" restructure

Reviewed as hostile-environment code: this CLI is invoked unattended by Windows Task Scheduler
every ~30 min forever, with nobody watching a given run. Commit is on `main` locally, one ahead
of `origin/main`, not yet pushed.

## Verdicts

- **Spec verdict: MEETS SPEC.** The at-most-one-live-request-per-invocation invariant holds —
  verified both structurally (full control-flow trace of every reachable fetcher, not just by
  reading the tests) and by the test suite. ToU-critical code (limiter, durable cooldown) is
  byte-identical to the parent commit. The scheduler's frozen `['--limit','1']` invocation and the
  `moHouseWroteSomething` field contract both still hold.
- **Quality verdict: SOLID, ships clean, two non-blocking test-coverage gaps worth closing.**
  Comments are accurate (no overclaims beyond two historical/narrative claims about live
  production data I have no DB access to check this session). Tests are fixture-only and
  genuinely red-first (proven mechanically, see below). Two coverage gaps exist around exactly
  the risk classes the task asked me to hunt for — neither is a live defect (I independently
  proved the underlying behavior is safe by reading the code directly), but neither is currently
  *proven by a test* either.

## SHIP / DO-NOT-SHIP: **SHIP**

Rationale: no Critical findings. The two Important findings are test-coverage gaps, not
demonstrated bugs — in both cases I traced the actual runtime behavior by hand (not just read the
tests) and confirmed it's safe. Given this code's hostile/unattended profile, I'd still want the
two gaps closed in a fast follow-up commit (tests only, no production-code change implied), but
they don't block this push.

---

## 1. `node --test` — literal fail-count line

Ran bare `node --test` myself (not `npm test`, not a pipeline wrapper). Extracted tail:

```
ℹ tests 2101
ℹ suites 0
ℹ pass 2101
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Matches the commit/TODO.md claim exactly (`2101/2101 green`, "claimed `ℹ fail 0`").

---

## 2. THE INVARIANT — exhaustive enumeration (explicit answer)

Repo-wide grep for every live fetcher (`fetchMoBillList`, `fetchMoBillXml`, `fetchMoMemberList`,
`fetchMoRepresentative`, `fetchMoRollCallPdf`) confirms exactly three are reachable from
`runMoHouse`, and two are not reachable at all:

| Fetcher | Reachable from `runMoHouse`? | Call site | Max calls/invocation |
|---|---|---|---|
| `mo.fetchMoBillList` (injectable as `fetchBillList`) | Yes | `ingest-mo-house.js:1046`, inside SLOT (a) only | 1 |
| `mo.fetchMoBillXml` (injectable as `fetchBillXml`) | Yes | `ingest-mo-house.js:1104`, inside the per-target loop | 0 or 1 |
| `pdf.fetchMoRollCallPdf` | Yes | `ingest-mo-house.js:764` via `processRollCallPdf`, inside the `if (pendingPdf)` branch | 0 or 1 |
| `mo.fetchMoMemberList` | **No** — zero call sites outside `mo-house-xml.js`'s own definition | — | 0 |
| `mo.fetchMoRepresentative` | **No** — zero call sites outside `mo-house-xml.js`'s own definition | — | 0 |

**`persistRoster` hard-check (explicitly requested):** `persistRoster` (`ingest-mo-house.js:812-846`)
reads `ROSTER_REPRESENTATIVE_FIXTURE` (`tests/fixtures/research/mo-house-xml/representative-107.xml`)
via `readFileSync` only, in all three places it's called (the `--bill-xml-file` branch, SLOT (a),
and SLOT (b)). It never calls `fetchWithLimit`, `moHouseLimiter`, or either roster-related fetcher.
Confirmed by direct reading of the function body and by the grep table above (zero outside call
sites for either roster fetcher in the entire `src/` tree). **persistRoster fetches nothing live,
in any invocation shape.**

**Why the three reachable fetchers can't combine (structural proof, not just test-proof):**
- PDF-priority branch (`ingest-mo-house.js:1012-1027`): `if (pendingPdf) { ...; return {runId, status, counts}; }` — an *unconditional* return (fires regardless of `failures.length`) that precedes the list/bill-detail code entirely. `pdf.fetchMoRollCallPdf` can only ever fire here, and this branch can only run zero or one live fetch of its own (`processRollCallPdf` calls it exactly once, no loop).
- List-refresh SLOT (a) (`ingest-mo-house.js:1043-1071`): `if (shouldRefetchBillList(...)) { ...; return {...}; }` — also an unconditional return, reached BEFORE `selectTargets`/the per-bill loop exist in scope. `fetchMoBillList` can only fire here.
- Bill-detail SLOT (b) / `--bill-xml-file` bypass (`ingest-mo-house.js:1072-1121`): only reached when SLOT (a) did *not* fire. The per-target loop iterates `selectTargets(entries ?? [], args, billsDir)`, which is sliced to `args.limit` — and `args.limit > 1` is rejected at function entry (`ingest-mo-house.js:975-985`, checked first, before any DB/network activity), so `args.limit` is always exactly `1` by the time targets are computed. `fetchMoBillXml` can fire at most once here, and only when `target.localFile` is unset (the `--bill-xml-file` path never reaches it at all).

These three branches are mutually exclusive within one invocation purely by straight-line control
flow (single-threaded, no concurrency within one call) — not a timing question. I traced every
line between `ingest-mo-house.js:1009` and `:1121` by hand to confirm this.

**Gap found — explicit answer to "does the combined-counter test count ALL live fetchers or just
the two obvious ones":** Just the two obvious ones. The invariant test
(`tests/mo-house-xml.test.js:1226`, *"the one-live-request-per-run invariant"*) only wires
`fetchBillList`/`fetchBillXml` into its `liveFetchCount` counter — `pdf.fetchMoRollCallPdf` is not
injectable via `runMoHouse`'s `deps` object at all (it's called through the directly-imported `pdf`
module, not a parameter), so no test can spy on it without a `mock.method`-style intercept, and
none of the 9 new tests attempt one. More importantly: **none of the 9 new tests ever populate
`store.votes` with a pending-PDF row** (`makeFakeMoHouseRunClient`'s `votes` table starts `[]` and
nothing pushes to it in any new test), so the PDF-priority branch (`ingest-mo-house.js:1009-1027`)
is entirely unexercised by this test batch — not merely uncounted, *untested* at the `runMoHouse`
orchestration level. This isn't a new hole this commit dug (main() was never exported/tested
end-to-end before this refactor either, confirmed: pre-commit export list has no `main`), but this
commit was the first opportunity to close it with the new `runMoHouse` tests and didn't take it.
The invariant still holds for the PDF path — proven above by control-flow reading, not by this
test — but a future regression that removed/guarded the PDF branch's `return` (e.g., someone
"helpfully" makes it fall through when there's nothing else to do) would ship silently as far as
this test file is concerned.

**Severity: Important** (coverage gap on the exact property this commit exists to guarantee, on
code that's unattended forever — but not a live defect; the current code is verified safe).

---

## 3. THE SCHEDULER CONTRACT

- `--limit 1` parses: `parsePositiveIntegerFlag('1', '--limit')` → `1` (valid). `runMoHouse`'s
  `args.limit > 1` check (`ingest-mo-house.js:975`) is `1 > 1` → `false` → never throws. Confirmed
  by direct trace and by the dedicated test `tests/mo-house-xml.test.js:1055` ("the scheduler's own
  frozen invocation is unaffected").
- Timing: `CHILD_TIMEOUT_MS = 8 * 60 * 1000` (`scheduled-ingest.js:97`, = 480000ms, matches the
  task's "480s"), unchanged by this diff. Every slot now makes **at most** one live fetch plus
  bounded DB/filesystem work — strictly less than the old worst case (which could burn an entire
  ~30-minute limiter sleep in-process). `persistBillStubs`'s `insertIfAbsent`-over-the-whole-list
  cost is unchanged by this diff (it was already called unconditionally every run pre-fix,
  confirmed via the diff), so there's no new DB-latency risk introduced. No slot should come close
  to 480s under normal conditions.
- `moHouseWroteSomething` (`scheduled-ingest.js:443-453`, **not touched by this diff** — confirmed
  not to modify it) field-by-field against the new shape:
  - `detail.counts.document_type`: still exactly `'rollcall-pdf'` or `'bill-xml'` in every branch
    that closes a run `succeeded`/`partial`. Unchanged name, unchanged values.
  - `rollcall-pdf` branch reads `detail.rollCallResult.castCount` — this whole branch of
    `runMoHouse` is functionally unchanged from the old `main()` (only the trailing `return` gained
    a payload; the `counts`/`rollCallResult` shape passed to `closeRun` is identical).
  - `bill-xml` branch reads `detail.counts.bills_detailed` — present and correctly populated in
    *both* new slots: hardcoded `0` in SLOT (a)/list-refresh (`ingest-mo-house.js:1057`) and
    `billResults.length` in SLOT (b)/bill-detail (`ingest-mo-house.js:1127`, naturally capped at 1
    now instead of relying on `--limit`). No field renamed, no field dropped.
  - A list-refresh-only run reporting `wroteSomething === false` is **correct, not a regression**:
    that slot only ever writes null-field `bills` stub rows (`title`/`status`/`canonical_url` all
    null) plus an idempotent roster/session upsert — there is genuinely nothing for
    `refresh-aggregates.js`'s materialized views (votes/bill-detail driven, migration 0018) to
    usefully recompute. This is structurally different from the LegiScan NEW-1 regression, which
    read a field that *never* existed on that CLI's real detail shape (0/52 real rows ever matched)
    — here every field the predicate reads is present and semantically live in both new branches.
- **Coverage gap (same flavor as §2):** `tests/scheduled-ingest.test.js` (correctly not part of
  this diff's stat — out of scope to edit) still only pins `moHouseWroteSomething` against
  `REAL_MO_HOUSE_BILL_XML` (`tests/scheduled-ingest.test.js:524-533`) — a real captured row that
  predates this commit (`bills_listed`/`document_type`/`bills_detailed`/`list_fetch_mode`, **no**
  `slot` or `total_pending_bills` field). No test anywhere on `main` currently asserts
  `moHouseWroteSomething` against a literal `{slot: 'list-refresh', bills_detailed: 0}`-shaped
  detail. In *substance* this is already covered — the existing "`zeroBills`" case at
  `tests/scheduled-ingest.test.js:543-544` already asserts `bills_detailed: 0 → false`, which is
  the exact boolean the predicate computes regardless of why `bills_detailed` is 0 (old-shape empty
  target vs. new-shape list-refresh slot look identical to this predicate, since it never reads
  `slot` at all) — so I assess this as low functional risk. But given the task named this exact
  regression class as "the single most likely defect in this change," and no test literally
  exercises the new real shape, I'm flagging it rather than waving it through on inference alone.

**Severity: Important** (verification gap on the exact mechanism the task flagged as highest-risk;
independently confirmed safe by field-by-field reading, not by a test that encodes the new shape).

---

## 4. ToU: limiter + durable cooldown byte-unchanged (explicit answer: YES)

Mechanically verified, not eyeballed:
- `git diff b7e423c f692b34 -- src/lib/rate-limiter.js` → **empty**. `createLimiter` is untouched.
- `MO_HOUSE_MIN_INTERVAL_MS = 30 * 60 * 1000` and
  `moHouseLimiter = createLimiter({ minIntervalMs: MO_HOUSE_MIN_INTERVAL_MS })` are textually
  identical in both commits (only their surrounding comment moved/grew).
- Extracted and byte-compared the function bodies of `remainingCooldownMs`, `formatCooldownWait`,
  `queryLastMoHouseRunStartedAt`, and `enforceDurableCooldown` between `b7e423c` and `f692b34`:
  **all four are identical, character-for-character** (verified programmatically, not by reading
  comments).

No new code path can make the request rate faster than before. If anything the realized rate can
only be equal-or-slower: the old shape's worst case was up to 2 live requests attempted per
invocation (one of which silently slept ~30 min in-process); the new ceiling is 1.

---

## 5. 24h list staleness — can slot (a) and slot (b) both fire in one invocation, under any interleaving?

**No — structurally impossible**, not just "untested." Traced `ingest-mo-house.js:1040-1121` line
by line: SLOT (a) (`shouldRefetchBillList(...) === true`) always ends in an unconditional `return`
(`ingest-mo-house.js:1070`) reached *before* the code that would fall into SLOT (b) or the per-bill
loop is ever executed. This is single-threaded straight-line `async` code within one function
invocation — there is no concurrency to interleave; the only question is control flow, and the
control flow has exactly one branch point (`if (shouldRefetchBillList(...)) { ...; return; } else {
...falls through to the shared target loop... }`), never both. The "stop-after-list-refresh" is
unconditional as claimed.

---

## 6. Cache correctness — corrupt cached BillList (explicit answer)

`readCachedBillList` (`ingest-mo-house.js:355-363`) — **unchanged by this diff**, not present in
any diff hunk:

```js
export function readCachedBillList(session, dir = MO_BILL_LIST_ARTIFACT_DIR) {
  const p = billListCachePath(session, dir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null; // a corrupt/partial cache file must never crash the driver — treated as "no cache"
  }
}
```

**What actually happens:** a corrupt/unparseable cache file returns `null` — **silently**, not
loud (no exception, no distinguishing signal from "file doesn't exist"). This does *not* match the
"fail LOUD" framing in the task brief literally. However, tracing what `runMoHouse` does with that
`null`: `readCachedBillList` is called exactly *once*, at the very top of the slot-decision
(`ingest-mo-house.js:1042`), *before* either slot is chosen — not as a fallback partway through
SLOT (b). `cachedList?.fetched_at` on a `null` cachedList is `undefined` →
`shouldRefetchBillList(undefined)` → `true` (missing/corrupt both read as "needs refetch") → SLOT
(a) fires → exactly one live fetch, then an unconditional return. **A corrupt cache is therefore
indistinguishable from a missing cache from `runMoHouse`'s perspective, and both drive the exact
same single-fetch-then-stop branch.** The specific risk the task named — corrupt cache causing a
live fetch *on top of* an already-spent request this run (request #2) — does not occur, because
the cache is read once, up front, before any request has been spent. It fails safe, just not loud.

Test coverage: a pre-existing (not new to this diff) unit test,
`tests/mo-house-xml.test.js:877` ("`readCachedBillList`: null (never throws) on a corrupt cache
file"), pins the low-level behavior. No `runMoHouse`-level test is explicitly labeled
"corrupt cache," but the existing SLOT (a) "missing cache" test
(`tests/mo-house-xml.test.js:1072`) exercises the *identical* downstream code path (both produce
`cachedList === null`), so this is effectively already covered end-to-end even without a
dedicated corrupt-bytes fixture.

**Severity: Minor.** Safe with respect to the one-request invariant (verified); doesn't match the
"fail loud" ideal (silently masks a possible disk/write problem by self-healing into a refetch) —
worth a product decision on whether that's acceptable, not a shipping blocker. Pre-existing
behavior, not introduced by this commit.

---

## 7. Tests: red-first plausibility, fixture-only, and what they'd catch

**Red-first, verified mechanically (not assumed):** created a detached git worktree at the parent
commit `b7e423c`, copied over *only* the new `tests/mo-house-xml.test.js`, junctioned
`node_modules` in, and ran it against the pre-fix source unmodified. Result:

```
SyntaxError: The requested module '../src/cli/ingest-mo-house.js' does not provide an export
named 'LiveRequestLimitError'
```

The new tests cannot even load against the pre-fix code (`runMoHouse`, `LiveRequestLimitError`,
`countPendingBills` don't exist there) — proof the tests exercise genuinely new surface area, not
tautological/pre-existing-passing assertions. Worktree removed after the check; main working tree
was never touched (confirmed clean, back on `main` @ `f692b34`).

**Fixture-only / no live network or DB, confirmed by direct reading:** every new test injects
`fetchBillList`/`fetchBillXml` spy functions and a fully in-memory fake Supabase client
(`makeFakeMoHouseRunClient`, `tests/mo-house-xml.test.js:743-786`); zero real `fetch()` calls, zero
real Supabase calls anywhere in the new test code.

**Would they catch:**
- **A second live fetch sneaking in (list+bill combo): YES**, directly — three separate
  assertions (`xmlCalls === 0` in both SLOT (a) tests, `listCalls === 0` in the SLOT (b) test, plus
  the dedicated combined-counter invariant test). **A second live fetch via the PDF path
  specifically: NO** — see §2's gap; no test ever populates a pending PDF, so a regression that
  broke the PDF branch's early return wouldn't be caught here (though it's still structurally
  proven safe today).
- **The `wroteSomething` field rename: N/A to this test file** — that predicate lives in
  `scripts/scheduled-ingest.js`, tested by `tests/scheduled-ingest.test.js`, which this diff
  correctly doesn't touch. See §3 — verified by direct field-by-field reading that no rename
  occurred, but no *new* test re-pins the predicate against the literal new shape either.
- **The corrupt-cache-fallback-to-live mistake: not directly labeled, but effectively covered** —
  see §6; the missing-cache test at the `runMoHouse` level exercises the same code path a
  corrupt-cache scenario would.

---

## 8. TODO.md item 34 + code comments — accuracy

Checked every discrete, mechanically-checkable factual claim in item 34
(`TODO.md:280-303`) against the code:

| Claim | Verified |
|---|---|
| `moHouseLimiter` correctly strict, 30 min/request | True (§4) |
| Old shape could need two live requests (list + bill) sharing one limiter | True — confirmed by reading the parent commit's `main()` directly during the worktree check |
| Second request "slept out" silently (zero connections/CPU/log output) | True — `createLimiter.take()` (`rate-limiter.js`) has no logging, sleeps via bare `setTimeout` |
| Earlier 60-min cache fix only reduced frequency, didn't stop the combination | True — parent commit's `main()` still fell through to the per-bill fetch after a live list refetch |
| `runMoHouse` now makes at most one live request/invocation, mirrors `runMoSenate`'s slot shape | True — `ingest-mo-senate.js:1052` literally says "At most ONE live network fetch per invocation (roster > journal-index > journal-day PDF, priority order)" |
| Limiter untouched, now a tripwire | True (§4); tripwire arithmetic checks out (30-min sleep vs. 480s scheduler kill) |
| `MO_BILL_LIST_MAX_AGE_MS` raised 60min → 24h | True — `24 * 60 * 60 * 1000` (§ code read) |
| `--limit` > 1 → typed `LiveRequestLimitError`; scheduler's frozen `--limit 1` unaffected | True (§3) |
| 9 new tests, 2101/2101 green | True — `git diff` shows 10 `test(` added, 1 removed = net 9; `node --test` confirms 2101/2101 (§1) |

Two claims are historical/narrative about live production `ingestion_runs` data I have no way to
check this session (Supabase MCP is unauthenticated per this session's tooling): "mo-house-xml was
3-for-3 ETIMEDOUT" and "the round-2 reviewer's every-run-multiple-of-1800s observation was this
defect." Both are internally consistent with the mechanism described (a full limiter sleep is
exactly 1800s; the scheduler's 480s timeout would kill any run attempting it) and nothing I found
contradicts them, but I can't independently confirm them — flagging as unverified-by-me rather than
false. Not an overclaim in the item's own text, which already hedges this as "controller-verified"
(an external verification I also can't check).

Code comments checked (module header on `runMoHouse`, the `TRIPWIRE ROLE` block on
`mo-house-xml.js:12-24`, `MO_BILL_LIST_MAX_AGE_MS`'s history block) — all cross-checked against
actual behavior during this review; no overclaims found.

**Incidental, out-of-scope note:** `TODO.md:254` (item 31, pre-existing, unrelated to this diff)
cites `ingest-mo-house.js:794` for the `mo_house_id` `insertIfAbsent` call; this commit's insertions
shifted that to line ~823. Not part of item 34, not introduced responsibility for this commit —
noting only as a drive-by observation, not a finding against f692b34.

---

## Findings summary

**Critical:** none.

**Important:**
1. `tests/mo-house-xml.test.js:1226` (the combined-counter "invariant" test) and the other 8 new
   `runMoHouse` tests never exercise the PDF-priority branch — no test populates a pending roll-call
   PDF, so the PDF fetcher is neither counted by the invariant counter nor tested at all at the
   orchestration level. The invariant holds today by direct code-reading (§2), but this specific
   commit's own headline claim ("at most one live request, across ALL paths") isn't fully backed by
   its own test suite. *Recommend:* add one `runMoHouse` test with a pending PDF **and** a
   simultaneously stale list, asserting the PDF fetch fires, the list/bill fetchers never do, and
   the run returns before the slot-decision code is even reached.
2. `tests/scheduled-ingest.test.js` was correctly left untouched by this diff, but as a result no
   test on `main` pins `moHouseWroteSomething` against the new `{slot: 'list-refresh',
   bills_detailed: 0}` shape — only against a pre-existing real fixture that predates `slot`
   entirely. Verified safe by field-by-field reading (§3), not by a test that encodes the literal
   new shape. *Recommend:* a small follow-up test in `tests/scheduled-ingest.test.js` asserting
   `moHouseWroteSomething` against a `slot: 'list-refresh'` detail (expect `false`) and a `slot:
   'bill-detail', bills_detailed: 1` detail (expect `true`), independent of this push.

**Minor:**
1. `ingest-mo-house.js:355-363` (`readCachedBillList`, pre-existing/unchanged) treats a corrupt
   cache file identically to a missing one — silent, not "fail loud." Does not break the
   one-request invariant (§6) and is self-healing (next successful fetch overwrites the corrupt
   file), but masks a potential underlying problem (bad write, disk issue) without any distinct
   signal. Worth a product decision, not a blocker.
2. An explicit `--bill X` invocation that lands on a stale-list run silently defers `X` to a later
   invocation rather than fetching it this run (spends the request on the list refresh instead).
   Correctly documented in-code (`ingest-mo-house.js:944-948`); operator/manual-use-only concern
   (the scheduler never passes `--bill`), not a scheduler-contract risk.
3. `TODO.md:254` (item 31)'s line reference (`ingest-mo-house.js:794`) is now stale
   (current ~823) due to this commit's unrelated insertions above it. Pre-existing item, drive-by
   note only.

## Files touched by this commit (for reference)

- `F:\VisibleGov\TODO.md` (item 34 added/checked off)
- `F:\VisibleGov\src\adapters\mo-house-xml.js` (comment-only: TRIPWIRE ROLE block; constants
  byte-unchanged)
- `F:\VisibleGov\src\cli\ingest-mo-house.js` (the actual restructure: `runMoHouse` extracted from
  `main()`, slot-priority architecture, `LiveRequestLimitError`, `countPendingBills`,
  `MO_BILL_LIST_MAX_AGE_MS` 60min→24h, `--limit` typed validation)
- `F:\VisibleGov\tests\mo-house-xml.test.js` (9 net new tests + 1 modified constant test)

Not touched by this commit (verified, correctly out of scope): `scripts/scheduled-ingest.js`,
`tests/scheduled-ingest.test.js`, `src/lib/rate-limiter.js`, `src/adapters/mo-rollcall-pdf.js`.
