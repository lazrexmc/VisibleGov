import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseMoCitation, normalizeMoCitation, isMoCitation,
  extractMoSectionText, MoBotPageError, MoPageIdentityError,
  buildMoSectionUrl,
} from '../src/adapters/mo-statutes.js';
import * as moStatutes from '../src/adapters/mo-statutes.js';
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

// ---- F1 (post-audit fix wave, 2026-08-19): chapters are OUT of v1 entirely ----
//
// A chapter page is a table of contents — revisor-authored catchlines plus cross-references naming
// OTHER chapters' subjects — not statutory text. An adversarial audit demonstrated a verifier quote
// drawn from one of those cross-reference lines (e.g. "Deaf persons, auxiliary services and aids,
// 476.750 to 476.766") could mechanically "support" a wrong-chapter gloss claim. Chapters must now
// parse-fail so they stay needs_mapping, honestly, until a design grounds them.
test('parseMoCitation REFUSES every chapter shape — chapters are out of v1 (F1)', () => {
  for (const raw of ['chapter 536', 'RSMo chapter 536', 'chapter 303, RSMo', 'chapter 303', 'Chapter 1']) {
    assert.equal(parseMoCitation(raw), null, raw);
  }
});

test('extractMoChapterText is no longer exported — the chapter extraction path is gone (F1)', () => {
  assert.equal(moStatutes.extractMoChapterText, undefined);
  assert.equal(moStatutes.fetchMoChapter, undefined);
  assert.equal(moStatutes.buildMoChapterUrl, undefined);
});

test('normalizeMoCitation throws defensively on any non-section parse result (F1)', () => {
  assert.throws(() => normalizeMoCitation({ kind: 'chapter', chapter: '536' }), /only section citations exist in v1/);
  assert.throws(() => normalizeMoCitation(null), /only section citations exist in v1/);
});

test('parseMoCitation reparses its own normalized output (gloss-time round trip)', () => {
  assert.deepEqual(parseMoCitation('RSMo 536.010'), { kind: 'section', section: '536.010' });
});

// ---- F2 (post-audit fix wave): parser hardening, both directions ----

test('parseMoCitation refuses a zero or leading-zero chapter part (F2)', () => {
  for (const raw of ['0.500', '000.000', '053.010', 'section 0.500', 'RSMo 053.010']) {
    assert.equal(parseMoCitation(raw), null, raw);
  }
  // A leading-zero SECTION suffix after the dot is untouched — RSMo genuinely prints '536.010'.
  assert.deepEqual(parseMoCitation('536.010'), { kind: 'section', section: '536.010' });
  assert.deepEqual(parseMoCitation('section 302.015, RSMo'), { kind: 'section', section: '302.015' });
});

// Low-chapter corroboration guard: MO appropriations bills (HB 1-19) number their OWN internal
// sections N.MMM, so a BARE low-chapter dotted cite inside a MO bill is ambiguous between a real
// RSMo section and the bill's own internal section. Refuse unless the text itself carries RSMo.
test('parseMoCitation refuses a BARE low-chapter dotted cite but accepts the RSMo-corroborated form (F2)', () => {
  assert.equal(parseMoCitation('section 2.100'), null);
  assert.equal(parseMoCitation('1.140'), null);
  assert.equal(parseMoCitation('section 20.100'), null, 'chapter 20 is the boundary — still refused bare');
  assert.deepEqual(parseMoCitation('RSMo 1.140'), { kind: 'section', section: '1.140' });
  assert.deepEqual(parseMoCitation('section 1.140, RSMo'), { kind: 'section', section: '1.140' });
  // Chapter 21 and up are unambiguous — no RSMo marker needed.
  assert.deepEqual(parseMoCitation('section 21.100'), { kind: 'section', section: '21.100' });
});

test('parseMoCitation round-trips its own stored output for a low-chapter section (the guard must not break gloss time) (F2)', () => {
  const parsed = parseMoCitation('section 1.140, RSMo');
  const stored = normalizeMoCitation(parsed);
  assert.equal(stored, 'RSMo 1.140');
  assert.deepEqual(parseMoCitation(stored), { kind: 'section', section: '1.140' });
});

test('parseMoCitation accepts the canonical Missouri year forms and the sec. short form (F2)', () => {
  assert.deepEqual(parseMoCitation('section 536.010, RSMo 2016'), { kind: 'section', section: '536.010' });
  assert.deepEqual(parseMoCitation('section 536.010, RSMo Supp. 2023'), { kind: 'section', section: '536.010' });
  assert.deepEqual(parseMoCitation('sec. 536.010'), { kind: 'section', section: '536.010' });
  assert.deepEqual(parseMoCitation('Sec. 536.010'), { kind: 'section', section: '536.010' });
});

test('parseMoCitation requires BALANCED subdivision groups (F2)', () => {
  assert.deepEqual(parseMoCitation('536.010(1)(a)'), { kind: 'section', section: '536.010' });
  assert.equal(parseMoCitation('536.010(a)b)'), null);
  assert.equal(parseMoCitation('536.010(a'), null);
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
});

