import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MODEL, PROMPT_VERSION, MAX_OUTPUT_TOKENS, GLOSS_SCHEMA, GLOSS_SYSTEM_PROMPT,
  buildGlossUserMessage, authorGloss,
  GLOSS_VERIFIER_MODEL, GLOSS_VERIFY_PROMPT_VERSION, GLOSS_VERIFY_MAX_OUTPUT_TOKENS,
  GLOSS_VERIFY_SCHEMA, GLOSS_VERIFY_SYSTEM_PROMPT, buildGlossVerifyMessage, splitGlossSentences,
  fetchGlossSource, EmptyGlossError, assertGlossNotEmpty,
} from '../src/lib/glosser.js';
import { assessVerdicts } from '../src/lib/verifier.js';
import { parseCitation, extractSubsectionText } from '../src/adapters/uscode.js';
import { normalizeCitation } from '../src/cli/extract-terms.js';

const section1396b = readFileSync('tests/fixtures/uscode/title-42-section-1396b.xhtml', 'utf8');

// ---- constants (controller ruling 1: opus-5 authors, sonnet-5 verifies — the established pair) ----

test('MODEL is claude-opus-5, PROMPT_VERSION is gloss-v1 (controller ruling 3)', () => {
  assert.equal(MODEL, 'claude-opus-5');
  assert.equal(PROMPT_VERSION, 'gloss-v1');
});

test('MAX_OUTPUT_TOKENS gives real headroom above extract-terms.js\'s tiny-output cap', () => {
  assert.ok(MAX_OUTPUT_TOKENS >= 2000);
});

test('GLOSS_VERIFIER_MODEL is claude-sonnet-5, deliberately a different weight class than the opus-5 author', () => {
  assert.equal(GLOSS_VERIFIER_MODEL, 'claude-sonnet-5');
  assert.notEqual(GLOSS_VERIFIER_MODEL, MODEL);
});

test('GLOSS_VERIFY_PROMPT_VERSION pinned', () => {
  assert.equal(GLOSS_VERIFY_PROMPT_VERSION, 'v1');
});

test('GLOSS_VERIFY_MAX_OUTPUT_TOKENS gives real headroom, distinct from verifier.js\'s many-bullet-calibrated cap', () => {
  assert.ok(GLOSS_VERIFY_MAX_OUTPUT_TOKENS >= 4000);
});

// ---- GLOSS_SCHEMA shape ----

test('GLOSS_SCHEMA requires gloss_md + supported_by_quote, additionalProperties false', () => {
  assert.deepEqual(GLOSS_SCHEMA.required.sort(), ['gloss_md', 'supported_by_quote']);
  assert.equal(GLOSS_SCHEMA.additionalProperties, false);
  assert.equal(GLOSS_SCHEMA.properties.gloss_md.type, 'string');
  assert.equal(GLOSS_SCHEMA.properties.supported_by_quote.type, 'string');
});

// ---- facts-only system prompt (controller ruling 4: carry Task 3/4's facts-only markers) ----

test('GLOSS_SYSTEM_PROMPT contains the required facts-only markers', () => {
  const lower = GLOSS_SYSTEM_PROMPT.toLowerCase();
  for (const marker of ['from this excerpt alone', 'never infer', 'plain language', 'party']) {
    assert.ok(lower.includes(marker), `missing rule marker: ${marker}`);
  }
});

test('GLOSS_SYSTEM_PROMPT forbids characterization beyond function (no adjectives about merit)', () => {
  const lower = GLOSS_SYSTEM_PROMPT.toLowerCase();
  assert.ok(lower.includes('no adjectives'), "missing rule marker: 'no adjectives'");
  assert.ok(lower.includes('1-2 sentences'), 'missing the 1-2 sentence length constraint');
});

// Fix wave (Minor finding 3): the model itself should be discouraged from writing dotted
// abbreviations into gloss_md in the first place, on top of splitGlossSentences' own mechanical
// protection for whatever it writes anyway.
test('GLOSS_SYSTEM_PROMPT discourages dotted abbreviations in gloss_md', () => {
  const lower = GLOSS_SYSTEM_PROMPT.toLowerCase();
  assert.ok(lower.includes('dotted abbreviations'), "missing rule marker: 'dotted abbreviations'");
});

// ---- buildGlossUserMessage ----

