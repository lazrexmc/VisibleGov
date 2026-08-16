# Scheduled summaries — `scripts/scheduled-summaries.js`

The autonomous bill-summary runner designed to run **unattended, on Lance's machine, every day**,
under a strict, code-enforced budget cap ($5.00 per ISO week, $1.00 per tick). This doc is what lets
him register it (his own step — an agent never runs `schtasks`) and is what he uses to keep an eye
on it now that it's running.

**Every claim in this document was re-verified directly against `scripts/scheduled-summaries.js`
and `src/lib/billed-summary-chain.js` during the final whole-branch review's fix wave (this pass
replaced roughly a dozen claims that had drifted false, several of them carried over verbatim from
`docs/SCHEDULED_INGESTION.md`'s description of a DIFFERENT script with different mechanics). If
this script changes again, re-check this doc against it — do not trust prose over code.**

## What it does

Each invocation (one tick, typically once a day, early morning):

1. Takes a single-instance, ownership-checked lock
   (`.superpowers/artifacts/summary-scheduler.lock.json`, pid + a random nonce + a declared max
   duration — the exact same `acquireLock`/`releaseLock` mechanism `scheduled-ingest.js` uses,
   reused, not reimplemented). If another invocation already holds it, this one logs
   `already running (<reason>) — skipping this tick` and exits 0 — that is a **normal**, expected
   outcome, never a failure. A lock older than its own declared max duration (30 minutes,
   `TICK_MAX_DURATION_MS`) is reclaimed as stale by whichever LATER tick finds it that way — see
   "Recovery properties" below for exactly what that constant does and does not enforce.
2. Computes this ISO week's spend from `ingestion_runs` rows (`source='scheduled-summaries'`,
   last 10 days) and checks it against the weekly cap (`SUMMARY_WEEKLY_CAP_USD`, $5.00 default) and
   per-tick cap (`SUMMARY_TICK_CAP_USD`, $1.00 default). If the remaining allowance for this tick
   would fall below the smallest plausible bill cost (`WORST_BILL_FLOOR_USD`, $0.05), the tick ends
   right here: it logs `budget exhausted for <week>` and exits 0 — **no run row is opened, nothing
   is spent.**
3. Asks `src/cli/summary-queue.js plan --dry-run` (a separate, read-only, $0 child process — no
   API calls) for the priority-ordered queue of summarizable bills, splits it into **fresh**
   (unsummarized, ≤100,000 chars), **conversion** (draft-only bills that already have mechanical
   verifier objections on file — a re-author lane, capped at the 50 oldest-flagged
   `MAX_CONVERSIONS_EXAMINED` per tick so hundreds of routinely-ineligible drafts don't get
   re-examined forever), and **monster** (unsummarized, >100,000 chars, at most one per tick)
   lanes, in that priority order.
4. For each bill in the assembled tick, in order: two-to-three CHEAP, unbilled pre-bill checks run
   BEFORE the first paid call — (a) a general "can we still afford another bill at all" guard based
   on the worst bill actually observed so far this tick; (b) for the one monster lane, an extra
   1.5x-headroom check; (c) a conservative cost estimate computed from the bill's own text length
   (`estimateBillCostUsd`), checked against the allowance still remaining. A bill that fails any of
   these is skipped — honestly recorded in the run's `skipped` list, no API call ever made for it.
   A bill that passes all of them runs the full chain (`src/lib/billed-summary-chain.js`: Haiku
   author → Sonnet verify → Sonnet provisions → Sonnet coverage, or Haiku re-author for the
   conversion lane), checkpointed per stage as it goes (see "Recovery properties"). **There is no
   mid-chain budget check** — once a bill's chain starts, it runs to completion (or throws); the
   caps are enforced entirely by deciding whether to START a bill, never by interrupting one
   partway through, and never by shrinking any one call's own token ceiling (every stage's
   `max_tokens` is a fixed constant — 16,000 for the Haiku author, 32,000/4,000/3,000 for the three
   Sonnet stages — independent of how much budget remains).
5. Hands every bill that produced a real result to `src/cli/summary-queue.js record` (a separate
   child process per lane — the ONLY thing that ever writes a summary row; this script never writes
   to `summaries` directly), which runs the same mechanical publish/flag gates every other
   summarization path in this repo goes through.
