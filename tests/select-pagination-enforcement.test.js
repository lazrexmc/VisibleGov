import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Mechanical enforcement for the single most recurring bug class in this codebase's history:
// PostgREST caps any single .select() response at 1,000 rows (src/lib/db.js's own selectAll
// header: "Every unbounded full-table(-ish) select in this codebase must route through THIS one
// shared helper from here on"). That law has been written down and then silently bypassed at
// least five separate times on record — the original vote-duplicates truncation (senior
// engineering audit finding 1, 2026-08-03), auto-publish-glossary.js/gloss.js/review/server.js's
// glossary queue (fixed the same week), and a hotfix-path recurrence documented in
// PLAYBOOK_DELTA.md's own VisibleGov-delta item 12 — before the 2026-08-05 deep code audit found
// roughly a dozen MORE currently-live instances across ingest.js, ingest-mo-house.js,
// correct-data.js, golden.js, summarize.js, verify.js, extract-terms.js, and review/server.js.
// TODO.md items 18/32 already separately track the summarize.js instance specifically; this test
// is the mechanical backstop the project decided (2026-08-05, "proceed with 1 and 2") it needed
// instead of relying on a convention holding by memory alone — see PLAYBOOK_DELTA's own Lesson 15
// ("a schema bound is a request, not a guarantee... anything you declare... must be re-verified
// mechanically at the gate") and Lesson 23 (grepping for a marker proves only the branches that
// already have it) — the same doctrine applied one level up, to a coding CONVENTION rather than a
// runtime value.
//
// Design: rather than a doomed attempt to retrofit ~19 already-known call sites in one pass (real,
// separate work — tracked in TODO.md), this test GRANDFATHERS today's known debt by an explicit,
// dated, file-scoped allowlist, and fails loud the moment any NEW file introduces the same
// bare-`.select()` shape. Removing a file from ALLOWLISTED_UNSAFE_FILES below (once its own
// unbounded selects are fixed) is how this test's own enforcement widens over time — the allowlist
// is meant to shrink, not grow.

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function stripJsComments(source) {
  // Line comments only — this codebase's own convention (confirmed by the same technique already
  // used in tests/vote-duplicates-antijoin-migration.test.js and
  // tests/refresh-vote-aggregates-migration.test.js). Block comments (/* */) are rare in this
  // codebase's actual code (as opposed to JSDoc-style file headers, which are line-comment blocks
  // here) — a full stripper isn't needed and would risk eating real template-literal content that
  // happens to contain "/*".
  return source.replace(/^[ \t]*\/\/.*$/gm, '');
}

function listJsFiles(dir) {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
}

// ---- Server-side: every unbounded multi-row .select() must route through selectAll ----

// db.js is selectAll's own canonical implementation — its internal `client.from(table).select(...)`
// call IS the correct pattern this whole test enforces everyone else use, not a violation of it.
const SERVER_SCAN_DIRS = ['src', 'scripts'];
const SERVER_EXCLUDE_FILES = new Set([
  path.join(REPO_ROOT, 'src', 'lib', 'db.js'),
]);

// Dated, file-scoped, currently-known debt (2026-08-05 deep code audit — see CHATLOG.md same date).
// A file listed here is NOT exempt from ever being checked again — it's exempt from THIS test
// specifically until its own unbounded selects are fixed as their own tracked work. Remove an
// entry once that file's violations are fixed; do not add a new entry without a comment citing
// the specific finding.
const ALLOWLISTED_UNSAFE_FILES = new Map([
  [path.join('src', 'cli', 'ingest.js'), 'legislators/bills lookups (byBioguide, byIdentifier) — 2026-08-05 audit; legislators already at 940/1000 on the actively-scheduled us-congress path'],
  [path.join('src', 'cli', 'ingest-mo-house.js'), 'listPendingRollCallPdfs’s votes + vote_casts doneness queries — 2026-08-05 audit; dormant only because the MO House roster gap keeps real cast volume low (TODO.md, MO House per-legislator vote coverage)'],
  [path.join('src', 'cli', 'correct-data.js'), 'runCorrectMoHouseChamber’s votes scan — 2026-08-05 audit; latent at 92 live mo-house-xml rows'],
  [path.join('src', 'cli', 'golden.js'), 'loadGoldenCandidates’s summaries scan — 2026-08-05 audit; latent, few approved summaries today'],
  [path.join('src', 'cli', 'summarize.js'), 'loadFederalBills’s bills/votes/bill_texts/summaries reads — TODO.md items 18 and 32, already tracked as URGENT-WHEN-SUMMARIES-RESUME since before this test existed; votes is already past the 1000-row cap'],
  [path.join('src', 'cli', 'verify.js'), 'loadCandidateSummaries + loadAlreadyVerifiedIds — 2026-08-05 audit; same shape as extract-terms.js, both one summarization wave away from the cap'],
  [path.join('src', 'cli', 'extract-terms.js'), 'loadAllSummaries + loadExtractedSummaryIds — 2026-08-05 audit; same shape as verify.js'],
  [path.join('src', 'review', 'server.js'), 'handleQueue’s summaries queue select — 2026-08-05 audit; the parallel glossary queue query was already fixed under a prior CRITICAL finding, this one was missed'],
]);

