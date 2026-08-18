import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PRICES, priceOf, createCostTracker, classifyBillingError, apiProvisionsSchema,
  loadCheckpoint, saveCheckpoint, buildReAuthorMessage, runBillChain,
} from '../src/lib/billed-summary-chain.js';

function fakeAnthropic(responsesByLabelOrder) {
  // Each call pops the next canned {json, usage} and returns a stream-like object whose
  // finalMessage() resolves to the SDK response shape callStructured/runBillChain consume.
  const calls = [];
  return {
    calls,
    messages: {
      stream(req) {
        const canned = responsesByLabelOrder.shift();
        calls.push(req);
        return {
          finalMessage: async () => ({
            usage: canned.usage ?? { input_tokens: 1000, output_tokens: 100 },
            stop_reason: canned.stop_reason ?? 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(canned.json) }],
          }),
        };
      },
    },
  };
}

const SUMMARY = {
  what_it_does: [{ point: 'Does X.', section: 'Sec. 1' }],
  stated_purpose: '',
  classification: 'other',
  referenced_terms: [],
};
const VERIFY = { verdicts: [{ bullet_index: 0, section: 'Sec. 1', supported: true, reason: 'ok', evidence_quote: 'Does X' }], overall: 'clean' };
const PROVISIONS = { key_provisions: [{ section: 'SEC. 1.', provision: 'Does X.' }, { section: 'SEC. 2.', provision: 'Does Y.' }, { section: 'SEC. 3.', provision: 'Does Z.' }] };
const COVERAGE = { coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'n' }, { provision_index: 1, covered: true, bullet_index: 0, note: 'n' }, { provision_index: 2, covered: true, bullet_index: 0, note: 'n' }] };
const BILL = { bill_id: 'b-1', identifier: 'HB 1', title: 'T', bill_text_hash: 'abcdef1234567890' };

test('cost tracker: prices real usage at the model\'s per-Mtok rates', () => {
  const t = createCostTracker();
  t.record('claude-haiku-4-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'author:x');
  assert.equal(t.spentUsd(), PRICES['claude-haiku-4-5'].in + PRICES['claude-haiku-4-5'].out);
  assert.equal(t.callLog.length, 1);
  assert.equal(t.callLog[0].label, 'author:x');
});

test('priceOf throws for an unpriced model — never spends unpriced', () => {
  assert.throws(() => priceOf('claude-nonexistent'), /no price entry/);
});

test('classifyBillingError: credit-class 400s are billing, schema 400s are not', () => {
  assert.equal(classifyBillingError({ status: 400, message: 'Your credit balance is too low' }), true);
  assert.equal(classifyBillingError({ status: 402, message: 'billing issue' }), true);
  assert.equal(classifyBillingError({ status: 400, message: 'minItems values other than 0 or 1 are not supported' }), false);
  assert.equal(classifyBillingError({ status: 500, message: 'overloaded' }), false);
  assert.equal(classifyBillingError(new Error('plain')), false);
});

test('apiProvisionsSchema strips minItems/maxItems (API rejects them) and keeps items shape', () => {
  const s = apiProvisionsSchema();
  assert.equal(s.minItems, undefined);
  assert.equal(s.maxItems, undefined);
  assert.ok(s.items);
});

test('runBillChain: full 4-stage chain produces the record envelope', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const anthropic = fakeAnthropic([{ json: SUMMARY }, { json: VERIFY }, { json: PROVISIONS }, { json: COVERAGE }]);
  const tracker = createCostTracker();
  const { envelope } = await runBillChain(anthropic, tracker, {
    bill: BILL, text: 'Does X. SEC. 1. SEC. 2. SEC. 3.', stageDir: dir, checkpointKey: 'b-1-abcdef12',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
  });
  assert.equal(envelope.bill_id, 'b-1');
  assert.equal(envelope.provenance, 'api');
  assert.equal(envelope.author_model, 'claude-haiku-4-5');
  assert.equal(envelope.summary.what_it_does.length, 1);
  assert.equal(envelope.verdicts.length, 1);
  assert.equal(envelope.completeness.key_provisions.length, 3);
  assert.equal(anthropic.calls.length, 4);
  assert.ok(tracker.spentUsd() > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('runBillChain: checkpoint resume never re-pays for a completed stage', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  saveCheckpoint(dir, 'b-1-abcdef12', { summary: SUMMARY, verify: VERIFY });
  const anthropic = fakeAnthropic([{ json: PROVISIONS }, { json: COVERAGE }]);
  const { envelope } = await runBillChain(anthropic, createCostTracker(), {
    bill: BILL, text: 't', stageDir: dir, checkpointKey: 'b-1-abcdef12',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
  });
  assert.equal(anthropic.calls.length, 2); // only provisions + coverage ran
  assert.equal(envelope.summary.what_it_does[0].point, 'Does X.');
  rmSync(dir, { recursive: true, force: true });
});

test('runBillChain with reAuthor: the author user message carries the prior draft and numbered objections', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const anthropic = fakeAnthropic([{ json: SUMMARY }, { json: VERIFY }, { json: PROVISIONS }, { json: COVERAGE }]);
  await runBillChain(anthropic, createCostTracker(), {
    bill: BILL, text: 't', stageDir: dir, checkpointKey: 'k',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
    reAuthor: { priorSummary: SUMMARY, objections: ['fix A', 'fix B'] },
  });
  const authorMsg = anthropic.calls[0].messages[0].content;
  assert.match(authorMsg, /PRIOR DRAFT:/);
  assert.match(authorMsg, /1\. fix A/);
  assert.match(authorMsg, /2\. fix B/);
  rmSync(dir, { recursive: true, force: true });
});

test('runBillChain: author refusal/max_tokens surfaces as a thrown error (no envelope)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const anthropic = fakeAnthropic([{ json: {}, stop_reason: 'refusal' }]);
  await assert.rejects(
    () => runBillChain(anthropic, createCostTracker(), {
      bill: BILL, text: 't', stageDir: dir, checkpointKey: 'k2',
      authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
    }),
    /refused/,
  );
  rmSync(dir, { recursive: true, force: true });
});

