#!/usr/bin/env node
// unpark-stochastic-parks — return bills to the billed queue that were parked PERMANENTLY for a
// failure that was never theirs.
//
// DRAFT-THEN-APPLY. Dry-run is the default and prints exactly what would change. Nothing is
// written without --apply, and --apply is Lance's step, not an agent's.
//
//   node --env-file=.env scripts/unpark-stochastic-parks.mjs            # dry run
//   node --env-file=.env scripts/unpark-stochastic-parks.mjs --apply    # Lance only
//
// WHY. A park removes a bill from every future tick's budget, forever. On 2026-10-20 one tick
// parked HB 594, HB 1909 and SB 748 because the completeness CHECKER mis-shaped its own output:
// 9 key_provisions against a required 3-7, 6 coverage entries against 5 provisions, and a
// coverage entry pointing at bullet_index 27 of 25. None of those is a property of the bill.
//
// The bound two of them violated is one the model was never structurally held to:
// apiProvisionsSchema() DELETES minItems/maxItems because the API rejects minItems > 1, so 3-7
// lives in the prompt and in the record gate and nowhere in the schema the model generates
// against. The standing rule, bought the hard way on HB 903 (parked as structural after four
// identical failures, withdrawn, published on the fifth): park what fails DETERMINISTICALLY;
// retry what fails because two samplers disagreed.
//
// scheduled-summaries.js no longer parks this class at all (isStochasticRecordFailure). This
// script only cleans up the bills parked BEFORE that fix.
//
// WHY ONLY FOUR OF THE TEN completeness-related parks. The ten are not one class, and bulk-
// unparking them would repeat the error in the other direction - treating a measured, exhausted
// failure as if it were noise:
//
//   LEFT PARKED - HRES 1423, HB 369, SB 794, SJR 46. Each carries THREE exhausted billed
//   attempts (drain-lane seeded, 2026-08-17/18). Three recurrences is the deterministic standard
//   migration 0039 describes, and re-opening them spends real money to re-learn it.
//
//   LEFT PARKED, FLAGGED INSTEAD - HJR 114 and SJR 41. Their failures are section strings that
//   are not verbatim in the bill text: HJR 114 cites "Section 7, Article IX, Constitution of
//   Missouri", and SJR 41 carries "1the state of Missouri", a glued-digit text artifact. That is
//   a BILL-TEXT quality problem, not a checker-shape problem, so the reasoning in this file does
//   not cover them and one attempt each is not enough to classify either. They need their own
//   look; see TODO.md.
//
//   UNPARKED HERE - the three from 2026-10-20 (pure output-shape violations, one attempt, no
//   recurrence evidence) and SRES 412, whose recorded reason is "corroboration found 4 provisions
//   but the primary check found 1". That is the sub-floor corroboration gate reporting that two
//   blind runs disagreed, which is the retry case in its purest form.
//
// WHAT GETS WRITTEN. Parked state lives in TWO places and both must be cleared or the next sync
// restores the park:
//   1. .superpowers/artifacts/scheduled-summaries/parked.json - the OPERATIVE file; the billed
//      scheduler reads this one, so this is what actually re-opens the bills.
//   2. parked_bills (migration 0039) - the durable ledger, which exists because the JSON is
//      gitignored and lives on one machine. scripts/migrate-parked-to-ledger.mjs syncs JSON ->
//      table, so a row left behind here would be copied back on the next sync.
// Three of the four are not in the table yet (parked today, not yet synced), which the dry run
// reports rather than treating as an error.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const PARKED_PATH = path.join('.superpowers', 'artifacts', 'scheduled-summaries', 'parked.json');
const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Identified by bill_id, never by identifier: identifiers REPEAT across sessions (there are
// several distinct "HB 594" and "HB 2" rows), so an identifier-keyed unpark would re-open the
// wrong bill. Recorded with the identifier alongside purely so a human can read this list.
const UNPARK = [
  { bill_id: '9cc6836f-e763-471e-a299-d5c491fc7b6b', identifier: 'HB 594', why: 'key_provisions had 9 entries against a required 3-7 — a bound the schema does not enforce' },
  { bill_id: 'bcdcedf1-86cc-42a7-ae9c-78392d4fad18', identifier: 'HB 1909', why: 'coverage had 6 entries against 5 key_provisions' },
  { bill_id: '63b91c93-f793-4055-a3c3-a819b6992482', identifier: 'SB 748', why: 'coverage[5] claimed bullet_index 27 of 25 bullets' },
  { bill_id: '76a6d667-c77e-4aa6-8393-0d5b7aebacd1', identifier: 'SRES 412', why: 'corroboration found 4 provisions where the primary found 1 — two blind runs disagreeing' },
];

function need(name, value) {
  if (!value) { console.error(`${name} is not set — run with --env-file=.env`); process.exit(2); }
}

async function main() {
  const apply = process.argv.includes('--apply');
  need('SUPABASE_URL', URL_BASE);
  need('SUPABASE_SERVICE_ROLE_KEY', KEY);
  if (!existsSync(PARKED_PATH)) {
    console.error(`${PARKED_PATH} does not exist — nothing to unpark, and that is itself worth`);
    console.error('investigating: the billed scheduler reads this file to avoid re-spending on');
    console.error('bills already proven unpublishable. An absent file means it will re-attempt all of them.');
    process.exit(2);
  }

  const json = JSON.parse(readFileSync(PARKED_PATH, 'utf8'));
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

  const res = await fetch(`${URL_BASE}/rest/v1/parked_bills?select=bill_id,reason`, { headers: H });
  if (!res.ok) throw new Error(`parked_bills read failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const tableRows = await res.json();
  // expectArray discipline (PLAYBOOK 51): a non-array is an unreadable answer, not an empty one.
  if (!Array.isArray(tableRows)) throw new Error(`parked_bills did not return an array: ${JSON.stringify(tableRows).slice(0, 160)}`);
  const inTable = new Set(tableRows.map((r) => r.bill_id));

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — unpark ${UNPARK.length} stochastically-parked bill(s)\n`);
  console.log(`  parked.json entries now ....... ${Object.keys(json).length}`);
  console.log(`  parked_bills rows now ......... ${tableRows.length}\n`);

  const jsonHits = [];
  const tableHits = [];
  const missing = [];
  for (const u of UNPARK) {
    const inJson = Object.prototype.hasOwnProperty.call(json, u.bill_id);
    if (inJson) jsonHits.push(u); else missing.push(u);
    if (inTable.has(u.bill_id)) tableHits.push(u);
    console.log(`  ${u.identifier.padEnd(9)} json=${inJson ? 'YES' : 'no '} table=${inTable.has(u.bill_id) ? 'YES' : 'no '}  ${u.why}`);
  }

  console.log(`\n  would remove from parked.json .. ${jsonHits.length}`);
  console.log(`  would delete from parked_bills . ${tableHits.length}`);
  if (missing.length) {
    console.log(`  NOT PRESENT in parked.json ..... ${missing.length}  <- already unparked, or never parked; not an error`);
  }

  if (!apply) {
    console.log('\n  Dry run — nothing written. Re-run with --apply to perform it.');
    console.log('  After applying, these bills become eligible for the billed scheduler again and');
    console.log('  the next tick may attempt them. That is the intent; it is also real spend.');
    return;
  }

  // The JSON is the only copy of 30+ paid-for decisions and is gitignored, so it is backed up
  // before being rewritten. Losing it makes the billed scheduler re-spend on known-bad work,
  // silently - the exact failure migration 0039 was written to prevent.
  const backup = `${PARKED_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(PARKED_PATH, backup);
  console.log(`\n  backed up parked.json -> ${backup}`);

  for (const u of jsonHits) delete json[u.bill_id];
  writeFileSync(PARKED_PATH, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  console.log(`  parked.json rewritten: ${Object.keys(json).length} entries remain`);

  for (const u of tableHits) {
    const d = await fetch(`${URL_BASE}/rest/v1/parked_bills?bill_id=eq.${u.bill_id}`, {
      method: 'DELETE', headers: { ...H, Prefer: 'return=representation' },
    });
    if (!d.ok) throw new Error(`parked_bills delete failed for ${u.identifier}: HTTP ${d.status} ${(await d.text()).slice(0, 160)}`);
    const body = await d.json();
    // A DELETE that matched nothing returns 200 with an empty array. Reporting that as success is
    // the "absence reported as expected" failure this repo keeps hitting, so it is named.
    console.log(`  parked_bills: deleted ${Array.isArray(body) ? body.length : '?'} row(s) for ${u.identifier}`);
  }

  console.log('\n  Done. Verify with: npm run status  (parked count should drop by '
    + `${jsonHits.length}), and re-read ${PARKED_PATH}.`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
