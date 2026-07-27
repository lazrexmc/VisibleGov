import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceFetchError, RateLimitedError } from '../src/lib/errors.js';
import { createLimiter } from '../src/lib/rate-limiter.js';
import { redactUrl } from '../src/lib/http.js';

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

test('redactUrl passes through URLs with no query unchanged', () => {
  assert.equal(redactUrl('https://clerk.house.gov/evs/2025/roll358.xml'), 'https://clerk.house.gov/evs/2025/roll358.xml');
  assert.equal(redactUrl('https://x/y?format=json&limit=250'), 'https://x/y?format=json&limit=250');
});
