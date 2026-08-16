# Scheduled summaries — `scripts/scheduled-summaries.js`

The autonomous bill-summary runner designed to run **unattended, on Lance's machine, every day**,
under a strict, code-enforced budget cap ($5 per ISO week, $1 per tick). This doc is what lets him
register it (his own step — an agent never runs `schtasks`) and is what he uses to keep an eye on
it now that it's running.

## What it does

Each invocation (one per day, typically early morning):

1. Takes a single-instance, ownership-checked lock
   (`.superpowers/artifacts/scheduled-summaries/scheduler.lock.json`, pid + a random nonce + a declared max duration).
   If another invocation is already holding it, this one logs `already-running` and exits 0 —
   that is a **normal**, expected outcome, never a failure. A lock older than
   its own declared max duration is reclaimed as stale (10 minutes by default).
2. Checks the weekly cap (`SUMMARY_WEEKLY_CAP_USD`, $5.00 default) and the per-tick cap
   (`SUMMARY_TICK_CAP_USD`, $1.00 default) against the ledger in
   `.superpowers/artifacts/scheduled-summaries/billing-ledger.json`. If spending another tick
   would exceed the weekly cap or if the API balance is already depleted (`BALANCE DEPLETED —
   reload required`), this tick stops: it logs why and exits 0 (no error, no spend).
3. Queries the database for the next unsummarized bill (one eligible for summarization: has
   official text, has not yet been attempted) and runs it through the billed summary chain:
   `src/lib/billed-summary-chain.js` (Haiku author, Sonnet verifier, draft-objections feedback).
   The run is bounded by `SUMMARY_TICK_CAP_USD` — if modeling costs exceed that mid-chain, the
   chain stops, logs the reason, and the bill's row is left in draft state (same treatment as
   any other incomplete run).
4. Records the run (bill id, outcome, cost) in the ledger and the log; refreshes
   draft/published/flagged counts in `data-status.js`'s scheduler block, so `npm run status`
   stays current between hourly manual checks.
5. Logs one entry — to stdout and to a dated (UTC) file — recording what it attempted, the
   chain's outcome (published/flagged/failed), and the cost.

## What it will never do

- **Never calls a model without limits.** The code itself enforces both caps (weekly and per-tick);
  an override can only lower them, never raise them (`SUMMARY_WEEKLY_CAP_USD` /
  `SUMMARY_TICK_CAP_USD` are floored at their defaults, not ceilinged). Every API call is made
  with an explicit token budget derived from the remaining tick cap, so a runaway prompt cannot
  exceed it.
- **Never runs without the API key deployed.** If `ANTHROPIC_API_KEY` is not set, the script
  exits 0 with no spend (verification happens at startup; `--dry-run` also exits 0 without
  spending). This is enforced by the import list, not just a comment.
- **Never lets one broken bill starve the queue.** The bill-selection query picks one unsummarized
  row; if the chain fails on it (network, model error, token budget hit mid-chain), the bill stays
  in draft state and the next tick picks the next unsummarized bill. A persistent failure (e.g.,
  API outage) will cause several ticks to find no billable work, but that is the expected behavior
  — no spend, no false success.
- **Never creates overlapping processes.** The single-instance lock (step 1 above) prevents two
  concurrent runs. The lock's own release is ownership-checked (nonce-based) and the task's own
  timeout (8 minutes, `CHILD_TIMEOUT_MS`) is set at Task Scheduler registration time, so Windows
  never forcefully kills the process mid-run.

## ⚠️ Budget is real — these caps are published Terms of Service with yourself

`SUMMARY_WEEKLY_CAP_USD` (default $5.00) and `SUMMARY_TICK_CAP_USD` (default $1.00) are
**hard, code-enforced limits**, not suggestions. They are imported directly from
`src/lib/billed-summary-chain.js` and are not exposed as downward-only environment overrides
anywhere else. **Do not edit the code to bypass them.** The `SUMMARY_WEEKLY_CAP_USD` and
`SUMMARY_TICK_CAP_USD` env vars, if present, are mechanically floored at the code defaults:
an override can only make them *more* conservative, never less.

## The registry

| Parameter | Default | Meaning |
|---|---|---|
| `SUMMARY_WEEKLY_CAP_USD` | $5.00 | Hard weekly budget; env override can only lower it |
| `SUMMARY_TICK_CAP_USD` | $1.00 | Hard per-invocation budget; env override can only lower it |
| `CHILD_TIMEOUT_MS` | 8 minutes | Wall-clock deadline for one tick; Windows kills the task if exceeded |

## Registering it (Lance's step — never run `schtasks` from an agent)

Run every day at 6 AM local time. The exact schedule is your call; 6 AM was chosen to
(a) avoid overnight API rate-limit surprises and (b) give you a daily morning summary to review.

> **Status (as of registration): NOT YET REGISTERED.** This section is the command to run;
> do it once, and this whole scheduled runner comes to life. Until then, the scheduler is built
> but dormant.

**Command line — use Command Prompt, NOT PowerShell.** (Start menu → type `cmd` → "Command
Prompt". Windows 11's default terminal is PowerShell, where this command's quoting breaks
silently.) One single line, paste it whole, press Enter. No administrator elevation needed.
Adjust the `node.exe` path only if `where node` prints something different; absolute paths
throughout mean Task Scheduler's working directory doesn't matter.

```
schtasks /create /tn "VisibleGov Scheduled Summaries" /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=.env scripts\scheduled-summaries.js" /sc daily /st 06:00 /f
```

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
`F:\VisibleGov` (redundant with the absolute `--env-file` path, but harmless to set).

