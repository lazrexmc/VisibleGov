import { createClient } from '@supabase/supabase-js';

// Additive writes (PLAYBOOK §3.5): only fields that are currently null/undefined may be filled.
export function additivePatch(existing, incoming) {
  const patch = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === undefined) continue;
    if (existing[key] === null || existing[key] === undefined) patch[key] = value;
  }
  return patch;
}

export function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // callers treat null as dry-run
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function openRun(client, source) {
  const { data, error } = await client
    .from('ingestion_runs')
    .insert({ source, status: 'running' })
    .select('id')
    .single();
  if (error) throw new Error(`could not open ingestion run: ${error.message}`);
  return data.id;
}

export async function closeRun(client, runId, status, detail = {}) {
  const { error } = await client
    .from('ingestion_runs')
    .update({ status, detail, finished_at: new Date().toISOString() })
    .eq('id', runId);
  if (error) throw new Error(`could not close ingestion run ${runId}: ${error.message}`);
}

export async function insertIfAbsent(client, table, rows, onConflict) {
  if (rows.length === 0) return;
  const { error } = await client.from(table).upsert(rows, { onConflict, ignoreDuplicates: true });
  if (error) throw new Error(`insertIfAbsent(${table}) failed: ${error.message}`);
}
