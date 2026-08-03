import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  tallyPositions, renderSummaryStructured, buildVerificationNote, NO_SUMMARY_NOTE, PLAIN_TEXT_FALLBACK_NOTE,
  loadVotesSection, loadSummarySection, classifyVerificationOverall, selectVerificationNotes,
  filterRedundantOpenStatesVotes, ZERO_CAST_TALLY_NOTE,
} from '../site/js/bill-page.js';
import { markTerms } from '../site/js/glossary-inline.js';
import { renderMarkdown } from '../src/lib/summarizer.js';
import { _setFetch, _setConfig } from '../site/js/rest.js';

// Task 9 (docs/superpowers/plans/2026-07-30-public-site.md, task-9-brief.md; fix rounds 1-2,
// task-9 review) — the bill page's pure helpers, TDD'd here BEFORE the DOM-wiring code exists
// (bill-page.js's own orchestration functions and glossary-inline.js's DOM helpers are otherwise
// smoke-tested live per the controller's own Step 4, same convention as person-page.js/
// directory-page.js — EXCEPT for the one DOM regression test at the bottom of this file, added in
// fix round 2 specifically because a pure-function-only test suite is structurally unable to catch
// a bug that lives entirely in how two already-correct pieces (the flags fetch, joinFlagBadges)
// get wired together at the DOM/network orchestration layer).
//
// jsdom supplies `document` for that one test (same pattern as tests/person-page.test.js) — set
// once here, after the static imports, before any test() body runs; bill-page.js never touches
// `document` at its own module-load time.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:8990/' });
globalThis.document = dom.window.document;

// ============================================================================
// tallyPositions — a mechanical count of stored vote_casts rows, labeled "recorded casts in our
// data," rendered NEXT TO votes.result, never replacing/reconciling it. An unknown position lands
// in `other` under its RAW string, displayed, not dropped.
// ============================================================================

test('tallyPositions: counts the four named buckets from a normal cast set', () => {
  const rows = [
    { position: 'yea' }, { position: 'yea' }, { position: 'yea' },
    { position: 'nay' },
    { position: 'not_voting' },
    { position: 'absent' }, { position: 'absent' },
  ];
  assert.deepEqual(tallyPositions(rows), {
    yea: 3, nay: 1, not_voting: 1, absent: 2, other: {},
  });
});

test('tallyPositions: an unexpected position string (not one of the four named buckets) lands in `other`, keyed by its own raw value, not dropped', () => {
  const rows = [
    { position: 'yea' },
    { position: 'present' }, // a real vote_casts CHECK-constraint value, but outside the named buckets
    { position: 'other' }, // the DB's own literal 'other' value
    { position: 'weird-legiscan-code' }, // a genuinely unrecognized string
    { position: 'present' },
  ];
  assert.deepEqual(tallyPositions(rows), {
    yea: 1,
    nay: 0,
    not_voting: 0,
    absent: 0,
    other: { present: 2, other: 1, 'weird-legiscan-code': 1 },
  });
});

test('tallyPositions: empty/null/undefined input -> all-zero tally, never throws', () => {
  const zero = {
    yea: 0, nay: 0, not_voting: 0, absent: 0, other: {},
  };
  assert.deepEqual(tallyPositions([]), zero);
  assert.deepEqual(tallyPositions(null), zero);
  assert.deepEqual(tallyPositions(undefined), zero);
});

test('tallyPositions: rows that are null/malformed are skipped, not crashed on', () => {
  const rows = [{ position: 'yea' }, null, undefined, {}];
  const result = tallyPositions(rows);
  assert.equal(result.yea, 1);
  // A row present but with no `position` at all (position undefined) still counts honestly,
  // under its own raw (stringified) value, rather than being silently discarded.
  assert.equal(result.other.undefined, 1);
});

// ============================================================================
// filterRedundantOpenStatesVotes — TODO 28 (2026-08-02 brief). Two structurally different
// zero-cast causes on `votes` need DIFFERENT treatment: `mo-ocd-*` rows are OpenStates' own
// bare-status-word bill-action stubs (permanent, structurally noisy — no per-member data ever
// exists for MO from that source); `mo-house-xml-*` rows are real, specific tallies whose casts
// land LATER via the same vote_id (transient, never a duplicate). Suppression is BILL-LEVEL only
// ("real data exists elsewhere on this bill, so the noise adds nothing") — never a claimed
// row-to-row pairing by date/tally proximity, which the sampled data proves does not exist
// honestly. A null/unavailable tally (the per-vote cast fetch itself failed) is never treated as
// "positively zero" — suppressing on an assumption would invent certainty the fetch never gave.
// ============================================================================

test('filterRedundantOpenStatesVotes: a mix of a cast-bearing vote and mo-ocd zero-cast noise -> the noise rows are excluded', () => {
  const votes = [
    { id: 'v-real', source_key: 'mo-house-xml-hb1-1' },
    { id: 'v-ocd-1', source_key: 'mo-ocd-vote/1' },
    { id: 'v-ocd-2', source_key: 'mo-ocd-vote/2' },
  ];
  const tallyByVoteId = new Map([
    ['v-real', { yea: 20, nay: 0, not_voting: 0, absent: 0, other: {} }],
    ['v-ocd-1', { yea: 0, nay: 0, not_voting: 0, absent: 0, other: {} }],
    ['v-ocd-2', { yea: 0, nay: 0, not_voting: 0, absent: 0, other: {} }],
  ]);
  const result = filterRedundantOpenStatesVotes(votes, tallyByVoteId);
  assert.deepEqual(result.map((v) => v.id), ['v-real']);
});

test('filterRedundantOpenStatesVotes: a bill with ONLY mo-ocd zero-cast rows (no real data anywhere) -> nothing is suppressed', () => {
  const votes = [
    { id: 'v-ocd-1', source_key: 'mo-ocd-vote/1' },
    { id: 'v-ocd-2', source_key: 'mo-ocd-vote/2' },
  ];
  const tallyByVoteId = new Map([
    ['v-ocd-1', { yea: 0, nay: 0, not_voting: 0, absent: 0, other: {} }],
    ['v-ocd-2', { yea: 0, nay: 0, not_voting: 0, absent: 0, other: {} }],
  ]);
  const result = filterRedundantOpenStatesVotes(votes, tallyByVoteId);
  assert.deepEqual(result.map((v) => v.id), ['v-ocd-1', 'v-ocd-2']);
});

