import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { JSDOM } from 'jsdom';

import {
  restGet, pagedFetch, fetchAllRows, countOnly, _setFetch, _setConfig, ConfigError, RestError,
} from '../site/js/rest.js';
import {
  el, clearChildren, sectionState, mountFooter, UnsafeAttributeError, InvalidSectionStateError,
  isSafeSrc,
} from '../site/js/render.js';
import { voteReceiptUrl, photoUrl, officialBillUrl } from '../site/js/receipts.js';
import {
  resolveSitePath, applyRewrites, createSiteServer, contentTypeFor, SITE_ROOT, PathTraversalError,
  _setGeocodeFetch, parseHeadersFile, loadSiteHeaders,
} from '../scripts/serve-site.js';
import { buildUpstreamUrl, onRequestPost } from '../site/functions/geocode.js';
import { METRIC_DEFINITIONS } from '../site/js/vote-charts.js';
import { MO_DISCLAIMER_TEXT } from '../site/js/bill-page.js';
import { PRIVACY_CONTRACT_TEXT } from '../site/js/copy.js';
import {
  COUNT_SPECS, renderMetricDefinitions, loadCountsSection, loadFreshnessSection,
  renderAttributionCopy,
} from '../site/js/trust-page.js';

// render.js is a plain browser-native ES module — it reaches for the global `document`, exactly
// as it will in a real browser tab. jsdom supplies that global here so node:test can drive it
// with no browser and no network (task-3 brief, "Context beyond the brief"). render.js never
// touches `document` at its own module-load time (only inside function bodies called later), so
// setting this after the static imports above is safe — it lands before any test() body runs.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:8990/' });
globalThis.document = dom.window.document;

function mockResponse({ status = 200, rows = [], contentRange = null }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => rows,
    headers: { get: (name) => (name.toLowerCase() === 'content-range' ? contentRange : null) },
  };
}

// ============================================================================
// rest.js
// ============================================================================

test('restGet: returns {status, rows, total}, total parsed from content-range (count=exact)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async () => mockResponse({ status: 200, rows: [{ id: 1 }, { id: 2 }], contentRange: '0-1/2' }));
  const result = await restGet('legislators?select=id&limit=2');
  assert.equal(result.status, 200);
  assert.deepEqual(result.rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(result.total, 2);
});

// N2-LOW(a) (task 6b review, fix round 3): a `limit=1` existence-style probe should not pay for an
// exact count it never reads — `restGet(path, { noCount: true })` omits the `Prefer: count=exact`
// header entirely. Default (no options / `noCount` omitted) is UNCHANGED — every other caller in
// the codebase still gets `count=exact` exactly as before this option existed.
test('restGet: { noCount: true } omits the Prefer: count=exact header (a cheap limit=1 probe never pays for an exact count)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  let capturedHeaders;
  _setFetch(async (url, opts) => {
    capturedHeaders = opts.headers;
    return mockResponse({ status: 200, rows: [{ id: 1 }], contentRange: null });
  });
  await restGet('legislators?select=id&limit=1', { noCount: true });
  assert.equal(capturedHeaders.Prefer, undefined);
});

test('restGet: with no options (or noCount omitted/false), the Prefer: count=exact header is sent exactly as before', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  let capturedHeaders;
  _setFetch(async (url, opts) => {
    capturedHeaders = opts.headers;
    return mockResponse({ status: 200, rows: [], contentRange: null });
  });
  await restGet('legislators?select=id');
  assert.equal(capturedHeaders.Prefer, 'count=exact');
});

test('restGet: throws a typed ConfigError (never a silent 401) when config is empty', async () => {
  _setConfig({ url: '', anonKey: '' });
  await assert.rejects(() => restGet('legislators?select=id'), ConfigError);
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' }); // restore
});

// Fix round 1 (task-6 controller live smoke, LOAD-BEARING finding): a non-2xx response (the real
// case was a Postgres statement timeout, PostgREST 500) used to fall through doFetch's
// `Array.isArray(rows) ? rows : []` fallback silently — a PostgREST error body is an object
// ({code, message, ...}), not an array, so it became `rows: []`, which every caller (pagedFetch,
// fetchAllRows, countOnly) then treated as a genuine zero-row result. A page-level loader checking
// `rows.length === 0` then rendered the HONESTLY-EMPTY state for what was actually a FAILED fetch
// — exactly the violation the plan forbids ("a failed fetch NEVER renders as an empty section").
// Fixed at the lowest honest layer (doFetch, the one shared primitive every exported function
// here builds on): any non-2xx response throws a typed RestError carrying the status and, when
// the body is a PostgREST-shaped error object, its message — before any caller ever sees a rows
// array at all.
test('pagedFetch: a non-2xx response (statement timeout) throws a typed RestError, never a silent empty result', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async () => mockResponse({
    status: 500,
    rows: { code: '57014', message: 'canceling statement due to statement timeout' },
  }));
  await assert.rejects(
    () => pagedFetch('public_vote_feed?legislator_id=in.(x)', { page: 1, pageSize: 50 }),
    (err) => {
      assert.ok(err instanceof RestError);
      assert.equal(err.status, 500);
      assert.match(err.message, /statement timeout/);
      return true;
    },
  );
});

test('restGet/fetchAllRows/countOnly all throw the same typed RestError on a non-2xx response (doFetch is the one shared primitive)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async () => mockResponse({ status: 503, rows: { message: 'server unavailable' } }));
  await assert.rejects(() => restGet('bills?select=id'), RestError);
  await assert.rejects(() => fetchAllRows('bills?select=id'), RestError);
  await assert.rejects(() => countOnly('bills?select=id'), RestError);
});

test('doFetch: a non-2xx response with a non-JSON/unparseable body still throws RestError with the status (never a silent empty result)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async () => ({
    ok: false,
    status: 502,
    json: async () => { throw new Error('not json'); },
    headers: { get: () => null },
  }));
  await assert.rejects(() => restGet('bills?select=id'), (err) => {
    assert.ok(err instanceof RestError);
    assert.equal(err.status, 502);
    return true;
  });
});

test('pagedFetch: page 3, size 50 sends Range 100-149 and returns total from content-range', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  let capturedHeaders;
  let capturedUrl;
  _setFetch(async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: 100 + i }));
    return mockResponse({ status: 206, rows, contentRange: '100-149/2037' });
  });
  const result = await pagedFetch('vote_casts?select=*', { page: 3, pageSize: 50, order: 'vote_date.desc' });
  assert.equal(capturedHeaders.Range, '100-149');
  assert.equal(capturedHeaders['Range-Unit'], 'items');
  assert.match(capturedUrl, /order=vote_date\.desc/);
  assert.equal(result.total, 2037);
  assert.equal(result.page, 3);
  assert.equal(result.pageSize, 50);
  assert.equal(result.rows.length, 50);
});

