import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planWork, wrapTextFormatError, persistReferencedTermsGracefully, createDraftSummary,
} from '../src/cli/summarize.js';
import { SourceFetchError } from '../src/lib/errors.js';

const bills = [{ id: 'b1', identifier: 'HR 1' }, { id: 'b2', identifier: 'HR 2' }, { id: 'b3', identifier: 'HR 3' }];
const texts = [{ bill_id: 'b2', content_hash: 'h2' }, { bill_id: 'b3', content_hash: 'h3-new' }];
const summaries = [{ bill_id: 'b3', bill_text_hash: 'h3-old', status: 'published' }];

test('planWork routes bills correctly', () => {
  const plan = planWork(bills, texts, summaries);
  assert.deepEqual(plan.needText.map((b) => b.id), ['b1']);
  assert.deepEqual(plan.needSummary.map((b) => b.id), ['b2', 'b3']);
  assert.deepEqual(plan.stale.map((s) => s.bill_id), ['b3']);
});

test('planWork skips bills already summarized at current hash', () => {
  const plan = planWork([bills[2]], [{ bill_id: 'b3', content_hash: 'h3-old' }], summaries);
  assert.equal(plan.needSummary.length, 0);
  assert.equal(plan.stale.length, 0);
});

test('planWork skips an approved summary at the current hash (routes nowhere)', () => {
  const approvedSummaries = [{ bill_id: 'b3', bill_text_hash: 'h3-old', status: 'approved' }];
  const plan = planWork([bills[2]], [{ bill_id: 'b3', content_hash: 'h3-old' }], approvedSummaries);
  assert.equal(plan.needSummary.length, 0);
  assert.equal(plan.stale.length, 0);
  assert.equal(plan.needText.length, 0);
});

test('wrapTextFormatError wraps a plain Error (e.g. pickTextUrl\'s "no fetchable text format") as a typed SourceFetchError', () => {
  const wrapped = wrapTextFormatError(new Error('no fetchable text format in text versions'));
  assert.ok(wrapped instanceof SourceFetchError);
  assert.equal(wrapped.source, 'us-congress');
  assert.match(wrapped.message, /no fetchable text format/);
});

test('wrapTextFormatError passes an already-typed SourceFetchError through unchanged', () => {
  const original = new SourceFetchError('network failure', { source: 'us-congress' });
  assert.equal(wrapTextFormatError(original), original);
});

