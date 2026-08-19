import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMoCitationBackfill, fetchBackfillInputs, executeBackfillPlan } from '../src/cli/backfill-mo-glossary-citations.js';

const T = (id, term, extra = {}) => ({
  id, term, kind: 'statute', citation: null, needs_mapping: true, gloss_md: null,
  created_at: '2026-08-01T00:00:00Z', hasVerifications: false, hasNotes: false, ...extra,
});
const MO = 'mo-legislature'; const FED = 'us-congress';

test('update in place: a clean MO-referenced section term maps', () => {
  const plan = planMoCitationBackfill({
    terms: [T('t1', 'section 536.010')],
    linksByTermId: new Map([['t1', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.deepEqual(plan.updates, [{ id: 't1', term: 'section 536.010', citation: 'RSMo 536.010' }]);
  assert.deepEqual(plan.merges, []);
});

test('jurisdiction guard: mixed or federal references never map; zero links never map', () => {
  const plan = planMoCitationBackfill({
    terms: [T('t1', 'chapter 303'), T('t2', 'section 33.080'), T('t3', '302.309')],
    linksByTermId: new Map([['t1', ['s1', 's2']], ['t2', ['s2']]]),
    jurisdictionBySummaryId: new Map([['s1', MO], ['s2', FED]]),
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.skips.guardBlocked, 2);
  assert.equal(plan.skips.zeroLinks, 1);
});

test('intra-batch collision: most-linked row survives; tie -> earliest created_at -> smallest id', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('t1', 'section 536.010'),
      T('t2', '536.010, RSMo', { created_at: '2026-07-01T00:00:00Z' }),
    ],
    linksByTermId: new Map([['t1', ['s1', 's2']], ['t2', ['s3']]]),
    jurisdictionBySummaryId: new Map([['s1', MO], ['s2', MO], ['s3', MO]]),
  });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, 't1'); // most links wins despite t2 being older
  assert.deepEqual(plan.merges, [{ survivorId: 't1', loserId: 't2', citation: 'RSMo 536.010', linkMoves: ['s3'] }]);
});

test('collision with an existing mapped row: the mapped row always survives', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('m1', 'ignored', { citation: 'RSMo 536.010', needs_mapping: false }),
      T('t1', 'section 536.010'),
    ],
    linksByTermId: new Map([['t1', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.equal(plan.updates.length, 0);
  assert.deepEqual(plan.merges, [{ survivorId: 'm1', loserId: 't1', citation: 'RSMo 536.010', linkMoves: ['s1'] }]);
});

// Ruling 3 (controller, Task 7): an existing mapped row colliding with TWO unmapped stub
// candidates must produce zero updates (the mapped row already carries the citation — no update
// needed) and BOTH candidates merge into it as the survivor, never into each other.
test('collision with an existing mapped row and TWO unmapped stub candidates: zero updates, both merge into the mapped survivor', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('m1', 'ignored', { citation: 'RSMo 536.010', needs_mapping: false }),
      T('t1', 'section 536.010'),
      T('t2', '536.010, RSMo', { created_at: '2026-07-01T00:00:00Z' }),
    ],
    linksByTermId: new Map([['t1', ['s1']], ['t2', ['s2']]]),
    jurisdictionBySummaryId: new Map([['s1', MO], ['s2', MO]]),
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.merges.length, 2);
  assert.ok(plan.merges.every((m) => m.survivorId === 'm1'), 'both merges must target the mapped row as survivor');
  assert.deepEqual(plan.merges.map((m) => m.loserId).sort(), ['t1', 't2']);
  assert.ok(plan.merges.every((m) => m.citation === 'RSMo 536.010'));
});

test('stub assertion: a merge loser with gloss content/verifications/notes is skipped, never merged', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('t1', 'section 536.010'),
      T('t2', '536.010', { hasVerifications: true }),
    ],
    linksByTermId: new Map([['t1', ['s1', 's2']], ['t2', ['s3']]]),
    jurisdictionBySummaryId: new Map([['s1', MO], ['s2', MO], ['s3', MO]]),
  });
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.skips.stubViolations.length, 1);
  assert.equal(plan.skips.stubViolations[0].id, 't2');
  assert.equal(plan.updates.length, 1); // the survivor still updates
});