test('buildGlossUserMessage embeds term and excerpt text', () => {
  const msg = buildGlossUserMessage('Social Security Act, Sec. 1903', 'The Secretary shall...');
  assert.ok(msg.includes('Social Security Act, Sec. 1903'));
  assert.ok(msg.includes('The Secretary shall...'));
});

// ---- GLOSS_VERIFY_SCHEMA shape (reuses assessVerdicts unchanged — bullet_index field name) ----

test('GLOSS_VERIFY_SCHEMA top level requires verdicts + overall, additionalProperties false', () => {
  assert.deepEqual(GLOSS_VERIFY_SCHEMA.required.sort(), ['overall', 'verdicts']);
  assert.equal(GLOSS_VERIFY_SCHEMA.additionalProperties, false);
});

test('GLOSS_VERIFY_SCHEMA.overall is an enum of exactly clean/flagged', () => {
  assert.deepEqual(GLOSS_VERIFY_SCHEMA.properties.overall.enum.sort(), ['clean', 'flagged']);
});

test('GLOSS_VERIFY_SCHEMA.verdicts items require bullet_index (reused field name) + three other fields, additionalProperties false', () => {
  const item = GLOSS_VERIFY_SCHEMA.properties.verdicts.items;
  assert.deepEqual(item.required.sort(), ['bullet_index', 'evidence_quote', 'reason', 'supported']);
  assert.equal(item.additionalProperties, false);
});

// ---- adversarial gloss-verify system prompt ----

test('GLOSS_VERIFY_SYSTEM_PROMPT contains the required adversarial-stance markers', () => {
  const lower = GLOSS_VERIFY_SYSTEM_PROMPT.toLowerCase();
  for (const marker of ['refute', 'excerpt', 'fully supported', 'quote']) {
    assert.ok(lower.includes(marker), `missing marker: ${marker}`);
  }
});

// ---- buildGlossVerifyMessage ----

test('buildGlossVerifyMessage embeds term, sentencesJson, and excerpt text', () => {
  const sentencesJson = JSON.stringify(['The Secretary administers grants.']);
  const msg = buildGlossVerifyMessage('Some Act', sentencesJson, 'Full excerpt text here.');
  assert.ok(msg.includes('Some Act'));
  assert.ok(msg.includes(sentencesJson));
  assert.ok(msg.includes('Full excerpt text here.'));
});

// ---- splitGlossSentences: pure, mirrors verify.js's parseBullets role ----

test('splitGlossSentences splits two sentences on terminal punctuation', () => {
  const result = splitGlossSentences('The Secretary administers grants. States must comply with federal standards.');
  assert.deepEqual(result, [
    'The Secretary administers grants.',
    'States must comply with federal standards.',
  ]);
});

test('splitGlossSentences returns a single-element array for one sentence', () => {
  assert.deepEqual(splitGlossSentences('The Secretary administers grants.'), ['The Secretary administers grants.']);
});

test('splitGlossSentences returns the whole trimmed string as one sentence when there is no terminal punctuation', () => {
  assert.deepEqual(splitGlossSentences('The Secretary administers grants'), ['The Secretary administers grants']);
});

test('splitGlossSentences returns an empty array for empty/nullish input', () => {
  assert.deepEqual(splitGlossSentences(''), []);
  assert.deepEqual(splitGlossSentences(null), []);
  assert.deepEqual(splitGlossSentences(undefined), []);
  assert.deepEqual(splitGlossSentences('   '), []);
});

test('splitGlossSentences trims surrounding whitespace from each sentence', () => {
  assert.deepEqual(
    splitGlossSentences('  First sentence.   Second sentence.  '),
    ['First sentence.', 'Second sentence.'],
  );
});

// ---- fix wave (Minor finding 3, redesigned in round 2): dotted legal abbreviations must not
// fragment a real sentence — AND must never silently MERGE two real sentences either, the
// trust-harming direction a round-1 regression let through (round-2 Important finding 2). ----

// Round 2 consequence (a): a digit immediately after the abbreviation's own dot means "not a real
// sentence end" — stays merged. Same input/expectation as round 1; the redesign must not regress it.
test('splitGlossSentences does not split on a dotted U.S.C. citation mid-sentence — exactly 2 real sentences', () => {
  const result = splitGlossSentences('Under 42 U.S.C. 1396b, states get paid. It caps rates.');
  assert.deepEqual(result, [
    'Under 42 U.S.C. 1396b, states get paid.',
    'It caps rates.',
  ]);
});

