import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, planGlossing, persistGloss, GLOSS_COST_PER_TERM_USD } from '../src/cli/gloss.js';

// ---- planGlossing: the branched routing decision (mirrors extract-terms.js's planExtraction) ----

test('planGlossing routes a needs_mapping row to needsMapping, never to candidates', () => {
  const terms = [{ id: 't1', needs_mapping: true, gloss_md: null }];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.needsMapping.map((t) => t.id), ['t1']);
  assert.equal(plan.alreadyGlossed.length, 0);
  assert.equal(plan.candidates.length, 0);
});

test('planGlossing routes an already-glossed row (gloss_md set) to alreadyGlossed', () => {
  const terms = [{ id: 't1', needs_mapping: false, gloss_md: 'Already written.' }];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.alreadyGlossed.map((t) => t.id), ['t1']);
  assert.equal(plan.needsMapping.length, 0);
  assert.equal(plan.candidates.length, 0);
});

test('planGlossing routes a resolvable, ungloosed row to candidates', () => {
  const terms = [{ id: 't1', needs_mapping: false, gloss_md: null }];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.candidates.map((t) => t.id), ['t1']);
  assert.equal(plan.needsMapping.length, 0);
  assert.equal(plan.alreadyGlossed.length, 0);
});

test('planGlossing treats a gloss_md-set row as alreadyGlossed even if needs_mapping is (inconsistently) true — glossed status wins', () => {
  const terms = [{ id: 't1', needs_mapping: true, gloss_md: 'Written anyway.' }];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.alreadyGlossed.map((t) => t.id), ['t1']);
  assert.equal(plan.needsMapping.length, 0);
});

test('planGlossing partitions a mixed batch into all three mutually exclusive buckets', () => {
  const terms = [
    { id: 'mapped-done', needs_mapping: false, gloss_md: 'Done.' },
    { id: 'needs-mapping', needs_mapping: true, gloss_md: null },
    { id: 'candidate-1', needs_mapping: false, gloss_md: null },
    { id: 'candidate-2', needs_mapping: false, gloss_md: null },
  ];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.alreadyGlossed.map((t) => t.id), ['mapped-done']);
  assert.deepEqual(plan.needsMapping.map((t) => t.id), ['needs-mapping']);
  assert.deepEqual(plan.candidates.map((t) => t.id), ['candidate-1', 'candidate-2']);
});

test('planGlossing on an empty term list returns three empty buckets', () => {
  const plan = planGlossing([]);
  assert.deepEqual(plan, { needsMapping: [], alreadyGlossed: [], candidates: [] });
});

