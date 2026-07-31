# Task 5 report — LegiScan identity resolution (people_id find-or-create, era-scoped mapping)

Commit: `67c4a34` — `feat: legiscan identity resolution - people_id find-or-create, era-scoped
mapping to existing MO rows`

## Module design (CONTROLLER RULING 1 — the identity-merge seed)

Split into two files, per the binding ruling that this task's matching logic is the design seed
for cross-source identity merge (TODO item 8), not a fifth per-source silo:

- **`src/lib/person-identity.js`** (new) — reusable, source-agnostic, touches no database:
  - `normalizePersonName(fullName)` — the canonical normalizer (see below).
  - `eraOverlaps(row, era)` — pure date-range overlap on ISO `YYYY-MM-DD` strings (string
    comparison is safe: fixed-width, zero-padded). Either side may be `null` (open-ended term /
    unbounded era) — treated as "cannot rule out overlap," never as a forced true or false.
  - `matchLegislator(candidate, existingRows)` — **the** reusable matching function ruling 1 calls
    for by name: `candidate = { full_name, chamber, district, era: { start, end } }`,
    `existingRows` a pool of `{ legislator_id, full_name, chamber, district, start_date, end_date }`.
    Filters on chamber + district + `eraOverlaps` + `normalizePersonName` equality, then **dedupes
    by `legislator_id`** before classifying — two overlapping `terms` rows for the *same* real
    person (e.g. non-consecutive terms in the same seat) collapse to one candidate rather than
    reading as a false ambiguous collision. Returns `{ outcome: 'match'|'no_match'|'ambiguous',
    matches: [...] }` (never throws — "fail loud" is the caller's job, since a pure matcher
    throwing on ambiguity would make the ambiguous-but-still-create-a-row path awkward to express).
- **`src/adapters/legiscan-identity.js`** (new) — the LegiScan-shaped glue, source-specific:
  - `chamberFromRole(role)` — `'Sen'->'senate'`, `'Rep'->'house'`; anything else throws
    `UnrecognizedLegiscanRoleError` (verified exhaustive against the real 189-person fixture: only
    these two role strings occur, zero exceptions).
  - `normalizeLegiscanDistrict(district)` — `'SD-002'->'2'`, `'HD-049'->'49'` (regex
    `/^[SH]D-?(\d+)$/i`, strips the chamber-letter prefix + leading zeros). An unrecognized shape
    passes through unchanged (never a silent guess) — a downstream 0-candidate result is the
    honest failure mode.
  - `findCandidateLegislatorRows(client, { fullNameNormalized, chamber, district,
    sessionStartDate, sessionEndDate })` — queries `terms` (server-side `.eq('chamber',
    ...).eq('district', ...)`, bounding the row count to one seat's occupants across every era on
    file) joined to `legislators(full_name)`, reshapes into `matchLegislator`'s pool shape, and
    returns `matches` (a plain array — length 0/1/2+ is the caller's branch signal). Plain
    `.select()`, not `selectAll` — correct per the brief's own reasoning.
  - `resolveOrCreateLegiscanPerson(client, runId, legiscanPerson, sessionWindow)` — the
    three-outcome resolver (below). `re-exports normalizePersonName` from `person-identity.js` so
    the brief's original literal export list stays satisfied even though the canonical
    implementation moved to the shared module.
  - `LegiscanIdentityConflictError` — thrown (never silently swallowed) when a single-candidate
    match's existing row already carries a *different* `legiscan_people_id`.

## The three-outcome semantics

1. **Exact-key lookup first, always**: `legislators.legiscan_people_id = people_id`. Found -> done
   (`reason: 'exact_key'`), **zero fuzzy matching invoked** — directly tested via a fake `terms`
   handler that `throw`s if queried at all; the repeat-call test asserts no throw occurs. This is
   the isolation the brief's "Produces" note calls out: the fragile matching runs at most once per
   real person, never in Task 6's per-vote-cast hot path.
2. **First time seen** -> `findCandidateLegislatorRows`:
   - **0 candidates** -> INSERT a new `legislators` row with `legiscan_people_id` set,
     `reason: 'no_candidate'`. Never guessed; TODO 8 picks it up later.
   - **1 candidate** -> re-read that row by id; if it already carries a *different*
     `legiscan_people_id`, throw `LegiscanIdentityConflictError` (a hard error — checked
     explicitly, before `additivePatch` runs, since `additivePatch`'s own fills-null-only
     semantics would otherwise just silently skip the field on a conflict, which the brief
     explicitly forbids). Otherwise `additivePatch(existing, { legiscan_people_id })` and UPDATE
     (`reason: 'single_candidate'`).
   - **>1 candidates** -> FAIL LOUD: INSERT a new row anyway (never guess-merge),
     `reason: 'ambiguous', candidateCount: N` for future review.
3. Every write path is `isMissingColumnError`-gated (`PGRST204`/`42703` on `legiscan_people_id`) —
   returns `{ gated: true, matched: false, reason: 'missing_column', note: '...migration 0010...' }`
   rather than throwing, mirroring `ensureRosterIdentities`'s own gate convention. Checked at the
   very first query, so a missing column short-circuits before any candidate search or write is
   attempted.

## Real fixture numbers (dataset-2018-1608, the 189-person fixture)

Decoded via Task 4's own proven pipeline (`decodeDatasetZip` + `extractDatasetFiles` against
`mo-2018-dataset-1608.json`), not re-parsed independently:

