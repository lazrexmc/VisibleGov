import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// ============================================================================
// Fix round 1 (RULED SCOPE EXTENSION): the save-before-decide UX fix (controller ruling 3) is
// pure client-side DOM/fetch orchestration in src/review/page.html — nothing server.js does
// changed to build it, so tests/review-logic.test.js's fake-Supabase-client route tests can't
// exercise it at all. This file loads the REAL page.html into jsdom (not a hand-copied
// reimplementation — real drift risk if the two ever disagreed) with a mocked `fetch`, and drives
// the actual shipped script through page.html's own `__registerTestHooks` seam (see that file's
// own comment on it — inert in every real browser, only wired up when a test explicitly defines
// window.__registerTestHooks before the inline <script> runs).
//
// currentId/currentGlossaryId are set by loadQueue/loadGlossaryQueue (the "pick an item from the
// dropdown" flow), NOT by loadItem/loadGlossaryItem directly — every test below drives the real
// queue-then-item flow via loadQueue()/loadGlossaryQueue() rather than calling loadItem directly,
// so currentId is set exactly the way a real page interaction sets it.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_HTML_PATH = path.join(__dirname, '../src/review/page.html');
const PAGE_HTML = readFileSync(PAGE_HTML_PATH, 'utf8');

// Every boot-time load (loadQueue/loadGlossaryQueue/loadIdentityQueue, all fired-and-forgotten at
// the bottom of the script) needs a response shape each route's own defensive checks tolerate
// without throwing — the summary queue's `for (const it of items)` is the one fragile spot (a
// bare array, checked outside its own try/catch), everything else checks `.available` first and
// degrades safely on any other shape. Tests override specific URLs on top of this base.
function defaultFetchResponse(url) {
  if (url === '/api/queue') return { status: 200, body: [] };
  return { status: 200, body: { available: true, items: [] } };
}

// Builds a controllable fetch mock: `handlers` is an ordered list of {match(url,method,body),
// respond} checked in order before falling back to defaultFetchResponse. Every call (URL, method,
// parsed JSON body) is recorded in the returned array for order/content assertions.
function makeFetchMock(handlers = []) {
  const calls = [];
  const fn = async (url, opts) => {
    const method = opts?.method || 'GET';
    const body = opts?.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method, body });
    for (const h of handlers) {
      if (h.match(url, method, body)) {
        const r = h.respond(url, method, body) || {};
        const status = r.status ?? 200;
        return { ok: status >= 200 && status < 300, status, json: async () => (r.body ?? {}) };
      }
    }
    const fallback = defaultFetchResponse(url);
    return { ok: true, status: fallback.status, json: async () => fallback.body };
  };
  fn.calls = calls;
  return fn;
}

// Loads the REAL page.html into jsdom with `fetchImpl` wired as window.fetch, waits for the
// script's own test-hook registration, and hands back the hooks object (loadQueue/postDecision/
// loadGlossaryQueue/postGlossaryDecision/state getters — see page.html's own
// __registerTestHooks block) plus the live `document` for direct DOM inspection/mutation (e.g.
// simulating Lance typing into a textarea).
function loadPage(fetchImpl) {
  let hooks;
  const dom = new JSDOM(PAGE_HTML, {
    url: 'http://127.0.0.1:8991/',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.fetch = fetchImpl;
      window.__registerTestHooks = (h) => { hooks = h; };
    },
  });
  if (!hooks) throw new Error('test hooks were never registered — the inline <script> did not run to completion');
  return { document: dom.window.document, hooks, setFetch: (f) => { dom.window.fetch = f; } };
}

function postCallsTo(fetchCalls, endpoint) {
  return fetchCalls.filter((c) => c.url === endpoint && c.method === 'POST');
}

// ============================================================================
// Summary tab (postDecision / autoSaveSummaryEditIfDirty)
// ============================================================================

// Queue+item mocks that put `item` at the top of the summary queue and serve it back on
// /api/item/:id, so loadQueue() naturally sets currentId the way a real dropdown selection would.
function summaryQueueMocks(item) {
  return [
    { match: (url) => url === '/api/queue', respond: () => ({ body: [{ id: item.id, status: item.status, created_at: '2026-01-01T00:00:00Z', bill: { identifier: 'HR 1', title: 'A Bill' } }] }) },
    { match: (url) => url === `/api/item/${item.id}`, respond: () => ({ body: { summary: item, bill: null, text: null, vote: null, verification: null } }) },
  ];
}

