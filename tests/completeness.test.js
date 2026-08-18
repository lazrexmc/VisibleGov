import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPLETENESS_SCHEMA, COMPLETENESS_SYSTEM_PROMPT, COMPLETENESS_PROMPT_VERSION,
  buildProvisionsMessage, buildCoverageMessage, assessCompleteness,
  MIN_KEY_PROVISIONS, MAX_KEY_PROVISIONS, minKeyProvisionsFor,
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

test('COMPLETENESS_SCHEMA.key_provisions allows down to 1 entry (the gate enforces the REAL, length-scaled floor); ceiling stays 7', () => {
  // 2026-08-08 (wave-C catch-22 fix): a schema minItems of 3 FORCED checkers on sub-3-provision
  // bills to pad with enactment boilerplate the author contract rightly omits, making tiny bills
  // structurally unpublishable. The schema now permits 1+; minKeyProvisionsFor(billText.length)
  // is the mechanical floor assessCompleteness actually enforces.
  assert.equal(COMPLETENESS_SCHEMA.properties.key_provisions.minItems, 1);
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

test('assessCompleteness: fewer than the floor on a FULL-SIZE bill -> malformed (a thin check cannot earn the receipt; the scaled floor only relaxes for genuinely tiny bills)', () => {
  const fullSizeText = `${BILL_TEXT}${'x '.repeat(3000)}`; // >=5000 chars -> floor is the standard 3
  const thin = {
    key_provisions: [{ section: 'SEC. 1.', provision: 'Bars judicial review of the reissuance.' }],
    coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'covered' }],
  };
  const result = assessCompleteness(thin, 3, fullSizeText);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons[0], /without a well-formed corroboration run/);
});

test('assessCompleteness: exactly MIN_KEY_PROVISIONS is accepted (the bound is inclusive) — on a FULL-SIZE bill where the standard floor of 3 actually binds', () => {
  // goodPayload() carries exactly 3 provisions grounded in BILL_TEXT; padding the text past 5000
  // chars makes the standard floor apply, so this genuinely exercises the floor=3 accept boundary
  // (against the tiny fixture alone the real floor would be 1 and the title would overclaim).
  const fullSizeText = `${BILL_TEXT}${'x '.repeat(3000)}`;
  assert.equal(assessCompleteness(goodPayload(), 3, fullSizeText).overall, 'complete');
  assert.equal(assessCompleteness(goodPayload(), 3, BILL_TEXT).overall, 'complete'); // and tiny still accepts 3
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
  assert.match(result.reasons[0], /8 entries, outside the required 1-7/);
});

test('MAX_KEY_PROVISIONS matches the schema ceiling; the schema FLOOR is deliberately 1 (the gate scales the real floor by bill length)', () => {
  assert.equal(COMPLETENESS_SCHEMA.properties.key_provisions.maxItems, MAX_KEY_PROVISIONS);
  assert.equal(COMPLETENESS_SCHEMA.properties.key_provisions.minItems, 1);
  assert.equal(MIN_KEY_PROVISIONS, 3); // the standard floor for full-size bills, unchanged
});

// ---- length-scaled mechanical floor (2026-08-08, the wave-C tiny-bill catch-22 fix) ----

test('minKeyProvisionsFor: <2500 chars -> 1; <5000 -> 2; >=5000 -> 3; garbage input -> the conservative 3', () => {
  assert.equal(minKeyProvisionsFor(0), 1);
  assert.equal(minKeyProvisionsFor(2499), 1);
  assert.equal(minKeyProvisionsFor(2500), 2);
  assert.equal(minKeyProvisionsFor(4999), 2);
  assert.equal(minKeyProvisionsFor(5000), 3);
  assert.equal(minKeyProvisionsFor(400000), 3);
  assert.equal(minKeyProvisionsFor(NaN), 3);
  assert.equal(minKeyProvisionsFor(undefined), 3);
  assert.equal(minKeyProvisionsFor(-1), 3);
});

test('assessCompleteness: ONE grounded, covered provision on a tiny bill (<2500 chars) -> complete (no boilerplate padding required)', () => {
  // BILL_TEXT is ~150 chars — a genuinely tiny bill. One real provision is a real check.
  const payload = {
    key_provisions: [{ section: 'SEC. 1.', provision: 'Bars judicial review of the reissuance.' }],
    coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'covered' }],
  };
  const result = assessCompleteness(payload, 1, BILL_TEXT);
  assert.equal(result.overall, 'complete');
});

