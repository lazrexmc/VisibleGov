import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL, PROMPT_VERSION, MAX_OUTPUT_TOKENS, GLOSS_SCHEMA, GLOSS_SYSTEM_PROMPT,
  buildGlossUserMessage, authorGloss,
  GLOSS_VERIFIER_MODEL, GLOSS_VERIFY_PROMPT_VERSION, GLOSS_VERIFY_MAX_OUTPUT_TOKENS,
  GLOSS_VERIFY_SCHEMA, GLOSS_VERIFY_SYSTEM_PROMPT, buildGlossVerifyMessage, splitGlossSentences,
  fetchGlossSource,
} from '../src/lib/glosser.js';
import { assessVerdicts } from '../src/lib/verifier.js';

// ---- constants (controller ruling 1: opus-5 authors, sonnet-5 verifies — the established pair) ----

test('MODEL is claude-opus-5, PROMPT_VERSION is gloss-v1 (controller ruling 3)', () => {
  assert.equal(MODEL, 'claude-opus-5');
  assert.equal(PROMPT_VERSION, 'gloss-v1');
});

test('MAX_OUTPUT_TOKENS gives real headroom above extract-terms.js\'s tiny-output cap', () => {
  assert.ok(MAX_OUTPUT_TOKENS >= 2000);
});

test('GLOSS_VERIFIER_MODEL is claude-sonnet-5, deliberately a different weight class than the opus-5 author', () => {
  assert.equal(GLOSS_VERIFIER_MODEL, 'claude-sonnet-5');
  assert.notEqual(GLOSS_VERIFIER_MODEL, MODEL);
});

test('GLOSS_VERIFY_PROMPT_VERSION pinned', () => {
  assert.equal(GLOSS_VERIFY_PROMPT_VERSION, 'v1');
});

test('GLOSS_VERIFY_MAX_OUTPUT_TOKENS gives real headroom, distinct from verifier.js\'s many-bullet-calibrated cap', () => {
  assert.ok(GLOSS_VERIFY_MAX_OUTPUT_TOKENS >= 4000);
});

// ---- GLOSS_SCHEMA shape ----

test('GLOSS_SCHEMA requires gloss_md + supported_by_quote, additionalProperties false', () => {
  assert.deepEqual(GLOSS_SCHEMA.required.sort(), ['gloss_md', 'supported_by_quote']);
  assert.equal(GLOSS_SCHEMA.additionalProperties, false);
  assert.equal(GLOSS_SCHEMA.properties.gloss_md.type, 'string');
  assert.equal(GLOSS_SCHEMA.properties.supported_by_quote.type, 'string');
});

// ---- facts-only system prompt (controller ruling 4: carry Task 3/4's facts-only markers) ----

test('GLOSS_SYSTEM_PROMPT contains the required facts-only markers', () => {
  const lower = GLOSS_SYSTEM_PROMPT.toLowerCase();
  for (const marker of ['from this excerpt alone', 'never infer', 'plain language', 'party']) {
    assert.ok(lower.includes(marker), `missing rule marker: ${marker}`);
  }
});

test('GLOSS_SYSTEM_PROMPT forbids characterization beyond function (no adjectives about merit)', () => {
  const lower = GLOSS_SYSTEM_PROMPT.toLowerCase();
  assert.ok(lower.includes('no adjectives'), "missing rule marker: 'no adjectives'");
  assert.ok(lower.includes('1-2 sentences'), 'missing the 1-2 sentence length constraint');
});

// ---- buildGlossUserMessage ----

test('buildGlossUserMessage embeds term and excerpt text', () => {
  const msg = buildGlossUserMessage('Social Security Act, Sec. 1903', 'The Secretary shall...');
  assert.ok(msg.includes('Social Security Act, Sec. 1903'));
  assert.ok(msg.includes('The Secretary shall...'));
});

// ---- GLOSS_VERIFY_SCHEMA shape (reuses assessVerdicts unchanged — bullet_index field name) ----

test('GLOSS_VERIFY_SCHEMA top level requires verdicts + overall, additionalProperties false', () => {
  assert.deepEqual(GLOSS_VERIFY_SCHEMA.required.sort(), ['overall', 'verdicts']);
  assert.equal(GLOSS_VERIFY_SCHEMA.additionalProperties, false);
});

