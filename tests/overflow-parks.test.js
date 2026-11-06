import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGE_OUTPUT_ALLOWANCES, parseMaxTokensFailure, overflowKey, overflowRecordFor,
  overflowSuppression,
} from '../src/lib/overflow-parks.js';

// ---------------------------------------------------------------------------
// Permanent suppression of bills that overflow max_tokens (2026-11-06).
//
// Missouri appropriations bills exceed the output allowance and are retried on every billed tick -
// HB 2 did it ten times between 2026-10-20 and 2026-11-05, each retry paying for a full authored
// output that was then discarded (docs/EXPECTED_FAILURES.md entry 4).
//
// The rule, agreed with RapidForge under docs/JOINT_CHANGE_PROTOCOL.md: a max_tokens stop on
// UNCHANGED input is permanent, keyed by the bill's text hash, and nothing more is spent on it
// until either the text or the output allowance changes.
//
// Two asymmetries drive every design decision below:
//   - Paying twice for an impossible bill costs money. Permanently suppressing a POSSIBLE bill
//     loses it from a civic-transparency site forever. So every ambiguous case fails toward
//     ATTEMPTING, never toward suppressing.
//   - The stage matters. `coverage` caps output at 3,000 tokens while `verify` gets 32,000, so
//     "HB 2 overflowed" is meaningless without saying where. A record that cannot name its stage
//     cannot honour the allowance clause and therefore must not be permanent at all.
// ---------------------------------------------------------------------------

test('STAGE_OUTPUT_ALLOWANCES: carries every stage the chain can throw max_tokens from', () => {
  // These mirror src/lib/{summarizer,verifier}.js and the inline literals in
  // billed-summary-chain.js. If a stage is missing, a real overflow in it becomes unparkable.
  for (const stage of ['author', 'reauthor', 'verify', 'provisions', 'provisions-corroboration', 'coverage']) {
    assert.equal(typeof STAGE_OUTPUT_ALLOWANCES[stage], 'number', `${stage} must declare an allowance`);
  }
  assert.equal(STAGE_OUTPUT_ALLOWANCES.coverage, 3000, 'the tightest stage, and the one HB 2 actually failed');
  assert.equal(STAGE_OUTPUT_ALLOWANCES.verify, 32000);
});

// ---- parsing the failure ----------------------------------------------------------------------

test('parseMaxTokensFailure: reads the stage out of the chain\'s own error message', () => {
  assert.deepEqual(parseMaxTokensFailure('coverage:HB 2: hit max_tokens'), { stage: 'coverage', identifier: 'HB 2' });
  assert.deepEqual(parseMaxTokensFailure('verify:HB 19: hit max_tokens'), { stage: 'verify', identifier: 'HB 19' });
});

test('parseMaxTokensFailure: handles a HYPHENATED stage name', () => {
  // provisions-corroboration would be truncated to "provisions" by a lazy split on "-".
  assert.deepEqual(
    parseMaxTokensFailure('provisions-corroboration:SB 40: hit max_tokens'),
    { stage: 'provisions-corroboration', identifier: 'SB 40' },
  );
});

test('parseMaxTokensFailure: handles an identifier containing a colon or spaces', () => {
  // Identifiers are upstream data; a colon in one must not shift the stage.
  assert.deepEqual(
    parseMaxTokensFailure('author:HB 2: Part II: hit max_tokens'),
    { stage: 'author', identifier: 'HB 2: Part II' },
  );
});

test('parseMaxTokensFailure: returns null for ANY failure that is not a max_tokens stop', () => {
  // The whole point. A refusal, a billing error or a completeness failure must never become a
  // permanent park - those are the retryable kinds, and one of them is already handled by
  // isStochasticRecordFailure.
  for (const msg of [
    'coverage:HB 2: refused to answer',
    'author:HB 2: completeness gate refused 3 of 5 provisions',
    'your credit balance is too low',
    'bill_texts hash mismatch vs. queue hash — skipped',
    '',
  ]) {
    assert.equal(parseMaxTokensFailure(msg), null, `must not park on: ${msg}`);
  }
});

test('parseMaxTokensFailure: returns null on a non-string, never throws', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.equal(parseMaxTokensFailure(bad), null);
  }
});

test('parseMaxTokensFailure: returns null when the stage is UNKNOWN - unparkable, so transient', () => {
  // An unrecognised stage has no declared allowance, so the "until the allowance changes" clause
  // cannot be honoured. A park that can never be invalidated would lose the bill forever, so this
  // deliberately falls back to the retryable path even though that costs money again.
  assert.equal(parseMaxTokensFailure('somenewstage:HB 2: hit max_tokens'), null);
});

// ---- the key ---------------------------------------------------------------------------------

test('overflowKey: binds the record to the TEXT, not just the bill', () => {
  const a = overflowKey('uuid-1', 'abcdef0123456789abcdef');
  const b = overflowKey('uuid-1', 'fedcba9876543210fedcba');
  assert.notEqual(a, b, 'a substitute or amended bill is a different input and deserves a fresh attempt');
  assert.equal(a, overflowKey('uuid-1', 'abcdef0123456789abcdef'), 'same bill + same text must be stable');
});

