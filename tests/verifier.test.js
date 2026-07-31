import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERIFIER_MODEL, VERIFY_PROMPT_VERSION, VERIFY_SCHEMA, VERIFY_SYSTEM_PROMPT,
  VERIFY_MAX_OUTPUT_TOKENS,
  buildVerifyMessage, verifyBill, assessVerdicts, VerificationIncompleteError,
} from '../src/lib/verifier.js';
import { MODEL, MAX_TEXT_CHARS, OversizeTextError, renderMarkdown } from '../src/lib/summarizer.js';
import { parseArgs, parseBullets, checkBulletCoverage, checkVerifyApproval } from '../src/cli/verify.js';
import { RunNotApprovedError } from '../src/lib/errors.js';

// ---- constants (controller ruling #4: sonnet stays sonnet, deliberately not opus) ----

test('VERIFIER_MODEL is claude-sonnet-5, deliberately a different weight class than the opus-5 author', () => {
  assert.equal(VERIFIER_MODEL, 'claude-sonnet-5');
  assert.notEqual(VERIFIER_MODEL, MODEL);
});

test('VERIFY_PROMPT_VERSION pinned', () => {
  assert.equal(VERIFY_PROMPT_VERSION, 'v1');
});

// Many-bullet summaries (HR 6955, HR 8595) threw SummaryTruncatedError against summarizer.js's
// 16000-token cap: sonnet-5's adaptive thinking plus a full per-bullet verdicts JSON exceeded it.
// The verifier needs its own, larger cap rather than reusing the summarizer's.
test('VERIFY_MAX_OUTPUT_TOKENS is at least 32000, and deliberately not summarizer.js MAX_OUTPUT_TOKENS', () => {
  assert.ok(VERIFY_MAX_OUTPUT_TOKENS >= 32000);
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

// ---- checkBulletCoverage: catches a bullet that lost its trailing '(section)' on edit and so
// vanished from parseBullets' output while still rendering publicly (pre-merge finding 2) ----

test('checkBulletCoverage throws VerificationIncompleteError when body_md has an uncited "- " line invisible to parseBullets', () => {
  const bodyMd = '**What it does:**\n- Prohibits X payments (Sec. 2)\n- Establishes a new grant program, edited to drop its citation';
  const bullets = parseBullets(bodyMd);
  assert.equal(bullets.length, 1); // the uncited line doesn't end in ')', so parseBullets silently drops it
  assert.throws(
    () => checkBulletCoverage('HR 1', bodyMd, bullets),
    VerificationIncompleteError,
  );
});

test('checkBulletCoverage error message names the summary identifier and both counts', () => {
  const bodyMd = '- Point one (Sec. 2)\n- Point two, uncited';
  const bullets = parseBullets(bodyMd);
  try {
    checkBulletCoverage('HR 498', bodyMd, bullets);
    assert.fail('expected checkBulletCoverage to throw');
  } catch (err) {
    assert.ok(err instanceof VerificationIncompleteError);
    assert.match(err.message, /HR 498/);
    assert.match(err.message, /1/); // parsed count
    assert.match(err.message, /2/); // raw count
  }
});

test('checkBulletCoverage does not throw when every raw "- " line parses cleanly', () => {
  const bodyMd = '- Point one (Sec. 2)\n- Point two (Sec. 3)';
  const bullets = parseBullets(bodyMd);
  assert.doesNotThrow(() => checkBulletCoverage('HR 1', bodyMd, bullets));
});

test('checkBulletCoverage does not throw on empty body_md (0 raw === 0 parsed)', () => {
  assert.doesNotThrow(() => checkBulletCoverage('HR 1', '', []));
});

// ---- assessVerdicts: the mechanical completeness gate (pre-merge finding 1) — derives overall
// itself rather than trusting the model's own 'overall' field, which this function's signature
// doesn't even accept. ----

test('assessVerdicts: complete + all supported -> clean', () => {
  const verdicts = [
    { bullet_index: 0, supported: true },
    { bullet_index: 1, supported: true },
  ];
  assert.deepEqual(assessVerdicts(verdicts, 2), { complete: true, overall: 'clean' });
});

test('assessVerdicts: complete + one unsupported -> flagged, even if every verdict claimed clean elsewhere', () => {
  const verdicts = [
    { bullet_index: 0, supported: true },
    { bullet_index: 1, supported: false },
  ];
  assert.deepEqual(assessVerdicts(verdicts, 2), { complete: true, overall: 'flagged' });
});

test('assessVerdicts: missing verdict -> incomplete', () => {
  const verdicts = [{ bullet_index: 0, supported: true }];
  const result = assessVerdicts(verdicts, 2);
  assert.equal(result.complete, false);
});

test('assessVerdicts: duplicate bullet_index -> incomplete', () => {
  const verdicts = [
    { bullet_index: 0, supported: true },
    { bullet_index: 0, supported: true },
  ];
  const result = assessVerdicts(verdicts, 2);
  assert.equal(result.complete, false);
});

test('assessVerdicts: out-of-range bullet_index -> incomplete', () => {
  const verdicts = [
    { bullet_index: 0, supported: true },
    { bullet_index: 5, supported: true },
  ];
  const result = assessVerdicts(verdicts, 2);
  assert.equal(result.complete, false);
});

test('assessVerdicts: negative bullet_index -> incomplete', () => {
  const verdicts = [
    { bullet_index: -1, supported: true },
    { bullet_index: 0, supported: true },
  ];
  const result = assessVerdicts(verdicts, 2);
  assert.equal(result.complete, false);
});

test('assessVerdicts: zero bullets, zero verdicts -> complete/clean (vacuous case)', () => {
  assert.deepEqual(assessVerdicts([], 0), { complete: true, overall: 'clean' });
});

test('assessVerdicts: non-array verdicts -> incomplete rather than throwing', () => {
  const result = assessVerdicts(undefined, 2);
  assert.equal(result.complete, false);
});

// ---- VerificationIncompleteError shape ----

test('VerificationIncompleteError carries a name and passes meta through', () => {
  const err = new VerificationIncompleteError('bad state', { summaryId: 's1' });
  assert.equal(err.name, 'VerificationIncompleteError');
  assert.equal(err.summaryId, 's1');
  assert.ok(err instanceof Error);
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

// ---- checkVerifyApproval: task 1's spend gate — mirrors gloss.js's GLOSS_RUN_APPROVED shape
// exactly, wired to VERIFY_RUN_APPROVED. main() calls this before constructing an Anthropic
// client; see verify.js's main() for the call site. ----

test('checkVerifyApproval blocks unless VERIFY_RUN_APPROVED is exactly "yes"', () => {
  assert.throws(() => checkVerifyApproval(undefined), RunNotApprovedError);
  assert.throws(() => checkVerifyApproval('true'), RunNotApprovedError);
  assert.doesNotThrow(() => checkVerifyApproval('yes'));
});

test('checkVerifyApproval\'s message names VERIFY_RUN_APPROVED specifically, never another CLI\'s var', () => {
  try {
    checkVerifyApproval('no');
    assert.fail('expected checkVerifyApproval to throw');
  } catch (err) {
    assert.match(err.message, /set VERIFY_RUN_APPROVED=yes to proceed/);
    assert.doesNotMatch(err.message, /SUMMARIZE_RUN_APPROVED|GLOSS_RUN_APPROVED|GOLDEN_CHECK_APPROVED/);
  }
});
