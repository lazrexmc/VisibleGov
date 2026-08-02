# Task review — commit 146f410 (TODO-33: legiscan source split, without breaking budget enforcement)

Reviewer: adversarial review, full-accuracy pass per Lance's explicit request (suspension-level
external term at stake: LegiScan's real 30,000-query/month account cap). Every claim below was
independently re-derived from the actual code and the live database — nothing here is trusted from
the implementer's own report without a separate verification step.

## Spec verdict: MEETS SPEC

All five parts of the brief (`brief.md`) are implemented exactly as specified: (1) distinct
`RUN_SOURCE='legiscan-texts'` for `ingest-legiscan-texts.js`, (2) `getMonthlyQueryUsage` sums an
array of sources and BOTH CLIs' own pre-flight checks pass the combined `ALL_LEGISCAN_SOURCES`,
(3) the historical-row backfill correction with the exact three-case classification rule, dry-run
verified, not run live, (4) the scheduler comment corrected with `SOURCE_KEYS` genuinely untouched,
(5) `public_freshness` needed and received no code change, confirmed by reading the view directly.

## Quality verdict: HIGH

Tests are load-bearing, not vacuous (see point 4 below). Code changes are minimal, scoped, and each
new/changed function is accompanied by traceable, sourced reasoning in comments. One pre-existing
(not newly introduced) minor doc-staleness item noted below.

## The two adversarial budget scenarios — independently traced through the literal code, not the implementer's own test

**Scenario 1**: CLI A (`ingest-legiscan.js`, `source='legiscan'`) has spent 29,900 of a 30,000 cap
this month. CLI B (`ingest-legiscan-texts.js`, `source='legiscan-texts'`) plans to spend 200 more.
Does CLI B's OWN check refuse?

Trace: `runIngestLegiscanTexts` (`src/cli/ingest-legiscan-texts.js:582`) calls
`assertBudgetFn(client, { plannedQueries: plannedFreshQueries, capPerMonth, source: ALL_LEGISCAN_SOURCES })`.
`assertBudgetFn` defaults to `assertRunUnderBudget` (`src/cli/ingest-legiscan.js:944`), which calls
`getMonthlyQueryUsage(client, { source: ['legiscan', 'legiscan-texts'] })`
(`src/adapters/legiscan.js:256-271`). Because the array has length 2, the filter branch is
`q.in('source', sources)` (line 264), not `.eq()` — it reads BOTH labels' rows and sums
`detail.queries_used` across all of them: `29,900 (legiscan) + 0 (legiscan-texts, none spent yet) =
29,900`. `assertUnderBudget(29900, 200, 30000)` (`legiscan.js:283`) computes `projected =
29900+200=30100`, and `30100 >= 30000` → throws `QueryBudgetExceededError`.
**YES — CLI B's own check correctly refuses.**

**Scenario 2 (reverse)**: CLI B has spent 29,900 (all under `legiscan-texts`). CLI A plans 200. Does
CLI A's OWN check refuse?

Trace: `main()` in `ingest-legiscan.js:1106` calls `runLegiscanBudgetGate(client, args)`
(`ingest-legiscan.js:964-966`), which calls `assertRunUnderBudget(client, { plannedQueries, source:
ALL_LEGISCAN_SOURCES })` — same combined array. `getMonthlyQueryUsage` sums `0 (legiscan) + 29,900
(legiscan-texts) = 29,900`; `projected = 29900+200=30100 >= 30000` → throws.
**YES — CLI A's own check correctly refuses.**

Both directions are genuinely load-bearing in the real production call sites (`main()` in each CLI),
not just in the pure `getMonthlyQueryUsage`/`assertRunUnderBudget` mechanism — I read both `main()`
bodies directly (`ingest-legiscan.js:1067-1129`, `ingest-legiscan-texts.js:780-825`) and confirmed
neither ever falls back to a single-source default at its real gating call site. I have **no doubt**
this is airtight as implemented — the array-summing path is exercised by the actual production
composition, not just a helper that could theoretically be miswired.

