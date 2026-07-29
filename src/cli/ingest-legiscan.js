import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {
  getClient, openRun, closeRun, insertIfAbsent, additivePatch, selectAll,
  isMissingColumnError, isMissingRelationError,
} from '../lib/db.js';
import {
  SOURCE, ATTRIBUTION, getDatasetList, getDataset, decodeDatasetHashGate,
  getMonthlyQueryUsage, assertUnderBudget, DatasetHashMismatchError,
} from '../adapters/legiscan.js';
import {
  decodeDatasetZip, extractDatasetFiles, normalizeBillIdentifier,
} from '../adapters/legiscan-dataset.js';
import { resolveOrCreateLegiscanPerson } from '../adapters/legiscan-identity.js';
import {
  reconcileLegiscanTallies, buildLegiscanVoteSourceKey, buildLegiscanVoteCasts,
  crossCheckAgainstPrimarySource, LegiscanRollCallReconcileError, VoteIdMapError,
} from '../adapters/legiscan-votes.js';

// LegiScan bulk adapter — driver (Task 9 of docs/superpowers/plans/2026-07-29-legiscan-bulk-
// adapter.md). Composes Tasks 2/4/5/6/7 into the full dataset-bulk backfill pipeline: dataset
// ensure (hash-gated) -> decode/parse -> sessions/bills/identity -> reconciled votes/casts ->
// honest run detail. Every behavior here answers one of the 11 CONTROLLER RULINGS appended to
// task-9-brief.md (F:\VisibleGov\.superpowers\sdd\2026-07-29-legiscan-bulk-adapter\task-9-
// brief.md) — see task-9-report.md for the ruling-by-ruling accounting.
//
// HARD RULE (this task only): no live LegiScan query and no live DB write ever happens as a
// SIDE EFFECT of running this repo's test suite. Every live-network/live-DB call site below is
// reached only through the `--dataset-file <path>` fixture-substitution flag (mirrors ingest-mo-
// senate.js's `--journal-pdf-file` convention exactly) or through injectable functions
// (`getDatasetListFn`/`getDatasetFn`) a test can fake — same convention as that driver's
// `fetchLive`/`fetchPdf` params. Task 10 owns the first real live slice.

const STATE = 'MO';
const DEFAULT_MONTHLY_QUERY_CAP = 5000; // Q2 ruling default, overridable below
const LEGISCAN_DATASET_CACHE_DIR = '.superpowers/artifacts/legiscan-datasets'; // gitignored (Ruling 9)
// Worst-case per-run LegiScan query cost when this run actually needs to touch the live API: one
// getDatasetList (always, to learn the CURRENT dataset_hash) plus, only if the hash gate says
// shouldFetch, one getDataset. assertUnderBudget must refuse BEFORE we know which of those two
// outcomes we'll get (brief step 1: "BEFORE any live call") — so the pre-flight check plans for
// the worst case, never the optimistic one.
const PLANNED_QUERIES_PER_RUN = 2;

// ---- args (CONTROLLER RULING 11: --session <legiscan_session_id> [--limit N] [--dry-run],
// plus --dataset-file for the fixture-substitution / local-smoke-test path the brief's own worked
// example literally invokes) ----

export function parseLegiscanArgs(argv) {
  const out = {
    session: null, limit: null, dryRun: false, datasetFile: null,
  };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
    const val = argv[i + 1];
    if (key === '--session') out.session = Number(val);
    else if (key === '--limit') out.limit = Number(val);
    else if (key === '--dataset-file') out.datasetFile = val;
    else throw new Error(`unknown flag: ${key}`);
    i += 2;
  }
  // --dataset-file already carries the LegiScan session_id in its own envelope (dataset.session_id)
  // — the brief's own smoke-test invocation omits --session entirely in that mode. A real (live)
  // run has no other way to know which session to fetch, so --session is required there.
  if (!out.datasetFile && !out.session) {
    throw new Error('--session <legiscan_session_id> is required (unless --dataset-file is given)');
  }
  return out;
}

// ---- provenance: source_url resolution (CONTROLLER RULINGS 5 & 10) ----
//
// Ruling 10: prefer state_link (the STATE's own page — "the better receipt") over legiscan.com's
// own url; both fields are printed verbatim by LegiScan itself on the SAME record, never
// constructed or guessed. Ruling 5: roll_call payloads carry NO url field at all — a roll call's
// own source_url must come from its PARENT BILL's votes[] array, keyed by roll_call_id (verified
// against the real SB894/HB2/HB3 fixtures — see task-9-report.md).
function preferStateLink(record) {
  const stateLink = record?.state_link;
  if (typeof stateLink === 'string' && stateLink.trim() !== '') return stateLink;
  const url = record?.url;
  return (typeof url === 'string' && url.trim() !== '') ? url : null;
}

export function billSourceUrl(bill) {
  return preferStateLink(bill);
}

export function rollCallSourceUrl(billRecord, rollCallId) {
  const voteEntry = (billRecord?.votes ?? []).find((v) => v.roll_call_id === rollCallId);
  return voteEntry ? preferStateLink(voteEntry) : null;
}

// ---- session identity (CONTROLLER RULING 4) ----
//
// Real prod state (task-1-report.md pre-flight probe, live 2026-07-28): `sessions` already holds
// THREE MO rows under TWO identifier conventions — bare years ('2018', '2022', mo-senate-web/
// OpenStates) and mo-house-xml's own raw session id ('261', name "2026 2nd Regular, 103rd General
// Assembly", 2,099 bills attached). LegiScan's own 2026 Regular Session (session_id 2239, real
// mo-sessions.json fixture) must resolve onto THAT EXISTING '261' row, never mint a duplicate
// '2026' row — otherwise LegiScan's 2026 bills/votes would silently fork away from mo-house-xml's
// already-ingested 2,099 bills instead of dedupeing onto them.

export class AmbiguousLegiscanSessionMatchError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'AmbiguousLegiscanSessionMatchError';
    Object.assign(this, meta);
  }
}

export class LegiscanSessionIdentityConflictError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LegiscanSessionIdentityConflictError';
    Object.assign(this, meta);
  }
}

const MISSING_SESSION_COLUMN_NOTE = 'sessions.legiscan_session_id column not found — migration 0010 '
  + '(supabase/migrations/0010_legiscan_identity_and_ledger.sql) not yet applied; session resolution '
  + 'skipped for this run. Never guessed — retried automatically once the migration lands.';

// isLegiscanRegularSession — LegiScan's own `special` field (0/1), verified against every session
// in the real mo-sessions.json fixture (all 17 Regular Sessions carry special:0; both real dataset
// fixtures, 1579/1608, carry special:1 and a session_tag ending "Special Session"). Never derived
// from session_tag text-matching — the source already prints this as a typed flag.
export function isLegiscanRegularSession(datasetMeta) {
  return Number(datasetMeta.special) === 0;
}