test('pagedFetch: page 1 defaults pageSize to 50 -> Range 0-49', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  let capturedHeaders;
  _setFetch(async (url, opts) => {
    capturedHeaders = opts.headers;
    return mockResponse({ status: 206, rows: [], contentRange: '*/0' });
  });
  await pagedFetch('bills?select=id', { page: 1 });
  assert.equal(capturedHeaders.Range, '0-49');
});

test('fetchAllRows: loops in 1000-row chunks until a short chunk (1000+1000+37 = 2037)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  const chunkSizes = [1000, 1000, 37];
  let calls = 0;
  const ranges = [];
  _setFetch(async (url, opts) => {
    ranges.push(opts.headers.Range);
    const n = chunkSizes[calls];
    calls += 1;
    const rows = Array.from({ length: n }, (_, i) => ({ id: i }));
    return mockResponse({ status: 206, rows, contentRange: null });
  });
  const rows = await fetchAllRows('vote_casts?select=id&legislator_id=eq.abc');
  assert.equal(rows.length, 2037);
  assert.equal(calls, 3, 'stops immediately after the short (37-row) chunk, no extra trailing call');
  assert.deepEqual(ranges, ['0-999', '1000-1999', '2000-2999']);
});

test('fetchAllRows: a single short first chunk makes exactly one call', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  let calls = 0;
  _setFetch(async () => {
    calls += 1;
    return mockResponse({ status: 200, rows: [{ id: 1 }, { id: 2 }], contentRange: null });
  });
  const rows = await fetchAllRows('bills?select=id');
  assert.equal(rows.length, 2);
  assert.equal(calls, 1);
});

test('countOnly: returns the content-range total as a number, no page of rows required', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async () => mockResponse({ status: 206, rows: [{ id: 1 }], contentRange: '0-0/4321' }));
  const total = await countOnly('bills?select=id');
  assert.equal(total, 4321);
});

// ============================================================================
// render.js
// ============================================================================

test('el: a hostile DB string becomes literal text, never markup (XSS load-bearing test)', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const div = el('div', {}, hostile);
  assert.equal(div.textContent, hostile);
  assert.equal(div.querySelector('img'), null);
});

test('el: rejects event-handler attributes with a typed error', () => {
  assert.throws(() => el('div', { onclick: 'alert(1)' }), UnsafeAttributeError);
  assert.throws(() => el('img', { onerror: 'alert(1)' }), UnsafeAttributeError);
});

test('el: rejects javascript: hrefs with a typed error', () => {
  assert.throws(() => el('a', { href: 'javascript:alert(1)' }, 'click'), UnsafeAttributeError);
  assert.throws(() => el('a', { href: '  JavaScript:alert(1)' }, 'click'), UnsafeAttributeError, 'case/whitespace variants too');
});

// Fix round 1 (task review): a bare `.trim()` only strips leading/trailing whitespace — a TAB or
// newline EMBEDDED in the middle of the scheme survives it, and browsers' URL parsers strip
// embedded TAB/CR/LF anywhere before scheme resolution (jsdom's .protocol confirms 'javascript:'
// for this exact construction), so the blocklist check silently let this through.
test('el: rejects a TAB-embedded javascript: scheme bypass (control chars stripped before scheme check)', () => {
  assert.throws(() => el('a', { href: 'jav\tascript:alert(1)' }, 'click'), UnsafeAttributeError);
});

// Fix round 1 (task review, finding 2): blocklisting javascript: alone is insufficient — switch
// to an ALLOWLIST of href schemes (http:, https:, mailto:, or no scheme at all/relative). This
// closes the general class, not just the one construction: data:text/html can run script in a
// clicked link exactly like javascript: can, and it must be rejected the same way.
test('el: href scheme allowlist rejects data: URLs', () => {
  assert.throws(() => el('a', { href: 'data:text/html,<script>alert(1)</script>' }, 'click'), UnsafeAttributeError);
});

test('el: href scheme allowlist still accepts relative paths and http(s)/mailto hrefs', () => {
  assert.equal(el('a', { href: '/person/abc-123' }, 'x').getAttribute('href'), '/person/abc-123');
  assert.equal(el('a', { href: 'https://example.com/bill/1' }, 'x').getAttribute('href'), 'https://example.com/bill/1');
  assert.equal(el('a', { href: 'http://example.com' }, 'x').getAttribute('href'), 'http://example.com');
  assert.equal(el('a', { href: 'mailto:someone@example.com' }, 'x').getAttribute('href'), 'mailto:someone@example.com');
});

// Micro-round (re-review, pre-existing LOW-MEDIUM): a href with NO matched scheme was treated as
// always-relative, but a protocol-relative URL ('//evil.com/x') has no scheme token either and
// still resolves cross-origin (browsers inherit the CURRENT page's scheme) — a spoofed-link
// vector if a DB source_url ever carried a leading '//'. A genuine same-site path never starts
// with '//' (real receipt URLs are absolute http(s)), so this is rejected outright, not
// allowlisted to some other scheme.
test('el: href guard rejects protocol-relative hrefs ("//host/path") — resolves cross-origin', () => {
  assert.throws(() => el('a', { href: '//evil.com/x' }, 'click'), UnsafeAttributeError);
});

test('el: href guard still accepts a genuine single-slash same-site path ("/person/x")', () => {
  assert.equal(el('a', { href: '/person/x' }, 'x').getAttribute('href'), '/person/x');
});

// ---------------------------------------------------------------------------
// FINAL REVIEW, finding 1 (CRITICAL, proven by execution in Chromium): the strip set was \t\r\n
// ONLY — three of the thirty-three codepoints a URL parser removes. WHATWG's URL parser removes
// leading AND trailing C0 controls and space (U+0000–U+0020) before anything else, so a href of
// '\u0001javascript:alert(1)' parses to a real javascript: URL and EXECUTES on click, while this
// guard saw a string whose first scheme-position token was '\u0001javascript' — no SCHEME_PATTERN
// match, therefore "relative", therefore allowed. The earlier ledger line claiming the strip
// "mirrored WHATWG" was simply false. Every C0 codepoint is pinned below (boundaries + interior
// samples), leading and embedded, for javascript: and data: and the protocol-relative form.
// ---------------------------------------------------------------------------

const C0_CODEPOINTS = Array.from({ length: 0x21 }, (_, i) => i); // U+0000..U+0020 inclusive (space)

