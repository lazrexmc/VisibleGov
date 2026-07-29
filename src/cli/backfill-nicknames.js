import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  getClient, openRun, closeRun, additivePatch, isMissingColumnError,
} from '../lib/db.js';
import { decodeDatasetZip, extractDatasetFiles } from '../adapters/legiscan-dataset.js';

// backfill-nicknames — nickname amendment
// (.superpowers/sdd/2026-07-29-identity-merge/progress.md, last entry, controller ruling on fix
// round 2's cost). The unconditional full-name-variant gate (src/lib/person-identity.js) correctly
// stops surname-only merges, but split the real four-Onder rows into TWO persons because LegiScan's
// own source-printed `person.nickname` field ('Bob' on people_id 16351) was resolved once at
// INGEST time (src/adapters/legiscan-identity.js's buildLegiscanNameVariants — used ONLY for that
// one record's single-candidate DB lookup) but never PERSISTED onto the `legislators` row. This CLI
// closes that gap for every already-ingested LegiScan person, from data already on disk.
//
// HARD RULE (this task, ledgered explicitly): ZERO LegiScan API queries, ever. This CLI reads ONLY
// the dataset ZIPs already cached under .superpowers/artifacts/legiscan-datasets/ by a prior
// ingest-legiscan.js sweep (that cache's own write site: src/cli/ingest-legiscan.js's
// resolveDatasetBytes, `${cacheDir}/${legiscanSessionId}-${entry.dataset_hash}.json`, the FULL
// dataset envelope with `.zip` still Base64-encoded) — never calls getDatasetList/getDataset. A
// missing cache directory, or a missing/corrupt individual cache file, is never treated as a reason
// to fetch — it is counted honestly (`cacheMissing`) and skipped, per this task's own instruction:
// "if a session's cache is missing, skip with honest count, never fetch."
//
// Matching is EXACT KEY ONLY: legiscan_people_id is already a table-wide unique column (migration
// 0010) — this CLI never falls back to name matching of any kind (CONTROLLER RULING 3 stands: zero
// fuzzy/edit-distance matching anywhere in this codebase's identity machinery). additivePatch means
// an existing legislators.nickname value is NEVER overwritten — a repeat run (the same person seen
// again in a later session's dataset, or a second full run) is a safe no-op past the first patch.
//
// isMissingColumnError-gated on `legislators.nickname` (migration 0013, draft-then-apply — Lance's
// call when to run it): every DB touch this file makes is gated the same honest way
// legiscan-identity.js's resolveOrCreateLegiscanPerson already gates on legiscan_people_id — a
// `gated` count, never a crash, never silently mistaken for "nothing to backfill". Once the gate
// fires once in a run, every remaining candidate is counted `gated` without a further live query
// (the column's absence does not change mid-run).

const CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';
const SOURCE = 'backfill-nicknames';

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

// ---- local cache: enumerate + decode (zero network, zero API queries) ----

// listCachedDatasetFiles — every *.json file directly under the cache dir (ingest-legiscan.js's own
// cachePath naming convention, but this function does not depend on it — any *.json file present is
// treated as a candidate). An absent cache dir (the sweep never ran, or ran somewhere else) is
// honestly reported as zero files found, never a crash and never a reason to reach for the network.
export function listCachedDatasetFiles(cacheDir = CACHE_DIR) {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => `${cacheDir}/${name}`);
}

// extractNicknamePeople — one dataset's parsed `people[]` -> only the records worth a patch
// attempt: a non-empty, source-printed nickname that actually DIFFERS from first_name (LegiScan
// prints some records with nickname === first_name, e.g. nickname:"Robert" on first_name:"Robert" —
// carries zero new identity information, filtered out here so peopleSeen/withNickname stay
// meaningful rather than padded with no-op entries).
export function extractNicknamePeople(parsedPeople) {
  const out = [];
  for (const person of parsedPeople ?? []) {
    const nickname = String(person?.nickname ?? '').trim();
    const firstName = String(person?.first_name ?? '').trim();
    if (nickname && nickname !== firstName) {
      out.push({ peopleId: person.people_id, nickname });
    }
  }
  return out;
}

// readCachedDatasetPeople — one cache file -> { ok:true, filePath, sessionId, people } or
// { ok:false, filePath } (file missing/unreadable/malformed JSON/undecodable ZIP/unparseable
// archive) — never throws. This mirrors ingest-legiscan.js's own resolveDatasetBytes cache-hit
// branch exactly (`JSON.parse(readFileSync(path, 'utf8'))`, then decodeDatasetZip +
// extractDatasetFiles on the envelope's still-Base64 `.zip` field) — the SAME decode surface, read
// from disk instead of freshly fetched. A read/parse/decode failure anywhere in this chain is folded
// into the same honest `cacheMissing` bucket the orchestrator counts (this task's own instruction
// draws no finer distinction than "cache missing" vs "cache usable") — never a thrown error that
// would abort the other 30 sessions' worth of real, usable data over one bad file.
export async function readCachedDatasetPeople(filePath, { readFileFn = readFileSync } = {}) {
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
    return {
      ok: true, filePath, sessionId: envelope.session_id, people: parsed.people ?? [],
    };
  } catch {
    return { ok: false, filePath };
  }
}

