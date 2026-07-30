import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import {
  nextStatus, mapNoteAction, validateDecisionInput, countVoteCasts, pickLatestVote,
  pickBillText, readBody, BodyTooLargeError, requestListener, isAllowedDecisionRequest,
  verificationBadge, latestVerificationBySummary, resolveVerificationRows,
  validateGlossaryDecisionInput, glossVerificationBadge, latestVerificationByTerm,
  isPublishCompletenessViolation,
  formatCandidateDistrict, formatCandidateEraSpan, findCandidateEvidence,
  buildLanceLinkEvidence, buildLanceAttachEvidence, appendResolution, validateIdentityDecisionInput,
  HOST, PORT,
} from '../src/review/server.js';

const OWN_ORIGIN = `http://${HOST}:${PORT}`;

test('nextStatus: draft + approve -> approved', () => {
  assert.equal(nextStatus('draft', 'approve'), 'approved');
});

test('nextStatus: approved + publish -> published', () => {
  assert.equal(nextStatus('approved', 'publish'), 'published');
});

test('nextStatus: draft + publish -> throws /illegal/', () => {
  assert.throws(() => nextStatus('draft', 'publish'), /illegal/);
});

test('nextStatus: published + approve -> throws', () => {
  assert.throws(() => nextStatus('published', 'approve'), /illegal/);
});

test('nextStatus: stale + edit -> draft', () => {
  assert.equal(nextStatus('stale', 'edit'), 'draft');
});

test('nextStatus: rejected + publish -> throws', () => {
  assert.throws(() => nextStatus('rejected', 'publish'), /illegal/);
});

// Additional transition-table coverage beyond the brief's six named cases: 'edit' is only legal
// from draft/stale, and reject is legal from every non-terminal state.
test('nextStatus: draft + reject -> rejected', () => {
  assert.equal(nextStatus('draft', 'reject'), 'rejected');
});

test('nextStatus: stale + reject -> rejected', () => {
  assert.equal(nextStatus('stale', 'reject'), 'rejected');
});

test('nextStatus: approved + reject -> rejected', () => {
  assert.equal(nextStatus('approved', 'reject'), 'rejected');
});

test('nextStatus: approved + edit -> throws (edit is not legal from approved)', () => {
  assert.throws(() => nextStatus('approved', 'edit'), /illegal/);
});

// ---- mapNoteAction (controller ruling #2) ----

test('mapNoteAction maps every decision action to its summary_notes.action', () => {
  assert.equal(mapNoteAction('approve'), 'approved');
  assert.equal(mapNoteAction('edit'), 'edited');
  assert.equal(mapNoteAction('reject'), 'rejected');
  assert.equal(mapNoteAction('publish'), 'published');
});

test('mapNoteAction throws on an unknown action', () => {
  assert.throws(() => mapNoteAction('delete'), /unknown action/);
});

// ---- validateDecisionInput (controller ruling #3) ----

test('validateDecisionInput: edit without body_md is invalid', () => {
  assert.match(validateDecisionInput({ action: 'edit', body_md: '', note: '' }), /body_md is required/);
});

test('validateDecisionInput: edit with body_md is valid', () => {
  assert.equal(validateDecisionInput({ action: 'edit', body_md: '**hi**', note: '' }), null);
});

test('validateDecisionInput: reject without note is invalid', () => {
  assert.match(validateDecisionInput({ action: 'reject', note: '' }), /note is required/);
});

test('validateDecisionInput: reject with note is valid', () => {
  assert.equal(validateDecisionInput({ action: 'reject', note: 'text does not match title' }), null);
});

test('validateDecisionInput: approve/publish do not require note', () => {
  assert.equal(validateDecisionInput({ action: 'approve' }), null);
  assert.equal(validateDecisionInput({ action: 'publish' }), null);
});

test('validateDecisionInput: unknown action is invalid', () => {
  assert.match(validateDecisionInput({ action: 'delete' }), /unknown action/);
});

// ---- countVoteCasts (controller ruling #4) ----

test('countVoteCasts counts only yea/nay, ignoring other positions', () => {
  const casts = [
    { position: 'yea' }, { position: 'yea' }, { position: 'nay' },
    { position: 'present' }, { position: 'not_voting' }, { position: 'absent' }, { position: 'other' },
  ];
  assert.deepEqual(countVoteCasts(casts), { yeas: 2, nays: 1 });
});

test('countVoteCasts on an empty list is zero/zero', () => {
  assert.deepEqual(countVoteCasts([]), { yeas: 0, nays: 0 });
});

// ---- pickLatestVote (controller ruling #4) ----

test('pickLatestVote picks the most recent vote by vote_date when several exist', () => {
  const votes = [
    { id: 'v1', vote_date: '2026-01-01T00:00:00Z' },
    { id: 'v2', vote_date: '2026-06-15T00:00:00Z' },
    { id: 'v3', vote_date: '2026-03-01T00:00:00Z' },
  ];
  assert.equal(pickLatestVote(votes).id, 'v2');
});

test('pickLatestVote returns null for an empty/absent list', () => {
  assert.equal(pickLatestVote([]), null);
  assert.equal(pickLatestVote(null), null);
});

// ---- pickBillText (grounding: match the text a draft was actually generated from) ----

test('pickBillText matches by content_hash against the summary bill_text_hash', () => {
  const texts = [
    { content: 'old version', content_hash: 'hash-old', retrieved_at: '2026-01-01T00:00:00Z' },
    { content: 'current version', content_hash: 'hash-new', retrieved_at: '2026-02-01T00:00:00Z' },
  ];
  assert.equal(pickBillText(texts, 'hash-old').content, 'old version');
});

test('pickBillText falls back to the most-recently-retrieved row when no hash matches', () => {
  const texts = [
    { content: 'older', content_hash: 'a', retrieved_at: '2026-01-01T00:00:00Z' },
    { content: 'newer', content_hash: 'b', retrieved_at: '2026-02-01T00:00:00Z' },
  ];
  assert.equal(pickBillText(texts, 'no-such-hash').content, 'newer');
});

test('pickBillText returns null for an empty list', () => {
  assert.equal(pickBillText([], 'anything'), null);
});

// ---- verificationBadge (Task 10: adversarial verification pass) ----

test('verificationBadge: null verification -> grey unverified', () => {
  assert.deepEqual(verificationBadge(null), { state: 'unverified', label: 'Unverified' });
});

test('verificationBadge: overall clean -> green, names how many bullets were checked', () => {
  const v = { overall: 'clean', verdicts: [{ supported: true }, { supported: true }, { supported: true }] };
  assert.deepEqual(verificationBadge(v), { state: 'clean', label: 'Verifier found all 3 bullets supported' });
});

test('verificationBadge: overall flagged -> amber, names how many of how many failed', () => {
  const v = { overall: 'flagged', verdicts: [{ supported: true }, { supported: false }, { supported: false }] };
  assert.deepEqual(verificationBadge(v), { state: 'flagged', label: 'Verifier flagged 2 of 3 bullets' });
});

// ---- latestVerificationBySummary (a summary can be re-verified; latest row wins, like pickLatestVote) ----

test('latestVerificationBySummary keeps only the most recent row per summary_id', () => {
  const rows = [
    { summary_id: 's1', created_at: '2026-01-01T00:00:00Z', overall: 'flagged' },
    { summary_id: 's1', created_at: '2026-02-01T00:00:00Z', overall: 'clean' },
    { summary_id: 's2', created_at: '2026-01-15T00:00:00Z', overall: 'clean' },
  ];
  const map = latestVerificationBySummary(rows);
  assert.equal(map.size, 2);
  assert.equal(map.get('s1').overall, 'clean');
  assert.equal(map.get('s2').overall, 'clean');
});

test('latestVerificationBySummary on empty/absent input returns an empty map', () => {
  assert.equal(latestVerificationBySummary([]).size, 0);
  assert.equal(latestVerificationBySummary(undefined).size, 0);
});

// ---- resolveVerificationRows (fix: review server must not 500 the whole page when migration
// 0004/summary_verifications hasn't been applied yet — the pure fallback decision) ----

const MISSING_RELATION_ERROR = {
  code: 'PGRST205',
  message: "Could not find the table 'public.summary_verifications' in the schema cache",
};

test('resolveVerificationRows returns the rows on success', () => {
  const rows = resolveVerificationRows({ data: [{ summary_id: 's1' }], error: null });
  assert.deepEqual(rows, [{ summary_id: 's1' }]);
});

test('resolveVerificationRows treats null data on success as an empty array', () => {
  assert.deepEqual(resolveVerificationRows({ data: null, error: null }), []);
});

test('resolveVerificationRows degrades to [] (not a throw) on a missing-relation error — 0004 not applied yet', () => {
  assert.deepEqual(resolveVerificationRows({ data: null, error: MISSING_RELATION_ERROR }), []);
});

test('resolveVerificationRows rethrows any OTHER error — no blanket swallowing', () => {
  const err = { code: '08006', message: 'connection failure' };
  assert.throws(() => resolveVerificationRows({ data: null, error: err }), (thrown) => thrown === err);
});

test('resolveVerificationRows rethrows an error naming a DIFFERENT missing table — no blanket swallowing', () => {
  const err = { code: '42P01', message: 'relation "public.some_other_table" does not exist' };
  assert.throws(() => resolveVerificationRows({ data: null, error: err }), (thrown) => thrown === err);
});

// ---- readBody / 1MB cap ----

test('readBody resolves with the concatenated buffer under the limit', async () => {
  const req = Readable.from([Buffer.from('{"a":1}')]);
  const buf = await readBody(req, 1024 * 1024);
  assert.equal(buf.toString('utf8'), '{"a":1}');
});

test('readBody rejects with BodyTooLargeError once the size cap is exceeded', async () => {
  const big = Buffer.alloc(2000, 'x');
  const req = Readable.from([big]);
  await assert.rejects(() => readBody(req, 1000), BodyTooLargeError);
});

// ---- isAllowedDecisionRequest (CSRF guard on POST /api/decision) ----

test('isAllowedDecisionRequest: application/json + no Origin -> allowed', () => {
  assert.equal(isAllowedDecisionRequest({ 'content-type': 'application/json' }), true);
});

test('isAllowedDecisionRequest: application/json + own Origin -> allowed', () => {
  assert.equal(isAllowedDecisionRequest({ 'content-type': 'application/json', origin: OWN_ORIGIN }), true);
});

test('isAllowedDecisionRequest: text/plain (form CSRF vector) -> denied regardless of Origin', () => {
  assert.equal(isAllowedDecisionRequest({ 'content-type': 'text/plain' }), false);
  assert.equal(isAllowedDecisionRequest({ 'content-type': 'text/plain', origin: OWN_ORIGIN }), false);
});

test('isAllowedDecisionRequest: application/json + foreign Origin -> denied', () => {
  assert.equal(isAllowedDecisionRequest({ 'content-type': 'application/json', origin: 'https://evil.example' }), false);
});

test('isAllowedDecisionRequest: missing Content-Type -> denied', () => {
  assert.equal(isAllowedDecisionRequest({}), false);
});

test('isAllowedDecisionRequest: Content-Type with charset suffix still matches (startsWith)', () => {
  assert.equal(isAllowedDecisionRequest({ 'content-type': 'application/json; charset=utf-8' }), true);
});

// ---- requestListener HTTP-level behavior (no live DB required) ----

function withServer(fn, clientOverride) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      requestListener(req, res, clientOverride).catch(reject);
    });
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}`);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

// ---- fake Supabase-shaped client (test-only) ----
// Every postgrest-js query builder method returns the same chainable, thenable object regardless
// of call order — mirrors real Supabase's builder shape closely enough to drive handleQueue/
// handleItem through a real HTTP round trip without a live DB. onCall, if given, records every
// builder-method invocation (table, method, args) so a test can assert on what was actually
// queried (e.g. which statuses a .in('status', [...]) call asked for), not just the fake result.
function fakeQuery(result, onCall) {
  const record = (method) => (...args) => { if (onCall) onCall(method, args); return builder; };
  const builder = {
    select: record('select'),
    in: record('in'),
    eq: record('eq'),
    order: record('order'),
    // range() (finding 1): selectAll (src/lib/db.js) always appends .order('id',...).range(from,to)
    // — this fake's own canned result comes back in one shot regardless of the requested bounds,
    // which is fine for every fixture in this suite (all well under the 1000-row page size); the
    // dedicated capped fake in tests/db.test.js is what actually proves selectAll's pagination math.
    range: record('range'),
    limit: record('limit'),
    maybeSingle: record('maybeSingle'),
    // update/insert (Task 6's decision handlers, mirroring handleDecision's existing writes):
    // chain through the same builder and resolve to the same canned {data,error} result — enough
    // for happy-path decision tests where the write is expected to succeed.
    update: record('update'),
    insert: record('insert'),
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

// ---- fix: review server must degrade, not 500, when summary_verifications is missing (0004 not
// applied yet) — regression coverage for exactly this bug ----

test('GET /api/queue returns verified:"unverified" (200, not 500) when summary_verifications is missing', () => {
  const client = fakeClient({
    summaries: {
      data: [{ id: 's1', status: 'draft', created_at: '2026-01-01T00:00:00Z', bills: { identifier: 'HR 1', title: 'A Bill' } }],
      error: null,
    },
    summary_verifications: { data: null, error: MISSING_RELATION_ERROR },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/queue`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{
      id: 's1', status: 'draft', created_at: '2026-01-01T00:00:00Z',
      bill: { identifier: 'HR 1', title: 'A Bill' }, verified: 'unverified',
    }]);
  }, client);
});

