// scripts/probe-public-surface.js — anon-key verification of the public read surface
// (migration 0016, extended for migration 0019). Run after Lance applies a migration.
//
// FINAL REVIEW, findings 2 and 4: this probe used to check COLUMN SETS only — which is why it
// passed for weeks while public_verification_notes was handing anon 23 unpublished summaries'
// verification rows. A column list says what a view exposes; it says nothing about WHICH ROWS.
// The two gates below check rows, not just shapes.
const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;
if (!url || !anon) { console.error('SUPABASE_URL/SUPABASE_ANON_KEY not set'); process.exit(1); }
const H = { apikey: anon, Authorization: `Bearer ${anon}` };
let failed = false;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed = true;
}
async function rows(path) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: H });
  return { status: r.status, body: await r.json().catch(() => null) };
}
// Exhaustive read in 1000-row chunks (PostgREST's cap) — the row-scoping gate below compares whole
// sets, so a silently-truncated read would be a silently-weakened check.
async function allRows(path) {
  const out = [];
  for (let start = 0; ; start += 1000) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetch(`${url}/rest/v1/${path}`, { headers: { ...H, 'Range-Unit': 'items', Range: `${start}-${start + 999}` } });
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
const EXPECT_NOTES = ['summary_id', 'model', 'overall', 'created_at'];
const locked = await rows('bill_texts?select=id&limit=1');
check('bill_texts locked to anon', locked.status !== 200 || (Array.isArray(locked.body) && locked.body.length === 0), `status ${locked.status}`);
const runsLocked = await rows('ingestion_runs?select=id&limit=1');
check('ingestion_runs locked to anon', runsLocked.status !== 200 || (Array.isArray(runsLocked.body) && runsLocked.body.length === 0), `status ${runsLocked.status}`);
for (const v of ['public_vote_feed', 'public_freshness', 'public_verification_notes', 'public_reconciliation_flags']) {
  const r = await rows(`${v}?limit=1`);
  check(`${v} readable`, r.status === 200, `status ${r.status}`);
}
const feed = await rows('public_vote_feed?limit=1');
if (feed.status === 200 && feed.body?.[0]) {
  const got = Object.keys(feed.body[0]).sort().join(',');
  check('public_vote_feed columns exact', got === [...EXPECT_FEED].sort().join(','), got);
}
const fresh = await allRows('public_freshness');
if (fresh.status === 200 && fresh.body?.[0]) {
  const got = Object.keys(fresh.body[0]).sort().join(',');
  check('public_freshness columns exact (0019 shape)', got === [...EXPECT_FRESH].sort().join(','), got);

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
  );
  check(
    'public_freshness: a source whose NEWEST run already finished reports that finish time',
    fresh.body.filter((r) => r.status !== 'running').every((r) => r.finished_at != null),
    'a failure here means either the view is wrong or an ingestion run recorded a terminal status with no finished_at',
  );
  check(
    'public_freshness: quarantined_days is never null (0 means zero, not unknown)',
    fresh.body.every((r) => r.quarantined_days != null),
  );
  const running = fresh.body.filter((r) => r.status === 'running');
  for (const r of running) {
    console.log(
      `INFO  public_freshness: ${r.source} has a run IN FLIGHT — last finished `
        + `${r.finished_at ?? 'NEVER (verify by hand that this source has genuinely never completed a run)'}`,
    );
  }
}

// FINDING 2 gate — ROW SCOPING, not column shape. Every verification row anon can read must belong
// to a summary anon can also read (i.e. a published one). This is the check whose absence let the
// leak stand.
const notes = await allRows('public_verification_notes?select=summary_id,model,overall,created_at');
const published = await allRows('summaries?select=id&status=eq.published');
if (notes.status === 200 && published.status === 200 && notes.body && published.body) {
  // Column check reads a row with NO select= — asking for four named columns back would only ever
  // prove those four exist, never that prompt_version is gone.
  const noteShape = await rows('public_verification_notes?limit=1');
  if (noteShape.status === 200 && noteShape.body?.[0]) {
    const got = Object.keys(noteShape.body[0]).sort().join(',');
    check('public_verification_notes columns exact (prompt_version gone)', got === [...EXPECT_NOTES].sort().join(','), got);
  }
  const publishedIds = new Set(published.body.map((r) => r.id));
  const leaked = notes.body.filter((n) => !publishedIds.has(n.summary_id));
  const distinctNoteSummaries = new Set(notes.body.map((n) => n.summary_id));
  check(
    'public_verification_notes is scoped to anon-visible PUBLISHED summaries',
    leaked.length === 0,
    `${notes.body.length} note row(s) over ${distinctNoteSummaries.size} distinct summaries; `
      + `${publishedIds.size} published summaries visible to anon; ${leaked.length} unpublished leak(s)`,
  );
} else {
  check('public_verification_notes row-scoping readable', false, `notes ${notes.status} / summaries ${published.status}`);
}
process.exit(failed ? 1 : 0);
