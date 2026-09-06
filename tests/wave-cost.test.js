import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStage, weightedTotal, rawTotal } from '../scripts/wave-cost.mjs';

// Stage is recovered from the agent's own prompt because journal keys are content hashes with no
// label. These pin the discriminators that actually separate the stages - notably that re-authoring
// must NOT be read as authoring (it carries the AUTHOR banner too), and that the two completeness
// phases are distinguished by their phase number rather than by shared wording.
test('classifyStage: reauthor wins over author, both carry the AUTHOR banner', () => {
  assert.equal(classifyStage('You are the AUTHOR stage of VisibleGov, RE-AUTHORING a summary whose previous draft failed mechanical verification gates.'), 'reauthor');
  assert.equal(classifyStage('You are the AUTHOR stage of VisibleGov trust-model-v3.'), 'author');
});

test('classifyStage: the two completeness phases are told apart, not merged', () => {
  assert.equal(classifyStage('You are PHASE 1 (key provisions) of the completeness checker.'), 'provisions');
  assert.equal(classifyStage('You are PHASE 2 (coverage) of the completeness checker.'), 'coverage');
  assert.equal(classifyStage('You are the ADVERSARIAL VERIFIER stage.'), 'verify');
});

test('classifyStage: an unrecognised prompt is unclassified, never guessed into a stage', () => {
  // Failing loudly matters more than coverage: a mislabelled stage would send someone optimising
  // the wrong one, which is exactly the mistake this script exists to prevent.
  assert.equal(classifyStage('Read the manifest and return the bill list.'), 'unclassified');
  assert.equal(classifyStage(''), 'unclassified');
  assert.equal(classifyStage(null), 'unclassified');
});

test('weightedTotal prices cache reads at a tenth and output at five times', () => {
  const u = {
    input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 10,
  };
  // 100 + 100 + 250 + 50
  assert.equal(weightedTotal(u), 500);
  assert.equal(rawTotal(u), 1310);
});

test('weighting is what makes two waves comparable: same raw, different cache mix, different cost', () => {
  const cached = { input_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 0 };
  const fresh = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 0 };
  assert.equal(rawTotal(cached), rawTotal(fresh));
  assert.ok(weightedTotal(fresh) > weightedTotal(cached) * 10, 'a cache-miss wave must cost far more than a cache-hit wave of the same raw size');
});

test('missing usage fields are treated as zero rather than NaN', () => {
  assert.equal(weightedTotal({}), 0);
  assert.equal(rawTotal({}), 0);
});