// ---- persistGloss: write order + retry-eligibility recovery (fix round 2, Important review
// finding) ----
//
// A minimal fake `client` — insert/update recorders only, no real Postgrest chain semantics
// needed since persistGloss's own logic (order, and bailing out after the first failure) is what
// these tests exercise, not Supabase itself. No model/network faking needed: persistGloss takes
// already-computed gloss/verdict data, deliberately factored out of glossOne for exactly this
// reason.
function makeFakeClient({ failTable = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        insert(row) {
          calls.push({ op: 'insert', table, row });
          if (table === failTable) return Promise.resolve({ error: { message: 'simulated transient network blip' } });
          return Promise.resolve({ error: null });
        },
        update(patch) {
          return {
            eq(col, val) {
              calls.push({ op: 'update', table, patch, col, val });
              if (table === failTable) return Promise.resolve({ error: { message: 'simulated transient network blip' } });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

const SAMPLE_GLOSS = {
  glossMd: 'The Secretary administers grants to States.',
  supportedByQuote: 'The Secretary shall administer grants to States.',
  sourceUrl: 'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title42-section1396b',
  sourceHash: 'abc123',
  verdicts: [{ bullet_index: 0, supported: true, reason: 'Matches the excerpt.', evidence_quote: 'The Secretary shall administer grants to States.' }],
  overall: 'clean',
};

test('persistGloss writes glossary_verifications BEFORE glossary_terms', async () => {
  const client = makeFakeClient();
  await persistGloss(client, 'run-1', { id: 'term-1' }, SAMPLE_GLOSS);
  assert.deepEqual(client.calls.map((c) => `${c.op}:${c.table}`), ['insert:glossary_verifications', 'update:glossary_terms']);
});

test('persistGloss includes supported_by_quote in the glossary_terms update payload (fix round 2, promoted Minor finding)', async () => {
  const client = makeFakeClient();
  await persistGloss(client, 'run-1', { id: 'term-1' }, SAMPLE_GLOSS);
  const updateCall = client.calls.find((c) => c.op === 'update');
  assert.equal(updateCall.patch.gloss_md, SAMPLE_GLOSS.glossMd);
  assert.equal(updateCall.patch.supported_by_quote, SAMPLE_GLOSS.supportedByQuote);
  assert.equal(updateCall.patch.source_url, SAMPLE_GLOSS.sourceUrl);
  assert.equal(updateCall.patch.source_hash, SAMPLE_GLOSS.sourceHash);
});

test('persistGloss: recovery — if glossary_verifications insert fails, glossary_terms is never touched, so gloss_md is never committed', async () => {
  const client = makeFakeClient({ failTable: 'glossary_verifications' });
  await assert.rejects(
    () => persistGloss(client, 'run-1', { id: 'term-1' }, SAMPLE_GLOSS),
    /glossary_verifications insert failed/,
  );
  // Only the failed insert was attempted — the glossary_terms update was never reached.
  assert.deepEqual(client.calls.map((c) => `${c.op}:${c.table}`), ['insert:glossary_verifications']);
});

test('persistGloss: recovery — simulated second-run retry. After a failed first run (verification insert failed), the term\'s gloss_md is still null in the DB, so planGlossing routes it back to candidates rather than alreadyGlossed', async () => {
  const client = makeFakeClient({ failTable: 'glossary_verifications' });
  await assert.rejects(() => persistGloss(client, 'run-1', { id: 'term-1' }, SAMPLE_GLOSS));

  // Simulates re-loading this exact row on the next run: gloss_md is still null in the DB,
  // because persistGloss's glossary_terms update was never reached (proven above).
  const termAsReloadedNextRun = { id: 'term-1', needs_mapping: false, gloss_md: null };
  const plan = planGlossing([termAsReloadedNextRun]);
  assert.deepEqual(plan.candidates.map((t) => t.id), ['term-1']);
  assert.equal(plan.alreadyGlossed.length, 0);
});

test('persistGloss: if glossary_terms update itself fails (verification already committed), the error is typed/thrown, never silent', async () => {
  const client = makeFakeClient({ failTable: 'glossary_terms' });
  await assert.rejects(
    () => persistGloss(client, 'run-1', { id: 'term-1' }, SAMPLE_GLOSS),
    /glossary_terms update failed/,
  );
  // Both writes were attempted, in order — the verification row exists even though this
  // particular retry's glossary_terms write failed (an accepted, honest edge: a retry may leave
  // an orphaned verification row rather than a permanently ungrounded gloss — the same shape
  // summary_verifications already tolerates in verify.js, which has no dedup guard either).
  assert.deepEqual(client.calls.map((c) => `${c.op}:${c.table}`), ['insert:glossary_verifications', 'update:glossary_terms']);
});

// ---- cost estimate constant (brief: "unique terms x ~$0.16 authoring+verify") ----

test('GLOSS_COST_PER_TERM_USD matches the plan\'s own estimate', () => {
  assert.equal(GLOSS_COST_PER_TERM_USD, 0.16);
});

// ---- parseArgs: same --dry-run shape as the other CLIs ----

test('parseArgs defaults dryRun to false and accepts --dry-run', () => {
  assert.equal(parseArgs([]).dryRun, false);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});
