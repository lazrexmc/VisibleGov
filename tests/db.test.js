import { test } from 'node:test';
import assert from 'node:assert/strict';
import { additivePatch } from '../src/lib/db.js';

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
