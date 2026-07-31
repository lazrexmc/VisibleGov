# Task 4 report: Extraction backfill CLI

**Status:** READY_FOR_LIVE_GATE

**Commit:** d910d54 — "feat: extract-terms backfill CLI (gated)" (pushed to
`glossary-implementation`, range 777e7fc..d910d54)

**Tests:** 311/311 green (294 prior + 17 new in `tests/extract-terms-cli.test.js`). TDD
followed: all 17 assertions were confirmed failing (module-not-found, since
`src/cli/extract-terms.js` did not exist yet) before implementation, then green after.

## What was built

`src/cli/extract-terms.js` — a backfill CLI, same shape as `verify.js`/`golden.js`:
pure planning + typed failures + `--dry-run` (zero-call) + a mechanical per-run approval
gate for live mode. Added `"extract-terms": "node --env-file=.env src/cli/extract-terms.js"`
to `package.json`.

### Extraction call (never invoked live this task — see Concerns)

- `EXTRACT_MODEL = 'claude-sonnet-5'`, `EXTRACT_PROMPT_VERSION = 'v1'`, `EXTRACT_MAX_OUTPUT_TOKENS = 4000`
  (tiny output — a handful of `{term, kind, citation_raw}` triples, not a full summary).
- `EXTRACTION_SCHEMA` wraps a single `referenced_terms` property whose value IS
  `SUMMARY_SCHEMA.properties.referenced_terms` **by object reference** (not a re-typed
  copy) — the two shapes literally cannot drift apart. Confirmed by a dedicated test
  (`assert.equal`, same reference, not `deepEqual`).
- `extractTerms()` reuses summarizer.js's `OversizeTextError`/`SummaryRefusedError`/
  `SummaryTruncatedError` directly, same convention `verifier.js` already established for
  its own non-summary model call.

### Pure parts (TDD'd first)

- `planExtraction(summaries, extractedSummaryIds)` — summaries lacking any `summary_terms`
  row need extraction. No status filter: which statutes/acts a bill's text cites is
  orthogonal to the summary's editorial status, so the backfill covers the whole
  `summaries` table.
- `normalizeTermText(s)` — trim + collapse internal whitespace only, per controller ruling 2.
  Never rewrites the term (verbatim-from-bill discipline); (kind, term) dedup for unmapped
  terms is exact-string only, accepted and documented, not "fixed" with fuzzier matching.
- `upsertKeyFor(term)` → `{by: 'citation'|'term', needs_mapping}` — the branched upsert
  decision ledgered from Task 1's review. Decided entirely by whether `parseCitation`
  resolves `citation_raw`; never by `kind`, never a guess at a citation the bill text
  didn't print.

### DB-facing branch (real finding, not just plumbing)

`upsertGlossaryTerm` implements ruling 2's "compatible with BOTH the base unique
constraint and the partial index `glossary_terms_unmapped_uidx`" requirement, and the two
branches need genuinely different strategies:

- `by: 'citation'` → the base `unique (kind, citation)` constraint is a normal, non-partial
  unique index, so `insertIfAbsent`'s `ON CONFLICT(kind,citation) DO NOTHING` path (existing
  `lib/db.js` helper) works as-is.
- `by: 'term'` → `glossary_terms_unmapped_uidx` is a **partial** unique index
  (`(kind, term) WHERE citation IS NULL`). Postgres only lets `ON CONFLICT` target a
  partial index when the conflict clause repeats its exact `WHERE` predicate; PostgREST's
  `upsert` `on_conflict` parameter (what `insertIfAbsent` sends) is a bare column list with
  no way to express that predicate — `ON CONFLICT(kind,term)` can never resolve to this
  index at all (Postgres would reject it: "no unique or exclusion constraint matching").
  This branch instead does manual check-then-insert (`findExistingGlossaryTerm` then a
  plain `insert`), the same shape as `ingest.js`'s existing
  `findExistingTerm`/`upsertTerm` workaround for a different nullable-column ON CONFLICT
  gap. Single-threaded CLI runs, so the race window is accepted (consistent with the
  existing `ingest.js` precedent), not engineered around.

## Dry-run against the live DB (verbatim)

Zero Anthropic calls — the dry-run path returns before `getAnthropicClient()` is ever
reached. Ran against the real Supabase project (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
from `.env`):

