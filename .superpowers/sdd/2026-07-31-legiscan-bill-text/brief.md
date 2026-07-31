# Task brief — LegiScan `getBillText` volume path (`ingest-legiscan-texts`)

**Goal:** fill `bill_texts` for Missouri at volume, which is the single gate on plain-language
summaries (154 of 3,280 accountability-relevant bills currently have text). Lance approved this
path 2026-07-31 over direct state fetching, because house.mo.gov's published ToU caps automated
pulls at once per 30 minutes (18,336 House bills ⇒ ~382 days) and because **2,202 bills have no
usable `state_link` at all** — their cached link is one shared `reflect.legiscan.com/Proxy.php`
placeholder, so the API is their only source.

**Budget reality:** 30,000 queries/month (resets the 1st). One `getBillText` = 1 query. The
priority set (bills carrying a passage/third-reading roll call) is ~3,116 bills ≈ **10% of one
month's budget**. At the resolved 1000 ms limiter that is ~52 minutes of wall clock.

## Binding rules (from `docs/research/2026-07-28-legiscan-terms.md` — violations marked ⛔ are
suspension-level; these are law, not guidance)

1. **Monthly cap.** Use the existing budget machinery in `src/adapters/legiscan.js`
   (`getMonthlyQueryUsage`, the cap constant/env override, and the write-ahead accounting pattern
   `src/cli/ingest-legiscan.js` already implements — read it and mirror it exactly, including
   carrying `queries_used` through BOTH close paths, which was a fixed bug there).
   A run that could plausibly exceed the configured cap **refuses to start**.
2. **Rule 7 — a document blob is downloaded at most once per `doc_id`, ever.** Cache the raw JSON
   response per `doc_id` under `.superpowers/artifacts/legiscan-texts/<doc_id>.json` (gitignored,
   like the dataset ZIPs); a cached doc_id is NEVER re-queried, in this run or any future run,
   even if its `bill_texts` row was deleted. Check cache before spending a query.
4. **Rule 4 — check `status` on every JSON response** (OK/ERROR) and act on it with typed errors.
   `src/adapters/legiscan.js` already has this discipline; reuse its response handling.
5. ⛔ **Never scrape legiscan.com's front end.** `api.legiscan.com` only, via the existing
   `buildUrl`/client in `src/adapters/legiscan.js`.
6. **Timing: RESOLVED, do not re-research.** `LEGISCAN_MIN_INTERVAL_MS = 1000` with the
   `legiscanLimiter` singleton — the manual was fetched and fully read by an earlier task and
   contains no per-request pacing value (see the long comment above the constant). Use that
   limiter; do not add a second one, do not change the interval.
7. **Access key** comes from the existing env plumbing (`LEGISCANAPI`) with the established
   redaction discipline — the key must never appear in a log line, an error message, a run detail
   payload, or a cached artifact. Check how `ingest-legiscan.js` threads and redacts it.

## The work

CLI: `node --env-file=.env src/cli/ingest-legiscan-texts.js [--dry-run] [--limit N] [--session <legiscan_session_id>] [--priority-only]`

- `--limit` uses the shared fail-loud positive-integer validation (a malformed value throws).
- **Worklist** (reuse the planning already written in `src/cli/backfill-mo-bill-texts.js` — import
  its exported planner if practical rather than duplicating; it already does cached-dataset
  reading, exact bill/session matching, latest-version selection with a robust comparator,
  `alreadyHasVersion` skipping, and passage-priority ordering): for each planned bill take the
  selected text entry's **`doc_id`**. `--priority-only` restricts to passage/third-reading bills.
- **Per bill:** cache-check `doc_id` → if absent, ONE `getBillText` query through `legiscanLimiter`
  → verify `status` → persist the raw response to the doc_id cache → decode `text.doc` (base64) →
  if `mime` is PDF, extract with `extractPdfText` from `src/adapters/pdf-text.js`; if the payload is
  plain text/HTML, handle honestly (HTML → count `skippedNonPdf`-style bucket in v1 rather than
  inventing an HTML-to-text path).
- **Store** exactly as the sibling does: `version` VERBATIM from the entry's `type`,
  `content_hash` via the same `sha256` helper, `source_url` = the entry's `state_link` when it is a
  real state host, else the LegiScan doc URL — **and comment the choice**: the receipt must point
  somewhere a reader can actually verify, so prefer the state's own link and fall back to
  LegiScan's `https://legiscan.com/MO/text/<bill>/id/<doc_id>` for the proxy-placeholder bills.
  Bare `.insert()` + 23505-tolerance (never upsert — the sibling's reviewer confirmed this is the
  right idiom because it cannot be config-flipped into an overwrite).
- Honor `MAX_TEXT_CHARS`: oversize is REFUSED and counted, never truncated.
- **Honest counts** that reconcile (the sibling's HIGH finding — assert reconciliation in a test):
  `{ billsPlanned, alreadyHasVersion, docCacheHits, queriesSpent, statusError, decodeFailed,
  nonPdfMime, extractEmpty, oversizeRefused, inserted, alreadyPresent, budgetRefused }`, plus
  `failures[]` carrying `{ step, billId, identifier, docId, message }` with `step` differentiated
  (`query | decode | parse | extract | oversize | insert`).
- **Write-ahead budget accounting:** increment and persist `queries_used` BEFORE the query is
  issued (the established pattern — an overcount is safe, an undercount is a terms violation), and
  carry it through both close paths.
- `--dry-run`: zero queries, zero writes; reports every count knowable without querying, including
  how many doc_ids are already cached and the exact query count the live run would spend.

## Response shape — verify, don't assume

The expected shape is `{status:'OK', text:{doc_id, bill_id, date, type, type_id, mime, mime_id,
text_size, text_hash, doc:'<base64>'}}` — but **confirm it with exactly ONE real probe** against a
known MO doc_id before building against it (1 query of 30,000; capture the response as a small
committed fixture with the `doc` blob truncated to a few hundred bytes, and note the real shape in
your report if it differs). Do not spend more than that one probe.

## Tests (TDD, failing first) — `tests/ingest-legiscan-texts.test.js`

Cache-hit spends no query; budget-cap refusal before any query; `status:'ERROR'` → typed error,
counted, run continues; base64 decode failure counted; non-PDF mime counted, nothing stored;
oversize refused, nothing stored; `version` verbatim; insert-if-absent 23505 tolerance;
`--dry-run` spends zero queries and writes nothing; `--limit` validation; counts reconcile;
key never appears in any run-detail/failure payload (assert on a redaction test).

Full suite: bare `node --test` from repo root, baseline **1803** stays green.

## Out of scope

Federal text (already done), HTML text versions, the MO 2024 roll-call gap, summarization itself,
and any live run (the controller operates those, in budgeted batches).

Commit: `feat: LegiScan getBillText volume path (budgeted, doc_id-cached, $0)` ending with
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
