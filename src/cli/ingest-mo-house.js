import {
  existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import {
  getClient, openRun, closeRun, insertIfAbsent, additivePatch, isMissingColumnError, isMissingRelationError,
} from '../lib/db.js';
import { SourceFetchError } from '../lib/errors.js';
import * as mo from '../adapters/mo-house-xml.js';
import * as pdf from '../adapters/mo-rollcall-pdf.js';

// Separate small CLI per task-4-brief.md ("Driver: a separate small CLI ... implementer's call,
// document it") rather than extending src/cli/ingest.js: this source has a fundamentally
// different cadence (30-minute mechanically-enforced limiter vs. the other adapters' sub-10s
// limiters) and a fetch-list-then-loop-per-item shape that doesn't fit ingest.js's existing
// one-collect-call-per-source pattern without complicating it for every other source.

const ROSTER_REPRESENTATIVE_FIXTURE = 'tests/fixtures/research/mo-house-xml/representative-107.xml';

// Task 4b: gitignored (.superpowers/), so this is safe to write to from a live run — see the
// "PERSISTENCE GATE" block below (persistRollCallCasts/replayArtifacts) for what lands here and
// why.
const ROLLCALL_ARTIFACT_DIR = '.superpowers/artifacts/mo-rollcalls';

export function parseMoHouseArgs(argv) {
  const out = {
    session: mo.DEFAULT_MO_HOUSE_SESSION, limit: 1, dryRun: false, billIdentifier: null, billXmlFile: null, rollcallPdfFile: null,
  };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
    const val = argv[i + 1];
    if (key === '--session') out.session = val;
    else if (key === '--limit') out.limit = Number(val);
    // Normalized (case/space-insensitive) so '--bill hb1800', '--bill HB1800', and
    // '--bill "HB 1800"' all resolve identically — matches entries[].identifier, which is
    // always produced via the same normalizeMoBillIdentifier call (parseMoBillList).
    else if (key === '--bill') out.billIdentifier = mo.normalizeMoBillIdentifier(val);
    else if (key === '--bill-xml-file') out.billXmlFile = val;
    // Same fixture-testing convention as --bill-xml-file (Task 4): reads a LOCAL PDF file instead
    // of live-fetching whatever pending roll-call PDF this invocation would otherwise process
    // (selectPendingPdf still runs — a real DB read, not a house.mo.gov request — this flag only
    // substitutes the byte source). Used this task to prove the full extract -> reconcile ->
    // resolve -> persist-or-gate cycle against the real fixture without spending a live PDF fetch.
    else if (key === '--rollcall-pdf-file') out.rollcallPdfFile = val;
    else throw new Error(`unknown flag: ${key}`);
    i += 2;
  }
  return out;
}

// ---- collection ----

export async function collectBillList(session) {
  const xmlText = await mo.fetchMoBillList(session);
  return mo.parseMoBillList(xmlText);
}

// Chooses which bill(s) get a per-bill detail fetch this invocation. --bill-xml-file reads a
// LOCAL file instead of a live fetch (never counts against moHouseLimiter) — used this task to
// prove the full bill-detail persistence cycle against an already-captured research fixture
// without spending the second live 30-minute-gated request (see task-4-report.md for why).
export function selectTargets(entries, args) {
  if (args.billXmlFile) {
    if (!args.billIdentifier) throw new Error('--bill-xml-file requires --bill <identifier>');
    return [{ identifier: args.billIdentifier, localFile: args.billXmlFile }];
  }
  if (args.billIdentifier) {
    const found = entries.find((e) => e.identifier === args.billIdentifier);
    if (!found) throw new Error(`bill ${args.billIdentifier} not found in fetched bill list`);
    return [{ identifier: found.identifier, bill_xml_url: found.bill_xml_url }];
  }
  // No documented way to know which bills have RollCall elements without having already
  // fetched their detail XML (BillList.XML carries no such signal) — list-order is the only
  // honest default for a first pass. A future overnight pass could prioritize bills not yet
  // enriched, once some detail has been fetched.
  return entries.slice(0, args.limit).map((e) => ({ identifier: e.identifier, bill_xml_url: e.bill_xml_url }));
}

