# Task 3 report — `src/adapters/mo-senate-web.js` (roster + journal-index parsing)

**Commit:** `650e409` — `feat: mo-senate-web adapter - roster + journal index (fixture-backed)`

## Files

- **Created `src/adapters/mo-senate-web.js`** — `SOURCE`, `MO_SENATE_MIN_INTERVAL_MS` (30 min),
  `moSenateLimiter` (own `createLimiter` instance, separate from `moHouseLimiter` — different
  host), `parseSenateRosterHtml`, `parseSenateRosterPdf`, `parseJournalIndex`,
  `fetchSenateRoster`, `fetchJournalIndex`, `fetchSenateJournalPdf`. No new dependencies (regex/
  string extraction only; pdfjs-dist import stays confined to the test file per ruling 1).
- **Created `tests/mo-senate-web.test.js`** — 20 tests, all against the real Task-1 fixtures
  (`roster-current.html`, `roster-2018-wayback.pdf`, `journallist-current.html`,
  `journallist-2018.html`) plus a handful of hand-built minimal HTML/text snippets for the
  throw-path branches real fixtures don't exercise (unrecognized link shape, missing district
  text, unparseable printed date). PDF text extraction is a literal inline copy of
  `mo-rollcall-pdf.js`'s `reconstructPageText`/`extractRollCallText` pattern (coordinate-based row
  reconstruction, `pdfjs-dist/legacy/build/pdf.mjs`) — not imported, not a new module, per binding
  ruling 1.

## Test counts (the real numbers)

- Full suite: **444 pass, 0 fail** (424 baseline + 20 new). Ran via bare `node --test`.
- `parseSenateRosterHtml` on `roster-current.html`: **33 members + 1 vacancy** (district 10) —
  matches task-1-report.md exactly. Districts present: 1-9, 11-34 (all 33, no gaps/dupes).
- `parseSenateRosterPdf` on `roster-2018-wayback.pdf`: **33 members + 1 vacancy** (`VACANT–17`) —
  matches task-1-report.md exactly. Districts present: 1-16, 18-34.
- Onder spot-check (brief's named ground truth): `{ mo_senate_id: '2', surname: 'Onder',
  full_name: 'Bob Onder', party: null }` — confirmed exact.
- `parseJournalIndex` on `journallist-current.html`: **70 day entries** (2026).
- `parseJournalIndex` on `journallist-2018.html`: **88 day entries** (2018), including the real
  Day 37 URL: `https://www.senate.mo.gov/18info/Journals/RDay370308587-610.pdf`,
  `journal_date: '2018-03-08'` — matches task-1-report.md's cross-check note exactly.

## Design decisions

1. **`mo_senate_id` = district number as text**, not the live site's internal `Senators/
   Member?id=N` query value (those two numberings are unrelated — e.g. Jason Bean is district 25
   but `id=2`). Confirmed against migration `0008_mo_senate_id.sql`'s own comment ("the senator's
   district number as text ('1'..'34')"), mirroring `mo_house_id`'s convention exactly.
2. **Vacancy detection is href-shape-driven, not text-driven**: a real senator's card links to
   `/Senators/Member?id=N`; an empty seat links to a structurally distinct
   `/Senators/VacantSenator?district=N` URL. This is more robust than parsing "Vacant" out of the
   footer text (which has no `<br/>` separator and no "Senator" prefix, unlike a real card's
   footer) and gave a clean, unambiguous branch.
3. **PDF entries title-cased on the way out** (`ONDER, BOB` → `surname: 'Onder', full_name: 'Bob
   Onder'`) since the brief's own spot-check names `Onder` (not `ONDER`) as the expected value.
   Handles hyphenated surnames (`CHAPPELLE-NADAL` → `Chappelle-Nadal`) and a bracketed nickname
   (`SHALONN "KIKI"` in the real fixture) via a punctuation-boundary regex, not a naive
   capitalize-first-letter.
4. **PDF regex anchors on the dot-leader run after the district number** (`(?=\s*\.)`), not on any
   preceding whitespace/boundary. Necessary because the real fixture's 2-column layout means the
   row-reconstructed text runs one column's trailing phone-number digits directly into the next
   column's all-caps surname with **zero separating whitespace** (confirmed against the real
   extracted text: `...751-1282Internal Number...` and similarly two header lines back-to-back).
   A lookbehind/boundary-based approach would have missed roughly half the entries.
5. **En dash (U+2013) confirmed as the real delimiter** in the extracted PDF text (`BROWN,
   DAN–16`), not a hyphen-minus — verified by direct `codePointAt` check against the fixture. The
   regex matches both `–` and `-` defensively since nothing guarantees every future capture
   reproduces the exact glyph, but the real 2018 fixture only ever produces the en dash.
6. **`parseJournalIndex` uses one regex for both years** — controller ruling 2's "2026 uses
   `.journal-entry-card` divs; 2018 uses Day-N h6 headers" turned out to describe the *same*
   markup from two angles once the real fixtures were diffed (both files render byte-identical
   `.journal-entry-card` structure; only the data differs). No branching needed.
7. **`journal_date` is null-safe and filename-independent**: parsed only from the printed
   `M/D/YYYY` text via a strict regex; a synthetic test proves it stays `null` (never falls back
   to parsing the date encoded in the PDF filename) when the printed text doesn't match.
8. **`party` is always `null`** in both parsers — task-1-report.md confirms no party affiliation
   is printed on either the live roster page or the 2018 PDF (grepped absent in both), so this
   isn't a parsing gap, it's an honest reflection of what the source provides.
9. Both parsers throw a plain `Error` (matching `parseMoRepresentative`'s precedent, per the
   brief) rather than a custom error class — no downstream code in this task needs to
   discriminate error types, unlike `RollCallParseError`'s reconciliation-detail payload.
10. No `fetchSenateRosterPdf` function was added. The interface block only lists
    `fetchSenateRoster` (HTML), `fetchJournalIndex`, and `fetchSenateJournalPdf`; the 2018 PDF
    came from `web.archive.org`, a different host with no confirmed live-fetchable URL pattern on
    `senate.mo.gov` itself, so adding a fetch wrapper for it would be speculative.

## Concerns

- **Fetch functions are untested against real network behavior** (`fetchSenateRoster`,
  `fetchJournalIndex`, `fetchSenateJournalPdf`) — each is a two-line wrapper around
  `fetchWithLimit`, and per the hard "no network in tests" rule plus this codebase's own
  precedent (`mo-house-xml.js`'s and `mo-rollcall-pdf.js`'s equivalent fetch functions are also
  untested), only their existence/type is asserted. Same risk profile as the rest of the
  codebase, not a new gap.
- **PDF entry regex is only verified against one real 2018 fixture.** It correctly handles every
  shape in that document (hyphenated surname, bracketed nickname, run-on 2-column text, `VACANT`
  with no first name), but a genuinely different future archival year's roster PDF (different
  typesetting) is unverified territory — same caveat the brief itself flags for `mo-house-xml.js`'s
  analogous surname-parsing gaps.
- **`titleCase`'s punctuation-boundary heuristic** is a small bespoke function with no existing
  repo precedent to lean on (unlike `decodeHtmlEntities`, which mirrors `us-congress-text.js`'s
  established entity-stripping approach). It's covered by two real-fixture assertions (Onder,
  Chappelle-Nadal) but a name with punctuation not in its boundary character class (e.g. a period
  inside a name) would title-case incorrectly rather than throw — a silent-degradation risk, not a
  fail-loud one, though the *parsing* (surname/district extraction) itself would still be correct;
  only the cosmetic casing could be off.
