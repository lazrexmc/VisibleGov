import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPLETENESS_SCHEMA, COMPLETENESS_SYSTEM_PROMPT, COMPLETENESS_PROMPT_VERSION,
  buildProvisionsMessage, buildCoverageMessage, assessCompleteness,
  MIN_KEY_PROVISIONS, MAX_KEY_PROVISIONS,
} from '../src/lib/verifier.js';

// ---- COMPLETENESS_PROMPT_VERSION ----

test('COMPLETENESS_PROMPT_VERSION is pinned, independent of VERIFY_PROMPT_VERSION', () => {
  assert.equal(COMPLETENESS_PROMPT_VERSION, 'v1');
});

// ---- COMPLETENESS_SCHEMA shape ----

test('COMPLETENESS_SCHEMA top level requires key_provisions + coverage, additionalProperties false', () => {
  assert.deepEqual(COMPLETENESS_SCHEMA.required.sort(), ['coverage', 'key_provisions']);
  assert.equal(COMPLETENESS_SCHEMA.additionalProperties, false);
});

test('COMPLETENESS_SCHEMA.key_provisions items require section + provision, additionalProperties false', () => {
  const item = COMPLETENESS_SCHEMA.properties.key_provisions.items;
  assert.deepEqual(item.required.sort(), ['provision', 'section']);
  assert.equal(item.additionalProperties, false);
  assert.ok(item.properties.section);
  assert.ok(item.properties.provision);
});

test('COMPLETENESS_SCHEMA.key_provisions is bounded to 3-7 entries', () => {
  assert.equal(COMPLETENESS_SCHEMA.properties.key_provisions.minItems, 3);
  assert.equal(COMPLETENESS_SCHEMA.properties.key_provisions.maxItems, 7);
});

test('COMPLETENESS_SCHEMA.coverage items require all four fields, additionalProperties false', () => {
  const item = COMPLETENESS_SCHEMA.properties.coverage.items;
  assert.deepEqual(item.required.sort(), ['bullet_index', 'covered', 'note', 'provision_index']);
  assert.equal(item.additionalProperties, false);
  assert.ok(item.properties.provision_index);
  assert.ok(item.properties.covered);
  assert.ok(item.properties.bullet_index);
  assert.ok(item.properties.note);
});

test('COMPLETENESS_SCHEMA.coverage.bullet_index type allows null (covered:false uses it)', () => {
  const t = COMPLETENESS_SCHEMA.properties.coverage.items.properties.bullet_index.type;
  assert.ok(Array.isArray(t) ? t.includes('null') : t === 'null', 'bullet_index type must allow null');
});

// ---- COMPLETENESS_SYSTEM_PROMPT: two-phase orchestration markers ----

test('COMPLETENESS_SYSTEM_PROMPT names both phases and the 3-7 provision bound', () => {
  const lower = COMPLETENESS_SYSTEM_PROMPT.toLowerCase();
  for (const marker of ['phase 1', 'phase 2', 'section', 'bullet_index', '3', '7']) {
    assert.ok(lower.includes(marker), `missing marker: ${marker}`);
  }
});

test('COMPLETENESS_SYSTEM_PROMPT states phase 1 must not see the summary', () => {
  const lower = COMPLETENESS_SYSTEM_PROMPT.toLowerCase();
  assert.ok(lower.includes('never') || lower.includes('not been shown') || lower.includes('only'), 'expected an explicit no-summary-in-phase-1 marker');
  assert.ok(lower.includes('summary'));
});

// ---- buildProvisionsMessage / buildCoverageMessage ----

test('buildProvisionsMessage embeds identifier and bill text, never the summary', () => {
  const msg = buildProvisionsMessage('HR 498', 'SECTION 1. Text.');
  assert.ok(msg.includes('HR 498'));
  assert.ok(msg.includes('SECTION 1.'));
});

test('buildCoverageMessage embeds identifier, provisions json, and bullets json', () => {
  const provisionsJson = JSON.stringify([{ section: 'Sec. 2', provision: 'Bars X.' }]);
  const bulletsJson = JSON.stringify([{ index: 0, point: 'Bars X', section: 'Sec. 2' }]);
  const msg = buildCoverageMessage('HR 498', provisionsJson, bulletsJson);
  assert.ok(msg.includes('HR 498'));
  assert.ok(msg.includes(provisionsJson));
  assert.ok(msg.includes(bulletsJson));
});

