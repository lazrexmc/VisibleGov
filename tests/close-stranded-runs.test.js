import test from 'node:test';
import assert from 'node:assert/strict';
import { closureFor } from '../scripts/close-stranded-runs.mjs';

const NOW = new Date('2026-08-29T18:00:00Z');
const run = (startedAt, detail) => ({ id: 'r1', source: 'correct-data', started_at: startedAt, detail });

test('closureFor: records FAILED, never succeeded — the run did not finish', () => {
  const c = closureFor(run('2026-08-03T22:35:11Z'), { now: NOW });
  assert.equal(c.status, 'failed', 'recording a crash as succeeded would launder it in public_freshness');
});

test('closureFor: finished_at equals started_at — the true end time is unknowable', () => {
  const c = closureFor(run('2026-08-03T22:35:11Z'), { now: NOW });
  assert.equal(c.finished_at, '2026-08-03T22:35:11Z');
  assert.notEqual(c.finished_at, NOW.toISOString(), 'closing time is not run-end time; inventing a duration corrupts analysis');
});

test('closureFor: states how long it was stranded, in the row itself', () => {
  const c = closureFor(run('2026-08-03T22:35:11Z'), { now: NOW });
  // 619h, derived: 2026-08-03T22:35:11Z -> 2026-08-29T18:00:00Z is 25 days (600h) plus 19h25m,
  // floored. Hardcoded rather than recomputed in the test, so a change to the arithmetic has to be
  // justified rather than silently absorbed by a mirror of itself.
  assert.match(c.detail.reason, /619h/, 'the row must carry its own evidence of how long it sat');
  assert.equal(c.detail.closed_by, 'scripts/close-stranded-runs.mjs');
});

test('closureFor: PRESERVES any existing detail rather than overwriting the record', () => {
  const c = closureFor(run('2026-08-03T22:35:11Z', { attempted: 4, note: 'keep me' }), { now: NOW });
  assert.equal(c.detail.attempted, 4, 'existing detail is evidence and must survive the closure');
  assert.equal(c.detail.note, 'keep me');
  assert.equal(c.detail.closed_by, 'scripts/close-stranded-runs.mjs');
});

test('closureFor: a non-object detail does not crash or leak into the closure', () => {
  for (const bad of [null, undefined, 'a string', 42]) {
    const c = closureFor(run('2026-08-03T22:35:11Z', bad), { now: NOW });
    assert.equal(typeof c.detail, 'object');
    assert.equal(c.detail.closed_by, 'scripts/close-stranded-runs.mjs');
  }
});
