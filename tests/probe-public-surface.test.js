import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRequiredColumnsPresent, checkRowScoping, checkCitationsShape, checkNoSupersededVotes, main, lockVerdict, lockDetail } from '../scripts/probe-public-surface.js';

// Completeness axis follow-up (2026-07-31): scripts/probe-public-surface.js used to assert
// public_verification_notes' column set EXACTLY (4 named columns) — migration 0020 (draft-then-
// apply) adds a fifth, `kind`, so an exact-match check would false-flag every run made AFTER 0020
// is applied but BEFORE this script is separately updated, which is exactly the kind of lockstep-
// migration-coordination bug the coordinator asked to close. checkRequiredColumnsPresent is now
// SUPERSET-tolerant: it passes against BOTH the pre-0020 shape (no `kind`) and a simulated
// post-0020 shape (`kind` present), and only fails when a genuinely REQUIRED column goes missing.
//
// This module's network-touching orchestration (main()) is gated behind invokedDirectly (see the
// file's own header comment) — importing it here for its pure exports never hits the network,
// never reads SUPABASE_URL/SUPABASE_ANON_KEY, and never calls process.exit. `main` itself is
// imported and exercised directly below (not via the CLI entry point) so its env-var-missing branch
// is covered without any live network dependency.

// ---- checkRequiredColumnsPresent ----

const PRE_0020_NOTES_COLUMNS = ['summary_id', 'model', 'overall', 'created_at'];
const POST_0020_NOTES_COLUMNS = ['summary_id', 'kind', 'model', 'overall', 'created_at'];
const REQUIRED_NOTES = ['summary_id', 'model', 'overall', 'created_at'];

test('checkRequiredColumnsPresent: the CURRENT LIVE (pre-0020) shape — exactly the four required columns, no more -> ok', () => {
  const result = checkRequiredColumnsPresent(PRE_0020_NOTES_COLUMNS, REQUIRED_NOTES);
  assert.deepEqual(result, { ok: true, missing: [] });
});

test('checkRequiredColumnsPresent: a SIMULATED post-0020 shape — the four required columns PLUS `kind` -> still ok (superset-tolerant)', () => {
  const result = checkRequiredColumnsPresent(POST_0020_NOTES_COLUMNS, REQUIRED_NOTES);
  assert.deepEqual(result, { ok: true, missing: [] });
});

test('checkRequiredColumnsPresent: a genuinely missing required column -> not ok, names exactly what is missing', () => {
  const result = checkRequiredColumnsPresent(['summary_id', 'model', 'created_at'], REQUIRED_NOTES);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['overall']);
});

test('checkRequiredColumnsPresent: multiple missing columns are all named', () => {
  const result = checkRequiredColumnsPresent(['summary_id'], REQUIRED_NOTES);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.sort(), ['created_at', 'model', 'overall']);
});

test('checkRequiredColumnsPresent: empty/absent gotColumns -> not ok, never throws', () => {
  assert.equal(checkRequiredColumnsPresent([], REQUIRED_NOTES).ok, false);
  assert.equal(checkRequiredColumnsPresent(null, REQUIRED_NOTES).ok, false);
  assert.equal(checkRequiredColumnsPresent(undefined, REQUIRED_NOTES).ok, false);
});

// ---- checkRowScoping — FINAL REVIEW finding 2's gate, must stay EXACTLY as strict ----

test('checkRowScoping: every note row belongs to a published summary -> ok, zero leaks', () => {
  const notes = [
    { summary_id: 's1', overall: 'clean' },
    { summary_id: 's2', overall: 'complete' }, // a completeness-kind row — scoping applies identically
  ];
  const result = checkRowScoping(notes, ['s1', 's2']);
  assert.deepEqual(result, { ok: true, leaked: [], distinctSummaries: 2 });
});

test('checkRowScoping: a note row for an UNPUBLISHED summary is caught (the real leak this gate exists for) — reproduces the original finding 2 shape', () => {
  const notes = [
    { summary_id: 's1', overall: 'clean' }, // published
    { summary_id: 's2', overall: 'flagged' }, // NOT published — this is the leak
  ];
  const result = checkRowScoping(notes, ['s1']);
  assert.equal(result.ok, false);
  assert.equal(result.leaked.length, 1);
  assert.equal(result.leaked[0].summary_id, 's2');
});

test('checkRowScoping: a COMPLETENESS-kind row leaking an unpublished summary is caught exactly the same way as a support-kind leak — no kind-based exception', () => {
  const notes = [{ summary_id: 's-unpublished', overall: 'incomplete' }];
  const result = checkRowScoping(notes, []); // nothing published
  assert.equal(result.ok, false);
  assert.equal(result.leaked.length, 1);
});

