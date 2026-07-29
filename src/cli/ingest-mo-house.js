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
//
// COEXISTENCE POLICY (Task 8 of docs/superpowers/plans/2026-07-29-legiscan-bulk-adapter.md,
// REVISED by Task 7's evidence — controller ruling appended to .superpowers/sdd/2026-07-29-
// legiscan-bulk-adapter/task-8-brief.md): LegiScan (src/cli/ingest-legiscan.js, Task 9) becomes
// PRIMARY for MO backfill generally — a fraction of the query cost of this XML/PDF path for
// ordinary bills. Task 7 (docs/research/2026-07-29-legiscan-substitute-vehicles.md,
// VERIFIED-BY-PAYLOAD, SENATE-SIDE ONLY) found LegiScan's own schema structurally cannot
// attribute one roll call to more than one sibling bill_id (`ls_bill_vote.bill_id` is a single
// scalar FK) and proved a real Senate case where LegiScan has ZERO record of a genuine
// individually-recorded vote for either sibling bill. Whether the MO HOUSE has an equivalent
// combined-vehicle mechanism, and whether this driver carries the same completeness exposure the
// Senate journals pipeline (ingest-mo-senate.js) does, is UNKNOWN — not yet evidenced either way.
// This is deliberately NOT decided here: Task 10 (a per-chamber count comparison) gathers the
// first evidence before any House-side demotion or completeness-critical call is made. Until then
// this driver is functionally UNCHANGED by this policy — same 30-minute ToU-driven cadence, same
// parsing/reconcile-or-throw internals. crossCheckAgainstPrimarySource (src/adapters/legiscan-
// votes.js, Task 6) runs from the LegiScan ingestion side and looks up whatever this driver has
// already written — the cross-check happens automatically whenever LegiScan ingestion runs, no new
// scheduled job needed. DISPLAY-TIME DEDUP RULE for downstream consumers (Plan 3, not built here;
// CONTROLLER RULING 3): when the same real floor vote legitimately exists twice — a LegiScan row
// and a primary-source row here, different source_keys — the primary-source row wins for display
// whenever both exist for the same (chamber, date, bill, tallies); see the matching comment in
// src/adapters/legiscan-votes.js beside PRIMARY_SOURCE_KEY_PREFIXES. The cross-check flags
// (vote_reconciliation_flags) already make the correspondence visible; this is a display-layer
// convention, not a data-integrity mechanism.

const ROSTER_REPRESENTATIVE_FIXTURE = 'tests/fixtures/research/mo-house-xml/representative-107.xml';

// Task 4b: gitignored (.superpowers/), so this is safe to write to from a live run — see the
// "PERSISTENCE GATE" block below (persistRollCallCasts/replayArtifacts) for what lands here and
// why.
const ROLLCALL_ARTIFACT_DIR = '.superpowers/artifacts/mo-rollcalls';

// Task fix-mo-enrichment: per-bill "has this bill left the needs-enrichment set" marker, and the
// bill-list fetch cache — see the two dedicated comment blocks below (ahead of
// selectTargets/hasEnrichedMarker and the bill-list-cadence helpers) for the live-verified bug
// these fix and why each is shaped this way.
const MO_BILLS_ARTIFACT_DIR = '.superpowers/artifacts/mo-bills';
const MO_BILL_LIST_ARTIFACT_DIR = '.superpowers/artifacts/mo-bill-list';

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

// ---- Task fix-mo-enrichment: per-bill enrichment-target tracking ----
//
// BUG FOUND LIVE (root-caused, not just hypothesized — see fix-mo-enrichment-report.md for the
// full evidence trail): selectTargets's default branch used to be `entries.slice(0, args.limit)`
// with ZERO enrichment-state awareness — every invocation re-selected the exact same first
// `limit` bills in BillList.XML's own document order, forever, regardless of whether they'd
// already been fetched+persisted. HB 2 is entry #1 in the real live list (session 261 has no
// HB 1), so with the driver's default --limit 1, EVERY invocation without an explicit --bill
// fetched HB 2 again. Live ingestion_runs evidence: of 12 real half-hour slots
// (2026-07-28T04:50Z-10:54Z), 11 fetched 'HB 2' and only 2 runs ever wrote a new title anywhere
// (one via an explicit-bill invocation that seeded HB 1800, one an orphaned high-limit run whose
// ingestion_runs row was left status='running' with finished_at null) — 10
// consecutive slots made zero enrichment progress. additivePatch (persistBillDetail below) was
// ALREADY correctly wired (verified: it's been called here since this file's first commit) and
// correctly prevented HB 2's title from being clobbered on refetch #2 onward — the bug was never
// "title stays null forever" (HB 2's real fixture DOES parse a non-empty LongTitle, verified
// directly against tests/fixtures/research/mo-house-xml/HB2-bill-text-pdf-only.xml), it was purely
// that selectTargets never advanced past the bills it had already finished.
//
// FIX: track "has this bill left the needs-enrichment set" via a per-bill marker artifact
// (hasEnrichedMarker/writeEnrichedMarker below) instead of any DB-column signal. Considered and
// REJECTED: keying off "bills having NO bill_actions rows" (derivable purely from existing DB
// state, no new artifact needed) — rejected because persistBillDetail's own
// `datedActions = parsed.actions.filter((a) => a.date)` (below) already proves a real bill CAN
// have zero bill_actions rows despite a fully successful enrichment cycle: any Action element
// without a PubDate is dropped before insertIfAbsent ever runs (see the `droppedActions` log line
// in persistBillDetail). A bill whose only action(s) happened to lack a PubDate would show zero
// bill_actions rows forever and reproduce the EXACT SAME false-forever-pending bug this fix exists
// to close, just moved from "title" to "bill_actions". Both real captured fixtures (HB 2: 1 dated
// action; HB 1800: 26/26 dated) happen to have every action dated, but that is not a documented
// guarantee of the source XML (the schema doc does not mark PubDate as required) — an assumption
// this fix does not need to make. A file-presence-driven marker (same idiom as this file's own
// ROLLCALL_ARTIFACT_DIR / *.failed.json quarantine — gitignored, trivially inspectable, and
// operator-resettable by deleting one file) sidesteps that risk entirely: it is written once,
// unconditionally, after a bill's fetch+parse+persist cycle completes, independent of what fields
// or child rows that cycle did or didn't end up writing.
function enrichedMarkerPath(identifier, dir) {
  return `${dir}/${String(identifier).replace(/\s+/g, '')}.json`;
}

