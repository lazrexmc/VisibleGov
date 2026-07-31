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

// ============================================================
// Completeness axis (trust model v3, Lance 2026-07-31): proves a summary COVERS the bill, the
// direct sibling of the verification pass above proving a summary is TRUE of the bill. Same
// conventions as VERIFY_SYSTEM_PROMPT/VERIFY_SCHEMA/assessVerdicts: a prompt + schema exported for
// a CONTROLLER-ORCHESTRATED SUBAGENT to consume (the $0 path — this file makes no model call for
// this axis, exactly like every other export below buildVerifyMessage), and a pure mechanical
// assessor that re-derives the outcome from structured data rather than trusting the checker's own
// word for it.
// ============================================================

export const COMPLETENESS_PROMPT_VERSION = 'v1';

// COMPLETENESS_SYSTEM_PROMPT — a HARD ORCHESTRATION CONTRACT, not just a prompt. Two phases,
// dispatched by the CONTROLLER as two SEPARATE subagent turns against this SAME system prompt (this
// file makes no model calls for this axis at all — see the header comment — so nothing here can
// enforce the separation itself):
//   Phase 1 (provisions): dispatch with buildProvisionsMessage — bill text ONLY. The checker must
//     never see the summary's bullets while forming this list; seeing them first would let the
//     checker's "coverage" answer bend to match whatever the summary already says, instead of
//     forming an independent judgment of what a reader needs to know.
//   Phase 2 (coverage): a SECOND, separate dispatch with buildCoverageMessage — phase 1's own
//     provisions list (fed back, not re-derived) plus the summary's bullets, asking only which
//     provisions the bullets cover.
// Sending both bill text and summary in one dispatch defeats the whole check — the checker could
// "find" a provisions list that just happens to already match the summary. Whoever wires the
// dispatch owns this contract; classifyRecordItem/assessCompleteness cannot verify it was honored.
export const COMPLETENESS_SYSTEM_PROMPT = [
  'You are a completeness checker for a plain-language bill summary written by another model. Your job is to catch omissions, not to fact-check claims already made — a different pass already does that.',
  'You work in two separate phases, dispatched to you as two separate messages. Only do the phase named in the CURRENT message; do not anticipate the other phase.',
  'PHASE 1 — key provisions (you will be given ONLY the bill text for this phase; you have not been shown any summary and must not assume one, guess one, or write as if you have seen one):',
  '- Read the bill text and list the provisions a reader must know to understand what this bill actually does — bounded to between 3 and 7 of the most consequential provisions.',
  '- For each provision, name the section it lives in, copied from the bill text, and give a short, factual statement of what it does.',
  '- Facts only: state what the text does, nothing more. No significance language beyond what the text itself supports — write "bars judicial review of the reissuance," never "an alarming limitation on judicial review."',
  'PHASE 2 — coverage (you will be given your own phase 1 key_provisions list back, plus the summary\'s bullets, in a later message):',
  '- For every provision in the list, decide whether any bullet in the summary covers it.',
  '- When a provision is covered, cite the bullet_index of the bullet that covers it, and explain why in note.',
  '- When a provision is not covered by any bullet, mark covered false, leave bullet_index null, and explain what is missing in note — never force a weak or partial match to count as coverage.',
].join('\n');

// The declared provision bound. Exported because assessCompleteness enforces it MECHANICALLY —
// a schema minItems/maxItems is a request to the checker, not a guarantee about what arrives at
// the gate, and trust model v3's rule is that a checker's own compliance is never assumed. A
// payload naming one trivially-covered provision would otherwise earn the same 'complete' verdict
// (and the same public "covers the bill's key provisions" receipt) as a real 3-7 provision check.
export const MIN_KEY_PROVISIONS = 3;
export const MAX_KEY_PROVISIONS = 7;

export const COMPLETENESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key_provisions', 'coverage'],
  properties: {
    key_provisions: {
      type: 'array',
      minItems: MIN_KEY_PROVISIONS,
      maxItems: MAX_KEY_PROVISIONS,
      description: 'Phase 1 output: the 3-7 provisions a reader must know, formed from the bill text ONLY, without reference to the summary',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'provision'],
        properties: {
          section: { type: 'string', description: 'The bill section this provision lives in, copied from the bill text' },
          provision: { type: 'string', description: 'A short, factual statement of what this provision does — facts only, no significance language beyond what the text supports' },
        },
      },
    },
    coverage: {
      type: 'array',
      description: "Phase 2 output: exactly one entry per key_provisions entry, deciding whether the summary's bullets cover it",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['provision_index', 'covered', 'bullet_index', 'note'],
        properties: {
          provision_index: { type: 'integer', description: '0-based index into key_provisions' },
          covered: { type: 'boolean', description: 'true if some bullet in the summary covers this provision' },
          bullet_index: { type: ['integer', 'null'], description: "0-based index into the summary's what_it_does array that covers this provision; null exactly when covered is false" },
          note: { type: 'string', description: 'One short plain-language sentence explaining the covered/not-covered decision' },
        },
      },
    },
  },
};

export function buildProvisionsMessage(identifier, billText) {
  return `Bill ${identifier}\n\n<bill_text>\n${billText}\n</bill_text>\n\nPHASE 1 ONLY. List the 3-7 key provisions a reader must know, per your schema's key_provisions shape. Do not reference any summary — none has been shown to you.`;
}

export function buildCoverageMessage(identifier, provisionsJson, bulletsJson) {
  return `Bill ${identifier}\n\n<key_provisions>\n${provisionsJson}\n</key_provisions>\n\n<summary_bullets>\n${bulletsJson}\n</summary_bullets>\n\nPHASE 2 ONLY. For each provision above, decide whether a bullet covers it, per your schema's coverage shape. Return one coverage entry per provision, in provision_index order.`;
}

