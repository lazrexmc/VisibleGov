// gloss-batch-mo.mjs — the MO glossary drain, Batch API edition (Lance-approved 2026-08-20:
// "I agree, lets go for it"; hard cap given at dispatch via --budget-usd, proposed $15).
//
// Config per the approved design: Haiku authors → mechanical gates (verbatim-quote, empty-gloss)
// → one retry with an explicit warning → Sonnet-author escalation → Sonnet adversarially
// verifies → assessVerdicts gate → persistGloss with the TRUE author model byline. Every billed
// call runs through the Message Batches API (50% off — tracked as interactive price × 0.5).
//
// Trust properties inherited unchanged: all prompts/schemas/gates are the trust lib's own
// exports (glosser.js / verifier.js / gloss.js) — this file orchestrates, it never re-derives.
//
// Politeness (spec §4): the fetch sweep is strictly sequential through the adapter's own 5s
// limiter. A bot page = 10-minute cooldown, ONE retry; a second bot page on the same section is
// the nonexistent-section signal (rate limiting would have cleared) → the term is PARKED
// (status='rejected' + a glossary_notes row carrying the evidence) and the sweep continues.
// A systematic identity-error streak aborts the sweep honestly (template-drift signal).
//
// Checkpointing: every phase persists to .superpowers/artifacts/gloss-batch-mo/ (gitignored);
// --resume picks up mid-phase (batch ids are stored, so even a killed poll resumes).
//
// Usage:
//   node --env-file=.env scripts/gloss-batch-mo.mjs --budget-usd 15 [--max-terms N] [--resume]
//   node --env-file=.env scripts/gloss-batch-mo.mjs --fetch-only --budget-usd 15
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { getClient, selectAll, openRun, closeRun } from '../src/lib/db.js';
import {
  GLOSS_SYSTEM_PROMPT, GLOSS_SCHEMA, buildGlossUserMessage, MAX_OUTPUT_TOKENS,
  GLOSS_VERIFIER_MODEL, GLOSS_VERIFY_SYSTEM_PROMPT, GLOSS_VERIFY_SCHEMA,
  GLOSS_VERIFY_MAX_OUTPUT_TOKENS, buildGlossVerifyMessage,
  splitGlossSentences, assertGlossNotEmpty, assertQuoteVerbatim, fetchGlossSource,
} from '../src/lib/glosser.js';
import { assessVerdicts } from '../src/lib/verifier.js';
import { planGlossing, loadAllTerms, persistGloss } from '../src/cli/gloss.js';
import { isMoCitation, MoBotPageError, MoPageIdentityError } from '../src/adapters/mo-statutes.js';
import { priceOf } from '../src/lib/billed-summary-chain.js';

export const AUTHOR_MODEL = 'claude-haiku-4-5';
export const ESCALATION_MODEL = 'claude-sonnet-5';
export const BATCH_DISCOUNT = 0.5; // Message Batches API: 50% of standard prices
export const BOT_PAGE_COOLDOWN_MS = 10 * 60 * 1000;
export const IDENTITY_ABORT_THRESHOLD = 20; // sweep-wide template-drift tripwire
export const RUN_SOURCE = 'gloss-batch-mo'; // the MO default; see runSourceFor

// --source widening (2026-08-21): the same runner drains the USC mappable drafts. The two drains
// stay separate in run labels and checkpoint dirs so --resume can never mix them. Routing is by
// the STORED citation shape (the prefix-discriminated format the glossary keys on).
export function citationFilterFor(source) {
  if (source === 'mo') return (t) => isMoCitation(t?.citation);
  if (source === 'usc') return (t) => typeof t?.citation === 'string' && /U\.S\.C\./.test(t.citation);
  throw new Error(`unknown --source ${source} (expected mo|usc)`);
}
export function runSourceFor(source) { return `gloss-batch-${source}`; }
export function stateDirNameFor(source) { return `gloss-batch-${source}`; }

// The wave-2 remedy class: an explicit warning against the exact prior mistake, appended to the
// SAME user message the first attempt saw (prompts themselves stay the trust lib's, unmodified).
export const RETRY_WARNING = [
  '',
  'WARNING — your previous attempt failed a mechanical gate and was discarded:',
  'supported_by_quote MUST be one exact, contiguous, character-for-character passage copied from',
  'the excerpt above. Never insert brackets, ellipses, summaries, or any word the excerpt does',
  'not print at that position. gloss_md must be non-empty (1-2 sentences).',
].join('\n');

