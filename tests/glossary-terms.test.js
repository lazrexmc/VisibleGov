import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTermText, upsertKeyFor, normalizeCitation, persistReferencedTerms,
  resolveBillJurisdiction, GLOSSARY_TERMS_TABLE, SUMMARY_TERMS_TABLE,
} from '../src/lib/glossary-terms.js';
import * as extractTerms from '../src/cli/extract-terms.js';

// Fix wave (final review, Important finding 2): normalizeTermText/upsertKeyFor/normalizeCitation
// moved here from extract-terms.js so summarize.js could reuse them too (see that file's
// createDraftSummary). extract-terms.js re-exports them UNCHANGED — proving here that the
// re-exports are the SAME function objects (not re-implemented copies) is what guarantees the two
// callers can never silently drift apart, the exact risk this fix wave was meant to close.
test('extract-terms.js re-exports normalizeTermText/upsertKeyFor/normalizeCitation BY REFERENCE, not as re-implemented copies', () => {
  assert.equal(extractTerms.normalizeTermText, normalizeTermText);
  assert.equal(extractTerms.upsertKeyFor, upsertKeyFor);
  assert.equal(extractTerms.normalizeCitation, normalizeCitation);
});

test('table name constants match the actual migration 0007 table names', () => {
  assert.equal(GLOSSARY_TERMS_TABLE, 'glossary_terms');
  assert.equal(SUMMARY_TERMS_TABLE, 'summary_terms');
});

// persistReferencedTerms itself (the shared mechanical layer, no missing-relation tolerance —
// that policy lives at each call site) — a light direct check that an empty referencedTerms array
// is a no-op, complementing the fuller fake-client coverage exercised indirectly through
// summarize.js's persistReferencedTermsGracefully (tests/summarize-cli.test.js) and
// extract-terms.js's own extractOne (tests/extract-terms-cli.test.js's upstream unit coverage of
// the pure pieces it's built from).
test('persistReferencedTerms is a no-op (no DB calls, termsUpserted 0) for an empty referencedTerms array', async () => {
  let calls = 0;
  const client = { from: () => { calls += 1; return {}; } };
  const result = await persistReferencedTerms(client, 'run-1', { summaryId: 'sum-1', referencedTerms: [] });
  assert.deepEqual(result, { termsUpserted: 0 });
  assert.equal(calls, 0);
});

// ---- Task 5: insert-time dispatch — jurisdiction-aware upsertKeyFor ----
//
// Missouri statute citations (section N.NNN / chapter N) look nothing like USC citations, so
// parseCitation (uscode.js) never accidentally resolves them — but a bare "section 536.010" is
// ALSO not self-evidently MO without knowing which legislature is speaking. upsertKeyFor now takes
// the bill's resolved jurisdictionId and only asks mo-statutes.js's parser when that jurisdiction is
// literally 'mo-legislature' — no context (every caller before this task) and any OTHER
// jurisdiction (e.g. a future 'us-congress' value) must stay unmapped, exactly like today, because
// guessing MO from an ambiguous bare citation would risk mismapping a term from some other state's
// bill that happens to cite a same-shaped number.

test('upsertKeyFor maps an RSMo citation ONLY in mo-legislature context', () => {
  const rawTerm = { term: 'section 536.010', kind: 'statute', citation_raw: 'section 536.010' };
  assert.deepEqual(upsertKeyFor(rawTerm, 'mo-legislature'),
    { by: 'citation', needs_mapping: false, citation: 'RSMo 536.010' });
  // No context (today's callers) and federal context both stay unmapped — never guess.
  assert.deepEqual(upsertKeyFor(rawTerm), { by: 'term', needs_mapping: true });
  assert.deepEqual(upsertKeyFor(rawTerm, 'us-congress'), { by: 'term', needs_mapping: true });
});

test('upsertKeyFor: USC parse wins regardless of jurisdiction, and carries its citation', () => {
  const usc = { term: 'x', kind: 'statute', citation_raw: '42 U.S.C. 1396b' };
  assert.deepEqual(upsertKeyFor(usc, 'mo-legislature'),
    { by: 'citation', needs_mapping: false, citation: '42 U.S.C. 1396b' });
});

test('upsertKeyFor: a chapter maps in MO context', () => {
  const ch = { term: 'chapter 536', kind: 'statute', citation_raw: 'chapter 536' };
  assert.deepEqual(upsertKeyFor(ch, 'mo-legislature'),
    { by: 'citation', needs_mapping: false, citation: 'RSMo chapter 536' });
});

// ---- fake-client helpers for resolveBillJurisdiction/persistReferencedTerms below ----
//
// fakeQuery/fakeClient (canned-per-table {data,error}, call-captured) is this codebase's
// established convention for driving persistReferencedTerms' real upsert/find/insert call
// sequence without a live Postgrest instance — see tests/summarize-cli.test.js's own copy, which
// this mirrors exactly. It can't express resolveBillJurisdiction's need though: the SAME table
// (bills, then sessions) must answer DIFFERENTLY depending on which id was queried, within a
// single test ('b1' -> a row, 'missing' -> none) — so fakeRowQuery adds a small row-store variant
// (seeded array, filtered by whatever .eq() the code chains, resolved at .maybeSingle()) and
// fakeMixedClient lets a single client mix both: `rowsByTable` tables (bills/sessions here) get
// real per-row filtering, everything else falls through to a canned resolver (glossary_terms/
// summary_terms here) — which may itself be a function of the methods called on that one chain
// (not just a static object), because upsertGlossaryTerm's unmapped branch makes TWO sequential
// calls to glossary_terms in one upsert (a check, then a conditional insert) that must answer
// differently: not-found on the check, an id back on the insert.
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