test('GET /api/item/:id returns verification:null (200, not 500) when summary_verifications is missing', () => {
  const client = fakeClient({
    summaries: {
      data: {
        id: 'sum1', bill_id: 'b1', status: 'draft', body_md: '- x (Sec 1)', model: 'claude-opus-5',
        prompt_version: 'v1', bill_text_hash: 'h1', created_at: '2026-01-01T00:00:00Z', published_at: null,
      },
      error: null,
    },
    bills: { data: { identifier: 'HR 1', title: 'A Bill', canonical_url: 'https://example.test/hr1' }, error: null },
    bill_texts: { data: [], error: null },
    votes: { data: [], error: null },
    summary_verifications: { data: null, error: MISSING_RELATION_ERROR },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/item/sum1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.verification, null);
    assert.equal(body.summary.id, 'sum1');
  }, client);
});

// ---- fix: approved summaries must stay in the review queue until published (real-use gap:
// approve->publish is a legal transition, but an approved row was invisible the moment it left
// draft/stale, with no UI path back to it) ----

test('GET /api/queue queries summaries with status in (draft, stale, approved)', () => {
  const calls = [];
  const client = fakeClient(
    {
      summaries: { data: [], error: null },
    },
    (table, method, args) => calls.push({ table, method, args }),
  );
  return withServer(async (base) => {
    await fetch(`${base}/api/queue`);
    const statusFilter = calls.find((c) => c.table === 'summaries' && c.method === 'in' && c.args[0] === 'status');
    assert.ok(statusFilter, 'expected a summaries .in("status", [...]) call');
    assert.deepEqual(statusFilter.args[1].slice().sort(), ['approved', 'draft', 'stale']);
  }, client);
});

test('GET /api/queue includes an approved-status row with its status (not just draft/stale)', () => {
  const client = fakeClient({
    summaries: {
      data: [
        { id: 's1', status: 'draft', created_at: '2026-01-01T00:00:00Z', bills: { identifier: 'HR 1', title: 'Bill One' } },
        { id: 's2', status: 'approved', created_at: '2026-01-02T00:00:00Z', bills: { identifier: 'HR 2', title: 'Bill Two' } },
      ],
      error: null,
    },
    summary_verifications: { data: [], error: null },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/queue`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const approvedItem = body.find((it) => it.id === 's2');
    assert.ok(approvedItem, 'approved row must appear in the queue response');
    assert.equal(approvedItem.status, 'approved');
  }, client);
});

test('GET / serves page.html as text/html with the nosniff header', () => withServer(async (base) => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html; charset=utf-8/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const body = await res.text();
  assert.match(body, /<title>VisibleGov/);
}));

test('GET /api/queue with no DB client configured returns a clean 500, not a crash', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/queue`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.deepEqual(body, { error: 'internal error' });
}));

test('POST /api/decision rejects an over-1MB body with 413', () => withServer(async (base) => {
  const big = 'x'.repeat(1024 * 1024 + 10);
  const res = await fetch(`${base}/api/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary_id: 'x', action: 'edit', body_md: big }),
  });
  assert.equal(res.status, 413);
}));

// ---- CSRF guard, exercised over real HTTP (the form-CSRF vector is specifically about the
// actual Content-Type/Origin headers an HTTP request arrives with) ----

test('POST /api/decision with Content-Type text/plain (the <form enctype=text/plain> CSRF vector) -> 403', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ summary_id: 'x', action: 'approve' }),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'forbidden' });
}));

test('POST /api/decision with a foreign Origin -> 403', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ summary_id: 'x', action: 'approve' }),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'forbidden' });
}));

test('POST /api/decision with application/json and no Origin passes the CSRF guard (not 403)', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary_id: 'x', action: 'approve' }),
  });
  // No live DB client in this test process, so this falls through to a 500 (or a 400 if
  // validation trips first) — the point of this test is only that the CSRF guard itself did not
  // block it.
  assert.notEqual(res.status, 403);
}));

test('unknown route returns 404', () => withServer(async (base) => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
}));

// ============================================================================
// Task 6: glossary review queue (mirrors the summary review server exactly —
// controller ruling 2 — same TRANSITIONS/nextStatus/mapNoteAction reused unchanged)
// ============================================================================

const GLOSSARY_MISSING_RELATION_ERROR = {
  code: 'PGRST205',
  message: "Could not find the table 'public.glossary_terms' in the schema cache",
};

const GLOSSARY_VERIFICATIONS_MISSING_ERROR = {
  code: 'PGRST205',
  message: "Could not find the table 'public.glossary_verifications' in the schema cache",
};

// ---- validateGlossaryDecisionInput (mirrors validateDecisionInput's rules, gloss_md in place of body_md) ----

test('validateGlossaryDecisionInput: edit without gloss_md is invalid', () => {
  assert.match(validateGlossaryDecisionInput({ action: 'edit', gloss_md: '', note: '' }), /gloss_md is required/);
});

test('validateGlossaryDecisionInput: edit with gloss_md is valid', () => {
  assert.equal(validateGlossaryDecisionInput({ action: 'edit', gloss_md: 'A short gloss.', note: '' }), null);
});

test('validateGlossaryDecisionInput: reject without note is invalid', () => {
  assert.match(validateGlossaryDecisionInput({ action: 'reject', note: '' }), /note is required/);
});

test('validateGlossaryDecisionInput: reject with note is valid', () => {
  assert.equal(validateGlossaryDecisionInput({ action: 'reject', note: 'not a real citation' }), null);
});

test('validateGlossaryDecisionInput: approve/publish do not require note', () => {
  assert.equal(validateGlossaryDecisionInput({ action: 'approve' }), null);
  assert.equal(validateGlossaryDecisionInput({ action: 'publish' }), null);
});

test('validateGlossaryDecisionInput: unknown action is invalid', () => {
  assert.match(validateGlossaryDecisionInput({ action: 'delete' }), /unknown action/);
});

// ---- glossVerificationBadge (same mechanical derivation as verificationBadge, "sentences" wording
// per the gloss verifier's own domain — glosser.js verifies gloss SENTENCES, not summary bullets) ----

test('glossVerificationBadge: null verification -> grey unverified', () => {
  assert.deepEqual(glossVerificationBadge(null), { state: 'unverified', label: 'Unverified' });
});

test('glossVerificationBadge: overall clean -> green, names how many sentences were checked', () => {
  const v = { overall: 'clean', verdicts: [{ supported: true }, { supported: true }] };
  assert.deepEqual(glossVerificationBadge(v), { state: 'clean', label: 'Verifier found all 2 sentences supported' });
});

test('glossVerificationBadge: overall flagged -> amber, names how many of how many failed', () => {
  const v = { overall: 'flagged', verdicts: [{ supported: true }, { supported: false }] };
  assert.deepEqual(glossVerificationBadge(v), { state: 'flagged', label: 'Verifier flagged 1 of 2 sentences' });
});

// ---- latestVerificationByTerm (same "latest wins" pattern as latestVerificationBySummary, keyed
// by term_id instead of summary_id) ----

test('latestVerificationByTerm keeps only the most recent row per term_id', () => {
  const rows = [
    { term_id: 't1', created_at: '2026-01-01T00:00:00Z', overall: 'flagged' },
    { term_id: 't1', created_at: '2026-02-01T00:00:00Z', overall: 'clean' },
    { term_id: 't2', created_at: '2026-01-15T00:00:00Z', overall: 'clean' },
  ];
  const map = latestVerificationByTerm(rows);
  assert.equal(map.size, 2);
  assert.equal(map.get('t1').overall, 'clean');
  assert.equal(map.get('t2').overall, 'clean');
});

test('latestVerificationByTerm on empty/absent input returns an empty map', () => {
  assert.equal(latestVerificationByTerm([]).size, 0);
  assert.equal(latestVerificationByTerm(undefined).size, 0);
});

// ---- isPublishCompletenessViolation (controller ruling 2: surface the DB CHECK error honestly,
// never pre-filter it away silently) ----

test('isPublishCompletenessViolation: true for the glossary_terms_published_complete CHECK violation', () => {
  const err = { code: '23514', message: 'new row for relation "glossary_terms" violates check constraint "glossary_terms_published_complete"' };
  assert.equal(isPublishCompletenessViolation(err), true);
});

test('isPublishCompletenessViolation: false for an unrelated CHECK violation', () => {
  const err = { code: '23514', message: 'violates check constraint "glossary_terms_kind_check"' };
  assert.equal(isPublishCompletenessViolation(err), false);
});

test('isPublishCompletenessViolation: false for a non-check-violation error', () => {
  const err = { code: '08006', message: 'connection failure' };
  assert.equal(isPublishCompletenessViolation(err), false);
});

test('isPublishCompletenessViolation: false for null/absent error', () => {
  assert.equal(isPublishCompletenessViolation(null), false);
  assert.equal(isPublishCompletenessViolation(undefined), false);
});

// ---- CSRF route allowlist extended to /api/glossary/decision (same isAllowedDecisionRequest guard) ----

test('POST /api/glossary/decision with Content-Type text/plain -> 403 (same CSRF vector as /api/decision)', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/glossary/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ term_id: 'x', action: 'approve' }),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'forbidden' });
}));

test('POST /api/glossary/decision with a foreign Origin -> 403', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/glossary/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ term_id: 'x', action: 'approve' }),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'forbidden' });
}));

test('POST /api/glossary/decision with application/json and no Origin passes the CSRF guard (not 403)', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/glossary/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ term_id: 'x', action: 'approve' }),
  });
  assert.notEqual(res.status, 403);
}));

// ---- graceful degradation: pre-0007 (glossary_terms missing), the review server must never 500 —
// controller ruling 6 ----

test('GET /api/glossary/queue returns {available:false} (200, not 500) when glossary_terms is missing', () => {
  const client = fakeClient({
    glossary_terms: { data: null, error: GLOSSARY_MISSING_RELATION_ERROR },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/queue`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, false);
    assert.match(body.reason, /0007/);
    assert.deepEqual(body.items, []);
  }, client);
});

test('GET /api/glossary/item/:id returns {available:false} (200, not 500) when glossary_terms is missing', () => {
  const client = fakeClient({
    glossary_terms: { data: null, error: GLOSSARY_MISSING_RELATION_ERROR },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/item/t1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, false);
    assert.match(body.reason, /0007/);
  }, client);
});

test('POST /api/glossary/decision returns an honest non-500 error when glossary_terms is missing', () => {
  const client = fakeClient({
    glossary_terms: { data: null, error: GLOSSARY_MISSING_RELATION_ERROR },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term_id: 't1', action: 'approve' }),
    });
    assert.notEqual(res.status, 500);
    assert.notEqual(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /0007/);
  }, client);
});

test('GET /api/item/:id (summary route) still works when glossary_terms is missing — the two queues do not interfere', () => {
  const client = fakeClient({
    summaries: {
      data: {
        id: 'sum1', bill_id: 'b1', status: 'draft', body_md: '- x (Sec 1)', model: 'claude-opus-5',
        prompt_version: 'v1', bill_text_hash: 'h1', created_at: '2026-01-01T00:00:00Z', published_at: null,
      },
      error: null,
    },
    bills: { data: { identifier: 'HR 1', title: 'A Bill', canonical_url: 'https://example.test/hr1' }, error: null },
    bill_texts: { data: [], error: null },
    votes: { data: [], error: null },
    summary_verifications: { data: [], error: null },
    glossary_terms: { data: null, error: GLOSSARY_MISSING_RELATION_ERROR },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/item/sum1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.summary.id, 'sum1');
  }, client);
});

// ---- happy path: glossary queue ----

