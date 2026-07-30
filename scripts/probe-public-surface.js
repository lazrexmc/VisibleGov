// scripts/probe-public-surface.js — anon-key verification of migration 0016 (run after Lance applies).
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
const EXPECT_FEED = ['cast_id', 'legislator_id', 'position', 'vote_id', 'vote_date', 'chamber', 'question', 'result', 'source_url', 'jurisdiction_id', 'bill_id', 'bill_identifier', 'bill_title', 'session_id'];
const EXPECT_FRESH = ['source', 'status', 'finished_at', 'quarantined_days'];
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
const fresh = await rows('public_freshness?limit=1');
if (fresh.status === 200 && fresh.body?.[0]) {
  const got = Object.keys(fresh.body[0]).sort().join(',');
  check('public_freshness columns exact', got === [...EXPECT_FRESH].sort().join(','), got);
}
process.exit(failed ? 1 : 0);