- **189/189 people records carry a non-empty `district` field** — zero exceptions.
- **Role: 156 `Rep` / 33 `Sen`** — these are the *only* two role strings present (verified
  exhaustive, backs `chamberFromRole`'s throw-on-anything-else design).
- **District shape: 100% `[SH]D-\d+`** (`HD-N` x156, `SD-N` x33) — zero exceptions, backs
  `normalizeLegiscanDistrict`'s regex being safe to apply unconditionally across this fixture.
- **Party: only `'R'`/`'D'`** observed across all 189.

## Onder-in-fixture verdict (CONTROLLER RULING 4)

**Present.** `people_id: 16351`, exact record:
```json
{"people_id":16351,"person_hash":"3ma48iug","party":"R","role":"Sen","name":"Robert Onder",
 "first_name":"Robert","middle_name":"Frank","last_name":"Onder","suffix":"Jr.","nickname":"Bob",
 "district":"SD-002", ...}
```

**Real finding, not assumed**: matched (in `tests/legiscan-identity.test.js`) against a fake row
mirroring his *actual live* `mo_senate` shape — `full_name: 'Bob Onder'`, `mo_senate_id: '2'`,
term `2015-01-07` to `2023-01-04` (all verified against `tests/mo-senate-web.test.js` /
`tests/ingest-mo-senate-cli.test.js` / `docs/research/2026-07-28-mo-senate-sources.md`) — this is
a **genuine `no_match`**, not a match. LegiScan's own `name` field is `"Robert Onder"`;
`normalizePersonName` folds case/whitespace/punctuation and reorders `"Last, First"` but does
**not** bridge `nickname: "Bob"` to `first_name: "Robert"` (ruling 3 forbids a nickname table by
design). So `resolveOrCreateLegiscanPerson` creates a **second, benign duplicate row** for
LegiScan's "Robert Onder" rather than attaching to the existing "Bob Onder" row — exactly the
asymmetric-cost tradeoff ruling 3 calls for (a miss is cheap and fixable later by TODO 8; a wrong
merge is not). Worth flagging because ruling 2's own illustrative text names Onder as *the*
worked "first real merge" example — the real fixture data shows that specific pairing does **not**
clear the bar this task was told to hold, which is the point of testing against his real record
rather than a synthesized one.

## Normalization decisions with examples

- **`normalizePersonName`**: lowercase; strip `. , ' " ( )`; collapse whitespace; if the input
  contains a comma, treat it as `"Last, First..."` and reorder to `"First... Last"` before folding.
  Examples: `"Douglas   Libla"` -> `"douglas libla"`; `"O'Brien, Mary-Jane"` -> `"mary-jane obrien"`;
  `"Onder, Robert F."` -> `"robert f onder"` == `normalizePersonName("Robert F. Onder")`.
  Explicitly **not** normalized: nicknames (`"Bob"` vs `"Robert"` stay distinct), fuzzy/edit-distance
  matches, initials expansion.
- **`normalizeLegiscanDistrict`**: strip the chamber-letter prefix (`SD-`/`HD-`, case-insensitive,
  dash optional) and leading zeros. `"SD-002"->"2"`, `"HD-049"->"49"`, `"SD-025"->"25"` (Libla's
  real district). Unrecognized input (e.g. `"AL"` for an at-large-style code, never observed in
  either real fixture) passes through unchanged rather than guessing.
- **Chamber**: `role` string only (`'Sen'`/`'Rep'`), not `role_id` — the fixtures always carry both
  redundantly; `role` is what every other real record in this plan (sponsors, vote casts) actually
  uses verbatim, so `role_id` was left unused rather than adding a second parallel mapping.

## Test suite

21 new tests in `tests/legiscan-identity.test.js`, all fake-client/fixture-backed — real SB894
sponsors (Libla `people_id:14996` Sen/SD-025 zero-candidate-create path; Fitzwater
`people_id:17512` Rep/HD-049 single-candidate-attach path), the real Onder record (above), a
synthetic same-name two-candidate ambiguous case (new row + `candidateCount:2`, neither existing
row touched), the exact-key repeat-call isolation test (fake `terms` handler throws if queried —
proves zero fuzzy matching on that path), a conflicting-`legiscan_people_id` hard-error test, a
missing-column gated test, plus direct unit coverage of `normalizePersonName` / `chamberFromRole` /
`normalizeLegiscanDistrict` / `eraOverlaps` / `matchLegislator`'s legislator_id dedupe, and the
"never a bare district lookup" chamber-discrimination test.

**Full suite: 695/695 green** (`node --test`, bare invocation) — 674 baseline + 21 new. No live DB
writes, no network calls anywhere in the new code or tests.

## Concerns / forward flags

1. **The `terms` table has no rows for MO Senate members today.** `ensureRosterIdentities`
   (`src/cli/ingest-mo-senate.js`) writes only `legislators.mo_senate_id` directly — it never
   inserts a `terms` row. So `findCandidateLegislatorRows` would find **zero** real candidates for
   any currently-persisted MO Senate legislator (including the real Onder row), independent of the
   name-mismatch finding above — a second, structural reason today's MO Senate rows can't yet be
   matched by this task's design. Out of scope to fix here (Task 5 only builds the matching logic;
   backfilling `terms` rows for the mo-senate/mo-house drivers is a separate, not-yet-scoped gap)
   but load-bearing for Task 9's real-world hit rate and worth flagging before that task assumes
   otherwise.
