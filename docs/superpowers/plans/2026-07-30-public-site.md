# Public Site Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The VisibleGov public site per the approved spec `docs/superpowers/specs/2026-07-30-public-site-design.md` — profile-first, live anon-fetch on a static shell, deployed early to Cloudflare Pages.

**Architecture:** a `site/` directory of plain HTML/CSS/JS (no framework, no build step) served by Cloudflare Pages; the browser reads Supabase over anon REST through narrow public views; migration 0016 reshapes the public read surface (locks down two over-exposures, adds five views, adds `terms.state`); one Pages Function (geocode proxy) is the only server code.

**Tech Stack:** browser-native ES modules; Supabase PostgREST (anon key); node:test + jsdom (existing dev dep) for tests; Cloudflare Pages (free tier). NO new dependencies.

## Global Constraints

- Mechanically neutral: same treatment regardless of party. No scorecards, ratings, or grading — permanently out. Nothing renders that is not in the DB with provenance; the client never invents display facts.
- ALL database text enters the DOM via `textContent` (never innerHTML for DB-sourced strings).
- Skip≠empty in the UI: every fetch renders one of three distinct states — loading, failed ("couldn't load — retry" with a working retry), or honestly-empty ("no recorded X in our data"). A failed fetch NEVER renders as an empty section.
- The 1000-row PostgREST cap: every multi-row read goes through `site/js/rest.js`'s paged/exhaustive helpers. No bare `.select()` anywhere in site code.
- Additive writes only in any CLI work (fills-null `additivePatch`, `insertIfAbsent`); `selectAll` for CLI multi-row reads; typed errors; honest counts; provenance run_id.
- Draft-then-apply: migration 0016 is written and committed; Lance applies it; site features that need it are gated behind honest "unavailable" states until then, and the Task-1 probe verifies with the ANON key, not the service key.
- Anon key in `site/config.js` is public by design; RLS + the 0016 views are the entire wall. The SERVICE key must never appear anywhere under `site/`.
- The geocode Pages Function must not log, store, or forward the address anywhere except the Census request itself — a no-logging pass-through. This is a review-blocking requirement.
- Tests: bare `node --test` from repo root (NEVER a directory argument). Baseline 1220 passing stays green; every task ends green.
- Commits end with: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
- Branch: `public-site` off main.

**Verbatim body_md facts (from `src/lib/summarizer.js` renderMarkdown — the parser contract):** bullets render as `- <point> (<section>)`; the stated-purpose line renders as `**Stated purpose (from the bill):** <text>`; the point/section split is the LAST ` (` before line end.

**Verbatim data-shape facts (verified live 2026-07-30):**
- `terms`: id, legislator_id, jurisdiction_id, chamber, district, party, start_date, end_date, run_id. Federal senators: `district='MO'` (state code). Federal house: `district='2'` — NO state (Wagner MO-2 and a hypothetical NV-2 are indistinguishable) → Task 1 adds `terms.state`, Task 2 backfills it.
- `legislators` has `image_url` (OpenStates-era), `person_id`, `full_name`, `party`, `bioguide_id`, `nickname`, `surname`.
- `summaries`: body_md, model, prompt_version, status, published_at, bill_id, bill_text_hash. `summary_verifications`: summary_id, verdicts, overall, model, prompt_version, created_at.
- `glossary_terms`: term, kind, gloss_md, supported_by_quote, source_url, status, needs_mapping. `summary_terms`: (summary_id, term_id).
- `vote_reconciliation_flags`: vote_id, source_a, source_b, discrepancy, resolved, created_at.
- `votes`: bill_id, jurisdiction_id, chamber, vote_date, question, result, source_url, source_key. `vote_casts`: vote_id, legislator_id, position (vocabulary seen live: yea, nay, not_voting; absent exists in the LegiScan map).
- `ingestion_runs`: source, status, detail (JSON with counts, incl. `quarantined_days` array on mo-senate-web), started_at, finished_at.
- RLS today (0001): jurisdictions, sessions, legislators, terms, bills, bill_actions, **bill_texts (over-exposed)**, votes, vote_casts, districts anon-read; summaries published-only; **ingestion_runs anon-read in full (over-exposed)**; glossary_terms published-only; summary_terms anon-read; persons anon-read; bill_sponsors anon-read; person_links / identity_flags / summary_verifications / vote_reconciliation_flags internal (no anon policy).
- The `districts` table is EMPTY (slice-1 vestige) — never read it.