// ============================================================
// assessCompleteness — the mechanical, never-trust-the-checker's-self-report gate
// ============================================================

const BILL_TEXT = 'SEC. 1. Bars judicial review of the reissuance.\nSEC. 2. Establishes a grant program.\nSEC. 3. Repeals the prior reporting requirement.\n';

function goodPayload(overrides = {}) {
  return {
    key_provisions: [
      { section: 'SEC. 1.', provision: 'Bars judicial review of the reissuance.' },
      { section: 'SEC. 2.', provision: 'Establishes a grant program.' },
      { section: 'SEC. 3.', provision: 'Repeals the prior reporting requirement.' },
    ],
    coverage: [
      { provision_index: 0, covered: true, bullet_index: 0, note: 'covered by bullet 0' },
      { provision_index: 1, covered: true, bullet_index: 1, note: 'covered by bullet 1' },
      { provision_index: 2, covered: true, bullet_index: 2, note: 'covered by bullet 2' },
    ],
    ...overrides,
  };
}

// ---- complete ----

test('assessCompleteness: well-formed, grounded, every provision covered -> complete', () => {
  const result = assessCompleteness(goodPayload(), 3, BILL_TEXT);
  assert.deepEqual(result, { overall: 'complete', missing: [], reasons: [] });
});

// ---- malformed: count mismatch ----

test('assessCompleteness: coverage.length !== key_provisions.length -> malformed', () => {
  const payload = goodPayload({ coverage: goodPayload().coverage.slice(0, 2) });
  const result = assessCompleteness(payload, 3, BILL_TEXT);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /coverage has 2 entries but key_provisions has 3/);
});

// ---- malformed: duplicate provision_index ----

test('assessCompleteness: duplicate provision_index -> malformed', () => {
  const payload = goodPayload();
  payload.coverage[2] = { ...payload.coverage[1] };
  const result = assessCompleteness(payload, 3, BILL_TEXT);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /duplicate/);
});

// ---- malformed: out-of-range provision_index ----

test('assessCompleteness: out-of-range provision_index -> malformed', () => {
  const payload = goodPayload();
  payload.coverage[2].provision_index = 99;
  const result = assessCompleteness(payload, 3, BILL_TEXT);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /out of range/);
});

// ---- malformed: covered=true with null/out-of-range bullet_index ----

test('assessCompleteness: covered=true with a null bullet_index -> malformed', () => {
  const payload = goodPayload();
  payload.coverage[0].bullet_index = null;
  const result = assessCompleteness(payload, 3, BILL_TEXT);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /covered=true but bullet_index/);
});

test('assessCompleteness: covered=true with an out-of-range bullet_index -> malformed', () => {
  const payload = goodPayload();
  payload.coverage[0].bullet_index = 99;
  const result = assessCompleteness(payload, 3, BILL_TEXT);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /covered=true but bullet_index/);
});

// ---- malformed: covered=false with a non-null bullet_index ----

test('assessCompleteness: covered=false with a non-null bullet_index -> malformed', () => {
  const payload = goodPayload();
  payload.coverage[0].covered = false;
  // bullet_index left at 0 (non-null) — the illegal combination.
  const result = assessCompleteness(payload, 3, BILL_TEXT);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /covered=false but bullet_index is 0/);
});

// ---- malformed: zero provisions (the vacuous-empty class) ----

test('assessCompleteness: zero key_provisions -> malformed, never a vacuous "complete"', () => {
  const result = assessCompleteness({ key_provisions: [], coverage: [] }, 3, BILL_TEXT);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /zero key_provisions/);
});

test('assessCompleteness: absent/malformed top-level shape -> malformed, never throws', () => {
  assert.equal(assessCompleteness(null, 3, BILL_TEXT).overall, 'malformed');
  assert.equal(assessCompleteness(undefined, 3, BILL_TEXT).overall, 'malformed');
  assert.equal(assessCompleteness({}, 3, BILL_TEXT).overall, 'malformed');
  assert.equal(assessCompleteness({ key_provisions: 'nope', coverage: [] }, 3, BILL_TEXT).overall, 'malformed');
});

// ---- grounding: a provision citing a section absent from the bill text ----

test('assessCompleteness: a key_provisions section not present in the bill text -> malformed (the checker invented it)', () => {
  const payload = goodPayload();
  payload.key_provisions[1].section = 'SEC. 402.';
  const result = assessCompleteness(payload, 3, BILL_TEXT);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /SEC\. 402\./);
  assert.match(result.reasons.join(' '), /does not appear in the bill text/);
});