test('assessCompleteness: TWO provisions on a mid-tiny bill (2500-4999 chars) -> complete; ONE on the same bill -> malformed (below its floor of 2)', () => {
  const midText = `${BILL_TEXT}${'x '.repeat(1600)}`; // ~3350 chars
  const two = {
    key_provisions: [
      { section: 'SEC. 1.', provision: 'Bars judicial review of the reissuance.' },
      { section: 'SEC. 2.', provision: 'Establishes a grant program.' },
    ],
    coverage: [
      { provision_index: 0, covered: true, bullet_index: 0, note: 'covered' },
      { provision_index: 1, covered: true, bullet_index: 1, note: 'covered' },
    ],
  };
  assert.equal(assessCompleteness(two, 2, midText).overall, 'complete');

  const one = {
    key_provisions: [{ section: 'SEC. 1.', provision: 'Bars judicial review of the reissuance.' }],
    coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'covered' }],
  };
  const result = assessCompleteness(one, 1, midText);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons[0], /without a well-formed corroboration run/);
});

test('assessCompleteness: TWO provisions on a full-size bill (>=5000 chars) -> malformed (the standard floor of 3 still binds)', () => {
  const bigText = `${BILL_TEXT}${'x '.repeat(3000)}`; // ~6150 chars
  const two = {
    key_provisions: [
      { section: 'SEC. 1.', provision: 'Bars judicial review of the reissuance.' },
      { section: 'SEC. 2.', provision: 'Establishes a grant program.' },
    ],
    coverage: [
      { provision_index: 0, covered: true, bullet_index: 0, note: 'covered' },
      { provision_index: 1, covered: true, bullet_index: 1, note: 'covered' },
    ],
  };
  const result = assessCompleteness(two, 2, bigText);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons[0], /without a well-formed corroboration run/);
});

test('assessCompleteness: zero provisions stays malformed at EVERY size — the scaled floor never reaches 0', () => {
  assert.equal(assessCompleteness({ key_provisions: [], coverage: [] }, 3, 'x').overall, 'malformed');
});

// ============================================================
// sub-floor corroboration (spec 2026-08-18): a yield below the length-scaled floor is
// publishable ONLY when a second independent blind extraction mechanically corroborates it
// ============================================================

// ≥5,000 chars → minKeyProvisionsFor floor of 3; the substance is one Resolved clause + one
// grant section, so honest yields of 1-2 are SUB-floor here.
const WHEREAS_PAD = 'Whereas the Congress has found further considerations worth weighing; '.repeat(80);
const LONG_THIN_TEXT = `${WHEREAS_PAD}Resolved, That the Senate designates the week. SEC. 2. Establishes a grant program.`;

function thinPayload(overrides = {}) {
  return {
    key_provisions: [{ section: 'Resolved,', provision: 'Designates the week.' }],
    coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'covered by bullet 0' }],
    ...overrides,
  };
}
const thinCorroboration = () => ({ key_provisions: [{ section: 'Resolved,', provision: 'Designates the week.' }] });

// spec test 1 — the happy path
test('assessCompleteness sub-floor: corroborated equal count + overlapping grounded sections -> complete', () => {
  const result = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT, thinCorroboration());
  assert.deepEqual(result, { overall: 'complete', missing: [], reasons: [] });
});

// spec test 2 — corroborator finds fewer than the primary
test('assessCompleteness sub-floor: primary 2, corroborator 1 with overlapping section -> corroborated', () => {
  const payload = thinPayload({
    key_provisions: [
      { section: 'Resolved,', provision: 'Designates the week.' },
      { section: 'SEC. 2.', provision: 'Establishes a grant program.' },
    ],
    coverage: [
      { provision_index: 0, covered: true, bullet_index: 0, note: 'n' },
      { provision_index: 1, covered: true, bullet_index: 0, note: 'n' },
    ],
  });
  const result = assessCompleteness(payload, 1, LONG_THIN_TEXT, thinCorroboration());
  assert.equal(result.overall, 'complete');
});

// spec test 3 — corroborator finds MORE -> the primary may have missed substance
test('assessCompleteness sub-floor: corroborator finds more provisions than primary -> malformed', () => {
  const cor = { key_provisions: [
    { section: 'Resolved,', provision: 'Designates the week.' },
    { section: 'SEC. 2.', provision: 'Establishes a grant program.' },
  ] };
  const result = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT, cor);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /primary may have missed substance/);
});

// spec test 4 — ungrounded corroborator section
test('assessCompleteness sub-floor: corroborator cites a section absent from the bill -> malformed', () => {
  const cor = { key_provisions: [{ section: 'SEC. 99.', provision: 'Invented.' }] };
  const result = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT, cor);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /not found in the bill text/);
});

// spec test 5 — grounded but non-overlapping section
test('assessCompleteness sub-floor: corroborator section matches no primary section -> malformed', () => {
  const cor = { key_provisions: [{ section: 'SEC. 2.', provision: 'Establishes a grant program.' }] };
  const result = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT, cor);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /matches no primary provision/);
});

