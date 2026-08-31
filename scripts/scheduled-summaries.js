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
  runBillChain, createCostTracker, classifyBillingError, assertPricesFresh,
} from '../src/lib/billed-summary-chain.js';
import { loadDraftObjections } from '../src/lib/draft-objections.js';
import { MAX_TEXT_CHARS } from '../src/lib/summarizer.js';
import { sessionRecencyKey } from '../src/lib/session-dates.js';
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
      // I9 (final whole-branch review): a crashed/stranded row must be charged AT LEAST the
      // code's own hard default (PER_TICK_CAP_USD), never the CALLER's possibly-lowered
      // perTickCapUsd. Without this, a today's throttled manual run (e.g. the I7 first-live-tick
      // procedure's SUMMARY_TICK_CAP_USD=0.10) would retroactively UNDER-charge a stranded row
      // from a PRIOR tick that actually ran under the real, unlowered $1.00 cap — Math.max is the
      // conservative direction, matching this function's own "unknown spend is treated as spent"
      // doctrine one step further (unknown spend is treated as the WORST plausible spend, not
      // today's incidental cap).
      spentUsd += Math.max(perTickCapUsd, PER_TICK_CAP_USD);
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

// I3 (final whole-branch review): worstBillUsd (above) is only ever as good as what THIS tick has
// already observed, and seeds at the tiny WORST_BILL_FLOOR_USD — at tick start, before any real
// bill has priced, the monster-headroom gate only required 1.5x that floor ($0.075) as headroom,
// even though a real ~400k-char monster's worst-case chain (author haiku 100k-tok in + 16k out;
// verify sonnet 100k in + 32k out; provisions sonnet 100k in + 4k out; coverage ~$0.05) costs
// ≈$0.99 — so a tick with as little as $0.08 of nominal remaining allowance could still start (and
// fully pay for) a bill costing up to ~$1, overshooting the weekly cap by up to a tick's worth.
// This estimator is a SECOND, ADDITIVE guard (the 1.5x-observed gate above is unchanged, per
// controller ruling) computed from the bill's text length ALONE — already in hand before any paid
// call, for every lane (fresh/conversion/monster), not just the monster one.
//
// Deliberately padded well above the real worst case:
//   input side  ≈ (chars/4/1e6) * (haiku-in-once-price + sonnet-in-price * 3-stages) — 4 chars/tok,
//                 haiku in $1/Mtok once (author) + sonnet in $2/Mtok x3 (verify/provisions/coverage,
//                 conservatively counted as if every sonnet stage re-paid for the full text, though
//                 coverage's real message is much smaller)
//   output side ≈ fixed ceilings, independent of bill size: haiku's own MAX_OUTPUT_TOKENS (16000)
//                 at $5/Mtok ≈ $0.08, plus sonnet's three fixed ceilings (32000+4000+3000 tokens)
//                 at $10/Mtok padded 1.5x for safety ≈ $0.585 (matches this file's own existing
//                 1.5x-safety-margin convention)
// A 400k-char bill: input ≈ (0.4/4)*7.0 = $0.70, + $0.665 output ceiling ≈ $1.365 — comfortably
// above the real ≈$0.99 worst case, which is the point (round the constant up for safety, never
// down).
export const COST_ESTIMATE_INPUT_MULTIPLIER = 1.0 + 2.0 * 3; // 7.0 — haiku-in-once + sonnet-in-x3
export const COST_ESTIMATE_OUTPUT_CEILING_USD = 0.08 + 0.585; // 0.665 — fixed, independent of size

export function estimateBillCostUsd(chars) {
  const inputUsd = (Number(chars) / 4 / 1e6) * COST_ESTIMATE_INPUT_MULTIPLIER;
  return inputUsd + COST_ESTIMATE_OUTPUT_CEILING_USD;
}

