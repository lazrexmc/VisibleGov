import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKLY_CAP_USD, PER_TICK_CAP_USD, MONSTER_THRESHOLD_CHARS, envCapUsd, currentWeekKey,
  summarizeWeekSpend, tickAllowance, sortQueueRecencyFirst, computeDraftOnly, assembleTick,
  runTick,
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

function fakeDeps(overrides = {}) {
  const calls = {
    childCli: [], closed: [], logs: [], records: [],
  };
  return {
    calls,
    deps: {
      client: {},
      anthropic: {},
      now: () => new Date('2026-08-15T12:00:00Z'),
      acquireLockFn: () => ({ acquired: true, nonce: 'n1', reason: 'fresh' }),
      releaseLockFn: () => {},
      selectRecentRuns: async () => overrides.recentRuns ?? [],
      openRunFn: async () => 'run-1',
      closeRunFn: async (client, runId, status, detail) => { calls.closed.push({ runId, status, detail }); },
      runChildCliFn: (script, args) => {
        calls.childCli.push({ script, args });
        if (args[0] === 'plan') return { parsed: { queue: overrides.queue ?? [] } };
        return { parsed: overrides.recordResult ?? { counts: { published: 1, gated: 0, failures: 0 }, gated: [], failures: [] } };
      },
      loadSessionStartByBill: async () => overrides.sessionStart ?? new Map(),
      loadSummaryRows: async () => overrides.summaryRows ?? [],
      loadTextRow: async (billId) => (overrides.texts ?? {})[billId] ?? null,
      loadDraftObjectionsFn: async () => overrides.draftObjections ?? { priorSummary: { what_it_does: [{ point: 'p', section: 's' }], stated_purpose: '' }, objections: ['fix it'], hasVerifications: true },
      runBillChainFn: async (a, tracker, { bill }) => {
        tracker.record('claude-haiku-4-5', { input_tokens: 10000, output_tokens: 1000 }, `author:${bill.identifier}`);
        return { envelope: { bill_id: bill.bill_id, identifier: bill.identifier, bill_text_hash: bill.bill_text_hash, summary: {}, verdicts: [], completeness: {}, provenance: 'api', author_model: 'claude-haiku-4-5', verifier_model: 'claude-sonnet-5' } };
      },
      writeRecordsFile: (p, payload) => { calls.records.push({ p, payload }); },
      appendLog: (line) => { calls.logs.push(line); },
      readParked: () => overrides.parked ?? {},
      writeParked: () => {},
      dryRun: overrides.dryRun ?? false,
      ...overrides.deps,
    },
  };
}

test('runTick: budget-exhausted week opens NO run row and spends nothing', async () => {
  const { deps, calls } = fakeDeps({
    recentRuns: [{ status: 'succeeded', detail: { week_key: '2026-W33', spent_usd: 5.0 } }],
  });
  const report = await runTick(deps);
  assert.equal(report.outcome, 'budget-exhausted');
  assert.equal(calls.closed.length, 0);
});

test('runTick: a fresh bill flows plan → chain → records file → record CLI → closed run with honest detail', async () => {
  const { deps, calls } = fakeDeps({
    queue: [{ bill_id: 'f1', identifier: 'HB 1', title: 'T', bill_text_hash: 'h1', text_length: 500, priority: 'other' }],
    texts: { f1: { content: 'text', content_hash: 'h1' } },
  });
  const report = await runTick(deps);
  assert.equal(report.outcome, 'ok');
  assert.equal(calls.records.length, 1); // fresh records file only (no conversions this tick)
  assert.equal(calls.closed[0].status, 'succeeded');
  assert.equal(calls.closed[0].detail.week_key, '2026-W33');
  assert.ok(calls.closed[0].detail.spent_usd > 0);
  assert.equal(calls.closed[0].detail.lanes.fresh, 1);
});

test('runTick: billing error stops the tick, marks balance_depleted, logs BALANCE DEPLETED', async () => {
  let chainCalls = 0;
  const { deps, calls } = fakeDeps({
    queue: [
      { bill_id: 'f1', identifier: 'HB 1', title: 'T', bill_text_hash: 'h1', text_length: 500, priority: 'other' },
      { bill_id: 'f2', identifier: 'HB 2', title: 'T', bill_text_hash: 'h2', text_length: 600, priority: 'other' },
    ],
    texts: { f1: { content: 't', content_hash: 'h1' }, f2: { content: 't', content_hash: 'h2' } },
    deps: {
      runBillChainFn: async () => {
        chainCalls += 1;
        const e = new Error('Your credit balance is too low'); e.status = 400; throw e;
      },
    },
  });
  const report = await runTick(deps);
  assert.equal(report.balanceDepleted, true);
  assert.equal(calls.closed[0].detail.balance_depleted, true);
  assert.ok(calls.logs.some((l) => /BALANCE DEPLETED/.test(l)));
  // Regression guard (task-4 review, finding 2): the assertions above would still pass even if
  // the loop continued past the billing error to bill f2 — pin the actual `break` behavior so a
  // future regression (the loop no longer stopping after a billing error) fails loudly. Only ONE
  // chain call ever fires (f1's), f2 is never attempted, and f1's own failed attempt is recorded
  // as a balance-depleted stop, not a generic skip.
  assert.equal(chainCalls, 1);
  assert.equal(calls.closed[0].detail.lanes.fresh, 0);
  assert.equal(calls.closed[0].detail.skipped.length, 0);
});

