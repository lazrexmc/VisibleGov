import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGlossaryBuckets } from '../src/review/glossary-buckets.js';

// ---- final-review finding 6: computeGlossaryGroups (page.html) used four independent .filter()
// calls that could — and did — drop a row from every bucket AND every count. computeGlossaryBuckets
// is the canonical, exhaustive fix: one if/continue chain, every row lands in exactly one bucket.
// The eight scenarios below are the exact set the fix-wave ground rules named: flagged, clean-draft,
// unverified-glossed, stub, needs_mapping, approved, published, stale. ----

function item(overrides) {
  return {
    id: 'x', status: 'draft', has_gloss: true, needs_mapping: false, verified: 'unverified', ...overrides,
  };
}

test('computeGlossaryBuckets: flagged — has_gloss + verified=flagged, status draft', () => {
  const b = computeGlossaryBuckets([item({ id: 't1', verified: 'flagged' })]);
  assert.deepEqual(b.flagged.map((i) => i.id), ['t1']);
});

test('computeGlossaryBuckets: clean-draft — has_gloss + verified=clean, status draft (THE finding-6 regression: this used to vanish from every bucket)', () => {
  const b = computeGlossaryBuckets([item({ id: 't1', verified: 'clean' })]);
  assert.deepEqual(b.cleanDraft.map((i) => i.id), ['t1']);
});

test('computeGlossaryBuckets: unverified-glossed — has_gloss=true, no verification row yet (THE OTHER finding-6 regression)', () => {
  const b = computeGlossaryBuckets([item({ id: 't1', verified: 'unverified' })]);
  assert.deepEqual(b.unverifiedGlossed.map((i) => i.id), ['t1']);
});

test('computeGlossaryBuckets: stub — no gloss yet at all (has_gloss=false), citation resolved (needs_mapping=false)', () => {
  const b = computeGlossaryBuckets([item({ id: 't1', has_gloss: false, verified: 'unverified' })]);
  assert.deepEqual(b.stubs.map((i) => i.id), ['t1']);
});

test('computeGlossaryBuckets: needs_mapping — no resolved citation at all, takes priority over the stub bucket', () => {
  const b = computeGlossaryBuckets([item({ id: 't1', needs_mapping: true, has_gloss: false })]);
  assert.deepEqual(b.needsMapping.map((i) => i.id), ['t1']);
  assert.equal(b.stubs.length, 0, 'a needs_mapping row must not ALSO land in stubs');
});

test('computeGlossaryBuckets: approved — pending publish, takes priority over flagged/clean/unverified regardless of gloss state', () => {
  const b = computeGlossaryBuckets([item({ id: 't1', status: 'approved', verified: 'flagged' })]);
  assert.deepEqual(b.approved.map((i) => i.id), ['t1']);
  assert.equal(b.flagged.length, 0);
});

test('computeGlossaryBuckets: published — terminal state, takes priority over everything', () => {
  const b = computeGlossaryBuckets([item({ id: 't1', status: 'published', verified: 'flagged', needs_mapping: true })]);
  assert.deepEqual(b.published.map((i) => i.id), ['t1']);
});

test('computeGlossaryBuckets: stale — treated identically to draft; a stale+unglossed row lands in stubs, not a separate/missing bucket', () => {
  const b = computeGlossaryBuckets([item({ id: 't1', status: 'stale', has_gloss: false })]);
  assert.deepEqual(b.stubs.map((i) => i.id), ['t1']);
});

test('computeGlossaryBuckets: stale + clean-verified also lands in cleanDraft, same as a draft in the same state', () => {
  const b = computeGlossaryBuckets([item({ id: 't1', status: 'stale', verified: 'clean' })]);
  assert.deepEqual(b.cleanDraft.map((i) => i.id), ['t1']);
});

// ---- exhaustiveness: every row from a large synthetic mixed set lands in EXACTLY one bucket —
// the actual guarantee finding 6 requires, proven by construction rather than by enumerating every
// possible combination by hand. ----

test('computeGlossaryBuckets: exhaustive over a synthetic mixed set covering all 8 named states — every row appears exactly once, none vanish, none duplicate', () => {
  const items = [
    item({ id: 'flagged-1', verified: 'flagged' }),
    item({ id: 'clean-1', verified: 'clean' }),
    item({ id: 'unverified-1', verified: 'unverified' }),
    item({ id: 'stub-1', has_gloss: false }),
    item({ id: 'mapping-1', needs_mapping: true, has_gloss: false }),
    item({ id: 'approved-1', status: 'approved' }),
    item({ id: 'published-1', status: 'published' }),
    item({ id: 'stale-1', status: 'stale', has_gloss: false }),
    // a few more, deliberately overlapping edge combinations, still each with exactly one true home
    item({
      id: 'mapping-approved', status: 'approved', needs_mapping: true, has_gloss: false,
    }),
    item({
      id: 'flagged-stale', status: 'stale', verified: 'flagged',
    }),
  ];
  const buckets = computeGlossaryBuckets(items);
  const allBucketed = [
    ...buckets.published, ...buckets.approved, ...buckets.needsMapping,
    ...buckets.stubs, ...buckets.flagged, ...buckets.cleanDraft, ...buckets.unverifiedGlossed,
  ];
  assert.equal(allBucketed.length, items.length, 'every input row must appear in the union of all buckets exactly once — none vanish');
  const idsSeen = allBucketed.map((i) => i.id);
  assert.equal(new Set(idsSeen).size, idsSeen.length, 'no row may appear in more than one bucket');
  assert.deepEqual(idsSeen.sort(), items.map((i) => i.id).sort());
});

test('computeGlossaryBuckets: an empty item list returns seven empty buckets', () => {
  const b = computeGlossaryBuckets([]);
  assert.deepEqual(b, {
    published: [], approved: [], needsMapping: [], stubs: [], flagged: [], cleanDraft: [], unverifiedGlossed: [],
  });
});
