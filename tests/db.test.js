import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  additivePatch, isMissingRelationError, isMissingColumnError, selectAll,
} from '../src/lib/db.js';

test('additivePatch never overwrites a set field, even when values differ', () => {
  const patch = additivePatch({ title: 'Original', status: null }, { title: 'Different', status: 'passed' });
  assert.deepEqual(patch, { status: 'passed' });
});

test('additivePatch ignores null/undefined incoming values', () => {
  const patch = additivePatch({ title: null }, { title: null, status: undefined });
  assert.deepEqual(patch, {});
});

test('additivePatch fills only null/undefined existing fields', () => {
  const patch = additivePatch({ a: undefined, b: 'kept', c: null }, { a: 1, b: 2, c: 3 });
  assert.deepEqual(patch, { a: 1, c: 3 });
});

// ---- isMissingRelationError (Task 10: shared between the verify CLI's dry-run tolerance and
// the review server's graceful degradation when a migration hasn't been applied yet) ----

test('isMissingRelationError recognizes a raw Postgres undefined_table error (42P01)', () => {
  const err = { code: '42P01', message: 'relation "public.summary_verifications" does not exist' };
  assert.equal(isMissingRelationError(err, 'summary_verifications'), true);
});

test('isMissingRelationError recognizes PostgREST\'s "not in schema cache" shape (PGRST205)', () => {
  const err = { code: 'PGRST205', message: "Could not find the table 'public.summary_verifications' in the schema cache" };
  assert.equal(isMissingRelationError(err, 'summary_verifications'), true);
});

test('isMissingRelationError does not false-positive on an unrelated error', () => {
  const err = { code: 'ECONNRESET', message: 'network error' };
  assert.equal(isMissingRelationError(err, 'summary_verifications'), false);
});

test('isMissingRelationError does not false-positive on a different missing table', () => {
  const err = { code: '42P01', message: 'relation "public.some_other_table" does not exist' };
  assert.equal(isMissingRelationError(err, 'summary_verifications'), false);
});

test('isMissingRelationError is false for a null/absent error', () => {
  assert.equal(isMissingRelationError(null, 'summary_verifications'), false);
});

// ---- isMissingColumnError (Task 4: mo-house-xml member persistence gates on migration 0005 —
// legislators.mo_house_id — via this same skip≠empty tolerance pattern) ----

test('isMissingColumnError recognizes PostgREST\'s "column not found in schema cache" shape (PGRST204)', () => {
  const err = { code: 'PGRST204', message: "Could not find the 'mo_house_id' column of 'legislators' in the schema cache" };
  assert.equal(isMissingColumnError(err, 'mo_house_id'), true);
});

test('isMissingColumnError recognizes a raw Postgres undefined_column error (42703)', () => {
  const err = { code: '42703', message: 'column "mo_house_id" of relation "legislators" does not exist' };
  assert.equal(isMissingColumnError(err, 'mo_house_id'), true);
});

test('isMissingColumnError matches on message text alone when .code was stripped (insertIfAbsent wraps errors into a plain Error, discarding .code)', () => {
  const err = new Error("insertIfAbsent(legislators) failed: Could not find the 'mo_house_id' column of 'legislators' in the schema cache");
  assert.equal(isMissingColumnError(err, 'mo_house_id'), true);
});

test('isMissingColumnError does not false-positive on an unrelated error', () => {
  const err = { code: 'ECONNRESET', message: 'network error' };
  assert.equal(isMissingColumnError(err, 'mo_house_id'), false);
});

test('isMissingColumnError does not false-positive on a different missing column', () => {
  const err = { code: '42703', message: 'column "openstates_id" of relation "legislators" does not exist' };
  assert.equal(isMissingColumnError(err, 'mo_house_id'), false);
});

test('isMissingColumnError is false for a null/absent error', () => {
  assert.equal(isMissingColumnError(null, 'mo_house_id'), false);
});

// ---- selectAll (final-review finding 1: unbounded .select() calls silently truncate at
// Supabase/PostgREST's 1000-row-per-request server-side cap — live-verified on this instance, per
// ingest-mo-house.js's dryRunReport comment). The fake client below is deliberately built to
// ENFORCE that same cap (never return more than `serverCap` rows for a single .range() call,
// regardless of how wide a range was asked for) — the prior fakes across this suite returned
// however many rows they were seeded with in one shot, which is exactly why the original bug
// shipped with a fully green suite. A fake that can't reproduce the cap can't prove the fix. ----

