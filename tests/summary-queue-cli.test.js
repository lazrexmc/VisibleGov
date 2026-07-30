import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, PASSAGE_QUESTION_RE, isPassageVote, planQueue, pickCurrentTextRow, loadPlanState,
  validateSummaryShape, checkCitationsPresent, classifyRecordItem, applyRecordDecision, recordOne,
  autoPublishSummary, MalformedSummaryError, TextHashMismatchError, MissingBillTextError,
} from '../src/cli/summary-queue.js';
import { MAX_TEXT_CHARS } from '../src/lib/summarizer.js';
import { InvalidFlagValueError } from '../src/lib/errors.js';

// ---- parseArgs ----

test('parseArgs requires a mode of plan or record', () => {
  assert.throws(() => parseArgs([]), /unknown mode/);
  assert.throws(() => parseArgs(['bogus']), /unknown mode/);
});

test('parseArgs: plan mode accepts --dry-run, --limit, --bill', () => {
  const out = parseArgs(['plan', '--limit', '5', '--bill', 'HR 1']);
  assert.equal(out.mode, 'plan');
  assert.equal(out.limit, 5);
  assert.equal(out.bill, 'HR 1');
  assert.equal(out.dryRun, false);
});

test('parseArgs: record mode requires --file', () => {
  assert.throws(() => parseArgs(['record']), /requires --file/);
  const out = parseArgs(['record', '--file', 'results.json']);
  assert.equal(out.mode, 'record');
  assert.equal(out.file, 'results.json');
});

test('parseArgs: record mode accepts --dry-run alongside --file', () => {
  const out = parseArgs(['record', '--file', 'x.json', '--dry-run']);
  assert.equal(out.dryRun, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['plan', '--bogus']), /unknown flag/);
});

// ---- isPassageVote / PASSAGE_QUESTION_RE ----

test('isPassageVote matches passage and third-reading questions, case-insensitively', () => {
  assert.ok(isPassageVote('On Passage'));
  assert.ok(isPassageVote('on passage of the bill'));
  assert.ok(isPassageVote('Third Reading'));
  assert.ok(isPassageVote('On Motion to Concur, Third Reading'));
});

test('isPassageVote does not match unrelated/procedural questions', () => {
  assert.equal(isPassageVote('On Motion to Table'), false);
  assert.equal(isPassageVote('On Agreeing to the Amendment'), false);
  assert.equal(isPassageVote(''), false);
  assert.equal(isPassageVote(null), false);
  assert.equal(isPassageVote(undefined), false);
});

test('PASSAGE_QUESTION_RE is the same regex isPassageVote uses', () => {
  assert.ok(PASSAGE_QUESTION_RE.test('Passage'));
});

// ---- fix round 1, Important finding 3: PASSAGE_QUESTION_RE against REAL corpus shapes, verbatim
// from repo fixtures — the original /passage|third reading/i regex matched neither. ----

test('isPassageVote matches the real MO LegiScan corpus shape verbatim (tests/fixtures/research/legiscan/mo-2018-rollcall-747209.json)', () => {
  assert.ok(isPassageVote('House: SB 894  SBs 3rd READ - INFORMAL'));
});

test('isPassageVote matches the real MO OpenStates motion_text shape verbatim (tests/fixtures/mo-legislature/bills-with-votes.json)', () => {
  assert.ok(isPassageVote('Third Read and Passed (H) -'));
  assert.ok(isPassageVote('Third Read and Passed (S) -'));
});

test('isPassageVote still matches the original clean-room forms after the regex widening', () => {
  assert.ok(isPassageVote('On Passage'));
  assert.ok(isPassageVote('Third Reading'));
});

// ---- planQueue ----

const bills = [
  { id: 'b1', identifier: 'HR 1', title: 'Bill One' },
  { id: 'b2', identifier: 'HR 2', title: 'Bill Two' },
  { id: 'b3', identifier: 'HR 3', title: 'Bill Three' },
  { id: 'b4', identifier: 'HR 4', title: 'Bill Four' },
  { id: 'b5', identifier: 'HR 5', title: 'Bill Five' },
];

test('planQueue: passage-vote bills sort before other bills; order preserved within each group', () => {
  const texts = bills.map((b) => ({ bill_id: b.id, content_hash: `h-${b.id}`, length: 100 }));
  const votes = [
    { bill_id: 'b1', question: 'On Agreeing to the Amendment' },
    { bill_id: 'b2', question: 'On Passage' },
    { bill_id: 'b3', question: 'On Motion to Table' },
    { bill_id: 'b4', question: 'Third Reading' },
    { bill_id: 'b5', question: 'On Motion to Table' },
  ];
  const { queue } = planQueue(bills, texts, [], votes);
  assert.deepEqual(queue.map((q) => q.bill_id), ['b2', 'b4', 'b1', 'b3', 'b5']);
  assert.equal(queue.find((q) => q.bill_id === 'b2').priority, 'passage');
  assert.equal(queue.find((q) => q.bill_id === 'b1').priority, 'other');
});

test('planQueue: excludes bills with no current text, honestly bucketed as noText', () => {
  const texts = [{ bill_id: 'b1', content_hash: 'h1', length: 100 }];
  const { queue, excluded } = planQueue(bills.slice(0, 2), texts, [], []);
  assert.deepEqual(queue.map((q) => q.bill_id), ['b1']);
  assert.deepEqual(excluded.noText.map((e) => e.bill_id), ['b2']);
});

test('planQueue: excludes oversize text (length > MAX_TEXT_CHARS), never truncates silently', () => {
  const texts = [
    { bill_id: 'b1', content_hash: 'h1', length: 100 },
    { bill_id: 'b2', content_hash: 'h2', length: MAX_TEXT_CHARS + 1 },
  ];
  const { queue, excluded } = planQueue(bills.slice(0, 2), texts, [], []);
  assert.deepEqual(queue.map((q) => q.bill_id), ['b1']);
  assert.deepEqual(excluded.oversize, [{ bill_id: 'b2', identifier: 'HR 2', length: MAX_TEXT_CHARS + 1 }]);
});