function fakeRowQuery(rows, onCall) {
  const filters = [];
  const record = (method) => (...args) => { if (onCall) onCall(method, args); return builder; };
  const builder = {
    select: record('select'),
    eq: (col, val) => { filters.push([col, val]); if (onCall) onCall('eq', [col, val]); return builder; },
    is: (col, val) => { filters.push([col, val]); if (onCall) onCall('is', [col, val]); return builder; },
    maybeSingle: async () => {
      const found = rows.find((r) => filters.every(([c, v]) => r[c] === v));
      return { data: found ?? null, error: null };
    },
  };
  return builder;
}

// cannedByTable entries may be a static {data,error} OR a function(methodsCalledOnThisChain) ->
// {data,error} — see the header comment above.
function fakeCannedQuery(resolver, onCall) {
  const methodsCalled = [];
  const record = (method) => (...args) => {
    methodsCalled.push(method);
    if (onCall) onCall(method, args);
    return builder;
  };
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
    then: (resolve, reject) => {
      const result = typeof resolver === 'function' ? resolver(methodsCalled) : resolver;
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return builder;
}

function fakeMixedClient(rowsByTable, cannedByTable = {}, onCall) {
  return {
    from: (table) => {
      const tableOnCall = onCall ? (method, args) => onCall(table, method, args) : undefined;
      if (rowsByTable[table]) return fakeRowQuery(rowsByTable[table], tableOnCall);
      return fakeCannedQuery(cannedByTable[table] ?? { data: null, error: null }, tableOnCall);
    },
  };
}

test('resolveBillJurisdiction walks bills -> sessions and is null-safe', async () => {
  // bills carries NO jurisdiction column — it's two hops away (bills.session_id ->
  // sessions.jurisdiction_id). Seed both tables; a missing bill row, and a null billId, must both
  // resolve to null (never fail term persistence over a lookup miss) rather than throwing.
  const fake = fakeMixedClient({
    bills: [{ id: 'b1', session_id: 's1' }],
    sessions: [{ id: 's1', jurisdiction_id: 'mo-legislature' }],
  });
  assert.equal(await resolveBillJurisdiction(fake, 'b1'), 'mo-legislature');
  assert.equal(await resolveBillJurisdiction(fake, 'missing'), null);
  assert.equal(await resolveBillJurisdiction(fake, null), null);
});

test('persistReferencedTerms threads billId jurisdiction into term mapping', async () => {
  const referencedTerms = [{ term: 'section 536.010', kind: 'statute', citation_raw: 'section 536.010' }];

  // billId 'b1' resolves (via bills -> sessions, seeded as in the test above) to
  // 'mo-legislature', so upsertKeyFor's MO branch fires: the row lands mapped, citation
  // 'RSMo 536.010', needs_mapping false. insertIfAbsent's upsert only reads `.error` off the
  // canned result and findExistingGlossaryTerm's maybeSingle only reads `.data.id` — a single
  // static {data,error} answers both truthfully here (same convention as
  // tests/summarize-cli.test.js's own persistReferencedTermsGracefully tests).
  const mappedCalls = [];
  const mappedClient = fakeMixedClient({
    bills: [{ id: 'b1', session_id: 's1' }],
    sessions: [{ id: 's1', jurisdiction_id: 'mo-legislature' }],
  }, {
    glossary_terms: { data: { id: 'term-mo' }, error: null },
    summary_terms: { data: null, error: null },
  }, (table, method, args) => mappedCalls.push({ table, method, args }));

  await persistReferencedTerms(mappedClient, 'run-1', { summaryId: 'sum-1', referencedTerms, billId: 'b1' });
  const mappedUpsert = mappedCalls.find((c) => c.table === 'glossary_terms' && c.method === 'upsert');
  assert.ok(mappedUpsert, 'expected an upsert against glossary_terms for the mapped branch');
  assert.equal(mappedUpsert.args[0][0].citation, 'RSMo 536.010');
  assert.equal(mappedUpsert.args[0][0].needs_mapping, false);

  // billId null never resolves a jurisdiction (resolveBillJurisdiction short-circuits on a falsy
  // billId — no DB call at all), so upsertKeyFor falls back to today's default: unmapped. The
  // unmapped branch makes a check-then-insert against glossary_terms (no unique index it can
  // ON CONFLICT against — see upsertGlossaryTerm's own comment) — the resolver function answers
  // "not found" on the check (.maybeSingle, no .insert in this chain yet) and "here's an id" on
  // the follow-up .insert(...).select('id').single() chain.
  const unmappedCalls = [];
  const unmappedClient = fakeMixedClient({}, {
    glossary_terms: (methods) => (methods.includes('insert')
      ? { data: { id: 'term-unmapped' }, error: null }
      : { data: null, error: null }),
    summary_terms: { data: null, error: null },
  }, (table, method, args) => unmappedCalls.push({ table, method, args }));

  await persistReferencedTerms(unmappedClient, 'run-1', { summaryId: 'sum-2', referencedTerms, billId: null });
  const unmappedInsert = unmappedCalls.find((c) => c.table === 'glossary_terms' && c.method === 'insert');
  assert.ok(unmappedInsert, 'expected a manual insert against glossary_terms for the unmapped branch');
  assert.equal(unmappedInsert.args[0].citation, null);
  assert.equal(unmappedInsert.args[0].needs_mapping, true);
});
