# Task brief — MO bill-text fetcher (`backfill-mo-bill-texts`)

**Goal:** close the bottleneck between VisibleGov's vote data and its plain-language summaries.
3,280 MO/federal bills carry a passage-or-third-reading vote; we hold text for 154 of them. Every
bill in the 31 cached LegiScan dataset ZIPs carries a `texts[]` array whose `state_link` points at
the **state's own official PDF** — so the text is obtainable for $0: no LegiScan API queries (the
datasets are already cached on disk), no model calls, just polite fetching from
documents.house.mo.gov / senate.mo.gov and the PDF extraction this repo already owns.

**Zero-spend constraint (project law):** no Anthropic/LLM calls anywhere in this task, and no
LegiScan API queries — cached ZIPs only, skip-with-count if a dataset file is missing.

## Verified shapes (confirmed by the controller against live data + cached artifacts — do not re-derive)

`bill_texts` columns: `id, bill_id, version, content, content_hash, source_url, retrieved_at, run_id`.
Unique constraint is `(bill_id, version)` (migration 0001) — so multiple versions per bill are legal
and idempotency is per-version.

A cached dataset bill record (`extractDatasetFiles(...)` → `{ bills, people, rollCalls }`; `bills` is
an array) carries:

```
bill_number: 'HB1607'   session_id: 2239   title, description, status, ...
texts: [ {
  doc_id: 3286261, date: '2025-12-01', type: 'Introduced', type_id: 1,
  mime: 'application/pdf', mime_id: 2,
  url: 'https://legiscan.com/MO/text/HB1607/id/3286261',      // NOT this one
  state_link: 'https://documents.house.mo.gov/billtracking/bills261/hlrbillspdf/5106H.01I.pdf',
  text_size: 93238, text_hash: 'aeb34…'                        // LegiScan's MD5 of the DOC
} ]
```

All 3,146 bills in session 2239 carry ≥1 text entry. `state_link` is the official state document —
fetch that, never LegiScan's `url` (that is their HTML viewer, and their terms bind their API).

## Modules to reuse (import, never reimplement)

- `src/adapters/legiscan-dataset.js` → `decodeDatasetZip`, `extractDatasetFiles`, `normalizeBillIdentifier`
- `src/cli/backfill-mo-bill-meta.js` — read it first: its cached-ZIP reading, `loadSessionIndex`
  (`sessions.legiscan_session_id` → session row id), bill-identifier matching, bulk `selectAll`
  loaders, honest-count/run-record shape, and `--dry-run` conventions are the pattern to mirror.
- PDF text extraction: `src/adapters/mo-senate-journal-pdf.js` → `extractJournalText(buffer)` and
  `src/adapters/mo-rollcall-pdf.js` → `extractRollCallText(buffer)` are the two existing pdfjs
  consumers. Read both; if neither is a clean fit for a *bill* PDF, extract the shared
  page-text-join core into a new small module both can use (do NOT copy pdfjs setup a third time —
  a third copy is a review-rejectable defect).
- `src/lib/rate-limiter.js` → `createLimiter({ minIntervalMs })`. MO document servers are the same
  hosts the journal/rollcall fetchers already use politely — match their cadence, do not go faster.
- `src/lib/summarizer.js` → `MAX_TEXT_CHARS` (400000). Honor it: an oversize extraction is REFUSED
  with an honest count, never truncated (existing project law; the giant-bill policy is parked).
- `src/lib/db.js` → `selectAll`, the insert helpers, run-record open/close.

## Behavior

CLI: `node --env-file=.env src/cli/backfill-mo-bill-texts.js [--dry-run] [--limit N] [--session <legiscan_session_id>]`

- `--limit` uses the shared fail-loud positive-integer validation added in the public-site branch
  (see `src/cli/enrich-federal-bills.js` / `summary-queue.js`) — a malformed value throws, never
  silently means "no limit".