One design note, not a defect: `assertRunUnderBudget`'s own signature still defaults
`source = SOURCE` (single-string) when a caller omits `source` entirely (`ingest-legiscan.js:944`),
and `getMonthlyQueryUsage` likewise defaults to `SOURCE` (`legiscan.js:256`). This is deliberate,
brief-specified backward compatibility for other/future single-source callers — but it does mean the
API itself does not *prevent* a future call site from being added without remembering to pass
`ALL_LEGISCAN_SOURCES`. I grepped every real call site of both functions in `src/` and `scripts/`
(excluding tests) and confirmed the only two real gating call sites (`runLegiscanBudgetGate` and the
`assertBudgetFn` call inside `runIngestLegiscanTexts`) both pass the array explicitly today. This is
a forward-maintainability note, not a bug in this commit.

## Historical classification — independently re-derived from the live DB, not trusted from the report

I wrote a fresh classification script from scratch (not copy-pasted from `classifyLegiscanSourceRow`)
against the actual live `source='legiscan'` rows, using `getClient()`/`selectAll()` the same way the
project's own CLIs do (`node --env-file=.env`). Result:

```
Total source='legiscan' rows: 54
MY INDEPENDENT CLASSIFICATION: { "legiscan": 52, "legiscan-texts": 2, "unclassified": 0, "ambiguous": 0 }
```

The 2 relabel candidates (ids `7e2e67f5-1d0f-4291-aabd-682d15f75a22`,
`d0f74115-c801-4c03-a9d3-6a63b510c3c6`) both carry `detail.counts` as an object with
`billsPlanned`/`docCacheHits`/etc. and no top-level `detail.votes` — genuine
`ingest-legiscan-texts.js` shape. The 4 error-marker rows I dumped directly:

- 2x `"Error: insertIfAbsent(votes) failed: date/time field value out of range..."`
- 1x `"Error: insertIfAbsent(votes) failed: TypeError: fetch failed"`
- 1x `"Error: legiscan-votes: could not write vote_reconciliation_flags row: duplicate key..."`

