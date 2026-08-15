// scripts/scheduled-summaries.js — pure decision core of the scheduled billed-summary pipeline.
// This script never calls the Anthropic API directly; it only computes which bills to summarize
// and in what order, based on weekly budget constraints, lane prioritization (fresh, conversions,
// monsters), and rejected-attempt tracking. The actual bill summarization (which DOES call the
// API) happens in a separate orchestration layer (main() and runTick(), added in Task 4).
//
// SAFETY DISCIPLINE — BILLED-CALLS CARVE-OUT:
//   - This file is PURE FUNCTIONS ONLY. No I/O, no state mutations, no side effects. All
//     business logic (budget math, queue ordering, lane assembly, draft tracking) is
//     deterministic and testable without a database or network.
//   - BILLED-CALLS CAP DISCIPLINE: The scheduler operates under two hard caps:
//     * WEEKLY_CAP_USD = 5.00 — maximum spend per ISO week (UTC, Thursday-anchored)
//     * PER_TICK_CAP_USD = 1.00 — maximum spend per tick (individual orchestration loop run)
//   - The caps are env-overridable via envCapUsd(), but DOWNWARD ONLY — a typo'd environment
//     variable can shrink spend, never grow it. This mirrors envIntervalMs's floor-only
//     discipline in scheduled-ingest.js, inverted: the env can only constrain, never relax.
//   - Crashed ticks (status='running' in ingestion_runs) are counted as full spend
//     (conservatively assume the worst), preventing budget bleed from stranded processes.
//
// WHAT BELONGS IN main()/runTick() (TASK 4):
//   - Lock file acquisition and release (single-instance guarantee, like scheduled-ingest.js)
//   - Reading live data from ingestion_runs and summary_queue tables
//   - Writing run rows to ingestion_runs (opening and closing them honestly)
//   - Invoking the billed summarizer for each bill in the assembled tick
//   - Honesty logging and error handling
//
// This pure-functions-first design makes the logic testable without hitting the database or API,
// and makes the orchestration layer (Task 4, below) a thin I/O wrapper around these decisions —
// runTick(deps) takes every dependency injected, so it is tested the same way
// tests/scheduled-ingest.test.js tests runChosenSource: real logic, fake client/lock/child-process.
//
// Entry: node --env-file=.env scripts/scheduled-summaries.js [--dry-run]

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  getClient, openRun, closeRun, selectAll,
} from '../src/lib/db.js';
import { acquireLock, releaseLock, runChildCli } from './scheduled-ingest.js';
import {
  runBillChain, createCostTracker, classifyBillingError,
} from '../src/lib/billed-summary-chain.js';
import { loadDraftObjections } from '../src/lib/draft-objections.js';
import { MAX_TEXT_CHARS } from '../src/lib/summarizer.js';
import { pickCurrentTextRow } from '../src/cli/summary-queue.js';

export const WEEKLY_CAP_USD = 5.00;
export const PER_TICK_CAP_USD = 1.00;
export const MONSTER_THRESHOLD_CHARS = 100000;

// Downward-only env override (spec: "env-overridable DOWNWARD only ... a typo can shrink spend,
// never grow it") — mirror of envIntervalMs's floor-only discipline, inverted.
export function envCapUsd(envVar, defaultUsd) {
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, defaultUsd) : defaultUsd;
}

