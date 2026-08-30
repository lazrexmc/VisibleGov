import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, silenceThreshold, selectSources, exitCodeFor, expectArray,
} from '../scripts/check-ingest-health.mjs';

// The whole point of this check is that it must fire on real breakage and stay quiet on weather.
// Both halves are pinned: a detector nobody has watched fail is a hope (PLAYBOOK lesson 50), and a
// detector that fires on ordinary noise gets ignored, which is the same as not existing.

const NOW = Date.parse('2026-08-29T18:00:00Z');
const at = (hoursAgo, status) => ({ status, started_at: new Date(NOW - hoursAgo * 3600000).toISOString() });

test('classify: a recent successful run is ok', () => {
  const r = classify([at(1, 'succeeded'), at(2, 'succeeded')], { now: NOW });
  assert.equal(r.state, 'ok');
});

test('classify: ONE failure is weather, not a defect — government sites 500', () => {
  const r = classify([at(1, 'failed'), at(2, 'succeeded'), at(3, 'succeeded')], { now: NOW });
  assert.equal(r.state, 'transient', 'a single failure must not redden an hourly job');
});

test('classify: TWO consecutive failures are still below the threshold', () => {
  const r = classify([at(1, 'failed'), at(2, 'failed'), at(3, 'succeeded')], { now: NOW });
  assert.equal(r.state, 'transient');
});

test('classify: THREE consecutive failures is a broken feed and must fire', () => {
  const r = classify([at(1, 'failed'), at(2, 'failed'), at(3, 'failed'), at(4, 'succeeded')], { now: NOW });
  assert.equal(r.state, 'BROKEN');
  assert.match(r.detail, /3 consecutive/);
});

// The half that is easy to forget: nothing FAILED, because nothing was attempted. A source quietly
// dropping out of the schedule looks perfect to any failure-counting check.
test('classify: silence is its own alarm — no attempt in over a day fires even with zero failures', () => {
  const r = classify([at(40, 'succeeded'), at(41, 'succeeded')], { now: NOW });
  assert.equal(r.state, 'SILENT', 'a source that stopped being attempted must not read as healthy');
  assert.match(r.detail, /no run attempted/);
});

test('classify: a source with no rows at all is NEVER_RAN, never "fine"', () => {
  assert.equal(classify([], { now: NOW }).state, 'NEVER_RAN');
  assert.equal(classify(undefined, { now: NOW }).state, 'NEVER_RAN');
});

// This tick's own in-flight row must not be counted as evidence, or the check fails against itself
// the moment it runs inside the same workflow that started the ingest.
test('classify: an in-flight running row is not evidence either way', () => {
  const r = classify([at(0, 'running'), at(1, 'succeeded'), at(2, 'succeeded')], { now: NOW });
  assert.equal(r.state, 'ok', "the tick's own running row must not break the streak logic");
});

test('classify: a running row does not mask a real failure streak underneath it', () => {
  const r = classify([at(0, 'running'), at(1, 'failed'), at(2, 'failed'), at(3, 'failed')], { now: NOW });
  assert.equal(r.state, 'BROKEN', 'the streak must be read through the in-flight row, not stopped by it');
});

// --- silence thresholds -------------------------------------------------------------------------
// These had ZERO coverage when they were introduced, and the first value shipped (legiscan 30h) was
// wrong for a reason no observation would have revealed: legiscan is due-gated at 24h and measured
// from the previous run's START, so a day whose drift is smaller than the previous day's drift plus
// install time leaves it not-yet-due, writing no row and legitimately skipping a day. 30h alarmed on
// that. The rule the tests pin is the general one: derive the window from interval x cycles you are
// willing to lose, never from the bare interval.

test('silenceThreshold: legiscan is exactly 50h — two 24h cycles plus ~2h drift', () => {
  // Pinned to the VALUE, not a bound. `> 48` passed for 49 and for 500 alike, so it would not have
  // caught a drift in either direction; the number is derived (2 x 24h interval + drift), so a
  // change to it should have to be justified rather than slipping under a range check.
  assert.equal(silenceThreshold('legiscan'), 50);
});

test('silenceThreshold: every hourly source is exactly 25h, not merely "tight"', () => {
  for (const s of ['mo-senate-web', 'mo-house-xml', 'us-congress', 'us-senate']) {
    assert.equal(silenceThreshold(s), 25, `${s} must keep the hourly window`);
  }
});

test('silenceThreshold: an unknown source falls back to the tight default, never to permissive', () => {
  // Pinned to the literal 25, not to silenceThreshold('us-senate'): asserting equality between two
  // values from the same table is transitive, so changing the default AND every hourly entry to one
  // new number would have passed while silently widening every window.
  assert.equal(silenceThreshold('brand-new-source'), 25);
});