test('checkRowScoping: empty notes -> ok trivially, zero leaks, zero distinct summaries', () => {
  assert.deepEqual(checkRowScoping([], ['s1']), { ok: true, leaked: [], distinctSummaries: 0 });
});

test('checkRowScoping: null/undefined noteRows -> ok, never throws', () => {
  assert.deepEqual(checkRowScoping(null, ['s1']), { ok: true, leaked: [], distinctSummaries: 0 });
  assert.deepEqual(checkRowScoping(undefined, ['s1']), { ok: true, leaked: [], distinctSummaries: 0 });
});

// ---- checkCitationsShape — migration 0021 (draft-then-apply, may not be applied yet) ----

test('checkCitationsShape: a completeness row has non-null citations -> violation', () => {
  const rows = [
    { summary_id: 's1', kind: 'completeness', overall: 'complete', citations: [{ bullet_index: 0, section: 'Sec. 1', evidence_quote: 'text' }] },
  ];
  const result = checkCitationsShape(rows);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].summary_id, 's1');
});

test('checkCitationsShape: a completeness row with null citations -> ok', () => {
  const rows = [{ summary_id: 's1', kind: 'completeness', overall: 'complete', citations: null }];
  assert.deepEqual(checkCitationsShape(rows), { ok: true, violations: [] });
});

test('checkCitationsShape: a support row with overall=flagged has non-null citations -> violation (the exact leak the gate exists to prevent)', () => {
  const rows = [
    {
      summary_id: 's-flagged',
      kind: 'support',
      overall: 'flagged',
      citations: [{ bullet_index: 0, section: 'Sec. 1', evidence_quote: 'a refuting quote' }],
    },
  ];
  const result = checkCitationsShape(rows);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].summary_id, 's-flagged');
});

test('checkCitationsShape: a support row with overall=flagged and null citations -> ok (the correct, gated shape)', () => {
  const rows = [{ summary_id: 's-flagged', kind: 'support', overall: 'flagged', citations: null }];
  assert.deepEqual(checkCitationsShape(rows), { ok: true, violations: [] });
});

test('checkCitationsShape: a clean support row with a well-shaped citations array -> ok', () => {
  const rows = [
    {
      summary_id: 's-clean',
      kind: 'support',
      overall: 'clean',
      citations: [
        { bullet_index: 0, section: 'Sec. 1', evidence_quote: 'quote one' },
        { bullet_index: 1, section: 'Sec. 2', evidence_quote: 'quote two' },
      ],
    },
  ];
  assert.deepEqual(checkCitationsShape(rows), { ok: true, violations: [] });
});

test('checkCitationsShape: a citation entry carrying `reason` or `supported` is a violation — those must never reach anon', () => {
  const withReason = [
    { summary_id: 's1', kind: 'support', overall: 'clean', citations: [{ bullet_index: 0, section: 'Sec. 1', evidence_quote: 'q', reason: 'because' }] },
  ];
  assert.equal(checkCitationsShape(withReason).ok, false);

  const withSupported = [
    { summary_id: 's2', kind: 'support', overall: 'clean', citations: [{ bullet_index: 0, section: 'Sec. 1', evidence_quote: 'q', supported: true }] },
  ];
  assert.equal(checkCitationsShape(withSupported).ok, false);
});

test('checkCitationsShape: a clean support row with null citations (e.g. zero verdicts) -> ok, not a violation', () => {
  const rows = [{ summary_id: 's-empty', kind: 'support', overall: 'clean', citations: null }];
  assert.deepEqual(checkCitationsShape(rows), { ok: true, violations: [] });
});

test('checkCitationsShape: rows with no `citations` key at all (pre-0021 DB) -> ok, never a violation — this check is additive, never fails a probe run before Lance applies the migration', () => {
  const rows = [
    { summary_id: 's1', kind: 'support', overall: 'clean' },
    { summary_id: 's2', kind: 'completeness', overall: 'complete' },
  ];
  assert.deepEqual(checkCitationsShape(rows), { ok: true, violations: [] });
});

test('checkCitationsShape: empty/null/undefined noteRows -> ok, never throws', () => {
  assert.deepEqual(checkCitationsShape([]), { ok: true, violations: [] });
  assert.deepEqual(checkCitationsShape(null), { ok: true, violations: [] });
  assert.deepEqual(checkCitationsShape(undefined), { ok: true, violations: [] });
});

