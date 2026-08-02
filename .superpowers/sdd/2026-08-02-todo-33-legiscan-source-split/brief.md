# Task brief — TODO 33: split the shared `source='legiscan'` key, WITHOUT breaking budget enforcement

Approved by Lance (2026-08-02: "Let's move to TODO-33 and feel free to spend real Fable5 usage on
this one to ensure accuracy") — this fix touches a suspension-level external term, so it gets full
rigor: real investigation already done (below), a careful implementer, and an adversarial review
before anything is handed to Lance to apply.

## The defect, and why TODO-33's own original text was itself incomplete

Two CLIs write `ingestion_runs.source = 'legiscan'`: `ingest-legiscan.js` (votes/bills, the
scheduler's real registered source) and `ingest-legiscan-texts.js` (doc-blob text fetches, NEVER
scheduler-invoked, manual-only). The original TODO-33 entry proposed "split the source key" as the
fix. **That proposal, done naively, would be actively dangerous — worse than the bug it fixes.**

`ingest-legiscan-texts.js`'s own file header (`:59-65`) explains why the shared key exists at all:
**both CLIs spend queries against the SAME real LegiScan account and the SAME real 30,000/month
cap.** `getMonthlyQueryUsage` (`src/adapters/legiscan.js:229`) sums `detail.queries_used` filtered
by `.eq('source', source)` — a single exact match. If the two CLIs get distinct source strings
WITHOUT also fixing how the budget check sums usage, each CLI's own budget check would only see its
OWN half of the real spend, silently letting the combined total exceed the real account cap — the
exact terms violation the shared key was deliberately built to prevent (binding Rule 1,
`docs/research/2026-07-28-legiscan-terms.md`, suspension-level). **This fix is only safe if the
budget check is updated to sum across BOTH source labels while everything else (freshness display,
scheduler due-ness) is updated to distinguish them.**

## What's actually broken today (confirmed, fail-safe, but real)

- `public_freshness` shows ONE row for `legiscan` reflecting whichever CLI ran most recently —
  a manual texts run can make the votes/bills pipeline look more or less recently active than it
  really was.
- The scheduler's own due-ness read (`scripts/scheduled-ingest.js:620`,
  `queryLatestStartedAt(client, 'legiscan')`) reads the latest `started_at` for `source='legiscan'`
  regardless of which CLI wrote it — confirmed in the scheduler's own code comment (`:463-469`): a
  manual texts run between scheduler ticks DELAYS (never skips or advances) the next real votes/
  bills tick, because it makes the shared source look more recently touched than the actual
  automated pipeline. **This is currently accepted as fail-safe (delay only, never skip) — but it's
  a real, unnecessary imprecision this fix removes entirely, not just tolerates.**

## No schema migration is actually needed — verified

`ingestion_runs.source` is `text not null` (migration `0001_core_schema.sql:114`) with NO check
constraint anywhere enumerating allowed values (grepped all 21 migrations). This is a data
correction plus a code change, following the EXACT same `correct-data.js` pattern as every other
production-data fix in this repo — not a schema migration. (TODO-33's own text said "schema + CLI +
historical-row migration" — that overstated the schema piece, the same way TODO-35 turned out to
overstate its own claim. Always re-verify a TODO entry's framing against live reality before
building to it literally.)

## The historical-row classification rule — verified against ALL 54 real live rows, not sampled

Live-queried every `source='legiscan'` row (54 total) and classified each:

- **48 rows: `detail.votes` is a number, no `detail.counts` object.** This is `ingest-legiscan.js`'s
  own shape (`buildSuccessCloseDetail`, `ingest-legiscan.js:961-963` — spreads `result.counts` at
  the TOP level, `votes` included, never nested). Classify → **`legiscan`** (unchanged).
- **2 rows: no top-level `detail.votes`, `detail.counts` IS an object.** `ingest-legiscan-texts.js`'s
  own shape (billsPlanned/docCacheHits/alreadyHasVersion/... nested under `.counts`, no `votes`
  field anywhere in that CLI — confirmed by reading the whole file). Classify → **`legiscan-texts`**
  (the new label).
