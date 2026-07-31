# Final-review fix wave — report

Branch: `mo-senate-adapter`. Source of truth for scope:
`.superpowers/sdd/2026-07-28-mo-senate-adapter/final-review-findings.md` (6 findings, workflow
wf_a41a3805-e7b).

Full suite: **626/626 passing** (`node --test`), up from the 580 baseline (initial wave: 621; addendum
below: +5 more). Zero live DB writes, zero network calls in any test — every new/changed test uses
fixture PDFs, fake clients, or scratch directories. The senate cadence loop was not touched or
started.

Commits (newest first):

| SHA | Findings | Summary |
|---|---|---|
| `0874568` | 1 (sweep) | gloss.js's `loadAllTerms` paginated — judgment-call addendum |
| `004b27d` | 1 (addendum) | auto-publish-glossary.js's `loadDraftTerms` paginated — controller-adjudicated |
| `512926a` | 6 | Exhaustive glossary bucketing, moved to a testable module |
| `790d7bc` | 1 + 3 | auto-publish-glossary.js: paginate verifications, exclude post-verification edits |
| `0c02f59` | 1 | Shared `selectAll` pagination utility + review server wiring |
| `b1915cc` | 4 + 5 | Journal fetch/extraction failures routed through day-level quarantine |
| `1173b55` | 2 | Hard refusal for MO Senate roster years with no archived source |

---

## Finding 1 — CRITICAL: unbounded selects truncate at Supabase's 1000-row cap

**Fix direction (given):** `.range()` pagination loops (the `ingest-mo-house.js` pattern),
assert-loud if a page returns full at the end without terminating. One shared utility used by all
four named call sites.

**What changed**

- `src/lib/db.js:85` — new `selectAll(client, table, columns, { filter, pageSize, maxPages })`.
  Loops `.range()` pages (default 1000, matching Supabase's real cap) until a page returns short.
  A `filter` callback may chain its own predicate/order onto the query; `selectAll` always appends
  `.order('id', { ascending: true })` afterward as a deterministic tiebreaker — pagination via
  `.range()` is only correct with a deterministic order, and two of the four call sites had no
  `ORDER BY` at all before this fix. If the loop exhausts `maxPages` (default 200) while the last
  page fetched is still full-sized, it **throws** rather than returning a result that looks
  complete — the "assert-loud" half of the fix direction. This retires the one-off pagination
  pattern `ingest-mo-house.js`'s `dryRunReport` used privately (that fix was never shared, which is
  exactly how the same bug shipped three more times).
- Four call sites now route through it:
  - `src/cli/auto-publish-glossary.js:133` — `loadLatestVerifications` (glossary_verifications).
  - `src/review/server.js:300` — `handleQueue`'s `summary_verifications` select.
  - `src/review/server.js:450` — `handleGlossaryQueue`'s `glossary_terms` select (this is the
    literal "created_at-ASC queue select drops the NEWEST terms" call site named in the finding).
  - `src/review/server.js:472` — `handleGlossaryQueue`'s `glossary_verifications` select.

**Test evidence**

- `tests/db.test.js` — a new `makeCappedTableClient` fake that **enforces** Supabase's real
  1000-row-per-request cap (any `.range()` call, however wide, comes back capped) — the prior fakes
  across the suite returned their whole seeded dataset in one shot regardless of range, which is
  exactly why the original bug shipped with a green suite. 9 new tests: the fake's own cap-sanity
  check; `selectAll` retrieving all 2,500 rows across 3 pages; the newest row (highest id) surviving
  past page 1; empty-table/1-page short-circuit; `filter` predicate applied on every page;
  pageSize-agnostic pagination math; error propagation from a mid-loop page; and the assert-loud
  `maxPages` throw.
- `tests/review-logic.test.js` — two new HTTP-level integration tests against
  `/api/glossary/queue` using a dedicated capped-table fake: 1,500 draft terms proves the newest
  term (`t-1499`) survives past the first 1000-row page; 1,200 verification rows for one term proves
  its newest (clean) verification wins over an older (flagged) one that would otherwise be the only
  page-1 hit. `fakeQuery`'s shared builder gained `.range()` so every existing fake in the file
  stays chain-compatible.
