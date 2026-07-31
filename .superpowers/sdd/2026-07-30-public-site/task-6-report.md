# Task 6 report — profile page (person.html, person-page.js, legislator.html, legislator-page.js)

## Status
Code-complete, including fix rounds 1-3 (three live-smoke rounds, a formal opus task review, and
a re-review micro-round on round 3's own new coupling). Automated suite green throughout. I still
have no browser tool of my own — every live smoke was run by the controller.

## Commits
- `e52c6be` — `feat: render.js - src/alt attrs under the scheme guard (photo support)`
- `29c0de4` — `feat: profile page (person + legislator forwarding) wired to live anon surface`
- `1cb831d` — `fix: profile page - non-2xx throws to failed state, all affiliations when dates unproven, favicon`
- `f451edd` — `fix: profile page - honest pagination, omit bare numeric status codes`
- `e1cc62f` — `fix: profile page - render-phase containment, freshness tri-state, flag honesty, filter race, hardening batch`
- `871a4f6` — `fix: profile page - bidirectional identity/freshness retry, votes unserialized, guard dedup`

Branch `public-site`. Two commits from other work streams landed between mine — not mine, noted
only because they sit in the log: `e54d3e6` (migration 0017 draft, the controller's own fix for
the vote-feed statement-timeout finding) and `bed1cee` (a spec amendment + Task 6b plan for vote
aggregate charts, unrelated to this task).

## Test summary
1405/1405 pass, 0 fail (1324 baseline → 1328 after the render.js extension → 1354 after the
profile page → 1366 after fix round 1 → 1382 after fix round 2 → 1399 after fix round 3 → 1405
after the re-review micro-round: +4 render.js src/alt tests, +3 `voteFilterQuery` missed-votes-
filter extension tests, +23 `tests/person-page.test.js` pure-helper tests, +3 rest.js `RestError`
tests, +5 `buildIdentity` affiliation tests, +4 person-page wiring-layer regression tests, +6
`paginationSummary` tests, +5
`nextVoteFilters` tests, +3 `isNumericStatusCode` tests, +2 `renderSponsorships` numeric-status
DOM tests, +17 fix-round-3 tests across `idFromPath`/`paginationSummary`/`renderPhoto`/
`loadVotesSection`/`loadFreshnessSection`).

## What was built
- `site/js/render.js`: attrs allowlist extended `{class, href, id, dataset}` → `+ {src, alt}`.
  `src` reuses the same guard structure as `href` (control-char strip, protocol-relative
  rejection, scheme allowlist) via a new shared `assertSafeUrlAttr`, configured stricter than
  `href`: https-only, no relative-path allowance (both real `photoUrl()` results are always
  absolute https). TDD'd first (4 new tests: https accepted; javascript:/data:/http:/relative/
  protocol-relative all rejected).
- `site/js/profile-model.js`: `voteFilterQuery` gained a `missedOnly` param appending
  `position=in.(not_voting,absent)` before the order clause — the missed-votes toggle's server
  filter, on the same path builder (never a client-side re-filter). TDD'd first.
