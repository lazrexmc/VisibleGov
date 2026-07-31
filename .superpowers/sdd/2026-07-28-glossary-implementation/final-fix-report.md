# Final-review fix wave — glossary-implementation branch

Branch: `glossary-implementation`, starting HEAD `fb0e653`. Closes 2 Important + 3 Minor findings
from the whole-branch review in one commit series. No live model calls, no live DB writes made;
0007 remains unapplied (draft-then-apply, Lance applies).

## FIX 1 (Important) — rejected terms re-entering the billable gloss queue

**File:** `src/cli/gloss.js`

- `planGlossing` (~line 59-90 after fix) now excludes `status === 'rejected'` from `candidates`,
  routing it to a new, explicit `rejected` bucket instead. Checked AFTER the `gloss_md` check (so
  an approved-then-rejected term that already has a gloss still lands in `alreadyGlossed`, an
  existing, separately-tracked product gap — not something this fix changes) and BEFORE the
  `needs_mapping` check. The four buckets (`needsMapping`, `alreadyGlossed`, `rejected`,
  `candidates`) stay mutually exclusive and exhaustive.
- Added a comment block recording the deliberate INVERSE semantics vs `summarize.js`: a rejected
  *summary* regenerates on the next run (`planWork`'s `ALREADY_SUMMARIZED_STATUSES` excludes
  `'rejected'` on purpose); a rejected glossary *term* means the extraction itself was bogus, so
  skipping permanently is correct.
- `main()`'s dry-run output now includes `rejected` in `counts` and `status` in each candidate
  object (`candidates: candidates.map((t) => ({..., status: t.status}))`), so a reviewer can
  visually confirm nothing rejected is about to be billed, right at the cost-estimate approval
  gate. Live-run counts gained a symmetrical `rejectedSkipped`.

**Tests** (`tests/gloss-cli.test.js`):
- `planGlossing excludes a rejected, ungloosed stub from candidates — it lands in rejected instead`
- `planGlossing: a rejected term that already has a gloss stays in alreadyGlossed...` (regression
  guard for the existing, intentionally-unchanged gap)
- `planGlossing: a draft (non-rejected) stub ... is still a normal candidate`
- `planGlossing candidate rows carry status through unaltered, for the dry-run plan output`
- Updated `planGlossing on an empty term list returns four empty buckets` and the mixed-batch
  partition test for the new bucket.

All 10 `planGlossing`/`persistGloss` tests in that file pass (18/18 total in the file).

## FIX 2 (Important) — summarize.js discarding v2 referenced_terms

**Files:** new `src/lib/glossary-terms.js`; `src/cli/extract-terms.js`; `src/cli/summarize.js`

- Moved `normalizeTermText`, `upsertKeyFor`, `normalizeCitation`, `findExistingGlossaryTerm`
  (internal), and `upsertGlossaryTerm` out of `extract-terms.js` into a new shared module,
  `src/lib/glossary-terms.js`, unchanged in logic. Added `persistReferencedTerms(client, runId,
  {summaryId, referencedTerms})` — the exact upsert-then-join loop `extractOne` used to run
  inline, now callable from both extraction paths.
- `extract-terms.js` (`src/cli/extract-terms.js:1-16, 150-169`) imports from the shared module and
  **re-exports** `normalizeTermText`/`upsertKeyFor`/`normalizeCitation` by reference, so every
  existing test import (`from '../src/cli/extract-terms.js'`) keeps working unchanged.
  `extractOne` now calls `persistReferencedTerms` directly — same call order, same error
  propagation (any DB error still hard-crashes the batch, exactly as before this fix).
