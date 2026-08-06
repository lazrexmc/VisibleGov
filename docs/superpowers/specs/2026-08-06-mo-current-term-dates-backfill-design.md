# MO current-legislator term start-date backfill — design

**Status:** approved design, pre-implementation (2026-08-06)
**Sub-project of:** the public directory "Serving now / Past members" split
(`docs/superpowers/specs/2026-08-...-directory-current-past-design.md`, not yet written — this
backfill is a prerequisite that unblocks tenure display there).
**Origin:** Lance, 2026-08-06 — *"We should fill all the unknown members dates in first."* Preceded by
a 4-agent investigation workflow (`mo-current-term-dates-investigation`, run `wf_9eeed494-93d`) whose
census / provenance / source-inventory / synthesis findings this spec encodes.

---

## 1. Problem

`terms.start_date` and `terms.end_date` are both NULL for **194** rows. Live-verified breakdown:

- All 194 are `state='MO'`; **159 `chamber='house'` + 35 `chamber='senate'`**; one distinct
  `legislator_id` each; **0** of them have a non-null `end_date` (completely dateless).
- Every **federal** (`jurisdiction_id='us-congress'`) term is already dated — filled by
  `src/cli/backfill-federal-names.js` from the cached CC0 `congress-legislators` dataset.
- The handful of **historical** MO members (8 house + 11 senate) already carry real dated spans — the
  residue of an earlier live OpenStates ingest.

So the gap is precisely **the current MO *state* legislators**, and it is dateless **by explicit
design, not a bug**: `src/cli/backfill-mo-terms.js` `insertMoTermRow()` hardcodes
`start_date:null, end_date:null` under a `DATES STAY NULL` header comment reasoning that
*"session-derived dates would invent term boundaries the source does not actually assert."* That guard
is the currency-honesty law written into code. **This spec does not override that reasoning — it
honors it** by sourcing *real asserted* dates (OpenStates), never session-derived inventions.

### 1a. The one non-target: Bob Onder (parked)

Exactly one of the 194 is **not** a current member. `senate` `district=2`, `party='Republican'`
(spelled out — every other row uses `'R'`/`'D'`), and the **only** zero-vote row of the 194 (all 193
others have 427–5,073 vote_casts). He is a former MO senator (term-limited ~2023) who is now the
**US Representative for MO-03** — he has a *separate*, legitimate `us-congress` `district=3` term. The
dateless `senate` D2 row is a stale duplicate of the real current D2 senator **Nick Schroer**
(3,877 votes). **Decision (Lance, 2026-08-06): park it.** The backfill skips Onder's state-senate row
entirely; the directory UI must keep it out of "Serving now" (see §8). Full resolution (assign real
historical dates, or remove/merge) is deferred to TODO 31's `mo_house_id` cross-era-collision work.

### 1b. Scope boundary — the 2026 MO congressional remap is OUT of scope

Missouri redrew its **congressional (US House)** map in 2026. That is explicitly **not** in this
backfill's blast radius, and the spec records why so it isn't re-litigated:

- The `terms` table separates the two systems by `jurisdiction_id`: `mo-legislature` (state, the 193
  targets) vs `us-congress` (the 8-member federal delegation). They never mix here.
- MO **state** house/senate districts follow the 2022 decennial map and did **not** change in 2026;
  the 193 targets are all state seats matched by *state* district.
- Therefore the remap cannot affect any date this backfill writes.
- **Where the remap DOES matter** is the federal delegation and the eventual directory UI: when the UI
  renders the 8 US House members it must use current (2026) districts (sourced from
  `congress-legislators`, which tracks current members). That is a checkpoint for the UI sub-project,
  captured here and in `PLAYBOOK_DELTA.md`, not this one.

## 2. Goal / non-goals

**Goal:** give each of the 193 current MO state legislators a real, source-traceable `start_date`, so
profiles can show tenure ("serving since <year>") and the directory can show term-start years —
without ever asserting a date the source does not support, and without closing any open term.

