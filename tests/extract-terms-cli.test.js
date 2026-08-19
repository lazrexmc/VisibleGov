import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, planExtraction, normalizeTermText, upsertKeyFor, normalizeCitation,
  EXTRACTION_SCHEMA, EXTRACT_MODEL, EXTRACT_PROMPT_VERSION, EXTRACT_SYSTEM_PROMPT,
} from '../src/cli/extract-terms.js';
import { SUMMARY_SCHEMA } from '../src/lib/summarizer.js';

// ---- planExtraction: routes summaries lacking summary_terms rows ----

test('planExtraction routes summaries with no summary_terms row', () => {
  const summaries = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
  const extractedIds = new Set(['s2']);
  const plan = planExtraction(summaries, extractedIds);
  assert.deepEqual(plan.map((s) => s.id), ['s1', 's3']);
});

test('planExtraction returns everything when no summary has been extracted yet', () => {
  const summaries = [{ id: 's1' }, { id: 's2' }];
  const plan = planExtraction(summaries, new Set());
  assert.deepEqual(plan.map((s) => s.id), ['s1', 's2']);
});

test('planExtraction returns nothing when every summary already has a summary_terms row', () => {
  const summaries = [{ id: 's1' }, { id: 's2' }];
  const plan = planExtraction(summaries, new Set(['s1', 's2']));
  assert.equal(plan.length, 0);
});

// ---- normalizeTermText: TRIVIAL normalization only (trim + collapse whitespace) ----

test('normalizeTermText trims leading/trailing whitespace', () => {
  assert.equal(normalizeTermText('  Social Security Act  '), 'Social Security Act');
});

test('normalizeTermText collapses internal whitespace (tabs/newlines/runs of spaces) to a single space', () => {
  assert.equal(normalizeTermText('Social   Security\tAct\n'), 'Social Security Act');
});

test('normalizeTermText never rewrites case or wording — verbatim-from-bill discipline', () => {
  assert.equal(normalizeTermText('the  Secretary  of Health and Human Services'), 'the Secretary of Health and Human Services');
});

test('normalizeTermText handles empty/nullish input without throwing', () => {
  assert.equal(normalizeTermText(''), '');
  assert.equal(normalizeTermText(undefined), '');
  assert.equal(normalizeTermText(null), '');
});

// ---- upsertKeyFor: the branched upsert decision (ledgered from Task 1's review) ----

test('upsertKeyFor: a term with a parseable USC citation upserts by citation, not needing mapping', () => {
  const key = upsertKeyFor({ term: 'Social Security Act', kind: 'act', citation_raw: '42 U.S.C. 1396b' });
  // Task 5 (jurisdiction-aware insert-time dispatch): `citation` is a new, additive field on the
  // by:'citation' branch — carries the normalized string so upsertGlossaryTerm no longer re-derives
  // it. Not a behavior change to which branch this citation takes.
  assert.deepEqual(key, { by: 'citation', needs_mapping: false, citation: '42 U.S.C. 1396b' });
});

test('upsertKeyFor: a term with no citation printed upserts by term, needing mapping', () => {
  const key = upsertKeyFor({ term: 'Secretary', kind: 'agency', citation_raw: '' });
  assert.deepEqual(key, { by: 'term', needs_mapping: true });
});

test('upsertKeyFor: a popular-name-only citation (no USC cite printed) upserts by term, needing mapping — never guesses a USC citation', () => {
  const key = upsertKeyFor({ term: 'Social Security Act', kind: 'act', citation_raw: 'the Social Security Act' });
  assert.deepEqual(key, { by: 'term', needs_mapping: true });
});

test('upsertKeyFor: a "section X of title Y" citation resolves by citation', () => {
  const key = upsertKeyFor({ term: 'Some Program', kind: 'program', citation_raw: 'section 1396b of title 42' });
  // Task 5: additive `citation` field, same reasoning as the test above.
  assert.deepEqual(key, { by: 'citation', needs_mapping: false, citation: '42 U.S.C. 1396b' });
});

