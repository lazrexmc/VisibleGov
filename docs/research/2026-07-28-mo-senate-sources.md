# Missouri Senate machine-readable source investigation (research only)

**Date:** 2026-07-28. **Status:** research complete, no integration code written. **Branch:**
`main`.

## Why this exists

`docs/research/2026-07-27-mo-data-sources.md` (Task 9) investigated the MO **House** and found
`documents.house.mo.gov` — a clean, no-auth XML export system — plus a real, text-layer,
parseable per-vote roll-call PDF. That work shipped as `src/adapters/mo-house-xml.js` +
`src/adapters/mo-rollcall-pdf.js` (PDF extraction via `pdfjs-dist`, with a hard
reconcile-or-throw integrity gate — parsed cast counts must equal the printed tallies or the
roll call is never stored). This doc is the sibling investigation for the MO **Senate**
(`senate.mo.gov`), asking the identical questions, with the identical honesty standard, because
Bob Onder's Missouri political career spans **both chambers** — MO House, then MO Senate
(district 2, 2015-01-07 to 2023-01-04), then U.S. House — and TODO item 9's "MO individual votes"
gap applies to his Senate seat too.

**Honest-status key**, used on every claim below (same as the House doc):
- **VERIFIED-BY-PAYLOAD** — fetched the real thing live and saved it under
  `tests/fixtures/research/mo-senate/` (see `tests/fixtures/research/SOURCES.md` for exact
  URLs/dates).
- **DOCUMENTED-UNVERIFIED** — read on an official page or found via search, but not fetched
  myself in this investigation (cited).
- **UNKNOWN** — could not determine either way; what would resolve it is stated.

## A note on access

No LegiScan key exists (see the House doc — unchanged). `senate.mo.gov` itself was fully
fetchable with no auth and no bot-wall (unlike `legiscan.com`): every fetch in this investigation
succeeded via a plain `curl` request with a self-identifying User-Agent, no headless browser
required, even for the sub-pages that the site's own JavaScript loads via `fetch()` into a modal
dialog (see Q1) — those are same-origin GET endpoints, directly reachable. 17 requests total were
made against `senate.mo.gov` across this investigation (well under the requested <20 politeness
budget), spaced ≥2 seconds apart. `senate.mo.gov/robots.txt` and `www.senate.mo.gov/robots.txt`
both returned HTTP 404 — **no robots.txt exists at all**, which is itself a data point for Q4.

## Q1: Does senate.mo.gov (or any official MO portal) expose XML/JSON exports for Senate bills/actions like the House's documents.house.mo.gov/xml/?

**No — VERIFIED (absence), not just unsearched.**

