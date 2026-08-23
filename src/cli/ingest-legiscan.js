import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {
  getClient, openRun, closeRun, insertIfAbsent, additivePatch, selectAll,
  isMissingColumnError, isMissingRelationError,
} from '../lib/db.js';
import {
  SOURCE, ATTRIBUTION, getDatasetList, getDataset, decodeDatasetHashGate,
  getMonthlyQueryUsage, assertUnderBudget, DatasetHashMismatchError, ALL_LEGISCAN_SOURCES,
} from '../adapters/legiscan.js';
import {
  decodeDatasetZip, extractDatasetFiles, normalizeBillIdentifier,
} from '../adapters/legiscan-dataset.js';
import { resolveOrCreateLegiscanPerson } from '../adapters/legiscan-identity.js';
import {
  reconcileLegiscanTallies, buildLegiscanVoteSourceKey, buildLegiscanVoteCasts,
  crossCheckAgainstPrimarySource, LegiscanRollCallReconcileError, VoteIdMapError,
  LegiscanRollCallDateError,
} from '../adapters/legiscan-votes.js';
// mapMoStatusCode — data-corrections task (.superpowers/sdd/2026-07-31-data-corrections/brief.md),
// "fix the writer too": the SAME manual-sourced constant correct-data.js uses to CORRECT the
// ~37,662 already-numeric rows, imported here (never a second copy) so a bill first-seen by THIS
// driver from now on stores LegiScan's printed status WORD, not its bare numeric code — the
// regression correct-data.js's own live pass would otherwise be undone by the very next ingest run.
// Imported from src/lib (not correct-data.js directly) since senior engineering audit 2026-08-03,
// finding 16 — this exact import used to be one edge of a genuine 3-node cli/cli import cycle.
import { mapMoStatusCode } from '../lib/mo-status-codes.js';

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
// Exported (2026-08-02, review finding) so any OTHER driver scanning the shared `sessions` table
// for year+name candidates can exclude rows THIS driver minted for a Special session — see
// ensureSessionRow's own candidate filter in ingest-mo-senate.js for why this matters there too:
// the risk isn't whether that driver has its own special-session concept, it's that this table is
// shared and already contains special-session rows this pattern must keep excluding everywhere.
export const SPECIAL_IDENTIFIER_PATTERN = /-special-\d+$/;

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
    // LegiScan's own `status` is a numeric lifecycle code. FIX (data-corrections task, "fix the
    // writer too"): codes 1-6 are now decoded to their printed word via mapMoStatusCode — the SAME
    // manual-sourced mapping (LegiScan API User Manual p.42) correct-data.js's mo-status correction
    // uses on the already-ingested rows, so re-ingestion never reintroduces a numeric code for a
    // bill this driver first-sees. Code 0 (no honest single word — "N/A pre-filed") and 7-12
    // (progress-array-only per the manual, never a bill's overall status) fall back to storing the
    // code verbatim — mapMoStatusCode returns null for exactly those, by design, never a guess.
    // `status_date` is not persisted (bills table has no column for it).
    status: b.status != null ? (mapMoStatusCode(b.status) ?? String(b.status)) : null,
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

// The House roll-call PDF link prints the legislative day: '.../rollcalls/047.012.pdf' = day 47.
// Senate links ('RDay<N>...pdf#...') are journal pages, not this scheme -> null.
const HOUSE_ROLLCALL_PDF_DAY_RE = /\/rollcalls\/(\d{1,3})\.\d{1,3}\.pdf$/i;
export function legislativeDayOf(billRecord, rollCallId) {
  const entry = (billRecord?.votes ?? []).find((v) => v.roll_call_id === rollCallId);
  const m = HOUSE_ROLLCALL_PDF_DAY_RE.exec(String(entry?.state_link ?? ''));
  return m ? Number(m[1]) : null;
}

