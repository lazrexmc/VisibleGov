-- 0039: move the parked-bill set out of a gitignored JSON file and into the database.
--
-- WHAT IS PARKED, AND WHY IT IS EXPENSIVE TO LOSE. A "parked" bill is one the summary chain has
-- failed on three times for a STRUCTURAL reason — an emergency clause with no operative text, a
-- short-title-only bill, an appropriation whose provisions cannot be covered without inventing
-- them. Parking is the decision to stop paying for retries that will not succeed (PLAYBOOK 38).
-- Each of the 31 current entries therefore represents THREE exhausted billed attempts, and the
-- reason string is the evidence for why a fourth would waste money too.
--
-- WHERE IT LIVES TODAY: `.superpowers/artifacts/scheduled-summaries/parked.json`, which
-- `.gitignore:13` excludes. So it exists on exactly one machine, is in no backup, and
-- `docs/DISASTER_RECOVERY.md` does not mention it at all (grep: zero hits). A rebuild from a bare
-- clone comes up with an EMPTY parked set and the daily scheduler — which is billed — begins
-- re-attempting 31 bills already proven to fail. The failure is silent: nothing errors, the
-- scheduler just quietly spends again on known-bad work.
--
-- CORRECTING THE URGENCY, because it was reported to me as a cutover blocker and it is not.
-- `scripts/scheduled-summaries.js` is NOT part of the GitHub Actions migration — it stays on
-- Windows Task Scheduler (verified: it appears in no workflow file), so parked.json remains
-- readable by the only thing that consumes it. The cutover does not break this.
--
-- What this actually is: a DISASTER-RECOVERY gap, plus a blocker for a migration that has not
-- happened yet. It becomes urgent the day `scheduled-summaries.js` moves to Actions, and it is
-- already true that the machine dying loses 31 paid-for decisions. That is worth a table; it is
-- not worth rushing ahead of Lance's cutover.
--
-- SHAPE. One row per parked bill. `bill_id` is the natural key and is UNIQUE — parking a bill twice
-- is not a thing, and a second park should update the reason rather than duplicate the row.
-- ON DELETE CASCADE because a parked bill that no longer exists is not a park worth keeping.
--
-- `reason` is NOT NULL and deliberately free text: it is the evidence a human reads when deciding
-- whether a class can be unparked, and constraining it to codes would lose exactly the detail that
-- makes that decision possible. `source` records WHICH pass parked it (a drain-lane seed, the
-- scheduler itself), so a whole seeding pass can be unparked as a class.
--
-- INTERNAL, like ingestion_runs and legiscan_datasets: RLS on, and NO grant to anon. Migrations
-- 0036/0037 exist because three tables had their policy dropped while an older GRANT survived, so
-- the protection here is stated at the privilege layer from the start rather than left to an
-- absent policy. `scripts/probe-public-surface.js` will confirm anon gets 401, not `200 []`.
--
-- APPLYING THIS ALONE IS SAFE AND CHANGES NOTHING. It creates an empty table that no code reads
-- yet. The data move and the code cutover are deliberately separate:
--   1. this migration                         (Lance applies)
--   2. node --env-file=.env scripts/migrate-parked-to-ledger.mjs           (dry run)
--   3. node --env-file=.env scripts/migrate-parked-to-ledger.mjs --apply   (copies the 31 rows)
--   4. only then does scheduled-summaries.js switch to reading the table
-- Reversing that order would have the live billed scheduler read a table that is empty or absent,
-- which is precisely the "empty parked set" failure this migration exists to prevent.
--
-- VERIFY AFTER APPLYING:
--   npm run verify:migrations     -- the 0039 row must read OK
--
-- Draft-then-apply: Lance applies.

create table if not exists parked_bills (
  bill_id     uuid primary key references bills(id) on delete cascade,
  reason      text        not null,
  parked_at   timestamptz not null default now(),
  source      text,
  created_at  timestamptz not null default now()
);

comment on table parked_bills is
  'Bills the summary chain has stopped retrying for a structural reason. Each row represents three '
  'exhausted billed attempts; the reason is the evidence for why a fourth would also fail. Moved '
  'here from a gitignored JSON file so it survives a rebuild and is available wherever the '
  'scheduler runs.';

-- The scheduler asks "is this bill parked?" per candidate, and the operator asks "how many are
-- parked, and by which pass?". The primary key covers the first; this covers the second.
create index if not exists parked_bills_source_idx on parked_bills (source);

alter table parked_bills enable row level security;

-- No policy and no anon grant, deliberately: this is internal operational state with no public
-- surface. Stated at the privilege layer rather than left to an absent policy — that distinction
-- is the whole content of migrations 0036 and 0037.
revoke all on parked_bills from anon;
revoke all on parked_bills from authenticated;
grant select, insert, update, delete on parked_bills to service_role;
