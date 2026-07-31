### Task 5: profile model (pure)

**Files:**
- Create: `site/js/profile-model.js`
- Test: `tests/profile-model.test.js`

**Interfaces:**
- Produces (all pure, no fetch):
  - `buildIdentity({person, legislators, terms})` → `{displayName, party, chamberLabel, districtLabel, careerSpan, photoCandidate, rowCount}`. displayName: `person.display_name` when person present, else the single row's `full_name` as stored — never edited. party: from the most recent term with a party, else legislator.party, else null (render "party unrecorded"). Most-recent term: max non-null `start_date`; when ALL start_dates are null, the term set is date-unproven → careerSpan `'service dates unrecorded'` and chamber/district from any term labeled "as of the {session-era} record" is NOT attempted — label plainly from the term row but suffix the careerSpan honestly.
  - `careerSpan(terms)` → e.g. `'2013 – 2023'`, `'2019 – (end date unrecorded)'`, `'service dates unrecorded'` — never invents currency ("present" is banned; an open end is "(end date unrecorded)").
  - `chamberLabel(jurisdiction_id, chamber)` → 'U.S. Senate' | 'U.S. House' | 'MO Senate' | 'MO House' (exact map, unknown combos → the raw values joined, never dropped).
  - `voteFilterQuery({legislatorIds, chamber, year, page})` → the exact `public_vote_feed` REST path with filters (`legislator_id=in.(...)`, optional `chamber=eq.`, optional `vote_date=gte.YYYY-01-01&vote_date=lt.YYYY+1-01-01`, `order=vote_date.desc.nullslast,cast_id.desc`).
  - `groupSponsorships(sponsorRows)` → `{primary: [], cosponsor: [], joint: [], unspecified: []}` (exact 0015 vocabulary; unknown values throw — fail loud, a new type means a schema change happened).

- [ ] **Step 1: TDD** — failing tests: Onder-shaped fixture (4 linked rows, MO senate 2013-2023 + federal house 2023-) → identity fields exact; null-date-only terms → 'service dates unrecorded'; year+chamber filter path string exact; unknown sponsor_type throws; "present" never appears in any careerSpan output (assert on all fixtures). Run: `node --test` — FAIL.
- [ ] **Step 2: Implement to green. Commit** — `git commit -m "feat: pure profile model (identity, career span honesty, filter queries)"`

