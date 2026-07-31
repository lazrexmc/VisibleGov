### Task 3: Bounded live capture — ONE real session dataset ZIP (fixture)

**Files:**
- Create: `tests/fixtures/research/legiscan/mo-2018-dataset.json` (raw envelope, key redacted)
  and its decoded contents under `tests/fixtures/research/legiscan/dataset-2018/` (bills/votes/
  people, decoded from the Base64 ZIP — real captured payload, not synthesized)
- Modify: `tests/fixtures/research/SOURCES.md` (append URL/date/exact query count — same
  discipline as every prior research capture in this repo)

**Bounded to ≤4 live LegiScan queries** (Lance sees this count before the task runs, per Global
Constraints): `getSessionList` (1, reuse if the cached fixture is still fresh — likely 0 needed),
`getDatasetList` for MO (1), `getDataset` for the smallest available 2018 session_id (1, gated by
Task 2's `decodeDatasetHashGate` — first call for this session always fetches), one retry budget
for a transient failure (1). MO's 2018 Regular Session (2,347 bills per the existing masterlist
fixture) is likely NOT the smallest — prefer a Special Session (2018 1st/2nd Special, `session_id`
1579/1608) for a genuinely small first fixture; the Regular Session dataset can be captured in a
LATER live task (Task 10) once the parser is proven.

- [ ] ⛔ **DEPENDENCY GATE — do not write capture/decode code past this line without Lance's
      explicit approval, captured in this task's commit message.** Ruling
      (`.superpowers/sdd/legiscan-plan-draft-notes.md` Q1): the controller RECOMMENDS Option A
      (`yauzl` — minimal, well-audited, streaming-capable, no native bindings) over Option B (a
      hand-rolled central-directory reader over `node:zlib.inflateRawSync` — feasible for the
      well-documented PKZIP format but a real correctness surface for production ingestion, where
      a subtle bug risks silent data loss that's harder to catch than a PDF-extraction miss). **The
      recommendation is NOT the approval** — same standing policy as every other new runtime
      dependency this repo has taken (`pdfjs-dist`, `@anthropic-ai/sdk`): a new npm dependency
      requires Lance's explicit per-dependency sign-off, asked for up front with what it is and
      why, before it's added.
      - **If approved:** add `yauzl` to `package.json`, implement decode against it; note the
        approval (who/when) in this task's commit message.
      - **If declined or unavailable:** fall back to Option B (hand-rolled central-directory
        reader); document that choice and why in this task's commit message, and flag the
        increased correctness-review burden for Task 4's fixture-first tests.
      Either way, the decision and its basis are documented in this task's commit message before
      any capture/decode code is written.
- [ ] Live capture per the bounded budget above; append to SOURCES.md; note the REAL `getDataset`
      response envelope shape (does it require the session's `access_key` from `getDatasetList`,
      per the client signature's flagged guess in Task 2? confirm and correct if wrong).
- [ ] Commit: `chore: capture LegiScan MO dataset ZIP fixture (research-budgeted, ≤4 queries)`.

**Produces:** the one real dataset payload every parser test in Tasks 4-7 is written against.


## CONTROLLER RULINGS (binding, appended)

1. DEPENDENCY APPROVED by Lance (2026-07-28, verbatim: "yes for yauzl"): install yauzl with --save-exact (pin-exact precedent: pdfjs-dist). Commit package.json + package-lock.json. No other new dependencies.
2. access_key (Task 2's manual finding, binding): getDataset requires the per-session access_key returned by getDatasetList — thread it through the capture; NEVER log it un-redacted (extend the redaction test if the URL shape includes it: access_key= is NOT covered by redactUrl's current key= pattern — the T2 reviewer verified that by construction. Add access_key to the redaction pattern in src/lib/http.js as part of this task, WITH a test, before any live call).
3. Fixture choice: query getDatasetList for MO once, pick the SMALLEST dataset (likely a special session) as the committed fixture — repo-size discipline; note the chosen session + byte size in SOURCES.md. The big Regular-session datasets are cache-only at runtime (gitignored), never committed.
4. Budget honesty: every live query this task spends is logged in the report AND SOURCES.md (expected total: ≤4 — one getDatasetList + one getDataset + margin). Check status on every response.
5. dataset_hash from getDatasetList is stored alongside the fixture metadata — the fixture IS the first entry of the hash-gate discipline (record it exactly as the ledger table will).
