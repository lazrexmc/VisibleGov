import { readFileSync } from 'node:fs';
import {
  getClient, openRun, closeRun, isMissingColumnError,
} from '../lib/db.js';
import { listCachedDatasetFiles, readCachedDatasetPeople } from './backfill-nicknames.js';
import { loadLegislatorIndex } from './backfill-mo-bill-meta.js';
import {
  chamberFromRole, normalizeLegiscanDistrict, UnrecognizedLegiscanRoleError,
} from '../adapters/legiscan-identity.js';

// backfill-mo-terms — Task 8b of the public-site plan
// (.superpowers/sdd/2026-07-30-public-site/task-8b-brief.md, finding D1). Task 8's own review
// surfaced this live: mo-legislature `terms` is ~unpopulated (1 row, live) because no MO driver
// has ever written a `terms` row keyed off a LegiScan-sourced legislator — the site's address
// lookup (site/js/districts.js's matchReps) can therefore never find a MO Senate/House seat for a
// real MO address. This CLI closes that gap from ONE source only: the LATEST MO LegiScan session's
// cached people records (walk-back ruling, task-8b-brief.md: "latest-session roster only — it
// serves address lookup with one honest answer per seat; historical MO terms are a later, separate
// concern").
//
// HARD RULE (same as backfill-nicknames.js/backfill-mo-bill-meta.js): ZERO LegiScan API queries,
// ever. Reads ONLY the dataset ZIPs already cached under .superpowers/artifacts/legiscan-datasets/
// by a prior ingest-legiscan.js sweep, via listCachedDatasetFiles/readCachedDatasetPeople (both
// imported from backfill-nicknames.js — the same decode surface, not reimplemented). A missing
// cache directory, or a missing/corrupt individual cache file, is counted honestly and skipped,
// never a reason to fetch.
//
// SESSION SELECTION (mechanical, documented in the run's own report): every cached envelope
// already carries its own `session_id`/`year_start`/`session_title`/`dataset_date` fields at the
// TOP level (verified against the real cache — no ZIP decode needed to read them). The latest
// session is simply the cached envelope with the highest `year_start`; ties (a Regular + Special
// session both starting the same year) are broken by the later `dataset_date`, then by the higher
// LegiScan `session_id`, for full run-to-run determinism. Verified live against this repo's own 31
// cached datasets (2026-07-30): 2239 ("2026 Regular Session", year_start 2026) is the unambiguous
// winner — no other cached dataset shares that year_start. Only THIS ONE session's people[] array
// is ever decoded/processed; the other 30 cached files are never opened.
//
// MATCHING (exact key only, CONTROLLER RULING 3 lineage): loadLegislatorIndex (imported from
// backfill-mo-bill-meta.js — the SAME Map<legiscan_people_id, legislator_id> bulk loader, not
// reimplemented) resolves each person's `people_id` against legislators.legiscan_people_id via
// EXACT match only. A person with no matching legislator row is counted `noMatchingLegislator`,
// never guessed/created (creating legislator rows is legiscan-identity.js's job during real
// ingestion, not this read-only-of-legislators backfill).
//
// CHAMBER/DISTRICT (reused, not reimplemented): chamberFromRole/normalizeLegiscanDistrict
// (src/adapters/legiscan-identity.js) are the SAME functions resolveOrCreateLegiscanPerson already
// uses to map a person's `role`/`district` fields. A role that maps to neither chamber ('Sen'/
// 'Rep' are the only two chamberFromRole recognizes — verified-exhaustive against the real 189-
// person fixture per that function's own comment) throws UnrecognizedLegiscanRoleError, caught
// here and counted `skippedNonLegislator` — never guessed. normalizeLegiscanDistrict converts
// LegiScan's 'HD-060'/'SD-02' shape to the bare zero-stripped-digit convention every other source's
// terms.district already uses ('60'/'2').
//
// DATES STAY NULL (brief, explicit): session-derived dates would invent term boundaries the source
// does not actually assert — the site's own date-honesty language (site/js/districts.js's asOf
// fallback) already covers a null-dated term. Every row this CLI ever inserts has
// start_date/end_date both null.
//
// IDEMPOTENCY (brief, explicit — check-then-insert, NOT the unique constraint): terms' own unique
// constraint is (legislator_id, jurisdiction_id, chamber, district, start_date) — Postgres unique
// indexes never treat two NULLs as equal, so a null-start_date row can never be deduped by an
// upsert/onConflict the way ingest.js's own findExistingTerm/upsertTerm precedent already
// documents. findExistingMoTerm below is this CLI's own check-then-insert (same shape as
// findExistingTerm, but explicitly scoped to `start_date IS NULL` per the brief's own wording,
// rather than ignoring start_date entirely) — every insert is preceded by this read, and only a
// miss actually writes.
//
// state:'MO' (additive, never blocking): migration 0016 added terms.state (draft-then-apply); by
// the time this task runs it is applied live (Task 2 of this same plan, live-verified). Written
// alongside every insert here for the same reason backfill-term-states.js fills it elsewhere — MO
// is a fixed constant, no lookup needed. insertMoTermRow still tolerates the column being absent
// (isMissingColumnError) by falling back to the SAME insert minus `state` — a secondary enrichment
// field must never block the primary term row from landing (PLAYBOOK_DELTA §7 lesson 9: additive
// pipeline stages must never fail the primary product). Once that fallback fires once in a run,
// every later insert in the SAME run skips the with-state attempt entirely (mirrors the
// `columnKnownMissing`-style gate-fires-once convention used throughout this codebase's other
// backfills).

const CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';
const SOURCE = 'backfill-mo-terms';
const MO_JURISDICTION = 'mo-legislature';
const MO_STATE_CONSTANT = 'MO';

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

// ---- session selection: cheap metadata read (no ZIP decode) + mechanical highest-year_start pick ----

// readDatasetEnvelopeMeta — one cache file's TOP-LEVEL envelope fields (session_id/year_start/
// session_title/dataset_date) WITHOUT decoding the (large, base64) `zip` payload at all — this
// function never calls decodeDatasetZip/extractDatasetFiles. Mirrors readCachedDatasetPeople's own
// missing/malformed-JSON tolerance (ok:false, never throws) but stops one step earlier, since the
// SELECTION phase only needs these small top-level fields, not the full decoded people[] array —
// decoding all 31 cached ZIPs just to pick ONE of them would repeat backfill-mo-bill-meta.js's own
// documented performance lesson (SCALE header comment there) for no benefit.
export function readDatasetEnvelopeMeta(filePath, { readFileFn = readFileSync } = {}) {
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
  if (envelope.session_id == null || envelope.year_start == null) return { ok: false, filePath };
  return {
    ok: true,
    filePath,
    sessionId: envelope.session_id,
    yearStart: envelope.year_start,
    sessionTitle: envelope.session_title ?? envelope.session_name ?? null,
    datasetDate: envelope.dataset_date ?? null,
  };
}

function isBetterCandidate(candidate, current) {
  if (!current) return true;
  if (candidate.yearStart !== current.yearStart) return candidate.yearStart > current.yearStart;
  const candidateDate = String(candidate.datasetDate ?? '');
  const currentDate = String(current.datasetDate ?? '');
  if (candidateDate !== currentDate) return candidateDate > currentDate;
  return candidate.sessionId > current.sessionId;
}

// resolveLatestMoDatasetFile -> { best, filesConsidered, skippedUnreadable }. `best` is the
// envelope-meta object (see readDatasetEnvelopeMeta) for the mechanically-chosen latest session, or
// null if no cached dataset is readable at all (honest, never a crash — the orchestrator reports
// this as a session:null run with zero counts rather than guessing a session).
export function resolveLatestMoDatasetFile(cacheDir = CACHE_DIR, {
  listFilesFn = listCachedDatasetFiles, readMetaFn = readDatasetEnvelopeMeta,
} = {}) {
  const files = listFilesFn(cacheDir);
  let best = null;
  let skippedUnreadable = 0;
  for (const filePath of files) {
    const meta = readMetaFn(filePath);
    if (!meta.ok) { skippedUnreadable += 1; continue; }
    if (isBetterCandidate(meta, best)) best = meta;
  }
  return { best, filesConsidered: files.length, skippedUnreadable };
}

// ---- check-then-insert (see IDEMPOTENCY header comment) ----

export async function findExistingMoTerm(client, { legislatorId, chamber, district }) {
  const { data, error } = await client
    .from('terms')
    .select('id')
    .eq('legislator_id', legislatorId)
    .eq('jurisdiction_id', MO_JURISDICTION)
    .eq('chamber', chamber)
    .eq('district', district)
    .is('start_date', null)
    .maybeSingle();
  if (error) throw new Error(`backfill-mo-terms: existing-term lookup failed for legislator_id=${legislatorId}: ${error.message}`);
  return data;
}

// insertMoTermRow — see state:'MO' header comment for the fallback rationale. `includeState` lets
// the orchestrator skip the doomed first attempt once the column is already known missing for this
// run (gate-fires-once).
export async function insertMoTermRow(client, runId, {
  legislatorId, chamber, district, party, includeState,
}) {
  const baseRow = {
    legislator_id: legislatorId,
    jurisdiction_id: MO_JURISDICTION,
    chamber,
    district,
    party: party ?? null,
    start_date: null,
    end_date: null,
    run_id: runId,
  };
  const firstRow = includeState ? { ...baseRow, state: MO_STATE_CONSTANT } : baseRow;
  const { error } = await client.from('terms').insert(firstRow);
  if (!error) return { stateColumnMissing: false };
  if (includeState && isMissingColumnError(error, 'state')) {
    const { error: retryErr } = await client.from('terms').insert(baseRow);
    if (retryErr) throw new Error(`backfill-mo-terms: term insert failed for legislator_id=${legislatorId}: ${retryErr.message}`);
    return { stateColumnMissing: true };
  }
  throw new Error(`backfill-mo-terms: term insert failed for legislator_id=${legislatorId}: ${error.message}`);
}