const UNBOUNDED_SELECT_RE = /\.from\(\s*['"]([a-zA-Z0-9_]+)['"]\s*\)\s*\.select\(/g;
// `.eq(` is deliberately included as a bounding signal, not just limit/range/single/maybeSingle/
// head-count: an exact-match filter on a specific parent id (vote_id, bill_id, a seat's district
// column) inherently bounds the result set to that one entity's rows, the same way this codebase's
// own comments justify it in multiple places (e.g. legiscan-identity.js's "the chamber+district
// filter alone already bounds each query's result set nowhere near the 1000-row page default").
// This is a real, evidence-based distinction, not a guess: verified against this codebase's actual
// ~19 known bare-select violations (2026-08-05 audit) — every one of them filters via `.not(...
// is...)`, `.in(...)`, `.like(...)`, or no filter at all, categorically broader operations that do
// NOT bound to a specific row/entity the way `.eq()` on an id-shaped column does — never a plain
// `.eq(`. Should a future `.eq()` on a genuinely low-cardinality, high-row-count column (e.g.
// `.eq('status', 'draft')` matching thousands of rows) ever slip through as a false negative, that
// is exactly what phase 1 / periodic re-audits exist to catch — this test is a cheap mechanical
// backstop, not a substitute for real review.
const BOUNDING_CALL_RE = /\.(limit|range|single|maybeSingle|eq)\s*\(|\{\s*count:\s*['"]exact['"]\s*,\s*head:\s*true\s*\}/;
const LOOKAHEAD_WINDOW = 400;

function findUnboundedSelects(sourceNoComments) {
  const hits = [];
  let match;
  UNBOUNDED_SELECT_RE.lastIndex = 0;
  while ((match = UNBOUNDED_SELECT_RE.exec(sourceNoComments)) !== null) {
    const windowEnd = Math.min(sourceNoComments.length, match.index + match[0].length + LOOKAHEAD_WINDOW);
    const window = sourceNoComments.slice(match.index, windowEnd);
    // Selects up to (but not into) the NEXT unrelated statement, so a bounding call two lines
    // later on the SAME chain still counts, but a bounding call that belongs to some later,
    // unrelated statement does not get wrongly credited to this one.
    const nextStatementEnd = window.indexOf(';\n');
    const relevantWindow = nextStatementEnd === -1 ? window : window.slice(0, nextStatementEnd + 2);
    if (!BOUNDING_CALL_RE.test(relevantWindow)) {
      const lineNumber = sourceNoComments.slice(0, match.index).split('\n').length;
      hits.push({ table: match[1], line: lineNumber });
    }
  }
  return hits;
}

test('server-side (src/, scripts/): every unbounded multi-row .select() routes through selectAll, except explicitly dated known debt', () => {
  const violations = [];
  for (const dir of SERVER_SCAN_DIRS) {
    for (const file of listJsFiles(path.join(REPO_ROOT, dir))) {
      if (SERVER_EXCLUDE_FILES.has(file)) continue;
      const relPath = path.relative(REPO_ROOT, file);
      const hits = findUnboundedSelects(stripJsComments(readFileSync(file, 'utf8')));
      if (hits.length === 0) continue;
      if (ALLOWLISTED_UNSAFE_FILES.has(relPath)) continue;
      for (const hit of hits) violations.push(`${relPath}:${hit.line} — table '${hit.table}'`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Found unbounded .from().select() call(s) not routed through selectAll and not in the dated allowlist:\n${violations.join('\n')}\n\n`
      + 'PostgREST silently caps any single response at 1,000 rows (src/lib/db.js’s own selectAll '
      + 'header) — this exact bug class has shipped live at least five times in this project’s '
      + 'history. Either route the read through selectAll(client, table, columns, {filter}), bound it '
      + 'with an explicit .limit()/.range()/.single()/.maybeSingle(), or — if this is genuinely new, '
      + 'deliberate debt — add it to ALLOWLISTED_UNSAFE_FILES above with a dated comment explaining why.',
  );
});

test('sanity: the detector actually flags the known unsafe shape (proves the regex isn’t vacuously passing)', () => {
  const hits = findUnboundedSelects(stripJsComments(
    "const { data } = await client.from('votes').select('id').not('bill_id', 'is', null);\n",
  ));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].table, 'votes');
});

test('sanity: the detector does not flag a properly-bounded select (single/maybeSingle/limit/range/head-count)', () => {
  const safe = [
    "await client.from('legislators').select('id').eq('id', x).single();",
    "await client.from('legislators').select('id').eq('id', x).maybeSingle();",
    "await client.from('votes').select('id').eq('bill_id', x).limit(1);",
    "await client.from('votes').select('id', { count: 'exact', head: true });",
    "await client.from('votes').select('id').order('id').range(0, 999);",
  ];
  for (const snippet of safe) {
    const hits = findUnboundedSelects(stripJsComments(`${snippet}\n`));
    assert.deepEqual(hits, [], `expected no violation for: ${snippet}`);
  }
});

test('sanity: an .eq() filter on a specific parent id is treated as bounded (real codebase pattern — legiscan-identity.js/legiscan-votes.js/summary-queue.js all rely on exactly this), but a categorically broader filter (.in/.not/.like) is NOT', () => {
  const boundedByEq = "await client.from('vote_casts').select('position').eq('vote_id', primaryVote.id);";
  assert.deepEqual(findUnboundedSelects(stripJsComments(`${boundedByEq}\n`)), []);

  const stillUnbounded = [
    "await client.from('votes').select('bill_id').not('bill_id', 'is', null);",
    "await client.from('summaries').select('id').in('status', TARGET_STATUSES);",
    "await client.from('votes').select('id,source_key').like('source_key', 'mo-house-xml-%');",
  ];
  for (const snippet of stillUnbounded) {
    const hits = findUnboundedSelects(stripJsComments(`${snippet}\n`));
    assert.equal(hits.length, 1, `expected a violation for: ${snippet}`);
  }
});

// ---- Site-side: every network read in site/js/ goes through rest.js's own cap-aware helpers ----

test('site-side (site/js/): no file that talks to Supabase directly bypasses rest.js’s helpers', () => {
  const siteJsDir = path.join(REPO_ROOT, 'site', 'js');
  const restJs = path.join(siteJsDir, 'rest.js');
  const violations = [];
  for (const file of listJsFiles(siteJsDir)) {
    if (file === restJs) continue;
    const source = stripJsComments(readFileSync(file, 'utf8'));
    // Scoped specifically to Supabase, not every network call in site/js — a same-origin fetch to
    // a Cloudflare Pages Function (e.g. directory-page.js's POST to /geocode, a reviewed
    // "CONTROLLER RULING" proxying the Census Geocoder — see its own inline comment) is a real,
    // deliberate, non-Supabase network call and must NOT be flagged here. The reliable signal for
    // "this call could reach Supabase directly, bypassing rest.js's 1000-row-cap-aware helpers" is
    // importing the Supabase credentials themselves (SUPABASE_URL/SUPABASE_ANON_KEY from
    // ../config.js) in a file that ALSO calls the raw fetch() global — rest.js is the only module
    // that should ever do both.
    const importsSupabaseConfig = /import\s*\{[^}]*\bSUPABASE_(?:URL|ANON_KEY)\b[^}]*\}\s*from\s*['"][^'"]*config\.js['"]/.test(source);
    if (!importsSupabaseConfig) continue;
    if (/(?<![.\w])fetch\s*\(/.test(source)) {
      const lineNumber = source.slice(0, source.search(/(?<![.\w])fetch\s*\(/)).split('\n').length;
      violations.push(`${path.relative(REPO_ROOT, file)}:${lineNumber}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Found a file importing Supabase credentials AND calling fetch() directly, outside rest.js: ${violations.join(', ')}\n\n`
      + 'Every Supabase read in site/js/ must go through rest.js’s restGet/pagedFetch/fetchAllRows/'
      + 'countOnly — those are the only call sites that correctly handle the 1,000-row PostgREST cap '
      + 'and the RestError/ConfigError contract. A same-origin fetch to something else entirely '
      + '(e.g. a Cloudflare Pages Function) is fine and should never import Supabase credentials in '
      + 'the first place.',
  );
});
