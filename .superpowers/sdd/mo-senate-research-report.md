# MO Senate source investigation — agent report

## Status
Complete. Research doc + fixtures written and committed to `main`, pushed to `origin/main`.

## Deliverables
- `docs/research/2026-07-28-mo-senate-sources.md` — full Q1-Q5 findings, same honest-labeling
  method as the House doc (`docs/research/2026-07-27-mo-data-sources.md`).
- `tests/fixtures/research/mo-senate/` — 7 files, all live-fetched 2026-07-28:
  - `sb834-2026-billinformation.html` + `.headers.txt` (current-session bill page, full HTML)
  - `sb834-2026-actions-fragment.html` (Actions AJAX endpoint, current session)
  - `sb894-2018-onder-era-actions-fragment.html` (same endpoint, 2018 = Onder's Senate era)
  - `find-voting-records.html` (Senate's own instructions for locating vote records)
  - `sb834-2026-billtext-fragment.html` (bill-text PDF links + official-copy disclaimer)
  - `2018-day37-journal-onder-era.pdf` (real 2018 Senate Journal day, 13 individual roll-call
    votes, Bob Onder named in the Present roll and multiple YEAS lists)
- `tests/fixtures/research/SOURCES.md` — updated with a `mo-senate/` provenance section
  (existing `legiscan/`/`mo-house-xml/` sections left untouched).

## Key findings

**Q1 (XML/JSON export):** No. `documents.senate.mo.gov` doesn't resolve (DNS failure). The
Senate's bill-tracking app (`BillTracking/...`, ASP.NET Core/Blazor) exposes real, directly
curl-able same-origin GET endpoints (`...&handler=Actions`, `handler=BillText`, etc.) but they
return HTML fragments, not XML/JSON, and are keyed on an internal `billId` integer discoverable
only via an HTML bill-list page — no documented schema like the House's `XMLBillExports.html`.

**Q2 (roll-call location/format):** Individual votes live only inside full-day Senate/House
Journal PDFs, cited by page number from each bill's HTML Actions list (e.g. `#page=2` into
`DAY39.pdf`). Confirmed text-layer (not scanned) via a live fetch and direct Read-tool extraction
— no OCR needed. Structurally different from the House: one PDF = one calendar day and can embed
many votes (13 counted in the one real day fetched), each formatted as full-name lists grouped
under `YEAS—Senators` / `NAYS—Senators` / `Absent—Senators` / `Absent with leave—Senators` /
`Vacancies—N` headers, with a trailing `—<count>` per category usable as a reconciliation check
(same integrity-gate philosophy as the House's `parseMoRollCall`, different shape). No aggregate
tally of any kind exists anywhere in the HTML layer — unlike the House's XML, which at least
gives a free `TotalYes`/`TotalNo` before touching a PDF.

**Q3 (Onder-era / 2015-2023 coverage):** Yes, VERIFIED-BY-PAYLOAD, not just documented. Fetched a
real 2018 bill (SB 894) via the same `handler=Actions` mechanism used for 2026, and fetched a real
2018 Senate Journal day PDF that names Bob Onder in both the daily attendance roll and multiple
individual YEAS vote lists. The Senate's own "Find Voting Records" instructions page states
per-year bill archives exist starting exactly at 2015 (Onder's first year), with a single
"2015 and earlier" bucket for anything older — his entire 2015-2023 term sits inside the
individually-searchable archive, not the catch-all bucket. Journal archive itself traces back to
at least 2000-2001 via other search hits.

**Q4 (ToU):** No robots.txt (404 on both `senate.mo.gov` and `www.senate.mo.gov`), and no
dedicated Terms-of-Use/automation-cadence page was found anywhere searched (unlike the House's
explicit "no more than once every half hour" rule on a dedicated docs page) — genuine absence,
not an unsearched gap, though a full site crawl wasn't performed. Only quotable policy-adjacent
text found is a data-quality disclaimer on bill-text PDFs: "These Bills are not official copies
and should not be quoted or cited. The official copy is the paper copy, which may be obtained
from the Senate Bill Room." Response headers show `Access-Control-Allow-Origin: *` (CORS wide
open) and no rate-limit headers of any kind. Recommendation given to Lance in the doc: treat
Senate cadence exactly as conservatively as the House's documented half-hour rule by default,
since silence isn't an invitation to go faster.

**Q5 (recommendation):** Build a Senate adapter that reuses the House pipeline's *architecture*
(shared `fetchWithLimit`/`createLimiter`, the `pdfjs-dist` legacy-build extraction approach, the
reconcile-or-throw integrity-gate philosophy, the fail-loud identity-resolution pattern) but
requires genuinely new parsing code for two pieces: (1) HTML-fragment scraping instead of XML
parsing for bill/action discovery, with a two-step bill-list→billId resolve the House's
URL-constructible XML pattern doesn't need; (2) whole-day multi-vote journal parsing (locate every
vote block via a motion-phrase anchor, attribute each to its bill, reconcile each against its own
trailing count) instead of one-PDF-per-vote parsing. Effort: more than "swap the URL," less than
"build from scratch." Proposed a `mo-senate-web.js` + `mo-senate-journal-pdf.js` two-adapter shape
mirroring `mo-house-xml.js`/`mo-rollcall-pdf.js`, design-only, not implemented. Told Lance nothing
is blocking (no signup/key/ToU wall unlike LegiScan), and that this reads as a ready-to-pick-up
backlog item rather than urgent work given Plan 3/freshness/glossary already queued ahead of it.

## Politeness / budget
17 live requests to `senate.mo.gov` total (11 via WebFetch for initial reconnaissance, 6 via curl
for the fixtures that got saved), all ≥2 seconds apart, well under the <20 budget. One extra
WebFetch to `mo.gov/privacy-policy` (different host, doesn't count against the senate.mo.gov
budget) to check for a statewide automated-access policy — found none. No Anthropic API calls
were made; no LegiScan calls were made (no key, out of scope, matches the House doc's prior
finding).

## Commit
`docs: MO Senate source investigation` — commit `a6af3ec1bad5154894c54f2a88ba325599d7dcba`,
pushed to `origin/main`.

## Correction (2026-07-28, post-review)

Coordinator review approved the doc overall — independent audit recounted all 13 votes in the
Onder-era journal fixture and confirmed the integrity-gate reasoning held up — but flagged one
Important accuracy defect: the doc claimed journal roll calls print **full names**, when a direct
re-read of the fixture shows every YEAS/NAYS list in all 13 votes prints **bare surnames only**
(e.g. `Brown Chappelle-Nadal Cierpiot ... Onder ... Wieland—31`) — the same granularity as the
House's roll-call PDFs, not richer. I re-verified this myself against the fixture text already in
context before editing (confirmed the reviewer was correct) and fixed every instance in
`docs/research/2026-07-28-mo-senate-sources.md`: the pseudocode block (`<full-name-N>` →
`<surname-N>`), the prose describing the fixture, and — the part that actually mattered
downstream — the Q5 effort-estimate reasoning, which had claimed Senate identity resolution would
be "simpler than the House" because of full names. Corrected to: resolution is surname-based
exactly like the House's `resolveMoRep`, not a simpler full-name lookup; the only real difference
is that Missouri's 34-seat Senate (vs. the House's 163) makes surname collisions rarer in
practice, not different in kind. Also fixed two Minors: normalized two bare "DOCUMENTED" labels
to "DOCUMENTED-UNVERIFIED" per the doc's own honesty key, and corrected
`tests/fixtures/research/SOURCES.md`'s vote count/page range from "at least 10... pages 588-596"
to the exact "13... pages 588-597" (verified by re-counting the vote blocks: SCS for SBs
632&675, SS for SB 882, SS for SCS for SB 600, SB 793, SS for SB 881, SS for SCS for SBs 894&921
[Onder-era target bill], SS for SCS for SB 592, SS for SCS for SBs 627&925, SB 683, SB 768, SB
631, SCS for SBs 946&947, SB 819 — 13 total, first on page 588, last (SB 819) on page 597).

Commit: `docs: correct MO Senate journal name-format claim (surnames, not full names)` —
`9ebd64ddb25e1f6780efaa84f9b756b1e5ee08ea`, pushed to `origin/main`.