// ---- orchestration ----

function emptyCounts() {
  return {
    peopleSeen: 0, termsInserted: 0, alreadyPresent: 0, noMatchingLegislator: 0, skippedNonLegislator: 0,
  };
}

// runBackfillMoTerms — the testable seam. dryRun:true performs every read live mode would (session
// selection, dataset decode, legislator index load, AND the per-candidate existing-row check — the
// point of --dry-run is a controller-reviewable PREVIEW, not a guess) but never calls .insert() —
// `termsInserted` stays 0, and every row that WOULD be inserted lands in `plan` instead (mirrors
// every other backfill CLI in this codebase).
export async function runBackfillMoTerms(client, {
  dryRun = false, cacheDir = CACHE_DIR, runId = null,
  resolveLatestDatasetFileFn = resolveLatestMoDatasetFile,
  readDatasetFn = readCachedDatasetPeople,
  loadLegislatorIndexFn = loadLegislatorIndex,
  findExistingTermFn = findExistingMoTerm,
  insertTermFn = insertMoTermRow,
} = {}) {
  const counts = emptyCounts();
  const plan = [];

  const resolution = resolveLatestDatasetFileFn(cacheDir);
  if (!resolution.best) {
    return {
      mode: dryRun ? 'dry-run' : 'live',
      counts,
      session: null,
      note: 'no cached MO LegiScan dataset envelope was readable — nothing to backfill',
      filesConsidered: resolution.filesConsidered,
      skippedUnreadable: resolution.skippedUnreadable,
      plan: dryRun ? plan : undefined,
    };
  }

  const session = {
    legiscanSessionId: resolution.best.sessionId,
    yearStart: resolution.best.yearStart,
    sessionTitle: resolution.best.sessionTitle,
    cacheFile: resolution.best.filePath,
  };

  const decoded = await readDatasetFn(resolution.best.filePath);
  if (!decoded.ok) {
    return {
      mode: dryRun ? 'dry-run' : 'live',
      counts,
      session,
      note: 'the chosen dataset envelope could not be decoded (cache missing/corrupt) — nothing to backfill',
      filesConsidered: resolution.filesConsidered,
      skippedUnreadable: resolution.skippedUnreadable,
      plan: dryRun ? plan : undefined,
    };
  }

  const legislatorIndex = await loadLegislatorIndexFn(client);
  let stateColumnAvailable = true;

  for (const person of decoded.people) {
    counts.peopleSeen += 1;

    let chamber;
    try {
      chamber = chamberFromRole(person.role);
    } catch (err) {
      if (err instanceof UnrecognizedLegiscanRoleError) { counts.skippedNonLegislator += 1; continue; }
      throw err;
    }

    const legislatorId = legislatorIndex.get(person.people_id);
    if (!legislatorId) { counts.noMatchingLegislator += 1; continue; }

    const district = normalizeLegiscanDistrict(person.district);
    const party = person.party ?? null;

    // eslint-disable-next-line no-await-in-loop -- sequential, same "small/infrequent backlog"
    // precedent as every other batch CLI in this codebase; one session's roster is ~190 people.
    const existing = await findExistingTermFn(client, { legislatorId, chamber, district });
    if (existing) { counts.alreadyPresent += 1; continue; }

    if (dryRun) {
      plan.push({
        legislatorId, legiscanPeopleId: person.people_id, chamber, district, party,
      });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const result = await insertTermFn(client, runId, {
      legislatorId, chamber, district, party, includeState: stateColumnAvailable,
    });
    if (result.stateColumnMissing) stateColumnAvailable = false;
    counts.termsInserted += 1;
  }

  return {
    mode: dryRun ? 'dry-run' : 'live',
    counts,
    session,
    filesConsidered: resolution.filesConsidered,
    skippedUnreadable: resolution.skippedUnreadable,
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
    const report = await runBackfillMoTerms(client, { dryRun: true });
    console.log(JSON.stringify({ source: SOURCE, ...report }, null, 2));
    return;
  }

  const runId = await openRun(client, SOURCE);
  try {
    const report = await runBackfillMoTerms(client, { dryRun: false, runId });
    await closeRun(client, runId, 'succeeded', { counts: report.counts, session: report.session });
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
