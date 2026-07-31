### Task 3: `src/adapters/mo-senate-web.js` — roster + journal-index parsing, shared limiter

**Files:**
- Create: `src/adapters/mo-senate-web.js`, `tests/mo-senate-web.test.js`
- Fixtures: from Task 1

**Interfaces (Produces):**
```js
export const SOURCE = 'mo-senate-web';
export const MO_SENATE_MIN_INTERVAL_MS = 30 * 60 * 1000;   // House-conservative cadence (research Q4)
export const moSenateLimiter = createLimiter({ minIntervalMs: MO_SENATE_MIN_INTERVAL_MS });
export function parseSenateRoster(html) -> [{ mo_senate_id, surname, full_name, party|null }]
export function parseJournalIndex(html) -> [{ day_label, journal_url }]   // absolute URLs
export function fetchSenateRoster(url, limiter = moSenateLimiter)         // as:'text'
export function fetchJournalIndex(url, limiter = moSenateLimiter)         // as:'text'
export function fetchSenateJournalPdf(url, limiter = moSenateLimiter)     // as:'arrayBuffer'
```

- [ ] TDD off the real fixtures: roster parse yields 34 rows for 2018 (or the fixture's true count — assert the REAL number, plus spot-assert Onder: surname `Onder`, district `2`); journal index yields Day 37's URL among 2018 entries; both parsers throw a typed error (plain `Error` with a clear message is fine here, matching `parseMoRepresentative`'s precedent) on structurally-unrecognizable HTML rather than returning [].
- [ ] Implement minimal (regex/string extraction driven by the fixture's actual CSS/markup — no new HTML-parsing dependency), green, commit `feat: mo-senate-web adapter - roster + journal index (fixture-backed)`.


## CONTROLLER RULINGS (binding, appended)

1. Roster parsing is TWO explicit exported functions (Task 1 finding: no 2018 HTML roster exists): parseSenateRosterHtml(html) for the current /Senators/ grid fixture (roster-current.html — 34 cards incl. 'Vacant District 10'; vacancies are NOT roster rows, skip them with an honest count in the return: { members, vacancies }) and parseSenateRosterPdf(text) for the 2018-era 'SURNAME, FIRSTNAME–DISTRICT' shape (roster-2018-wayback.pdf; note VACANT–17 is a vacancy, not a member; the dash may be en/em-dash — match what the extracted text actually contains). PDF text extraction itself belongs to Task 4's extractJournalText — for THIS task's tests, extract the fixture's text with the same pdfjs pattern inline in the test file (do not create the Task 4 module early).
2. parseJournalIndex must handle the real markup found in Task 1: 2026 uses .journal-entry-card divs; 2018 uses Day-N h6 headers with RDay<NN><MMDD><pages>.pdf hrefs (e.g. RDay370308587-610.pdf, data-pages attr). Return { day_label, journal_url, journal_date } where journal_date comes from the printed date ('3/8/2018' → '2018-03-08') when present, else null — never derived from the filename.
3. Fetch functions + limiter exactly per the plan's Interfaces block. SOURCE='mo-senate-web'. Absolute URLs resolved against https://www.senate.mo.gov.
4. Read task-1-report.md (F:\VisibleGov\.superpowers\sdd\2026-07-28-mo-senate-adapter\task-1-report.md) for the markup structure notes before writing parsers — the fixtures are the source of truth over both that report and this brief.