test('summary tab: dirty draft-edit auto-saves (its own edit POST) BEFORE the requested decision, both logged in order', async () => {
  const item = { id: 'sum-1', status: 'draft', body_md: 'original text' };
  const { document, hooks, setFetch } = loadPage(makeFetchMock(summaryQueueMocks(item)));
  await hooks.loadQueue();
  // Field-by-field, not assert.deepEqual: getSummaryState()'s return object is constructed inside
  // jsdom's own vm realm, so its Object prototype is a different reference from a plain object
  // literal here even when structurally identical — deepStrictEqual's realm-sensitive prototype
  // check would false-fail on that alone. Primitive string comparisons via assert.equal don't care
  // about realms.
  const state1 = hooks.getSummaryState();
  assert.equal(state1.currentId, 'sum-1');
  assert.equal(state1.lastLoadedBodyMd, 'original text');
  assert.equal(state1.currentSummaryStatus, 'draft');

  document.getElementById('draft-edit').value = 'edited text — NOT yet saved';

  const mock = makeFetchMock([
    { match: (url, method, body) => url === '/api/decision' && body.action === 'edit', respond: () => ({ body: { status: 'draft' } }) },
    { match: (url, method, body) => url === '/api/decision' && body.action === 'approve', respond: () => ({ body: { status: 'approved' } }) },
  ]);
  setFetch(mock);
  await hooks.postDecision('approve');

  const decisionCalls = postCallsTo(mock.calls, '/api/decision');
  assert.equal(decisionCalls.length, 2, 'both the auto-save and the requested decision are logged as separate actions');
  assert.equal(decisionCalls[0].body.action, 'edit', 'the edit is saved FIRST');
  assert.equal(decisionCalls[0].body.body_md, 'edited text — NOT yet saved');
  assert.equal(decisionCalls[1].body.action, 'approve', 'the originally-requested decision follows');
  assert.equal(hooks.getSummaryState().lastLoadedBodyMd, 'edited text — NOT yet saved', 'the tracked "last saved" value advances once the auto-save succeeds');
});

test('summary tab: a CLEAN draft-edit (unchanged since load) fires only the requested decision, no auto-save call', async () => {
  const item = { id: 'sum-2', status: 'draft', body_md: 'stays exactly this' };
  const { hooks, setFetch } = loadPage(makeFetchMock(summaryQueueMocks(item)));
  await hooks.loadQueue();

  const mock = makeFetchMock([
    { match: (url, method, body) => url === '/api/decision' && body.action === 'reject', respond: () => ({ body: { status: 'rejected' } }) },
  ]);
  setFetch(mock);
  await hooks.postDecision('reject');

  const decisionCalls = postCallsTo(mock.calls, '/api/decision');
  assert.equal(decisionCalls.length, 1, 'no auto-save fires when nothing was actually edited');
  assert.equal(decisionCalls[0].body.action, 'reject');
});

test('summary tab: auto-save failing aborts the decision entirely — the requested action is NEVER sent, the edit is left exactly as typed', async () => {
  const item = { id: 'sum-3', status: 'draft', body_md: 'original' };
  const { document, hooks, setFetch } = loadPage(makeFetchMock(summaryQueueMocks(item)));
  await hooks.loadQueue();
  document.getElementById('draft-edit').value = 'a dirty edit the server will reject';

  const mock = makeFetchMock([
    { match: (url, method, body) => url === '/api/decision' && body.action === 'edit', respond: () => ({ status: 400, body: { error: 'body_md is required for edit' } }) },
    { match: (url, method, body) => url === '/api/decision' && body.action === 'approve', respond: () => ({ body: { status: 'approved' } }) },
  ]);
  setFetch(mock);
  await hooks.postDecision('approve');

  const decisionCalls = postCallsTo(mock.calls, '/api/decision');
  assert.equal(decisionCalls.length, 1, 'only the failed auto-save attempt was sent — approve never fired');
  assert.equal(decisionCalls[0].body.action, 'edit');
  assert.equal(document.getElementById('draft-edit').value, 'a dirty edit the server will reject', 'the edit is left untouched, never silently discarded');
  assert.equal(hooks.getSummaryState().lastLoadedBodyMd, 'original', 'the tracked "last saved" value does NOT advance on a failed auto-save');
});