test('GET /api/glossary/queue returns items with term/kind/citation/needs_mapping/verified fields', () => {
  const client = fakeClient({
    glossary_terms: {
      data: [
        { id: 't1', term: 'Social Security Act, Sec. 1903', kind: 'statute', citation: '42 U.S.C. 1396b', needs_mapping: false, gloss_md: 'A gloss.', status: 'draft', created_at: '2026-01-01T00:00:00Z' },
        { id: 't2', term: 'Some Popular-Name Act', kind: 'act', citation: null, needs_mapping: true, gloss_md: null, status: 'draft', created_at: '2026-01-02T00:00:00Z' },
      ],
      error: null,
    },
    glossary_verifications: {
      data: [{ term_id: 't1', overall: 'clean', verdicts: [{ supported: true }], created_at: '2026-01-03T00:00:00Z' }],
      error: null,
    },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/queue`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, true);
    assert.equal(body.items.length, 2);
    const t1 = body.items.find((it) => it.id === 't1');
    assert.equal(t1.term, 'Social Security Act, Sec. 1903');
    assert.equal(t1.kind, 'statute');
    assert.equal(t1.citation, '42 U.S.C. 1396b');
    assert.equal(t1.needs_mapping, false);
    assert.equal(t1.has_gloss, true);
    assert.equal(t1.verified, 'clean');
    const t2 = body.items.find((it) => it.id === 't2');
    assert.equal(t2.needs_mapping, true);
    assert.equal(t2.citation, null);
    assert.equal(t2.has_gloss, false);
    assert.equal(t2.verified, 'unverified');
  }, client);
});

// ---- trust model v3 mechanism 2 (auto-publish-glossary CLI): 'published' rows must stay
// queryable through /api/glossary/queue — the review page needs them for its published-count and
// sample-for-audit view, even though clean drafts now leave the review page entirely on their own ----

test('GET /api/glossary/queue queries glossary_terms with status in (draft, stale, approved, published)', () => {
  const calls = [];
  const client = fakeClient(
    { glossary_terms: { data: [], error: null } },
    (table, method, args) => calls.push({ table, method, args }),
  );
  return withServer(async (base) => {
    await fetch(`${base}/api/glossary/queue`);
    const statusFilter = calls.find((c) => c.table === 'glossary_terms' && c.method === 'in' && c.args[0] === 'status');
    assert.ok(statusFilter, 'expected a glossary_terms .in("status", [...]) call');
    assert.deepEqual(statusFilter.args[1].slice().sort(), ['approved', 'draft', 'published', 'stale']);
  }, client);
});

// ---- finding 1 integration: the queue ENDPOINTS themselves must actually page past Supabase's
// 1000-row-per-request cap, not just call selectAll's unit tests in isolation (tests/db.test.js) —
// a fake that enforces that same real server-side cap per .range() call, mirroring
// tests/db.test.js's makeCappedTableClient. Every OTHER fake in this file (fakeQuery/fakeClient)
// returns its whole canned dataset in one shot regardless of the requested range — which is exactly
// the shape of fake that let this bug ship with a fully green suite in the first place. ----

function cappedTableBuilder(rows, { serverCap = 1000 } = {}) {
  return () => {
    const filters = [];
    const orderCols = [];
    const builder = {
      select() { return this; },
      eq(col, val) { filters.push(['eq', col, val]); return this; },
      in(col, vals) { filters.push(['in', col, vals]); return this; },
      order(col) { orderCols.push(col); return this; },
      range(from, to) {
        let filtered = rows;
        for (const [kind, col, val] of filters) {
          filtered = kind === 'eq' ? filtered.filter((r) => r[col] === val) : filtered.filter((r) => val.includes(r[col]));
        }
        const sorted = [...filtered].sort((a, b) => {
          for (const col of orderCols) {
            if (a[col] < b[col]) return -1;
            if (a[col] > b[col]) return 1;
          }
          return 0;
        });
        const size = Math.min(to - from + 1, serverCap);
        return Promise.resolve({ data: sorted.slice(from, from + size), error: null });
      },
    };
    return builder;
  };
}

function fakeCappedClient(buildersByTable) {
  return { from: (table) => buildersByTable[table]() };
}

test('GET /api/glossary/queue: 1500 draft terms past the 1000-row server cap — the NEWEST term (highest created_at) is present, not silently dropped (finding 1\'s named failure mode)', () => {
  const terms = Array.from({ length: 1500 }, (_, i) => ({
    id: `t-${String(i).padStart(4, '0')}`,
    term: `Term ${i}`,
    kind: 'statute',
    citation: 'c',
    needs_mapping: false,
    gloss_md: 'g',
    status: 'draft',
    created_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  }));
  const client = fakeCappedClient({
    glossary_terms: cappedTableBuilder(terms),
    glossary_verifications: cappedTableBuilder([]),
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/queue`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 1500, 'every row must come back, not just the first 1000-row page');
    assert.ok(body.items.some((it) => it.id === 't-1499'), 'the newest term (last by created_at) must not be dropped');
  }, client);
});

test('GET /api/glossary/queue: 1200 verification rows for one term past the 1000-row cap — the newest (clean) verification wins over an older (flagged) one that would otherwise be the only page-1 hit', () => {
  const oldFlagged = Array.from({ length: 1199 }, (_, i) => ({
    term_id: 't-other', overall: 'flagged', verdicts: [{ supported: false }], created_at: new Date(2020, 0, 1, 0, 0, i).toISOString(),
  }));
  const newestClean = {
    term_id: 't1', overall: 'clean', verdicts: [{ supported: true }], created_at: '2026-06-01T00:00:00Z',
  };
  const client = fakeCappedClient({
    glossary_terms: cappedTableBuilder([
      { id: 't1', term: 'X', kind: 'statute', citation: 'c', needs_mapping: false, gloss_md: 'g', status: 'draft', created_at: '2026-01-01T00:00:00Z' },
    ]),
    glossary_verifications: cappedTableBuilder([...oldFlagged, newestClean]),
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/queue`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const t1 = body.items.find((it) => it.id === 't1');
    assert.ok(t1);
    assert.equal(t1.verified, 'clean', 'the term\'s own newest verification must win even though it sorts past the first 1000-row page');
  }, client);
});

test('GET /api/glossary/queue includes a published-status row (not just draft/stale/approved)', () => {
  const client = fakeClient({
    glossary_terms: {
      data: [{ id: 't1', term: 'X', kind: 'statute', citation: 'y', needs_mapping: false, gloss_md: 'g', status: 'published', created_at: '2026-01-01T00:00:00Z' }],
      error: null,
    },
    glossary_verifications: { data: [], error: null },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/queue`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const pub = body.items.find((it) => it.id === 't1');
    assert.ok(pub, 'published row must appear in the glossary queue response');
    assert.equal(pub.status, 'published');
  }, client);
});

test('GET /api/glossary/queue degrades verified:"unverified" (not 500) when glossary_verifications is missing', () => {
  const client = fakeClient({
    glossary_terms: {
      data: [{ id: 't1', term: 'X', kind: 'statute', citation: 'y', needs_mapping: false, gloss_md: 'g', status: 'draft', created_at: '2026-01-01T00:00:00Z' }],
      error: null,
    },
    glossary_verifications: { data: null, error: GLOSSARY_VERIFICATIONS_MISSING_ERROR },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/queue`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, true);
    assert.equal(body.items[0].verified, 'unverified');
  }, client);
});

// ---- happy path: glossary item ----

test('GET /api/glossary/item/:id returns the full term + latest verification', () => {
  const client = fakeClient({
    glossary_terms: {
      data: {
        id: 't1', term: 'Social Security Act, Sec. 1903', kind: 'statute', citation: '42 U.S.C. 1396b',
        gloss_md: 'A gloss.', supported_by_quote: 'the exact quote', source_url: 'https://uscode.house.gov/x',
        status: 'draft', needs_mapping: false, created_at: '2026-01-01T00:00:00Z', published_at: null,
      },
      error: null,
    },
    glossary_verifications: {
      data: [{ overall: 'clean', verdicts: [{ supported: true }], model: 'claude-sonnet-5', created_at: '2026-01-02T00:00:00Z' }],
      error: null,
    },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/item/t1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, true);
    assert.equal(body.term.term, 'Social Security Act, Sec. 1903');
    assert.equal(body.term.supported_by_quote, 'the exact quote');
    assert.equal(body.term.source_url, 'https://uscode.house.gov/x');
    assert.equal(body.verification.overall, 'clean');
  }, client);
});

test('GET /api/glossary/item/:id returns 404 for an unknown id', () => {
  const client = fakeClient({ glossary_terms: { data: null, error: null } });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/item/nope`);
    assert.equal(res.status, 404);
  }, client);
});

// ---- happy path: glossary decision ----

test('POST /api/glossary/decision approve: draft -> approved, writes glossary_notes with mapped action', () => {
  const calls = [];
  const client = fakeClient(
    {
      glossary_terms: { data: { id: 't1', status: 'draft' }, error: null },
      glossary_notes: { data: null, error: null },
    },
    (table, method, args) => calls.push({ table, method, args }),
  );
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term_id: 't1', action: 'approve' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'approved' });
    const noteInsert = calls.find((c) => c.table === 'glossary_notes' && c.method === 'insert');
    assert.ok(noteInsert, 'expected a glossary_notes insert');
    assert.equal(noteInsert.args[0].action, 'approved');
    assert.equal(noteInsert.args[0].term_id, 't1');
  }, client);
});

test('POST /api/glossary/decision edit: patches gloss_md, not body_md', () => {
  const calls = [];
  const client = fakeClient(
    {
      glossary_terms: { data: { id: 't1', status: 'draft' }, error: null },
      glossary_notes: { data: null, error: null },
    },
    (table, method, args) => calls.push({ table, method, args }),
  );
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term_id: 't1', action: 'edit', gloss_md: 'A revised gloss.' }),
    });
    assert.equal(res.status, 200);
    const update = calls.find((c) => c.table === 'glossary_terms' && c.method === 'update');
    assert.ok(update, 'expected a glossary_terms update');
    assert.equal(update.args[0].gloss_md, 'A revised gloss.');
    assert.equal(update.args[0].body_md, undefined);
  }, client);
});

test('POST /api/glossary/decision with an illegal transition -> 400', () => {
  const client = fakeClient({
    glossary_terms: { data: { id: 't1', status: 'draft' }, error: null },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term_id: 't1', action: 'publish' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'illegal transition' });
  }, client);
});

test('POST /api/glossary/decision for an unknown term_id -> 404', () => {
  const client = fakeClient({ glossary_terms: { data: null, error: null } });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term_id: 'nope', action: 'approve' }),
    });
    assert.equal(res.status, 404);
  }, client);
});

// ---- controller ruling 2: the publish-completeness DB CHECK is surfaced honestly, not swallowed ----

test('POST /api/glossary/decision publish on a bare stub surfaces the CHECK violation as 400, not a generic 500', () => {
  let updateCallCount = 0;
  const client = {
    from(table) {
      if (table === 'glossary_terms') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: { id: 't1', status: 'approved' }, error: null }),
          update: () => ({
            eq: async () => {
              updateCallCount += 1;
              return {
                error: {
                  code: '23514',
                  message: 'new row for relation "glossary_terms" violates check constraint "glossary_terms_published_complete"',
                },
              };
            },
          }),
        };
      }
      throw new Error(`unexpected table in this test: ${table}`);
    },
  };
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/glossary/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term_id: 't1', action: 'publish' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /gloss_md|source_url|source_hash/);
    assert.equal(updateCallCount, 1);
  }, client);
});

// ============================================================================
// Task 2 (.superpowers/sdd/2026-07-29-identity-merge/task-2-brief.md): identity review tab.
// Lance's adjudication surface for identity_flags rows link-persons.js (Task 1) writes when a
// cluster of legislator rows can't be linked automatically without risking a wrong merge.
// ============================================================================

// ---- formatCandidateDistrict / formatCandidateEraSpan (pure table-column summaries) ----

test('formatCandidateDistrict: joins chamber+district labels, deduped', () => {
  const entries = [
    { chamber: 'senate', district: '2' },
    { chamber: 'senate', district: '2' }, // duplicate label — collapsed, not doubled
    { chamber: 'house', district: '24' },
  ];
  assert.equal(formatCandidateDistrict(entries), 'senate 2, house 24');
});

test('formatCandidateDistrict: entry with chamber but no district still renders', () => {
  assert.equal(formatCandidateDistrict([{ chamber: 'senate', district: null }]), 'senate');
});

test('formatCandidateDistrict: empty/absent evidence -> honest placeholder, never blank', () => {
  assert.equal(formatCandidateDistrict([]), '(no district evidence)');
  assert.equal(formatCandidateDistrict(undefined), '(no district evidence)');
});

