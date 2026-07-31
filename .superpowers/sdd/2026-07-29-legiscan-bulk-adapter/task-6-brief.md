### Task 6: Votes + casts ingestion — reconcile-or-throw, cross-check, collision-safe keys

**Files:** Create `src/adapters/legiscan-votes.js`, `tests/legiscan-votes.test.js`

**Interfaces (Produces):**
```js
export const VOTE_ID_MAP = { 1: 'yea', 2: 'nay', 3: 'not_voting', 4: 'absent' };
  // per docs/research/2026-07-27-mo-data-sources.md Q2 (schema-mysql.sql ls_vote table) - ONLY
  // these 4 values are confirmed. Any other vote_id -> typed error, never silently -> 'other'.
export class VoteIdMapError extends Error {}
export function buildLegiscanVoteSourceKey(rollCallId) -> string  // 'legiscan-mo-<roll_call_id>'
  // roll_call_id is LegiScan's own globally-unique key - cannot collide with 'mo-senate-web-*' or
  // 'mo-house-xml-*' prefixes by construction (different alphabet/shape entirely).
export function reconcileLegiscanTallies(rollCall)
  // -> throws RollCallParseError-shaped error if parsed votes[] position counts != rollCall's own
  // printed yea/nay/nv/absent - mirrors parseMoRollCall's gate exactly, applied to LegiScan's OWN
  // printed numbers (not a primary-source cross-check yet - that's the next function).
export async function crossCheckAgainstPrimarySource(client, billId, legiscanTallies)
  // -> { checked: bool, matched: bool|null, flag: {...}|null } - looks up an ALREADY-STORED
  // primary-source vote for the same bill_id/chamber/approximate date (mo-house-xml or
  // mo-senate-journal-pdf source_key prefix); if none exists, checked:false (opportunistic, not
  // blocking - LegiScan covers far more sessions than the primary parsers have reached). If one
  // exists and tallies disagree, writes a vote_reconciliation_flags row (Task 1) and returns
  // matched:false - the LegiScan vote is NOT quarantined outright (its OWN internal reconcile
  // already passed) but the disagreement is durably flagged for human review, never silently
  // dropped either direction. Single-row lookup by bill_id+chamber+date (at most one primary-
  // source vote per real roll call) - plain .select(), selectAll (src/lib/db.js:85) not needed.
```

- [ ] TDD against the real roll-call-747209 fixture (yea=121,nay=19,nv=0,absent=21,total=161 —
      161 individual casts, EXACT match required): `reconcileLegiscanTallies` passes on the real
      fixture; a mutated copy (drop one Yea cast) throws. `VOTE_ID_MAP` covers vote_id 1/2/4 (the
      fixture has no `3` example — note this gap, don't fabricate a test for an unobserved value);
      an unrecognized vote_id (5, synthetic) throws `VoteIdMapError`, never defaults to `'other'`.
      `buildLegiscanVoteSourceKey(747209)` → `'legiscan-mo-747209'`; assert it never matches
      `/^mo-senate-web-/` or `/^mo-house-xml-/` (collision-safety, directly tested). Note the
      LegiScan/MO-House PDF category mismatch found during planning (LegiScan's `ls_vote` has no
      distinct "Present" code; MO House's own `Y/N/P/@` PDF tallies do) as a KNOWN cross-check
      caveat in this task's own comment — a genuine "Present" cast may show up as a LegiScan
      `not_voting`/`absent` disagreement against a primary-source tally that isn't a real error;
      `crossCheckAgainstPrimarySource` must record the caveat in the flag row, not just a bare
      mismatch, so a human reviewer isn't misled.
- [ ] `crossCheckAgainstPrimarySource` tests with fakes: no existing primary-source vote → `checked:false`;
      matching tallies → `matched:true`, no flag row; disagreeing tallies → flag row written,
      `matched:false`, LegiScan vote still stored (its own internal gate already passed).
- [ ] Implement, green, commit `feat: legiscan votes/casts - reconcile-or-throw + primary-source
      cross-check, collision-safe source_key`.


## CONTROLLER RULINGS (binding, appended)

1. DUAL RECONCILE GATES, in order: (a) INTERNAL — each roll_call's votes[] counted per position MUST equal its own printed yea/nay/nv/absent/total fields or that roll call is a typed, counted failure (never stored); verify the vote_id→position mapping against the REAL fixture payloads (do not trust recalled LegiScan docs — derive from vote_text which the fixture also carries, and assert vote_id↔vote_text consistency across all 8 real roll calls). (b) CROSS-SOURCE — where we already hold a primary-source tally for the same vote (House XML aggregates, Senate journal counts), compare; discrepancy → vote_reconciliation_flags row (0010, applied live) + the vote quarantined (not stored in votes/vote_casts), never silently resolved either way. Absence of a primary-source counterpart is NOT a failure (LegiScan-only votes store normally with gate (a) alone — that's the whole point of the backfill).
2. source_key: 'legiscan-<legiscan_session_id>-rollcall-<roll_call_id>' — collision-proof against 'mo-senate-web-*'/'mo-house-xml-*' by prefix. Matching an EXISTING primary-source vote row for cross-check: by (jurisdiction, chamber, date, bill identifier) — exact match only, ambiguity → flags row, never guessed.
3. Casts resolve via Task 5's mapping (legiscan_people_id → legislator_id); an unmapped people_id is an unresolved cast (honest count + sample), never guessed. positions map mechanically from the verified vote_id mapping; 'nv' → 'not_voting' (the enum has it — unlike the journals, LegiScan distinguishes nv from absent; preserve the distinction).
4. Bill linkage: roll_call.bill_id → Task 4's parsed bill records → our bills rows by LegiScan bill identifier normalization (the dataset bill payloads carry the printed bill_number — normalize to 'TYPE NNN' per normalizeMoBillIdentifier's convention; read it, don't re-implement).
5. Pure logic + fake-client tests; NO live DB writes (driver task owns those); fixtures: the 8 real roll calls in dataset-2018-1608 are your test bed — assert the REAL parsed totals per roll call.
