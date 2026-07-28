// Adversarial verification pass (trust-model v2, Lance 2026-07-27): a claude-sonnet-5 verifier
// tries to REFUTE each bullet of an opus-5-authored summary against its cited section. Reuses
// summarizer.js's constants/typed-error pattern rather than re-declaring it — same failure
// shapes, same caps.
import {
  MAX_TEXT_CHARS,
  OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
} from './summarizer.js';

// Deliberately claude-sonnet-5, NOT opus-5 (controller ruling #4). A different weight class than
// the summary's author trying to refute it is the whole point of this pass — "upgrading" the
// verifier to match the author's weight class would defeat that.
export const VERIFIER_MODEL = 'claude-sonnet-5';
export const VERIFY_PROMPT_VERSION = 'v1';

// Deliberately NOT summarizer.js's MAX_OUTPUT_TOKENS (16000): the verifier emits a full JSON
// verdict per bullet (section, supported, reason, evidence_quote) on top of claude-sonnet-5's
// adaptive thinking, which together can exceed 16k for many-bullet summaries — live-diagnosed
// via SummaryTruncatedError on HR 6955 and HR 8595. 32k gives real headroom; a pathological case
// that still hits it correctly stays a typed SummaryTruncatedError, never a silent truncation.
export const VERIFY_MAX_OUTPUT_TOKENS = 32000;

export const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts', 'overall'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['bullet_index', 'section', 'supported', 'reason', 'evidence_quote'],
        properties: {
          bullet_index: { type: 'integer', description: "0-based index into the summary's what_it_does array" },
          section: { type: 'string', description: 'The section cited by this bullet, copied from the summary' },
          supported: { type: 'boolean', description: 'true only if the cited section, read on its own, fully supports the bullet' },
          reason: { type: 'string', description: 'One or two plain-language sentences explaining the verdict' },
          evidence_quote: { type: 'string', description: 'An exact, verbatim quote from the bill text that supports or contradicts the bullet' },
        },
      },
    },
    overall: { type: 'string', enum: ['clean', 'flagged'], description: '"clean" only if every verdict is supported; otherwise "flagged"' },
  },
};

export const VERIFY_SYSTEM_PROMPT = [
  'You are an adversarial fact-checker reviewing a plain-language bill summary written by another model.',
  'Your job is to try to REFUTE each bullet point, not to rubber-stamp it — assume each one could be wrong until you confirm otherwise.',
  'For every bullet, re-read its cited section of the provided bill text and decide whether the bullet is fully supported by that cited section.',
  '- Actively look for ways the bullet could fail: a claim not actually present in the cited section, a claim that really belongs to a different section than the one cited, an overstatement, a meaningful omission, or a claim the bill text does not support anywhere.',
  '- supported = true only if the cited section, read on its own, fully supports the bullet with no additional inference required.',
  '- supported = false for anything you cannot fully verify against the cited section — do not give the benefit of the doubt.',
  '- For every verdict, provide an evidence_quote: an exact, verbatim quote pulled from the bill text (from the cited section when possible) that supports or contradicts the bullet.',
  '- reason must explain, in one or two plain-language sentences, why the bullet is or is not fully supported.',
  '- overall is "clean" only if every single verdict is supported; if even one bullet fails, overall is "flagged".',
].join('\n');

// Thrown when the verifier's json.verdicts cannot be mechanically trusted as complete/consistent
// (assessVerdicts below), or — from verify.js's checkBulletCoverage — when a body_md bullet lost
// its citation on edit and silently vanished from what got sent to the verifier at all
// (pre-merge findings 1 & 2). Deliberately a typed error, not a thrown-away log line: verify.js
// adds it to its typed-failure set so the batch continues and the summary is recorded in
// failures[], staying 'unverified' in the queue — the honest state, never a fabricated 'clean'.
export class VerificationIncompleteError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'VerificationIncompleteError';
    Object.assign(this, meta);
  }
}

// Mechanical completeness gate (pre-merge finding 1): the model's own json.overall is NEVER
// trusted directly — this function doesn't even accept it as input. Given the verdicts array and
// the number of bullets actually sent for verification, it independently re-derives whether the
// verdict set is complete (exactly one verdict per bullet_index in [0, bulletCount), no dupes, no
// gaps, no out-of-range indices) and, only if complete, what overall should be (every verdict
// supported -> 'clean', otherwise 'flagged'). Pure — never throws; callers decide what an
// incomplete result means for them (verify.js's verifyOne throws VerificationIncompleteError).
export function assessVerdicts(verdicts, bulletCount) {
  if (!Array.isArray(verdicts) || verdicts.length !== bulletCount) return { complete: false };
  const seen = new Set();
  for (const v of verdicts) {
    const idx = v && v.bullet_index;
    if (!Number.isInteger(idx) || idx < 0 || idx >= bulletCount) return { complete: false };
    if (seen.has(idx)) return { complete: false };
    seen.add(idx);
  }
  // verdicts.length === bulletCount and every bullet_index is a distinct integer in
  // [0, bulletCount) => the set of indices is exactly {0..bulletCount-1}; no separate coverage
  // check needed.
  const overall = verdicts.every((v) => v.supported === true) ? 'clean' : 'flagged';
  return { complete: true, overall };
}

export function buildVerifyMessage(identifier, bulletsJson, text) {
  return `Bill ${identifier}\n\n<bullets_to_verify>\n${bulletsJson}\n</bullets_to_verify>\n\n<bill_text>\n${text}\n</bill_text>\n\nAttempt to refute each bullet against ONLY its cited section. Return one verdict per bullet, in bullet_index order, per your schema.`;
}

export async function verifyBill(client, { identifier, bullets, text }) {
  if (text.length > MAX_TEXT_CHARS) {
    throw new OversizeTextError(`bill text ${text.length} chars exceeds ${MAX_TEXT_CHARS}; will not truncate silently`, { identifier, length: text.length });
  }
  const bulletsJson = JSON.stringify(bullets);
  // Streaming, not .create(): >16k max_tokens on a non-streaming request risks SDK HTTP timeouts
  // (documented SDK guidance). finalMessage() awaits the stream to completion and returns the
  // same complete Message shape .create() would, so everything below is unchanged.
  const stream = client.messages.stream({
    model: VERIFIER_MODEL,
    max_tokens: VERIFY_MAX_OUTPUT_TOKENS,
    system: VERIFY_SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: VERIFY_SCHEMA } },
    messages: [{ role: 'user', content: buildVerifyMessage(identifier, bulletsJson, text) }],
  });
  const response = await stream.finalMessage();
  if (response.stop_reason === 'refusal') {
    throw new SummaryRefusedError(`model declined to verify ${identifier}`, { identifier });
  }
  if (response.stop_reason === 'max_tokens') {
    throw new SummaryTruncatedError(`verification for ${identifier} hit max_tokens — raise the cap or reduce input`, { identifier });
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new SummaryTruncatedError(`no text content returned for ${identifier}`, { identifier });
  }
  const json = JSON.parse(textBlock.text);
  return { json };
}
