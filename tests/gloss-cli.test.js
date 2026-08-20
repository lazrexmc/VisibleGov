import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, planGlossing, persistGloss, GLOSS_COST_PER_TERM_USD, loadAllTerms, FAILURE_TYPES,
  glossCandidates, failedRunDetail,
} from '../src/cli/gloss.js';
import { MoBotPageError, MoPageIdentityError } from '../src/adapters/mo-statutes.js';
import { QuoteNotVerbatimError } from '../src/lib/glosser.js';
import { SourceFetchError } from '../src/lib/errors.js';

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

test('planGlossing partitions a mixed batch into all four mutually exclusive buckets', () => {
  const terms = [
    { id: 'mapped-done', needs_mapping: false, gloss_md: 'Done.' },
    { id: 'needs-mapping', needs_mapping: true, gloss_md: null },
    { id: 'candidate-1', needs_mapping: false, gloss_md: null },
    { id: 'candidate-2', needs_mapping: false, gloss_md: null },
    { id: 'rejected-1', needs_mapping: false, gloss_md: null, status: 'rejected' },
  ];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.alreadyGlossed.map((t) => t.id), ['mapped-done']);
  assert.deepEqual(plan.needsMapping.map((t) => t.id), ['needs-mapping']);
  assert.deepEqual(plan.rejected.map((t) => t.id), ['rejected-1']);
  assert.deepEqual(plan.candidates.map((t) => t.id), ['candidate-1', 'candidate-2']);
});

// ---- FAILURE_TYPES pinning (Minor finding 4) ----
//
// Spec §4: receiving revisor.mo.gov's bot-detection page is a whole-run HARD STOP, not a
// counted-and-continued per-term failure — abort the run honestly, never retry-hammer past it.
// A page-identity mismatch (MoPageIdentityError) gets the same treatment: both must propagate
// uncaught through the CLI's per-term try/catch (isTypedFailure) and abort the batch, rather than
// being recorded in failures[] like the source-fetch/verification failure types that ARE listed.
// This pins that neither MO adapter's typed identity errors are ever added to FAILURE_TYPES.
test('FAILURE_TYPES does not include MoBotPageError or MoPageIdentityError — both are whole-run hard stops per spec §4, never counted-and-continued', () => {
  assert.ok(!FAILURE_TYPES.includes(MoBotPageError), 'MoBotPageError must abort the run, not be counted and continued');
  assert.ok(!FAILURE_TYPES.includes(MoPageIdentityError), 'MoPageIdentityError must abort the run, not be counted and continued');
});

test('planGlossing on an empty term list returns four empty buckets', () => {
  const plan = planGlossing([]);
  assert.deepEqual(plan, {
    needsMapping: [], alreadyGlossed: [], rejected: [], candidates: [],
  });
});

// ---- fix wave (Important finding 1): a rejected-but-never-glossed stub must never re-enter
// candidates — it would re-bill an author+verify call and write a gloss onto a row Lance already
// threw out as a bogus extraction. ----

test('planGlossing excludes a rejected, ungloosed stub from candidates — it lands in rejected instead', () => {
  const terms = [{ id: 'rejected-1', needs_mapping: false, gloss_md: null, status: 'rejected' }];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.rejected.map((t) => t.id), ['rejected-1']);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.needsMapping.length, 0);
  assert.equal(plan.alreadyGlossed.length, 0);
});

test('planGlossing: a rejected term that already has a gloss stays in alreadyGlossed (gloss_md check wins first) — the existing, separately-tracked no-re-gloss-path gap, not something this fix changes', () => {
  const terms = [{ id: 'rejected-glossed', needs_mapping: false, gloss_md: 'Already written.', status: 'rejected' }];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.alreadyGlossed.map((t) => t.id), ['rejected-glossed']);
  assert.equal(plan.rejected.length, 0);
});

test('planGlossing: a draft (non-rejected) stub with needs_mapping=false and no gloss is still a normal candidate', () => {
  const terms = [{ id: 'draft-1', needs_mapping: false, gloss_md: null, status: 'draft' }];
  const plan = planGlossing(terms);
  assert.deepEqual(plan.candidates.map((t) => t.id), ['draft-1']);
  assert.equal(plan.rejected.length, 0);
});

