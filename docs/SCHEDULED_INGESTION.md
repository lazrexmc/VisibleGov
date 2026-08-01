# Scheduled ingestion — `scripts/scheduled-ingest.js`

The first thing in this repo designed to run **unattended, on Lance's machine, forever**, with no
human watching a single invocation. Everything about its design follows from that one fact. This
doc is what he needs to register it (his own step — an agent never runs `schtasks`) and to keep an
eye on it afterward.

## What it does

Each invocation:

1. Takes a single-instance, ownership-checked lock
   (`.superpowers/artifacts/scheduler.lock.json`, pid + a random nonce + a declared max duration).
   If another invocation is already holding it, this one logs `already-running` and exits 0 —
   that is a **normal**, expected outcome (see cadence below), never a failure. A lock older than
   its OWN declared max duration is reclaimed as stale (10 minutes by default; a source's real
   per-source timeout once one has been chosen — see *Per-source timeouts* below for why one
   fixed number doesn't work here); releasing the lock always re-checks the nonce first, so a run
   that hung long enough to be reclaimed can never delete a *newer* tick's lock out from under it.
2. Checks all five ingestion sources' real due-ness by querying `ingestion_runs` for each one's
   last `started_at` and comparing against its own minimum interval — the *same* durable,
   cross-process signal the ingest CLIs' own cooldown check (`enforceDurableCooldown`) already
   relies on. **It never blindly invokes a CLI.** Each source's own lookup is isolated: if one
   fails (a transient DB hiccup, say), that source is skipped for the tick and logged with a
   reason — the other four are unaffected.
3. Picks the single **most overdue** due source (the one that has gone longest since it last ran)
   and runs it as a short, timeout-bounded child process: `node --env-file=.env <cli> --limit 1`
   (or the equivalent for that source — see the registry table below). At most one source per
   tick. Two distinct honest-recovery paths, depending on how the CLI failed:
   - If it fails in a way that leaves **no new** `ingestion_runs` row at all (a hard crash, a
     timeout, an upstream outage before the CLI's own bookkeeping starts — this is `us-congress`/
     `us-senate`'s own shape, since `ingest.js` does its network work before it ever records
     anything), the scheduler writes its own honest **failed attempt** record — never a fake
     success — so that source's due-ness clock still advances and a persistently-failing source
     cannot monopolize every future tick.
   - If the timeout (or a buffer overflow) forcefully kills a CLI that HAD already opened its own
     run row (`mo-senate-web`/`mo-house-xml`/`legiscan` all open their row before their long
     work), that row would otherwise be stranded at `status='running'` forever — lying about state
     to anyone reading it (`public_freshness` included) while still silently advancing due-ness.
     The scheduler closes it honestly instead: `status='failed'`, `detail.scheduler_kill: true`,
     scoped so it can only ever touch a row this exact tick could plausibly have created.
4. If that run's own recorded counts show it actually wrote rows, refreshes the vote aggregates
   (`scripts/refresh-aggregates.js`) — the same standing practice every ingest batch has always
   followed, so the profile charts never silently drift behind the vote lists. A tick whose only
   "failures" are the probe window's own expected past-the-edge 404s (see `us-congress`/
   `us-senate` below) is recognized as healthy and does not spuriously trigger this.
5. Logs one entry — to stdout and to a dated (UTC) file — recording what it checked, what it chose
   (or why nothing was due), the CLI's own honest counts, and whether aggregates were refreshed.

## What it will never do

- **Never calls a model.** It imports no Anthropic client, no `lib/summarizer.js`, no
  `lib/verifier.js` — nothing that can bill Lance's account. It only ever spawns the five
  ingestion CLIs below and `scripts/refresh-aggregates.js`. This is enforced by the import list,
  not just a comment; verify by inspection if this file ever changes.