2. **The Onder "first real merge" worked example in ruling 2 does not actually clear the bar**, per
   the finding above — a real, intentional consequence of ruling 3's conservative-only
   normalization, not a bug, but worth Lance's explicit awareness since the plan text reads as if
   it expects a match.
3. **`resolveOrCreateLegiscanPerson`'s "already_attached" branch (empty `additivePatch` on the
   single-candidate path) is defensive/unreachable in normal operation** — if a row's
   `legiscan_people_id` already equals the incoming id, the exact-key lookup at the top would have
   already found it. Kept as a belt-and-suspenders no-op (consistent with this codebase's existing
   style) rather than removed; not separately tested since forcing it requires an artificially
   inconsistent fake DB, not a real reachable state.
4. **Migration 0010 is still unapplied** (Lance applies) — every write path in this module is
   `isMissingColumnError`-gated and tested with `missingColumn: true`, so the module degrades
   honestly today; nothing here requires the migration to land before Task 6/9 can be built and
   tested against fakes. **(Superseded — see Fix round 1: migration 0010 is now applied live.)**

## Fix round 1 (controller adjudication)

Both substantive concerns (1 and 2) were adjudicated as real gaps, not accepted limitations, and
fixed. Concern 3 (dead code) was adjudicated as no-action. Also: **migration 0010 is confirmed
applied live** (post-dates the original context above) — the `isMissingColumnError` gated paths
are kept regardless (defensive against any environment/schema-cache state where the column is
genuinely absent), per the controller's explicit instruction.

