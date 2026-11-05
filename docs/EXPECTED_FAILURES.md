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

## Currently green - re-verified 2026-11-05

| Instrument | Exit | Note |
|---|---|---|
| `npm run verify:migrations` | **0** | 40 probed, **30 applied, 0 MISSING**, 10 `unverifiable` because Tier 2 (`SUPABASE_DB_URL`) is off - a reported non-result, not a failure, and it does not affect the exit code |
| `node --test` | **0** | **2,883 pass / 0 fail**, in a clean shell (2026-11-05) |
| `npm run check:ingest` | **1** | **RED from 2026-11-04 - see entry 3.** `us-senate` BROKEN on an upstream 403; the other four sources are ok. This is the one currently-red instrument and it is declared below. |

**Entry 1 (the price guard) is CLOSED as of 2026-10-20** - funding arrived, prices were re-checked
and all three were unchanged, so the guard was cleared by its own stated condition. **It re-arms
2027-01-01**, which is the design and will not be a defect when it happens.

**One instrument is currently red: `npm run check:ingest`, declared as entry 3** (us-senate, upstream
403 from senate.gov, first seen 2026-11-04). Everything else is green. Per the rule above: anything
red and NOT listed here is a real failure.

**Entry 4 is open and NO instrument reports it** - that is the point of listing it. Appropriations
bills blow `max_tokens` and are retried by the billed scheduler every tick, which costs money and
leaves every instrument green, because a paid retry of an impossible bill is not a failure of
anything that gets checked.

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

## 3. `us-senate` ingest BROKEN from 2026-11-04: senate.gov returns 403 for its own roll-call XML

**Symptom.** `npm run check:ingest` reports `BROKEN us-senate - 5 consecutive failed runs`, and the
`ingest.yml` GitHub Actions job exits 1 on every run because of it. Individual runs fail with
`SourceFetchError: HTTP 403 from us-senate:
https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_2.xml`.

**Last successful run: 2026-10-23T09:30:13.** 228 failed runs after it as of 2026-11-04.

**Cause: UPSTREAM, and it is not us.** Measured 2026-11-04 from two unrelated networks - the
operator's residential IP and Anthropic's WebFetch infrastructure - with identical results:

| URL | Result from BOTH networks |
|---|---|
| `/legislative/LIS/roll_call_lists/vote_menu_119_2.xml` | **403**, `Server: AkamaiNetStorage` |
| `/legislative/LIS/roll_call_lists/vote_menu_119_1.xml` | **403** |
| `/legislative/votes.htm` (the HUMAN-facing votes page) | **403** |
| `/` | **403** |
| `/general/contact_information/senators_cfm.xml` | **200**, `Server: Apache`, 52,531 chars of real XML |

**The 403 follows the URL, not the requester.** Three hypotheses were tested and killed:
- **Not a missing `User-Agent`.** 403 with none, with a generic one, and with a browser one.
- **Not datacenter-IP blocking.** An unrelated non-datacenter IP gets the same 403, and the one
  Actions run inspected had reported `nothing-due` for us-senate, so it never fetched at all - its
  BROKEN verdict came from historical rows, not from a runner being refused.
- **Not the operator's Cloudflare reputation ban** (he raised this, reasonably). senate.gov's blocked
  paths are fronted by **Akamai**, a different vendor and a different list.

**CORRECTED 2026-11-04, same day, by Lance's own browser.** This entry first argued the 403 read as a
senate.gov FAULT - reasoning that `/legislative/votes.htm` and `/` 403 too, that a legislature does
not forbid its own public votes page, and that an `AkamaiNetStorage` 403 usually means the object is
absent. **Lance then opened the exact URL in his browser and pasted the full, current XML.** The file
is present and is served.

**So this IS client discrimination, and the earlier reading was wrong.** The same URL, from the same
IP, returns 200 to a browser and 403 to `curl`. Akamai is distinguishing clients - almost certainly on
TLS fingerprint and header shape, which no header setting fixes - and `/legislative/*` now refuses
non-browser clients. It will NOT fix itself, and it is a deliberate anti-automation measure rather
than a misconfiguration.

**The lesson, which is the reusable part: "a human cannot load it either" was an INFERENCE from curl's
403, not an observation of a human loading it.** One person with a browser falsified a paragraph of
confident reasoning in a single message. A claim about what a human sees needs a human, or at least a
browser engine - PLAYBOOK 71's shape again, the instrument that cannot see the path being asked about
the path.

**NO WORKAROUND IS TO BE BUILT, and this is a standing instruction - which matters MORE now that a
browser is known to work, not less.** The correction above establishes that a sufficiently
browser-shaped client would get the data. That is precisely the reason not to build one. An attempt to
probe the blocked path with a spoofed browser header set was correctly refused by the harness as
bot-check circumvention. That refusal is endorsed here, not merely recorded: **this project's entire value is
being above reproach about its sources.** Defeating a public institution's access controls to obtain
civic data would be self-defeating even if it worked, and would sit badly beside the one
non-negotiable. If the files are genuinely restricted now, the answer is to ask the Senate, not to
evade them.

**There is NO official API alternative, verified rather than assumed.** The Congress.gov API, for
which this project already holds a key, was probed directly on 2026-11-04:
`GET /v3/house-vote/119/2` -> **200**; `GET /v3/senate-vote/119/2` -> **404**; `GET /v3/vote/119/2`
-> **404**. The API covers House votes only, which is precisely why this project reads senate.gov at
all. Its README defers coverage questions to congress.gov/help/coverage-dates and refers data gaps to
"data partners in the House and Senate".