// ---- fix wave (final review, Important finding 2): summarize.js persists json.referenced_terms
// via the exact same glossary-terms.js logic extract-terms.js's backfill uses, right after a
// draft summary row exists — and degrades gracefully, never crashing the summarize run, when
// glossary_terms/summary_terms don't exist yet (0007 unapplied). ----
//
// A minimal fake `client`: every builder method chains through to a single canned {data,error}
// result PER TABLE, regardless of which chain shape reached it (mirrors review-logic.test.js's
// own fakeQuery/fakeClient pattern) — enough to drive persistReferencedTerms' real upsert/
// find/insert call sequence without a live Postgrest instance. onCall, if given, records every
// (table, method, args) invocation so a test can assert on what was actually written, not just
// the canned result.
function fakeQuery(result, onCall) {
  const record = (method) => (...args) => { if (onCall) onCall(method, args); return builder; };
  const builder = {
    select: record('select'),
    eq: record('eq'),
    is: record('is'),
    in: record('in'),
    order: record('order'),
    limit: record('limit'),
    insert: record('insert'),
    update: record('update'),
    upsert: record('upsert'),
    maybeSingle: record('maybeSingle'),
    single: record('single'),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function fakeClient(resultsByTable, onCall) {
  return {
    from: (table) => fakeQuery(
      resultsByTable[table] ?? { data: null, error: null },
      onCall ? (method, args) => onCall(table, method, args) : undefined,
    ),
  };
}

const MISSING_RELATION_ERROR = (table) => ({
  code: 'PGRST205',
  message: `Could not find the table 'public.${table}' in the schema cache`,
});

test('persistReferencedTermsGracefully: a v2 summary\'s referenced_terms land as glossary stubs + a summary_terms join', async () => {
  const calls = [];
  const client = fakeClient({
    // Serves BOTH the upsertIfAbsent(kind,citation) upsert (only .error matters to it) AND
    // findExistingGlossaryTerm's select/maybeSingle (both .data and .error matter to it) — a real
    // missing relation would fail identically on every operation, so one canned result per table
    // is the honest shape to fake here, same as review-logic.test.js's own fakeClient.
    glossary_terms: { data: { id: 'term-abc' }, error: null },
    summary_terms: { data: null, error: null },
  }, (table, method, args) => calls.push({ table, method, args }));

  const result = await persistReferencedTermsGracefully(client, 'run-1', {
    bill: { identifier: 'HR 498' },
    summaryId: 'sum-1',
    referencedTerms: [{ term: 'Social Security Act', kind: 'act', citation_raw: '42 U.S.C. 1396b' }],
  });

  assert.deepEqual(result, { termsUpserted: 1, warning: null });
  // glossary_terms was upserted with the stub shape (draft, needs_mapping false — a resolvable
  // citation) ...
  const glossaryUpsert = calls.find((c) => c.table === 'glossary_terms' && c.method === 'upsert');
  assert.ok(glossaryUpsert, 'expected an upsert against glossary_terms');
  assert.equal(glossaryUpsert.args[0][0].term, 'Social Security Act');
  assert.equal(glossaryUpsert.args[0][0].citation, '42 U.S.C. 1396b');
  assert.equal(glossaryUpsert.args[0][0].needs_mapping, false);
  assert.equal(glossaryUpsert.args[0][0].status, 'draft');
  // ... and summary_terms was upserted with the join row linking this summary to that term.
  const joinUpsert = calls.find((c) => c.table === 'summary_terms' && c.method === 'upsert');
  assert.ok(joinUpsert, 'expected an upsert against summary_terms');
  assert.deepEqual(joinUpsert.args[0][0], { summary_id: 'sum-1', term_id: 'term-abc' });
});

test('persistReferencedTermsGracefully: with no referenced_terms, no glossary writes happen and it reports 0 upserted', async () => {
  const calls = [];
  const client = fakeClient({}, (table, method, args) => calls.push({ table, method, args }));
  const result = await persistReferencedTermsGracefully(client, 'run-1', {
    bill: { identifier: 'HR 1' }, summaryId: 'sum-1', referencedTerms: [],
  });
  assert.deepEqual(result, { termsUpserted: 0, warning: null });
  assert.equal(calls.length, 0);
});

test('persistReferencedTermsGracefully: missing glossary_terms relation (0007 unapplied) degrades to an honest, distinctly-kinded warning, never throws', async () => {
  const client = fakeClient({
    glossary_terms: { data: null, error: MISSING_RELATION_ERROR('glossary_terms') },
  });
  const result = await persistReferencedTermsGracefully(client, 'run-1', {
    bill: { identifier: 'HR 498' },
    summaryId: 'sum-1',
    referencedTerms: [{ term: 'Social Security Act', kind: 'act', citation_raw: '42 U.S.C. 1396b' }],
  });
  assert.equal(result.termsUpserted, 0);
  assert.equal(result.warning.kind, 'missing_relation');
  assert.equal(result.warning.term, null);
  assert.match(result.warning.message, /0007/);
  assert.match(result.warning.message, /HR 498/);
});

// ---- round 2 (Important finding 1 from the scoped re-review): round 1 only tolerated a
// missing-relation error and rethrew anything else — a batch-crash hazard the summary draft is
// supposed to be immune to (any glossary-side error, e.g. a unique-constraint race in
// upsertGlossaryTerm's manual by:'term' insert branch, or a transient connection error, would
// propagate out of createDraftSummary, miss FAILURE_TYPES at main()'s per-bill catch, hit the
// outer catch, and closeRun(..., 'failed') would OVERWRITE the run detail — discarding every
// count already accumulated for bills already processed). Fixed: this now catches ANY error. ----

test('persistReferencedTermsGracefully: an unrelated (non-missing-relation) DB error degrades to a distinctly-kinded warning too — nothing throws', async () => {
  const client = fakeClient({
    glossary_terms: { data: null, error: { code: '08006', message: 'connection failure' } },
  });
  const result = await persistReferencedTermsGracefully(client, 'run-1', {
    bill: { identifier: 'HR 498' },
    summaryId: 'sum-1',
    referencedTerms: [{ term: 'Social Security Act', kind: 'act', citation_raw: '42 U.S.C. 1396b' }],
  });
  assert.equal(result.termsUpserted, 0);
  assert.equal(result.warning.kind, 'persist_error');
  assert.match(result.warning.message, /connection failure/);
  // known — persistReferencedTerms tags the term it was working on when the error hit.
  assert.equal(result.warning.term, 'Social Security Act');
});

// ---- createDraftSummary: the CRITICAL constraint end-to-end — the summary draft itself must
// still succeed even when glossary persistence degrades. Exported specifically so this can be
// proven (see summarize.js's own comment on the export). ----

function fakeAnthropicSummary(referencedTerms) {
  return {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{
          type: 'text',
          text: JSON.stringify({
            what_it_does: [{ point: 'Does X.', section: 'Sec. 1' }],
            stated_purpose: '',
            classification: 'other',
            referenced_terms: referencedTerms,
          }),
        }],
      }),
    },
  };
}