- `summarize.js` (`src/cli/summarize.js:181-230`): `createDraftSummary` now destructures `json`
  (not just `markdown`) from `summarizeBill`, changes the `summaries` insert to
  `.select('id').single()` to get the new row's id, and — after that insert succeeds — calls a new
  exported `persistReferencedTermsGracefully(client, runId, {bill, summaryId, referencedTerms})`.
  That wrapper calls the shared `persistReferencedTerms` and, ONLY on a missing-relation error
  (`isMissingRelationError` against `glossary_terms` or `summary_terms`), returns
  `{termsUpserted: 0, warning: '<honest message mentioning 0007 and the bill>'}` instead of
  throwing — the summary draft row is already committed by that point and stays committed. Any
  other DB error still propagates and crashes the run (a real bug, not the expected pre-0007
  condition). `main()`'s summarize loop (`src/cli/summarize.js:291-318`) now tracks
  `glossaryTermsPersisted` and a separate `glossaryWarnings[]` (distinct from `failures[]`,
  recorded in the run's `closeRun` detail and stdout) — never silently dropped.
- `createDraftSummary` is exported (unlike `gloss.js`'s `glossOne`/`extract-terms.js`'s
  `extractOne`, which stay unexported because their non-DB dependency is uncachable network I/O);
  its only non-DB dependency is the single `summarizeBill` call, cleanly fakeable at the SDK
  boundary, which let the "draft still succeeds" constraint be proven end-to-end.

**Tests:**
- `tests/glossary-terms.test.js` (new): proves `extract-terms.js`'s re-exports are the same
  function objects (not re-implemented copies); table-name constants; `persistReferencedTerms` is
  a no-op for an empty array.
- `tests/summarize-cli.test.js` (extended, +9 tests): `persistReferencedTermsGracefully` — happy
  path lands a glossary_terms stub + summary_terms join (asserted via a call-log fake client,
  checking the actual upsert payloads); empty-array no-op; missing-relation degrades to an honest
  warning containing "0007" and the bill identifier, never throws; a genuinely unrelated DB error
  (`08006` connection failure) still throws, proving nothing is blanket-swallowed.
  `createDraftSummary` end-to-end (fake anthropic + fake DB client): draft succeeds and terms
  persist when relations exist; draft **still succeeds** with the honest warning when
  `glossary_terms` is missing; a bill with no referenced_terms persists cleanly with zero warnings.
- `tests/extract-terms-cli.test.js` unmodified and still 100% green — confirms
  `extract-terms.js`'s own behavior is unchanged by the refactor.

12/12 new/updated tests in `summarize-cli.test.js`, 3/3 in `glossary-terms.test.js`, all pass.

## FIX 3 (Minor) — dotted legal abbreviations fragmenting sentences

**File:** `src/lib/glosser.js`

- `splitGlossSentences` (~line 164-173 after fix) now protects a list of dotted abbreviations
  (`Pub. L.`, `U.S.C.`, `U.S.`, `e.g.`, `i.e.`, `Sec.`, `Stat.`, `No.` — longest/most-specific
  pattern first, e.g. `U.S.C.` before `U.S.`, so a shorter pattern never partially matches inside
  a longer one already protected) before running the terminal-punctuation split regex, then
  restores the real periods in each output sentence.
- Placeholder implementation note: originally attempted a raw literal control character in the
  source, which the tool chain wrote as an actual NUL byte into the file (confirmed via hex dump —
  `grep` started reporting the file as binary). Fixed by using `String.fromCharCode(1)` at
  runtime instead, so the source file itself stays plain, unambiguous UTF-8 text with no embedded
  control bytes — verified via `file src/lib/glosser.js` reporting clean UTF-8 text afterward.
- `GLOSS_SYSTEM_PROMPT` gained a new hard-rule line discouraging dotted abbreviations in
  `gloss_md` in the first place, on top of the mechanical protection.

**Tests** (`tests/glosser.test.js`):
- `splitGlossSentences does not split on a dotted U.S.C. citation mid-sentence — exactly 2 real
  sentences` — the exact example from the brief (`'Under 42 U.S.C. 1396b, states get paid. It caps
  rates.'` → 2 sentences).
- `splitGlossSentences protects other dotted abbreviations (Pub. L., Sec., Stat., e.g., i.e.,
  No.)...` and a no-real-sentence-break restoration test.
- `GLOSS_SYSTEM_PROMPT discourages dotted abbreviations in gloss_md`.
- All existing `GLOSS_SYSTEM_PROMPT`/`splitGlossSentences` marker tests use `.includes()`
  substring checks (not exact-match), so none needed updating — confirmed all still pass.

## FIX 4 (Minor) — empty-string gloss passing every gate

**Files:** `supabase/migrations/0007_glossary.sql`; `src/lib/glosser.js`; `src/cli/gloss.js`

- `glossary_terms_published_complete` CHECK amended: `gloss_md is not null` →
  `gloss_md is not null and gloss_md <> ''`. This is the boundary that holds regardless of code
  path (automated gloss pipeline or a manual review-page edit) — note: the review-page edit path
  was already independently blocked by `validateGlossaryDecisionInput`'s existing
  `!gloss_md` truthiness check, so this CHECK is defense-in-depth there, but is the ONLY gate for
  the automated pipeline path this finding describes.
- `src/lib/glosser.js`: added `EmptyGlossError` (typed error, extends the existing taxonomy) and
  `assertGlossNotEmpty(sentences, {term, termId})` — a small pure guard, factored out the same way
  `persistGloss` was, so it's unit-testable without faking `authorGloss`/anthropic.
- `src/cli/gloss.js`'s `glossOne` calls `assertGlossNotEmpty(sentences, ...)` immediately after
  `splitGlossSentences`, BEFORE the `verifyGloss` call — an empty gloss now never reaches a
  (billed) verify call or `persistGloss`. `EmptyGlossError` added to `FAILURE_TYPES`, so it's a
  counted per-term failure (`failures[]`), not a batch crash.

**Tests:**
- `tests/glosser.test.js`: `EmptyGlossError is exported and instanceof Error`;
  `assertGlossNotEmpty throws EmptyGlossError when sentences is empty` (and does not throw when
  non-empty); composition tests with `splitGlossSentences('')` and `splitGlossSentences('   ')`
  proving the real empty/whitespace-only `gloss_md` path is caught before any verify call.
- `tests/migration-0007-glossary.test.js` (new): asserts the amended CHECK text
  (`gloss_md is not null and gloss_md <> ''`) is present in the raw migration SQL, and that
  `source_url`/`source_hash` requirements are unchanged.

## FIX 5 (Minor) — Background label missing as a schema comment

**File:** `supabase/migrations/0007_glossary.sql`

- Added a comment directly above the `gloss_md` column definition containing, verbatim: `Background
  — from the referenced law's official text`, plus one sentence of context tying it to where else
  this label appears (Task 6 review page, future public site).

**Test:** `tests/migration-0007-glossary.test.js` — `0007 carries the approved Background label as
a schema comment on gloss_md, verbatim` (regex match against the raw file text).

## Verification

Full suite: **418/418 passing** via bare `node --test` (no dir arg, per Node 24 Windows
constraint), up from the pre-fix baseline of 392/392. New/changed test files:
`tests/gloss-cli.test.js`, `tests/glosser.test.js`, `tests/summarize-cli.test.js` (extended),
`tests/glossary-terms.test.js` (new), `tests/migration-0007-glossary.test.js` (new).

No live Anthropic calls, no live Supabase writes were made at any point. `extract-terms.js`'s own
test suite (unmodified) stayed 100% green throughout the refactor, confirming FIX 2's "behavior
unchanged" constraint held.

---

# Round 2 — scoped re-review, 2 new Important findings

Re-review confirmed fixes 1/2/4/5 as landed. It found two NEW Important items introduced by round
1's own changes. Both closed in this round-2 commit, on top of the round-1 commit (`005b363`).

## ITEM 1 (Important) — summarize.js batch-crash surface

**Problem:** `persistReferencedTermsGracefully` (round 1) only degraded gracefully on
`isMissingRelationError`; any OTHER glossary-side error (a unique-constraint race in
`upsertGlossaryTerm`'s manual `by:'term'` insert branch, a transient connection error, etc.)
propagated out of `createDraftSummary`, missed `FAILURE_TYPES` at `main()`'s per-bill `catch`, hit
the outer `catch`, and `closeRun(..., 'failed')` OVERWROTE the run detail — discarding every
count/failure/warning already accumulated for bills already processed and aborting the rest of
the batch.

**Files:** `src/lib/glossary-terms.js`, `src/cli/summarize.js`

- `persistReferencedTerms` (`src/lib/glossary-terms.js:112-141`): still throws on the first
  failing term (unchanged — `extract-terms.js`'s own hard-fail-the-batch behavior is intentional
  and untouched), but now tags `.term`/`.kind` (the term being processed at the moment of failure)
  onto the thrown error object before rethrowing — harmless extra metadata `extract-terms.js`'s
  caller never reads.
- `persistReferencedTermsGracefully` (`src/cli/summarize.js:181-219`) now catches **any** error
  from glossary-side persistence, not just missing-relation, and never rethrows. Returns
  `{termsUpserted: 0, warning: {kind, term, message}}` in both cases:
  - `kind: 'missing_relation'`, `term: null` — the pre-0007 case, kept visually distinct.
  - `kind: 'persist_error'`, `term: err.term ?? null` — everything else, with the specific term
    if known.
- `main()`'s loop and `closeRun` detail were unaffected structurally (still pushes
  `{identifier, warning}` into `glossaryWarnings`) — the fix is entirely in
  `persistReferencedTermsGracefully` never throwing, which makes the outer
  `closeRun(..., 'failed')` overwrite path structurally unreachable for this class of error.

**Tests** (`tests/summarize-cli.test.js`):
- Updated the missing-relation test to assert the new `{kind, term, message}` shape.
- Replaced "an unrelated DB error still throws" with "...degrades to a distinctly-kinded warning
  too — nothing throws", asserting `kind: 'persist_error'` and that the failing term's name is
  captured.
- New: `createDraftSummary: the summary draft STILL SUCCEEDS when term persistence hits a
  non-missing-relation error` — proves the draft-success guarantee holds for the generic case too.
- New: `batch loop over two bills: a non-missing-relation persist error on bill 2 never erases
  bill 1's success, and processing continues to bill 2's own summary` — reproduces `main()`'s own
  accumulation loop directly (no client-injection seam exists on `main()` itself) over two bills
  with two separate fake clients, proving `summariesCreated === 2`, `failures.length === 0`, and
  bill 1's already-recorded `glossaryTermsPersisted` count survives bill 2's warning.

## ITEM 2 (Minor→Important, re-review escalated) — splitGlossSentences silent merge

**Problem:** Round 1's `splitGlossSentences` protected EVERY dot in a matched abbreviation,
including the abbreviation's own trailing period — so when a gloss legitimately ended right at an
abbreviation, two real sentences silently MERGED into one: `'The Secretary cites 42 U.S.C. It
funds Medicaid.'` produced 1 sentence, not 2, meaning one verifier verdict would have quietly
covered two separate claims (the under-verification / trust-harming direction).

**File:** `src/lib/glosser.js`

- `protectAbbreviationDots` (~line 152-161) redesigned: for each abbreviation match, protects
  every dot EXCEPT the last one (`m.lastIndexOf('.')`); that final dot is left as a normal,
  literal period and decided by the same rule every other period in the text is judged by.
- New `isTerminalPeriod`/`protectNonTerminalPeriods` (~line 163-190): a period counts as a real
  sentence boundary only if it's the last character of the trimmed text, or is followed by
  whitespace + an UPPERCASE letter; otherwise it's protected the same as an abbreviation-internal
  dot. This is what decides an abbreviation's own trailing dot case-by-case (digit follows → stays
  merged; capital follows → splits), and incidentally protects decimal-point periods too.
