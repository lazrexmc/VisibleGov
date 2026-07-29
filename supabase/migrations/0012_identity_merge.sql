-- Draft (Lance applies — draft-then-apply). Identity merge, VIRTUAL model per the approved
-- design (docs/superpowers/specs/2026-07-29-identity-merge-design.md, Lance 2026-07-29):
-- source legislator rows are never deleted or rewritten; a person groups them at read time.
-- A wrong link is one UPDATE to undo; per-source provenance is permanent.

create table persons (
  id                  uuid primary key default gen_random_uuid(),
  -- Mechanical, never invented: highest-authority source's printed name wins
  -- (bioguide > state roster > legiscan > openstates); the winner is recorded beside it.
  display_name        text not null,
  display_name_source text not null check (display_name_source in ('bioguide','mo_senate','mo_house','legiscan','openstates')),
  created_at          timestamptz default now()
);

-- Additive grouping column. NULL = not yet linked; an unlinked row behaves as a single-row
-- person at read time (Plan 3 contract), so rollout is incremental and nothing breaks.
alter table legislators add column person_id uuid references persons(id);
create index legislators_person_id_idx on legislators (person_id) where person_id is not null;

-- Audit trail: one row per linked legislator row, carrying the evidence that justified the
-- link and who decided ('auto' = the matcher's high-confidence path; 'lance' = adjudicated).
-- unique(legislator_id): a source row belongs to at most one person, ever.
create table person_links (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references persons(id),
  legislator_id uuid not null references legislators(id) unique,
  evidence      jsonb not null,
  decided_by    text not null check (decided_by in ('auto','lance')),
  run_id        uuid,
  created_at    timestamptz default now()
);

-- Ambiguity queue: the matcher links NOTHING when a cluster is ambiguous (wrong-merge is the
-- unacceptable error class); the cluster lands here with its evidence for Lance's side-by-side
-- review. resolved=true once adjudicated (either linked via the review tab, which writes
-- persons/person_links with decided_by='lance', or ruled keep-separate).
create table identity_flags (
  id                       uuid primary key default gen_random_uuid(),
  cluster_key              text not null unique,
  candidate_legislator_ids uuid[] not null,
  evidence                 jsonb not null,
  resolved                 boolean not null default false,
  run_id                   uuid,
  created_at               timestamptz default now()
);

-- RLS: persons is public data (the grouping IS the public profile identity); the audit trail
-- and ambiguity queue are internal (service-role only — no anon policies; revisit receipts
-- exposure when Plan 3 designs public provenance display).
alter table persons enable row level security;
alter table person_links enable row level security;
alter table identity_flags enable row level security;
create policy anon_read_persons on persons for select using (true);