- **Never violates a published rate limit.** The MO Senate and MO House intervals below are
  imported directly from the adapters that already encode senate.mo.gov's / house.mo.gov's real
  published terms — they are **not environment-overridable**, so a typo'd env var cannot shorten
  them. The intervals this script chooses itself (us-congress, us-senate, legiscan) are
  environment-overridable but mechanically floored at the values below: an override can only make
  them *more* conservative, never less.
- **Never runs a MO House historical/multi-era backfill.** `mo_house_id` is a table-wide unique
  constraint (migration 0005) against the *current* roster only — passing a historical year/session
  to the House CLI would silently misattribute a successor's votes to their predecessor (TODO item
  31). The registry entry for `mo-house-xml` passes `--limit 1` only, nothing else, permanently.
- **Never stacks overlapping processes.** The single-instance lock (step 1 above) and the
  due-ness check (step 2) both have to agree before anything runs. The lock's own release is
  ownership-checked (nonce-based), and every child process runs under an explicit, per-source
  timeout (see *Per-source timeouts* below) — the lock's own declared stale-reclaim window is
  updated to match that exact timeout right before the child is spawned, so a later tick's
  staleness check is always judging the run against its real bound, never a generic number that
  could be shorter than a legitimately still-running child. A single hung child can therefore
  never hold the lock indefinitely, and can never be mistaken for stale by a later tick while it
  is still legitimately within its own budget.
- **Never lets one failing source starve the others.** `ingest.js` (the `us-congress`/`us-senate`
  CLI) does its network work before it records anything — a persistent upstream failure there used
  to leave no durable trace at all, which would have let that one source win the "most overdue"
  pick on every tick forever. The scheduler now closes that gap itself (see step 3 above).
- **Never guesses a LegiScan session id.** If `sessions.legiscan_session_id` isn't on file for the
  current MO session, the `legiscan` source is reported `resolvable: false` and skipped, with the
  reason logged — never a "most recent session" heuristic. See *Known gap* below for why.

## ⚠️ The MO cadences are published Terms of Service, not our own caution

`MO_SENATE_MIN_INTERVAL_MS` and `MO_HOUSE_MIN_INTERVAL_MS` (30 minutes each) are
**senate.mo.gov's and house.mo.gov's own published rate limits**. They are imported verbatim from
`src/adapters/mo-senate-web.js` / `src/adapters/mo-house-xml.js` — the same constants the ingest
CLIs' own `enforceDurableCooldown` enforces — and are not exposed as environment variables at all.
**Do not shorten these**, in this file or anywhere else. house.mo.gov's ToU caps automated pulls at
once per 30 minutes; that is why the House backfill was never a volume strategy (see
`docs/DATA_INVENTORY.md`/CHATLOG for "the text unlock").

## The registry

| Source | Command | Interval | Why |
|---|---|---|---|
| `mo-senate-web` | `ingest-mo-senate.js --year <current> --limit 1` | 30 min | senate.mo.gov's published terms (imported, not configurable) |
| `mo-house-xml` | `ingest-mo-house.js --limit 1` | 30 min | house.mo.gov's published terms (imported, not configurable) — **current session only, never `--session`** |
| `us-congress` | `ingest.js --source us-congress --year <current> --rolls <lo>-<hi>` | ≥1 hour (`US_CONGRESS_MIN_INTERVAL_MS`, default 1h) | Congress.gov has its own polite limiter already; this is our own conservative check-frequency choice. `<lo>-<hi>` is computed each tick from the highest US **House** roll number already on file — a small forward window past it. Every roll in that window that doesn't exist yet 404s harmlessly (recorded, non-fatal, and recognized as an expected "nothing new yet" outcome rather than a real failure); every roll that already exists is a no-op. |
| `us-senate` | `ingest.js --source us-senate --session <current> --votes <lo>-<hi>` | ≥1 hour (`US_SENATE_MIN_INTERVAL_MS`, default 1h) | The Senate half of "federal votes" — a separate source from `us-congress` above (same CLI, different `--source`), with its own probe window computed the same way from the highest US **Senate** vote number already on file. Without an explicit `--votes` range, this CLI's own default behavior is to refetch and reparse the *entire* session's vote menu every invocation, which is wrong for a scheduled tick — the window keeps each invocation short and bounded, same as the House side. |
| `legiscan` | `ingest-legiscan.js --session <resolved id>` | ≥24 hours (`LEGISCAN_MIN_INTERVAL_MS`, default 24h) | Datasets refresh weekly (Sunday 5am ET); `ingest-legiscan.js`'s own `dataset_hash` gate (⛔ suspension-level LegiScan rule) makes a same-dataset tick cheap. `<resolved id>` comes from `sessions.legiscan_session_id` for the current MO session — see *Known gap* below if this ever reports `resolvable: false`. |

