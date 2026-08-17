// STOPGAP (Lance, 2026-08-17: "two now, three later"): pre-park the fresh-queue bills that
// structurally CANNOT publish under the current MIN_KEY_PROVISIONS=3 completeness floor, so
// the scheduler's daily $1.00 goes to bills that can actually publish. Two lenses, both
// evidence-calibrated from tick d744297c (2026-08-17, $0.4836, 0 published):
//
//   1. Simple resolutions (SRES/HRES) regardless of length — 4 of 5 SRES that tick hard-failed
//      with "key_provisions has 1 entries, outside the required 3-7"; the 5th only reached a
//      gate-refused draft. Length does NOT predict this class: SRES 412 FAILED at 16,163 chars
//      while SRES 532 passed the floor at 14,354 — ceremonial "whereas" bulk hides a single
//      substantive provision. (Concurrent resolutions are NOT parked: HCONRES 14 produced 23
//      real provisions the same tick.)
//   2. Regular bills with text_length < 5,000 chars — the wave-C tiny-bill class (TODO
//      "Completeness-floor catch-22", 2026-08-08): per that entry's own scale, <2.5k chars
//      yields ~1 provision and <5k yields ~2, and the current floor is 3, so both bands fail
//      (HB 606 was drain-parked on exactly "2 key provisions < the 3-7 floor"). The queue is
//      smallest-first within priority, so without this park the next ~7 weeks of ticks would
//      chew through 298 sub-2.5k + 389 sub-5k bills at ~$0.02-0.05 each with ~zero publishes.
//
// REVERSIBLE BY DESIGN: every entry carries source 'tiny-bill-stopgap-2026-08-17'. When the
// length-scaled completeness floor lands (the TODO'd verifier.js assessCompleteness fix —
// approved direction, not yet built), unpark the whole class by deleting every parked.json
// entry with that source value. Merge-safe: never overwrites an existing entry.
//
// Usage:
//   node scripts/park-tiny-fresh-bills.mjs <path-to-saved-plan-json>
//   (the plan JSON is the output of: node --env-file=.env src/cli/summary-queue.js plan --dry-run)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEST_DIR = path.join(__dirname, '..', '.superpowers', 'artifacts', 'scheduled-summaries');
const DEST = path.join(DEST_DIR, 'parked.json');

const SOURCE_TAG = 'tiny-bill-stopgap-2026-08-17';
const TINY_CHARS = 5000;
const SIMPLE_RESOLUTION_RE = /^(SRES|HRES)\s/;

const planPath = process.argv[2];
if (!planPath) throw new Error('usage: node scripts/park-tiny-fresh-bills.mjs <plan-json-path>');
const raw = readFileSync(planPath, 'utf8');
const plan = JSON.parse(raw.slice(raw.indexOf('{')));
const queue = plan.queue ?? [];
if (queue.length === 0) throw new Error('plan JSON has an empty queue — refusing to run on no data');

const targets = queue.filter((i) =>
  SIMPLE_RESOLUTION_RE.test(i.identifier ?? '') || (i.text_length ?? Infinity) < TINY_CHARS
);

mkdirSync(DEST_DIR, { recursive: true });
const existing = existsSync(DEST) ? JSON.parse(readFileSync(DEST, 'utf8')) : {};
const now = new Date().toISOString();
let added = 0;
for (const item of targets) {
  if (!item.bill_id || existing[item.bill_id]) continue;
  const why = SIMPLE_RESOLUTION_RE.test(item.identifier ?? '')
    ? `simple resolution (${item.identifier}) — class cannot reliably yield the 3-provision completeness floor (4/5 hard-failed tick d744297c; length does not predict: SRES 412 failed at 16k chars)`
    : `${item.identifier} at ${item.text_length} chars — under the ${TINY_CHARS}-char band that yields <3 provisions (wave-C catch-22; current floor MIN_KEY_PROVISIONS=3)`;
  existing[item.bill_id] = {
    reason: `tiny-bill stopgap park pending the length-scaled completeness-floor fix: ${why}. Unpark this whole class (delete entries with source=${SOURCE_TAG}) when that fix lands.`,
    parked_at: now,
    source: SOURCE_TAG,
  };
  added += 1;
}
writeFileSync(DEST, `${JSON.stringify(existing, null, 2)}\n`);

const check = JSON.parse(readFileSync(DEST, 'utf8'));
const bySource = {};
for (const v of Object.values(check)) bySource[v.source ?? 'scheduler'] = (bySource[v.source ?? 'scheduler'] ?? 0) + 1;
console.log(JSON.stringify({
  queue_size: queue.length,
  matched_targets: targets.length,
  added,
  total_parked: Object.keys(check).length,
  by_source: bySource,
}, null, 2));