test('checkCitationsShape: multiple violations across multiple rows are all reported, not just the first', () => {
  const rows = [
    { summary_id: 's1', kind: 'completeness', overall: 'complete', citations: [{ bullet_index: 0, section: 'x', evidence_quote: 'y' }] },
    { summary_id: 's2', kind: 'support', overall: 'flagged', citations: [{ bullet_index: 0, section: 'x', evidence_quote: 'y' }] },
  ];
  const result = checkCitationsShape(rows);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 2);
});

// ---- checkNoSupersededVotes — vote-duplicate dedup (migration 0022, draft-then-apply) ----

test('checkNoSupersededVotes: no superseded ids among the rows -> ok, zero leaks', () => {
  const rows = [{ id: 'v1' }, { id: 'v2' }];
  const result = checkNoSupersededVotes(rows, new Set(['v3']));
  assert.deepEqual(result, { ok: true, leaked: [] });
});

test('checkNoSupersededVotes: a superseded id present in the public rows is caught — the real leak this gate exists for', () => {
  const rows = [{ id: 'v1' }, { id: 'v2' }];
  const result = checkNoSupersededVotes(rows, new Set(['v2']));
  assert.equal(result.ok, false);
  assert.deepEqual(result.leaked, ['v2']);
});

test('checkNoSupersededVotes: empty rows or empty superseded set -> ok trivially', () => {
  assert.deepEqual(checkNoSupersededVotes([], new Set(['v1'])), { ok: true, leaked: [] });
  assert.deepEqual(checkNoSupersededVotes([{ id: 'v1' }], new Set()), { ok: true, leaked: [] });
});

test('checkNoSupersededVotes: null/undefined rows -> ok, never throws', () => {
  assert.deepEqual(checkNoSupersededVotes(null, new Set(['v1'])), { ok: true, leaked: [] });
  assert.deepEqual(checkNoSupersededVotes(undefined, new Set(['v1'])), { ok: true, leaked: [] });
});

// ---- main(): env-var-missing branch, no network required (proves importing/exercising this
// module never needs a live Supabase and never crashes the test process) ----

test('main(): SUPABASE_URL/SUPABASE_ANON_KEY unset -> sets a non-zero exitCode and returns, without touching the network', async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedAnon = process.env.SUPABASE_ANON_KEY;
  const savedExitCode = process.exitCode;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  process.exitCode = undefined;
  try {
    await main();
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = savedExitCode;
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    if (savedAnon !== undefined) process.env.SUPABASE_ANON_KEY = savedAnon;
  }
});

// --- lockVerdict / lockDetail -------------------------------------------------------------------
// Added 2026-08-29. This predicate lived inline in main() and was untested, so 404 was ADDED to the
// accept set at 12:35 and REMOVED at 19:14 without a single test failing either time. A predicate
// nobody can break is a predicate nobody can defend.
test('lockVerdict: 401/403 and a 42501 body are the only "locked" states', () => {
  assert.equal(lockVerdict(401, { code: '42501' }), 'locked');
  assert.equal(lockVerdict(403, null), 'locked');
  assert.equal(lockVerdict(200, { code: '42501' }), 'locked', 'an explicit 42501 body is decisive');
});

test('lockVerdict: `200 []` is EXPOSED — the grant is live, only a missing policy hides it', () => {
  assert.equal(lockVerdict(200, []), 'exposed');
  assert.equal(lockVerdict(200, [{ id: 1 }]), 'exposed');
});

test('lockVerdict: 404 is UNEXPLAINED — neither locked nor a leak', () => {
  // 404 was briefly accepted as "locked", which would have let a relation hidden from PostgREST's
  // schema cache pass here while verify-migrations.mjs reported the same relation as absent.
  assert.equal(lockVerdict(404, null), 'unexplained');
  assert.equal(lockVerdict(400, { code: '42703' }), 'unexplained', 'a column-name error never reached a privilege check');
  assert.equal(lockVerdict(500, null), 'unexplained');
});

// The former 'matches anonRevoked exactly' test lived here and was removed 2026-08-29: it compared
// lockVerdict against a hand-copied closure in this file, so verify-migrations.mjs could change
// without failing anything, and the copy was not even faithful (raw text vs JSON.stringify of a
// parsed body). Both callers now import src/lib/anon-lock.js, and tests/anon-lock.test.js carries a
// structural guard that neither file reintroduces its own predicate. Eliminating the second copy
// beats testing that two copies agree.
test('lockDetail: an unexplained result does not read like a leak', () => {
  const d = lockDetail(404, 'unexplained');
  assert.match(d, /UNEXPLAINED/);
  assert.doesNotMatch(d, /GRANT is still live/, 'must not send an operator hunting for a grant');
  assert.match(lockDetail(200, 'exposed'), /GRANT is still live/);
});
