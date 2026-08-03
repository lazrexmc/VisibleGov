import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceFetchError, RateLimitedError, RunNotApprovedError, assertRunApproved } from '../src/lib/errors.js';
import { createLimiter } from '../src/lib/rate-limiter.js';
import { redactUrl, fetchWithLimit } from '../src/lib/http.js';

function noOpLimiter() {
  return { take: async () => {} };
}

function withMockedFetch(impl, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = saved; });
}

test('RateLimitedError is a SourceFetchError with metadata', () => {
  const err = new RateLimitedError('slow down', { source: 'us-congress', url: 'https://x', status: 429 });
  assert.ok(err instanceof SourceFetchError);
  assert.ok(err instanceof Error);
  assert.equal(err.source, 'us-congress');
  assert.equal(err.status, 429);
  assert.equal(err.name, 'RateLimitedError');
});

test('limiter spaces out calls by minIntervalMs', async () => {
  const limiter = createLimiter({ minIntervalMs: 30 });
  const t0 = Date.now();
  await limiter.take();
  await limiter.take();
  await limiter.take();
  assert.ok(Date.now() - t0 >= 60, 'three takes must span at least 2 intervals');
});

test('first take is immediate', async () => {
  const limiter = createLimiter({ minIntervalMs: 5000 });
  const t0 = Date.now();
  await limiter.take();
  assert.ok(Date.now() - t0 < 100);
});

test('redactUrl replaces api_key values and leaves other params intact', () => {
  const url = 'https://api.congress.gov/v3/bill/119/hr/22?api_key=SECRET123&format=json';
  const redacted = redactUrl(url);
  assert.ok(!redacted.includes('SECRET123'), 'secret must not survive redaction');
  assert.ok(redacted.includes('api_key=REDACTED'));
  assert.ok(redacted.includes('format=json'), 'unrelated params must survive untouched');

  // case-insensitive, and covers apikey/key variants too
  assert.equal(redactUrl('https://x/y?ApiKey=abc123'), 'https://x/y?ApiKey=REDACTED');
  assert.equal(redactUrl('https://x/y?key=abc123&other=1'), 'https://x/y?key=REDACTED&other=1');
  assert.equal(
    redactUrl('https://x/y?a=1&api_key=abc123&b=2'),
    'https://x/y?a=1&api_key=REDACTED&b=2',
  );
});

test('redactUrl also redacts access_key= (LegiScan\'s per-dataset token from getDatasetList, '
  + 'threaded through getDataset calls) — added 2026-07-28, Task 3 of the LegiScan bulk adapter '
  + 'plan, closing a real gap: the prior pattern only matched a `key`/`api_key` name directly '
  + 'preceded by `?`/`&`, so `access_key=` (preceded by `_`, not `?`/`&`, right before "key") '
  + 'slipped through untouched', () => {
  assert.equal(
    redactUrl('https://api.legiscan.com/?key=SECRET1&op=getDataset&id=1608&access_key=SECRET2'),
    'https://api.legiscan.com/?key=REDACTED&op=getDataset&id=1608&access_key=REDACTED',
  );
  // access_key alone (no key= present) still redacts, and other params survive untouched
  assert.equal(
    redactUrl('https://x/y?access_key=abc123&other=1'),
    'https://x/y?access_key=REDACTED&other=1',
  );
});

test('redactUrl passes through URLs with no query unchanged', () => {
  assert.equal(redactUrl('https://clerk.house.gov/evs/2025/roll358.xml'), 'https://clerk.house.gov/evs/2025/roll358.xml');
  assert.equal(redactUrl('https://x/y?format=json&limit=250'), 'https://x/y?format=json&limit=250');
});

// ---- fetchWithLimit body-read hardening (senior engineering audit, 2026-08-03, finding 11) ----
// A 200-status response can still fail while its BODY is being read (res.json() throwing a raw
// SyntaxError on non-JSON content; a mid-stream connection reset surfacing as a raw
// `TypeError: terminated`) — previously ONLY the connection itself (fetch() throwing) was wrapped
// into a SourceFetchError; a body-read failure escaped as a raw, unclassified error that the
// near-universal "if (!(err instanceof SourceFetchError)) throw err;" catch pattern used
// throughout this codebase would never catch.

test('fetchWithLimit: a body-read failure (res.json() throwing on non-JSON content) is wrapped in a SourceFetchError, never a raw SyntaxError', async () => {
  await withMockedFetch(
    async () => ({
      status: 200,
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
    }),
    async () => {
      await assert.rejects(
        () => fetchWithLimit('https://x/y', { source: 'test-source', limiter: noOpLimiter(), as: 'json' }),
        (err) => {
          assert.ok(err instanceof SourceFetchError, `expected SourceFetchError, got ${err.constructor.name}`);
          assert.equal(err.source, 'test-source');
          assert.match(err.message, /failed reading response body/);
          assert.ok(err.cause instanceof SyntaxError, 'the original error must be preserved as .cause');
          return true;
        },
      );
    },
  );
});