test('classify: legiscan silent for 40h is NOT an alarm (one skipped daily cycle)', () => {
  const r = classify([at(40, 'succeeded')], { now: NOW, silentAfterHours: silenceThreshold('legiscan') });
  assert.equal(r.state, 'ok', 'a single skipped daily cycle must not cry wolf');
});

test('classify: legiscan silent for 60h IS an alarm (two cycles missed)', () => {
  const r = classify([at(60, 'succeeded')], { now: NOW, silentAfterHours: silenceThreshold('legiscan') });
  assert.equal(r.state, 'SILENT');
});

// --- --only -------------------------------------------------------------------------------------

test('selectSources: no --only checks everything', () => {
  assert.deepEqual(selectSources([], ['a', 'b']), ['a', 'b']);
});

test('selectSources: --only narrows to exactly the named sources', () => {
  assert.deepEqual(selectSources(['--only', 'b'], ['a', 'b']), ['b']);
  assert.deepEqual(selectSources(['--only', 'a, b'], ['a', 'b']), ['a', 'b']);
});

test('selectSources: a typo THROWS rather than silently checking nothing', () => {
  // The dangerous failure is not a crash, it is a script that passes by not looking.
  assert.throws(() => selectSources(['--only', 'legiscanx'], ['a', 'legiscan']), /unknown source/);
  assert.throws(() => selectSources(['--only'], ['a']), /requires a comma-separated/);
});

// --- the acting branch ---------------------------------------------------------------------------
// A sentinel that only prints is not a detector. These pin that BOTH axes fail the job
// independently — a dead feed, and a stranded row while every feed is healthy. The second is the
// case that went unnoticed for 25 days, because `npm run status` reported it perfectly and nothing
// ran `npm run status`.
test('exitCodeFor: all healthy and nothing stranded exits 0', () => {
  assert.equal(exitCodeFor({ results: [{ state: 'ok' }, { state: 'transient' }], stranded: [] }), 0);
});

test('exitCodeFor: a transient failure alone does NOT fail the job', () => {
  assert.equal(exitCodeFor({ results: [{ state: 'transient' }], stranded: [] }), 0, 'weather must not redden an hourly job');
});

test('exitCodeFor: a broken/silent/never-ran feed fails the job', () => {
  for (const state of ['BROKEN', 'SILENT', 'NEVER_RAN']) {
    assert.equal(exitCodeFor({ results: [{ state }], stranded: [] }), 1, `${state} must act`);
  }
});

test('exitCodeFor: a STRANDED run fails the job even when every feed is healthy', () => {
  assert.equal(
    exitCodeFor({ results: [{ state: 'ok' }, { state: 'ok' }], stranded: [{ source: 'correct-data' }] }),
    1,
    'this is the 25-day case: feeds fine, a crashed run open, nobody looking',
  );
});

test('exitCodeFor: defaults are safe — no args does not silently pass by having nothing to check', () => {
  assert.equal(exitCodeFor(), 0);
  assert.equal(exitCodeFor({ stranded: [{ source: 'x' }] }), 1);
});

// --- the transport contract ---------------------------------------------------------------------
// Three places measured `.length` on whatever PostgREST returned. A non-array makes `.length`
// undefined, `undefined > 0` is false, and the checker reports HEALTHY on a response it could not
// read. This file enforces "absence reported as unknown disarms the detector" for feeds, then
// trusted the wire itself. The worst of the three was close-stranded-runs' PATCH result, where the
// same shape would have counted an unreadable response as a SUCCESSFUL repair.
test('expectArray: passes an array through untouched', () => {
  const a = [{ x: 1 }];
  assert.equal(expectArray(a, 'ctx'), a);
  assert.deepEqual(expectArray([], 'ctx'), []);
});

test('expectArray: throws with exit code 2 on anything else - could not check, not clean', () => {
  for (const bad of [null, undefined, {}, 'text', 42, { message: 'error' }]) {
    let caught;
    try { expectArray(bad, 'strandedRuns'); } catch (e) { caught = e; }
    assert.ok(caught, `${JSON.stringify(bad)} must throw rather than flow on`);
    assert.equal(caught.exitCode, 2, '2 means could-not-check; 1 would claim we checked and found a fault');
    assert.match(caught.message, /strandedRuns/, 'the message must name which call failed');
  }
});

test('expectArray: a PostgREST error object does not read as an empty result set', () => {
  // The realistic failure: a 200 carrying {"message":"..."} instead of rows. Under the old code
  // this became "0 stranded runs" and the job stayed green.
  assert.throws(() => expectArray({ message: 'unexpected' }, 'close-stranded PATCH result'), /expected an array/);
});
