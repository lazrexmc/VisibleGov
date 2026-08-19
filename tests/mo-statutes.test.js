import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoCitation, normalizeMoCitation, isMoCitation } from '../src/adapters/mo-statutes.js';

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
