// Glossary plan Task 5: for a glossary_terms row with a resolved citation and no gloss yet, fetch
// the term's own official US Code text (uscode.js) and have claude-opus-5 author a 1-2 sentence
// plain-language gloss FROM THAT EXCERPT ALONE, then have claude-sonnet-5 adversarially verify it
// — the same author/verify weight-class split as the bill summarizer (summarizer.js / verifier.js),
// mirrored here rather than reinvented. Typed refusal/truncation failures are REUSED from
// summarizer.js (SummaryRefusedError/SummaryTruncatedError), same convention verifier.js and
// extract-terms.js already established: these names describe generic model-response outcomes
// (refusal/truncation), not anything specific to full-bill summarization.
import {
  parseCitation, fetchUscSection, fetchUscSubsection, OversizeExcerptError, sha256,
} from '../adapters/uscode.js';
import { isMoCitation, parseMoCitation, fetchMoSection, fetchMoChapter } from '../adapters/mo-statutes.js';
import { SummaryRefusedError, SummaryTruncatedError } from './summarizer.js';

export const MODEL = 'claude-opus-5';
export const PROMPT_VERSION = 'gloss-v1';
// Small on purpose: gloss_md (1-2 sentences) + supported_by_quote is a tiny JSON payload, nowhere
// near summarizer.js's MAX_OUTPUT_TOKENS (16000) for a full what_it_does summary — but still needs
// real headroom over extract-terms.js's EXTRACT_MAX_OUTPUT_TOKENS (4000), since opus-5's default
// thinking counts toward max_tokens regardless of how small the final JSON is (same caveat
// summarizer.js documents for its own cap).
export const MAX_OUTPUT_TOKENS = 4000;

export const GLOSS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gloss_md', 'supported_by_quote'],
  properties: {
    gloss_md: {
      type: 'string',
      description: '1-2 sentence plain-language explanation of what this term/citation does, from this excerpt alone — never infer beyond what the excerpt itself states',
    },
    supported_by_quote: {
      type: 'string',
      description: 'An exact, verbatim quote from the excerpt that supports gloss_md',
    },
  },
};

export const GLOSS_SYSTEM_PROMPT = [
  'You write a short, plain-language glossary entry explaining a single statute, act, agency, program, or public law, for a neutral civic-transparency site.',
  'Hard rules — violating any of these makes the output unusable:',
  '- Write from this excerpt alone: base gloss_md and supported_by_quote ONLY on the provided source excerpt. Never infer, assume, or supply outside knowledge — even if you recognize the citation from training, ignore what you know and use only what this excerpt itself says.',
  '- gloss_md is exactly 1-2 sentences, plain language: an average adult with no legal training should understand it on first read.',
  '- Restate only what the excerpt itself says this provision does. No adjectives about merit, no characterization of impact or intent, no speculation — describe function only.',
  '- No party framing of any kind. Never mention parties, politics, or sponsors.',
  '- Avoid dotted abbreviations (e.g. "U.S.C.", "Pub. L.") in gloss_md; spell terms out in full where practical so sentence boundaries stay unambiguous.',
  '- supported_by_quote is an exact, verbatim quote copied from the excerpt that backs gloss_md.',
].join('\n');

export function buildGlossUserMessage(term, excerptText) {
  return `Term: ${term}\n\n<source_excerpt>\n${excerptText}\n</source_excerpt>\n\nWrite gloss_md and supported_by_quote per your rules, from this excerpt alone.`;
}

export async function authorGloss(client, { term, excerptText }) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: GLOSS_SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: GLOSS_SCHEMA } },
    messages: [{ role: 'user', content: buildGlossUserMessage(term, excerptText) }],
  });
  if (response.stop_reason === 'refusal') {
    throw new SummaryRefusedError(`model declined to gloss "${term}"`, { term });
  }
  if (response.stop_reason === 'max_tokens') {
    throw new SummaryTruncatedError(`gloss for "${term}" hit max_tokens — raise the cap or reduce input`, { term });
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new SummaryTruncatedError(`no text content returned for gloss of "${term}"`, { term });
  }
  const json = JSON.parse(textBlock.text);
  return { json };
}

// ---- adversarial gloss verifier (trust model v2) ----

// Deliberately claude-sonnet-5, NOT opus-5 (same weight-class-split rationale as verifier.js).
export const GLOSS_VERIFIER_MODEL = 'claude-sonnet-5';
export const GLOSS_VERIFY_PROMPT_VERSION = 'v1';
// Scaled down from verifier.js's VERIFY_MAX_OUTPUT_TOKENS (32000, calibrated for many-bullet bill
// summaries): a gloss is 1-2 sentences, so at most 1-2 verdicts — nowhere near that many-bullet
// worst case — but adaptive thinking can still run long regardless of output size (verifier.js's
// own documented finding), so this keeps real headroom rather than reusing summarizer.js's much
// smaller MAX_OUTPUT_TOKENS (16000, sized for full-summary JSON, not calibrated for this at all).
export const GLOSS_VERIFY_MAX_OUTPUT_TOKENS = 8000;

