// Seed the scheduled-summaries runner's parked.json from the drain lane's PARKED set in
// scripts/build-drain-wave.mjs, so the billed conversion lane never spends budget
// re-attempting bills the drain lane already parked after exhausted supervised retries
// (they all have drafts + verifications on file, which makes them conversion-eligible,
// and the lane's oldest-flagged-first ordering puts them at the FRONT of the queue).
//
// First run 2026-08-17 seeded 27 entries; verified by dry-run that zero parked IDs
// remain in the assembled lanes (2,269 -> 2,261). Merge-safe and idempotent: an existing
// parked.json entry (scheduler-authored or prior seed) is never overwritten, so this can
// be re-run any time the drain lane parks new bills — or after a disk loss, since
// parked.json lives in the gitignored .superpowers/artifacts tree while this script and
// the PARKED set it reads are both committed.
//
// Usage: node scripts/seed-scheduler-parks.mjs   (no env needed; purely local files)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'build-drain-wave.mjs');
const DEST_DIR = path.join(__dirname, '..', '.superpowers', 'artifacts', 'scheduled-summaries');
const DEST = path.join(DEST_DIR, 'parked.json');

const src = readFileSync(SRC, 'utf8');
const blockMatch = src.match(/const PARKED = new Set\(\[([\s\S]*?)\]\);/);
if (!blockMatch) throw new Error('PARKED block not found in build-drain-wave.mjs');

const entryRe = /'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',\s*\/\/\s*(.+)/g;
const entries = [];
for (let m; (m = entryRe.exec(blockMatch[1])) !== null;) {
  entries.push({ bill_id: m[1], comment: m[2].trim() });
}
if (entries.length === 0) throw new Error('no UUID entries parsed from PARKED block');

const dupes = entries.length - new Set(entries.map((e) => e.bill_id)).size;
if (dupes > 0) throw new Error(`${dupes} duplicate bill_id(s) in PARKED block`);

mkdirSync(DEST_DIR, { recursive: true });
const existing = existsSync(DEST) ? JSON.parse(readFileSync(DEST, 'utf8')) : {};
const now = new Date().toISOString();
let added = 0;
for (const { bill_id, comment } of entries) {
  if (existing[bill_id]) continue; // never overwrite a scheduler-authored park
  existing[bill_id] = {
    reason: `drain-lane park (seeded from scripts/build-drain-wave.mjs PARKED set): ${comment}`,
    parked_at: now,
    source: `drain-lane-seed-${now.slice(0, 10)}`,
  };
  added += 1;
}
writeFileSync(DEST, `${JSON.stringify(existing, null, 2)}\n`);

const check = JSON.parse(readFileSync(DEST, 'utf8'));
console.log(JSON.stringify({
  parsed_from_source: entries.length,
  added,
  total_in_parked_json: Object.keys(check).length,
}, null, 2));
