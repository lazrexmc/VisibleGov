# Task review — spend gates + scheduled ingestion (de2bf54..3e12a1e)

Reviewer: session 8ecd5d8c (task-reviewer). Date 2026-07-31.
Reviewed as **hostile-environment code**: `scripts/scheduled-ingest.js` is the first thing in this
repo that runs unattended, forever, with nobody watching a single invocation.

---

## Verdicts

| | Verdict |
|---|---|
| **Task 1 spec** (spend gates) | ✅ **PASS** |
| **Task 2 spec** (scheduler) | ❌ **FAIL** — one binding brief requirement violated (docs honesty, review question C) |
| **Code quality** | ❌ **FAIL** — one Critical unattended-operation defect (C1) in the core selection path |

Task 1 is shippable as-is. Task 2 is close — the mechanics are genuinely good and every
suspension-level rule holds — but it must not be registered with Task Scheduler until C1 and C2
are fixed.

---

## Mechanical verification (run by the reviewer, not taken from any report)

**Test suite** — `node --test` from `F:\VisibleGov` (bare, repo root):

```
ℹ tests 2025
ℹ suites 0
ℹ pass 2025
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 22221.9775
```

Extracted fail-count line: **`ℹ fail 0`**. Independent corroboration: `grep -c "^not ok"` = **0**.
Baseline 1975 + 50 new = 2025. Matches the implementer's claim. Gated on the extracted line, not
on exit status (PLAYBOOK_DELTA lesson 14).

**Commit hashes** — `git log --oneline` confirms `3e12a1e` (scheduler) on top of `41936f0` (spend
gates) on top of BASE `de2bf54`. Per-commit `--stat` sums to 1152 + 304 = **1456 insertions**,
exactly the review package's stat. Diff matches the working tree. Tree clean except the two
untracked SDD ledger files.

**Dry run** — `node --env-file=.env scripts/scheduled-ingest.js --dry-run`:

```
DRYRUN_EXIT_CODE=0
```

Zero stderr. Count-header (`select('id', { count: 'exact', head: true })`) snapshot of six tables
immediately before and immediately after:

```
BEFORE {"ingestion_runs":401,"votes":9981,"vote_casts":1465333,"bills":38266,"sessions":33,"legislators":1607}
AFTER  {"ingestion_runs":401,"votes":9981,"vote_casts":1465333,"bills":38266,"sessions":33,"legislators":1607}
```

**Zero writes, byte-identical.** Lock file absent at rest both before and after (released
correctly). Chose `us-congress`, would run `src/cli/ingest.js --source us-congress --year 2026
--rolls 284-293`. The documented `--dry-run --only legiscan` variant also exits 0 with zero
writes.

**No model reachable from the scheduler's import graph** — walked the full transitive ESM graph of
`scripts/scheduled-ingest.js`: **10 files**, all of them `db.js` / `errors.js` / `http.js` /
`rate-limiter.js` / the two MO adapters / `mo-senate-journal-pdf.js` / `pdf-text.js` /
`ingest-mo-senate.js`. Zero model-adjacent modules (no `summarizer`, no `verifier`, no `gloss`),
zero `@anthropic-ai/*` imports at any depth. The header comment's guarantee is **mechanically
true**, not aspirational.

**MO ToU intervals cannot be shortened by any code path** — repo-wide grep: `MO_SENATE_MIN_INTERVAL_MS`
and `MO_HOUSE_MIN_INTERVAL_MS` are bare `export const … = 30 * 60 * 1000` literals
(`src/adapters/mo-senate-web.js:9`, `src/adapters/mo-house-xml.js:11`) with **no `process.env` read
anywhere in the repo**. `process.env[...]` appears exactly **once** in the entire scheduler graph
(`scripts/scheduled-ingest.js:82`, inside `envIntervalMs`), and `envIntervalMs` is called for only
the two non-ToU intervals, each `Math.max`-floored at the brief's minimum. No env var, no flag, no
config can shorten a published MO cadence. ✅

**LegiScan gate not reimplemented** — `dataset_hash` / `getDataset` appear in
`scripts/scheduled-ingest.js` only inside **comments** (lines 94, 362). The registry entry supplies
`--session <id>` and nothing else; the suspension-level gate stays entirely inside
`ingest-legiscan.js`. ✅

**mo-house-xml cannot receive a historical session** — `cliArgs` is a frozen literal
`['--limit','1']` (`scheduled-ingest.js:341`) with no interpolation; the CLI falls through to its
own `DEFAULT_MO_HOUSE_SESSION = '261'`. Structurally asserted by a test, not just commented. ✅