test('el: EVERY C0 control (U+0000–U+0020) LEADING a javascript: href is rejected — the full WHATWG strip range, not just \\t\\r\\n', () => {
  for (const cp of C0_CODEPOINTS) {
    const href = `${String.fromCharCode(cp)}javascript:alert(1)`;
    assert.throws(
      () => el('a', { href }, 'click'),
      UnsafeAttributeError,
      `leading U+${cp.toString(16).padStart(4, '0').toUpperCase()} must not smuggle a javascript: scheme past the guard`,
    );
  }
});

test('el: EVERY C0 control (U+0000–U+0020) EMBEDDED mid-scheme in javascript: is rejected', () => {
  for (const cp of C0_CODEPOINTS) {
    const href = `jav${String.fromCharCode(cp)}ascript:alert(1)`;
    assert.throws(
      () => el('a', { href }, 'click'),
      UnsafeAttributeError,
      `embedded U+${cp.toString(16).padStart(4, '0').toUpperCase()} must not smuggle a javascript: scheme past the guard`,
    );
  }
});

test('el: the four named bypass constructions from the final review (\\u0000, \\u0001, \\u0008, \\u001F + javascript:/data:) all throw', () => {
  for (const c of ['\u0000', '\u0001', '\u0008', '\u001F']) {
    assert.throws(() => el('a', { href: `${c}javascript:alert(1)` }, 'x'), UnsafeAttributeError);
    assert.throws(() => el('a', { href: `${c}data:text/html,<script>alert(1)</script>` }, 'x'), UnsafeAttributeError);
    assert.throws(() => el('a', { href: `java${c}script:alert(1)` }, 'x'), UnsafeAttributeError);
  }
});

test('el: a C0-prefixed PROTOCOL-RELATIVE href ("\\u0001//evil.com/x") is still rejected — the strip runs before the // check', () => {
  assert.throws(() => el('a', { href: '\u0001//evil.com/x' }, 'x'), UnsafeAttributeError);
  assert.throws(() => el('a', { href: '\u0000\u0009\u001F//evil.com/x' }, 'x'), UnsafeAttributeError);
});

test('el: the same C0 bypasses are rejected on <img src> too (one guard, both attributes)', () => {
  for (const c of ['\u0000', '\u0001', '\u0008', '\u001F']) {
    assert.throws(() => el('img', { src: `${c}javascript:alert(1)` }), UnsafeAttributeError);
    assert.throws(() => el('img', { src: `${c}//evil.com/x.jpg` }), UnsafeAttributeError);
  }
  assert.equal(isSafeSrc('\u0001javascript:alert(1)'), false);
  assert.equal(isSafeSrc('\u0001//evil.com/x.jpg'), false);
});

// FINAL REVIEW, finding 1 (second half): after stripping, "no ALLOWLISTED scheme matched" must not
// silently mean "relative". A colon sitting in scheme position — before any '/', '?' or '#' — is a
// scheme the browser will try to resolve even when the token before it isn't a well-formed scheme
// per our own pattern (percent-encoded, digit-leading, etc.). Those are REFUSED, never treated as
// a site-internal path.
test('el: a colon in scheme position with no allowlisted scheme match is REJECTED, never treated as relative', () => {
  assert.throws(() => el('a', { href: 'jav%61script:alert(1)' }, 'x'), UnsafeAttributeError, 'percent-encoded scheme char');
  assert.throws(() => el('a', { href: '1javascript:alert(1)' }, 'x'), UnsafeAttributeError, 'digit-leading token is not a SCHEME_PATTERN match');
  assert.throws(() => el('a', { href: '_vbscript:msgbox(1)' }, 'x'), UnsafeAttributeError, 'underscore-leading token');
});

test('el: a colon AFTER the first /, ? or # is a real relative path and is still accepted', () => {
  assert.equal(el('a', { href: '/bill/abc:def' }, 'x').getAttribute('href'), '/bill/abc:def');
  assert.equal(el('a', { href: '/search?q=a:b' }, 'x').getAttribute('href'), '/search?q=a:b');
  assert.equal(el('a', { href: '/trust#a:b' }, 'x').getAttribute('href'), '/trust#a:b');
  assert.equal(el('a', { href: 'person/x' }, 'x').getAttribute('href'), 'person/x', 'schemeless relative, no colon at all');
});

// FINAL REVIEW, finding 1 (third half): the `typeof value !== 'string'` early RETURN meant a
// non-string href was set on the element completely unchecked (setAttribute stringifies it) — a
// silent bypass of every rule above for any caller that ever hands this a non-string. Fails loud
// instead; `isSafeSrc` keeps its own non-throwing false (it is the predicate form, by contract).
test('el: a NON-STRING href/src throws a typed error instead of being silently set unchecked', () => {
  assert.throws(() => el('a', { href: null }, 'x'), UnsafeAttributeError);
  assert.throws(() => el('a', { href: undefined }, 'x'), UnsafeAttributeError);
  assert.throws(() => el('a', { href: 42 }, 'x'), UnsafeAttributeError);
  assert.throws(() => el('a', { href: { toString: () => 'javascript:alert(1)' } }, 'x'), UnsafeAttributeError);
  assert.throws(() => el('img', { src: null }), UnsafeAttributeError);
});

test('el: rejects any attribute outside the {class, href, id, dataset} allowlist', () => {
  assert.throws(() => el('div', { title: 'hello' }), UnsafeAttributeError);
});

test('el: allows the class/href/id/dataset allowlist and sets them correctly', () => {
  const a = el('a', {
    class: 'btn', id: 'x', href: 'https://example.com/bill/1', dataset: { legId: '42' },
  }, 'Vote');
  assert.equal(a.className, 'btn');
  assert.equal(a.id, 'x');
  assert.equal(a.getAttribute('href'), 'https://example.com/bill/1');
  assert.equal(a.dataset.legId, '42');
  assert.equal(a.textContent, 'Vote');
});

// Task 6 extension (pre-flagged by the task-3 report: "later page tasks needing e.g. src/alt/type
// will need render.js extended at that point"). The photo section needs <img src alt> — src gets
// the SAME guard structure as href (control-char strip, protocol-relative rejection, scheme
// allowlist) but configured stricter: https-only, no relative-path allowance, since every real
// photoUrl() result (receipts.js: legislators.image_url or the bioguide derivation) is an
// absolute https URL — there is no legitimate case for allowing more than that on an <img src>.
test('el: allows src/alt attrs; a genuine https src is accepted', () => {
  const img = el('img', { src: 'https://unitedstates.github.io/images/congress/450x550/O000177.jpg', alt: 'Robert F. Onder' });
  assert.equal(img.getAttribute('src'), 'https://unitedstates.github.io/images/congress/450x550/O000177.jpg');
  assert.equal(img.getAttribute('alt'), 'Robert F. Onder');
});