- `documents.senate.mo.gov` (the obvious parallel to the House's `documents.house.mo.gov`)
  **does not resolve** — `getaddrinfo ENOTFOUND documents.senate.mo.gov`. There is no
  Senate-side documents subdomain.
- The Senate runs its own bill-tracking web app (`senate.mo.gov/BillTracking/...`), built on
  ASP.NET Core/Blazor (server-rendered HTML with `b-<hash>` Blazor component markers), **not**
  the House's static-XML-export model. VERIFIED-BY-PAYLOAD
  (`tests/fixtures/research/mo-senate/sb834-2026-billinformation.html`): the per-bill page's
  "Quick Links" card exposes six sub-views as `data-modal-url` attributes consumed by client-side
  JS (`showAjaxModal`) — `handler=BillText`, `handler=Actions`, `handler=Summaries`,
  `handler=FiscalNotes`, `handler=Amendments`, `handler=CommitteeMinutes`. **These are real,
  directly-fetchable, same-origin GET endpoints** — VERIFIED-BY-PAYLOAD by curling
  `.../BillInformation?year=2026&billId=416&billPrefix=SB&billSuffix=834&handler=Actions`
  directly (no browser, no session, no cookies) and getting back the real actions table HTML
  (`tests/fixtures/research/mo-senate/sb834-2026-actions-fragment.html`). So there **is** a
  stable, scriptable per-bill data surface — but it returns **HTML fragments, not XML or JSON**,
  and it's coupled to internal `billId` integers (not bill numbers) discovered only via the
  `BillList` HTML page, not a documented schema page like the House's `XMLBillExports.html`.
- Two direct guesses at a BTS_Web ASPX endpoint pattern surfaced via search
  (`.../26info/BTS_Web/BillText.aspx?SessionType=R&BillID=2581464`,
  `.../26info/BTS_Web/Bill.aspx?...`) both returned HTTP 404 live — that URL shape looks like a
  retired/prior version of the bill-tracking system, not the current one. Not pursued further; the
  `BillTracking/Bills/BillInformation?...&handler=...` shape above is the real, currently-live
  mechanism.
- `senate.mo.gov/BillReportingSystem/` (a "Bill Reporting System" the site links to for
  customized bill reports) requires a login — VERIFIED-BY-PAYLOAD
  (page text: "Users can log in with credentials to select specific bills... then generate
  customized reports"). Not investigated further since it needs an account and this task's scope
  was no-auth sources first; **UNKNOWN** whether it would emit structured (CSV/XML) output for a
  registered user, flagged for a future look if the HTML-fragment path proves too fragile.
- No sitemap, developer page, or API mention was found anywhere on `senate.mo.gov` in this
  investigation (Quick Links, footer, BillReportingSystem instructions PDF link, FindVoterRecords
  page — none mention one). **Bottom line: the MO Senate has no XML/JSON export analogous to the
  House's.** The closest thing is same-origin HTML-fragment endpoints, which is workable but is a
  materially different (and more fragile — HTML markup, not a documented schema) integration
  surface than the House's XML.

## Q2: Where do MO Senate roll-call votes live? Text-layer PDFs or HTML?

**Inside the full-day Senate/House Journal PDFs, cited by page number from the bill's Actions
list — confirmed text-layer, VERIFIED-BY-PAYLOAD.** Structurally different from the House.

- VERIFIED-BY-PAYLOAD (`tests/fixtures/research/mo-senate/find-voting-records.html`, the
  Senate's own instructions page), quoted directly: *"Every vote taken in both chambers is
  recorded and listed in the Senate and House Journals which are available online in PDF
  format."* And: *"The numbers shown on the far right of the action line indicate the journal
  page on which the vote is recorded... An 'S' in front of the page number indicates it is
  located in a Senate journal, the 'H' represents a House journal page... Click on the page
  number to open the journal containing that action. The journal will open to the correct page."*
- VERIFIED-BY-PAYLOAD (`sb834-2026-actions-fragment.html`, `sb894-2018-onder-era-actions-fragment.html`):
  every substantive floor action (Third Read and Passed, Perfected, SS/SA adopted, Truly Agreed
  To and Finally Passed, etc.) links straight to
  `https://www.senate.mo.gov/<yy>info/pdf-jrnl/DAY<NN>.pdf#page=<N>` — a PDF-page-anchor link
  into that day's full journal, not a purpose-built per-vote document. Committee-stage actions
  ("Voted Do Pass X Committee") carry **no** journal citation at all — committee votes are not
  individually recorded this way (same gap as the House, where committee `RollCall` is
  aggregate-only).
- **No vote tally or count of any kind appears anywhere in the BillTracking HTML** — not even an
  aggregate Yes/No count like the House's `Action > RollCall > TotalYes/TotalNo`. The journal PDF
  is the *only* place any vote information exists for the Senate side. This is a real gap versus
  the House's XML, which at least gives a cheap aggregate tally without touching a PDF.
- VERIFIED-BY-PAYLOAD (`tests/fixtures/research/mo-senate/2018-day37-journal-onder-era.pdf`,
  fetched live and read directly — **confirmed text-layer, no OCR needed**, same finding as the
  House's roll-call PDF): the day's journal is a normal justified-text PDF. It opens with a
  `Present—Senators` / `Absent—Senators` / `Absent with leave—Senators` / `Vacancies—N` daily
  roll (31 present, 2 absent-with-leave, 1 vacancy — Missouri's Senate is 34 seats), then embeds
  **every individual floor vote taken that day inline**, each formatted identically:
  ```
  On motion of Senator <X>, <bill> was read the 3rd time and passed by the following vote:
  YEAS—Senators
  <full-name-1> <full-name-2> ... <full-name-N>—<count>
  NAYS—Senators
  <full-name-1> ...—<count>
  Absent—Senators[—None | <names>—<count>]
  Absent with leave—Senators
  <names>
  Vacancies—<N>
  ```
  This single 155KB, 24-page PDF (one calendar day) contains **13 separate individual roll-call
  votes** (SCS for SBs 632&675, SS for SB 882, SS for SCS for SB 600, SB 793, SS for SB 881, SS
  for SCS for SBs 894&921 [the Onder-era target bill], SS for SCS for SB 592, SS for SCS for SBs
  627&925, SB 683, SB 768, SB 631, SCS for SBs 946&947, SB 819). **Names are printed in full** (not abbreviated surnames like the House), grouped by vote position rather
  than one line per legislator — the parsing shape is genuinely different from the House's
  per-member-per-line `SURNAME [DISTRICT] <CODE>` format: here it's `<CATEGORY HEADER>` followed
  by a flat run of full names, terminated by the next category header, with a trailing
  `—<count>` after the last name that gives a cheap, mechanically-checkable tally (directly
  reusable as the same style of reconcile-or-throw gate `mo-rollcall-pdf.js` already uses for the
  House, just against a different grouping shape).
- Practical implication for an adapter: **one fetch (one day's journal) yields many votes**,
  which is actually *more* data-dense than the House's one-PDF-per-vote model — but finding *all*
  the vote blocks inside a variable-length day (could be a handful of pages on a quiet day, dozens
  near session deadlines) requires scanning for the `"...read the 3rd time and passed by the
  following vote:"` (and equivalent motion-adopted/veto-override phrasings) anchor repeatedly,
  not a single fixed anchor per document like the House's `RollCallPDF`.

## Q3: Does coverage extend back to 2015-2023 (Bob Onder's MO Senate era)?

**Yes — VERIFIED-BY-PAYLOAD for 2018 specifically (squarely inside Onder's term), and
DOCUMENTED by the Senate's own instructions for the full 2015-2023 span.**

- VERIFIED-BY-PAYLOAD: `sb894-2018-onder-era-actions-fragment.html` — the exact same
  `handler=Actions` mechanism, `year=2018` (not 2026), works identically: same field shapes, same
  journal-citation format (`S592`, `H2520`, etc.), same modal endpoint pattern. This is not a
  guess — it's a real, live, successful fetch of a real 2018 bill (SB 894, sponsor Sen. Libla).
- VERIFIED-BY-PAYLOAD: `2018-day37-journal-onder-era.pdf` — a real 2018 Senate Journal day,
  fetched live from `senate.mo.gov/18info/pdf-jrnl/DAY37.pdf`, text-layer-extractable, and it
  contains **Bob Onder's own name**, both in the daily Present roll and by name in multiple YEAS
  vote lists (he moved to table reconsideration on nearly every bill that day, consistent with
  him chairing the Committee on General Laws that session per the journal text itself). This
  directly answers the task's "fetch one Onder-era sample if reachable" instruction — reachable,
  fetched, and it names Onder in a real recorded vote.
- DOCUMENTED (the Senate's own page, quoted verbatim, `find-voting-records.html`): *"From the
  dropdown, click on the desired year; bills before 2015 you will click the '2015 and earlier'
  option."* This is the Senate telling its own users, in its own instructions, that **individual
  per-year bill archives exist starting at 2015** — the exact first year of Onder's Senate term
  (sworn in 2015-01-07) — with everything before that bundled into one catch-all option. Onder's
  entire Senate tenure (2015-2023) therefore falls entirely within the individually-searchable,
  per-year archive, not the pre-2015 bucket.
- Journal-archive depth independently corroborates this: the Journals landing page
  (`senate.mo.gov/journallist/`) offers a year selector from 2000 to the present, and a live
  search turned up real, resolvable journal URLs at both `senate.mo.gov/18info/Journals/...` (2018,
  Onder-era, matches the fixture above) and even a `senate.mo.gov/08info/jrnlist/journals.aspx`
  / `senate.mo.gov/01info/jrn-list.htm` hit (2001/2008 era), suggesting the URL scheme has
  survived at least one internal redesign but the archive itself goes back to at least 2000-2001.
  **Bottom line: not just "back to 2015" — the whole Onder MO Senate window (2015-2023) sits
  comfortably inside a much deeper archive**, with no indication of a coverage cliff anywhere
  near his term.

## Q4: Terms of use for automated access

**No dedicated automation/ToU policy was found — a meaningfully weaker (i.e., more permissive by
omission, but also less certain) posture than the House's explicit half-hour rule.**

- `senate.mo.gov/robots.txt` and `www.senate.mo.gov/robots.txt`: **both HTTP 404 — no robots.txt
  exists.** (The House also had no crawl-restricting robots.txt; this is consistent.)
- No "Terms of Use," "Conditions of Use," "Automated Access," or rate-limit language was found on
  any page fetched in this investigation: not on the Senate homepage, `BillTracking/`,
  `BillReportingSystem/`, `FindVoterRecords/`, or any individual bill page. This is a genuine
  absence, not an unsearched gap — the House's equivalent language ("Do not automate scripts to
  pull down information more often than once every half hour") lives on a dedicated
  `XMLBillList.html` docs page; the Senate has no equivalent docs page to check, because it has no
  documented XML system to write docs for.
- Statewide `mo.gov/privacy-policy` was checked as a fallback (does it cover all `*.mo.gov`
  automated-access behavior generically?) — it is a general privacy policy (data collection,
  monitoring for unauthorized access/tampering) with **no language addressing automated access,
  scraping, bots, or rate limits**. Does not fill the gap.
- The only quotable, verbatim policy-adjacent text found is a **data-quality disclaimer**, not a
  ToU, on every bill-text PDF listing (`sb834-2026-billtext-fragment.html`): *"These Bills are not
  official copies and should not be quoted or cited. The official copy is the paper copy, which
  may be obtained from the Senate Bill Room."* This bears on data provenance (never claim a
  fetched Senate PDF is "the" official bill text — same posture as court PACER-style disclaimers)
  but says nothing about automation cadence or bulk access.
- One positive technical signal: response headers on every page fetched
  (`sb834-2026-billinformation.headers.txt`) show `Access-Control-Allow-Origin: *` — the site
  serves every response with CORS wide open, which is at minimum consistent with (not proof of)
  an intent to allow non-browser/cross-origin consumption. No `X-RateLimit-*`, `Retry-After`, or
  similar throttling headers were observed on any response.
- **UNKNOWN, not "no restrictions exist"**: the absence of a documented policy is not the same as
  an explicit invitation. **Recommendation for Lance: treat the Senate exactly as strictly as the
  House's documented half-hour cadence (i.e., don't assume the silence means "go faster") until/
  unless a real Senate ToU page is found** — this investigation's reasonable search (Quick Links,
  footer, every fetched page, a general web search) did not surface one, but a full site crawl was
  not performed. Reuse `mo-house-xml.js`'s own `MO_HOUSE_MIN_INTERVAL_MS` limiter pattern and
  cadence as the conservative default for a Senate adapter rather than inventing a looser one.

## Q5: Recommendation

**Build a Senate adapter, reusing most of the House pipeline's machinery, but budget real new
work for two structurally different pieces: HTML-fragment scraping instead of XML parsing, and
whole-day multi-vote journal parsing instead of one-PDF-per-vote parsing.** Both are solvable with
what's already in the repo, not a new category of problem — but neither is a drop-in reuse of the
House adapter's parsing code, only its *architecture and integrity discipline*.

**What carries over directly (high reuse):**
- `src/lib/http.js`'s `fetchWithLimit` (already supports `as: 'text'` for HTML and
  `as: 'arrayBuffer'` for PDF binary — no changes needed) and `src/lib/rate-limiter.js`'s
  `createLimiter` (same shared-limiter-per-source pattern `mo-house-xml.js`/`mo-rollcall-pdf.js`
  already use).
- `pdfjs-dist/legacy/build/pdf.mjs` extraction approach from `mo-rollcall-pdf.js` — Node-safe,
  legacy build, `Uint8Array` conversion trap already documented and solved there — including its
  row-reconstruction-by-coordinate technique (though the Senate's flat name-lists likely need
  simpler text-stream concatenation, not row/column reconstruction, since there's no multi-column
  grid layout like the House's — needs re-verifying against a real Senate PDF's raw text-item
  order, not assumed).
- The **reconcile-or-throw integrity gate** philosophy from `mo-rollcall-pdf.js`'s
  `parseMoRollCall` (never store a vote whose parsed casts don't match the printed tally) —
  directly portable: the Senate's printed `—<count>` after each category's name list is the
  Senate's version of the House's `Total Yes:`/`Total No:` line, and should gate storage the same
  way.
- `resolveMoRep`'s fail-loud, no-guessing identity-resolution pattern (0 or >1 match → null,
  recorded unresolved, never guessed) — directly applicable to matching a Senate journal's full
  name against a Senate roster, likely *simpler* than the House case since 34 senators makes
  surname collisions rare (none observed in the one real day fetched) and full names (not bare
  surnames) are printed, removing the House's district-suffix-disambiguation need entirely for the
  common case.

**What's genuinely new work (real, not cosmetic):**
1. **Bill/action discovery is HTML-fragment scraping, not XML parsing.** No schema doc exists to
   pin field names against (the House's `XMLBillExports.html` was invaluable and has no Senate
   equivalent) — field extraction has to be driven off the real fixture HTML's CSS
   classes/structure (`.actions-container`, `td.col--date`, `td.col--action`, the `Journal` cell's
   `<a href>`), which is more brittle to a future site redesign than an XML schema would be. The
   research fixtures captured here (`sb834-2026-actions-fragment.html`,
   `sb894-2018-onder-era-actions-fragment.html`) are real specimens across two different sessions
   and should anchor the parser's tests, same as the House's fixtures do.
2. **Bill discovery needs a two-step resolve:** `BillTracking/Bills/BillList?year=<Y>&session=R`
   (HTML, lists bill number + internal `billid`) → `BillTracking/Bills/BillInformation?
   year=<Y>&billId=<id>&billPrefix=<TYPE>&billSuffix=<NUM>&handler=Actions` (the internal
   `billid` is required and isn't derivable from the bill number alone — it must be scraped from
   the list page first, one more HTTP round-trip than the House's URL-constructible
   `<session>-HB1800.xml` pattern).
3. **Roll-call extraction is a different parsing problem, not the same one with different
   regexes.** One whole-day journal PDF (variable length, potentially dozens of pages) can contain
   many unrelated votes; the parser must (a) locate every vote block via a motion-phrase anchor
   (not a single fixed section like the House's `RollCallPDF`), (b) know which specific bill each
   block belongs to (the preceding "SS for SCS for SB NNN... was taken up" text names it — doable,
   but is new logic, not reused from the House path), and (c) apply the reconcile-gate per block.
   This is more complex boundary-finding than the House case, offset by needing only one fetch to
   get potentially a dozen+ votes rather than one fetch per vote.
4. **No aggregate-tally fallback exists.** Unlike the House (whose XML gives a free
   `TotalYes`/`TotalNo` even before touching a PDF), the Senate gives **nothing** until the journal
   PDF is fetched and parsed — there's no cheap "get the numbers without the PDF" path at all for
   the Senate side.

**Effort estimate relative to the House pipeline:** meaningfully more than "swap the URL," clearly
less than "build from scratch." The identity-resolution and integrity-gate philosophy transfer
almost unchanged; the PDF-extraction *library usage* transfers; the actual parsing logic for both
bill-list discovery (HTML vs XML) and roll-call extraction (multi-vote-per-day-document vs
one-vote-per-document) needs real new code and its own test fixtures, not a config change to the
existing adapters. Rough shape (design only, not implemented):

```
src/adapters/mo-senate-web.js
  export const SOURCE = 'mo-senate-web';
  export const moSenateLimiter = createLimiter({ minIntervalMs: MO_HOUSE_MIN_INTERVAL_MS });
    // reuse the House's own conservative cadence by default (Q4: no Senate-specific policy found)
  fetchSenateBillList(year, session='R')      // BillTracking/Bills/BillList?year=&session=
  parseSenateBillList(html) -> [{ bill_number, senate_bill_id, title }]
  fetchSenateBillActions(year, billId, prefix, suffix)
    // BillTracking/Bills/BillInformation?year=&billId=&billPrefix=&billSuffix=&handler=Actions
  parseSenateActions(html) -> [{ date, description, journal_chamber: 's'|'h', journal_url, journal_page }]
  fetchSenateBillText(year, billId)  // handler=BillText -> PDF link list (Introduced/Perfected/TAFP)

src/adapters/mo-senate-journal-pdf.js
  fetchSenateJournalDay(url)  // as: 'arrayBuffer', shared moSenateLimiter
  extractJournalText(pdfBuffer) -> string   // reuse pdfjs-dist legacy-build call from mo-rollcall-pdf.js
  parseJournalVotes(text, targetPage?) -> [{ motion, billRef, yeas: [names], nays: [names],
    absent: [names], absentWithLeave: [names], vacancies: N }]
    // scan for "...following vote:" anchors; each block terminated by the next category header
    // or the next motion anchor; reconcile-or-throw against each category's trailing "—N" count,
    // same non-negotiable as mo-rollcall-pdf.js's parseMoRollCall
  resolveSenator(fullName, roster) -> legislator_id | null   // fail-loud, same convention as
    // resolveMoRep — likely simpler (full names, 34-seat chamber, no observed collisions)
```

### What Lance needs to do

1. **Nothing blocking** — no signup, no key, no ToU ambiguity like LegiScan's Cloudflare wall.
   Everything in this doc was reachable anonymously.
2. **Decide whether the Senate adapter is worth building now vs. deferred.** The House pipeline
   (`mo-house-xml.js` + `mo-rollcall-pdf.js`) already covers Onder's House-side and any other MO
   House member's votes. This doc's job was narrowly to answer "is Senate coverage real and does
   it reach Onder's Senate years" — both yes — not to schedule the build. Given TODO's existing
   backlog (Plan 3 profile-first site, freshness machinery, glossary work all queued ahead of
   this), recommend treating this as a scoped, ready-to-pick-up backlog item rather than
   immediate work, unless Onder's Senate-era votes specifically are needed before those land.
3. **When it is picked up:** budget for real new parsing code (per Q5 above) — this is not a
   config change to the House adapter. The two research fixtures captured here
   (`sb834-2026-actions-fragment.html` at 2026, `sb894-2018-onder-era-actions-fragment.html` at
   2018/Onder-era, and the real multi-vote `2018-day37-journal-onder-era.pdf`) are real enough
   specimens to write the first parser tests against without any further live fetching.