6. Closes the `ingestion_runs` row it opened at step 3/4 with an honest status (`succeeded` if
   everything it attempted published or hit only a routine, expected skip; `partial` if anything
   genuinely anomalous happened — a hash mismatch, an oversize text, an insufficient cost estimate,
   a non-billing chain error, a crashed record CLI, or the API balance running out) and a detail
   object (spend, published/gate-refusal/record-failure counts, per-lane counts, the full skip
   list). Appends one dated log line — see "Reading the logs" below for the exact shapes.

## What it will never do

- **Never calls a model without limits — but the limits are enforced by DECIDING, not by
  shrinking.** The code enforces both caps (weekly and per-tick) mechanically; an env override
  (`SUMMARY_WEEKLY_CAP_USD` / `SUMMARY_TICK_CAP_USD`) can only LOWER them below the code default,
  never raise them above it (`envCapUsd` computes `Math.min(override, default)` — a ceiling at the
  default, not a floor at it). Every API call's own token budget (`max_tokens`) is a FIXED constant
  per stage, never derived from remaining budget — the caps work entirely by refusing to START a
  bill whose conservative cost estimate the remaining allowance can't cover (see "What it does"
  step 4), not by shrinking any individual call.
- **Never runs without the API key deployed.** If `ANTHROPIC_API_KEY` is not set (and this isn't
  `--dry-run`), the script logs `ANTHROPIC_API_KEY not set — exiting without a tick` and exits 0
  with no spend — a plain runtime check in `main()`, not a structural "the SDK is never imported"
  guarantee the way `scheduled-ingest.js` makes for itself: this file DOES import
  `@anthropic-ai/sdk` unconditionally, because (unlike the ingestion scheduler) it exists
  specifically to make billed calls once the key is present.
- **Never lets one broken bill starve the rest of the tick.** The tick assembles a full lane list
  (fresh, then conversions, then at most one monster) and works through ALL of it, not just one
  bill. A non-billing error on any one bill (network hiccup, a schema 400, a refusal) is caught,
  recorded as an honest skip with the real error message, and the loop moves on to the next bill —
  the checkpoints for whatever paid stages that bill DID complete stay on disk either way (see
  "Recovery properties"). Only a genuine BILLING error (a 400/402 with credit/balance/payment
  language) stops the whole tick early — deliberately, since continuing to spend once the account
  is out of money would be worse than stopping.
- **Never creates overlapping processes.** The single-instance lock (see step 1) prevents two
  concurrent runs; its release is ownership-checked (nonce-based), so a lock can never be deleted by
  a process that doesn't own it. `TICK_MAX_DURATION_MS` (30 minutes) is **not** a self-enforced
  deadline that terminates a stuck tick — it is only the duration a LATER tick uses to decide an
  existing lock is stale enough to reclaim. The actual thing that can kill a runaway tick is
  Windows' own Task Scheduler "Stop the task if it runs longer than" setting — see that section
  below for why the two numbers need to agree.
- **Never writes summary rows directly to the database.** Every write goes through spawning
  `src/cli/summary-queue.js record` as a separate child process (the `recordLane` function), whose
  mechanical gates (schema validation, hash-provenance, citation checks, completeness checks) are
  exactly the same ones every other summarization path in this repo uses — nothing scheduler-specific
  is exempted.
- **Never crashes silently.** A throwing plan-CLI call, a throwing record-CLI call, and a throwing
  bill chain are all caught, not left to propagate — each lands as an honest log line and/or a
  recorded skip rather than an uncaught exception that would exit the process with no diagnostic
  trail (see "Recovery properties" and the fix-wave notes below).

## ⚠️ Budget is real — these caps are published Terms of Service with yourself

`SUMMARY_WEEKLY_CAP_USD` (default $5.00) and `SUMMARY_TICK_CAP_USD` (default $1.00) are
**hard, code-enforced limits**, not suggestions. They are defined in `scripts/scheduled-summaries.js`
(`WEEKLY_CAP_USD`/`PER_TICK_CAP_USD`) and are env-overridable via `envCapUsd()`, downward only — a
typo'd env var can shrink spend, never grow it (`Math.min(override, default)`: the default is a
ceiling the override can only fall below, never exceed). **Do not edit the code to bypass them.**