test('el: src scheme allowlist rejects javascript: and data: URLs (hostile src)', () => {
  assert.throws(() => el('img', { src: 'javascript:alert(1)' }), UnsafeAttributeError);
  assert.throws(() => el('img', { src: 'data:image/svg+xml,<svg onload=alert(1)>' }), UnsafeAttributeError);
});

test('el: src guard rejects protocol-relative ("//evil.com/x.jpg") the same as href does', () => {
  assert.throws(() => el('img', { src: '//evil.com/x.jpg' }), UnsafeAttributeError);
});

// src is stricter than href on purpose: unlike href, a scheme-less relative src is REJECTED, not
// treated as a same-site path — no real photoUrl() result is ever relative, so there is nothing
// legitimate to preserve, and rejecting keeps the allowlist narrow (https only, nothing else).
test('el: src guard rejects a plain http: URL and a scheme-less relative path (https-only, no relative allowance)', () => {
  assert.throws(() => el('img', { src: 'http://example.com/x.jpg' }), UnsafeAttributeError);
  assert.throws(() => el('img', { src: '/img/local.jpg' }), UnsafeAttributeError);
});

// Fix round 3 micro-round (task review, NEW-C(b)): isSafeSrc is the non-throwing predicate form
// of the exact same guard el()'s src handling uses above — a caller that wants to CHECK a src
// before ever attempting to render it (person-page.js's renderPhoto) gets ONE copy of this
// security rule, not a second lookalike one.
test('isSafeSrc: a genuine https url is safe', () => {
  assert.equal(isSafeSrc('https://unitedstates.github.io/images/congress/450x550/O000177.jpg'), true);
});

test('isSafeSrc: http/javascript/data/protocol-relative/relative are all unsafe (matches el()\'s own rejections above)', () => {
  assert.equal(isSafeSrc('http://example.com/x.jpg'), false);
  assert.equal(isSafeSrc('javascript:alert(1)'), false);
  assert.equal(isSafeSrc('data:image/svg+xml,<svg onload=alert(1)>'), false);
  assert.equal(isSafeSrc('//evil.com/x.jpg'), false);
  assert.equal(isSafeSrc('/img/local.jpg'), false);
});

test('isSafeSrc: non-string input is unsafe (never throws)', () => {
  assert.equal(isSafeSrc(null), false);
  assert.equal(isSafeSrc(undefined), false);
  assert.equal(isSafeSrc(42), false);
});

test('el: real DOM node children are appended as-is, not stringified', () => {
  const span = el('span', {}, 'inner');
  const wrapper = el('div', {}, span);
  assert.equal(wrapper.firstChild, span);
});

test('clearChildren: removes all children', () => {
  const div = el('div', {}, 'a', 'b');
  assert.equal(div.childNodes.length, 2);
  clearChildren(div);
  assert.equal(div.childNodes.length, 0);
});

test('sectionState: failed state renders a retry button wired to onRetry', () => {
  const container = document.createElement('div');
  let called = false;
  sectionState(container, { state: 'failed', message: 'could not load', onRetry: () => { called = true; } });
  assert.equal(container.textContent.includes('could not load'), true);
  const btn = container.querySelector('button');
  assert.ok(btn, 'a retry button is rendered');
  btn.click();
  assert.equal(called, true);
});

// task-9 review round 2, NEW-2 (MEDIUM): a determinate not-found (no onRetry given at all) must
// not render a DEAD retry button — no button beats a button that silently does nothing on click.
test('sectionState: failed state with NO onRetry renders NO retry button (a determinate not-found offers no dead control)', () => {
  const container = document.createElement('div');
  sectionState(container, { state: 'failed', message: 'No such bill in our data.' });
  assert.equal(container.textContent.includes('No such bill in our data.'), true);
  assert.equal(container.querySelector('button'), null, 'no button at all — not a button that no-ops on click');
});

test('sectionState: failed state with onRetry explicitly null/undefined also renders NO retry button (same as omitted)', () => {
  const container1 = document.createElement('div');
  sectionState(container1, { state: 'failed', message: 'x', onRetry: null });
  assert.equal(container1.querySelector('button'), null);

  const container2 = document.createElement('div');
  sectionState(container2, { state: 'failed', message: 'x', onRetry: undefined });
  assert.equal(container2.querySelector('button'), null);
});

test('sectionState: empty state renders the honest-empty message, no retry button', () => {
  const container = document.createElement('div');
  sectionState(container, { state: 'empty', message: 'no recorded votes in our data for this period' });
  assert.equal(container.textContent.includes('no recorded votes in our data for this period'), true);
  assert.equal(container.querySelector('button'), null);
});

test('sectionState: loading state renders without throwing and clears prior content', () => {
  const container = document.createElement('div');
  container.appendChild(el('p', {}, 'stale content'));
  sectionState(container, { state: 'loading' });
  assert.equal(container.textContent.includes('stale content'), false);
});

test('sectionState: ready state clears the container for the caller to fill', () => {
  const container = document.createElement('div');
  container.appendChild(el('p', {}, 'placeholder'));
  sectionState(container, { state: 'ready' });
  assert.equal(container.childNodes.length, 0);
});

// Fix round 1 (task review, finding 3): an unrecognized state used to fall through to an empty
// <p> — exactly the plan's forbidden "a failed fetch renders as an empty section" (design spec
// §8), reachable by a simple caller typo (e.g. 'error' instead of 'failed'). Must throw loud
// instead of silently rendering the wrong-but-plausible-looking empty state.
test('sectionState: an unrecognized state throws a typed error rather than silently rendering empty', () => {
  const container = document.createElement('div');
  assert.throws(() => sectionState(container, { state: 'error', message: 'oops' }), InvalidSectionStateError);
  assert.equal(container.childNodes.length, 0, 'nothing rendered — the throw happens before any DOM mutation');
});

// Task 10: mountFooter's real content (design spec §6: "This page is linked from every footer";
// task-10 brief: 'Every fact links to its source. · [How this works](/trust) · [Data
// freshness](/trust#freshness) · [Attribution](/trust#attribution)'). Exact tagline text + exact
// link order/href/label — every page (index, person, legislator, bill, trust itself) renders this
// SAME footer through this one function, so getting it right here gets it right everywhere.
test('mountFooter: renders the exact tagline + three links (How this works / Data freshness / Attribution), in order, with the exact hrefs', () => {
  const footer = document.createElement('footer');
  mountFooter(footer);
  assert.ok(footer.textContent.includes('Every fact links to its source.'));
  const links = [...footer.querySelectorAll('a')];
  assert.equal(links.length, 3);
  assert.equal(links[0].textContent, 'How this works');
  assert.equal(links[0].getAttribute('href'), '/trust');
  assert.equal(links[1].textContent, 'Data freshness');
  assert.equal(links[1].getAttribute('href'), '/trust#freshness');
  assert.equal(links[2].textContent, 'Attribution');
  assert.equal(links[2].getAttribute('href'), '/trust#attribution');
});

