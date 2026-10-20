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

// CONTROL PROBE (2026-10-20) — how we tell "this section does not exist" from "we are being rate
// limited" WITHOUT waiting 10 minutes to find out.
//
// WHY THIS EXISTS, measured rather than reasoned. The 2026-10-20 MO sweep spent ~110 minutes to
// rule out TEN sections and fetched none, because revisor.mo.gov serves the SAME bot-detection
// page for a section it does not have as it does when it is throttling us. The old code could
// only distinguish the two by waiting out a 10-minute cooldown per section, on the sound logic
// that rate limiting would have cleared. At 969 candidates with a meaningful uncodified share,
// that is tens of hours of deliberate sleeping, and the cooldown - not the API, not the money -
// was the binding constraint on the whole lane.
//
// The measurement that produced the fix: in a single minute, RSMo 621.075 and ten other known
// sections returned real text while the ten suspect sections returned the bot page. So the site
// WAS answering us; those sections simply are not there. A control section establishes that in
// one 5s request instead of 600 seconds of waiting.
//
// THE ASYMMETRY IS DELIBERATE AND IS THE WHOLE SAFETY ARGUMENT: parking a term requires POSITIVE
// proof the site is serving us. A clean control fetch is that proof. Anything else - a bot page on
// the control, a network error, a timeout, a parse failure - means we do not know, and we fall
// back to the original cooldown-and-retry path. A false park writes status='rejected' onto a real
// statute section, so the failure must land on the side of waiting, never of rejecting.
//
// 1.010 is the control because it is the most permanent section in RSMo (the common-law reception
// statute, chapter 1 section 010) and is not plausibly repealed or renumbered.
export const CONTROL_CITATION = 'RSMo 1.010';
export const CONTROL_TTL_MS = 60 * 1000;

// A short TTL so a long run of nonexistent sections re-probes occasionally rather than on every
// single one. Without it this fix would double request volume against the very site whose
// throttling it is trying to reason about - causing the condition it exists to detect.
export function createControlProbe(fetchFn, { ttlMs = CONTROL_TTL_MS, now = () => Date.now() } = {}) {
  let last = null;
  return async function controlIsServing() {
    if (last && now() - last.at < ttlMs) return last.serving;
    let serving = false;
    try {
      const res = await fetchFn(CONTROL_CITATION);
      // Truthy excerpt text only. A 200 that carries no text is not proof of service.
      serving = Boolean(res && res.excerptText);
    } catch {
      serving = false; // includes MoBotPageError: unknown, so fall back to the slow path
    }
    last = { at: now(), serving };
    return serving;
  };
}
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

// Pre-submission cost projection FROM THE BANK ON DISK (2026-08-21, after the USC run spent $8.31
// against an $8 cap: the cap only gated before each submission, and one verify batch cost $5.24,
// so nothing could stop it; the up-front estimate was a flat MO-derived per-term rate while the
// USC excerpts averaged 2.5x the MO length). ~4 chars/token for statute text; the overhead covers
// the system prompt + instructions + (for verify) the sentences JSON; the output allowance is
// PHASE-SPECIFIC — a verify result restates every sentence with its verdict, reason, and quote,
// so it runs ~3x an authored gloss. CALIBRATED against the 2026-08-21 USC run (669 excerpts,
// mean 11,056 chars): author-1 projects $1.62 vs $1.28 actual (+27%); verify projects $5.57 vs
// $5.24 actual (+6%). A first cut with a flat 500-token output allowance projected verify at
// $3.92 — 25% LOW — and would still have allowed the batch; the calibration test in
// tests/gloss-batch-mo.test.js pins both phases to today's actuals so that cannot silently
// recur. Projections must err high, never low. The default output allowance is the larger
// (verify) one, so a call site that forgets to pass one over-projects rather than under.
export const PROJECTION_CHARS_PER_TOKEN = 4;
export const PROJECTION_OVERHEAD_TOKENS = 600;
export const PROJECTION_AUTHOR_OUTPUT_TOKENS = 300;
export const PROJECTION_VERIFY_OUTPUT_TOKENS = 1000;
export const PROJECTION_OUTPUT_TOKENS = PROJECTION_VERIFY_OUTPUT_TOKENS;
// Up-front, the minimum path (author-1 + verify over everything) is multiplied by this before
// the cap check: without it a run can sink the author rounds and then be refused at verify,
// leaving paid-for glosses unverified. 1.25 covers the measured retry share (USC: rounds 2-3 were
// $1.79 of $8.31).
export const PROJECTION_RETRY_ALLOWANCE = 1.25;
export function projectBatchSpendUsd(model, excerptTexts, {
  overheadTokens = PROJECTION_OVERHEAD_TOKENS, outputTokens = PROJECTION_OUTPUT_TOKENS,
} = {}) {
  const p = priceOf(priceableModelId(model));
  let usd = 0;
  for (const text of excerptTexts) {
    const inputTokens = Math.ceil(String(text).length / PROJECTION_CHARS_PER_TOKEN) + overheadTokens;
    usd += ((inputTokens * p.in + outputTokens * p.out) / 1e6) * BATCH_DISCOUNT;
  }
  return usd;
}
// The cap is enforced HERE, before money leaves: a batch whose projected cost would carry the
// run past --budget-usd is refused in full (checkpointed state makes a later --resume with a
// larger cap or a --max-terms slice the honest continuation).
export function assertWithinBudget({ label, spentUsd, projectedUsd, budgetUsd }) {
  if (spentUsd + projectedUsd > budgetUsd) {
    throw new Error(`budget: ${label} projected $${projectedUsd.toFixed(2)} on top of $${spentUsd.toFixed(2)} already spent would exceed the $${budgetUsd} cap — refusing to submit`);
  }
}

