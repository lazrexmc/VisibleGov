# Scheduled ingestion - `scripts/scheduled-ingest.js`

The first thing in this repo designed to run **unattended, on Lance's machine, forever**, with no
human watching a single invocation (the first of two such tasks now - see the status note just
below). Everything about its design follows from that one fact. This
doc is what let him register it (his own step - an agent never runs `schtasks`) and is what he uses
to keep an eye on it now that it's running.

> **Current status as of 2026-08-23:** registered and running (Task Scheduler task `VisibleGov
> Scheduled Ingestion`, every 15 minutes). Nearly every tick is `live` - the registry is
> oversubscribed, so saturation is the normal state (the 2026-08-05 correction under *Registering
> it*). The `pg_cron` aggregate refresh is healthy; this scheduler's own post-tick refresh collides
> with it on :00/:30 ticks and logs a benign `lock timeout` about half the time (the 2026-08-23
> notes under step 4 and item 5). The MO Senate journal replay is draining through `mo-senate-web`
> (the section at the bottom of this file, dated 2026-08-23, is the newest material here; *What a
> `mo-senate-web` tick actually does* explains the drain rate). **This is no longer the only
> registered task:** `VisibleGov Scheduled Summaries` (`scripts/scheduled-summaries.js`, daily at
> 06:00, its own lock file `.superpowers/artifacts/summary-scheduler.lock.json`, its own log
> directory `summary-scheduler-logs/`, and a $5/ISO-week spend ledger computed from
> `ingestion_runs`) is documented in `docs/SCHEDULED_SUMMARIES.md` - a fresh session reading Task
> Scheduler history should expect two tasks. Everything from the next banner down is a dated
> history layer; live numbers come from `npm run status`.
>
> **Status (updated 2026-08-02): ALREADY REGISTERED AND RUNNING.** Lance ran the registration
> 2026-07-31 late night - see "Registering it" below for the exact command, kept for reference (a
> reinstall, a new machine, or a schedule change would use the same one, with `/f` safely
> overwriting the existing registration). He also switched the task to **S4U logon** ("run whether
> logged on or not, no stored password"), so it survives logouts/reboots. Confirmed alive by two
> independent signals, both checked live 2026-08-02: (1) `.superpowers/artifacts/scheduler-logs/`
> has a dated entry roughly every 15 minutes through the day of this check, alternating
> `nothing-due`/`already-running`/`live`, exactly the healthy pattern described below; (2)
> `ingestion_runs` shows `mo-senate-web` and `mo-house-xml` both finishing 15 minutes apart
> (`21:00:07` and `21:15:07` on 2026-08-02, in the same log entry) - a spacing that matches the
> scheduler's own 15-minute Task Scheduler tick picking off each source right as its 30-minute
> cooldown clears, not the manual bash loop's old shape (which died with its session and produced
> irregular gaps). The rest of this document, written before registration, still accurately
> describes the script's behavior - read on for the mechanism, not just the history.
>
> **Re-verified 2026-08-03, one day later - still alive.** Same two signals, checked live again:
> (1) today's UTC log (`.superpowers/artifacts/scheduler-logs/2026-08-03.log`) shows 22 `live` + 2
> `nothing-due` entries by check time, most recent tick `2026-08-03T03:01:28Z` (~7 minutes old at
> check time - well inside the "~20 minutes old means stopped" threshold below); (2) `ingestion_runs`
> shows all four non-legiscan sources finishing within the prior ~70 minutes (`mo-house-xml`
> 02:00:07, `mo-senate-web` 02:15:05, `us-congress` 02:45:13, `us-senate` 03:01:28), the same
> alternating-tick/per-source-cooldown shape as the day before - not the dead-bash-loop's irregular
> gaps. `legiscan` shows `status: failed` as of this check (last attempt started
> 2026-08-02T07:30:03Z) - **not a scheduler problem**; see item 4 under "How to verify it is alive"
> below for the full worked check (24h cooldown not yet elapsed, confirmed against both the code
> and the scheduler's own due-ness log).
>
> **Re-verified again 2026-08-03, later the same day (~18:23 UTC) - scheduler still alive, one new
> regression found (unrelated to legiscan).** `legiscan`'s retry **did fire and succeeded**: queried
> `ingestion_runs` directly for its latest row - `started_at 2026-08-03T07:45:03Z`, `finished_at
> 07:52:14Z` (~7m11s, comfortably inside the 75-minute budget), `status: succeeded`,
> `datasetGate.reason: "hash_changed"` (a real new dataset fetch, not a cheap same-hash skip), 3,146
> bills / 70,465 casts / 604 votes written, `parseFailures: 0`, `unresolvedCasts.count: 0`, no
> `vote_reconciliation_flags_dedup_key` error anywhere in `detail` - confirms the same-day fix noted
> above held on its very next real-world retry. `npm run schedule:ingest -- --dry-run` at check time
> also showed a healthy registry (all five sources resolvable, `legiscan.remainingMs` counting down
> from the 07:45 run, nothing stuck), and today's log (`2026-08-03.log`) had 75 entries by check
> time, still the same alternating tick pattern. **But a second, separate issue turned up while
> checking - see the new dated item 5 under "How to verify it is alive" below: the aggregate-refresh
> step (step 4 above) has been silently failing since ~05:00 UTC today, unrelated to legiscan or the
> scheduler's own core mechanism.** This is exactly the kind of thing signal 2 in that section warns
> about ("if the log looks healthy but freshness doesn't move, something downstream is wrong") - the
> scheduler itself is fine; a function this doc's step 4 depends on is not.
>
> **Bottom line as of the 2026-08-03 ~18:23 UTC check: the scheduler itself is healthy and running
> on cadence; its aggregate-refresh step is currently broken (silently, since ~05:00 UTC that day)
> and needs a Lance-applied SQL fix - see item 5 under "How to verify it is alive" for the full
> evidence and likely root cause.**
>
> **Superseded, 2026-08-04: fully resolved, in three layers, not one.** The fix drafted at the time
> (migration 0026) landed and worked immediately, but exposed two further, deeper problems under
> real production load before the aggregate-refresh step was genuinely healthy end to end - a
> Supabase edge-gateway ~120s timeout (fixed via migration 0027, moving the routine refresh onto a
> native `pg_cron` job inside Postgres) and a Postgres `statement_timeout` arm-timing trap (fixed via
> migration 0028), then a query-planner anti-join misestimation once both timeout layers were clear
> (fixed via migration 0029). All three applied and verified live 2026-08-04. **Current status: the
> scheduler and its aggregate-refresh step are both healthy** - see item 5 under "How to verify it
> is alive" for the full three-layer history and live verification evidence.
>
> **Superseded in one respect, 2026-08-23:** "both healthy" still holds for the scheduler and for
> the `pg_cron` leg, but the scheduler's OWN post-tick refresh (step 4) now fails with `canceling
> statement due to lock timeout` on roughly half of its attempts - every one on a :00/:30 tick,
> where `pg_cron`'s `*/30` refresh already holds the matview locks. Benign (pg_cron owns that
> refresh; the data is not stale) but `aggregatesHealthy:false` is noisy - captured in TODO.md
> 2026-08-22 with two cheap fix options, not yet built. Details under step 4 and item 5.

## What it does

Each invocation:

1. Takes a single-instance, ownership-checked lock
   (`.superpowers/artifacts/scheduler.lock.json`, pid + a random nonce + a declared max duration).
   If another invocation is already holding it, this one logs `already-running` and exits 0 -
   that is a **normal**, expected outcome (see cadence below), never a failure. A lock older than
   its OWN declared max duration is reclaimed as stale (10 minutes by default; a source's real
   per-source timeout once one has been chosen - see *Per-source timeouts* below for why one
   fixed number doesn't work here); releasing the lock always re-checks the nonce first, so a run
   that hung long enough to be reclaimed can never delete a *newer* tick's lock out from under it.
2. Checks all five ingestion sources' real due-ness by querying `ingestion_runs` for each one's
   last `started_at` and comparing against its own minimum interval - the *same* durable,
   cross-process signal the ingest CLIs' own cooldown check (`enforceDurableCooldown`) already
   relies on. **It never blindly invokes a CLI.** Each source's own lookup is isolated: if one
   fails (a transient DB hiccup, say), that source is skipped for the tick and logged with a
   reason - the other four are unaffected.
3. Picks the single **most overdue** due source (the one that has gone longest since it last ran)
   and runs it as a short, timeout-bounded child process: `node --env-file=.env <cli> --limit 1`
   (or the equivalent for that source - see the registry table below). At most one source per
   tick. Two distinct honest-recovery paths, depending on how the CLI failed:
   - If it fails in a way that leaves **no new** `ingestion_runs` row at all (a hard crash, a
     timeout, an upstream outage before the CLI's own bookkeeping starts - this is `us-congress`/
     `us-senate`'s own shape, since `ingest.js` does its network work before it ever records
     anything), the scheduler writes its own honest **failed attempt** record - never a fake
     success - so that source's due-ness clock still advances and a persistently-failing source
     cannot monopolize every future tick.
   - If the timeout (or a buffer overflow) forcefully kills a CLI that HAD already opened its own
     run row (`mo-senate-web`/`mo-house-xml`/`legiscan` all open their row before their long
     work), that row would otherwise be stranded at `status='running'` forever - lying about state
     to anyone reading it (`public_freshness` included) while still silently advancing due-ness.
     The scheduler closes it honestly instead: `status='failed'`, `detail.scheduler_kill: true`,
     scoped so it can only ever touch a row this exact tick could plausibly have created (the
     scope starts `ORPHAN_CLOSE_SKEW_GRACE_MS` - 5 minutes - before the tick's own start time, so
     a local clock running slightly ahead of the database's cannot hide the row; safe because
     every registry interval is ≥30 minutes, so no older `running` row can fall inside that window).
4. If that run's own recorded counts show it actually wrote rows, refreshes the vote aggregates
   (`scripts/refresh-aggregates.js`) - the same standing practice every ingest batch has always
   followed, so the profile charts never silently drift behind the vote lists. A tick whose only
   "failures" are the probe window's own expected past-the-edge 404s (see `us-congress`/
   `us-senate` below) is recognized as healthy and does not spuriously trigger this. **This is no
   longer the only refresh path.** Migration `0027_pg_cron_refresh_aggregates.sql` also schedules
   `refresh_vote_aggregates()` as a native `pg_cron` job running every 30 minutes directly inside
   Postgres - no HTTP, no PostgREST, no scheduler involvement for that routine case (see item 5
   under "How to verify it is alive" below for the full history of why this second path exists).
   `pg_cron` is now the primary, structural guarantee that aggregates stay current; this
   scheduler's own post-tick call remains an additional, more immediate refresh right after a tick
   that actually wrote new rows, and still uses the same underlying function.
   > **Known collision, noted here 2026-08-23 (captured in TODO.md 2026-08-22; not yet fixed).**
   > When a write-tick lands on a :00/:30 boundary - the Task Scheduler ticks at :00/:15/:30/:45,
   > and in practice the `mo-house-xml` tick, the one that most often writes rows, lands on
   > :00/:30 about half the time - this post-tick call runs at the same instant as `pg_cron`'s `*/30`
   > refresh and fails with `canceling statement due to lock timeout`
   > (`aggregatesResult.parsed.mode: 'failed'`, `aggregatesHealthy: false`). On 2026-08-22 and
   > 2026-08-23 that was roughly half of all attempts (12 of 23, then 12 of 20 by 14:30Z), every
   > failure on a :00/:30 tick, every :15/:45 attempt `refreshed`. **This is benign:** `pg_cron`
   > owns that refresh and completes it, so the matviews are current - confirm from the `pg_cron`
   > leg, not from this flag: the newest `source='refresh-aggregates'` rows in `ingestion_runs`
   > (or the `refresh-aggregates` line of `npm run status`) should read `succeeded` within the
   > last ~30 minutes. Only a lock-timeout failure on a :15/:45 tick, or a refresh failing some
   > other way, deserves a second look. Two cheap fixes are on file in TODO.md (classify a lock
   > timeout within ~60s of a :00/:30 boundary as the benign "pg_cron owns this refresh" class and
   > log it without marking the tick unhealthy, or skip the post-tick call when a `pg_cron` row
   > finished in the last N minutes) - capture only, not built.
   >
   > **Caveat added 2026-08-05 (phase-2 deep audit) - this "primary guarantee" currently has NO
   > working automated failure signal.** Migration 0027's `EXCEPTION` handler can never actually
   > record a failure: PL/pgSQL implicitly savepoints the `BEGIN` block, so any error rolls back
   > the `'running'` INSERT before the handler runs, the handler's UPDATE then matches zero rows,
   > and the trailing `raise` aborts the rest. Net: **a failing pg_cron refresh writes NOTHING to
   > `ingestion_runs`.** Downstream, `public_freshness` therefore keeps showing
   > `source='refresh-aggregates'` as `succeeded` with a quietly aging `finished_at`, and
   > `npm run status` prints it with no staleness threshold - so a broken pg_cron job (failing
   > ticks, unscheduled job, disabled extension) is invisible to every automated surface. (A
   > related reading trap, noted 2026-08-23: 0027's bookkeeping takes `started_at` from the
   > column default and sets `finished_at = now()` inside the same transaction, and Postgres's
   > `now()` is transaction-start time - so every `pg_cron` row has `started_at == finished_at`
   > to the microsecond. Such a row proves the job fired and committed; the zero duration is not
   > a skip and says nothing about how long the refresh took - the ~19s baseline comes from
   > manual `npm run refresh:aggregates` wall-clock and `cron.job_run_details`, not from these
   > rows.) Nothing
   > reads `cron.job_run_details`; the scheduler's own `aggregatesHealthy` only exists on ticks
   > where the scheduler itself wrote rows; the `/fail` healthcheck ping requires the opt-in
   > `HEALTHCHECK_PING_URL` (inert until set). This is the same silent-failure class that already
   > produced a real 14-hour outage (see 0026's header) and recurred three more times in one week.
   > Until it's fixed, **`cron.job_run_details` is the only honest way to check whether the
   > scheduled refresh is actually working** - see TODO.md NOW.
5. Logs one entry - to stdout and to a dated (UTC) file - recording what it checked, what it chose
   (or why nothing was due), the CLI's own honest counts, and whether aggregates were refreshed.

## What it will never do

- **Never calls a model.** It imports no Anthropic client, no `lib/summarizer.js`, no
  `lib/verifier.js` - nothing that can bill Lance's account. It only ever spawns the five
  ingestion CLIs below and `scripts/refresh-aggregates.js`. This is enforced by the import list,
  not just a comment; verify by inspection if this file ever changes.
- **Never violates a published rate limit.** The MO Senate and MO House intervals below are
  imported directly from the adapters that already encode senate.mo.gov's / house.mo.gov's real
  published terms - they are **not environment-overridable**, so a typo'd env var cannot shorten
  them. The intervals this script chooses itself (us-congress, us-senate, legiscan) are
  environment-overridable but mechanically floored at the values below: an override can only make
  them *more* conservative, never less.
- **Never runs a MO House historical/multi-era backfill.** `mo_house_id` is a table-wide unique
  constraint (migration 0005) against the *current* roster only - passing a historical year/session
  to the House CLI would silently misattribute a successor's votes to their predecessor (TODO item
  31). The registry entry for `mo-house-xml` passes `--limit 1` only, nothing else, permanently.
- **Never stacks overlapping processes.** The single-instance lock (step 1 above) and the
  due-ness check (step 2) both have to agree before anything runs. The lock's own release is
  ownership-checked (nonce-based), and every child process runs under an explicit, per-source
  timeout (see *Per-source timeouts* below) - the lock's own declared stale-reclaim window is
  updated to match that exact timeout right before the child is spawned, so a later tick's
  staleness check is always judging the run against its real bound, never a generic number that
  could be shorter than a legitimately still-running child. A single hung child can therefore
  never hold the lock indefinitely, and can never be mistaken for stale by a later tick while it
  is still legitimately within its own budget.
- **Never lets one failing source starve the others.** `ingest.js` (the `us-congress`/`us-senate`
  CLI) does its network work before it records anything - a persistent upstream failure there used
  to leave no durable trace at all, which would have let that one source win the "most overdue"
  pick on every tick forever. The scheduler now closes that gap itself (see step 3 above).
- **Never dates a session it mints.** Every driver here that creates a `sessions` row (legiscan,
  mo-house-xml, mo-senate) writes identifier + name only - no `start_date`. Recency-first ordering
  in the summary exporter and the summary scheduler (`scripts/scheduled-summaries.js`, the sibling
  registered task - `docs/SCHEDULED_SUMMARIES.md`) depends on that column, so after any ingest
  that mints a new session, run `node --env-file=.env src/cli/sync-session-dates.js` (dry-run),
  review, then `--apply` (2026-08-22; until then both consumers fall back to the session's
  name-year and log how many rows needed it).
- **Never guesses a LegiScan session id.** If `sessions.legiscan_session_id` isn't on file for the
  current MO session, the `legiscan` source is reported `resolvable: false` and skipped, with the
  reason logged - never a "most recent session" heuristic. See *Known gap* below for why.

## The MO cadences are published Terms of Service, not our own caution

`MO_SENATE_MIN_INTERVAL_MS` and `MO_HOUSE_MIN_INTERVAL_MS` (30 minutes each) are
**senate.mo.gov's and house.mo.gov's own published rate limits**. They are imported verbatim from
`src/adapters/mo-senate-web.js` / `src/adapters/mo-house-xml.js` - the same constants the ingest
CLIs' own `enforceDurableCooldown` enforces - and are not exposed as environment variables at all.
**Do not shorten these**, in this file or anywhere else. house.mo.gov's ToU caps automated pulls at
once per 30 minutes; that is why the House backfill was never a volume strategy (see
`docs/DATA_INVENTORY.md`/CHATLOG for "the text unlock").

## The registry

| Source | Command | Interval | Why |
|---|---|---|---|
| `mo-senate-web` | `ingest-mo-senate.js --year <current> --limit 1` | 30 min | senate.mo.gov's published terms (imported, not configurable) |
| `mo-house-xml` | `ingest-mo-house.js --limit 1` | 30 min | house.mo.gov's published terms (imported, not configurable) - **current session only, never `--session`** |
| `us-congress` | `ingest.js --source us-congress --year <current> --rolls <lo>-<hi>` | ≥1 hour (`US_CONGRESS_MIN_INTERVAL_MS`, default 1h) | Congress.gov has its own polite limiter already; this is our own conservative check-frequency choice. `<lo>-<hi>` is computed each tick from the highest US **House** roll number already on file - a small forward window past it. Every roll in that window that doesn't exist yet 404s harmlessly (recorded, non-fatal, and recognized as an expected "nothing new yet" outcome rather than a real failure); every roll that already exists is a no-op. |
| `us-senate` | `ingest.js --source us-senate --session <current> --votes <lo>-<hi>` | ≥1 hour (`US_SENATE_MIN_INTERVAL_MS`, default 1h) | The Senate half of "federal votes" - a separate source from `us-congress` above (same CLI, different `--source`), with its own probe window computed the same way from the highest US **Senate** vote number already on file. Without an explicit `--votes` range, this CLI's own default behavior is to refetch and reparse the *entire* session's vote menu every invocation, which is wrong for a scheduled tick - the window keeps each invocation short and bounded, same as the House side. |
| `legiscan` | `ingest-legiscan.js --session <resolved id>` | ≥24 hours (`LEGISCAN_MIN_INTERVAL_MS`, default 24h) | Datasets refresh weekly (Sunday 5am ET); `ingest-legiscan.js`'s own `dataset_hash` gate (suspension-level LegiScan rule) makes a same-dataset tick cheap. `<resolved id>` comes from `sessions.legiscan_session_id` for the current MO session - see *Known gap* below if this ever reports `resolvable: false`. |

Both federal streams (House and Senate) are covered by this scheduler - before this build, *neither*
had scheduled ingestion, so new federal roll calls simply never arrived.

`US_CONGRESS_MIN_INTERVAL_MS` / `US_SENATE_MIN_INTERVAL_MS` / `LEGISCAN_MIN_INTERVAL_MS` can be
raised via `.env` if Lance ever wants these to run less often; any value below the defaults above
is silently floored back up to them.

### What a `mo-senate-web` tick actually does (2026-08-23)

`--limit 1` is one *slot*, not always one journal day. `ingest-mo-senate.js` spends its slot in a
fixed priority order and closes the run as soon as one slot is consumed: (1) a **roster** refetch
if the cached roster is older than 24 hours (`MO_SENATE_ROSTER_MAX_AGE_MS`; run detail
`counts.slot: 'roster'`); else (2) a **journal-index** refetch if the cached index is older than
60 minutes (`MO_SENATE_INDEX_MAX_AGE_MS`; `counts.slot: 'journal-index'`); else (3) **one journal
day** (no `slot` key - the day's own counts instead). Because this source runs about hourly under
saturation (see *Registering it*), its runs alternate journal-index / journal-day - expect roughly
one journal day per 1.5-2 hours, not one per tick (observed 2026-08-23: day runs at 07:30Z,
09:15Z, 10:45Z, 12:30Z). Run-detail fields worth reading on a day run: `total_pending_days` (what
remains in this year's worklist), `quarantined_days` (days parked on a `.failed.json` marker; `[]`
is healthy), `non_bill_votes`, `attribution`, and `attributed_from_context` (see the section at the
bottom of this file). The registry passes `--year <current>` only, so a **prior year's journal
backlog has no automatic drain path** - the 2018 session's worklist was found to hold 52
unprocessed days on 2026-08-23 and needs manual `--year 2018 --limit 1` runs (or a registry
decision - TODO.md, Lance's call).

## Per-source timeouts - why legiscan is different

Every child process runs under a hard timeout (`spawnSync`'s own `timeout` option): if a CLI
hasn't finished by then, the scheduler kills it rather than risk hanging forever. Four of the five
sources share one **8-minute default** (`CHILD_TIMEOUT_MS`). `legiscan` gets its own, much larger
**75-minute** budget (`LEGISCAN_CHILD_TIMEOUT_MS`).

This isn't a guess - it came from reading `legiscan`'s own history in `ingestion_runs`. Real runs
against the scheduler's actual target session (`'261'`, `legiscan_session_id 2239`) took **449.3s
and 475.7s** - within, but uncomfortably close to, the old single 480s (8-minute) budget every
source originally shared. A separate historical run (a genuine dataset-hash-changed
reprocessing - the case `ingest-legiscan.js`'s own `dataset_hash` gate exists for, not a cheap
hash-match skip) took **3168.5s (~52.8 minutes)**. 75 minutes is that observed maximum plus ~40%
headroom, rounded up.

**Why the other four sources don't need this:** `mo-senate-web`'s real historical runs never
exceeded 9.6 seconds; `us-congress`/`us-senate`'s small sample never came close to 8 minutes
either. `mo-house-xml` LOOKS like an exception in raw `ingestion_runs` history (some runs show
~30-minute durations) - investigated and ruled out: those are exact 1800.0-second multiples,
which is `enforceDurableCooldown` *sleeping out* the old manual bash-loop's premature
invocations, not real work. This scheduler's own due-ness gate never invokes a CLI before its
cooldown has elapsed, so that scenario cannot recur under it.

**Why this matters beyond just "don't kill a slow run": the lock itself has to know about it
too.** A fixed 10-minute stale-reclaim window and a legitimately 75-minute `legiscan` run cannot
coexist - a second tick 15 minutes in would see the lock as stale, reclaim it, and start a
*second* concurrent `legiscan` process, exactly the overlapping-process problem the lock exists to
prevent. So the lock's own declared stale-reclaim duration is updated to match the CHOSEN
source's real timeout right before that source is spawned (see "What it does," step 1) - a
`legiscan` tick's lock is only ever considered stale after ~76 minutes, not 10.

## Registering it (Lance's step - never run `schtasks` from an agent)

**Already done (2026-07-31 late night) - this section is kept for reference,** not as an
outstanding step. Use it again only to re-register (new machine, schedule change - `/f` overwrites
the existing task safely) or to remind yourself what the registered task actually runs.

Run every 15 minutes - deliberately shorter than every source's own interval above; the per-source
cooldowns above do the real gating, not this number.

> **Corrected 2026-08-05 (phase-2 deep audit).** This section previously claimed "a tick is never
> more than ~15 minutes late." That's true of TICK latency but NOT of per-source SERVICE latency,
> and the distinction matters. The scheduler runs at most ONE source per tick (`pickMostOverdue`),
> giving a hard capacity of 4 runs/hour - against a registry demanding ~6/hour (mo-senate 2 +
> mo-house 2 + us-congress 1 + us-senate 1 + legiscan ~0.04). The registry is therefore
> structurally oversubscribed, and in steady state every source converges to an **~hourly
> rotation** - the two MO sources running at roughly 2x their own 30-minute cooldown. This doc's
> own quoted live data further down (mo-house 02:00, mo-senate 02:15, us-congress 02:45, us-senate
> 03:01) is exactly that hourly rotation, not the cooldown-edge service the older wording
> described. Provable worst-case service latency is ~5 ticks (~75 min) past cooldown expiry.
> **Nothing is lost and ToU is never violated** - the delay is entirely in the conservative
> direction, and staleness stays bounded - but the real bound is ~75 min per source under
> saturation, not ~15 min, and live logs show saturation is the normal state (22 'live' vs 2
> 'nothing-due' ticks on 2026-08-03). If the tighter bound is ever actually wanted: shorten the
> Task Scheduler interval (10 min -> 6/hr capacity), or allow more than one source per tick. Side
> effect worth knowing: MO backfill throughput is currently about half the ToU-allowed rate.

**Command line - use Command Prompt, NOT PowerShell.** (Start menu -> type `cmd` -> "Command
Prompt". Windows 11's default terminal is PowerShell, where this command's quoting breaks
silently - an earlier multi-line version of this doc failed exactly that way.) One single line,
paste it whole, press Enter. No administrator elevation needed. Adjust the `node.exe` path only
if `where node` prints something different; absolute paths throughout mean Task Scheduler's
working directory doesn't matter. Omitting `/ru` registers it for the current user, running only
while logged on (a locked screen still counts as logged on) - after a reboot it resumes at first
login, and missed ticks are harmless because due-ness is durable in the database:

```
schtasks /create /tn "VisibleGov Scheduled Ingestion" /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-ingest.js" /sc minute /mo 15 /st 00:00 /f
```

Expected output: `SUCCESS: The scheduled task "VisibleGov Scheduled Ingestion" has successfully
been created.`

- `/sc minute /mo 15` - repeats every 15 minutes, indefinitely (no end date unless you add `/ed`).
- `/ru "%USERNAME%"` runs it as your own account, only while you're logged on (no password
  needed). If you want it to run even while logged out, use the Task Scheduler GUI instead
  (Actions tab -> this same command; General tab -> "Run whether user is logged on or not," which
  will prompt for your password once). **This is what Lance actually did (2026-07-31 late night):**
  ran the one-liner above first, then switched the task to this S4U/"logged on or not" mode via
  the GUI, so it survives logouts and reboots without needing to stay signed in.
- `/f` overwrites a prior registration with the same name - safe to re-run this command if you
  ever change the schedule.

**GUI equivalent**, if preferred: Task Scheduler -> Create Task -> General: name it; Triggers -> New ->
"On a schedule" -> Daily, repeat task every **15 minutes** for a duration of **Indefinitely**;
Actions -> New -> Program: `C:\Program Files\nodejs\node.exe`, Arguments:
`--env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-ingest.js`, Start in:
`F:\VisibleGov` (redundant with the absolute `--env-file` path, but harmless to set).

### Check the task's own "Stop the task if it runs longer than" setting - it must EXCEED 75 minutes

This is a **separate setting from everything above** - it's Windows' own execution-time limit on
the *whole scheduled task*, not anything this script controls. The `schtasks /create` command
above does not set it explicitly, so **check it via the GUI after creating the task**: Task
Scheduler -> find "VisibleGov Scheduled Ingestion" -> Properties -> **Settings tab** -> "Stop the task
if it runs longer than."

If that value is *shorter* than `legiscan`'s own 75-minute timeout, Windows will kill the entire
scheduler process itself partway through a legitimate `legiscan` run - and because that's a forced
process termination from OUTSIDE this script (not `spawnSync`'s own timeout), **none of this
script's own honest-recovery logic gets a chance to run**: the lock is never released by its own
`finally` block (it self-heals eventually via the next tick's stale-reclaim, which is fine), but
any `ingestion_runs` row `legiscan` had already opened would be stranded at `status='running'`
with nothing to close it - exactly the lying-about-state problem this build went out of its way to
prevent, reintroduced from a layer above it.

**Recommendation: uncheck "Stop the task if it runs longer than" entirely, or set it to at least 2
hours.** This script's own per-source timeouts (8 minutes default, 75 minutes for `legiscan`) are
the real enforcement - Windows' own limit only needs to be generous enough to never fire first.

## How to verify it is alive

Two independent signals, on purpose - one from the scheduler's own perspective, one from the data's:

1. **The log file.** `.superpowers/artifacts/scheduler-logs/YYYY-MM-DD.log` (gitignored, one entry
   per tick). **The date in the filename is UTC, not local time** - Central time is 5-6 hours
   behind UTC, so any time after ~7pm Central (6-7pm during daylight time), "today's" log entries
   are already landing in *tomorrow's* dated file. If the file you'd expect looks stale or is
   missing entirely, check the next day's filename before assuming the scheduler stopped. A
   healthy scheduler shows an entry roughly every 15 minutes, almost all of them `live` - the
   registry is oversubscribed, so some source is nearly always due (see the 2026-08-05 correction
   under *Registering it*; on 2026-08-22: 86 `live` / 10 `nothing-due` / 0 `already-running`
   across 96 ticks) - with `nothing-due` only in quiet gaps and `already-running` rarely (the
   "alternating `nothing-due`/`already-running`/`live`" wording in the 2026-08-02 banner above
   described the first day after registration; superseded 2026-08-23); if the most
   recent entry across both today's-UTC and tomorrow's-UTC files is more than ~20 minutes old, the
   scheduled task itself has stopped firing (check Task Scheduler's history, not this repo).
2. **`npm run status`'s freshness block.** Reads `public_freshness` directly from the database -
   independent of whether the scheduler *ran*, it shows whether data actually *arrived*. If the
   log looks healthy but freshness doesn't move, something downstream (not the scheduler) is
   wrong.
3. Windows Task Scheduler's own History tab for "VisibleGov Scheduled Ingestion" shows exit codes
   over time - 0 is normal (success, nothing due, already-running, or the rare transient
   `lock-record-failed`, which self-heals on the next tick); non-zero is a real error
   (e.g. `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` missing) and is the one case worth investigating.
4. **A `failed` status for one source (via `npm run status`'s freshness block) is not itself proof
   of a stuck scheduler - check due-ness before assuming a problem.** Worked example, checked live
   2026-08-03: `legiscan` showed `status: failed`, last attempt started `2026-08-02T07:30:03Z`,
   failed 4m43s later (`finished_at` 07:34:46) on a real application error -
   `detail.error: "Error: legiscan-votes: could not write vote_reconciliation_flags row: duplicate
   key value violates unique constraint \"vote_reconciliation_flags_dedup_key\""`, `queries_used: 1`
   - not a scheduler timeout or kill (no `scheduler_attempt`/`scheduler_kill` marker in `detail`).
   At the check (2026-08-03, ~19h38m later), `LEGISCAN_MIN_INTERVAL_MS` - confirmed **24 hours** by
   reading the actual constant in `scripts/scheduled-ingest.js`
   (`LEGISCAN_MIN_INTERVAL_MS = envIntervalMs('LEGISCAN_MIN_INTERVAL_MS', ONE_DAY_MS, ONE_DAY_MS)`;
   `.env` grepped, no override present) - had **not yet elapsed**, so the scheduler correctly had
   not retried. Confirmed two independent ways: (a) elapsed time (19h38m) < 24h; (b) the
   scheduler's own log ticks agree - `legiscan.remainingMs` read `17,101,752` then `16,201,520`
   across two consecutive 15-minute ticks (`02:45:13Z` and `03:01:28Z`), counting down as expected,
   never stuck at a fixed value. Next retry was correctly due ≈`2026-08-03T07:30Z`. **The actual
   check, any time:** query `ingestion_runs` for that source's most recent `started_at`, compare
   elapsed time against its registry interval above, or just read `remainingMs` for that source in
   the latest scheduler log tick - only treat it as stuck if elapsed time exceeds the interval AND
   the scheduler log still shows it being skipped or reported `resolvable: false`. (The underlying
   application error is a separate defect - outside this document's scope, which covers the
   scheduler's own mechanism, not individual CLI bugs. **Update, same day:** root-caused and
   confirmed already fixed on `main` (commit `b1adbfa`, a type-blind `roll_call_id` comparison in
   `findExistingReconciliationFlag` - recurrence of PLAYBOOK_DELTA Lesson 21) via an independent
   multi-agent investigation + adversarial review, verdict SHIP, high confidence for the
   `~2026-08-03T07:30Z` retry. See `docs/CONTROLLER_BRIEFING.md`'s 2026-08-03 addendum for the full
   writeup.)
5. **Found live (2026-08-03, ~18:23 UTC), fix drafted same pass - step 4's own aggregate refresh
   had been silently failing since migration 0022 was applied, unrelated to legiscan or anything
   else in this document.** Found by reading `aggregatesResult.parsed.mode` out of every tick in
   `.superpowers/artifacts/scheduler-logs/2026-08-01.log` through `-03.log` directly: 66 (Aug 1)
   and 78 (Aug 2) `live`-mode ticks total, of which only **14 (Aug 1) and 19 (Aug 2) actually
   attempted a refresh** (most `live` ticks just check whether one is warranted and skip it) - 0
   failures across those real 33 attempts, then **11 consecutive failures**, every one since
   `2026-08-03T05:00:12Z` (10x after `mo-house-xml`, 1x after `legiscan`), all with the identical
   Postgres error `canceling statement due to statement timeout` (57014) and all failing in ~8-12
   seconds from tick start - the **last successful automated refresh was `2026-08-03T04:00:25Z`**,
   over 14 hours stale at discovery. Root cause traced exactly: migration `0018a_refresh_timeout.sql`
   fixed this same symptom on 2026-07-30 via a separate `alter function ... set statement_timeout =
   '600s'`; migration 0022 (applied 2026-08-03) later ran `create or replace function
   refresh_vote_aggregates()` to add the vote-duplicate exclusion join - Postgres's own documented
   behavior is that `CREATE OR REPLACE FUNCTION` resets any configuration a prior, separate `ALTER
   FUNCTION` had set, unless the new definition re-declares it. 0022's own comment ("UNCHANGED")
   was accurate about the function BODY but didn't account for 0018a's separate, later
   configuration patch. **Fix drafted same pass: `supabase/migrations/0026_fix_refresh_aggregates_
   timeout_regression.sql`** - this time `statement_timeout` is folded directly into the function's
   own `set` clause (not a separate `ALTER FUNCTION`), so it survives any future `CREATE OR REPLACE`
   that copies this file's header. ~~**Draft-then-apply, awaiting Lance - until it lands, this keeps
   failing every tick that would otherwise refresh.**~~ **(Historical: 0026 was applied 2026-08-03;
   this whole `statement_timeout` line was later superseded by the 0027/0028/0029 saga - see the
   top-of-file banner and item 5. All applied and live; nothing here awaits an apply.)** Note first:
   `aggregatesRefreshed: true` in a
   log entry means the scheduler decided a refresh was warranted
   (`run.outcome.wroteRows`, i.e. the source actually wrote new rows) - it is **not** proof the
   refresh succeeded; the nested `aggregatesResult.parsed.mode` is the real outcome, and reading
   only the outer flag would misreport 11 straight failures as healthy.
   **Likely root cause** (circumstantial but exact on every observable): `0018a_refresh_timeout.sql`
   set a function-level override - `alter function refresh_vote_aggregates() set statement_timeout
   = '600s'` - specifically because the PostgREST role's own default (~8s) is too short for a
   `REFRESH MATERIALIZED VIEW CONCURRENTLY` pass over 1.46M+ `vote_casts` rows (that file's own
   comment documents the original ~8s failures this was built to fix). `0022_vote_duplicates.sql`
   later re-declares the same function (`create or replace function refresh_vote_aggregates() ...
   set search_path = public, pg_temp as $$ ... $$`, needed only because the function's dependent
   matviews had to be dropped/recreated first) **without** re-declaring `statement_timeout` in that
   same statement. `CREATE OR REPLACE FUNCTION` replaces a function's entire declared config, not
   just its body - a setting from an earlier, separate `ALTER FUNCTION` is silently dropped unless
   the replacing statement redeclares it. This fits every observed fact: the failure onset lines up
   with 0022 being applied, and each of the 11 failures took ~8-12s - the ~8s PostgREST default
   reasserting itself, not a genuine 600s budget actually expiring (which would take up to ten
   minutes to fail, not eight seconds). `CHATLOG.md`/`TODO.md` already recorded two of these same
   `57014` failures right when Lance first applied 0022 (worked around once via a direct SQL-editor
   call, bypassing PostgREST) - neither doc connected that to the *scheduler's own* automated calls
   going on to fail the same way on every subsequent tick since; that connection is the new finding
   from this check.
   **Practical effect, ongoing:** the three public vote-aggregate matviews (`public_position_totals`,
   `public_party_alignment`, `public_party_position_totals` - the profile and party-alignment charts)
   have not been refreshed by any automated process since `2026-08-03T04:00:25Z`. Any `mo-house-xml`/
   `legiscan` votes ingested since then are sitting correctly in the base tables but are not yet
   reflected on public chart pages - the exact "profile charts silently drift behind the vote lists"
   outcome step 4 above exists to prevent, currently happening. **Not fixed here** (this check is
   read-only against the database, no writes) - the fix is a follow-up migration (or a one-off
   `alter function refresh_vote_aggregates() set statement_timeout = '600s';` re-run directly in the
   SQL editor, the same PostgREST-bypassing move already used once) that restores the override,
   ideally folded directly into the function's own next `create or replace` statement (e.g. `...
   set search_path = public, pg_temp set statement_timeout = '600s' as $$ ... $$`) so a future
   migration touching this function cannot silently drop it again the same way. Needs a `TODO.md`
   entry and Lance's own apply step (draft-then-apply, same as every other migration here) - flagged,
   not actioned, by this pass.
   **Update, 2026-08-04: fully resolved - this turned out to be three layers, not one, each found
   only after the previous one was actually fixed and re-tested against real production load.**
   Migration `0026` above (Lance-applied) worked immediately on its own - `npm run
   refresh:aggregates` completed clean in ~19s right after - but as `vote_casts` kept growing via
   the running scheduler, the manual RPC call started failing again with a *new*, shorter ceiling:
   Supabase's own edge/gateway infrastructure kills any synchronous REST/RPC request at a hard
   ~120-125s, confirmed by bypassing supabase-js with a raw `fetch` (still died at 125,374ms, HTTP
   504, `server: cloudflare`, body `"upstream request timeout"`) - independent of the function's own
   600s `statement_timeout`, since the HTTP connection watching the request dies first regardless of
   what Postgres itself is doing. **Fix: migration `0027_pg_cron_refresh_aggregates.sql`** -
   schedules `refresh_vote_aggregates()` as a native `pg_cron` job running every 30 minutes directly
   inside Postgres, no HTTP/PostgREST/gateway involved for the routine case; the function also gained
   its own durable `ingestion_runs` bookkeeping so `npm run status` stays authoritative even if a
   manual RPC call's own HTTP response times out. Applying `0027` alone did not finish the job:
   `pg_cron`'s own natural ticks still failed, now at Postgres's *native* `canceling statement due to
   statement timeout` (57014) at almost exactly 120s - a separate semantics trap, confirmed against
   real Postgres core-developer mailing-list threads: `statement_timeout` is armed once, at the start
   of the top-level statement, using whatever value is ambient at that instant, before the function
   body (or its own `set statement_timeout`) ever runs - so the function's 600s override (folded in
   by `0026`/`0027`) could never retroactively extend a deadline already fixed before the function
   started. Supabase's `postgres` database carries a built-in 2-minute database-level default, which
   was the actual ambient value in effect. **Fix: migration
   `0028_fix_statement_timeout_arm_timing.sql`** - raises that ambient database-level default itself
   (`alter database postgres set statement_timeout = '600s'`), the only fix that works given the
   arm-timing rule (a function-level `set` alone is not sufficient for a top-level call). Confirmed
   working via `cron.job_run_details`: failures shifted from exactly 120s to exactly 600s, proving
   the 600s ceiling was now the one actually in effect. With both timeout layers genuinely fixed,
   `pg_cron` ticks *still* failed - now hitting the real 600s ceiling on genuine query duration,
   always on the same statement (`refresh materialized view concurrently public_party_alignment`). A
   plain `EXPLAIN` (not empirical timing - the diagnostic that should have been reached for first)
   found the real root cause: all three matviews exclude superseded votes via a `left join
   vote_duplicates vd on ... where vd.id is null` anti-join (added by migration 0022), and Postgres's
   planner catastrophically misestimated that pattern's selectivity as **1 row** (true answer, given
   ~10,103 votes vs. 59 duplicates: ~10,044), cascading into Nested Loop joins across the entire
   downstream plan instead of Hash Joins - catastrophic once the true cardinality reaches ~1.34M
   rows. **Fix: migration `0029_fix_vote_duplicates_antijoin_planner_misestimate.sql`** - rewrites
   the same exclusion as `not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id =
   v.id)` (identical semantics, correct `Hash Anti Join` plan shape) across all three matviews, drop
   and recreate as migration 0022 already did for the same reason. **All three migrations (0027,
   0028, 0029) applied and verified live 2026-08-04:** three consecutive clean `succeeded` rows in
   `ingestion_runs` - two real `pg_cron` scheduled ticks landing exactly on the `*/30` boundary, plus
   a manual `npm run refresh:aggregates` run at ~19.4s wall-clock, matching the pre-outage healthy
   baseline exactly. Both the scheduled and manual paths confirmed working, not just one. A
   regression test (`tests/vote-duplicates-antijoin-migration.test.js`) now fails loudly if a future
   migration ever reintroduces the `left join ... is null` idiom for any of the three matviews.
   **Current state: both refresh paths (the native `pg_cron` job every 30 minutes, and this
   scheduler's own post-tick call) are healthy** - full write-up in `TODO.md`'s NOW section and
   `CHATLOG.md`'s 2026-08-04 entries. (One separately-tracked item remains open, not blocking:
   `0027`'s own exception handler can never actually leave a `'failed'` row in `ingestion_runs` on a
   genuine error, due to how PL/pgSQL savepoints a `BEGIN...EXCEPTION` block. The routine case
   completes in ~19s so it rarely fires - but the 2026-08-05 phase-2 deep audit rated this more
   seriously than "low-priority": the pg_cron leg is the documented *primary* freshness guarantee,
   and this gap means a pg_cron refresh failure records NOTHING, so `public_freshness`/`npm run
   status` would keep showing an aging "succeeded" during a failure streak - the same silent-failure
   class that produced the earlier 14-hour outage. The honest fix (per the audit and TODO.md): drop
   the exception handler and rely on `cron.job_run_details` for observability. See `TODO.md` for the
   fix-later plan and the audit's fuller framing.)
   **Update 2026-08-23 - "both refresh paths healthy" no longer holds for the post-tick leg,
   benignly.** The `pg_cron` leg is fine (its `refresh-aggregates` rows keep landing `succeeded` on
   every `*/30` boundary). The scheduler's own post-tick call, however, fails with `canceling
   statement due to lock timeout` on roughly half its attempts - every failure on a :00/:30 tick,
   where it races `pg_cron`'s refresh for the same matview locks (2026-08-22: 12 of 23; 2026-08-23:
   12 of 20 by 14:30Z; every :15/:45 attempt `refreshed`). So the reading rule above -
   "`aggregatesResult.parsed.mode` is the real outcome" - needs one qualifier: a `lock timeout`
   failure within ~60s of a :00/:30 boundary is the benign pg_cron-owns-this-refresh collision, not
   a failure streak. Confirm health from the `pg_cron` rows (`ingestion_runs` where
   `source='refresh-aggregates'`, newest first, or the `refresh-aggregates` line of `npm run
   status` - `succeeded` within the last ~30 minutes), and see the 2026-08-23 note under step 4
   for the two fix options captured in TODO.md 2026-08-22 (not built).

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
`legiscan` run was in progress - see *Per-source timeouts* above) is automatically reclaimed on
the next tick, with a warning logged. One guard on that reclaim (`MAX_LOCK_DURATION_MS`, 2 hours):
a lock whose declared duration is missing, corrupt, or above that ceiling - a hand-edited file, a
future bug - is judged by the 10-minute default instead of being honored, so a bad value can never
wedge every later tick into a permanent `already-running` that Task Scheduler's history would show
as a healthy exit 0. You can also delete
`.superpowers/artifacts/scheduler.lock.json` by hand at any time if you want a clean next tick
immediately rather than waiting out whichever window applies.

## Known gap: `legiscan` may report `resolvable: false`

The scheduler looks up the current MO session's `legiscan_session_id` from the `sessions` table
(keyed off `src/adapters/mo-house-xml.js`'s `DEFAULT_MO_HOUSE_SESSION` - the same constant the
House CLI falls through to; corrected 2026-08-23, it was never defined in `ingest-mo-house.js`)
rather than guessing - see
`resolveLegiscanSessionId`'s own comment in `scripts/scheduled-ingest.js`. As of this writing that
resolves correctly (session `261` -> LegiScan session `2239`). If it ever stops resolving, the
`legiscan` source is skipped honestly (logged, `resolvable: false`, with a reason) rather than
guessing - it does not block the other four sources (a lookup failure for any one source is
isolated from the rest; see "What it does," step 2).

## RESOLVED 2026-08-02: the TODO item 25 duplicate-session defect this scheduler used to feed is now fixed

**This section originally warned (correctly, at the time) that registering this scheduler would
mean `mo-senate-web` kept feeding a known, currently-open duplicate-MO-session defect forever.**
That defect (TODO.md item 25: session identifier `'2026'`, no `legiscan_session_id`, duplicating
the real session `'261'`/`legiscan_session_id 2239`) is now closed, verified against CHATLOG.md's
2026-08-01/02 entries and TODO.md's own item 25 (struck through as done):

- **The existing duplicate was cleaned up 2026-08-01:** 34 duplicate bills merged into their
  canonical twins, 31 votes redirected, the duplicate `'2026'` session row deleted -
  independently re-verified against the live DB afterward (0 duplicate bills, 0 orphaned votes,
  31/31 redirected votes correct).
- **The ROOT CAUSE - not just the cleanup - was closed 2026-08-02.** `ensureSessionRow`
  (`src/cli/ingest-mo-senate.js`) no longer inserts a bare-year `sessions` row with no
  `legiscan_session_id` on every invocation; it now uses the same year+name session resolution
  `ensureLegiscanSessionRow` already proved correct, so `mo-senate-web`'s normal
  `--year <current> --limit 1` run can no longer mint a fresh `'2026'`-style duplicate. (A same-day
  self-correction closed a false-ambiguity risk the first cut of this fix would have introduced the
  next time MO calls a special session - see CHATLOG 2026-08-02.)

**What this means for the scheduler:** `mo-senate-web` keeps running on its 30-minute cooldown
floor (in practice ~hourly under saturation - see the 2026-08-05 correction under *Registering it*;
"30-minute cadence" was the original wording here) exactly as before - nothing about the
scheduler itself changed - but it is no longer
feeding a duplicate-session defect while it does. Re-verify this claim against `sessions` /
TODO.md if this document is read long after 2026-08-02 and the fix's continued correctness matters
(12 real scheduler ticks had run clean with zero duplicates recreated as of the 2026-08-02 check
that closed this item).

## MO Senate journal attribution kinds and non-bill roll calls (2026-08-23)

`ingest-mo-senate.js` run detail now carries the attribution kinds the parser produced that run -
`motion` and `preceding_taken_up` always (seeded at 0), plus any of `conference_committee_report`,
`title_block`, `preceding_title_block`, `amendment_instruction`, `pending_amendment_recall`,
`narrative_window` that actually occurred (a kind that did not occur is absent, not 0; corrected
2026-08-23 - `pending_amendment_recall` was missing from this list) - and `non_bill_votes`
(quorum calls, simple-resolution adoptions/amendments, journal amendments, appointment
confirmations: recorded roll calls that are mechanically not votes on a bill; reported, never
stored, never a failure). A day completes when `failures` is 0, so a day made only of non-bill
roll calls completes. The 20 days quarantined on `bill_refs` through 2026-08-22 were this class;
see CHATLOG 2026-08-23 and tests/mo-senate-journal-attribution.test.js. To replay a quarantined
day after a parser fix: delete its `.failed.json` in `.superpowers/artifacts/mo-senate-journals/`
and the day re-enters the worklist (the scheduler drains current-year days one per journal-day
run - `mo-senate-web` runs about hourly under saturation and alternates a journal-index refetch
with one journal day, so expect roughly one day per 1.5-2 hours, not one per tick; read
`total_pending_days` in the run detail to see what remains - see *What a `mo-senate-web` tick
actually does* above; prior years need a manual `--year <Y> --limit 1` run, and the 2018 worklist
is 52 days long, per TODO.md 2026-08-23).