// main()'s --dry-run output maps `candidates` straight into the plan JSON it prints (id, term,
// kind, citation, status) — status is now included specifically so a reviewer can see, right at
// the cost-estimate approval gate, that nothing about to be billed is a rejected term. planGlossing
// is where that candidates array actually comes from, so proving status survives it unaltered here
// is what makes that dry-run field trustworthy — it is not a formatting-only concern.
test('planGlossing candidate rows carry status through unaltered, for the dry-run plan output', () => {
  const terms = [{ id: 't1', needs_mapping: false, gloss_md: null, status: 'draft' }];
  const plan = planGlossing(terms);
  assert.equal(plan.candidates[0].status, 'draft');
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

// ---- F6 (post-audit fix wave, 2026-08-19): gloss-abort observability ----
//
// A MoBotPageError is a whole-run HARD STOP by design (spec §4) — but its message names the SOURCE,
// not the term, so an aborted run's record used to leave no trace of which citation triggered it.
// The culprit must now ride on the error and reach the closeRun 'failed' detail.
test('a MoBotPageError-throwing fetch aborts the run AND the failure detail names the culprit term (F6)', async () => {
  const client = makeFakeClient();
  const term = { id: 'term-9', term: 'section 999.999', citation: 'RSMo 999.999' };
  const fetchSource = () => { throw new MoBotPageError('revisor.mo.gov returned its bot-detection page'); };

  await assert.rejects(
    () => glossCandidates(client, 'run-1', [term], null, { fetchSource }),
    (err) => {
      assert.ok(err instanceof MoBotPageError, 'the hard stop propagates untyped-as-failure, aborting the run');
      assert.deepEqual(err.term, { id: 'term-9', citation: 'RSMo 999.999' });
      const detail = failedRunDetail(err);
      assert.deepEqual(detail.term, { id: 'term-9', citation: 'RSMo 999.999' });
      assert.match(detail.error, /bot-detection page/);
      return true;
    },
  );
  assert.deepEqual(client.calls, [], 'nothing was written for a term that never produced a gloss');
});

test('failedRunDetail omits the term key entirely when an error carries no culprit (F6)', () => {
  assert.deepEqual(failedRunDetail(new Error('openRun blew up')), { error: 'Error: openRun blew up' });
});

test('glossCandidates still COUNTS a typed failure and continues to the next term — only untyped errors hard-stop (F6)', async () => {
  const client = makeFakeClient();
  const terms = [
    { id: 'term-1', term: 'section 1.010', citation: 'RSMo 1.010' },
    { id: 'term-2', term: 'section 2.020', citation: 'RSMo 2.020' },
  ];
  const fetchSource = (citation) => { throw new SourceFetchError(`network blip for ${citation}`); };
  const { glossed, flagged, failures } = await glossCandidates(client, 'run-1', terms, null, { fetchSource });
  assert.equal(glossed, 0);
  assert.equal(flagged, 0);
  assert.deepEqual(failures.map((f) => f.id), ['term-1', 'term-2']);
});

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

// ---- loadAllTerms (final-review finding 1 sweep, glossary-trust-surface): glossary_terms is the
// SAME growable table (401 live rows, growing with every summarized bill) auto-publish-glossary.js's
// loadDraftTerms reads — a truncated read here silently strands terms past the 1000-row cap as
// permanent bare stubs, never even considered by planGlossing. Same class of cap-enforcing fake as
// tests/auto-publish-glossary-cli.test.js's makeCappedGlossaryTermsClient — a fake that hands back
// its whole seeded dataset regardless of the requested range is exactly the shape that would hide
// this bug. ----

function makeCappedGlossaryTermsClient(allTerms, { serverCap = 1000, error = null } = {}) {
  const sorted = [...allTerms].sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return {
    from(table) {
      if (table !== 'glossary_terms') throw new Error(`unexpected table in this test: ${table}`);
      const builder = {
        select() { return this; },
        order() { return this; },
        range(from, to) {
          if (error) return Promise.resolve({ data: null, error });
          const size = Math.min(to - from + 1, serverCap);
          return Promise.resolve({ data: sorted.slice(from, from + size), error: null });
        },
      };
      return builder;
    },
  };
}

test('loadAllTerms: 1500 glossary_terms rows past the 1000-row server cap — every term comes back, including the newest (highest id), never silently stranded', async () => {
  const terms = Array.from({ length: 1500 }, (_, i) => ({
    id: `t-${String(i).padStart(4, '0')}`,
    term: `Term ${i}`,
    kind: 'statute',
    citation: 'c',
    gloss_md: null,
    needs_mapping: false,
    status: 'draft',
  }));
  const client = makeCappedGlossaryTermsClient(terms);
  const { terms: loaded, tableMissing } = await loadAllTerms(client, false);
  assert.equal(tableMissing, false);
  assert.equal(loaded.length, 1500, 'every term must come back, not just the first 1000-row page');
  assert.ok(loaded.some((t) => t.id === 't-1499'), 'the newest term must not be silently stranded past page 1');
});

test('loadAllTerms: dry-run tolerates a missing glossary_terms relation (migration 0007 not applied)', async () => {
  const client = makeCappedGlossaryTermsClient([], {
    error: { code: 'PGRST205', message: "Could not find the table 'public.glossary_terms' in the schema cache" },
  });
  const { terms, tableMissing } = await loadAllTerms(client, true);
  assert.equal(tableMissing, true);
  assert.deepEqual(terms, []);
});

test('loadAllTerms: a live (non-dry-run) missing-relation error still throws — migration 0007 is the real gate', async () => {
  const client = makeCappedGlossaryTermsClient([], {
    error: { code: 'PGRST205', message: "Could not find the table 'public.glossary_terms' in the schema cache" },
  });
  await assert.rejects(() => loadAllTerms(client, false), /glossary_terms lookup failed/);
});

// ---- QuoteNotVerbatimError: counted per-term failure, gated BEFORE any verify spend ----

test('FAILURE_TYPES includes QuoteNotVerbatimError — a bad receipt is a counted, retryable per-term failure', () => {
  assert.ok(FAILURE_TYPES.includes(QuoteNotVerbatimError));
});

test('glossCandidates: a non-verbatim supported_by_quote is counted as a failure, spends no verify call, writes nothing', async () => {
  const client = makeFakeClient();
  const term = { id: 'term-q', term: 'section 1.010', citation: 'RSMo 1.010' };
  const fetchSource = async () => ({ url: 'u', excerptText: 'the director shall hold a hearing within thirty days', hash: 'h' });
  const fakeAnthropic = {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ gloss_md: 'A sentence.', supported_by_quote: 'text the excerpt does not contain' }) }],
      }),
      stream: () => { throw new Error('verify must never be called for a gated receipt'); },
    },
  };
  const { glossed, flagged, failures } = await glossCandidates(client, 'run-1', [term], fakeAnthropic, { fetchSource });
  assert.equal(glossed, 0);
  assert.equal(flagged, 0);
  assert.deepEqual(failures.map((f) => f.id), ['term-q']);
  assert.deepEqual(client.calls, [], 'nothing persisted for a gated receipt');
});
