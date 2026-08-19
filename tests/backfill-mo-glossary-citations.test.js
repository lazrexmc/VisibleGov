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
    terms: [T('t1', 'section 303.190'), T('t2', 'section 33.080'), T('t3', '302.309')],
    linksByTermId: new Map([['t1', ['s1', 's2']], ['t2', ['s2']]]),
    jurisdictionBySummaryId: new Map([['s1', MO], ['s2', FED]]),
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.skips.guardBlocked, 2);
  assert.equal(plan.skips.zeroLinks, 1);
});

// F1 (post-audit fix wave, 2026-08-19): chapters left v1, so planMoCitationBackfill needs no code
// change of its own — it purely delegates to parseMoCitation, and a chapter term now parse-fails.
// This pins that it lands in skips.parseFailed (staying needs_mapping, honestly) rather than in
// updates, and that the parse failure is counted BEFORE the jurisdiction guard ever runs.
test('chapters land in skips.parseFailed, never in updates (F1)', () => {
  const plan = planMoCitationBackfill({
    terms: [T('t1', 'chapter 536'), T('t2', 'chapter 303, RSMo'), T('t3', 'RSMo chapter 536')],
    linksByTermId: new Map([['t1', ['s1']], ['t2', ['s1']], ['t3', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.skips.parseFailed, 3);
  assert.equal(plan.skips.guardBlocked, 0);
});

// F2 (post-audit fix wave): the low-chapter corroboration guard reaches the backfill through the
// same delegation — a BARE 'section 2.100' (ambiguous with a MO appropriations bill's own internal
// section numbering) parse-fails, while the RSMo-corroborated form still maps.
test('a bare low-chapter dotted cite parse-fails in the backfill; the RSMo-corroborated form maps (F2)', () => {
  const plan = planMoCitationBackfill({
    terms: [T('t1', 'section 2.100'), T('t2', 'section 1.140, RSMo')],
    linksByTermId: new Map([['t1', ['s1']], ['t2', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.equal(plan.skips.parseFailed, 1);
  assert.deepEqual(plan.updates, [{ id: 't2', term: 'section 1.140, RSMo', citation: 'RSMo 1.140' }]);
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
//
// Live-dry-run fix (Task 8 finding): this fake records every .order(col) call per table so the
// test below can prove fetchBackfillInputs' summary_terms read passes its real composite key
// (summary_id, term_id) through to selectAll's orderBy — a fake this permissive can't by itself
// catch a call to .order('id') against a table with no id column (it doesn't validate against
// real schema at all), which is exactly why this bug only surfaced against the live database in
// Task 8's dry-run; asserting the actual order-call arguments here is the closest a fake-only test
// can get to that same guarantee.

function fakeSelectAllClient(rowsByTable) {
  const orderCallsByTable = {};
  return {
    orderCallsByTable,
    from(table) {
      return {
        select() { return this; },
        order(col) { (orderCallsByTable[table] ??= []).push(col); return this; },
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

  // Live-dry-run fix (Task 8 finding): summary_terms has NO id column (composite PK
  // (summary_id, term_id), migration 0007) — its read must pass its real key through as orderBy,
  // never fall through to selectAll's id default, or pagination against the live table throws.
  // Every other table read here does keep the id default (each genuinely has a uuid id PK).
  assert.deepEqual(client.orderCallsByTable.summary_terms, ['summary_id', 'term_id']);
  assert.deepEqual(client.orderCallsByTable.glossary_terms, ['id']);
  assert.deepEqual(client.orderCallsByTable.summaries, ['id']);
  assert.deepEqual(client.orderCallsByTable.bills, ['id']);
  assert.deepEqual(client.orderCallsByTable.sessions, ['id']);
  assert.deepEqual(client.orderCallsByTable.glossary_verifications, ['id']);
  assert.deepEqual(client.orderCallsByTable.glossary_notes, ['id']);
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
  return filters.every(([col, val, op]) => (op === 'in' ? val.includes(row[col]) : row[col] === val));
}

// ---- real constraint enforcement (F5, post-audit fix wave) ----
//
// The fake previously accepted any write, so it could not catch the two races the audit found: a
// SECOND row claiming the same (kind, citation) mid-apply, and a summary_terms link minted onto a
// merge loser mid-merge. Both are enforced by real constraints in the live schema (migration 0007:
// `unique (kind, citation)` on glossary_terms, and summary_terms.term_id -> glossary_terms.id), so
// the fake now enforces them too.
//
// SHAPE MATTERS: supabase-js does NOT throw on a constraint violation — PostgREST returns it, and
// the client hands back {data: null, error: {code, message}}. Every write path in the CLI reads
// `error` off that object, so the fake returns the same shape rather than throwing, or the tests
// would prove the wrong contract.
const uniqueViolation = (constraint) => ({
  data: null,
  error: { code: '23505', message: `duplicate key value violates unique constraint "${constraint}"` },
});
const fkViolation = (constraint) => ({
  data: null,
  error: {
    code: '23503',
    message: `update or delete on table "glossary_terms" violates foreign key constraint "${constraint}" on table "summary_terms"`,
  },
});

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
      if (!store.has(table)) store.set(table, []);
      const rows = store.get(table);
      const terms = store.get('glossary_terms');
      const links = store.get('summary_terms');
      if (op === 'upsert') {
        // FK: summary_terms.term_id -> glossary_terms.id.
        if (table === 'summary_terms' && terms
          && upsertRows.some((r) => !terms.some((t) => t.id === r.term_id))) {
          return fkViolation('summary_terms_term_id_fkey');
        }
        const keyCols = String(upsertOnConflict).split(',').map((c) => c.trim());
        for (const incoming of upsertRows) {
          const exists = rows.some((r) => keyCols.every((c) => r[c] === incoming[c]));
          if (!exists) rows.push({ ...incoming });
        }
        return { data: null, error: null };
      }
      const matched = rows.filter((r) => rowMatches(r, filters));
      if (op === 'delete') {
        // FK: a glossary_terms row still referenced by summary_terms cannot be deleted.
        if (table === 'glossary_terms' && links
          && matched.some((r) => links.some((l) => l.term_id === r.id))) {
          return fkViolation('summary_terms_term_id_fkey');
        }
        const remaining = rows.filter((r) => !matched.includes(r));
        store.set(table, remaining);
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      if (op === 'update') {
        // unique (kind, citation) on glossary_terms — checked against the POST-patch value, and
        // only for a non-null citation (Postgres lets any number of NULLs coexist).
        if (table === 'glossary_terms') {
          for (const r of matched) {
            const next = { ...r, ...patch };
            if (next.citation != null
              && rows.some((o) => o !== r && o.citation === next.citation && o.kind === next.kind)) {
              return uniqueViolation('glossary_terms_kind_citation_key');
            }
          }
        }
        for (const r of matched) Object.assign(r, patch);
        return { data: matched.map((r) => projectCols(r, selectCols ?? 'id')), error: null };
      }
      return { data: matched.map((r) => projectCols(r, selectCols)), error: null }; // plain select
    }

    const builder = {
      select(cols) { calls.push({ table, method: 'select', args: [cols] }); selectCols = cols; return builder; },
      eq(col, val) { calls.push({ table, method: 'eq', args: [col, val] }); filters.push([col, val, 'eq']); return builder; },
      is(col, val) { calls.push({ table, method: 'is', args: [col, val] }); filters.push([col, val, 'is']); return builder; },
      in(col, vals) { calls.push({ table, method: 'in', args: [col, vals] }); filters.push([col, vals, 'in']); return builder; },
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
  // F5: every write path in this codebase stamps its run — glossary_terms has the run_id column.
  assert.equal(row.run_id, 'run-1');

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

// ---- F5 (post-audit fix wave): merge/update concurrency + honest partial reporting ----
//
// (a) A link minted onto the LOSER after planning is absent from m.linkMoves. Repointing only the
// planned set and then deleting the loser's links wholesale would DESTROY it — a summary silently
// losing a glossary reference. Execute time therefore RE-READS the loser's live links and repoints
// those; m.linkMoves stays in the dry-run output because that is what a human reviews.
test('a summary_terms link minted onto the loser AFTER planning is REPOINTED to the survivor, never destroyed (F5)', async () => {
  const fake = makeFakeDb({
    glossary_terms: [
      { id: 't1', kind: 'statute', citation: 'RSMo 536.010', needs_mapping: false, gloss_md: null },
      { id: 't2', kind: 'statute', citation: null, needs_mapping: true, gloss_md: null },
    ],
    // s9 was minted after this plan was built — it is deliberately NOT in linkMoves below.
    summary_terms: [{ summary_id: 's3', term_id: 't2' }, { summary_id: 's9', term_id: 't2' }],
    glossary_verifications: [],
    glossary_notes: [],
  });
  const plan = { updates: [], merges: [{ survivorId: 't1', loserId: 't2', citation: 'RSMo 536.010', linkMoves: ['s3'] }] };
  const result = await executeBackfillPlan(fake, 'run-1', plan);
  assert.deepEqual(result, { updated: 0, merged: 1, skipped: [] });

  const links = fake.store.get('summary_terms').map((l) => `${l.summary_id}->${l.term_id}`).sort();
  assert.deepEqual(links, ['s3->t1', 's9->t1'], 'both links, planned and unplanned, end up on the survivor');
  assert.deepEqual(fake.store.get('glossary_terms').map((r) => r.id), ['t1']);

  // The link delete must be SCOPED to the repointed set, never a bare .eq('term_id', loser).
  const linkDelete = callsFor(fake, 'summary_terms').findIndex((c) => c.method === 'delete');
  const afterDelete = callsFor(fake, 'summary_terms').slice(linkDelete);
  assert.deepEqual(afterDelete.map((c) => c.method), ['delete', 'eq', 'in']);
  assert.deepEqual(afterDelete[2].args, ['summary_id', ['s3', 's9']]);
});

// (b) The narrowest window: a link minted BETWEEN the live re-read and the loser delete is outside
// the scoped .in() delete, so it survives — and the loser row it references can no longer be
// deleted. The FK violation must be an honest skip that CONTINUES the run, never an abort and
// never a "fix" that destroys the new link.
test('a link minted between the live re-read and the loser delete: FK violation becomes an honest skip, loser survives, no data lost (F5)', async () => {
  const fake = makeFakeDb({
    glossary_terms: [
      { id: 't1', kind: 'statute', citation: 'RSMo 536.010', needs_mapping: false, gloss_md: null },
      { id: 't2', kind: 'statute', citation: null, needs_mapping: true, gloss_md: null },
    ],
    summary_terms: [{ summary_id: 's3', term_id: 't2' }],
    glossary_verifications: [],
    glossary_notes: [],
  }, {
    onBeforeExecute: ({ table, op, store: s }) => {
      if (table !== 'glossary_terms' || op !== 'delete') return;
      const links = s.get('summary_terms');
      if (!links.some((l) => l.summary_id === 's9' && l.term_id === 't2')) {
        links.push({ summary_id: 's9', term_id: 't2' }); // a second process linked the loser
      }
    },
  });
  const plan = { updates: [], merges: [{ survivorId: 't1', loserId: 't2', citation: 'RSMo 536.010', linkMoves: ['s3'] }] };
  const result = await executeBackfillPlan(fake, 'run-1', plan);

  assert.equal(result.merged, 0);
  assert.deepEqual(result.skipped, [{
    id: 't2',
    reason: 'loser gained a new link mid-merge — links repointed, loser row kept; next plan/apply completes it',
  }]);
  assert.ok(fake.store.get('glossary_terms').some((r) => r.id === 't2'), 'loser row must survive');
  const links = fake.store.get('summary_terms').map((l) => `${l.summary_id}->${l.term_id}`).sort();
  assert.deepEqual(links, ['s3->t1', 's9->t2'], 'the repointed link and the newly-minted link both survive');
});

// (c) The other race: a DIFFERENT row claims this (kind, citation) between planning and the write.
// .is('citation', null) cannot see that — it guards the target row only. The unique violation is an
// honest skip, and the run keeps going: later updates AND merges still execute.
test('an update losing the (kind, citation) race is an honest skip; later updates and merges still execute (F5)', async () => {
  const fake = makeFakeDb({
    glossary_terms: [
      { id: 'x0', kind: 'statute', citation: 'RSMo 536.010', needs_mapping: false, gloss_md: null },
      { id: 't1', kind: 'statute', citation: null, needs_mapping: true, gloss_md: null },
      { id: 't2', kind: 'statute', citation: null, needs_mapping: true, gloss_md: null },
      { id: 't3', kind: 'statute', citation: null, needs_mapping: true, gloss_md: null },
    ],
    summary_terms: [{ summary_id: 's3', term_id: 't3' }],
    glossary_verifications: [],
    glossary_notes: [],
  });
  const plan = {
    updates: [
      { id: 't1', term: 'section 536.010', citation: 'RSMo 536.010' }, // x0 already holds this
      { id: 't2', term: 'section 302.309', citation: 'RSMo 302.309' }, // must still run
    ],
    merges: [{ survivorId: 't2', loserId: 't3', citation: 'RSMo 302.309', linkMoves: ['s3'] }],
  };
  const result = await executeBackfillPlan(fake, 'run-1', plan);

  assert.equal(result.updated, 1, 'the second update still ran after the first one lost the race');
  assert.equal(result.merged, 1, 'merges still ran too');
  assert.deepEqual(result.skipped, [{
    id: 't1',
    reason: 'another row claimed (kind, citation) mid-apply — next plan will merge this row into it',
  }]);
  const t1 = fake.store.get('glossary_terms').find((r) => r.id === 't1');
  assert.equal(t1.citation, null, 'the losing row is left untouched for the next plan to merge');
  assert.equal(t1.needs_mapping, true);
  assert.deepEqual(fake.store.get('summary_terms'), [{ summary_id: 's3', term_id: 't2' }]);
});

// (d) An unexpected (non-race) failure must never LOSE the counts already earned.
test('an unexpected throw carries err.partialResult with the counts committed so far (F5)', async () => {
  const boom = new Error('connection reset mid-apply');
  const fake = makeFakeDb({
    glossary_terms: [
      { id: 't1', kind: 'statute', citation: null, needs_mapping: true, gloss_md: null },
      { id: 't2', kind: 'statute', citation: null, needs_mapping: true, gloss_md: null },
    ],
    summary_terms: [{ summary_id: 's3', term_id: 't2' }],
    glossary_verifications: [],
    glossary_notes: [],
  }, {
    onBeforeExecute: ({ table, op }) => { if (table === 'summary_terms' && op === 'delete') throw boom; },
  });
  const plan = {
    updates: [{ id: 't1', term: 'section 536.010', citation: 'RSMo 536.010' }],
    merges: [{ survivorId: 't1', loserId: 't2', citation: 'RSMo 536.010', linkMoves: ['s3'] }],
  };
  await assert.rejects(() => executeBackfillPlan(fake, 'run-1', plan), (err) => {
    assert.equal(err, boom, 'the original error propagates unchanged');
    assert.deepEqual(err.partialResult, { updated: 1, merged: 0, skipped: [] });
    return true;
  });
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
