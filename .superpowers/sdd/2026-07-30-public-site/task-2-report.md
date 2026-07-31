# Task 2 Report: terms.state Backfill — Federal via Member Metadata, MO Constant

## Status
✓ COMPLETE (fixture-tested only — see Concerns; cannot run live per Task 2 constraints)

## Files Created
- `src/cli/backfill-term-states.js` (275 lines) — the backfill CLI (`parseArgs`, `loadFederalMemberStateIndex`,
  `loadLegislatorBioguideIndex`, `loadTermIndex`, `resolveFillValue`, `runBackfillTermStates`, `main`).
- `tests/backfill-term-states.test.js` (20 tests) — TDD: written first, watched fail (module not found), then
  implementation went green.

## What was built
Three additive fill rules, `state` written ONLY where currently null (`.is('state', null)` guard on every
update, plus an in-memory `state != null` check before attempting a write at all):
- `us-congress` / house: 2-letter state code via EXACT bioguide_id match against the current congress.gov
  member roster.
- `us-congress` / senate: mechanical copy of the term's own `district` value (already a USPS state
  abbreviation, per the terms.district-as-state convention `ensureFederalMemberMetadata` established) — no
  fetch needed.
- `mo-legislature` (any chamber): constant `'MO'` — the only two jurisdiction_id values used anywhere in this
  codebase are `us-congress` and `mo-legislature` (verified via grep before writing), so no third branch
  exists.

Scale: `selectAll` (src/lib/db.js) for the `terms` and `legislators` bulk reads. The federal member roster
(~2,694 members / 250-per-page) is fetched at most once per run, and skipped entirely when no house term
actually needs it (MO-only or already-fully-filled runs pay zero network cost).

Gating (migration 0016, draft-then-apply): `loadTermIndex` is the one place gating is decided — it attempts
the bulk read WITH `state` included; on `isMissingColumnError(error, 'state')` (PGRST204/42703) it falls back
to the SAME read minus `state` (always succeeds pre-0016) so `termsSeen`/`gatedMissingColumn` stay honest
counts instead of unknown ones — this fallback is the one deliberate departure from the
`backfill-mo-bill-meta.js` `loadSponsorIndex` gate it otherwise mirrors, needed because terms.state (unlike
bill_sponsors' cache-file source) has no independent count source once gated. Once gated, every remaining
candidate is counted `gatedMissingColumn` without a further query, and neither the legislators bulk load nor
the federal roster fetch is attempted at all. A defense-in-depth re-check on the write path (`isMissingColumnError`
on the update's own error) catches the theoretical race where the column vanishes between the pre-flight read
and the write.

## Adapter export reused
`src/adapters/us-congress.js`'s `fetchMemberPage` + `parseMemberList` — the exact pair
`ensureFederalMemberMetadata` (src/cli/enrich-federal-bills.js) already uses to build these members' terms
rows in the first place — plus `isCurrentMember` (src/cli/ingest.js) for the same current-member filter, and
`stateAbbreviation` (src/adapters/us-senate.js) for the same full-name-to-USPS-code bridge. No parallel member
parser was written; `loadFederalMemberStateIndex` is a thin wrapper around that exact pipeline.

## Test summary
20/20 new tests pass (fixture-backed: `tests/fixtures/us-congress/member-page-unfiltered.json` for the
historical-filter/current-member case, `members-mo.json` for a real Ann Wagner → `MO` resolution; fake
selectAll/update clients for the DB-facing loaders and orchestration, mirroring
`backfill-mo-bill-meta-cli.test.js`'s established conventions). Full suite: 1240/1240 pass (1220 baseline +
20 new), 0 fail, 0 regressions.

## Concerns
- Genuinely untestable by me right now: migration 0016 is unapplied and there's no anon key in this
  environment, so the gated/ungated split and the live House/Senate/MO fill logic are verified only against
  fakes and fixtures, never a real Supabase instance or a real congress.gov response beyond the two committed
  fixtures. Step 4 (dry-run → review → live run → Wagner/Pelosi/MO-senate spot checks) is explicitly the
  controller's job after Lance applies 0016 and adds `SUPABASE_ANON_KEY` — matches the plan's own gating.
  Pelosi is not in either committed fixture, so her `state='CA'` claim can only be checked live.
  (Verified `docs/superpowers/plans/2026-07-30-public-site.md`'s own Task 2 section matches
  task-2-brief.md verbatim, checklist still `[ ]` — no plan/brief drift to flag.)
- Dry-run mode still performs the live congress.gov roster fetch when a house term needs it (mirrors
  `backfill-mo-bill-meta.js`'s "dry-run performs every read live mode would" philosophy) — this means a real
  `--dry-run` invocation will make ~11 congress.gov requests (throttled at 3.6s each, ~40s) and requires
  `CONGRESS_API_KEY` in `.env`, distinct from the Supabase anon-key gate. Worth flagging to Lance before he
  runs it, even though no Supabase write happens in that mode.
- `terms.state` for a `us-congress`/senate row with a null `district` (shouldn't occur given how
  `ensureFederalMemberMetadata` creates these rows, but handled defensively) lands in `memberNotFound` rather
  than a dedicated bucket — kept to the brief's exact 5-count shape rather than inventing a 6th.
