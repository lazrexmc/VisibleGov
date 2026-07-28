-- Draft (Lance applies — draft-then-apply). Referenced-context glossary (design approved by
-- Lance 2026-07-28, docs/superpowers/specs/2026-07-28-glossary-design.md, approach A+C hybrid).
--
-- Bills reference statutes/acts/agencies/programs the reader is assumed to already know
-- ("Sec. 1903 of the Social Security Act"). glossary_terms holds a 1-2 sentence gloss for each,
-- written FROM the term's own official source text (uscode.house.gov / govinfo.gov / the
-- existing Congress.gov adapter) and adversarially verified the same way summaries are — never
-- from model training knowledge (PLAYBOOK: never let an LLM assert content that isn't grounded
-- in a real, queryable source-of-record). summary_terms links a summary to the terms it
-- references. glossary_verifications and glossary_notes mirror summary_verifications (0004) and
-- summary_notes (0003) exactly, one row per glossary term instead of per summary, so Tasks 5-6
-- (gloss verification + review-page adjudication) have the same staff-review trail summaries
-- already have.
--
-- Until this is applied, the gloss-generation pipeline (Tasks 2-4) has no table to write to;
-- it degrades gracefully — see those tasks' own reports for exactly what that looks like.

create table glossary_terms (
  id             uuid primary key default gen_random_uuid(),
  term           text not null,              -- display name, e.g. 'Social Security Act, Sec. 1903'
  kind           text not null check (kind in ('statute','act','agency','program','public_law')),
  citation       text,                       -- normalized cite, e.g. '42 U.S.C. 1396b'
  gloss_md       text,                       -- the 1-2 sentence plain-language explanation
  -- Fix round 2 (Task 5 review, promoted Minor finding): the author model's claimed supporting
  -- quote from the source excerpt (GLOSS_SCHEMA.supported_by_quote in glosser.js) — displayed
  -- alongside gloss_md at review time so a human adjudicator can check the quote against the
  -- gloss without re-opening the source. Nullable like gloss_md itself (co-arrives with it, same
  -- Task-4-stub-then-Task-5-fills-in lifecycle) and deliberately NOT part of the
  -- glossary_terms_published_complete check below — it always co-arrives with gloss_md in the
  -- same write, so a separate gate on it would be redundant.
  supported_by_quote text,
  -- Nullable, NOT "not null": Task 4 inserts a bare STUB row here the moment a bill references a
  -- term (term/kind/citation only, status='draft') — it has no source to cite yet. Task 5's gloss
  -- stage is what fetches the term's primary text and fills these in (alongside gloss_md). A
  -- column-level not null here would make every Task-4 stub insert fail; the real integrity
  -- guarantee — nothing bare-sourced may ever reach 'published' — lives in the check constraint
  -- below instead, at the boundary that actually matters.
  source_url     text,                       -- the official text it was written from
  source_hash    text,                       -- sha256 of the fetched source excerpt
  status         text not null default 'draft' check (status in ('draft','approved','published','rejected','stale')),
  model          text, prompt_version text, run_id uuid,
  created_at     timestamptz default now(), published_at timestamptz,
  -- design-consistent addition (not in the original design doc's SQL block): some citations
  -- parseCitation can't resolve to a fetchable source (no guessing at a URL) — this flags them
  -- for a human to map manually instead of silently dropping or fabricating a source_url.
  needs_mapping  boolean default false,
  unique (kind, citation),
  -- Lifecycle this constraint enforces: Task 4 creates bare stubs (term/kind/citation only,
  -- status='draft', source_url/source_hash/gloss_md all NULL) → Task 5 fetches the term's
  -- official source and writes gloss_md + source_url + source_hash → Task 6's review page lets
  -- Lance adjudicate (approve/reject) → publish. A stub may sit bare indefinitely waiting on
  -- Task 5 — that's expected, not an error. What's never allowed, at any point in that lifecycle,
  -- is a 'published' row with a missing source or gloss: the public-facing status is the one
  -- boundary that must be fully grounded, so it's the one thing this constraint gates.
  constraint glossary_terms_published_complete check (
    status <> 'published' or (source_url is not null and source_hash is not null and gloss_md is not null)
  )
);

-- Postgres treats NULL as distinct from NULL under a unique constraint, so `unique (kind,
-- citation)` above does NOT dedupe rows with the same kind and an unmapped (NULL) citation —
-- every referencing bill would mint a fresh glossary_terms row for the same unmapped term,
-- defeating the write-once/reuse cost model the design relies on (popular-name-only terms like
-- a commonly cited act with no resolved U.S.C. cite yet). `NULLS NOT DISTINCT` was considered
-- and rejected: it would collapse ALL same-kind rows with NULL citation into one slot, which
-- would incorrectly merge unrelated acts that both happen to be unmapped. Instead, dedupe on
-- (kind, term) specifically for the unmapped case, so distinct unmapped terms of the same kind
-- stay distinct while a repeat of the exact same unmapped term collapses to one row.
create unique index glossary_terms_unmapped_uidx on glossary_terms (kind, term) where citation is null;

create table summary_terms (
  summary_id uuid not null references summaries(id),
  term_id    uuid not null references glossary_terms(id),
  primary key (summary_id, term_id)
);

-- Same shape as summary_verifications (0004), term_id in place of summary_id: the adversarial
-- verifier attempts to refute each gloss sentence against the fetched source excerpt alone.
create table glossary_verifications (
  id             uuid primary key default gen_random_uuid(),
  term_id        uuid not null references glossary_terms(id),
  verdicts       jsonb not null,
  overall        text not null check (overall in ('clean','flagged')),
  model          text not null,
  prompt_version text not null,
  created_at     timestamptz default now()
);

-- Same shape as summary_notes (0003), term_id in place of summary_id: Lance's adjudication
-- trail for glosses on the review page (approve/edit/reject/publish), same action enum.
create table glossary_notes (
  id         uuid primary key default gen_random_uuid(),
  term_id    uuid not null references glossary_terms(id),
  note       text not null,
  action     text not null check (action in ('approved','edited','rejected','published')),
  created_at timestamptz default now()
);

alter table glossary_terms         enable row level security;
alter table summary_terms          enable row level security;
alter table glossary_verifications enable row level security;
alter table glossary_notes         enable row level security;

-- anon reads published glosses only — same posture as summaries (0001): a draft/rejected gloss
-- hasn't been through adjudication yet and isn't a claim VisibleGov is ready to stand behind.
create policy anon_read_published on glossary_terms for select using (status = 'published');

-- anon reads all summary_terms rows: it's a join table of two ids, harmless on its own (the
-- glossary_terms RLS policy above is what actually gates whether the linked term is visible).
create policy anon_read on summary_terms for select using (true);

-- deliberately NO anon policy: service role (review server) only, same posture as
-- summary_verifications in 0004 — verification detail (raw model reasoning, quotes) is a staff
-- review tool, not a public-facing claim in its own right.

-- deliberately NO anon policy: service role (review server) only, same posture as summary_notes
-- in 0003 — the editorial adjudication trail is staff-only, not a public-facing claim.
