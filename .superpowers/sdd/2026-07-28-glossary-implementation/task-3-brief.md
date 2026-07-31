### Task 3: Summarizer prompt v2 (term extraction)

**Files:** Modify `src/lib/summarizer.js`; test additions
- SUMMARY_SCHEMA gains `referenced_terms`: array of {term (as the bill names it), kind (statute|act|agency|program|public_law), citation_raw (verbatim from bill text, '' if none printed)} — all required, additionalProperties false. SYSTEM_PROMPT gains an extraction instruction (facts-only: extract ONLY names/citations the bill text itself prints; never infer). PROMPT_VERSION → 'v2'.
- renderMarkdown UNCHANGED (terms don't render in the summary body — they feed the glossary pipeline).
- [ ] Pure tests (schema shape; prompt markers incl. 'never infer'; v2 pin) → implement → green → commit.
- [ ] **GATE (Lance, ~$0.35): `npm run golden -- --check`** under the mechanical approval env — v1 goldens vs v2 prompt; structural drift beyond the additive field should NOT occur (extraction is additive); report results honestly. If DRIFT fires, STOP and surface to Lance before any v2 summarize run.


## CONTROLLER RULINGS (binding, appended)

1. Full requirements: the plan's Task 3 section. SUMMARY_SCHEMA gains referenced_terms (term/kind/citation_raw, all required, additionalProperties false at both levels); SYSTEM_PROMPT extraction instruction must contain the marker 'never infer' and restrict to names/citations the bill text itself prints; PROMPT_VERSION → 'v2'; renderMarkdown UNCHANGED.
2. The GOLDEN CHECK GATE (~$0.35) is NOT yours to run — implement + test pure parts, commit, and STOP with status READY_FOR_GOLDEN_GATE. The controller obtains Lance's approval and runs it.
3. Do not touch verifier.js or the verify CLI (they operate on what_it_does bullets, unaffected by an additive schema field — confirm that by reading parseBullets' input path and STATE the confirmation in your report).
