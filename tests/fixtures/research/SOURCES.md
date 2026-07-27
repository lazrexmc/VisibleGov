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
