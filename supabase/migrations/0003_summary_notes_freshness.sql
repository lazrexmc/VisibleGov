-- 0003: editor notes become staff-only (facts-only directive: nothing editorial is public),
-- and ingestion_runs.detail (operational strings) leaves the anon surface.

-- CONTROLLER ADDITION: update summaries.status constraint to allow 'approved' status
alter table summaries drop constraint summaries_status_check;
alter table summaries add constraint summaries_status_check
  check (status in ('draft','approved','published','rejected','stale'));

create table summary_notes (
  id         uuid primary key default gen_random_uuid(),
  summary_id uuid not null references summaries(id),
  note       text not null,
  action     text not null check (action in ('approved','edited','rejected','published')),
  created_at timestamptz default now()
);
alter table summary_notes enable row level security;
-- deliberately NO anon policy: service role only.

alter table summaries drop column editor_notes;

drop policy anon_read on ingestion_runs;
-- Owner-defined view (bypasses RLS by design — it exposes ONLY safe aggregate columns).
create view ingestion_freshness as
  select source, max(finished_at) as last_success
  from ingestion_runs
  where status in ('succeeded','partial')
  group by source;
grant select on ingestion_freshness to anon;
