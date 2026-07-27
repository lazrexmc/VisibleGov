import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWork } from '../src/cli/summarize.js';

const bills = [{ id: 'b1', identifier: 'HR 1' }, { id: 'b2', identifier: 'HR 2' }, { id: 'b3', identifier: 'HR 3' }];
const texts = [{ bill_id: 'b2', content_hash: 'h2' }, { bill_id: 'b3', content_hash: 'h3-new' }];
const summaries = [{ bill_id: 'b3', bill_text_hash: 'h3-old', status: 'published' }];

test('planWork routes bills correctly', () => {
  const plan = planWork(bills, texts, summaries);
  assert.deepEqual(plan.needText.map((b) => b.id), ['b1']);
  assert.deepEqual(plan.needSummary.map((b) => b.id), ['b2', 'b3']);
  assert.deepEqual(plan.stale.map((s) => s.bill_id), ['b3']);
});

test('planWork skips bills already summarized at current hash', () => {
  const plan = planWork([bills[2]], [{ bill_id: 'b3', content_hash: 'h3-old' }], summaries);
  assert.equal(plan.needSummary.length, 0);
  assert.equal(plan.stale.length, 0);
});
