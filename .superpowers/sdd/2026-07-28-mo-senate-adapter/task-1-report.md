# Task 1 report — MO Senate live fixture capture (research-budgeted)

**Date:** 2026-07-28. **Budget:** <=14 HTTP requests, >=2s spacing, UA
`VisibleGov research (contact: repo owner)`. **Used: 12 requests** (6 hits, 6 misses/probes).
All requests went to `www.senate.mo.gov`; no other host was touched; no DB/model calls made.
"Current year" for this capture = 2026.

## Full request log

| # | Time (local) | URL | Status | Bytes | Note |
|---|---|---|---|---|---|
| 1 | 13:22 | `https://www.senate.mo.gov/journallist/` | 200 | 130,712 | journal index, defaults to current year (2026) |
| 2 | 13:23 | `https://www.senate.mo.gov/journallist/?SelectedYear=2018` | 200 | 166,115 | journal index, 2018 |
| 3 | 13:24 | `https://www.senate.mo.gov/18info/SenateRoster.htm` | 404 | 1,245 | roster-2018 candidate 1 (plan's guess) — miss |
| 4 | 13:24 | `https://www.senate.mo.gov/18info/senalpha.htm` | 404 | 1,245 | roster-2018 candidate 2 (plan's guess) — miss |
| 5 | 13:25 | `https://www.senate.mo.gov/18info/` | 403 | 1,233 | roster-2018 candidate 3: archive landing page to scan for a members link — forbidden, no directory listing exists |
| 6 | 13:25 | `https://www.senate.mo.gov/Senators/` | 200 | 36,029 | live current-session roster (found via nav link already in `sb834-2026-billinformation.html`) |
| 7 | 13:26 | `https://www.senate.mo.gov/18info/senators.htm` | 404 | 1,245 | roster-2018, own reasoned guess — miss |
| 8 | 13:27 | `https://www.senate.mo.gov/18info/members.htm` | 404 | 1,245 | roster-2018, own reasoned guess — miss |
| 9 | 13:27 | `https://www.senate.mo.gov/18info/index.htm` | 404 | 1,245 | roster-2018, second landing-page attempt — miss |
| 10 | 13:27 | `https://www.senate.mo.gov/26info/Journals/RDay6905211890-1891.pdf` | 200 | 168,324 | smallest ("quiet") 2026 journal day (Day 69, 2 pages) — contained zero roll-call votes, not usable, superseded |
| 11 | 13:28 | `https://www.senate.mo.gov/26info/Journals/RDay470409900-906.pdf` | 200 | 204,747 | next-smallest 2026 day (Day 47, 7 pages) — also zero roll-call votes, superseded |
| 12 | 13:29 | `https://www.senate.mo.gov/26info/pdf-jrnl/DAY39.pdf` | 200 | 269,498 | 2026 Day 39 (23 pages) — known via existing `sb834-2026-actions-fragment.html` citation to contain a real vote; **this is the committed fixture** |

6 successes, 6 misses/probes (4x 404 on genuine roster-2018 guesses, 1x 403 on a landing-page probe
that isn't itself a guessed target, 1x superseded PDF that wasn't wasted — its 404/200 status was
informative either way). 2 requests (#10, #11) were fetched, read, and found unsuitable (no votes)
before landing on #12 as the real deliverable; they are logged here for honesty but not committed
as fixtures since the brief calls for one PDF file.

## Fixtures produced

All under `tests/fixtures/research/mo-senate/`:

- **`journallist-current.html`** (from request #1, 130,712 bytes) — the journal index page,
  defaults to 2026 with no query param needed.
- **`journallist-2018.html`** (from request #2, 166,115 bytes) — same page with
  `?SelectedYear=2018`.
- **`roster-current.html`** (from request #6, 36,029 bytes) — the live Blazor app's current-session
  senator grid.
- **`2026-day39-journal.pdf`** (from request #12, 269,498 bytes, 23 pages) — a non-2018 journal
  day containing 10 real recorded roll-call votes.
- **`roster-2018.html` — NOT produced.** Genuine miss; see below.

`tests/fixtures/research/SOURCES.md` was appended with a dated subsection under the existing
`mo-senate/` heading documenting each file above plus the miss, in the same style as the section's
existing entries.

## Structure notes for the parser-writer

**Journal index (`journallist-current.html` / `journallist-2018.html`):** each day is rendered as
a `.journal-entry-card` div:
```html
<div class="w-100 journal-entry-card">
  <div class="d-flex justify-content-between align-items-center">
    <h6 class="mb-0"><strong>Day 37</strong></h6>
    <p class="mb-0 no-wrap"><strong>3/8/2018</strong></p>
  </div>
  <div class="... summary-card" data-pages="587-610"></div>
  <div class="d-flex justify-content-between">
    <button class="... preview-button ..." data-filename="/18info/Journals/RDay370308587-610.pdf" data-extension=".pdf">Preview Journal</button>
    <a href="/18info/Journals/RDay370308587-610.pdf" class="..." target="_blank">Open PDF</a>
  </div>
</div>
```
Day number, date, printed page range, and PDF URL (duplicated in a `data-filename` attribute and a
plain `<a href>`) are all present per card — cheap to scrape. Year selection is a real GET form
(`<form method="get" id="yearForm">`, `<select name="SelectedYear">`), so
`journallist/?SelectedYear=<Y>` is a stable, directly-constructible URL for any year 1996-2026
(full option list observed in the page).

**Correction to the plan's URL guesses:** the journal-index page's PDF links use
`/<yy>info/Journals/RDay<NN><MMDD><startpage>-<endpage>.pdf` — a *different* naming scheme than
the already-verified `/<yy>info/pdf-jrnl/DAY<NN>.pdf` short form used by the BillTracking
Actions-fragment journal citations (e.g. `sb834-2026-actions-fragment.html`'s
`.../DAY39.pdf#page=2`). Cross-checked: Day 37 in the 2018 index (`RDay370308587-610.pdf`) is
confirmably the same calendar day (3/8/2018) and page range (587 start) as the already-captured
`2018-day37-journal-onder-era.pdf` (fetched via the short `DAY37.pdf` form in the original
investigation). **Both schemes are live and appear to serve the same underlying content** — a
parser should prefer the short `pdf-jrnl/DAY<NN>.pdf` form since it's what bill-Actions citations
already use directly, without needing to scrape the index page's page-range/date metadata first.

**Roster (`roster-current.html`):** the live app's `/Senators/` page is a card grid, one
`<a>` per senator:
```html
<a href="https://www.senate.mo.gov/Senators/Member?id=2" aria-label="View Senator Jason Bean details page" ...>
  <div class="card card--with-footer">
    <div class="card__body"><img src=".../SenatorPortraits/Bean25.jpg" class="senator-img" alt="Senator Jason Bean"></div>
    <div class="card__footer" ...>Senator Jason Bean <br/> District 25</div>
  </div>
</a>
```
Name (first + last) and district are both present as plain text; **no party is printed anywhere on
this page** — confirmed absent (`(R)`/`(D)`/`Republican`/`Democrat` all grep to zero hits). A
parser needing party has to go elsewhere (untested candidate: the per-member `Member?id=N` page).
34 cards total: 33 named senators + one `Vacant Vacant` placeholder (district 10 currently vacant),
districts 1-34 all present, no gaps/dupes — confirms the 34-seat chamber. This page is **not**
year/session-parameterized — it's the live app's current-membership view only, with no observed
historical mode.

**Roll-call vote blocks (`2026-day39-journal.pdf`):** format is byte-for-byte structurally
identical to the already-captured 2018 fixture:
```
On motion of Senator <X>, <bill> was read the 3rd time and passed by the following vote:
YEAS—Senators
<surname> <surname> ...—<count>
NAYS—Senators[—None | <surname> ...—<count>]
Absent—Senators[—None | <surname> ...—<count>]
Absent with leave—Senator[s][—None | <surname> ...—<count>]
Vacancies—None
```
This one 23-page day contains 10 separately anchored votes ("...read the 3rd time and passed by
the following vote:" plus one "emergency clause was adopted by the following vote:" variant) —
confirms multiple motion-phrase anchors are needed, not just the third-reading one. **New finding
not present in the single 2018 day sampled previously:** surname collisions are real and are
disambiguated with a parenthesized district number, e.g. `Brown (16)` vs `Brown (26)`,
`Gregory (15)` vs `Gregory (21)`, appearing in both the daily attendance roll and vote-block name
lists. The earlier research doc's claim that "no collisions were observed" reflected only the one
2018 day sampled, not a general property — the parser must handle `SURNAME (DISTRICT)` as a valid
name-list token, not just bare surnames.

## The original miss: `roster-2018.html` (live senate.mo.gov) — now resolved via Wayback

Live senate.mo.gov never yielded a 2018 roster. Five distinct URLs were tried, all within the
brief's stated candidate list plus a small number of reasoned follow-ups, all failed:

1. `/18info/SenateRoster.htm` (plan's candidate 1) — 404
2. `/18info/senalpha.htm` (plan's candidate 2) — 404
3. `/18info/` as a landing page to scan for a members link (an attempt at the plan's candidate 3,
   "the members page linked from the year's archive landing page") — 403 Forbidden, no directory
   listing exists, so there was no page to scan
4. `/18info/senators.htm` — 404
5. `/18info/members.htm` — 404
6. `/18info/index.htm` (second landing-page attempt) — 404

Stopped there per the brief's explicit instruction not to brute-force past budget, and reported the
miss. **The controller then approved a bounded (<=8 request) follow-up against web.archive.org
(the Wayback Machine)** — the one authorized additional host — to look for an *archived* copy of
whatever 2018 roster artifact senate.mo.gov used to serve. That follow-up succeeded; see below.

## Wayback Machine follow-up (approved extension)

**5 of 8 budgeted requests used**, all to `web.archive.org`, same UA, >=2s spacing:

| # | URL | Status | Bytes | Note |
|---|---|---|---|---|
| 1 | `https://web.archive.org/cdx/search/cdx?url=senate.mo.gov/18info/*&output=json&limit=1000&collapse=urlkey&matchType=prefix` | 200 | 3 | empty `[]` — combining a trailing `*` with an explicit `matchType=prefix` param produced no results; encoding mistake, not a real miss |
| 2 | `https://web.archive.org/cdx/search/cdx?url=senate.mo.gov%2F18info%2F*&output=json&limit=1000&collapse=urlkey` | 200 | 234,479 | corrected query, 1000 rows returned (result set truncated mid-alphabet by the `limit`, sorted by urlkey) |
| 3 | CDX query with a regex filter restricting to root-level `/18info/*` files only | 200 | 171,950 | 756 rows — still noisy, query-string variants share the same path depth as the regex intended to isolate |
| 4 | CDX query with `filter=original:(?i).*(roster\|senalpha\|alpha\|senator\|member\|biog\|directory).*` across the whole `/18info/*` tree | 200 | 12,108 | 61 rows — **this found the target**: `2018Roster.pdf`, `2018SenateRoster.xlsx`, plus a set of individual per-senator `members/d<NN>/...` and `members/mem<NN>.htm` pages (bio pages, not a roster) |
| 5 | `https://web.archive.org/web/20250311182418id_/https://www.senate.mo.gov/18info/2018Roster.pdf` | 200 | 51,017 | the actual snapshot fetch — **committed as `roster-2018-wayback.pdf`** |

**Result: `roster-2018-wayback.pdf` (not `.html`)** — the entire `/18info/` tree was searched by
keyword regex (not just plausible HTML filenames), and the only consolidated all-senators roster
artifacts that exist are a PDF (`2018Roster.pdf`) and an Excel file (`2018SenateRoster.xlsx`); no
HTML roster page was ever served at this URL tree. The PDF was fetched (the Excel file wasn't —
redundant, would have cost budget without adding information). **Authenticity check:** the
Wayback response's `x-archive-orig-last-modified` header reads `Tue, 09 Jan 2018 19:29:38 GMT`,
which matches the "Rev. 1/8/18" date printed on the document itself — confirms this is the genuine
original 2018 file (unchanged on the origin server from Jan 2018 until IA's March 2025 crawl), not
a reconstruction.

**Onder district 2 — VERIFIED.** The document is a phone/room staff directory, title "MISSOURI
SENATE - 99TH GENERAL ASSEMBLY", one entry per senator:
```
ONDER, BOB–2. . . . . . . . . . . . . . . 331. . . . . . . . . . 751-1282
  Internal Number. . . . . . . . . . . . . . . . . . . . . . . . . . 3020
  Amanda Bell, Theckla Spainhower
```
`SURNAME, FIRSTNAME–DISTRICT` as the entry header, then Room, Phone, an internal extension, and
staff names. No party affiliation is printed anywhere in the document (grepped, absent — same
finding as `roster-current.html`).

**Markup/parse-shape difference for the parser-writer:** `roster-current.html` is DOM/CSS-selector
scraping (`Senator FIRST LAST <br/> District NN` text inside `.card__footer` divs — see the
"Structure notes" section above). `roster-2018-wayback.pdf` is **text-layer PDF extraction**
against a `SURNAME, FIRSTNAME–DISTRICT` line-header pattern (comma between surname/first name, en
dash before the district number, then dot-leader padding before room/phone columns) — a
structurally different parser, not a variant of the same one. Any code resolving historical vs.
current MO Senate rosters needs two independent parse branches (HTML DOM for the live app,
PDF-text-regex for archived-era directories), not one shared schema.

## Roster counts observed

- **2026 (current):** 34 seats total — 33 named senators + 1 vacancy (district 10). Districts
  1-34 all present, no gaps or duplicates confirmed by cross-checking image-alt count against
  district-number count.
- **2018 (via Wayback):** 34 seats total — 33 named senators + 1 vacancy (`VACANT–17`). Matches
  the 34-seat chamber size observed in the 2026 roster. Independently corroborated by
  `2018-day37-journal-onder-era.pdf`'s daily roll for a different day that same session (31
  present + 2 absent-with-leave + 1 vacancy = 34), though that's an attendance count, not a
  roster.
