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

// Recency-first (Lance, 2026-08-09: "hitting the current session bills first"): pull the FULL
// planner queue, then order it by legislative-session start date (newest session first) before
// taking the top N. The planner's own passage-first priority survives as a tiebreak within a
// session (stable sort), and within the same session+priority the smallest bills come first so
// each wave lands its cheapest wins early. The planner itself is untouched.
const planRaw = execFileSync(process.execPath, ['src/cli/summary-queue.js', 'plan', '--dry-run'], { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
const plan = JSON.parse(planRaw);
const fullQueue = plan.queue ?? [];
if (fullQueue.length === 0) throw new Error('planner returned an empty queue');

const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function pageAll(table, cols) {
  let rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await c.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table} lookup failed: ${error.message}`);
    rows = rows.concat(data ?? []);
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}

const sessions = await pageAll('sessions', 'id,start_date');
const sessionStart = new Map(sessions.map((s) => [s.id, s.start_date ?? '']));
const billSessionRows = await pageAll('bills', 'id,session_id');
const billSession = new Map(billSessionRows.map((b) => [b.id, sessionStart.get(b.session_id) ?? '']));

const queue = [...fullQueue]
  .sort((a, b) => {
    const sa = billSession.get(a.bill_id) ?? '';
    const sb = billSession.get(b.bill_id) ?? '';
    if (sa !== sb) return sb.localeCompare(sa); // newest session first; missing dates sort last
    if (a.priority !== b.priority) return a.priority === 'passage' ? -1 : 1;
    return (a.text_length ?? Infinity) - (b.text_length ?? Infinity);
  })
  .slice(0, N);
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
    session_start: billSession.get(item.bill_id) || null,
  });
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2), 'utf8');
const bySession = {};
for (const m of manifest) bySession[m.session_start ?? 'unknown'] = (bySession[m.session_start ?? 'unknown'] ?? 0) + 1;
console.log(JSON.stringify({ exported: manifest.length, sessions: bySession, identifiers: manifest.map((m) => m.identifier) }));