// verdicts[].bullet_index (not "sentence_index"): deliberately reuses verifier.js's assessVerdicts
// UNCHANGED (glossary plan controller ruling 5: "an assessVerdicts-equivalent") rather than
// duplicating its completeness-derivation logic under a differently-named field — one index field
// name, one mechanical completeness gate, shared by both the bill verifier and the gloss verifier.
// Here it indexes the gloss's own sentences (see splitGlossSentences), not summary bullets.
export const GLOSS_VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts', 'overall'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['bullet_index', 'supported', 'reason', 'evidence_quote'],
        properties: {
          bullet_index: { type: 'integer', description: "0-based index into the gloss's own sentences (see splitGlossSentences)" },
          supported: { type: 'boolean', description: 'true only if the source excerpt, read on its own, fully supports the sentence' },
          reason: { type: 'string', description: 'One or two plain-language sentences explaining the verdict' },
          evidence_quote: { type: 'string', description: 'An exact, verbatim quote from the excerpt that supports or contradicts the sentence' },
        },
      },
    },
    overall: { type: 'string', enum: ['clean', 'flagged'], description: '"clean" only if every verdict is supported; otherwise "flagged"' },
  },
};

export const GLOSS_VERIFY_SYSTEM_PROMPT = [
  'You are an adversarial fact-checker reviewing a plain-language glossary gloss written by another model.',
  'Your job is to try to REFUTE each sentence of the gloss, not to rubber-stamp it — assume each one could be wrong until you confirm otherwise.',
  'For every sentence, re-read the provided source excerpt and decide whether the sentence is fully supported by that excerpt alone.',
  '- Actively look for ways the sentence could fail: a claim not actually present in the excerpt, an overstatement, a meaningful omission, or a claim the excerpt does not support anywhere.',
  '- supported = true only if the excerpt, read on its own, fully supports the sentence with no additional inference required.',
  '- supported = false for anything you cannot fully verify against the excerpt — do not give the benefit of the doubt.',
  '- For every verdict, provide an evidence_quote: an exact, verbatim quote pulled from the excerpt that supports or contradicts the sentence.',
  '- reason must explain, in one or two plain-language sentences, why the sentence is or is not fully supported.',
  '- overall is "clean" only if every single verdict is supported; if even one sentence fails, overall is "flagged".',
].join('\n');

// Fix wave (final review, Minor finding 3; redesigned in round 2 after a re-review caught a
// silent-merge regression — see below) — dotted legal abbreviations whose internal periods are
// NOT sentence-ending punctuation: left unprotected, "Under 42 U.S.C. 1396b, states get paid."
// split at "U.S." into two spurious fragments, generating an extra per-fragment verifier verdict
// for text that was only ever one real sentence. Longest/most-specific pattern first (e.g.
// 'U.S.C.' before 'U.S.', 'Pub. L. No.' as its own three-token unit before 'Pub. L.' alone) so a
// shorter pattern never partially matches inside a longer one this list has already protected.
const DOTTED_ABBREVIATIONS = [
  /Pub\.\s+L\.\s+No\./g,
  /Pub\.\s+L\./g,
  /U\.S\.C\./g,
  /U\.S\./g,
  /e\.g\./g,
  /i\.e\./g,
  /Sec\./g,
  /Stat\./g,
  /No\./g,
];
// String.fromCharCode(1) (U+0001, a control character): never legitimate model output, so safe to
// use as a period placeholder with no risk of colliding with a real character already in the gloss
// text — unlike, say, a space, which restoreAbbreviationDots would then be unable to tell apart
// from every OTHER space in the sentence. Built via fromCharCode rather than a literal escape so
// the placeholder itself is unambiguous to read here as source text.
const ABBREV_DOT_PLACEHOLDER = String.fromCharCode(1);