// ---- DB matching: exact key only, additive-only, migration-0013-gated ----

// resolveNicknamePatch — legiscan_people_id EXACT match (never name matching) against
// `legislators`, then additivePatch's own fills-null-only semantics decide whether there is
// anything to do at all. Read-only (never calls .update() itself — see runBackfillNicknames below
// for why: the SAME resolution must serve both --dry-run's preview and a live run's actual write,
// and only the caller knows which mode it's in).
export async function resolveNicknamePatch(client, peopleId, nickname) {
  const { data: row, error } = await client
    .from('legislators')
    .select('id,nickname')
    .eq('legiscan_people_id', peopleId)
    .maybeSingle();
  if (error) {
    if (isMissingColumnError(error, 'nickname') || isMissingColumnError(error, 'legiscan_people_id')) {
      return { outcome: 'gated' };
    }
    throw new Error(`backfill-nicknames: legislators lookup failed for legiscan_people_id=${peopleId}: ${error.message}`);
  }
  if (!row) return { outcome: 'no_matching_row' };
  const patch = additivePatch(row, { nickname });
  if (Object.keys(patch).length === 0) return { outcome: 'already_set', legislatorId: row.id };
  return { outcome: 'would_patch', legislatorId: row.id, patch };
}

// ---- orchestration ----

function emptyCounts() {
  return {
    peopleSeen: 0, withNickname: 0, patched: 0, gated: 0, noMatchingRow: 0, cacheMissing: 0,
  };
}

// runBackfillNicknames — the testable seam. dryRun:true performs every DB READ that live mode
// would (so `gated`/`noMatchingRow` are honestly computed either way — the point of --dry-run is a
// controller-reviewable PREVIEW, not a guess) but never calls .update() — `patched` stays 0 (mirrors
// link-persons.js's runLink: personsCreated/linked are always 0 in dry-run, the literal count of
// writes actually performed), and every row that WOULD be patched is instead collected into `plan`
// so the preview is concrete, not just a number.
export async function runBackfillNicknames(client, {
  dryRun = false, cacheDir = CACHE_DIR, runId = null,
  listFilesFn = listCachedDatasetFiles, readDatasetFn = readCachedDatasetPeople,
} = {}) {
  const files = listFilesFn(cacheDir);
  const counts = emptyCounts();
  const plan = [];
  const sessionsSeen = new Set();
  let columnKnownMissing = false;

  for (const filePath of files) {
    // eslint-disable-next-line no-await-in-loop -- sequential, same "small/infrequent backlog"
    // precedent as every other batch CLI in this codebase (link-persons.js, ingest-legiscan.js).
    const decoded = await readDatasetFn(filePath);
    if (!decoded.ok) { counts.cacheMissing += 1; continue; }
    sessionsSeen.add(decoded.sessionId);
    counts.peopleSeen += decoded.people.length;
    const withNick = extractNicknamePeople(decoded.people);
    counts.withNickname += withNick.length;

    for (const { peopleId, nickname } of withNick) {
      if (columnKnownMissing) { counts.gated += 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      const resolved = await resolveNicknamePatch(client, peopleId, nickname);
      if (resolved.outcome === 'gated') {
        columnKnownMissing = true;
        counts.gated += 1;
        continue;
      }
      if (resolved.outcome === 'no_matching_row') { counts.noMatchingRow += 1; continue; }
      if (resolved.outcome === 'already_set') continue; // additive-only: nothing to do, not a failure

      // resolved.outcome === 'would_patch'
      if (dryRun) {
        plan.push({
          legiscanPeopleId: peopleId, nickname, legislatorId: resolved.legislatorId, sessionId: decoded.sessionId,
        });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const { error: updErr } = await client.from('legislators')
        .update({ ...resolved.patch, run_id: runId })
        .eq('id', resolved.legislatorId);
      if (updErr) {
        if (isMissingColumnError(updErr, 'nickname')) {
          columnKnownMissing = true;
          counts.gated += 1;
          continue;
        }
        throw new Error(`backfill-nicknames: patch failed for legislator id=${resolved.legislatorId}: ${updErr.message}`);
      }
      counts.patched += 1;
    }
  }

  return {
    mode: dryRun ? 'dry-run' : 'live',
    counts,
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
    const report = await runBackfillNicknames(client, { dryRun: true });
    console.log(JSON.stringify({ source: SOURCE, ...report }, null, 2));
    return;
  }

  const runId = await openRun(client, SOURCE);
  try {
    const report = await runBackfillNicknames(client, { dryRun: false, runId });
    await closeRun(client, runId, 'succeeded', { counts: report.counts, cacheFilesFound: report.cacheFilesFound });
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
