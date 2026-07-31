# Task 2 report — `src/adapters/legiscan.js` API client core

**Status:** complete. **Commit:** `767be85ebac1124d7f708a5845c1a73317ea251d` on
`legiscan-bulk-adapter`. **Tests:** `node --test` (bare) → 648/648 pass (626 baseline + 22 new in
`tests/legiscan-client.test.js`), 0 fail.

## Timing-guidance WebFetch — what it actually found

Fetched `https://api.legiscan.com/dl/` (reachable, not Cloudflare-blocked, confirming prior
research) → linked to `https://api.legiscan.com/dl/LegiScan_API_User_Manual.pdf` (rev 20250317, 43
pages). WebFetch's own page-render of the PDF couldn't answer the page-7 question directly, so I
extracted the real PDF text locally with `pdfjs-dist` (already a project dependency, same
legacy-build pattern as `mo-rollcall-pdf.js`) and read all 43 pages, not just page 7.

**Real finding:** Page 7 ("API Operations") is a per-operation **"Frequency"** table (getBill: 3
hours, getSessionList: Daily, getDataset: Weekly, getRollCall: Static, etc.), and the manual's own
text says this reflects "the minimum time resolution that *could* include changes in data" — i.e.
data-refresh/cache-staleness cadence, not a minimum wait between consecutive HTTP requests. A
full-text search across all 43 pages for rate/throttle/concurrent/simultaneous/"per
second"/"per minute"/delay/interval/suspend/abuse found **no explicit request-pacing guidance
anywhere in the manual** (the one "Concurrent" hit was "Concurrent Resolution," a bill-type enum).

This is exactly ruling Q3's "guidance isn't found" branch (manual was reachable; no timing value to
extract). Per the ruling, `LEGISCAN_MIN_INTERVAL_MS = 1000` (labeled placeholder), with a durable
`TODO(Q3, .superpowers/sdd/legiscan-plan-draft-notes.md)` comment in
`src/adapters/legiscan.js`.

**Bonus finding from the same fetch:** the manual's real `getDataset`/`getDatasetList` pages (25-26)
confirm `getDataset` requires `access_key` from `getDatasetList` (not the API key) — this resolves
the `getDataset` signature's flagged research-derived guess ahead of Task 3's fixture capture, and
I recorded it inline. Also confirmed `getRollCall`'s manual template literally prints
`op=getRollcall` (lowercase c) while every other reference uses `getRollCall`; operations are
documented as case-insensitive (Page 6), so I used the canonical spelling.

## What was built

`src/adapters/legiscan.js`: `SOURCE`, `ATTRIBUTION`, `LEGISCAN_MIN_INTERVAL_MS`, `legiscanLimiter`,
`LegiScanApiError`, `DatasetHashMismatchError`, `QueryBudgetExceededError`, `checkStatus`,
`getSessionList`/`getDatasetList`/`getDataset`/`getBill`/`getRollCall`, `decodeDatasetHashGate`,
`getMonthlyQueryUsage`, `assertUnderBudget` — matches the brief's interface list exactly.

- `checkStatus` is the layer this task's fixture tests exercise directly (LegiScan payloads need no
  reshaping at this layer — fields pass through verbatim); tested against all 3 real fixtures
  (31 sessions, SB894's `sponsors[].people_id`/`votes[].roll_call_id`, roll-call-747209's
  161 `votes[].{people_id,vote_id,vote_text}` casts, cross-checked against the roll call's own
  printed yea/nay/absent tallies) plus a synthetic ERROR payload.
- The 5 network functions (`getSessionList` etc.) are thin `fetchWithLimit` + `checkStatus`
  wrappers, deliberately untested directly at the network seam — same convention as
  `mo-legislature.js`'s `fetchSessions`/`fetchBillsWithVotes`/`fetchPersonById`, which are likewise
  untested in favor of testing their sibling pure logic (no `mock.method`/stubbed-`fetch` pattern
  exists anywhere else in this test suite, so I didn't introduce one here).
- `decodeDatasetHashGate`: all 3 required cases tested (no row → `never_fetched`; match →
  `shouldFetch:false`; mismatch → `shouldFetch:true, reason:'hash_changed'`).
- `getMonthlyQueryUsage`: reads via `selectAll` against `ingestion_runs.started_at` (there is no
  `created_at` column on that table — verified against `0001_core_schema.sql`), UTC month boundary
  per ruling Q5. One test seeds 1,500 fake rows behind a fake client that enforces the same
  1,000-row-per-`.range()` server cap `db.test.js`'s `makeCappedTableClient` uses, and asserts the
  full 1,500 comes back — this can only pass via real pagination, proving `selectAll` (not a bare
  `.select()`) is what's wired in.
- `assertUnderBudget`/`QueryBudgetExceededError`: pure, tested at and over the cap.
- `redactUrl` verified against LegiScan's actual URL shape (brief's explicit ask): `key=` is
  redacted on `getSessionList`/`getBill`/`getDataset`-shaped URLs; `access_key=` (the
  `getDataset`-only per-dataset token from `getDatasetList`, not the account credential) is
  confirmed to survive redaction untouched — a deliberate, tested, documented boundary matching the
  Global Constraints' "reused as-is, zero changes to `redactUrl`" design, not an oversight.

No DB writes, no live LegiScan API calls anywhere in this task or its tests.

## Concerns

1. `DatasetHashMismatchError` is defined/exported per the interface spec (constructible,
   instanceof-tested) but has no throw site in this task — by design, since the real "dataset_hash
   changed mid-run" race (comparing a fetched dataset's own reported hash against the value that
   justified fetching it) can only be checked where both values are in hand, which is Task 9's live
   `getDataset` call, not this pure/network-wrapper layer. Flagging so Task 9's brief doesn't assume
   it's already wired.
2. `decodeDatasetHashGate` accepts `sessionId` but doesn't cross-check it against
   `ledgerRow.legiscan_session_id` — the caller's own primary-key lookup already scopes `ledgerRow`
   to that session, so there's nothing left to verify at this pure layer, and the brief's 3 required
   test cases don't exercise a mismatched-session scenario. Noted in case a future caller ever
   passes a `ledgerRow` from an unrelated query.
3. `getMonthlyQueryUsage`'s UTC-vs-ET month-boundary imprecision (ruling Q5) is accepted/documented,
   not a defect — flagged again here only because it's a real (if low-stakes) behavior a future
   reader should know about.

## Files

- `F:\VisibleGov\src\adapters\legiscan.js` (new)
- `F:\VisibleGov\tests\legiscan-client.test.js` (new, 22 tests)
