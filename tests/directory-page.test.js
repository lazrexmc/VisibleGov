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

import { wireAddressForm } from '../site/js/directory-page.js';

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
