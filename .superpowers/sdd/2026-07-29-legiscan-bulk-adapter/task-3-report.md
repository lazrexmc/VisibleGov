# Task 3 report — LegiScan dataset ZIP capture (yauzl decode + bounded live capture)

## Dependency decision (recorded per the DEPENDENCY GATE)

`yauzl@3.4.0` — APPROVED by Lance, 2026-07-28, verbatim: "yes for yauzl" (ruling 1, appended to
`task-3-brief.md` before this task began). Installed with `--save-exact` (pin-exact precedent:
`pdfjs-dist`). `package.json` + `package-lock.json` committed. No other new dependency added.

## Redaction gap closed BEFORE any live call (ruling 2)

`src/lib/http.js`'s `redactUrl` regex previously matched only a `key`/`api_?key` param name
directly preceded by `?`/`&`. LegiScan's `access_key=` (the per-session dataset token from
`getDatasetList`, required by `getDataset`) does not match that pattern — the character
immediately before "key" in "access_key" is `_`, not `?`/`&` — a real gap for a real
credential-shaped value, verified present in Task 2's own test suite (which had asserted the old,
gap-having behavior as "accepted"). Fixed regex: `(?:access_key|api_?key|key)`. Updated
`tests/lib.test.js` (new dedicated test) and corrected `tests/legiscan-client.test.js`'s existing
test (previously asserted the wrong/old behavior). Verified 649/649 green before any live call was
made.

## Live capture

**2 of ≤4 budgeted queries used, no retry needed.** `getSessionList` was skipped (0 queries) —
today's `mo-sessions.json` fixture was already fresh.

| # | op | URL (redacted) | result |
|---|----|-----------------|--------|
| 1 | `getDatasetList` | `https://api.legiscan.com/?key=REDACTED&op=getDatasetList&state=MO` | 200, 31 entries |
| 2 | `getDataset` | `https://api.legiscan.com/?key=REDACTED&op=getDataset&id=1579&access_key=REDACTED` | 200 |

**Fixture choice:** compared the 3 real 2018 MO sessions from the `getDatasetList` response by
`dataset_size`:

| session_id | session_name | dataset_size (bytes) |
|---|---|---|
| 1608 | 2018 2nd Extraordinary Session | 105,793 |
| **1579** | **2018 1st Extraordinary Session** | **25,039 (chosen)** |
| 1530 | 2018 Regular Session | 4,061,035 |

Session 1579 chosen as the smallest. 1608 and 1530 were never fetched via `getDataset` — no
additional live queries were spent beyond the one `getDatasetList` listing call. 1530 (Regular
Session, 2,347 bills, ~4MB) stays cache-only/gitignored at runtime per ruling 3, deferred to
Task 10.

**`access_key` requirement confirmed real** (corrects/confirms Task 2's flagged research-derived
guess): `getDataset(id=1579, access_key=<from getDatasetList's own entry for 1579>)` succeeded on
the first live call. The returned envelope does not echo the `access_key` back — nothing to
redact inside the committed fixture body itself; the value only ever appears in the (now-redacted)
request URL.

## Fixture summary

- `tests/fixtures/research/legiscan/mo-2018-dataset.json` — 33,933 bytes. Full raw `getDataset`
  response, rewrapped as `{status: "OK", dataset: {...}}` to match every other fixture in the
  directory's convention (the adapter's own `getDataset()` helper already unwraps to
  `checkStatus(payload).dataset` — the committed fixture restores the wrapper so
  `checkStatus(fixture).dataset` works the same way `checkStatus(fixture).bill` etc. already do
  elsewhere in this directory). Includes the still-Base64 `zip` field (33,388 base64 chars,
  decodes to 25,039 raw bytes) — this is the exact input Task 4's `decodeDatasetZip` will be
  tested against.
- `tests/fixtures/research/legiscan/dataset-2018/MO/2018-2018_1st_Special_Session/` — the ZIP's
  decoded contents, real internal path preserved: `bill/` (18 files), `people/` (3 files),
  `LICENSE`, `README.md`, `hash.md5`. `vote/` is empty (0 files) — see structure notes below.
- Grepped both committed pieces for `access_key`/`api_key`/`apikey` and for the literal live API
  key value before committing: clean, nothing key-shaped present.

## ZIP structure notes (for Task 4's parser)

1. **Real layout:** `STATE/SESSION/{bill,people,vote}/*.json` plus three top-level non-data files
   (`LICENSE`, `README.md`, `hash.md5`) inside the same `STATE/SESSION/` folder. The archive's own
   bundled `README.md` documents this contract in LegiScan's own words — it's a committed part of
   the fixture. A parser must skip the three non-directory files, not assume every top-level entry
   under `SESSION/` is one of the three data dirs.
2. **`bill/<BILL_NUMBER>.json`** (e.g. `HB1.json`, `HR2.json`, `HCR1.json` — no space, no
   zero-padding) — payload is `{"bill": {...}}`, the exact `getBill` shape, verbatim same field
   names as the already-tested `mo-2018-SB894.json` fixture (`sponsors[].people_id`, `votes[]`,
   `history[]`, `texts[]`, `sasts[]`).