- Added `/Pub\.\s+L\.\s+No\./g` as its own longest-first pattern so a multi-token citation like
  "Pub. L. No. 117-2" is protected as ONE unit (previously "Pub. L." and "No." would have been
  matched as two independent abbreviations, and the redesigned last-dot-stays-raw rule would have
  incorrectly split between them).
- `splitGlossSentences` now also sanitizes any pre-existing placeholder control character
  (`String.fromCharCode(1)`) out of the input BEFORE protecting anything, per the re-reviewer's
  finding that a pre-existing one would otherwise become a spurious literal period on restore.
- Documented the accepted residual in a code comment: an abbreviation's trailing dot followed by
  whitespace + a capitalized word that ISN'T actually a new sentence over-splits into an extra
  fragment. Deliberately accepted — noisy (one redundant extra verdict) is the safe failure
  direction, the opposite of the silent-merge bug this round closes.

**Tests** (`tests/glosser.test.js`):
- `...exactly 2 real sentences` (existing, re-verified unchanged: digit after final dot → no split).
- `...round-1 silent-merge regression, now fixed` — the exact repro from the ruling, now 2 sentences.
- `...treats a multi-token "Pub. L. No." citation as one protected unit` — 1 sentence.
- `...protects other dotted abbreviations...` — updated (swapped "e.g. Medicaid" for "e.g. rent
  assistance" since a capitalized word after "e.g." now deliberately over-splits — see next test).
- `...accepts an over-split when a capitalized word...follows an abbreviation dot — documented
  residual, not a silent merge` — locks in the accepted residual with an explicit test, not just a
  comment.
- `...sanitizes a pre-existing placeholder control character out of the input before protecting
  anything`.

## Verification

Full suite: **424/424 passing** (up from round 1's 418/418). No live model/DB calls made.
`extract-terms.js`'s own test suite remained 100% green — `persistReferencedTerms`'s throw-on-first-
failure behavior for that caller is unchanged, only additional (unused-by-it) error metadata was
added.
