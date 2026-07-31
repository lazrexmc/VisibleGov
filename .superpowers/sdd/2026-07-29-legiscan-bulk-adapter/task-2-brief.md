### Task 2: `src/adapters/legiscan.js` — API client core (status/hash gate, limiter, cache)

**Files:** Create `src/adapters/legiscan.js`, `tests/legiscan-client.test.js`

**Interfaces (Produces):**
```js
export const SOURCE = 'legiscan';
export const ATTRIBUTION = { license: 'CC BY 4.0', holder: 'LegiScan', url: 'https://legiscan.com' };
export class LegiScanApiError extends Error {}         // non-OK status field, meta-carrying
export class DatasetHashMismatchError extends Error {} // defensive: dataset_hash changed mid-run
export const legiscanLimiter = createLimiter({ minIntervalMs: LEGISCAN_MIN_INTERVAL_MS }); // 1000ms fallback per ruling Q3, pending this task's WebFetch confirmation
export async function getSessionList(state, { key, limiter = legiscanLimiter })
export async function getDatasetList(state, { key, limiter = legiscanLimiter })
export async function getDataset(sessionId, accessKey, { key, limiter = legiscanLimiter }) // NOTE:
  // LegiScan's getDataset takes the session's own access_key (from getDatasetList), not just the
  // API key - verify this against getDatasetList's real response shape once captured (Task 3);
  // this signature is a research-derived guess per the fixture-first discipline.
export async function getBill(billId, { key, limiter = legiscanLimiter })       // verification/spot-check use, not the bulk path
export async function getRollCall(rollCallId, { key, limiter = legiscanLimiter }) // verification/spot-check use, not the bulk path
export function checkStatus(payload)   // throws LegiScanApiError if payload.status !== 'OK'
export function decodeDatasetHashGate(sessionId, reportedHash, ledgerRow)
  // -> { shouldFetch: bool, reason } — pure, testable without a DB or network: ledgerRow is the
  // already-queried legiscan_datasets row (or null). shouldFetch=false when ledgerRow.dataset_hash
  // === reportedHash. THIS is the suspension-level mandatory gate, isolated and heavily tested.
export async function getMonthlyQueryUsage(client, { source = SOURCE, now = new Date() })
  // sums ingestion_runs.detail.queries_used for this source within the current calendar month.
  // Reads via selectAll (src/lib/db.js:85), NOT a bare .select() - a busy month's ingestion_runs
  // rows could plausibly exceed the 1000-row PostgREST page default, and an unpaginated read
  // would silently UNDERCOUNT usage, letting a run blow past the configured query cap (the exact
  // shape of bug selectAll itself was written to close). Month boundary is UTC (ruling Q5,
  // .superpowers/sdd/legiscan-plan-draft-notes.md - known imprecision vs LegiScan's own ET-based
  // reset, documented in this function's own code comment, low-stakes given the 5,000/30,000
  // headroom).
export function assertUnderBudget(usage, plannedQueries, capPerMonth)  // pure; throws QueryBudgetExceededError
```

- [ ] TDD against the 3 existing non-oversize fixtures (`mo-sessions.json`,
      `mo-2018-SB894.json`, `mo-2018-rollcall-747209.json` — `mo-2018-masterlist.json` is
      1.3MB/2,347 bills, used later in Task 4 via streaming/offset read, not loaded whole here):
      `checkStatus` passes on `status:"OK"`, throws `LegiScanApiError` on anything else (synthetic
      fixture edit for the error case — no real ERROR payload captured yet); `getSessionList`
      parses all 31 real MO sessions; `getBill`/`getRollCall` parse the real SB894/roll-call-
      747209 shapes exactly (assert `sponsors[].people_id`, `votes[].roll_call_id`,
      `roll_call.votes[].{people_id,vote_id,vote_text}` field names verbatim — THE FIXTURE IS THE
      SOURCE OF TRUTH, do not rename fields to a house style).
- [ ] `decodeDatasetHashGate` unit tests (pure, no DB): no ledger row → shouldFetch true (never
      fetched); ledger row present + hash matches → shouldFetch false; ledger row present + hash
      differs (a real dataset update) → shouldFetch true, reason `'hash_changed'`.
- [ ] `getMonthlyQueryUsage`/`assertUnderBudget` unit tests with fake run rows spanning a month
      boundary — UTC boundary per ruling Q5 (`.superpowers/sdd/legiscan-plan-draft-notes.md`), not
      ET; include a fake-client test asserting `getMonthlyQueryUsage` calls through `selectAll`
      (not a bare hand-rolled page loop) so a future page-size change can't silently reintroduce
      the 1000-row undercount.
- [ ] One `WebFetch` (not an API query) of the LegiScan API Manual's Page 7 timing guidance
      (`api.legiscan.com/dl/` per prior research — the developer-tooling subdomain was NOT
      Cloudflare-blocked) to set `LEGISCAN_MIN_INTERVAL_MS` from the real text rather than a
      guess. **Ruling Q3 (APPROVED):** if unreachable or the guidance isn't found, fall back to a
      clearly-labeled `1000` placeholder with a durable TODO comment pointing back to
      `.superpowers/sdd/legiscan-plan-draft-notes.md` Q3 until a human reads the real manual — this
      is the resolved fallback value, not an open guess.
- [ ] Implement, green, commit `feat: legiscan API client - status/hash/budget gates, fixture-
      backed`.

**Produces:** the mandatory suspension-level gate (dataset_hash), the monthly budget refusal, and
every read operation this plan's later tasks call — all fixture/unit-tested BEFORE any live
`getDataset` call is ever made (Task 3).

