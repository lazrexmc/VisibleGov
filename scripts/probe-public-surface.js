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

// `vote_date_provenance` appended by migration 0035 (2026-08-28), the derived-date receipt for
// the 185 votes LegiScan prints with the 0000-00-00 sentinel. This list was NOT updated when
// 0035 landed, so this probe went red the moment it was next run — which is exactly the drift a
// pinned column list exists to catch, and it went unnoticed only because nothing runs this file
// automatically. Whoever changes a public view updates this list in the same commit.
const EXPECT_FEED = ['cast_id', 'legislator_id', 'position', 'vote_id', 'vote_date', 'chamber', 'question', 'result', 'source_url', 'jurisdiction_id', 'bill_id', 'bill_identifier', 'bill_title', 'session_id', 'vote_date_provenance'];
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
// EXPECT_VOTES — vote-duplicate dedup (migration 0022, draft-then-apply). Same columns
// bill-page.js's own VOTES_SELECT requests, now via public_votes instead of the raw votes table.
const EXPECT_VOTES = ['id', 'bill_id', 'jurisdiction_id', 'chamber', 'vote_date', 'question', 'result', 'source_url', 'source_key'];

// Senior engineering audit (2026-08-03, finding 6): 0024/0025 shipped with ZERO probe coverage —
// this file was last committed BEFORE either migration existed. 0025's real production regression
// (bill-page.js's summaries query 401ing the instant 0025 landed) was caught only because a human
// happened to load the site afterward, not by anything mechanical. These constants and the checks
// below close that gap: verbatim from migration 0025's own GRANT lists (never re-derived/guessed).
const SUMMARIES_GRANTED_COLUMNS = ['id', 'bill_id', 'status', 'body_md', 'model', 'published_at', 'created_at'];
const GLOSSARY_TERMS_GRANTED_COLUMNS = ['id', 'term', 'kind', 'citation', 'gloss_md', 'supported_by_quote', 'source_url', 'status'];
// One deliberately-NOT-granted internal column per table (0025's own header comment names all of
// them: summaries also withholds prompt_version/bill_text_hash/run_id; glossary_terms also
// withholds prompt_version/source_hash/needs_mapping) — proves the column-level grant is actually
// enforced, not just that the granted columns happen to work.
const SUMMARIES_DENIED_COLUMN = 'run_id';
const GLOSSARY_TERMS_DENIED_COLUMN = 'run_id';

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

