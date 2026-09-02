// tests/directory-page.test.js — DOM-level TDD for site/js/directory-page.js's address-lookup
// wiring (task-8 review, fix round 1). Split from tests/directory-model.test.js (pure model only)
// the same way tests/person-page.test.js splits DOM-touching regression tests from
// tests/profile-model.test.js's pure ones — jsdom supplies `document` here.
//
// wireAddressForm is exported specifically so these tests can wire a bare form/input/container
// directly (mirrors bootstrapDirectoryPage's own real usage) without needing a full
// document.getElementById-driven bootstrap, the same convention person-page.js's other exported
// DOM helpers (renderIdentity, renderPhoto, loadFreshnessSection, ...) already use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { bootstrapDirectoryPage, wireAddressForm, renderPrivacyContract } from '../site/js/directory-page.js';
import { _setFetch, _setConfig } from '../site/js/rest.js';
import { PRIVACY_CONTRACT_TEXT } from '../site/js/copy.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:8990/' });
globalThis.document = dom.window.document;

function buildFixture() {
  const form = document.createElement('form');
  const input = document.createElement('input');
  const resultsContainer = document.createElement('div');
  document.body.appendChild(form);
  document.body.appendChild(input);
  document.body.appendChild(resultsContainer);
  return { form, input, resultsContainer };
}

function submit(form) {
  const event = new dom.window.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
}

function flush(ms = 15) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// ============================================================================
// MAJOR-1 (review-blocking, privacy): the submit listener is wired synchronously and ALWAYS
// preventDefault()s — never dependent on whether directory data has loaded, is still loading, or
// has failed. Without this, a submit during the fetch window (or after a failed fetch, since the
// old code `return`ed before ever reaching the wiring call) fell through to a native GET
// navigation, putting the typed address on the URL/browser history/this origin's own request-line
// logs — exactly the privacy contract's own "not stored or logged — not by us, not ever" sentence
// broken by the page's own form.
// ============================================================================

test('MAJOR-1: submit is preventDefault()-ed synchronously even while the directory data promise is still PENDING', () => {
  const { form, input, resultsContainer } = buildFixture();
  input.value = '201 W Capitol Ave, Jefferson City, MO';
  const dataState = { promise: new Promise(() => {}) }; // never settles
  wireAddressForm({
    form, input, resultsContainer, dataState,
  });
  const event = submit(form);
  assert.equal(event.defaultPrevented, true, 'no native navigation, regardless of fetch state');
});

test('MAJOR-1: submit while the directory data promise has already REJECTED still preventDefaults, and renders the exact honest "unavailable" message', async () => {
  const { form, input, resultsContainer } = buildFixture();
  input.value = '201 W Capitol Ave, Jefferson City, MO';
  const rejected = Promise.reject(new Error('network fault'));
  rejected.catch(() => {}); // this promise is deliberately pre-rejected for the test; avoid a spurious unhandledRejection report on the rejection itself
  const dataState = { promise: rejected };
  wireAddressForm({
    form, input, resultsContainer, dataState,
  });
  const event = submit(form);
  assert.equal(event.defaultPrevented, true);
  await flush();
  assert.match(
    resultsContainer.textContent,
    /Directory data unavailable — districts can't be matched right now/,
  );
});

test('MAJOR-1: submit while the directory data promise REJECTS LATER (mid-flight failure) still renders the honest message, never navigates', async () => {
  const { form, input, resultsContainer } = buildFixture();
  input.value = '201 W Capitol Ave, Jefferson City, MO';
  let rejectFn;
  const pending = new Promise((_, reject) => { rejectFn = reject; });
  pending.catch(() => {});
  const dataState = { promise: pending };
  wireAddressForm({
    form, input, resultsContainer, dataState,
  });
  const event = submit(form);
  assert.equal(event.defaultPrevented, true);
  rejectFn(new Error('late network fault'));
  await flush();
  assert.match(resultsContainer.textContent, /Directory data unavailable/);
});

test('MAJOR-1: an empty/whitespace-only address never fires a lookup, but the submit is STILL preventDefault()-ed (no native navigation regardless of input)', () => {
  const { form, input, resultsContainer } = buildFixture();
  input.value = '   ';
  const dataState = { promise: new Promise(() => {}) };
  wireAddressForm({
    form, input, resultsContainer, dataState,
  });
  const event = submit(form);
  assert.equal(event.defaultPrevented, true);
  assert.equal(resultsContainer.textContent, '', 'no lookup attempted for an empty address');
});

