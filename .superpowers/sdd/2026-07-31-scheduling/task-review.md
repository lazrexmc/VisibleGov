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


---

# Re-review (rounds 1+2)

Scope: fix commits `9a4eb66` (round 1: C1, C2, I1-I5, M1-M4) and `a6d94bc` (round 2: per-source
timeouts, lock-declared duration, orphan-close). Full stack under verdict: `41936f0..a6d94bc`.
Reviewer: session 8ecd5d8c. Date 2026-07-31.

## Mechanical re-verification

**Test suite** — bare `node --test` from `F:\VisibleGov`, re-run by the reviewer:

```
ℹ tests 2073
ℹ suites 0
ℹ pass 2073
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 22239.9298
```

Extracted fail-count line: **`ℹ fail 0`**. Corroborated by `grep -c "^not ok"` = **0**.
2073 tests, matching the claim (2025 + 32 round-1 + 16 round-2).

**Dry run** — `node --env-file=.env scripts/scheduled-ingest.js --dry-run`: **exit code 0**, zero
stderr, lock released at rest. Count-header on six tables immediately before and after this
invocation:

```
BEFORE {"ingestion_runs":403,"votes":9988,"vote_casts":1465564,"bills":38273,"sessions":33,"legislators":1607}
AFTER  {"ingestion_runs":403,"votes":9988,"vote_casts":1465564,"bills":38273,"sessions":33,"legislators":1607}
```

Byte-identical — **zero writes**. (Absolute numbers moved since the first review because Lance's
existing manual loop is still running; the before/after pair bracketing *this* invocation is what
is being asserted.) `--dry-run --only us-senate` also exits 0 with zero writes.

**Commits** — `git log` confirms `a6d94bc` on `9a4eb66` on `3e12a1e` on `41936f0` on `de2bf54`.
Per-commit `--stat` matches the re-review package. Shared-blast-radius ruling honored: `git diff
3e12a1e..a6d94bc` on `src/lib/http.js`, `src/lib/db.js`, `src/adapters/`, `src/cli/ingest.js`,
`src/cli/ingest-mo-senate.js` returns **zero changes** — the timeout work stayed inside the
scheduler via its own `getSchedulerClient` (`scripts/scheduled-ingest.js:873-878`).

## (a) Per-finding verification

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| **C1** | Starvation via missing run row | ✅ **FIXED** | `recordSchedulerAttemptFailure` (`:688-699`) writes a real `ingestion_runs` row via the shared `openRun`/`closeRun`, `status='failed'`, `detail.scheduler_attempt=true` — never a fake success. `runChosenSource` (`:757-832`) catches launch/timeout/buffer errors rather than letting them propagate, so the "did a new row appear" check is never skipped. Because `queryLatestStartedAt` has no status filter, the row advances the durable signal and the source falls back to its own interval instead of winning every 15-min tick. |
| **C2** | Doc claimed scheduler unrelated to TODO-25 | ✅ **FIXED** | `docs/SCHEDULED_INGESTION.md:247-268` is now a warning-headed section: *"⚠️ This scheduler CONTINUES feeding a known, currently-open data defect (TODO item 25) — read before registering"*, *"**The feeder is `mo-senate-web`, which IS in this registry.**"*, cites `ensureSessionRow`'s `identifier: String(year)` mechanism, quotes TODO.md's own "the cron is feeding the duplicate", and closes with *"The honest framing is neutral-vs-today, not 'unrelated.'"* No residual overclaim anywhere in the file. |
| **I1** | Ownership-blind `releaseLock` | ✅ **FIXED** | `acquireLock` mints a `crypto.randomUUID()` nonce into the lock payload (`:232-235`); `releaseLock` (`:274-284`) re-reads and deletes **only** on nonce match; missing/corrupt/non-matching are all silent no-ops. `main()`'s `finally` threads `lockResult.nonce` (`:1017`). |
| **I2** | No child/fetch timeout | ✅ **FIXED** | `spawnSync` now gets `timeout: timeoutMs` (`:639-641`), per-source. The scheduler's own Supabase client applies `AbortSignal.timeout(30s)` to every REST call (`:861-878`). Shared `http.js`/`db.js` deliberately untouched, per the ruling — verified zero diff. |
| **I3** | One lookup rejection killed the tick | ✅ **FIXED** | `safeLookup` (`:501-508`) converts a rejection into `{ok:false, error}`; all eight lookups are wrapped, so the `Promise.all` (`:529-538`) can no longer reject. Each entry's own `resolvable` / `unresolvedReason` now reflects only *its* lookup (`:543-616`), so one source's failure genuinely no longer blocks the others — which is what the doc always claimed. |
| **I4** | Tail-404 noise + unconditional refresh | ✅ **FIXED (mechanism)** — but see **NEW-1** | I4a: `isExpectedTailProbeOutcome` (`:368-376`) requires *every* failure to match `roll N`/`vote N` strictly past `windowMaxKnown`, so a genuine regression can't be laundered as "expected". I4b: `countsShowRowsWritten` (`:389-397`) reads the child's own run row instead of mode/status. Correct for mo-senate-web, mo-house-xml (**both** branches), us-congress, us-senate — **broken for legiscan** (NEW-1). |
| **I5** | us-senate unscheduled | ✅ **FIXED** | Registry entry `:586-598` + `resolveUsSenateVoteWindow` `:480-493`. Verified end to end live: `--dry-run --only us-senate` emits `--source us-senate --session 2 --votes 211-220`, which is exactly right (210 rows on file under `us-senate-119-2-*`; 659 under session 1). `US_SENATE_SESSION = 2` is correct for 2026. `collectUsSenate` honors `--votes` (`ingest.js:503-505`), so the run stays bounded to 10. |
| **M1** | UTC log naming | ✅ **FIXED** | Code comments at `:76-78` and `:847`; doc `:199-205` spells out *"The date in the filename is UTC, not local time — Central time is 5-6 hours behind UTC…"* and tells Lance to check both today's-UTC and tomorrow's-UTC files. |
| **M2** | 1 MB maxBuffer misreported | ✅ **FIXED** | `CHILD_MAX_BUFFER = 16 MB` (`:121`) passed to `spawnSync` (`:640`); ENOBUFS now throws its own distinct, accurate message (`:657-662`) instead of "could not launch". |
| **M3** | Lookups ran regardless of `--only` | ✅ **FIXED** | `only` threaded into `buildRegistry` (`:523-524`) and gated per lookup by `safeLookup(need(key), …)` (`:530-537`); a skipped lookup returns `{ok:true, value:null}` and the entry's `cliArgs` correctly collapses to `[]` rather than dereferencing null (`:576-582`). |
| **M4** | No cost estimate before the gate | ✅ **FIXED** | `summarize.js:298-301` and `verify.js:173-176` print a `Cost estimate: N × ~$0.11 = ~$X` line in gloss.js's voice, before the gate and after the `--dry-run` return — so gate ordering is unchanged. The $0.11 figure is reused from golden.js's existing estimate for the identical `summarizeBill` call rather than invented. |

