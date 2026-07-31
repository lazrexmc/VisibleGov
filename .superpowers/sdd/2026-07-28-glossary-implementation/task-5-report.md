# Task 5 report: Glosser + gloss verifier

**Status:** READY_FOR_LIVE_GATE (stopped exactly at the mechanical `GLOSS_RUN_APPROVED` gate,
per controller ruling 1 — no live model calls, no live DB writes made this task)

## What was built

### `src/adapters/uscode.js` (extended, not created — controller ruling 2's explicit coordination point)

- **`parseCitation(raw)` now also returns `subsection`** when the raw cite carries a trailing
  top-level parenthetical suffix (e.g. `'42 U.S.C. 1396b(i)'` → `{title: 42, section: '1396b',
  subsection: 'i'}`). Implemented by extending `USC_CITE_RE` with an optional third capture group
  `(?:\s*\(([a-zA-Z]{1,2})\))?` right after the section number; the field is only added to the
  returned object when the group matched, so callers/citations with no subsection get the exact
  same `{title, section}` shape as before (no `subsection` key present at all — `!('subsection' in
  result)`, verified by a dedicated test).
  - **This required updating two existing tests** whose asserted behavior was literally "drops the
    subsection" (`tests/uscode.test.js`): the HR 498 golden-citation test and the
    "trailing subsection" test now assert the subsection IS captured. This is the intended,
    ruling-mandated reversal of that prior behavior, not a regression — the prior test names/bodies
    encoded exactly what ruling 2 says to stop doing. All other `parseCitation` tests (3 documented
    forms, section-symbol tolerance, null cases) were untouched and still pass unmodified, since
    none of their inputs carry a subsection.
- **`SubsectionNotFoundError`** (new typed error): a subsection was cited but has no
  `substructure-location_<X>` anchor in the fetched section HTML — distinct from
  `UscSectionNotFoundError` (whole section missing) and `OversizeExcerptError` (subsection found
  but still too big).
- **`extractSubsectionText(html, subsection, meta)`** (new, pure, fixture-tested): slices the
  statute field from the cited subsection's own anchor to the next top-level anchor (or end of
  field, if it's the section's last subsection). The anchor-matching regex
  `<a name="substructure-location_([a-zA-Z0-9]+)"></a>` self-filters to *top-level* anchors only —
  a nested anchor like `substructure-location_i_1` never matches because its name doesn't end
  exactly at the closing `"` the way a top-level one does — so no separate underscore-counting
  logic was needed. Throws `UscSectionNotFoundError` (section absent), `SubsectionNotFoundError`
  (subsection absent), or `OversizeExcerptError` (subsection itself still exceeds
  `MAX_EXCERPT_CHARS`).
- **`buildSubsectionFragment(subsection)`** and **`fetchUscSubsection(title, section, subsection)`**
  (new): thin fetch wrapper mirroring `fetchUscSection`'s shape, returning
  `{url: '<granule-url>#substructure-location_<X>', excerptText}` — the URL fragment makes the
  provenance point at the *exact* text that was actually read (controller ruling 3), not just the
  section it lives in. Untested directly (network), consistent with `fetchUscSection` itself being
  untested directly in this codebase — only the pure extraction function underneath carries the
  real test weight.

### `src/lib/glosser.js` (new)

Mirrors `summarizer.js`/`verifier.js`'s shape for a matched author/verify pair:

- **Author side**: `MODEL = 'claude-opus-5'`, `PROMPT_VERSION = 'gloss-v1'` (ruling 3, exact
  string), `MAX_OUTPUT_TOKENS = 4000`, `GLOSS_SCHEMA` (`{gloss_md, supported_by_quote}`, both
  required, `additionalProperties: false`), `GLOSS_SYSTEM_PROMPT` (facts-only markers: `'from this
  excerpt alone'`, `'never infer'`, `'plain language'`, `'no adjectives'`, `'1-2 sentences'`, no
  party framing — all asserted by marker tests per ruling 4/Task-3-4 precedent),
  `buildGlossUserMessage`, `authorGloss(client, {term, excerptText})` (reuses summarizer.js's
  `SummaryRefusedError`/`SummaryTruncatedError` for refusal/`max_tokens`, same convention
  `verifier.js` and `extract-terms.js` already established — one shared typed-failure vocabulary
  for model-response outcomes across the whole codebase, not a new set per module).