test('formatCandidateEraSpan: earliest start .. latest end across every entry', () => {
  const entries = [
    { start_date: '2019-01-01', end_date: '2021-01-01' },
    { start_date: '2015-01-01', end_date: '2017-01-01' },
  ];
  assert.equal(formatCandidateEraSpan(entries), '2015-01-01 – 2021-01-01');
});

test('formatCandidateEraSpan: missing bound renders as "?", never invented', () => {
  assert.equal(formatCandidateEraSpan([{ start_date: '2019-01-01', end_date: null }]), '2019-01-01 – ?');
});

test('formatCandidateEraSpan: every entry fully dateless -> honest placeholder', () => {
  assert.equal(formatCandidateEraSpan([{ start_date: null, end_date: null }]), '(no dates on file)');
  assert.equal(formatCandidateEraSpan([]), '(no dates on file)');
});

// ---- findCandidateEvidence (pulls one member's frozen flag evidence by legislatorId) ----

test('findCandidateEvidence finds the matching candidate by legislatorId', () => {
  const evidence = { reason: 'internal_contradiction', candidates: [{ legislatorId: 'a' }, { legislatorId: 'b' }] };
  assert.deepEqual(findCandidateEvidence(evidence, 'b'), { legislatorId: 'b' });
});

test('findCandidateEvidence returns null when not found or evidence is malformed', () => {
  assert.equal(findCandidateEvidence({ candidates: [{ legislatorId: 'a' }] }, 'nope'), null);
  assert.equal(findCandidateEvidence({}, 'a'), null);
  assert.equal(findCandidateEvidence(null, 'a'), null);
});

// ---- buildLanceLinkEvidence (controller ruling 4: "evidence from the flag + Lance's selection") ----

test('buildLanceLinkEvidence layers flagId/clusterKey/linkedWith/note onto the frozen candidate evidence', () => {
  const candidateEvidence = { legislatorId: 'x', fullName: 'Sherrod Brown', sourceKeys: { bioguide_id: 'B1' } };
  const result = buildLanceLinkEvidence(candidateEvidence, {
    flagId: 'flag-1', clusterKey: 'brown:x,y,z', linkedLegislatorIds: ['x', 'y', 'z'], note: 'same person, verified',
  });
  assert.equal(result.legislatorId, 'x');
  assert.equal(result.fullName, 'Sherrod Brown');
  assert.deepEqual(result.sourceKeys, { bioguide_id: 'B1' });
  assert.equal(result.flagId, 'flag-1');
  assert.equal(result.clusterKey, 'brown:x,y,z');
  assert.deepEqual(result.linkedWith, ['y', 'z'], 'excludes the row\'s own id from its own linked-with list');
  assert.equal(result.note, 'same person, verified');
});

test('buildLanceLinkEvidence tolerates a null candidateEvidence (defensive, never throws)', () => {
  const result = buildLanceLinkEvidence(null, { flagId: 'f1', clusterKey: 'k', linkedLegislatorIds: ['x', 'y'], note: null });
  assert.deepEqual(result.linkedWith, ['x', 'y']);
  assert.equal(result.note, null);
});

// ---- appendResolution (identity_flags has no notes table — audit lives in evidence.resolutions) ----

test('appendResolution appends the first resolution while preserving reason/candidates', () => {
  const evidence = { reason: 'ambiguous_era', candidates: [{ legislatorId: 'a' }] };
  const result = appendResolution(evidence, { action: 'keep-separate', legislatorIds: 'all', note: 'two real people' }, '2026-07-29T00:00:00Z');
  assert.equal(result.reason, 'ambiguous_era');
  assert.deepEqual(result.candidates, [{ legislatorId: 'a' }]);
  assert.equal(result.resolutions.length, 1);
  assert.deepEqual(result.resolutions[0], {
    action: 'keep-separate', legislatorIds: 'all', note: 'two real people', decidedBy: 'lance', decidedAt: '2026-07-29T00:00:00Z',
  });
});

test('appendResolution appends onto an existing resolutions array (per-subset link history)', () => {
  const evidence = { reason: 'internal_contradiction', candidates: [], resolutions: [{ action: 'link', legislatorIds: ['a', 'b'] }] };
  const result = appendResolution(evidence, { action: 'link', legislatorIds: ['c', 'd'] }, '2026-07-29T01:00:00Z');
  assert.equal(result.resolutions.length, 2);
  assert.deepEqual(result.resolutions[0], { action: 'link', legislatorIds: ['a', 'b'] });
  assert.equal(result.resolutions[1].legislatorIds.join(','), 'c,d');
});

// ---- validateIdentityDecisionInput (controller rulings 1 + 4) ----

test('validateIdentityDecisionInput: link with fewer than 2 ids is invalid', () => {
  assert.match(validateIdentityDecisionInput({ action: 'link', legislator_ids: ['a'] }), /at least 2/);
  assert.match(validateIdentityDecisionInput({ action: 'link', legislator_ids: [] }), /at least 2/);
  assert.match(validateIdentityDecisionInput({ action: 'link' }), /at least 2/);
});

test('validateIdentityDecisionInput: link with duplicate ids is invalid', () => {
  assert.match(validateIdentityDecisionInput({ action: 'link', legislator_ids: ['a', 'a'] }), /duplicate/);
});

test('validateIdentityDecisionInput: link with 2+ unique ids is valid', () => {
  assert.equal(validateIdentityDecisionInput({ action: 'link', legislator_ids: ['a', 'b'] }), null);
});

test('validateIdentityDecisionInput: keep-separate without a note is invalid', () => {
  assert.match(validateIdentityDecisionInput({ action: 'keep-separate' }), /note is required/);
  assert.match(validateIdentityDecisionInput({ action: 'keep-separate', note: '' }), /note is required/);
});

test('validateIdentityDecisionInput: keep-separate with a note is valid', () => {
  assert.equal(validateIdentityDecisionInput({ action: 'keep-separate', note: 'two unrelated Browns' }), null);
});

test('validateIdentityDecisionInput: unknown action is invalid', () => {
  assert.match(validateIdentityDecisionInput({ action: 'merge-everything' }), /unknown action/);
});

// ---- validateIdentityDecisionInput: 'attach' (Task 4, attach-to-existing) ----

test('validateIdentityDecisionInput: attach with zero ids is invalid', () => {
  assert.match(validateIdentityDecisionInput({ action: 'attach', legislator_ids: [], person_id: 'p1' }), /at least 1/);
  assert.match(validateIdentityDecisionInput({ action: 'attach', person_id: 'p1' }), /at least 1/);
});

test('validateIdentityDecisionInput: attach with a SINGLE id is valid — contrast link\'s 2+ minimum', () => {
  assert.equal(validateIdentityDecisionInput({ action: 'attach', legislator_ids: ['a'], person_id: 'p1' }), null);
});

test('validateIdentityDecisionInput: attach with duplicate ids is invalid', () => {
  assert.match(validateIdentityDecisionInput({ action: 'attach', legislator_ids: ['a', 'a'], person_id: 'p1' }), /duplicate/);
});

test('validateIdentityDecisionInput: attach without person_id is invalid', () => {
  assert.match(validateIdentityDecisionInput({ action: 'attach', legislator_ids: ['a'] }), /person_id is required/);
  assert.match(validateIdentityDecisionInput({ action: 'attach', legislator_ids: ['a'], person_id: '' }), /person_id is required/);
});

// ---- buildLanceAttachEvidence (Task 4): reuses buildLanceLinkEvidence verbatim + attachedToPersonId ----

test('buildLanceAttachEvidence: starts from the candidate\'s frozen flag evidence, layers flagId/clusterKey/linkedWith/note (identical to buildLanceLinkEvidence), plus attachedToPersonId', () => {
  const candidateEvidence = { legislatorId: 'leg-fifth', fullName: 'Robert Onder', surnameKeyUsed: 'onder' };
  const result = buildLanceAttachEvidence(candidateEvidence, {
    flagId: 'flag-1', clusterKey: 'attach:person-onder-1:leg-fifth', linkedLegislatorIds: ['leg-fifth'], personId: 'person-onder-1', note: 'same Bob Onder',
  });
  assert.deepEqual(result, {
    legislatorId: 'leg-fifth',
    fullName: 'Robert Onder',
    surnameKeyUsed: 'onder',
    flagId: 'flag-1',
    clusterKey: 'attach:person-onder-1:leg-fifth',
    linkedWith: [],
    note: 'same Bob Onder',
    attachedToPersonId: 'person-onder-1',
  });
});

test('buildLanceAttachEvidence: no candidate evidence found -> starts from {} (same fallback as buildLanceLinkEvidence)', () => {
  const result = buildLanceAttachEvidence(null, {
    flagId: 'flag-1', clusterKey: 'k', linkedLegislatorIds: ['leg-a', 'leg-b'], personId: 'person-1', note: null,
  });
  assert.deepEqual(result, {
    flagId: 'flag-1', clusterKey: 'k', linkedWith: ['leg-a', 'leg-b'], note: null, attachedToPersonId: 'person-1',
  });
});

// ---- route-level fake client: identity_flags / legislators / vote_casts / persons / person_links ----
//
// A purpose-built fake (not the generic fakeQuery/fakeClient above): unlike every other route in
// this file, the identity routes need PER-ID variation from the same table across a single
// request (a cast count per candidate, a live person_id per candidate, a targeted legislators
// lookup by a specific id subset) — the generic fixed-canned-result fake can't express that.

const MISSING_IDENTITY_FLAGS_ERROR = {
  code: 'PGRST205',
  message: "Could not find the table 'public.identity_flags' in the schema cache",
};