// ---- sub-floor corroboration stage (spec 2026-08-18) ----

const THIN_PROVISIONS = { key_provisions: [{ section: 'SEC. 1.', provision: 'Does X.' }] };
const THIN_COVERAGE = { coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'n' }] };
// ≥5,000 chars → floor 3, so a 1-provision yield is sub-floor and must trigger corroboration.
const LONG_TEXT = `${'W'.repeat(5200)} SEC. 1. Does X.`;

test('runBillChain: sub-floor provisions yield triggers ONE corroboration call, checkpointed, and the envelope carries the field', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const anthropic = fakeAnthropic([
    { json: SUMMARY }, { json: VERIFY }, { json: THIN_PROVISIONS },
    { json: THIN_PROVISIONS }, // the corroboration call's canned response
    { json: THIN_COVERAGE },
  ]);
  const tracker = createCostTracker();
  const { envelope } = await runBillChain(anthropic, tracker, {
    bill: BILL, text: LONG_TEXT, stageDir: dir, checkpointKey: 'b-1-thin0001',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
  });
  assert.equal(anthropic.calls.length, 5);
  assert.deepEqual(envelope.completeness_corroboration, { key_provisions: THIN_PROVISIONS.key_provisions });
  assert.ok(tracker.callLog.some((c) => c.label === 'provisions-corroboration:HB 1'));
  rmSync(dir, { recursive: true, force: true });
});

test('runBillChain: at-floor yield makes NO corroboration call and the envelope lacks the field', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const anthropic = fakeAnthropic([{ json: SUMMARY }, { json: VERIFY }, { json: PROVISIONS }, { json: COVERAGE }]);
  const tracker = createCostTracker();
  const { envelope } = await runBillChain(anthropic, tracker, {
    bill: BILL, text: 'Does X. SEC. 1. SEC. 2. SEC. 3.', stageDir: dir, checkpointKey: 'b-1-atfloor1',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
  });
  assert.equal(anthropic.calls.length, 4);
  assert.equal(envelope.completeness_corroboration, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('runBillChain: checkpoint replay skips a completed corroboration stage — no double pay', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const first = fakeAnthropic([
    { json: SUMMARY }, { json: VERIFY }, { json: THIN_PROVISIONS }, { json: THIN_PROVISIONS }, { json: THIN_COVERAGE },
  ]);
  await runBillChain(first, createCostTracker(), {
    bill: BILL, text: LONG_TEXT, stageDir: dir, checkpointKey: 'b-1-replay01',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
  });
  const second = fakeAnthropic([]); // every stage checkpointed — a replay must make ZERO calls
  const { envelope } = await runBillChain(second, createCostTracker(), {
    bill: BILL, text: LONG_TEXT, stageDir: dir, checkpointKey: 'b-1-replay01',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
  });
  assert.equal(second.calls.length, 0);
  assert.deepEqual(envelope.completeness_corroboration, { key_provisions: THIN_PROVISIONS.key_provisions });
  rmSync(dir, { recursive: true, force: true });
});
