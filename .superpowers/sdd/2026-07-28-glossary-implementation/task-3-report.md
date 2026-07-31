# Task 3 report: Summarizer prompt v2 (referenced-terms extraction)

**Status:** READY_FOR_GOLDEN_GATE

**Commit:** 777e7fc — "feat: summarizer prompt v2 - referenced-terms extraction (additive)"
(pushed to `glossary-implementation`, range 0dbbd03..777e7fc)

**Tests:** 294/294 green (291 prior + 3 new: schema-shape/both-additionalProperties-levels,
system-prompt 'never infer'/'referenced_terms'/"the bill text itself" markers, and
renderMarkdown-byte-unchanged-with-referenced_terms-present). TDD followed: all three
non-trivial new assertions were confirmed failing against the pre-change v1 code
(referenced_terms not required at top level; prompt missing 'referenced_terms' mention;
PROMPT_VERSION 'v1' !== 'v2') before implementation; the byte-unchanged renderMarkdown
assertion was true from the start (correctly, since renderMarkdown was untouched) and
stayed green through implementation.

## What changed (`src/lib/summarizer.js`)

- `PROMPT_VERSION`: `'v1'` → `'v2'`.
- `SUMMARY_SCHEMA`: added `referenced_terms` to the top-level `required` array and as a new
  property — `array` of objects, each requiring `term` / `kind` / `citation_raw` (all
  required), `additionalProperties: false` at the item level (the pre-existing top-level
  `additionalProperties: false` is untouched). `kind` is an enum:
  `statute|act|agency|program|public_law`.
- `SYSTEM_PROMPT`: added one new hard-rule bullet instructing facts-only extraction into
  `referenced_terms` — contains the literal marker `never infer`, explicitly restricts
  extraction to names/citations the bill text itself prints, and specifies `citation_raw` is
  verbatim from the text or `''` if the bill names a term without printing a citation.
- `renderMarkdown`: **unchanged**, byte-for-byte (verified by a new test that renders the
  same summary object with and without a populated `referenced_terms` array and asserts
  identical output, plus asserts none of the term content leaks into the rendered markdown).

## Ruling 3 confirmation (verifier.js / verify CLI unaffected)

Read `parseBullets`' input path in `src/cli/verify.js`: `verifyOne` calls
`parseBullets(summary.body_md)` — its input is the **stored `body_md` string** (the DB
column written by `summarize.js` from `summarizeBill`'s `markdown` return value, itself
produced by `renderMarkdown`), never the raw JSON. Since `renderMarkdown` does not render
`referenced_terms` and is unchanged, `body_md` content — and therefore everything
`parseBullets`, `checkBulletCoverage`, and the rest of the verify CLI operate on — is
byte-identical whether or not a v2 summary carries a populated `referenced_terms` array.
The additive schema field is structurally invisible to the verifier. Confirmed also by the
new `renderMarkdown is byte-unchanged by referenced_terms` test.

Additionally checked (not required by the ruling, but relevant to "additive, no drift"):
`src/cli/summarize.js` only persists `markdown` (`body_md`), never the raw `json`, so
`referenced_terms` isn't written anywhere yet by the current pipeline — that's Task 4's job.
`src/cli/golden.js`'s `compareSummaries`/`buildGoldenJson` only ever look at
`what_it_does` / `stated_purpose` / `classification`; `referenced_terms` is absent from
`golden.json` reconstructions (body_md-derived) and never inspected, so it cannot itself
trigger a golden-check DRIFT verdict.

## Concerns

None found. Scope was held strictly to `src/lib/summarizer.js` + its test file per the
brief; no other files touched. The GATE step (`npm run golden -- --check` under
`GOLDEN_CHECK_APPROVED=yes`, ~$0.35, v1 goldens vs. v2 prompt) was intentionally NOT run —
per ruling 2, that is the controller's step to obtain Lance's approval and execute. No
Anthropic API calls were made during this task.
