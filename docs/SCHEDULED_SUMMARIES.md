# Scheduled summaries - `scripts/scheduled-summaries.js`

The autonomous bill-summary runner designed to run **unattended, on Lance's machine, every day**,
under a strict, code-enforced budget cap ($5.00 per ISO week, $1.00 per tick). This doc is what lets
him register it (his own step - an agent never runs `schtasks`) and is what he uses to keep an eye
on it now that it's running.

**Every claim in this document was re-verified directly against `scripts/scheduled-summaries.js`
and `src/lib/billed-summary-chain.js` during the final whole-branch review's fix wave (this pass
replaced roughly a dozen claims that had drifted false, several of them carried over verbatim from
`docs/SCHEDULED_INGESTION.md`'s description of a DIFFERENT script with different mechanics). If
this script changes again, re-check this doc against it - do not trust prose over code.**
(Re-checked 2026-08-23 against the live task, the live `ingestion_runs` rows, and the code at
commit 2e420d9; every correction from that pass is marked inline with its date.)

**Policy linkage (CLAUDE.md "Standing policies"):** this runner's ledger + caps ARE the standing
per-run approval for billed calls - for `scripts/scheduled-summaries.js` ONLY. Every other billed
call in this repo still needs Lance's explicit per-run go with a cost stated. Funding context,
in flight as of 2026-08-23: the API balance hit $0 on the evening of 2026-08-21 (spent by the
USC glossary drain, not by this runner) and Lance reloaded about $7 the same evening; the
2026-08-22 tick confirmed the reload took. At the measured ~$0.33-0.39 per tick that is roughly
19 ticks - two to three weeks - if nothing else bills. Nothing in this repo can read the balance - the
Anthropic console is the only truth for it; `npm run status` knows only what THIS runner has
spent against its own cap.

## What it does

Each invocation (one tick, typically once a day, early morning):

1. Takes a single-instance, ownership-checked lock
   (`.superpowers/artifacts/summary-scheduler.lock.json`, pid + a random nonce + a declared max
   duration - the exact same `acquireLock`/`releaseLock` mechanism `scheduled-ingest.js` uses,
   reused, not reimplemented). If another invocation already holds it, this one logs
   `already running (<reason>) - skipping this tick` and exits 0 - that is a **normal**, expected
   outcome, never a failure. A lock older than its own declared max duration (30 minutes,
   `TICK_MAX_DURATION_MS`) is reclaimed as stale by whichever LATER tick finds it that way - see
   "Recovery properties" below for exactly what that constant does and does not enforce.
2. Computes this ISO week's spend from `ingestion_runs` rows (`source='scheduled-summaries'`,
   last 10 days) and checks it against the weekly cap (`SUMMARY_WEEKLY_CAP_USD`, $5.00 default) and
   per-tick cap (`SUMMARY_TICK_CAP_USD`, $1.00 default). **The week is the UTC ISO-8601 week**
   (`currentWeekKey`: Thursday-anchored, keys like `2026-W34`), so the $5.00 window resets at
   **Monday 00:00 UTC** - Sunday evening Central - never on a local-calendar boundary. A Monday
   6 AM Central tick is already the new week's first tick and opens at $0.00 spent (2026-W34 was
   2026-08-17..23; the 2026-08-24 tick opens 2026-W35). If the remaining allowance for this tick
   would fall below the smallest plausible bill cost (`WORST_BILL_FLOOR_USD`, $0.05), the tick ends
   right here: it logs `budget exhausted for <week>` and exits 0 - **no run row is opened, nothing
   is spent.**
3. Asks `src/cli/summary-queue.js plan --dry-run` (a separate, read-only, $0 child process - no
   API calls; given a 15-minute child timeout instead of the 8-minute default every other child
   in this repo gets, because plan mode loads every bills/votes/bill_texts/summaries row) for
   the queue of summarizable bills, **then re-sorts it recency-first** (`sortQueueRecencyFirst`:
   the bill's session `start_date` descending, then passage priority, then smallest text first)
   so current-session bills sit at the head of the paid queue. The recency key is
   `sessions.start_date`, falling back to the year parsed from the session's identifier/name
   (`src/lib/session-dates.js`); a bill whose session has neither sorts last, and if any queued
   bill is in that state the tick logs a second line - `WARNING: N of M queued bills have no
   session recency key ... run src/cli/sync-session-dates.js`. **Data dependency:** re-run
   `node --env-file=.env src/cli/sync-session-dates.js` (dry-run first, then `--apply`) whenever
   a new session is minted - the session-minting drivers still write no `start_date`. (Found
   2026-08-21: 30 of 31 MO sessions were undated, so the recency sort had silently degraded to
   passage-then-smallest-first for every tick since launch; the `--apply` ran late that evening
   - run `0fb39207`, 04:10Z on 08-22, 30 dates written - and the 2026-08-22 tick confirmed all
   12 lane bills were 2026-session.) It then splits the sorted queue into
   **fresh** (unsummarized, ≤100,000 chars), **conversion** (draft-only bills that already have mechanical
   verifier objections on file - a re-author lane, capped at the 50 oldest-flagged
   `MAX_CONVERSIONS_EXAMINED` per tick so hundreds of routinely-ineligible drafts don't get
   re-examined forever), and **monster** (unsummarized, >100,000 chars, at most one per tick)
   lanes, in that priority order.
4. For each bill in the assembled tick, in order: two-to-three CHEAP, unbilled pre-bill checks run
   BEFORE the first paid call - (a) a general "can we still afford another bill at all" guard based
   on the worst bill actually observed so far this tick; (b) for the one monster lane, an extra
   1.5x-headroom check; (c) a conservative cost estimate computed from the bill's own text length
   (`estimateBillCostUsd`), checked against the allowance still remaining. A bill that fails any of
   these is skipped - honestly recorded in the run's `skipped` list, no API call ever made for it.
   A bill that passes all of them runs the full chain (`src/lib/billed-summary-chain.js`: Haiku
   author -> Sonnet verify -> Sonnet provisions -> **(conditional) Sonnet provisions-corroboration**
   -> Sonnet coverage, or Haiku re-author for the conversion lane), checkpointed per stage as it
   goes (see "Recovery properties"). The corroboration stage (added 2026-08-18, spec
   `docs/superpowers/specs/2026-08-18-completeness-floor-corroboration-design.md`) fires only
   when the provisions yield is at least 1 but under the length-scaled floor
   (`minKeyProvisionsFor` in `src/lib/verifier.js`: 1 under 2,500 chars, 2 under 5,000, else
   3) - one independent blind re-extraction with the same prompt, 4,000 `max_tokens`; the record
   gate then accepts the thin check only if the two runs mechanically agree. Its output rides
   the envelope as `completeness_corroboration`. `estimateBillCostUsd` was deliberately NOT
   raised for it - one provisions-sized call sits inside the estimator's existing padding.
   **There is no mid-chain budget check** - once a bill's chain starts, it runs to completion (or throws); the
   caps are enforced entirely by deciding whether to START a bill, never by interrupting one
   partway through, and never by shrinking any one call's own token ceiling (every stage's
   `max_tokens` is a fixed constant - 16,000 for the Haiku author, 32,000/4,000/4,000/3,000 for
   the Sonnet verify/provisions/corroboration/coverage stages - independent of how much budget
   remains).
