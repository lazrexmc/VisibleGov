# LegiScan Bulk Adapter Implementation Plan

> **STATUS: approved, rulings folded.** Q1-Q7 (`.superpowers/sdd/legiscan-plan-draft-notes.md`)
> are resolved and folded into the task text and Global Constraints below. One gate remains live
> at execution time, not an open design question: **Task 3 does not start writing ZIP-decode code
> without Lance's explicit approval of the `yauzl` dependency** (Q1 — controller RECOMMENDS it,
> but a new runtime dependency is Lance's call per project precedent). Everything else in this
> plan is unconditionally ready to execute task-by-task.

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax.

**Goal:** MO bill/vote backfill (2010-2026, both chambers) from LegiScan's bulk dataset API,
becoming the PRIMARY MO ingestion path — individual roll-call votes at a fraction of the query
cost of the primary-source PDF/journal parsers, with the same reconcile-or-throw integrity gate,
fail-loud identity resolution, and draft-then-apply migration discipline as every prior adapter in
this repo. The existing `mo-house-xml`/`mo-rollcall-pdf` and `mo-senate-web`/`mo-senate-journal-
pdf` pipelines do not retire. **Task 8, REVISED by Task 7's evidence**
(`docs/research/2026-07-29-legiscan-substitute-vehicles.md`, VERIFIED-BY-PAYLOAD): the MO Senate
journals pipeline is COMPLETENESS-CRITICAL — LegiScan's own schema cannot represent a
combined-vehicle floor vote (`ls_bill_vote.bill_id` is a single scalar FK), and the real SBs 894 &
921 case proves LegiScan has zero record of a genuine individually-recorded vote for either
sibling bill — so it keeps its full ingestion cadence PERMANENTLY, not demoted to audit-only. The
House XML pipeline's exposure to the same gap is UNKNOWN, documented as such pending Task 10's
evidence. See Task 8 below for the full revised policy.

**Architecture:** **Dataset-bulk-first for backfill, not per-bill polling.** LegiScan's
`getDatasetList`/`getDataset` operations return one Base64-encoded ZIP per session containing
every `getBill`/`getRollCall`/`getPerson` payload for that session already assembled — this is
how "~1000 queries covers 3.5M+ records" per LegiScan's own framing (binding terms doc). The
whole MO 2010-2026 backfill (31 sessions, confirmed via `tests/fixtures/research/legiscan/mo-
sessions.json`) is therefore on the order of tens of queries (one `getDatasetList` + one
`getDataset` per session, gated by `dataset_hash`), not weeks of 30-minute-cadence PDF pulls.
`getMasterListRaw`/`getSearchRaw` + `change_hash`-gated individual `getBill`/`getRollCall` calls
(the terms doc's OTHER documented flow, for steady-state incremental freshness) are explicitly
**out of scope for this plan** — that's TODO item 13's freshness machinery, deferred until after
Plan 3a per existing TODO ordering. This plan builds the backfill path only.

**Tech stack:** existing Node ESM project; Node's built-in `fetch`/`zlib` where possible, plus
`yauzl` for ZIP-container decoding — **controller ruling (`.superpowers/sdd/legiscan-plan-draft-
notes.md` Q1): Option A (`yauzl`)**, since `node:zlib` handles raw DEFLATE streams but not the ZIP
central-directory container format itself, and a hand-rolled central-directory reader carries too
much silent-data-loss risk for production ingestion. **This is still a NEW runtime dependency and
therefore requires Lance's explicit per-dependency approval per project precedent (`pdfjs-dist`,
`@anthropic-ai/sdk`) — Task 3 is mechanically gated on that approval and MUST NOT start writing
decode code without it** (see Global Constraints and Task 3). Zero Anthropic API calls anywhere in
this plan — plain ingestion needs no per-run LLM approval gate.

## Global Constraints