test('planQueue: excludes a bill already summarized (draft/approved/published) at the current text hash', () => {
  const texts = [{ bill_id: 'b1', content_hash: 'h1', length: 100 }];
  for (const status of ['draft', 'approved', 'published']) {
    const summaries = [{ bill_id: 'b1', bill_text_hash: 'h1', status }];
    const { queue, excluded } = planQueue([bills[0]], texts, summaries, []);
    assert.equal(queue.length, 0, `status ${status} should exclude`);
    assert.deepEqual(excluded.alreadySummarized.map((e) => e.bill_id), ['b1']);
  }
});

test('planQueue: a rejected summary at the current hash is still eligible (re-queued, not excluded)', () => {
  const texts = [{ bill_id: 'b1', content_hash: 'h1', length: 100 }];
  const summaries = [{ bill_id: 'b1', bill_text_hash: 'h1', status: 'rejected' }];
  const { queue, excluded } = planQueue([bills[0]], texts, summaries, []);
  assert.deepEqual(queue.map((q) => q.bill_id), ['b1']);
  assert.equal(excluded.alreadySummarized.length, 0);
});

test('planQueue: a summary whose hash no longer matches the current text is still eligible (stale text, needs redo)', () => {
  const texts = [{ bill_id: 'b1', content_hash: 'h1-new', length: 100 }];
  const summaries = [{ bill_id: 'b1', bill_text_hash: 'h1-old', status: 'published' }];
  const { queue, excluded } = planQueue([bills[0]], texts, summaries, []);
  assert.deepEqual(queue.map((q) => q.bill_id), ['b1']);
  assert.equal(excluded.alreadySummarized.length, 0);
});

test('planQueue: mixed batch partitions exhaustively — every bill lands in exactly one bucket', () => {
  const texts = [
    { bill_id: 'b1', content_hash: 'h1', length: 100 }, // queued, passage
    { bill_id: 'b3', content_hash: 'h3', length: MAX_TEXT_CHARS + 1 }, // oversize
    { bill_id: 'b4', content_hash: 'h4', length: 100 }, // already summarized
    // b2: no text at all
    { bill_id: 'b5', content_hash: 'h5', length: 100 }, // queued, other
  ];
  const summaries = [{ bill_id: 'b4', bill_text_hash: 'h4', status: 'published' }];
  const votes = [{ bill_id: 'b1', question: 'On Passage' }];
  const { queue, excluded } = planQueue(bills, texts, summaries, votes);
  assert.deepEqual(queue.map((q) => q.bill_id).sort(), ['b1', 'b5']);
  assert.deepEqual(excluded.noText.map((e) => e.bill_id), ['b2']);
  assert.deepEqual(excluded.oversize.map((e) => e.bill_id), ['b3']);
  assert.deepEqual(excluded.alreadySummarized.map((e) => e.bill_id), ['b4']);
});

test('planQueue: empty input returns an empty queue and empty exclusion buckets', () => {
  const { queue, excluded } = planQueue([], [], [], []);
  assert.deepEqual(queue, []);
  assert.deepEqual(excluded, { alreadySummarized: [], noText: [], oversize: [] });
});

// ---- pickCurrentTextRow ----

test('pickCurrentTextRow: picks the most-recently-retrieved row', () => {
  const rows = [
    { content_hash: 'old', retrieved_at: '2026-01-01T00:00:00Z' },
    { content_hash: 'new', retrieved_at: '2026-01-03T00:00:00Z' },
    { content_hash: 'mid', retrieved_at: '2026-01-02T00:00:00Z' },
  ];
  assert.equal(pickCurrentTextRow(rows).content_hash, 'new');
});

test('pickCurrentTextRow: null on empty/absent input', () => {
  assert.equal(pickCurrentTextRow([]), null);
  assert.equal(pickCurrentTextRow(null), null);
});

// ---- validateSummaryShape ----

function validSummary(overrides = {}) {
  return {
    what_it_does: [{ point: 'Does X.', section: 'Sec. 1' }],
    stated_purpose: '',
    classification: 'other',
    referenced_terms: [],
    ...overrides,
  };
}

test('validateSummaryShape: a well-formed summary passes (null = valid)', () => {
  assert.equal(validateSummaryShape(validSummary()), null);
});

test('validateSummaryShape: rejects non-object input', () => {
  assert.match(validateSummaryShape(null), /must be a JSON object/);
  assert.match(validateSummaryShape('nope'), /must be a JSON object/);
  assert.match(validateSummaryShape([]), /must be a JSON object/);
});

test('validateSummaryShape: rejects an unexpected top-level field', () => {
  assert.match(validateSummaryShape(validSummary({ extra_field: 'x' })), /unexpected field: extra_field/);
});

test('validateSummaryShape: rejects a missing required field', () => {
  const s = validSummary();
  delete s.classification;
  assert.match(validateSummaryShape(s), /missing required field: classification/);
});

test('validateSummaryShape: rejects a bad classification enum value', () => {
  assert.match(validateSummaryShape(validSummary({ classification: 'bogus' })), /classification must be one of/);
});

test('validateSummaryShape: rejects a what_it_does bullet with an unexpected field', () => {
  const s = validSummary({ what_it_does: [{ point: 'X', section: 'Sec. 1', extra: 'y' }] });
  assert.match(validateSummaryShape(s), /what_it_does\[0\] has an unexpected field: extra/);
});

test('validateSummaryShape: rejects an empty/whitespace point', () => {
  assert.match(validateSummaryShape(validSummary({ what_it_does: [{ point: '  ', section: 'Sec. 1' }] })), /point must be a non-empty string/);
});

test('validateSummaryShape: rejects a non-string section', () => {
  assert.match(validateSummaryShape(validSummary({ what_it_does: [{ point: 'X', section: 5 }] })), /section must be a string/);
});

test('validateSummaryShape: rejects a bad referenced_terms.kind enum value', () => {
  const s = validSummary({ referenced_terms: [{ term: 'X Act', kind: 'bogus', citation_raw: '' }] });
  assert.match(validateSummaryShape(s), /kind must be one of/);
});

test('validateSummaryShape: rejects a non-string citation_raw', () => {
  const s = validSummary({ referenced_terms: [{ term: 'X Act', kind: 'act', citation_raw: null }] });
  assert.match(validateSummaryShape(s), /citation_raw must be a string/);
});

test('validateSummaryShape: an empty citation_raw string is VALID (the schema explicitly allows it)', () => {
  const s = validSummary({ referenced_terms: [{ term: 'X Act', kind: 'act', citation_raw: '' }] });
  assert.equal(validateSummaryShape(s), null);
});

