# Directory "Serving now / Past members" split — design

**Status:** approved design (Lance, 2026-08-06 — layout "Toggle, default Current", labels
"Serving now / Past members", year filter dropped; full build authorized same day: *"Yes, proceed
with the full build."*)
**Parent request:** Lance, 2026-08-05 — *"The website needs to be able to filter the long ass list
of names"* → refined 2026-08-06 to *"Rather than filters we should just make a 'Current Members'
and 'Past Members' lists?"*
**Prerequisite (DONE):** the MO term-date backfill
(`docs/superpowers/specs/2026-08-06-mo-current-term-dates-backfill-design.md`) — 192/194 current-MO
terms now dated, enabling tenure display this spec adds to the original approval.

---

## 1. Problem

The directory (site homepage) renders every person/legislator as ONE long alphabetical list
(~1,000+ entries). A visitor looking for their *current* representative scrolls past decades of
departed members. The existing text filter helps only if you already know the name.

## 2. The design (approved)

A two-state segmented toggle above the list; the page **opens on "Serving now"**:

```
Directory  [ search names ]
( ● Serving now (N) )  ( Past members (N) )
  ⓘ no recorded end date — the honest signal a term is still open
──────────────────────────────────────────
Adams, Jane — MO House · district 29 · D · since 2023
Baker, Bob  — US Senate · MO · R · since 2019
...
```

- **Partition rule (the honesty-compatible definition):** an entry is *Serving now* iff **any** of
  its terms has `end_date == null` (an open term is the data literally saying "not ended"). An
  entry whose every term is ended → *Past members*. An entry with **zero** terms → *Past members*
  (we cannot prove service; defaulting unknowns into "Serving now" would over-claim).
- **Labels:** exactly "Serving now" and "Past members". The word **"current" never appears** in the
  UI (currency-honesty law). The ⓘ footnote reads: *"no recorded end date — the honest signal a
  term is still open."*
- **Toggle badges** show the full partition counts; the name search narrows the rows shown in the
  active view but never changes the badge numbers.
- **Name search:** the existing `filterDirectory` text box is unchanged and applies within the
  active view only.
- **Tenure fragment (new since the original approval — enabled by the backfill):** a *Serving now*
  entry whose displayed anchor term (`mostRecentDatedTerm`) is itself open gains a trailing
  `· since YYYY` (year of that term's `start_date`). No dated open term → no fragment (never
  guessed). *Past members* entries get no tenure fragment (their profiles carry the full span).
- **No year filter, no sort options** — explicitly dropped by Lance.

## 3. Live-data verifications baked into this design (2026-08-06)

- **Onder causes no contradiction.** All four Onder legislator rows share `person_id 209cc21e`, so
  he renders as ONE entry; his `mostRecentDatedTerm` is the open federal `us-congress house D3`
  (2025-01-03–), so his entry displays **US House · 3 · since 2025** in *Serving now* — which is
  true (he is a sitting US Rep). His parked, dateless MO-Senate-D2 row is invisible to the display
  logic (undated terms are never the anchor) and Schroer alone shows Senate D2. No special-case
  code is needed or permitted.
- **Brown (MO House 149)** has an open-but-undated term and real 2026 votes → *Serving now* with no
  `since` fragment. Correct on both counts.
- Open terms live: 537 dated federal + 192 dated MO + 2 undated MO — the partition thresholds
  nothing on dates, only on `end_date == null`, so all of these classify as *Serving now*.

## 4. Architecture (follows `site/js/directory-page.js`'s existing pure-model → DOM split)

**Pure model (extend `directory-page.js`, TDD in `tests/directory-model.test.js`):**
- `buildDirectoryEntries` gains one derived field per entry: `servingNow: boolean` — true iff any
  of the group's terms has `end_date == null`. It also carries `sinceYear: number|null` — the
  4-digit year of `mostRecentDatedTerm(...).start_date` when that anchor term is open, else null.
- New `partitionDirectory(entries) -> { servingNow: [...], past: [...] }` — stable, order-preserving
  (entries are already surname-sorted).
- `filterDirectory` unchanged, reused per-view.

**View state / DOM (same file):**
- The toggle is two `<button>`s in a segmented control; a small controller tracks
  `activeView: 'serving' | 'past'` (default `'serving'`) plus the existing search text; any change
  re-renders `filterDirectory(partition[activeView], query)` through the existing
  `renderDirectoryList` + `sectionState` empty/ready discipline (an empty result shows the honest
  "no legislators match" state, never a blank).
- `renderDirectoryList`'s meta line gains the `· since YYYY` fragment when `entry.servingNow` and
  `entry.sinceYear` are both present.
- `site/index.html`: the toggle buttons + footnote markup above the existing `#directory-filter`.
- `site/css/…` (the site's existing stylesheet): segmented-control styles + footnote styling —
  match the site's existing look; no new framework, no new deps.

## 5. Honesty rules binding this feature

- "current"/"present" never rendered; "Serving now" + the open-term footnote is the ceiling of the
  claim.
- `sinceYear` only from a real `start_date` on the anchor open term; absent → omitted.
- Zero-term entries → *Past members* (never promoted without evidence).
- No client-side data mutation; the partition is a pure function of already-fetched rows (no new
  network calls — `terms` with `start_date/end_date` is already in `loadDirectoryData`).

## 6. Testing

Extend `tests/directory-model.test.js` (node:test conventions, pure functions only):
- `servingNow` derivation: open term → true; all-ended → false; zero terms → false; merged person
  with one open + one ended → true.
- `sinceYear`: open dated anchor → year; open undated anchor (the Brown case: servingNow true, no
  dated term at all) → null; ended anchor → null even when some other undated term is open (the
  fragment only ever describes the anchor term the entry displays).
- The Onder construction (regression, from live data): four rows one person, open dated federal +
  open undated MO → ONE entry, `servingNow: true`, anchor = federal, `sinceYear: 2025`.
- `partitionDirectory`: split correctness, order preservation, empty-input safety.
- Composition: search within a partition (filterDirectory over partition output).
- DOM wiring is covered by the existing site-modules smoke conventions (import-safe, no top-level
  DOM access) — match whatever `tests/site-modules.test.js` already asserts for this file.

## 7. Rollout

Pure front-end change: branch → TDD → review → merge → push; Cloudflare Pages auto-deploys on
push. Post-deploy: verify in a real browser (toggle both views, search within each, Onder shows US
House D3 in Serving now, Schroer alone on Senate D2, a `since` fragment renders, footnote wording
exact). No DB, no schema, no CSP, no new dependencies.