```json
{
  "mode": "dry-run",
  "counts": {
    "summaries": 25,
    "alreadyExtracted": 0,
    "candidates": 25
  },
  "candidates": [
    { "id": "86206cb6-a0e7-4683-b4a1-182dc03090b3", "status": "published", "identifier": "HR 1366" },
    { "id": "d051c1f0-2a73-4bc2-a369-7b91c6b825f4", "status": "published", "identifier": "HR 845" },
    { "id": "d5ab8340-f8a5-4eb4-8a18-65698d93d967", "status": "published", "identifier": "HR 498" },
    { "id": "fe4cab8e-df73-44fa-b558-1a4bb58f5611", "status": "draft", "identifier": "HR 8884" },
    { "id": "79e426d5-13f2-4444-b234-f514ea9a0dfe", "status": "draft", "identifier": "HCONRES 89" },
    { "id": "2064a869-95e6-4133-9ade-1d63a1de5f0f", "status": "draft", "identifier": "SJRES 180" },
    { "id": "c7aaa8c7-40fd-4c4f-be4d-4b03278fe12d", "status": "draft", "identifier": "HR 7008" },
    { "id": "60dcacd5-1a31-4b92-a414-b45ed9de5456", "status": "draft", "identifier": "HCONRES 113" },
    { "id": "d80e3deb-d2b2-435d-a4a0-5a14cab2b47a", "status": "draft", "identifier": "HRES 1438" },
    { "id": "46d3fa2d-d00c-44d8-8f88-6b2f083aa85a", "status": "draft", "identifier": "HR 1118" },
    { "id": "61616ab4-682c-44ce-8c1d-5320ff5ccd44", "status": "draft", "identifier": "HR 6955" },
    { "id": "a3979b70-d156-4939-a9f2-6e7656732cc3", "status": "draft", "identifier": "HR 9770" },
    { "id": "0a5d6358-ee9c-4210-a91f-c9246f541e20", "status": "draft", "identifier": "HR 4541" },
    { "id": "a0fc4029-2cda-4aeb-a1e7-376d14d08c1f", "status": "draft", "identifier": "HR 8823" },
    { "id": "85215658-031d-4a6b-8e08-376650ec1d31", "status": "draft", "identifier": "SJRES 198" },
    { "id": "e80aaf4b-f4f2-49c3-bc50-3b45b8e76e55", "status": "draft", "identifier": "HR 5362" },
    { "id": "55b955de-14df-4cc5-bb4f-a0575c4572bd", "status": "draft", "identifier": "HR 8595" },
    { "id": "4eaabfac-cb61-4443-884b-d68b3ffff4a8", "status": "draft", "identifier": "HR 1181" },
    { "id": "07ea48b4-2763-4ba7-8be9-1a2c6a6bd8bc", "status": "draft", "identifier": "HR 139" },
    { "id": "949ad91c-8953-4657-b715-23021573c219", "status": "draft", "identifier": "HRES 1423" },
    { "id": "ea232e0e-206d-4c3f-a4fd-6a3de49cd6ca", "status": "draft", "identifier": "HR 3106" },
    { "id": "84258cbc-be74-45dd-9e1e-d9232f604d17", "status": "draft", "identifier": "HR 8897" },
    { "id": "f9f74146-374b-4135-aef5-4bf20d11b405", "status": "draft", "identifier": "HRES 1399" },
    { "id": "0d16335a-8106-46d7-b40d-d36aad814a25", "status": "draft", "identifier": "HCONRES 108" },
    { "id": "d23cbde6-d64e-4332-b8a6-00ffb329823e", "status": "draft", "identifier": "HRES 1398" }
  ],
  "note": "(summary_terms missing — migration 0007 not applied; treating all summaries as candidates)"
}
```

25 candidates — matches the plan's own estimate ("~25 candidates", "~25 x ~$0.03 ~= $0.75")
exactly. The note honestly surfaces that `summary_terms` doesn't exist yet (0007 unapplied)
rather than silently reporting 0 candidates or crashing.

**Also confirmed (ruling 3):** running the CLI in live mode (no `--dry-run`, no
`GLOSS_RUN_APPROVED`) hard-fails immediately on the same missing-table lookup, before ever
reaching the cost estimate, the `GLOSS_RUN_APPROVED` gate, or `getAnthropicClient()`:

```
Error: summary_terms lookup failed: Could not find the table 'public.summary_terms' in the schema cache
    at loadExtractedSummaryIds (file:///F:/VisibleGov/src/cli/extract-terms.js:157:11)
```
Exit code 1. Zero Anthropic calls made anywhere during this task (verified structurally —
the dry-run and the live-mode failure both return/throw before `getAnthropicClient()` is
called — and no `ANTHROPIC_API_KEY`-consuming code path executed).

## Concerns