A crashed/stranded tick (`status='running'` left behind by a hard kill) is always charged the FULL
code-default per-tick cap against the weekly ledger — conservatively assuming the worst, and never
using a possibly-lowered cap from whichever tick happens to be doing the charging (fixed in this
review's pass: a throttled manual tick run under a lowered `SUMMARY_TICK_CAP_USD` used to be able
to under-charge a PRIOR crashed tick that actually ran under the real $1.00 cap).

## The registry

| Parameter | Default | Meaning |
|---|---|---|
| `SUMMARY_WEEKLY_CAP_USD` | $5.00 | Hard weekly budget; env override can only lower it, never raise it |
| `SUMMARY_TICK_CAP_USD` | $1.00 | Hard per-invocation budget; env override can only lower it, never raise it |
| `TICK_MAX_DURATION_MS` | 30 minutes | The lock's own declared stale-reclaim duration — how long a LATER tick waits before treating an existing lock as abandoned. NOT a self-terminating deadline for the CURRENT tick — see the Task Scheduler section below for what actually bounds a stuck tick |
| `MAX_CONVERSIONS_EXAMINED` | 50 (not env-overridable) | How many draft-only bills the conversion lane examines per tick, oldest-flagged first, before assembling the rest of the tick |
| `WORST_BILL_FLOOR_USD` | $0.05 | The floor a tick's remaining allowance must clear just to open a run row at all |

## Before you register: one throttled manual tick first

The runner has been tested end-to-end against fakes (`tests/scheduled-summaries.test.js`), but has
never yet made a single real, paid API call. **Before registering the daily task, run exactly one
deliberately throttled manual tick by hand** — this is Lance's own step; do not run it on his
behalf:

```
SUMMARY_TICK_CAP_USD=0.10 node --env-file=.env scripts/scheduled-summaries.js
```

(PowerShell equivalent, if not using Git Bash: `$env:SUMMARY_TICK_CAP_USD = "0.10"; node --env-file=.env scripts/scheduled-summaries.js`)

$0.10 is enough to fund one small bill through the whole chain (author → verify → provisions →
coverage) without risking a large, unexpected charge on the very first real run. After it finishes:

1. Check `npm run status`'s **SUMMARY SCHEDULER** block — it should show a `last tick` entry with
   today's date, a real `spent this week` figure above $0.00, and (if the one bill it attempted
   published cleanly) `published this week` at 1.
2. Check the day's log file under `.superpowers/artifacts/summary-scheduler-logs/` — one line
   should appear, of the `tick=<id> attempted=1 published=... spent=$...` shape described under
   "Reading the logs" below.
3. Only once both of those look right, proceed to registration below (and remember to unset
   `SUMMARY_TICK_CAP_USD` afterward, or the daily runs will stay throttled to $0.10/tick — a real
   per-tick budget of $1.00 needs the env var absent, not present-and-small).

## Registering it (Lance's step — never run `schtasks` from an agent)

Run every day at 6 AM local time. The exact schedule is your call; 6 AM was chosen to
(a) avoid overnight API rate-limit surprises and (b) give you a daily morning summary to review.

> **Status (as of this writing): NOT YET REGISTERED.** This section is the command to run; do it
> once (after the one throttled manual tick above), and this whole scheduled runner comes to life.
> Until then, the scheduler is built but dormant.

**Command line — use Command Prompt, NOT PowerShell.** (Start menu → type `cmd` → "Command
Prompt". Windows 11's default terminal is PowerShell, where this command's quoting breaks
silently.) One single line, paste it whole, press Enter. No administrator elevation needed.
Adjust the `node.exe` path only if `where node` prints something different.

```
schtasks /create /tn "VisibleGov Scheduled Summaries" /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-summaries.js" /sc daily /st 06:00 /f
```

**Both the `--env-file` path and the script path are absolute here — that matters.**
`schtasks /create` runs the scheduled task with its working directory set to
`%SystemRoot%\system32`, not the repo — a RELATIVE `--env-file=.env scripts\scheduled-summaries.js`
(the earlier form of this command) would resolve against `system32` and fail to find either file.
Only `node.exe`'s own path needs to be absolute for THAT reason alone; the `--env-file` and script
arguments need it too, for the same reason. As a belt-and-braces second safety net (not a
replacement for the absolute paths above — Task Scheduler's working directory should never be load
-bearing for this command), also set "Start in" to `F:\VisibleGov` via the GUI after creating the
task (Properties → General tab, or see the GUI walkthrough below) — redundant with the absolute
paths, but harmless, and it's one click.

