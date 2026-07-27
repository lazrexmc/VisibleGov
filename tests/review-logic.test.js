import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import {
  nextStatus, mapNoteAction, validateDecisionInput, countVoteCasts, pickLatestVote,
  pickBillText, readBody, BodyTooLargeError, requestListener,
} from '../src/review/server.js';

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

// ---- requestListener HTTP-level behavior (no live DB required) ----

function withServer(fn) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      requestListener(req, res).catch(reject);
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

test('unknown route returns 404', () => withServer(async (base) => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
}));
