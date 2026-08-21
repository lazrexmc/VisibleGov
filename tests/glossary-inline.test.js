import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  renderMarkedText, unmatchedTerms, renderReferencedLaws, REFERENCED_LAWS_NOTE,
} from '../site/js/glossary-inline.js';

// jsdom supplies `document` (same pattern as tests/bill-page.test.js) — set once, before any
// test body runs; glossary-inline.js never touches `document` at module-load time.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:8990/' });
globalThis.document = dom.window.document;

const ROW = (id, term, citation, extra = {}) => ({
  id, term, kind: 'statute', citation,
  gloss_md: `What ${term} does.`, supported_by_quote: `quote for ${term}`,
  source_url: `https://revisor.mo.gov/main/OneSection.aspx?section=${citation.replace('RSMo ', '')}`,
  ...extra,
});

// ---- renderMarkedText: additive `matched` field (2026-08-21 rendering fallback) ----

test('renderMarkedText returns the rows it claimed inline as `matched` (additive; inline/details unchanged)', () => {
  const a = ROW('a', 'section 536.010', 'RSMo 536.010');
  const b = ROW('b', 'section 33.080', 'RSMo 33.080');
  const { inline, details, matched } = renderMarkedText('Amends section 536.010 only.', [a, b]);
  assert.ok(inline instanceof dom.window.DocumentFragment || inline.nodeType === 11);
  assert.equal(details.length, 1);
  assert.deepEqual(matched.map((r) => r.id), ['a']);
});

test('renderMarkedText: nothing matched -> matched is an empty array, never undefined', () => {
  const { matched } = renderMarkedText('Plain text with no terms.', [ROW('a', 'section 536.010', 'RSMo 536.010')]);
  assert.deepEqual(matched, []);
});

// ---- unmatchedTerms: pure leftover computation ----

test('unmatchedTerms drops every row matched anywhere, keeps fetch order, tolerates null input', () => {
  const a = ROW('a', 'section 536.010', 'RSMo 536.010');
  const b = ROW('b', 'section 33.080', 'RSMo 33.080');
  const c = ROW('c', 'section 478.007', 'RSMo 478.007');
  assert.deepEqual(unmatchedTerms([a, b, c], [b]).map((r) => r.id), ['a', 'c']);
  assert.deepEqual(unmatchedTerms([a, b, c], [a, b, c]), []);
  assert.deepEqual(unmatchedTerms([a], []).map((r) => r.id), ['a']);
  assert.deepEqual(unmatchedTerms(null, null), []);
});

// ---- renderReferencedLaws: the collapsed "Referenced laws and terms (N)" section ----

test('renderReferencedLaws returns null for no rows (caller renders nothing)', () => {
  assert.equal(renderReferencedLaws([]), null);
  assert.equal(renderReferencedLaws(null), null);
});

test('renderReferencedLaws builds one accessible toggle per distinct term text, with the full receipt collapsed beneath', () => {
  const a = ROW('a', 'section 536.010', 'RSMo 536.010');
  const b = ROW('b', 'section 33.080', 'RSMo 33.080');
  const section = renderReferencedLaws([a, b]);
  assert.equal(section.className, 'gloss-referenced');
  const heading = section.querySelector('.gloss-referenced-heading');
  assert.equal(heading.textContent, 'Referenced laws and terms (2)');
  assert.equal(section.querySelector('.gloss-referenced-note').textContent, REFERENCED_LAWS_NOTE);
  const toggles = section.querySelectorAll('dfn.gloss-term');
  assert.equal(toggles.length, 2);
  assert.equal(toggles[0].textContent, 'section 536.010');
  assert.equal(toggles[0].getAttribute('role'), 'button');
  assert.equal(toggles[0].getAttribute('aria-expanded'), 'false');
  const details = section.querySelectorAll('.gloss-detail');
  assert.equal(details.length, 2);
  assert.equal(details[0].hidden, true, 'collapsed by default');
  // the receipt: citation heading, gloss, verbatim quote, Source link
  assert.equal(details[0].querySelector('.gloss-detail-heading').textContent, 'section 536.010 — RSMo 536.010');
  assert.ok(details[0].querySelector('.gloss-paragraph').textContent.includes('What section 536.010 does.'));
  assert.equal(details[0].querySelector('blockquote.gloss-quote').textContent, 'quote for section 536.010');
  assert.equal(details[0].querySelector('a.gloss-source-link').getAttribute('href'), 'https://revisor.mo.gov/main/OneSection.aspx?section=536.010');
  // toggling works exactly like the inline marks
  toggles[0].dispatchEvent(new dom.window.Event('click'));
  assert.equal(details[0].hidden, false);
  assert.equal(toggles[0].getAttribute('aria-expanded'), 'true');
});

test('renderReferencedLaws groups duplicate term texts into ONE toggle whose detail carries every citation (MED-1 parity with inline marking)', () => {
  const a = ROW('a', 'War Powers Resolution', 'RSMo 1.001');
  const b = ROW('b', 'war powers resolution', 'RSMo 1.002');
  const section = renderReferencedLaws([a, b]);
  assert.equal(section.querySelector('.gloss-referenced-heading').textContent, 'Referenced laws and terms (1)');
  assert.equal(section.querySelectorAll('dfn.gloss-term').length, 1);
  assert.equal(section.querySelectorAll('.gloss-detail-entry').length, 2);
});