// buildLegiscanSpecialSessionIdentifier — "Specials get distinct identifiers" (Ruling 4). Keyed by
// LegiScan's own session_id (globally unique by construction, per legiscan-votes.js's own
// buildLegiscanVoteSourceKey precedent) rather than a slugified session_tag — trivially
// collision-free without inventing a slugging scheme, and the human-readable session_title/
// session_name still lands in the row's own `name` column so nothing informative is lost.
export function buildLegiscanSpecialSessionIdentifier(datasetMeta) {
  return `${datasetMeta.year_start}-special-${datasetMeta.session_id}`;
}

// A special-session identifier this driver itself mints (buildLegiscanSpecialSessionIdentifier's
// own output shape) must never be mistaken for a pre-existing Regular Session row's own identifier
// during the year+name candidate search below — otherwise ingesting a Regular Session for a year
// that ALREADY has LegiScan-authored Special rows would find them as false "same year" candidates
// (their own `name` also starts with the year) and either wrongly attach to one or spuriously
// throw AmbiguousLegiscanSessionMatchError. See ensureLegiscanSessionRow's own test coverage for
// the concrete scenario this guards.
const SPECIAL_IDENTIFIER_PATTERN = /-special-\d+$/;

async function patchSessionRow(client, row, legiscanSessionId) {
  // Conflict guard (mirrors legiscan-identity.js's resolveOrCreateLegiscanPerson exactly): a
  // DIFFERENT legiscan_session_id already on this row is a hard error, never a silent overwrite.
  if (row.legiscan_session_id != null && row.legiscan_session_id !== legiscanSessionId) {
    throw new LegiscanSessionIdentityConflictError(
      `sessions.id=${row.id} (identifier=${row.identifier}) already has legiscan_session_id=`
        + `${row.legiscan_session_id}, cannot attach legiscan_session_id=${legiscanSessionId} — this is `
        + 'a real data conflict, not guessed at',
      { sessionRowId: row.id, existingLegiscanSessionId: row.legiscan_session_id, incomingLegiscanSessionId: legiscanSessionId },
    );
  }
  const patch = additivePatch(row, { legiscan_session_id: legiscanSessionId });
  if (Object.keys(patch).length > 0) {
    const { error } = await client.from('sessions').update(patch).eq('id', row.id);
    if (error) {
      if (isMissingColumnError(error, 'legiscan_session_id')) {
        return {
          id: row.id, identifier: row.identifier, matched: true, created: false, gated: true, note: MISSING_SESSION_COLUMN_NOTE,
        };
      }
      throw new Error(`ingest-legiscan: session patch failed for sessions.id=${row.id}: ${error.message}`);
    }
  }
  return {
    id: row.id, identifier: row.identifier, matched: true, created: false, gated: false, reason: 'attached_existing',
  };
}

async function ensureAndPatchSessionRow(client, { identifier, name, legiscanSessionId }) {
  await insertIfAbsent(client, 'sessions', [{ jurisdiction_id: 'mo-legislature', identifier, name }], 'jurisdiction_id,identifier');
  const { data: row, error } = await client.from('sessions')
    .select('id,identifier,name,legiscan_session_id')
    .eq('jurisdiction_id', 'mo-legislature').eq('identifier', identifier).single();
  if (error) throw new Error(`ingest-legiscan: session lookup after ensure failed for identifier=${identifier}: ${error.message}`);
  const patched = await patchSessionRow(client, row, legiscanSessionId);
  return { ...patched, created: true };
}

// ensureLegiscanSessionRow(client, datasetMeta) -> { id, identifier, matched, created, gated,
// reason?, note? }. datasetMeta is the dataset envelope's own top-level fields (session_id,
// year_start, special, session_tag, session_title, session_name — real fixture fields, see
// task-9-report.md) — no separate getSessionList call needed, the dataset response already
// carries everything this function needs.
export async function ensureLegiscanSessionRow(client, datasetMeta) {
  const legiscanSessionId = datasetMeta.session_id;

  // Fast path: already resolved (brief step 3 — single-row lookup by the UNIQUE
  // legiscan_session_id column, selectAll not needed).
  const { data: already, error: alreadyErr } = await client.from('sessions')
    .select('id,identifier,name,legiscan_session_id')
    .eq('legiscan_session_id', legiscanSessionId)
    .maybeSingle();
  if (alreadyErr) {
    if (isMissingColumnError(alreadyErr, 'legiscan_session_id')) {
      return {
        id: null, matched: false, created: false, gated: true, note: MISSING_SESSION_COLUMN_NOTE,
      };
    }
    throw new Error(`ingest-legiscan: session exact-match lookup failed: ${alreadyErr.message}`);
  }
  if (already) {
    return {
      id: already.id, identifier: already.identifier, matched: true, created: false, gated: false, reason: 'exact_key',
    };
  }

  if (!isLegiscanRegularSession(datasetMeta)) {
    const identifier = buildLegiscanSpecialSessionIdentifier(datasetMeta);
    return ensureAndPatchSessionRow(client, {
      identifier, name: datasetMeta.session_title ?? datasetMeta.session_name ?? null, legiscanSessionId,
    });
  }

  // Regular Session, first time seen. Step 1: the ordinary bare-year dedup path (matches
  // mo-senate-web's/OpenStates' own '2018'/'2022' rows).
  const bareYear = String(datasetMeta.year_start);
  const { data: bareYearRow, error: bareYearErr } = await client.from('sessions')
    .select('id,identifier,name,legiscan_session_id')
    .eq('jurisdiction_id', 'mo-legislature').eq('identifier', bareYear)
    .maybeSingle();
  if (bareYearErr) throw new Error(`ingest-legiscan: bare-year session lookup failed for ${bareYear}: ${bareYearErr.message}`);
  if (bareYearRow) return patchSessionRow(client, bareYearRow, legiscanSessionId);

  // Step 2: year+name mapping (CONTROLLER RULING 4, literal) — a Regular Session that already has
  // a row under a DIFFERENT pre-existing identifier convention (the real '261' case). Not a
  // single-row lookup, so selectAll (Ruling 10), never a bare .select().
  const { data: candidateRows, error: candErr } = await selectAll(client, 'sessions', 'id,identifier,name,legiscan_session_id', {
    filter: (q) => q.eq('jurisdiction_id', 'mo-legislature'),
  });
  if (candErr) throw new Error(`ingest-legiscan: session year/name candidate lookup failed: ${candErr.message}`);
  const yearNameCandidates = (candidateRows ?? []).filter((row) => (
    row.identifier !== bareYear
    && !SPECIAL_IDENTIFIER_PATTERN.test(row.identifier) // never match a row THIS driver itself minted for a Special session
    && typeof row.name === 'string'
    && row.name.trim().startsWith(bareYear)
  ));
  if (yearNameCandidates.length > 1) {
    throw new AmbiguousLegiscanSessionMatchError(
      `ingest-legiscan: LegiScan session ${legiscanSessionId} (${datasetMeta.session_title}) matches `
        + `${yearNameCandidates.length} existing sessions rows by year+name — never guessed between `
        + `them: ${yearNameCandidates.map((r) => r.identifier).join(', ')}`,
      { legiscanSessionId, candidates: yearNameCandidates },
    );
  }
  if (yearNameCandidates.length === 1) return patchSessionRow(client, yearNameCandidates[0], legiscanSessionId);

  // Step 3: genuinely new Regular Session — create the bare-year row (mirrors mo-senate-web's own
  // ensureSessionRow / OpenStates dedup convention exactly).
  return ensureAndPatchSessionRow(client, {
    identifier: bareYear, name: datasetMeta.session_title ?? datasetMeta.session_name ?? null, legiscanSessionId,
  });
}

