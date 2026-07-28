import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Migration-shape tests: no other test file reads a supabase/migrations/*.sql file's raw text
// directly (0007 is still Lance's to apply — draft-then-apply), so these are narrowly scoped to
// exactly the two fix-wave changes that live ONLY in the SQL text and would otherwise have no
// test coverage at all: the amended publish-completeness CHECK (Minor finding 4) and the
// Background label schema comment (Minor finding 5).
const sql = readFileSync('supabase/migrations/0007_glossary.sql', 'utf8');

// ---- fix wave (Minor finding 4): empty-string gloss_md must not satisfy the publish-completeness
// CHECK — 'gloss_md is not null' alone passed '' (not null != non-empty). ----

test('glossary_terms_published_complete CHECK rejects empty-string gloss_md, not just null', () => {
  assert.match(sql, /gloss_md is not null and gloss_md <> ''/);
});

test('glossary_terms_published_complete CHECK still requires source_url/source_hash (unchanged by this fix)', () => {
  const checkMatch = sql.match(/constraint glossary_terms_published_complete check \(([\s\S]*?)\)\s*\n\);/);
  assert.ok(checkMatch, 'could not locate the glossary_terms_published_complete CHECK body in 0007_glossary.sql');
  const body = checkMatch[1];
  assert.match(body, /source_url is not null/);
  assert.match(body, /source_hash is not null/);
});

// ---- fix wave (Minor finding 5): the approved design's "Background" label must appear as a
// schema comment, verbatim ----

test('0007 carries the approved Background label as a schema comment on gloss_md, verbatim', () => {
  assert.match(sql, /Background — from the referenced law's official text/);
});
