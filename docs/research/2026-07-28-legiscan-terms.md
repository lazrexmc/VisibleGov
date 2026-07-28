# LegiScan API — operating terms we agreed to (2026-07-28)

Lance registered a Public API key (survey answers: non-commercial, externally published with
CC BY 4.0 attribution, Missouri coverage, custom Node client, agentic-coding disclosed).
These are LegiScan's operating rules from their onboarding page, recorded here as BINDING
requirements on any LegiScan adapter this repo ever builds. Violations they enforce with
suspension are marked ⛔.

## Hard rules (mechanically enforced in the adapter, not just documented)

1. **30,000 queries/month**, resets the 1st. Budget tracking lives in ingestion_runs detail;
   the adapter refuses to start a run that could plausibly exceed a configured monthly cap
   (default well under the limit).
2. ⛔ **dataset_hash comparison is MANDATORY before any getDataset download** — "failure to do
   so will result in suspended access." Store dataset_hash per session; skip on match. Same
   pattern as our source_hash discipline.
3. **change_hash discipline everywhere**: getMasterListRaw/getSearchRaw drive the work loop;
   individual getBill/getRollCall spend happens ONLY when change_hash differs from the stored
   value. ("Use the hashes. No. Really. Use them.")
4. **Check `status` on every JSON response** for OK/ERROR and act on it (typed errors, our
   skip≠empty convention).
5. **Local caching of raw JSON responses** for replayability — matches our fixture/cache
   conventions; nothing is ever re-queried for data we already hold.
6. **Follow the timing guidelines on Page 7 of the LegiScan API Manual** — fetch and encode
   into the adapter's limiter before the first bulk run.
7. **Document blobs (getBillText etc.) are downloaded at most once** per doc_id — Base64 in
   JSON transport, decoded and stored locally.
8. ⛔ **Never scrape legiscan.com's front end.** API only.
9. ⛔ **One key.** Never create additional Public API keys.
10. **CC BY 4.0 attribution** on every public surface displaying LegiScan-derived data, with
    link. Belongs in Plan 3's page templates and the site footer.

## Design implications for the MO backfill (why this changes the timeline)

- Datasets are weekly (Sunday 5am ET) ZIPs holding every getBill/getRollCall/getPerson payload
  for a session; "~1000 API queries for 3.5M+ records for ALL 2010-2026 data" — so the whole
  MO 2015→2026 backfill is on the order of TENS of queries, versus weeks of 30-minute-cadence
  primary-source PDF pulls.
- Our primary-source parsers (house.mo.gov XML/PDFs, senate.mo.gov journals) do NOT retire:
  they become the reconciliation/audit layer. LegiScan cast lists reconcile against the
  printed tallies in the official record (House XML TotalYes/TotalNo, Senate journal —N
  counts) before storage — reconcile-or-throw, same as today. Aggregator speed, source-of-
  record integrity.
- ZIP payloads are Base64 inside JSON: adapter must stream/decode carefully (memory) and
  cache the decoded archive per session+dataset_hash.

## Status

Key: not yet in .env. Next step: 4-query verification probe (session list + one known MO roll
call) to confirm MO's individual votes are populated before any adapter build is planned.