// ---- bills ensure (brief step 4) ----

async function ensureLegiscanBillRows(client, runId, sessionRowId, bills) {
  const rows = bills.map((b) => ({
    session_id: sessionRowId,
    identifier: normalizeBillIdentifier(b.bill_number),
    title: b.title ?? null,
    // LegiScan's own `status` is a numeric lifecycle code (no house-style label mapping exists in
    // this codebase for it, and inventing one would be a guess) — stored as printed, verbatim,
    // never interpreted. `status_date` is not persisted (bills table has no column for it).
    status: b.status != null ? String(b.status) : null,
    canonical_url: billSourceUrl(b),
    run_id: runId,
  }));
  await insertIfAbsent(client, 'bills', rows, 'session_id,identifier');

  const billRecordByLegiscanBillId = new Map();
  // Sequential, not Promise.all — same "small/infrequent backlog, readability over throughput"
  // precedent as ingest-mo-senate.js's replayJournalArtifacts/selectAll (src/lib/db.js).
  for (const b of bills) {
    const identifier = normalizeBillIdentifier(b.bill_number);
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await client.from('bills').select('id')
      .eq('session_id', sessionRowId).eq('identifier', identifier).single();
    if (error) throw new Error(`ingest-legiscan: bill lookup failed for ${identifier}: ${error.message}`);
    billRecordByLegiscanBillId.set(b.bill_id, { rowId: data.id, record: b });
  }
  return { billRecordByLegiscanBillId };
}

// ---- people ensure (CONTROLLER RULING 6: every dataset person runs resolveOrCreateLegiscanPerson) ----

async function ensureLegiscanPeople(client, runId, people, sessionWindow) {
  const legislatorIdByPeopleId = new Map();
  let matched = 0;
  let created = 0;
  let ambiguous = 0;
  let gated = 0;
  // Sequential — same precedent as ensureLegiscanBillRows above (each person may cost several
  // round trips inside resolveOrCreateLegiscanPerson itself; not a scale where parallelism helps).
  for (const person of people) {
    // eslint-disable-next-line no-await-in-loop
    const result = await resolveOrCreateLegiscanPerson(client, runId, person, sessionWindow);
    if (result.gated) { gated += 1; continue; }
    if (result.legislator_id) legislatorIdByPeopleId.set(person.people_id, result.legislator_id);
    if (result.reason === 'ambiguous') ambiguous += 1;
    else if (result.matched) matched += 1;
    else if (result.created) created += 1;
  }
  return {
    legislatorIdByPeopleId, counts: {
      matched, created, ambiguous, gated,
    },
  };
}

// ---- votes/casts ingestion (CONTROLLER RULING 1: crossCheckAgainstPrimarySource runs BEFORE
// insertIfAbsent('votes') — quarantine:true means the LegiScan vote and its casts are NEVER
// written; CONTROLLER RULING 7: run detail must surface quarantined votes, no_tally_corresponding_
// primary flags, ambiguous_tally_match, unresolved casts, per-chamber vote counts distinctly) ----

// checkVoteId3Sighting — CONTROLLER RULING 8: vote_id 3 ('Not Voting') has no real-fixture example
// anywhere in this repo (legiscan-votes.js's own VOTE_ID_MAP comment — the mapping rests on the
// schema-mysql.sql citation alone, never fixture-confirmed). A cast bearing vote_id 3 is entirely
// legal per VOTE_ID_MAP (reconcileLegiscanTallies does not reject it), so this never blocks
// ingestion — it only gathers a small spot-verify sample (capped, same 10-item convention used
// throughout this plan) so a human can confirm the printed vote_text really does read "Not Voting"
// the first time this repo's own live traffic actually produces one.
function checkVoteId3Sighting(rollCall, sample) {
  for (const v of (rollCall.votes ?? [])) {
    if (v.vote_id === 3 && sample.length < 10) {
      sample.push({ rollCallId: rollCall.roll_call_id, peopleId: v.people_id, voteText: v.vote_text ?? null });
    }
  }
}

// classifyCrossCheckFlagReason — MINOR 1 fix (Task 9 review, label precision): the original
// version dumped every flag whose discrepancy carried no explicit `reason` key (i.e. every
// single-candidate-path hard/soft mismatch, from BOTH the ordinary N=1 branch and this fix round's
// new tally-unique-reverse-match soft-mismatch branch) into one undifferentiated "other" bucket,
// indistinguishable from a genuinely unclassified/unexpected discrepancy shape. Both mismatch
// kinds are recognizable by their own discrepancy shape (`hard_mismatches`/`soft_mismatches`
// arrays, always both present together whenever a flag is written from that code path) — split out
// explicitly so a human reading run detail can tell "N real hard mismatches (== N quarantined
// votes, since hard mismatch is exactly what triggers quarantine on this path)" from "N soft/
// bucket-only mismatches (never quarantined)" from a true "other" catch-all, which should now be
// empty in practice and only exists as a defensive fallback.
function classifyCrossCheckFlagReason(discrepancy) {
  const reason = discrepancy?.reason;
  if (reason === 'no_tally_corresponding_primary') return 'no_tally_corresponding_primary';
  if (reason === 'ambiguous_tally_match') return 'ambiguous_tally_match';
  // FIX (CRITICAL 3, final-review-findings.md): a primary candidate whose own cast data is not yet
  // comparable (zero/partial casts relative to its printed aggregate) is its own distinct,
  // explicitly-counted bucket — never lumped into "other" (a defensive catch-all that should stay
  // empty in practice) or misread as a real hard/soft mismatch (it is neither; no comparison ran).
  if (reason === 'primary_cast_data_not_comparable') return 'primary_cast_data_not_comparable';
  if (Array.isArray(discrepancy?.hard_mismatches)) {
    return discrepancy.hard_mismatches.length > 0 ? 'hard_mismatch' : 'soft_mismatch';
  }
  return 'other';
}

// buildSameTupleKey / groupReconciledRollCallsByTuple — FIX ROUND (Task 9 review finding, mirror
// of legiscan-votes.js's own FIX ROUND 2): crossCheckAgainstPrimarySource's single-candidate
// (candidates.length === 1) branch needs to know, for THIS roll call, which OTHER LegiScan roll
// calls in the CURRENT dataset share the exact same (bill, chamber, date) tuple — otherwise every
// LegiScan roll call sharing a tuple with a genuinely-corresponding sibling would independently see
// the same one primary-source row and risk being wrongly treated as contradicting it. This driver
// has the whole parsed dataset in hand (legiscan-votes.js does not, by design — it only ever sees
// one roll call at a time), so the grouping is built HERE, once per run, from every roll call that
// passed the internal reconciliation gate (a) and resolved to a real bill row — the only pool a
// cross-check could ever run against anyway.
function buildSameTupleKey(billRowId, chamber, date) {
  return `${billRowId}|${chamber}|${date}`;
}