## (b) Round-2 mechanism — verified at runtime, not by reading

Executed the real exported `isLockStale` against constructed locks (no DB, no network):

```
legiscan declared lock duration = 4560000 ms = 76 min   (LEGISCAN_CHILD_TIMEOUT_MS 75min + LOCK_GRACE_MS 1min)
default  declared lock duration =  540000 ms =  9 min   (CHILD_TIMEOUT_MS 8min + LOCK_GRACE_MS 1min)

  legiscan lock @ +15min -> stale=false     legiscan lock @ +75min -> stale=false
  legiscan lock @ +30min -> stale=false     legiscan lock @ +76min -> stale=false
  legiscan lock @ +45min -> stale=false     legiscan lock @ +77min -> stale=true
  legiscan lock @ +60min -> stale=false     legiscan lock @ +90min -> stale=true

  default(9min) lock @ +9min  -> stale=false
  default(9min) lock @ +10min -> stale=true
```

**A +15-minute tick cannot reclaim a live legiscan lock.** ✅ Confirmed — and the window still
closes at +77 min, so a genuinely dead legiscan run cannot wedge the schedule indefinitely. The
default 9-minute declaration still reclaims promptly at +10 min, so raising legiscan's budget did
not loosen anything for the other four sources.

**Corrupt/missing `maxDurationMs` falls back to the 10-minute default.** ✅ Confirmed across every
malformed shape:

```
  missing field / null / 'abc' / 0 / negative / NaN / Infinity
      -> @ +9min stale=false, @ +11min stale=true   (i.e. MAX_RUN_DURATION_MS = 10 min)
  unparseable startedAt -> stale=true always
```

`Number.isFinite(declared) && declared > 0` (`:208-209`) rejects all of them into
`fallbackMaxDurationMs`, and a lock file that fails `JSON.parse` outright is synthesized with an
epoch `startedAt` (`:250-252`) so it is always stale. Fail-safe direction throughout. (One gap:
NEW-2 below.)

**The orphan-close touches only rows this tick could have created.** ✅ Confirmed.
`closeOrphanedRunningRows` (`:721-732`) filters on all three of `source = chosen.key`,
`status = 'running'`, and `started_at >= sinceIso`, where `sinceIso` is `nowIsoAtTickStart` —
captured once at `:888`, *before* `acquireLock`, and threaded through `runChosenSource`'s
`tickStartIso`. A `'running'` row from any earlier tick has `started_at < tickStart` and is
excluded; there is no code path that widens or omits that predicate. It is additionally called only
when `killedByScheduler` is true (`:782`), i.e. only for ETIMEDOUT/ENOBUFS. Pre-existing history is
untouchable. (Secondary caveat: NEW-4 below.)