---

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

### Task 2: terms.state backfill (federal, additive, $0)

**Files:**
- Create: `src/cli/backfill-term-states.js`
- Test: `tests/backfill-term-states.test.js`
- Read (do not modify): `src/adapters/us-congress.js` (member parsing + polite limiter), `src/lib/db.js` (selectAll)

**Interfaces:**
- Consumes: the existing member-metadata parsing in `src/adapters/us-congress.js` (the Task-3-of-profile-completeness code that yielded "429 parties + 437 terms") — reuse its member-list fetch + parse, which already surfaces each member's `state`; do NOT write a parallel parser. Inspect its exports first and reuse the exact function the enrich pass uses.
- Produces: `terms.state` filled (fills-null only) for `jurisdiction_id='us-congress'` rows: house terms get the member's two-letter state code via bioguide exact match; senate terms ALSO get `state` = their existing `district` value (mechanical copy of the state code already stored there). MO terms: `state='MO'` (constant fill for `jurisdiction_id='mo-legislature'`, no fetch).
- CLI: `node --env-file=.env src/cli/backfill-term-states.js [--dry-run]`. Honest counts: `{termsSeen, filled, alreadySet, memberNotFound, gatedMissingColumn}`. Gated on 0016 via the existing `isMissingColumnError`-style detection (fail to honest `gatedMissingColumn` count, exactly like the 0014 gating pattern in `backfill-mo-bill-meta.js`).

- [ ] **Step 1: TDD** — write failing tests off the existing member fixtures (`tests/fixtures/us-congress/` already carries member payloads): state extracted per bioguide; senate term state copied from district; MO constant fill; fills-null (a term with state already set → alreadySet, never overwritten); dry-run writes nothing. Run: `node --test` — new tests FAIL, baseline stays green.
- [ ] **Step 2: Implement** minimal code to green. All reads via `selectAll`; updates only `state` where `state is null` (`.is('state', null)` guard on the update, same TOCTOU discipline as additivePatch call sites).
- [ ] **Step 3: Full suite green, commit** — `git commit -m "feat: terms.state backfill (federal via member metadata, MO constant)"`
- [ ] **Step 4 (controller, after 0016 applied):** dry-run → review counts → live run → verify: Wagner's house term shows `state='MO'`; Pelosi's shows `state='CA'`; a MO senate term shows `state='MO'`.

### Task 3: site scaffold — rest.js, render.js, receipts.js, dev server

**Files:**
- Create: `site/config.js`, `site/js/rest.js`, `site/js/render.js`, `site/js/receipts.js`, `site/_redirects`, `site/css/site.css`, `site/index.html` (placeholder shell for now; Task 8 fills it)
- Create: `scripts/serve-site.js` (zero-dep local static server with rewrite mimicry)
- Test: `tests/site-modules.test.js`

**Interfaces (later tasks import these exact names):**
- `rest.js`: `restGet(path)` → `{status, rows, total}` (total from content-range when `count=exact` requested); `pagedFetch(pathWithFilters, {page, pageSize=50, order})` → `{rows, total, page, pageSize}`; `fetchAllRows(pathWithFilters)` → rows[] (1000-chunk exhaustive loop — the browser selectAll); `countOnly(pathWithFilters)` → number. All take REST paths relative to `/rest/v1/`.
- `render.js`: `el(tag, attrs, ...children)` (strings → text nodes; attrs `{class, href, id, dataset}` allowlist); `clearChildren(node)`; `sectionState(container, {state, message, onRetry})` where state ∈ 'loading' | 'failed' | 'empty' | 'ready' — 'failed' renders a retry button wired to onRetry; 'empty' renders the message; `mountFooter(node)` (Task 10 fills the footer content; scaffold renders source-attribution placeholder text now).
- `receipts.js`: `voteReceiptUrl(feedRow)` → `feedRow.source_url ?? null`; `photoUrl(legislatorLike)` → `image_url` if set, else bioguide derivation `https://unitedstates.github.io/images/congress/450x550/${bioguide_id}.jpg`, else null; `officialBillUrl(bill)` → `bill.canonical_url ?? null`.
- `config.js`: `export const SUPABASE_URL = '<Lance pastes>'; export const SUPABASE_ANON_KEY = '<Lance pastes — the publishable key, public by design>';`

