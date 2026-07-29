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
--
-- Pre-migration probe (Q4 ruling, task-1-brief step 1-2, run live against prod 2026-07-28):
-- found 3 MO sessions rows total (identifiers '2018', '2022', '261') — '261' does NOT match the
-- bare-year pattern, but it is NOT a special-session encoding: it is mo-house-xml.js's own
-- MO_HOUSE_SESSION_ID ('2026 2nd Regular, 103rd General Assembly' — an explicitly REGULAR
-- session), a pre-existing, unrelated identifier convention that ingest-mo-house.js has used
-- since before this plan (session ID, not a bare year, not OpenStates-derived). Grep of
-- src/adapters/mo-house-xml.js and src/cli/ingest-mo-senate.js confirms neither driver has any
-- session-type (special/regular/session_tag) filter — both are general-purpose over whatever
-- sessions rows exist, so neither has ever had the opportunity to create an actual special-session
-- row. Net: no existing special-session row, no session-type filter — the two literal STOP
-- conditions are both negative, so this migration proceeds unchanged. (Full probe output and the
-- '261' coexistence caveat for future Task 9 are recorded in this task's report, not repeated
-- here — see task-1-report.md.)
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
