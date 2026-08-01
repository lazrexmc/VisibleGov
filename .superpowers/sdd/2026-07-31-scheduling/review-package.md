# Review package — spend gates + scheduled ingestion (de2bf54..3e12a1e)

## Commits
3e12a1e feat: durable, OS-scheduled ingestion (scripts/scheduled-ingest.js)
41936f0 feat: mechanical spend gates on summarize.js and verify.js

## Stat
 .superpowers/sdd/2026-07-31-scheduling/brief.md | 114 +++++
 docs/SCHEDULED_INGESTION.md                     | 155 +++++++
 package.json                                    |   3 +-
 scripts/scheduled-ingest.js                     | 546 ++++++++++++++++++++++++
 src/cli/summarize.js                            |  34 +-
 src/cli/verify.js                               |  31 ++
 src/lib/errors.js                               |  32 ++
 tests/lib.test.js                               |  51 ++-
 tests/scheduled-ingest.test.js                  | 449 +++++++++++++++++++
 tests/summarize-cli.test.js                     |  23 +-
 tests/verifier.test.js                          |  23 +-
 11 files changed, 1456 insertions(+), 5 deletions(-)

## Full diff (-U10)
diff --git a/.superpowers/sdd/2026-07-31-scheduling/brief.md b/.superpowers/sdd/2026-07-31-scheduling/brief.md
new file mode 100644
index 0000000..c3a2c63
--- /dev/null
+++ b/.superpowers/sdd/2026-07-31-scheduling/brief.md
@@ -0,0 +1,114 @@
+# Task brief — spend gates + scheduled ingestion
+
+Two tasks, **in this order**, as two separate commits. Both approved by Lance 2026-07-31
+("add the spend gate / build the schedule ingestion").
+
+---
+
+## TASK 1 — mechanical spend gates on the two ungated model-calling CLIs
+
+`src/cli/gloss.js` (line ~234), `src/cli/extract-terms.js` and `src/cli/golden.js` (~184) all carry
+a mechanical env gate. **`src/cli/summarize.js` and `src/cli/verify.js` do not** — both default
+`dryRun: false`, both call `getAnthropicClient()` and bill Lance's account, and both are exposed as
+`npm run summarize` / `npm run verify`. This is the unfinished half of CLAUDE.md's own policy
+("Mechanical enforcement exists where possible — extend that pattern to new model-calling tools")
+and it sits against Lance's standing spend hold.
+
+- Add the SAME guard-clause shape `gloss.js` uses (read it and mirror it — do not invent a new
+  pattern, do not refactor the existing ones). Env var names: `SUMMARIZE_RUN_APPROVED` for
+  summarize.js, `VERIFY_RUN_APPROVED` for verify.js.
+- The gate must fire **before any Anthropic client is constructed or any bill is fetched for
+  sending**, and must NOT fire when `--dry-run` is passed (dry runs cost nothing and must stay
+  freely runnable — that is what makes the gate acceptable rather than obstructive).
+- Error message must state, in the gloss.js voice: this run costs real money, Lance requires
+  explicit per-run approval, set `<VAR>=yes` to proceed.
+- Typed error class consistent with the file's existing conventions.
+- TDD: gate blocks a live run; `--dry-run` is unaffected; `<VAR>=yes` permits it. Fake the client —
+  **no live API call in tests, ever.**
+
+---
+
+## TASK 2 — `scripts/scheduled-ingest.js`: real, durable, OS-scheduled ingestion
+
+**The problem it solves.** All recurring ingestion to date has been a bash loop inside a Claude
+Code session — it dies when the session ends and is finite. Lance asked directly whether data stays
+fresh; the honest answer today is no. This is TODO build-queue item 13, flagged a priority
+2026-07-28 and never built.
+
+### Critical design constraint (do not miss this)
+
+The ingest CLIs **do not exit when their ToU cooldown has not elapsed — they SLEEP until it has**
+(`enforceDurableCooldown`, `src/cli/ingest-mo-senate.js:446`; same pattern in ingest-mo-house.js).
+A scheduler that blindly invokes them every N minutes will stack overlapping sleeping processes.
+
+So the scheduler must **decide for itself** what is due:
+- Reuse the EXPORTED `remainingCooldownMs(lastStartedAtIso, minIntervalMs)` — import it, do not
+  reimplement the arithmetic.
+- Query `ingestion_runs` for each source's latest `started_at` (the same durable signal the CLIs
+  use), compute remaining cooldown, and **only invoke a CLI whose cooldown has fully elapsed**.
+- Invoke **at most ONE source per run** — keeps each invocation short and bounded.
+
+### Behavior
+
+Entry: `node --env-file=.env scripts/scheduled-ingest.js [--dry-run] [--only <source>]`
+
+1. **Single-instance lock.** A lock file under `.superpowers/artifacts/` carrying pid + ISO
+   timestamp. If a live lock exists → log "already running", exit 0 (NOT an error: an overlapping
+   tick is normal and must never surface as a scheduler failure). Stale-lock detection: a lock older
+   than a documented max run duration is reclaimed with a logged warning. Always release the lock,
+   including on throw (try/finally).
+2. **Pick the single most-overdue due source**, from this registry — each entry declares its source
+   key, its min interval, and the command to run:
+   - `mo-senate-web` — `src/cli/ingest-mo-senate.js --year <current> --limit 1`,
+     `MO_SENATE_MIN_INTERVAL_MS` (30 min, published ToU)
+   - `mo-house-xml` — `src/cli/ingest-mo-house.js --limit 1`, `MO_HOUSE_MIN_INTERVAL_MS`
+     (30 min, **house.mo.gov's own published terms** — never shorten this)
+   - `us-congress` — the federal roll-call delta (read `src/cli/ingest.js` to find the correct
+     current-Congress invocation; federal votes are the one stream with NO scheduled ingestion
+     today, so new federal votes simply never arrive). Congress.gov's polite limiter already
+     exists; pick a conservative interval (≥1 hour) and comment the reasoning.
+   - `legiscan` — the dataset-hash check. ⛔ **Suspension-level rule:** `dataset_hash` comparison is
+     MANDATORY before any `getDataset` download. `ingest-legiscan.js` already implements this
+     correctly — invoke it, never re-implement the gate. Datasets are weekly; interval ≥24h.
+   **Restriction on mo-house-xml (TODO 31, do not violate):** current-session ingestion ONLY.
+   `mo_house_id` is declared table-wide `unique` (0005) against a current-only roster, so a
+   multi-era/historical House backfill silently misattributes a successor's votes to their
+   predecessor. The scheduler must never pass a historical session/year to the House CLI. State
+   this in a comment at the registry entry.
+3. **Run it as a child process** (`node --env-file=.env <cli> …`), capture stdout/stderr, and record
+   the outcome. A CLI failure is logged and reported, never crashes the scheduler run.
+4. **After a run that actually wrote anything**, invoke `scripts/refresh-aggregates.js` — this is
+   the STANDING PRACTICE from the ledger (every loop batch ends with an aggregate refresh, else the
+   profile charts silently drift behind the vote lists; that drift was a real user-visible defect
+   on 2026-07-31). Skip it when nothing was written.
+5. **Log** to a dated file under `.superpowers/artifacts/scheduler-logs/` (gitignored) AND to
+   stdout: timestamp, which source was chosen and why (or "nothing due"), the CLI's honest counts,
+   and whether aggregates were refreshed. Lance must be able to read one file and know it is alive.
+6. **NEVER call a model.** This script is ingestion only. Add an explicit comment saying so — it is
+   the one automated, unattended thing in the repo, and it must remain incapable of spending money.
+7. `--dry-run`: report what WOULD run and each source's remaining cooldown; take the lock, make zero
+   fetches, zero writes.
+8. Exit code: 0 for success and for "nothing due"/"already running"; non-zero only on a real error,
+   so Task Scheduler's own history is meaningful.
+
+### Registration is LANCE'S step (draft-then-apply)
+
+Do NOT register a scheduled task, and do not run `schtasks`. Registering something that runs forever
+on his machine is his call. Instead produce `docs/SCHEDULED_INGESTION.md` containing:
+- what the scheduler does, what it will never do (no model calls, no ToU violations)
+- the exact `schtasks /create …` command (or Task Scheduler UI steps) to run it every 15 minutes —
+  15 min is deliberately shorter than every source interval so nothing is ever missed while the
+  per-source cooldowns still do the real gating
+- how to verify it is alive (the log file, `npm run status`'s freshness block)
+- how to pause/remove it
+- an explicit note that the MO cadences are published ToU and must not be shortened
+
+Add `npm run schedule:ingest` to package.json.
+
+## Constraints for both tasks
+
+Bare `node --test` from repo root; baseline **1975** stays green. TDD red-first. Typed errors.
+Honest counts. selectAll/pagination discipline for any multi-row read (the 1000-row cap has bitten
+this repo repeatedly). No live API calls and no live DB writes from tests. Commits end with:
+
+Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
diff --git a/docs/SCHEDULED_INGESTION.md b/docs/SCHEDULED_INGESTION.md
new file mode 100644
index 0000000..666d395
--- /dev/null
+++ b/docs/SCHEDULED_INGESTION.md
@@ -0,0 +1,155 @@
+# Scheduled ingestion — `scripts/scheduled-ingest.js`
+
+The first thing in this repo designed to run **unattended, on Lance's machine, forever**, with no
+human watching a single invocation. Everything about its design follows from that one fact. This
+doc is what he needs to register it (his own step — an agent never runs `schtasks`) and to keep an
+eye on it afterward.
+
+## What it does
+
+Each invocation:
+
+1. Takes a single-instance lock (`.superpowers/artifacts/scheduler.lock.json`). If another
+   invocation is already holding it, this one logs `already-running` and exits 0 — that is a
+   **normal**, expected outcome (see cadence below), never a failure.
+2. Checks all four ingestion sources' real due-ness by querying `ingestion_runs` for each one's
+   last `started_at` and comparing against its own minimum interval — the *same* durable,
+   cross-process signal the ingest CLIs' own cooldown check (`enforceDurableCooldown`) already
+   relies on. **It never blindly invokes a CLI.**
+3. Picks the single **most overdue** due source (the one that has gone longest since it last ran)
+   and runs it as a short child process: `node --env-file=.env <cli> --limit 1` (or the equivalent
+   for that source — see the registry table below). At most one source per tick.
+4. If that run actually wrote anything, refreshes the vote aggregates
+   (`scripts/refresh-aggregates.js`) — the same standing practice every ingest batch has always
+   followed, so the profile charts never silently drift behind the vote lists.
+5. Logs one entry — to stdout and to a dated file — recording what it checked, what it chose (or
+   why nothing was due), the CLI's own honest counts, and whether aggregates were refreshed.
+
+## What it will never do
+
+- **Never calls a model.** It imports no Anthropic client, no `lib/summarizer.js`, no
+  `lib/verifier.js` — nothing that can bill Lance's account. It only ever spawns the four
+  ingestion CLIs below and `scripts/refresh-aggregates.js`. This is enforced by the import list,
+  not just a comment; verify by inspection if this file ever changes.
+- **Never violates a published rate limit.** The MO Senate and MO House intervals below are
+  imported directly from the adapters that already encode senate.mo.gov's / house.mo.gov's real
+  published terms — they are **not environment-overridable**, so a typo'd env var cannot shorten
+  them. The two intervals this script chooses itself (us-congress, legiscan) are
+  environment-overridable but mechanically floored at the values below: an override can only make
+  them *more* conservative, never less.
+- **Never runs a MO House historical/multi-era backfill.** `mo_house_id` is a table-wide unique
+  constraint (migration 0005) against the *current* roster only — passing a historical year/session
+  to the House CLI would silently misattribute a successor's votes to their predecessor (TODO item
+  31). The registry entry for `mo-house-xml` passes `--limit 1` only, nothing else, permanently.
+- **Never stacks overlapping processes.** The single-instance lock (step 1 above) and the
+  due-ness check (step 2) both have to agree before anything runs.
+- **Never guesses a LegiScan session id.** If `sessions.legiscan_session_id` isn't on file for the
+  current MO session, the `legiscan` source is reported `resolvable: false` and skipped, with the
+  reason logged — never an "most recent session" heuristic. See *Known gap* below for why.
+
+## ⚠️ The MO cadences are published Terms of Service, not our own caution
+
+`MO_SENATE_MIN_INTERVAL_MS` and `MO_HOUSE_MIN_INTERVAL_MS` (30 minutes each) are
+**senate.mo.gov's and house.mo.gov's own published rate limits**. They are imported verbatim from
+`src/adapters/mo-senate-web.js` / `src/adapters/mo-house-xml.js` — the same constants the ingest
+CLIs' own `enforceDurableCooldown` enforces — and are not exposed as environment variables at all.
+**Do not shorten these**, in this file or anywhere else. house.mo.gov's ToU caps automated pulls at
+once per 30 minutes; that is why the House backfill was never a volume strategy (see
+`docs/DATA_INVENTORY.md`/CHATLOG for "the text unlock").
+
+## The registry
+
+| Source | Command | Interval | Why |
+|---|---|---|---|
+| `mo-senate-web` | `ingest-mo-senate.js --year <current> --limit 1` | 30 min | senate.mo.gov's published terms (imported, not configurable) |
+| `mo-house-xml` | `ingest-mo-house.js --limit 1` | 30 min | house.mo.gov's published terms (imported, not configurable) — **current session only, never `--session`** |
+| `us-congress` | `ingest.js --source us-congress --year <current> --rolls <lo>-<hi>` | ≥1 hour (`US_CONGRESS_MIN_INTERVAL_MS`, default 1h) | Congress.gov has its own polite limiter already; this is our own conservative check-frequency choice. `<lo>-<hi>` is computed each tick from the highest US House roll number already on file — a small forward window past it. Every roll in that window that doesn't exist yet 404s harmlessly (recorded, non-fatal); every roll that already exists is a no-op. This is the one federal stream that had **no** scheduled ingestion before this — new House roll calls simply never arrived. |
+| `legiscan` | `ingest-legiscan.js --session <resolved id>` | ≥24 hours (`LEGISCAN_MIN_INTERVAL_MS`, default 24h) | Datasets refresh weekly (Sunday 5am ET); `ingest-legiscan.js`'s own `dataset_hash` gate (⛔ suspension-level LegiScan rule) makes a same-dataset tick cheap. `<resolved id>` comes from `sessions.legiscan_session_id` for the current MO session — see *Known gap* below if this ever reports `resolvable: false`. |
+
+`US_CONGRESS_MIN_INTERVAL_MS` / `LEGISCAN_MIN_INTERVAL_MS` can be raised via `.env` if Lance ever
+wants these to run less often; any value below the defaults above is silently floored back up to
+them.
+
+## Registering it (Lance's step — never run `schtasks` from an agent)
+
+Run every 15 minutes — deliberately shorter than every source's own interval above, so a tick is
+never more than ~15 minutes late; the per-source cooldowns above do the real gating, not this
+number.
+
+**Command line** (adjust the `node.exe` path if `where node` gives something different; using
+absolute paths throughout means Task Scheduler's working directory doesn't matter):
+
+```
+schtasks /create /tn "VisibleGov Scheduled Ingestion" ^
+  /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-ingest.js" ^
+  /sc minute /mo 15 ^
+  /st 00:00 ^
+  /ru "%USERNAME%" ^
+  /f
+```
+
+- `/sc minute /mo 15` — repeats every 15 minutes, indefinitely (no end date unless you add `/ed`).
+- `/ru "%USERNAME%"` runs it as your own account, only while you're logged on (no password
+  needed). If you want it to run even while logged out, use the Task Scheduler GUI instead
+  (Actions tab → this same command; General tab → "Run whether user is logged on or not," which
+  will prompt for your password once).
+- `/f` overwrites a prior registration with the same name — safe to re-run this command if you
+  ever change the schedule.
+
+**GUI equivalent**, if preferred: Task Scheduler → Create Task → General: name it; Triggers → New →
+"On a schedule" → Daily, repeat task every **15 minutes** for a duration of **Indefinitely**;
+Actions → New → Program: `C:\Program Files\nodejs\node.exe`, Arguments:
+`--env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-ingest.js`, Start in:
+`F:\VisibleGov` (redundant with the absolute `--env-file` path, but harmless to set).
+
+## How to verify it is alive
+
+Two independent signals, on purpose — one from the scheduler's own perspective, one from the data's:
+
+1. **The log file.** `.superpowers/artifacts/scheduler-logs/YYYY-MM-DD.log` (gitignored, one entry
+   per tick). A healthy scheduler shows an entry roughly every 15 minutes, alternating between
+   `nothing-due`, `already-running`, and occasional `live` runs as each source's cooldown elapses.
+   `tail`/open today's file; if the last entry is more than ~20 minutes old, the scheduled task
+   itself has stopped firing (check Task Scheduler's history, not this repo).
+2. **`npm run status`'s freshness block.** Reads `public_freshness` directly from the database —
+   independent of whether the scheduler *ran*, it shows whether data actually *arrived*. If the
+   log looks healthy but freshness doesn't move, something downstream (not the scheduler) is
+   wrong.
+3. Windows Task Scheduler's own History tab for "VisibleGov Scheduled Ingestion" shows exit codes
+   over time — 0 is normal (success, nothing due, or already-running); non-zero is a real error
+   (e.g. `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` missing) and is the one case worth investigating.
+
+Manual checks any time, safe to run for real (read-only, zero writes, zero external fetches):
+
+```
+npm run schedule:ingest -- --dry-run
+npm run schedule:ingest -- --dry-run --only legiscan
+```
+
+## How to pause / remove it
+
+```
+schtasks /change /tn "VisibleGov Scheduled Ingestion" /disable   # pause (keeps the registration)
+schtasks /change /tn "VisibleGov Scheduled Ingestion" /enable    # resume
+schtasks /delete /tn "VisibleGov Scheduled Ingestion" /f         # remove entirely
+```
+
+If the machine ever loses power mid-run, the lock file self-heals: a lock older than 10 minutes
+(`MAX_RUN_DURATION_MS`) is automatically reclaimed on the next tick, with a warning logged. You can
+also delete `.superpowers/artifacts/scheduler.lock.json` by hand at any time if you want a clean
+next tick immediately rather than waiting out the 10 minutes.
+
+## Known gap: `legiscan` may report `resolvable: false`
+
+The scheduler looks up the current MO session's `legiscan_session_id` from the `sessions` table
+(keyed off `ingest-mo-house.js`'s own `DEFAULT_MO_HOUSE_SESSION`) rather than guessing — see
+`resolveLegiscanSessionId`'s own comment in `scripts/scheduled-ingest.js`. As of this writing that
+resolves correctly (session `261` → LegiScan session `2239`). If it ever stops resolving, the
+`legiscan` source is skipped honestly (logged, `resolvable: false`, with a reason) rather than
+guessing — it does not block the other three sources.
+
+Separately, **TODO.md item 25** documents a real, currently-open duplicate-MO-session defect
+(session `'2026'` vs `'261'`) caused by a *different*, non-scheduler source (not `mo-house-xml`,
+whose default session — `261` — is already the correct one). This scheduler's registry does not
+touch whatever is producing that duplicate; it's flagged here only so it isn't mistaken for
+something this script caused.
diff --git a/package.json b/package.json
index e5de763..d2d7b70 100644
--- a/package.json
+++ b/package.json
@@ -14,21 +14,22 @@
     "ingest:legiscan": "node --env-file=.env src/cli/ingest-legiscan.js",
     "enrich:federal-bills": "node --env-file=.env src/cli/enrich-federal-bills.js",
     "summarize": "node --env-file=.env src/cli/summarize.js",
     "verify": "node --env-file=.env src/cli/verify.js",
     "extract-terms": "node --env-file=.env src/cli/extract-terms.js",
     "gloss": "node --env-file=.env src/cli/gloss.js",
     "auto-publish:glossary": "node --env-file=.env src/cli/auto-publish-glossary.js",
     "golden": "node --env-file=.env src/cli/golden.js",
     "link:persons": "node --env-file=.env src/cli/link-persons.js",
     "refresh:aggregates": "node --env-file=.env scripts/refresh-aggregates.js",
-    "review": "node --env-file=.env src/review/server.js"
+    "review": "node --env-file=.env src/review/server.js",
+    "schedule:ingest": "node --env-file=.env scripts/scheduled-ingest.js"
   },
   "dependencies": {
     "@anthropic-ai/sdk": "^0.115.0",
     "@supabase/supabase-js": "^2.45.0",
     "fast-xml-parser": "^4.4.0",
     "pdfjs-dist": "6.1.200",
     "yauzl": "3.4.0"
   },
   "devDependencies": {
     "jsdom": "^29.1.1"
diff --git a/scripts/scheduled-ingest.js b/scripts/scheduled-ingest.js
new file mode 100644
index 0000000..26787bb
--- /dev/null
+++ b/scripts/scheduled-ingest.js
@@ -0,0 +1,546 @@
+// scripts/scheduled-ingest.js — the first unattended, OS-scheduled process in this repo (TODO
+// build-queue item 13). Every prior "recurring" ingestion was a bash loop inside a Claude Code
+// session: it died the moment the session ended, so data staleness was real. This script is meant
+// to be registered with Windows Task Scheduler (registration itself is Lance's own step — see
+// docs/SCHEDULED_INGESTION.md — never run schtasks from an agent) and to run forever, unattended,
+// with no human watching a single invocation. That changes the design bar entirely:
+//
+//   - NEVER CALLS A MODEL. This file imports no Anthropic client, no lib/summarizer.js, no
+//     lib/verifier.js — nothing that can bill Lance's account. It only ever spawns the four
+//     read-mostly ingestion CLIs below plus scripts/refresh-aggregates.js. This comment, and the
+//     import list actually enforcing it, are the whole guarantee — verify by inspection any time
+//     this file changes.
+//   - INCAPABLE OF VIOLATING A PUBLISHED RATE LIMIT. The two MO cadences (MO_SENATE_MIN_INTERVAL_MS,
+//     MO_HOUSE_MIN_INTERVAL_MS) are imported verbatim from the adapters that already encode
+//     senate.mo.gov's/house.mo.gov's real published terms — never redefined here, never
+//     env-overridable, so a typo'd environment variable cannot shorten them. The two intervals
+//     this script DOES get to choose (us-congress, legiscan) are env-overridable but mechanically
+//     floored at the brief's own conservative minimum (envIntervalMs) — configurable upward only.
+//   - INCAPABLE OF STACKING OVERLAPPING PROCESSES. A single-instance lock file
+//     (.superpowers/artifacts/scheduler.lock.json) is required before anything else happens; a
+//     live lock means "already running," logged and exited 0 — an overlapping tick is expected
+//     (Task Scheduler is recommended at a 15-min cadence, shorter than every source's own
+//     interval, see docs/SCHEDULED_INGESTION.md) and must never read as a scheduler failure.
+//   - The CRITICAL constraint from the brief: the ingest CLIs do not exit when their ToU cooldown
+//     hasn't elapsed — they SLEEP until it has (enforceDurableCooldown, ingest-mo-senate.js:446;
+//     same pattern in ingest-mo-house.js). A scheduler that blindly invoked them every tick would
+//     stack sleeping processes. So THIS script decides due-ness itself, BEFORE ever launching a
+//     child, by importing the exported remainingCooldownMs and querying ingestion_runs directly —
+//     the same durable, cross-process signal the CLIs' own enforceDurableCooldown reads. A CLI is
+//     only ever launched once its own cooldown has fully elapsed; in normal operation the child's
+//     own enforceDurableCooldown check should therefore always see remaining<=0 immediately and
+//     never actually sleep.
+//   - Leaves an honest, dated log a human can read to confirm it is alive (see writeLog / npm run
+//     status's freshness block).
+//
+// Entry: node --env-file=.env scripts/scheduled-ingest.js [--dry-run] [--only <source>]
+
+import { spawnSync } from 'node:child_process';
+import {
+  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync,
+} from 'node:fs';
+import path from 'node:path';
+import { fileURLToPath } from 'node:url';
+
+import { getClient, selectAll } from '../src/lib/db.js';
+// Reused, not reimplemented (brief's own explicit instruction): the exact arithmetic every ingest
+// CLI's own enforceDurableCooldown already relies on. Both ingest-mo-senate.js and
+// ingest-mo-house.js export an identical copy (the latter ported from the former, see that file's
+// own comment) — either is a correct, generic (lastStartedAtIso, minIntervalMs, now) function, not
+// specific to MO Senate; imported once here and reused for all four registry sources.
+import { remainingCooldownMs, formatCooldownWait } from '../src/cli/ingest-mo-senate.js';
+import { MO_SENATE_MIN_INTERVAL_MS } from '../src/adapters/mo-senate-web.js';
+import { MO_HOUSE_MIN_INTERVAL_MS, DEFAULT_MO_HOUSE_SESSION } from '../src/adapters/mo-house-xml.js';
+
+const __dirname = path.dirname(fileURLToPath(import.meta.url));
+// Computed from this file's own location, NEVER from process.cwd() — Task Scheduler's default
+// working directory is not guaranteed to be the repo root (docs/SCHEDULED_INGESTION.md recommends
+// setting "Start in" anyway, but this script does not depend on it either way).
+export const REPO_ROOT = path.join(__dirname, '..');
+const ARTIFACTS_DIR = path.join(REPO_ROOT, '.superpowers', 'artifacts');
+const LOCK_PATH = path.join(ARTIFACTS_DIR, 'scheduler.lock.json');
+const LOG_DIR = path.join(ARTIFACTS_DIR, 'scheduler-logs');
+
+// Stale-lock reclaim threshold. A normal invocation is one child CLI at --limit 1 (cooldown
+// already confirmed elapsed by this script, so the child's own enforceDurableCooldown should not
+// actually sleep) plus, sometimes, one refresh-aggregates.js call — realistically seconds, well
+// under a minute. 10 minutes is a generous ceiling for slow network/retries while staying safely
+// below the 15-minute recommended Task Scheduler tick, so a genuinely crashed/killed prior run
+// cannot wedge the schedule for more than one missed tick.
+export const MAX_RUN_DURATION_MS = 10 * 60 * 1000;
+
+const ONE_HOUR_MS = 60 * 60 * 1000;
+const ONE_DAY_MS = 24 * ONE_HOUR_MS;
+
+// envIntervalMs: the mechanical floor behind US_CONGRESS_MIN_INTERVAL_MS/LEGISCAN_MIN_INTERVAL_MS
+// below — these two intervals are OUR OWN conservative policy choice (Congress.gov and LegiScan
+// publish no per-request cadence the way house.mo.gov/senate.mo.gov do), so, unlike the two MO
+// constants above, they are env-overridable. But an override can only raise the interval, never
+// lower it below the floor the brief itself specifies (>=1h / >=24h) — a bad or typo'd env value
+// can only make this script MORE conservative, never less.
+export function envIntervalMs(envVar, defaultMs, floorMs) {
+  const raw = Number(process.env[envVar]);
+  const configured = Number.isFinite(raw) && raw > 0 ? raw : defaultMs;
+  return Math.max(configured, floorMs);
+}
+
+// us-congress: no published rate limit exists to violate (Congress.gov's own polite limiter is
+// already enforced inside src/adapters/us-congress.js's congressLimiter) — >=1h is this script's
+// own conservative choice, since new House roll calls arrive on a legislative-day cadence, not
+// continuously; there is no benefit to checking more often than that.
+export const US_CONGRESS_MIN_INTERVAL_MS = envIntervalMs('US_CONGRESS_MIN_INTERVAL_MS', ONE_HOUR_MS, ONE_HOUR_MS);
+// legiscan: datasets refresh weekly (Sunday 5am ET per docs/research/2026-07-28-legiscan-terms.md)
+// — >=24h is deliberately far more frequent than strictly necessary, still cheap because
+// ingest-legiscan.js's own dataset_hash gate (⛔ suspension-level rule, decodeDatasetHashGate)
+// makes a same-dataset invocation a single cheap list-check, not a real download.
+export const LEGISCAN_MIN_INTERVAL_MS = envIntervalMs('LEGISCAN_MIN_INTERVAL_MS', ONE_DAY_MS, ONE_DAY_MS);
+
+// Matches the hardcoded convention already used throughout this repo (ingest.js,
+// backfill-federal-names.js, enrich-federal-bills.js all hardcode 119) — no dynamic
+// "current congress" formula exists anywhere in this codebase; update all four together when the
+// 120th Congress convenes.
+export const US_CONGRESS_CONGRESS = 119;
+// Small, conservative forward-delta window past the highest roll number already on file — see
+// resolveUsCongressRollWindow's own comment for why this is safe to overlap/overshoot.
+export const US_CONGRESS_ROLL_WINDOW = 10;
+
+const SOURCE_KEYS = ['mo-senate-web', 'mo-house-xml', 'us-congress', 'legiscan'];
+
+// ---- pure: args ----
+
+export function parseArgs(argv) {
+  const out = { dryRun: false, only: null };
+  let i = 0;
+  while (i < argv.length) {
+    const key = argv[i];
+    if (key === '--dry-run') {
+      out.dryRun = true;
+      i += 1;
+      continue;
+    }
+    if (key === '--only') {
+      out.only = argv[i + 1];
+      if (!SOURCE_KEYS.includes(out.only)) {
+        throw new Error(`unknown source: ${out.only} (expected one of ${SOURCE_KEYS.join(', ')})`);
+      }
+      i += 2;
+      continue;
+    }
+    throw new Error(`unknown flag: ${key}`);
+  }
+  return out;
+}
+
+// ---- pure: single-instance lock ----
+
+export function isLockStale(lock, nowMs, maxRunDurationMs = MAX_RUN_DURATION_MS) {
+  const startedMs = Date.parse(lock.startedAt);
+  if (!Number.isFinite(startedMs)) return true; // unparseable timestamp — never trusted, treated as stale
+  return nowMs - startedMs > maxRunDurationMs;
+}
+
+// acquireLock: an atomic create ('wx' — fails with EEXIST if the file already exists) is tried
+// first, closing the check-then-act race a plain existsSync()-then-writeFileSync() pair would
+// leave open between two schedulers starting within milliseconds of each other. Unlikely at a
+// 15-minute tick cadence, but free to close. Falls back to reading the existing lock only on
+// EEXIST; a corrupt/unreadable lock is treated exactly like a stale one (reclaimed + the caller
+// logs a warning) rather than either trusting it blindly or crashing — a half-written lock from a
+// killed process must not permanently wedge every future tick.
+export function acquireLock(lockPath = LOCK_PATH, { now = Date.now(), maxRunDurationMs = MAX_RUN_DURATION_MS } = {}) {
+  mkdirSync(path.dirname(lockPath), { recursive: true });
+  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() }, null, 2);
+
+  try {
+    writeFileSync(lockPath, payload, { flag: 'wx' });
+    return { acquired: true, reason: 'fresh' };
+  } catch (err) {
+    if (err.code !== 'EEXIST') throw err;
+  }
+
+  let existing;
+  try {
+    existing = JSON.parse(readFileSync(lockPath, 'utf8'));
+  } catch {
+    existing = { startedAt: new Date(0).toISOString(), pid: null, corrupt: true };
+  }
+  if (!isLockStale(existing, now, maxRunDurationMs)) {
+    return { acquired: false, reason: 'already-running', lock: existing };
+  }
+  // Stale: a plain overwrite is fine here — the prior owner is already established to be long
+  // past any plausible run duration, so losing a 'wx'-style race at this exact point is not a
+  // realistic concern.
+  writeFileSync(lockPath, payload);
+  return { acquired: true, reason: 'reclaimed-stale', staleLock: existing };
+}
+
+export function releaseLock(lockPath = LOCK_PATH) {
+  if (existsSync(lockPath)) unlinkSync(lockPath);
+}
+
+// ---- pure: due-ness + selection ----
+
+// computeSourceDueness: remainingMs comes straight from the shared, imported remainingCooldownMs
+// — never reimplemented. elapsedMs (Infinity for a source with no prior run at all) is the
+// separate "how overdue" ranking signal pickMostOverdue uses below; remainingMs alone cannot rank
+// two already-due sources against each other since Math.max(0, ...) clamps both to 0.
+export function computeSourceDueness(entry, now) {
+  const remainingMs = remainingCooldownMs(entry.lastStartedAtIso, entry.minIntervalMs, now);
+  const elapsedMs = entry.lastStartedAtIso ? now - Date.parse(entry.lastStartedAtIso) : Infinity;
+  return {
+    ...entry, remainingMs, elapsedMs, due: remainingMs <= 0,
+  };
+}
+
+// pickMostOverdue: among due AND resolvable entries (legiscan with no legiscan_session_id on file
+// is due but never resolvable — see buildRegistry), the one that has gone longest since its last
+// (or ever) run wins. A source with zero prior runs (elapsedMs=Infinity) outranks everything else
+// — seeding an unseen source is the most urgent thing to do. Ties keep registry order (reduce
+// never replaces `best` on an equal elapsedMs).
+export function pickMostOverdue(entries) {
+  const candidates = entries.filter((e) => e.due && e.resolvable);
+  if (candidates.length === 0) return null;
+  return candidates.reduce((best, e) => (e.elapsedMs > best.elapsedMs ? e : best));
+}
+
+// ---- pure: us-congress roll-delta window ----
+
+const US_HOUSE_ROLL_RE = /^us-house-\d+-\d+-(\d+)$/;
+
+export function parseUsHouseRoll(sourceKey) {
+  const m = US_HOUSE_ROLL_RE.exec(String(sourceKey ?? ''));
+  return m ? Number(m[1]) : null;
+}
+
+export function computeRollWindow(maxKnownRoll, windowSize = US_CONGRESS_ROLL_WINDOW) {
+  const base = Number.isFinite(maxKnownRoll) && maxKnownRoll > 0 ? maxKnownRoll : 0;
+  return { lo: base + 1, hi: base + windowSize };
+}
+
+// ---- pure: child-CLI output ----
+
+export function parseChildOutput(stdout) {
+  try {
+    return { parsed: JSON.parse(String(stdout ?? '').trim()), parseError: null };
+  } catch (err) {
+    return { parsed: null, parseError: err.message };
+  }
+}
+
+// runWroteSomething: deliberately generous, not a byte-exact "were rows actually inserted" oracle
+// — the four registry CLIs' count shapes are heterogeneous (mo-senate/mo-house's document-shaped
+// counts vs. us-congress's legislators/bills/votes/casts vs. legiscan's own), so this reads the one
+// field every one of them shares (mode/status, the same repo-wide main() convention every CLI in
+// this codebase follows). A 'live' run that reached succeeded/partial opened and closed a real
+// ingestion_runs row — it genuinely attempted writes, even on a tick where every upsert happened to
+// be a no-op. Treating that as "wrote something" means the aggregate refresh below sometimes runs
+// when nothing actually changed (cheap, idempotent SQL) rather than risk the opposite: skipping a
+// refresh that WAS needed, which is the exact user-visible chart-drift defect from 2026-07-31 that
+// refresh-aggregates.js's own header describes this standing practice as preventing.
+export function runWroteSomething(parsedOutput) {
+  if (!parsedOutput || parsedOutput.mode !== 'live') return false;
+  return parsedOutput.status === 'succeeded' || parsedOutput.status === 'partial';
+}
+
+// ---- DB-facing helpers ----
+
+export async function queryLatestStartedAt(client, source) {
+  const { data, error } = await client
+    .from('ingestion_runs')
+    .select('started_at')
+    .eq('source', source)
+    .order('started_at', { ascending: false })
+    .limit(1)
+    .maybeSingle();
+  if (error) throw new Error(`ingestion_runs lookup failed for source=${source}: ${error.message}`);
+  return data ? data.started_at : null;
+}
+
+// resolveLegiscanSessionId: reuses mo-house-xml.js's OWN DEFAULT_MO_HOUSE_SESSION as "the current
+// MO session identifier" — never a second, separately-maintained notion of "current" — and looks
+// up that session's legiscan_session_id column directly by key. Returns null (never a guess, never
+// an ORDER BY/"most recent" heuristic over `sessions`) when that row or its legiscan_session_id
+// doesn't exist yet. TODO.md item 25 documents a real, currently-open duplicate-MO-session defect
+// in this exact area of the data model; guessing here is exactly the kind of thing that could make
+// it worse. The registry (below) treats a null result as "not configured" and skips legiscan
+// honestly rather than risk feeding that defect a second way.
+export async function resolveLegiscanSessionId(client) {
+  const { data, error } = await client
+    .from('sessions')
+    .select('legiscan_session_id')
+    .eq('jurisdiction_id', 'mo-legislature')
+    .eq('identifier', DEFAULT_MO_HOUSE_SESSION)
+    .maybeSingle();
+  if (error) throw new Error(`sessions lookup failed for legiscan_session_id: ${error.message}`);
+  return data && data.legiscan_session_id != null ? data.legiscan_session_id : null;
+}
+
+// resolveUsCongressRollWindow: src/cli/ingest.js has no built-in delta mode (--rolls is a
+// caller-chosen explicit range) and this source has never had scheduled ingestion (brief) — this
+// is the scheduler's own minimal, honest "what's new" computation: the highest US House roll
+// number already on file for this congress+year, plus a small forward window. Every candidate roll
+// in that window that doesn't exist yet simply 404s inside collectUsCongress (a typed, non-fatal
+// SourceFetchError recorded in failures[] — see ingest.js's own per-roll try/catch) and every roll
+// that already exists is a harmless insertIfAbsent no-op (votes.source_key is the conflict key) —
+// so overlapping an already-ingested roll, or probing one that hasn't happened yet, is always
+// safe, just occasionally wasted requests against Congress.gov's own already-polite limiter.
+// Routed through selectAll (project law: no bare .select() on a multi-row table — this table is
+// already ~10,000+ rows overall, well past Supabase's 1000-row cap, even though this query's own
+// WHERE clause keeps any single congress+year's result set small).
+export async function resolveUsCongressRollWindow(client, {
+  congress = US_CONGRESS_CONGRESS, year, windowSize = US_CONGRESS_ROLL_WINDOW,
+} = {}) {
+  const prefix = `us-house-${congress}-${year}-`;
+  const { data, error } = await selectAll(client, 'votes', 'source_key', {
+    filter: (q) => q.eq('jurisdiction_id', 'us-congress').like('source_key', `${prefix}%`),
+  });
+  if (error) throw new Error(`votes lookup failed for us-congress roll window: ${error.message}`);
+  const maxRoll = (data ?? [])
+    .map((r) => parseUsHouseRoll(r.source_key))
+    .filter((n) => n !== null)
+    .reduce((max, n) => Math.max(max, n), 0);
+  return computeRollWindow(maxRoll, windowSize);
+}
+
+// ---- registry ----
+//
+// Each entry: { key, minIntervalMs, lastStartedAtIso, resolvable, unresolvedReason, scriptPath,
+// cliArgs }. scriptPath is repo-root-relative, matching every "node --env-file=.env <path>" npm
+// script already in package.json.
+export async function buildRegistry(client, { now = Date.now(), year = new Date(now).getFullYear() } = {}) {
+  const [moSenateLast, moHouseLast, usCongressLast, legiscanLast, legiscanSessionId, rollWindow] = await Promise.all([
+    queryLatestStartedAt(client, 'mo-senate-web'),
+    queryLatestStartedAt(client, 'mo-house-xml'),
+    queryLatestStartedAt(client, 'us-congress'),
+    queryLatestStartedAt(client, 'legiscan'),
+    resolveLegiscanSessionId(client),
+    resolveUsCongressRollWindow(client, { year }),
+  ]);
+
+  return [
+    {
+      key: 'mo-senate-web',
+      minIntervalMs: MO_SENATE_MIN_INTERVAL_MS,
+      lastStartedAtIso: moSenateLast,
+      resolvable: true,
+      unresolvedReason: null,
+      scriptPath: 'src/cli/ingest-mo-senate.js',
+      cliArgs: ['--year', String(year), '--limit', '1'],
+    },
+    {
+      key: 'mo-house-xml',
+      minIntervalMs: MO_HOUSE_MIN_INTERVAL_MS,
+      lastStartedAtIso: moHouseLast,
+      resolvable: true,
+      unresolvedReason: null,
+      scriptPath: 'src/cli/ingest-mo-house.js',
+      // RESTRICTION (TODO 31 — do not violate): current-session ingestion ONLY. mo_house_id is
+      // declared table-wide `unique` (migration 0005) against a current-only roster, so a
+      // historical/multi-era backfill would silently misattribute a successor's votes to their
+      // predecessor. NEVER add --session (or any year/era flag) here — --limit 1 alone lets the
+      // CLI fall through to its own DEFAULT_MO_HOUSE_SESSION, which is the current session.
+      cliArgs: ['--limit', '1'],
+    },
+    {
+      key: 'us-congress',
+      minIntervalMs: US_CONGRESS_MIN_INTERVAL_MS,
+      lastStartedAtIso: usCongressLast,
+      resolvable: true,
+      unresolvedReason: null,
+      scriptPath: 'src/cli/ingest.js',
+      cliArgs: ['--source', 'us-congress', '--year', String(year), '--rolls', `${rollWindow.lo}-${rollWindow.hi}`],
+    },
+    {
+      key: 'legiscan',
+      minIntervalMs: LEGISCAN_MIN_INTERVAL_MS,
+      lastStartedAtIso: legiscanLast,
+      resolvable: legiscanSessionId != null,
+      unresolvedReason: legiscanSessionId != null
+        ? null
+        : `no legiscan_session_id on file for MO session '${DEFAULT_MO_HOUSE_SESSION}' (sessions.legiscan_session_id) — `
+          + 'see TODO.md item 25; not guessed, skipped honestly until resolved',
+      scriptPath: 'src/cli/ingest-legiscan.js',
+      // ⛔ dataset_hash comparison happens INSIDE ingest-legiscan.js (decodeDatasetHashGate) —
+      // never re-implemented here. This registry entry only ever supplies --session; the
+      // suspension-level gate itself is entirely the CLI's own responsibility, invoked, not
+      // reimplemented.
+      cliArgs: legiscanSessionId != null ? ['--session', String(legiscanSessionId)] : [],
+    },
+  ];
+}
+
+// ---- process orchestration ----
+
+function defaultSpawn(command, args, options) {
+  return spawnSync(command, args, { encoding: 'utf8', ...options });
+}
+
+// runChildCli: every ingestion CLI in this repo (and refresh-aggregates.js) speaks the same "API"
+// — one console.log(JSON.stringify(...)) as its terminal line to stdout, progress on stderr, the
+// same repo-wide main() convention verified across all four registry sources. No CLI in this repo
+// exports its main() (checked before writing this file), so a child process — not an in-process
+// import — is the only way to invoke one. spawnFn is injectable so tests never launch a real
+// subprocess against real network/DB state; the real default really does spawn `node
+// --env-file=.env <scriptPath> ...cliArgs`, matching every "node --env-file=.env ..." npm script.
+export function runChildCli(scriptPath, cliArgs, { cwd = REPO_ROOT, spawnFn = defaultSpawn } = {}) {
+  const result = spawnFn(process.execPath, ['--env-file=.env', scriptPath, ...cliArgs], { cwd });
+  if (result.error) {
+    // The child could not even be launched (e.g. a bad path) — unlike a child that launched and
+    // reported its own typed failures, this IS a real scheduler-level error.
+    throw new Error(`could not launch ${scriptPath}: ${result.error.message}`);
+  }
+  const { parsed, parseError } = parseChildOutput(result.stdout);
+  return {
+    scriptPath, cliArgs, exitStatus: result.status, stdout: result.stdout, stderr: result.stderr, parsed, parseError,
+  };
+}
+
+// ---- logging ----
+
+function nowIso() {
+  return new Date().toISOString();
+}
+
+// writeLog: appends the SAME pretty-printed JSON this script prints to stdout into a dated file
+// under .superpowers/artifacts/scheduler-logs/ (gitignored, matches the existing cached-artifact
+// subdirectory convention) — "Lance must be able to read one file and know it is alive" (brief).
+// One entry per invocation; every branch of main() below funnels through this single function so
+// the file and stdout can never drift out of sync with each other.
+function writeLog(entry) {
+  mkdirSync(LOG_DIR, { recursive: true });
+  const day = entry.timestamp.slice(0, 10); // YYYY-MM-DD
+  const logPath = path.join(LOG_DIR, `${day}.log`);
+  const block = `=== ${entry.timestamp} ===\n${JSON.stringify(entry, null, 2)}\n\n`;
+  appendFileSync(logPath, block);
+  console.log(JSON.stringify(entry, null, 2));
+}
+
+// ---- main ----
+
+async function main() {
+  const args = parseArgs(process.argv.slice(2));
+  const now = Date.now();
+
+  const lockResult = acquireLock(LOCK_PATH, { now });
+  if (!lockResult.acquired) {
+    // NOT an error — an overlapping tick is normal (Task Scheduler's 15-min cadence is shorter
+    // than every source's own interval by design) and must never surface as a scheduler failure.
+    writeLog({
+      timestamp: nowIso(),
+      mode: 'already-running',
+      note: `a live lock (pid ${lockResult.lock.pid}, started ${lockResult.lock.startedAt}) already exists — skipping this tick`,
+    });
+    return;
+  }
+
+  const lockReclaimed = lockResult.reason === 'reclaimed-stale' ? lockResult.staleLock : null;
+  if (lockReclaimed) {
+    console.error(
+      `[${nowIso()}] WARNING: reclaimed a stale lock (pid ${lockReclaimed.pid}, started `
+        + `${lockReclaimed.startedAt}, older than ${formatCooldownWait(MAX_RUN_DURATION_MS)}) — a prior run may have crashed without releasing it`,
+    );
+  }
+
+  try {
+    const client = getClient();
+    if (!client) {
+      writeLog({
+        timestamp: nowIso(),
+        mode: 'blocked',
+        reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — cannot compute source due-ness without reading ingestion_runs',
+        lockReclaimed,
+      });
+      process.exitCode = 1;
+      return;
+    }
+
+    const year = new Date(now).getFullYear();
+    const registry = await buildRegistry(client, { now, year });
+    const scoped = args.only ? registry.filter((e) => e.key === args.only) : registry;
+    const withDueness = scoped.map((e) => computeSourceDueness(e, now));
+    const chosen = pickMostOverdue(withDueness);
+
+    const sourcesSummary = withDueness.map((e) => ({
+      key: e.key,
+      due: e.due,
+      remainingMs: e.remainingMs,
+      remainingHuman: e.remainingMs > 0 ? formatCooldownWait(e.remainingMs) : '0s',
+      resolvable: e.resolvable,
+      unresolvedReason: e.unresolvedReason,
+      lastStartedAt: e.lastStartedAtIso,
+    }));
+
+    if (!chosen) {
+      writeLog({
+        timestamp: nowIso(),
+        mode: 'nothing-due',
+        chosen: null,
+        reason: args.only ? `'${args.only}' is not due yet (or not configured)` : 'no registry source is currently due',
+        sources: sourcesSummary,
+        lockReclaimed,
+      });
+      return;
+    }
+
+    const reason = `most overdue due source (elapsed ${chosen.elapsedMs === Infinity ? 'never run' : formatCooldownWait(chosen.elapsedMs)}, `
+      + `min interval ${formatCooldownWait(chosen.minIntervalMs)})`;
+
+    if (args.dryRun) {
+      writeLog({
+        timestamp: nowIso(),
+        mode: 'dry-run',
+        chosen: chosen.key,
+        reason,
+        wouldRun: { scriptPath: chosen.scriptPath, cliArgs: chosen.cliArgs },
+        sources: sourcesSummary,
+        note: 'zero fetches, zero writes — --dry-run',
+        lockReclaimed,
+      });
+      return;
+    }
+
+    const childResult = runChildCli(chosen.scriptPath, chosen.cliArgs);
+    const wroteSomething = runWroteSomething(childResult.parsed);
+
+    // Standing practice from the ledger (brief): every ingest batch ends with an aggregate
+    // refresh, else public_position_totals/public_party_alignment silently drift behind the vote
+    // lists — a real user-visible defect on 2026-07-31. Skipped only when nothing was written
+    // (runWroteSomething), and its own outcome NEVER overrides the primary ingest run's already-
+    // recorded result below, mirroring summarize.js's persistReferencedTermsGracefully: a
+    // secondary, best-effort follow-up must never make an otherwise-successful tick look failed.
+    let aggregatesResult = null;
+    if (wroteSomething) {
+      const refreshResult = runChildCli('scripts/refresh-aggregates.js', []);
+      aggregatesResult = {
+        exitStatus: refreshResult.exitStatus, parsed: refreshResult.parsed, parseError: refreshResult.parseError,
+      };
+    }
+
+    writeLog({
+      timestamp: nowIso(),
+      mode: 'live',
+      chosen: chosen.key,
+      reason,
+      result: {
+        exitStatus: childResult.exitStatus,
+        mode: childResult.parsed?.mode ?? null,
+        status: childResult.parsed?.status ?? null,
+        counts: childResult.parsed?.counts ?? null,
+        failures: childResult.parsed?.failures ?? null,
+        parseError: childResult.parseError,
+      },
+      aggregatesRefreshed: wroteSomething,
+      aggregatesResult,
+      sources: sourcesSummary,
+      lockReclaimed,
+    });
+  } finally {
+    // Always released, including on throw — an overlapping tick after a genuine crash would
+    // otherwise be permanently blocked until MAX_RUN_DURATION_MS's stale-reclaim kicks in.
+    releaseLock(LOCK_PATH);
+  }
+}
+
+const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
+if (invokedDirectly) {
+  main().catch((err) => { console.error(err); process.exitCode = 1; });
+}
diff --git a/src/cli/summarize.js b/src/cli/summarize.js
index 93d6597..30cfaca 100644
--- a/src/cli/summarize.js
+++ b/src/cli/summarize.js
@@ -1,12 +1,12 @@
 import { getClient, openRun, closeRun, insertIfAbsent, isMissingRelationError } from '../lib/db.js';
