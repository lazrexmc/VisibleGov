-- 0004: adversarial verification pass (trust-model v2, Lance 2026-07-27). A claude-sonnet-5
-- verifier attempts to REFUTE each bullet of an opus-5-authored summary against its cited
-- section; flags surface on the review page.

create table summary_verifications (
  id             uuid primary key default gen_random_uuid(),
  summary_id     uuid not null references summaries(id),
  verdicts       jsonb not null,
  overall        text not null check (overall in ('clean','flagged')),
  model          text not null,
  prompt_version text not null,
  created_at     timestamptz default now()
);
alter table summary_verifications enable row level security;
-- deliberately NO anon policy: service role (review server) only, same posture as summary_notes
-- in 0003 — verification detail (raw model reasoning, quotes) is a staff review tool, not a
-- public-facing claim in its own right.
