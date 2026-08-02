# Review package — TODO-33 legiscan source split (17dd22c..146f410)

146f410 fix: TODO-33 legiscan source split, without breaking budget enforcement

## Stat
 .../brief.md                                       | 155 +++++++++++++++
 CHATLOG.md                                         |  39 ++++
 TODO.md                                            |  26 ++-
 scripts/scheduled-ingest.js                        |  27 ++-
 src/adapters/legiscan.js                           |  38 +++-
 src/cli/correct-data.js                            | 151 ++++++++++++++-
 src/cli/ingest-legiscan-texts.js                   |  45 +++--
 src/cli/ingest-legiscan.js                         |  39 +++-
 tests/correct-data.test.js                         | 208 +++++++++++++++++++++
 tests/ingest-legiscan-cli.test.js                  | 122 +++++++++++-
 tests/ingest-legiscan-texts.test.js                |  49 +++++
 tests/legiscan-client.test.js                      |  49 +++++
 12 files changed, 899 insertions(+), 49 deletions(-)

## Full diff (-U10)
diff --git a/.superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md b/.superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md
new file mode 100644
index 0000000..49485bb
--- /dev/null
+++ b/.superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md
@@ -0,0 +1,155 @@
+# Task brief — TODO 33: split the shared `source='legiscan'` key, WITHOUT breaking budget enforcement
+
+Approved by Lance (2026-08-02: "Let's move to TODO-33 and feel free to spend real Fable5 usage on
+this one to ensure accuracy") — this fix touches a suspension-level external term, so it gets full
+rigor: real investigation already done (below), a careful implementer, and an adversarial review
+before anything is handed to Lance to apply.
+
+## The defect, and why TODO-33's own original text was itself incomplete
+
+Two CLIs write `ingestion_runs.source = 'legiscan'`: `ingest-legiscan.js` (votes/bills, the
+scheduler's real registered source) and `ingest-legiscan-texts.js` (doc-blob text fetches, NEVER
+scheduler-invoked, manual-only). The original TODO-33 entry proposed "split the source key" as the
+fix. **That proposal, done naively, would be actively dangerous — worse than the bug it fixes.**
+
+`ingest-legiscan-texts.js`'s own file header (`:59-65`) explains why the shared key exists at all:
+**both CLIs spend queries against the SAME real LegiScan account and the SAME real 30,000/month
+cap.** `getMonthlyQueryUsage` (`src/adapters/legiscan.js:229`) sums `detail.queries_used` filtered
+by `.eq('source', source)` — a single exact match. If the two CLIs get distinct source strings
+WITHOUT also fixing how the budget check sums usage, each CLI's own budget check would only see its
+OWN half of the real spend, silently letting the combined total exceed the real account cap — the
+exact terms violation the shared key was deliberately built to prevent (binding Rule 1,
+`docs/research/2026-07-28-legiscan-terms.md`, suspension-level). **This fix is only safe if the
+budget check is updated to sum across BOTH source labels while everything else (freshness display,
+scheduler due-ness) is updated to distinguish them.**
+
+## What's actually broken today (confirmed, fail-safe, but real)
+
+- `public_freshness` shows ONE row for `legiscan` reflecting whichever CLI ran most recently —
+  a manual texts run can make the votes/bills pipeline look more or less recently active than it
+  really was.
+- The scheduler's own due-ness read (`scripts/scheduled-ingest.js:620`,
+  `queryLatestStartedAt(client, 'legiscan')`) reads the latest `started_at` for `source='legiscan'`
+  regardless of which CLI wrote it — confirmed in the scheduler's own code comment (`:463-469`): a
+  manual texts run between scheduler ticks DELAYS (never skips or advances) the next real votes/
+  bills tick, because it makes the shared source look more recently touched than the actual
+  automated pipeline. **This is currently accepted as fail-safe (delay only, never skip) — but it's
+  a real, unnecessary imprecision this fix removes entirely, not just tolerates.**
+
+## No schema migration is actually needed — verified
+
+`ingestion_runs.source` is `text not null` (migration `0001_core_schema.sql:114`) with NO check
+constraint anywhere enumerating allowed values (grepped all 21 migrations). This is a data
+correction plus a code change, following the EXACT same `correct-data.js` pattern as every other
+production-data fix in this repo — not a schema migration. (TODO-33's own text said "schema + CLI +
+historical-row migration" — that overstated the schema piece, the same way TODO-35 turned out to
+overstate its own claim. Always re-verify a TODO entry's framing against live reality before
+building to it literally.)
+
+## The historical-row classification rule — verified against ALL 54 real live rows, not sampled
+
+Live-queried every `source='legiscan'` row (54 total) and classified each:
+
+- **48 rows: `detail.votes` is a number, no `detail.counts` object.** This is `ingest-legiscan.js`'s
+  own shape (`buildSuccessCloseDetail`, `ingest-legiscan.js:961-963` — spreads `result.counts` at
+  the TOP level, `votes` included, never nested). Classify → **`legiscan`** (unchanged).
+- **2 rows: no top-level `detail.votes`, `detail.counts` IS an object.** `ingest-legiscan-texts.js`'s
+  own shape (billsPlanned/docCacheHits/alreadyHasVersion/... nested under `.counts`, no `votes`
+  field anywhere in that CLI — confirmed by reading the whole file). Classify → **`legiscan-texts`**
+  (the new label).
+- **4 rows: neither shape — a bare `{error, queries_used}` failure detail.** Both CLIs' failure
+  paths converge to this simpler shape, so detail-shape alone can't distinguish them. **All 4
+  sampled directly and their `detail.error` text is unambiguous**: every one references
+  votes-pipeline-specific code — `"insertIfAbsent(votes) failed"` (the literal table-name argument
+  `src/lib/db.js`'s generic error message includes when called with `table='votes'` — a string
+  `ingest-legiscan-texts.js` structurally cannot produce, since that file never calls
+  `insertIfAbsent` with `'votes'` anywhere), and `"legiscan-votes: could not write..."` (the literal
+  prefix `src/adapters/legiscan-votes.js`'s own throw statements use — a module
+  `ingest-legiscan-texts.js` never imports at all). These are real, deterministic, sourced signals —
+  not guesses — because they're exact strings this project's own code produces, traceable to a
+  specific file. Classify all 4 → **`legiscan`** (unchanged; they are genuine `ingest-legiscan.js`
+  failures, including the exact `roll_call_id` type-mismatch bug fixed earlier today).
+
+**Re-verify this classification against the LIVE database at implementation time — the count will
+have grown since this brief (54 as of this writing); the RULE is what matters, not the frozen
+count.** If any row doesn't cleanly match any of the three patterns above (shape check, or a
+recognizable error-string marker), **do not guess — leave it as `legiscan` (the current, safe
+default) and report it explicitly as unclassified in your response.** Misclassifying a real
+`ingest-legiscan.js` query as `legiscan-texts` would UNDERCOUNT that CLI's own budget usage on its
+next self-check (dangerous, could let real usage exceed the cap unnoticed); leaving an ambiguous row
+as `legiscan` is always safe — it just stays combined, exactly like today, introducing no new risk.
+
+## The fix, five parts
+
+1. **New source constant.** In `ingest-legiscan-texts.js`, add a distinct constant for what THIS
+   CLI writes to `ingestion_runs.source` going forward — e.g. `RUN_SOURCE = 'legiscan-texts'`. Keep
+   the existing `SOURCE` import from `ingest-legiscan.js` (still `'legiscan'`) for budget-check
+   purposes only (see part 2) — do not conflate the two uses. Update the `openRun`/`closeRun` call
+   site (`:781` and its `closeRun` call) to use `RUN_SOURCE`, not `SOURCE`. Update the stale comment
+   at `:781` ("SAME source as ingest-legiscan.js") — it will no longer be true.
+
+2. **Budget check must sum across BOTH labels — this is the load-bearing part.** Modify
+   `getMonthlyQueryUsage` (`src/adapters/legiscan.js:229`) to accept EITHER a single source string
+   (existing callers, unchanged behavior) OR an array of sources to sum together — e.g. change the
+   filter from `.eq('source', source)` to something that handles both
+   (`.in('source', Array.isArray(source) ? source : [source])`). Update `assertRunUnderBudget`
+   (`ingest-legiscan.js:944`) the same way if it also needs to pass an array through. **Both
+   `ingest-legiscan.js`'s own budget check AND `ingest-legiscan-texts.js`'s own budget check must
+   now pass `source: ['legiscan', 'legiscan-texts']` (the FULL combined set)** — every query either
+   CLI plans to spend competes against the SAME real account limit, and each CLI's own pre-flight
+   check must see the TRUE combined total, not just its own half. Test this specifically: a
+   scenario where CLI A has spent most of the cap and CLI B's OWN check must still correctly refuse
+   because of CLI A's spend (and vice versa) — this is the single most important behavior in this
+   whole fix; get it wrong and this fix creates a real risk of exceeding LegiScan's terms.
+
+3. **Historical-row backfill**, following the classification rule above exactly, as a new
+   correction in `correct-data.js` (matching this repo's own established convention — read
+   `runCorrectMoStatus`/`runCorrectPartyNormalize` for the exact shape/conventions to mirror: a
+   dry-run-safe function, an honest counts object, `--dry-run` reproduces live target numbers,
+   commit only at 0 test failures). This CLI is `built ready, dry-run verified — Lance runs the live
+   pass himself`, per this file's own established header convention — do not run it live yourself.
+   `--limit`/session scoping are not needed here (54 rows total, small, no pagination-cap risk) but
+   still use `selectAll` for the read per this repo's own standing rule.
+
+4. **`legiscanWroteSomething`'s stale comment** (`scripts/scheduled-ingest.js:462-469`) documents the
+   OLD shared-key confusion as an accepted, fail-open-safe residual. Once the split lands, the
+   scenario it describes (a manual texts run polluting the scheduler's due-ness read for `legiscan`)
+   can no longer happen going forward — update the comment to say so; the function's own fail-open
+   behavior for a genuinely unrecognized detail shape should stay (defensive, in case a SIXTH source
+   is ever added without its own predicate — that's a different, still-valid concern), just correct
+   what it says about THIS specific scenario. **Do not touch `SOURCE_KEYS`
+   (`scripts/scheduled-ingest.js:181`) or anything else about the scheduler's registry** — the
+   scheduler never invokes `ingest-legiscan-texts.js` and that stays true; this whole fix changes
+   what value `ingest-legiscan-texts.js` itself writes, nothing about how the scheduler decides what
+   to run.
+
+5. **`public_freshness` needs no code change** — confirmed: it's a plain `distinct on (source)`
+   aggregation with no hardcoded source enumeration (migration `0019_view_scoping_and_freshness.sql`).
+   Once `ingest-legiscan-texts.js` starts writing `legiscan-texts` and the historical rows are
+   relabeled, the view will show two correctly-distinct rows automatically. Verify this is true by
+   reading the view definition yourself rather than trusting this brief's claim alone.
+
+## Constraints
+
+- TDD red-first throughout. For `getMonthlyQueryUsage`'s array-summing change: test a single-string
+  call still works identically (regression); test an array of two sources sums correctly across
+  rows with different source values; test the cross-CLI budget-refusal scenario from part 2
+  explicitly. For the historical backfill: test all three classification cases (votes-shape,
+  texts-shape, error-marker fallback) plus the "genuinely unclassifiable → stays `legiscan`, never
+  guessed" case. No live DB writes from tests.
+- Bare `node --test` from repo root; baseline currently 2170 (re-check the actual current count
+  before claiming a delta — it has moved multiple times today). Extract the literal `ℹ fail` line
+  yourself; commit ONLY at 0.
+- This touches LegiScan's own suspension-level query-budget enforcement — re-read
+  `docs/research/2026-07-28-legiscan-terms.md`'s Rule 1 before writing the budget-summing code, and
+  state explicitly in your report that you did.
+- Commit message explains the defect (including WHY the naive "just split the key" approach in the
+  original TODO text would have been dangerous) and the fix, ends with:
+
+Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
+
+Return: status, commit hash, fail-count line verbatim, the live classification result for all
+current `source='legiscan'` rows (counts per bucket, and explicit disclosure of any row you could
+not classify and left as `legiscan`), the `--dry-run` output of the new correction against the real
+live DB, and concerns — especially anything about the budget-summing logic you are not 100% certain
+is airtight, given the suspension-level stakes.
diff --git a/CHATLOG.md b/CHATLOG.md
index 0d4e288..8f6d662 100644
--- a/CHATLOG.md
+++ b/CHATLOG.md
@@ -1179,10 +1179,49 @@ linked one). Scott Sifton, cited as an example of the "problem," carries zero `t
 identity matcher correctly refuses to link him to anyone, because there's nothing to safely match
 against. The Mary Coleman / Mary Elizabeth Coleman pair, TODO 35's own headline example of a
 "missed unification," was already merged to one person. The one real ambiguity in this roster (Dan
 Brown / Justin Brown) was already a known, open flag — untouched, exactly where it should stay.
 
 Building the "identity merge pass" TODO 35 called for would have meant writing new automated
 merge logic for a same-seat pattern that is, by design, mostly DIFFERENT people — precisely the
 class of mistake (the Symington father/son near-miss) this project has been burned by before.
 Verifying against live data before writing any code caught that no fix was needed at all — the
 existing identity system was already right.
+
+## 2026-08-02 (continued) — TODO-33 closed: split the `source='legiscan'` key without breaking
+budget enforcement (Lance approved real Fable5 usage on this one for accuracy)
+
+TODO-33's own original text ("split the source key") was itself incomplete, same lesson as TODO-35
+above but with real stakes this time: `ingest-legiscan.js` (votes/bills) and
+`ingest-legiscan-texts.js` (doc-blob text fetches) share `ingestion_runs.source='legiscan'`
+specifically because both CLIs spend queries against the SAME real LegiScan account and its ONE
+real 30,000/month cap. Giving them distinct labels without ALSO fixing the budget-summing math
+would have been actively dangerous — each CLI's own pre-flight `getMonthlyQueryUsage`/
+`assertRunUnderBudget` check would only ever see its own half of the real spend, silently letting
+the combined total exceed the real cap without either CLI's own refusal ever noticing. Re-read
+`docs/research/2026-07-28-legiscan-terms.md` Rule 1 before touching the budget code, per the
+brief's own explicit instruction.
+
+The fix, in order: (1) `ingest-legiscan-texts.js` writes its own `RUN_SOURCE='legiscan-texts'`
+going forward; (2) `getMonthlyQueryUsage` (`src/adapters/legiscan.js`) now accepts either a bare
+source string (existing callers, byte-for-byte unchanged — still `.eq()`) or an array of sources,
+summed via `.in()`; both CLIs' own budget checks now pass `ALL_LEGISCAN_SOURCES` (the combined
+pair), including `ingest-legiscan.js`'s own main()-only call site, extracted into a new
+`runLegiscanBudgetGate` purely so it could be unit-tested directly (this repo's own established
+"extract for testability" precedent). Proved the load-bearing direction explicitly, twice, in both
+files: CLI A's own check refuses because of CLI B's spend, and vice versa, with a negative-control
+assertion showing an own-source-only check would have wrongly let the run proceed — the exact bug
+this fix closes. (3) No schema migration needed — `ingestion_runs.source` is unconstrained `text`,
+confirmed against all 21 migrations. The historical-row backfill is a new `correct-data.js`
+correction (`legiscan-source-split`), same draft-then-apply convention as every other correction in
+that file: built ready, `--dry-run` verified against the real live DB, Lance runs the live pass.
+Live-classified all 54 real `source='legiscan'` rows by detail shape (votes-number vs. counts-object)
+with two exact, sourced error-string markers as a fallback for the 4 rows whose failure detail is
+too generic to distinguish by shape alone — 48 stay `legiscan`, 2 relabel to `legiscan-texts`, 4
+stay `legiscan` (genuine `ingest-legiscan.js` failures), 0 unclassified. (4) The scheduler's own
+stale comment about a manual texts run polluting its due-ness read is corrected — that scenario
+can no longer happen once the historical rows are relabeled — `SOURCE_KEYS` and the scheduler's
+own registry are untouched, exactly as the brief required. (5) `public_freshness` needed no code
+change, confirmed by reading the view definition directly: a plain `distinct on (source)` with no
+hardcoded source enumeration.
+
+2170 → 2192 tests (22 new, all TDD red-first), 0 fail. Full suite green before committing.
diff --git a/TODO.md b/TODO.md
index 3ea5a5f..d3861e3 100644
--- a/TODO.md
+++ b/TODO.md
@@ -259,30 +259,36 @@
     historical/multi-era backfill** — a natural next step. Fix BEFORE any such backfill.
 
 32. **`summarize.js` unbounded selects — the ledger said URGENT-WHEN-SUMMARIES-RESUME, and
     summaries HAVE resumed.** `src/cli/summarize.js:89` (bills), `:96` (`votes`), `:117`
     (summaries) are bare `.select()` with no `selectAll`, no `.range()`, no `.limit()`; `votes` is
     now ~10,000 rows, well past the 1,000 cap, so its candidate picker silently returns an
     arbitrary truncated subset. Wave 1 was safe only because it used `summary-queue.js` instead.
     Fix before anyone reaches for `summarize.js` again. (TODO 18 tracks this as "hygiene" — the
     ledger's own word was URGENT.)
 
-33. **Two CLIs share `source='legiscan'` in `ingestion_runs` with different detail shapes**
-    (surfaced by the 2026-07-31 scheduler review, reviewer-confirmed out-of-scope-but-ledger).
-    `ingest-legiscan.js` (votes/bills) and `ingest-legiscan-texts.js` (doc blobs,
-    `ingest-legiscan-texts.js:781`, deliberate per its own comment) both write the same source
-    key, so any latest-row read — scheduler due-ness, `public_freshness` — sees whichever ran
-    last. Every current consequence is fail-safe (a manual texts run can only *delay* the next
-    scheduled legiscan tick, never advance it; the scheduler's refresh gate fails open on the
-    texts shape). Real fix = split the source key (schema + CLI + historical-row migration
-    touching `public_freshness`) — **draft-then-apply, Lance runs it**. Not urgent; recorded so
-    the shared key stops being a surprise.
+33. [x] ~~Two CLIs share `source='legiscan'` in `ingestion_runs` with different detail shapes~~
+    **CODE FIX SHIPPED 2026-08-02** (`.superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/
+    brief.md). `ingest-legiscan-texts.js` now writes its own `RUN_SOURCE='legiscan-texts'`
+    (`src/cli/ingest-legiscan-texts.js`), never the shared `SOURCE`. This entry's own original
+    text understated the risk: splitting the key naively (no other change) would have let each
+    CLI's own pre-flight budget check see only ITS half of the real spend against the ONE real
+    LegiScan account's 30,000/month cap — a genuine terms-violation risk, not just a display bug.
+    Fixed alongside the split: `getMonthlyQueryUsage`/`assertRunUnderBudget`
+    (`src/adapters/legiscan.js`, `src/cli/ingest-legiscan.js`) now accept an array of sources and
+    sum them; BOTH CLIs' own budget checks pass `ALL_LEGISCAN_SOURCES` (the combined pair), proven
+    by an explicit cross-CLI refusal test in each direction. No schema migration was needed
+    (`ingestion_runs.source` is unconstrained `text`) — `correct-data.js`'s new
+    `legiscan-source-split` correction (`runCorrectLegiscanSourceSplit`) is the historical-row
+    fix, **built ready, `--dry-run` verified against the real live DB (54 rows: 2 relabel to
+    `legiscan-texts`, 52 stay `legiscan`, 0 unclassified) — Lance runs the live pass himself**,
+    same draft-then-apply convention as every other correction in that file.
 
 34. [x] ~~MO House driver silently slept ~30 minutes mid-run, wedged behind its own rate
     limiter — every scheduled run ETIMEDOUT.~~ **FIXED 2026-08-01.** `mo-house-xml.js:12`'s
     `moHouseLimiter` (30 min/request, per house.mo.gov's own ToU) is correctly *strict*, but
     `ingest-mo-house.js`'s old shape could need TWO live requests in one invocation — a stale
     `BillList.XML` refresh, then a per-bill XML fetch — both through that SAME shared limiter, so
     the second request just slept out the first request's ~30-minute interval in-process (zero
     connections, zero CPU, zero log output — invisible unless you caught the process alive).
     Under the scheduler's 480s child timeout every such run was killed first: mo-house-xml was
     3-for-3 ETIMEDOUT, effectively down. **The round-2 reviewer's "every historical run took an