## (c) New defects introduced by the fixes

### 🔴 NEW-1 (Critical) — `countsShowRowsWritten` can never return true for `legiscan`, so the aggregate refresh will never fire after a LegiScan dataset lands

`scripts/scheduled-ingest.js:389-397` — the fallthrough at `:396` is
`return (counts.votes ?? 0) > 0;`, reading `detail.counts` (`:390`).
`src/cli/ingest-legiscan.js:1085` closes its run with `buildSuccessCloseDetail(result.counts)`,
and that helper (`:961-963`) is:

```js
export function buildSuccessCloseDetail(counts) {
  return { ...counts, attribution: ATTRIBUTION, queries_used: counts.queriesUsed };
}
```

It **spreads `counts` at the top level of `detail`** — there is no `detail.counts` object at all —
and the counts it spreads are the document/text-pipeline counters, which contain no vote counter.
Measured against all 52 real legiscan runs in `ingestion_runs`:

```
legiscan runs total: 52
UNION of all legiscan detail.counts keys:
   alreadyHasVersion, alreadyPresent, billsPlanned, budgetRefused, cacheCorrupt, datasetsMissing,
   datasetsRead, decodeFailed, docCacheHits, extractEmpty, identityMismatch, inserted,
   missingSourceUrl, nonPdfMime, oversizeRefused, queriesSpent, statusError
votes-like keys present?: NONE
distinct counts shapes: (50 runs) (no detail.counts)   (2 runs) <the 17 keys above>
>>> runs where countsShowRowsWritten('legiscan', detail) === true : 0 / 52
```

So it is **0 for 52**, and structurally incapable of ever being anything else. Meanwhile LegiScan
is by a wide margin the largest vote writer in this database — it calls
`insertIfAbsent(client, 'votes', …)` at `ingest-legiscan.js:604` and
`insertIfAbsent(client, 'vote_casts', …)` at `:617`, and live:

```
votes table: 8221 of 9988 rows have a legiscan* source_key (82.3%)
```

**Consequence:** when the weekly dataset hash changes and a real reprocessing lands thousands of
new casts, `run.outcome.wroteRows` is `false`, `refresh-aggregates.js` is skipped
(`scheduled-ingest.js:982`), and `public_position_totals` / `public_party_alignment` silently drift
behind the vote lists — the exact user-visible chart-drift defect of 2026-07-31 that the brief
names as the entire reason the standing practice exists. The log will read
`healthy: true, aggregatesRefreshed: false`, so nothing signals it.

**This is a regression, not a pre-existing gap.** The pre-round-1 `runWroteSomething` returned
`true` for `{mode:'live', status:'succeeded'}`, so the refresh *did* fire after legiscan runs
before this fix. I4b's tightening is correct in principle and correct for four of five sources; it
silently disabled the refresh for the one that matters most.

The comment at `:378-388` states the mapping was *"verified against each one's real closeRun()
call site, not guessed."* For legiscan that is not accurate — 50 of 52 runs have no
`detail.counts` at all. Worth correcting alongside the code so the next reader doesn't trust it.

(Note for whoever fixes it: legiscan's counts do carry `inserted`, but that counts documents/texts,
not votes or casts. There may be no honest votes-written counter in that CLI's detail today —
picking the right signal is a design call, not a one-token swap.)

### 🟡 NEW-2 (Minor) — no upper clamp on the lock's declared `maxDurationMs`

`scripts/scheduled-ingest.js:205-211`. The guard is `Number.isFinite(declared) && declared > 0`,
which rejects garbage in the *low* direction but honors any finite positive value. Verified:

```
  absurdly large (1e12)  @ +9min stale=false  @ +11min stale=false
```

A lock declaring ~31 years would never be reclaimed, permanently wedging every future tick into
`already-running` + exit 0 — silent, and indistinguishable from a healthy quiet period in Task
Scheduler's history. Only reachable by hand-editing the lock (the doc does tell Lance he may delete
it by hand) or an exotic corruption that still parses as valid JSON. Clamping at, say,
`LEGISCAN_CHILD_TIMEOUT_MS + LOCK_GRACE_MS` would close it in one line.

### 🟡 NEW-3 (Minor) — `updateLockMaxDuration`'s failure return is ignored

`scripts/scheduled-ingest.js:973` calls it purely for effect. It returns `false` when the lock is
missing, corrupt, or no longer nonce-matched (`:295-306`). In that case `main()` still spawns the
child — and for legiscan that means a 75-minute run proceeding under a lock that still declares the
10-minute selection-phase placeholder, which re-opens precisely the +15-min stale-reclaim stacking
window round 2 exists to close. Low probability (requires losing the lock between acquire and
selection) and it fails open rather than dangerously, but the one call site that makes round 2 work
is also the one whose result is discarded.

