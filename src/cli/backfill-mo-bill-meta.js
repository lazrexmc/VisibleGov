import { readFileSync } from 'node:fs';
import {
  getClient, openRun, closeRun, additivePatch, isMissingRelationError, isCheckConstraintViolation, selectAll,
} from '../lib/db.js';
import { decodeDatasetZip, extractDatasetFiles, normalizeBillIdentifier } from '../adapters/legiscan-dataset.js';
import { listCachedDatasetFiles } from './backfill-nicknames.js';
// mapMoStatusCode — data-corrections task (.superpowers/sdd/2026-07-31-data-corrections/brief.md),
// "fix the writer too": same rationale as ingest-legiscan.js's own import of this — one exported
// mapping, never a second copy, so a status this backfill fills in from now on is the printed word.
import { mapMoStatusCode } from './correct-data.js';

// backfill-mo-bill-meta — Task 2 of the profile-completeness plan
// (.superpowers/sdd/2026-07-29-profile-completeness/task-2-brief.md). Closes two gaps in the
// already-ingested MO LegiScan data, from the same 31 dataset ZIPs backfill-nicknames.js already
// reads, without a single new LegiScan API query or a single overwrite of an already-set value:
//
//   1. bill_sponsors (migration 0014, draft-then-apply): ingest-legiscan.js's own driver
//      (src/cli/ingest-legiscan.js) never wrote sponsors at all — every bill payload's `sponsors[]`
//      array has sat unused in the cache since that driver's first live run. This CLI is the first
//      code in this repo to persist it.
//   2. bills.status: ingest-legiscan.js's own ensureLegiscanBillRows DOES set status at insert time
//      (`status: b.status != null ? String(b.status) : null`), but only when it is the FIRST writer
//      of that (session_id, identifier) row (insertIfAbsent's ignoreDuplicates:true). MO's two
//      primary-source drivers (ingest-mo-senate.js's bill-ref stub, ingest-mo-house.js's own
//      persistBillDetail) routinely create/patch that SAME row first, often leaving status null
//      (ingest-mo-senate.js's stub: `status: null` verbatim) or filling it from their OWN source's
//      differently-shaped status text — either way, LegiScan's own printed status is discarded the
//      moment insertIfAbsent sees the row already exists. This CLI closes that gap additively.
//
// HARD RULE (same as backfill-nicknames.js): ZERO LegiScan API queries, ever. Reads ONLY the
// dataset ZIPs already cached under .superpowers/artifacts/legiscan-datasets/ by a prior
// ingest-legiscan.js sweep — never calls getDatasetList/getDataset. A missing cache directory, or a
// missing/corrupt individual cache file, is counted honestly (`cacheMissing`) and skipped, never a
// reason to fetch. listCachedDatasetFiles is imported (not reimplemented) from backfill-nicknames.js
// — the same pure filesystem primitive, one definition.
//
// SCALE FORCED A REDESIGN AWAY FROM backfill-nicknames.js's PER-CANDIDATE POINT LOOKUPS (live
// pre-flight probe, 2026-07-29): the 31 cached ZIPs hold 37,756 real bill payloads (not just the two
// small special-session fixtures' 27) and 45,792 real sponsor entries, against a live `bills` table
// of 38,250+ rows — one .maybeSingle() round trip per bill/per sponsor (backfill-nicknames.js's own
// per-withNickname-candidate shape) would be on the order of 130,000 sequential live queries, which
// a real pre-flight timing check showed does not complete in any reasonable time. Global Constraints
// says it plainly: "selectAll for every multi-row read (legislators 1,576; bills 38,250; votes
// 9,900+ — everything is past or near the 1,000 cap)". This file bulk-loads sessions/legislators/
// bills/bill_sponsors ONCE per run via selectAll (src/lib/db.js — already-paginated, deterministic,
// fail-loud-never-truncate) into in-memory Maps, then resolves every bill/sponsor candidate as a
// pure Map lookup — turning ~130,000 round trips into ~45 paginated bulk reads. Writes (a bill's
// status patch, a sponsor insert) still happen one-per-row when dryRun is false, same as everywhere
// else in this codebase — that IS the real, proportional write volume; only the READ side was the
// bottleneck.
//
// JOIN KEY (verified, not guessed): `bills` (migration 0001) has NO legiscan_bill_id column — no
// migration through 0014 ever added one, and DESIGN FREEZE (0014's own header comment, echoed in
// this task's Global Constraints) forbids new per-state identity columns going forward. The only
// reliable join onto an already-created bills row is (session_id, identifier) — the SAME compound
// key ensureLegiscanBillRows (src/cli/ingest-legiscan.js) used to CREATE these rows in the first
// place, built via that file's own `normalizeBillIdentifier(b.bill_number)` (imported here, not
// reimplemented). session_id is resolved via sessions.legiscan_session_id (migration 0010, already
// applied/live — a pre-flight probe confirmed all 31 cached legiscan_session_ids already have a live
// sessions row) — exact match only, never a year/name guess (that guessing belongs solely to
// ensureLegiscanSessionRow's own session-creation path, not to this read-only backfill).
//
// SPONSOR MATCHING (exact key only, CONTROLLER RULING 3 lineage): a sponsor's `people_id` is
// resolved against legislators.legiscan_people_id (migration 0010) via EXACT match ONLY — never name
// matching, never fuzzy matching, anywhere. An unmatched people_id is an honest count
// (`sponsorLegislatorNotFound`), never guessed.
//
// SPONSOR TYPE (fix round 1, 2026-07-29 — verified, not assumed): the two committed fixtures only
// ever show `sponsor_type_id` 1 (27 occurrences, always sponsor_order:1) or 2 (11 occurrences,
// always sponsor_order>=2) — a live pre-flight scan of all 31 real cached archives found the FIRST
// dry-run against production actually surfaced 0 and 3 too (8,124 of 45,792 real MO sponsorships,
// ~18% — see task-2-report.md), both silently discarded as `sponsorTypeUnknown` in the original
// pass. Rather than trust memory for what those mean, the mapping below was re-verified straight
// from the primary source: LegiScan's own API manual (tests/fixtures/research/legiscan/LegiScan_
// API_User_Manual.pdf, page 42, "Static Values > Sponsor Types" table, independently re-extracted
// via pdfjs-dist for this fix round — not copied from a prior session's notes) prints exactly:
//   0 = "Sponsor (Generic / Unspecified)"   1 = "Primary Sponsor"
//   2 = "Co-Sponsor"                         3 = "Joint Sponsor"
// Migration 0015 (controller-drafted, draft-then-apply) widens bill_sponsors.sponsor_type's check
// constraint to match: ('primary','cosponsor','joint','unspecified'). All FOUR now-verified values
// map mechanically (SPONSOR_TYPE_MAP below) — nothing is discarded as unknown anymore. Only a value
// genuinely outside {0,1,2,3} (never observed anywhere, not in LegiScan's own documented lookup) is
// still a typed, counted skip (`sponsorTypeUnknown`) — the distinction the brief draws as "fail loud
// on genuinely unknown, never on known-but-unmapped": every KNOWN LegiScan sponsor type now has a
// mapped destination, so "known-but-unmapped" can no longer happen.
//
// PRE-0015 TOLERANCE: `loadSponsorIndex`'s own bulk SELECT can only detect the 0014 whole-table gate
// (a CHECK constraint says nothing until something actually violates it) — so a live run reaching a
// 'joint'/'unspecified' sponsor row before migration 0015 lands will hit the OLD, narrower
// `bill_sponsors_sponsor_type_check` constraint on that specific INSERT (Postgres 23514). This is
// caught (`isCheckConstraintViolation`, src/lib/db.js) and named honestly as its own gated state
// (`sponsorType0015Gated`) — distinct from the 0014 table-missing gate, never a crash, never lumped
// in with an unrelated failure. 'primary'/'cosponsor' rows are unaffected either way (both migrations
// always allow them) — only 'joint'/'unspecified' candidates are held back pre-0015.
//
// STATUS (never invented): ingest-legiscan.js's own ensureLegiscanBillRows comment states it
// plainly — "LegiScan's own `status` is a numeric lifecycle code (no house-style label mapping
// exists in this codebase for it, and inventing one would be a guess) — stored as printed,
// verbatim". This CLI mirrors that EXACT convention (`String(bill.status)`) rather than inventing a
// parallel labeling scheme. `status_date` and the bill's own last `history[]` entry are both present
// in the payload and were considered, but bills has no destination column for either (same as
// ingest-legiscan.js's own status_date note) — nothing is invented to make room for them; only
// `status` is written, additively (additivePatch: fills null only, never overwrites an
// already-set value from either MO primary-source driver).
//
// GATING: bill_sponsors is migration 0014, draft-then-apply. The bulk sponsor-table load
// (loadSponsorIndex) is the ONE place this is checked — isMissingRelationError on that single
// selectAll call decides gating for the entire run, before the per-bill loop even starts (simpler
// than backfill-nicknames.js's own "gate fires on the first candidate" dance, and just as honest: a
// missing table is a run-wide fact, not a per-row one). bills.status writes are UNGATED — the
// `bills.status` column has existed since migration 0001 (already live).

const CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';
const SOURCE = 'backfill-mo-bill-meta';

export function parseArgs(argv) {
  const out = { dryRun: false };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

// ---- local cache: decode (zero network, zero API queries) ----

// readCachedDatasetBills — one cache file -> { ok:true, filePath, sessionId, bills } or
// { ok:false, filePath } (file missing/unreadable/malformed JSON/undecodable ZIP/unparseable
// archive) — never throws. Mirrors backfill-nicknames.js's own readCachedDatasetPeople exactly
// (same decode surface: JSON.parse -> decodeDatasetZip -> extractDatasetFiles), extracting `bills`
// instead of `people` — a sibling function, not a shared one, since the two files' extraction
// targets genuinely differ and forcing a shared return shape would just push the caller back into
// picking which field matters.
export async function readCachedDatasetBills(filePath, { readFileFn = readFileSync } = {}) {
  let raw;
  try {
    raw = readFileFn(filePath, 'utf8');
  } catch {
    return { ok: false, filePath };
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { ok: false, filePath };
  }
  try {
    const zipBuffer = decodeDatasetZip(envelope.zip);
    const parsed = await extractDatasetFiles(zipBuffer);
    return { ok: true, filePath, sessionId: envelope.session_id, bills: parsed.bills ?? [] };
  } catch {
    return { ok: false, filePath };
  }
}

// ---- sponsor field mapping (verified against LegiScan's own API manual — see SPONSOR TYPE header
// comment; migration 0015 widens bill_sponsors.sponsor_type to match all four) ----

const SPONSOR_TYPE_MAP = {
  0: 'unspecified', 1: 'primary', 2: 'cosponsor', 3: 'joint',
};

export function mapSponsorType(sponsorTypeId) {
  return SPONSOR_TYPE_MAP[sponsorTypeId] ?? null;
}

// The bill_sponsors.sponsor_type check constraint's own name (migrations 0014/0015) — named here
// once so isCheckConstraintViolation's call site and any test both reference the same literal.
const SPONSOR_TYPE_CHECK_CONSTRAINT = 'bill_sponsors_sponsor_type_check';

// extractBillSponsorCandidates — one bill's `sponsors[]` -> raw { peopleId, sponsorTypeId } pairs,
// UNFILTERED and UNMAPPED (unlike extractNicknamePeople's redundancy filter in backfill-nicknames.js
// — every sponsor entry here is worth a resolution attempt, since even an unrecognized
// sponsor_type_id needs its own honest counted bucket, not a silent drop at extraction time). The
// sponsor_type_id -> 'primary'/'cosponsor' mapping and the "unknown type" count both happen in the
// orchestrator below, alongside every other resolution outcome.
export function extractBillSponsorCandidates(bill) {
  const out = [];
  for (const sponsor of bill?.sponsors ?? []) {
    out.push({ peopleId: sponsor.people_id, sponsorTypeId: sponsor.sponsor_type_id });
  }
  return out;
}

// ---- bulk index loaders (selectAll — see SCALE header comment above) ----

// loadSessionIndex -> Map<legiscan_session_id, { id: sessionRowId }>. Never creates or guesses a
// session row (that is ensureLegiscanSessionRow's job, in ingest-legiscan.js, not this read-only
// backfill's) — rows with no legiscan_session_id set are simply not indexed.
export async function loadSessionIndex(client) {
  const { data, error } = await selectAll(client, 'sessions', 'id,legiscan_session_id');
  if (error) throw new Error(`backfill-mo-bill-meta: sessions bulk load failed: ${error.message}`);
  const index = new Map();
  for (const row of data) {
    if (row.legiscan_session_id != null) index.set(row.legiscan_session_id, { id: row.id });
  }
  return index;
}

// loadLegislatorIndex -> Map<legiscan_people_id, legislatorRowId>. Exact key only (CONTROLLER
// RULING 3 lineage: zero fuzzy/name matching anywhere in this codebase's identity machinery).
export async function loadLegislatorIndex(client) {
  const { data, error } = await selectAll(client, 'legislators', 'id,legiscan_people_id');
  if (error) throw new Error(`backfill-mo-bill-meta: legislators bulk load failed: ${error.message}`);
  const index = new Map();
  for (const row of data) {
    if (row.legiscan_people_id != null) index.set(row.legiscan_people_id, row.id);
  }
  return index;
}

// loadBillIndex -> Map<"${sessionRowId}|${identifier}", { id, status }>. Keyed by the SAME compound
// key ensureLegiscanBillRows used to create the row (see JOIN KEY header comment) — carries `status`
// so the orchestrator never issues a second read just to compute the additive patch.
export async function loadBillIndex(client) {
  const { data, error } = await selectAll(client, 'bills', 'id,session_id,identifier,status');
  if (error) throw new Error(`backfill-mo-bill-meta: bills bulk load failed: ${error.message}`);
  const index = new Map();
  for (const row of data) {
    index.set(`${row.session_id}|${row.identifier}`, { id: row.id, status: row.status });
  }
  return index;
}

// loadSponsorIndex -> { gated:true, index:null } when migration 0014 is unapplied (bill_sponsors
// does not exist), otherwise { gated:false, index: Map<"${billRowId}|${legislatorId}", { id }> }.
// The ONE place this run decides gating — see GATING header comment.
export async function loadSponsorIndex(client) {
  const { data, error } = await selectAll(client, 'bill_sponsors', 'id,bill_id,legislator_id');
  if (error) {
    if (isMissingRelationError(error, 'bill_sponsors')) return { gated: true, index: null };
    throw new Error(`backfill-mo-bill-meta: bill_sponsors bulk load failed: ${error.message}`);
  }
  const index = new Map();
  for (const row of data) {
    index.set(`${row.bill_id}|${row.legislator_id}`, { id: row.id });
  }
  return { gated: false, index };
}

// ---- orchestration ----

function emptyCounts() {
  return {
    billsSeen: 0,
    sessionNotFound: 0,
    billNotFound: 0,
    statusMissingInSource: 0,
    statusAlreadySet: 0,
    statusPatched: 0,
    sponsorsSeen: 0,
    sponsorTypeUnknown: 0,
    sponsorLegislatorNotFound: 0,
    sponsorAlreadyExists: 0,
    sponsorGated: 0,
    // sponsorType0015Gated — fix round 1, pre-0015 tolerance: a 'joint'/'unspecified' candidate
    // that hit the OLD (0014-only) check constraint live (Postgres 23514), honestly named apart
    // from the 0014 whole-table gate above. 'primary'/'cosponsor' candidates never land here.
    sponsorType0015Gated: 0,
    sponsorInserted: 0,
    cacheMissing: 0,
  };
}

// emptySponsorTypeBreakdown — fix round 1, requirement 3: composition of the SOURCE data by
// LegiScan's own sponsor type, independent of match/write outcome, so an operator can see what a
// live run would actually be writing before authorizing it. Populated in both dry-run and live
// mode (cheap, pure counting — unlike `plan`, which is deliberately dry-run-only).
function emptySponsorTypeBreakdown() {
  return {
    primary: 0, cosponsor: 0, joint: 0, unspecified: 0,
  };
}

// runBackfillMoBillMeta — the testable seam. dryRun:true performs every bulk READ that live mode
// would (the four loadXIndex calls) but never calls .update()/.upsert() — statusPatched/
// sponsorInserted stay 0 (mirrors backfill-nicknames.js's runBackfillNicknames: `patched` stays 0 in
// dry-run, the literal count of writes actually performed), and every row that WOULD be written is
// instead collected into `plan`.
export async function runBackfillMoBillMeta(client, {
  dryRun = false, cacheDir = CACHE_DIR, runId = null,
  listFilesFn = listCachedDatasetFiles, readDatasetFn = readCachedDatasetBills,
  loadSessionIndexFn = loadSessionIndex, loadLegislatorIndexFn = loadLegislatorIndex,
  loadBillIndexFn = loadBillIndex, loadSponsorIndexFn = loadSponsorIndex,
} = {}) {
  const files = listFilesFn(cacheDir);
  const counts = emptyCounts();
  const sponsorTypeBreakdown = emptySponsorTypeBreakdown();
  const plan = { statusPatches: [], sponsorInserts: [] };
  const sessionsSeen = new Set();

  // Bulk-prefetch every large table ONCE per run — see the SCALE header comment for why this
  // replaced per-candidate point lookups.
  const sessionIndex = await loadSessionIndexFn(client);
  const legislatorIndex = await loadLegislatorIndexFn(client);
  const billIndex = await loadBillIndexFn(client);
  const sponsorLoad = await loadSponsorIndexFn(client);
  let sponsorGatedForRun = sponsorLoad.gated;
  const sponsorIndex = sponsorLoad.index;
  // sponsorType0015Missing — set the first time a live 'joint'/'unspecified' insert 23514s against
  // the OLD constraint (see PRE-0015 TOLERANCE header comment). Unlike sponsorGatedForRun (decided
  // up front by a SELECT), this can only be discovered by an actual write attempt, so it starts
  // false even in a run where migration 0015 turns out to be unapplied — the first candidate of
  // either new type pays for the discovery, every later one is short-circuited.
  let sponsorType0015Missing = false;

  for (const filePath of files) {
    // eslint-disable-next-line no-await-in-loop -- sequential, same "small/infrequent backlog"
    // precedent as every other batch CLI in this codebase.
    const decoded = await readDatasetFn(filePath);
    if (!decoded.ok) { counts.cacheMissing += 1; continue; }
    sessionsSeen.add(decoded.sessionId);
    counts.billsSeen += decoded.bills.length;

    const sessionRow = sessionIndex.get(decoded.sessionId);
    if (!sessionRow) { counts.sessionNotFound += decoded.bills.length; continue; }

    for (const bill of decoded.bills) {
      const identifier = normalizeBillIdentifier(bill.bill_number);
      const billRow = billIndex.get(`${sessionRow.id}|${identifier}`);
      if (!billRow) { counts.billNotFound += 1; continue; }

      // --- status: additivePatch, fills null only ---
      if (bill.status == null) {
        counts.statusMissingInSource += 1;
      } else {
        // FIX (data-corrections task, "fix the writer too"): decode via the SAME manual-sourced
        // mapMoStatusCode correct-data.js's mo-status correction uses on the already-ingested
        // numeric rows — a bill this backfill fills status for (typically a bill MO's own primary
        // driver stubbed first, per this file's STATUS header comment) now gets LegiScan's printed
        // word, not its bare numeric code. Falls back to the code verbatim for 0/7-12/undocumented
        // (mapMoStatusCode returns null for exactly those, by design — no honest word exists).
        const patch = additivePatch(billRow, { status: mapMoStatusCode(bill.status) ?? String(bill.status) });
        if (Object.keys(patch).length === 0) {
          counts.statusAlreadySet += 1;
        } else if (dryRun) {
          plan.statusPatches.push({
            billId: billRow.id, identifier, legiscanSessionId: decoded.sessionId, patch,
          });
        } else {
          // eslint-disable-next-line no-await-in-loop
          const { error: updErr } = await client.from('bills')
            .update({ ...patch, run_id: runId }).eq('id', billRow.id);
          if (updErr) throw new Error(`backfill-mo-bill-meta: status patch failed for bills.id=${billRow.id}: ${updErr.message}`);
          billRow.status = patch.status; // keep the in-memory index consistent for the rest of this run
          counts.statusPatched += 1;
        }
      }

      // --- sponsors: insert-if-absent, migration-0014-gated (see loadSponsorIndex) and
      // migration-0015-tolerant (see PRE-0015 TOLERANCE header comment) ---
      for (const { peopleId, sponsorTypeId } of extractBillSponsorCandidates(bill)) {
        counts.sponsorsSeen += 1;
        const sponsorType = mapSponsorType(sponsorTypeId);
        if (!sponsorType) { counts.sponsorTypeUnknown += 1; continue; }
        sponsorTypeBreakdown[sponsorType] += 1; // composition of the source data, both modes

        const legislatorId = legislatorIndex.get(peopleId);
        if (!legislatorId) { counts.sponsorLegislatorNotFound += 1; continue; }

        if (sponsorGatedForRun) { counts.sponsorGated += 1; continue; }

        const sponsorKey = `${billRow.id}|${legislatorId}`;
        if (sponsorIndex.has(sponsorKey)) { counts.sponsorAlreadyExists += 1; continue; }

        if (dryRun) {
          plan.sponsorInserts.push({
            billId: billRow.id, identifier, legislatorId, legiscanPeopleId: peopleId, sponsorType,
          });
          continue;
        }

        const isWidenedType = sponsorType === 'joint' || sponsorType === 'unspecified';
        if (isWidenedType && sponsorType0015Missing) { counts.sponsorType0015Gated += 1; continue; }

        // eslint-disable-next-line no-await-in-loop
        const { error: insErr } = await client.from('bill_sponsors')
          .upsert({
            bill_id: billRow.id, legislator_id: legislatorId, sponsor_type: sponsorType, run_id: runId,
          }, { onConflict: 'bill_id,legislator_id', ignoreDuplicates: true });
        if (insErr) {
          if (isMissingRelationError(insErr, 'bill_sponsors')) {
            sponsorGatedForRun = true;
            counts.sponsorGated += 1;
            continue;
          }
          if (isWidenedType && isCheckConstraintViolation(insErr, SPONSOR_TYPE_CHECK_CONSTRAINT)) {
            sponsorType0015Missing = true;
            counts.sponsorType0015Gated += 1;
            continue;
          }
          throw new Error(`backfill-mo-bill-meta: sponsor insert failed for bill_id=${billRow.id} legislator_id=${legislatorId}: ${insErr.message}`);
        }
        sponsorIndex.set(sponsorKey, { id: null }); // keep the in-memory index consistent for the rest of this run
        counts.sponsorInserted += 1;
      }
    }
  }

  return {
    mode: dryRun ? 'dry-run' : 'live',
    counts,
    sponsorTypeBreakdown,
    cacheFilesFound: files.length,
    sessionsSeen: [...sessionsSeen],
    plan: dryRun ? plan : undefined,
  };
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    const report = await runBackfillMoBillMeta(client, { dryRun: true });
    console.log(JSON.stringify({ source: SOURCE, ...report }, null, 2));
    return;
  }

  const runId = await openRun(client, SOURCE);
  try {
    const report = await runBackfillMoBillMeta(client, { dryRun: false, runId });
    await closeRun(client, runId, 'succeeded', {
      counts: report.counts, sponsorTypeBreakdown: report.sponsorTypeBreakdown, cacheFilesFound: report.cacheFilesFound,
    });
    console.log(JSON.stringify({ source: SOURCE, run_id: runId, ...report }, null, 2));
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
