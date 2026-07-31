# Task 4 report — LegiScan dataset ZIP parser (bills/rollcalls/people, fixture-backed)

Commit: `dcb8309e4fa9f6d95b6149e4e3cbaeeeb8b68043` — `feat: legiscan dataset ZIP parser -
bills/rollcalls/people (fixture-backed)`

## Files

- **`src/adapters/legiscan-dataset.js`** (new) — the whole deliverable:
  - `decodeDatasetZip(base64Zip) -> Buffer`: `Buffer.from(base64Zip, 'base64')`, with a guard
    throwing `DatasetParseError` (`reason: 'empty_input'`) on non-string/empty input rather than
    silently producing a garbage 0-length Buffer.
  - `extractDatasetFiles(zipBuffer) -> { bills, people, rollCalls, datasetHash, failures }` — opens
    via `yauzl.fromBufferPromise(zipBuffer, { decodeStrings: false })` and iterates
    `zipfile.eachEntry()`. Deliberately **does not** rely on yauzl's own default (`decodeStrings:
    true`) automatic `validateFileName` check — that runs inside yauzl's own central-directory
    parser, before this module's code ever sees the entry, so a hit there surfaces as a bare
    dependency error indistinguishable from ordinary corruption, not a typed `DatasetParseError`.
    Instead this module decodes each entry's `fileName` itself via the exported
    `yauzl.getFileNameLowLevel(...)` (its own README: "This method... bypasses the security checks
    in `validateFileName()`. You should call that function yourself") and then calls its own
    `assertSafeEntryPath` — `yauzl.validateFileName` plus an independent `path.resolve` containment
    check against a synthetic dataset-root sentinel — so this task genuinely *owns* the decision,
    not merely benefits from a dependency default.
  - `normalizeBillIdentifier(billNumber) -> string`: `'SB894' -> 'SB 894'`.
  - `DatasetParseError` — meta-carrying `Error` subclass, same shape as `JournalParseError`
    (`mo-senate-journal-pdf.js`).
  - Directory→wrapper-key map (`DATA_DIRS`): `bill/` → `bill`, `people/` → `person` (singular,
    asymmetric with the plural dir), `vote/` → `roll_call` (different noun entirely). Classification
    is by the entry's last two path segments only (no hardcoded `STATE/SESSION` prefix), so it's
    agnostic to state/session folder naming.
  - `hash.md5`'s content (trimmed) is captured verbatim into `datasetHash` on the result — the
    CONTROLLER RULING 2 requirement (this is the in-archive file's content, not `md5(zip bytes)`).
  - Skip≠empty split: a malformed **individual** `bill/people/vote` entry (invalid JSON, or JSON
    missing its documented wrapper key) is pushed to `failures[]` and the loop continues — never a
    silent drop, never fatal. An **archive-level** problem (won't open at all; a read fails
    mid-stream; any entry's path is unsafe) throws `DatasetParseError` directly, discarding
    everything gathered so far — never a partial `bills/people/rollCalls` result.
- **`tests/legiscan-dataset.test.js`** (new) — 25 tests, all fixture- or synthetic-ZIP-backed. No
  new dependency for the malicious/malformed-ZIP tests: a ~70-line hand-rolled minimal-PKZIP
  writer (`buildStoredZip`, STORED/uncompressed entries only, using Node's built-in `node:zlib`
  `crc32` for correct non-empty-entry checksums) constructs synthetic archives in-memory.
- **`tests/fixtures/research/SOURCES.md`** (modified) — ruling 5: joined the wrapped two-line
  `## LegiScan dataset ZIP capture (...)` heading (was split across two lines, breaking Markdown
  heading recognition on the continuation line) into one line. No other content changed.

No `package.json` change — `yauzl@3.4.0` was already added and approved in Task 3.

## Real parsed numbers (both fixtures, verified by running the actual module against the actual
committed fixture bytes, not asserted from memory)

**Session 1579** (`mo-2018-dataset.json`, 2018 1st Extraordinary Session — the ZERO-votes fixture):
- `decodeDatasetZip` output: 25,039 bytes (`=== dataset.dataset_size`).
- `extractDatasetFiles`: **18 bills, 3 people, 0 roll calls, 0 failures.**
- `datasetHash`: `196f5cb2b665116489beb1da7df8f982` — equals `envelope.dataset.dataset_hash`
  byte-for-byte.
- Sample bill record (`bill/HB1.json`, unwrapped from `{"bill": {...}}`):
  ```json
  {
    "bill_id": 1126419, "session_id": 1579, "state": "MO", "bill_number": "HB1",
    "title": "Appropriates money to the Board of Fund Commissioners",
    "sponsors": [{ "people_id": 14179, "name": "Scott Fitzpatrick", "district": "HD-158", ... }],
    "votes": [], "history": [], "texts": [], "sasts": []
  }
  ```
- Sample person record (`people/12941.json`, unwrapped from `{"person": {...}}`):
  `{"people_id":12941,"name":"Jason Barnes","party":"R","district":"HD-060",...}`.

**Session 1608** (`mo-2018-dataset-1608.json`, 2018 2nd Extraordinary Session — the real-roll-calls
fixture):
- `decodeDatasetZip` output: 105,793 bytes (`=== dataset.dataset_size`).
- `extractDatasetFiles`: **9 bills, 189 people, 8 roll calls, 0 failures.**
- `datasetHash`: `f07c2e26578db9db7daa683cfa054190` — equals `envelope.dataset.dataset_hash`
  byte-for-byte.