function identityFakeClient({
  flags = [],
  legislatorsById = new Map(),
  castCountsByLegislatorId = new Map(),
  identityFlagsMissing = false,
  newPersonId = 'person-new-1',
  // TOCTOU guard test seams (final wave, item 3): `raceOnLegislatorUpdateFor` flips the named
  // legislator's person_id to a rival value right BEFORE the guarded update's own
  // .is('person_id', null) filter is evaluated — this is the precise "a second writer won the
  // race in the gap between the pre-check SELECT and this write" interleave, not merely a
  // pre-seeded already-linked row (which the EARLIER pre-check loop would catch first, never even
  // reaching the write). `raceOnPersonLinksFor` makes that legislator's person_links insert return
  // a 23505 instead of succeeding — the race caught one step later, after the legislators guard
  // itself passed.
  raceOnLegislatorUpdateFor = null,
  raceOnPersonLinksFor = null,
  // failCleanupDelete (micro-round, re-review): makes the orphan-cleanup persons.delete() itself
  // return an error, the exact scenario the re-reviewer proved by execution the route never
  // checked for.
  failCleanupDelete = false,
  // existingPersonIds (Task 4, attach-to-existing): the set of person_id values the 'attach'
  // route's own persons.select().eq('id',...).maybeSingle() existence check should find — real
  // Supabase would 404-equivalent (null row) for any id that isn't an actual persons row; a test
  // exercising 'attach' seeds the target person's id here, same as legislatorsById seeds the
  // legislators table.
  existingPersonIds = [],
} = {}, onCall) {
  const personIdSet = new Set(existingPersonIds);
  const record = (table, method, args) => { if (onCall) onCall(table, method, args); };
  // Real Supabase generates a fresh uuid per insert; a fixed canned id would make every 'link'
  // decision within the same test collapse onto the SAME person (masking a real bug — see the
  // 14-candidate lifecycle test, which links two independent subsets and must see two DIFFERENT
  // person ids). Scoped at the client level (not inside from('persons')) so it persists across
  // multiple decision requests against one identityFakeClient instance.
  let personInsertCount = 0;
  // insertedPersonIds/deletedPersonIds (final wave, item 3): tracked so a test can assert the
  // TOCTOU guard's own cleanup (deleting an orphaned persons row when nothing has linked to it
  // yet) actually happened, not just that the route returned 409.
  const insertedPersonIds = [];
  const deletedPersonIds = [];

  return {
    insertedPersonIds,
    deletedPersonIds,
    from(table) {
      if (table === 'identity_flags') {
        return {
          select(cols) {
            record(table, 'select', [cols]);
            const st = { filters: [] };
            return {
              eq(col, val) { record(table, 'eq', [col, val]); st.filters.push([col, val]); return this; },
              order(col, opts) { record(table, 'order', [col, opts]); return this; },
              range(from, to) {
                record(table, 'range', [from, to]);
                if (identityFlagsMissing) return Promise.resolve({ data: null, error: MISSING_IDENTITY_FLAGS_ERROR });
                let rows = flags;
                for (const [col, val] of st.filters) rows = rows.filter((r) => r[col] === val);
                return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
              },
              maybeSingle() {
                record(table, 'maybeSingle', []);
                if (identityFlagsMissing) return Promise.resolve({ data: null, error: MISSING_IDENTITY_FLAGS_ERROR });
                let rows = flags;
                for (const [col, val] of st.filters) rows = rows.filter((r) => r[col] === val);
                return Promise.resolve({ data: rows[0] ?? null, error: null });
              },
            };
          },
          update(patch) {
            record(table, 'update', [patch]);
            return {
              eq: (col, val) => {
                record(table, 'eq', [col, val]);
                const flag = flags.find((f) => f[col] === val);
                if (flag) Object.assign(flag, patch);
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      }

      if (table === 'legislators') {
        return {
          select(cols) {
            record(table, 'select', [cols]);
            const st = { ids: null };
            const builder = {
              in(col, ids) { record(table, 'in', [col, ids]); st.ids = ids; return this; },
              order(col, opts) { record(table, 'order', [col, opts]); return this; },
              range(from, to) {
                record(table, 'range', [from, to]);
                const all = [...legislatorsById.values()];
                return Promise.resolve({ data: all.slice(from, to + 1), error: null });
              },
              then(resolve, reject) {
                const rows = st.ids
                  ? st.ids.map((id) => legislatorsById.get(id)).filter(Boolean)
                  : [...legislatorsById.values()];
                return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
              },
            };
            return builder;
          },
          update(patch) {
            record(table, 'update', [patch]);
            return {
              eq: (col, val) => {
                record(table, 'eq', [col, val]);
                return {
                  is: (isCol, isVal) => {
                    record(table, 'is', [isCol, isVal]);
                    return {
                      select: (selCols) => {
                        record(table, 'select', [selCols]);
                        if (raceOnLegislatorUpdateFor === val) {
                          // Simulate: a concurrent writer wins the race right before THIS
                          // update's own guard is evaluated.
                          const raced = legislatorsById.get(val);
                          if (raced) raced.person_id = 'person-rival';
                        }
                        const row = legislatorsById.get(val);
                        const guardFails = !row || (isCol === 'person_id' && isVal === null && row.person_id !== null);
                        if (guardFails) return Promise.resolve({ data: [], error: null });
                        Object.assign(row, patch);
                        return Promise.resolve({ data: [{ id: row.id }], error: null });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === 'vote_casts') {
        return {
          select(cols, opts) {
            record(table, 'select', [cols, opts]);
            return {
              eq: (col, val) => {
                record(table, 'eq', [col, val]);
                return Promise.resolve({ data: null, error: null, count: castCountsByLegislatorId.get(val) ?? 0 });
              },
            };
          },
        };
      }

      if (table === 'persons') {
        return {
          // select().eq('id',...).maybeSingle() — Task 4's 'attach' route existence check ONLY;
          // the pre-existing insert()/delete() below are untouched, still the 'link' route's shape.
          select(cols) {
            record(table, 'select', [cols]);
            return {
              eq(col, val) {
                record(table, 'eq', [col, val]);
                return {
                  maybeSingle() {
                    record(table, 'maybeSingle', []);
                    return Promise.resolve({ data: personIdSet.has(val) ? { id: val } : null, error: null });
                  },
                };
              },
            };
          },
          insert(row) {
            record(table, 'insert', [row]);
            personInsertCount += 1;
            const id = personInsertCount === 1 ? newPersonId : `${newPersonId}-${personInsertCount}`;
            insertedPersonIds.push(id);
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id }, error: null }),
              }),
            };
          },
          delete() {
            record(table, 'delete', []);
            return {
              eq: (col, val) => {
                record(table, 'eq', [col, val]);
                if (failCleanupDelete) {
                  return Promise.resolve({ error: { message: 'simulated cleanup delete failure' } });
                }
                if (col === 'id') deletedPersonIds.push(val);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }

      if (table === 'person_links') {
        return {
          insert(row) {
            record(table, 'insert', [row]);
            if (raceOnPersonLinksFor === row.legislator_id) {
              return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "person_links_legislator_id_key"' } });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      }

      throw new Error(`identityFakeClient: unexpected table in this test: ${table}`);
    },
  };
}

// ---- GET /api/identity/queue ----

test('GET /api/identity/queue degrades to {available:false} (200, not 500) when identity_flags is missing (pre-0012)', () => {
  const client = identityFakeClient({ identityFlagsMissing: true });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/queue`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, false);
    assert.match(body.reason, /0012/);
    assert.deepEqual(body.items, []);
  }, client);
});

test('GET /api/identity/queue: zero unresolved flags is a valid, empty render', () => {
  const client = identityFakeClient({ flags: [] });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/queue`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { available: true, items: [] });
  }, client);
});

test('GET /api/identity/queue with no DB client configured returns a clean 500, not a crash', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/identity/queue`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'internal error' });
}));

test('GET /api/identity/queue happy path: full_name, source_keys, district, era_span, cast_count all present', () => {
  const flag = {
    id: 'flag-1',
    cluster_key: 'brown:leg-a,leg-b',
    resolved: false,
    created_at: '2026-07-29T00:00:00Z',
    evidence: {
      reason: 'internal_contradiction',
      candidates: [
        {
          legislatorId: 'leg-a', fullName: 'Sherrod Brown',
          sourceKeys: { bioguide_id: 'B000944', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null },
          chamberDistrictEra: [{ source: 'terms', jurisdiction_id: 'us-congress', chamber: 'senate', district: null, start_date: '2007-01-04', end_date: null }],
        },
        {
          legislatorId: 'leg-b', fullName: 'Hank Brown',
          sourceKeys: { bioguide_id: 'B000944', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null },
          chamberDistrictEra: [{ source: 'terms', jurisdiction_id: 'us-congress', chamber: 'senate', district: null, start_date: '1991-01-03', end_date: '1997-01-03' }],
        },
      ],
    },
  };
  const legislatorsById = new Map([
    ['leg-a', { id: 'leg-a', person_id: null }],
    ['leg-b', { id: 'leg-b', person_id: null }],
  ]);
  const castCountsByLegislatorId = new Map([['leg-a', 4200], ['leg-b', 900]]);
  const client = identityFakeClient({ flags: [flag], legislatorsById, castCountsByLegislatorId });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/queue`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, true);
    assert.equal(body.items.length, 1);
    const item = body.items[0];
    assert.equal(item.id, 'flag-1');
    assert.equal(item.cluster_key, 'brown:leg-a,leg-b');
    assert.equal(item.reason, 'internal_contradiction');
    assert.equal(item.candidates.length, 2);
    const a = item.candidates.find((c) => c.legislator_id === 'leg-a');
    assert.equal(a.full_name, 'Sherrod Brown');
    assert.deepEqual(a.source_keys, { bioguide_id: 'B000944', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null });
    assert.equal(a.district, 'senate');
    assert.equal(a.era_span, '2007-01-04 – ?');
    assert.equal(a.cast_count, 4200);
    assert.equal(a.already_linked, false);
    assert.equal(a.linked_person_id, null);
    const b = item.candidates.find((c) => c.legislator_id === 'leg-b');
    assert.equal(b.era_span, '1991-01-03 – 1997-01-03');
    assert.equal(b.cast_count, 900);
    assert.equal(item.existing_person, null, 'a normal (non-attach) flag carries no existing_person');
  }, client);
});

test('GET /api/identity/queue: an attach_candidate flag surfaces existing_person (the EXISTING person\'s id + display_name, buildAttachFlags\' own evidence) so the review tab can target the "Attach" decision without a second lookup', () => {
  const flag = {
    id: 'flag-1', cluster_key: 'attach:person-onder-1:leg-fifth', resolved: false, created_at: '2026-07-29T00:00:00Z',
    evidence: {
      reason: 'attach_candidate',
      existingPerson: { personId: 'person-onder-1', displayName: 'Robert F. Onder' },
      candidates: [{
        legislatorId: 'leg-fifth', fullName: 'Robert Onder', sourceKeys: { legiscan_people_id: 99999 }, chamberDistrictEra: [],
      }],
    },
  };
  const legislatorsById = new Map([['leg-fifth', { id: 'leg-fifth', person_id: null }]]);
  const client = identityFakeClient({ flags: [flag], legislatorsById });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/queue`);
    const body = await res.json();
    assert.equal(body.items.length, 1);
    const item = body.items[0];
    assert.equal(item.reason, 'attach_candidate');
    assert.deepEqual(item.existing_person, { personId: 'person-onder-1', displayName: 'Robert F. Onder' });
  }, client);
});

test('GET /api/identity/queue: a flag whose candidates are ALL already person_id-linked is hidden (controller ruling 2, self-healing display)', () => {
  const flag = {
    id: 'flag-1', cluster_key: 'k', resolved: false, created_at: '2026-07-29T00:00:00Z',
    evidence: { reason: 'ambiguous_era', candidates: [{ legislatorId: 'leg-a', fullName: 'X', sourceKeys: {}, chamberDistrictEra: [] }, { legislatorId: 'leg-b', fullName: 'Y', sourceKeys: {}, chamberDistrictEra: [] }] },
  };
  const legislatorsById = new Map([
    ['leg-a', { id: 'leg-a', person_id: 'person-1' }],
    ['leg-b', { id: 'leg-b', person_id: 'person-1' }],
  ]);
  const client = identityFakeClient({ flags: [flag], legislatorsById });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/queue`);
    const body = await res.json();
    assert.deepEqual(body.items, [], 'fully-linked flag must not appear in the queue');
  }, client);
});

test('GET /api/identity/queue: a flag with SOME (not all) candidates already linked still appears, per-candidate already_linked marked correctly', () => {
  const flag = {
    id: 'flag-1', cluster_key: 'k', resolved: false, created_at: '2026-07-29T00:00:00Z',
    evidence: {
      reason: 'internal_contradiction',
      candidates: [
        { legislatorId: 'leg-a', fullName: 'X', sourceKeys: {}, chamberDistrictEra: [] },
        { legislatorId: 'leg-b', fullName: 'Y', sourceKeys: {}, chamberDistrictEra: [] },
        { legislatorId: 'leg-c', fullName: 'Z', sourceKeys: {}, chamberDistrictEra: [] },
      ],
    },
  };
  const legislatorsById = new Map([
    ['leg-a', { id: 'leg-a', person_id: 'person-1' }],
    ['leg-b', { id: 'leg-b', person_id: 'person-1' }],
    ['leg-c', { id: 'leg-c', person_id: null }],
  ]);
  const client = identityFakeClient({ flags: [flag], legislatorsById });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/queue`);
    const body = await res.json();
    assert.equal(body.items.length, 1, 'partially-linked flag stays in the queue (remaining candidates need a decision)');
    const candidates = body.items[0].candidates;
    assert.equal(candidates.find((c) => c.legislator_id === 'leg-a').already_linked, true);
    assert.equal(candidates.find((c) => c.legislator_id === 'leg-a').linked_person_id, 'person-1');
    assert.equal(candidates.find((c) => c.legislator_id === 'leg-c').already_linked, false);
  }, client);
});

// ---- POST /api/identity/decision: CSRF + degradation + validation ----

test('POST /api/identity/decision: Content-Type text/plain -> 403 (same CSRF vector as every other decision route)', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/identity/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ flag_id: 'f1', action: 'keep-separate', note: 'x' }),
  });
  assert.equal(res.status, 403);
}));

test('POST /api/identity/decision: foreign Origin -> 403', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/identity/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ flag_id: 'f1', action: 'keep-separate', note: 'x' }),
  });
  assert.equal(res.status, 403);
}));

test('POST /api/identity/decision degrades honestly to a literal 503 (not 500, not 403) when identity_flags is missing', () => {
  const client = identityFakeClient({ identityFlagsMissing: true });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'f1', action: 'keep-separate', note: 'x' }),
    });
    // Fix round 1, minor 2: assert the literal status code, not just "not 500/403" — 503 is the
    // deliberate choice (service temporarily unavailable pending the migration), distinct from the
    // GET queue route's own degradation, which is a 200 by design (see handleIdentityQueue).
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /0012/);
  }, client);
});

test('POST /api/identity/decision: missing flag_id -> 400', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/identity/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'keep-separate', note: 'x' }),
  });
  assert.equal(res.status, 400);
}));

test('POST /api/identity/decision: link with fewer than 2 legislator_ids -> 400', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/identity/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flag_id: 'f1', action: 'link', legislator_ids: ['a'] }),
  });
  assert.equal(res.status, 400);
}));

test('POST /api/identity/decision: keep-separate without a note -> 400', () => withServer(async (base) => {
  const res = await fetch(`${base}/api/identity/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flag_id: 'f1', action: 'keep-separate' }),
  });
  assert.equal(res.status, 400);
}));