3. **`people/<PEOPLE_ID>.json`** (e.g. `14179.json`) — payload is `{"person": {...}}`, **singular**
   wrapper key, asymmetric with the plural directory name `people/` — an easy naming trap for a
   parser. Only 3 people files exist for this session (the bills' own sponsors) — this directory
   is NOT a full chamber roster; a parser needing one must not assume dataset ZIPs supply it.
4. **`vote/` is present-but-EMPTY in this fixture (1579)** — internally consistent with all 18
   bills' own `votes: []` fields (only 3 of 18 bills advanced past "Prefiled" at all:
   `HCR1`/`HR1`/`HR2`, the other 15 have `status:0, history:[], texts:[]`). This is a real
   property of this session, not a parsing artifact. **CLOSED by a coordinator-adjudicated
   follow-up query** (see "Follow-up capture: session 1608" below) — do not re-open.
5. **`hash.md5`** — single line, exactly `dataset.dataset_hash` from the envelope
   (`196f5cb2b665116489beb1da7df8f982`) — free cross-check available to a parser wanting to
   validate a decoded ZIP against its own claimed hash.
6. **`LICENSE`** — full CC BY 4.0 text, confirms the `ATTRIBUTION` constant already hardcoded in
   `src/adapters/legiscan.js` against a primary source (not just the API manual's claim).

## Follow-up capture: session 1608 (2018 2nd Extraordinary Session) — closing the vote/ gap

Coordinator-adjudicated follow-up, spent within this task's own ≤4-query budget (3 of ≤4 used
total, no retry ever needed). Only **1 more query**: `getDataset(id=1608, access_key=...)` —
`access_key` and `dataset_hash` for 1608 were already held from this task's earlier
`getDatasetList` call and were NOT re-queried, per explicit instruction.

3. `getDataset`: `https://api.legiscan.com/?key=REDACTED&op=getDataset&id=1608&access_key=REDACTED`
   (200 OK).

**Result: `vote/` is non-empty** — 8 real roll-call files (9 bill files, 189 people files,
105,793 bytes total dataset, 209 files / ~366KB decoded). Committed as a second, parallel fixture
pair, same layout convention:
- `tests/fixtures/research/legiscan/mo-2018-dataset-1608.json` — raw `{status, dataset}` envelope
  incl. Base64 `zip` (141,606 bytes). `dataset_hash` = `f07c2e26578db9db7daa683cfa054190`, matches
  the ZIP's own `hash.md5` byte-for-byte.
- `tests/fixtures/research/legiscan/dataset-2018-1608/MO/2018-2018_2nd_Special_Session/` — real
  internal path preserved: `bill/` (9), `people/` (189 — roll calls reference far more legislators
  than 1579's sponsor-only set), `vote/` (8), `LICENSE`, `README.md`, `hash.md5`. Grepped clean of
  key material before committing.

**In-ZIP vote payload shape (the actual question this follow-up answers):**
`vote/<ROLL_CALL_ID>.json` (e.g. `vote/774412.json`) wraps as `{"roll_call": {...}}` — **matches**
the standalone `getRollCall` API fixture's wrapper key and field set exactly
(`roll_call_id`, `bill_id`, `yea`, `nay`, `nv`, `absent`, `total`, `passed`, `chamber`,
`chamber_id`, `date`, `desc`, `votes[].{people_id, vote_id, vote_text}`). Sample (`774412.json`,
33 individual casts, "Senate: Third Reading", 29 Yea / 0 Nay / 4 Absent):
```json
{"roll_call":{"roll_call_id":774412,"bill_id":1126109,"date":"2018-09-14","desc":"Senate: Third Reading","yea":29,"nay":0,"nv":0,"absent":4,"total":33,"passed":1,"chamber":"S","chamber_id":60,"votes":[{"people_id":7512,"vote_id":1,"vote_text":"Yea"}, ...]}}
```
**Naming asymmetry for Task 4 (documented, not hidden):** directory `vote/` (singular) but wrapper
key `roll_call` (a different noun, not a singular/plural variant) — matches the archive's own
bundled `README.md` ("The JSON payload from the getRollcall API hook"), so it's expected, but a
parser assuming directory name == top-level JSON key would break here exactly as it would on
`people/` -> `person`.

## Test suite

649/649 green (`node --test`, bare invocation per PLAYBOOK_DELTA §7.1) — baseline 648 + 1 new
redaction test in `tests/lib.test.js`; unchanged by the 1608 follow-up (fixture-only, no new
`src/` module). Task 3 adds no new `src/` module (per the plan: `src/adapters/
legiscan-dataset.js`'s `decodeDatasetZip`/`extractDatasetFiles` are Task 4's deliverables, built
against this task's fixtures) — the yauzl decode used to produce the fixtures lived in one-off,
uncommitted capture scripts (same discipline as every prior ad-hoc research capture in this repo,
which used `curl` directly rather than a committed script).

## Concerns / forward flags

- `people/*.json`'s wrapper key is singular (`person`) while the directory is plural (`people`),
  and `vote/*.json`'s wrapper key is `roll_call` (not `vote` at all) — real naming asymmetries in
  both non-bill directories, not typos in this report; worth defensive tests in Task 4 (don't
  assume directory name == top-level JSON key anywhere but `bill/`).
- The committed envelopes keep the full Base64 `zip` field so they're faithful `decodeDatasetZip`
  inputs for Task 4 — this roughly doubles each fixture's total committed size vs. decoded-only
  (1579: 33.9KB envelope + ~28KB decoded; 1608: 141.6KB envelope + ~366KB decoded). Still small in
  absolute terms; 1608 was deliberately the *next*-smallest real session, not an arbitrary pick.
- Budget note: 3 of ≤4 queries now spent across this task in total (2 initial + 1 follow-up); 1
  query of margin remains unused. No further live capture was attempted or is needed for Task 3.