function groupReconciledRollCallsByTuple(reconciled) {
  const groups = new Map();
  for (const entry of reconciled) {
    const key = buildSameTupleKey(entry.billEntry.rowId, entry.legiscanTallies.chamber, entry.legiscanTallies.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ rollCallId: entry.legiscanTallies.rollCallId, tallies: entry.legiscanTallies.tallies });
  }
  return groups;
}

// retractLegiscanVoteIfStored — FIX (CRITICAL 2, final-review-findings.md, 2026-07-29 final
// whole-branch review). Quarantine was insert-time-only: in the standard backfill-first ordering, a
// primary journal row landing LATER with contradicting tallies was only detected on the NEXT
// LegiScan re-run, where the quarantine branch just `continue`d past insertIfAbsent — the already-
// published contradicted vote and all its casts stayed anon-readable forever, nothing ever marked
// or deleted them. This closes that: whenever crossCheckFn reports quarantine:true, look up the
// LegiScan vote by its own source_key and retract it if it already exists (a fresh quarantine, with
// nothing stored yet, is a no-op lookup — the common case; an already-published row is now actually
// removed).
//
// CONTROLLER AMENDMENT (Finding 2): delete casts then vote (FK order), source_key-prefix-guarded to
// legiscan- rows ONLY, flag row + retractedVotes count retained — this is the codebase's ONE
// sanctioned delete (every other write path here is additive/upsert-only, PLAYBOOK_DELTA lesson 5)
// — commented as such, never a precedent for a delete anywhere else in this repo.
export async function retractLegiscanVoteIfStored(client, sourceKey) {
  if (!sourceKey.startsWith('legiscan-')) {
    throw new Error(
      `retractLegiscanVoteIfStored: refusing to touch a non-legiscan source_key "${sourceKey}" — `
        + 'this is the one sanctioned delete in this codebase and it must never reach a '
        + 'primary-source row',
    );
  }
  const { data: existing, error: selErr } = await client.from('votes').select('id')
    .eq('source_key', sourceKey).maybeSingle();
  if (selErr) throw new Error(`ingest-legiscan: retraction lookup failed for ${sourceKey}: ${selErr.message}`);
  if (!existing) return { retracted: false, voteId: null };

  const { error: castsDelErr } = await client.from('vote_casts').delete().eq('vote_id', existing.id);
  if (castsDelErr) throw new Error(`ingest-legiscan: retraction cast delete failed for ${sourceKey}: ${castsDelErr.message}`);
  const { error: voteDelErr } = await client.from('votes').delete().eq('id', existing.id);
  if (voteDelErr) throw new Error(`ingest-legiscan: retraction vote delete failed for ${sourceKey}: ${voteDelErr.message}`);
  return { retracted: true, voteId: existing.id };
}

function emptyRollCallResult() {
  return {
    votes: 0,
    votesByChamber: { house: 0, senate: 0 },
    casts: 0,
    reconciliationFailures: 0,
    reconciliationFailureDetails: [],
    crossCheckFlags: {
      total: 0,
      tally_unique_match: 0,
      no_tally_corresponding_primary: 0,
      ambiguous_tally_match: 0,
      primary_cast_data_not_comparable: 0,
      hard_mismatch: 0,
      soft_mismatch: 0,
      other: 0,
    },
    quarantinedVotes: 0,
    quarantinedRollCalls: [],
    retractedVotes: 0,
    retractedRollCalls: [],
    unresolvedCasts: { count: 0, sample: [] },
    voteId3SpotVerify: [],
  };
}