test('filterRedundantOpenStatesVotes: mo-house zero-cast rows are NEVER suppressed, even alongside real data', () => {
  const votes = [
    { id: 'v-real', source_key: 'mo-house-xml-hb3-1' },
    { id: 'v-house-pending', source_key: 'mo-house-xml-hb3-2' },
  ];
  const tallyByVoteId = new Map([
    ['v-real', { yea: 6, nay: 3, not_voting: 0, absent: 0, other: {} }],
    ['v-house-pending', { yea: 0, nay: 0, not_voting: 0, absent: 0, other: {} }],
  ]);
  const result = filterRedundantOpenStatesVotes(votes, tallyByVoteId);
  assert.deepEqual(result.map((v) => v.id), ['v-real', 'v-house-pending']);
});

test('filterRedundantOpenStatesVotes: mo-house-only zero-cast bill (no real sibling) -> unaffected either way, both rows stay', () => {
  const votes = [{ id: 'v-house-1', source_key: 'mo-house-xml-hb4-1' }];
  const tallyByVoteId = new Map([
    ['v-house-1', { yea: 0, nay: 0, not_voting: 0, absent: 0, other: {} }],
  ]);
  const result = filterRedundantOpenStatesVotes(votes, tallyByVoteId);
  assert.deepEqual(result.map((v) => v.id), ['v-house-1']);
});

test('filterRedundantOpenStatesVotes: an mo-ocd row whose tally fetch FAILED (null, not positively zero) is never suppressed — no invented certainty', () => {
  const votes = [
    { id: 'v-real', source_key: 'mo-house-xml-hb5-1' },
    { id: 'v-ocd-unknown', source_key: 'mo-ocd-vote/1' },
  ];
  const tallyByVoteId = new Map([
    ['v-real', { yea: 10, nay: 0, not_voting: 0, absent: 0, other: {} }],
    ['v-ocd-unknown', null],
  ]);
  const result = filterRedundantOpenStatesVotes(votes, tallyByVoteId);
  assert.deepEqual(result.map((v) => v.id), ['v-real', 'v-ocd-unknown']);
});

test('filterRedundantOpenStatesVotes: a non-mo-ocd, non-mo-house zero-cast source is never suppressed (only mo-ocd- rows are ever candidates)', () => {
  const votes = [
    { id: 'v-real', source_key: 'mo-house-xml-hb6-1' },
    { id: 'v-other', source_key: 'us-congress-1' },
  ];
  const tallyByVoteId = new Map([
    ['v-real', { yea: 10, nay: 0, not_voting: 0, absent: 0, other: {} }],
    ['v-other', { yea: 0, nay: 0, not_voting: 0, absent: 0, other: {} }],
  ]);
  const result = filterRedundantOpenStatesVotes(votes, tallyByVoteId);
  assert.deepEqual(result.map((v) => v.id), ['v-real', 'v-other']);
});

test('filterRedundantOpenStatesVotes: a missing/malformed source_key is never suppressed, never throws', () => {
  const votes = [
    { id: 'v-real', source_key: 'mo-house-xml-hb7-1' },
    { id: 'v-no-source' },
  ];
  const tallyByVoteId = new Map([
    ['v-real', { yea: 10, nay: 0, not_voting: 0, absent: 0, other: {} }],
    ['v-no-source', { yea: 0, nay: 0, not_voting: 0, absent: 0, other: {} }],
  ]);
  const result = filterRedundantOpenStatesVotes(votes, tallyByVoteId);
  assert.deepEqual(result.map((v) => v.id), ['v-real', 'v-no-source']);
});

test('filterRedundantOpenStatesVotes: empty/null votes -> empty array, never throws', () => {
  assert.deepEqual(filterRedundantOpenStatesVotes([], new Map()), []);
  assert.deepEqual(filterRedundantOpenStatesVotes(null, new Map()), []);
  assert.deepEqual(filterRedundantOpenStatesVotes(undefined, new Map()), []);
});

// ============================================================================
// renderSummaryStructured — parses body_md via Task 4's shared parsers; if parseBullets yields
// FEWER bullets than the raw '- ' line count (the verifier's own coverage rule), falls back to
// plain-text lines with an honest note. Never renders half.
//
// Fix round 1, MED-2 ("the vacuous-empty class, 4th appearance"): a structureless body (0 bullets,
// no purpose) that still has REAL text falls back to plain text too (never a silently empty
// structured render); a TRULY empty body is its own `isEmpty` outcome, distinct from both.
// ============================================================================

const REAL_SUMMARY = {
  what_it_does: [
    { point: 'Prohibits X payments', section: 'Sec. 2' },
    { point: 'Establishes a new grant program', section: 'Sec. 3(a)' },
  ],
  stated_purpose: 'To prohibit X and establish Y.',
  classification: 'amends_existing_law',
};

test('renderSummaryStructured: a real, well-formed body_md -> the structured shape, full coverage', () => {
  const md = renderMarkdown(REAL_SUMMARY);
  const result = renderSummaryStructured(md);
  assert.equal(result.formattingVerified, true);
  assert.equal(result.isEmpty, false);
  assert.equal(result.statedPurpose, 'To prohibit X and establish Y.');
  assert.deepEqual(result.bullets, [
    { index: 0, point: 'Prohibits X payments', section: 'Sec. 2' },
    { index: 1, point: 'Establishes a new grant program', section: 'Sec. 3(a)' },
  ]);
  assert.deepEqual(result.plainTextLines, []);
  assert.equal(result.note, null);
});

test('renderSummaryStructured: a purpose-less body_md with bullets -> structured, statedPurpose null', () => {
  const md = renderMarkdown({ ...REAL_SUMMARY, stated_purpose: '' });
  const result = renderSummaryStructured(md);
  assert.equal(result.formattingVerified, true);
  assert.equal(result.isEmpty, false);
  assert.equal(result.statedPurpose, null);
  assert.equal(result.bullets.length, 2);
});