test('mountFooter: clears any prior content before rendering (idempotent — safe to call again)', () => {
  const footer = document.createElement('footer');
  footer.appendChild(el('p', {}, 'stale'));
  mountFooter(footer);
  assert.equal(footer.textContent.includes('stale'), false);
});

// ============================================================================
// receipts.js
// ============================================================================

test('voteReceiptUrl: returns source_url, or null when absent', () => {
  assert.equal(voteReceiptUrl({ source_url: 'https://example.com/roll-call/1' }), 'https://example.com/roll-call/1');
  assert.equal(voteReceiptUrl({ source_url: null }), null);
  assert.equal(voteReceiptUrl({}), null);
});

test('photoUrl: image_url wins when set', () => {
  assert.equal(
    photoUrl({ image_url: 'https://img.example/1.jpg', bioguide_id: 'X000001' }),
    'https://img.example/1.jpg',
  );
});

test('photoUrl: falls back to the bioguide derivation when image_url is absent', () => {
  assert.equal(
    photoUrl({ image_url: null, bioguide_id: 'X000001' }),
    'https://unitedstates.github.io/images/congress/450x550/X000001.jpg',
  );
});

test('photoUrl: null when neither image_url nor bioguide_id is present', () => {
  assert.equal(photoUrl({}), null);
  assert.equal(photoUrl(null), null);
});

test('officialBillUrl: returns canonical_url, or null when absent', () => {
  assert.equal(officialBillUrl({ canonical_url: 'https://congress.gov/bill/x' }), 'https://congress.gov/bill/x');
  assert.equal(officialBillUrl({}), null);
});

// ============================================================================
// scripts/serve-site.js
// ============================================================================

test('applyRewrites: mirrors the exact four site/_redirects rules', () => {
  assert.equal(applyRewrites('/trust'), '/trust.html');
  assert.equal(applyRewrites('/person/abc-123/jane-doe'), '/person.html');
  assert.equal(applyRewrites('/legislator/xyz'), '/legislator.html');
  assert.equal(applyRewrites('/bill/1/hb-1'), '/bill.html');
  assert.equal(applyRewrites('/css/site.css'), '/css/site.css', 'non-matching paths pass through unchanged');
  assert.equal(applyRewrites('/trusty'), '/trusty', '/trust is an EXACT match, not a prefix');
});

test('contentTypeFor: maps html/js/css/json/svg/png by extension', () => {
  assert.match(contentTypeFor('index.html'), /text\/html/);
  assert.match(contentTypeFor('js/rest.js'), /text\/javascript/);
  assert.match(contentTypeFor('css/site.css'), /text\/css/);
  assert.match(contentTypeFor('data.json'), /application\/json/);
  assert.match(contentTypeFor('icon.svg'), /image\/svg/);
  assert.match(contentTypeFor('photo.png'), /image\/png/);
});

test('resolveSitePath: a normal request resolves to a path inside the site root', () => {
  const resolved = resolveSitePath(SITE_ROOT, '/js/rest.js');
  assert.ok(resolved.startsWith(SITE_ROOT));
});

test('resolveSitePath: root path resolves to index.html', () => {
  const resolved = resolveSitePath(SITE_ROOT, '/');
  assert.equal(resolved.endsWith('index.html'), true);
});

test('resolveSitePath: rejects classic dot-dot traversal with a typed error', () => {
  assert.throws(() => resolveSitePath(SITE_ROOT, '/../../../../etc/passwd'), PathTraversalError);
});

test('resolveSitePath: rejects percent-encoded (\'..%2f\' style) traversal with a typed error', () => {
  assert.throws(() => resolveSitePath(SITE_ROOT, '/..%2f..%2f..%2f..%2fetc%2fpasswd'), PathTraversalError);
  assert.throws(() => resolveSitePath(SITE_ROOT, '/%2e%2e/%2e%2e/%2e%2e/secret.txt'), PathTraversalError);
});

test('resolveSitePath: a path that traverses and lands back inside the root is fine', () => {
  const resolved = resolveSitePath(SITE_ROOT, '/js/../js/rest.js');
  assert.ok(resolved.startsWith(SITE_ROOT));
  assert.ok(resolved.endsWith('rest.js'));
});

test('createSiteServer: end-to-end smoke — serves index.html with the right content-type', async () => {
  const server = createSiteServer(SITE_ROOT);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try {
    const response = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], data }));
      }).on('error', reject);
    });
    assert.equal(response.status, 200);
    assert.match(response.contentType, /text\/html/);
    assert.ok(response.data.includes('<html'));
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// site/_headers (the production CSP) + scripts/serve-site.js serving the SAME file's headers.
// Final-review fix wave, finding 1 (defense in depth). The dev server PARSES site/_headers rather
// than carrying a second hand-written copy — one source of truth, no drift possible.
// ---------------------------------------------------------------------------

test('parseHeadersFile: reads the /* rule\'s headers, ignoring comments and blank lines', () => {
  const parsed = parseHeadersFile([
    '# a comment',
    '',
    '/*',
    '  Content-Security-Policy: default-src \'self\'',
    '  X-Content-Type-Options: nosniff',
    '',
    '/only-here/*',
    '  X-Scoped: yes',
  ].join('\n'));
  assert.deepEqual(parsed['/*'], {
    'Content-Security-Policy': "default-src 'self'",
    'X-Content-Type-Options': 'nosniff',
  });
  assert.deepEqual(parsed['/only-here/*'], { 'X-Scoped': 'yes' });
});

test('loadSiteHeaders: the real site/_headers carries a CSP with the exact directive set the site needs', () => {
  const headers = loadSiteHeaders(SITE_ROOT);
  const csp = headers['Content-Security-Policy'];
  assert.ok(csp, 'site/_headers must define a Content-Security-Policy for /*');
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' https:",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ]) {
    assert.ok(csp.includes(directive), `CSP must contain "${directive}" — got: ${csp}`);
  }
  assert.ok(!csp.includes('unsafe-inline'), "no 'unsafe-inline' anywhere — that would re-open the class the CSP exists to close");
  assert.ok(!csp.includes('unsafe-eval'), "no 'unsafe-eval' anywhere");
});

