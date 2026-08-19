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

// Final-review finding 1 (live-verified on THIS instance, per ingest-mo-house.js's own
// dryRunReport comment above this file): Supabase/PostgREST caps a single .select() response at
// 1000 rows server-side REGARDLESS of an explicit .range() request. Every unbounded full-table(-ish)
// select in this codebase must route through THIS one shared helper from here on — loop .range()
// pages of `pageSize` (default 1000, matching the server's own cap) until a page returns short,
// exactly like ingest-mo-house.js's dryRunReport pattern (that pattern is now retired in favor of
// this shared version; the bug it fixed independently resurfaced twice more — auto-publish-
// glossary.js's loadLatestVerifications and two review-server queue queries — because the fix
// wasn't shared).
//
// `filter` may chain its own business-meaningful predicate/order (e.g. `.eq('status', X)`,
// `.order('created_at', {ascending: true})`) onto the query builder before pagination begins.
// Pagination via .range() is only correct with a DETERMINISTIC order — without one, Postgres makes
// no promise that two separate .range() calls see the same row ordering, which could silently drop
// a row into the gap between two pages or return it twice. A tiebreaker on `orderBy` is therefore
// ALWAYS appended after whatever order `filter` set (or as the sole order, if `filter` set none).
// `orderBy` defaults to `'id'`, which assumes the table has a uuid `id` column — true for most
// tables this touches, but NOT universal: a table with a composite primary key and no surrogate
// `id` (e.g. summary_terms, PK (summary_id, term_id) — migration 0007) has no `id` column to order
// by at all, and the default would fail outright. Callers of such a table MUST pass `orderBy`
// explicitly — a string for a single column, or an array of columns to chain `.order()` once per
// column IN ORDER (a composite key needs every column to form a genuine total order; ordering by
// just the first column alone would leave ties within it undetermined across pages, same failure
// mode as having no order at all).
//
// Fail loud, never silently truncate (finding 1's fix direction): if the very LAST page fetched is
// still full-sized (`pageSize` rows), the loop cannot tell whether that was the true end of the
// table or whether `maxPages` cut it off mid-scan — throws rather than returning a result that
// LOOKS complete but might not be. `maxPages` defaults to 200 (200k rows at the default page size),
// the same sanity-backstop magnitude ingest-mo-house.js's dryRunReport used.
export async function selectAll(client, table, columns, {
  filter, pageSize = 1000, maxPages = 200, orderBy = 'id',
} = {}) {
  const orderCols = Array.isArray(orderBy) ? orderBy : [orderBy];
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    let query = client.from(table).select(columns);
    if (filter) query = filter(query);
    for (const col of orderCols) query = query.order(col, { ascending: true });
    query = query.range(from, from + pageSize - 1);
    // Sequential (not parallel) is deliberate: each page's .range() bounds depend on knowing the
    // PRIOR page came back full-sized — same "sequential, small/infrequent backlog" precedent as
    // ingest-mo-senate.js's replayJournalArtifacts.
    const { data, error } = await query;
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) return { data: rows, error: null };
  }
  throw new Error(
    `selectAll(${table}): hit maxPages (${maxPages}) at pageSize ${pageSize} without a short final `
      + 'page — refusing to return a possibly-truncated result. Raise maxPages or investigate why '
      + 'this table is now this large.',
  );
}

// Same shape as isMissingRelationError but for a missing COLUMN (e.g. legislators.mo_house_id
// before migration 0005 is applied — draft-then-apply, Lance's call when to run it). Matched
// on `.message` text alone, NOT `.code` — insertIfAbsent (above) wraps the real Supabase error
// into a plain `Error(...)` and only preserves `.message`, discarding `.code`, so a caller that
// went through insertIfAbsent (the normal path) never sees a `.code` at all. Checking the raw
// `.code` too is a harmless bonus for any caller working with an unwrapped Supabase error
// directly. PostgREST reports this as PGRST204 ("Could not find the '<col>' column of '<table>'
// in the schema cache"); raw Postgres reports 42703 undefined_column ('column "<col>" of
// relation "<table>" does not exist').
export function isMissingColumnError(error, column) {
  if (!error) return false;
  const code = error.code;
  const msg = String(error.message || '').toLowerCase();
  const mentionsColumn = msg.includes(column.toLowerCase());
  if (code === 'PGRST204' || code === '42703') return mentionsColumn;
  return mentionsColumn && (msg.includes('does not exist') || msg.includes('could not find'));
}

// Detects a Postgres CHECK constraint violation (23514) for a NAMED constraint — same
// code-primary/message-corroborated shape as isMissingRelationError/isMissingColumnError above, so
// a caller can tell "this specific constraint rejected the row" apart from every other kind of DB
// error without re-deriving the pattern. First use: src/cli/backfill-mo-bill-meta.js's pre-0015
// tolerance — a live run that reaches a widened-enum value (e.g. bill_sponsors.sponsor_type =
// 'joint'/'unspecified') before migration 0015 lands hits the OLD, narrower check constraint;
// this lets that be caught and named (which migration is still pending) rather than crashing the
// whole run or being lumped in with an unrelated failure.
export function isCheckConstraintViolation(error, constraintName) {
  if (!error) return false;
  const code = error.code;
  const msg = String(error.message || '').toLowerCase();
  const mentionsConstraint = msg.includes(constraintName.toLowerCase());
  if (code === '23514') return mentionsConstraint;
  return mentionsConstraint && msg.includes('violates check constraint');
}