test('renderSummaryStructured: zero bullets but a real stated purpose -> still structured, not a false fallback', () => {
  const md = '**Stated purpose (from the bill):** Does a thing.';
  const result = renderSummaryStructured(md);
  assert.equal(result.formattingVerified, true);
  assert.equal(result.isEmpty, false);
  assert.equal(result.statedPurpose, 'Does a thing.');
  assert.deepEqual(result.bullets, []);
});

test('renderSummaryStructured: a bullet edited to drop its trailing "(section)" -> parseBullets undercounts vs raw "- " lines -> PLAIN-TEXT fallback, never rendered half', () => {
  const wellFormed = renderMarkdown(REAL_SUMMARY);
  // Simulate exactly the edit checkBulletCoverage (src/cli/verify.js) exists to catch: a bullet
  // line that still starts with '- ' but no longer ends in ')' — parseBullets silently skips it,
  // countRawBulletLines still counts it, so coverage drops from 2/2 to 1/2.
  const mangled = wellFormed.replace('- Establishes a new grant program (Sec. 3(a))', '- Establishes a new grant program, no section cited');
  const result = renderSummaryStructured(mangled);
  assert.equal(result.formattingVerified, false);
  assert.equal(result.isEmpty, false);
  assert.equal(result.statedPurpose, null);
  assert.deepEqual(result.bullets, []);
  assert.equal(result.note, PLAIN_TEXT_FALLBACK_NOTE);
  assert.ok(result.plainTextLines.length > 0, 'the raw text still renders, just as plain lines');
  assert.ok(result.plainTextLines.some((line) => line.includes('no section cited')), 'the mangled line itself is still shown, honestly, as plain text');
});

test('renderSummaryStructured: MED-2 — a structureless body (no bullets, no purpose) that STILL HAS real text -> plain-text fallback, never a silently empty structured render', () => {
  const md = '**What it does:**\nThis bill amends several provisions without a recognizable bullet or purpose line.';
  const result = renderSummaryStructured(md);
  assert.equal(result.formattingVerified, false);
  assert.equal(result.isEmpty, false);
  assert.equal(result.note, PLAIN_TEXT_FALLBACK_NOTE);
  assert.ok(result.plainTextLines.some((line) => line.includes('amends several provisions')), 'the real authored text is shown, not silently dropped');
});

test('renderSummaryStructured: MED-2 — a genuinely EMPTY body_md -> isEmpty true, no bullets/purpose/plain-text, no note (nothing to have verified)', () => {
  const expectedEmpty = {
    formattingVerified: true, isEmpty: true, statedPurpose: null, bullets: [], plainTextLines: [], note: null,
  };
  assert.deepEqual(renderSummaryStructured(''), expectedEmpty);
  assert.deepEqual(renderSummaryStructured(null), expectedEmpty);
  assert.deepEqual(renderSummaryStructured(undefined), expectedEmpty);
  assert.deepEqual(renderSummaryStructured('   \n  \n'), expectedEmpty, 'whitespace-only body_md is also genuinely empty');
});

// ============================================================================
// buildVerificationNote — the exact receipt sentence (task-9 brief, verbatim), the exact honest
// no-summary line, and (fix round 1, LOW-6) two DISTINCT strings for "no record on file" vs
// "record could not be loaded."
// ============================================================================

test('buildVerificationNote: summary + verification note present -> the exact receipt sentence', () => {
  const summary = { model: 'claude-opus-5' };
  const note = { model: 'claude-sonnet-5', overall: 'clean', created_at: '2026-07-15T18:22:00.000Z' };
  assert.equal(
    buildVerificationNote({ summary, note }),
    'Summary by claude-opus-5, adversarially verified clean by claude-sonnet-5 on 2026-07-15.',
  );
});

test('buildVerificationNote: a flagged verdict renders honestly too (never suppressed)', () => {
  const summary = { model: 'claude-opus-5' };
  const note = { model: 'claude-sonnet-5', overall: 'flagged', created_at: '2026-01-02T00:00:00.000Z' };
  assert.equal(
    buildVerificationNote({ summary, note }),
    'Summary by claude-opus-5, adversarially verified flagged by claude-sonnet-5 on 2026-01-02.',
  );
});

test('buildVerificationNote: no published summary -> the exact honest line', () => {
  assert.equal(buildVerificationNote({ summary: null, note: null }), NO_SUMMARY_NOTE);
  assert.equal(buildVerificationNote({}), NO_SUMMARY_NOTE);
  assert.equal(buildVerificationNote(), NO_SUMMARY_NOTE);
});

test('buildVerificationNote: LOW-6 — a published summary with NO verification-note row on file (fetch succeeded, legitimately zero rows) -> "no verification record on file"', () => {
  const summary = { model: 'claude-opus-5' };
  assert.equal(
    buildVerificationNote({ summary, note: null }),
    'Summary by claude-opus-5 — no verification record on file.',
  );
});

test('buildVerificationNote: LOW-6 — the verification-note FETCH ITSELF FAILED -> a DIFFERENT string, "could not be loaded," never conflated with "no record on file"', () => {
  const summary = { model: 'claude-opus-5' };
  const failedMessage = buildVerificationNote({ summary, note: null, noteUnavailable: true });
  assert.equal(failedMessage, 'Summary by claude-opus-5 — verification record could not be loaded.');
  assert.notEqual(
    failedMessage,
    buildVerificationNote({ summary, note: null }),
    'the two honest-uncertainty cases must render as two DIFFERENT strings',
  );
});

// ============================================================================
// classifyVerificationOverall / selectVerificationNotes — completeness axis follow-up (2026-07-31).
// public_verification_notes (migration 0016/0019/0020) never exposes `verdicts`/`coverage` detail
// to anon (0004/0019: "verification detail ... is a staff review tool, not a public-facing claim in
// its own right"), so bill-page.js cannot discriminate rows by verdict SHAPE the way
// src/review/server.js does against the raw table. It discriminates by `overall`'s own value
// domain instead — disjoint by construction (migration 0020's compound CHECK: support rows are
// always clean/flagged, completeness rows are always complete/incomplete) and present on this view
// since 0004, so it is exactly as reliable a signal as a `kind` column would be, without requiring
// 0020 (draft-then-apply, may land hours after this code ships) to have been applied at all.
// ============================================================================