### 🟡 NEW-4 (Minor) — the orphan-close scope compares a local clock against DB-assigned timestamps

`scripts/scheduled-ingest.js:888` builds `nowIsoAtTickStart` from `Date.now()` (the local machine
clock), and it is compared via `.gte('started_at', sinceIso)` (`:723`) against `ingestion_runs.
started_at`, which is **not** client-supplied: `openRun` (`src/lib/db.js:20-28`) inserts only
`{source, status}`, so `started_at` comes from the column default `now()`
(`supabase/migrations/0001_core_schema.sql:117`) — the Supabase server clock.

The child reaches its own `openRun` within a second or two of tick start (legiscan's is at
`ingest-legiscan.js:1064`, right after the client check), so if the local clock runs even a couple
of seconds *ahead* of Supabase's, the child's row lands with `started_at < sinceIso` and the
`gte` filter matches nothing. The scoping requirement is still satisfied — this errs toward closing
*fewer* rows, never a wrong one — but the fix can silently no-op in exactly the rare, weekly
scenario it was written for, with no signal (`killClosedRunIds: []` reads the same as "nothing
needed closing"). A small negative tolerance on `sinceIso`, bounded well below one tick, would make
it robust without widening the scope meaningfully.

### 🟡 NEW-5 (Minor, observation) — a non-SIGTERM hard crash still strands a `'running'` row

`closeOrphanedRunningRows` runs only when `killedByScheduler` is true, which is gated to
`ETIMEDOUT`/`ENOBUFS` (`:769, :782`). A child killed by anything else — OOM-killer, segfault, power
loss mid-run — leaves the same stranded `'running'` row the round-2 fix exists to clean up. This is
a deliberate, documented scope (`:701-716`) and the *due-ness* signal is unaffected (the row exists,
so nothing starves); the residue is `public_freshness` honesty only. Noting for completeness, not
as a defect in the fix.

### Explicitly checked and clean

- **C1 double-recording.** `newRowAppeared` (`:795`) compares `latestRun.started_at !== chosen.
  lastStartedAtIso`. Both sides come from the same PostgREST client reading the same `timestamptz`
  column, so the string forms are directly comparable. If the child opened its own row, the
  timestamp differs and no attempt row is written; if `lastStartedAtIso` was `null` and a row
  appeared, `latestRun !== null` also short-circuits correctly. The self-record fires only when
  genuinely no new row exists. No double-recording path found.
- **C1 honest due-ness advance.** The self-recorded row is `status='failed'`, and
  `queryLatestStartedAt` intentionally has no status filter, so the next tick sees it and the
  source backs off to its own `minIntervalMs`. A persistently failing us-congress now runs hourly
  and never starves the others — verified by reading, and consistent with the live registry state.
- **I4b right-row selection.** `queryLatestRun` (`:417-427`) filters by source, orders
  `started_at` desc, `limit(1)` — after the child runs, that is the child's row, and the
  single-instance lock prevents a concurrent writer for the same source.
- **I4b correctness for the other four sources**, checked against live `ingestion_runs` detail
  rather than the code comment: `mo-senate-web` has `detail.counts.votes` ✅;
  `us-congress` `detail.counts.votes = 5` ✅; `us-senate` `detail.counts.votes = 210` ✅;
  `mo-house-xml` **both** branches ✅ — the `bill-xml` branch via `counts.bills_detailed`, and all
  11 real `rollcall-pdf` runs carry `detail.rollCallResult.castCount = 158` and evaluate `true`.
- **us-senate inherits C1's protection.** `collectUsSenate` fetches the vote menu fatally
  (`ingest.js:130`) before `openRun` (`:506`) — the same late-open shape as us-congress — and the
  self-record path is source-agnostic, so it is covered.
- **No new model reachability.** The import list gained only `node:crypto` and
  `@supabase/supabase-js`; still no summarizer/verifier/Anthropic anywhere in the graph.
- **MO ToU intervals** remain non-overridable constants; `process.env` is still read only inside
  `envIntervalMs`, now for three floored non-ToU intervals.
- **`dataset_hash`** still appears only in comments — the suspension-level gate is untouched.
- **`mo-house-xml` cliArgs** is still the frozen literal `['--limit','1']`.

## Verdicts

| | Verdict |
|---|---|
| Original findings C1, C2, I1, I2, I3, I4, I5, M1, M2, M3, M4 | ✅ **all 11 addressed in code** (I4's mechanism is sound but incomplete — NEW-1) |
| Round-2 mechanism (75-min lock vs +15-min tick, corrupt-field fallback, orphan-close scoping) | ✅ **internally sound**, verified at runtime |
| New defects introduced | ❌ **1 Critical** (NEW-1), 3 Minor, 1 observation |
| **Ship `41936f0..a6d94bc` as unattended-forever code** | ❌ **DO NOT SHIP** |

**Blocking, and it is the only blocker: NEW-1.** Everything else in this stack is genuinely fixed,
and the round-2 timeout/lock mechanism is the strongest part of the whole build — it is evidence-
derived, runtime-verifiable, and fails safe in every malformed case I could construct. But
registering the scheduler today means the single largest source of votes in this database
(82.3% of the table) lands its weekly batch and never triggers the aggregate refresh, silently
recreating the exact user-visible defect the brief cites as the reason for the standing practice.
That is precisely the compounds-quietly-for-weeks failure class this review exists to catch, and it
was introduced by the fix round rather than found in the original build.

Not blocking, worth folding into the same pass because they are each a line or two: NEW-2 (clamp
the declared lock duration), NEW-3 (act on `updateLockMaxDuration`'s `false`), NEW-4 (tolerance on
the orphan-close `sinceIso`).

**Task 1 (`41936f0` + M4's addition in `9a4eb66`) remains independently shippable and is
unaffected by all of the above.**


---

# Re-review (round 3)

Scope: commit `6cf47cf` (on `a6d94bc`) — NEW-1 through NEW-4. Full stack under final verdict:
`41936f0..6cf47cf` (5 commits). Reviewer: session 8ecd5d8c. Date 2026-07-31.

## Mechanical re-verification

**Test suite** — bare `node --test` from `F:\VisibleGov`, re-run by the reviewer:

```
ℹ tests 2089
ℹ suites 0
ℹ pass 2089
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 22288.4128
```

Extracted fail-count line: **`ℹ fail 0`**. Corroborated by `grep -c "^not ok"` = **0**. 2089 tests
(2073 + 16), matching the claim.

**Dry run** — exit code **0**, zero stderr, lock released at rest, count-header on six tables
byte-identical bracketing the invocation:

```
BEFORE {"ingestion_runs":404,"votes":9988,"vote_casts":1465564,"bills":38273,"sessions":33,"legislators":1607}
AFTER  {"ingestion_runs":404,"votes":9988,"vote_casts":1465564,"bills":38273,"sessions":33,"legislators":1607}
```

**Stack invariants re-checked after a 185-line change to the scheduler** — import graph still 10
files with zero model-adjacent modules and zero Anthropic imports; `dataset_hash` still appears
only in comments; `mo-house-xml` cliArgs still the frozen literal `['--limit','1']`;
`process.env` read only in `envIntervalMs` and `getSchedulerClient` (never for a MO cadence).
`countsShowRowsWritten` is fully removed from live code (surviving mentions are comments only).
Round 3 touched only `scripts/scheduled-ingest.js`, `tests/scheduled-ingest.test.js`, and ledger files.

## (a) Per-finding verification

### NEW-1 ✅ FIXED — and the implementer's deeper root cause is confirmed

The single key-dispatched `countsShowRowsWritten` is replaced by five per-registry-entry
predicates (`:414-484`), attached in `buildRegistry` and invoked as
`(chosen.wroteSomething ?? defaultWroteSomething)(detail, status)` at `:919`.

I ran the **real exported predicates against every real `ingestion_runs` row** (339 rows across
five sources), not against fixtures:

| Source | Real rows | Predicate tally | Shapes actually seen |
|---|---|---|---|
| `mo-senate-web` | 153 | 30 true / 123 false | 153/153 carry a numeric `counts.votes` |
| `mo-house-xml` | 127 | **127 true** / 0 false | 113 `bill-xml`, 11 `rollcall-pdf`, 3 with no `document_type` |
| `us-congress` | 3 | 3 true | 3/3 numeric `counts.votes` |
| `us-senate` | 4 | 4 true | 4/4 numeric `counts.votes` |
| `legiscan` | 52 | **37 true** / 15 false | 37 top-level `votes` (0–1359), 3 failure-shape, **2 texts-CLI shape** |

**The legiscan predicate returns true against the real top-level-votes shape.** ✅ Confirmed:
`detail.votes` is a genuine top-level counter present on 37 of the 52 rows, observed 0 through
1359. Round-2 state was **0 of 52** true; it is now **37 of 52**. The regression is closed.

**The texts-CLI shape fails open rather than false.** ✅ Confirmed empirically. The 2 rows written
by `ingest-legiscan-texts.js` (nested `detail.counts` with text-cache counters, no votes field
anywhere) resolve **true**, not false — they land in the succeeded/partial fail-open branch. The
15 false results decompose exactly as: 12 rows with a genuine top-level `votes: 0`, and 3
failure-shape rows (`keys: error|queries_used`, status `failed`). No false is a shape-miss.

**The implementer's root-cause claim is verified independently.**
`src/cli/ingest-legiscan-texts.js:781` really is `openRun(client, SOURCE)` carrying its own
comment *"SAME source as ingest-legiscan.js — see file header"*. Three distinct real shapes exist
under `source='legiscan'`, and all three are now handled.

**The four other predicates still read their real shapes correctly after the refactor.** ✅
Re-verified live (this was the coordinator's specific ask): `mo-senate-web` reads a real numeric
`counts.votes` on all 153 rows — its 123 false results are genuine `votes: 0` roster/journal-index
slots, which is the honest signal, not a shape-miss. `mo-house-xml` evaluates true on all 127 rows
across all three real shapes, including all 11 `rollcall-pdf` runs via
`detail.rollCallResult.castCount` (the shape I verified live in round 2) and the 3 rows with an
absent `document_type`, which correctly fail open. `us-congress` and `us-senate` are unchanged and
correct.

**Sibling-counter blind-spot audit** — I checked for the exact class of error that produced NEW-1
in the first place (the chosen counter reading 0 while a sibling counter shows rows really landed):

```
mo-senate-web: 153 rows; votes==0 but casts/bills>0 -> 0
us-congress:     3 rows; votes==0 but casts/bills>0 -> 0
us-senate:       4 rows; votes==0 but casts/bills>0 -> 0
legiscan:            votes==0 but casts/bills>0 -> 12
```

The 12 legiscan rows are **not** a defect. Each has `casts: 0` alongside `votes: 0` (e.g.
`{"bills":1746,"casts":0,"votes":0,…}`) — they ingested bills only. `scripts/refresh-aggregates.js`
refreshes **three vote-aggregate materialized views** (`public_position_totals`,
`public_party_alignment`, `public_party_position_totals`, per its own header), all vote-derived, so
a bills-only run genuinely cannot move them and skipping the refresh is correct. A legiscan run
that does write votes moves both counters together (sample: `{"bills":43,"casts":514,"votes":8,…}`),
so `detail.votes` is a faithful proxy for the thing being refreshed. **The counter choice is right,
not lucky.**

**Test provenance** is honest: the round-3 fixtures are documented as real observed shapes fetched
read-only from the live DB during the fix round, and include the regression case explicitly
(`usCongressWroteSomething: THE I4b REGRESSION CASE — … (votes:0) must read as "wrote nothing"`).

### NEW-2 ✅ FIXED — ceiling enforced, round-2 guarantee intact

`MAX_LOCK_DURATION_MS = 2h` (`:123`), applied at `:228` as
`Number.isFinite(declared) && declared > 0 && declared <= MAX_LOCK_DURATION_MS`. Runtime-verified
against the real export:

```
  legiscan 76min (legit)   stale@+9m=false @+11m=false @+77m=true  @+121m=true
  default 9min (legit)     stale@+9m=false @+11m=true  @+77m=true  @+121m=true
  exactly 2h ceiling       stale@+9m=false @+11m=false @+77m=false @+121m=true
  2h + 1ms (over)          stale@+9m=false @+11m=true  @+77m=true  @+121m=true
  1e12 (absurd)            stale@+9m=false @+11m=true  @+77m=true  @+121m=true
  Number.MAX_VALUE         stale@+9m=false @+11m=true  @+77m=true  @+121m=true
```

Absurd values now fall back to the conservative 10-minute default, exactly like a missing/corrupt
field. And the round-2 guarantee is untouched — the legiscan lock still survives a +15-minute tick:

```
   +15m:live  +30m:live  +60m:live  +75m:live  +76m:live  +77m:STALE
```

### NEW-3 ✅ FIXED — failure now aborts before spawn

`:1093-1105`: the return value is captured and, when false, the tick logs and returns **without
spawning**. Runtime-verified the underlying contract against the real export in all five cases:

```
  update with CORRECT nonce  -> true    (lock file really rewritten: maxDurationMs 4560000)
  update with WRONG   nonce  -> false
  update with NULL    nonce  -> false
  update on CORRUPT lock     -> false
  update on MISSING lock     -> false
```

The abort path is inside the `try`, so the outer `finally` still runs `releaseLock` — and that
release is itself nonce-checked, so if the lock update failed *because* the nonce no longer
matches, the release correctly declines to delete someone else's lock. Fail-safe end to end.

### NEW-4 ✅ FIXED — and the safety argument holds under audit

`ORPHAN_CLOSE_SKEW_GRACE_MS = 5 min` (`:128`), applied at `:896` as
`tickStartIso - ORPHAN_CLOSE_SKEW_GRACE_MS`. I audited the stated argument rather than accepting it:

- Every registry interval is ≥30 min: MO Senate/House are hardcoded 30-min ToU constants;
  `us-congress`/`us-senate` are floored at 1h; `legiscan` at 24h. Minimum is 30 min — a **6×
  margin** over the 5-minute grace.
- For a source to be chosen it must be *due*, and `queryLatestStartedAt` has **no status filter**
  (by design), so even a stranded `'running'` row from a prior tick counts against due-ness. A
  source with any row inside the last 5 minutes is therefore not due and cannot be selected.
- Hence any `'running'` row the grace additionally captures must be from the invocation this tick
  just made. The scoping guarantee from round 2 (never touches pre-existing history) survives.

The one residual — a *manual* concurrent run of the same CLI could place a row in the window — is
pre-existing (it was equally reachable with the un-graced `tickStartIso` bound) and outside the
single-instance lock's reach by construction. Not introduced here.

### NEW-5 — accepted scope, untouched. Agreed; my round-2 framing already treated it as an
observation rather than a defect, and nothing in this round changes that.

## (b) Fail-open cannot resolve to silent-never for any completed run

Enumerated by executing every predicate against seven unrecognized shapes
(`{}`, `{counts:{}}`, `{counts:{votes:null}}`, `{votes:'x'}`, `{weird:1}`, `null`, `undefined`)
across every status:

```
  mo-senate-web  succeeded:ALL-TRUE  partial:ALL-TRUE  failed:ALL-FALSE  running:ALL-FALSE  null:ALL-FALSE
  mo-house-xml   succeeded:ALL-TRUE  partial:ALL-TRUE  failed:ALL-FALSE  running:ALL-FALSE  null:ALL-FALSE
  us-congress    succeeded:ALL-TRUE  partial:ALL-TRUE  failed:ALL-FALSE  running:ALL-FALSE  null:ALL-FALSE
  us-senate      succeeded:ALL-TRUE  partial:ALL-TRUE  failed:ALL-FALSE  running:ALL-FALSE  null:ALL-FALSE
  legiscan       succeeded:ALL-TRUE  partial:ALL-TRUE  failed:ALL-FALSE  running:ALL-FALSE  null:ALL-FALSE
  default        succeeded:ALL-TRUE  partial:ALL-TRUE  failed:ALL-FALSE  running:ALL-FALSE  null:ALL-FALSE
```

Every path to `wroteRows === false`, exhaustively:

| # | Path | Resolves false because | Completed run? | Correct? |
|---|---|---|---|---|
| 1 | `selfRecordedFailure === true` | short-circuited by the `!selfRecordedFailure &&` guard at `:919` | No — the child never wrote a row | ✅ nothing to refresh |
| 2 | status `succeeded`/`partial`, **recognized** shape, counter `=== 0` | a real numeric counter was read and it was zero | Yes | ✅ the honest signal — this is the I4b fix working |
| 3 | status `failed` | deliberate: a genuine failure has nothing to refresh | Yes (completed-as-failed) | ✅ documented, intended |
| 4 | status `running` | not a completed run — child opened a row and never closed it | No | ✅ only reachable via a non-SIGTERM hard crash (NEW-5's accepted scope) |
| 5 | status `null` | unreachable in practice: `!selfRecordedFailure` implies `latestRun !== null`, so path 1 already applies | n/a | ✅ |

**There is no path where a completed (`succeeded`/`partial`) run with an unrecognized detail shape
resolves false.** Confirmed twice over: synthetically (table above) and empirically — across all
339 real historical rows, the count of *completed runs resolving false without having read a real
numeric counter* is **0 for every one of the five sources**. Silent-never is unreachable.

## (c) New defects in this diff

### 🟡 R3-1 (Minor) — `mode: "blocked"` now spans two different exit codes, and the doc's exit-code guide wasn't updated

`scripts/scheduled-ingest.js:1094-1104` logs `mode: 'blocked'` and returns **exit 0**. The
pre-existing blocked branch (missing `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, `:1022-1031`) logs
the same `mode: 'blocked'` but sets `process.exitCode = 1`. Meanwhile
`docs/SCHEDULED_INGESTION.md:211-212` still enumerates exit-0 outcomes as *"success, nothing due,
or already-running"* — the new abort isn't listed, and round 3 didn't touch the doc.

Consequence is cosmetic but lands squarely on the "one file Lance reads to know it's alive": a
reader grepping `"mode": "blocked"` cannot tell a benign self-healing abort from a real
configuration failure without also reading `reason`. A distinct mode string (e.g.
`lock-update-failed`) plus one line in the doc's exit-code list would close it. Not ship-blocking:
the `reason` field is explicit and honest, and the behavior itself is correct.

No other new defects found. Specifically checked and clean: the predicate functions attached to
registry entries survive the `{...entry}` spread in `computeSourceDueness`; no function value ever
reaches `JSON.stringify` (every `writeLog` payload uses `chosen.key` and scalar-only
`sourcesSummary`); `defaultWroteSomething` is correctly wired via `??` for a future unwired source;
and the fail-open direction cannot produce a refresh storm (at most one refresh per tick, i.e. per
15 min, of idempotent SQL).

## (e) Ruling — NEW-3 verified by reading, not a dedicated unit test: **ACCEPTABLE, not a gap that blocks ship**

The disclosure is accurate and the reasoning is sound:

- **The decision function is tested, and I re-verified it at runtime.**
  `updateLockMaxDuration`'s false-return contract has round-2 coverage and I independently
  exercised all five branches (correct nonce, wrong nonce, null nonce, corrupt file, missing file)
  against the real export this round. The part carrying actual logic is covered.
- **The untested part has no logic.** It is a three-statement guard: call, `if (!x) { writeLog(…);
  return; }`. There is no branch, no arithmetic, no state. `return` inside `try` still runs the
  `finally` (language-guaranteed), which I confirmed by reading and which the dry-run exercises for
  the sibling early-return paths.
- **The repo convention is real, not an excuse.** No CLI in this repo exports its `main()` — the
  scheduler's own comment at `:625-631` records that this was checked. Testing this branch would
  mean either breaking that convention repo-wide or spawning a real subprocess against a doctored
  lock file, both disproportionate to a guard clause.
- **The failure direction is safe.** If the guard were wrong, the worst case is refusing to spawn a
  run that could have proceeded — the next tick retries and no source's due-ness moved.

I would rule differently if the branch made a *positive* decision (spawning, writing, closing a
row) on untested logic. It does the opposite: it declines to act. Accept as a documented residual.

## (f) Ruling — shared `source='legiscan'` key: **AGREE, out-of-scope-but-ledger, not a blocker**

Verified independently (`ingest-legiscan-texts.js:781`, plus 2 of 52 real rows carrying that CLI's
shape). Every consequence for *this* scheduler is either fail-safe-conservative or
fail-open-harmless:

1. **Due-ness** — `queryLatestStartedAt('legiscan')` could read a texts-CLI row and conclude the
   dataset CLI ran when it didn't. Effect: the legiscan tick is *delayed* by up to 24h. Strictly
   more conservative; it cannot cause an extra call, a ToU issue, or a LegiScan budget event.
2. **Refresh gate** — the texts shape now fails open to true (measured), so the cost is one extra
   idempotent refresh, never a missed one.
3. **Orphan-close** — could in principle touch a texts-CLI `'running'` row, but only given a
   concurrent manual texts run inside the same tick window; that is the same pre-existing
   manual-overlap class the single-instance lock never covered.
4. **The scheduler never invokes the texts CLI** — the registry's legiscan `scriptPath` is
   `src/cli/ingest-legiscan.js`, verified.

The honest fix (distinct source keys, or a discriminator column) is a schema + CLI + historical-row
migration that would also move `public_freshness` — clearly outside this brief, and exactly the
kind of thing that should be Lance's draft-then-apply call rather than a scope creep inside a
scheduler build. **Recommend a TODO.md entry** so it is not rediscovered the hard way during future
freshness work; it does not gate registration.

## Verdicts

| | Verdict |
|---|---|
| NEW-1 (legiscan refresh-gate regression) | ✅ **FIXED** — verified against all 339 real rows; 0/52 → 37/52; texts shape fails open |
| NEW-2 (unclamped lock duration) | ✅ **FIXED** — 2h ceiling, runtime-verified, round-2 guarantee intact |
| NEW-3 (ignored update failure) | ✅ **FIXED** — aborts before spawn; contract runtime-verified in 5 branches |
| NEW-4 (orphan-close clock skew) | ✅ **FIXED** — 5-min grace; ≥30-min-interval argument audited and holds (6× margin) |
| NEW-5 | Accepted scope, agreed |
| Other four predicates after refactor | ✅ **still correct** — re-verified live |
| Fail-open → silent-never for a completed run | ✅ **unreachable** (synthetic + 339-row empirical) |
| New defects this round | 🟡 **1 Minor** (R3-1: overloaded `mode:"blocked"` + stale doc exit-code list) |
| (e) NEW-3 test coverage | **Acceptable** — not a ship blocker |
| (f) shared `source='legiscan'` | **Agree** — out-of-scope-but-ledger |
| **Ship `41936f0..6cf47cf` as unattended-forever code** | ✅ **SHIP** |

Every Critical and Important finding raised across three rounds — C1, C2, I1–I5, NEW-1 through
NEW-4 — is now verified fixed against live data or runtime execution rather than against the
implementer's report. The one open item is a Minor log-string/doc nit that cannot cause a wrong
write, a missed refresh, a ToU violation, or a silent stall.

**Follow-ups (none blocking):**
1. R3-1 — give the lock-update abort its own mode string and add it to
   `docs/SCHEDULED_INGESTION.md`'s exit-code list.
2. TODO.md entry for the shared `source='legiscan'` key between `ingest-legiscan.js` and
   `ingest-legiscan-texts.js`.

**Standing operational caveat, unchanged and now honestly documented:** registering this scheduler
means `mo-senate-web` keeps feeding the TODO-25 session duplicate on a forever cadence.
`docs/SCHEDULED_INGESTION.md:247-268` says so plainly, which was the requirement — the decision to
register before or after TODO 25's merge is Lance's, made with accurate information.
