import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_SCHEMA, SYSTEM_PROMPT, buildUserMessage, renderMarkdown, MAX_TEXT_CHARS, PROMPT_VERSION, MODEL } from '../src/lib/summarizer.js';

test('schema requires section citations on every bullet', () => {
  const item = SUMMARY_SCHEMA.properties.what_it_does.items;
  assert.deepEqual(item.required.sort(), ['point', 'section']);
  assert.equal(item.additionalProperties, false);
});

test('system prompt encodes the facts-only rules', () => {
  for (const marker of ['traceable', 'stated purpose', 'no adjectives', 'party']) {
    assert.ok(SYSTEM_PROMPT.toLowerCase().includes(marker), `missing rule marker: ${marker}`);
  }
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

test('constants pinned', () => {
  assert.equal(MODEL, 'claude-opus-5');
  assert.equal(PROMPT_VERSION, 'v1');
  assert.ok(MAX_TEXT_CHARS >= 100000);
});
