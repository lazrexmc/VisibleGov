# Cross-Adapter Vote Duplicate Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the never-built "primary-source row wins for display" ruling: mark legitimate
cross-adapter vote duplicates (LegiScan vs. MO's own primary-source adapters) additively, then
exclude the superseded row from every public-facing read — vote lists AND the vote-aggregate
matview percentages, which currently double-count them.

**Architecture:** A new grouping table (`vote_duplicates`) records which `votes` row is superseded
by which, following this codebase's own non-destructive `persons`/`person_links` precedent — no
row is ever deleted or rewritten. Detection reuses the existing, already-tested
`crossCheckAgainstPrimarySource` matching logic (extended to report the matched primary row's id),
wired into live ingest going forward and a one-time backfill correction for the existing backlog.
Three read paths (`public_vote_feed`, the three vote-aggregate matviews, and a new `public_votes`
view for the bill page) all exclude superseded rows from the same table.

**Tech Stack:** Postgres/Supabase (migration, views, materialized views), Node.js (ingest CLI,
correction CLI), vanilla JS ES modules (site), `node --test`.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-03-vote-duplicate-dedup-design.md`.
- **The migration is draft-then-apply. Do not run it against any live database — write the file only.**
- **Never delete or rewrite an existing `votes`/`vote_casts` row.** `vote_duplicates` is purely additive; both rows in a marked pair stay exactly as they are.
- **`crossCheckAgainstPrimarySource`'s existing behavior for every non-`tally_unique_match` branch (flags, quarantine, `corresponds_to_sibling`) is unchanged** — only the two clean-match return statements gain one new field.
- **Reuse `crossCheckAgainstPrimarySource` for detection everywhere — never a second, hand-rolled comparison.** This applies to both the live-ingest wiring (Task 3) and the backfill correction (Task 4).
- The combined-vehicle mechanism (`docs/research/2026-07-29-legiscan-substitute-vehicles.md`) is a different problem at a different layer — this plan never touches it.
- Gate every commit on the extracted `node --test` fail-count (`ℹ fail N` line), never a pipeline's exit status.
- `node --test` runs from the repo root, never with a directory argument.
- No LLM/API calls anywhere in this feature.

---

### Task 1: Migration — `vote_duplicates` table, `public_vote_feed` exclusion, new `public_votes` view, matview exclusion

**Files:**
- Create: `supabase/migrations/0022_vote_duplicates.sql`

**Interfaces:**
- Produces: `vote_duplicates(id, canonical_vote_id, superseded_vote_id, superseded_vote_id unique, reason, created_at)`, consumed by Task 3 (ingest wiring) and Task 4 (backfill) as an insert target, and by this same migration's own view/matview definitions as an exclusion join.

No `node --test` coverage for this task (SQL only, this repo's tests never touch a live DB) — verified by Task 6's `probe-public-surface.js` extension once Lance applies it live.

- [ ] **Step 1: Write the migration file**

```sql
-- 0022 (draft — Lance applies). Cross-adapter vote duplicate dedup (docs/superpowers/specs/
-- 2026-08-03-vote-duplicate-dedup-design.md): implements CONTROLLER RULING 3
-- (docs/superpowers/plans/2026-07-29-legiscan-bulk-adapter.md:604-609) — "the primary-source
-- (journal/PDF) row wins for display whenever both exist for the same (chamber, date, bill,
-- tallies)" — never built until now. Both LegiScan and MO's own primary-source adapters can
-- legitimately each write their own `votes` row for the same real floor vote; this migration adds a
-- non-destructive way to mark one the winner and exclude the other from every public read, without
-- ever deleting or rewriting either row.
--
-- Non-destructive precedent this mirrors: persons/person_links (migration 0012) — "source
-- legislator rows are never deleted or rewritten; a person groups them at read time." Same here:
-- both votes rows stay forever, fully traceable. This is explicitly NOT the codebase's one
-- sanctioned delete (retractLegiscanVoteIfStored, src/cli/ingest-legiscan.js) — that function is
-- scoped to genuine LegiScan-vs-primary CONTRADICTIONS and throws if called on anything else; this
-- table is for legitimately AGREEING duplicates, a different case, never conflated.

create table vote_duplicates (
  id                 uuid primary key default gen_random_uuid(),
  canonical_vote_id  uuid not null references votes(id),
  superseded_vote_id uuid not null unique references votes(id),
  reason             text not null,
  created_at         timestamptz default now()
);
-- No anon-facing grant on this table itself — it's an internal marking table. The three consumers
-- below expose its EFFECT (exclusion), never its own rows, matching this schema's existing
-- "the view is the policy" posture for internal tables (e.g. summary_verifications, 0004).

-- public_vote_feed (0016_public_read_surface.sql): add the exclusion. Everything else about this
-- view is UNCHANGED from 0016's own definition.
drop view if exists public_vote_feed;
create view public_vote_feed with (security_invoker = true) as
select
  vc.id            as cast_id,
  vc.legislator_id,
  vc.position,
  v.id             as vote_id,
  v.vote_date,
  v.chamber,
  v.question,
  v.result,
  v.source_url,
  v.jurisdiction_id,
  b.id             as bill_id,
  b.identifier     as bill_identifier,
  b.title          as bill_title,
  b.session_id
from vote_casts vc
join votes v on v.id = vc.vote_id
left join bills b on b.id = v.bill_id
left join vote_duplicates vd on vd.superseded_vote_id = v.id
where vd.id is null;
grant select on public_vote_feed to anon, authenticated;

-- public_votes: a new view for site/js/bill-page.js, which queries the raw `votes` table directly
-- today (not through any view) — the one consumer that needs a new access path. Same columns
-- bill-page.js's own VOTES_SELECT already asks for, plus the same exclusion. votes' own existing
-- direct anon grant is left untouched (known residual, spec §4 — out of scope to audit every other
-- consumer of that grant here).
create view public_votes with (security_invoker = true) as
select
  v.id, v.bill_id, v.jurisdiction_id, v.chamber, v.vote_date, v.question, v.result,
  v.source_url, v.source_key
from votes v
left join vote_duplicates vd on vd.superseded_vote_id = v.id
where vd.id is null;
grant select on public_votes to anon, authenticated;

-- The three vote-aggregate matviews (0018_vote_aggregates.sql): same exclusion added to each base
-- join chain. This is the half of the fix that corrects the actual double-counted percentages, not
-- just a display list. Recreated in full (materialized views can't be ALTERed to add a join) —
-- every other column/grouping/index/grant below is IDENTICAL to 0018's own definition, only the
-- join chain changes.
drop view if exists public_position_totals cascade;
drop materialized view if exists public_position_totals cascade;
create materialized view public_position_totals as
select
  vc.legislator_id,
  v.jurisdiction_id,
  v.chamber,
  date_part('year', v.vote_date)::int as year,
  vc.position,
  case l.party
    when 'R' then 'Republican'
    when 'D' then 'Democratic'
    when 'I' then 'Independent'
    else l.party
  end as party,
  count(*)::int as casts
from vote_casts vc
join votes v on v.id = vc.vote_id
join legislators l on l.id = vc.legislator_id
left join vote_duplicates vd on vd.superseded_vote_id = v.id
where vd.id is null
group by 1, 2, 3, 4, 5, 6;

create unique index public_position_totals_uq
  on public_position_totals (legislator_id, jurisdiction_id, chamber, year, position);
grant select on public_position_totals to anon, authenticated;

drop view if exists public_party_alignment cascade;
drop materialized view if exists public_party_alignment cascade;
create materialized view public_party_alignment as
with caster_casts as (
  select
    vc.vote_id,
    vc.legislator_id,
    vc.position,
    case l.party
      when 'R' then 'Republican'
      when 'D' then 'Democratic'
      when 'I' then 'Independent'
      else l.party
    end as party,
    v.vote_date,
    v.chamber
  from vote_casts vc
  join legislators l on l.id = vc.legislator_id
  join votes v on v.id = vc.vote_id
  left join vote_duplicates vd on vd.superseded_vote_id = v.id
  where vc.position in ('yea', 'nay') and vd.id is null
),
normalized_casts as (
  select * from caster_casts where party in ('Republican', 'Democratic', 'Independent')
),
party_tallies as (
  select
    vote_id,
    party,
    count(*) filter (where position = 'yea')::int as party_yea,
    count(*) filter (where position = 'nay')::int as party_nay
  from normalized_casts
  group by vote_id, party
),
party_majority as (
  select
    vote_id,
    party,
    party_yea,
    party_nay,
    case
      when party_yea > party_nay then 'yea'
      when party_nay > party_yea then 'nay'
      else null
    end as majority_position
  from party_tallies
)
select
  cc.legislator_id,
  date_part('year', cc.vote_date)::int as year,
  cc.chamber,
  count(*)::int as comparable,
  count(*) filter (where cc.position = pm.majority_position)::int as matched
from normalized_casts cc
join party_majority pm on pm.vote_id = cc.vote_id and pm.party = cc.party
where pm.majority_position is not null
  and (pm.party_yea + pm.party_nay) > 1
group by cc.legislator_id, date_part('year', cc.vote_date)::int, cc.chamber;

create unique index public_party_alignment_uq
  on public_party_alignment (legislator_id, year, chamber);
grant select on public_party_alignment to anon, authenticated;

drop materialized view if exists public_party_position_totals cascade;
create materialized view public_party_position_totals as
with normalized as (
  select
    case l.party
      when 'R' then 'Republican'
      when 'D' then 'Democratic'
      when 'I' then 'Independent'
      else l.party
    end as party,
    v.jurisdiction_id,
    v.chamber,
    v.vote_date,
    vc.position
  from vote_casts vc
  join votes v on v.id = vc.vote_id
  join legislators l on l.id = vc.legislator_id
  left join vote_duplicates vd on vd.superseded_vote_id = v.id
  where vd.id is null
)
select
  party,
  jurisdiction_id,
  chamber,
  date_part('year', vote_date)::int as year,
  position,
  count(*)::int as casts
from normalized
where party in ('Republican', 'Democratic', 'Independent')
group by 1, 2, 3, 4, 5;

create unique index public_party_position_totals_uq
  on public_party_position_totals (party, jurisdiction_id, chamber, year, position);
grant select on public_party_position_totals to anon, authenticated;

-- refresh_vote_aggregates (0018): UNCHANGED — recreated here only because CREATE OR REPLACE FUNCTION
-- must follow its dependent matviews being recreated above, not because its own body changed.
create or replace function refresh_vote_aggregates()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  refresh materialized view concurrently public_position_totals;
  refresh materialized view concurrently public_party_alignment;
  refresh materialized view concurrently public_party_position_totals;
$$;

revoke all on function refresh_vote_aggregates() from public;
revoke all on function refresh_vote_aggregates() from anon;
grant execute on function refresh_vote_aggregates() to service_role;
```

- [ ] **Step 2: Do NOT apply this migration.** Confirm no `psql`/Supabase CLI/REST DDL call was made.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0022_vote_duplicates.sql
git commit -m "feat: draft migration - vote_duplicates table + exclusion in public_vote_feed, public_votes, vote-aggregate matviews (Lance applies)"
```

---

### Task 2: Extend `crossCheckAgainstPrimarySource` to report the matched primary vote's id

**Files:**
- Modify: `src/adapters/legiscan-votes.js`
- Test: `tests/legiscan-votes.test.js`

**Interfaces:**
- Produces: on a `reason: 'tally_unique_match'` result only, the returned object also carries `primaryVoteId: <uuid>` — the matched primary-source `votes.id`. Every other branch's return shape is unchanged (no `primaryVoteId` key at all — not `null`, simply absent, so a consumer can reliably check `'primaryVoteId' in result`).
- Consumes: nothing new — `primaryVote.id` (single-candidate path) and `selectedCandidate.id` (multi-candidate tally-unique path) are already in scope at both return sites.

- [ ] **Step 1: Write the failing tests**

Add to `tests/legiscan-votes.test.js`, immediately after the existing test at line 902-912 (the
`tally_unique_match` HB3 single-candidate test):

```javascript
test('crossCheckAgainstPrimarySource: tally_unique_match ALWAYS carries primaryVoteId — the matched primary-source votes.id, for the dedup-marking caller to use', async () => {
  const { voteRows, castRows } = buildHb3HouseCandidates(HB3_HOUSE_TALLIES);
  const { client } = makeFakeVotesDb({ voteRows, castRows });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(result.reason, 'tally_unique_match');
  const expectedPrimaryId = voteRows.find((v) => v.source_key.includes('primary-hb3')
    && v.chamber === legiscanTallies774312.chamber).id;
  assert.equal(result.primaryVoteId, expectedPrimaryId);
});

test('crossCheckAgainstPrimarySource: a FLAGGED (non-clean) result never carries primaryVoteId — the field is absent, not null, so a caller checking `in` never mistakes a flagged row for a clean match', async () => {
  const mismatchedTallies = { ...legiscanTallies774312, tallies: { yea: 999, nay: 999 } };
  const { voteRows, castRows } = buildHb3HouseCandidates(HB3_HOUSE_TALLIES);
  const { client } = makeFakeVotesDb({ voteRows, castRows });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', mismatchedTallies);
  assert.notEqual(result.reason, 'tally_unique_match');
  assert.equal('primaryVoteId' in result, false);
});
```

Also extend the second existing `tally_unique_match` test (the multi-candidate tally-unique
selection path, `tests/legiscan-votes.test.js:1102-1120`) by adding this assertion right after its
existing `assert.equal(result312.reason, 'tally_unique_match');` line:

```javascript
  assert.ok(result312.primaryVoteId, 'the tally-uniquely-selected candidate\'s own id must be reported, not just that a match happened');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/legiscan-votes.test.js`
Expected: FAIL — `result.primaryVoteId` is `undefined` where a real id is expected; the "never
carries primaryVoteId" test currently passes vacuously (not useful yet, will stay green — that's
fine, it's a regression guard for Step 3, not a red/green pair on its own).

- [ ] **Step 3: Implement — add `primaryVoteId` to the two clean-match return statements**

In `src/adapters/legiscan-votes.js`, change the single-candidate path's clean-match return
(currently at line 816-819):

```javascript
    if (hardMismatches.length === 0 && softMismatches.length === 0) {
      return {
        checked: true, matched: true, flag: null, quarantine: false, reason: 'tally_unique_match', primaryVoteId: primaryVote.id,
      };
    }
```

And the multi-candidate tally-unique path's clean-match return (currently at line 893-897):

```javascript
    if (hardMismatches.length === 0 && softMismatches.length === 0) {
      // The real happy path: verification actually passing, not just selection succeeding.
      return {
        checked: true, matched: true, flag: null, quarantine: false, reason: 'tally_unique_match', primaryVoteId: selectedCandidate.id,
      };
    }
```

No other return statement in this function changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/legiscan-votes.test.js`
Expected: PASS, all new/extended assertions plus every pre-existing test in this file.

- [ ] **Step 5: Run the full suite**

Run: `node --test` (from repo root)
Extract the fail count from the `^ℹ fail` line.
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/legiscan-votes.js tests/legiscan-votes.test.js
git commit -m "feat: crossCheckAgainstPrimarySource reports the matched primary vote's id on a clean match"
```

---

### Task 3: Wire `vote_duplicates` writes into live LegiScan ingest

**Files:**
- Modify: `src/cli/ingest-legiscan.js`
- Test: `tests/ingest-legiscan-cli.test.js` (the real file — despite the module being named
  `ingest-legiscan.js`, its test file is `ingest-legiscan-cli.test.js`; confirmed by directory
  listing, do not create a differently-named file)

**Interfaces:**
- Consumes: `crossCheck.primaryVoteId` (Task 2) and `voteSel.id` (the just-inserted LegiScan vote's real id, already computed at `ingest-legiscan.js:611-613`).
- Produces: nothing new exported — this is internal wiring inside `ingestLegiscanRollCalls`. Going forward, every live LegiScan ingest that finds a clean primary-source match additively records it in `vote_duplicates`.

- [ ] **Step 1: Write the failing test**

This file drives real ingests through `runLegiscanIngest(client, runId, args, deps)` against the
real fixture dataset `${FIXDIR}/mo-2018-dataset-1608.json`, using `makeFakeLegiscanClient` and
inspecting `tables.*` directly afterward — the exact same pattern the existing hard-mismatch test
(search for `IMPORTANT 5 fix`) and quarantine-retraction test (search for `CRITICAL 2 fix`) already
use.

**Required first edit, or every existing test in this file breaks once Step 3 lands:**
`makeFakeLegiscanClient` (`ingest-legiscan-cli.test.js:107-111`) throws `unexpected table` for
anything not in its own hardcoded `tables` object (`client.from(table)`, line 133:
`if (!(table in tables)) throw new Error(...)`). Add `vote_duplicates: []` to that object's default
list:

```javascript
  const tables = {
    sessions: [], bills: [], legislators: [], terms: [], votes: [], vote_casts: [],
    vote_reconciliation_flags: [], legiscan_datasets: [], ingestion_runs: [], vote_duplicates: [], ...seed,
  };
```

Then add, in the same style as the two tests named above:

```javascript
test('runLegiscanIngest: a clean primary-source correspondence additively writes a vote_duplicates row (canonical=primary, superseded=the newly-stored LegiScan vote)', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  tables.ingestion_runs.push({ id: 'run-dedup-1', source: 'legiscan', status: 'running', detail: {} });

  // Pass 1: no primary rows exist yet — resolve the real (fake) HB3 bill row id, same two-phase
  // idempotent pattern the hard-mismatch test above uses.
  await runLegiscanIngest(client, 'run-dedup-1', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: null });
  const hb3BillRow = tables.bills.find((b) => b.identifier === 'HB 3');
  assert.ok(hb3BillRow);

  // Roll call 774411 (HB3, SENATE, 2018-09-14, real tallies yea=28/nay=1/absent=4 per
  // legiscan-votes.test.js's own EXPECTED_TALLIES) is the SAME singleton/singleton roll call the
  // existing hard-mismatch test isolates, but seeded here with MATCHING tallies instead of doctored
  // ones — a genuine clean correspondence, not a contradiction.
  const primaryVoteId = 'primary-hb3-senate-clean';
  tables.votes.push({
    id: primaryVoteId, bill_id: hb3BillRow.id, jurisdiction_id: 'mo-legislature', chamber: 'senate', vote_date: '2018-09-14', source_key: 'mo-senate-web-2018-x-vote1',
  });
  for (let i = 0; i < 28; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'yea' });
  for (let i = 0; i < 1; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'nay' });
  for (let i = 0; i < 4; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'absent' });

  // Reset whatever LegiScan itself wrote on pass 1 (same reset the existing hard-mismatch test
  // performs), then re-run.
  tables.votes.splice(0, tables.votes.length, ...tables.votes.filter((v) => v.id === primaryVoteId));
  tables.vote_casts.splice(0, tables.vote_casts.length, ...tables.vote_casts.filter((c) => c.vote_id === primaryVoteId));

  await runLegiscanIngest(client, 'run-dedup-1', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: null });

  const legiscanVote774411 = tables.votes.find((v) => v.source_key === 'legiscan-1608-rollcall-774411');
  assert.ok(legiscanVote774411, 'sanity: the LegiScan vote is stored (a clean match never withholds storage)');
  assert.equal(tables.vote_duplicates.length, 1, 'exactly one duplicate pair — the clean match, and only that one');
  assert.equal(tables.vote_duplicates[0].canonical_vote_id, primaryVoteId);
  assert.equal(tables.vote_duplicates[0].superseded_vote_id, legiscanVote774411.id);
});

test('runLegiscanIngest: a re-run against an already-marked pair does not error or double-write', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  tables.ingestion_runs.push({ id: 'run-dedup-2', source: 'legiscan', status: 'running', detail: {} });
  await runLegiscanIngest(client, 'run-dedup-2', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: null });
  const hb3BillRow = tables.bills.find((b) => b.identifier === 'HB 3');
  const primaryVoteId = 'primary-hb3-senate-clean-2';
  tables.votes.push({
    id: primaryVoteId, bill_id: hb3BillRow.id, jurisdiction_id: 'mo-legislature', chamber: 'senate', vote_date: '2018-09-14', source_key: 'mo-senate-web-2018-x-vote1',
  });
  for (let i = 0; i < 28; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'yea' });
  for (let i = 0; i < 1; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'nay' });
  for (let i = 0; i < 4; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'absent' });
  tables.votes.splice(0, tables.votes.length, ...tables.votes.filter((v) => v.id === primaryVoteId));
  tables.vote_casts.splice(0, tables.vote_casts.length, ...tables.vote_casts.filter((c) => c.vote_id === primaryVoteId));

  // First pass creates the pair.
  await runLegiscanIngest(client, 'run-dedup-2', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: null });
  assert.equal(tables.vote_duplicates.length, 1);

  // Second pass, same run shape — insertIfAbsent on superseded_vote_id must make this a no-op, never
  // a duplicate-key error and never a second row.
  tables.ingestion_runs.push({ id: 'run-dedup-3', source: 'legiscan', status: 'running', detail: {} });
  await runLegiscanIngest(client, 'run-dedup-3', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: null });
  assert.equal(tables.vote_duplicates.length, 1, 'no second row for the same already-marked pair');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/ingest-legiscan-cli.test.js`
Expected: FAIL — `tables.vote_duplicates` stays empty (or the test throws on an undefined table,
depending on `makeFakeLegiscanClient`'s exact default-table handling — either way, red for the right
reason).

- [ ] **Step 3: Implement the wiring**

In `src/cli/ingest-legiscan.js`, inside `ingestLegiscanRollCalls`'s per-roll-call loop, after the
existing vote insert and `voteSel.id` lookup (currently ending at line 613) and before the
`result.votes += 1;` line (614), add:

```javascript
    // Severity/dedup follow-up (2026-08-03): a clean primary-source correspondence marks the
    // duplicate additively — both rows stay stored, forever, fully traceable (vote_duplicates,
    // migration 0022). insertIfAbsent on superseded_vote_id (its own unique constraint) makes this
    // safe to re-run: an already-marked pair is a harmless no-op, never a duplicate-key error.
    if (crossCheck.reason === 'tally_unique_match' && crossCheck.primaryVoteId) {
      // eslint-disable-next-line no-await-in-loop
      await insertIfAbsent(client, 'vote_duplicates', [{
        canonical_vote_id: crossCheck.primaryVoteId,
        superseded_vote_id: voteSel.id,
        reason: 'legiscan-vs-primary-source tally_unique_match at ingest',
      }], 'superseded_vote_id');
    }

```

Confirm `insertIfAbsent` is already imported in this file (it's used throughout, e.g. line 609 for
the `votes` insert itself) — no new import needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ingest-legiscan-cli.test.js`
Expected: PASS, both new tests plus every pre-existing test in this file.

- [ ] **Step 5: Run the full suite**

Run: `node --test` (from repo root)
Extract the fail count from the `^ℹ fail` line.
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/ingest-legiscan.js tests/ingest-legiscan-cli.test.js
git commit -m "feat: mark clean LegiScan-vs-primary-source vote correspondences in vote_duplicates at ingest time"
```

---

### Task 4: Backfill correction — `runCorrectVoteDuplicates`

**Files:**
- Modify: `src/cli/correct-data.js`
- Test: `tests/correct-data.test.js`

**Interfaces:**
- Consumes: `crossCheckAgainstPrimarySource` (Task 2's extended version), `parseLegiscanRollCallSourceKey` (already exported in this same file, `correct-data.js:635`), `PRIMARY_SOURCE_KEY_PREFIXES` (already exported from `src/adapters/legiscan-votes.js:340`).
- Produces: `export async function runCorrectVoteDuplicates(client, {dryRun = false, limit = null, runId = null} = {}) -> {matched, alreadyMarked, unparseable, failures}`, wired into `runCorrectData`'s dispatcher under `which === 'vote-duplicates'`, joining the `'all'` bucket (pure inserts, same risk class as `party-normalize`/`legiscan-source-split`).

- [ ] **Step 1: Write the failing tests**

Read `tests/correct-data.test.js`'s `makeFakeClient` helper in full first (it already supports
`.from(table).select().eq()`, `.from(table).insert(row).select().single()`, and needs
`vote_duplicates: []` added to its default `tables` seed object alongside the other defaulted-empty
tables like `ingestion_runs` — the same "defaulted empty so every EXISTING test still works as a
harmless no-op" precedent already used there).

Add to `tests/correct-data.test.js`:

```javascript
const MO_BILL_ID = 'bill-mo-1';

function seedVoteDuplicateFixture({ withMismatch = false } = {}) {
  const legiscanVote = {
    id: 'v-legiscan-1', bill_id: MO_BILL_ID, jurisdiction_id: 'mo-legislature', chamber: 'house',
    vote_date: '2018-09-12T00:00:00Z', source_key: 'legiscan-1530-rollcall-774312',
  };
  const primaryVote = {
    id: 'v-primary-1', bill_id: MO_BILL_ID, jurisdiction_id: 'mo-legislature', chamber: 'house',
    vote_date: '2018-09-12T00:00:00Z', source_key: 'mo-house-xml-2018-hb3-vote1',
  };
  const legiscanCasts = [
    { id: 'c1', vote_id: 'v-legiscan-1', legislator_id: 'l1', position: 'yea' },
    { id: 'c2', vote_id: 'v-legiscan-1', legislator_id: 'l2', position: withMismatch ? 'yea' : 'nay' },
  ];
  const primaryCasts = [
    { id: 'c3', vote_id: 'v-primary-1', legislator_id: 'l1', position: 'yea' },
    { id: 'c4', vote_id: 'v-primary-1', legislator_id: 'l2', position: 'nay' },
  ];
  return {
    votes: [legiscanVote, primaryVote],
    vote_casts: [...legiscanCasts, ...primaryCasts],
  };
}

test('runCorrectVoteDuplicates: dry-run finds a genuine clean match and reports it without writing', async () => {
  const client = makeFakeClient(seedVoteDuplicateFixture());
  const result = await runCorrectVoteDuplicates(client, { dryRun: true });
  assert.equal(result.matched, 1);
  assert.equal(result.alreadyMarked, 0);
  assert.deepEqual(result.failures, []);
  const writes = client.calls.filter((c) => c.table === 'vote_duplicates' && c.mode === 'insert');
  assert.equal(writes.length, 0, 'dry-run must never write');
});

test('runCorrectVoteDuplicates: live run writes the exact pair dry-run reported', async () => {
  const client = makeFakeClient(seedVoteDuplicateFixture());
  const dry = await runCorrectVoteDuplicates(client, { dryRun: true });
  const live = await runCorrectVoteDuplicates(client, { dryRun: false, runId: 'run-1' });
  assert.equal(live.matched, dry.matched);
  const inserted = client.tables.vote_duplicates;
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].canonical_vote_id, 'v-primary-1');
  assert.equal(inserted[0].superseded_vote_id, 'v-legiscan-1');
});

test('runCorrectVoteDuplicates: a pair already marked in vote_duplicates is not re-counted or re-written', async () => {
  const client = makeFakeClient({
    ...seedVoteDuplicateFixture(),
    vote_duplicates: [{
      id: 'vd-1', canonical_vote_id: 'v-primary-1', superseded_vote_id: 'v-legiscan-1', reason: 'existing', created_at: 'test-time',
    }],
  });
  const result = await runCorrectVoteDuplicates(client, { dryRun: true });
  assert.equal(result.matched, 0);
  assert.equal(result.alreadyMarked, 1);
});

test('runCorrectVoteDuplicates: a genuine tally mismatch is never marked as a duplicate', async () => {
  const client = makeFakeClient(seedVoteDuplicateFixture({ withMismatch: true }));
  const result = await runCorrectVoteDuplicates(client, { dryRun: true });
  assert.equal(result.matched, 0);
  assert.equal(client.tables.vote_duplicates.length, 0);
});

test('runCorrectVoteDuplicates: an unparseable LegiScan source_key is counted, never guessed', async () => {
  const client = makeFakeClient({
    votes: [
      { id: 'v-bad', bill_id: MO_BILL_ID, jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12T00:00:00Z', source_key: 'legiscan-not-a-real-shape' },
    ],
    vote_casts: [],
  });
  const result = await runCorrectVoteDuplicates(client, { dryRun: true });
  assert.equal(result.unparseable, 1);
  assert.equal(result.matched, 0);
});
```

Add `runCorrectVoteDuplicates` to the existing import block at the top of the file, and add
`vote_duplicates: []` to `makeFakeClient`'s default `tables` object.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/correct-data.test.js`
Expected: FAIL — `runCorrectVoteDuplicates is not a function` (import error).

- [ ] **Step 3: Implement `runCorrectVoteDuplicates` in `src/cli/correct-data.js`**

Add near the other corrections (after `runCorrectLegiscanSourceSplit`, before the top-level
dispatcher):

```javascript
// ============================================================================================
// Correction: vote-duplicates — the never-built "primary-source row wins for display" ruling
// (docs/superpowers/specs/2026-08-03-vote-duplicate-dedup-design.md). Pure inserts into
// vote_duplicates, never a rewrite of votes/vote_casts — lower risk than mo-status/party-normalize
// (in-place UPDATEs), so this joins 'all' below, same as those.
// ============================================================================================

// buildVoteDuplicateTupleKey — the same correspondence key crossCheckAgainstPrimarySource itself
// matches on (bill, chamber, calendar day), scoped to grouping SIBLING LegiScan votes for its own
// same-day disambiguation parameter — this is NOT a duplicate of crossCheckAgainstPrimarySource's
// own matching/disambiguation logic (that stays exclusively inside that function, reused directly
// below), only the small bucket key needed to build its siblingTallies argument.
function buildVoteDuplicateTupleKey(billId, chamber, isoDate) {
  const day = String(isoDate ?? '').slice(0, 10);
  return `${billId}::${chamber}::${day}`;
}

export async function runCorrectVoteDuplicates(client, {
  dryRun = false, limit = null, runId = null,
} = {}) {
  const failures = [];
  let remainingBudget = limit ?? Infinity;

  const { data: legiscanVotes, error: lvErr } = await client
    .from('votes').select('id,bill_id,chamber,vote_date,source_key').like('source_key', 'legiscan-%');
  if (lvErr) return { matched: 0, alreadyMarked: 0, unparseable: 0, failures: [{ reason: 'legiscan_votes_lookup_failed', error: String(lvErr.message ?? lvErr) }] };

  const { data: existingPairs, error: vdErr } = await client.from('vote_duplicates').select('superseded_vote_id');
  if (vdErr) return { matched: 0, alreadyMarked: 0, unparseable: 0, failures: [{ reason: 'vote_duplicates_lookup_failed', error: String(vdErr.message ?? vdErr) }] };
  const alreadyMarkedIds = new Set((existingPairs ?? []).map((r) => r.superseded_vote_id));

  // Sibling grouping — bucket every LegiScan vote in this backfill's own scan by (bill, chamber,
  // day), so crossCheckAgainstPrimarySource's own same-day disambiguation (the real HB3 5-roll-call
  // case) sees the full sibling pool, mirroring ingest-legiscan.js's own Phase-1/Phase-2 split
  // (reconcile everything first, THEN cross-check with full sibling knowledge).
  const tupleGroups = new Map();
  for (const v of legiscanVotes ?? []) {
    const key = buildVoteDuplicateTupleKey(v.bill_id, v.chamber, v.vote_date);
    if (!tupleGroups.has(key)) tupleGroups.set(key, []);
    tupleGroups.get(key).push(v);
  }

  let matched = 0;
  let alreadyMarked = 0;
  let unparseable = 0;

  for (const v of legiscanVotes ?? []) {
    if (alreadyMarkedIds.has(v.id)) { alreadyMarked += 1; continue; }
    if (!Number.isFinite(remainingBudget) || remainingBudget > 0) {
      const parsed = parseLegiscanRollCallSourceKey(v.source_key);
      if (!parsed) { unparseable += 1; continue; }

      const { data: castRows, error: castErr } = await client.from('vote_casts').select('position').eq('vote_id', v.id);
      if (castErr) { failures.push({ voteId: v.id, reason: 'casts_lookup_failed', error: String(castErr.message ?? castErr) }); continue; }
      const yea = (castRows ?? []).filter((c) => c.position === 'yea').length;
      const nay = (castRows ?? []).filter((c) => c.position === 'nay').length;

      const key = buildVoteDuplicateTupleKey(v.bill_id, v.chamber, v.vote_date);
      const siblingTallies = (tupleGroups.get(key) ?? [])
        .filter((s) => s.id !== v.id)
        .map((s) => ({ rollCallId: parseLegiscanRollCallSourceKey(s.source_key)?.rollCallId }))
        .filter((s) => s.rollCallId != null);

      const legiscanTallies = {
        chamber: v.chamber, date: String(v.vote_date).slice(0, 10), tallies: { yea, nay },
        rollCallId: parsed.rollCallId, runId,
      };

      // eslint-disable-next-line no-await-in-loop
      const crossCheck = await crossCheckAgainstPrimarySource(client, v.bill_id, legiscanTallies, siblingTallies);
      if (crossCheck.reason === 'tally_unique_match' && crossCheck.primaryVoteId) {
        matched += 1;
        if (!dryRun) {
          // eslint-disable-next-line no-await-in-loop
          await insertIfAbsent(client, 'vote_duplicates', [{
            canonical_vote_id: crossCheck.primaryVoteId, superseded_vote_id: v.id, reason: 'legiscan-vs-primary-source tally_unique_match, backfill 2026-08-03',
          }], 'superseded_vote_id');
        }
        if (Number.isFinite(remainingBudget)) remainingBudget -= 1;
      }
    }
  }

  return {
    matched, alreadyMarked, unparseable, failures,
  };
}
```

Add these two imports at the top of `correct-data.js` if not already present:

```javascript
import { crossCheckAgainstPrimarySource } from '../adapters/legiscan-votes.js';
```

(`insertIfAbsent` is already imported in this file — used by other corrections.)

Wire into the dispatcher (`runCorrectData`, alongside the `legiscan-source-split` block):

```javascript
  // vote-duplicates (2026-08-03) — same in-place-additive risk class as party-normalize/
  // legiscan-source-split above (pure inserts, no rewrites of votes/vote_casts at all — lower risk
  // than either), so it joins 'all' alongside them.
  if (which === 'vote-duplicates' || which === 'all') {
    out.voteDuplicates = await runCorrectVoteDuplicates(client, { dryRun, limit, runId });
    failures.push(...out.voteDuplicates.failures);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/correct-data.test.js`
Expected: PASS, all new tests plus every pre-existing test in this file (confirm the `'all'` bucket
tests, if any assert on the exact set of `out.*` keys, are updated to include `voteDuplicates` —
read them and adjust if they do an exact-shape assertion).

- [ ] **Step 5: Run the full suite**

Run: `node --test` (from repo root)
Extract the fail count from the `^ℹ fail` line.
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/correct-data.js tests/correct-data.test.js
git commit -m "feat: runCorrectVoteDuplicates backfill correction for the existing cross-adapter duplicate backlog"
```

---

### Task 5: `bill-page.js` — switch the votes fetch to the new `public_votes` view

**Files:**
- Modify: `site/js/bill-page.js`
- Test: `tests/bill-page.test.js`

**Interfaces:**
- Consumes: the new `public_votes` view (Task 1) — same column shape as the existing `VOTES_SELECT` constant already requests from `votes` directly, so no rendering-code change needed downstream.

- [ ] **Step 1: Update the existing `loadVotesSection` tests' mock URL matching**

`tests/bill-page.test.js`'s `loadVotesSection` tests currently mock fetch responses keyed on
`u.includes('/votes?')` (or similar — read the file's existing `loadVotesSection` tests to confirm
the exact match string used). Change every such match from `/votes?` to `/public_votes?` in those
existing tests, since the fetch URL is about to change in Step 3. This is a mechanical rename, not
new test logic — the assertions themselves (what renders) stay identical.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/bill-page.test.js`
Expected: FAIL — the existing `loadVotesSection` tests now mock a URL (`/public_votes?`) the
still-unchanged fetch code never requests, so they see no matching votes data (empty/failed state).

- [ ] **Step 3: Change the fetch URL in `bill-page.js`**

Change (`bill-page.js:602`):

```javascript
    votes = (await restGet(`votes?bill_id=eq.${billId}&select=${VOTES_SELECT}&order=vote_date.desc.nullslast`)).rows;
```

to:

```javascript
    votes = (await restGet(`public_votes?bill_id=eq.${billId}&select=${VOTES_SELECT}&order=vote_date.desc.nullslast`)).rows;
```

No other change — `VOTES_SELECT`'s column list (`id,jurisdiction_id,chamber,vote_date,question,
result,source_url,source_key`) is exactly the column set `public_votes` (Task 1) exposes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/bill-page.test.js`
Expected: PASS, all `loadVotesSection` tests plus every other pre-existing test in this file.

- [ ] **Step 5: Run the full suite**

Run: `node --test` (from repo root)
Extract the fail count from the `^ℹ fail` line.
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add site/js/bill-page.js tests/bill-page.test.js
git commit -m "feat: bill-page.js reads votes through the deduped public_votes view"
```

---

### Task 6: Extend `probe-public-surface.js` for `public_votes` and the exclusion

**Files:**
- Modify: `scripts/probe-public-surface.js`
- Test: `tests/probe-public-surface.test.js`

**Interfaces:**
- Produces: `export function checkNoSupersededVotes(voteRows, supersededIds) -> {ok, leaked}` — a pure function mirroring `checkRowScoping`'s existing shape exactly (same file, same style: a Set-based membership check, `{ok, leaked}`), wired into `main()`'s live probe once Lance applies migration 0022.

- [ ] **Step 1: Write the failing tests**

Add to `tests/probe-public-surface.test.js`, after the existing `checkCitationsShape` tests:

```javascript
// ---- checkNoSupersededVotes — vote-duplicate dedup (migration 0022, draft-then-apply) ----

test('checkNoSupersededVotes: no superseded ids among the rows -> ok, zero leaks', () => {
  const rows = [{ id: 'v1' }, { id: 'v2' }];
  const result = checkNoSupersededVotes(rows, new Set(['v3']));
  assert.deepEqual(result, { ok: true, leaked: [] });
});

test('checkNoSupersededVotes: a superseded id present in the public rows is caught — the real leak this gate exists for', () => {
  const rows = [{ id: 'v1' }, { id: 'v2' }];
  const result = checkNoSupersededVotes(rows, new Set(['v2']));
  assert.equal(result.ok, false);
  assert.deepEqual(result.leaked, ['v2']);
});

test('checkNoSupersededVotes: empty rows or empty superseded set -> ok trivially', () => {
  assert.deepEqual(checkNoSupersededVotes([], new Set(['v1'])), { ok: true, leaked: [] });
  assert.deepEqual(checkNoSupersededVotes([{ id: 'v1' }], new Set()), { ok: true, leaked: [] });
});

test('checkNoSupersededVotes: null/undefined rows -> ok, never throws', () => {
  assert.deepEqual(checkNoSupersededVotes(null, new Set(['v1'])), { ok: true, leaked: [] });
  assert.deepEqual(checkNoSupersededVotes(undefined, new Set(['v1'])), { ok: true, leaked: [] });
});
```

Add `checkNoSupersededVotes` to the existing import line at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/probe-public-surface.test.js`
Expected: FAIL — import error, `checkNoSupersededVotes` not exported yet.

- [ ] **Step 3: Implement `checkNoSupersededVotes` in `scripts/probe-public-surface.js`**

Add after `checkRowScoping`:

```javascript
// checkNoSupersededVotes(voteRows, supersededIds) -> {ok, leaked} — vote-duplicate dedup (migration
// 0022, draft-then-apply). public_votes/public_vote_feed/the vote-aggregate matviews all exclude
// superseded_vote_id rows via a join; this proves that exclusion actually held for a live sample,
// the same "prove the row-level effect, don't just trust the view definition" discipline
// checkRowScoping already applies to public_verification_notes. Pure — no I/O, never throws.
export function checkNoSupersededVotes(voteRows, supersededIds) {
  const rowsArr = Array.isArray(voteRows) ? voteRows : [];
  const ids = supersededIds instanceof Set ? supersededIds : new Set();
  const leaked = rowsArr.filter((r) => ids.has(r.id)).map((r) => r.id);
  return { ok: leaked.length === 0, leaked };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/probe-public-surface.test.js`
Expected: PASS, all new tests plus every pre-existing test in this file.

- [ ] **Step 5: Wire into `main()`'s live probe — honestly, within what an anon key can prove**

`checkNoSupersededVotes` cannot actually run inside this script's `main()`: `main()` is anon-key-only
by design (`probe-public-surface.js`'s own header: "anon-key verification of the public read
surface"), and `vote_duplicates` deliberately carries no anon grant at all (Task 1) — so there is no
way for this script to ever learn which ids are superseded, and a check that claimed to "prove no
superseded row leaked" here would be checking against an empty set it can never actually populate —
the exact vacuous-check shape this project's own PLAYBOOK_DELTA warns about. Keep
`checkNoSupersededVotes` as a tested pure function (useful if a future service-role-side script ever
needs it), but wire only an honest, real check into `main()`: reachability and column shape, the
same pattern `EXPECT_FEED`/`checkRequiredColumnsPresent` already use for `public_vote_feed`.

In `scripts/probe-public-surface.js`, add near the other `EXPECT_*` constants:

```javascript
const EXPECT_VOTES = ['id', 'bill_id', 'jurisdiction_id', 'chamber', 'vote_date', 'question', 'result', 'source_url', 'source_key'];
```

Then in `main()`, after the existing `citations` check block, add:

```javascript
  // Migration 0022 (draft-then-apply) may or may not have landed yet — same graceful-skip pattern
  // as the citations check above. This can only prove public_votes is reachable and correctly
  // shaped from the anon key — NOT that the exclusion actually holds (vote_duplicates itself is
  // deliberately not anon-readable, so there is no way to learn the superseded-id set from here;
  // verifying the join's real effect is Lance's own live spot-check, per the handoff notes below).
  const publicVotesShape = await rows(url, H, 'public_votes?limit=1');
  if (publicVotesShape.status === 200 && publicVotesShape.body?.[0]) {
    const got = Object.keys(publicVotesShape.body[0]);
    const { ok, missing } = checkRequiredColumnsPresent(got, EXPECT_VOTES);
    check(
      'public_votes has the required columns (migration 0022)',
      ok,
      missing.length ? `missing: ${missing.join(',')}` : got.sort().join(','),
      state,
    );
  } else {
    console.log('INFO  public_votes check skipped — migration 0022 not applied yet (or the request failed for another reason)');
  }
```

- [ ] **Step 6: Run the full suite**

Run: `node --test` (from repo root)
Extract the fail count from the `^ℹ fail` line.
Expected: `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add scripts/probe-public-surface.js tests/probe-public-surface.test.js
git commit -m "feat: checkNoSupersededVotes validator + public_votes shape probe check"
```

---

## Handoff to Lance (not a task — nothing left for an agent to do)

1. Review `supabase/migrations/0022_vote_duplicates.sql` and apply it (Supabase SQL editor, same
   process as every prior migration).
2. Run `node scripts/probe-public-surface.js` — confirms `public_votes` is reachable and the schema
   landed correctly.
3. Run `npm run refresh:aggregates` — the three matviews were recreated by the migration with
   `WITH DATA` (populated immediately), but a fresh refresh after the backfill (step 4 below) picks
   up any newly-marked duplicates.
4. Run the backfill: `node --env-file=.env src/cli/correct-data.js vote-duplicates --dry-run` first
   to see the real count, then without `--dry-run` to apply it live.
5. Run `npm run refresh:aggregates` again (the backfill in step 4 ran after step 3's refresh).
6. Spot-check the actual exclusion (the one thing the anon-only probe script structurally can't
   prove, per Task 6 §5's own note): in the Supabase SQL editor, `select * from vote_duplicates
   limit 5` to find a real marked pair, then confirm its `superseded_vote_id` does NOT appear in
   `select id from public_votes where id = '<that id>'` or `public_vote_feed`. Then spot-check that
   same bill's page and a legislator's vote-aggregate chart in a browser to confirm the numbers now
   match what the vote list itself shows.
