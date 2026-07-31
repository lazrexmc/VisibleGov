# Task 2 report — MO sponsors + bill-status backfill

**Status:** complete.

**Commit SHA(s):** `4ba88c8` (branch `profile-completeness`)

**Test summary:** 1052/1052 green, bare `node --test` (1020 pre-existing at commit time + 32 new,
all in `tests/backfill-mo-bill-meta-cli.test.js`). Zero live DB writes/network from tests (fake
write-only client + injected bulk-index-loader functions; the two real-fixture/real-cache-dir tests
read only already-committed local files). Note: the "979/1011" baseline cited in the Global
Constraints had already moved to 1011 -> 1020 by commit time — Task 4's fix-round-1 landed on this
same shared branch mid-task (commit `80ae531`, +9 tests) while this task was in progress; not a
regression here, see that commit's own report.

## Real fixture field names found (source of truth: the two committed dataset fixtures)

Verified directly against `tests/fixtures/research/legiscan/dataset-2018/MO/.../bill/*.json`
(session 1579, 18 bills, 18 sponsor entries) and `dataset-2018-1608/MO/.../bill/*.json` (session
1608, 9 bills, 20 sponsor entries) — nothing guessed:

- Bill payload: `bill_id` (numeric, LegiScan's own internal id — see join-key decision below),
  `bill_number` (`"SB894"`, no space/padding — `normalizeBillIdentifier` already existed for this),
  `status` (numeric lifecycle code: 0/1/4 observed in the two fixtures; 0/1/2/4/5 observed in the
  full 31-file live cache), `status_date`, `history[]` (each entry: `date`, `action`, `chamber`,
  `importance` — no destination column exists for either field, see below), `sponsors[]`.
- Sponsor entry (inside `bill.sponsors[]`): `people_id` (matches `legislators.legiscan_people_id`,
  migration 0010), `sponsor_type_id` (**1 = primary, 2 = cosponsor** in both fixtures — 27 type-1 +
  11 type-2 across 27 bills, always with `sponsor_order:1` for type 1), `sponsor_order`, plus
  person-descriptive fields already covered by `legiscan-identity.js` (`name`, `first_name`,
  `last_name`, `party`, `district`, etc. — not touched here). A full 31-file live-cache scan (not
  just the two fixtures) found `sponsor_type_id` values **0 and 3** also occur in the wider real
  data (LegiScan's own documented "None"/"Joint Sponsor") — handled as a typed, counted skip
  (`sponsorTypeUnknown`), never forced into migration 0014's `check (sponsor_type in
  ('primary','cosponsor'))` constraint.

`status_date` and `history[]`'s last entry were both considered per the brief's wording but are
**not persisted** — `bills` has no destination column for either (mirrors
`ingest-legiscan.js`'s own `ensureLegiscanBillRows` comment, which made the identical call for
`status_date` already). Only `bills.status` is written, as `String(bill.status)` — LegiScan's own
numeric code, printed verbatim, exactly matching `ensureLegiscanBillRows`'s existing convention
rather than inventing a parallel label mapping.

## Join-key decision

`bills` (migration 0001 through 0014) has **no `legiscan_bill_id` column** — confirmed by reading
every migration file, not assumed. The DESIGN FREEZE (0014's own header, echoed in this task's
Global Constraints) also forbids adding one. The only reliable join onto an already-created `bills`
row is the compound key `(session_id, identifier)` — the same key `ensureLegiscanBillRows`
(`src/cli/ingest-legiscan.js`) used to create the row, built via that file's own
`normalizeBillIdentifier(bill_number)` (imported, not reimplemented). `session_id` itself resolves
via `sessions.legiscan_session_id` (migration 0010) — a live pre-flight probe confirmed all 31
cached `legiscan_session_id`s already have a matching live `sessions` row (0 `sessionNotFound` in
the real dry-run below).

## Scale-driven redesign (worth flagging explicitly)

The brief's own precedent (`backfill-nicknames.js`) does one `.maybeSingle()` DB round trip per
candidate — fine there because `extractNicknamePeople` pre-filters down to a small subset. This
task's candidates can't be pre-filtered that way: **every** bill needs a status check and **every**
sponsor needs a legislator lookup. A live pre-flight probe found 37,756 real bill payloads and
45,792 real sponsor entries across the 31 cached ZIPs, against a live `bills` table of 38,250+ rows
— mirroring the nicknames per-candidate shape here would be on the order of 130,000 sequential live
queries (a real timed attempt did not complete in 3 minutes and was killed). Global Constraints
already calls for the fix directly: *"selectAll for every multi-row read (legislators 1,576; bills
38,250 ...)"*. Redesigned around four `selectAll`-based bulk loaders
(`loadSessionIndex`/`loadLegislatorIndex`/`loadBillIndex`/`loadSponsorIndex`, `src/cli/backfill-mo-
bill-meta.js`) run once per run into in-memory `Map`s; the per-bill/per-sponsor loop then does pure
in-memory lookups. The real dry-run below completed in **11 seconds** end to end (~45 paginated
bulk reads total) instead of the multi-hour path the naive design was on. `bill_sponsors` gating
(migration 0014) is decided once, up front, by `loadSponsorIndex`'s own single `selectAll` call
(`isMissingRelationError` on that one call), rather than "gate fires on the first candidate."

## Dry-run counts (live DB, read-only, `node --env-file=.env src/cli/backfill-mo-bill-meta.js
--dry-run`, 2026-07-29)

```
cacheFilesFound: 31        sessionsSeen: 31 (all resolved — 0 sessionNotFound)
billsSeen:              37756
billNotFound:                0   (every bill matched by (session_id, identifier) — join key holds)
statusMissingInSource:       0   (LegiScan's own status is never null in the real cache)
statusAlreadySet:        35709   (additive no-op — already set by LegiScan's own first-insert or a
                                   MO primary-source driver; never touched)
statusPatched (dry-run):     0   (2047 in plan.statusPatches — real work a live run would do)
sponsorsSeen:            45792
sponsorTypeUnknown:       8124   (sponsor_type_id not in {1,2} — typed, counted, never guessed)
sponsorLegislatorNotFound:   0   (every type-1/2 sponsor's legiscan_people_id already resolves)
sponsorAlreadyExists:        0
sponsorGated:                 0
sponsorInserted (dry-run):   0   (37668 in plan.sponsorInserts — real work a live run would do)
cacheMissing:                 0
```

Arithmetic sanity checks (all hold): `statusAlreadySet + statusMissingInSource +
|plan.statusPatches| = 35709 + 0 + 2047 = 37756 = billsSeen`. `sponsorTypeUnknown +
sponsorLegislatorNotFound + sponsorAlreadyExists + |plan.sponsorInserts| = 8124 + 0 + 0 + 37668 =
45792 = sponsorsSeen`. Sampled `plan.statusPatches` values: `{"1": 1838, "2": 136, "4": 72, "5":
1}` — sane LegiScan lifecycle codes, not garbage.

**Finding worth flagging to Lance:** `sponsorGated: 0` and a direct independent probe
(`client.from('bill_sponsors').select('id',{count:'exact',head:true})` → `error: null, count: 0`)
both confirm **migration 0014 is already applied live** (table exists, currently empty) —
contrary to the brief's "draft-then-apply, Lance applies" framing. The gating code path is still
fully implemented and tested (`loadSponsorIndex`'s `gated:true` branch, exercised by fixture
tests) for any future environment where it isn't yet applied, but on the actual target DB right
now the sponsor-write path is live-ready, not blocked.

A live (non-dry-run) execution of this CLI was **not** performed — per the task framing ("Live run
controller-operated"), only the read-only dry-run above ran against production.

## Concerns

- Migration 0014 turned out to already be applied live (see Finding above) — the live run, when
  authorized, will actually insert 37,668 `bill_sponsors` rows and patch 2,047 `bills.status`
  values on the first pass, not a smaller/gated number. Worth a quick sanity skim of a handful of
  the planned sponsor inserts before/after the live run, same spot-check discipline as
  PLAYBOOK_DELTA lesson 13.
- `sponsorTypeUnknown` (8,124 of 45,792 sponsor entries, ~18%) is a large honest-skip bucket —
  these are LegiScan's own `sponsor_type_id` values 0 ("None") and 3 ("Joint Sponsor"), which
  migration 0014's `bill_sponsors.sponsor_type` check constraint has no slot for (only
  `'primary'`/`'cosponsor'`). Flagging for Lance's awareness in case "Joint Sponsor" sponsorship is
  something the product eventually wants to surface — no schema change made here (DESIGN FREEZE /
  don't-guess discipline), just an honest count of what's currently being left out.
- No live linker/backfill run performed by this task — dry-run only, per the brief's own "Live run
  controller-operated" instruction.

---

## Fix round 1

**Status:** complete — the widened-enum mapping, per-type dry-run breakdown, and pre-0015
write-time tolerance are all implemented, execution-proven against fixtures, and re-verified
against the live DB (dry-run only — no live writes, per the task's own framing).

**Commit SHA:** `ede8dc6` (branch `profile-completeness`)

**Test summary:** 1068/1068 green, bare `node --test` (1005 baseline at commit time + 63 in this
task's own two files: 36 in `tests/backfill-mo-bill-meta-cli.test.js` [+4 net over the prior
report: 3 `mapSponsorType` tests replacing 2, 3 new orchestration tests for the breakdown and the
pre-0015 tolerance path (both live-mode and dry-run-mode)], 27 in `tests/db.test.js` [+5 for the
new `isCheckConstraintViolation` predicate]). Zero live DB writes from tests. One transient failure
(`tests/review-page-decisions.test.js`) observed on a single whole-tree run and gone on immediate
re-run, isolated-file run green throughout — a concurrent session was actively editing
`link-persons.js`/`page.html`/`server.js`/their tests in this same working tree at the time (visible
in `git status`), the same cross-process interference pattern Task 4's own report already
documented; not a regression in this task's files.

**1. Mapping — verified against the primary source, not memory or the two small fixtures alone.**
LegiScan's own API manual (`tests/fixtures/research/legiscan/LegiScan_API_User_Manual.pdf`, page
42, "Static Values > Sponsor Types" table) was independently re-extracted via `pdfjs-dist` (already
a repo dependency, used for the MO senate/house PDF adapters) for this fix round — not copied from
a prior session's notes, though a prior session's extracted text (found in the scratchpad) agreed.
The table prints exactly: `0 = Sponsor (Generic / Unspecified)`, `1 = Primary Sponsor`, `2 =
Co-Sponsor`, `3 = Joint Sponsor` — matching migration 0015's own comment. `SPONSOR_TYPE_MAP`
(`src/cli/backfill-mo-bill-meta.js`) now maps all four: `0→'unspecified'`, `1→'primary'`,
`2→'cosponsor'`, `3→'joint'`. A value genuinely outside `{0,1,2,3}` (never observed anywhere) still
returns `null` and is counted `sponsorTypeUnknown` — the live dry-run below shows that bucket is
now **0** (was 8,124), confirming no real MO sponsorship data is discarded anymore.

**2. Pre-0015 tolerance.** `loadSponsorIndex`'s bulk `SELECT` can only detect the 0014 whole-table
gate — a CHECK constraint says nothing until an INSERT actually violates it. Added
`isCheckConstraintViolation(error, constraintName)` (`src/lib/db.js`, same code-primary/
message-corroborated shape as `isMissingRelationError`/`isMissingColumnError`). On a live run, the
first `'joint'`/`'unspecified'` insert attempt that 23514s against the OLD
`bill_sponsors_sponsor_type_check` constraint sets a run-level flag and is counted
`sponsorType0015Gated` (distinct from `sponsorGated`, the 0014 table-missing gate); every later
`'joint'`/`'unspecified'` candidate in the same run is short-circuited without a further live query.
`'primary'`/`'cosponsor'` writes are completely unaffected (both migrations always allow them).
Dry-run cannot discover this (it never writes) — documented as a known, deliberate limitation, not
a bug; a dry-run's `plan.sponsorInserts` for `'joint'`/`'unspecified'` candidates is a preview of
what a live run WOULD attempt, not a guarantee it will succeed if 0015 isn't applied yet.

**3. Per-type dry-run breakdown.** `runBackfillMoBillMeta` now returns `sponsorTypeBreakdown:
{primary, cosponsor, joint, unspecified}` alongside `counts` (both modes — cheap, pure counting,
unlike `plan` which stays dry-run-only) — composition of the SOURCE data by LegiScan's own printed
type, independent of match/write outcome, so an operator sees the real shape before authorizing a
live run. Also threaded into the live-mode `closeRun` detail payload for the same visibility in
`ingestion_runs`.

**4. Tests.** `mapSponsorType(0)==='unspecified'`/`mapSponsorType(3)==='joint'` (citing the
independently re-extracted manual page); a genuinely-unknown id (99, never observed) still skips
typed; the prior "unknown type" orchestration test (which had used `sponsor_type_id:3` — now a
KNOWN, mapped value) was corrected to use 99; a new orchestration test proves the pre-0015 write-time
gate (2 live upsert attempts total for 4 candidates — the successful primary + the one joint that
discovers the gate; the second joint and the unspecified candidate never re-attempt a live write);
a sibling test proves dry-run does NOT apply the tolerance (no live calls at all, `joint` lands in
`plan.sponsorInserts` same as any other type); a breakdown test covers both modes and confirms an
unmatched-legislator candidate still counts toward its type while a genuinely-unknown type is
excluded.

**Updated dry-run counts (live DB, read-only, re-run 2026-07-29 post-fix)**

```
sponsorsSeen:            45792   (unchanged)
sponsorTypeUnknown:           0   (was 8124 — every real LegiScan sponsor type is now mapped)
sponsorTypeBreakdown: { primary: 32337, cosponsor: 5331, joint: 810, unspecified: 7314 }
                                  (sums to 45792 = sponsorsSeen, exact)
sponsorType0015Gated:         0   (0015 not yet applied live at probe time — see below — but this
                                   count is only ever populated by an ACTUAL live write attempt,
                                   which a dry-run never makes; stays 0 in dry-run by construction)
plan.sponsorInserts.length: 45792 (was 37668 — the 8,124 previously-discarded joint/unspecified
                                   rows are now real candidates a live run would attempt)
statusPatched/statusAlreadySet: unchanged (2047 / 35709) — this fix round did not touch the status
                                 path at all
```

Migration 0015 was **not yet applied live** at the time of this dry-run (it was drafted and
committed to the repo, `supabase/migrations/0015_sponsor_types.sql`, but per draft-then-apply,
Lance applies it) — unlike 0014, which the first dry-run found already live. Since a dry-run never
attempts a write, `sponsorType0015Gated` cannot be observed from a dry-run either way; the
write-time tolerance path is proven correct by the new fixture-driven tests above, not by a live
probe (no live write was performed, per this task's "Live run controller-operated" framing).

**Concerns (fix round 1):**
- Once Lance applies migration 0015, the live run will additively insert all 45,792 sponsor rows in
  one pass (up from the pre-fix-round 37,668) — the 7,314 `'unspecified'` and 810 `'joint'` rows are
  real new categories of data landing in `bill_sponsors` for the first time; worth a spot-check of a
  few `'joint'`/`'unspecified'` rows after the live run (same PLAYBOOK_DELTA lesson 13 discipline
  already flagged in the original report).
- If the live run happens to execute BEFORE Lance applies 0015, it will now correctly report
  `sponsorType0015Gated` counts instead of crashing or silently discarding — but the run's
  `bill_sponsors` insert volume would then be capped at `primary`+`cosponsor` only (37,668) until a
  second run completes the rest post-migration; additive/idempotent by construction, so this is safe
  either way, just worth knowing which order actually happened when reading a live run's detail.
