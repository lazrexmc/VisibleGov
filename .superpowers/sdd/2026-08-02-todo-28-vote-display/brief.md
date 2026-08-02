# Task brief — TODO 28: zero-cast roll calls reading as broken on bill pages

Approved by Lance (working through the non-usage queue, "continue after the verification pass").
Zero model calls, zero network calls — this is a public-site display fix over already-correct data
(no ingestion, no DB writes — this task never touches production data, only `site/js/bill-page.js`).

## The problem, verified live today (numbers have grown since the original 2026-07-31 audit — always
## re-verify live before trusting any count in this brief)

167 `votes` rows carry zero `vote_casts`, across 60 bills, from two structurally DIFFERENT causes
that need DIFFERENT treatment — do not conflate them:

**`mo-ocd` (OpenStates), 95 rows — permanent, structurally noisy, safe to suppress when redundant.**
Sampled 6+ bills directly. These are NOT 1:1 duplicates of a specific real vote — they're OpenStates'
own bill-action log entries, each carrying only a bare status word (`result: "pass"`, never a real
tally), often MANY per bill (one sampled bill has 16 OpenStates zero-cast entries against only 7 real
LegiScan votes). OpenStates never has per-member cast data for MO (confirmed, structural upstream
gap, not pending). Once a bill has ANY real cast-bearing vote from another source, these entries add
zero reader value — they are procedural noise, not a second data point.

**`mo-house` (mo-house-xml), 72 rows — transient, legitimately mid-pipeline, NEVER suppress.**
Sampled directly: these carry REAL, SPECIFIC tallies already (`"20-0"`, `"6-3"`, never a bare status
word) — the vote row lands from the bill's action history immediately; casts arrive later from a
separately-polled roll-call PDF (`ingest-mo-house.js`'s `persistRollCallCasts`/`processRollCallPdf`).
**Verified in the code: this UPDATES THE SAME `vote_id` in place — it never creates a second vote
row.** These rows will never become "duplicates" the way OpenStates rows are; they will simply gain
their casts and stop being zero. They ARE real data, just incomplete — suppressing them would hide a
real recorded tally a reader is entitled to see.

Net effect after removing the source split, live-verified: 60 affected bills split into ~26 with a
real cast-bearing sibling elsewhere on the bill (mostly `mo-ocd` noise), and ~34 with no real sibling
anywhere on the bill (~4 permanently OpenStates-only, ~30 mo-house rows still mid-pipeline).

## The fix — two independent, additive changes to `site/js/bill-page.js`, nothing destructive

### 1. Suppress redundant `mo-ocd` zero-cast rows when real data exists elsewhere on the bill

In `loadVotesSection` (reads `VOTES_SELECT`, currently `'id,jurisdiction_id,chamber,vote_date,
question,result,source_url'` — no `source_key`): add `source_key` to the select (cheap, additive,
needed to identify which rows are `mo-ocd`-sourced; the column already exists on `votes`).

After the per-vote cast-tally fetch (the code already computes `tallyByVoteId`), before calling
`renderVotes`: if this bill has AT LEAST ONE vote with `tallyByVoteId.get(vote.id)` showing any
non-zero cast count, filter the vote list passed to `renderVotes` to EXCLUDE any vote whose
`source_key` starts with `mo-ocd-` AND whose own tally is all-zero. Scope this at the WHOLE-BILL
level, not per-chamber or per-date — do not attempt to pair a specific OpenStates entry with a
specific specific LegiScan vote by date/tally proximity; the sampled data proves there is no honest
1:1 correspondence to find (multiple stubs, no matching tallies, sometimes different dates
entirely) — inventing one would be exactly the fuzzy-matching this codebase has banned everywhere
else. This is bill-level "real data exists, so the noise adds nothing," never a claimed pairing.

If a bill's `mo-ocd` zero-cast rows are its ONLY votes (no real data anywhere — the ~4-bill case),
do NOT suppress them — nothing else exists to show, so removing them would leave the section looking
empty/broken when there IS a real recorded outcome (`result`), just no individual-member breakdown.

### 2. Honest wording for any zero-cast row that still renders (never silently look like "0 people voted")

`formatTallyLine` (find its current definition — it's what renders next to `bill-vote-tally`) needs
a distinct branch for the true-zero case: when every position count is 0, render something like
`"(no individual member votes recorded for this record)"` instead of a bare `"yea 0 · nay 0 · ..."`
line, which reads as a real (and strange) unanimous-absent outcome rather than "data not available."
This applies to BOTH remaining cases after suppression: mo-house rows still pending their PDF, and
the small set of OpenStates-only bills with nothing else to show. Do not try to word these two cases
differently (e.g. "pending" vs "not available") from the frontend alone — the page doesn't reliably
know which is which without guessing at source-specific behavior the reader doesn't need explained;
one honest, source-agnostic wording covers both truthfully ("recorded", not "existed" — a reader
should not conclude nobody voted).

## Constraints

- This is a pure client-side JS change. No migration, no CLI, no ingestion path touches. Read the
  WHOLE of `site/js/bill-page.js` (`loadVotesSection`, `renderVotes`, `formatTallyLine`, and the
  `VOTES_SELECT` constant) before editing — match its existing patterns (the file already has a
  `flagsUnavailable`/three-state-section discipline documented at its own header; follow it, don't
  invent a new failure-handling shape for this feature).
- TDD: there's an existing DOM-level test suite for this file (jsdom-based per this repo's approved
  dev dependency) — find it (`tests/*.test.js` matching bill-page) and add cases there, not a new
  ad-hoc test file, matching its existing fixture/assertion style. Cover: (a) a bill with a mix of
  cast-bearing votes and `mo-ocd` zero-cast noise — the noise rows must not render at all; (b) a bill
  with ONLY `mo-ocd` zero-cast rows — they must still render (nothing else to show), with the honest
  zero-cast wording; (c) a bill with `mo-house` zero-cast rows only — never suppressed, honest wording
  applied; (d) a bill mixing a cast-bearing vote with an `mo-house` zero-cast row — the mo-house row
  must NOT be suppressed (only `mo-ocd` rows are ever suppressed, regardless of what else exists on
  the bill).
- **Per this repo's own UI-change convention: before reporting this done, actually load the dev
  server and view a real affected bill page in a browser** (or via a script that renders the DOM and
  inspects it, if a live browser isn't available in this environment — but prefer the real thing).
  State plainly in your report whether you did this and what you saw, not just that tests pass.
- Bare `node --test` from repo root; extract the literal `ℹ fail` line yourself, commit only at 0.
- Live-verify the exact current counts (167/60/95/72, or whatever they've grown to) against the real
  database before writing your report — do not just cite this brief's numbers as if they're frozen.
- Commit message explains the defect and the fix, ends with:

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

Return: status, commit hash, fail-count line verbatim, what you saw when you actually looked at an
affected bill page (before/after if you can capture it), and concerns.
