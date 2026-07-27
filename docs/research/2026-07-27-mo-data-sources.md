# Missouri machine-readable source investigation (Task 9, research only)

**Date:** 2026-07-27. **Status:** research complete, no integration code written. **Branch:**
`slice2-summarization-review`.

## Why this exists

The `mo-legislature` adapter (`src/adapters/mo-legislature.js`) ingests from OpenStates v3.
Confirmed twice — once in `tests/fixtures/mo-legislature/bills-with-votes.json` (re-checked
2026-07-27: 20 bills, 95 vote events, **0** events carry any per-voter cast) and once live
(TODO.md item 4) — OpenStates has **no individual roll-call votes for MO**, across 4 sessions /
305 sampled vote events. OpenStates' own `openstates_url` on every one of those 95 events points
back at `house.mo.gov`/`senate.mo.gov`. This doc investigates whether LegiScan, or MO's own
official sites, can supply (a) MO bill full text and (b) MO individual roll-call votes in a
machine-readable form, instead of building an HTML/journal scraper against the primary sites.

**Honest-status key**, used on every claim below:
- **VERIFIED-BY-PAYLOAD** — I fetched or downloaded the real thing and it's saved under
  `tests/fixtures/research/` (see `tests/fixtures/research/SOURCES.md` for exact URLs/dates).
- **DOCUMENTED-UNVERIFIED** — read on an official docs page or corroborated by multiple
  independent secondary sources, but I could not fetch/verify it myself (cited).
- **UNKNOWN** — could not determine either way; what would resolve it is stated.

## A note on access

No LegiScan API key exists (`.env` has `CONGRESS_API_KEY`, `OPENSTATES_API_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` — no LegiScan key). Registration at `legiscan.com/legiscan` requires
an interactive email signup, which I did not attempt (out of scope per task instructions). This
caps what could be verified for LegiScan specifically: **no live MO API response was obtained**.
Separately, `legiscan.com` itself (the main site — pricing, ToU, per-bill/roll-call HTML pages)
returned HTTP 403 to every fetch method tried (WebFetch direct, WebFetch via a read-proxy, raw
curl with a browser user-agent) — it's behind Cloudflare bot-detection that blocks automated
tools outright, not just missing a key. `api.legiscan.com` (a separate subdomain hosting the
official developer downloads) was **not** behind that wall and was fully fetchable, which is how
the strongest evidence below was obtained: the real official PHP API client source code and
database schema, downloaded directly.

MO's own `documents.house.mo.gov` (the House's XML export subdomain) was fully fetchable with no
auth, and gave the best, most concrete evidence in this whole investigation.

---

## Q1: Does LegiScan's API provide MO bill full text in machine-readable form?

**UNKNOWN for MO specifically** (no live payload obtained). **DOCUMENTED + VERIFIED-BY-PAYLOAD
for the operation's general behavior:**

