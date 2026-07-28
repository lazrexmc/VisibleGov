import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTermText, upsertKeyFor, normalizeCitation, persistReferencedTerms,
  GLOSSARY_TERMS_TABLE, SUMMARY_TERMS_TABLE,
} from '../src/lib/glossary-terms.js';
import * as extractTerms from '../src/cli/extract-terms.js';

// Fix wave (final review, Important finding 2): normalizeTermText/upsertKeyFor/normalizeCitation
// moved here from extract-terms.js so summarize.js could reuse them too (see that file's
// createDraftSummary). extract-terms.js re-exports them UNCHANGED — proving here that the
// re-exports are the SAME function objects (not re-implemented copies) is what guarantees the two
// callers can never silently drift apart, the exact risk this fix wave was meant to close.
test('extract-terms.js re-exports normalizeTermText/upsertKeyFor/normalizeCitation BY REFERENCE, not as re-implemented copies', () => {
  assert.equal(extractTerms.normalizeTermText, normalizeTermText);
  assert.equal(extractTerms.upsertKeyFor, upsertKeyFor);
  assert.equal(extractTerms.normalizeCitation, normalizeCitation);
});

test('table name constants match the actual migration 0007 table names', () => {
  assert.equal(GLOSSARY_TERMS_TABLE, 'glossary_terms');
  assert.equal(SUMMARY_TERMS_TABLE, 'summary_terms');
});

// persistReferencedTerms itself (the shared mechanical layer, no missing-relation tolerance —
// that policy lives at each call site) — a light direct check that an empty referencedTerms array
// is a no-op, complementing the fuller fake-client coverage exercised indirectly through
// summarize.js's persistReferencedTermsGracefully (tests/summarize-cli.test.js) and
// extract-terms.js's own extractOne (tests/extract-terms-cli.test.js's upstream unit coverage of
// the pure pieces it's built from).
test('persistReferencedTerms is a no-op (no DB calls, termsUpserted 0) for an empty referencedTerms array', async () => {
  let calls = 0;
  const client = { from: () => { calls += 1; return {}; } };
  const result = await persistReferencedTerms(client, 'run-1', { summaryId: 'sum-1', referencedTerms: [] });
  assert.deepEqual(result, { termsUpserted: 0 });
  assert.equal(calls, 0);
});
