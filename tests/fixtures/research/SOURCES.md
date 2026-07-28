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
  1 vacancy). Pages 588-596 contain **at least 10 separate named roll-call votes** in that single
  day's journal, each formatted as `YEAS—Senators` / `NAYS—Senators` / `Absent—Senators` /
  `Absent with leave—Senators` / `Vacancies—N`, with a trailing count after the last name in each
  list (e.g. `Wieland—28`). Bob Onder's name appears by name in every YEAS list on this page range
  (he was Chairman of the Committee on General Laws that session). This is the real, individual,
  named MO Senate roll-call primary source — one document per **day**, not per **vote** (unlike
  the House's one-PDF-per-roll-call `RollCallPDF`), with several to a few dozen votes embedded in
  each day's file depending on floor activity that day.