async function ingestLegiscanRollCalls(client, runId, {
  allRollCalls, rollCallsToProcess, legiscanSessionId, billRecordByLegiscanBillId, legislatorIdByPeopleId,
  crossCheckFn = crossCheckAgainstPrimarySource,
}) {
  const result = emptyRollCallResult();

  // FIX (IMPORTANT 4, final-review-findings.md): --limit (or a reconcile-failing sibling) must
  // never truncate the SIBLING-TALLY POOL crossCheckAgainstPrimarySource's own tuple-disambiguation
  // depends on — only which roll calls this run actually processes/stores. Reconciling was
  // previously scoped to the (possibly --limit-sliced) `rollCalls` argument alone, so a roll call
  // whose true-corresponding same-tuple sibling was sliced out saw siblingTallies=[] and fell into
  // Branch B (singleton/singleton) against a primary row it never actually corresponded to —
  // repro-confirmed on the real 1608 fixture (--limit 3 fabricated a "119 vs 36 / 23 vs 92"
  // contradiction for 774312 against a primary row that actually matches sibling 774313, sliced out
  // of the 3). Phase 1 below reconciles the FULL `allRollCalls` (always the complete parsed
  // dataset, regardless of --limit) so Phase 2's tuple grouping has complete sibling knowledge;
  // reconciliationFailures/voteId3SpotVerify/Phase 3's cross-check+store still only reflect the
  // `rollCallsToProcess` subset — --limit continues to govern what THIS RUN touches/reports on,
  // only the grouping INPUT widens.
  const toProcessIds = new Set(rollCallsToProcess.map((rc) => rc.roll_call_id));
  const reconciled = []; // every roll call in the FULL dataset that reconciles — the grouping pool
  const reconciledToProcess = []; // the subset actually cross-checked/stored this run
  for (const rollCall of allRollCalls) {
    const isSelected = toProcessIds.has(rollCall.roll_call_id);
    // checkVoteId3Sighting runs unconditionally for a selected roll call, even one that goes on to
    // fail reconciliation — a printed vote_id 3 is real source data regardless of whether the REST
    // of that roll call's own numbers happen to reconcile.
    if (isSelected) checkVoteId3Sighting(rollCall, result.voteId3SpotVerify);

    let legiscanTallies;
    try {
      legiscanTallies = reconcileLegiscanTallies(rollCall);
    } catch (err) {
      if (err instanceof LegiscanRollCallReconcileError || err instanceof VoteIdMapError) {
        // Internal gate (a) failure — skipped, never stored, same convention as every prior parser
        // in this repo (mo-rollcall-pdf.js's parseMoRollCall, mo-senate-journal-pdf.js's
        // parseJournalVotes). Not part of the sibling-grouping pool either (no reliable tallies
        // exist to compare against) — only counted as a failure when this run was actually going to
        // process it.
        if (isSelected) {
          result.reconciliationFailures += 1;
          result.reconciliationFailureDetails.push({ rollCallId: rollCall.roll_call_id, message: err.message });
        }
        continue;
      }
      throw err;
    }
    legiscanTallies.runId = runId; // rides into any flag row crossCheckAgainstPrimarySource writes

    const billEntry = billRecordByLegiscanBillId.get(legiscanTallies.legiscanBillId);
    if (!billEntry) {
      // Never observed in either real fixture (every roll call's bill_id is one of the dataset's
      // own bills[]) — a real data-shape surprise if it ever happens, counted honestly rather than
      // silently skipped or crashing the whole run.
      if (isSelected) {
        result.reconciliationFailures += 1;
        result.reconciliationFailureDetails.push({
          rollCallId: rollCall.roll_call_id, message: `no bill record for legiscan bill_id=${legiscanTallies.legiscanBillId}`,
        });
      }
      continue;
    }

    const entry = { rollCall, legiscanTallies, billEntry };
    reconciled.push(entry);
    if (isSelected) reconciledToProcess.push(entry);
  }

  // Phase 2: group by (bill, chamber, date) tuple over the FULL reconciled pool (Finding 4) — the
  // same correspondence key crossCheckAgainstPrimarySource itself matches on.
  const tupleGroups = groupReconciledRollCallsByTuple(reconciled);

  // Phase 3: cross-check + store, one roll call at a time, over the --limit-selected subset only.
  // Sequential — same precedent as ensureLegiscanBillRows/ensureLegiscanPeople; a roll call's own
  // cross-check + insert path is itself several round trips, not parallelizable against the shared
  // per-run counters above without real risk of double-counting.
  for (const { rollCall, legiscanTallies, billEntry } of reconciledToProcess) {
    const tupleKey = buildSameTupleKey(billEntry.rowId, legiscanTallies.chamber, legiscanTallies.date);
    const siblingTallies = tupleGroups.get(tupleKey).filter((s) => s.rollCallId !== legiscanTallies.rollCallId);

    // eslint-disable-next-line no-await-in-loop
    const crossCheck = await crossCheckFn(client, billEntry.rowId, legiscanTallies, siblingTallies);
    if (crossCheck.flag) {
      result.crossCheckFlags.total += 1;
      result.crossCheckFlags[classifyCrossCheckFlagReason(crossCheck.flag.discrepancy)] += 1;
    } else if (crossCheck.reason === 'tally_unique_match') {
      result.crossCheckFlags.tally_unique_match += 1;
    }

    if (crossCheck.quarantine) {
      // CONTROLLER RULING 1: crossCheckAgainstPrimarySource already ran (and already wrote its own
      // flag row, above) BEFORE this point — no insertIfAbsent('votes', ...) call happens on this
      // branch, ever, on a fresh detection. FIX (CRITICAL 2): a re-run against an ALREADY-STORED
      // LegiScan vote (a prior run stored it before the contradicting primary row existed) must
      // actively retract it — quarantined only truthfully means "never stored" once this confirms
      // the row is actually absent.
      const sourceKey = buildLegiscanVoteSourceKey(legiscanSessionId, legiscanTallies.rollCallId);
      // eslint-disable-next-line no-await-in-loop
      const retraction = await retractLegiscanVoteIfStored(client, sourceKey);
      result.quarantinedVotes += 1;
      result.quarantinedRollCalls.push({
        rollCallId: rollCall.roll_call_id, billId: billEntry.rowId, retracted: retraction.retracted,
      });
      if (retraction.retracted) {
        result.retractedVotes += 1;
        result.retractedRollCalls.push({ rollCallId: rollCall.roll_call_id, billId: billEntry.rowId });
      }
      continue;
    }

    const voteRow = {
      bill_id: billEntry.rowId,
      jurisdiction_id: 'mo-legislature',
      chamber: legiscanTallies.chamber,
      vote_date: legiscanTallies.date,
      question: legiscanTallies.question,
      // Mechanical neutrality: no pass/fail word is computed from LegiScan's own `passed` flag or
      // from the tallies (that would bake in chamber-specific majority-threshold assumptions).
      // Mirrors mo-house-xml.js's buildMoVoteRows precedent exactly (same `votes` table, same
      // "store only what's printed" bar): a raw yea-nay numeric string, never an interpreted word.
      result: `${legiscanTallies.tallies.yea}-${legiscanTallies.tallies.nay}`,
      source_url: rollCallSourceUrl(billEntry.record, legiscanTallies.rollCallId),
      source_key: buildLegiscanVoteSourceKey(legiscanSessionId, legiscanTallies.rollCallId),
      run_id: runId,
    };
    // eslint-disable-next-line no-await-in-loop
    await insertIfAbsent(client, 'votes', [voteRow], 'source_key');
    // eslint-disable-next-line no-await-in-loop
    const { data: voteSel, error: voteSelErr } = await client.from('votes').select('id')
      .eq('source_key', voteRow.source_key).single();
    if (voteSelErr) throw new Error(`ingest-legiscan: vote lookup failed for ${voteRow.source_key}: ${voteSelErr.message}`);

    result.votes += 1;
    result.votesByChamber[legiscanTallies.chamber] = (result.votesByChamber[legiscanTallies.chamber] ?? 0) + 1;

    const { casts, unresolved } = buildLegiscanVoteCasts({
      voteId: voteSel.id, runId, casts: legiscanTallies.casts, legislatorIdByPeopleId,
    });
    // eslint-disable-next-line no-await-in-loop
    await insertIfAbsent(client, 'vote_casts', casts, 'vote_id,legislator_id');
    result.casts += casts.length;
    result.unresolvedCasts.count += unresolved.count;
    if (result.unresolvedCasts.sample.length < 10) {
      result.unresolvedCasts.sample.push(
        ...unresolved.sample.slice(0, 10 - result.unresolvedCasts.sample.length)
          .map((c) => ({ rollCallId: rollCall.roll_call_id, ...c })),
      );
    }
  }

  return result;
}

// ---- dataset resolution: hash gate + local cache + live fetch (CONTROLLER RULINGS 2, 3, 9) ----
//
// Only reached when args.datasetFile is NOT given — see runLegiscanIngest below. Every live call
// site here goes through injected getDatasetListFn/getDatasetFn (default: the real legiscan.js
// functions) so a test can fake this entire function without ever touching the network.

// recordQueryUsage — CONTROLLER RULING 3, incremental persistence: "crash must OVERCOUNT, never
// undercount" — the counter is incremented AND persisted (write-ahead) BEFORE the query it counts
// is even issued, so a crash mid-flight (including one that kills the query before it completes)
// still leaves the ledger showing it as spent. getMonthlyQueryUsage sums detail.queries_used
// across EVERY ingestion_runs row regardless of status (src/adapters/legiscan.js) — a run stuck at
// status:'running' with a stale/absent detail would otherwise silently UNDERCOUNT that month's
// real usage, the exact unsafe-direction bug this closes (T2 review finding (b)).
export async function recordQueryUsage(client, runId, detail) {
  detail.queries_used += 1;
  const { error } = await client.from('ingestion_runs')
    .update({ detail: { queries_used: detail.queries_used } })
    .eq('id', runId);
  if (error) throw new Error(`ingest-legiscan: write-ahead query-usage persistence failed: ${error.message}`);
}