- [ ] **Step 1: TDD the pure logic** in `tests/site-modules.test.js` (jsdom for DOM helpers): range-header math for `pagedFetch` (page 3, size 50 → `Range: 100-149`); `fetchAllRows` loops until a short chunk (fixture fetch stub returning 1000+1000+37 rows → 2037); `el('div', {}, dbString)` puts hostile `<img onerror>` text in as TEXT (assert `textContent` equals input and `querySelector('img')` is null); `sectionState` failed-state retry button calls the callback; `photoUrl` chain (image_url wins; bioguide fallback; null). Run: `node --test` — new tests FAIL.
- [ ] **Step 2: Implement the three modules** (browser-native ESM; `rest.js` reads config via `import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js'`; in node tests, inject via a `_setFetch`/`_setConfig` test hook exported for tests only). `_redirects`:

```
/person/*      /person.html      200
/legislator/*  /legislator.html  200
/bill/*        /bill.html        200
/trust         /trust.html       200
```

- [ ] **Step 3: `scripts/serve-site.js`** — zero-dep node http server: serves files under `site/` by extension content-type, applies the same four rewrites, port 8990, 127.0.0.1 only. (~40 lines; no directory traversal: resolve and require the result starts with the site root.)
- [ ] **Step 4: Full suite green, commit** — `git commit -m "feat: site scaffold - rest/render/receipts modules, rewrites, dev server"`
- [ ] **Step 5 (LANCE GATE):** Lance pastes the anon key + URL into `site/config.js` (or approves the controller copying the URL from `.env` and the anon key he added in Task 1).

### Task 4: summary-parse — one shared parser, one-liner extraction

**Files:**
- Create: `site/js/summary-parse.js`
- Modify: `src/cli/verify.js` (parseBullets moves out; re-import + re-export from the new file so existing consumers/tests are untouched)
- Test: `tests/summary-parse.test.js`

**Interfaces:**
- Produces (in `site/js/summary-parse.js`, imported by BOTH the browser and `src/cli/verify.js` — one copy, no build step; Node imports across directories fine):
  - `parseBullets(bodyMd)` → `[{index, point, section}]` — MOVED VERBATIM from `src/cli/verify.js:37` including its comment block. Not reformatted, not "improved".
  - `extractStatedPurpose(bodyMd)` → string | null — the line starting `**Stated purpose (from the bill):** ` (exact prefix, the renderMarkdown contract), prefix stripped, trimmed; null when absent.
  - `extractOneLiner(bodyMd)` → string | null — `extractStatedPurpose(...) ?? parseBullets(...)[0]?.point ?? null`. This is the spec §3 mechanical one-liner: stated purpose when non-empty, else first bullet point, else null (render title-only).

- [ ] **Step 1: TDD** — failing tests: a real body_md fixture (purpose + 3 bullets) → one-liner is the purpose; purpose-less fixture → first bullet point; empty/garbage → null; `parseBullets` behavior pinned by two cases copied from the existing verify tests (sections containing parentheses split on LAST ` (`). Run: `node --test` — FAIL on the new file.
- [ ] **Step 2: Move + implement.** `src/cli/verify.js` becomes `import { parseBullets } from '../../site/js/summary-parse.js'; export { parseBullets };` — its `countRawBulletLines` and everything else stays put.
- [ ] **Step 3: FULL suite green** (this proves the move broke no verifier consumer), commit — `git commit -m "feat: shared summary parser + mechanical one-liner extraction (verify.js re-imports)"`

### Task 5: profile model (pure)

**Files:**
- Create: `site/js/profile-model.js`
- Test: `tests/profile-model.test.js`

