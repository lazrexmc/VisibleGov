import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../scripts/check-ingest-health.mjs';

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
