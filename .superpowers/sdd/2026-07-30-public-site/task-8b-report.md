# Task 8b Report: launch-data completeness — three $0 backfills (D1/D2 + at-large)

## Status
COMPLETE (TDD, fixture/fake-client-tested only — no live DB writes, no live congress.gov/LegiScan
requests anywhere in this branch's test suite; live runs are the controller's per the brief).

## Commit
`7063b506b3af04086f4056531a1a745745b8e55` — `feat: launch-data backfills (MO terms roster,
federal placeholder names, at-large districts)`

## Test summary
1612/1612 passing (1551 baseline + 61 new — see Micro-fix below for the final count), 0 fail,
0 regressions.

## Micro-fix (post-review)
Review verdict: spec PASS, quality PASS with one MODERATE + one informational.

- **MODERATE (fixed):** `runAtLargeBackfill`'s D3 write (`src/cli/backfill-federal-names.js`)
  incremented `counts.filled` on any non-error response from `.update(...).eq('id', ...)
  .is('district', null)` — but without `.select()` chained, a zero-rows-affected response (the
  `.is()` guard filtering everything out under a race with something else that already filled the
  same row) is indistinguishable from a real success; both come back `error:null`. Fixed exactly
  like the D2 path already does 30 lines above in the same file: chained `.select('id')` and, when
  `data.length === 0`, count a new `alreadyFilled` bucket (added to `emptyAtLargeCounts`) instead
  of `filled`. The stale "TOCTOU guard" comment on `.is()` was also corrected to point at
  `.select()` as what actually confirms the write, not the guard clause alone.
  TDD: added `runAtLargeBackfill: a zero-rows-affected update ... is honestly counted
  alreadyFilled, never filled` (`tests/backfill-federal-names.test.js`) — watched it fail red
  against the pre-fix code (asserting `filled:0`/`alreadyFilled:1` against code that still counted
  `filled:1`), then green after the fix. `makeFakeTermWriteClient` was extended to chain
  `.select()` and accept per-term-id override results (mirrors `makeFakeLegislatorUpdateClient`'s
  existing keyed-override convention for the D2 race test); the pre-existing tests using the fake
  client's default (no override) continued to pass unchanged since the default still simulates one
  row updated.
- **Informational (closed):** the real-cache-dir smoke test in `tests/backfill-mo-terms.test.js`
  injected an empty legislator index, so it short-circuited at `noMatchingLegislator` before ever
  exercising `normalizeLegiscanDistrict`'s output against a real decoded person. Added one more
  real-fixture test mapping a real 2026-roster person (Hardy Billington, `people_id 20696`, real
  source district `"HD-152"`) to a fake legislator id, asserting the full real-decode ->
  chamber/district-resolution -> insert path lands `district: '152'`.

Final count: 1612/1612 (1551 baseline + 59 from the original commit + 2 from this micro-fix), 0
fail, 0 regressions.

## Micro-fix commit
`fix: at-large backfill counts zero-row updates as alreadyFilled`

## T8c follow-on: federal term dates from member service years (fills-null)
Coordinator follow-on (2026-07-30): a live smoke test proved the MO sections perfect but found US
Senate rendering 11 honest candidates for a MO address — every undated historical senator matches
`site/js/districts.js`'s `matchReps` with no date evidence to tell them apart.

