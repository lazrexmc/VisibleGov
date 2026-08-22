// sync-session-dates: fill NULL `sessions.start_date` for Missouri sessions from traceable sources.
//
//   node --env-file=.env src/cli/sync-session-dates.js            # dry-run: prints the plan, writes nothing
//   node --env-file=.env src/cli/sync-session-dates.js --apply    # writes start_date (fill-null only), records a run
//   options: --openstates-file <path>   use a saved OpenStates jurisdiction JSON instead of the live API
//                                       (pin the SAME payload for dry-run and --apply when it matters:
//                                       the run record carries the payload's sha256 either way)
//            --no-legiscan-check        skip the LegiScan-dataset corroboration of special-session starts
//
// Why (2026-08-21): 30 of 31 mo-legislature sessions had a NULL start_date, which silently turned
// BOTH recency-first consumers — scripts/export-summary-wave.mjs and the daily scheduler's
// sortQueueRecencyFirst — into arbitrary order for 95% of the ready-to-summarize queue. Sources
// and rules live in src/lib/session-dates.js (constitutional convening date for regular sessions;
// for specials the EARLIER of OpenStates' published start and the earliest recorded bill action in
// the session's own cached LegiScan dataset, guarded to the session's year). Every written value
// names its source, and the run record names the evidence (the bill/action/file a LegiScan date
// rests on, the sha256 of the OpenStates payload). Additive: never overwrites a non-null
// start_date; never writes end_date. Rows with no traceable source stay NULL and are listed.
//
// PRODUCER-SIDE NOTE: this is a backfill. The drivers that mint session rows (ingest-legiscan,
// ingest-mo-house, ingest-mo-senate) still write no start_date, so a session minted next January
// will be undated until this CLI is re-run (dry-run, review, --apply). Both consumers fall back to
// the session's name/identifier year meanwhile and report how many rows needed the fallback.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getClient, selectAll, openRun, closeRun } from '../lib/db.js';
import * as mo from '../adapters/mo-legislature.js';
import { planSessionDates } from '../lib/session-dates.js';
import { decodeDatasetZip, extractDatasetFiles } from '../adapters/legiscan-dataset.js';

export const SOURCE = 'sync-session-dates';
const LEGISCAN_CACHE_DIR = new URL('../../.superpowers/artifacts/legiscan-datasets/', import.meta.url);

export function parseArgs(argv) {
  const out = { apply: false, openstatesFile: null, legiscanCheck: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--openstates-file') {
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) throw new Error('--openstates-file requires a path');
      out.openstatesFile = v; i += 1;
    } else if (argv[i] === '--no-legiscan-check') out.legiscanCheck = false;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

// Earliest recorded bill-history entry across extractDatasetFiles's `bills` container ONLY (its
// real return shape is { bills, people, rollCalls, datasetHash, failures }; roll-call dates and
// failure records must never count). Accepts an array or a Map of bills, each either the bare
// LegiScan bill object or its {bill: {...}} wrapper. Returns { date, bill_number, action } so the
// plan can name the record a date rests on, or null when no dated history exists.
export function earliestHistoryDate(parsed) {
  let min = null;
  const visit = (bill) => {
    const b = bill?.bill ?? bill;
    for (const h of b?.history ?? []) {
      if (h?.date && (min == null || h.date < min.date)) min = { date: h.date, bill_number: b.bill_number ?? b.number ?? null, action: h.action ?? null };
    }
  };
  const bills = parsed?.bills;
  if (Array.isArray(bills)) bills.forEach(visit);
  else if (bills instanceof Map) bills.forEach(visit);
  return min;
}