**Commit:** `1b495aa` — a new commit on top of `67c4a34`, not an amend.

### Ruling 3 amended (concern 2) — source-printed nickname variants

Conservative normalization stands, with one principled extension: when the source itself prints an
alternate name form (LegiScan's own `person.nickname` field), the candidate's name-variant set
becomes `{ given-name form, nickname form }`, each matched **exactly** under the same folding —
still no fuzzy/edit-distance matching, still no nickname *table* invented by this module. This is
the source's own printed data, so the asymmetric-cost rule is intact; ambiguity *across* variants
(one variant hits row A, a different variant hits a different row B) is still `ambiguous`, never
picked.

- `src/lib/person-identity.js`: `matchLegislator`'s candidate shape gains an optional
  `nameVariants` array (raw alternate full names); a new internal `buildNameVariantSet` unions
  `normalizePersonName(full_name)` with `normalizePersonName(...)` of each variant into a `Set`,
  and matching becomes `nameVariants.has(normalizePersonName(row.full_name))` instead of a single
  string `===`. `normalizePersonName` itself is **unchanged** — the nickname bridge lives one layer
  up, in the variant set, not inside the normalizer (the earlier test proving `"Bob Onder"` and
  `"Robert Onder"` normalize to different strings is still true and still in the suite — it
  documents the *normalizer's* contract, not the *matcher's*).
- `src/adapters/legiscan-identity.js`: new `buildLegiscanNameVariants(legiscanPerson)` — returns
  `[name]`, or `[name, "${nickname} ${last_name}"]` when `nickname` is non-empty. The nickname
  variant is built in the SAME shape LegiScan's own `name` field already is (first + last, no
  middle name, no suffix — verified: Onder's own `name` omits `middle_name:"Frank"` and
  `suffix:"Jr."` too), just with `nickname` substituted for the given first name:
  `"Robert Onder"`+`nickname:"Bob"` -> variants `["Robert Onder", "Bob Onder"]`.
  `resolveOrCreateLegiscanPerson` now computes and passes `nameVariantsNormalized` through to
  `findCandidateLegislatorRows`.
- **Result: Onder's real fixture record now matches and attaches** — see below, the corrected
  verdict.

### Concern 1 fixed — per-source identity columns as fallback evidence

`findCandidateLegislatorRows` now gathers candidates from **two** sources, unioned:
1. `terms` rows (chamber + district, server-side filter) — **preferred**, carries real
   `start_date`/`end_date` so era-overlap is a genuine check.
2. **New fallback**: `legislators.mo_senate_id` (chamber `'senate'`) / `legislators.mo_house_id`
   (chamber `'house'`) — a row with `mo_senate_id='2'` *is* senate/district-2 evidence (the column
   exists only for MO senators, stamped only by `ensureRosterIdentities`). Used **only** for
   legislator_ids the `terms` query did not already find (no double-counting when both exist — a
   dedicated test proves this). Column-derived rows carry `start_date: null, end_date: null` — no
   date evidence exists at that layer, so `eraOverlaps` can never rule them out; this is documented
   as a real, honest limitation, not silently assumed correct. `isMissingColumnError`-guarded per
   column (mirrors the `legiscan_people_id` gate) — a missing `mo_senate_id`/`mo_house_id` column
   makes that fallback contribute nothing, non-fatal to the overall lookup.
3. A row with **neither** `terms` evidence nor the relevant chamber column set is never fetched by
   either query — never a candidate, an honest exclusion (directly tested).