- `tests/auto-publish-glossary-cli.test.js` — the `makeStatefulClient` fake's
  `glossary_verifications`/`glossary_notes` builders gained `.order()`/`.range()` so
  `loadLatestVerifications`/`loadLatestEditNotes` keep working through the existing idempotency
  tests.

**Open detail I decided:** the finding names exactly four call sites; `loadDraftTerms` in
`auto-publish-glossary.js` (glossary_terms, ordered `created_at` ascending, no `selectAll`) has the
same unbounded-select shape but was not named — I left it unpaginated to stay inside the finding's
stated scope rather than silently expanding it. Flagged under Concerns below.

---

## Finding 2 — CRITICAL (latent): roster fallback resolves historical years against today's members

**Fix direction (given):** hard refusal for any historical year absent from
`SENATE_ROSTER_ARCHIVE_URLS`, honest message naming the missing roster source and
`SENATE_ROSTER_ARCHIVE_URLS` as the extension point. 2018 and the current calendar year keep
working.

**What changed**

- `src/cli/ingest-mo-senate.js:138` — new `RosterSourceUnavailableError`.
- `src/cli/ingest-mo-senate.js:149` — `pickRosterSource(year, currentCalendarYear = <real year>)`
  now: archived year → archive URL (unchanged); `year === currentCalendarYear` → live current
  roster (the one case where "today's roster" is correct by definition); anything else → throws
  `RosterSourceUnavailableError` whose message names the specific year, states it's neither
  archived nor current, and names `SENATE_ROSTER_ARCHIVE_URLS` as the extension point.
- `src/cli/ingest-mo-senate.js:536` — `ensureRosterForRun` gained an injectable
  `currentCalendarYear` option, threaded through to **both** `pickRosterSource` and
  `effectiveMaxAge` — the refusal fires before any live fetch or `writeCache` call, so a wrong
  roster can never get written into a closed year's cache (which `effectiveMaxAge` makes never
  expire — the exact permanent-poisoning path the finding names).

**Test evidence** (`tests/ingest-mo-senate-cli.test.js`)

- `pickRosterSource`: current-year → live HTML; a historical year absent from the archive (2020) →
  throws `RosterSourceUnavailableError` with `.year`/`.currentCalendarYear` set and a message
  matching both `/2020/` and `/SENATE_ROSTER_ARCHIVE_URLS/`; a future year is refused the same way
  ("current year" means exactly one year, not `>=`); string-year input still resolves/refuses
  correctly.