test("loadSiteHeaders: connect-src names the SAME Supabase origin site/config.js points at (hardcoded header vs config drift)", async () => {
  const { SUPABASE_URL } = await import('../site/config.js');
  const csp = loadSiteHeaders(SITE_ROOT)['Content-Security-Policy'];
  const connectSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('connect-src'));
  assert.ok(connectSrc, 'CSP must define connect-src explicitly (default-src would block the Supabase fetch)');
  assert.ok(connectSrc.includes("'self'"), 'connect-src must allow our own origin (the /geocode function)');
  const origin = new URL(SUPABASE_URL).origin;
  assert.ok(
    connectSrc.includes(origin),
    `connect-src must name site/config.js's Supabase origin (${origin}) — got: ${connectSrc}`,
  );
});

test('every page shell loads its bootstrap from an EXTERNAL module — no inline <script>, which script-src \'self\' would block', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const page of ['index.html', 'person.html', 'legislator.html', 'bill.html', 'trust.html']) {
    // eslint-disable-next-line no-await-in-loop
    const html = await readFile(`${SITE_ROOT}/${page}`, 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(html), `${page} still has an inline <script> block`);
    assert.match(html, /<script type="module" src="\/js\/boot-[a-z]+\.js"><\/script>/, `${page} must load an external boot module`);
    assert.ok(!html.includes('href="data:'), `${page} must not use a data: URL (img-src has no data: allowance)`);
  }
});

test('createSiteServer: serves the site/_headers CSP on a real response (dev mirrors production)', async () => {
  const server = createSiteServer(SITE_ROOT);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try {
    const headers = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers));
      }).on('error', reject);
    });
    assert.equal(headers['content-security-policy'], loadSiteHeaders(SITE_ROOT)['Content-Security-Policy']);
    assert.equal(headers['x-content-type-options'], 'nosniff');
  } finally {
    server.close();
  }
});

test('createSiteServer: the security headers ride on 404 and 400 responses too, not just 200s', async () => {
  const server = createSiteServer(SITE_ROOT);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  const get = (path) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });
  try {
    const missing = await get('/does-not-exist.html');
    assert.equal(missing.status, 404);
    assert.ok(missing.headers['content-security-policy']);
    const traversal = await get('/..%2f..%2f..%2fpackage.json');
    assert.equal(traversal.status, 400);
    assert.ok(traversal.headers['content-security-policy']);
  } finally {
    server.close();
  }
});

test('createSiteServer: a 404 for a genuinely missing file (not a crash)', async () => {
  const server = createSiteServer(SITE_ROOT);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try {
    const status = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/does-not-exist.html`, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 404);
  } finally {
    server.close();
  }
});

test('createSiteServer: a traversal request is rejected (400), not served', async () => {
  const server = createSiteServer(SITE_ROOT);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try {
    const status = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/..%2f..%2f..%2fpackage.json`, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 400);
  } finally {
    server.close();
  }
});

// ============================================================================
// site/functions/geocode.js — the one allowed server code (task 8). PRIVACY CONTRACT
// (review-blocking): the address goes to the Census request and nowhere else — no logging, no
// analytics, no cache writes, no error reporting that includes the address.
// ============================================================================

test('buildUpstreamUrl: builds the exact Census Geocoder request URL, address percent-encoded', () => {
  const u = buildUpstreamUrl('201 W Capitol Ave, Jefferson City, MO');
  assert.equal(u.origin + u.pathname, 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress');
  assert.equal(u.searchParams.get('address'), '201 W Capitol Ave, Jefferson City, MO');
  assert.equal(u.searchParams.get('benchmark'), 'Public_AR_Current');
  // LIVE CENSUS-SHAPE CORRECTION (task-8 report): the brief's own draft code used
  // vintage=Current, which the real Census API rejects outright (400 "Invalid vintage in
  // request") — verified live against
  // https://geocoding.geo.census.gov/geocoder/vintages?benchmark=Public_AR_Current&format=json,
  // whose one Public_AR_Current-paired vintage is named Current_Current.
  assert.equal(u.searchParams.get('vintage'), 'Current_Current');
  assert.equal(u.searchParams.get('format'), 'json');
});

// Fix round 1 (task-8 review, CONTROLLER RULING): POST with a JSON body, not GET with the
// address on the query string — Cloudflare records ClientRequestURI (including query strings) on
// its OWN edge logs regardless of anything this function does; POST's body is not part of that
// surface. A minimal fake `request` carrying only `.json()` (the one method onRequestPost reads)
// is enough — mirrors the real Cloudflare Request shape closely enough for this handler.
function fakeRequest(body) {
  return { json: async () => body };
}

test('onRequestPost: no address in the JSON body -> 400 {error: "address required"}, upstream never called', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not be called'); };
  try {
    const res = await onRequestPost({ request: fakeRequest({}) });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'address required' });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('onRequestPost: an unparseable JSON body -> 400, never throws out of the handler', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not be called'); };
  try {
    const badRequest = { json: async () => { throw new SyntaxError('bad json'); } };
    const res = await onRequestPost({ request: badRequest });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('onRequestPost: an address over 500 chars -> 400, upstream never called', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not be called'); };
  try {
    const longAddress = 'a'.repeat(501);
    const res = await onRequestPost({ request: fakeRequest({ address: longAddress }) });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('onRequestPost: a non-string address (hostile/malformed body) -> 400, upstream never called', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not be called'); };
  try {
    const res = await onRequestPost({ request: fakeRequest({ address: { nested: 'object' } }) });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('onRequestPost: a successful upstream fetch passes the Census JSON straight through', async () => {
  const originalFetch = globalThis.fetch;
  const fakeGeocodeResult = { result: { addressMatches: [{ geographies: {} }] } };
  globalThis.fetch = async (url, opts) => {
    assert.ok(String(url).includes('vintage=Current_Current'));
    assert.ok(opts && opts.signal, 'a timeout AbortSignal is attached to the upstream request');
    return { ok: true, json: async () => fakeGeocodeResult };
  };
  try {
    const res = await onRequestPost({ request: fakeRequest({ address: '201 W Capitol Ave' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), fakeGeocodeResult);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('onRequestPost: a non-ok upstream response -> 502 generic error, never the upstream body verbatim', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ some: 'internal census detail' }) });
  try {
    const res = await onRequestPost({ request: fakeRequest({ address: 'x' }) });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'geocoder unavailable' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('onRequestPost: a thrown/timed-out upstream fetch -> 502 generic error, never throws out of the handler', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network fault'); };
  try {
    const res = await onRequestPost({ request: fakeRequest({ address: 'x' }) });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'geocoder unavailable' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('onRequestPost: never calls console.log/console.error (no-logging privacy contract, review-blocking)', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  let logCalls = 0;
  console.log = () => { logCalls += 1; };
  console.error = () => { logCalls += 1; };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: { addressMatches: [] } }) });
  try {
    await onRequestPost({ request: fakeRequest({ address: 'some private address' }) });
    assert.equal(logCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }
});

// ============================================================================
// scripts/serve-site.js — the /geocode dev passthrough (task 8). Same upstream-URL builder as
// the Pages Function (buildUpstreamUrl, imported directly — one copy, not two). POST/JSON body,
// mirroring onRequestPost exactly (CONTROLLER RULING, fix round 1) — the global `fetch` used
// below to DRIVE the requests is the real Node fetch (this server's own upstream fetch is
// separately overridden via _setGeocodeFetch), so this exercises the real HTTP/JSON body path
// end to end, not a hand-built request object.
// ============================================================================

test('createSiteServer: POST /geocode with a JSON body passes address+params to the SAME upstream URL the Pages Function builds, returns the upstream JSON', async () => {
  let capturedUrl = null;
  _setGeocodeFetch(async (url) => {
    capturedUrl = String(url);
    return { ok: true, json: async () => ({ result: { addressMatches: [] } }) };
  });
  const server = createSiteServer(SITE_ROOT);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/geocode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: '201 W Capitol Ave' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { result: { addressMatches: [] } });
    assert.ok(capturedUrl.includes('vintage=Current_Current'));
    assert.ok(capturedUrl.includes('address=201'));
  } finally {
    server.close();
    _setGeocodeFetch(null);
  }
});

test('createSiteServer: POST /geocode with no address in the body -> 400, upstream never called', async () => {
  let called = false;
  _setGeocodeFetch(async () => { called = true; return { ok: true, json: async () => ({}) }; });
  const server = createSiteServer(SITE_ROOT);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/geocode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  } finally {
    server.close();
    _setGeocodeFetch(null);
  }
});

test('createSiteServer: POST /geocode when the upstream fetch fails -> 502, never crashes the server', async () => {
  _setGeocodeFetch(async () => { throw new Error('network fault'); });
  const server = createSiteServer(SITE_ROOT);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/geocode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'x' }),
    });
    assert.equal(res.status, 502);
  } finally {
    server.close();
    _setGeocodeFetch(null);
  }
});