**A LEGITIMATE ROUTE EXISTS, and it is Lance's call because it needs his hands.** Not a workaround -
a human using a browser as a human, which is what the site now permits:

1. He opens the menu URL in his browser and saves the XML to a file.
2. The adapter ingests from that file rather than fetching it, the way
   `ingest-legiscan --dataset-file` already works for the cached LegiScan datasets.

**That capability does not exist yet for us-senate** - `--dataset-file` is a LegiScan-only flag today.
Building it is a small, honest change and it is NOT circumvention: no automated client pretends to be
a browser, and the only fetch is one a person performed themselves. **Worth building only when the
Senate actually votes again**, since the gap is currently zero; doing it now would be building for a
problem that has not arrived. Flagged so the next session does not re-derive the option under time
pressure.

**The other honest route: ask.** The Senate webmaster can be asked whether automated access to the LIS
XML is permitted and how. That is outbound contact in Lance's name, so it is his to send, never an
agent's.

**Expiry condition - what clears this entry.** Re-probe the URL. One command, free, no key:
```
curl -s -o /dev/null -w "%{http_code}
" https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_2.xml
```
`200` means the source is back: delete this entry, and expect the adapter to heal the gap on its own,
since it walks the vote menu rather than tailing from a cursor. A persistent `403` past a few weeks
makes this a question for the Senate webmaster - **Lance's call, not an agent's**, since it is
outbound contact in his name.

**How to tell this from a NEW failure.** This entry covers `HTTP 403` on `/legislative/*` ONLY. A
different status (404, 500, a timeout), a different path, or a parse error is NOT this entry - note
in particular that the 2026-09-18..26 us-senate outage looked similar at the health-check level and
had an entirely different cause (senate.gov served a redirect to a full HTML page that
`fast-xml-parser` threw on; PLAYBOOK 65). **The health check reports the same word for both. Read the
run row's `stderrTail` before assuming it is this.**

**THE DATA GAP IS ZERO, and the earlier "coverage frozen at 2026-10-23" claim here was also wrong.**
Measured 2026-11-04: our newest stored `us-senate` vote is **2026-09-30**, and the newest vote in the
live menu file is **00256, dated 30-Sep**. They match. **The Senate has not held a roll-call vote
since 2026-09-30 and we hold every one up to it** (915 votes stored). The block began after the last
vote, so it has cost nothing at all.

**What that changes: this is a LIVENESS alarm, not a data-loss alarm - for now.** Nothing is missing
today, and nothing will be until the Senate votes again, at which point we lose every vote from that
day onward. Urgency is therefore tied to the Senate's calendar, not to the clock.

**The CI job stays RED, deliberately, for that reason.** It is the only warning that will be in place
when the next vote happens. Suppressing it would mean discovering the hole after it exists rather
than before. If the redness becomes alarm fatigue, that is a conversation to have explicitly rather
than a `continue-on-error` added quietly.

## 4. Missouri APPROPRIATIONS bills exceed `max_tokens` and are retried every tick (open, found 2026-11-05)

**Symptom.** A billed `scheduled-summaries` tick records skip reasons of the form
`coverage:HB 2: hit max_tokens` or `verify:HB 19: hit max_tokens`. Per tick this looks like two or
three unlucky bills out of a hundred-odd attempted.

**It is not per-tick.** Aggregated across every tick since 2026-10-20:

| Bill | Ticks that hit `max_tokens` | First | Last |
|---|---|---|---|
| HB 2 | **10** | 2026-10-20 | 2026-11-05 |
| HB 2287 | 9 | 2026-10-23 | 2026-11-05 |
| HB 2017 | 7 | 2026-10-23 | 2026-11-02 |
| HB 19 | 2 | 2026-11-04 | 2026-11-05 |
| HB 12, HB 519, HB 1019, HB 2004, HB 2007, SB 40, SB 912 | 1 each | 2026-10-23 | 2026-11-04 |

HB 2, 5, 7, 8, 12, 15, 19 and the HB 20xx range are Missouri's **appropriations bills** - the state
budget. Their text does not fit, has never fit, and will not fit tomorrow. Every retry pays for a
full authored output that is then discarded.

**Why it is not already parked.** `skipped` is one bucket holding two different things: a failure
that might not recur, and a failure that cannot succeed. The 2026-11-04 fix deliberately stopped
parking the first kind (a completeness checker that malformed its own output is worth retrying -
`isStochasticRecordFailure`), and `max_tokens` inherited the lenient half without anyone deciding
that. A size overflow is not two samplers disagreeing; it is a property of the bill.

**The condition that clears it.** Either (a) `max_tokens` becomes a parking reason - deterministic
by cause, so it belongs in `parked_bills` with a written reason like the other structural classes -
or (b) appropriations bills get a different authoring path that does not try to summarise the whole
text at once. (a) is the small change and stops the bleeding; (b) is the only one that ever produces
a summary for the state budget, which is arguably the single most consequential bill class on the
site. **Neither is built. This entry is open.**

**Reading note for whoever picks this up:** do not re-derive the counts above from one tick. The
instrument is one `group by` over the skip reasons across ticks - the query is in `CHATLOG.md` under
2026-11-05 - because the tick that pays for the tenth attempt cannot see the first nine.
PLAYBOOK_DELTA lesson 77.

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
