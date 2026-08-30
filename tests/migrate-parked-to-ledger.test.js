import test from 'node:test';
import assert from 'node:assert/strict';
import { planParkedRows } from '../scripts/migrate-parked-to-ledger.mjs';

// parked.json is gitignored and lives on one machine. Each entry represents three exhausted BILLED
// attempts, so the move into the database has to be lossless in the ways that matter — the reason
// string especially, since that is the evidence a human reads when deciding whether a class can be
// unparked. These pin what may and may not be silently dropped or invented on the way across.

const NOW = new Date('2026-08-30T00:00:00Z');
const ID = '0e3279bf-e7df-4374-b5a4-fb82f3db9c6a';

test('planParkedRows: carries bill_id, reason, parked_at and source across unchanged', () => {
  const { rows } = planParkedRows({
    [ID]: { reason: 'HB 569 — 3 attempts exhausted', parked_at: '2026-08-17T14:48:59.576Z', source: 'drain-lane-seed' },
  }, { now: NOW });
  assert.deepEqual(rows, [{
    bill_id: ID,
    reason: 'HB 569 — 3 attempts exhausted',
    parked_at: '2026-08-17T14:48:59.576Z',
    source: 'drain-lane-seed',
  }]);
});

test('planParkedRows: a missing source stays NULL — an unknown provenance is a fact, not "(none)"', () => {
  // 3 of the 31 real entries predate the source field. Defaulting them to a placeholder would
  // record a provenance nobody chose.
  const { rows } = planParkedRows({ [ID]: { reason: 'r', parked_at: '2026-08-17T00:00:00Z' } }, { now: NOW });
  assert.equal(rows[0].source, null);
});

test('planParkedRows: an entry with NO reason is SKIPPED, never invented', () => {
  // The reason IS the artefact. A park with no stated evidence cannot be reviewed later, and
  // writing "parked" in its place would launder a missing record into a decision.
  for (const bad of [{}, { reason: '' }, { reason: '   ' }, { reason: 42 }]) {
    const { rows, skipped } = planParkedRows({ [ID]: bad }, { now: NOW });
    assert.equal(rows.length, 0, `${JSON.stringify(bad)} must not become a row`);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].why, /no reason/);
  }
});

test('planParkedRows: a key that is not a uuid is skipped rather than sent to a uuid column', () => {
  const { rows, skipped } = planParkedRows({ 'not-a-uuid': { reason: 'r' } }, { now: NOW });
  assert.equal(rows.length, 0);
  assert.match(skipped[0].why, /not a uuid/);
});

test('planParkedRows: a missing parked_at falls back to now rather than to null', () => {
  const { rows } = planParkedRows({ [ID]: { reason: 'r' } }, { now: NOW });
  assert.equal(rows[0].parked_at, NOW.toISOString());
});

test('planParkedRows: empty and undefined input produce no rows and do not throw', () => {
  assert.deepEqual(planParkedRows({}, { now: NOW }), { rows: [], skipped: [] });
  assert.deepEqual(planParkedRows(undefined, { now: NOW }), { rows: [], skipped: [] });
});

test('planParkedRows: the real 31-entry shape survives the round trip with nothing dropped', () => {
  const real = {};
  for (let i = 0; i < 31; i += 1) {
    real[`0e3279bf-e7df-4374-b5a4-fb82f3db9c6${i.toString(16)}`.slice(0, 36)] = {
      reason: `structural park ${i}`, parked_at: '2026-08-17T14:48:59.576Z', source: 'drain-lane-seed-2026-08-17',
    };
  }
  const { rows, skipped } = planParkedRows(real, { now: NOW });
  assert.equal(rows.length, Object.keys(real).length, 'no entry may be dropped silently');
  assert.equal(skipped.length, 0);
});
