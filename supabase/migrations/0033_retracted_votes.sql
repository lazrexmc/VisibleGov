-- 0033 (draft — Lance applies). Tombstone table for RETRACTED votes: rows that were stored against
-- a bill that never held that vote.
--
-- WHY THIS IS NOT vote_duplicates (0022). That table marks a redundant record of a vote that really
-- happened on that bill, and the fix is to hide one copy. This is a different defect: the vote row
-- carries the WRONG bill_id. Hiding it would leave the false bill<->vote relationship queryable by
-- anything that does not join perfectly against the exclusion, and the row would still assert, in
-- the base table, that a bill held a vote it never held. The relationship has to go.
--
-- WHY A TOMBSTONE AND NOT A BARE DELETE. This project's posture is that nothing is destroyed and
-- everything is traceable (persons/person_links, 0012: "source rows are never deleted or rewritten").
-- A straight delete would leave a future audit unable to answer "what happened to those LegiScan
-- roll calls?" — and would make the operation irreversible if the retraction rule itself turns out
-- to be wrong. That is not hypothetical: earlier on 2026-08-26 a dedup rule was applied to
-- production and 17 of its 38 pairings were false. Recovery was possible only because that design
-- was non-destructive. This table is the same insurance, and it goes further: the FULL cast list is
-- preserved as jsonb, so a retraction can be replayed backwards row-for-row.
--
-- THE DEFECT IT EXISTS FOR (measured live 2026-08-26): LegiScan's 2023 MO dataset mints a separate
-- roll_call_id per bill for one physical House floor vote. Three HB 10 roll calls are each stored
-- 232 times against 232 different bills, with full cast lists — 693 phantom vote rows and 112,728
-- redundant casts. 196 bills currently display ONLY votes that were never cast on them, 47 of them
-- carrying a published summary and listed in the public /bills index.

create table retracted_votes (
  id                  uuid primary key default gen_random_uuid(),
  -- Deliberately NOT a foreign key to votes(id): the whole point is that the votes row is gone.
  -- The id is kept so an audit can correlate with anything that logged it before the retraction.
  vote_id             uuid not null,
  bill_id             uuid,
  bill_identifier     text,
  jurisdiction_id     text,
  chamber             text,
  vote_date           timestamptz,
  question            text,
  result              text,
  source_url          text,
  source_key          text not null,
  -- The complete cast list: [{legislator_id, position}, ...]. This is what makes a retraction
  -- reversible rather than merely explained.
  casts               jsonb not null,
  cast_count          integer not null,
  -- Why this row went. Carries the manifest entry that justified it: the finding, the confidence
  -- level, the rationale, which row was kept and on what evidence.
  reason              text not null,
  evidence            jsonb not null,
  retracted_at        timestamptz not null default now(),
  run_id              uuid
);

-- One retraction per vote row. Makes the retraction script safe to re-run: an already-retracted
-- row is a no-op conflict, never a second tombstone.
create unique index retracted_votes_vote_id_key on retracted_votes (vote_id);
create index retracted_votes_source_url_idx on retracted_votes (source_url);
create index retracted_votes_bill_id_idx on retracted_votes (bill_id);

-- Internal QA ledger, exactly like vote_reconciliation_flags (0010) and vote_duplicates (0022):
-- RLS on, no anon grant. Its EFFECT is public (the bad rows stop being served); its contents are
-- not. Nothing in site/ reads it. Kept owner-only so a future public "what we removed and why"
-- surface is a deliberate decision with its own view, not an accident of a missing policy.
alter table retracted_votes enable row level security;

comment on table retracted_votes is
  'Votes deleted because they were attached to a bill that never held them (distinct from '
  'vote_duplicates, which hides a redundant copy of a real vote on the right bill). Preserves the '
  'full cast list so any retraction can be replayed backwards. Written by '
  'scripts/retract-misattributed-votes.mjs from the manifest produced by '
  'scripts/find-misattributed-votes.mjs.';
