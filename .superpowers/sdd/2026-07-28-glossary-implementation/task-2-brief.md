### Task 2: US Code fetcher (fixture-first)

**Files:** Create `src/adapters/uscode.js`, `tests/fixtures/uscode/` (real captures), `tests/uscode.test.js`
- Capture (polite, ~1s spacing): the official text for 42 U.S.C. 1396b — try uscode.house.gov's download/API surface first (the OLRC site offers per-section RSS/XHTML exports; investigate the real URL shape and DOCUMENT it), falling back to govinfo's USCODE collection API. THE FIXTURE IS THE SOURCE OF TRUTH; the brief's URL guesses are research-derived.
- Produces: `parseCitation(raw) → {title, section} | null` (handles '42 U.S.C. 1396b', '42 USC 1396b', 'section 1396b of title 42'; null for popular-name-only refs like 'the Social Security Act' — those become needs_mapping); `fetchUscSection(title, section) → {url, excerptText}` via fetchWithLimit + a dedicated polite limiter (2s); `excerptHash` via existing sha256. Excerpt = the section text trimmed to MAX_EXCERPT_CHARS = 100000 with a typed OversizeExcerptError beyond (fail loud, same convention).
- [ ] Fixture capture → failing tests (parseCitation matrix incl. null cases; fixture parse yields substantial text mentioning 'medical assistance' [1396b is Medicaid payments — verify against the real text]; hash stability) → implement → green → commit.


## CONTROLLER RULINGS (binding, appended)

1. Full requirements are the plan's Task 2 section (docs/superpowers/plans/2026-07-28-glossary-implementation.md — read that section): parseCitation matrix, fetchUscSection via fetchWithLimit + dedicated 2s limiter, MAX_EXCERPT_CHARS 100000 with typed OversizeExcerptError, excerptHash via existing sha256.
2. Fixture capture reality-check: investigate uscode.house.gov's actual per-section export surface FIRST (their site offers XHTML downloads per title/section — find and DOCUMENT the real URL shape); if per-section fetch proves impractical there, use govinfo's USCODE collection (api.govinfo.gov — works keyless for basic access at low volume; document what reality supports). Target section for the fixture: 42 U.S.C. 1396b (Medicaid payments — referenced by our HR 498 golden). THE FIXTURE IS THE SOURCE OF TRUTH.
3. Politeness: ≤6 total live requests, ≥2s spacing. Grep fixtures for anything key-shaped before committing.
4. parseCitation null cases are FIRST-CLASS behavior (popular-name-only → null → needs_mapping downstream) — test them as thoroughly as the parse successes.
