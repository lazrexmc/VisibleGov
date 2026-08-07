// Summary-wave batch exporter: runs the summary-queue planner, takes the top N queued bills,
// fetches each bill's CURRENT hash-pinned text, and writes per-bill work files for the subagent
// wave (see docs/RUNBOOK_SUMMARY_WAVES.md). Read-only against the DB; writes only under
// .superpowers/artifacts/wave3/. The bill list is generated here BY CODE — never hand-typed
// (wave-2 lesson, re-proven in wave 3 when a hand-typed manifest fabricated ids/hashes).
// Run: node --env-file=.env scripts/export-summary-wave.mjs [N]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const N = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 12;
const OUT = '.superpowers/artifacts/wave3';
mkdirSync(`${OUT}/bills`, { recursive: true });

const planRaw = execFileSync(process.execPath, ['src/cli/summary-queue.js', 'plan', '--dry-run', '--limit', String(N)], { encoding: 'utf8', env: process.env });
const plan = JSON.parse(planRaw);
const queue = plan.queue ?? [];
if (queue.length === 0) throw new Error('planner returned an empty queue');

const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const manifest = [];
for (const item of queue) {
  const { data: rows, error } = await c.from('bill_texts').select('content,content_hash,retrieved_at').eq('bill_id', item.bill_id);
  if (error) throw new Error(`${item.identifier}: ${error.message}`);
  const current = (rows ?? []).reduce((a, r) => (!a || (r.retrieved_at ?? '') > (a.retrieved_at ?? '') ? r : a), null);
  if (!current) { console.error(`SKIP ${item.identifier}: no text`); continue; }
  if (current.content_hash !== item.bill_text_hash) { console.error(`SKIP ${item.identifier}: hash moved since plan`); continue; }
  writeFileSync(`${OUT}/bills/${item.bill_id}.txt`, current.content, 'utf8');
  manifest.push({
    bill_id: item.bill_id,
    identifier: item.identifier,
    title: item.title,
    bill_text_hash: item.bill_text_hash,
    text_length: current.content.length,
    text_file: `${OUT}/bills/${item.bill_id}.txt`,
  });
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify({ exported: manifest.length, identifiers: manifest.map((m) => m.identifier) }));