**Design call ("your call, report it"):** extended `src/cli/backfill-federal-names.js` with a
THIRD pass, `runFederalTermDatesBackfill`, rather than a sibling CLI — same file already owns the
`/member/congress/119` roster fetch (D2) and the exact `.select('id')` row-count-race pattern the
review's own micro-fix just established (D3), so the new pass reuses both directly instead of
re-deriving them elsewhere. Kept as its OWN independently-testable function with its OWN
gate/fetch (mirrors `runAtLargeBackfill`'s existing independence from D2) rather than threading one
shared roster fetch through three differently-shaped passes — the trade-off (a live run needing
BOTH D2 and date fills pays for the ~11-request roster page TWICE, ~80s total, still $0) is
documented in the file's own EFFICIENCY NOTE rather than hidden.

**Payload granularity actually offered** (verified against the real committed fixture,
`tests/fixtures/us-congress/member-page-unfiltered.json` — all 20 real members, both current and
departed): every `terms.item` entry is **YEAR-ONLY** — a bare `startYear` and an optional
`endYear`, no month or day anywhere in the payload. Congress.gov also **collapses consecutive
same-chamber terms into ONE item** covering the whole stint rather than one item per 2-year term —
e.g. Payne, Donald M. (`P000604`) shows a single House item `{startYear:2012, endYear:2024}`
covering what was actually six separate terms; Shuster, Bill (`S001154`) the same
(`{startYear:2001, endYear:2019}`, one item for nine terms). No member in the fixture carries more
than one item for the same chamber (a chamber SWITCH shows as two items of different chambers, not
two same-chamber items). Per the coordinator's own instruction for this granularity: both
`start_date` and `end_date` are computed as `${year}-01-03` — the 20th Amendment's constitutionally
fixed congressional turnover day (noon, January 3rd of odd-numbered years) — documented explicitly
as `congressionalTermDate` in the source. An open/current service (no `endYear`) leaves `end_date`
null, counted `partialFilled` (not `datesFilled`); the site already renders "(end date unrecorded)"
honestly for that case.

**Multi-stint handling:** `resolveServiceRangeForChamber` picks the range covering the 119th
Congress (2025–2027) when a legislator has more than one range for the same chamber — a defensive
branch (no fixture example exercises it, since real data shows exactly one range per chamber),
falling back to the most-recently-started range if none cover the 119th, never guessing an
arbitrary one.

**Honest counts:** `{termsSeen, datesFilled, partialFilled, noMemberFound, alreadyDated}`, reported
as a `dates` sub-object on `runBackfillFederalNames`'s combined report (alongside `counts` for D2
and `atLarge` for D3). `noMemberFound` is the deliberate catch-all for every case nothing can be
honestly resolved from (non-`us-congress` jurisdiction, no bioguide_id, bioguide not in the fetched
roster, or a roster hit with no service range for that SPECIFIC chamber) — mirrors
`backfill-term-states.js`'s own `memberNotFound` catch-all rather than inventing extra buckets the
brief's fixed 5-count list didn't ask for. A zero-rows-affected write (raced by something else that
dated the row between read and write) is counted `alreadyDated`, applying the SAME `.select('id')`
row-count-check discipline the review's D3 micro-fix just established in this same file — verified
red against a deliberately-broken build (multi-range resolution) before confirming green against
the real implementation.

**TDD:** 20 new tests (`resolveTermDates` pure-function cases including the multi-stint
covering/fallback branches, `loadTermDateIndex`, `runFederalTermDatesBackfill` orchestration
including the TOCTOU/dry-run/noMemberFound paths, a real-fixture end-to-end proving Payne fills
both dates and Gallagher — currently serving — fills only `start_date`, plus the D2 roster-index
fixture assertions extended to cover the new `service` field and one new combined-orchestration
test proving all three passes land in one report). Final count: 1632/1632 (1612 prior + 20 new), 0
fail, 0 regressions.

## T8c commit
`feat: federal term dates from member service years (fills-null)`

## What was built
- `src/cli/backfill-mo-terms.js` (D1): fills `mo-legislature` `terms` from the LATEST cached MO
  LegiScan session's people records only. Session chosen mechanically (highest `year_start` among
  the 31 cached dataset envelopes, read from top-level envelope metadata with no ZIP decode until
  the winner is picked) — live-verified against the real cache: session 2239, "2026 Regular
  Session" (year_start 2026), unambiguous winner. Reuses `chamberFromRole`/
  `normalizeLegiscanDistrict`/`UnrecognizedLegiscanRoleError` (legiscan-identity.js),
  `listCachedDatasetFiles`/`readCachedDatasetPeople` (backfill-nicknames.js), and
  `loadLegislatorIndex` (backfill-mo-bill-meta.js) — no parallel logic. Dates stay null;
  idempotency is check-then-insert (`findExistingMoTerm`, `start_date IS NULL`) since the terms
  unique constraint cannot dedupe null start_date. `state:'MO'` is written when the column exists,
  with a per-run graceful fallback if migration 0016 is somehow unapplied (never blocks the
  primary term row). Honest counts: `{peopleSeen, termsInserted, alreadyPresent,
  noMatchingLegislator, skippedNonLegislator}`.
