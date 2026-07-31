import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequiredColumnsPresent, checkRowScoping, main } from '../scripts/probe-public-surface.js';

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