- `site/js/person-page.js`: pure helpers (`idFromPath`, `buildOneLinerMap`, `joinFlagBadges`,
  `relevantFreshnessRows` — the last is a bonus beyond the brief's named three, since it's the
  same kind of pure/testable logic the freshness step needs) TDD'd first in
  `tests/person-page.test.js`, then the DOM/network wiring: `mountProfile` (the shared
  section-orchestrator both pages use), `bootstrapPersonPage` (person.html's entry point),
  `renderNotFound`, and per-section loaders each independently three-stated via `sectionState`.
- `site/js/legislator-page.js`: `bootstrapLegislatorPage` — fetches the single row,
  `person_id` set → `location.replace('/person/<id>')`, else calls the SAME `mountProfile` with
  `legislators=[row], person=null`. No duplicated rendering logic.
- `site/person.html`, `site/legislator.html`: minimal shells (identity/vote-filters/votes/
  sponsorships/freshness sections + footer), each with a 2-line inline `<script type="module">`
  calling its page's exported bootstrap function — deliberately not auto-run at module import
  time, since `legislator-page.js` imports `person-page.js` for reuse and an auto-run bootstrap
  in the imported module would have double-fired on `/legislator/...` URLs.
- `site/css/site.css`: minimal functional styles for the new elements (explicitly not a polish
  pass — that's later in the design spec's build order).

## Data-flow fidelity to the brief
All 7 steps implemented as specified: existence check → not-found; terms → `buildIdentity`;
paginated votes via `voteFilterQuery` + `pagedFetch`, server-side filters only; current-page
distinct `bill_id`s → one summaries query → `buildOneLinerMap` (first-per-bill_id, title-only
on null/absent, no placeholder text); current-page `vote_id`s → `public_reconciliation_flags` →
`joinFlagBadges` → badge linking `/trust#flags`; `bill_sponsors` + embedded `bills` →
`groupSponsorships` → four labeled sections, empty groups render nothing;
`public_freshness` filtered to the profile's jurisdictions (`us-` prefix for us-congress,
`mo-` prefix + exact `legiscan` for mo-legislature) with the quarantined-days count surfaced.
Vote position renders exactly as stored (yea/nay/not_voting/absent/present/other — never
reworded). Each vote row also carries a `chamberLabel(jurisdiction_id, chamber)` tag — needed
because a merged profile like Onder's real shape casts votes across two different
jurisdiction/chamber pairs (MO Senate 2013–2023, US House 2023–) and an undifferentiated combined
list would be misleading about which chamber each cast came from.

One-liner and flag-badge fetches are treated as additive enhancements to an already-successful
votes fetch: if either sub-fetch throws, the vote list still renders (from the successful primary
fetch) with rows falling back to title-only / unflagged, rather than failing the whole votes
section over a secondary data source.

## Verification beyond the automated suite
I have no browser tool, so I could not run the brief's Step 4 live smoke. To reduce risk before
handoff I wrote two throwaway scripts (not committed, deleted after use) exercising the real
module code under jsdom with `rest.js`'s `_setFetch`/`_setConfig` test hooks standing in for
Supabase:
1. A mocked full `mountProfile` dry run against an Onder-shaped fixture (2 legislator rows, 2
   terms, 2 votes across both jurisdictions, 1 published summary, 1 reconciliation flag, 1
   sponsorship, 3 freshness rows) — confirmed every section rendered correctly together
   (identity, chamber-labeled votes with one-liner/receipt/flag badge, sponsorships, freshness
   with the quarantine count, footer, photo `<img>`), no exceptions.
2. `legislator-page.js`'s three branches: linked row (jsdom confirmed `location.replace` was
   actually invoked, logging "Not implemented: navigation" as expected in a non-navigating test
   environment), not-found row, and an unlinked thin-data row (confirmed every section degrades
   to an honest "unrecorded"/"no data" state, never a crash, never fabricated data).

This is not a substitute for the real live smoke against actual Supabase data and a real browser,
but it does prove the wiring is exception-free and produces the expected DOM shape against
realistic mocked payloads.