// collapseWhitespace mirrors summary-queue.js's checkStatedPurposeGrounding EXACTLY (read it,
// match it — the task brief's own instruction): whitespace runs collapse to a single space on BOTH
// sides, nothing else normalized. Duplicated rather than imported: summary-queue.js already imports
// FROM this file, and this axis's grounding check has no reason to invert that direction.
function collapseWhitespace(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

// assessCompleteness — the completeness axis's own mechanical, never-trust-the-checker's-self-report
// gate, the direct sibling of assessVerdicts above. Pure, no I/O, never throws: given the checker's
// raw {key_provisions, coverage} payload, the number of bullets actually in the summary, and the
// hash-pinned bill text, independently re-derives whether the check itself can be trusted at all
// (malformed — collects EVERY structural problem found, not just the first, so one call gives a full
// diagnostic), and if so, whether the summary actually covers the bill (complete) or not (incomplete,
// naming exactly what's missing).
//
// malformed, in full (task brief, verbatim):
//   - coverage.length !== key_provisions.length
//   - any provision_index out of range or duplicated
//   - covered===true with a null/out-of-range bullet_index
//   - covered===false with a non-null bullet_index
//   - zero key_provisions (the vacuous-empty class this codebase has hit four times — a checker
//     that finds no provisions has not checked anything, and must never read as "nothing to cover,
//     so complete")
//   - grounding: any key_provisions[].section absent from billText (same normalize-whitespace-
//     then-substring discipline as checkStatedPurposeGrounding) — a provision citing a section that
//     isn't in the bill means the checker invented it.
export function assessCompleteness(completeness, bulletCount, billText) {
  const keyProvisions = completeness && Array.isArray(completeness.key_provisions) ? completeness.key_provisions : null;
  const coverage = completeness && Array.isArray(completeness.coverage) ? completeness.coverage : null;
  if (!keyProvisions || !coverage) {
    return { overall: 'malformed', missing: [], reasons: ['completeness payload must have key_provisions and coverage arrays'] };
  }
  if (keyProvisions.length === 0) {
    return { overall: 'malformed', missing: [], reasons: ['zero key_provisions — a checker that finds no provisions has not checked anything'] };
  }
  // The schema asks for MIN..MAX provisions; this enforces it. Below the floor the check is too
  // thin to support the receipt it would earn (one covered provision is not evidence a summary
  // covers the bill); above the ceiling the checker ignored its instructions, so its output is
  // not the artifact this gate was designed to assess. Either way: malformed, never publishable.
  if (keyProvisions.length < MIN_KEY_PROVISIONS || keyProvisions.length > MAX_KEY_PROVISIONS) {
    return {
      overall: 'malformed',
      missing: [],
      reasons: [`key_provisions has ${keyProvisions.length} entries, outside the required ${MIN_KEY_PROVISIONS}-${MAX_KEY_PROVISIONS} — the check does not meet the standard its verdict would claim`],
    };
  }

  const reasons = [];
  if (coverage.length !== keyProvisions.length) {
    reasons.push(`coverage has ${coverage.length} entries but key_provisions has ${keyProvisions.length} — exactly one coverage entry is required per provision`);
  }

  const seenIndices = new Set();
  coverage.forEach((c, i) => {
    const idx = c && c.provision_index;
    if (!Number.isInteger(idx) || idx < 0 || idx >= keyProvisions.length) {
      reasons.push(`coverage[${i}].provision_index ${JSON.stringify(idx ?? null)} is out of range for ${keyProvisions.length} provision(s)`);
      return;
    }
    if (seenIndices.has(idx)) {
      reasons.push(`coverage[${i}].provision_index ${idx} duplicates an earlier entry — every provision must be covered exactly once`);
      return;
    }
    seenIndices.add(idx);
  });

  coverage.forEach((c, i) => {
    if (!c || typeof c.covered !== 'boolean') {
      reasons.push(`coverage[${i}].covered must be a boolean`);
      return;
    }
    const bulletIndex = c.bullet_index;
    if (c.covered) {
      if (!Number.isInteger(bulletIndex) || bulletIndex < 0 || bulletIndex >= bulletCount) {
        reasons.push(`coverage[${i}] is covered=true but bullet_index ${JSON.stringify(bulletIndex ?? null)} is not a valid index into ${bulletCount} bullet(s)`);
      }
    } else if (bulletIndex !== null) {
      reasons.push(`coverage[${i}] is covered=false but bullet_index is ${JSON.stringify(bulletIndex)}, not null`);
    }
  });

  const normalizedBillText = collapseWhitespace(billText ?? '');
  keyProvisions.forEach((p, i) => {
    const section = p && p.section;
    if (typeof section !== 'string' || section.trim() === '' || !normalizedBillText.includes(collapseWhitespace(section))) {
      reasons.push(`key_provisions[${i}].section ${JSON.stringify(section ?? null)} does not appear in the bill text — the checker invented a section it never read`);
    }
  });

  if (reasons.length > 0) {
    return { overall: 'malformed', missing: [], reasons };
  }

  const missing = [];
  coverage.forEach((c) => {
    if (!c.covered) {
      const p = keyProvisions[c.provision_index];
      missing.push({
        provision_index: c.provision_index, section: p.section, provision: p.provision, note: c.note ?? null,
      });
    }
  });
  if (missing.length > 0) {
    return { overall: 'incomplete', missing, reasons: [] };
  }
  return { overall: 'complete', missing: [], reasons: [] };
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