5. Hands every bill that produced a real result to `src/cli/summary-queue.js record` (a separate
   child process per lane - the ONLY thing that ever writes a summary row; this script never writes
   to `summaries` directly), which runs the same mechanical publish/flag gates every other
   summarization path in this repo goes through.
6. Closes the `ingestion_runs` row it opened at step 3/4 with an honest status (`succeeded` if
   everything it attempted published or hit only a routine, expected skip; `partial` if anything
   genuinely anomalous happened - a hash mismatch, an oversize text, an insufficient cost estimate,
   a non-billing chain error, a crashed record CLI, or the API balance running out) and a detail
   object (spend, published/gate-refusal/record-failure counts, per-lane counts, the full skip
   list). Appends one dated log line - see "Reading the logs" below for the exact shapes.
   **In practice every tick closes `partial`** - every live tick since 2026-08-17 has. The
   pre-bill estimate guard skips the couple of thousand queued bills a $1 tick cannot fund, and
   those skips count as non-routine (only the conversion lane's no-objections skip carries
   `routine: true`), so `partial` is the steady state for as long as the queue is deeper than one
   tick's budget; `succeeded` has never occurred live and cannot until the queue fits in a tick.
   Read `partial` as healthy. The real anomaly signals live in the detail object: any `skipped`
   reason that is NOT the `pre-bill cost estimate` one, a non-zero `record_failures`,
   `balance_depleted: true`, or counts out of line with the baseline under "Reading the logs".

## What it will never do

- **Never calls a model without limits - but the limits are enforced by DECIDING, not by
  shrinking.** The code enforces both caps (weekly and per-tick) mechanically; an env override
  (`SUMMARY_WEEKLY_CAP_USD` / `SUMMARY_TICK_CAP_USD`) can only LOWER them below the code default,
  never raise them above it (`envCapUsd` computes `Math.min(override, default)` - a ceiling at the
  default, not a floor at it). Every API call's own token budget (`max_tokens`) is a FIXED constant
  per stage, never derived from remaining budget - the caps work entirely by refusing to START a
  bill whose conservative cost estimate the remaining allowance can't cover (see "What it does"
  step 4), not by shrinking any individual call.
- **Never runs without the API key deployed.** If `ANTHROPIC_API_KEY` is not set (and this isn't
  `--dry-run`), the script logs `ANTHROPIC_API_KEY not set - exiting without a tick` and exits 0
  with no spend - a plain runtime check in `main()`, not a structural "the SDK is never imported"
  guarantee the way `scheduled-ingest.js` makes for itself: this file DOES import
  `@anthropic-ai/sdk` unconditionally, because (unlike the ingestion scheduler) it exists
  specifically to make billed calls once the key is present.
- **Never lets one broken bill starve the rest of the tick.** The tick assembles a full lane list
  (fresh, then conversions, then at most one monster) and works through ALL of it, not just one
  bill. A non-billing error on any one bill (network hiccup, a schema 400, a refusal) is caught,
  recorded as an honest skip with the real error message, and the loop moves on to the next bill -
  the checkpoints for whatever paid stages that bill DID complete stay on disk either way (see
  "Recovery properties"). Only a genuine BILLING error (a 400/402 with credit/balance/payment
  language) stops the whole tick early - deliberately, since continuing to spend once the account
  is out of money would be worse than stopping.
- **Never creates overlapping processes.** The single-instance lock (see step 1) prevents two
  concurrent runs; its release is ownership-checked (nonce-based), so a lock can never be deleted by
  a process that doesn't own it. `TICK_MAX_DURATION_MS` (30 minutes) is **not** a self-enforced
  deadline that terminates a stuck tick - it is only the duration a LATER tick uses to decide an
  existing lock is stale enough to reclaim. The actual thing that can kill a runaway tick is
  Windows' own Task Scheduler "Stop the task if it runs longer than" setting - see that section
  below for why the two numbers need to agree.
- **Never writes summary rows directly to the database.** Every write goes through spawning
  `src/cli/summary-queue.js record` as a separate child process (the `recordLane` function), whose
  mechanical gates (schema validation, hash-provenance, citation checks, completeness checks) are
  exactly the same ones every other summarization path in this repo uses - nothing scheduler-specific
  is exempted.
