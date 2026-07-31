### Task 4: Dataset payload parsing — bills, roll calls, people (fixture-first)

**Files:** Create `src/adapters/legiscan-dataset.js`, `tests/legiscan-dataset.test.js`

**Interfaces (Produces):**
```js
export function decodeDatasetZip(base64Zip) -> Buffer  // built on yauzl if Task 3's dependency
  // gate (Q1) was approved, else the Task-3-documented hand-rolled central-directory reader —
  // whichever Task 3's commit message records as the resolved decision
export function extractDatasetFiles(zipBuffer) -> { bills: [...], rollCalls: [...], people: [...] }
  // exact shape driven by what Task 3's real fixture actually contains inside the ZIP - LegiScan's
  // dataset ZIPs are DOCUMENTED (per prior research) to bundle getBill/getRollCall/getPerson
  // payloads per-session; the internal file layout (one JSON per bill? one big array?) is
  // currently UNKNOWN and must be read from the real fixture, not assumed.
export function normalizeBillIdentifier(billNumber) -> string    // 'SB894' -> 'SB 894'
export class DatasetParseError extends Error {}                  // meta-carrying, mirrors JournalParseError
```

- [ ] TDD against Task 3's real fixture: `decodeDatasetZip` + `extractDatasetFiles` recover the
      known bill count / roll-call count / people count for the captured session (assert the REAL
      numbers, not a guessed round number); `normalizeBillIdentifier('SB894')` → `'SB 894'`
      (matches `mo-senate-journal-pdf.js`'s own normalized format exactly — cross-checked, not
      just internally consistent); a corrupted/truncated ZIP throws `DatasetParseError`, never
      returns partial data silently.
- [ ] Implement, green, commit `feat: legiscan dataset ZIP parser - bills/rollcalls/people
      (fixture-backed)`.


## CONTROLLER RULINGS (binding, appended — from Task 3's review)

1. This task OWNS the production decode: decodeDatasetZip (Base64 envelope → entries) + extraction MUST harden against path traversal (an entry named ../../evil never escapes the target dir) with a test constructing such an entry synthetically (the real fixtures are clean — the test must not depend on them being malicious).
2. dataset_hash semantics (reviewer-verified on both fixtures): it equals the IN-ARCHIVE hash.md5 file's content, NOT md5 of the raw ZIP bytes. Your decode surface must expose the archive's hash.md5 content so Task 9's post-fetch re-compare can use it.
3. Wrapper traps (fixture-verified): people/<id>.json wraps {"person":{...}}; vote/<id>.json wraps {"roll_call":{...}}; bill/<id>.json presumably {"bill":{...}} — verify against the real fixtures, defensive tests for each.
4. Both fixtures are in play: 1579 proves the ZERO-votes path (empty vote/ dir parses honestly, no crash, no fabricated rows); 1608 proves real roll calls (8 files, field set matches the getRollCall API fixture incl. passed/nv/chamber/date).
5. Fix SOURCES.md's two-line wrapped heading (~line 323) in passing.