// ---- durable, cross-process ToU cooldown ----
//
// moHouseLimiter (src/adapters/mo-house-xml.js) is an IN-MEMORY limiter: it only sequences
// fetches within a single process's lifetime. Bug found in review: a real double-fetch
// (~4 minutes apart) occurred when a second process (the controller's overnight driver) started
// shortly after this process had already exited — the new process's limiter had zero memory of
// the first process's fetch, so it fetched immediately, violating house.mo.gov's <=1 req/30min
// ToU. ingestion_runs is the durable, cross-process-visible record of "was a fetch recently
// made (or attempted)" — these two pure helpers plus enforceDurableCooldown below close that gap.

// Pure + testable without a DB: given the most recent run's started_at (ISO string) and the
// required minimum interval, how much longer must we wait (0 if the cooldown has elapsed, or if
// there is no prior run at all).
export function remainingCooldownMs(lastStartedAtIso, minIntervalMs, now = Date.now()) {
  if (!lastStartedAtIso) return 0;
  const elapsed = now - new Date(lastStartedAtIso).getTime();
  return Math.max(0, minIntervalMs - elapsed);
}

export function formatCooldownWait(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}m ${secs}s`;
}

// Queries the most recent source='mo-house-xml' ingestion_runs row REGARDLESS of status —
// an in-flight 'running' row (another process mid-fetch right now) must count too, not just a
// closed 'succeeded'/'failed' one, or two processes starting within the same instant could both
// pass the check. Waits out any remaining cooldown before returning; never aborts, never skips
// the check silently (a lookup failure is a hard error, not a swallowed skip).
//
// KNOWN RESIDUAL GAP (documented honestly, not fixed here — see task-4-report.md): two processes
// launched at the EXACT same instant could both query before either has inserted its own run
// row, and both pass. This closes the SEQUENTIAL gap the review found (processes minutes apart
// with no shared in-memory state) but is not a full distributed lock. Acceptable for a
// single-operator overnight driver; would need real locking (e.g. a Postgres advisory lock) for
// truly concurrent launches, which is out of scope for this fix.
export async function enforceDurableCooldown(client, minIntervalMs = mo.MO_HOUSE_MIN_INTERVAL_MS) {
  const { data, error } = await client
    .from('ingestion_runs')
    .select('started_at')
    .eq('source', 'mo-house-xml')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`mo-house cooldown lookup failed: ${error.message}`);
  if (!data) return; // no prior run recorded for this source at all — nothing to wait for
  const remaining = remainingCooldownMs(data.started_at, minIntervalMs);
  if (remaining > 0) {
    console.error(`[${new Date().toISOString()}] ToU cooldown: waiting ${formatCooldownWait(remaining)} (last fetch ${data.started_at})`);
    await new Promise((r) => setTimeout(r, remaining));
  }
}

// ---- persistence ----

async function ensureSessionRow(client, runId, session) {
  await insertIfAbsent(client, 'sessions', [{
    jurisdiction_id: 'mo-legislature', identifier: session, name: mo.MO_HOUSE_SESSION_NAME,
    start_date: null, end_date: null,
  }], 'jurisdiction_id,identifier');
  const { data, error } = await client.from('sessions').select('id')
    .eq('jurisdiction_id', 'mo-legislature').eq('identifier', session).single();
  if (error) throw new Error(`mo-house session lookup failed: ${error.message}`);
  return data;
}

// Additive: insertIfAbsent (upsert + ignoreDuplicates) never overwrites, so a stub row from a
// prior run is left untouched here — persistBillDetail (below) is the only place a bill's
// title/status/canonical_url ever get filled in, via an explicit additive patch.
async function persistBillStubs(client, runId, sessionRow, entries) {
  await insertIfAbsent(client, 'bills', entries.map((e) => ({
    session_id: sessionRow.id, identifier: e.identifier, title: null, status: null, canonical_url: null, run_id: runId,
  })), 'session_id,identifier');
}

// PLAYBOOK_DELTA §3.5 (additive/write-once): a bill already enriched by a prior per-bill fetch
// must never be silently clobbered by a re-fetch. additivePatch only fills currently-null
// fields; bill_actions/votes rely on insertIfAbsent's own unique-constraint dedup instead
// (unique(bill_id,action_date,description) / unique(source_key)) since those are append-only.
async function persistBillDetail(client, runId, sessionRow, parsed) {
  const { data: existing, error: selErr } = await client.from('bills')
    .select('id,title,status,canonical_url')
    .eq('session_id', sessionRow.id).eq('identifier', parsed.bill.identifier).maybeSingle();
  if (selErr) throw new Error(`bill lookup failed: ${selErr.message}`);

  const incoming = { title: parsed.bill.title || null, status: parsed.bill.status, canonical_url: parsed.bill.canonical_url };
  let billId;
  if (!existing) {
    const { data: inserted, error: insErr } = await client.from('bills')
      .insert({ session_id: sessionRow.id, identifier: parsed.bill.identifier, ...incoming, run_id: runId })
      .select('id').single();
    if (insErr) throw new Error(`bill insert failed: ${insErr.message}`);
    billId = inserted.id;
  } else {
    billId = existing.id;
    const patch = additivePatch(existing, incoming);
    if (Object.keys(patch).length > 0) {
      const { error: updErr } = await client.from('bills').update({ ...patch, run_id: runId }).eq('id', billId);
      if (updErr) throw new Error(`bill update failed: ${updErr.message}`);
    }
  }

  const datedActions = parsed.actions.filter((a) => a.date);
  const droppedActions = parsed.actions.length - datedActions.length;
  if (droppedActions > 0) console.error(`note: ${droppedActions} action(s) on ${parsed.bill.identifier} had no PubDate (bill_actions.action_date is not-null); not written`);
  await insertIfAbsent(client, 'bill_actions', datedActions.map((a) => ({
    bill_id: billId, action_date: a.date, description: a.description, run_id: runId,
  })), 'bill_id,action_date,description');

  const voteRows = mo.buildMoVoteRows(parsed.bill.identifier, parsed.rollcalls);
  await insertIfAbsent(client, 'votes', voteRows.map((v) => ({
    bill_id: billId, jurisdiction_id: 'mo-legislature', chamber: v.chamber, vote_date: v.vote_date,
    question: v.question, result: v.result, source_url: v.source_url, source_key: v.source_key, run_id: runId,
  })), 'source_key');

  return { bill_id: billId, actions: parsed.actions.length, rollcalls: parsed.rollcalls.length };
}

// ---- Task 4b: pending roll-call PDF queue ----
//
// No new queue table — "pending" is derived directly from DB state each invocation, the same
// convention dryRunReport/selectTargets already use for "pending bill XML" (title IS NULL). A
// `votes` row counts as a pending PDF when it carries a source_url (the RollCallPDF link,
// mo.buildMoVoteRows) and has neither vote_casts rows yet NOR an already-written gated artifact
// (see persistRollCallCasts below — an artifact on disk means this PDF was already extracted this
// gate-cycle; re-fetching it live every invocation until 0005 lands would waste the scarce 30-min
// budget on the same document over and over instead of making progress elsewhere).
//
// FIFO ordering: `votes` carries no created_at/sequence column, so there is no literal wall-clock
// "when did this become pending" to sort by. source_key ascending (embeds bill identifier + the
// roll-call's own ordinal within the bill, e.g. 'mo-house-xml-HB1800-4' — mo.buildMoVoteRows) is
// used as a stable, deterministic, reproducible proxy instead — not literal FIFO, documented
// honestly rather than silently assumed.
//
// PRIORITY over new bill work: main() checks selectPendingPdf BEFORE it would fetch a fresh bill
// from the list. Per task-4b-brief.md ("a bill's rollcall PDFs fetch in subsequent cooldown
// slots"), once a bill's XML reveals a PDF link, the immediately-FOLLOWING invocation(s) drain
// that backlog before this driver moves on to the next unfetched bill — so with N pending PDFs
// outstanding, this driver spends up to N cooldown slots on them before touching a new bill. Each
// invocation still processes exactly ONE document total (one PDF, OR — only once zero PDFs are
// pending — the existing bill-list+selectTargets path), matching "each cooldown slot processes
// ONE document" from the brief.
function artifactPath(sourceKey) {
  return `${ROLLCALL_ARTIFACT_DIR}/${sourceKey}.json`;
}

// Live-DB check while building this task caught a real bug in an earlier draft of this query:
// `jurisdiction_id='mo-legislature' AND source_url IS NOT NULL` is NOT specific to mo-house-xml
// roll-call PDFs — dozens of OpenStates-sourced 'mo-ocd-vote/...' rows in the SAME jurisdiction
// also carry a non-null source_url (an openstates.org bill-page link, never a PDF). Scoped instead
// to source_key's own 'mo-house-xml-' prefix (mo.buildMoVoteRows's actual, intentional naming
// convention) - the only reliable signal for "this row came from the mo-house-xml adapter."
async function listPendingRollCallPdfs(client) {
  const { data: candidates, error } = await client
    .from('votes')
    .select('id,source_key,source_url')
    .like('source_key', 'mo-house-xml-%')
    .not('source_url', 'is', null)
    .order('source_key', { ascending: true });
  if (error) throw new Error(`pending roll-call PDF lookup failed: ${error.message}`);
  const undone = (candidates ?? []).filter((v) => !existsSync(artifactPath(v.source_key)));
  if (undone.length === 0) return [];
  const { data: casted, error: castErr } = await client
    .from('vote_casts')
    .select('vote_id')
    .in('vote_id', undone.map((v) => v.id));
  if (castErr) throw new Error(`vote_casts lookup failed: ${castErr.message}`);
  const castedIds = new Set((casted ?? []).map((c) => c.vote_id));
  return undone.filter((v) => !castedIds.has(v.id));
}

export async function selectPendingPdf(client) {
  const pending = await listPendingRollCallPdfs(client);
  return pending[0] ?? null;
}

// ---- Task 4b: PERSISTENCE GATE (migration 0005 — legislators.mo_house_id) ----
//
// legislators has no dedicated surname column (only full_name) — parseMoRepresentative
// (mo-house-xml.js) builds full_name as "FirstName LastName", so "everything after the first
// space" is a best-effort reconstruction of the surname resolveMoRep needs, not the ingested
// surname itself. Correct for every roster entry observed so far (single-token first names);
// would misresolve a legislator with a multi-word first OR last name. A future migration adding
// legislators.surname (parallel to this task's own mo_house_id) would remove this gap — flagged
// honestly, not fixed here (out of scope for 4b; see task-4b-report.md).
async function loadMoRoster(client) {
  const { data, error } = await client.from('legislators').select('id,full_name,mo_house_id').not('mo_house_id', 'is', null);
  if (error) throw error; // caller checks isMissingColumnError(err, 'mo_house_id')
  return (data ?? []).map((r) => ({
    legislator_id: r.id,
    surname: String(r.full_name ?? '').trim().split(/\s+/).slice(1).join(' '),
    mo_house_id: r.mo_house_id,
  }));
}

// Extraction + reconciliation ALWAYS run in full regardless of the migration gate (per the plan's
// Global Constraints: "extraction + tests proceed fully"). Only resolution+persistence to
// `vote_casts` is gated — when legislators.mo_house_id doesn't exist yet, the reconciled
// tallies+casts are written to a JSON artifact instead of being discarded, so applying 0005 and
// re-running this driver is a trivial replay (see replayArtifacts below), never a live re-fetch.
async function persistRollCallCasts(client, runId, vote, parsed) {
  let roster;
  try {
    roster = await loadMoRoster(client);
  } catch (err) {
    if (!isMissingColumnError(err, 'mo_house_id')) throw err;
    mkdirSync(ROLLCALL_ARTIFACT_DIR, { recursive: true });
    writeFileSync(artifactPath(vote.source_key), JSON.stringify({
      vote_id: vote.id,
      source_key: vote.source_key,
      tallies: parsed.tallies,
      casts: parsed.casts,
      extracted_run_id: runId,
      note: 'legislators.mo_house_id column not found — migration 0005 (supabase/migrations/0005_mo_house_id.sql) '
        + 'not yet applied. Casts were extracted and RECONCILED (tallies verified) but not resolved/persisted to '
        + 'vote_casts. This driver retries loading the roster (and replays every queued artifact) on every '
        + 'subsequent invocation — once 0005 is applied, the next scheduled run drains this automatically.',
    }, null, 2));
    return {
      persisted: false, gated: true, resolved: 0, unresolved: parsed.casts.length,
      note: `gated on migration 0005 — extracted+reconciled casts written to ${artifactPath(vote.source_key)}`,
    };
  }
  const resolvedRows = [];
  const unresolved = [];
  for (const cast of parsed.casts) {
    const legislatorId = pdf.resolveMoRep(cast, roster);
    if (legislatorId) resolvedRows.push({ vote_id: vote.id, legislator_id: legislatorId, position: cast.position, run_id: runId });
    else unresolved.push(cast);
  }
  await insertIfAbsent(client, 'vote_casts', resolvedRows, 'vote_id,legislator_id');
  return {
    persisted: true, gated: false, resolved: resolvedRows.length, unresolved: unresolved.length,
    unresolvedSample: unresolved.slice(0, 10),
  };
}

// Drains any previously-gated artifacts. Pure DB + filesystem — no house.mo.gov request — so it is
// safe and cheap to attempt on EVERY invocation regardless of whether this slot ends up processing
// a document at all: this is what makes "apply 0005, then it just works next run" literally true
// rather than requiring a separate manual replay script.
async function replayArtifacts(client, runId) {
  if (!existsSync(ROLLCALL_ARTIFACT_DIR)) return { attempted: 0, replayed: 0, stillGated: false };
  const files = readdirSync(ROLLCALL_ARTIFACT_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return { attempted: 0, replayed: 0, stillGated: false };
  let roster;
  try {
    roster = await loadMoRoster(client);
  } catch (err) {
    if (!isMissingColumnError(err, 'mo_house_id')) throw err;
    return { attempted: files.length, replayed: 0, stillGated: true };
  }
  let replayed = 0;
  for (const file of files) {
    const artifact = JSON.parse(readFileSync(`${ROLLCALL_ARTIFACT_DIR}/${file}`, 'utf8'));
    const resolvedRows = [];
    for (const cast of artifact.casts) {
      const legislatorId = pdf.resolveMoRep(cast, roster);
      if (legislatorId) resolvedRows.push({ vote_id: artifact.vote_id, legislator_id: legislatorId, position: cast.position, run_id: runId });
    }
    // sequential (not Promise.all) is deliberate: small, infrequent artifact backlog, each write
    // independent — no need for parallel-fetch complexity here.
    await insertIfAbsent(client, 'vote_casts', resolvedRows, 'vote_id,legislator_id');
    unlinkSync(`${ROLLCALL_ARTIFACT_DIR}/${file}`);
    replayed += 1;
  }
  return { attempted: files.length, replayed, stillGated: false };
}

// One "document" for this invocation's cooldown slot: either a local fixture file (never a live
// request — Task 4b's live-verification budget is ZERO live PDF fetches, fixture-only) or a real
// fetch through pdf.fetchMoRollCallPdf, which shares mo-house-xml.js's own moHouseLimiter instance
// (same host, same durable ToU cooldown — see mo-rollcall-pdf.js's module comment).
async function processRollCallPdf(client, runId, vote, args) {
  let pdfBuffer;
  let mode;
  try {
    if (args.rollcallPdfFile) {
      pdfBuffer = readFileSync(args.rollcallPdfFile);
      mode = 'fixture';
      console.error(`[${new Date().toISOString()}] read roll-call PDF for ${vote.source_key} from local fixture (not a live request): ${args.rollcallPdfFile}`);
    } else {
      const arrayBuffer = await pdf.fetchMoRollCallPdf(vote.source_url);
      pdfBuffer = Buffer.from(arrayBuffer);
      mode = 'live';
      console.error(`[${new Date().toISOString()}] fetched roll-call PDF for ${vote.source_key} (live)`);
    }
  } catch (err) {
    if (!(err instanceof SourceFetchError)) throw err;
    return { source_key: vote.source_key, mode: 'failed', failure: { step: `rollcall pdf ${vote.source_key}`, message: err.message } };
  }

  let parsed;
  try {
    const text = await pdf.extractRollCallText(pdfBuffer);
    parsed = pdf.parseMoRollCall(text);
  } catch (err) {
    if (!(err instanceof pdf.RollCallParseError)) throw err;
    // THE INTEGRITY GATE: a roll call that doesn't reconcile is NEVER stored — recorded as a
    // failure (skip != empty), not silently dropped, not persisted.
    return { source_key: vote.source_key, mode, failure: { step: `rollcall parse ${vote.source_key}`, message: err.message } };
  }

  const persistResult = await persistRollCallCasts(client, runId, vote, parsed);
  return {
    source_key: vote.source_key, mode, tallies: parsed.tallies, castCount: parsed.casts.length, ...persistResult,
  };
}

// Roster ingestion this task is FIXTURE-SOURCED, not live: the live budget for this task is
// AT MOST ONE live fetch (the bill-list XML) per the controller dispatch — a live
// MemberList.XML + per-district RepresentativeXML fetch is a future overnight-loop pass, not
// this run. Exercises the real mo_house_id migration-0005 gate against whatever the live DB
// schema actually is right now (skip != empty: a missing column is reported honestly, never
// silently swallowed).
async function persistRoster(client, runId) {
  const repXml = readFileSync(ROSTER_REPRESENTATIVE_FIXTURE, 'utf8');
  const roster = [mo.parseMoRepresentative(repXml)];
  const rows = roster.map((r) => ({ full_name: r.full_name, mo_house_id: r.mo_house_id, party: r.party, run_id: runId }));
  try {
    await insertIfAbsent(client, 'legislators', rows, 'mo_house_id');
    return {
      attempted: rows.length, persisted: rows.length, skipped: false,
      note: `fixture-sourced roster seed (${ROSTER_REPRESENTATIVE_FIXTURE}) — live per-district roster fetch is a future overnight-loop pass, not this task's live budget`,
    };
  } catch (err) {
    if (isMissingColumnError(err, 'mo_house_id')) {
      return {
        attempted: rows.length, persisted: 0, skipped: true,
        note: 'legislators.mo_house_id column not found — migration 0005 (supabase/migrations/0005_mo_house_id.sql) not yet applied; member persistence skipped this run. bills/actions/votes are unaffected.',
      };
    }
    throw err;
  }
}