- **Never crashes silently on the paid path.** A throwing plan-CLI call, a throwing record-CLI
  call, and a throwing bill chain are all caught, not left to propagate - each lands as an honest
  log line and/or a recorded skip rather than an uncaught exception that would exit the process
  with no diagnostic trail (see "Recovery properties" and the fix-wave notes below). **The one
  exception (noted 2026-08-23): the pre-tick DB calls are not wrapped** - `selectRecentRunsReal`
  (`ingestion_runs`), `loadSessionStartByBillReal` (`sessions` + `bills`),
  `loadSummaryRowsReal` (`summaries`), and the `openRun` insert itself each throw on a Supabase
  error, and that throw propagates
  out of `runTickLocked` (the lock is still released by its `finally`) to `main().catch`, which
  prints to stderr and exits 1 - **no log-file line at all**, and under the InteractiveToken
  console window the stderr vanishes when the window closes. All four run before the first paid
  call, so nothing is spent and no run row is stranded; the only trace is Task Scheduler's "Last Result"
  being non-zero (History tab). A day with no log entry is therefore ambiguous between "the task
  never fired" and "a pre-tick DB call failed" - check Last Result before concluding either.

## Budget is real - these caps are published Terms of Service with yourself

`SUMMARY_WEEKLY_CAP_USD` (default $5.00) and `SUMMARY_TICK_CAP_USD` (default $1.00) are
**hard, code-enforced limits**, not suggestions. They are defined in `scripts/scheduled-summaries.js`
(`WEEKLY_CAP_USD`/`PER_TICK_CAP_USD`) and are env-overridable via `envCapUsd()`, downward only - a
typo'd env var can shrink spend, never grow it (`Math.min(override, default)`: the default is a
ceiling the override can only fall below, never exceed). **Do not edit the code to bypass them.**

A crashed/stranded tick (`status='running'` left behind by a hard kill) is always charged the FULL
code-default per-tick cap against the weekly ledger - conservatively assuming the worst, and never
using a possibly-lowered cap from whichever tick happens to be doing the charging (fixed in this
review's pass: a throttled manual tick run under a lowered `SUMMARY_TICK_CAP_USD` used to be able
to under-charge a PRIOR crashed tick that actually ran under the real $1.00 cap).

## The registry

| Parameter | Default | Meaning |
|---|---|---|
| `SUMMARY_WEEKLY_CAP_USD` | $5.00 | Hard weekly budget; env override can only lower it, never raise it |
| `SUMMARY_TICK_CAP_USD` | $1.00 | Hard per-invocation budget; env override can only lower it, never raise it |
| `TICK_MAX_DURATION_MS` | 30 minutes | The lock's own declared stale-reclaim duration - how long a LATER tick waits before treating an existing lock as abandoned. NOT a self-terminating deadline for the CURRENT tick - see the Task Scheduler section below for what actually bounds a stuck tick |
| `MAX_CONVERSIONS_EXAMINED` | 50 (not env-overridable) | How many draft-only bills the conversion lane examines per tick, oldest-flagged first, before assembling the rest of the tick |
| `WORST_BILL_FLOOR_USD` | $0.05 | The floor a tick's remaining allowance must clear just to open a run row at all |

## If you ever re-register from scratch: one throttled manual tick first

**(Superseded 2026-08-17 as an open instruction: the runner went live that day - see "Status" -
and has made paid calls on every tick since. This procedure now applies to a fresh registration
on a rebuilt machine or after a long disable, not to any step anyone still owes.)** The runner
is tested end-to-end against fakes (`tests/scheduled-summaries.test.js`); before (re-)registering
the daily task, run exactly one deliberately throttled manual tick by hand - this is Lance's
own step; do not run it on his behalf:

```
SUMMARY_TICK_CAP_USD=0.70 node --env-file=.env scripts/scheduled-summaries.js
```

(PowerShell equivalent, if not using Git Bash: `$env:SUMMARY_TICK_CAP_USD = "0.70"; node --env-file=.env scripts/scheduled-summaries.js`)

**The cap must be at least ~$0.67, and $0.70 is the deliberate choice.** The pre-bill cost
estimator (`estimateBillCostUsd`) adds a fixed output-ceiling constant of $0.665
(`COST_ESTIMATE_OUTPUT_CEILING_USD`) to every bill regardless of its size, so **no bill ever
estimates below ~$0.67** - a cap under that skips every bill before any paid call and spends
exactly $0. (Verified live 2026-08-17: the first manual tick was run at this section's earlier
$0.10 figure and scanned 2,269 bills, skipped all of them on the estimate guard, and spent
$0.0000 - safe, but useless as a first live test. This section originally claimed "$0.10 is
enough to fund one small bill"; that was wrong.) $0.70 admits exactly one small bill
(text ≲ 20k chars) and leaves essentially no headroom for a second: after the first bill's real
spend, the remaining allowance falls below the $0.665 floor, so every later bill is skipped.
The estimate is a deliberately padded worst-case ceiling - the real spend for one small bill is
on the order of $0.04, not $0.67. After it finishes:

1. Check `npm run status`'s **SUMMARY SCHEDULER** block - it should show a `last tick` entry with
   today's date, a real `spent this week` figure above $0.00, and (if the one bill it attempted
   published cleanly) `published this week` at 1.
2. Check the day's log file under `.superpowers/artifacts/summary-scheduler-logs/` - one line
   should appear, of the `tick=<id> attempted=<roughly the whole queue> published=... spent=$...`
   shape described under "Reading the logs" below. `attempted` counts every bill the per-bill
   loop examined, INCLUDING the unpaid estimate-guard skips, so it reads in the thousands, not 1
   (corrected 2026-08-23; the 2026-08-17 $0.70 tick actually logged `attempted=2269 published=1
   gate_refusals=1 spent=$0.0474`). The bills actually funded are the run row's `detail.lanes`
   and `per_call_count`.
3. Only once both of those look right, proceed to registration below (and remember to unset
   `SUMMARY_TICK_CAP_USD` afterward, or the daily runs will stay throttled to $0.70/tick - a real
   per-tick budget of $1.00 needs the env var absent, not present-and-small).

## Registering it (Lance's step - never run `schtasks` from an agent)

Run every day at 6 AM local time. The exact schedule is your call; 6 AM was chosen to
(a) avoid overnight API rate-limit surprises and (b) give you a daily morning summary to review.

