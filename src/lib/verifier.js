// Adversarial verification pass (trust-model v2, Lance 2026-07-27): a claude-sonnet-5 verifier
// tries to REFUTE each bullet of an opus-5-authored summary against its cited section. Reuses
// summarizer.js's constants/typed-error pattern rather than re-declaring it — same failure
// shapes, same caps.
import {
  MAX_TEXT_CHARS, MAX_OUTPUT_TOKENS,
  OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
} from './summarizer.js';

// Deliberately claude-sonnet-5, NOT opus-5 (controller ruling #4). A different weight class than
// the summary's author trying to refute it is the whole point of this pass — "upgrading" the
// verifier to match the author's weight class would defeat that.
export const VERIFIER_MODEL = 'claude-sonnet-5';
export const VERIFY_PROMPT_VERSION = 'v1';

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

export function buildVerifyMessage(identifier, bulletsJson, text) {
  return `Bill ${identifier}\n\n<bullets_to_verify>\n${bulletsJson}\n</bullets_to_verify>\n\n<bill_text>\n${text}\n</bill_text>\n\nAttempt to refute each bullet against ONLY its cited section. Return one verdict per bullet, in bullet_index order, per your schema.`;
}

export async function verifyBill(client, { identifier, bullets, text }) {
  if (text.length > MAX_TEXT_CHARS) {
    throw new OversizeTextError(`bill text ${text.length} chars exceeds ${MAX_TEXT_CHARS}; will not truncate silently`, { identifier, length: text.length });
  }
  const bulletsJson = JSON.stringify(bullets);
  const response = await client.messages.create({
    model: VERIFIER_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: VERIFY_SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: VERIFY_SCHEMA } },
    messages: [{ role: 'user', content: buildVerifyMessage(identifier, bulletsJson, text) }],
  });
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
