import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-opus-5';
export const PROMPT_VERSION = 'v1';
export const MAX_TEXT_CHARS = 400000; // ~100k tokens; larger bills error loudly, never truncate silently
export const MAX_OUTPUT_TOKENS = 16000; // opus-5 thinking runs by default and counts toward max_tokens; headroom so it can't truncate the JSON output

export class OversizeTextError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'OversizeTextError';
    Object.assign(this, meta);
  }
}

export class SummaryRefusedError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SummaryRefusedError';
    Object.assign(this, meta);
  }
}

export class SummaryTruncatedError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SummaryTruncatedError';
    Object.assign(this, meta);
  }
}

export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['what_it_does', 'stated_purpose', 'classification'],
  properties: {
    what_it_does: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['point', 'section'],
        properties: {
          point: { type: 'string', description: 'One plain-language factual statement of what the bill text does' },
          section: { type: 'string', description: "The bill section this point comes from, e.g. 'Sec. 2' or 'Title III'" },
        },
      },
    },
    stated_purpose: { type: 'string', description: "The bill's purpose in plain language, ONLY from the bill's own stated-purpose/findings language; empty string if the bill states none" },
    classification: { type: 'string', enum: ['amends_existing_law', 'new_program', 'appropriation', 'resolution', 'other'] },
  },
};

export const SYSTEM_PROMPT = [
  'You translate United States and state legislative bill text into plain language for a neutral civic-transparency site.',
  'Hard rules — violating any of these makes the output unusable:',
  '- Every point must be traceable to a specific section of the provided bill text; cite that section.',
  '- Restate only what the text does. No adjectives about merit, no characterization of impact beyond the text, no speculation about intent or consequences.',
  '- The stated purpose comes ONLY from the bill\'s own purpose/findings language; if the bill states none, return an empty string. Never infer purpose.',
  '- No party framing of any kind. Never mention parties, politics, or sponsors.',
  '- Plain language: an average adult with no legal training should understand every point. Spell out programs and acts by name on first mention.',
  '- Omit boilerplate (short title sections, severability, effective-date mechanics) unless it is the substance of the bill.',
].join('\n');

export function buildUserMessage(identifier, title, text) {
  return `Bill ${identifier} — ${title}\n\n<bill_text>\n${text}\n</bill_text>\n\nSummarize per your rules.`;
}

export function renderMarkdown(s) {
  const bullets = s.what_it_does.map((b) => `- ${b.point} (${b.section})`).join('\n');
  const purpose = s.stated_purpose ? `\n\n**Stated purpose (from the bill):** ${s.stated_purpose}` : '';
  return `**What it does:**\n${bullets}${purpose}`;
}

export function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null; // caller treats as blocked, not empty
  return new Anthropic();
}

export async function summarizeBill(client, { identifier, title, text }) {
  if (text.length > MAX_TEXT_CHARS) {
    throw new OversizeTextError(`bill text ${text.length} chars exceeds ${MAX_TEXT_CHARS}; will not truncate silently`, { identifier, length: text.length });
  }
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
    messages: [{ role: 'user', content: buildUserMessage(identifier, title, text) }],
  });
  if (response.stop_reason === 'refusal') {
    throw new SummaryRefusedError(`model declined to summarize ${identifier}`, { identifier });
  }
  if (response.stop_reason === 'max_tokens') {
    throw new SummaryTruncatedError(`summary for ${identifier} hit max_tokens — raise the cap or reduce input`, { identifier });
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new SummaryTruncatedError(`no text content returned for ${identifier}`, { identifier });
  }
  const json = JSON.parse(textBlock.text);
  return { json, markdown: renderMarkdown(json) };
}