// checkNoSupersededVotes(voteRows, supersededIds) -> {ok, leaked} — vote-duplicate dedup (migration
// 0022, draft-then-apply). public_votes/public_vote_feed/the vote-aggregate matviews all exclude
// superseded_vote_id rows via a join; this proves that exclusion actually held for a live sample,
// the same "prove the row-level effect, don't just trust the view definition" discipline
// checkRowScoping already applies to public_verification_notes. Pure — no I/O, never throws.
export function checkNoSupersededVotes(voteRows, supersededIds) {
  const rowsArr = Array.isArray(voteRows) ? voteRows : [];
  const ids = supersededIds instanceof Set ? supersededIds : new Set();
  const leaked = rowsArr.filter((r) => ids.has(r.id)).map((r) => r.id);
  return { ok: leaked.length === 0, leaked };
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

  // LOCKED means the PRIVILEGE is gone — not that the table happened to answer empty.
  //
  // These three checks used to accept `status !== 200 || body.length === 0`, so a table that
  // returned `200 []` PASSED. That is precisely the policy-only signature migrations 0036/0037
  // were written to eliminate: the GRANT still present, an absent RLS policy alone holding the
  // door, and the probe reporting green the whole time. This file therefore certified as "locked"
  // exactly the state the repo's other probe refuses to accept — scripts/verify-migrations.mjs's
  // anonRevoked() says it outright: "`200 []` here is ABSENT, not policy-only ... reporting it as
  // the softer policy-only would let an unapplied migration exit 0."
  //
  // Two probes in one repo disagreeing about what "locked" means is worse than either standard
  // alone, because the weaker one is the one that runs after an operator applies a migration.
  // Aligned here on the strict definition: a 200 of ANY shape is a FAIL.
  for (const [relation, label] of [
    ['bill_texts', 'bill_texts locked to anon (migration 0037)'],
    ['ingestion_runs', 'ingestion_runs locked to anon (migration 0036)'],
    // 0024 dropped legiscan_datasets' RLS policy in 2026-08-03 but left 0010's grant in place —
    // which is how it sat at `200 []` until 0036 revoked it. The very defect this loop now catches.
    ['legiscan_datasets', 'legiscan_datasets locked to anon (migrations 0024 + 0036)'],
    ['vote_reconciliation_flags', 'vote_reconciliation_flags locked to anon (migration 0036)'],
  ]) {
    // eslint-disable-next-line no-await-in-loop -- sequential keeps the PASS/FAIL log in a stable
    // order an operator can diff between runs; four requests need no concurrency.
    // select=* deliberately, NEVER a named column. `?select=id` made this check useless for
    // legiscan_datasets, which has no `id` column: PostgREST resolved the column name first and
    // answered `400 42703 column does not exist`, so the request never reached a privilege check
    // at all. The old assertion counted that as "locked" (it was non-200) and the strict one
    // counted it as a leak — both wrong, because the probe was never testing permission.
    // `select=*` cannot miss: it is the same shape verify-migrations.mjs's anonRevoked() uses.
    const res = await rows(url, H, `${relation}?select=*&limit=1`);
    check(
      label,
      // EXACTLY the set verify-migrations.mjs anonRevoked() accepts — 401 / 403 / a 42501 body.
      // 404 is deliberately NOT here, though an earlier version of this line allowed it. The two
      // probes disagreeing on 404 was the same class of defect as the `200 []` split they were just
      // aligned on: a relation hidden from PostgREST's schema cache would pass this file and fail
      // that one, and the operator would have no way to know which was telling the truth. A 404
      // also does not mean "the grant was revoked" — it means the relation is not visible at all,
      // which for a lock check is an unexplained state that deserves a red line, not a pass.
      res.status === 401 || res.status === 403 || /42501/.test(JSON.stringify(res.body ?? '')),
      res.status === 200
        ? `status 200 — the GRANT is still live; an empty body is NOT "locked"`
        : `status ${res.status}`,
      state,
    );
  }
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

  // Migration 0022 (draft-then-apply) may or may not have landed yet — same graceful-skip pattern
  // as the citations check above. This can only prove public_votes is reachable and correctly
  // shaped from the anon key — NOT that the exclusion actually holds (vote_duplicates itself is
  // deliberately not anon-readable, so there is no way to learn the superseded-id set from here;
  // verifying the join's real effect is Lance's own live spot-check, per the implementation plan's
  // handoff notes).
  const publicVotesShape = await rows(url, H, 'public_votes?limit=1');
  if (publicVotesShape.status === 200 && publicVotesShape.body?.[0]) {
    const got = Object.keys(publicVotesShape.body[0]);
    const { ok, missing } = checkRequiredColumnsPresent(got, EXPECT_VOTES);
    check(
      'public_votes has the required columns (migration 0022)',
      ok,
      missing.length ? `missing: ${missing.join(',')}` : got.sort().join(','),
      state,
    );
  } else {
    console.log('INFO  public_votes check skipped — migration 0022 not applied yet (or the request failed for another reason)');
  }

  // Migration 0025 column-scoping (senior engineering audit, 2026-08-03, finding 6): shipped with
  // zero probe coverage — its real production regression (bill-page.js's summaries query 401ing
  // the instant 0025 landed) was caught only by a human loading the site afterward. Two halves:
  // (1) column-denial — an internal column withheld by the GRANT must actually be refused, not
  // just absent from the site's own queries; (2) real query replay — the site's own exact query
  // strings (not a re-derived approximation) must still succeed, which is the specific class of
  // check that would have caught the bill-page.js regression before a human had to.
  const summariesDenied = await rows(url, H, `summaries?select=id,${SUMMARIES_DENIED_COLUMN}&limit=1`);
  check(
    `summaries denies the ungranted column "${SUMMARIES_DENIED_COLUMN}" (migration 0025)`,
    summariesDenied.status !== 200,
    `status ${summariesDenied.status}`,
    state,
  );
  const glossaryDenied = await rows(url, H, `glossary_terms?select=id,${GLOSSARY_TERMS_DENIED_COLUMN}&limit=1`);
  check(
    `glossary_terms denies the ungranted column "${GLOSSARY_TERMS_DENIED_COLUMN}" (migration 0025)`,
    glossaryDenied.status !== 200,
    `status ${glossaryDenied.status}`,
    state,
  );
  const summariesGrantedProbe = await rows(url, H, `summaries?select=${SUMMARIES_GRANTED_COLUMNS.join(',')}&limit=1`);
  check(
    'summaries: every column migration 0025 actually grants is readable together in one request',
    summariesGrantedProbe.status === 200,
    `status ${summariesGrantedProbe.status}`,
    state,
  );
  const glossaryGrantedProbe = await rows(url, H, `glossary_terms?select=${GLOSSARY_TERMS_GRANTED_COLUMNS.join(',')}&limit=1`);
  check(
    'glossary_terms: every column migration 0025 actually grants is readable together in one request',
    glossaryGrantedProbe.status === 200,
    `status ${glossaryGrantedProbe.status}`,
    state,
  );

  // Real query replay — the LITERAL query shapes site/js/*.js issues today (bill-page.js,
  // person-page.js, trust-page.js), not a re-derived approximation. Sourced against a real
  // published bill_id / glossary_terms id found via an already-granted column, so this needs no
  // hardcoded fixture id and stays correct as the underlying data changes.
  const sampleBill = await rows(url, H, 'summaries?select=bill_id&status=eq.published&limit=1');
  const sampleBillId = sampleBill.status === 200 ? sampleBill.body?.[0]?.bill_id : null;
  if (sampleBillId) {
    const billPageSummary = await rows(url, H, `summaries?bill_id=eq.${sampleBillId}&status=eq.published&select=id,bill_id,status,body_md,model,published_at,created_at&order=published_at.desc.nullslast,created_at.desc`);
    check('bill-page.js\'s real summaries query string succeeds (migration 0025)', billPageSummary.status === 200, `status ${billPageSummary.status}`, state);
    const personPageSummary = await rows(url, H, `summaries?bill_id=in.(${sampleBillId})&status=eq.published&select=bill_id,body_md,published_at&order=published_at.desc.nullslast,created_at.desc`);
    check('person-page.js\'s real summaries query string succeeds (migration 0025)', personPageSummary.status === 200, `status ${personPageSummary.status}`, state);
  } else {
    console.log('INFO  bill-page.js/person-page.js real summaries query replay skipped — no published summary found to test against');
  }
  const sampleTerm = await rows(url, H, 'glossary_terms?select=id&status=eq.published&limit=1');
  const sampleTermId = sampleTerm.status === 200 ? sampleTerm.body?.[0]?.id : null;
  if (sampleTermId) {
    const billPageGlossary = await rows(url, H, `glossary_terms?id=in.(${sampleTermId})&status=eq.published&select=id,term,kind,citation,gloss_md,supported_by_quote,source_url&order=citation.nullsfirst,id`);
    check('bill-page.js\'s real glossary_terms query string succeeds (migration 0025)', billPageGlossary.status === 200, `status ${billPageGlossary.status}`, state);
  } else {
    console.log('INFO  bill-page.js real glossary_terms query replay skipped — no published glossary term found to test against');
  }
  const trustPageSummariesCount = await rows(url, H, 'summaries?select=id&status=eq.published&limit=3');
  check('trust-page.js\'s real summaries count query string succeeds (migration 0025)', trustPageSummariesCount.status === 200, `status ${trustPageSummariesCount.status}`, state);
  const trustPageGlossaryCount = await rows(url, H, 'glossary_terms?select=id&status=eq.published&limit=3');
  check('trust-page.js\'s real glossary_terms count query string succeeds (migration 0025)', trustPageGlossaryCount.status === 200, `status ${trustPageGlossaryCount.status}`, state);

  process.exitCode = state.failed ? 1 : 0;
}

// Only run against the network when invoked directly (`node scripts/probe-public-surface.js`),
// never when imported by tests — same Windows-safe invokedDirectly pattern scripts/serve-site.js
// and every src/cli/*.js entry point already use.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