## Concerns
- **Cross-section staleness on identity retry (minor, accepted):** if the identity section's own
  fetch fails and the user clicks its retry, the identity section itself re-fetches and
  re-renders correctly, but the freshness section (which depends on `terms` captured at the time
  `mountProfile` first ran) does not get the retried `terms` value and stays on whatever it
  rendered from the initial (degraded, `terms: []`) attempt. Each section's own retry works
  correctly in isolation (the three-state law's actual requirement); this is a narrower
  cross-section propagation gap on a fairly rare path (terms fetch failing after the
  existence fetch already succeeded). Not fixed — flagging for the controller to decide if it's
  worth a follow-up.
- **Slug generation is a local `slugify()` helper**, not a shared module — no existing shared
  slug utility was found in the codebase (checked `src/adapters/us-congress.js`'s
  `slugToPath`/`billTypeSlug`, which are congress.gov bill-TYPE-to-URL-segment mappers, a
  different concern). Since the brief states the trailing slug segment is "cosmetic and ignored
  by lookup," this is low-risk, but a future bill-page task (Task 8) should reuse this same
  slugify or its own equivalent rather than inventing a third scheme.
- **`officialBillUrl` (receipts.js) is not used on this page** — by design: the brief/spec route
  sponsorship → our bill page → official bill (two hops), so the direct official link belongs on
  the future bill page (Task 8), not here. Noting this since it's one of the three receipts.js
  names listed as "consume by exact name" but this task legitimately has no direct use for it.
- Live smoke outstanding at the time this was originally written: real Onder person_id lookup,
  ~1,650-cast pagination, 179 sponsored bills, real receipt URLs, throttled-network loading-state
  visibility, and whether any of his real votes carry a reconciliation flag. Superseded by the two
  fix rounds below — the controller's live smokes have since confirmed identity/votes/one-liners/
  receipts/filters genuinely work against live data; pagination and reconciliation-flag/throttled-
  network visibility remain to be re-confirmed live after fix round 2 (pagination didn't exist
  yet at either prior live smoke).

## Fix round 1 (controller live browser smoke)

**Status:** done. **Commit:** `1cb831d`. **Tests:** 1366/1366, 0 fail (12 new: 3 rest.js, 5
profile-model.js, 4 person-page.js).

The controller ran the brief's Step 4 live smoke and reported sponsors/identity/filters rendering
well, plus 3 findings for this task (a 4th, the vote-feed statement timeout itself, was a DB index
— migration 0017, drafted separately, not mine).

1. **LOAD-BEARING — a failed fetch rendered as honestly-empty.** Root cause was in
   `site/js/rest.js`, not `person-page.js`: `doFetch`'s `Array.isArray(rows) ? rows : []`
   fallback silently treated ANY non-array JSON body — including a PostgREST error object
   (`{code, message, ...}`) on a non-2xx response — as zero rows. Every caller (`pagedFetch`,
   `restGet`, `fetchAllRows`, `countOnly`) inherited this, so the live statement-timeout 500 on
   the vote feed came back as `{rows: [], total: null}` and `loadVotesSection`'s
   `page.rows.length === 0` check rendered `'No recorded votes for this filter.'` — the exact
   three-state violation the plan forbids. Fixed at `doFetch` (the one shared primitive): any
   non-2xx now throws a new typed `RestError` (status + the PostgREST message when the body
   carries one) before any caller sees a rows array. `person-page.js`'s section loaders already
   had `try/catch → sectionState('failed', ..., onRetry)` around their primary fetches — once
   `rest.js` throws correctly, no loader logic needed to change; I only exported
   `loadVotesSection` so the regression could be asserted directly. TDD'd first in both
   `tests/site-modules.test.js` (typed-throw on non-2xx, including an unparseable error body) and
   `tests/person-page.test.js` (asserts `'failed'` renders, `'empty'` does not, on a rejecting
   fetch; a companion test pins that a genuine empty-but-successful result still renders
   `'empty'`, so the fix can't flip false-failed in the other direction).
2. **IMPORTANT — one arbitrary term picked when dates can't order the terms.** With all term
   dates null, `mostRecentTerm()` returned null and the old fallback (`termRows[0]`) picked
   whichever row was first in an unordered query — live-observed as "MO Senate, district 2" for a
   man currently in the U.S. House. Fixed in `buildIdentity` (`site/js/profile-model.js`): when
   the term set is date-unproven AND there is more than one distinct `(jurisdiction_id, chamber,
   district)` affiliation, `chamberLabel` becomes all of them joined (` · `-separated, each
   segment already carrying its own "district N"), sorted by the tuple itself for determinism
   regardless of caller array order (the same discipline as the earlier party-precedence fix), and
   `districtLabel` is `null` so `renderIdentity`'s existing `chamberLabel + ", district " +
   districtLabel` never double-appends. A single distinct affiliation (even across duplicate term
   rows) keeps the original single-field shape; when dates DO order the terms, nothing changed.
   TDD'd first: 5 new `buildIdentity` cases in `tests/profile-model.test.js`, plus 2
   `renderIdentity` DOM assertions in `tests/person-page.test.js` (joined string with no
   duplicated suffix; single-affiliation shape unchanged) — `renderIdentity` exported for this.
3. **MINOR — favicon 404 noise.** Added a trivial inline data-URI SVG `<link rel="icon">` (a
   rounded blue square with "V") to `site/person.html` and `site/legislator.html` — an authored
   asset, not DB content, so it doesn't go through `render.js`'s `el()` guard.

Verified beyond the automated suite (still no browser of my own): a combined mocked-fetch dry run
(jsdom + `_setFetch`/`_setConfig`, not committed) exercising both fixes together — a 500 on the
vote feed alongside all-null-dated terms across two jurisdictions — confirmed identity renders
"MO Senate, district 2 · U.S. House, district 3", the votes section renders `'failed'` with a
working retry button (never the empty message), and sponsorships/freshness still finish rendering
normally around the one failed section.

## Fix round 2 (controller re-smoke after fix round 1)

**Status:** done. **Commit:** `f451edd`. **Tests:** 1382/1382, 0 fail (16 new, all in
`site/js/person-page.js` / `tests/person-page.test.js`).

The controller re-ran the live smoke after fix round 1 and reported the page genuinely good —
the all-affiliations line rendered correctly, votes populated with one-liners, as-stored
positions, and real receipt links (0017 applied, feed now 242ms) — plus 2 more findings.

1. **IMPORTANT — no pagination controls.** Exactly page 1 (50 rows) rendered with no way to reach
   the rest of a ~1,650-cast career. `pagedFetch()` already returns `{rows, total, page,
   pageSize}` (`count=exact` on every request via `rest.js`'s `doFetch`); the missing piece was
   honest navigation built from that. Added to `site/js/person-page.js`:
   - `paginationSummary({page, pageSize, total})` — pure display math
     (`start`/`end`/`hasPrev`/`hasNext`/`pageCount`), including a defensive `total === null`
     fallback (not an expected live path, since `rest.js` always requests `count=exact`) that
     never offers a next page into the unknown, and a `total === 0` degenerate case.
   - `nextVoteFilters(filters, patch)` — the pure "which page are we on" reducer both the filter
     controls and the new Prev/Next buttons go through: any real filter change
     (chamber/year/missedOnly) resets to page 1 (brief: "any filter change resets to page 1"), so
     a stale page number can never survive a filter change and land past the new, smaller result
     set; a *pure* page-only patch (a Prev/Next click) applies directly, clamped to a minimum of
     1. `wireVoteFilters`'s three change handlers were refactored onto this same reducer for
     consistency (previously each hand-set `filters.page = 1` separately).
   - `renderPaginationControls`: "Showing X–Y of Z" (authored text; X/Y/Z come from
     `paginationSummary`) + Prev/Next buttons disabled at bounds. Both buttons call
     `loadVotesSection`'s own `reload` — a small internal refactor that also now backs the
     failed-state retry button, so a pagination-triggered network failure is error-swallowed the
     same way `mountProfile`'s `runVotes()` already is, never an unhandled rejection.
   TDD'd first: 6 `paginationSummary` cases + 5 `nextVoteFilters` cases in
   `tests/person-page.test.js`, all pure/no-DOM math and reducer logic, per the controller's
   explicit scope for this finding.
2. **IMPORTANT — sponsored-bill status renders `'[1]'`/`'[2]'` for MO bills.** The DB stores
   LegiScan's numeric status code for MO bills (a merged-backfill deviation from its own plan — a
   data correction is queued separately with Lance; federal statuses are proper printed strings
   like `'Introduced'`). Per the facts-only rule, the fix belongs in the data, never a client-side
   code→label map (that would be the client inventing a fact). Added `isNumericStatusCode(status)`
   (`/^\d+$/`, type-guarded against non-strings) and gated `renderSponsorships`' status span on
   it: a numeric code is omitted entirely (unintelligible ≠ informative), a real string still
   renders. The predicate's doc comment explicitly frames it as temporary display honesty pending
   the data correction, not a policy stance on what MO statuses mean. TDD'd first: 3
   `isNumericStatusCode` cases + 2 `renderSponsorships` DOM cases (numeric → no `.bill-status`
   span; string → span renders with the text) — `renderSponsorships` exported for the latter.

Verified end-to-end beyond the automated suite (still no browser of my own): a mocked-fetch dry
run (jsdom + `_setFetch`/`_setConfig`, not committed) against a simulated 1,652-cast career
confirmed 50 rows on page 1, "Showing 1–50 of 1652", Prev disabled/Next enabled; clicking the
real Next button DOM element re-queried with `Range: 50-99` and updated to "Showing 51–100 of
1652" with Prev now enabled. A mixed MO-numeric/federal-string sponsorship pair confirmed the
numeric status omitted (no `'[2]'` anywhere in the rendered text) and `'Introduced'` rendered
normally.

## Concerns after fix round 2 (in addition to the ones above, still standing)
- Pagination and the numeric-status guard are both new since the last two live smokes — neither
  has been confirmed against real Supabase data yet. The mocked dry run proves the wiring is
  correct against realistic payload shapes (simulated 1,652-row career, real Range-header
  math), but the real ~1,650-cast Onder pagination and the real MO/federal status mix are still
  only verified live by the controller, not by me.
- `nextVoteFilters`'s "mixed patch" behavior (a patch carrying `page` alongside another filter
  key forces page 1, discarding the given page value) is defensive — no real call site in this
  file ever constructs such a patch (filter changes never include `page`; pagination changes only
  ever include `page`) — but it's asserted directly in case a future caller does.

## Fix round 3 (formal task review, opus, all 5 commits)

**Status:** done. **Commit:** `e1cc62f`. **Tests:** 1399/1399, 0 fail (17 new, all in
`site/js/person-page.js` / `tests/person-page.test.js`).

Verdict: spec PASS with deviations, quality good — but a real findings batch (1 HIGH, 4 MED
including 1 controller ruling, 7 LOW). All fixes landed in `site/js/person-page.js`.

**HIGH-1 — blank section on a render-time throw.** The votes render phase (`sectionState`
`'ready'`, the `renderVoteRow` loop, `renderPaginationControls`) sat OUTSIDE any try — a throw
during rendering (e.g. a hostile/malformed value tripping `render.js`'s attribute guard) escaped
to the swallowing `.catch(() => {})` at the call site, leaving the section CLEARED (by the
`'ready'` paint) and never repainted with anything — no failed message, no retry, genuinely
blank. Fixed by wrapping the whole render phase in try/catch, routing any throw to the same
failed-with-retry path a fetch failure already used. "While there": a single row's malformed/
hostile `source_url` no longer risks the whole section — the receipt `<a>` is wrapped in its own
local try, degrading that ONE row to a "source unavailable" `<span>` instead of propagating.
TDD'd first: a controlled fault-injected throw (a `position` value whose `toString()` throws,
forcing a genuine synchronous throw inside the template-literal interpolation) proves the outer
containment; a mixed hostile/good-url pair proves the per-row isolation (both rows still render,
only the bad one degrades).

**MED-2 (skip != empty) — freshness's false "no data" claim on unknown jurisdictions.**
`loadIdentitySection`'s failure used to degrade to `terms: []` in `mountProfile`'s catch, so
freshness rendered the AFFIRMATIVE `"No freshness data recorded"` claim on jurisdictions it never
actually learned — indistinguishable from a genuinely unlinked, zero-term row. `terms` is now
`null` on identity failure (a real `[]` stays reserved for the genuine case). `loadFreshnessSection`
renders `'failed'` for `terms === null`, and — since freshness owns no fetch of its own that could
ever discover terms — `mountProfile` now bundles identity+freshness into one
`loadIdentityThenFreshness()` so freshness's retry button actually re-triggers identity, not an
inert click. TDD'd first, and additionally verified with a full mocked dry run (not committed):
identity fails → freshness renders `'failed'` (not the false empty claim) → clicking freshness's
retry actually re-runs identity → both recover once the simulated network is fixed.

**MED-3 (skip != empty) — flags-fetch failure silently unflagged everything.** A failed
`public_reconciliation_flags` fetch used to default every row to unflagged with zero indication —
absence of a flag badge IS a claim ("no known discrepancy"). Now renders a visible
`"Reconciliation-flag status unavailable for this page."` notice above the vote list; the rows
themselves still render (flags stay additive to an already-successful votes fetch, per the
existing one-liner precedent).

**MED-4 (CONTROLLER RULING, plan-level).** The flags query gains `resolved=is.false` — an
adjudicated discrepancy is not an open dispute, so only unresolved flags are worth a live badge
on a public page. Comment on the query cites this as a controller ruling, not a local judgment
call.

**MED-5 — filter-change race.** Two in-flight `loadVotesSection` calls (e.g. a user changing
chamber then year before the first request returns) could resolve out of order, letting the
STALE one win the render and leave the vote list mismatched against the currently-selected
filter controls. Added a `voteGeneration` counter object shared BY REFERENCE across every
re-entry path (filter changes via `mountProfile`'s `runVotes`, retries and pagination via the
internal `reload`) — incremented synchronously as the very first statement in `loadVotesSection`
(before any `await`, so no interleaving is possible until this call itself yields), captured as
this call's own token, and checked before every subsequent DOM mutation; a superseded call
returns silently. A caller that omits `voteGeneration` (most direct/test invocations) gets a
private counter and is never stale relative to itself — fully backward compatible. TDD'd with two
calls sharing one counter, deliberately resolved in REVERSE start order to prove the fix tracks
call-start order, not network-resolution order.

**LOWs (7, all cheap, all landed in this round):**
6. `loadIdentitySection`/`loadSponsorshipsSection`/`loadFreshnessSection`'s retry handlers now
   `.catch(() => {})`, matching votes' `reload` — a retry-triggered network failure can no longer
   surface as an unhandled rejection.
7. Documented the accepted "bounded by ≤50 `in.()` ids / one row per source" deviation directly
   on the three `restGet` reads (summaries, flags — both bounded by the 50-row page; freshness —
   one row per source, small fixed cardinality) — these were always correct, just undocumented.
8. `idFromPath` now validates the id segment IS uuid-shaped
   (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`); non-matching → `null` →
   `renderNotFound`. Closes both a filter-injection path (a garbage id flowing straight into
   PostgREST query strings) and an infinite-self-retry-on-garbage path (retrying a doomed lookup
   forever). The existing non-uuid test fixtures (`'abc-123-def'`, `'xyz-789'`) were updated to
   real uuids and the old fixture itself became the dedicated rejection test's regression case.
9. The summaries query orders `published_at.desc.nullslast,created_at.desc` — a tie (or a null
   `published_at`) now breaks on `created_at`, so `buildOneLinerMap`'s "first per bill_id" always
   means the current published version.
10. `loadVotesSection` guards `legislatorIds.length === 0` → the honest empty state, never firing
    an empty `in.()`.
11. `renderPhoto` checks the `https://` scheme BEFORE calling `el()` (not a try/catch after the
    fact), falling to the no-photo state instead of throwing on a non-https or hostile
    `image_url`. Exported for direct testing.
12. `paginationSummary`'s `total === null` branch now derives `end` from an optional `rowsLength`
    param (the actual rows returned), not a padded pageSize assumption — a short final page under
    an unknown total no longer claims more rows exist than really came back. No `rowsLength`
    given falls back to the old full-page assumption (backward compatible).

Verified end-to-end beyond the automated suite (still no browser of my own): a full mocked
`mountProfile` dry run (jsdom + `_setFetch`/`_setConfig`, not committed) against a realistic
Onder-shaped fixture confirmed identity, votes (flags-unavailable notice + a working receipt
link + pagination summary from the real content-range), sponsorships (numeric MO status omitted,
federal string status shown), and freshness (the honest empty state, correctly distinct from the
MED-2 failure state) all render correctly together with no exceptions; a second, separate dry run
specifically exercised the MED-2 recovery path described above.

## Concerns after fix round 3
- This is now the third fix round without a fresh full live-browser re-smoke of ALL of it
  together (pagination + numeric-status + render-phase-containment + freshness-tri-state + flag-
  honesty + the filter race, all in one page load). Each individual fix has mocked-dry-run
  evidence; a live re-smoke would be the first time all of fix rounds 1–3 are exercised together
  against real Supabase data and a real browser.
- The `voteGeneration` counter is scoped to one `mountProfile` call (a fresh object per page
  load/mount) — this is correct for the single-page-at-a-time reality of this site, but it's
  worth stating plainly: it is NOT a page-wide or module-wide singleton, by design.

## Fix round 3 micro-round (re-review, opus, on round 3's own new coupling)

**Status:** done. **Commit:** `871a4f6`. **Tests:** 1405/1405, 0 fail (6 new).

Re-review closed 11/12 of fix round 3's findings (LOW-7 stands as documented-accepted — the
`restGet` deviation comments satisfied it) and surfaced 3 new small items, all introduced by
round 3's own new coupling between identity/freshness/votes.