// ---- normalizeCitation: AS-CITED granularity (fix round 1 controller ruling) — a captured
// subsection is PRESERVED in the stored citation, not collapsed to section level, so a bill
// citing 1396b(i) and one citing 1396b bare yield distinct glossary_terms rows, and so uscode.js's
// subsection-level oversize fallback (extractSubsectionText) is reachable end-to-end from the
// live extraction pipeline (parseCitation re-resolves the subsection from this exact stored value
// — see glosser.js's fetchGlossSource). ----

test('normalizeCitation preserves a captured subsection in the stored citation (e.g. HR 498\'s own 1396b(i) cite)', () => {
  assert.equal(normalizeCitation('42 U.S.C. 1396b(i)'), '42 U.S.C. 1396b(i)');
});

test('normalizeCitation leaves a bare section citation unchanged — no subsection to preserve', () => {
  assert.equal(normalizeCitation('42 U.S.C. 1396b'), '42 U.S.C. 1396b');
});

test('normalizeCitation normalizes loose formatting (section symbol, "section X of title Y") to the canonical shape', () => {
  assert.equal(normalizeCitation('42 U.S.C. §1396b'), '42 U.S.C. 1396b');
  assert.equal(normalizeCitation('section 1396b of title 42'), '42 U.S.C. 1396b');
});

test('normalizeCitation preserves a subsection on a dashed section number too (e.g. 1396r-4(f))', () => {
  assert.equal(normalizeCitation('42 U.S.C. 1396r-4(f)'), '42 U.S.C. 1396r-4(f)');
});

// ---- EXTRACTION_SCHEMA: mirrors SUMMARY_SCHEMA's referenced_terms shape (tiny output) ----

test('EXTRACTION_SCHEMA wraps a single referenced_terms array, additionalProperties false', () => {
  assert.equal(EXTRACTION_SCHEMA.type, 'object');
  assert.equal(EXTRACTION_SCHEMA.additionalProperties, false);
  assert.deepEqual(EXTRACTION_SCHEMA.required, ['referenced_terms']);
  assert.deepEqual(Object.keys(EXTRACTION_SCHEMA.properties), ['referenced_terms']);
});

test('EXTRACTION_SCHEMA.properties.referenced_terms IS SUMMARY_SCHEMA\'s referenced_terms — mirrored by reference so the two shapes can never drift apart', () => {
  assert.equal(EXTRACTION_SCHEMA.properties.referenced_terms, SUMMARY_SCHEMA.properties.referenced_terms);
});

test('EXTRACTION_SCHEMA referenced_terms items require term/kind/citation_raw, additionalProperties false', () => {
  const item = EXTRACTION_SCHEMA.properties.referenced_terms.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required.sort(), ['citation_raw', 'kind', 'term']);
});

// ---- extraction call constants pinned (controller ruling 1) ----

test('extraction constants pinned: sonnet model, own v1 prompt version, distinct from the summarizer\'s', () => {
  assert.equal(EXTRACT_MODEL, 'claude-sonnet-5');
  assert.equal(EXTRACT_PROMPT_VERSION, 'v1');
});

// ---- EXTRACT_SYSTEM_PROMPT: brought to Task 3's test bar (summarizer.js's SYSTEM_PROMPT) ----

test('EXTRACT_SYSTEM_PROMPT encodes the facts-only extraction rule: never infer, restricted to what the bill text itself prints', () => {
  const lower = EXTRACT_SYSTEM_PROMPT.toLowerCase();
  assert.ok(lower.includes('never infer'), "missing rule marker: 'never infer'");
  assert.ok(
    lower.includes('the bill text itself'),
    'extraction instruction must restrict to names/citations the bill text itself prints',
  );
});

test('EXTRACT_SYSTEM_PROMPT mirrors Task 3\'s exhaustive framing — completeness (every referenced term) and scope (only what the text itself prints) both explicit', () => {
  const lower = EXTRACT_SYSTEM_PROMPT.toLowerCase();
  assert.ok(
    lower.includes('for every statute, act, agency, program, or public law the bill text itself names or cites'),
    "missing the exhaustive-completeness framing mirrored from summarizer.js's SYSTEM_PROMPT",
  );
  assert.ok(lower.includes('only'), 'missing the scope-restricting "only" alongside the completeness framing');
});

// ---- parseArgs: same --dry-run shape as the other CLIs ----

test('parseArgs defaults dryRun to false and accepts --dry-run', () => {
  assert.equal(parseArgs([]).dryRun, false);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});