test('createSiteServer: GET /geocode (the old query-string shape) is no longer routed to the passthrough at all — falls through to a plain 404, never leaks an address onto our own request-line logging surface via a route that still works', async () => {
  let called = false;
  _setGeocodeFetch(async () => { called = true; return { ok: true, json: async () => ({}) }; });
  const server = createSiteServer(SITE_ROOT);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try {
    const status = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/geocode?address=201+W+Capitol+Ave`, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 404);
    assert.equal(called, false);
  } finally {
    server.close();
    _setGeocodeFetch(null);
  }
});

// ============================================================================
// site/js/trust-page.js — Task 10, the trust page (.superpowers/sdd/2026-07-30-public-site/
// task-10-brief.md). #metrics renders vote-charts.js's own METRIC_DEFINITIONS verbatim (single-
// source contract — Task 10 never paraphrases it); #counts and #freshness are the page's two live
// sections (countOnly numbers; the FULL public_freshness table, unlike the profile page's own
// jurisdiction-scoped subset), each independently three-stated.
// ============================================================================

test('COUNT_SPECS: exactly the five live counts the brief names (vote casts, bills, legislators, published summaries, published glossary terms)', () => {
  assert.equal(COUNT_SPECS.length, 5);
  const byKey = Object.fromEntries(COUNT_SPECS.map((s) => [s.key, s]));
  assert.equal(byKey.voteCasts.path, 'vote_casts?select=id');
  assert.equal(byKey.voteCasts.label, 'Vote casts');
  assert.equal(byKey.bills.path, 'bills?select=id');
  assert.equal(byKey.bills.label, 'Bills');
  assert.equal(byKey.legislators.path, 'legislators?select=id');
  assert.equal(byKey.legislators.label, 'Legislators');
  // summaries/glossary_terms mirror the SAME status=eq.published filter bill-page.js/
  // person-page.js already use (RLS also enforces it — anon_read_published, migrations 0001/0007
  // — this is belt-and-braces, matching the rest of the codebase's convention, not a new rule).
  assert.equal(byKey.summaries.path, 'summaries?select=id&status=eq.published');
  assert.equal(byKey.summaries.label, 'Published summaries');
  assert.equal(byKey.glossaryTerms.path, 'glossary_terms?select=id&status=eq.published');
  assert.equal(byKey.glossaryTerms.label, 'Published glossary terms');
});

test('renderMetricDefinitions: loops over ALL FOUR METRIC_DEFINITIONS keys (including the staleness disclosure), rendering title/body verbatim — never a paraphrase', () => {
  const container = document.createElement('div');
  renderMetricDefinitions(container);
  const headings = [...container.querySelectorAll('h3')].map((h) => h.textContent);
  assert.deepEqual(headings, [
    METRIC_DEFINITIONS.distribution.title,
    METRIC_DEFINITIONS.partyComparison.title,
    METRIC_DEFINITIONS.cohesion.title,
    METRIC_DEFINITIONS.staleness.title,
  ]);
  const bodies = [...container.querySelectorAll('p')].map((p) => p.textContent);
  assert.deepEqual(bodies, [
    METRIC_DEFINITIONS.distribution.body,
    METRIC_DEFINITIONS.partyComparison.body,
    METRIC_DEFINITIONS.cohesion.body,
    METRIC_DEFINITIONS.staleness.body,
  ]);
});

test('renderMetricDefinitions: clears prior content before rendering', () => {
  const container = document.createElement('div');
  container.appendChild(el('p', {}, 'stale'));
  renderMetricDefinitions(container);
  assert.equal(container.textContent.includes('stale'), false);
});

test('loadCountsSection: fetches all five countOnly numbers via the SAME rest.js countOnly, renders them ready (three-stated)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  const totals = {
    vote_casts: 1462338, bills: 38252, legislators: 1607, summaries: 10, glossary_terms: 116,
  };
  _setFetch(async (url) => {
    const hit = Object.entries(totals).find(([table]) => url.includes(`/${table}?`));
    return mockResponse({ status: 206, rows: [{ id: 1 }], contentRange: `0-0/${hit[1]}` });
  });
  const container = document.createElement('div');
  const results = await loadCountsSection(container);
  assert.deepEqual(results.map((r) => r.value), [1462338, 38252, 1607, 10, 116]);
  assert.ok(container.textContent.includes('Vote casts'));
  assert.ok(container.textContent.includes('1462338'));
  assert.ok(container.textContent.includes('Published summaries'));
  assert.ok(container.textContent.includes('10'));
  assert.ok(container.textContent.includes('Published glossary terms'));
  assert.ok(container.textContent.includes('116'));
  assert.equal(container.querySelector('.section-state'), null, 'ready state — no loading/failed message left behind');
});

test('loadCountsSection: a failed countOnly fetch renders the FAILED state with a working retry — never an empty/zero-looking section', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async () => mockResponse({ status: 500, rows: { message: 'canceling statement due to statement timeout' } }));
  const container = document.createElement('div');
  await assert.rejects(() => loadCountsSection(container));
  assert.ok(container.textContent.includes("Couldn't load live counts"));
  assert.ok(container.querySelector('button'), 'a retry button is rendered');
});

test('loadFreshnessSection (trust page): renders the FULL public_freshness table, unfiltered — including sources a profile page\'s jurisdiction scoping would exclude (e.g. "gloss", "summarize") — proving this is the whole table, not the person-page.js jurisdiction-scoped subset', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  const rows = [
    { source: 'legiscan', status: 'succeeded', finished_at: '2026-07-29T16:32:12.831+00:00', quarantined_days: 0 },
    { source: 'gloss', status: 'partial', finished_at: '2026-07-29T00:04:17.534+00:00', quarantined_days: 2 },
    { source: 'summarize', status: 'succeeded', finished_at: null, quarantined_days: 0 },
  ];
  _setFetch(async () => mockResponse({ status: 200, rows, contentRange: null }));
  const container = document.createElement('div');
  const result = await loadFreshnessSection(container);
  assert.equal(result.length, 3);
  const table = container.querySelector('table');
  assert.ok(table, 'a real table renders');
  assert.equal(table.querySelectorAll('tbody tr').length, 3);
  assert.ok(container.textContent.includes('legiscan'));
  assert.ok(container.textContent.includes('gloss'));
  assert.ok(container.textContent.includes('summarize'));
  assert.ok(container.textContent.includes('2'), 'the quarantined-day count renders');
  assert.ok(container.textContent.includes('(never)'), 'a null finished_at renders honestly, never blank');
});

test('loadFreshnessSection (trust page): zero rows renders the honest EMPTY state, not a blank table', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async () => mockResponse({ status: 200, rows: [], contentRange: null }));
  const container = document.createElement('div');
  await loadFreshnessSection(container);
  assert.equal(container.querySelector('table'), null);
  assert.ok(container.textContent.length > 0);
});

test('loadFreshnessSection (trust page): a failed fetch renders FAILED with a working retry, never an empty-looking table', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async () => mockResponse({ status: 503, rows: { message: 'server unavailable' } }));
  const container = document.createElement('div');
  await assert.rejects(() => loadFreshnessSection(container));
  assert.ok(container.textContent.includes("Couldn't load freshness data"));
  assert.ok(container.querySelector('button'), 'a retry button is rendered');
});

// Task-10 review, LOW-1: #attribution's two verbatim quotes render from their OWN single source
// (bill-page.js's MO_DISCLAIMER_TEXT, copy.js's PRIVACY_CONTRACT_TEXT) rather than a hand-typed
// second copy in trust.html — asserted here exactly, so a future wording change to either source
// string is caught the moment this page's rendering falls out of sync with it.
test('renderAttributionCopy: fills both verbatim-quote placeholders from their single-source constants', () => {
  const moSpan = el('span', { id: 'attribution-mo-disclaimer' });
  const privacySpan = el('span', { id: 'attribution-privacy-contract' });
  document.body.appendChild(moSpan);
  document.body.appendChild(privacySpan);
  try {
    renderAttributionCopy();
    assert.equal(document.getElementById('attribution-mo-disclaimer').textContent, MO_DISCLAIMER_TEXT);
    assert.equal(document.getElementById('attribution-privacy-contract').textContent, PRIVACY_CONTRACT_TEXT);
  } finally {
    document.body.removeChild(moSpan);
    document.body.removeChild(privacySpan);
  }
});

test('renderAttributionCopy: missing placeholders (e.g. a partial fixture) never throws', () => {
  assert.doesNotThrow(() => renderAttributionCopy());
});

// ============================================================================
// Footer regression test (Task 10 review, LOW-2): every real site page — driven through
// createSiteServer's own routing (the SAME _redirects/applyRewrites rules production serves
// through, not a hand-picked file list) — serves the shared footer mount point AND its own
// bootstrap script. Catches the exact class of bug "four of five pages wire mountFooter, one was
// missed" without relying on a human re-checking each page by hand.
// ============================================================================
// Final-review fix wave (CSP): the bootstrap is no longer inline in the page shell, so this now
// follows the chain the browser follows — page shell -> external /js/boot-*.js -> the page module
// and its bootstrap call. Both hops are fetched through the SAME server, so a boot module that
// 404s (a typo in the src, a file never committed) fails this test instead of shipping a page
// whose script silently never runs.
test('Every page (index, trust, person, legislator, bill) serves the footer mount point + its own bootstrap script', async () => {
  const server = createSiteServer(SITE_ROOT);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  const routes = [
    { path: '/', boot: '/js/boot-directory.js', module: './directory-page.js', bootstrap: 'bootstrapDirectoryPage' },
    { path: '/trust', boot: '/js/boot-trust.js', module: './trust-page.js', bootstrap: 'bootstrapTrustPage' },
    { path: '/person/test-id', boot: '/js/boot-person.js', module: './person-page.js', bootstrap: 'bootstrapPersonPage' },
    { path: '/legislator/test-id', boot: '/js/boot-legislator.js', module: './legislator-page.js', bootstrap: 'bootstrapLegislatorPage' },
    { path: '/bill/test-id', boot: '/js/boot-bill.js', module: './bill-page.js', bootstrap: 'bootstrapBillPage' },
  ];
  const get = (p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${p}`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
  try {
    for (const {
      path, boot, module, bootstrap,
    } of routes) {
      // eslint-disable-next-line no-await-in-loop -- sequential smoke over a small fixed route list
      const html = await get(path);
      assert.ok(html.body.includes('<footer id="site-footer">'), `${path}: footer mount point present`);
      assert.ok(html.body.includes(`src="${boot}"`), `${path}: loads its own boot module (${boot})`);
      // eslint-disable-next-line no-await-in-loop
      const bootJs = await get(boot);
      assert.equal(bootJs.status, 200, `${boot}: must actually be served (a 404 here = a page whose script never runs)`);
      assert.ok(bootJs.body.includes(module), `${boot}: imports its page module (${module})`);
      assert.ok(bootJs.body.includes(`${bootstrap}()`), `${boot}: calls its own bootstrap function (${bootstrap})`);
    }
  } finally {
    server.close();
  }
});