**Interfaces:**
- Produces (all pure, no fetch):
  - `buildIdentity({person, legislators, terms})` → `{displayName, party, chamberLabel, districtLabel, careerSpan, photoCandidate, rowCount}`. displayName: `person.display_name` when person present, else the single row's `full_name` as stored — never edited. party: from the most recent term with a party, else legislator.party, else null (render "party unrecorded"). Most-recent term: max non-null `start_date`; when ALL start_dates are null, the term set is date-unproven → careerSpan `'service dates unrecorded'` and chamber/district from any term labeled "as of the {session-era} record" is NOT attempted — label plainly from the term row but suffix the careerSpan honestly.
  - `careerSpan(terms)` → e.g. `'2013 – 2023'`, `'2019 – (end date unrecorded)'`, `'service dates unrecorded'` — never invents currency ("present" is banned; an open end is "(end date unrecorded)").
  - `chamberLabel(jurisdiction_id, chamber)` → 'U.S. Senate' | 'U.S. House' | 'MO Senate' | 'MO House' (exact map, unknown combos → the raw values joined, never dropped).
  - `voteFilterQuery({legislatorIds, chamber, year, page})` → the exact `public_vote_feed` REST path with filters (`legislator_id=in.(...)`, optional `chamber=eq.`, optional `vote_date=gte.YYYY-01-01&vote_date=lt.YYYY+1-01-01`, `order=vote_date.desc.nullslast,cast_id.desc`).
  - `groupSponsorships(sponsorRows)` → `{primary: [], cosponsor: [], joint: [], unspecified: []}` (exact 0015 vocabulary; unknown values throw — fail loud, a new type means a schema change happened).

- [ ] **Step 1: TDD** — failing tests: Onder-shaped fixture (4 linked rows, MO senate 2013-2023 + federal house 2023-) → identity fields exact; null-date-only terms → 'service dates unrecorded'; year+chamber filter path string exact; unknown sponsor_type throws; "present" never appears in any careerSpan output (assert on all fixtures). Run: `node --test` — FAIL.
- [ ] **Step 2: Implement to green. Commit** — `git commit -m "feat: pure profile model (identity, career span honesty, filter queries)"`

### Task 6: profile page — person.html, person.js, legislator.html

**Files:**
- Create: `site/person.html`, `site/js/person-page.js`, `site/legislator.html`, `site/js/legislator-page.js`
- Test: `tests/person-page.test.js` (pure helpers: id-from-path, one-liner attach, flag-badge join)

**Interfaces:**
- Consumes: everything from Tasks 3–5 by the exact names above.
- URL contract: `/person/<uuid>[/<slug-ignored>]`; `idFromPath(pathname, prefix)` → uuid | null (exported pure, tested).
- Data flow (each section independently three-stated):
  1. `legislators?person_id=eq.<id>` via `fetchAllRows` + `persons?id=eq.<id>`; empty legislators AND no person → 'failed'-style not-found state ("no such profile in our data").
  2. `terms?legislator_id=in.(...)` → `buildIdentity`.
  3. Votes: `pagedFetch(voteFilterQuery(...))`; filter controls re-query the SERVER (never client-sort partial pages); each row: position as stored, bill identifier+title (linked to `/bill/<bill_id>/<identifier-slug>`), receipt link from `voteReceiptUrl` labeled "source", one-liner (step 4), flag badge (step 5). Missed-votes toggle = `position=in.(not_voting,absent)` server filter.
  4. One-liners: for the CURRENT page's distinct bill_ids: `summaries?bill_id=in.(...)&status=eq.published&select=bill_id,body_md,published_at&order=published_at.desc` → keep first per bill_id (current published) → `extractOneLiner`. Null → title only.
  5. Flags: `public_reconciliation_flags?vote_id=in.(current page's vote_ids)` → badge "⚑ reconciliation flag" linking `/trust#flags` on matching rows.
  6. Sponsorships: `bill_sponsors?legislator_id=in.(...)&select=sponsor_type,bills(id,identifier,title,status)` via `fetchAllRows` → `groupSponsorships` → four labeled sections (empty groups render nothing — absence of a section is honest here since the labels are exhaustive).
  7. Freshness box: `public_freshness` rows for the sources relevant to this profile's jurisdictions (map: us-congress → sources starting `us-`; mo-legislature → `mo-` + `legiscan`), quarantined_days > 0 renders "N journal days pending human review".