Expected output: `SUCCESS: The scheduled task "VisibleGov Scheduled Summaries" has successfully
been created.`

- `/sc daily /st 06:00` — runs every day at 6:00 AM.
- No `/ru` flag — runs as your own account, only while you're logged on (no password needed).
  If you want it to run even while logged out, use the Task Scheduler GUI after creating it
  (this same command; General tab → "Run whether user is logged on or not," which will prompt
  for your password once). **This is what Lance should do** if he wants the runner truly
  hands-off across reboots.
- `/f` overwrites a prior registration with the same name — safe to re-run this command if you
  ever change the schedule or the cap values.

**GUI equivalent**, if preferred: Task Scheduler → Create Task → General: name it "VisibleGov
Scheduled Summaries"; Triggers → New → "On a schedule" → Daily at **06:00** (or your preferred
time); Actions → New → Program: `C:\Program Files\nodejs\node.exe`, Arguments:
`--env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-summaries.js`, Start in:
`F:\VisibleGov` (the belt-and-braces safety net mentioned above).

### ⚠️ Check the task's own "Stop the task if it runs longer than" setting — it must EXCEED 30 minutes

This is a **separate setting from everything above** — it's Windows' own execution-time limit on
the *whole scheduled task*, not anything this script controls. The `schtasks /create` command
above does not set it explicitly, so **check it via the GUI after creating the task**: Task
Scheduler → find "VisibleGov Scheduled Summaries" → Properties → **Settings tab** → "Stop the task
if it runs longer than."

**This Windows setting is the ACTUAL, real deadline that can kill a stuck tick.**
`TICK_MAX_DURATION_MS` (30 minutes, inside the script) is NOT a self-enforced deadline for the
CURRENT tick at all — it only controls how long a LATER tick waits before deciding an existing lock
file is abandoned and safe to reclaim. If Windows' own setting is *shorter* than 30 minutes, it can
kill a legitimate in-progress tick before this script's own lock even reaches its stale-reclaim
window — and because that kill comes from OUTSIDE the script (not the script's own `finally`
block), the lock is never released by its normal path (it still self-heals eventually, once a later
tick finds it stale — see "Recovery properties" — but the current tick's `ingestion_runs` row can
be left `running` and get conservatively charged the full per-tick cap by the next week's ledger
math).

**Recommendation: uncheck "Stop the task if it runs longer than" entirely, or set it to at least
1 hour (comfortably above the 30-minute `TICK_MAX_DURATION_MS`).** Windows' own setting is the real
enforcement here; the in-script constant only needs to stay well under it so the stale-reclaim
window and the OS-level kill can never race each other in a confusing way.

## Reading the logs

Two places to check, and they answer different questions:

