### Task 9: `src/cli/ingest-legiscan.js` — driver

**Files:** Create `src/cli/ingest-legiscan.js`; add `package.json` script `"ingest:legiscan"`;
`tests/ingest-legiscan-cli.test.js` (pure parts: planning, budget gate, dry-run; fake client,
fixture-driven — no network in tests, same convention as every prior CLI test in this repo)

**Interfaces (Consumes):** everything from Tasks 2/4/5/6/7; `getClient/openRun/closeRun/
insertIfAbsent/additivePatch/isMissingColumnError/isMissingRelationError` from `src/lib/db.js`.

**Flow (per run, `--session-id <legiscan_session_id> [--dry-run] [--dataset-file <path>]`):**
1. `openRun(client, SOURCE)`; `getMonthlyQueryUsage` + `assertUnderBudget` BEFORE any live call —
   refuses to start if this run's planned query count would plausibly exceed the configured
   monthly cap (Q2).
2. `decodeDatasetHashGate` against `legiscan_datasets` for the requested session — single-row
   lookup by the `legiscan_session_id` primary key, plain `.select()`, `selectAll` not needed;
   skip `getDataset` entirely on a hash match (mandatory gate, Task 2).
3. Ensure/find the `sessions` row (Task 1's `legiscan_session_id` column; Regular→bare-year
   identifier, Special→derived identifier, per the Global Constraints resolution) — single-row
   lookup by the unique `legiscan_session_id` column, `selectAll` not needed.
4. Decode + parse the dataset (Task 4); for each bill: `insertIfAbsent('bills', ...,
   'session_id,identifier')` with the normalized identifier (Global Constraints); for each
   sponsor/person encountered: `resolveOrCreateLegiscanPerson` (Task 5); for each roll call:
   `reconcileLegiscanTallies` → on pass, `insertIfAbsent('votes', ..., 'source_key')` with
   `buildLegiscanVoteSourceKey` → `crossCheckAgainstPrimarySource` (Task 6) → per-cast
   `VOTE_ID_MAP` + `insertIfAbsent('vote_casts', ..., 'vote_id,legislator_id')`; on reconcile
   failure, the roll call is skipped with an honest count, never stored (same convention as every
   prior parser in this repo).
5. Provenance: every written row's `source_url` is the LegiScan record URL from the payload
   (`bill.url`/`roll_call.url` — real fixture fields, e.g.
   `https://legiscan.com/MO/rollcall/SB894/id/747209`); `ATTRIBUTION` constant (Task 2) rides in
   `closeRun`'s detail.
6. `closeRun` with full counts `{ sessions, bills, people: {matched, created, ambiguous}, votes,
   casts, reconciliationFailures, crossCheckFlags, queriesUsed }`.

- [ ] TDD the pure parts (budget-gate refusal, dry-run planning, dataset-hash-gate skip
      reporting) with fakes; implement; green.
- [ ] Local no-network smoke: `node src/cli/ingest-legiscan.js --dataset-file
      tests/fixtures/research/legiscan/mo-2018-dataset.json --dry-run` → prints the real plan
      (bill/vote/people counts from Task 3's fixture), 0 writes.
- [ ] Commit `feat: legiscan ingest driver - dataset-bulk backfill, budget+hash gated`.


## CONTROLLER RULINGS (binding, appended — the accumulated obligations of Tasks 1-8; each is load-bearing)

1. ORDER OF WRITES: crossCheckAgainstPrimarySource runs BEFORE insertIfAbsent('votes') — quarantine:true means that LegiScan vote and its casts are NEVER written. For quarantined/flag rows, the flags FK anchors per Task 6's built shapes (primary row's vote id; read the T6 code and tests, don't re-derive).
2. POST-FETCH HASH: after decoding a fetched dataset, compare the archive's OWN hash.md5 content (Task 4's decode surface exposes it) against the getDatasetList dataset_hash that justified the fetch — mismatch throws DatasetHashMismatchError (its designed throw site is HERE) and the dataset is not parsed.
3. BUDGET: incremental persistence of queries_used (crash must OVERCOUNT, never undercount — write-ahead per query or per small batch into the run's detail, not only at closeRun); assertUnderBudget becomes >= (refuse AT the cap); add the decodeDatasetHashGate sessionId-vs-ledgerRow assert and buildUrl missing-key fail-fast (T2 review items (c)).
4. SESSION IDENTITY: LegiScan 2026 Regular Session must resolve onto the EXISTING '261' sessions row (mo-house-xml's identifier; 2,099 bills attached) — match via year+name mapping, fail-loud if ambiguous; other Regular Sessions use bare-year identifiers; Specials get distinct identifiers; stamp legiscan_session_id via additivePatch.
5. ATTRIBUTION: single-bill-primary (T7 ruling): roll_call.bill_id verbatim; per-roll-call source_url comes from the PARENT BILL's votes[] array keyed by roll_call_id (roll_call payloads have NO url field); source_key per T6's builder.
6. IDENTITY: every dataset person runs resolveOrCreateLegiscanPerson (T5); unresolved people_ids in casts → honest unresolved counts (T6's builder).
7. RUN DETAIL must surface distinctly: quarantined votes; no_tally_corresponding_primary flags (HIGHER-priority human-review class per T6 round-2); ambiguous_tally_match; unresolved casts; edited/gated counts; per-chamber vote counts (Task 10 compares these against primary-source counts as the House-gap evidence).
8. vote_id 3 ('Not Voting'): first live sighting → log a spot-verify line (vote_text confirmation) in run detail; the mapping is doc-cited, never fixture-confirmed.
9. dataset_hash STORE-AND-COMPARE gate before any getDataset (suspension-level); legiscan_datasets ledger rows via 0010 (applied live); local ZIP cache per session+hash, gitignored.
10. All reads via selectAll; all writes additive (insertIfAbsent/additivePatch); provenance run_id everywhere; NO model calls; limiter 1000ms; access_key threading per T3; CC BY: votes.source_url points at LegiScan's public bill/roll-call URL (from the bill payload's url/state_link fields — prefer state_link where present: it points at the STATE's own page, the better receipt).
11. CLI shape: --session <legiscan_session_id> [--limit N] [--dry-run]; dry-run = zero live queries, plan from cache/fixtures only. NO live run this task — Task 10 owns the first live slice. Tests: fake-client + the two dataset fixtures end-to-end (1579 zero-votes and 1608 full path — 8 roll calls through identity+votes+casts with real numbers asserted).
