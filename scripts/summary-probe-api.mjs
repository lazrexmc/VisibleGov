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
// The 4-stage chain itself lives in src/lib/billed-summary-chain.js (shared with
// scripts/scheduled-summaries.js) — this script owns only CLI parsing, the manifest/skip-file
// input, the budget guard, and the output files/terminal JSON.
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
  createCostTracker, callStructured, runBillChain, loadCheckpoint, saveCheckpoint,
} from '../src/lib/billed-summary-chain.js';

function parseArgs(argv) {
  const out = {
    // Proven config (the $2 probe, 2026-08-07): Haiku authors survived the gates 9/9; Haiku
    // CHECKERS failed 8/9 (invented normalized citations, under-counts) — checking defaults to
    // Sonnet, the config that ran wave 3's checks with zero grounding rejects.
    budgetUsd: 2, authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5', maxChars: 100000,
  };
  out.authorOnly = false;
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (key === '--budget-usd') out.budgetUsd = Number(value);
    else if (key === '--author-model') out.authorModel = value;
    else if (key === '--checker-model') out.checkerModel = value;
    else if (key === '--max-chars') out.maxChars = Number(value);
    else if (key === '--author-only') { out.authorOnly = true; i -= 1; } // boolean flag, no value
    else if (key === '--skip-file') out.skipFile = value; // JSON array of bill_ids another lane owns
    else throw new Error(`unknown flag: ${key}`);
  }
  if (!(out.budgetUsd > 0)) throw new Error('--budget-usd must be > 0');
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
const client = new Anthropic();
const tracker = createCostTracker();

// Per-stage checkpointing (live-learned the expensive way: a stage-3 failure used to discard the
// PAID author+verify outputs of the same bill). Every completed stage persists immediately; a
// re-run loads the checkpoint and never re-pays for a stage it already has. Plain bill_id keys
// (unchanged) so checkpoints from before this refactor stay valid.
const STAGE_DIR = '.superpowers/artifacts/wave3/api-stages';

const skipIds = new Set(args.skipFile ? JSON.parse(readFileSync(args.skipFile, 'utf8')) : []);
const manifest = JSON.parse(readFileSync('.superpowers/artifacts/wave3/manifest.json', 'utf8'))
  .filter((b) => !skipIds.has(b.bill_id)) // bills another lane (a subscription wave) owns
  .sort((a, b) => a.text_length - b.text_length); // smallest first: cheapest signal per dollar
const results = [];
const skipped = [];
let worstBillUsd = 0.05; // floor for small-bill probing; grows with observed reality

for (const bill of manifest) {
  if (bill.text_length > args.maxChars) { skipped.push({ identifier: bill.identifier, reason: `oversize ${bill.text_length} > ${args.maxChars}` }); continue; }
  if (args.budgetUsd - tracker.spentUsd() < worstBillUsd) { skipped.push({ identifier: bill.identifier, reason: 'budget guard' }); continue; }
  const startSpend = tracker.spentUsd();
  try {
    const text = readFileSync(bill.text_file, 'utf8');
    // Author-bank mode (Lance, 2026-08-07: "spend the weekly subscription tokens to prep... to
    // lower the spend"): dollars buy ONLY the Haiku authoring; the Sonnet-priced stages drain
    // from these checkpoints later on subscription-token subagent waves.
    if (args.authorOnly) {
      const cp = loadCheckpoint(STAGE_DIR, bill.bill_id);
      if (!cp.summary) {
        cp.summary = await callStructured(client, tracker, {
          model: args.authorModel, system: SYSTEM_PROMPT, userContent: buildUserMessage(bill.identifier, bill.title ?? '', text),
          schema: SUMMARY_SCHEMA, maxTokens: MAX_OUTPUT_TOKENS, label: `author:${bill.identifier}`,
        });
        saveCheckpoint(STAGE_DIR, bill.bill_id, cp);
      }
      if (!cp.summary.what_it_does || cp.summary.what_it_does.length === 0) throw new Error('author produced zero bullets');
      skipped.push({ identifier: bill.identifier, reason: 'banked (author-only mode)' });
      worstBillUsd = Math.max(0.02, (tracker.spentUsd() - startSpend) * 1.5);
      continue;
    }
    const { envelope } = await runBillChain(client, tracker, {
      bill: {
        bill_id: bill.bill_id, identifier: bill.identifier, title: bill.title, bill_text_hash: bill.bill_text_hash,
      },
      text, stageDir: STAGE_DIR, checkpointKey: bill.bill_id,
      authorModel: args.authorModel, checkerModel: args.checkerModel,
    });
    results.push(envelope);
    worstBillUsd = Math.max(worstBillUsd, (tracker.spentUsd() - startSpend) * 1.5);
  } catch (err) {
    skipped.push({ identifier: bill.identifier, reason: String(err.message ?? err) });
  }
}

writeFileSync('.superpowers/artifacts/wave3/records-api.json', JSON.stringify({ results }, null, 1), 'utf8');
console.log(JSON.stringify({
  spent_usd: Number(tracker.spentUsd().toFixed(4)),
  budget_usd: args.budgetUsd,
  bills_completed: results.length,
  skipped,
  per_call: tracker.callLog,
}, null, 1));
