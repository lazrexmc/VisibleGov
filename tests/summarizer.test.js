import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_SCHEMA, SYSTEM_PROMPT, buildUserMessage, renderMarkdown, MAX_TEXT_CHARS, MAX_OUTPUT_TOKENS, PROMPT_VERSION, MODEL, SummaryTruncatedError } from '../src/lib/summarizer.js';

test('schema requires section citations on every bullet', () => {
  const item = SUMMARY_SCHEMA.properties.what_it_does.items;
  assert.deepEqual(item.required.sort(), ['point', 'section']);
  assert.equal(item.additionalProperties, false);
});

test('schema gains referenced_terms extraction, additionalProperties false at both levels', () => {
  // outer object level (unchanged, must still hold)
  assert.equal(SUMMARY_SCHEMA.additionalProperties, false);
  assert.ok(SUMMARY_SCHEMA.required.includes('referenced_terms'), 'referenced_terms must be required at the top level');

  const rt = SUMMARY_SCHEMA.properties.referenced_terms;
  assert.equal(rt.type, 'array');
  const item = rt.items;
  assert.equal(item.type, 'object');
  // item level (new)
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required.sort(), ['citation_raw', 'kind', 'term']);
  assert.deepEqual(Object.keys(item.properties).sort(), ['citation_raw', 'kind', 'term']);
  assert.deepEqual(
    [...item.properties.kind.enum].sort(),
    ['act', 'agency', 'program', 'public_law', 'statute'],
  );
});

test('system prompt encodes the facts-only rules', () => {
  for (const marker of ['traceable', 'stated purpose', 'no adjectives', 'party']) {
    assert.ok(SYSTEM_PROMPT.toLowerCase().includes(marker), `missing rule marker: ${marker}`);
  }
});

test('system prompt encodes the referenced_terms extraction rule, facts-only', () => {
  const lower = SYSTEM_PROMPT.toLowerCase();
  assert.ok(lower.includes('never infer'), "missing rule marker: 'never infer'");
  assert.ok(lower.includes('referenced_terms'), "missing mention of 'referenced_terms'");
  assert.ok(
    lower.includes('the bill text itself'),
    'extraction instruction must restrict to names/citations the bill text itself prints',
  );
});

test('buildUserMessage embeds identifier, title, and text', () => {
  const msg = buildUserMessage('HR 498', 'Do No Harm', 'SECTION 1. Text.');
  assert.ok(msg.includes('HR 498') && msg.includes('Do No Harm') && msg.includes('SECTION 1.'));
});

test('renderMarkdown produces neutral markdown with citations', () => {
  const md = renderMarkdown({ what_it_does: [{ point: 'Prohibits X payments', section: 'Sec. 2' }], stated_purpose: 'To prohibit X.', classification: 'amends_existing_law' });
  assert.ok(md.includes('Prohibits X payments'));
  assert.ok(md.includes('(Sec. 2)'));
  assert.ok(md.includes('To prohibit X.'));
});

test('renderMarkdown is byte-unchanged by referenced_terms — v2 extraction is additive, not rendered', () => {
  const withoutTerms = {
    what_it_does: [{ point: 'Prohibits X payments', section: 'Sec. 2' }],
    stated_purpose: 'To prohibit X.',
    classification: 'amends_existing_law',
  };
  const withTerms = {
    ...withoutTerms,
    referenced_terms: [
      { term: 'Social Security Act', kind: 'act', citation_raw: '42 U.S.C. 301' },
      { term: 'Secretary', kind: 'agency', citation_raw: '' },
    ],
  };
  const mdWithout = renderMarkdown(withoutTerms);
  const mdWith = renderMarkdown(withTerms);
  assert.equal(mdWith, mdWithout, 'renderMarkdown output must be byte-identical whether or not referenced_terms is present');
  assert.ok(!mdWith.includes('Social Security Act'), 'referenced_terms must not render into the summary body');
  assert.ok(!mdWith.includes('42 U.S.C. 301'), 'referenced_terms must not render into the summary body');
});

test('constants pinned', () => {
  assert.equal(MODEL, 'claude-opus-5');
  assert.equal(PROMPT_VERSION, 'v2');
  assert.ok(MAX_TEXT_CHARS >= 100000);
  assert.ok(MAX_OUTPUT_TOKENS >= 16000);
});

test('SummaryTruncatedError is exported and instanceof Error', () => {
  const err = new SummaryTruncatedError('summary for HR 498 hit max_tokens');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'SummaryTruncatedError');
});