This closes the real, load-bearing gap flagged in concern 1: `ensureRosterIdentities`
(`src/cli/ingest-mo-senate.js`) stamps `mo_senate_id` directly onto the `legislators` row but
writes **no** `terms` row at all — without this fallback, every currently-persisted MO Senate
legislator (including the real Onder row) would be structurally unreachable by this task's
matching, independent of the nickname finding.

### Onder-merge verdict, corrected

With both fixes in place, the test now mirrors the **real current DB shape exactly** (a
`legislators` row with `full_name:'Bob Onder'`, `mo_senate_id:'2'`, and **no** `terms` row —
matching what `ensureRosterIdentities` actually writes today): LegiScan's real Onder record
(`people_id:16351`, `name:"Robert Onder"`, `nickname:"Bob"`, `role:"Sen"`, `district:"SD-002"`)
now resolves via the column-derived-evidence fallback (path 2 above) + the nickname variant (Ruling
3 amendment) to **exactly one candidate**, and `resolveOrCreateLegiscanPerson` returns
`{ matched: true, created: false, reason: 'single_candidate' }` — `legiscan_people_id: 16351` is
attached to the existing `'Bob Onder'` row via `additivePatch`. **This is the project's first real
cross-source identity convergence** — no new row, no duplicate. A second test proves the
amendment's own guardrail: a nickname variant that happens to collide with a genuinely *different*
existing row's name still resolves `ambiguous` (two distinct `legislator_id`s hit by two different
variants), never picked.

### New/changed tests

7 new tests in `tests/legiscan-identity.test.js`: `buildLegiscanNameVariants` (no-nickname and
with-nickname shapes), the corrected Onder match+attach test (column-evidence-only, no `terms`
row — the realistic shape), the nickname-collision-is-ambiguous test, and three
`findCandidateLegislatorRows` evidence-path tests (terms-only, column-only, terms+column
no-double-count) plus the neither-case exclusion test. The old Onder "no_match" test was replaced
(not kept alongside) since it asserted behavior the amended ruling now makes incorrect; the
underlying normalizer-level fact it partially documented (`normalizePersonName` alone doesn't
bridge nicknames) remains covered by its own still-passing, unchanged unit test.

**Full suite: 702/702 green** (`node --test`, bare invocation) — 674 baseline + 28 in
`tests/legiscan-identity.test.js` (21 original + 7 fix-round). No live DB writes, no network calls
anywhere in the new or changed code or tests.

## Fix round 2 (code review: 1 Critical, empirically reproduced against the real module + 2 minors
promoted)

### CRITICAL — `terms` has no jurisdiction scoping (reviewer-reproduced)

`findCandidateLegislatorRows`'s `terms` query (`src/adapters/legiscan-identity.js`) filtered only
on `chamber` + `district` — `terms` is a table SHARED across every jurisdiction this repo ingests
(`src/cli/ingest.js`'s `persistUsCongress` and `persistMoLegislature` both write plain `terms`
rows, same `chamber`/`district` vocabulary). The reviewer reproduced a MO LegiScan sponsor's
`legiscan_people_id` attaching to a FEDERAL legislator's row as a false `'single_candidate'` match,
whenever a us-congress `terms` row happened to share chamber + bare-number district + normalized
name with an MO candidate.

**Fix**: added `.eq('jurisdiction_id', MO_JURISDICTION_ID)` (hardcoded `'mo-legislature'`) to the
`terms` query in `legiscan-identity.js` — deliberately kept in the LegiScan-specific adapter file,
NOT pushed into `src/lib/person-identity.js`, so the reusable matcher stays jurisdiction-agnostic
per ruling 1 (a future bioguide/openstates source supplies its own jurisdiction scoping the same
way, at its own DB-query layer). The `mo_senate_id`/`mo_house_id` column-derived fallback needs no
equivalent filter — those columns are MO-only by construction (migrations 0008/0005), never
written by any other jurisdiction's driver, so there is no collision surface there.