test('createDraftSummary: the summary draft succeeds and its referenced_terms are persisted when glossary relations exist', async () => {
  const calls = [];
  const client = fakeClient({
    summaries: { data: { id: 'sum-1' }, error: null },
    glossary_terms: { data: { id: 'term-abc' }, error: null },
    summary_terms: { data: null, error: null },
  }, (table, method, args) => calls.push({ table, method, args }));

  const anthropic = fakeAnthropicSummary([{ term: 'Social Security Act', kind: 'act', citation_raw: '42 U.S.C. 1396b' }]);
  const bill = { id: 'b1', identifier: 'HR 498', title: 'Do No Harm' };
  const textRow = { content: 'SECTION 1. Text.', content_hash: 'h1' };

  const result = await createDraftSummary(client, 'run-1', { bill, textRow, anthropic });

  assert.deepEqual(result, { termsUpserted: 1, warning: null });
  const summaryInsert = calls.find((c) => c.table === 'summaries' && c.method === 'insert');
  assert.ok(summaryInsert, 'expected an insert against summaries');
  // .insert(obj) takes a plain row object (unlike .upsert([...]), which takes an array) — args[0]
  // is that object directly.
  assert.equal(summaryInsert.args[0].status, 'draft');
  assert.equal(summaryInsert.args[0].bill_id, 'b1');
});

test('createDraftSummary: the summary draft STILL SUCCEEDS when glossary_terms is missing (0007 unapplied) — honest warning, no crash', async () => {
  const client = fakeClient({
    summaries: { data: { id: 'sum-1' }, error: null },
    glossary_terms: { data: null, error: MISSING_RELATION_ERROR('glossary_terms') },
  });

  const anthropic = fakeAnthropicSummary([{ term: 'Social Security Act', kind: 'act', citation_raw: '42 U.S.C. 1396b' }]);
  const bill = { id: 'b1', identifier: 'HR 498', title: 'Do No Harm' };
  const textRow = { content: 'SECTION 1. Text.', content_hash: 'h1' };

  // Must NOT throw — the draft summary row above has already been inserted successfully by the
  // time glossary persistence is attempted, and that must never be undone by 0007 being missing.
  const result = await createDraftSummary(client, 'run-1', { bill, textRow, anthropic });
  assert.equal(result.termsUpserted, 0);
  assert.equal(result.warning.kind, 'missing_relation');
  assert.match(result.warning.message, /0007/);
});

test('createDraftSummary: a bill with no referenced_terms at all persists cleanly with zero warnings', async () => {
  const client = fakeClient({ summaries: { data: { id: 'sum-1' }, error: null } });
  const anthropic = fakeAnthropicSummary([]);
  const bill = { id: 'b1', identifier: 'HR 1', title: 'Some Bill' };
  const textRow = { content: 'SECTION 1. Text.', content_hash: 'h1' };
  const result = await createDraftSummary(client, 'run-1', { bill, textRow, anthropic });
  assert.deepEqual(result, { termsUpserted: 0, warning: null });
});