- **Verify side**: `GLOSS_VERIFIER_MODEL = 'claude-sonnet-5'` (deliberately a different weight
  class than the author, same rationale as `verifier.js`), `GLOSS_VERIFY_PROMPT_VERSION = 'v1'`,
  `GLOSS_VERIFY_MAX_OUTPUT_TOKENS = 8000` (scaled down from `verifier.js`'s 32000 — that cap was
  calibrated for many-bullet bill summaries; a gloss verdict set is at most 1-2 entries, but kept
  real headroom over the smaller 16000 since adaptive thinking, not output size, is what actually
  drives token use), `GLOSS_VERIFY_SCHEMA`, `GLOSS_VERIFY_SYSTEM_PROMPT` (refute-stance markers:
  `'refute'`, `'excerpt'`, `'fully supported'`, `'quote'`), `buildGlossVerifyMessage`,
  `verifyGloss(client, {term, sentences, excerptText})` (streaming via `.stream()`/
  `finalMessage()`, same SDK-timeout rationale as `verifyBill`).
  - **Deliberate design choice**: `GLOSS_VERIFY_SCHEMA.verdicts[].bullet_index` is named
    `bullet_index`, not `sentence_index`, specifically so `verifier.js`'s `assessVerdicts` can be
    **reused completely unchanged** (ruling 5: "an assessVerdicts-equivalent") rather than
    duplicating its completeness-derivation logic under a different field name. One mechanical
    completeness gate, shared by both verifiers, single source of truth. Commented clearly at the
    schema definition so this isn't mistaken for a copy-paste error.
- **`splitGlossSentences(glossMd)`** (new, pure): trivial terminal-punctuation splitter — mirrors
  `verify.js`'s `parseBullets` role (the input the verifier is built from, and the count
  `assessVerdicts` checks completeness against). Kept intentionally simple because `gloss_md` is
  model-authored and constrained by the system prompt to 1-2 sentences, not arbitrary prose.
- **`fetchGlossSource(citation)`** (new): tries the whole cited section first
  (`fetchUscSection`); only on `OversizeExcerptError` **and** a captured `subsection`, falls back
  to `fetchUscSubsection`. Any other failure (including oversize with no subsection) propagates
  unchanged — the honest, typed, counted skip ruling 2's final clause calls for. Not unit-tested
  directly (network), same convention as the uscode.js fetch wrappers; its one network-free guard
  (rejecting an unparseable citation before any fetch) is tested.

### `src/cli/gloss.js` (new)

Same shape as `extract-terms.js`/`verify.js`: pure planning + typed failures + `--dry-run`
(zero-call) + the mechanical `GLOSS_RUN_APPROVED` per-run approval gate for live mode.
`"gloss": "node --env-file=.env src/cli/gloss.js"` added to `package.json`.

- **`planGlossing(terms)`** (pure): partitions every `glossary_terms` row into three mutually
  exclusive, exhaustive buckets — `needsMapping` (SKIPPED, honest count, ruling 1/brief), `alreadyGlossed`
  (`gloss_md` already set — nothing to do), `candidates` (`needs_mapping=false`, `gloss_md` still
  null — eligible). A row can never land in two buckets: Task 4 never sets `gloss_md`, and only
  this stage ever does, and only for `needs_mapping=false` rows.
- **`glossOne(client, runId, term, anthropic)`**: `fetchGlossSource` → `authorGloss` →
  `splitGlossSentences` → `verifyGloss` → `assessVerdicts` (mechanical completeness gate, never
  trusts the model's own `overall`) → on incomplete, throws `VerificationIncompleteError` (writes
  nothing, term stays honestly ungloosed) → on complete, updates the `glossary_terms` row
  (`gloss_md`, `source_url`, `source_hash`, `model`, `prompt_version`, `run_id` — exactly what
  the published-completeness `CHECK` constraint needs) and inserts a `glossary_verifications` row
  (`term_id`, `verdicts`, `overall`, `model`, `prompt_version`). **Status is never touched** —
  stays `'draft'`, per migration 0007's own documented lifecycle comment (Task 5 fills in fields;
  Task 6's review page moves status).