// Read back the row standing under a source_key: id + vote_date + the 0032 receipt, falling back
// to `id` alone while the column does not exist yet (PGRST204), so printed-date stores keep
// working before the migration and the gate above stays the only place that refuses.
async function selectStoredVote(client, sourceKey) {
  const full = await client.from('votes').select('id,vote_date,vote_date_provenance').eq('source_key', sourceKey).single();
  if (!full.error) return full.data;
  if (isMissingColumnError(full.error, 'vote_date_provenance')) {
    const { data, error } = await client.from('votes').select('id').eq('source_key', sourceKey).single();
    if (error) throw new Error(`ingest-legiscan: vote lookup failed for ${sourceKey}: ${error.message}`);
    return { id: data.id, vote_date: null, vote_date_provenance: null };
  }
  throw new Error(`ingest-legiscan: vote lookup failed for ${sourceKey}: ${full.error.message}`);
}

function emptyRollCallResult() {
  return {
    votes: 0,
    votesByChamber: { house: 0, senate: 0 },
    casts: 0,
    reconciliationFailures: 0,
    reconciliationFailureDetails: [],
    // 2026-08-23: sentinel-dated roll calls dated from the bill history (Tier 1 tally match) and
    // stored WITH their receipt; `datesDerivedGated` counts the ones refused because migration
    // 0032's votes.vote_date_provenance column is not there yet (re-run stores them).
    datesDerived: 0, // stored this run WITH their receipt (verified by reading the row back)
    datesDerivedGated: 0, // refused: 0032's column absent
    datesDerivedConflicts: 0, // refused: contradicted another derived date on the same legislative day, or day order
    datesDerivedPreexisting: 0, // a row already stood under the source_key; the derivation was not written
    datesSuperseded: 0, // a previously derived date replaced by a now-printed one
    datesDerivedDetails: [],
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

// Exported (2026-08-23) so the migration-0032 gate and the derived-date path can be tested against
// a real-fixture roll-call set without a full dataset envelope; runLegiscanIngest remains the only
// production caller.
export async function ingestLegiscanRollCalls(client, runId, {
  allRollCalls, rollCallsToProcess, legiscanSessionId, billRecordByLegiscanBillId, legislatorIdByPeopleId,
  sessionYears,
  crossCheckFn = crossCheckAgainstPrimarySource,
}) {
  // FINAL REVIEW, finding 3: sessionYears is REQUIRED here, not defaulted. The date gate is only
  // as good as the bounds it is handed, and a silently-absent bound would degrade it to a shape
  // check while still looking present — a caller that forgets it is a programming error and says
  // so, rather than quietly ingesting another decade's worth of epoch sentinels.
  if (!sessionYears || sessionYears.yearStart == null) {
    throw new Error(
      'ingest-legiscan: ingestLegiscanRollCalls requires sessionYears {yearStart, yearEnd} from the '
        + "dataset envelope's own year_start/year_end — the roll-call date gate cannot run without them",
    );
  }
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
  // 2026-08-23: every roll call of a bill, for deriveDateFromHistory's two-sided uniqueness (a
  // sibling printing the same tally makes any single history action ambiguous as to WHICH vote).
  const rollCallsByBillId = new Map();
  for (const rc of allRollCalls) {
    const list = rollCallsByBillId.get(rc.bill_id) ?? [];
    list.push(rc);
    rollCallsByBillId.set(rc.bill_id, list);
  }
  for (const rollCall of allRollCalls) {
    const isSelected = toProcessIds.has(rollCall.roll_call_id);
    // checkVoteId3Sighting runs unconditionally for a selected roll call, even one that goes on to
    // fail reconciliation — a printed vote_id 3 is real source data regardless of whether the REST
    // of that roll call's own numbers happen to reconcile.
    if (isSelected) checkVoteId3Sighting(rollCall, result.voteId3SpotVerify);

    let legiscanTallies;
    try {
      // 2026-08-23: the bill's own printed history lets a sentinel-dated roll call be dated by an
      // exact tally match (deriveDateFromHistory, Tier 1 only) — the record is already in hand, so
      // this costs nothing and never fetches. A roll call whose bill is not in the dataset keeps
      // the plain refusal path.
      const history = billRecordByLegiscanBillId.get(rollCall.bill_id)?.record?.history ?? null;
      legiscanTallies = reconcileLegiscanTallies(rollCall, sessionYears, { history, siblingRollCalls: rollCallsByBillId.get(rollCall.bill_id) ?? [] });
    } catch (err) {
      if (err instanceof LegiscanRollCallReconcileError || err instanceof VoteIdMapError
        || err instanceof LegiscanRollCallDateError) {
        // Internal gate (a) failure — skipped, never stored, same convention as every prior parser
        // in this repo (mo-rollcall-pdf.js's parseMoRollCall, mo-senate-journal-pdf.js's
        // parseJournalVotes). LegiscanRollCallDateError (finding 3) rides the SAME path on purpose:
        // an out-of-session printed date is the same class of source self-contradiction as a tally
        // that doesn't add up, and gets the same treatment — refused, counted, detailed, never
        // corrected into looking plausible. Not part of the sibling-grouping pool either (no
        // reliable tallies exist to compare against) — only counted as a failure when this run was
        // actually going to process it.
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

  // Phase 2b (2026-08-23): legislative-day gate over the DERIVED dates in this run. A House roll
  // call's PDF link prints its legislative day ('.../rollcalls/047.012.pdf' = day 47, roll call
  // 12), a second printed source the derivation can be held to: every derived date on one
  // legislative day must be the same calendar date, and legislative days must not run backwards
  // in time. Any group that contradicts either is refused whole (counted datesDerivedConflicts)
  // — never "pick one". The day number rides in the receipt as `legislative_day`.
  const derivedByDay = new Map();
  for (const entry of reconciledToProcess) {
    const prov = entry.legiscanTallies.dateProvenance;
    if (!prov) continue;
    const day = legislativeDayOf(entry.billEntry.record, entry.legiscanTallies.rollCallId);
    prov.legislative_day = day;
    if (day === null) continue;
    const key = `${entry.legiscanTallies.chamber}|${day}`;
    const group = derivedByDay.get(key) ?? { chamber: entry.legiscanTallies.chamber, day, entries: [] };
    group.entries.push(entry);
    derivedByDay.set(key, group);
  }
  const refusedConflicts = new Set();
  const groups = [...derivedByDay.values()];
  for (const g of groups) {
    const dates = [...new Set(g.entries.map((e) => e.legiscanTallies.date))];
    if (dates.length > 1) for (const e of g.entries) refusedConflicts.add(e);
  }
  for (const chamber of new Set(groups.map((g) => g.chamber))) {
    const ordered = groups.filter((g) => g.chamber === chamber && !g.entries.some((e) => refusedConflicts.has(e))).sort((a, b) => a.day - b.day);
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i].entries[0].legiscanTallies.date < ordered[i - 1].entries[0].legiscanTallies.date) {
        for (const e of [...ordered[i - 1].entries, ...ordered[i].entries]) refusedConflicts.add(e);
      }
    }
  }
  if (refusedConflicts.size > 0) {
    for (const e of refusedConflicts) {
      result.datesDerivedConflicts += 1;
      if (result.datesDerivedDetails.length < 10) {
        result.datesDerivedDetails.push({
          rollCallId: e.legiscanTallies.rollCallId, conflict: true, date: e.legiscanTallies.date, legislative_day: e.legiscanTallies.dateProvenance.legislative_day, action: e.legiscanTallies.dateProvenance.action.action,
        });
      }
    }
    const keep = reconciledToProcess.filter((e) => !refusedConflicts.has(e));
    reconciledToProcess.length = 0;
    reconciledToProcess.push(...keep);
  }

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
      // A derived date NEVER lands without its receipt (migration 0032). The key is only present
      // when the date was derived, so every printed-date vote inserts exactly as before — with or
      // without the column.
      ...(legiscanTallies.dateProvenance ? { vote_date_provenance: legiscanTallies.dateProvenance } : {}),
    };
    try {
      // eslint-disable-next-line no-await-in-loop
      await insertIfAbsent(client, 'votes', [voteRow], 'source_key');
    } catch (err) {
      if (legiscanTallies.dateProvenance && isMissingColumnError(err.cause ?? err, 'vote_date_provenance')) {
        // Migration 0032 not applied yet: refuse to store this vote (its date is derived and the
        // receipt has nowhere to live), count it, and move on — re-running after the migration
        // lands stores it. Never silently stored without provenance. The run closes 'partial'.
        result.datesDerivedGated += 1;
        if (result.datesDerivedDetails.length < 10) {
          result.datesDerivedDetails.push({ rollCallId: legiscanTallies.rollCallId, gated: true, date: legiscanTallies.date, action: legiscanTallies.dateProvenance.action.action });
        }
        continue;
      }
      throw err;
    }
    // The row that now stands under this source_key. insertIfAbsent is insert-if-absent (ON
    // CONFLICT DO NOTHING), so a pre-existing row may differ from what was just offered: read
    // vote_date and the receipt back (falling back to `id` alone while 0032's column is absent)
    // and reconcile the two honestly rather than assume the write landed.
    // eslint-disable-next-line no-await-in-loop
    const stored = await selectStoredVote(client, voteRow.source_key);
    const voteSel = { id: stored.id };
    if (legiscanTallies.dateProvenance) {
      const storedDate = String(stored.vote_date ?? '').slice(0, 10);
      if (stored.vote_date_provenance && storedDate === legiscanTallies.date) {
        result.datesDerived += 1;
        if (result.datesDerivedDetails.length < 10) {
          result.datesDerivedDetails.push({ rollCallId: legiscanTallies.rollCallId, date: legiscanTallies.date, printed_date: legiscanTallies.dateProvenance.printed_date, legislative_day: legiscanTallies.dateProvenance.legislative_day, action: legiscanTallies.dateProvenance.action.action });
        }
      } else {
        // A row already existed (a prior printed-date store, or a different derivation) — the
        // derived date was NOT written; count it as pre-existing, never as "stored with receipt".
        result.datesDerivedPreexisting += 1;
        if (result.datesDerivedDetails.length < 10) {
          result.datesDerivedDetails.push({ rollCallId: legiscanTallies.rollCallId, preexisting: true, stored_date: storedDate, stored_has_receipt: Boolean(stored.vote_date_provenance), derived_date: legiscanTallies.date });
        }
      }
    } else if (stored.vote_date_provenance && String(stored.vote_date ?? '').slice(0, 10) !== legiscanTallies.date) {
      // The source now PRINTS a date for a roll call previously stored under a derived one: the
      // printed date supersedes the derivation and the receipt is cleared.
      // eslint-disable-next-line no-await-in-loop
      const { error: supErr } = await client.from('votes').update({ vote_date: legiscanTallies.date, vote_date_provenance: null }).eq('id', stored.id);
      if (supErr) throw new Error(`ingest-legiscan: superseding derived date failed for ${voteRow.source_key}: ${supErr.message}`);
      result.datesSuperseded += 1;
    }

    // Severity/dedup follow-up (2026-08-03): a clean primary-source correspondence marks the
    // duplicate additively — both rows stay stored, forever, fully traceable (vote_duplicates,
    // migration 0022). Gated on `matched` (set on EVERY clean-match branch in
    // crossCheckAgainstPrimarySource, including the plain singleton/singleton one that carries no
    // `reason` at all) — never on `reason`, which only distinguishes HOW disambiguation happened
    // and is not set on every clean-match branch. insertIfAbsent on superseded_vote_id (its own
    // unique constraint) makes this safe to re-run: an already-marked pair is a harmless no-op,
    // never a duplicate-key error.
    if (crossCheck.matched && crossCheck.primaryVoteId) {
      // eslint-disable-next-line no-await-in-loop
      await insertIfAbsent(client, 'vote_duplicates', [{
        canonical_vote_id: crossCheck.primaryVoteId,
        superseded_vote_id: voteSel.id,
        reason: 'legiscan-vs-primary-source tally_unique_match at ingest',
      }], 'superseded_vote_id');
    }

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

  // FINAL REVIEW, finding 3: the SAME two envelope fields, in their raw year form, bound the
  // roll-call date gate (legiscan-votes.js's assertRollCallDateWithinSession). Read from the
  // envelope, never from a hardcoded "plausible" range — the dataset's own declaration of what
  // session this is IS the thing a roll call's printed date has to be consistent with.
  const sessionYears = {
    yearStart: datasetEnvelope.year_start,
    yearEnd: datasetEnvelope.year_end ?? datasetEnvelope.year_start,
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
      sessionYears,
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
    // 2026-08-23: derived-date accounting (migration 0032) — surfaced here so ingestion_runs.detail,
    // the console JSON, and the status decision all see it.
    datesDerived: rollCallResult.datesDerived,
    datesDerivedGated: rollCallResult.datesDerivedGated,
    datesDerivedConflicts: rollCallResult.datesDerivedConflicts,
    datesDerivedPreexisting: rollCallResult.datesDerivedPreexisting,
    datesSuperseded: rollCallResult.datesSuperseded,
    datesDerivedDetails: rollCallResult.datesDerivedDetails,
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

// runLegiscanBudgetGate — main()'s OWN pre-flight budget gate (brief step 1: getMonthlyQueryUsage +
// assertUnderBudget BEFORE any live call), extracted as its own function so THIS EXACT composition
// is directly unit-testable, same "extract for testability without needing process.argv/
// getClient()" precedent as assertRunUnderBudget/buildSuccessCloseDetail/closeRunOnFailure below.
//
// TODO-33 (source split, .superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/brief.md,
// part 2 — the LOAD-BEARING part of that fix): passes source: ALL_LEGISCAN_SOURCES, never the bare
// SOURCE default. ingest-legiscan-texts.js now writes its own distinct 'legiscan-texts' label, but
// both CLIs still spend queries against the SAME real LegiScan account/30,000-per-month cap
// (docs/research/2026-07-28-legiscan-terms.md, Rule 1) — this driver's own pre-flight check must
// see the TRUE combined total (this run's own past spend AND the OTHER CLI's), never just its own
// half, or a manual ingest-legiscan-texts.js run could push the real account past its real cap
// without THIS driver's own refusal ever noticing.
export async function runLegiscanBudgetGate(client, args) {
  const plannedQueries = args.datasetFile ? 0 : PLANNED_QUERIES_PER_RUN;
  return assertRunUnderBudget(client, { plannedQueries, source: ALL_LEGISCAN_SOURCES });
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
  //
  // FIX (coordinator ruling, IMPORTANT-1, live-execution-proven): the original version destructured
  // ONLY {data} from this re-read, discarding `error` entirely — postgrest-js RESOLVES (never
  // throws) on a query failure, so a transient 500/504/statement-timeout (Postgres 57014,
  // "query_canceled") on THIS SINGLE select silently produced queriesUsedSoFar=0 regardless of the
  // real ledger value. Since closeRun wholesale-REPLACES detail (never merges — see closeRun's own
  // header comment in src/lib/db.js), a caller writing that false 0 through closeRun would ERASE the
  // true write-ahead-persisted count from getMonthlyQueryUsage's sum — the undercount direction the
  // terms call a violation, and one that could let a LATER run pass a budget gate that should have
  // refused. Proven by execution: a 6-query run closed with detail.queries_used=0 while
  // counts.queriesSpent=6.
  //
  // FIX: a read ERROR is now distinguished from "genuinely no row / no queries yet" —
  // ledgerReadFailed:true (+ ledgerReadError, the raw message) signals every caller of this function
  // to skip closeRun entirely and leave the run 'running' rather than close over an unverifiable
  // value — getMonthlyQueryUsage sums detail.queries_used regardless of status (see its own header
  // comment), so the row's own last-known-good write-ahead value keeps counting correctly without
  // this function ever needing to guess at it. See closeRunOnFailure below for the composition that
  // acts on this signal.
  let queriesUsedSoFar = 0;
  let ledgerReadFailed = false;
  let ledgerReadError = null;
  try {
    const { data: runRow, error: readErr } = await client.from('ingestion_runs').select('detail').eq('id', runId).maybeSingle();
    if (readErr) {
      ledgerReadFailed = true;
      ledgerReadError = readErr.message ?? String(readErr);
    } else {
      queriesUsedSoFar = Number(runRow?.detail?.queries_used) || 0;
    }
  } catch (cause) {
    ledgerReadFailed = true;
    ledgerReadError = cause?.message ?? String(cause);
  }
  return {
    error: String(err), queries_used: queriesUsedSoFar, ledgerReadFailed, ledgerReadError,
  };
}

// closeRunOnFailure — the composition main() uses after a throw: never closes over an unverifiable
// ledger. When the DB re-read itself failed (ledgerReadFailed), closing would risk wholesale-
// replacing a real nonzero detail with a false zero (closeRun never merges) — so this deliberately
// does NOT closeRun in that case, leaving the row 'running' with whatever detail.queries_used the
// write-ahead path already durably persisted; getMonthlyQueryUsage sums that regardless of status.
// Every other case closes normally. Extracted as its own function so this exact decision is
// directly unit-testable, same "extract for testability" precedent as buildSuccessCloseDetail/
// buildFailureCloseDetail themselves.
export async function closeRunOnFailure(client, runId, err) {
  const closeDetail = await buildFailureCloseDetail(client, runId, err);
  if (closeDetail.ledgerReadFailed) {
    return { closed: false, reason: 'ledger_read_failed', ledgerReadError: closeDetail.ledgerReadError };
  }
  await closeRun(client, runId, 'failed', closeDetail);
  return { closed: true, closeDetail };
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
    // MINOR 2 (Task 9 review, accepted as intentional-conservative, not a bug): a --dataset-file
    // run still calls the budget gate even though plannedQueries=0 here means it can never itself
    // push usage over the cap — so a month that has ALREADY breached the cap from other (live) runs
    // still refuses a zero-cost fixture-driven run too, rather than carving out an exception.
    // Deliberate: refusal semantics stay uniform and simple to reason about (one gate, no special
    // cases to remember), and it avoids a cap-breached month quietly continuing to run local-fixture
    // backfills that would normally accompany live catches.
    // TODO-33: runLegiscanBudgetGate passes source: ALL_LEGISCAN_SOURCES (this CLI's own 'legiscan'
    // label AND ingest-legiscan-texts.js's 'legiscan-texts' label, combined) — see that function's
    // own header comment for why checking against 'legiscan' alone would be dangerous now that the
    // two CLIs write distinct source labels but still share one real LegiScan account/cap.
    await runLegiscanBudgetGate(client, args);

    const result = await runLegiscanIngest(client, runId, args);

    // A gated or conflicting derived date is a refusal the operator must see: 'partial', exit 2.
    const status = (result.counts.reconciliationFailures === 0 && result.counts.parseFailures === 0
      && (result.counts.datesDerivedGated ?? 0) === 0 && (result.counts.datesDerivedConflicts ?? 0) === 0) ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, buildSuccessCloseDetail(result.counts));
    console.log(JSON.stringify({
      mode: 'live', run_id: runId, status, source: SOURCE, counts: result.counts,
    }, null, 2));
    if (status !== 'succeeded') process.exitCode = 2;
  } catch (err) {
    const result = await closeRunOnFailure(client, runId, err);
    if (!result.closed) {
      // FIX (coordinator ruling, IMPORTANT-1): never closeRun over an unverifiable ledger — see
      // closeRunOnFailure's own header comment. The run stays 'running'; its own last-known-good
      // write-ahead detail keeps counting correctly via getMonthlyQueryUsage.
      console.error(
        'WARNING: could not verify the query-usage ledger before closing this run — leaving it '
          + '"running" rather than risk erasing a real nonzero count:',
        result.ledgerReadError,
      );
    }
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
