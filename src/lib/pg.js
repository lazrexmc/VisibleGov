// pg.js — a direct Postgres connection for ANALYTICAL READS ONLY.
//
// WHY THIS EXISTS ALONGSIDE src/lib/db.js
//
// db.js speaks PostgREST through supabase-js, and that is the right tool for ingestion and for
// everything the public site does: RLS is the security wall, and every write in this project should
// keep going through it. But PostgREST is a bad fit for *analysis*, and this project has paid for
// that three separate times:
//
//   - It silently caps every read at 1,000 rows regardless of `.limit()`. That trap produced a
//     false catastrophe in the 2026-08-26 audit (708 summaries reported "unverified"; the real
//     answer was 0) and it is why `selectAll` exists at all.
//   - It cannot aggregate. Counting casts per vote means fetching every cast row to the client.
//   - A sweep over ~10k votes costs hundreds of round trips. Measured in this repo: fingerprinting
//     5,058 votes took ~10 minutes and ~760 requests. The equivalent SQL is one query, ~2 seconds.
//
// The same question written as SQL is also structurally immune to the truncation trap, because
// `count(*)` does not paginate.
//
// CONTRACT — read every line before using this:
//
//   1. READ ONLY, ENFORCED BY POSTGRES. Every statement runs inside `BEGIN TRANSACTION READ ONLY`,
//      so the server itself rejects INSERT/UPDATE/DELETE/DDL. This is deliberately not a string
//      check on the query text — a regex over SQL is a guess, a read-only transaction is a promise.
//   2. IT BYPASSES RLS. This connects with the database credentials, not the anon key, so none of
//      the public view scoping applies. NEVER use it in site/, in a Pages Function, or anywhere a
//      visitor's input reaches. It is for audit and analysis scripts run by hand.
//   3. NEVER WRITE THROUGH IT. Writes stay on supabase-js so they keep passing the same RLS and
//      view surface the rest of the system is verified against. If you find yourself wanting a
//      fast bulk write, that is a migration, and migrations are Lance's apply.
//   4. IT IS OPTIONAL. With SUPABASE_DB_URL unset, getPgPool() returns null and callers fall back
//      to the supabase-js path — the same "unset env var = feature simply absent" contract
//      getClient() and pingHealthcheck() already follow. Nothing breaks if it is never configured.
//
// SETUP: click CONNECT at the top of the Supabase dashboard (beside the branch selector; shortcut
// O then C), then the "Session pooler" entry (port 5432 — not the 6543 transaction pooler, which
// cannot do the prepared statements node-postgres uses). As of 2026-08 this is NOT under Project
// Settings -> Database; that page shows only project name, region and service versions.
// Put the URI in .env as SUPABASE_DB_URL. It contains the database password, which is NOT the
// service-role key and is NOT interchangeable with it.
// .env is already gitignored; never paste this string into a doc, a commit, or a chat message.

import pg from 'pg';

let pool = null;

export function getPgPool() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) return null;
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: url,
    // Supabase terminates TLS with a certificate chain node does not ship a root for. The
    // connection is still encrypted; we are not verifying the server certificate. Acceptable here
    // because this is an operator-run analysis path against a known host, and it is exactly what
    // the Supabase docs prescribe for this client.
    ssl: { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    // A runaway analytical query should die rather than pin a connection. Generous enough for a
    // full-table aggregate over 1.4M casts, which measures in low single-digit seconds.
    statement_timeout: 120_000,
  });
  return pool;
}

// Run one read-only query. Returns rows. Throws with the SQL attached on failure, because a silent
// null here would be indistinguishable from "no rows", which is the exact class of bug that has
// bitten this project repeatedly (a swallowed error looks like a finding, not a fault).
export async function pgQuery(sql, params = []) {
  const p = getPgPool();
  if (!p) throw new Error('pgQuery: SUPABASE_DB_URL is not set — see src/lib/pg.js for setup');
  const client = await p.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    return res.rows;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already dead */ }
    throw new Error(`pgQuery failed: ${err.message}\n--- sql ---\n${String(sql).trim().slice(0, 600)}`, { cause: err });
  } finally {
    client.release();
  }
}

// Convenience for the common "one row, one number" case.
export async function pgCount(sql, params = []) {
  const rows = await pgQuery(sql, params);
  if (!rows.length) return 0;
  const first = rows[0];
  const key = Object.keys(first)[0];
  return Number(first[key]);
}

export async function closePgPool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