> **Status: REGISTERED and running daily since 2026-08-17** (superseded 2026-08-23: the original
> "NOT YET REGISTERED" note here stood from the build until registration day). Live
> `schtasks /query` on 2026-08-23: Enabled, Daily 6:00 AM, Start Date 8/17/2026, Last Result 0,
> Next Run 8/24/2026, and one `ingestion_runs` row per day from 2026-08-18 on (08-17 itself
> holds the three hand-fired ticks). Keep this command for
> re-registration after a machine rebuild - see "Status" at the bottom for activation day.

**Command line - use Command Prompt, NOT PowerShell.** (Start menu -> type `cmd` -> "Command
Prompt". Windows 11's default terminal is PowerShell, where this command's quoting breaks
silently.) One single line, paste it whole, press Enter. No administrator elevation needed.
Adjust the `node.exe` path only if `where node` prints something different.

```
schtasks /create /tn "VisibleGov Scheduled Summaries" /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-summaries.js" /sc daily /st 06:00 /f
```

**Both the `--env-file` path and the script path are absolute here - that matters.**
`schtasks /create` runs the scheduled task with its working directory set to
`%SystemRoot%\system32`, not the repo - a RELATIVE `--env-file=.env scripts\scheduled-summaries.js`
(the earlier form of this command) would resolve against `system32` and fail to find either file.
Only `node.exe`'s own path needs to be absolute for THAT reason alone; the `--env-file` and script
arguments need it too, for the same reason. (Earlier text here also recommended setting "Start
in" to `F:\VisibleGov` via the GUI as a belt-and-braces second safety net - **superseded
2026-08-23: on this machine the GUI cannot save this task at all** (see "Modifying this task"
below), so that click is not possible; live `schtasks /query` shows `Start In: N/A` and it was
never set. Nothing depends on it thanks to the absolute paths. If you ever want it anyway, add
`<WorkingDirectory>F:\VisibleGov</WorkingDirectory>` inside `<Exec>` in the saved XML and
re-create from that.)

Expected output: `SUCCESS: The scheduled task "VisibleGov Scheduled Summaries" has successfully
been created.`

- `/sc daily /st 06:00` - runs every day at 6:00 AM.
- No `/ru` flag - runs as your own account, only while you're logged on (no password needed).
  If you want it to run even while logged out, use the Task Scheduler GUI after creating it
  (this same command; General tab -> "Run whether user is logged on or not," which will prompt
  for your password once). **This is what Lance should do** if he wants the runner truly
  hands-off across reboots.
- `/f` overwrites a prior registration with the same name - safe to re-run this command if you
  ever change the schedule or the cap values.
- **Flags the registration carries silently** (from the XML `schtasks /create` produced, verified
  2026-08-23 against the live task): `DisallowStartIfOnBatteries=true` and
  `StopIfGoingOnBatteries=true` - a tick will not start, and a running one is killed, on battery
  power (moot on a desktop; it matters the day this runs on a laptop or a UPS reports "on
  battery", and a kill from there is the same stranded-lock / `running`-row case as the
  console-window kill below); `MultipleInstancesPolicy=IgnoreNew` - Task Scheduler's own second
  overlap guard, alongside the script's lock file; `StartWhenAvailable=true` (set by XML
  re-create 2026-08-17, see "Missed runs"); no `ExecutionTimeLimit` element (72-hour default,
  next section).
- **Triggering a tick by hand through the real Task Scheduler environment:**
  `schtasks /run /tn "VisibleGov Scheduled Summaries"`. This is a REAL, full-budget paid tick (up
  to $1.00), not a dry run, so it is Lance's call, never an agent's. Done once with his explicit
  go on 2026-08-17 (tick d744297c, 24 paid calls, $0.4836) to validate the registered pathway
  end-to-end; it is also the way to make up a missed day by hand. Expect the black node console
  window (section below) and leave it alone.

**GUI equivalent**, if preferred: Task Scheduler -> Create Task -> General: name it "VisibleGov
Scheduled Summaries"; Triggers -> New -> "On a schedule" -> Daily at **06:00** (or your preferred
time); Actions -> New -> Program: `C:\Program Files\nodejs\node.exe`, Arguments:
`--env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-summaries.js`, Start in:
`F:\VisibleGov` (optional - see the superseded "Start in" note above; and note the GUI could not
save this task on this machine once it existed, see "Modifying this task" below).

### Check the task's own "Stop the task if it runs longer than" setting - it must EXCEED 30 minutes

This is a **separate setting from everything above** - it's Windows' own execution-time limit on
the *whole scheduled task*, not anything this script controls. The `schtasks /create` command
above does not set it explicitly, so **check it via the GUI after creating the task**: Task
Scheduler -> find "VisibleGov Scheduled Summaries" -> Properties -> **Settings tab** -> "Stop the task
if it runs longer than."

**This Windows setting is the ACTUAL, real deadline that can kill a stuck tick.**
`TICK_MAX_DURATION_MS` (30 minutes, inside the script) is NOT a self-enforced deadline for the
CURRENT tick at all - it only controls how long a LATER tick waits before deciding an existing lock
file is abandoned and safe to reclaim. If Windows' own setting is *shorter* than 30 minutes, it can
kill a legitimate in-progress tick before this script's own lock even reaches its stale-reclaim
window - and because that kill comes from OUTSIDE the script (not the script's own `finally`
block), the lock is never released by its normal path (it still self-heals eventually, once a later
tick finds it stale - see "Recovery properties" - but the current tick's `ingestion_runs` row can
be left `running` and get conservatively charged the full per-tick cap by the next week's ledger
math).

**Recommendation: uncheck "Stop the task if it runs longer than" entirely, or set it to at least
1 hour (comfortably above the 30-minute `TICK_MAX_DURATION_MS`).** Windows' own setting is the real
enforcement here; the in-script constant only needs to stay well under it so the stale-reclaim
window and the OS-level kill can never race each other in a confusing way.