test('overflowKey: a missing or empty hash yields null - never a key that collides on "undefined"', () => {
  // Two different untexted bills must not share a key, and an unhashable bill must not be parked
  // at all.
  assert.equal(overflowKey('uuid-1', undefined), null);
  assert.equal(overflowKey('uuid-1', ''), null);
  assert.equal(overflowKey(undefined, 'abc'), null);
});

// ---- the record ------------------------------------------------------------------------------

const NOW = new Date('2026-11-06T12:00:00Z');

test('overflowRecordFor: records the stage AND the allowance in force, which is what lets it expire', () => {
  const r = overflowRecordFor({
    billId: 'uuid-1', identifier: 'HB 2', stage: 'coverage', textHash: 'abc123def456', now: NOW,
  });
  assert.equal(r.stage, 'coverage');
  assert.equal(r.max_tokens, 3000, 'without this the allowance clause has nothing to compare against');
  assert.equal(r.identifier, 'HB 2');
  assert.equal(r.bill_id, 'uuid-1');
  assert.equal(r.text_hash, 'abc123def456');
  assert.equal(r.recorded_at, NOW.toISOString());
  assert.match(r.reason, /max_tokens/);
});

test('overflowRecordFor: returns null for an unknown stage rather than inventing an allowance', () => {
  assert.equal(overflowRecordFor({
    billId: 'uuid-1', identifier: 'HB 2', stage: 'mystery', textHash: 'abc', now: NOW,
  }), null);
});

// ---- the suppression decision ------------------------------------------------------------------

const store = {
  [overflowKey('uuid-1', 'hash-aaa')]: {
    bill_id: 'uuid-1', identifier: 'HB 2', stage: 'coverage', max_tokens: 3000,
    text_hash: 'hash-aaa', recorded_at: '2026-11-06T12:00:00Z', reason: 'hit max_tokens',
  },
};

test('overflowSuppression: suppresses a bill whose text is unchanged and allowance unchanged', () => {
  const s = overflowSuppression(store, { billId: 'uuid-1', textHash: 'hash-aaa' });
  assert.equal(s.suppressed, true);
  assert.equal(s.record.stage, 'coverage');
  assert.match(s.reason, /coverage/);
  assert.match(s.reason, /3000/, 'the reason a person reads must name the limit that was hit');
});

test('overflowSuppression: does NOT suppress once the bill text changes', () => {
  const s = overflowSuppression(store, { billId: 'uuid-1', textHash: 'hash-bbb' });
  assert.equal(s.suppressed, false, 'an amended HB 2 is a different input and gets one fresh attempt');
});

test('overflowSuppression: does NOT suppress once that stage\'s allowance is RAISED', () => {
  // The other half of RapidForge's rule, and it is load-bearing precisely because coverage's 3,000
  // is suspiciously tight: a bill that overflowed at 3,000 is not proven impossible at 8,000.
  const s = overflowSuppression(store, { billId: 'uuid-1', textHash: 'hash-aaa' }, { coverage: 8000 });
  assert.equal(s.suppressed, false);
  assert.match(s.reason, /allowance/i);
});

test('overflowSuppression: STILL suppresses when the allowance is lowered', () => {
  // Tightening a limit cannot make a previously-impossible bill possible.
  const s = overflowSuppression(store, { billId: 'uuid-1', textHash: 'hash-aaa' }, { coverage: 1000 });
  assert.equal(s.suppressed, true);
});

test('overflowSuppression: an unknown bill is never suppressed', () => {
  assert.equal(overflowSuppression(store, { billId: 'uuid-9', textHash: 'hash-aaa' }).suppressed, false);
});

test('overflowSuppression: a MALFORMED record does not suppress - corruption must not delete coverage', () => {
  // Fails toward attempting. A junk file that silently suppressed bills would remove them from a
  // transparency site with no symptom anywhere, which is strictly worse than paying again.
  for (const bad of [null, {}, 'a string', { stage: 'coverage' }, { max_tokens: 3000 }]) {
    const s = overflowSuppression({ [overflowKey('uuid-1', 'hash-aaa')]: bad }, { billId: 'uuid-1', textHash: 'hash-aaa' });
    assert.equal(s.suppressed, false, `malformed record must not suppress: ${JSON.stringify(bad)}`);
  }
});

test('overflowSuppression: a non-object store does not throw and does not suppress', () => {
  for (const bad of [null, undefined, 'x', 42]) {
    assert.equal(overflowSuppression(bad, { billId: 'uuid-1', textHash: 'hash-aaa' }).suppressed, false);
  }
});

test('overflowSuppression: a bill with no text hash is never suppressed', () => {
  assert.equal(overflowSuppression(store, { billId: 'uuid-1', textHash: undefined }).suppressed, false);
});

test('overflowSuppression: a record whose stage is no longer declared does not suppress', () => {
  // If a stage is renamed or removed, its allowance can no longer be compared, so the park can
  // never expire. Release it rather than hold a bill on a comparison nothing can make.
  const s = overflowSuppression(
    { [overflowKey('uuid-1', 'hash-aaa')]: { stage: 'retired-stage', max_tokens: 3000, bill_id: 'uuid-1', text_hash: 'hash-aaa' } },
    { billId: 'uuid-1', textHash: 'hash-aaa' },
  );
  assert.equal(s.suppressed, false);
});
