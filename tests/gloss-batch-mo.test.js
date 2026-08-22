import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthorRequest, buildVerifyRequest, gateAuthoredGloss, batchSpendUsd,
  RETRY_WARNING, AUTHOR_MODEL, ESCALATION_MODEL, BATCH_DISCOUNT,
  citationFilterFor, runSourceFor, stateDirNameFor,
  projectBatchSpendUsd, assertWithinBudget, recordFetchFailure, clearFetchFailure,
  PROJECTION_OVERHEAD_TOKENS, PROJECTION_OUTPUT_TOKENS, PROJECTION_AUTHOR_OUTPUT_TOKENS, PROJECTION_VERIFY_OUTPUT_TOKENS,
  PROJECTION_RETRY_ALLOWANCE,
} from '../scripts/gloss-batch-mo.mjs';
import { priceOf } from '../src/lib/billed-summary-chain.js';
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

test('batchSpendUsd prices a dated canonical model id the Batch API returns (claude-haiku-4-5-20251001) the same as its alias', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0 };
  assert.equal(batchSpendUsd('claude-haiku-4-5-20251001', usage), batchSpendUsd('claude-haiku-4-5', usage));
  assert.equal(batchSpendUsd('claude-sonnet-5-20260301', usage), batchSpendUsd('claude-sonnet-5', usage));
});

test('batchSpendUsd still refuses a genuinely unpriced model', () => {
  assert.throws(() => batchSpendUsd('claude-unknown-9-20260101', { input_tokens: 1, output_tokens: 1 }), /no price entry/);
});

// ---- --source widening (2026-08-21: the 692 USC mappable drafts through the same runner) ----

test('citationFilterFor routes by stored-citation shape: mo -> RSMo only, usc -> U.S.C. only', () => {
  const mo = citationFilterFor('mo');
  const usc = citationFilterFor('usc');
  assert.equal(mo({ citation: 'RSMo 536.010' }), true);
  assert.equal(mo({ citation: '42 U.S.C. 1396b' }), false);
  assert.equal(usc({ citation: '42 U.S.C. 1396b(i)' }), true);
  assert.equal(usc({ citation: 'RSMo 536.010' }), false);
  assert.equal(usc({ citation: null }), false);
  assert.throws(() => citationFilterFor('all'), /unknown --source/);
});

test('runSourceFor / stateDirNameFor keep the two drains in separate run labels and checkpoint dirs', () => {
  assert.equal(runSourceFor('mo'), 'gloss-batch-mo');
  assert.equal(runSourceFor('usc'), 'gloss-batch-usc');
  assert.equal(stateDirNameFor('mo'), 'gloss-batch-mo');
  assert.equal(stateDirNameFor('usc'), 'gloss-batch-usc');
});

// ---- budget projection + fetch-failure bookkeeping (2026-08-21: the USC run spent $8.31 against an
// $8 cap — the cap only gated BEFORE each submission, and the verify batch alone cost $5.24, so
// nothing could stop it; the up-front estimate used a flat MO-derived per-term rate while the USC
// bank on disk averaged 2.5x the excerpt length) ----

test('projectBatchSpendUsd scales with the excerpt bank on disk and carries the batch discount', () => {
  const noFixed = { overheadTokens: 0, outputTokens: 0 }; // isolate the excerpt-driven input term
  const shortIn = projectBatchSpendUsd(AUTHOR_MODEL, ['a'.repeat(4_000)], noFixed);
  const longIn = projectBatchSpendUsd(AUTHOR_MODEL, ['a'.repeat(40_000)], noFixed);
  assert.ok(Math.abs(longIn / shortIn - 10) < 1e-9, `a 10x longer excerpt must project 10x the input cost (${shortIn} -> ${longIn})`);
  const short = projectBatchSpendUsd(AUTHOR_MODEL, ['a'.repeat(4_000)]);
  const p = priceOf(AUTHOR_MODEL);
  const expected = (((1_000 + PROJECTION_OVERHEAD_TOKENS) * p.in + PROJECTION_OUTPUT_TOKENS * p.out) / 1e6) * BATCH_DISCOUNT;
  assert.ok(Math.abs(short - expected) < 1e-9);
  assert.equal(projectBatchSpendUsd(AUTHOR_MODEL, []), 0);
});

test('assertWithinBudget refuses a batch whose projected cost would breach the cap, and names the numbers', () => {
  assert.throws(() => assertWithinBudget({ label: 'verify', spentUsd: 3.07, projectedUsd: 5.9, budgetUsd: 8 }),
    /verify.*\$5\.90.*\$3\.07.*\$8/);
  assert.doesNotThrow(() => assertWithinBudget({ label: 'author-1', spentUsd: 0, projectedUsd: 1.6, budgetUsd: 8 }));
  assert.doesNotThrow(() => assertWithinBudget({ label: 'author-1', spentUsd: 6.4, projectedUsd: 1.6, budgetUsd: 8 }), 'exactly at the cap is allowed');
});

test('recordFetchFailure replaces by term id (a resumed sweep must not double-count) and clearFetchFailure drops a now-fetched term', () => {
  const state = { fetchFailures: [] };
  recordFetchFailure(state, { id: 't1', citation: '30 U.S.C. 28-28', reason: 'UscSectionNotFoundError: x' });
  recordFetchFailure(state, { id: 't2', citation: '42 U.S.C. 1396a', reason: 'OversizeExcerptError: y' });
  recordFetchFailure(state, { id: 't1', citation: '30 U.S.C. 28-28', reason: 'UscSectionNotFoundError: x again' });
  assert.equal(state.fetchFailures.length, 2);
  assert.equal(state.fetchFailures.find((f) => f.id === 't1').reason, 'UscSectionNotFoundError: x again');
  clearFetchFailure(state, 't2');
  assert.deepEqual(state.fetchFailures.map((f) => f.id), ['t1']);
  clearFetchFailure(state, 'absent'); // no-op, never throws
});

test('projection CALIBRATION: never projects below the 2026-08-21 USC run actuals (author-1 $1.28 over 669; verify $5.24 over 665)', () => {
  // Mean banked USC excerpt was 11,056 chars. If a price-table change ever makes this fail, the
  // allowances must be recalibrated UP against a real run — the projection must err high.
  const usc = Array.from({ length: 669 }, () => 'x'.repeat(11_056));
  const author1 = projectBatchSpendUsd(AUTHOR_MODEL, usc, { outputTokens: PROJECTION_AUTHOR_OUTPUT_TOKENS });
  const verify = projectBatchSpendUsd(GLOSS_VERIFIER_MODEL, usc.slice(0, 665), { outputTokens: PROJECTION_VERIFY_OUTPUT_TOKENS });
  assert.ok(author1 >= 1.28, `author-1 projection ${author1.toFixed(2)} is below the measured $1.28`);
  assert.ok(verify >= 5.24, `verify projection ${verify.toFixed(2)} is below the measured $5.24`);
  assert.equal(PROJECTION_OUTPUT_TOKENS, PROJECTION_VERIFY_OUTPUT_TOKENS, 'the default allowance must be the larger one');
  // And the guards that would have stopped today's overspend: verify at $3.07 spent under an $8 cap
  // is refused; the whole run is refused up front under an $8 cap once the retry allowance applies.
  assert.throws(() => assertWithinBudget({ label: 'verify', spentUsd: 3.07, projectedUsd: verify, budgetUsd: 8 }), /verify/);
  assert.throws(() => assertWithinBudget({ label: 'projected run', spentUsd: 0, projectedUsd: (author1 + verify) * PROJECTION_RETRY_ALLOWANCE, budgetUsd: 8 }), /projected run/);
});