// The Batch API reports each result's model as the CANONICAL dated id (e.g.
// claude-haiku-4-5-20251001) while PRICES keys on the alias we requested (claude-haiku-4-5) —
// learned live 2026-08-21 when the first collected result threw "no price entry" and killed the
// resume. Strip one trailing -YYYYMMDD only when the exact id is unpriced; a genuinely unknown
// model still refuses (priceOf throws) — never spend unpriced.
export function priceableModelId(model) {
  try { priceOf(model); return model; } catch { /* fall through to the alias */ }
  return String(model).replace(/-\d{8}$/, '');
}

export function batchSpendUsd(model, usage) {
  const p = priceOf(priceableModelId(model));
  return ((usage.input_tokens * p.in + usage.output_tokens * p.out) / 1e6) * BATCH_DISCOUNT;
}

export function buildAuthorRequest(term, excerptText, { model, withRetryWarning = false } = {}) {
  const base = buildGlossUserMessage(term.term, excerptText);
  return {
    custom_id: term.id,
    params: {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: GLOSS_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: GLOSS_SCHEMA } },
      messages: [{ role: 'user', content: withRetryWarning ? base + RETRY_WARNING : base }],
    },
  };
}

export function buildVerifyRequest(term, sentences, excerptText) {
  return {
    custom_id: term.id,
    params: {
      model: GLOSS_VERIFIER_MODEL,
      max_tokens: GLOSS_VERIFY_MAX_OUTPUT_TOKENS,
      system: GLOSS_VERIFY_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: GLOSS_VERIFY_SCHEMA } },
      messages: [{ role: 'user', content: buildGlossVerifyMessage(term.term, JSON.stringify(sentences), excerptText) }],
    },
  };
}

// gateAuthoredGloss — every mechanical check the interactive path runs between author and verify,
// applied to a batch result message. Returns {ok:true, glossJson, sentences} or {ok:false, reason}.
// Gate failures are RETRYABLE (the retry ladder's food), never thrown.
export function gateAuthoredGloss(term, message, excerptText) {
  if (message.stop_reason === 'refusal') return { ok: false, reason: 'author refusal' };
  if (message.stop_reason === 'max_tokens') return { ok: false, reason: 'author truncation' };
  const textBlock = (message.content ?? []).find((b) => b.type === 'text');
  if (!textBlock) return { ok: false, reason: 'no text content' };
  let glossJson;
  try {
    glossJson = JSON.parse(textBlock.text);
  } catch {
    return { ok: false, reason: 'unparseable JSON' };
  }
  try {
    assertQuoteVerbatim(glossJson.supported_by_quote, excerptText, { term: term.term, termId: term.id });
    const sentences = splitGlossSentences(glossJson.gloss_md);
    assertGlossNotEmpty(sentences, { term: term.term, termId: term.id });
    return { ok: true, glossJson, sentences };
  } catch (err) {
    return { ok: false, reason: `${err.name}: ${err.message}` };
  }
}

// ---- orchestration (thin; everything above is the tested surface) ----

