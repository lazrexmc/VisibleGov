# Scheduled ingestion — `scripts/scheduled-ingest.js`

The first thing in this repo designed to run **unattended, on Lance's machine, forever**, with no
human watching a single invocation. Everything about its design follows from that one fact. This
doc is what he needs to register it (his own step — an agent never runs `schtasks`) and to keep an
eye on it afterward.

## What it does

Each invocation:

1. Takes a single-instance lock (`.superpowers/artifacts/scheduler.lock.json`). If another
   invocation is already holding it, this one logs `already-running` and exits 0 — that is a
   **normal**, expected outcome (see cadence below), never a failure.
2. Checks all four ingestion sources' real due-ness by querying `ingestion_runs` for each one's
   last `started_at` and comparing against its own minimum interval — the *same* durable,
   cross-process signal the ingest CLIs' own cooldown check (`enforceDurableCooldown`) already
   relies on. **It never blindly invokes a CLI.**
3. Picks the single **most overdue** due source (the one that has gone longest since it last ran)
   and runs it as a short child process: `node --env-file=.env <cli> --limit 1` (or the equivalent
   for that source — see the registry table below). At most one source per tick.
4. If that run actually wrote anything, refreshes the vote aggregates
   (`scripts/refresh-aggregates.js`) — the same standing practice every ingest batch has always
   followed, so the profile charts never silently drift behind the vote lists.
5. Logs one entry — to stdout and to a dated file — recording what it checked, what it chose (or
   why nothing was due), the CLI's own honest counts, and whether aggregates were refreshed.

## What it will never do

- **Never calls a model.** It imports no Anthropic client, no `lib/summarizer.js`, no
  `lib/verifier.js` — nothing that can bill Lance's account. It only ever spawns the four
  ingestion CLIs below and `scripts/refresh-aggregates.js`. This is enforced by the import list,
  not just a comment; verify by inspection if this file ever changes.
- **Never violates a published rate limit.** The MO Senate and MO House intervals below are
  imported directly from the adapters that already encode senate.mo.gov's / house.mo.gov's real
  published terms — they are **not environment-overridable**, so a typo'd env var cannot shorten
  them. The two intervals this script chooses itself (us-congress, legiscan) are
  environment-overridable but mechanically floored at the values below: an override can only make
  them *more* conservative, never less.
- **Never runs a MO House historical/multi-era backfill.** `mo_house_id` is a table-wide unique
  constraint (migration 0005) against the *current* roster only — passing a historical year/session
  to the House CLI would silently misattribute a successor's votes to their predecessor (TODO item
  31). The registry entry for `mo-house-xml` passes `--limit 1` only, nothing else, permanently.
- **Never stacks overlapping processes.** The single-instance lock (step 1 above) and the
  due-ness check (step 2) both have to agree before anything runs.
- **Never guesses a LegiScan session id.** If `sessions.legiscan_session_id` isn't on file for the
  current MO session, the `legiscan` source is reported `resolvable: false` and skipped, with the
  reason logged — never an "most recent session" heuristic. See *Known gap* below for why.

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
| `us-congress` | `ingest.js --source us-congress --year <current> --rolls <lo>-<hi>` | ≥1 hour (`US_CONGRESS_MIN_INTERVAL_MS`, default 1h) | Congress.gov has its own polite limiter already; this is our own conservative check-frequency choice. `<lo>-<hi>` is computed each tick from the highest US House roll number already on file — a small forward window past it. Every roll in that window that doesn't exist yet 404s harmlessly (recorded, non-fatal); every roll that already exists is a no-op. This is the one federal stream that had **no** scheduled ingestion before this — new House roll calls simply never arrived. |
| `legiscan` | `ingest-legiscan.js --session <resolved id>` | ≥24 hours (`LEGISCAN_MIN_INTERVAL_MS`, default 24h) | Datasets refresh weekly (Sunday 5am ET); `ingest-legiscan.js`'s own `dataset_hash` gate (⛔ suspension-level LegiScan rule) makes a same-dataset tick cheap. `<resolved id>` comes from `sessions.legiscan_session_id` for the current MO session — see *Known gap* below if this ever reports `resolvable: false`. |

`US_CONGRESS_MIN_INTERVAL_MS` / `LEGISCAN_MIN_INTERVAL_MS` can be raised via `.env` if Lance ever
wants these to run less often; any value below the defaults above is silently floored back up to
them.

## Registering it (Lance's step — never run `schtasks` from an agent)

Run every 15 minutes — deliberately shorter than every source's own interval above, so a tick is
never more than ~15 minutes late; the per-source cooldowns above do the real gating, not this
number.

**Command line** (adjust the `node.exe` path if `where node` gives something different; using
absolute paths throughout means Task Scheduler's working directory doesn't matter):

```
schtasks /create /tn "VisibleGov Scheduled Ingestion" ^
  /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-ingest.js" ^
  /sc minute /mo 15 ^
  /st 00:00 ^
  /ru "%USERNAME%" ^
  /f
```

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

## How to verify it is alive

Two independent signals, on purpose — one from the scheduler's own perspective, one from the data's:

1. **The log file.** `.superpowers/artifacts/scheduler-logs/YYYY-MM-DD.log` (gitignored, one entry
   per tick). A healthy scheduler shows an entry roughly every 15 minutes, alternating between
   `nothing-due`, `already-running`, and occasional `live` runs as each source's cooldown elapses.
   `tail`/open today's file; if the last entry is more than ~20 minutes old, the scheduled task
   itself has stopped firing (check Task Scheduler's history, not this repo).
2. **`npm run status`'s freshness block.** Reads `public_freshness` directly from the database —
   independent of whether the scheduler *ran*, it shows whether data actually *arrived*. If the
   log looks healthy but freshness doesn't move, something downstream (not the scheduler) is
   wrong.
3. Windows Task Scheduler's own History tab for "VisibleGov Scheduled Ingestion" shows exit codes
   over time — 0 is normal (success, nothing due, or already-running); non-zero is a real error
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

If the machine ever loses power mid-run, the lock file self-heals: a lock older than 10 minutes
(`MAX_RUN_DURATION_MS`) is automatically reclaimed on the next tick, with a warning logged. You can
also delete `.superpowers/artifacts/scheduler.lock.json` by hand at any time if you want a clean
next tick immediately rather than waiting out the 10 minutes.

## Known gap: `legiscan` may report `resolvable: false`

The scheduler looks up the current MO session's `legiscan_session_id` from the `sessions` table
(keyed off `ingest-mo-house.js`'s own `DEFAULT_MO_HOUSE_SESSION`) rather than guessing — see
`resolveLegiscanSessionId`'s own comment in `scripts/scheduled-ingest.js`. As of this writing that
resolves correctly (session `261` → LegiScan session `2239`). If it ever stops resolving, the
`legiscan` source is skipped honestly (logged, `resolvable: false`, with a reason) rather than
guessing — it does not block the other three sources.

Separately, **TODO.md item 25** documents a real, currently-open duplicate-MO-session defect
(session `'2026'` vs `'261'`) caused by a *different*, non-scheduler source (not `mo-house-xml`,
whose default session — `261` — is already the correct one). This scheduler's registry does not
touch whatever is producing that duplicate; it's flagged here only so it isn't mistaken for
something this script caused.
