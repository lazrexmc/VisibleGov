import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKLY_CAP_USD, PER_TICK_CAP_USD, MONSTER_THRESHOLD_CHARS, MAX_CONVERSIONS_EXAMINED, envCapUsd,
  currentWeekKey, summarizeWeekSpend, tickAllowance, sortQueueRecencyFirst, computeDraftOnly,
  assembleTick, estimateBillCostUsd, runTick,
} from '../scripts/scheduled-summaries.js';
import { PRICES_VERIFIED_THROUGH } from '../src/lib/billed-summary-chain.js';

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

test('summarizeWeekSpend: I9 — a crashed row is charged the code default even when THIS tick is running under a lowered env cap', () => {
  const rows = [
    { status: 'running', detail: {} }, // crashed under yesterday's real $1.00 cap
  ];
  // Today's tick is deliberately throttled (e.g. the I7 first-live-tick manual procedure,
  // SUMMARY_TICK_CAP_USD=0.10) — the crashed row must still be charged the full PER_TICK_CAP_USD
  // default, never today's 0.10, or the weekly ledger would under-count real prior spend.
  const out = summarizeWeekSpend(rows, '2026-W33', 0.10);
  assert.equal(out.spentUsd, PER_TICK_CAP_USD);
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

test('estimateBillCostUsd: I3 — matches the review\'s own worked example, padded above the real worst case', () => {
  // 400k-char bill: input (100000/1e6 Mtok * 7.0) + $0.665 fixed output ceiling ≈ $1.365 —
  // deliberately above the real worst-case chain cost the review itself computed (~$0.99: haiku
  // author 100k-in/16k-out + sonnet verify 100k-in/32k-out + sonnet provisions 100k-in/4k-out +
  // coverage ~$0.05), never below it.
  const est400k = estimateBillCostUsd(400000);
  assert.ok(Math.abs(est400k - 1.365) < 0.001, `expected ~1.365, got ${est400k}`);
  assert.ok(est400k > 0.99, 'the padded estimate must stay above the real worst-case cost');
  // A trivially small bill still costs at least the fixed output ceiling — the guard is never
  // free, since every chain call pays fixed per-stage output tokens regardless of input size.
  assert.ok(Math.abs(estimateBillCostUsd(0) - 0.665) < 0.0001);
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
  // text_length just over MONSTER_THRESHOLD_CHARS (100001, not the old 200000): I3's own
  // pre-bill estimateBillCostUsd guard (a SEPARATE, additive check — see the dedicated I3 test
  // below) must not itself exclude the "ample" sub-case here. estimateBillCostUsd(100001) ≈
  // $0.84, comfortably under the $1.00 default allowance; estimateBillCostUsd(200000) ≈ $1.015
  // would not have been, which is exactly the I3 test's own point made with a bigger bill.
  const monsterQueue = [{
    bill_id: 'm1', identifier: 'HB 9', title: 'T', bill_text_hash: 'hm', text_length: 100001, priority: 'other',
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

test('runTick: I3 — pre-bill cost-estimate guard skips an under-funded bill BEFORE any chain call, even when the OLD 1.5x-worst-bill gate alone would have let it through; ample allowance and a tight-but-sufficient allowance both still run', async () => {
  // Sub-case A: a 400k-char monster (the review's own worked example, ~$1.365 estimate) under the
  // DEFAULT $1.00 tick allowance. The OLD monster-specific 1.5x-worst-bill gate would have passed
  // this (1.00 - 0 = 1.00 > 1.5 * 0.05 = 0.075) — the NEW I3 guard is what actually excludes it.
  let bigChainCalls = 0;
  const big = fakeDeps({
    queue: [{
      bill_id: 'm2', identifier: 'HB 99', title: 'T', bill_text_hash: 'hm2', text_length: 400000, priority: 'other',
    }],
    texts: { m2: { content: 't', content_hash: 'hm2' } },
    deps: {
      runBillChainFn: async () => { bigChainCalls += 1; throw new Error('must not be called — I3 guard should exclude this bill first'); },
    },
  });
  const bigReport = await runTick(big.deps);
  assert.equal(bigChainCalls, 0);
  assert.equal(bigReport.detail.lanes.monster, 0);
  assert.equal(bigReport.detail.skipped.length, 1);
  assert.match(bigReport.detail.skipped[0].reason, /pre-bill cost estimate/);
  assert.equal(big.calls.closed[0].status, 'partial'); // a non-routine (I3-estimate) skip still marks partial

  // Sub-case B: a small FRESH-lane bill under a genuinely tight remaining allowance ($0.70, via
  // prior spend this week of $4.30) still runs — its estimate (~$0.666, near the fixed output
  // floor) fits comfortably, unlike the 400k monster above at the very same allowance.
  let smallChainCalls = 0;
  const small = fakeDeps({
    queue: [{ bill_id: 'f9', identifier: 'HB 9', title: 'T', bill_text_hash: 'hf9', text_length: 500, priority: 'other' }],
    texts: { f9: { content: 't', content_hash: 'hf9' } },
    recentRuns: [{ status: 'succeeded', detail: { week_key: '2026-W33', spent_usd: 4.30 } }], // allowance = $0.70
    deps: {
      runBillChainFn: async (a, tracker, { bill }) => {
        smallChainCalls += 1;
        tracker.record('claude-haiku-4-5', { input_tokens: 100, output_tokens: 100 }, `author:${bill.identifier}`);
        return {
          envelope: {
            bill_id: bill.bill_id, identifier: bill.identifier, bill_text_hash: bill.bill_text_hash, summary: {}, verdicts: [], completeness: {}, provenance: 'api', author_model: 'claude-haiku-4-5', verifier_model: 'claude-sonnet-5',
          },
        };
      },
    },
  });
  await runTick(small.deps);
  assert.equal(smallChainCalls, 1);
  assert.equal(small.calls.closed[0].detail.lanes.fresh, 1);
  assert.equal(small.calls.closed[0].detail.skipped.length, 0);
});

test('runTick: I4 — a throwing record CLI call (recordLane) is caught; the run still closes honestly (status partial), the error lands in detail.skipped, records file already on disk', async () => {
  const { deps, calls } = fakeDeps({
    queue: [{ bill_id: 'f1', identifier: 'HB 1', title: 'T', bill_text_hash: 'h1', text_length: 500, priority: 'other' }],
    texts: { f1: { content: 't', content_hash: 'h1' } },
    deps: {
      runChildCliFn: (script, args) => {
        if (args[0] === 'plan') return { parsed: { queue: [{ bill_id: 'f1', identifier: 'HB 1', title: 'T', bill_text_hash: 'h1', text_length: 500, priority: 'other' }] } };
        const e = new Error('summary-queue.js exceeded its timeout and was killed (ETIMEDOUT)');
        e.code = 'ETIMEDOUT';
        throw e;
      },
    },
  });
  const report = await runTick(deps);
  assert.equal(report.outcome, 'ok');
  assert.equal(calls.closed.length, 1);
  assert.equal(calls.closed[0].status, 'partial');
  assert.ok(calls.closed[0].detail.skipped.some((s) => /ETIMEDOUT/.test(s.reason)));
  assert.equal(calls.records.length, 1); // the records file was written before the throw — never lost
});

test('runTick: I5 — a throwing plan CLI is caught, logged, and returns plan-failed without opening a run row', async () => {
  const { deps, calls } = fakeDeps({
    deps: {
      runChildCliFn: (script, args) => {
        if (args[0] === 'plan') {
          const e = new Error('summary-queue.js exceeded its 900000ms timeout and was killed (ETIMEDOUT)');
          e.code = 'ETIMEDOUT';
          throw e;
        }
        return { parsed: { counts: { published: 1, gated: 0, failures: 0 }, gated: [], failures: [] } };
      },
    },
  });
  const report = await runTick(deps);
  assert.equal(report.outcome, 'plan-failed');
  assert.equal(calls.closed.length, 0);
  assert.ok(calls.logs.some((l) => /plan CLI failed/.test(l)));
});

test('runTick: I8 — MAX_CONVERSIONS_EXAMINED caps how many draft-only bills are examined per tick; routine ineligibility skips do not force status partial', async () => {
  const summaryRows = [];
  const texts = {};
  const total = MAX_CONVERSIONS_EXAMINED + 10;
  for (let i = 0; i < total; i += 1) {
    const billId = `c${i}`;
    summaryRows.push({
      id: `s${i}`, bill_id: billId, status: 'draft', bill_text_hash: `h${i}`, created_at: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`,
    });
    texts[billId] = { content: 't', content_hash: `h${i}` };
  }
  const { deps, calls } = fakeDeps({
    queue: [], // no fresh/monster lane items — isolate the conversion lane
    summaryRows,
    texts,
    deps: {
      // Every draft is routinely ineligible (no verifications on file) — the review's own
      // "hundreds of draft-only bills examined forever" scenario.
      loadDraftObjectionsFn: async () => ({ priorSummary: {}, objections: [], hasVerifications: false }),
    },
  });
  const report = await runTick(deps);
  const routineSkips = calls.closed[0].detail.skipped.filter((s) => /no objections\/verifications/.test(s.reason));
  assert.equal(routineSkips.length, MAX_CONVERSIONS_EXAMINED, 'only MAX_CONVERSIONS_EXAMINED entries are ever examined, not all ' + total);
  assert.equal(calls.closed[0].status, 'succeeded', 'a tick that only skips routine, ineligible conversions is NOT partial');
  assert.equal(report.detail.published, 0);
});

test('runTick: I8 — a non-routine skip (e.g. a bill_texts hash mismatch) still marks status partial', async () => {
  const { deps, calls } = fakeDeps({
    queue: [{ bill_id: 'f1', identifier: 'HB 1', title: 'T', bill_text_hash: 'h1', text_length: 500, priority: 'other' }],
    texts: { f1: { content: 't', content_hash: 'WRONG-HASH' } }, // mismatch vs. queue's h1
  });
  await runTick(deps);
  assert.equal(calls.closed[0].status, 'partial');
  assert.match(calls.closed[0].detail.skipped[0].reason, /hash mismatch/);
});

test('runTick: I9-adjacent fix-in-passing — an unreadable (null) parked read never triggers writeParked, even when new park-worthy failures exist this tick', async () => {
  let writeParkedCalls = 0;
  const { deps, calls } = fakeDeps({
    queue: [{ bill_id: 'f1', identifier: 'HB 1', title: 'T', bill_text_hash: 'h1', text_length: 500, priority: 'other' }],
    texts: { f1: { content: 't', content_hash: 'h1' } },
    recordResult: { counts: { published: 0 }, gated: [], failures: [{ bill_id: 'f1', error: 'MalformedSummaryError', message: 'checker floor' }] },
    deps: {
      readParked: () => null, // simulates an unreadable/corrupt parked.json
      writeParked: () => { writeParkedCalls += 1; },
    },
  });
  await runTick(deps);
  assert.equal(writeParkedCalls, 0);
  assert.ok(calls.logs.some((l) => /parked\.json was unreadable/.test(l)));
});

test('runTick: T4-triage — the conversion lane happy path actually spends: a draft-only bill with objections runs reAuthor, records, and closes published', async () => {
  let chainArgs = null;
  const { deps, calls } = fakeDeps({
    queue: [], // no fresh/monster items — isolate the conversion lane
    summaryRows: [
      { id: 's1', bill_id: 'c1', status: 'draft', bill_text_hash: 'hc1', created_at: '2026-08-01T00:00:00Z' },
    ],
    texts: { c1: { content: 'bill text', content_hash: 'hc1' } },
    draftObjections: {
      priorSummary: { what_it_does: [{ point: 'p', section: 's' }], stated_purpose: '' },
      objections: ['fix the citation'],
      hasVerifications: true,
      identifier: 'HB 1',
      title: 'Test Bill',
    },
    recordResult: { counts: { published: 1, gated: 0, failures: 0 }, gated: [], failures: [] },
    deps: {
      runBillChainFn: async (a, tracker, args) => {
        chainArgs = args;
        tracker.record('claude-haiku-4-5', { input_tokens: 5000, output_tokens: 500 }, `reauthor:${args.bill.identifier}`);
        return {
          envelope: {
            bill_id: args.bill.bill_id, identifier: args.bill.identifier, bill_text_hash: args.bill.bill_text_hash, summary: {}, verdicts: [], completeness: {}, provenance: 'api', author_model: 'claude-haiku-4-5', verifier_model: 'claude-sonnet-5',
          },
        };
      },
    },
  });
  const report = await runTick(deps);
  assert.equal(report.outcome, 'ok');
  assert.ok(chainArgs, 'runBillChainFn must have been called');
  assert.ok(chainArgs.reAuthor, 'the conversion lane must pass reAuthor args');
  assert.deepEqual(chainArgs.reAuthor.objections, ['fix the citation']);
  assert.equal(chainArgs.bill.bill_id, 'c1');
  assert.equal(chainArgs.bill.identifier, 'HB 1');
  assert.equal(calls.records.length, 1); // the drafts records file, written once
  assert.equal(calls.closed[0].status, 'succeeded');
  assert.equal(calls.closed[0].detail.lanes.conversion, 1);
  assert.equal(calls.closed[0].detail.published, 1);
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

// Regression, 2026-09-02. The price-expiry guard (7e614ea) read `new Date()` inside a function
// whose whole design is clock-injectable, so on 2026-09-01 ten runTick tests went red for a reason
// none of them was about. A guard that reaches around dependency injection to the wall clock makes
// every test of the code it guards depend on the day it is run. These two pin the injection itself,
// not the outcome on any particular date.
test('runTick: the price-expiry guard reads the INJECTED clock, not the wall clock', async () => {
  const expired = new Date(`${PRICES_VERIFIED_THROUGH}T00:00:00Z`);
  expired.setUTCDate(expired.getUTCDate() + 1);
  const { deps, calls } = fakeDeps({
    queue: [{ bill_id: 'b1', identifier: 'HB 1', bill_text_hash: 'h1' }],
    texts: { b1: { bill_id: 'b1', content: 'text', content_hash: 'h1' } },
    deps: { now: () => expired },
  });
  const report = await runTick(deps);
  assert.equal(report.outcome, 'skipped-prices-unverified');
  assert.match(report.detail, /price table unverified/);
  // The whole point of skipping BEFORE openRun: no run row to strand, nothing spent.
  assert.equal(calls.closed.length, 0);
  assert.equal(calls.records.length, 0);
  // ...but it MUST still leave a trace. Skipping before openRun writes no run row, so without a
  // log line the tick is indistinguishable from a tick that never ran at all - which is exactly
  // what happened between 2026-08-31 and 09-04, while the docs asserted a daily skip that no
  // artifact could confirm. An expected absence with no evidence disarms the check for a real one.
  assert.equal(calls.logs.filter((l) => /prices unverified/.test(l)).length, 1);
});

test('runTick: an in-window injected clock does not trip the price guard', async () => {
  const inWindow = new Date(`${PRICES_VERIFIED_THROUGH}T00:00:00Z`);
  const { deps } = fakeDeps({ deps: { now: () => inWindow } });
  const report = await runTick(deps);
  assert.notEqual(report.outcome, 'skipped-prices-unverified');
});
