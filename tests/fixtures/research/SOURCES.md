# Research fixtures — provenance

Captured 2026-07-27 for `docs/research/2026-07-27-mo-data-sources.md` (Task 9, slice-2 plan).
These are NOT consumed by any test — they are raw evidence backing the findings doc's
VERIFIED-BY-PAYLOAD claims. Re-fetch the URLs below to reproduce.

## legiscan/

No LegiScan API key was available (registration is interactive; out of scope for this task —
see findings doc). Nothing here is a live LegiScan API response. All three files are LegiScan's
own publicly downloadable (no-auth) developer resources from `api.legiscan.com`, which sits
outside the Cloudflare bot-check that blocks automated fetches of the main `legiscan.com` site.

- `legiscan-current.tar.gz` — official PHP API client, fetched from
  `https://api.legiscan.com/dl/legiscan-current.tar.gz`. Contains `legiscan/LegiScan.php` (the
  real operation implementations — `getBillText`, `getRollCall`, etc. — and the `processBillText`
  / `processRollCall` payload-parsing code that reveals actual JSON field names), and
  `legiscan/schema-mysql.sql` (the `ls_bill_text`, `ls_bill_vote`, `ls_bill_vote_detail`,
  `ls_mime_type` table definitions + seed data, which is where the mime-type list and the
  Yea/Nay/Not Voting/Absent vote-code list live).
- `ChangeLog` — from `https://api.legiscan.com/dl/ChangeLog`.
- `LegiScan_API_User_Manual.pdf` — "Revision 20250317 LegiScan API v1.91", from
  `https://api.legiscan.com/dl/LegiScan_API_User_Manual.pdf`.

## mo-house-xml/

All fetched directly and live from `documents.house.mo.gov` (no auth, no key) on 2026-07-27.
This is the Missouri House's own no-auth XML export system (session 261 = 2026 2nd regular,
103rd General Assembly).

- `xml-bill-list-instructions-doc.html` — raw HTML of
  `https://documents.house.mo.gov/XMLBillList.html` (ToU/rate-limit language, `BillList.XML`
  schema).
- `xml-bill-exports-schema-doc.html` — raw HTML of
  `https://documents.house.mo.gov/XMLBillExports.html` (full per-bill XML schema, incl. the
  `Action > RollCall` and `RollCallPDF` elements).
- `session-set.js` — `https://documents.house.mo.gov/SessionSet.js`, the script that builds the
  real XML URLs (`https://documents.house.mo.gov/xml/261-*.XML`) — the doc pages themselves
  populate these via JS `onload`, so the literal URL isn't in the static HTML.
- `bill-list-sample-truncated.xml` — first 20KB of a live fetch of
  `https://documents.house.mo.gov/xml/261-BillList.XML` (full file was 537,211 bytes).
- `member-list-sample-truncated.xml` — first 8KB of a live fetch of
  `https://documents.house.mo.gov/xml/261-MemberList.XML` (full file was 38,157 bytes).
- `HB2-bill-text-pdf-only.xml` — live fetch of `https://documents.house.mo.gov/xml/261-HB2.xml`.
  Shows `BillTextLink` pointing at a `.pdf`, never HTML/text.
- `HB1800-with-rollcall-tallies.xml` — live fetch of
  `https://documents.house.mo.gov/xml/261-HB1800.xml`. Shows an `Action > RollCall` block with
  only `TotalYes`/`TotalNo`/`TotalPresent` (aggregate, no individual votes), and a
  `RollCallPDF` link to the underlying vote-detail PDF.