export async function resolveDatasetBytes(client, runId, legiscanSessionId, {
  getDatasetListFn, getDatasetFn, apiKey, cacheDir, detail, state = STATE,
}) {
  await recordQueryUsage(client, runId, detail); // about to spend the getDatasetList query
  const datasetList = await getDatasetListFn(state, { key: apiKey });
  const entry = datasetList.find((d) => d.session_id === legiscanSessionId);
  if (!entry) throw new Error(`ingest-legiscan: session ${legiscanSessionId} not found in getDatasetList(${state})`);

  let ledgerRow = null;
  const { data: ledgerData, error: ledgerErr } = await client
    .from('legiscan_datasets')
    .select('legiscan_session_id,dataset_hash,local_cache_path,fetched_at,run_id')
    .eq('legiscan_session_id', legiscanSessionId)
    .maybeSingle();
  if (ledgerErr) {
    if (!isMissingRelationError(ledgerErr, 'legiscan_datasets')) {
      throw new Error(`ingest-legiscan: legiscan_datasets ledger lookup failed: ${ledgerErr.message}`);
    }
    // migration 0010 not applied — degrades to "always fetch" (same gate-honestly convention as
    // every other 0010-dependent table in this plan); ledgerRow stays null.
  } else {
    ledgerRow = ledgerData;
  }

  const gate = decodeDatasetHashGate(legiscanSessionId, entry.dataset_hash, ledgerRow);

  if (!gate.shouldFetch) {
    // Ruling 9: local ZIP cache — the dataset is unchanged since the last fetch, so this run reads
    // the previously-cached envelope instead of re-downloading. Re-processing from the cache (not
    // just trusting "unchanged = nothing to do") is deliberate: insertIfAbsent/additivePatch make
    // re-processing idempotent and cheap, and it is what actually completes a prior run that got
    // interrupted partway through bills/votes/casts.
    if (!ledgerRow?.local_cache_path || !existsSync(ledgerRow.local_cache_path)) {
      throw new Error(
        `ingest-legiscan: dataset-hash gate says hash unchanged for session ${legiscanSessionId} but the `
          + `local cache at ${ledgerRow?.local_cache_path} is missing — cannot safely skip the live fetch`,
      );
    }
    const datasetEnvelope = JSON.parse(readFileSync(ledgerRow.local_cache_path, 'utf8'));

    // FIX (IMPORTANT 7, final-review-findings.md): the cache branch previously trusted
    // local_cache_path's CONTENTS unconditionally — a swapped/stale/corrupted file on disk (wrong
    // session's cache reused, a leftover from a prior interrupted run, manual tampering) would
    // silently ingest under THIS session's identity, with nothing re-verifying it matches what the
    // ledger claims. Re-decode the cached archive and compare its own in-archive hash.md5 (Task 4's
    // extractDatasetFiles) against the ledger row's own dataset_hash — the SAME comparison the
    // fresh-fetch path below performs against a just-downloaded archive.
    const cachedZipBuffer = decodeDatasetZip(datasetEnvelope.zip);
    const cachedVerifyParse = await extractDatasetFiles(cachedZipBuffer);
    if (cachedVerifyParse.datasetHash == null) {
      // A hashless cached archive is the SAME loud, counted condition as the fresh path's own
      // null-hash branch below — never silently trusted either. Not itself thrown (a genuinely
      // hashless archive is not evidence of tampering, only evidence the re-compare couldn't run).
      gate.hashVerification = { verified: false, reason: 'cached_archive_missing_hash_md5' };
    } else if (cachedVerifyParse.datasetHash !== ledgerRow.dataset_hash) {
      throw new DatasetHashMismatchError(
        `ingest-legiscan: cached dataset at ${ledgerRow.local_cache_path} has its own hash.md5 `
          + `(${cachedVerifyParse.datasetHash}) which does not match the legiscan_datasets ledger's `
          + `recorded dataset_hash (${ledgerRow.dataset_hash}) for session ${legiscanSessionId} — a `
          + 'swapped or corrupted local cache file is never trusted silently',
        { legiscanSessionId, expected: ledgerRow.dataset_hash, actual: cachedVerifyParse.datasetHash },
      );
    } else {
      gate.hashVerification = { verified: true };
    }

    return { datasetEnvelope, gate };
  }

  await recordQueryUsage(client, runId, detail); // about to spend the getDataset query
  const datasetEnvelope = await getDatasetFn(legiscanSessionId, entry.access_key, { key: apiKey });

  // CONTROLLER RULING 2 — THE throw site: compare the freshly-fetched archive's OWN hash.md5
  // content (Task 4's decode surface) against the getDatasetList dataset_hash that justified this
  // fetch (entry.dataset_hash). A mismatch means the dataset changed again between the gate check
  // and this call landing (a real mid-run race per legiscan.js's own DatasetHashMismatchError
  // comment) — the dataset is not parsed or persisted on this path.
  const zipBuffer = decodeDatasetZip(datasetEnvelope.zip);
  const verifyParse = await extractDatasetFiles(zipBuffer);
  if (verifyParse.datasetHash == null) {
    // FIX (IMPORTANT 7): previously `verifyParse.datasetHash != null && ...` silently SKIPPED the
    // mandated re-compare whenever the freshly-fetched archive had no hash.md5 at all — the dataset
    // still got cached and ledgered as if verified, manufacturing an unverified future cache hit.
    // Now a loud, counted condition on the gate result instead (never thrown on its own).
    gate.hashVerification = { verified: false, reason: 'fetched_archive_missing_hash_md5' };
  } else if (verifyParse.datasetHash !== entry.dataset_hash) {
    throw new DatasetHashMismatchError(
      `ingest-legiscan: fetched dataset's own hash.md5 (${verifyParse.datasetHash}) does not match the `
        + `getDatasetList dataset_hash (${entry.dataset_hash}) that justified this fetch for session `
        + `${legiscanSessionId} — dataset not parsed or persisted`,
      { legiscanSessionId, expected: entry.dataset_hash, actual: verifyParse.datasetHash },
    );
  } else {
    gate.hashVerification = { verified: true };
  }

  mkdirSync(cacheDir, { recursive: true });
  const cachePath = `${cacheDir}/${legiscanSessionId}-${entry.dataset_hash}.json`;
  writeFileSync(cachePath, JSON.stringify(datasetEnvelope));

  const { error: upsertErr } = await client.from('legiscan_datasets').upsert({
    legiscan_session_id: legiscanSessionId,
    dataset_hash: entry.dataset_hash,
    local_cache_path: cachePath,
    fetched_at: new Date().toISOString(),
    run_id: runId,
  }, { onConflict: 'legiscan_session_id' });
  if (upsertErr && !isMissingRelationError(upsertErr, 'legiscan_datasets')) {
    throw new Error(`ingest-legiscan: legiscan_datasets ledger upsert failed: ${upsertErr.message}`);
  }

  return { datasetEnvelope, gate };
}