Both federal streams (House and Senate) are covered by this scheduler — before this build, *neither*
had scheduled ingestion, so new federal roll calls simply never arrived.

`US_CONGRESS_MIN_INTERVAL_MS` / `US_SENATE_MIN_INTERVAL_MS` / `LEGISCAN_MIN_INTERVAL_MS` can be
raised via `.env` if Lance ever wants these to run less often; any value below the defaults above
is silently floored back up to them.

## Per-source timeouts — why legiscan is different

Every child process runs under a hard timeout (`spawnSync`'s own `timeout` option): if a CLI
hasn't finished by then, the scheduler kills it rather than risk hanging forever. Four of the five
sources share one **8-minute default** (`CHILD_TIMEOUT_MS`). `legiscan` gets its own, much larger
**75-minute** budget (`LEGISCAN_CHILD_TIMEOUT_MS`).

This isn't a guess — it came from reading `legiscan`'s own history in `ingestion_runs`. Real runs
against the scheduler's actual target session (`'261'`, `legiscan_session_id 2239`) took **449.3s
and 475.7s** — within, but uncomfortably close to, the old single 480s (8-minute) budget every
source originally shared. A separate historical run (a genuine dataset-hash-changed
reprocessing — the case `ingest-legiscan.js`'s own `dataset_hash` gate exists for, not a cheap
hash-match skip) took **3168.5s (~52.8 minutes)**. 75 minutes is that observed maximum plus ~40%
headroom, rounded up.

**Why the other four sources don't need this:** `mo-senate-web`'s real historical runs never
exceeded 9.6 seconds; `us-congress`/`us-senate`'s small sample never came close to 8 minutes
either. `mo-house-xml` LOOKS like an exception in raw `ingestion_runs` history (some runs show
~30-minute durations) — investigated and ruled out: those are exact 1800.0-second multiples,
which is `enforceDurableCooldown` *sleeping out* the old manual bash-loop's premature
invocations, not real work. This scheduler's own due-ness gate never invokes a CLI before its
cooldown has elapsed, so that scenario cannot recur under it.

**Why this matters beyond just "don't kill a slow run": the lock itself has to know about it
too.** A fixed 10-minute stale-reclaim window and a legitimately 75-minute `legiscan` run cannot
coexist — a second tick 15 minutes in would see the lock as stale, reclaim it, and start a
*second* concurrent `legiscan` process, exactly the overlapping-process problem the lock exists to
prevent. So the lock's own declared stale-reclaim duration is updated to match the CHOSEN
source's real timeout right before that source is spawned (see "What it does," step 1) — a
`legiscan` tick's lock is only ever considered stale after ~76 minutes, not 10.

## Registering it (Lance's step — never run `schtasks` from an agent)

Run every 15 minutes — deliberately shorter than every source's own interval above, so a tick is
never more than ~15 minutes late; the per-source cooldowns above do the real gating, not this
number.

**Command line — use Command Prompt, NOT PowerShell.** (Start menu → type `cmd` → "Command
Prompt". Windows 11's default terminal is PowerShell, where this command's quoting breaks
silently — an earlier multi-line version of this doc failed exactly that way.) One single line,
paste it whole, press Enter. No administrator elevation needed. Adjust the `node.exe` path only
if `where node` prints something different; absolute paths throughout mean Task Scheduler's
working directory doesn't matter. Omitting `/ru` registers it for the current user, running only
while logged on (a locked screen still counts as logged on) — after a reboot it resumes at first
login, and missed ticks are harmless because due-ness is durable in the database:

```
schtasks /create /tn "VisibleGov Scheduled Ingestion" /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-ingest.js" /sc minute /mo 15 /st 00:00 /f
```

Expected output: `SUCCESS: The scheduled task "VisibleGov Scheduled Ingestion" has successfully
been created.`

- `/sc minute /mo 15` — repeats every 15 minutes, indefinitely (no end date unless you add `/ed`).
- `/ru "%USERNAME%"` runs it as your own account, only while you're logged on (no password
  needed). If you want it to run even while logged out, use the Task Scheduler GUI instead
  (Actions tab → this same command; General tab → "Run whether user is logged on or not," which
  will prompt for your password once).
