### Task 1: Migration 0016 — the public read surface (drafted here; Lance applies)

**Files:**
- Create: `supabase/migrations/0016_public_read_surface.sql`
- Create: `scripts/probe-public-surface.js`
- Test: none (SQL is Lance-applied; the probe is the verification)

**Interfaces:**
- Produces: views `public_vote_feed`, `public_freshness`, `public_verification_notes`, `public_reconciliation_flags`; column `terms.state`; anon read revoked on `bill_texts` and `ingestion_runs`. Every later task reads ONLY these views + the already-public base tables.
- NOTE (spec §7 amendment, decided at plan time): `public_person_links` is NOT built — `legislators.person_id` is already anon-readable and is the same mapping.

- [ ] **Step 1: Write the migration**

```sql
-- Draft (Lance applies — draft-then-apply). Public read surface for the site (spec §7).
-- Two lock-downs, one additive column, four views. The views over LOCKED tables are
-- DELIBERATELY security_definer-style (no security_invoker): the view IS the policy — it
-- exposes only the named columns, and anon gets SELECT on the view, not the table.
-- public_vote_feed sits over already-public tables and uses security_invoker=true.

-- 1) Lock-downs (spec: bill_texts raw text and ingestion_runs internals are not public).
drop policy anon_read on bill_texts;
drop policy anon_read on ingestion_runs;

-- 2) terms.state (additive; fills-null backfill in the next task). US House terms store bare
-- district numbers ('2') with no state — unmatchable from an address without this.
alter table terms add column state text;

-- 3) The vote feed: one paged query serves a profile's vote list, newest first, without
-- PostgREST embedded-ordering tricks. Bases are all anon-readable; invoker semantics apply.
create view public_vote_feed with (security_invoker = true) as
select
  vc.id            as cast_id,
  vc.legislator_id,
  vc.position,
  v.id             as vote_id,
  v.vote_date,
  v.chamber,
  v.question,
  v.result,
  v.source_url,
  v.jurisdiction_id,
  b.id             as bill_id,
  b.identifier     as bill_identifier,
  b.title          as bill_title,
  b.session_id
from vote_casts vc
join votes v on v.id = vc.vote_id
left join bills b on b.id = v.bill_id;
grant select on public_vote_feed to anon, authenticated;

-- 4) Freshness: latest run per source + the quarantined-day COUNT only (never the detail
-- payload). Owner-bypass over the now-locked ingestion_runs; the column list is the wall.
create view public_freshness as
select distinct on (source)
  source,
  status,
  finished_at,
  coalesce(jsonb_array_length(detail->'counts'->'quarantined_days'), 0) as quarantined_days
from ingestion_runs
order by source, started_at desc;
grant select on public_freshness to anon, authenticated;

-- 5) Verification notes: exactly what the bill page's receipt renders, nothing more.
create view public_verification_notes as
select summary_id, model, prompt_version, overall, created_at
from summary_verifications;
grant select on public_verification_notes to anon, authenticated;

-- 6) Reconciliation flags: the factual discrepancy record, minus provenance internals.
create view public_reconciliation_flags as
select vote_id, source_a, source_b, discrepancy, resolved, created_at
from vote_reconciliation_flags;
grant select on public_reconciliation_flags to anon, authenticated;
```

- [ ] **Step 2: Write the anon-key probe** — `scripts/probe-public-surface.js`, run with `node --env-file=.env scripts/probe-public-surface.js`. It must use `SUPABASE_ANON_KEY` (Lance adds it to `.env` in this task — the publishable key from the dashboard, same value that later goes in `site/config.js`). It asserts, printing PASS/FAIL per line and exiting 1 on any FAIL: `bill_texts` returns zero rows/permission error via anon; `ingestion_runs` likewise; each of the four views returns HTTP 200 via anon; `public_freshness` rows carry exactly {source, status, finished_at, quarantined_days}; `public_vote_feed?limit=1` carries exactly the columns named in Step 1.

```js
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
```

- [ ] **Step 3: Commit** — `git add supabase/migrations/0016_public_read_surface.sql scripts/probe-public-surface.js && git commit -m "feat: migration 0016 draft - public read surface (lock-downs, views, terms.state)"`
- [ ] **Step 4 (LANCE GATE):** Lance adds `SUPABASE_ANON_KEY` to `.env`, applies 0016 in Supabase, then the controller runs the probe. All PASS before any site task ships.

