# Task 10 report — trust page + universal footer

**Status:** complete.

**Commit:** `d0329af29757dc6549a7993fcbd42c64b3157b0b` — "feat: trust page + universal footer (the receipts, explained)"

**Tests:** `node --test` from repo root: 1677/1677 passing (baseline 1668 + 9 new — footer content/links, `COUNT_SPECS` assembly, `renderMetricDefinitions` loop over all four `METRIC_DEFINITIONS` keys, `loadCountsSection`/`loadFreshnessSection` ready/failed/empty paths — written failing first per TDD). Additionally verified live end-to-end (jsdom + real fetch, no mocks, against the real anon Supabase surface): `bootstrapTrustPage()` rendered counts (1,462,338 vote casts / 38,252 bills / 1,607 legislators / 10 published summaries / 116 published glossary terms) and all 19 `public_freshness` rows correctly; a local `createSiteServer` smoke confirmed all five pages (`/`, `/trust`, `/person/x`, `/legislator/x`, `/bill/x`) serve a `<footer id="site-footer">` mount point plus their bootstrap script, and all six trust-page anchor ids (`pipeline`, `flags`, `metrics`, `freshness`, `counts`, `attribution`) land.

**Concerns:** none blocking. Two minor judgment calls worth flagging for review: (1) the MO-journal "not-official-copies" disclaimer and the Census privacy-contract sentence are restated verbatim as static hand-typed text in `trust.html` rather than imported as shared JS constants — matches the brief's "static prose is authored text" instruction, but means a future wording change to either source string would need a manual second edit to stay in sync; (2) `#counts` uses three-state loading/failed/ready only (no "empty" case) since `countOnly()` always returns a number, never an absent result — intentional, not an oversight.

## Review fix round

**Status:** complete.

**Commit:** `77f47e301279baddca290b077e15bc0a2b6ce6a9` — "fix: trust page - exactly-true pipeline prose, shared copy constants, footer regression test"

**Tests:** `node --test` from repo root: 1686/1686 passing (baseline 1681, T9's round 2 landed on top of Task 10's own commit — 5 new: `renderPrivacyContract` x2, `renderAttributionCopy` x2, the footer regression test).

Addressed every finding:
- **MEDIUM (truthfulness):** rewrote trust.html's pipeline paragraph, which had overclaimed that "every claim's citation resolves to real text in the source." Read `src/cli/summary-queue.js` and `src/lib/verifier.js` directly to get the real mechanics before rewriting: `checkStatedPurposeGrounding` is the only genuine verbatim-substring-against-stored-text check (stated_purpose only); bullets get `checkCitationsPresent` (non-empty cited section) and `validateVerdictBinding` (the verdict's `section` matches the bullet's own claimed section — a consistency/binding check, not a text match); actual bullet-level support is `assessVerdicts`' re-derived, never-self-reported "clean," from the adversarial verifier's own `supported` judgment per bullet. New paragraph states each layer separately and accurately.
- **LOW-1:** new `site/js/copy.js` exports `PRIVACY_CONTRACT_TEXT` (doc comment carries "Lance's ruling, spec §5"); `site/js/directory-page.js` gained `renderPrivacyContract(container)`, called from `bootstrapDirectoryPage`, with index.html's paragraph now an empty `#privacy-contract` placeholder plus a `<noscript>` fallback (added on my own initiative — the original static paragraph was also the no-JS safety net, so removing it outright would have silently regressed that path). `site/js/trust-page.js` gained `renderAttributionCopy()`, importing `MO_DISCLAIMER_TEXT` from `bill-page.js` and `PRIVACY_CONTRACT_TEXT` from `copy.js`, filling two placeholder `<span>`s in trust.html's attribution list.
- **LOW-2:** added a footer regression test in `tests/site-modules.test.js` driving `createSiteServer`'s real routes (`/`, `/trust`, `/person/*`, `/legislator/*`, `/bill/*` — the same `_redirects`/`applyRewrites` rules production serves through), asserting the `<footer id="site-footer">` mount point and each page's own bootstrap module/function string are present in the served HTML.
- **LOW-3:** hyperlinked "CC BY 4.0" to `https://creativecommons.org/licenses/by/4.0/` in the LegiScan attribution bullet.

Verified live end-to-end again (jsdom + real fetch against the real anon Supabase surface, no mocks): both verbatim spans (`#attribution-mo-disclaimer`, `#attribution-privacy-contract`) render exactly their source constants' text; live counts unchanged from the first verification pass.

**Concerns:** none blocking.
