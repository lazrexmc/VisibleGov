### Task 3: site scaffold — rest.js, render.js, receipts.js, dev server

**Files:**
- Create: `site/config.js`, `site/js/rest.js`, `site/js/render.js`, `site/js/receipts.js`, `site/_redirects`, `site/css/site.css`, `site/index.html` (placeholder shell for now; Task 8 fills it)
- Create: `scripts/serve-site.js` (zero-dep local static server with rewrite mimicry)
- Test: `tests/site-modules.test.js`

**Interfaces (later tasks import these exact names):**
- `rest.js`: `restGet(path)` → `{status, rows, total}` (total from content-range when `count=exact` requested); `pagedFetch(pathWithFilters, {page, pageSize=50, order})` → `{rows, total, page, pageSize}`; `fetchAllRows(pathWithFilters)` → rows[] (1000-chunk exhaustive loop — the browser selectAll); `countOnly(pathWithFilters)` → number. All take REST paths relative to `/rest/v1/`.
- `render.js`: `el(tag, attrs, ...children)` (strings → text nodes; attrs `{class, href, id, dataset}` allowlist); `clearChildren(node)`; `sectionState(container, {state, message, onRetry})` where state ∈ 'loading' | 'failed' | 'empty' | 'ready' — 'failed' renders a retry button wired to onRetry; 'empty' renders the message; `mountFooter(node)` (Task 10 fills the footer content; scaffold renders source-attribution placeholder text now).
- `receipts.js`: `voteReceiptUrl(feedRow)` → `feedRow.source_url ?? null`; `photoUrl(legislatorLike)` → `image_url` if set, else bioguide derivation `https://unitedstates.github.io/images/congress/450x550/${bioguide_id}.jpg`, else null; `officialBillUrl(bill)` → `bill.canonical_url ?? null`.
- `config.js`: `export const SUPABASE_URL = '<Lance pastes>'; export const SUPABASE_ANON_KEY = '<Lance pastes — the publishable key, public by design>';`

- [ ] **Step 1: TDD the pure logic** in `tests/site-modules.test.js` (jsdom for DOM helpers): range-header math for `pagedFetch` (page 3, size 50 → `Range: 100-149`); `fetchAllRows` loops until a short chunk (fixture fetch stub returning 1000+1000+37 rows → 2037); `el('div', {}, dbString)` puts hostile `<img onerror>` text in as TEXT (assert `textContent` equals input and `querySelector('img')` is null); `sectionState` failed-state retry button calls the callback; `photoUrl` chain (image_url wins; bioguide fallback; null). Run: `node --test` — new tests FAIL.
- [ ] **Step 2: Implement the three modules** (browser-native ESM; `rest.js` reads config via `import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js'`; in node tests, inject via a `_setFetch`/`_setConfig` test hook exported for tests only). `_redirects`:

```
/person/*      /person.html      200
/legislator/*  /legislator.html  200
/bill/*        /bill.html        200
/trust         /trust.html       200
```

- [ ] **Step 3: `scripts/serve-site.js`** — zero-dep node http server: serves files under `site/` by extension content-type, applies the same four rewrites, port 8990, 127.0.0.1 only. (~40 lines; no directory traversal: resolve and require the result starts with the site root.)
- [ ] **Step 4: Full suite green, commit** — `git commit -m "feat: site scaffold - rest/render/receipts modules, rewrites, dev server"`
- [ ] **Step 5 (LANCE GATE):** Lance pastes the anon key + URL into `site/config.js` (or approves the controller copying the URL from `.env` and the anon key he added in Task 1).