test('classifyVerificationOverall: clean/flagged -> support; complete/incomplete -> completeness; anything else -> null', () => {
  assert.equal(classifyVerificationOverall('clean'), 'support');
  assert.equal(classifyVerificationOverall('flagged'), 'support');
  assert.equal(classifyVerificationOverall('complete'), 'completeness');
  assert.equal(classifyVerificationOverall('incomplete'), 'completeness');
  assert.equal(classifyVerificationOverall('bogus'), null);
  assert.equal(classifyVerificationOverall(undefined), null);
  assert.equal(classifyVerificationOverall(null), null);
});

test('selectVerificationNotes: a support row and a completeness row both present -> both selected', () => {
  const rows = [
    { summary_id: 's1', overall: 'complete', model: 'claude-sonnet-5', created_at: '2026-07-16T00:00:00.000Z' },
    { summary_id: 's1', overall: 'clean', model: 'claude-sonnet-5', created_at: '2026-07-15T18:22:00.000Z' },
  ];
  const { supportNote, completenessNote } = selectVerificationNotes(rows);
  assert.equal(supportNote.overall, 'clean');
  assert.equal(completenessNote.overall, 'complete');
});

test('selectVerificationNotes: rows already ordered created_at DESC — the FIRST matching row of each shape wins (the latest one)', () => {
  const rows = [
    { summary_id: 's1', overall: 'complete', model: 'm', created_at: '2026-07-16T00:00:00.000Z' }, // latest completeness
    { summary_id: 's1', overall: 'clean', model: 'm', created_at: '2026-07-15T18:22:00.000Z' }, // latest support
    { summary_id: 's1', overall: 'incomplete', model: 'm', created_at: '2026-07-10T00:00:00.000Z' }, // older completeness
    { summary_id: 's1', overall: 'flagged', model: 'm', created_at: '2026-07-01T00:00:00.000Z' }, // older support
  ];
  const { supportNote, completenessNote } = selectVerificationNotes(rows);
  assert.equal(supportNote.created_at, '2026-07-15T18:22:00.000Z');
  assert.equal(completenessNote.created_at, '2026-07-16T00:00:00.000Z');
});

test('selectVerificationNotes: only a support row present (every summary published before this axis shipped) -> completenessNote is null', () => {
  const rows = [{ summary_id: 's1', overall: 'clean', model: 'm', created_at: '2026-01-01T00:00:00.000Z' }];
  const { supportNote, completenessNote } = selectVerificationNotes(rows);
  assert.equal(supportNote.overall, 'clean');
  assert.equal(completenessNote, null);
});

test('selectVerificationNotes: empty/absent rows -> both null, never throws', () => {
  assert.deepEqual(selectVerificationNotes([]), { supportNote: null, completenessNote: null });
  assert.deepEqual(selectVerificationNotes(null), { supportNote: null, completenessNote: null });
  assert.deepEqual(selectVerificationNotes(undefined), { supportNote: null, completenessNote: null });
});

// ============================================================================
// buildVerificationNote + completenessNote — the visible payoff of the completeness axis: when a
// completeness-shaped row is ALSO on file, the receipt gains a second, honest clause. Wording must
// be exactly true of what the gate did (coordinator instruction, 2026-07-31): complete means an
// independent check found the summary covers the bill's key provisions; incomplete should be
// IMPOSSIBLE on a published summary (classifyRecordItem never publishes one), so it is rendered
// honestly rather than hidden if it somehow appears.
// ============================================================================

test('buildVerificationNote: no completenessNote at all (every summary published before this axis shipped) -> renders EXACTLY today\'s receipt, byte for byte, no mention of coverage', () => {
  const summary = { model: 'claude-opus-5' };
  const note = { model: 'claude-sonnet-5', overall: 'clean', created_at: '2026-07-15T18:22:00.000Z' };
  assert.equal(
    buildVerificationNote({ summary, note }),
    'Summary by claude-opus-5, adversarially verified clean by claude-sonnet-5 on 2026-07-15.',
  );
  assert.equal(
    buildVerificationNote({
      summary, note, completenessNote: null,
    }),
    'Summary by claude-opus-5, adversarially verified clean by claude-sonnet-5 on 2026-07-15.',
    'an explicit null completenessNote must render identically to omitting the field entirely',
  );
});

test('buildVerificationNote: a "complete" completenessNote adds a second, honest clause reporting the coverage check', () => {
  const summary = { model: 'claude-opus-5' };
  const note = { model: 'claude-sonnet-5', overall: 'clean', created_at: '2026-07-15T18:22:00.000Z' };
  const completenessNote = { overall: 'complete', model: 'claude-sonnet-5', created_at: '2026-07-16T00:00:00.000Z' };
  const text = buildVerificationNote({ summary, note, completenessNote });
  assert.ok(text.startsWith('Summary by claude-opus-5, adversarially verified clean by claude-sonnet-5 on 2026-07-15.'), 'the original receipt sentence must appear unchanged as the first clause');
  assert.match(text, /covers the bill/i);
});

test('buildVerificationNote: an "incomplete" completenessNote is rendered HONESTLY, never hidden — this should never happen on a published summary, and the text says so rather than silently omitting it', () => {
  const summary = { model: 'claude-opus-5' };
  const note = { model: 'claude-sonnet-5', overall: 'clean', created_at: '2026-07-15T18:22:00.000Z' };
  const completenessNote = { overall: 'incomplete', model: 'claude-sonnet-5', created_at: '2026-07-16T00:00:00.000Z' };
  const text = buildVerificationNote({ summary, note, completenessNote });
  assert.ok(text.startsWith('Summary by claude-opus-5, adversarially verified clean by claude-sonnet-5 on 2026-07-15.'));
  assert.match(text, /incomplete/i);
  assert.doesNotMatch(text, /covers the bill/i, 'must not claim coverage was confirmed when the on-file result says otherwise');
});

test('buildVerificationNote: the no-summary / no-record / unavailable branches are unaffected by completenessNote (they return before it is ever consulted)', () => {
  assert.equal(buildVerificationNote({ summary: null, completenessNote: { overall: 'complete' } }), NO_SUMMARY_NOTE);
  const summary = { model: 'claude-opus-5' };
  assert.equal(
    buildVerificationNote({
      summary, note: null, completenessNote: { overall: 'complete' },
    }),
    'Summary by claude-opus-5 — no verification record on file.',
  );
  assert.equal(
    buildVerificationNote({
      summary, note: null, noteUnavailable: true, completenessNote: { overall: 'complete' },
    }),
    'Summary by claude-opus-5 — verification record could not be loaded.',
  );
});