test('createDraftSummary: the summary draft STILL SUCCEEDS when term persistence hits a non-missing-relation error (round-2 Important finding 1)', async () => {
  const client = fakeClient({
    summaries: { data: { id: 'sum-1' }, error: null },
    glossary_terms: { data: null, error: { code: '08006', message: 'connection failure' } },
  });
  const anthropic = fakeAnthropicSummary([{ term: 'Social Security Act', kind: 'act', citation_raw: '42 U.S.C. 1396b' }]);
  const bill = { id: 'b1', identifier: 'HR 498', title: 'Do No Harm' };
  const textRow = { content: 'SECTION 1. Text.', content_hash: 'h1' };

  const result = await createDraftSummary(client, 'run-1', { bill, textRow, anthropic });
  assert.equal(result.termsUpserted, 0);
  assert.equal(result.warning.kind, 'persist_error');
  assert.match(result.warning.message, /connection failure/);
});

// ---- round 2's required proof: a non-missing-relation persist error on one bill never erases
// (or aborts processing of) another bill's already-recorded success. Reproduces main()'s own
// per-bill accumulation loop (src/cli/summarize.js) directly, since main() itself has no
// client-injection seam to test through — main() gets this behavior for free precisely BECAUSE
// createDraftSummary never throws for this class of error (proven above): its outer
// closeRun(..., 'failed') overwrite path is structurally unreachable for a glossary-persist
// failure alone. ----

test('batch loop over two bills: a non-missing-relation persist error on bill 2 never erases bill 1\'s success, and processing continues to bill 2\'s own summary', async () => {
  const client1 = fakeClient({
    summaries: { data: { id: 'sum-1' }, error: null },
    glossary_terms: { data: { id: 'term-abc' }, error: null },
    summary_terms: { data: null, error: null },
  });
  const client2 = fakeClient({
    summaries: { data: { id: 'sum-2' }, error: null },
    glossary_terms: { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "glossary_terms_kind_citation_key"' } },
  });

  const anthropic1 = fakeAnthropicSummary([{ term: 'Social Security Act', kind: 'act', citation_raw: '42 U.S.C. 1396b' }]);
  const anthropic2 = fakeAnthropicSummary([{ term: 'Some Program', kind: 'program', citation_raw: '42 U.S.C. 999' }]);

  const targets = [
    { bill: { id: 'b1', identifier: 'HR 1', title: 'Bill One' }, textRow: { content: 'T', content_hash: 'h1' }, client: client1, anthropic: anthropic1 },
    { bill: { id: 'b2', identifier: 'HR 2', title: 'Bill Two' }, textRow: { content: 'T', content_hash: 'h2' }, client: client2, anthropic: anthropic2 },
  ];

  // Mirrors src/cli/summarize.js's main() loop exactly (summariesCreated/glossaryTermsPersisted/
  // glossaryWarnings/failures accumulation, try/catch around createDraftSummary).
  let summariesCreated = 0;
  let glossaryTermsPersisted = 0;
  const glossaryWarnings = [];
  const failures = [];
  for (const { bill, textRow, client, anthropic } of targets) {
    try {
      const { termsUpserted, warning } = await createDraftSummary(client, 'run-1', { bill, textRow, anthropic });
      summariesCreated += 1;
      glossaryTermsPersisted += termsUpserted;
      if (warning) glossaryWarnings.push({ identifier: bill.identifier, warning });
    } catch (err) {
      failures.push({ identifier: bill.identifier, message: err.message });
    }
  }

  // Both summaries counted — bill 2's draft was never lost, and the loop never aborted early.
  assert.equal(summariesCreated, 2);
  // A glossary-persist error must never surface as a batch failure (that's the whole point).
  assert.equal(failures.length, 0);
  // Bill 1's term genuinely persisted; bill 2's did not (that's the simulated failure).
  assert.equal(glossaryTermsPersisted, 1);
  // The prior bill's success is intact in the run detail — not discarded by bill 2's warning.
  assert.equal(glossaryWarnings.length, 1);
  assert.equal(glossaryWarnings[0].identifier, 'HR 2');
  assert.equal(glossaryWarnings[0].warning.kind, 'persist_error');
  assert.match(glossaryWarnings[0].warning.message, /duplicate key/);
});
