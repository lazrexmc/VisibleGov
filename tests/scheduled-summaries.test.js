import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKLY_CAP_USD, PER_TICK_CAP_USD, MONSTER_THRESHOLD_CHARS, envCapUsd, currentWeekKey,
  summarizeWeekSpend, tickAllowance, sortQueueRecencyFirst, computeDraftOnly, assembleTick,
} from '../scripts/scheduled-summaries.js';

test('caps: constants match the spec', () => {
  assert.equal(WEEKLY_CAP_USD, 5.00);
  assert.equal(PER_TICK_CAP_USD, 1.00);
  assert.equal(MONSTER_THRESHOLD_CHARS, 100000);
});

test('envCapUsd: overrides can only shrink, never grow; junk is ignored', () => {
  process.env.TEST_CAP = '0.50';
  assert.equal(envCapUsd('TEST_CAP', 1.00), 0.50);
  process.env.TEST_CAP = '9.00';
  assert.equal(envCapUsd('TEST_CAP', 1.00), 1.00);
  process.env.TEST_CAP = 'banana';
  assert.equal(envCapUsd('TEST_CAP', 1.00), 1.00);
  delete process.env.TEST_CAP;
});

test('currentWeekKey: UTC ISO-8601 weeks, including year-boundary cases', () => {
  assert.equal(currentWeekKey(new Date('2026-08-15T12:00:00Z')), '2026-W33');
  assert.equal(currentWeekKey(new Date('2026-01-01T00:00:00Z')), '2026-W01');
  assert.equal(currentWeekKey(new Date('2027-01-01T00:00:00Z')), '2026-W53'); // Jan 1 2027 is a Friday of ISO week 53/2026
  assert.equal(currentWeekKey(new Date('2024-12-30T00:00:00Z')), '2025-W01'); // Monday belonging to next ISO year
});

test('summarizeWeekSpend: sums this week, ignores other weeks, counts crashed ticks at full allowance', () => {
  const rows = [
    { status: 'succeeded', detail: { week_key: '2026-W33', spent_usd: 0.40 } },
    { status: 'partial', detail: { week_key: '2026-W33', spent_usd: 0.25 } },
    { status: 'succeeded', detail: { week_key: '2026-W32', spent_usd: 0.90 } }, // other week
    { status: 'running', detail: {} }, // crashed/unclosed: conservative full-tick assumption
  ];
  const out = summarizeWeekSpend(rows, '2026-W33', 1.00);
  assert.equal(out.spentUsd, 0.40 + 0.25 + 1.00);
  assert.equal(out.crashedTicks, 1);
});

test('tickAllowance: min(weekly remaining, per-tick cap), floored at 0', () => {
  assert.equal(tickAllowance({ weeklyCapUsd: 5, weeklySpentUsd: 4.6, perTickCapUsd: 1 }), 0.4 === 0.4 ? Number((5 - 4.6).toFixed(10)) : 0.4);
  assert.equal(tickAllowance({ weeklyCapUsd: 5, weeklySpentUsd: 2, perTickCapUsd: 1 }), 1);
  assert.equal(tickAllowance({ weeklyCapUsd: 5, weeklySpentUsd: 6, perTickCapUsd: 1 }), 0);
});

test('sortQueueRecencyFirst: session DESC, then passage before other, then smallest first', () => {
  const queue = [
    { bill_id: 'a', priority: 'other', text_length: 100 },
    { bill_id: 'b', priority: 'passage', text_length: 900 },
    { bill_id: 'c', priority: 'other', text_length: 50 },
    { bill_id: 'd', priority: 'passage', text_length: 10 },
  ];
  const sessionStart = new Map([['a', '2026-01-01'], ['b', '2026-01-01'], ['c', '2025-01-01'], ['d', '2026-01-01']]);
  const sorted = sortQueueRecencyFirst(queue, sessionStart);
  assert.deepEqual(sorted.map((q) => q.bill_id), ['d', 'b', 'a', 'c']);
});

test('computeDraftOnly: draft-only bills with rejected-attempt counts; published bills excluded', () => {
  const rows = [
    { id: 's1', bill_id: 'x', status: 'draft', bill_text_hash: 'h1' },
    { id: 's2', bill_id: 'x', status: 'rejected', bill_text_hash: 'h1' },
    { id: 's3', bill_id: 'x', status: 'rejected', bill_text_hash: 'h1' },
    { id: 's4', bill_id: 'y', status: 'draft', bill_text_hash: 'h2' },
    { id: 's5', bill_id: 'z', status: 'draft', bill_text_hash: 'h3' },
    { id: 's6', bill_id: 'z', status: 'published', bill_text_hash: 'h3' },
  ];
  const m = computeDraftOnly(rows);
  assert.equal(m.get('x').rejectedCount, 2);
  assert.equal(m.get('x').draftRow.id, 's1');
  assert.equal(m.get('y').rejectedCount, 0);
  assert.equal(m.has('z'), false);
});

test('assembleTick: fresh → conversions → at most ONE monster; parked and ≥2-rejected conversions skipped', () => {
  const out = assembleTick({
    freshQueue: [{ bill_id: 'f1' }, { bill_id: 'f2' }],
    conversions: [
      { bill_id: 'c1', rejectedCount: 0 },
      { bill_id: 'c2', rejectedCount: 2 }, // spec: skip ≥2 prior rejected attempts
      { bill_id: 'c3', rejectedCount: 1 },
    ],
    monsters: [{ bill_id: 'm1' }, { bill_id: 'm2' }],
    parkedIds: new Set(['c3', 'f2']),
  });
  assert.deepEqual(out.map((e) => `${e.lane}:${e.item.bill_id}`), ['fresh:f1', 'conversion:c1', 'monster:m1']);
});