export function hasEnrichedMarker(identifier, dir = MO_BILLS_ARTIFACT_DIR) {
  return existsSync(enrichedMarkerPath(identifier, dir));
}

// Called once, right after a bill's fetch+parse+persist cycle completes successfully (main(),
// below) — deliberately unconditional on what persistBillDetail's patch/action/vote counts turned
// out to be, per the rejected-alternative note above.
export function writeEnrichedMarker(identifier, meta = {}, dir = MO_BILLS_ARTIFACT_DIR) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(enrichedMarkerPath(identifier, dir), JSON.stringify({
    identifier, enriched_at: new Date().toISOString(), ...meta,
  }, null, 2));
}

// One-time migration helper (NOT called from main()'s normal per-invocation path — see
// fix-mo-enrichment-report.md for how/when this was actually run): bills enriched by a live run
// BEFORE this marker mechanism existed already carry a non-null `title` in the DB but have no
// marker file yet, so selectTargets would still reselect each of them exactly once more (harmless
// — additivePatch again produces an empty patch — but still a wasted cooldown slot). Backfilling
// a marker for every already-title-filled bill closes that gap without needing a live fetch: pure
// DB read (`bills.title IS NOT NULL`) plus local marker writes. Idempotent — safe to run any
// number of times (hasEnrichedMarker only cares about file presence; writeEnrichedMarker just
// refreshes the timestamp on an existing marker).
export async function backfillEnrichedMarkers(client, sessionId, dir = MO_BILLS_ARTIFACT_DIR) {
  const { data, error } = await client.from('bills').select('identifier')
    .eq('session_id', sessionId).not('title', 'is', null);
  if (error) throw new Error(`backfillEnrichedMarkers lookup failed: ${error.message}`);
  for (const row of data ?? []) writeEnrichedMarker(row.identifier, { backfilled: true }, dir);
  return { backfilled: (data ?? []).length };
}

// Chooses which bill(s) get a per-bill detail fetch this invocation. --bill-xml-file reads a
// LOCAL file instead of a live fetch (never counts against moHouseLimiter) — used this task to
// prove the full bill-detail persistence cycle against an already-captured research fixture
// without spending the second live 30-minute-gated request (see task-4-report.md for why).
// --bill and --bill-xml-file are explicit operator overrides — deliberately NOT filtered by the
// enriched-marker check below (an operator asking for a specific bill by name is honored,
// including a deliberate re-fetch of an already-enriched one).
export function selectTargets(entries, args, dir = MO_BILLS_ARTIFACT_DIR) {
  if (args.billXmlFile) {
    if (!args.billIdentifier) throw new Error('--bill-xml-file requires --bill <identifier>');
    return [{ identifier: args.billIdentifier, localFile: args.billXmlFile }];
  }
  if (args.billIdentifier) {
    const found = entries.find((e) => e.identifier === args.billIdentifier);
    if (!found) throw new Error(`bill ${args.billIdentifier} not found in fetched bill list`);
    return [{ identifier: found.identifier, bill_xml_url: found.bill_xml_url }];
  }
  // No documented way to PRIORITIZE among not-yet-enriched bills (BillList.XML carries no
  // "has RollCall elements" signal) — list-order is still the honest default ordering. What
  // changed (the actual fix): bills that have ALREADY completed an enrichment cycle
  // (hasEnrichedMarker) are excluded before slicing to --limit, so this driver advances through
  // the backlog instead of reselecting the same already-done bill(s) forever.
  const pending = entries.filter((e) => !hasEnrichedMarker(e.identifier, dir));
  return pending.slice(0, args.limit).map((e) => ({ identifier: e.identifier, bill_xml_url: e.bill_xml_url }));
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

// FINAL-REVIEW FIX (convergence race): a typed, dedicated error for enforceDurableCooldown's
// "never converged" case — never mistaken for the plain lookup-failed Error above, and carries
// the iteration count for debugging. Thrown only if the loop below truly never converges, which
// per its own comment should be impossible under normal operation.
export class CooldownConvergenceError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'CooldownConvergenceError';
    Object.assign(this, meta);
  }
}