- VERIFIED-BY-PAYLOAD (`tests/fixtures/research/legiscan/legiscan-current.tar.gz` →
  `legiscan/LegiScan.php` lines 1097–1105, 3626–3719; `legiscan/schema-mysql.sql` lines 194–208,
  905–917): `getBillText(text_id)` returns a payload whose `text` object has `doc_id`, `bill_id`,
  `text_size`, `text_hash`, `type_id`, `mime_id`, `date`, and `doc` (base64-encoded — confirmed by
  the official client's own decode step: `base64_decode($text['doc'])`). `mime_id` resolves via
  the `ls_mime_type` table, whose seeded values are: `text/html`, `application/pdf`,
  `application/wordperfect`, `application/msword`, `application/rtf`,
  `application/vnd...wordprocessingml.document` (docx), `application/vnd.ms-excel` (xls). So the
  format is genuinely **state-dependent** — LegiScan is a pass-through of whatever the state
  itself publishes, not a normalizer to HTML/plain-text.
- VERIFIED-BY-PAYLOAD (`tests/fixtures/research/mo-house-xml/HB2-bill-text-pdf-only.xml`,
  `HB1800-with-rollcall-tallies.xml`, and the schema doc
  `xml-bill-exports-schema-doc.html`): Missouri's **own** primary source — house.mo.gov — serves
  bill text **only as PDF**. Every `BillTextLink` in every MO House bill XML I fetched (live,
  2026-07-27) is a `.pdf` URL (e.g.
  `https://documents.house.mo.gov/billtracking/bills261/hlrbillspdf/0002H.06T.pdf`); the House's
  own schema documentation lists `BillTextLink` as "PDF of the text of a given version of the
  bill" with no alternate format. There is no HTML or plain-text bill-text format anywhere at the
  MO primary source.
- Given that, it is very likely LegiScan's `mime` for MO bill text is `application/pdf` (LegiScan
  markets itself as tracking the state's own source documents), but **this is an inference, not a
  verified fact** — LegiScan could plausibly OCR/convert to HTML on ingest for some states. This
  is the single most useful thing a live test call would settle.
- **Implication regardless of source chosen:** `src/lib/summarizer.js` (`summarizeBill`) requires
  a plain-text string. Neither LegiScan (probably) nor house.mo.gov (confirmed) will hand MO bill
  text over as ready-to-summarize text — a **PDF-text-extraction step is a new, currently-missing
  pipeline capability** either way. `src/adapters/us-congress-text.js`'s `stripHtml` only handles
  HTML/XML; it does not touch PDF. This is a real new dependency (like `@anthropic-ai/sdk` was
  flagged as one new runtime dep in the slice-2 self-review) — budget for it.

## Q2: Does LegiScan carry MO roll calls WITH individual legislator votes?

**UNKNOWN for MO specifically whether the data is actually populated** (no live payload
obtained) — **but the operation itself, and its schema, are VERIFIED-BY-PAYLOAD to support
individual votes in general**, which is a materially stronger basis than a docs page claim:

- VERIFIED-BY-PAYLOAD (`legiscan-current.tar.gz` → `legiscan/LegiScan.php` lines 1154–1170,
  3971–4057): `getRollCall($roll_call_id)`'s own docstring reads *"Get the roll call record for a
  specified bill with vote summary and **individual legislator vote information**."* The real
  parsing code (`processRollCall`) confirms the payload shape:
  `payload.roll_call = { roll_call_id, bill_id, chamber_id, date, desc, yea, nay, nv, absent,
  total, passed, votes: [ { people_id, vote_id }, ... ] }` — one entry per legislator who voted,
  keyed by LegiScan's internal `people_id` (a `getPerson`/`getSessionPeople` call resolves that to
  a name).
- VERIFIED-BY-PAYLOAD (`schema-mysql.sql` lines 1189–1192): `vote_id` resolves via the `ls_vote`
  lookup table: `1=Yea, 2=Nay, 3=Not Voting, 4=Absent`.
- What this does **not** tell us: whether LegiScan's MO coverage actually has this `votes[]`
  array populated for real MO roll calls, or whether (like OpenStates) it's structurally present
  but empty for this particular state. That can only be settled with one real `getRollCall` call
  against a real MO `roll_call_id` — which requires a key.
- **Independent, stronger evidence that the underlying data genuinely exists and is
  machine-parseable, found directly at the MO primary source (no LegiScan needed to establish
  this):** VERIFIED-BY-PAYLOAD (`tests/fixtures/research/mo-house-xml/rollcall-034.008.pdf`,
  fetched live from a real `RollCallPDF` link found in `HB1800-with-rollcall-tallies.xml`). This
  PDF ("HB 1800, Session Day 34, Roll Call 8, 3/9/2026") is a **text-layer PDF, not a scanned
  image** — it extracted cleanly as real text via the Read tool with no OCR, into a 4-column table
  of every House member's surname with a `Y`/`N`/`P`/`@` vote code (Yea/Nay/Present/Absent),
  plus `Total Yes: 82, Total No: 61, Total Present: 2, Total Absent: 13, Vacancies: 5`. Surnames
  with duplicates get a district-number suffix (`SMITH 46`, `SMITH 68`, `SMITH 74`, `TAYLOR 48`,
  `TAYLOR 84`, `JONES 12`, `JONES 88`), which cross-references cleanly against the House's own
  member-XML district keys (see Q4). **This means MO individual roll-call votes are real,
  public, and parseable without any third party** — LegiScan, if its MO data is populated, has
  simply already done this same parsing work for us.