// UTC ISO-8601 week key ('2026-W33') — Thursday-anchored per ISO 8601.
export function currentWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Weekly spend from ingestion_runs rows (caller pre-filters to source='scheduled-summaries',
// last 10 days). A row stranded at status='running' (crashed tick that never closed) is counted
// AS IF it spent the full per-tick allowance — unknown spend is treated as spent (spec).
export function summarizeWeekSpend(rows, weekKey, perTickCapUsd) {
  let spentUsd = 0;
  let crashedTicks = 0;
  for (const row of rows ?? []) {
    if (row.status === 'running') {
      spentUsd += perTickCapUsd;
      crashedTicks += 1;
      continue;
    }
    if (row.detail?.week_key === weekKey) spentUsd += Number(row.detail?.spent_usd) || 0;
  }
  return { spentUsd, crashedTicks };
}

export function tickAllowance({ weeklyCapUsd, weeklySpentUsd, perTickCapUsd }) {
  const remaining = weeklyCapUsd - weeklySpentUsd;
  return Math.max(0, Math.min(Number(remaining.toFixed(10)), perTickCapUsd));
}

// Recency-first ordering, ported from scripts/export-summary-wave.mjs (session start DESC →
// passage priority → text_length ASC; stable for ties).
export function sortQueueRecencyFirst(queue, sessionStartByBill) {
  return [...queue].sort((a, b) => {
    const sa = sessionStartByBill.get(a.bill_id) ?? '';
    const sb = sessionStartByBill.get(b.bill_id) ?? '';
    if (sa !== sb) return sb.localeCompare(sa);
    if (a.priority !== b.priority) return a.priority === 'passage' ? -1 : 1;
    return (a.text_length ?? Infinity) - (b.text_length ?? Infinity);
  });
}

// Draft-only reduction (same convention scripts/build-drain-wave.mjs applies: any
// published/approved row disqualifies the bill; last draft row wins) plus a rejected-attempt
// count for the spec's "skip ≥2 prior superseded/rejected attempts" rule.
export function computeDraftOnly(summaryRows) {
  const byBill = new Map();
  for (const s of summaryRows ?? []) {
    const list = byBill.get(s.bill_id) ?? [];
    list.push(s);
    byBill.set(s.bill_id, list);
  }
  const out = new Map();
  for (const [billId, rows] of byBill) {
    if (rows.some((r) => r.status === 'published' || r.status === 'approved')) continue;
    const drafts = rows.filter((r) => r.status === 'draft');
    if (drafts.length === 0) continue;
    out.set(billId, {
      draftRow: drafts[drafts.length - 1],
      rejectedCount: rows.filter((r) => r.status === 'rejected').length,
    });
  }
  return out;
}

// Lane assembly (spec order): fresh first, then conversions, then AT MOST ONE monster.
// Parked bills and conversions with >=2 prior rejected attempts never enter the tick.
export function assembleTick({ freshQueue, conversions, monsters, parkedIds }) {
  const out = [];
  for (const item of freshQueue ?? []) {
    if (!parkedIds.has(item.bill_id)) out.push({ lane: 'fresh', item });
  }
  for (const item of conversions ?? []) {
    if (parkedIds.has(item.bill_id)) continue;
    if (item.rejectedCount >= 2) continue;
    out.push({ lane: 'conversion', item });
  }
  for (const item of monsters ?? []) {
    if (parkedIds.has(item.bill_id)) continue;
    out.push({ lane: 'monster', item });
    break; // at most one per tick
  }
  return out;
}

// ============================================================
// Orchestration layer (Task 4) — lock, ledger, queue, per-bill chain, record, close, log.
// Everything above this line is pure; everything below does real I/O (fs, DB, child processes,
// the Anthropic API). runTick(deps) never touches a real client, lock file, or network call in a
// test — every dependency is injected; see tests/scheduled-summaries.test.js's fakeDeps() for the
// full fake surface. main() (bottom of file) wires the real ones.
// ============================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Computed from this file's own location, NEVER process.cwd() — same rationale as
// scheduled-ingest.js's REPO_ROOT (Task Scheduler's working directory is not guaranteed).
const REPO_ROOT = path.join(__dirname, '..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, '.superpowers', 'artifacts');
export const LOCK_PATH = path.join(ARTIFACTS_DIR, 'summary-scheduler.lock.json');
export const LOG_DIR = path.join(ARTIFACTS_DIR, 'summary-scheduler-logs');
export const RECORDS_DIR = path.join(ARTIFACTS_DIR, 'scheduled-summaries');
export const STAGE_DIR = path.join(RECORDS_DIR, 'stages');
export const PARKED_PATH = path.join(RECORDS_DIR, 'parked.json');

// 30 minutes: generous headroom for a full tick's worth of streamed calls (spec: "~25 streamed
// calls"). The lock's OWN declared duration, fixed and uniform per tick — unlike
// scheduled-ingest.js, there is no "chosen source" whose real timeout is only known after
// selection, so acquireLock's initial declaration here is already final (no
// updateLockMaxDuration call site exists in this file for that reason).
export const TICK_MAX_DURATION_MS = 30 * 60 * 1000;

// The conservative "smallest plausible bill" cost floor. An allowance below this cannot safely
// fund even the cheapest queued bill, so the tick ends before it opens a run row (spec: "allowance
// below the observed worst-case cost of the smallest queued bill"). Also seeds worstBillUsd's
// initial per-bill estimate before any real bill has been priced this tick — the same
// assume-the-worst-until-measured convention scripts/summary-probe-api.mjs uses.
export const WORST_BILL_FLOOR_USD = 0.05;

const AUTHOR_MODEL = 'claude-haiku-4-5';
const CHECKER_MODEL = 'claude-sonnet-5';

// runTick — one full tick: lock, ledger read, queue/lane assembly, the billed per-bill chain,
// records-file handoff to `summary-queue.js record`, an honest ingestion_runs close, and one
// dated log line.
export async function runTick(deps) {
  const lockResult = deps.acquireLockFn(LOCK_PATH, { maxRunDurationMs: TICK_MAX_DURATION_MS });
  if (!lockResult.acquired) {
    deps.appendLog(`already running (${lockResult.reason}) — skipping this tick`);
    return { outcome: 'already-running' };
  }
  try {
    return await runTickLocked(deps);
  } finally {
    // Always released, including on throw — ownership-checked (nonce) the same way
    // scheduled-ingest.js's own lock is, so this can never delete a lock it does not own.
    deps.releaseLockFn(LOCK_PATH, lockResult.nonce);
  }
}

async function runTickLocked(deps) {
  const now = deps.now();
  const weekKey = currentWeekKey(now);
  const perTickCapUsd = envCapUsd('SUMMARY_TICK_CAP_USD', PER_TICK_CAP_USD);
  const weeklyCapUsd = envCapUsd('SUMMARY_WEEKLY_CAP_USD', WEEKLY_CAP_USD);

  const recentRuns = await deps.selectRecentRuns();
  const { spentUsd: weeklySpentUsd } = summarizeWeekSpend(recentRuns, weekKey, perTickCapUsd);
  const allowance = tickAllowance({ weeklyCapUsd, weeklySpentUsd, perTickCapUsd });

  // Budget-exhausted exits BEFORE opening a run row — a skipped tick spends nothing and must not
  // pollute the ledger with a zero-spend row (spec).
  if (allowance < WORST_BILL_FLOOR_USD) {
    deps.appendLog(`budget exhausted for ${weekKey}`);
    return {
      outcome: 'budget-exhausted', weekKey, allowance, weeklySpentUsd,
    };
  }

  // ---- queue / lane assembly — all $0 (plan mode, DB reads, no API calls) ----
  const planResult = deps.runChildCliFn('src/cli/summary-queue.js', ['plan', '--dry-run']);
  const rawQueue = planResult?.parsed?.queue ?? [];
  const sessionStartByBill = await deps.loadSessionStartByBill();
  const sortedQueue = sortQueueRecencyFirst(rawQueue, sessionStartByBill);
  // planQueue already excluded anything > MAX_TEXT_CHARS; this only splits what's left into
  // normal-sized (fresh) vs. oversize-but-summarizable (monster).
  const freshQueue = sortedQueue.filter((q) => (q.text_length ?? 0) <= MONSTER_THRESHOLD_CHARS);
  const monsterQueue = sortedQueue.filter((q) => (q.text_length ?? 0) > MONSTER_THRESHOLD_CHARS);

  const summaryRows = await deps.loadSummaryRows();
  const draftOnly = computeDraftOnly(summaryRows);
  // computeDraftOnly's Map carries no ordering guarantee; oldest-flag-first per spec.
  const conversions = [...draftOnly.entries()]
    .map(([billId, v]) => ({ bill_id: billId, rejectedCount: v.rejectedCount, draftRow: v.draftRow }))
    .sort((a, b) => String(a.draftRow.created_at ?? '').localeCompare(String(b.draftRow.created_at ?? '')));

  const parked = deps.readParked() ?? {};
  const parkedIds = new Set(Object.keys(parked));

  const assembled = assembleTick({
    freshQueue, conversions, monsters: monsterQueue, parkedIds,
  });

  // --dry-run: everything above (real allowance, real queue, real lanes) has already run; stop
  // here — no Anthropic client is ever touched by this function, no run row, no record spawn.
  if (deps.dryRun) {
    return {
      outcome: 'dry-run',
      allowance,
      weekKey,
      weeklySpent: weeklySpentUsd,
      lanes: assembled.map((entry) => entry.item.bill_id),
    };
  }

  // ---- live path: openRun right after the allowance check passes, right before the first
  // possible paid call — a crash anywhere from here on leaves an honest 'running' row the next
  // tick's ledger read counts conservatively (as full per-tick spend). ----
  const runId = await deps.openRunFn();
  const tracker = createCostTracker();

  const freshResults = [];
  const conversionResults = [];
  const skipped = [];
  let freshCount = 0;
  let monsterCount = 0;
  let attempted = 0;
  let balanceDepleted = false;
  let worstBillUsd = WORST_BILL_FLOOR_USD;

  for (const { lane, item } of assembled) {
    // Budget guard: stop before starting a bill we can no longer safely afford.
    if (tracker.spentUsd() >= allowance - worstBillUsd) {
      console.error(`budget guard: stopping tick — spent $${tracker.spentUsd().toFixed(4)} of $${allowance.toFixed(4)} allowance`);
      break;
    }
    // The lone monster (assembleTick guarantees at most one) needs extra headroom — it is
    // consistently the most expensive call in a tick.
    if (lane === 'monster' && !(allowance - tracker.spentUsd() > 1.5 * worstBillUsd)) {
      skipped.push({
        identifier: item.identifier ?? item.bill_id,
        reason: 'insufficient headroom for a monster bill this tick (needs > 1.5x the worst-bill estimate)',
      });
      continue;
    }

    attempted += 1;
    const startSpend = tracker.spentUsd();
    try {
      if (lane === 'conversion') {
        const { draftRow } = item;
        const textRow = await deps.loadTextRow(item.bill_id);
        if (!textRow || textRow.content_hash !== draftRow.bill_text_hash) {
          skipped.push({ identifier: item.bill_id, reason: 'bill_texts hash mismatch vs. draft hash — skipped' });
          continue;
        }
        if (typeof textRow.content === 'string' && textRow.content.length > MAX_TEXT_CHARS) {
          skipped.push({ identifier: item.bill_id, reason: `bill text ${textRow.content.length} chars exceeds MAX_TEXT_CHARS (${MAX_TEXT_CHARS})` });
          continue;
        }
        const draftInfo = await deps.loadDraftObjectionsFn(deps.client, {
          draftId: draftRow.id, text: textRow.content, billId: item.bill_id,
        });
        if (draftInfo.hasVerifications === false || !draftInfo.objections || draftInfo.objections.length === 0) {
          skipped.push({ identifier: item.bill_id, reason: 'no objections/verifications on file for this draft — belongs to a re-verify lane, not conversion' });
          continue;
        }
        const hash8 = String(draftRow.bill_text_hash).slice(0, 8);
        const bill = {
          bill_id: item.bill_id,
          identifier: draftInfo.identifier ?? item.bill_id,
          title: draftInfo.title ?? null,
          bill_text_hash: draftRow.bill_text_hash,
        };
        const { envelope } = await deps.runBillChainFn(deps.anthropic, tracker, {
          bill,
          text: textRow.content,
          stageDir: STAGE_DIR,
          checkpointKey: `${item.bill_id}-${hash8}`,
          authorModel: AUTHOR_MODEL,
          checkerModel: CHECKER_MODEL,
          reAuthor: { priorSummary: draftInfo.priorSummary, objections: draftInfo.objections },
        });
        conversionResults.push(envelope);
      } else {
        // fresh or monster — the queue item IS already shaped like a `bill` (bill_id, identifier,
        // title, bill_text_hash), courtesy of summary-queue.js's planQueue.
        const textRow = await deps.loadTextRow(item.bill_id);
        if (!textRow || textRow.content_hash !== item.bill_text_hash) {
          skipped.push({ identifier: item.identifier ?? item.bill_id, reason: 'bill_texts hash mismatch vs. queue hash — skipped' });
          continue;
        }
        if (typeof textRow.content === 'string' && textRow.content.length > MAX_TEXT_CHARS) {
          skipped.push({ identifier: item.identifier ?? item.bill_id, reason: `bill text ${textRow.content.length} chars exceeds MAX_TEXT_CHARS (${MAX_TEXT_CHARS})` });
          continue;
        }
        const hash8 = String(item.bill_text_hash).slice(0, 8);
        const { envelope } = await deps.runBillChainFn(deps.anthropic, tracker, {
          bill: item,
          text: textRow.content,
          stageDir: STAGE_DIR,
          checkpointKey: `${item.bill_id}-${hash8}`,
          authorModel: AUTHOR_MODEL,
          checkerModel: CHECKER_MODEL,
        });
        freshResults.push(envelope);
        if (lane === 'fresh') freshCount += 1; else monsterCount += 1;
      }
    } catch (err) {
      if (classifyBillingError(err)) {
        balanceDepleted = true;
        deps.appendLog('BALANCE DEPLETED — reload required');
        break;
      }
      // Non-billing error: checkpoints already preserved whatever paid stages completed; skip
      // this bill honestly and keep going — one bad bill must never starve the rest of the tick.
      skipped.push({ identifier: item.identifier ?? item.bill_id, reason: err.message });
    } finally {
      // Probe convention: re-estimate the worst-case per-bill cost from what THIS bill actually
      // spent, so the budget guard above tightens as real prices come in rather than trusting the
      // floor for the whole tick.
      worstBillUsd = Math.max(worstBillUsd, (tracker.spentUsd() - startSpend) * 1.5);
    }
  }

  // ---- record: hand each non-empty lane's envelopes to summary-queue.js record ----
  let published = 0;
  let flagged = 0;
  let rejected = 0;
  const parkedAdditions = {};

  async function recordLane(results, suffix, replaceDrafts) {
    if (results.length === 0) return; // nothing to record — no file, no spawn (test-verified)
    const filePath = path.join(RECORDS_DIR, `records-${runId}-${suffix}.json`);
    deps.writeRecordsFile(filePath, { results });
    const args = ['record', '--file', filePath];
    if (replaceDrafts) args.push('--replace-drafts');
    const cliResult = deps.runChildCliFn('src/cli/summary-queue.js', args);
    const parsed = cliResult?.parsed;
    if (!parsed) {
      // Recovery property: the records file stays on disk either way — nothing is lost.
      console.error(`record CLI (${suffix}) produced no parseable output (exit ${cliResult?.exitStatus ?? 'unknown'}) — records file kept on disk at ${filePath}`);
      return;
    }
    published += Number(parsed.counts?.published) || 0;
    flagged += Number(parsed.counts?.gated) || 0;
    rejected += Number(parsed.counts?.failures) || 0;
    for (const failure of parsed.failures ?? []) {
      if (failure?.error === 'MalformedSummaryError' && failure.bill_id) {
        parkedAdditions[failure.bill_id] = { reason: failure.message ?? 'malformed summary', parked_at: now.toISOString() };
      }
    }
  }

  await recordLane(freshResults, 'fresh', false);
  await recordLane(conversionResults, 'drafts', true);

  // The budget must never re-pay for a bill a mechanical gate has already proven unpublishable.
  if (Object.keys(parkedAdditions).length > 0) {
    deps.writeParked({ ...parked, ...parkedAdditions });
  }

  const spentUsd = tracker.spentUsd();
  const status = balanceDepleted || skipped.length > 0 ? 'partial' : 'succeeded';
  const detail = {
    week_key: weekKey,
    spent_usd: Number(spentUsd.toFixed(4)),
    per_call_count: tracker.callLog.length,
    published,
    flagged,
    rejected,
    parked: Object.keys(parkedAdditions).length,
    balance_depleted: balanceDepleted,
    lanes: { fresh: freshCount, conversion: conversionResults.length, monster: monsterCount },
    skipped,
  };
  await deps.closeRunFn(deps.client, runId, status, detail);

  const newWeeklyTotal = weeklySpentUsd + spentUsd;
  const logLine = `${now.toISOString()} tick=${runId} attempted=${attempted} published=${published} `
    + `flagged=${flagged} spent=$${spentUsd.toFixed(4)} week=${weekKey} total=$${newWeeklyTotal.toFixed(4)}/${weeklyCapUsd.toFixed(2)}`
    + `${balanceDepleted ? ' [BALANCE DEPLETED]' : ''}`;
  deps.appendLog(logLine);

  return {
    outcome: 'ok', balanceDepleted, runId, weekKey, allowance, detail,
  };
}

// ============================================================
// main() — real dependency wiring. Untested directly (it is a thin assembly of already-tested
// pieces); tests exercise runTick's actual logic through fakeDeps() instead.
// ============================================================

async function selectRecentRunsReal(client) {
  const tenDaysAgoIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await selectAll(client, 'ingestion_runs', 'status,detail', {
    filter: (q) => q.eq('source', 'scheduled-summaries').gte('started_at', tenDaysAgoIso),
  });
  if (error) throw new Error(`ingestion_runs lookup failed: ${error.message}`);
  return data ?? [];
}

async function loadSessionStartByBillReal(client) {
  const { data: sessions, error: sErr } = await selectAll(client, 'sessions', 'id,start_date');
  if (sErr) throw new Error(`sessions lookup failed: ${sErr.message}`);
  const { data: bills, error: bErr } = await selectAll(client, 'bills', 'id,session_id');
  if (bErr) throw new Error(`bills lookup failed: ${bErr.message}`);
  const startById = new Map((sessions ?? []).map((s) => [s.id, s.start_date]));
  const out = new Map();
  for (const b of bills ?? []) {
    const start = startById.get(b.session_id);
    if (start) out.set(b.id, start);
  }
  return out;
}

async function loadSummaryRowsReal(client) {
  const { data, error } = await selectAll(client, 'summaries', 'id,bill_id,bill_text_hash,status,created_at');
  if (error) throw new Error(`summaries lookup failed: ${error.message}`);
  return data ?? [];
}

// loadTextRowReal — the "current" bill text for a bill (most recent retrieved_at), same reduction
// scripts/build-drain-wave.mjs and summary-queue.js's own record gate both apply; reused via
// pickCurrentTextRow rather than re-derived.
async function loadTextRowReal(client, billId) {
  const { data, error } = await client.from('bill_texts').select('bill_id,content,content_hash,retrieved_at').eq('bill_id', billId);
  if (error) throw new Error(`bill_texts lookup failed for ${billId}: ${error.message}`);
  return pickCurrentTextRow(data ?? []);
}

// loadDraftObjectionsReal — wraps the real loadDraftObjections(client, {draftId, text}) (unchanged
// signature) with a small bills lookup so the conversion lane's re-author call gets the bill's
// real identifier/title (loadDraftObjections itself never reads the bills table — its only job is
// reconstructing prior summary + objections from summaries/summary_verifications/summary_notes).
async function loadDraftObjectionsReal(client, { draftId, text, billId }) {
  const result = await loadDraftObjections(client, { draftId, text });
  const { data, error } = await client.from('bills').select('identifier,title').eq('id', billId).maybeSingle();
  if (error) throw new Error(`bills lookup failed for ${billId}: ${error.message}`);
  return { ...result, identifier: data?.identifier ?? billId, title: data?.title ?? null };
}

function writeRecordsFileReal(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(payload), 'utf8');
}

// appendLogReal — stderr for real-time visibility, plus the SAME line appended to a UTC-dated
// file under LOG_DIR (matches scheduled-ingest.js's writeLog day convention: the date comes from
// the line's own leading ISO-Z timestamp, not a fresh `new Date()`, so the file a line lands in
// can never drift from the timestamp printed inside it).
function appendLogReal(line) {
  console.error(line);
  mkdirSync(LOG_DIR, { recursive: true });
  const leading = String(line).slice(0, 10);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(leading) ? leading : new Date().toISOString().slice(0, 10);
  appendFileSync(path.join(LOG_DIR, `${day}.log`), `${line}\n`);
}

function readParkedReal() {
  if (!existsSync(PARKED_PATH)) return {};
  try {
    return JSON.parse(readFileSync(PARKED_PATH, 'utf8'));
  } catch {
    return {}; // corrupt/unreadable — never crash the tick over an optional park list
  }
}

function writeParkedReal(obj) {
  mkdirSync(path.dirname(PARKED_PATH), { recursive: true });
  writeFileSync(PARKED_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');

  // No ANTHROPIC_API_KEY (and not --dry-run): an unattended tick must not look like a scheduler
  // crash in Task Scheduler history — log honestly and exit 0, never process.exitCode.
  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    appendLogReal('ANTHROPIC_API_KEY not set — exiting without a tick');
    console.log(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }));
    return;
  }

  const client = getClient();
  if (!client) {
    appendLogReal('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — exiting without a tick');
    console.log(JSON.stringify({ error: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }));
    return;
  }

  // Constructed only when it can actually be used — dry-run never touches the Anthropic SDK at
  // all (step 9's "no Anthropic client is even constructed").
  const anthropic = dryRun ? null : new Anthropic();

  const report = await runTick({
    client,
    anthropic,
    now: () => new Date(),
    acquireLockFn: acquireLock,
    releaseLockFn: releaseLock,
    selectRecentRuns: () => selectRecentRunsReal(client),
    openRunFn: () => openRun(client, 'scheduled-summaries'),
    closeRunFn: closeRun,
    runChildCliFn: runChildCli,
    loadSessionStartByBill: () => loadSessionStartByBillReal(client),
    loadSummaryRows: () => loadSummaryRowsReal(client),
    loadTextRow: (billId) => loadTextRowReal(client, billId),
    loadDraftObjectionsFn: (c, opts) => loadDraftObjectionsReal(c, opts),
    runBillChainFn: runBillChain,
    writeRecordsFile: writeRecordsFileReal,
    appendLog: appendLogReal,
    readParked: readParkedReal,
    writeParked: writeParkedReal,
    dryRun,
  });

  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
