### Task 8b: launch-data completeness — three $0 backfills (findings D1/D2 + at-large)

**Files:**
- Create: `src/cli/backfill-mo-terms.js`, `src/cli/backfill-federal-names.js`, tests for both
- Modify: `src/adapters/us-congress.js` (at-large members yield district `'0'`, not null)
- Test: extend `tests/` per fixture patterns

**Interfaces / rules:**
- **MO terms (D1):** from the LATEST MO session's cached LegiScan dataset people records (walk-back ruling: latest-session roster only — it serves address lookup with one honest answer per seat; historical MO terms are a later, separate concern). Per person with a matching `legiscan_people_id` legislator row: insert a terms row {jurisdiction_id:'mo-legislature', chamber (from the LegiScan role), district (normalized digits, as printed), state:'MO', party (as printed), start_date/end_date null} via check-then-insert against the existing unique constraint. Dates stay null — session-derived dates would invent term boundaries; the site's date-honesty language already covers null dates. Honest counts {peopleSeen, termsInserted, alreadyPresent, noMatchingLegislator, skippedNonLegislator}.
- **Federal names (D2):** fill `full_name`/`party` for legislator rows where `full_name` equals `bioguide_id` (our own placeholder artifact from roll-call ingestion — correcting a synthetic placeholder is NOT the Lance-gated real-value-overwrite class; the update is guarded `eq('full_name', bioguide_id)` so a real name can never be touched). Source: Congress.gov `/member/congress/119` paginated (covers departed members the current-member fill skipped), existing polite limiter + parseMemberList; bioguide exact match only. Honest counts {placeholdersSeen, filled, noMemberFound, alreadyReal}.
- **At-large (D3):** adapter change — `district: '0'` for at-large House members (comment: Census CD '00' convention; the site's null-bridge stays for old rows) + a fills-null backfill inside `backfill-federal-names.js`: us-congress house terms with district null AND state in the at-large set get district `'0'` (additive fills-null).
- All live runs controller-operated. TDD off cached/committed fixtures; NO new fetch patterns.
- [ ] TDD → implement → suite green → commit `feat: launch-data backfills (MO terms roster, federal placeholder names, at-large districts)` → controller dry-runs + live runs + spot-checks.