// --dry-run makes ZERO live fetches (fix: previously it still made the live bill-list fetch).
// Reports from DB state only: how many bill stub rows already exist for this session, and how
// many still need per-bill enrichment (title IS NULL is exactly the stub-vs-enriched signal
// persistBillStubs/persistBillDetail already produce — no separate tracking needed).
export async function dryRunReport(client, session) {
  const { data: sessionRow, error: sessErr } = await client.from('sessions')
    .select('id,identifier,name')
    .eq('jurisdiction_id', 'mo-legislature').eq('identifier', session).maybeSingle();
  if (sessErr) {
    if (isMissingRelationError(sessErr, 'sessions')) {
      return { counts: null, note: 'sessions table not found (migration not yet applied) — no DB state to report; zero live fetches made' };
    }
    throw new Error(`dry-run session lookup failed: ${sessErr.message}`);
  }
  if (!sessionRow) {
    return {
      counts: { bills_total: 0, bills_needing_enrichment: 0 },
      note: `no sessions row yet for identifier=${session} (no live run has happened yet); counts come from the DB, not a live list — zero live fetches made`,
    };
  }
  const { count: total, error: totalErr } = await client.from('bills')
    .select('id', { count: 'exact', head: true }).eq('session_id', sessionRow.id);
  if (totalErr) throw new Error(`dry-run bills count failed: ${totalErr.message}`);
  const { count: needingEnrichment, error: needErr } = await client.from('bills')
    .select('id', { count: 'exact', head: true }).eq('session_id', sessionRow.id).is('title', null);
  if (needErr) throw new Error(`dry-run bills-needing-enrichment count failed: ${needErr.message}`);
  return {
    counts: { bills_total: total ?? 0, bills_needing_enrichment: needingEnrichment ?? 0 },
    note: 'counts computed from DB state only — zero live fetches made this invocation, per --dry-run',
  };
}