test('POST /api/identity/decision: unknown flag_id -> 404', () => {
  const client = identityFakeClient({ flags: [] });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'nope', action: 'keep-separate', note: 'x' }),
    });
    assert.equal(res.status, 404);
  }, client);
});

test('POST /api/identity/decision: already-resolved flag -> 400', () => {
  const flag = { id: 'f1', cluster_key: 'k', resolved: true, evidence: { reason: 'ambiguous_era', candidates: [] }, candidate_legislator_ids: [] };
  const client = identityFakeClient({ flags: [flag] });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'f1', action: 'keep-separate', note: 'x' }),
    });
    assert.equal(res.status, 400);
  }, client);
});

// ---- POST /api/identity/decision: keep-separate happy path ----

test('POST /api/identity/decision keep-separate: resolves the flag with a note, evidence.resolutions records the ACTUAL still-unlinked ids (fix round 1, minor 1 — not the literal \'all\'), writes NOTHING to persons/person_links', () => {
  const flag = {
    id: 'f1', cluster_key: 'brown:a,b,c', resolved: false,
    candidate_legislator_ids: ['leg-a', 'leg-b', 'leg-c'],
    evidence: { reason: 'ambiguous_era', candidates: [{ legislatorId: 'leg-a' }, { legislatorId: 'leg-b' }, { legislatorId: 'leg-c' }] },
  };
  // leg-a was already linked by an earlier partial decision on this same flag; leg-b/leg-c never
  // were — the audit entry must name only the latter two, proving this isn't just the original
  // candidate_legislator_ids echoed back.
  const legislatorsById = new Map([
    ['leg-a', { id: 'leg-a', person_id: 'person-earlier' }],
    ['leg-b', { id: 'leg-b', person_id: null }],
    ['leg-c', { id: 'leg-c', person_id: null }],
  ]);
  const calls = [];
  const client = identityFakeClient({ flags: [flag], legislatorsById }, (table, method, args) => calls.push({ table, method, args }));
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'f1', action: 'keep-separate', note: 'leg-b and leg-c are unrelated Browns' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { resolved: true });
    assert.equal(flag.resolved, true, 'the fake\'s own flag row was mutated to resolved:true');
    assert.equal(flag.evidence.resolutions.length, 1);
    assert.equal(flag.evidence.resolutions[0].action, 'keep-separate');
    assert.deepEqual(
      flag.evidence.resolutions[0].legislatorIds.slice().sort(),
      ['leg-b', 'leg-c'],
      'only the STILL-unlinked ids are recorded — leg-a was already linked before this decision, and must not be re-claimed by it',
    );
    assert.equal(flag.evidence.resolutions[0].note, 'leg-b and leg-c are unrelated Browns');
    assert.equal(flag.evidence.resolutions[0].decidedBy, 'lance');
    assert.ok(!calls.some((c) => c.table === 'persons'), 'keep-separate must never touch persons');
    assert.ok(!calls.some((c) => c.table === 'person_links'), 'keep-separate must never touch person_links');
  }, client);
});

// ---- POST /api/identity/decision: link happy path (whole flag in one subset -> fully resolved) ----

test('POST /api/identity/decision link: writes persons (display-name precedence), legislators.person_id patches, person_links (decided_by lance), and resolves the flag when every candidate is now linked', () => {
  const flag = {
    id: 'f1', cluster_key: 'onder:a,b', resolved: false,
    candidate_legislator_ids: ['leg-a', 'leg-b'],
    evidence: {
      reason: 'internal_contradiction',
      candidates: [
        { legislatorId: 'leg-a', fullName: 'Onder, Robert F.', sourceKeys: { bioguide_id: 'O000177' }, chamberDistrictEra: [] },
        { legislatorId: 'leg-b', fullName: 'Bob Onder', sourceKeys: { mo_senate_id: '2' }, chamberDistrictEra: [] },
      ],
    },
  };
  const legislatorsById = new Map([
    ['leg-a', {
      id: 'leg-a', full_name: 'Onder, Robert F.', bioguide_id: 'O000177', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
    ['leg-b', {
      id: 'leg-b', full_name: 'Bob Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: '2', legiscan_people_id: null, person_id: null,
    }],
  ]);
  const calls = [];
  const client = identityFakeClient(
    { flags: [flag], legislatorsById, newPersonId: 'person-onder-1' },
    (table, method, args) => calls.push({ table, method, args }),
  );
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'f1', action: 'link', legislator_ids: ['leg-a', 'leg-b'], note: 'same Robert "Bob" Onder' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.person_id, 'person-onder-1');
    assert.equal(body.resolved, true, 'both candidates were in this one link decision, so the flag is fully resolved');

    const personInsert = calls.find((c) => c.table === 'persons' && c.method === 'insert');
    assert.ok(personInsert);
    // bioguide beats mo_senate in display-name precedence (pickDisplayName, imported from
    // src/lib/person-identity.js) — 'Onder, Robert F.' reorders to 'Robert F. Onder'.
    assert.equal(personInsert.args[0].display_name, 'Robert F. Onder');
    assert.equal(personInsert.args[0].display_name_source, 'bioguide');

    const legUpdates = calls.filter((c) => c.table === 'legislators' && c.method === 'update');
    assert.equal(legUpdates.length, 2);
    for (const u of legUpdates) assert.equal(u.args[0].person_id, 'person-onder-1');
    assert.equal(legislatorsById.get('leg-a').person_id, 'person-onder-1');
    assert.equal(legislatorsById.get('leg-b').person_id, 'person-onder-1');

    const linkInserts = calls.filter((c) => c.table === 'person_links' && c.method === 'insert');
    assert.equal(linkInserts.length, 2);
    for (const li of linkInserts) {
      assert.equal(li.args[0].decided_by, 'lance');
      assert.equal(li.args[0].person_id, 'person-onder-1');
      assert.equal(li.args[0].evidence.flagId, 'f1');
      assert.equal(li.args[0].evidence.clusterKey, 'onder:a,b');
      assert.equal(li.args[0].evidence.note, 'same Robert "Bob" Onder');
    }
    const aLink = linkInserts.find((li) => li.args[0].legislator_id === 'leg-a');
    assert.deepEqual(aLink.args[0].evidence.linkedWith, ['leg-b']);

    const flagUpdate = calls.find((c) => c.table === 'identity_flags' && c.method === 'update');
    assert.equal(flagUpdate.args[0].resolved, true);
    assert.equal(flag.resolved, true);
  }, client);
});

// ---- POST /api/identity/decision: PER-SUBSET link (controller ruling 1) — a 3-candidate flag,
// Lance links only 2 of them; the 3rd stays in the flag, unresolved ----

test('POST /api/identity/decision link (per-subset): linking 2 of 3 candidates leaves the flag unresolved, third candidate untouched', () => {
  const flag = {
    id: 'f1', cluster_key: 'smith:a,b,c', resolved: false,
    candidate_legislator_ids: ['leg-a', 'leg-b', 'leg-c'],
    evidence: {
      reason: 'internal_contradiction',
      candidates: [
        { legislatorId: 'leg-a', fullName: 'Smith A', sourceKeys: {}, chamberDistrictEra: [] },
        { legislatorId: 'leg-b', fullName: 'Smith B', sourceKeys: {}, chamberDistrictEra: [] },
        { legislatorId: 'leg-c', fullName: 'Smith C', sourceKeys: {}, chamberDistrictEra: [] },
      ],
    },
  };
  const legislatorsById = new Map([
    ['leg-a', {
      id: 'leg-a', full_name: 'Smith A', bioguide_id: 'S1', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
    ['leg-b', {
      id: 'leg-b', full_name: 'Smith B', bioguide_id: 'S2', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
    ['leg-c', {
      id: 'leg-c', full_name: 'Smith C', bioguide_id: 'S3', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
  ]);
  const calls = [];
  const client = identityFakeClient(
    { flags: [flag], legislatorsById },
    (table, method, args) => calls.push({ table, method, args }),
  );
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'f1', action: 'link', legislator_ids: ['leg-a', 'leg-b'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resolved, false, 'leg-c is still unlinked, so the whole flag cannot resolve yet');

    assert.equal(legislatorsById.get('leg-a').person_id, body.person_id);
    assert.equal(legislatorsById.get('leg-b').person_id, body.person_id);
    assert.equal(legislatorsById.get('leg-c').person_id, null, 'the third candidate was never touched by this decision');

    assert.equal(flag.resolved, false, 'the flag itself must stay unresolved — remaining candidates stay in the flag (ruling 1)');
    const flagUpdate = calls.find((c) => c.table === 'identity_flags' && c.method === 'update');
    assert.ok(flagUpdate, 'the flag is still patched (its evidence.resolutions audit trail grows) even though resolved stays false');
    assert.notEqual(flagUpdate.args[0].resolved, true);
  }, client);
});

// ---- POST /api/identity/decision: legislator_ids outside the flag's own candidate set -> 400 ----

test('POST /api/identity/decision link: a legislator_id not among this flag\'s candidates -> 400, nothing written', () => {
  const flag = {
    id: 'f1', cluster_key: 'k', resolved: false,
    candidate_legislator_ids: ['leg-a', 'leg-b'],
    evidence: { reason: 'internal_contradiction', candidates: [{ legislatorId: 'leg-a' }, { legislatorId: 'leg-b' }] },
  };
  const calls = [];
  const client = identityFakeClient({ flags: [flag] }, (table, method, args) => calls.push({ table, method, args }));
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'f1', action: 'link', legislator_ids: ['leg-a', 'leg-outsider'] }),
    });
    assert.equal(res.status, 400);
    assert.ok(!calls.some((c) => c.table === 'persons'));
  }, client);
});

// ---- POST /api/identity/decision: conflict-throw path intact (controller ruling 4) ----

test('POST /api/identity/decision link: a selected legislator already carrying a person_id -> 409, zero writes (conflict-throw path)', () => {
  const flag = {
    id: 'f1', cluster_key: 'k', resolved: false,
    candidate_legislator_ids: ['leg-a', 'leg-b'],
    evidence: { reason: 'internal_contradiction', candidates: [{ legislatorId: 'leg-a' }, { legislatorId: 'leg-b' }] },
  };
  const legislatorsById = new Map([
    ['leg-a', {
      id: 'leg-a', full_name: 'X', bioguide_id: 'X1', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: 'already-linked-elsewhere',
    }],
    ['leg-b', {
      id: 'leg-b', full_name: 'Y', bioguide_id: 'Y1', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
  ]);
  const calls = [];
  const client = identityFakeClient({ flags: [flag], legislatorsById }, (table, method, args) => calls.push({ table, method, args }));
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'f1', action: 'link', legislator_ids: ['leg-a', 'leg-b'] }),
    });
    assert.equal(res.status, 409);
    assert.ok(!calls.some((c) => c.table === 'persons'), 'no person row created once a conflict is found');
    assert.ok(!calls.some((c) => c.table === 'person_links'), 'no link rows written once a conflict is found');
    assert.equal(legislatorsById.get('leg-b').person_id, null, 'leg-b (checked, no conflict) still never got written — the whole decision aborts before any write');
  }, client);
});

// ---- FINAL WAVE, item 3: TOCTOU guard — the pre-check loop validates person_id===null against a
// SELECT snapshot; these tests prove the SEPARATE guarded-write race (a concurrent writer wins
// the race in the gap between that snapshot and this route's own write) is caught too, not just
// the already-linked-at-snapshot-time case the test above covers. ----

test('POST /api/identity/decision link: double-submit interleave — the SECOND member loses the guarded update to a concurrent writer -> 409, the first member\'s real link stays (honest partial state), the just-created person is NOT deleted (something already links to it)', () => {
  const flag = {
    id: 'f1', cluster_key: 'k', resolved: false,
    candidate_legislator_ids: ['leg-a', 'leg-b'],
    evidence: { reason: 'internal_contradiction', candidates: [{ legislatorId: 'leg-a' }, { legislatorId: 'leg-b' }] },
  };
  const legislatorsById = new Map([
    ['leg-a', {
      id: 'leg-a', full_name: 'X', bioguide_id: 'X1', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
    ['leg-b', {
      id: 'leg-b', full_name: 'Y', bioguide_id: 'Y1', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
  ]);
  const client = identityFakeClient({
    flags: [flag], legislatorsById, raceOnLegislatorUpdateFor: 'leg-b',
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'f1', action: 'link', legislator_ids: ['leg-a', 'leg-b'] }),
    });
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.match(body.error, /concurrent/);
    assert.equal(legislatorsById.get('leg-a').person_id, 'person-new-1', 'leg-a already got a real link before the race was detected — left as-is, an honest partial state');
    assert.equal(legislatorsById.get('leg-b').person_id, 'person-rival', 'leg-b was linked by the simulated concurrent writer, never overwritten by this request');
    assert.deepEqual(client.deletedPersonIds, [], 'the person is NOT deleted — leg-a genuinely links to it');
  }, client);
});