test('fetchWithLimit: a mid-stream connection reset during the body read (a raw TypeError) is wrapped in a SourceFetchError', async () => {
  await withMockedFetch(
    async () => ({
      status: 200,
      ok: true,
      text: async () => { throw new TypeError('terminated'); },
    }),
    async () => {
      await assert.rejects(
        () => fetchWithLimit('https://x/y', { source: 'test-source', limiter: noOpLimiter(), as: 'text' }),
        (err) => {
          assert.ok(err instanceof SourceFetchError);
          assert.ok(err.cause instanceof TypeError);
          return true;
        },
      );
    },
  );
});

test('fetchWithLimit: a genuinely successful JSON body still returns normally (the wrap does not change the happy path)', async () => {
  await withMockedFetch(
    async () => ({ status: 200, ok: true, json: async () => ({ hello: 'world' }) }),
    async () => {
      const result = await fetchWithLimit('https://x/y', { source: 'test-source', limiter: noOpLimiter(), as: 'json' });
      assert.deepEqual(result, { hello: 'world' });
    },
  );
});

test('fetchWithLimit: an HTTP error status still throws SourceFetchError from the status check, never even attempting a body read', async () => {
  let bodyReadAttempted = false;
  await withMockedFetch(
    async () => ({
      status: 500,
      ok: false,
      json: async () => { bodyReadAttempted = true; return {}; },
    }),
    async () => {
      await assert.rejects(
        () => fetchWithLimit('https://x/y', { source: 'test-source', limiter: noOpLimiter(), as: 'json' }),
        SourceFetchError,
      );
    },
  );
  assert.equal(bodyReadAttempted, false);
});

// ---- assertRunApproved / RunNotApprovedError: the shared spend-gate primitive behind
// summarize.js's SUMMARIZE_RUN_APPROVED and verify.js's VERIFY_RUN_APPROVED (task 1, closing the
// gap CLAUDE.md's own policy flagged — gloss.js's GLOSS_RUN_APPROVED and golden.js's
// GOLDEN_CHECK_APPROVED predate this and stay untouched, inline, per-file). ----

test('assertRunApproved throws RunNotApprovedError unless the value is exactly "yes"', () => {
  assert.throws(
    () => assertRunApproved(undefined, { envVar: 'FOO_RUN_APPROVED', action: 'fooing' }),
    RunNotApprovedError,
  );
  assert.throws(
    () => assertRunApproved('', { envVar: 'FOO_RUN_APPROVED', action: 'fooing' }),
    RunNotApprovedError,
  );
  // Truthy-looking but not the exact sentinel — same discipline as gloss.js's own `!== 'yes'`.
  assert.throws(
    () => assertRunApproved('true', { envVar: 'FOO_RUN_APPROVED', action: 'fooing' }),
    RunNotApprovedError,
  );
});

test('assertRunApproved does not throw when the value is exactly "yes"', () => {
  assert.doesNotThrow(() => assertRunApproved('yes', { envVar: 'FOO_RUN_APPROVED', action: 'fooing' }));
});

test('RunNotApprovedError message states the run costs real money, that approval is per-run, and the exact env var to set — gloss.js\'s voice', () => {
  try {
    assertRunApproved(undefined, { envVar: 'FOO_RUN_APPROVED', action: 'fooing', detail: 'doing the foo' });
    assert.fail('expected assertRunApproved to throw');
  } catch (err) {
    assert.ok(err instanceof RunNotApprovedError);
    assert.equal(err.name, 'RunNotApprovedError');
    assert.match(err.message, /^BLOCKED: fooing makes live, billed Anthropic API calls \(doing the foo\)\./);
    assert.match(err.message, /owner's standing policy/);
    assert.match(err.message, /explicit per-run approval/);
    assert.match(err.message, /set FOO_RUN_APPROVED=yes to proceed/);
    assert.equal(err.envVar, 'FOO_RUN_APPROVED');
  }
});

test('assertRunApproved omits the parenthetical when no detail is given', () => {
  try {
    assertRunApproved('no', { envVar: 'FOO_RUN_APPROVED', action: 'fooing' });
    assert.fail('expected assertRunApproved to throw');
  } catch (err) {
    assert.match(err.message, /^BLOCKED: fooing makes live, billed Anthropic API calls\. Per/);
  }
});
