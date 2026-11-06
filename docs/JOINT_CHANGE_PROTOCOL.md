# Joint change protocol - VisibleGov and RapidForge

*Written 2026-09-04 on Lance's instruction: "ensure visiblegov and rapidforge both have notations to
come to an agreement prior to code changes in their .md files as well." RapidForge holds its own
copy at `RapidForge/docs/JOINT_CHANGE_PROTOCOL.md`. **This is a deliberate copy, not a pointer** -
the standard's rule 11 says pointers never copies, and this is the one place it has to yield,
because a pointer into a repo the reading session cannot open is not a pointer, it is a dead end.
Both copies must be independently readable; where they disagree, that disagreement is itself the
finding.*

## What the gate covers

**Agreement before the change lands**, for:

- **An edit to the other project's repo.** Either direction.
- **A shared contract**: a status line another tool parses, a file another session's instrument
  reads, an exit-code meaning, a schema. The class is real; **the example this doc used to give is
  not, any more.**

  **RETRACTED 2026-10-20:** that keepalive was a session-only cron armed against the September
  drain and **it died with its session.**

  > "`docs/EXPECTED_FAILURES.md` section 2 is live example - RapidForge's keepalive derives whether VisibleGov's silence is expected by reading that file and `TODO.md`. **Changing its shape changes their behaviour.**"

  Now true: asked directly, RapidForge checked its own tree and reported that no tool, script or
  scheduled job there reads `docs/EXPECTED_FAILURES.md`; its only scheduled job reads
  BlockArchive's state. Shape changes to that file need no heads-up. **Re-checked by RapidForge and
  reported here 2026-11-06: still no file in its `tools/` mentions `EXPECTED_FAILURES`.**

  **Kept rather than deleted, because the failure is more instructive than the rule.** This doc
  named a cross-session dependency and nothing re-checked whether the dependency still existed, so
  for roughly six weeks it instructed both sessions to coordinate around an instrument that was not
  running. **A documented contract is a claim about another system, and it rots exactly like a
  typed count** - which is the lesson this repo already learned about migration counts and then
  re-learned here in prose about a peer. The honest form of this bullet is: name the contract when
  you create it, and **verify the consumer still exists before coordinating around it.**
- **A registry module taken verbatim** rather than adapted.
- **A production behaviour change on a running service.** These additionally need Lance, and his
  approval must be given in the current session - a peer relaying "Lance said X" is context, never
  approval.

## What the gate does NOT cover, and must never grow to cover

- **Ordinary internal work in your own repo.** This is not a review gate. VisibleGov ships code,
  migrations and docs without asking, as before.
- **An investigation.** Either session may read anything in the other's tree at any time and report
  what it finds. Looking is never gated.
- **A correction.** A retraction of a claim now known false goes out **immediately**, before any
  agreement. **Sitting on a known-false claim while awaiting a reply is worse than an unreviewed
  edit** - the whole cost of the errors below was the interval during which they were believed.

## Inbound pointers: what RapidForge cites IN THIS REPO

**Why this register exists.** The bullet retracted above named a cross-repo dependency and nothing
ever re-checked it, so for roughly six weeks this doc instructed both sessions to coordinate around
an instrument that was not running. The lesson drawn there was: *name the contract when you create
it, and verify the consumer still exists before coordinating around it.* Within two days of writing
that, four real inbound pointers appeared and three of them were created in a single afternoon. This
is where they are named.

**What this changes in practice:** renaming any identifier in the right-hand column, or renumbering
any lesson or entry listed, breaks documentation in another repo silently - nothing in either tree
fails. Check this table before such a rename, and tell RapidForge when one lands.