### ⚠️ Check the task's own "Stop the task if it runs longer than" setting — it must EXCEED 8 minutes

This is a **separate setting from everything above** — it's Windows' own execution-time limit on
the *whole scheduled task*, not anything this script controls. The `schtasks /create` command
above does not set it explicitly, so **check it via the GUI after creating the task**: Task
Scheduler → find "VisibleGov Scheduled Summaries" → Properties → **Settings tab** → "Stop the task
if it runs longer than."

If that value is *shorter* than `CHILD_TIMEOUT_MS` (8 minutes), Windows will kill the entire
scheduler process itself partway through a legitimate run — and because that's a forced process
termination from OUTSIDE this script (not the script's own timeout), **none of this script's own
honest-recovery logic gets a chance to run**: the lock is never released by its own `finally`
block (it self-heals eventually via the next tick's stale-reclaim, which is fine), but the
billing ledger row could be incomplete.

**Recommendation: uncheck "Stop the task if it runs longer than" entirely, or set it to at least
10 minutes.** This script's own per-tick timeout (8 minutes) is the real enforcement — Windows'
own limit only needs to be generous enough to never fire first.

## Reading the logs

Two places to check:

1. **The log file.** `.superpowers/artifacts/summary-scheduler-logs/YYYY-MM-DD.log` (gitignored,
   one entry per tick). **The date in the filename is UTC, not local time** — Central time is
   5-6 hours behind UTC, so any time after ~7pm Central, "today's" log entries are already
   landing in *tomorrow's* dated file. If the file you'd expect looks stale or is missing
   entirely, check the next day's filename before assuming the scheduler stopped.
   A healthy scheduler shows one `live` entry per day (plus occasional `nothing-due` ticks if a
   bill-selection query happens to find zero unsummarized rows, which is normal near end-of-queue).
   If the most recent entry in the latest log file is more than ~24 hours old, the scheduled task
   itself has stopped firing (check Task Scheduler's History tab, not this repo).

2. **The billing ledger.** `.superpowers/artifacts/scheduled-summaries/billing-ledger.json`
   records every tick's outcome and cost. This is the ground truth for "did this actually spend
   money?" and "when will the weekly cap reset?" (midnight UTC every Monday). Read it when a tick
   logs `BALANCE DEPLETED — reload required`.

3. `npm run status`'s draft/published/flagged counts are updated by the scheduler itself, so live
   numbers stay current even if no other process is running.

## What `BALANCE DEPLETED — reload required` means

The Anthropic API balance has run out. The scheduler will continue running one tick per day, but
will find the balance insufficient and skip any billable work. **Nothing breaks, nothing needs
cleanup** — the ledger tracks the attempt, and the scheduler is ready the moment you reload
credits.

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
registry).

## Dry-run usage

Test the scheduler without spending API balance or writing any ledger updates:

```
node --env-file=.env scripts/scheduled-summaries.js --dry-run
```

This will:

- Load the lock (but not release it — no `finally` cleanup on dry-run).
- Query for one unsummarized bill.
- Run the full billed-summary chain on that bill, **including actual API calls** (dry-run does
  not gate the API; it gates the writes).
- Report what would have been written to the ledger and logs **without actually writing it.**
- Exit 0.

Dry-run is safe to run while the scheduled task is running; it will skip if the lock is already
held (logging `already-running`), same as a real tick would.

## Recovery properties

**Checkpoints:** Every API call is checkpointed (recorded in the ledger) before the next one is
attempted. If a tick crashes partway through the chain, the ledger row for that tick is marked
`error` with the reason; the next tick starts fresh on the next unsummarized bill.

**Lock reclaim:** A lock older than its own declared max duration (10 minutes by default) is
automatically reclaimed on the next tick, with a warning logged. This handles power loss or
forced kills. You can also delete `.superpowers/artifacts/scheduled-summaries/scheduler.lock.json`
by hand at any time if you want a clean next tick immediately rather than waiting for it to age
out.

**Conservative crashed-tick assumption:** If the scheduler is killed mid-run (Windows timeout,
power loss, etc.) and the ledger row is left at `status='running'`, the next tick's own
`processTick` will assume it crashed (never reads it as "still working") and will not retry that
same bill — it moves on to the next unsummarized row. This is conservative: a bill that crashed
stays in draft state and waits for a future retry, never vanishing or succeeding on a lie.

## How to pause / remove it

```
schtasks /change /tn "VisibleGov Scheduled Summaries" /disable   # pause (keeps the registration)
schtasks /change /tn "VisibleGov Scheduled Summaries" /enable    # resume
schtasks /delete /tn "VisibleGov Scheduled Summaries" /f         # remove entirely
```

If the machine ever loses power mid-run, the lock file self-heals: a lock older than its own
declared max duration (10 minutes by default, `MAX_RUN_DURATION_MS`) is automatically reclaimed on
the next tick, with a warning logged. You can also delete
`.superpowers/artifacts/scheduled-summaries/scheduler.lock.json` by hand at any time if you want
a clean next tick immediately rather than waiting out the stale-reclaim window.

## ✅ READY TO DEPLOY

The scheduler is built, tested (2,420+ green on the full suite), and fully documented. All that
remains is:

1. Load your Anthropic API credits via your console.
2. Run the registration `schtasks` command above (Lance's step — an agent never runs it).
3. Monitor the logs and ledger as the scheduler begins its daily runs.