// Round 2 consequence (b): the round-1 regression, confirmed and fixed. A gloss can legitimately
// END a sentence right at an abbreviation — protecting EVERY dot (round 1's bug) silently merged
// this into one sentence, one verdict quietly covering two separate claims (under-verification,
// the direction that must never happen silently). A capital letter after the dot IS a real
// boundary and must split.
test('splitGlossSentences splits when a real sentence legitimately ends AT a dotted abbreviation (round-1 silent-merge regression, now fixed)', () => {
  const result = splitGlossSentences('The Secretary cites 42 U.S.C. It funds Medicaid.');
  assert.deepEqual(result, [
    'The Secretary cites 42 U.S.C.',
    'It funds Medicaid.',
  ]);
});

// Round 2 consequence (c): a multi-token citation ("Pub. L. No. 117-2") is ONE protected unit —
// only its very last dot (No.'s) is ever a split candidate, and a digit follows it, so the whole
// thing stays merged as a single sentence.
test('splitGlossSentences treats a multi-token "Pub. L. No." citation as one protected unit', () => {
  const result = splitGlossSentences('Established by Pub. L. No. 117-2, the program pays states.');
  assert.deepEqual(result, ['Established by Pub. L. No. 117-2, the program pays states.']);
});

test('splitGlossSentences protects other dotted abbreviations (Pub. L., Sec., Stat., i.e., No.) from spurious splits', () => {
  assert.deepEqual(
    splitGlossSentences('This amends Pub. L. 117-2, Sec. 3, 100 Stat. 1. It applies immediately.'),
    ['This amends Pub. L. 117-2, Sec. 3, 100 Stat. 1.', 'It applies immediately.'],
  );
  // 'i.e.,' is immediately followed by a comma (not whitespace+capital) so it's unambiguous
  // regardless of what follows — 'e.g.' is exercised separately below, where what follows DOES
  // matter (see the accepted-residual test).
  assert.deepEqual(
    splitGlossSentences('It covers programs (e.g. rent assistance) and, i.e., related agencies. No. 4 is one example.'),
    ['It covers programs (e.g. rent assistance) and, i.e., related agencies.', 'No. 4 is one example.'],
  );
});

// Round 2 consequence (d), the ACCEPTED residual, locked in by a test (not just a code comment):
// an abbreviation's trailing dot followed by whitespace + a capitalized word that ISN'T actually a
// new sentence over-splits into an extra fragment. Deliberately accepted — noisy (an extra,
// redundant verdict) is the safe failure direction, the opposite of the round-1 silent-merge bug
// this fix wave closes. GLOSS_SYSTEM_PROMPT's existing "avoid dotted abbreviations" line is the
// primary mitigation, not further mechanical cleverness here.
test('splitGlossSentences accepts an over-split when a capitalized word (not a new sentence) follows an abbreviation dot — documented residual, not a silent merge', () => {
  const result = splitGlossSentences('It covers programs (e.g. Medicaid) and related agencies.');
  assert.deepEqual(result, [
    'It covers programs (e.g.',
    'Medicaid) and related agencies.',
  ]);
});

test('splitGlossSentences restores the exact original text, dots included, when no real sentence break is present', () => {
  assert.deepEqual(
    splitGlossSentences('The Secretary cites 42 U.S.C. 1396b'),
    ['The Secretary cites 42 U.S.C. 1396b'],
  );
});

// Round 2 (re-reviewer finding): a pre-existing placeholder byte in the input must be sanitized
// away, never trusted as "ours" — otherwise it would silently become a spurious literal period on
// restore, corrupting text the model never actually wrote a period into.
test('splitGlossSentences sanitizes a pre-existing placeholder control character out of the input before protecting anything', () => {
  const withControl = `A${String.fromCharCode(1)}B sentence here.`;
  assert.deepEqual(splitGlossSentences(withControl), ['AB sentence here.']);
});

// splitGlossSentences' output feeds assessVerdicts (reused, not reimplemented) as the sentence
// count — confirms the two functions actually compose the way glossOne (gloss.js) uses them.
test('splitGlossSentences count composes with assessVerdicts for the 2-sentence case', () => {
  const sentences = splitGlossSentences('First sentence. Second sentence.');
  const verdicts = [
    { bullet_index: 0, supported: true },
    { bullet_index: 1, supported: true },
  ];
  assert.deepEqual(assessVerdicts(verdicts, sentences.length), { complete: true, overall: 'clean' });
});

// ---- fix wave (Minor finding 4): empty-gloss guard, BEFORE any verify call ----