async function queryLastMoHouseRunStartedAt(client) {
  const { data, error } = await client
    .from('ingestion_runs')
    .select('started_at')
    .eq('source', 'mo-house-xml')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`mo-house cooldown lookup failed: ${error.message}`);
  return data ? data.started_at : null; // null = no prior run recorded for this source at all
}

// Queries the most recent source='mo-house-xml' ingestion_runs row REGARDLESS of status —
// an in-flight 'running' row (another process mid-fetch right now) must count too, not just a
// closed 'succeeded'/'failed' one, or two processes starting within the same instant could both
// pass the check. Waits out any remaining cooldown before returning; never aborts, never skips
// the check silently (a lookup failure is a hard error, not a swallowed skip).
//
// FINAL-REVIEW FIX (convergence race): the original implementation read ingestion_runs ONCE,
// slept out whatever remaining cooldown that single read implied, then returned unconditionally.
// Two processes starting within the same cooldown window would both read the same last
// started_at, compute the same remaining wait, sleep to the same wake time, and BOTH proceed
// without ever re-checking — the exact double-fetch this whole mechanism exists to prevent, just
// moved from "no shared state at all" (the original bug this file already fixed once) to "shared
// state read once, then trusted stale."
//
// Fixed by LOOPING: after every sleep, re-query ingestion_runs from scratch and recompute
// `remaining` against that FRESH read. Only a fresh read showing remaining <= 0 is allowed to let
// this process proceed. If a different process claimed the slot mid-sleep (a newer started_at now
// exists), the fresh read reflects that — an equal-or-larger remaining wait — and this loops
// again. Capped at maxIterations (default 10) as a sanity backstop: each iteration either
// proceeds or discovers a strictly-newer started_at, and wall-clock time only moves forward, so
// convergence within a handful of checks is a near-certainty under normal operation; never
// converging within maxIterations means something is actually wrong (clock skew, a
// corrupted/future-dated started_at) — that must fail loud, not spin forever.
//
// KNOWN RESIDUAL GAP (documented honestly, not fixed here — see task-4-report.md /
// task-4b-report.md): two processes whose FRESH final reads land at the EXACT same instant (both
// observe remaining <= 0 before either has inserted its own new run row) could still both pass.
// This loop closes the "stale shared read" gap above; it is still not a full distributed lock.
// Acceptable for a single-operator overnight driver; would need real locking (e.g. a Postgres
// advisory lock) for truly concurrent launches, which is out of scope for this fix.
//
// sleep is injected (defaults to a real setTimeout-based wait) purely for testability — a unit
// test can stub it to resolve instantly while still observing the requested wait durations and
// the number of fresh re-checks performed.
export async function enforceDurableCooldown(
  client,
  minIntervalMs = mo.MO_HOUSE_MIN_INTERVAL_MS,
  { sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), maxIterations = 10 } = {},
) {
  for (let attempt = 1; attempt <= maxIterations; attempt += 1) {
    const lastStartedAt = await queryLastMoHouseRunStartedAt(client);
    const remaining = remainingCooldownMs(lastStartedAt, minIntervalMs);
    if (remaining <= 0) return; // fresh read confirms the cooldown has elapsed — safe to proceed
    console.error(`[${new Date().toISOString()}] ToU cooldown: waiting ${formatCooldownWait(remaining)} (last fetch ${lastStartedAt}, re-check ${attempt}/${maxIterations})`);
    await sleep(remaining);
  }
  throw new CooldownConvergenceError(
    `mo-house cooldown did not converge after ${maxIterations} fresh re-checks — this should be `
      + 'impossible in normal operation (see enforceDurableCooldown\'s own comment); failing loud '
      + 'rather than looping forever',
    { maxIterations, minIntervalMs },
  );
}

// ---- Task fix-mo-enrichment: bill-list refetch cadence ----
//
// BUG FOUND LIVE: main() used to unconditionally re-fetch the entire BillList.XML on every
// invocation before ever reaching the per-bill fetch. Both fetches share the SAME in-process
// moHouseLimiter instance (house.mo.gov's <=1 req/30min ToU, mechanically enforced) — so the
// second (per-bill) fetch of every single invocation had to wait out a FULL second 30-minute
// interval after the first (list) fetch completed. Live proof (ingestion_runs, this source): every
// started_at/finished_at pair is exactly 30 minutes apart (e.g. 10:24:22 -> 10:54:22) — each
// invocation spent its ENTIRE cooldown slot on this one redundant list re-fetch, roughly HALVING
// how many bills this driver can process per hour. The list only regenerates upstream on its own
// schedule (LastTimeRun timestamps in the research fixture cluster around :01 and :30 past the
// hour) — re-fetching it every 30 minutes was never buying freshness, only burning budget.
//
// FIX: cache the parsed list to a local artifact with a fetch timestamp; only re-fetch live once
// that cache is >= MO_BILL_LIST_MAX_AGE_MS old (60 min — comfortably covers the upstream refresh
// cadence with margin, without needing to introspect house.mo.gov's own regeneration schedule
// precisely). A stale-by-up-to-an-hour list is harmless here: persistBillStubs's writes are
// purely additive (insertIfAbsent), and any bill genuinely new since the last live fetch is picked
// up on the next refresh, at most an hour later.
export const MO_BILL_LIST_MAX_AGE_MS = 60 * 60 * 1000;