**Non-goals:** filling `end_date` for anyone (all 193 are open terms — see §5); dating Onder's parked
row; touching federal terms; changing the directory UI (separate sub-project); resolving TODO 31.

## 3. Sourcing decision (author → verify → flag)

Mirrors the project's own trust model: an author proposes, an independent check verifies, mismatches
go to Lance rather than auto-applying.

- **Author (fills the date): the `openstates/people` CC0-1.0 data repo** (GitHub;
  `data/mo/legislature/*.yml` — 192 files ≈ the current seated MO members). **AMENDED 2026-08-06,
  Lance-approved, after Task 1's probe proved the original choice unviable:** the OpenStates v3 REST
  API does not expose role dates at all (live-verified — `include=other_roles` is rejected 422; the
  permitted includes are `other_names/other_identifiers/links/sources/offices`; `current_role`
  carries only title/org_classification/district/division_id, and the adapter's `parsePerson`
  date-reading is defensive dead code). The YAML data repo is what *feeds* that API and carries
  **full role history at day precision** (`roles: [{start_date, end_date, type: lower|upper,
  district}]`) — live-verified on a regular member (Crossley, `2023-01-04`) and a House→Senate
  transition member (Schnelting, three dated roles). It is the direct analog of
  `congress-legislators` (also CC0), which this project already trusts for every federal date.
  Downloaded once into `.superpowers/artifacts/openstates-people/mo-legislature/` with a
  `manifest.json` (source commit SHA + retrieval date); the CLI reads only the cache. Retired
  members (Onder) are structurally absent from the current-legislature directory, preserving the
  parked-row exclusion. Parsing uses the standard `yaml` npm package (new dependency,
  Lance-approved in the same ruling).
- **Verifier (independent, on-disk): the 32 cached LegiScan MO datasets**
  (`.superpowers/artifacts/legiscan-datasets/`). For each member we derive the **earliest qualifying
  session-year** from `people[]` presence gated by `roll_call.chamber` (the `roll_call.chamber`
  `'H'/'S'` test is mandatory — it defeats the back-stamped/corrupt `person.role` field, e.g.
  Bernskoetter shows `role='Sen'` in 2011 datasets when he was a Representative).
- **Reconciliation:** compare the **year** of OpenStates' `start_date` to the LegiScan-derived
  earliest-qualifying year.
  - **Agree** → the term is eligible to be filled with OpenStates' exact date.
  - **Disagree** → **FLAG** the term for Lance's review in the dry-run output; do **not** auto-apply.
  - **OpenStates has no `start_date`** (its `current_role.start_date` may be sparse) → **FLAG** as
    `no-openstates-date`; leave NULL. We do **not** fall back to a LegiScan-year→January-convene date,
    because inventing that January date is exactly the "session-derived boundary" the `DATES STAY
    NULL` guard forbids. The dry-run will quantify how many rows this hits.
- **Wikipedia: rejected as a citation, outright.** It is never written into any stored provenance
  string, source column, or public receipt — a transparency platform citing a crowd-edited source for
  when a legislator took office is self-defeating. It may be used only privately, during development,
  as a human sanity-check, never in the data. It is also *unnecessary*: OpenStates + LegiScan cover
  all 193.

## 4. Where the code lives

**New CLI: `src/cli/backfill-mo-term-dates.js`** — a *date-filler*, deliberately separate from the
*row-creator* `backfill-mo-terms.js` (whose `DATES STAY NULL` identity we leave intact). This mirrors
the federal split exactly: `ingest.js`/`enrich-federal-bills.js` create null-dated federal rows;
`backfill-federal-names.js` fills their dates. New reusable pieces are pure and unit-testable:

- `resolveOpenStatesStart(person, chamber, district)` — pick the matching role's `start_date`.
- `earliestLegiscanYear(peopleId, chamber, datasets)` — the two-signal (presence + `roll_call.chamber`)
  year resolver.
