-- VisibleGov core schema. RLS is the wall: anon may read public rows only;
-- the ingestion CLI writes with the service role (bypasses RLS by design).

create table jurisdictions (
  id   text primary key,          -- 'us-congress' | 'mo-legislature'
  name text not null
);

create table sessions (
  id              uuid primary key default gen_random_uuid(),
  jurisdiction_id text not null references jurisdictions(id),
  identifier      text not null,  -- '119' for Congress; OpenStates session key for MO
  name            text,
  start_date      date,
  end_date        date,
  unique (jurisdiction_id, identifier)
);

create table legislators (
  id            uuid primary key default gen_random_uuid(),
  full_name     text not null,
  bioguide_id   text unique,      -- federal identity key
  openstates_id text unique,      -- MO identity key
  party         text,
  image_url     text,
  contact       jsonb,
  run_id        uuid
);

create table terms (
  id              uuid primary key default gen_random_uuid(),
  legislator_id   uuid not null references legislators(id),
  jurisdiction_id text not null references jurisdictions(id),
  chamber         text not null check (chamber in ('house','senate')),
  district        text,
  party           text,
  start_date      date,
  end_date        date,
  run_id          uuid,
  unique (legislator_id, jurisdiction_id, chamber, district, start_date)
);

create table bills (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references sessions(id),
  identifier    text not null,    -- 'HR 22', 'SB 4'
  title         text,
  status        text,             -- lifecycle stage; refined in later slices
  canonical_url text,             -- official record link
  run_id        uuid,
  unique (session_id, identifier)
);

create table bill_actions (
  id             uuid primary key default gen_random_uuid(),
  bill_id        uuid not null references bills(id),
  action_date    date not null,
  description    text not null,
  classification text,
  run_id         uuid,
  unique (bill_id, action_date, description)
);

create table bill_texts (
  id           uuid primary key default gen_random_uuid(),
  bill_id      uuid not null references bills(id),
  version      text not null,
  content      text,
  content_hash text,
  source_url   text,
  retrieved_at timestamptz,
  run_id       uuid,
  unique (bill_id, version)
);

create table votes (
  id              uuid primary key default gen_random_uuid(),
  bill_id         uuid references bills(id),   -- nullable: some votes are procedural
  jurisdiction_id text not null references jurisdictions(id),
  chamber         text not null check (chamber in ('house','senate')),
  vote_date       timestamptz,
  question        text,
  result          text,
  source_url      text,
  source_key      text not null unique,        -- dedupe key, e.g. 'us-house-119-2025-123'
  run_id          uuid
);

create table vote_casts (
  id            uuid primary key default gen_random_uuid(),
  vote_id       uuid not null references votes(id),
  legislator_id uuid not null references legislators(id),
  position      text not null check (position in ('yea','nay','present','not_voting','absent','other')),
  run_id        uuid,
  unique (vote_id, legislator_id)
);

create table summaries (
  id             uuid primary key default gen_random_uuid(),
  bill_id        uuid not null references bills(id),
  status         text not null default 'draft' check (status in ('draft','published','rejected','stale')),
  body_md        text,
  model          text,
  prompt_version text,
  bill_text_hash text,
  editor_notes   text,
  run_id         uuid,
  created_at     timestamptz default now(),
  published_at   timestamptz
);

create table ingestion_runs (
  id          uuid primary key default gen_random_uuid(),
  source      text not null,
  status      text not null check (status in ('running','succeeded','partial','failed')),
  detail      jsonb,
  started_at  timestamptz default now(),
  finished_at timestamptz
);

create table districts (
  id              uuid primary key default gen_random_uuid(),
  jurisdiction_id text not null references jurisdictions(id),
  chamber         text not null check (chamber in ('house','senate')),
  district        text not null,
  legislator_id   uuid references legislators(id),
  unique (jurisdiction_id, chamber, district)
);

-- RLS: everything readable EXCEPT unpublished summaries; nothing writable by anon.
alter table jurisdictions  enable row level security;
alter table sessions       enable row level security;
alter table legislators    enable row level security;
alter table terms          enable row level security;
alter table bills          enable row level security;
alter table bill_actions   enable row level security;
alter table bill_texts     enable row level security;
alter table votes          enable row level security;
alter table vote_casts     enable row level security;
alter table summaries      enable row level security;
alter table ingestion_runs enable row level security;
alter table districts      enable row level security;

create policy anon_read on jurisdictions  for select using (true);
create policy anon_read on sessions       for select using (true);
create policy anon_read on legislators    for select using (true);
create policy anon_read on terms          for select using (true);
create policy anon_read on bills          for select using (true);
create policy anon_read on bill_actions   for select using (true);
create policy anon_read on bill_texts     for select using (true);
create policy anon_read on votes          for select using (true);
create policy anon_read on vote_casts     for select using (true);
create policy anon_read on districts      for select using (true);
create policy anon_read_published on summaries for select using (status = 'published');
create policy anon_read on ingestion_runs for select using (true); -- powers the freshness footer
