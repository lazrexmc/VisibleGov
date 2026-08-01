# Task brief — TODO 26: backfill NULL bill titles from cached LegiScan datasets

Approved by Lance (2026-08-01, in a stretch where he capped spend: "What can we continue without
usage?" → this was offered and approved). **Zero model calls anywhere in this task** — it is pure
data extraction and a mechanical DB write. That property must remain true after the fix; do not
introduce any path that calls an LLM.

## The problem

`bills.title` is NULL on 2,020 rows (live count, will drift — read live, don't hardcode). These
bills were stub-inserted (session/identifier only) by some earlier ingestion path before the title
field was populated, or came from a source that doesn't carry titles. LegiScan's own weekly
dataset ZIPs — already downloaded and cached at `.superpowers/artifacts/legiscan-datasets/*.json`
(31 files, one per MO session 2010-2026, per `docs/ARTIFACTS.md`) — carry every bill's `title` and
`bill_number`. This is a straight backfill: for every NULL-title bill, find the matching LegiScan
dataset entry and write its title in.

## What already exists — reuse it, do not reinvent

- `src/adapters/legiscan-dataset.js`: `decodeDatasetZip(base64Zip)` → Buffer,
  `extractDatasetFiles(zipBuffer)` → `{ bills, people, rollCalls }` (bills is an array of LegiScan
  bill records with `.title`, `.bill_number`, `.session_id`), `normalizeBillIdentifier(bill_number)`
  → the exact string format stored in `bills.identifier` (verified live: `"HB1"` → `"HB 1"`).
- `src/cli/ingest-legiscan.js:274-291` (`ensureLegiscanBillRows`) is the reference for how a
  LegiScan dataset bill record maps to a `bills` row and which key matches it to the DB:
  **`(session_id, identifier)`** via `insertIfAbsent(client, 'bills', rows, 'session_id,identifier')`.
  Your backfill must resolve the SAME `session_id` for a match — read how `ensureLegiscanSessionRow`
  (same file) resolves a dataset's session to the DB's `sessions.id`, and reuse that resolution, not
  a rederived one. **This is a correctness requirement, not a style preference**: TODO 25 documents
  that the current MO 2026 session is split across two `sessions` rows (identifier `'261'` correct,
  identifier `'2026'` a duplicate-in-progress) — writing a title against the wrong session's row
  would make the split worse, not better, and would be invisible until a bill page rendered wrong.
  If your matching resolves a bill to a session-row you cannot confidently identify as the single
  correct target, exclude that bill from the write and count it, honestly, as unresolved — never
  guess.

## Task

Build `src/cli/backfill-bill-titles.js`, callable as
`node --env-file=.env src/cli/backfill-bill-titles.js [--dry-run] [--limit N]`.

1. **Read all NULL-title bills** from the live DB: `id, session_id, identifier`. Use `selectAll`
   (project law — the 1000-row cap has bitten this repo repeatedly; ~2,020 rows will hit it).
2. **Load every cached dataset** from `.superpowers/artifacts/legiscan-datasets/*.json`, decode +
   extract each (the files are already on disk — this makes ZERO network calls, confirm that
   nothing in your code path reaches `fetchWithLimit`/`legiscanLimiter`/any adapter fetch
   function). Build an in-memory index keyed by `(resolved_session_id, normalized_identifier)` →
   `title`, resolving each dataset's session the same way `ensureLegiscanSessionRow` would (read
   it; you may need to query `sessions` once, read-only, to map a dataset's LegiScan session
   identity to the DB row — cache that lookup, don't requery per bill).
3. **For each NULL-title bill**, look up its `(session_id, identifier)` in the index. If found and
   the title is a non-empty string, stage an UPDATE of `bills.title` for that row ONLY (never touch
   any other column — canonical_url, status, etc. are out of scope for this task). If not found,
   count it as `unresolved` with a reason (`no matching dataset entry` / `dataset title also empty`
   / `session could not be confidently resolved`) — do not write, do not throw.
4. **Idempotency / concurrency safety**: the UPDATE must be conditioned on `title IS NULL` at write
   time (an `.is('title', null)` filter in the same request, not just the initial SELECT) — the
   scheduler ingests concurrently and a bill could legitimately gain a title between your read and
   write. A second run of this script against an already-backfilled DB must update 0 rows and
   report that honestly, not error.
5. **`--dry-run`**: report `{ nullTitleBills, resolvable, unresolved: { count, byReason }, wouldWrite }`
   — zero writes, exactly like this repo's other CLIs. **`--limit N`**: cap how many bills get
   written this run (same `parsePositiveIntegerFlag` guard pattern other CLIs use — reject
   NaN/0/negative loudly, never silently "process everything").
6. **Live mode**: perform the writes, then report `{ nullTitleBills, resolved, written, unresolved:
   {...}, failures: [...] }` — every number honest, matching this repo's existing counts
   conventions (see `data-status.js` or `summarize.js` for the tone).
7. Log via `openRun`/`closeRun` against `ingestion_runs` with `source: 'title-backfill'` (a new
   source key — this is not "legiscan" traffic, it makes no LegiScan request, and conflating it with
   the real legiscan source would corrupt that source's due-ness signal for the scheduler). This CLI
   is NOT added to the scheduler's registry — it's a one-time backfill Lance runs by hand, not a
   recurring source. Do not touch `scripts/scheduled-ingest.js`.

## Constraints

- **Zero model calls, verified**: no import of anything Anthropic-adjacent, no subagent dispatch.
- **Zero network calls**: everything reads from the already-cached dataset files on disk.
- TDD red-first. Fixture-based tests only — use `tests/fixtures/research/legiscan-*` or synthesize
  small dataset-shaped fixtures; no live network/DB in tests.
- `selectAll` for any multi-row read; `parsePositiveIntegerFlag` for `--limit`; typed errors
  matching this repo's conventions; bare `node --test` from repo root, baseline currently 2105 must
  stay green.
- Extract the literal `ℹ fail` line yourself; commit ONLY at 0 (PLAYBOOK lesson 14 — never gate on
  a pipeline's exit status).
- This writes production data — draft-then-apply in spirit even though it's a script Lance runs
  himself: your job is to build and test it; DO NOT invoke it against the live DB yourself as the
  final step. Report status with `--dry-run` output attached as evidence the logic is sound, and
  stop there. Lance (or the controller on his explicit go) runs the live pass.
- Commit message explains the defect/gap and the fix, ends with:

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

Return: status, commit hash, fail-count line verbatim, the `--dry-run` output against the real
live DB (counts only — resolvable vs unresolved, with the unresolved reason breakdown), and any
concerns — especially anything that made you uncertain about a session match (per the TODO-25
sensitivity above).
