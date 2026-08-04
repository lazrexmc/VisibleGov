import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// Senior engineering audit (2026-08-03, finding 7): migration 0026's fix for the real ~14-hour
// production outage (CREATE OR REPLACE FUNCTION silently dropping 0018a's separate
// `ALTER FUNCTION ... SET statement_timeout` — see 0026's own header) is enforced today ONLY by a
// comment telling a future author not to redefine refresh_vote_aggregates() without checking for
// this. That is exactly the kind of guard that already failed once: 0022's own author inspected
// the function, wrote "UNCHANGED," and shipped the timeout-dropping version anyway (see 0022's own
// SUPERSEDED-BY note above its refresh_vote_aggregates() block). A migration-text test is cheap,
// mechanical insurance the comment alone isn't.
//
// Deliberately dynamic, not hardcoded to 0026: this scans supabase/migrations/ for whichever file
// holds the MOST RECENT `create or replace function refresh_vote_aggregates` definition and checks
// THAT one. If a future migration (0027+) redefines the function again, this test automatically
// starts checking the new file — exactly the moment a future author needs to be reminded that this
// function has a separate, easy-to-drop timeout requirement. Pinning this to "0026" by filename
// would make the test blind the instant a 0027 redefinition landed, silently defeating its own
// purpose.

const MIGRATIONS_DIR = 'supabase/migrations';

function findLatestRefreshVoteAggregatesDefinition() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let latest = null;
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
    if (/create or replace function refresh_vote_aggregates/i.test(sql)) {
      latest = { file, sql };
    }
  }
  return latest;
}

function extractFunctionBody(sql) {
  // From the CREATE OR REPLACE FUNCTION statement itself through its closing `$$;` — scoped to
  // just this one function's own definition, not the whole migration file (which may define
  // other, unrelated objects with their own SET clauses).
  const match = sql.match(/create or replace function refresh_vote_aggregates\(\)[\s\S]*?\$\$;/i);
  return match ? match[0] : null;
}

test('the LATEST migration to redefine refresh_vote_aggregates() still folds statement_timeout directly into its own declaration', () => {
  const latest = findLatestRefreshVoteAggregatesDefinition();
  assert.ok(latest, 'no migration defines refresh_vote_aggregates() at all — the function itself may have been removed or renamed; update this test to match');

  const body = extractFunctionBody(latest.sql);
  assert.ok(body, `found refresh_vote_aggregates() in ${latest.file} but could not isolate its function body via the CREATE...$$; pattern — the SQL shape changed enough that this test's own extraction regex needs updating`);

  assert.match(
    body,
    /set\s+statement_timeout\s*=\s*'?\d+s'?/i,
    `${latest.file}'s refresh_vote_aggregates() definition has no inline "set statement_timeout" — this is the EXACT class of regression that caused a real ~14-hour production outage (0022 silently dropped 0018a's separate ALTER FUNCTION timeout). If this migration genuinely intends to redefine the function, it MUST fold "set statement_timeout = '600s'" (or a deliberately-chosen replacement value) directly into the function's own declaration, the same way 0026 does — never rely on a separate ALTER FUNCTION surviving a future CREATE OR REPLACE.`,
  );
});

test('sanity: as of this writing, 0027 is genuinely the file this test is exercising (fails loudly, not silently, if migration numbering/ordering ever changes)', () => {
  const latest = findLatestRefreshVoteAggregatesDefinition();
  assert.equal(latest.file, '0027_pg_cron_refresh_aggregates.sql');
});
