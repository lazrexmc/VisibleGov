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

// Detects "relation does not exist", whether reported as a raw Postgres error (undefined_table,
// 42P01) or PostgREST's own "not in schema cache" shape (seen when a table was never created —
// e.g. before a migration is applied). Lives here (not in either caller) because src/cli/verify.js
// imports pickBillText from src/review/server.js — importing this the other direction would be
// circular. Both the verify CLI (dry-run tolerance) and the review server (graceful degradation
// when a migration hasn't landed yet) share this predicate.
export function isMissingRelationError(error, table) {
  if (!error) return false;
  const code = error.code;
  const msg = String(error.message || '').toLowerCase();
  const mentionsTable = msg.includes(table.toLowerCase());
  // The Postgres/PostgREST error codes for "relation doesn't exist" are the same regardless of
  // WHICH relation — the table name only shows up in the message — so even a code match must
  // still be confirmed against the message to avoid matching a different missing table.
  if (code === '42P01' || code === 'PGRST205') return mentionsTable;
  return mentionsTable && (msg.includes('does not exist') || msg.includes('could not find the table'));
}