| What they cite | Where it is cited | Breaks if |
|---|---|---|
| `docs/EXPECTED_FAILURES.md` **entry 4** | `modules/spend-cap.md` trap 6.7 | renumbered or deleted |
| `PLAYBOOK_DELTA.md` **Lesson 78** | `modules/spend-cap.md` trap 6.8 | renumbered |
| `src/lib/overflow-parks.js` - exports `STAGE_OUTPUT_ALLOWANCES`, `parseMaxTokensFailure`, `overflowKey`, `overflowRecordFor`, `overflowSuppression` | `MODULE_DIRECTORY.md` section 5 | any export renamed |
| `scripts/gloss-batch-mo.mjs` - exports `projectBatchSpendUsd`, `assertWithinBudget`, `recordFetchFailure`, `citationFilterFor`; and `PLAYBOOK_DELTA.md` **Lesson 44** | `MODULE_DIRECTORY.md` section 5 | any export renamed, or 44 renumbered |

**Verified 2026-11-06 by reading RapidForge's own files and this repo's own source**, not by taking
the peer's word and not by recollection: each trap and row was read in place, and all nine cited
export names were confirmed to exist with `grep -E '^export (const|function|async function)'`. That
matters because the failure this register prevents is *recording a dependency that is not real* -
which is exactly what the retraction above was.

**The last row was NOT reported by anyone.** It was found while checking the other three, and it had
been an undeclared cross-repo dependency for some time. So the count here is "four that are known",
never "four that exist".

**This table is itself a claim about another repo and will rot the same way.** Re-derive it rather
than trusting it:

```
grep -rn "VisibleGov" F:/RapidForge --include=*.md
```

## How disagreements resolve

1. **Ties break on ownership.** Lance owns both, but each project has an owning session, and the
   owner's reading of its own codebase wins. RapidForge's standing precedence over peers governs
   **sequencing and shared resources - never whose reading of a codebase is correct.** RapidForge
   corrected its own draft on exactly this point.
2. **An unsettled disagreement is UNMEASURED, not false.** Name the experiment that would settle
   it. "Unmeasured" is a state somebody can act on; "false" ends the inquiry with an assertion.
3. **Verify in the other's source before repeating a claim about it** - including a claim the other
   session made about itself.

## Why this exists: six confident wrong claims in two days, between two careful sessions

Written with the evidence rather than the principle. **These six are VisibleGov's** - RapidForge's
copy carries its own three, and the two lists do not overlap.

1. **"Blocked until 2026-09-04 12:00 CDT."** Read off a rate-limit error string, never probed. Wrong
   by ~29 hours. The drain sat idle two days; a probe wave then ran 26 agents with zero errors. It
   had propagated into `TODO.md`, `docs/EXPECTED_FAILURES.md`, three peer messages, and - via
   RapidForge repeating it to Lance - into that session's keepalive rules, where it instructed the
   instrument to SUPPRESS stall reports until a moment that did not matter.
2. **"`resumeFromRunId` spends no new agent tokens."** Asserted from the harness's description of
   the flag. Measured afterward from agent transcript mtimes: **38 of 51 agents re-ran, 74.5%,
   corroborated by cost at 74.7%.** Stated during a pause Lance called specifically to redirect
   token budget.
3. **"The billed scheduler fails daily at 06:00 with `skipped-prices-unverified`."** It had left no
   trace at all since 08-31 - no run row and no log line - because the skip happens before
   `openRun`. **The doc prescribed telling that failure from a real one by the run row's detail
   string, which the expected path structurally cannot produce.** Four states collapsed into one
   silence.
4. **"HB 903 has failed four times identically; park it as structural."** SQL drafted, put to
   Lance, withdrawn. It published on the fifth attempt. The failure was stochastic - two blind
   provisions runs disagreeing - and a later wave published six of six drafts that had each already
   failed two passes.
5. **"Fresh authoring converts at ~17%."** Then revised to ~50%. Actual on the 2025 backlog: 100%,
   twelve bills in nine minutes. Generalised three times in one night from whichever slice of the
   queue was in front of me.
6. **"The suite is red because of the uncommitted directory feature."** It was not. A guard I had
   committed three days earlier fired on the calendar with no diff to point at, and another agent's
   correct work would have been reverted.

**Three of RapidForge's own instances were it repeating VisibleGov rather than making its own
error.** That asymmetry is the argument for the protocol: **a peer's reasoning is a claim like a
peer's number, and this fleet verifies numbers.**

**The header for the whole class:** *well-argued is the disguise that gets past a verifier tuned for
numbers.*