test('POST /api/identity/decision link: double-submit interleave — the FIRST (and only) member loses the guarded update -> 409, the just-created orphaned person IS deleted (nothing links to it yet)', () => {
  const flag = {
    id: 'f1', cluster_key: 'k', resolved: false,
    candidate_legislator_ids: ['leg-a', 'leg-b'],
    evidence: { reason: 'internal_contradiction', candidates: [{ legislatorId: 'leg-a' }, { legislatorId: 'leg-b' }] },
  };
  const legislatorsById = new Map([
    ['leg-a', {
      id: 'leg-a', full_name: 'X', bioguide_id: 'X1', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
    ['leg-b', {
      id: 'leg-b', full_name: 'Y', bioguide_id: 'Y1', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
  ]);
  const client = identityFakeClient({
    flags: [flag], legislatorsById, raceOnLegislatorUpdateFor: 'leg-a',
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'f1', action: 'link', legislator_ids: ['leg-a', 'leg-b'] }),
    });
    assert.equal(res.status, 409);
    assert.equal(legislatorsById.get('leg-a').person_id, 'person-rival', 'raced away by the simulated concurrent writer');
    assert.equal(legislatorsById.get('leg-b').person_id, null, 'never reached — the loop aborted on leg-a first');
    assert.deepEqual(client.insertedPersonIds, ['person-new-1']);
    assert.deepEqual(client.deletedPersonIds, ['person-new-1'], 'the orphaned person (zero links landed) is cleaned up rather than left stranded');
  }, client);
});

