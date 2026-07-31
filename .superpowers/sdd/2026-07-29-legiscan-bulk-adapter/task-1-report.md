# Task 1 report — Migration 0010 (LegiScan identity + ledger schema, draft)

## Pre-flight special-session DB probe (Q4 ruling)

Read-only, service-role, count-only/plain-select queries against the live DB (no writes). Script
run: `node --env-file=.env <scratch>/probe-special-sessions.mjs` from `F:\VisibleGov`, using
`getClient()` from `src/lib/db.js` (existing service-role client factory, same pattern as every
adapter).

**Raw output (verbatim):**

```json
{
  "mo_sessions_total": 3,
  "all_identifiers": ["2022", "261", "2018"]
}
{
  "non_bare_year_sessions": [
    {
      "id": "bf3c7f23-358d-4399-8279-3a8e60a96eda",
      "jurisdiction_id": "mo-legislature",
      "identifier": "261",
      "name": "2026 2nd Regular, 103rd General Assembly"
    }
  ]
}
{
  "probe_1_results": [
    {
      "session": {
        "id": "bf3c7f23-358d-4399-8279-3a8e60a96eda",
        "jurisdiction_id": "mo-legislature",
        "identifier": "261",
        "name": "2026 2nd Regular, 103rd General Assembly"
      },
      "billsCount": 2099
    }
  ]
}
{"verdict":"FAIL: found non-bare-year session(s), see above"}
```

**Interpretation — the literal "0 non-bare-year rows" expectation is falsified, but the actual
STOP criteria (item 3) are both negative:**

- Session `261` does **not** match `/^\d{4}$/`, so the brief's literal probe-1 condition fires.
  However its `name` is `"2026 2nd Regular, 103rd General Assembly"` — an explicitly **Regular**
  session, not a special session. `261` is `mo-house-xml.js`'s own `MO_HOUSE_SESSION_ID` constant
  (`src/adapters/mo-house-xml.js:23`, `MO_HOUSE_SESSION_NAME`), used verbatim as `sessions.identifier`
  by `ingest-mo-house.js:322` (`identifier: session`). This is a pre-existing, unrelated identifier
  convention — MO House's own numeric session ID — not a "prior ad-hoc special-session encoding."
  No special-session row exists.
- Grep of `src/adapters/mo-house-xml.js` and `src/cli/ingest-mo-senate.js` for
  `special|regular|session_tag` (case-insensitive) found no session-type filter in either file —
  only incidental matches (`MO_HOUSE_SESSION_NAME` containing the word "Regular"; an unrelated
  comment about "special election" in `ingest-mo-senate.js:801`; `"${year} Regular Session (MO
  Senate journals)"` as a display name in `ingest-mo-senate.js:414`). Neither driver discriminates
  by session type — confirmed as expected.

Per the brief's own item 3, STOP is triggered only by "an existing **special-session row**" or "a
session-type filter" — neither is present. `261` is a regular session under a different,
already-established identifier scheme, so it doesn't invalidate the Q4 ruling's "distinct
identifier for Special Sessions is collision-free" claim (a future `'2026-1st-special'`-shaped
string cannot collide with `'261'` in the `unique(jurisdiction_id, identifier)` index). **Verdict:
proceed — migration written unchanged from the brief.**

**Concern flagged for later tasks (not fixed here, out of scope for Task 1):** the `sessions`
table already holds MO rows under **two incompatible identifier conventions** — bare years
(`'2018'`, `'2022'`, from `mo-senate-web`/OpenStates) and MO House's own raw session ID (`'261'`,
unrelated to OpenStates or a bare year). Task 9's session ensure/find step (Regular Session →
bare-year `identifier` per the Global Constraints) will need to resolve the *current* MO 2026
Regular Session against the **existing `261` row**, not mint a fresh `'2026'` row — otherwise a
LegiScan Regular Session write would silently duplicate the session rather than dedupe against
`mo-house-xml`'s already-ingested one (2099 bills). Recommend Task 9 explicitly check for an
existing row with a `legiscan_session_id`-implied bare-year identifier that ALSO needs to line up
against `261` before assuming "Regular Session identifier = bare year" resolves cleanly end to
end.

## Migration file

`supabase/migrations/0010_legiscan_identity_and_ledger.sql` — written exactly as specified in the
task brief; no naming collisions found on re-read of 0001 (core schema), 0002 (seed
jurisdictions), 0003 (summary notes/freshness), 0004 (summary verifications), 0005 (mo_house_id),
0006 (surname), 0007 (glossary), 0008/0009 (mo_senate_id + nonunique fix). None of
`legislators.legiscan_people_id`, `sessions.legiscan_session_id`, `legiscan_datasets`,
`vote_reconciliation_flags` pre-exist. `votes(id)` (referenced by `vote_reconciliation_flags.vote_id`)
confirmed present in 0001. The migration is NOT applied — draft-then-apply, Lance runs it; every
later task must degrade gracefully without it (established pattern, `isMissingColumnError`/
`isMissingRelationError`).

## Test evidence

`node --test` (bare, no dir arg — Node 24 Windows convention): **626/626 pass, 0 fail** — matches
the stated 626 baseline exactly (this task added no code, only a draft SQL file the harness never
executes, and the probe script itself lives outside the repo in the scratch directory, not
committed).