function makeCappedTableClient(allRows, { serverCap = 1000, orderKey = 'id' } = {}) {
  const rangeCalls = [];
  // Fixed insertion-order-independent sort, mirroring Postgres's own guarantee: a query IS
  // deterministic once an ORDER BY is present. selectAll always appends `.order('id', ...)` — this
  // fake's `.order()` is a no-op that trusts THAT append happened and always serves rows sorted by
  // `orderKey`, the same contract a real ordered table would honor across separate .range() calls.
  const sorted = [...allRows].sort((a, b) => {
    if (a[orderKey] < b[orderKey]) return -1;
    if (a[orderKey] > b[orderKey]) return 1;
    return 0;
  });
  return {
    rangeCalls,
    from(table) {
      const filters = [];
      const builder = {
        select() { return this; },
        eq(col, val) { filters.push(['eq', col, val]); return this; },
        in(col, vals) { filters.push(['in', col, vals]); return this; },
        order() { return this; },
        range(from, to) {
          rangeCalls.push({ table, from, to });
          let rows = sorted;
          for (const [kind, col, val] of filters) {
            rows = kind === 'eq' ? rows.filter((r) => r[col] === val) : rows.filter((r) => val.includes(r[col]));
          }
          const requestedSize = to - from + 1;
          const cappedSize = Math.min(requestedSize, serverCap);
          return Promise.resolve({ data: rows.slice(from, from + cappedSize), error: null });
        },
      };
      return builder;
    },
  };
}

test('makeCappedTableClient sanity: a single wide .range() request is truncated at the server cap — proves the fake actually reproduces the live bug', async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ id: String(i).padStart(5, '0') }));
  const client = makeCappedTableClient(rows);
  const { data } = await client.from('t').select('id').range(0, 999999);
  assert.equal(data.length, 1000, 'a naive unbounded/wide-range select must come back capped at 1000, exactly like live Supabase');
});

test('selectAll: pages past 1000 rows to retrieve the FULL table, never truncating at the server cap (the actual finding-1 regression)', async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ id: String(i).padStart(5, '0'), n: i }));
  const client = makeCappedTableClient(rows);
  const { data, error } = await selectAll(client, 'glossary_verifications', 'id,n');
  assert.equal(error, null);
  assert.equal(data.length, 2500, 'every row must come back — this is exactly the count a truncated, silently-wrong result would under-report');
  assert.deepEqual(data.map((r) => r.n).sort((a, b) => a - b), rows.map((r) => r.n));
  assert.equal(client.rangeCalls.length, 3, 'default pageSize=1000 over 2500 rows must take exactly 3 pages (1000+1000+500)');
});

test('selectAll: the NEWEST rows (highest id) are present — the exact failure mode finding 1 named ("created_at-ASC queue select drops the NEWEST terms")', async () => {
  const rows = Array.from({ length: 1500 }, (_, i) => ({ id: String(i).padStart(5, '0') }));
  const client = makeCappedTableClient(rows);
  const { data } = await selectAll(client, 't', 'id');
  assert.ok(data.some((r) => r.id === '01499'), 'the last-inserted row must not be silently dropped past the first 1000-row page');
});

test('selectAll: an empty table returns an empty array after exactly one page, never loops needlessly', async () => {
  const client = makeCappedTableClient([]);
  const { data, error } = await selectAll(client, 't', 'id');
  assert.equal(error, null);
  assert.deepEqual(data, []);
  assert.equal(client.rangeCalls.length, 1);
});

test('selectAll: a `filter` callback\'s .eq()/.in() predicate is applied on every page, not just the first', async () => {
  const rows = Array.from({ length: 1500 }, (_, i) => ({ id: String(i).padStart(5, '0'), status: i % 2 === 0 ? 'draft' : 'published' }));
  const client = makeCappedTableClient(rows);
  const { data } = await selectAll(client, 't', 'id,status', { filter: (q) => q.eq('status', 'draft') });
  assert.equal(data.length, 750);
  assert.ok(data.every((r) => r.status === 'draft'));
});

test('selectAll: a smaller pageSize still retrieves everything via more pages (pagination math is pageSize-agnostic)', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: String(i).padStart(3, '0') }));
  const client = makeCappedTableClient(rows, { serverCap: 10 });
  const { data } = await selectAll(client, 't', 'id', { pageSize: 10 });
  assert.equal(data.length, 25);
  assert.equal(client.rangeCalls.length, 3, '10+10+5');
});

test('selectAll: propagates an error from whichever page produced it, without throwing', async () => {
  let calls = 0;
  const client = {
    from: () => ({
      select() { return this; },
      order() { return this; },
      range: () => {
        calls += 1;
        if (calls === 2) return Promise.resolve({ data: null, error: { message: 'connection reset' } });
        return Promise.resolve({ data: Array.from({ length: 1000 }, (_, i) => ({ id: i })), error: null });
      },
    }),
  };
  const { data, error } = await selectAll(client, 't', 'id');
  assert.equal(data, null);
  assert.equal(error.message, 'connection reset');
});

test('selectAll: assert-loud — a final page that is STILL full-sized at maxPages throws rather than returning a possibly-truncated result', async () => {
  // Every page comes back full (serverCap === pageSize === total available "appears" unbounded to
  // the caller) — selectAll can never tell this apart from a table that keeps going past maxPages,
  // so per finding 1's fix direction it must fail loud rather than silently hand back a result that
  // LOOKS complete.
  const client = {
    from: () => ({
      select() { return this; },
      order() { return this; },
      range: () => Promise.resolve({ data: Array.from({ length: 5 }, (_, i) => ({ id: i })), error: null }),
    }),
  };
  await assert.rejects(
    () => selectAll(client, 'huge_table', 'id', { pageSize: 5, maxPages: 3 }),
    /selectAll\(huge_table\).*maxPages/,
  );
});