// Micro-round (re-review, execution-proven): the orphan-cleanup persons.delete() call never
// checked its own error return — a failed cleanup silently stranded an anon-readable orphaned
// persons row while the client still got a clean, unremarkable 409. Fixed to surface it honestly
// on BOTH sides: the 409 response body itself, and a server-side console.error (this file's own
// established convention for an unexpected condition — sendServerError's `[review-server]
// <context>:` prefix).
test('POST /api/identity/decision link: the orphan-cleanup delete ITSELF failing -> 409 body carries the cleanup-failed notice, server logs it', () => {
  const flag = {
    id: 'f1', cluster_key: 'k', resolved: false,
    candidate_legislator_ids: ['leg-a', 'leg-b'],
    evidence: { reason: 'internal_contradiction', candidates: [{ legislatorId: 'leg-a' }, { legislatorId: 'leg-b' }] },
  };
  const legislatorsById = new Map([
    ['leg-a', {
      id: 'leg-a', full_name: 'X', bioguide_id: 'X1', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
    ['leg-b', {
      id: 'leg-b', full_name: 'Y', bioguide_id: 'Y1', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
  ]);
  const client = identityFakeClient({
    flags: [flag], legislatorsById, raceOnLegislatorUpdateFor: 'leg-a', failCleanupDelete: true,
  });
  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => { loggedCalls.push(args); };
  return withServer(async (base) => {
    try {
      const res = await fetch(`${base}/api/identity/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flag_id: 'f1', action: 'link', legislator_ids: ['leg-a', 'leg-b'] }),
      });
      const body = await res.json();
      assert.equal(res.status, 409);
      assert.equal(body.error, 'concurrent link detected');
      assert.equal(body.cleanup, 'failed — orphaned person person-new-1 requires manual removal');
      assert.deepEqual(client.deletedPersonIds, [], 'the delete call was attempted but itself failed — never recorded as succeeded');
      assert.ok(
        loggedCalls.some((call) => String(call[0]).includes('[review-server]') && String(call[0]).toLowerCase().includes('cleanup')),
        'the cleanup failure is logged server-side, same [review-server] convention as every other unexpected condition in this file',
      );
    } finally {
      console.error = originalConsoleError;
    }
  }, client);
});

test('POST /api/identity/decision link: a person_links unique-violation (the SAME race, caught one step later) also maps to 409, not a raw 500', () => {
  const flag = {
    id: 'f1', cluster_key: 'k', resolved: false,
    candidate_legislator_ids: ['leg-a', 'leg-b'],
    evidence: { reason: 'internal_contradiction', candidates: [{ legislatorId: 'leg-a' }, { legislatorId: 'leg-b' }] },
  };
  const legislatorsById = new Map([
    ['leg-a', {
      id: 'leg-a', full_name: 'X', bioguide_id: 'X1', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
    ['leg-b', {
      id: 'leg-b', full_name: 'Y', bioguide_id: 'Y1', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
  ]);
  const client = identityFakeClient({
    flags: [flag], legislatorsById, raceOnPersonLinksFor: 'leg-a',
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'f1', action: 'link', legislator_ids: ['leg-a', 'leg-b'] }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(client.deletedPersonIds, ['person-new-1'], 'nothing had linked yet when the race was detected — cleaned up');
  }, client);
});

test('POST /api/identity/decision link: a legislator_id that no longer resolves to a row -> 404', () => {
  const flag = {
    id: 'f1', cluster_key: 'k', resolved: false,
    candidate_legislator_ids: ['leg-a', 'leg-ghost'],
    evidence: { reason: 'internal_contradiction', candidates: [{ legislatorId: 'leg-a' }, { legislatorId: 'leg-ghost' }] },
  };
  const legislatorsById = new Map([
    ['leg-a', {
      id: 'leg-a', full_name: 'X', bioguide_id: 'X1', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    }],
  ]);
  const client = identityFakeClient({ flags: [flag], legislatorsById });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'f1', action: 'link', legislator_ids: ['leg-a', 'leg-ghost'] }),
    });
    assert.equal(res.status, 404);
  }, client);
});

// ============================================================================
// Task 4 (.superpowers/sdd/2026-07-29-profile-completeness/task-4-brief.md): POST
// /api/identity/decision action 'attach'. Links selected UNLINKED candidate row(s) into an
// EXISTING person (person_id supplied in the payload, validated to actually exist) — no new
// persons row is ever created, decided_by 'lance', same TOCTOU-guard discipline as 'link', but
// WITHOUT the orphan-cleanup step (there is nothing to clean up: the target person predates the
// decision and already carries its other members' links).
// ============================================================================

test('POST /api/identity/decision attach: writes legislators.person_id + person_links (decided_by lance, attachedToPersonId) into the EXISTING person, creates NO new persons row, resolves the flag when its single candidate is the whole candidate set', () => {
  const flag = {
    id: 'f1', cluster_key: 'attach:person-onder-1:leg-fifth', resolved: false,
    candidate_legislator_ids: ['leg-fifth'],
    evidence: {
      reason: 'attach_candidate',
      existingPerson: { personId: 'person-onder-1', displayName: 'Robert F. Onder' },
      candidates: [{
        legislatorId: 'leg-fifth', fullName: 'Robert Onder', sourceKeys: { legiscan_people_id: 99999 }, chamberDistrictEra: [],
      }],
    },
  };
  const legislatorsById = new Map([
    ['leg-fifth', {
      id: 'leg-fifth', full_name: 'Robert Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null,
    }],
  ]);
  const calls = [];
  const client = identityFakeClient(
    { flags: [flag], legislatorsById, existingPersonIds: ['person-onder-1'] },
    (table, method, args) => calls.push({ table, method, args }),
  );
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flag_id: 'f1', action: 'attach', legislator_ids: ['leg-fifth'], person_id: 'person-onder-1', note: 'same Bob Onder',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.person_id, 'person-onder-1');
    assert.equal(body.resolved, true, 'the flag\'s only candidate was just attached');

    assert.ok(!calls.some((c) => c.table === 'persons' && c.method === 'insert'), 'attach NEVER creates a new persons row');
    const legUpdate = calls.find((c) => c.table === 'legislators' && c.method === 'update');
    assert.equal(legUpdate.args[0].person_id, 'person-onder-1');
    assert.equal(legislatorsById.get('leg-fifth').person_id, 'person-onder-1');

    const linkInsert = calls.find((c) => c.table === 'person_links' && c.method === 'insert');
    assert.equal(linkInsert.args[0].person_id, 'person-onder-1');
    assert.equal(linkInsert.args[0].legislator_id, 'leg-fifth');
    assert.equal(linkInsert.args[0].decided_by, 'lance');
    assert.equal(linkInsert.args[0].evidence.attachedToPersonId, 'person-onder-1');
    assert.equal(linkInsert.args[0].evidence.flagId, 'f1');
    assert.equal(linkInsert.args[0].evidence.note, 'same Bob Onder');
    assert.deepEqual(linkInsert.args[0].evidence.linkedWith, []);

    const flagUpdate = calls.find((c) => c.table === 'identity_flags' && c.method === 'update');
    assert.equal(flagUpdate.args[0].resolved, true);
    assert.equal(flag.resolved, true);
  }, client);
});

test('POST /api/identity/decision attach: person_id names a non-existent person -> 404, zero writes', () => {
  const flag = {
    id: 'f1', cluster_key: 'attach:person-ghost:leg-fifth', resolved: false,
    candidate_legislator_ids: ['leg-fifth'],
    evidence: { reason: 'attach_candidate', existingPerson: { personId: 'person-ghost', displayName: 'Nobody' }, candidates: [{ legislatorId: 'leg-fifth' }] },
  };
  const legislatorsById = new Map([
    ['leg-fifth', {
      id: 'leg-fifth', full_name: 'Robert Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null,
    }],
  ]);
  const calls = [];
  const client = identityFakeClient(
    { flags: [flag], legislatorsById, existingPersonIds: [] }, // person-ghost does NOT actually exist
    (table, method, args) => calls.push({ table, method, args }),
  );
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flag_id: 'f1', action: 'attach', legislator_ids: ['leg-fifth'], person_id: 'person-ghost',
      }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /person not found/);
    assert.ok(!calls.some((c) => c.table === 'legislators' && c.method === 'update'));
    assert.ok(!calls.some((c) => c.table === 'person_links'));
  }, client);
});

test('POST /api/identity/decision attach: a legislator_id not among this flag\'s candidates -> 400, nothing written', () => {
  const flag = {
    id: 'f1', cluster_key: 'attach:person-onder-1:leg-fifth', resolved: false,
    candidate_legislator_ids: ['leg-fifth'],
    evidence: { reason: 'attach_candidate', existingPerson: { personId: 'person-onder-1', displayName: 'Robert F. Onder' }, candidates: [{ legislatorId: 'leg-fifth' }] },
  };
  const calls = [];
  const client = identityFakeClient(
    { flags: [flag], existingPersonIds: ['person-onder-1'] },
    (table, method, args) => calls.push({ table, method, args }),
  );
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flag_id: 'f1', action: 'attach', legislator_ids: ['leg-outsider'], person_id: 'person-onder-1',
      }),
    });
    assert.equal(res.status, 400);
    assert.ok(!calls.some((c) => c.table === 'legislators' && c.method === 'update'));
  }, client);
});

test('POST /api/identity/decision attach: a selected candidate already carrying a person_id -> 409, zero writes (conflict-throw path, same discipline as link)', () => {
  const flag = {
    id: 'f1', cluster_key: 'attach:person-onder-1:leg-fifth', resolved: false,
    candidate_legislator_ids: ['leg-fifth'],
    evidence: { reason: 'attach_candidate', existingPerson: { personId: 'person-onder-1', displayName: 'Robert F. Onder' }, candidates: [{ legislatorId: 'leg-fifth' }] },
  };
  const legislatorsById = new Map([
    ['leg-fifth', {
      id: 'leg-fifth', full_name: 'Robert Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: 'already-linked-elsewhere',
    }],
  ]);
  const calls = [];
  const client = identityFakeClient(
    { flags: [flag], legislatorsById, existingPersonIds: ['person-onder-1'] },
    (table, method, args) => calls.push({ table, method, args }),
  );
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flag_id: 'f1', action: 'attach', legislator_ids: ['leg-fifth'], person_id: 'person-onder-1',
      }),
    });
    assert.equal(res.status, 409);
    assert.ok(!calls.some((c) => c.table === 'person_links'));
    assert.equal(legislatorsById.get('leg-fifth').person_id, 'already-linked-elsewhere', 'untouched');
  }, client);
});

test('POST /api/identity/decision attach: TOCTOU race — a concurrent writer wins the guarded update -> 409, generic "concurrent request" message, and CRITICALLY the pre-existing target person is NEVER deleted (contrast link\'s own orphan-cleanup, which does not apply here)', () => {
  const flag = {
    id: 'f1', cluster_key: 'attach:person-onder-1:leg-fifth', resolved: false,
    candidate_legislator_ids: ['leg-fifth'],
    evidence: { reason: 'attach_candidate', existingPerson: { personId: 'person-onder-1', displayName: 'Robert F. Onder' }, candidates: [{ legislatorId: 'leg-fifth' }] },
  };
  const legislatorsById = new Map([
    ['leg-fifth', {
      id: 'leg-fifth', full_name: 'Robert Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null,
    }],
  ]);
  const client = identityFakeClient({
    flags: [flag], legislatorsById, existingPersonIds: ['person-onder-1'], raceOnLegislatorUpdateFor: 'leg-fifth',
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flag_id: 'f1', action: 'attach', legislator_ids: ['leg-fifth'], person_id: 'person-onder-1',
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.match(body.error, /concurrent/);
    assert.equal(body.cleanup, undefined, 'no cleanup field at all — attach never has an orphan to report on');
    assert.equal(legislatorsById.get('leg-fifth').person_id, 'person-rival', 'raced away by the simulated concurrent writer');
    assert.deepEqual(client.deletedPersonIds, [], 'the pre-existing target person is REAL data — it must never be deleted, unlike link\'s just-inserted orphan');
    assert.deepEqual(client.insertedPersonIds, [], 'attach never inserts a persons row in the first place');
  }, client);
});

test('POST /api/identity/decision attach: a person_links unique-violation (the same race, caught one step later) also maps to a plain 409, target person still untouched', () => {
  const flag = {
    id: 'f1', cluster_key: 'attach:person-onder-1:leg-fifth', resolved: false,
    candidate_legislator_ids: ['leg-fifth'],
    evidence: { reason: 'attach_candidate', existingPerson: { personId: 'person-onder-1', displayName: 'Robert F. Onder' }, candidates: [{ legislatorId: 'leg-fifth' }] },
  };
  const legislatorsById = new Map([
    ['leg-fifth', {
      id: 'leg-fifth', full_name: 'Robert Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null,
    }],
  ]);
  const client = identityFakeClient({
    flags: [flag], legislatorsById, existingPersonIds: ['person-onder-1'], raceOnPersonLinksFor: 'leg-fifth',
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flag_id: 'f1', action: 'attach', legislator_ids: ['leg-fifth'], person_id: 'person-onder-1',
      }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(client.deletedPersonIds, []);
  }, client);
});

test('POST /api/identity/decision attach (multi-candidate, per-subset): attaching 1 of 2 candidates leaves the flag unresolved, the other candidate untouched', () => {
  const flag = {
    id: 'f1', cluster_key: 'attach:person-onder-1:leg-fifth,leg-sixth', resolved: false,
    candidate_legislator_ids: ['leg-fifth', 'leg-sixth'],
    evidence: {
      reason: 'attach_candidate',
      existingPerson: { personId: 'person-onder-1', displayName: 'Robert F. Onder' },
      candidates: [{ legislatorId: 'leg-fifth' }, { legislatorId: 'leg-sixth' }],
    },
  };
  const legislatorsById = new Map([
    ['leg-fifth', {
      id: 'leg-fifth', full_name: 'Robert Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null,
    }],
    ['leg-sixth', {
      id: 'leg-sixth', full_name: 'Robert Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99998, person_id: null,
    }],
  ]);
  const client = identityFakeClient({ flags: [flag], legislatorsById, existingPersonIds: ['person-onder-1'] });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flag_id: 'f1', action: 'attach', legislator_ids: ['leg-fifth'], person_id: 'person-onder-1',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resolved, false, 'leg-sixth is still unaccounted for');
    assert.equal(legislatorsById.get('leg-fifth').person_id, 'person-onder-1');
    assert.equal(legislatorsById.get('leg-sixth').person_id, null, 'untouched by this decision');
    assert.equal(flag.resolved, false);
  }, client);
});

test('POST /api/identity/decision attach: degrades honestly to 503 when identity_flags is missing (pre-0012), same as every other action', () => {
  const client = identityFakeClient({ identityFlagsMissing: true });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flag_id: 'f1', action: 'attach', legislator_ids: ['leg-fifth'], person_id: 'person-1',
      }),
    });
    assert.equal(res.status, 503);
  }, client);
});

// ============================================================================
// Fix round 1, IMPORTANT finding: no prior test exercised the DOCUMENTED real queue scale
// (controller ruling 1 — "two 14-member brown/smith blobs"). This is that test: a real
// 14-candidate flag, rendered, then resolved across MULTIPLE decisions (two per-subset links +
// a terminal keep-separate on the remainder) — the full multi-decision lifecycle, asserted
// non-vacuously at every step (specific per-row values and writes, not just counts).
// ============================================================================

test('14-candidate flag: queue render (all 14, real per-candidate data) -> link 2 -> link 2 more -> keep-separate the other 10 -> flag fully resolved, precise audit trail throughout', async () => {
  const memberIds = Array.from({ length: 14 }, (_, i) => `leg-${String(i + 1).padStart(2, '0')}`);

  const evidenceCandidates = memberIds.map((id, i) => ({
    legislatorId: id,
    fullName: `Brown Member ${i + 1}`,
    sourceKeys: {
      bioguide_id: i < 3 ? `B00${i}` : null,
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: null,
      legiscan_people_id: i >= 3 ? `L${1000 + i}` : null,
    },
    // Varied chamber/district/era per candidate — real, distinguishable evidence, not a repeated
    // fixture value (the whole point of a table review is that these DIFFER row to row).
    chamberDistrictEra: [{
      source: i < 3 ? 'terms' : 'legiscan_people_id',
      jurisdiction_id: i < 3 ? 'us-congress' : 'mo-legislature',
      chamber: i % 2 === 0 ? 'senate' : 'house',
      district: i < 3 ? null : String(i),
      start_date: i < 3 ? `${2000 + i}-01-03` : null,
      end_date: null,
    }],
  }));

  const flag = {
    id: 'flag-brown-14',
    cluster_key: 'brown:leg-01,...,leg-14',
    resolved: false,
    created_at: '2026-07-29T00:00:00Z',
    candidate_legislator_ids: memberIds,
    evidence: { reason: 'internal_contradiction', candidates: evidenceCandidates },
  };

  const legislatorsById = new Map(memberIds.map((id, i) => [id, {
    id,
    full_name: `Brown Member ${i + 1}`,
    bioguide_id: i < 3 ? `B00${i}` : null,
    openstates_id: null,
    mo_house_id: null,
    mo_senate_id: null,
    legiscan_people_id: i >= 3 ? `L${1000 + i}` : null,
    person_id: null,
  }]));
  const castCountsByLegislatorId = new Map(memberIds.map((id, i) => [id, i * 10]));

  const calls = [];
  const client = identityFakeClient(
    { flags: [flag], legislatorsById, castCountsByLegislatorId, newPersonId: 'person-placeholder' },
    (table, method, args) => calls.push({ table, method, args }),
  );

  await withServer(async (base) => {
    // ---- Step 1: queue render — all 14 candidates present with real, distinct per-row data ----
    const queueRes = await fetch(`${base}/api/identity/queue`);
    assert.equal(queueRes.status, 200);
    const queueBody = await queueRes.json();
    assert.equal(queueBody.items.length, 1);
    const item = queueBody.items[0];
    assert.equal(item.id, 'flag-brown-14');
    assert.equal(item.candidates.length, 14, 'all 14 candidates render, none dropped or collapsed');

    const c1 = item.candidates.find((c) => c.legislator_id === 'leg-01');
    assert.equal(c1.full_name, 'Brown Member 1');
    assert.deepEqual(c1.source_keys, { bioguide_id: 'B000', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null });
    assert.equal(c1.district, 'senate');
    assert.equal(c1.era_span, '2000-01-03 – ?');
    assert.equal(c1.cast_count, 0);
    assert.equal(c1.already_linked, false);

    const c8 = item.candidates.find((c) => c.legislator_id === 'leg-08');
    assert.equal(c8.full_name, 'Brown Member 8');
    assert.deepEqual(c8.source_keys, { bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 'L1007' });
    assert.equal(c8.district, 'house 7');
    assert.equal(c8.era_span, '(no dates on file)');
    assert.equal(c8.cast_count, 70);

    const c14 = item.candidates.find((c) => c.legislator_id === 'leg-14');
    assert.equal(c14.cast_count, 130);
    assert.equal(c14.district, 'house 13');

    // ---- Step 2: link a first subset (leg-01, leg-02) — exactly those two written, the other 12 untouched ----
    calls.length = 0;
    const link1Res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'flag-brown-14', action: 'link', legislator_ids: ['leg-01', 'leg-02'], note: 'same Brown, verified' }),
    });
    assert.equal(link1Res.status, 200);
    const link1Body = await link1Res.json();
    assert.equal(link1Body.resolved, false, '12 of 14 candidates are still unaccounted for');
    const personX = link1Body.person_id;
    assert.ok(personX);

    assert.equal(legislatorsById.get('leg-01').person_id, personX);
    assert.equal(legislatorsById.get('leg-02').person_id, personX);
    for (const id of memberIds) {
      if (id === 'leg-01' || id === 'leg-02') continue;
      assert.equal(legislatorsById.get(id).person_id, null, `${id} must be untouched by the first subset link`);
    }
    assert.equal(calls.filter((c) => c.table === 'persons' && c.method === 'insert').length, 1);
    assert.equal(calls.filter((c) => c.table === 'legislators' && c.method === 'update').length, 2);
    assert.equal(calls.filter((c) => c.table === 'person_links' && c.method === 'insert').length, 2);
    assert.equal(flag.resolved, false);

    // ---- Step 3: a second, independent subset link (leg-03, leg-04) — a DIFFERENT person, first subset unaffected ----
    calls.length = 0;
    const link2Res = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'flag-brown-14', action: 'link', legislator_ids: ['leg-03', 'leg-04'] }),
    });
    assert.equal(link2Res.status, 200);
    const link2Body = await link2Res.json();
    assert.equal(link2Body.resolved, false, '10 of 14 candidates are still unaccounted for');
    const personY = link2Body.person_id;
    assert.notEqual(personY, personX, 'the second subset is a DIFFERENT real person from the first');

    assert.equal(legislatorsById.get('leg-03').person_id, personY);
    assert.equal(legislatorsById.get('leg-04').person_id, personY);
    assert.equal(legislatorsById.get('leg-01').person_id, personX, 'the first subset\'s link is untouched by the second decision');
    assert.equal(legislatorsById.get('leg-02').person_id, personX);
    for (const id of memberIds) {
      if (['leg-01', 'leg-02', 'leg-03', 'leg-04'].includes(id)) continue;
      assert.equal(legislatorsById.get(id).person_id, null, `${id} must still be untouched after the second subset link`);
    }
    assert.equal(flag.resolved, false, 'still 10 unaccounted-for candidates — the flag stays open');
    assert.equal(flag.evidence.resolutions.length, 2, 'two link decisions logged so far');

    // ---- Step 4: terminal keep-separate closes out the remaining 10 — flag fully resolved ----
    calls.length = 0;
    const keepSepRes = await fetch(`${base}/api/identity/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_id: 'flag-brown-14', action: 'keep-separate', note: 'remaining 10 are unrelated same-surname noise' }),
    });
    assert.equal(keepSepRes.status, 200);
    assert.deepEqual(await keepSepRes.json(), { resolved: true });
    assert.equal(flag.resolved, true);
    assert.equal(flag.evidence.resolutions.length, 3);
    const finalResolution = flag.evidence.resolutions[2];
    assert.equal(finalResolution.action, 'keep-separate');
    // Precision (minor 1, at real scale): exactly the 10 STILL-unlinked candidates, never the
    // original 14 and never a hardcoded 'all'.
    const expectedRemainder = memberIds.filter((id) => !['leg-01', 'leg-02', 'leg-03', 'leg-04'].includes(id));
    assert.deepEqual(finalResolution.legislatorIds.slice().sort(), expectedRemainder.slice().sort());
    assert.equal(finalResolution.legislatorIds.length, 10);
    assert.ok(!calls.some((c) => c.table === 'persons'), 'keep-separate never creates a person');
    assert.ok(!calls.some((c) => c.table === 'person_links'), 'keep-separate never writes a link');

    // ---- Step 5: the fully-resolved flag disappears from the live queue ----
    const finalQueueRes = await fetch(`${base}/api/identity/queue`);
    const finalQueueBody = await finalQueueRes.json();
    assert.deepEqual(finalQueueBody.items, [], 'a resolved:true flag is excluded by the queue\'s own resolved=false filter');
  }, client);
});
