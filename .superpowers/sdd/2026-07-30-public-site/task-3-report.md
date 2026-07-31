# Task 3 Report: site scaffold — rest.js, render.js, receipts.js, dev server

## Status
COMPLETE

## Commit
d1dcf94 — `feat: site scaffold - rest/render/receipts modules, rewrites, dev server`

## Test summary
1274/1274 pass (1240 baseline + 34 new in `tests/site-modules.test.js`), 0 fail.

## Files created
- `site/config.js` — empty-string placeholders (LANCE GATE, step 5 not yet done)
- `site/js/rest.js` — `restGet`/`pagedFetch`/`fetchAllRows`/`countOnly` + `_setFetch`/`_setConfig` test hooks + typed `ConfigError`
- `site/js/render.js` — `el`/`clearChildren`/`sectionState`/`mountFooter` + typed `UnsafeAttributeError`
- `site/js/receipts.js` — `voteReceiptUrl`/`photoUrl`/`officialBillUrl`
- `site/_redirects`, `site/css/site.css`, `site/index.html` (placeholder shell)
- `scripts/serve-site.js` — zero-dep dev server, port 8990/127.0.0.1, exports pure `resolveSitePath`/`applyRewrites`/`contentTypeFor` for testing
- `tests/site-modules.test.js`

## Concerns
- LANCE GATE (step 5) still open: `site/config.js` needs the real Supabase URL + anon key pasted in before any page can read the DB.
- `el()`'s allowlist rejects any attrs key outside `{class, href, id, dataset}` (not just `on*`/`javascript:`) — later page tasks needing e.g. `src`/`alt`/`type` will need render.js extended at that point; flagging so it isn't mistaken for an oversight.
- Manually smoke-tested `node scripts/serve-site.js` on port 8990: `/`, `/js/rest.js`, `/css/site.css` serve 200 with correct content-types; `/trust` correctly 404s (trust.html doesn't exist until a later task); a `..%2f` traversal attempt correctly returns 400.

## Fix round 1 (task review, 3 findings — all in site/js/render.js)

**Status:** COMPLETE
**Commit:** 3c2d3c9 — `fix: render.js - scheme allowlist with control-char stripping, sectionState enum guard`
**Test summary:** 1278/1278 pass (1274 prior + 4 new: TAB-embedded bypass rejection, `data:` rejection, relative/http(s)/mailto still accepted, `sectionState('error')` throwing), 0 fail.

Findings and fixes:
1. **HIGH — javascript: guard bypassable via embedded control chars.** The original check was
   `value.trim().toLowerCase().startsWith('javascript:')`, and `.trim()` only strips leading/
   trailing whitespace — `'jav\tascript:alert(1)'` has its TAB in the middle, survives `.trim()`
   untouched, and does not literally start with `javascript:` as a string, but browsers' URL
   parsers strip embedded TAB/CR/LF anywhere before scheme resolution, so it resolves to a real
   `javascript:` URL at click time. Fixed by stripping `/[\t\r\n]/g` from the WHOLE string first
   (`assertSafeHref` in render.js), not just the ends, before any scheme check.
2. **MEDIUM — blocklist too narrow.** Blocking only `javascript:` missed the rest of the
   dangerous-scheme class (`data:text/html,...` can run script from a clicked link the same way).
   Replaced the blocklist with an allowlist: after control-char stripping, `href` must either
   have no scheme at all (a relative/site-internal path) or match `http:`, `https:`, or `mailto:`
   (case-insensitive) — anything else throws `UnsafeAttributeError`.
3. **MEDIUM — sectionState had no state-enum validation.** An unrecognized `state` (e.g. a typo
   `'error'`) fell through both `if`s and rendered an empty `<p>` with no text — reproducing the
   plan's forbidden "a failed fetch renders as an empty section" via a different path (a caller
   typo instead of an actual fetch failure). Added a `VALID_STATES` guard at the top of
   `sectionState` that throws a new typed `InvalidSectionStateError` (also exported from
   render.js) for any state outside `loading|failed|empty|ready`, before any DOM mutation.

TDD discipline followed: the 4 new tests were added to `tests/site-modules.test.js` and confirmed
failing first (`InvalidSectionStateError` didn't exist yet, causing an import-time `SyntaxError`
that failed the whole file) before the render.js fix was written.

## Micro-round (re-review, 1 pre-existing LOW-MEDIUM — site/js/render.js)

**Status:** COMPLETE
**Commit:** d8f6a02 — `fix: render.js - reject protocol-relative hrefs`
**Test summary:** 1280/1280 pass (1278 prior + 2 new: `//evil.com/x` rejection, `/person/x` single-slash acceptance retained), 0 fail.

Finding: `assertSafeHref`'s "no scheme matched" branch treated any href with no `scheme:` token
as always-relative and let it through unchecked. A protocol-relative URL (`//evil.com/x`) also has
no scheme token, but browsers resolve it against the CURRENT page's scheme — so it still goes
cross-origin. That made it a spoofed-link vector if a DB `source_url` ever carried a leading `//`.

Fix: after the existing control-char strip, `assertSafeHref` now checks `stripped.startsWith('//')`
first and throws the same typed `UnsafeAttributeError` before the scheme-allowlist check even
runs — a genuine same-site path never starts with `//` (real receipt URLs are absolute http(s)),
so there is no legitimate case to preserve. `/person/x` (a real single-slash same-site path) is
asserted separately to still pass, so the fix cannot be mistaken for a blanket "starts with /"
rejection.

TDD discipline followed: the `//evil.com/x` rejection test was added and confirmed failing
(assertion failure, not an import error this time — the module already existed) before the
one-branch fix was written.
