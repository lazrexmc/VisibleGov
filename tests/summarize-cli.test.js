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

test('persistReferencedTermsGracefully: missing glossary_terms relation (0007 unapplied) degrades to an honest warning, never throws', async () => {
  const client = fakeClient({
    glossary_terms: { data: null, error: MISSING_RELATION_ERROR('glossary_terms') },
  });
  const result = await persistReferencedTermsGracefully(client, 'run-1', {
    bill: { identifier: 'HR 498' },
    summaryId: 'sum-1',
    referencedTerms: [{ term: 'Social Security Act', kind: 'act', citation_raw: '42 U.S.C. 1396b' }],
  });
  assert.equal(result.termsUpserted, 0);
  assert.match(result.warning, /0007/);
  assert.match(result.warning, /HR 498/);
});

test('persistReferencedTermsGracefully: an unrelated (non-missing-relation) DB error still throws — not everything is swallowed', async () => {
  const client = fakeClient({
    glossary_terms: { data: null, error: { code: '08006', message: 'connection failure' } },
  });
  await assert.rejects(() => persistReferencedTermsGracefully(client, 'run-1', {
    bill: { identifier: 'HR 498' },
    summaryId: 'sum-1',
    referencedTerms: [{ term: 'Social Security Act', kind: 'act', citation_raw: '42 U.S.C. 1396b' }],
  }));
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
  assert.match(result.warning, /0007/);
});

test('createDraftSummary: a bill with no referenced_terms at all persists cleanly with zero warnings', async () => {
  const client = fakeClient({ summaries: { data: { id: 'sum-1' }, error: null } });
  const anthropic = fakeAnthropicSummary([]);
  const bill = { id: 'b1', identifier: 'HR 1', title: 'Some Bill' };
  const textRow = { content: 'SECTION 1. Text.', content_hash: 'h1' };
  const result = await createDraftSummary(client, 'run-1', { bill, textRow, anthropic });
  assert.deepEqual(result, { termsUpserted: 0, warning: null });
});