diff --git a/scripts/scheduled-ingest.js b/scripts/scheduled-ingest.js
index 956048f..333d042 100644
--- a/scripts/scheduled-ingest.js
+++ b/scripts/scheduled-ingest.js
@@ -453,29 +453,38 @@ export function moHouseWroteSomething(detail, status) {
 }
 
 // legiscan (the actual NEW-1 fix): `ingest-legiscan.js`'s own `buildSuccessCloseDetail` (that
 // file's own :961-963) is `return {...counts, attribution, queries_used: counts.queriesUsed}` —
 // it spreads `result.counts` at the TOP LEVEL of `detail`, never nested under a `.counts` key.
 // Verified against all 50 real `ingest-legiscan.js` rows on file: `detail.votes` (top-level) is a
 // genuine, reliable counter, observed 0-659 — this is the honest signal the old code's
 // `detail.counts.votes` lookup could never have matched (there is no `detail.counts` for this
 // CLI's own runs at all, which is the actual root cause of NEW-1's 0/52).
 //
-// `src/cli/ingest-legiscan-texts.js` ALSO writes to `source='legiscan'` — its own header comment
-// says so explicitly ("SAME source as ingest-legiscan.js") — with a COMPLETELY different,
-// votes-unrelated close-detail shape (billsPlanned/docCacheHits/alreadyHasVersion/... — text-cache
-// counters, nested under `detail.counts`, no votes field anywhere; 2 of the 52 real rows). This
-// scheduler's own registry only ever invokes ingest-legiscan.js, never ingest-legiscan-texts.js —
-// but queryLatestRun reads whatever the LATEST row for source='legiscan' happens to be, so if that
-// text CLI is ever run manually between scheduler ticks, this predicate would see ITS shape
-// instead. No honest votes signal exists there either, so it falls through to the same fail-open
-// default as every other unrecognized shape.
+// UPDATE (TODO-33, .superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md): at the time
+// this predicate was written, `src/cli/ingest-legiscan-texts.js` ALSO wrote to `source='legiscan'`
+// (its own header comment used to say so explicitly, "SAME source as ingest-legiscan.js") — a
+// manual texts run between scheduler ticks could pollute `queryLatestRun`'s read for
+// source='legiscan' with that CLI's own COMPLETELY different, votes-unrelated close-detail shape
+// (billsPlanned/docCacheHits/alreadyHasVersion/... — text-cache counters, nested under
+// `detail.counts`, no votes field anywhere), which this predicate would see with no honest votes
+// signal to read, falling through to the same fail-open default as any unrecognized shape — accepted
+// at the time as fail-safe (delay only, never skip or advance) but a real, unnecessary imprecision.
+// TODO-33 gives `ingest-legiscan-texts.js` its own distinct `source='legiscan-texts'` label going
+// forward (with the historical rows relabeled too) — this scenario can no longer happen: every row
+// this predicate ever reads for source='legiscan' is now genuinely, exclusively an
+// `ingest-legiscan.js` row. `legiscanWroteSomething`'s own final fallback (below) stays exactly as
+// it was — defensive, in case a SIXTH source is ever added without its own predicate wired in — that
+// is a different, still-valid concern, unrelated to this one now-closed scenario. SOURCE_KEYS
+// (below) and this registry's own scheduling logic are untouched: the scheduler never invoked
+// `ingest-legiscan-texts.js` before this fix and still doesn't — only what THAT CLI itself writes to
+// `ingestion_runs.source` has changed.
 export function legiscanWroteSomething(detail, status) {
   const votes = detail?.votes;
   if (typeof votes === 'number') return votes > 0;
   return status === 'succeeded' || status === 'partial';
 }
 
 // defaultWroteSomething: fail-open fallback for a registry entry with no predicate wired at all
 // (should never happen with the five fixed entries below — defensive only, e.g. against a future
 // sixth source added without also wiring its own predicate).
 export function defaultWroteSomething(detail, status) {
diff --git a/src/adapters/legiscan.js b/src/adapters/legiscan.js
index d88d19b..cd49cc2 100644
--- a/src/adapters/legiscan.js
+++ b/src/adapters/legiscan.js
@@ -5,20 +5,36 @@ import { selectAll } from '../lib/db.js';
 // LegiScan bulk adapter — API client core (Task 2 of docs/superpowers/plans/2026-07-29-legiscan-
 // bulk-adapter.md). This module owns: status-checking (skip≠empty, typed errors), the mandatory
 // dataset_hash gate (suspension-level per docs/research/2026-07-28-legiscan-terms.md rule 2), the
 // shared per-source limiter, and the monthly query-budget refusal. NO ZIP decoding here (Task 3,
 // gated on Lance's yauzl approval) — getDataset returns the raw envelope including the still-
 // Base64-encoded zip field untouched.
 
 export const SOURCE = 'legiscan';
 export const ATTRIBUTION = { license: 'CC BY 4.0', holder: 'LegiScan', url: 'https://legiscan.com' };
 
+// LEGISCAN_TEXTS_SOURCE / ALL_LEGISCAN_SOURCES — TODO-33 (source split,
+// .superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md). ingest-legiscan-texts.js
+// (doc-blob text fetches) writes its OWN distinct ingestion_runs.source label going forward
+// ('legiscan-texts') instead of sharing SOURCE with ingest-legiscan.js (votes/bills) — but both
+// CLIs still spend queries against the SAME real LegiScan account and the SAME real 30,000/month
+// cap (docs/research/2026-07-28-legiscan-terms.md, Rule 1, binding). Splitting the label WITHOUT
+// also making the budget check sum across BOTH labels would be actively dangerous: each CLI's own
+// pre-flight getMonthlyQueryUsage/assertRunUnderBudget call would then only ever see its OWN half
+// of the real spend, silently letting the TRUE combined total exceed the real account cap without
+// either CLI ever refusing — the exact terms violation the shared key was originally built to
+// prevent. ALL_LEGISCAN_SOURCES is the one canonical combined set both CLIs' own budget checks must
+// pass as `source` — defined once, here (next to SOURCE), so neither CLI hardcodes the pair
+// separately (which could silently drift if a source label is ever renamed again).
+export const LEGISCAN_TEXTS_SOURCE = 'legiscan-texts';
+export const ALL_LEGISCAN_SOURCES = [SOURCE, LEGISCAN_TEXTS_SOURCE];
+
 // Pull API base per the LegiScan API Manual (Task 2 WebFetch, see LEGISCAN_MIN_INTERVAL_MS comment
 // below for provenance): "https://api.legiscan.com/?key=APIKEY&op=OPERATION&PARAMS".
 const BASE = 'https://api.legiscan.com/';
 
 // LEGISCAN_MIN_INTERVAL_MS — resolved via the one permitted WebFetch (Global Constraints #6 /
 // ruling Q3, .superpowers/sdd/legiscan-plan-draft-notes.md): fetched
 // https://api.legiscan.com/dl/ (reachable, NOT Cloudflare-blocked, confirming prior research) which
 // links straight to https://api.legiscan.com/dl/LegiScan_API_User_Manual.pdf (rev 20250317,
 // 43 pages). Extracted the PDF's real text with pdfjs-dist (already a project dependency, same
 // legacy-build extraction pattern as mo-rollcall-pdf.js/mo-senate-journal-pdf.js) and read every
@@ -210,39 +226,53 @@ export function decodeDatasetHashGate(sessionId, reportedHash, ledgerRow) {
   return { shouldFetch: true, reason: 'hash_changed' };
 }
 
 // getMonthlyQueryUsage — sums ingestion_runs.detail.queries_used for `source` within the current
 // calendar month. Reads via selectAll (src/lib/db.js:85), NOT a bare .select() — a busy month's
 // ingestion_runs rows could plausibly exceed the 1000-row PostgREST page default, and an
 // unpaginated read would silently UNDERCOUNT usage, letting a run blow past the configured monthly
 // query cap (Global Constraints #2 / terms doc rule 1) — the exact shape of bug selectAll itself
 // was written to close (see src/lib/db.js's own "finding 1" comment).
 //
+// TODO-33 (source split, .superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md,
+// part 2 — the LOAD-BEARING part of that fix): `source` may now be EITHER a single source string
+// (every existing caller, behavior byte-for-byte unchanged — still a plain `.eq('source', source)`)
+// OR an array of sources, summed TOGETHER via `.in('source', sources)`. This exists so
+// ingest-legiscan.js and ingest-legiscan-texts.js — two CLIs writing two DISTINCT source labels but
+// spending queries against the SAME real LegiScan account/30,000-per-month cap — can each pass
+// ALL_LEGISCAN_SOURCES (above) and see the TRUE combined total, not just their own half. A caller
+// that split its own source label without also switching its budget check to the array form would
+// silently undercount real usage — see ALL_LEGISCAN_SOURCES's own header comment for why that is a
+// genuine terms violation, not just an accounting nicety.
+//
 // Month boundary is UTC (ruling Q5, .superpowers/sdd/legiscan-plan-draft-notes.md) — LegiScan's own
 // reset is "resets the 1st" against its ET-based billing clock, so a run within a few hours of
 // midnight ET around the month edge could be scoped to the "wrong" UTC month by this boundary.
 // Accepted imprecision per Q5: low-stakes given the 5,000/30,000 headroom (Global Constraints #2) —
 // worst case this is off by a few hours' worth of queries right at the edge, nowhere near enough to
 // matter against a default 5,000/month cap.
 //
 // ingestion_runs has no created_at column (supabase/migrations/0001_core_schema.sql) — started_at
 // is the real per-run timestamp and is what every run's month is scoped by here.
 export async function getMonthlyQueryUsage(client, { source = SOURCE, now = new Date() } = {}) {
   const year = now.getUTCFullYear();
   const month = now.getUTCMonth();
   const monthStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
   const monthEnd = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
+  const sources = Array.isArray(source) ? source : [source];
   const { data, error } = await selectAll(client, 'ingestion_runs', 'detail', {
-    filter: (q) => q
-      .eq('source', source)
-      .gte('started_at', monthStart.toISOString())
-      .lt('started_at', monthEnd.toISOString()),
+    filter: (q) => {
+      const withSource = sources.length === 1 ? q.eq('source', sources[0]) : q.in('source', sources);
+      return withSource
+        .gte('started_at', monthStart.toISOString())
+        .lt('started_at', monthEnd.toISOString());
+    },
   });
   if (error) throw new Error(`getMonthlyQueryUsage: could not read ingestion_runs: ${error.message}`);
   return (data ?? []).reduce((sum, row) => sum + (Number(row?.detail?.queries_used) || 0), 0);
 }
 
 // assertUnderBudget — pure hard-refusal gate (Global Constraints #2 / ruling Q2, APPROVED as
 // drafted): a run refuses to START if usage-so-far plus this run's own planned query count would
 // plausibly exceed capPerMonth. capPerMonth is the caller's job to supply (default 5,000/month,
 // overridable via LEGISCAN_MONTHLY_QUERY_CAP per Q2 — that env-reading belongs to the CLI driver,
 // Task 9, not this pure function).
diff --git a/src/cli/correct-data.js b/src/cli/correct-data.js
index d48d3d5..bec30db 100644
--- a/src/cli/correct-data.js
+++ b/src/cli/correct-data.js
@@ -89,27 +89,27 @@ export function parseArgs(argv) {
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
-      `correct-data: requires exactly one <which> argument (mo-status | mo-1969-dates | party-normalize | mo-2026-session-merge | mo-2026-vote-reconcile | all), got ${positionals.length} — `
+      `correct-data: requires exactly one <which> argument (mo-status | mo-1969-dates | party-normalize | mo-2026-session-merge | mo-2026-vote-reconcile | legiscan-source-split | all), got ${positionals.length} — `
         + 'no default, so an operator can never accidentally run every correction at once',
     );
   }
   const [which] = positionals;
