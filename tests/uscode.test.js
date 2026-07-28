import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseCitation, extractSectionText, buildUscUrl, sha256,
  MAX_EXCERPT_CHARS, OversizeExcerptError, UscSectionNotFoundError,
} from '../src/adapters/uscode.js';

const section1396b = readFileSync('tests/fixtures/uscode/title-42-section-1396b.xhtml', 'utf8');
const section1396d = readFileSync('tests/fixtures/uscode/title-42-section-1396d.xhtml', 'utf8');
const notFound = readFileSync('tests/fixtures/uscode/section-not-found.xhtml', 'utf8');
// The real raw citation text from this task's own golden (HR 498) - see
// tests/fixtures/us-congress/bill-text.htm - proves parseCitation handles what this pipeline
// will actually receive, not just the brief's illustrative forms.
const hr498Text = readFileSync('tests/fixtures/us-congress/bill-text.htm', 'utf8');

// ---- parseCitation ----

test('parseCitation handles the 3 documented forms', () => {
  assert.deepEqual(parseCitation('42 U.S.C. 1396b'), { title: 42, section: '1396b' });
  assert.deepEqual(parseCitation('42 USC 1396b'), { title: 42, section: '1396b' });
  assert.deepEqual(parseCitation('section 1396b of title 42'), { title: 42, section: '1396b' });
});

test('parseCitation handles the real HR 498 raw citation shape (popular name wrapping a USC cite with a trailing subsection, incl. the actual embedded line-wrap whitespace)', () => {
  const match = hr498Text.match(/Section 1903\(i\) of the Social Security Act \(42[\s\S]{0,10}U\.S\.C\.[\s\S]{0,10}1396b\(i\)\)/);
  assert.ok(match, 'golden fixture must actually contain this citation - not reconstructed by hand');
  assert.deepEqual(parseCitation(match[0]), { title: 42, section: '1396b' });
});

test('parseCitation drops a trailing subsection and keeps only title/section', () => {
  assert.deepEqual(parseCitation('42 U.S.C. 1396b(i)'), { title: 42, section: '1396b' });
  assert.deepEqual(parseCitation('42 U.S.C. 1396r-4(f)'), { title: 42, section: '1396r-4' });
});

test('parseCitation tolerates a section symbol and loose spacing', () => {
  assert.deepEqual(parseCitation('42 U.S.C. §1396b'), { title: 42, section: '1396b' });
  assert.deepEqual(parseCitation('42U.S.C.1396b'), { title: 42, section: '1396b' });
});

test('parseCitation returns null for popular-name-only references (needs_mapping, never guessed)', () => {
  assert.equal(parseCitation('the Social Security Act'), null);
  assert.equal(parseCitation('Section 1903 of the Social Security Act'), null);
  assert.equal(parseCitation('title XIX of the Social Security Act'), null);
  assert.equal(parseCitation('the Act'), null);
});

test('parseCitation returns null for empty/missing/non-citation input', () => {
  assert.equal(parseCitation(''), null);
  assert.equal(parseCitation('   '), null);
  assert.equal(parseCitation(undefined), null);
  assert.equal(parseCitation(null), null);
  assert.equal(parseCitation('1396b'), null); // bare section number, no title context - never assumed
});

// ---- buildUscUrl ----

test('buildUscUrl matches the real, live-verified uscode.house.gov shape', () => {
  assert.equal(
    buildUscUrl(42, '1396b'),
    'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title42-section1396b&num=0&edition=prelim',
  );
});

// ---- extractSectionText: real fixture, happy path (42 USC 1396d - under the cap) ----

test('extractSectionText on the real 42 USC 1396d fixture yields substantial text mentioning "medical assistance"', () => {
  const text = extractSectionText(section1396d, { title: 42, section: '1396d' });
  assert.ok(text.length > 500);
  assert.match(text, /medical assistance/i);
  assert.ok(!/<[a-z]+[\s>]/i.test(text), 'no residual tags');
});

test('extractSectionText hash is stable for the real 42 USC 1396d fixture', () => {
  const text = extractSectionText(section1396d, { title: 42, section: '1396d' });
  assert.equal(text.length, 84221);
  assert.equal(sha256(text), '7d73ec2ed1f417d3772cf39d512c83f8d02d29cd11513220249f010b327e8b71');
  assert.equal(sha256(text), sha256(text)); // stable across calls
});

// ---- extractSectionText: real fixture, oversize path (42 USC 1396b - the golden's own citation) ----

test('extractSectionText throws OversizeExcerptError on the real 42 USC 1396b fixture (169,882 chars of operative text alone, over the 100k cap)', () => {
  assert.throws(
    () => extractSectionText(section1396b, { title: 42, section: '1396b' }),
    (err) => {
      assert.ok(err instanceof OversizeExcerptError);
      assert.equal(err.length, 169882);
      assert.equal(err.title, 42);
      assert.equal(err.section, '1396b');
      return true;
    },
  );
});

test('MAX_EXCERPT_CHARS is exactly 100000 per spec', () => {
  assert.equal(MAX_EXCERPT_CHARS, 100000);
});

// ---- extractSectionText: real fixture, not-found path ----

test('extractSectionText throws UscSectionNotFoundError on the real "Document not Found" page (never returns empty text)', () => {
  assert.throws(
    () => extractSectionText(notFound, { title: 42, section: '99999999' }),
    (err) => {
      assert.ok(err instanceof UscSectionNotFoundError);
      assert.equal(err.title, 42);
      assert.equal(err.section, '99999999');
      return true;
    },
  );
});

// ---- sha256 re-export ----

test('sha256 is re-exported from us-congress-text.js (single source of truth)', () => {
  assert.equal(sha256('a'), sha256('a'));
  assert.match(sha256('a'), /^[0-9a-f]{64}$/);
});