// ---- main ----

async function main() {
  const args = parseMoHouseArgs(process.argv.slice(2));
  // Fetched even under --dry-run's early-return branch is now GONE (fix): the client is needed
  // either way (dry-run reads DB state; live reads+writes), but no live fetch happens before we
  // know which branch we're in.
  const client = getClient();

  if (args.dryRun) {
    if (!client) {
      console.log(JSON.stringify({
        mode: 'dry-run', source: 'mo-house-xml', counts: null,
        note: 'no DB client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset) — cannot report DB state; zero live fetches made',
      }, null, 2));
      return;
    }
    const report = await dryRunReport(client, args.session);
    console.log(JSON.stringify({ mode: 'dry-run', source: 'mo-house-xml', ...report }, null, 2));
    return;
  }

  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  // Cross-process durable cooldown check happens BEFORE we even open our own run row — see
  // enforceDurableCooldown's own comment block for why (an in-flight row must be visible).
  await enforceDurableCooldown(client);

  // openRun is now called BEFORE the bill-list fetch (previously it was called AFTER — the bug
  // the review caught: a run row that only appears once a fetch already happened is invisible
  // to another process's cooldown check for as long as the fetch takes). Its started_at
  // (schema default now() at INSERT time) is therefore a close proxy for "when this process's
  // first house.mo.gov request happened" — safe because: (1) it's durable and
  // cross-process-visible, unlike moHouseLimiter's in-memory state; (2) if anything fails between
  // this insert and the actual fetch, the cooldown still counts it — conservative, better to
  // over-wait than risk violating the ToU; (3) it reflects FETCH time, not run-CLOSE time —
  // using finished_at instead would be wrong, since a run that loops over several per-bill
  // fetches can stay open far longer than any single fetch, which would make a next run's
  // cooldown check under-wait if it referenced finished_at.
  //
  // KNOWN RESIDUAL GAP: within a single process making MULTIPLE live fetches (--limit > 1, no
  // --bill-xml-file), only the FIRST fetch's timing is captured by started_at — a third process
  // starting mid-loop would see a stale started_at and could under-wait relative to that
  // process's most recent (not first) fetch. In practice this driver has so far only ever made
  // one live document fetch per invocation (see task-4-report.md); running it as short-lived,
  // --limit 1 invocations spaced externally (e.g. a scheduler re-launching the process every
  // ~30 min) sidesteps the gap entirely and is the recommended operational pattern.
  const runId = await openRun(client, 'mo-house-xml');
  try {
    // Pure DB + filesystem — no house.mo.gov request — safe to attempt every invocation
    // regardless of which branch below actually runs this slot (see replayArtifacts's own
    // comment for why this is what makes "apply 0005, next run just works" literally true).
    const artifactReplay = await replayArtifacts(client, runId);

    // Task 4b queue priority: an explicit --bill/--bill-xml-file targets a specific bill directly
    // (bypasses the PDF queue — the operator asked for that bill, honor it). Otherwise, a pending
    // roll-call PDF (a votes row with a pdf_url and no casts yet) takes priority over fetching a
    // NEW bill this slot — see listPendingRollCallPdfs's own comment for the FIFO/priority
    // rationale. This invocation processes exactly ONE document either way: one roll-call PDF, or
    // (only when zero are pending) the existing bill-list + selectTargets bill-XML path below.
    const wantsExplicitBill = Boolean(args.billIdentifier || args.billXmlFile);
    const pendingPdf = wantsExplicitBill ? null : await selectPendingPdf(client);
    if (pendingPdf) {
      const result = await processRollCallPdf(client, runId, pendingPdf, args);
      const failures = result.failure ? [result.failure] : [];
      const counts = { document_type: 'rollcall-pdf', artifact_replay: artifactReplay, failures: failures.length };
      const status = failures.length === 0 ? 'succeeded' : 'partial';
      await closeRun(client, runId, status, { counts, rollCallResult: result, failures });
      console.log(JSON.stringify({
        mode: 'live', run_id: runId, status, counts, rollCallResult: result, failures,
      }, null, 2));
      if (failures.length > 0) process.exitCode = 2;
      return;
    }

    const listXml = await mo.fetchMoBillList(args.session);
    console.error(`[${new Date().toISOString()}] fetched bill-list XML (session ${args.session})`);
    const entries = mo.parseMoBillList(listXml);
    const targets = selectTargets(entries, args);

    const sessionRow = await ensureSessionRow(client, runId, args.session);
    await persistBillStubs(client, runId, sessionRow, entries);
    const roster = await persistRoster(client, runId);

    const billResults = [];
    const failures = [];
    for (const target of targets) {
      let xmlText;
      let mode;
      try {
        if (target.localFile) {
          xmlText = readFileSync(target.localFile, 'utf8');
          mode = 'fixture';
          console.error(`[${new Date().toISOString()}] read bill XML ${target.identifier} from local fixture (not a live request): ${target.localFile}`);
        } else {
          xmlText = await mo.fetchMoBillXml(target.bill_xml_url);
          mode = 'live';
          console.error(`[${new Date().toISOString()}] fetched bill XML ${target.identifier} (live)`);
        }
      } catch (err) {
        if (!(err instanceof SourceFetchError)) throw err;
        failures.push({ step: `bill xml ${target.identifier}`, message: err.message });
        continue;
      }
      const parsed = mo.parseMoBillXml(xmlText);
      const result = await persistBillDetail(client, runId, sessionRow, parsed);
      billResults.push({ identifier: target.identifier, mode, ...result });
    }

    const counts = {
      document_type: 'bill-xml', bills_listed: entries.length, bills_detailed: billResults.length,
      failures: failures.length, roster, artifact_replay: artifactReplay,
    };
    const status = failures.length === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { counts, billResults, failures, roster });
    console.log(JSON.stringify({ mode: 'live', run_id: runId, status, counts, billResults, failures }, null, 2));
    if (failures.length > 0) process.exitCode = 2;
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