// ---- boundary-aware containment (final whole-branch review, finding 1) ----
// Plain substring containment (`ps.includes(normalized) || normalized.includes(ps)`) is vacuous:
// "TITLE I" is a literal prefix of "TITLE II", "Section 2" is a literal prefix of "Section 24" —
// a primary/corroborator pair naming DIFFERENT sections would wrongly count as corroborated.
// These are THE regression tests for that defect.

const TITLE_BILL_TEXT = `${WHEREAS_PAD}TITLE I--Definitions. TITLE II--Appropriations. Resolved, that the Senate designates the week.`;

test('assessCorroboration boundary containment: primary TITLE I vs corroborator TITLE II -> malformed, matches-no-primary (regression)', () => {
  const payload = thinPayload({
    key_provisions: [{ section: 'TITLE I', provision: 'Sets definitions.' }],
    coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'n' }],
  });
  const cor = { key_provisions: [{ section: 'TITLE II', provision: 'Appropriates funds.' }] };
  const result = assessCompleteness(payload, 1, TITLE_BILL_TEXT, cor);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /matches no primary provision/);
});

const SECTION_BILL_TEXT = `${WHEREAS_PAD}Section 2 establishes eligibility. Section 24 establishes penalties. Resolved, that the Senate designates the week.`;

test('assessCorroboration boundary containment: primary Section 2 vs corroborator Section 24 -> malformed, matches-no-primary', () => {
  const payload = thinPayload({
    key_provisions: [{ section: 'Section 2', provision: 'Establishes eligibility.' }],
    coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'n' }],
  });
  const cor = { key_provisions: [{ section: 'Section 24', provision: 'Establishes penalties.' }] };
  const result = assessCompleteness(payload, 1, SECTION_BILL_TEXT, cor);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /matches no primary provision/);
});

const SEC_ESTABLISH_BILL_TEXT = `${WHEREAS_PAD}SEC. 2. ESTABLISHMENT OF PROGRAM. Resolved, that the Senate designates the week.`;

test('assessCorroboration boundary containment: primary SEC. 2. vs corroborator SEC. 2. ESTABLISHMENT OF PROGRAM. -> corroborated (honest same-section variance stays passing)', () => {
  const payload = thinPayload({
    key_provisions: [{ section: 'SEC. 2.', provision: 'Establishes a grant program.' }],
    coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'n' }],
  });
  const cor = { key_provisions: [{ section: 'SEC. 2. ESTABLISHMENT OF PROGRAM.', provision: 'Establishes a grant program.' }] };
  const result = assessCompleteness(payload, 1, SEC_ESTABLISH_BILL_TEXT, cor);
  assert.equal(result.overall, 'complete');
});

// spec test 6 — absent / wrong shape / empty, each with its distinct reason
test('assessCompleteness sub-floor: corroboration absent, malformed, or empty -> malformed with distinct reasons', () => {
  const absent = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT);
  assert.equal(absent.overall, 'malformed');
  assert.match(absent.reasons.join(' '), /without a well-formed corroboration run/);

  const wrongShape = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT, { key_provisions: 'nope' });
  assert.equal(wrongShape.overall, 'malformed');
  assert.match(wrongShape.reasons.join(' '), /without a well-formed corroboration run/);

  const empty = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT, { key_provisions: [] });
  assert.equal(empty.overall, 'malformed');
  assert.match(empty.reasons.join(' '), /corroborator that finds none has not checked anything/);
});

// spec test 7 — the vacuous rule always wins
test('assessCompleteness: zero primary provisions + perfect corroboration -> still malformed', () => {
  const result = assessCompleteness({ key_provisions: [], coverage: [] }, 1, LONG_THIN_TEXT, thinCorroboration());
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /zero key_provisions/);
});

// spec test 8 — at-floor path byte-identical; stray corroboration ignored
test('assessCompleteness at-floor: stray corroboration argument is ignored — result identical to the 3-arg call', () => {
  const withCor = assessCompleteness(goodPayload(), 3, BILL_TEXT, { key_provisions: [{ section: 'garbage', provision: 'garbage' }] });
  const withoutCor = assessCompleteness(goodPayload(), 3, BILL_TEXT);
  assert.deepEqual(withCor, withoutCor);
  assert.equal(withCor.overall, 'complete');
});

// spec test 9 (regression) — sub-floor corroborated but coverage incomplete -> incomplete, not complete
test('assessCompleteness sub-floor corroborated: uncovered provision still reads incomplete', () => {
  const payload = thinPayload({ coverage: [{ provision_index: 0, covered: false, bullet_index: null, note: 'missing' }] });
  const result = assessCompleteness(payload, 1, LONG_THIN_TEXT, thinCorroboration());
  assert.equal(result.overall, 'incomplete');
  assert.equal(result.missing.length, 1);
});
