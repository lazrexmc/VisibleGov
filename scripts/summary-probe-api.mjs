// Budget-capped API summary runner — built for Lance's $2 Haiku-authoring probe (2026-08-07)
// and reusable as the billed-path driver if the probe's publish rate holds.
//
// Per bill, the same 4-stage trust chain the $0 waves run, but as billed API calls:
//   1. author      (--author-model, probe: claude-haiku-4-5)  — SUMMARY_SCHEMA json_schema output
//   2. verify      (claude-sonnet-5, the spec's verifier — the safety net is not the experiment)
//   3. provisions  (--checker-model, probe: claude-haiku-4-5) — BLIND: bill text only
//   4. coverage    (--checker-model)                          — provisions + bullets only, no text
// Emits the summary-queue `record` envelope with provenance:'api'; every publish/flag decision
// stays with src/cli/summary-queue.js's mechanical gates — this script never writes the DB.
//
// Budget: tracks REAL usage from every response at current per-Mtok prices and HARD-STOPS before
// starting any bill once remaining budget < the batch's own worst-observed per-bill cost (or the
// conservative floor before any bill has finished). Skips bills > --max-chars (omnibus monsters
// belong to the $0 waves). Run:
//   node --env-file=.env scripts/summary-probe-api.mjs --budget-usd 2 [--author-model m] [--max-chars 100000]
import { readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import {
  SUMMARY_SCHEMA, SYSTEM_PROMPT, buildUserMessage, MAX_OUTPUT_TOKENS,
} from '../src/lib/summarizer.js';
import {
  VERIFY_SCHEMA, VERIFY_SYSTEM_PROMPT, buildVerifyMessage, VERIFY_MAX_OUTPUT_TOKENS,
  COMPLETENESS_SCHEMA, COMPLETENESS_SYSTEM_PROMPT, buildProvisionsMessage, buildCoverageMessage,
  VERIFIER_MODEL,
} from '../src/lib/verifier.js';

// USD per Mtok, interactive tier (batch pricing comes with the full runner if the probe passes).
const PRICES = {
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'claude-sonnet-5': { in: 2.0, out: 10.0 }, // intro pricing through 2026-08-31
  'claude-opus-5': { in: 5.0, out: 25.0 },
};

function parseArgs(argv) {
  const out = {
    budgetUsd: 2, authorModel: 'claude-haiku-4-5', checkerModel: 'claude-haiku-4-5', maxChars: 100000,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (key === '--budget-usd') out.budgetUsd = Number(value);
    else if (key === '--author-model') out.authorModel = value;
    else if (key === '--checker-model') out.checkerModel = value;
    else if (key === '--max-chars') out.maxChars = Number(value);
    else throw new Error(`unknown flag: ${key}`);
  }
  if (!(out.budgetUsd > 0)) throw new Error('--budget-usd must be > 0');
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
const client = new Anthropic();

let spentUsd = 0;
const callLog = [];
function priceOf(model) {
  const p = PRICES[model];
  if (!p) throw new Error(`no price entry for model ${model} — add it before spending`);
  return p;
}
async function call(model, system, userContent, schema, maxTokens, label) {
  // Streaming is mandatory for high-max_tokens requests (the SDK refuses non-streaming calls
  // that could run >10 min — hit live on the first probe run); finalMessage() gives the same
  // complete response object.
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: userContent }],
  });
  const response = await stream.finalMessage();
  const p = priceOf(model);
  const cost = (response.usage.input_tokens * p.in + response.usage.output_tokens * p.out) / 1e6;
  spentUsd += cost;
  callLog.push({ label, model, in: response.usage.input_tokens, out: response.usage.output_tokens, usd: Number(cost.toFixed(4)) });
  if (response.stop_reason === 'refusal') throw new Error(`${label}: model refused`);
  if (response.stop_reason === 'max_tokens') throw new Error(`${label}: hit max_tokens`);
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error(`${label}: no text content`);
  return JSON.parse(textBlock.text);
}

// The API's structured-output mode rejects array minItems > 1 (live-diagnosed 400: "For 'array'
// type, 'minItems' values other than 0 or 1 are not supported"). The 3-7 provisions bound is a
// REQUEST at the schema layer anyway — assessCompleteness enforces it mechanically at the record
// gate — so the API-facing copy strips the unsupported constraints and keeps everything else.
const API_PROVISIONS_ITEMS = { ...COMPLETENESS_SCHEMA.properties.key_provisions };
delete API_PROVISIONS_ITEMS.minItems;
delete API_PROVISIONS_ITEMS.maxItems;

