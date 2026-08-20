import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthorRequest, buildVerifyRequest, gateAuthoredGloss, batchSpendUsd,
  RETRY_WARNING, AUTHOR_MODEL, ESCALATION_MODEL, BATCH_DISCOUNT,
} from '../scripts/gloss-batch-mo.mjs';
import {
  GLOSS_SYSTEM_PROMPT, GLOSS_SCHEMA, GLOSS_VERIFIER_MODEL, GLOSS_VERIFY_SCHEMA, MODEL,
} from '../src/lib/glosser.js';
import { persistGloss } from '../src/cli/gloss.js';

const TERM = { id: 'term-1', term: 'section 536.010', citation: 'RSMo 536.010' };
const EXCERPT = '536.010. Definitions. — For the purpose of this chapter: (1) "Agency" means any administrative officer or body.';

const authorMessage = (json, stopReason = 'end_turn') => ({
  stop_reason: stopReason,
  content: [{ type: 'text', text: JSON.stringify(json) }],
});

test('buildAuthorRequest uses the trust lib prompts/schema verbatim, keyed by term id', () => {
  const req = buildAuthorRequest(TERM, EXCERPT, { model: AUTHOR_MODEL });
  assert.equal(req.custom_id, 'term-1');
  assert.equal(req.params.model, AUTHOR_MODEL);
  assert.equal(req.params.system, GLOSS_SYSTEM_PROMPT);
  assert.deepEqual(req.params.output_config, { format: { type: 'json_schema', schema: GLOSS_SCHEMA } });
  assert.ok(req.params.messages[0].content.includes(EXCERPT));
  assert.ok(!req.params.messages[0].content.includes('WARNING'), 'no warning on the first attempt');
});

test('buildAuthorRequest appends the retry warning to the SAME base message', () => {
  const plain = buildAuthorRequest(TERM, EXCERPT, { model: AUTHOR_MODEL });
  const retry = buildAuthorRequest(TERM, EXCERPT, { model: ESCALATION_MODEL, withRetryWarning: true });
  assert.equal(retry.params.model, ESCALATION_MODEL);
  assert.equal(retry.params.messages[0].content, plain.params.messages[0].content + RETRY_WARNING);
});

test('buildVerifyRequest uses the verifier model + schema and carries the sentences JSON', () => {
  const req = buildVerifyRequest(TERM, ['A sentence.'], EXCERPT);
  assert.equal(req.custom_id, 'term-1');
  assert.equal(req.params.model, GLOSS_VERIFIER_MODEL);
  assert.deepEqual(req.params.output_config, { format: { type: 'json_schema', schema: GLOSS_VERIFY_SCHEMA } });
  assert.ok(req.params.messages[0].content.includes(JSON.stringify(['A sentence.'])));
});

test('gateAuthoredGloss passes a clean gloss with a verbatim quote', () => {
  const gate = gateAuthoredGloss(TERM, authorMessage({
    gloss_md: 'This section defines terms used in the chapter.',
    supported_by_quote: 'For the purpose of this chapter',
  }), EXCERPT);
  assert.equal(gate.ok, true);
  assert.equal(gate.sentences.length, 1);
});

test('gateAuthoredGloss fails a non-verbatim quote as a retryable reason, never a throw', () => {
  const gate = gateAuthoredGloss(TERM, authorMessage({
    gloss_md: 'A sentence.',
    supported_by_quote: 'text the excerpt does not contain',
  }), EXCERPT);
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /QuoteNotVerbatimError/);
});

test('gateAuthoredGloss fails empty gloss, refusal, truncation, and unparseable JSON honestly', () => {
  assert.match(gateAuthoredGloss(TERM, authorMessage({ gloss_md: '', supported_by_quote: 'For the purpose' }), EXCERPT).reason, /Quote|Empty/);
  assert.equal(gateAuthoredGloss(TERM, authorMessage({}, 'refusal'), EXCERPT).reason, 'author refusal');
  assert.equal(gateAuthoredGloss(TERM, authorMessage({}, 'max_tokens'), EXCERPT).reason, 'author truncation');
  assert.equal(gateAuthoredGloss(TERM, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }, EXCERPT).reason, 'unparseable JSON');
});

test('batchSpendUsd applies the 50% batch discount to interactive prices', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0 };
  assert.equal(batchSpendUsd('claude-haiku-4-5', usage), 1.0 * BATCH_DISCOUNT);
});

test('persistGloss writes the TRUE author model when given, and the opus default otherwise', async () => {
  const calls = [];
  const fake = {
    from(table) {
      return {
        insert(row) { calls.push({ table, op: 'insert', row }); return Promise.resolve({ error: null }); },
        update(row) {
          return { eq() { calls.push({ table, op: 'update', row }); return Promise.resolve({ error: null }); } };
        },
      };
    },
  };
  const gloss = {
    glossMd: 'A sentence.', supportedByQuote: 'quote', sourceUrl: 'u', sourceHash: 'h',
    verdicts: [], overall: 'clean',
  };
  await persistGloss(fake, 'run-1', { id: 't1' }, { ...gloss, authorModel: 'claude-haiku-4-5' });
  await persistGloss(fake, 'run-1', { id: 't2' }, gloss);
  const updates = calls.filter((c) => c.op === 'update');
  assert.equal(updates[0].row.model, 'claude-haiku-4-5');
  assert.equal(updates[1].row.model, MODEL);
});
