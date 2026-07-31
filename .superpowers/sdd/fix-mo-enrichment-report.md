# fix-mo-enrichment — report

Branch: `fix-mo-enrichment`. No live house.mo.gov fetches were made during this task (fixture
fetches and DB reads/writes only, per the task's constraint). No Anthropic API calls were made.

## Root cause (verified, not assumed)

The task's stated hypothesis was **not confirmed** on investigation, and the real root cause is
different and narrower:

- **`additivePatch` was already correctly wired.** `src/cli/ingest-mo-house.js`'s
  `persistBillDetail` has called `additivePatch(existing, incoming)` before every `bills.update()`
  since this file's very first commit (`81fa9f0`, "feat: mo-house-xml adapter") — TODO.md item
  10b ("additivePatch exists but nothing calls it") predates that commit and was stale for this
  code path specifically.
- **HB 2's real XML does parse a title.** Ran `parseMoBillXml` directly against the real captured
  fixture `tests/fixtures/research/mo-house-xml/HB2-bill-text-pdf-only.xml`: it yields
  `title: "Appropriates money for the expenses, grants, refunds, and distributions of the State
  Board of Education..."`, a non-null `status`, `canonical_url`, and 1 dated action. HB 2 is not a
  "no parseable title" bill shape.
- **The actual bug: `selectTargets`'s default branch had zero enrichment-state awareness.** It was
  `entries.slice(0, args.limit)` — pure BillList.XML document order, sliced to `--limit`, with no
  check for whether a bill had already been fetched. HB 2 is entry #1 in the real live list
  (session 261 has no HB 1), and the driver's default `--limit` is 1, so **every** invocation
  without an explicit `--bill` re-selected HB 2, forever, regardless of its enrichment status.

**Live evidence** (read directly from the production `ingestion_runs`/`bills` tables, DB-reads
only): of the 12 real half-hour cooldown slots between `2026-07-28T04:50:57Z` and
`2026-07-28T10:54:24Z`, **11** fetched bill-xml for `HB 2` and only **2** runs ever wrote a new
title anywhere (one enriched `HB 1800` via an explicit-bill invocation, one — `aa558e3c`, left
`status: 'running'`/`finished_at: null`, an orphaned process — enriched 13 bills in one shot,
apparently a manual `--limit 13` test run). **10 consecutive scheduled slots made zero enrichment
progress.** (Note: the task said "seven"; the live data shows 11 — the diagnosis and fix are the
same either way, reporting the precise number here for accuracy.)

A second, related bug was also confirmed live: every invocation's `ingestion_runs.started_at` /
`finished_at` pair is **exactly 30 minutes apart** (e.g. `10:24:22Z` → `10:54:22Z`). Cause: the
bill-list fetch and the per-bill fetch share the same in-process `moHouseLimiter`
(`<=1 req/30min`), so the second fetch of every invocation had to wait out a full second interval
after the first — every invocation was burning its **entire** cooldown slot on a redundant list
re-fetch, roughly halving throughput.

## Fix

1. **`hasEnrichedMarker` / `writeEnrichedMarker`** (`.superpowers/artifacts/mo-bills/<id>.json`,
   gitignored, file-presence-driven — same idiom as this file's existing PDF quarantine).
   `selectTargets`'s default branch now filters out bills with a marker before slicing to
   `--limit`; `main()` writes the marker right after a bill's fetch+parse+persist cycle completes,
   unconditionally (regardless of what fields stayed null).

   Considered and **rejected**: "no `bill_actions` rows" as the pending-signal (avoids a new
   artifact). Rejected because `persistBillDetail` already drops any `Action` with no `PubDate`
   before writing `bill_actions` (`datedActions = parsed.actions.filter((a) => a.date)`) — a bill
   whose only action(s) lack a date would show zero `bill_actions` rows despite a fully successful
   cycle, reproducing the exact same false-forever-pending bug. Both real fixtures (HB 2, HB 1800)
   happen to have every action dated, but the schema doc does not document `PubDate` as required,
   so this isn't a safe assumption. The marker file makes no assumption about the XML's shape at
   all.

2. **`persistBillDetail` exported** and directly unit-tested with a stubbed client per the task's
   spec: stub row `{title: null}` + parsed `{title: 'X'}` → `update()` called with
   `{title: 'X', run_id}`; existing non-null title → `update()` never called (this is the literal
   "HB 2 fetched 7/11 times, zero progress" behavior, pinned as a regression test).

3. **`shouldRefetchBillList` / `readCachedBillList` / `writeCachedBillList`**
   (`.superpowers/artifacts/mo-bill-list/<session>.json`): the list is cached with a fetch
   timestamp; `main()` only re-fetches live once the cache is `>= 60min` old
   (`MO_BILL_LIST_MAX_AGE_MS`), otherwise reuses the cached entries and goes straight to the
   per-bill fetch. Decision function is pure and unit-tested (no-prior-cache, fresh, stale,
   boundary at exactly 60min).

4. **One-time marker backfill** (`backfillEnrichedMarkers`, exported, unit-tested): bills enriched
   by real live runs *before* this marker mechanism existed carry a non-null `title` in the DB but
   had no marker file. Ran this once against the live DB during verification (DB read + local file
   writes only, zero live fetches) — backfilled 14 markers (the 14 bills already enriched:
   `HB 2-13`, `HB 17`, `HB 1800`).

5. `dryRunReport` (`--dry-run`) extended with `bills_without_enriched_marker` and
   `next_targets_preview` (paginated DB read + marker check, still zero live fetches) so the fix's
   effect is directly observable without a live run.

## Live dry-run verification (DB reads only, zero fetches)

After the one-time backfill:

```
node --env-file=.env src/cli/ingest-mo-house.js --dry-run
{
  "counts": {
    "bills_total": 2099,
    "bills_needing_enrichment": 2085,
    "bills_without_enriched_marker": 2085
  },
  "next_targets_preview": [
    "HB 1607", "HB 1608", "HB 1609", "HB 1610", "HB 1611",
    "HB 1612", "HB 1613", "HB 1614", "HB 1615", "HB 1616"
  ]
}
```

Directly confirmed: `hasEnrichedMarker('HB 2') === true`, `hasEnrichedMarker('HB 1800') === true`,
`hasEnrichedMarker('HB 1607') === false`. **HB 2 is excluded** from the pending set post-fix, as
required. (Reported honestly: `next_targets_preview` is sorted by DB identifier, i.e.
alphabetically — not the true `BillList.XML` document order `selectTargets` actually uses live/from
cache, since producing that exact order without a live fetch isn't possible. The 2085 pending count
and the HB-2-excluded fact are the load-bearing claims here, not the preview's ordering.)

A genuine bug was found and fixed *during this verification*: the first draft of the
`bills_without_enriched_marker` query used an unpaginated `.select('identifier')`, which
PostgREST/Supabase silently caps at 1000 rows server-side (confirmed live — `bills_total` is 2099;
an explicit `.range(0, 2098)` still only returned 1000 rows). Fixed with real pagination
(`.range()` looped in 1000-row pages until exhausted); the paginated result (2085) now matches the
independent `bills_needing_enrichment` head-count exactly, as expected since the backfill covers
precisely that set.

## Test results

`npm test`: **277/277 passing** (258 baseline + 19 new tests: 2 `persistBillDetail`
additivePatch-wiring tests, 3 marker-presence tests, 4 `selectTargets` tests including the direct
regression test for the HB-2-forever bug, 2 `backfillEnrichedMarkers` tests, 5
`shouldRefetchBillList` tests, 3 cache round-trip tests). 0 failures.

## Concerns / out of scope

- **Orphaned `ingestion_runs` row** (`aa558e3c-...`, `started_at: 2026-07-28T04:54:02Z`,
  `status: 'running'`, `finished_at: null`, apparently a manual high-`--limit` test run that never
  reached `closeRun`) — found while reading live data, not fixed here (out of scope for this task,
  and `enforceDurableCooldown`'s cooldown-elapsed check already means it can't block future runs
  once enough wall-clock time passes). Worth a follow-up if `ingestion_runs` history/observability
  matters — it currently muddies "how many runs actually succeeded" queries.
- **Residual list/bill-fetch serialization**: on an invocation where the 60-min list cache *is*
  stale, that invocation still does list-fetch-then-bill-fetch through the same in-process
  `moHouseLimiter`, so it still absorbs one ~30-min internal wait — now at most once per hour
  instead of every 30 minutes. Fully decoupling the two would need either a second limiter instance
  or restructuring to fetch the list and bill in separate invocations; not implemented, as it's
  beyond what was asked (cache-based cadence only) and this codebase's own convention is to not
  over-build past the stated ask.
- **`backfillEnrichedMarkers` is not wired into `main()`'s normal path** — it's a one-time
  migration helper, exported and unit-tested, run manually once during this task's verification.
  If markers are ever wiped (new machine, cache directory deleted) it can be re-run the same way;
  no CLI flag was added for it to keep the change's surface area bounded to what was asked.
- Unrelated, noted only for completeness: migrations 0005/0006
  (`legislators.mo_house_id`/`surname`) are still not applied to the live DB (confirmed via the
  existing `persistRollCallCasts` gate-artifact note) — pre-existing, not part of this task.