test('runTick: monster-lane 1.5x-allowance headroom gate — attempted with ample headroom, excluded (skipped, no chain call) without it', async () => {
  const monsterQueue = [{
    bill_id: 'm1', identifier: 'HB 9', title: 'T', bill_text_hash: 'hm', text_length: 200000, priority: 'other',
  }];
  const monsterTexts = { m1: { content: 't', content_hash: 'hm' } };

  // Sub-case A: default allowance ($1.00, no prior spend this week) is comfortably above the gate
  // (1.5 * the 0.05 worst-bill floor = $0.075) — the monster is attempted and its chain call fires.
  let ampleChainCalls = 0;
  const ample = fakeDeps({
    queue: monsterQueue,
    texts: monsterTexts,
    deps: {
      runBillChainFn: async (a, tracker, { bill }) => {
        ampleChainCalls += 1;
        tracker.record('claude-haiku-4-5', { input_tokens: 10000, output_tokens: 1000 }, `author:${bill.identifier}`);
        return {
          envelope: {
            bill_id: bill.bill_id, identifier: bill.identifier, bill_text_hash: bill.bill_text_hash, summary: {}, verdicts: [], completeness: {}, provenance: 'api', author_model: 'claude-haiku-4-5', verifier_model: 'claude-sonnet-5',
          },
        };
      },
    },
  });
  await runTick(ample.deps);
  assert.equal(ampleChainCalls, 1);
  assert.equal(ample.calls.closed[0].detail.lanes.monster, 1);
  assert.equal(ample.calls.closed[0].detail.skipped.length, 0);

  // Sub-case B: prior spend this week ($4.94) leaves only a $0.06 tick allowance — at-or-below the
  // same 1.5x gate ($0.075) — the monster is excluded BEFORE any chain call and lands as a skip.
  let tightChainCalls = 0;
  const tight = fakeDeps({
    queue: monsterQueue,
    texts: monsterTexts,
    recentRuns: [{ status: 'succeeded', detail: { week_key: '2026-W33', spent_usd: 4.94 } }],
    deps: {
      runBillChainFn: async () => { tightChainCalls += 1; throw new Error('must not be called — gate should exclude this bill first'); },
    },
  });
  await runTick(tight.deps);
  assert.equal(tightChainCalls, 0);
  assert.equal(tight.calls.closed[0].detail.lanes.monster, 0);
  assert.equal(tight.calls.closed[0].detail.skipped.length, 1);
});

test('runTick: MalformedSummaryError from record parks the bill durably', async () => {
  const parkedWrites = [];
  const { deps } = fakeDeps({
    queue: [{ bill_id: 'f1', identifier: 'HB 1', title: 'T', bill_text_hash: 'h1', text_length: 500, priority: 'other' }],
    texts: { f1: { content: 't', content_hash: 'h1' } },
    recordResult: { counts: { published: 0 }, gated: [], failures: [{ bill_id: 'f1', error: 'MalformedSummaryError', message: 'checker floor' }] },
    deps: { writeParked: (obj) => parkedWrites.push(obj) },
  });
  await runTick(deps);
  assert.equal(parkedWrites.length, 1);
  assert.ok(parkedWrites[0].f1);
  assert.match(parkedWrites[0].f1.reason, /checker floor/);
});

test('runTick: dry-run assembles lanes but never opens a run, spends, or records', async () => {
  const { deps, calls } = fakeDeps({
    dryRun: true,
    queue: [{ bill_id: 'f1', identifier: 'HB 1', title: 'T', bill_text_hash: 'h1', text_length: 500, priority: 'other' }],
    texts: { f1: { content: 't', content_hash: 'h1' } },
  });
  const report = await runTick(deps);
  assert.equal(report.outcome, 'dry-run');
  assert.equal(report.lanes.length, 1);
  assert.equal(calls.closed.length, 0);
  assert.equal(calls.records.length, 0);
});

test('runTick: lock not acquired exits quietly without touching anything', async () => {
  const { deps, calls } = fakeDeps({ deps: { acquireLockFn: () => ({ acquired: false, reason: 'already-running' }) } });
  const report = await runTick(deps);
  assert.equal(report.outcome, 'already-running');
  assert.equal(calls.closed.length, 0);
});