- **Worklist:** for every cached MO dataset (or just the `--session` one), match each dataset bill to
  our `bills` row via `normalizeBillIdentifier(bill_number)` + `sessions.legiscan_session_id`
  (exact keys only — an unmatched bill is an honest count, never guessed). Skip bills that already
  have a `bill_texts` row for the version we would write.
- **Version selection (v1 ruling):** fetch the **latest** text entry by `date` (ties → highest
  `doc_id`), i.e. the most operative form of the bill. Store `version` as the entry's printed
  `type` string verbatim (`'Introduced'`, `'Perfected'`, `'Truly Agreed to and Finally Passed'`, …)
  — never invented, never normalized. Because the unique key is `(bill_id, version)`, a later run
  that adds earlier versions will not conflict; do not fetch multiple versions in v1.
- **Priority order:** bills carrying a passage/third-reading roll call first (same regex family as
  `summary-queue.js`'s priority: `/passage|third\s*read|3rd\s*read/i` over `votes.question`), then
  the rest. Report both counts.
- **Fetch:** only `mime === 'application/pdf'` entries in v1; a non-PDF mime is an honest
  `skippedNonPdf` count (HTML text versions are a later task). Fetch `state_link` through the
  limiter, with the project's existing typed-error discipline; a non-200 or empty body is a counted
  failure, never a stored empty row.
- **Extract → store:** extracted text must be non-empty and ≤ `MAX_TEXT_CHARS`; compute
  `content_hash` with the repo's existing convention (match what `enrich-federal-bills.js` does —
  read it, do not invent a second hashing scheme); insert with `source_url = state_link`,
  `retrieved_at = now`, `run_id`. Insert-if-absent on `(bill_id, version)`; a 23505 is tolerated and
  counted `alreadyPresent`, never fatal.
- **Honest counts:** `{ datasetsRead, datasetsMissing, billsSeen, billMatched, billUnmatched,
  alreadyHasVersion, skippedNonPdf, fetched, fetchFailed, extractEmpty, oversizeRefused, inserted,
  alreadyPresent }` plus a `passagePriority` breakdown, and a `failures[]` array carrying
  `{ step, identifier, message }`. `--dry-run` performs zero fetches and zero writes and prints the
  planned worklist head plus every count it can know without fetching.
- **Resumability:** DB-keyed (the already-has-version check) so re-running after an interrupt
  resumes naturally; no artifact state file.

## Tests (TDD, failing first)

`tests/backfill-mo-bill-texts.test.js`, driven by fake clients + committed fixture shapes (reuse the
existing dataset fixtures under `tests/fixtures/`; capture at most one small real MO bill PDF only
if a real extraction fixture is genuinely needed, and keep it small):

- latest-version selection (multi-entry `texts[]`, out-of-order dates, date tie → higher `doc_id`)
- `version` stored verbatim from `type`
- unmatched bill → `billUnmatched`, no fetch attempted
- existing `(bill_id, version)` row → `alreadyHasVersion`, no fetch attempted
- non-PDF mime → `skippedNonPdf`, no fetch
- oversize extraction → `oversizeRefused`, nothing stored, no truncation
- empty extraction → `extractEmpty`, nothing stored
- fetch non-200 → counted failure, run continues, nothing stored
- `--dry-run` performs zero fetches and zero writes
- `--limit 5O` (letter O) throws; `--limit 0` throws; `--limit 12` works
- passage-priority ordering puts a passage-vote bill ahead of a non-voted bill

Full suite: bare `node --test` from repo root, baseline **1726** stays green.

## Out of scope (do not build)

Federal text (already handled by `enrich-federal-bills.js`), HTML/non-PDF versions, multi-version
backfill, the 2024 MO roll-call gap, any summarization. Live runs are the controller's.

Commit: `feat: MO bill-text fetcher (cached dataset state_links, $0)` ending with
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
Report to `.superpowers/sdd/2026-07-31-mo-bill-texts/report.md`.
