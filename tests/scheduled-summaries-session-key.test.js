import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSessionStartByBillReal, sortQueueRecencyFirst } from '../scripts/scheduled-summaries.js';

// Fake of the selectAll chain (from(table).select().order().range()) the loader reads through.
function makeClient({ sessions, bills }) {
  const tables = { sessions, bills };
  return {
    from(table) {
      const rows = tables[table];
      return {
        select() {
          const q = {
            order() { return q; },
            range(from, to) { return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); },
          };
          return q;
        },
      };
    },
  };
}

test('loadSessionStartByBillReal: real dates win, undated sessions fall back to their name/identifier year, unordered bills are counted (2026-08-21 review finding: the scheduler sorted on NULL dates)', async () => {
  const client = makeClient({
    sessions: [
      { id: 's2022', identifier: '2022', name: '2022 Regular Session', start_date: '2022-01-05' },
      { id: 's2025', identifier: '2025', name: '2025 Regular Session', start_date: null },
      { id: 's261', identifier: '261', name: '2026 2nd Regular, 103rd General Assembly', start_date: null },
      { id: 'sx', identifier: 'x', name: 'Session', start_date: null }, // no date, no year
    ],
    bills: [
      { id: 'b1', session_id: 's2022' }, { id: 'b2', session_id: 's2025' }, { id: 'b3', session_id: 's261' }, { id: 'b4', session_id: 'sx' }, { id: 'b5', session_id: 'missing' },
    ],
  });
  const byBill = await loadSessionStartByBillReal(client);
  assert.equal(byBill.get('b1'), '2022-01-05');
  assert.equal(byBill.get('b2'), '2025-00-00');
  assert.equal(byBill.get('b3'), '2026-00-00');
  assert.equal(byBill.has('b4'), false);
  assert.equal(byBill.has('b5'), false);
  assert.equal(byBill.unordered, 2);
  assert.equal(byBill.fallback, 2);
  assert.deepEqual(Object.keys(byBill), [], 'the counters are non-enumerable: the Map contract is unchanged');

  // and the existing sort now orders newest session first even while the dates are NULL
  const queue = [
    { bill_id: 'b1', priority: 'passage', text_length: 10 },
    { bill_id: 'b2', priority: 'passage', text_length: 10 },
    { bill_id: 'b3', priority: 'passage', text_length: 10 },
    { bill_id: 'b4', priority: 'passage', text_length: 10 },
  ];
  assert.deepEqual(sortQueueRecencyFirst(queue, byBill).map((q) => q.bill_id), ['b3', 'b2', 'b1', 'b4']);
});
