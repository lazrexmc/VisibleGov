// tests/bills-page.test.js — TDD for the pure bill-catalog logic that lives in
// site/js/bills-page.js (the Browse-bills page, 2026-08-18). Written BEFORE the pure model
// functions exist (fails first). site/js/bills-page.js also carries the DOM-orchestration side
// (fetch + render wiring) — not exercised here, same split as tests/directory-model.test.js vs
// site/js/directory-page.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBillEntries, filterBills, partitionBills } from '../site/js/bills-page.js';

// The REST row shape: summaries (status=published) with the bills -> sessions -> jurisdictions
// embed, exactly what bootstrapBillsPage fetches.
function summaryRow(overrides = {}) {
  return {
    bill_id: 'bill-1',
    published_at: '2026-08-18T12:00:00+00:00',
    bills: {
      id: 'bill-1',
      identifier: 'HR 1',
      title: 'A Federal Bill',
      sessions: {
        id: 'sess-us',
        identifier: '119',
        name: '119th Congress',
        jurisdiction_id: 'us-congress',
        jurisdictions: { id: 'us-congress', name: 'United States Congress' },
      },
    },
    ...overrides,
  };
}

function moRow(overrides = {}) {
  return summaryRow({
    bill_id: 'bill-mo',
    published_at: '2026-08-17T12:00:00+00:00',
    bills: {
      id: 'bill-mo',
      identifier: 'HB 100',
      title: 'A Missouri Bill',
      sessions: {
        id: 'sess-mo',
        identifier: '2025',
        name: '2025 Regular Session',
        jurisdiction_id: 'mo-legislature',
        jurisdictions: { id: 'mo-legislature', name: 'Missouri General Assembly' },
      },
    },
    ...overrides,
  });
}

// ============================================================================
// buildBillEntries — one entry per bill, newest summary first
// ============================================================================

test('buildBillEntries: one published row -> one entry with identifier, title, date, jurisdiction, session label, and bill href', () => {
  const entries = buildBillEntries([summaryRow()]);
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.billId, 'bill-1');
  assert.equal(e.identifier, 'HR 1');
  assert.equal(e.title, 'A Federal Bill');
  assert.equal(e.publishedDate, '2026-08-18');
  assert.equal(e.jurisdictionId, 'us-congress');
  assert.equal(e.sessionLabel, '119th Congress');
  assert.equal(e.href, '/bill/bill-1');
});

test('buildBillEntries: sorts newest published_at first, ties broken by identifier', () => {
  const older = summaryRow({ bill_id: 'b-old', published_at: '2026-08-01T00:00:00+00:00', bills: { ...summaryRow().bills, id: 'b-old', identifier: 'HR 9' } });
  const newer = summaryRow({ bill_id: 'b-new', published_at: '2026-08-15T00:00:00+00:00', bills: { ...summaryRow().bills, id: 'b-new', identifier: 'HR 2' } });
  const tieA = summaryRow({ bill_id: 'b-tie-a', published_at: '2026-08-10T00:00:00+00:00', bills: { ...summaryRow().bills, id: 'b-tie-a', identifier: 'HR 20' } });
  const tieB = summaryRow({ bill_id: 'b-tie-b', published_at: '2026-08-10T00:00:00+00:00', bills: { ...summaryRow().bills, id: 'b-tie-b', identifier: 'HR 10' } });
  const entries = buildBillEntries([older, tieA, newer, tieB]);
  assert.deepEqual(entries.map((e) => e.billId), ['b-new', 'b-tie-b', 'b-tie-a', 'b-old']);
});

test('buildBillEntries: two published rows for the SAME bill keep only the newest', () => {
  const first = summaryRow({ published_at: '2026-08-01T00:00:00+00:00' });
  const replacement = summaryRow({ published_at: '2026-08-15T00:00:00+00:00' });
  const entries = buildBillEntries([first, replacement]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].publishedDate, '2026-08-15');
});

test('buildBillEntries: a session label falls back to the session identifier, then to nothing', () => {
  const noName = summaryRow();
  noName.bills.sessions = { ...noName.bills.sessions, name: null };
  const noSession = summaryRow({ bill_id: 'b-nosess' });
  noSession.bills = { ...noSession.bills, id: 'b-nosess', sessions: null };
  const entries = buildBillEntries([noName, noSession]);
  const withIdentifier = entries.find((e) => e.billId === 'bill-1');
  const without = entries.find((e) => e.billId === 'b-nosess');
  assert.equal(withIdentifier.sessionLabel, '119');
  assert.equal(without.sessionLabel, '');
  assert.equal(without.jurisdictionId, null);
});

test('buildBillEntries: never throws on malformed input — null rows, missing bills embed, non-array', () => {
  assert.deepEqual(buildBillEntries(null), []);
  assert.deepEqual(buildBillEntries(undefined), []);
  const entries = buildBillEntries([null, {}, { bill_id: 'x', published_at: null, bills: null }]);
  assert.ok(Array.isArray(entries));
  // a row with no bills embed cannot render a row a reader could use — it is dropped, never a
  // half-empty entry
  assert.equal(entries.find((e) => e && e.identifier == null), undefined);
});

// ============================================================================
// partitionBills — federal / missouri / other buckets, order-preserving
// ============================================================================

test('partitionBills: splits us-congress into federal and mo-legislature into missouri, preserving order', () => {
  const entries = buildBillEntries([summaryRow(), moRow()]);
  const { federal, missouri, other } = partitionBills(entries);
  assert.deepEqual(federal.map((e) => e.billId), ['bill-1']);
  assert.deepEqual(missouri.map((e) => e.billId), ['bill-mo']);
  assert.deepEqual(other, []);
});

test('partitionBills: an unknown or missing jurisdiction lands in other, never silently in a tab', () => {
  const stray = summaryRow({ bill_id: 'b-stray' });
  stray.bills = { ...stray.bills, id: 'b-stray', sessions: { ...stray.bills.sessions, jurisdiction_id: 'tx-legislature' } };
  const noSession = summaryRow({ bill_id: 'b-nosess' });
  noSession.bills = { ...noSession.bills, id: 'b-nosess', sessions: null };
  const { federal, missouri, other } = partitionBills(buildBillEntries([stray, noSession]));
  assert.deepEqual(federal, []);
  assert.deepEqual(missouri, []);
  assert.deepEqual(other.map((e) => e.billId).sort(), ['b-nosess', 'b-stray']);
});

test('partitionBills: never throws on malformed input', () => {
  assert.deepEqual(partitionBills(null), { federal: [], missouri: [], other: [] });
  assert.deepEqual(partitionBills([null, undefined]), { federal: [], missouri: [], other: [] });
});

// ============================================================================
// filterBills — client-side text filter over the COMPLETE fetched list
// ============================================================================

test('filterBills: matches identifier and title case-insensitively; empty query returns the list unchanged', () => {
  const entries = buildBillEntries([summaryRow(), moRow()]);
  assert.equal(filterBills(entries, 'hr 1').length, 1);
  assert.equal(filterBills(entries, 'MISSOURI').length, 1);
  assert.equal(filterBills(entries, '   ').length, 2);
  assert.equal(filterBills(entries, 'zebra').length, 0);
});

test('filterBills: never throws on malformed input', () => {
  assert.deepEqual(filterBills(null, 'x'), []);
  assert.equal(filterBills([null, undefined], 'x').length, 0);
});
