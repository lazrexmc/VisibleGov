# Task 2 report: US Code fetcher (fixture-first)

**Commit:** `0dbbd035f83e6b54cebe146c9822161096942775` (glossary-implementation, pushed)

## What was built

`src/adapters/uscode.js`: `parseCitation(raw) -> {title, section} | null`, `buildUscUrl`,
`extractSectionText(html, meta)` (pure, does the HTML extraction + the MAX_EXCERPT_CHARS=100000
gate, throws `OversizeExcerptError` / `UscSectionNotFoundError`), `fetchUscSection(title, section)`
(thin fetchWithLimit wrapper, `{url, excerptText}`), `uscodeLimiter` (2s, dedicated), `sha256`
re-exported from `us-congress-text.js` (per instruction: "import it") for callers/tests to hash
the excerpt themselves. `tests/uscode.test.js`: 13 tests, all against real captured fixtures, no
network mocking. `tests/fixtures/uscode/`: 3 real captures (1396b, 1396d, not-found page).
`tests/fixtures/research/uscode/`: 4 raw request+header captures backing the investigation, with
a new `## uscode/` section in `tests/fixtures/research/SOURCES.md` documenting provenance.

## The real export surface vs. the brief's guess

The brief guessed OLRC offers a clean per-section RSS/XHTML "download" export. **It does not.**
Investigated live (4 requests, ≥2s apart, self-identifying UA, well under the ≤6 budget):

- **Real working URL shape:** `https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title{title}-section{section}&num=0&edition=prelim`
  — `text/html`, 200 OK. This is OLRC's *interactive* JSF/Mojarra view page, not a dedicated
  export endpoint — no `download`/`export`/`.xml`/`.pdf` link exists anywhere in the response
  (grepped, confirmed absent). The real section text is embedded in it between OLRC's own
  `<!-- field-start:statute -->` / `<!-- field-end:statute -->` HTML comment markers, alongside a
  large navigation tree and an opaque JSF session-state blob (why the raw pages are 600–800KB).
  Verified the URL shape generalizes across two different real sections (1396b, 1396d).
- **Not-found behavior:** an unparseable/nonexistent section does **not** 404 — the server
  `302`s to `/docnotfound.xhtml`, which `fetch()`'s default `redirect:'follow'` resolves to a
  normal `200 OK` "Document not Found" page. `fetchWithLimit`'s `!res.ok` check never fires for
  this; detection has to be by marker-absence, which is what `extractSectionText` does.
- govinfo's USCODE API was never touched — the house.gov path worked cleanly on the first live
  request, so the documented fallback was never exercised.

## Test summary

291/291 green (278 baseline + 13 new), all in `tests/uscode.test.js`, all against real fixtures —
no network calls in the test run.

## Concern (real, not hypothetical)

**42 U.S.C. 1396b — the exact section this task's own golden (HR 498) cites — legitimately trips
the oversize gate.** Its operative statute text alone (OLRC's own statute-field markers, before
any historical/amendment notes) is 169,882 chars, well over `MAX_EXCERPT_CHARS = 100000`. This
isn't a parsing bug or an overly narrow extraction — 1396b is one of the most heavily amended
Medicaid provisions in the Code. `extractSectionText`/`fetchUscSection` correctly throw
`OversizeExcerptError` rather than silently truncating, per the fail-loud convention — this is
verified directly against the real captured fixture (`tests/fixtures/uscode/title-42-section-1396b.xhtml`,
one of this task's own test cases). Practically: Task 5's glosser will be unable to gloss HR 498's
own 42 U.S.C. 1396b(i) citation as a whole section under the current cap — it will need either a
raised cap, subsection-level excerpting (parseCitation currently drops the subsection), or an
explicit skip/report path for oversize sections. Flagging now for Lance/the controller before
Task 5 is built, not discovering it live mid-gloss-run.

Secondary, minor: `parseCitation` was extended beyond the brief's 3 example forms to also resolve
the *actual* raw citation shape found in HR 498's real bill text — `"Section 1903(i) of the Social
Security Act (42 U.S.C. 1396b(i))"` (popular name wrapping a USC cite, trailing subsection
dropped) — verified against the real `tests/fixtures/us-congress/bill-text.htm` fixture, not
invented. This is a defensible, spec-consistent extension (embedded-cite matching, subsection
discarded since `fetchUscSection` is section-granularity only) but is additional surface beyond
what the brief listed verbatim, worth a controller glance.
