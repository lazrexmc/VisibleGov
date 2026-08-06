import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// 2026-08-04: migration 0029 fixed a real production outage caused by the classic Postgres
// planner trap in `left join vote_duplicates vd on vd.superseded_vote_id = v.id ... where vd.id is
// null` (introduced by 0022 to exclude superseded votes from all three public vote-aggregate
// matviews) — the planner catastrophically underestimated this anti-join's selectivity as 1 row
// when the honest answer was ~10,044, cascading into nested-loop joins over ~1.34M rows and turning
// a sub-minute query into 40+ minutes. The fix (`not exists (select 1 from vote_duplicates vd where
// vd.superseded_vote_id = v.id)`) is semantically identical but gives Postgres's dedicated
// anti-join estimator a chance to get the selectivity right. This is a non-obvious trap — a future
// editor "simplifying" this back to a LEFT JOIN would reintroduce the same outage with no warning
// until the data grew enough to hit a timeout again. Deliberately dynamic, not hardcoded to 0029:
// scans supabase/migrations/ for whichever file holds the MOST RECENT definition of each matview,
// same pattern as tests/refresh-vote-aggregates-migration.test.js.

const MIGRATIONS_DIR = 'supabase/migrations';
const MATVIEWS = ['public_position_totals', 'public_party_alignment', 'public_party_position_totals'];

function stripSqlComments(sql) {
  // Line comments only (-- ...) — none of these migrations use /* */ block comments, and this
  // test's own regexes only need to avoid matching prose in header comments (which sometimes
  // quote the exact broken pattern being fixed, e.g. 0029's own header).
  return sql.replace(/--.*$/gm, '');
}

function findLatestMatviewDefinition(matviewName) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let latest = null;
  const createPattern = new RegExp(`create materialized view ${matviewName}\\b`, 'i');
  for (const file of files) {
    const rawSql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
    if (createPattern.test(rawSql)) {
      latest = { file, sql: stripSqlComments(rawSql) };
    }
  }
  return latest;
}

for (const matview of MATVIEWS) {
  test(`the LATEST migration to define ${matview} excludes vote_duplicates via NOT EXISTS, not the LEFT JOIN + IS NULL anti-join idiom`, () => {
    const latest = findLatestMatviewDefinition(matview);
    assert.ok(latest, `no migration defines ${matview} at all — the matview may have been removed or renamed; update this test to match`);

    assert.doesNotMatch(
      latest.sql,
      /left join vote_duplicates[\s\S]{0,80}where[\s\S]{0,20}\.id is null/i,
      `${latest.file}'s definition of ${matview} uses "left join vote_duplicates ... where x.id is null" — this is the EXACT pattern that caused a real production outage (0029's own header): Postgres misestimates this anti-join's selectivity so badly (observed: 1 row instead of ~10,044) that every downstream join gets planned as a catastrophic nested loop. Use "not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id = v.id)" instead — same semantics, correct planner estimation.`,
    );

    assert.match(
      latest.sql,
      /not exists\s*\(\s*select 1 from vote_duplicates/i,
      `${latest.file}'s definition of ${matview} has no "not exists (select 1 from vote_duplicates ...)" anti-join — if this migration genuinely intends to exclude superseded votes some other way, verify via EXPLAIN that the plan doesn't regress to nested loops before updating this test.`,
    );
  });
}

test('sanity: as of this writing, 0029 is genuinely the file this test is exercising for all three matviews', () => {
  for (const matview of MATVIEWS) {
    const latest = findLatestMatviewDefinition(matview);
    assert.equal(latest.file, '0029_fix_vote_duplicates_antijoin_planner_misestimate.sql', `expected 0029 to be the latest migration defining ${matview}`);
  }
});

// ---- 2026-08-05 (deploy night): the SAME guard, extended to the two plain VIEWS ----
//
// The scoping gap this closes bit in production on the first deploy: this test originally covered
// only the three MATVIEWS 0029 fixed, while `public_vote_feed`/`public_votes` (plain views, 0023)
// kept the LEFT JOIN + IS NULL idiom. With vote_duplicates empty that was invisible; once the
// backfill landed 59 (now 62) rows and vote_casts reached ~1.47M, the misplanned view query
// crossed anon's 3s statement_timeout and every anonymous profile's vote list 500'd on
// visiblegov.pages.dev — found by the Phase 2 browser walk, minutes after first deploy. Migration
// 0031 is the fix; this extension is what makes the whole idiom class unrepresentable in ANY
// current definition, matview or view, instead of only the objects that had already burned us.

const VIEWS = ['public_vote_feed', 'public_votes'];

function findLatestViewDefinition(viewName) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let latest = null;
  // `create view <name>\b` — cannot match `create materialized view` (literal differs), and
  // `public_votes\b` cannot match `public_vote_feed` (no 's' after 'vote' there).
  const createPattern = new RegExp(`create view ${viewName}\\b`, 'i');
  for (const file of files) {
    const rawSql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
    if (createPattern.test(rawSql)) {
      latest = { file, sql: stripSqlComments(rawSql) };
    }
  }
  return latest;
}

for (const view of VIEWS) {
  test(`the LATEST migration to define ${view} excludes vote_duplicates via NOT EXISTS, not the LEFT JOIN + IS NULL anti-join idiom`, () => {
    const latest = findLatestViewDefinition(view);
    assert.ok(latest, `no migration defines ${view} at all — the view may have been removed or renamed; update this test to match`);

    assert.doesNotMatch(
      latest.sql,
      /left join vote_duplicates[\s\S]{0,80}where[\s\S]{0,20}\.id is null/i,
      `${latest.file}'s definition of ${view} uses "left join vote_duplicates ... where x.id is null" — the exact planner-misestimation idiom that broke production TWICE (matview refresh timeouts, fixed by 0029; then anon 3s timeouts on every profile vote list on deploy night, fixed by 0031). Use "not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id = v.id)" instead.`,
    );

    assert.match(
      latest.sql,
      /not exists\s*\(\s*select 1 from vote_duplicates/i,
      `${latest.file}'s definition of ${view} has no "not exists (select 1 from vote_duplicates ...)" anti-join — if it genuinely intends to exclude superseded votes some other way, verify the plan with EXPLAIN under the ANON role's 3s statement_timeout before updating this test.`,
    );
  });
}

test('sanity: as of this writing, 0031 is genuinely the file this test is exercising for both views', () => {
  for (const view of VIEWS) {
    const latest = findLatestViewDefinition(view);
    assert.equal(latest.file, '0031_fix_public_views_antijoin_planner_misestimate.sql', `expected 0031 to be the latest migration defining ${view}`);
  }
});