// Earliest recorded bill action per LOCAL cached LegiScan dataset, keyed by legiscan_session_id,
// each carrying the file it came from. Read-only, $0, no network: the cache is the decoded
// dataset the ingest already verified by hash. Every file that contributes nothing is REPORTED
// in `skipped` (unparseable, missing zip/session_id, undecodable, no dated history) — never
// dropped silently. Several cache files can exist for one session (re-fetched datasets with new
// hashes); the minimum wins and any disagreement between files is reported in `disagreements`.
export async function legiscanEarliestActions(cacheDir = LEGISCAN_CACHE_DIR) {
  const dirPath = typeof cacheDir === 'string' ? cacheDir : fileURLToPath(cacheDir);
  const out = new Map();
  const skipped = [];
  const disagreements = [];
  if (!existsSync(dirPath)) return { bySessionId: out, skipped: [{ reason: `no cache dir at ${dirPath}` }], disagreements };
  for (const f of readdirSync(dirPath).filter((n) => n.endsWith('.json')).sort()) {
    let env;
    try { env = JSON.parse(readFileSync(`${dirPath}/${f}`, 'utf8')); } catch (err) { skipped.push({ file: f, reason: err.message }); continue; }
    if (!env?.zip || env.session_id == null) { skipped.push({ file: f, reason: 'envelope has no zip or session_id' }); continue; }
    try {
      const parsed = await extractDatasetFiles(decodeDatasetZip(env.zip));
      const earliest = earliestHistoryDate(parsed);
      if (!earliest) { skipped.push({ file: f, reason: 'no dated bill history in dataset' }); continue; }
      const sid = Number(env.session_id);
      const rec = { ...earliest, file: f };
      const prior = out.get(sid);
      if (!prior) out.set(sid, rec);
      else if (prior.date !== rec.date) {
        disagreements.push({ session_id: sid, kept: prior.date < rec.date ? prior : rec, other: prior.date < rec.date ? rec : prior });
        if (rec.date < prior.date) out.set(sid, rec);
      }
    } catch (err) { skipped.push({ file: f, reason: err.message }); }
  }
  return { bySessionId: out, skipped, disagreements };
}

export async function fetchInputs(client, { openstatesFile = null, legiscanCheck = true } = {}, deps = {}) {
  const fetchSessions = deps.fetchSessions ?? mo.fetchSessions;
  const earliestActions = deps.legiscanEarliestActions ?? legiscanEarliestActions;
  const { data: rows, error } = await selectAll(client, 'sessions', 'id,jurisdiction_id,identifier,name,start_date,end_date,legiscan_session_id', { orderBy: 'identifier' });
  if (error) throw new Error(`sessions read failed: ${error.message}`);
  const openstatesJson = openstatesFile ? JSON.parse(readFileSync(openstatesFile, 'utf8')) : await fetchSessions();
  const openstates = mo.parseSessions(openstatesJson);
  if (openstates.length === 0) {
    throw new Error(`OpenStates returned no legislative_sessions (${openstatesFile ? `wrong --openstates-file ${openstatesFile}` : 'API key or response-shape problem'}) — refusing to plan without it`);
  }
  const openstatesSha256 = createHash('sha256').update(JSON.stringify(openstatesJson)).digest('hex');
  const legiscanEarliestAction = new Map();
  let legiscanSkipped = [];
  let legiscanDisagreements = [];
  if (legiscanCheck) {
    const { bySessionId, skipped, disagreements } = await earliestActions();
    legiscanSkipped = skipped;
    legiscanDisagreements = disagreements;
    for (const r of rows) if (r.legiscan_session_id != null && bySessionId.has(r.legiscan_session_id)) legiscanEarliestAction.set(r.id, bySessionId.get(r.legiscan_session_id));
  }
  return { rows, openstates, openstatesSha256, openstatesSource: openstatesFile ?? 'live v3.openstates.org', legiscanEarliestAction, legiscanSkipped, legiscanDisagreements };
}

