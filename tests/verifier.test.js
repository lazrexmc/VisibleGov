import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERIFIER_MODEL, VERIFY_PROMPT_VERSION, VERIFY_SCHEMA, VERIFY_SYSTEM_PROMPT,
  buildVerifyMessage, verifyBill,
} from '../src/lib/verifier.js';
import { MODEL, MAX_TEXT_CHARS, OversizeTextError, renderMarkdown } from '../src/lib/summarizer.js';
import { parseArgs, parseBullets } from '../src/cli/verify.js';

// ---- constants (controller ruling #4: sonnet stays sonnet, deliberately not opus) ----

test('VERIFIER_MODEL is claude-sonnet-5, deliberately a different weight class than the opus-5 author', () => {
  assert.equal(VERIFIER_MODEL, 'claude-sonnet-5');
  assert.notEqual(VERIFIER_MODEL, MODEL);
});

test('VERIFY_PROMPT_VERSION pinned', () => {
  assert.equal(VERIFY_PROMPT_VERSION, 'v1');
});

// ---- schema shape ----

test('VERIFY_SCHEMA top level requires verdicts + overall, additionalProperties false', () => {
  assert.deepEqual(VERIFY_SCHEMA.required.sort(), ['overall', 'verdicts']);
  assert.equal(VERIFY_SCHEMA.additionalProperties, false);
});

test('VERIFY_SCHEMA.overall is an enum of exactly clean/flagged', () => {
  assert.deepEqual(VERIFY_SCHEMA.properties.overall.enum.sort(), ['clean', 'flagged']);
});

test('VERIFY_SCHEMA.verdicts items require all five fields, additionalProperties false', () => {
  const item = VERIFY_SCHEMA.properties.verdicts.items;
  assert.deepEqual(item.required.sort(), ['bullet_index', 'evidence_quote', 'reason', 'section', 'supported']);
  assert.equal(item.additionalProperties, false);
  assert.ok(item.properties.bullet_index);
  assert.ok(item.properties.section);
  assert.ok(item.properties.supported);
  assert.ok(item.properties.reason);
  assert.ok(item.properties.evidence_quote);
});

// ---- adversarial system prompt ----

test('VERIFY_SYSTEM_PROMPT contains the required adversarial-stance markers', () => {
  for (const marker of ['refute', 'cited section', 'fully supported', 'quote']) {
    assert.ok(VERIFY_SYSTEM_PROMPT.toLowerCase().includes(marker), `missing marker: ${marker}`);
  }
});

// ---- buildVerifyMessage ----

test('buildVerifyMessage embeds identifier, bulletsJson, and bill text', () => {
  const bulletsJson = JSON.stringify([{ index: 0, point: 'Prohibits X', section: 'Sec. 2' }]);
  const msg = buildVerifyMessage('HR 498', bulletsJson, 'SECTION 1. Text.');
  assert.ok(msg.includes('HR 498'));
  assert.ok(msg.includes(bulletsJson));
  assert.ok(msg.includes('SECTION 1.'));
});

// ---- verifyBill: oversize path is testable without any live/stub client (throws before touching it) ----

test('verifyBill throws OversizeTextError before touching the client when text exceeds MAX_TEXT_CHARS', async () => {
  const text = 'x'.repeat(MAX_TEXT_CHARS + 1);
  await assert.rejects(
    () => verifyBill({}, { identifier: 'HR 1', bullets: [], text }),
    OversizeTextError,
  );
});

// ---- parseBullets: the renderer's inverse (controller ruling #2) ----

test('parseBullets round-trips renderMarkdown output for multiple bullets, tolerating parens in section strings', () => {
  const summary = {
    what_it_does: [
      { point: 'Prohibits X payments', section: 'Sec. 2' },
      { point: 'Establishes a new grant program', section: 'Sec. 3(a)' },
      {
        point: 'Amends definitions used elsewhere in the act, including parenthetical terms (like this)',
        section: 'Sec. 4(b)(2)',
      },
    ],
    stated_purpose: 'To prohibit X and establish Y.',
    classification: 'amends_existing_law',
  };
  const md = renderMarkdown(summary);
  const bullets = parseBullets(md);
  assert.deepEqual(bullets, [
    { index: 0, point: 'Prohibits X payments', section: 'Sec. 2' },
    { index: 1, point: 'Establishes a new grant program', section: 'Sec. 3(a)' },
    {
      index: 2,
      point: 'Amends definitions used elsewhere in the act, including parenthetical terms (like this)',
      section: 'Sec. 4(b)(2)',
    },
  ]);
});

test('parseBullets round-trips the no-purpose case (empty stated_purpose renders no trailing paragraph)', () => {
  const summary = {
    what_it_does: [{ point: 'Repeals an obsolete reporting requirement', section: 'Sec. 1' }],
    stated_purpose: '',
    classification: 'other',
  };
  const md = renderMarkdown(summary);
  assert.ok(!md.includes('Stated purpose'));
  assert.deepEqual(parseBullets(md), [{ index: 0, point: 'Repeals an obsolete reporting requirement', section: 'Sec. 1' }]);
});

test('parseBullets ignores non-bullet lines (heading, purpose paragraph, blank lines)', () => {
  const md = '**What it does:**\n- Only point (Sec. 9)\n\n**Stated purpose (from the bill):** To do the thing.';
  assert.deepEqual(parseBullets(md), [{ index: 0, point: 'Only point', section: 'Sec. 9' }]);
});

test('parseBullets on empty/absent body_md returns an empty array', () => {
  assert.deepEqual(parseBullets(''), []);
  assert.deepEqual(parseBullets(null), []);
});

// ---- CLI arg parsing ----

test('parseArgs defaults dryRun to false and accepts --dry-run', () => {
  assert.equal(parseArgs([]).dryRun, false);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

// isMissingRelationError itself now lives in src/lib/db.js (shared with the review server) —
// see tests/db.test.js for its unit tests. verify.js just imports and uses it.
