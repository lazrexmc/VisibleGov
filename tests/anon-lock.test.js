import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

// STRUCTURAL GUARD. The failure this module exists to prevent is a second implementation
// appearing, and a behavioural test cannot catch that — a reintroduced copy would simply not be
// under test, which is exactly what happened before.
//
// BE HONEST ABOUT WHAT THIS CATCHES. It is a REGRESSION guard for predicate-shaped uses of 42501,
// not a duplicate detector. An earlier version matched only the literal `/42501/.test(`, and
// `b.includes('42501')`, `/42501/i.test(b)`, `new RegExp('42501').test(b)` and `b.match(/42501/)`
// all walked straight past it. It now checks every file under scripts/ and src/ (not two named
// ones) for a line that mentions 42501 AND calls a matching method — which covers all five forms —
// but a determined rewrite (building the string from parts, say) still evades it. Treat a pass as
// "the known shapes have not come back", never as "no duplicate exists anywhere".
test('regression guard: no predicate-shaped 42501 match outside the shared module', () => {
  const roots = ['scripts', 'src'];
  // Method-shaped AND equality-shaped. `body.code === '42501'`, `startsWith('42501')` and
  // `case '42501':` are realistic duplicate forms that a method-call-only pattern cannot see —
  // a predicate does not have to call a matcher to be a predicate.
  const MATCHERS = /\b(test|includes|match|search|indexOf|RegExp|startsWith|endsWith)\s*\(|===|!==|\bcase\s/;
  const offenders = [];
  for (const root of roots) {
    const dir = new URL(`../${root}/`, import.meta.url);
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(js|mjs)$/.test(entry.name)) continue;
      const rel = `${entry.parentPath ?? entry.path}/${entry.name}`.replace(/\\/g, '/');
      if (rel.endsWith('src/lib/anon-lock.js')) continue; // the one legitimate home
      for (const line of readFileSync(rel, 'utf8').split(/\r?\n/)) {
        const code = line.replace(/^\s*(\/\/|\*).*$/, ''); // ignore comment-only lines
        if (code.includes('42501') && MATCHERS.test(code)) offenders.push(`${rel}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    `a 42501 predicate reappeared outside src/lib/anon-lock.js — the copies drifted twice before, `
    + `on \`200 []\` and on 404. Import anonLockState/anonRpcState instead.\n`
    // The limits belong HERE, in the message a failing engineer actually reads, not only in the
    // comment above the test where nobody looks once it is red.
    + `NOTE: this guard is shape-based, not semantic. It has no string-literal awareness, skips only `
    + `LINE-PREFIX comments (so a trailing // comment can false-positive), covers .js/.mjs under `
    + `scripts/ and src/ only, and a predicate assembled from string parts still evades it. A pass `
    + `means the known shapes have not returned — never that no duplicate exists.\n`
    + `${offenders.join('\n')}`,
  );
});

test('both historical consumers still import the shared predicate', () => {
  for (const f of ['scripts/verify-migrations.mjs', 'scripts/probe-public-surface.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /from '\.\.\/src\/lib\/anon-lock\.js'/, `${f} must import the shared predicate`);
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