- **Typed-failure set**: `OversizeExcerptError`, `UscSectionNotFoundError`,
  `SubsectionNotFoundError` (uscode.js), `SourceFetchError`/`RateLimitedError` (http.js/errors.js),
  `SummaryRefusedError`/`SummaryTruncatedError` (summarizer.js, reused), `VerificationIncompleteError`
  (verifier.js, reused). A term hitting any of these is recorded in `failures[]` with honest
  counts; the batch continues. Any *other* error (e.g. the defensive "citation not parseable"
  guard in `fetchGlossSource`, which should never fire given `needs_mapping=false`'s own
  invariant) propagates and hard-fails the run — the same "genuine invariant violation crashes
  loudly" precedent `verify.js`'s own `verifyOne` already sets for its "no bill text on file"
  case.
- **`GLOSS_COST_PER_TERM_USD = 0.16`**, matching the plan's own estimate verbatim.

## The exact live-run cost estimate line the CLI prints

```js
console.log(`Cost estimate: ${candidates.length} term(s) x ~$${GLOSS_COST_PER_TERM_USD.toFixed(2)} = ~$${estimate} in live model calls (authoring + verify).`);
```

With `GLOSS_COST_PER_TERM_USD = 0.16` this renders e.g. `Cost estimate: 3 term(s) x ~$0.16 =
~$0.48 in live model calls (authoring + verify).` — I could not demonstrate this with a *nonzero*
real count: migration 0007 (`glossary_terms`) is still unapplied on the live DB (confirmed live,
see below), and unlike `extract-terms.js` (whose primary query is against the already-applied
`summaries` table, with only `summary_terms` gracefully degrading), `gloss.js`'s primary query
*is* `glossary_terms` itself — so a real dry run against the current live DB necessarily reports 0
candidates. This mirrors Task 4's own documented limitation (its live-write path was also
unexercised pending 0007).

## Live-DB verification (structural, no billed calls — controller ruling 1)

Ran `gloss.js` against the real Supabase project (`.env`) to confirm the same graceful-degradation
and hard-fail behavior established by `verify.js`/`extract-terms.js`:

**`--dry-run`:**
```json
{
  "mode": "dry-run",
  "counts": { "terms": 0, "needsMapping": 0, "alreadyGlossed": 0, "candidates": 0 },
  "candidates": [],
  "note": "(glossary_terms missing — migration 0007 not applied; treating as zero terms)"
}
```

**Live mode (no `--dry-run`, no `GLOSS_RUN_APPROVED`):** hard-fails immediately on the same
missing-table lookup, before ever reaching the cost estimate, the `GLOSS_RUN_APPROVED` gate, or
`getAnthropicClient()` — exit code 1:
```
Error: glossary_terms lookup failed: Could not find the table 'public.glossary_terms' in the schema cache
    at loadAllTerms (file:///F:/VisibleGov/src/cli/gloss.js:90:11)
```
Zero Anthropic calls made anywhere during this task — verified structurally (both paths
return/throw before `getAnthropicClient()` is called) and by this live run.

## Tests

**351/351 green** (`node --test`, full suite; 313 baseline + 38 new). Breakdown:
- `tests/uscode.test.js`: +7 (parseCitation subsection capture ×3 incl. 2 rewritten,
  `extractSubsectionText` ×6, `buildSubsectionFragment` ×1 — net +7 after accounting for 2 tests
  whose bodies changed rather than being added fresh)