// ---- the full orchestrator (usable directly by tests, and by main() below) ----
//
// args: { session, limit, datasetFile } (dryRun is handled by main() itself — this function
// always writes when called, per the brief's own composition step). deps are all injectable for
// testability, same convention as ingest-mo-senate.js's ensureRosterForRun/processJournalDay.
export async function runLegiscanIngest(client, runId, args, deps = {}) {
  const {
    getDatasetListFn = getDatasetList,
    getDatasetFn = getDataset,
    apiKey = process.env.LEGISCAN_API_KEY,
    cacheDir = LEGISCAN_DATASET_CACHE_DIR,
    // crossCheckFn — injectable purely for testability (mirrors getDatasetListFn/getDatasetFn's own
    // convention): real runs always use the real crossCheckAgainstPrimarySource. After Findings 3
    // and 5 (final-review-findings.md), crossCheckAgainstPrimarySource cannot itself produce
    // quarantine:true from any of its own branches anymore (see legiscan-votes.js's Branch B
    // comment) — this seam lets a test exercise retractLegiscanVoteIfStored's real re-run behavior
    // (an ALREADY-STORED vote getting retracted, no manual wipe) without needing to fabricate that
    // scenario through crossCheckAgainstPrimarySource's own now-narrower contract.
    crossCheckFn = crossCheckAgainstPrimarySource,
  } = deps;

  const detail = { queries_used: 0 };
  let datasetEnvelope;
  let gate;

  if (args.datasetFile) {
    // Local no-network smoke path (brief's own worked example): substitutes ONLY the byte source,
    // exactly like ingest-mo-senate.js's --journal-pdf-file. Zero live LegiScan queries, hash gate
    // and local cache machinery both bypassed entirely (nothing to gate — the bytes are already in
    // hand).
    datasetEnvelope = JSON.parse(readFileSync(args.datasetFile, 'utf8')).dataset;
    gate = { shouldFetch: null, reason: 'dataset_file_override' };
  } else {
    const resolved = await resolveDatasetBytes(client, runId, args.session, {
      getDatasetListFn, getDatasetFn, apiKey, cacheDir, detail,
    });
    datasetEnvelope = resolved.datasetEnvelope;
    gate = resolved.gate;
  }

  const zipBuffer = decodeDatasetZip(datasetEnvelope.zip);
  const parsed = await extractDatasetFiles(zipBuffer);

  const sessionResult = await ensureLegiscanSessionRow(client, datasetEnvelope);

  // Era window for person identity resolution (Task 5's sessionWindow) — LegiScan's dataset
  // metadata has no explicit start_date/end_date, only year_start/year_end; a full calendar-year
  // bound is a conservative, honestly-documented approximation (never narrower than the real
  // session, which is what matters for era-overlap — see person-identity.js's eraOverlaps).
  const sessionWindow = {
    startDate: `${datasetEnvelope.year_start}-01-01`,
    endDate: `${datasetEnvelope.year_end ?? datasetEnvelope.year_start}-12-31`,
  };

  const billEnsure = sessionResult.gated
    ? { billRecordByLegiscanBillId: new Map() }
    : await ensureLegiscanBillRows(client, runId, sessionResult.id, parsed.bills);
  const peopleEnsure = await ensureLegiscanPeople(client, runId, parsed.people, sessionWindow);

  const rollCallsToProcess = (typeof args.limit === 'number' && args.limit > 0)
    ? parsed.rollCalls.slice(0, args.limit)
    : parsed.rollCalls;

  const rollCallResult = sessionResult.gated
    ? emptyRollCallResult()
    : await ingestLegiscanRollCalls(client, runId, {
      allRollCalls: parsed.rollCalls,
      rollCallsToProcess,
      legiscanSessionId: datasetEnvelope.session_id,
      billRecordByLegiscanBillId: billEnsure.billRecordByLegiscanBillId,
      legislatorIdByPeopleId: peopleEnsure.legislatorIdByPeopleId,
      crossCheckFn,
    });

  // Brief step 6's literal required shape, PLUS Ruling 7's "must surface distinctly" additions
  // alongside it (quarantinedVotes/quarantinedRollCalls, unresolvedCasts, votesByChamber,
  // crossCheckFlags' own reason breakdown, gate/session state, vote_id 3 spot-verify sample).
  const counts = {
    sessions: 1,
    bills: parsed.bills.length,
    people: peopleEnsure.counts,
    votes: rollCallResult.votes,
    casts: rollCallResult.casts,
    reconciliationFailures: rollCallResult.reconciliationFailures,
    reconciliationFailureDetails: rollCallResult.reconciliationFailureDetails,
    crossCheckFlags: rollCallResult.crossCheckFlags,
    queriesUsed: detail.queries_used,
    quarantinedVotes: rollCallResult.quarantinedVotes,
    quarantinedRollCalls: rollCallResult.quarantinedRollCalls,
    retractedVotes: rollCallResult.retractedVotes,
    retractedRollCalls: rollCallResult.retractedRollCalls,
    unresolvedCasts: rollCallResult.unresolvedCasts,
    votesByChamber: rollCallResult.votesByChamber,
    voteId3SpotVerify: rollCallResult.voteId3SpotVerify,
    parseFailures: parsed.failures.length,
    parseFailureDetails: parsed.failures.map((f) => ({ reason: f.reason, entryName: f.entryName, wrapperKey: f.wrapperKey })),
    session: {
      id: sessionResult.id, identifier: sessionResult.identifier, reason: sessionResult.reason, gated: sessionResult.gated, note: sessionResult.note,
    },
    datasetGate: gate,
    rollCallsPlanned: parsed.rollCalls.length,
    rollCallsProcessed: rollCallsToProcess.length,
  };

  return {
    counts, source: SOURCE, attribution: ATTRIBUTION, datasetSessionId: datasetEnvelope.session_id, datasetSessionTitle: datasetEnvelope.session_title,
  };
}

// ---- dry-run: local plan from a dataset file, zero live queries, zero writes ----

export function planFromParsedDataset(parsed, datasetEnvelope) {
  return {
    session_id: datasetEnvelope.session_id,
    session_title: datasetEnvelope.session_title,
    bills_planned: parsed.bills.length,
    people_planned: parsed.people.length,
    roll_calls_planned: parsed.rollCalls.length,
    parse_failures: parsed.failures.length,
    writes: 0,
  };
}

// ---- dry-run: DB-state-only report (no dataset file — mirrors ingest-mo-senate.js's dryRunReport) ----