**`schtasks` not run** — `schtasks /query` finds no `VisibleGov` task. Draft-then-apply honored. ✅

**gloss.js / extract-terms.js / golden.js untouched** — `git diff --name-only de2bf54..3e12a1e` on
those three paths returns 0 files. The brief's "do not refactor the existing ones" holds. ✅

**Project law (1000-row cap)** — the only multi-row read in the new code is
`resolveUsCongressRollWindow`, correctly routed through `selectAll` (`scheduled-ingest.js:293`).
The other two DB helpers are single-row (`.limit(1).maybeSingle()` / unique-key `.maybeSingle()`).
See question B for the empirical check. ✅

---

## Answers to the three open review questions

### A. LegiScan session resolution — deterministic and NULL-proof? **YES, provably.**

Live state (read-only probe of the `sessions` table, `jurisdiction_id = 'mo-legislature'`, 33 rows
total) — the two 2026-named rows are:

| id | identifier | name | legiscan_session_id |
|---|---|---|---|
| `4f…` | **`2026`** | `2026 Regular Session (MO Senate journals)` | **NULL** |
| `bf3c7f23-358d-4399-8279-3a8e60a96eda` | **`261`** | `2026 2nd Regular, 103rd General Assembly` | **2239** |

The resolver (`scripts/scheduled-ingest.js:266-275`) filters on
`.eq('jurisdiction_id','mo-legislature').eq('identifier', DEFAULT_MO_HOUSE_SESSION)` where
`DEFAULT_MO_HOUSE_SESSION = '261'` (`src/adapters/mo-house-xml.js:22`). It **never** orders,
**never** takes "most recent", and **never** falls back.

Three independent reasons it cannot pick the NULL row or flip:

1. **The predicate excludes it.** The NULL row's `identifier` is `'2026'`, not `'261'`. The
   equality filter can never match it.
2. **The schema forbids ambiguity.** `supabase/migrations/0001_core_schema.sql:16` declares
   `unique (jurisdiction_id, identifier)` on `sessions`. The two-column filter therefore matches
   **at most one row, ever** — `.maybeSingle()` cannot hit PostgREST's multiple-rows error, and
   there is no set of rows for it to "flip" between. This is a database-level guarantee, not a
   convention.
3. **NULL is handled explicitly anyway.** Line 274 returns `null` unless
   `legiscan_session_id != null`, and `buildRegistry` turns that into `resolvable: false` +
   an honest `unresolvedReason`, which `pickMostOverdue` filters out (`:200`). Even if the NULL row
   were somehow selected, the outcome would be an honest skip, not a wrong session id.

Replayed the exact query against live data: returns `{"legiscan_session_id":2239}`. Deterministic.

**Caveat (Important, not a defect in the resolver):** the *error* path is not as isolated as the
docs claim — see finding I3.

### B. us-congress forward window — reviewed hardest, as instructed.

**Is the max-roll read subject to the 1000-row cap? NO — correctly avoided.**
`resolveUsCongressRollWindow` (`scheduled-ingest.js:289-302`) goes through `selectAll`, which pages
at 1000 with a `maxPages` guard that throws rather than return a truncated result
(`src/lib/db.js:85-105`). Verified empirically: the filtered set is **283 rows** today
(`votes` is 9,981 rows overall, so a bare `.select()` here would have been a live landmine); the
paginator returned all 283 and the parsed roll count matched exactly (283/283, no drops). A bare
`.select()` would happen to work today and silently break around November of a busy session year —
it was not used. ✅

**Is it bounded? YES.** `computeRollWindow` is `max+1 .. max+windowSize`, `windowSize = 10`, and
`parseRollRange` (`src/cli/ingest.js:8-14`) materializes exactly that many integers. Live window:
`{lo: 284, hi: 293}`. Worst case per tick = 1 member-list call + 10 clerk.house.gov roll fetches +
≤10 bill-detail calls, all on existing limiters (`clerkLimiter` 1 req/s, `congressLimiter`
1 req/3.6s). Bounded. ✅

**Is it idempotent? YES.** `votes.source_key` is the conflict key and persistence is
`insertIfAbsent`, so re-probing an already-ingested roll is a genuine no-op. The window is derived
fresh from the DB each tick, so it is self-correcting rather than stateful. ✅

