import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, planGlossing, GLOSS_COST_PER_TERM_USD } from '../src/cli/gloss.js';

// ---- planGlossing: the branched routing decision (mirrors extract-terms.js's planExtraction) ----

test('planGlossing routes a needs_mapping row to needsMapping, never to candidates', () => {
  const terms = [{ id: 't1', needs_mapping: true, gloss_md: null }];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.needsMapping.map((t) => t.id), ['t1']);
  assert.equal(plan.alreadyGlossed.length, 0);
  assert.equal(plan.candidates.length, 0);
});

test('planGlossing routes an already-glossed row (gloss_md set) to alreadyGlossed', () => {
  const terms = [{ id: 't1', needs_mapping: false, gloss_md: 'Already written.' }];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.alreadyGlossed.map((t) => t.id), ['t1']);
  assert.equal(plan.needsMapping.length, 0);
  assert.equal(plan.candidates.length, 0);
});

test('planGlossing routes a resolvable, ungloosed row to candidates', () => {
  const terms = [{ id: 't1', needs_mapping: false, gloss_md: null }];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.candidates.map((t) => t.id), ['t1']);
  assert.equal(plan.needsMapping.length, 0);
  assert.equal(plan.alreadyGlossed.length, 0);
});

test('planGlossing treats a gloss_md-set row as alreadyGlossed even if needs_mapping is (inconsistently) true — glossed status wins', () => {
  const terms = [{ id: 't1', needs_mapping: true, gloss_md: 'Written anyway.' }];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.alreadyGlossed.map((t) => t.id), ['t1']);
  assert.equal(plan.needsMapping.length, 0);
});

test('planGlossing partitions a mixed batch into all three mutually exclusive buckets', () => {
  const terms = [
    { id: 'mapped-done', needs_mapping: false, gloss_md: 'Done.' },
    { id: 'needs-mapping', needs_mapping: true, gloss_md: null },
    { id: 'candidate-1', needs_mapping: false, gloss_md: null },
    { id: 'candidate-2', needs_mapping: false, gloss_md: null },
  ];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.alreadyGlossed.map((t) => t.id), ['mapped-done']);
  assert.deepEqual(plan.needsMapping.map((t) => t.id), ['needs-mapping']);
  assert.deepEqual(plan.candidates.map((t) => t.id), ['candidate-1', 'candidate-2']);
});

test('planGlossing on an empty term list returns three empty buckets', () => {
  const plan = planGlossing([]);
  assert.deepEqual(plan, { needsMapping: [], alreadyGlossed: [], candidates: [] });
});

// ---- cost estimate constant (brief: "unique terms x ~$0.16 authoring+verify") ----

test('GLOSS_COST_PER_TERM_USD matches the plan\'s own estimate', () => {
  assert.equal(GLOSS_COST_PER_TERM_USD, 0.16);
});

// ---- parseArgs: same --dry-run shape as the other CLIs ----

test('parseArgs defaults dryRun to false and accepts --dry-run', () => {
  assert.equal(parseArgs([]).dryRun, false);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});