**NEW-A (MED-LOW) — identity's own retry bypassed the identity+freshness bundle.**
`loadIdentitySection`'s own `catch` installed `onRetry: () => loadIdentitySection(...)` — a bare
self-recursion, not the `loadIdentityThenFreshness` composition fix round 3 built for exactly this
purpose. Reviewer's proven scenario: the terms fetch 500s, both identity and freshness fail; the
user clicks IDENTITY's own retry button (not freshness's); identity recovers, but freshness stays
stranded on `"Couldn't determine this profile's jurisdictions"` forever, despite terms now being
in hand — because nothing ever told freshness to re-check. Fixed: `loadIdentitySection` now takes
a `reload` param supplied by its caller rather than self-recursing on its own narrow inputs;
`mountProfile` passes `loadIdentityThenFreshness` to BOTH identity's and freshness's retry paths,
so either button recovers both sections. TDD'd with real verification discipline: I had already
applied the fix before writing the test (a genuine risk of writing a test that would pass
regardless), so I temporarily reverted `loadIdentitySection`'s `onRetry` back to the old bare
self-recursion, confirmed the new test failed red for the right reason, then restored the fix and
confirmed green. The test reproduces the reviewer's exact scenario end-to-end via `mountProfile`
(both sections start failed, click identity's own retry, assert freshness also recovers).

**NEW-B (LOW) — round 3 accidentally serialized votes behind freshness.** Before round 3:
`terms → votes → … → freshness` (freshness last, blocking nothing). Round 3's MED-2 fix
introduced `loadIdentityThenFreshness`, awaited as one unit before votes ever started — a genuine
but unintended regression: `terms → freshness → votes`, with the page's centerpiece now waiting
on a secondary section's round-trip. Fixed: `mountProfile` awaits identity, then STARTS freshness
(`const freshnessLoad = loadFreshness(terms)`, not awaited yet) before wiring and starting votes;
freshness is only awaited once, at the very end, after sponsorships. Tri-state semantics are
unchanged — freshness still receives exactly `terms`-or-`null` from identity, only its ordering
relative to votes moved. TDD'd with the same discipline as NEW-A: I temporarily reverted
`mountProfile` to fully await `loadIdentityThenFreshness()` before starting votes, confirmed the
new test failed red, then restored the fix. The test defers the mocked `public_freshness`
response indefinitely (a manually-controlled gate promise) and asserts the votes fetch still
fires before freshness's fetch resolves, then releases the gate and confirms freshness still
completes normally — proving nothing was dropped, only the ordering changed.

**NEW-C (cosmetic, both fixed):**
(a) The zero-legislator-rows empty state said `"No recorded votes for this filter."` — the wrong
reason (there's no legislator row to query at all, not a filtered-away result). Now
`"No legislator records are linked to this profile."` Test asserts the new text and the absence
of the old one.
(b) `renderPhoto` carried a private `/^https:\/\//i` regex duplicating a security rule
`render.js` already owns. `render.js` now exports `isSafeSrc(value)` — a non-throwing predicate
that reuses `assertSafeUrlAttr`'s EXACT control-char-stripping/protocol-relative-rejection/
scheme-check logic (not a lookalike copy) — and `renderPhoto` consumes it. Direct tests added in
`tests/site-modules.test.js` alongside the existing `el()` src-guard tests it mirrors.

Verified end-to-end beyond the automated suite (still no browser of my own): a mocked
`bootstrapPersonPage` dry run with a deliberately non-https `image_url` confirmed `renderPhoto`'s
`isSafeSrc`-based guard correctly falls back to the no-photo block via the shared `render.js`
predicate, with identity/votes/freshness all still rendering normally around it.

## Concerns after the micro-round
- All 12 fix-round-3 findings plus these 3 are now closed or accepted-documented (LOW-7). This
  is the fourth round of fixes on this page without a fresh full live-browser re-smoke of
  everything together — a live re-smoke remains the first time fix rounds 1 through 3-micro are
  all exercised together against real Supabase data and a real browser.
- `loadIdentity`/`loadFreshness`/`loadIdentityThenFreshness` are three mutually-referencing
  `function` declarations local to `mountProfile` (hoisted, so definition order doesn't matter)
  — a deliberate structural choice to let the initial mount interleave votes between identity and
  freshness while both retry buttons still share one composition. Flagging the pattern itself
  (three closures referencing each other) as slightly more intricate than the rest of this file's
  style, in case a future maintainer wants to simplify it once the underlying requirements
  settle.