// round 2 (Important finding 2 from the scoped re-review): round 1 protected EVERY dot in a
// matched abbreviation, including its OWN trailing period — which silently MERGED two real
// sentences whenever a gloss legitimately ended right at an abbreviation ('The Secretary cites 42
// U.S.C. It funds Medicaid.' collapsed to ONE sentence, one verdict quietly covering two claims —
// exactly the under-verification direction that must never happen silently). Fixed by protecting
// every dot in a matched abbreviation EXCEPT ITS LAST ONE — that final dot is left as a normal,
// literal period, decided by the SAME terminal-period rule (see protectNonTerminalPeriods below)
// every other period in the text is judged by. `m.lastIndexOf('.')` finds that abbreviation's own
// last dot within the match; everything before it gets protected, that one character does not.
function protectAbbreviationDots(text) {
  let out = text;
  for (const pattern of DOTTED_ABBREVIATIONS) {
    out = out.replace(pattern, (m) => {
      const lastDot = m.lastIndexOf('.');
      return m.slice(0, lastDot).split('.').join(ABBREV_DOT_PLACEHOLDER) + m.slice(lastDot);
    });
  }
  return out;
}

// A period is a real sentence boundary if it's the last character of the (already-trimmed) text,
// or if whitespace then an UPPERCASE letter follows it — otherwise (a digit, a lowercase letter,
// punctuation like a comma, or nothing-but-more-lowercase-word immediately after) it's treated as
// non-terminal and protected the same way an abbreviation-internal dot is. This is what actually
// decides an abbreviation's own trailing dot (left raw by protectAbbreviationDots above) case by
// case: "U.S.C. 1396b" (digit follows) stays merged; "U.S.C. It funds..." (capital follows)
// splits. Also incidentally protects decimal-point periods ("12.5 percent") from ever becoming a
// spurious split — an unplanned but welcome side effect of the same rule.
//
// Accepted residual (documented, not "fixed" further): an abbreviation's trailing dot followed by
// whitespace + a capitalized word that ISN'T actually a new sentence ("...covers (e.g. Medicaid)
// and...") over-splits into an extra fragment. That is the deliberately ACCEPTED failure
// direction — noisy (an extra, redundant verdict) rather than the silent-merge this round-2 fix
// exists to close (one verdict quietly covering two real claims). GLOSS_SYSTEM_PROMPT's existing
// "avoid dotted abbreviations" line is the primary mitigation for both directions at the source.
function isTerminalPeriod(text, index) {
  if (index === text.length - 1) return true;
  return /^\s+[A-Z]/.test(text.slice(index + 1));
}

function protectNonTerminalPeriods(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    out += (text[i] === '.' && !isTerminalPeriod(text, i)) ? ABBREV_DOT_PLACEHOLDER : text[i];
  }
  return out;
}

function restoreAbbreviationDots(text) {
  return text.split(ABBREV_DOT_PLACEHOLDER).join('.');
}

// splitGlossSentences: TRIVIAL sentence splitting only (terminal .!? followed by whitespace/end,
// with the terminal-period refinement above) — gloss_md is model-authored, constrained by
// GLOSS_SYSTEM_PROMPT to exactly 1-2 sentences, so this never has to handle arbitrary prose beyond
// the dotted-abbreviation protection above. Pure, mirrors verify.js's parseBullets role (the input
// the verifier is built from, and the count assessVerdicts checks completeness against).
export function splitGlossSentences(glossMd) {
  const raw = String(glossMd || '').trim();
  if (!raw) return [];
  // Sanitize any PRE-EXISTING placeholder byte out of the input first (round 2, re-reviewer
  // finding): the placeholder is a control character no legitimate model output should ever
  // contain, but if one somehow leaked in, restoreAbbreviationDots would turn it into a spurious
  // literal period on the way out — stripped, never trusted, before any protection step runs.
  const text = raw.split(ABBREV_DOT_PLACEHOLDER).join('');
  const protectedText = protectNonTerminalPeriods(protectAbbreviationDots(text));
  const matches = protectedText.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
  // no terminal punctuation found (outside protected abbreviations) - treat the whole string as
  // one sentence, same restore step either way.
  const rawSentences = matches ? matches.map((s) => s.trim()) : [protectedText];
  return rawSentences.map(restoreAbbreviationDots).filter(Boolean);
}

// Fix wave (final review, Minor finding 4): '' technically satisfies GLOSS_SCHEMA's
// {type:'string'} requirement for gloss_md (no minLength), so an empty-but-schema-valid gloss was
// never caught as a malformed model response the way a max_tokens truncation would be — and left
// unchecked, splitGlossSentences('') === [] reaches assessVerdicts as a VACUOUS pass (0 sentences,
// 0 verdicts is the exact same shape a legitimate "nothing to verify" case would produce), which
// then persisted as a published-eligible empty gloss (migration 0007's own CHECK constraint has a
// matching fix — see that migration's header comment).
export class EmptyGlossError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'EmptyGlossError';
    Object.assign(this, meta);
  }
}