test('validateSummaryShape: rejects what_it_does that is not an array', () => {
  assert.match(validateSummaryShape(validSummary({ what_it_does: 'nope' })), /what_it_does must be an array/);
});

// ---- checkCitationsPresent ----

test('checkCitationsPresent: passes when every bullet has a non-empty section', () => {
  assert.doesNotThrow(() => checkCitationsPresent([{ point: 'X', section: 'Sec. 1' }, { point: 'Y', section: 'Sec. 2' }]));
});

// ---- fix round 1, CRITICAL finding 1: an empty what_it_does array vacuously satisfies both this
// function's own missingAt loop and assessVerdicts' zero-bullets/zero-verdicts "clean" case — a
// {what_it_does: [], verdicts: []} payload must be rejected here, before assessVerdicts ever runs,
// never silently treated as a zero-content "clean" summary. ----

test('checkCitationsPresent: throws MalformedSummaryError on an empty what_it_does array (the reviewer\'s exact vacuous-empty shape)', () => {
  assert.throws(() => checkCitationsPresent([]), (err) => {
    assert.ok(err instanceof MalformedSummaryError);
    assert.match(err.message, /zero what_it_does bullets/);
    return true;
  });
});

test('checkCitationsPresent: throws on null/undefined what_it_does too, not just []', () => {
  assert.throws(() => checkCitationsPresent(null), MalformedSummaryError);
  assert.throws(() => checkCitationsPresent(undefined), MalformedSummaryError);
});

test('checkCitationsPresent: throws MalformedSummaryError naming the missing indices', () => {
  const bullets = [{ point: 'X', section: 'Sec. 1' }, { point: 'Y', section: '' }, { point: 'Z', section: '   ' }];
  assert.throws(() => checkCitationsPresent(bullets), (err) => {
    assert.ok(err instanceof MalformedSummaryError);
    assert.match(err.message, /2 bullet/);
    assert.deepEqual(err.missingAt, [1, 2]);
    return true;
  });
});

// ---- classifyRecordItem / applyRecordDecision / recordOne: fake-client DB layer ----
// Mirrors summarize-cli.test.js's own fakeQuery/fakeClient pattern: one canned {data,error} result
// per table, chained through every builder method regardless of shape.

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

// BILL_TEXT_CONTENT — the hash-pinned stored bill text every record-mode fixture below is
// summarized FROM. Final whole-branch review, finding 5: the record gate now re-reads this content
// and requires a non-empty stated_purpose to be a verbatim (whitespace-normalized) substring of it,
// so a fixture that omits the content is a fixture asserting "we cannot verify the stated purpose"
// — which is exactly the flag path, not the publish path. goodSummary's stated_purpose is printed
// here verbatim, the way a real bill's own purpose section would be.
const BILL_TEXT_CONTENT = 'SEC. 1. Does X.\nSEC. 2. Does Y.\n\nPURPOSE.—To do X and Y.\n';

const textRow = (contentHash = 'h1', retrievedAt = '2026-01-01T00:00:00Z') => ({
  content: BILL_TEXT_CONTENT, content_hash: contentHash, retrieved_at: retrievedAt,
});

const goodSummary = () => ({
  what_it_does: [{ point: 'Does X.', section: 'Sec. 1' }, { point: 'Does Y.', section: 'Sec. 2' }],
  stated_purpose: 'To do X and Y.',
  classification: 'other',
  referenced_terms: [{ term: 'Some Act', kind: 'act', citation_raw: '' }],
});

function goodVerdicts(overrides = []) {
  const base = [
    { bullet_index: 0, section: 'Sec. 1', supported: true, reason: 'ok', evidence_quote: 'q1' },
    { bullet_index: 1, section: 'Sec. 2', supported: true, reason: 'ok', evidence_quote: 'q2' },
  ];
  return overrides.length ? overrides : base;
}

function baseItem(overrides = {}) {
  return {
    bill_id: 'b1',
    bill_text_hash: 'h1',
    summary: goodSummary(),
    verdicts: goodVerdicts(),
    ...overrides,
  };
}

test('classifyRecordItem: throws MalformedSummaryError for a missing bill_id, before any DB call', async () => {
  const client = fakeClient({}, () => assert.fail('no DB call should happen for a malformed envelope'));
  await assert.rejects(() => classifyRecordItem(client, { bill_text_hash: 'h1', summary: goodSummary() }), MalformedSummaryError);
});

test('classifyRecordItem: throws MalformedSummaryError for a summary that fails schema-shape validation', async () => {
  const client = fakeClient({});
  await assert.rejects(() => classifyRecordItem(client, baseItem({ summary: { bogus: true } })), MalformedSummaryError);
});

test('classifyRecordItem: throws MalformedSummaryError for a bullet with no cited section', async () => {
  const client = fakeClient({});
  const summary = goodSummary();
  summary.what_it_does[0].section = '';
  await assert.rejects(() => classifyRecordItem(client, baseItem({ summary })), MalformedSummaryError);
});

test('classifyRecordItem: the reviewer\'s exact vacuous-empty payload ({what_it_does: [], verdicts: []}) is a typed reject, zero writes attempted', async () => {
  const client = fakeClient({}, () => assert.fail('no DB call should happen — the empty-bullets reject fires before any read'));
  const summary = {
    what_it_does: [], stated_purpose: '', classification: 'other', referenced_terms: [],
  };
  await assert.rejects(
    () => classifyRecordItem(client, baseItem({ summary, verdicts: [] })),
    MalformedSummaryError,
  );
});

test('classifyRecordItem: throws MissingBillTextError when no bill_texts row exists for the bill', async () => {
  const client = fakeClient({ bill_texts: { data: [], error: null } });
  await assert.rejects(() => classifyRecordItem(client, baseItem()), MissingBillTextError);
});

test('classifyRecordItem: throws TextHashMismatchError when the claimed hash does not match the current stored text', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow('h1-DIFFERENT')], error: null },
  });
  await assert.rejects(
    () => classifyRecordItem(client, baseItem()),
    (err) => {
      assert.ok(err instanceof TextHashMismatchError);
      assert.equal(err.claimedHash, 'h1');
      assert.equal(err.currentHash, 'h1-DIFFERENT');
      return true;
    },
  );
});

