// scripts/probe-public-surface.js — anon-key verification of the public read surface
// (migration 0016, extended for migration 0019, extended again for migration 0020's completeness
// axis). Run after Lance applies a migration.
//
// FINAL REVIEW, findings 2 and 4: this probe used to check COLUMN SETS only — which is why it
// passed for weeks while public_verification_notes was handing anon 23 unpublished summaries'
// verification rows. A column list says what a view exposes; it says nothing about WHICH ROWS.
// checkRowScoping below checks rows, not just shapes, and stays EXACTLY as strict through the
// completeness-axis follow-up (2026-07-31) — see its own comment.
//
// Pure logic (checkRequiredColumnsPresent, checkRowScoping) is exported and unit-tested
// (tests/probe-public-surface.test.js) against both the pre-0020 and a simulated post-0020 column
// shape. The network-touching orchestration lives in main(), gated behind invokedDirectly — same
// convention as scripts/serve-site.js and every src/cli/*.js entry point — so importing this module
// for its exports never touches the network, never reads env vars, and never calls process.exit.

function check(name, ok, extra, state) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) state.failed = true;
}

async function rows(url, headers, path) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Exhaustive read in 1000-row chunks (PostgREST's cap) — the row-scoping gate below compares whole
// sets, so a silently-truncated read would be a silently-weakened check.
async function allRows(url, headers, path) {
  const out = [];
  for (let start = 0; ; start += 1000) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetch(`${url}/rest/v1/${path}`, { headers: { ...headers, 'Range-Unit': 'items', Range: `${start}-${start + 999}` } });
    if (!r.ok) return { status: r.status, body: null };
    // eslint-disable-next-line no-await-in-loop
    const body = await r.json().catch(() => null);
    if (!Array.isArray(body)) return { status: r.status, body: null };
    out.push(...body);
    if (body.length < 1000) return { status: r.status, body: out };
  }
}

const EXPECT_FEED = ['cast_id', 'legislator_id', 'position', 'vote_id', 'vote_date', 'chamber', 'question', 'result', 'source_url', 'jurisdiction_id', 'bill_id', 'bill_identifier', 'bill_title', 'session_id'];
// 0019 adds last_finished_status (and changes finished_at/quarantined_days to LATEST-FINISHED
// semantics). Before 0019 is applied this expectation fails loud — that is the point: the probe is
// how Lance confirms an apply actually landed.
const EXPECT_FRESH = ['source', 'status', 'finished_at', 'quarantined_days', 'last_finished_status'];
// REQUIRED_NOTES (completeness axis follow-up, 2026-07-31): these four columns have been on
// public_verification_notes since migration 0004/0016 and must always be present, regardless of
// migration state. Migration 0020 (draft-then-apply — may be applied hours after this code ships,
// in either order relative to it) adds a FIFTH column, `kind` — deliberately NOT required here.
// checked via checkRequiredColumnsPresent's superset tolerance rather than an exact-match
// assertion, so this probe passes unmodified whether Lance has applied 0020 yet or not, instead of
// false-flagging one of the two real, valid states on every run until someone remembers to update
// this script in lockstep with the migration.
const REQUIRED_NOTES = ['summary_id', 'model', 'overall', 'created_at'];

// checkRequiredColumnsPresent(gotColumns, requiredColumns) -> {ok, missing} — SUPERSET-tolerant:
// every required column must be present, but extra columns (e.g. 0020's `kind`) are fine and never
// fail the check. Pure — no I/O, never throws.
export function checkRequiredColumnsPresent(gotColumns, requiredColumns) {
  const got = new Set(Array.isArray(gotColumns) ? gotColumns : []);
  const missing = requiredColumns.filter((c) => !got.has(c));
  return { ok: missing.length === 0, missing };
}

// checkRowScoping(noteRows, publishedIds) -> {ok, leaked, distinctSummaries} — the FINAL REVIEW
// finding 2 gate, UNCHANGED and load-bearing: every verification row anon can read must belong to a
// summary anon can also read (i.e. a published one). This is the check whose absence let a real
// leak stand for weeks (see this file's own header comment). Kept EXACTLY as strict through the
// completeness-axis follow-up (2026-07-31): a completeness-kind row is just as much a leak as a
// support-kind row if it belongs to an unpublished summary — this makes no kind-based exception of
// any sort, and never even looks at `overall`/`kind`, only `summary_id`. Pure — no I/O.
export function checkRowScoping(noteRows, publishedIds) {
  const rowsArr = Array.isArray(noteRows) ? noteRows : [];
  const publishedIdSet = new Set(publishedIds);
  const leaked = rowsArr.filter((n) => !publishedIdSet.has(n.summary_id));
  const distinctSummaries = new Set(rowsArr.map((n) => n.summary_id)).size;
  return { ok: leaked.length === 0, leaked, distinctSummaries };
}