1. **The log file.** `.superpowers/artifacts/summary-scheduler-logs/YYYY-MM-DD.log` (gitignored,
   one entry per tick, occasionally two — see below). **The date in the filename is UTC, not local
   time** — Central time is 5-6 hours behind UTC, so any time after ~7pm Central, "today's" log
   entries are already landing in *tomorrow's* dated file. If the file you'd expect looks stale or
   is missing entirely, check the next day's filename before assuming the scheduler stopped.

   A normal, successful tick logs exactly ONE line, of this shape:
   ```
   2026-08-16T11:03:22.104Z tick=<run-id> attempted=3 published=2 gate_refusals=1 spent=$0.3120 week=2026-W33 total=$1.2340/5.00
   ```
   (the leading timestamp is when the tick FINISHED, not when it started). A tick that stopped
   early for a normal, expected reason logs a single SHORT line instead, with no `tick=` field —
   one of:
   - `already running (<reason>) — skipping this tick` — another invocation was still in progress.
   - `budget exhausted for <week>` — the weekly cap is already spent; no run row was even opened.
   - `plan CLI failed: <message> — skipping this tick` — the read-only queue lookup itself failed
     (a timeout, a launch failure); nothing was spent, try again tomorrow.

   A tick that ran out of API balance mid-run logs TWO lines: an immediate
   `BALANCE DEPLETED — reload required` the moment the billing error is detected, followed by the
   normal per-tick summary line (ending in `[BALANCE DEPLETED]`) once the tick finishes closing out
   whatever it already recorded. **A `--dry-run` invocation writes NO log line at all** — it never
   touches the log, the database, or the API; see "Dry-run usage" below.

   If the most recent entry in the latest log file is more than ~24 hours old, the scheduled task
   itself has stopped firing (check Task Scheduler's History tab, not this repo).

2. **`npm run status`'s SUMMARY SCHEDULER block.** This is the real ledger — **there is no
   separate `billing-ledger.json` file; it does not exist anywhere in this codebase.** The ground
   truth for "did this actually spend money?" is the `ingestion_runs` table itself
   (`source='scheduled-summaries'` rows), and `scripts/data-status.js` reads it live, on every
   invocation, and prints:
   ```
   SUMMARY SCHEDULER
     last tick ........................ 2026-08-16T11:03:22 status=succeeded
     spent this week ................. $1.23 of $5.00
     published this week ............ 2
   ```
   (the `parked (structural failures)` line only appears at all once the parked count is above
   zero — omitted here since a fresh scheduler has parked nothing yet)

   Nothing "refreshes" or "pushes" these numbers from inside the scheduler — `data-status.js`
   queries Postgres directly, itself, every time you run it, the same way it reports every other
   number in that report. Read it when a tick logs `BALANCE DEPLETED — reload required`, or any
   time you want a live answer to "what has this thing actually spent?"

## What `BALANCE DEPLETED — reload required` means

The Anthropic API balance has run out mid-tick. The scheduler will continue running one tick per
day; each future tick will still open a run row and attempt its assembled lane, but the FIRST
billing error it hits will stop that tick immediately (see "What it does" step 4) — so spend stays
bounded at whatever one bill's chain cost before the error, never compounding. **Nothing breaks,
nothing needs cleanup** — the `ingestion_runs` ledger records the honest attempt, and the scheduler
is ready the moment you reload credits.

To resume:

1. **Reload your Anthropic API balance** via your Anthropic account console.
2. **No code changes needed.** The next tick (tomorrow morning) will pick up where it left off,
   probing the balance again on its first billable API call.

## Unparking a bill

If a bill is parked (marked as permanently unpublishable due to structural incompleteness,
recorded in `.superpowers/artifacts/scheduled-summaries/parked.json`), it will never be
attempted again. To unpark it (e.g., after a verifier gate fix or a text source improvement):

1. Open `.superpowers/artifacts/scheduled-summaries/parked.json`.
2. Find the bill's row (keyed by `bill_id`).
3. Delete that entire row.
4. The next tick will see the bill as unsummarized again and attempt it.

The parked set is kept as a JSON file (not a database table) so it can be edited locally without
server access, and so a decision to unpark survives power loss and reboots (unlike an in-memory
registry). If `parked.json` exists but can't be read on a given tick (corrupt, a transient
filesystem error), that tick treats the park list as UNKNOWN for its own purposes rather than
silently empty — it will not merge-write over a file it couldn't actually read, so a newly
park-worthy bill from that same tick simply doesn't get parked yet (logged honestly; it gets parked
on a future healthy tick instead). This exists specifically so a transient read glitch can never
silently un-park (and therefore cause a wasted re-attempt of) every bill already on the list.

## Dry-run usage

Test the scheduler without spending API balance or writing any ledger updates:

```
node --env-file=.env scripts/scheduled-summaries.js --dry-run
```

This will:

- Acquire and release the lock (full ownership-checked lifecycle).
- Compute the real weekly/tick allowance and assemble the tick's lanes in real priority order
  (fresh, conversions, at most one monster) — using the SAME plan CLI, the SAME queue data, and the
  SAME lane-assembly logic a live tick would.
- Spend **zero dollars** (no Anthropic client is even constructed on `--dry-run` — see `main()`).
- Open **no run row** in the database, write **no log line**, and spawn **no `record` child
  process**.
- Report the assembled lanes, computed allowance, and weekly spend — what the next live tick would
  actually work with — **without making any writes or API calls.**
- Exit 0.

Dry-run is safe to run while the scheduled task is running; it will skip if the lock is already
held (logging `already-running`, same as a real tick would). The report includes the real queue and
budget state, so it can be run multiple times a day without side effects.

## Recovery properties

