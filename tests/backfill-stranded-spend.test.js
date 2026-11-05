import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backfillFor, backfillStrandedSpend, TARGET_FILTER,
} from '../scripts/backfill-stranded-spend.mjs';
import { strandedSpendPatch, STRANDED_TICK_CHARGE_USD, isoWeekKeyOf } from '../scripts/close-stranded-runs.mjs';
import { PER_TICK_CAP_USD, summarizeWeekSpend } from '../scripts/scheduled-summaries.js';

// ---------------------------------------------------------------------------
// Backfilling the spend charge onto the six ticks closed before closureFor recorded one
// (2026-11-05).
//
// These rows were charged the conservative cap while they sat at status='running', then dropped to
// $0 the moment they were closed, because the ledger reads a CLOSED row's detail.spent_usd and
// closureFor wrote none. The scheduler's own logs caught the swing: 2026-W45 read $11.41 on 11-02
// and $6.92 on 11-04, having spent MORE money in between.
// ---------------------------------------------------------------------------

const billed = (startedAt, detail) => ({
  id: 'r1', source: 'scheduled-summaries', status: 'failed', started_at: startedAt, detail,
});

test('backfillFor: records the conservative charge, its week, and that it is an ESTIMATE', () => {
  const p = backfillFor(billed('2026-11-03T12:00:35Z', { closed_by: 'scripts/close-stranded-runs.mjs' }));
  assert.equal(p.detail.spent_usd, STRANDED_TICK_CHARGE_USD);
  assert.equal(p.detail.week_key, '2026-W45');
  assert.equal(p.detail.spend_is_estimated, true, 'an estimate that cannot be told from a measurement gets quoted as fact later');
  assert.equal(p.detail.spend_backfilled_by, 'scripts/backfill-stranded-spend.mjs');
});

test('backfillFor: patches the spend fields ONLY — never status, finished_at or reason', () => {
  // closureFor set those correctly on 2026-11-04 from a `now` of that date. Re-deriving a
  // stuck-duration from today would rewrite a figure that was right when written.
  const p = backfillFor(billed('2026-11-03T12:00:35Z', { closed_by: 'scripts/close-stranded-runs.mjs', reason: 'sat for 19h' }));
  assert.deepEqual(Object.keys(p), ['detail'], 'a PATCH body with status or finished_at would rewrite the closure itself');
  assert.equal(p.detail.reason, 'sat for 19h', 'the original closure reason is evidence and must survive');
});

test('backfillFor: PRESERVES every existing detail field', () => {
  const p = backfillFor(billed('2026-11-03T12:00:35Z', { closed_by: 'x', closed_at: 'then', keep: 'me' }));
  assert.equal(p.detail.keep, 'me');
  assert.equal(p.detail.closed_at, 'then');
});

test('backfillFor: a row that recorded its OWN spend is left alone', () => {
  // A tick that got far enough to measure its cost knows better than this script. Overwriting a
  // measured figure with an estimate is the one way this repair could make the ledger worse.
  assert.equal(backfillFor(billed('2026-11-03T12:00:35Z', { spent_usd: 0.42 })), null);
  assert.equal(backfillFor(billed('2026-11-03T12:00:35Z', { spent_usd: 0 })), null, '$0 is a measurement too, not an absence');
});

test('backfillFor: a NON-billed source gets no invented dollar figure', () => {
  const p = backfillFor({ id: 'r1', source: 'correct-data', status: 'failed', started_at: '2026-11-03T12:00:35Z', detail: {} });
  assert.equal(p, null, 'no other source has a spend ledger; a cost for an unbilled ingest run never existed');
});

test('backfillFor: an existing week_key is preserved rather than re-derived', () => {
  const p = backfillFor(billed('2026-11-03T12:00:35Z', { week_key: '2026-W01' }));
  assert.equal(p.detail.week_key, '2026-W01', 'the tick knew its own week');
});

// ---- the shared definition --------------------------------------------------------------------
// strandedSpendPatch was extracted so closureFor (closing a row now) and this backfill (repairing
// rows closed before the fix) cannot disagree about what a crashed tick cost. These assert the
// extraction actually holds rather than having been merely intended.