let STATE_DIR = new URL('../.superpowers/artifacts/gloss-batch-mo/', import.meta.url);
function useStateDir(source) { STATE_DIR = new URL(`../.superpowers/artifacts/${stateDirNameFor(source)}/`, import.meta.url); }
const p = (name) => new URL(name, STATE_DIR);
const loadJson = (name, fallback) => (existsSync(p(name)) ? JSON.parse(readFileSync(p(name), 'utf8')) : fallback);
const saveJson = (name, value) => writeFileSync(p(name), JSON.stringify(value, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseRunnerArgs(argv) {
  const out = { budgetUsd: NaN, maxTerms: Infinity, fetchOnly: false, resume: false, source: 'mo' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--budget-usd') out.budgetUsd = Number(argv[i += 1, i]);
    else if (argv[i] === '--max-terms') out.maxTerms = Number(argv[i += 1, i]);
    else if (argv[i] === '--fetch-only') out.fetchOnly = true;
    else if (argv[i] === '--resume') out.resume = true;
    else if (argv[i] === '--source') out.source = argv[i += 1, i];
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (!(out.budgetUsd > 0)) throw new Error('--budget-usd must be > 0');
  citationFilterFor(out.source); // validates early
  return out;
}

async function parkTerm(client, term, note) {
  const { error: nErr } = await client.from('glossary_notes').insert({ term_id: term.id, note, action: 'rejected' });
  if (nErr) throw new Error(`glossary_notes insert failed for ${term.id}: ${nErr.message}`);
  const { error: uErr } = await client.from('glossary_terms').update({ status: 'rejected' }).eq('id', term.id);
  if (uErr) throw new Error(`glossary_terms park failed for ${term.id}: ${uErr.message}`);
}

async function runBatch(anthropic, requests, label, state, spend) {
  let batchId = state.batches[label];
  if (!batchId) {
    const created = await anthropic.messages.batches.create({ requests });
    batchId = created.id;
    state.batches[label] = batchId;
    saveJson('state.json', state);
    console.error(`${label}: submitted batch ${batchId} (${requests.length} requests)`);
  } else {
    console.error(`${label}: resuming batch ${batchId}`);
  }
  for (;;) {
    const batch = await anthropic.messages.batches.retrieve(batchId);
    if (batch.processing_status === 'ended') break;
    console.error(`${label}: ${batch.processing_status} (${batch.request_counts.processing} processing)`);
    await sleep(60_000);
  }
  const results = new Map();
  for await (const result of await anthropic.messages.batches.results(batchId)) {
    if (result.result.type === 'succeeded') {
      const msg = result.result.message;
      spend.total += batchSpendUsd(msg.model, msg.usage);
      results.set(result.custom_id, { ok: true, message: msg });
    } else {
      results.set(result.custom_id, { ok: false, type: result.result.type });
    }
  }
  saveJson('state.json', state);
  return results;
}

async function main() {
  const args = parseRunnerArgs(process.argv.slice(2));
  useStateDir(args.source);
  mkdirSync(STATE_DIR, { recursive: true });
  const client = getClient();
  const anthropic = new Anthropic();
  const state = args.resume ? loadJson('state.json', { batches: {}, parked: [], fetchFailures: [] }) : { batches: {}, parked: [], fetchFailures: [] };
  const spend = { total: state.spentUsd ?? 0 };
  const excerpts = loadJson('excerpts.json', {});

  // ---- candidates: RSMo-cited, gloss-ready, per the same planGlossing buckets gloss.js uses
  const { terms } = await loadAllTerms(client); // returns {terms, tableMissing}, never a bare array
  const candidates = planGlossing(terms).candidates.filter(citationFilterFor(args.source)).slice(0, args.maxTerms);
  console.error(`candidates: ${candidates.length} ${args.source}-cited gloss-ready terms`);

  // ---- phase FETCH (sequential, 5s limiter inside fetchGlossSource; free) ----
  let identityErrors = 0;
  for (const term of candidates) {
    if (excerpts[term.id] || state.parked.includes(term.id)) continue;
    try {
      const { url, excerptText, hash } = await fetchGlossSource(term.citation);
      excerpts[term.id] = { url, excerptText, hash };
      saveJson('excerpts.json', excerpts);
    } catch (err) {
      if (err instanceof MoBotPageError) {
        console.error(`bot page on ${term.citation} — cooling down ${BOT_PAGE_COOLDOWN_MS / 60000} min, then ONE retry`);
        await sleep(BOT_PAGE_COOLDOWN_MS);
        try {
          const { url, excerptText, hash } = await fetchGlossSource(term.citation);
          excerpts[term.id] = { url, excerptText, hash };
          saveJson('excerpts.json', excerpts);
        } catch (err2) {
          if (err2 instanceof MoBotPageError) {
            const note = `parked by gloss-batch-mo ${new Date().toISOString()}: revisor.mo.gov served its bot page twice, ${BOT_PAGE_COOLDOWN_MS / 60000} minutes apart at 5s pacing, for ${term.citation} — the nonexistent-section signal (rate limiting would have cleared). Likely a bill-created section the Revisor does not serve yet. Unpark by setting status back to 'draft' if the section appears.`;
            await parkTerm(client, term, note);
            state.parked.push(term.id);
            saveJson('state.json', state);
            console.error(`PARKED ${term.citation}`);
          } else { throw err2; }
        }
      } else if (err instanceof MoPageIdentityError) {
        identityErrors += 1;
        state.fetchFailures.push({ id: term.id, citation: term.citation, reason: `${err.name}: ${err.message}` });
        saveJson('state.json', state);
        if (identityErrors >= IDENTITY_ABORT_THRESHOLD) {
          throw new Error(`${identityErrors} identity errors — template-drift signal, aborting the sweep honestly rather than hammering ${candidates.length} pages`);
        }
      } else {
        state.fetchFailures.push({ id: term.id, citation: term.citation, reason: `${err.name}: ${err.message}` });
        saveJson('state.json', state);
      }
    }
  }
  const fetched = candidates.filter((t) => excerpts[t.id]);
  console.error(`fetched: ${fetched.length}; parked: ${state.parked.length}; fetch failures: ${state.fetchFailures.length}`);
  if (args.fetchOnly) { console.log(JSON.stringify({ fetched: fetched.length, parked: state.parked.length, failures: state.fetchFailures.length })); return; }

  // ---- budget guard before any submission (probe-derived worst-case per call, batched) ----
  const estimate = fetched.length * (0.0008 + 0.0055) * 1.5;
  if (estimate > args.budgetUsd) throw new Error(`estimate $${estimate.toFixed(2)} exceeds budget $${args.budgetUsd} — refusing to submit`);

  // ---- phase AUTHOR: round 1 (haiku) -> round 2 (haiku + warning) -> round 3 (sonnet) ----
  const authored = new Map(); // term id -> {glossJson, sentences, authorModel}
  const authorFailures = [];
  let pending = fetched;
  const rounds = [
    { label: 'author-1', model: AUTHOR_MODEL, warn: false },
    { label: 'author-2', model: AUTHOR_MODEL, warn: true },
    { label: 'author-3', model: ESCALATION_MODEL, warn: true },
  ];
  for (const round of rounds) {
    if (pending.length === 0) break;
    if (spend.total >= args.budgetUsd) throw new Error(`budget exhausted ($${spend.total.toFixed(2)}) before ${round.label}`);
    const requests = pending.map((t) => buildAuthorRequest(t, excerpts[t.id].excerptText, { model: round.model, withRetryWarning: round.warn }));
    const results = await runBatch(anthropic, requests, round.label, state, spend);
    const next = [];
    for (const term of pending) {
      const r = results.get(term.id);
      if (!r || !r.ok) { next.push(term); continue; }
      const gate = gateAuthoredGloss(term, r.message, excerpts[term.id].excerptText);
      if (gate.ok) authored.set(term.id, { glossJson: gate.glossJson, sentences: gate.sentences, authorModel: round.model });
      else next.push(term);
    }
    console.error(`${round.label}: ${authored.size} authored total, ${next.length} still pending ($${spend.total.toFixed(2)} spent)`);
    pending = next;
  }
  for (const term of pending) authorFailures.push({ id: term.id, citation: term.citation, reason: 'failed all three author rounds' });

  // ---- phase VERIFY (sonnet, batch) ----
  if (spend.total >= args.budgetUsd) throw new Error(`budget exhausted ($${spend.total.toFixed(2)}) before verify`);
  const verifyTerms = fetched.filter((t) => authored.has(t.id));
  const verifyRequests = verifyTerms.map((t) => buildVerifyRequest(t, authored.get(t.id).sentences, excerpts[t.id].excerptText));
  const verifyResults = await runBatch(anthropic, verifyRequests, 'verify', state, spend);

  // ---- phase PERSIST (the mechanical gates decide; the run record carries everything) ----
  const runId = await openRun(client, runSourceFor(args.source));
  let glossed = 0; let flagged = 0; const verifyFailures = [];
  try {
    for (const term of verifyTerms) {
      const r = verifyResults.get(term.id);
      const a = authored.get(term.id);
      if (!r || !r.ok) { verifyFailures.push({ id: term.id, reason: r ? r.type : 'missing result' }); continue; }
      const msg = r.message;
      if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') { verifyFailures.push({ id: term.id, reason: `verify ${msg.stop_reason}` }); continue; }
      const textBlock = (msg.content ?? []).find((b) => b.type === 'text');
      let verifyJson;
      try { verifyJson = JSON.parse(textBlock?.text ?? ''); } catch { verifyFailures.push({ id: term.id, reason: 'verify unparseable JSON' }); continue; }
      const { complete, overall } = assessVerdicts(verifyJson.verdicts, a.sentences.length);
      if (!complete) { verifyFailures.push({ id: term.id, reason: 'incomplete verdict set' }); continue; }
      await persistGloss(client, runId, term, {
        glossMd: a.glossJson.gloss_md, supportedByQuote: a.glossJson.supported_by_quote,
        sourceUrl: excerpts[term.id].url, sourceHash: excerpts[term.id].hash,
        verdicts: verifyJson.verdicts, overall, authorModel: a.authorModel,
      });
      if (overall === 'clean') glossed += 1; else flagged += 1;
    }
    const detail = {
      budget_usd: args.budgetUsd, spent_usd: Number(spend.total.toFixed(4)),
      candidates: candidates.length, fetched: fetched.length,
      glossed_clean: glossed, flagged, parked: state.parked.length,
      fetch_failures: state.fetchFailures.length, author_failures: authorFailures.length,
      verify_failures: verifyFailures.length,
      author_model: AUTHOR_MODEL, escalation_model: ESCALATION_MODEL, verifier_model: GLOSS_VERIFIER_MODEL,
      batch_api: true,
    };
    await closeRun(client, runId, 'succeeded', detail);
    state.spentUsd = spend.total; saveJson('state.json', state);
    console.log(JSON.stringify(detail, null, 2));
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err), spent_usd: Number(spend.total.toFixed(4)), glossed_clean: glossed, flagged });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