// Fetch-failure bookkeeping keyed by term id: a resumed sweep re-attempts every unfetched term,
// so a failure must REPLACE its earlier entry (the first USC resume reported 46 failures for 23
// terms) and a term that fetches on a later pass must drop off the list.
export function recordFetchFailure(state, entry) {
  state.fetchFailures = (state.fetchFailures ?? []).filter((f) => f.id !== entry.id);
  state.fetchFailures.push(entry);
}
export function clearFetchFailure(state, id) {
  state.fetchFailures = (state.fetchFailures ?? []).filter((f) => f.id !== id);
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
  // The control probe is created once per run so its TTL cache spans the whole sweep. Only the MO
  // source has a control section: USC citations resolve against a different host entirely, so a
  // usc run keeps the original cooldown behaviour rather than consulting an irrelevant control.
  const controlIsServing = args.source === 'mo'
    ? createControlProbe(fetchGlossSource)
    : async () => false;
  let identityErrors = 0;
  for (const term of candidates) {
    if (excerpts[term.id] || state.parked.includes(term.id)) continue;
    try {
      const { url, excerptText, hash } = await fetchGlossSource(term.citation);
      excerpts[term.id] = { url, excerptText, hash };
      clearFetchFailure(state, term.id);
      saveJson('excerpts.json', excerpts);
    } catch (err) {
      if (err instanceof MoBotPageError) {
        // Ask the control section whether the site is answering US before assuming anything about
        // THIS one. A clean control fetch is positive proof of service, so the target's bot page
        // means the section is not there and we can park in ~5s instead of ~600s. Anything else
        // and we do not know, so we take the original cooldown path unchanged.
        if (await controlIsServing()) {
          const note = `parked by gloss-batch-mo ${new Date().toISOString()}: revisor.mo.gov served its bot page for ${term.citation} WHILE simultaneously serving real text for the control section ${CONTROL_CITATION}, so the site was answering us and this section is not published - not rate limiting. Likely a bill-created section the Revisor does not serve yet. Unpark by setting status back to 'draft' if the section appears.`;
          await parkTerm(client, term, note);
          state.parked.push(term.id);
          saveJson('state.json', state);
          console.error(`PARKED ${term.citation} (control ${CONTROL_CITATION} served — no cooldown needed)`);
          continue;
        }
        console.error(`bot page on ${term.citation} AND on control ${CONTROL_CITATION} — treating as rate limiting, cooling down ${BOT_PAGE_COOLDOWN_MS / 60000} min, then ONE retry`);
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
        recordFetchFailure(state, { id: term.id, citation: term.citation, reason: `${err.name}: ${err.message}` });
        saveJson('state.json', state);
        if (identityErrors >= IDENTITY_ABORT_THRESHOLD) {
          throw new Error(`${identityErrors} identity errors — template-drift signal, aborting the sweep honestly rather than hammering ${candidates.length} pages`);
        }
      } else {
        recordFetchFailure(state, { id: term.id, citation: term.citation, reason: `${err.name}: ${err.message}` });
        saveJson('state.json', state);
      }
    }
  }
  const fetched = candidates.filter((t) => excerpts[t.id]);
  console.error(`fetched: ${fetched.length}; parked: ${state.parked.length}; fetch failures: ${state.fetchFailures.length}`);
  if (args.fetchOnly) { console.log(JSON.stringify({ fetched: fetched.length, parked: state.parked.length, failures: state.fetchFailures.length })); return; }

  // ---- budget guard before any submission: projected from THE BANK ON DISK, not a per-term rate.
  // Minimum path = author-1 over everything + verify over everything; each later batch re-checks
  // its own projection against what has actually been spent (assertWithinBudget) before submitting.
  const bankTexts = fetched.map((t) => excerpts[t.id].excerptText);
  const minimumPathUsd = projectBatchSpendUsd(AUTHOR_MODEL, bankTexts, { outputTokens: PROJECTION_AUTHOR_OUTPUT_TOKENS })
    + projectBatchSpendUsd(GLOSS_VERIFIER_MODEL, bankTexts, { outputTokens: PROJECTION_VERIFY_OUTPUT_TOKENS });
  const projectedRunUsd = minimumPathUsd * PROJECTION_RETRY_ALLOWANCE;
  console.error(`projected run (author-1 + verify over ${fetched.length} banked excerpts = $${minimumPathUsd.toFixed(2)}, x${PROJECTION_RETRY_ALLOWANCE} retry allowance): $${projectedRunUsd.toFixed(2)}; cap $${args.budgetUsd}; already spent $${spend.total.toFixed(2)}`);
  assertWithinBudget({ label: 'projected run', spentUsd: spend.total, projectedUsd: projectedRunUsd, budgetUsd: args.budgetUsd });

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
    if (!state.batches[round.label]) { // a resumed, already-submitted batch is sunk cost; only NEW submissions are gated
      assertWithinBudget({ label: round.label, spentUsd: spend.total, projectedUsd: projectBatchSpendUsd(round.model, pending.map((t) => excerpts[t.id].excerptText), { outputTokens: PROJECTION_AUTHOR_OUTPUT_TOKENS }), budgetUsd: args.budgetUsd });
    }
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
  const verifyTerms = fetched.filter((t) => authored.has(t.id));
  if (!state.batches.verify) {
    assertWithinBudget({ label: 'verify', spentUsd: spend.total, projectedUsd: projectBatchSpendUsd(GLOSS_VERIFIER_MODEL, verifyTerms.map((t) => excerpts[t.id].excerptText), { outputTokens: PROJECTION_VERIFY_OUTPUT_TOKENS }), budgetUsd: args.budgetUsd });
  }
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