// ============================================================================
// CONTROLLER RULING (fix round 1): the geocode request is POST with the address in a JSON body —
// never a GET query string, which Cloudflare would record on this origin's own edge logs
// (ClientRequestURI) regardless of anything the geocode function itself does.
// ============================================================================

test('CONTROLLER RULING: a real submit POSTs the address as a JSON body to /geocode, never as a query string', async () => {
  const { form, input, resultsContainer } = buildFixture();
  input.value = '201 W Capitol Ave, Jefferson City, MO';
  const dataState = { promise: Promise.resolve({ legislators: [], persons: [], terms: [] }) };
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  let capturedOpts;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = String(url);
    capturedOpts = opts;
    return { ok: true, json: async () => ({ result: { addressMatches: [] } }) };
  };
  try {
    wireAddressForm({
      form, input, resultsContainer, dataState,
    });
    submit(form);
    await flush();
    assert.equal(capturedUrl, '/geocode');
    assert.equal(capturedUrl.includes('address='), false, 'the address must never ride the request URL');
    assert.equal(capturedOpts.method, 'POST');
    assert.equal(capturedOpts.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(capturedOpts.body), { address: '201 W Capitol Ave, Jefferson City, MO' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// MED-5: a geocode result with the state matched but a district layer MISSING (a real, legitimate
// Census response shape) renders a fourth honest state per section, distinct from both "we found
// candidates" and "we checked and found none."
// ============================================================================

test('MED-5: state matched but the Congressional Districts layer is missing -> the U.S. House section says the geocoder didn\'t return it, never a silent skip and never "not found"', async () => {
  const { form, input, resultsContainer } = buildFixture();
  input.value = '201 W Capitol Ave, Jefferson City, MO';
  const dataState = { promise: Promise.resolve({ legislators: [], persons: [], terms: [] }) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      result: {
        addressMatches: [{
          geographies: {
            States: [{ STUSAB: 'MO' }],
            // no Congressional Districts layer at all
          },
        }],
      },
    }),
  });
  try {
    wireAddressForm({
      form, input, resultsContainer, dataState,
    });
    submit(form);
    await flush();
    assert.match(resultsContainer.textContent, /didn't return your U\.S\. House district/);
    assert.equal(resultsContainer.textContent.includes('No U.S. House representative found'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// LOW-11: an address that geocodes fine but matches zero legislators anywhere still renders the
// as-of line plus each in-scope category's own honest message — never a single generic
// "nothing found" line that erases which categories were even checked.
// ============================================================================

const FULL_MO_GEO_RESPONSE = {
  result: {
    addressMatches: [{
      geographies: {
        States: [{ STUSAB: 'MO' }],
        '119th Congressional Districts': [{ CD119: '03', BASENAME: '3' }],
        '2024 State Legislative Districts - Upper': [{ SLDU: '006', BASENAME: '6' }],
        '2024 State Legislative Districts - Lower': [{ SLDL: '060', BASENAME: '60' }],
      },
    }],
  },
};

test('LOW-11: a fully-geocoded MO address with zero matching legislators renders the as-of line + all four categories\' own honest "not found" messages', async () => {
  const { form, input, resultsContainer } = buildFixture();
  input.value = '201 W Capitol Ave, Jefferson City, MO';
  const dataState = { promise: Promise.resolve({ legislators: [], persons: [], terms: [] }) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => FULL_MO_GEO_RESPONSE });
  try {
    wireAddressForm({
      form, input, resultsContainer, dataState,
    });
    submit(form);
    await flush();
    assert.match(resultsContainer.textContent, /Results shown per the most recent term evidence/);
    assert.match(resultsContainer.textContent, /No U\.S\. Senate representative found/);
    assert.match(resultsContainer.textContent, /No U\.S\. House representative found/);
    assert.match(resultsContainer.textContent, /No MO Senate representative found/);
    assert.match(resultsContainer.textContent, /No MO House representative found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a non-MO address never mentions MO Senate/House at all (structurally out of scope, not merely empty)', async () => {
  const { form, input, resultsContainer } = buildFixture();
  input.value = '300 SW 10th Ave, Topeka, KS';
  const dataState = { promise: Promise.resolve({ legislators: [], persons: [], terms: [] }) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      result: {
        addressMatches: [{
          geographies: {
            States: [{ STUSAB: 'KS' }],
            '119th Congressional Districts': [{ CD119: '02', BASENAME: '2' }],
          },
        }],
      },
    }),
  });
  try {
    wireAddressForm({
      form, input, resultsContainer, dataState,
    });
    submit(form);
    await flush();
    assert.match(resultsContainer.textContent, /No U\.S\. Senate representative found/);
    assert.match(resultsContainer.textContent, /No U\.S\. House representative found/);
    assert.equal(resultsContainer.textContent.includes('MO Senate'), false);
    assert.equal(resultsContainer.textContent.includes('MO House'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// N1 (task-8 re-review, MEDIUM, wrong-rep surface): a slower, EARLIER submission's stale response
// must never overwrite a faster, LATER submission's correct result. The reviewer's own repro: a
// slow Kansas lookup, then a fast Missouri lookup — Missouri's real result must render and stay
// rendered even once the stale Kansas response finally arrives.
// ============================================================================

const KS_GEO_RESPONSE = {
  result: {
    addressMatches: [{
      geographies: {
        States: [{ STUSAB: 'KS' }],
        '119th Congressional Districts': [{ CD119: '02', BASENAME: '2' }],
      },
    }],
  },
};

test('N1: a slow EARLIER submit (Kansas) resolving AFTER a fast LATER submit (Missouri) must never overwrite the correct, already-rendered Missouri result', async () => {
  const { form, input, resultsContainer } = buildFixture();
  const dataState = { promise: Promise.resolve({ legislators: [], persons: [], terms: [] }) };
  const originalFetch = globalThis.fetch;
  let resolveKansas;
  globalThis.fetch = async (url, opts) => {
    const { address } = JSON.parse(opts.body);
    if (address === 'Kansas address (slow)') {
      // Deliberately hangs until resolveKansas() is called below, well after the MO submit.
      return new Promise((resolve) => {
        resolveKansas = () => resolve({ ok: true, json: async () => KS_GEO_RESPONSE });
      });
    }
    return { ok: true, json: async () => FULL_MO_GEO_RESPONSE };
  };
  try {
    wireAddressForm({
      form, input, resultsContainer, dataState,
    });

    // Submit 1: Kansas — slow, deliberately left unresolved.
    input.value = 'Kansas address (slow)';
    submit(form);
    await flush(5); // let the KS fetch actually start (and hang) before the next submit

    // Submit 2: Missouri — resolves immediately, must win and render.
    input.value = '201 W Capitol Ave, Jefferson City, MO';
    submit(form);
    await flush();

    assert.match(resultsContainer.textContent, /MO Senate/, 'the correct, newer Missouri result is showing');
    assert.equal(resultsContainer.textContent.includes('Kansas'), false);

    // NOW let the STALE Kansas response resolve — it must be silently dropped, not rendered.
    resolveKansas();
    await flush();

    assert.match(resultsContainer.textContent, /MO Senate/, 'Missouri result must still be showing after the stale Kansas response resolves');
    assert.equal(resultsContainer.textContent.includes('No U.S. Senate representative found in our data for this state.') && !resultsContainer.textContent.includes('MO Senate'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// N2 (task-8 re-review, LOW): the directory-page.js scope gate for MO Senate/House must use the
// SAME case-insensitive state check matchReps itself uses — a lowercase STUSAB used to make
// matchReps correctly find a MO candidate while the (stricter, `=== 'MO'`) scope gate still
// called the category out of scope, silently dropping a real matched rep (skip != empty).
// ============================================================================

test('N2: a lowercase STUSAB ("mo") still puts MO Senate/House in scope and renders the real matched candidate, never silently dropped', async () => {
  const { form, input, resultsContainer } = buildFixture();
  input.value = '201 W Capitol Ave, Jefferson City, MO';
  const legislator = {
    id: 'leg-mo-sen', full_name: 'Mo Senator', party: 'Republican', person_id: null,
  };
  const term = {
    legislator_id: 'leg-mo-sen', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '6', party: 'Republican', start_date: '2021-01-06', end_date: null,
  };
  const dataState = { promise: Promise.resolve({ legislators: [legislator], persons: [], terms: [term] }) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      result: {
        addressMatches: [{
          geographies: {
            States: [{ STUSAB: 'mo' }], // lowercase — a real live-shape possibility, not guaranteed uppercase
            '2024 State Legislative Districts - Upper': [{ SLDU: '006', BASENAME: '6' }],
            '2024 State Legislative Districts - Lower': [{ SLDL: '060', BASENAME: '60' }],
          },
        }],
      },
    }),
  });
  try {
    wireAddressForm({
      form, input, resultsContainer, dataState,
    });
    submit(form);
    await flush();
    assert.match(resultsContainer.textContent, /MO Senate/);
    assert.match(resultsContainer.textContent, /Mo Senator/, 'the real matched MO Senate candidate renders, not silently dropped');
    assert.equal(resultsContainer.textContent.includes('No MO Senate representative found'), false, 'the real candidate rendered, so the empty/not-found message must NOT also appear for MO Senate');
    assert.equal(resultsContainer.textContent.includes('No MO House representative found'), true, 'MO House correctly reports not-found (no matching data for it), proving the section actually ran, not just skipped');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// N3 (task-8 re-review, LOW): the "Directory data unavailable" message/retry must not get stuck
// re-announcing unavailability once the shared dataState.promise has actually recovered (e.g. via
// the directory-list section's own independent retry) — both a fresh resubmit AND the failed
// message's own retry button must pick up the CURRENT dataState.promise, and the retry must not
// fire a redundant extra fetch when the holder is already good.
// ============================================================================

test('N3: after dataState.promise recovers externally (simulating the directory list\'s own retry), a fresh resubmit renders real results, not the stale "unavailable" message', async () => {
  const { form, input, resultsContainer } = buildFixture();
  input.value = '201 W Capitol Ave, Jefferson City, MO';
  const failed = Promise.reject(new Error('network fault'));
  failed.catch(() => {});
  const dataState = { promise: failed };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => FULL_MO_GEO_RESPONSE });
  try {
    wireAddressForm({
      form, input, resultsContainer, dataState,
    });
    submit(form);
    await flush();
    assert.match(resultsContainer.textContent, /Directory data unavailable/);

    // Simulate the directory list's OWN independent retry succeeding, external to the address form.
    dataState.promise = Promise.resolve({ legislators: [], persons: [], terms: [] });

    submit(form); // a fresh resubmit, not the failed message's own retry button
    await flush();
    assert.match(resultsContainer.textContent, /Results shown per the most recent term evidence/);
    assert.equal(resultsContainer.textContent.includes('Directory data unavailable'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('N3: the failed message\'s own retry button reuses an already-recovered dataState.promise instead of firing a redundant extra fetch', async () => {
  const { form, input, resultsContainer } = buildFixture();
  input.value = '201 W Capitol Ave, Jefferson City, MO';
  const originallyFailed = Promise.reject(new Error('network fault'));
  originallyFailed.catch(() => {});
  const dataState = { promise: originallyFailed };

  let restFetchCalls = 0;
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async () => {
    restFetchCalls += 1;
    return {
      ok: true, status: 200, json: async () => [], headers: { get: () => null },
    };
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => FULL_MO_GEO_RESPONSE });

  try {
    wireAddressForm({
      form, input, resultsContainer, dataState,
    });
    submit(form);
    await flush();
    assert.match(resultsContainer.textContent, /Directory data unavailable/);
    assert.equal(restFetchCalls, 0, 'no directory fetch has happened yet (the ORIGINAL promise was pre-built, not via loadDirectoryData)');

    // Externally refresh dataState.promise (simulating the directory list's own retry) to an
    // ALREADY-GOOD, already-resolved promise — without going through loadDirectoryData, so
    // restFetchCalls stays 0 up to this point.
    dataState.promise = Promise.resolve({ legislators: [], persons: [], terms: [] });

    const retryBtn = resultsContainer.querySelector('button');
    assert.ok(retryBtn, 'a retry button was rendered');
    retryBtn.click();
    await flush();

    assert.equal(restFetchCalls, 0, 'the retry reused the already-good dataState.promise — no new fetchAllRows call fired');
    assert.match(resultsContainer.textContent, /Results shown per the most recent term evidence/);
  } finally {
    globalThis.fetch = originalFetch;
    _setFetch(null);
  }
});

// Task-10 review, LOW-1: index.html's static privacy-contract paragraph now renders from the SAME
// PRIVACY_CONTRACT_TEXT constant (site/js/copy.js) trust.html's attribution section renders — one
// wording, never a hand-typed second copy that could drift.
test('renderPrivacyContract: fills the container with the exact PRIVACY_CONTRACT_TEXT constant', () => {
  const container = document.createElement('p');
  renderPrivacyContract(container);
  assert.equal(container.textContent, PRIVACY_CONTRACT_TEXT);
});

test('renderPrivacyContract: clears any prior content before rendering (idempotent)', () => {
  const container = document.createElement('p');
  container.textContent = 'stale';
  renderPrivacyContract(container);
  assert.equal(container.textContent, PRIVACY_CONTRACT_TEXT);
});

function responseForRows(rows) {
  return {
    ok: true,
    status: 200,
    json: async () => rows,
    headers: { get: (name) => (name.toLowerCase() === 'content-range' ? `0-${Math.max(0, rows.length - 1)}/${rows.length}` : null) },
  };
}

function directoryShell() {
  document.body.innerHTML = `
    <main>
      <p id="privacy-contract"></p>
      <form id="address-form"><input id="address-input" /></form>
      <div id="address-results"></div>
      <button id="directory-view-serving" type="button" aria-pressed="true">Serving now</button>
      <button id="directory-view-past" type="button" aria-pressed="false">Past members</button>
      <div id="directory-summary"></div>
      <div id="directory-chambers"></div>
      <input id="directory-filter" />
      <p id="directory-count"></p>
      <div id="directory-list"></div>
    </main>
    <footer id="site-footer"></footer>
  `;
}

test('bootstrapDirectoryPage: summarizes the directory, pages the long roster, and filters by chamber', async () => {
  directoryShell();
  const legislators = Array.from({ length: 30 }, (_, i) => ({
    id: `L${i}`,
    full_name: `Member ${String(i).padStart(2, '0')} Surname${String(i).padStart(2, '0')}`,
    surname: `Surname${String(i).padStart(2, '0')}`,
    party: i % 2 === 0 ? 'Democratic' : 'Republican',
    person_id: null,
  }));
  const terms = legislators.map((legislator, i) => ({
    legislator_id: legislator.id,
    jurisdiction_id: i < 5 ? 'us-congress' : 'mo-legislature',
    chamber: i < 5 ? 'senate' : 'house',
    district: i < 5 ? 'MO' : String(i),
    state: 'MO',
    party: legislator.party,
    start_date: '2025-01-03',
    end_date: null,
  }));

  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    if (url.includes('/legislators?')) return responseForRows(legislators);
    if (url.includes('/persons?')) return responseForRows([]);
    if (url.includes('/terms?')) return responseForRows(terms);
    throw new Error(`unexpected URL ${url}`);
  });

  try {
    await bootstrapDirectoryPage();
    assert.match(document.getElementById('directory-summary').textContent, /Total/);
    assert.match(document.getElementById('directory-summary').textContent, /30/);
    assert.equal(document.querySelectorAll('#directory-list .directory-row').length, 24);
    assert.match(document.getElementById('directory-count').textContent, /Showing 24 of 30/);

    document.querySelector('#directory-list .directory-show-more').click();
    assert.equal(document.querySelectorAll('#directory-list .directory-row').length, 30);
    assert.match(document.getElementById('directory-count').textContent, /Showing 30 of 30/);

    const senateButton = [...document.querySelectorAll('#directory-chambers button')]
      .find((button) => button.textContent === 'U.S. Senate');
    senateButton.click();
    assert.equal(document.querySelectorAll('#directory-list .directory-row').length, 5);
    assert.match(document.getElementById('directory-count').textContent, /Showing 5 of 5 U\.S\. Senate/);
    assert.equal(document.querySelector('#directory-list .directory-show-more'), null);
  } finally {
    _setFetch(null);
  }
});