## Q3: LegiScan free-tier limits and terms-of-use constraints

**Mostly UNKNOWN at the primary-source level** — `legiscan.com/terms-of-service`,
`legiscan.com/legiscan`, `legiscan.com/pricing/api`, and `legiscan.com/legiscan-register` all
returned HTTP 403 to every fetch method available in this environment (see "A note on access"
above). This was not a soft block — Cloudflare's bot-check page was served even through a
read-proxy, meaning **an implementer will need to open these pages in a real, human-driven
browser**, not a scripted fetch, to get the authoritative terms.

- DOCUMENTED-UNVERIFIED (converging across multiple independent secondary sources found via
  search — a GitHub review-of-the-API gist, and general-knowledge citations of LegiScan's own
  marketing copy — none of which I could open directly to confirm firsthand): LegiScan's free
  "public" API key tier is capped at **30,000 queries/month**, described as mirroring their
  "OneVote" public tracking service.
- VERIFIED-BY-PAYLOAD (`legiscan-current.tar.gz` → `legiscan/LegiScan.php` lines 1457–1479): the
  official client hard-codes recommended **cache lifetimes per operation**, citing "API
  Operations p.7" of the manual: `getSessionList` 1 day, `getMasterList`/`getMasterListRaw` 1
  hour, `getBill` 3 hours, **`getBillText`/`getAmendment`/`getSupplement`/`getRollCall`: 30 days
  (treated as static)**, `getPerson` 1 week, `getDatasetList`/`getDataset`/`getSessionPeople` 1
  day. This is directly actionable regardless of the exact monthly cap: bill text and roll calls
  should never be re-fetched more than once per document — they don't change once posted.
- VERIFIED-BY-PAYLOAD (`legiscan-current.tar.gz` → `legiscan/COPYRIGHT`): the **client library
  code** (not the data) ships under a permissive BSD-2-clause-style license. This says nothing
  about redistribution/attribution terms for the *data* itself, which is governed by the
  (unreachable) `legiscan.com/terms-of-service`.
- UNKNOWN: attribution requirements, any restriction on public redistribution of MO vote/bill
  data on a civic-transparency site, and whether the free "public" tier specifically prohibits or
  permits that use case (vs. requiring a paid/sponsor tier). **This must be read by Lance in a
  browser before any LegiScan integration ships** — do not assume permissive terms.
- DOCUMENTED-UNVERIFIED (dataset/bulk-download pages found via search, e.g.
  `legiscan.com/MO/datasets`; could not fetch directly): bulk session ZIP downloads
  (`getDataset`/the weekly public dataset snapshots) require being logged into a free LegiScan
  account — there is **no fully anonymous, no-auth bulk MO dataset**, contrary to what the task
  brief hoped might be true. Only the developer *tooling* (client library, manual, ERD, changelog)
  at `api.legiscan.com/dl/` is truly no-auth, and none of that is MO bill/vote data.

## Q4: Do house.mo.gov / senate.mo.gov expose any JSON/XML endpoints themselves?

**house.mo.gov: yes, VERIFIED-BY-PAYLOAD, real and live.** **senate.mo.gov: no evidence found**
(reasonable search, not exhaustive — see below).

