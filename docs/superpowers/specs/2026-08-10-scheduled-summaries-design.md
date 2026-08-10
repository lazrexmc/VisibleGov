# Scheduled Summaries — Autonomous Billed Summary Pipeline (design)

**Date:** 2026-08-10 · **Approved by:** Lance (this session; engine, budget, scope, and design
each approved explicitly) · **Status: PARKED — design approved, implementation NOT started.**
Lance, same session, immediately after design approval: *"But our focus right now is what we've
been doing, I have no credits loaded at the moment so we should proceed how have been after the
spec is written."* Pick this up (spec review → writing-plans → implement) only when Lance has
loaded API credits AND explicitly says go. Until then the subagent wave campaign continues and
this file is a complete record of every decision already made.

## What this is

A second OS-scheduled process, `scripts/scheduled-summaries.js`, sibling of
`scripts/scheduled-ingest.js`, that autonomously authors, verifies, and records plain-language
bill summaries under trust model v3 — so the summary backlog finishes and stays finished without
Lance triggering waves. Lance's directive: *"I'd like to move away from the system and let it
become more autonomous and get real OS-level scheduling like the ingest does."*

Decisions made during brainstorming (each answered by Lance directly):
- **Engine: billed API** (Haiku authors, Sonnet verifies/checks — the config the 2026-08-09
  campaign proved at $0.041/publish, zero credit errors in 288 calls). Not headless Claude Code,
  not a cloud agent.
- **Budget: $5.00 per ISO week, hard-stopped in code.** A durable ledger + cap replaces per-run
  approval for THIS runner only.
- **Scope: all three lanes** — fresh backlog (recency-first), flagged-draft conversion, and
  oversize (>100k chars) monsters.

## Non-negotiables inherited unchanged

- **Trust model v3 is untouched.** Every publish/flag decision is made by
  `src/cli/summary-queue.js record`'s mechanical gates. The runner never writes summary rows
  itself, never loosens a gate, and publishes only verified-CLEAN items. Facts-only; receipts
  (evidence quotes, section citations) exactly as today.
- **`scripts/scheduled-ingest.js` is not modified.** Its "NEVER CALLS A MODEL" guarantee stays
  true by keeping all model-calling code in a separate process with its own lock.
- **Never assume a credit reload.** A billing/credit-class API error ends the tick immediately
  with an honest log line; subsequent ticks retry cheaply (first failed call costs $0) and keep
  logging until Lance reloads. No fallback to any other spend path.
- **Draft-then-apply, no migrations needed:** the design deliberately requires zero schema
  changes.

## Architecture

One tick = one Task Scheduler invocation of
`node --env-file=.env scripts/scheduled-summaries.js [--dry-run]`. Recommended registration:
**daily**. Each tick:

1. **Lock** — acquire `.superpowers/artifacts/summary-scheduler.lock.json` (same nonce-ownership
   + stale-reclaim pattern as the ingest scheduler's lock, separate file). Live lock → log
   "already running", exit 0.
2. **Budget check** — compute this ISO week's spend (see Ledger) and this tick's allowance:
   `min(weekly_remaining, PER_TICK_CAP)` with `WEEKLY_CAP_USD = 5.00` and
   `PER_TICK_CAP_USD = 1.00` (constants in the script; env-overridable DOWNWARD only, mirroring
   envIntervalMs's floor-only discipline in reverse — a typo can shrink spend, never grow it).
   Allowance below the observed worst-case cost of the smallest queued bill → log + exit 0.
3. **Queue build (live, no manifests)** — spawn `src/cli/summary-queue.js plan --dry-run`, parse
   the queue, and sort recency-first exactly as `scripts/export-summary-wave.mjs` does (session
   start_date DESC → passage priority → text_length ASC). Lane order within a tick:
   a. **Fresh** (zero summary rows) — new arrivals surface automatically at the top;
   b. **Draft conversion** — flagged drafts, oldest-flag first, skipping any bill with ≥2 prior
      superseded/rejected attempts (parked, logged);
   c. **Monster** — at most ONE >100k-chars bill per tick, and only if remaining tick allowance
      exceeds 1.5× the worst observed per-bill cost so far this tick.
4. **Per-bill chain** — the billed 4-stage chain extracted from `scripts/summary-probe-api.mjs`
   into a shared module `src/lib/billed-summary-chain.js` (the probe CLI keeps working, now
   importing the same module): Haiku author → Sonnet verify → Sonnet blind provisions → Sonnet
   coverage; streaming; json_schema outputs; real-usage cost accounting per call; per-stage
   checkpoints under `.superpowers/artifacts/scheduled-summaries/stages/<bill_id>-<hash8>.json`
   (keyed by bill AND text hash so a text revision invalidates the checkpoint).
5. **Record through the gates** — write the tick's envelopes to
   `.superpowers/artifacts/scheduled-summaries/records-<runId>.json`, then spawn
   `summary-queue.js record --file <records>` (fresh + monster lanes) and a second records file
   with `--replace-drafts` (conversion lane). Parse the CLI's JSON output; counts go in the log
   and the run row.
6. **Close** — write the ingestion_runs row (see Ledger), release the lock, append the honest
   UTC log line: date, bills attempted, published/flagged/rejected, spent this tick, week total,
   and any error class.

### Draft-conversion lane detail

Objections are read from the DATABASE, not wave artifacts: the draft summary row (status
'draft') plus its `summary_verifications` row supply (a) verdicts with `supported: false` →
"objection: bullet N unsupported: <reason>"; (b) completeness coverage rows with
`covered: false` → "objection: omitted provision: <provision text>"; (c) the draft's
`summary_note` gate reason verbatim. The re-author call is Haiku with the wave workflow's
reAuthor prompt shape (prior summary JSON + numbered objections + all mechanical rules — port
the prompt text from `.claude/workflows/summary-wave.js`'s reAuthor branch). The re-authored
summary then runs the FULL fresh verify/provisions/coverage chain (never reuses prior verdicts)
and records via `--replace-drafts`, which retires the superseded draft to 'rejected' with the
existing audit note.

### Ledger (budget durability, zero migrations)

Each tick opens an `ingestion_runs` row via the existing `openRun(client,
'scheduled-summaries')` and closes it with `closeRun(..., status, detail)` where detail carries:
`{week_key: '2026-W33', spent_usd, per_call_count, published, flagged, rejected, parked,
balance_depleted: bool}`. Weekly spend = fetch rows with `source = 'scheduled-summaries'`
created in the last 10 days, filter `detail.week_key === currentWeekKey()`, sum `spent_usd`.
`week_key` is the UTC ISO-8601 week. A crashed tick that never closed its row is counted AS IF
it spent its full tick allowance (conservative: unknown spend is treated as spent) — the next
tick logs that assumption honestly.

### Failure honesty

- Per-bill chain error (schema, refusal, max_tokens): checkpoint keeps every paid stage; the
  bill is skipped this tick with the error logged; it retries in a later tick for only the
  missing stages.
- Billing/credit error class (HTTP 400/402 with credit-related message): set
  `balance_depleted: true` on the run row, log `BALANCE DEPLETED — reload required`, end the
  tick. Later ticks keep running the $0 parts (queue build, log) and re-probe with the first
  real call.
- The record CLI blocking or failing: envelopes stay on disk in the records file; the error is
  logged; nothing is lost (same recovery property the wave campaign relied on).
- Structural rejects (MalformedSummaryError, e.g. the HB 2465 re-enactment class): logged and
  PARKED (a parked list in `.superpowers/artifacts/scheduled-summaries/parked.json` with
  reasons) so the budget never re-pays for a known-unpublishable bill. Parked bills are
  reported in the log and in `npm run status`; unparking is a human act (delete the entry).

### Monitoring

`scripts/data-status.js` grows a "summary scheduler" freshness block: last tick time, last
status, this week's spend vs cap, published this week, parked count. (While in there, fix the
known gauge bug per TODO inbox: "summaries draft/flagged" becomes a positive
`status=eq.draft` count with retirees shown separately — PLAYBOOK lesson 36.)

### Policy changes (docs, same commit as the code)

- `CLAUDE.md` standing policies: add the carve-out — *"scripts/scheduled-summaries.js runs
  billed calls unattended under a code-enforced $5.00/ISO-week cap (Lance, 2026-08-10); this
  ledger+cap IS the per-run approval for this runner only. Every other billed call still
  requires explicit per-run approval."*
- New runbook `docs/SCHEDULED_SUMMARIES.md` (shape of `docs/SCHEDULED_INGESTION.md`): Task
  Scheduler registration steps (Lance runs schtasks himself — agents never register tasks),
  changing the cap, reading the log, unparking bills, what BALANCE DEPLETED means.
- Memory + TODO RESUME HERE updated when this ships.

## Components (files)

- `src/lib/billed-summary-chain.js` — NEW: the 4-stage billed chain + pricing + checkpointing,
  extracted from `scripts/summary-probe-api.mjs`; exported as `runBillChain(client, bill,
  opts)` returning `{envelope, spentUsd}` plus `classifyBillingError(err)`.
- `scripts/summary-probe-api.mjs` — MODIFIED: imports the shared module; CLI behavior unchanged.
- `scripts/scheduled-summaries.js` — NEW: lock, ledger, queue, lanes, record spawning, log.
- `src/lib/draft-objections.js` — NEW: reads a draft's objections from summaries +
  summary_verifications; pure query + assembly, unit-testable with fake clients.
- `scripts/data-status.js` — MODIFIED: scheduler freshness block + lesson-36 gauge fix.
- `docs/SCHEDULED_SUMMARIES.md`, `CLAUDE.md`, `README.md` — docs.
- Tests: `tests/scheduled-summaries.test.js` (week-key math, budget arithmetic from fake run
  rows incl. the crashed-tick assumption, lane ordering, monster cap, parked-list behavior),
  `tests/draft-objections.test.js` (objection assembly from fixture verdict rows), extension of
  existing suites where the probe-script extraction touches them. Zero live API/DB calls in
  tests, per repo discipline.

## Explicitly out of scope (YAGNI)

- Glossary pipeline autonomy (different pipeline, own project).
- Cloud/off-PC execution (Task Scheduler tolerates the PC being off; missed ticks roll within
  the week).
- Any change to verifier/gate semantics beyond reusing them.
- Auto-reload, auto-raise, or any budget behavior not "hard stop at the cap."
- Retiring the subagent wave path (stays available for manual campaigns).

## Success criteria

1. Registered task ticks daily; `npm run status` shows the scheduler alive with honest spend.
2. A week of unattended operation publishes ~100-120 summaries (at observed cost) with zero
   human touches and zero gate changes.
3. Killing the process mid-tick loses no paid work (checkpoints) and the next tick self-heals
   (lock reclaim, conservative ledger assumption, honest log).
4. When the balance runs dry, the system says so plainly and keeps saying so — and spends
   nothing further.