(Registration-day verification note, 2026-08-17: the task XML the `schtasks /create` command
actually produces contains NO `ExecutionTimeLimit` element at all, and Task Scheduler's default
for that absence is 72 hours - already comfortably above 30 minutes. So on a fresh registration
this setting is fine as-is; the check above matters if anyone ever edits the task in the GUI,
where the dialog re-imposes its own defaults.)

### Missed runs: check "Run task as soon as possible after a scheduled start is missed"

`schtasks /create` does NOT set this (`StartWhenAvailable` is absent from the produced XML,
which means OFF), and this machine is shut down regularly - **with it off, any day the PC is
powered down at 6 AM simply gets NO tick that day**, silently. Turn it on via the GUI: Task
Scheduler -> "VisibleGov Scheduled Summaries" -> Properties -> **Settings tab** -> check **"Run
task as soon as possible after a scheduled start is missed."** Then a missed 6 AM run fires
shortly after the next boot/logon instead of being dropped.

This is safe by design: a catch-up tick is just a normal tick - the lock file prevents overlap,
the weekly ledger is computed from `ingestion_runs` (not from run *count*), and the per-tick cap
binds regardless of what time the tick actually fires. Worst case, two ticks land on the same
calendar day (a late catch-up plus the next 6 AM) - both stay under the same weekly $5.00 cap,
so the spend guarantee is unchanged. Note it fires IMMEDIATELY on registration too: the moment
this setting was turned on (2026-08-17, ~9:03 AM, after the 6:00 start had already passed),
Task Scheduler treated that day's start as missed and launched a catch-up tick on the spot.

### Modifying this task on THIS machine: GUI and `Set-ScheduledTask` both fail - use XML re-create

Both interactive modification routes are broken for this task (verified live, 2026-08-17):

- **The GUI** loads the Properties dialog fine but errors on OK with *"One or more of the
  specified arguments are not valid"* - it re-validates and rewrites the entire task on save
  and chokes on elements it didn't author (likely the quoted `Command` and/or the raw-SID
  `UserId` the original `schtasks /create` wrote).
- **PowerShell `Set-ScheduledTask -InputObject`** fails with *"The parameter is incorrect.
  (23,8):UserId"* - same root cause, surfaced by the cmdlet's own re-registration validation
  of the stored SID principal.

**The route that works is re-creating from exact XML** (the same path that created the task):
edit the saved copy at `.superpowers/artifacts/scheduled-summaries-task.xml` (or re-export with
`schtasks /query /tn "VisibleGov Scheduled Summaries" /xml > file.xml`, saved as UTF-16 to
match its declaration), then:

```
schtasks /create /tn "VisibleGov Scheduled Summaries" /xml "F:\VisibleGov\.superpowers\artifacts\scheduled-summaries-task.xml" /f
```

`/f` overwrites in place. This is how `StartWhenAvailable` was actually turned on. The saved
XML stays out of git (`.superpowers/artifacts` is gitignored - it contains the machine SID).

### The tick runs in a VISIBLE console window while you're logged on - closing it KILLS the tick

The task runs with `LogonType InteractiveToken` ("only while logged on"), so every tick opens
a black node console window on the desktop. **Closing that window (or Ctrl+C in it) terminates
the tick mid-run** - exit code 0xC000013A. This happened live on 2026-08-17: the
registration-moment catch-up tick popped its window, the window was closed, and the tick died.
It died BEFORE opening its run row, so that particular kill cost $0.00 and charged nothing -
but a kill later in a tick strands the lock (self-heals in 30 min, or delete it by hand) and a
`running` run row (conservatively charged the full $1.00 by next tick's ledger math, by
design). So: **when a black node window appears at tick time, leave it alone - it closes
itself when the tick finishes.** The permanent fix is switching the task to "Run whether user
is logged on or not" (no window at all, and ticks run while logged out): per the section
above, the GUI can't save this task, so do it by re-creating from the saved XML with
credentials - `schtasks /create /tn "VisibleGov Scheduled Summaries" /xml "F:\VisibleGov\.superpowers\artifacts\scheduled-summaries-task.xml" /ru LAZREX\Lazrex /rp * /f`
(the `/rp *` prompts for the account password once; requires the account to actually have a
password).

## Reading the logs

Two places to check, and they answer different questions:

1. **The log file.** `.superpowers/artifacts/summary-scheduler-logs/YYYY-MM-DD.log` (gitignored,
   one entry per tick, occasionally two - see below). **The date in the filename is UTC, not local
   time** - Central time is 5-6 hours behind UTC, so any time after ~7pm Central, "today's" log
   entries are already landing in *tomorrow's* dated file. If the file you'd expect looks stale or
   is missing entirely, check the next day's filename before assuming the scheduler stopped.

   A normal, successful tick logs one summary line, of this shape (plus one `WARNING: N of M
   queued bills have no session recency key ...` line before it if any queued bill's session has
   neither a `start_date` nor a parseable year - see "What it does" step 3; that warning means run `src/cli/sync-session-dates.js`,
   not that the tick failed; corrected 2026-08-23 from "exactly ONE line"):
   ```
   2026-08-23T11:04:47.004Z tick=<run-id> attempted=2188 published=4 gate_refusals=2 spent=$0.3530 week=2026-W34 total=$2.6980/5.00
   ```
   (a real line from the 2026-08-23 tick; the leading timestamp is when the tick FINISHED, not
   when it started; `attempted` counts every bill examined, including the ~2,000 unpaid
   estimate-guard skips - the bills actually funded are `detail.lanes` / `per_call_count` on
   the run row). A tick that stopped
   early for a normal, expected reason logs a single SHORT line instead, with no `tick=` field -
   one of:
   - `already running (<reason>) - skipping this tick` - another invocation was still in progress.
   - `budget exhausted for <week>` - the weekly cap is already spent; no run row was even opened.
   - `plan CLI failed: <message> - skipping this tick` - the read-only queue lookup itself failed
     (a timeout, a launch failure); nothing was spent, try again tomorrow.

   A tick that ran out of API balance mid-run logs TWO lines: an immediate
   `BALANCE DEPLETED - reload required` the moment the billing error is detected, followed by the
   normal per-tick summary line (ending in `[BALANCE DEPLETED]`) once the tick finishes closing out
   whatever it already recorded. **A `--dry-run` invocation writes no per-tick summary line and
   no run row** - but it CAN still log the short `budget exhausted for <week>`,
   `plan CLI failed: ...`, or session-key `WARNING:` lines, exactly as a live tick would at those
   same points, because all three sit before the dry-run early return (corrected 2026-08-23;
   earlier text said "no log line" at all). It reads the database but never writes to it and
   never touches the API (if the lock is already held it logs
   `already running (<reason>) - skipping this tick`, same as a real tick would); see "Dry-run
   usage" below.

   If the most recent entry in the latest log file is more than ~24 hours old, either the
   scheduled task itself has stopped firing OR a pre-tick DB read threw before anything was
   logged (see "Never crashes silently" above - that path exits 1 with stderr only). Check Task
   Scheduler's History tab / "Last Result" first: a run with a non-zero Last Result and no log
   line means the task fired and died on a pre-tick read; no run at all means it never fired.
   Neither question is answered by anything in this repo.

   **What healthy looks like** (baseline from the live ticks 2026-08-18..23 - re-measure rather
   than trusting these past a few weeks): one tick a day starting 11:00Z and finishing ~11:05Z
   (08-18's started 46 minutes late, at 11:46Z); `status=partial`
   every time (see "What it does" step 6); `attempted` ≈ the whole queue (~2,200);
   `detail.lanes.fresh` 6-12 bills funded, `conversion` 0 so far (the conversion entries sit
   BEHIND the ~2,200 fresh entries in the loop, so by the time one is reached the remaining
   allowance is already under the estimator's floor - the $0 drain lane has been re-authoring
   the draft pool instead), `monster` 0; 24-48 paid calls; spend ~$0.33-0.39 per tick; 0-6
   published and 1-7 gate refusals per tick; `record_failures` 0 except on a self-park day (see
   "Unparking a bill"). The spend settles there, not at $1.00, because every bill estimates at
   least $0.665 (`COST_ESTIMATE_OUTPUT_CEILING_USD`): once spend passes ~$0.335 no further bill
   can clear the estimate guard. Over its first week (all nine ticks 2026-08-17..23) the scheduler
   funded 64 bills for $2.70 - about $0.04 per funded bill and $0.12 per published summary - and
   published 22 first-pass (~34%); 26 were gate-refused to draft (the conversion lane or the $0
   drain lane re-author those later), 7 self-parked as malformed checks (4 since unparked), and
   the rest closed on the record CLI's non-gate outcomes, which the log line does not count.
   (CHATLOG's 2026-08-21 mid-week figure - $0.063 per bill, $0.163 per published, 39% - counted
   only published + gate-refused outcomes.) A tick that spends $0.00 with
   `lanes.fresh` 0, `published` 0 for several days running, or any `BALANCE DEPLETED` line is the
   thing to look at.

2. **`npm run status`'s SUMMARY SCHEDULER block.** This is the real ledger - **there is no
   separate `billing-ledger.json` file; it does not exist anywhere in this codebase.** The ground
   truth for "did this actually spend money?" is the `ingestion_runs` table itself
   (`source='scheduled-summaries'` rows), and `scripts/data-status.js` reads it live, on every
   invocation, and prints:
   ```
   SUMMARY SCHEDULER
     last tick ........................ 2026-08-23T11:00:40 status=partial
     spent this week ................. $2.70 of $5.00
     published this week ............ 22
     parked (structural failures) .... 31
   ```
   (live output 2026-08-23 - `status=partial` is the steady state, see "What it does" step 6;
   the `parked (structural failures)` line only appears at all once the parked count is above
   zero, and it has been present since the drain-lane seeding on 2026-08-17 (the first
   self-parks landed later that same day). The earlier example
   here showed `succeeded` with no parked line - the pre-launch expectation, not anything a live
   tick has ever produced.)

   Nothing "refreshes" or "pushes" these numbers from inside the scheduler - `data-status.js`
   queries Postgres directly, itself, every time you run it, the same way it reports every other
   number in that report. Read it when a tick logs `BALANCE DEPLETED - reload required`, or any
   time you want a live answer to "what has this thing actually spent?"

## What `BALANCE DEPLETED - reload required` means

The Anthropic API balance has run out mid-tick. The scheduler will continue running one tick per
day; each future tick will still open a run row and attempt its assembled lane, but the FIRST
billing error it hits will stop that tick immediately (see "What it does" step 4) - so spend stays
bounded at whatever one bill's chain cost before the error, never compounding. **Nothing breaks,
nothing needs cleanup** - the `ingestion_runs` ledger records the honest attempt, and the scheduler
is ready the moment you reload credits.

To resume:

1. **Reload your Anthropic API balance** via your Anthropic account console.
2. **No code changes needed.** The next tick (tomorrow morning) will pick up where it left off,
   probing the balance again on its first billable API call.

**History (as of 2026-08-23): this path has never fired live.** The balance did hit $0 on the
evening of 2026-08-21 - spent by the USC glossary drain, not by this runner - but that fell
between that day's 6 AM tick and the next one, Lance reloaded about $7 the same evening, and
the 2026-08-22 tick ran normally. Nothing in this repo can read the balance; the Anthropic
console is the only truth for it.

## Unparking a bill

If a bill is parked (marked as permanently unpublishable due to structural incompleteness,
recorded in `.superpowers/artifacts/scheduled-summaries/parked.json`), it will never be
attempted again. To unpark it (e.g., after a verifier gate fix or a text source improvement):

1. Open `.superpowers/artifacts/scheduled-summaries/parked.json`.
2. Find the bill's row (keyed by `bill_id`).
3. Delete that entire row.
4. The next tick will see the bill as unsummarized again and attempt it.
5. **If the bill is ALSO in the drain lane's PARKED set** (`scripts/build-drain-wave.mjs`),
   remove it there too - otherwise the next `seed-scheduler-parks.mjs` run re-parks it (the
   seeder only ever ADDS; it never removes an entry). Unparking a drain-lane bill is therefore
   always two edits: the PARKED set AND the `parked.json` row.

**The scheduler's own self-park class.** Besides the seeded drain parks, the scheduler parks a
bill itself when `summary-queue.js record` returns a `MalformedSummaryError` for it - the reason
reads `completeness check for bill X is malformed - the checker's own output cannot be
trusted: ...` (a checker that cited a section not in the bill text, or a corroboration run that
disagreed with the primary). Those rows carry NO `source` tag in `parked.json` (seeded rows
carry `source: drain-lane-seed-<date>`), which is how to tell them apart. Record so far: 4
self-parks on 2026-08-17 (tick d744297c - SRES 377/690/520/412, the old fixed-floor catch-22)
were deleted after the 2026-08-18 gate fix, per that spec's "Unpark the scheduler side" step;
3 more on 2026-08-19 (SRES 412 again, HJR 114, SJR 41) stand as of 2026-08-23. A self-park's
reason text is the gate's verbatim explanation - read it before deciding the bill deserves a
retry; the park exists because paying for the same mechanical refusal again is the one thing
the budget must never do. (A third, transient source tag - `tiny-bill-stopgap-2026-08-17`,
688 sub-5k-char bills pre-parked by `scripts/park-tiny-fresh-bills.mjs` on a stale premise
(the length-scaled floor already existed in `verifier.js`) - was undone the same day: 687
removed within the hour, the last one (HRES 1299) on 2026-08-18 with the corroboration-gate
rollout; it may still appear in old logs.)

The parked set is kept as a JSON file (not a database table) so it can be edited locally without
server access, and so a decision to unpark survives power loss and reboots (unlike an in-memory
registry).

**Seeded from the drain lane's parks (2026-08-17):** the drain lane's PARKED set in
`scripts/build-drain-wave.mjs` (27 bills at the time, each parked after exhausted supervised
retries, with written reasons; **28 as of 2026-08-18** after 4 were unparked by the
completeness-floor fix and 5 new parks were added (four 3-strike, one 2-strike malformed via
the corroboration gate) - the file is authoritative, count
it rather than trusting this sentence) was seeded into `parked.json` via
`node scripts/seed-scheduler-parks.mjs` -
without this, those bills are conversion-lane-eligible (they all have drafts + verifications on
file) and the lane's oldest-flagged-first ordering puts them at the FRONT of the paid queue, so
the scheduler would have spent budget re-attempting bills that already failed three supervised
attempts each. Verified by dry-run after seeding: lanes dropped 2,269 -> 2,261 and zero parked
IDs remain in the assembly. The seeder is merge-safe and idempotent (never overwrites an
existing entry) - **re-run it whenever the drain lane parks new bills** (done on 2026-08-18 in
three passes as that day's drain waves parked bills - +2, +1, +2, all tagged
`drain-lane-seed-2026-08-18`), and after any loss of
the gitignored artifacts tree (the script and the PARKED set it reads are both committed, so
the park list is always recoverable). `parked.json` is therefore seeds PLUS the scheduler's own
self-parks - 31 entries on 2026-08-23 (23 + 5 seeded, 3 self-parks); `npm run status` prints
the live count. If `parked.json` exists but can't be read on a given tick (corrupt, a transient
filesystem error), that tick treats the park list as UNKNOWN for its own purposes rather than
silently empty - it will not merge-write over a file it couldn't actually read, so a newly
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
  (fresh, conversions, at most one monster) - using the SAME plan CLI, the SAME queue data, and the
  SAME lane-assembly logic a live tick would.