- `rollcall-034.008.pdf` — live fetch of
  `https://documents.house.mo.gov/billtracking/bills261/rollcalls/034.008.pdf` (the
  `RollCallPDF` link found in HB1800's XML). **Confirmed text-layer PDF, not a scanned image** —
  lists every House member's surname with a Y/N/P/@ vote code in a 4-column layout. This is the
  actual individual-vote primary source; it is machine-parseable (PDF text extraction, not OCR),
  just not JSON/XML.
- `representative-107.xml` — live fetch of `https://documents.house.mo.gov/xml/261-107.xml`
  (Rep. Mark Matthiesen, district 107 — the sponsor of HB1800, whose surname MATTHIESEN appears
  in the roll call PDF above). Shows the full-name/district/party record needed to resolve a
  roll-call PDF's bare surname back to a real legislator identity.

## mo-senate/

Captured 2026-07-28 for `docs/research/2026-07-28-mo-senate-sources.md` (MO Senate source
investigation, sibling to the House doc above). All fetched directly and live from
`www.senate.mo.gov` (no auth, no key) via `curl` with a self-identifying User-Agent
(`VisibleGov-research/1.0 ... contact lancemccarter1316@hotmail.com`), ≥2s apart. `senate.mo.gov`
runs an ASP.NET Core/Blazor site (`BillTracking` app) — most content is server-rendered HTML, with
a handful of sub-pages loaded via same-origin `fetch()` calls into a JS modal (the `handler=...`
query-param endpoints below), which are themselves plain HTTP GETs fetchable directly with curl
(no headless browser needed).

- `sb834-2026-billinformation.html` + `.headers.txt` — live fetch of
  `https://www.senate.mo.gov/BillTracking/Bills/BillInformation?year=2026&billid=416` (SB 834,
  2026 regular session, signed by governor). Full page shell: bill details, sponsor, committee,
  and the "Quick Links" buttons whose `data-modal-url` attributes are the real per-bill sub-page
  URLs (`handler=BillText`, `handler=Actions`, `handler=Summaries`, `handler=FiscalNotes`,
  `handler=Amendments`, `handler=CommitteeMinutes`). Response headers show
  `Access-Control-Allow-Origin: *` (CORS wide open) and no `X-RateLimit-*` header of any kind.
- `sb834-2026-actions-fragment.html` — live fetch of the Actions handler URL for the same bill
  (`.../BillInformation?year=2026&billId=416&billPrefix=SB&billSuffix=834&handler=Actions`). Full
  action history table: every action has a Date + Action-text + a `Journal` cell linking straight
  to a specific page anchor (`#page=N`) inside that day's full Senate or House Journal PDF (e.g.
  `https://www.senate.mo.gov/26info/pdf-jrnl/DAY39.pdf#page=2`). No vote tally of any kind is ever
  printed in this HTML — the journal PDF is the only place a roll call's actual numbers/names
  live.
- `sb894-2018-onder-era-actions-fragment.html` — live fetch of the same Actions handler for SB
  894 (2018 regular session, sponsor Sen. Libla; billid `71289930`), i.e.
  `.../BillInformation?year=2018&billId=71289930&billPrefix=SB&billSuffix=894&handler=Actions`.
  Proves the identical `handler=Actions` mechanism, identical journal-citation format, works for
  a bill from squarely inside Bob Onder's Missouri Senate term (2015-01-07 to 2023-01-04) — not
  just the current session.
- `find-voting-records.html` — live fetch of
  `https://www.senate.mo.gov/BillTracking/FindVoterRecords/`, the Senate's own plain-English
  instructions for finding a vote. Quoted directly in the findings doc: confirms votes live only
  in the Journal PDFs, and that year-by-year bill archives exist starting at 2015, with
  everything earlier bundled into a single "2015 and earlier" option.
- `sb834-2026-billtext-fragment.html` — live fetch of the BillText handler for SB 834
  (`handler=BillText`). Confirms bill text is PDF-only (three PDF links: Truly Agreed To/Finally
  Passed, Perfected, Introduced), and carries the verbatim disclaimer quoted in the findings doc:
  "These Bills are not official copies and should not be quoted or cited. The official copy is
  the paper copy, which may be obtained from the Senate Bill Room."