test('summary tab: a dirty draft-edit on a status where edit is NOT legal (approved) never attempts an auto-save — draft-edit is also read-only there', async () => {
  const item = { id: 'sum-4', status: 'approved', body_md: 'locked content' };
  const { document, hooks, setFetch } = loadPage(makeFetchMock(summaryQueueMocks(item)));
  await hooks.loadQueue();
  assert.equal(document.getElementById('draft-edit').readOnly, true, 'nothing legal to save it to, so the field itself is locked');

  // Simulate a value change bypassing the readOnly attribute (defensive-path coverage — proves
  // postDecision's own status gate, not just the UI affordance, is what actually protects this).
  document.getElementById('draft-edit').value = 'bypassed the readonly attribute somehow';

  const mock = makeFetchMock([
    { match: (url, method, body) => url === '/api/decision' && body.action === 'publish', respond: () => ({ body: { status: 'published' } }) },
  ]);
  setFetch(mock);
  await hooks.postDecision('publish');

  const decisionCalls = postCallsTo(mock.calls, '/api/decision');
  assert.equal(decisionCalls.length, 1, 'no edit auto-save attempted — it is not a legal action from approved');
  assert.equal(decisionCalls[0].body.action, 'publish');
});

// ============================================================================
// Glossary tab (postGlossaryDecision / autoSaveGlossaryEditIfDirty) — mirrors the summary tab's
// tests exactly, over the actual glossary code path (this closes the SAME test gap the original
// ruling-3 fix round left open — no dedicated test previously proved this mechanism worked either).
// ============================================================================

// computeGlossaryGroups (page.html) buckets by status/needs_mapping/has_gloss/verified, and only
// the flagged/approved buckets are visible by DEFAULT (everything else sits behind a collapsed
// toggle) — the queue-list entry must land in one of those two so loadGlossaryQueue() actually
// reaches loadGlossaryItem() at all. status:'approved' lands in the always-visible `approved`
// bucket unconditionally; for the draft-status tests, verified:'flagged' + has_gloss:true lands
// in the always-visible `flagged` bucket instead.
function glossaryQueueMocks(term, { queueVerified = 'flagged' } = {}) {
  return [
    {
      match: (url) => url === '/api/glossary/queue',
      respond: () => ({
        body: {
          available: true,
          items: [{
            id: term.id, status: term.status, term: term.term, kind: term.kind, citation: term.citation,
            needs_mapping: false, has_gloss: Boolean(term.gloss_md), created_at: '2026-01-01T00:00:00Z', verified: queueVerified,
          }],
        },
      }),
    },
    { match: (url) => url === `/api/glossary/item/${term.id}`, respond: () => ({ body: { available: true, term, verification: null } }) },
  ];
}

test('glossary tab: a dirty gloss-edit auto-saves BEFORE the requested decision, both logged in order', async () => {
  const term = {
    id: 'term-1', status: 'draft', term: 'X', kind: 'statute', citation: 'c', gloss_md: 'original gloss', supported_by_quote: null, source_url: null, needs_mapping: false,
  };
  const { document, hooks, setFetch } = loadPage(makeFetchMock(glossaryQueueMocks(term)));
  await hooks.loadGlossaryQueue();
  // Field-by-field for the same cross-realm reason as the summary-tab test above.
  const state1 = hooks.getGlossaryState();
  assert.equal(state1.currentGlossaryId, 'term-1');
  assert.equal(state1.lastLoadedGlossMd, 'original gloss');
  assert.equal(state1.currentGlossaryStatus, 'draft');

  document.getElementById('glossary-edit').value = 'a revised, not-yet-saved gloss';

  const mock = makeFetchMock([
    { match: (url, method, body) => url === '/api/glossary/decision' && body.action === 'edit', respond: () => ({ body: { status: 'draft' } }) },
    { match: (url, method, body) => url === '/api/glossary/decision' && body.action === 'approve', respond: () => ({ body: { status: 'approved' } }) },
  ]);
  setFetch(mock);
  await hooks.postGlossaryDecision('approve');

  const decisionCalls = postCallsTo(mock.calls, '/api/glossary/decision');
  assert.equal(decisionCalls.length, 2, 'both the auto-save and the requested decision are logged as separate actions');
  assert.equal(decisionCalls[0].body.action, 'edit', 'the edit is saved FIRST');
  assert.equal(decisionCalls[0].body.gloss_md, 'a revised, not-yet-saved gloss');
  assert.equal(decisionCalls[1].body.action, 'approve');
  assert.equal(hooks.getGlossaryState().lastLoadedGlossMd, 'a revised, not-yet-saved gloss');
});