test('strandedSpendPatch: ONE definition drives both the closer and the backfill', () => {
  const run = billed('2026-11-03T12:00:35Z', {});
  const shared = strandedSpendPatch(run);
  const viaBackfill = backfillFor(run).detail;
  for (const k of Object.keys(shared)) {
    assert.deepEqual(viaBackfill[k], shared[k], `${k} must come from the shared patch, not a second copy`);
  }
});

test('strandedSpendPatch: the charge is the scheduler own hard default, not a restated constant', () => {
  assert.equal(STRANDED_TICK_CHARGE_USD, PER_TICK_CAP_USD, 'two copies of "conservative" will drift');
});

test('strandedSpendPatch: refuses to guess a week from an unparseable timestamp', () => {
  assert.equal(strandedSpendPatch(billed('not a date', {})).week_key, null);
  assert.equal(isoWeekKeyOf('not a date'), null);
});

// ---- the end-to-end property this repair exists for -------------------------------------------

test('a backfilled row counts in its week exactly as it did while stranded', () => {
  // This is the whole point. The ledger charged these rows the cap while they were open; after the
  // repair it must charge them the same. Anything else means closing a row still changes history.
  const openRow = { status: 'running', started_at: '2026-11-03T12:00:35Z', detail: {} };
  const whileStranded = summarizeWeekSpend([openRow], '2026-W45', PER_TICK_CAP_USD);

  const closedRow = { status: 'failed', started_at: '2026-11-03T12:00:35Z', detail: { closed_by: 'x' } };
  const beforeRepair = summarizeWeekSpend([closedRow], '2026-W45', PER_TICK_CAP_USD);
  const repaired = { status: 'failed', started_at: closedRow.started_at, detail: backfillFor({ ...closedRow, source: 'scheduled-summaries' }).detail };
  const afterRepair = summarizeWeekSpend([repaired], '2026-W45', PER_TICK_CAP_USD);

  assert.equal(beforeRepair.spentUsd, 0, 'the defect: a closed crash read as free');
  assert.equal(afterRepair.spentUsd, whileStranded.spentUsd, 'the repair: closure no longer changes the week total');
});

test('a backfilled row burdens ONLY its own week', () => {
  // Pairs with the 2026-11-04 scoping fix. Restoring the charge must not restore the old defect of
  // one crash eating every week's budget.
  const repaired = {
    status: 'failed',
    started_at: '2026-11-03T12:00:35Z',
    detail: backfillFor(billed('2026-11-03T12:00:35Z', {})).detail,
  };
  assert.equal(summarizeWeekSpend([repaired], '2026-W45', PER_TICK_CAP_USD).spentUsd, STRANDED_TICK_CHARGE_USD);
  assert.equal(summarizeWeekSpend([repaired], '2026-W44', PER_TICK_CAP_USD).spentUsd, 0);
});

// ---- the write path --------------------------------------------------------------------------

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const target = {
  id: 'r1', source: 'scheduled-summaries', status: 'failed', started_at: '2026-11-03T12:00:35Z',
  detail: { closed_by: 'scripts/close-stranded-runs.mjs', keep: 'me' },
};

function recordingFetch(patchBody = [target]) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body });
    return opts.method === 'PATCH' ? okJson(patchBody) : okJson([target]);
  };
  return { calls, fn };
}

test('TARGET_FILTER: carries the spent_usd=is.null guard, which is what makes a re-run a no-op', () => {
  // Idempotence lives in the QUERY, not in a post-read JavaScript check. Running --apply twice must
  // not charge a row twice, and this is the mechanism.
  assert.match(TARGET_FILTER, /detail->>spent_usd=is\.null/);
  assert.match(TARGET_FILTER, /source=eq\.scheduled-summaries/, 'no other source has a spend ledger');
  assert.match(TARGET_FILTER, /closed_by=eq\.scripts\/close-stranded-runs\.mjs/, 'the crash must be established by an artifact, not inferred from a status');
});

test('backfillStrandedSpend: a DRY RUN issues no PATCH at all', async () => {
  const { calls, fn } = recordingFetch();
  const r = await backfillStrandedSpend({ url: 'https://x', key: 'k', fetchFn: fn, log: () => {} });
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0, 'a dry run must not write');
  assert.equal(r.found, 1);
  assert.equal(r.written, 0);
  assert.equal(r.wrote, false);
});