// ---- grounding acceptance across whitespace/wrapping differences ----

test('assessCompleteness: grounding tolerates whitespace/wrapping differences (same discipline as checkStatedPurposeGrounding)', () => {
  const wrappedText = 'SEC.\n  1.   Bars   judicial\n  review of the\nreissuance.\nSEC. 2. Establishes a grant program.\nSEC. 3. Repeals the prior reporting requirement.\n';
  const result = assessCompleteness(goodPayload(), 3, wrappedText);
  assert.equal(result.overall, 'complete');
});

// ---- incomplete: naming the right missing provisions ----

test('assessCompleteness: one provision uncovered -> incomplete, naming exactly that provision', () => {
  const payload = goodPayload();
  payload.coverage[1] = { provision_index: 1, covered: false, bullet_index: null, note: 'no bullet mentions the grant program' };
  const result = assessCompleteness(payload, 3, BILL_TEXT);
  assert.equal(result.overall, 'incomplete');
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].provision_index, 1);
  assert.equal(result.missing[0].section, 'SEC. 2.');
  assert.match(result.missing[0].provision, /grant program/);
});

test('assessCompleteness: multiple provisions uncovered -> incomplete, naming all of them', () => {
  const payload = goodPayload();
  payload.coverage[0] = { provision_index: 0, covered: false, bullet_index: null, note: 'n/a' };
  payload.coverage[2] = { provision_index: 2, covered: false, bullet_index: null, note: 'n/a' };
  const result = assessCompleteness(payload, 3, BILL_TEXT);
  assert.equal(result.overall, 'incomplete');
  assert.deepEqual(result.missing.map((m) => m.provision_index).sort(), [0, 2]);
});

// ---- pure / never throws on garbage input ----

test('assessCompleteness: never throws on garbage bulletCount/billText', () => {
  assert.doesNotThrow(() => assessCompleteness(goodPayload(), 0, ''));
  assert.doesNotThrow(() => assessCompleteness(goodPayload(), 3, null));
  assert.doesNotThrow(() => assessCompleteness(goodPayload(), 3, undefined));
});

test('assessCompleteness: a non-empty billText argument of "" cannot ground anything -> malformed', () => {
  const result = assessCompleteness(goodPayload(), 3, '');
  assert.equal(result.overall, 'malformed');
});

// ---- malformed: the declared 3-7 provision bound, enforced mechanically ----
// Review finding (2026-07-31): the schema declared minItems/maxItems but assessCompleteness never
// checked them, so a checker naming ONE trivially-covered provision earned the same 'complete'
// verdict — and the same public "covers the bill's key provisions" receipt — as a real check.
// A schema bound is a request to the checker; trust model v3 says never assume compliance.

test('assessCompleteness: fewer than MIN_KEY_PROVISIONS -> malformed (a thin check cannot earn the receipt)', () => {
  const thin = {
    key_provisions: [{ section: 'SEC. 1.', provision: 'Bars judicial review of the reissuance.' }],
    coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'covered' }],
  };
  const result = assessCompleteness(thin, 3, BILL_TEXT);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons[0], /1 entries, outside the required 3-7/);
});

test('assessCompleteness: exactly MIN_KEY_PROVISIONS is accepted (the bound is inclusive)', () => {
  assert.equal(assessCompleteness(goodPayload(), 3, BILL_TEXT).overall, 'complete');
});

test('assessCompleteness: more than MAX_KEY_PROVISIONS -> malformed (the checker ignored its instructions)', () => {
  const provisions = [];
  const coverage = [];
  for (let i = 0; i < 8; i += 1) {
    provisions.push({ section: 'SEC. 1.', provision: 'Bars judicial review of the reissuance.' });
    coverage.push({ provision_index: i, covered: true, bullet_index: 0, note: 'covered' });
  }
  const result = assessCompleteness({ key_provisions: provisions, coverage }, 3, BILL_TEXT);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons[0], /8 entries, outside the required 3-7/);
});

test('MIN/MAX_KEY_PROVISIONS are the same values the schema declares (no drift between the ask and the enforcement)', () => {
  assert.equal(COMPLETENESS_SCHEMA.properties.key_provisions.minItems, MIN_KEY_PROVISIONS);
  assert.equal(COMPLETENESS_SCHEMA.properties.key_provisions.maxItems, MAX_KEY_PROVISIONS);
});