test('glossary tab: a CLEAN gloss-edit fires only the requested decision, no auto-save call', async () => {
  const term = {
    id: 'term-2', status: 'draft', term: 'Y', kind: 'statute', citation: 'c', gloss_md: 'unchanged', supported_by_quote: null, source_url: null, needs_mapping: false,
  };
  const { hooks, setFetch } = loadPage(makeFetchMock(glossaryQueueMocks(term)));
  await hooks.loadGlossaryQueue();

  const mock = makeFetchMock([
    { match: (url, method, body) => url === '/api/glossary/decision' && body.action === 'reject', respond: () => ({ body: { status: 'rejected' } }) },
  ]);
  setFetch(mock);
  await hooks.postGlossaryDecision('reject');

  const decisionCalls = postCallsTo(mock.calls, '/api/glossary/decision');
  assert.equal(decisionCalls.length, 1, 'no auto-save fires when nothing was actually edited');
  assert.equal(decisionCalls[0].body.action, 'reject');
});

test('glossary tab: auto-save failing aborts the decision entirely — the requested action is NEVER sent, the edit is left exactly as typed', async () => {
  const term = {
    id: 'term-3', status: 'draft', term: 'Z', kind: 'statute', citation: 'c', gloss_md: 'original', supported_by_quote: null, source_url: null, needs_mapping: false,
  };
  const { document, hooks, setFetch } = loadPage(makeFetchMock(glossaryQueueMocks(term)));
  await hooks.loadGlossaryQueue();
  document.getElementById('glossary-edit').value = 'a dirty edit the server will reject';

  const mock = makeFetchMock([
    { match: (url, method, body) => url === '/api/glossary/decision' && body.action === 'edit', respond: () => ({ status: 400, body: { error: 'gloss_md is required for edit' } }) },
    { match: (url, method, body) => url === '/api/glossary/decision' && body.action === 'approve', respond: () => ({ body: { status: 'approved' } }) },
  ]);
  setFetch(mock);
  await hooks.postGlossaryDecision('approve');

  const decisionCalls = postCallsTo(mock.calls, '/api/glossary/decision');
  assert.equal(decisionCalls.length, 1, 'only the failed auto-save attempt was sent');
  assert.equal(document.getElementById('glossary-edit').value, 'a dirty edit the server will reject');
  assert.equal(hooks.getGlossaryState().lastLoadedGlossMd, 'original');
});

test('glossary tab: a dirty gloss-edit on a status where edit is NOT legal (approved) never attempts an auto-save — glossary-edit is also read-only there', async () => {
  const term = {
    id: 'term-4', status: 'approved', term: 'W', kind: 'statute', citation: 'c', gloss_md: 'locked content', supported_by_quote: null, source_url: null, needs_mapping: false,
  };
  const { document, hooks, setFetch } = loadPage(makeFetchMock(glossaryQueueMocks(term)));
  await hooks.loadGlossaryQueue();
  assert.equal(document.getElementById('glossary-edit').readOnly, true);

  document.getElementById('glossary-edit').value = 'bypassed the readonly attribute somehow';

  const mock = makeFetchMock([
    { match: (url, method, body) => url === '/api/glossary/decision' && body.action === 'publish', respond: () => ({ body: { status: 'published' } }) },
  ]);
  setFetch(mock);
  await hooks.postGlossaryDecision('publish');

  const decisionCalls = postCallsTo(mock.calls, '/api/glossary/decision');
  assert.equal(decisionCalls.length, 1);
  assert.equal(decisionCalls[0].body.action, 'publish');
});
