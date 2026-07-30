-- Draft (Lance applies — draft-then-apply). Bill sponsorship: the "bills they propose" half of
-- the founding vision (profiles show votes AND sponsored bills). One row per (bill, legislator)
-- sponsorship; sponsor_type distinguishes the introducing sponsor from cosponsors.
--
-- Sources: MO from the LegiScan cached dataset archives (people_id -> legislators via
-- legiscan_people_id, exact key only); federal from Congress.gov bill details (bioguide_id ->
-- legislators, exact key only). Unmatched sponsors are honestly counted and skipped, never
-- guess-matched — same discipline as every identity path in this codebase.
--
-- DESIGN FREEZE (two-steps-ahead ruling, 2026-07-29): identity keying for states beyond
-- Missouri rides legiscan_people_id + the terms table. No new per-state identity columns
-- (mo_senate_id/mo_house_id-style) will be added for future states — those two exist for the
-- primary-source MO pipelines that predate LegiScan and are the LAST of their kind.

create table bill_sponsors (
  id            uuid primary key default gen_random_uuid(),
  bill_id       uuid not null references bills(id),
  legislator_id uuid not null references legislators(id),
  sponsor_type  text not null check (sponsor_type in ('primary','cosponsor')),
  run_id        uuid,
  created_at    timestamptz default now(),
  unique (bill_id, legislator_id)
);

-- Display table: the public site reads sponsorship anonymously, like bills/votes/vote_casts.
alter table bill_sponsors enable row level security;
create policy anon_read_bill_sponsors on bill_sponsors for select using (true);
