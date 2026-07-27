import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceFetchError, RateLimitedError } from '../src/lib/errors.js';
import { createLimiter } from '../src/lib/rate-limiter.js';

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