- Spend **zero dollars** (no Anthropic client is even constructed on `--dry-run` - see `main()`).
- Open **no run row** in the database, write **no per-tick summary line** (it can still write
  the short budget-exhausted / plan-failed / session-key-WARNING lines a live tick would write
  at those same points - see "Reading the logs"), and spawn **no `record` child
  process**.
- Report the assembled lanes, computed allowance, and weekly spend - what the next live tick would
  actually work with - **without making any writes or API calls.**
- Exit 0.

Dry-run is safe to run while the scheduled task is running; it will skip if the lock is already
held (logging `already running (<reason>) - skipping this tick` and reporting
`outcome: 'already-running'`, same as a real tick would). The report includes the real queue and
budget state, so it can be run multiple times a day without side effects.

## Recovery properties

**Checkpoints are per-stage files, not ledger rows - and they DO cause the SAME bill to be
retried, not skipped.** Every completed (paid) chain stage - author, verify, provisions, the
conditional provisions-corroboration (2026-08-18), coverage -
is written immediately to its own JSON file under
`.superpowers/artifacts/scheduled-summaries/stages/<bill_id>-<hash8>.json`
(`saveCheckpoint`/`loadCheckpoint` in `src/lib/billed-summary-chain.js`), keyed so a text revision
(a new hash) invalidates the old checkpoint automatically. If a tick crashes partway through a
bill's chain, that bill was never handed to `record` (only a fully-completed chain produces an
envelope), so it is simply still unsummarized (fresh lane) or still draft-only (conversion lane) -
the VERY NEXT tick will see it as eligible again, re-queue it, and re-attempt it. When it does,
`runBillChain`'s own checkpoint load finds whatever stages already completed and skips straight
past them, paying only for the stages that are still missing. This is the actual recovery
guarantee: **a crashed bill is retried, cheaply, not abandoned and not re-paid for from scratch.**

**Lock reclaim:** A lock older than its own declared max duration (30 minutes,
`TICK_MAX_DURATION_MS`) is automatically reclaimed on the next tick that finds it stale, with a
warning logged. This handles power loss or forced kills. You can also delete
`.superpowers/artifacts/summary-scheduler.lock.json` by hand at any time if you want a clean next
tick immediately rather than waiting for it to age out. (Again: this 30-minute figure is the
RECLAIM window a later tick uses, not a self-terminating deadline for the current one - see the
Task Scheduler section above for what actually bounds a stuck tick.)