test('classifyRecordItem: hash check uses the MOST RECENT bill_texts row when several exist', async () => {
  const client = fakeClient({
    bill_texts: {
      data: [
        textRow('h1-old', '2026-01-01T00:00:00Z'),
        textRow('h1', '2026-01-05T00:00:00Z'),
      ],
      error: null,
    },
    summaries: { data: [], error: null },
  });
  const decision = await classifyRecordItem(client, baseItem());
  assert.equal(decision.action, 'publish');
});

test('classifyRecordItem: alreadySummarized (draft/approved/published) at the matching hash short-circuits, no summary write attempted', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow()], error: null },
    summaries: { data: [{ id: 'sum-existing', status: 'approved', bill_text_hash: 'h1' }], error: null },
  });
  const decision = await classifyRecordItem(client, baseItem());
  assert.deepEqual(decision, {
    action: 'alreadySummarized', billId: 'b1', identifier: 'b1', summaryId: 'sum-existing',
  });
});

test('classifyRecordItem: a REJECTED existing summary at the same hash does NOT block — proceeds to a write decision', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow()], error: null },
    summaries: { data: [{ id: 'sum-old', status: 'rejected', bill_text_hash: 'h1' }], error: null },
  });
  const decision = await classifyRecordItem(client, baseItem());
  assert.equal(decision.action, 'publish');
});

test('classifyRecordItem: complete verdicts, all supported -> action publish, overall clean', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow()], error: null },
    summaries: { data: [], error: null },
  });
  const decision = await classifyRecordItem(client, baseItem());
  assert.equal(decision.action, 'publish');
  assert.equal(decision.overall, 'clean');
});

test('classifyRecordItem: complete verdicts, one unsupported -> action flagDraft, overall flagged', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow()], error: null },
    summaries: { data: [], error: null },
  });
  const verdicts = [
    { bullet_index: 0, section: 'Sec. 1', supported: true, reason: 'ok', evidence_quote: 'q1' },
    { bullet_index: 1, section: 'Sec. 2', supported: false, reason: 'not supported', evidence_quote: 'q2' },
  ];
  const decision = await classifyRecordItem(client, baseItem({ verdicts }));
  assert.equal(decision.action, 'flagDraft');
  assert.equal(decision.overall, 'flagged');
});

test('classifyRecordItem: missing/incomplete verdicts -> action leaveUnverified, NEVER trusting a self-reported overall', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow()], error: null },
    summaries: { data: [], error: null },
  });
  for (const badVerdicts of [undefined, null, [], [{ bullet_index: 0, supported: true }]]) {
    const decision = await classifyRecordItem(client, baseItem({ verdicts: badVerdicts }));
    assert.equal(decision.action, 'leaveUnverified', `expected leaveUnverified for verdicts=${JSON.stringify(badVerdicts)}`);
  }
});

test('classifyRecordItem: default author/verifier model labels come from summarizer.js/verifier.js constants; explicit overrides are respected', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow()], error: null },
    summaries: { data: [], error: null },
  });
  const d1 = await classifyRecordItem(client, baseItem());
  assert.equal(d1.authorModelLabel, 'subagent:claude-opus-5');
  assert.equal(d1.verifierModelLabel, 'subagent:claude-sonnet-5');

  const d2 = await classifyRecordItem(client, baseItem({ author_model: 'claude-opus-5-preview', verifier_model: 'claude-sonnet-5-preview' }));
  assert.equal(d2.authorModelLabel, 'subagent:claude-opus-5-preview');
  assert.equal(d2.verifierModelLabel, 'subagent:claude-sonnet-5-preview');
});

// ---- fix round 1, Important finding 2: author_model/verifier_model format is validated, not just
// defaulted. An empty string used to slip past `?? MODEL` (which only falls back on null/
// undefined) and produce a provenance label of the bare string 'subagent:'; an already-prefixed
// value used to double-prefix to 'subagent:subagent:...'. Both are now typed, pre-write rejects. ----

test('classifyRecordItem: rejects an empty-string author_model (would otherwise produce provenance "subagent:")', async () => {
  const client = fakeClient({}, () => assert.fail('no DB call should happen for a malformed envelope'));
  await assert.rejects(
    () => classifyRecordItem(client, baseItem({ author_model: '' })),
    (err) => { assert.ok(err instanceof MalformedSummaryError); assert.match(err.message, /author_model/); return true; },
  );
});

test('classifyRecordItem: rejects an empty-string verifier_model', async () => {
  const client = fakeClient({}, () => assert.fail('no DB call should happen for a malformed envelope'));
  await assert.rejects(
    () => classifyRecordItem(client, baseItem({ verifier_model: '' })),
    (err) => { assert.ok(err instanceof MalformedSummaryError); assert.match(err.message, /verifier_model/); return true; },
  );
});

test('classifyRecordItem: rejects an author_model already carrying the \'subagent:\' prefix (reviewer repro: double-prefix)', async () => {
  const client = fakeClient({}, () => assert.fail('no DB call should happen for a malformed envelope'));
  await assert.rejects(
    () => classifyRecordItem(client, baseItem({ author_model: 'subagent:claude-opus-5' })),
    (err) => { assert.ok(err instanceof MalformedSummaryError); assert.match(err.message, /author_model/); assert.match(err.message, /prefix/); return true; },
  );
});

test('classifyRecordItem: rejects a verifier_model already carrying the \'subagent:\' prefix', async () => {
  const client = fakeClient({}, () => assert.fail('no DB call should happen for a malformed envelope'));
  await assert.rejects(
    () => classifyRecordItem(client, baseItem({ verifier_model: 'subagent:claude-sonnet-5' })),
    (err) => { assert.ok(err instanceof MalformedSummaryError); assert.match(err.message, /verifier_model/); assert.match(err.message, /prefix/); return true; },
  );
});

// ---- applyRecordDecision: write shapes ----

test('applyRecordDecision: alreadySummarized performs no writes', async () => {
  const calls = [];
  const client = fakeClient({}, (table, method, args) => calls.push({ table, method, args }));
  const result = await applyRecordDecision(client, 'run-1', { action: 'alreadySummarized', billId: 'b1', summaryId: 'sum-existing' });
  assert.deepEqual(result, {
    outcome: 'alreadySummarized', billId: 'b1', summaryId: 'sum-existing', termsUpserted: 0, warning: null,
  });
  assert.equal(calls.length, 0);
});