// Applies the plan one row at a time with a guarded update (`.is('start_date', null)`) that
// RETURNS the affected row (`.select()`), so "written" means exactly "this call changed this
// row" — a row whose guard no longer matches (someone dated it between plan and apply) affects
// zero rows and is reported as a skip with the value it now carries, never overwritten. A
// failure throws with `partialResult` carrying the rows written/skipped so far and the patch
// that failed, so the run record can name exactly what was committed.
export async function executePlan(client, runId, plan) {
  const written = [];
  const skipped = [];
  const fail = (message, p) => Object.assign(new Error(message), { partialResult: { written: [...written], skipped: [...skipped], failed: { id: p.id, identifier: p.identifier, wanted: p.start_date } } });
  for (const p of plan.patches) {
    const { data: affected, error } = await client.from('sessions').update({ start_date: p.start_date }).eq('id', p.id).is('start_date', null).select('id,identifier,start_date');
    if (error) throw fail(`sessions update failed for ${p.identifier}: ${error.message}`, p);
    if (affected?.length === 1 && affected[0].start_date === p.start_date) {
      written.push({ id: p.id, identifier: p.identifier, start_date: p.start_date, source: p.source });
      continue;
    }
    const { data: now, error: readErr } = await client.from('sessions').select('id,identifier,start_date').eq('id', p.id).single();
    if (readErr) throw fail(`re-read failed for ${p.identifier}: ${readErr.message}`, p);
    skipped.push({ id: p.id, identifier: p.identifier, reason: `guard: row now carries start_date=${now?.start_date ?? null} (affected ${affected?.length ?? 0} rows)`, wanted: p.start_date });
  }
  return { written, skipped, run_id: runId };
}

export function summarize(args, inputs, plan) {
  return {
    mode: args.apply ? 'apply' : 'dry-run',
    rows: inputs.rows.filter((r) => r.jurisdiction_id === 'mo-legislature').length,
    patches: plan.patches.length,
    unchanged: plan.unchanged.length,
    unmatched: plan.unmatched.length,
    unclassified: plan.unclassified.length,
    corroboration: plan.corroboration,
    sources: Object.fromEntries([...new Set(plan.patches.map((p) => p.source))].map((s) => [s, plan.patches.filter((p) => p.source === s).length])),
    openstates: { source: inputs.openstatesSource, sessions: inputs.openstates.length, payload_sha256: inputs.openstatesSha256 },
    legiscan_cache: { skipped: inputs.legiscanSkipped.length, disagreements: inputs.legiscanDisagreements.length },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }
  const inputs = await fetchInputs(client, args);
  const plan = planSessionDates(inputs);
  const summary = summarize(args, inputs, plan);
  const planList = plan.patches.map((p) => ({ identifier: p.identifier, start_date: p.start_date, source: p.source, notes: p.notes }));
  if (!args.apply) {
    console.log(JSON.stringify({ ...summary, plan: plan.patches, unmatched: plan.unmatched, unclassified: plan.unclassified, legiscanSkipped: inputs.legiscanSkipped, legiscanDisagreements: inputs.legiscanDisagreements }, null, 2));
    return;
  }
  const runId = await openRun(client, SOURCE);
  let result;
  try {
    result = await executePlan(client, runId, plan);
  } catch (err) {
    // The original error and what was actually committed are printed FIRST; closing the run is
    // attempted separately so a closeRun failure can never mask either.
    const partial = err.partialResult ?? { written: [], skipped: [], failed: null };
    console.log(JSON.stringify({ ...summary, outcome: 'failed', error: err.message, ...partial, run_id: runId }, null, 2));
    try {
      await closeRun(client, runId, partial.written.length > 0 ? 'partial' : 'failed', { ...summary, written: partial.written, skipped: partial.skipped, failed: partial.failed, plan: planList, unmatched: plan.unmatched, error: err.message });
    } catch (closeErr) {
      console.error(`additionally, closing ingestion run ${runId} failed: ${closeErr.message}`);
    }
    throw err;
  }
  const detail = { ...summary, written: result.written.length, skipped: result.skipped, plan: planList, unmatched: plan.unmatched };
  console.log(JSON.stringify({ ...summary, written: result.written, skipped: result.skipped, unmatched: plan.unmatched, run_id: runId }, null, 2));
  try {
    await closeRun(client, runId, 'succeeded', detail);
  } catch (closeErr) {
    console.error(`writes succeeded (${result.written.length} written) but closing ingestion run ${runId} failed: ${closeErr.message}`);
    throw closeErr;
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
