import { test } from 'node:test';
import assert from 'node:assert/strict';
import { additivePatch, isMissingRelationError, isMissingColumnError } from '../src/lib/db.js';

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