- **4 rows: neither shape — a bare `{error, queries_used}` failure detail.** Both CLIs' failure
  paths converge to this simpler shape, so detail-shape alone can't distinguish them. **All 4
  sampled directly and their `detail.error` text is unambiguous**: every one references
  votes-pipeline-specific code — `"insertIfAbsent(votes) failed"` (the literal table-name argument
  `src/lib/db.js`'s generic error message includes when called with `table='votes'` — a string
  `ingest-legiscan-texts.js` structurally cannot produce, since that file never calls
  `insertIfAbsent` with `'votes'` anywhere), and `"legiscan-votes: could not write..."` (the literal
  prefix `src/adapters/legiscan-votes.js`'s own throw statements use — a module
  `ingest-legiscan-texts.js` never imports at all). These are real, deterministic, sourced signals —
  not guesses — because they're exact strings this project's own code produces, traceable to a
  specific file. Classify all 4 → **`legiscan`** (unchanged; they are genuine `ingest-legiscan.js`
  failures, including the exact `roll_call_id` type-mismatch bug fixed earlier today).

**Re-verify this classification against the LIVE database at implementation time — the count will
have grown since this brief (54 as of this writing); the RULE is what matters, not the frozen
count.** If any row doesn't cleanly match any of the three patterns above (shape check, or a
recognizable error-string marker), **do not guess — leave it as `legiscan` (the current, safe
default) and report it explicitly as unclassified in your response.** Misclassifying a real
`ingest-legiscan.js` query as `legiscan-texts` would UNDERCOUNT that CLI's own budget usage on its
next self-check (dangerous, could let real usage exceed the cap unnoticed); leaving an ambiguous row
as `legiscan` is always safe — it just stays combined, exactly like today, introducing no new risk.

## The fix, five parts

1. **New source constant.** In `ingest-legiscan-texts.js`, add a distinct constant for what THIS
   CLI writes to `ingestion_runs.source` going forward — e.g. `RUN_SOURCE = 'legiscan-texts'`. Keep
   the existing `SOURCE` import from `ingest-legiscan.js` (still `'legiscan'`) for budget-check
   purposes only (see part 2) — do not conflate the two uses. Update the `openRun`/`closeRun` call
   site (`:781` and its `closeRun` call) to use `RUN_SOURCE`, not `SOURCE`. Update the stale comment
   at `:781` ("SAME source as ingest-legiscan.js") — it will no longer be true.

2. **Budget check must sum across BOTH labels — this is the load-bearing part.** Modify
   `getMonthlyQueryUsage` (`src/adapters/legiscan.js:229`) to accept EITHER a single source string
   (existing callers, unchanged behavior) OR an array of sources to sum together — e.g. change the
   filter from `.eq('source', source)` to something that handles both
   (`.in('source', Array.isArray(source) ? source : [source])`). Update `assertRunUnderBudget`
   (`ingest-legiscan.js:944`) the same way if it also needs to pass an array through. **Both
   `ingest-legiscan.js`'s own budget check AND `ingest-legiscan-texts.js`'s own budget check must
   now pass `source: ['legiscan', 'legiscan-texts']` (the FULL combined set)** — every query either
   CLI plans to spend competes against the SAME real account limit, and each CLI's own pre-flight
   check must see the TRUE combined total, not just its own half. Test this specifically: a
   scenario where CLI A has spent most of the cap and CLI B's OWN check must still correctly refuse
   because of CLI A's spend (and vice versa) — this is the single most important behavior in this
   whole fix; get it wrong and this fix creates a real risk of exceeding LegiScan's terms.

3. **Historical-row backfill**, following the classification rule above exactly, as a new
   correction in `correct-data.js` (matching this repo's own established convention — read
   `runCorrectMoStatus`/`runCorrectPartyNormalize` for the exact shape/conventions to mirror: a
   dry-run-safe function, an honest counts object, `--dry-run` reproduces live target numbers,
   commit only at 0 test failures). This CLI is `built ready, dry-run verified — Lance runs the live
   pass himself`, per this file's own established header convention — do not run it live yourself.
   `--limit`/session scoping are not needed here (54 rows total, small, no pagination-cap risk) but
   still use `selectAll` for the read per this repo's own standing rule.