-import { SourceFetchError } from '../lib/errors.js';
+import { SourceFetchError, assertRunApproved, RunNotApprovedError } from '../lib/errors.js';
 import { billTypeSlug } from '../adapters/us-congress.js';
 import { parseTextVersions, pickTextUrl, stripHtml, sha256, fetchBillTextVersions, fetchTextBody } from '../adapters/us-congress-text.js';
 import {
   getAnthropicClient, summarizeBill, MODEL, PROMPT_VERSION,
   OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
 } from '../lib/summarizer.js';
 import {
   persistReferencedTerms, GLOSSARY_TERMS_TABLE, SUMMARY_TERMS_TABLE,
 } from '../lib/glossary-terms.js';
 
@@ -242,20 +242,36 @@ export async function createDraftSummary(client, runId, { bill, textRow, anthrop
   // above (near-zero added cost, per the design doc's own "rides in the same call" framing), so
   // realize that design instead of letting them go straight to the floor and requiring a second,
   // separately-billed extract-terms.js pass to rediscover them later.
   return persistReferencedTermsGracefully(client, runId, { bill, summaryId: data.id, referencedTerms: json.referenced_terms ?? [] });
 }
 
 function isTypedFailure(err) {
   return FAILURE_TYPES.some((T) => err instanceof T);
 }
 
+// checkSummarizeApproval (task 1, 2026-07-31): the mechanical per-run spend gate summarize.js
+// lacked — this file bills Lance's Anthropic account (bill summary authoring) and previously ran
+// with no gate at all, against the owner's standing spend hold and against CLAUDE.md's own stated
+// policy ("Mechanical enforcement exists where possible — extend that pattern to new
+// model-calling tools"). Thin, exported wrapper around the shared assertRunApproved (lib/errors.js)
+// so this exact wiring — env var name, action wording — is directly testable without needing a
+// fake DB/Anthropic client at all. See main() below for the call site: fires after the --dry-run
+// branch has already returned and before getAnthropicClient() is called, so it blocks before any
+// Anthropic client is constructed and before any bill text is fetched for sending (ensureText/
+// createDraftSummary only run further down, inside the try block).
+export function checkSummarizeApproval(envValue) {
+  assertRunApproved(envValue, {
+    envVar: 'SUMMARIZE_RUN_APPROVED', action: 'summarizing', detail: 'bill summary authoring',
+  });
+}
+
 // ---- main ----
 
 async function main() {
   const args = parseArgs(process.argv.slice(2));
   const client = getClient();
   if (!client) {
     console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
     process.exitCode = 1;
     return;
   }
@@ -268,20 +284,36 @@ async function main() {
     console.log(JSON.stringify({
       mode: 'dry-run',
       counts: { bills: bills.length, needText: plan.needText.length, needSummary: plan.needSummary.length, stale: plan.stale.length },
       needText: plan.needText.map((b) => b.identifier),
       needSummary: plan.needSummary.map((b) => b.identifier),
       stale: plan.stale.map((s) => s.bill_id),
     }, null, 2));
     return;
   }
 
+  // Mechanical per-run approval gate (task 1) — same standing policy as GLOSS_RUN_APPROVED in
+  // gloss.js/extract-terms.js and GOLDEN_CHECK_APPROVED in golden.js: no live, billed Anthropic
+  // call runs without Lance's explicit per-run opt-in. Caught locally (not left to propagate to
+  // main().catch below) so the CLI prints the same clean single BLOCKED line gloss.js does,
+  // never a raw stack trace.
+  try {
+    checkSummarizeApproval(process.env.SUMMARIZE_RUN_APPROVED);
+  } catch (err) {
+    if (err instanceof RunNotApprovedError) {
+      console.log(err.message);
+      process.exitCode = 1;
+      return;
+    }
+    throw err;
+  }
+
   const anthropic = getAnthropicClient();
   if (!anthropic) {
     console.log(JSON.stringify({ mode: 'blocked', reason: 'ANTHROPIC_API_KEY not set' }, null, 2));
     process.exitCode = 1;
     return;
   }
 
   const runId = await openRun(client, 'summarize');
   const failures = [];
   try {
diff --git a/src/cli/verify.js b/src/cli/verify.js
index 9166e36..ce7ca34 100644
--- a/src/cli/verify.js
+++ b/src/cli/verify.js
@@ -1,11 +1,12 @@
 import { getClient, openRun, closeRun, isMissingRelationError } from '../lib/db.js';
+import { assertRunApproved, RunNotApprovedError } from '../lib/errors.js';
 import { pickBillText } from '../review/server.js';
 import {
   getAnthropicClient, MAX_TEXT_CHARS,
   OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
 } from '../lib/summarizer.js';
 import {
   verifyBill, VERIFIER_MODEL, VERIFY_PROMPT_VERSION, assessVerdicts, VerificationIncompleteError,
 } from '../lib/verifier.js';
 import { parseBullets } from '../../site/js/summary-parse.js';
 
@@ -56,20 +57,34 @@ export function checkBulletCoverage(identifier, bodyMd, bullets) {
 }
 
 // isMissingRelationError itself now lives in ../lib/db.js (shared with the review server — see
 // that module for why). In --dry-run mode a missing table is tolerated (controller ruling #3);
 // in live mode it is deliberately NOT caught anywhere — it's a gate.
 
 function isTypedFailure(err) {
   return FAILURE_TYPES.some((T) => err instanceof T);
 }
 
+// checkVerifyApproval (task 1, 2026-07-31): the mechanical per-run spend gate verify.js lacked —
+// this file bills Lance's Anthropic account (adversarial summary verification) and previously ran
+// with no gate at all, against the owner's standing spend hold and against CLAUDE.md's own stated
+// policy ("Mechanical enforcement exists where possible — extend that pattern to new
+// model-calling tools"). Thin, exported wrapper around the shared assertRunApproved (lib/errors.js)
+// so this exact wiring — env var name, action wording — is directly testable without needing a
+// fake DB/Anthropic client at all. See main() below for the call site: fires after the --dry-run
+// branch has already returned and before getAnthropicClient() is called.
+export function checkVerifyApproval(envValue) {
+  assertRunApproved(envValue, {
+    envVar: 'VERIFY_RUN_APPROVED', action: 'verification', detail: 'adversarial summary verification',
+  });
+}
+
 // ---- DB-facing helpers ----
 
 async function loadCandidateSummaries(client) {
   const { data, error } = await client
     .from('summaries')
     .select('id,bill_id,status,body_md,bill_text_hash,created_at,bills(identifier,title)')
     .in('status', TARGET_STATUSES)
     .order('created_at', { ascending: true });
   if (error) throw new Error(`summaries lookup failed: ${error.message}`);
   return data ?? [];
@@ -143,20 +158,36 @@ async function main() {
     const out = {
       mode: 'dry-run',
       counts: { candidates: summaries.length, unverified: unverified.length },
       unverified: unverified.map((s) => ({ id: s.id, status: s.status, identifier: s.bills ? s.bills.identifier : null })),
     };
     if (tableMissing) out.note = '(summary_verifications missing — 0004 not applied; treating all as unverified)';
     console.log(JSON.stringify(out, null, 2));
     return;
   }
 
+  // Mechanical per-run approval gate (task 1) — same standing policy as GLOSS_RUN_APPROVED in
+  // gloss.js/extract-terms.js and GOLDEN_CHECK_APPROVED in golden.js: no live, billed Anthropic
+  // call runs without Lance's explicit per-run opt-in. Caught locally (not left to propagate to
+  // main().catch below) so the CLI prints the same clean single BLOCKED line gloss.js does,
+  // never a raw stack trace.
+  try {
+    checkVerifyApproval(process.env.VERIFY_RUN_APPROVED);
+  } catch (err) {
+    if (err instanceof RunNotApprovedError) {
+      console.log(err.message);
+      process.exitCode = 1;
+      return;
+    }
+    throw err;
+  }
+
   const anthropic = getAnthropicClient();
   if (!anthropic) {
     console.log(JSON.stringify({ mode: 'blocked', reason: 'ANTHROPIC_API_KEY not set' }, null, 2));
     process.exitCode = 1;
     return;
   }
 
   const runId = await openRun(client, 'verify');
   const failures = [];
   try {
diff --git a/src/lib/errors.js b/src/lib/errors.js
index 9b48e41..34d5870 100644
--- a/src/lib/errors.js
+++ b/src/lib/errors.js
@@ -39,10 +39,42 @@ export function parsePositiveIntegerFlag(rawValue, flag) {
   const n = Number(rawValue);
   if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '' || !Number.isInteger(n) || n < 1) {
     throw new InvalidFlagValueError(
       `${flag} requires a positive integer; got ${JSON.stringify(rawValue ?? null)} — refusing to run, `
         + 'since an unparseable limit would silently mean "no limit" and process the entire worklist',
       { flag, value: rawValue },
     );
   }
   return n;
 }
+
+// RunNotApprovedError / assertRunApproved — task 1 (2026-07-31), the shared mechanical spend-gate
+// primitive behind summarize.js's SUMMARIZE_RUN_APPROVED and verify.js's VERIFY_RUN_APPROVED.
+// gloss.js's GLOSS_RUN_APPROVED (also reused by extract-terms.js) and golden.js's
+// GOLDEN_CHECK_APPROVED predate this and stay untouched, inline, per-file — this shared pair only
+// backs the two CLIs newly gated here, so their wording can't drift from each other the way two
+// hand-copied message strings eventually would (same rationale as parsePositiveIntegerFlag/
+// InvalidFlagValueError above).
+export class RunNotApprovedError extends Error {
+  constructor(message, { envVar, action } = {}) {
+    super(message);
+    this.name = 'RunNotApprovedError';
+    this.envVar = envVar;
+    this.action = action;
+  }
+}
+
+// Throws unless envValue is exactly 'yes' — mirrors gloss.js's own `!== 'yes'` check, so
+// 'true'/'1'/anything else is refused, not just an unset var. The message keeps gloss.js's voice:
+// what makes the run cost money, that approval is the owner's per-run call, and the exact env var
+// to set. Callers (see summarize.js/verify.js main()) catch RunNotApprovedError locally and print
+// err.message via console.log — never console.error — so the CLI's output stays the same clean
+// single line gloss.js itself prints, not a raw stack trace.
+export function assertRunApproved(envValue, { envVar, action, detail } = {}) {
+  if (envValue === 'yes') return;
+  const detailSuffix = detail ? ` (${detail})` : '';
+  throw new RunNotApprovedError(
+    `BLOCKED: ${action} makes live, billed Anthropic API calls${detailSuffix}. Per the owner's `
+      + `standing policy, each run requires his explicit per-run approval — set ${envVar}=yes to proceed.`,
+    { envVar, action },
+  );
+}
diff --git a/tests/lib.test.js b/tests/lib.test.js
index d50f207..9e0a38a 100644
--- a/tests/lib.test.js
+++ b/tests/lib.test.js
@@ -1,13 +1,13 @@
 import { test } from 'node:test';
 import assert from 'node:assert/strict';
-import { SourceFetchError, RateLimitedError } from '../src/lib/errors.js';
+import { SourceFetchError, RateLimitedError, RunNotApprovedError, assertRunApproved } from '../src/lib/errors.js';
 import { createLimiter } from '../src/lib/rate-limiter.js';
 import { redactUrl } from '../src/lib/http.js';
 
 test('RateLimitedError is a SourceFetchError with metadata', () => {
   const err = new RateLimitedError('slow down', { source: 'us-congress', url: 'https://x', status: 429 });
   assert.ok(err instanceof SourceFetchError);
   assert.ok(err instanceof Error);
   assert.equal(err.source, 'us-congress');
   assert.equal(err.status, 429);
   assert.equal(err.name, 'RateLimitedError');
@@ -58,10 +58,59 @@ test('redactUrl also redacts access_key= (LegiScan\'s per-dataset token from get
   assert.equal(
     redactUrl('https://x/y?access_key=abc123&other=1'),
     'https://x/y?access_key=REDACTED&other=1',
   );
 });
 
 test('redactUrl passes through URLs with no query unchanged', () => {
   assert.equal(redactUrl('https://clerk.house.gov/evs/2025/roll358.xml'), 'https://clerk.house.gov/evs/2025/roll358.xml');
   assert.equal(redactUrl('https://x/y?format=json&limit=250'), 'https://x/y?format=json&limit=250');
 });
+
+// ---- assertRunApproved / RunNotApprovedError: the shared spend-gate primitive behind
+// summarize.js's SUMMARIZE_RUN_APPROVED and verify.js's VERIFY_RUN_APPROVED (task 1, closing the
+// gap CLAUDE.md's own policy flagged — gloss.js's GLOSS_RUN_APPROVED and golden.js's
+// GOLDEN_CHECK_APPROVED predate this and stay untouched, inline, per-file). ----
+
+test('assertRunApproved throws RunNotApprovedError unless the value is exactly "yes"', () => {
+  assert.throws(
+    () => assertRunApproved(undefined, { envVar: 'FOO_RUN_APPROVED', action: 'fooing' }),
+    RunNotApprovedError,
+  );
+  assert.throws(
+    () => assertRunApproved('', { envVar: 'FOO_RUN_APPROVED', action: 'fooing' }),
+    RunNotApprovedError,
+  );
+  // Truthy-looking but not the exact sentinel — same discipline as gloss.js's own `!== 'yes'`.
+  assert.throws(
+    () => assertRunApproved('true', { envVar: 'FOO_RUN_APPROVED', action: 'fooing' }),
+    RunNotApprovedError,
+  );
+});
+
+test('assertRunApproved does not throw when the value is exactly "yes"', () => {
+  assert.doesNotThrow(() => assertRunApproved('yes', { envVar: 'FOO_RUN_APPROVED', action: 'fooing' }));
+});
+
+test('RunNotApprovedError message states the run costs real money, that approval is per-run, and the exact env var to set — gloss.js\'s voice', () => {
+  try {
+    assertRunApproved(undefined, { envVar: 'FOO_RUN_APPROVED', action: 'fooing', detail: 'doing the foo' });
+    assert.fail('expected assertRunApproved to throw');
+  } catch (err) {
+    assert.ok(err instanceof RunNotApprovedError);
+    assert.equal(err.name, 'RunNotApprovedError');
+    assert.match(err.message, /^BLOCKED: fooing makes live, billed Anthropic API calls \(doing the foo\)\./);
+    assert.match(err.message, /owner's standing policy/);
+    assert.match(err.message, /explicit per-run approval/);
+    assert.match(err.message, /set FOO_RUN_APPROVED=yes to proceed/);
+    assert.equal(err.envVar, 'FOO_RUN_APPROVED');
+  }
+});
+
+test('assertRunApproved omits the parenthetical when no detail is given', () => {
+  try {
+    assertRunApproved('no', { envVar: 'FOO_RUN_APPROVED', action: 'fooing' });
+    assert.fail('expected assertRunApproved to throw');
+  } catch (err) {
+    assert.match(err.message, /^BLOCKED: fooing makes live, billed Anthropic API calls\. Per/);
+  }
+});
diff --git a/tests/scheduled-ingest.test.js b/tests/scheduled-ingest.test.js
new file mode 100644
index 0000000..d0497d0
--- /dev/null
+++ b/tests/scheduled-ingest.test.js
@@ -0,0 +1,449 @@
+import { test } from 'node:test';
+import assert from 'node:assert/strict';
+import {
+  mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync,
+} from 'node:fs';
+import { spawnSync } from 'node:child_process';
+import path from 'node:path';
+import os from 'node:os';
+import {
+  parseArgs, isLockStale, acquireLock, releaseLock,
+  computeSourceDueness, pickMostOverdue,
+  parseUsHouseRoll, computeRollWindow,
+  parseChildOutput, runWroteSomething,
+  queryLatestStartedAt, resolveLegiscanSessionId, resolveUsCongressRollWindow, buildRegistry,
+  runChildCli, envIntervalMs,
+  MAX_RUN_DURATION_MS, US_CONGRESS_CONGRESS, US_CONGRESS_ROLL_WINDOW,
+} from '../scripts/scheduled-ingest.js';
+import { MO_SENATE_MIN_INTERVAL_MS } from '../src/adapters/mo-senate-web.js';
+import { MO_HOUSE_MIN_INTERVAL_MS, DEFAULT_MO_HOUSE_SESSION } from '../src/adapters/mo-house-xml.js';
+
+// ---- parseArgs ----
+
+test('parseArgs defaults to live, no --only', () => {
+  const out = parseArgs([]);
+  assert.equal(out.dryRun, false);
+  assert.equal(out.only, null);
+});
+
+test('parseArgs accepts --dry-run and --only <source>', () => {
+  const out = parseArgs(['--dry-run', '--only', 'mo-senate-web']);
+  assert.equal(out.dryRun, true);
+  assert.equal(out.only, 'mo-senate-web');
+});
+
+test('parseArgs rejects an unknown --only value (never silently runs the wrong source)', () => {
+  assert.throws(() => parseArgs(['--only', 'bogus-source']), /unknown source/);
+});
+
+test('parseArgs rejects unknown flags', () => {
+  assert.throws(() => parseArgs(['--wat']), /unknown flag/);
+});
+
+// ---- envIntervalMs: the mechanical floor behind US_CONGRESS_MIN_INTERVAL_MS/LEGISCAN_MIN_INTERVAL_MS ----
+
+test('envIntervalMs floors a configured value at the minimum, never letting it go lower', () => {
+  assert.equal(envIntervalMs('__NOPE__', 1000, 5000), 5000, 'unset env falls back to default, then floored');
+  assert.equal(envIntervalMs('__NOPE__', 10000, 5000), 10000, 'unset env default above floor is kept');
+});
+
+// ---- isLockStale / acquireLock / releaseLock — single-instance lock discipline ----
+
+test('isLockStale: false when within the max run duration, true once past it', () => {
+  const now = Date.parse('2026-07-31T12:10:00.000Z');
+  const lock = { startedAt: '2026-07-31T12:00:00.000Z', pid: 123 };
+  assert.equal(isLockStale(lock, now, 20 * 60 * 1000), false); // 10 min elapsed, 20 min ceiling
+  assert.equal(isLockStale(lock, now, 5 * 60 * 1000), true); // 10 min elapsed, 5 min ceiling
+});
+
+test('isLockStale: an unparseable startedAt is treated as stale, not trusted', () => {
+  assert.equal(isLockStale({ startedAt: 'not-a-date' }, Date.now(), MAX_RUN_DURATION_MS), true);
+});
+
+function withTmpDir(fn) {
+  const dir = mkdtempSync(path.join(os.tmpdir(), 'vg-scheduler-test-'));
+  try {
+    return fn(dir);
+  } finally {
+    rmSync(dir, { recursive: true, force: true });
+  }
+}
+
+test('acquireLock: fresh lock succeeds and writes pid+timestamp; a second attempt while it is live is refused', () => {
+  withTmpDir((dir) => {
+    const lockPath = path.join(dir, 'nested', 'scheduler.lock.json');
+    const first = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
+    assert.equal(first.acquired, true);
+    assert.equal(first.reason, 'fresh');
+    assert.ok(existsSync(lockPath));
+    const written = JSON.parse(readFileSync(lockPath, 'utf8'));
+    assert.equal(written.pid, process.pid);
+    assert.equal(written.startedAt, '2026-07-31T12:00:00.000Z');
+
+    // Second attempt 1 minute later, well within MAX_RUN_DURATION_MS — must be refused, never
+    // silently proceed (this is the exact "no stacked overlapping processes" guarantee).
+    const second = acquireLock(lockPath, { now: Date.parse('2026-07-31T12:01:00.000Z') });
+    assert.equal(second.acquired, false);
+    assert.equal(second.reason, 'already-running');
+    assert.equal(second.lock.pid, process.pid);
+  });
+});
+
+test('acquireLock: a lock older than the max run duration is reclaimed, not trusted forever', () => {
+  withTmpDir((dir) => {
+    const lockPath = path.join(dir, 'scheduler.lock.json');
+    acquireLock(lockPath, { now: Date.parse('2026-07-31T12:00:00.000Z') });
+
+    const muchLater = Date.parse('2026-07-31T12:00:00.000Z') + MAX_RUN_DURATION_MS + 1;
+    const reclaimed = acquireLock(lockPath, { now: muchLater });
+    assert.equal(reclaimed.acquired, true);
+    assert.equal(reclaimed.reason, 'reclaimed-stale');
+    assert.ok(reclaimed.staleLock, 'the reclaimed lock\'s own prior contents are surfaced for the warning log');
+  });
+});
+
+test('acquireLock: a corrupt/unreadable lock file is treated as stale and reclaimed, never crashes', () => {
+  withTmpDir((dir) => {
+    const lockPath = path.join(dir, 'scheduler.lock.json');
+    mkdirSync(path.dirname(lockPath), { recursive: true });
+    writeFileSync(lockPath, 'not json{{{');
+    const result = acquireLock(lockPath, { now: Date.now() });
+    assert.equal(result.acquired, true);
+    assert.equal(result.reason, 'reclaimed-stale');
+  });
+});
+
+test('releaseLock: deletes an existing lock file, and is a safe no-op when nothing is there', () => {
+  withTmpDir((dir) => {
+    const lockPath = path.join(dir, 'scheduler.lock.json');
+    acquireLock(lockPath, { now: Date.now() });
+    assert.ok(existsSync(lockPath));
+    releaseLock(lockPath);
+    assert.ok(!existsSync(lockPath));
+    assert.doesNotThrow(() => releaseLock(lockPath)); // already gone — must not throw
+  });
+});
+
+// ---- computeSourceDueness / pickMostOverdue ----
+
+test('computeSourceDueness: never-run source (lastStartedAtIso null) is due, with infinite elapsed', () => {
+  const now = Date.now();
+  const e = computeSourceDueness({ key: 'x', minIntervalMs: 1000, lastStartedAtIso: null }, now);
+  assert.equal(e.due, true);
+  assert.equal(e.remainingMs, 0);
+  assert.equal(e.elapsedMs, Infinity);
+});
+
+test('computeSourceDueness: recently-run source is not due; remainingMs matches remainingCooldownMs\'s own arithmetic', () => {
+  const now = Date.parse('2026-07-31T12:30:00.000Z');
+  const e = computeSourceDueness({ key: 'x', minIntervalMs: 30 * 60 * 1000, lastStartedAtIso: '2026-07-31T12:20:00.000Z' }, now);
+  assert.equal(e.due, false);
+  assert.equal(e.remainingMs, 20 * 60 * 1000); // 30 min interval - 10 min elapsed
+  assert.equal(e.elapsedMs, 10 * 60 * 1000);
+});
+
+test('computeSourceDueness: a source whose cooldown has fully elapsed is due', () => {
+  const now = Date.parse('2026-07-31T13:00:00.000Z');
+  const e = computeSourceDueness({ key: 'x', minIntervalMs: 30 * 60 * 1000, lastStartedAtIso: '2026-07-31T12:00:00.000Z' }, now);
+  assert.equal(e.due, true);
+  assert.equal(e.remainingMs, 0);
+});
+
+test('pickMostOverdue: chooses the due source with the longest elapsed time, never a not-due one', () => {
+  const entries = [
+    { key: 'a', due: true, resolvable: true, elapsedMs: 1000 },
+    { key: 'b', due: true, resolvable: true, elapsedMs: 5000 },
+    { key: 'c', due: false, resolvable: true, elapsedMs: 999999 }, // not due — must never win despite huge elapsed
+  ];
+  assert.equal(pickMostOverdue(entries).key, 'b');
+});
+
+test('pickMostOverdue: an unresolvable source (e.g. legiscan with no session id) is never chosen even if due and most overdue', () => {
+  const entries = [
+    { key: 'a', due: true, resolvable: true, elapsedMs: 10 },
+    { key: 'legiscan', due: true, resolvable: false, elapsedMs: Infinity },
+  ];
+  assert.equal(pickMostOverdue(entries).key, 'a');
+});
+
+test('pickMostOverdue: null when nothing is due', () => {
+  const entries = [{ key: 'a', due: false, resolvable: true, elapsedMs: 10 }];
+  assert.equal(pickMostOverdue(entries), null);
+});
+
+test('pickMostOverdue: a source that has never run (Infinity elapsed) outranks every source with a real timestamp', () => {
+  const entries = [
+    { key: 'seen', due: true, resolvable: true, elapsedMs: 99 * 24 * 60 * 60 * 1000 },
+    { key: 'never', due: true, resolvable: true, elapsedMs: Infinity },
+  ];
+  assert.equal(pickMostOverdue(entries).key, 'never');
+});
+
+// ---- parseUsHouseRoll / computeRollWindow ----
+
+test('parseUsHouseRoll extracts the trailing roll number from a us-house source_key', () => {
+  assert.equal(parseUsHouseRoll('us-house-119-2026-350'), 350);
+  assert.equal(parseUsHouseRoll('us-house-119-2026-7'), 7);
+});
+
+test('parseUsHouseRoll returns null for anything that isn\'t that exact shape (never a false roll number)', () => {
+  assert.equal(parseUsHouseRoll('us-senate-119-1-616'), null);
+  assert.equal(parseUsHouseRoll(''), null);
+  assert.equal(parseUsHouseRoll(null), null);
+  assert.equal(parseUsHouseRoll(undefined), null);
+});
+
+test('computeRollWindow: starts one past the max known roll, spans windowSize', () => {
+  assert.deepEqual(computeRollWindow(350, 10), { lo: 351, hi: 360 });
+});
+
+test('computeRollWindow: zero/no prior rolls on file starts the window at roll 1', () => {
+  assert.deepEqual(computeRollWindow(0, 10), { lo: 1, hi: 10 });
+  assert.deepEqual(computeRollWindow(undefined, 10), { lo: 1, hi: 10 });
+});
+
+test('computeRollWindow defaults windowSize to US_CONGRESS_ROLL_WINDOW', () => {
+  assert.deepEqual(computeRollWindow(0), { lo: 1, hi: US_CONGRESS_ROLL_WINDOW });
+});
+
+// ---- parseChildOutput / runWroteSomething ----
+
+test('parseChildOutput parses a CLI\'s pretty-printed JSON.stringify(..., null, 2) stdout', () => {
+  const stdout = JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 3 } }, null, 2);
+  const { parsed, parseError } = parseChildOutput(stdout);
+  assert.equal(parseError, null);
+  assert.equal(parsed.mode, 'live');
+  assert.equal(parsed.counts.votes, 3);
+});
+
+test('parseChildOutput reports a parse error instead of throwing on unparseable stdout', () => {
+  const { parsed, parseError } = parseChildOutput('not json at all');
+  assert.equal(parsed, null);
+  assert.ok(parseError);
+});
+
+test('runWroteSomething: true only for a live run reporting succeeded/partial', () => {
+  assert.equal(runWroteSomething({ mode: 'live', status: 'succeeded' }), true);
+  assert.equal(runWroteSomething({ mode: 'live', status: 'partial' }), true);
+});
+
+test('runWroteSomething: false for blocked/dry-run modes, and for a null/unparsed result', () => {
+  assert.equal(runWroteSomething({ mode: 'blocked', status: 'succeeded' }), false);
+  assert.equal(runWroteSomething({ mode: 'dry-run' }), false);
+  assert.equal(runWroteSomething(null), false);
+  assert.equal(runWroteSomething(undefined), false);
+});
+
+test('runWroteSomething: false for a live run whose status is neither succeeded nor partial', () => {
+  assert.equal(runWroteSomething({ mode: 'live', status: 'failed' }), false);
+});
+
+// ---- DB-facing helpers: fakeClient (same shape as summarize-cli.test.js's own fakeClient) ----
+
+function fakeQuery(result) {
+  const builder = {
+    select: () => builder,
+    eq: () => builder,
+    like: () => builder,
+    order: () => builder,
+    limit: () => builder,
+    range: () => builder,
+    maybeSingle: () => builder,
+    single: () => builder,
+    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
+  };
+  return builder;
+}
+
+function fakeClient(resultsByTable) {
+  return { from: (table) => fakeQuery(resultsByTable[table] ?? { data: null, error: null }) };
+}
+
+test('queryLatestStartedAt returns the latest started_at for the given source, null when none exists', async () => {
+  const client = fakeClient({ ingestion_runs: { data: { started_at: '2026-07-31T10:00:00.000Z' }, error: null } });
+  assert.equal(await queryLatestStartedAt(client, 'mo-senate-web'), '2026-07-31T10:00:00.000Z');
+
+  const emptyClient = fakeClient({ ingestion_runs: { data: null, error: null } });
+  assert.equal(await queryLatestStartedAt(emptyClient, 'mo-senate-web'), null);
+});
+
+test('queryLatestStartedAt throws a plain descriptive Error on a real lookup failure (never silently swallowed)', async () => {
+  const client = fakeClient({ ingestion_runs: { data: null, error: { message: 'boom' } } });
+  await assert.rejects(() => queryLatestStartedAt(client, 'legiscan'), /ingestion_runs lookup failed.*legiscan.*boom/s);
+});
+
+test('resolveLegiscanSessionId returns the current MO session\'s legiscan_session_id when on file', async () => {
+  const client = fakeClient({ sessions: { data: { legiscan_session_id: 2239 }, error: null } });
+  assert.equal(await resolveLegiscanSessionId(client), 2239);
+});
+
+test('resolveLegiscanSessionId returns null (never guesses) when the session row or its legiscan_session_id is missing', async () => {
+  const missingRow = fakeClient({ sessions: { data: null, error: null } });
+  assert.equal(await resolveLegiscanSessionId(missingRow), null);
+
+  const nullColumn = fakeClient({ sessions: { data: { legiscan_session_id: null }, error: null } });
+  assert.equal(await resolveLegiscanSessionId(nullColumn), null);
+});
+
+test('resolveUsCongressRollWindow computes the window from the max roll number found in votes.source_key', async () => {
+  const client = fakeClient({
+    votes: {
+      data: [
+        { source_key: 'us-house-119-2026-40' },
+        { source_key: 'us-house-119-2026-355' },
+        { source_key: 'us-house-119-2026-12' },
+      ],
+      error: null,
+    },
+  });
+  const window = await resolveUsCongressRollWindow(client, { congress: 119, year: 2026, windowSize: 10 });
+  assert.deepEqual(window, { lo: 356, hi: 365 });
+});
+
+test('resolveUsCongressRollWindow starts at roll 1 when nothing is on file yet for this congress/year', async () => {
+  const client = fakeClient({ votes: { data: [], error: null } });
+  const window = await resolveUsCongressRollWindow(client, { congress: 119, year: 2026, windowSize: 10 });
+  assert.deepEqual(window, { lo: 1, hi: 10 });
+});
+
+// ---- buildRegistry: the full four-source registry, with the TODO-31 mo-house-xml restriction and
+// the legiscan fail-safe both structurally verified, not just documented ----
+
+function fakeRegistryClient({ legiscanSessionId = 2239, votesRows = [], lastStartedAtBySource = {} } = {}) {
+  return {
+    from(table) {
+      if (table === 'ingestion_runs') {
+        // Own closure variable per .from('ingestion_runs') call (queryLatestStartedAt makes one
+        // fresh call per source) — NOT `this` inside arrow functions, which would capture the
+        // outer fakeRegistryClient object instead of this inner chainable builder.
+        let sourceFilter = null;
+        const builder = {
+          select: () => builder,
+          eq: (col, val) => { sourceFilter = val; return builder; },
+          order: () => builder,
+          limit: () => builder,
+          maybeSingle: () => builder,
+          then: (resolve, reject) => {
+            const started = lastStartedAtBySource[sourceFilter] ?? null;
+            return Promise.resolve({ data: started ? { started_at: started } : null, error: null }).then(resolve, reject);
+          },
+        };
+        return builder;
+      }
+      if (table === 'sessions') {
+        return fakeQuery({
+          data: legiscanSessionId != null ? { legiscan_session_id: legiscanSessionId } : null,
+          error: null,
+        });
+      }
+      if (table === 'votes') {
+        return fakeQuery({ data: votesRows, error: null });
+      }
+      return fakeQuery({ data: null, error: null });
+    },
+  };
+}
+
+test('buildRegistry: all four sources, correct scripts + static args, legiscan resolved', async () => {
+  const client = fakeRegistryClient({ legiscanSessionId: 2239 });
+  const registry = await buildRegistry(client, { now: Date.parse('2026-07-31T12:00:00.000Z'), year: 2026 });
+
+  assert.equal(registry.length, 4);
+  const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));
+
+  assert.equal(byKey['mo-senate-web'].minIntervalMs, MO_SENATE_MIN_INTERVAL_MS);
+  assert.equal(byKey['mo-senate-web'].scriptPath, 'src/cli/ingest-mo-senate.js');
+  assert.deepEqual(byKey['mo-senate-web'].cliArgs, ['--year', '2026', '--limit', '1']);
+  assert.equal(byKey['mo-senate-web'].resolvable, true);
+
+  assert.equal(byKey['mo-house-xml'].minIntervalMs, MO_HOUSE_MIN_INTERVAL_MS);
+  assert.equal(byKey['mo-house-xml'].scriptPath, 'src/cli/ingest-mo-house.js');
+  assert.deepEqual(byKey['mo-house-xml'].cliArgs, ['--limit', '1']);
+
+  assert.equal(byKey['us-congress'].scriptPath, 'src/cli/ingest.js');
+  assert.deepEqual(byKey['us-congress'].cliArgs, ['--source', 'us-congress', '--year', '2026', '--rolls', '1-10']);
+
+  assert.equal(byKey.legiscan.scriptPath, 'src/cli/ingest-legiscan.js');
+  assert.deepEqual(byKey.legiscan.cliArgs, ['--session', '2239']);
+  assert.equal(byKey.legiscan.resolvable, true);
+});
+
+test('buildRegistry: TODO-31 restriction — mo-house-xml args NEVER include --session, regardless of anything else', async () => {
+  const client = fakeRegistryClient({});
+  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
+  const house = registry.find((e) => e.key === 'mo-house-xml');
+  assert.ok(!house.cliArgs.includes('--session'), 'mo-house-xml must never receive a --session flag from the scheduler');
+});
+
+test('buildRegistry: legiscan with no legiscan_session_id on file is marked unresolvable and gets an honest reason, never a guessed session', async () => {
+  const client = fakeRegistryClient({ legiscanSessionId: null });
+  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
+  const legiscan = registry.find((e) => e.key === 'legiscan');
+  assert.equal(legiscan.resolvable, false);
+  assert.ok(legiscan.unresolvedReason, 'must explain WHY it is skipped');
+  assert.deepEqual(legiscan.cliArgs, []);
+});
+
+test('buildRegistry: every source\'s lastStartedAtIso reflects ingestion_runs, per source', async () => {
+  const client = fakeRegistryClient({
+    lastStartedAtBySource: {
+      'mo-senate-web': '2026-07-31T11:00:00.000Z',
+      'mo-house-xml': '2026-07-31T11:29:00.000Z',
+    },
+  });
+  const registry = await buildRegistry(client, { now: Date.now(), year: 2026 });
+  const byKey = Object.fromEntries(registry.map((e) => [e.key, e]));
+  assert.equal(byKey['mo-senate-web'].lastStartedAtIso, '2026-07-31T11:00:00.000Z');
+  assert.equal(byKey['mo-house-xml'].lastStartedAtIso, '2026-07-31T11:29:00.000Z');
+  assert.equal(byKey['us-congress'].lastStartedAtIso, null);
+});
+
+// ---- runChildCli: process orchestration, spawnFn injectable so no real subprocess in most tests ----
+
+test('runChildCli: parses a faked child\'s stdout and passes through its exit status', () => {
+  const calls = [];
+  const spawnFn = (command, args, options) => {
+    calls.push({ command, args, options });
+    return { status: 0, stdout: JSON.stringify({ mode: 'live', status: 'succeeded', counts: { votes: 1 } }), stderr: '' };
+  };
+  const result = runChildCli('src/cli/ingest-mo-senate.js', ['--year', '2026', '--limit', '1'], { cwd: '/repo', spawnFn });
+  assert.equal(result.exitStatus, 0);
+  assert.equal(result.parsed.status, 'succeeded');
+  assert.equal(calls.length, 1);
+  assert.equal(calls[0].command, process.execPath);
+  assert.deepEqual(calls[0].args, ['--env-file=.env', 'src/cli/ingest-mo-senate.js', '--year', '2026', '--limit', '1']);
+  assert.equal(calls[0].options.cwd, '/repo');
+});
+
+test('runChildCli: a non-zero exit (typed CLI failures) is reported, never thrown — "never crashes the scheduler run"', () => {
+  const spawnFn = () => ({ status: 2, stdout: JSON.stringify({ mode: 'live', status: 'partial', counts: {}, failures: [{ message: 'x' }] }), stderr: '' });
+  const result = runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn });
+  assert.equal(result.exitStatus, 2);
+  assert.equal(result.parsed.status, 'partial');
+});
+
+test('runChildCli: a genuine launch failure (spawnFn returns .error) throws — this IS a real scheduler-level error', () => {
+  const spawnFn = () => ({ error: new Error('ENOENT'), status: null, stdout: '', stderr: '' });
+  assert.throws(() => runChildCli('src/cli/ingest.js', [], { cwd: '/repo', spawnFn }), /could not launch/);
+});
+
+// Real subprocess smoke test (no network, no DB) — proves the actual `node --env-file=.env <path>
+// <args>` spawn plumbing runChildCli builds works end to end, not just the fake spawnFn used
+// everywhere else above. Runs from its own temp dir with a throwaway .env — real .env is
+// gitignored (never present on a fresh checkout), so this must not depend on the repo's own copy.
+test('runChildCli: real subprocess smoke test (no network, no DB) — proves the actual spawn plumbing works, not just the fake', () => {
+  withTmpDir((dir) => {
+    writeFileSync(path.join(dir, '.env'), 'SCHEDULED_INGEST_SMOKE_TEST=1\n');
+    const scriptPath = path.join(dir, 'fake-cli.js');
+    writeFileSync(scriptPath, "console.log(JSON.stringify({mode:'live',status:'succeeded',counts:{x:1}}));\n");
+
+    const result = runChildCli(
+      'fake-cli.js',
+      [],
+      { cwd: dir, spawnFn: (command, args, options) => spawnSync(command, args, { encoding: 'utf8', ...options }) },
+    );
+    assert.equal(result.exitStatus, 0);
+    assert.equal(result.parsed.mode, 'live');
+    assert.equal(result.parsed.counts.x, 1);
+  });
+});
diff --git a/tests/summarize-cli.test.js b/tests/summarize-cli.test.js
index 6554b01..84863b9 100644
--- a/tests/summarize-cli.test.js
+++ b/tests/summarize-cli.test.js
@@ -1,16 +1,17 @@
 import { test } from 'node:test';
 import assert from 'node:assert/strict';
 import {
   planWork, wrapTextFormatError, persistReferencedTermsGracefully, createDraftSummary,
+  checkSummarizeApproval,
 } from '../src/cli/summarize.js';
