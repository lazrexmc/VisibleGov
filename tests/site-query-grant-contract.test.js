import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Senior engineering audit (2026-08-03, finding 14): the 0025 production regression (bill-page.js
// querying `summaries` with no explicit select=, defaulting to `*`, which migration 0025's
// column-level GRANT denies outright rather than silently narrowing) was — and, without this test,
// STILL IS — invisible to the test suite. A verifier ran the pre-fix broken bill-page.js code
// against the full suite as it stood after the fix shipped: 57/57 passed anyway, because nothing
// in the suite compares a real site query string against what a migration actually grants.
//
// This is a PURE, offline, text-level contract check — no live DB, no anon key, no network (that
// live half already exists: scripts/probe-public-surface.js, extended alongside this same audit
// finding). It reads migration 0025's own GRANT statements as the single source of truth for what
// columns anon may read, then scans every real site/js file that queries `summaries`/
// `glossary_terms` directly and asserts every query's own select= list is a subset. A query with NO
// select= at all (implicitly requesting every column, i.e. `*`) is flagged as its own violation —
// exactly the shape of the original bug.

const MIGRATION_PATH = 'supabase/migrations/0025_scope_summaries_glossary_columns.sql';
const SITE_FILES = ['site/js/bill-page.js', 'site/js/person-page.js', 'site/js/trust-page.js'];

function extractGrantedColumns(sql, table) {
  const re = new RegExp(`grant select \\(([^)]+)\\) on ${table} to`, 'i');
  const match = sql.match(re);
  assert.ok(match, `could not find a "grant select (...) on ${table} to" statement in ${MIGRATION_PATH} — the migration's SQL shape changed enough that this test's own extraction regex needs updating`);
  return match[1].split(',').map((c) => c.trim());
}

// Finds every real query string in `source` that targets `table` — matches both backtick template
// literals (restGet(`summaries?...`)) and plain quoted strings (trust-page.js's `path: '...'`).
// Comment lines are skipped (person-page.js:59 documents the real query inline in a comment —
// scanning it too would just be a harmless duplicate, but excluding it keeps violations
// unambiguous). The select= value itself never contains a template interpolation in any real
// query today, so extracting it via a plain regex against the raw matched string is safe.
function findQueryStrings(source, table) {
  const found = [];
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('*')) continue; // comment lines, incl. block-comment continuation
    // Captures the OPENING delimiter (backtick/single/double quote) and requires the SAME
    // character to close — a plain "any quote char" exclusion class breaks on a template literal
    // whose ${...} interpolation itself contains a different quote type (e.g. `${x.join(',')}`,
    // a real shape in this codebase: a single quote inside a backtick-delimited string).
    const re = new RegExp('([`\'"])(' + table + '\\?[\\s\\S]*?)\\1', 'g');
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(rawLine)) !== null) found.push(m[2]);
  }
  return found;
}

function selectColumnsOf(queryString) {
  const m = queryString.match(/[?&]select=([^&]*)/);
  if (!m) return null; // no select= param at all — implicit `*`, the exact original bug shape
  return m[1].split(',').map((c) => c.trim()).filter(Boolean);
}

const sql = readFileSync(MIGRATION_PATH, 'utf8');
const GRANTED = {
  summaries: new Set(extractGrantedColumns(sql, 'summaries')),
  glossary_terms: new Set(extractGrantedColumns(sql, 'glossary_terms')),
};

test('sanity: migration 0025 grants the exact columns this test expects (fails loudly, not silently, if the grant ever changes)', () => {
  assert.deepEqual([...GRANTED.summaries].sort(), ['bill_id', 'body_md', 'created_at', 'id', 'model', 'published_at', 'status'].sort());
  assert.deepEqual([...GRANTED.glossary_terms].sort(), ['citation', 'gloss_md', 'id', 'kind', 'source_url', 'status', 'supported_by_quote', 'term'].sort());
});

for (const table of ['summaries', 'glossary_terms']) {
  test(`every real site/js query against "${table}" requests only columns migration 0025 actually grants`, () => {
    let queriesChecked = 0;
    for (const file of SITE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const queryString of findQueryStrings(source, table)) {
        queriesChecked += 1;
        const requested = selectColumnsOf(queryString);
        assert.ok(
          requested !== null,
          `${file}: a "${table}" query has no select= parameter at all (implicit "*") — this is EXACTLY `
            + `the shape of the real production regression: ${JSON.stringify(queryString)}`,
        );
        const ungranted = requested.filter((c) => !GRANTED[table].has(c));
        assert.deepEqual(
          ungranted,
          [],
          `${file}: query requests column(s) migration 0025 does not grant on "${table}": `
            + `${ungranted.join(', ')} — full query: ${JSON.stringify(queryString)}`,
        );
      }
    }
    assert.ok(queriesChecked > 0, `found zero real "${table}" queries in site/js/*.js — the scan itself may be broken (file paths/regex), not a genuine "nothing to check"`);
  });
}
