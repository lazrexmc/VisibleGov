# Task brief — spend gates + scheduled ingestion

Two tasks, **in this order**, as two separate commits. Both approved by Lance 2026-07-31
("add the spend gate / build the schedule ingestion").

---

## TASK 1 — mechanical spend gates on the two ungated model-calling CLIs

`src/cli/gloss.js` (line ~234), `src/cli/extract-terms.js` and `src/cli/golden.js` (~184) all carry
a mechanical env gate. **`src/cli/summarize.js` and `src/cli/verify.js` do not** — both default
`dryRun: false`, both call `getAnthropicClient()` and bill Lance's account, and both are exposed as
`npm run summarize` / `npm run verify`. This is the unfinished half of CLAUDE.md's own policy
("Mechanical enforcement exists where possible — extend that pattern to new model-calling tools")
and it sits against Lance's standing spend hold.

- Add the SAME guard-clause shape `gloss.js` uses (read it and mirror it — do not invent a new
  pattern, do not refactor the existing ones). Env var names: `SUMMARIZE_RUN_APPROVED` for
  summarize.js, `VERIFY_RUN_APPROVED` for verify.js.
- The gate must fire **before any Anthropic client is constructed or any bill is fetched for
  sending**, and must NOT fire when `--dry-run` is passed (dry runs cost nothing and must stay
  freely runnable — that is what makes the gate acceptable rather than obstructive).
- Error message must state, in the gloss.js voice: this run costs real money, Lance requires
  explicit per-run approval, set `<VAR>=yes` to proceed.
- Typed error class consistent with the file's existing conventions.
- TDD: gate blocks a live run; `--dry-run` is unaffected; `<VAR>=yes` permits it. Fake the client —
  **no live API call in tests, ever.**

---

## TASK 2 — `scripts/scheduled-ingest.js`: real, durable, OS-scheduled ingestion

**The problem it solves.** All recurring ingestion to date has been a bash loop inside a Claude
Code session — it dies when the session ends and is finite. Lance asked directly whether data stays
fresh; the honest answer today is no. This is TODO build-queue item 13, flagged a priority
2026-07-28 and never built.

### Critical design constraint (do not miss this)

The ingest CLIs **do not exit when their ToU cooldown has not elapsed — they SLEEP until it has**
(`enforceDurableCooldown`, `src/cli/ingest-mo-senate.js:446`; same pattern in ingest-mo-house.js).
A scheduler that blindly invokes them every N minutes will stack overlapping sleeping processes.

So the scheduler must **decide for itself** what is due:
- Reuse the EXPORTED `remainingCooldownMs(lastStartedAtIso, minIntervalMs)` — import it, do not
  reimplement the arithmetic.
- Query `ingestion_runs` for each source's latest `started_at` (the same durable signal the CLIs
  use), compute remaining cooldown, and **only invoke a CLI whose cooldown has fully elapsed**.
- Invoke **at most ONE source per run** — keeps each invocation short and bounded.

### Behavior

Entry: `node --env-file=.env scripts/scheduled-ingest.js [--dry-run] [--only <source>]`

1. **Single-instance lock.** A lock file under `.superpowers/artifacts/` carrying pid + ISO
   timestamp. If a live lock exists → log "already running", exit 0 (NOT an error: an overlapping
   tick is normal and must never surface as a scheduler failure). Stale-lock detection: a lock older
   than a documented max run duration is reclaimed with a logged warning. Always release the lock,
   including on throw (try/finally).
2. **Pick the single most-overdue due source**, from this registry — each entry declares its source
   key, its min interval, and the command to run:
   - `mo-senate-web` — `src/cli/ingest-mo-senate.js --year <current> --limit 1`,
     `MO_SENATE_MIN_INTERVAL_MS` (30 min, published ToU)
   - `mo-house-xml` — `src/cli/ingest-mo-house.js --limit 1`, `MO_HOUSE_MIN_INTERVAL_MS`
     (30 min, **house.mo.gov's own published terms** — never shorten this)
   - `us-congress` — the federal roll-call delta (read `src/cli/ingest.js` to find the correct
     current-Congress invocation; federal votes are the one stream with NO scheduled ingestion
     today, so new federal votes simply never arrive). Congress.gov's polite limiter already
     exists; pick a conservative interval (≥1 hour) and comment the reasoning.
   - `legiscan` — the dataset-hash check. ⛔ **Suspension-level rule:** `dataset_hash` comparison is
     MANDATORY before any `getDataset` download. `ingest-legiscan.js` already implements this
     correctly — invoke it, never re-implement the gate. Datasets are weekly; interval ≥24h.
   **Restriction on mo-house-xml (TODO 31, do not violate):** current-session ingestion ONLY.
   `mo_house_id` is declared table-wide `unique` (0005) against a current-only roster, so a
   multi-era/historical House backfill silently misattributes a successor's votes to their
   predecessor. The scheduler must never pass a historical session/year to the House CLI. State
   this in a comment at the registry entry.
3. **Run it as a child process** (`node --env-file=.env <cli> …`), capture stdout/stderr, and record
   the outcome. A CLI failure is logged and reported, never crashes the scheduler run.
4. **After a run that actually wrote anything**, invoke `scripts/refresh-aggregates.js` — this is
   the STANDING PRACTICE from the ledger (every loop batch ends with an aggregate refresh, else the
   profile charts silently drift behind the vote lists; that drift was a real user-visible defect
   on 2026-07-31). Skip it when nothing was written.
5. **Log** to a dated file under `.superpowers/artifacts/scheduler-logs/` (gitignored) AND to
   stdout: timestamp, which source was chosen and why (or "nothing due"), the CLI's honest counts,
   and whether aggregates were refreshed. Lance must be able to read one file and know it is alive.
6. **NEVER call a model.** This script is ingestion only. Add an explicit comment saying so — it is
   the one automated, unattended thing in the repo, and it must remain incapable of spending money.
7. `--dry-run`: report what WOULD run and each source's remaining cooldown; take the lock, make zero
   fetches, zero writes.
8. Exit code: 0 for success and for "nothing due"/"already running"; non-zero only on a real error,
   so Task Scheduler's own history is meaningful.

### Registration is LANCE'S step (draft-then-apply)

Do NOT register a scheduled task, and do not run `schtasks`. Registering something that runs forever
on his machine is his call. Instead produce `docs/SCHEDULED_INGESTION.md` containing:
- what the scheduler does, what it will never do (no model calls, no ToU violations)
- the exact `schtasks /create …` command (or Task Scheduler UI steps) to run it every 15 minutes —
  15 min is deliberately shorter than every source interval so nothing is ever missed while the
  per-source cooldowns still do the real gating
- how to verify it is alive (the log file, `npm run status`'s freshness block)
- how to pause/remove it
- an explicit note that the MO cadences are published ToU and must not be shortened

Add `npm run schedule:ingest` to package.json.

## Constraints for both tasks

Bare `node --test` from repo root; baseline **1975** stays green. TDD red-first. Typed errors.
Honest counts. selectAll/pagination discipline for any multi-row read (the 1000-row cap has bitten
this repo repeatedly). No live API calls and no live DB writes from tests. Commits end with:

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