// Per-stage checkpointing (live-learned the expensive way: a stage-3 failure used to discard the
// PAID author+verify outputs of the same bill). Every completed stage persists immediately; a
// re-run loads the checkpoint and never re-pays for a stage it already has.
import { existsSync, mkdirSync } from 'node:fs';
const STAGE_DIR = '.superpowers/artifacts/wave3/api-stages';
mkdirSync(STAGE_DIR, { recursive: true });
function loadCheckpoint(billId) {
  const p = `${STAGE_DIR}/${billId}.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}
function saveCheckpoint(billId, data) {
  writeFileSync(`${STAGE_DIR}/${billId}.json`, JSON.stringify(data), 'utf8');
}

const manifest = JSON.parse(readFileSync('.superpowers/artifacts/wave3/manifest.json', 'utf8'))
  .sort((a, b) => a.text_length - b.text_length); // smallest first: cheapest signal per dollar
const results = [];
const skipped = [];
let worstBillUsd = 0.05; // floor for small-bill probing; grows with observed reality

for (const bill of manifest) {
  if (bill.text_length > args.maxChars) { skipped.push({ identifier: bill.identifier, reason: `oversize ${bill.text_length} > ${args.maxChars}` }); continue; }
  if (args.budgetUsd - spentUsd < worstBillUsd) { skipped.push({ identifier: bill.identifier, reason: 'budget guard' }); continue; }
  const startSpend = spentUsd;
  try {
    const text = readFileSync(bill.text_file, 'utf8');
    const cp = loadCheckpoint(bill.bill_id);
    if (!cp.summary) {
      cp.summary = await call(args.authorModel, SYSTEM_PROMPT, buildUserMessage(bill.identifier, bill.title ?? '', text), SUMMARY_SCHEMA, MAX_OUTPUT_TOKENS, `author:${bill.identifier}`);
      saveCheckpoint(bill.bill_id, cp);
    }
    const summary = cp.summary;
    if (!summary.what_it_does || summary.what_it_does.length === 0) throw new Error('author produced zero bullets');
    const bulletsJson = JSON.stringify(summary.what_it_does);
    if (!cp.verify) {
      cp.verify = await call(VERIFIER_MODEL, VERIFY_SYSTEM_PROMPT, buildVerifyMessage(bill.identifier, bulletsJson, text), VERIFY_SCHEMA, VERIFY_MAX_OUTPUT_TOKENS, `verify:${bill.identifier}`);
      saveCheckpoint(bill.bill_id, cp);
    }
    const verify = cp.verify;
    if (!cp.provisions) {
      const prov = await call(args.checkerModel, COMPLETENESS_SYSTEM_PROMPT, buildProvisionsMessage(bill.identifier, text), { type: 'object', additionalProperties: false, required: ['key_provisions'], properties: { key_provisions: API_PROVISIONS_ITEMS } }, 4000, `provisions:${bill.identifier}`);
      cp.provisions = prov.key_provisions;
      saveCheckpoint(bill.bill_id, cp);
    }
    const provisions = { key_provisions: cp.provisions };
    if (!cp.coverage) {
      const cov = await call(args.checkerModel, COMPLETENESS_SYSTEM_PROMPT, buildCoverageMessage(bill.identifier, JSON.stringify(provisions.key_provisions), bulletsJson), { type: 'object', additionalProperties: false, required: ['coverage'], properties: { coverage: COMPLETENESS_SCHEMA.properties.coverage } }, 3000, `coverage:${bill.identifier}`);
      cp.coverage = cov.coverage;
      saveCheckpoint(bill.bill_id, cp);
    }
    const coverage = { coverage: cp.coverage };
    results.push({
      bill_id: bill.bill_id,
      identifier: bill.identifier,
      bill_text_hash: bill.bill_text_hash,
      summary,
      verdicts: verify.verdicts,
      completeness: { key_provisions: provisions.key_provisions, coverage: coverage.coverage },
      provenance: 'api',
      author_model: args.authorModel,
      verifier_model: VERIFIER_MODEL,
    });
    worstBillUsd = Math.max(worstBillUsd, (spentUsd - startSpend) * 1.5);
  } catch (err) {
    skipped.push({ identifier: bill.identifier, reason: String(err.message ?? err) });
  }
}

writeFileSync('.superpowers/artifacts/wave3/records-api.json', JSON.stringify({ results }, null, 1), 'utf8');
console.log(JSON.stringify({
  spent_usd: Number(spentUsd.toFixed(4)),
  budget_usd: args.budgetUsd,
  bills_completed: results.length,
  skipped,
  per_call: callLog,
}, null, 1));
