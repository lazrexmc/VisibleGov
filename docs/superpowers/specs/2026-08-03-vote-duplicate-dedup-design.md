# Cross-adapter vote duplicate dedup — design

**Status:** approved (Lance, 2026-08-03: "Move forward with the project and complete it from spec
to implementation").

## Why

A binding ruling exists (CONTROLLER RULING 3, `docs/superpowers/plans/2026-07-29-legiscan-bulk-
adapter.md:604-609`; restated in `src/adapters/legiscan-votes.js:333-339` and `src/cli/ingest-mo-
house.js:34-40`): *"the primary-source (journal/PDF) row wins for display whenever both exist for
the same (chamber, date, bill, tallies)."* It was never implemented. Both LegiScan and MO's own
primary-source adapters (`mo-house-xml`, `mo-senate-web`) can — legitimately, correctly — each write
their own `votes` row for the same real floor vote. No dedup logic exists anywhere in `site/js/`
(confirmed by grep — the only "dedup" hit is an unrelated affiliation-list dedup in
`profile-model.js`), and the three vote-aggregate matviews (`0018_vote_aggregates.sql`) join
`votes`/`vote_casts` with zero source discrimination, so every duplicated real vote is counted
**twice** in every position/cohesion/party-rollup percentage on the live site. This is not a cosmetic
list-duplication bug — it's a live accuracy defect in the numbers themselves.

Scope, per Lance's decision: fix both the display (vote lists) and the aggregates (matview
percentages), not just one.

## Design

### 1. Data layer — an additive grouping table, not a destructive fix

```sql
create table vote_duplicates (
  id                 uuid primary key default gen_random_uuid(),
  canonical_vote_id  uuid not null references votes(id),
  superseded_vote_id uuid not null unique references votes(id),
  reason             text not null,
  created_at         timestamptz default now()
);
```

Mirrors this codebase's own non-destructive precedent for exactly this shape of problem —
`persons`/`person_links` (migration `0012_identity_merge.sql`): *"source legislator rows are never
deleted or rewritten; a person groups them at read time. A wrong link is one UPDATE to undo."* Same
here: both `votes` rows stay exactly as they are, forever, fully traceable. `superseded_vote_id
unique` prevents double-marking the same row. This is explicitly **not** the codebase's one
sanctioned delete (`retractLegiscanVoteIfStored`, `src/cli/ingest-legiscan.js`) — that function is
scoped to genuine LegiScan-vs-primary **contradictions** and throws if ever called on anything else;
this table is for legitimately **agreeing** duplicates, a different case entirely, never conflated.

### 2. Detection — extend the existing matching logic, never reimplement it

`crossCheckAgainstPrimarySource` (`src/adapters/legiscan-votes.js:627-963`) already computes exactly
this correspondence on every live LegiScan ingest, before the LegiScan row is even stored — bill +
chamber + same-calendar-day + (when ambiguous) tally-based disambiguation, including the real
5-same-day-roll-calls HB3 case. Its clean-match branches (both the tally-unique-selection path,
`legiscan-votes.js:816-819`, and the plain single-candidate path, `:893-897`) already return
`{checked: true, matched: true, flag: null, quarantine: false, reason: 'tally_unique_match'}` — the
exact signal needed — but currently discard the matched primary-source row's own id.

**Change:** add `primaryVoteId: primaryVote.id` (first branch) / `primaryVoteId:
selectedCandidate.id` (second branch) to those two return statements only — additive, backward
compatible (existing tests assert individual fields via `assert.equal`, never a whole-object
`deepEqual`, confirmed by reading `tests/legiscan-votes.test.js:902-912`). No other branch changes.

**Wiring** (`src/cli/ingest-legiscan.js:559-616`, inside the per-roll-call loop): after the existing
`crossCheck = await crossCheckFn(...)` call and the existing LegiScan-vote insert
(`insertIfAbsent(client, 'votes', [voteRow], 'source_key')` at `:609`, whose real id is fetched
right after at `:611-613` into `voteSel.id`), when `crossCheck.reason === 'tally_unique_match'`
(already checked at `:568` for a different counter), additively write one `vote_duplicates` row:
`canonical_vote_id = crossCheck.primaryVoteId`, `superseded_vote_id = voteSel.id`, guarded the same
way every other write in this file is (`insertIfAbsent`-style, tolerant of a re-run against an
already-marked pair — never a duplicate-key error on retry). This closes the defect **going
forward**, automatically, on every future ingest — no new periodic job, no drift between detection
and marking.

### 3. Backfill — a new `correct-data.js` correction for the existing backlog

