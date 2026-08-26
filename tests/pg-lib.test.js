import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPgPool, pgQuery, closePgPool } from '../src/lib/pg.js';

// The direct-Postgres path is an OPTIONAL analysis accelerator. Its most important property for
// everyone who never configures it is that it is completely inert: same "unset env var = the
// feature is simply absent" contract getClient() and pingHealthcheck() already follow. These tests
// deliberately never touch a database.

test('getPgPool returns null when SUPABASE_DB_URL is unset — the feature is simply absent', async () => {
  const saved = process.env.SUPABASE_DB_URL;
  delete process.env.SUPABASE_DB_URL;
  try {
    assert.equal(getPgPool(), null);
  } finally {
    if (saved !== undefined) process.env.SUPABASE_DB_URL = saved;
    await closePgPool();
  }
});

test('pgQuery THROWS a setup message when unconfigured — never returns empty rows', async () => {
  // A silent [] here would be indistinguishable from "the query found nothing", which is exactly
  // the class of bug that has produced false findings in this project three times.
  const saved = process.env.SUPABASE_DB_URL;
  delete process.env.SUPABASE_DB_URL;
  try {
    await assert.rejects(() => pgQuery('select 1'), /SUPABASE_DB_URL is not set/);
  } finally {
    if (saved !== undefined) process.env.SUPABASE_DB_URL = saved;
    await closePgPool();
  }
});

test('closePgPool is safe to call when nothing was ever opened', async () => {
  await closePgPool();
  await closePgPool();
});