- Sample roll call record (`vote/774412.json`, unwrapped from `{"roll_call": {...}}`):
  ```json
  {
    "roll_call_id": 774412, "bill_id": 1126109, "date": "2018-09-14",
    "desc": "Senate: Third Reading", "yea": 29, "nay": 0, "nv": 0, "absent": 4, "total": 33,
    "passed": 1, "chamber": "S", "chamber_id": 60,
    "votes": [{"people_id":7512,"vote_id":1,"vote_text":"Yea"}, ... 33 entries total]
  }
  ```
  Individually re-tallied from the 33 `votes[]` entries: 29 `Yea`, 4 `Absent` — matches the
  record's own `yea`/`absent` fields exactly.

## Traversal-test design (CONTROLLER RULING 1)

Three synthetic-ZIP tests, all built via the in-file `buildStoredZip` PKZIP writer (real fixtures
are clean by construction, per the ruling — the test cannot depend on them being malicious):
1. An entry named `../../evil.json`, placed **second** in central-directory order after a
   legitimate `bill/HB1.json` entry — proves the malicious entry is caught even when a valid entry
   already yielded successfully ahead of it, and that `extractDatasetFiles` rejects (never
   resolves) with `DatasetParseError` whose `reason === 'unsafe_entry_path'` — i.e. no partial
   `{bills, people, rollCalls}` is ever observable by the caller, because the function throws
   before it ever returns.
2. An absolute-path entry, `/etc/passwd`.
3. A backslash/drive-letter entry, `` C:\evil.json `` — this one specifically exercises the
   `decodeStrings:false` design choice: with the default `decodeStrings:true`, yauzl's own
   `strictFileNames:false` default would *silently normalize* backslashes to forward slashes before
   validation ever ran, which could mask this exact pattern; explicitly decoding + validating each
   fileName ourselves keeps `yauzl.validateFileName`'s backslash rejection (`indexOf("\\") !== -1`)
   in force regardless.

All three assert `instanceof DatasetParseError` (never a bare/generic Error reaching the caller).
Also covered: a truncated real ZIP (last 200 bytes of the real 1579 archive cut off, so the End Of
Central Directory record is missing) and a completely non-ZIP buffer — both throw
`DatasetParseError` with `reason: 'invalid_zip'`.

## Wrapper-trap defensive tests (CONTROLLER RULING 3)

Beyond the real-fixture assertions (which only prove the *correct* wrapper keys work), three
synthetic tests prove the *wrong* wrapper key is caught, not silently accepted or silently dropped:
a `bill/` entry containing `{"person": {...}}` instead of `{"bill": {...}}`; a `people/` entry
containing the plural `{"people": {...}}` instead of the real singular `{"person": {...}}`; and a
`vote/` entry with malformed (non-JSON) bytes. Each lands exactly one `DatasetParseError` in
`failures[]` with the expected `reason`/`entryName`/`wrapperKey`, and — in the mixed-entry test —
does **not** stop a co-located well-formed entry from still being processed correctly.

## `normalizeBillIdentifier` cross-check

`normalizeBillIdentifier('SB894') === 'SB 894'`, and a dedicated test imports
`extractBillRefs` from `mo-senate-journal-pdf.js` directly, feeds it `'SBs 894 was read the third
time and passed.'`, and asserts its real output (`'SB 894'`) equals this function's output for the
same bill — a genuine cross-file check, not just internal self-consistency. Also covers every real
bill type seen across both fixtures (HB, HR, HCR, SB, SR, SCR), idempotency on an already-spaced
identifier, and case-insensitivity.

## Test suite

674/674 green (`node --test`, bare invocation) — 649 baseline + 25 new in
`tests/legiscan-dataset.test.js`.

## Concerns / forward flags

- `datasetHash` can be `null` if an archive has no `hash.md5` entry at all (never observed in
  either real fixture, but a hand-built/malformed archive could omit it) — this is **not** treated
  as fatal by itself, since the bill/people/vote data is still independently usable; Task 9's
  post-fetch re-compare will need its own null-check before comparing against `dataset.dataset_hash`.
- The fatal-vs-counted-failure line is a deliberate design choice, not dictated verbatim by the
  brief: JSON-parse failures and missing-wrapper-key entries are per-entry recoverable (pushed to
  `failures[]`, loop continues); anything else during ZIP iteration (a corrupted deflate stream, a
  CRC/size mismatch, an unsafe entry path) is treated as archive-level and fatal, discarding
  everything gathered so far. Flagging this explicitly in case a future task wants a different
  boundary (e.g. treating a single corrupted deflate stream as a per-entry failure too).
- `extractDatasetFiles` reads every matched entry's full content into memory via
  `Buffer.concat` (no streaming to a consumer) — fine at this fixture's scale (largest real
  fixture is 366KB decoded) but worth revisiting if Task 10's MO 2018 Regular Session dataset
  (~4MB zipped, 2,347 bills) turns out to decode to something large enough to matter.
- `decodeDatasetZip` does not itself validate ZIP-ness (that's `extractDatasetFiles`'s job, since it
  requires actually opening the archive) — only guards against a missing/empty Base64 string.
