// scripts/migrate-parked-to-ledger.mjs — copy the parked-bill set from its gitignored JSON file
// into the `parked_bills` table created by migration 0039.
//
// WHY A SCRIPT AND NOT ROWS IN THE MIGRATION. 31 rows of free-text reasons hardcoded into a .sql
// file would be unreviewable, unrepeatable on a machine whose JSON has since changed, and would
// make the migration non-idempotent in an unhelpful way. Keeping the schema change and the data
// move separate also means the migration can be applied at any time with zero effect, which is what
// makes it safe to apply ahead of the code that will read the table.
//
// IDEMPOTENT BY CONSTRUCTION. Upsert on the bill_id primary key: running it twice changes nothing,
// and running it after someone has parked a further bill by hand updates rather than duplicates.
//
// ORDER MATTERS AND IS ENFORCED HERE. This refuses to run if 0039 has not been applied, rather than
// failing with a confusing PostgREST error. And it must run BEFORE scheduled-summaries.js switches
// to reading the table: a billed scheduler reading an empty parked set re-attempts 31 bills already
// proven to fail three times each, which is the exact waste the parked set prevents.
//
// Usage:
//   node --env-file=.env scripts/migrate-parked-to-ledger.mjs           # dry run, prints the plan
//   node --env-file=.env scripts/migrate-parked-to-ledger.mjs --apply   # writes

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARKED_PATH = path.join(REPO_ROOT, '.superpowers', 'artifacts', 'scheduled-summaries', 'parked.json');

// A parked entry is {reason, parked_at, source?} keyed by bill_id. `source` is absent on 3 of the
// 31 current entries (they predate the field), so it is optional here rather than defaulted to
// something invented — an unknown provenance is a fact, and "(none)" would be a fabricated one.
export function planParkedRows(parkedJson, { now = new Date() } = {}) {
  const rows = [];
  const skipped = [];
  for (const [billId, entry] of Object.entries(parkedJson ?? {})) {
    if (!/^[0-9a-f-]{36}$/i.test(billId)) {
      skipped.push({ billId, why: 'key is not a uuid' });
      continue;
    }
    const reason = entry && typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!reason) {
      // The reason IS the artefact — a parked bill with no stated reason cannot be reviewed later,
      // and inventing one ("parked") would launder a missing record into a decision.
      skipped.push({ billId, why: 'no reason recorded; a park without evidence is not portable' });
      continue;
    }
    rows.push({
      bill_id: billId,
      reason,
      parked_at: entry.parked_at ?? now.toISOString(),
      source: entry.source ?? null,
    });
  }
  return { rows, skipped };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const err = new Error('migrate-parked-to-ledger: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    err.exitCode = 2;
    throw err;
  }
  const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  if (!existsSync(PARKED_PATH)) {
    console.log(`no parked.json at ${PARKED_PATH} — nothing to migrate`);
    return;
  }

  // Refuse early and clearly if 0039 has not been applied, rather than surfacing a PostgREST 404.
  const probe = await fetch(`${url}/rest/v1/parked_bills?select=bill_id&limit=1`, { headers: H });
  if (probe.status === 404) {
    const err = new Error(
      'parked_bills does not exist — apply supabase/migrations/0039_parked_bills.sql first, '
      + 'then re-run this. (npm run verify:migrations will confirm.)',
    );
    err.exitCode = 2;
    throw err;
  }
  if (!probe.ok) throw new Error(`parked_bills probe failed: HTTP ${probe.status}`);

  const parked = JSON.parse(readFileSync(PARKED_PATH, 'utf8'));
  const { rows, skipped } = planParkedRows(parked);

  console.log(`${Object.keys(parked).length} entries in parked.json -> ${rows.length} row(s) to upsert`);
  for (const s of skipped) console.log(`  SKIP ${s.billId}: ${s.why}`);
  const bySource = rows.reduce((m, r) => ({ ...m, [r.source ?? '(none)']: (m[r.source ?? '(none)'] ?? 0) + 1 }), {});
  console.log(`  by source: ${JSON.stringify(bySource)}`);

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    return;
  }
  if (rows.length === 0) {
    console.log('nothing to write');
    return;
  }

  // merge-duplicates makes this an upsert on the bill_id primary key, so a second run is a no-op
  // rather than a constraint violation.
  const res = await fetch(`${url}/rest/v1/parked_bills?on_conflict=bill_id`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`upsert failed: HTTP ${res.status} ${await res.text()}`);
  const written = await res.json();
  console.log(`\nwrote ${written.length} row(s) to parked_bills`);
  console.log('parked.json is now a copy, not the source of truth. Leave it in place until');
  console.log('scheduled-summaries.js reads the table — see 0039 for the ordering.');
}

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) main().catch((err) => { console.error(err.message ?? err); process.exitCode = err?.exitCode ?? 2; });
