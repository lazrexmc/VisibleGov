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