- VERIFIED-BY-PAYLOAD: `documents.house.mo.gov` runs a genuine, no-auth, hourly-updated XML
  export system, documented at `documents.house.mo.gov/XML*.html` and confirmed live by fetching
  real files on 2026-07-27 (session `261` = 2026 2nd Regular, 103rd General Assembly — note the
  regular session is "Adjourned Sine Die" per LegiScan's own MO landing page found in search, but
  the XML feed is still live and serving current data as of today). URL construction is driven by
  a small JS file (`SessionSet.js`, saved at
  `tests/fixtures/research/mo-house-xml/session-set.js`) that builds URLs as
  `https://documents.house.mo.gov/xml/<sessioncode>-<File>.XML`, e.g.:
  - `.../xml/261-BillList.XML` — every bill in the session + link to its own XML (537,211 bytes
    live; sample saved).
  - `.../xml/261-HB1800.xml` — one bill's full detail: title, sponsor, all actions with dates and
    House/Senate Journal page citations, bill text version links (PDF only), amendments (PDF
    only), fiscal notes (external link), witness forms, subject index.
  - `.../xml/261-MemberList.XML` and `.../xml/261-107.xml` — every House member, keyed by
    district, with full name, party, committees, sponsored/co-sponsored bills.
  - Also documented (not individually fetched): `SessionList`, `CommitteeList`,
    `UpcomingHearingList`, `CalendarList`, and `SenateActList` (**House-published** tracking of
    Senate bills once they reach the House side — not a Senate-native feed).
- VERIFIED-BY-PAYLOAD: within a bill's `Action` history, a `RollCall` element carries **only**
  `TotalYes`/`TotalNo`/`TotalPresent` — aggregate tallies, never individual votes — confirmed both
  in the schema doc and in a live `HB1800` fetch (a 6–3 committee vote). Individual votes live one
  hop away, in a `RollCallPDF` link (see Q2) — same PDF bottleneck the original problem statement
  described, just now **discoverable via clean XML instead of HTML/journal scraping**, which is a
  real improvement in reliability even though it doesn't remove the PDF-parsing step.
- VERIFIED-BY-PAYLOAD (`tests/fixtures/research/mo-house-xml/xml-bill-list-instructions-doc.html`):
  explicit usage terms, quoted directly: *"This data is made available for public use, however, we
  do not support technology external to the Missouri House of Representatives."* Rate guidance:
  update hourly server-side; **"Do not automate scripts to pull down information more often than
  once every half hour"**; "Scripts which cause undue load... may be temporarily blocked at the
  discretion of House Information Systems." No attribution requirement stated. No prohibition on
  public redistribution stated. This is meaningfully more permissive and much easier to verify
  than LegiScan's (unreachable) terms.
- senate.mo.gov: WebFetch of `senate.mo.gov/billtracking/bills/billsearch` found no
  machine-readable export links on the page; targeted web searches for a Senate XML/JSON/API
  export turned up nothing beyond the House's own cross-chamber tracking file above. Labeled
  UNKNOWN rather than a hard "no" — a full site crawl of senate.mo.gov wasn't performed, and
  government sites sometimes have undocumented endpoints. If Senate-originated bills' individual
  votes are ever needed and the House's `SenateActList`/journal citations don't cover them, this
  is worth a deeper look, but not this task's priority.

## Q5: Recommendation

**LegiScan does not (yet, unverified) obviously solve this better than going directly to
house.mo.gov — and going direct has zero signup, zero ToU ambiguity, and is already
proven-parseable in this investigation.** Recommend a two-track plan, not a single bet:

**Track A — build first, no new external account needed:** a `mo-house-xml` adapter reading
directly from `documents.house.mo.gov`, replacing TODO item 9's originally-scoped "journal
scraper" with something narrower and more reliable (discover the exact `RollCallPDF` per vote via
clean XML, then parse that one small PDF). This closes the roll-call-votes gap without waiting on
Lance or on an unverified third party.