test('GLOSS_VERIFY_SCHEMA.overall is an enum of exactly clean/flagged', () => {
  assert.deepEqual(GLOSS_VERIFY_SCHEMA.properties.overall.enum.sort(), ['clean', 'flagged']);
});

test('GLOSS_VERIFY_SCHEMA.verdicts items require bullet_index (reused field name) + three other fields, additionalProperties false', () => {
  const item = GLOSS_VERIFY_SCHEMA.properties.verdicts.items;
  assert.deepEqual(item.required.sort(), ['bullet_index', 'evidence_quote', 'reason', 'supported']);
  assert.equal(item.additionalProperties, false);
});

// ---- adversarial gloss-verify system prompt ----

test('GLOSS_VERIFY_SYSTEM_PROMPT contains the required adversarial-stance markers', () => {
  const lower = GLOSS_VERIFY_SYSTEM_PROMPT.toLowerCase();
  for (const marker of ['refute', 'excerpt', 'fully supported', 'quote']) {
    assert.ok(lower.includes(marker), `missing marker: ${marker}`);
  }
});

// ---- buildGlossVerifyMessage ----

test('buildGlossVerifyMessage embeds term, sentencesJson, and excerpt text', () => {
  const sentencesJson = JSON.stringify(['The Secretary administers grants.']);
  const msg = buildGlossVerifyMessage('Some Act', sentencesJson, 'Full excerpt text here.');
  assert.ok(msg.includes('Some Act'));
  assert.ok(msg.includes(sentencesJson));
  assert.ok(msg.includes('Full excerpt text here.'));
});

// ---- splitGlossSentences: pure, mirrors verify.js's parseBullets role ----

test('splitGlossSentences splits two sentences on terminal punctuation', () => {
  const result = splitGlossSentences('The Secretary administers grants. States must comply with federal standards.');
  assert.deepEqual(result, [
    'The Secretary administers grants.',
    'States must comply with federal standards.',
  ]);
});

test('splitGlossSentences returns a single-element array for one sentence', () => {
  assert.deepEqual(splitGlossSentences('The Secretary administers grants.'), ['The Secretary administers grants.']);
});

test('splitGlossSentences returns the whole trimmed string as one sentence when there is no terminal punctuation', () => {
  assert.deepEqual(splitGlossSentences('The Secretary administers grants'), ['The Secretary administers grants']);
});

test('splitGlossSentences returns an empty array for empty/nullish input', () => {
  assert.deepEqual(splitGlossSentences(''), []);
  assert.deepEqual(splitGlossSentences(null), []);
  assert.deepEqual(splitGlossSentences(undefined), []);
  assert.deepEqual(splitGlossSentences('   '), []);
});

test('splitGlossSentences trims surrounding whitespace from each sentence', () => {
  assert.deepEqual(
    splitGlossSentences('  First sentence.   Second sentence.  '),
    ['First sentence.', 'Second sentence.'],
  );
});

// splitGlossSentences' output feeds assessVerdicts (reused, not reimplemented) as the sentence
// count — confirms the two functions actually compose the way glossOne (gloss.js) uses them.
test('splitGlossSentences count composes with assessVerdicts for the 2-sentence case', () => {
  const sentences = splitGlossSentences('First sentence. Second sentence.');
  const verdicts = [
    { bullet_index: 0, supported: true },
    { bullet_index: 1, supported: true },
  ];
  assert.deepEqual(assessVerdicts(verdicts, sentences.length), { complete: true, overall: 'clean' });
});

// ---- fetchGlossSource: unparseable-citation guard is testable without any network/live client ----

test('fetchGlossSource rejects a citation with no parseable title/section before touching the network', async () => {
  await assert.rejects(() => fetchGlossSource('the Social Security Act'), /not a parseable USC citation/);
});

test('fetchGlossSource rejects null/empty citation before touching the network', async () => {
  await assert.rejects(() => fetchGlossSource(''), /not a parseable USC citation/);
  await assert.rejects(() => fetchGlossSource(null), /not a parseable USC citation/);
});
