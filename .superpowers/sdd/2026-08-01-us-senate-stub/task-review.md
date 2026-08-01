# Task review — us-senate not-yet-published guard (commit 31dc3b3)

Reviewed: commit `31dc3b3ab84d3a927debf37be7e07c887b84eea2` on `main`, 1 commit ahead of pushed
`origin/main` (144b320). Diff: `src/adapters/us-senate.js` (+47/-1), new fixture
`tests/fixtures/us-senate/roll-call-unavailable.html` (580 lines), `tests/us-senate.test.js`
(+73/-1). Verified the review package's stat and full diff against `git show`/`git diff` directly
— byte-for-byte match, no discrepancy between the package and the actual commit.

## SPEC VERDICT: PASS

Every causal claim in the commit message and review package was independently reproduced, not
just read:

- **The premise** (`fetchWithLimit`'s `!res.ok` never fires for HTTP 200) — confirmed by reading
  `src/lib/http.js:30`; `res.ok` is true for any 2xx status per the Fetch spec, so a 200 response
  never enters the `throw new SourceFetchError` branch regardless of body content.
- **The original bug is real, not just asserted** — reverted `src/adapters/us-senate.js` to the
  parent commit (144b320) via `git checkout 144b320 -- src/adapters/us-senate.js`, then ran the
  old `parseSenateRollCall` directly against the real captured fixture. It threw exactly
  `TypeError: Cannot read properties of undefined (reading 'congress')`, matching the commit
  message's claimed crash signature verbatim. Restored via `git checkout HEAD --` immediately
  after (confirmed clean via `git diff HEAD` — empty).
- **The guard's classification is correct on the happy path** — real XML for an existing vote
  never enters the `if (!root)` branch at all (confirmed by the pre-existing, unmodified test
  `parseSenateRollCall yields a full-chamber cast list including both MO senators` still passing,
  plus my own probe feeding real XML with the marker phrase artificially embedded in a text field —
  it parsed normally with no throw, since `root` was truthy and the guard is never reached).
- **`collectUsSenate`'s per-vote catch is genuinely unchanged** — `git diff 144b320..31dc3b3 --
  src/cli/ingest.js` is empty. Read the live code directly (`src/cli/ingest.js:139-148`): the
  catch is `if (!(err instanceof SourceFetchError)) throw err; failures.push(...); continue;`.
  `RollCallNotYetPublishedError extends SourceFetchError`, so it's caught, recorded in
  `failures`, and the explicit `continue` (line 147) advances the `for (const num of
  targetNumbers)` loop to the next vote number — the window does not abort partway through. This
  mirrors `collectUsCongress`'s sibling catch (`src/cli/ingest.js:50-71`) for a real House 404.
- **Scope claim holds** — `scripts/scheduled-ingest.js`, `src/adapters/us-congress.js`, and
  `src/cli/ingest.js` are all byte-identical to the parent commit (`git diff 144b320..31dc3b3 --
  <files>` returns nothing for all three).

## QUALITY VERDICT: PASS

- **Fail-count line extracted from a bare `node --test` run at repo root (HEAD, untouched):**
  ```
  ℹ tests 2092
  ℹ pass 2092
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ```
  Matches the claimed `ℹ fail 0`, 2092 pass exactly. Zero `not ok` lines anywhere in the full
  output (grep-confirmed across the whole log, not just the summary). `npm test` is defined in
  `package.json` as exactly `node --test` — no hidden wrapper changes the meaning of this count.
- **Red-first, mechanically confirmed twice:**
  1. Reverting `src/adapters/us-senate.js` to the parent commit and running
     `node --test tests/us-senate.test.js` fails the entire file to even load: `SyntaxError: The
     requested module '../src/adapters/us-senate.js' does not provide an export named
     'RollCallNotYetPublishedError'`. Genuinely red before the fix, at the strongest possible
     level (import-time, not just an assertion failure).
  2. Independently reproduced the exact pre-fix `TypeError` against the real fixture (see SPEC
     VERDICT above).
- **Mutation test — the exact regression the task asked about, actually performed, not just
  reasoned through.** Temporarily edited `parseSenateRollCall` to loosen the guard to "any
  missing root ⇒ `RollCallNotYetPublishedError`" (removing the marker check entirely — the
  precise "loosens the stub predicate to 'any missing root'" scenario). Re-ran
  `tests/us-senate.test.js`: the second new test failed immediately —
  `AssertionError: must not be misclassified as the not-yet-published case` — while the other
  tests stayed green. This is definitive proof the test suite catches that specific regression,
  not an inference from reading the assertions. Reverted via `git checkout HEAD --` immediately
  after; `git diff HEAD -- src/adapters/us-senate.js` confirmed empty afterward, and the full
  suite was re-run clean (`ℹ fail 0`, 2092 pass) as a final check.
- **Fixture authenticity** — 28,690 bytes on disk (28,661 in the git blob; the 29-byte gap
  exactly equals the file's CRLF count, i.e. Windows checkout line-ending normalization, not
  tampering). Comparable in size to the pre-existing `roll-call.xml` fixture (29.7 KB) — no git
  bloat concern. Strong structural evidence of a genuine scrape rather than hand- or
  LLM-fabrication: three CMS-fragment regeneration timestamps embedded in comments that
  disagree with each other (2019, 2023, 2025 — exactly what you'd expect from independently
  cached template includes, not something a fabricator would bother faking), a ColdFusion
  `<CFPARAM>` tag, a human comment ("commented out by betty"), malformed/unclosed `<li>` tags,
  and mixed CRLF/LF line endings within the single file. Referenced only in a code *comment*
  (`src/adapters/us-senate.js`) and in the test file — grep across `**/*.js` confirms no
  production path reads it.
- **No network/DB calls** — read `tests/us-senate.test.js` in full; the only I/O is
  `readFileSync` against local fixtures. No `fetch`, no `http`, no Supabase/db import anywhere in
  the file.

## THE CRITICAL PROPERTY — swallow-boundary attack results

Wrote an independent adversarial probe (not part of the shipped test suite) and ran it against
the fixed adapter. Full matrix:

| Input | Classification | Correct? |
|---|---|---|
| Real captured stub | `RollCallNotYetPublishedError` (is-a `SourceFetchError`) | Yes |
| Real roll-call XML (happy path) | no throw, normal parse | Yes |
| Lowercase marker | plain `Error`, not `SourceFetchError` | Yes |
| Double-spaced marker | plain `Error` | Yes |
| Plural "Votes" | plain `Error` | Yes |
| Marker split across two tags | plain `Error` | Yes |
| Differently-worded "unavailable" page | plain `Error` | Yes |
| Generic HTML 500 page | plain `Error` | Yes |
| Maintenance page | plain `Error` | Yes |
| CAPTCHA page | plain `Error` | Yes |
| Empty string | plain `Error` | Yes |
| JSON error body | plain `Error` | Yes |
| Unrelated real senate.gov page shape | plain `Error` | Yes |
| Real stub truncated before `<title>` | raw `TypeError` from fast-xml-parser internals (not `RollCallNotYetPublishedError`, not `SourceFetchError`) | Not misclassified (see Minor-1) |
| Real stub truncated at 100 bytes | raw `Error` ("Unclosed DOCTYPE") from fast-xml-parser (not `SourceFetchError`) | Not misclassified (see Minor-1) |
| Real XML with marker text stuffed into a `<question>` field, root intact | no throw, normal parse (marker text irrelevant since `root` is truthy) | Yes |

**(a) Can a genuinely corrupted existing-vote response match the stub predicate?** Only if the
corruption both (i) loses the `roll_call_vote` root AND (ii) happens to contain the literal
27-character case-sensitive substring "Roll Call Vote Unavailable" verbatim. The predicate is an
exact substring match on the raw response text, not a loose match (confirmed tight against 5
near-miss variants above) and not a full-body hash (which would be brittle to harmless byte
changes) — a reasonable middle point. If `root` is present, the predicate is never evaluated at
all regardless of what text appears elsewhere in the payload.

**(b) Can a rootless-but-not-stub payload be misclassified as not-yet-published, hiding a real
outage?** No — confirmed across 8 distinct adversarial "real outage/error page" shapes plus 2
truncation variants of the real stub itself. None were classified as `RollCallNotYetPublishedError`
or as any `SourceFetchError`. The dangerous direction (silent swallow of a real problem) did not
occur once.

**(c) Does real XML for an existing vote still parse unchanged?** Yes — confirmed both by the
unmodified pre-existing test still passing and by direct probing; the diff's post-guard body is
untouched context, not modified code.

## Findings

No Critical or Important findings.

**Minor-1** (`src/adapters/us-senate.js:104-127`) — A response truncated mid-transfer (cut off
before or shortly after the marker text would appear) does not reach either the typed
`RollCallNotYetPublishedError` branch or the clean "genuine parse failure" `Error` message;
fast-xml-parser itself throws a raw internal error first (observed: `TypeError: Cannot read
properties of undefined (reading 'tagName')`, and separately `Unclosed DOCTYPE`). This still
fails loud — confirmed not a `SourceFetchError`, not misclassified — so the critical safety
property holds. But it means a genuine network-level truncation would still hard-crash the whole
`collectUsSenate` run, same as the original bug, just via a different, less informative message.
This is pre-existing behavior outside this fix's stated scope (the production trigger is a
complete, well-formed HTTP 200 body, not a truncated transfer), and is consistent with the code's
own documented intent that unrecognized shapes "must still fail loudly." Not a blocker.

**Minor-2** (`src/adapters/us-senate.js:102,114`) — The stub predicate is coupled to the literal
current wording of a live third-party page ("Roll Call Vote Unavailable"). If senate.gov ever
changes that exact phrase, real not-yet-published probes would start throwing the loud
unrecognized-shape `Error` again instead of being classified as an expected miss — a noisy
regression (failed run needing attention), not a silent one. Safe-direction fragility, worth
knowing as a maintenance coupling, not a defect.

**Minor-3** (process note) — The SDD folder (`.superpowers/sdd/2026-08-01-us-senate-stub/`)
contains only `review-package.md`; no separate task-brief/spec doc or red-first evidence artifact
of the kind some other SDD folders in this repo carry (e.g. `2026-07-31-scheduling/` has four
files across multiple review rounds). Did not block this review — the red-first and bug-repro
claims were independently reproduced mechanically (see QUALITY VERDICT) rather than taken on
faith — but flagging since it's a lighter paper trail than this repo's usual habit.

## Fail-count line (verbatim, bare `node --test` from repo root, HEAD)

```
ℹ tests 2092
ℹ pass 2092
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## Verdict: SHIP

The fix does exactly what it claims, the swallow-boundary safety property (the one this repo's
review history keeps catching regressions on) held under direct adversarial attack including a
real mutation test, the pre-existing happy path is untouched, the per-vote catch and loop-continue
semantics that make this safe are byte-identical to the parent commit, and the fixture is
authentic. The two Minor findings are residual-risk notes for awareness, not shipping blockers —
neither describes a silent-failure regression, and Minor-1 is pre-existing/out-of-scope behavior
rather than something this diff introduced.