**Checkpoints are per-stage files, not ledger rows — and they DO cause the SAME bill to be
retried, not skipped.** Every completed (paid) chain stage — author, verify, provisions, coverage —
is written immediately to its own JSON file under
`.superpowers/artifacts/scheduled-summaries/stages/<bill_id>-<hash8>.json`
(`saveCheckpoint`/`loadCheckpoint` in `src/lib/billed-summary-chain.js`), keyed so a text revision
(a new hash) invalidates the old checkpoint automatically. If a tick crashes partway through a
bill's chain, that bill was never handed to `record` (only a fully-completed chain produces an
envelope), so it is simply still unsummarized (fresh lane) or still draft-only (conversion lane) —
the VERY NEXT tick will see it as eligible again, re-queue it, and re-attempt it. When it does,
`runBillChain`'s own checkpoint load finds whatever stages already completed and skips straight
past them, paying only for the stages that are still missing. This is the actual recovery
guarantee: **a crashed bill is retried, cheaply, not abandoned and not re-paid for from scratch.**

**Lock reclaim:** A lock older than its own declared max duration (30 minutes,
`TICK_MAX_DURATION_MS`) is automatically reclaimed on the next tick that finds it stale, with a
warning logged. This handles power loss or forced kills. You can also delete
`.superpowers/artifacts/summary-scheduler.lock.json` by hand at any time if you want a clean next
tick immediately rather than waiting for it to age out. (Again: this 30-minute figure is the
RECLAIM window a later tick uses, not a self-terminating deadline for the current one — see the
Task Scheduler section above for what actually bounds a stuck tick.)

**Conservative crashed-tick ledger charge:** If the scheduler is killed mid-run (Windows timeout,
power loss, etc.) and its `ingestion_runs` row is left at `status='running'`, the NEXT tick's own
weekly-spend calculation (`summarizeWeekSpend`) counts that stranded row as having spent the FULL
per-tick cap default ($1.00) against the weekly ledger — never less, even if that later tick happens
to be running under a manually-lowered `SUMMARY_TICK_CAP_USD` itself (fixed in this review's pass:
the charge now always uses `Math.max(this tick's own cap, the code default)`, so a throttled manual
tick can never retroactively under-charge an earlier crash that ran under the real cap). This is
deliberately conservative — a bill that crashed stays in draft/unsummarized state and waits for a
future retry (see "Checkpoints" above), never vanishing or succeeding on a lie, and never letting an
unknown amount of prior spend be undercounted.

**A throwing plan CLI or record CLI no longer crashes the whole tick.** Both are wrapped in their
own try/catch: a throwing plan call is logged and returns a clean `plan-failed` outcome with no run
row ever opened; a throwing record call (mid-tick, after a run row IS already open) is logged,
recorded as a skip in that run's own detail, and the tick still closes its `ingestion_runs` row
honestly rather than leaving it stranded at `running` with no diagnostic trail at all. In both
cases, `main()` still exits 0 — an expected, logged stop, not a Task-Scheduler-visible crash.

## How to pause / remove it

```
schtasks /change /tn "VisibleGov Scheduled Summaries" /disable   # pause (keeps the registration)
schtasks /change /tn "VisibleGov Scheduled Summaries" /enable    # resume
schtasks /delete /tn "VisibleGov Scheduled Summaries" /f         # remove entirely
```

If the machine ever loses power mid-run, the lock file self-heals: a lock older than its own
declared max duration (30 minutes, `TICK_MAX_DURATION_MS`) is automatically reclaimed on
the next tick, with a warning logged. You can also delete
`.superpowers/artifacts/summary-scheduler.lock.json` by hand at any time if you want
a clean next tick immediately rather than waiting out the stale-reclaim window.

## Status

All 7 build tasks are complete, plus a final whole-branch review and its fix wave (this document
was rewritten section-by-section against the live code as part of that pass). The full test suite
is green in a clean shell. What remains, in order:

1. Load Anthropic API credits via your console (the billed path has been closed since the
   2026-08-09 balance depletion — see `CLAUDE.md`'s standing-policy section).
2. Run the ONE throttled manual tick described above ("Before you register").
3. Confirm it via `npm run status` and the day's log file.
4. Run the registration `schtasks` command above (Lance's step — an agent never runs it).
5. Monitor the logs and the SUMMARY SCHEDULER block as the scheduler begins its daily runs.
