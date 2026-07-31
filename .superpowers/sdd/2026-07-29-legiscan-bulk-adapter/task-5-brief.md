### Task 5: Identity — `legiscan_people_id` find-or-create + mapping to existing MO rows

**Files:** Create `src/adapters/legiscan-identity.js`, `tests/legiscan-identity.test.js`

**Interfaces (Produces):**
```js
export function normalizePersonName(fullName) -> string   // whitespace/case normalization for matching
export async function findCandidateLegislatorRows(client, { fullNameNormalized, chamber, district, sessionStartDate, sessionEndDate })
  // -> era-scoped query against `terms` (chamber + district + start_date/end_date OVERLAP with the
  // session window) joined to `legislators` on full_name (normalized). NEVER a bare district
  // lookup - this is the exact shape of query the mo-senate Critical bug's fix requires. Plain
  // .select() (not selectAll) - the chamber+district+era-window filter bounds this to a handful
  // of candidate rows at most (one seat's occupants across overlapping eras), nowhere near the
  // 1000-row page default selectAll (src/lib/db.js:85) guards against.
export async function resolveOrCreateLegiscanPerson(client, runId, legiscanPerson, sessionWindow)
  // legiscanPerson: { people_id, name, first_name, last_name, party, role, district, ... } (real
  // fixture shape - sponsors[]/roll_call.votes[] entries, see mo-2018-SB894.json)
  // 1. exact-match lookup: legislators.legiscan_people_id = people_id -> if found, done (safe
  //    unique-key path, no fuzzy matching - this is the ONLY path a repeat call for an
  //    already-mapped person ever takes).
  // 2. first time seen: findCandidateLegislatorRows. 0 matches -> INSERT a new legislators row
  //    with legiscan_people_id set, log { matched: false, reason: 'no_candidate' } in run detail
  //    (future identity-merge, TODO item 8, picks this up later - NEVER guessed here).
  //    1 match -> additivePatch-style UPDATE setting legiscan_people_id on that EXISTING row (only
  //    if it doesn't already have a DIFFERENT legiscan_people_id - a conflict there is a hard
  //    error, not a silent overwrite). >1 match -> FAIL LOUD: create a new row anyway (never
  //    guess-merge) and log { matched: false, reason: 'ambiguous', candidateCount } for review.
```

- [ ] TDD against the real SB894 fixture's `sponsors[]` (Douglas Libla `people_id:14996`, role
      `Sen`, district `SD-025`; Travis Fitzwater `people_id:17512`, role `Rep`, district
      `HD-049`) as concrete test people, plus synthetic candidate-row fixtures exercising: 0
      candidates → new row; exactly 1 candidate whose `terms` window overlaps the session → patch;
      2 candidates with overlapping windows (simulating a same-surname collision within one era,
      the mo-senate bug's exact shape) → fail loud, new row + ambiguous log, NEVER pick one;
      repeat call for an already-`legiscan_people_id`-tagged person → the safe unique-key path,
      zero fuzzy matching invoked (assert the fuzzy-match function is NOT called on this path —
      isolation is the point).
- [ ] Implement, green, commit `feat: legiscan identity resolution - people_id find-or-create,
      era-scoped mapping to existing MO rows`.

**Produces:** the ONE place in this plan where the mo-senate bug's risk shape (full_name+chamber+
district fuzzy matching) is exercised — isolated, tested, and run once per person, never in the
hot path of vote-cast resolution (Task 6 only ever does the safe unique-key lookup).


## CONTROLLER RULINGS (binding, appended)

1. IDENTITY-MERGE SEED (standing ruling, from the project owner's recalibration): this task's person-matching is the design seed for cross-source identity merge (TODO 8), not a fifth silo. Build the matching logic as a REUSABLE module (src/lib/person-identity.js) whose match function takes a candidate {full_name, chamber, district, era} and a set of existing legislator rows and returns exactly-one-match | no-match | AMBIGUOUS (fail-loud) — source-agnostic, so bioguide/openstates/mo_house/mo_senate/legiscan attachment can all converge on it over time.
2. THE FIRST REAL MERGE: LegiScan person records carry name/chamber/district. When a LegiScan person matches an EXISTING legislator row (e.g. Bob Onder's mo_senate row: senate + district 2 + name match), the ruling is ATTACH legiscan_people_id to that row (additivePatch — fills null only), creating the project's first cross-source converged identity. No match → new row with legiscan_people_id. AMBIGUOUS → recorded, skipped, never guessed.
3. Name normalization: conservative — case/whitespace/punctuation folding and 'Last, First' ↔ 'First Last' reordering ONLY; no nickname tables, no fuzzy distance (a miss creates a benign duplicate row for future merge; a wrong merge corrupts attribution — asymmetric costs, fail toward duplicates).
4. Fixture test bed: session 1608's 189 people/ records. Assert the real behaviors: a synthetic existing-rows set exercising all three outcomes; and if Onder appears in the 189 (check the fixture), a test with his REAL record against a fake row mirroring his live mo_senate shape.
5. Era: LegiScan dataset people are per-session — the era for matching = the session year(s); reuse the era-scoped philosophy from the mo-senate work (a district match only counts within the same era).
6. NO live DB writes (0010 unapplied; driver attaches later). Pure logic + fake-client tests. isMissingColumnError-gated write helper may be built here for the driver to use, tested with fakes.
