import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseMoCitation, normalizeMoCitation, isMoCitation,
  extractMoSectionText, extractMoChapterText, MoBotPageError, MoPageIdentityError,
  buildMoSectionUrl, buildMoChapterUrl,
} from '../src/adapters/mo-statutes.js';
import { OversizeExcerptError } from '../src/adapters/uscode.js';

const fx = (name) => readFileSync(new URL(`./fixtures/mo-statutes/${name}`, import.meta.url), 'utf8');

test('parseMoCitation accepts every v1 section shape', () => {
  for (const raw of [
    'section 536.010', 'Section 478.007', '§ 536.010', '302.309',
    'sections 302.309, RSMo', 'section 302.015, RSMo', 'RSMo 536.010',
    'section 620.2020', 'section 33.080',
  ]) {
    const p = parseMoCitation(raw);
    assert.equal(p?.kind, 'section', raw);
  }
  assert.deepEqual(parseMoCitation('section 536.010'), { kind: 'section', section: '536.010' });
});

test('parseMoCitation normalizes a subdivision tail to the parent section', () => {
  assert.deepEqual(parseMoCitation('section 536.010.2'), { kind: 'section', section: '536.010' });
  assert.deepEqual(parseMoCitation('section 536.010(1)'), { kind: 'section', section: '536.010' });
});

test('parseMoCitation accepts chapter shapes including the stored format', () => {
  assert.deepEqual(parseMoCitation('chapter 303'), { kind: 'chapter', chapter: '303' });
  assert.deepEqual(parseMoCitation('chapter 536, RSMo'), { kind: 'chapter', chapter: '536' });
  assert.deepEqual(parseMoCitation('RSMo chapter 536'), { kind: 'chapter', chapter: '536' });
});

test('parseMoCitation reparses its own normalized output (gloss-time round trip)', () => {
  assert.deepEqual(parseMoCitation('RSMo 536.010'), { kind: 'section', section: '536.010' });
});

test('parseMoCitation refuses ranges, lists, specials, and federal markers', () => {
  for (const raw of [
    'sections 302.302 to 302.309', 'sections 302.309 and 302.341, RSMo',
    'RSMo', 'Constitution of Missouri', 'chapter 8 of title 5, United States Code',
    '1 U.S.C. Section 8(b)', '42 CFR Part 418', 'Public Law 118-42',
    'section 1903 of the Social Security Act', '', '   ', null, undefined, 42,
  ]) {
    assert.equal(parseMoCitation(raw), null, String(raw));
  }
});

test('normalizeMoCitation produces the stored prefix-discriminated format', () => {
  assert.equal(normalizeMoCitation({ kind: 'section', section: '536.010' }), 'RSMo 536.010');
  assert.equal(normalizeMoCitation({ kind: 'chapter', chapter: '536' }), 'RSMo chapter 536');
});

test('isMoCitation discriminates stored citation strings', () => {
  assert.equal(isMoCitation('RSMo 536.010'), true);
  assert.equal(isMoCitation('RSMo chapter 536'), true);
  assert.equal(isMoCitation('42 U.S.C. 1396b'), false);
  assert.equal(isMoCitation(null), false);
});

test('extractMoSectionText extracts the real statute body for 536.010', () => {
  const text = extractMoSectionText(fx('section-536.010.html'), { section: '536.010', url: 'x' });
  assert.ok(text.includes('536.010'));
  assert.ok(text.includes('For the purpose of this chapter'));
  assert.ok(!text.includes('<'), 'no HTML tags survive');
  assert.ok(!/double clicking/i.test(text), 'no bot-page text');
});

test('extractMoSectionText throws MoBotPageError on the bot page — never extracts it as statute text', () => {
  assert.throws(() => extractMoSectionText(fx('bot-page.html'), { section: '999.999', url: 'x' }), MoBotPageError);
});

test('extractMoSectionText throws MoPageIdentityError when the page is not the requested section', () => {
  // A real page for a DIFFERENT section must fail the identity check for 111.111.
  assert.throws(() => extractMoSectionText(fx('section-536.010.html'), { section: '111.111', url: 'x' }), MoPageIdentityError);
});

test('extractMoSectionText throws OversizeExcerptError instead of truncating', () => {
  // Splice an oversize body into the REAL fixture between its real markers so the identity
  // check passes and only the size gate fires.
  const real = fx('section-536.010.html');
  const padded = real.replace('For the purpose of this chapter', 'For the purpose of this chapter ' + 'x'.repeat(100001));
  assert.throws(() => extractMoSectionText(padded, { section: '536.010', url: 'x' }), OversizeExcerptError);
});

test('extractMoSectionText extracts a repealed section honestly (repeal notice IS official text)', () => {
  // Skip cleanly if Task 1 could not capture a repealed fixture (documented in SOURCES.md).
  let html;
  try { html = fx('section-repealed.html'); } catch { return; }
  const section = '1.022';
  const text = extractMoSectionText(html, { section, url: 'x' });
  assert.ok(text.includes(section));
});

test('extractMoChapterText extracts the chapter title and section list', () => {
  const text = extractMoChapterText(fx('chapter-536.html'), { chapter: '536', url: 'x' });
  assert.ok(text.includes('Administrative Procedure and Review'));
  assert.ok(text.includes('536.010'));
  assert.ok(!text.includes('<'));
});

test('extractMoChapterText identity check: wrong chapter fails typed', () => {
  assert.throws(() => extractMoChapterText(fx('chapter-536.html'), { chapter: '999', url: 'x' }), MoPageIdentityError);
});

test('extractMoChapterText bot page fails typed', () => {
  assert.throws(() => extractMoChapterText(fx('bot-page.html'), { chapter: '536', url: 'x' }), MoBotPageError);
});

test('MO URL builders produce the verified revisor.mo.gov shapes', () => {
  assert.equal(buildMoSectionUrl('536.010'), 'https://revisor.mo.gov/main/OneSection.aspx?section=536.010');
  assert.equal(buildMoChapterUrl('536'), 'https://revisor.mo.gov/main/OneChapter.aspx?chapter=536');
});

test('extractMoSectionText throws MoPageIdentityError when the body-start marker is absent (controller ruling: no silent slice-from-0 fallback)', () => {
  // Mangle the REAL fixture's body-start marker so the identity check (section number present)
  // still passes but isolateBetween can no longer find where the body begins. Per the controller
  // ruling on Task 3's review, isolateBetween must THROW here rather than silently widening the
  // slice to the whole document.
  const startMarker = '<div class="norm" title="" style="background-color:#fffff7;padding-left:.75%;padding-right:.75%;">';
  const real = fx('section-536.010.html');
  assert.ok(real.includes(startMarker), 'fixture must still contain the marker this test mangles');
  const mangled = real.replace(startMarker, '<!-- gone -->');
  assert.throws(
    () => extractMoSectionText(mangled, { section: '536.010', url: 'x' }),
    MoPageIdentityError,
  );
});