**Conservative crashed-tick ledger charge:** If the scheduler is killed mid-run (Windows timeout,
power loss, etc.) and its `ingestion_runs` row is left at `status='running'`, the NEXT tick's own
weekly-spend calculation (`summarizeWeekSpend`) counts that stranded row as having spent the FULL
per-tick cap default ($1.00) against the weekly ledger - never less, even if that later tick happens
to be running under a manually-lowered `SUMMARY_TICK_CAP_USD` itself (fixed in this review's pass:
the charge now always uses `Math.max(this tick's own cap, the code default)`, so a throttled manual
tick can never retroactively under-charge an earlier crash that ran under the real cap). This is
deliberately conservative - a bill that crashed stays in draft/unsummarized state and waits for a
future retry (see "Checkpoints" above), never vanishing or succeeding on a lie, and never letting an
unknown amount of prior spend be undercounted.

**A throwing plan CLI or record CLI no longer crashes the whole tick.** Both are wrapped in their
own try/catch: a throwing plan call is logged and returns a clean `plan-failed` outcome with no run
row ever opened; a throwing record call (mid-tick, after a run row IS already open) is logged,
recorded as a skip in that run's own detail, and the tick still closes its `ingestion_runs` row
honestly rather than leaving it stranded at `running` with no diagnostic trail at all. In both
cases, `main()` still exits 0 - an expected, logged stop, not a Task-Scheduler-visible crash.

**What a tick leaves on disk for diagnosis** (all under the gitignored `.superpowers/artifacts/`):

- `scheduled-summaries/records-<runId>-<lane>.json` - the exact envelopes handed to
  `summary-queue.js record`, one file per non-empty lane (`fresh` / `drafts`), written BEFORE
  the record CLI is spawned and kept even when that CLI throws or returns nothing parseable - so
  a "record failed" tick can be replayed by hand with
  `node --env-file=.env src/cli/summary-queue.js record --file <that path>` (add
  `--replace-drafts` for a `drafts` file) once the cause is fixed.
- `scheduled-summaries/stages/<bill_id>-<hash8>.json` - the per-stage checkpoints above (about
  60 files on 2026-08-23; they accumulate one per bill-text attempted and are harmless to keep).
- `scheduled-summaries/parked.json` - the park list ("Unparking a bill").
- `summary-scheduler-logs/YYYY-MM-DD.log` - the one-line-per-tick log ("Reading the logs").
- `summary-scheduler.lock.json` - present only while a tick runs (or after a hard kill, until
  reclaimed).
- `scheduled-summaries-task.xml` - the saved Task Scheduler definition (contains the machine SID).

The run row itself (`ingestion_runs`, `source='scheduled-summaries'`) is the ledger; its
`detail` carries the full `skipped` list with reasons, `lanes`, and `per_call_count`.

## How to pause / remove it

```
schtasks /change /tn "VisibleGov Scheduled Summaries" /disable   # pause (keeps the registration)
schtasks /change /tn "VisibleGov Scheduled Summaries" /enable    # resume
schtasks /delete /tn "VisibleGov Scheduled Summaries" /f         # remove entirely
schtasks /run    /tn "VisibleGov Scheduled Summaries"            # fire a REAL paid tick now (Lance's call only)
```

If the machine ever loses power mid-run, the lock file self-heals: a lock older than its own
declared max duration (30 minutes, `TICK_MAX_DURATION_MS`) is automatically reclaimed on
the next tick, with a warning logged. You can also delete
`.superpowers/artifacts/summary-scheduler.lock.json` by hand at any time if you want
a clean next tick immediately rather than waiting out the stale-reclaim window.

## Status

All 7 build tasks are complete, plus a final whole-branch review and its fix wave (this document
was rewritten section-by-section against the live code as part of that pass). The full test suite
is green in a clean shell.

**ACTIVATED 2026-08-17.** The original activation checklist completed that day, in order:
credits loaded ($20); the throttled manual tick ran - first at this doc's original (wrong)
$0.10, which the estimate guard correctly skipped entirely at $0 spend, then at the corrected
$0.70, which published HR 3095 and gate-refused HB 1562 to draft for $0.0474; confirmed via
`npm run status` and the day's log; and the `schtasks` registration succeeded (task XML
verified: daily 6:00, absolute paths, no ExecutionTimeLimit element = 72h default). What
remains:

1. ~~Check "Run task as soon as possible after a scheduled start is missed"~~ **DONE
   2026-08-17** - via XML re-create, after both the GUI and `Set-ScheduledTask` failed (see
   the two warning sections above; the GUI route in this list's original wording does not
   work for this task).
2. Optional: switch to "Run whether user is logged on or not" via the XML + `/ru` command in
   the console-window section above - eliminates the visible tick window and enables
   logged-out runs. Until then: never close the black node window a tick opens.
3. Monitor the logs and the SUMMARY SCHEDULER block as the daily runs accumulate.
4. Re-check the cost-estimate constants when Sonnet intro pricing ends (2026-08-31).

**Update 2026-08-23 (live-verified):** six consecutive unattended 6 AM ticks (2026-08-18..23,
one `ingestion_runs` row each - 08-18's fired 46 minutes late; Task Scheduler Last Result 0,
Next Run 8/24/2026 6:00 AM) after 08-17's three hand-fired ticks ($0.10, $0.70, and the
`schtasks /run` validation); ISO week 2026-W34 stands at roughly $2.70 of $5.00 with 22 published after
its last tick - run `npm run status` for live figures. Item 2 above (the `/ru` switch) is still
open: the task still runs as `InteractiveToken` with its visible console window. Item 4 stands.
Changes since activation that this doc now reflects: the conditional provisions-corroboration
stage (2026-08-18), the recency-first sort's session-date dependency and WARNING line
(2026-08-21/22), the `partial`-is-steady-state reading, the self-park class and two-edit
unpark, the silent Task XML flags, and the `schtasks /run` manual trigger.