**Is it 404-tolerant? YES, structurally.** `ingest.js:67-70` catches `SourceFetchError` per roll
and pushes to `failures[]` — "skip != empty: recorded, not silent". `fetchWithLimit`
(`src/lib/http.js:30-32`) types any non-ok status as `SourceFetchError`, so a 404 on an unpublished
roll lands in that catch. ✅ **But see I4** — that tolerance has a cost the implementer did not
trace.

**Is it on the polite limiter? YES.** `fetchHouseRollCall` defaults to `clerkLimiter`
(1000 ms) and `fetchBillDetail`/`fetchMemberList` to `congressLimiter` (3600 ms), both
pre-existing (`src/adapters/us-congress.js:7-8`). The scheduler adds no new fetch path. ✅

**Is the interval floored ≥1h? YES.**
`envIntervalMs('US_CONGRESS_MIN_INTERVAL_MS', ONE_HOUR_MS, ONE_HOUR_MS)` — default *and* floor are
both 1h, so an env override can only raise it. Non-numeric/zero/negative falls back to the default,
then `Math.max`. ✅

**Gap-stall risk: real but currently nil.** The window only advances if some roll in
`max+1..max+10` exists, so a contiguous missing run of >10 rolls would stall it permanently.
Checked live: rolls 1–283 for 2026 are **contiguous, largest interior gap = 0**. Not a present
concern; worth knowing it is the failure mode if it ever stops advancing.

**Verdict on B: the inference is sound and the implementation is correct.** The two things the
implementer did *not* trace are I4 (the 404 tolerance makes `partial`/exit-2 the permanent healthy
state, poisoning the log and forcing an hourly aggregate refresh) and I5 (the Senate half of
"federal votes" is still unscheduled). Neither invalidates the window design.

### C. Docs honesty — **FAILED. The overclaim is present and is factually false.**

`docs/SCHEDULED_INGESTION.md:151-155`:

> Separately, **TODO.md item 25** documents a real, currently-open duplicate-MO-session defect
> (session `'2026'` vs `'261'`) caused by a *different*, **non-scheduler source** (not
> `mo-house-xml`, whose default session — `261` — is already the correct one). **This scheduler's
> registry does not touch whatever is producing that duplicate**; it's flagged here only so it
> isn't mistaken for something this script caused.

Both bolded claims are false, and I re-proved it end to end rather than taking the controller's
word:

1. `src/cli/ingest-mo-senate.js:470-474` — `ensureSessionRow(client, runId, year)` does
   `insertIfAbsent(client, 'sessions', [{ jurisdiction_id: 'mo-legislature', identifier:
   String(year), name: \`${year} Regular Session (MO Senate journals)\` }], …)` — with **no
   `legiscan_session_id`**.
2. Live DB: the NULL row is `identifier '2026'`, `name "2026 Regular Session (MO Senate
   journals)"` — byte-for-byte the string that line 473 constructs. There is no other producer.
3. `runMoSenate` calls `ensureSessionRow` on every invocation
   (`ingest-mo-senate.js:1042` region), and the scheduler's **first registry entry**
   (`scheduled-ingest.js:320-328`) runs exactly `src/cli/ingest-mo-senate.js --year 2026 --limit 1`.

So `mo-senate-web` **is** in the registry, **is** the feeder, and registering this scheduler
**continues** feeding the split every 30 minutes until TODO 25's merge lands. TODO.md:261 already
says as much in its own words: *"it grew 15→16 bills during the audit: the cron is feeding the
duplicate."*

The honest framing is **neutral-vs-today**: the scheduler does the same thing the manual bash loop
already did — it neither creates nor worsens the defect relative to current practice — but it is
absolutely not unrelated to it, and it will keep it alive on a durable, unattended cadence rather
than a session-lifetime one.

