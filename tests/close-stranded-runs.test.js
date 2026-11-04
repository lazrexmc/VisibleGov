import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closureFor, closeStranded, STRANDED_TICK_CHARGE_USD, isoWeekKeyOf,
} from '../scripts/close-stranded-runs.mjs';
import { PER_TICK_CAP_USD } from '../scripts/scheduled-summaries.js';

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

// ---- the two things most likely to regress silently -------------------------------------------
// Listed as untested for two review rounds because they needed fetch injection the script did not
// take. A dry run that quietly issued a PATCH would look IDENTICAL in the console to a correct one,
// and the id+status guard only matters in a race impractical to stage against a live database.
// Neither is observable from the outside, which is exactly why they need a test rather than a
// careful reading.

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const stranded1 = { id: 'r1', source: 'correct-data', started_at: '2026-08-03T22:35:11Z', detail: { keep: 'me' } };

function recordingFetch(patchBody = [stranded1]) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body, headers: opts.headers });
    return opts.method === 'PATCH' ? okJson(patchBody) : okJson([stranded1]);
  };
  return { calls, fn };
}

test('closeStranded: a DRY RUN issues no PATCH at all — not one write', async () => {
  const { calls, fn } = recordingFetch();
  const r = await closeStranded({ url: 'https://x', key: 'k', fetchFn: fn, log: () => {} });
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0, 'a dry run must not write');
  assert.equal(r.wrote, false);
  assert.equal(r.found, 1);
  assert.equal(r.closed, 0);
});

test('closeStranded: --apply guards the write by id AND status, never id alone', async () => {
  const { calls, fn } = recordingFetch();
  const r = await closeStranded({ url: 'https://x', key: 'k', apply: true, fetchFn: fn, log: () => {} });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'apply must issue a PATCH');
  assert.match(patch.url, /id=eq\.r1/, 'must target the exact row');
  assert.match(
    patch.url, /status=eq\.running/,
    'without the status filter a row that finished between read and write would be overwritten with a fabricated failure',
  );
  assert.equal(r.closed, 1);
  assert.equal(r.wrote, true);
});

test('closeStranded: --apply writes failed/started_at and preserves existing detail', async () => {
  const { calls, fn } = recordingFetch();
  await closeStranded({ url: 'https://x', key: 'k', apply: true, fetchFn: fn, log: () => {} });
  const body = JSON.parse(calls.find((c) => c.method === 'PATCH').body);
  assert.equal(body.status, 'failed', 'never succeeded — it did not finish');
  assert.equal(body.finished_at, stranded1.started_at, 'the true end is unknowable; a zero-length run is visibly wrong');
  assert.equal(body.detail.keep, 'me', 'existing detail is evidence and must survive');
  assert.equal(body.detail.closed_by, 'scripts/close-stranded-runs.mjs');
});

test('closeStranded: an empty PATCH result is SKIPPED, not counted as closed (the race)', async () => {
  // PostgREST returns [] when the id+status filter matches nothing — i.e. the run closed itself
  // between our read and our write. That is the guard working, and it must not read as success.
  const { fn } = recordingFetch([]);
  const r = await closeStranded({ url: 'https://x', key: 'k', apply: true, fetchFn: fn, log: () => {} });
  assert.equal(r.closed, 0);
  assert.equal(r.skipped, 1);
});

test('closeStranded: nothing stranded does not write and does not claim to have closed anything', async () => {
  const calls = [];
  const fn = async (url, opts = {}) => { calls.push(opts.method ?? 'GET'); return okJson([]); };
  const r = await closeStranded({ url: 'https://x', key: 'k', apply: true, fetchFn: fn, log: () => {} });
  assert.deepEqual(r, { found: 0, closed: 0, skipped: 0, wrote: false });
  assert.equal(calls.filter((m) => m !== 'GET').length, 0);
});

test('closeStranded: a failed PATCH throws rather than reporting a false success', async () => {
  const fn = async (url, opts = {}) => (opts.method === 'PATCH'
    ? { ok: false, status: 409, json: async () => ({}), text: async () => 'conflict' }
    : okJson([stranded1]));
  await assert.rejects(
    () => closeStranded({ url: 'https://x', key: 'k', apply: true, fetchFn: fn, log: () => {} }),
    /failed to close r1: HTTP 409/,
  );
});

// ---------------------------------------------------------------------------
// Spend must survive closure (2026-11-04).
//
// summarizeWeekSpend charges a status='running' row the conservative per-tick cap, but reads a
// CLOSED row's detail.spent_usd. closureFor never wrote one, so closing a crashed billed tick
// dropped its charge to $0 and made the weekly cap stop being the cap. Closure was the UNSAFE
// direction. Six real rows were closed on 2026-11-04 in exactly that state.
// ---------------------------------------------------------------------------

const billed = (startedAt, detail) => ({
  id: 'r9', source: 'scheduled-summaries', started_at: startedAt, detail,
});

test('closureFor: a crashed BILLED tick keeps a conservative spend charge and its week', () => {
  const c = closureFor(billed('2026-11-03T12:00:35Z'), { now: NOW });
  assert.equal(c.detail.spent_usd, STRANDED_TICK_CHARGE_USD);
  assert.equal(c.detail.week_key, isoWeekKeyOf('2026-11-03T12:00:35Z'));
  // The charge is an ESTIMATE and says so. A dollar figure that cannot be told apart from a
  // measured one is how an estimate gets quoted as fact later.
  assert.equal(c.detail.spend_is_estimated, true);
  assert.match(c.detail.spend_estimate_basis, /per-tick cap/);
});

test('closureFor: the recorded charge equals what the ledger charged while the row was OPEN', () => {
  // This is the property that makes closure lossless rather than merely non-zero: the row's
  // contribution to its week must not change at the moment somebody tidies it up.
  assert.equal(STRANDED_TICK_CHARGE_USD, PER_TICK_CAP_USD);
});

test('closureFor: a NON-billed source gets no invented dollar figure', () => {
  // Other sources have no spend ledger. Writing a cost for an unbilled ingest run would fabricate
  // a number that never existed, which is worse than leaving it absent.
  const c = closureFor(run('2026-08-03T22:35:11Z'), { now: NOW });
  assert.equal(c.detail.spent_usd, undefined);
  assert.equal(c.detail.week_key, undefined);
  assert.equal(c.detail.spend_is_estimated, undefined);
});

test('closureFor: a REAL spend already in the detail is never overwritten by the estimate', () => {
  // A tick that got far enough to record its own spend knows better than this function does.
  const c = closureFor(billed('2026-11-03T12:00:35Z', { spent_usd: 0.42, week_key: '2026-W45' }), { now: NOW });
  assert.equal(c.detail.spent_usd, 0.42);
  assert.equal(c.detail.week_key, '2026-W45');
  assert.equal(c.detail.spend_is_estimated, undefined, 'a measured figure must not be relabelled an estimate');
});

test('closureFor: an existing week_key is preserved even when the spend has to be estimated', () => {
  const c = closureFor(billed('2026-11-03T12:00:35Z', { week_key: '2026-W01' }), { now: NOW });
  assert.equal(c.detail.spent_usd, STRANDED_TICK_CHARGE_USD);
  assert.equal(c.detail.week_key, '2026-W01', 'the tick knew its own week; do not re-derive it');
});

test('isoWeekKeyOf: matches the scheduler, and refuses to guess on junk', () => {
  assert.equal(isoWeekKeyOf('2026-08-15T12:00:00Z'), '2026-W33');
  assert.equal(isoWeekKeyOf('not a date'), null);
  assert.equal(isoWeekKeyOf(undefined), null);
});