- `/f` overwrites a prior registration with the same name — safe to re-run this command if you
  ever change the schedule.

**GUI equivalent**, if preferred: Task Scheduler → Create Task → General: name it; Triggers → New →
"On a schedule" → Daily, repeat task every **15 minutes** for a duration of **Indefinitely**;
Actions → New → Program: `C:\Program Files\nodejs\node.exe`, Arguments:
`--env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-ingest.js`, Start in:
`F:\VisibleGov` (redundant with the absolute `--env-file` path, but harmless to set).

### ⚠️ Check the task's own "Stop the task if it runs longer than" setting — it must EXCEED 75 minutes

This is a **separate setting from everything above** — it's Windows' own execution-time limit on
the *whole scheduled task*, not anything this script controls. The `schtasks /create` command
above does not set it explicitly, so **check it via the GUI after creating the task**: Task
Scheduler → find "VisibleGov Scheduled Ingestion" → Properties → **Settings tab** → "Stop the task
if it runs longer than."

If that value is *shorter* than `legiscan`'s own 75-minute timeout, Windows will kill the entire
scheduler process itself partway through a legitimate `legiscan` run — and because that's a forced
process termination from OUTSIDE this script (not `spawnSync`'s own timeout), **none of this
script's own honest-recovery logic gets a chance to run**: the lock is never released by its own
`finally` block (it self-heals eventually via the next tick's stale-reclaim, which is fine), but
any `ingestion_runs` row `legiscan` had already opened would be stranded at `status='running'`
with nothing to close it — exactly the lying-about-state problem this build went out of its way to
prevent, reintroduced from a layer above it.

**Recommendation: uncheck "Stop the task if it runs longer than" entirely, or set it to at least 2
hours.** This script's own per-source timeouts (8 minutes default, 75 minutes for `legiscan`) are
the real enforcement — Windows' own limit only needs to be generous enough to never fire first.

## How to verify it is alive

Two independent signals, on purpose — one from the scheduler's own perspective, one from the data's:

1. **The log file.** `.superpowers/artifacts/scheduler-logs/YYYY-MM-DD.log` (gitignored, one entry
   per tick). **The date in the filename is UTC, not local time** — Central time is 5-6 hours
   behind UTC, so any time after ~7pm Central (6-7pm during daylight time), "today's" log entries
   are already landing in *tomorrow's* dated file. If the file you'd expect looks stale or is
   missing entirely, check the next day's filename before assuming the scheduler stopped. A
   healthy scheduler shows an entry roughly every 15 minutes, alternating between `nothing-due`,
   `already-running`, and occasional `live` runs as each source's cooldown elapses; if the most
   recent entry across both today's-UTC and tomorrow's-UTC files is more than ~20 minutes old, the
   scheduled task itself has stopped firing (check Task Scheduler's history, not this repo).
2. **`npm run status`'s freshness block.** Reads `public_freshness` directly from the database —
   independent of whether the scheduler *ran*, it shows whether data actually *arrived*. If the
   log looks healthy but freshness doesn't move, something downstream (not the scheduler) is
   wrong.
3. Windows Task Scheduler's own History tab for "VisibleGov Scheduled Ingestion" shows exit codes
   over time — 0 is normal (success, nothing due, already-running, or the rare transient
   `lock-record-failed`, which self-heals on the next tick); non-zero is a real error
   (e.g. `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` missing) and is the one case worth investigating.

Manual checks any time, safe to run for real (read-only, zero writes, zero external fetches):

```
npm run schedule:ingest -- --dry-run
npm run schedule:ingest -- --dry-run --only legiscan
```

## How to pause / remove it

```
schtasks /change /tn "VisibleGov Scheduled Ingestion" /disable   # pause (keeps the registration)
schtasks /change /tn "VisibleGov Scheduled Ingestion" /enable    # resume
schtasks /delete /tn "VisibleGov Scheduled Ingestion" /f         # remove entirely
```

If the machine ever loses power mid-run, the lock file self-heals: a lock older than its own
declared max duration (10 minutes by default, `MAX_RUN_DURATION_MS`; up to ~76 minutes if a
`legiscan` run was in progress — see *Per-source timeouts* above) is automatically reclaimed on
the next tick, with a warning logged. You can also delete
`.superpowers/artifacts/scheduler.lock.json` by hand at any time if you want a clean next tick
immediately rather than waiting out whichever window applies.

## Known gap: `legiscan` may report `resolvable: false`

The scheduler looks up the current MO session's `legiscan_session_id` from the `sessions` table
(keyed off `ingest-mo-house.js`'s own `DEFAULT_MO_HOUSE_SESSION`) rather than guessing — see
`resolveLegiscanSessionId`'s own comment in `scripts/scheduled-ingest.js`. As of this writing that
resolves correctly (session `261` → LegiScan session `2239`). If it ever stops resolving, the
`legiscan` source is skipped honestly (logged, `resolvable: false`, with a reason) rather than
guessing — it does not block the other four sources (a lookup failure for any one source is
isolated from the rest; see "What it does," step 2).

## ⚠️ This scheduler CONTINUES feeding a known, currently-open data defect (TODO item 25) — read before registering

**TODO.md item 25** documents a real, currently-open duplicate-MO-session defect: session
identifier `'2026'` (no `legiscan_session_id`) duplicates session `'261'` (the correct one,
`legiscan_session_id = 2239`) — the same real legislative session recorded twice, splitting its
bills/votes across two session rows on the public site. TODO.md's own words: *"it grew 15→16 bills
during the audit: the cron is feeding the duplicate."*

**The feeder is `mo-senate-web`, which IS in this registry.** `ingest-mo-senate.js`'s
`ensureSessionRow` inserts a `sessions` row keyed on the bare calendar year (`identifier:
String(year)`, e.g. `'2026'`, with no `legiscan_session_id`) on **every single invocation** —
this is not a rare edge case, it is what that CLI's normal `--year <current> --limit 1` run always
does. Registering this scheduler means `mo-senate-web` keeps running on its own 30-minute cadence
forever, which means this duplicate keeps growing forever too, until TODO 25's session-merge fix
is applied at the database level.

**The honest framing is neutral-vs-today, not "unrelated."** This scheduler does exactly what the
manual bash loop already did before it — it neither creates nor worsens the defect relative to
current practice — but it is **not unrelated to it**, and running it unattended means the defect
now grows on a durable, forever cadence instead of a session-lifetime one. Registering this
scheduler is not blocked on TODO 25 being fixed first (the brief scoped this build to the
scheduler, not to that merge), but Lance should register it knowing this, not discover it later.