function writeDecision(action, overrides = {}) {
  return {
    action,
    billId: 'b1',
    identifier: 'HR 1',
    claimedHash: 'h1',
    markdown: '**What it does:**\n- Does X. (Sec. 1)',
    authorModelLabel: 'subagent:claude-opus-5',
    verifierModelLabel: 'subagent:claude-sonnet-5',
    referencedTerms: [],
    verdicts: goodVerdicts(),
    overall: action === 'flagDraft' ? 'flagged' : 'clean',
    ...overrides,
  };
}

test('applyRecordDecision: publish inserts a draft summary, a clean verification row, then auto-publishes (approve+published note, publish+published_at)', async () => {
  const calls = [];
  const client = fakeClient({
    summaries: { data: { id: 'sum-1' }, error: null },
  }, (table, method, args) => calls.push({ table, method, args }));

  const result = await applyRecordDecision(client, 'run-1', writeDecision('publish'));
  assert.equal(result.outcome, 'published');
  assert.equal(result.summaryId, 'sum-1');

  const summaryInsert = calls.find((c) => c.table === 'summaries' && c.method === 'insert');
  assert.equal(summaryInsert.args[0].status, 'draft');
  assert.equal(summaryInsert.args[0].model, 'subagent:claude-opus-5');
  assert.equal(summaryInsert.args[0].bill_text_hash, 'h1');
  assert.equal(summaryInsert.args[0].run_id, 'run-1');

  const verInsert = calls.find((c) => c.table === 'summary_verifications' && c.method === 'insert');
  assert.ok(verInsert, 'expected a summary_verifications insert');
  assert.equal(verInsert.args[0].overall, 'clean');
  assert.equal(verInsert.args[0].summary_id, 'sum-1');
  assert.equal(verInsert.args[0].model, 'subagent:claude-sonnet-5');

  const statusUpdates = calls.filter((c) => c.table === 'summaries' && c.method === 'update');
  assert.deepEqual(statusUpdates.map((u) => u.args[0].status), ['approved', 'published']);
  assert.ok(statusUpdates[1].args[0].published_at);
  assert.equal(statusUpdates[0].args[0].published_at, undefined);

  const notes = calls.filter((c) => c.table === 'summary_notes' && c.method === 'insert');
  assert.deepEqual(notes.map((n) => n.args[0].action), ['approved', 'published']);
});

test('applyRecordDecision: flagDraft inserts a draft summary + a flagged verification row, and NEVER auto-publishes', async () => {
  const calls = [];
  const client = fakeClient({
    summaries: { data: { id: 'sum-1' }, error: null },
  }, (table, method, args) => calls.push({ table, method, args }));

  const result = await applyRecordDecision(client, 'run-1', writeDecision('flagDraft'));
  assert.equal(result.outcome, 'flaggedDraft');

  const verInsert = calls.find((c) => c.table === 'summary_verifications' && c.method === 'insert');
  assert.equal(verInsert.args[0].overall, 'flagged');

  const statusUpdates = calls.filter((c) => c.table === 'summaries' && c.method === 'update');
  assert.equal(statusUpdates.length, 0, 'a flagged summary must stay in draft — no auto-publish');
  const notes = calls.filter((c) => c.table === 'summary_notes' && c.method === 'insert');
  assert.equal(notes.length, 0);
});

test('applyRecordDecision: leaveUnverified inserts a draft summary ONLY — no verification row, no status update', async () => {
  const calls = [];
  const client = fakeClient({
    summaries: { data: { id: 'sum-1' }, error: null },
  }, (table, method, args) => calls.push({ table, method, args }));

  const result = await applyRecordDecision(client, 'run-1', writeDecision('leaveUnverified'));
  assert.equal(result.outcome, 'unverifiedDraft');

  assert.equal(calls.filter((c) => c.table === 'summary_verifications').length, 0);
  assert.equal(calls.filter((c) => c.table === 'summaries' && c.method === 'update').length, 0);
  const summaryInsert = calls.find((c) => c.table === 'summaries' && c.method === 'insert');
  assert.equal(summaryInsert.args[0].status, 'draft');
});

test('applyRecordDecision: referenced_terms persist via the summarize.js precedent (glossary_terms + summary_terms writes)', async () => {
  const calls = [];
  const client = fakeClient({
    summaries: { data: { id: 'sum-1' }, error: null },
    glossary_terms: { data: { id: 'term-abc' }, error: null },
    summary_terms: { data: null, error: null },
  }, (table, method, args) => calls.push({ table, method, args }));

  const result = await applyRecordDecision(client, 'run-1', writeDecision('publish', {
    // A resolvable citation (parseCitation succeeds) exercises glossary-terms.js's
    // insertIfAbsent-upsert branch, same as summarize-cli.test.js's own equivalent test — an
    // unresolvable citation takes the manual find-or-insert branch instead (no upsert call at
    // all when a match is found), which isn't what this test is proving.
    referencedTerms: [{ term: 'Social Security Act', kind: 'act', citation_raw: '42 U.S.C. 1396b' }],
  }));
  assert.equal(result.termsUpserted, 1);
  assert.equal(result.warning, null);
  assert.ok(calls.some((c) => c.table === 'glossary_terms' && c.method === 'upsert'));
  assert.ok(calls.some((c) => c.table === 'summary_terms' && c.method === 'upsert'));
});