Same established shape as every other correction in that file (`runCorrectMoStatus`,
`runCorrectPartyNormalize`, etc.): `--dry-run` reproduces live-target numbers exactly, honest counts
object, `--limit` supported. Calls `crossCheckAgainstPrimarySource` **directly** against every
existing `legiscan-*` MO vote — same function, same matching logic as §2, not a parallel
reimplementation — and for every `tally_unique_match` result whose pair isn't already in
`vote_duplicates`, writes it. Pure inserts, no deletes, no updates to `votes`/`vote_casts` — lower
risk than this file's typical corrections, but still draft-then-apply: built and dry-run verified,
Lance runs the live pass, per this file's own stated convention.

### 4. Consumers — three call sites read from the one source of truth

- **`public_vote_feed`** (migration, modify `0016_public_read_surface.sql`'s view): add `left join
  vote_duplicates vd on vd.superseded_vote_id = v.id` and `where vd.id is null` to the existing
  join chain. Fixes `person-page.js`/`legislator-page.js`'s vote list (both share
  `person-page.js`'s `loadVotesSection`, confirmed by reading `legislator-page.js` — it's a thin
  wrapper around `person-page.js`'s `mountProfile`) with **zero JS changes** — they already fetch
  from this view.
- **The three vote-aggregate matviews** (`0018_vote_aggregates.sql` — `public_position_totals`,
  `public_party_alignment`, `public_party_position_totals`): the same `left join vote_duplicates ...
  where ... is null` exclusion added to each of their `from vote_casts vc join votes v` chains. This
  is the half of the fix that actually matters most — it corrects the double-counted percentages,
  not just a display list.
- **`bill-page.js`** queries the raw `votes` table directly (`votes?bill_id=eq.${billId}&select=...`,
  `bill-page.js:602`), not through any view — the one consumer that needs a new access path rather
  than an already-shared one. New view `public_votes` (migration): `votes` plus the same
  `vote_duplicates` exclusion, granted to anon (matching the `public_freshness`/
  `public_reconciliation_flags` "the view IS the policy" pattern already used in this schema).
  `bill-page.js`'s fetch changes from `votes?bill_id=eq...` to `public_votes?bill_id=eq...` — same
  select shape, same rendering code downstream, no other change needed.

**Known residual, not closed by this feature:** `votes`' own existing direct anon-read grant is left
untouched (lower blast radius than auditing every other consumer of that grant across the codebase,
which is out of scope here) — someone querying the raw `votes` table directly via the REST API still
sees both rows. `public_votes`/`public_vote_feed`/the matviews — everything the actual site
renders — do not. Logged here rather than silently accepted, same discipline as the citation-exposure
feature's own residual note.

### 5. Non-goals

- Not touching the combined-vehicle mechanism (`docs/research/2026-07-29-legiscan-substitute-
  vehicles.md`) — confirmed, by reading that doc in full, to be a genuinely different mechanism at a
  different layer (ingest-time "never write a second row for a sibling bill" vs. this feature's
  display-time "two adapters legitimately each wrote their own row for the one real vote, pick a
  winner"). No overlap, no shared code, not conflated in this design.
- Not revoking `votes`' direct anon grant (§4's residual).
- Not touching `vote_reconciliation_flags` or the contradiction/quarantine paths in
  `crossCheckAgainstPrimarySource` — this feature only extends the ALREADY-clean, non-flagged,
  non-quarantined match branches.
- No LLM/API calls anywhere in this feature.

## Testing

- `crossCheckAgainstPrimarySource`: extend the two existing `tally_unique_match` fixture tests
  (`tests/legiscan-votes.test.js:902-912`, `:1102-1120`) to also assert `result.primaryVoteId`
  equals the real primary-source candidate's id from the fixture. Add a case confirming
  `primaryVoteId` is `undefined`/absent on every non-matched branch (flag, quarantine,
  `corresponds_to_sibling`) — the field must only ever appear on a genuine clean match.
- `ingest-legiscan.js`: extend existing `crossCheckFn`-injection tests (this file already injects a
  fake `crossCheckFn` per its own header comment at `:471`) with a case where the fake returns
  `tally_unique_match` + `primaryVoteId` — assert a `vote_duplicates` row gets written with the
  correct `canonical_vote_id`/`superseded_vote_id` pair; a case re-running the same ingest twice
  confirms no duplicate-key error and no second row.
- New `correct-data.js` correction: `--dry-run` against a fixture with a mix of already-marked pairs,
  genuinely-missing pairs, and non-matching (flagged/quarantined) rows — confirms only the
  genuinely-missing clean matches get counted/written, `--dry-run` reproduces the live-target count
  exactly, re-running never double-writes.
- `public_vote_feed`/matviews/`public_votes`: this codebase's convention for SQL-only view/matview
  changes is verification via `scripts/probe-public-surface.js` (extend it, same pattern as the
  bullet-citation-exposure feature's `checkCitationsShape`) plus Lance's own live spot-check after
  applying — no `node --test` coverage exists for raw view SQL in this repo's history, and this
  design doesn't invent a new pattern for that.