- **Binding source: `docs/research/2026-07-28-legiscan-terms.md`.** Every numbered rule there is
  mechanically enforced, not just documented, per its own header. Restated as engineering
  mandates:
  1. ⛔ **`dataset_hash` comparison is MANDATORY before any `getDataset` call** — LegiScan
     enforces this with suspension. Stored per LegiScan `session_id` in a dedicated ledger table
     (Task 1); a matching hash means the cached decode is reused and `getDataset` is never called
     again for that session. This gate gets its own dedicated tests before anything else in this
     plan is wired up (Task 2).
  2. **30,000 queries/month, resets the 1st.** A run refuses to start if it could plausibly push
     the current month's `legiscan`-source query count (summed from `ingestion_runs.detail`, the
     terms doc's own suggested home for this) over a configured cap — **ruled default 5,000/month
     (one-sixth of the hard cap), overridable via `LEGISCAN_MONTHLY_QUERY_CAP`, HARD refusal
     (throw, run never starts) at the configured cap** (`.superpowers/sdd/legiscan-plan-draft-
     notes.md` Q2, APPROVED as drafted). Every LegiScan call this plan makes increments a per-run
     counter that lands in `closeRun`'s detail payload, the same provenance convention as every
     other adapter's run counts. The month boundary itself is UTC (ruling Q5 — see Task 2).
  3. **`status` checked on every JSON response** (OK/ERROR) — typed `LegiScanApiError` on
     anything else, never a silent empty-array skip (skip≠empty, existing convention).
  4. **Local caching of raw JSON/decoded-ZIP responses** — nothing already held is re-queried.
  5. **`change_hash`/`session_hash` fields are recorded even though this plan doesn't act on them
     incrementally** — they ride along in stored provenance so the future freshness adapter (TODO
     13) has them for free without a second historical backfill.
  6. **Page 7 timing guidance is UNVERIFIED in this repo** (no prior live fetch of the LegiScan
     API Manual PDF exists) — Task 2 fetches it (one `WebFetch`, not an API query) before the
     limiter's `minIntervalMs` is finalized. **Ruling (`.superpowers/sdd/legiscan-plan-draft-
     notes.md` Q3, APPROVED): WebFetch the manual first; if unreachable or the guidance isn't
     found, fall back to a `1000`ms labeled placeholder with a durable TODO comment** pointing
     back to Q3 until a human reads the real manual text.
  7. **Document blobs (`getBillText` etc.) downloaded at most once per `doc_id`** — out of scope
     for THIS plan (bill full text / `bill_texts` population is not in this plan's task list; MO
     bill text remains PDF-only at the primary source per `docs/research/2026-07-27-mo-data-
     sources.md` Q1 — a separate, not-yet-scoped plan). Noted so a future bill-text plan doesn't
     have to re-derive this constraint.
  8. ⛔ **Never scrape legiscan.com's front end — API only.** Already true by construction (this
     plan touches only `api.legiscan.com`); `legiscan.com` itself was confirmed Cloudflare-blocked
     to automated fetches in prior research, so there's no temptation path here anyway.
  9. ⛔ **One key. Never create additional Public API keys.** Documentation-only constraint;
     nothing to build.
  10. **CC BY 4.0 attribution.** `source_url` (existing column on `votes`/`bills`) carries the
      LegiScan record link on every LegiScan-sourced row — satisfies per-row traceability now.
      Site-wide attribution UI/footer is Plan 3's job (explicitly deferred); this plan exports a
      small `ATTRIBUTION` constant (Task 9) so Plan 3 doesn't have to reverse-engineer the
      license text later.

- **THE FIXTURES ARE THE SOURCE OF TRUTH.** `tests/fixtures/research/legiscan/*.json` (session
  list, 2018 masterlist, `getBill` for SB894, `getRollCall` for roll call 747209 — 161 real
  `{people_id, vote_id, vote_text}` casts, confirmed populated for MO) anchor every parser test in
  this plan. Where this plan's guesses about payload shape disagree with a fixture, the fixture
  wins and the correction gets documented in the implementing task's commit — same discipline as
  the MO Senate plan's Global Constraints.
- **No dataset ZIP fixture exists yet.** Everything downstream of the ZIP (Tasks 4-7) is written
  fixture-first against a REAL captured dataset, not a synthesized one — Task 3 is a bounded live
  capture whose sole job is producing that fixture before any parser code is written.
- **The cross-era identity bug class MUST NOT reincarnate here.**
  `.superpowers/sdd/2026-07-28-mo-senate-adapter/progress.md` records a Critical, empirically-
  reproduced bug: treating a per-era, REUSED value (a Senate district number — a seat, occupied by
  a different real person every few years) as a table-wide-unique permanent identity key silently
  misattributed a successor's votes to their predecessor. The fix — `(full_name, mo_senate_id)`
  find-or-create, era-scoped resolution rosters, no bare-key uniqueness — is now merged on `main`
  and directly citable: `src/cli/ingest-mo-senate.js` (roster identity fix, ~lines 422-517;
  migration `supabase/migrations/0009_mo_senate_id_nonunique.sql` drops the bare-key unique index)
  and `src/adapters/mo-senate-journal-pdf.js`'s `resolveMoSenator` (era-scoped, fail-loud
  resolution against a per-year roster). This plan's identity design (Task 5) follows the same
  shape.
  **`legiscan_people_id` is a DIFFERENT shape and does not carry this specific risk itself** — it
  is LegiScan's own permanent per-person surrogate key (confirmed by fixture: Douglas Libla
  `people_id: 14996`, Travis Fitzwater `people_id: 17512` — individuals, not seats; LegiScan's own
  `people` table is documented as normalized across sessions per
  `docs/research/2026-07-27-mo-data-sources.md` Q2). A table-wide unique index on
  `legiscan_people_id` itself is therefore SAFE, unlike `mo_senate_id`. **The risk this plan MUST
  design against instead lives one level over: the one-time MAPPING from a new `legiscan_people_id`
  to an EXISTING `legislators` row** (Task 5) uses the exact same shape of signal the mo-senate bug
  exploited — full name + chamber + district — and must therefore be **era-scoped against the
  `terms` table's `start_date`/`end_date`** (never a bare district lookup), **fail loud on >1
  ambiguous candidate** (never guess-merge — create a new row and log it for TODO item 8 instead),
  and **run exactly once per new `legiscan_people_id`** (not on every vote-cast write) so the
  fragile fuzzy-matching step is isolated, logged, and auditable rather than sitting in the hot
  path of every cast resolution. Once a `legiscan_people_id` is attached to a `legislators` row,
  ALL subsequent resolution (e.g. `getRollCall` → `vote_casts`) is a plain unique-index lookup —
  no fuzzy matching, no era ambiguity, by construction.
- **Bill identity coexistence:** `bills` already enforces `unique(session_id, identifier)`.
  LegiScan's `bill_number` field is unspaced (`'SB894'`, confirmed by fixture); the existing
  `mo-senate-journal-pdf.js` convention normalizes to spaced form (`'SB 894'`). Every LegiScan
  bill-identifier write in this plan MUST normalize to the SAME spaced form
  (`bill_number.replace(/^([A-Z]+)(\d+)$/, '$1 $2')`) so a LegiScan-sourced bill row unifies with
  an already-ingested `mo-house-xml`/`mo-senate-journal-pdf` row for the same real bill instead of
  duplicating it — this is load-bearing for Task 8's coexistence design, not a cosmetic nicety.
- **Session identity is FINER-GRAINED in LegiScan than the existing `sessions` convention.** The
  real fixture (`mo-sessions.json`) shows THREE distinct LegiScan `session_id` values for calendar
  year 2018 alone (Regular, 1st Special, 2nd Special — each its own row with its own
  `dataset_hash`). The existing `sessions` table dedupes on `(jurisdiction_id, identifier)` where
  `identifier` is a bare year string (`'2018'`), a convention `mo-senate-web`'s driver relies on
  ("identifier deliberately collides with OpenStates' own year-keyed session rows"). Collapsing
  all three 2018 LegiScan sessions onto one `'2018'` row would lose the regular-vs-special
  distinction; giving each its own row under the bare-year identifier is impossible (constraint
  violation). **Ruled resolution** (`.superpowers/sdd/legiscan-plan-draft-notes.md` Q4, APPROVED —
  Task 1): add a nullable `sessions.legiscan_session_id integer unique` column so every LegiScan
  session gets its own row 1:1; the Regular Session's `identifier` stays the bare year (preserving
  cross-source dedup with OpenStates/`mo-senate-web` for the common case); Special Sessions get a
  distinct identifier (`'<year>-1st-special'` etc., derived mechanically from `session_tag`, never
  guessed). **The assumption that no existing driver currently ingests MO special-session bills is
  no longer taken on faith** — Q4's ruling promotes it to an explicit pre-migration DB probe + grep
  step, now the first checklist item in Task 1 below, that must confirm this before the migration
  SQL is written.
- **Skip≠empty; typed errors; no silent fallbacks.** Additive DB writes only (`insertIfAbsent`);
  provenance `run_id` on every row; API keys never in URLs (`redactUrl` in `src/lib/http.js`
  already redacts `key=`/`api_key=` query params — reused as-is, `?key=` fits the existing
  pattern with zero changes).
- **Every DB read in this plan uses `selectAll` (`src/lib/db.js:85` — the shared pagination
  utility fixing the 1000-row-cap lesson: a bare `.select()` silently truncates at PostgREST's
  default page size, the exact bug `auto-publish-glossary.js`/`gloss.js`/`review/server.js` were
  patched for) OR states inline why it doesn't need to** — a single-row primary-key/unique-column
  lookup; a count-only existence check via `.select(col, { count: 'exact', head: true })` per the
  `ingest-mo-house.js:824`/`ingest-mo-senate.js:934` convention; or a result set a narrow filter
  already bounds well under 1000 rows. Called out per read site in the relevant task below.
  `getMonthlyQueryUsage` (Task 2) is the one read in this plan where skipping `selectAll` would be
  a live correctness bug, not just a convention miss — an undercounted month silently lets a run
  blow past the configured query cap.
- **Draft-then-apply:** every migration in this plan is written + committed, Lance applies.
  Everything gated on an unapplied migration degrades gracefully (`isMissingColumnError` /
  `isMissingRelationError` from `src/lib/db.js`), exactly like every prior migration in this repo.
- **Reconcile-or-throw (non-negotiable, extended):** a LegiScan roll call's parsed individual
  `votes[]` casts must reconcile against LegiScan's OWN printed `yea`/`nay`/`nv`/`absent`/`total`
  fields before storage (mirrors `mo-rollcall-pdf.js`'s `parseMoRollCall` gate exactly). SEPARATELY
  — where this repo already holds a primary-source tally for the same real vote (a `mo-house-xml`
  `RollCall` aggregate, a `mo-senate-journal-pdf`-parsed journal block) — the LegiScan tally is
  cross-checked against it; a disagreement is quarantined (never silently stored, never silently
  overwritten either direction) and lands in a dedicated ledger table (Task 1), not just a log
  line.
- **No LLM calls anywhere in this plan.** Plain ingestion needs no per-run Anthropic approval;
  live LegiScan API calls (a different, non-Anthropic budget with its own hard monthly cap and
  suspension risk) are still bounded per task with an explicit stated query count, mirroring the
  MO Senate plan's `≤14 requests` convention for its own bounded live-capture task — Lance sees
  the count before any bounded-live task runs, same spirit as the LLM approval gate without being
  the same policy.
- node:test via bare `node --test` (Node 24 Windows: never pass a dir arg); full suite (626
  baseline as of this plan's finalization) stays green every task. Commits end:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Migration 0010 — LegiScan identity + ledger schema (draft; Lance applies)

**Files:** Create `supabase/migrations/0010_legiscan_identity_and_ledger.sql`

```sql
-- Draft (Lance applies). LegiScan bulk-adapter identity + operational ledger schema.
--
-- legiscan_people_id: LegiScan's OWN permanent per-person surrogate key (NOT a seat/district
-- number — see the mo-senate-adapter progress.md Critical for why that distinction matters).
-- Safe as a table-wide unique index, unlike mo_senate_id. Coexists with bioguide_id/
-- openstates_id/mo_house_id/mo_senate_id per-row (TODO item 8, identity merge, remains future
-- work — this column does not attempt cross-source unification, only stores LegiScan's own key).
alter table legislators add column legiscan_people_id integer unique;

-- sessions.legiscan_session_id: LegiScan's session_id is FINER-GRAINED than this table's existing
-- (jurisdiction_id, identifier) convention (a calendar year can hold 3 distinct LegiScan sessions
-- - Regular + N Special). One row per LegiScan session_id; Regular Session rows keep the existing
-- bare-year `identifier` (cross-source dedup with OpenStates/mo-senate-web); Special Session rows
-- get a distinct identifier so the unique(jurisdiction_id, identifier) constraint never collides.
alter table sessions add column legiscan_session_id integer unique;

-- Mandatory dataset_hash ledger (binding terms doc, rule 1: suspension-level enforcement). One
-- row per LegiScan session_id ever fetched via getDataset. A getDataset call is skipped whenever
-- the LegiScan-reported dataset_hash for that session_id already matches this table's stored
-- value - this table IS the compare-before-download gate, not just a cache.
create table legiscan_datasets (
  legiscan_session_id integer primary key,
  dataset_hash         text not null,
  local_cache_path     text,           -- decoded-ZIP local cache location (gitignored artifacts dir)
  fetched_at           timestamptz not null default now(),
  run_id               uuid
);

-- Cross-check discrepancy ledger (reconcile-or-throw, extended): when a LegiScan-sourced vote's
-- printed tally disagrees with an already-held primary-source tally (mo-house-xml RollCall
-- aggregate, mo-senate-journal-pdf block) for the same real vote, the disagreement is recorded
-- here rather than silently overwriting either side. Internal/operational - no anon read policy
-- (mirrors the editor_notes precedent: internal QA data is not public-readable by default).
create table vote_reconciliation_flags (
  id           uuid primary key default gen_random_uuid(),
  vote_id      uuid not null references votes(id),
  source_a     text not null,          -- e.g. 'legiscan'
  source_b     text not null,          -- e.g. 'mo-house-xml'
  discrepancy  jsonb not null,         -- { source_a_tallies, source_b_tallies, mismatches: [...] }
  created_at   timestamptz not null default now(),
  resolved     boolean not null default false,
  run_id       uuid
);

alter table legiscan_datasets           enable row level security;
alter table vote_reconciliation_flags   enable row level security;
-- legiscan_datasets: harmless operational metadata (hash + timestamp), same shape as
-- ingestion_runs (which IS anon-readable, powers the freshness footer) - mirrored here.
create policy anon_read on legiscan_datasets for select using (true);
-- vote_reconciliation_flags: internal QA ledger, deliberately NOT anon-readable (no policy
-- created = RLS default-deny for anon). Staff/service-role only.
```

- [ ] **Special-session-collision DB probe (Q4 ruling — confirm before writing the migration
      below, not an assumption):**
      1. DB probe: for each MO `sessions` row, count `bills`/`votes` rows whose `session_id`
         points at a row whose `identifier` does NOT match `/^\d{4}$/` (a bare year) — i.e. any
         session identifier that could only be a prior ad-hoc special-session encoding. Count-only
         query (`.select('id', { count: 'exact', head: true })`, the `ingest-mo-house.js:824`/
         `ingest-mo-senate.js:934` convention — no row data needed, so `selectAll` pagination is
         moot here). Expected: 0 MO `sessions` rows with a non-bare-year identifier today.
      2. Grep confirm: `src/adapters/mo-house-xml.js` and `src/cli/ingest-mo-senate.js` for any
         session-type filter (`special`, `regular`, `session_tag`) — confirm neither driver
         currently discriminates by session type (both are already general-purpose over whatever
         `sessions` rows exist, so neither has ever had the opportunity to create a special-session
         row).
      3. If either check surfaces an existing special-session row or a session-type filter, STOP
         and re-open Q4 — the plan's "distinct identifier for Special Sessions is collision-free"
         claim would be false and the migration/identifier scheme below needs to be revisited
         before it ships. Record the real finding (expected: negative) in this task's commit
         message either way.
- [ ] Write SQL exactly as above (adjust only if a naming collision with an existing column/table
      is found on read — re-read 0001/0005/0008/0009 first) → commit `feat: migration 0010 -
      LegiScan identity + ledger schema (draft; Lance applies)`.

**Produces:** every identity/ledger column and table every later task gates on. NOT applied until
Lance runs it — every later task must degrade gracefully without it (established pattern).

### Task 2: `src/adapters/legiscan.js` — API client core (status/hash gate, limiter, cache)

**Files:** Create `src/adapters/legiscan.js`, `tests/legiscan-client.test.js`

**Interfaces (Produces):**
```js
export const SOURCE = 'legiscan';
export const ATTRIBUTION = { license: 'CC BY 4.0', holder: 'LegiScan', url: 'https://legiscan.com' };
export class LegiScanApiError extends Error {}         // non-OK status field, meta-carrying
export class DatasetHashMismatchError extends Error {} // defensive: dataset_hash changed mid-run
export const legiscanLimiter = createLimiter({ minIntervalMs: LEGISCAN_MIN_INTERVAL_MS }); // 1000ms fallback per ruling Q3, pending this task's WebFetch confirmation
export async function getSessionList(state, { key, limiter = legiscanLimiter })
export async function getDatasetList(state, { key, limiter = legiscanLimiter })
export async function getDataset(sessionId, accessKey, { key, limiter = legiscanLimiter }) // NOTE:
  // LegiScan's getDataset takes the session's own access_key (from getDatasetList), not just the
  // API key - verify this against getDatasetList's real response shape once captured (Task 3);
  // this signature is a research-derived guess per the fixture-first discipline.
export async function getBill(billId, { key, limiter = legiscanLimiter })       // verification/spot-check use, not the bulk path
export async function getRollCall(rollCallId, { key, limiter = legiscanLimiter }) // verification/spot-check use, not the bulk path
export function checkStatus(payload)   // throws LegiScanApiError if payload.status !== 'OK'
export function decodeDatasetHashGate(sessionId, reportedHash, ledgerRow)
  // -> { shouldFetch: bool, reason } — pure, testable without a DB or network: ledgerRow is the
  // already-queried legiscan_datasets row (or null). shouldFetch=false when ledgerRow.dataset_hash
  // === reportedHash. THIS is the suspension-level mandatory gate, isolated and heavily tested.
export async function getMonthlyQueryUsage(client, { source = SOURCE, now = new Date() })
  // sums ingestion_runs.detail.queries_used for this source within the current calendar month.
  // Reads via selectAll (src/lib/db.js:85), NOT a bare .select() - a busy month's ingestion_runs
  // rows could plausibly exceed the 1000-row PostgREST page default, and an unpaginated read
  // would silently UNDERCOUNT usage, letting a run blow past the configured query cap (the exact
  // shape of bug selectAll itself was written to close). Month boundary is UTC (ruling Q5,
  // .superpowers/sdd/legiscan-plan-draft-notes.md - known imprecision vs LegiScan's own ET-based
  // reset, documented in this function's own code comment, low-stakes given the 5,000/30,000
  // headroom).
export function assertUnderBudget(usage, plannedQueries, capPerMonth)  // pure; throws QueryBudgetExceededError
```

- [ ] TDD against the 3 existing non-oversize fixtures (`mo-sessions.json`,
      `mo-2018-SB894.json`, `mo-2018-rollcall-747209.json` — `mo-2018-masterlist.json` is
      1.3MB/2,347 bills, used later in Task 4 via streaming/offset read, not loaded whole here):
      `checkStatus` passes on `status:"OK"`, throws `LegiScanApiError` on anything else (synthetic
      fixture edit for the error case — no real ERROR payload captured yet); `getSessionList`
      parses all 31 real MO sessions; `getBill`/`getRollCall` parse the real SB894/roll-call-
      747209 shapes exactly (assert `sponsors[].people_id`, `votes[].roll_call_id`,
      `roll_call.votes[].{people_id,vote_id,vote_text}` field names verbatim — THE FIXTURE IS THE
      SOURCE OF TRUTH, do not rename fields to a house style).
- [ ] `decodeDatasetHashGate` unit tests (pure, no DB): no ledger row → shouldFetch true (never
      fetched); ledger row present + hash matches → shouldFetch false; ledger row present + hash
      differs (a real dataset update) → shouldFetch true, reason `'hash_changed'`.
- [ ] `getMonthlyQueryUsage`/`assertUnderBudget` unit tests with fake run rows spanning a month
      boundary — UTC boundary per ruling Q5 (`.superpowers/sdd/legiscan-plan-draft-notes.md`), not
      ET; include a fake-client test asserting `getMonthlyQueryUsage` calls through `selectAll`
      (not a bare hand-rolled page loop) so a future page-size change can't silently reintroduce
      the 1000-row undercount.
- [ ] One `WebFetch` (not an API query) of the LegiScan API Manual's Page 7 timing guidance
      (`api.legiscan.com/dl/` per prior research — the developer-tooling subdomain was NOT
      Cloudflare-blocked) to set `LEGISCAN_MIN_INTERVAL_MS` from the real text rather than a
      guess. **Ruling Q3 (APPROVED):** if unreachable or the guidance isn't found, fall back to a
      clearly-labeled `1000` placeholder with a durable TODO comment pointing back to
      `.superpowers/sdd/legiscan-plan-draft-notes.md` Q3 until a human reads the real manual — this
      is the resolved fallback value, not an open guess.
- [ ] Implement, green, commit `feat: legiscan API client - status/hash/budget gates, fixture-
      backed`.

**Produces:** the mandatory suspension-level gate (dataset_hash), the monthly budget refusal, and
every read operation this plan's later tasks call — all fixture/unit-tested BEFORE any live
`getDataset` call is ever made (Task 3).

### Task 3: Bounded live capture — ONE real session dataset ZIP (fixture)

**Files:**
- Create: `tests/fixtures/research/legiscan/mo-2018-dataset.json` (raw envelope, key redacted)
  and its decoded contents under `tests/fixtures/research/legiscan/dataset-2018/` (bills/votes/
  people, decoded from the Base64 ZIP — real captured payload, not synthesized)
- Modify: `tests/fixtures/research/SOURCES.md` (append URL/date/exact query count — same
  discipline as every prior research capture in this repo)

**Bounded to ≤4 live LegiScan queries** (Lance sees this count before the task runs, per Global
Constraints): `getSessionList` (1, reuse if the cached fixture is still fresh — likely 0 needed),
`getDatasetList` for MO (1), `getDataset` for the smallest available 2018 session_id (1, gated by
Task 2's `decodeDatasetHashGate` — first call for this session always fetches), one retry budget
for a transient failure (1). MO's 2018 Regular Session (2,347 bills per the existing masterlist
fixture) is likely NOT the smallest — prefer a Special Session (2018 1st/2nd Special, `session_id`
1579/1608) for a genuinely small first fixture; the Regular Session dataset can be captured in a
LATER live task (Task 10) once the parser is proven.

- [ ] ⛔ **DEPENDENCY GATE — do not write capture/decode code past this line without Lance's
      explicit approval, captured in this task's commit message.** Ruling
      (`.superpowers/sdd/legiscan-plan-draft-notes.md` Q1): the controller RECOMMENDS Option A
      (`yauzl` — minimal, well-audited, streaming-capable, no native bindings) over Option B (a
      hand-rolled central-directory reader over `node:zlib.inflateRawSync` — feasible for the
      well-documented PKZIP format but a real correctness surface for production ingestion, where
      a subtle bug risks silent data loss that's harder to catch than a PDF-extraction miss). **The
      recommendation is NOT the approval** — same standing policy as every other new runtime
      dependency this repo has taken (`pdfjs-dist`, `@anthropic-ai/sdk`): a new npm dependency
      requires Lance's explicit per-dependency sign-off, asked for up front with what it is and
      why, before it's added.
      - **If approved:** add `yauzl` to `package.json`, implement decode against it; note the
        approval (who/when) in this task's commit message.
      - **If declined or unavailable:** fall back to Option B (hand-rolled central-directory
        reader); document that choice and why in this task's commit message, and flag the
        increased correctness-review burden for Task 4's fixture-first tests.
      Either way, the decision and its basis are documented in this task's commit message before
      any capture/decode code is written.
- [ ] Live capture per the bounded budget above; append to SOURCES.md; note the REAL `getDataset`
      response envelope shape (does it require the session's `access_key` from `getDatasetList`,
      per the client signature's flagged guess in Task 2? confirm and correct if wrong).
- [ ] Commit: `chore: capture LegiScan MO dataset ZIP fixture (research-budgeted, ≤4 queries)`.

**Produces:** the one real dataset payload every parser test in Tasks 4-7 is written against.

### Task 4: Dataset payload parsing — bills, roll calls, people (fixture-first)

**Files:** Create `src/adapters/legiscan-dataset.js`, `tests/legiscan-dataset.test.js`

**Interfaces (Produces):**
```js
export function decodeDatasetZip(base64Zip) -> Buffer  // built on yauzl if Task 3's dependency
  // gate (Q1) was approved, else the Task-3-documented hand-rolled central-directory reader —
  // whichever Task 3's commit message records as the resolved decision
export function extractDatasetFiles(zipBuffer) -> { bills: [...], rollCalls: [...], people: [...] }
  // exact shape driven by what Task 3's real fixture actually contains inside the ZIP - LegiScan's
  // dataset ZIPs are DOCUMENTED (per prior research) to bundle getBill/getRollCall/getPerson
  // payloads per-session; the internal file layout (one JSON per bill? one big array?) is
  // currently UNKNOWN and must be read from the real fixture, not assumed.
export function normalizeBillIdentifier(billNumber) -> string    // 'SB894' -> 'SB 894'
export class DatasetParseError extends Error {}                  // meta-carrying, mirrors JournalParseError
```

- [ ] TDD against Task 3's real fixture: `decodeDatasetZip` + `extractDatasetFiles` recover the
      known bill count / roll-call count / people count for the captured session (assert the REAL
      numbers, not a guessed round number); `normalizeBillIdentifier('SB894')` → `'SB 894'`
      (matches `mo-senate-journal-pdf.js`'s own normalized format exactly — cross-checked, not
      just internally consistent); a corrupted/truncated ZIP throws `DatasetParseError`, never
      returns partial data silently.
- [ ] Implement, green, commit `feat: legiscan dataset ZIP parser - bills/rollcalls/people
      (fixture-backed)`.

### Task 5: Identity — `legiscan_people_id` find-or-create + mapping to existing MO rows

**Files:** Create `src/adapters/legiscan-identity.js`, `tests/legiscan-identity.test.js`

**Interfaces (Produces):**
```js
export function normalizePersonName(fullName) -> string   // whitespace/case normalization for matching
export async function findCandidateLegislatorRows(client, { fullNameNormalized, chamber, district, sessionStartDate, sessionEndDate })
  // -> era-scoped query against `terms` (chamber + district + start_date/end_date OVERLAP with the
  // session window) joined to `legislators` on full_name (normalized). NEVER a bare district
  // lookup - this is the exact shape of query the mo-senate Critical bug's fix requires. Plain
  // .select() (not selectAll) - the chamber+district+era-window filter bounds this to a handful
  // of candidate rows at most (one seat's occupants across overlapping eras), nowhere near the
  // 1000-row page default selectAll (src/lib/db.js:85) guards against.
export async function resolveOrCreateLegiscanPerson(client, runId, legiscanPerson, sessionWindow)
  // legiscanPerson: { people_id, name, first_name, last_name, party, role, district, ... } (real
  // fixture shape - sponsors[]/roll_call.votes[] entries, see mo-2018-SB894.json)
  // 1. exact-match lookup: legislators.legiscan_people_id = people_id -> if found, done (safe
  //    unique-key path, no fuzzy matching - this is the ONLY path a repeat call for an
  //    already-mapped person ever takes).
  // 2. first time seen: findCandidateLegislatorRows. 0 matches -> INSERT a new legislators row
  //    with legiscan_people_id set, log { matched: false, reason: 'no_candidate' } in run detail
  //    (future identity-merge, TODO item 8, picks this up later - NEVER guessed here).
  //    1 match -> additivePatch-style UPDATE setting legiscan_people_id on that EXISTING row (only
  //    if it doesn't already have a DIFFERENT legiscan_people_id - a conflict there is a hard
  //    error, not a silent overwrite). >1 match -> FAIL LOUD: create a new row anyway (never
  //    guess-merge) and log { matched: false, reason: 'ambiguous', candidateCount } for review.
```

- [ ] TDD against the real SB894 fixture's `sponsors[]` (Douglas Libla `people_id:14996`, role
      `Sen`, district `SD-025`; Travis Fitzwater `people_id:17512`, role `Rep`, district
      `HD-049`) as concrete test people, plus synthetic candidate-row fixtures exercising: 0
      candidates → new row; exactly 1 candidate whose `terms` window overlaps the session → patch;
      2 candidates with overlapping windows (simulating a same-surname collision within one era,
      the mo-senate bug's exact shape) → fail loud, new row + ambiguous log, NEVER pick one;
      repeat call for an already-`legiscan_people_id`-tagged person → the safe unique-key path,
      zero fuzzy matching invoked (assert the fuzzy-match function is NOT called on this path —
      isolation is the point).
- [ ] Implement, green, commit `feat: legiscan identity resolution - people_id find-or-create,
      era-scoped mapping to existing MO rows`.

**Produces:** the ONE place in this plan where the mo-senate bug's risk shape (full_name+chamber+
district fuzzy matching) is exercised — isolated, tested, and run once per person, never in the
hot path of vote-cast resolution (Task 6 only ever does the safe unique-key lookup).

### Task 6: Votes + casts ingestion — reconcile-or-throw, cross-check, collision-safe keys

**Files:** Create `src/adapters/legiscan-votes.js`, `tests/legiscan-votes.test.js`

**Interfaces (Produces):**
```js
export const VOTE_ID_MAP = { 1: 'yea', 2: 'nay', 3: 'not_voting', 4: 'absent' };
  // per docs/research/2026-07-27-mo-data-sources.md Q2 (schema-mysql.sql ls_vote table) - ONLY
  // these 4 values are confirmed. Any other vote_id -> typed error, never silently -> 'other'.
export class VoteIdMapError extends Error {}
export function buildLegiscanVoteSourceKey(rollCallId) -> string  // 'legiscan-mo-<roll_call_id>'
  // roll_call_id is LegiScan's own globally-unique key - cannot collide with 'mo-senate-web-*' or
  // 'mo-house-xml-*' prefixes by construction (different alphabet/shape entirely).
export function reconcileLegiscanTallies(rollCall)
  // -> throws RollCallParseError-shaped error if parsed votes[] position counts != rollCall's own
  // printed yea/nay/nv/absent - mirrors parseMoRollCall's gate exactly, applied to LegiScan's OWN
  // printed numbers (not a primary-source cross-check yet - that's the next function).
export async function crossCheckAgainstPrimarySource(client, billId, legiscanTallies)
  // -> { checked: bool, matched: bool|null, flag: {...}|null } - looks up an ALREADY-STORED
  // primary-source vote for the same bill_id/chamber/approximate date (mo-house-xml or
  // mo-senate-journal-pdf source_key prefix); if none exists, checked:false (opportunistic, not
  // blocking - LegiScan covers far more sessions than the primary parsers have reached). If one
  // exists and tallies disagree, writes a vote_reconciliation_flags row (Task 1) and returns
  // matched:false - the LegiScan vote is NOT quarantined outright (its OWN internal reconcile
  // already passed) but the disagreement is durably flagged for human review, never silently
  // dropped either direction. Single-row lookup by bill_id+chamber+date (at most one primary-
  // source vote per real roll call) - plain .select(), selectAll (src/lib/db.js:85) not needed.
```

- [ ] TDD against the real roll-call-747209 fixture (yea=121,nay=19,nv=0,absent=21,total=161 —
      161 individual casts, EXACT match required): `reconcileLegiscanTallies` passes on the real
      fixture; a mutated copy (drop one Yea cast) throws. `VOTE_ID_MAP` covers vote_id 1/2/4 (the
      fixture has no `3` example — note this gap, don't fabricate a test for an unobserved value);
      an unrecognized vote_id (5, synthetic) throws `VoteIdMapError`, never defaults to `'other'`.
      `buildLegiscanVoteSourceKey(747209)` → `'legiscan-mo-747209'`; assert it never matches
      `/^mo-senate-web-/` or `/^mo-house-xml-/` (collision-safety, directly tested). Note the
      LegiScan/MO-House PDF category mismatch found during planning (LegiScan's `ls_vote` has no
      distinct "Present" code; MO House's own `Y/N/P/@` PDF tallies do) as a KNOWN cross-check
      caveat in this task's own comment — a genuine "Present" cast may show up as a LegiScan
      `not_voting`/`absent` disagreement against a primary-source tally that isn't a real error;
      `crossCheckAgainstPrimarySource` must record the caveat in the flag row, not just a bare
      mismatch, so a human reviewer isn't misled.
- [ ] `crossCheckAgainstPrimarySource` tests with fakes: no existing primary-source vote → `checked:false`;
      matching tallies → `matched:true`, no flag row; disagreeing tallies → flag row written,
      `matched:false`, LegiScan vote still stored (its own internal gate already passed).
- [ ] Implement, green, commit `feat: legiscan votes/casts - reconcile-or-throw + primary-source
      cross-check, collision-safe source_key`.

### Task 7: Substitute-vehicle attribution — bounded investigation, then implement

**Files:** Modify `src/adapters/legiscan-votes.js` (or a small sibling module); tests

`tests/fixtures/research/SOURCES.md` already flags this open: SB894's real `getBill` fixture
carries exactly ONE roll call (747209, House, described `"House: SB 894  SBs 3rd READ -
INFORMAL"` — note the plural "SBs", confirming this vote covers the combined `SS for SCS for SBs
894 & 921` vehicle from the MO Senate journal fixture). Crucially, **none of SB894's own recorded
Senate-passage actions** (`S Third Read and Passed`, `Truly Agreed To and Finally Passed`, both
2018-05-03) **have a corresponding roll call in SB894's `votes[]` array at all** — meaning either
(a) that Senate passage was a voice vote with no individually-recorded tally, or (b) LegiScan
attributes the Senate roll call for a combined vehicle to a DIFFERENT bill's record (SB921's, per
the working hypothesis already noted in SOURCES.md) rather than duplicating it onto SB894 too.
This must be settled with real payloads before an attribution rule is coded, not assumed either
way.

**Bounded to ≤3 live LegiScan queries** (stated up front, per Global Constraints): `getBill` for
SB921 in the 2018 session (1 — check whether IT carries a Senate-chamber roll call around
2018-03-01/2018-05-03 that SB894 lacks); if found, `getRollCall` for that roll call (1, confirm
whether its `bill_id` points at SB921 only or is somehow shared); 1 query held in reserve.

- [ ] Run the bounded live investigation; document the REAL finding (which of (a)/(b) above, or a
      third shape neither anticipated) in this task's commit message and in
      `tests/fixtures/research/SOURCES.md`.
- [ ] Implement the attribution rule the real finding actually supports. **Schema implication,
      ruled in advance** (`.superpowers/sdd/legiscan-plan-draft-notes.md` Q6, APPROVED): if the
      finding shows LegiScan attributing ONE roll call to MULTIPLE sibling bills, `votes.bill_id`
      (a single nullable FK) cannot represent that without either (i) picking one bill as primary
      (mirrors `mo-senate-journal-pdf.js`'s own precedent: `bill_refs[0]` is primary, siblings are
      traceable via the verbatim motion/desc text) — no schema change needed — or (ii) a new
      bill↔vote join table if per-bill attribution genuinely matters for both siblings
      independently. **Ruled: do NOT build (ii) speculatively** — ship (i) unless the real finding
      demonstrates it's needed, and even then only if Plan 3's bill-page scoping actually demands
      it, not preemptively here.
- [ ] TDD the implemented rule against whatever real fixture the investigation produced.
- [ ] Commit `feat: legiscan substitute-vehicle attribution (investigated, not assumed)`.

### Task 8: Coexistence policy — REVISED by Task 7's evidence (Senate stays completeness-critical)

> **REVISED (controller ruling, post-Task-7-evidence — binding, appended to
> `.superpowers/sdd/2026-07-29-legiscan-bulk-adapter/task-8-brief.md`):** this task's original
> framing below ("demote primary-source drivers to reconciliation cadence," written before Task 7
> ran) is SUPERSEDED for the MO Senate journals pipeline. Task 7's bounded live investigation
> (`docs/research/2026-07-29-legiscan-substitute-vehicles.md`, VERIFIED-BY-PAYLOAD) found LegiScan's
> own schema structurally cannot attribute one roll call to more than one sibling bill_id
> (`ls_bill_vote.bill_id` is a single scalar FK) and proved a real case (`SS for SCS for SBs 894 &
> 921`, a genuine individually-recorded 31-0 Senate vote, 2018-03-08, ground-truthed against the Day
> 37 journal fixture) where LegiScan has ZERO record of the vote for EITHER sibling bill. The MO
> Senate journals-first pipeline (`ingest-mo-senate.js`/`mo-senate-journal-pdf.js`) is therefore
> COMPLETENESS-CRITICAL — sole source for that entire class of combined-vehicle floor votes — and
> keeps its full ingestion cadence PERMANENTLY; it is NOT demoted to audit-only. The House XML
> pipeline's exposure to the same gap is UNKNOWN (Task 7 was Senate-scoped only, by design) —
> documented as such, never assumed either way; Task 10 gathers the first evidence via a
> per-chamber count comparison before any House-side demotion/completeness-critical call is made.
> Scope stays SMALL exactly as originally ruled (Q7) — policy/comment updates in the two drivers +
> this plan-level statement + exercising the Task 6 cross-check wiring; still NO new reconciliation
> CLI/UI. One addition: CONTROLLER RULING 3 requires documenting a display-time dedup rule for
> downstream consumers (Plan 3) — see item 4 below, comment-only, no code change. The text below
> (original, pre-Task-7) is kept for its still-accurate parts (the `crossCheckAgainstPrimarySource`
> wiring mechanism, the "scope stays small" ruling) but its blanket "demote to reconciliation
> cadence" framing no longer applies uniformly — see items 1-2 as amended.

**Files:** Modify `src/cli/ingest-mo-house.js`, `src/cli/ingest-mo-senate.js` (cadence/role
comments only — no `--reconcile-only` flag: neither driver's cadence actually changes, per the
revision above, so that flag from the original framing is not built); no new adapter files —
**deliberately right-sized**: this task lands the POLICY and the LEDGER WIRING (Task 1's
`vote_reconciliation_flags` table + Task 6's `crossCheckAgainstPrimarySource`), not a full new
automated comparison engine. **Ruled** (`.superpowers/sdd/legiscan-plan-draft-notes.md` Q7,
APPROVED — ship the small version now): a fuller reconciliation-review CLI/UI is legitimate
follow-on work, explicit and deferred, not built here — it's premature before
`vote_reconciliation_flags` has ever had real rows to review.

**Concrete changes:**
1. Both drivers' module-header comments updated — **per-driver, not uniform** (revised, per Task
   7's finding): both state LegiScan (`src/cli/ingest-legiscan.js`, Task 9) is now PRIMARY for MO
   backfill generally. But `ingest-mo-senate.js`'s comment states it stays COMPLETENESS-CRITICAL,
   keeps its full cadence, and is NOT demoted; `ingest-mo-house.js`'s comment states its exposure to
   the same combined-vehicle gap is UNKNOWN, deferred to Task 10's per-chamber count comparison, not
   assumed either way. No functional behavior change in THIS task for either driver — both keep
   working exactly as they do today (they still write votes rows when run; nothing about their
   parsing/reconcile-or-throw internals changes).
2. `crossCheckAgainstPrimarySource` (Task 6) is the actual mechanism: it runs from the LegiScan
   ingestion side and looks up whatever the primary-source drivers have ALREADY written — meaning
   the coexistence check happens automatically whenever LegiScan ingestion runs, with zero new
   scheduled job needed for the backfill period. `mo-house-xml`/`mo-senate-web`'s own cadence
   (30-min, ToU-driven) is UNCHANGED by this plan — they were already slow/rare by ToU necessity.
   For `mo-senate-web`/`mo-senate-journal-pdf` the accurate framing post-Task-7 is "primary source
   for its combined-vehicle vote class, cross-check source for everything else LegiScan also
   covers" — not "demoted to audit cadence." For `mo-house-xml`, whether an analogous "future runs
   matter more for cross-checking than first-writing" framing applies is UNKNOWN pending Task 10's
   evidence — not assumed.
3. Bill/vote coexistence itself is guaranteed by the identifier-normalization + session-mapping
   Global Constraints already specified (Tasks 1/4) — a LegiScan-sourced bill for a session/
   identifier a primary-source driver already created lands on the SAME `bills` row (unique
   constraint dedupe), not a duplicate.
4. **Display-time dedup rule for downstream consumers** (CONTROLLER RULING 3 — documented here,
   not coded): the same real-world floor vote may now legitimately exist as TWO rows — a LegiScan
   row and a primary-source row, different `source_key`s, both correctly stored (expected, not a
   bug, once Task 7 confirmed neither source subsumes the other for every case). Rule for whoever
   builds Plan 3's rendering: the primary-source (journal/PDF) row wins for display whenever both
   exist for the same (chamber, date, bill, tallies) — the same correspondence
   `crossCheckAgainstPrimarySource` (Task 6) already computes for its flag rows, so Plan 3 can reuse
   that matching logic rather than re-deriving it. No code change here; the same rule is documented
   as a comment beside `PRIMARY_SOURCE_KEY_PREFIXES` in `src/adapters/legiscan-votes.js`.

- [ ] Update both drivers' header comments (documented policy, per-driver as revised above).
- [ ] `crossCheckAgainstPrimarySource` (already built in Task 6) is exercised end-to-end against
      exactly the synthetic scenario this bullet describes: a `mo-house-xml`-sourced vote row
      exists for a bill LegiScan also covers, tallies deliberately mismatched → flag row lands in
      `vote_reconciliation_flags` with both sources' tallies and the Task-6 caveat note. Already
      covered by Task 6's own test suite (`tests/legiscan-votes.test.js` — the "YEA mismatch" and
      "Present-category caveat" cases both exercise a `mo-house-xml-*`-sourced primary vote row
      against a mismatched LegiScan tally) — confirmed still green here rather than duplicated with
      a redundant Task-8-local test.
- [ ] Document the display-time dedup rule (item 4 above): comment in
      `src/adapters/legiscan-votes.js` beside `PRIMARY_SOURCE_KEY_PREFIXES`.
- [ ] Commit `docs: coexistence policy revised - MO Senate journals stay completeness-critical
      (Task 7 evidence), House exposure unknown pending Task 10, display-dedup rule documented`.

### Task 9: `src/cli/ingest-legiscan.js` — driver

**Files:** Create `src/cli/ingest-legiscan.js`; add `package.json` script `"ingest:legiscan"`;
`tests/ingest-legiscan-cli.test.js` (pure parts: planning, budget gate, dry-run; fake client,
fixture-driven — no network in tests, same convention as every prior CLI test in this repo)

**Interfaces (Consumes):** everything from Tasks 2/4/5/6/7; `getClient/openRun/closeRun/
insertIfAbsent/additivePatch/isMissingColumnError/isMissingRelationError` from `src/lib/db.js`.

**Flow (per run, `--session-id <legiscan_session_id> [--dry-run] [--dataset-file <path>]`):**
1. `openRun(client, SOURCE)`; `getMonthlyQueryUsage` + `assertUnderBudget` BEFORE any live call —
   refuses to start if this run's planned query count would plausibly exceed the configured
   monthly cap (Q2).
2. `decodeDatasetHashGate` against `legiscan_datasets` for the requested session — single-row
   lookup by the `legiscan_session_id` primary key, plain `.select()`, `selectAll` not needed;
   skip `getDataset` entirely on a hash match (mandatory gate, Task 2).
3. Ensure/find the `sessions` row (Task 1's `legiscan_session_id` column; Regular→bare-year
   identifier, Special→derived identifier, per the Global Constraints resolution) — single-row
   lookup by the unique `legiscan_session_id` column, `selectAll` not needed.
4. Decode + parse the dataset (Task 4); for each bill: `insertIfAbsent('bills', ...,
   'session_id,identifier')` with the normalized identifier (Global Constraints); for each
   sponsor/person encountered: `resolveOrCreateLegiscanPerson` (Task 5); for each roll call:
   `reconcileLegiscanTallies` → on pass, `insertIfAbsent('votes', ..., 'source_key')` with
   `buildLegiscanVoteSourceKey` → `crossCheckAgainstPrimarySource` (Task 6) → per-cast
   `VOTE_ID_MAP` + `insertIfAbsent('vote_casts', ..., 'vote_id,legislator_id')`; on reconcile
   failure, the roll call is skipped with an honest count, never stored (same convention as every
   prior parser in this repo).
5. Provenance: every written row's `source_url` is the LegiScan record URL from the payload
   (`bill.url`/`roll_call.url` — real fixture fields, e.g.
   `https://legiscan.com/MO/rollcall/SB894/id/747209`); `ATTRIBUTION` constant (Task 2) rides in
   `closeRun`'s detail.
6. `closeRun` with full counts `{ sessions, bills, people: {matched, created, ambiguous}, votes,
   casts, reconciliationFailures, crossCheckFlags, queriesUsed }`.

- [ ] TDD the pure parts (budget-gate refusal, dry-run planning, dataset-hash-gate skip
      reporting) with fakes; implement; green.
- [ ] Local no-network smoke: `node src/cli/ingest-legiscan.js --dataset-file
      tests/fixtures/research/legiscan/mo-2018-dataset.json --dry-run` → prints the real plan
      (bill/vote/people counts from Task 3's fixture), 0 writes.
- [ ] Commit `feat: legiscan ingest driver - dataset-bulk backfill, budget+hash gated`.

### Task 10: Live bounded backfill slice + verification + docs

- [ ] Live run (bounded, stated count up front — expect ≤3 queries: `decodeDatasetHashGate` skips
      the already-fixture-captured 2018 Special Session's `getDataset`, so this is likely just a
      fresh `getDatasetList` + one NEW small session's `getDataset`) against a second small MO
      session not yet captured, OR replay the Task 3 fixture live end-to-end into a real (non-
      dry-run) DB write if Lance prefers proving the write path over spending a fresh query.
      Report the REAL numbers (bills/votes/casts/flags written).
- [ ] Verify via service-role REST: spot-check Bob Onder's rows (the project's running end-to-end
      example) if he appears in the captured session — confirm `legiscan_people_id` landed on his
      EXISTING `legislators` row (via `mo_senate_id`, from the era-scoped match) rather than
      creating a duplicate, and that this doesn't regress TODO item 8's already-documented
      "expected 2 rows (bioguide/openstates) until identity merge" status — a 3rd row only if the
      era-scoped match genuinely found none, which should log why.
- [ ] Docs: TODO item 0 marked in-progress-live with real numbers; CHATLOG entry; PLAYBOOK
      addition only if something cost real time (per existing convention). Commit `docs: legiscan
      bulk adapter live - dataset-bulk MO backfill path proven`.

### Task 11: Final review + merge

- [ ] Whole-branch review (most capable model, per house convention) → fix wave if needed → merge
      menu to Lance.

## Self-review notes (write time)

- Task count (11) is deliberately larger than the MO Senate plan (6) and the glossary plan (8):
  this adapter's genuinely separate concerns — dataset-ZIP mechanics, a NEW identity-key shape
  with its own coexistence design, votes reconciliation extended with a cross-source cross-check,
  a real substitute-vehicle ambiguity requiring investigation before implementation, and an
  explicit coexistence-policy task — don't compress further without hiding real risk inside a
  bigger task. Comparable in shape to Plan 1's original 10-task scope.
- The dataset_hash gate (binding, suspension-level) gets its OWN isolated, heavily-tested function
  (`decodeDatasetHashGate`, Task 2) before any live `getDataset` wiring — mirrors how the MO
  Senate plan isolated `resolveMoSenator`'s fail-loud contract before wiring it into the driver.
- `legiscan_people_id`'s safety argument (table-wide-unique is fine, UNLIKE `mo_senate_id`) is
  made explicit and tested in Task 5, directly answering this plan's binding requirement not to
  reincarnate the cross-era bug class — the actual risk surface (fuzzy full_name+chamber+district
  matching) is isolated to a one-time mapping step, era-scoped against `terms`, fail-loud on
  ambiguity, never in the cast-resolution hot path.
- Every "new dependency" and "new schema shape" decision this plan couldn't responsibly make
  unilaterally was ruled by the controller (Q1-Q7, `.superpowers/sdd/legiscan-plan-draft-
  notes.md`) rather than left as a silent assumption — all seven rulings are folded into the task
  text and Global Constraints above. Q1 (ZIP-decode dependency) is the one ruling with a real gate
  still open at execution time: the controller RECOMMENDS `yauzl` but a new runtime dependency is
  Lance's call per project precedent — Task 3 is mechanically gated on his explicit approval and
  does not start writing decode code without it (see Task 3 and the Tech Stack line above).
- Every DB read this plan specifies either routes through `selectAll` (`src/lib/db.js:85`) or
  states inline why it doesn't need to — `getMonthlyQueryUsage` (Task 2, the one place an
  unpaginated read would be a live correctness bug), `decodeDatasetHashGate`'s ledger lookup and
  the `sessions` row lookup (Task 9, both single-row PK/unique-column reads), the Q4 special-
  session probe (Task 1, count-only via `{ count: 'exact', head: true }`), and
  `findCandidateLegislatorRows`/`crossCheckAgainstPrimarySource` (Tasks 5/6, both narrow-filter-
  bounded to a handful of rows) — the 1000-row-cap lesson from `auto-publish-glossary.js`/
  `gloss.js`/`review/server.js` does not reincarnate here either.
- Zero Anthropic API calls confirmed across all 11 tasks — this is a plain ingestion plan; no
  `GOLDEN_CHECK_APPROVED`-style gate is needed anywhere in it.