test('kinds are separate namespaces: same citation under different kinds never merges', () => {
  const plan = planMoCitationBackfill({
    terms: [T('t1', 'section 536.010'), T('t2', 'section 536.010', { kind: 'program' })],
    linksByTermId: new Map([['t1', ['s1']], ['t2', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.equal(plan.updates.length, 2);
  assert.equal(plan.merges.length, 0);
});

test('already-mapped rows and unparseable terms are never updates', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('m1', 'x', { citation: '42 U.S.C. 1396b', needs_mapping: false }),
      T('t1', 'sections 302.302 to 302.309'),
      T('t2', 'RSMo'),
    ],
    linksByTermId: new Map([['t1', ['s1']], ['t2', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.skips.parseFailed, 2);
});

// ---- Task 7: fetchBackfillInputs / executeBackfillPlan ----
//
// fetchBackfillInputs: a minimal selectAll-shaped fake (select -> order -> range), one page per
// table — proves the given brief code's selectAll destructure (selectAll returns {data,error},
// same contract as gloss.js's loadAllTerms and backfill-mo-term-dates.js's loadDatelessMoTerms,
// NEVER a bare array) is actually wired correctly, and that a table-load error surfaces loudly.

function fakeSelectAllClient(rowsByTable) {
  return {
    from(table) {
      return {
        select() { return this; },
        order() { return this; },
        range: () => Promise.resolve({ data: rowsByTable[table] ?? [], error: null }),
      };
    },
  };
}

test('fetchBackfillInputs wires selectAll results into terms/linksByTermId/jurisdictionBySummaryId', async () => {
  const client = fakeSelectAllClient({
    glossary_terms: [{
      id: 't1', term: 'section 536.010', kind: 'statute', citation: null, needs_mapping: true,
      gloss_md: null, created_at: '2026-08-01T00:00:00Z',
    }],
    summary_terms: [{ summary_id: 's1', term_id: 't1' }],
    summaries: [{ id: 's1', bill_id: 'b1' }],
    bills: [{ id: 'b1', session_id: 'sess1' }],
    sessions: [{ id: 'sess1', jurisdiction_id: MO }],
    glossary_verifications: [],
    glossary_notes: [],
  });
  const inputs = await fetchBackfillInputs(client);
  assert.equal(inputs.terms.length, 1);
  assert.equal(inputs.terms[0].id, 't1');
  assert.equal(inputs.terms[0].hasVerifications, false);
  assert.equal(inputs.terms[0].hasNotes, false);
  assert.deepEqual(inputs.linksByTermId.get('t1'), ['s1']);
  assert.equal(inputs.jurisdictionBySummaryId.get('s1'), MO);
});

test('fetchBackfillInputs throws a descriptive error when a table read fails, rather than silently continuing', async () => {
  const client = {
    from: () => ({
      select() { return this; },
      order() { return this; },
      range: () => Promise.resolve({ data: null, error: { message: 'connection reset' } }),
    }),
  };
  await assert.rejects(() => fetchBackfillInputs(client), /glossary_terms load failed: connection reset/);
});

// ---- executeBackfillPlan: a stateful in-memory fake DB (not a canned-response fake) ----
//
// A canned-response fake (this file's sibling tests use a pure planning core, no DB) can't prove
// idempotency or the concurrent-write guards — those need real mutation between calls. This fake
// mirrors this project's actual Supabase mutation semantics (PLAYBOOK lesson 20: update/delete
// never populate a reliable `count`; every caller in this codebase reads returned row data
// instead) by only ever handing back rows, never a count field, and by actually filtering/
// mutating/removing rows in a per-table Map so a second call against the SAME fake sees the
// first call's effects — required for the idempotency test below.

function projectCols(row, cols) {
  if (!cols || cols === '*') return { ...row };
  const names = String(cols).split(',').map((c) => c.trim());
  const out = {};
  for (const n of names) out[n] = row[n];
  return out;
}

function rowMatches(row, filters) {
  return filters.every(([col, val]) => row[col] === val);
}

// onBeforeExecute(({table, op, filters, store}) => void) is an optional hook fired at the top of
// every execute() call, before filtering/mutation happens — it exists so a single test can
// simulate a write from a SECOND, concurrent process landing at a specific point mid-merge (e.g.
// "someone else maps the loser between this run's live stub re-check and its own delete"), which
// a purely-seeded starting state can't express: seeding the loser WITH a citation from the start
// would only ever exercise the EARLIER .maybeSingle() stub lookup, never the delete's own guard.
function makeFakeDb(seed, { onBeforeExecute } = {}) {
  const store = new Map(Object.entries(seed).map(([table, rows]) => [table, rows.map((r) => ({ ...r }))]));
  const calls = [];

  function from(table) {
    const filters = [];
    let op = null; // null (select) | 'update' | 'delete' | 'upsert'
    let patch = null;
    let selectCols = null;
    let upsertRows = null;
    let upsertOnConflict = null;

    function execute() {
      if (onBeforeExecute) onBeforeExecute({ table, op, filters, store });
      const rows = store.get(table) ?? [];
      if (op === 'upsert') {
        const keyCols = String(upsertOnConflict).split(',').map((c) => c.trim());
        for (const incoming of upsertRows) {
          const exists = rows.some((r) => keyCols.every((c) => r[c] === incoming[c]));
          if (!exists) rows.push({ ...incoming });
        }
        return { data: null, error: null };
      }
      const matched = rows.filter((r) => rowMatches(r, filters));
      if (op === 'delete') {
        const remaining = rows.filter((r) => !matched.includes(r));
        store.set(table, remaining);
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      if (op === 'update') {
        for (const r of matched) Object.assign(r, patch);
        return { data: matched.map((r) => projectCols(r, selectCols ?? 'id')), error: null };
      }
      return { data: matched.map((r) => projectCols(r, selectCols)), error: null }; // plain select
    }

    const builder = {
      select(cols) { calls.push({ table, method: 'select', args: [cols] }); selectCols = cols; return builder; },
      eq(col, val) { calls.push({ table, method: 'eq', args: [col, val] }); filters.push([col, val]); return builder; },
      is(col, val) { calls.push({ table, method: 'is', args: [col, val] }); filters.push([col, val]); return builder; },
      update(p) { calls.push({ table, method: 'update', args: [p] }); op = 'update'; patch = p; return builder; },
      delete() { calls.push({ table, method: 'delete', args: [] }); op = 'delete'; return builder; },
      upsert(rows, opts) {
        calls.push({ table, method: 'upsert', args: [rows, opts] });
        op = 'upsert'; upsertRows = rows; upsertOnConflict = opts?.onConflict;
        return builder;
      },
      maybeSingle() {
        const { data, error } = execute();
        return Promise.resolve({ data: (data && data[0]) ?? null, error });
      },
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
    };
    return builder;
  }

  return { from, store, calls };
}

const callsFor = (fake, table) => fake.calls.filter((c) => c.table === table);

test('executeBackfillPlan updates in place with a needs_mapping=true write guard', async () => {
  const fake = makeFakeDb({
    glossary_terms: [{ id: 't1', citation: null, needs_mapping: true, gloss_md: null }],
  });
  const plan = { updates: [{ id: 't1', term: 'section 536.010', citation: 'RSMo 536.010' }], merges: [] };
  const result = await executeBackfillPlan(fake, 'run-1', plan);
  assert.deepEqual(result, { updated: 1, merged: 0, skipped: [] });

  const row = fake.store.get('glossary_terms').find((r) => r.id === 't1');
  assert.equal(row.citation, 'RSMo 536.010');
  assert.equal(row.needs_mapping, false);

  // The write must be guarded by .eq('id', 't1').is('citation', null) — a concurrently-mapped row
  // can never be clobbered.
  const relevant = callsFor(fake, 'glossary_terms');
  assert.deepEqual(relevant.map((c) => c.method), ['update', 'eq', 'is', 'select']);
  assert.deepEqual(relevant[1].args, ['id', 't1']);
  assert.deepEqual(relevant[2].args, ['citation', null]);
});

test('executeBackfillPlan merges: link repointed insert-if-absent, old links deleted, loser deleted with a citation-null guard', async () => {
  const fake = makeFakeDb({
    glossary_terms: [
      { id: 't1', citation: 'RSMo 536.010', needs_mapping: false, gloss_md: null },
      { id: 't2', citation: null, needs_mapping: true, gloss_md: null },
    ],
    summary_terms: [{ summary_id: 's3', term_id: 't2' }],
    glossary_verifications: [],
    glossary_notes: [],
  });
  const plan = { updates: [], merges: [{ survivorId: 't1', loserId: 't2', citation: 'RSMo 536.010', linkMoves: ['s3'] }] };
  const result = await executeBackfillPlan(fake, 'run-1', plan);
  assert.deepEqual(result, { updated: 0, merged: 1, skipped: [] });

  assert.deepEqual(fake.store.get('summary_terms'), [{ summary_id: 's3', term_id: 't1' }]);
  assert.deepEqual(fake.store.get('glossary_terms').map((r) => r.id), ['t1']);

  // The loser delete must be guarded by .eq('id', ...).is('citation', null) — a row someone else
  // already mapped can never be deleted — and must carry .select('id') so the caller can verify
  // how many rows it actually removed (see the dedicated race-condition test below).
  const deleteCall = callsFor(fake, 'glossary_terms').find((c) => c.method === 'delete');
  assert.ok(deleteCall, 'expected a delete against glossary_terms');
  const afterDelete = callsFor(fake, 'glossary_terms').slice(callsFor(fake, 'glossary_terms').indexOf(deleteCall));
  assert.deepEqual(afterDelete.map((c) => c.method), ['delete', 'eq', 'is', 'select']);
  assert.deepEqual(afterDelete[1].args, ['id', 't2']);
  assert.deepEqual(afterDelete[2].args, ['citation', null]);
  assert.deepEqual(afterDelete[3].args, ['id']);
});

// Important finding (task-7 review, controller ruled it stands): the loser delete didn't verify
// how many rows it actually removed, unlike the update loop's .is('citation', null) guard check.
// If a SECOND, concurrent --apply invocation maps the loser's citation in the narrow window
// between THIS run's live stub re-check (the earlier .maybeSingle() lookup, which already passed
// since the loser was still a bare stub at that instant) and this run's own delete, the delete's
// .is('citation', null) guard silently matches zero rows — yet the old code still incremented
// result.merged, misreporting a completed merge while an orphaned, un-deleted loser survived with
// its links already repointed to the survivor.
//
// Seeding the loser WITH a citation from the start would only ever exercise the EARLIER
// .maybeSingle() lookup (it would skip with 'loser row gone or already mapped' before ever
// reaching the delete) — it can't reach the delete's own guard. To exercise that specific guard,
// this test uses makeFakeDb's onBeforeExecute hook to land the concurrent write at the exact
// moment the delete itself executes, after the stub re-check has already passed.
test('executeBackfillPlan: a citation concurrently mapped between the live stub re-check and the delete is an honest skip, never a false merged count', async () => {
  const fake = makeFakeDb({
    glossary_terms: [
      { id: 't1', citation: 'RSMo 536.010', needs_mapping: false, gloss_md: null },
      { id: 't2', citation: null, needs_mapping: true, gloss_md: null },
    ],
    summary_terms: [{ summary_id: 's3', term_id: 't2' }],
    glossary_verifications: [],
    glossary_notes: [],
  }, {
    onBeforeExecute: ({ table, op, store: s }) => {
      if (table === 'glossary_terms' && op === 'delete') {
        const row = s.get('glossary_terms').find((r) => r.id === 't2');
        if (row) row.citation = 'RSMo 999.999'; // a second process mapped it first
      }
    },
  });
  const plan = { updates: [], merges: [{ survivorId: 't1', loserId: 't2', citation: 'RSMo 536.010', linkMoves: ['s3'] }] };
  const result = await executeBackfillPlan(fake, 'run-1', plan);

  assert.equal(result.merged, 0, 'a delete that matched zero citation-null rows must never count as a completed merge');
  assert.deepEqual(result.skipped, [{
    id: 't2',
    reason: 'loser delete matched no citation-null row (concurrently mapped?) — links already repointed to survivor',
  }]);

  // The loser row survives — orphaned (its link was already repointed above), but never silently
  // vanished and never reported as a completed merge.
  const loserRow = fake.store.get('glossary_terms').find((r) => r.id === 't2');
  assert.ok(loserRow, 'loser row must still exist — the guarded delete did not remove it');
  assert.equal(loserRow.citation, 'RSMo 999.999');

  // The delete call itself must still carry .select('id') so a zero-row match is observable.
  const deleteCall = callsFor(fake, 'glossary_terms').find((c) => c.method === 'delete');
  const afterDelete = callsFor(fake, 'glossary_terms').slice(callsFor(fake, 'glossary_terms').indexOf(deleteCall));
  assert.deepEqual(afterDelete.map((c) => c.method), ['delete', 'eq', 'is', 'select']);
});

test('executeBackfillPlan re-verifies the loser stub live before deleting; gloss_md present aborts that merge only', async () => {
  const fake = makeFakeDb({
    glossary_terms: [
      { id: 't1', citation: 'RSMo 536.010', needs_mapping: false, gloss_md: null },
      // Simulates a concurrent write after planning: this loser is no longer a bare stub.
      { id: 't2', citation: null, needs_mapping: true, gloss_md: 'Some real gloss content already written' },
    ],
    summary_terms: [{ summary_id: 's3', term_id: 't2' }],
    glossary_verifications: [],
    glossary_notes: [],
  });
  const plan = { updates: [], merges: [{ survivorId: 't1', loserId: 't2', citation: 'RSMo 536.010', linkMoves: ['s3'] }] };
  const result = await executeBackfillPlan(fake, 'run-1', plan);
  assert.equal(result.merged, 0);
  assert.deepEqual(result.skipped, [{ id: 't2', reason: 'loser is not a bare stub at execute time — merge aborted' }]);

  // The loser row must survive, untouched, and its link must not have been moved.
  assert.deepEqual(fake.store.get('glossary_terms').map((r) => r.id).sort(), ['t1', 't2']);
  assert.deepEqual(fake.store.get('summary_terms'), [{ summary_id: 's3', term_id: 't2' }]);
});

// Ruling 1 (controller, Task 7): the live pre-delete re-verification must check glossary_notes
// too, not just gloss_md/glossary_verifications — matches the planning core's own isStub
// definition (gloss/verifications/notes). Without this check a loser that picked up a note
// between planning and execute would still be deleted.
test('executeBackfillPlan re-verifies the loser stub live before deleting; a glossary_notes row aborts that merge only', async () => {
  const fake = makeFakeDb({
    glossary_terms: [
      { id: 't1', citation: 'RSMo 536.010', needs_mapping: false, gloss_md: null },
      { id: 't2', citation: null, needs_mapping: true, gloss_md: null },
    ],
    summary_terms: [{ summary_id: 's3', term_id: 't2' }],
    glossary_verifications: [],
    glossary_notes: [{ id: 'n1', term_id: 't2' }],
  });
  const plan = { updates: [], merges: [{ survivorId: 't1', loserId: 't2', citation: 'RSMo 536.010', linkMoves: ['s3'] }] };
  const result = await executeBackfillPlan(fake, 'run-1', plan);
  assert.equal(result.merged, 0);
  assert.deepEqual(result.skipped, [{ id: 't2', reason: 'loser is not a bare stub at execute time — merge aborted' }]);
  assert.deepEqual(fake.store.get('glossary_terms').map((r) => r.id).sort(), ['t1', 't2']);
  assert.deepEqual(fake.store.get('summary_terms'), [{ summary_id: 's3', term_id: 't2' }]);
});

test('idempotency: executing the same plan twice against the same fake writes nothing the second time', async () => {
  const fake = makeFakeDb({
    glossary_terms: [
      { id: 't1', citation: null, needs_mapping: true, gloss_md: null },
      { id: 't2', citation: null, needs_mapping: true, gloss_md: null },
    ],
    summary_terms: [{ summary_id: 's3', term_id: 't2' }],
    glossary_verifications: [],
    glossary_notes: [],
  });
  const plan = {
    updates: [{ id: 't1', term: 'section 536.010', citation: 'RSMo 536.010' }],
    merges: [{ survivorId: 't1', loserId: 't2', citation: 'RSMo 536.010', linkMoves: ['s3'] }],
  };

  const first = await executeBackfillPlan(fake, 'run-1', plan);
  assert.deepEqual(first, { updated: 1, merged: 1, skipped: [] });

  const second = await executeBackfillPlan(fake, 'run-2', plan);
  assert.equal(second.updated, 0);
  assert.equal(second.merged, 0);
  // Update finds no citation-null row (already mapped); merge finds no loser row (already gone).
  assert.deepEqual(second.skipped, [
    { id: 't1', reason: 'update matched no citation-null row (already mapped?)' },
    { id: 't2', reason: 'loser row gone or already mapped' },
  ]);
});
