import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBodyMd, computeObjections, loadDraftObjections } from '../src/lib/draft-objections.js';

test('parseBodyMd inverts renderMarkdown, including parens inside points and sections', () => {
  const md = '**What it does:**\n- Changes the standard (a big one) to best value. (Sec. 2(a)(1))\n- Second point. (Section A)\n\n**Stated purpose (from the bill):** To do things.';
  const s = parseBodyMd(md);
  assert.equal(s.what_it_does.length, 2);
  assert.equal(s.what_it_does[0].point, 'Changes the standard (a big one) to best value.');
  assert.equal(s.what_it_does[0].section, 'Sec. 2(a)(1)');
  assert.equal(s.what_it_does[1].section, 'Section A');
  assert.equal(s.stated_purpose, 'To do things.');
});

test('computeObjections mirrors the record gates: refuted verdicts, coverage misses, ungrounded purpose', () => {
  const objections = computeObjections({
    verdicts: [
      { bullet_index: 0, section: 'Sec. 1', supported: true, reason: 'ok' },
      { bullet_index: 1, section: 'Sec. 2', supported: false, reason: 'nope' },
    ],
    completeness: {
      key_provisions: [{ section: 'SEC. 3.', provision: 'Adds Z.' }],
      coverage: [{ provision_index: 0, covered: false, bullet_index: null, note: '' }],
    },
    statedPurpose: 'never in the text',
    text: 'SEC. 1. SEC. 2. SEC. 3. Adds Z.',
  });
  assert.equal(objections.length, 3);
  assert.match(objections[0], /Bullet 1 \(cited Sec\. 2\) was REFUTED/);
  assert.match(objections[1], /OMITS a key provision.*\[SEC\. 3\.\] Adds Z\./);
  assert.match(objections[2], /stated_purpose is NOT a verbatim substring/);
});

function fakeClient({ bodyMd, verifications, notes }) {
  const from = (table) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      single: async () => ({ data: { id: 'd-1', body_md: bodyMd }, error: null }),
      then(resolve) { // awaited without .single(): the multi-row tables
        const data = table === 'summary_verifications' ? verifications : notes;
        resolve({ data, error: null });
      },
    };
    return chain;
  };
  return { from };
}

test('loadDraftObjections assembles prior summary + objections from DB rows and dedups the gate note', async () => {
  const client = fakeClient({
    bodyMd: '**What it does:**\n- Point one. (Sec. 1)',
    verifications: [
      { kind: 'support', verdicts: [{ bullet_index: 0, section: 'Sec. 1', supported: false, reason: 'bad' }] },
      { kind: 'completeness', verdicts: { key_provisions: [], coverage: [] } },
    ],
    notes: [
      { note: 'Bullet 0 (cited Sec. 1) was REFUTED by the verifier: bad', action: 'rejected' },
      { note: 'summary omits 1 key provision(s) present in the bill text: X (Y)', action: 'rejected' },
    ],
  });
  const out = await loadDraftObjections(client, { draftId: 'd-1', text: 'Sec. 1' });
  assert.equal(out.priorSummary.what_it_does.length, 1);
  assert.equal(out.hasVerifications, true);
  // the refuted verdict appears once (note dedup'd against it) + the distinct omit-note appears
  assert.equal(out.objections.filter((o) => /REFUTED/.test(o)).length, 1);
  assert.equal(out.objections.filter((o) => /omits 1 key provision/.test(o)).length, 1);
});

test('loadDraftObjections with zero verification rows reports hasVerifications:false', async () => {
  const client = fakeClient({ bodyMd: '**What it does:**\n- P. (S)', verifications: [], notes: [] });
  const out = await loadDraftObjections(client, { draftId: 'd-1', text: 'S' });
  assert.equal(out.hasVerifications, false);
});