test('backfillStrandedSpend: the dry run previews the SAME rows the apply will touch', async () => {
  // A preview built from a different filter than the write is a preview of nothing. Both paths use
  // TARGET_FILTER for the read, and the write re-states only the id plus the null guard.
  const { calls, fn } = recordingFetch();
  await backfillStrandedSpend({ url: 'https://x', key: 'k', fetchFn: fn, log: () => {} });
  assert.ok(calls[0].url.includes(TARGET_FILTER), 'the read must use the shared filter verbatim');
});

test('backfillStrandedSpend: --apply guards the write by id AND the null spend, never id alone', async () => {
  const { calls, fn } = recordingFetch();
  const r = await backfillStrandedSpend({ url: 'https://x', key: 'k', apply: true, fetchFn: fn, log: () => {} });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'apply must issue a PATCH');
  assert.match(patch.url, /id=eq\.r1/, 'must target the exact row');
  assert.match(
    patch.url, /detail->>spent_usd=is\.null/,
    'without the null guard, a row that acquired a real figure between read and write would be overwritten with an estimate',
  );
  assert.equal(r.written, 1);
  assert.equal(r.wrote, true);
});

test('backfillStrandedSpend: --apply preserves existing detail and adds only the spend fields', async () => {
  const { calls, fn } = recordingFetch();
  await backfillStrandedSpend({ url: 'https://x', key: 'k', apply: true, fetchFn: fn, log: () => {} });
  const body = JSON.parse(calls.find((c) => c.method === 'PATCH').body);
  assert.equal(body.detail.keep, 'me');
  assert.equal(body.detail.closed_by, 'scripts/close-stranded-runs.mjs');
  assert.equal(body.detail.spent_usd, STRANDED_TICK_CHARGE_USD);
  assert.equal(body.status, undefined, 'the closure status was right; do not rewrite it');
  assert.equal(body.finished_at, undefined);
});

test('backfillStrandedSpend: an empty PATCH result is SKIPPED, not counted as written (the race)', async () => {
  const { fn } = recordingFetch([]);
  const r = await backfillStrandedSpend({ url: 'https://x', key: 'k', apply: true, fetchFn: fn, log: () => {} });
  assert.equal(r.written, 0);
  assert.equal(r.skipped, 1);
});

test('backfillStrandedSpend: nothing to repair does not write and does not claim to have', async () => {
  const calls = [];
  const fn = async (url, opts = {}) => { calls.push(opts.method ?? 'GET'); return okJson([]); };
  const r = await backfillStrandedSpend({ url: 'https://x', key: 'k', apply: true, fetchFn: fn, log: () => {} });
  assert.equal(r.found, 0);
  assert.equal(r.written, 0);
  assert.equal(r.wrote, false);
  assert.equal(calls.filter((m) => m !== 'GET').length, 0);
});

test('backfillStrandedSpend: a failed PATCH throws rather than reporting a false repair', async () => {
  const fn = async (url, opts = {}) => (opts.method === 'PATCH'
    ? { ok: false, status: 409, json: async () => ({}), text: async () => 'conflict' }
    : okJson([target]));
  await assert.rejects(
    () => backfillStrandedSpend({ url: 'https://x', key: 'k', apply: true, fetchFn: fn, log: () => {} }),
    /failed to backfill r1: HTTP 409/,
  );
});

test('backfillStrandedSpend: an unreadable PATCH response is not counted as a successful write', async () => {
  // expectArray fails closed here. The alternative — a non-array making rows.length===0 false —
  // would report a repair that may not have happened, the worst of the fail-open cases.
  const fn = async (url, opts = {}) => (opts.method === 'PATCH' ? okJson({ not: 'an array' }) : okJson([target]));
  await assert.rejects(
    () => backfillStrandedSpend({ url: 'https://x', key: 'k', apply: true, fetchFn: fn, log: () => {} }),
  );
});

test('backfillStrandedSpend: reports the per-week totals it is about to add', async () => {
  // The dry run has to let a reader see the ledger effect BEFORE approving it, per week, because a
  // week that would be pushed past its cap by estimates is a thing to notice rather than discover.
  const { fn } = recordingFetch();
  const r = await backfillStrandedSpend({ url: 'https://x', key: 'k', fetchFn: fn, log: () => {} });
  assert.deepEqual(r.byWeek, { '2026-W45': STRANDED_TICK_CHARGE_USD });
});