**Regression tests** (the review noted the OLD fake DB structurally could not have caught this
class — its `terms` fake never modeled a second jurisdiction at all): the fake `terms` query
builder was rewritten into a generic thenable chain (accumulates any number of `.eq()` filters,
resolves on `await`) so it can model the real 3-filter query, and every `termRows` fixture across
the file now carries its own `jurisdiction_id` (an omission would have silently broken every
existing test, since the fake now filters on it exactly like the real query). Two new tests: a
direct `findCandidateLegislatorRows` test with a `jurisdiction_id:'us-congress'` term row sharing
chamber+district+name — asserts 0 candidates; and an end-to-end `resolveOrCreateLegiscanPerson`
test — a MO sponsor whose chamber+district+name coincidentally matches a federal row resolves
`no_candidate` (a new MO row is created), and the federal row's `legiscan_people_id` stays `null`.
**Verified the regression tests are load-bearing, not tautological**: temporarily reverted the
`.eq('jurisdiction_id', ...)` line and re-ran the suite — both new tests genuinely failed
(`ERR_ASSERTION`, `actual: true` where `false` was expected); restored the fix and confirmed green
again before committing.

### MINOR 1 (promoted) — `surname` never populated on `legislators` rows this module creates

Rows created on the `no_candidate`/`ambiguous` paths only ever set `full_name`, leaving `surname`
null — unlike `ensureRosterIdentities`'s own inserts (`src/cli/ingest-mo-senate.js`), which always
set it. A future surname-based resolver would be blind to LegiScan-originated rows. **Fixed**: new
`legiscanSurname(legiscanPerson)` populates `surname` from the SOURCE's own printed `last_name`
field (verified present, verbatim, on every real fixture record used in this suite — Onder, Libla,
Fitzwater) on BOTH insert paths. Explicitly **never** derived by splitting `full_name` — this
project has already been burned twice by exactly that (migration
`0006_legislators_surname.sql`'s own header comment records the first occurrence, for
`mo-house-xml.js`'s roster). Absent/empty `last_name` on a given record -> `surname: null`, never
guessed. Three new tests: `no_candidate` path (Libla -> `'Libla'`), `ambiguous` path (also
populated, not just the common case), and an absent-`last_name` record -> `null`.

### MINOR 2 — nickname identical to first_name (locked)

`buildLegiscanNameVariants` can produce a variant set with a duplicate entry after normalization
(e.g. `nickname === first_name`) — already harmless by construction, since
`buildNameVariantSet` (`src/lib/person-identity.js`) folds variants into a `Set` before matching,
so a duplicate collapses rather than double-counting toward a false ambiguous. New test locks this
exact shape: a synthetic person with `nickname:'Travis'`/`first_name:'Travis'` (matching Fitzwater's
own first name) produces `['Travis Fitzwater', 'Travis Fitzwater']` from `buildLegiscanNameVariants`,
and the full `resolveOrCreateLegiscanPerson` call against a single real candidate still resolves
cleanly to `'single_candidate'`, not `'ambiguous'`.

### Test suite

6 new tests (2 Critical regression — direct `findCandidateLegislatorRows` + end-to-end
`resolveOrCreateLegiscanPerson`; 3 Minor-1 surname — `no_candidate` path, `ambiguous` path,
absent-`last_name` -> null; 1 Minor-2 — nickname-identical-to-first_name lock). Plus every existing
`termRows` fixture in the file gained a `jurisdiction_id` field (required by the CRITICAL fix — an
omission would silently break the now-jurisdiction-filtered fake), and the Libla `no_candidate`
insert-shape assertion gained `surname: 'Libla'`. `tests/legiscan-identity.test.js`: 34 tests total
(21 task-5 original + 7 fix-round-1 + 6 fix-round-2). **Full suite: 708/708 green** (`node --test`,
bare) — 674 baseline + 34. No live DB writes, no network calls anywhere in the new or changed code
or tests.

**Commit:** `1a8153f` — a new commit on top of `1b495aa`, not an amend.