4. **`legiscanWroteSomething`'s stale comment** (`scripts/scheduled-ingest.js:462-469`) documents the
   OLD shared-key confusion as an accepted, fail-open-safe residual. Once the split lands, the
   scenario it describes (a manual texts run polluting the scheduler's due-ness read for `legiscan`)
   can no longer happen going forward — update the comment to say so; the function's own fail-open
   behavior for a genuinely unrecognized detail shape should stay (defensive, in case a SIXTH source
   is ever added without its own predicate — that's a different, still-valid concern), just correct
   what it says about THIS specific scenario. **Do not touch `SOURCE_KEYS`
   (`scripts/scheduled-ingest.js:181`) or anything else about the scheduler's registry** — the
   scheduler never invokes `ingest-legiscan-texts.js` and that stays true; this whole fix changes
   what value `ingest-legiscan-texts.js` itself writes, nothing about how the scheduler decides what
   to run.

5. **`public_freshness` needs no code change** — confirmed: it's a plain `distinct on (source)`
   aggregation with no hardcoded source enumeration (migration `0019_view_scoping_and_freshness.sql`).
   Once `ingest-legiscan-texts.js` starts writing `legiscan-texts` and the historical rows are
   relabeled, the view will show two correctly-distinct rows automatically. Verify this is true by
   reading the view definition yourself rather than trusting this brief's claim alone.

## Constraints

- TDD red-first throughout. For `getMonthlyQueryUsage`'s array-summing change: test a single-string
  call still works identically (regression); test an array of two sources sums correctly across
  rows with different source values; test the cross-CLI budget-refusal scenario from part 2
  explicitly. For the historical backfill: test all three classification cases (votes-shape,
  texts-shape, error-marker fallback) plus the "genuinely unclassifiable → stays `legiscan`, never
  guessed" case. No live DB writes from tests.
- Bare `node --test` from repo root; baseline currently 2170 (re-check the actual current count
  before claiming a delta — it has moved multiple times today). Extract the literal `ℹ fail` line
  yourself; commit ONLY at 0.
- This touches LegiScan's own suspension-level query-budget enforcement — re-read
  `docs/research/2026-07-28-legiscan-terms.md`'s Rule 1 before writing the budget-summing code, and
  state explicitly in your report that you did.
- Commit message explains the defect (including WHY the naive "just split the key" approach in the
  original TODO text would have been dangerous) and the fix, ends with:

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

Return: status, commit hash, fail-count line verbatim, the live classification result for all
current `source='legiscan'` rows (counts per bucket, and explicit disclosure of any row you could
not classify and left as `legiscan`), the `--dry-run` output of the new correction against the real
live DB, and concerns — especially anything about the budget-summing logic you are not 100% certain
is airtight, given the suspension-level stakes.

---

## Ledger — SHIP

Independent adversarial review verified the budget-summing math by hand-tracing the actual
production call sites (not just pure helpers) and hand-computing both refusal scenarios with real
numbers: 29,900 spent under either label + a 200-query plan from the OTHER CLI → combined 30,100
≥ 30,000 cap → correctly refuses, both directions. No doubt remaining on this.

Historical classification independently re-derived from a from-scratch script against the live
DB, not copied from the correction's own logic: 52 unchanged / 2 relabeled / 0 unclassified,
same two row ids as the correction's own dry-run. The two error-string fallback markers were
structurally verified, not just tested: grepped every real call site and confirmed
ingest-legiscan-texts.js contains zero `insertIfAbsent` calls and never imports legiscan-votes.js
— it is structurally incapable of producing either marker string.

Write guard confirmed safe (id + source WHERE clause, row-count mismatch guard against a
concurrent relabel), nothing in the diff runs it live. 2 Minor, non-blocking findings noted (a
pre-existing stale doc comment; a documented-by-design backward-compat default). Suite and
--dry-run both independently reproduced exactly.
