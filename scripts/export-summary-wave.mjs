// Summary-wave batch exporter: runs the summary-queue planner, takes the top N queued bills,
// fetches each bill's CURRENT hash-pinned text, and writes per-bill work files for the subagent
// wave (see docs/RUNBOOK_SUMMARY_WAVES.md). Read-only against the DB; writes only under
// .superpowers/artifacts/wave3/. The bill list is generated here BY CODE — never hand-typed
// (wave-2 lesson, re-proven in wave 3 when a hand-typed manifest fabricated ids/hashes).
// Run: node --env-file=.env scripts/export-summary-wave.mjs [N]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { selectAll } from '../src/lib/db.js';
import { sessionRecencyKey } from '../src/lib/session-dates.js';

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

// Recency key per session: the real start_date, else the year parsed from the session's own
// identifier/name (src/lib/session-dates.js). Found 2026-08-21: 30 of 31 MO sessions carried a
// NULL start_date, so this sort had silently degraded to arbitrary order for 95% of the queue.
// Undated sessions are now counted and REPORTED (stderr + the exported summary), never hidden;
// `src/cli/sync-session-dates.js` fills the dates from traceable sources.
// Both reads go through selectAll (ORDER BY id + range) — an unordered .range() scan over ~38k
// bills can skip or duplicate rows between pages, and a skipped bill would silently sort last.
const { data: sessions, error: sessErr } = await selectAll(c, 'sessions', 'id,identifier,name,start_date');
if (sessErr) throw new Error(`sessions lookup failed: ${sessErr.message}`);
const sessionKey = new Map(sessions.map((s) => [s.id, sessionRecencyKey(s)]));
const { data: billSessionRows, error: billErr } = await selectAll(c, 'bills', 'id,session_id');
if (billErr) throw new Error(`bills lookup failed: ${billErr.message}`);
const billSession = new Map(billSessionRows.map((b) => [b.id, sessionKey.get(b.session_id) ?? { key: '', dated: false }]));
const queueBillsNotFound = fullQueue.filter((q) => !billSession.has(q.bill_id)).length;
const undatedQueueItems = fullQueue.filter((q) => billSession.has(q.bill_id) && !billSession.get(q.bill_id).dated).length;
if (queueBillsNotFound > 0) console.error(`WARNING: ${queueBillsNotFound} queued bill id(s) not found in the bills read — they sort last; investigate before trusting this order`);
if (undatedQueueItems > 0) console.error(`WARNING: ${undatedQueueItems} of ${fullQueue.length} queued bills belong to a session with no start_date — ordered by name/identifier year only; run src/cli/sync-session-dates.js`);

const queue = [...fullQueue]
  .sort((a, b) => {
    const sa = billSession.get(a.bill_id)?.key ?? '';
    const sb = billSession.get(b.bill_id)?.key ?? '';
    if (sa !== sb) return sb.localeCompare(sa); // newest session first; missing keys sort last
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
    // session_start is a REAL date or null — never the synthetic sort key; the key and whether a
    // fallback was used are carried separately so the manifest never presents a pseudo-date.
    session_start: billSession.get(item.bill_id)?.dated ? billSession.get(item.bill_id).key : null,
    session_sort_key: billSession.get(item.bill_id)?.key || null,
    session_dated: billSession.get(item.bill_id)?.dated ?? false,
  });
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2), 'utf8');
const bySession = {};
for (const m of manifest) { const k = m.session_start ?? (m.session_sort_key ? `${m.session_sort_key.slice(0, 4)} (undated session)` : 'unknown'); bySession[k] = (bySession[k] ?? 0) + 1; }
console.log(JSON.stringify({ exported: manifest.length, sessions: bySession, undated_queue_items: undatedQueueItems, queue_bills_not_found: queueBillsNotFound, identifiers: manifest.map((m) => m.identifier) }));
