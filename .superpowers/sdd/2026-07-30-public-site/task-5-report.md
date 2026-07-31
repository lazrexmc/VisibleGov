# Task 5 report — profile model (pure)

**Status:** done

**Commit:** e83690d300fdb7f806cacf8f8ecc53e9d29b38f5

**Tests:** full suite green, 1320/1320 passing (1292 baseline + 28 new in tests/profile-model.test.js), 0 failures.

**Concerns:** none. `site/js/profile-model.js` is zero-import, browser-clean, pure (no fetch, no DOM, no Node APIs). All five interfaces implemented per the brief: `buildIdentity`, `careerSpan`, `chamberLabel`, `voteFilterQuery`, `groupSponsorships` (+ exported `UnknownSponsorTypeError`). "present" is banned from careerSpan output (asserted directly, and swept across every fixture in the test file); an open end_date on ANY dated term (not just the latest) renders "(end date unrecorded)". A null-dates-only term set (modeled on the real live MO-senate-only Onder shape from tests/link-persons-cli.test.js) yields `'service dates unrecorded'` while chamber/district still label plainly from the term row, per the brief's explicit "don't attempt a fancier as-of qualifier" instruction. `groupSponsorships` throws `UnknownSponsorTypeError` on any sponsor_type outside the exact 0015 vocabulary (primary/cosponsor/joint/unspecified), including null/missing. `voteFilterQuery`'s `page` param is accepted per the interface signature but deliberately never affects the output path (pagination is Range-header driven by rest.js's pagedFetch, not a URL filter) — documented inline. Party fallback (`most recent term with a party, else legislator.party, else null`) uses first-non-null-in-caller-order for the legislator fallback, since the brief specifies no source-authority precedence for that branch (unlike pickDisplayName's bioguide/mo_senate/mo_house/legiscan/openstates ranking elsewhere in the codebase) — flagged here in case a later task wants that precedence added.

## Fix round 1 (task review)

**Status:** done

**Commit:** 431795d0b4db91b9c443d2672faf706e5d97917e

**Tests:** full suite green, 1324/1324 passing (1320 baseline + 4 new in tests/profile-model.test.js), 0 failures.

Two IMPORTANT findings confirmed by execution, both fixed in `site/js/profile-model.js`:

1. **Party fallback was caller-order-dependent.** `resolveParty`'s legislator-row fallback picked the first row in array order that carried a party — proven with a bioguide-Republican/openstates-Democrat pair whose displayed party flipped when the two rows were swapped. Fixed to rank by the same source precedence `src/lib/person-identity.js`'s `DISPLAY_NAME_PRIORITY` uses (bioguide > mo_senate > mo_house > legiscan > openstates), replicated as a new local constant `SOURCE_PRECEDENCE_COLUMNS` with a comment naming `DISPLAY_NAME_PRIORITY` as the source of truth it mirrors and stating the drift tradeoff (duplicated, not imported, to keep this file zero-import/browser-clean — no mechanical link between the two copies, must be hand-updated if the source order ever changes). New tests: order-swap no longer flips the result; a higher-precedence row with no recorded party correctly falls through to the next tier.

2. **`careerSpan` dropped a null-start term's end_date entirely.** The `dated` filter (`t => t && t.start_date`) excluded any term lacking a start_date from every downstream computation, so `careerSpan([{2013-2018}, {start:null, end:2020}])` returned `'2013 – 2018'`, silently discarding the real 2020 evidence. Fixed: the start-year bound still comes from `dated` terms only (unchanged — we don't invent when an undated term began), but the end-year bound now reduces over ALL terms' `end_date` values regardless of whether that term has a start_date; when any term in the set lacks a start_date, the output carries an honesty suffix `' (some service dates unrecorded)'` so the gap is labeled rather than silently smoothed over. The all-null case is unchanged (`'service dates unrecorded'`, no suffix stacking — confirmed by a dedicated regression test), and "present" stays banned (swept across the new fixture too).

Both fixes were TDD'd: the reviewer's exact constructions were added as tests first and confirmed failing against the pre-fix code, then the fix was applied to green.