// ============================================================================
// markTerms — case-insensitive EXACT string match on glossary_terms.term, longest-first,
// non-overlapping. `terms` on a matched segment is the array of ALL glossary_terms rows sharing
// that exact term text (fix round 1, MED-1), `[]` on plain text. Fix round 1, LOW-1: a match must
// not be flanked by [a-z0-9] on either side (a letter-boundary rule).
// ============================================================================

test('markTerms: an exact, case-insensitive match wraps the ORIGINAL-CASE text, terms set to a single-element array containing the matched row', () => {
  const hipaa = { id: 't1', term: 'HIPAA' };
  const segments = markTerms('Complies with hipaa requirements.', [hipaa]);
  assert.deepEqual(segments, [
    { text: 'Complies with ', terms: [] },
    { text: 'hipaa', terms: [hipaa] }, // original casing preserved, even though the term row is 'HIPAA'
    { text: ' requirements.', terms: [] },
  ]);
  assert.equal(segments[1].terms[0], hipaa, 'the matched segment carries the FULL row by reference, not a copy');
});

test('markTerms: overlapping candidates — the LONGER term wins the whole span; the shorter substring term is not separately matched inside it', () => {
  const act = { id: 't1', term: 'Social Security Act' };
  const bare = { id: 't2', term: 'Social Security' };
  const segments = markTerms('Under the Social Security Act, benefits are paid.', [bare, act]);
  assert.deepEqual(segments, [
    { text: 'Under the ', terms: [] },
    { text: 'Social Security Act', terms: [act] },
    { text: ', benefits are paid.', terms: [] },
  ]);
});

test('markTerms: two distinct, non-overlapping terms both get marked', () => {
  const medicaid = { id: 't1', term: 'Medicaid' };
  const medicare = { id: 't2', term: 'Medicare' };
  const segments = markTerms('Both Medicaid and Medicare cover this.', [medicaid, medicare]);
  assert.deepEqual(segments, [
    { text: 'Both ', terms: [] },
    { text: 'Medicaid', terms: [medicaid] },
    { text: ' and ', terms: [] },
    { text: 'Medicare', terms: [medicare] },
    { text: ' cover this.', terms: [] },
  ]);
});

test('markTerms: repeated occurrences of the SAME term are all marked, not just the first', () => {
  const act = { id: 't1', term: 'the Act' };
  const segments = markTerms('the Act does X. Later, the Act does Y.', [act]);
  const marked = segments.filter((s) => s.terms.length > 0);
  assert.equal(marked.length, 2);
});

test('markTerms: no glossary terms at all -> the whole text is one unmarked segment', () => {
  assert.deepEqual(markTerms('Plain text with nothing to mark.', []), [
    { text: 'Plain text with nothing to mark.', terms: [] },
  ]);
  assert.deepEqual(markTerms('Plain text.', null), [{ text: 'Plain text.', terms: [] }]);
});

test('markTerms: no match found in the text -> one unmarked segment, term rows simply unused', () => {
  const unrelated = { id: 't1', term: 'Not Present Anywhere' };
  assert.deepEqual(markTerms('This text mentions nothing relevant.', [unrelated]), [
    { text: 'This text mentions nothing relevant.', terms: [] },
  ]);
});

test('markTerms: empty/null pointText -> a single empty segment, never throws', () => {
  assert.deepEqual(markTerms('', [{ term: 'X' }]), [{ text: '', terms: [] }]);
  assert.deepEqual(markTerms(null, [{ term: 'X' }]), [{ text: '', terms: [] }]);
  assert.deepEqual(markTerms(undefined, undefined), [{ text: '', terms: [] }]);
});

test('markTerms: malformed candidate rows (no `term` string, or empty term) are ignored, never crash the match', () => {
  const real = { id: 't1', term: 'Medicaid' };
  const segments = markTerms('Medicaid covers this.', [real, { id: 't2' }, { id: 't3', term: '' }, null]);
  assert.deepEqual(segments, [
    { text: 'Medicaid', terms: [real] },
    { text: ' covers this.', terms: [] },
  ]);
});

// ---- Fix round 1, MED-1: duplicate term text (different citations) — one arbitrary row used to
// win by fetch order; now ALL rows sharing the exact term text render together on one match. ----

test('markTerms: MED-1 — duplicate term text with DIFFERENT citations (live: "War Powers Resolution" x3) all attach to the ONE matched span, in the caller-supplied (fetch) order', () => {
  const row1 = {
    id: 't1', term: 'War Powers Resolution', citation: '50 U.S.C. 1541', gloss_md: 'First gloss.',
  };
  const row2 = {
    id: 't2', term: 'War Powers Resolution', citation: '50 U.S.C. 1544', gloss_md: 'Second gloss.',
  };
  const row3 = {
    id: 't3', term: 'War Powers Resolution', citation: null, gloss_md: 'Third gloss, uncited.',
  };
  const segments = markTerms('Under the War Powers Resolution, notice is required.', [row1, row2, row3]);
  assert.deepEqual(segments, [
    { text: 'Under the ', terms: [] },
    { text: 'War Powers Resolution', terms: [row1, row2, row3] }, // ONE span, ALL three rows, in input order
    { text: ', notice is required.', terms: [] },
  ]);
});

test('markTerms: MED-1 — a duplicate-named group is still treated as ONE candidate for longest-first purposes (does not create phantom re-matches)', () => {
  const dup1 = { id: 't1', term: 'Act', citation: 'A' };
  const dup2 = { id: 't2', term: 'Act', citation: 'B' };
  const segments = markTerms('The Act applies here.', [dup1, dup2]);
  const marked = segments.filter((s) => s.terms.length > 0);
  assert.equal(marked.length, 1, 'exactly one span is claimed, not one per duplicate row');
  assert.deepEqual(marked[0].terms, [dup1, dup2]);
});

// ---- Fix round 1, LOW-1: letter-boundary rule — a match must not be flanked by [a-z0-9]. ----

