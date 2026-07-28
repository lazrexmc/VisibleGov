import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import {
  nextStatus, mapNoteAction, validateDecisionInput, countVoteCasts, pickLatestVote,
  pickBillText, readBody, BodyTooLargeError, requestListener, isAllowedDecisionRequest,
  verificationBadge, latestVerificationBySummary, resolveVerificationRows,
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
    limit: record('limit'),
    maybeSingle: record('maybeSingle'),
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
