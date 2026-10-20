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

## Currently green - re-verified 2026-10-20

| Instrument | Exit | Note |
|---|---|---|
| `npm run verify:migrations` | **0** | 40 probed, **30 applied, 0 MISSING**, 10 `unverifiable` because Tier 2 (`SUPABASE_DB_URL`) is off - a reported non-result, not a failure, and it does not affect the exit code |
| `node --test` | **0** | **2,850 pass / 0 fail**, in a clean shell |

**Entry 1 (the price guard) is CLOSED as of 2026-10-20** - funding arrived, prices were re-checked
and all three were unchanged, so the guard was cleared by its own stated condition. **It re-arms
2027-01-01**, which is the design and will not be a defect when it happens.

**Nothing in this file is currently red.** Per the rule above: anything red and not listed here is a
real failure.

---

## Previously green - re-verified 2026-09-05 08:1x CDT

| Instrument | Exit | Note |
|---|---|---|
| `npm run verify:migrations` | **0** | 40 probed, 30 applied, **0 MISSING**. 10 report `unverifiable` because Tier 2 (`SUPABASE_DB_URL`) is off - that is a reported non-result, not a failure, and it does not affect the exit code. |
| `npm run check:ingest` | **0** | all five scheduled sources inside their silence windows, no stranded runs |
| `node --test` | **0** | 2,802 pass / 0 fail |

`verify:migrations` was red for weeks on `0039_parked_bills`. **Lance applied it 2026-08-31 and that
entry is closed** - the first time this repo has had a clean migration board.

---

## 1. ~~`VisibleGov Scheduled Summaries` fails daily from 2026-09-01 06:00~~ CLOSED 2026-10-20

**CLOSED. The expiry condition was met, not waived.** Anthropic granted Lance $200 in API credits
on 2026-10-20, which is the funding event this entry was waiting on. Every model in `PRICES` was
then re-checked against Anthropic's published per-Mtok pricing - the part that actually clears the
guard - and **all three were unchanged**: haiku-4-5 $1/$5, sonnet-5 $2/$10, opus-5 $5/$25. The
sonnet line's "intro pricing" caveat is deleted because the intro rate did not lapse into a
different number. `PRICES_VERIFIED_THROUGH` moved 2026-08-31 -> 2026-12-31. Suite 2,834 pass /
0 fail.

**The date was NOT moved alone**, which this entry named as the one edit that would make things
worse. It moved together with the re-check, and the commit records which prices were compared
against what. **Struck through rather than deleted so the next reader can see the guard existed,
held for seven weeks, and was retired by its own stated condition** rather than by someone finding
it inconvenient.

**Consequence worth stating plainly: the daily 06:00 tick can now spend real money again**, under
its $1.00/tick + $5.00/ISO-week ledger carve-out, which `CLAUDE.md` makes the standing per-run
approval for that runner alone. Whether the Windows task is currently enabled is Lance's to check -
an agent never runs `schtasks`. `npm run status` reported the runner silent since 2026-08-31.

**Re-check `PRICES` again before 2026-12-31.** The guard will re-arm on 2027-01-01 and that is the
design, not a defect.

---

## 1a. The original entry, kept for the record

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

## 2. ~~CURRENTLY PAUSED BY DECISION~~ ~~RESUMED 2026-10-06~~ IDLE since 2026-10-06: the $0 summary wave lane

**Status as of 2026-10-20: NOT PAUSED, NOT RUNNING - IDLE for want of a session.** These are three
different states and this entry has now worn all three, so the distinction is the point. Lance
resumed it 2026-10-06: *"Start draining using subscription, I have no credits for API."* The pause he
set on 2026-09-03 is lifted and stays lifted. **But "resumed" is not a durable state for this lane:**
it IS a Claude session, so it ran while that session ran and stopped when the session ended. Last
summary published **2026-10-06**; 14 days idle at this writing, with 1,993 bills READY.

**This line said "Status: RUNNING" for fourteen days while nothing ran.** Not because anyone was
careless, but because a lane with no process boundary has no way to contradict a document that
claims it is running. `npm run status` prints `LANE IDLE` past two days, which is the only
instrument that can - **trust that over this heading.** **Struck through rather than deleted so
the record shows the pause existed, who set it, and that it was ended deliberately rather than
forgotten** - a pause that quietly disappears is indistinguishable from one nobody ever honoured.

**The distinction his instruction turns on, and it is the one most likely to be got wrong by a
session reading this cold:** the $0 wave lane does NOT use API credits and never has. It runs on his
Claude subscription through session subagents. Having no API balance does not block it. What API
credits buy is the BILLED scheduler (entry 1 above, dormant) and the gloss runner - neither of which
is this lane. A session that reads "no credits" as "no summaries" will stop work that costs nothing.

**What the pause cost while it lasted: nothing was lost.** 2026-09-05 ended at 34.0% - 1,411
published, 2,025 READY - and the lane picked up from exactly there.

**While idle for ANY reason, `npm run status` prints `LANE IDLE: the $0 wave lane needs a session to
run it` once the last publish is more than two days old.** That warning was never suppressed during
the pause, deliberately: silencing it would have made a genuine stall after the pause ended look
identical to the pause itself, which is the same trap one layer down. See the generic note below.

**A peer session's monitoring instrument reads THIS FILE and `TODO.md`'s RESUME block to decide
whether VisibleGov's silence is expected.** With the pause lifted, silence is NO LONGER expected - a
multi-day gap from here is a real finding and should be reported rather than absorbed.

## The generic note, which applies whenever the lane is idle for any reason

`npm run status` prints `last summary published ... (Nd ago)` and warns `LANE IDLE` past two days.
**That warning is not an error and nothing is broken when it appears.**

The $0 subagent wave lane has no scheduler and cannot have one of the current kind: it IS a Claude
session, so it runs only when a session runs it. It published nothing 2026-08-28 through 08-31 for
exactly that reason, and no instrument could see it, because instrumentation attaches to things with
a process boundary - an exit code, a cron entry, a budget - and this lane offers none.

The warning exists so the idleness is a number on day one instead of a discovery on day four. Whether
the lane SHOULD run unattended is an open question for Lance, recorded in `TODO.md`.