test('isMoCitation discriminates stored citation strings', () => {
  assert.equal(isMoCitation('RSMo 536.010'), true);
  // Still true for a legacy 'RSMo chapter N' string: isMoCitation is a pure prefix test, and
  // routing such a citation to the MO path is CORRECT — parseMoCitation then refuses it and
  // fetchGlossSource takes its defensive typed throw, rather than the citation silently falling
  // through to the US Code path (F1).
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

test('extractMoSectionText extracts a repealed section honestly (repeal notice IS official text)', (t) => {
  // Minor finding 5: skip HONESTLY (visible in test output as skipped, not silently as passed)
  // if Task 1 could not capture a repealed fixture (documented in SOURCES.md). The fixture file
  // exists in this repo (tests/fixtures/mo-statutes/section-repealed.html), so this branch is not
  // expected to fire live — it is a documented fallback for a future re-capture, not a shrug.
  let html;
  try { html = fx('section-repealed.html'); } catch { t.skip('section-repealed.html fixture not captured'); return; }
  const section = '1.022';
  const text = extractMoSectionText(html, { section, url: 'x' });
  assert.ok(text.includes(section));
});

test('extractMoSectionText throws MoPageIdentityError when the isolated slice strips to empty even though both real markers are present (template drift)', () => {
  // Synthetic splice of the REAL fixture: keep both real body markers (so isolateBetween itself
  // does not throw for a missing marker — that is finding 1's OTHER, already-covered failure
  // mode, tested above) but delete everything between them, so the isolated+stripped excerpt is
  // the empty string. Per finding 1a, this must be its own typed refusal, not a silent empty
  // extraction.
  const real = fx('section-536.010.html');
  const START = '<div class="norm" title="" style="background-color:#fffff7;padding-left:.75%;padding-right:.75%;">';
  const END = '<hr><div style="padding:.2em 0em 0em 2em;">';
  const s = real.indexOf(START);
  const e = real.indexOf(END, s + START.length);
  assert.ok(s !== -1 && e !== -1, 'fixture must still contain both real markers this test splices around');
  const spliced = real.slice(0, s + START.length) + real.slice(e);
  assert.throws(
    () => extractMoSectionText(spliced, { section: '536.010', url: 'x' }),
    MoPageIdentityError,
  );
});

// ---- F3 (post-audit fix wave): revisor-authored case-law annotations are NOT statute text ----
//
// The captured 536.010 page's `<div class="foot">` block holds the enactment-history source note
// followed by four judicial-decision annotations, each opening with a parenthesized year
// ("(1977) Held, director of revenue must hold hearing... Randle et al. v. Spradling (Mo.), 556
// S.W.2d 10." … "(2000) ... Krentz v. Robertson, 228 F.3d 897 (8th Cir.)."). Those are the
// revisor's editorial commentary ABOUT the statute, not the law — quotable by a gloss author or
// verifier as if they were law if they stay in the excerpt.
test('extractMoSectionText keeps the statute body and enactment history but DROPS the case-law annotations (F3)', () => {
  const text = extractMoSectionText(fx('section-536.010.html'), { section: '536.010', url: 'x' });
  assert.ok(text.includes('For the purpose of this chapter'), 'statute body must survive');
  assert.ok(text.includes('(L. 1945 p. 1504'), 'enactment-history line must survive');
  assert.ok(text.includes('A.L. 2006 S.B. 1146'), 'the whole enactment-history line must survive');
  assert.ok(!text.includes('Krentz'), 'case-law annotation citation must be gone');
  assert.ok(!text.includes('(1977)'), 'case-law annotation must be gone');
  assert.ok(!text.includes('Randle'), 'case-law annotation must be gone');
  assert.ok(!text.includes('Yarber'), 'case-law annotation must be gone');
});

test('extractMoSectionText still extracts the repealed 1.022 fixture unchanged — it has no annotations block to cut (F3)', () => {
  const text = extractMoSectionText(fx('section-repealed.html'), { section: '1.022', url: 'x' });
  assert.ok(text.includes('1.022'));
  assert.ok(/Repealed L\. 1975 H\.B\. 945/.test(text), 'the repeal notice IS the official text and must survive');
});

// ---- F4 (post-audit fix wave): the identity check is PREFIX-ANCHORED ----
//
// The isolated slice genuinely BEGINS with its own section number ("536.010. Definitions. — ...").
// The old contains-anywhere check accepted a page that merely cross-references the requested
// section: 536.010's own body links to 536.100, so requesting 536.100 off 536.010's page passed
// (executed proof). Anchoring proves the page IS the section.
test('extractMoSectionText refuses a page that only CROSS-REFERENCES the requested section (F4)', () => {
  const html = fx('section-536.010.html');
  assert.ok(html.includes('536.100'), 'fixture must still contain the cross-reference this test relies on');
  assert.throws(() => extractMoSectionText(html, { section: '536.100', url: 'x' }), MoPageIdentityError);
});

test('extractMoSectionText: the anchored identity check still accepts the real page it belongs to (F4)', () => {
  const text = extractMoSectionText(fx('section-536.010.html'), { section: '536.010', url: 'x' });
  assert.match(text, /^536\.010\./);
});

test('stripMoHtml decodes &amp; LAST so a literal &amp;lt; in source text does not double-decode into a bare <  (Minor finding 2)', () => {
  const real = fx('section-536.010.html');
  const spliced = real.replace(
    'For the purpose of this chapter',
    'For the purpose of this chapter &amp;lt; literal-marker',
  );
  const text = extractMoSectionText(spliced, { section: '536.010', url: 'x' });
  assert.ok(text.includes('&lt; literal-marker'), 'literal &amp;lt; must decode to the two-character text "&lt;", not "<"');
  assert.ok(!text.includes('< literal-marker'), 'must never double-decode &amp;lt; into a bare <');
});

test('MO URL builder produces the verified revisor.mo.gov shape', () => {
  assert.equal(buildMoSectionUrl('536.010'), 'https://revisor.mo.gov/main/OneSection.aspx?section=536.010');
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