test('markTerms: LOW-1 — "act" must NOT match mid-word inside "exact" (a letter immediately precedes it)', () => {
  const actTerm = { id: 't1', term: 'act' };
  const segments = markTerms('This is exact wording.', [actTerm]);
  assert.deepEqual(segments, [{ text: 'This is exact wording.', terms: [] }], 'no match at all — the boundary violation is not a match, not a dropped match');
});

test('markTerms: LOW-1 — the SAME term DOES match as a standalone word, flanked by spaces/punctuation', () => {
  const actTerm = { id: 't1', term: 'Act' };
  const segments = markTerms('The Act requires compliance.', [actTerm]);
  assert.deepEqual(segments, [
    { text: 'The ', terms: [] },
    { text: 'Act', terms: [actTerm] },
    { text: ' requires compliance.', terms: [] },
  ]);
});

test('markTerms: LOW-1 — a valid standalone match at the very start or end of the text (no flanking character on that side) still matches', () => {
  const actTerm = { id: 't1', term: 'Act' };
  assert.deepEqual(markTerms('Act now.', [actTerm]), [
    { text: 'Act', terms: [actTerm] },
    { text: ' now.', terms: [] },
  ]);
  assert.deepEqual(markTerms('Compliance with the Act', [actTerm]), [
    { text: 'Compliance with the ', terms: [] },
    { text: 'Act', terms: [actTerm] },
  ]);
});

test('markTerms: LOW-1 — a boundary-rejected occurrence does not block a genuinely valid occurrence of the SAME term elsewhere in the text', () => {
  const actTerm = { id: 't1', term: 'act' };
  const segments = markTerms('An exact reading of the act is required.', [actTerm]);
  const marked = segments.filter((s) => s.terms.length > 0);
  assert.equal(marked.length, 1, 'only the standalone "act" matches; the "act" inside "exact" does not');
  assert.equal(marked[0].text, 'act');
});

// ============================================================================
// loadVotesSection — DOM regression test (task-9 re-review round 2, HIGH-1: NOT CLOSED in round
// 1). The bug: joinFlagBadges keys its join on `row.vote_id`. The profile page feeds it
// public_vote_feed rows (migration 0016 aliases `v.id AS vote_id` there); this page queries the
// RAW `votes` table, whose primary key column is plain `id` — no `vote_id` at all. Every
// `flaggedIds.has(row.vote_id)` check was silently `has(undefined)`. The flags fetch itself was
// right, joinFlagBadges was right, only the shape handed to it at THIS call site was wrong — and
// no test caught it, because every prior test in this file exercises PURE functions only, never
// the actual fetch -> join -> render pipeline. This is that missing test: the exact HB 1623-shaped
// construction (a raw votes row whose `id` matches an unresolved public_reconciliation_flags row's
// `vote_id`) — reproduces the live bug (fails against the pre-fix code, where `flagRows` never
// matched anything), passes once the join is fed the correctly-aliased row shape.
// ============================================================================

function okResponse(rows) {
  return {
    ok: true, status: 200, json: async () => rows, headers: { get: () => null },
  };
}

test('loadVotesSection: HIGH-1 regression — a raw votes row whose `id` matches an unresolved reconciliation flag renders the ⚑ badge (the exact join-alias bug the round-1 fix missed)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/public_votes?')) {
      // A RAW votes row, exactly as bill-page.js's own VOTES_SELECT returns it — primary key
      // column is `id`, there is no `vote_id` column on this table at all (that alias only exists
      // on the public_vote_feed VIEW the profile page reads instead).
      return okResponse([{
        id: 'v-hb1623', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2026-03-01T00:00:00Z', question: 'On passage', result: '103-48', source_url: null,
      }]);
    }
    if (u.includes('/vote_casts?')) {
      // The reviewer's own live example: printed 103-48 beside a recorded tally of yea 0 nay 1 —
      // the DISCREPANCY that makes the flag meaningful in the first place (not asserted here
      // beyond reproducing the shape; the tally math itself is tallyPositions' own coverage above).
      return okResponse([{ position: 'nay' }]);
    }
    if (u.includes('/public_reconciliation_flags?')) {
      // Keyed by vote_id, matching the votes row's `id` above — this is the real, correct shape
      // public_reconciliation_flags (migration 0016) returns; resolved=is.false is already part of
      // the request URL bill-page.js builds, not re-filtered here.
      return okResponse([{
        vote_id: 'v-hb1623', source_a: 'legiscan', source_b: 'mo-house-journal', discrepancy: 'tally mismatch', resolved: false,
      }]);
    }
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadVotesSection(container, { billId: 'bill-hb1623' });

  const badge = container.querySelector('.flag-badge');
  assert.notEqual(badge, null, 'the ⚑ badge must render — this is exactly the bug: without the vote_id alias, flaggedIds.has(row.vote_id) is has(undefined) for every raw votes row');
  assert.equal(badge.textContent, '⚑ reconciliation flag');
  assert.equal(badge.getAttribute('href'), '/trust#flags');
});

test('loadVotesSection: a vote with NO matching flag row renders no badge (the positive control for the regression test above)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/public_votes?')) {
      return okResponse([{
        id: 'v-clean', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2026-03-01T00:00:00Z', question: 'On passage', result: '103-48', source_url: null,
      }]);
    }
    if (u.includes('/vote_casts?')) return okResponse([{ position: 'yea' }]);
    if (u.includes('/public_reconciliation_flags?')) return okResponse([]); // no flags at all
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadVotesSection(container, { billId: 'bill-clean' });

  assert.equal(container.querySelector('.flag-badge'), null);
  assert.equal(container.querySelector('.flags-unavailable-notice'), null);
});

// ============================================================================
// loadVotesSection — TODO 28 (2026-08-02 brief) DOM regression tests: the real fetch -> tally ->
// filterRedundantOpenStatesVotes -> render pipeline, not just the pure filter tested above. Covers
// the brief's four required cases (a)-(d).
// ============================================================================

function castsFor(byVoteId) {
  return async (url) => {
    const u = String(url);
    for (const [voteId, casts] of Object.entries(byVoteId)) {
      if (u.includes(`vote_id=eq.${voteId}`)) return okResponse(casts);
    }
    return okResponse([]);
  };
}