- `reconcile(openStatesDate, legiscanYear)` → `'agree' | 'flag'`.
- `matchRoster(openStatesPeople, dbTerms)` — join OpenStates people to the dateless DB terms by
  `(chamber, district)` with a surname sanity check.

## 5. Data-model & write discipline (non-negotiable invariants)

- **`end_date` is ALWAYS left NULL.** Never infer an end from "last session seen": the newest dataset
  can be early/incomplete, and all 193 sit inside the `end_date IS NULL` open-term set. No live seat
  gets closed.
- **UPDATE in place, never INSERT.** The `terms` unique key is
  `(legislator_id, jurisdiction_id, chamber, district, start_date)` and Postgres treats NULLs as
  distinct — so an INSERT with a real date creates a *duplicate* row beside the null one instead of
  replacing it. The fill must locate the existing null-`start_date` row (the `findExistingMoTerm` key)
  and `UPDATE ... SET start_date = …`.
- **Collision guard:** before each UPDATE, verify there is not already a *dated* OpenStates-residue row
  for the same `(legislator_id, chamber, district)` — if there is, flag rather than write.
  **Disclosure (2026-08-06, implementation-time):** this is not implemented as a separate check. A
  live read-only query against `terms` (2026-08-06) found `mo-legislature` currently has 194 rows,
  **all 194 dateless** — the "8 house + 11 senate already-dated historical residue rows" this spec's
  §1 describes reflects an earlier database state, not the live one, so the premise set for this
  guard (a pre-existing *dated* residue row colliding with a fresh write) is currently empty. The
  guard that is actually live is `updateTermStartDate`'s own `.is('start_date', null)` scope on every
  write (`src/cli/backfill-mo-term-dates.js`) — it is unconditional (not contingent on the collision
  premise ever being nonempty) and mechanically prevents overwriting any row that is not still
  null-dated at write time, which covers this case and any other race on the same row.
- **TODO 31 / `mo_house_id` cross-era collision:** before writing any *house* row, confirm the
  `legislator_id` did not cluster two different-era people; stamping a date onto a cross-era-merged id
  would attribute it to the wrong era. Flag such rows rather than write.

## 6. Algorithm (per dateless MO state term)

1. Load the 194 dateless MO terms (`start_date IS NULL, state='MO'`) with `legislator_id`, `chamber`,
   `district`, `legiscan_people_id`, `full_name`. **Exclude Onder's senate D2 row** (parked).
2. Load the current MO roster (`loadCachedRoster`) from the locally cached `openstates/people`
   CC0-1.0 YAML files (`.superpowers/artifacts/openstates-people/mo-legislature/*.yml`, ~192 files,
   both chambers) — per the §3 amendment, the OpenStates v3 REST API does not expose role dates at
   all, so this reads the cached data-repo YAML directly, not the API; zero live OpenStates calls at
   run time.
3. `matchRoster`: join each OpenStates person to a DB term by `(chamber, district)`; surname must
   match (sanity). Unmatched DB terms and unmatched OpenStates people are both reported.
4. `resolveOpenStatesStart`: the proposed `start_date` is the matched role's real `start_date`.
5. `earliestLegiscanYear`: independently derive the earliest qualifying year on-disk. Edge handling:
   pre-2015 starters (no roll calls before 2015) fall back to earliest `people[]` presence; the 2
   non-continuous House members (Matthiesen, Simmons) use the first year of their *current* post-gap
   run; the 5 House→Senate transition senators are handled correctly by the `roll_call.chamber='S'`
   test with no special case; corrupt `roll_call.date` literals (`1969-12-31`, `0000-00-00`) are
   ignored — anchor on session-year only.
6. `reconcile`: `agree` if `year(openStatesDate) === legiscanYear`; else `flag`.
7. Emit a row into the dry-run table (§7). Only `agree` rows are write-eligible; `flag`, unmatched,
   collision, and cross-era rows are review-only.

