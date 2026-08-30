import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, silenceThreshold, selectSources } from '../scripts/check-ingest-health.mjs';

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

test('silenceThreshold: legiscan tolerates one legitimately skipped daily cycle', () => {
  assert.ok(silenceThreshold('legiscan') > 48, `must exceed two 24h intervals, got ${silenceThreshold('legiscan')}`);
});

test('silenceThreshold: an hourly source is NOT given the daily allowance', () => {
  for (const s of ['mo-senate-web', 'mo-house-xml', 'us-congress', 'us-senate']) {
    assert.ok(silenceThreshold(s) <= 25, `${s} must keep the tight window, got ${silenceThreshold(s)}`);
  }
});

test('silenceThreshold: an unknown source falls back to the tight default, never to permissive', () => {
  assert.equal(silenceThreshold('brand-new-source'), silenceThreshold('us-senate'));
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