- `ensureRosterForRun`: a refused year with no cache never calls the injected `fetchLive` and never
  writes a cache file (the actual poisoning-prevention proof); the current calendar year still
  fetches live normally (the refusal doesn't regress the one case that must keep working); a
  **pre-existing** warm cache for a since-refused year is still trusted as-is (the refusal only
  gates a fresh fetch).

---

## Finding 3 — IMPORTANT: auto-publish eligibility not bound to the verified text

**Fix direction (given, controller ruling):** exclude terms whose newest `glossary_notes`
edit-action postdates the latest verification's `created_at`; no migration (0007 is applied);
content-hash binding can come later.

**What changed**

- `src/cli/auto-publish-glossary.js:158` — new `loadLatestEditNotes(client, dryRun)`: paginated
  (via `selectAll`, filtered server-side to `action='edited'`) reduce to the newest edit's
  `created_at` per `term_id`.
- `src/cli/auto-publish-glossary.js:56` — `planAutoPublish(terms, latestVerificationByTermMap,
  latestEditNoteByTermMap = new Map())`: after the existing clean-verification check, compares the
  term's newest edit timestamp against `verification.created_at`; if the edit is newer, the term is
  excluded into a new `editedSinceVerification` bucket instead of `eligible`. Default empty map
  keeps existing 2-arg callers/tests unaffected.
- `main()` wires `loadLatestEditNotes` in, and reports `editedSinceVerification` — count and full
  `{id, term}` list — in both dry-run output and the live run's console/`closeRun` detail, per the
  "never silently" ground rule.

**Test evidence** (`tests/auto-publish-glossary-cli.test.js`)

- `planAutoPublish`: edit after verification → excluded, appears in `editedSinceVerification`; edit
  before verification → still eligible (verifier already saw the current text); no edit note at all
  (the normal auto-glossed path) → unaffected; omitted 3rd arg → unaffected (backward compat); mixed
  batch + empty-list tests updated to the new 5-bucket shape.
- `loadLatestEditNotes`: keeps only the newest `edited` row per term, ignores other actions; the
  query itself filters server-side to `action='edited'`; empty result → empty map, not an error;
  dry-run tolerates a missing `glossary_notes` relation; a live missing-relation error still throws.
- One end-to-end test drives the CLI's own `loadDraftTerms` → `loadLatestVerifications` →
  `loadLatestEditNotes` → `planAutoPublish` → `autoPublishOne` sequence against a stateful fake:
  a term edited after its clean verification is left at `status: 'draft'` (never auto-published),
  while an untouched clean term in the same batch reaches `status: 'published'`.

---

## Finding 4 — IMPORTANT: driver `main()` crashes on a day's fetch failure, masking the error

**Fix direction (given):** guard aggregation, fold `fetchFailure` into `failures`, test.

**What changed** (committed together with finding 5 — see below, same function)

- `src/cli/ingest-mo-senate.js:592` — new `buildDayFailureResult(dayRow, category, step, err, dir)`
  always returns `attribution: { motion: 0, preceding_taken_up: 0 }` and `failures: 1` (folding a
  whole-day failure into the honest failure count instead of the old `failures: 0`).
- `src/cli/ingest-mo-senate.js:1074` (`main()`'s day loop) — `const resultAttribution =
  result.attribution ?? { motion: 0, preceding_taken_up: 0 };` before the two `+=` lines: a
  defensive second layer on top of the contract fix above, directly closing the
  `Cannot read properties of undefined (reading 'motion')` TypeError the original bare
  `result.attribution.motion` dereference could throw.

**Test evidence** — see finding 5's test list below (`buildDayFailureResult`'s shape, including
`attribution`, is asserted directly in both new `processJournalDay` failure-path tests).

---

## Finding 5 — IMPORTANT: only parse failures quarantine; fetch/extraction failures wedge the FIFO worklist forever

**Fix direction (given):** route fetch failures + extraction throws through the same
attempts/quarantine artifact mechanism.

**What changed**

- `src/cli/ingest-mo-senate.js:617` — `processJournalDay` gained an injectable `fetchPdf` option
  (default `senateWeb.fetchSenateJournalPdf`, same convention as `ensureRosterForRun`'s
  `fetchLive`) so a fetch-failure day is testable without live network.
- The fetch step's existing `catch` and a **new** `catch` around `journalPdf.extractJournalText`
  both call `buildDayFailureResult`, which calls `writeDayFailureArtifact` — the exact artifact
  `excludeQuarantinedDays`/`selectJournalDayWorklist` already use for parse failures. Neither path
  writes a done marker, so the day stays in the worklist and is retried up to
  `JOURNAL_DAY_MAX_FAILED_ATTEMPTS` (3) before quarantining, instead of crashing on every
  subsequent invocation forever.

**Test evidence** (`tests/ingest-mo-senate-cli.test.js`)

- A fetch failure (injected `fetchPdf` throwing `SourceFetchError`) → `result.mode === 'failed'`,
  `result.failures === 1`, `result.attribution` deep-equals the zeroed shape, `result.fetchFailure`
  set, `result.extractionFailure` undefined, no done marker, and a `.failed.json` artifact with
  `attempts: 1`, `category: 'fetch'`.
- An extraction failure — a real, deliberately corrupt local file (`'this is not a real PDF file'`)
  fed through `--journal-pdf-file`, so `extractJournalText` genuinely throws (pdfjs-dist rejects the
  missing `%PDF-` header) — → same shape, `result.extractionFailure` set instead,
  `category: 'extraction'` in the artifact.
- A third test drives the corrupt-file path `JOURNAL_DAY_MAX_FAILED_ATTEMPTS` times and then calls
  `selectJournalDayWorklist`: the day is no longer selected and shows up in
  `skippedQuarantinedKeys` — proving the FIFO-wedge is closed end to end, not just that the artifact
  gets written once.

---

## Finding 6 — IMPORTANT: `computeGlossaryGroups` drops clean-verified/unverified-glossed rows from every bucket and count

**Fix direction (given):** exhaustive buckets (add `'clean — awaiting auto-publish'` + fold
unverified-glossed visibly), move bucketing to a testable module.

**What changed**

- `src/review/glossary-buckets.js:32` (new file) — canonical `computeGlossaryBuckets(items)`: one
  `if`/`continue` chain over 7 buckets, checked in priority order — `published` → `approved` →
  `needsMapping` → `stubs` → `flagged` → `cleanDraft` → `unverifiedGlossed`. Exhaustive by
  construction: the last branch has no condition left to fail, so every item lands in exactly one
  bucket. `'draft'`/`'stale'` status items fall through the same chain (server.js's `TRANSITIONS`
  already treats them identically) rather than getting a separate 9th bucket.
- `src/review/page.html:340` — `computeGlossaryGroups` is now a byte-for-byte-logic hand mirror of
  the module above (page.html has no bundler/`import`, so it can't literally import it — this
  matches the existing duplication convention already used there for
  `verificationBadge`/`glossVerificationBadge`/`TRANSITIONS`, each with its own "mirrors
  server.js's..." comment). The toolbar now names every bucket's count honestly in one line
  (`needsMapping` broken out from `stubs` even though they share one toggle); a new
  "Show N awaiting pipeline" toggle folds `cleanDraft` + `unverifiedGlossed` in, both reachable via
  the `<select>`, with the two counts kept visible in the button label rather than merged into one
  number. `showGlossaryUnavailable` and the toggle click handlers were extended to match.

**Test evidence** (`tests/glossary-buckets.test.js`, 11 tests)

- One test per named state: flagged, clean-draft (the literal finding-6 regression), unverified-
  glossed (the other one), stub, needs_mapping (proven to take priority over stub), approved (proven
  to take priority over flagged), published (proven to take priority over everything), stale (proven
  to fall into the same buckets a draft would, both for a stub and for a clean-draft stale row).
- An exhaustiveness test over a 10-item synthetic mixed set (covering edge combinations like an
  `approved` + `needs_mapping` row): asserts the union of all 7 buckets has exactly `items.length`
  entries with zero duplicate ids — the actual guarantee the finding requires, proven by
  construction rather than enumerated by hand.
- Empty-list test confirms 7 empty buckets (not a crash on an empty items array).

I verified `page.html`'s inline `<script>` still parses as valid JS after the edits (`new
Function(scriptSource)` in Node) since there is no browser/jsdom test harness in this repo to run it
against directly — the canonical logic itself is what's actually unit-tested in
`tests/glossary-buckets.test.js`.

---

## Concerns / follow-ups (not fixed in this wave — flagging, not silently ignoring)

1. ~~Finding 1's scope vs. `loadDraftTerms`.~~ **Resolved in the addendum below** — controller
   adjudicated it in-scope; fixed in `004b27d`.
2. **Finding 3's exclusion is timestamp-only, per the ruling.** A verification and an edit that land
   in the same millisecond (unlikely, but possible under test-harness clock resolution or a
   future faster pipeline) would resolve via plain string comparison (`>`, not `>=`) — the edit
   would NOT be treated as "since" the verification in that exact tie. The ruling explicitly
   deferred the more precise content-hash binding to a future migration; this is that same accepted
   gap, not a new one.
3. **The `docs/superpowers/plans/2026-07-29-legiscan-bulk-adapter.DRAFT.md` file** sitting untracked
   in the working tree predates this session (per its own `.DRAFT.` marker and the existing commit
   history) and is unrelated to this fix wave — left untouched, not committed.

---

## Addendum — coordinator follow-up (post-report)

Two items, both closed:

### 1. `loadDraftTerms` — controller-adjudicated in-scope

Concern 1 above was adjudicated: `glossary_terms` is at 401 live rows and grows with every
summarized bill — a known future trigger for the exact finding-1 truncation class, not a
hypothetical. `src/cli/auto-publish-glossary.js`'s `loadDraftTerms` (line 108) now routes through
`selectAll`, identical in shape to the four originally-fixed call sites. Test: `tests/auto-publish-
glossary-cli.test.js`, a dedicated `makeCappedGlossaryTermsClient` fake proving 1500 draft terms —
including the newest, highest-id row — all come back across pages, plus a companion test proving
the `status='draft'` filter survives pagination. `makeStatefulClient`'s `glossary_terms` builder
gained `.range()` so the pre-existing idempotency/end-to-end tests kept passing.
Commit: `004b27d`. Full suite green (623/623 at that point).

### 2. Full-tree grep for other unbounded `.select()` calls on growable tables

Swept `src/` for `.select()` calls with no `.single()`/`.maybeSingle()`/`.limit()` bound and no
`selectAll` routing, over `votes`, `vote_casts`, `bills`, `legislators`, and the summary-domain
tables. Judgment call applied per the coordinator's instruction: **fixed** the one genuinely
glossary-trust-surface hit found beyond `loadDraftTerms`; **listed, not fixed**, everything else
(ingestion paths and the summary-review path have their own separate pagination history/owners).

**Fixed:** `src/cli/gloss.js:102` — `loadAllTerms` (module-private, now exported) read the SAME
`glossary_terms` table as `loadDraftTerms`/`loadLatestVerifications`, unbounded, no pagination.
Truncation here has a distinct bad consequence from the review-side bugs: a term past the 1000-row
cap would be invisible to `planGlossing` and would never get glossed at all — a permanent, silent
bare stub, no error, no count. Routed through `selectAll`; tests added in `tests/gloss-cli.test.js`
(1500-term capped-fake pagination test + dry-run/live missing-relation tolerance, mirroring
`loadDraftTerms`'s own tests). Commit: `0874568`.

**Listed for the ledger (not fixed — out of this wave's adjudicated scope):**

| Table | File:line | Shape | Note |
|---|---|---|---|
| `summaries` | `src/cli/verify.js:86-90` | `.in('status', TARGET_STATUSES).order('created_at',{ascending:true})`, no pagination | summary-review path |
| `summaries` | `src/cli/extract-terms.js:124-127` | no status filter at all (loads every summary), `.order('created_at',{ascending:true})`, no pagination | summary-review path |
| `summaries` | `src/cli/golden.js:119-123` | `.in('status', SNAPSHOT_STATUSES).order('created_at',{ascending:true})`, no pagination | summary-review path |
| `summaries` | `src/cli/summarize.js:117-118` | `.in('bill_id', billIds).order('created_at',{ascending:true})`, no pagination | summary-review path |
| `summary_verifications` | `src/cli/verify.js:100-101` | `.in('summary_id', summaryIds)`, no pagination | summary-review path |
| `summary_terms` | `src/cli/extract-terms.js:139-140` | `.in('summary_id', summaryIds)`, no pagination | summary-review path (glossary join table, but summary-oriented idempotency check) |
| `bills` | `src/cli/ingest.js:181,256,406` | `.eq('session_id', ...)` / `.in('session_id', sessionIds)`, no pagination, three call sites (US House, MO OpenStates, US Senate persist paths) | ingestion path — same shape ingest-mo-house.js's OWN dryRunReport already proved live-truncates (2099 bills for one session) |
| `bills` | `src/cli/ingest-mo-house.js:130-131` (`backfillEnrichedMarkers`) | `.eq('session_id', sessionId).not('title','is',null)`, no pagination | ingestion path — same live-proven risk as above |
| `votes` | `src/cli/summarize.js:96` | `.not('bill_id','is',null)` — no scoping at all, reads the entire table across every jurisdiction, no pagination | ingestion/summary-selection path |
| `votes` | `src/cli/ingest-mo-house.js:497-502` (pending roll-call PDF worklist) | `.like('source_key','mo-house-xml-%').not('source_url','is',null).order(...)`, no pagination | ingestion path |
| `vote_casts` | `src/cli/ingest-mo-house.js:511-514` | `.in('vote_id', kept.map(...))` — bounded by the (possibly already-truncated) votes query above; also risks the separate id-list header-overflow class if `kept` is large | ingestion path |
| `legislators` | `src/cli/ingest.js:179,195,258,275` | `.not('bioguide_id'/'openstates_id','is',null)`, no pagination, re-read mid-loop in two of the four spots | ingestion path (US House + MO OpenStates persist paths) |
| `legislators` | `src/cli/ingest-mo-house.js:556` (`loadMoRoster`) | `.not('mo_house_id','is',null)`, no pagination | ingestion path — bounded in practice to MO House's own roster size today, lower near-term risk |

`ingest.js`'s `legislators.select(...).in('bioguide_id', senateMembers.map(...))` (line 382-383) and
`glossary-terms.js`'s `findExistingGlossaryTerm` (`.maybeSingle()`, a targeted 0-or-1-row lookup on a
unique index) were checked and excluded — both are naturally bounded to a small result set by
construction, not candidates for this class of bug.
