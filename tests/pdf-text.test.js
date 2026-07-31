import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { reconstructPageText, extractPdfText } from '../src/adapters/pdf-text.js';

// DIRECT test for the shared pdfjs-dist extraction core (LOW, code review — "add a direct test
// file for src/adapters/pdf-text.js"). Before this file, pdf-text.js's own contract was proven only
// INDIRECTLY, through mo-rollcall-pdf.js's and mo-senate-journal-pdf.js's own real-fixture suites
// (both wrap extractPdfText with document-type-specific post-processing — chrome-stripping,
// vote-grammar parsing — that has nothing to do with pdf-text.js's own job). This file tests
// reconstructPageText's row/column reconstruction directly (synthetic items, no PDF I/O — the
// "REAL-PDF FINDING" comment's own claim: stream order is not reading order, so coordinate-based
// reconstruction is required unconditionally) and extractPdfText's page-join + input-type tolerance
// against a REAL fixture PDF already used elsewhere in this codebase.

// ---- reconstructPageText (pure, synthetic items — no PDF parsing involved) ----

// pdfjs-dist text items carry `.str` and a 6-element `.transform` matrix; reconstructPageText only
// ever reads transform[4] (x) and transform[5] (y) — this helper mirrors just that shape.
function mkItem(str, x, y) {
  return { str, transform: [1, 0, 0, 1, x, y] };
}

test('reconstructPageText: items on the same visual row (y within the epsilon tolerance) join left-to-right by x, REGARDLESS of the order they arrive in the stream', () => {
  const row = [mkItem('world', 50, 100), mkItem('hello ', 0, 100)]; // stream order: right-to-left
  assert.equal(reconstructPageText(row), 'hello world');
});

test('reconstructPageText: items whose y differs by MORE than the epsilon become separate rows, ordered top-to-bottom (descending y — PDF y grows upward) regardless of stream order', () => {
  const items = [mkItem('bottom', 0, 10), mkItem('top', 0, 500), mkItem('middle', 0, 250)];
  assert.equal(reconstructPageText(items), 'top\nmiddle\nbottom');
});

test('reconstructPageText: items within the row epsilon (2pt) stay grouped; items just OUTSIDE it split into separate rows — proves the tolerance boundary, not just its existence', () => {
  const sameRow = [mkItem('a', 0, 100), mkItem('b', 10, 101.5)]; // 1.5pt apart -> within epsilon
  assert.equal(reconstructPageText(sameRow), 'ab');

  const splitRow = [mkItem('a', 0, 100), mkItem('b', 10, 96.9)]; // 3.1pt apart -> beyond epsilon
  assert.equal(reconstructPageText(splitRow), 'a\nb');
});

test('reconstructPageText: an item with an empty string is filtered out entirely — never creates a phantom row, never affects a real neighbor\'s grouping', () => {
  const items = [mkItem('real', 0, 100), mkItem('', 999, 999)];
  assert.equal(reconstructPageText(items), 'real');
});

test('reconstructPageText: an empty item array produces an empty string, never throws', () => {
  assert.equal(reconstructPageText([]), '');
});

test('reconstructPageText: three rows, fully scrambled stream order (both across AND within rows), correct final reading order (integrates row-grouping + top-to-bottom row-ordering + left-to-right within-row x-sort in one construction)', () => {
  const items = [
    mkItem('Two', 30, 250), mkItem('Three', 30, 10), mkItem('One', 30, 500),
    mkItem('Line', 0, 10), mkItem('Line', 0, 500), mkItem('Line', 0, 250),
  ];
  assert.equal(reconstructPageText(items), 'LineOne\nLineTwo\nLineThree');
});

// ---- extractPdfText (real fixture PDF — multi-page join + input-type tolerance) ----

// Reuses the already-verified MO House roll-call fixture (tests/mo-rollcall-pdf.test.js's own
// ground truth: 82 yes / 61 no / 2 present / 13 absent / 5 vacancies, MATTHIESEN voted yes) — this
// file does not re-derive that domain content, only proves pdf-text.js's OWN extraction contract
// against real bytes.
const FIXTURE_PDF = 'tests/fixtures/research/mo-house-xml/rollcall-034.008.pdf';
const pdfBuffer = readFileSync(FIXTURE_PDF); // a real Node Buffer, exactly what every live caller passes

test('extractPdfText: a real multi-page PDF (Buffer input) returns page-joined, reading-order text containing known content', async () => {
  const text = await extractPdfText(pdfBuffer);
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('Roll Call'));
  assert.ok(text.includes('MATTHIESEN'));
  assert.ok(text.includes('Total Yes'));

  // Multi-page join contract: pages are joined with '\n\n' (a blank line), never silently
  // concatenated — confirmed against this fixture's OWN real page count rather than assumed.
  const doc = await getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  assert.ok(doc.numPages >= 1);
  if (doc.numPages > 1) {
    assert.ok(text.includes('\n\n'), 'more than one page must be joined by a blank line, not concatenated bare');
  }
});

test('extractPdfText: a plain Uint8Array (not a Node Buffer) produces IDENTICAL text to the Buffer call — pdfjs-dist rejects a bare Buffer, so the header comment\'s "always rebuilt as Uint8Array" conversion must actually run', async () => {
  const uint8 = new Uint8Array(pdfBuffer);
  const [fromBuffer, fromUint8] = await Promise.all([extractPdfText(pdfBuffer), extractPdfText(uint8)]);
  assert.equal(fromUint8, fromBuffer);
});

test('extractPdfText: a genuine ArrayBuffer (fetchWithLimit\'s own `as: \'arrayBuffer\'` return shape) produces IDENTICAL text to the Buffer call', async () => {
  const arrayBuffer = pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength);
  const [fromBuffer, fromArrayBuffer] = await Promise.all([extractPdfText(pdfBuffer), extractPdfText(arrayBuffer)]);
  assert.equal(fromArrayBuffer, fromBuffer);
});