test('applyRecordDecision: a glossary-persist failure NEVER blocks the summary/verification/publish writes (summarize.js CRITICAL constraint carries over)', async () => {
  const client = fakeClient({
    summaries: { data: { id: 'sum-1' }, error: null },
    glossary_terms: { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.glossary_terms' in the schema cache" } },
  });
  const result = await applyRecordDecision(client, 'run-1', writeDecision('publish', {
    referencedTerms: [{ term: 'Some Act', kind: 'act', citation_raw: '' }],
  }));
  assert.equal(result.outcome, 'published');
  assert.equal(result.warning.kind, 'missing_relation');
});

// ---- autoPublishSummary: write order ----

function makeHappySummaryClient() {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        update(patch) {
          return { eq: (col, val) => { calls.push({ op: 'update', table, patch, col, val }); return Promise.resolve({ error: null }); } };
        },
        insert(row) {
          calls.push({ op: 'insert', table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

test('autoPublishSummary: write order is approve-update, approve-note, publish-update, publish-note', async () => {
  const client = makeHappySummaryClient();
  await autoPublishSummary(client, 'sum-1', 'subagent:claude-sonnet-5');
  assert.deepEqual(
    client.calls.map((c) => `${c.op}:${c.table}:${c.op === 'update' ? c.patch.status : c.row.action}`),
    ['update:summaries:approved', 'insert:summary_notes:approved', 'update:summaries:published', 'insert:summary_notes:published'],
  );
  const notes = client.calls.filter((c) => c.op === 'insert' && c.table === 'summary_notes');
  assert.match(notes[0].row.note, /trust-model v3/);
  assert.match(notes[0].row.note, /auto-approved/);
  assert.match(notes[0].row.note, /subagent:claude-sonnet-5/);
  assert.match(notes[1].row.note, /auto-published/);
});

// ---- recordOne: idempotency end-to-end with a stateful fake client ----

function makeStatefulRecordClient() {
  const state = {
    bill_texts: [{ bill_id: 'b1', ...textRow() }],
    summaries: [],
    summary_verifications: [],
    summary_notes: [],
    glossary_terms: [],
    summary_terms: [],
  };
  let nextId = 1;
  return {
    state,
    from(table) {
      if (table === 'bill_texts') {
        let filterVal;
        const builder = {
          select: () => builder,
          eq: (col, val) => { filterVal = val; return builder; },
          then: (resolve) => resolve({ data: state.bill_texts.filter((r) => r.bill_id === filterVal), error: null }),
        };
        return builder;
      }
      if (table === 'summaries') {
        const builder = {
          _filters: [],
          select() { return this; },
          eq(col, val) { this._filters.push([col, val]); return this; },
          then(resolve) {
            let rows = state.summaries;
            for (const [c, v] of this._filters) rows = rows.filter((r) => r[c] === v);
            resolve({ data: rows.map((r) => ({ ...r })), error: null });
          },
          insert(row) {
            const id = `sum-${nextId}`; nextId += 1;
            state.summaries.push({ id, ...row });
            return { select: () => ({ single: () => Promise.resolve({ data: { id }, error: null }) }) };
          },
          update(patch) {
            return { eq: (col, val) => { const row = state.summaries.find((r) => r[col] === val); if (row) Object.assign(row, patch); return Promise.resolve({ error: null }); } };
          },
        };
        return builder;
      }
      if (table === 'summary_verifications') {
        return { insert(row) { state.summary_verifications.push(row); return Promise.resolve({ error: null }); } };
      }
      if (table === 'summary_notes') {
        return { insert(row) { state.summary_notes.push(row); return Promise.resolve({ error: null }); } };
      }
      if (table === 'glossary_terms' || table === 'summary_terms') {
        // Simulate 0007 unapplied — degrades to a graceful warning, never blocks. Generic
        // chainable stub (select/eq/is all return itself) so it tolerates either
        // upsertGlossaryTerm branch (the insertIfAbsent/upsert path OR the manual
        // findExistingGlossaryTerm select/eq/is/maybeSingle path) without needing to know which
        // one parseCitation('') actually takes.
        const err = { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` };
        const builder = {
          select: () => builder,
          eq: () => builder,
          is: () => builder,
          maybeSingle: () => Promise.resolve({ data: null, error: err }),
          upsert: () => Promise.resolve({ error: err }),
          insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: err }) }) }),
        };
        return builder;
      }
      throw new Error(`unexpected table in this test: ${table}`);
    },
  };
}

test('recordOne end-to-end: first pass records+publishes a clean summary; second pass with the SAME item is idempotent (alreadySummarized, no duplicate rows)', async () => {
  const client = makeStatefulRecordClient();
  const item = baseItem();

  const first = await recordOne(client, 'run-1', item);
  assert.equal(first.outcome, 'published');
  assert.equal(client.state.summaries.length, 1);
  assert.equal(client.state.summaries[0].status, 'published');
  assert.equal(client.state.summary_verifications.length, 1);

  const second = await recordOne(client, 'run-1', item);
  assert.equal(second.outcome, 'alreadySummarized');
  assert.equal(second.summaryId, first.summaryId);
  assert.equal(client.state.summaries.length, 1, 'no duplicate summary row on replay');
  assert.equal(client.state.summary_verifications.length, 1, 'no duplicate verification row on replay');
});

// ---- loadPlanState: selectAll pagination survives past the 1000-row server cap ----
// Same class of cap-enforcing fake as auto-publish-glossary-cli.test.js's
// makeCappedGlossaryTermsClient — Global Constraints names bills (38,250) and votes (9,900+)
// explicitly as tables already past or near the cap.

function makeCappedPlanClient({ bills: billRows, votes: voteRows, billTexts = [], summaries = [] }, { serverCap = 1000 } = {}) {
  function capped(table, rows) {
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      select() { return this; },
      eq() { return this; },
      order() { return this; },
      range(from, to) {
        const size = Math.min(to - from + 1, serverCap);
        return Promise.resolve({ data: sorted.slice(from, from + size), error: null });
      },
    };
  }
  return {
    from(table) {
      if (table === 'bills') return capped('bills', billRows);
      if (table === 'votes') return capped('votes', voteRows);
      if (table === 'bill_texts') return capped('bill_texts', billTexts);
      if (table === 'summaries') return capped('summaries', summaries);
      throw new Error(`unexpected table in this test: ${table}`);
    },
  };
}

test('loadPlanState: 1500 voted-on bills past the 1000-row server cap all come back, not just the first page', async () => {
  const billRows = Array.from({ length: 1500 }, (_, i) => ({
    id: `b-${String(i).padStart(4, '0')}`, identifier: `HR ${i}`, title: `Bill ${i}`,
  }));
  const voteRows = billRows.map((b, i) => ({ id: `v-${String(i).padStart(4, '0')}`, bill_id: b.id, question: 'On Passage' }));
  const client = makeCappedPlanClient({ bills: billRows, votes: voteRows });
  const { bills: loaded } = await loadPlanState(client);
  assert.equal(loaded.length, 1500);
  assert.ok(loaded.some((b) => b.id === 'b-1499'), 'the newest bill must not be silently dropped past page 1');
});

test('loadPlanState: bills with no vote at all never enter the candidate universe, even past the pagination cap', async () => {
  const billRows = Array.from({ length: 1200 }, (_, i) => ({
    id: `b-${String(i).padStart(4, '0')}`, identifier: `HR ${i}`, title: `Bill ${i}`,
  }));
  // Only every other bill has a vote.
  const voteRows = billRows.filter((_, i) => i % 2 === 0).map((b, i) => ({ id: `v-${String(i).padStart(4, '0')}`, bill_id: b.id, question: 'On Passage' }));
  const client = makeCappedPlanClient({ bills: billRows, votes: voteRows });
  const { bills: loaded } = await loadPlanState(client);
  assert.equal(loaded.length, 600);
});

test('loadPlanState: --bill filter narrows to a single identifier', async () => {
  const billRows = [{ id: 'b1', identifier: 'HR 1', title: 'One' }, { id: 'b2', identifier: 'HR 2', title: 'Two' }];
  const voteRows = [{ id: 'v1', bill_id: 'b1', question: 'On Passage' }, { id: 'v2', bill_id: 'b2', question: 'On Passage' }];
  const client = makeCappedPlanClient({ bills: billRows, votes: voteRows });
  const { bills: loaded } = await loadPlanState(client, 'HR 2');
  assert.deepEqual(loaded.map((b) => b.id), ['b2']);
});

test('loadPlanState: picks the most-recently-retrieved bill_texts row as "current" and reduces to one per bill', async () => {
  const billRows = [{ id: 'b1', identifier: 'HR 1', title: 'One' }];
  const voteRows = [{ id: 'v1', bill_id: 'b1', question: 'On Passage' }];
  const billTexts = [
    { id: 't1', bill_id: 'b1', content: 'old', content_hash: 'h-old', retrieved_at: '2026-01-01T00:00:00Z' },
    { id: 't2', bill_id: 'b1', content: 'new text', content_hash: 'h-new', retrieved_at: '2026-01-05T00:00:00Z' },
  ];
  const client = makeCappedPlanClient({ bills: billRows, votes: voteRows, billTexts });
  const { texts } = await loadPlanState(client);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].content_hash, 'h-new');
  assert.equal(texts[0].length, 'new text'.length);
});

// ============================================================================================
// FINAL WHOLE-BRANCH REVIEW (.superpowers/sdd/2026-07-29-profile-completeness/
// final-review-findings.md), findings 4, 5 and 7 — the record gate.
// ============================================================================================

// ---- FINDING 4: the record gate bound verdicts to a summary by COUNT ONLY ----
// classifyRecordItem checked verdict-array length, bullet_index uniqueness/range and
// supported===true; nothing tied the verdicts to THIS summary, and the verdicts themselves were
// never validated against VERIFY_SCHEMA (only the summary was schema-checked). A verdict set citing
// another bill's sections auto-published and was stored verbatim in summary_verifications as the
// permanent trust-model-v3 receipt.

const oneBulletSummary = () => ({
  what_it_does: [{ point: 'Does X.', section: 'Sec. 1' }],
  stated_purpose: '',
  classification: 'other',
  referenced_terms: [],
});

test('classifyRecordItem: FINAL REVIEW FINDING 4 — a verdict set whose sections cite ANOTHER bill is flagged, never published: VERIFY_SCHEMA already mandates the verifier COPY each section from the summary, and that binding is now enforced mechanically', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow()], error: null },
    summaries: { data: [], error: null },
  });
  const crossBillVerdicts = [
    { bullet_index: 0, section: 'Sec. 402', supported: true, reason: 'ok', evidence_quote: 'q1' },
    { bullet_index: 1, section: 'Sec. 403', supported: true, reason: 'ok', evidence_quote: 'q2' },
  ];
  const decision = await classifyRecordItem(client, baseItem({ verdicts: crossBillVerdicts }));
  assert.equal(decision.action, 'flagDraft', 'a verification that never looked at this summary is a verification FAILURE, handled exactly like an unsupported verdict');
  assert.equal(decision.overall, 'flagged');
  assert.match(decision.gateReason, /Sec\. 402/);
});

test('classifyRecordItem: FINAL REVIEW FINDING 4 — a hollow verdict carrying only bullet_index+supported (no section/reason/evidence_quote) is flagged, never published, even though assessVerdicts alone reads it as complete and clean', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow()], error: null },
    summaries: { data: [], error: null },
  });
  const summary = oneBulletSummary();
  const hollow = [{ bullet_index: 0, supported: true }];
  const decision = await classifyRecordItem(client, baseItem({ summary, verdicts: hollow }));
  assert.equal(decision.action, 'flagDraft');
  assert.equal(decision.overall, 'flagged');
  assert.match(decision.gateReason, /evidence_quote|section|reason/);
});

test('classifyRecordItem: FINAL REVIEW FINDING 4 — a real, correctly-bound verdict set still publishes (the gate narrows nothing that was legitimately clean)', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow()], error: null },
    summaries: { data: [], error: null },
  });
  const decision = await classifyRecordItem(client, baseItem());
  assert.equal(decision.action, 'publish');
  assert.equal(decision.overall, 'clean');
});

// ---- FINDING 5: stated_purpose published with ZERO verdict coverage ----
// renderMarkdown emits "**Stated purpose (from the bill):** ..." into anon-readable body_md, but
// verdicts only ever cover what_it_does bullets — a fabricated stated_purpose published under a
// clean-verification note. The mechanical-substring route: a non-empty stated_purpose must appear
// verbatim in the hash-pinned stored text, whitespace runs collapsed on both sides and nothing else
// normalized (facts-only).

test('classifyRecordItem: FINAL REVIEW FINDING 5 — a stated_purpose that is a verbatim substring of the hash-pinned stored bill text publishes', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow()], error: null },
    summaries: { data: [], error: null },
  });
  const summary = goodSummary();
  summary.stated_purpose = 'To do X and Y.';
  const decision = await classifyRecordItem(client, baseItem({ summary }));
  assert.equal(decision.action, 'publish');
});

test('classifyRecordItem: FINAL REVIEW FINDING 5 — a PARAPHRASED stated_purpose (nowhere in the bill text) is flagged with an honest reason, never published under a clean-verification note', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow()], error: null },
    summaries: { data: [], error: null },
  });
  const summary = goodSummary();
  summary.stated_purpose = 'To improve the lives of hardworking families.';
  const decision = await classifyRecordItem(client, baseItem({ summary }));
  assert.equal(decision.action, 'flagDraft', 'nothing mechanical covered this field before — it rendered into anon-readable body_md unchecked');
  assert.equal(decision.overall, 'flagged');
  assert.match(decision.gateReason, /stated_purpose/);
});

test('classifyRecordItem: FINAL REVIEW FINDING 5 — line breaks and indentation in the stored bill text do not defeat the check (whitespace runs collapse on BOTH sides; nothing else is normalized)', async () => {
  const client = fakeClient({
    bill_texts: {
      data: [{ content: 'SEC. 1. PURPOSE.\n    To do   X\n    and Y.\n', content_hash: 'h1', retrieved_at: '2026-01-01T00:00:00Z' }],
      error: null,
    },
    summaries: { data: [], error: null },
  });
  const summary = goodSummary();
  summary.stated_purpose = 'To do X and Y.';
  const decision = await classifyRecordItem(client, baseItem({ summary }));
  assert.equal(decision.action, 'publish');
});

test('classifyRecordItem: FINAL REVIEW FINDING 5 — an EMPTY stated_purpose stays allowed (a bill that states no purpose is a real, honest shape; the schema itself says so)', async () => {
  const client = fakeClient({
    bill_texts: { data: [textRow()], error: null },
    summaries: { data: [], error: null },
  });
  const summary = goodSummary();
  summary.stated_purpose = '';
  const decision = await classifyRecordItem(client, baseItem({ summary }));
  assert.equal(decision.action, 'publish');
});

test('classifyRecordItem: FINAL REVIEW FINDING 5 — a stored bill_texts row with no content at all cannot ground a non-empty stated_purpose, so it flags rather than publishing on an unverifiable field', async () => {
  const client = fakeClient({
    bill_texts: { data: [{ content: null, content_hash: 'h1', retrieved_at: '2026-01-01T00:00:00Z' }], error: null },
    summaries: { data: [], error: null },
  });
  const decision = await classifyRecordItem(client, baseItem());
  assert.equal(decision.action, 'flagDraft');
  assert.match(decision.gateReason, /stated_purpose/);
});

// ---- FINDING 7: a newline inside a what_it_does point injects extra public bullets ----
// validateSummaryShape only required a non-empty string; renderMarkdown interpolates the point into
// a `- ` line, so a point containing "\n- Repeals the Clean Air Act in full. (Sec. 9)" rendered TWO
// citable public bullets while assessVerdicts counted ONE, and a point containing "\n\n**Stated
// purpose (from the bill):** ..." forged a block no field ever held. Structural fields are
// single-line by contract.

test('validateSummaryShape: FINAL REVIEW FINDING 7 — a newline inside a what_it_does point is a shape failure (it renders a SECOND citable public bullet the verification record never covers)', () => {
  const summary = goodSummary();
  summary.what_it_does[0].point = 'Does X.\n- Repeals the Clean Air Act in full. (Sec. 9)';
  assert.match(validateSummaryShape(summary), /what_it_does\[0\]\.point/);
});

test('validateSummaryShape: FINAL REVIEW FINDING 7 — a newline inside stated_purpose is a shape failure (the forged-stated-purpose-block probe)', () => {
  const summary = goodSummary();
  summary.stated_purpose = 'To do X and Y.\n\n**Stated purpose (from the bill):** To seize all private property.';
  assert.match(validateSummaryShape(summary), /stated_purpose/);
});

test('validateSummaryShape: FINAL REVIEW FINDING 7 — a carriage return counts too, in a section as well as a point', () => {
  const withPointCr = goodSummary();
  withPointCr.what_it_does[1].point = 'Does Y.\r- Forged.';
  assert.match(validateSummaryShape(withPointCr), /what_it_does\[1\]\.point/);

  const withSectionNewline = goodSummary();
  withSectionNewline.what_it_does[0].section = 'Sec. 1\nSec. 9';
  assert.match(validateSummaryShape(withSectionNewline), /what_it_does\[0\]\.section/);
});

test('validateSummaryShape: FINAL REVIEW FINDING 7 — referenced_terms fields are single-line by contract too (they feed the glossary pipeline, which renders them elsewhere)', () => {
  const withTermNewline = goodSummary();
  withTermNewline.referenced_terms[0].term = 'Some Act\nOther Act';
  assert.match(validateSummaryShape(withTermNewline), /referenced_terms\[0\]\.term/);

  const withCitationNewline = goodSummary();
  withCitationNewline.referenced_terms[0].citation_raw = '42 U.S.C. 1396b\n42 U.S.C. 9999';
  assert.match(validateSummaryShape(withCitationNewline), /referenced_terms\[0\]\.citation_raw/);
});

test('validateSummaryShape: FINAL REVIEW FINDING 7 — a clean multi-bullet summary still passes; single-line is the only new constraint', () => {
  assert.equal(validateSummaryShape(goodSummary()), null);
});

test('classifyRecordItem: FINAL REVIEW FINDING 7 — the newline injection is a SHAPE failure, so it takes the existing typed-reject path (MalformedSummaryError) before any DB read, never a flagged draft', async () => {
  const client = fakeClient({}, () => assert.fail('no DB call should happen — the shape reject fires before any read'));
  const summary = goodSummary();
  summary.what_it_does[0].point = 'Does X.\n- Repeals the Clean Air Act in full. (Sec. 9)';
  await assert.rejects(() => classifyRecordItem(client, baseItem({ summary })), MalformedSummaryError);
});

// ---- FINAL REVIEW FINDING 6: --limit fails loud here too ----
// Same class as enrich-federal-bills.js's own --limit (see that file's tests): `Number(...)` with
// no validation, and plan mode's `args.limit ? queue.slice(0, args.limit) : queue` treats NaN/0 as
// "emit the whole queue". Same shared guard, same typed error.

test('parseArgs: FINAL REVIEW FINDING 6 — a malformed --limit throws InvalidFlagValueError instead of silently emitting the entire queue', () => {
  for (const bad of ['5O', '0', '-3', '1.5', '']) {
    assert.throws(() => parseArgs(['plan', '--limit', bad]), InvalidFlagValueError, `expected --limit ${JSON.stringify(bad)} to throw`);
  }
  assert.throws(() => parseArgs(['plan', '--limit']), InvalidFlagValueError);
});

test('parseArgs: FINAL REVIEW FINDING 6 — a real positive integer --limit still parses, in both modes', () => {
  assert.equal(parseArgs(['plan', '--limit', '12']).limit, 12);
  assert.equal(parseArgs(['record', '--file', 'x.json', '--limit', '3']).limit, 3);
});