I then ran the commit's own correction live: `node --env-file=.env src/cli/correct-data.js
legiscan-source-split --dry-run` against the same live DB. Its output:
`{ "seen": 54, "relabeledToTexts": 2, "unchangedLegiscan": 52, "unclassified": 0 }`, with the
**identical two row ids** as my independent script. Three independent sources now agree exactly: my
from-scratch script, the correction's own `--dry-run`, and the commit's own claimed numbers in
`TODO.md`/the commit message (54 rows, 2 relabel, 52 unchanged, 0 unclassified).

**Error-marker specificity, verified structurally, not assumed**: `"insertIfAbsent(votes) failed"`
is produced only by `insertIfAbsent(client, table, ...)` in `src/lib/db.js:41`
(`` `insertIfAbsent(${table}) failed: ...` ``) when called with `table='votes'`. Grepped every call
site of `insertIfAbsent(client, 'votes', ...)` in the repo: `ingest-legiscan.js:609`,
`ingest-mo-senate.js:807`, `ingest.js` (x3), `ingest-mo-house.js:432`. Confirmed
`ingest-legiscan-texts.js` contains **zero** occurrences of `insertIfAbsent` anywhere (grep, no
matches) — it structurally cannot produce this string. The other CLIs that DO call
`insertIfAbsent(client,'votes',...)` (mo-senate, mo-house, etc.) write different `source` values, so
they're outside this correction's `source='legiscan'` scope entirely — irrelevant to this
classification's safety. `"legiscan-votes:"` is the throw-prefix used exclusively inside
`src/adapters/legiscan-votes.js` (7 throw sites, grepped). Confirmed `ingest-legiscan-texts.js` never
imports `legiscan-votes.js` (grep for both the module path and a named import, zero matches) —
structurally cannot produce this string either. Both markers are genuinely sourced and
scope-safe, not guesses.

One correctness detail worth calling out as a strength, not a gap: `classifyLegiscanSourceRow`'s
branch logic falls through to `return null` (unclassified, never guessed) in the theoretical case
where a row has BOTH a numeric `detail.votes` AND an object `detail.counts` at once — a case the
brief's prose doesn't explicitly enumerate but the code correctly defaults to the safe "don't guess"
outcome for. No live row hit this case (confirmed by my independent script's `ambiguous: 0`), but the
code is right about it regardless.

## Write guard — genuinely safe

`runCorrectLegiscanSourceSplit` (`src/cli/correct-data.js:1249-1288`) scopes its read to
`source='legiscan'` only via `selectAll` (no bare `.select()`, consistent with the repo's
standing pagination rule). Its live UPDATE:

```js
.from('ingestion_runs').update({ source: 'legiscan-texts' })
.eq('id', row.id).eq('source', 'legiscan').select('id');
```

is guarded by BOTH primary key AND the current `source='legiscan'` value in the WHERE clause, and
checks `updatedRows.length !== 1` before counting it as a real relabel — if a concurrent process
already changed the row's source between the read and this write, the guard clause matches 0 rows
and the code correctly reports `relabel_guard_mismatch` in `failures[]` rather than silently
succeeding. This is byte-for-byte the same guarded-update convention already used by
`runCorrectMo1969Dates` (`correct-data.js:536-543`) and `correctOnePartyCode`
(`correct-data.js:273-277`) elsewhere in this same file — not a novel, unreviewed pattern.
A per-row DB error is isolated into `failures[]` and does not abort the remaining rows (tested,
`tests/correct-data.test.js` "a genuinely unrelated DB error on ONE relabel is isolated").

Nothing in this diff invokes the correction live. Grepped the whole repo (excluding `tests/` and
`.superpowers/`) for `legiscan-source-split` — every hit is either the CLI's own arg-parsing/dispatch
code or a comment; no script, scheduler, or `package.json` entry calls it. The correction is only
reachable via an operator explicitly running `node correct-data.js legiscan-source-split [--dry-run]`
or `... all`, matching this repo's own draft-then-apply convention exactly, and the file's own header
comment ("built READY... Lance runs the live pass himself") is honored.

## Test quality — the 22 new tests are load-bearing, not vacuous

Traced through several of the new tests to confirm they would actually FAIL if the array-summing fix
were reverted to a single `.eq()`:

- `tests/legiscan-client.test.js` "source as an array of TWO labels sums BOTH together, excluding a
  third, unrelated source" — asserts `usage === 150` (100+50 across two sources, third source 999
  excluded). A reverted single-`.eq()` implementation passed an array to `.eq()` would either throw
  or match zero rows (arrays aren't scalar-equal to a string column) — this test would fail loudly,
  not silently pass.
- `tests/ingest-legiscan-cli.test.js` "CROSS-CLI BUDGET REFUSAL (direction 1/2)" — asserts specific
  `err.usage` values (4995, 4998) that are only reachable by summing both sources; each test also
  contains an explicit **negative control** proving the single-source-only call would have wrongly
  NOT thrown (`assert.doesNotThrow(... source: 'legiscan-texts' ...)`), directly documenting the
  danger being closed.
- `tests/ingest-legiscan-cli.test.js` "runLegiscanBudgetGate: wired to ALL_LEGISCAN_SOURCES" —
  exercises the REAL `main()`-adjacent call site (not just the underlying mechanism), asserting
  `err.usage === 4998` only reachable via the combined sum.
- `tests/ingest-legiscan-texts.test.js` "CROSS-CLI — the COMBINED usage... triggers refusal even
  though NEITHER source ALONE is anywhere near the cap" — exercises `runIngestLegiscanTexts`'s real,
  non-overridden `assertBudgetFn` default, proving the actual production wiring, not a test double.

These are genuine proof-of-fix tests, each with numbers chosen so a naive reversion breaks them.

## Everything else specified in the brief

- **RUN_SOURCE naming / call sites**: confirmed by direct read (not just diff) of both `main()`
  functions — `ingest-legiscan.js:1087` still `openRun(client, SOURCE)` (correct, unchanged, votes
  CLI keeps its own label); `ingest-legiscan-texts.js:800` now `openRun(client, RUN_SOURCE)`
  (correct, relabeled). Both print `source` in their JSON output using the right constant.
- **Scheduler comment + `SOURCE_KEYS`**: read `scripts/scheduled-ingest.js:181` directly —
  `SOURCE_KEYS = ['mo-senate-web', 'mo-house-xml', 'us-congress', 'us-senate', 'legiscan']`, no
  `'legiscan-texts'` entry, confirmed genuinely untouched, exactly as the brief required (the
  scheduler still never invokes `ingest-legiscan-texts.js`).
- **`public_freshness` needs no change**: read `supabase/migrations/0019_view_scoping_and_freshness.sql`
  directly. It's a `distinct on (source)` CTE join with no hardcoded source enumeration anywhere —
  confirmed the brief's claim is true, not just asserted.
- **`main()` in both CLIs not silently broken**: read both files' actual `main()` bodies in full
  (not inferred from the diff hunks alone) — both correctly call the new budget-gate path and the
  correct source constants at every relevant statement.

## `node --test` result (bare, from repo root)

```
ℹ tests 2192
ℹ suites 0
ℹ pass 2192
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Matches the commit's own claimed `2170 → 2192 (22 new), 0 fail` exactly.