**Track B — cheap to validate, potentially saves building the PDF parser:** once Lance registers
a free LegiScan key (2-minute interactive email signup — could not be done here, see "A note on
access"), the very first thing to do is **one manual `getRollCall` call against one real MO
`roll_call_id`** to check whether `votes[]` is actually populated for MO (the single open
question this whole doc couldn't resolve). If yes, LegiScan can replace Track A's PDF-parsing
step entirely — it's already normalized JSON, already resolves to `people_id`, and its official
client tells us to cache it as static (30 days), so it's cheap on the query budget either way. If
`votes[]` comes back empty for MO (an OpenStates-style gap), Track A stands as the real answer and
LegiScan is not worth integrating for this specific purpose (it may still be worth it later for
bill full text, subject tagging, or non-MO states — out of scope here).

**Either track still needs a PDF-text-extraction dependency for bill full text** — MO's primary
source is PDF-only regardless of vendor (Q1), and `summarizeBill()` needs plain text. This is a
new, currently-absent capability; flag it honestly as a new dependency when scoped, the same way
`@anthropic-ai/sdk` was flagged in the slice-2 self-review.

### Proposed adapter shape (design only — not implemented)

Mirrors the existing `us-congress` / `us-congress-text` split (a metadata adapter + a
text-fetching adapter sharing one `SOURCE` and one rate limiter), per
`src/adapters/us-congress.js` / `src/adapters/us-congress-text.js`:

```
src/adapters/mo-house-xml.js
  export const SOURCE = 'mo-house-xml';
  export const moHouseLimiter = createLimiter({ minIntervalMs: ... });  // House's own
    // guidance is "no more than once per 30 min" for bulk pulls — much gentler cadence than
    // moLimiter's 7s (that one's tuned to OpenStates); this needs its own limiter, not a shared one.
  fetchBillList(sessionCode)          // .../xml/<session>-BillList.XML
  fetchBillXml(sessionCode, billId)   // .../xml/<session>-<BillId>.xml
  parseBillXml(xml) -> {
    bill: { identifier, title, sponsor, ... },
    textVersions: [{ versionType, pdfUrl, lrNumber }],   // ALWAYS pdf — no format branch needed
    actions: [{ description, date, journalPages, rollCall: { totalYes, totalNo, totalPresent,
      pdfUrl } | null }],
  }
  fetchMemberXml(sessionCode, district)  // .../xml/<session>-<district>.xml
  parseMemberXml(xml) -> { lastName, firstName, district, party }  // for surname->identity join

src/adapters/mo-house-rollcall-pdf.js   (or fold into mo-house-xml.js)
  fetchRollCallPdf(url)                // binary fetch, not JSON/text — needs a PDF text layer
    // extraction step (new dependency, e.g. pdf-parse or pdfjs-dist — NOT yet in package.json)
  parseRollCallPdf(pdfText) -> [{ surname, districtSuffix, position }]
    // position: Y/N/P/@ -> yea/nay/present/absent, matching the OPTION_MAP pattern already
    // used in mo-legislature.js's mapOpenstatesOption
  resolveVoter(surname, districtSuffix, memberList) -> full identity record

src/adapters/mo-house-text.js  (or extend the above)
  fetchBillTextPdf(pdfUrl)             // binary fetch
  extractPdfText(buffer) -> string     // new dependency; feeds summarizeBill()'s `text` param
```

If Track B is later confirmed viable:

```
src/adapters/mo-legiscan.js
  export const SOURCE = 'mo-legiscan';
  const BASE = 'https://api.legiscan.com/';
  // auth via ?key=... query param -- src/lib/http.js's redactUrl() already redacts
  // `key=`/`api_key=` query params, so this fits the existing convention with no changes needed.
  getRollCall(rollCallId), getBillText(textId), getSessionList('MO'), getMasterList(sessionId)
  // cache getBillText/getRollCall responses for 30 days per the official client's own guidance
  // (LegiScan.php cache_times table) -- keeps well inside whatever the real monthly cap is.
```

### What Lance needs to do

1. **Register a free LegiScan API key** at `legiscan.com/legiscan` (interactive, email-based —
   not something this task could do). Add it to `.env` as `LEGISCAN_API_KEY` once obtained.
2. **Read `legiscan.com/terms-of-service` and `legiscan.com/pricing/api` in a real browser** —
   they blocked every automated fetch attempt in this environment (Cloudflare bot-check), so Q3's
   attribution/redistribution terms are still genuinely unverified. Confirm the free "public" tier
   permits use on a public-facing civic-transparency site before any LegiScan integration ships.
3. **Decide Track A vs. B** (or both) once the above is done: if Lance wants to unblock MO votes
   immediately without waiting on a signup, greenlight Track A now — it needs no new account and
   is already verified end-to-end (XML discovery → real parseable PDF → identity resolution). If
   Lance would rather not maintain a PDF parser at all, wait for the LegiScan key and spend one
   `getRollCall` call confirming MO coverage before committing.