export async function dryRunReportFromDb(client, legiscanSessionId) {
  if (!legiscanSessionId) {
    return { note: '--session <legiscan_session_id> is required for a DB-state dry-run report (or use --dataset-file for a local-fixture plan)' };
  }
  const { data: ledgerRow, error: ledgerErr } = await client.from('legiscan_datasets')
    .select('legiscan_session_id,dataset_hash,fetched_at')
    .eq('legiscan_session_id', legiscanSessionId).maybeSingle();
  if (ledgerErr && !isMissingRelationError(ledgerErr, 'legiscan_datasets')) {
    throw new Error(`ingest-legiscan dry-run ledger lookup failed: ${ledgerErr.message}`);
  }
  const { data: sessionRow, error: sessErr } = await client.from('sessions')
    .select('id,identifier,name')
    .eq('legiscan_session_id', legiscanSessionId).maybeSingle();
  if (sessErr && !isMissingColumnError(sessErr, 'legiscan_session_id')) {
    throw new Error(`ingest-legiscan dry-run session lookup failed: ${sessErr.message}`);
  }
  let voteCount = 0;
  if (sessionRow) {
    const { count, error: countErr } = await client.from('votes')
      .select('id', { count: 'exact', head: true })
      .like('source_key', `legiscan-${legiscanSessionId}-rollcall-%`);
    if (countErr) throw new Error(`ingest-legiscan dry-run votes count failed: ${countErr.message}`);
    voteCount = count ?? 0;
  }
  return {
    ledger: (ledgerErr || !ledgerRow) ? null : { dataset_hash: ledgerRow.dataset_hash, fetched_at: ledgerRow.fetched_at },
    session_row: (sessErr || !sessionRow) ? null : sessionRow,
    counts: { votes_total: voteCount },
    note: 'counts computed from DB state only — zero live queries made this invocation, per --dry-run',
  };
}

// ---- budget gate (brief step 1: getMonthlyQueryUsage + assertUnderBudget BEFORE any live call) ----
//
// Extracted as its own function so the refusal itself is directly unit-testable against a fake
// ingestion_runs client, independent of process.argv/getClient() — proves the gate throws (and
// therefore main() never reaches runLegiscanIngest, since this call sits before it in the same
// try block with no other await in between) without needing a live DB or a live LegiScan call.
export async function assertRunUnderBudget(client, { source = SOURCE, plannedQueries, capPerMonth } = {}) {
  const cap = capPerMonth ?? (Number(process.env.LEGISCAN_MONTHLY_QUERY_CAP) || DEFAULT_MONTHLY_QUERY_CAP);
  const usage = await getMonthlyQueryUsage(client, { source });
  assertUnderBudget(usage, plannedQueries, cap);
  return { usage, plannedQueries, capPerMonth: cap };
}

// ---- closeRun payload helpers (CRITICAL 1, final-review-findings.md) ----
//
// closeRun (src/lib/db.js) REPLACES detail jsonb wholesale — relied on repo-wide (every CLI driver
// in this codebase passes closeRun its own complete detail object; changing closeRun to MERGE
// instead would silently change behavior for every one of them, a much larger blast radius than
// this bug needs). The actual defect: recordQueryUsage's write-ahead persists
// detail.queries_used (SNAKE_CASE, what getMonthlyQueryUsage reads) during the run, but main()'s own
// closeRun call on both success (`{...result.counts, attribution}`) and failure (`{error}`) never
// included that key at all — result.counts carries `queriesUsed` (CAMELCASE, a different field
// entirely) — so closeRun's final wholesale replace silently erased the ledger back to 0 on every
// completed run, undercounting getMonthlyQueryUsage forever (the unsafe direction; Ruling 3 requires
// "crash must overcount, never undercount"). FIX: main() carries queries_used forward into BOTH
// close payloads, extracted here as its own functions so this exact composition (recordQueryUsage ->
// closeRun -> getMonthlyQueryUsage) is directly unit-testable, same "extract for testability without
// needing process.argv/getClient()" precedent as assertRunUnderBudget above.
export function buildSuccessCloseDetail(counts) {
  return { ...counts, attribution: ATTRIBUTION, queries_used: counts.queriesUsed };
}

export async function buildFailureCloseDetail(client, runId, err) {
  // Best-effort re-read of whatever the write-ahead path already persisted — survives even a
  // runLegiscanIngest throw, since recordQueryUsage's own write happens BEFORE the live call it
  // counts, not after. A re-read failure here must never mask the ORIGINAL error being closed out.
  let queriesUsedSoFar = 0;
  try {
    const { data: runRow } = await client.from('ingestion_runs').select('detail').eq('id', runId).maybeSingle();
    queriesUsedSoFar = Number(runRow?.detail?.queries_used) || 0;
  } catch { /* best-effort only — the original err below is what matters */ }
  return { error: String(err), queries_used: queriesUsedSoFar };
}

// ---- main ----

async function main() {
  const args = parseLegiscanArgs(process.argv.slice(2));

  if (args.dryRun && args.datasetFile) {
    const datasetEnvelope = JSON.parse(readFileSync(args.datasetFile, 'utf8')).dataset;
    const zipBuffer = decodeDatasetZip(datasetEnvelope.zip);
    const parsed = await extractDatasetFiles(zipBuffer);
    console.log(JSON.stringify({
      mode: 'dry-run',
      source: SOURCE,
      dataset_file: args.datasetFile,
      plan: planFromParsedDataset(parsed, datasetEnvelope),
      note: 'local fixture parse only — zero live queries, zero DB writes',
    }, null, 2));
    return;
  }

  const client = getClient();

  if (args.dryRun) {
    if (!client) {
      console.log(JSON.stringify({
        mode: 'dry-run', source: SOURCE, note: 'no DB client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset) — cannot report DB state; zero live queries made',
      }, null, 2));
      return;
    }
    const report = await dryRunReportFromDb(client, args.session);
    console.log(JSON.stringify({ mode: 'dry-run', source: SOURCE, session: args.session, ...report }, null, 2));
    return;
  }

  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const runId = await openRun(client, SOURCE);
  try {
    // Brief step 1: getMonthlyQueryUsage + assertUnderBudget BEFORE any live call. A
    // --dataset-file run spends zero LegiScan queries regardless of outcome, so it plans for 0;
    // every other run plans for the worst case (PLANNED_QUERIES_PER_RUN) since we don't yet know
    // whether the hash gate will skip the getDataset call. This is the ONLY statement between
    // openRun and runLegiscanIngest — a refusal here means runLegiscanIngest (and therefore every
    // live LegiScan call and every DB write it could make) is never reached.
    const plannedQueries = args.datasetFile ? 0 : PLANNED_QUERIES_PER_RUN;
    // MINOR 2 (Task 9 review, accepted as intentional-conservative, not a bug): a --dataset-file
    // run still calls assertRunUnderBudget even though plannedQueries=0 here means it can never
    // itself push usage over the cap — so a month that has ALREADY breached the cap from other
    // (live) runs still refuses a zero-cost fixture-driven run too, rather than carving out an
    // exception. Deliberate: refusal semantics stay uniform and simple to reason about (one gate,
    // no special cases to remember), and it avoids a cap-breached month quietly continuing to run
    // local-fixture backfills that would normally accompany live catches.
    await assertRunUnderBudget(client, { plannedQueries });

    const result = await runLegiscanIngest(client, runId, args);

    const status = (result.counts.reconciliationFailures === 0 && result.counts.parseFailures === 0) ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, buildSuccessCloseDetail(result.counts));
    console.log(JSON.stringify({
      mode: 'live', run_id: runId, status, source: SOURCE, counts: result.counts,
    }, null, 2));
    if (status !== 'succeeded') process.exitCode = 2;
  } catch (err) {
    await closeRun(client, runId, 'failed', await buildFailureCloseDetail(client, runId, err));
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
