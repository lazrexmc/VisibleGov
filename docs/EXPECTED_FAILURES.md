# Expected failures

*What is known to fail, why, and the condition that clears it. Standard rule 8. Created 2026-08-31
17:5x CDT.*

**Why this file exists.** A failure that happens every day stops being read. Once an instrument is
red every morning, a session opening the repo in October cannot tell the known cause from a new one
that broke last week - three different causes, one identical symptom. This file is the difference
between a task nobody stopped and a task somebody decided about.

**The rule this file obeys:** anything red and NOT listed here is a real failure. If this file is
empty, say so plainly, because "no known failures" is itself information.

---

## Currently green - re-verified 2026-09-05 08:1x CDT

| Instrument | Exit | Note |
|---|---|---|
| `npm run verify:migrations` | **0** | 40 probed, 30 applied, **0 MISSING**. 10 report `unverifiable` because Tier 2 (`SUPABASE_DB_URL`) is off - that is a reported non-result, not a failure, and it does not affect the exit code. |
| `npm run check:ingest` | **0** | all five scheduled sources inside their silence windows, no stranded runs |
| `node --test` | **0** | 2,802 pass / 0 fail |

`verify:migrations` was red for weeks on `0039_parked_bills`. **Lance applied it 2026-08-31 and that
entry is closed** - the first time this repo has had a clean migration board.

---

## 1. `VisibleGov Scheduled Summaries` fails daily from 2026-09-01 06:00

**Symptom.** The Windows Scheduled Task runs at 06:00 and the run reports
`skipped-prices-unverified`. It fails before opening a run row and before any network call, so it
costs nothing and writes nothing.

**Cause.** `src/lib/billed-summary-chain.js` carries `PRICES_VERIFIED_THROUGH = '2026-08-31'`. The
sonnet entry was intro pricing, declared in a comment, with nothing enforcing the declaration. A
stale price fails in the EXPENSIVE direction - the entry still exists, so `priceOf` returns happily,
the cost tracker under-counts real spend, and the $5.00 weekly cap silently stops being the cap.
`assertPricesFresh` now refuses to start a billed run past the verified date.

**This is chosen, not neglected.** Lance decided on 2026-08-31 to leave the task registered and
running rather than disable it, and to revisit later. He is also routing summary work through his
Claude subscription rather than API credits, so the billed lane produces little either way - it
published 1 to 4 a day against the free lane's peak of 204. Nothing is lost while this sits red.

**NOT AN OPEN ITEM - dormant until funding returns (Lance, 2026-09-05).** *"Claude set the hard
rule on pricing, we can disregard that for now until I get back to api credits."* Correct on both
counts: the guard was Claude'''s own addition, not a policy of his, and with no API balance nothing
can spend anyway, so a daily skip costs nothing. **Do not raise this at him as pending work.** It
fails SAFE - refusing to spend rather than spending at prices that may have moved - and it re-arms
by itself at the moment funding makes it matter again.

**Expiry condition - what clears it, WHEN he is funded and not before.** Re-check every model in `PRICES` against Anthropic's
published pricing, correct any that moved, then move `PRICES_VERIFIED_THROUGH` forward. **Moving the
date alone is the one edit that makes this worse than the comment it replaced**, because it
re-arms the guard while leaving the prices wrong.

**How to tell this from a real failure.** The tick appends a line containing `prices unverified`
to that day's file under `.superpowers/artifacts/summary-scheduler-logs/`. **Check there, NOT
`ingestion_runs`** - the skip happens before `openRun`, deliberately, so it writes no run row at
all.

**CORRECTED 2026-09-04.** This section previously said to tell the two apart by the run row's
detail string. **That was impossible: the declared failure produces no run row.** Between 08-31 and
09-04 the summary scheduler left no trace of any kind - no run row and no log line - while this
document asserted a daily skip that no artifact could confirm. A tick that ran and skipped was
indistinguishable from a task that had been disabled, crashed at startup, or never fired. **An
expected absence that produces no evidence disarms the very check meant to tell it from a real
one.** The skip path now logs, and a test asserts it. **Before 2026-09-04 there is no evidence
either way and none should be inferred.**

A genuine failure still looks different: an exhausted credit balance surfaces as a billing error
from the API, and anything else leaves a run row, which this entry never does. **A day with no
`prices unverified` line and no run row means the task did not run - that is a real finding, not
this entry.**

---

## 2. CURRENTLY PAUSED BY DECISION: the $0 summary wave lane

**Status: PAUSED. Decided by Lance. Effective 2026-09-03 08:06 CDT.**
**~~EXCEPTION, 2026-09-04: one wave authorized~~ CLOSED 09:23 CDT.** Lance authorized one wave -
*"make one wave of drain then pause"*. W27 ran and was recorded: **11 of 12 published**, completion
33.3% -> 33.7%, 1,046 of 3,108, review backlog 40 -> 29. **The exception is spent and the pause is
again unqualified.** The status line was never flipped to ACTIVE during it, so nothing downstream
needed to change back.

**Reason for the pause:** other projects on this machine should get the token budget for now. **Nothing is broken.** The lane ran successfully
the same morning - 6 of 6 published at 07:32 - and stopped because it was told to.

**This entry exists because a pause that is a DECISION and a pause that is a FAULT are
indistinguishable from the outside, and only one of them should be undone on initiative.** A
session finding an idle lane cannot tell them apart; restarting a deliberate pause spends budget
the operator deliberately redirected, and mistaking a real stall for a pause means the work stops
silently. The decider and the DATE are both recorded above on purpose - a pause with a decider and
no date is present-but-not-true, since a three-week-old pause and a three-hour-old one are
different facts that look identical.

**A peer session's monitoring instrument reads THIS FILE and `TODO.md`'s RESUME block to decide
whether VisibleGov's silence is expected, and stays quiet if either says paused.** So this entry is
load-bearing outside the repo: while the pause lasts it must stay here. If the drain resumes, this
section goes back to being the generic note below.

**To resume:** the numbered procedure is in `TODO.md`'s RESUME block. Step 1 there is "confirm
Lance wants it resumed," because this is his decision and not a technical state to undo.

**While paused, `npm run status` will print `LANE IDLE: the $0 wave lane needs a session to run it`
once the last publish is more than two days old. That warning is CORRECT about the fact and WRONG
about the implication - it reads as a fault and this is a decision.** The warning is not suppressed
deliberately: silencing it would mean a genuine stall after the pause ends looks identical to the
pause, which is the same trap one layer down. Read it against this entry.

## The generic note, which applies whenever the lane is idle for any reason

`npm run status` prints `last summary published ... (Nd ago)` and warns `LANE IDLE` past two days.
**That warning is not an error and nothing is broken when it appears.**

The $0 subagent wave lane has no scheduler and cannot have one of the current kind: it IS a Claude
session, so it runs only when a session runs it. It published nothing 2026-08-28 through 08-31 for
exactly that reason, and no instrument could see it, because instrumentation attaches to things with
a process boundary - an exit code, a cron entry, a budget - and this lane offers none.

The warning exists so the idleness is a number on day one instead of a discovery on day four. Whether
the lane SHOULD run unattended is an open question for Lance, recorded in `TODO.md`.
