import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBullets, extractStatedPurpose, extractOneLiner } from '../site/js/summary-parse.js';
import { renderMarkdown } from '../src/lib/summarizer.js';

// ---- parseBullets: two cases pinned from tests/verifier.test.js (controller ruling #2 — the
// point/section split point is the LAST ' (' before line end, not the first) ----

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

test('parseBullets ignores non-bullet lines (heading, purpose paragraph, blank lines)', () => {
  const md = '**What it does:**\n- Only point (Sec. 9)\n\n**Stated purpose (from the bill):** To do the thing.';
  assert.deepEqual(parseBullets(md), [{ index: 0, point: 'Only point', section: 'Sec. 9' }]);
});

// ---- extractStatedPurpose: matches renderMarkdown's exact line prefix ----

test('extractStatedPurpose returns the trimmed text after the exact renderMarkdown prefix', () => {
  const md = renderMarkdown({
    what_it_does: [{ point: 'Repeals an obsolete reporting requirement', section: 'Sec. 1' }],
    stated_purpose: 'To streamline reporting.',
    classification: 'other',
  });
  assert.equal(extractStatedPurpose(md), 'To streamline reporting.');
});

test('extractStatedPurpose returns null when the bill states no purpose (renderMarkdown omits the paragraph)', () => {
  const md = renderMarkdown({
    what_it_does: [{ point: 'Repeals an obsolete reporting requirement', section: 'Sec. 1' }],
    stated_purpose: '',
    classification: 'other',
  });
  assert.equal(extractStatedPurpose(md), null);
});

test('extractStatedPurpose returns null on empty/absent body_md', () => {
  assert.equal(extractStatedPurpose(''), null);
  assert.equal(extractStatedPurpose(null), null);
});

// ---- extractOneLiner: spec §3 mechanical one-liner — stated purpose when present, else first
// bullet point, else null (render title-only) ----

test('extractOneLiner: a real body_md with a purpose and 3 bullets -> the stated purpose', () => {
  const md = renderMarkdown({
    what_it_does: [
      { point: 'Prohibits X payments', section: 'Sec. 2' },
      { point: 'Establishes a new grant program', section: 'Sec. 3(a)' },
      { point: 'Repeals an obsolete reporting requirement', section: 'Sec. 4' },
    ],
    stated_purpose: 'To prohibit X and establish Y.',
    classification: 'amends_existing_law',
  });
  assert.equal(extractOneLiner(md), 'To prohibit X and establish Y.');
});

test('extractOneLiner: a purpose-less body_md -> the first bullet point', () => {
  const md = renderMarkdown({
    what_it_does: [
      { point: 'Establishes a new grant program', section: 'Sec. 3(a)' },
      { point: 'Repeals an obsolete reporting requirement', section: 'Sec. 4' },
    ],
    stated_purpose: '',
    classification: 'other',
  });
  assert.equal(extractOneLiner(md), 'Establishes a new grant program');
});

test('extractOneLiner: empty/garbage body_md -> null (render title-only)', () => {
  assert.equal(extractOneLiner(''), null);
  assert.equal(extractOneLiner(null), null);
  assert.equal(extractOneLiner('not markdown at all, just prose'), null);
});
