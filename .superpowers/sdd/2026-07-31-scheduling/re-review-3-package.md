# Scoped re-review package — fix round 3 (a6d94bc..6cf47cf)

## Commits
6cf47cf fix: scheduler re-review round 3 — legiscan refresh-gate regression + 3 minors

## Stat
 .superpowers/sdd/2026-07-31-scheduling/progress.md |   37 +
 .../sdd/2026-07-31-scheduling/re-review-package.md | 5174 ++++++++++++++++++++
 .../sdd/2026-07-31-scheduling/task-review.md       |  272 +
 scripts/scheduled-ingest.js                        |  185 +-
 tests/scheduled-ingest.test.js                     |  343 +-
 5 files changed, 5959 insertions(+), 52 deletions(-)

## Full diff (-U10)
diff --git a/.superpowers/sdd/2026-07-31-scheduling/progress.md b/.superpowers/sdd/2026-07-31-scheduling/progress.md
index b6998b4..8ebbab4 100644
--- a/.superpowers/sdd/2026-07-31-scheduling/progress.md
+++ b/.superpowers/sdd/2026-07-31-scheduling/progress.md
@@ -63,10 +63,47 @@ premature invocations; structurally prevented by the scheduler's due-ness gate).
 
 ## Fix round 2 — dispatched (same implementer; controller CONFIRMED the concern as a defect)
 Rulings: per-source timeoutMs (legiscan 75 min = observed max +40%, default stays 480s); lock
 carries maxDurationMs of the in-flight run and stale-reclaim reads IT (fixed 10-min fallback for
 missing/corrupt field) — this is what keeps a 75-min child and the I1 single-instance guarantee
 compatible; timeout-kill closes the child's orphaned 'running' rows honestly (scheduler_kill
 detail, only rows started within the tick); doc gains per-source values + derivation + Windows
 "stop task if longer than" must EXCEED 75 min (recommend do-not-stop; our timeouts are the real
 enforcement). Red-first: 75-min lock not reclaimed at 15 min / 480s lock still is / corrupt lock
 still is; orphan-closing. One scoped re-review will cover rounds 1+2 together.
+
+## Fix round 2 — complete (commit a6d94bc, ℹ fail 0, 2073 tests = 2057 + 16)
+Per-source timeoutMs (legiscan 75 min, default 480s), lock-declared maxDurationMs with corrupt/
+missing-field fallback to fixed 10-min, orphan-'running'-row closing on kill (tick-scoped only),
+doc gains derivations + Windows stop-if-longer-than must exceed 75 min. Implementer's residual
+note (accepted): any fixed timeout can be outgrown by future data volume; the honest-recovery
+path (orphan-close + self-record + loud log) makes that fail-loud-and-retry, not silent — accepted
+as inherent, revisit the number if legiscan durations trend up.
+
+## Scoped re-review (rounds 1+2 together) — dispatched (resumed original opus reviewer)
+Package: re-review-package.md (3e12a1e..a6d94bc, -U10). Scope: per-finding verification of
+C1/C2/I1-I5/M1-M4, round-2 soundness (75-min lock vs +15-min tick reclaim, corrupt-lock fallback,
+tick-scoped orphan-close), new-defect sweep (C1 double-record risk, I4b refresh-gate row
+selection), mechanical suite + dry-run re-verification. SHIP / DO-NOT-SHIP verdict requested for
+the full 4-commit stack as unattended-forever code.
+
+## Scoped re-review (rounds 1+2) — DO NOT SHIP; one new Critical, three new minors
+All 11 original findings verified addressed; round-2 lock mechanics verified sound AT RUNTIME
+(not stale through +76 min on a 76-min declaration, stale at +77; default lock unaffected; all 7
+corrupt-field shapes fall back safely; orphan-close triple-scoped, history untouchable). Suite +
+dry-run independently re-verified (ℹ fail 0, 2073; exit 0, byte-identical count-headers on 6
+tables). Shared-blast-radius honored (zero diff on http.js/db.js/adapters/other CLIs).
+- 🔴 NEW-1 (Critical, REGRESSION): refresh gate reads detail.counts.votes; legiscan spreads
+  counters top-level with no vote key — measured 0/52 real runs trigger; legiscan owns 82.3% of
+  votes → weekly dataset would land with NO aggregate refresh, silently, log claiming healthy.
+- 🟡 NEW-2 no clamp on declared maxDurationMs; NEW-3 updateLockMaxDuration failure ignored
+  (spawns under 10-min placeholder); NEW-4 orphan-close local-clock vs DB-clock skew no-op.
+- NEW-5 (hard-crash strands 'running' row): controller-adjudicated ACCEPTED, documented scope.
+- Task 1 (41936f0 + M4) independently shippable.
+
+## Fix round 3 — dispatched (same implementer; final resume round per SDD)
+Rulings: NEW-1 = per-registry-entry wroteSomething(detail) predicate, FAIL-OPEN on unknown shape
+(over-refresh accepted, silent-never rejected), legiscan predicate derived from real close-detail
+keys and verified vs the 52 live rows, fixture tests from real detail rows for all 5 sources,
+fix the :378-388 comment. NEW-2 = 2h ceiling → default beyond. NEW-3 = can't-record → don't
+spawn (log, release, exit 0). NEW-4 = 5-min skew grace + written safety argument (≥30-min
+intervals make pre-tick capture impossible) or DB-derived now(). Next: scoped re-review round 3.
diff --git a/.superpowers/sdd/2026-07-31-scheduling/re-review-package.md b/.superpowers/sdd/2026-07-31-scheduling/re-review-package.md
new file mode 100644
index 0000000..5856f78
--- /dev/null
+++ b/.superpowers/sdd/2026-07-31-scheduling/re-review-package.md
@@ -0,0 +1,5174 @@
+# Scoped re-review package — fix rounds 1+2 (3e12a1e..a6d94bc)
+
+## Commits
+a6d94bc fix: scheduler review round 2 — per-source timeouts, lock-declared duration, orphan-close
+9a4eb66 fix: scheduler review round 1 — C1 starvation, C2 doc honesty, I1-I5, M1-M4
+
+## Stat
+ .superpowers/sdd/2026-07-31-scheduling/progress.md |   72 +
+ .../sdd/2026-07-31-scheduling/review-package.md    | 1755 ++++++++++++++++++++
+ .../sdd/2026-07-31-scheduling/task-review.md       |  426 +++++
+ docs/SCHEDULED_INGESTION.md                        |  179 +-
+ scripts/scheduled-ingest.js                        |  750 +++++++--
+ src/cli/summarize.js                               |   11 +
+ src/cli/verify.js                                  |   10 +
+ tests/scheduled-ingest.test.js                     |  861 +++++++++-
+ tests/summarize-cli.test.js                        |    8 +-
+ tests/verifier.test.js                             |   10 +-
+ 10 files changed, 3851 insertions(+), 231 deletions(-)
+
+## Full diff (-U10)
+diff --git a/.superpowers/sdd/2026-07-31-scheduling/progress.md b/.superpowers/sdd/2026-07-31-scheduling/progress.md
+new file mode 100644
+index 0000000..b6998b4
+--- /dev/null
++++ b/.superpowers/sdd/2026-07-31-scheduling/progress.md
+@@ -0,0 +1,72 @@
++# SDD ledger — plan: .superpowers/sdd/2026-07-31-scheduling/brief.md (brief-driven, no separate plan file)
++
++Controller: session 8ecd5d8c. Both tasks approved by Lance 2026-07-31 ("add the spend gate /
++build the schedule ingestion"). BASE de2bf54.
++
++## Implementer report (sonnet, single serialized dispatch)
++- Task 1 commit 41936f0 (spend gates SUMMARIZE_RUN_APPROVED / VERIFY_RUN_APPROVED)
++- Task 2 commit 3e12a1e (scripts/scheduled-ingest.js + docs/SCHEDULED_INGESTION.md + npm run schedule:ingest)
++- Suite: 2025 pass / 0 fail (baseline 1975 + 50 new). Live-DB verification via --dry-run only.
++- schtasks NOT run (correct — registration is Lance's draft-then-apply step).
++
++## Implementer concerns + controller verification
++1. ~~"TODO 25 feeder is not in this scheduler's registry"~~ — **WRONG, controller-corrected.**
++   The feeder is `mo-senate-web`: ingest-mo-senate.js:472 insertIfAbsent's its OWN session row
++   ("2026 Regular Session (MO Senate journals)", legiscan_session_id NULL) and keys its bills to
++   it. Verified live: both 2026 rows exist, NULL one is the senate-journal one. The scheduler
++   invokes that same CLI, so registration CONTINUES feeding the split until TODO 25's merge fix.
++   Neutral vs today (the manual loop does the same), but docs must not claim otherwise.
++2. legiscan --session resolved from sessions.legiscan_session_id (currently 2239), skip-on-fail.
++   REVIEW QUESTION: with two 2026-named rows (one NULL), is the resolution deterministic and
++   NULL-proof?
++3. us-congress delta = scheduler-computed forward window (max known roll + 10) — implementer's
++   own inference, flagged by them as most-uncertain. Review hard: boundedness, idempotency,
++   404 handling, limiter use, interval floor.
++4. "Wrote anything" gating the aggregate refresh is a deliberate over-refresh proxy. Acceptable
++   direction (stale charts were a real user-visible defect); reviewer sanity-check only.
++
++## Task review (opus, adversarial; full text: task-review.md)
++- Task 1 spec ✅ (ships as-is). Task 2 spec ❌ (C2 docs-honesty) + quality ❌ (C1).
++- Mechanical: reviewer ran suite itself (ℹ fail 0, 2025 pass), dry-run exit 0 with byte-identical
++  before/after count-headers on 6 tables, commit hashes match diff.
++- C1 (Critical): ingest.js networks BEFORE openRun → persistent congress.gov failure writes no run
++  row → us-congress stays most-overdue → picked EVERY tick forever, starving MO+legiscan. Live on
++  day one (us-congress 91h overdue at review time).
++- C2 (Critical): SCHEDULED_INGESTION.md claimed scheduler unrelated to TODO-25 split — false
++  (controller-proven; reviewer independently re-proved).
++- I1 lock release without ownership check; I2 no spawnSync/fetch timeouts; I3 Promise.all kills
++  tick on one lookup rejection; I4 tail-404 'partial' = permanent noise + unconditional hourly
++  aggregate refresh; I5 us-senate source missing from registry entirely.
++- M1 UTC log naming vs doc; M2 1MB maxBuffer misreport; M3 lookups run under --only/--dry-run;
++  M4 gate messages lack gloss.js's cost-estimate line.
++- Review answers: A) LegiScan resolver NULL-proof by unique(jurisdiction_id,identifier) +
++  identifier='261' predicate — cannot pick the TODO-25 row. B) forward-window inference sound,
++  selectAll-paginated (not 1000-capped), bounded/idempotent/404-tolerant/limiter'd/1h-floored.
++  C) failed — doc overclaims; code comments clean.
++
++## Fix round 1 — dispatched (resumed original implementer)
++All of C1, C2, I1-I5, M1-M4 with controller rulings: C1 = scheduler-side honest attempt row
++(status 'failed', scheduler_attempt detail) advancing the shared durable cooldown signal;
++C2 = neutral-vs-today rewrite; I1 = nonce ownership check; I2 = spawnSync ≤10min +
++AbortSignal.timeout, http.js untouched; I3 = allSettled + skip-with-reason; I4 = read child's run
++row → tail-404 partial logged healthy + refresh only on >0 written; I5 = add us-senate mirroring
++its 4 prior runs. Red-first tests required for C1/I1/I3/I4-gate. M4 is the only permitted Task-1
++touch.
++
++## Fix round 1 — complete (commit 9a4eb66, ℹ fail 0, 2057 tests = 2025 + 32)
++All C1/C2/I1-I5/M1-M4 landed per rulings. Implementer's empirical self-check surfaced a real
++follow-on: legiscan runs vs the target session took 449.3s/475.7s against the I2-ruled 480s
++budget (1-7% margin), outlier 3168.5s; a timeout-kill strands the CLI's pre-opened 'running' row
++AND repeats daily (24h interval) — weekly dataset could never land. mo-house 1800.0s-multiple
++"outliers" adjudicated false alarm (enforceDurableCooldown sleeping out the old manual loop's
++premature invocations; structurally prevented by the scheduler's due-ness gate).
++
++## Fix round 2 — dispatched (same implementer; controller CONFIRMED the concern as a defect)
++Rulings: per-source timeoutMs (legiscan 75 min = observed max +40%, default stays 480s); lock
++carries maxDurationMs of the in-flight run and stale-reclaim reads IT (fixed 10-min fallback for
++missing/corrupt field) — this is what keeps a 75-min child and the I1 single-instance guarantee
++compatible; timeout-kill closes the child's orphaned 'running' rows honestly (scheduler_kill
++detail, only rows started within the tick); doc gains per-source values + derivation + Windows
++"stop task if longer than" must EXCEED 75 min (recommend do-not-stop; our timeouts are the real
++enforcement). Red-first: 75-min lock not reclaimed at 15 min / 480s lock still is / corrupt lock
++still is; orphan-closing. One scoped re-review will cover rounds 1+2 together.
+diff --git a/.superpowers/sdd/2026-07-31-scheduling/review-package.md b/.superpowers/sdd/2026-07-31-scheduling/review-package.md
+new file mode 100644
+index 0000000..de67a0b
+--- /dev/null
++++ b/.superpowers/sdd/2026-07-31-scheduling/review-package.md
+@@ -0,0 +1,1755 @@
++# Review package — spend gates + scheduled ingestion (de2bf54..3e12a1e)
++
++## Commits
++3e12a1e feat: durable, OS-scheduled ingestion (scripts/scheduled-ingest.js)
++41936f0 feat: mechanical spend gates on summarize.js and verify.js
++
++## Stat
++ .superpowers/sdd/2026-07-31-scheduling/brief.md | 114 +++++
++ docs/SCHEDULED_INGESTION.md                     | 155 +++++++
++ package.json                                    |   3 +-
++ scripts/scheduled-ingest.js                     | 546 ++++++++++++++++++++++++
++ src/cli/summarize.js                            |  34 +-
++ src/cli/verify.js                               |  31 ++
++ src/lib/errors.js                               |  32 ++
++ tests/lib.test.js                               |  51 ++-
++ tests/scheduled-ingest.test.js                  | 449 +++++++++++++++++++
++ tests/summarize-cli.test.js                     |  23 +-
++ tests/verifier.test.js                          |  23 +-
++ 11 files changed, 1456 insertions(+), 5 deletions(-)
++
++## Full diff (-U10)
++diff --git a/.superpowers/sdd/2026-07-31-scheduling/brief.md b/.superpowers/sdd/2026-07-31-scheduling/brief.md
++new file mode 100644
++index 0000000..c3a2c63
++--- /dev/null
+++++ b/.superpowers/sdd/2026-07-31-scheduling/brief.md
++@@ -0,0 +1,114 @@
+++# Task brief — spend gates + scheduled ingestion
+++
+++Two tasks, **in this order**, as two separate commits. Both approved by Lance 2026-07-31
+++("add the spend gate / build the schedule ingestion").
+++
+++---
+++
+++## TASK 1 — mechanical spend gates on the two ungated model-calling CLIs
+++
+++`src/cli/gloss.js` (line ~234), `src/cli/extract-terms.js` and `src/cli/golden.js` (~184) all carry
+++a mechanical env gate. **`src/cli/summarize.js` and `src/cli/verify.js` do not** — both default
+++`dryRun: false`, both call `getAnthropicClient()` and bill Lance's account, and both are exposed as
+++`npm run summarize` / `npm run verify`. This is the unfinished half of CLAUDE.md's own policy
+++("Mechanical enforcement exists where possible — extend that pattern to new model-calling tools")
+++and it sits against Lance's standing spend hold.
+++
+++- Add the SAME guard-clause shape `gloss.js` uses (read it and mirror it — do not invent a new
+++  pattern, do not refactor the existing ones). Env var names: `SUMMARIZE_RUN_APPROVED` for
+++  summarize.js, `VERIFY_RUN_APPROVED` for verify.js.
+++- The gate must fire **before any Anthropic client is constructed or any bill is fetched for
+++  sending**, and must NOT fire when `--dry-run` is passed (dry runs cost nothing and must stay
+++  freely runnable — that is what makes the gate acceptable rather than obstructive).
+++- Error message must state, in the gloss.js voice: this run costs real money, Lance requires
+++  explicit per-run approval, set `<VAR>=yes` to proceed.
+++- Typed error class consistent with the file's existing conventions.
+++- TDD: gate blocks a live run; `--dry-run` is unaffected; `<VAR>=yes` permits it. Fake the client —
+++  **no live API call in tests, ever.**
+++
+++---
+++
+++## TASK 2 — `scripts/scheduled-ingest.js`: real, durable, OS-scheduled ingestion
+++
+++**The problem it solves.** All recurring ingestion to date has been a bash loop inside a Claude
+++Code session — it dies when the session ends and is finite. Lance asked directly whether data stays
+++fresh; the honest answer today is no. This is TODO build-queue item 13, flagged a priority
+++2026-07-28 and never built.
+++
+++### Critical design constraint (do not miss this)
+++
+++The ingest CLIs **do not exit when their ToU cooldown has not elapsed — they SLEEP until it has**
+++(`enforceDurableCooldown`, `src/cli/ingest-mo-senate.js:446`; same pattern in ingest-mo-house.js).
+++A scheduler that blindly invokes them every N minutes will stack overlapping sleeping processes.
+++
+++So the scheduler must **decide for itself** what is due:
+++- Reuse the EXPORTED `remainingCooldownMs(lastStartedAtIso, minIntervalMs)` — import it, do not
+++  reimplement the arithmetic.
+++- Query `ingestion_runs` for each source's latest `started_at` (the same durable signal the CLIs
+++  use), compute remaining cooldown, and **only invoke a CLI whose cooldown has fully elapsed**.
+++- Invoke **at most ONE source per run** — keeps each invocation short and bounded.
+++
+++### Behavior
+++
+++Entry: `node --env-file=.env scripts/scheduled-ingest.js [--dry-run] [--only <source>]`
+++
+++1. **Single-instance lock.** A lock file under `.superpowers/artifacts/` carrying pid + ISO
+++   timestamp. If a live lock exists → log "already running", exit 0 (NOT an error: an overlapping
+++   tick is normal and must never surface as a scheduler failure). Stale-lock detection: a lock older
+++   than a documented max run duration is reclaimed with a logged warning. Always release the lock,
+++   including on throw (try/finally).
+++2. **Pick the single most-overdue due source**, from this registry — each entry declares its source
+++   key, its min interval, and the command to run:
+++   - `mo-senate-web` — `src/cli/ingest-mo-senate.js --year <current> --limit 1`,
+++     `MO_SENATE_MIN_INTERVAL_MS` (30 min, published ToU)
+++   - `mo-house-xml` — `src/cli/ingest-mo-house.js --limit 1`, `MO_HOUSE_MIN_INTERVAL_MS`
+++     (30 min, **house.mo.gov's own published terms** — never shorten this)
+++   - `us-congress` — the federal roll-call delta (read `src/cli/ingest.js` to find the correct
+++     current-Congress invocation; federal votes are the one stream with NO scheduled ingestion
+++     today, so new federal votes simply never arrive). Congress.gov's polite limiter already
+++     exists; pick a conservative interval (≥1 hour) and comment the reasoning.
+++   - `legiscan` — the dataset-hash check. ⛔ **Suspension-level rule:** `dataset_hash` comparison is
+++     MANDATORY before any `getDataset` download. `ingest-legiscan.js` already implements this
+++     correctly — invoke it, never re-implement the gate. Datasets are weekly; interval ≥24h.
+++   **Restriction on mo-house-xml (TODO 31, do not violate):** current-session ingestion ONLY.
+++   `mo_house_id` is declared table-wide `unique` (0005) against a current-only roster, so a
+++   multi-era/historical House backfill silently misattributes a successor's votes to their
+++   predecessor. The scheduler must never pass a historical session/year to the House CLI. State
+++   this in a comment at the registry entry.
+++3. **Run it as a child process** (`node --env-file=.env <cli> …`), capture stdout/stderr, and record
+++   the outcome. A CLI failure is logged and reported, never crashes the scheduler run.
+++4. **After a run that actually wrote anything**, invoke `scripts/refresh-aggregates.js` — this is
+++   the STANDING PRACTICE from the ledger (every loop batch ends with an aggregate refresh, else the
+++   profile charts silently drift behind the vote lists; that drift was a real user-visible defect
+++   on 2026-07-31). Skip it when nothing was written.
+++5. **Log** to a dated file under `.superpowers/artifacts/scheduler-logs/` (gitignored) AND to
+++   stdout: timestamp, which source was chosen and why (or "nothing due"), the CLI's honest counts,
+++   and whether aggregates were refreshed. Lance must be able to read one file and know it is alive.
+++6. **NEVER call a model.** This script is ingestion only. Add an explicit comment saying so — it is
+++   the one automated, unattended thing in the repo, and it must remain incapable of spending money.
+++7. `--dry-run`: report what WOULD run and each source's remaining cooldown; take the lock, make zero
+++   fetches, zero writes.
+++8. Exit code: 0 for success and for "nothing due"/"already running"; non-zero only on a real error,
+++   so Task Scheduler's own history is meaningful.
+++
+++### Registration is LANCE'S step (draft-then-apply)
+++
+++Do NOT register a scheduled task, and do not run `schtasks`. Registering something that runs forever
+++on his machine is his call. Instead produce `docs/SCHEDULED_INGESTION.md` containing:
+++- what the scheduler does, what it will never do (no model calls, no ToU violations)
+++- the exact `schtasks /create …` command (or Task Scheduler UI steps) to run it every 15 minutes —
+++  15 min is deliberately shorter than every source interval so nothing is ever missed while the
+++  per-source cooldowns still do the real gating
+++- how to verify it is alive (the log file, `npm run status`'s freshness block)
+++- how to pause/remove it
+++- an explicit note that the MO cadences are published ToU and must not be shortened
+++
+++Add `npm run schedule:ingest` to package.json.
+++
+++## Constraints for both tasks
+++
+++Bare `node --test` from repo root; baseline **1975** stays green. TDD red-first. Typed errors.
+++Honest counts. selectAll/pagination discipline for any multi-row read (the 1000-row cap has bitten
+++this repo repeatedly). No live API calls and no live DB writes from tests. Commits end with:
+++
+++Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
++diff --git a/docs/SCHEDULED_INGESTION.md b/docs/SCHEDULED_INGESTION.md
++new file mode 100644
++index 0000000..666d395
++--- /dev/null
+++++ b/docs/SCHEDULED_INGESTION.md
++@@ -0,0 +1,155 @@
+++# Scheduled ingestion — `scripts/scheduled-ingest.js`
+++
+++The first thing in this repo designed to run **unattended, on Lance's machine, forever**, with no
+++human watching a single invocation. Everything about its design follows from that one fact. This
+++doc is what he needs to register it (his own step — an agent never runs `schtasks`) and to keep an
+++eye on it afterward.
+++
+++## What it does
+++
+++Each invocation:
+++
+++1. Takes a single-instance lock (`.superpowers/artifacts/scheduler.lock.json`). If another
+++   invocation is already holding it, this one logs `already-running` and exits 0 — that is a
+++   **normal**, expected outcome (see cadence below), never a failure.
+++2. Checks all four ingestion sources' real due-ness by querying `ingestion_runs` for each one's
+++   last `started_at` and comparing against its own minimum interval — the *same* durable,
+++   cross-process signal the ingest CLIs' own cooldown check (`enforceDurableCooldown`) already
+++   relies on. **It never blindly invokes a CLI.**
+++3. Picks the single **most overdue** due source (the one that has gone longest since it last ran)
+++   and runs it as a short child process: `node --env-file=.env <cli> --limit 1` (or the equivalent
+++   for that source — see the registry table below). At most one source per tick.
+++4. If that run actually wrote anything, refreshes the vote aggregates
+++   (`scripts/refresh-aggregates.js`) — the same standing practice every ingest batch has always
+++   followed, so the profile charts never silently drift behind the vote lists.
+++5. Logs one entry — to stdout and to a dated file — recording what it checked, what it chose (or
+++   why nothing was due), the CLI's own honest counts, and whether aggregates were refreshed.
+++
+++## What it will never do
+++
+++- **Never calls a model.** It imports no Anthropic client, no `lib/summarizer.js`, no
+++  `lib/verifier.js` — nothing that can bill Lance's account. It only ever spawns the four
+++  ingestion CLIs below and `scripts/refresh-aggregates.js`. This is enforced by the import list,
+++  not just a comment; verify by inspection if this file ever changes.
+++- **Never violates a published rate limit.** The MO Senate and MO House intervals below are
+++  imported directly from the adapters that already encode senate.mo.gov's / house.mo.gov's real
+++  published terms — they are **not environment-overridable**, so a typo'd env var cannot shorten
+++  them. The two intervals this script chooses itself (us-congress, legiscan) are
+++  environment-overridable but mechanically floored at the values below: an override can only make
+++  them *more* conservative, never less.
+++- **Never runs a MO House historical/multi-era backfill.** `mo_house_id` is a table-wide unique
+++  constraint (migration 0005) against the *current* roster only — passing a historical year/session
+++  to the House CLI would silently misattribute a successor's votes to their predecessor (TODO item
+++  31). The registry entry for `mo-house-xml` passes `--limit 1` only, nothing else, permanently.
+++- **Never stacks overlapping processes.** The single-instance lock (step 1 above) and the
+++  due-ness check (step 2) both have to agree before anything runs.
+++- **Never guesses a LegiScan session id.** If `sessions.legiscan_session_id` isn't on file for the
+++  current MO session, the `legiscan` source is reported `resolvable: false` and skipped, with the
+++  reason logged — never an "most recent session" heuristic. See *Known gap* below for why.
+++
+++## ⚠️ The MO cadences are published Terms of Service, not our own caution
+++
+++`MO_SENATE_MIN_INTERVAL_MS` and `MO_HOUSE_MIN_INTERVAL_MS` (30 minutes each) are
+++**senate.mo.gov's and house.mo.gov's own published rate limits**. They are imported verbatim from
+++`src/adapters/mo-senate-web.js` / `src/adapters/mo-house-xml.js` — the same constants the ingest
+++CLIs' own `enforceDurableCooldown` enforces — and are not exposed as environment variables at all.
+++**Do not shorten these**, in this file or anywhere else. house.mo.gov's ToU caps automated pulls at
+++once per 30 minutes; that is why the House backfill was never a volume strategy (see
+++`docs/DATA_INVENTORY.md`/CHATLOG for "the text unlock").
+++
+++## The registry
+++
+++| Source | Command | Interval | Why |
+++|---|---|---|---|
+++| `mo-senate-web` | `ingest-mo-senate.js --year <current> --limit 1` | 30 min | senate.mo.gov's published terms (imported, not configurable) |
+++| `mo-house-xml` | `ingest-mo-house.js --limit 1` | 30 min | house.mo.gov's published terms (imported, not configurable) — **current session only, never `--session`** |
+++| `us-congress` | `ingest.js --source us-congress --year <current> --rolls <lo>-<hi>` | ≥1 hour (`US_CONGRESS_MIN_INTERVAL_MS`, default 1h) | Congress.gov has its own polite limiter already; this is our own conservative check-frequency choice. `<lo>-<hi>` is computed each tick from the highest US House roll number already on file — a small forward window past it. Every roll in that window that doesn't exist yet 404s harmlessly (recorded, non-fatal); every roll that already exists is a no-op. This is the one federal stream that had **no** scheduled ingestion before this — new House roll calls simply never arrived. |
+++| `legiscan` | `ingest-legiscan.js --session <resolved id>` | ≥24 hours (`LEGISCAN_MIN_INTERVAL_MS`, default 24h) | Datasets refresh weekly (Sunday 5am ET); `ingest-legiscan.js`'s own `dataset_hash` gate (⛔ suspension-level LegiScan rule) makes a same-dataset tick cheap. `<resolved id>` comes from `sessions.legiscan_session_id` for the current MO session — see *Known gap* below if this ever reports `resolvable: false`. |
+++
+++`US_CONGRESS_MIN_INTERVAL_MS` / `LEGISCAN_MIN_INTERVAL_MS` can be raised via `.env` if Lance ever
+++wants these to run less often; any value below the defaults above is silently floored back up to
+++them.
+++
+++## Registering it (Lance's step — never run `schtasks` from an agent)
+++
+++Run every 15 minutes — deliberately shorter than every source's own interval above, so a tick is
+++never more than ~15 minutes late; the per-source cooldowns above do the real gating, not this
+++number.
+++
+++**Command line** (adjust the `node.exe` path if `where node` gives something different; using
+++absolute paths throughout means Task Scheduler's working directory doesn't matter):
+++
+++```
+++schtasks /create /tn "VisibleGov Scheduled Ingestion" ^
+++  /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-ingest.js" ^
+++  /sc minute /mo 15 ^
+++  /st 00:00 ^
+++  /ru "%USERNAME%" ^
+++  /f
+++```
+++
+++- `/sc minute /mo 15` — repeats every 15 minutes, indefinitely (no end date unless you add `/ed`).
+++- `/ru "%USERNAME%"` runs it as your own account, only while you're logged on (no password
+++  needed). If you want it to run even while logged out, use the Task Scheduler GUI instead
+++  (Actions tab → this same command; General tab → "Run whether user is logged on or not," which
+++  will prompt for your password once).
+++- `/f` overwrites a prior registration with the same name — safe to re-run this command if you
+++  ever change the schedule.
+++
+++**GUI equivalent**, if preferred: Task Scheduler → Create Task → General: name it; Triggers → New →
+++"On a schedule" → Daily, repeat task every **15 minutes** for a duration of **Indefinitely**;
+++Actions → New → Program: `C:\Program Files\nodejs\node.exe`, Arguments:
+++`--env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-ingest.js`, Start in:
+++`F:\VisibleGov` (redundant with the absolute `--env-file` path, but harmless to set).
+++
+++## How to verify it is alive
+++
+++Two independent signals, on purpose — one from the scheduler's own perspective, one from the data's:
+++
+++1. **The log file.** `.superpowers/artifacts/scheduler-logs/YYYY-MM-DD.log` (gitignored, one entry
+++   per tick). A healthy scheduler shows an entry roughly every 15 minutes, alternating between
+++   `nothing-due`, `already-running`, and occasional `live` runs as each source's cooldown elapses.
+++   `tail`/open today's file; if the last entry is more than ~20 minutes old, the scheduled task
+++   itself has stopped firing (check Task Scheduler's history, not this repo).
+++2. **`npm run status`'s freshness block.** Reads `public_freshness` directly from the database —
+++   independent of whether the scheduler *ran*, it shows whether data actually *arrived*. If the
+++   log looks healthy but freshness doesn't move, something downstream (not the scheduler) is
+++   wrong.
+++3. Windows Task Scheduler's own History tab for "VisibleGov Scheduled Ingestion" shows exit codes
+++   over time — 0 is normal (success, nothing due, or already-running); non-zero is a real error
+++   (e.g. `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` missing) and is the one case worth investigating.
+++
+++Manual checks any time, safe to run for real (read-only, zero writes, zero external fetches):
+++
+++```
+++npm run schedule:ingest -- --dry-run
+++npm run schedule:ingest -- --dry-run --only legiscan
+++```
+++
+++## How to pause / remove it
+++
+++```
+++schtasks /change /tn "VisibleGov Scheduled Ingestion" /disable   # pause (keeps the registration)
+++schtasks /change /tn "VisibleGov Scheduled Ingestion" /enable    # resume
+++schtasks /delete /tn "VisibleGov Scheduled Ingestion" /f         # remove entirely
+++```
+++
+++If the machine ever loses power mid-run, the lock file self-heals: a lock older than 10 minutes
+++(`MAX_RUN_DURATION_MS`) is automatically reclaimed on the next tick, with a warning logged. You can
+++also delete `.superpowers/artifacts/scheduler.lock.json` by hand at any time if you want a clean
+++next tick immediately rather than waiting out the 10 minutes.
+++
+++## Known gap: `legiscan` may report `resolvable: false`
+++
+++The scheduler looks up the current MO session's `legiscan_session_id` from the `sessions` table
+++(keyed off `ingest-mo-house.js`'s own `DEFAULT_MO_HOUSE_SESSION`) rather than guessing — see
+++`resolveLegiscanSessionId`'s own comment in `scripts/scheduled-ingest.js`. As of this writing that
+++resolves correctly (session `261` → LegiScan session `2239`). If it ever stops resolving, the
+++`legiscan` source is skipped honestly (logged, `resolvable: false`, with a reason) rather than
+++guessing — it does not block the other three sources.
+++
+++Separately, **TODO.md item 25** documents a real, currently-open duplicate-MO-session defect
+++(session `'2026'` vs `'261'`) caused by a *different*, non-scheduler source (not `mo-house-xml`,
+++whose default session — `261` — is already the correct one). This scheduler's registry does not
+++touch whatever is producing that duplicate; it's flagged here only so it isn't mistaken for
+++something this script caused.
++diff --git a/package.json b/package.json
++index e5de763..d2d7b70 100644
++--- a/package.json
+++++ b/package.json
++@@ -14,21 +14,22 @@
++     "ingest:legiscan": "node --env-file=.env src/cli/ingest-legiscan.js",
++     "enrich:federal-bills": "node --env-file=.env src/cli/enrich-federal-bills.js",
++     "summarize": "node --env-file=.env src/cli/summarize.js",
++     "verify": "node --env-file=.env src/cli/verify.js",
++     "extract-terms": "node --env-file=.env src/cli/extract-terms.js",
++     "gloss": "node --env-file=.env src/cli/gloss.js",
++     "auto-publish:glossary": "node --env-file=.env src/cli/auto-publish-glossary.js",
++     "golden": "node --env-file=.env src/cli/golden.js",
++     "link:persons": "node --env-file=.env src/cli/link-persons.js",
++     "refresh:aggregates": "node --env-file=.env scripts/refresh-aggregates.js",
++-    "review": "node --env-file=.env src/review/server.js"
+++    "review": "node --env-file=.env src/review/server.js",
+++    "schedule:ingest": "node --env-file=.env scripts/scheduled-ingest.js"
++   },
++   "dependencies": {
++     "@anthropic-ai/sdk": "^0.115.0",
++     "@supabase/supabase-js": "^2.45.0",
++     "fast-xml-parser": "^4.4.0",
++     "pdfjs-dist": "6.1.200",
++     "yauzl": "3.4.0"
++   },
++   "devDependencies": {
++     "jsdom": "^29.1.1"
++diff --git a/scripts/scheduled-ingest.js b/scripts/scheduled-ingest.js
++new file mode 100644
++index 0000000..26787bb
++--- /dev/null
+++++ b/scripts/scheduled-ingest.js
++@@ -0,0 +1,546 @@
+++// scripts/scheduled-ingest.js — the first unattended, OS-scheduled process in this repo (TODO
+++// build-queue item 13). Every prior "recurring" ingestion was a bash loop inside a Claude Code
+++// session: it died the moment the session ended, so data staleness was real. This script is meant
+++// to be registered with Windows Task Scheduler (registration itself is Lance's own step — see
+++// docs/SCHEDULED_INGESTION.md — never run schtasks from an agent) and to run forever, unattended,
+++// with no human watching a single invocation. That changes the design bar entirely:
+++//
+++//   - NEVER CALLS A MODEL. This file imports no Anthropic client, no lib/summarizer.js, no
+++//     lib/verifier.js — nothing that can bill Lance's account. It only ever spawns the four
+++//     read-mostly ingestion CLIs below plus scripts/refresh-aggregates.js. This comment, and the
+++//     import list actually enforcing it, are the whole guarantee — verify by inspection any time
+++//     this file changes.
+++//   - INCAPABLE OF VIOLATING A PUBLISHED RATE LIMIT. The two MO cadences (MO_SENATE_MIN_INTERVAL_MS,
+++//     MO_HOUSE_MIN_INTERVAL_MS) are imported verbatim from the adapters that already encode
+++//     senate.mo.gov's/house.mo.gov's real published terms — never redefined here, never
+++//     env-overridable, so a typo'd environment variable cannot shorten them. The two intervals
+++//     this script DOES get to choose (us-congress, legiscan) are env-overridable but mechanically
+++//     floored at the brief's own conservative minimum (envIntervalMs) — configurable upward only.
+++//   - INCAPABLE OF STACKING OVERLAPPING PROCESSES. A single-instance lock file
+++//     (.superpowers/artifacts/scheduler.lock.json) is required before anything else happens; a
+++//     live lock means "already running," logged and exited 0 — an overlapping tick is expected
+++//     (Task Scheduler is recommended at a 15-min cadence, shorter than every source's own
+++//     interval, see docs/SCHEDULED_INGESTION.md) and must never read as a scheduler failure.
+++//   - The CRITICAL constraint from the brief: the ingest CLIs do not exit when their ToU cooldown
+++//     hasn't elapsed — they SLEEP until it has (enforceDurableCooldown, ingest-mo-senate.js:446;
+++//     same pattern in ingest-mo-house.js). A scheduler that blindly invoked them every tick would
+++//     stack sleeping processes. So THIS script decides due-ness itself, BEFORE ever launching a
+++//     child, by importing the exported remainingCooldownMs and querying ingestion_runs directly —
+++//     the same durable, cross-process signal the CLIs' own enforceDurableCooldown reads. A CLI is
+++//     only ever launched once its own cooldown has fully elapsed; in normal operation the child's
+++//     own enforceDurableCooldown check should therefore always see remaining<=0 immediately and
+++//     never actually sleep.
+++//   - Leaves an honest, dated log a human can read to confirm it is alive (see writeLog / npm run
+++//     status's freshness block).
+++//
+++// Entry: node --env-file=.env scripts/scheduled-ingest.js [--dry-run] [--only <source>]
+++
+++import { spawnSync } from 'node:child_process';
+++import {
+++  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync,
+++} from 'node:fs';
+++import path from 'node:path';
+++import { fileURLToPath } from 'node:url';
+++
+++import { getClient, selectAll } from '../src/lib/db.js';
+++// Reused, not reimplemented (brief's own explicit instruction): the exact arithmetic every ingest
+++// CLI's own enforceDurableCooldown already relies on. Both ingest-mo-senate.js and
+++// ingest-mo-house.js export an identical copy (the latter ported from the former, see that file's
+++// own comment) — either is a correct, generic (lastStartedAtIso, minIntervalMs, now) function, not
+++// specific to MO Senate; imported once here and reused for all four registry sources.
+++import { remainingCooldownMs, formatCooldownWait } from '../src/cli/ingest-mo-senate.js';
+++import { MO_SENATE_MIN_INTERVAL_MS } from '../src/adapters/mo-senate-web.js';
+++import { MO_HOUSE_MIN_INTERVAL_MS, DEFAULT_MO_HOUSE_SESSION } from '../src/adapters/mo-house-xml.js';
+++
+++const __dirname = path.dirname(fileURLToPath(import.meta.url));
+++// Computed from this file's own location, NEVER from process.cwd() — Task Scheduler's default
+++// working directory is not guaranteed to be the repo root (docs/SCHEDULED_INGESTION.md recommends
+++// setting "Start in" anyway, but this script does not depend on it either way).
+++export const REPO_ROOT = path.join(__dirname, '..');
+++const ARTIFACTS_DIR = path.join(REPO_ROOT, '.superpowers', 'artifacts');
+++const LOCK_PATH = path.join(ARTIFACTS_DIR, 'scheduler.lock.json');
+++const LOG_DIR = path.join(ARTIFACTS_DIR, 'scheduler-logs');
+++
+++// Stale-lock reclaim threshold. A normal invocation is one child CLI at --limit 1 (cooldown
+++// already confirmed elapsed by this script, so the child's own enforceDurableCooldown should not
+++// actually sleep) plus, sometimes, one refresh-aggregates.js call — realistically seconds, well
+++// under a minute. 10 minutes is a generous ceiling for slow network/retries while staying safely
+++// below the 15-minute recommended Task Scheduler tick, so a genuinely crashed/killed prior run
+++// cannot wedge the schedule for more than one missed tick.
+++export const MAX_RUN_DURATION_MS = 10 * 60 * 1000;
+++
+++const ONE_HOUR_MS = 60 * 60 * 1000;
+++const ONE_DAY_MS = 24 * ONE_HOUR_MS;
+++
+++// envIntervalMs: the mechanical floor behind US_CONGRESS_MIN_INTERVAL_MS/LEGISCAN_MIN_INTERVAL_MS
+++// below — these two intervals are OUR OWN conservative policy choice (Congress.gov and LegiScan
+++// publish no per-request cadence the way house.mo.gov/senate.mo.gov do), so, unlike the two MO
+++// constants above, they are env-overridable. But an override can only raise the interval, never
+++// lower it below the floor the brief itself specifies (>=1h / >=24h) — a bad or typo'd env value
+++// can only make this script MORE conservative, never less.
+++export function envIntervalMs(envVar, defaultMs, floorMs) {
+++  const raw = Number(process.env[envVar]);
+++  const configured = Number.isFinite(raw) && raw > 0 ? raw : defaultMs;
+++  return Math.max(configured, floorMs);
+++}
+++
+++// us-congress: no published rate limit exists to violate (Congress.gov's own polite limiter is
+++// already enforced inside src/adapters/us-congress.js's congressLimiter) — >=1h is this script's
+++// own conservative choice, since new House roll calls arrive on a legislative-day cadence, not
+++// continuously; there is no benefit to checking more often than that.
+++export const US_CONGRESS_MIN_INTERVAL_MS = envIntervalMs('US_CONGRESS_MIN_INTERVAL_MS', ONE_HOUR_MS, ONE_HOUR_MS);
+++// legiscan: datasets refresh weekly (Sunday 5am ET per docs/research/2026-07-28-legiscan-terms.md)
+++// — >=24h is deliberately far more frequent than strictly necessary, still cheap because
+++// ingest-legiscan.js's own dataset_hash gate (⛔ suspension-level rule, decodeDatasetHashGate)
+++// makes a same-dataset invocation a single cheap list-check, not a real download.
+++export const LEGISCAN_MIN_INTERVAL_MS = envIntervalMs('LEGISCAN_MIN_INTERVAL_MS', ONE_DAY_MS, ONE_DAY_MS);
+++
+++// Matches the hardcoded convention already used throughout this repo (ingest.js,
+++// backfill-federal-names.js, enrich-federal-bills.js all hardcode 119) — no dynamic
+++// "current congress" formula exists anywhere in this codebase; update all four together when the
+++// 120th Congress convenes.
+++export const US_CONGRESS_CONGRESS = 119;
+++// Small, conservative forward-delta window past the highest roll number already on file — see
+++// resolveUsCongressRollWindow's own comment for why this is safe to overlap/overshoot.
+++export const US_CONGRESS_ROLL_WINDOW = 10;
+++
+++const SOURCE_KEYS = ['mo-senate-web', 'mo-house-xml', 'us-congress', 'legiscan'];
+++
+++// ---- pure: args ----
+++
+++export function parseArgs(argv) {
+++  const out = { dryRun: false, only: null };
+++  let i = 0;
+++  while (i < argv.length) {
+++    const key = argv[i];
+++    if (key === '--dry-run') {
+++      out.dryRun = true;
+++      i += 1;
+++      continue;
+++    }
+++    if (key === '--only') {
+++      out.only = argv[i + 1];
+++      if (!SOURCE_KEYS.includes(out.only)) {
+++        throw new Error(`unknown source: ${out.only} (expected one of ${SOURCE_KEYS.join(', ')})`);
+++      }
+++      i += 2;
+++      continue;
+++    }
+++    throw new Error(`unknown flag: ${key}`);
+++  }
+++  return out;
+++}
+++
+++// ---- pure: single-instance lock ----
+++
+++export function isLockStale(lock, nowMs, maxRunDurationMs = MAX_RUN_DURATION_MS) {
+++  const startedMs = Date.parse(lock.startedAt);
+++  if (!Number.isFinite(startedMs)) return true; // unparseable timestamp — never trusted, treated as stale
+++  return nowMs - startedMs > maxRunDurationMs;
+++}
+++
+++// acquireLock: an atomic create ('wx' — fails with EEXIST if the file already exists) is tried
+++// first, closing the check-then-act race a plain existsSync()-then-writeFileSync() pair would
+++// leave open between two schedulers starting within milliseconds of each other. Unlikely at a
+++// 15-minute tick cadence, but free to close. Falls back to reading the existing lock only on
+++// EEXIST; a corrupt/unreadable lock is treated exactly like a stale one (reclaimed + the caller
+++// logs a warning) rather than either trusting it blindly or crashing — a half-written lock from a
+++// killed process must not permanently wedge every future tick.
+++export function acquireLock(lockPath = LOCK_PATH, { now = Date.now(), maxRunDurationMs = MAX_RUN_DURATION_MS } = {}) {
+++  mkdirSync(path.dirname(lockPath), { recursive: true });
+++  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() }, null, 2);
+++
+++  try {
+++    writeFileSync(lockPath, payload, { flag: 'wx' });
+++    return { acquired: true, reason: 'fresh' };
+++  } catch (err) {
+++    if (err.code !== 'EEXIST') throw err;
+++  }
+++
+++  let existing;
+++  try {
+++    existing = JSON.parse(readFileSync(lockPath, 'utf8'));
+++  } catch {
+++    existing = { startedAt: new Date(0).toISOString(), pid: null, corrupt: true };
+++  }
+++  if (!isLockStale(existing, now, maxRunDurationMs)) {
+++    return { acquired: false, reason: 'already-running', lock: existing };
+++  }
+++  // Stale: a plain overwrite is fine here — the prior owner is already established to be long
+++  // past any plausible run duration, so losing a 'wx'-style race at this exact point is not a
+++  // realistic concern.
+++  writeFileSync(lockPath, payload);
+++  return { acquired: true, reason: 'reclaimed-stale', staleLock: existing };
+++}
+++
+++export function releaseLock(lockPath = LOCK_PATH) {
+++  if (existsSync(lockPath)) unlinkSync(lockPath);
+++}
+++
+++// ---- pure: due-ness + selection ----
+++
+++// computeSourceDueness: remainingMs comes straight from the shared, imported remainingCooldownMs
+++// — never reimplemented. elapsedMs (Infinity for a source with no prior run at all) is the
+++// separate "how overdue" ranking signal pickMostOverdue uses below; remainingMs alone cannot rank
+++// two already-due sources against each other since Math.max(0, ...) clamps both to 0.
+++export function computeSourceDueness(entry, now) {
+++  const remainingMs = remainingCooldownMs(entry.lastStartedAtIso, entry.minIntervalMs, now);
+++  const elapsedMs = entry.lastStartedAtIso ? now - Date.parse(entry.lastStartedAtIso) : Infinity;
+++  return {
+++    ...entry, remainingMs, elapsedMs, due: remainingMs <= 0,
+++  };
+++}
+++
+++// pickMostOverdue: among due AND resolvable entries (legiscan with no legiscan_session_id on file
+++// is due but never resolvable — see buildRegistry), the one that has gone longest since its last
+++// (or ever) run wins. A source with zero prior runs (elapsedMs=Infinity) outranks everything else
+++// — seeding an unseen source is the most urgent thing to do. Ties keep registry order (reduce
+++// never replaces `best` on an equal elapsedMs).
+++export function pickMostOverdue(entries) {
+++  const candidates = entries.filter((e) => e.due && e.resolvable);
+++  if (candidates.length === 0) return null;
+++  return candidates.reduce((best, e) => (e.elapsedMs > best.elapsedMs ? e : best));
+++}
+++
+++// ---- pure: us-congress roll-delta window ----
+++
+++const US_HOUSE_ROLL_RE = /^us-house-\d+-\d+-(\d+)$/;
+++
+++export function parseUsHouseRoll(sourceKey) {
+++  const m = US_HOUSE_ROLL_RE.exec(String(sourceKey ?? ''));
+++  return m ? Number(m[1]) : null;
+++}
+++
+++export function computeRollWindow(maxKnownRoll, windowSize = US_CONGRESS_ROLL_WINDOW) {
+++  const base = Number.isFinite(maxKnownRoll) && maxKnownRoll > 0 ? maxKnownRoll : 0;
+++  return { lo: base + 1, hi: base + windowSize };
+++}
+++
+++// ---- pure: child-CLI output ----
+++
+++export function parseChildOutput(stdout) {
+++  try {
+++    return { parsed: JSON.parse(String(stdout ?? '').trim()), parseError: null };
+++  } catch (err) {
+++    return { parsed: null, parseError: err.message };
+++  }
+++}
+++
+++// runWroteSomething: deliberately generous, not a byte-exact "were rows actually inserted" oracle
+++// — the four registry CLIs' count shapes are heterogeneous (mo-senate/mo-house's document-shaped
+++// counts vs. us-congress's legislators/bills/votes/casts vs. legiscan's own), so this reads the one
+++// field every one of them shares (mode/status, the same repo-wide main() convention every CLI in
+++// this codebase follows). A 'live' run that reached succeeded/partial opened and closed a real
+++// ingestion_runs row — it genuinely attempted writes, even on a tick where every upsert happened to
+++// be a no-op. Treating that as "wrote something" means the aggregate refresh below sometimes runs
+++// when nothing actually changed (cheap, idempotent SQL) rather than risk the opposite: skipping a
+++// refresh that WAS needed, which is the exact user-visible chart-drift defect from 2026-07-31 that
+++// refresh-aggregates.js's own header describes this standing practice as preventing.
+++export function runWroteSomething(parsedOutput) {
+++  if (!parsedOutput || parsedOutput.mode !== 'live') return false;
+++  return parsedOutput.status === 'succeeded' || parsedOutput.status === 'partial';
+++}
+++
+++// ---- DB-facing helpers ----
+++
+++export async function queryLatestStartedAt(client, source) {
+++  const { data, error } = await client
+++    .from('ingestion_runs')
+++    .select('started_at')
+++    .eq('source', source)
+++    .order('started_at', { ascending: false })
+++    .limit(1)
+++    .maybeSingle();
+++  if (error) throw new Error(`ingestion_runs lookup failed for source=${source}: ${error.message}`);
+++  return data ? data.started_at : null;
+++}
+++
+++// resolveLegiscanSessionId: reuses mo-house-xml.js's OWN DEFAULT_MO_HOUSE_SESSION as "the current
+++// MO session identifier" — never a second, separately-maintained notion of "current" — and looks
+++// up that session's legiscan_session_id column directly by key. Returns null (never a guess, never
+++// an ORDER BY/"most recent" heuristic over `sessions`) when that row or its legiscan_session_id
+++// doesn't exist yet. TODO.md item 25 documents a real, currently-open duplicate-MO-session defect
+++// in this exact area of the data model; guessing here is exactly the kind of thing that could make
+++// it worse. The registry (below) treats a null result as "not configured" and skips legiscan
+++// honestly rather than risk feeding that defect a second way.
+++export async function resolveLegiscanSessionId(client) {
+++  const { data, error } = await client
+++    .from('sessions')
+++    .select('legiscan_session_id')
+++    .eq('jurisdiction_id', 'mo-legislature')
+++    .eq('identifier', DEFAULT_MO_HOUSE_SESSION)
+++    .maybeSingle();
+++  if (error) throw new Error(`sessions lookup failed for legiscan_session_id: ${error.message}`);
+++  return data && data.legiscan_session_id != null ? data.legiscan_session_id : null;
+++}
+++
+++// resolveUsCongressRollWindow: src/cli/ingest.js has no built-in delta mode (--rolls is a
+++// caller-chosen explicit range) and this source has never had scheduled ingestion (brief) — this
+++// is the scheduler's own minimal, honest "what's new" computation: the highest US House roll
+++// number already on file for this congress+year, plus a small forward window. Every candidate roll
+++// in that window that doesn't exist yet simply 404s inside collectUsCongress (a typed, non-fatal
+++// SourceFetchError recorded in failures[] — see ingest.js's own per-roll try/catch) and every roll
+++// that already exists is a harmless insertIfAbsent no-op (votes.source_key is the conflict key) —
+++// so overlapping an already-ingested roll, or probing one that hasn't happened yet, is always
+++// safe, just occasionally wasted requests against Congress.gov's own already-polite limiter.
+++// Routed through selectAll (project law: no bare .select() on a multi-row table — this table is
+++// already ~10,000+ rows overall, well past Supabase's 1000-row cap, even though this query's own
+++// WHERE clause keeps any single congress+year's result set small).
+++export async function resolveUsCongressRollWindow(client, {
+++  congress = US_CONGRESS_CONGRESS, year, windowSize = US_CONGRESS_ROLL_WINDOW,
+++} = {}) {
+++  const prefix = `us-house-${congress}-${year}-`;
+++  const { data, error } = await selectAll(client, 'votes', 'source_key', {
+++    filter: (q) => q.eq('jurisdiction_id', 'us-congress').like('source_key', `${prefix}%`),
+++  });
+++  if (error) throw new Error(`votes lookup failed for us-congress roll window: ${error.message}`);
+++  const maxRoll = (data ?? [])
+++    .map((r) => parseUsHouseRoll(r.source_key))
+++    .filter((n) => n !== null)
+++    .reduce((max, n) => Math.max(max, n), 0);
+++  return computeRollWindow(maxRoll, windowSize);
+++}
+++
+++// ---- registry ----
+++//
+++// Each entry: { key, minIntervalMs, lastStartedAtIso, resolvable, unresolvedReason, scriptPath,
+++// cliArgs }. scriptPath is repo-root-relative, matching every "node --env-file=.env <path>" npm
+++// script already in package.json.
+++export async function buildRegistry(client, { now = Date.now(), year = new Date(now).getFullYear() } = {}) {
+++  const [moSenateLast, moHouseLast, usCongressLast, legiscanLast, legiscanSessionId, rollWindow] = await Promise.all([
+++    queryLatestStartedAt(client, 'mo-senate-web'),
+++    queryLatestStartedAt(client, 'mo-house-xml'),
+++    queryLatestStartedAt(client, 'us-congress'),
+++    queryLatestStartedAt(client, 'legiscan'),
+++    resolveLegiscanSessionId(client),
+++    resolveUsCongressRollWindow(client, { year }),
+++  ]);
+++
+++  return [
+++    {
+++      key: 'mo-senate-web',
+++      minIntervalMs: MO_SENATE_MIN_INTERVAL_MS,
+++      lastStartedAtIso: moSenateLast,
+++      resolvable: true,
+++      unresolvedReason: null,
+++      scriptPath: 'src/cli/ingest-mo-senate.js',
+++      cliArgs: ['--year', String(year), '--limit', '1'],
+++    },
+++    {
+++      key: 'mo-house-xml',
+++      minIntervalMs: MO_HOUSE_MIN_INTERVAL_MS,
+++      lastStartedAtIso: moHouseLast,
+++      resolvable: true,
+++      unresolvedReason: null,
+++      scriptPath: 'src/cli/ingest-mo-house.js',
+++      // RESTRICTION (TODO 31 — do not violate): current-session ingestion ONLY. mo_house_id is
+++      // declared table-wide `unique` (migration 0005) against a current-only roster, so a
+++      // historical/multi-era backfill would silently misattribute a successor's votes to their
+++      // predecessor. NEVER add --session (or any year/era flag) here — --limit 1 alone lets the
+++      // CLI fall through to its own DEFAULT_MO_HOUSE_SESSION, which is the current session.
+++      cliArgs: ['--limit', '1'],
+++    },
+++    {
+++      key: 'us-congress',
+++      minIntervalMs: US_CONGRESS_MIN_INTERVAL_MS,
+++      lastStartedAtIso: usCongressLast,
+++      resolvable: true,
+++      unresolvedReason: null,
+++      scriptPath: 'src/cli/ingest.js',
+++      cliArgs: ['--source', 'us-congress', '--year', String(year), '--rolls', `${rollWindow.lo}-${rollWindow.hi}`],
+++    },
+++    {
+++      key: 'legiscan',
+++      minIntervalMs: LEGISCAN_MIN_INTERVAL_MS,
+++      lastStartedAtIso: legiscanLast,
+++      resolvable: legiscanSessionId != null,
+++      unresolvedReason: legiscanSessionId != null
+++        ? null
+++        : `no legiscan_session_id on file for MO session '${DEFAULT_MO_HOUSE_SESSION}' (sessions.legiscan_session_id) — `
+++          + 'see TODO.md item 25; not guessed, skipped honestly until resolved',
+++      scriptPath: 'src/cli/ingest-legiscan.js',
+++      // ⛔ dataset_hash comparison happens INSIDE ingest-legiscan.js (decodeDatasetHashGate) —
+++      // never re-implemented here. This registry entry only ever supplies --session; the
+++      // suspension-level gate itself is entirely the CLI's own responsibility, invoked, not
+++      // reimplemented.
+++      cliArgs: legiscanSessionId != null ? ['--session', String(legiscanSessionId)] : [],
+++    },
+++  ];
+++}
+++
+++// ---- process orchestration ----
+++
+++function defaultSpawn(command, args, options) {
+++  return spawnSync(command, args, { encoding: 'utf8', ...options });
+++}
+++
+++// runChildCli: every ingestion CLI in this repo (and refresh-aggregates.js) speaks the same "API"
+++// — one console.log(JSON.stringify(...)) as its terminal line to stdout, progress on stderr, the
+++// same repo-wide main() convention verified across all four registry sources. No CLI in this repo
+++// exports its main() (checked before writing this file), so a child process — not an in-process
+++// import — is the only way to invoke one. spawnFn is injectable so tests never launch a real
+++// subprocess against real network/DB state; the real default really does spawn `node
+++// --env-file=.env <scriptPath> ...cliArgs`, matching every "node --env-file=.env ..." npm script.
+++export function runChildCli(scriptPath, cliArgs, { cwd = REPO_ROOT, spawnFn = defaultSpawn } = {}) {
+++  const result = spawnFn(process.execPath, ['--env-file=.env', scriptPath, ...cliArgs], { cwd });
+++  if (result.error) {
+++    // The child could not even be launched (e.g. a bad path) — unlike a child that launched and
+++    // reported its own typed failures, this IS a real scheduler-level error.
+++    throw new Error(`could not launch ${scriptPath}: ${result.error.message}`);
+++  }
+++  const { parsed, parseError } = parseChildOutput(result.stdout);
+++  return {
+++    scriptPath, cliArgs, exitStatus: result.status, stdout: result.stdout, stderr: result.stderr, parsed, parseError,
+++  };
+++}
+++
+++// ---- logging ----
+++
+++function nowIso() {
+++  return new Date().toISOString();
+++}
+++
+++// writeLog: appends the SAME pretty-printed JSON this script prints to stdout into a dated file
+++// under .superpowers/artifacts/scheduler-logs/ (gitignored, matches the existing cached-artifact
+++// subdirectory convention) — "Lance must be able to read one file and know it is alive" (brief).
+++// One entry per invocation; every branch of main() below funnels through this single function so
+++// the file and stdout can never drift out of sync with each other.
+++function writeLog(entry) {
+++  mkdirSync(LOG_DIR, { recursive: true });
+++  const day = entry.timestamp.slice(0, 10); // YYYY-MM-DD
+++  const logPath = path.join(LOG_DIR, `${day}.log`);
+++  const block = `=== ${entry.timestamp} ===\n${JSON.stringify(entry, null, 2)}\n\n`;
+++  appendFileSync(logPath, block);
+++  console.log(JSON.stringify(entry, null, 2));
+++}
+++
+++// ---- main ----
+++
+++async function main() {
+++  const args = parseArgs(process.argv.slice(2));
+++  const now = Date.now();
+++
+++  const lockResult = acquireLock(LOCK_PATH, { now });
+++  if (!lockResult.acquired) {
+++    // NOT an error — an overlapping tick is normal (Task Scheduler's 15-min cadence is shorter
+++    // than every source's own interval by design) and must never surface as a scheduler failure.
+++    writeLog({
+++      timestamp: nowIso(),
+++      mode: 'already-running',
+++      note: `a live lock (pid ${lockResult.lock.pid}, started ${lockResult.lock.startedAt}) already exists — skipping this tick`,
+++    });
+++    return;
+++  }
+++
+++  const lockReclaimed = lockResult.reason === 'reclaimed-stale' ? lockResult.staleLock : null;
+++  if (lockReclaimed) {
+++    console.error(
+++      `[${nowIso()}] WARNING: reclaimed a stale lock (pid ${lockReclaimed.pid}, started `
+++        + `${lockReclaimed.startedAt}, older than ${formatCooldownWait(MAX_RUN_DURATION_MS)}) — a prior run may have crashed without releasing it`,
+++    );
+++  }
+++
+++  try {
+++    const client = getClient();
+++    if (!client) {
+++      writeLog({
+++        timestamp: nowIso(),
+++        mode: 'blocked',
+++        reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — cannot compute source due-ness without reading ingestion_runs',
+++        lockReclaimed,
+++      });
+++      process.exitCode = 1;
+++      return;
+++    }
+++
+++    const year = new Date(now).getFullYear();
+++    const registry = await buildRegistry(client, { now, year });
+++    const scoped = args.only ? registry.filter((e) => e.key === args.only) : registry;
+++    const withDueness = scoped.map((e) => computeSourceDueness(e, now));
+++    const chosen = pickMostOverdue(withDueness);
+++
+++    const sourcesSummary = withDueness.map((e) => ({
+++      key: e.key,
+++      due: e.due,
+++      remainingMs: e.remainingMs,
+++      remainingHuman: e.remainingMs > 0 ? formatCooldownWait(e.remainingMs) : '0s',
+++      resolvable: e.resolvable,
+++      unresolvedReason: e.unresolvedReason,
+++      lastStartedAt: e.lastStartedAtIso,
+++    }));
+++
+++    if (!chosen) {
+++      writeLog({
+++        timestamp: nowIso(),
+++        mode: 'nothing-due',
+++        chosen: null,
+++        reason: args.only ? `'${args.only}' is not due yet (or not configured)` : 'no registry source is currently due',
+++        sources: sourcesSummary,
+++        lockReclaimed,
+++      });
+++      return;
+++    }
+++
+++    const reason = `most overdue due source (elapsed ${chosen.elapsedMs === Infinity ? 'never run' : formatCooldownWait(chosen.elapsedMs)}, `
+++      + `min interval ${formatCooldownWait(chosen.minIntervalMs)})`;
+++
+++    if (args.dryRun) {
+++      writeLog({
+++        timestamp: nowIso(),
+++        mode: 'dry-run',
+++        chosen: chosen.key,
+++        reason,
+++        wouldRun: { scriptPath: chosen.scriptPath, cliArgs: chosen.cliArgs },
+++        sources: sourcesSummary,
+++        note: 'zero fetches, zero writes — --dry-run',
+++        lockReclaimed,
+++      });
+++      return;
+++    }
+++
+++    const childResult = runChildCli(chosen.scriptPath, chosen.cliArgs);
+++    const wroteSomething = runWroteSomething(childResult.parsed);
+++
+++    // Standing practice from the ledger (brief): every ingest batch ends with an aggregate
+++    // refresh, else public_position_totals/public_party_alignment silently drift behind the vote
+++    // lists — a real user-visible defect on 2026-07-31. Skipped only when nothing was written
+++    // (runWroteSomething), and its own outcome NEVER overrides the primary ingest run's already-
+++    // recorded result below, mirroring summarize.js's persistReferencedTermsGracefully: a
+++    // secondary, best-effort follow-up must never make an otherwise-successful tick look failed.
+++    let aggregatesResult = null;
+++    if (wroteSomething) {
+++      const refreshResult = runChildCli('scripts/refresh-aggregates.js', []);
+++      aggregatesResult = {
+++        exitStatus: refreshResult.exitStatus, parsed: refreshResult.parsed, parseError: refreshResult.parseError,
+++      };
+++    }
+++
+++    writeLog({
+++      timestamp: nowIso(),
+++      mode: 'live',
+++      chosen: chosen.key,
+++      reason,
+++      result: {
+++        exitStatus: childResult.exitStatus,
+++        mode: childResult.parsed?.mode ?? null,
+++        status: childResult.parsed?.status ?? null,
+++        counts: childResult.parsed?.counts ?? null,
+++        failures: childResult.parsed?.failures ?? null,
+++        parseError: childResult.parseError,
+++      },
+++      aggregatesRefreshed: wroteSomething,
+++      aggregatesResult,
+++      sources: sourcesSummary,
+++      lockReclaimed,
+++    });
+++  } finally {
+++    // Always released, including on throw — an overlapping tick after a genuine crash would
+++    // otherwise be permanently blocked until MAX_RUN_DURATION_MS's stale-reclaim kicks in.
+++    releaseLock(LOCK_PATH);
+++  }
+++}
+++
+++const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
+++if (invokedDirectly) {
+++  main().catch((err) => { console.error(err); process.exitCode = 1; });
+++}
++diff --git a/src/cli/summarize.js b/src/cli/summarize.js
++index 93d6597..30cfaca 100644
++--- a/src/cli/summarize.js
+++++ b/src/cli/summarize.js
++@@ -1,12 +1,12 @@
++ import { getClient, openRun, closeRun, insertIfAbsent, isMissingRelationError } from '../lib/db.js';
++-import { SourceFetchError } from '../lib/errors.js';
+++import { SourceFetchError, assertRunApproved, RunNotApprovedError } from '../lib/errors.js';
++ import { billTypeSlug } from '../adapters/us-congress.js';
++ import { parseTextVersions, pickTextUrl, stripHtml, sha256, fetchBillTextVersions, fetchTextBody } from '../adapters/us-congress-text.js';
++ import {
++   getAnthropicClient, summarizeBill, MODEL, PROMPT_VERSION,
++   OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
++ } from '../lib/summarizer.js';
++ import {
++   persistReferencedTerms, GLOSSARY_TERMS_TABLE, SUMMARY_TERMS_TABLE,
++ } from '../lib/glossary-terms.js';
++ 
++@@ -242,20 +242,36 @@ export async function createDraftSummary(client, runId, { bill, textRow, anthrop
++   // above (near-zero added cost, per the design doc's own "rides in the same call" framing), so
++   // realize that design instead of letting them go straight to the floor and requiring a second,
++   // separately-billed extract-terms.js pass to rediscover them later.
++   return persistReferencedTermsGracefully(client, runId, { bill, summaryId: data.id, referencedTerms: json.referenced_terms ?? [] });
++ }
++ 
++ function isTypedFailure(err) {
++   return FAILURE_TYPES.some((T) => err instanceof T);
++ }
++ 
+++// checkSummarizeApproval (task 1, 2026-07-31): the mechanical per-run spend gate summarize.js
+++// lacked — this file bills Lance's Anthropic account (bill summary authoring) and previously ran
+++// with no gate at all, against the owner's standing spend hold and against CLAUDE.md's own stated
+++// policy ("Mechanical enforcement exists where possible — extend that pattern to new
+++// model-calling tools"). Thin, exported wrapper around the shared assertRunApproved (lib/errors.js)
+++// so this exact wiring — env var name, action wording — is directly testable without needing a
+++// fake DB/Anthropic client at all. See main() below for the call site: fires after the --dry-run
+++// branch has already returned and before getAnthropicClient() is called, so it blocks before any
+++// Anthropic client is constructed and before any bill text is fetched for sending (ensureText/
+++// createDraftSummary only run further down, inside the try block).
+++export function checkSummarizeApproval(envValue) {
+++  assertRunApproved(envValue, {
+++    envVar: 'SUMMARIZE_RUN_APPROVED', action: 'summarizing', detail: 'bill summary authoring',
+++  });
+++}
+++
++ // ---- main ----
++ 
++ async function main() {
++   const args = parseArgs(process.argv.slice(2));
++   const client = getClient();
++   if (!client) {
++     console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
++     process.exitCode = 1;
++     return;
++   }
++@@ -268,20 +284,36 @@ async function main() {
++     console.log(JSON.stringify({
++       mode: 'dry-run',
++       counts: { bills: bills.length, needText: plan.needText.length, needSummary: plan.needSummary.length, stale: plan.stale.length },
++       needText: plan.needText.map((b) => b.identifier),
++       needSummary: plan.needSummary.map((b) => b.identifier),
++       stale: plan.stale.map((s) => s.bill_id),
++     }, null, 2));
++     return;
++   }
++ 
+++  // Mechanical per-run approval gate (task 1) — same standing policy as GLOSS_RUN_APPROVED in
+++  // gloss.js/extract-terms.js and GOLDEN_CHECK_APPROVED in golden.js: no live, billed Anthropic
+++  // call runs without Lance's explicit per-run opt-in. Caught locally (not left to propagate to
+++  // main().catch below) so the CLI prints the same clean single BLOCKED line gloss.js does,
+++  // never a raw stack trace.
+++  try {
+++    checkSummarizeApproval(process.env.SUMMARIZE_RUN_APPROVED);
+++  } catch (err) {
+++    if (err instanceof RunNotApprovedError) {
+++      console.log(err.message);
+++      process.exitCode = 1;
+++      return;
+++    }
+++    throw err;
+++  }
+++
++   const anthropic = getAnthropicClient();
++   if (!anthropic) {
++     console.log(JSON.stringify({ mode: 'blocked', reason: 'ANTHROPIC_API_KEY not set' }, null, 2));
++     process.exitCode = 1;
++     return;
++   }
++ 
++   const runId = await openRun(client, 'summarize');
++   const failures = [];
++   try {
++diff --git a/src/cli/verify.js b/src/cli/verify.js
++index 9166e36..ce7ca34 100644
++--- a/src/cli/verify.js
+++++ b/src/cli/verify.js
++@@ -1,11 +1,12 @@
++ import { getClient, openRun, closeRun, isMissingRelationError } from '../lib/db.js';
+++import { assertRunApproved, RunNotApprovedError } from '../lib/errors.js';
++ import { pickBillText } from '../review/server.js';
++ import {
++   getAnthropicClient, MAX_TEXT_CHARS,
++   OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
++ } from '../lib/summarizer.js';
++ import {
++   verifyBill, VERIFIER_MODEL, VERIFY_PROMPT_VERSION, assessVerdicts, VerificationIncompleteError,
++ } from '../lib/verifier.js';
++ import { parseBullets } from '../../site/js/summary-parse.js';
++ 
++@@ -56,20 +57,34 @@ export function checkBulletCoverage(identifier, bodyMd, bullets) {
++ }
++ 
++ // isMissingRelationError itself now lives in ../lib/db.js (shared with the review server — see
++ // that module for why). In --dry-run mode a missing table is tolerated (controller ruling #3);
++ // in live mode it is deliberately NOT caught anywhere — it's a gate.
++ 
++ function isTypedFailure(err) {
++   return FAILURE_TYPES.some((T) => err instanceof T);
++ }
++ 
+++// checkVerifyApproval (task 1, 2026-07-31): the mechanical per-run spend gate verify.js lacked —
+++// this file bills Lance's Anthropic account (adversarial summary verification) and previously ran
+++// with no gate at all, against the owner's standing spend hold and against CLAUDE.md's own stated
+++// policy ("Mechanical enforcement exists where possible — extend that pattern to new
+++// model-calling tools"). Thin, exported wrapper around the shared assertRunApproved (lib/errors.js)
+++// so this exact wiring — env var name, action wording — is directly testable without needing a
+++// fake DB/Anthropic client at all. See main() below for the call site: fires after the --dry-run
+++// branch has already returned and before getAnthropicClient() is called.
+++export function checkVerifyApproval(envValue) {
+++  assertRunApproved(envValue, {
+++    envVar: 'VERIFY_RUN_APPROVED', action: 'verification', detail: 'adversarial summary verification',
+++  });
+++}
+++
++ // ---- DB-facing helpers ----
++ 
++ async function loadCandidateSummaries(client) {
++   const { data, error } = await client
++     .from('summaries')
++     .select('id,bill_id,status,body_md,bill_text_hash,created_at,bills(identifier,title)')
++     .in('status', TARGET_STATUSES)
++     .order('created_at', { ascending: true });
++   if (error) throw new Error(`summaries lookup failed: ${error.message}`);
++   return data ?? [];
++@@ -143,20 +158,36 @@ async function main() {
++     const out = {
++       mode: 'dry-run',
++       counts: { candidates: summaries.length, unverified: unverified.length },
++       unverified: unverified.map((s) => ({ id: s.id, status: s.status, identifier: s.bills ? s.bills.identifier : null })),
++     };
++     if (tableMissing) out.note = '(summary_verifications missing — 0004 not applied; treating all as unverified)';
++     console.log(JSON.stringify(out, null, 2));
++     return;
++   }
++ 
+++  // Mechanical per-run approval gate (task 1) — same standing policy as GLOSS_RUN_APPROVED in
+++  // gloss.js/extract-terms.js and GOLDEN_CHECK_APPROVED in golden.js: no live, billed Anthropic
+++  // call runs without Lance's explicit per-run opt-in. Caught locally (not left to propagate to
+++  // main().catch below) so the CLI prints the same clean single BLOCKED line gloss.js does,
+++  // never a raw stack trace.
+++  try {
+++    checkVerifyApproval(process.env.VERIFY_RUN_APPROVED);
+++  } catch (err) {
+++    if (err instanceof RunNotApprovedError) {
+++      console.log(err.message);
+++      process.exitCode = 1;
+++      return;
+++    }
+++    throw err;
+++  }
+++
++   const anthropic = getAnthropicClient();
++   if (!anthropic) {
++     console.log(JSON.stringify({ mode: 'blocked', reason: 'ANTHROPIC_API_KEY not set' }, null, 2));
++     process.exitCode = 1;
++     return;
++   }
++ 
++   const runId = await openRun(client, 'verify');
++   const failures = [];
++   try {
++diff --git a/src/lib/errors.js b/src/lib/errors.js
++index 9b48e41..34d5870 100644
++--- a/src/lib/errors.js
+++++ b/src/lib/errors.js
++@@ -39,10 +39,42 @@ export function parsePositiveIntegerFlag(rawValue, flag) {
++   const n = Number(rawValue);
++   if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '' || !Number.isInteger(n) || n < 1) {
++     throw new InvalidFlagValueError(
++       `${flag} requires a positive integer; got ${JSON.stringify(rawValue ?? null)} — refusing to run, `
++         + 'since an unparseable limit would silently mean "no limit" and process the entire worklist',
++       { flag, value: rawValue },
++     );
++   }
++   return n;
++ }
+++
+++// RunNotApprovedError / assertRunApproved — task 1 (2026-07-31), the shared mechanical spend-gate
+++// primitive behind summarize.js's SUMMARIZE_RUN_APPROVED and verify.js's VERIFY_RUN_APPROVED.
+++// gloss.js's GLOSS_RUN_APPROVED (also reused by extract-terms.js) and golden.js's
+++// GOLDEN_CHECK_APPROVED predate this and stay untouched, inline, per-file — this shared pair only
+++// backs the two CLIs newly gated here, so their wording can't drift from each other the way two
+++// hand-copied message strings eventually would (same rationale as parsePositiveIntegerFlag/
+++// InvalidFlagValueError above).
+++export class RunNotApprovedError extends Error {
+++  constructor(message, { envVar, action } = {}) {
+++    super(message);
+++    this.name = 'RunNotApprovedError';
+++    this.envVar = envVar;
+++    this.action = action;
+++  }
+++}
+++
+++// Throws unless envValue is exactly 'yes' — mirrors gloss.js's own `!== 'yes'` check, so
+++// 'true'/'1'/anything else is refused, not just an unset var. The message keeps gloss.js's voice:
+++// what makes the run cost money, that approval is the owner's per-run call, and the exact env var
+++// to set. Callers (see summarize.js/verify.js main()) catch RunNotApprovedError locally and print
+++// err.message via console.log — never console.error — so the CLI's output stays the same clean
+++// single line gloss.js itself prints, not a raw stack trace.
+++export function assertRunApproved(envValue, { envVar, action, detail } = {}) {
+++  if (envValue === 'yes') return;
+++  const detailSuffix = detail ? ` (${detail})` : '';
+++  throw new RunNotApprovedError(
+++    `BLOCKED: ${action} makes live, billed Anthropic API calls${detailSuffix}. Per the owner's `
+++      + `standing policy, each run requires his explicit per-run approval — set ${envVar}=yes to proceed.`,
+++    { envVar, action },
+++  );
+++}
++diff --git a/tests/lib.test.js b/tests/lib.test.js
++index d50f207..9e0a38a 100644
++--- a/tests/lib.test.js
+++++ b/tests/lib.test.js
++@@ -1,13 +1,13 @@
++ import { test } from 'node:test';
++ import assert from 'node:assert/strict';
++-import { SourceFetchError, RateLimitedError } from '../src/lib/errors.js';
+++import { SourceFetchError, RateLimitedError, RunNotApprovedError, assertRunApproved } from '../src/lib/errors.js';
++ import { createLimiter } from '../src/lib/rate-limiter.js';
++ import { redactUrl } from '../src/lib/http.js';
++ 
++ test('RateLimitedError is a SourceFetchError with metadata', () => {
++   const err = new RateLimitedError('slow down', { source: 'us-congress', url: 'https://x', status: 429 });
++   assert.ok(err instanceof SourceFetchError);
++   assert.ok(err instanceof Error);
++   assert.equal(err.source, 'us-congress');
++   assert.equal(err.status, 429);
++   assert.equal(err.name, 'RateLimitedError');
++@@ -58,10 +58,59 @@ test('redactUrl also redacts access_key= (LegiScan\'s per-dataset token from get
++   assert.equal(
++     redactUrl('https://x/y?access_key=abc123&other=1'),
++     'https://x/y?access_key=REDACTED&other=1',
++   );
++ });
++ 
++ test('redactUrl passes through URLs with no query unchanged', () => {
++   assert.equal(redactUrl('https://clerk.house.gov/evs/2025/roll358.xml'), 'https://clerk.house.gov/evs/2025/roll358.xml');
++   assert.equal(redactUrl('https://x/y?format=json&limit=250'), 'https://x/y?format=json&limit=250');
++ });
+++
+++// ---- assertRunApproved / RunNotApprovedError: the shared spend-gate primitive behind
+++// summarize.js's SUMMARIZE_RUN_APPROVED and verify.js's VERIFY_RUN_APPROVED (task 1, closing the
+++// gap CLAUDE.md's own policy flagged — gloss.js's GLOSS_RUN_APPROVED and golden.js's
+++// GOLDEN_CHECK_APPROVED predate this and stay untouched, inline, per-file). ----
+++
+++test('assertRunApproved throws RunNotApprovedError unless the value is exactly "yes"', () => {
+++  assert.throws(
+++    () => assertRunApproved(undefined, { envVar: 'FOO_RUN_APPROVED', action: 'fooing' }),
+++    RunNotApprovedError,
+++  );
+++  assert.throws(
+++    () => assertRunApproved('', { envVar: 'FOO_RUN_APPROVED', action: 'fooing' }),
+++    RunNotApprovedError,
+++  );
+++  // Truthy-looking but not the exact sentinel — same discipline as gloss.js's own `!== 'yes'`.
+++  assert.throws(
+++    () => assertRunApproved('true', { envVar: 'FOO_RUN_APPROVED', action: 'fooing' }),
+++    RunNotApprovedError,
+++  );
+++});
+++
+++test('assertRunApproved does not throw when the value is exactly "yes"', () => {
+++  assert.doesNotThrow(() => assertRunApproved('yes', { envVar: 'FOO_RUN_APPROVED', action: 'fooing' }));
+++});
+++
+++test('RunNotApprovedError message states the run costs real money, that approval is per-run, and the exact env var to set — gloss.js\'s voice', () => {
+++  try {
+++    assertRunApproved(undefined, { envVar: 'FOO_RUN_APPROVED', action: 'fooing', detail: 'doing the foo' });
+++    assert.fail('expected assertRunApproved to throw');
+++  } catch (err) {
+++    assert.ok(err instanceof RunNotApprovedError);
+++    assert.equal(err.name, 'RunNotApprovedError');
+++    assert.match(err.message, /^BLOCKED: fooing makes live, billed Anthropic API calls \(doing the foo\)\./);
+++    assert.match(err.message, /owner's standing policy/);
+++    assert.match(err.message, /explicit per-run approval/);
+++    assert.match(err.message, /set FOO_RUN_APPROVED=yes to proceed/);
+++    assert.equal(err.envVar, 'FOO_RUN_APPROVED');
+++  }
+++});
+++
+++test('assertRunApproved omits the parenthetical when no detail is given', () => {
+++  try {
+++    assertRunApproved('no', { envVar: 'FOO_RUN_APPROVED', action: 'fooing' });
+++    assert.fail('expected assertRunApproved to throw');
+++  } catch (err) {
+++    assert.match(err.message, /^BLOCKED: fooing makes live, billed Anthropic API calls\. Per/);
+++  }
+++});
++diff --git a/tests/scheduled-ingest.test.js b/tests/scheduled-ingest.test.js
++new file mode 100644
++index 0000000..d0497d0
++--- /dev/null
+++++ b/tests/scheduled-ingest.test.js
++@@ -0,0 +1,449 @@
+++import { test } from 'node:test';
+++import assert from 'node:assert/strict';
+++import {
+++  mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync,
+++} from 'node:fs';
+++import { spawnSync } from 'node:child_process';
+++import path from 'node:path';
+++import os from 'node:os';
+++import {
+++  parseArgs, isLockStale, acquireLock, releaseLock,
+++  computeSourceDueness, pickMostOverdue,
+++  parseUsHouseRoll, computeRollWindow,
+++  parseChildOutput, runWroteSomething,
+++  queryLatestStartedAt, resolveLegiscanSessionId, resolveUsCongressRollWindow, buildRegistry,
+++  runChildCli, envIntervalMs,
+++  MAX_RUN_DURATION_MS, US_CONGRESS_CONGRESS, US_CONGRESS_ROLL_WINDOW,
+++} from '../scripts/scheduled-ingest.js';
+++import { MO_SENATE_MIN_INTERVAL_MS } from '../src/adapters/mo-senate-web.js';
+++import { MO_HOUSE_MIN_INTERVAL_MS, DEFAULT_MO_HOUSE_SESSION } from '../src/adapters/mo-house-xml.js';
+++
+++// ---- parseArgs ----
+++
+++test('parseArgs defaults to live, no --only', () => {
+++  const out = parseArgs([]);
+++  assert.equal(out.dryRun, false);
+++  assert.equal(out.only, null);
+++});
+++
+++test('parseArgs accepts --dry-run and --only <source>', () => {
+++  const out = parseArgs(['--dry-run', '--only', 'mo-senate-web']);
+++  assert.equal(out.dryRun, true);
+++  assert.equal(out.only, 'mo-senate-web');
+++});
+++
+++test('parseArgs rejects an unknown --only value (never silently runs the wrong source)', () => {
+++  assert.throws(() => parseArgs(['--only', 'bogus-source']), /unknown source/);
+++});
+++
+++test('parseArgs rejects unknown flags', () => {
+++  assert.throws(() => parseArgs(['--wat']), /unknown flag/);
+++});
+++
+++// ---- envIntervalMs: the mechanical floor behind US_CONGRESS_MIN_INTERVAL_MS/LEGISCAN_MIN_INTERVAL_MS ----
+++
+++test('envIntervalMs floors a configured value at the minimum, never letting it go lower', () => {
+++  assert.equal(envIntervalMs('__NOPE__', 1000, 5000), 5000, 'unset env falls back to default, then floored');
+++  assert.equal(envIntervalMs('__NOPE__', 10000, 5000), 10000, 'unset env default above floor is kept');
+++});
+++
+++// ---- isLockStale / acquireLock / releaseLock — single-instance lock discipline ----
+++
+++test('isLockStale: false when within the max run duration, true once past it', () => {
+++  const now = Date.parse('2026-07-31T12:10:00.000Z');
+++  const lock = { startedAt: '2026-07-31T12:00:00.000Z', pid: 123 };
+++  assert.equal(isLockStale(lock, now, 20 * 60 * 1000), false); // 10 min elapsed, 20 min ceiling
+++  assert.equal(isLockStale(lock, now, 5 * 60 * 1000), true); // 10 min elapsed, 5 min ceiling
+++});
+++
+++test('isLockStale: an unparseable startedAt is treated as stale, not trusted', () => {
+++  assert.equal(isLockStale({ startedAt: 'not-a-date' }, Date.now(), MAX_RUN_DURATION_MS), true);
+++});
+++
+++function withTmpDir(fn) {
+++  const dir = mkdtempSync(path.join(os.tmpdir(), 'vg-scheduler-test-'));
+++  try {
+++    return fn(dir);
+++  } finally {
+++    rmSync(dir, { recursive: true, force: true });
+++  }
+++}
+++
+++test('acquireLock: fresh lock succeeds and writes pid+timestamp; a second attempt while it is live is refused', () => {
+++  withTmpDir((dir) => {
+++    const lockPath = path.join(dir, 'nested', 'scheduler.lock.json');
+++    const first = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
+++    assert.equal(first.acquired, true);
+++    assert.equal(first.reason, 'fresh');
+++    assert.ok(existsSync(lockPath));
+++    const written = JSON.parse(readFileSync(lockPath, 'utf8'));
+++    assert.equal(written.pid, process.pid);
+++    assert.equal(written.startedAt, '2026-07-31T12:00:00.000Z');
+++
+++    // Second attempt 1 minute later, well within MAX_RUN_DURATION_MS — must be refused, never
+++    // silently proceed (this is the exact "no stacked overlapping processes" guarantee).
+++    const second = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:01:00.000Z') });
+++    assert.equal(second.acquired, false);
+++    assert.equal(second.reason, 'already-running');
+++    assert.equal(second.lock.pid, process.pid);
+++  });
+++});
+++
+++test('acquireLock: a lock older than the max run duration is reclaimed, not trusted forever', () => {
+++  withTmpDir((dir) => {
+++    const lockPath = path.join(dir, 'scheduler.lock.json');
+++    acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
+++
+++    const muchLater = Date.parse('2026-07-31T12:00:00.000Z') + MAX_RUN_DURATION_MS + 1;
+++    const reclaimed = acquireLock(lockPath, { now: muchLater });
+++    assert.equal(reclaimed.acquired, true);
+++    assert.equal(reclaimed.reason, 'reclaimed-stale');
+++    assert.ok(reclaimed.staleLock, 'the reclaimed lock\'s own prior contents are surfaced for the warning log');
+++  });
+++});
+++
+++test('acquireLock: a corrupt/unreadable lock file is treated as stale and reclaimed, never crashes', () => {
+++  withTmpDir((dir) => {
+++    const lockPath = path.join(dir, 'scheduler.lock.json');
+++    mkdirSync(path.dirname(lockPath), { recursive: true });
+++    writeFileSync(lockPath, 'not json{{{');
+++    const result = acquireLock(lockPath, { now: Date.now() });
+++    assert.equal(result.acquired, true);
+++    assert.equal(result.reason, 'reclaimed-stale');
+++  });
+++});
+++
+++test('releaseLock: deletes an existing lock file, and is a safe no-op when nothing is there', () => {
+++  withTmpDir((dir) => {
+++    const lockPath = path.join(dir, 'scheduler.lock.json');
+++    acquireLock(lockPath, { now: Date.now() });
+++    assert.ok(existsSync(lockPath));
+++    releaseLock(lockPath);
+++    assert.ok(!existsSync(lockPath));
+++    assert.doesNotThrow(() => releaseLock(lockPath)); // already gone — must not throw
+++  });
+++});
+++
+++// ---- computeSourceDueness / pickMostOverdue ----
+++
+++test('computeSourceDueness: never-run source (lastStartedAtIso null) is due, with infinite elapsed', () => {
+++  const now = Date.now();
+++  const e = computeSourceDueness({ key: 'x', minIntervalMs: 1000, lastStartedAtIso: null }, now);
+++  assert.equal(e.due, true);
+++  assert.equal(e.remainingMs, 0);
+++  assert.equal(e.elapsedMs, Infinity);
+++});
+++
+++test('computeSourceDueness: recently-run source is not due; remainingMs matches remainingCooldownMs\'s own arithmetic', () => {
+++  const now = Date.parse('2026-07-31T12:30:00.000Z');
+++  const e = computeSourceDueness({ key: 'x', minIntervalMs: 30 * 60 * 1000, lastStartedAtIso: '2026-07-31T12:20:00.000Z' }, now);
+++  assert.equal(e.due, false);
+++  assert.equal(e.remainingMs, 20 * 60 * 1000); // 30 min interval - 10 min elapsed
+++  assert.equal(e.elapsedMs, 10 * 60 * 1000);
+++});
+++
+++test('computeSourceDueness: a source whose cooldown has fully elapsed is due', () => {
+++  const now = Date.parse('2026-07-31T13:00:00.000Z');
+++  const e = computeSourceDueness({ key: 'x', minIntervalMs: 30 * 60 * 1000, lastStartedAtIso: '2026-07-31T12:00:00.000Z' }, now);
+++  assert.equal(e.due, true);
+++  assert.equal(e.remainingMs, 0);
+++});
+++
+++test('pickMostOverdue: chooses the due source with the longest elapsed time, never a not-due one', () => {
+++  const entries = [
+++    { key: 'a', due: true, resolvable: true, elapsedMs: 1000 },
+++    { key: 'b', due: true, resolvable: true, elapsedMs: 5000 },
+++    { key: 'c', due: false, resolvable: true, elapsedMs: 999999 }, // not due — must never win despite huge elapsed
+++  ];
+++  assert.equal(pickMostOverdue(entries).key, 'b');
+++});
+++
+++test('pickMostOverdue: an unresolvable source (e.g. legiscan with no session id) is never chosen even if due and most overdue', () => {
+++  const entries = [
+++    { key: 'a', due: true, resolvable: true, elapsedMs: 10 },
+++    { key: 'legiscan', due: true, resolvable: false, elapsedMs: Infinity },
+++  ];
+++  assert.equal(pickMostOverdue(entries).key, 'a');
+++});
+++
+++test('pickMostOverdue: null when nothing is due', () => {
+++  const entries = [{ key: 'a', due: false, resolvable: true, elapsedMs: 10 }];
+++  assert.equal(pickMostOverdue(entries), null);
+++});
+++
+++test('pickMostOverdue: a source that has never run (Infinity elapsed) outranks every source with a real timestamp', () => {
+++  const entries = [
+++    { key: 'seen', due: true, resolvable: true, elapsedMs: 99 * 24 * 60 * 60 * 1000 },
+++    { key: 'never', due: true, resolvable: true, elapsedMs: Infinity },
+++  ];
+++  assert.equal(pickMostOverdue(entries).key, 'never');
+++});
+++
+++// ---- parseUsHouseRoll / computeRollWindow ----
+++
+++test('parseUsHouseRoll extracts the trailing roll number from a us-house source_key', () => {
+++  assert.equal(parseUsHouseRoll('us-house-119-2026-350'), 350);
+++  assert.equal(parseUsHouseRoll('us-house-119-2026-7'), 7);
+++});
+++
+++test('parseUsHouseRoll returns null for anything that isn\'t that exact shape (never a false roll number)', () => {
+++  assert.equal(parseUsHouseRoll('us-senate-119-1-616'), null);
+++  assert.equal(parseUsHouseRoll(''), null);
+++  assert.equal(parseUsHouseRoll(null), null);
+++  assert.equal(parseUsHouseRoll(undefined), null);
+++});
+++
+++test('computeRollWindow: starts one past the max known roll, spans windowSize', () => {
+++  assert.deepEqual(computeRollWindow(350, 10), { lo: 351, hi: 360 });
+++});
+++
+++test('computeRollWindow: zero/no prior rolls on file starts the window at roll 1', () => {
+++  assert.deepEqual(computeRollWindow(0, 10), { lo: 1, hi: 10 });
+++  assert.deepEqual(computeRollWindow(undefined, 10), { lo: 1, hi: 10 });
+++});
+++
+++test('computeRollWindow defaults windowSize to US_CONGRESS_ROLL_WINDOW', () => {
+++  assert.deepEqual(computeRollWindow(0), { lo: 1, hi: US_CONGRESS_ROLL_WINDOW });
+++});
+++
+++// ---- parseChildOutput / runWroteSomething ----
+++
+++test('parseChildOutput parses a CLI\'s pretty-printed JSON.stringify(..., null, 2) stdout', () => {
+++  const stdout = JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 3 } }, null, 2);
+++  const { parsed, parseError } = parseChildOutput(stdout);
+++  assert.equal(parseError, null);
+++  assert.equal(parsed.mode, 'live');
+++  assert.equal(parsed.counts.votes, 3);
+++});
+++
+++test('parseChildOutput reports a parse error instead of throwing on unparseable stdout', () => {
+++  const { parsed, parseError } = parseChildOutput('not json at all');
+++  assert.equal(parsed, null);
+++  assert.ok(parseError);
+++});
+++
+++test('runWroteSomething: true only for a live run reporting succeeded/partial', () => {
+++  assert.equal(runWroteSomething({ mode: 'live', status: 'succeeded' }), true);
+++  assert.equal(runWroteSomething({ mode: 'live', status: 'partial' }), true);
+++});
+++
+++test('runWroteSomething: false for blocked/dry-run modes, and for a null/unparsed result', () => {
+++  assert.equal(runWroteSomething({ mode: 'blocked', status: 'succeeded' }), false);
+++  assert.equal(runWroteSomething({ mode: 'dry-run' }), false);
+++  assert.equal(runWroteSomething(null), false);
+++  assert.equal(runWroteSomething(undefined), false);
+++});
+++
+++test('runWroteSomething: false for a live run whose status is neither succeeded nor partial', () => {
+++  assert.equal(runWroteSomething({ mode: 'live', status: 'failed' }), false);
+++});
+++
+++// ---- DB-facing helpers: fakeClient (same shape as summarize-cli.test.js's own fakeClient) ----
+++
+++function fakeQuery(result) {
+++  const builder = {
+++    select: () => builder,
+++    eq: () => builder,
+++    like: () => builder,
+++    order: () => builder,
+++    limit: () => builder,
+++    range: () => builder,
+++    maybeSingle: () => builder,
+++    single: () => builder,
+++    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
+++  };
+++  return builder;
+++}
+++
+++function fakeClient(resultsByTable) {
+++  return { from: (table) => fakeQuery(resultsByTable[table] ?? { data: null, error: null }) };
+++}
+++
+++test('queryLatestStartedAt returns the latest started_at for the given source, null when none exists', async () => {
+++  const client = fakeClient({ ingestion_runs: { data: { started_at: '2026-07-31T10:00:00.000Z' }, error: null } });
+++  assert.equal(await queryLatestStartedAt(client, 'mo-senate-web'), '2026-07-31T10:00:00.000Z');
+++
+++  const emptyClient = fakeClient({ ingestion_runs: { data: null, error: null } });
+++  assert.equal(await queryLatestStartedAt(emptyClient, 'mo-senate-web'), null);
+++});
+++
+++test('queryLatestStartedAt throws a plain descriptive Error on a real lookup failure (never silently swallowed)', async () => {
+++  const client = fakeClient({ ingestion_runs: { data: null, error: { message: 'boom' } } });
+++  await assert.rejects(() => queryLatestStartedAt(client, 'legiscan'), /ingestion_runs lookup failed.*legiscan.*boom/s);
+++});
+++
+++test('resolveLegiscanSessionId returns the current MO session\'s legiscan_session_id when on file', async () => {
+++  const client = fakeClient({ sessions: { data: { legiscan_session_id: 2239 }, error: null } });
+++  assert.equal(await resolveLegiscanSessionId(client), 2239);
+++});
+++
+++test('resolveLegiscanSessionId returns null (never guesses) when the session row or its legiscan_session_id is missing', async () => {
+++  const missingRow = fakeClient({ sessions: { data: null, error: null } });
+++  assert.equal(await resolveLegiscanSessionId(missingRow), null);
+++
+++  const nullColumn = fakeClient({ sessions: { data: { legiscan_session_id: null }, error: null } });
+++  assert.equal(await resolveLegiscanSessionId(nullColumn), null);
+++});
+++
+++test('resolveUsCongressRollWindow computes the window from the max roll number found in votes.source_key', async () => {
+++  const client = fakeClient({
+++    votes: {
+++      data: [
+++        { source_key: 'us-house-119-2026-40' },
+++        { source_key: 'us-house-119-2026-355' },
+++        { source_key: 'us-house-119-2026-12' },
+++      ],
+++      error: null,
+++    },
+++  });
+++  const window = await resolveUsCongressRollWindow(client, { congress: 119, year: 2026, windowSize: 10 });
+++  assert.deepEqual(window, { lo: 356, hi: 365 });
+++});
+++
+++test('resolveUsCongressRollWindow starts at roll 1 when nothing is on file yet for this congress/year', async () => {
+++  const client = fakeClient({ votes: { data: [], error: null } });
+++  const window = await resolveUsCongressRollWindow(client, { congress: 119, year: 2026, windowSize: 10 });
+++  assert.deepEqual(window, { lo: 1, hi: 10 });
+++});
+++
+++// ---- buildRegistry: the full four-source registry, with the TODO-31 mo-house-xml restriction and
+++// the legiscan fail-safe both structurally verified, not just documented ----
+++
+++function fakeRegistryClient({ legiscanSessionId = 2239, votesRows = [], lastStartedAtBySource = {} } = {}) {
+++  return {
+++    from(table) {
+++      if (table === 'ingestion_runs') {
+++        // Own closure variable per .from('ingestion_runs') call (queryLatestStartedAt makes one
+++        // fresh call per source) — NOT `this` inside arrow functions, which would capture the
+++        // outer fakeRegistryClient object instead of this inner chainable builder.
+++        let sourceFilter = null;
+++        const builder = {
+++          select: () => builder,
+++          eq: (col, val) => { sourceFilter = val; return builder; },
+++          order: () => builder,
+++          limit: () => builder,
+++          maybeSingle: () => builder,
+++          then: (resolve, reject) => {
+++            const started = lastStartedAtBySource[sourceFilter] ?? null;
+++            return Promise.resolve({ data: started ? { started_at: started } : null, error: null }).then(resolve, reject);
+++          },
+++        };
+++        return builder;
+++      }
+++      if (table === 'sessions') {
+++        return fakeQuery({
+++          data: legiscanSessionId != null ? { legiscan_session_id: legiscanSessionId } : null,
+++          error: null,
+++        });
+++      }
+++      if (table === 'votes') {
+++        return fakeQuery({ data: votesRows, error: null });
+++      }
+++      return fakeQuery({ data: null, error: null });
+++    },
+++  };
+++}
+++
+++test('buildRegistry: all four sources, correct scripts + static args, legiscan resolved', async () => {
+++  const client = fakeRegistryClient({ legiscanSessionId: 2239 });
+++  const registry = await buildRegistry(client, { now: Date.parse('2026-07-31T12:00:00.000Z'), year: 2026 });
+++
+++  assert.equal(registry.length, 4);
+++  const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));
+++
+++  assert.equal(byKey['mo-senate-web'].minIntervalMs, MO_SENATE_MIN_INTERVAL_MS);
+++  assert.equal(byKey['mo-senate-web'].scriptPath, 'src/cli/ingest-mo-senate.js');
+++  assert.deepEqual(byKey['mo-senate-web'].cliArgs, ['--year', '2026', '--limit', '1']);
+++  assert.equal(byKey['mo-senate-web'].resolvable, true);
+++
+++  assert.equal(byKey['mo-house-xml'].minIntervalMs, MO_HOUSE_MIN_INTERVAL_MS);
+++  assert.equal(byKey['mo-house-xml'].scriptPath, 'src/cli/ingest-mo-house.js');
+++  assert.deepEqual(byKey['mo-house-xml'].cliArgs, ['--limit', '1']);
+++
+++  assert.equal(byKey['us-congress'].scriptPath, 'src/cli/ingest.js');
+++  assert.deepEqual(byKey['us-congress'].cliArgs, ['--source', 'us-congress', '--year', '2026', '--rolls', '1-10']);
+++
+++  assert.equal(byKey.legiscan.scriptPath, 'src/cli/ingest-legiscan.js');
+++  assert.deepEqual(byKey.legiscan.cliArgs, ['--session', '2239']);
+++  assert.equal(byKey.legiscan.resolvable, true);
+++});
+++
+++test('buildRegistry: TODO-31 restriction — mo-house-xml args NEVER include --session, regardless of anything else', async () => {
+++  const client = fakeRegistryClient({});
+++  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
+++  const house = registry.find((e) => e.key === 'mo-house-xml');
+++  assert.ok(!house.cliArgs.includes('--session'), 'mo-house-xml must never receive a --session flag from the scheduler');
+++});
+++
+++test('buildRegistry: legiscan with no legiscan_session_id on file is marked unresolvable and gets an honest reason, never a guessed session', async () => {
+++  const client = fakeRegistryClient({ legiscanSessionId: null });
+++  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
+++  const legiscan = registry.find((e) => e.key === 'legiscan');
+++  assert.equal(legiscan.resolvable, false);
+++  assert.ok(legiscan.unresolvedReason, 'must explain WHY it is skipped');
+++  assert.deepEqual(legiscan.cliArgs, []);
+++});
+++
+++test('buildRegistry: every source\'s lastStartedAtIso reflects ingestion_runs, per source', async () => {
+++  const client = fakeRegistryClient({
+++    lastStartedAtBySource: {
+++      'mo-senate-web': '2026-07-31T11:00:00.000Z',
+++      'mo-house-xml': '2026-07-31T11:29:00.000Z',
+++    },
+++  });
+++  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
+++  const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));
+++  assert.equal(byKey['mo-senate-web'].lastStartedAtIso, '2026-07-31T11:00:00.000Z');
+++  assert.equal(byKey['mo-house-xml'].lastStartedAtIso, '2026-07-31T11:29:00.000Z');
+++  assert.equal(byKey['us-congress'].lastStartedAtIso, null);
+++});
+++
+++// ---- runChildCli: process orchestration, spawnFn injectable so no real subprocess in most tests ----
+++
+++test('runChildCli: parses a faked child\'s stdout and passes through its exit status', () => {
+++  const calls = [];
+++  const spawnFn = (command, args, options) => {
+++    calls.push({ command, args, options });
+++    return { status: 0, stdout: JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 1 } }), stderr: '' };
+++  };
+++  const result = runChildCli('src/cli/ingest-mo-senate.js', ['--year', '2026', '--limit', '1'], { cwd: '/repo', spawnFn });
+++  assert.equal(result.exitStatus, 0);
+++  assert.equal(result.parsed.status, 'succeeded');
+++  assert.equal(calls.length, 1);
+++  assert.equal(calls[0].command, process.execPath);
+++  assert.deepEqual(calls[0].args, ['--env-file=.env', 'src/cli/ingest-mo-senate.js', '--year', '2026', '--limit', '1']);
+++  assert.equal(calls[0].options.cwd, '/repo');
+++});
+++
+++test('runChildCli: a non-zero exit (typed CLI failures) is reported, never thrown — "never crashes the scheduler run"', () => {
+++  const spawnFn = () => ({ status: 2, stdout: JSON.stringify({ mode: 'live', status: 'partial', counts: {}, failures: [{ message: 'x' }] }), stderr: '' });
+++  const result = runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn });
+++  assert.equal(result.exitStatus, 2);
+++  assert.equal(result.parsed.status, 'partial');
+++});
+++
+++test('runChildCli: a genuine launch failure (spawnFn returns .error) throws — this IS a real scheduler-level error', () => {
+++  const spawnFn = () => ({ error: new Error('ENOENT'), status: null, stdout: '', stderr: '' });
+++  assert.throws(() => runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn }), /could not launch/);
+++});
+++
+++// Real subprocess smoke test (no network, no DB) — proves the actual `node --env-file=.env <path>
+++// <args>` spawn plumbing runChildCli builds works end to end, not just the fake spawnFn used
+++// everywhere else above. Runs from its own temp dir with a throwaway .env — real .env is
+++// gitignored (never present on a fresh checkout), so this must not depend on the repo's own copy.
+++test('runChildCli: real subprocess smoke test (no network, no DB) — proves the actual spawn plumbing works, not just the fake', () => {
+++  withTmpDir((dir) => {
+++    writeFileSync(path.join(dir, '.env'), 'SCHEDULED_INGEST_SMOKE_TEST=1\n');
+++    const scriptPath = path.join(dir, 'fake-cli.js');
+++    writeFileSync(scriptPath, "console.log(JSON.stringify({mode:'live',status:'succeeded',counts:{x:1}}));\n");
+++
+++    const result = runChildCli(
+++      'fake-cli.js',
+++      [],
+++      { cwd: dir, spawnFn: (command, args, options) => spawnSync(command, args, { encoding: 'utf8', ...options }) },
+++    );
+++    assert.equal(result.exitStatus, 0);
+++    assert.equal(result.parsed.mode, 'live');
+++    assert.equal(result.parsed.counts.x, 1);
+++  });
+++});
++diff --git a/tests/summarize-cli.test.js b/tests/summarize-cli.test.js
++index 6554b01..84863b9 100644
++--- a/tests/summarize-cli.test.js
+++++ b/tests/summarize-cli.test.js
++@@ -1,16 +1,17 @@
++ import { test } from 'node:test';
++ import assert from 'node:assert/strict';
++ import {
++   planWork, wrapTextFormatError, persistReferencedTermsGracefully, createDraftSummary,
+++  checkSummarizeApproval,
++ } from '../src/cli/summarize.js';
++-import { SourceFetchError } from '../src/lib/errors.js';
+++import { SourceFetchError, RunNotApprovedError } from '../src/lib/errors.js';
++ 
++ const bills = [{ id: 'b1', identifier: 'HR 1' }, { id: 'b2', identifier: 'HR 2' }, { id: 'b3', identifier: 'HR 3' }];
++ const texts = [{ bill_id: 'b2', content_hash: 'h2' }, { bill_id: 'b3', content_hash: 'h3-new' }];
++ const summaries = [{ bill_id: 'b3', bill_text_hash: 'h3-old', status: 'published' }];
++ 
++ test('planWork routes bills correctly', () => {
++   const plan = planWork(bills, texts, summaries);
++   assert.deepEqual(plan.needText.map((b) => b.id), ['b1']);
++   assert.deepEqual(plan.needSummary.map((b) => b.id), ['b2', 'b3']);
++   assert.deepEqual(plan.stale.map((s) => s.bill_id), ['b3']);
++@@ -305,10 +306,30 @@ test('batch loop over two bills: a non-missing-relation persist error on bill 2
++   // A glossary-persist error must never surface as a batch failure (that's the whole point).
++   assert.equal(failures.length, 0);
++   // Bill 1's term genuinely persisted; bill 2's did not (that's the simulated failure).
++   assert.equal(glossaryTermsPersisted, 1);
++   // The prior bill's success is intact in the run detail — not discarded by bill 2's warning.
++   assert.equal(glossaryWarnings.length, 1);
++   assert.equal(glossaryWarnings[0].identifier, 'HR 2');
++   assert.equal(glossaryWarnings[0].warning.kind, 'persist_error');
++   assert.match(glossaryWarnings[0].warning.message, /duplicate key/);
++ });
+++
+++// ---- checkSummarizeApproval: task 1's spend gate — mirrors gloss.js's GLOSS_RUN_APPROVED shape
+++// exactly, wired to SUMMARIZE_RUN_APPROVED. main() calls this before constructing an Anthropic
+++// client or fetching any bill text for sending; see summarize.js's main() for the call site. ----
+++
+++test('checkSummarizeApproval blocks unless SUMMARIZE_RUN_APPROVED is exactly "yes"', () => {
+++  assert.throws(() => checkSummarizeApproval(undefined), RunNotApprovedError);
+++  assert.throws(() => checkSummarizeApproval('true'), RunNotApprovedError);
+++  assert.doesNotThrow(() => checkSummarizeApproval('yes'));
+++});
+++
+++test('checkSummarizeApproval\'s message names SUMMARIZE_RUN_APPROVED specifically, never another CLI\'s var', () => {
+++  try {
+++    checkSummarizeApproval('no');
+++    assert.fail('expected checkSummarizeApproval to throw');
+++  } catch (err) {
+++    assert.match(err.message, /set SUMMARIZE_RUN_APPROVED=yes to proceed/);
+++    assert.doesNotMatch(err.message, /VERIFY_RUN_APPROVED|GLOSS_RUN_APPROVED|GOLDEN_CHECK_APPROVED/);
+++  }
+++});
++diff --git a/tests/verifier.test.js b/tests/verifier.test.js
++index de10dde..a4763cf 100644
++--- a/tests/verifier.test.js
+++++ b/tests/verifier.test.js
++@@ -1,19 +1,20 @@
++ import { test } from 'node:test';
++ import assert from 'node:assert/strict';
++ import {
++   VERIFIER_MODEL, VERIFY_PROMPT_VERSION, VERIFY_SCHEMA, VERIFY_SYSTEM_PROMPT,
++   VERIFY_MAX_OUTPUT_TOKENS,
++   buildVerifyMessage, verifyBill, assessVerdicts, VerificationIncompleteError,
++ } from '../src/lib/verifier.js';
++ import { MODEL, MAX_TEXT_CHARS, OversizeTextError, renderMarkdown } from '../src/lib/summarizer.js';
++-import { parseArgs, parseBullets, checkBulletCoverage } from '../src/cli/verify.js';
+++import { parseArgs, parseBullets, checkBulletCoverage, checkVerifyApproval } from '../src/cli/verify.js';
+++import { RunNotApprovedError } from '../src/lib/errors.js';
++ 
++ // ---- constants (controller ruling #4: sonnet stays sonnet, deliberately not opus) ----
++ 
++ test('VERIFIER_MODEL is claude-sonnet-5, deliberately a different weight class than the opus-5 author', () => {
++   assert.equal(VERIFIER_MODEL, 'claude-sonnet-5');
++   assert.notEqual(VERIFIER_MODEL, MODEL);
++ });
++ 
++ test('VERIFY_PROMPT_VERSION pinned', () => {
++   assert.equal(VERIFY_PROMPT_VERSION, 'v1');
++@@ -239,10 +240,30 @@ test('parseArgs defaults dryRun to false and accepts --dry-run', () => {
++   assert.equal(parseArgs([]).dryRun, false);
++   assert.equal(parseArgs(['--dry-run']).dryRun, true);
++ });
++ 
++ test('parseArgs rejects unknown flags', () => {
++   assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
++ });
++ 
++ // isMissingRelationError itself now lives in src/lib/db.js (shared with the review server) —
++ // see tests/db.test.js for its unit tests. verify.js just imports and uses it.
+++
+++// ---- checkVerifyApproval: task 1's spend gate — mirrors gloss.js's GLOSS_RUN_APPROVED shape
+++// exactly, wired to VERIFY_RUN_APPROVED. main() calls this before constructing an Anthropic
+++// client; see verify.js's main() for the call site. ----
+++
+++test('checkVerifyApproval blocks unless VERIFY_RUN_APPROVED is exactly "yes"', () => {
+++  assert.throws(() => checkVerifyApproval(undefined), RunNotApprovedError);
+++  assert.throws(() => checkVerifyApproval('true'), RunNotApprovedError);
+++  assert.doesNotThrow(() => checkVerifyApproval('yes'));
+++});
+++
+++test('checkVerifyApproval\'s message names VERIFY_RUN_APPROVED specifically, never another CLI\'s var', () => {
+++  try {
+++    checkVerifyApproval('no');
+++    assert.fail('expected checkVerifyApproval to throw');
+++  } catch (err) {
+++    assert.match(err.message, /set VERIFY_RUN_APPROVED=yes to proceed/);
+++    assert.doesNotMatch(err.message, /SUMMARIZE_RUN_APPROVED|GLOSS_RUN_APPROVED|GOLDEN_CHECK_APPROVED/);
+++  }
+++});
+diff --git a/.superpowers/sdd/2026-07-31-scheduling/task-review.md b/.superpowers/sdd/2026-07-31-scheduling/task-review.md
+new file mode 100644
+index 0000000..9815229
+--- /dev/null
++++ b/.superpowers/sdd/2026-07-31-scheduling/task-review.md
+@@ -0,0 +1,426 @@
++# Task review — spend gates + scheduled ingestion (de2bf54..3e12a1e)
++
++Reviewer: session 8ecd5d8c (task-reviewer). Date 2026-07-31.
++Reviewed as **hostile-environment code**: `scripts/scheduled-ingest.js` is the first thing in this
++repo that runs unattended, forever, with nobody watching a single invocation.
++
++---
++
++## Verdicts
++
++| | Verdict |
++|---|---|
++| **Task 1 spec** (spend gates) | ✅ **PASS** |
++| **Task 2 spec** (scheduler) | ❌ **FAIL** — one binding brief requirement violated (docs honesty, review question C) |
++| **Code quality** | ❌ **FAIL** — one Critical unattended-operation defect (C1) in the core selection path |
++
++Task 1 is shippable as-is. Task 2 is close — the mechanics are genuinely good and every
++suspension-level rule holds — but it must not be registered with Task Scheduler until C1 and C2
++are fixed.
++
++---
++
++## Mechanical verification (run by the reviewer, not taken from any report)
++
++**Test suite** — `node --test` from `F:\VisibleGov` (bare, repo root):
++
++```
++ℹ tests 2025
++ℹ suites 0
++ℹ pass 2025
++ℹ fail 0
++ℹ cancelled 0
++ℹ skipped 0
++ℹ todo 0
++ℹ duration_ms 22221.9775
++```
++
++Extracted fail-count line: **`ℹ fail 0`**. Independent corroboration: `grep -c "^not ok"` = **0**.
++Baseline 1975 + 50 new = 2025. Matches the implementer's claim. Gated on the extracted line, not
++on exit status (PLAYBOOK_DELTA lesson 14).
++
++**Commit hashes** — `git log --oneline` confirms `3e12a1e` (scheduler) on top of `41936f0` (spend
++gates) on top of BASE `de2bf54`. Per-commit `--stat` sums to 1152 + 304 = **1456 insertions**,
++exactly the review package's stat. Diff matches the working tree. Tree clean except the two
++untracked SDD ledger files.
++
++**Dry run** — `node --env-file=.env scripts/scheduled-ingest.js --dry-run`:
++
++```
++DRYRUN_EXIT_CODE=0
++```
++
++Zero stderr. Count-header (`select('id', { count: 'exact', head: true })`) snapshot of six tables
++immediately before and immediately after:
++
++```
++BEFORE {"ingestion_runs":401,"votes":9981,"vote_casts":1465333,"bills":38266,"sessions":33,"legislators":1607}
++AFTER  {"ingestion_runs":401,"votes":9981,"vote_casts":1465333,"bills":38266,"sessions":33,"legislators":1607}
++```
++
++**Zero writes, byte-identical.** Lock file absent at rest both before and after (released
++correctly). Chose `us-congress`, would run `src/cli/ingest.js --source us-congress --year 2026
++--rolls 284-293`. The documented `--dry-run --only legiscan` variant also exits 0 with zero
++writes.
++
++**No model reachable from the scheduler's import graph** — walked the full transitive ESM graph of
++`scripts/scheduled-ingest.js`: **10 files**, all of them `db.js` / `errors.js` / `http.js` /
++`rate-limiter.js` / the two MO adapters / `mo-senate-journal-pdf.js` / `pdf-text.js` /
++`ingest-mo-senate.js`. Zero model-adjacent modules (no `summarizer`, no `verifier`, no `gloss`),
++zero `@anthropic-ai/*` imports at any depth. The header comment's guarantee is **mechanically
++true**, not aspirational.
++
++**MO ToU intervals cannot be shortened by any code path** — repo-wide grep: `MO_SENATE_MIN_INTERVAL_MS`
++and `MO_HOUSE_MIN_INTERVAL_MS` are bare `export const … = 30 * 60 * 1000` literals
++(`src/adapters/mo-senate-web.js:9`, `src/adapters/mo-house-xml.js:11`) with **no `process.env` read
++anywhere in the repo**. `process.env[...]` appears exactly **once** in the entire scheduler graph
++(`scripts/scheduled-ingest.js:82`, inside `envIntervalMs`), and `envIntervalMs` is called for only
++the two non-ToU intervals, each `Math.max`-floored at the brief's minimum. No env var, no flag, no
++config can shorten a published MO cadence. ✅
++
++**LegiScan gate not reimplemented** — `dataset_hash` / `getDataset` appear in
++`scripts/scheduled-ingest.js` only inside **comments** (lines 94, 362). The registry entry supplies
++`--session <id>` and nothing else; the suspension-level gate stays entirely inside
++`ingest-legiscan.js`. ✅
++
++**mo-house-xml cannot receive a historical session** — `cliArgs` is a frozen literal
++`['--limit','1']` (`scheduled-ingest.js:341`) with no interpolation; the CLI falls through to its
++own `DEFAULT_MO_HOUSE_SESSION = '261'`. Structurally asserted by a test, not just commented. ✅
++
++**`schtasks` not run** — `schtasks /query` finds no `VisibleGov` task. Draft-then-apply honored. ✅
++
++**gloss.js / extract-terms.js / golden.js untouched** — `git diff --name-only de2bf54..3e12a1e` on
++those three paths returns 0 files. The brief's "do not refactor the existing ones" holds. ✅
++
++**Project law (1000-row cap)** — the only multi-row read in the new code is
++`resolveUsCongressRollWindow`, correctly routed through `selectAll` (`scheduled-ingest.js:293`).
++The other two DB helpers are single-row (`.limit(1).maybeSingle()` / unique-key `.maybeSingle()`).
++See question B for the empirical check. ✅
++
++---
++
++## Answers to the three open review questions
++
++### A. LegiScan session resolution — deterministic and NULL-proof? **YES, provably.**
++
++Live state (read-only probe of the `sessions` table, `jurisdiction_id = 'mo-legislature'`, 33 rows
++total) — the two 2026-named rows are:
++
++| id | identifier | name | legiscan_session_id |
++|---|---|---|---|
++| `4f…` | **`2026`** | `2026 Regular Session (MO Senate journals)` | **NULL** |
++| `bf3c7f23-358d-4399-8279-3a8e60a96eda` | **`261`** | `2026 2nd Regular, 103rd General Assembly` | **2239** |
++
++The resolver (`scripts/scheduled-ingest.js:266-275`) filters on
++`.eq('jurisdiction_id','mo-legislature').eq('identifier', DEFAULT_MO_HOUSE_SESSION)` where
++`DEFAULT_MO_HOUSE_SESSION = '261'` (`src/adapters/mo-house-xml.js:22`). It **never** orders,
++**never** takes "most recent", and **never** falls back.
++
++Three independent reasons it cannot pick the NULL row or flip:
++
++1. **The predicate excludes it.** The NULL row's `identifier` is `'2026'`, not `'261'`. The
++   equality filter can never match it.
++2. **The schema forbids ambiguity.** `supabase/migrations/0001_core_schema.sql:16` declares
++   `unique (jurisdiction_id, identifier)` on `sessions`. The two-column filter therefore matches
++   **at most one row, ever** — `.maybeSingle()` cannot hit PostgREST's multiple-rows error, and
++   there is no set of rows for it to "flip" between. This is a database-level guarantee, not a
++   convention.
++3. **NULL is handled explicitly anyway.** Line 274 returns `null` unless
++   `legiscan_session_id != null`, and `buildRegistry` turns that into `resolvable: false` +
++   an honest `unresolvedReason`, which `pickMostOverdue` filters out (`:200`). Even if the NULL row
++   were somehow selected, the outcome would be an honest skip, not a wrong session id.
++
++Replayed the exact query against live data: returns `{"legiscan_session_id":2239}`. Deterministic.
++
++**Caveat (Important, not a defect in the resolver):** the *error* path is not as isolated as the
++docs claim — see finding I3.
++
++### B. us-congress forward window — reviewed hardest, as instructed.
++
++**Is the max-roll read subject to the 1000-row cap? NO — correctly avoided.**
++`resolveUsCongressRollWindow` (`scheduled-ingest.js:289-302`) goes through `selectAll`, which pages
++at 1000 with a `maxPages` guard that throws rather than return a truncated result
++(`src/lib/db.js:85-105`). Verified empirically: the filtered set is **283 rows** today
++(`votes` is 9,981 rows overall, so a bare `.select()` here would have been a live landmine); the
++paginator returned all 283 and the parsed roll count matched exactly (283/283, no drops). A bare
++`.select()` would happen to work today and silently break around November of a busy session year —
++it was not used. ✅
++
++**Is it bounded? YES.** `computeRollWindow` is `max+1 .. max+windowSize`, `windowSize = 10`, and
++`parseRollRange` (`src/cli/ingest.js:8-14`) materializes exactly that many integers. Live window:
++`{lo: 284, hi: 293}`. Worst case per tick = 1 member-list call + 10 clerk.house.gov roll fetches +
++≤10 bill-detail calls, all on existing limiters (`clerkLimiter` 1 req/s, `congressLimiter`
++1 req/3.6s). Bounded. ✅
++
++**Is it idempotent? YES.** `votes.source_key` is the conflict key and persistence is
++`insertIfAbsent`, so re-probing an already-ingested roll is a genuine no-op. The window is derived
++fresh from the DB each tick, so it is self-correcting rather than stateful. ✅
++
++**Is it 404-tolerant? YES, structurally.** `ingest.js:67-70` catches `SourceFetchError` per roll
++and pushes to `failures[]` — "skip != empty: recorded, not silent". `fetchWithLimit`
++(`src/lib/http.js:30-32`) types any non-ok status as `SourceFetchError`, so a 404 on an unpublished
++roll lands in that catch. ✅ **But see I4** — that tolerance has a cost the implementer did not
++trace.
++
++**Is it on the polite limiter? YES.** `fetchHouseRollCall` defaults to `clerkLimiter`
++(1000 ms) and `fetchBillDetail`/`fetchMemberList` to `congressLimiter` (3600 ms), both
++pre-existing (`src/adapters/us-congress.js:7-8`). The scheduler adds no new fetch path. ✅
++
++**Is the interval floored ≥1h? YES.**
++`envIntervalMs('US_CONGRESS_MIN_INTERVAL_MS', ONE_HOUR_MS, ONE_HOUR_MS)` — default *and* floor are
++both 1h, so an env override can only raise it. Non-numeric/zero/negative falls back to the default,
++then `Math.max`. ✅
++
++**Gap-stall risk: real but currently nil.** The window only advances if some roll in
++`max+1..max+10` exists, so a contiguous missing run of >10 rolls would stall it permanently.
++Checked live: rolls 1–283 for 2026 are **contiguous, largest interior gap = 0**. Not a present
++concern; worth knowing it is the failure mode if it ever stops advancing.
++
++**Verdict on B: the inference is sound and the implementation is correct.** The two things the
++implementer did *not* trace are I4 (the 404 tolerance makes `partial`/exit-2 the permanent healthy
++state, poisoning the log and forcing an hourly aggregate refresh) and I5 (the Senate half of
++"federal votes" is still unscheduled). Neither invalidates the window design.
++
++### C. Docs honesty — **FAILED. The overclaim is present and is factually false.**
++
++`docs/SCHEDULED_INGESTION.md:151-155`:
++
++> Separately, **TODO.md item 25** documents a real, currently-open duplicate-MO-session defect
++> (session `'2026'` vs `'261'`) caused by a *different*, **non-scheduler source** (not
++> `mo-house-xml`, whose default session — `261` — is already the correct one). **This scheduler's
++> registry does not touch whatever is producing that duplicate**; it's flagged here only so it
++> isn't mistaken for something this script caused.
++
++Both bolded claims are false, and I re-proved it end to end rather than taking the controller's
++word:
++
++1. `src/cli/ingest-mo-senate.js:470-474` — `ensureSessionRow(client, runId, year)` does
++   `insertIfAbsent(client, 'sessions', [{ jurisdiction_id: 'mo-legislature', identifier:
++   String(year), name: \`${year} Regular Session (MO Senate journals)\` }], …)` — with **no
++   `legiscan_session_id`**.
++2. Live DB: the NULL row is `identifier '2026'`, `name "2026 Regular Session (MO Senate
++   journals)"` — byte-for-byte the string that line 473 constructs. There is no other producer.
++3. `runMoSenate` calls `ensureSessionRow` on every invocation
++   (`ingest-mo-senate.js:1042` region), and the scheduler's **first registry entry**
++   (`scheduled-ingest.js:320-328`) runs exactly `src/cli/ingest-mo-senate.js --year 2026 --limit 1`.
++
++So `mo-senate-web` **is** in the registry, **is** the feeder, and registering this scheduler
++**continues** feeding the split every 30 minutes until TODO 25's merge lands. TODO.md:261 already
++says as much in its own words: *"it grew 15→16 bills during the audit: the cron is feeding the
++duplicate."*
++
++The honest framing is **neutral-vs-today**: the scheduler does the same thing the manual bash loop
++already did — it neither creates nor worsens the defect relative to current practice — but it is
++absolutely not unrelated to it, and it will keep it alive on a durable, unattended cadence rather
++than a session-lifetime one.
++
++**Clean by comparison** (no change needed): `scripts/scheduled-ingest.js:258-265`
++(`resolveLegiscanSessionId`'s own comment) and `:359-360` (the `unresolvedReason` string) both
++mention TODO 25 **without** claiming the scheduler is unrelated to it. Only the doc overclaims.
++
++---
++
++## Findings
++
++### 🔴 Critical
++
++**C1 — A source whose CLI fails before `openRun` is re-picked on every 15-minute tick forever,
++permanently starving every other source.**
++`scripts/scheduled-ingest.js:199-203` (`pickMostOverdue`), `:186-192` (`computeSourceDueness`);
++root cause `src/cli/ingest.js:536` vs `:556`.
++
++The scheduler's only due-ness clock is `ingestion_runs.started_at`, written by the *child*. It
++records no attempt of its own. Three of the four registry CLIs call `openRun` **before** any
++network work — `ingest-mo-senate.js:1041-1042` (`enforceDurableCooldown` then `openRun`),
++`ingest-mo-house.js:940`, `ingest-legiscan.js:1064`. **`ingest.js` is the exception**: it runs the
++entire `collect()` (member-list fetch + up to 10 roll fetches + bill details) at line 536 and only
++calls `openRun` at line 556. And `collectUsCongress`'s very first statement,
++`await us.fetchMemberList('MO')` (`ingest.js:46`), is **outside** the per-roll try/catch and is
++fatal by design ("throws on failure: fatal, nothing to reconcile").
++
++So any persistent congress.gov condition — expired/rotated `CONGRESS_API_KEY` (403), an API
++outage (5xx), a 429, a network blip — throws before line 556, **no `ingestion_runs` row is ever
++written**, and `lastStartedAtIso` for `us-congress` stays frozen. Consequences, all silent:
++
++- `us-congress`'s `elapsedMs` keeps growing and can never be overtaken, because every other
++  source's `elapsedMs` grows at the same rate from a lower start. `pickMostOverdue` returns
++  `us-congress` on **every tick, forever**.
++- `mo-senate-web`, `mo-house-xml` and `legiscan` **never run again**. Freshness — the entire point
++  of this build — silently dies while the log keeps saying `mode: "live"`.
++- congress.gov/clerk.house.gov get hit **every 15 minutes** instead of the 1-hour interval this
++  script declares for itself — a 4× overrun of its own stated conservative cadence, up to ~11
++  requests per tick, indefinitely.
++- The scheduler still exits **0** every tick (the child's failure is "logged and reported, never
++  crashes the scheduler"), so Task Scheduler's history shows a healthy green task the whole time.
++
++**This is live on day one, not hypothetical.** `us-congress` currently sits at
++`started_at = 2026-07-28T04:40Z` (n=3 runs) — ~91 hours overdue — and the dry run confirms it is
++the source chosen on the very first tick. If that first live run fails at `fetchMemberList`, the
++scheduler is wedged from the moment it is registered, and the only symptom is a log file nobody is
++watching.
++
++Shape of a fix (not applied, per instructions): give the scheduler its own attempt record —
++persist the tick's chosen source + timestamp (the lock file or a small sidecar is enough) and rank
++on `max(child started_at, own last attempt)`, so a failing source backs off at its own interval
++instead of monopolizing the picker. A per-source consecutive-failure backoff would also work.
++
++**C2 — `docs/SCHEDULED_INGESTION.md:151-155` states, twice, something the controller already
++disproved.** Full proof under question C above. This is a direct violation of the brief's docs
++deliverable and of `CLAUDE.md`'s "everything traceable… no editorializing" standard. The fix is a
++wording change to neutral-vs-today, not a code change. Because this doc is what Lance reads before
++deciding to register a forever-task on his own machine, a false "not us" claim in it is a shipping
++gate, not a nit.
++
++### 🟠 Important
++
++**I1 — `releaseLock()` is ownership-blind, so one slow run can unlock a *different* run's lock and
++un-do the single-instance guarantee.**
++`scripts/scheduled-ingest.js:176-178`, called from the `finally` at `:536-540`.
++
++`releaseLock` does `if (existsSync(lockPath)) unlinkSync(lockPath)` — it never checks whether the
++lock it is deleting is still *its own*. Sequence: tick A takes the lock at T and its child hangs.
++At T+10min tick B finds the lock stale, reclaims it (overwriting with B's pid) and starts its own
++child. At T+12min tick A finally returns and its `finally` deletes **B's** lock. Tick C at T+15min
++finds no lock, takes a fresh one, and starts a **third** concurrent child. The "INCAPABLE OF
++STACKING OVERLAPPING PROCESSES" guarantee in the header comment (`:19-23`) degrades to unbounded
++stacking the moment any single run exceeds `MAX_RUN_DURATION_MS`.
++
++A >10-minute run is not exotic: `ingest-legiscan.js` on a *changed* `dataset_hash` downloads and
++processes a full LegiScan MO dataset against a 38,266-bill table, and LegiScan refreshes weekly.
++Mitigating factor that keeps this out of Critical: the **published ToU is still protected** by each
++MO CLI's own `enforceDurableCooldown`, which re-reads `ingestion_runs` and sleeps — so overlapping
++children cannot violate house.mo.gov/senate.mo.gov. What breaks is the scheduler's own stacking
++guarantee and the doc's claim about it. Fix shape: compare pid + `startedAt` against the payload
++this process wrote before unlinking.
++
++**I2 — No timeout anywhere on the child, which is what makes I1 reachable.**
++`scripts/scheduled-ingest.js:373-375` (`defaultSpawn`), `:384-395` (`runChildCli`);
++`src/lib/http.js:18-36`.
++
++`spawnSync` is called with no `timeout` option, and `fetchWithLimit` passes no `AbortSignal` to
++`fetch` (Node's `fetch` has no default response timeout). A single stalled TCP connection inside
++any child hangs the scheduler indefinitely, holding the lock, which is precisely the precondition
++for I1. For a process that runs unattended forever, an explicit `timeout: MAX_RUN_DURATION_MS` on
++`spawnSync` — so the scheduler kills its own child at exactly the threshold at which it declares
++that child dead — would close both this and I1's window.
++
++**I3 — "it does not block the other three sources" is only true for the `null` path; a *thrown*
++lookup aborts the entire tick.**
++`docs/SCHEDULED_INGESTION.md:149`; `scripts/scheduled-ingest.js:310-317`.
++
++`buildRegistry` runs all six lookups in a single `Promise.all`. `resolveLegiscanSessionId` throws
++on any Supabase error (`:273`), as do `queryLatestStartedAt` (`:254`) and
++`resolveUsCongressRollWindow` (`:296`). One rejection rejects the whole `Promise.all`, propagates
++out of `main()`, and exits 1 — **no source runs at all that tick**. The doc's reassurance holds
++only for the "row absent / column null" case it was written about. Either wrap each lookup so a
++per-source failure degrades to `resolvable: false`, or correct the sentence.
++
++**I4 — `partial` + child exit 2 is the permanent *healthy* state for `us-congress`, which poisons
++the log and forces an hourly aggregate refresh.**
++`scripts/scheduled-ingest.js:239-242` (`runWroteSomething`); `src/cli/ingest.js:69, 560, 568`.
++
++The 10-roll probe window is designed to overshoot, so on a typical tick most of the window 404s.
++Each 404 is recorded in `failures[]` (`ingest.js:69`), which makes `status = 'partial'`
++(`:560`) and sets `process.exitCode = 2` (`:568`). Two consequences neither the code nor the docs
++acknowledge:
++
++- Every hourly `us-congress` entry will read `exitStatus: 2, status: "partial", failures: [ … ]`
++  **forever, even when everything is perfect**. The one artifact Lance is told to read to know the
++  scheduler is alive will train him to ignore exactly the fields that would signal a real failure.
++- `runWroteSomething` returns `true` for `'partial'`, so `scripts/refresh-aggregates.js` is spawned
++  on **every** `us-congress` tick — hourly, indefinitely, whether or not a single new vote arrived.
++  The ledger's over-refresh proxy was reviewed as an occasional over-run; in practice it is
++  unconditional-hourly. (Cheap and idempotent, so this is a cost/noise issue, not a correctness
++  one — but it is not what the comment at `:229-238` describes.)
++
++**I5 — Senate roll calls remain unscheduled; only the House half of "federal votes" is solved.**
++`scripts/scheduled-ingest.js:107` (`SOURCE_KEYS`); `docs/SCHEDULED_INGESTION.md:213`.
++
++`ingest.js` has a **separate** `us-senate` source with its own branch (`:531-533`), its own
++`openRun(client, 'us-senate')` (`:506`), 4 prior runs and **869 `us-senate-*` vote rows** live.
++`collectUsCongress` fetches House rolls only. The registry has no `us-senate` entry, so new Senate
++roll calls still never arrive. The doc's phrasing — *"the one federal stream that had no scheduled
++ingestion before this"* — is true of the House but reads, in a doc whose whole subject is freshness,
++as if federal votes are now covered. The brief did name only `us-congress`, so this is arguably
++in-scope-as-written; flagging it because the gap is invisible from the doc and Lance is the one who
++will be surprised by it.
++
++### 🟡 Minor
++
++**M1 — Log files are dated by UTC while the doc tells Lance to open "today's file."**
++`scripts/scheduled-ingest.js:410` (`entry.timestamp.slice(0, 10)` on an ISO-Z string);
++`docs/SCHEDULED_INGESTION.md:256-260`. Observed live: a run at **19:11 local on 2026-07-31** wrote
++`.superpowers/artifacts/scheduler-logs/**2026-08-01**.log`. Every evening after 7pm Central,
++"today's log" is tomorrow's filename, and the "is the last entry more than ~20 minutes old" check
++sends you to an empty or nonexistent file. Local-date naming, or a note in the doc, would fix it.
++
++**M2 — `spawnSync` runs with Node's default 1 MB `maxBuffer`, and overflow is reported as a
++misleading "could not launch".** `scripts/scheduled-ingest.js:373-375, 386-390`. On overflow
++`spawnSync` **kills the child** and sets `result.error` (ENOBUFS) — which `runChildCli` turns into
++`could not launch ${scriptPath}`, a message that points at a bad path when the real cause is a
++chatty child that was terminated mid-run. Low likelihood at `--limit 1` (the CLIs have 2–11
++`console.error` sites), but the failure mode is silent truncation plus a wrong diagnosis, on the
++one process nobody is watching. An explicit `maxBuffer` and a distinct ENOBUFS message would cost
++two lines.
++
++**M3 — `buildRegistry` unconditionally performs all six lookups, including a paginated `selectAll`,
++even for `--only <other-source>` and `--dry-run`.** `scripts/scheduled-ingest.js:310-317`. The
++283-row `votes` scan and the `sessions` lookup run every 15 minutes forever regardless of which
++source is scoped. Small today, purely wasted, and grows with the vote table. Making the two
++resolvers lazy (only for the entry actually under consideration) would also shrink I3's blast
++radius.
++
++**M4 — `summarize.js` / `verify.js` print no cost estimate before blocking, unlike `gloss.js`.**
++`src/cli/gloss.js:228-229` prints `Cost estimate: N term(s) x ~$X = ~$Y` *before* its gate, so even
++a blocked run tells Lance the scale of what he is approving. The new gates
++(`src/cli/summarize.js:299-308`, `src/cli/verify.js:173-182`) print only the BLOCKED line.
++`CLAUDE.md`'s policy is worded as "explicit per-run approval, **with call count + dollar estimate
++stated up front**". The brief asked only for the guard-clause shape, so this is brief-compliant —
++noting it because the policy it implements asks for slightly more, and both files already know
++their candidate count at that point (`plan.needSummary.length` / `unverified.length`).
++
++**M5 — observation only, no change requested.** `scheduled-ingest.js:543`'s `invokedDirectly`
++basename-suffix heuristic is a substring test rather than a URL identity comparison, but it is
++copied verbatim from every existing CLI in this repo (`ingest.js:571`, `ingest-legiscan.js:1106`,
++…). Consistency with the codebase is the right call here; changing it in one file would be worse.
++Verified it behaves correctly under `node --test` (argv[1] is the test file, so `main()` does not
++fire on import) and under a real spawn.
++
++---
++
++## What is genuinely good (so the fixes don't regress it)
++
++- **Due-ness is computed, never guessed.** `remainingCooldownMs` is imported
++  (`scheduled-ingest.js:51`) and used unmodified (`:187`); the arithmetic is nowhere duplicated.
++  The `elapsedMs` / `remainingMs` split is the right call — `Math.max(0, …)` clamps every due
++  source to 0, so `remainingMs` alone genuinely cannot rank two due sources, and the comment at
++  `:182-185` says exactly that.
++- **`acquireLock`'s `'wx'` atomic create** (`:154`) closes the check-then-act race properly, and
++  treating a corrupt lock as stale (`:160-165`) is the right failure direction — a half-written
++  lock from a killed process can't wedge every future tick.
++- **The three suspension-level / data-integrity rules all hold mechanically**, not by comment:
++  no model in the import graph, no env path to a MO cadence, no `dataset_hash` logic outside
++  `ingest-legiscan.js`, no `--session` reachable by `mo-house-xml`.
++- **Test quality is high.** 50 new tests, `spawnFn` injected so nothing hits the network or the DB,
++  a real-subprocess smoke test using a throwaway `.env` in a temp dir (so it survives a fresh
++  checkout where `.env` is gitignored), and the TODO-31 restriction asserted structurally rather
++  than trusted to a comment. The `fakeRegistryClient` closure comment at
++  `tests/scheduled-ingest.test.js:1511-1513` documents a real trap it hit.
++- **Task 1's shared `assertRunApproved`** is a small, defensible deviation from "mirror the shape":
++  it preserves the exact `!== 'yes'` strictness, keeps gloss.js's message voice, adds a typed
++  `RunNotApprovedError` in the file's existing convention, catches locally so the CLI prints one
++  clean line instead of a stack trace, and — importantly — leaves the three pre-existing gates
++  untouched, which is what the brief actually forbade changing. Tests assert each message names
++  its own env var and no other CLI's.
++
++---
++
++## Required before this is registered with Task Scheduler
++
++1. Fix **C1** — a failing child must not be able to monopolize the picker. This is the one that
++   compounds silently for weeks, which is exactly the failure class this review was asked to catch.
++2. Fix **C2** — correct `docs/SCHEDULED_INGESTION.md:151-155` to the neutral-vs-today framing.
++3. Recommended in the same pass, cheap and closes a real hole: **I1** (ownership-checked release)
++   + **I2** (`timeout` on `spawnSync`).
++
++Task 1 (`41936f0`) can ship independently and immediately.
+diff --git a/docs/SCHEDULED_INGESTION.md b/docs/SCHEDULED_INGESTION.md
+index 666d395..a56b738 100644
+--- a/docs/SCHEDULED_INGESTION.md
++++ b/docs/SCHEDULED_INGESTION.md
+@@ -2,80 +2,148 @@
+ 
+ The first thing in this repo designed to run **unattended, on Lance's machine, forever**, with no
+ human watching a single invocation. Everything about its design follows from that one fact. This
+ doc is what he needs to register it (his own step — an agent never runs `schtasks`) and to keep an
+ eye on it afterward.
+ 
+ ## What it does
+ 
+ Each invocation:
+ 
+-1. Takes a single-instance lock (`.superpowers/artifacts/scheduler.lock.json`). If another
+-   invocation is already holding it, this one logs `already-running` and exits 0 — that is a
+-   **normal**, expected outcome (see cadence below), never a failure.
+-2. Checks all four ingestion sources' real due-ness by querying `ingestion_runs` for each one's
++1. Takes a single-instance, ownership-checked lock
++   (`.superpowers/artifacts/scheduler.lock.json`, pid + a random nonce + a declared max duration).
++   If another invocation is already holding it, this one logs `already-running` and exits 0 —
++   that is a **normal**, expected outcome (see cadence below), never a failure. A lock older than
++   its OWN declared max duration is reclaimed as stale (10 minutes by default; a source's real
++   per-source timeout once one has been chosen — see *Per-source timeouts* below for why one
++   fixed number doesn't work here); releasing the lock always re-checks the nonce first, so a run
++   that hung long enough to be reclaimed can never delete a *newer* tick's lock out from under it.
++2. Checks all five ingestion sources' real due-ness by querying `ingestion_runs` for each one's
+    last `started_at` and comparing against its own minimum interval — the *same* durable,
+    cross-process signal the ingest CLIs' own cooldown check (`enforceDurableCooldown`) already
+-   relies on. **It never blindly invokes a CLI.**
++   relies on. **It never blindly invokes a CLI.** Each source's own lookup is isolated: if one
++   fails (a transient DB hiccup, say), that source is skipped for the tick and logged with a
++   reason — the other four are unaffected.
+ 3. Picks the single **most overdue** due source (the one that has gone longest since it last ran)
+-   and runs it as a short child process: `node --env-file=.env <cli> --limit 1` (or the equivalent
+-   for that source — see the registry table below). At most one source per tick.
+-4. If that run actually wrote anything, refreshes the vote aggregates
++   and runs it as a short, timeout-bounded child process: `node --env-file=.env <cli> --limit 1`
++   (or the equivalent for that source — see the registry table below). At most one source per
++   tick. Two distinct honest-recovery paths, depending on how the CLI failed:
++   - If it fails in a way that leaves **no new** `ingestion_runs` row at all (a hard crash, a
++     timeout, an upstream outage before the CLI's own bookkeeping starts — this is `us-congress`/
++     `us-senate`'s own shape, since `ingest.js` does its network work before it ever records
++     anything), the scheduler writes its own honest **failed attempt** record — never a fake
++     success — so that source's due-ness clock still advances and a persistently-failing source
++     cannot monopolize every future tick.
++   - If the timeout (or a buffer overflow) forcefully kills a CLI that HAD already opened its own
++     run row (`mo-senate-web`/`mo-house-xml`/`legiscan` all open their row before their long
++     work), that row would otherwise be stranded at `status='running'` forever — lying about state
++     to anyone reading it (`public_freshness` included) while still silently advancing due-ness.
++     The scheduler closes it honestly instead: `status='failed'`, `detail.scheduler_kill: true`,
++     scoped so it can only ever touch a row this exact tick could plausibly have created.
++4. If that run's own recorded counts show it actually wrote rows, refreshes the vote aggregates
+    (`scripts/refresh-aggregates.js`) — the same standing practice every ingest batch has always
+-   followed, so the profile charts never silently drift behind the vote lists.
+-5. Logs one entry — to stdout and to a dated file — recording what it checked, what it chose (or
+-   why nothing was due), the CLI's own honest counts, and whether aggregates were refreshed.
++   followed, so the profile charts never silently drift behind the vote lists. A tick whose only
++   "failures" are the probe window's own expected past-the-edge 404s (see `us-congress`/
++   `us-senate` below) is recognized as healthy and does not spuriously trigger this.
++5. Logs one entry — to stdout and to a dated (UTC) file — recording what it checked, what it chose
++   (or why nothing was due), the CLI's own honest counts, and whether aggregates were refreshed.
+ 
+ ## What it will never do
+ 
+ - **Never calls a model.** It imports no Anthropic client, no `lib/summarizer.js`, no
+-  `lib/verifier.js` — nothing that can bill Lance's account. It only ever spawns the four
++  `lib/verifier.js` — nothing that can bill Lance's account. It only ever spawns the five
+   ingestion CLIs below and `scripts/refresh-aggregates.js`. This is enforced by the import list,
+   not just a comment; verify by inspection if this file ever changes.
+ - **Never violates a published rate limit.** The MO Senate and MO House intervals below are
+   imported directly from the adapters that already encode senate.mo.gov's / house.mo.gov's real
+   published terms — they are **not environment-overridable**, so a typo'd env var cannot shorten
+-  them. The two intervals this script chooses itself (us-congress, legiscan) are
++  them. The intervals this script chooses itself (us-congress, us-senate, legiscan) are
+   environment-overridable but mechanically floored at the values below: an override can only make
+   them *more* conservative, never less.
+ - **Never runs a MO House historical/multi-era backfill.** `mo_house_id` is a table-wide unique
+   constraint (migration 0005) against the *current* roster only — passing a historical year/session
+   to the House CLI would silently misattribute a successor's votes to their predecessor (TODO item
+   31). The registry entry for `mo-house-xml` passes `--limit 1` only, nothing else, permanently.
+ - **Never stacks overlapping processes.** The single-instance lock (step 1 above) and the
+-  due-ness check (step 2) both have to agree before anything runs.
++  due-ness check (step 2) both have to agree before anything runs. The lock's own release is
++  ownership-checked (nonce-based), and every child process runs under an explicit, per-source
++  timeout (see *Per-source timeouts* below) — the lock's own declared stale-reclaim window is
++  updated to match that exact timeout right before the child is spawned, so a later tick's
++  staleness check is always judging the run against its real bound, never a generic number that
++  could be shorter than a legitimately still-running child. A single hung child can therefore
++  never hold the lock indefinitely, and can never be mistaken for stale by a later tick while it
++  is still legitimately within its own budget.
++- **Never lets one failing source starve the others.** `ingest.js` (the `us-congress`/`us-senate`
++  CLI) does its network work before it records anything — a persistent upstream failure there used
++  to leave no durable trace at all, which would have let that one source win the "most overdue"
++  pick on every tick forever. The scheduler now closes that gap itself (see step 3 above).
+ - **Never guesses a LegiScan session id.** If `sessions.legiscan_session_id` isn't on file for the
+   current MO session, the `legiscan` source is reported `resolvable: false` and skipped, with the
+-  reason logged — never an "most recent session" heuristic. See *Known gap* below for why.
++  reason logged — never a "most recent session" heuristic. See *Known gap* below for why.
+ 
+ ## ⚠️ The MO cadences are published Terms of Service, not our own caution
+ 
+ `MO_SENATE_MIN_INTERVAL_MS` and `MO_HOUSE_MIN_INTERVAL_MS` (30 minutes each) are
+ **senate.mo.gov's and house.mo.gov's own published rate limits**. They are imported verbatim from
+ `src/adapters/mo-senate-web.js` / `src/adapters/mo-house-xml.js` — the same constants the ingest
+ CLIs' own `enforceDurableCooldown` enforces — and are not exposed as environment variables at all.
+ **Do not shorten these**, in this file or anywhere else. house.mo.gov's ToU caps automated pulls at
+ once per 30 minutes; that is why the House backfill was never a volume strategy (see
+ `docs/DATA_INVENTORY.md`/CHATLOG for "the text unlock").
+ 
+ ## The registry
+ 
+ | Source | Command | Interval | Why |
+ |---|---|---|---|
+ | `mo-senate-web` | `ingest-mo-senate.js --year <current> --limit 1` | 30 min | senate.mo.gov's published terms (imported, not configurable) |
+ | `mo-house-xml` | `ingest-mo-house.js --limit 1` | 30 min | house.mo.gov's published terms (imported, not configurable) — **current session only, never `--session`** |
+-| `us-congress` | `ingest.js --source us-congress --year <current> --rolls <lo>-<hi>` | ≥1 hour (`US_CONGRESS_MIN_INTERVAL_MS`, default 1h) | Congress.gov has its own polite limiter already; this is our own conservative check-frequency choice. `<lo>-<hi>` is computed each tick from the highest US House roll number already on file — a small forward window past it. Every roll in that window that doesn't exist yet 404s harmlessly (recorded, non-fatal); every roll that already exists is a no-op. This is the one federal stream that had **no** scheduled ingestion before this — new House roll calls simply never arrived. |
++| `us-congress` | `ingest.js --source us-congress --year <current> --rolls <lo>-<hi>` | ≥1 hour (`US_CONGRESS_MIN_INTERVAL_MS`, default 1h) | Congress.gov has its own polite limiter already; this is our own conservative check-frequency choice. `<lo>-<hi>` is computed each tick from the highest US **House** roll number already on file — a small forward window past it. Every roll in that window that doesn't exist yet 404s harmlessly (recorded, non-fatal, and recognized as an expected "nothing new yet" outcome rather than a real failure); every roll that already exists is a no-op. |
++| `us-senate` | `ingest.js --source us-senate --session <current> --votes <lo>-<hi>` | ≥1 hour (`US_SENATE_MIN_INTERVAL_MS`, default 1h) | The Senate half of "federal votes" — a separate source from `us-congress` above (same CLI, different `--source`), with its own probe window computed the same way from the highest US **Senate** vote number already on file. Without an explicit `--votes` range, this CLI's own default behavior is to refetch and reparse the *entire* session's vote menu every invocation, which is wrong for a scheduled tick — the window keeps each invocation short and bounded, same as the House side. |
+ | `legiscan` | `ingest-legiscan.js --session <resolved id>` | ≥24 hours (`LEGISCAN_MIN_INTERVAL_MS`, default 24h) | Datasets refresh weekly (Sunday 5am ET); `ingest-legiscan.js`'s own `dataset_hash` gate (⛔ suspension-level LegiScan rule) makes a same-dataset tick cheap. `<resolved id>` comes from `sessions.legiscan_session_id` for the current MO session — see *Known gap* below if this ever reports `resolvable: false`. |
+ 
+-`US_CONGRESS_MIN_INTERVAL_MS` / `LEGISCAN_MIN_INTERVAL_MS` can be raised via `.env` if Lance ever
+-wants these to run less often; any value below the defaults above is silently floored back up to
+-them.
++Both federal streams (House and Senate) are covered by this scheduler — before this build, *neither*
++had scheduled ingestion, so new federal roll calls simply never arrived.
++
++`US_CONGRESS_MIN_INTERVAL_MS` / `US_SENATE_MIN_INTERVAL_MS` / `LEGISCAN_MIN_INTERVAL_MS` can be
++raised via `.env` if Lance ever wants these to run less often; any value below the defaults above
++is silently floored back up to them.
++
++## Per-source timeouts — why legiscan is different
++
++Every child process runs under a hard timeout (`spawnSync`'s own `timeout` option): if a CLI
++hasn't finished by then, the scheduler kills it rather than risk hanging forever. Four of the five
++sources share one **8-minute default** (`CHILD_TIMEOUT_MS`). `legiscan` gets its own, much larger
++**75-minute** budget (`LEGISCAN_CHILD_TIMEOUT_MS`).
++
++This isn't a guess — it came from reading `legiscan`'s own history in `ingestion_runs`. Real runs
++against the scheduler's actual target session (`'261'`, `legiscan_session_id 2239`) took **449.3s
++and 475.7s** — within, but uncomfortably close to, the old single 480s (8-minute) budget every
++source originally shared. A separate historical run (a genuine dataset-hash-changed
++reprocessing — the case `ingest-legiscan.js`'s own `dataset_hash` gate exists for, not a cheap
++hash-match skip) took **3168.5s (~52.8 minutes)**. 75 minutes is that observed maximum plus ~40%
++headroom, rounded up.
++
++**Why the other four sources don't need this:** `mo-senate-web`'s real historical runs never
++exceeded 9.6 seconds; `us-congress`/`us-senate`'s small sample never came close to 8 minutes
++either. `mo-house-xml` LOOKS like an exception in raw `ingestion_runs` history (some runs show
++~30-minute durations) — investigated and ruled out: those are exact 1800.0-second multiples,
++which is `enforceDurableCooldown` *sleeping out* the old manual bash-loop's premature
++invocations, not real work. This scheduler's own due-ness gate never invokes a CLI before its
++cooldown has elapsed, so that scenario cannot recur under it.
++
++**Why this matters beyond just "don't kill a slow run": the lock itself has to know about it
++too.** A fixed 10-minute stale-reclaim window and a legitimately 75-minute `legiscan` run cannot
++coexist — a second tick 15 minutes in would see the lock as stale, reclaim it, and start a
++*second* concurrent `legiscan` process, exactly the overlapping-process problem the lock exists to
++prevent. So the lock's own declared stale-reclaim duration is updated to match the CHOSEN
++source's real timeout right before that source is spawned (see "What it does," step 1) — a
++`legiscan` tick's lock is only ever considered stale after ~76 minutes, not 10.
+ 
+ ## Registering it (Lance's step — never run `schtasks` from an agent)
+ 
+ Run every 15 minutes — deliberately shorter than every source's own interval above, so a tick is
+ never more than ~15 minutes late; the per-source cooldowns above do the real gating, not this
+ number.
+ 
+ **Command line** (adjust the `node.exe` path if `where node` gives something different; using
+ absolute paths throughout means Task Scheduler's working directory doesn't matter):
+ 
+@@ -95,29 +163,54 @@ schtasks /create /tn "VisibleGov Scheduled Ingestion" ^
+   will prompt for your password once).
+ - `/f` overwrites a prior registration with the same name — safe to re-run this command if you
+   ever change the schedule.
+ 
+ **GUI equivalent**, if preferred: Task Scheduler → Create Task → General: name it; Triggers → New →
+ "On a schedule" → Daily, repeat task every **15 minutes** for a duration of **Indefinitely**;
+ Actions → New → Program: `C:\Program Files\nodejs\node.exe`, Arguments:
+ `--env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-ingest.js`, Start in:
+ `F:\VisibleGov` (redundant with the absolute `--env-file` path, but harmless to set).
+ 
++### ⚠️ Check the task's own "Stop the task if it runs longer than" setting — it must EXCEED 75 minutes
++
++This is a **separate setting from everything above** — it's Windows' own execution-time limit on
++the *whole scheduled task*, not anything this script controls. The `schtasks /create` command
++above does not set it explicitly, so **check it via the GUI after creating the task**: Task
++Scheduler → find "VisibleGov Scheduled Ingestion" → Properties → **Settings tab** → "Stop the task
++if it runs longer than."
++
++If that value is *shorter* than `legiscan`'s own 75-minute timeout, Windows will kill the entire
++scheduler process itself partway through a legitimate `legiscan` run — and because that's a forced
++process termination from OUTSIDE this script (not `spawnSync`'s own timeout), **none of this
++script's own honest-recovery logic gets a chance to run**: the lock is never released by its own
++`finally` block (it self-heals eventually via the next tick's stale-reclaim, which is fine), but
++any `ingestion_runs` row `legiscan` had already opened would be stranded at `status='running'`
++with nothing to close it — exactly the lying-about-state problem this build went out of its way to
++prevent, reintroduced from a layer above it.
++
++**Recommendation: uncheck "Stop the task if it runs longer than" entirely, or set it to at least 2
++hours.** This script's own per-source timeouts (8 minutes default, 75 minutes for `legiscan`) are
++the real enforcement — Windows' own limit only needs to be generous enough to never fire first.
++
+ ## How to verify it is alive
+ 
+ Two independent signals, on purpose — one from the scheduler's own perspective, one from the data's:
+ 
+ 1. **The log file.** `.superpowers/artifacts/scheduler-logs/YYYY-MM-DD.log` (gitignored, one entry
+-   per tick). A healthy scheduler shows an entry roughly every 15 minutes, alternating between
+-   `nothing-due`, `already-running`, and occasional `live` runs as each source's cooldown elapses.
+-   `tail`/open today's file; if the last entry is more than ~20 minutes old, the scheduled task
+-   itself has stopped firing (check Task Scheduler's history, not this repo).
++   per tick). **The date in the filename is UTC, not local time** — Central time is 5-6 hours
++   behind UTC, so any time after ~7pm Central (6-7pm during daylight time), "today's" log entries
++   are already landing in *tomorrow's* dated file. If the file you'd expect looks stale or is
++   missing entirely, check the next day's filename before assuming the scheduler stopped. A
++   healthy scheduler shows an entry roughly every 15 minutes, alternating between `nothing-due`,
++   `already-running`, and occasional `live` runs as each source's cooldown elapses; if the most
++   recent entry across both today's-UTC and tomorrow's-UTC files is more than ~20 minutes old, the
++   scheduled task itself has stopped firing (check Task Scheduler's history, not this repo).
+ 2. **`npm run status`'s freshness block.** Reads `public_freshness` directly from the database —
+    independent of whether the scheduler *ran*, it shows whether data actually *arrived*. If the
+    log looks healthy but freshness doesn't move, something downstream (not the scheduler) is
+    wrong.
+ 3. Windows Task Scheduler's own History tab for "VisibleGov Scheduled Ingestion" shows exit codes
+    over time — 0 is normal (success, nothing due, or already-running); non-zero is a real error
+    (e.g. `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` missing) and is the one case worth investigating.
+ 
+ Manual checks any time, safe to run for real (read-only, zero writes, zero external fetches):
+ 
+@@ -127,29 +220,49 @@ npm run schedule:ingest -- --dry-run --only legiscan
+ ```
+ 
+ ## How to pause / remove it
+ 
+ ```
+ schtasks /change /tn "VisibleGov Scheduled Ingestion" /disable   # pause (keeps the registration)
+ schtasks /change /tn "VisibleGov Scheduled Ingestion" /enable    # resume
+ schtasks /delete /tn "VisibleGov Scheduled Ingestion" /f         # remove entirely
+ ```
+ 
+-If the machine ever loses power mid-run, the lock file self-heals: a lock older than 10 minutes
+-(`MAX_RUN_DURATION_MS`) is automatically reclaimed on the next tick, with a warning logged. You can
+-also delete `.superpowers/artifacts/scheduler.lock.json` by hand at any time if you want a clean
+-next tick immediately rather than waiting out the 10 minutes.
++If the machine ever loses power mid-run, the lock file self-heals: a lock older than its own
++declared max duration (10 minutes by default, `MAX_RUN_DURATION_MS`; up to ~76 minutes if a
++`legiscan` run was in progress — see *Per-source timeouts* above) is automatically reclaimed on
++the next tick, with a warning logged. You can also delete
++`.superpowers/artifacts/scheduler.lock.json` by hand at any time if you want a clean next tick
++immediately rather than waiting out whichever window applies.
+ 
+ ## Known gap: `legiscan` may report `resolvable: false`
+ 
+ The scheduler looks up the current MO session's `legiscan_session_id` from the `sessions` table
+ (keyed off `ingest-mo-house.js`'s own `DEFAULT_MO_HOUSE_SESSION`) rather than guessing — see
+ `resolveLegiscanSessionId`'s own comment in `scripts/scheduled-ingest.js`. As of this writing that
+ resolves correctly (session `261` → LegiScan session `2239`). If it ever stops resolving, the
+ `legiscan` source is skipped honestly (logged, `resolvable: false`, with a reason) rather than
+-guessing — it does not block the other three sources.
++guessing — it does not block the other four sources (a lookup failure for any one source is
++isolated from the rest; see "What it does," step 2).
++
++## ⚠️ This scheduler CONTINUES feeding a known, currently-open data defect (TODO item 25) — read before registering
++
++**TODO.md item 25** documents a real, currently-open duplicate-MO-session defect: session
++identifier `'2026'` (no `legiscan_session_id`) duplicates session `'261'` (the correct one,
++`legiscan_session_id = 2239`) — the same real legislative session recorded twice, splitting its
++bills/votes across two session rows on the public site. TODO.md's own words: *"it grew 15→16 bills
++during the audit: the cron is feeding the duplicate."*
++
++**The feeder is `mo-senate-web`, which IS in this registry.** `ingest-mo-senate.js`'s
++`ensureSessionRow` inserts a `sessions` row keyed on the bare calendar year (`identifier:
++String(year)`, e.g. `'2026'`, with no `legiscan_session_id`) on **every single invocation** —
++this is not a rare edge case, it is what that CLI's normal `--year <current> --limit 1` run always
++does. Registering this scheduler means `mo-senate-web` keeps running on its own 30-minute cadence
++forever, which means this duplicate keeps growing forever too, until TODO 25's session-merge fix
++is applied at the database level.
+ 
+-Separately, **TODO.md item 25** documents a real, currently-open duplicate-MO-session defect
+-(session `'2026'` vs `'261'`) caused by a *different*, non-scheduler source (not `mo-house-xml`,
+-whose default session — `261` — is already the correct one). This scheduler's registry does not
+-touch whatever is producing that duplicate; it's flagged here only so it isn't mistaken for
+-something this script caused.
++**The honest framing is neutral-vs-today, not "unrelated."** This scheduler does exactly what the
++manual bash loop already did before it — it neither creates nor worsens the defect relative to
++current practice — but it is **not unrelated to it**, and running it unattended means the defect
++now grows on a durable, forever cadence instead of a session-lifetime one. Registering this
++scheduler is not blocked on TODO 25 being fixed first (the brief scoped this build to the
++scheduler, not to that merge), but Lance should register it knowing this, not discover it later.
+diff --git a/scripts/scheduled-ingest.js b/scripts/scheduled-ingest.js
+index 26787bb..d771b18 100644
+--- a/scripts/scheduled-ingest.js
++++ b/scripts/scheduled-ingest.js
+@@ -1,117 +1,176 @@
+ // scripts/scheduled-ingest.js — the first unattended, OS-scheduled process in this repo (TODO
+ // build-queue item 13). Every prior "recurring" ingestion was a bash loop inside a Claude Code
+ // session: it died the moment the session ended, so data staleness was real. This script is meant
+ // to be registered with Windows Task Scheduler (registration itself is Lance's own step — see
+ // docs/SCHEDULED_INGESTION.md — never run schtasks from an agent) and to run forever, unattended,
+ // with no human watching a single invocation. That changes the design bar entirely:
+ //
+ //   - NEVER CALLS A MODEL. This file imports no Anthropic client, no lib/summarizer.js, no
+-//     lib/verifier.js — nothing that can bill Lance's account. It only ever spawns the four
++//     lib/verifier.js — nothing that can bill Lance's account. It only ever spawns the five
+ //     read-mostly ingestion CLIs below plus scripts/refresh-aggregates.js. This comment, and the
+ //     import list actually enforcing it, are the whole guarantee — verify by inspection any time
+ //     this file changes.
+ //   - INCAPABLE OF VIOLATING A PUBLISHED RATE LIMIT. The two MO cadences (MO_SENATE_MIN_INTERVAL_MS,
+ //     MO_HOUSE_MIN_INTERVAL_MS) are imported verbatim from the adapters that already encode
+ //     senate.mo.gov's/house.mo.gov's real published terms — never redefined here, never
+-//     env-overridable, so a typo'd environment variable cannot shorten them. The two intervals
+-//     this script DOES get to choose (us-congress, legiscan) are env-overridable but mechanically
+-//     floored at the brief's own conservative minimum (envIntervalMs) — configurable upward only.
+-//   - INCAPABLE OF STACKING OVERLAPPING PROCESSES. A single-instance lock file
++//     env-overridable, so a typo'd environment variable cannot shorten them. The intervals this
++//     script DOES get to choose (us-congress, us-senate, legiscan) are env-overridable but
++//     mechanically floored at a conservative minimum (envIntervalMs) — configurable upward only.
++//   - INCAPABLE OF STACKING OVERLAPPING PROCESSES. A single-instance, ownership-checked lock file
+ //     (.superpowers/artifacts/scheduler.lock.json) is required before anything else happens; a
+ //     live lock means "already running," logged and exited 0 — an overlapping tick is expected
+ //     (Task Scheduler is recommended at a 15-min cadence, shorter than every source's own
+-//     interval, see docs/SCHEDULED_INGESTION.md) and must never read as a scheduler failure.
+-//   - The CRITICAL constraint from the brief: the ingest CLIs do not exit when their ToU cooldown
+-//     hasn't elapsed — they SLEEP until it has (enforceDurableCooldown, ingest-mo-senate.js:446;
+-//     same pattern in ingest-mo-house.js). A scheduler that blindly invoked them every tick would
+-//     stack sleeping processes. So THIS script decides due-ness itself, BEFORE ever launching a
+-//     child, by importing the exported remainingCooldownMs and querying ingestion_runs directly —
+-//     the same durable, cross-process signal the CLIs' own enforceDurableCooldown reads. A CLI is
+-//     only ever launched once its own cooldown has fully elapsed; in normal operation the child's
+-//     own enforceDurableCooldown check should therefore always see remaining<=0 immediately and
+-//     never actually sleep.
+-//   - Leaves an honest, dated log a human can read to confirm it is alive (see writeLog / npm run
+-//     status's freshness block).
++//     interval, see docs/SCHEDULED_INGESTION.md) and must never read as a scheduler failure. Every
++//     child process runs under a PER-SOURCE bounded timeout (fix round 2 — see CHILD_TIMEOUT_MS/
++//     LEGISCAN_CHILD_TIMEOUT_MS; legiscan alone can legitimately run up to 75 minutes on a real
++//     dataset-hash change, evidenced from real ingestion_runs history), and the lock itself
++//     carries THAT source's own declared max duration (updateLockMaxDuration, written after
++//     selection, before spawn) — so the stale-reclaim window judges each run against its own real
++//     bound rather than one fixed number, which is what makes the lock's ownership check
++//     (nonce-based, fix round 1 — see acquireLock/releaseLock) actually sufficient rather than
++//     theoretical. A forceful kill (timeout or buffer overflow) that strands a source's own
++//     ingestion_runs row at status='running' is closed honestly afterward, scoped to only the
++//     rows this exact tick could have created (fix round 2 — see closeOrphanedRunningRows).
++//   - INCAPABLE OF LETTING ONE FAILING SOURCE STARVE THE OTHERS. The ingest CLIs do not exit when
++//     their ToU cooldown hasn't elapsed — they SLEEP until it has (enforceDurableCooldown,
++//     ingest-mo-senate.js:446; same pattern in ingest-mo-house.js) — so this script decides
++//     due-ness itself, BEFORE ever launching a child, by importing the exported
++//     remainingCooldownMs and querying ingestion_runs directly. But `ingest.js` (us-congress/
++//     us-senate) does real network work BEFORE it ever calls openRun — a persistent upstream
++//     failure there would otherwise leave NO ingestion_runs row, freezing that source's due-ness
++//     signal and letting it monopolize every future tick forever (fix round 1, finding C1). So
++//     after every live run this script re-checks whether a new row actually appeared for the
++//     chosen source; if not, it writes its own HONEST failed attempt row (never a fake success) —
++//     see runChosenSource/recordSchedulerAttemptFailure below.
++//   - Leaves an honest, dated (UTC) log a human can read to confirm it is alive (see writeLog /
++//     npm run status's freshness block).
+ //
+ // Entry: node --env-file=.env scripts/scheduled-ingest.js [--dry-run] [--only <source>]
+ 
+ import { spawnSync } from 'node:child_process';
++import { randomUUID } from 'node:crypto';
+ import {
+   existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync,
+ } from 'node:fs';
+ import path from 'node:path';
+ import { fileURLToPath } from 'node:url';
++import { createClient } from '@supabase/supabase-js';
+ 
+-import { getClient, selectAll } from '../src/lib/db.js';
++import { selectAll, openRun, closeRun } from '../src/lib/db.js';
+ // Reused, not reimplemented (brief's own explicit instruction): the exact arithmetic every ingest
+ // CLI's own enforceDurableCooldown already relies on. Both ingest-mo-senate.js and
+ // ingest-mo-house.js export an identical copy (the latter ported from the former, see that file's
+ // own comment) — either is a correct, generic (lastStartedAtIso, minIntervalMs, now) function, not
+-// specific to MO Senate; imported once here and reused for all four registry sources.
++// specific to MO Senate; imported once here and reused for all five registry sources.
+ import { remainingCooldownMs, formatCooldownWait } from '../src/cli/ingest-mo-senate.js';
+ import { MO_SENATE_MIN_INTERVAL_MS } from '../src/adapters/mo-senate-web.js';
+ import { MO_HOUSE_MIN_INTERVAL_MS, DEFAULT_MO_HOUSE_SESSION } from '../src/adapters/mo-house-xml.js';
+ 
+ const __dirname = path.dirname(fileURLToPath(import.meta.url));
+ // Computed from this file's own location, NEVER from process.cwd() — Task Scheduler's default
+ // working directory is not guaranteed to be the repo root (docs/SCHEDULED_INGESTION.md recommends
+ // setting "Start in" anyway, but this script does not depend on it either way).
+ export const REPO_ROOT = path.join(__dirname, '..');
+ const ARTIFACTS_DIR = path.join(REPO_ROOT, '.superpowers', 'artifacts');
+ const LOCK_PATH = path.join(ARTIFACTS_DIR, 'scheduler.lock.json');
++// UTC-dated (entry.timestamp is an ISO-Z string sliced at 0,10) — see docs/SCHEDULED_INGESTION.md
++// for why "today's file" needs a UTC caveat in any timezone west of Greenwich (fix round 1, M1).
+ const LOG_DIR = path.join(ARTIFACTS_DIR, 'scheduler-logs');
+ 
+ // Stale-lock reclaim threshold. A normal invocation is one child CLI at --limit 1 (cooldown
+ // already confirmed elapsed by this script, so the child's own enforceDurableCooldown should not
+ // actually sleep) plus, sometimes, one refresh-aggregates.js call — realistically seconds, well
+ // under a minute. 10 minutes is a generous ceiling for slow network/retries while staying safely
+ // below the 15-minute recommended Task Scheduler tick, so a genuinely crashed/killed prior run
+ // cannot wedge the schedule for more than one missed tick.
+ export const MAX_RUN_DURATION_MS = 10 * 60 * 1000;
+ 
++// I2 (fix round 1): explicit timeout so a stalled child cannot hang the scheduler — and therefore
++// hold the lock — indefinitely, which was precisely the precondition I1's ownership-blind
++// releaseLock() turned into unbounded process stacking. This is the DEFAULT, used by the four
++// sources whose real observed durations never came close to it (mo-senate-web max 9.6s observed
++// across 151 historical runs; us-congress/us-senate max well under a minute across their small
++// sample; mo-house-xml's apparent ~30-min outliers turned out to be enforceDurableCooldown
++// SLEEPING out the old manual-loop's premature invocations — exact 1800.0s multiples in
++// ingestion_runs, not real work, and structurally impossible under this scheduler's own due-ness
++// gate, which never invokes a CLI before its cooldown has elapsed).
++export const CHILD_TIMEOUT_MS = 8 * 60 * 1000; // 8 min
++
++// Round 2 fix: legiscan needed its own, much larger timeout. Real ingestion_runs history showed
++// its runs against the scheduler's actual target session ('261', legiscan_session_id 2239) took
++// 449.3s and 475.7s — uncomfortably close to the old single 480s (8 min) budget — and a separate
++// historical run (a real dataset-hash-changed reprocessing, not a cheap hash-match skip) took
++// 3168.5s (~52.8 min). 75 minutes (4500s) is that observed max plus ~40% headroom
++// (3168.5 * 1.4 ≈ 4436s), rounded up. A per-source timeoutMs field (see buildRegistry) is what
++// makes this safe to raise for just this one source without loosening the default for the rest.
++export const LEGISCAN_CHILD_TIMEOUT_MS = 75 * 60 * 1000; // 75 min — see derivation above
++
++// Round 2 fix: the lock's own declared max duration (see acquireLock/updateLockMaxDuration) is
++// the chosen source's timeoutMs PLUS this grace — cleanup after a timeout-kill (closing an
++// orphaned 'running' row, writing the log) takes at most a few seconds, but a small buffer keeps
++// the stale-reclaim window from being able to fire in the split second between spawnSync's own
++// kill and this process's cleanup finishing.
++export const LOCK_GRACE_MS = 60 * 1000; // 1 min
++
++// M2 (fix round 1): Node's spawnSync default maxBuffer (1 MB) is small enough that a chatty child
++// (the ingest CLIs have 2-11 console.error progress lines) could overflow it, which SILENTLY
++// kills the child and reports ENOBUFS as `result.error` — runChildCli used to fold that into the
++// same "could not launch" message as a bad path, which is a misdiagnosis on the one process
++// nobody is watching. 16 MB is generous headroom; overflow is now reported with its own distinct
++// message (see runChildCli).
++export const CHILD_MAX_BUFFER = 16 * 1024 * 1024;
++
+ const ONE_HOUR_MS = 60 * 60 * 1000;
+ const ONE_DAY_MS = 24 * ONE_HOUR_MS;
+ 
+-// envIntervalMs: the mechanical floor behind US_CONGRESS_MIN_INTERVAL_MS/LEGISCAN_MIN_INTERVAL_MS
+-// below — these two intervals are OUR OWN conservative policy choice (Congress.gov and LegiScan
+-// publish no per-request cadence the way house.mo.gov/senate.mo.gov do), so, unlike the two MO
+-// constants above, they are env-overridable. But an override can only raise the interval, never
+-// lower it below the floor the brief itself specifies (>=1h / >=24h) — a bad or typo'd env value
+-// can only make this script MORE conservative, never less.
++// envIntervalMs: the mechanical floor behind US_CONGRESS_MIN_INTERVAL_MS/US_SENATE_MIN_INTERVAL_MS/
++// LEGISCAN_MIN_INTERVAL_MS below — these intervals are OUR OWN conservative policy choice
++// (Congress.gov and LegiScan publish no per-request cadence the way house.mo.gov/senate.mo.gov
++// do), so, unlike the two MO constants above, they are env-overridable. But an override can only
++// raise the interval, never lower it below the floor — a bad or typo'd env value can only make
++// this script MORE conservative, never less.
+ export function envIntervalMs(envVar, defaultMs, floorMs) {
+   const raw = Number(process.env[envVar]);
+   const configured = Number.isFinite(raw) && raw > 0 ? raw : defaultMs;
+   return Math.max(configured, floorMs);
+ }
+ 
+-// us-congress: no published rate limit exists to violate (Congress.gov's own polite limiter is
+-// already enforced inside src/adapters/us-congress.js's congressLimiter) — >=1h is this script's
+-// own conservative choice, since new House roll calls arrive on a legislative-day cadence, not
+-// continuously; there is no benefit to checking more often than that.
++// us-congress / us-senate: no published rate limit exists to violate (Congress.gov's/senate.gov's
++// own polite limiters are already enforced inside src/adapters/us-congress.js's congressLimiter /
++// us-senate.js's senateLimiter) — >=1h is this script's own conservative choice, since new roll
++// calls arrive on a legislative-day cadence, not continuously. Separate env vars per source (same
++// "own named interval per registry entry" convention as every other source here), same family.
+ export const US_CONGRESS_MIN_INTERVAL_MS = envIntervalMs('US_CONGRESS_MIN_INTERVAL_MS', ONE_HOUR_MS, ONE_HOUR_MS);
++export const US_SENATE_MIN_INTERVAL_MS = envIntervalMs('US_SENATE_MIN_INTERVAL_MS', ONE_HOUR_MS, ONE_HOUR_MS);
+ // legiscan: datasets refresh weekly (Sunday 5am ET per docs/research/2026-07-28-legiscan-terms.md)
+ // — >=24h is deliberately far more frequent than strictly necessary, still cheap because
+ // ingest-legiscan.js's own dataset_hash gate (⛔ suspension-level rule, decodeDatasetHashGate)
+ // makes a same-dataset invocation a single cheap list-check, not a real download.
+ export const LEGISCAN_MIN_INTERVAL_MS = envIntervalMs('LEGISCAN_MIN_INTERVAL_MS', ONE_DAY_MS, ONE_DAY_MS);
+ 
+ // Matches the hardcoded convention already used throughout this repo (ingest.js,
+ // backfill-federal-names.js, enrich-federal-bills.js all hardcode 119) — no dynamic
+ // "current congress" formula exists anywhere in this codebase; update all four together when the
+ // 120th Congress convenes.
+ export const US_CONGRESS_CONGRESS = 119;
+-// Small, conservative forward-delta window past the highest roll number already on file — see
+-// resolveUsCongressRollWindow's own comment for why this is safe to overlap/overshoot.
++// Senate.gov numbers each Congress's two annual sessions 1/2 by calendar year (119th Congress:
++// session 1 = 2025, session 2 = 2026) — same hardcoded-"current" convention as the congress
++// number above; update alongside it when the session rolls over.
++export const US_SENATE_SESSION = 2;
++// Small, conservative forward-delta window past the highest roll/vote number already on file —
++// see resolveUsCongressRollWindow/resolveUsSenateVoteWindow's own comments for why this is safe
++// to overlap/overshoot.
+ export const US_CONGRESS_ROLL_WINDOW = 10;
++export const US_SENATE_VOTE_WINDOW = 10;
+ 
+-const SOURCE_KEYS = ['mo-senate-web', 'mo-house-xml', 'us-congress', 'legiscan'];
++const SOURCE_KEYS = ['mo-senate-web', 'mo-house-xml', 'us-congress', 'us-senate', 'legiscan'];
+ 
+ // ---- pure: args ----
+ 
+ export function parseArgs(argv) {
+   const out = { dryRun: false, only: null };
+   let i = 0;
+   while (i < argv.length) {
+     const key = argv[i];
+     if (key === '--dry-run') {
+       out.dryRun = true;
+@@ -124,308 +183,716 @@ export function parseArgs(argv) {
+         throw new Error(`unknown source: ${out.only} (expected one of ${SOURCE_KEYS.join(', ')})`);
+       }
+       i += 2;
+       continue;
+     }
+     throw new Error(`unknown flag: ${key}`);
+   }
+   return out;
+ }
+ 
+-// ---- pure: single-instance lock ----
++// ---- pure: single-instance lock (I1 fix round 1: ownership-checked via nonce; round 2: the
++// stale-reclaim window is the LOCK'S OWN declared duration, not one fixed constant) ----
+ 
+-export function isLockStale(lock, nowMs, maxRunDurationMs = MAX_RUN_DURATION_MS) {
++// isLockStale (round 2): a fixed 10-minute stale-reclaim window and a legiscan run that can
++// legitimately need 75 minutes cannot coexist — a tick at +15 min would reclaim a still-live
++// legiscan lock, starting a SECOND concurrent child, exactly the stacking I1 closed. So the lock
++// itself carries `maxDurationMs` (written by acquireLock, updated by updateLockMaxDuration once
++// the chosen source — and therefore its real timeout — is known), and staleness is judged against
++// THAT declared value. `fallbackMaxDurationMs` (still MAX_RUN_DURATION_MS by default) is used
++// only when the lock has no valid `maxDurationMs` of its own — an old-format or corrupt lock file
++// — which is the fail-safe direction: an unrecognized lock is judged by the conservative 10-minute
++// default, never trusted to mean "wait indefinitely."
++export function isLockStale(lock, nowMs, fallbackMaxDurationMs = MAX_RUN_DURATION_MS) {
+   const startedMs = Date.parse(lock.startedAt);
+   if (!Number.isFinite(startedMs)) return true; // unparseable timestamp — never trusted, treated as stale
+-  return nowMs - startedMs > maxRunDurationMs;
++  const declared = Number(lock.maxDurationMs);
++  const maxDurationMs = Number.isFinite(declared) && declared > 0 ? declared : fallbackMaxDurationMs;
++  return nowMs - startedMs > maxDurationMs;
+ }
+ 
+ // acquireLock: an atomic create ('wx' — fails with EEXIST if the file already exists) is tried
+ // first, closing the check-then-act race a plain existsSync()-then-writeFileSync() pair would
+-// leave open between two schedulers starting within milliseconds of each other. Unlikely at a
+-// 15-minute tick cadence, but free to close. Falls back to reading the existing lock only on
+-// EEXIST; a corrupt/unreadable lock is treated exactly like a stale one (reclaimed + the caller
+-// logs a warning) rather than either trusting it blindly or crashing — a half-written lock from a
+-// killed process must not permanently wedge every future tick.
++// leave open between two schedulers starting within milliseconds of each other. Falls back to
++// reading the existing lock only on EEXIST; a corrupt/unreadable lock is treated exactly like a
++// stale one (reclaimed + the caller logs a warning) rather than either trusting it blindly or
++// crashing — a half-written lock from a killed process must not permanently wedge every future
++// tick. Every lock this process writes carries a fresh random `nonce` (crypto.randomUUID) — the
++// caller MUST thread the returned nonce through to releaseLock, which is the other half of I1's
++// fix (see that function).
++//
++// Round 2: the lock also carries `maxDurationMs`, initialized here to `maxRunDurationMs`
++// (MAX_RUN_DURATION_MS by default) — at acquire time the chosen source (and therefore its real
++// per-source timeout) isn't known yet, so this initial value only has to cover the SELECTION
++// phase (a handful of bounded DB lookups, realistically seconds) and every non-live tick shape
++// (nothing-due/already-running/dry-run/blocked, none of which spawn a child at all). The caller
++// MUST call updateLockMaxDuration once a source is chosen and BEFORE spawning it, so the
++// stale-reclaim window covers that child's REAL declared timeout, not this placeholder.
+ export function acquireLock(lockPath = LOCK_PATH, { now = Date.now(), maxRunDurationMs = MAX_RUN_DURATION_MS } = {}) {
+   mkdirSync(path.dirname(lockPath), { recursive: true });
+-  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() }, null, 2);
++  const nonce = randomUUID();
++  const payload = JSON.stringify({
++    pid: process.pid, startedAt: new Date(now).toISOString(), nonce, maxDurationMs: maxRunDurationMs,
++  }, null, 2);
+ 
+   try {
+     writeFileSync(lockPath, payload, { flag: 'wx' });
+-    return { acquired: true, reason: 'fresh' };
++    return {
++      acquired: true, reason: 'fresh', nonce,
++    };
+   } catch (err) {
+     if (err.code !== 'EEXIST') throw err;
+   }
+ 
+   let existing;
+   try {
+     existing = JSON.parse(readFileSync(lockPath, 'utf8'));
+   } catch {
+-    existing = { startedAt: new Date(0).toISOString(), pid: null, corrupt: true };
++    existing = {
++      startedAt: new Date(0).toISOString(), pid: null, nonce: null, corrupt: true,
++    };
+   }
+   if (!isLockStale(existing, now, maxRunDurationMs)) {
+     return { acquired: false, reason: 'already-running', lock: existing };
+   }
+   // Stale: a plain overwrite is fine here — the prior owner is already established to be long
+   // past any plausible run duration, so losing a 'wx'-style race at this exact point is not a
+   // realistic concern.
+   writeFileSync(lockPath, payload);
+-  return { acquired: true, reason: 'reclaimed-stale', staleLock: existing };
++  return {
++    acquired: true, reason: 'reclaimed-stale', staleLock: existing, nonce,
++  };
+ }
+ 
+-export function releaseLock(lockPath = LOCK_PATH) {
+-  if (existsSync(lockPath)) unlinkSync(lockPath);
++// releaseLock: ownership-checked (I1, fix round 1) — re-reads the lock and deletes ONLY when its
++// nonce matches the one THIS process was given when it acquired the lock. Without this, the
++// defect was concrete: tick A takes the lock and its child hangs past MAX_RUN_DURATION_MS; tick B
++// reclaims the (now-stale) lock and starts its own child; tick A finally returns and its
++// `finally` deletes what it thinks is "its" lock — but that file is now B's, mid-run — leaving no
++// lock at all for tick C to find, so THREE children end up running concurrently. A missing file,
++// an unreadable/corrupt file, or a present-but-non-matching nonce are all safe no-ops — this
++// function must never delete something it cannot prove it owns, and never throws.
++export function releaseLock(lockPath = LOCK_PATH, nonce = null) {
++  if (!existsSync(lockPath)) return;
++  let existing;
++  try {
++    existing = JSON.parse(readFileSync(lockPath, 'utf8'));
++  } catch {
++    return; // corrupt/unreadable — cannot prove ownership, so never delete
++  }
++  if (!nonce || existing.nonce !== nonce) return; // not (verifiably) ours — leave it alone
++  unlinkSync(lockPath);
++}
++
++// updateLockMaxDuration (round 2): rewrites the lock's declared `maxDurationMs` once the chosen
++// source — and therefore its real per-source timeout — is known, so the stale-reclaim window
++// (isLockStale) judges THIS run against its own real bound rather than the generic
++// selection-phase placeholder acquireLock wrote. Must be called AFTER source selection and
++// BEFORE the child is spawned. Ownership-checked the same way releaseLock is (nonce match) —
++// never overwrites a lock this process cannot prove it still owns; a missing/corrupt/
++// non-matching lock is a safe no-op (returns false) rather than a throw, since a scheduler that
++// somehow lost its own lock between acquiring it and choosing a source has a bigger problem than
++// this write failing.
++export function updateLockMaxDuration(lockPath = LOCK_PATH, nonce = null, maxDurationMs) {
++  if (!existsSync(lockPath)) return false;
++  let existing;
++  try {
++    existing = JSON.parse(readFileSync(lockPath, 'utf8'));
++  } catch {
++    return false;
++  }
++  if (!nonce || existing.nonce !== nonce) return false;
++  writeFileSync(lockPath, JSON.stringify({ ...existing, maxDurationMs }, null, 2));
++  return true;
+ }
+ 
+ // ---- pure: due-ness + selection ----
+ 
+ // computeSourceDueness: remainingMs comes straight from the shared, imported remainingCooldownMs
+ // — never reimplemented. elapsedMs (Infinity for a source with no prior run at all) is the
+ // separate "how overdue" ranking signal pickMostOverdue uses below; remainingMs alone cannot rank
+ // two already-due sources against each other since Math.max(0, ...) clamps both to 0.
+ export function computeSourceDueness(entry, now) {
+   const remainingMs = remainingCooldownMs(entry.lastStartedAtIso, entry.minIntervalMs, now);
+   const elapsedMs = entry.lastStartedAtIso ? now - Date.parse(entry.lastStartedAtIso) : Infinity;
+   return {
+     ...entry, remainingMs, elapsedMs, due: remainingMs <= 0,
+   };
+ }
+ 
+-// pickMostOverdue: among due AND resolvable entries (legiscan with no legiscan_session_id on file
+-// is due but never resolvable — see buildRegistry), the one that has gone longest since its last
+-// (or ever) run wins. A source with zero prior runs (elapsedMs=Infinity) outranks everything else
+-// — seeding an unseen source is the most urgent thing to do. Ties keep registry order (reduce
+-// never replaces `best` on an equal elapsedMs).
++// pickMostOverdue: among due AND resolvable entries (legiscan with no legiscan_session_id on
++// file, or any source whose lookup failed this tick — I3 — is due but never resolvable; see
++// buildRegistry), the one that has gone longest since its last (or ever) run wins. A source with
++// zero prior runs (elapsedMs=Infinity) outranks everything else — seeding an unseen source is the
++// most urgent thing to do. Ties keep registry order (reduce never replaces `best` on an equal
++// elapsedMs). C1's fix (runChosenSource, below) is what keeps a persistently-failing source from
++// winning this EVERY tick forever — see that function's own comment.
+ export function pickMostOverdue(entries) {
+   const candidates = entries.filter((e) => e.due && e.resolvable);
+   if (candidates.length === 0) return null;
+   return candidates.reduce((best, e) => (e.elapsedMs > best.elapsedMs ? e : best));
+ }
+ 
+-// ---- pure: us-congress roll-delta window ----
++// ---- pure: us-congress/us-senate probe-window math ----
+ 
+ const US_HOUSE_ROLL_RE = /^us-house-\d+-\d+-(\d+)$/;
++const US_SENATE_VOTE_RE = /^us-senate-\d+-\d+-(\d+)$/;
+ 
+ export function parseUsHouseRoll(sourceKey) {
+   const m = US_HOUSE_ROLL_RE.exec(String(sourceKey ?? ''));
+   return m ? Number(m[1]) : null;
+ }
+ 
++export function parseUsSenateVote(sourceKey) {
++  const m = US_SENATE_VOTE_RE.exec(String(sourceKey ?? ''));
++  return m ? Number(m[1]) : null;
++}
++
+ export function computeRollWindow(maxKnownRoll, windowSize = US_CONGRESS_ROLL_WINDOW) {
+   const base = Number.isFinite(maxKnownRoll) && maxKnownRoll > 0 ? maxKnownRoll : 0;
+   return { lo: base + 1, hi: base + windowSize };
+ }
+ 
+-// ---- pure: child-CLI output ----
++// isExpectedTailProbeOutcome (I4a, fix round 1): the probe window is DESIGNED to overshoot — most
++// ticks 404 on every roll/vote past the real edge, which is confirmation nothing new has landed
++// yet, not a failure. True only when EVERY recorded failure is a roll/vote failure (never a
++// bill-detail failure, a different step, or a roll/vote AT OR BELOW the previously-known edge —
++// any of those would be a genuine regression) strictly past windowMaxKnown. `failures` is the
++// run's own detail.failures array (ingest.js's exact `{step: 'roll <N>'}` / `{step: 'vote <N>'}`
++// shape). Returns false (never "expected") for any non-windowed source, or when there are no
++// failures to begin with (nothing to explain away).
++const TAIL_FAILURE_STEP_RE = {
++  'us-congress': /^roll (\d+)$/,
++  'us-senate': /^vote (\d+)$/,
++};
+ 
+-export function parseChildOutput(stdout) {
+-  try {
+-    return { parsed: JSON.parse(String(stdout ?? '').trim()), parseError: null };
+-  } catch (err) {
+-    return { parsed: null, parseError: err.message };
+-  }
++export function isExpectedTailProbeOutcome(sourceKey, failures, windowMaxKnown) {
++  const re = TAIL_FAILURE_STEP_RE[sourceKey];
++  if (!re || windowMaxKnown === undefined || windowMaxKnown === null) return false;
++  if (!failures || failures.length === 0) return false;
++  return failures.every((f) => {
++    const m = re.exec(f?.step ?? '');
++    return m !== null && Number(m[1]) > windowMaxKnown;
++  });
+ }
+ 
+-// runWroteSomething: deliberately generous, not a byte-exact "were rows actually inserted" oracle
+-// — the four registry CLIs' count shapes are heterogeneous (mo-senate/mo-house's document-shaped
+-// counts vs. us-congress's legislators/bills/votes/casts vs. legiscan's own), so this reads the one
+-// field every one of them shares (mode/status, the same repo-wide main() convention every CLI in
+-// this codebase follows). A 'live' run that reached succeeded/partial opened and closed a real
+-// ingestion_runs row — it genuinely attempted writes, even on a tick where every upsert happened to
+-// be a no-op. Treating that as "wrote something" means the aggregate refresh below sometimes runs
+-// when nothing actually changed (cheap, idempotent SQL) rather than risk the opposite: skipping a
+-// refresh that WAS needed, which is the exact user-visible chart-drift defect from 2026-07-31 that
+-// refresh-aggregates.js's own header describes this standing practice as preventing.
+-export function runWroteSomething(parsedOutput) {
+-  if (!parsedOutput || parsedOutput.mode !== 'live') return false;
+-  return parsedOutput.status === 'succeeded' || parsedOutput.status === 'partial';
++// countsShowRowsWritten (I4b, fix round 1): reads the run's OWN detail — never inferred from
++// mode/status alone, which was the actual bug (a live/succeeded-or-partial run was treated as
++// "wrote something" even on a tick where every probed roll 404s and literally zero rows landed,
++// so refresh-aggregates.js fired every hour unconditionally). Source-specific because the CLIs'
++// count shapes are genuinely heterogeneous — verified against each one's real closeRun() call
++// site, not guessed:
++//   - mo-senate-web / us-congress / us-senate / legiscan: detail.counts.votes > 0
++//   - mo-house-xml: document_type-dependent — the rollcall-pdf branch writes CASTS
++//     (detail.rollCallResult.castCount, a sibling of counts, not inside it — see
++//     processRollCallPdf's return shape), the bill-xml branch writes BILL rows
++//     (detail.counts.bills_detailed)
++export function countsShowRowsWritten(sourceKey, detail) {
++  const counts = detail?.counts ?? {};
++  if (sourceKey === 'mo-house-xml') {
++    if (counts.document_type === 'rollcall-pdf') return (detail?.rollCallResult?.castCount ?? 0) > 0;
++    if (counts.document_type === 'bill-xml') return (counts.bills_detailed ?? 0) > 0;
++    return false;
++  }
++  return (counts.votes ?? 0) > 0;
+ }
+ 
+ // ---- DB-facing helpers ----
+ 
+ export async function queryLatestStartedAt(client, source) {
+   const { data, error } = await client
+     .from('ingestion_runs')
+     .select('started_at')
+     .eq('source', source)
+     .order('started_at', { ascending: false })
+     .limit(1)
+     .maybeSingle();
+   if (error) throw new Error(`ingestion_runs lookup failed for source=${source}: ${error.message}`);
+   return data ? data.started_at : null;
+ }
+ 
++// queryLatestRun: same query as queryLatestStartedAt but the FULL row (status + detail), used by
++// runChosenSource (C1/I4, fix round 1) to (a) detect whether a genuinely new row appeared after
++// invoking a child, and (b) read that row's own honest status/counts/failures rather than trust
++// the child's stdout alone (which can be absent entirely on a hard crash).
++export async function queryLatestRun(client, source) {
++  const { data, error } = await client
++    .from('ingestion_runs')
++    .select('started_at,status,detail')
++    .eq('source', source)
++    .order('started_at', { ascending: false })
++    .limit(1)
++    .maybeSingle();
++  if (error) throw new Error(`ingestion_runs lookup failed for source=${source}: ${error.message}`);
++  return data ?? null;
++}
++
+ // resolveLegiscanSessionId: reuses mo-house-xml.js's OWN DEFAULT_MO_HOUSE_SESSION as "the current
+ // MO session identifier" — never a second, separately-maintained notion of "current" — and looks
+ // up that session's legiscan_session_id column directly by key. Returns null (never a guess, never
+ // an ORDER BY/"most recent" heuristic over `sessions`) when that row or its legiscan_session_id
+ // doesn't exist yet. TODO.md item 25 documents a real, currently-open duplicate-MO-session defect
+ // in this exact area of the data model; guessing here is exactly the kind of thing that could make
+ // it worse. The registry (below) treats a null result as "not configured" and skips legiscan
+ // honestly rather than risk feeding that defect a second way.
+ export async function resolveLegiscanSessionId(client) {
+   const { data, error } = await client
+     .from('sessions')
+     .select('legiscan_session_id')
+     .eq('jurisdiction_id', 'mo-legislature')
+     .eq('identifier', DEFAULT_MO_HOUSE_SESSION)
+     .maybeSingle();
+   if (error) throw new Error(`sessions lookup failed for legiscan_session_id: ${error.message}`);
+   return data && data.legiscan_session_id != null ? data.legiscan_session_id : null;
+ }
+ 
+ // resolveUsCongressRollWindow: src/cli/ingest.js has no built-in delta mode (--rolls is a
+-// caller-chosen explicit range) and this source has never had scheduled ingestion (brief) — this
++// caller-chosen explicit range) and this source had never had scheduled ingestion (brief) — this
+ // is the scheduler's own minimal, honest "what's new" computation: the highest US House roll
+ // number already on file for this congress+year, plus a small forward window. Every candidate roll
+ // in that window that doesn't exist yet simply 404s inside collectUsCongress (a typed, non-fatal
+ // SourceFetchError recorded in failures[] — see ingest.js's own per-roll try/catch) and every roll
+ // that already exists is a harmless insertIfAbsent no-op (votes.source_key is the conflict key) —
+ // so overlapping an already-ingested roll, or probing one that hasn't happened yet, is always
+-// safe, just occasionally wasted requests against Congress.gov's own already-polite limiter.
+-// Routed through selectAll (project law: no bare .select() on a multi-row table — this table is
+-// already ~10,000+ rows overall, well past Supabase's 1000-row cap, even though this query's own
+-// WHERE clause keeps any single congress+year's result set small).
++// safe, just occasionally wasted requests against Congress.gov's own already-polite limiter (see
++// I4a — that tolerance is now correctly reported as healthy, not a failure). Routed through
++// selectAll (project law: no bare .select() on a multi-row table). Returns maxKnown alongside
++// {lo,hi} so callers (buildRegistry) can pass it through for I4a's tail-probe classification.
+ export async function resolveUsCongressRollWindow(client, {
+   congress = US_CONGRESS_CONGRESS, year, windowSize = US_CONGRESS_ROLL_WINDOW,
+ } = {}) {
+   const prefix = `us-house-${congress}-${year}-`;
+   const { data, error } = await selectAll(client, 'votes', 'source_key', {
+     filter: (q) => q.eq('jurisdiction_id', 'us-congress').like('source_key', `${prefix}%`),
+   });
+   if (error) throw new Error(`votes lookup failed for us-congress roll window: ${error.message}`);
+-  const maxRoll = (data ?? [])
++  const maxKnown = (data ?? [])
+     .map((r) => parseUsHouseRoll(r.source_key))
+     .filter((n) => n !== null)
+     .reduce((max, n) => Math.max(max, n), 0);
+-  return computeRollWindow(maxRoll, windowSize);
++  return { ...computeRollWindow(maxKnown, windowSize), maxKnown };
++}
++
++// resolveUsSenateVoteWindow (I5, fix round 1): same rationale as resolveUsCongressRollWindow
++// above — ingest.js's us-senate path ALSO has no delta mode, and omitting --votes entirely means
++// "refetch and reparse the WHOLE session's vote menu" (hundreds of XML fetches), clearly wrong
++// for a scheduled tick. jurisdiction_id is 'us-congress' for Senate rows too (see
++// persistUsSenate) — only source_key's own 'us-senate-' prefix distinguishes chamber.
++export async function resolveUsSenateVoteWindow(client, {
++  congress = US_CONGRESS_CONGRESS, session = US_SENATE_SESSION, windowSize = US_SENATE_VOTE_WINDOW,
++} = {}) {
++  const prefix = `us-senate-${congress}-${session}-`;
++  const { data, error } = await selectAll(client, 'votes', 'source_key', {
++    filter: (q) => q.eq('jurisdiction_id', 'us-congress').like('source_key', `${prefix}%`),
++  });
++  if (error) throw new Error(`votes lookup failed for us-senate vote window: ${error.message}`);
++  const maxKnown = (data ?? [])
++    .map((r) => parseUsSenateVote(r.source_key))
++    .filter((n) => n !== null)
++    .reduce((max, n) => Math.max(max, n), 0);
++  return { ...computeRollWindow(maxKnown, windowSize), maxKnown };
++}
++
++// safeLookup (I3, fix round 1): wraps ONE DB lookup so a rejection degrades to {ok:false, error}
++// instead of rejecting the whole buildRegistry() call. Previously all six (now eight) lookups ran
++// inside a single Promise.all — one Supabase hiccup on ANY of them (a transient network blip, an
++// RLS/permissions change, anything) rejected the whole thing, propagated out of main(), and
++// exited 1 with NO source run that tick — directly contradicting the doc's "does not block the
++// other sources" claim, which was true only for the null/not-configured path, not a thrown error.
++async function safeLookup(shouldRun, fn) {
++  if (!shouldRun) return { ok: true, value: null }; // M3: not needed this tick (--only excludes it) — never attempted
++  try {
++    return { ok: true, value: await fn() };
++  } catch (err) {
++    return { ok: false, error: err };
++  }
++}
++
++function skipReason(result) {
++  return result.ok ? null : `skipped this tick: ${result.error.message}`;
+ }
+ 
+ // ---- registry ----
+ //
+ // Each entry: { key, minIntervalMs, lastStartedAtIso, resolvable, unresolvedReason, scriptPath,
+-// cliArgs }. scriptPath is repo-root-relative, matching every "node --env-file=.env <path>" npm
+-// script already in package.json.
+-export async function buildRegistry(client, { now = Date.now(), year = new Date(now).getFullYear() } = {}) {
+-  const [moSenateLast, moHouseLast, usCongressLast, legiscanLast, legiscanSessionId, rollWindow] = await Promise.all([
+-    queryLatestStartedAt(client, 'mo-senate-web'),
+-    queryLatestStartedAt(client, 'mo-house-xml'),
+-    queryLatestStartedAt(client, 'us-congress'),
+-    queryLatestStartedAt(client, 'legiscan'),
+-    resolveLegiscanSessionId(client),
+-    resolveUsCongressRollWindow(client, { year }),
++// cliArgs, timeoutMs, windowMaxKnown? }. scriptPath is repo-root-relative, matching every
++// "node --env-file=.env <path>" npm script already in package.json. `only` (M3, fix round 1)
++// skips every lookup not needed for the requested source, rather than running all eight and
++// discarding six of them every tick. `timeoutMs` (round 2) is CHILD_TIMEOUT_MS for every source
++// except legiscan, which gets LEGISCAN_CHILD_TIMEOUT_MS — see that constant's own comment for the
++// real-duration evidence behind the 75-minute figure.
++export async function buildRegistry(client, { now = Date.now(), year = new Date(now).getFullYear(), only = null } = {}) {
++  const need = (key) => !only || only === key;
++
++  const [
++    moSenateLast, moHouseLast, usCongressLast, usSenateLast, legiscanLast,
++    legiscanSessionId, rollWindow, voteWindow,
++  ] = await Promise.all([
++    safeLookup(need('mo-senate-web'), () => queryLatestStartedAt(client, 'mo-senate-web')),
++    safeLookup(need('mo-house-xml'), () => queryLatestStartedAt(client, 'mo-house-xml')),
++    safeLookup(need('us-congress'), () => queryLatestStartedAt(client, 'us-congress')),
++    safeLookup(need('us-senate'), () => queryLatestStartedAt(client, 'us-senate')),
++    safeLookup(need('legiscan'), () => queryLatestStartedAt(client, 'legiscan')),
++    safeLookup(need('legiscan'), () => resolveLegiscanSessionId(client)),
++    safeLookup(need('us-congress'), () => resolveUsCongressRollWindow(client, { year })),
++    safeLookup(need('us-senate'), () => resolveUsSenateVoteWindow(client, {})),
+   ]);
+ 
++  const legiscanResolvedId = legiscanSessionId.ok ? legiscanSessionId.value : null;
++  const legiscanResolvable = legiscanLast.ok && legiscanSessionId.ok && legiscanResolvedId != null;
++
+   return [
+     {
+       key: 'mo-senate-web',
+       minIntervalMs: MO_SENATE_MIN_INTERVAL_MS,
+-      lastStartedAtIso: moSenateLast,
+-      resolvable: true,
+-      unresolvedReason: null,
++      lastStartedAtIso: moSenateLast.ok ? moSenateLast.value : null,
++      resolvable: moSenateLast.ok,
++      unresolvedReason: skipReason(moSenateLast),
+       scriptPath: 'src/cli/ingest-mo-senate.js',
+       cliArgs: ['--year', String(year), '--limit', '1'],
++      timeoutMs: CHILD_TIMEOUT_MS,
+     },
+     {
+       key: 'mo-house-xml',
+       minIntervalMs: MO_HOUSE_MIN_INTERVAL_MS,
+-      lastStartedAtIso: moHouseLast,
+-      resolvable: true,
+-      unresolvedReason: null,
++      lastStartedAtIso: moHouseLast.ok ? moHouseLast.value : null,
++      resolvable: moHouseLast.ok,
++      unresolvedReason: skipReason(moHouseLast),
+       scriptPath: 'src/cli/ingest-mo-house.js',
+       // RESTRICTION (TODO 31 — do not violate): current-session ingestion ONLY. mo_house_id is
+       // declared table-wide `unique` (migration 0005) against a current-only roster, so a
+       // historical/multi-era backfill would silently misattribute a successor's votes to their
+       // predecessor. NEVER add --session (or any year/era flag) here — --limit 1 alone lets the
+       // CLI fall through to its own DEFAULT_MO_HOUSE_SESSION, which is the current session.
+       cliArgs: ['--limit', '1'],
++      timeoutMs: CHILD_TIMEOUT_MS,
+     },
+     {
+       key: 'us-congress',
+       minIntervalMs: US_CONGRESS_MIN_INTERVAL_MS,
+-      lastStartedAtIso: usCongressLast,
+-      resolvable: true,
+-      unresolvedReason: null,
++      lastStartedAtIso: usCongressLast.ok ? usCongressLast.value : null,
++      resolvable: usCongressLast.ok && rollWindow.ok && rollWindow.value != null,
++      unresolvedReason: skipReason(usCongressLast) ?? skipReason(rollWindow),
+       scriptPath: 'src/cli/ingest.js',
+-      cliArgs: ['--source', 'us-congress', '--year', String(year), '--rolls', `${rollWindow.lo}-${rollWindow.hi}`],
++      // rollWindow.value is null both on a genuine failure (rollWindow.ok===false, handled by
++      // skipReason above) AND on a lookup skipped outright because --only excluded this source
++      // (rollWindow.ok===true, value:null, per safeLookup) — either way, no real window exists to
++      // build --rolls from, so cliArgs must stay empty rather than dereference a null value.
++      cliArgs: rollWindow.value != null
++        ? ['--source', 'us-congress', '--year', String(year), '--rolls', `${rollWindow.value.lo}-${rollWindow.value.hi}`]
++        : [],
++      timeoutMs: CHILD_TIMEOUT_MS,
++      windowMaxKnown: rollWindow.value != null ? rollWindow.value.maxKnown : undefined,
++    },
++    {
++      key: 'us-senate',
++      minIntervalMs: US_SENATE_MIN_INTERVAL_MS,
++      lastStartedAtIso: usSenateLast.ok ? usSenateLast.value : null,
++      resolvable: usSenateLast.ok && voteWindow.ok && voteWindow.value != null,
++      unresolvedReason: skipReason(usSenateLast) ?? skipReason(voteWindow),
++      scriptPath: 'src/cli/ingest.js',
++      cliArgs: voteWindow.value != null
++        ? ['--source', 'us-senate', '--session', String(US_SENATE_SESSION), '--votes', `${voteWindow.value.lo}-${voteWindow.value.hi}`]
++        : [],
++      timeoutMs: CHILD_TIMEOUT_MS,
++      windowMaxKnown: voteWindow.value != null ? voteWindow.value.maxKnown : undefined,
+     },
+     {
+       key: 'legiscan',
+       minIntervalMs: LEGISCAN_MIN_INTERVAL_MS,
+-      lastStartedAtIso: legiscanLast,
+-      resolvable: legiscanSessionId != null,
+-      unresolvedReason: legiscanSessionId != null
+-        ? null
+-        : `no legiscan_session_id on file for MO session '${DEFAULT_MO_HOUSE_SESSION}' (sessions.legiscan_session_id) — `
+-          + 'see TODO.md item 25; not guessed, skipped honestly until resolved',
++      lastStartedAtIso: legiscanLast.ok ? legiscanLast.value : null,
++      resolvable: legiscanResolvable,
++      unresolvedReason: skipReason(legiscanLast) ?? skipReason(legiscanSessionId) ?? (legiscanResolvedId == null
++        ? `no legiscan_session_id on file for MO session '${DEFAULT_MO_HOUSE_SESSION}' (sessions.legiscan_session_id) — `
++          + 'see TODO.md item 25; not guessed, skipped honestly until resolved'
++        : null),
+       scriptPath: 'src/cli/ingest-legiscan.js',
+       // ⛔ dataset_hash comparison happens INSIDE ingest-legiscan.js (decodeDatasetHashGate) —
+       // never re-implemented here. This registry entry only ever supplies --session; the
+       // suspension-level gate itself is entirely the CLI's own responsibility, invoked, not
+       // reimplemented.
+-      cliArgs: legiscanSessionId != null ? ['--session', String(legiscanSessionId)] : [],
++      cliArgs: legiscanResolvedId != null ? ['--session', String(legiscanResolvedId)] : [],
++      timeoutMs: LEGISCAN_CHILD_TIMEOUT_MS,
+     },
+   ];
+ }
+ 
+ // ---- process orchestration ----
+ 
+ function defaultSpawn(command, args, options) {
+   return spawnSync(command, args, { encoding: 'utf8', ...options });
+ }
+ 
+ // runChildCli: every ingestion CLI in this repo (and refresh-aggregates.js) speaks the same "API"
+ // — one console.log(JSON.stringify(...)) as its terminal line to stdout, progress on stderr, the
+-// same repo-wide main() convention verified across all four registry sources. No CLI in this repo
++// same repo-wide main() convention verified across all registry sources. No CLI in this repo
+ // exports its main() (checked before writing this file), so a child process — not an in-process
+ // import — is the only way to invoke one. spawnFn is injectable so tests never launch a real
+ // subprocess against real network/DB state; the real default really does spawn `node
+ // --env-file=.env <scriptPath> ...cliArgs`, matching every "node --env-file=.env ..." npm script.
+-export function runChildCli(scriptPath, cliArgs, { cwd = REPO_ROOT, spawnFn = defaultSpawn } = {}) {
+-  const result = spawnFn(process.execPath, ['--env-file=.env', scriptPath, ...cliArgs], { cwd });
++//
++// timeoutMs (round 2): per-call, defaulting to CHILD_TIMEOUT_MS — the caller (runChosenSource)
++// passes the CHOSEN SOURCE's own registry.timeoutMs, so legiscan's 75-minute budget is honored
++// without loosening the 8-minute default every other source uses.
++export function runChildCli(scriptPath, cliArgs, {
++  cwd = REPO_ROOT, spawnFn = defaultSpawn, timeoutMs = CHILD_TIMEOUT_MS,
++} = {}) {
++  const result = spawnFn(process.execPath, ['--env-file=.env', scriptPath, ...cliArgs], {
++    cwd, timeout: timeoutMs, maxBuffer: CHILD_MAX_BUFFER,
++  });
+   if (result.error) {
+-    // The child could not even be launched (e.g. a bad path) — unlike a child that launched and
+-    // reported its own typed failures, this IS a real scheduler-level error.
++    // I2: a timeout throws here too now (result.error.code === 'ETIMEDOUT', result.killed true) —
++    // this IS a real scheduler-level condition, distinctly reported so it is never confused with
++    // a bad path. M2: a maxBuffer overflow (ENOBUFS) also lands here and gets its own message
++    // instead of the misleading "could not launch". Both are tagged with `.code` and (for
++    // ETIMEDOUT) `.timeoutMs` on the thrown Error — round 2, finding 3: runChosenSource uses this
++    // to know a forceful kill happened and that source's own ingestion_runs row may need to be
++    // closed (a graceful crash inside the CLI's own try/catch already self-closes; only a
++    // SIGTERM/SIGKILL from spawnSync bypasses that).
++    if (result.error.code === 'ETIMEDOUT') {
++      const err = new Error(`${scriptPath} exceeded its ${timeoutMs}ms timeout and was killed (ETIMEDOUT)`);
++      err.code = 'ETIMEDOUT';
++      err.timeoutMs = timeoutMs;
++      throw err;
++    }
++    if (result.error.code === 'ENOBUFS') {
++      const err = new Error(`${scriptPath} exceeded the ${CHILD_MAX_BUFFER}-byte output buffer and was killed mid-run (ENOBUFS) — raise maxBuffer or investigate excessive stdout/stderr output`);
++      err.code = 'ENOBUFS';
++      err.timeoutMs = timeoutMs;
++      throw err;
++    }
+     throw new Error(`could not launch ${scriptPath}: ${result.error.message}`);
+   }
+   const { parsed, parseError } = parseChildOutput(result.stdout);
+   return {
+     scriptPath, cliArgs, exitStatus: result.status, stdout: result.stdout, stderr: result.stderr, parsed, parseError,
+   };
+ }
+ 
++export function parseChildOutput(stdout) {
++  try {
++    return { parsed: JSON.parse(String(stdout ?? '').trim()), parseError: null };
++  } catch (err) {
++    return { parsed: null, parseError: err.message };
++  }
++}
++
++// recordSchedulerAttemptFailure (C1, fix round 1): writes an HONEST failed ingestion_runs row on
++// the scheduler's own behalf, using the SAME openRun/closeRun helpers every CLI uses (reused, not
++// reinvented) — never a fake success, always status='failed' with real diagnostic detail. This is
++// what advances the durable due-ness signal when the chosen CLI failed before ever reaching its
++// own openRun call (ingest.js's collect() does all network work first — see ingest.js:536 vs
++// :556 — so a persistent congress.gov/senate.gov failure would otherwise leave NO row at all,
++// freezing that source's `elapsedMs` and letting pickMostOverdue return it on every tick forever,
++// starving mo-senate-web/mo-house-xml/legiscan while hammering the failing source at 4x its
++// declared interval — this was live on day one: us-congress sat ~91h overdue at review time).
++export async function recordSchedulerAttemptFailure(client, source, childResult, launchError = null) {
++  const runId = await openRun(client, source);
++  const stderrTail = String(childResult.stderr ?? '').slice(-2000); // bounded — never an unbounded write
++  await closeRun(client, runId, 'failed', {
++    scheduler_attempt: true,
++    exitCode: childResult.exitStatus,
++    stderrTail,
++    parseError: childResult.parseError,
++    launchError: launchError ? launchError.message : null,
++  });
++  return runId;
++}
++
++// closeOrphanedRunningRows (round 2, finding 3): three of the five CLIs (mo-senate-web,
++// mo-house-xml, legiscan) call openRun BEFORE their long work, unlike ingest.js — so a forceful
++// kill (I2's ETIMEDOUT, M2's ENOBUFS: both SIGTERM the child before it ever reaches its own
++// try/catch's closeRun) leaves that row stranded at status='running' forever. Left alone, this
++// lies twice over: public_freshness would show the source as permanently "running", and the
++// row's own started_at silently keeps advancing the durable due-ness signal (queryLatestStartedAt
++// has no status filter, by design — see its own comment) even though nothing is actually
++// happening. Closed here as status='failed' with real diagnostic detail — never left open, never
++// silently deleted.
++//
++// Scoped to `sinceIso` (the TICK's own start time, captured once in main() before anything else
++// runs) — `started_at >= sinceIso` — so this can only ever touch a row THIS tick's own child could
++// plausibly have created. A 'running' row from any earlier tick is a different, unrelated
++// question this function must never touch (if a previous tick's kill-cleanup already ran, that
++// row is 'failed' already, not 'running'; if this is somehow the first time it's being noticed,
++// that is its own separate investigation, not something to paper over here).
++//
++// Routed through selectAll (project law: no bare multi-row .select()) even though the realistic
++// result size is 0 or 1 — the whole point of that law is not re-deriving "is this one small
++// enough to skip it" per call site.
++export async function closeOrphanedRunningRows(client, source, { sinceIso, timeoutMs, note }) {
++  const { data, error } = await selectAll(client, 'ingestion_runs', 'id', {
++    filter: (q) => q.eq('source', source).eq('status', 'running').gte('started_at', sinceIso),
++  });
++  if (error) throw new Error(`orphaned-run lookup failed for source=${source}: ${error.message}`);
++  const closedIds = [];
++  for (const row of data ?? []) {
++    await closeRun(client, row.id, 'failed', { scheduler_kill: true, timeoutMs, note });
++    closedIds.push(row.id);
++  }
++  return closedIds;
++}
++
++// runChosenSource: invokes the chosen source's CLI, then reconciles the durable signal against
++// what actually landed in ingestion_runs. This is where C1 and I4 both live, since both need to
++// read the SAME post-run row (the "honest counts channel," per the review's own framing).
++//
++// C1: if the child throws (a genuine launch failure, an I2 timeout, or an M2 buffer overflow —
++// ALL of these are exactly "the child never got as far as reaching its own openRun", the scenario
++// C1 exists for) the error is caught HERE, not left to propagate — because propagating it would
++// skip the "did a new row appear" check entirely and defeat the whole point of the fix. Whether
++// the child threw or merely exited non-zero, if `ingestion_runs` shows no NEW row for this source
++// since before this call, the scheduler writes its own failed attempt row. Never rethrown — a
++// failing source is logged and reported, never a scheduler crash (the original, still-valid
++// design principle).
++//
++// I4: classifies the outcome from the run's OWN detail — never mode/status alone. `healthy` folds
++// in the tail-probe case (I4a): a windowed source (us-congress/us-senate) whose ONLY failures are
++// expected past-the-edge 404s reads as healthy, not alarming. `wroteRows` (I4b) is what gates the
++// aggregate refresh in main() — read from detail.counts, so a tick where every probe 404s and
++// zero rows landed correctly does NOT trigger a refresh, unlike the old mode/status heuristic.
++// tickStartIso (round 2, finding 3): this TICK's own start time (main() captures `now` once,
++// before anything else runs, and passes its ISO form through) — the ONLY thing
++// closeOrphanedRunningRows below is allowed to treat as "this run's own row." Required whenever a
++// forceful kill is possible; the existing round-1 tests never reach that branch, so they are
++// unaffected by its absence.
++export async function runChosenSource(client, chosen, { runChildCliFn = runChildCli, tickStartIso } = {}) {
++  let childResult;
++  let launchError = null;
++  let killedByScheduler = false;
++  try {
++    childResult = runChildCliFn(chosen.scriptPath, chosen.cliArgs, { timeoutMs: chosen.timeoutMs });
++  } catch (err) {
++    launchError = err;
++    // Round 2, finding 3: ETIMEDOUT (I2) and ENOBUFS (M2) both SIGTERM the child — it never
++    // reaches its own try/catch's closeRun, unlike a graceful in-process crash (which every CLI
++    // already self-closes as 'failed'). Only these two forceful-kill codes can strand a
++    // pre-opened run row at status='running'.
++    killedByScheduler = err.code === 'ETIMEDOUT' || err.code === 'ENOBUFS';
++    childResult = {
++      scriptPath: chosen.scriptPath,
++      cliArgs: chosen.cliArgs,
++      exitStatus: null,
++      stdout: '',
++      stderr: err.message,
++      parsed: null,
++      parseError: err.message,
++    };
++  }
++
++  let killClosedRunIds = [];
++  if (killedByScheduler) {
++    // mo-senate-web/mo-house-xml/legiscan all call openRun BEFORE their long work — for those,
++    // this closes the row the kill stranded at 'running'. For us-congress/us-senate (which open
++    // LATE, the actual C1 root cause), this correctly finds nothing and is a harmless no-op; the
++    // existing self-record path below handles that case instead.
++    killClosedRunIds = await closeOrphanedRunningRows(client, chosen.key, {
++      sinceIso: tickStartIso,
++      timeoutMs: launchError.timeoutMs ?? chosen.timeoutMs,
++      note: `${launchError.code}: ${launchError.message}`,
++    });
++  }
++
++  const latestRun = await queryLatestRun(client, chosen.key);
++  const newRowAppeared = latestRun !== null && latestRun.started_at !== chosen.lastStartedAtIso;
++
++  let selfRecordedFailure = false;
++  let selfRecordedRunId = null;
++  if (!newRowAppeared) {
++    selfRecordedRunId = await recordSchedulerAttemptFailure(client, chosen.key, childResult, launchError);
++    selfRecordedFailure = true;
++  }
++
++  const detail = selfRecordedFailure ? {} : (latestRun?.detail ?? {});
++  const status = selfRecordedFailure ? 'failed' : (latestRun?.status ?? null);
++  const failures = detail.failures ?? [];
++  const wroteRows = !selfRecordedFailure && countsShowRowsWritten(chosen.key, detail);
++  const tailProbeOnly = !selfRecordedFailure && status === 'partial'
++    && isExpectedTailProbeOutcome(chosen.key, failures, chosen.windowMaxKnown);
++  const healthy = !selfRecordedFailure && !killedByScheduler && (status === 'succeeded' || tailProbeOnly);
++
++  let note = null;
++  if (killedByScheduler) {
++    note = `scheduler killed this run (${launchError.code}) after its ${formatCooldownWait(launchError.timeoutMs ?? chosen.timeoutMs)} timeout — `
++      + `${killClosedRunIds.length} orphaned 'running' row(s) closed honestly`;
++  } else if (tailProbeOnly) {
++    note = `${failures.length} tail 404(s) past ${chosen.key === 'us-congress' ? 'roll' : 'vote'} ${chosen.windowMaxKnown} — expected from the probe window, not a failure`;
++  }
++
++  return {
++    childResult,
++    latestRun,
++    selfRecordedFailure,
++    selfRecordedRunId,
++    killedByScheduler,
++    killClosedRunIds,
++    launchError: launchError ? launchError.message : null,
++    outcome: {
++      status, healthy, wroteRows, tailProbeOnly, note,
++    },
++  };
++}
++
+ // ---- logging ----
+ 
+ function nowIso() {
+   return new Date().toISOString();
+ }
+ 
+-// writeLog: appends the SAME pretty-printed JSON this script prints to stdout into a dated file
+-// under .superpowers/artifacts/scheduler-logs/ (gitignored, matches the existing cached-artifact
+-// subdirectory convention) — "Lance must be able to read one file and know it is alive" (brief).
+-// One entry per invocation; every branch of main() below funnels through this single function so
+-// the file and stdout can never drift out of sync with each other.
++// writeLog: appends the SAME pretty-printed JSON this script prints to stdout into a dated
++// (UTC — see LOG_DIR's own comment) file under .superpowers/artifacts/scheduler-logs/ (gitignored,
++// matches the existing cached-artifact subdirectory convention) — "Lance must be able to read one
++// file and know it is alive" (brief). One entry per invocation; every branch of main() below
++// funnels through this single function so the file and stdout can never drift out of sync.
+ function writeLog(entry) {
+   mkdirSync(LOG_DIR, { recursive: true });
+-  const day = entry.timestamp.slice(0, 10); // YYYY-MM-DD
++  const day = entry.timestamp.slice(0, 10); // YYYY-MM-DD, UTC
+   const logPath = path.join(LOG_DIR, `${day}.log`);
+   const block = `=== ${entry.timestamp} ===\n${JSON.stringify(entry, null, 2)}\n\n`;
+   appendFileSync(logPath, block);
+   console.log(JSON.stringify(entry, null, 2));
+ }
+ 
++// ---- scheduler's own Supabase client (I2, fix round 1) ----
++
++// A single Supabase REST round-trip should take well under a second; 30s is generous headroom
++// while still bounding the worst case. Applied to every fetch this process's OWN client makes
++// (due-ness lookups, registry resolution) — NOT to the ingest CLIs' own fetches to
++// house.mo.gov/congress.gov/etc, which are untouched (their own limiters + this file's
++// CHILD_TIMEOUT_MS already bound those from the outside).
++const SCHEDULER_FETCH_TIMEOUT_MS = 30 * 1000;
++
++function timedFetch(url, options = {}) {
++  return fetch(url, { ...options, signal: AbortSignal.timeout(SCHEDULER_FETCH_TIMEOUT_MS) });
++}
++
++// getSchedulerClient: deliberately NOT src/lib/db.js's shared getClient() — this needs a fetch
++// timeout applied (I2), and getClient() is imported by every interactive CLI in the repo;
++// changing ITS defaults would widen an unattended-only decision's blast radius repo-wide (the
++// review's own instruction: "Do NOT change shared http.js defaults — blast radius stays inside
++// the scheduler", extended here to lib/db.js for the same reason). Mirrors getClient()'s own
++// env-var/null-if-unconfigured contract exactly otherwise.
++export function getSchedulerClient() {
++  const url = process.env.SUPABASE_URL;
++  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
++  if (!url || !key) return null;
++  return createClient(url, key, { auth: { persistSession: false }, global: { fetch: timedFetch } });
++}
++
+ // ---- main ----
+ 
+ async function main() {
+   const args = parseArgs(process.argv.slice(2));
+   const now = Date.now();
++  // Captured once, before anything else runs — the ONLY timestamp closeOrphanedRunningRows
++  // (round 2, finding 3) is allowed to treat as "this tick's own" when scoping which orphaned
++  // 'running' rows it may close.
++  const nowIsoAtTickStart = new Date(now).toISOString();
+ 
+   const lockResult = acquireLock(LOCK_PATH, { now });
+   if (!lockResult.acquired) {
+     // NOT an error — an overlapping tick is normal (Task Scheduler's 15-min cadence is shorter
+     // than every source's own interval by design) and must never surface as a scheduler failure.
+     writeLog({
+       timestamp: nowIso(),
+       mode: 'already-running',
+       note: `a live lock (pid ${lockResult.lock.pid}, started ${lockResult.lock.startedAt}) already exists — skipping this tick`,
+     });
+@@ -434,34 +901,34 @@ async function main() {
+ 
+   const lockReclaimed = lockResult.reason === 'reclaimed-stale' ? lockResult.staleLock : null;
+   if (lockReclaimed) {
+     console.error(
+       `[${nowIso()}] WARNING: reclaimed a stale lock (pid ${lockReclaimed.pid}, started `
+         + `${lockReclaimed.startedAt}, older than ${formatCooldownWait(MAX_RUN_DURATION_MS)}) — a prior run may have crashed without releasing it`,
+     );
+   }
+ 
+   try {
+-    const client = getClient();
++    const client = getSchedulerClient();
+     if (!client) {
+       writeLog({
+         timestamp: nowIso(),
+         mode: 'blocked',
+         reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — cannot compute source due-ness without reading ingestion_runs',
+         lockReclaimed,
+       });
+       process.exitCode = 1;
+       return;
+     }
+ 
+     const year = new Date(now).getFullYear();
+-    const registry = await buildRegistry(client, { now, year });
++    const registry = await buildRegistry(client, { now, year, only: args.only });
+     const scoped = args.only ? registry.filter((e) => e.key === args.only) : registry;
+     const withDueness = scoped.map((e) => computeSourceDueness(e, now));
+     const chosen = pickMostOverdue(withDueness);
+ 
+     const sourcesSummary = withDueness.map((e) => ({
+       key: e.key,
+       due: e.due,
+       remainingMs: e.remainingMs,
+       remainingHuman: e.remainingMs > 0 ? formatCooldownWait(e.remainingMs) : '0s',
+       resolvable: e.resolvable,
+@@ -491,56 +958,67 @@ async function main() {
+         chosen: chosen.key,
+         reason,
+         wouldRun: { scriptPath: chosen.scriptPath, cliArgs: chosen.cliArgs },
+         sources: sourcesSummary,
+         note: 'zero fetches, zero writes — --dry-run',
+         lockReclaimed,
+       });
+       return;
+     }
+ 
+-    const childResult = runChildCli(chosen.scriptPath, chosen.cliArgs);
+-    const wroteSomething = runWroteSomething(childResult.parsed);
++    // Round 2, finding 2: the lock's declared duration must cover THIS source's real timeout
++    // before we spawn it — written after selection (now that we know chosen.timeoutMs), before
++    // the child starts, so a later tick's stale-reclaim check judges this run against its actual
++    // bound (e.g. legiscan's 75 min) rather than the generic selection-phase placeholder
++    // acquireLock wrote.
++    updateLockMaxDuration(LOCK_PATH, lockResult.nonce, chosen.timeoutMs + LOCK_GRACE_MS);
++
++    const run = await runChosenSource(client, chosen, { tickStartIso: nowIsoAtTickStart });
+ 
+-    // Standing practice from the ledger (brief): every ingest batch ends with an aggregate
+-    // refresh, else public_position_totals/public_party_alignment silently drift behind the vote
+-    // lists — a real user-visible defect on 2026-07-31. Skipped only when nothing was written
+-    // (runWroteSomething), and its own outcome NEVER overrides the primary ingest run's already-
+-    // recorded result below, mirroring summarize.js's persistReferencedTermsGracefully: a
+-    // secondary, best-effort follow-up must never make an otherwise-successful tick look failed.
++    // I4b: refresh-aggregates fires ONLY when the run's own detail.counts show rows actually
++    // written (run.outcome.wroteRows) — never the old "mode==='live' && succeeded/partial"
++    // heuristic, which was true even on a tick where every us-congress probe 404s and nothing
++    // landed, so the refresh used to fire unconditionally every hour regardless.
+     let aggregatesResult = null;
+-    if (wroteSomething) {
++    if (run.outcome.wroteRows) {
+       const refreshResult = runChildCli('scripts/refresh-aggregates.js', []);
+       aggregatesResult = {
+         exitStatus: refreshResult.exitStatus, parsed: refreshResult.parsed, parseError: refreshResult.parseError,
+       };
+     }
+ 
+     writeLog({
+       timestamp: nowIso(),
+       mode: 'live',
+       chosen: chosen.key,
+       reason,
++      selfRecordedFailure: run.selfRecordedFailure,
++      killedByScheduler: run.killedByScheduler,
++      killClosedRunIds: run.killClosedRunIds,
+       result: {
+-        exitStatus: childResult.exitStatus,
+-        mode: childResult.parsed?.mode ?? null,
+-        status: childResult.parsed?.status ?? null,
+-        counts: childResult.parsed?.counts ?? null,
+-        failures: childResult.parsed?.failures ?? null,
+-        parseError: childResult.parseError,
++        exitStatus: run.childResult.exitStatus,
++        mode: run.childResult.parsed?.mode ?? null,
++        status: run.outcome.status,
++        healthy: run.outcome.healthy,
++        note: run.outcome.note,
++        counts: run.childResult.parsed?.counts ?? null,
++        failures: run.childResult.parsed?.failures ?? null,
++        parseError: run.childResult.parseError,
++        launchError: run.launchError,
+       },
+-      aggregatesRefreshed: wroteSomething,
++      aggregatesRefreshed: run.outcome.wroteRows,
+       aggregatesResult,
+       sources: sourcesSummary,
+       lockReclaimed,
+     });
+   } finally {
+     // Always released, including on throw — an overlapping tick after a genuine crash would
+     // otherwise be permanently blocked until MAX_RUN_DURATION_MS's stale-reclaim kicks in.
+-    releaseLock(LOCK_PATH);
++    // Ownership-checked (I1) via the nonce this same process was given when it acquired the lock.
++    releaseLock(LOCK_PATH, lockResult.nonce);
+   }
+ }
+ 
+ const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
+ if (invokedDirectly) {
+   main().catch((err) => { console.error(err); process.exitCode = 1; });
+ }
+diff --git a/src/cli/summarize.js b/src/cli/summarize.js
+index 30cfaca..24afcab 100644
+--- a/src/cli/summarize.js
++++ b/src/cli/summarize.js
+@@ -4,20 +4,24 @@ import { billTypeSlug } from '../adapters/us-congress.js';
+ import { parseTextVersions, pickTextUrl, stripHtml, sha256, fetchBillTextVersions, fetchTextBody } from '../adapters/us-congress-text.js';
+ import {
+   getAnthropicClient, summarizeBill, MODEL, PROMPT_VERSION,
+   OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
+ } from '../lib/summarizer.js';
+ import {
+   persistReferencedTerms, GLOSSARY_TERMS_TABLE, SUMMARY_TERMS_TABLE,
+ } from '../lib/glossary-terms.js';
+ 
+ const JURISDICTION = 'us-congress';
++// M4 (task review fix round 1): golden.js's runCheck re-runs this EXACT summarizeBill call
++// (same model, same shape of input/output) and estimates it at $0.11/bill — reused here rather
++// than a second, independently-guessed number for the identical underlying call.
++export const SUMMARIZE_COST_PER_BILL_USD = 0.11;
+ const FAILURE_TYPES = [SourceFetchError, OversizeTextError, SummaryRefusedError, SummaryTruncatedError];
+ // A summary in any of these statuses, at the current text hash, is "already summarized" — skip
+ // it. 'approved' means an editor signed off but hasn't published yet; it must not be
+ // re-summarized (would duplicate a paid API call and insert a redundant draft row).
+ const ALREADY_SUMMARIZED_STATUSES = new Set(['draft', 'approved', 'published']);
+ 
+ export function parseArgs(argv) {
+   const out = { dryRun: false, bill: null };
+   let i = 0;
+   while (i < argv.length) {
+@@ -284,20 +288,27 @@ async function main() {
+     console.log(JSON.stringify({
+       mode: 'dry-run',
+       counts: { bills: bills.length, needText: plan.needText.length, needSummary: plan.needSummary.length, stale: plan.stale.length },
+       needText: plan.needText.map((b) => b.identifier),
+       needSummary: plan.needSummary.map((b) => b.identifier),
+       stale: plan.stale.map((s) => s.bill_id),
+     }, null, 2));
+     return;
+   }
+ 
++  // M4 (task review fix round 1): candidateCount is needText + needSummary — EVERY bill in
++  // needText also gets summarized right after its text is fetched (see the loop below), so
++  // needSummary alone would understate the true number of billed calls this run is about to make.
++  const candidateCount = plan.needText.length + plan.needSummary.length;
++  const estimate = (candidateCount * SUMMARIZE_COST_PER_BILL_USD).toFixed(2);
++  console.log(`Cost estimate: ${candidateCount} bill(s) x ~$${SUMMARIZE_COST_PER_BILL_USD.toFixed(2)} = ~$${estimate} in live model calls (bill summary authoring).`);
++
+   // Mechanical per-run approval gate (task 1) — same standing policy as GLOSS_RUN_APPROVED in
+   // gloss.js/extract-terms.js and GOLDEN_CHECK_APPROVED in golden.js: no live, billed Anthropic
+   // call runs without Lance's explicit per-run opt-in. Caught locally (not left to propagate to
+   // main().catch below) so the CLI prints the same clean single BLOCKED line gloss.js does,
+   // never a raw stack trace.
+   try {
+     checkSummarizeApproval(process.env.SUMMARIZE_RUN_APPROVED);
+   } catch (err) {
+     if (err instanceof RunNotApprovedError) {
+       console.log(err.message);
+diff --git a/src/cli/verify.js b/src/cli/verify.js
+index ce7ca34..0becab8 100644
+--- a/src/cli/verify.js
++++ b/src/cli/verify.js
+@@ -5,20 +5,25 @@ import {
+   getAnthropicClient, MAX_TEXT_CHARS,
+   OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
+ } from '../lib/summarizer.js';
+ import {
+   verifyBill, VERIFIER_MODEL, VERIFY_PROMPT_VERSION, assessVerdicts, VerificationIncompleteError,
+ } from '../lib/verifier.js';
+ import { parseBullets } from '../../site/js/summary-parse.js';
+ 
+ export { parseBullets };
+ 
++// M4 (task review fix round 1): verifyBill is a comparably-sized bill-level call to the
++// summarizeBill golden.js/summarize.js already estimate at $0.11 — same order of magnitude, no
++// independently-metered figure exists for verification alone, so the same estimate is reused
++// rather than invented from nothing.
++export const VERIFY_COST_PER_SUMMARY_USD = 0.11;
+ const FAILURE_TYPES = [OversizeTextError, SummaryRefusedError, SummaryTruncatedError, VerificationIncompleteError];
+ // Same target set as summarize.js's staleness handling: a draft is the normal unreviewed state,
+ // stale means the text moved out from under an existing draft — both need a fresh verification.
+ // approved/published/rejected summaries are out of scope for this pass.
+ const TARGET_STATUSES = ['draft', 'stale'];
+ const VERIFICATIONS_TABLE = 'summary_verifications';
+ 
+ export function parseArgs(argv) {
+   const out = { dryRun: false };
+   let i = 0;
+@@ -158,20 +163,25 @@ async function main() {
+     const out = {
+       mode: 'dry-run',
+       counts: { candidates: summaries.length, unverified: unverified.length },
+       unverified: unverified.map((s) => ({ id: s.id, status: s.status, identifier: s.bills ? s.bills.identifier : null })),
+     };
+     if (tableMissing) out.note = '(summary_verifications missing — 0004 not applied; treating all as unverified)';
+     console.log(JSON.stringify(out, null, 2));
+     return;
+   }
+ 
++  // M4 (task review fix round 1): cost estimate printed before the gate, gloss.js's own voice —
++  // both files already know their candidate count at this point (unverified.length).
++  const estimate = (unverified.length * VERIFY_COST_PER_SUMMARY_USD).toFixed(2);
++  console.log(`Cost estimate: ${unverified.length} summary(ies) x ~$${VERIFY_COST_PER_SUMMARY_USD.toFixed(2)} = ~$${estimate} in live model calls (adversarial summary verification).`);
++
+   // Mechanical per-run approval gate (task 1) — same standing policy as GLOSS_RUN_APPROVED in
+   // gloss.js/extract-terms.js and GOLDEN_CHECK_APPROVED in golden.js: no live, billed Anthropic
+   // call runs without Lance's explicit per-run opt-in. Caught locally (not left to propagate to
+   // main().catch below) so the CLI prints the same clean single BLOCKED line gloss.js does,
+   // never a raw stack trace.
+   try {
+     checkVerifyApproval(process.env.VERIFY_RUN_APPROVED);
+   } catch (err) {
+     if (err instanceof RunNotApprovedError) {
+       console.log(err.message);
+diff --git a/tests/scheduled-ingest.test.js b/tests/scheduled-ingest.test.js
+index d0497d0..64705f1 100644
+--- a/tests/scheduled-ingest.test.js
++++ b/tests/scheduled-ingest.test.js
+@@ -1,60 +1,63 @@
+ import { test } from 'node:test';
+ import assert from 'node:assert/strict';
+ import {
+   mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync,
+ } from 'node:fs';
+ import { spawnSync } from 'node:child_process';
+ import path from 'node:path';
+ import os from 'node:os';
+ import {
+-  parseArgs, isLockStale, acquireLock, releaseLock,
++  parseArgs, isLockStale, acquireLock, releaseLock, updateLockMaxDuration,
+   computeSourceDueness, pickMostOverdue,
+-  parseUsHouseRoll, computeRollWindow,
+-  parseChildOutput, runWroteSomething,
+-  queryLatestStartedAt, resolveLegiscanSessionId, resolveUsCongressRollWindow, buildRegistry,
+-  runChildCli, envIntervalMs,
+-  MAX_RUN_DURATION_MS, US_CONGRESS_CONGRESS, US_CONGRESS_ROLL_WINDOW,
++  parseUsHouseRoll, parseUsSenateVote, computeRollWindow,
++  isExpectedTailProbeOutcome, countsShowRowsWritten,
++  parseChildOutput,
++  queryLatestStartedAt, queryLatestRun,
++  resolveLegiscanSessionId, resolveUsCongressRollWindow, resolveUsSenateVoteWindow, buildRegistry,
++  runChildCli, recordSchedulerAttemptFailure, closeOrphanedRunningRows, runChosenSource,
++  getSchedulerClient, envIntervalMs,
++  MAX_RUN_DURATION_MS, CHILD_TIMEOUT_MS, CHILD_MAX_BUFFER, LEGISCAN_CHILD_TIMEOUT_MS, LOCK_GRACE_MS,
++  US_CONGRESS_CONGRESS, US_CONGRESS_ROLL_WINDOW, US_SENATE_SESSION, US_SENATE_VOTE_WINDOW,
+ } from '../scripts/scheduled-ingest.js';
+ import { MO_SENATE_MIN_INTERVAL_MS } from '../src/adapters/mo-senate-web.js';
+ import { MO_HOUSE_MIN_INTERVAL_MS, DEFAULT_MO_HOUSE_SESSION } from '../src/adapters/mo-house-xml.js';
+ 
+ // ---- parseArgs ----
+ 
+ test('parseArgs defaults to live, no --only', () => {
+   const out = parseArgs([]);
+   assert.equal(out.dryRun, false);
+   assert.equal(out.only, null);
+ });
+ 
+-test('parseArgs accepts --dry-run and --only <source>', () => {
+-  const out = parseArgs(['--dry-run', '--only', 'mo-senate-web']);
+-  assert.equal(out.dryRun, true);
+-  assert.equal(out.only, 'mo-senate-web');
++test('parseArgs accepts --dry-run and --only <source>, including the new us-senate source', () => {
++  assert.equal(parseArgs(['--dry-run', '--only', 'mo-senate-web']).only, 'mo-senate-web');
++  assert.equal(parseArgs(['--only', 'us-senate']).only, 'us-senate');
+ });
+ 
+ test('parseArgs rejects an unknown --only value (never silently runs the wrong source)', () => {
+   assert.throws(() => parseArgs(['--only', 'bogus-source']), /unknown source/);
+ });
+ 
+ test('parseArgs rejects unknown flags', () => {
+   assert.throws(() => parseArgs(['--wat']), /unknown flag/);
+ });
+ 
+-// ---- envIntervalMs: the mechanical floor behind US_CONGRESS_MIN_INTERVAL_MS/LEGISCAN_MIN_INTERVAL_MS ----
++// ---- envIntervalMs: the mechanical floor behind US_CONGRESS_MIN_INTERVAL_MS/US_SENATE_MIN_INTERVAL_MS/LEGISCAN_MIN_INTERVAL_MS ----
+ 
+ test('envIntervalMs floors a configured value at the minimum, never letting it go lower', () => {
+   assert.equal(envIntervalMs('__NOPE__', 1000, 5000), 5000, 'unset env falls back to default, then floored');
+   assert.equal(envIntervalMs('__NOPE__', 10000, 5000), 10000, 'unset env default above floor is kept');
+ });
+ 
+-// ---- isLockStale / acquireLock / releaseLock — single-instance lock discipline ----
++// ---- isLockStale / acquireLock / releaseLock — single-instance lock discipline, ownership-checked (I1) ----
+ 
+ test('isLockStale: false when within the max run duration, true once past it', () => {
+   const now = Date.parse('2026-07-31T12:10:00.000Z');
+   const lock = { startedAt: '2026-07-31T12:00:00.000Z', pid: 123 };
+   assert.equal(isLockStale(lock, now, 20 * 60 * 1000), false); // 10 min elapsed, 20 min ceiling
+   assert.equal(isLockStale(lock, now, 5 * 60 * 1000), true); // 10 min elapsed, 5 min ceiling
+ });
+ 
+ test('isLockStale: an unparseable startedAt is treated as stale, not trusted', () => {
+   assert.equal(isLockStale({ startedAt: 'not-a-date' }, Date.now(), MAX_RUN_DURATION_MS), true);
+@@ -62,189 +65,380 @@ test('isLockStale: an unparseable startedAt is treated as stale, not trusted', (
+ 
+ function withTmpDir(fn) {
+   const dir = mkdtempSync(path.join(os.tmpdir(), 'vg-scheduler-test-'));
+   try {
+     return fn(dir);
+   } finally {
+     rmSync(dir, { recursive: true, force: true });
+   }
+ }
+ 
+-test('acquireLock: fresh lock succeeds and writes pid+timestamp; a second attempt while it is live is refused', () => {
++test('acquireLock: fresh lock succeeds, writes pid+timestamp+nonce; a second attempt while it is live is refused', () => {
+   withTmpDir((dir) => {
+     const lockPath = path.join(dir, 'nested', 'scheduler.lock.json');
+     const first = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
+     assert.equal(first.acquired, true);
+     assert.equal(first.reason, 'fresh');
++    assert.ok(first.nonce, 'a fresh lock must carry a nonce for I1\'s ownership check');
+     assert.ok(existsSync(lockPath));
+     const written = JSON.parse(readFileSync(lockPath, 'utf8'));
+     assert.equal(written.pid, process.pid);
+     assert.equal(written.startedAt, '2026-07-31T12:00:00.000Z');
++    assert.equal(written.nonce, first.nonce);
+ 
+-    // Second attempt 1 minute later, well within MAX_RUN_DURATION_MS — must be refused, never
+-    // silently proceed (this is the exact "no stacked overlapping processes" guarantee).
+     const second = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:01:00.000Z') });
+     assert.equal(second.acquired, false);
+     assert.equal(second.reason, 'already-running');
+     assert.equal(second.lock.pid, process.pid);
+   });
+ });
+ 
+-test('acquireLock: a lock older than the max run duration is reclaimed, not trusted forever', () => {
++test('acquireLock: a lock older than the max run duration is reclaimed, not trusted forever, and gets a FRESH nonce', () => {
+   withTmpDir((dir) => {
+     const lockPath = path.join(dir, 'scheduler.lock.json');
+-    acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
++    const first = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
+ 
+     const muchLater = Date.parse('2026-07-31T12:00:00.000Z') + MAX_RUN_DURATION_MS + 1;
+     const reclaimed = acquireLock(lockPath, { now: muchLater });
+     assert.equal(reclaimed.acquired, true);
+     assert.equal(reclaimed.reason, 'reclaimed-stale');
+     assert.ok(reclaimed.staleLock, 'the reclaimed lock\'s own prior contents are surfaced for the warning log');
++    assert.notEqual(reclaimed.nonce, first.nonce, 'a reclaimed lock must not reuse the stale owner\'s nonce');
+   });
+ });
+ 
+ test('acquireLock: a corrupt/unreadable lock file is treated as stale and reclaimed, never crashes', () => {
+   withTmpDir((dir) => {
+     const lockPath = path.join(dir, 'scheduler.lock.json');
+     mkdirSync(path.dirname(lockPath), { recursive: true });
+     writeFileSync(lockPath, 'not json{{{');
+     const result = acquireLock(lockPath, { now: Date.now() });
+     assert.equal(result.acquired, true);
+     assert.equal(result.reason, 'reclaimed-stale');
+   });
+ });
+ 
+-test('releaseLock: deletes an existing lock file, and is a safe no-op when nothing is there', () => {
++test('releaseLock: deletes an existing lock file when the nonce matches, and is a safe no-op when nothing is there', () => {
+   withTmpDir((dir) => {
+     const lockPath = path.join(dir, 'scheduler.lock.json');
+-    acquireLock(lockPath, { now: Date.now() });
++    const lock = acquireLock(lockPath, { now: Date.now() });
+     assert.ok(existsSync(lockPath));
+-    releaseLock(lockPath);
++    releaseLock(lockPath, lock.nonce);
++    assert.ok(!existsSync(lockPath));
++    assert.doesNotThrow(() => releaseLock(lockPath, lock.nonce)); // already gone — must not throw
++  });
++});
++
++// ---- I1 (fix round 1) red-first: a slow run must never delete a NEWER tick's reclaimed lock ----
++
++test('I1: releaseLock only deletes when the nonce matches — a late release from a reclaimed-away lock is a safe no-op, never deletes the newer owner\'s lock', () => {
++  withTmpDir((dir) => {
++    const lockPath = path.join(dir, 'scheduler.lock.json');
++    const tickA = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
++    assert.equal(tickA.acquired, true);
++
++    // Tick A's child hangs past MAX_RUN_DURATION_MS; tick B reclaims the now-stale lock.
++    const muchLater = Date.parse('2026-07-31T12:00:00.000Z') + MAX_RUN_DURATION_MS + 1;
++    const tickB = acquireLock(lockPath, { now: muchLater });
++    assert.equal(tickB.acquired, true);
++    assert.notEqual(tickB.nonce, tickA.nonce);
++
++    // Tick A finally "returns" and its finally-block releases with ITS OWN (now-stale) nonce —
++    // must NOT delete tick B's live lock. This is the exact defect: without the nonce check, this
++    // unlinkSync would blindly remove whatever file is at lockPath, which is now tick B's.
++    releaseLock(lockPath, tickA.nonce);
++    assert.ok(existsSync(lockPath), 'tick B\'s lock must survive tick A\'s late release');
++    const stillThere = JSON.parse(readFileSync(lockPath, 'utf8'));
++    assert.equal(stillThere.nonce, tickB.nonce, 'the surviving lock must still be tick B\'s, unmodified');
++
++    // Tick B's own release, with its own correct nonce, DOES work.
++    releaseLock(lockPath, tickB.nonce);
+     assert.ok(!existsSync(lockPath));
+-    assert.doesNotThrow(() => releaseLock(lockPath)); // already gone — must not throw
++  });
++});
++
++test('I1: releaseLock with no nonce (or the wrong nonce) never deletes anything', () => {
++  withTmpDir((dir) => {
++    const lockPath = path.join(dir, 'scheduler.lock.json');
++    acquireLock(lockPath, { now: Date.now() });
++    releaseLock(lockPath, null);
++    assert.ok(existsSync(lockPath));
++    releaseLock(lockPath); // no second arg at all
++    assert.ok(existsSync(lockPath));
++    releaseLock(lockPath, 'totally-wrong-nonce');
++    assert.ok(existsSync(lockPath));
++  });
++});
++
++// ---- Round 2, finding 2 RED-FIRST: the lock's stale-reclaim window must be the LOCK'S OWN
++// declared maxDurationMs, not one fixed constant — a 75-min legiscan run and a fixed 10-min
++// window cannot coexist. Exactly the coordinator's three named cases. ----
++
++test('ROUND 2 RED-FIRST: a lock declaring 75 minutes (legiscan) is NOT reclaimed at 15 minutes', () => {
++  withTmpDir((dir) => {
++    const lockPath = path.join(dir, 'scheduler.lock.json');
++    const t0 = Date.parse('2026-07-31T12:00:00.000Z');
++    const tickA = acquireLock(lockPath, { now: t0 });
++    // Selection has finished and legiscan (75 min timeout + 1 min grace) was chosen — declare
++    // the real duration BEFORE spawning, exactly as main() does.
++    updateLockMaxDuration(lockPath, tickA.nonce, LEGISCAN_CHILD_TIMEOUT_MS + LOCK_GRACE_MS);
++
++    const fifteenMinLater = t0 + 15 * 60 * 1000;
++    const tickB = acquireLock(lockPath, { now: fifteenMinLater });
++    assert.equal(tickB.acquired, false, 'a 76-min declared lock must not be reclaimed at 15 minutes — a fixed 10-min window would have wrongly reclaimed it here');
++    assert.equal(tickB.reason, 'already-running');
++  });
++});
++
++test('ROUND 2 RED-FIRST: a lock declaring 480s (the default family) IS still reclaimed at 15 minutes', () => {
++  withTmpDir((dir) => {
++    const lockPath = path.join(dir, 'scheduler.lock.json');
++    const t0 = Date.parse('2026-07-31T12:00:00.000Z');
++    const tickA = acquireLock(lockPath, { now: t0 });
++    updateLockMaxDuration(lockPath, tickA.nonce, 480 * 1000); // exactly CHILD_TIMEOUT_MS, no grace
++
++    const fifteenMinLater = t0 + 15 * 60 * 1000;
++    const tickB = acquireLock(lockPath, { now: fifteenMinLater });
++    assert.equal(tickB.acquired, true, 'a lock declaring only 8 minutes must be reclaimable well past that');
++    assert.equal(tickB.reason, 'reclaimed-stale');
++  });
++});
++
++test('ROUND 2 RED-FIRST: a corrupt lock file is STILL reclaimed at 15 minutes (fail-safe fallback to MAX_RUN_DURATION_MS, unaffected by the new per-lock duration)', () => {
++  withTmpDir((dir) => {
++    const lockPath = path.join(dir, 'scheduler.lock.json');
++    mkdirSync(path.dirname(lockPath), { recursive: true });
++    writeFileSync(lockPath, 'not json at all{{{');
++    const t0 = Date.parse('2026-07-31T12:00:00.000Z');
++    const result = acquireLock(lockPath, { now: t0 + 15 * 60 * 1000 });
++    assert.equal(result.acquired, true);
++    assert.equal(result.reason, 'reclaimed-stale');
++  });
++});
++
++test('isLockStale directly: missing/non-numeric/non-positive maxDurationMs all fall back to fallbackMaxDurationMs, never trusted as "wait forever"', () => {
++  const now = Date.parse('2026-07-31T12:15:00.000Z'); // 15 min after startedAt below — past the 10-min default
++  const startedAt = '2026-07-31T12:00:00.000Z';
++  assert.equal(isLockStale({ startedAt }, now), true, 'no maxDurationMs field at all (old-format lock)');
++  assert.equal(isLockStale({ startedAt, maxDurationMs: 'not-a-number' }, now), true);
++  assert.equal(isLockStale({ startedAt, maxDurationMs: -5 }, now), true);
++  assert.equal(isLockStale({ startedAt, maxDurationMs: 0 }, now), true);
++});
++
++test('isLockStale directly: a valid maxDurationMs on the lock is honored over the fallback', () => {
++  const now = Date.parse('2026-07-31T12:15:00.000Z'); // 15 min elapsed
++  const startedAt = '2026-07-31T12:00:00.000Z';
++  assert.equal(isLockStale({ startedAt, maxDurationMs: 75 * 60 * 1000 }, now), false);
++  assert.equal(isLockStale({ startedAt, maxDurationMs: 8 * 60 * 1000 }, now), true);
++});
++
++test('acquireLock writes the initial maxDurationMs (MAX_RUN_DURATION_MS, the selection-phase default) into a fresh lock', () => {
++  withTmpDir((dir) => {
++    const lockPath = path.join(dir, 'scheduler.lock.json');
++    acquireLock(lockPath, { now: Date.now() });
++    const written = JSON.parse(readFileSync(lockPath, 'utf8'));
++    assert.equal(written.maxDurationMs, MAX_RUN_DURATION_MS);
++  });
++});
++
++test('updateLockMaxDuration rewrites the declared duration when the nonce matches, preserving pid/startedAt/nonce', () => {
++  withTmpDir((dir) => {
++    const lockPath = path.join(dir, 'scheduler.lock.json');
++    const lock = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
++    const ok = updateLockMaxDuration(lockPath, lock.nonce, 75 * 60 * 1000);
++    assert.equal(ok, true);
++    const written = JSON.parse(readFileSync(lockPath, 'utf8'));
++    assert.equal(written.maxDurationMs, 75 * 60 * 1000);
++    assert.equal(written.pid, process.pid);
++    assert.equal(written.nonce, lock.nonce);
++    assert.equal(written.startedAt, '2026-07-31T12:00:00.000Z');
++  });
++});
++
++test('updateLockMaxDuration never overwrites a lock it does not (verifiably) own, and never throws when the file is missing', () => {
++  withTmpDir((dir) => {
++    const lockPath = path.join(dir, 'scheduler.lock.json');
++    acquireLock(lockPath, { now: Date.now() });
++    assert.equal(updateLockMaxDuration(lockPath, 'wrong-nonce', 999), false);
++    assert.equal(updateLockMaxDuration(lockPath, null, 999), false);
++    const unchanged = JSON.parse(readFileSync(lockPath, 'utf8'));
++    assert.equal(unchanged.maxDurationMs, MAX_RUN_DURATION_MS, 'the rejected attempts must leave the lock completely untouched');
++
++    assert.equal(updateLockMaxDuration(path.join(dir, 'nope.json'), 'any-nonce', 999), false);
+   });
+ });
+ 
+ // ---- computeSourceDueness / pickMostOverdue ----
+ 
+ test('computeSourceDueness: never-run source (lastStartedAtIso null) is due, with infinite elapsed', () => {
+   const now = Date.now();
+   const e = computeSourceDueness({ key: 'x', minIntervalMs: 1000, lastStartedAtIso: null }, now);
+   assert.equal(e.due, true);
+   assert.equal(e.remainingMs, 0);
+   assert.equal(e.elapsedMs, Infinity);
+ });
+ 
+ test('computeSourceDueness: recently-run source is not due; remainingMs matches remainingCooldownMs\'s own arithmetic', () => {
+   const now = Date.parse('2026-07-31T12:30:00.000Z');
+   const e = computeSourceDueness({ key: 'x', minIntervalMs: 30 * 60 * 1000, lastStartedAtIso: '2026-07-31T12:20:00.000Z' }, now);
+   assert.equal(e.due, false);
+-  assert.equal(e.remainingMs, 20 * 60 * 1000); // 30 min interval - 10 min elapsed
++  assert.equal(e.remainingMs, 20 * 60 * 1000);
+   assert.equal(e.elapsedMs, 10 * 60 * 1000);
+ });
+ 
+ test('computeSourceDueness: a source whose cooldown has fully elapsed is due', () => {
+   const now = Date.parse('2026-07-31T13:00:00.000Z');
+   const e = computeSourceDueness({ key: 'x', minIntervalMs: 30 * 60 * 1000, lastStartedAtIso: '2026-07-31T12:00:00.000Z' }, now);
+   assert.equal(e.due, true);
+   assert.equal(e.remainingMs, 0);
+ });
+ 
+ test('pickMostOverdue: chooses the due source with the longest elapsed time, never a not-due one', () => {
+   const entries = [
+     { key: 'a', due: true, resolvable: true, elapsedMs: 1000 },
+     { key: 'b', due: true, resolvable: true, elapsedMs: 5000 },
+-    { key: 'c', due: false, resolvable: true, elapsedMs: 999999 }, // not due — must never win despite huge elapsed
++    { key: 'c', due: false, resolvable: true, elapsedMs: 999999 },
+   ];
+   assert.equal(pickMostOverdue(entries).key, 'b');
+ });
+ 
+-test('pickMostOverdue: an unresolvable source (e.g. legiscan with no session id) is never chosen even if due and most overdue', () => {
++test('pickMostOverdue: an unresolvable source (e.g. legiscan with no session id, or a failed lookup) is never chosen even if due and most overdue', () => {
+   const entries = [
+     { key: 'a', due: true, resolvable: true, elapsedMs: 10 },
+     { key: 'legiscan', due: true, resolvable: false, elapsedMs: Infinity },
+   ];
+   assert.equal(pickMostOverdue(entries).key, 'a');
+ });
+ 
+ test('pickMostOverdue: null when nothing is due', () => {
+   const entries = [{ key: 'a', due: false, resolvable: true, elapsedMs: 10 }];
+   assert.equal(pickMostOverdue(entries), null);
+ });
+ 
+ test('pickMostOverdue: a source that has never run (Infinity elapsed) outranks every source with a real timestamp', () => {
+   const entries = [
+     { key: 'seen', due: true, resolvable: true, elapsedMs: 99 * 24 * 60 * 60 * 1000 },
+     { key: 'never', due: true, resolvable: true, elapsedMs: Infinity },
+   ];
+   assert.equal(pickMostOverdue(entries).key, 'never');
+ });
+ 
+-// ---- parseUsHouseRoll / computeRollWindow ----
++// ---- parseUsHouseRoll / parseUsSenateVote / computeRollWindow ----
+ 
+ test('parseUsHouseRoll extracts the trailing roll number from a us-house source_key', () => {
+   assert.equal(parseUsHouseRoll('us-house-119-2026-350'), 350);
+   assert.equal(parseUsHouseRoll('us-house-119-2026-7'), 7);
+ });
+ 
+-test('parseUsHouseRoll returns null for anything that isn\'t that exact shape (never a false roll number)', () => {
++test('parseUsHouseRoll returns null for anything that isn\'t that exact shape', () => {
+   assert.equal(parseUsHouseRoll('us-senate-119-1-616'), null);
+   assert.equal(parseUsHouseRoll(''), null);
+   assert.equal(parseUsHouseRoll(null), null);
+   assert.equal(parseUsHouseRoll(undefined), null);
+ });
+ 
++test('parseUsSenateVote extracts the trailing vote number from a us-senate source_key (I5)', () => {
++  assert.equal(parseUsSenateVote('us-senate-119-2-661'), 661);
++  assert.equal(parseUsSenateVote('us-senate-119-1-1'), 1);
++});
++
++test('parseUsSenateVote returns null for a us-house key or anything else', () => {
++  assert.equal(parseUsSenateVote('us-house-119-2026-350'), null);
++  assert.equal(parseUsSenateVote(''), null);
++  assert.equal(parseUsSenateVote(null), null);
++});
++
+ test('computeRollWindow: starts one past the max known roll, spans windowSize', () => {
+   assert.deepEqual(computeRollWindow(350, 10), { lo: 351, hi: 360 });
+ });
+ 
+ test('computeRollWindow: zero/no prior rolls on file starts the window at roll 1', () => {
+   assert.deepEqual(computeRollWindow(0, 10), { lo: 1, hi: 10 });
+   assert.deepEqual(computeRollWindow(undefined, 10), { lo: 1, hi: 10 });
+ });
+ 
+ test('computeRollWindow defaults windowSize to US_CONGRESS_ROLL_WINDOW', () => {
+   assert.deepEqual(computeRollWindow(0), { lo: 1, hi: US_CONGRESS_ROLL_WINDOW });
+ });
+ 
+-// ---- parseChildOutput / runWroteSomething ----
++// ---- I4a (fix round 1) red-first: isExpectedTailProbeOutcome ----
++
++test('isExpectedTailProbeOutcome: true when every failure is a roll/vote strictly past the window edge', () => {
++  assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 291' }, { step: 'roll 292' }], 283), true);
++  assert.equal(isExpectedTailProbeOutcome('us-senate', [{ step: 'vote 661' }], 660), true);
++});
++
++test('isExpectedTailProbeOutcome: false when a failure is NOT a roll/vote step (e.g. a bill-detail failure) — a real regression, not overshoot', () => {
++  assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 291' }, { step: 'bill HR 1' }], 283), false);
++});
++
++test('isExpectedTailProbeOutcome: false when a roll/vote failure is AT OR BELOW the previously-known edge', () => {
++  assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 283' }], 283), false);
++  assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 200' }], 283), false);
++});
++
++test('isExpectedTailProbeOutcome: false for a non-windowed source, or when there are no failures to explain away', () => {
++  assert.equal(isExpectedTailProbeOutcome('mo-senate-web', [{ step: 'roll 291' }], 283), false);
++  assert.equal(isExpectedTailProbeOutcome('us-congress', [], 283), false);
++  assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 291' }], undefined), false);
++});
++
++// ---- I4b (fix round 1) red-first: countsShowRowsWritten replaces the old mode/status heuristic ----
++
++test('countsShowRowsWritten: mo-senate-web/us-congress/us-senate/legiscan all read detail.counts.votes', () => {
++  assert.equal(countsShowRowsWritten('us-congress', { counts: { votes: 3 } }), true);
++  assert.equal(countsShowRowsWritten('us-congress', { counts: { votes: 0 } }), false);
++  assert.equal(countsShowRowsWritten('mo-senate-web', { counts: { votes: 1 } }), true);
++  assert.equal(countsShowRowsWritten('us-senate', { counts: { votes: 2 } }), true);
++  assert.equal(countsShowRowsWritten('legiscan', { counts: { votes: 5 } }), true);
++});
++
++test('countsShowRowsWritten: THE I4b REGRESSION CASE — a live/partial run whose probe window found nothing must read as "wrote nothing", not "wrote something"', () => {
++  // This is exactly the shape a us-congress tick has on a typical hour: mode 'live', status
++  // 'partial' (every probed roll 404d), counts.votes still 0. The OLD heuristic
++  // (mode==='live' && status in succeeded/partial) returned true here — this must return false.
++  assert.equal(countsShowRowsWritten('us-congress', { counts: { votes: 0, casts: 0, failures: 10 } }), false);
++});
++
++test('countsShowRowsWritten: mo-house-xml rollcall-pdf branch reads rollCallResult.castCount, a SIBLING of counts, not a field inside it', () => {
++  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'rollcall-pdf' }, rollCallResult: { castCount: 5 } }), true);
++  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'rollcall-pdf' }, rollCallResult: { castCount: 0 } }), false);
++  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'rollcall-pdf' } }), false, 'missing rollCallResult must not throw or default to true');
++});
++
++test('countsShowRowsWritten: mo-house-xml bill-xml branch reads counts.bills_detailed', () => {
++  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'bill-xml', bills_detailed: 2 } }), true);
++  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'bill-xml', bills_detailed: 0 } }), false);
++});
++
++test('countsShowRowsWritten: a missing/empty detail never throws, reads as false', () => {
++  assert.equal(countsShowRowsWritten('us-congress', {}), false);
++  assert.equal(countsShowRowsWritten('us-congress', null), false);
++  assert.equal(countsShowRowsWritten('mo-house-xml', {}), false);
++});
++
++// ---- parseChildOutput ----
+ 
+ test('parseChildOutput parses a CLI\'s pretty-printed JSON.stringify(..., null, 2) stdout', () => {
+   const stdout = JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 3 } }, null, 2);
+   const { parsed, parseError } = parseChildOutput(stdout);
+   assert.equal(parseError, null);
+   assert.equal(parsed.mode, 'live');
+   assert.equal(parsed.counts.votes, 3);
+ });
+ 
+ test('parseChildOutput reports a parse error instead of throwing on unparseable stdout', () => {
+   const { parsed, parseError } = parseChildOutput('not json at all');
+   assert.equal(parsed, null);
+   assert.ok(parseError);
+ });
+ 
+-test('runWroteSomething: true only for a live run reporting succeeded/partial', () => {
+-  assert.equal(runWroteSomething({ mode: 'live', status: 'succeeded' }), true);
+-  assert.equal(runWroteSomething({ mode: 'live', status: 'partial' }), true);
+-});
+-
+-test('runWroteSomething: false for blocked/dry-run modes, and for a null/unparsed result', () => {
+-  assert.equal(runWroteSomething({ mode: 'blocked', status: 'succeeded' }), false);
+-  assert.equal(runWroteSomething({ mode: 'dry-run' }), false);
+-  assert.equal(runWroteSomething(null), false);
+-  assert.equal(runWroteSomething(undefined), false);
+-});
+-
+-test('runWroteSomething: false for a live run whose status is neither succeeded nor partial', () => {
+-  assert.equal(runWroteSomething({ mode: 'live', status: 'failed' }), false);
+-});
+-
+ // ---- DB-facing helpers: fakeClient (same shape as summarize-cli.test.js's own fakeClient) ----
+ 
+ function fakeQuery(result) {
+   const builder = {
+     select: () => builder,
+     eq: () => builder,
+     like: () => builder,
+     order: () => builder,
+     limit: () => builder,
+     range: () => builder,
+@@ -265,185 +459,732 @@ test('queryLatestStartedAt returns the latest started_at for the given source, n
+ 
+   const emptyClient = fakeClient({ ingestion_runs: { data: null, error: null } });
+   assert.equal(await queryLatestStartedAt(emptyClient, 'mo-senate-web'), null);
+ });
+ 
+ test('queryLatestStartedAt throws a plain descriptive Error on a real lookup failure (never silently swallowed)', async () => {
+   const client = fakeClient({ ingestion_runs: { data: null, error: { message: 'boom' } } });
+   await assert.rejects(() => queryLatestStartedAt(client, 'legiscan'), /ingestion_runs lookup failed.*legiscan.*boom/s);
+ });
+ 
++test('queryLatestRun returns the full row (started_at, status, detail), null when none exists', async () => {
++  const row = { started_at: '2026-07-31T10:00:00.000Z', status: 'succeeded', detail: { counts: { votes: 2 } } };
++  const client = fakeClient({ ingestion_runs: { data: row, error: null } });
++  assert.deepEqual(await queryLatestRun(client, 'us-congress'), row);
++
++  const emptyClient = fakeClient({ ingestion_runs: { data: null, error: null } });
++  assert.equal(await queryLatestRun(emptyClient, 'us-congress'), null);
++});
++
++test('queryLatestRun throws a plain descriptive Error on a real lookup failure', async () => {
++  const client = fakeClient({ ingestion_runs: { data: null, error: { message: 'boom' } } });
++  await assert.rejects(() => queryLatestRun(client, 'us-congress'), /ingestion_runs lookup failed.*us-congress.*boom/s);
++});
++
+ test('resolveLegiscanSessionId returns the current MO session\'s legiscan_session_id when on file', async () => {
+   const client = fakeClient({ sessions: { data: { legiscan_session_id: 2239 }, error: null } });
+   assert.equal(await resolveLegiscanSessionId(client), 2239);
+ });
+ 
+ test('resolveLegiscanSessionId returns null (never guesses) when the session row or its legiscan_session_id is missing', async () => {
+   const missingRow = fakeClient({ sessions: { data: null, error: null } });
+   assert.equal(await resolveLegiscanSessionId(missingRow), null);
+ 
+   const nullColumn = fakeClient({ sessions: { data: { legiscan_session_id: null }, error: null } });
+   assert.equal(await resolveLegiscanSessionId(nullColumn), null);
+ });
+ 
+-test('resolveUsCongressRollWindow computes the window from the max roll number found in votes.source_key', async () => {
++test('resolveUsCongressRollWindow computes {lo,hi,maxKnown} from the max roll number found in votes.source_key', async () => {
+   const client = fakeClient({
+     votes: {
+       data: [
+         { source_key: 'us-house-119-2026-40' },
+         { source_key: 'us-house-119-2026-355' },
+         { source_key: 'us-house-119-2026-12' },
+       ],
+       error: null,
+     },
+   });
+   const window = await resolveUsCongressRollWindow(client, { congress: 119, year: 2026, windowSize: 10 });
+-  assert.deepEqual(window, { lo: 356, hi: 365 });
++  assert.deepEqual(window, { lo: 356, hi: 365, maxKnown: 355 });
+ });
+ 
+ test('resolveUsCongressRollWindow starts at roll 1 when nothing is on file yet for this congress/year', async () => {
+   const client = fakeClient({ votes: { data: [], error: null } });
+   const window = await resolveUsCongressRollWindow(client, { congress: 119, year: 2026, windowSize: 10 });
+-  assert.deepEqual(window, { lo: 1, hi: 10 });
++  assert.deepEqual(window, { lo: 1, hi: 10, maxKnown: 0 });
+ });
+ 
+-// ---- buildRegistry: the full four-source registry, with the TODO-31 mo-house-xml restriction and
+-// the legiscan fail-safe both structurally verified, not just documented ----
++test('resolveUsSenateVoteWindow (I5) computes {lo,hi,maxKnown} from the max vote number found in votes.source_key, ignoring House keys', async () => {
++  const client = fakeClient({
++    votes: {
++      data: [
++        { source_key: 'us-senate-119-2-655' },
++        { source_key: 'us-senate-119-2-661' },
++        { source_key: 'us-house-119-2026-999' }, // must be ignored — different chamber/prefix
++      ],
++      error: null,
++    },
++  });
++  const window = await resolveUsSenateVoteWindow(client, { congress: 119, session: 2, windowSize: 10 });
++  assert.deepEqual(window, { lo: 662, hi: 671, maxKnown: 661 });
++});
++
++test('resolveUsSenateVoteWindow defaults to US_CONGRESS_CONGRESS/US_SENATE_SESSION/US_SENATE_VOTE_WINDOW', async () => {
++  const client = fakeClient({ votes: { data: [], error: null } });
++  const window = await resolveUsSenateVoteWindow(client, {});
++  assert.deepEqual(window, { lo: 1, hi: US_SENATE_VOTE_WINDOW, maxKnown: 0 });
++});
+ 
+-function fakeRegistryClient({ legiscanSessionId = 2239, votesRows = [], lastStartedAtBySource = {} } = {}) {
++// ---- buildRegistry: the full five-source registry ----
++
++function fakeRegistryClient({
++  legiscanSessionId = 2239, houseVotesRows = [], senateVotesRows = [],
++  lastStartedAtBySource = {}, sessionsError = null, onCall = null,
++} = {}) {
+   return {
+     from(table) {
+       if (table === 'ingestion_runs') {
+-        // Own closure variable per .from('ingestion_runs') call (queryLatestStartedAt makes one
+-        // fresh call per source) — NOT `this` inside arrow functions, which would capture the
+-        // outer fakeRegistryClient object instead of this inner chainable builder.
+         let sourceFilter = null;
+         const builder = {
+           select: () => builder,
+           eq: (col, val) => { sourceFilter = val; return builder; },
+           order: () => builder,
+           limit: () => builder,
+           maybeSingle: () => builder,
+           then: (resolve, reject) => {
++            if (onCall) onCall(`ingestion_runs:${sourceFilter}`);
+             const started = lastStartedAtBySource[sourceFilter] ?? null;
+             return Promise.resolve({ data: started ? { started_at: started } : null, error: null }).then(resolve, reject);
+           },
+         };
+         return builder;
+       }
+       if (table === 'sessions') {
+-        return fakeQuery({
+-          data: legiscanSessionId != null ? { legiscan_session_id: legiscanSessionId } : null,
+-          error: null,
+-        });
++        if (onCall) onCall('sessions');
++        return fakeQuery(sessionsError
++          ? { data: null, error: sessionsError }
++          : { data: legiscanSessionId != null ? { legiscan_session_id: legiscanSessionId } : null, error: null });
+       }
+       if (table === 'votes') {
+-        return fakeQuery({ data: votesRows, error: null });
++        if (onCall) onCall('votes');
++        // Real filtering isn't implemented by this fake — both resolveUsCongressRollWindow and
++        // resolveUsSenateVoteWindow query 'votes' and each filters via its OWN regex
++        // (parseUsHouseRoll / parseUsSenateVote), which naturally ignores the other chamber's
++        // keys — so returning the UNION of both rows to either caller is safe.
++        return fakeQuery({ data: [...houseVotesRows, ...senateVotesRows], error: null });
+       }
+       return fakeQuery({ data: null, error: null });
+     },
+   };
+ }
+ 
+-test('buildRegistry: all four sources, correct scripts + static args, legiscan resolved', async () => {
++test('buildRegistry: all five sources, correct scripts + static args, legiscan resolved', async () => {
+   const client = fakeRegistryClient({ legiscanSessionId: 2239 });
+   const registry = await buildRegistry(client, { now: Date.parse('2026-07-31T12:00:00.000Z'), year: 2026 });
+ 
+-  assert.equal(registry.length, 4);
++  assert.equal(registry.length, 5);
+   const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));
+ 
+   assert.equal(byKey['mo-senate-web'].minIntervalMs, MO_SENATE_MIN_INTERVAL_MS);
+   assert.equal(byKey['mo-senate-web'].scriptPath, 'src/cli/ingest-mo-senate.js');
+   assert.deepEqual(byKey['mo-senate-web'].cliArgs, ['--year', '2026', '--limit', '1']);
+   assert.equal(byKey['mo-senate-web'].resolvable, true);
+ 
+   assert.equal(byKey['mo-house-xml'].minIntervalMs, MO_HOUSE_MIN_INTERVAL_MS);
+   assert.equal(byKey['mo-house-xml'].scriptPath, 'src/cli/ingest-mo-house.js');
+   assert.deepEqual(byKey['mo-house-xml'].cliArgs, ['--limit', '1']);
+ 
+   assert.equal(byKey['us-congress'].scriptPath, 'src/cli/ingest.js');
+   assert.deepEqual(byKey['us-congress'].cliArgs, ['--source', 'us-congress', '--year', '2026', '--rolls', '1-10']);
++  assert.equal(byKey['us-congress'].windowMaxKnown, 0);
++
++  assert.equal(byKey['us-senate'].scriptPath, 'src/cli/ingest.js');
++  assert.deepEqual(byKey['us-senate'].cliArgs, ['--source', 'us-senate', '--session', String(US_SENATE_SESSION), '--votes', `1-${US_SENATE_VOTE_WINDOW}`]);
++  assert.equal(byKey['us-senate'].windowMaxKnown, 0);
+ 
+   assert.equal(byKey.legiscan.scriptPath, 'src/cli/ingest-legiscan.js');
+   assert.deepEqual(byKey.legiscan.cliArgs, ['--session', '2239']);
+   assert.equal(byKey.legiscan.resolvable, true);
+ });
+ 
++test('ROUND 2: buildRegistry gives every source EXCEPT legiscan the default CHILD_TIMEOUT_MS, and legiscan its own much larger LEGISCAN_CHILD_TIMEOUT_MS', async () => {
++  const client = fakeRegistryClient({ legiscanSessionId: 2239 });
++  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
++  const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));
++
++  assert.equal(byKey['mo-senate-web'].timeoutMs, CHILD_TIMEOUT_MS);
++  assert.equal(byKey['mo-house-xml'].timeoutMs, CHILD_TIMEOUT_MS);
++  assert.equal(byKey['us-congress'].timeoutMs, CHILD_TIMEOUT_MS);
++  assert.equal(byKey['us-senate'].timeoutMs, CHILD_TIMEOUT_MS);
++  assert.equal(byKey.legiscan.timeoutMs, LEGISCAN_CHILD_TIMEOUT_MS);
++  assert.ok(byKey.legiscan.timeoutMs > byKey['mo-senate-web'].timeoutMs, 'legiscan\'s timeout must be strictly larger than the default family');
++});
++
+ test('buildRegistry: TODO-31 restriction — mo-house-xml args NEVER include --session, regardless of anything else', async () => {
+   const client = fakeRegistryClient({});
+   const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
+   const house = registry.find((e) => e.key === 'mo-house-xml');
+   assert.ok(!house.cliArgs.includes('--session'), 'mo-house-xml must never receive a --session flag from the scheduler');
+ });
+ 
+ test('buildRegistry: legiscan with no legiscan_session_id on file is marked unresolvable and gets an honest reason, never a guessed session', async () => {
+   const client = fakeRegistryClient({ legiscanSessionId: null });
+   const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
+   const legiscan = registry.find((e) => e.key === 'legiscan');
+   assert.equal(legiscan.resolvable, false);
+   assert.ok(legiscan.unresolvedReason, 'must explain WHY it is skipped');
++  assert.match(legiscan.unresolvedReason, new RegExp(DEFAULT_MO_HOUSE_SESSION), 'names the actual session identifier it looked up, not a vague message');
+   assert.deepEqual(legiscan.cliArgs, []);
+ });
+ 
+ test('buildRegistry: every source\'s lastStartedAtIso reflects ingestion_runs, per source', async () => {
+   const client = fakeRegistryClient({
+     lastStartedAtBySource: {
+       'mo-senate-web': '2026-07-31T11:00:00.000Z',
+       'mo-house-xml': '2026-07-31T11:29:00.000Z',
+     },
+   });
+   const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
+   const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));
+   assert.equal(byKey['mo-senate-web'].lastStartedAtIso, '2026-07-31T11:00:00.000Z');
+   assert.equal(byKey['mo-house-xml'].lastStartedAtIso, '2026-07-31T11:29:00.000Z');
+   assert.equal(byKey['us-congress'].lastStartedAtIso, null);
+ });
+ 
++// ---- I3 (fix round 1) red-first: one rejected lookup must not abort the whole tick ----
++
++test('I3: buildRegistry survives a rejected lookup (legiscan session resolution throws) — never rejects, the other sources still resolve normally', async () => {
++  const client = fakeRegistryClient({ sessionsError: { message: 'connection reset by peer' } });
++  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 }); // must NOT throw
++  const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));
++
++  assert.equal(byKey['mo-senate-web'].resolvable, true);
++  assert.equal(byKey['mo-house-xml'].resolvable, true);
++  assert.equal(byKey['us-congress'].resolvable, true);
++  assert.equal(byKey['us-senate'].resolvable, true);
++
++  assert.equal(byKey.legiscan.resolvable, false);
++  assert.match(byKey.legiscan.unresolvedReason, /skipped this tick:.*connection reset/);
++});
++
++test('I3: after a rejected lookup, the tick can still PICK among the sources that resolved fine', async () => {
++  const client = fakeRegistryClient({
++    sessionsError: { message: 'connection reset by peer' },
++    lastStartedAtBySource: { 'mo-senate-web': '2020-01-01T00:00:00.000Z' }, // long overdue
++  });
++  const now = Date.now();
++  const registry = await buildRegistry(client, { now, year: 2026 });
++  const withDueness = registry.map((e) => computeSourceDueness(e, now));
++  const chosen = pickMostOverdue(withDueness);
++  assert.ok(chosen, 'a tick must still be able to choose a source even when legiscan\'s lookup failed');
++  assert.notEqual(chosen.key, 'legiscan', 'the failed lookup must never be chosen');
++});
++
++// ---- M3 (fix round 1): --only skips lookups that are not needed this tick ----
++
++test('M3: buildRegistry with --only mo-senate-web fires ONLY that source\'s own ingestion_runs lookup — not the other four sources\' lookups, not sessions, not votes', async () => {
++  const calls = [];
++  const client = fakeRegistryClient({ onCall: (c) => calls.push(c) });
++  await buildRegistry(client, { now: Date.now(), year: 2026, only: 'mo-senate-web' });
++  assert.deepEqual(calls, ['ingestion_runs:mo-senate-web']);
++});
++
++test('M3: buildRegistry with --only us-congress fires that source\'s ingestion_runs lookup AND its roll-window votes lookup, nothing else', async () => {
++  const calls = [];
++  const client = fakeRegistryClient({ onCall: (c) => calls.push(c) });
++  await buildRegistry(client, { now: Date.now(), year: 2026, only: 'us-congress' });
++  assert.deepEqual(calls.sort(), ['ingestion_runs:us-congress', 'votes'].sort());
++});
++
++test('M3: buildRegistry with --only legiscan fires that source\'s ingestion_runs lookup AND the sessions lookup, nothing else', async () => {
++  const calls = [];
++  const client = fakeRegistryClient({ onCall: (c) => calls.push(c) });
++  await buildRegistry(client, { now: Date.now(), year: 2026, only: 'legiscan' });
++  assert.deepEqual(calls.sort(), ['ingestion_runs:legiscan', 'sessions'].sort());
++});
++
++test('M3: buildRegistry with no --only still fires every lookup (nothing is scoped away for a full tick)', async () => {
++  const calls = [];
++  const client = fakeRegistryClient({ onCall: (c) => calls.push(c) });
++  await buildRegistry(client, { now: Date.now(), year: 2026 });
++  assert.equal(calls.filter((c) => c.startsWith('ingestion_runs:')).length, 5);
++  assert.equal(calls.filter((c) => c === 'sessions').length, 1);
++  assert.equal(calls.filter((c) => c === 'votes').length, 2); // us-congress roll window + us-senate vote window
++});
++
+ // ---- runChildCli: process orchestration, spawnFn injectable so no real subprocess in most tests ----
+ 
+ test('runChildCli: parses a faked child\'s stdout and passes through its exit status', () => {
+   const calls = [];
+   const spawnFn = (command, args, options) => {
+     calls.push({ command, args, options });
+     return { status: 0, stdout: JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 1 } }), stderr: '' };
+   };
+   const result = runChildCli('src/cli/ingest-mo-senate.js', ['--year', '2026', '--limit', '1'], { cwd: '/repo', spawnFn });
+   assert.equal(result.exitStatus, 0);
+   assert.equal(result.parsed.status, 'succeeded');
+   assert.equal(calls.length, 1);
+   assert.equal(calls[0].command, process.execPath);
+   assert.deepEqual(calls[0].args, ['--env-file=.env', 'src/cli/ingest-mo-senate.js', '--year', '2026', '--limit', '1']);
+   assert.equal(calls[0].options.cwd, '/repo');
++  assert.equal(calls[0].options.timeout, CHILD_TIMEOUT_MS, 'defaults to CHILD_TIMEOUT_MS when no per-source timeoutMs is given');
++  assert.equal(calls[0].options.maxBuffer, CHILD_MAX_BUFFER);
++});
++
++test('ROUND 2: runChildCli honors a per-call timeoutMs (this is what lets legiscan get its own 75-min budget)', () => {
++  const calls = [];
++  const spawnFn = (command, args, options) => {
++    calls.push({ command, args, options });
++    return { status: 0, stdout: JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 1 } }), stderr: '' };
++  };
++  runChildCli('src/cli/ingest-legiscan.js', ['--session', '2239'], { cwd: '/repo', spawnFn, timeoutMs: LEGISCAN_CHILD_TIMEOUT_MS });
++  assert.equal(calls[0].options.timeout, LEGISCAN_CHILD_TIMEOUT_MS);
+ });
+ 
+ test('runChildCli: a non-zero exit (typed CLI failures) is reported, never thrown — "never crashes the scheduler run"', () => {
+   const spawnFn = () => ({ status: 2, stdout: JSON.stringify({ mode: 'live', status: 'partial', counts: {}, failures: [{ message: 'x' }] }), stderr: '' });
+   const result = runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn });
+   assert.equal(result.exitStatus, 2);
+   assert.equal(result.parsed.status, 'partial');
+ });
+ 
+-test('runChildCli: a genuine launch failure (spawnFn returns .error) throws — this IS a real scheduler-level error', () => {
++test('runChildCli: a genuine launch failure (spawnFn returns .error with no known code) throws "could not launch"', () => {
+   const spawnFn = () => ({ error: new Error('ENOENT'), status: null, stdout: '', stderr: '' });
+   assert.throws(() => runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn }), /could not launch/);
+ });
+ 
++// ---- I2/M2 (fix round 1): timeout and buffer-overflow are reported distinctly, never as "could not launch" ----
++
++test('I2: a spawnSync timeout (ETIMEDOUT) is reported distinctly — never confused with a bad path', () => {
++  const spawnFn = () => ({
++    error: Object.assign(new Error('spawnSync src/cli/ingest.js ETIMEDOUT'), { code: 'ETIMEDOUT' }),
++    status: null, stdout: '', stderr: '', signal: 'SIGTERM',
++  });
++  assert.throws(() => runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn }), /exceeded its .*timeout/);
++});
++
++test('ROUND 2: the thrown ETIMEDOUT error carries .code and .timeoutMs -- this is what runChosenSource uses to know a forceful kill happened', () => {
++  const spawnFn2 = () => ({
++    error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
++    status: null, stdout: '', stderr: '',
++  });
++  try {
++    runChildCli('src/cli/ingest-legiscan.js', [], { cwd: '/repo', spawnFn: spawnFn2, timeoutMs: LEGISCAN_CHILD_TIMEOUT_MS });
++    assert.fail('expected a throw');
++  } catch (err) {
++    assert.equal(err.code, 'ETIMEDOUT');
++    assert.equal(err.timeoutMs, LEGISCAN_CHILD_TIMEOUT_MS);
++  }
++});
++
++test('M2: a maxBuffer overflow (ENOBUFS) is reported distinctly — never confused with a bad path', () => {
++  const spawnFn = () => ({
++    error: Object.assign(new Error('spawnSync src/cli/ingest.js ENOBUFS'), { code: 'ENOBUFS' }),
++    status: null, stdout: '', stderr: '',
++  });
++  assert.throws(() => runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn }), /output buffer.*ENOBUFS/);
++});
++
++test('I2/M2: CHILD_TIMEOUT_MS is strictly less than both MAX_RUN_DURATION_MS and the 15-min recommended tick; CHILD_MAX_BUFFER is raised above Node\'s 1MB default', () => {
++  assert.ok(CHILD_TIMEOUT_MS < MAX_RUN_DURATION_MS, 'child timeout must be strictly less than the stale-reclaim window');
++  assert.ok(CHILD_TIMEOUT_MS < 15 * 60 * 1000, 'child timeout must be strictly less than the recommended 15-min tick');
++  assert.ok(CHILD_MAX_BUFFER > 1024 * 1024, 'maxBuffer must be raised above Node\'s 1MB default');
++});
++
+ // Real subprocess smoke test (no network, no DB) — proves the actual `node --env-file=.env <path>
+ // <args>` spawn plumbing runChildCli builds works end to end, not just the fake spawnFn used
+ // everywhere else above. Runs from its own temp dir with a throwaway .env — real .env is
+ // gitignored (never present on a fresh checkout), so this must not depend on the repo's own copy.
+ test('runChildCli: real subprocess smoke test (no network, no DB) — proves the actual spawn plumbing works, not just the fake', () => {
+   withTmpDir((dir) => {
+     writeFileSync(path.join(dir, '.env'), 'SCHEDULED_INGEST_SMOKE_TEST=1\n');
+     const scriptPath = path.join(dir, 'fake-cli.js');
+     writeFileSync(scriptPath, "console.log(JSON.stringify({mode:'live',status:'succeeded',counts:{x:1}}));\n");
+ 
+     const result = runChildCli(
+       'fake-cli.js',
+       [],
+       { cwd: dir, spawnFn: (command, args, options) => spawnSync(command, args, { encoding: 'utf8', ...options }) },
+     );
+     assert.equal(result.exitStatus, 0);
+     assert.equal(result.parsed.mode, 'live');
+     assert.equal(result.parsed.counts.x, 1);
+   });
+ });
++
++// ---- C1 (fix round 1) red-first: a source whose CLI fails before openRun must not be able to
++// monopolize the picker forever ----
++
++// A minimal, STATEFUL fake for 'ingestion_runs' covering the real shapes openRun/closeRun/
++// queryLatestRun/closeOrphanedRunningRows (via selectAll) actually use — realistic enough to
++// prove recordSchedulerAttemptFailure and closeOrphanedRunningRows really do advance/correct the
++// durable signal queryLatestRun/queryLatestStartedAt both read from.
++//
++// Single source of truth: `byId`. "Latest" is ALWAYS computed fresh (max by started_at) from
++// whatever is currently in `byId` — never a separately-tracked shadow variable. An earlier
++// version of this fake tracked `latestRow` as its own mutable variable, updated only by the
++// insert()/update() code paths; a row added via `_seed` (bypassing insert()) never touched that
++// variable, so a test seeding an orphaned row and then closing it via closeOrphanedRunningRows
++// would have queryLatestRun still returning the STALE pre-seed value — a real bug this fake
++// caught in itself during round 2. Computing it fresh every time closes that class of bug
++// entirely, matching how a real `ORDER BY started_at DESC LIMIT 1` query behaves regardless of
++// which code path wrote a row.
++//
++// Two DIFFERENT terminal shapes share the same .select() entry point: queryLatestRun ends in
++// .maybeSingle() (the freshest-by-started_at row across everything seeded/inserted — round-1
++// tests only ever exercise one source per test, so this has never needed to also filter by the
++// chained .eq('source', ...)); closeOrphanedRunningRows's selectAll call ends in a bare `then`
++// (an array of ALL rows matching every .eq()/.gte() filter actually chained, mirroring real
++// Postgrest AND semantics, and IS source-aware — round 2 addition). `_seed`/`_get` are test-only
++// escape hatches for precise control over a row's started_at (the real insert() path always uses
++// `new Date()`, which real callers never override either — only tests need to simulate "a row
++// from an earlier tick").
++function fakeIngestionRunsClient(initialRow) {
++  const byId = new Map();
++  let nextId = 1;
++  if (initialRow) byId.set('initial', { id: 'initial', ...initialRow });
++
++  function latestRow() {
++    let best = null;
++    for (const r of byId.values()) {
++      if (!best || (r.started_at ?? '') > (best.started_at ?? '')) best = r;
++    }
++    return best;
++  }
++
++  return {
++    _seed(row) {
++      const id = row.id ?? `seed-${nextId}`; nextId += 1;
++      byId.set(id, { id, ...row });
++      return id;
++    },
++    _get(id) {
++      return byId.get(id);
++    },
++    from(table) {
++      if (table !== 'ingestion_runs') throw new Error(`unexpected table ${table}`);
++      return {
++        select: () => {
++          const eqFilters = {};
++          const gteFilters = {};
++          const builder = {
++            eq: (col, val) => { eqFilters[col] = val; return builder; },
++            gte: (col, val) => { gteFilters[col] = val; return builder; },
++            order: () => builder,
++            range: () => builder,
++            limit: () => builder,
++            maybeSingle: () => Promise.resolve({ data: latestRow(), error: null }),
++            then: (resolve, reject) => {
++              const rows = [...byId.values()].filter((r) => {
++                for (const [col, val] of Object.entries(eqFilters)) if (r[col] !== val) return false;
++                for (const [col, val] of Object.entries(gteFilters)) if (!(r[col] >= val)) return false;
++                return true;
++              });
++              return Promise.resolve({ data: rows.map((r) => ({ id: r.id })), error: null }).then(resolve, reject);
++            },
++          };
++          return builder;
++        },
++        insert: (row) => ({
++          select: () => ({
++            single: () => {
++              const id = `run-${nextId}`; nextId += 1;
++              const startedAt = new Date().toISOString();
++              const stored = {
++                id, source: row.source, status: row.status, started_at: startedAt, detail: null,
++              };
++              byId.set(id, stored);
++              return Promise.resolve({ data: { id }, error: null });
++            },
++          }),
++        }),
++        update: (patch) => ({
++          eq: (col, id) => {
++            const stored = byId.get(id);
++            if (stored) {
++              stored.status = patch.status;
++              stored.detail = patch.detail;
++            }
++            return Promise.resolve({ error: null });
++          },
++        }),
++      };
++    },
++  };
++}
++
++test('recordSchedulerAttemptFailure writes an HONEST failed row via the same openRun/closeRun helpers every CLI uses — never a fake success', async () => {
++  const client = fakeIngestionRunsClient(null);
++  const childResult = {
++    exitStatus: 1, stderr: 'x'.repeat(3000) + 'TAIL_MARKER', parseError: 'Unexpected token', stdout: '',
++  };
++  const runId = await recordSchedulerAttemptFailure(client, 'us-congress', childResult, new Error('fetchMemberList failed'));
++  assert.ok(runId);
++
++  const latest = await queryLatestRun(client, 'us-congress');
++  assert.equal(latest.status, 'failed');
++  assert.equal(latest.detail.scheduler_attempt, true);
++  assert.equal(latest.detail.exitCode, 1);
++  assert.equal(latest.detail.launchError, 'fetchMemberList failed');
++  assert.ok(latest.detail.stderrTail.endsWith('TAIL_MARKER'), 'stderr tail must be bounded but keep the most recent content');
++  assert.ok(latest.detail.stderrTail.length <= 2000);
++});
++
++// ---- Round 2, finding 3 RED-FIRST: a forceful kill must close an orphaned 'running' row it
++// stranded — never leave it lying about state, never touch a row from before the tick ----
++
++test('closeOrphanedRunningRows closes running rows for the given source scoped to sinceIso, honestly, and reports their ids', async () => {
++  const client = fakeIngestionRunsClient(null);
++  const staleId = client._seed({
++    source: 'legiscan', status: 'running', started_at: '2026-07-31T11:00:00.000Z', detail: null,
++  }); // BEFORE this tick — must never be touched
++  const orphanId = client._seed({
++    source: 'legiscan', status: 'running', started_at: '2026-07-31T12:05:00.000Z', detail: null,
++  }); // DURING this tick — the one the kill actually stranded
++
++  const closed = await closeOrphanedRunningRows(client, 'legiscan', {
++    sinceIso: '2026-07-31T12:00:00.000Z', timeoutMs: 75 * 60 * 1000, note: 'ETIMEDOUT: boom',
++  });
++
++  assert.deepEqual(closed, [orphanId]);
++  const closedRow = client._get(orphanId);
++  assert.equal(closedRow.status, 'failed');
++  assert.equal(closedRow.detail.scheduler_kill, true);
++  assert.equal(closedRow.detail.timeoutMs, 75 * 60 * 1000);
++  assert.match(closedRow.detail.note, /ETIMEDOUT/);
++
++  // The pre-tick row is untouched — this is the "never touch rows from before the tick" rule.
++  assert.equal(client._get(staleId).status, 'running');
++});
++
++test('closeOrphanedRunningRows only touches the named source — a running row for a DIFFERENT source is left alone', async () => {
++  const client = fakeIngestionRunsClient(null);
++  const otherId = client._seed({
++    source: 'mo-house-xml', status: 'running', started_at: '2026-07-31T12:05:00.000Z', detail: null,
++  });
++  const closed = await closeOrphanedRunningRows(client, 'legiscan', {
++    sinceIso: '2026-07-31T12:00:00.000Z', timeoutMs: 1000, note: 'x',
++  });
++  assert.deepEqual(closed, []);
++  assert.equal(client._get(otherId).status, 'running');
++});
++
++test('closeOrphanedRunningRows is a harmless no-op for a source that never opened a run before being killed (e.g. us-congress, the actual C1 root cause)', async () => {
++  const client = fakeIngestionRunsClient(null);
++  const closed = await closeOrphanedRunningRows(client, 'us-congress', {
++    sinceIso: '2026-07-31T12:00:00.000Z', timeoutMs: 1000, note: 'x',
++  });
++  assert.deepEqual(closed, []);
++});
++
++test('ROUND 2 RED-FIRST (finding 3): a timeout-killed legiscan run (which had already opened its own row) gets that row closed honestly — never stranded at running, never double-recorded by C1', async () => {
++  const tickStartIso = '2026-07-31T12:00:00.000Z';
++  const chosen = {
++    key: 'legiscan',
++    minIntervalMs: 24 * 60 * 60 * 1000,
++    lastStartedAtIso: '2026-07-30T07:00:00.000Z', // yesterday's run — unrelated to this tick
++    resolvable: true,
++    scriptPath: 'src/cli/ingest-legiscan.js',
++    cliArgs: ['--session', '2239'],
++    timeoutMs: 75 * 60 * 1000,
++  };
++  const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
++  // Simulate: legiscan's own openRun already fired (a real row exists, 'running') before the
++  // 75-minute timeout killed it mid-dataset-processing.
++  const orphanId = client._seed({
++    source: 'legiscan', status: 'running', started_at: '2026-07-31T12:03:00.000Z', detail: null,
++  });
++
++  const spawnFn = () => ({
++    error: Object.assign(new Error('spawnSync ingest-legiscan.js ETIMEDOUT'), { code: 'ETIMEDOUT' }),
++    status: null, stdout: '', stderr: 'a lot of progress output before the kill',
++  });
++
++  const result = await runChosenSource(client, chosen, {
++    runChildCliFn: (scriptPath, cliArgs, opts) => runChildCli(scriptPath, cliArgs, { ...opts, spawnFn }),
++    tickStartIso,
++  });
++
++  assert.equal(result.killedByScheduler, true);
++  assert.deepEqual(result.killClosedRunIds, [orphanId]);
++  assert.equal(result.selfRecordedFailure, false, 'the orphaned-row close already accounts for this — C1 must not ALSO write a second failure row');
++  assert.equal(result.outcome.status, 'failed');
++  assert.equal(result.outcome.healthy, false);
++  assert.equal(result.outcome.wroteRows, false);
++  assert.match(result.outcome.note, /scheduler killed this run/);
++
++  const closedRow = client._get(orphanId);
++  assert.equal(closedRow.status, 'failed');
++  assert.equal(closedRow.detail.scheduler_kill, true);
++  assert.equal(closedRow.detail.timeoutMs, 75 * 60 * 1000);
++});
++
++test('ROUND 2: a timeout-killed us-congress run (which never reached its own openRun) still falls through to C1\'s self-record — closeOrphanedRunningRows correctly finds nothing to close', async () => {
++  const tickStartIso = '2026-07-31T12:00:00.000Z';
++  const chosen = {
++    key: 'us-congress',
++    minIntervalMs: 60 * 60 * 1000,
++    lastStartedAtIso: '2026-07-28T04:40:00.000Z',
++    resolvable: true,
++    scriptPath: 'src/cli/ingest.js',
++    cliArgs: ['--source', 'us-congress', '--rolls', '284-293'],
++    timeoutMs: 8 * 60 * 1000,
++    windowMaxKnown: 283,
++  };
++  const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
++  const spawnFn = () => ({
++    error: Object.assign(new Error('spawnSync ingest.js ETIMEDOUT'), { code: 'ETIMEDOUT' }),
++    status: null, stdout: '', stderr: 'stuck fetching member list',
++  });
++
++  const result = await runChosenSource(client, chosen, {
++    runChildCliFn: (scriptPath, cliArgs, opts) => runChildCli(scriptPath, cliArgs, { ...opts, spawnFn }),
++    tickStartIso,
++  });
++
++  assert.equal(result.killedByScheduler, true);
++  assert.deepEqual(result.killClosedRunIds, [], 'nothing to close — this source never opened a row before the kill');
++  assert.equal(result.selfRecordedFailure, true, 'C1\'s existing self-record mechanism must still catch this case');
++  assert.equal(result.outcome.status, 'failed');
++  assert.equal(result.outcome.healthy, false);
++});
++
++test('C1 RED-FIRST: when the child fails and writes NO new ingestion_runs row, runChosenSource self-records an honest failed attempt — and the source is no longer most-overdue on the next computation', async () => {
++  const oldStartedAt = '2026-07-28T04:40:00.000Z'; // matches the live incident's real timestamp
++  const chosen = {
++    key: 'us-congress',
++    minIntervalMs: 60 * 60 * 1000,
++    lastStartedAtIso: oldStartedAt,
++    resolvable: true,
++    scriptPath: 'src/cli/ingest.js',
++    cliArgs: ['--source', 'us-congress', '--year', '2026', '--rolls', '284-293'],
++    windowMaxKnown: 283,
++  };
++
++  // The fake starts already seeded with the OLD row (matching chosen.lastStartedAtIso) — the
++  // child "fails before openRun" (ingest.js's fetchMemberList throws), so nothing INSERTs a new
++  // row on its own; only recordSchedulerAttemptFailure (invoked internally by runChosenSource)
++  // will change what queryLatestRun sees next.
++  const client = fakeIngestionRunsClient({ started_at: oldStartedAt, status: 'succeeded', detail: {} });
++
++  // Simulates a hard crash: congress.gov down, ingest.js throws before ever printing JSON —
++  // non-zero exit, empty/non-JSON stdout.
++  const spawnFn = () => ({ status: 1, stdout: '', stderr: 'SourceFetchError: HTTP 503 from us-congress' });
++
++  const result = await runChosenSource(client, chosen, {
++    runChildCliFn: (scriptPath, cliArgs) => runChildCli(scriptPath, cliArgs, { spawnFn }),
++  });
++
++  assert.equal(result.selfRecordedFailure, true, 'must detect that no new row appeared and self-record');
++  assert.equal(result.outcome.status, 'failed');
++  assert.equal(result.outcome.healthy, false);
++  assert.equal(result.outcome.wroteRows, false, 'a self-recorded failure must never trigger the aggregate refresh');
++
++  // The durable signal now reflects the self-recorded attempt, not the frozen 2026-07-28 timestamp.
++  const latest = await queryLatestRun(client, 'us-congress');
++  assert.notEqual(latest.started_at, oldStartedAt);
++  assert.equal(latest.status, 'failed');
++  assert.equal(latest.detail.scheduler_attempt, true);
++
++  // THE ACTUAL PROOF: recomputing due-ness with the NEW lastStartedAtIso, one Task Scheduler tick
++  // later, shows the source is no longer due — it will rotate to another source next time,
++  // instead of being picked again on every 15-minute tick forever.
++  const nextTickNow = Date.now() + 15 * 60 * 1000;
++  const duenessAfter = computeSourceDueness({ ...chosen, lastStartedAtIso: latest.started_at }, nextTickNow);
++  assert.equal(duenessAfter.due, false, 'the source must not be immediately due again after a self-recorded attempt');
++});
++
++test('runChosenSource: a NORMAL successful child (which writes its own row) is NOT self-recorded — the child\'s own row is trusted', async () => {
++  const chosen = {
++    key: 'mo-senate-web',
++    minIntervalMs: 30 * 60 * 1000,
++    lastStartedAtIso: '2026-07-31T11:00:00.000Z',
++    resolvable: true,
++    scriptPath: 'src/cli/ingest-mo-senate.js',
++    cliArgs: ['--year', '2026', '--limit', '1'],
++  };
++  const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
++
++  const spawnFn = () => ({ status: 0, stdout: JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 4, casts: 200 } }), stderr: '' });
++  // Pre-seed what the child "would have written" by inserting directly through the same fake —
++  // runChosenSource only OBSERVES ingestion_runs, it doesn't care who wrote the row.
++  const inserted = await client.from('ingestion_runs').insert({ source: 'mo-senate-web', status: 'running' }).select('id').single();
++  await client.from('ingestion_runs').update({ status: 'succeeded', detail: { counts: { votes: 4, casts: 200 } } }).eq('id', inserted.data.id);
++
++  const result = await runChosenSource(client, chosen, {
++    runChildCliFn: (scriptPath, cliArgs) => runChildCli(scriptPath, cliArgs, { spawnFn }),
++  });
++
++  assert.equal(result.selfRecordedFailure, false);
++  assert.equal(result.outcome.status, 'succeeded');
++  assert.equal(result.outcome.healthy, true);
++  assert.equal(result.outcome.wroteRows, true);
++});
++
++test('runChosenSource: a windowed source whose ONLY failures are expected tail 404s reads as healthy (I4a), and wroteRows reflects the real counts (I4b) independently', async () => {
++  const chosen = {
++    key: 'us-congress',
++    minIntervalMs: 60 * 60 * 1000,
++    lastStartedAtIso: '2026-07-31T10:00:00.000Z',
++    resolvable: true,
++    scriptPath: 'src/cli/ingest.js',
++    cliArgs: ['--source', 'us-congress', '--year', '2026', '--rolls', '284-293'],
++    windowMaxKnown: 283,
++  };
++  const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
++
++  const failures = Array.from({ length: 10 }, (_, i) => ({ step: `roll ${284 + i}`, message: 'HTTP 404' }));
++  const inserted = await client.from('ingestion_runs').insert({ source: 'us-congress', status: 'running' }).select('id').single();
++  await client.from('ingestion_runs').update({
++    status: 'partial', detail: { counts: { votes: 0, casts: 0, failures: 10 }, failures },
++  }).eq('id', inserted.data.id);
++
++  const spawnFn = () => ({
++    status: 2, stdout: JSON.stringify({ mode: 'live', status: 'partial', counts: { votes: 0 }, failures }), stderr: '',
++  });
++  const result = await runChosenSource(client, chosen, {
++    runChildCliFn: (scriptPath, cliArgs) => runChildCli(scriptPath, cliArgs, { spawnFn }),
++  });
++
++  assert.equal(result.selfRecordedFailure, false, 'the child DID write a row — this is not a C1 scenario');
++  assert.equal(result.outcome.status, 'partial');
++  assert.equal(result.outcome.tailProbeOnly, true);
++  assert.equal(result.outcome.healthy, true, 'all-tail-404s must read as healthy, not alarming (I4a)');
++  assert.equal(result.outcome.wroteRows, false, 'zero votes actually landed — must not trigger a refresh (I4b)');
++  assert.match(result.outcome.note, /tail 404/);
++});
++
++// ---- getSchedulerClient (I2): null-if-unconfigured contract, mirrors lib/db.js's getClient() ----
++
++test('getSchedulerClient returns null when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are not set', () => {
++  const savedUrl = process.env.SUPABASE_URL;
++  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
++  delete process.env.SUPABASE_URL;
++  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
++  try {
++    assert.equal(getSchedulerClient(), null);
++  } finally {
++    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl; else delete process.env.SUPABASE_URL;
++    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey; else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
++  }
++});
++
++test('getSchedulerClient returns a truthy client when both env vars are set (construction only — no network call happens)', () => {
++  const savedUrl = process.env.SUPABASE_URL;
++  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
++  process.env.SUPABASE_URL = 'https://example.invalid';
++  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key-for-construction-only';
++  try {
++    assert.ok(getSchedulerClient());
++  } finally {
++    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl; else delete process.env.SUPABASE_URL;
++    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey; else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
++  }
++});
++
++// ---- sanity: hardcoded "current" congress/session constants exist and are the documented values ----
++
++test('US_CONGRESS_CONGRESS/US_SENATE_SESSION match the repo-wide hardcoded-current convention', () => {
++  assert.equal(US_CONGRESS_CONGRESS, 119);
++  assert.equal(US_SENATE_SESSION, 2);
++});
+diff --git a/tests/summarize-cli.test.js b/tests/summarize-cli.test.js
+index 84863b9..78c955f 100644
+--- a/tests/summarize-cli.test.js
++++ b/tests/summarize-cli.test.js
+@@ -1,15 +1,15 @@
+ import { test } from 'node:test';
+ import assert from 'node:assert/strict';
+ import {
+   planWork, wrapTextFormatError, persistReferencedTermsGracefully, createDraftSummary,
+-  checkSummarizeApproval,
++  checkSummarizeApproval, SUMMARIZE_COST_PER_BILL_USD,
+ } from '../src/cli/summarize.js';
+ import { SourceFetchError, RunNotApprovedError } from '../src/lib/errors.js';
+ 
+ const bills = [{ id: 'b1', identifier: 'HR 1' }, { id: 'b2', identifier: 'HR 2' }, { id: 'b3', identifier: 'HR 3' }];
+ const texts = [{ bill_id: 'b2', content_hash: 'h2' }, { bill_id: 'b3', content_hash: 'h3-new' }];
+ const summaries = [{ bill_id: 'b3', bill_text_hash: 'h3-old', status: 'published' }];
+ 
+ test('planWork routes bills correctly', () => {
+   const plan = planWork(bills, texts, summaries);
+   assert.deepEqual(plan.needText.map((b) => b.id), ['b1']);
+@@ -317,19 +317,25 @@ test('batch loop over two bills: a non-missing-relation persist error on bill 2
+ // ---- checkSummarizeApproval: task 1's spend gate — mirrors gloss.js's GLOSS_RUN_APPROVED shape
+ // exactly, wired to SUMMARIZE_RUN_APPROVED. main() calls this before constructing an Anthropic
+ // client or fetching any bill text for sending; see summarize.js's main() for the call site. ----
+ 
+ test('checkSummarizeApproval blocks unless SUMMARIZE_RUN_APPROVED is exactly "yes"', () => {
+   assert.throws(() => checkSummarizeApproval(undefined), RunNotApprovedError);
+   assert.throws(() => checkSummarizeApproval('true'), RunNotApprovedError);
+   assert.doesNotThrow(() => checkSummarizeApproval('yes'));
+ });
+ 
++// M4 (task review fix round 1): summarize.js now prints a cost estimate before the gate, the
++// gloss.js voice — matches golden.js's own $0.11/bill estimate for the SAME summarizeBill call.
++test('SUMMARIZE_COST_PER_BILL_USD matches golden.js\'s own estimate for the same summarizeBill call', () => {
++  assert.equal(SUMMARIZE_COST_PER_BILL_USD, 0.11);
++});
++
+ test('checkSummarizeApproval\'s message names SUMMARIZE_RUN_APPROVED specifically, never another CLI\'s var', () => {
+   try {
+     checkSummarizeApproval('no');
+     assert.fail('expected checkSummarizeApproval to throw');
+   } catch (err) {
+     assert.match(err.message, /set SUMMARIZE_RUN_APPROVED=yes to proceed/);
+     assert.doesNotMatch(err.message, /VERIFY_RUN_APPROVED|GLOSS_RUN_APPROVED|GOLDEN_CHECK_APPROVED/);
+   }
+ });
+diff --git a/tests/verifier.test.js b/tests/verifier.test.js
+index a4763cf..7cbb4f7 100644
+--- a/tests/verifier.test.js
++++ b/tests/verifier.test.js
+@@ -1,19 +1,21 @@
+ import { test } from 'node:test';
+ import assert from 'node:assert/strict';
+ import {
+   VERIFIER_MODEL, VERIFY_PROMPT_VERSION, VERIFY_SCHEMA, VERIFY_SYSTEM_PROMPT,
+   VERIFY_MAX_OUTPUT_TOKENS,
+   buildVerifyMessage, verifyBill, assessVerdicts, VerificationIncompleteError,
+ } from '../src/lib/verifier.js';
+ import { MODEL, MAX_TEXT_CHARS, OversizeTextError, renderMarkdown } from '../src/lib/summarizer.js';
+-import { parseArgs, parseBullets, checkBulletCoverage, checkVerifyApproval } from '../src/cli/verify.js';
++import {
++  parseArgs, parseBullets, checkBulletCoverage, checkVerifyApproval, VERIFY_COST_PER_SUMMARY_USD,
++} from '../src/cli/verify.js';
+ import { RunNotApprovedError } from '../src/lib/errors.js';
+ 
+ // ---- constants (controller ruling #4: sonnet stays sonnet, deliberately not opus) ----
+ 
+ test('VERIFIER_MODEL is claude-sonnet-5, deliberately a different weight class than the opus-5 author', () => {
+   assert.equal(VERIFIER_MODEL, 'claude-sonnet-5');
+   assert.notEqual(VERIFIER_MODEL, MODEL);
+ });
+ 
+ test('VERIFY_PROMPT_VERSION pinned', () => {
+@@ -251,19 +253,25 @@ test('parseArgs rejects unknown flags', () => {
+ // ---- checkVerifyApproval: task 1's spend gate — mirrors gloss.js's GLOSS_RUN_APPROVED shape
+ // exactly, wired to VERIFY_RUN_APPROVED. main() calls this before constructing an Anthropic
+ // client; see verify.js's main() for the call site. ----
+ 
+ test('checkVerifyApproval blocks unless VERIFY_RUN_APPROVED is exactly "yes"', () => {
+   assert.throws(() => checkVerifyApproval(undefined), RunNotApprovedError);
+   assert.throws(() => checkVerifyApproval('true'), RunNotApprovedError);
+   assert.doesNotThrow(() => checkVerifyApproval('yes'));
+ });
+ 
++// M4 (task review fix round 1): verify.js now prints a cost estimate before the gate, the
++// gloss.js voice.
++test('VERIFY_COST_PER_SUMMARY_USD is a stated estimate, same order of magnitude as the other bill-level calls', () => {
++  assert.equal(VERIFY_COST_PER_SUMMARY_USD, 0.11);
++});
++
+ test('checkVerifyApproval\'s message names VERIFY_RUN_APPROVED specifically, never another CLI\'s var', () => {
+   try {
+     checkVerifyApproval('no');
+     assert.fail('expected checkVerifyApproval to throw');
+   } catch (err) {
+     assert.match(err.message, /set VERIFY_RUN_APPROVED=yes to proceed/);
+     assert.doesNotMatch(err.message, /SUMMARIZE_RUN_APPROVED|GLOSS_RUN_APPROVED|GOLDEN_CHECK_APPROVED/);
+   }
+ });
diff --git a/.superpowers/sdd/2026-07-31-scheduling/task-review.md b/.superpowers/sdd/2026-07-31-scheduling/task-review.md
index 9815229..1fb7694 100644
--- a/.superpowers/sdd/2026-07-31-scheduling/task-review.md
+++ b/.superpowers/sdd/2026-07-31-scheduling/task-review.md
@@ -417,10 +417,282 @@ fire on import) and under a real spawn.
 
 ## Required before this is registered with Task Scheduler
 
 1. Fix **C1** — a failing child must not be able to monopolize the picker. This is the one that
    compounds silently for weeks, which is exactly the failure class this review was asked to catch.
 2. Fix **C2** — correct `docs/SCHEDULED_INGESTION.md:151-155` to the neutral-vs-today framing.
 3. Recommended in the same pass, cheap and closes a real hole: **I1** (ownership-checked release)
    + **I2** (`timeout` on `spawnSync`).
 
 Task 1 (`41936f0`) can ship independently and immediately.
+
+
+---
+
+# Re-review (rounds 1+2)
+
+Scope: fix commits `9a4eb66` (round 1: C1, C2, I1-I5, M1-M4) and `a6d94bc` (round 2: per-source
+timeouts, lock-declared duration, orphan-close). Full stack under verdict: `41936f0..a6d94bc`.
+Reviewer: session 8ecd5d8c. Date 2026-07-31.
+
+## Mechanical re-verification
+
+**Test suite** — bare `node --test` from `F:\VisibleGov`, re-run by the reviewer:
+
+```
+ℹ tests 2073
+ℹ suites 0
+ℹ pass 2073
+ℹ fail 0
+ℹ cancelled 0
+ℹ skipped 0
+ℹ todo 0
+ℹ duration_ms 22239.9298
+```
+
+Extracted fail-count line: **`ℹ fail 0`**. Corroborated by `grep -c "^not ok"` = **0**.
+2073 tests, matching the claim (2025 + 32 round-1 + 16 round-2).
+
+**Dry run** — `node --env-file=.env scripts/scheduled-ingest.js --dry-run`: **exit code 0**, zero
+stderr, lock released at rest. Count-header on six tables immediately before and after this
+invocation:
+
+```
+BEFORE {"ingestion_runs":403,"votes":9988,"vote_casts":1465564,"bills":38273,"sessions":33,"legislators":1607}
+AFTER  {"ingestion_runs":403,"votes":9988,"vote_casts":1465564,"bills":38273,"sessions":33,"legislators":1607}
+```
+
+Byte-identical — **zero writes**. (Absolute numbers moved since the first review because Lance's
+existing manual loop is still running; the before/after pair bracketing *this* invocation is what
+is being asserted.) `--dry-run --only us-senate` also exits 0 with zero writes.
+
+**Commits** — `git log` confirms `a6d94bc` on `9a4eb66` on `3e12a1e` on `41936f0` on `de2bf54`.
+Per-commit `--stat` matches the re-review package. Shared-blast-radius ruling honored: `git diff
+3e12a1e..a6d94bc` on `src/lib/http.js`, `src/lib/db.js`, `src/adapters/`, `src/cli/ingest.js`,
+`src/cli/ingest-mo-senate.js` returns **zero changes** — the timeout work stayed inside the
+scheduler via its own `getSchedulerClient` (`scripts/scheduled-ingest.js:873-878`).
+
+## (a) Per-finding verification
+
+| # | Finding | Verdict | Evidence |
+|---|---|---|---|
+| **C1** | Starvation via missing run row | ✅ **FIXED** | `recordSchedulerAttemptFailure` (`:688-699`) writes a real `ingestion_runs` row via the shared `openRun`/`closeRun`, `status='failed'`, `detail.scheduler_attempt=true` — never a fake success. `runChosenSource` (`:757-832`) catches launch/timeout/buffer errors rather than letting them propagate, so the "did a new row appear" check is never skipped. Because `queryLatestStartedAt` has no status filter, the row advances the durable signal and the source falls back to its own interval instead of winning every 15-min tick. |
+| **C2** | Doc claimed scheduler unrelated to TODO-25 | ✅ **FIXED** | `docs/SCHEDULED_INGESTION.md:247-268` is now a warning-headed section: *"⚠️ This scheduler CONTINUES feeding a known, currently-open data defect (TODO item 25) — read before registering"*, *"**The feeder is `mo-senate-web`, which IS in this registry.**"*, cites `ensureSessionRow`'s `identifier: String(year)` mechanism, quotes TODO.md's own "the cron is feeding the duplicate", and closes with *"The honest framing is neutral-vs-today, not 'unrelated.'"* No residual overclaim anywhere in the file. |
+| **I1** | Ownership-blind `releaseLock` | ✅ **FIXED** | `acquireLock` mints a `crypto.randomUUID()` nonce into the lock payload (`:232-235`); `releaseLock` (`:274-284`) re-reads and deletes **only** on nonce match; missing/corrupt/non-matching are all silent no-ops. `main()`'s `finally` threads `lockResult.nonce` (`:1017`). |
+| **I2** | No child/fetch timeout | ✅ **FIXED** | `spawnSync` now gets `timeout: timeoutMs` (`:639-641`), per-source. The scheduler's own Supabase client applies `AbortSignal.timeout(30s)` to every REST call (`:861-878`). Shared `http.js`/`db.js` deliberately untouched, per the ruling — verified zero diff. |
+| **I3** | One lookup rejection killed the tick | ✅ **FIXED** | `safeLookup` (`:501-508`) converts a rejection into `{ok:false, error}`; all eight lookups are wrapped, so the `Promise.all` (`:529-538`) can no longer reject. Each entry's own `resolvable` / `unresolvedReason` now reflects only *its* lookup (`:543-616`), so one source's failure genuinely no longer blocks the others — which is what the doc always claimed. |
+| **I4** | Tail-404 noise + unconditional refresh | ✅ **FIXED (mechanism)** — but see **NEW-1** | I4a: `isExpectedTailProbeOutcome` (`:368-376`) requires *every* failure to match `roll N`/`vote N` strictly past `windowMaxKnown`, so a genuine regression can't be laundered as "expected". I4b: `countsShowRowsWritten` (`:389-397`) reads the child's own run row instead of mode/status. Correct for mo-senate-web, mo-house-xml (**both** branches), us-congress, us-senate — **broken for legiscan** (NEW-1). |
+| **I5** | us-senate unscheduled | ✅ **FIXED** | Registry entry `:586-598` + `resolveUsSenateVoteWindow` `:480-493`. Verified end to end live: `--dry-run --only us-senate` emits `--source us-senate --session 2 --votes 211-220`, which is exactly right (210 rows on file under `us-senate-119-2-*`; 659 under session 1). `US_SENATE_SESSION = 2` is correct for 2026. `collectUsSenate` honors `--votes` (`ingest.js:503-505`), so the run stays bounded to 10. |
+| **M1** | UTC log naming | ✅ **FIXED** | Code comments at `:76-78` and `:847`; doc `:199-205` spells out *"The date in the filename is UTC, not local time — Central time is 5-6 hours behind UTC…"* and tells Lance to check both today's-UTC and tomorrow's-UTC files. |
+| **M2** | 1 MB maxBuffer misreported | ✅ **FIXED** | `CHILD_MAX_BUFFER = 16 MB` (`:121`) passed to `spawnSync` (`:640`); ENOBUFS now throws its own distinct, accurate message (`:657-662`) instead of "could not launch". |
+| **M3** | Lookups ran regardless of `--only` | ✅ **FIXED** | `only` threaded into `buildRegistry` (`:523-524`) and gated per lookup by `safeLookup(need(key), …)` (`:530-537`); a skipped lookup returns `{ok:true, value:null}` and the entry's `cliArgs` correctly collapses to `[]` rather than dereferencing null (`:576-582`). |
+| **M4** | No cost estimate before the gate | ✅ **FIXED** | `summarize.js:298-301` and `verify.js:173-176` print a `Cost estimate: N × ~$0.11 = ~$X` line in gloss.js's voice, before the gate and after the `--dry-run` return — so gate ordering is unchanged. The $0.11 figure is reused from golden.js's existing estimate for the identical `summarizeBill` call rather than invented. |
+
+## (b) Round-2 mechanism — verified at runtime, not by reading
+
+Executed the real exported `isLockStale` against constructed locks (no DB, no network):
+
+```
+legiscan declared lock duration = 4560000 ms = 76 min   (LEGISCAN_CHILD_TIMEOUT_MS 75min + LOCK_GRACE_MS 1min)
+default  declared lock duration =  540000 ms =  9 min   (CHILD_TIMEOUT_MS 8min + LOCK_GRACE_MS 1min)
+
+  legiscan lock @ +15min -> stale=false     legiscan lock @ +75min -> stale=false
+  legiscan lock @ +30min -> stale=false     legiscan lock @ +76min -> stale=false
+  legiscan lock @ +45min -> stale=false     legiscan lock @ +77min -> stale=true
+  legiscan lock @ +60min -> stale=false     legiscan lock @ +90min -> stale=true
+
+  default(9min) lock @ +9min  -> stale=false
+  default(9min) lock @ +10min -> stale=true
+```
+
+**A +15-minute tick cannot reclaim a live legiscan lock.** ✅ Confirmed — and the window still
+closes at +77 min, so a genuinely dead legiscan run cannot wedge the schedule indefinitely. The
+default 9-minute declaration still reclaims promptly at +10 min, so raising legiscan's budget did
+not loosen anything for the other four sources.
+
+**Corrupt/missing `maxDurationMs` falls back to the 10-minute default.** ✅ Confirmed across every
+malformed shape:
+
+```
+  missing field / null / 'abc' / 0 / negative / NaN / Infinity
+      -> @ +9min stale=false, @ +11min stale=true   (i.e. MAX_RUN_DURATION_MS = 10 min)
+  unparseable startedAt -> stale=true always
+```
+
+`Number.isFinite(declared) && declared > 0` (`:208-209`) rejects all of them into
+`fallbackMaxDurationMs`, and a lock file that fails `JSON.parse` outright is synthesized with an
+epoch `startedAt` (`:250-252`) so it is always stale. Fail-safe direction throughout. (One gap:
+NEW-2 below.)
+
+**The orphan-close touches only rows this tick could have created.** ✅ Confirmed.
+`closeOrphanedRunningRows` (`:721-732`) filters on all three of `source = chosen.key`,
+`status = 'running'`, and `started_at >= sinceIso`, where `sinceIso` is `nowIsoAtTickStart` —
+captured once at `:888`, *before* `acquireLock`, and threaded through `runChosenSource`'s
+`tickStartIso`. A `'running'` row from any earlier tick has `started_at < tickStart` and is
+excluded; there is no code path that widens or omits that predicate. It is additionally called only
+when `killedByScheduler` is true (`:782`), i.e. only for ETIMEDOUT/ENOBUFS. Pre-existing history is
+untouchable. (Secondary caveat: NEW-4 below.)
+
+## (c) New defects introduced by the fixes
+
+### 🔴 NEW-1 (Critical) — `countsShowRowsWritten` can never return true for `legiscan`, so the aggregate refresh will never fire after a LegiScan dataset lands
+
+`scripts/scheduled-ingest.js:389-397` — the fallthrough at `:396` is
+`return (counts.votes ?? 0) > 0;`, reading `detail.counts` (`:390`).
+`src/cli/ingest-legiscan.js:1085` closes its run with `buildSuccessCloseDetail(result.counts)`,
+and that helper (`:961-963`) is:
+
+```js
+export function buildSuccessCloseDetail(counts) {
+  return { ...counts, attribution: ATTRIBUTION, queries_used: counts.queriesUsed };
+}
+```
+
+It **spreads `counts` at the top level of `detail`** — there is no `detail.counts` object at all —
+and the counts it spreads are the document/text-pipeline counters, which contain no vote counter.
+Measured against all 52 real legiscan runs in `ingestion_runs`:
+
+```
+legiscan runs total: 52
+UNION of all legiscan detail.counts keys:
+   alreadyHasVersion, alreadyPresent, billsPlanned, budgetRefused, cacheCorrupt, datasetsMissing,
+   datasetsRead, decodeFailed, docCacheHits, extractEmpty, identityMismatch, inserted,
+   missingSourceUrl, nonPdfMime, oversizeRefused, queriesSpent, statusError
+votes-like keys present?: NONE
+distinct counts shapes: (50 runs) (no detail.counts)   (2 runs) <the 17 keys above>
+>>> runs where countsShowRowsWritten('legiscan', detail) === true : 0 / 52
+```
+
+So it is **0 for 52**, and structurally incapable of ever being anything else. Meanwhile LegiScan
+is by a wide margin the largest vote writer in this database — it calls
+`insertIfAbsent(client, 'votes', …)` at `ingest-legiscan.js:604` and
+`insertIfAbsent(client, 'vote_casts', …)` at `:617`, and live:
+
+```
+votes table: 8221 of 9988 rows have a legiscan* source_key (82.3%)
+```
+
+**Consequence:** when the weekly dataset hash changes and a real reprocessing lands thousands of
+new casts, `run.outcome.wroteRows` is `false`, `refresh-aggregates.js` is skipped
+(`scheduled-ingest.js:982`), and `public_position_totals` / `public_party_alignment` silently drift
+behind the vote lists — the exact user-visible chart-drift defect of 2026-07-31 that the brief
+names as the entire reason the standing practice exists. The log will read
+`healthy: true, aggregatesRefreshed: false`, so nothing signals it.
+
+**This is a regression, not a pre-existing gap.** The pre-round-1 `runWroteSomething` returned
+`true` for `{mode:'live', status:'succeeded'}`, so the refresh *did* fire after legiscan runs
+before this fix. I4b's tightening is correct in principle and correct for four of five sources; it
+silently disabled the refresh for the one that matters most.
+
+The comment at `:378-388` states the mapping was *"verified against each one's real closeRun()
+call site, not guessed."* For legiscan that is not accurate — 50 of 52 runs have no
+`detail.counts` at all. Worth correcting alongside the code so the next reader doesn't trust it.
+
+(Note for whoever fixes it: legiscan's counts do carry `inserted`, but that counts documents/texts,
+not votes or casts. There may be no honest votes-written counter in that CLI's detail today —
+picking the right signal is a design call, not a one-token swap.)
+
+### 🟡 NEW-2 (Minor) — no upper clamp on the lock's declared `maxDurationMs`
+
+`scripts/scheduled-ingest.js:205-211`. The guard is `Number.isFinite(declared) && declared > 0`,
+which rejects garbage in the *low* direction but honors any finite positive value. Verified:
+
+```
+  absurdly large (1e12)  @ +9min stale=false  @ +11min stale=false
+```
+
+A lock declaring ~31 years would never be reclaimed, permanently wedging every future tick into
+`already-running` + exit 0 — silent, and indistinguishable from a healthy quiet period in Task
+Scheduler's history. Only reachable by hand-editing the lock (the doc does tell Lance he may delete
+it by hand) or an exotic corruption that still parses as valid JSON. Clamping at, say,
+`LEGISCAN_CHILD_TIMEOUT_MS + LOCK_GRACE_MS` would close it in one line.
+
+### 🟡 NEW-3 (Minor) — `updateLockMaxDuration`'s failure return is ignored
+
+`scripts/scheduled-ingest.js:973` calls it purely for effect. It returns `false` when the lock is
+missing, corrupt, or no longer nonce-matched (`:295-306`). In that case `main()` still spawns the
+child — and for legiscan that means a 75-minute run proceeding under a lock that still declares the
+10-minute selection-phase placeholder, which re-opens precisely the +15-min stale-reclaim stacking
+window round 2 exists to close. Low probability (requires losing the lock between acquire and
+selection) and it fails open rather than dangerously, but the one call site that makes round 2 work
+is also the one whose result is discarded.
+
+### 🟡 NEW-4 (Minor) — the orphan-close scope compares a local clock against DB-assigned timestamps
+
+`scripts/scheduled-ingest.js:888` builds `nowIsoAtTickStart` from `Date.now()` (the local machine
+clock), and it is compared via `.gte('started_at', sinceIso)` (`:723`) against `ingestion_runs.
+started_at`, which is **not** client-supplied: `openRun` (`src/lib/db.js:20-28`) inserts only
+`{source, status}`, so `started_at` comes from the column default `now()`
+(`supabase/migrations/0001_core_schema.sql:117`) — the Supabase server clock.
+
+The child reaches its own `openRun` within a second or two of tick start (legiscan's is at
+`ingest-legiscan.js:1064`, right after the client check), so if the local clock runs even a couple
+of seconds *ahead* of Supabase's, the child's row lands with `started_at < sinceIso` and the
+`gte` filter matches nothing. The scoping requirement is still satisfied — this errs toward closing
+*fewer* rows, never a wrong one — but the fix can silently no-op in exactly the rare, weekly
+scenario it was written for, with no signal (`killClosedRunIds: []` reads the same as "nothing
+needed closing"). A small negative tolerance on `sinceIso`, bounded well below one tick, would make
+it robust without widening the scope meaningfully.
+
+### 🟡 NEW-5 (Minor, observation) — a non-SIGTERM hard crash still strands a `'running'` row
+
+`closeOrphanedRunningRows` runs only when `killedByScheduler` is true, which is gated to
+`ETIMEDOUT`/`ENOBUFS` (`:769, :782`). A child killed by anything else — OOM-killer, segfault, power
+loss mid-run — leaves the same stranded `'running'` row the round-2 fix exists to clean up. This is
+a deliberate, documented scope (`:701-716`) and the *due-ness* signal is unaffected (the row exists,
+so nothing starves); the residue is `public_freshness` honesty only. Noting for completeness, not
+as a defect in the fix.
+
+### Explicitly checked and clean
+
+- **C1 double-recording.** `newRowAppeared` (`:795`) compares `latestRun.started_at !== chosen.
+  lastStartedAtIso`. Both sides come from the same PostgREST client reading the same `timestamptz`
+  column, so the string forms are directly comparable. If the child opened its own row, the
+  timestamp differs and no attempt row is written; if `lastStartedAtIso` was `null` and a row
+  appeared, `latestRun !== null` also short-circuits correctly. The self-record fires only when
+  genuinely no new row exists. No double-recording path found.
+- **C1 honest due-ness advance.** The self-recorded row is `status='failed'`, and
+  `queryLatestStartedAt` intentionally has no status filter, so the next tick sees it and the
+  source backs off to its own `minIntervalMs`. A persistently failing us-congress now runs hourly
+  and never starves the others — verified by reading, and consistent with the live registry state.
+- **I4b right-row selection.** `queryLatestRun` (`:417-427`) filters by source, orders
+  `started_at` desc, `limit(1)` — after the child runs, that is the child's row, and the
+  single-instance lock prevents a concurrent writer for the same source.
+- **I4b correctness for the other four sources**, checked against live `ingestion_runs` detail
+  rather than the code comment: `mo-senate-web` has `detail.counts.votes` ✅;
+  `us-congress` `detail.counts.votes = 5` ✅; `us-senate` `detail.counts.votes = 210` ✅;
+  `mo-house-xml` **both** branches ✅ — the `bill-xml` branch via `counts.bills_detailed`, and all
+  11 real `rollcall-pdf` runs carry `detail.rollCallResult.castCount = 158` and evaluate `true`.
+- **us-senate inherits C1's protection.** `collectUsSenate` fetches the vote menu fatally
+  (`ingest.js:130`) before `openRun` (`:506`) — the same late-open shape as us-congress — and the
+  self-record path is source-agnostic, so it is covered.
+- **No new model reachability.** The import list gained only `node:crypto` and
+  `@supabase/supabase-js`; still no summarizer/verifier/Anthropic anywhere in the graph.
+- **MO ToU intervals** remain non-overridable constants; `process.env` is still read only inside
+  `envIntervalMs`, now for three floored non-ToU intervals.
+- **`dataset_hash`** still appears only in comments — the suspension-level gate is untouched.
+- **`mo-house-xml` cliArgs** is still the frozen literal `['--limit','1']`.
+
+## Verdicts
+
+| | Verdict |
+|---|---|
+| Original findings C1, C2, I1, I2, I3, I4, I5, M1, M2, M3, M4 | ✅ **all 11 addressed in code** (I4's mechanism is sound but incomplete — NEW-1) |
+| Round-2 mechanism (75-min lock vs +15-min tick, corrupt-field fallback, orphan-close scoping) | ✅ **internally sound**, verified at runtime |
+| New defects introduced | ❌ **1 Critical** (NEW-1), 3 Minor, 1 observation |
+| **Ship `41936f0..a6d94bc` as unattended-forever code** | ❌ **DO NOT SHIP** |
+
+**Blocking, and it is the only blocker: NEW-1.** Everything else in this stack is genuinely fixed,
+and the round-2 timeout/lock mechanism is the strongest part of the whole build — it is evidence-
+derived, runtime-verifiable, and fails safe in every malformed case I could construct. But
+registering the scheduler today means the single largest source of votes in this database
+(82.3% of the table) lands its weekly batch and never triggers the aggregate refresh, silently
+recreating the exact user-visible defect the brief cites as the reason for the standing practice.
+That is precisely the compounds-quietly-for-weeks failure class this review exists to catch, and it
+was introduced by the fix round rather than found in the original build.
+
+Not blocking, worth folding into the same pass because they are each a line or two: NEW-2 (clamp
+the declared lock duration), NEW-3 (act on `updateLockMaxDuration`'s `false`), NEW-4 (tolerance on
+the orphan-close `sinceIso`).
+
+**Task 1 (`41936f0` + M4's addition in `9a4eb66`) remains independently shippable and is
+unaffected by all of the above.**
diff --git a/scripts/scheduled-ingest.js b/scripts/scheduled-ingest.js
index d771b18..363e888 100644
--- a/scripts/scheduled-ingest.js
+++ b/scripts/scheduled-ingest.js
@@ -105,20 +105,35 @@ export const CHILD_TIMEOUT_MS = 8 * 60 * 1000; // 8 min
 // makes this safe to raise for just this one source without loosening the default for the rest.
 export const LEGISCAN_CHILD_TIMEOUT_MS = 75 * 60 * 1000; // 75 min — see derivation above
 
 // Round 2 fix: the lock's own declared max duration (see acquireLock/updateLockMaxDuration) is
 // the chosen source's timeoutMs PLUS this grace — cleanup after a timeout-kill (closing an
 // orphaned 'running' row, writing the log) takes at most a few seconds, but a small buffer keeps
 // the stale-reclaim window from being able to fire in the split second between spawnSync's own
 // kill and this process's cleanup finishing.
 export const LOCK_GRACE_MS = 60 * 1000; // 1 min
 
+// Round 3, NEW-2: an upper ceiling on a lock's declared maxDurationMs. Without this, isLockStale's
+// only validation was "finite and positive" — a lock somehow declaring an absurd value (hand-edited,
+// or a future bug) would be honored as-is and never go stale, permanently wedging every future tick
+// into "already-running" + exit 0, indistinguishable in Task Scheduler's history from a healthy
+// quiet period. 2 hours comfortably exceeds LEGISCAN_CHILD_TIMEOUT_MS + LOCK_GRACE_MS (the largest
+// legitimate declared duration today, 76 min) while still being a real, enforced ceiling — a
+// declared duration beyond this is treated exactly like a missing/corrupt one (isLockStale falls
+// back to fallbackMaxDurationMs).
+export const MAX_LOCK_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours
+
+// Round 3, NEW-4: tolerance subtracted from tickStartIso before scoping closeOrphanedRunningRows —
+// see runChosenSource's own comment at the call site for the full safety argument (every registry
+// interval is >=30 min, so this cannot capture pre-existing history).
+export const ORPHAN_CLOSE_SKEW_GRACE_MS = 5 * 60 * 1000; // 5 min
+
 // M2 (fix round 1): Node's spawnSync default maxBuffer (1 MB) is small enough that a chatty child
 // (the ingest CLIs have 2-11 console.error progress lines) could overflow it, which SILENTLY
 // kills the child and reports ENOBUFS as `result.error` — runChildCli used to fold that into the
 // same "could not launch" message as a bad path, which is a misdiagnosis on the one process
 // nobody is watching. 16 MB is generous headroom; overflow is now reported with its own distinct
 // message (see runChildCli).
 export const CHILD_MAX_BUFFER = 16 * 1024 * 1024;
 
 const ONE_HOUR_MS = 60 * 60 * 1000;
 const ONE_DAY_MS = 24 * ONE_HOUR_MS;
@@ -192,28 +207,34 @@ export function parseArgs(argv) {
 
 // ---- pure: single-instance lock (I1 fix round 1: ownership-checked via nonce; round 2: the
 // stale-reclaim window is the LOCK'S OWN declared duration, not one fixed constant) ----
 
 // isLockStale (round 2): a fixed 10-minute stale-reclaim window and a legiscan run that can
 // legitimately need 75 minutes cannot coexist — a tick at +15 min would reclaim a still-live
 // legiscan lock, starting a SECOND concurrent child, exactly the stacking I1 closed. So the lock
 // itself carries `maxDurationMs` (written by acquireLock, updated by updateLockMaxDuration once
 // the chosen source — and therefore its real timeout — is known), and staleness is judged against
 // THAT declared value. `fallbackMaxDurationMs` (still MAX_RUN_DURATION_MS by default) is used
-// only when the lock has no valid `maxDurationMs` of its own — an old-format or corrupt lock file
-// — which is the fail-safe direction: an unrecognized lock is judged by the conservative 10-minute
+// whenever the lock has no VALID `maxDurationMs` of its own — missing, corrupt, non-numeric,
+// non-positive, or (round 3, NEW-2) beyond MAX_LOCK_DURATION_MS — which is the fail-safe
+// direction: an unrecognized OR out-of-range lock is judged by the conservative 10-minute
 // default, never trusted to mean "wait indefinitely."
 export function isLockStale(lock, nowMs, fallbackMaxDurationMs = MAX_RUN_DURATION_MS) {
   const startedMs = Date.parse(lock.startedAt);
   if (!Number.isFinite(startedMs)) return true; // unparseable timestamp — never trusted, treated as stale
   const declared = Number(lock.maxDurationMs);
-  const maxDurationMs = Number.isFinite(declared) && declared > 0 ? declared : fallbackMaxDurationMs;
+  // Round 3, NEW-2: a declared duration beyond MAX_LOCK_DURATION_MS is treated exactly like a
+  // missing/corrupt one — an out-of-range value (hand-edited lock file, a future bug) must never
+  // be honored as "never go stale."
+  const maxDurationMs = Number.isFinite(declared) && declared > 0 && declared <= MAX_LOCK_DURATION_MS
+    ? declared
+    : fallbackMaxDurationMs;
   return nowMs - startedMs > maxDurationMs;
 }
 
 // acquireLock: an atomic create ('wx' — fails with EEXIST if the file already exists) is tried
 // first, closing the check-then-act race a plain existsSync()-then-writeFileSync() pair would
 // leave open between two schedulers starting within milliseconds of each other. Falls back to
 // reading the existing lock only on EEXIST; a corrupt/unreadable lock is treated exactly like a
 // stale one (reclaimed + the caller logs a warning) rather than either trusting it blindly or
 // crashing — a half-written lock from a killed process must not permanently wedge every future
 // tick. Every lock this process writes carries a fresh random `nonce` (crypto.randomUUID) — the
@@ -368,39 +389,104 @@ const TAIL_FAILURE_STEP_RE = {
 export function isExpectedTailProbeOutcome(sourceKey, failures, windowMaxKnown) {
   const re = TAIL_FAILURE_STEP_RE[sourceKey];
   if (!re || windowMaxKnown === undefined || windowMaxKnown === null) return false;
   if (!failures || failures.length === 0) return false;
   return failures.every((f) => {
     const m = re.exec(f?.step ?? '');
     return m !== null && Number(m[1]) > windowMaxKnown;
   });
 }
 
-// countsShowRowsWritten (I4b, fix round 1): reads the run's OWN detail — never inferred from
-// mode/status alone, which was the actual bug (a live/succeeded-or-partial run was treated as
-// "wrote something" even on a tick where every probed roll 404s and literally zero rows landed,
-// so refresh-aggregates.js fired every hour unconditionally). Source-specific because the CLIs'
-// count shapes are genuinely heterogeneous — verified against each one's real closeRun() call
-// site, not guessed:
-//   - mo-senate-web / us-congress / us-senate / legiscan: detail.counts.votes > 0
-//   - mo-house-xml: document_type-dependent — the rollcall-pdf branch writes CASTS
-//     (detail.rollCallResult.castCount, a sibling of counts, not inside it — see
-//     processRollCallPdf's return shape), the bill-xml branch writes BILL rows
-//     (detail.counts.bills_detailed)
-export function countsShowRowsWritten(sourceKey, detail) {
-  const counts = detail?.counts ?? {};
-  if (sourceKey === 'mo-house-xml') {
-    if (counts.document_type === 'rollcall-pdf') return (detail?.rollCallResult?.castCount ?? 0) > 0;
-    if (counts.document_type === 'bill-xml') return (counts.bills_detailed ?? 0) > 0;
-    return false;
+// wroteSomething predicates (round 3, NEW-1 fix): ONE PER REGISTRY SOURCE, each source declaring
+// how to read ITS OWN real close-detail shape — attached to its registry entry below (buildRegistry)
+// and invoked as `chosen.wroteSomething(detail, status)` from runChosenSource. This replaces
+// the single fix-round-1 `countsShowRowsWritten(sourceKey, detail)`, whose fallthrough
+// `detail.counts.votes` was WRONG for legiscan: measured against all 52 real legiscan
+// `ingestion_runs` rows, it evaluated true for ZERO of them, so refresh-aggregates.js never fired
+// after a legiscan run — a real regression (pre-fix-round-1, the refresh always fired) that
+// silently reintroduced the exact 2026-07-31 chart-drift defect for the single largest vote writer
+// in the database (legiscan is 82.3% of all `votes` rows). The fix-round-1 comment here claimed
+// "verified against each one's real closeRun() call site, not guessed" — true for four of five,
+// but legiscan's mapping was inferred by analogy with the other four, not actually measured, and
+// the inference was wrong. This round's version really was checked against real fixture rows
+// (tests/scheduled-ingest.test.js pulls them from live `ingestion_runs`) for all five.
+//
+// Every predicate below FAILS OPEN (returns true) for a succeeded/partial run whose detail
+// doesn't match its own expected shape — refreshing anyway is the accepted-safe direction (cheap,
+// idempotent SQL); silently never refreshing is the one this whole mechanism exists to prevent.
+// A 'failed' run never fails open (nothing to refresh after a genuine failure) — the accepted risk
+// is "occasionally refresh when nothing changed," not "refresh after every failure too."
+export function moSenateWroteSomething(detail, status) {
+  const votes = detail?.counts?.votes;
+  if (typeof votes === 'number') return votes > 0;
+  return status === 'succeeded' || status === 'partial';
+}
+
+export function usCongressWroteSomething(detail, status) {
+  const votes = detail?.counts?.votes;
+  if (typeof votes === 'number') return votes > 0;
+  return status === 'succeeded' || status === 'partial';
+}
+
+export function usSenateWroteSomething(detail, status) {
+  const votes = detail?.counts?.votes;
+  if (typeof votes === 'number') return votes > 0;
+  return status === 'succeeded' || status === 'partial';
+}
+
+// mo-house-xml: unchanged shape from round 1 (re-verified against real fixtures this round,
+// including all 5 real 'bill-xml' rows on file — every real 'rollcall-pdf' row on file already
+// checked by the reviewer's own re-review). document_type-dependent — the rollcall-pdf branch
+// writes CASTS (detail.rollCallResult.castCount, a SIBLING of counts, not inside it — see
+// processRollCallPdf's return shape), the bill-xml branch writes BILL rows
+// (detail.counts.bills_detailed). Falls open for a document_type this predicate doesn't
+// recognize (a future third branch) rather than assuming nothing was written.
+export function moHouseWroteSomething(detail, status) {
+  const documentType = detail?.counts?.document_type;
+  if (documentType === 'rollcall-pdf') {
+    const castCount = detail?.rollCallResult?.castCount;
+    if (typeof castCount === 'number') return castCount > 0;
+  } else if (documentType === 'bill-xml') {
+    const billsDetailed = detail?.counts?.bills_detailed;
+    if (typeof billsDetailed === 'number') return billsDetailed > 0;
   }
-  return (counts.votes ?? 0) > 0;
+  return status === 'succeeded' || status === 'partial';
+}
+
+// legiscan (the actual NEW-1 fix): `ingest-legiscan.js`'s own `buildSuccessCloseDetail` (that
+// file's own :961-963) is `return {...counts, attribution, queries_used: counts.queriesUsed}` —
+// it spreads `result.counts` at the TOP LEVEL of `detail`, never nested under a `.counts` key.
+// Verified against all 50 real `ingest-legiscan.js` rows on file: `detail.votes` (top-level) is a
+// genuine, reliable counter, observed 0-659 — this is the honest signal the old code's
+// `detail.counts.votes` lookup could never have matched (there is no `detail.counts` for this
+// CLI's own runs at all, which is the actual root cause of NEW-1's 0/52).
+//
+// `src/cli/ingest-legiscan-texts.js` ALSO writes to `source='legiscan'` — its own header comment
+// says so explicitly ("SAME source as ingest-legiscan.js") — with a COMPLETELY different,
+// votes-unrelated close-detail shape (billsPlanned/docCacheHits/alreadyHasVersion/... — text-cache
+// counters, nested under `detail.counts`, no votes field anywhere; 2 of the 52 real rows). This
+// scheduler's own registry only ever invokes ingest-legiscan.js, never ingest-legiscan-texts.js —
+// but queryLatestRun reads whatever the LATEST row for source='legiscan' happens to be, so if that
+// text CLI is ever run manually between scheduler ticks, this predicate would see ITS shape
+// instead. No honest votes signal exists there either, so it falls through to the same fail-open
+// default as every other unrecognized shape.
+export function legiscanWroteSomething(detail, status) {
+  const votes = detail?.votes;
+  if (typeof votes === 'number') return votes > 0;
+  return status === 'succeeded' || status === 'partial';
+}
+
+// defaultWroteSomething: fail-open fallback for a registry entry with no predicate wired at all
+// (should never happen with the five fixed entries below — defensive only, e.g. against a future
+// sixth source added without also wiring its own predicate).
+export function defaultWroteSomething(detail, status) {
+  return status === 'succeeded' || status === 'partial';
 }
 
 // ---- DB-facing helpers ----
 
 export async function queryLatestStartedAt(client, source) {
   const { data, error } = await client
     .from('ingestion_runs')
     .select('started_at')
     .eq('source', source)
     .order('started_at', { ascending: false })
@@ -543,82 +629,87 @@ export async function buildRegistry(client, { now = Date.now(), year = new Date(
   return [
     {
       key: 'mo-senate-web',
       minIntervalMs: MO_SENATE_MIN_INTERVAL_MS,
       lastStartedAtIso: moSenateLast.ok ? moSenateLast.value : null,
       resolvable: moSenateLast.ok,
       unresolvedReason: skipReason(moSenateLast),
       scriptPath: 'src/cli/ingest-mo-senate.js',
       cliArgs: ['--year', String(year), '--limit', '1'],
       timeoutMs: CHILD_TIMEOUT_MS,
+      wroteSomething: moSenateWroteSomething,
     },
     {
       key: 'mo-house-xml',
       minIntervalMs: MO_HOUSE_MIN_INTERVAL_MS,
       lastStartedAtIso: moHouseLast.ok ? moHouseLast.value : null,
       resolvable: moHouseLast.ok,
       unresolvedReason: skipReason(moHouseLast),
       scriptPath: 'src/cli/ingest-mo-house.js',
       // RESTRICTION (TODO 31 — do not violate): current-session ingestion ONLY. mo_house_id is
       // declared table-wide `unique` (migration 0005) against a current-only roster, so a
       // historical/multi-era backfill would silently misattribute a successor's votes to their
       // predecessor. NEVER add --session (or any year/era flag) here — --limit 1 alone lets the
       // CLI fall through to its own DEFAULT_MO_HOUSE_SESSION, which is the current session.
       cliArgs: ['--limit', '1'],
       timeoutMs: CHILD_TIMEOUT_MS,
+      wroteSomething: moHouseWroteSomething,
     },
     {
       key: 'us-congress',
       minIntervalMs: US_CONGRESS_MIN_INTERVAL_MS,
       lastStartedAtIso: usCongressLast.ok ? usCongressLast.value : null,
       resolvable: usCongressLast.ok && rollWindow.ok && rollWindow.value != null,
       unresolvedReason: skipReason(usCongressLast) ?? skipReason(rollWindow),
       scriptPath: 'src/cli/ingest.js',
       // rollWindow.value is null both on a genuine failure (rollWindow.ok===false, handled by
       // skipReason above) AND on a lookup skipped outright because --only excluded this source
       // (rollWindow.ok===true, value:null, per safeLookup) — either way, no real window exists to
       // build --rolls from, so cliArgs must stay empty rather than dereference a null value.
       cliArgs: rollWindow.value != null
         ? ['--source', 'us-congress', '--year', String(year), '--rolls', `${rollWindow.value.lo}-${rollWindow.value.hi}`]
         : [],
       timeoutMs: CHILD_TIMEOUT_MS,
       windowMaxKnown: rollWindow.value != null ? rollWindow.value.maxKnown : undefined,
+      wroteSomething: usCongressWroteSomething,
     },
     {
       key: 'us-senate',
       minIntervalMs: US_SENATE_MIN_INTERVAL_MS,
       lastStartedAtIso: usSenateLast.ok ? usSenateLast.value : null,
       resolvable: usSenateLast.ok && voteWindow.ok && voteWindow.value != null,
       unresolvedReason: skipReason(usSenateLast) ?? skipReason(voteWindow),
       scriptPath: 'src/cli/ingest.js',
       cliArgs: voteWindow.value != null
         ? ['--source', 'us-senate', '--session', String(US_SENATE_SESSION), '--votes', `${voteWindow.value.lo}-${voteWindow.value.hi}`]
         : [],
       timeoutMs: CHILD_TIMEOUT_MS,
       windowMaxKnown: voteWindow.value != null ? voteWindow.value.maxKnown : undefined,
+      wroteSomething: usSenateWroteSomething,
     },
     {
       key: 'legiscan',
       minIntervalMs: LEGISCAN_MIN_INTERVAL_MS,
       lastStartedAtIso: legiscanLast.ok ? legiscanLast.value : null,
       resolvable: legiscanResolvable,
       unresolvedReason: skipReason(legiscanLast) ?? skipReason(legiscanSessionId) ?? (legiscanResolvedId == null
         ? `no legiscan_session_id on file for MO session '${DEFAULT_MO_HOUSE_SESSION}' (sessions.legiscan_session_id) — `
           + 'see TODO.md item 25; not guessed, skipped honestly until resolved'
         : null),
       scriptPath: 'src/cli/ingest-legiscan.js',
       // ⛔ dataset_hash comparison happens INSIDE ingest-legiscan.js (decodeDatasetHashGate) —
       // never re-implemented here. This registry entry only ever supplies --session; the
       // suspension-level gate itself is entirely the CLI's own responsibility, invoked, not
       // reimplemented.
       cliArgs: legiscanResolvedId != null ? ['--session', String(legiscanResolvedId)] : [],
       timeoutMs: LEGISCAN_CHILD_TIMEOUT_MS,
+      wroteSomething: legiscanWroteSomething,
     },
   ];
 }
 
 // ---- process orchestration ----
 
 function defaultSpawn(command, args, options) {
   return spawnSync(command, args, { encoding: 'utf8', ...options });
 }
 
@@ -739,23 +830,25 @@ export async function closeOrphanedRunningRows(client, source, { sinceIso, timeo
 // ALL of these are exactly "the child never got as far as reaching its own openRun", the scenario
 // C1 exists for) the error is caught HERE, not left to propagate — because propagating it would
 // skip the "did a new row appear" check entirely and defeat the whole point of the fix. Whether
 // the child threw or merely exited non-zero, if `ingestion_runs` shows no NEW row for this source
 // since before this call, the scheduler writes its own failed attempt row. Never rethrown — a
 // failing source is logged and reported, never a scheduler crash (the original, still-valid
 // design principle).
 //
 // I4: classifies the outcome from the run's OWN detail — never mode/status alone. `healthy` folds
 // in the tail-probe case (I4a): a windowed source (us-congress/us-senate) whose ONLY failures are
-// expected past-the-edge 404s reads as healthy, not alarming. `wroteRows` (I4b) is what gates the
-// aggregate refresh in main() — read from detail.counts, so a tick where every probe 404s and
-// zero rows landed correctly does NOT trigger a refresh, unlike the old mode/status heuristic.
+// expected past-the-edge 404s reads as healthy, not alarming. `wroteRows` (I4b, round 3 NEW-1 fix)
+// is what gates the aggregate refresh in main() — read via chosen.wroteSomething, THIS source's
+// own registry-declared predicate (see buildRegistry / the wroteSomething functions above), so a
+// tick where every probe 404s and zero rows landed correctly does NOT trigger a refresh, while a
+// shape a predicate doesn't recognize fails open (refreshes anyway) rather than silently never.
 // tickStartIso (round 2, finding 3): this TICK's own start time (main() captures `now` once,
 // before anything else runs, and passes its ISO form through) — the ONLY thing
 // closeOrphanedRunningRows below is allowed to treat as "this run's own row." Required whenever a
 // forceful kill is possible; the existing round-1 tests never reach that branch, so they are
 // unaffected by its absence.
 export async function runChosenSource(client, chosen, { runChildCliFn = runChildCli, tickStartIso } = {}) {
   let childResult;
   let launchError = null;
   let killedByScheduler = false;
   try {
@@ -777,41 +870,60 @@ export async function runChosenSource(client, chosen, { runChildCliFn = runChild
       parseError: err.message,
     };
   }
 
   let killClosedRunIds = [];
   if (killedByScheduler) {
     // mo-senate-web/mo-house-xml/legiscan all call openRun BEFORE their long work — for those,
     // this closes the row the kill stranded at 'running'. For us-congress/us-senate (which open
     // LATE, the actual C1 root cause), this correctly finds nothing and is a harmless no-op; the
     // existing self-record path below handles that case instead.
+    //
+    // Round 3, NEW-4: sinceIso is tickStartIso MINUS a skew-tolerance grace, not tickStartIso
+    // itself. tickStartIso comes from this process's LOCAL clock (Date.now() in main(), captured
+    // before anything else runs); started_at is DB-assigned (Postgres column default now(), the
+    // Supabase server's clock). If the local clock runs even slightly ahead of the server's, a row
+    // the CHOSEN source opens a second or two into this very tick could land with
+    // started_at < tickStartIso — the exact row this mechanism exists to find would then silently
+    // fail the >= filter, with killClosedRunIds:[] reading identically to "nothing needed closing".
+    // Safety argument for why 5 minutes of grace cannot capture stale, pre-existing history: every
+    // registry source's own minIntervalMs is >=30 minutes, so a 'running' row for THIS source
+    // dated within 5 minutes before tick start would mean that source was invoked well inside its
+    // own cooldown — impossible, since pickMostOverdue only ever selects a DUE source, and a
+    // source invoked <30min ago cannot be due under a >=30min interval. Any 'running' row this
+    // grace additionally captures must therefore be from the invocation THIS tick just made, never
+    // an older one.
     killClosedRunIds = await closeOrphanedRunningRows(client, chosen.key, {
-      sinceIso: tickStartIso,
+      sinceIso: new Date(Date.parse(tickStartIso) - ORPHAN_CLOSE_SKEW_GRACE_MS).toISOString(),
       timeoutMs: launchError.timeoutMs ?? chosen.timeoutMs,
       note: `${launchError.code}: ${launchError.message}`,
     });
   }
 
   const latestRun = await queryLatestRun(client, chosen.key);
   const newRowAppeared = latestRun !== null && latestRun.started_at !== chosen.lastStartedAtIso;
 
   let selfRecordedFailure = false;
   let selfRecordedRunId = null;
   if (!newRowAppeared) {
     selfRecordedRunId = await recordSchedulerAttemptFailure(client, chosen.key, childResult, launchError);
     selfRecordedFailure = true;
   }
 
   const detail = selfRecordedFailure ? {} : (latestRun?.detail ?? {});
   const status = selfRecordedFailure ? 'failed' : (latestRun?.status ?? null);
   const failures = detail.failures ?? [];
-  const wroteRows = !selfRecordedFailure && countsShowRowsWritten(chosen.key, detail);
+  // Round 3, NEW-1 fix: chosen.wroteSomething is THIS source's own registry-declared predicate
+  // (buildRegistry) — never a generic key-dispatched function guessing at a shape it was never
+  // checked against. defaultWroteSomething is the fail-open fallback for the (should-never-happen)
+  // case where a registry entry has no predicate wired at all.
+  const wroteRows = !selfRecordedFailure && (chosen.wroteSomething ?? defaultWroteSomething)(detail, status);
   const tailProbeOnly = !selfRecordedFailure && status === 'partial'
     && isExpectedTailProbeOutcome(chosen.key, failures, chosen.windowMaxKnown);
   const healthy = !selfRecordedFailure && !killedByScheduler && (status === 'succeeded' || tailProbeOnly);
 
   let note = null;
   if (killedByScheduler) {
     note = `scheduler killed this run (${launchError.code}) after its ${formatCooldownWait(launchError.timeoutMs ?? chosen.timeoutMs)} timeout — `
       + `${killClosedRunIds.length} orphaned 'running' row(s) closed honestly`;
   } else if (tailProbeOnly) {
     note = `${failures.length} tail 404(s) past ${chosen.key === 'us-congress' ? 'roll' : 'vote'} ${chosen.windowMaxKnown} — expected from the probe window, not a failure`;
@@ -963,21 +1075,40 @@ async function main() {
         lockReclaimed,
       });
       return;
     }
 
     // Round 2, finding 2: the lock's declared duration must cover THIS source's real timeout
     // before we spawn it — written after selection (now that we know chosen.timeoutMs), before
     // the child starts, so a later tick's stale-reclaim check judges this run against its actual
     // bound (e.g. legiscan's 75 min) rather than the generic selection-phase placeholder
     // acquireLock wrote.
-    updateLockMaxDuration(LOCK_PATH, lockResult.nonce, chosen.timeoutMs + LOCK_GRACE_MS);
+    //
+    // Round 3, NEW-3: its return value MUST be acted on. Round 2 called this purely for effect —
+    // if it failed (lock missing/corrupt/no-longer-nonce-matched between acquire and here, an
+    // edge case but a real one), the child would still have been spawned under the stale
+    // selection-phase placeholder, reopening the exact mid-run-reclaim window round 2 exists to
+    // close. Fail-safe beats limping: if the lock can't record the run's real declared duration,
+    // do not spawn it at all — log honestly, release the lock (still via the outer finally), exit
+    // 0, and let the next tick retry (the source's own due-ness is untouched, since nothing ran).
+    const durationRecorded = updateLockMaxDuration(LOCK_PATH, lockResult.nonce, chosen.timeoutMs + LOCK_GRACE_MS);
+    if (!durationRecorded) {
+      writeLog({
+        timestamp: nowIso(),
+        mode: 'blocked',
+        chosen: chosen.key,
+        reason: `could not record ${chosen.key}'s declared run duration on the lock before spawning — refusing to start a run the stale-reclaim window would not correctly protect; next tick retries`,
+        sources: sourcesSummary,
+        lockReclaimed,
+      });
+      return;
+    }
 
     const run = await runChosenSource(client, chosen, { tickStartIso: nowIsoAtTickStart });
 
     // I4b: refresh-aggregates fires ONLY when the run's own detail.counts show rows actually
     // written (run.outcome.wroteRows) — never the old "mode==='live' && succeeded/partial"
     // heuristic, which was true even on a tick where every us-congress probe 404s and nothing
     // landed, so the refresh used to fire unconditionally every hour regardless.
     let aggregatesResult = null;
     if (run.outcome.wroteRows) {
       const refreshResult = runChildCli('scripts/refresh-aggregates.js', []);
diff --git a/tests/scheduled-ingest.test.js b/tests/scheduled-ingest.test.js
index 64705f1..709dae4 100644
--- a/tests/scheduled-ingest.test.js
+++ b/tests/scheduled-ingest.test.js
@@ -3,27 +3,30 @@ import assert from 'node:assert/strict';
 import {
   mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync,
 } from 'node:fs';
 import { spawnSync } from 'node:child_process';
 import path from 'node:path';
 import os from 'node:os';
 import {
   parseArgs, isLockStale, acquireLock, releaseLock, updateLockMaxDuration,
   computeSourceDueness, pickMostOverdue,
   parseUsHouseRoll, parseUsSenateVote, computeRollWindow,
-  isExpectedTailProbeOutcome, countsShowRowsWritten,
+  isExpectedTailProbeOutcome,
+  moSenateWroteSomething, usCongressWroteSomething, usSenateWroteSomething, moHouseWroteSomething,
+  legiscanWroteSomething, defaultWroteSomething,
   parseChildOutput,
   queryLatestStartedAt, queryLatestRun,
   resolveLegiscanSessionId, resolveUsCongressRollWindow, resolveUsSenateVoteWindow, buildRegistry,
   runChildCli, recordSchedulerAttemptFailure, closeOrphanedRunningRows, runChosenSource,
   getSchedulerClient, envIntervalMs,
-  MAX_RUN_DURATION_MS, CHILD_TIMEOUT_MS, CHILD_MAX_BUFFER, LEGISCAN_CHILD_TIMEOUT_MS, LOCK_GRACE_MS,
+  MAX_RUN_DURATION_MS, MAX_LOCK_DURATION_MS, CHILD_TIMEOUT_MS, CHILD_MAX_BUFFER,
+  LEGISCAN_CHILD_TIMEOUT_MS, LOCK_GRACE_MS, ORPHAN_CLOSE_SKEW_GRACE_MS,
   US_CONGRESS_CONGRESS, US_CONGRESS_ROLL_WINDOW, US_SENATE_SESSION, US_SENATE_VOTE_WINDOW,
 } from '../scripts/scheduled-ingest.js';
 import { MO_SENATE_MIN_INTERVAL_MS } from '../src/adapters/mo-senate-web.js';
 import { MO_HOUSE_MIN_INTERVAL_MS, DEFAULT_MO_HOUSE_SESSION } from '../src/adapters/mo-house-xml.js';
 
 // ---- parseArgs ----
 
 test('parseArgs defaults to live, no --only', () => {
   const out = parseArgs([]);
   assert.equal(out.dryRun, false);
@@ -224,20 +227,48 @@ test('isLockStale directly: missing/non-numeric/non-positive maxDurationMs all f
   assert.equal(isLockStale({ startedAt, maxDurationMs: 0 }, now), true);
 });
 
 test('isLockStale directly: a valid maxDurationMs on the lock is honored over the fallback', () => {
   const now = Date.parse('2026-07-31T12:15:00.000Z'); // 15 min elapsed
   const startedAt = '2026-07-31T12:00:00.000Z';
   assert.equal(isLockStale({ startedAt, maxDurationMs: 75 * 60 * 1000 }, now), false);
   assert.equal(isLockStale({ startedAt, maxDurationMs: 8 * 60 * 1000 }, now), true);
 });
 
+// ---- ROUND 3, NEW-2 RED-FIRST: a declared duration beyond MAX_LOCK_DURATION_MS is treated like
+// missing/corrupt — never honored as "never go stale" ----
+
+test('ROUND 3 RED-FIRST (NEW-2): an absurdly large declared maxDurationMs (e.g. hand-edited to ~31 years) is NOT honored — falls back to the default, so the lock CAN still go stale', () => {
+  const startedAt = '2026-07-31T12:00:00.000Z';
+  const wellPastDefault = Date.parse(startedAt) + MAX_RUN_DURATION_MS + 60 * 1000; // 1 min past the 10-min default
+
+  // Without the NEW-2 fix, 1e12 ms (~31 years) would be honored verbatim and this would read false.
+  assert.equal(isLockStale({ startedAt, maxDurationMs: 1e12 }, wellPastDefault), true);
+});
+
+test('ROUND 3 (NEW-2): a value right at MAX_LOCK_DURATION_MS is still honored; one msec beyond it falls back to the default', () => {
+  const startedAt = '2026-07-31T12:00:00.000Z';
+  const withinCeiling = Date.parse(startedAt) + MAX_LOCK_DURATION_MS - 1000; // 1s before the ceiling elapses
+  assert.equal(isLockStale({ startedAt, maxDurationMs: MAX_LOCK_DURATION_MS }, withinCeiling), false);
+
+  const beyondDefaultButNotCeiling = Date.parse(startedAt) + MAX_RUN_DURATION_MS + 1000; // past the 10-min default
+  assert.equal(
+    isLockStale({ startedAt, maxDurationMs: MAX_LOCK_DURATION_MS + 1 }, beyondDefaultButNotCeiling),
+    true,
+    'a duration one msec beyond the ceiling must fall back to the (much smaller) default, not be honored',
+  );
+});
+
+test('ROUND 3 (NEW-2): MAX_LOCK_DURATION_MS comfortably exceeds the largest real declared duration (legiscan + grace)', () => {
+  assert.ok(MAX_LOCK_DURATION_MS > LEGISCAN_CHILD_TIMEOUT_MS + LOCK_GRACE_MS);
+});
+
 test('acquireLock writes the initial maxDurationMs (MAX_RUN_DURATION_MS, the selection-phase default) into a fresh lock', () => {
   withTmpDir((dir) => {
     const lockPath = path.join(dir, 'scheduler.lock.json');
     acquireLock(lockPath, { now: Date.now() });
     const written = JSON.parse(readFileSync(lockPath, 'utf8'));
     assert.equal(written.maxDurationMs, MAX_RUN_DURATION_MS);
   });
 });
 
 test('updateLockMaxDuration rewrites the declared duration when the nonce matches, preserving pid/startedAt/nonce', () => {
@@ -375,52 +406,223 @@ test('isExpectedTailProbeOutcome: false when a roll/vote failure is AT OR BELOW
   assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 283' }], 283), false);
   assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 200' }], 283), false);
 });
 
 test('isExpectedTailProbeOutcome: false for a non-windowed source, or when there are no failures to explain away', () => {
   assert.equal(isExpectedTailProbeOutcome('mo-senate-web', [{ step: 'roll 291' }], 283), false);
   assert.equal(isExpectedTailProbeOutcome('us-congress', [], 283), false);
   assert.equal(isExpectedTailProbeOutcome('us-congress', [{ step: 'roll 291' }], undefined), false);
 });
 
-// ---- I4b (fix round 1) red-first: countsShowRowsWritten replaces the old mode/status heuristic ----
+// ---- ROUND 3, NEW-1 RED-FIRST: per-source wroteSomething predicates, verified against REAL
+// ingestion_runs fixture rows (fetched read-only from the live DB during this fix round, trimmed
+// to the fields that matter) — not invented shapes. This is what caught the original bug:
+// fix-round-1's countsShowRowsWritten claimed "verified against each one's real closeRun() call
+// site" but legiscan's mapping was actually inferred by analogy, and measured 0/52 true against
+// real data. Every fixture below is a REAL observed shape. ----
+
+// ---- mo-senate-web: real detail.counts.votes, both the "wrote something" and early-close
+// "wrote nothing" (roster/journal-index slot, votes always 0) shapes really occur ----
+
+const REAL_MO_SENATE_WROTE_VOTES = {
+  status: 'succeeded',
+  detail: {
+    counts: {
+      days: 1, casts: 231, gated: false, votes: 7, failures: 0, unresolved: 7,
+    },
+  },
+};
+const REAL_MO_SENATE_JOURNAL_INDEX_SLOT = {
+  status: 'succeeded',
+  detail: {
+    counts: {
+      days: 0, slot: 'journal-index', casts: 0, gated: false, votes: 0, failures: 0, unresolved: 0,
+    },
+  },
+};
+
+test('moSenateWroteSomething: real "wrote votes" row -> true; real journal-index early-close slot (votes always 0) -> false', () => {
+  assert.equal(moSenateWroteSomething(REAL_MO_SENATE_WROTE_VOTES.detail, REAL_MO_SENATE_WROTE_VOTES.status), true);
+  assert.equal(moSenateWroteSomething(REAL_MO_SENATE_JOURNAL_INDEX_SLOT.detail, REAL_MO_SENATE_JOURNAL_INDEX_SLOT.status), false);
+});
+
+test('moSenateWroteSomething: an unrecognized shape fails OPEN on a completed run, but never on a failed one', () => {
+  assert.equal(moSenateWroteSomething({ somethingElse: true }, 'succeeded'), true);
+  assert.equal(moSenateWroteSomething({ somethingElse: true }, 'partial'), true);
+  assert.equal(moSenateWroteSomething({ somethingElse: true }, 'failed'), false);
+  assert.equal(moSenateWroteSomething(null, 'succeeded'), true);
+});
+
+// ---- us-congress / us-senate: real detail.counts.votes ----
+
+const REAL_US_CONGRESS_PARTIAL_WITH_FAILURES = {
+  status: 'partial',
+  detail: {
+    notes: [], counts: {
+      bills: 173, casts: 122129, votes: 283, failures: 2, legislators: 53,
+    }, failures: [{ step: 'roll 999', message: 'HTTP 404' }, { step: 'roll 1000', message: 'HTTP 404' }],
+  },
+};
+const REAL_US_CONGRESS_SUCCEEDED = {
+  status: 'succeeded',
+  detail: {
+    notes: [], counts: {
+      bills: 3, casts: 2165, votes: 5, failures: 0, legislators: 53,
+    }, failures: [],
+  },
+};
+
+test('usCongressWroteSomething: real succeeded row (votes:5) -> true; real partial-with-failures row (votes:283, the tail-probe shape) -> ALSO true, since votes really did land', () => {
+  assert.equal(usCongressWroteSomething(REAL_US_CONGRESS_SUCCEEDED.detail, REAL_US_CONGRESS_SUCCEEDED.status), true);
+  assert.equal(usCongressWroteSomething(REAL_US_CONGRESS_PARTIAL_WITH_FAILURES.detail, REAL_US_CONGRESS_PARTIAL_WITH_FAILURES.status), true);
+});
+
+test('usCongressWroteSomething: THE I4b REGRESSION CASE — a live/partial run whose probe window found nothing (votes:0) must read as "wrote nothing"', () => {
+  assert.equal(usCongressWroteSomething({ counts: { votes: 0, casts: 0, failures: 10 } }, 'partial'), false);
+});
+
+test('usCongressWroteSomething: an unrecognized shape fails OPEN on a completed run, never on a failed one', () => {
+  assert.equal(usCongressWroteSomething({}, 'succeeded'), true);
+  assert.equal(usCongressWroteSomething({}, 'failed'), false);
+});
+
+const REAL_US_SENATE_WROTE_VOTES = {
+  status: 'succeeded',
+  detail: {
+    counts: {
+      bills: 44, casts: 20997, votes: 210, failures: 0, resolved: 20997, unresolved: 0, senate_members_ensured: 100, senate_members_filtered_historical: 2157,
+    },
+    failures: [],
+    unresolved: [],
+  },
+};
+
+test('usSenateWroteSomething: real succeeded row (votes:210) -> true; a zero-vote instance of the same real shape -> false', () => {
+  assert.equal(usSenateWroteSomething(REAL_US_SENATE_WROTE_VOTES.detail, REAL_US_SENATE_WROTE_VOTES.status), true);
+  const zeroVotes = { counts: { ...REAL_US_SENATE_WROTE_VOTES.detail.counts, votes: 0 } };
+  assert.equal(usSenateWroteSomething(zeroVotes, 'succeeded'), false);
+});
+
+test('usSenateWroteSomething: an unrecognized shape fails OPEN on a completed run, never on a failed one', () => {
+  assert.equal(usSenateWroteSomething({}, 'partial'), true);
+  assert.equal(usSenateWroteSomething({}, 'failed'), false);
+});
+
+// ---- mo-house-xml: real rollcall-pdf (rollCallResult.castCount) and bill-xml
+// (counts.bills_detailed) shapes, both branches ----
+
+const REAL_MO_HOUSE_ROLLCALL_PDF = {
+  status: 'succeeded',
+  detail: {
+    counts: {
+      failures: 0, document_type: 'rollcall-pdf', skipped_failed_pdfs: 0, skipped_failed_pdf_keys: [],
+    },
+    rollCallResult: {
+      mode: 'live', gated: false, resolved: 1, castCount: 158, persisted: true, unresolved: 157,
+    },
+  },
+};
+const REAL_MO_HOUSE_BILL_XML = {
+  status: 'succeeded',
+  detail: {
+    counts: {
+      roster: {}, failures: 0, bills_listed: 2099, document_type: 'bill-xml', bills_detailed: 1, list_fetch_mode: 'live', skipped_failed_pdfs: 0, skipped_failed_pdf_keys: [],
+    },
+    failures: [],
+    billResults: [{}],
+  },
+};
+
+test('moHouseWroteSomething: real rollcall-pdf row (castCount:158) -> true; a zero-cast instance of the same real shape -> false', () => {
+  assert.equal(moHouseWroteSomething(REAL_MO_HOUSE_ROLLCALL_PDF.detail, REAL_MO_HOUSE_ROLLCALL_PDF.status), true);
+  const zeroCast = { ...REAL_MO_HOUSE_ROLLCALL_PDF.detail, rollCallResult: { ...REAL_MO_HOUSE_ROLLCALL_PDF.detail.rollCallResult, castCount: 0 } };
+  assert.equal(moHouseWroteSomething(zeroCast, 'succeeded'), false);
+});
+
+test('moHouseWroteSomething: real bill-xml row (bills_detailed:1) -> true; a zero instance of the same real shape -> false', () => {
+  assert.equal(moHouseWroteSomething(REAL_MO_HOUSE_BILL_XML.detail, REAL_MO_HOUSE_BILL_XML.status), true);
+  const zeroBills = { ...REAL_MO_HOUSE_BILL_XML.detail, counts: { ...REAL_MO_HOUSE_BILL_XML.detail.counts, bills_detailed: 0 } };
+  assert.equal(moHouseWroteSomething(zeroBills, 'succeeded'), false);
+});
+
+test('moHouseWroteSomething: an unrecognized document_type fails OPEN on a completed run, never on a failed one', () => {
+  assert.equal(moHouseWroteSomething({ counts: { document_type: 'some-future-branch' } }, 'succeeded'), true);
+  assert.equal(moHouseWroteSomething({ counts: { document_type: 'some-future-branch' } }, 'failed'), false);
+  assert.equal(moHouseWroteSomething({}, 'partial'), true);
+});
+
+// ---- legiscan: THE ACTUAL NEW-1 FIX. Real ingest-legiscan.js shape has `votes` at the TOP
+// LEVEL of detail (never nested under .counts) — the old code's detail.counts.votes lookup could
+// never match it. ALSO real: ingest-legiscan-texts.js writes to the SAME source='legiscan' key
+// with a totally different, votes-free shape (nested under .counts this time) — and a real
+// failed-run shape with no votes field at all. ----
+
+const REAL_LEGISCAN_WROTE_VOTES = {
+  status: 'succeeded',
+  detail: {
+    bills: 3146,
+    casts: 70465,
+    votes: 604,
+    people: { gated: 0, created: 0, matched: 193, ambiguous: 0 },
+    session: { id: 'bf3c7f23-358d-4399-8279-3a8e60a96eda', gated: false, reason: 'exact_key', identifier: '261' },
+    sessions: 1,
+    datasetGate: { reason: 'hash_unchanged', shouldFetch: false },
+    queriesUsed: 1,
+    queries_used: 1,
+    votesByChamber: { house: 404, senate: 200 },
+    reconciliationFailures: 0,
+  },
+};
+// The ingest-legiscan-texts.js shape — real, but votes-unrelated (document/text-cache counters).
+const REAL_LEGISCAN_TEXTS_SHAPE = {
+  status: 'partial',
+  detail: {
+    counts: {
+      inserted: 3140, nonPdfMime: 0, statusError: 0, billsPlanned: 3152, cacheCorrupt: 0, datasetsRead: 31, decodeFailed: 0, docCacheHits: 0, extractEmpty: 1, queriesSpent: 3152, budgetRefused: 0, alreadyPresent: 0, datasetsMissing: 0, oversizeRefused: 11, identityMismatch: 0, missingSourceUrl: 0, alreadyHasVersion: 25,
+    },
+    failures: new Array(12).fill({ step: 'x' }),
+    attribution: { url: 'https://legiscan.com', holder: 'LegiScan', license: 'CC BY 4.0' },
+    queries_used: 3152,
+  },
+};
+const REAL_LEGISCAN_FAILED = {
+  status: 'failed',
+  detail: {
+    error: 'Error: insertIfAbsent(votes) failed: date/time field value out of range: "0000-00-00"',
+    queries_used: 1,
+  },
+};
 
-test('countsShowRowsWritten: mo-senate-web/us-congress/us-senate/legiscan all read detail.counts.votes', () => {
-  assert.equal(countsShowRowsWritten('us-congress', { counts: { votes: 3 } }), true);
-  assert.equal(countsShowRowsWritten('us-congress', { counts: { votes: 0 } }), false);
-  assert.equal(countsShowRowsWritten('mo-senate-web', { counts: { votes: 1 } }), true);
-  assert.equal(countsShowRowsWritten('us-senate', { counts: { votes: 2 } }), true);
-  assert.equal(countsShowRowsWritten('legiscan', { counts: { votes: 5 } }), true);
+test('legiscanWroteSomething THE NEW-1 FIX: real ingest-legiscan.js row (top-level detail.votes:604) -> true — this is exactly the shape the old detail.counts.votes lookup measured 0/52 true against', () => {
+  assert.equal(legiscanWroteSomething(REAL_LEGISCAN_WROTE_VOTES.detail, REAL_LEGISCAN_WROTE_VOTES.status), true);
 });
 
-test('countsShowRowsWritten: THE I4b REGRESSION CASE — a live/partial run whose probe window found nothing must read as "wrote nothing", not "wrote something"', () => {
-  // This is exactly the shape a us-congress tick has on a typical hour: mode 'live', status
-  // 'partial' (every probed roll 404d), counts.votes still 0. The OLD heuristic
-  // (mode==='live' && status in succeeded/partial) returned true here — this must return false.
-  assert.equal(countsShowRowsWritten('us-congress', { counts: { votes: 0, casts: 0, failures: 10 } }), false);
+test('legiscanWroteSomething: a zero-vote instance of the real ingest-legiscan.js shape -> false', () => {
+  const zeroVotes = { ...REAL_LEGISCAN_WROTE_VOTES.detail, votes: 0 };
+  assert.equal(legiscanWroteSomething(zeroVotes, 'succeeded'), false);
 });
 
-test('countsShowRowsWritten: mo-house-xml rollcall-pdf branch reads rollCallResult.castCount, a SIBLING of counts, not a field inside it', () => {
-  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'rollcall-pdf' }, rollCallResult: { castCount: 5 } }), true);
-  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'rollcall-pdf' }, rollCallResult: { castCount: 0 } }), false);
-  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'rollcall-pdf' } }), false, 'missing rollCallResult must not throw or default to true');
+test('legiscanWroteSomething: the real ingest-legiscan-texts.js shape (same source=\'legiscan\' key, no votes field anywhere) fails OPEN because the run genuinely completed', () => {
+  assert.equal(legiscanWroteSomething(REAL_LEGISCAN_TEXTS_SHAPE.detail, REAL_LEGISCAN_TEXTS_SHAPE.status), true);
 });
 
-test('countsShowRowsWritten: mo-house-xml bill-xml branch reads counts.bills_detailed', () => {
-  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'bill-xml', bills_detailed: 2 } }), true);
-  assert.equal(countsShowRowsWritten('mo-house-xml', { counts: { document_type: 'bill-xml', bills_detailed: 0 } }), false);
+test('legiscanWroteSomething: the real failed-run shape (no votes field, status failed) -> false, never fails open on a genuine failure', () => {
+  assert.equal(legiscanWroteSomething(REAL_LEGISCAN_FAILED.detail, REAL_LEGISCAN_FAILED.status), false);
 });
 
-test('countsShowRowsWritten: a missing/empty detail never throws, reads as false', () => {
-  assert.equal(countsShowRowsWritten('us-congress', {}), false);
-  assert.equal(countsShowRowsWritten('us-congress', null), false);
-  assert.equal(countsShowRowsWritten('mo-house-xml', {}), false);
+// ---- defaultWroteSomething: the fallback for a registry entry with no predicate wired at all ----
+
+test('defaultWroteSomething fails open for any completed run, never for a failed one', () => {
+  assert.equal(defaultWroteSomething({ anything: true }, 'succeeded'), true);
+  assert.equal(defaultWroteSomething({ anything: true }, 'partial'), true);
+  assert.equal(defaultWroteSomething({ anything: true }, 'failed'), false);
+  assert.equal(defaultWroteSomething(null, null), false);
 });
 
 // ---- parseChildOutput ----
 
 test('parseChildOutput parses a CLI\'s pretty-printed JSON.stringify(..., null, 2) stdout', () => {
   const stdout = JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 3 } }, null, 2);
   const { parsed, parseError } = parseChildOutput(stdout);
   assert.equal(parseError, null);
   assert.equal(parsed.mode, 'live');
   assert.equal(parsed.counts.votes, 3);
@@ -600,20 +802,39 @@ test('buildRegistry: all five sources, correct scripts + static args, legiscan r
 
   assert.equal(byKey['us-senate'].scriptPath, 'src/cli/ingest.js');
   assert.deepEqual(byKey['us-senate'].cliArgs, ['--source', 'us-senate', '--session', String(US_SENATE_SESSION), '--votes', `1-${US_SENATE_VOTE_WINDOW}`]);
   assert.equal(byKey['us-senate'].windowMaxKnown, 0);
 
   assert.equal(byKey.legiscan.scriptPath, 'src/cli/ingest-legiscan.js');
   assert.deepEqual(byKey.legiscan.cliArgs, ['--session', '2239']);
   assert.equal(byKey.legiscan.resolvable, true);
 });
 
+test('ROUND 3 (NEW-1): buildRegistry wires each entry to ITS OWN wroteSomething predicate — never a shared/generic one', async () => {
+  const client = fakeRegistryClient({ legiscanSessionId: 2239 });
+  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
+  const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));
+
+  assert.equal(byKey['mo-senate-web'].wroteSomething, moSenateWroteSomething);
+  assert.equal(byKey['mo-house-xml'].wroteSomething, moHouseWroteSomething);
+  assert.equal(byKey['us-congress'].wroteSomething, usCongressWroteSomething);
+  assert.equal(byKey['us-senate'].wroteSomething, usSenateWroteSomething);
+  assert.equal(byKey.legiscan.wroteSomething, legiscanWroteSomething);
+
+  // Each predicate must be independently callable and produce source-specific answers even
+  // against the SAME detail shape — proves they are genuinely distinct functions, not one
+  // dispatcher pretending to be five.
+  assert.equal(byKey.legiscan.wroteSomething({ votes: 3 }, 'succeeded'), true); // top-level votes
+  assert.equal(byKey['us-congress'].wroteSomething({ votes: 3 }, 'succeeded'), true); // fails open — no .counts.votes here, but a completed run
+  assert.equal(byKey['us-congress'].wroteSomething({ counts: { votes: 0 } }, 'succeeded'), false); // the real, precise signal
+});
+
 test('ROUND 2: buildRegistry gives every source EXCEPT legiscan the default CHILD_TIMEOUT_MS, and legiscan its own much larger LEGISCAN_CHILD_TIMEOUT_MS', async () => {
   const client = fakeRegistryClient({ legiscanSessionId: 2239 });
   const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
   const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));
 
   assert.equal(byKey['mo-senate-web'].timeoutMs, CHILD_TIMEOUT_MS);
   assert.equal(byKey['mo-house-xml'].timeoutMs, CHILD_TIMEOUT_MS);
   assert.equal(byKey['us-congress'].timeoutMs, CHILD_TIMEOUT_MS);
   assert.equal(byKey['us-senate'].timeoutMs, CHILD_TIMEOUT_MS);
   assert.equal(byKey.legiscan.timeoutMs, LEGISCAN_CHILD_TIMEOUT_MS);
@@ -980,20 +1201,21 @@ test('closeOrphanedRunningRows is a harmless no-op for a source that never opene
 test('ROUND 2 RED-FIRST (finding 3): a timeout-killed legiscan run (which had already opened its own row) gets that row closed honestly — never stranded at running, never double-recorded by C1', async () => {
   const tickStartIso = '2026-07-31T12:00:00.000Z';
   const chosen = {
     key: 'legiscan',
     minIntervalMs: 24 * 60 * 60 * 1000,
     lastStartedAtIso: '2026-07-30T07:00:00.000Z', // yesterday's run — unrelated to this tick
     resolvable: true,
     scriptPath: 'src/cli/ingest-legiscan.js',
     cliArgs: ['--session', '2239'],
     timeoutMs: 75 * 60 * 1000,
+    wroteSomething: legiscanWroteSomething,
   };
   const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
   // Simulate: legiscan's own openRun already fired (a real row exists, 'running') before the
   // 75-minute timeout killed it mid-dataset-processing.
   const orphanId = client._seed({
     source: 'legiscan', status: 'running', started_at: '2026-07-31T12:03:00.000Z', detail: null,
   });
 
   const spawnFn = () => ({
     error: Object.assign(new Error('spawnSync ingest-legiscan.js ETIMEDOUT'), { code: 'ETIMEDOUT' }),
@@ -1012,31 +1234,99 @@ test('ROUND 2 RED-FIRST (finding 3): a timeout-killed legiscan run (which had al
   assert.equal(result.outcome.healthy, false);
   assert.equal(result.outcome.wroteRows, false);
   assert.match(result.outcome.note, /scheduler killed this run/);
 
   const closedRow = client._get(orphanId);
   assert.equal(closedRow.status, 'failed');
   assert.equal(closedRow.detail.scheduler_kill, true);
   assert.equal(closedRow.detail.timeoutMs, 75 * 60 * 1000);
 });
 
+test('ROUND 3 RED-FIRST (NEW-4): a forward-skewed local clock (this tick\'s row lands slightly BEFORE the literal tickStartIso) is still found and closed, thanks to the skew-tolerance grace', async () => {
+  const tickStartIso = '2026-07-31T12:00:00.000Z';
+  const chosen = {
+    key: 'legiscan',
+    minIntervalMs: 24 * 60 * 60 * 1000,
+    lastStartedAtIso: '2026-07-30T07:00:00.000Z',
+    resolvable: true,
+    scriptPath: 'src/cli/ingest-legiscan.js',
+    cliArgs: ['--session', '2239'],
+    timeoutMs: 75 * 60 * 1000,
+    wroteSomething: legiscanWroteSomething,
+  };
+  const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
+  // The DB (server clock) timestamped this row 90 SECONDS BEFORE the local tickStartIso — a
+  // plausible forward local-clock skew. Without the grace, the plain `>= tickStartIso` filter
+  // would miss it entirely (killClosedRunIds: [], silently indistinguishable from "nothing
+  // needed closing"). It is well within ORPHAN_CLOSE_SKEW_GRACE_MS (5 min), so it must still be found.
+  const orphanId = client._seed({
+    source: 'legiscan', status: 'running', started_at: '2026-07-31T11:58:30.000Z', detail: null,
+  });
+
+  const spawnFn = () => ({
+    error: Object.assign(new Error('spawnSync ingest-legiscan.js ETIMEDOUT'), { code: 'ETIMEDOUT' }),
+    status: null, stdout: '', stderr: '',
+  });
+  const result = await runChosenSource(client, chosen, {
+    runChildCliFn: (scriptPath, cliArgs, opts) => runChildCli(scriptPath, cliArgs, { ...opts, spawnFn }),
+    tickStartIso,
+  });
+
+  assert.deepEqual(result.killClosedRunIds, [orphanId], 'the skew-tolerant grace must still find a row timestamped slightly before tickStartIso');
+  assert.equal(client._get(orphanId).status, 'failed');
+});
+
+test('ROUND 3 (NEW-4): the skew grace is bounded — a row from BEFORE the grace window (genuinely older, pre-existing history) is still correctly excluded', async () => {
+  const tickStartIso = '2026-07-31T12:00:00.000Z';
+  const chosen = {
+    key: 'legiscan',
+    minIntervalMs: 24 * 60 * 60 * 1000,
+    lastStartedAtIso: '2026-07-30T07:00:00.000Z',
+    resolvable: true,
+    scriptPath: 'src/cli/ingest-legiscan.js',
+    cliArgs: ['--session', '2239'],
+    timeoutMs: 75 * 60 * 1000,
+    wroteSomething: legiscanWroteSomething,
+  };
+  const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
+  // 6 minutes before tick start — outside the 5-minute grace. Per the safety argument (every
+  // registry interval is >=30 min), this could not be a row THIS tick's invocation created, and
+  // must never be touched.
+  const staleId = client._seed({
+    source: 'legiscan', status: 'running', started_at: '2026-07-31T11:54:00.000Z', detail: null,
+  });
+
+  const spawnFn = () => ({
+    error: Object.assign(new Error('spawnSync ingest-legiscan.js ETIMEDOUT'), { code: 'ETIMEDOUT' }),
+    status: null, stdout: '', stderr: '',
+  });
+  const result = await runChosenSource(client, chosen, {
+    runChildCliFn: (scriptPath, cliArgs, opts) => runChildCli(scriptPath, cliArgs, { ...opts, spawnFn }),
+    tickStartIso,
+  });
+
+  assert.deepEqual(result.killClosedRunIds, [], 'a row older than the grace window must never be touched');
+  assert.equal(client._get(staleId).status, 'running', 'genuinely pre-existing history is left completely alone');
+});
+
 test('ROUND 2: a timeout-killed us-congress run (which never reached its own openRun) still falls through to C1\'s self-record — closeOrphanedRunningRows correctly finds nothing to close', async () => {
   const tickStartIso = '2026-07-31T12:00:00.000Z';
   const chosen = {
     key: 'us-congress',
     minIntervalMs: 60 * 60 * 1000,
     lastStartedAtIso: '2026-07-28T04:40:00.000Z',
     resolvable: true,
     scriptPath: 'src/cli/ingest.js',
     cliArgs: ['--source', 'us-congress', '--rolls', '284-293'],
     timeoutMs: 8 * 60 * 1000,
     windowMaxKnown: 283,
+    wroteSomething: usCongressWroteSomething,
   };
   const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
   const spawnFn = () => ({
     error: Object.assign(new Error('spawnSync ingest.js ETIMEDOUT'), { code: 'ETIMEDOUT' }),
     status: null, stdout: '', stderr: 'stuck fetching member list',
   });
 
   const result = await runChosenSource(client, chosen, {
     runChildCliFn: (scriptPath, cliArgs, opts) => runChildCli(scriptPath, cliArgs, { ...opts, spawnFn }),
     tickStartIso,
@@ -1052,20 +1342,21 @@ test('ROUND 2: a timeout-killed us-congress run (which never reached its own ope
 test('C1 RED-FIRST: when the child fails and writes NO new ingestion_runs row, runChosenSource self-records an honest failed attempt — and the source is no longer most-overdue on the next computation', async () => {
   const oldStartedAt = '2026-07-28T04:40:00.000Z'; // matches the live incident's real timestamp
   const chosen = {
     key: 'us-congress',
     minIntervalMs: 60 * 60 * 1000,
     lastStartedAtIso: oldStartedAt,
     resolvable: true,
     scriptPath: 'src/cli/ingest.js',
     cliArgs: ['--source', 'us-congress', '--year', '2026', '--rolls', '284-293'],
     windowMaxKnown: 283,
+    wroteSomething: usCongressWroteSomething,
   };
 
   // The fake starts already seeded with the OLD row (matching chosen.lastStartedAtIso) — the
   // child "fails before openRun" (ingest.js's fetchMemberList throws), so nothing INSERTs a new
   // row on its own; only recordSchedulerAttemptFailure (invoked internally by runChosenSource)
   // will change what queryLatestRun sees next.
   const client = fakeIngestionRunsClient({ started_at: oldStartedAt, status: 'succeeded', detail: {} });
 
   // Simulates a hard crash: congress.gov down, ingest.js throws before ever printing JSON —
   // non-zero exit, empty/non-JSON stdout.
@@ -1095,20 +1386,21 @@ test('C1 RED-FIRST: when the child fails and writes NO new ingestion_runs row, r
 });
 
 test('runChosenSource: a NORMAL successful child (which writes its own row) is NOT self-recorded — the child\'s own row is trusted', async () => {
   const chosen = {
     key: 'mo-senate-web',
     minIntervalMs: 30 * 60 * 1000,
     lastStartedAtIso: '2026-07-31T11:00:00.000Z',
     resolvable: true,
     scriptPath: 'src/cli/ingest-mo-senate.js',
     cliArgs: ['--year', '2026', '--limit', '1'],
+    wroteSomething: moSenateWroteSomething,
   };
   const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
 
   const spawnFn = () => ({ status: 0, stdout: JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 4, casts: 200 } }), stderr: '' });
   // Pre-seed what the child "would have written" by inserting directly through the same fake —
   // runChosenSource only OBSERVES ingestion_runs, it doesn't care who wrote the row.
   const inserted = await client.from('ingestion_runs').insert({ source: 'mo-senate-web', status: 'running' }).select('id').single();
   await client.from('ingestion_runs').update({ status: 'succeeded', detail: { counts: { votes: 4, casts: 200 } } }).eq('id', inserted.data.id);
 
   const result = await runChosenSource(client, chosen, {
@@ -1123,20 +1415,21 @@ test('runChosenSource: a NORMAL successful child (which writes its own row) is N
 
 test('runChosenSource: a windowed source whose ONLY failures are expected tail 404s reads as healthy (I4a), and wroteRows reflects the real counts (I4b) independently', async () => {
   const chosen = {
     key: 'us-congress',
     minIntervalMs: 60 * 60 * 1000,
     lastStartedAtIso: '2026-07-31T10:00:00.000Z',
     resolvable: true,
     scriptPath: 'src/cli/ingest.js',
     cliArgs: ['--source', 'us-congress', '--year', '2026', '--rolls', '284-293'],
     windowMaxKnown: 283,
+    wroteSomething: usCongressWroteSomething, // round 3: what buildRegistry actually attaches
   };
   const client = fakeIngestionRunsClient({ started_at: chosen.lastStartedAtIso, status: 'succeeded', detail: {} });
 
   const failures = Array.from({ length: 10 }, (_, i) => ({ step: `roll ${284 + i}`, message: 'HTTP 404' }));
   const inserted = await client.from('ingestion_runs').insert({ source: 'us-congress', status: 'running' }).select('id').single();
   await client.from('ingestion_runs').update({
     status: 'partial', detail: { counts: { votes: 0, casts: 0, failures: 10 }, failures },
   }).eq('id', inserted.data.id);
 
   const spawnFn = () => ({