// I8 (final whole-branch review): the conversion lane used to examine EVERY draft-only bill EVERY
// tick, forever — each one costing a full bill_texts content fetch plus 3 draft-objections queries
// (summaries/summary_verifications/summary_notes), even for the (routine, expected) case where the
// draft has no verifications on file yet and is mechanically ineligible for this lane. With
// hundreds of draft-only bills on file, that is hundreds of DB reads spent every single tick just
// to re-discover the same routine ineligibility. Capped at a flat constant, applied where the
// conversions list is built (before assembleTick even sees it) — oldest-flagged-first ordering
// (already the sort order) is preserved, so which 50 get examined is stable and meaningful, not
// arbitrary.
export const MAX_CONVERSIONS_EXAMINED = 50;

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
  let planResult;
  try {
    // I5 (final whole-branch review): a throwing plan CLI (ETIMEDOUT/ENOBUFS/launch failure) used
    // to propagate straight out of runTick, crashing the whole tick BEFORE openRun ever ran —
    // nothing in LOG_DIR, nothing in ingestion_runs, and main() would exit 1, which reads
    // identically to a real scheduler crash in Task Scheduler's history. Caught here instead:
    // logged honestly, exit clean, try again tomorrow — mirrors the no-API-key honesty rationale
    // in main() below (:520-521 in the pre-fix file). 15 minutes (vs. the 8-minute
    // CHILD_TIMEOUT_MS default every other child in this repo uses) because this CLI's plan mode
    // loads every bills/votes/bill_texts/summaries row via loadPlanState's selectAll calls, not a
    // small per-source query.
    planResult = deps.runChildCliFn('src/cli/summary-queue.js', ['plan', '--dry-run'], { timeoutMs: 15 * 60 * 1000 });
  } catch (err) {
    deps.appendLog(`plan CLI failed: ${err.message} — skipping this tick`);
    return { outcome: 'plan-failed' };
  }
  const rawQueue = planResult?.parsed?.queue ?? [];
  const sessionStartByBill = await deps.loadSessionStartByBill();
  const unorderedQueued = rawQueue.filter((q) => !sessionStartByBill.has(q.bill_id)).length;
  if (unorderedQueued > 0) deps.appendLog(`WARNING: ${unorderedQueued} of ${rawQueue.length} queued bills have no session recency key (no start_date and no parseable session year) — they sort last; run src/cli/sync-session-dates.js`);
  const sortedQueue = sortQueueRecencyFirst(rawQueue, sessionStartByBill);
  // planQueue already excluded anything > MAX_TEXT_CHARS; this only splits what's left into
  // normal-sized (fresh) vs. oversize-but-summarizable (monster).
  const freshQueue = sortedQueue.filter((q) => (q.text_length ?? 0) <= MONSTER_THRESHOLD_CHARS);
  const monsterQueue = sortedQueue.filter((q) => (q.text_length ?? 0) > MONSTER_THRESHOLD_CHARS);

  const summaryRows = await deps.loadSummaryRows();
  const draftOnly = computeDraftOnly(summaryRows);
  // computeDraftOnly's Map carries no ordering guarantee; oldest-flag-first per spec. I8: capped
  // at MAX_CONVERSIONS_EXAMINED here, BEFORE assembleTick ever sees the list — the cheapest seam,
  // since every entry that reaches assembleTick is one this loop will pay a real bill_texts fetch
  // (and, unless routinely ineligible, 3 more objection queries) to examine.
  const conversions = [...draftOnly.entries()]
    .map(([billId, v]) => ({ bill_id: billId, rejectedCount: v.rejectedCount, draftRow: v.draftRow }))
    .sort((a, b) => String(a.draftRow.created_at ?? '').localeCompare(String(b.draftRow.created_at ?? '')))
    .slice(0, MAX_CONVERSIONS_EXAMINED);

  // I9-adjacent fix-in-passing (final whole-branch review, :503-510): readParked's real
  // implementation now distinguishes "no file yet" (safe: {}) from "file exists but could not be
  // read" (unknown — signaled as `null`, never treated as an empty park list to merge-write over;
  // see the writeParked call below and readParkedReal's own comment).
  const parkedRaw = deps.readParked();
  const parkedReadFailed = parkedRaw === null;
  const parked = parkedRaw ?? {};
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
  // Price-table freshness is checked HERE, before openRun, not inside the try below. createCostTracker
  // also asserts it (defence in depth), but by then a run row exists, and a throw would strand a
  // 'running' row that the next tick's ledger read counts as a FULL per-tick spend — so an expired
  // table would quietly eat the weekly cap and trip the stranded-run detector every morning. A
  // stale price is a reason to do nothing, which costs nothing and says so.
  try {
    assertPricesFresh();
  } catch (err) {
    return {
      outcome: 'skipped-prices-unverified',
      detail: err.message,
      allowance,
      weekKey,
      weeklySpent: weeklySpentUsd,
      lanes: [],
    };
  }

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
        // I3: conservative pre-bill estimate from the text length now in hand — before the
        // (cheap, unbilled) objections lookup below, let alone the first paid call.
        const estUsd = estimateBillCostUsd(textRow.content.length);
        if (!(allowance - tracker.spentUsd() > estUsd)) {
          skipped.push({ identifier: item.bill_id, reason: `pre-bill cost estimate $${estUsd.toFixed(4)} exceeds remaining allowance $${(allowance - tracker.spentUsd()).toFixed(4)} — skipped before any paid call` });
          continue;
        }
        const draftInfo = await deps.loadDraftObjectionsFn(deps.client, {
          draftId: draftRow.id, text: textRow.content, billId: item.bill_id,
        });
        if (draftInfo.hasVerifications === false || !draftInfo.objections || draftInfo.objections.length === 0) {
          // I8: routine, expected — hundreds of draft-only bills legitimately have no
          // verifications on file yet (that's a re-verify lane's job, not this one). Tagged
          // `routine: true` so it never forces the tick's status to 'partial' below.
          skipped.push({
            identifier: item.bill_id,
            reason: 'no objections/verifications on file for this draft — belongs to a re-verify lane, not conversion',
            routine: true,
          });
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
        // I3: pre-bill estimate from item.text_length — already in hand, no DB read needed to get
        // it, so this runs BEFORE loadTextRow (unlike the conversion lane, which only learns its
        // text length from that same read). A missing text_length is treated as the worst case
        // (MAX_TEXT_CHARS) rather than as free — never UNDER-estimate an unknown size.
        const estUsd = estimateBillCostUsd(item.text_length ?? MAX_TEXT_CHARS);
        if (!(allowance - tracker.spentUsd() > estUsd)) {
          skipped.push({ identifier: item.identifier ?? item.bill_id, reason: `pre-bill cost estimate $${estUsd.toFixed(4)} exceeds remaining allowance $${(allowance - tracker.spentUsd()).toFixed(4)} — skipped before any paid call` });
          continue;
        }
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
  // FIX-IN-PASSING (:387-389 in the pre-fix file): renamed from `flagged`/`rejected` — these are
  // the record CLI's own `gated` (mechanical-gate refusals: flagDraft) and `failures` (typed
  // pre-write rejects: malformed shape, hash mismatch, missing text) counts, not a moderation
  // "flag" or an editorial "rejection".
  let gateRefusals = 0;
  let recordFailures = 0;
  const parkedAdditions = {};

  async function recordLane(results, suffix, replaceDrafts) {
    if (results.length === 0) return; // nothing to record — no file, no spawn (test-verified)
    const filePath = path.join(RECORDS_DIR, `records-${runId}-${suffix}.json`);
    deps.writeRecordsFile(filePath, { results });
    const args = ['record', '--file', filePath];
    if (replaceDrafts) args.push('--replace-drafts');
    let cliResult;
    try {
      cliResult = deps.runChildCliFn('src/cli/summary-queue.js', args);
    } catch (err) {
      // I4 (final whole-branch review): a throwing runChildCliFn (ETIMEDOUT/ENOBUFS/launch
      // failure) used to propagate straight out of runTick — closeRun never ran, so the run row
      // stranded at 'running' with NO log line at all, indistinguishable from a genuine hard
      // crash but with none of that scenario's diagnostic trail. The records file is already on
      // disk (written above, before this call) either way — nothing is lost; the tick continues
      // to its own honest closeRun below instead of dying here.
      console.error(`record CLI (${suffix}) failed to launch/complete: ${err.message} — records file kept on disk at ${filePath}`);
      skipped.push({ identifier: `record-${suffix}`, reason: `record CLI (${suffix}) threw: ${err.message}` });
      return;
    }
    const parsed = cliResult?.parsed;
    if (!parsed) {
      // Recovery property: the records file stays on disk either way — nothing is lost.
      console.error(`record CLI (${suffix}) produced no parseable output (exit ${cliResult?.exitStatus ?? 'unknown'}) — records file kept on disk at ${filePath}`);
      return;
    }
    published += Number(parsed.counts?.published) || 0;
    gateRefusals += Number(parsed.counts?.gated) || 0;
    recordFailures += Number(parsed.counts?.failures) || 0;
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
    if (parkedReadFailed) {
      // Fix-in-passing (:503-510 in the pre-fix file): parked.json existed but could not be read
      // this tick — merge-writing now would silently DELETE every previously-parked bill's row
      // (a real money leak: each would quietly become re-eligible and re-attempted, spending real
      // budget re-discovering what was already mechanically proven unpublishable). Refuse the
      // write; the new park-worthy bill(s) simply get parked again on a future healthy tick.
      deps.appendLog(`parked.json was unreadable this tick — ${Object.keys(parkedAdditions).length} new park entry/entries NOT written to avoid clobbering the existing file`);
    } else {
      deps.writeParked({ ...parked, ...parkedAdditions });
    }
  }

  const spentUsd = tracker.spentUsd();
  // I8: routine, expected conversion-lane skips (a draft-only bill with no verifications on file
  // yet — see the `routine: true` tag above) must never force 'partial' on an otherwise healthy
  // tick that published everything it attempted; only a genuine anomaly (hash mismatch, oversize
  // text, an insufficient pre-bill estimate, a non-billing chain error, a crashed record CLI) does.
  const nonRoutineSkipped = skipped.filter((s) => !s.routine);
  const status = balanceDepleted || nonRoutineSkipped.length > 0 ? 'partial' : 'succeeded';
  const detail = {
    week_key: weekKey,
    spent_usd: Number(spentUsd.toFixed(4)),
    per_call_count: tracker.callLog.length,
    published,
    gate_refusals: gateRefusals,
    record_failures: recordFailures,
    parked: Object.keys(parkedAdditions).length,
    balance_depleted: balanceDepleted,
    lanes: { fresh: freshCount, conversion: conversionResults.length, monster: monsterCount },
    skipped,
  };
  await deps.closeRunFn(deps.client, runId, status, detail);

  // Fix-in-passing (:422-425 in the pre-fix file): `now` is the TICK-START timestamp (used above
  // for weekKey/parked_at, correctly) — the log line's own leading timestamp should reflect when
  // the tick actually finished, not when it started, since the two can differ by minutes.
  const finishedAt = deps.now();
  const newWeeklyTotal = weeklySpentUsd + spentUsd;
  const logLine = `${finishedAt.toISOString()} tick=${runId} attempted=${attempted} published=${published} `
    + `gate_refusals=${gateRefusals} spent=$${spentUsd.toFixed(4)} week=${weekKey} total=$${newWeeklyTotal.toFixed(4)}/${weeklyCapUsd.toFixed(2)}`
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

// Recency key per bill for sortQueueRecencyFirst: the session's real start_date, else the year
// parsed from the session's identifier/name (src/lib/session-dates.js sessionRecencyKey).
// Found 2026-08-21 (adversarial review of the session-dates fix): 30 of 31 MO sessions carried
// a NULL start_date, so this loader returned a key for almost no bill and the "recency-first"
// sort silently degraded to passage-then-smallest-first for every tick since the scheduler went
// live. The fallback keeps an undated session in its year; `src/cli/sync-session-dates.js`
// fills the dates from traceable sources. Bills whose session has neither a date nor a
// parseable year get no key (they sort last) and are counted on the returned Map's
// `unordered` property so the tick log can say so instead of hiding it.
export async function loadSessionStartByBillReal(client) {
  const { data: sessions, error: sErr } = await selectAll(client, 'sessions', 'id,identifier,name,start_date');
  if (sErr) throw new Error(`sessions lookup failed: ${sErr.message}`);
  const { data: bills, error: bErr } = await selectAll(client, 'bills', 'id,session_id');
  if (bErr) throw new Error(`bills lookup failed: ${bErr.message}`);
  const keyById = new Map((sessions ?? []).map((s) => [s.id, sessionRecencyKey(s)]));
  const out = new Map();
  let unordered = 0;
  let fallback = 0;
  for (const b of bills ?? []) {
    const k = keyById.get(b.session_id);
    if (k && k.key) { out.set(b.id, k.key); if (!k.dated) fallback += 1; } else unordered += 1;
  }
  Object.defineProperty(out, 'unordered', { value: unordered, enumerable: false });
  Object.defineProperty(out, 'fallback', { value: fallback, enumerable: false });
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

// Fix-in-passing (final whole-branch review, :503-510 in the pre-fix file): a bare catch here used
// to return {} for BOTH "no file yet" and "file exists but a transient read error occurred" — the
// caller's merge-write (`writeParked({ ...parked, ...parkedAdditions })`) would then silently wipe
// out every previously-parked bill's row on the SECOND case, quietly un-parking (and therefore
// re-attempting, spending real budget on) bills already mechanically proven unpublishable. ENOENT
// (genuinely nothing on disk, nothing to lose) is now distinguished from any other read/parse
// failure (park state UNKNOWN this tick) via the `null` sentinel — see runTickLocked, which never
// merge-writes over a `null` read.
function readParkedReal() {
  if (!existsSync(PARKED_PATH)) return {};
  try {
    return JSON.parse(readFileSync(PARKED_PATH, 'utf8'));
  } catch (err) {
    console.error(`parked.json unreadable (${err.message}) — treating park list as unknown this tick, will not overwrite it`);
    return null;
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