- `tests/glosser.test.js`: +22 (new file — constants, schema shapes, both system prompts' facts-
  only/adversarial markers, message builders, `splitGlossSentences`, its composition with the
  reused `assessVerdicts`, `fetchGlossSource`'s no-network guard)
- `tests/gloss-cli.test.js`: +9 (new file — `planGlossing`'s three-bucket routing incl. mixed
  batches and the empty-list case, `GLOSS_COST_PER_TERM_USD`, `parseArgs`)

TDD followed: each new/changed assertion was run and confirmed against the actual implementation
(not written blind) — e.g. the subsection-boundary test initially asserted `!/\(j\)/.test(text)`,
which failed because subsection (i)'s own body legitimately cross-references *another* section's
`(j)(2)` (`1395u(j)(2)`); tightened to check for `(j)`'s own heading text
(`'Adjustment of amount'`) instead, which is the actually-correct assertion.

## Design decisions worth flagging for controller/Lance review

1. **The subsection-slicing machinery is currently unreachable from the live auto-extraction
   pipeline.** `extract-terms.js`'s `upsertGlossaryTerm` (Task 4, already committed) constructs
   the stored `citation` as `` `${parsed.title} U.S.C. ${parsed.section}` `` — title+section only,
   **always**, regardless of whether the original `citation_raw` carried a subsection. This means
   even though `parseCitation` now captures `subsection` from a raw cite like `'42 U.S.C.
   1396b(i)'`, that information is discarded the moment Task 4 normalizes and stores the citation
   — a `glossary_terms.citation` value for 1396b is always `'42 U.S.C. 1396b'`, never `'...1396b(i)'`.
   Consequence: today, gloss.js's `fetchGlossSource` calls `parseCitation(term.citation)` on that
   *stored* (subsection-stripped) string, so for HR 498's own 1396b(i) citation — the exact case
   ruling 2 was written to solve — `parsed.subsection` will be `undefined` when the glosser runs
   it, and the 169,882-char oversize will hit the "no subsection cited → typed skip" branch, not
   the subsection-slicing branch, until something changes upstream.
   - I deliberately did **not** touch `extract-terms.js` to fix this — ruling 2 named only
     `uscode.js` for coordination, and `extract-terms.js` is an already-committed, out-of-scope
     file for this task. Fixing it (e.g. appending `(subsection)` to the stored citation when
     present) is a one-line, non-breaking change with zero live-data risk right now (0007 is still
     unapplied; zero live `glossary_terms` rows exist), but it's a real, deliberate scope/behavior
     decision — narrowing the section-level dedup key for the (currently rare) subsection-cited
     case — that deserves an explicit controller/Lance call, not a unilateral change bundled into
     this task.
   - Everything I *did* build is correct and ready the moment a `glossary_terms.citation` value
     carries a subsection, by whatever path that ends up happening (a future `extract-terms.js`
     fix, or a staff editor typing a more specific citation directly into a `needs_mapping` row on
     Task 6's review page) — fully fixture-tested against the real 1396b(i) case per the brief's
     own "fixture-first" instruction.
2. **`GLOSS_RUN_APPROVED`** (not a new gate name) is reused verbatim from `extract-terms.js` per
   ruling 1's own wording — one standing-policy env var authorizes live glossary-pipeline model
   calls across both CLIs, not a per-CLI-unique gate name.
3. Neither `authorGloss` nor `verifyGloss`'s model-call bodies are unit-tested with a fake/mock
   client (refusal/`max_tokens`/no-text-block branches) — consistent with this codebase's existing
   precedent (`summarizeBill`, `verifyBill`, `extractTerms` are none of them tested that way
   either; only their surrounding pure surface — schema, prompts, message builders, constants — is
   unit-tested, and the model-call body itself is validated by structural review plus the eventual
   live gate).

## Concerns

- Same as Task 4's: the live gloss+verify call path (`authorGloss`, `verifyGloss`, `glossOne`) has
  never actually run against the Anthropic API or a real `glossary_terms`/`glossary_verifications`
  table (0007 still unapplied). Once Lance applies 0007 and there are real `needs_mapping=false`
  stub rows to work from, worth a small first live run (few terms) before trusting this at scale —
  and per point 1 above, worth deciding *then* whether the subsection-citation gap is worth
  closing before or during that first run, since it directly determines whether HR 498's own
  1396b(i) term glosses successfully or lands in `failures[]` as `OversizeExcerptError`.
- `splitGlossSentences` is a trivial terminal-punctuation splitter — fine for a system-prompt-
  constrained 1-2 sentence `gloss_md`, but would mis-split on an abbreviation like "U.S.C." if the
  model ever put one at a sentence boundary. Not fixture-tested against a real model output (no
  live calls this task); worth a glance at real gloss text once live glossing runs.

## Fix round 1 (controller ruling): AS-CITED citation granularity

**Commit:** `96c1384` — "fix: as-cited citation granularity so subsection slicing is reachable
end-to-end" (pushed to `glossary-implementation`, range `4633353..96c1384`)

The base task flagged, but did not fix, that `extract-terms.js`'s citation normalization always
collapsed a stored `glossary_terms.citation` to section level (`'42 U.S.C. 1396b'`), discarding
any subsection the raw citation carried — making the new subsection-slicing machinery
unreachable from the live pipeline even though it was correct and fixture-tested in isolation.
The controller confirmed this is real and ruled: **citation granularity is AS-CITED** — when the
raw cite carries a subsection, the normalized citation preserves it (`'42 U.S.C. 1396b(i)'`), so
a bill citing 1903(i) yields a distinct `glossary_terms` row from one citing 1903 bare.

**Rationale, recorded verbatim per the ruling:** the design doc's own example term is
section-specific (`'Social Security Act, Sec. 1903'`); a gloss of the actually-cited subsection is
more relevant to that bill's reader than a gloss of the whole (possibly huge) section; dedup only
splits when bills genuinely cite different subsections of the same section (a modest, accepted
cost); and 0007 is unapplied with the extraction backfill never having run live, so changing
granularity now is free — no data migration, no existing rows to reconcile.

### What changed

- **`src/cli/extract-terms.js`**: added `normalizeCitation(citationRaw)` — a new pure, exported
  function that calls `parseCitation` and returns `` `${title} U.S.C. ${section}` `` with
  `(${subsection})` appended when `parseCitation` captured one, unchanged otherwise.
  `upsertGlossaryTerm`'s `by: 'citation'` branch now calls `normalizeCitation(rawTerm.citation_raw)`
  in place of its old inline `` `${parsed.title} U.S.C. ${parsed.section}` `` reconstruction —
  a one-line call-site change. The branched upsert decision (`upsertKeyFor`), `needs_mapping`
  logic, and both live-run gates (`GLOSS_RUN_APPROVED`, `ANTHROPIC_API_KEY` check) are all
  byte-for-byte unchanged.
- **`tests/extract-terms-cli.test.js`**: 4 new tests for `normalizeCitation` — subsection preserved
  (`'42 U.S.C. 1396b(i)'` → `'42 U.S.C. 1396b(i)'`), bare section unchanged
  (`'42 U.S.C. 1396b'` → `'42 U.S.C. 1396b'`), loose-format normalization (section symbol, "section
  X of title Y" — both still resolve to the canonical shape with no subsection), and a dashed
  section number with a subsection (`'42 U.S.C. 1396r-4(f)'` → unchanged, subsection preserved).
- **`tests/glosser.test.js`**: 1 new end-to-end round-trip test —
  `normalizeCitation('42 U.S.C. 1396b(i)')` → re-parsed via `parseCitation` (exactly as
  `fetchGlossSource` does on `term.citation`) → confirms `{title: 42, section: '1396b',
  subsection: 'i'}` survives the store-then-reparse round trip → feeds that recovered subsection
  into `extractSubsectionText` against the **real** 1396b fixture and confirms a non-empty,
  well-under-100k, recognizable excerpt (`/organ transplant/i`). This proves the full live-pipeline
  chain (store as-cited → re-parse → slice) actually reaches subsection-level slicing for the real
  HR 498 golden case, not just that each piece works in isolation — directly closing the
  reachability gap flagged in the base task.

### Test evidence

**356/356 green** (`node --test`, full suite; 351 prior + 5 new: 4 in
`tests/extract-terms-cli.test.js`, 1 in `tests/glosser.test.js`). Re-ran both CLIs' `--dry-run`
against the real Supabase project after the change to confirm no regression: `extract-terms.js
--dry-run` still reports the same 25 candidates as before (its query path — `summaries` — is
unaffected by this change); `gloss.js --dry-run` still reports 0 terms with the same
`glossary_terms missing — migration 0007 not applied` note (0007 is still unapplied; this change
doesn't touch schema). No live model calls, no live DB writes.

### Concerns (updated)

The core "unexercised against a real Anthropic response or a real post-0007 table" concern from
both this task and Task 4 is unchanged — this fix closes the *reachability* gap (the stored
citation now carries what the glosser needs), but the actual live gloss-a-1396b(i)-term-and-slice-
correctly path still has never run for real. Worth confirming in the first live run after Lance
applies 0007.

## Fix round 2 (task review: 1 Important + 1 Minor promoted by controller ruling)

**Commit:** `3ce5398` — "fix: order glossary writes for self-healing retry + persist
supported_by_quote" (pushed to `glossary-implementation`, range `96c1384..3ce5398`)

### Important — write-order regression vs. extract-terms.js's self-healing pattern

`glossOne` wrote `glossary_terms` (setting `gloss_md`) *before* inserting the dependent
`glossary_verifications` row. If the second write failed (a transient blip), `gloss_md` was
already committed while no verification row existed — and `planGlossing` routes purely off
`gloss_md` being set, so that term would land in `alreadyGlossed` forever: a gloss with no backing
audit row, never retried, cutting against trust-model v2. `extract-terms.js`'s analogous two-write
sequence (`upsertGlossaryTerm` then `summary_terms` insert) keys retry eligibility off the
*second* write (`loadExtractedSummaryIds` queries `summary_terms`), so a summary with a partially
completed extraction stays eligible for retry — `gloss.js`'s original ordering was a regression
from that safer, already-established shape.

**Fix:** reordered the two writes — `glossary_verifications` insert now happens first,
`glossary_terms` update second — so `gloss_md` can only ever become non-null once its verification
row already exists. Factored both writes into a new exported `persistGloss(client, runId, term,
{glossMd, supportedByQuote, sourceUrl, sourceHash, verdicts, overall})`, deliberately decoupled
from `authorGloss`/`verifyGloss`/`fetchGlossSource` (no model or network calls inside it at all) so
the write order and its failure/retry behavior are unit-testable with a plain fake `client` object
— no model/network mocking needed, keeping this consistent with the rest of the codebase's
"don't mock the model" test convention while still directly proving the fix.

**Tests added** (`tests/gloss-cli.test.js`, using a minimal fake client that records
insert/update calls and can be told to fail a specific table):
1. `persistGloss writes glossary_verifications BEFORE glossary_terms` — asserts call order.
2. `persistGloss includes supported_by_quote in the glossary_terms update payload` — covers the
   Minor finding below too.
3. `persistGloss: recovery — if glossary_verifications insert fails, glossary_terms is never
   touched` — proves the `glossary_terms` update is never attempted when the first write fails
   (only one call recorded).
4. `persistGloss: recovery — simulated second-run retry` — composes (3)'s result (`gloss_md` never
   committed) with `planGlossing` to prove a term whose first run failed on the verification
   insert is routed back to `candidates` (not `alreadyGlossed`) on a simulated next run — the exact
   "first run's verification insert fails → second run retries the term" scenario the reviewer
   asked to simulate.
5. `persistGloss: if glossary_terms update itself fails, the error is typed/thrown, never silent`
   — covers the reverse case: if the (now-first) verification write succeeds but the second write
   fails, the error still propagates loudly. Documents the one accepted residual edge case: a
   retry after this specific failure mode could leave an orphaned `glossary_verifications` row
   with no matching gloss — the same shape `summary_verifications` already tolerates in
   `verify.js` (no dedup guard there either), not a new inconsistency this fix introduces.

### Minor (promoted by controller ruling) — `supported_by_quote` was dead output

`GLOSS_SCHEMA` required `supported_by_quote` from the author model but nothing ever persisted it.
**Ruling:** persist it. Added a nullable `supported_by_quote text` column to `glossary_terms` in
`supabase/migrations/0007_glossary.sql` (still unapplied/draft, free to edit) with a comment
explaining its purpose (displayed alongside `gloss_md` at review time so a human adjudicator can
check the quote against the gloss without re-opening the source). Deliberately **not** added to
`glossary_terms_published_complete`'s `CHECK` — it always co-arrives with `gloss_md` in the same
`persistGloss` write, so a separate gate on it would be redundant, matching the ruling's
instruction to keep that constraint minimal. `persistGloss` now writes it in the same update as
`gloss_md`; test 2 above asserts it's present in the update payload alongside `gloss_md`,
`source_url`, and `source_hash`.

### Deferred (no action, ledgered per the controller ruling)

Subsection-cited terms whose subsection excerpt is actually *under* the oversize threshold still
receive the whole-section excerpt (the subsection fallback in `fetchGlossSource` only triggers on
`OversizeExcerptError`) — as-designed per ruling 2, not a bug. No action taken.

### Test evidence

**361/361 green** (`node --test`, full suite; 356 prior + 5 new, all in `tests/gloss-cli.test.js`).
Re-ran `gloss.js --dry-run` against the real Supabase project after the refactor to confirm no
regression: still reports 0 terms with the same `glossary_terms missing — migration 0007 not
applied` note (0007 still unapplied; this fix changes write order and schema-to-be, not query
behavior). No live model calls, no live DB writes.

### Concerns (fix round 2)

Same as before — the live path (now with corrected write order) has still never run against a
real `glossary_terms`/`glossary_verifications` table or a real Anthropic response. The write-order
fix and `supported_by_quote` persistence are proven correct against a fake client and pure schema
review respectively, not against Postgres's actual behavior (e.g. real network-timeout-shaped
failures, real constraint interactions) — worth keeping an eye on during the first live run.
