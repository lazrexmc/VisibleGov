import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  anonLockState, isRevokedResponse, anonRpcState, isRpcDeniedResponse,
} from '../src/lib/anon-lock.js';

// This predicate answers "is a relation genuinely revoked for anon?" and it used to exist twice —
// once in verify-migrations.mjs, once inline in probe-public-surface.js. The copies disagreed twice
// in a single day (on `200 []`, then on 404). The first fix was a test asserting the two agreed,
// which was theatre: it compared one implementation against a hand-copied closure living in the
// test file, so the other file could still change silently — and the copy was not even faithful.
// The copies are now gone. These tests exercise the single definition, plus a structural guard that
// nobody quietly reintroduces a second one.

test('anonLockState: 401 and 403 are locked', () => {
  assert.equal(anonLockState(401, '{"code":"42501"}'), 'locked');
  assert.equal(anonLockState(403, null), 'locked');
});

test('anonLockState: a 42501 body is decisive regardless of status', () => {
  assert.equal(anonLockState(200, '{"code":"42501"}'), 'locked');
  assert.equal(anonLockState(400, { code: '42501' }), 'locked');
});

test('anonLockState: `200 []` is EXPOSED — the grant is live, only a missing policy hides it', () => {
  assert.equal(anonLockState(200, []), 'exposed');
  assert.equal(anonLockState(200, '[]'), 'exposed');
  assert.equal(anonLockState(200, [{ id: 1 }]), 'exposed');
});

test('anonLockState: 404/400/5xx are UNEXPLAINED — neither locked nor a leak', () => {
  assert.equal(anonLockState(404, null), 'unexplained');
  // The real case: `?select=id` on a table with no `id` column. PostgREST resolves the column name
  // before the privilege check, so this request never tested permission at all.
  assert.equal(anonLockState(400, '{"code":"42703"}'), 'unexplained');
  assert.equal(anonLockState(500, null), 'unexplained');
});

// The two callers pass DIFFERENT body shapes — verify-migrations.mjs's rest() returns res.text()
// (a string), probe-public-surface.js's rows() returns res.json() (parsed). The hand-copied test
// this replaces got that wrong, matching /42501/ against JSON.stringify of a parsed body while the
// real code matched raw text. Both shapes must give the same verdict or the shared module has
// merely relocated the bug.
test('anonLockState: raw text and parsed body give identical verdicts', () => {
  for (const [status, parsed] of [[401, { code: '42501' }], [200, []], [404, { message: 'nope' }], [400, { code: '42703' }]]) {
    assert.equal(
      anonLockState(status, parsed),
      anonLockState(status, JSON.stringify(parsed)),
      `status ${status}: parsed and text forms disagree`,
    );
  }
});

test('anonLockState: a body that cannot be stringified does not throw', () => {
  const circular = {};
  circular.self = circular;
  assert.equal(anonLockState(404, circular), 'unexplained');
});

test('isRevokedResponse: true only for locked', () => {
  assert.equal(isRevokedResponse(401, ''), true);
  assert.equal(isRevokedResponse(200, []), false);
  assert.equal(isRevokedResponse(404, null), false, 'unexplained must never read as revoked');
});

// STRUCTURAL GUARD. The failure this whole module exists to prevent is a second implementation
// appearing, so assert that neither consumer carries its own. A behavioural test cannot catch that
// — a reintroduced copy would simply not be under test, which is exactly what happened before.
test('neither consumer defines its own 42501 predicate — one definition, imported', () => {
  for (const f of ['scripts/verify-migrations.mjs', 'scripts/probe-public-surface.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /from '\.\.\/src\/lib\/anon-lock\.js'/, `${f} must import the shared predicate`);
    assert.doesNotMatch(
      src,
      /\/42501\/\.test\(/,
      `${f} has its own 42501 test again — the two copies drifted twice before; import anonLockState instead`,
    );
  }
});

// --- the RPC case, and why it MUST differ on 404 -------------------------------------------------
// These two predicates share a 42501 test and were nearly merged during review. Merging them would
// have been a real bug, so the difference is pinned here rather than left to a comment.
test('anonRpcState: 404 IS denial for a function — PostgREST hides an RPC the role cannot execute', () => {
  assert.equal(anonRpcState(404, null), 'denied');
  assert.equal(anonLockState(404, null), 'unexplained', 'the TABLE predicate must not agree here');
});

test('anonRpcState: 400 event_trigger means anon STILL HAS EXECUTE (migration 0038)', () => {
  // The real payload: PostgREST got far enough to serialise the return value and choked on the
  // pseudo-type. A serializer accident, not a privilege — reading it as denial would report an
  // unapplied migration as applied.
  const body = '{"code":"0A000","message":"cannot display a value of type event_trigger"}';
  assert.equal(anonRpcState(400, body), 'callable');
  assert.equal(isRpcDeniedResponse(400, body), false);
});

test('anonRpcState: 401/403/42501 are denial, same as the table predicate', () => {
  assert.equal(anonRpcState(401, ''), 'denied');
  assert.equal(anonRpcState(403, ''), 'denied');
  assert.equal(anonRpcState(200, '{"code":"42501"}'), 'denied');
});