// assertGlossNotEmpty: the empty-gloss guard, factored out as its own pure function (same
// rationale as gloss.js's persistGloss being split out of glossOne — unit-testable without faking
// authorGloss/anthropic at all). Called with the already-split sentence count (glossOne's own
// splitGlossSentences output), BEFORE any verify call is made — an empty gloss should never spend
// a billed verify call on itself, and must never reach persistGloss.
export function assertGlossNotEmpty(sentences, { term, termId }) {
  if (sentences.length === 0) {
    throw new EmptyGlossError(
      `gloss for "${term}" (id ${termId}): authored gloss_md is empty — refusing to verify or persist an empty gloss`,
      { term, termId },
    );
  }
}

export function buildGlossVerifyMessage(term, sentencesJson, excerptText) {
  return `Term: ${term}\n\n<gloss_sentences_to_verify>\n${sentencesJson}\n</gloss_sentences_to_verify>\n\n<source_excerpt>\n${excerptText}\n</source_excerpt>\n\nAttempt to refute each sentence against ONLY the source excerpt. Return one verdict per sentence, in order, per your schema (bullet_index = sentence position).`;
}

export async function verifyGloss(client, { term, sentences, excerptText }) {
  const sentencesJson = JSON.stringify(sentences);
  // Streaming, not .create() — same SDK-timeout rationale as verifier.js's verifyBill.
  const stream = client.messages.stream({
    model: GLOSS_VERIFIER_MODEL,
    max_tokens: GLOSS_VERIFY_MAX_OUTPUT_TOKENS,
    system: GLOSS_VERIFY_SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: GLOSS_VERIFY_SCHEMA } },
    messages: [{ role: 'user', content: buildGlossVerifyMessage(term, sentencesJson, excerptText) }],
  });
  const response = await stream.finalMessage();
  if (response.stop_reason === 'refusal') {
    throw new SummaryRefusedError(`model declined to verify gloss for "${term}"`, { term });
  }
  if (response.stop_reason === 'max_tokens') {
    throw new SummaryTruncatedError(`gloss verification for "${term}" hit max_tokens — raise the cap or reduce input`, { term });
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new SummaryTruncatedError(`no text content returned for gloss verification of "${term}"`, { term });
  }
  const json = JSON.parse(textBlock.text);
  return { json };
}

// ---- source resolution (glossary plan controller ruling 2: oversize-section subsection fallback) ----

// fetchGlossSource(citation) -> {url, excerptText, hash}. Tries the whole cited SECTION first
// (fetchUscSection) — the common case, and the only case for the vast majority of US Code
// sections, which comfortably fit under uscode.js's MAX_EXCERPT_CHARS. Only when that oversizes
// AND the citation itself named a subsection (parseCitation's `subsection` field — see uscode.js)
// does this fall back to a subsection-level excerpt (fetchUscSubsection), narrower text but from
// the EXACT anchor OLRC itself marks for that subsection, never a truncation. If the section
// oversizes and no subsection was cited, the OversizeExcerptError propagates unchanged — an honest,
// typed, counted skip (glossary plan controller ruling 2's final clause), never a silent one.
//
// NOT unit-tested directly (same convention as fetchUscSection/fetchUscSubsection themselves — see
// uscode.test.js's own comment: thin fetch wrappers are structurally reviewed, not integration-
// tested, in this codebase; the pure extraction functions underneath them carry the real test
// weight). A citation with no parseable title/section should never reach here at all — the CLI
// only calls this for needs_mapping=false rows, whose citation was already confirmed parseable by
// extract-terms.js's own parseCitation call at insert time — the defensive throw below is a belt,
// not the expected path.
export async function fetchGlossSource(citation) {
  if (isMoCitation(citation)) {
    const parsed = parseMoCitation(citation);
    if (!parsed) {
      throw new Error(`citation "${citation}" carries the RSMo prefix but is not a parseable RSMo citation — this term should have needs_mapping=true and never reach the glosser`);
    }
    // Whole-section/whole-chapter only in v1 (spec §3) — no subsection fallback for MO.
    const { url, excerptText } = parsed.kind === 'chapter'
      ? await fetchMoChapter(parsed.chapter)
      : await fetchMoSection(parsed.section);
    return { url, excerptText, hash: sha256(excerptText) };
  }
  // ---- existing USC path, unchanged ----
  const parsed = parseCitation(citation);
  if (!parsed) {
    throw new Error(`citation "${citation}" is not a parseable USC citation — this term should have needs_mapping=true and never reach the glosser`);
  }
  try {
    const { url, excerptText } = await fetchUscSection(parsed.title, parsed.section);
    return { url, excerptText, hash: sha256(excerptText) };
  } catch (err) {
    if (err instanceof OversizeExcerptError && parsed.subsection) {
      const { url, excerptText } = await fetchUscSubsection(parsed.title, parsed.section, parsed.subsection);
      return { url, excerptText, hash: sha256(excerptText) };
    }
    throw err;
  }
}
