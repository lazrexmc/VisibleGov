import {
  getClient, openRun, closeRun, selectAll,
} from '../lib/db.js';
import { parsePositiveIntegerFlag } from '../lib/errors.js';
import { normalizeBillIdentifier } from '../adapters/legiscan-dataset.js';
import { listCachedDatasetFiles } from './backfill-nicknames.js';
import { readCachedDatasetBills, loadSessionIndex } from './backfill-mo-bill-meta.js';

// backfill-bill-titles — TODO 26. Backfills bills.title where NULL, from the SAME 31 cached
// LegiScan dataset ZIPs already on disk (ingest-legiscan.js's own prior sweep). ZERO model calls,
// ZERO network calls — every input is either a cached file or a DB read; every fetcher/reuse below
// is read-only against LegiScan data already fetched under its own dataset_hash gate.
//
// REUSE, NOT REIMPLEMENT: listCachedDatasetFiles (backfill-nicknames.js), readCachedDatasetBills +
// loadSessionIndex (backfill-mo-bill-meta.js — the SAME decodeDatasetZip/extractDatasetFiles path
// and the SAME Map<legiscan_session_id, {id}> exact-match session index other backfill CLIs use),
// normalizeBillIdentifier (legiscan-dataset.js — the SAME identifier string shape stored in
// bills.identifier).
//
// SESSION-MATCH SAFETY (brief's TODO-25 requirement): loadSessionIndex only returns EXACT matches
// on the sessions.legiscan_session_id column — it never creates or patches a session row (that
// write path belongs solely to ingest-legiscan.js's ensureLegiscanSessionRow). A dataset whose
// session has no such row yet is excluded from the index entirely (buildTitleIndex), so this CLI
// can never resolve a bill against a session it isn't already certain of — and therefore can never
// make the MO-2026 session split (TODO 25) worse. If a bill's session can't be confidently
// resolved, it is counted honestly as unresolved and left untouched.
//
// (session_id, identifier) is the SAME compound key ensureLegiscanBillRows used to create these
// rows in the first place (ingest-legiscan.js:291) — this backfill never invents a new join key.

export function buildTitleIndex(cachedFiles, sessionIndex) {
  const index = new Map();
  for (const file of cachedFiles) {
    if (!file.ok) continue; // unparseable cache file — skip, don't throw (mirrors readCachedDatasetBills' own tolerance)
    const dbSession = sessionIndex.get(file.sessionId);
    if (!dbSession) continue; // session not exactly resolved — exclude the whole file, never guess
    for (const bill of file.bills ?? []) {
      const title = typeof bill.title === 'string' ? bill.title.trim() : '';
      if (!title) continue; // LegiScan itself has no title for this bill — nothing to backfill from
      const key = `${dbSession.id}|${normalizeBillIdentifier(bill.bill_number)}`;
      index.set(key, title);
    }
  }
  return index;
}

export function resolveBillTitle(titleIndex, bill) {
  const key = `${bill.session_id}|${bill.identifier}`;
  const title = titleIndex.get(key);
  if (!title) return { found: false, reason: 'no matching dataset entry' };
  return { found: true, title };
}

// runBackfill — pure orchestration over injected data + a writeTitle callback (DB access lives
// entirely in main(), below), so this is fully unit-testable without a live client. Honest counts
// throughout: --limit caps live WRITES, never the count of bills examined or reported.
export async function runBackfill({
  nullTitleBills, titleIndex, dryRun, limit, writeTitle,
}) {
  const unresolvedByReason = {};
  const failures = [];
  let written = 0;
  let resolvable = 0;

  for (const bill of nullTitleBills) {
    const hit = resolveBillTitle(titleIndex, bill);
    if (!hit.found) {
      unresolvedByReason[hit.reason] = (unresolvedByReason[hit.reason] ?? 0) + 1;
      continue;
    }
    resolvable += 1;
    if (dryRun) continue;
    if (limit != null && written >= limit) continue; // still counted as resolvable above; just not written this run
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential, small/infrequent backlog (same
      // precedent as ingest-legiscan.js/ingest-mo-senate.js: readability over throughput here)
      await writeTitle(bill.id, hit.title);
      written += 1;
    } catch (err) {
      failures.push({ id: bill.id, message: err.message });
    }
  }

  const unresolvedCount = Object.values(unresolvedByReason).reduce((a, b) => a + b, 0);
  return {
    nullTitleBills: nullTitleBills.length,
    resolvable,
    written,
    unresolved: { count: unresolvedCount, byReason: unresolvedByReason },
    failures,
  };
}

// ---- CLI wiring ----

function parseArgs(argv) {
  const out = { dryRun: false, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--dry-run') { out.dryRun = true; continue; }
    if (key === '--limit') { out.limit = parsePositiveIntegerFlag(argv[i + 1], '--limit'); i += 1; continue; }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const runId = args.dryRun ? null : await openRun(client, 'title-backfill');

  try {
    const { data: nullTitleBills, error: billsErr } = await selectAll(
      client,
      'bills',
      'id,session_id,identifier',
      { filter: (q) => q.is('title', null) },
    );
    if (billsErr) throw new Error(`bills lookup failed: ${billsErr.message}`);

    const sessionIndex = await loadSessionIndex(client);
    const cachedFiles = await Promise.all(
      listCachedDatasetFiles().map((filePath) => readCachedDatasetBills(filePath)),
    );
    const titleIndex = buildTitleIndex(cachedFiles, sessionIndex);

    const report = await runBackfill({
      nullTitleBills: nullTitleBills ?? [],
      titleIndex,
      dryRun: args.dryRun,
      limit: args.limit,
      // Conditioned on title IS NULL at write time — a bill can legitimately gain a title via
      // concurrent ingestion between our read and this write (the scheduler runs independently).
      writeTitle: async (id, title) => {
        const { error, count } = await client
          .from('bills')
          .update({ title })
          .eq('id', id)
          .is('title', null)
          .select('id', { count: 'exact', head: true });
        if (error) throw new Error(error.message);
        if (count === 0) throw new Error('title was no longer NULL at write time (concurrent write) — skipped, not overwritten');
      },
    });

    if (!args.dryRun) {
      await closeRun(client, runId, 'succeeded', { counts: report });
    }
    console.log(JSON.stringify({ mode: args.dryRun ? 'dry-run' : 'live', ...report }, null, 2));
  } catch (err) {
    if (runId) await closeRun(client, runId, 'failed', { note: err.message });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
