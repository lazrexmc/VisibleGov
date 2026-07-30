import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { JSDOM } from 'jsdom';

import {
  restGet, pagedFetch, fetchAllRows, countOnly, _setFetch, _setConfig, ConfigError,
} from '../site/js/rest.js';
import {
  el, clearChildren, sectionState, mountFooter, UnsafeAttributeError, InvalidSectionStateError,
} from '../site/js/render.js';
import { voteReceiptUrl, photoUrl, officialBillUrl } from '../site/js/receipts.js';
import {
  resolveSitePath, applyRewrites, createSiteServer, contentTypeFor, SITE_ROOT, PathTraversalError,
} from '../scripts/serve-site.js';

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

test('restGet: throws a typed ConfigError (never a silent 401) when config is empty', async () => {
  _setConfig({ url: '', anonKey: '' });
  await assert.rejects(() => restGet('legislators?select=id'), ConfigError);
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' }); // restore
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

test('mountFooter: renders placeholder attribution text (Task 10 fills real content)', () => {
  const footer = document.createElement('footer');
  mountFooter(footer);
  assert.ok(footer.textContent.length > 0);
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