// checkCitationsShape(noteRows) -> {ok, violations} — migration 0021 (draft-then-apply, may not be
// applied yet) adds a computed `citations` column to public_verification_notes. Once present, its
// content must satisfy three rules, independent of whether 0021 has landed yet: (1) a
// completeness-kind row's citations is always null (its verdicts column holds an unrelated
// {key_provisions, coverage} shape, nothing to extract); (2) a support-kind row whose overall isn't
// 'clean' has citations null too — this is the exact gate the Fable 5 design review found missing;
// a flagged row's evidence_quote can CONTRADICT its bullet, and this check catches it leaking
// through as if it were a receipt; (3) a clean support row's citations, when non-null, is an array
// of objects with EXACTLY bullet_index/section/evidence_quote keys — never `reason` (the verifier's
// own commentary) or `supported` (redundant once gated, and the leak vector if handled carelessly).
// Tolerates `citations` being entirely absent from a row (pre-0021 shape) — this check is additive,
// never a replacement for checkRequiredColumnsPresent, and never fails a probe run against a
// database that hasn't had 0021 applied yet. Pure — no I/O, never throws.
const CITATION_ENTRY_KEYS = ['bullet_index', 'evidence_quote', 'section'];

export function checkCitationsShape(noteRows) {
  const rowsArr = Array.isArray(noteRows) ? noteRows : [];
  const violations = [];
  for (const row of rowsArr) {
    if (!row || !('citations' in row)) continue; // pre-0021 row shape — nothing to check yet
    const { kind, overall, citations } = row;
    if (kind === 'completeness') {
      if (citations !== null) violations.push({ summary_id: row.summary_id, reason: 'completeness row has non-null citations' });
      continue;
    }
    if (kind === 'support' && overall !== 'clean') {
      if (citations !== null) violations.push({ summary_id: row.summary_id, reason: `support row with overall=${overall} has non-null citations` });
      continue;
    }
    if (citations === null || citations === undefined) continue; // no citations extracted (e.g. empty verdicts) — fine
    if (!Array.isArray(citations)) {
      violations.push({ summary_id: row.summary_id, reason: 'citations is not an array' });
      continue;
    }
    for (const entry of citations) {
      const keys = Object.keys(entry || {}).sort();
      if (keys.join(',') !== CITATION_ENTRY_KEYS.join(',')) {
        violations.push({ summary_id: row.summary_id, reason: `citation entry has unexpected keys: ${keys.join(',')}` });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

export async function main() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    console.error('SUPABASE_URL/SUPABASE_ANON_KEY not set');
    process.exitCode = 1;
    return;
  }
  const H = { apikey: anon, Authorization: `Bearer ${anon}` };
  const state = { failed: false };

  const locked = await rows(url, H, 'bill_texts?select=id&limit=1');
  check('bill_texts locked to anon', locked.status !== 200 || (Array.isArray(locked.body) && locked.body.length === 0), `status ${locked.status}`, state);
  const runsLocked = await rows(url, H, 'ingestion_runs?select=id&limit=1');
  check('ingestion_runs locked to anon', runsLocked.status !== 200 || (Array.isArray(runsLocked.body) && runsLocked.body.length === 0), `status ${runsLocked.status}`, state);
  for (const v of ['public_vote_feed', 'public_freshness', 'public_verification_notes', 'public_reconciliation_flags']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await rows(url, H, `${v}?limit=1`);
    check(`${v} readable`, r.status === 200, `status ${r.status}`, state);
  }
  const feed = await rows(url, H, 'public_vote_feed?limit=1');
  if (feed.status === 200 && feed.body?.[0]) {
    const got = Object.keys(feed.body[0]).sort().join(',');
    check('public_vote_feed columns exact', got === [...EXPECT_FEED].sort().join(','), got, state);
  }
  const fresh = await allRows(url, H, 'public_freshness');
  if (fresh.status === 200 && fresh.body?.[0]) {
    const got = Object.keys(fresh.body[0]).sort().join(',');
    check('public_freshness columns exact (0019 shape)', got === [...EXPECT_FRESH].sort().join(','), got, state);

    // FINDING 4 gates. The exact claim ("a running source still shows its last finished date") is
    // only decidable against ingestion_runs, which anon cannot read — correctly. So the two checks
    // below are the strongest MECHANICAL invariants of the new shape that this probe can actually
    // establish, and the running rows are REPORTED for a human to confirm rather than waved through
    // by a check that would pass either way (a vacuously-true assertion is how finding 2 survived).
    const finishedRows = fresh.body.filter((r) => r.finished_at != null);
    check(
      'public_freshness: finished_at and last_finished_status are present together, always',
      fresh.body.every((r) => (r.finished_at != null) === (r.last_finished_status != null)),
      `${finishedRows.length} of ${fresh.body.length} row(s) report a finished run`,
      state,
    );
    check(
      'public_freshness: a source whose NEWEST run already finished reports that finish time',
      fresh.body.filter((r) => r.status !== 'running').every((r) => r.finished_at != null),
      'a failure here means either the view is wrong or an ingestion run recorded a terminal status with no finished_at',
      state,
    );
    check(
      'public_freshness: quarantined_days is never null (0 means zero, not unknown)',
      fresh.body.every((r) => r.quarantined_days != null),
      '',
      state,
    );
    const running = fresh.body.filter((r) => r.status === 'running');
    for (const r of running) {
      console.log(
        `INFO  public_freshness: ${r.source} has a run IN FLIGHT — last finished `
          + `${r.finished_at ?? 'NEVER (verify by hand that this source has genuinely never completed a run)'}`,
      );
    }
  }

  // FINDING 2 gate — ROW SCOPING, not column shape. Every verification row anon can read must
  // belong to a summary anon can also read (i.e. a published one). This is the check whose absence
  // let the leak stand.
  const notes = await allRows(url, H, 'public_verification_notes?select=summary_id,model,overall,created_at');
  const published = await allRows(url, H, 'summaries?select=id&status=eq.published');
  if (notes.status === 200 && published.status === 200 && notes.body && published.body) {
    // Column check reads a row with NO select= — asking for named columns back would only ever
    // prove those exist, never that prompt_version is gone.
    const noteShape = await rows(url, H, 'public_verification_notes?limit=1');
    if (noteShape.status === 200 && noteShape.body?.[0]) {
      const got = Object.keys(noteShape.body[0]);
      const { ok, missing } = checkRequiredColumnsPresent(got, REQUIRED_NOTES);
      check(
        'public_verification_notes has the required columns (superset-tolerant — migration 0020 may or may not have added `kind` yet)',
        ok,
        missing.length ? `missing: ${missing.join(',')}` : got.sort().join(','),
        state,
      );
      // 0019's own fix, checked independently of the superset check above so a regression here
      // fails with its own unambiguous message rather than being folded into a generic
      // "missing required column" report: prompt_version is an internal pipeline identifier, never
      // rendered by the bill page, and must stay off the public surface regardless of kind/0020.
      check('public_verification_notes stays free of prompt_version', !got.includes('prompt_version'), got.sort().join(','), state);
    }
    const { ok, leaked, distinctSummaries } = checkRowScoping(notes.body, published.body.map((r) => r.id));
    check(
      'public_verification_notes is scoped to anon-visible PUBLISHED summaries',
      ok,
      `${notes.body.length} note row(s) over ${distinctSummaries} distinct summaries; `
        + `${published.body.length} published summaries visible to anon; ${leaked.length} unpublished leak(s)`,
      state,
    );
  } else {
    check('public_verification_notes row-scoping readable', false, `notes ${notes.status} / summaries ${published.status}`, state);
  }

  // Migration 0021 (draft-then-apply) may or may not have landed yet — request the expanded shape
  // and gracefully skip this check (not fail the probe) if the column doesn't exist.
  const notesWithCitations = await allRows(url, H, 'public_verification_notes?select=summary_id,kind,overall,citations');
  if (notesWithCitations.status === 200 && notesWithCitations.body) {
    const { ok: citationsOk, violations } = checkCitationsShape(notesWithCitations.body);
    check(
      'public_verification_notes.citations is correctly gated and shaped (migration 0021)',
      citationsOk,
      violations.length ? `${violations.length} violation(s): ${violations.map((v) => `${v.summary_id} — ${v.reason}`).join('; ')}` : `${notesWithCitations.body.length} row(s) checked`,
      state,
    );
  } else {
    console.log('INFO  public_verification_notes.citations check skipped — migration 0021 not applied yet (or the request failed for another reason)');
  }

  process.exitCode = state.failed ? 1 : 0;
}

// Only run against the network when invoked directly (`node scripts/probe-public-surface.js`),
// never when imported by tests — same Windows-safe invokedDirectly pattern scripts/serve-site.js
// and every src/cli/*.js entry point already use.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
