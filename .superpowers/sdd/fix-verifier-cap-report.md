# fix-verifier-cap report

## Status
Done. Fix implemented, tested, committed, pushed.

## Issue
Many-bullet summaries (HR 6955, HR 8595) failed verification with `SummaryTruncatedError`.
`verifyBill` in `src/lib/verifier.js` reused `summarizer.js`'s `MAX_OUTPUT_TOKENS` (16000) as its
`max_tokens` cap. On `claude-sonnet-5`, adaptive thinking plus a full per-bullet verdicts JSON
(section, supported, reason, evidence_quote per bullet) exceeded that cap for summaries with many
bullets.

## Fix (src/lib/verifier.js)
1. Added `export const VERIFY_MAX_OUTPUT_TOKENS = 32000;` (with rationale comment tying it to the
   HR 6955 / HR 8595 live diagnosis). Removed `MAX_OUTPUT_TOKENS` from the `summarizer.js` import
   (no longer used in this file) — `MAX_TEXT_CHARS` and the typed errors are still imported/used
   as before.
2. `verifyBill` now calls `client.messages.stream({ ...same params, max_tokens:
   VERIFY_MAX_OUTPUT_TOKENS })` and `await`s `stream.finalMessage()` instead of
   `client.messages.create(...)`. `finalMessage()` returns the same complete `Message` shape
   `.create()` returned, so the `stop_reason` checks, content extraction, and downstream
   `assessVerdicts` usage in `src/cli/verify.js` are unchanged.
3. `SummaryTruncatedError` path is untouched — still thrown on `stop_reason === 'max_tokens'` and
   on a missing text content block. 32k can still truncate a pathological case; that stays the
   honest typed failure, not a silent truncation.
4. Nothing else in the file was restructured (schema, system prompt, `assessVerdicts`,
   `buildVerifyMessage`, `VerificationIncompleteError` all untouched).

## Tests (tests/verifier.test.js)
Added one constants test:
```js
test('VERIFY_MAX_OUTPUT_TOKENS is at least 32000, and deliberately not summarizer.js MAX_OUTPUT_TOKENS', () => {
  assert.ok(VERIFY_MAX_OUTPUT_TOKENS >= 32000);
});
```
Imported `VERIFY_MAX_OUTPUT_TOKENS` alongside the existing verifier exports. All other tests
unchanged — the streaming call itself is live-only (consistent with this codebase's convention of
not unit-testing fetch/SDK wrappers); the existing `verifyBill throws OversizeTextError before
touching the client...` test still passes `{}` as the client since that path returns before
`client.messages.stream` is ever called.

## Evidence

`node --test tests/verifier.test.js`: 28/28 pass, including the new constants test.

`npm test` (full suite): 278/278 pass, 0 fail (was 277 green before this branch; +1 for the new
test). One pre-existing test intentionally logs a `TypeError` from the review server's error path
during the run (`POST /api/decision ... TypeError: Cannot read properties of null`) — that is
expected output from an existing passing test exercising an error branch, unrelated to this change
(confirmed present in the same spot on a clean run of the same suite).

## Commit
`4d3ee03633eed3b675afcf56a08abaf62d04beda` — "fix: verifier output cap 32k via streaming
(many-bullet truncation)" on branch `fix-verifier-cap`, pushed to `origin/fix-verifier-cap`.

Files changed: `src/lib/verifier.js` (+14/-3), `tests/verifier.test.js` (+8).

## Concerns
- Live re-verification of HR 6955 / HR 8595 against the new 32k cap is out of scope for this task
  (no live model calls here per instructions) — the controller runs that re-verification after
  merge, per the task framing.
- No test exercises the actual streaming code path (`client.messages.stream(...).finalMessage()`)
  since it requires a live client — flagged as an intentional, convention-consistent gap, not an
  oversight.
- `VERIFY_MAX_OUTPUT_TOKENS` (32000) is double `MAX_OUTPUT_TOKENS` (16000) but still well under
  typical model output ceilings; if a future many-bullet summary is large enough to still hit
  `SummaryTruncatedError` at 32k, that's the intended honest-failure behavior, not a bug.