## 7. Draft-then-apply: the dry-run table is the deliverable, writes are gated

The **first and only** thing the CLI does by default is a **read-only `--dry-run`** that emits, per
term: `legislator | chamber | district | proposed start_date (OpenStates) | legiscan year | verdict
(agree / flag:<reason>) | provenance string`. **Zero DB writes.** Lance reviews this table; only after
his approval does an explicit `--apply` (or Lance running it himself) perform the `UPDATE`s for the
`agree` rows. This is the draft-then-apply discipline and the mechanical gate.

## 8. Provenance recorded with every filled date

Each filled `start_date` carries a machine-recorded citation via `ingestion_runs.detail` — no new `terms`
column, no migration. The `run_id` is stamped on each updated row; the `citations[]` array in
`ingestion_runs.detail` records:

```
openstates/people@<commit> (CC0-1.0) data/mo/legislature id=<ocd-person> roles[open].start_date=<date>;
verified-against legiscan-dataset earliest-qualifying-year=<year> [people[] presence + roll_call.chamber=<H|S>]
```

The two honesty-critical tokens are the verbatim OpenStates date (what we assert) and the LegiScan
cross-check signal (how it was independently confirmed).

## 9. UI dependency (for the separate directory sub-project)

- Filling `start_date` unblocks **tenure display** ("serving since <year>") on profiles and the
  directory — impossible today because every current-MO term is dateless.
- **Onder exclusion is a shared dependency.** Because his parked row keeps `end_date = NULL`, a naive
  "open term ⇒ serving now" rule would place him in Current, producing a visible D2 duplicate with
  Schroer. The directory's "Serving now" test must therefore be **"open term AND has recorded
  votes"** (or equivalent), which cleanly excludes the zero-vote stale row and generalizes to any
  future stale duplicate. This is specified here as the dependency; implemented in the UI sub-project.
- **Federal members on the 2026 map** (§1b): the UI must render the 8 US House members with current
  districts.

## 10. Testing (fixture-backed, matching repo convention)

Unit tests against captured fixtures (no live network in tests; never `source .env` before
`node --test`):

- `resolveOpenStatesStart`: picks the correct role's date for a member with multiple roles.
- `matchRoster`: joins by `(chamber, district)`; reports unmatched on both sides; rejects a
  surname mismatch.
- `earliestLegiscanYear`: presence + `roll_call.chamber` gating; the Bernskoetter corrupt-role case
  resolves to the correct Senate year; the non-continuous post-gap case; the pre-2015 fallback.
- `reconcile`: agree vs flag on year match/mismatch.
- **Invariant tests:** the writer never emits a non-null `end_date`; the writer issues UPDATE (not
  INSERT) keyed on the null-`start_date` row; Onder's senate D2 row is excluded from the target set.
- Dry-run emits every target with a verdict and a provenance string; `--apply` writes only `agree`
  rows.

## 11. Constraints

- **Draft-then-apply:** dry-run first, Lance approves, then apply. No unattended DB writes.
- **Secrets:** never print `OPENSTATES_API_KEY` / Supabase key values; use by name only.
- **OpenStates free tier:** stay inside the existing 7 s-interval limiter; the roster fetch is small.
- **No LLM/API-spend gate applies** (OpenStates is a data API, not an LLM; the LLM-spend rule is
  suspended anyway).

## 12. Rollout

1. Build the pure resolvers + the new CLI with `--dry-run` default (TDD, per the plan).
2. Produce the dry-run resolution table over all 193 → Lance reviews (draft-then-apply).
3. Resolve any `flag` rows with Lance.
4. `--apply` the `agree` rows (Lance runs or approves); verify live: dateless-MO count drops toward 1
   (only Onder's parked row remains), `end_date` still NULL for all.
5. Hand off to the directory "Serving now / Past members" sub-project (now unblocked for tenure).