test('loadVotesSection: (a) a mix of a cast-bearing vote and mo-ocd zero-cast noise — the noise rows do not render at all', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  const castsByVote = castsFor({
    'v-real': [{ position: 'yea' }, { position: 'yea' }],
    'v-ocd-1': [],
    'v-ocd-2': [],
  });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/public_votes?')) {
      return okResponse([
        {
          id: 'v-real', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2026-03-01T00:00:00Z', question: 'On passage', result: '20-0', source_url: null, source_key: 'mo-house-xml-hb1-1',
        },
        {
          id: 'v-ocd-1', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2026-02-01T00:00:00Z', question: 'Referred', result: 'pass', source_url: null, source_key: 'mo-ocd-vote/1',
        },
        {
          id: 'v-ocd-2', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2026-02-15T00:00:00Z', question: 'Perfected', result: 'pass', source_url: null, source_key: 'mo-ocd-vote/2',
        },
      ]);
    }
    if (u.includes('/vote_casts?')) return castsByVote(url);
    if (u.includes('/public_reconciliation_flags?')) return okResponse([]);
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadVotesSection(container, { billId: 'bill-mixed-ocd' });

  const rows = container.querySelectorAll('.bill-vote-row');
  assert.equal(rows.length, 1, 'only the real cast-bearing vote renders — both mo-ocd stubs are suppressed');
  assert.match(rows[0].querySelector('.bill-vote-result').textContent, /20-0/);
});

test('loadVotesSection: (b) a bill with ONLY mo-ocd zero-cast rows (nothing else to show) — both still render, with the honest zero-cast wording', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  const castsByVote = castsFor({ 'v-ocd-1': [], 'v-ocd-2': [] });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/public_votes?')) {
      return okResponse([
        {
          id: 'v-ocd-1', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2026-02-01T00:00:00Z', question: 'Referred', result: 'pass', source_url: null, source_key: 'mo-ocd-vote/1',
        },
        {
          id: 'v-ocd-2', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2026-02-15T00:00:00Z', question: 'Perfected', result: 'pass', source_url: null, source_key: 'mo-ocd-vote/2',
        },
      ]);
    }
    if (u.includes('/vote_casts?')) return castsByVote(url);
    if (u.includes('/public_reconciliation_flags?')) return okResponse([]);
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadVotesSection(container, { billId: 'bill-ocd-only' });

  const rows = container.querySelectorAll('.bill-vote-row');
  assert.equal(rows.length, 2, 'nothing else exists to show — neither mo-ocd stub is suppressed');
  for (const row of rows) {
    assert.equal(row.querySelector('.bill-vote-tally').textContent, ZERO_CAST_TALLY_NOTE);
  }
});

test('loadVotesSection: (c) a bill with mo-house zero-cast rows only — never suppressed, honest wording applied', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  const castsByVote = castsFor({ 'v-house-pending': [] });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/public_votes?')) {
      return okResponse([{
        id: 'v-house-pending', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2026-03-01T00:00:00Z', question: 'On passage', result: '20-0', source_url: null, source_key: 'mo-house-xml-hb2-1',
      }]);
    }
    if (u.includes('/vote_casts?')) return castsByVote(url);
    if (u.includes('/public_reconciliation_flags?')) return okResponse([]);
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadVotesSection(container, { billId: 'bill-house-only' });

  const rows = container.querySelectorAll('.bill-vote-row');
  assert.equal(rows.length, 1, 'the mo-house row still renders — it is real data, just mid-pipeline');
  assert.equal(rows[0].querySelector('.bill-vote-tally').textContent, ZERO_CAST_TALLY_NOTE);
});

test('loadVotesSection: (d) a cast-bearing vote plus an mo-house zero-cast row — the mo-house row is NOT suppressed (only mo-ocd rows ever are)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  const castsByVote = castsFor({
    'v-real': [{ position: 'yea' }, { position: 'yea' }, { position: 'nay' }],
    'v-house-pending': [],
  });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/public_votes?')) {
      return okResponse([
        {
          id: 'v-real', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2026-03-01T00:00:00Z', question: 'On passage', result: '2-1', source_url: null, source_key: 'mo-house-xml-hb3-1',
        },
        {
          id: 'v-house-pending', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2026-03-05T00:00:00Z', question: 'On passage as amended', result: '6-3', source_url: null, source_key: 'mo-house-xml-hb3-2',
        },
      ]);
    }
    if (u.includes('/vote_casts?')) return castsByVote(url);
    if (u.includes('/public_reconciliation_flags?')) return okResponse([]);
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadVotesSection(container, { billId: 'bill-mixed-house' });

  const rows = container.querySelectorAll('.bill-vote-row');
  assert.equal(rows.length, 2, 'both rows render — the mo-house zero-cast row is real data, never suppressed by the presence of a real sibling');
  const tallies = [...rows].map((r) => r.querySelector('.bill-vote-tally').textContent);
  assert.ok(tallies.some((t) => t.includes('Recorded casts in our data')), 'the real vote still shows its actual tally');
  assert.ok(tallies.includes(ZERO_CAST_TALLY_NOTE), 'the mo-house pending row shows the honest zero-cast wording, not a bare all-zero line');
});

// ============================================================================
// loadSummarySection — DOM regression test, completeness axis follow-up (2026-07-31), same reason
// the loadVotesSection regression test above exists: buildVerificationNote and selectVerificationNotes
// are both independently correct in isolation, but the real risk is in how loadSummarySection WIRES
// the single public_verification_notes fetch into them. This exercises the actual fetch -> select ->
// render pipeline, not just the pure pieces.
// ============================================================================

test('loadSummarySection: a summary with BOTH a support row and a completeness row on file renders the support receipt PLUS the coverage clause', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/summaries?')) {
      return okResponse([{
        id: 'sum-both', bill_id: 'bill-both', model: 'claude-opus-5', body_md: '**What it does:**\n- Does X. (Sec. 1)',
      }]);
    }
    if (u.includes('/public_verification_notes?')) {
      // Real applyRecordDecision insert order (src/cli/summary-queue.js): support row first,
      // completeness row second — so in a real DB (order=created_at.desc) the completeness row
      // comes back FIRST. Reproduced here on purpose.
      return okResponse([
        { summary_id: 'sum-both', overall: 'complete', model: 'claude-sonnet-5', created_at: '2026-07-16T00:00:00.000Z' },
        { summary_id: 'sum-both', overall: 'clean', model: 'claude-sonnet-5', created_at: '2026-07-15T18:22:00.000Z' },
      ]);
    }
    if (u.includes('/summary_terms?')) return okResponse([]);
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadSummarySection(container, { billId: 'bill-both' });

  const note = container.querySelector('.bill-verification-note');
  assert.notEqual(note, null);
  assert.ok(note.textContent.startsWith('Summary by claude-opus-5, adversarially verified clean by claude-sonnet-5 on 2026-07-15.'));
  assert.match(note.textContent, /covers the bill/i);
});