**Clean by comparison** (no change needed): `scripts/scheduled-ingest.js:258-265`
(`resolveLegiscanSessionId`'s own comment) and `:359-360` (the `unresolvedReason` string) both
mention TODO 25 **without** claiming the scheduler is unrelated to it. Only the doc overclaims.

---

## Findings

### 🔴 Critical

**C1 — A source whose CLI fails before `openRun` is re-picked on every 15-minute tick forever,
permanently starving every other source.**
`scripts/scheduled-ingest.js:199-203` (`pickMostOverdue`), `:186-192` (`computeSourceDueness`);
root cause `src/cli/ingest.js:536` vs `:556`.

The scheduler's only due-ness clock is `ingestion_runs.started_at`, written by the *child*. It
records no attempt of its own. Three of the four registry CLIs call `openRun` **before** any
network work — `ingest-mo-senate.js:1041-1042` (`enforceDurableCooldown` then `openRun`),
`ingest-mo-house.js:940`, `ingest-legiscan.js:1064`. **`ingest.js` is the exception**: it runs the
entire `collect()` (member-list fetch + up to 10 roll fetches + bill details) at line 536 and only
calls `openRun` at line 556. And `collectUsCongress`'s very first statement,
`await us.fetchMemberList('MO')` (`ingest.js:46`), is **outside** the per-roll try/catch and is
fatal by design ("throws on failure: fatal, nothing to reconcile").

So any persistent congress.gov condition — expired/rotated `CONGRESS_API_KEY` (403), an API
outage (5xx), a 429, a network blip — throws before line 556, **no `ingestion_runs` row is ever
written**, and `lastStartedAtIso` for `us-congress` stays frozen. Consequences, all silent:

- `us-congress`'s `elapsedMs` keeps growing and can never be overtaken, because every other
  source's `elapsedMs` grows at the same rate from a lower start. `pickMostOverdue` returns
  `us-congress` on **every tick, forever**.
- `mo-senate-web`, `mo-house-xml` and `legiscan` **never run again**. Freshness — the entire point
  of this build — silently dies while the log keeps saying `mode: "live"`.
- congress.gov/clerk.house.gov get hit **every 15 minutes** instead of the 1-hour interval this
  script declares for itself — a 4× overrun of its own stated conservative cadence, up to ~11
  requests per tick, indefinitely.
- The scheduler still exits **0** every tick (the child's failure is "logged and reported, never
  crashes the scheduler"), so Task Scheduler's history shows a healthy green task the whole time.

**This is live on day one, not hypothetical.** `us-congress` currently sits at
`started_at = 2026-07-28T04:40Z` (n=3 runs) — ~91 hours overdue — and the dry run confirms it is
the source chosen on the very first tick. If that first live run fails at `fetchMemberList`, the
scheduler is wedged from the moment it is registered, and the only symptom is a log file nobody is
watching.

Shape of a fix (not applied, per instructions): give the scheduler its own attempt record —
persist the tick's chosen source + timestamp (the lock file or a small sidecar is enough) and rank
on `max(child started_at, own last attempt)`, so a failing source backs off at its own interval
instead of monopolizing the picker. A per-source consecutive-failure backoff would also work.

**C2 — `docs/SCHEDULED_INGESTION.md:151-155` states, twice, something the controller already
disproved.** Full proof under question C above. This is a direct violation of the brief's docs
deliverable and of `CLAUDE.md`'s "everything traceable… no editorializing" standard. The fix is a
wording change to neutral-vs-today, not a code change. Because this doc is what Lance reads before
deciding to register a forever-task on his own machine, a false "not us" claim in it is a shipping
gate, not a nit.

### 🟠 Important

**I1 — `releaseLock()` is ownership-blind, so one slow run can unlock a *different* run's lock and
un-do the single-instance guarantee.**
`scripts/scheduled-ingest.js:176-178`, called from the `finally` at `:536-540`.

`releaseLock` does `if (existsSync(lockPath)) unlinkSync(lockPath)` — it never checks whether the
lock it is deleting is still *its own*. Sequence: tick A takes the lock at T and its child hangs.
At T+10min tick B finds the lock stale, reclaims it (overwriting with B's pid) and starts its own
child. At T+12min tick A finally returns and its `finally` deletes **B's** lock. Tick C at T+15min
finds no lock, takes a fresh one, and starts a **third** concurrent child. The "INCAPABLE OF
STACKING OVERLAPPING PROCESSES" guarantee in the header comment (`:19-23`) degrades to unbounded
stacking the moment any single run exceeds `MAX_RUN_DURATION_MS`.

A >10-minute run is not exotic: `ingest-legiscan.js` on a *changed* `dataset_hash` downloads and
processes a full LegiScan MO dataset against a 38,266-bill table, and LegiScan refreshes weekly.
Mitigating factor that keeps this out of Critical: the **published ToU is still protected** by each
MO CLI's own `enforceDurableCooldown`, which re-reads `ingestion_runs` and sleeps — so overlapping
children cannot violate house.mo.gov/senate.mo.gov. What breaks is the scheduler's own stacking
guarantee and the doc's claim about it. Fix shape: compare pid + `startedAt` against the payload
this process wrote before unlinking.

**I2 — No timeout anywhere on the child, which is what makes I1 reachable.**
`scripts/scheduled-ingest.js:373-375` (`defaultSpawn`), `:384-395` (`runChildCli`);
`src/lib/http.js:18-36`.

`spawnSync` is called with no `timeout` option, and `fetchWithLimit` passes no `AbortSignal` to
`fetch` (Node's `fetch` has no default response timeout). A single stalled TCP connection inside
any child hangs the scheduler indefinitely, holding the lock, which is precisely the precondition
for I1. For a process that runs unattended forever, an explicit `timeout: MAX_RUN_DURATION_MS` on
`spawnSync` — so the scheduler kills its own child at exactly the threshold at which it declares
that child dead — would close both this and I1's window.

**I3 — "it does not block the other three sources" is only true for the `null` path; a *thrown*
lookup aborts the entire tick.**
`docs/SCHEDULED_INGESTION.md:149`; `scripts/scheduled-ingest.js:310-317`.

`buildRegistry` runs all six lookups in a single `Promise.all`. `resolveLegiscanSessionId` throws
on any Supabase error (`:273`), as do `queryLatestStartedAt` (`:254`) and
`resolveUsCongressRollWindow` (`:296`). One rejection rejects the whole `Promise.all`, propagates
out of `main()`, and exits 1 — **no source runs at all that tick**. The doc's reassurance holds
only for the "row absent / column null" case it was written about. Either wrap each lookup so a
per-source failure degrades to `resolvable: false`, or correct the sentence.

**I4 — `partial` + child exit 2 is the permanent *healthy* state for `us-congress`, which poisons
the log and forces an hourly aggregate refresh.**
`scripts/scheduled-ingest.js:239-242` (`runWroteSomething`); `src/cli/ingest.js:69, 560, 568`.

The 10-roll probe window is designed to overshoot, so on a typical tick most of the window 404s.
Each 404 is recorded in `failures[]` (`ingest.js:69`), which makes `status = 'partial'`
(`:560`) and sets `process.exitCode = 2` (`:568`). Two consequences neither the code nor the docs
acknowledge:

- Every hourly `us-congress` entry will read `exitStatus: 2, status: "partial", failures: [ … ]`
  **forever, even when everything is perfect**. The one artifact Lance is told to read to know the
  scheduler is alive will train him to ignore exactly the fields that would signal a real failure.
- `runWroteSomething` returns `true` for `'partial'`, so `scripts/refresh-aggregates.js` is spawned
  on **every** `us-congress` tick — hourly, indefinitely, whether or not a single new vote arrived.
  The ledger's over-refresh proxy was reviewed as an occasional over-run; in practice it is
  unconditional-hourly. (Cheap and idempotent, so this is a cost/noise issue, not a correctness
  one — but it is not what the comment at `:229-238` describes.)

**I5 — Senate roll calls remain unscheduled; only the House half of "federal votes" is solved.**
`scripts/scheduled-ingest.js:107` (`SOURCE_KEYS`); `docs/SCHEDULED_INGESTION.md:213`.

`ingest.js` has a **separate** `us-senate` source with its own branch (`:531-533`), its own
`openRun(client, 'us-senate')` (`:506`), 4 prior runs and **869 `us-senate-*` vote rows** live.
`collectUsCongress` fetches House rolls only. The registry has no `us-senate` entry, so new Senate
roll calls still never arrive. The doc's phrasing — *"the one federal stream that had no scheduled
ingestion before this"* — is true of the House but reads, in a doc whose whole subject is freshness,
as if federal votes are now covered. The brief did name only `us-congress`, so this is arguably
in-scope-as-written; flagging it because the gap is invisible from the doc and Lance is the one who
will be surprised by it.

### 🟡 Minor

**M1 — Log files are dated by UTC while the doc tells Lance to open "today's file."**
`scripts/scheduled-ingest.js:410` (`entry.timestamp.slice(0, 10)` on an ISO-Z string);
`docs/SCHEDULED_INGESTION.md:256-260`. Observed live: a run at **19:11 local on 2026-07-31** wrote
`.superpowers/artifacts/scheduler-logs/**2026-08-01**.log`. Every evening after 7pm Central,
"today's log" is tomorrow's filename, and the "is the last entry more than ~20 minutes old" check
sends you to an empty or nonexistent file. Local-date naming, or a note in the doc, would fix it.

**M2 — `spawnSync` runs with Node's default 1 MB `maxBuffer`, and overflow is reported as a
misleading "could not launch".** `scripts/scheduled-ingest.js:373-375, 386-390`. On overflow
`spawnSync` **kills the child** and sets `result.error` (ENOBUFS) — which `runChildCli` turns into
`could not launch ${scriptPath}`, a message that points at a bad path when the real cause is a
chatty child that was terminated mid-run. Low likelihood at `--limit 1` (the CLIs have 2–11
`console.error` sites), but the failure mode is silent truncation plus a wrong diagnosis, on the
one process nobody is watching. An explicit `maxBuffer` and a distinct ENOBUFS message would cost
two lines.

**M3 — `buildRegistry` unconditionally performs all six lookups, including a paginated `selectAll`,
even for `--only <other-source>` and `--dry-run`.** `scripts/scheduled-ingest.js:310-317`. The
283-row `votes` scan and the `sessions` lookup run every 15 minutes forever regardless of which
source is scoped. Small today, purely wasted, and grows with the vote table. Making the two
resolvers lazy (only for the entry actually under consideration) would also shrink I3's blast
radius.

**M4 — `summarize.js` / `verify.js` print no cost estimate before blocking, unlike `gloss.js`.**
`src/cli/gloss.js:228-229` prints `Cost estimate: N term(s) x ~$X = ~$Y` *before* its gate, so even
a blocked run tells Lance the scale of what he is approving. The new gates
(`src/cli/summarize.js:299-308`, `src/cli/verify.js:173-182`) print only the BLOCKED line.
`CLAUDE.md`'s policy is worded as "explicit per-run approval, **with call count + dollar estimate
stated up front**". The brief asked only for the guard-clause shape, so this is brief-compliant —
noting it because the policy it implements asks for slightly more, and both files already know
their candidate count at that point (`plan.needSummary.length` / `unverified.length`).

**M5 — observation only, no change requested.** `scheduled-ingest.js:543`'s `invokedDirectly`
basename-suffix heuristic is a substring test rather than a URL identity comparison, but it is
copied verbatim from every existing CLI in this repo (`ingest.js:571`, `ingest-legiscan.js:1106`,
…). Consistency with the codebase is the right call here; changing it in one file would be worse.
Verified it behaves correctly under `node --test` (argv[1] is the test file, so `main()` does not
fire on import) and under a real spawn.

---

## What is genuinely good (so the fixes don't regress it)

- **Due-ness is computed, never guessed.** `remainingCooldownMs` is imported
  (`scheduled-ingest.js:51`) and used unmodified (`:187`); the arithmetic is nowhere duplicated.
  The `elapsedMs` / `remainingMs` split is the right call — `Math.max(0, …)` clamps every due
  source to 0, so `remainingMs` alone genuinely cannot rank two due sources, and the comment at
  `:182-185` says exactly that.
- **`acquireLock`'s `'wx'` atomic create** (`:154`) closes the check-then-act race properly, and
  treating a corrupt lock as stale (`:160-165`) is the right failure direction — a half-written
  lock from a killed process can't wedge every future tick.
- **The three suspension-level / data-integrity rules all hold mechanically**, not by comment:
  no model in the import graph, no env path to a MO cadence, no `dataset_hash` logic outside
  `ingest-legiscan.js`, no `--session` reachable by `mo-house-xml`.
- **Test quality is high.** 50 new tests, `spawnFn` injected so nothing hits the network or the DB,
  a real-subprocess smoke test using a throwaway `.env` in a temp dir (so it survives a fresh
  checkout where `.env` is gitignored), and the TODO-31 restriction asserted structurally rather
  than trusted to a comment. The `fakeRegistryClient` closure comment at
  `tests/scheduled-ingest.test.js:1511-1513` documents a real trap it hit.
- **Task 1's shared `assertRunApproved`** is a small, defensible deviation from "mirror the shape":
  it preserves the exact `!== 'yes'` strictness, keeps gloss.js's message voice, adds a typed
  `RunNotApprovedError` in the file's existing convention, catches locally so the CLI prints one
  clean line instead of a stack trace, and — importantly — leaves the three pre-existing gates
  untouched, which is what the brief actually forbade changing. Tests assert each message names
  its own env var and no other CLI's.

---

## Required before this is registered with Task Scheduler

1. Fix **C1** — a failing child must not be able to monopolize the picker. This is the one that
   compounds silently for weeks, which is exactly the failure class this review was asked to catch.
2. Fix **C2** — correct `docs/SCHEDULED_INGESTION.md:151-155` to the neutral-vs-today framing.
3. Recommended in the same pass, cheap and closes a real hole: **I1** (ownership-checked release)
   + **I2** (`timeout` on `spawnSync`).

Task 1 (`41936f0`) can ship independently and immediately.
