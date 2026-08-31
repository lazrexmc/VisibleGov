// src/lib/billed-summary-chain.js — the billed 4-stage trust-model-v3 chain (Haiku/Sonnet via
// the Anthropic API), extracted VERBATIM-in-mechanism from scripts/summary-probe-api.mjs (the
// $1.98 2026-08-09 campaign runner: $0.041/publish, zero credit errors in 288 calls) so the
// probe CLI and scripts/scheduled-summaries.js share one implementation. This module never
// touches the DB; envelopes go through src/cli/summary-queue.js record, whose mechanical gates
// own every publish/flag decision.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SUMMARY_SCHEMA, SYSTEM_PROMPT, buildUserMessage, MAX_OUTPUT_TOKENS,
} from './summarizer.js';
import {
  VERIFY_SCHEMA, VERIFY_SYSTEM_PROMPT, buildVerifyMessage, VERIFY_MAX_OUTPUT_TOKENS,
  COMPLETENESS_SCHEMA, COMPLETENESS_SYSTEM_PROMPT, buildProvisionsMessage, buildCoverageMessage,
  VERIFIER_MODEL, minKeyProvisionsFor,
} from './verifier.js';

export { VERIFIER_MODEL };

// USD per Mtok, interactive tier (same table the probe carried; keep in sync with Anthropic
// pricing — priceOf throws rather than spend unpriced).
export const PRICES = {
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'claude-sonnet-5': { in: 2.0, out: 10.0 }, // intro pricing — see PRICES_VERIFIED_THROUGH
  'claude-opus-5': { in: 5.0, out: 25.0 },
};

// The date through which the table above was last checked against published pricing. This used to
// be a comment reading "intro pricing through 2026-08-31", which is a declared expiry condition
// with nothing enforcing it — and a stale price fails in the EXPENSIVE direction: the entry still
// exists, so priceOf returns happily, the cost tracker under-counts real spend, and the $5.00
// weekly cap silently stops being the cap. A budget guard computing from a stale table reports a
// safety it is not providing.
//
// To clear an expiry: re-check every model above against Anthropic's published prices, correct any
// that moved, and move this date forward. Do NOT move the date alone — that is the one edit that
// makes this worse than the comment it replaced.
export const PRICES_VERIFIED_THROUGH = '2026-08-31';

export function priceOf(model) {
  const p = PRICES[model];
  if (!p) throw new Error(`no price entry for model ${model} — add it before spending`);
  return p;
}

// Deliberately NOT folded into priceOf. scripts/gloss-batch-mo.js probes model aliases with
// `try { priceOf(id) } catch { /* try the alias */ }`, so an expiry thrown from there would be
// swallowed and misread as "unknown model" — one exception carrying two unrelated meanings.
// This is called where money starts (createCostTracker), so a billed run refuses to begin on a
// stale table rather than running and under-counting.
export function assertPricesFresh(today = new Date()) {
  const iso = today.toISOString().slice(0, 10);
  if (iso > PRICES_VERIFIED_THROUGH) {
    throw new Error(
      `price table unverified since ${PRICES_VERIFIED_THROUGH} (today ${iso}) — re-check every `
      + 'model in PRICES against published pricing and move PRICES_VERIFIED_THROUGH. Refusing to '
      + 'spend against prices that may have changed.',
    );
  }
}

// createCostTracker — real-usage accounting shared by every call this chain makes. spentUsd()
// is the number budget guards trust; callLog is the per-call audit trail for run detail/logs.
export function createCostTracker({ now } = {}) {
  // Where money starts. A run refuses to begin on an unverified price table rather than running
  // and under-counting against the weekly cap — the failure lands in the safe direction.
  assertPricesFresh(now ?? new Date());
  let spent = 0;
  const callLog = [];
  return {
    record(model, usage, label) {
      const p = priceOf(model);
      const cost = (usage.input_tokens * p.in + usage.output_tokens * p.out) / 1e6;
      spent += cost;
      callLog.push({
        label, model, in: usage.input_tokens, out: usage.output_tokens, usd: Number(cost.toFixed(4)),
      });
      return cost;
    },
    spentUsd() { return spent; },
    callLog,
  };
}