- `legislator.html`/`legislator-page.js`: fetch the row; `person_id` set → `location.replace('/person/<person_id>')`; else render the same profile sections with `legislators=[row]`, `person=null`.

- [ ] **Step 1: TDD the pure helpers** (`idFromPath`, one-liner-attach map, flag-badge join) — failing first, then green.
- [ ] **Step 2: Build the pages.** Every DB string through `el(...)` text nodes. Photo: `photoUrl` result or the no-photo block.
- [ ] **Step 3: Full suite green, commit** — `git commit -m "feat: profile page (person + legislator forwarding) wired to live anon surface"`
- [ ] **Step 4 (controller smoke, needs Tasks 1+3 gates done):** `node scripts/serve-site.js` → load Onder's person URL → verify against the review server's known truth: identity header, ~1,650 casts paginated, 179 sponsored bills, receipts click through to real roll-call/journal URLs, filters re-query, throttled-network loading states visible, one flagged-vote badge if any of his votes carry flags. Record findings in the ledger.

### Task 7: Cloudflare Pages deploy (early-deploy decision)

**Files:** none (Lance-operated console steps + one probe)

- [ ] **Step 1 (LANCE GATE, exact steps):** Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → select `lazrexmc/VisibleGov` → production branch `main`, build command EMPTY, build output directory `site` → Deploy. (The site work merges to main before this — or point Pages at the `public-site` branch as a preview first; Lance's choice, both documented.)
- [ ] **Step 2:** Verify on the real URL (phone + desktop): Onder profile renders; `_redirects` rewrites work (a hard refresh on `/person/<id>` does not 404); config.js anon key works from the Pages origin (Supabase CORS allows all origins by default — if a CORS failure appears, it is a finding, not a shrug).
- [ ] **Step 3:** Record the URL in the ledger + CHATLOG. Nothing links to it publicly until Lance says so.

### Task 8: directory + address lookup (+ the geocode function)

**Files:**
- Create: `site/js/directory-page.js` (replaces index placeholder wiring), `site/js/districts.js`, `site/functions/geocode.js`
- Modify: `site/index.html`
- Test: `tests/districts.test.js`, `tests/directory-model.test.js`

**Interfaces:**
- `districts.js` (pure):
  - `parseGeographies(censusJson)` → `{state, cd, sldu, sldl}` — from `result.addressMatches[0].geographies`, matching layer keys by PREFIX: `'Congressional Districts'`, `'State Legislative Districts - Upper'`, `'State Legislative Districts - Lower'`; fields: `STUSAB` (state), `CD119`/`BASENAME` for the district number; districts normalized via `normalizeDistrict` (strip leading zeros: '02' → '2'); no match → nulls, never throws.
  - `matchReps({terms, legislators}, {state, cd, sldu, sldl})` → `{usSenators: [], usHouse: [], moSenate: [], moHouse: [], asOf}` — us senators: us-congress + chamber=senate + (term.state ?? term.district) === state; us house: us-congress + house + term.state === state + normalizeDistrict(term.district) === cd; MO: mo-legislature + chamber + normalizeDistrict(term.district) === sldu/sldl (only when state==='MO'). `asOf`: from the matched terms' dates when present, else `'per the most recent term evidence in our data (dates unrecorded)'` — the spec's currency-honesty ruling, verbatim behavior: NEVER the word "current".
  - When several legislators match one seat (era overlap unprovable), return ALL matches; the UI renders them all with their date evidence — showing candidates honestly beats guessing.
- `site/functions/geocode.js` (the one allowed server code):

```js
// Cloudflare Pages Function: /geocode?address=... — a no-logging pass-through to the Census
// Geocoder (their API sends no CORS headers, so the browser cannot call it directly).
// PRIVACY CONTRACT (spec §5, review-blocking): the address is forwarded to the Census request
// and NOWHERE else. No console.log, no analytics, no KV, no cache writes, no error reporting
// that includes the address. Errors return generic JSON.
export async function onRequestGet({ request }) {
  const address = new URL(request.url).searchParams.get('address');
  if (!address || address.length > 500) {
    return Response.json({ error: 'address required' }, { status: 400 });
  }
  const u = new URL('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress');
  u.searchParams.set('address', address);
  u.searchParams.set('benchmark', 'Public_AR_Current');
  u.searchParams.set('vintage', 'Current');
  u.searchParams.set('format', 'json');
  try {
    const upstream = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) return Response.json({ error: 'geocoder unavailable' }, { status: 502 });
    return Response.json(await upstream.json());
  } catch {
    return Response.json({ error: 'geocoder unavailable' }, { status: 502 });
  }
}
```

- Directory: `fetchAllRows('legislators?select=id,full_name,party,person_id,bioguide_id,mo_senate_id,mo_house_id,openstates_id,legiscan_people_id')` + persons + terms (fetchAllRows each); group rows by person_id (ungrouped rows stand alone); one entry per person/row: display name, chamber/party/district from most recent term, link to `/person/` or `/legislator/`; client-side text filter over name + chamber + party (a filter over a COMPLETE fetched list — not a partial-page sort). Alphabetical by surname — the one neutral order.
- Address UI: input + "find my representatives" → `/geocode` → `parseGeographies` → `matchReps` → the five-people result with as-of labels; the privacy contract sentence renders VERBATIM next to the input: "Your address is sent to the U.S. Census Bureau geocoder to find your districts, and is not stored or logged — not by us, not ever."; geocoder failure → the three-state 'failed' treatment; address-not-found → honest empty ("the geocoder couldn't match that address").

- [ ] **Step 1: TDD districts.js** off a captured real Census payload fixture (capture once with a public landmark address — e.g. the MO State Capitol, 201 W Capitol Ave, Jefferson City, MO — never a private address, commit as `tests/fixtures/census/capitol.json`): parse → `{state:'MO', cd, sldu, sldl}` exact; leading-zero normalization; matchReps against a terms fixture incl. the ambiguous-seat multi-match case and the null-dates as-of string. FAIL first.
- [ ] **Step 2: Implement districts.js + directory model to green.**
- [ ] **Step 3: Wire index.html + directory-page.js + the function.** Local dev: `serve-site.js` gains a `/geocode` passthrough mimicking the function (same code path importable — keep the upstream-URL builder as an exported pure function so the dev server and the Pages function share it).
- [ ] **Step 4: Full suite green, commit** — `git commit -m "feat: directory + address lookup (geocode pass-through, currency-honest matching)"`
- [ ] **Step 5 (controller smoke):** Capitol address → five MO people with as-of labels; a non-MO address → federal-only results labeled; garbage address → honest failure.

### Task 9: bill page + glossary

**Files:**
- Create: `site/bill.html`, `site/js/bill-page.js`, `site/js/glossary-inline.js`
- Test: `tests/bill-page.test.js` (pure: tally counting, glossary marking, verification-note assembly)

**Interfaces:**
- Data: bill row (`bills?id=eq.` + session + jurisdiction labels); sponsors (`bill_sponsors?bill_id=eq.&select=sponsor_type,legislators(id,full_name,person_id)`); roll calls (`votes?bill_id=eq.&order=vote_date.desc` then per vote `vote_casts?vote_id=eq.&select=position` via fetchAllRows); summary (current published per bill: `status=eq.published&order=published_at.desc` first row) + `public_verification_notes?summary_id=eq.`; glossary (`summary_terms?summary_id=eq.` → `glossary_terms?id=in.(...)&status=eq.published`).
- Pure (tested):
  - `tallyPositions(castRows)` → `{yea, nay, not_voting, absent, other: {}}` — a mechanical count of stored rows, labeled in the UI as "recorded casts in our data"; rendered NEXT TO `votes.result` (the source's printed outcome), never replacing it. An unknown position lands in `other` under its raw string — displayed, not dropped.
  - `renderSummaryStructured(bodyMd)` → `{statedPurpose, bullets: [{point, section}]}` via Task 4's parsers — the page renders from the parsed structure; if `parseBullets` yields fewer bullets than `body_md`'s raw `- ` lines (the verifier's own coverage rule), fall back to rendering body_md as PLAIN TEXT lines with a "formatting could not be verified" note — never render half.
  - `markTerms(pointText, glossaryTerms)` → array of `{text, term|null}` segments by case-insensitive EXACT string match on `glossary_terms.term`, longest-first, non-overlapping — segments render as text nodes with `<dfn>` wraps; gloss_md shown in an expandable block below (gloss_md through a MINIMAL renderer: paragraphs + `**bold**` only, built on text nodes — no innerHTML).
- Verification note (receipt): "Summary by {summaries.model}, adversarially verified {overall} by {note.model} on {date}" + supporting quote from `glossary_terms.supported_by_quote` on each gloss. No published summary → "No plain-language summary yet — the facts above are the record." MO bills (`jurisdiction_id='mo-legislature'`): the disclaimer line "Bill text and status shown are not official copies; the official record is at the linked source." + `officialBillUrl` link.

- [ ] **Step 1: TDD the three pure functions** (fixtures: real body_md, a cast set with an unexpected position string, term marking with overlapping candidates) — FAIL first.
- [ ] **Step 2: Implement + wire the page.** Every section three-stated. **Step 3: suite green, commit** — `git commit -m "feat: bill page (tallies-beside-printed-result, structured summary, inline glossary)"`
- [ ] **Step 4 (controller smoke):** one published-summary bill (e.g. S 2), one summary-less MO bill, one bill with a reconciliation-flagged vote.

### Task 10: trust page + universal footer

**Files:**
- Create: `site/trust.html`, `site/js/trust-page.js`
- Modify: `site/js/render.js` (`mountFooter` gets its real content), all `site/*.html` (footer mount point — verify each)
- Test: extend `tests/site-modules.test.js` (footer links present; counts render path)

**Interfaces:**
- Trust page sections (anchors): `#pipeline` (the mechanical story: official sources → reconcile-or-refuse → author from official text → adversarial verify → mechanical gates → publish with receipts; flagged items wait for human review and say so), `#flags` (what a reconciliation flag / quarantined day means; primary-source-first display), `#freshness` (the full `public_freshness` table rendered), `#attribution` (LegiScan CC-BY 4.0 with link, Congress.gov, senate.gov LIS, house.mo.gov XML, MO Senate journals with the not-official-copies disclaimer, U.S. Census Bureau Geocoder, bioguide/unitedstates images), `#counts` (live `countOnly` numbers: vote casts, bills, legislators, published summaries, published glossary terms — labeled "live from the same database the site reads").
- Footer (every page): "Every fact links to its source. · [How this works](/trust) · [Data freshness](/trust#freshness) · [Attribution](/trust#attribution)".

- [ ] **Step 1: TDD footer content + counts assembly (failing first). Step 2: implement, wire every page, suite green.**
- [ ] **Step 3: Commit** — `git commit -m "feat: trust page + universal footer (the receipts, explained)"`
- [ ] **Step 4 (controller smoke):** every page shows the footer; every trust anchor lands; counts match DB truth.

### Task 11: final review + merge menu

- [ ] Whole-branch review (most capable model, workflow: dimensions → adversarial verify → synthesize; reviewers get the spec + this plan + the ledger; hostile-payload attention on: textContent discipline everywhere, the geocode no-logging contract, the anon surface (attempt service-only reads with the anon key), currency-honesty strings, one-liner parser sharing (no drift between verify.js and the site)) → fix wave → full suite + probe green → **merge menu to Lance**.

## Self-review notes (write time)

- Spec coverage checked section by section: §1→T3, §2→T3/T6, §3→T4/T5/T6, §4→T9, §5→T8, §6→T10, §7→T1 (+T2 for the state gap the spec's currency ruling implied), §8→every task's three-state + pure-test steps, §9 enforced by absence, build order preserved (deploy = T7 sits after the vertical slice exactly as decided).
- The spec's `public_person_links` view is superseded (legislators.person_id already public) — noted in T1; the spec gets a one-line amendment commit in T1's Step 3.
- Census layer-name prefixes and field names in T8 are best-knowledge; T8 Step 1 captures a REAL payload first and the fixture is the contract — if the real shape differs, the fixture wins and parseGeographies is written to it.
- `terms.state` (T1/T2) is the one schema addition; it is additive, jurisdiction-agnostic, and does not violate the 0014 design freeze (that freeze bars per-state IDENTITY columns on legislators; this is seat geography on terms).