function billListCachePath(session, dir) {
  return `${dir}/${session}.json`;
}

// Pure + testable without touching the filesystem or mocking a clock in the caller: given the ISO
// timestamp of the last cached list fetch (or null/undefined if none exists yet), is a fresh live
// fetch required this invocation? Mirrors remainingCooldownMs's own "no prior => must proceed"
// convention.
export function shouldRefetchBillList(lastFetchIso, maxAgeMs = MO_BILL_LIST_MAX_AGE_MS, now = Date.now()) {
  if (!lastFetchIso) return true;
  return (now - new Date(lastFetchIso).getTime()) >= maxAgeMs;
}

export function readCachedBillList(session, dir = MO_BILL_LIST_ARTIFACT_DIR) {
  const p = billListCachePath(session, dir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null; // a corrupt/partial cache file must never crash the driver — treated as "no cache"
  }
}

export function writeCachedBillList(session, entries, dir = MO_BILL_LIST_ARTIFACT_DIR) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(billListCachePath(session, dir), JSON.stringify({
    session, fetched_at: new Date().toISOString(), entries,
  }, null, 2));
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
// Exported (Task fix-mo-enrichment) so the additivePatch wiring itself can be pinned directly with
// a stubbed client, not just exercised indirectly through main() — see
// tests/mo-house-xml.test.js's "persistBillDetail: fills a null title..." tests.
export async function persistBillDetail(client, runId, sessionRow, parsed) {
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

// ---- FINAL-REVIEW FIX: failing-PDF quarantine ----
//
// Bug found in whole-branch review: a PDF that persistently fails extraction/reconciliation
// (RollCallParseError) was never recorded anywhere durable — listPendingRollCallPdfs had no way
// to know a source_key had already been tried and failed, so it sorted first (source_key
// ascending) FOREVER and got a fresh LIVE re-fetch every single cooldown slot, permanently
// wedging the queue behind one bad document instead of making progress on the rest of the
// backlog.
//
// Fix: a failure writes a `<source_key>.failed.json` artifact to the SAME artifacts dir as the
// success/gate artifact (artifactPath above) — same directory, different suffix, so the two never
// collide and both are visible side by side for a human to inspect. Each artifact tracks an
// `attempts` counter that INCREMENTS (never resets) across repeated failures of the same
// source_key. Once attempts reaches ROLLCALL_MAX_FAILED_ATTEMPTS, excludeQuarantinedPdfs
// permanently excludes that source_key from the live queue — "permanently" only in the sense that
// nothing in this driver ever deletes the file; an operator can always delete it by hand to
// re-enable a retry (e.g. after a code fix lands for a parsing gap the PDF exposed). That is a
// deliberate, cheap, file-presence-driven "reset" rather than a dedicated CLI flag or DB column.
//
// THRESHOLD (3): below 3 attempts, retry is allowed — a single failure (or two) is plausibly a
// transient hiccup (a momentarily malformed fetch, a not-actually-broken layout quirk), and
// house.mo.gov's own 30-min cooldown already spaces retries far apart, so retrying costs little.
// At 3 independent LIVE attempts on 3 separate cooldown slots all failing the SAME document,
// "transient" stops being a credible explanation — this is a genuinely bad PDF (or a real parser
// gap) that will not resolve itself, and continuing to burn the scarce 30-min budget on it instead
// of the rest of the backlog is the actual bug this fixes.
export const ROLLCALL_MAX_FAILED_ATTEMPTS = 3;

function failedArtifactPath(dir, sourceKey) {
  return `${dir}/${sourceKey}.failed.json`;
}

// dir is injectable (defaults to the real ROLLCALL_ARTIFACT_DIR) purely so this and
// writeFailureArtifact/excludeQuarantinedPdfs can be unit-tested against a scratch directory
// without touching the real gitignored artifacts dir a live driver process may be using
// concurrently.
export function readFailureArtifact(sourceKey, dir = ROLLCALL_ARTIFACT_DIR) {
  const p = failedArtifactPath(dir, sourceKey);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function writeFailureArtifact(sourceKey, pdfUrl, err, dir = ROLLCALL_ARTIFACT_DIR) {
  const existing = readFailureArtifact(sourceKey, dir);
  const attempts = (existing ? existing.attempts : 0) + 1;
  mkdirSync(dir, { recursive: true });
  const record = {
    source_key: sourceKey,
    pdf_url: pdfUrl,
    error: { name: err.name, message: err.message },
    failed_at: new Date().toISOString(),
    attempts,
  };
  writeFileSync(failedArtifactPath(dir, sourceKey), JSON.stringify(record, null, 2));
  return record;
}

// Pure filter, directly unit-tested (no DB required): drops any candidate whose .failed.json has
// reached ROLLCALL_MAX_FAILED_ATTEMPTS. listPendingRollCallPdfs below is a thin DB-querying
// wrapper around this. Returns skippedKeys (not just a count) — re-review flagged that a bare
// count gives an operator no way to know WHICH document(s) are quarantined without going and
// listing the artifacts dir by hand; the keys are cheap to carry through and make the log
// line/run-detail actually actionable.
export function excludeQuarantinedPdfs(candidates, dir = ROLLCALL_ARTIFACT_DIR) {
  const skippedKeys = [];
  const kept = candidates.filter((v) => {
    const failure = readFailureArtifact(v.source_key, dir);
    if (failure && failure.attempts >= ROLLCALL_MAX_FAILED_ATTEMPTS) {
      skippedKeys.push(v.source_key);
      return false;
    }
    return true;
  });
  return { kept, skippedFailed: skippedKeys.length, skippedKeys };
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
  if (undone.length === 0) return { pending: [], skippedFailed: 0, skippedKeys: [] };
  const { kept, skippedFailed, skippedKeys } = excludeQuarantinedPdfs(undone);
  if (skippedFailed > 0) {
    console.error(`[${new Date().toISOString()}] roll-call PDF queue: skipping ${skippedFailed} permanently-failing PDF(s): ${skippedKeys.join(', ')} (>= ${ROLLCALL_MAX_FAILED_ATTEMPTS} failed attempts — see *.failed.json in ${ROLLCALL_ARTIFACT_DIR})`);
  }
  if (kept.length === 0) return { pending: [], skippedFailed, skippedKeys };
  const { data: casted, error: castErr } = await client
    .from('vote_casts')
    .select('vote_id')
    .in('vote_id', kept.map((v) => v.id));
  if (castErr) throw new Error(`vote_casts lookup failed: ${castErr.message}`);
  const castedIds = new Set((casted ?? []).map((c) => c.vote_id));
  return { pending: kept.filter((v) => !castedIds.has(v.id)), skippedFailed, skippedKeys };
}

// Returns { next, skippedFailed, skippedKeys }: next is the highest-priority still-eligible
// pending PDF (or null if none), skippedFailed/skippedKeys describe what the quarantine above
// excluded. Both are surfaced by main() into run detail even on an invocation that ends up
// processing a different document entirely (see the FINDING 2 fix note in main()).
export async function selectPendingPdf(client) {
  const { pending, skippedFailed, skippedKeys } = await listPendingRollCallPdfs(client);
  return { next: pending[0] ?? null, skippedFailed, skippedKeys };
}

// ---- Task 4b: PERSISTENCE GATE (migrations 0005 — legislators.mo_house_id, 0006 — surname) ----
//
// FIX ROUND (review finding): the first draft of this function reconstructed a roster surname by
// taking "everything after the first space" in legislators.full_name — for a legislator with a
// multi-word FIRST name, that produces a WRONG surname (not merely "fragile"), which would then
// never match that legislator's real printed surname in any roll call. The real fix, not just a
// documented caveat: legislators.surname (migration 0006) now carries the source XML's own
// <LastName> element straight through (parseMoRepresentative, mo-house-xml.js -> persistRoster
// above) — verified against the real fixture, tests/fixtures/research/mo-house-xml/
// representative-107.xml: '<LastName>Matthiesen</LastName><FirstName>Mark</FirstName>'.
//
// The heuristic below survives ONLY as a fallback for a row that somehow has surname=null despite
// the column existing (e.g. a legacy row inserted before 0006/before persistRoster started
// populating it) — reconstructSurnameHeuristic is exported and unit-tested directly
// (tests/mo-house-xml.test.js) to pin down exactly what it gets right (single-token first names)
// and wrong (multi-word first names), and resolveMoRep's own exact-match semantics guarantee that
// a wrong reconstructed surname simply fails to match any cast's real printed surname rather than
// misattributing a vote — so even in the fallback case, the affected cast lands in unresolved[]
// (persistRollCallCasts/replayArtifacts), never silently dropped. See
// 'resolveMoRep: a roster surname reconstructed via the full_name fallback heuristic misses a
// legislator with a multi-word first name (recorded unresolved, never silently dropped)' in
// tests/mo-rollcall-pdf.test.js for the end-to-end proof of that claim.
export function reconstructSurnameHeuristic(fullName) {
  return String(fullName ?? '').trim().split(/\s+/).slice(1).join(' ');
}

async function loadMoRoster(client) {
  const { data, error } = await client.from('legislators').select('id,full_name,surname,mo_house_id').not('mo_house_id', 'is', null);
  if (error) throw error; // caller checks isRosterGateError
  return (data ?? []).map((r) => ({
    legislator_id: r.id,
    surname: r.surname || reconstructSurnameHeuristic(r.full_name),
    mo_house_id: r.mo_house_id,
  }));
}

// Two independent columns can gate loadMoRoster now (0005's mo_house_id, 0006's surname) — either
// missing means "roster isn't queryable yet," same treatment either way.
function isRosterGateError(err) {
  return isMissingColumnError(err, 'mo_house_id') || isMissingColumnError(err, 'surname');
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
    if (!isRosterGateError(err)) throw err;
    mkdirSync(ROLLCALL_ARTIFACT_DIR, { recursive: true });
    writeFileSync(artifactPath(vote.source_key), JSON.stringify({
      vote_id: vote.id,
      source_key: vote.source_key,
      tallies: parsed.tallies,
      casts: parsed.casts,
      extracted_run_id: runId,
      note: 'legislators.mo_house_id and/or legislators.surname column not found — migrations 0005 '
        + '(supabase/migrations/0005_mo_house_id.sql) and 0006 (supabase/migrations/0006_legislators_surname.sql) '
        + 'not yet (both) applied. Casts were extracted and RECONCILED (tallies verified) but not resolved/persisted '
        + 'to vote_casts. This driver retries loading the roster (and replays every queued artifact) on every '
        + 'subsequent invocation — once both migrations are applied, the next scheduled run drains this automatically.',
    }, null, 2));
    return {
      persisted: false, gated: true, resolved: 0, unresolved: parsed.casts.length,
      note: `gated on migration 0005/0006 — extracted+reconciled casts written to ${artifactPath(vote.source_key)}`,
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
// a document at all: this is what makes "apply the migrations, then it just works next run" true
// rather than requiring a separate manual replay script.
//
// FIX ROUND (review finding): the first draft deleted an artifact after ANY replay attempt,
// regardless of whether every cast actually resolved — a cast that failed resolveMoRep (roster
// gap, not a migration gate) was silently dropped with no count, no sample, no log line, and the
// file was gone so there was nothing left to even notice from. Fixed: unresolved casts from each
// artifact are now collected and returned (parity with persistRollCallCasts's own
// {resolved,unresolved,unresolvedSample} shape), logged per-artifact, AND the artifact is kept on
// disk (same path — NOT renamed, since listPendingRollCallPdfs's "already extracted, don't
// live-refetch" check depends on that exact filename continuing to exist) with `partial: true` and
// its `casts` trimmed down to only the STILL-unresolved ones, so the next replay only re-attempts
// what's left rather than redoing already-resolved work. An artifact is only deleted once a replay
// resolves everything in it.
//
// FIX ROUND (re-review, final-review hardening): a plain `f.endsWith('.json')` filter also
// matches the `<source_key>.failed.json` quarantine artifacts writeFailureArtifact writes
// (Finding 2 above) — '.failed.json'.endsWith('.json') is true. Those carry no `casts` field at
// all, so `for (const cast of artifact.casts)` below threw an UNCAUGHT TypeError
// ("artifact.casts is not iterable") on every single invocation of this driver from the moment
// ANY PDF had failed even once — a total outage, and one that would only get WORSE the moment
// migrations 0005/0006 land (this function runs unconditionally, every invocation, regardless of
// the gate). Fixed by excluding `.failed.json` explicitly, not just incidentally.
//
// dir is injectable (defaults to the real ROLLCALL_ARTIFACT_DIR) and this is now exported purely
// so it can be unit-tested against a scratch directory without touching the real gitignored
// artifacts dir a live driver process may be using concurrently — same convention as
// readFailureArtifact/writeFailureArtifact/excludeQuarantinedPdfs above.
export async function replayArtifacts(client, runId, dir = ROLLCALL_ARTIFACT_DIR) {
  const empty = {
    attempted: 0, replayed: 0, stillGated: false, unresolved: 0, unresolvedSample: [],
  };
  if (!existsSync(dir)) return empty;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.failed.json'));
  if (files.length === 0) return empty;
  let roster;
  try {
    roster = await loadMoRoster(client);
  } catch (err) {
    if (!isRosterGateError(err)) throw err;
    return { ...empty, attempted: files.length, stillGated: true };
  }
  let replayed = 0;
  let unresolvedTotal = 0;
  const unresolvedSample = [];
  for (const file of files) {
    const filePath = `${dir}/${file}`;
    const artifact = JSON.parse(readFileSync(filePath, 'utf8'));
    const resolvedRows = [];
    const unresolved = [];
    for (const cast of artifact.casts) {
      const legislatorId = pdf.resolveMoRep(cast, roster);
      if (legislatorId) resolvedRows.push({ vote_id: artifact.vote_id, legislator_id: legislatorId, position: cast.position, run_id: runId });
      else unresolved.push(cast);
    }
    // sequential (not Promise.all) is deliberate: small, infrequent artifact backlog, each write
    // independent — no need for parallel-fetch complexity here.
    await insertIfAbsent(client, 'vote_casts', resolvedRows, 'vote_id,legislator_id');
    if (unresolved.length === 0) {
      unlinkSync(filePath);
      replayed += 1;
    } else {
      writeFileSync(filePath, JSON.stringify({
        ...artifact,
        partial: true,
        casts: unresolved, // only what's still unresolved needs retrying next replay
        last_replay_resolved_count: resolvedRows.length,
        last_replay_unresolved_count: unresolved.length,
        last_replay_run_id: runId,
        last_replay_at: new Date().toISOString(),
      }, null, 2));
      unresolvedTotal += unresolved.length;
      if (unresolvedSample.length < 10) unresolvedSample.push(...unresolved.slice(0, 10 - unresolvedSample.length).map((c) => ({ source_key: artifact.source_key, ...c })));
      console.error(`[${new Date().toISOString()}] replay: ${artifact.source_key} — ${resolvedRows.length} resolved, ${unresolved.length} unresolved (artifact kept on disk, partial: true)`);
    }
  }
  return {
    attempted: files.length, replayed, stillGated: false, unresolved: unresolvedTotal, unresolvedSample,
  };
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
    //
    // FINAL-REVIEW FIX (permanently-failing PDF wedges the queue): previously this failure was
    // only reported in this run's own result/log — nothing durable recorded that THIS source_key
    // had already failed, so listPendingRollCallPdfs kept re-selecting it (source_key-ascending
    // sort) and it got a fresh LIVE re-fetch every cooldown slot, forever. Now a `.failed.json`
    // artifact is written (see writeFailureArtifact/ROLLCALL_MAX_FAILED_ATTEMPTS above); once it
    // reaches the retry cap, excludeQuarantinedPdfs removes this source_key from the queue so the
    // driver can make progress on the rest of the backlog instead of retrying the same bad
    // document indefinitely.
    const failureArtifact = writeFailureArtifact(vote.source_key, vote.source_url, err);
    return {
      source_key: vote.source_key,
      mode,
      failure: { step: `rollcall parse ${vote.source_key}`, message: err.message },
      failureArtifact: { attempts: failureArtifact.attempts, quarantined: failureArtifact.attempts >= ROLLCALL_MAX_FAILED_ATTEMPTS },
    };
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
  // surname: r.surname carries the source XML's own <LastName> (parseMoRepresentative,
  // mo-house-xml.js) straight through — see supabase/migrations/0006_legislators_surname.sql for
  // why this column exists (loadMoRoster below depends on it to avoid a lossy full_name-based
  // reconstruction).
  const rows = roster.map((r) => ({
    full_name: r.full_name, surname: r.surname, mo_house_id: r.mo_house_id, party: r.party, run_id: runId,
  }));
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
    // Realistic if 0005/0006 are applied out of order (Lance applies them separately): 0005 alone
    // is enough for mo_house_id inserts to succeed, but this row payload also carries `surname`
    // (0006) — reported with the same honest-skip shape, not left to surface as an opaque throw.
    if (isMissingColumnError(err, 'surname')) {
      return {
        attempted: rows.length, persisted: 0, skipped: true,
        note: 'legislators.surname column not found — migration 0006 (supabase/migrations/0006_legislators_surname.sql) not yet applied (0005 may already be); member persistence skipped this run pending both migrations. bills/actions/votes are unaffected.',
      };
    }
    throw err;
  }
}

// --dry-run makes ZERO live fetches (fix: previously it still made the live bill-list fetch).
// Reports from DB state only: how many bill stub rows already exist for this session, and how
// many still need per-bill enrichment.
//
// bills_needing_enrichment (title IS NULL) is kept for continuity but is now a LEGACY signal —
// since Task fix-mo-enrichment, selectTargets no longer uses it (see that function's own comment
// for why: additivePatch leaves title non-null once set, so this count is still accurate for
// "never yet fetched", but a bill can also leave the needs-enrichment set via its .enriched marker
// while some fields stay null, e.g. a bill whose XML genuinely has no RollCall). The new
// bills_without_enriched_marker + next_targets_preview fields below reflect the ACTUAL signal
// selectTargets drives from — a DB read plus local marker-file presence checks, still zero live
// fetches.
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
      counts: { bills_total: 0, bills_needing_enrichment: 0, bills_without_enriched_marker: 0 },
      next_targets_preview: [],
      note: `no sessions row yet for identifier=${session} (no live run has happened yet); counts come from the DB, not a live list — zero live fetches made`,
    };
  }
  const { count: total, error: totalErr } = await client.from('bills')
    .select('id', { count: 'exact', head: true }).eq('session_id', sessionRow.id);
  if (totalErr) throw new Error(`dry-run bills count failed: ${totalErr.message}`);
  const { count: needingEnrichment, error: needErr } = await client.from('bills')
    .select('id', { count: 'exact', head: true }).eq('session_id', sessionRow.id).is('title', null);
  if (needErr) throw new Error(`dry-run bills-needing-enrichment count failed: ${needErr.message}`);
  // BUG FOUND WHILE VERIFYING THIS FIX: PostgREST/Supabase caps a single .select() response at
  // 1000 rows server-side REGARDLESS of an explicit .range() request (verified live: bills_total
  // was already 2099 for session 261 at the time this was written) — a single unpaginated query
  // here silently under-counted "pending" bills by however many identifiers sorted past row 1000,
  // which would have made this report actively misleading rather than merely incomplete. Paginate
  // in PAGE_SIZE batches until a page returns fewer than PAGE_SIZE rows. Capped at MAX_PAGES as a
  // sanity backstop (200k identifiers) — this driver's own bill count should never approach that;
  // hitting the cap is a signal something is wrong, not a value to silently truncate at.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 200;
  const identifiers = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data: idRows, error: idErr } = await client.from('bills')
      .select('identifier').eq('session_id', sessionRow.id).order('identifier').range(from, from + PAGE_SIZE - 1);
    if (idErr) throw new Error(`dry-run bill-identifier lookup failed: ${idErr.message}`);
    identifiers.push(...(idRows ?? []).map((r) => r.identifier));
    if (!idRows || idRows.length < PAGE_SIZE) break;
  }
  const pendingByMarker = identifiers.filter((id) => !hasEnrichedMarker(id));
  return {
    counts: {
      bills_total: total ?? 0,
      bills_needing_enrichment: needingEnrichment ?? 0,
      bills_without_enriched_marker: pendingByMarker.length,
    },
    // NOTE: sorted by DB identifier (alphabetical), NOT the true BillList.XML document order
    // selectTargets uses live/from cache — a sensible preview of what's still pending, not a
    // promise of the exact next fetch order (that requires an actual list fetch/cache, which
    // --dry-run deliberately never does).
    next_targets_preview: pendingByMarker.slice(0, 10),
    note: 'counts computed from DB state + local .enriched marker artifacts only — zero live fetches made this invocation, per --dry-run',
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
    // FINDING 2 fix: the pending-PDF queue check (and its skippedFailed/quarantine count+keys)
    // runs whenever no explicit --bill/--bill-xml-file was given, regardless of whether this slot
    // ends up processing a PDF or falls through to the bill-xml path below — surfaced into run
    // detail either way (both counts objects below).
    const pdfQueue = wantsExplicitBill ? { next: null, skippedFailed: 0, skippedKeys: [] } : await selectPendingPdf(client);
    const { next: pendingPdf, skippedFailed: skippedFailedPdfs, skippedKeys: skippedFailedPdfKeys } = pdfQueue;
    if (pendingPdf) {
      const result = await processRollCallPdf(client, runId, pendingPdf, args);
      const failures = result.failure ? [result.failure] : [];
      const counts = {
        document_type: 'rollcall-pdf', artifact_replay: artifactReplay, failures: failures.length, skipped_failed_pdfs: skippedFailedPdfs, skipped_failed_pdf_keys: skippedFailedPdfKeys,
      };
      const status = failures.length === 0 ? 'succeeded' : 'partial';
      await closeRun(client, runId, status, { counts, rollCallResult: result, failures });
      console.log(JSON.stringify({
        mode: 'live', run_id: runId, status, counts, rollCallResult: result, failures,
      }, null, 2));
      if (failures.length > 0) process.exitCode = 2;
      return;
    }

    // Task fix-mo-enrichment: only re-fetch BillList.XML live when the cache is stale (or absent)
    // — see shouldRefetchBillList's own comment for the live-verified bug this closes (every
    // invocation used to spend its entire cooldown slot on a redundant list re-fetch).
    const cachedList = readCachedBillList(args.session);
    let entries;
    let listFetchMode;
    if (shouldRefetchBillList(cachedList?.fetched_at ?? null)) {
      const listXml = await mo.fetchMoBillList(args.session);
      console.error(`[${new Date().toISOString()}] fetched bill-list XML (live, session ${args.session})`);
      entries = mo.parseMoBillList(listXml);
      writeCachedBillList(args.session, entries);
      listFetchMode = 'live';
    } else {
      entries = cachedList.entries;
      listFetchMode = 'cached';
      console.error(`[${new Date().toISOString()}] reusing cached bill-list XML from ${cachedList.fetched_at} (< ${MO_BILL_LIST_MAX_AGE_MS / 60000}min old; skipping live list fetch this slot)`);
    }
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
      // Task fix-mo-enrichment: the bill LEAVES the needs-enrichment set here, unconditionally,
      // now that its fetch+parse+persist cycle has completed — see selectTargets/
      // hasEnrichedMarker's own comment for why this is file-presence-driven rather than derived
      // from any DB column.
      writeEnrichedMarker(target.identifier, { run_id: runId, bill_id: result.bill_id });
    }

    const counts = {
      document_type: 'bill-xml', bills_listed: entries.length, bills_detailed: billResults.length,
      list_fetch_mode: listFetchMode,
      failures: failures.length, roster, artifact_replay: artifactReplay, skipped_failed_pdfs: skippedFailedPdfs, skipped_failed_pdf_keys: skippedFailedPdfKeys,
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