// classifyBillingError — the spec's "billing/credit error class (HTTP 400/402 with
// credit-related message)". Anthropic SDK errors carry .status and .message; anything else
// (schema 400s, 5xx, plain Errors) is NOT billing and must not stop a whole tick.
export function classifyBillingError(err) {
  const status = Number(err?.status);
  if (status !== 400 && status !== 402) return false;
  const msg = String(err?.message ?? '');
  return /credit|billing|balance|purchase|payment/i.test(msg);
}

// The API's structured-output mode rejects array minItems > 1 (live-diagnosed 400). The 3-7
// provisions bound is enforced mechanically at the record gate anyway, so the API-facing schema
// strips only those two constraints.
export function apiProvisionsSchema() {
  const s = { ...COMPLETENESS_SCHEMA.properties.key_provisions };
  delete s.minItems;
  delete s.maxItems;
  return s;
}

// Per-stage checkpoints: every completed (paid) stage persists immediately; a re-run loads the
// checkpoint and never re-pays for a stage it already has. `key` is caller-chosen: the probe
// keeps its historical plain bill_id keys; the scheduler uses `${bill_id}-${hash8}` so a text
// revision invalidates the checkpoint (spec).
export function loadCheckpoint(stageDir, key) {
  const p = path.join(stageDir, `${key}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

export function saveCheckpoint(stageDir, key, data) {
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(path.join(stageDir, `${key}.json`), JSON.stringify(data), 'utf8');
}

// callStructured — one streamed, schema-constrained call with honest usage accounting.
// Streaming is mandatory: the SDK refuses non-streaming calls that could run >10 min (hit live
// on the first probe run).
export async function callStructured(anthropic, tracker, {
  model, system, userContent, schema, maxTokens, label,
}) {
  const stream = anthropic.messages.stream({
    model,
    max_tokens: maxTokens,
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: userContent }],
  });
  const response = await stream.finalMessage();
  tracker.record(model, response.usage, label);
  if (response.stop_reason === 'refusal') throw new Error(`${label}: model refused`);
  if (response.stop_reason === 'max_tokens') throw new Error(`${label}: hit max_tokens`);
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error(`${label}: no text content`);
  return JSON.parse(textBlock.text);
}

// buildReAuthorMessage — the conversion lane's author message: the standard authoring message
// plus the prior draft and the gates' numbered objections. Ported from the reAuthor branch of
// .claude/workflows/summary-wave.js (same framing, API-message form).
export function buildReAuthorMessage(identifier, title, text, priorSummary, objections) {
  return `${buildUserMessage(identifier, title ?? '', text)}

A PRIOR DRAFT of this summary exists (below) with SPECIFIC OBJECTIONS from the mechanical
verification gates. Author a corrected summary: keep what the text genuinely supports, fix every
objection. Never copy a prior claim without re-checking it against the text yourself.

PRIOR DRAFT:
${JSON.stringify(priorSummary)}

OBJECTIONS TO FIX (each MUST be resolved):
${objections.map((o, i) => `${i + 1}. ${o}`).join('\n')}

ADDITIONAL MECHANICAL RULES the code gates enforce:
- stated_purpose, when non-empty, must be a VERBATIM substring of the bill text (whitespace may collapse; words/characters may not change). If the bill's purpose language cannot be quoted verbatim, return "".
- Every field is SINGLE-LINE: no newline characters inside point/section/stated_purpose/term/citation_raw.
- Every \`section\` string you emit MUST appear VERBATIM as a substring of the bill text — never invent, normalize, or reformat a citation.`;
}

// The wave-2-hard-won grounding reinforcement appended to the provisions stage (its absence is
// exactly what the Haiku checkers tripped on).
const GROUNDING_RULE = '\n\nMECHANICAL GROUNDING RULE (a code gate rejects violations whole): every `section` string you emit MUST appear VERBATIM as a substring of the bill text — never invent, normalize, or reformat a citation (no "115.295(2)" unless the text prints exactly that; no dotted ranges the text does not print).';

// runBillChain — author → verify → blind provisions → coverage, checkpointed per stage.
// Returns the summary-queue record envelope. Throws on refusal/max_tokens/zero-bullets (caller
// decides skip-vs-stop; paid stages stay in the checkpoint either way).
export async function runBillChain(anthropic, tracker, {
  bill, text, stageDir, checkpointKey, authorModel, checkerModel, reAuthor = null,
}) {
  const cp = loadCheckpoint(stageDir, checkpointKey);
  if (!cp.summary) {
    const userContent = reAuthor
      ? buildReAuthorMessage(bill.identifier, bill.title, text, reAuthor.priorSummary, reAuthor.objections)
      : buildUserMessage(bill.identifier, bill.title ?? '', text);
    cp.summary = await callStructured(anthropic, tracker, {
      model: authorModel, system: SYSTEM_PROMPT, userContent, schema: SUMMARY_SCHEMA,
      maxTokens: MAX_OUTPUT_TOKENS, label: `${reAuthor ? 'reauthor' : 'author'}:${bill.identifier}`,
    });
    saveCheckpoint(stageDir, checkpointKey, cp);
  }
  const summary = cp.summary;
  if (!summary.what_it_does || summary.what_it_does.length === 0) {
    throw new Error(`author produced zero bullets for ${bill.identifier}`);
  }
  const bulletsJson = JSON.stringify(summary.what_it_does);
  if (!cp.verify) {
    cp.verify = await callStructured(anthropic, tracker, {
      model: VERIFIER_MODEL, system: VERIFY_SYSTEM_PROMPT,
      userContent: buildVerifyMessage(bill.identifier, bulletsJson, text),
      schema: VERIFY_SCHEMA, maxTokens: VERIFY_MAX_OUTPUT_TOKENS, label: `verify:${bill.identifier}`,
    });
    saveCheckpoint(stageDir, checkpointKey, cp);
  }
  if (!cp.provisions) {
    const prov = await callStructured(anthropic, tracker, {
      model: checkerModel, system: COMPLETENESS_SYSTEM_PROMPT,
      userContent: buildProvisionsMessage(bill.identifier, text) + GROUNDING_RULE,
      schema: {
        type: 'object', additionalProperties: false, required: ['key_provisions'], properties: { key_provisions: apiProvisionsSchema() },
      },
      maxTokens: 4000, label: `provisions:${bill.identifier}`,
    });
    cp.provisions = prov.key_provisions;
    saveCheckpoint(stageDir, checkpointKey, cp);
  }
  // Sub-floor corroboration stage (spec 2026-08-18): a yield under the length-scaled floor gets
  // ONE independent blind re-extraction — same prompt, fresh call — and the gate accepts the thin
  // check only if the two runs mechanically agree. Conditional (rare; pennies) and checkpointed
  // like every paid stage; estimateBillCostUsd is deliberately NOT changed (one provisions-sized
  // call sits well inside its existing padding).
  if (cp.provisions.length >= 1 && cp.provisions.length < minKeyProvisionsFor(text.length) && !cp.provisionsCorroboration) {
    const cor = await callStructured(anthropic, tracker, {
      model: checkerModel, system: COMPLETENESS_SYSTEM_PROMPT,
      userContent: buildProvisionsMessage(bill.identifier, text) + GROUNDING_RULE,
      schema: {
        type: 'object', additionalProperties: false, required: ['key_provisions'], properties: { key_provisions: apiProvisionsSchema() },
      },
      maxTokens: 4000, label: `provisions-corroboration:${bill.identifier}`,
    });
    cp.provisionsCorroboration = cor.key_provisions;
    saveCheckpoint(stageDir, checkpointKey, cp);
  }
  if (!cp.coverage) {
    const cov = await callStructured(anthropic, tracker, {
      model: checkerModel, system: COMPLETENESS_SYSTEM_PROMPT,
      userContent: buildCoverageMessage(bill.identifier, JSON.stringify(cp.provisions), bulletsJson),
      schema: {
        type: 'object', additionalProperties: false, required: ['coverage'], properties: { coverage: COMPLETENESS_SCHEMA.properties.coverage },
      },
      maxTokens: 3000, label: `coverage:${bill.identifier}`,
    });
    cp.coverage = cov.coverage;
    saveCheckpoint(stageDir, checkpointKey, cp);
  }
  return {
    envelope: {
      bill_id: bill.bill_id,
      identifier: bill.identifier,
      bill_text_hash: bill.bill_text_hash,
      summary,
      verdicts: cp.verify.verdicts,
      completeness: { key_provisions: cp.provisions, coverage: cp.coverage },
      ...(cp.provisionsCorroboration ? { completeness_corroboration: { key_provisions: cp.provisionsCorroboration } } : {}),
      provenance: 'api',
      author_model: authorModel,
      verifier_model: VERIFIER_MODEL,
    },
  };
}