## `--dry-run` against the live DB (run independently, this session)

```
node --env-file=.env src/cli/correct-data.js legiscan-source-split --dry-run
```
```json
{
  "legiscanSourceSplit": {
    "seen": 54, "relabeledToTexts": 2, "unchangedLegiscan": 52, "unclassified": 0,
    "relabeled": [
      { "id": "7e2e67f5-1d0f-4291-aabd-682d15f75a22", "from": "legiscan", "to": "legiscan-texts" },
      { "id": "d0f74115-c801-4c03-a9d3-6a63b510c3c6", "from": "legiscan", "to": "legiscan-texts" }
    ],
    "unclassifiedRows": [], "failures": []
  }
}
```
Matches the commit's own claimed live counts exactly, and matches my independently-written
classification script's output exactly (same ids, same buckets).

## Findings

**Critical**: none.

**Important**: none.

**Minor**:
1. `src/cli/correct-data.js:76-79` — the file-header CLI usage comment (`` `<which>` is REQUIRED
   (mo-status | mo-1969-dates | mo-2026-session-merge | mo-2026-vote-reconcile | all) `` ) was not
   updated to list `legiscan-source-split` (or `party-normalize`, which is also already missing from
   this comment, predating this commit). Pure documentation drift, not a functional issue — the
   actual `parseArgs` error messages (`correct-data.js:99,105`) ARE correctly updated and are what an
   operator actually sees on a bad invocation. Pre-existing pattern of staleness in this one comment
   block, not introduced fresh by 146f410, but this commit had the opportunity to fix it and didn't.
2. `assertRunUnderBudget`/`getMonthlyQueryUsage` still default to the single `SOURCE` value when a
   caller omits `source` (by design, for backward compatibility) — noted above as a forward-looking
   maintainability observation, not a defect in the current diff. Every real call site today passes
   the combined array correctly.

## SHIP / DO-NOT-SHIP

**SHIP.** The budget-summing math was traced through the literal, real production call sites in both
CLIs' `main()` functions (not just the pure helper functions) with hand-computed numbers, and both
adversarial directions from the review brief correctly refuse. The historical classification was
independently re-derived from the live database with a script written from scratch, not copied from
the implementer's code, and it matches both the correction's own `--dry-run` output and the commit's
claimed numbers exactly, down to the specific row ids. The error-marker fallback's specificity was
verified structurally against every real call site of the two marker-producing functions in the
repo, not assumed. The write guard is scoped, idempotent under a concurrent-modification race, and
genuinely not invoked live anywhere in this diff. Tests are demonstrably load-bearing against the
one specific behavior that matters most here. `node --test` independently reproduces `2192/0 fail`.
I have no unresolved doubt about the budget-summing correctness as implemented in this commit.