- The live extraction call path (`extractTerms`, `upsertGlossaryTerm`, `extractOne`) is
  implemented but has never actually run against the Anthropic API — per the brief, no
  credits exist and the task stops at READY_FOR_LIVE_GATE regardless. It is exercised only
  by the pure/schema tests and by reading through the code; the real risk surface (does the
  model actually return well-formed `referenced_terms`, does the citation normalization
  `${title} U.S.C. ${section}` read naturally for every case) is unverified until Lance
  approves the live run.
- 0007 being unapplied means the whole live path (`upsertGlossaryTerm`,
  `findExistingGlossaryTerm`, the `summary_terms` join) is also untested against a real
  `glossary_terms`/`summary_terms` table — only the missing-table hard-fail was verified
  live. Once Lance applies 0007, worth a first small live run to confirm the partial-index
  branch behaves as designed before trusting it at scale.

## Fix round 1 (review): CRITICAL + IMPORTANT addressed

**Commit:** `1cf33f4` — "fix: nullable stub sources + published-completeness check; prompt
marker tests" (pushed to `glossary-implementation`, range `d910d54..1cf33f4`)

**Tests:** 313/313 green (`node --test tests/extract-terms-cli.test.js`: 19/19; full
`npm test`: 313/313 — 311 prior + 2 new).

### CRITICAL — schema/sequencing mismatch (inherited from the design doc, not this task's
invention)

`supabase/migrations/0007_glossary.sql`'s `glossary_terms` table declared `source_url` and
`source_hash` `not null`, but this task's own stub inserts (`upsertGlossaryTerm`, both
branches) only ever write `{term, kind, citation, status: 'draft', needs_mapping, run_id}`
— by design, since Task 5 (not Task 4) is what fetches the source and writes
`source_url`/`source_hash`/`gloss_md`. Applied as originally drafted, every Task-4 stub
insert would have failed against the real schema the moment 0007 landed — a real
sequencing bug, caught before it could bite.

Fix (0007 is still an unapplied draft, edited in place per the existing precedent set by
earlier tasks): dropped `not null` from `source_url` and `source_hash`, and added

```sql
constraint glossary_terms_published_complete check (
  status <> 'published' or (source_url is not null and source_hash is not null and gloss_md is not null)
)
```

with a comment at the constraint spelling out the lifecycle it enforces: Task 4 creates
bare stubs → Task 5 fetches source + writes gloss_md/source_url/source_hash → Task 6 review
→ publish. Stubs may sit bare indefinitely; nothing bare can ever reach `'published'` — the
integrity guarantee moved from "every row must have a source" (wrong — breaks the
stub-then-gloss lifecycle) to "every *published* row must have a source" (the boundary that
actually matters for a trust product).

**Verified statically** (0007 is still unapplied, so this cannot be verified live yet):
read both `glossary_terms` insert call sites in `src/cli/extract-terms.js`
(`upsertGlossaryTerm`, the `insertIfAbsent(...)` call and the plain `.insert(...)` call) —
both supply exactly `{term, kind, citation, status, needs_mapping, run_id}` and never
`source_url`/`source_hash`/`gloss_md`. Against the amended schema, the only remaining `not
null` columns are `term`, `kind`, and `status` (all three always provided), and
`status: 'draft'` always short-circuits `glossary_terms_published_complete` true
(`status <> 'published'`) regardless of the null source/gloss columns. Both insert paths
now succeed where they previously would have violated the old `not null` constraints.

### IMPORTANT — EXTRACT_SYSTEM_PROMPT brought to Task 3's test bar

`EXTRACT_SYSTEM_PROMPT` was already exported; added it to the test file's import list and
two new tests mirroring `summarizer.test.js`'s pattern: one asserting the `'never infer'`
marker and the `'the bill text itself'` scope-restriction phrase are both present, one
asserting the prompt mirrors Task 3's exhaustive completeness framing verbatim
(`'for every statute, act, agency, program, or public law the bill text itself names or
cites'`) alongside the scope-restricting `'only'`. The prompt text itself was tightened to
include that exact completeness phrase — previously it stated scope (`'ONLY ... never
infer'`) but not completeness (extract *every* one present, not just some); now both are
explicit, matching Task 3's `SYSTEM_PROMPT` framing in `src/lib/summarizer.js`.

### Concerns (unchanged from the base task)

Same two as the base task's Concerns section above: the live extraction call path and the
`glossary_terms`/`summary_terms` write path remain unexercised against a real Anthropic
response or a real (post-0007) table — both gated on Lance applying 0007 and approving a
live run. No Anthropic calls were made addressing this review round either.