test('loadSummarySection: a summary with ONLY a support row on file (every summary published before this axis shipped) renders EXACTLY today\'s receipt, no coverage clause', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/summaries?')) {
      return okResponse([{
        id: 'sum-support-only', bill_id: 'bill-support-only', model: 'claude-opus-5', body_md: '**What it does:**\n- Does X. (Sec. 1)',
      }]);
    }
    if (u.includes('/public_verification_notes?')) {
      return okResponse([
        { summary_id: 'sum-support-only', overall: 'clean', model: 'claude-sonnet-5', created_at: '2026-07-15T18:22:00.000Z' },
      ]);
    }
    if (u.includes('/summary_terms?')) return okResponse([]);
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadSummarySection(container, { billId: 'bill-support-only' });

  const note = container.querySelector('.bill-verification-note');
  assert.notEqual(note, null);
  assert.equal(note.textContent, 'Summary by claude-opus-5, adversarially verified clean by claude-sonnet-5 on 2026-07-15.');
});

// ============================================================================
// Bullet citation toggle — bullet-citation-exposure design (2026-08-02). The `citations` column on
// public_verification_notes is new (migration 0021, draft-then-apply); these tests reproduce both
// the "citation available" and "no citation available" cases, matching this file's own convention
// of DOM-wiring regression tests at the fetch -> select -> render level, not just pure-function
// tests.
// ============================================================================

test('loadSummarySection: a bullet WITH a matching citation renders an accessible toggle that reveals the exact quote on click', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/summaries?')) {
      return okResponse([{
        id: 'sum-cited', bill_id: 'bill-cited', model: 'claude-opus-5', body_md: '**What it does:**\n- Does X. (Sec. 1)\n- Does Y. (Sec. 2)',
      }]);
    }
    if (u.includes('/public_verification_notes?')) {
      return okResponse([
        {
          summary_id: 'sum-cited',
          kind: 'support',
          overall: 'clean',
          model: 'claude-sonnet-5',
          created_at: '2026-07-15T18:22:00.000Z',
          citations: [
            { bullet_index: 0, section: 'Sec. 1', evidence_quote: 'The exact bill text for point X.' },
          ],
        },
      ]);
    }
    if (u.includes('/summary_terms?')) return okResponse([]);
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadSummarySection(container, { billId: 'bill-cited' });

  const items = container.querySelectorAll('.bill-summary-bullets li');
  assert.equal(items.length, 2);

  // Bullet 0 has a citation: an accessible toggle, not the old plain span.
  const toggle0 = items[0].querySelector('.bill-citation-toggle');
  assert.notEqual(toggle0, null, 'bullet 0 should render an interactive citation toggle');
  assert.equal(toggle0.getAttribute('role'), 'button');
  assert.equal(toggle0.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle0.tabIndex, 0);
  assert.match(toggle0.textContent, /Sec\. 1/);

  const quote0 = items[0].querySelector('.bill-citation-quote');
  assert.notEqual(quote0, null);
  assert.equal(quote0.hidden, true, 'the quote is hidden until the toggle is activated');
  assert.equal(quote0.textContent, 'The exact bill text for point X.');

  toggle0.dispatchEvent(new dom.window.Event('click'));
  assert.equal(quote0.hidden, false, 'clicking the toggle reveals the quote');
  assert.equal(toggle0.getAttribute('aria-expanded'), 'true');

  // Bullet 1 has NO matching citation (bullet_index 1 not present in the citations array): falls
  // back to the old plain, non-interactive span — never a broken/empty toggle.
  const toggle1 = items[1].querySelector('.bill-citation-toggle');
  assert.equal(toggle1, null, 'bullet 1 has no citation — must not render a toggle at all');
  const span1 = items[1].querySelector('.bill-summary-bullet-section');
  assert.notEqual(span1, null);
  assert.match(span1.textContent, /Sec\. 2/);
});

test('loadSummarySection: citations is null (flagged/no-citation summary) -> every bullet falls back to the plain, non-interactive section span', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/summaries?')) {
      return okResponse([{
        id: 'sum-no-cite', bill_id: 'bill-no-cite', model: 'claude-opus-5', body_md: '**What it does:**\n- Does X. (Sec. 1)',
      }]);
    }
    if (u.includes('/public_verification_notes?')) {
      return okResponse([
        {
          summary_id: 'sum-no-cite', kind: 'support', overall: 'clean', model: 'claude-sonnet-5', created_at: '2026-07-15T18:22:00.000Z', citations: null,
        },
      ]);
    }
    if (u.includes('/summary_terms?')) return okResponse([]);
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadSummarySection(container, { billId: 'bill-no-cite' });

  assert.equal(container.querySelector('.bill-citation-toggle'), null);
  const span = container.querySelector('.bill-summary-bullet-section');
  assert.notEqual(span, null);
  assert.match(span.textContent, /Sec\. 1/);
});

test('loadSummarySection: a public_verification_notes row with no `citations` key at all (pre-0021 shape) -> falls back cleanly, same as null', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/summaries?')) {
      return okResponse([{
        id: 'sum-pre-0021', bill_id: 'bill-pre-0021', model: 'claude-opus-5', body_md: '**What it does:**\n- Does X. (Sec. 1)',
      }]);
    }
    if (u.includes('/public_verification_notes?')) {
      return okResponse([
        {
          summary_id: 'sum-pre-0021', overall: 'clean', model: 'claude-sonnet-5', created_at: '2026-07-15T18:22:00.000Z',
        },
      ]);
    }
    if (u.includes('/summary_terms?')) return okResponse([]);
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadSummarySection(container, { billId: 'bill-pre-0021' });

  assert.equal(container.querySelector('.bill-citation-toggle'), null);
  assert.notEqual(container.querySelector('.bill-summary-bullet-section'), null);
});