-  if (!['mo-status', 'mo-1969-dates', 'party-normalize', 'mo-2026-session-merge', 'mo-2026-vote-reconcile', 'all'].includes(which)) {
-    throw new Error(`correct-data: unknown <which> "${which}" — expected mo-status | mo-1969-dates | party-normalize | mo-2026-session-merge | mo-2026-vote-reconcile | all`);
+  if (!['mo-status', 'mo-1969-dates', 'party-normalize', 'mo-2026-session-merge', 'mo-2026-vote-reconcile', 'legiscan-source-split', 'all'].includes(which)) {
+    throw new Error(`correct-data: unknown <which> "${which}" — expected mo-status | mo-1969-dates | party-normalize | mo-2026-session-merge | mo-2026-vote-reconcile | legiscan-source-split | all`);
   }
   out.which = which;
   return out;
 }
 
 // ============================================================================================
 // Correction A — mo-status: numeric LegiScan status codes -> their printed words
 // ============================================================================================
 
 // MO_STATUS_WORD_MAP — SOURCED, not invented: LegiScan API User Manual, page 42
@@ -1166,20 +1166,157 @@ export async function runReconcileMo2026VotesStandalone(client, {
 export async function runCorrectMo2026SessionMerge(client, {
   dryRun = false, limit = null, runId = null,
 } = {}) {
   const merge = await runMergeMo2026Session(client, { dryRun, limit, runId });
   const reconciliation = await runReconcileMo2026Votes(client, { dryRun, runId, mergedBills: merge.merges });
   return {
     merge, reconciliation, failures: [...merge.failures, ...reconciliation.failures],
   };
 }
 
+// ============================================================================================
+// Correction — legiscan-source-split (TODO-33, .superpowers/sdd/2026-08-02-todo-33-legiscan-
+// source-split/brief.md, part 3): historical-row backfill for the source-key split. Before this
+// fix, BOTH `ingest-legiscan.js` (votes/bills) and `ingest-legiscan-texts.js` (doc-blob text
+// fetches) wrote `ingestion_runs.source = 'legiscan'` — deliberately shared, because both CLIs
+// spend queries against the SAME real LegiScan account/30,000-per-month cap (docs/research/
+// 2026-07-28-legiscan-terms.md, Rule 1) and the budget check summed usage per exact source string.
+// `ingest-legiscan-texts.js` now writes its own distinct `'legiscan-texts'` label going forward
+// (src/cli/ingest-legiscan-texts.js's RUN_SOURCE; the budget check itself was separately fixed to
+// sum BOTH labels together — src/adapters/legiscan.js's ALL_LEGISCAN_SOURCES/getMonthlyQueryUsage —
+// see that module's own header comment for why splitting the label without ALSO fixing the budget
+// summing would have been dangerous). This correction relabels the historical rows that were
+// ALREADY written under the old shared key but actually belong to ingest-legiscan-texts.js, so
+// public_freshness and the scheduler's own due-ness read both start reporting two genuinely
+// distinct pipelines immediately, not just for runs going forward.
+//
+// CLASSIFICATION RULE — verified against ALL 54 real live `source='legiscan'` rows on file at
+// implementation time (48 votes-shape / 2 texts-shape / 4 error-marker / 0 unclassified):
+//   1. `detail.votes` is a number, no `detail.counts` object -> ingest-legiscan.js's OWN shape
+//      (buildSuccessCloseDetail spreads `result.counts` — votes included — at the TOP level of
+//      detail, never nested). Classify -> 'legiscan' (unchanged).
+//   2. No top-level `detail.votes`, `detail.counts` IS an object -> ingest-legiscan-texts.js's OWN
+//      shape (billsPlanned/docCacheHits/alreadyHasVersion/... nested under `.counts`, no `votes`
+//      field anywhere in that CLI). Classify -> 'legiscan-texts' (the new label — RELABEL).
+//   3. Neither shape (a bare `{error, queries_used}` failure detail — both CLIs' failure paths
+//      converge to this simpler shape, so detail-shape alone can't distinguish them here) ->
+//      classified by an exact, SOURCED error-string marker (LEGISCAN_TEXTS_ERROR_MARKERS' own name
+//      is backwards from its role — see that constant's own comment): `"insertIfAbsent(votes)
+//      failed"` (src/lib/db.js's own generic error message, only ever produced when insertIfAbsent
+//      is called with table='votes' — ingest-legiscan-texts.js never calls insertIfAbsent with
+//      'votes' anywhere) or `"legiscan-votes:"` (src/adapters/legiscan-votes.js's own throw-
+//      statement prefix — a module ingest-legiscan-texts.js never imports at all). Either marker ->
+//      classify 'legiscan' (unchanged; a genuine ingest-legiscan.js failure).
+//   4. Anything matching NONE of the above is NEVER guessed: misclassifying a real
+//      ingest-legiscan.js query as 'legiscan-texts' would UNDERCOUNT that CLI's own budget usage on
+//      its NEXT self-check (the dangerous direction — could let real usage exceed the real cap
+//      unnoticed); leaving a genuinely ambiguous row as 'legiscan' is always safe — it just stays
+//      combined, exactly like today, introducing no new risk. Counted honestly (`unclassified`) and
+//      surfaced (`unclassifiedRows`), never silently folded into `unchangedLegiscan`.
+//
+// DRAFT-THEN-APPLY (same established convention as every other correction in this file): built
+// READY, --dry-run verified against the real live DB, Lance runs the live pass himself.
+// ============================================================================================
+
+// LEGISCAN_TEXTS_ERROR_MARKERS — named for what they PROVE (an ingest-legiscan.js-only failure
+// shape), not what they cause: a match keeps the row classified 'legiscan' (the SAFE, unchanged
+// outcome), it never triggers a relabel. Both are literal, sourced strings this project's own code
+// produces — src/lib/db.js's insertIfAbsent (table='votes' only) and
+// src/adapters/legiscan-votes.js's own throw-statement prefix — never invented or fuzzy-matched.
+export const LEGISCAN_TEXTS_ERROR_MARKERS = ['insertIfAbsent(votes) failed', 'legiscan-votes:'];
+
+// classifyLegiscanSourceRow — pure. Returns 'legiscan' | 'legiscan-texts' | null (never guessed —
+// see rule 4 above). `detail` is one row's own `ingestion_runs.detail` jsonb value, as read from
+// the DB (a plain object, or null/undefined for a genuinely empty/missing detail).
+export function classifyLegiscanSourceRow(detail) {
+  const hasVotesNumber = typeof detail?.votes === 'number';
+  const hasCountsObject = detail?.counts != null && typeof detail.counts === 'object' && !Array.isArray(detail.counts);
+  if (hasVotesNumber && !hasCountsObject) return 'legiscan';
+  if (!hasVotesNumber && hasCountsObject) return 'legiscan-texts';
+  if (!hasVotesNumber && !hasCountsObject) {
+    const errText = typeof detail?.error === 'string' ? detail.error : '';
+    if (LEGISCAN_TEXTS_ERROR_MARKERS.some((marker) => errText.includes(marker))) return 'legiscan';
+  }
+  return null;
+}
+
+// runCorrectLegiscanSourceSplit — reads every `source='legiscan'` row via selectAll (project law:
+// no bare .select() on a multi-row table — 54 rows today is well under the 1000-row server page
+// cap, but this correction should never silently truncate if that count grows before it runs).
+// `updated always equal to relabeledToTexts + unchangedLegiscan + unclassified` is the same
+// reconciliation invariant this file's other corrections carry (e.g. runCorrectMoStatus's own
+// "updated always equals the sum of perCode").
+// NOTE: no `runId` param, unlike this file's other corrections — ingestion_runs has no run_id
+// column (it IS a run, not a row referencing one — supabase/migrations/0001_core_schema.sql), so
+// there is nothing for one to write. The top-level dispatcher still passes `runId` uniformly to
+// every correction; it is simply not destructured here.
+export async function runCorrectLegiscanSourceSplit(client, {
+  dryRun = false, limit = null,
+} = {}) {
+  const { data: rows, error } = await selectAll(client, 'ingestion_runs', 'id,source,detail', {
+    filter: (q) => q.eq('source', 'legiscan'),
+  });
+  if (error) throw new Error(`legiscan-source-split: scope query failed: ${error.message}`);
+
+  const sorted = [...(rows ?? [])].sort((a, b) => (a.id > b.id ? 1 : -1));
+  const scoped = limit != null ? sorted.slice(0, limit) : sorted;
+
+  const relabeled = [];
+  const unclassifiedRows = [];
+  const failures = [];
+  let unchangedLegiscan = 0;
+  let unclassified = 0;
+
+  for (const row of scoped) {
+    const classification = classifyLegiscanSourceRow(row.detail);
+    if (classification === 'legiscan') {
+      unchangedLegiscan += 1;
+      continue;
+    }
+    if (classification === null) {
+      unclassified += 1;
+      unclassifiedRows.push({ id: row.id, detail: row.detail });
+      continue;
+    }
+    // classification === 'legiscan-texts' — the only relabel-eligible outcome.
+    if (dryRun) {
+      relabeled.push({ id: row.id, from: 'legiscan', to: 'legiscan-texts' });
+      continue;
+    }
+    // eslint-disable-next-line no-await-in-loop -- small/infrequent backlog (54 rows total as of
+    // this writing; brief: "no --limit/pagination-cap risk"), same "sequential" precedent as this
+    // file's other corrections' per-row loops.
+    const { data: updatedRows, error: updErr } = await client
+      .from('ingestion_runs').update({ source: 'legiscan-texts' })
+      .eq('id', row.id).eq('source', 'legiscan').select('id');
+    if (updErr) {
+      failures.push({ id: row.id, reason: 'relabel_failed', error: String(updErr.message ?? updErr) });
+      continue;
+    }
+    if (!updatedRows || updatedRows.length !== 1) {
+      failures.push({ id: row.id, reason: 'relabel_guard_mismatch', got: updatedRows?.length ?? 0 });
+      continue;
+    }
+    relabeled.push({ id: row.id, from: 'legiscan', to: 'legiscan-texts' });
+  }
+
+  return {
+    seen: scoped.length,
+    relabeledToTexts: relabeled.length,
+    unchangedLegiscan,
+    unclassified,
+    relabeled,
+    unclassifiedRows,
+    failures,
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
 
@@ -1190,20 +1327,28 @@ export async function runCorrectData(client, {
   if (which === 'mo-1969-dates' || which === 'all') {
     out.mo1969Dates = await runCorrectMo1969Dates(client, { dryRun, limit, runId });
     failures.push(...out.mo1969Dates.failures);
   }
   // Joins 'all': same in-place-rewrite risk class as the two corrections above it (no deletes, no
   // FK redirects — a guarded UPDATE per exact source value), unlike the session-merge below.
   if (which === 'party-normalize' || which === 'all') {
     out.partyNormalize = await runCorrectPartyNormalize(client, { dryRun, runId });
     failures.push(...out.partyNormalize.failures);
   }
+  // legiscan-source-split (TODO-33) — same in-place-rewrite risk class as mo-status/party-normalize
+  // above (a guarded single-column UPDATE by primary key, no deletes, no FK redirects), so it joins
+  // 'all' alongside them rather than requiring an operator to name it separately the way the
+  // higher-stakes mo-2026-session-merge below does.
+  if (which === 'legiscan-source-split' || which === 'all') {
+    out.legiscanSourceSplit = await runCorrectLegiscanSourceSplit(client, { dryRun, limit, runId });
+    failures.push(...out.legiscanSourceSplit.failures);
+  }
   // Deliberately EXCLUDED from 'all' (brief, explicit): bill/session merge + FK redirect + guarded
   // deletes is higher-stakes than A/B's in-place rewrites — an operator must name this one, never
   // sweep it in by omission.
   if (which === 'mo-2026-session-merge') {
     out.mo2026SessionMerge = await runCorrectMo2026SessionMerge(client, { dryRun, limit, runId });
     failures.push(...out.mo2026SessionMerge.failures);
   }
   // mo-2026-vote-reconcile — the standalone Phase B re-run (task-review.md Important 2), for after
   // the duplicate session is already gone (a live mo-2026-session-merge pass either succeeded fully,
   // or aborted partway through Phase B and left some reconciliations undone). Also excluded from
diff --git a/src/cli/ingest-legiscan-texts.js b/src/cli/ingest-legiscan-texts.js
index fc20396..80bb725 100644
--- a/src/cli/ingest-legiscan-texts.js
+++ b/src/cli/ingest-legiscan-texts.js
@@ -2,21 +2,22 @@ import {
   existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
 } from 'node:fs';
 import { basename } from 'node:path';
 import { getClient, openRun, closeRun } from '../lib/db.js';
 import { parsePositiveIntegerFlag, SourceFetchError, RateLimitedError } from '../lib/errors.js';
 import { MAX_TEXT_CHARS, OversizeTextError } from '../lib/summarizer.js';
 import { sha256 } from '../adapters/us-congress-text.js';
 import { extractPdfText } from '../adapters/pdf-text.js';
 import { normalizeBillIdentifier } from '../adapters/legiscan-dataset.js';
 import {
-  SOURCE, ATTRIBUTION, getBillText, LegiScanApiError, QueryBudgetExceededError,
+  ATTRIBUTION, getBillText, LegiScanApiError, QueryBudgetExceededError,
+  LEGISCAN_TEXTS_SOURCE as RUN_SOURCE, ALL_LEGISCAN_SOURCES,
 } from '../adapters/legiscan.js';
 import {
   assertRunUnderBudget, recordQueryUsage, buildFailureCloseDetail,
 } from './ingest-legiscan.js';
 import { listCachedDatasetFiles } from './backfill-nicknames.js';
 import { readCachedDatasetBills, loadSessionIndex, loadBillIndex } from './backfill-mo-bill-meta.js';
 import {
   pickLatestTextEntry, loadBillTextVersionIndex, loadPassageBillIds, pickLimiterForUrl, EmptyExtractionError,
 } from './backfill-mo-bill-texts.js';
 import { isUniqueViolation } from './link-persons.js';
@@ -48,28 +49,40 @@ import { isUniqueViolation } from './link-persons.js';
 // state_link bill is exactly the kind of bill this path exists to unblock). Its MIME filter
 // (skippedNonPdf), however, IS restored below as `skippedNonPdfMime` — FIX (MED-1, controller
 // ruling on the fix-round review, corpus-verified, overriding this file's original launch
 // decision): measurement showed ZERO of the 2,202 real proxy-placeholder targets are non-PDF, and
 // every one of the corpus's 6,225 text/html bills sits on a state host the sibling CLI can already
 // reach directly — so spending a query (20.8% of one month's budget for that count alone) to store
 // nothing has no upside. planLegiscanTextWork below reuses the SAME building blocks (
 // pickLatestTextEntry, the two bulk indexes, normalizeBillIdentifier) as the sibling but keeps its
 // own routing rules: mime IS gated at planning time again, host is not.
 //
-// BUDGET SOURCE (critical, easy to get wrong): this run's own ingestion_runs.source MUST be the
-// SAME `SOURCE` ('legiscan') ingest-legiscan.js already writes — getMonthlyQueryUsage sums usage
-// PER SOURCE, and both this CLI and ingest-legiscan.js spend queries against the SAME real LegiScan
-// account/monthly quota. Using a distinct source string here (e.g. 'ingest-legiscan-texts') would
-// silently let the two CLIs each think they had the FULL cap to themselves, doubling the effective
-// budget against the one real account limit — exactly the terms violation binding rule 1 exists to
-// prevent. openRun/closeRun/assertRunUnderBudget/recordQueryUsage below all use the imported
-// `SOURCE` constant for this reason, never a bespoke label.
+// BUDGET SOURCE (critical, easy to get wrong — TODO-33, .superpowers/sdd/2026-08-02-todo-33-
+// legiscan-source-split/brief.md): this run's own ingestion_runs.source is now its OWN distinct
+// label, RUN_SOURCE ('legiscan-texts', imported above as `LEGISCAN_TEXTS_SOURCE as RUN_SOURCE`) —
+// NOT the same `SOURCE` ('legiscan') ingest-legiscan.js writes. Splitting the label fixes two real,
+// confirmed defects the shared key caused: public_freshness showing one blended row for two
+// unrelated pipelines, and the scheduler's own due-ness read (scripts/scheduled-ingest.js) treating
+// a manual texts run as if it were a votes/bills tick.
+//
+// BUT — and this is the part a naive "just split the key" fix would get dangerously wrong — this
+// CLI and ingest-legiscan.js still spend queries against the SAME real LegiScan account and the
+// SAME real 30,000/month cap (docs/research/2026-07-28-legiscan-terms.md, Rule 1, binding). If this
+// run's OWN pre-flight budget check only ever asked "how much has 'legiscan-texts' spent?" it would
+// be blind to ingest-legiscan.js's real spend under 'legiscan' — each CLI would only ever see its
+// own half of the true total, silently letting the COMBINED real spend exceed the real account cap
+// without either CLI's own refusal ever noticing. So: openRun/closeRun/the printed `source` field
+// below all use RUN_SOURCE (this run's own honest identity in the ledger), but the budget
+// check — assertBudgetFn below — is explicitly passed `source: ALL_LEGISCAN_SOURCES` (both labels,
+// combined; adapters/legiscan.js's own header comment on that constant has the full reasoning).
+// Never conflate the two: RUN_SOURCE says WHO wrote this row; ALL_LEGISCAN_SOURCES says WHAT the
+// budget check must sum before either CLI is allowed to spend another query.
 //
 // DOC CACHE (Rule 7, suspension-level): a document blob is downloaded at most once per doc_id,
 // EVER — .superpowers/artifacts/legiscan-texts/<doc_id>.json (gitignored via the repo's blanket
 // `.superpowers/` rule, same as the dataset ZIP cache). Only a verified status:'OK' response whose
 // own identity matches what was asked for (see IDENTITY CHECK below) is ever written there, and the
 // write itself is atomic (temp file + rename — MED-2, fix-round review: a crash mid-write must
 // never leave a truncated file at the real path, which would otherwise brick every future run
 // against that doc_id with a bare, unrecoverable SyntaxError). An ERROR response is never cached
 // (caching a failure would permanently block a legitimate future retry, which Rule 7 is not asking
 // for). A cache HIT is a pure, zero-cost filesystem fact and costs no query — see the BUDGET
@@ -556,21 +569,24 @@ export async function runIngestLegiscanTexts(client, {
   }
 
   // Pre-flight budget gate (binding rule 1: "refuses to start") — ONLY when a fresh query is
   // actually needed; a worklist fully satisfied by the doc cache never touches the budget check at
   // all. plannedFreshQueries is exact (a real filesystem fact, not a worst-case guess), matching
   // "an overcount is safe, an undercount is a terms violation" with no slack needed either way.
   let budgetOk = true;
   let budgetError;
   if (plannedFreshQueries > 0) {
     try {
-      await assertBudgetFn(client, { plannedQueries: plannedFreshQueries, capPerMonth });
+      // TODO-33: source: ALL_LEGISCAN_SOURCES — the load-bearing part of the source split (see the
+      // file header's BUDGET SOURCE comment). Never `source: RUN_SOURCE` here, and never the bare
+      // default either — both would be blind to ingest-legiscan.js's own real spend.
+      await assertBudgetFn(client, { plannedQueries: plannedFreshQueries, capPerMonth, source: ALL_LEGISCAN_SOURCES });
     } catch (err) {
       if (!(err instanceof QueryBudgetExceededError)) throw err;
       budgetOk = false;
       budgetError = {
         usage: err.usage, plannedQueries: err.plannedQueries, capPerMonth: err.capPerMonth, projected: err.projected,
       };
     }
   }
 
   const detail = { queries_used: 0 };
@@ -767,43 +783,46 @@ async function main() {
   if (!client) {
     console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
     process.exitCode = 1;
     return;
   }
 
   if (args.dryRun) {
     const report = await runIngestLegiscanTexts(client, {
       dryRun: true, limit: args.limit, session: args.session, priorityOnly: args.priorityOnly,
     });
-    console.log(JSON.stringify({ source: SOURCE, ...report }, null, 2));
+    console.log(JSON.stringify({ source: RUN_SOURCE, ...report }, null, 2));
     return;
   }
 
-  const runId = await openRun(client, SOURCE); // SAME source as ingest-legiscan.js — see file header
+  // TODO-33: RUN_SOURCE ('legiscan-texts'), not SOURCE — this run's own honest identity in the
+  // ledger. See the file header's BUDGET SOURCE comment for why the budget check (inside
+  // runIngestLegiscanTexts) is a DIFFERENT value (ALL_LEGISCAN_SOURCES) from this one.
+  const runId = await openRun(client, RUN_SOURCE);
   try {
     const report = await runIngestLegiscanTexts(client, {
       dryRun: false, runId, limit: args.limit, session: args.session, priorityOnly: args.priorityOnly,
     });
     const { status, partialReason } = computeLiveRunStatus(report);
     await closeRun(client, runId, status, {
       counts: report.counts,
       passagePriority: report.passagePriority,
       planCounts: report.planCounts,
       failures: report.failures,
       budgetError: report.budgetError,
       sessionUncached: report.sessionUncached,
       partialReason,
       queries_used: report.counts.queriesSpent,
       attribution: ATTRIBUTION,
     });
     console.log(JSON.stringify({
-      source: SOURCE, run_id: runId, status, partialReason, ...report,
+      source: RUN_SOURCE, run_id: runId, status, partialReason, ...report,
     }, null, 2));
     if (status !== 'succeeded') process.exitCode = 2;
   } catch (err) {
     const result = await closeRunOnAbort(client, runId, err);
     if (!result.closed) {
       // FIX (coordinator ruling, IMPORTANT-1(b)): never closeRun over an unverifiable ledger — see
       // closeRunOnAbort's own header comment. The run stays 'running'; its own last-known-good
       // write-ahead detail keeps counting correctly via getMonthlyQueryUsage.
       console.error(
         'WARNING: could not verify the query-usage ledger before closing this run — leaving it '
diff --git a/src/cli/ingest-legiscan.js b/src/cli/ingest-legiscan.js
index ab62117..0b5953b 100644
--- a/src/cli/ingest-legiscan.js
+++ b/src/cli/ingest-legiscan.js
@@ -1,20 +1,20 @@
 import {
   existsSync, mkdirSync, readFileSync, writeFileSync,
 } from 'node:fs';
 import {
   getClient, openRun, closeRun, insertIfAbsent, additivePatch, selectAll,
   isMissingColumnError, isMissingRelationError,
 } from '../lib/db.js';
 import {
   SOURCE, ATTRIBUTION, getDatasetList, getDataset, decodeDatasetHashGate,
-  getMonthlyQueryUsage, assertUnderBudget, DatasetHashMismatchError,
+  getMonthlyQueryUsage, assertUnderBudget, DatasetHashMismatchError, ALL_LEGISCAN_SOURCES,
 } from '../adapters/legiscan.js';
 import {
   decodeDatasetZip, extractDatasetFiles, normalizeBillIdentifier,
 } from '../adapters/legiscan-dataset.js';
 import { resolveOrCreateLegiscanPerson } from '../adapters/legiscan-identity.js';
 import {
   reconcileLegiscanTallies, buildLegiscanVoteSourceKey, buildLegiscanVoteCasts,
   crossCheckAgainstPrimarySource, LegiscanRollCallReconcileError, VoteIdMapError,
   LegiscanRollCallDateError,
 } from '../adapters/legiscan-votes.js';
@@ -941,20 +941,38 @@ export async function dryRunReportFromDb(client, legiscanSessionId) {
 // ingestion_runs client, independent of process.argv/getClient() — proves the gate throws (and
 // therefore main() never reaches runLegiscanIngest, since this call sits before it in the same
 // try block with no other await in between) without needing a live DB or a live LegiScan call.
 export async function assertRunUnderBudget(client, { source = SOURCE, plannedQueries, capPerMonth } = {}) {
   const cap = capPerMonth ?? (Number(process.env.LEGISCAN_MONTHLY_QUERY_CAP) || DEFAULT_MONTHLY_QUERY_CAP);
   const usage = await getMonthlyQueryUsage(client, { source });
   assertUnderBudget(usage, plannedQueries, cap);
   return { usage, plannedQueries, capPerMonth: cap };
 }
 
+// runLegiscanBudgetGate — main()'s OWN pre-flight budget gate (brief step 1: getMonthlyQueryUsage +
+// assertUnderBudget BEFORE any live call), extracted as its own function so THIS EXACT composition
+// is directly unit-testable, same "extract for testability without needing process.argv/
+// getClient()" precedent as assertRunUnderBudget/buildSuccessCloseDetail/closeRunOnFailure below.
+//
+// TODO-33 (source split, .superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md,
+// part 2 — the LOAD-BEARING part of that fix): passes source: ALL_LEGISCAN_SOURCES, never the bare
+// SOURCE default. ingest-legiscan-texts.js now writes its own distinct 'legiscan-texts' label, but
+// both CLIs still spend queries against the SAME real LegiScan account/30,000-per-month cap
+// (docs/research/2026-07-28-legiscan-terms.md, Rule 1) — this driver's own pre-flight check must
+// see the TRUE combined total (this run's own past spend AND the OTHER CLI's), never just its own
+// half, or a manual ingest-legiscan-texts.js run could push the real account past its real cap
+// without THIS driver's own refusal ever noticing.
+export async function runLegiscanBudgetGate(client, args) {
+  const plannedQueries = args.datasetFile ? 0 : PLANNED_QUERIES_PER_RUN;
+  return assertRunUnderBudget(client, { plannedQueries, source: ALL_LEGISCAN_SOURCES });
+}
+
 // ---- closeRun payload helpers (CRITICAL 1, final-review-findings.md) ----
 //
 // closeRun (src/lib/db.js) REPLACES detail jsonb wholesale — relied on repo-wide (every CLI driver
 // in this codebase passes closeRun its own complete detail object; changing closeRun to MERGE
 // instead would silently change behavior for every one of them, a much larger blast radius than
 // this bug needs). The actual defect: recordQueryUsage's write-ahead persists
 // detail.queries_used (SNAKE_CASE, what getMonthlyQueryUsage reads) during the run, but main()'s own
 // closeRun call on both success (`{...result.counts, attribution}`) and failure (`{error}`) never
 // included that key at all — result.counts carries `queriesUsed` (CAMELCASE, a different field
 // entirely) — so closeRun's final wholesale replace silently erased the ledger back to 0 on every
@@ -1067,29 +1085,32 @@ async function main() {
   }
 
   const runId = await openRun(client, SOURCE);
   try {
     // Brief step 1: getMonthlyQueryUsage + assertUnderBudget BEFORE any live call. A
     // --dataset-file run spends zero LegiScan queries regardless of outcome, so it plans for 0;
     // every other run plans for the worst case (PLANNED_QUERIES_PER_RUN) since we don't yet know
     // whether the hash gate will skip the getDataset call. This is the ONLY statement between
     // openRun and runLegiscanIngest — a refusal here means runLegiscanIngest (and therefore every
     // live LegiScan call and every DB write it could make) is never reached.
-    const plannedQueries = args.datasetFile ? 0 : PLANNED_QUERIES_PER_RUN;
     // MINOR 2 (Task 9 review, accepted as intentional-conservative, not a bug): a --dataset-file
-    // run still calls assertRunUnderBudget even though plannedQueries=0 here means it can never
-    // itself push usage over the cap — so a month that has ALREADY breached the cap from other
-    // (live) runs still refuses a zero-cost fixture-driven run too, rather than carving out an
-    // exception. Deliberate: refusal semantics stay uniform and simple to reason about (one gate,
-    // no special cases to remember), and it avoids a cap-breached month quietly continuing to run
-    // local-fixture backfills that would normally accompany live catches.
-    await assertRunUnderBudget(client, { plannedQueries });
+    // run still calls the budget gate even though plannedQueries=0 here means it can never itself
+    // push usage over the cap — so a month that has ALREADY breached the cap from other (live) runs
+    // still refuses a zero-cost fixture-driven run too, rather than carving out an exception.
+    // Deliberate: refusal semantics stay uniform and simple to reason about (one gate, no special
+    // cases to remember), and it avoids a cap-breached month quietly continuing to run local-fixture
+    // backfills that would normally accompany live catches.
+    // TODO-33: runLegiscanBudgetGate passes source: ALL_LEGISCAN_SOURCES (this CLI's own 'legiscan'
+    // label AND ingest-legiscan-texts.js's 'legiscan-texts' label, combined) — see that function's
+    // own header comment for why checking against 'legiscan' alone would be dangerous now that the
+    // two CLIs write distinct source labels but still share one real LegiScan account/cap.
+    await runLegiscanBudgetGate(client, args);
 
     const result = await runLegiscanIngest(client, runId, args);
 
     const status = (result.counts.reconciliationFailures === 0 && result.counts.parseFailures === 0) ? 'succeeded' : 'partial';
     await closeRun(client, runId, status, buildSuccessCloseDetail(result.counts));
     console.log(JSON.stringify({
       mode: 'live', run_id: runId, status, source: SOURCE, counts: result.counts,
     }, null, 2));
     if (status !== 'succeeded') process.exitCode = 2;
   } catch (err) {
diff --git a/tests/correct-data.test.js b/tests/correct-data.test.js
index 0524568..9ad451d 100644
--- a/tests/correct-data.test.js
+++ b/tests/correct-data.test.js
@@ -14,20 +14,23 @@ import {
   runCorrectMo1969Dates,
   runCorrectPartyNormalize,
   runCorrectData,
   CANONICAL_MO_2026_SESSION_IDENTIFIER,
   DUPLICATE_MO_2026_SESSION_IDENTIFIER,
   DUP_BILL_MUST_BE_EMPTY_TABLES,
   runMergeMo2026Session,
   runReconcileMo2026Votes,
   runReconcileMo2026VotesStandalone,
   runCorrectMo2026SessionMerge,
+  classifyLegiscanSourceRow,
+  LEGISCAN_TEXTS_ERROR_MARKERS,
+  runCorrectLegiscanSourceSplit,
 } from '../src/cli/correct-data.js';
 
 // Data-corrections CLI (.superpowers/sdd/2026-07-31-data-corrections/brief.md). Two REVERSIBLE
 // production-data corrections (both re-derivable from cached LegiScan datasets / the primary MO
 // Senate journal source), draft-then-apply — this test file proves the dry-run/live orchestration
 // logic entirely against a fake in-memory client; ZERO live DB writes anywhere in this file, and no
 // live run is ever performed from this repo (Lance's own separate explicit word, per the brief).
 
 // ---- fake Supabase-ish client: eq/in/order/limit + select/update/delete, thenable builder ----
 // A single generic in-memory fake (not one bespoke mock per call site) because both corrections
@@ -45,20 +48,24 @@ function makeFakeClient(seed = {}, { forceError = null, afterExecute = null } =
     bills: [],
     votes: [],
     vote_casts: [],
     sessions: [],
     bill_texts: [],
     bill_sponsors: [],
     summaries: [],
     bill_actions: [],
     vote_reconciliation_flags: [],
     legislators: [],
+    // legiscan-source-split (TODO-33) reads this table too — defaulted empty so every EXISTING
+    // 'all' test (none of which seed it) still works as a harmless no-op, not an undefined-table
+    // crash.
+    ingestion_runs: [],
     ...seed,
   };
   for (const t of Object.keys(tables)) tables[t] = tables[t].map((r) => ({ ...r }));
   const calls = [];
   let insertCounter = 0;
 
   function matchesFilters(row, filters) {
     return filters.every((f) => {
       if (f.op === 'eq') return row[f.col] === f.val;
       if (f.op === 'in') return f.vals.includes(row[f.col]);
@@ -1533,10 +1540,211 @@ test('reconcileOneVote (via runReconcileMo2026Votes): a primary (mo-senate-web)
       id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1', result: null,
     })],
   }];
 
   const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });
 
   assert.equal(report.flaggedCount, 0, 'never hard-flags on incomplete primary cast data');
   assert.equal(report.notComparableCount, 1);
   assert.equal(client.tables.vote_reconciliation_flags.length, 0);
 });
+
+// ============================================================================================
+// legiscan-source-split (TODO-33 — .superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/
+// brief.md, part 3): historical `ingestion_runs.source='legiscan'` rows that were actually written
+// by ingest-legiscan-texts.js (before that CLI got its own distinct 'legiscan-texts' label) are
+// relabeled. Classification rule, verified against ALL 54 real live rows at implementation time
+// (48 votes-shape / 2 texts-shape / 4 error-marker / 0 unclassified — exactly the brief's own
+// counts, re-confirmed live, not stale):
+//   - detail.votes is a number, no detail.counts object -> ingest-legiscan.js's OWN shape -> stays
+//     'legiscan'.
+//   - no top-level detail.votes, detail.counts IS an object -> ingest-legiscan-texts.js's OWN shape
+//     -> relabel to 'legiscan-texts'.
+//   - neither shape (a bare {error, queries_used} failure detail) -> classified by an exact,
+//     sourced error-string marker only ingest-legiscan.js's own code paths can produce -> stays
+//     'legiscan'.
+//   - anything matching NONE of the above is NEVER guessed — left as 'legiscan' (today's safe
+//     default) and reported explicitly, never silently folded into "unchanged."
+// ============================================================================================
+
+const votesShapeDetail = () => ({
+  votes: 12, casts: 40, sessions: 1, bills: 5, queriesUsed: 2, attribution: { license: 'CC BY 4.0' },
+});
+const textsShapeDetail = () => ({
+  counts: {
+    billsPlanned: 5, docCacheHits: 2, queriesSpent: 3, inserted: 3,
+  },
+  failures: [],
+  queries_used: 3,
+});
+const insertVotesErrorDetail = () => ({
+  error: 'Error: insertIfAbsent(votes) failed: date/time field value out of range: "0000-00-00"', queries_used: 2,
+});
+const legiscanVotesModuleErrorDetail = () => ({
+  error: 'Error: legiscan-votes: could not write vote_reconciliation_flags row: duplicate key value violates unique constraint "vote_reconciliation_flags_dedup_key"', queries_used: 1,
+});
+const genuinelyUnclassifiableDetail = () => ({
+  error: 'Error: some totally unrelated failure with no recognizable marker', queries_used: 1,
+});
+
+// ---- classifyLegiscanSourceRow (pure) ----
+
+test('classifyLegiscanSourceRow: votes-shape (detail.votes number, no detail.counts object) classifies "legiscan" (unchanged)', () => {
+  assert.equal(classifyLegiscanSourceRow(votesShapeDetail()), 'legiscan');
+});
+
+test('classifyLegiscanSourceRow: texts-shape (no detail.votes, detail.counts IS an object) classifies "legiscan-texts" (relabel)', () => {
+  assert.equal(classifyLegiscanSourceRow(textsShapeDetail()), 'legiscan-texts');
+});
+
+test('classifyLegiscanSourceRow: a bare failure detail carrying the "insertIfAbsent(votes) failed" marker classifies "legiscan" (unchanged)', () => {
+  assert.equal(classifyLegiscanSourceRow(insertVotesErrorDetail()), 'legiscan');
+});
+
+test('classifyLegiscanSourceRow: a bare failure detail carrying the "legiscan-votes:" marker classifies "legiscan" (unchanged)', () => {
+  assert.equal(classifyLegiscanSourceRow(legiscanVotesModuleErrorDetail()), 'legiscan');
+});
+
+test('classifyLegiscanSourceRow: a genuinely unrecognized shape (no votes number, no counts object, no known error marker) is NEVER guessed — returns null', () => {
+  assert.equal(classifyLegiscanSourceRow(genuinelyUnclassifiableDetail()), null);
+});
+
+test('classifyLegiscanSourceRow: null/undefined/empty detail is never guessed — returns null', () => {
+  assert.equal(classifyLegiscanSourceRow(null), null);
+  assert.equal(classifyLegiscanSourceRow(undefined), null);
+  assert.equal(classifyLegiscanSourceRow({}), null);
+});
+
+test('LEGISCAN_TEXTS_ERROR_MARKERS: exactly the two real, sourced markers named in the brief', () => {
+  assert.deepEqual(LEGISCAN_TEXTS_ERROR_MARKERS, ['insertIfAbsent(votes) failed', 'legiscan-votes:']);
+});
+
+// ---- runCorrectLegiscanSourceSplit ----
+
+function legiscanRunRow(id, detail, { source = 'legiscan' } = {}) {
+  return {
+    id, source, status: 'succeeded', started_at: '2026-07-30T00:00:00.000Z', detail,
+  };
+}
+
+test('runCorrectLegiscanSourceSplit: --dry-run classifies all rows correctly and performs ZERO writes, reporting the exact counts a live run would produce', async () => {
+  const seed = {
+    ingestion_runs: [
+      legiscanRunRow('r1', votesShapeDetail()),
+      legiscanRunRow('r2', votesShapeDetail()),
+      legiscanRunRow('r3', textsShapeDetail()),
+      legiscanRunRow('r4', textsShapeDetail()),
+      legiscanRunRow('r5', insertVotesErrorDetail()),
+      legiscanRunRow('r6', legiscanVotesModuleErrorDetail()),
+      legiscanRunRow('r7', genuinelyUnclassifiableDetail()),
+      // a different source entirely — must never be touched/counted at all (scope query only reads source='legiscan')
+      legiscanRunRow('r8', votesShapeDetail(), { source: 'mo-house-xml' }),
+    ],
+  };
+  const client = makeFakeClient(seed);
+  const report = await runCorrectLegiscanSourceSplit(client, { dryRun: true });
+
+  assert.equal(report.seen, 7, 'only source=legiscan rows are in scope — the mo-house-xml row is excluded entirely');
+  assert.equal(report.relabeledToTexts, 2);
+  assert.deepEqual(report.relabeled.map((r) => r.id).sort(), ['r3', 'r4']);
+  assert.equal(report.unchangedLegiscan, 4, '2 votes-shape + 2 error-marker rows');
+  assert.equal(report.unclassified, 1);
+  assert.deepEqual(report.unclassifiedRows.map((r) => r.id), ['r7']);
+  assert.equal(report.failures.length, 0);
+
+  assert.equal(
+    client.calls.some((c) => c.table === 'ingestion_runs' && c.mode === 'update'),
+    false,
+    'dry-run must perform ZERO writes',
+  );
+  // Reconciliation invariant, same convention as runCorrectMoStatus's own "updated always equals
+  // the sum of perCode": every seen row lands in exactly one of the three honest buckets.
+  assert.equal(report.relabeledToTexts + report.unchangedLegiscan + report.unclassified, report.seen);
+});
+
+test('runCorrectLegiscanSourceSplit: LIVE — relabels ONLY the texts-shape rows to \'legiscan-texts\', leaves every other row\'s source untouched, and reproduces the dry-run\'s own counts', async () => {
+  const seed = {
+    ingestion_runs: [
+      legiscanRunRow('r1', votesShapeDetail()),
+      legiscanRunRow('r2', textsShapeDetail()),
+      legiscanRunRow('r3', insertVotesErrorDetail()),
+      legiscanRunRow('r4', genuinelyUnclassifiableDetail()),
+    ],
+  };
+  const client = makeFakeClient(seed);
+  const report = await runCorrectLegiscanSourceSplit(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.relabeledToTexts, 1);
+  assert.equal(report.unchangedLegiscan, 2);
+  assert.equal(report.unclassified, 1);
+
+  const byId = Object.fromEntries(client.tables.ingestion_runs.map((r) => [r.id, r]));
+  assert.equal(byId.r1.source, 'legiscan', 'votes-shape row: untouched');
+  assert.equal(byId.r2.source, 'legiscan-texts', 'texts-shape row: relabeled live');
+  assert.equal(byId.r3.source, 'legiscan', 'error-marker row: untouched');
+  assert.equal(byId.r4.source, 'legiscan', 'genuinely unclassifiable row: left as legiscan, the safe default');
+});
+
+test('runCorrectLegiscanSourceSplit: a genuinely unrelated DB error on ONE relabel is isolated into failures[] — the run continues and still relabels the OTHER texts-shape row', async () => {
+  const seed = {
+    ingestion_runs: [
+      legiscanRunRow('r1', textsShapeDetail()),
+      legiscanRunRow('r2', textsShapeDetail()),
+    ],
+  };
+  const client = makeFakeClient(
+    seed,
+    {
+      forceError: (table, mode, filters) => (
+        table === 'ingestion_runs' && mode === 'update' && filters.some((f) => f.op === 'eq' && f.col === 'id' && f.val === 'r1')
+          ? { message: 'connection reset' }
+          : null
+      ),
+    },
+  );
+  const report = await runCorrectLegiscanSourceSplit(client, { dryRun: false, runId: 'run-1' });
+
+  assert.equal(report.relabeledToTexts, 1, 'r2 still relabels despite r1\'s failure');
+  assert.equal(report.failures.length, 1);
+  assert.equal(report.failures[0].id, 'r1');
+  assert.match(report.failures[0].error, /connection reset/);
+  const byId = Object.fromEntries(client.tables.ingestion_runs.map((r) => [r.id, r]));
+  assert.equal(byId.r1.source, 'legiscan', 'never relabeled — its update failed');
+  assert.equal(byId.r2.source, 'legiscan-texts');
+});
+
+test('runCorrectLegiscanSourceSplit: --limit scopes which rows are processed (deterministic id order), same convention as this file\'s other corrections', async () => {
+  const seed = {
+    ingestion_runs: [
+      legiscanRunRow('r1', textsShapeDetail()),
+      legiscanRunRow('r2', textsShapeDetail()),
+      legiscanRunRow('r3', textsShapeDetail()),
+    ],
+  };
+  const client = makeFakeClient(seed);
+  const report = await runCorrectLegiscanSourceSplit(client, { dryRun: true, limit: 2 });
+  assert.equal(report.seen, 2);
+  assert.deepEqual(report.relabeled.map((r) => r.id).sort(), ['r1', 'r2']);
+});
+
+// ---- wiring: parseArgs + runCorrectData dispatcher ----
+
+test('parseArgs: accepts legiscan-source-split as a <which> value', () => {
+  assert.equal(parseArgs(['legiscan-source-split']).which, 'legiscan-source-split');
+  assert.equal(parseArgs(['legiscan-source-split', '--dry-run']).dryRun, true);
+});
+
+test('runCorrectData: "legiscan-source-split" runs only that correction, and it also participates in "all" (a guarded single-column UPDATE by primary key, same in-place-rewrite risk class as mo-status/party-normalize, never a delete or FK redirect)', async () => {
+  const seed = { ingestion_runs: [legiscanRunRow('r1', textsShapeDetail())] };
+
+  const onlyThis = await runCorrectData(makeFakeClient(seed), { which: 'legiscan-source-split', dryRun: true });
+  assert.ok(onlyThis.legiscanSourceSplit);
+  assert.equal(onlyThis.moStatus, undefined);
+  assert.equal(onlyThis.legiscanSourceSplit.relabeledToTexts, 1);
+
+  const all = await runCorrectData(makeFakeClient({
+    ...seed, bills: [], votes: [], vote_casts: [],
+  }), { which: 'all', dryRun: true });
+  assert.ok(all.legiscanSourceSplit, '"all" must include this correction');
+  assert.ok(all.moStatus);
+  assert.equal(all.failures.length, 0);
+});
diff --git a/tests/ingest-legiscan-cli.test.js b/tests/ingest-legiscan-cli.test.js
index 4c1bdc8..0a836b4 100644
--- a/tests/ingest-legiscan-cli.test.js
+++ b/tests/ingest-legiscan-cli.test.js
@@ -4,26 +4,27 @@ import {
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { crc32 } from 'node:zlib';
 import { test } from 'node:test';
 import assert from 'node:assert/strict';
 import {
   parseLegiscanArgs,
   billSourceUrl, rollCallSourceUrl,
   isLegiscanRegularSession, buildLegiscanSpecialSessionIdentifier,
   ensureLegiscanSessionRow, AmbiguousLegiscanSessionMatchError, LegiscanSessionIdentityConflictError,
-  runLegiscanIngest, resolveDatasetBytes, assertRunUnderBudget, dryRunReportFromDb,
+  runLegiscanIngest, resolveDatasetBytes, assertRunUnderBudget, runLegiscanBudgetGate, dryRunReportFromDb,
   planFromParsedDataset, retractLegiscanVoteIfStored, recordQueryUsage,
   buildSuccessCloseDetail, buildFailureCloseDetail, closeRunOnFailure,
 } from '../src/cli/ingest-legiscan.js';
 import {
   QueryBudgetExceededError, DatasetHashMismatchError, getMonthlyQueryUsage, ATTRIBUTION,
+  ALL_LEGISCAN_SOURCES,
 } from '../src/adapters/legiscan.js';
 import { decodeDatasetZip, extractDatasetFiles } from '../src/adapters/legiscan-dataset.js';
 import { crossCheckAgainstPrimarySource } from '../src/adapters/legiscan-votes.js';
 import { closeRun } from '../src/lib/db.js';
 
 // Task 9 (docs/superpowers/plans/2026-07-29-legiscan-bulk-adapter.md) — the driver that composes
 // Tasks 2/4/5/6/7 into the full dataset-bulk backfill pipeline. Real fixtures throughout (no
 // synthetic dataset payloads for the end-to-end tests) per CONTROLLER RULING 11: session 1579
 // (2018 1st Special Session, ZERO votes) and session 1608 (2018 2nd Special Session, 8 real roll
 // calls) — the exact two fixtures every other adapter test in this plan is built against.
@@ -52,31 +53,33 @@ async function withScratchDirAsync(fn) {
 // once, in one composed pipeline.
 
 function likeToRegExp(pattern) {
   const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   return new RegExp(`^${escaped.replace(/%/g, '.*')}$`);
 }
 
 function applyFilters(rows, filters) {
   return rows.filter((row) => filters.every((f) => {
     if (f.type === 'eq') return row[f.col] === f.val;
+    if (f.type === 'in') return f.vals.includes(row[f.col]);
     if (f.type === 'gte') return row[f.col] >= f.val;
     if (f.type === 'lt') return row[f.col] < f.val;
     if (f.type === 'like') return likeToRegExp(f.pattern).test(String(row[f.col] ?? ''));
     throw new Error(`unsupported filter type ${f.type}`);
   }));
 }
 
 function makeQueryBuilder(getRows, opts = {}) {
   function build(filters) {
     const api = {
       eq: (col, val) => build([...filters, { type: 'eq', col, val }]),
+      in: (col, vals) => build([...filters, { type: 'in', col, vals }]),
       gte: (col, val) => build([...filters, { type: 'gte', col, val }]),
       lt: (col, val) => build([...filters, { type: 'lt', col, val }]),
       like: (col, pattern) => build([...filters, { type: 'like', col, pattern }]),
       order: () => api,
       range: (from, to) => {
         const matched = applyFilters(getRows(), filters);
         return Promise.resolve({ data: matched.slice(from, to + 1).map((r) => ({ ...r })), error: null });
       },
       maybeSingle: async () => {
         const matched = applyFilters(getRows(), filters);
@@ -390,20 +393,24 @@ test('ensureLegiscanSessionRow: a row already carrying a DIFFERENT legiscan_sess
 // functions (already unit-tested in legiscan.js's own suite).
 
 function makeFakeUsageClient(rows) {
   return {
     from(table) {
       assert.equal(table, 'ingestion_runs');
       const predicates = [];
       const builder = {
         select() { return this; },
         eq(col, val) { predicates.push((r) => r[col] === val); return this; },
+        // TODO-33 — the load-bearing budget fix: `.in()` support so a test can prove the array-of-
+        // sources summing path (see the cross-CLI refusal tests below), not just the pre-existing
+        // single-string `.eq()` path.
+        in(col, vals) { predicates.push((r) => vals.includes(r[col])); return this; },
         gte(col, val) { predicates.push((r) => r[col] >= val); return this; },
         lt(col, val) { predicates.push((r) => r[col] < val); return this; },
         order() { return this; },
         range(from, to) {
           const filtered = rows.filter((r) => predicates.every((p) => p(r)));
           return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
         },
       };
       return builder;
     },
@@ -425,20 +432,133 @@ test('assertRunUnderBudget: refuses (QueryBudgetExceededError) when this run\'s
     },
   );
 });
 
 test('assertRunUnderBudget: does not throw with real headroom, and honors an explicit capPerMonth over the env default', async () => {
   const client = makeFakeUsageClient([]);
   const result = await assertRunUnderBudget(client, { plannedQueries: 2, capPerMonth: 100 });
   assert.deepEqual(result, { usage: 0, plannedQueries: 2, capPerMonth: 100 });
 });
 
+// ---- TODO-33 (.superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md, part 2) — THE
+// single most important behavior in this whole fix, per the brief's own explicit instruction to
+// "test this specifically": ingest-legiscan.js and ingest-legiscan-texts.js write DISTINCT
+// ingestion_runs.source labels ('legiscan' / 'legiscan-texts') but spend queries against the SAME
+// real LegiScan account/30,000-per-month cap (docs/research/2026-07-28-legiscan-terms.md, Rule 1,
+// re-read before writing these). Each CLI's own pre-flight budget check must pass
+// source: ALL_LEGISCAN_SOURCES (the combined pair) so it sees the TRUE combined total — never just
+// its own half. These tests prove BOTH directions: CLI A's own check must refuse because of CLI B's
+// spend, and vice versa — and, as a negative control, that checking against ONLY the caller's own
+// source label (the naive/dangerous "just split the key" approach) would have WRONGLY allowed the
+// run to proceed, which is exactly the bug this fix closes. ----
+
+test('CROSS-CLI BUDGET REFUSAL (direction 1): ingest-legiscan-texts.js\'s OWN budget check must refuse '
+  + 'because of ingest-legiscan.js\'s spend, even though the texts CLI\'s own source has spent almost '
+  + 'nothing — proves the combined-array check is load-bearing, not decorative', async () => {
+  const rows = [
+    { id: '1', source: 'legiscan', started_at: new Date().toISOString(), detail: { queries_used: 4990 } },
+    { id: '2', source: 'legiscan-texts', started_at: new Date().toISOString(), detail: { queries_used: 5 } },
+  ];
+  const client = makeFakeUsageClient(rows);
+
+  // The combined check (what the real code must do) correctly refuses: 4990+5=4995 used, +10 planned = 5005 >= 5000.
+  await assert.rejects(
+    () => assertRunUnderBudget(client, { source: ALL_LEGISCAN_SOURCES, plannedQueries: 10, capPerMonth: 5000 }),
+    (err) => {
+      assert.ok(err instanceof QueryBudgetExceededError);
+      assert.equal(err.usage, 4995, 'must see the COMBINED usage across both labels, not just legiscan-texts\' own 5');
+      return true;
+    },
+  );
+
+  // Negative control — the naive "just split the key" bug this fix prevents: checking against ONLY
+  // the texts CLI's own source label would have seen just 5 used and WRONGLY allowed the run to
+  // proceed, blind to ingest-legiscan.js's real 4990. This is the exact scenario the brief calls
+  // "a real risk of exceeding LegiScan's terms" if gotten wrong.
+  await assert.doesNotThrow(
+    () => assertRunUnderBudget(client, { source: 'legiscan-texts', plannedQueries: 10, capPerMonth: 5000 }),
+    'documents the danger: an own-source-only check is blind to the other CLI\'s real spend',
+  );
+});
+
+test('CROSS-CLI BUDGET REFUSAL (direction 2, vice versa): ingest-legiscan.js\'s OWN budget check must '
+  + 'refuse because of ingest-legiscan-texts.js\'s spend, even though ingest-legiscan.js\'s own source '
+  + 'has spent almost nothing', async () => {
+  const rows = [
+    { id: '1', source: 'legiscan-texts', started_at: new Date().toISOString(), detail: { queries_used: 4995 } },
+    { id: '2', source: 'legiscan', started_at: new Date().toISOString(), detail: { queries_used: 3 } },
+  ];
+  const client = makeFakeUsageClient(rows);
+
+  await assert.rejects(
+    () => assertRunUnderBudget(client, { source: ALL_LEGISCAN_SOURCES, plannedQueries: 2, capPerMonth: 5000 }),
+    (err) => {
+      assert.ok(err instanceof QueryBudgetExceededError);
+      assert.equal(err.usage, 4998, 'must see the COMBINED usage, not just legiscan\'s own 3');
+      return true;
+    },
+  );
+
+  // Negative control, same danger, opposite direction: checking against ONLY 'legiscan' would see 3
+  // used and wrongly allow the run to proceed, blind to the texts CLI's real 4995.
+  await assert.doesNotThrow(
+    () => assertRunUnderBudget(client, { source: 'legiscan', plannedQueries: 2, capPerMonth: 5000 }),
+  );
+});
+
+test('CROSS-CLI BUDGET REFUSAL: with real combined headroom, the combined check does NOT refuse either CLI', async () => {
+  const rows = [
+    { id: '1', source: 'legiscan', started_at: new Date().toISOString(), detail: { queries_used: 100 } },
+    { id: '2', source: 'legiscan-texts', started_at: new Date().toISOString(), detail: { queries_used: 50 } },
+  ];
+  const client = makeFakeUsageClient(rows);
+  const resultA = await assertRunUnderBudget(client, { source: ALL_LEGISCAN_SOURCES, plannedQueries: 2, capPerMonth: 5000 });
+  const resultB = await assertRunUnderBudget(client, { source: ALL_LEGISCAN_SOURCES, plannedQueries: 10, capPerMonth: 5000 });
+  assert.equal(resultA.usage, 150);
+  assert.equal(resultB.usage, 150);
+});
+
+// ---- runLegiscanBudgetGate — main()'s OWN pre-flight budget gate, extracted for testability (same
+// "extract for testability without needing process.argv/getClient()" precedent as
+// assertRunUnderBudget/buildSuccessCloseDetail/closeRunOnFailure). TODO-33: THIS is the real
+// production call site that must pass ALL_LEGISCAN_SOURCES — proving it here closes the gap a bare
+// assertRunUnderBudget unit test can't: that main() itself is actually wired to the combined set,
+// not just that the underlying mechanism CAN sum correctly when told to. ----
+
+test('runLegiscanBudgetGate: wired to ALL_LEGISCAN_SOURCES — refuses because of ingest-legiscan-texts.js\'s '
+  + 'own spend even though THIS CLI\'s own "legiscan" usage alone has plenty of headroom (proves the '
+  + 'real main() call site, not just the underlying assertRunUnderBudget mechanism)', async () => {
+  const rows = [
+    { id: '1', source: 'legiscan', started_at: new Date().toISOString(), detail: { queries_used: 10 } },
+    { id: '2', source: 'legiscan-texts', started_at: new Date().toISOString(), detail: { queries_used: 4988 } },
+  ];
+  const client = makeFakeUsageClient(rows);
+  // Live run (no --dataset-file): plannedQueries = PLANNED_QUERIES_PER_RUN = 2. Combined usage
+  // 10+4988=4998, +2 = 5000 >= the DEFAULT_MONTHLY_QUERY_CAP (5000) — refuses at the cap (Minor 2).
+  // An own-source-only view (just 'legiscan'=10) would see 10+2=12, nowhere near the cap.
+  await assert.rejects(
+    () => runLegiscanBudgetGate(client, { session: 1608, datasetFile: null }),
+    (err) => {
+      assert.ok(err instanceof QueryBudgetExceededError);
+      assert.equal(err.usage, 4998, 'must be the COMBINED usage across both source labels');
+      return true;
+    },
+  );
+});
+
+test('runLegiscanBudgetGate: a --dataset-file run plans 0 queries (the local-fixture smoke path spends zero live LegiScan queries) regardless of live headroom', async () => {
+  const client = makeFakeUsageClient([]);
+  const result = await runLegiscanBudgetGate(client, { datasetFile: 'x.json' });
+  assert.equal(result.plannedQueries, 0);
+  assert.equal(result.usage, 0);
+});
+
 // ---- resolveDatasetBytes: hash gate + local cache + write-ahead query accounting (CONTROLLER
 // RULINGS 2, 3, 9) — every live call here is an injected fake, zero real network/DB. -------------
 
 test('resolveDatasetBytes: no ledger row -> fetches live (both queries), writes the ledger + local cache', async () => {
   await withScratchDirAsync(async (dir) => {
     const { client, tables } = makeFakeLegiscanClient();
     const events = [];
     const getDatasetListFn = async () => {
       events.push('getDatasetList');
       return [{ session_id: 1608, dataset_hash: mo2018Special2Dataset.dataset_hash, access_key: 'ak-1608' }];
diff --git a/tests/ingest-legiscan-texts.test.js b/tests/ingest-legiscan-texts.test.js
index 80dd634..010ac23 100644
--- a/tests/ingest-legiscan-texts.test.js
+++ b/tests/ingest-legiscan-texts.test.js
@@ -291,20 +291,24 @@ function makeFakeWriteClient({ rejectVersions = [] } = {}) {
   const runsTable = [];
   return {
     calls,
     runsTable,
     from(table) {
       if (table === 'ingestion_runs') {
         const predicates = [];
         const builder = {
           select() { return this; },
           eq(col, val) { predicates.push((r) => r[col] === val); return this; },
+          // TODO-33 — this CLI's own budget check now passes an ARRAY of sources
+          // (ALL_LEGISCAN_SOURCES), summed via `.in()` — this fake must support it, not just the
+          // pre-existing single-string `.eq()`.
+          in(col, vals) { predicates.push((r) => vals.includes(r[col])); return this; },
           gte(col, val) { predicates.push((r) => r[col] >= val); return this; },
           lt(col, val) { predicates.push((r) => r[col] < val); return this; },
           order() { return this; },
           range(from, to) {
             const filtered = runsTable.filter((r) => predicates.every((p) => p(r)));
             return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
           },
           // maybeSingle — needed by buildFailureCloseDetail/buildAbortCloseDetail's own best-effort
           // re-read of ingestion_runs.detail.queries_used (src/cli/ingest-legiscan.js). Without this,
           // the real function's own try/catch would silently swallow the missing method and default
@@ -592,20 +596,21 @@ test('runIngestLegiscanTexts: a 23505 on insert is tolerated as alreadyPresent,
 });
 
 test('runIngestLegiscanTexts: an unrelated DB error on insert is thrown, never silently swallowed', async () => {
   await withScratchDirAsync(async (textCacheDir) => {
     const client = {
       from: (table) => {
         if (table === 'ingestion_runs') {
           return {
             select() { return this; },
             eq() { return this; },
+            in() { return this; }, // TODO-33 — budget check now may call .in(); this fake ignores filtering either way
             gte() { return this; },
             lt() { return this; },
             order() { return this; },
             range: () => Promise.resolve({ data: [], error: null }),
             update: () => ({ eq: async () => ({ error: null }) }),
           };
         }
         return { insert: async () => ({ error: { code: '500', message: 'connection reset' } }) };
       },
     };
@@ -680,33 +685,77 @@ test('runIngestLegiscanTexts: --priority-only restricts the worklist to passage/
 // ---- budget gate: refuses to start, before any query (binding rule 1) ----
 
 function makeFakeUsageClient(rows) {
   return {
     from(table) {
       assert.equal(table, 'ingestion_runs');
       const predicates = [];
       const builder = {
         select() { return this; },
         eq(col, val) { predicates.push((r) => r[col] === val); return this; },
+        // TODO-33 — this CLI's own budget check now passes ALL_LEGISCAN_SOURCES (an array), summed
+        // via `.in()` — this fake must support it, not just the pre-existing single-string `.eq()`.
+        in(col, vals) { predicates.push((r) => vals.includes(r[col])); return this; },
         gte(col, val) { predicates.push((r) => r[col] >= val); return this; },
         lt(col, val) { predicates.push((r) => r[col] < val); return this; },
         order() { return this; },
         range(from, to) {
           const filtered = rows.filter((r) => predicates.every((p) => p(r)));
           return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
         },
       };
       return builder;
     },
   };
 }
 
+// ---- TODO-33 (.superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md, part 2) —
+// cross-CLI budget refusal, THIS CLI's own real production call site (default assertBudgetFn, not
+// overridden): this CLI must refuse because of ingest-legiscan.js's OWN spend under the 'legiscan'
+// label, even though THIS CLI's own future writes will land under 'legiscan-texts' and have never
+// spent anything yet. Proves the real wiring inside runIngestLegiscanTexts, not just the underlying
+// assertRunUnderBudget mechanism (already proven generically in tests/ingest-legiscan-cli.test.js). ----
+
+test('runIngestLegiscanTexts: CROSS-CLI — the COMBINED usage across BOTH \'legiscan\' (ingest-legiscan.js) '
+  + 'and \'legiscan-texts\' (this CLI\'s own past runs) triggers refusal even though NEITHER source '
+  + 'ALONE is anywhere near the cap — proves the real production call site sums both labels, not just '
+  + 'its own', async () => {
+  await withScratchDirAsync(async (textCacheDir) => {
+    const usageRows = [
+      { id: '1', source: 'legiscan', started_at: new Date().toISOString(), detail: { queries_used: 10 } },
+      { id: '2', source: 'legiscan-texts', started_at: new Date().toISOString(), detail: { queries_used: 89 } },
+    ];
+    // Sanity: neither source alone would refuse at capPerMonth=100 with 1 planned query
+    // (10+1=11 and 89+1=90, both < 100) — only the TRUE combined total (10+89=99, +1=100) does.
+    const writeClient = makeFakeWriteClient();
+    const usageClient = makeFakeUsageClient(usageRows);
+    const client = {
+      from: (table) => (table === 'ingestion_runs' ? usageClient.from(table) : writeClient.from(table)),
+    };
+    let getBillTextCalled = false;
+    const report = await runIngestLegiscanTexts(client, {
+      dryRun: false,
+      runId: 'run-1',
+      cacheDir: textCacheDir,
+      capPerMonth: 100,
+      listFilesFn: () => ['a.json'],
+      readDatasetFn: async () => ONE_BILL_DATASET(),
+      ...baseLoaders(),
+      getBillTextFn: async () => { getBillTextCalled = true; return billTextPayload(); },
+      extractFn: async () => 'text',
+    });
+    assert.equal(getBillTextCalled, false, 'refuses to start — the COMBINED usage must be visible to this CLI\'s own check, not just its own label\'s usage');
+    assert.equal(report.counts.budgetRefused, 1);
+    assert.equal(report.budgetError.usage, 99, 'must be the SUM across both source labels (10+89), not either one alone');
+  });
+});
+
 test('runIngestLegiscanTexts: budget-cap refusal happens BEFORE any query — getBillTextFn is never invoked, nothing is written', async () => {
   await withScratchDirAsync(async (textCacheDir) => {
     const usageRows = [{
       id: '1', source: SOURCE, started_at: new Date().toISOString(), detail: { queries_used: 99 },
     }];
     // A composed fake: budget reads go to the ingestion_runs shape above, bill_texts writes go to
     // the ordinary insert-recording shape — both routed through one `from(table)` dispatcher.
     const writeClient = makeFakeWriteClient();
     const usageClient = makeFakeUsageClient(usageRows);
     const client = {
diff --git a/tests/legiscan-client.test.js b/tests/legiscan-client.test.js
index 994b696..05a1550 100644
--- a/tests/legiscan-client.test.js
+++ b/tests/legiscan-client.test.js
@@ -203,20 +203,25 @@ test('decodeDatasetHashGate: a ledgerRow whose own legiscan_session_id does NOT
 // prove pagination is actually happening; this one can't be fooled by a bare unpaginated .select().
 function makeFakeIngestionRunsClient(rows, { serverCap = 1000 } = {}) {
   const rangeCalls = [];
   return {
     rangeCalls,
     from(table) {
       const predicates = [];
       const builder = {
         select() { return this; },
         eq(col, val) { predicates.push((r) => r[col] === val); return this; },
+        // TODO-33 (.superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md, part 2):
+        // getMonthlyQueryUsage now accepts an ARRAY of sources to sum together (the load-bearing
+        // budget fix — see this file's own new tests below) — this fake must support `.in()`
+        // so a test can actually prove that path, not just the pre-existing single-string `.eq()`.
+        in(col, vals) { predicates.push((r) => vals.includes(r[col])); return this; },
         gte(col, val) { predicates.push((r) => r[col] >= val); return this; },
         lt(col, val) { predicates.push((r) => r[col] < val); return this; },
         order() { return this; },
         range(from, to) {
           rangeCalls.push({ table, from, to });
           const filtered = rows
             .filter((r) => predicates.every((p) => p(r)))
             .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
           const requestedSize = to - from + 1;
           const cappedSize = Math.min(requestedSize, serverCap);
@@ -266,20 +271,64 @@ test('getMonthlyQueryUsage calls through selectAll — a busy month past the 100
     source: 'legiscan',
     started_at: '2026-07-15T00:00:00.000Z',
     detail: { queries_used: 1 },
   }));
   const client = makeFakeIngestionRunsClient(rows); // serverCap defaults to 1000, same as live Supabase
   const usage = await getMonthlyQueryUsage(client, { now: new Date('2026-07-20T00:00:00.000Z') });
   assert.equal(usage, 1500);
   assert.ok(client.rangeCalls.length >= 2, 'must have paged past the first 1000-row server cap');
 });
 
+// ---- TODO-33: source as an ARRAY sums across multiple ingestion_runs.source labels — the
+// load-bearing fix. ingest-legiscan.js and ingest-legiscan-texts.js write DISTINCT source labels
+// ('legiscan' / 'legiscan-texts') but spend queries against the SAME real LegiScan account/30,000-
+// per-month cap; each CLI's own pre-flight budget check must sum BOTH labels together, or each one
+// would only ever see its own half of the real spend. Re-read docs/research/2026-07-28-legiscan-
+// terms.md's Rule 1 before trusting this: "the adapter refuses to start a run that could plausibly
+// exceed a configured monthly cap" — that promise is only honest if the usage being compared
+// against the cap is the REAL total, not one CLI's own partial view of it. ----
+
+test('getMonthlyQueryUsage: source as an array of TWO labels sums BOTH together, excluding a third, unrelated source — the exact TODO-33 budget-summing behavior', async () => {
+  const rows = [
+    { id: '00001', source: 'legiscan', started_at: '2026-07-05T00:00:00.000Z', detail: { queries_used: 100 } },
+    { id: '00002', source: 'legiscan-texts', started_at: '2026-07-06T00:00:00.000Z', detail: { queries_used: 50 } },
+    { id: '00003', source: 'mo-house-xml', started_at: '2026-07-07T00:00:00.000Z', detail: { queries_used: 999 } },
+  ];
+  const client = makeFakeIngestionRunsClient(rows);
+  const usage = await getMonthlyQueryUsage(client, {
+    source: ['legiscan', 'legiscan-texts'], now: new Date('2026-07-20T00:00:00.000Z'),
+  });
+  assert.equal(usage, 150, 'must sum BOTH labels together, and must NOT include the unrelated third source');
+});
+
+test('getMonthlyQueryUsage: a single-element array behaves identically to the bare-string call — same total, same exclusions', async () => {
+  const rows = [
+    { id: '00001', source: 'legiscan', started_at: '2026-07-05T00:00:00.000Z', detail: { queries_used: 100 } },
+    { id: '00002', source: 'legiscan-texts', started_at: '2026-07-06T00:00:00.000Z', detail: { queries_used: 50 } },
+  ];
+  const client = makeFakeIngestionRunsClient(rows);
+  const usageArray = await getMonthlyQueryUsage(client, { source: ['legiscan'], now: new Date('2026-07-20T00:00:00.000Z') });
+  const usageString = await getMonthlyQueryUsage(client, { source: 'legiscan', now: new Date('2026-07-20T00:00:00.000Z') });
+  assert.equal(usageArray, 100);
+  assert.equal(usageString, 100);
+});
+
+test('getMonthlyQueryUsage: REGRESSION — a bare string source is unchanged from before this task (still filters to exactly that one source, still excludes every other source)', async () => {
+  const rows = [
+    { id: '00001', source: 'legiscan', started_at: '2026-07-10T00:00:00.000Z', detail: { queries_used: 7 } },
+    { id: '00002', source: 'legiscan-texts', started_at: '2026-07-10T00:00:00.000Z', detail: { queries_used: 200 } },
+  ];
+  const client = makeFakeIngestionRunsClient(rows);
+  const usage = await getMonthlyQueryUsage(client, { source: 'legiscan', now: new Date('2026-07-20T00:00:00.000Z') });
+  assert.equal(usage, 7, 'the default single-source call must never accidentally pick up the other CLI\'s rows');
+});
+
 test('getMonthlyQueryUsage propagates a selectAll read error rather than swallowing it', async () => {
   const client = {
     from: () => ({
       select() { return this; },
       eq() { return this; },
       gte() { return this; },
       lt() { return this; },
       order() { return this; },
       range: () => Promise.resolve({ data: null, error: { message: 'connection reset' } }),
     }),