test('EmptyGlossError is exported and instanceof Error', () => {
  const err = new EmptyGlossError('gloss is empty');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'EmptyGlossError');
});

test('assertGlossNotEmpty throws EmptyGlossError when sentences is empty', () => {
  assert.throws(
    () => assertGlossNotEmpty([], { term: 'Some Act', termId: 't1' }),
    (err) => err instanceof EmptyGlossError && err.name === 'EmptyGlossError' && /empty/.test(err.message) && err.term === 'Some Act' && err.termId === 't1',
  );
});

test('assertGlossNotEmpty does not throw when sentences is non-empty', () => {
  assert.doesNotThrow(() => assertGlossNotEmpty(['A sentence.'], { term: 'Some Act', termId: 't1' }));
});

// Proves the real end-to-end path glossOne (gloss.js) actually exercises: an authored gloss_md of
// '' (schema-valid — GLOSS_SCHEMA has no minLength on the string — so nothing upstream flags it)
// splits to zero sentences, and THAT is what assertGlossNotEmpty guards against — never reaching
// verifyGloss or persistGloss with zero sentences to work from.
test('assertGlossNotEmpty composes with splitGlossSentences("") to catch a genuinely empty gloss_md before any verify call', () => {
  const sentences = splitGlossSentences('');
  assert.deepEqual(sentences, []);
  assert.throws(() => assertGlossNotEmpty(sentences, { term: 'Some Act', termId: 't1' }), EmptyGlossError);
});

test('assertGlossNotEmpty also catches a whitespace-only gloss_md (trims to empty)', () => {
  const sentences = splitGlossSentences('   ');
  assert.throws(() => assertGlossNotEmpty(sentences, { term: 'Some Act', termId: 't1' }), EmptyGlossError);
});

// ---- fetchGlossSource: unparseable-citation guard is testable without any network/live client ----

test('fetchGlossSource rejects a citation with no parseable title/section before touching the network', async () => {
  await assert.rejects(() => fetchGlossSource('the Social Security Act'), /not a parseable USC citation/);
});

test('fetchGlossSource rejects null/empty citation before touching the network', async () => {
  await assert.rejects(() => fetchGlossSource(''), /not a parseable USC citation/);
  await assert.rejects(() => fetchGlossSource(null), /not a parseable USC citation/);
});

// ---- fix round 1 (controller ruling): AS-CITED citation granularity round-trips end-to-end ----
//
// extract-terms.js's normalizeCitation now PRESERVES a captured subsection in the stored
// glossary_terms.citation value (e.g. '42 U.S.C. 1396b(i)', not just '42 U.S.C. 1396b'). This
// proves the full live-pipeline chain — store (normalizeCitation) -> re-parse
// (parseCitation, exactly as fetchGlossSource calls it on term.citation) -> slice
// (extractSubsectionText, exactly as fetchGlossSource's OversizeExcerptError fallback calls it) —
// actually reaches subsection-level slicing for the real HR 498 golden case (42 U.S.C. 1396b(i)),
// not just that each piece works in isolation.
test('a stored AS-CITED citation round-trips through parseCitation to reach subsection slicing for the real HR 498 golden case', () => {
  // What glossary-terms.js's upsertGlossaryTerm (used by both extract-terms.js and summarize.js)
  // now actually stores for HR 498's own raw citation shape (subsection preserved, per the
  // fix-round-1 controller ruling).
  const storedCitation = normalizeCitation('42 U.S.C. 1396b(i)');
  assert.equal(storedCitation, '42 U.S.C. 1396b(i)');

  // fetchGlossSource (glosser.js) re-parses exactly this stored value via parseCitation — the
  // subsection must survive the store-then-reparse round trip, not just the original raw text.
  const reparsed = parseCitation(storedCitation);
  assert.deepEqual(reparsed, { title: 42, section: '1396b', subsection: 'i' });

  // And reparsed.subsection is what actually drives a correct, real, well-under-cap excerpt when
  // the whole section oversizes — the exact fallback fetchGlossSource performs on
  // OversizeExcerptError — proven against the real fixture (169,882 chars whole-section, over the
  // 100k cap), not a synthetic one.
  const excerpt = extractSubsectionText(section1396b, reparsed.subsection, { title: reparsed.title, section: reparsed.section });
  assert.ok(excerpt.length > 0 && excerpt.length < 100000);
  assert.match(excerpt, /organ transplant/i);
});