-import { SourceFetchError } from '../src/lib/errors.js';
+import { SourceFetchError, RunNotApprovedError } from '../src/lib/errors.js';
 
 const bills = [{ id: 'b1', identifier: 'HR 1' }, { id: 'b2', identifier: 'HR 2' }, { id: 'b3', identifier: 'HR 3' }];
 const texts = [{ bill_id: 'b2', content_hash: 'h2' }, { bill_id: 'b3', content_hash: 'h3-new' }];
 const summaries = [{ bill_id: 'b3', bill_text_hash: 'h3-old', status: 'published' }];
 
 test('planWork routes bills correctly', () => {
   const plan = planWork(bills, texts, summaries);
   assert.deepEqual(plan.needText.map((b) => b.id), ['b1']);
   assert.deepEqual(plan.needSummary.map((b) => b.id), ['b2', 'b3']);
   assert.deepEqual(plan.stale.map((s) => s.bill_id), ['b3']);
@@ -305,10 +306,30 @@ test('batch loop over two bills: a non-missing-relation persist error on bill 2
   // A glossary-persist error must never surface as a batch failure (that's the whole point).
   assert.equal(failures.length, 0);
   // Bill 1's term genuinely persisted; bill 2's did not (that's the simulated failure).
   assert.equal(glossaryTermsPersisted, 1);
   // The prior bill's success is intact in the run detail — not discarded by bill 2's warning.
   assert.equal(glossaryWarnings.length, 1);
   assert.equal(glossaryWarnings[0].identifier, 'HR 2');
   assert.equal(glossaryWarnings[0].warning.kind, 'persist_error');
   assert.match(glossaryWarnings[0].warning.message, /duplicate key/);
 });
+
+// ---- checkSummarizeApproval: task 1's spend gate — mirrors gloss.js's GLOSS_RUN_APPROVED shape
+// exactly, wired to SUMMARIZE_RUN_APPROVED. main() calls this before constructing an Anthropic
+// client or fetching any bill text for sending; see summarize.js's main() for the call site. ----
+
+test('checkSummarizeApproval blocks unless SUMMARIZE_RUN_APPROVED is exactly "yes"', () => {
+  assert.throws(() => checkSummarizeApproval(undefined), RunNotApprovedError);
+  assert.throws(() => checkSummarizeApproval('true'), RunNotApprovedError);
+  assert.doesNotThrow(() => checkSummarizeApproval('yes'));
+});
+
+test('checkSummarizeApproval\'s message names SUMMARIZE_RUN_APPROVED specifically, never another CLI\'s var', () => {
+  try {
+    checkSummarizeApproval('no');
+    assert.fail('expected checkSummarizeApproval to throw');
+  } catch (err) {
+    assert.match(err.message, /set SUMMARIZE_RUN_APPROVED=yes to proceed/);
+    assert.doesNotMatch(err.message, /VERIFY_RUN_APPROVED|GLOSS_RUN_APPROVED|GOLDEN_CHECK_APPROVED/);
+  }
+});
diff --git a/tests/verifier.test.js b/tests/verifier.test.js
index de10dde..a4763cf 100644
--- a/tests/verifier.test.js
+++ b/tests/verifier.test.js
@@ -1,19 +1,20 @@
 import { test } from 'node:test';
 import assert from 'node:assert/strict';
 import {
   VERIFIER_MODEL, VERIFY_PROMPT_VERSION, VERIFY_SCHEMA, VERIFY_SYSTEM_PROMPT,
   VERIFY_MAX_OUTPUT_TOKENS,
   buildVerifyMessage, verifyBill, assessVerdicts, VerificationIncompleteError,
 } from '../src/lib/verifier.js';
 import { MODEL, MAX_TEXT_CHARS, OversizeTextError, renderMarkdown } from '../src/lib/summarizer.js';
-import { parseArgs, parseBullets, checkBulletCoverage } from '../src/cli/verify.js';
+import { parseArgs, parseBullets, checkBulletCoverage, checkVerifyApproval } from '../src/cli/verify.js';
+import { RunNotApprovedError } from '../src/lib/errors.js';
 
 // ---- constants (controller ruling #4: sonnet stays sonnet, deliberately not opus) ----
 
 test('VERIFIER_MODEL is claude-sonnet-5, deliberately a different weight class than the opus-5 author', () => {
   assert.equal(VERIFIER_MODEL, 'claude-sonnet-5');
   assert.notEqual(VERIFIER_MODEL, MODEL);
 });
 
 test('VERIFY_PROMPT_VERSION pinned', () => {
   assert.equal(VERIFY_PROMPT_VERSION, 'v1');
@@ -239,10 +240,30 @@ test('parseArgs defaults dryRun to false and accepts --dry-run', () => {
   assert.equal(parseArgs([]).dryRun, false);
   assert.equal(parseArgs(['--dry-run']).dryRun, true);
 });
 
 test('parseArgs rejects unknown flags', () => {
   assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
 });
 
 // isMissingRelationError itself now lives in src/lib/db.js (shared with the review server) —
 // see tests/db.test.js for its unit tests. verify.js just imports and uses it.
+
+// ---- checkVerifyApproval: task 1's spend gate — mirrors gloss.js's GLOSS_RUN_APPROVED shape
+// exactly, wired to VERIFY_RUN_APPROVED. main() calls this before constructing an Anthropic
+// client; see verify.js's main() for the call site. ----
+
+test('checkVerifyApproval blocks unless VERIFY_RUN_APPROVED is exactly "yes"', () => {
+  assert.throws(() => checkVerifyApproval(undefined), RunNotApprovedError);
+  assert.throws(() => checkVerifyApproval('true'), RunNotApprovedError);
+  assert.doesNotThrow(() => checkVerifyApproval('yes'));
+});
+
+test('checkVerifyApproval\'s message names VERIFY_RUN_APPROVED specifically, never another CLI\'s var', () => {
+  try {
+    checkVerifyApproval('no');
+    assert.fail('expected checkVerifyApproval to throw');
+  } catch (err) {
+    assert.match(err.message, /set VERIFY_RUN_APPROVED=yes to proceed/);
+    assert.doesNotMatch(err.message, /SUMMARIZE_RUN_APPROVED|GLOSS_RUN_APPROVED|GOLDEN_CHECK_APPROVED/);
+  }
+});