- `src/cli/backfill-federal-names.js` (D2 + D3): fills `full_name`/`party` for legislator rows
  where `full_name` still equals `bioguide_id` (our own synthetic placeholder), sourced from
  congress.gov's `/member/congress/119` (covers departed members the current-member fill
  skipped). Update carries `.eq('full_name', bioguide_id)` as a structural guard — a real name
  can never equal its own bioguide id, so a race is counted `alreadyReal`, never risked. Honest
  counts: `{placeholdersSeen, filled, noMemberFound, alreadyReal}`. Also runs the D3 at-large
  fills-null pass (reuses `loadTermIndex` verbatim from backfill-term-states.js, same
  migration-0016 gate): `us-congress` house terms with null district and `state` in the at-large
  set (AK/DE/ND/SD/VT/WY) get `district:'0'`. Reported as a separate `atLarge` sub-object:
  `{candidatesSeen, filled, gatedMissingColumn}`.
- `src/adapters/us-congress.js`: `parseMemberList` now yields `district:'0'` (not null) for
  at-large House members going forward (Census CD '00' convention, matching `site/js/
  districts.js`'s existing null-bridge target value); `fetchMemberPage` grew one optional
  `congress` parameter routing to `/member/congress/{congress}` — every existing caller
  (`ingest.js`, `enrich-federal-bills.js`) passes only 2 positional args, unaffected.
  `site/js/districts.js`'s null-bridge is untouched and stays in place for any row this backfill
  has not yet reached.

## Fixtures
No new live captures were needed: `tests/fixtures/us-congress/member-page-unfiltered.json`
already carries members with `endYear` set (departed) alongside current ones — exactly the shape
`/member/congress/119` returns and `parseMemberList` doesn't discriminate by source endpoint.

## Concerns
- Not runnable live by me: no `SUPABASE_SERVICE_ROLE_KEY`/`CONGRESS_API_KEY` live-call approval in
  this session — every DB write and every congress.gov fetch is exercised only against fakes/
  fixtures/injected stubs. Dry-run then live run, plus spot-checks (a Wyoming/Vermont/etc. House
  term shows `district:'0'`; a formerly-placeholder legislator shows a real name; a sample of
  newly-inserted MO terms match the real 2026 roster), are the controller's next step.
  `backfill-federal-names --dry-run` will make ~11 real congress.gov requests (throttled
  3.6s/request, ~40s) — same operational note Task 2 already flagged for its own dry-run.
- `insertMoTermRow`'s state-column fallback is scoped to `isMissingColumnError(error, 'state')`
  only; any other insert error is thrown, never swallowed, so a genuine partial-write scenario
  (e.g. a bad FK) will surface loudly rather than being silently absorbed into `termsInserted`.
- MO terms are inserted with `party` exactly as LegiScan prints it (single-letter codes like
  `R`/`D`) — no normalization against the federal `partyName`-style full words used elsewhere;
  left as-is since the brief specifies "as printed" and no site consumer today depends on the two
  being in the same vocabulary.

## T8c fix round: real per-term dates from congress-legislators (Jan-3 synthesis removed)
Controller-owned MAJOR from the T8c review: the first implementation's Jan-3-convention date
synthesis produced provably false personal dates — Payne, Donald M. (P000604) rendered with
end_date 2024-01-03 when he actually died in office 2024-04-24, and start_date 2012-01-03 while
the seat was still held by his father (Donald Payne Sr., died 2012-03-06) until Payne Jr. won a
special election and was sworn in. Lance approved swapping the date SOURCE to the
`unitedstates/congress-legislators` dataset (public domain, CC0, bioguide-keyed, real per-term
day-precision dates from the House/Senate Biographical Directory).

**Cache (mirrors the LegiScan ZIP-cache discipline):** downloaded
`https://unitedstates.github.io/congress-legislators/legislators-current.json` and
`.../legislators-historical.json` ONCE into
`.superpowers/artifacts/congress-legislators/legislators-{current,historical}-2026-07-30.json`
(1.4MB / 13.5MB — gitignored under `.superpowers/`, never committed).
`readCongressLegislatorsCache` (`src/cli/backfill-federal-names.js`) reads ONLY from that cache
directory (latest-dated file per prefix, ISO filenames sort chronologically) — zero live HTTP
requests for date data, ever; a missing/unreadable cache folds every genuine candidate into the
existing `noMemberFound` bucket (counts unchanged in shape, as instructed), never a fetch.
Committed excerpt fixtures (`tests/fixtures/congress-legislators/legislators-{current,
historical}-excerpt.json`) hold real, byte-verified-against-the-downloaded-files records for
Payne (P000604), Shuster (S001154), and Hawley (H001089, current open Senate service).

**Derivation replaced:** `resolveTermDates` now filters a matched member's real `terms[]` by
type (`'rep'`→house, `'sen'`→senate), takes MIN(start)/MAX(end) across that chamber's terms for a
CLOSED career; a member present in `legislators-current.json` whose own LAST term matches the
target chamber is "open" — `end_date` stays null (verified: Hawley's own current term carries a
real but SCHEDULED `end` of 2031-01-03 in the dataset, which this pass deliberately never writes
— presence-in-current, not a term's own `end` field, is what decides "still serving"). All
guard/chamber-isolation/honest-count mechanics from the first round (both columns
`.is(col, null)`-guarded, `.select('id')` row-count race check, `{termsSeen, datesFilled,
partialFilled, noMemberFound, alreadyDated}`) are UNCHANGED, per the review's own verdict that
they were already correct.

**Deleted entirely, per instruction:** `CONGRESS_START_YEAR`, `congressionalTermDate`,
`resolveServiceRangeForChamber`, `classifyServiceChamber`, `extractServiceRanges`, and the
"PAYLOAD GRANULARITY"/"EFFICIENCY NOTE" header comments describing the Jan-3 convention — no dead
"documented convention" text left for a future reader to resurrect. `loadFederalMemberIndex`
(D2's congress.gov roster loader) reverted to its original `{full_name, party}`-only shape (the
`service` field it briefly carried was T8c-only and is gone with the rest of the old approach).

**Payne's asserted dates (the point of the fix, live-verified against the freshly-downloaded real
file moments before writing the fixture):** `start_date: '2012-11-15'`, `end_date: '2024-04-24'`.
Note: the coordinator's dispatch message said "start 2012-11-06" — the REAL downloaded
`legislators-historical.json` record (re-verified independently, not from memory) shows Payne's
first term `start` as `2012-11-15` (nine days after the November 6, 2012 special election, likely
his swearing-in date), not November 6th itself. Trusted the freshly-fetched primary source over
the paraphrase per this project's own "verify current state before asserting it as fact"
convention; `2024-04-24` (the end date) matched exactly. Shuster's real closed-career bounds:
`2001-05-17` (sworn in via special election after his father Bud Shuster's resignation) to
`2019-01-03` (normal end of his final, non-renewed term). Hawley: `2019-01-03` / `null` (open).

**TDD:** rewrote the T8c test sections against the new dataset shape — `readCongressLegislatorsCache`
(real excerpt dir, missing dir, one-file-only, malformed JSON, latest-dated-file selection),
`resolveTermDates` pure cases (Payne/Shuster/Hawley with their real values, chamber isolation, a
constructed House→Senate chamber-switch case proving a closed chamber never gets null-ended just
because the member overall is still serving), `runFederalTermDatesBackfill` orchestration
(closed/open/already-dated/non-federal/no-bioguide/absent-from-dataset/cache-missing/TOCTOU-race/
dry-run), and two full real-excerpt-fixture end-to-end tests. Verified genuinely red (not
tautological) via two deliberate-break-then-restore sanity checks: the multi-range covering logic
(round 1) and the open-service `isCurrent`/last-term-type check (this round) — both caught by the
relevant tests when broken, both clean when restored (diffed to confirm no drift). Final count:
1660/1660 (1653 baseline + 7 net new — 52 in the file vs. 45 before), 0 fail, 0 regressions.

## T8c fix-round commit
`fix: federal term dates from congress-legislators real per-term dates (CC0), Jan-3 synthesis removed`