- `2018-day37-journal-onder-era.pdf` — live fetch of
  `https://www.senate.mo.gov/18info/pdf-jrnl/DAY37.pdf` (Thirty-Seventh Day, Thursday, March 8,
  2018 — the day SB 894's "S Third Read and Passed" action, cited as journal page S592, actually
  happened). **Confirmed text-layer PDF, not scanned** — extracted cleanly via the Read tool with
  no OCR. Page 587 lists the day's full Present/Absent senator roll (Onder present, 31 senators,
  1 vacancy). Pages 588-597 contain **exactly 13 separate named roll-call votes** in that single
  day's journal, each formatted as `YEAS—Senators` / `NAYS—Senators` / `Absent—Senators` /
  `Absent with leave—Senators` / `Vacancies—N`, with a trailing count after the last name in each
  list (e.g. `Wieland—28`). Names are printed as bare surnames (same granularity as the House's
  roll-call PDFs, not full names). Bob Onder's surname appears in every YEAS list on this page
  range (he was Chairman of the Committee on General Laws that session). This is the real,
  individual, named MO Senate roll-call primary source — one document per **day**, not per **vote** (unlike
  the House's one-PDF-per-roll-call `RollCallPDF`), with several to a few dozen votes embedded in
  each day's file depending on floor activity that day.

**2026-07-28, Task 1 of the MO Senate adapter plan** (`.superpowers/sdd/2026-07-28-mo-senate-adapter/`):
a second, bounded (<=14 request) live capture pass to get roster + journal-index fixtures the
above investigation didn't fetch. 12 requests total, all from `www.senate.mo.gov`, self-identifying
User-Agent `VisibleGov research (contact: repo owner)`, >=2s apart (full request log in
`task-1-report.md` in that plan folder). "Current year" = 2026 (today's date).

- `journallist-current.html` — live fetch of `https://www.senate.mo.gov/journallist/` (200,
  130,712 bytes). Confirms this page is real and defaults to the current year (2026, "Second
  Regular Session") without any query param. **Markup shape for a parser:** each day is a
  `.journal-entry-card` div containing `<h6><strong>Day N</strong></h6>` + `<p><strong>M/D/YYYY</strong></p>`,
  a `data-pages="<start>-<end>"` attribute giving the printed page range, and the PDF URL in two
  places — a `data-filename="..."` attribute on a "Preview Journal" button and a plain
  `<a href="..." target="_blank">Open PDF</a>` ("Open PDF" text). 70 day-cards found for 2026 (as
  of this capture, session ongoing). Year selection is a real `<form method="get" id="yearForm">`
  with a `<select name="SelectedYear">` (`onchange="clearHashAndSubmit();"`, i.e. GET-resubmits the
  same URL with a `SelectedYear` query param) — years 1996-2026 all listed as options.
- `journallist-2018.html` — live fetch of `https://www.senate.mo.gov/journallist/?SelectedYear=2018`
  (200, 166,115 bytes). Confirms the year-selector query param works and correctly reflects 2018
  (`<option selected>2018</option>`, 88 PDF links under `/18info/Journals/`). **Correction to the
  plan:** this page's PDF links use a *different* URL/naming scheme than the already-verified
  `/18info/pdf-jrnl/DAY37.pdf` — here it's `/18info/Journals/RDay<NN><MMDD><startpage>-<endpage>.pdf`,
  e.g. Day 37 is `/18info/Journals/RDay370308587-610.pdf` (confirmed same calendar day, 3/8/2018,
  as the already-captured `2018-day37-journal-onder-era.pdf`, and the printed page-range prefix
  `587-610` matches that fixture's own page 587 start). **Both URL schemes appear to be live,
  parallel paths to (at least materially) the same content** — `/<yy>info/pdf-jrnl/DAY<NN>.pdf`
  (short form, used by the BillTracking Actions-fragment journal citations) and
  `/<yy>info/Journals/RDay<NN><MMDD><pages>.pdf` (long form, used by the `journallist/` index UI).
  A parser has two independent ways to construct the same fetch; the short form is preferable since
  it doesn't require scraping page-range/date metadata first.
- `roster-current.html` — live fetch of `https://www.senate.mo.gov/Senators/` (200, 36,029 bytes),
  found via a nav link (`Senators/Member?id=9`) already present in
  `sb834-2026-billinformation.html`. This is the live Blazor app's member grid for the **current**
  (103rd) General Assembly only — confirmed NOT year/session-parameterized (no historical-roster
  capability observed). **Markup shape:** each senator is
  `<a href="https://www.senate.mo.gov/Senators/Member?id=N" aria-label="View Senator FIRST LAST details page">`
  wrapping a card with `<img ... alt="Senator FIRST LAST">` and a footer div reading
  `Senator FIRST LAST <br/> District NN`. **34 cards total** (33 named senators + one
  `Vacant Vacant` placeholder for district 10, i.e. Missouri Senate = 34 seats, 1 vacancy as of this
  capture), districts 1-34 all present with no gaps or duplicates. **No party affiliation is
  printed anywhere on this page** (`(R)`/`(D)`/`Republican`/`Democrat` all absent) — a parser
  needing party will have to get it from a different page (e.g. the per-member `Member?id=N` page,
  not fetched in this task) or a non-Senate source. District 2 (Bob Onder's former seat) is
  currently held by Nick Schroer, not Onder — expected, since Onder's Senate term ended
  2023-01-04, confirming district numbers are stable single-member seats, not renumbered per
  session.
- **`roster-2018.html` — MISS, not captured.** Five distinct URLs were tried and all failed within
  budget: `/18info/SenateRoster.htm` (404), `/18info/senalpha.htm` (404, both the plan's own
  candidates), `/18info/` itself as a landing page to scan for a members link (403 Forbidden — no
  directory listing, so this candidate-discovery strategy doesn't work), and two more reasoned
  guesses, `/18info/senators.htm` and `/18info/members.htm` (both 404), plus `/18info/index.htm`
  as a second landing-page attempt (404). No working 2018-era roster/member-listing URL was found.
  **Consequence: the "Onder = district 2" verification could not be performed against a roster
  fixture** — the already-captured `2018-day37-journal-onder-era.pdf` confirms Onder's *surname*
  appears in the daily Present roll and multiple YEAS lists for that day, but the daily roll
  format prints bare surnames only, no district numbers (same finding as the 2026 journal PDFs
  below), so it cannot independently corroborate district 2 either. A future task should either
  budget a fresh, larger search for the 2018 roster's real URL, or fall back to a non-Senate
  source (e.g. Wikipedia/Ballotpedia) for historical district assignment, out of scope for this
  no-other-hosts research task.
- `2026-day39-journal.pdf` — live fetch of `https://www.senate.mo.gov/26info/pdf-jrnl/DAY39.pdf`
  (200, 269,498 bytes, 23 pages). Chosen deliberately over a genuinely "quiet" day: Day 69
  (5/21/2026, 2 pages, `/26info/Journals/RDay6905211890-1891.pdf`) was fetched first as the
  smallest day on the 2026 index, but it turned out to contain **zero** roll-call votes (just
  resolutions/adjournment) — useless for the stated purpose of confirming the vote-block format.
  DAY39 was picked instead because it's independently known (via the already-captured
  `sb834-2026-actions-fragment.html`, whose "S Third Read and Passed" action for SB 834 cites
  `DAY39.pdf#page=2`, journal page S773-774) to contain a real recorded vote. Confirmed
  text-layer, no OCR: **10 separate roll-call votes** on this one day (SS for SB 834, SB 1119, SS
  for SCS for SB 1383, SCS for SB 959, SS for SCS for SBs 907/1154/1272, SS for SCS for SBs
  1066/1088, SS for SJR 87, SS for SB 1421 [bill + a separate emergency-clause vote], SB 945, SS
  for SCS for SB 1015), format **identical** to the 2018 fixture's
  `YEAS—Senators` / `NAYS—Senators` / `Absent—Senators` / `Absent with leave—Senators` /
  `Vacancies—N` blocks with a trailing `—<count>` tally — confirms the vote-block format is stable
  across at least 2018-2026. **New finding not in the 2018 sample:** the daily Present roll and
  bill-sponsor lines do show surname collisions here, disambiguated with a parenthesized district
  number, e.g. `Brown (16)` vs `Brown (26)`, `Gregory (15)` vs `Gregory (21)` — the research doc's
  earlier claim that "no surname collisions were observed" was an artifact of the one 2018 day
  sampled, not a general property; a parser must handle the `SURNAME (DISTRICT)` disambiguated
  form, not just bare surnames, in both the attendance roll and vote-block name lists.
- Also fetched but not committed as fixtures (logged for completeness/honesty): `/18info/` and
  `/18info/index.htm` (403/404 landing-page probes, see roster-2018 miss above), and
  `/26info/Journals/RDay6905211890-1891.pdf` (the vote-free "quiet day" superseded by DAY39.pdf
  above) and `/26info/Journals/RDay470409900-906.pdf` (Day 47, 4/9/2026, 7 pages — an intermediate
  attempt that also turned out vote-free, superseded by DAY39.pdf).

## uscode/

Captured 2026-07-28 for Task 2 of the glossary implementation plan (US Code fetcher). All fetched
directly and live from `uscode.house.gov` (the Office of Law Revision Counsel's site; no auth, no
key) via `curl` with a self-identifying User-Agent
(`VisibleGov-research/1.0 (civic transparency project; contact lancemccarter1316@hotmail.com)`),
≥2s apart, 4 requests total (well under the ≤6 budget). Target: 42 U.S.C. 1396b (Medicaid
payments, referenced by the HR 498 golden's actual bill text).

**Reality vs. the task brief's guess:** the brief speculated OLRC offers a clean per-section
RSS/XHTML "download" export. It does not. There is no distinct download/export resource reachable
by a plain GET for a single section - the only working per-section surface is the site's
interactive `view.xhtml` page (a JSF/Mojarra app), which happens to embed the real official
section text amid a large navigation-tree + session-ViewState page. No `download`/`export`/`.xml`/
`.pdf` link of any kind was found in the fetched pages (grepped, confirmed absent) - OLRC's actual
"download" surface (`https://uscode.house.gov/download/download.shtml`, not fetched - out of
scope once the per-section path worked) is documented elsewhere as whole-TITLE bulk archives
(XML/PDF/USLM zips), not per-section. govinfo's USCODE API was never exercised as a fallback
because the house.gov per-section path worked cleanly on the first request.

- `req1-view.xhtml` + `req1.headers.txt` - live fetch of
  `https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title42-section1396b&num=0&edition=prelim`
  (200, `text/html;charset=UTF-8`, 810,581 bytes). Confirmed real: `<title>42 USC 1396b: Payment
  to States</title>`, correct expcite hierarchy (Title 42 > Chapter 7 > Subchapter XIX), genuine
  statutory body between OLRC's own `<!-- field-start:statute -->` / `<!-- field-end:statute -->`
  comment markers. **Major finding:** the operative statute text alone (between those two
  markers, before any HTML-stripping) is 264,322 raw chars / 169,882 chars after stripping - this
  is OVER this task's own MAX_EXCERPT_CHARS=100000 cap. 1396b is one of the U.S. Code's most
  heavily amended sections (Medicaid federal-match formula, decades of PL amendments layered in);
  this is a real property of the actual official text, not a fixture/parsing artifact. Copied
  verbatim (untrimmed) to `tests/fixtures/uscode/title-42-section-1396b.xhtml` as the production
  test fixture proving the adapter's OversizeExcerptError path against real content.
- `req2-view-1396d.xhtml` + `req2.headers.txt` - live fetch of the same URL shape for section
  1396d (`...title42-section1396d...`), fetched to (a) confirm the URL shape generalizes beyond
  the one hardcoded section, and (b) get a real, smaller happy-path fixture. 1396d ("Definitions")
  is directly cross-referenced from within 1396b's own text ("Federal medical assistance
  percentage (as defined in section 1396d(b)...)"). Stripped operative text is 84,221 chars -
  under the cap. Opens by literally defining `"medical assistance"`. Copied verbatim to
  `tests/fixtures/uscode/title-42-section-1396d.xhtml`.
- `req3.headers.txt` (no body saved - 0 bytes) - live fetch of the same URL shape for a
  deliberately bogus section (`title42-section99999999`), sent WITHOUT following redirects
  (`curl` default). **Finding:** unknown citations do not 404 - the server returns `302 Found`
  with `location: /docnotfound.xhtml`. Node's built-in `fetch()` (used by this project's
  `fetchWithLimit`) follows redirects by default, so a real adapter call for a bad citation lands
  on a normal `200 OK` page, not a distinguishable HTTP failure - `!res.ok` in `src/lib/http.js`
  never fires for this case.
- `req4-notfound-followed.xhtml` + `req4.headers.txt` - the same bogus-section request, this time
  with `curl -L` to follow the redirect and capture what a real `fetch()` call actually receives:
  `200 OK`, `<title>Document not Found</title>`, `<h1>Document not found</h1>`, and critically NO
  `field-start:statute` marker anywhere in the page. This is why the adapter detects "not found"
  by marker absence, not by HTTP status. Copied verbatim to
  `tests/fixtures/uscode/section-not-found.xhtml`.

All four fixtures were grepped for anything key-shaped (`api_key`, `token`, `secret`, `Bearer`,
etc.) before being committed - the only hits were false positives on the word "Secretary" (HHS
Secretary, printed throughout the actual statute text). No credentials of any kind are involved;
the site is fully public and unauthenticated.
