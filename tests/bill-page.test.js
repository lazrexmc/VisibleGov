import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tallyPositions, renderSummaryStructured, buildVerificationNote, NO_SUMMARY_NOTE, PLAIN_TEXT_FALLBACK_NOTE,
} from '../site/js/bill-page.js';
import { markTerms } from '../site/js/glossary-inline.js';
import { renderMarkdown } from '../src/lib/summarizer.js';

// Task 9 (docs/superpowers/plans/2026-07-30-public-site.md, task-9-brief.md) — the bill page's
// pure helpers, TDD'd here BEFORE the DOM-wiring code exists (bill-page.js's own orchestration
// functions and glossary-inline.js's DOM helpers are smoke-tested live per the controller's own
// Step 4, same convention as person-page.js/directory-page.js).

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
// renderSummaryStructured — parses body_md via Task 4's shared parsers; if parseBullets yields
// FEWER bullets than the raw '- ' line count (the verifier's own coverage rule), falls back to
// plain-text lines with an honest note. Never renders half.
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
  assert.equal(result.statedPurpose, null);
  assert.equal(result.bullets.length, 2);
});

test('renderSummaryStructured: zero bullets, zero raw lines (a purpose-only body) -> still structured, not a false fallback', () => {
  const md = '**Stated purpose (from the bill):** Does a thing.';
  const result = renderSummaryStructured(md);
  assert.equal(result.formattingVerified, true);
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
  assert.equal(result.statedPurpose, null);
  assert.deepEqual(result.bullets, []);
  assert.equal(result.note, PLAIN_TEXT_FALLBACK_NOTE);
  assert.ok(result.plainTextLines.length > 0, 'the raw text still renders, just as plain lines');
  assert.ok(result.plainTextLines.some((line) => line.includes('no section cited')), 'the mangled line itself is still shown, honestly, as plain text');
});

test('renderSummaryStructured: empty/garbage body_md -> structured with nothing extractable, never a fallback (0 raw lines, 0 parsed — full coverage of nothing)', () => {
  assert.deepEqual(renderSummaryStructured(''), {
    formattingVerified: true, statedPurpose: null, bullets: [], plainTextLines: [], note: null,
  });
  assert.deepEqual(renderSummaryStructured(null), {
    formattingVerified: true, statedPurpose: null, bullets: [], plainTextLines: [], note: null,
  });
});

// ============================================================================
// buildVerificationNote — the exact receipt sentence (task-9 brief, verbatim), or the exact
// honest no-summary line.
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

test('buildVerificationNote: a published summary with no verification-note row on file -> an honest fallback, never a fabricated verdict', () => {
  const summary = { model: 'claude-opus-5' };
  assert.equal(
    buildVerificationNote({ summary, note: null }),
    'Summary by claude-opus-5 — verification record unavailable.',
  );
});

// ============================================================================
// markTerms — case-insensitive EXACT string match on glossary_terms.term, longest-first,
// non-overlapping. `term` on a matched segment is the FULL glossary_terms row (reference
// equality checked below), `null` on plain text.
// ============================================================================

test('markTerms: an exact, case-insensitive match wraps the ORIGINAL-CASE text, term set to the matched row', () => {
  const hipaa = { id: 't1', term: 'HIPAA' };
  const segments = markTerms('Complies with hipaa requirements.', [hipaa]);
  assert.deepEqual(segments, [
    { text: 'Complies with ', term: null },
    { text: 'hipaa', term: hipaa }, // original casing preserved, even though the term row is 'HIPAA'
    { text: ' requirements.', term: null },
  ]);
  assert.equal(segments[1].term, hipaa, 'the matched segment carries the FULL row by reference, not a copy');
});

test('markTerms: overlapping candidates — the LONGER term wins the whole span; the shorter substring term is not separately matched inside it', () => {
  const act = { id: 't1', term: 'Social Security Act' };
  const bare = { id: 't2', term: 'Social Security' };
  const segments = markTerms('Under the Social Security Act, benefits are paid.', [bare, act]);
  assert.deepEqual(segments, [
    { text: 'Under the ', term: null },
    { text: 'Social Security Act', term: act },
    { text: ', benefits are paid.', term: null },
  ]);
});

test('markTerms: two distinct, non-overlapping terms both get marked', () => {
  const medicaid = { id: 't1', term: 'Medicaid' };
  const medicare = { id: 't2', term: 'Medicare' };
  const segments = markTerms('Both Medicaid and Medicare cover this.', [medicaid, medicare]);
  assert.deepEqual(segments, [
    { text: 'Both ', term: null },
    { text: 'Medicaid', term: medicaid },
    { text: ' and ', term: null },
    { text: 'Medicare', term: medicare },
    { text: ' cover this.', term: null },
  ]);
});

test('markTerms: repeated occurrences of the SAME term are all marked, not just the first', () => {
  const act = { id: 't1', term: 'the Act' };
  const segments = markTerms('the Act does X. Later, the Act does Y.', [act]);
  const marked = segments.filter((s) => s.term === act);
  assert.equal(marked.length, 2);
});

test('markTerms: no glossary terms at all -> the whole text is one unmarked segment', () => {
  assert.deepEqual(markTerms('Plain text with nothing to mark.', []), [
    { text: 'Plain text with nothing to mark.', term: null },
  ]);
  assert.deepEqual(markTerms('Plain text.', null), [{ text: 'Plain text.', term: null }]);
});

test('markTerms: no match found in the text -> one unmarked segment, term rows simply unused', () => {
  const unrelated = { id: 't1', term: 'Not Present Anywhere' };
  assert.deepEqual(markTerms('This text mentions nothing relevant.', [unrelated]), [
    { text: 'This text mentions nothing relevant.', term: null },
  ]);
});

test('markTerms: empty/null pointText -> a single empty segment, never throws', () => {
  assert.deepEqual(markTerms('', [{ term: 'X' }]), [{ text: '', term: null }]);
  assert.deepEqual(markTerms(null, [{ term: 'X' }]), [{ text: '', term: null }]);
  assert.deepEqual(markTerms(undefined, undefined), [{ text: '', term: null }]);
});

test('markTerms: malformed candidate rows (no `term` string, or empty term) are ignored, never crash the match', () => {
  const real = { id: 't1', term: 'Medicaid' };
  const segments = markTerms('Medicaid covers this.', [real, { id: 't2' }, { id: 't3', term: '' }, null]);
  assert.deepEqual(segments, [
    { text: 'Medicaid', term: real },
    { text: ' covers this.', term: null },
  ]);
});
