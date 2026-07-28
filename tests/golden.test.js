import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, compareSummaries, parseStatedPurpose, buildGoldenJson, goldenFilename,
} from '../src/cli/golden.js';
import { renderMarkdown } from '../src/lib/summarizer.js';

// ---- parseArgs ----

test('parseArgs recognizes --snapshot', () => {
  assert.equal(parseArgs(['--snapshot']).mode, 'snapshot');
});

test('parseArgs recognizes --check', () => {
  assert.equal(parseArgs(['--check']).mode, 'check');
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

test('parseArgs rejects when neither --snapshot nor --check is given', () => {
  assert.throws(() => parseArgs([]), /--snapshot|--check/);
});

test('parseArgs rejects when both --snapshot and --check are given', () => {
  assert.throws(() => parseArgs(['--snapshot', '--check']), /only one/);
});

// ---- compareSummaries: pure structural comparison ----

const baseGolden = {
  what_it_does: [
    { point: 'Prohibits X payments', section: 'Sec. 2' },
    { point: 'Establishes a new grant program', section: 'Sec. 3(a)' },
    { point: 'Amends definitions used elsewhere', section: 'Sec. 4(b)' },
  ],
  stated_purpose: 'To prohibit X and establish Y.',
  classification: 'amends_existing_law',
};

test('compareSummaries: identical golden and fresh → no drift flags', () => {
  const fresh = JSON.parse(JSON.stringify(baseGolden));
  const result = compareSummaries(baseGolden, fresh);
  assert.deepEqual(result, {
    classificationChanged: false,
    purposeChanged: false,
    bulletCountDelta: 0,
    missingSections: [],
    drift: false,
  });
});

test('compareSummaries: changed classification is flagged as drift', () => {
  const fresh = { ...baseGolden, classification: 'new_program' };
  const result = compareSummaries(baseGolden, fresh);
  assert.equal(result.classificationChanged, true);
  assert.equal(result.drift, true);
});

test('compareSummaries: null golden classification is "not comparable" — never flags drift from classification, regardless of fresh', () => {
  const golden = { ...baseGolden, classification: null };
  const freshSame = { ...baseGolden, classification: null };
  const freshDifferent = { ...baseGolden, classification: 'appropriation' };
  assert.equal(compareSummaries(golden, freshSame).classificationChanged, false);
  assert.equal(compareSummaries(golden, freshDifferent).classificationChanged, false);
  assert.equal(compareSummaries(golden, freshDifferent).drift, false);
});

test('compareSummaries: stated_purpose change beyond whitespace is flagged as drift', () => {
  const fresh = { ...baseGolden, stated_purpose: 'To do something completely different.' };
  const result = compareSummaries(baseGolden, fresh);
  assert.equal(result.purposeChanged, true);
  assert.equal(result.drift, true);
});

test('compareSummaries: stated_purpose whitespace-only differences are NOT drift', () => {
  const fresh = { ...baseGolden, stated_purpose: '  To prohibit X and establish   Y.  ' };
  const result = compareSummaries(baseGolden, fresh);
  assert.equal(result.purposeChanged, false);
  assert.equal(result.drift, false);
});

test('compareSummaries: dropped sections beyond the 30% threshold are flagged as drift, with the missing list', () => {
  // golden has 3 sections; fresh drops 2 of them (67% missing > 30%)
  const fresh = {
    ...baseGolden,
    what_it_does: [{ point: 'Amends definitions used elsewhere', section: 'Sec. 4(b)' }],
  };
  const result = compareSummaries(baseGolden, fresh);
  assert.equal(result.drift, true);
  assert.deepEqual(result.missingSections.sort(), ['Sec. 2 (x1)', 'Sec. 3(a) (x1)']);
});

test('compareSummaries: count-aware — a section collapsed from many golden citations to few is a shortfall even though it still "appears" (mirrors HR 498: 9 of 11 bullets cite the same section)', () => {
  // golden: 9x 'Sec. 2(b)' + 1x 'Sec. 1' + 1x 'Sec. 3' = 11 total citations.
  const golden = {
    ...baseGolden,
    what_it_does: [
      ...Array.from({ length: 9 }, (_, i) => ({ point: `Point ${i}`, section: 'Sec. 2(b)' })),
      { point: 'Point A', section: 'Sec. 1' },
      { point: 'Point B', section: 'Sec. 3' },
    ],
  };
  // fresh: collapses the 9 'Sec. 2(b)' bullets down to 1 — plain Set membership would call this
  // "present" (missingSections: []), but 8 of those 9 citations have no counterpart in fresh.
  const fresh = {
    ...baseGolden,
    what_it_does: [
      { point: 'Combined point', section: 'Sec. 2(b)' },
      { point: 'Point A', section: 'Sec. 1' },
      { point: 'Point B', section: 'Sec. 3' },
    ],
  };
  const result = compareSummaries(golden, fresh);
  // shortfall = 9 - 1 = 8; ratio = 8/11 ≈ 0.727 > 0.3
  assert.deepEqual(result.missingSections, ['Sec. 2(b) (x8)']);
  assert.equal(result.drift, true);
});

test('compareSummaries: count-aware — duplicate-section citation counts preserved (even if bullet order differs) is NOT drift', () => {
  // mirrors HR 1366's shape: 5x 'Sec. 2(a)' + 3x 'Sec. 2(b)' + 1x 'Sec. 3' = 9 total citations.
  const golden = {
    ...baseGolden,
    what_it_does: [
      ...Array.from({ length: 5 }, (_, i) => ({ point: `A${i}`, section: 'Sec. 2(a)' })),
      ...Array.from({ length: 3 }, (_, i) => ({ point: `B${i}`, section: 'Sec. 2(b)' })),
      { point: 'C', section: 'Sec. 3' },
    ],
  };
  const fresh = {
    ...baseGolden,
    what_it_does: [
      { point: 'C-reordered', section: 'Sec. 3' },
      ...Array.from({ length: 3 }, (_, i) => ({ point: `B${i}-reworded`, section: 'Sec. 2(b)' })),
      ...Array.from({ length: 5 }, (_, i) => ({ point: `A${i}-reworded`, section: 'Sec. 2(a)' })),
    ],
  };
  const result = compareSummaries(golden, fresh);
  assert.deepEqual(result.missingSections, []);
  assert.equal(result.drift, false);
});

test('compareSummaries: missing sections at or below the 30% threshold are NOT drift', () => {
  // golden has 10 sections; fresh drops exactly 3 (30%, not > 30%)
  const goldenSections = Array.from({ length: 10 }, (_, i) => ({ point: `Point ${i}`, section: `Sec. ${i}` }));
  const golden = { ...baseGolden, what_it_does: goldenSections };
  const fresh = { ...baseGolden, what_it_does: goldenSections.slice(3) }; // drops Sec. 0,1,2
  const result = compareSummaries(golden, fresh);
  assert.equal(result.missingSections.length, 3);
  assert.equal(result.drift, false);
});

test('compareSummaries: missing sections just above the 30% threshold ARE drift', () => {
  const goldenSections = Array.from({ length: 10 }, (_, i) => ({ point: `Point ${i}`, section: `Sec. ${i}` }));
  const golden = { ...baseGolden, what_it_does: goldenSections };
  const fresh = { ...baseGolden, what_it_does: goldenSections.slice(4) }; // drops 4 of 10 = 40%
  const result = compareSummaries(golden, fresh);
  assert.equal(result.missingSections.length, 4);
  assert.equal(result.drift, true);
});

test('compareSummaries: bulletCountDelta is fresh count minus golden count', () => {
  const fresh = { ...baseGolden, what_it_does: [...baseGolden.what_it_does, { point: 'New point', section: 'Sec. 5' }] };
  const result = compareSummaries(baseGolden, fresh);
  assert.equal(result.bulletCountDelta, 1);
});

// ---- parseStatedPurpose: inverse of renderMarkdown's stated-purpose line ----

test('parseStatedPurpose extracts the purpose text after the marker', () => {
  const md = renderMarkdown({
    what_it_does: [{ point: 'Does a thing', section: 'Sec. 1' }],
    stated_purpose: 'To do the thing properly.',
    classification: 'other',
  });
  assert.equal(parseStatedPurpose(md), 'To do the thing properly.');
});

test('parseStatedPurpose returns empty string when the bill states no purpose', () => {
  const md = renderMarkdown({
    what_it_does: [{ point: 'Does a thing', section: 'Sec. 1' }],
    stated_purpose: '',
    classification: 'other',
  });
  assert.equal(parseStatedPurpose(md), '');
});

test('parseStatedPurpose returns empty string for empty/absent body_md', () => {
  assert.equal(parseStatedPurpose(''), '');
  assert.equal(parseStatedPurpose(null), '');
});

// ---- buildGoldenJson: reconstructs the {what_it_does, stated_purpose, classification} shape from body_md ----

test('buildGoldenJson round-trips bullets and purpose from rendered markdown, with classification always null (not recoverable from body_md)', () => {
  const original = {
    what_it_does: [
      { point: 'Prohibits X payments', section: 'Sec. 2' },
      { point: 'Establishes a new grant program', section: 'Sec. 3(a)' },
    ],
    stated_purpose: 'To prohibit X and establish Y.',
    classification: 'amends_existing_law',
  };
  const md = renderMarkdown(original);
  const golden = buildGoldenJson(md);
  assert.deepEqual(golden, {
    what_it_does: [
      { point: 'Prohibits X payments', section: 'Sec. 2' },
      { point: 'Establishes a new grant program', section: 'Sec. 3(a)' },
    ],
    stated_purpose: 'To prohibit X and establish Y.',
    classification: null,
  });
});

// ---- goldenFilename ----

test('goldenFilename replaces spaces with dashes', () => {
  assert.equal(goldenFilename('HR 498'), 'HR-498.json');
  assert.equal(goldenFilename('S 100'), 'S-100.json');
});
