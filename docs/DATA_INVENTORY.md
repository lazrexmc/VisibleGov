# What VisibleGov Actually Has

**Status of this document:** source of truth for **structure and meaning**.
**Not** the source of truth for live numbers - see the box below.

> **SEMANTICS CHANGED SINCE THIS DOC'S LAST FULL PASS (banner added 2026-08-10).** The
> summary-campaign era (2026-08-06 -> 2026-08-10, ending at 710 published / 359 drafts / 119
> retired) invalidated three of this document's structural claims, corrected here rather than
> rewritten in place:
> 1. **"Exactly one summary row per bill" is no longer true.** The drain lane's
>    `--replace-drafts` mechanism supersedes a bill's draft with a re-authored row: the OLD row
>    is retired to `status='rejected'` with an audit note naming its replacement, and a NEW row
>    is written. A bill that went through conversion carries 2+ rows; exactly one is live
>    (published or draft).
> 2. **`status` is not just `draft`/`published`.** The live enum in use:
>    `published` (public), `draft` (held by the trust gate - every one carries a specific
>    adverse verdict or coverage miss), `rejected` (retired-superseded rows kept as audit
>    trail - NOT quality judgments about the bill), and `approved` (defined, currently unused).
>    *(Addendum 2026-08-23: the check constraint (migrations 0003/0007) also defines `stale` -
>    `summarize.js` sets it when a bill's stored text hash drifts, and `verify.js` /
>    `data-status.js` treat it as a review-queue status; `approved` and `stale` both hold 0 rows
>    in `summaries` and in `glossary_terms` today. "Every draft carries an adverse verdict" is
>    itself superseded - see item 4.)*
> 3. ~~**The "draft/flagged" line printed by `data-status.js` currently over-counts** - it counts
>    `status neq 'published'`, which absorbs the retirees (PLAYBOOK lesson 36; TODO INBOX has
>    the one-line fix).~~ **Fixed 2026-08-16 (`c9b3560`):** `data-status.js` counts
>    `status = 'draft'` (+ `stale`) and prints the retirees on their own line; the old `neq` lens
>    survives only as a reconciliation field in its JSON report. Open drafts = `status = 'draft'`
>    only.
> 4. **(Added 2026-08-23) The campaign-era close-out numbers above are themselves superseded.**
>    The $0 drain lane ran to empty 2026-08-22 (commit `3a93fe1`), and the registered daily 06:00
>    Windows task "VisibleGov Scheduled Summaries" (`scripts/scheduled-summaries.js`) is now the
>    ONLY ongoing writer of `summaries` (plus their verification and note rows, and - through
>    `summary-queue.js`'s `persistReferencedTermsGracefully` - new `glossary_terms` stubs for any
>    law a new summary cites): code-enforced
>    $1.00/tick + $5.00/ISO-week caps, with the spend ledger kept as `ingestion_runs` rows
>    (source `scheduled-summaries`; the queue planner it calls records its own rows as
>    `summary-queue-record`). The "overflow-parked (unpaid, auto-expiring)" line counts
>    `.superpowers/artifacts/scheduled-summaries/overflow-parks.json` - a DIFFERENT and much
>    narrower thing: bills whose output overflowed `max_tokens`, keyed by bill + text hash, skipped
>    before any paid call, and released automatically if the text or the stage allowance changes.
>    They are NOT human judgements and need no unparking. They ARE still inside "READY to
>    summarize" above (`docs/EXPECTED_FAILURES.md` entry 4 says why that is left as Lance's call).
>    The "parked (structural failures)" line `npm run status` prints
>    counts `.superpowers/artifacts/scheduled-summaries/parked.json` - bills whose authoring
>    failed structurally (a `MalformedSummaryError` from the record step - the authored envelope failed the mechanical
>    shape checks and was never written - or a park seeded with a written reason from the drain
>    lane's PARKED set by `scripts/seed-scheduler-parks.mjs` or the tiny-bill stopgap class by
>    `scripts/park-tiny-fresh-bills.mjs`) and that every future tick skips. Consequence for item 2: `status='draft'` now
>    mostly means PARKED-with-reason rather than "adverse verdict awaiting re-author"
>    (2026-08-23: ~32 open drafts, 31 of them parked). Magnitude today: ~1,100 published /
>    ~30 draft / 600 retired over ~1,700 rows - run `npm run status` for the live figures.
> The dated snapshot counts below (115-published era) are otherwise left as the historical
> ratios they were always framed as; run `data-status.js` for anything current.

---

## READ THIS FIRST: counts go stale, structure does not

The database is **actively written to on a schedule** - this sentence originally read "by a cron job every 30 minutes (`mo-senate-web`)", which undersells it; the actual mechanism (2026-08-23) is three things: a Windows Task Scheduler job ("VisibleGov Scheduled Ingestion") that runs `scripts/scheduled-ingest.js` every 15 minutes and each tick picks the single most-overdue of five sources and runs it under that source's own floor interval (`mo-senate-web` 30 min, `mo-house-xml` 30 min, `us-congress` ≥1 h, `us-senate` ≥1 h, `legiscan` ≥24 h - `docs/SCHEDULED_INGESTION.md`); the only literal cron, `pg_cron` refreshing the vote-aggregate matviews every 30 minutes inside Postgres (migration 0027, §6); and the daily 06:00 "VisibleGov Scheduled Summaries" task (`scripts/scheduled-summaries.js`, banner item 4) that writes `summaries`. During a 15-minute audit on 2026-07-31, the bill count, roll-call count and vote-cast count all changed underneath the auditor. Any count typed into a document is wrong within half an hour.

So there are two kinds of truth here, and they live in two different places:

| Question | Answer lives in |
|---|---|
| "How many bills / votes / vote casts do we have **right now**?" | `node --env-file=.env scripts/data-status.js` |
| "What *is* a bill row? Why is that number different from this one? What's missing and why?" | **This document.** |

**The counts printed below are a snapshot from 2026-08-03 (re-verified against the live database via `node --env-file=.env scripts/data-status.js` plus direct Supabase REST count queries for everything that script doesn't print; supersedes the 2026-08-02 snapshot) and exist only to show you the shape and the ratios.** Treat them as "about this many," never as current fact. Do not copy them into other docs - that is exactly how the confusion started.

**Re-verified again 2026-08-03, later the same day, after the comprehensive accuracy audit (`docs/audits/2026-08-03-comprehensive-accuracy-audit.md`) and its live corrections landed** - independently re-queried via the same two methods (`data-status.js` plus direct REST count/anon-key probes), not copied from the audit report or from `TODO.md`. Five things moved since the morning snapshot above and are corrected throughout this document: **persons 37->36 / person_links 76->74** (the Pierson Sr./Jr. wrong-merge split back into two rows); **glossary_notes 266->275** (9 new edit notes from the FECA/BBEDCA and 7-corrupted-term repairs; published/draft/flagged counts themselves unchanged); **migration 0022 (vote-duplicate dedup) is now APPLIED and LIVE**, not drafted (`vote_duplicates` held 0 rows at this snapshot - later found to be a bug, not a correct zero: the senior engineering audit, later the same day, traced it to a truncated `.select()` in the backfill script that silently scanned only 1,000 of 8,221 legiscan votes; the corrected live run found 59 real matched pairs, all 2018 MO Senate - see structural defect #2 for the full correction); **migration 0024 (legiscan_datasets lockdown) is now APPLIED and LIVE** (structural defect #10 below is resolved); **vote_reconciliation_flags open count 49->61** (grew during the audit's own read-only queries, which is expected - MO ingestion never stopped). The MO House per-legislator cast-completeness gap (new structural defect #11 below) turned out to be structural, not temporary, superseding this document's older "casts arriving later" framing.

**Correction pass 2026-08-05 (only the items that structurally changed, not the volatile counts):**
the site is now DEPLOYED and live at https://visiblegov.pages.dev; **all 32 migrations (0001-0031)
are applied** (0030 revoked a stray `authenticated` grant, 0031 rewrote the public views' anti-join
to `NOT EXISTS` after an anon timeout on deploy night); **all 4 identity flags are now resolved
(0 open)**; **SB 914 was adjudicated** ("trust senate journals") so it no longer double-counts, and
a general `reconcile-flag` tool now exists; open `vote_reconciliation_flags` is now ~107 (this queue
grows as ingestion surfaces more cross-source discrepancies - expected, not a defect) *(~364 at
2026-08-23, mostly one journal-coverage class - see the next correction pass and the Operations
table)*. Wherever the
2026-08-03 body below says "4 open identity flags," "SB 914 unresolved," or "61 open recon flags,"
read this correction instead.

**Correction pass 2026-08-23 (a docs audit against the live database; again only what structurally
changed - every count here is dated, and `npm run status` outranks it):** **migration 0032
(`votes.vote_date_provenance`) is DRAFTED, NOT applied** - 33 migration files now exist, the column
does not exist live (verified by query), and until Lance applies it `ingest-legiscan.js` refuses
every derived-date 2024 MO House roll call (`datesDerivedGated` in the run detail, run closes
`partial`) - see GAP 1; **the MO Senate journal `bill_refs` quarantine class was root-caused and
fixed** (commit `5ced4eb`; `public_freshness.quarantined_days` reads 0, down from a peak of 20) and a
separate 52-day 2018 journal backlog was found (GAP 5); **open `vote_reconciliation_flags` is ~364**,
dominated by a journal-coverage class rather than by tally disagreements (Operations table);
**`persons` 38 / `person_links` 78 / 1,529 unlinked rows -> 1,567 distinct people**, all 16
identity flags resolved; **the glossary is ~16× larger than §5's snapshot in published entries (116 -> ~1,858; rows 2,219 -> ~7,344)** after two billed
Batch-API drains on 2026-08-21/22 (§5 carries the live shape); **summaries are ~1,100 published**
(banner item 4). Wherever the 2026-08-03 body below says "4 open identity flags," "36 persons,"
"116 glossary entries," "12 quarantined days," or "all 32 migrations applied," read this correction
instead.

Three counts move constantly and must **never** be hardcoded anywhere: `bills`, `votes`, `vote_casts`.

---

## The 30-second version

VisibleGov holds **a very strong voting record and a small but rapidly-growing explanation layer.**

- We have **every recorded roll-call vote within the covered years** (MO House 2015->, MO Senate 2016->, US Congress 2025-> - except MO House 2024, and with 52 MO Senate 2018 journal days not yet ingested from the primary source; see "The year gaps") *(qualifier added 2026-08-23 - this bullet originally read "every recorded roll-call vote for the Missouri legislature back to 2015", which the doc's own gaps contradict)* - about **1.47 million individual legislator votes** across roughly **10,032 roll calls** (was ~10,022 at 08-02 - MO ingestion is the only thing still moving this number; US House and US Senate roll-call counts are byte-for-byte unchanged again this pass, same as 08-02) *(superseded 2026-08-23: ~10,600 roll calls; the US Senate HAS moved since - 890 roll calls, last 2026-08-08 - while the US House is genuinely unchanged at 645, last 2026-07-23)*. Within the years covered, this is essentially complete: on an average roll call we have a position recorded for ~157 of Missouri's 163 House members and 100 of the US Senate's 100.
- We have **~38,254 bills**, but most bills never get a floor vote. About **3,341** got a passage vote - those are the ones that matter for holding someone accountable. This number, and the entire bill/summary funnel below it, is **byte-for-byte unchanged from the 08-02 snapshot** - re-verified live, every stage matched exactly (38,254 -> 3,870 -> 3,341 -> 3,319 -> 197 -> 107/115). Growth since 08-02 is entirely in vote-volume tables (`votes`, `vote_casts`, `bill_actions`, `ingestion_runs`), not in bills or summaries.
- We have the **official text** of about **3,630** bills.
- We have a **plain-language summary published for 115 bills** (out of 213 summary rows total). That is the product's core promise, and while it is still a small slice of all bills - 0.30% - it has grown nearly 3× since the 2026-07-31 snapshot (was 39) and is **no longer concentrated in just 2 sessions**: published summaries now span 12 of our 32 legislative sessions (see "The concentration problem" below for the honest remaining skew). *(Superseded 2026-08-23: ~1,094 published / 32 draft / 600 retired over ~1,726 rows; 793 of the 3,343 accountability-set bills - 24% - carry a published summary, ~2,500 more are text-ready, and 15 of 32 sessions carry at least one; the daily scheduler (banner item 4) is the ongoing writer. `npm run status` for today's figures.)*
- **New this pass: every published bullet now carries a clickable exact-quote citation back to the bill text.** Migration 0021 (bullet-citation exposure) is confirmed fully live - re-verified live via `node --env-file=.env scripts/probe-public-surface.js`: the `citations` column on `public_verification_notes` is present, correctly gated on `overall='clean'`, and shape-checked against all 220 real rows with **0 violations**. `trust.html`'s receipt claim ("the exact quoted excerpt it came from") is now literally true for bill-summary bullets, not just glossary terms.
- We can identify **~1,569 distinct legislators** (was ~1,568 as of the morning snapshot - the Pierson Sr./Jr. wrong-merge split back into two correctly-separate humans this pass, net +1 to this count) *(2026-08-23: 1,567 - 1,529 unlinked rows + 38 merged persons; two more humans were unified since)*, but **555 of them have no votes on file** (386 carry a federal `bioguide_id`, mostly historical US senators/House members whose service predates our federal coverage window; 169 are Missouri-sourced), and **none of them have a photo or contact info** (by design - see the structural-defects note below). The no-votes/no-photo figures re-verified live, exact match to 08-02; only the distinct-people total moved, and only because of the Pierson split.

The short version of the honest gap: **if you look up a legislator, you'll almost certainly see a real voting record, and if you click one of those votes hoping for a plain-language explanation with a receipt, the odds are much better than they were a few days ago - but it's still a minority of votes.** The vote-aggregate double-counting risk described in earlier snapshots of this document is resolved - but not the way this document first said. Migration 0022 is applied and live; the backfill's original zero-match result was itself a bug (a truncated `.select()` in `runCorrectVoteDuplicates`, found by the 2026-08-03 senior engineering audit), not a correct zero. The corrected live run found 59 real matched pairs, all 2018 MO Senate, now excluded from every public vote-aggregate matview (see structural defect #2). The honest gap that remains is a structural MO House per-legislator coverage gap (structural defect #11) - not a systemic double-counting problem anymore.

---

## The relationships - why so many different numbers all mean "how much data do we have"

This section is the reason this document exists. None of these numbers contradict each other. They count **different things**.

### 1. The bill funnel

Each layer is a subset of the layer above it *except where noted*. Percentages are of all bills.

```
 38,254   bills in the database                      100%
          ↓  (−34,384)  most bills are introduced and die without a recorded floor vote
  3,870   bills with ≥1 recorded roll call of any kind  10.1%
          ↓  (−529)     these only ever got procedural votes, not a vote on passage
  3,341   bills with a PASSAGE / third-reading vote      8.7%   ← the accountability universe
          ↓  (−3,144)   the summarization pipeline hasn't reached the rest yet
    197   passage bills with any summary                 0.5%
          ↓  (−90)
    107   passage bills with a PUBLISHED plain-language summary   0.3%
```

**One number the funnel above doesn't show: total published summaries is 115, not 107.** 8 published summaries sit on bills that never got a passage/third-reading vote by the funnel's own text-matching definition (a procedural-vote-only bill, or a passage vote whose recorded `question` text didn't match the passage/third-reading pattern). 115 published + 98 draft = 213 summary rows total.

And running alongside, not inside, that funnel:

```
  3,630   bills whose official text we have stored        9.5%
```

**The four traps in that funnel:**

- **"Bills with text" is not a stage of the funnel.** Text is only ever fetched for a bill that *already has a vote* - verified: zero text-bearing bills lack a vote. So text ⊂ voted. But text is **not** a subset of *passage*: 311 text-bearing bills have a vote that isn't a passage vote. Text (3,630) and passage (3,341) **overlap**; neither contains the other.
- **The famous "99.3%" figure has a small denominator.** 3,319 of 3,341 passage-vote bills have text = 99.3%. That is *not* 99.3% of bills. Text coverage across all bills is **9.5%**.
- **3,341 is not a Missouri number.** It is Missouri 3,177 + federal 164 - unchanged from the 2026-07-31 snapshot, re-verified live. (An earlier README labelled it "Missouri" - wrong.)
- **213 summary rows, 115 published.** ~~There is exactly one summary row per bill, so "summaries" and "bills with a summary" are the same number.~~ *(Struck 2026-08-23 - false since the drain lane's `--replace-drafts`, banner item 1. Live: ~1,726 rows over 1,126 bills, 479 bills carrying 2+ rows, 0 bills with more than one live row - so "published summaries" and "bills with a published summary" still coincide; "summary rows" no longer does.)* The other 98 are drafts (see §"draft ≠ flagged" below - as of this pass, every one of those 98 carries an adverse verdict; nothing clean is sitting unpublished).

**Why federal and Missouri sit at opposite ends of the funnel:**

- **Federal bills only exist in our database because a roll call referenced them.** All 482 federal bills have a vote (up from 478 - 4 more federal bills entered the database since 07-31, all via a roll call, same pattern). This is *not* a corpus of the 119th Congress - it is "bills that were voted on."
- **Missouri is the inverse.** ~37,772 Missouri bills came from LegiScan's bulk datasets, and only 3,388 of them (9.0%) ever got a recorded roll call.

Those two facts are why a single "% of bills with a vote" number is meaningless without saying which jurisdiction.

### 2. `votes` vs `vote_casts` - the 10,022 vs 1.47-million confusion

- **`votes` (~10,032)** = **roll calls**. The *event*: "the Missouri House voted on HB 1234 on 2026-03-04."
- **`vote_casts` (~1,466,730)** = **one legislator's position on one roll call**. Rep. Smith voted Yea.

A doc saying "10,022 votes" and a doc saying "1.47 million votes" are both correct and are describing different things. Use the words **roll calls** and **vote casts** and the ambiguity disappears.

Note also: 445 roll calls have no bill attached at all (444 US Senate, 1 US House - nominations, cloture, adjournment) *(451 at 2026-08-23: 450 US Senate, 1 US House)*. They are legitimate votes with nothing to link to.

### 3. Legislator ROWS vs PERSONS - the one that caused the most confusion

**Every legislator in the database is fully identified. `persons` is not a roster.**

Here is the actual model:

- **`legislators` (~1,607 rows)** - one row per legislator **per source system**. Every single row carries a real identity key from its source: a `bioguide_id` (Congress), a `legiscan_people_id`, an `mo_senate_id`, an `mo_house_id` or an `openstates_id`. **Zero rows are unidentified.** This is the roster.
- **`persons` (36 rows, was 37)** - a person row is created **only when two or more legislator rows are proven to be the same human**. It is a *merge record*, not a profile.
- **`person_links` (74 rows, was 76)** - the edges connecting merged rows to their person.

So, in plain language: **most legislators appear in exactly one source, so they need no unification and correctly have no `persons` row.** A `persons` row is the exception, created for the ~74 rows where one human showed up in more than one source system - e.g. Robert F. Onder appears four times (LegiScan, MO Senate, Congress's bioguide, OpenStates) and is unified into a single person carrying all 1,850 of his casts.

**The counts above moved on 2026-08-03: the comprehensive accuracy audit caught `persons` doing the opposite of Onder's case.** Tommie Pierson Sr. and Tommie Pierson Jr. - father and son, both Missouri House District 66, different eras (2013 vs 2017+), distinct `legiscan_people_id`s (15900 vs 18826) and cleanly non-overlapping vote years (1,190 casts 2015-2016 vs 2,157 casts 2017-2020) - had been auto-merged into one person with empty seat evidence on both sides. `correct-data.js pierson-split` (live, verified) deleted that person row and both `person_links` rows and nulled `person_id` on both legislator rows, live-reconfirmed this pass: both Pierson rows now carry `person_id: null`. Onder shows the mechanism working correctly (one real human, several source rows, unified); Pierson showed it failing (two real humans, wrongly unified) - the split is why `persons` went down by 1 and `person_links` down by 2 while the distinct-people total (below) went **up** by 1, not down: two real humans are now counted as two, not one. A same-source-key contradiction guard (`person-identity.js`'s `finalPairStatus`) now checks for this pattern - two rows sharing a person but disagreeing on the same per-person source id - before even seat evidence, so this class shouldn't recur silently.

**"36 legislators identified" is a misreading. The correct count of distinct humans is:**

```
1,533  legislator rows with no person link (each = one distinct human, fully identified)
+  36  merged persons (each covering 2–4 rows, = one distinct human)
-----
 1,569  distinct people you can look up
```

(Was 1,531 + 37 = 1,568 before the Pierson split - both re-verified live this pass via direct REST count queries, not carried forward.)

~~1,569 is an **upper bound** - 4 identity clusters are still unresolved, so a few of those 1,533 may turn out to be duplicates.~~ *(Struck 2026-08-23: all 16 identity flags have been resolved - 0 open - since 2026-08-05, and the arithmetic today is 1,529 unlinked rows + 38 merged persons = **1,567** distinct people; two more humans were unified after this snapshot.)* It is never 36, and 1,607 overcounts by at least 38 (was 39).

### 4. `status` vs `verdict` - "draft" ≠ "flagged"

These live in **different tables** and mean different things:

- **`status`** is on the content row (`summaries`, `glossary_terms`): ~~`draft` or `published`~~ *(corrected 2026-08-23)* `draft`, `approved`, `published`, `rejected` or `stale` - banner item 2 for what each means; for summaries, `draft` today mostly means parked-with-reason (banner item 4).
- **`clean` / `flagged` / `complete` / `incomplete`** are **verdicts** on a *verification* row (`summary_verifications`, `glossary_verifications`).

**There is no "flagged" status.** A phrase like "98 draft/flagged summaries" collapses two axes. The real breakdown of the 98 drafts, re-verified live 2026-08-02:

| | Count | Meaning |
|---|---|---|
| Adverse verdict | **98** | 67 support-flagged only + 27 completeness-incomplete only + 4 flagged on both axes. Genuinely needs review. |
| Clean, not yet published | **0** | - |
| Never verified | **0** | - |

**This is a change in kind, not just in scale.** The 2026-07-31 snapshot had 14 clean-but-unpublished drafts and 1 never-verified draft - a real backlog. That backlog was cleared in a 2026-08-02 review-queue pass (see `TODO.md` NOW section): every draft with a clean verdict on both axes auto-published, and the trust model's auto-publish gate now runs to completion instead of leaving clean items sitting in draft. **The result: every summary still in draft status carries an adverse verdict, and every published summary carries zero adverse verdicts - nothing sits in an ambiguous middle state.** The gate held, and now it's also caught up.

The glossary is the one asymmetric case: **8 of 116 published glossary terms carry a flagged verdict.** Those were hand-adjudicated (28 `edited` as of 2026-08-03, was 19 - 9 new this pass from the accuracy audit's corrections + 2 `rejected` actions are recorded) rather than auto-published - consistent with the trust model, but it is a real difference from the summary pipeline and should not be assumed away. *(Restated 2026-08-23: still exactly those 8 - but now 8 of 1,858 published terms. The two Batch-API glossary drains (§5) auto-published only verified-CLEAN glosses; their ~419 FLAGGED glosses sit in `draft` awaiting Lance's review, never published as-is, so the glossary gate now behaves like the summary pipeline - the asymmetry is those 8 hand-adjudicated legacy rows and nothing newer.)*

### 5. Glossary terms vs glossary *entries*

*(The three bullets and the closing line below are the 2026-08-03 snapshot, kept as history. The live shape - roughly 16× more published entries (116 -> ~1,858) after two billed glossary drains on 2026-08-21/22 - follows them, dated 2026-08-23.)*

- **2,219 `glossary_terms` rows** (was 847 in the 2026-07-31 snapshot) - statutes, acts, agencies and programs that bills reference. The growth tracks the summary-volume growth directly: `extract-terms` mints a term row for every distinct citation a new summary references, and summary volume went from 74 to 213 rows over the same window.
- **116 of them are actually written** - unchanged from 07-31, no new glossing has run. The other **2,103 are bare stubs**: verified, every single one has `gloss_md` NULL *and* `source_url` NULL. They are placeholders naming a term, not unreviewed writing.
- **2,072 of the 2,103 are blocked on an unresolvable citation** - there is no official source URL to gloss *from*. That is blocked on a human mapping decision, not on review or on API spend. (98.5% of the stubs, up slightly from 96.3% at 07-31 - the backlog is growing in step with summary volume, not shrinking.)

~~"2,219 glossary terms" overstates real content roughly 19× (was ~7× at 847). Say **116 entries** - that number itself hasn't moved.~~

**Live shape, 2026-08-23** (`npm run status` prints the first line of this; the rest was re-queried directly and will drift):

- **~7,344 `glossary_terms` rows; ~2,277 written (`gloss_md` present); ~1,858 `published`.** The stub definition above still holds exactly: every one of the ~5,067 unwritten rows has `gloss_md` NULL *and* `source_url` NULL.
- **~4,964 of those stubs are `needs_mapping`** - the extractor could not resolve the citation to an official source, so there is nothing to gloss *from*. That is the curation backlog (a human mapping decision), not errors and not API spend; it still dominates at ~98% of stubs.
- **The mappable remainder is TWO queues, and `npm run status` used to print them as one number (fixed 2026-08-27).** Splitting on whether a gloss was ever written: **427 are authored, verified, and FLAGGED** - the verifier raised an objection and the runner never publishes a flagged gloss, so these are Lance's review queue; **396 have a resolved citation but NO gloss text at all** - nobody has written them, so they need a billed gloss run under per-run approval, not his eyes. (2026-08-27 counts: 359 RSMo + 37 U.S.C.) The unauthored pile GROWS every time summaries publish - 307 of the 396 were minted overnight 2026-08-26/27 by the +99 summary run, because new summaries cite statutes nothing has glossed yet. **This is a standing consequence of publishing summaries, not a backlog that drains once.**
- **Two reporting traps this same line taught (both fixed 2026-08-27):** the figure was computed as `total − published − needs_mapping` rather than counted, so all **47 REJECTED** terms were reported to the operator as work awaiting his review; and summing the two queues above told him 870 when his actual queue was 427. **A queue number must be COUNTED with the predicate that defines the queue** - derive it by subtraction and every status you did not think of lands in it silently.
- **What the `needs_mapping` pile ACTUALLY contains - measured 2026-08-27, never characterized before.**
  The line is labelled "curation backlog," which reads like a queue somebody could work through. It is
  not one queue, and **the majority of it cannot be glossed at all under trust model v3.** A gloss
  needs a receipt - a verbatim quote from official text - so a term with no citation has no source to
  quote and is structurally ungossable, not pending. Of 5,328 rows:

  | Bucket | Rows | Can it ever be glossed? |
  |---|---|---|
  | `agency` + `program` names ("Office of the Attorney General", "Fast Track Workforce Incentive Grant Program") | **2,784 (52%)** | **No** - no citation exists to fetch official text from |
  | named `act`s ("Megan Meier Act") | 836 | Only via a name->citation lookup nothing implements |
  | MO compound / range / chapter-level cites ("sections 302.302 to 302.309", "chapter 303") | 831 | **Yes, with a parser upgrade** - `parseMoCitation` handles single sections only |
  | U.S.C. cites ("26 U.S.C. Section 103") | 199 | **Yes** - `src/adapters/uscode.js` already fetches these |
  | `public_law` ("Public Law 118-42") | 153 | Needs a GovInfo adapter that does not exist |
  | Missouri Constitution ("Article I, Section 15") | 77 | Needs a constitution source |
  | bill references mis-typed as acts ("house bill no. 117") | 9 | Resolvable against our OWN bills table |
  | unclassified statute-kind remainder | 439 | Unknown |

  **`parseMoCitation` rejects 5,305 of 5,328** - so re-running the normalizer converts ~10 rows, not
  thousands, and the 2026-08-27 run did exactly that (10 updates, 13 merges). **The genuinely
  recoverable-by-code subset is ~1,030 rows** (831 compound/chapter + 199 U.S.C.), and recovering them
  makes them ELIGIBLE for a billed gloss run - it publishes nothing by itself. Everything else needs a
  new source adapter or a decision to gloss named entities from something other than statute text.
  **Do not quote 5,328 as a backlog anyone can drain.**
- **A whole class of gloss terms can NEVER be fetched, and it is not a source problem (found
  2026-08-27).** Bills routinely cite section numbers **they themselves create**. RSMo contains
  ENACTED law only, so revisor.mo.gov has nothing at that number until the bill passes and is
  codified - it serves its bot page, which this pipeline reads (correctly) as the
  nonexistent-section signal. Confirmed by joining the parked terms back to their bills:
  *"Authorizes the Missouri Child Tax Credit Act"* -> `RSMo 135.320`; *"Student Screen-Time Standards
  Act"* -> `RSMo 160.068`; *"Authorizes a tax credit for certain contraception"* -> `RSMo 135.610`.
  Every one is a section the bill would ADD.

  **This costs real time to rediscover: each such term burns a 10-minute cooldown plus one retry
  before parking.** The `--fetch-only` sweep on 2026-08-27 parked 19 this way. The cheap fix, if it
  is ever worth building, is to check the citation against the bill's own "to enact ... new
  sections" list BEFORE fetching and park it immediately with that reason - a bill that creates a
  section is stating, in its own text, that the section does not yet exist. Until then, treat these
  parks as CORRECT behaviour and not a fetch failure. (PLAYBOOK lesson 38: park the structural
  class with written reasons rather than paying per-instance retries.)
- **47 rows are `rejected`:** RSMo sections for which revisor.mo.gov served its bot page twice, 10 minutes apart at 5-second pacing - the nonexistent-section signal (rate limiting would have cleared) - parked with a `glossary_notes` row carrying the evidence; unpark by setting `status` back to `draft` if the section appears. Not quality judgments.
- **Two sources, one pipeline (trust model v3, unchanged):** Missouri statutes (RSMo, fetched from revisor.mo.gov by `src/adapters/mo-statutes.js`; `src/cli/backfill-mo-glossary-citations.js` first normalised and de-duplicated the stored RSMo citations so `needs_mapping` stubs could become mappable) and the U.S. Code (`src/adapters/uscode.js`). `scripts/gloss-batch-mo.mjs --source mo|usc` is the drain runner: Haiku authors -> mechanical gates (verbatim quote, non-empty) -> one retry -> Sonnet escalation -> Sonnet adversarial verification -> the shared verdict gate, every billed call through the Message Batches API, checkpointed per phase and resumable; it persisted 1,217 RSMo glosses ($12.45, 2026-08-21) and 525 U.S.C. glosses ($8.31 against an $8 cap on 2026-08-21/22 - disclosed; the runner now projects each batch's cost from the banked text before submitting, PLAYBOOK lesson 44). `src/cli/auto-publish-glossary.js` (zero model calls) moves any draft whose latest verification derives CLEAN through `approved` -> `published`. All four appear as sources in the freshness table.
- **What a reader sees:** a published gloss renders inline where the summary's marking can place it, and otherwise in the bill page's collapsed "Referenced laws and terms" list (`site/js/glossary-inline.js`, `renderReferencedLaws`) with its full receipt. At the 2026-08-21 measurement ~649 of ~1,045 published summaries showed at least one gloss.

Say **"~1,850 published entries of ~7,300 terms"** - and say the date.

### 7. `vote_duplicates` vs `retracted_votes` - hidden vs removed, and why the difference matters

Both exist because a vote row turned out not to belong where it was. They are **not**
interchangeable, and choosing the wrong one leaves a false claim in the database.

| | `vote_duplicates` (213) | `retracted_votes` (714) |
|---|---|---|
| The defect | a REDUNDANT copy of a real vote, on the RIGHT bill | the `bill_id` is WRONG - the bill never held this vote |
| What happens to the row | stays in `votes`; public views exclude it | **deleted** from `votes`, casts deleted too |
| How it is recorded | a marking row naming canonical + superseded | a tombstone carrying the COMPLETE cast list as jsonb |
| How to undo | delete the marking row | replay the tombstone's preserved casts |
| Migration | 0022 | 0033 |

**Why hiding is wrong for a misattribution:** a suppressed row still asserts, in the base table,
that a bill held a vote it never held - queryable by anything that does not join the exclusion
perfectly. The relationship has to go, not just its visibility.

**Why a tombstone rather than a bare delete:** a retraction rule can be wrong, and on 2026-08-26 one
was - an earlier dedup rule was applied and 17 of its 38 pairings were false, hiding real votes.
Recovery was possible only because that design was non-destructive. The tombstone preserves every
cast so a retraction replays backwards row-for-row.

`npm run status` prints both under **REPAIR LEDGER**. `votes` alone stopped telling the whole truth
the day rows began being hidden and removed.

### 6. Materialized views are snapshots, not tables

`public_position_totals`, `public_party_alignment` and `public_party_position_totals` are **materialized views** - frozen aggregates that only match the live tables after a refresh runs.

**This is where the stale docs came from.** The figure "1,465,102 vote casts" that appeared in `README.md` and `docs/ARTIFACTS.md` is *exactly* the sum of `public_position_totals` - a stale snapshot, not the vote_casts table. The gap used to grow with every cron tick (measured at 198, then 231, within one audit).

**The refresh mechanism itself was broken, in three separate layers, and is now fixed (2026-08-04).** `npm run refresh:aggregates` calls `refresh_vote_aggregates()`, which runs `REFRESH MATERIALIZED VIEW CONCURRENTLY` on all three matviews. Migration 0026 (2026-08-03) fixed a slow-query regression and restored a healthy ~19s baseline - but a fresh outage started the same day, right after the vote-dedup backfill fix gave `vote_duplicates` its first 59 real rows, and took three more root causes and three more migrations to fully resolve:

- **Layer 1 - Supabase edge-gateway timeout.** A synchronous REST/RPC call to `refresh_vote_aggregates()` is subject to a fixed ~120-125s ceiling enforced by Supabase's own edge/gateway infrastructure (confirmed via a raw `fetch()` bypassing the SDK: HTTP 504, `server: cloudflare`, body `"upstream request timeout"`) - completely separate from the function's own 600s `statement_timeout`. **Fix: migration `0027_pg_cron_refresh_aggregates.sql`** - the refresh now runs as a native `pg_cron` job every 30 minutes directly inside Postgres, no HTTP/gateway layer in the routine path at all.
- **Layer 2 - `statement_timeout` arm-timing.** Even via pg_cron, the job still failed at ~120s with Postgres's own `canceling statement due to statement timeout`. `statement_timeout` is armed once, at the start of the top-level statement, using whatever value is ambient at that instant - the function's own `set statement_timeout = '600s'` (folded in by 0026/0027) cannot retroactively extend a deadline already fixed before the function body runs, and Supabase's `postgres` database carries a built-in 2-minute database-level default that was the real ambient value. **Fix: migration `0028_fix_statement_timeout_arm_timing.sql`** (`alter database postgres set statement_timeout = '600s'`).
- **Layer 3 - query-planner anti-join misestimate.** With both timeout layers fixed, pg_cron ticks still failed - now hitting a genuine 600s of real query time on `refresh materialized view concurrently public_party_alignment`. Root cause: all three matviews exclude superseded votes via `left join vote_duplicates vd on ... where vd.id is null` (added by migration 0022), and Postgres's planner catastrophically misestimated that anti-join's selectivity as 1 row when the honest answer (~10,103 votes vs. 59 real duplicates) is ~10,044 - cascading into Nested Loop joins across the whole downstream plan instead of Hash Joins. **Fix: migration `0029_fix_vote_duplicates_antijoin_planner_misestimate.sql`** - rewrote the exclusion as `not exists (...)`, which the planner estimates correctly.
- **Verified live 2026-08-04:** a manual `npm run refresh:aggregates` now completes in ~19 seconds, matching the original pre-outage baseline, and real scheduled pg_cron ticks (on the `*/30` boundary) are succeeding - both the automated and manual paths confirmed working.

**"Nothing in the database records when the matviews were last refreshed" is no longer true.** `refresh-aggregates.js` now writes a durable `ingestion_runs` row on every attempt (a senior-engineering-audit fix, 2026-08-03) *(corrected 2026-08-23: since migration 0027 the SQL function `refresh_vote_aggregates()` writes that row itself, inside its own transaction - so the `pg_cron` ticks are recorded too - and the Node script deliberately no longer wraps the call in `openRun`/`closeRun`, which would double-record; both the manual and the scheduled path therefore appear under the same source)*, so `public_freshness` carries a real `refresh-aggregates` source with a genuine finish timestamp - the same freshness surface every other ingestion source already used. A matview number can now be timestamped like any other source instead of being permanently "as of an unknown time."

**The matview row counts have moved for a reason beyond ordinary growth - the exclusion logic went from inert to live.** Migration 0022's join-chain exclusion of superseded votes was live in the view definitions since 2026-08-03 but had nothing to exclude until the backfill itself was fixed the same day (structural defect #2): while `vote_duplicates` incorrectly held 0 rows, every "unchanged" matview count recorded elsewhere in this document reflects a snapshot where the exclusion was wired but doing no work. With 59 real duplicate pairs now marked and a working refresh actually running, re-verified live 2026-08-04 via direct REST count: `public_position_totals` moved to 11,472 (was 11,466); `public_party_alignment` and `public_party_position_totals` landed unchanged at 3,042 and 198 (coincidental at this cardinality, not evidence the exclusion still has nothing to exclude); and `public_vote_feed` - previously described as always equaling `vote_casts` - no longer does: 1,465,781 against 1,467,728 `vote_casts`, the ~1,947-row gap being the casts on the 59 now-excluded votes correctly dropped from the public feed. *(Re-checked 2026-08-23: `public_position_totals` 11,485; `public_party_alignment` 3,042 and `public_party_position_totals` 198 still unchanged; `public_vote_feed` 1,470,316 against 1,472,493 `vote_casts` - the exclusion is still live, now over 66 superseded votes, and `public_votes` reads 10,527 = 10,593 − 66.)*

---

## Every table, with plain-language descriptions

Counts are the 2026-08-03 snapshot (re-verified live; supersedes 2026-08-02). *** = moves constantly; never hardcode.** The three vote-aggregate matviews and `public_vote_feed` in the "Views and materialized views" table below carry a newer 2026-08-04 re-check, taken after a multi-layer refresh-timeout fix landed (see §6 above) - see that table for detail.

### Core civic data

| Table | Rows | What it is |
|---|---:|---|
| `jurisdictions` | 2 | The only two governments covered: `us-congress`, `mo-legislature`. |
| `sessions` | 32 (was 33) | Legislative sessions. 1 federal (119th Congress) + 31 Missouri. **`start_date` is sourced for every Missouri session as of 2026-08-22** (30 were NULL before; regular sessions carry the Mo. Const. art. III §20 convening date, specials the earlier of OpenStates' published start and the session's first recorded LegiScan bill action - see `src/cli/sync-session-dates.js`; `end_date` is only set where OpenStates supplied one, and is not used for ordering). **Producer-side caveat (2026-08-23):** the drivers that mint session rows (`ingest-legiscan.js`, `ingest-mo-house.js`, `ingest-mo-senate.js`) still write no `start_date`, so a session minted next January is undated until `node --env-file=.env src/cli/sync-session-dates.js` is re-run (dry-run, review, then `--apply`; fill-null only); both recency-first consumers (the exporter and the scheduler) fall back to the session's name-year meanwhile and report how many rows needed the fallback. **Down by one: the duplicate MO 2026 session (`'2026'`) was merged into `'261'` and deleted - see structural defect #1, now RESOLVED.** |
| `bills` | * ~38,254 | One row per bill per session. Most were never voted on. |
| `bill_texts` | 3,630 | Stored official bill text with a SHA-256 hash and source URL. Exactly one version per bill. |
| `bill_actions` | 1,051 (was 1,020) | Legislative history / action steps. **Covers only 142 bills (0.4%)** - see gaps. Grew but the coverage ratio barely moved. *(2026-08-23: ~5,096 rows over 493 bills, 1.3% - still effectively empty.)* |
| `bill_sponsors` | 46,268 | Sponsor and cosponsor links. Covers 38,232 bills (99.9%) - unchanged. |
| `votes` | * ~10,032 | **Roll calls** - the vote *event*. 445 have no bill attached (unchanged) *(451 at 2026-08-23)*. |
| `vote_casts` | * ~1,466,730 | **One legislator's position on one roll call.** The largest table. |

### People

| Table | Rows | What it is |
|---|---:|---|
| `legislators` | 1,607 | One row **per source system** per legislator. Every row is identified. Unchanged from 07-31. |
| `terms` | 1,087 | Service records: chamber, district, party, dates. One per legislator row that has one. Unchanged from 07-31. |
| `persons` | 36 (was 37) | **Merge records only** - created when ≥2 legislator rows are the same human. Not a roster. **Changed 2026-08-03:** the Pierson Sr./Jr. wrong-merge split back into two rows (`correct-data.js pierson-split`, live) - see §3 above. *(38 at 2026-08-23.)* |
| `person_links` | 74 (was 76) | The edges: legislator row -> person. 1,533 rows correctly have none (was 1,531). **Changed 2026-08-03,** same Pierson split (−2 links). *(2026-08-23: 78 links; 1,529 rows have none.)* |
| `identity_flags` | 16 | Same-surname clusters the auto-merger refused to decide. **4 open**, 12 resolved - unchanged from 07-31, re-verified live. *(All 16 resolved, 0 open, since 2026-08-05 - re-verified 2026-08-23.)* |
| `districts` | **0** | **Empty. Never populated, by design** - re-confirmed 2026-08-02, the site never reads it. Address lookup runs off `terms.district` instead. |

### Plain-language layer

| Table | Rows | What it is |
|---|---:|---|
| `summaries` | 213 (was 74) | Plain-language bill summaries. ~~One per bill.~~ **115 published, 98 draft.** *(2026-08-23: ~1,726 rows - 1,094 `published` / 32 `draft` / 600 `rejected`-retired - over 1,126 bills; no longer one per bill, banner item 1; `draft` mostly means parked, banner item 4.)* |
| `summary_verifications` | 378 (was 113) | Adversarial verification results on two axes: accuracy (support) and coverage (completeness). *(~3,349 at 2026-08-23.)* |
| `summary_notes` | 230 (was 78) | Adjudication trail: 115 `approved` + 115 `published`. *(2026-08-23: ~2,788 - 1,094 `approved` + 1,094 `published` + 600 `rejected`, the retirement notes that name each row's replacement.)* |
| `summary_terms` | 3,228 (was 974) | Summary -> glossary-term links, across 211 of the 213 summaries. |
| `glossary_terms` | 2,219 (was 847) | Statutes/acts/agencies bills reference. **116 written, 2,103 bare stubs.** Row counts and `status` split re-verified live 2026-08-03 (post-audit), exact match - but 9 of the 116 written terms had their `gloss_md` **text corrected in place** this pass (2 for refuted claims, 7 for corrupted text - same row, same status, different content; see `glossary_notes` above and structural fixes in the audit). *(2026-08-23: ~7,344 rows - ~2,277 written, 1,858 published, 47 rejected-parked - see §5 for the live shape.)* |
| `glossary_verifications` | 116 | One per published term: 108 clean, 8 flagged. Re-verified live 2026-08-03 (post-audit), exact match - the two FECA/BBEDCA terms corrected this pass are still among the 8 flagged (the audit fixed their *text* to match what their own flagged verification already said, it did not re-verify or reclassify them). *(2026-08-23: ~2,277 - 1,850 clean / 427 flagged; the published-and-flagged set is still exactly those 8, the other ~419 flagged glosses are held in `draft`.)* |
| `glossary_notes` | 275 (was 266) | Adjudication trail: 123 approved, 122 published, 28 edited (was 19), 2 rejected. **Changed 2026-08-03:** 9 new `edited` notes from the accuracy audit's corrections - 7 for the corrupted-text repairs (`correct-data.js glossary-corrupted-text`) + 2 for the FECA/BBEDCA refuted-claim fixes (`correct-data.js glossary-refuted-claims`). `glossary_terms.status`/`glossary_verifications.overall` counts themselves did not move (see below) - this is text-content correction on already-published rows, not a status change. *(2026-08-23: ~3,827 - 1,865 approved, 1,864 published, 28 edited, 70 rejected; the rejected notes now include the 47 parked nonexistent RSMo sections, §5.)* |

### Operations and provenance

| Table | Rows | What it is |
|---|---:|---|
| `ingestion_runs` | 581 (was 563) | Every pipeline run, with status and JSON detail, across 21 sources (unchanged - see freshness table). *(2026-08-23: ~3,655 rows across 30 sources - the newer sources are glossed below this table.)* |
| `legiscan_datasets` | 31 | LegiScan bulk-dataset cache ledger - one per Missouri session. Unchanged since 07-31, genuinely one-per-session (the 2026 duplicate that shared this count is gone; see structural defect #1). |
| `vote_reconciliation_flags` | 61 (was 49) | Cross-source vote-tally discrepancies. **All 61 open**, 0 resolved, covering 55 distinct roll calls (was 45) - 19 LegiScan-vs-MO-House-XML (was 16), 42 LegiScan-vs-MO-Senate-web (was 33), all four counts re-verified live 2026-08-03 (post-audit) via direct REST query, grouped by `vote_id`. Live MO ingestion kept ticking during and after the audit, surfacing more of the same known patterns - not a new defect class. See structural defect #2 (dedup) and #11 (MO House roster gap) - the audit found 16 of the (then-49, now more) flags are actually re-measuring the roster gap, not a genuine cross-source disagreement. *(2026-08-23: **364 open / 1 resolved** (SB 914) over 268 distinct roll calls - 187 LegiScan-vs-MO-Senate-web, 177 LegiScan-vs-MO-House-XML. The open count is dominated by a coverage class, not by tally disagreements - by `discrepancy.reason`: 176 `no_tally_corresponding_primary` (a LegiScan roll call with no journal twin because that journal day was quarantined or never reached), 101 `hard_mismatch`, 69 `primary_cast_data_not_comparable` (defect #11's roster gap re-measured), 14 `soft_mismatch`, 4 `ambiguous_tally_match`. Flags are written additively and nothing in the ingest path closes one when its twin later arrives, so `scripts/resolve-matched-reconciliation-flags.mjs` (dry-run by default, `--apply` to write) exists to resolve the first class once the journal replay and the next LegiScan cross-check have paired them in `vote_duplicates`; it records the resolution inside `discrepancy`, never deletes.)* |

**The 30-source vocabulary (2026-08-23), so a `public_freshness` row is readable.** Ingestion proper: `legiscan`, `mo-house-xml`, `mo-senate-web`, `us-congress`, `us-senate` (the five the 15-minute scheduler drives), `mo-legislature` (the original OpenStates import, dormant). Summary pipeline: `summarize`, `verify`, `extract-terms` (the 2026-07 CLIs), `scheduled-summaries` (the daily billed runner's per-tick ledger row - its `detail` is how the $5/ISO-week cap is computed), `summary-queue-record` (the queue planner's own run record). Glossary pipeline: `gloss` (the original per-run glosser CLI, `src/cli/gloss.js`), `gloss-batch-mo` / `gloss-batch-usc` (the Batch-API drains, one label per `--source`), `auto-publish-glossary` (clean-verified drafts -> published, no model calls), `backfill-mo-glossary-citations` (RSMo citation normalisation/de-dup). Identity and metadata backfills: `link-persons`, `backfill-nicknames`, `backfill-federal-names`, `backfill-mo-terms`, `backfill-term-states`, `backfill-mo-term-dates` and `backfill-mo-term-dates-overrides` (term start dates from openstates/people plus Lance's 21 ruled overrides), `backfill-mo-bill-meta`, `title-backfill` (`backfill-bill-titles.js`), `enrich-federal-bills`, `sync-session-dates`. Operations: `refresh-aggregates` (written by `refresh_vote_aggregates()` itself, §6), `correct-data` (every `correct-data.js` subcommand), `debug-timeout-check` (a one-off probe from the 2026-08-04 refresh-timeout diagnosis, kept as history).

### Views and materialized views

| Object | Rows | What it is |
|---|---:|---|
| `public_vote_feed` | * ≈ `vote_casts` minus superseded-vote casts (1,465,781 vs. 1,467,728 `vote_casts`, live-checked 2026-08-04) | Plain view joining casts -> roll calls -> bills. **No longer always equals `vote_casts`** - migration 0022's exclusion is live and, since the 2026-08-03 backfill fix (structural defect #2), finally has real rows to exclude: the ~1,947-row gap above is every cast on one of the 59 superseded 2018 MO Senate votes, correctly dropped from the public feed. |
| `public_position_totals` | 11,472 (was 11,466, live-checked 2026-08-04 after the refresh-timeout fix) | **MATVIEW** - casts per legislator / chamber / year / position. Stale until refreshed. **No longer structurally double-counts** - migration 0022's exclusion is live in the view chain and, since the 2026-08-03 backfill fix, is actually excluding the 59 real duplicate-marked 2018 MO Senate votes (see structural defect #2). A working refresh landed 2026-08-04 after a separate multi-layer timeout saga (see §6 above) - this row count is post-fix. |
| `public_party_alignment` | 3,042 (live-checked 2026-08-04 after the refresh-timeout fix, exact match) | **MATVIEW** - how often a legislator votes with their party's majority. Same 0022 exclusion now live and, since 2026-08-03, actually excluding 59 real duplicate-marked votes - landing on the same row count as before is coincidental at this cardinality, not evidence the exclusion still has nothing to exclude (see structural defect #2). |
| `public_party_position_totals` | 198 (live-checked 2026-08-04 after the refresh-timeout fix, exact match) | **MATVIEW** - casts per party / chamber / year / position. Same as above. |
| `public_freshness` | 21 *(one row per source - 30 at 2026-08-23)* | Latest run status per ingestion source. Unchanged since 08-02. |
| `public_verification_notes` | 220 (was 68) *(2,178 at 2026-08-23)* | Verification metadata, scoped to published summaries only. **As of migration 0021 (confirmed live this pass), also carries the `citations` column** - per-bullet exact-quote text, gated on `overall='clean'`, live-checked against all 220 rows with 0 shape/gating violations. |
| `public_reconciliation_flags` | 61 (was 49) *(365 at 2026-08-23)* | Reconciliation flags exposed publicly - tracks `vote_reconciliation_flags` above exactly. |

> **Gone:** migration 0003's `ingestion_freshness` view no longer exists - 0016 dropped it and replaced it with `public_freshness`. Don't go looking for it.

### One provenance warning

`run_id` on a row is the **last run that wrote it, not the run that created it.** Grouping bills by `run_id` today attributes 37,662 of them to a data-correction run that merely patched their status field. Never read `run_id` as origin.

---

## Coverage and honest gaps

### Date ranges - what years we actually cover

| Chamber | First roll call | Last roll call | Roll calls | Casts | Avg members per roll call |
|---|---|---|---:|---:|---|
| Missouri House | 2015-01-15 | 2026-05-15 | 6,613 | 1,038,741 | 157.1 of 163 |
| Missouri Senate | 2016-01-07 | 2026-05-15 | 1,898 | 61,559 | 32.4 of 34 |
| US House | 2025-01-03 | 2026-07-23 | 645 | 278,842 | 432.3 of 435 |
| US Senate | 2025-01-09 | 2026-07-30 | 876 | 87,588 | 100.0 of 100 |

(All four rows re-verified live 2026-08-03. Missouri House and Senate both grew a little further - expected, that ingestion is on a live cadence. **US House and US Senate are byte-for-byte unchanged, for the second refresh pass in a row** - both sources have been quiet since 07-31. Per-roll-call averages are unchanged in every chamber.)

*(Superseded 2026-08-23 - the "quiet since 07-31" framing no longer holds: MO House 6,989 roll calls, MO Senate 2,069, US House 645 (genuinely unchanged, last 2026-07-23), US Senate 890 with its last roll call 2026-08-08 - the `us-senate` source ran the morning of 2026-08-23. First-roll-call dates are unchanged in every chamber. Per-member averages were not re-derived; treat the table as a dated snapshot and regenerate it rather than patching cells.)*

Every roll call carries a real date - zero NULLs, and the old `1969-12-31` sentinel dates are fully cleared. *(Still true 2026-08-23. Once migration 0032 is applied, a small set of 2024 MO House roll calls will carry a date DERIVED from the bill's own printed history rather than printed on the roll call, each with a receipt in `votes.vote_date_provenance` - GAP 1; every printed date keeps that column NULL.)*

**The per-member averages are the honest completeness signal:** within the years covered, every chamber lands within a couple of members of its full roster. The vote record is not thin where it exists.

### The year gaps

**GAP 1 - Missouri House 2024 - RECOVERED 2026-08-23: 185 of 275 stored, 90 stay absent.** LegiScan's 2024 session held 351 roll calls. We stored 76 (all Senate) - re-verified live 2026-08-02. The other **275 (all House) were refused** because LegiScan prints their date as `0000-00-00` (its per-roll-call API prints the same - spot-checked live 2026-08-23 - so it is the source's record); the decision was to refuse rather than invent dates. **Update 2026-08-23:** the House XML export serves only the current General Assembly (2025/2026), so 2024 cannot come from house.mo.gov; but the bill history in the same LegiScan dataset prints floor passage with dates and tallies, and a roll call whose yea/nay match exactly one dated same-chamber action's printed AYES/NOES takes that date with the action stored as its receipt (`votes.vote_date_provenance`, migration 0032, `src/adapters/legiscan-votes.js` `deriveDateFromHistory`). That rule dates date this way; the other 90 are refused by design - 79 because no action in the bill's history prints that tally at all (perfection actions usually print none), 10 because another roll call on the same bill and chamber prints the same tally (so no single action can be tied to one of them), and 1 whose only tallied action belongs to the other chamber. **Status of the mechanism (2026-08-23): migration 0032 is DRAFTED, not applied** - the column does not exist live (verified by query), so `ingest-legiscan.js` refuses every derived-date vote rather than store a date without its receipt (`datesDerivedGated` in the run detail; the run closes `partial`), and the 184 (185 after the pre-commit adversarial review's chamber-suffix fix - commit `2e420d9`, CHATLOG 2026-08-23; the re-ingest's run detail is the number that actually lands) land only after Lance applies it. The receipt is stored verbatim as `{ source: 'legiscan_history_tally_match', printed_date: '0000-00-00', legislative_day, action: { date, action, chamber, chamber_source } }`, is NULL for every vote whose date was printed on the roll call (the overwhelming majority), and is dropped - with `vote_date` overwritten - if a later dataset prints a real date. On apply the column is anon-readable on the base table (0001's table-level `anon_read` policy; 0025 scoped only `summaries`/`glossary_terms`), but `public_votes`/`public_vote_feed` list their columns explicitly and do not carry it, so the site would serve the derived dates without an inline receipt until the view and the bill page do - a captured TODO, not an oversight. **The "275" figure itself is unverified this pass** - refused rows are never written to the database (that's the whole point of "refused"), so there is no live table to re-query for a refusal count; it comes from the original 2026-07-31 ingest-run audit and was accurate then. Result: Missouri 2024 shows ~2,500 casts against ~100,000 in neighbouring years, confirmed still true. It is *absent*, not thin.

**GAP 2 - Missouri 2010-2014 has bills but zero votes.** ~8,985 bills exist across the 2010-2014 regular sessions - re-verified live, exact match. **Correction to the 07-31 snapshot: including special sessions the total is 9,021, not "~9,079 including six special sessions."** Live query finds only **three** MO special sessions fall in the 2010-2014 window (`2010-special-497`, `2011-special-498`, `2013-special-1094`), not six, and 8,985 + 3 specials' bills = 9,021. All 9,021 of these bills - regular and special alike - still have **zero recorded votes**, confirmed live. This is a **source** gap, not an ingestion miss: all 31 LegiScan datasets were fetched, and every one of those sessions' ingest runs reports `rollCallsPlanned = 0`. Nothing to recover without a different source. **The Missouri bill record starts in 2010; the Missouri vote record starts in 2015.**

**GAP 3 - federal history does not exist.** All 366,430 federal casts (was 365,730) are 119th Congress (2025->) - re-verified: the per-year breakdown shows exactly zero federal casts in every year before 2025. A senator's pre-2025 record simply is not here. Widening it means more Congress.gov / senate.gov ingestion - free, polite, slow.

**GAP 4 - Missouri Senate has no 2015.** The journals-first pipeline starts in 2016.

**GAP 5 (added 2026-08-23) - 52 Missouri Senate 2018 journal days were never ingested from the primary source.** The scheduler's registry runs `ingest-mo-senate.js --year <current> --limit 1` only, so a prior year's journal days have no automatic drain path; the first manual `--year 2018 --limit 1` replay after the `bill_refs` parser fix reported `total_pending_days: 52` - the 2018 session was never processed beyond July's backfill sample. This is distinct from GAP 4 (an absent year) and from GAP 1 (a source that prints no date): LegiScan's 2018 Senate roll calls ARE on file (the 59 backfill-matched duplicate pairs are LegiScan-vs-journal twins from the 2018 days that were ingested), so what is missing is the per-day primary-source twin - which is also what keeps most `no_tally_corresponding_primary` reconciliation flags open. Draining it is ~26 hours of 30-minute terms-of-use slots, or a second registry entry for the prior year - a product decision for Lance, captured in `TODO.md`. Quarantine mechanics for the record: each journal day that fails to parse gets a `<journal>.failed.json` attempt marker beside its artifact; at `JOURNAL_DAY_MAX_FAILED_ATTEMPTS` (3) the day is quarantined and named in the run record; a replay is simply the marker removed and the day walked again, one day per tick.

### The summary funnel and the reason for each drop

*(Stage counts below are the 2026-08-03 snapshot. 2026-08-23 via `npm run status`: 38,256 -> 3,953 -> 3,343 -> 3,320 -> 793 published within the pool, ~2,498 text-ready and unsummarized; 1,094 published database-wide. The drop reasons are unchanged.)*

| Stage | Count | Why we lose the ones we lose |
|---|---:|---|
| Bills in the database | ~38,254 | - |
| v have any recorded roll call | 3,870 | **−34,384.** Introduced and died without a floor vote. This bucket also swallows all of Missouri 2010-2014, where no source has roll calls. |
| v have a passage / third-reading vote | 3,341 | **−529.** Only ever got procedural votes, so they are not accountability-relevant under the pool definition. |
| v have official text on hand | 3,319 | **−22.** 21 refused by the 400,000-character oversize gate + 1 image-only PDF that extracted zero characters. Nothing was ever silently truncated. |
| v have any summary row | 197 | **−3,144.** Pure volume - the pipeline hasn't reached the rest yet. 3,122 passage-vote bills already have text and are ready to go. |
| v **published** (within the passage-vote pool) | **107** | **−90.** 98 rows sit in draft awaiting review, and every one of them carries an adverse verdict (see "draft ≠ flagged" above) - none are clean-and-waiting. (Total published across the whole database is 115 - 8 more sit on bills outside the passage-vote pool by this funnel's own text-matching definition.) |

**The concentration problem has substantially improved, but is not solved.** At 07-31, all 39 published summaries came from 2 of 33 sessions. Re-verified live 2026-08-02: **115 published summaries now span 12 of 32 sessions** - the 119th Congress plus 11 Missouri sessions (2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2025, and 261/2026). Per-session counts: 261 (2026) 38, 2023 15, 119th Congress 19, 2018 11, 2019 6, 2016 6, 2015 5, 2022 5, 2017 4, 2021 2, 2025 3, 2020 1. **It is still lopsided** - MO 2026 alone accounts for a third of all published summaries - but a legislator's 2016-2023 record is no longer guaranteed to be explanation-free the way it was at 07-31. ~~The sessions still at zero are structurally expected to be: all of Missouri 2010-2014 (zero votes exist there at all - GAP 2), every MO special session in the window, and 2024 (GAP 1, the refused-House-dates year).~~ *(Corrected 2026-08-23: only Missouri 2010-2014 is structurally at zero - no votes exist there (GAP 2). Published summaries now span 15 of 32 sessions, including MO 2024 (9, on bills with 2024 **Senate** roll calls - GAP 1 is a House gap), the 2017 2nd Special (6) and the 2025 2nd Special (1). The 119th Congress now carries the largest share (~450 of ~1,094) and MO 2026 ~90 - still lopsided, just toward the federal side. Re-derive the per-session list from the database rather than copying this one.)*

Also: **0 of the 115 published-summary bills have a NULL title** (was 3 of 39) - **RESOLVED**. The 2026-08-02 title backfill (`backfill-bill-titles.js`, 1,972 of 1,975 NULL titles filled from cached LegiScan data) closed this gap as a side effect.

### Quarantined, refused and flagged items

| Item | Count | Status |
|---|---:|---|
| Missouri House 2024 roll calls refused | **275** (unverified this pass - refused rows are never stored, so there is no live table to re-count; was accurate as of 2026-07-31, and the resulting gap - 0 MO House roll calls in 2024 - is independently re-confirmed live) | Refused on `0000-00-00` source dates. Deliberate. |
| MO Senate journal days quarantined | **12** (was 11) *(superseded 2026-08-23: **0** - read `public_freshness.quarantined_days`. It had grown to 20 by 2026-08-22, 14 of them 2026-session days, every one failing on a single `bill_refs` class - "no bill reference found in motion" - because the parser knew one grammar (the bill named in the sentence before "by the following vote:") while the journal prints the bill OUTSIDE that sentence for conference-committee-report adoptions, title blocks, amendment instructions and reconsiderations, and prints non-bill roll calls (quorum calls, simple resolutions, journal amendments, appointments) under the same anchor. Fixed in `5ced4eb` - those families are attributed from their own headings/instructions, non-bill roll calls are classified as `nonBillVotes` and reported, never attributed or stored - all 20 `*.failed.json` markers were cleared, and the days replay one per scheduler tick. The 2018 days sit inside GAP 5's backlog.)* | Failed to parse 3+ times (`JOURNAL_DAY_MAX_FAILED_ATTEMPTS`, tracked per day in a `<journal>.failed.json` artifact); held out of the published record by design. |
| Passage bills with no text | **22** | 21 oversize refusals + 1 image-only PDF. Unchanged from 07-31. |
| Vote-reconciliation flags | **61 open / 0 resolved** (was 49) | Cross-source tally discrepancies over **55** distinct roll calls (was 45): 19 LegiScan-vs-MO-House-XML (was 16), 42 LegiScan-vs-MO-Senate-web (was 33). Re-verified live 2026-08-03 (post-audit) via direct REST query. Continued organic growth from live MO ingestion, not a new defect class - see structural defect #2 (dedup, now largely resolved) and #11 (MO House roster gap, the audit's estimated root cause of ~16 of these flags). *(2026-08-23: **364 open / 1 resolved** over 268 roll calls; 176 of the open flags are the `no_tally_corresponding_primary` coverage class, not tally disagreements - class breakdown and the resolver script are in the Operations table above.)* |
| Identity flags | **4 open / 12 resolved** *(0 open / 16 resolved since 2026-08-05; re-verified 2026-08-23)* | Clusters: Brown (3 rows), Moore (2), Johnson (2), Menendez (2 - an informational keep-separate ruling). Unchanged from 07-31, re-verified live. |
| Roll calls with zero individual casts | **179** (was 169) | 95 OpenStates events (source has no per-voter data, unchanged) + 84 MO House XML rows where only the aggregate tally was captured (was 74). Both counts re-verified live 2026-08-03 (post-audit) via a direct census, not sampled. **Correction to the "casts arriving later" framing:** the comprehensive accuracy audit found this is structural, not a lag, for the large majority of the MO House XML rows - see structural defect #11. The remaining 18 MO House XML rows in the same source (not zero-cast, but with exactly 1 cast) have the *same* root cause and are equally stuck, so 179 alone understates the real scope; defect #11 has the full figure. **A 2026-08-02 display fix (`site/js/bill-page.js`, TODO 28) still hides the OpenStates rows on a bill page whenever real cast-bearing data exists elsewhere on that same bill** - unaffected by this pass. No underlying data was touched by this doc pass - counts only. *(2026-08-23: ≥479 - the same 95 OpenStates rows plus 384 zero-cast `mo-house-xml` rows, with 125 more one-cast rows beside them; that adapter now contributes 509 roll calls and still has 0 with more than one cast - defect #11, same structure, larger numbers.)* |

### Structural defects worth knowing about

These are real problems, not design choices:

1. ~~**The Missouri 2026 session is split across two session rows.**~~ **RESOLVED 2026-08-02.** Session `'261'` (LegiScan) and session `'2026'` (MO Senate journals) used to both cover 2026, with `'2026'` carrying no `legiscan_session_id`. Live-verified: `sessions` now holds exactly **one** MO-2026 row (`'261'`) - the duplicate was merged and deleted (34 duplicate bills merged into their canonical twins, 31 votes redirected, 0 orphaned votes independently re-verified) - see `CHATLOG.md` 2026-08-02. The fix landed twice: the first pass closed the existing duplicate, then a still-buggy `ensureSessionRow` re-minted a fresh *empty* `'2026'` row before the root cause was patched; that empty row was confirmed empty and deleted, and the underlying resolver was rewritten to reuse the same year+name logic already proven correct for LegiScan sessions. 12 real scheduler ticks since have created zero duplicates.
2. **Cross-source roll-call duplication - MIGRATION 0022 IS NOW APPLIED AND LIVE (2026-08-03), largely resolved, one real sub-case still open (see #11).** This is the same defect tracked as `docs/CONTROLLER_BRIEFING.md` §3 item 5 ("display-time dedup ruled binding, never built"). It went "not started" -> "code complete, drafted" (earlier 08-03 snapshot) -> **applied live** (this pass, later the same day). **Independently reconfirmed live this pass** (`node --env-file=.env scripts/probe-public-surface.js`): the `public_votes` columns check now **PASSes** (it read "migration 0022 not applied yet" as of the morning snapshot - that sentence is now wrong and has been removed from this doc).
   - **What's live:** the non-destructive `vote_duplicates` grouping table (mirrors the `persons`/`person_links` precedent - neither `votes` row is ever deleted or rewritten), the `public_votes` view and an updated `public_vote_feed` that both exclude the superseded row, and the same exclusion rewritten into the join chain of all three vote-aggregate matviews. Live LegiScan ingest now marks new duplicates automatically going forward.
   - **CORRECTED 2026-08-03, later the same day: the backfill's original ZERO-match result was itself a bug, not a correct zero - this document's own earlier framing here was wrong.** `runCorrectVoteDuplicates` (`src/cli/correct-data.js`) ran a bare `.select()` on `votes` filtered to `legiscan-%` source keys - no `selectAll`, no pagination - so PostgREST silently capped the scan at 1,000 of 8,221 legiscan votes, and because already-matched rows were skipped in memory rather than excluded from the query, repeated runs never advanced past that same first page. The senior engineering audit ran the repo's own comparison functions against the full, unpaginated set and found real, clean matches waiting beyond row 1,000. Fixed by routing through `selectAll`; a regression test seeding >1,000 pairs now fails against the old code. **The corrected live run found 59 real matched pairs - all 2018 MO Senate - and `vote_duplicates` now holds exactly 59 rows, confirmed via a direct REST count.** *(2026-08-23: 66 - those 59 backfill rows plus 6 marked `tally_unique_match at ingest` by live LegiScan cross-checks (the "marks new duplicates automatically" claim above, confirmed working) and the 1 SB 914 adjudication; the `reason` column distinguishes the three.)* All 59 are excluded from every public vote-aggregate matview via the same 0022 join-chain exclusion described above, which is now genuinely doing work, not a no-op.
   - **The `mo-house-xml` comparability finding survives this correction and explains why none of the 59 matches involve that adapter.** MO's `mo-house-xml` adapter essentially never has enough individually-stored `vote_casts` for the matching code to certify a match it can verify (`isPrimaryCastDataComparable` correctly declines rather than guessing) - this isn't incidental, **it is the direct downstream effect of structural defect #11 below** (the one-fixture-roster gap): 0 of 102 `mo-house-xml` roll calls have more than 1 individually-stored cast, so there is essentially nothing for the dedup backfill to match against on that adapter. `mo-senate-web` was never actually the problem, though - all 104 of its votes pass the comparability check; the earlier reading of the zero-match result as "MO's adapters mostly aren't comparable" was a plausible-sounding explanation for what was actually a query-truncation bug that never reached the senate rows at all.
   - **A real exception the backfill deliberately never resolves - RESOLVED by human adjudication 2026-08-05:** SB 914's third-reading vote is a **hard contradiction**, not a duplicate. LegiScan says 29-0 (unanimous); the MO Senate journal (primary source) says 28-1, with Sen. Mike Moon's NAY absent entirely from LegiScan's own roll-call data (LegiScan's own total field says 32 voters, not the Senate's real 34 - Sen. Steven Roberts is also missing from LegiScan's tally). Caught live by the reconciliation gate (`vote_reconciliation_flags` id `214a2be0`); `correct-data.js`'s dedup backfill deliberately never marks disagreeing pairs (it only certifies *agreeing* ones), so this needed a human ruling, not a data fix. **Lance ruled "trust senate journals" 2026-08-05**: `correct-data.js sb914-reconcile` ran live - the LegiScan row is now marked superseded (non-destructively, via `vote_duplicates`), so the vote is no longer double-counted in the public aggregates, and flag `214a2be0` is resolved with the adjudication recorded in its own `discrepancy` JSON. A GENERAL adjudication tool (`correct-data.js reconcile-flag`) now exists for the other open flags too. This case still proves the older "will pick up automatically once cast data catches up" framing false: cast data is complete on both sides, the backfill correctly declined (because the sources disagree, not because data is missing), and only a human ruling could resolve it.
   - **Reconciliation-flag context (re-verified live this pass):** 61 open / 0 resolved (was 49), 19 LegiScan-vs-MO-House-XML + 42 LegiScan-vs-MO-Senate-web, over 55 distinct roll calls (was 45). The audit found roughly 16 of these (of the then-49) are actually re-measuring the defect-#11 roster gap rather than a genuine cross-source tally disagreement - a real discrepancy count is smaller than the raw flag count suggests, but not mechanically separable yet.
   - **Migration `0023_vote_duplicates_rls_and_view_drift.sql` is now formally APPLIED, confirmed live 2026-08-03 (Lance: "all have been ran in supabase").** Two fixes in one file: (a) `enable row level security` on `vote_duplicates` (the only table in the schema whose 0022 migration hadn't declared it, though the posture was already live out-of-band before 0023 landed) - confirmed via a direct planner-cost check (`public_votes` anon-planned row count matches the RLS-restricted control, not the full `votes` table) plus a direct `vote_duplicates` anon read (`200 []`). (b) recreating `public_vote_feed`/`public_votes` without `security_invoker = true` to match what's actually live. No longer a draft-vs-live gap of any kind - it is simply applied, same as every other numbered migration in this repo.
3. ~~**2,005 bills have both a NULL title and a NULL canonical URL.**~~ **RESOLVED 2026-08-02, still resolved - re-verified live 2026-08-03, exact match, still 3.** `backfill-bill-titles.js` filled 1,972 of 1,975 NULL-title bills from cached LegiScan datasets (0 failures; the 3 left untitled are `SRM` remonstrance resolutions LegiScan's own cache has no title for either - correctly left untouched, never guessed). Bills with **both** a NULL title and a NULL `canonical_url`: **3** database-wide, unchanged since 08-02.
4. **`bill_actions` is effectively empty** - grew but the coverage ratio barely moved: 1,051 rows (was 1,020) over 142 of 38,254 bills (0.4%, was 139/38,254 = 0.4%), all Missouri - re-verified live this pass. There is still no "what happened to this bill" timeline for 99.6% of bills. *(2026-08-23: ~5,096 rows over 493 bills - 1.3%; 98.7% still have no timeline. Same conclusion.)*
5. **Legislator profiles have no photos and no contact info** - re-confirmed live 2026-08-02: `image_url` and `contact` are NULL on all 1,607 rows, by design (`TODO.md` item 29 - photos derive from bioguide at render time, not stored). `districts` is still empty. One row still displays a raw bioguide code (`G000578`) as its name - unchanged, still open.
6. **555 of 1,607 legislator rows have zero votes** - re-verified live 2026-08-03, exact match to 08-02 and 07-31. Breakdown re-verified live this pass via `public_position_totals` (386 carry a federal `bioguide_id`, mostly historical members whose service predates our federal coverage window; 169 are Missouri-sourced) - exact match. (The 07-31 snapshot's finer claim, "352 of those are historical US senators" specifically - a chamber-level sub-cut of the federal group - remains **unverified**; it needs a join against each row's own term chamber that wasn't run this pass either.) The distinct-person-level breakdown (1,015 of 1,568 show a voting record, 553 render empty, "two known empty-shell duplicates" - Bob Onder, Jason Smith) was not independently re-run this pass; carried forward from 08-02 unchanged. **Note the denominator underneath it moved 2026-08-03:** the distinct-people total is now 1,569, not 1,568 (see §3 above, the Pierson split) - both Pierson rows have real votes on file, so 1,015/553 themselves likely didn't change, but this exact breakdown hasn't been re-derived against the new denominator and shouldn't be assumed unchanged.
7. **318 legislator rows have votes but no term row** - unchanged, exact match to 07-31. Live-verified this pass, exact match again: **520 of 1,607 legislator rows** have no term row at all (the 07-31 snapshot phrased this as "482 of 1,568 entries," using the person-deduplicated denominator rather than the raw row count this figure is actually computed against - the row-level number itself moved 482->520, then held steady 08-02->08-03).
8. ~~**Party vocabulary is unnormalized.**~~ **LARGELY RESOLVED 2026-08-02 - on the column the public aggregates actually read - and confirmed still holding, re-verified live 2026-08-03, exact match on every figure.** `legislators.party` (the column `public_position_totals`/`public_party_alignment`/`public_party_position_totals` all join against) remains fully normalized - **Republican 860, Democratic 672, Independent 8, Independent Democrat 1, NULL 66** - zero bare `R`/`D` codes, confirmed live this pass. The insertion-point fix (`legiscan-identity.js` writes full words directly) is holding: a freshly-ingested LegiScan legislator has not re-dirtied the column since 08-02. **Casts falling out of every party total** (NULL or `Independent Democrat` party, 67 legislators - confirmed the same 67 this pass) was **42,207** as of 08-02; not independently re-summed this pass (the underlying legislator-level party breakdown is unchanged, so this figure has very likely only grown with vote volume, same as before - not re-verified to the exact number, flagging rather than restating as current fact). **`terms.party` - the second, still-unnormalized column - re-verified live this pass, exact match:** bare `R` (131) and `D` (62) codes alongside `Republican` (450), `Democratic` (435), `Independent` (8) and `Independent Democrat` (1). Still untouched by the fix, still not read by any public matview.
9. **Current-seat coverage is nearly complete but not perfectly - re-verified live, essentially unchanged.** US Senate 100/100 (unchanged). US House 437 current-term rows, of which **6** (was 5) have a null district, so address lookup cannot match them. Missouri House 159 of 163 seats - districts 95, 110, 114, 160 still have no current-term row, exact match to 07-31. Missouri Senate covers all 34 districts but has 35 rows - district 2 still carries two overlapping current terms. ~~194 terms have no start date~~ *(2 as of 2026-08-23: `backfill-mo-term-dates` filled them 2026-08-06 from the openstates/people repository's CC0 role dates - each row cites the source commit - plus 21 Lance-ruled overrides recorded under `backfill-mo-term-dates-overrides` with his ruling that "start_date means the start of the CURRENT term/stint being served; the openstates/people open-role start_date is authoritative for it")*, 731 no end date - ~~both exact matches to 07-31~~ *(the end-date figure is the one unchanged)* - so "current" is still partly inferred rather than proven, now only through the missing end dates.
10. ~~**`legiscan_datasets` is still publicly readable including its `local_cache_path` column.**~~ **RESOLVED 2026-08-03 - applied and verified live this pass.** Migration `0024_lock_down_legiscan_datasets.sql` dropped the `anon_read` policy from migration 0010. Re-confirmed directly with the anon key this pass: `legiscan_datasets` now returns `200 []` to anon (RLS default-deny, same posture as `vote_reconciliation_flags`), while the service-role key still sees all 31 rows intact - no data touched, only public reachability closed.
    - **RESOLVED 2026-08-03.** Migration `0025_scope_summaries_glossary_columns.sql` (*column*-level scoping, not row-level - RLS already correctly restricted anon to *published* rows on `summaries`/`glossary_terms`, but nothing had restricted which *columns* of those published rows anon could read) is applied and verified live: a direct anon-key query for `model,prompt_version,bill_text_hash,run_id` against published `summaries` now denies the three non-granted columns, and `source_hash,needs_mapping` against published `glossary_terms` are likewise denied; `model` (deliberately public - `bill-page.js` displays it as attribution) still reads fine. **One real fallout, caught and fixed the same pass:** `site/js/bill-page.js`'s summary fetch had no explicit `select=` (defaulted to all columns), and Postgres denies a bare `select=*` outright when a role only holds column-level grants rather than silently narrowing to what's granted - that query started 401ing the instant 0025 landed. Fixed same pass (commit `9884b18`): added the explicit `select=` listing exactly the columns 0025 grants, confirmed via direct anon REST calls against all 5 real `summaries`/`glossary_terms` query sites in `site/js/` plus a real Playwright browser load of an actual bill page (summary rendered, zero console errors). Every other query site already had an explicit `select=` and needed no change.
11. **NEW 2026-08-03 (found by the comprehensive accuracy audit, independently re-verified live this pass): the MO House per-legislator vote-coverage gap is structural, not a temporary lag - this document's older framing ("individual casts arriving later on the same row") is retired.** Root cause: `persistRoster` (`ingest-mo-house.js`; line numbers dropped 2026-08-23 - they had drifted) seeds the roster the roll-call-PDF cast-parser resolves names against with **exactly one legislator** - Mark Matthiesen, a test fixture, its own code comment calling a real per-district roster "a future overnight-loop pass" that was never built. Every PDF still parses completely and tally-reconciles against the printed aggregate (2,370 individual positions extracted across the non-zero votes), but only Matthiesen's own position ever resolves against the one-name roster and gets stored - the rest are silently dropped.
    - **Live re-verification this pass (grown since the audit's 0-of-92, same shape):** of 102 `mo-house-xml`-sourced roll calls, **0 have more than 1 individually-stored `vote_cast`** - 84 have zero, 18 have exactly one (Matthiesen's). *(2026-08-23: the structure holds exactly and the numbers have grown with the 2026 crawl - 509 roll calls from this adapter, 384 zero-cast, 125 one-cast, still 0 with more than one; the one-fixture roster is still in the code. A bound worth knowing for any roster-fix costing: the House XML export serves only the CURRENT General Assembly - Lance's own browser got XML for the 2025 list and the "application error" page for the 2024 ones - so this adapter can never contribute prior-session data, and 2024 House votes can only come from LegiScan, GAP 1.)* This is a narrow, adapter-scoped figure - it describes only the ~102 roll calls this specific adapter contributes, not the MO House's full ~6,613-roll-call, 157-of-163-member-average record (which is dominated by LegiScan's own independent MO ingestion and is not affected by this defect).
    - **Concrete visitor-facing effect:** roughly 162 of Missouri's 163 House members show **zero** MO House votes on their own profile page from this adapter, forever, with no caveat - while Matthiesen looks fully tracked on the exact same roll calls. His cast is also stored redundantly on both his own row and the LegiScan twin for all 18 non-zero votes, inflating his own public vote count by roughly 4% relative to every colleague.
    - **No automatic recovery path for most of what's already been dropped:** the pending-queue logic permanently excludes any vote with ≥1 cast already stored from re-fetch, so 17 of the 18 non-zero votes (all but the very latest) would not backfill on their own even if a real per-district roster shipped tomorrow - a dedicated backfill pass would be needed.
    - **This is the mechanism behind two other figures in this document, not a separate coincidence:** it is why the migration-0022 dedup backfill (structural defect #2) found 0 clean matches against `mo-house-xml` specifically, and the audit attributes roughly 16 of the (then-49, now 61) open `vote_reconciliation_flags` to this same roster gap rather than genuine cross-source disagreement.
    - **Status: RESOLVED 2026-08-05, corrected below.** ~~a real, disclosed, still-open product decision - not fixed this session, and deliberately out of scope for the Cloudflare deploy spec (Lance's own scoping call, 2026-08-03): ship the ~162 blank MO House vote sections as-is, or add an explicit completeness caveat to `person-page.js`'s MO House vote section first. Tracked in `TODO.md` NOW.~~ **Correction, 2026-08-05: "the ~162 blank MO House vote sections" was itself imprecise and read as more severe than reality - this bullet's own line above (the 309 note) correctly scoped the gap to "from this adapter," but this Status line slipped into implying the profile SECTIONS are blank, which is wrong.** Live-verified directly: all 159 CURRENT MO House legislators have at least one real MO House vote on their profile page via LegiScan's independent coverage (confirmed against `site/js/person-page.js`: no source/adapter filtering excludes LegiScan-sourced MO House rows). Decision: **ship as-is, no caveat needed** - see the 2026-08-05 update below for the full evidence.
    - **Redundancy investigated end-to-end, 2026-08-05 (parallel investigate -> synthesize -> adversarially verify; CONFIRMED on independent re-check) - a roster-ingest-loop fix was deliberately deprioritized, not built.** Live-verified: every one of the ~22-24 `mo-house-xml` roll calls that currently resolve ANY real cast has, at the bill level, an existing LegiScan vote for the same bill (100% overlap, checked directly, not assumed from this document's own "LegiScan twin" phrasing above). Cannot get a dedup-*certified* floor-vote match - `vote_duplicates` shows zero hits for these vote ids - but that's the identical 1-person-roster gap starving `isPrimaryCastDataComparable`'s certifier of enough individual casts to certify anything, the same limitation already documented for `HB1623-3` in the vote-dedup work above; bill-level overlap is strong circumstantial evidence, not a certified match. Given that confirmed redundancy for everything this source currently *can* produce, plus the fix's real cost (~3.4 days of cooldown budget for a live per-district roster fetch via the already-defined-but-unwired `fetchMoMemberList`/`fetchMoRepresentative`, `mo-house-xml.js:124-149,314-321`, plus a new replay pass since `listPendingRollCallPdfs` permanently excludes any roll call with ≥1 cast from re-fetch, plus careful navigation of a separate open landmine - `mo_house_id` is `unique` with no collision handling, risking cross-era misattribution if roster fetching ever spans more than the current session, per `docs/CONTROLLER_BRIEFING.md` item 6/TODO 31) - the fix was judged not worth building. The pipeline itself is otherwise operationally healthy (214 runs since 2026-07-28, 97% success, only failures a single already-fixed 2026-08-01 timeout incident, bill backlog draining monotonically) - this is a functional cap on cast-resolution, not a stalled or broken scheduler. Unrelated finding surfaced along the way: **zero MO House votes exist for 2024 at all** in the live dataset - a separate gap, not investigated further. **Follow-up, same day: the site-content question above (ship as-is vs. caveat) is resolved, not just informed.** Directly verified (159 individual per-legislator existence checks against `vote_casts` joined to `votes`, scoped to current MO House `terms` rows, avoiding the PostgREST 1,000-row cap by checking one legislator at a time): all 159 current MO House legislators have `>=1` real MO House vote_cast - zero show a blank section. Confirmed this reflects actual rendering by reading `site/js/person-page.js`: votes render generically by chamber with no adapter/source-based exclusion. Decision: ship as-is - a completeness caveat would warn about a gap that doesn't exist on the rendered page for virtually any legislator or vote.

### What the public can actually see

**Update 2026-08-03, later the same day (post-audit): 0023 and 0025 applied, closing the gap.** Migration 0021 (bullet citations) was already live as of the morning snapshot, confirmed via `node scripts/probe-public-surface.js` (the `citations` column shape-checked against all 220 live rows, 0 violations). Migrations 0022 (vote-duplicates) and 0024 (legiscan_datasets lockdown) were confirmed applied and live earlier the same day. **Migrations 0023 (RLS + view-drift fix) and 0025 (column-scoping) were then formally applied and verified live too** (Lance: "all have been ran in supabase") - see structural defects #2 and #10 above for the confirmation detail and, for 0025, the one real site-query fallout it caused (`bill-page.js`, fixed same pass). **Migration 0026 (aggregate-refresh timeout fix) landed the same day as well.** As of that pass: migrations 0001-0026 were all live. **The refresh-timeout story didn't end there** - 0026 fixed a slow-query regression but not the whole problem; three more root causes (a Supabase edge-gateway timeout, a Postgres `statement_timeout` arm-timing trap, and a query-planner anti-join misestimate) were found and fixed 2026-08-04 via migrations 0027, 0028 and 0029 - see "Materialized views are snapshots, not tables" (§6) above for the full account. **As of 2026-08-04: migrations 0001-0029 are all applied and live.** *(Update 2026-08-05: 0030
revoked a stray `authenticated` EXECUTE grant, and 0031 rewrote `public_vote_feed`/`public_votes`'
anti-join to `NOT EXISTS` after it hit anon's 3s `statement_timeout` on deploy night - both applied
and verified live. **All 32 migrations, 0001-0031, are applied.**)* *(Update 2026-08-23: a 33rd file, `0032_vote_date_provenance.sql`, was applied by Lance that day - `votes.vote_date_provenance` is live and carries a receipt on 185 rows.)*

- **Fully public:** bills, sponsors, actions, roll calls, vote casts, the vote feed, legislators, terms, persons, sessions, jurisdictions, summary->term links, and all three aggregate matviews.
- **Gated to zero rows:** `bill_texts`, `ingestion_runs`, all notes and verifications, `identity_flags`, `person_links`, `vote_reconciliation_flags`, and (new this pass) `legiscan_datasets` and `vote_duplicates`.
- **New since 08-02:** `public_verification_notes.citations` - per-bullet exact-quote text, gated on `overall='clean'` in the view definition itself (not application code), live and probe-verified.
- **Filtered:** `summaries` shows 115 of 213 (published only) - was 39 of 74; `glossary_terms` shows 116 of 2,219 (published only) - was 116 of 847. *(2026-08-23: ~1,094 of ~1,726 and ~1,858 of ~7,344 respectively - same rule, larger tables.)* **Row-filtered AND, since 2026-08-03, column-scoped too** - migration 0025 (see structural defect #10) is applied and live: anon can no longer read internal pipeline columns (`prompt_version`/`bill_text_hash`/`run_id` on `summaries`; `source_hash`/`needs_mapping` on `glossary_terms`) on published rows; `model` remains readable by design (`bill-page.js` shows it as attribution).
- **Two deliberate view bypasses:** `public_freshness` (21 rows, was 20 - *30 at 2026-08-23, one per source*) and `public_reconciliation_flags` (61 rows, was 49 - re-verified live this pass; *365 at 2026-08-23*) expose data whose *base tables* are anon-gated. Documented design choices, but the two places where "the base table is private" does not mean the data is private.

---

## Numbers that look alarming but are fine

Several counts in the ledgers read like data loss and are not. Checking these once, here, should stop the recurring panic.

**"275 Missouri House 2024 roll calls refused"** (unverified this pass, was accurate as of 2026-07-31 - refused rows are never stored, so there is no live table to re-derive the count from; the gap it described - 0 MO House roll calls stored for 2024 - held until 2026-08-23, when 185 of the 275 were stored under derived dates; see GAP 1). LegiScan prints those roll calls with the date `0000-00-00`. ~~There is no honest way to derive a real date.~~ *(Superseded 2026-08-23: there is one honest way, for 185 of the 275 (GAP 1; stored 2026-08-23) - the bill's own printed history in the same dataset, where exactly one dated same-chamber action prints the identical AYES/NOES; that action is stored as the receipt (GAP 1, migration 0032 - drafted, not yet applied). The other 91 stay refused.)* Storing them with a fabricated or sentinel date would put wrong dates on the public record. **Refusing is the correct behavior.** The gap is real and is documented above; the refusal is not a bug.

**"21 bills refused for oversize text."** A 400,000-character ceiling on stored text. Missouri's SRB 975 is 751,225 characters; the federal S 1071 is 3,492,102. The alternative to refusing is silently truncating, which would mean summarizing half a bill and calling it the bill. **Nothing was ever truncated.** Correct by design.

**"12 MO Senate journal days quarantined"** (was 11 at 07-31, re-verified live via `public_freshness.quarantined_days`) *(0 at 2026-08-23 - the count peaked at 20 on 2026-08-22, all one parser class, fixed and replayed; see the quarantine table above and GAP 5 for the separate 2018 backlog)*. Days whose journal PDF failed to parse cleanly three or more times, deliberately held out rather than published as a partial or garbled vote record. Correct by design, and each quarantined day is named in the run record.

**"1,813 LegiScan roll calls refused over an unknown `NV` vote code."** This was a first-contact fail-loud on an unrecognized vote value - the pipeline stopped rather than guessing what `NV` meant. **It was fixed and every affected session re-ingested to `succeeded` with zero reconciliation failures.** Not missing today.

**"3,474 unresolved US Senate cast entries."** Resolved. The final us-senate run reports 20,997 resolved / **0 unresolved**, and the live average is now a clean 100.0 of 100 senators per roll call (up from 99.99), which confirms it.

**"17,585 unresolved casts in mo-house-xml."** An artifact of re-counting. This is a **single stuck artifact** (~158 surname-only casts with null districts, source key `mo-house-xml-HB1800-4`) being retried on every run, and the 17,585 figure is that same ~158 counted across 122 runs. Roughly 158 casts are genuinely not stored - not 17,585.

**"1969-12-31 dates" and "numeric bill status codes."** Both cleaned up. Zero sentinel dates and zero NULL vote dates remain. 37,662 bills had numeric LegiScan status codes converted to words; **36 bills still show status `0` deliberately**, because LegiScan's codebook has no word for code 0 and inventing one would be editorializing. ~~18~~ 3 have a NULL status *(2026-08-23; the 36 `0`-status rows are unchanged)*.

**"`enrich-federal-bills` status: partial"** and **"`gloss` has never succeeded."** These pipelines record per-item failures and continue by design, so `partial` is their normal healthy outcome, not a failure. 480 of 482 federal bills have a status (was 476 of 478 - the federal bill count grew by 4, and the same 2 exceptions remain uncovered); the 2 without are the fake `QUORUM` / `ADJOURN` pseudo-bills that Congress.gov returns 404 for.

**"445 roll calls have no bill"** (was 444; 451 at 2026-08-23). Nominations, cloture motions, adjournment - 444 US Senate and 1 US House (was 443/1; 450/1 at 2026-08-23). Real votes that genuinely have no bill to attach to.

**"Only 8 of 116 published glossary terms are flagged, but zero published summaries are."** Not an inconsistency. Glossary terms were hand-adjudicated (28 edited as of 2026-08-03, was 19; 2 rejected on the way through) under the review model; summaries auto-publish only on a clean verdict. Different pipelines, both intentional - but state it rather than assume it. **Two of those 8 flagged terms (FECA, BBEDCA) had their text corrected this pass** - they were `published` with content their own `flagged` verification had explicitly refuted (an intended edit recorded in the notes trail 2026-07-29 but never actually saved before re-publish); the audit caught it, `correct-data.js glossary-refuted-claims` fixed the text to match what the flagged verdict already said. Still flagged, still published, still 8 of 116 - the count didn't move, only two rows' correctness did. *(2026-08-23: still those same 8, now 8 of 1,858 published; the ~419 flagged glosses from the Batch-API drains were held in `draft` for Lance's review rather than published, so the glossary gate now matches the summary gate - §4.)*

---

## How to check this yourself

```bash
node --env-file=.env scripts/data-status.js
```

That script queries the live database and prints the current counts, the funnel, and the open-flag totals. **It is the source of truth for any number.** This document is the source of truth for what those numbers *mean*.

Two rules that keep this from breaking again:

1. **Do not hand-edit counts into `README.md`, `docs/ARTIFACTS.md`, `TODO.md`, or anywhere else.** Those files should link here and to the script. Every count previously written into prose went stale within a day, and the "1,465,102 vote casts" figure that appeared in two files was a stale materialized-view sum that nobody could trace.
2. **If the aggregate matviews and the tables disagree, run `npm run refresh:aggregates`.** The matviews back the profile charts, so when they lag, a legislator's chart under-reports activity that the vote list beside it displays correctly - a visible self-contradiction on the public site.

Anything that restates a count in prose will be wrong again within 30 minutes. Only two things should ever be trusted for live numbers: the status script, and `site/js/trust-page.js`, which counts from the database at page load and is the one number source in the repo that cannot go stale.
---

## 2026-10-20 - two glossary numbers changed meaning, and one assertion in this document expired

### The second ungroundable class: UNCODIFIED sections

`npm run status` now prints a line that did not exist before:

```
  glossary published ...... 2,587 of 5,096 glossable  (50.8%)
    ...ungroundable ....... 4,517  <- acts/agencies/programs with no citable source
    ...uncodified ......... 109    <- sections a bill PROPOSES; the Revisor publishes no text
    ...raw row total ...... 9,722  <- includes BOTH ungroundable classes
```

**What `uncodified` means.** A bill proposing to create section 135.1325 ("Employer Provided Child
Care Assistance Tax Credit Act") gives the glossary a citation that resolves to nothing:
revisor.mo.gov does not publish a section until it is codified. There is no text to quote, so
Lance's 2026-09-05 source rule excludes it exactly as it excludes an agency name. Agreed with him
2026-10-20.

**How they are identified, and why not by status.** By the park note `gloss-batch` writes
(`glossary_notes.note LIKE 'parked by gloss-batch%'`), counted as DISTINCT `term_id`. **Never by
`status='rejected'` alone** - that status is crowded and also holds genuinely bad glosses, so
conflating them would make the line meaningless. The note is the evidence, which is why `parkTerm`
writes one.

**They were previously counted as GLOSSABLE.** The denominator moved 5,193 -> 5,096 when they were
excluded. 78 existed when the class was named and 68 of those were parked in August, so **this class
sat inside the "achievable work" denominator for two months.** That is the precise defect Lance's
2026-09-05 ruling was issued to stop, reappearing in a class nobody had met yet.

### `flagged, awaiting Lance` is now `authored drafts`, because the old label was false

The line used to read `flagged, awaiting Lance <N>  <- verifier raised an objection`. On 2026-10-20
it read **1,356** when Lance's real review queue was **619**: the other 737 were verified CLEAN and
merely waiting for a free `auto-publish-glossary` run.

**This is §4 of this document ("draft != flagged") recurring one level deeper.** §4 separates the
`status` axis from the `verdict` axis. This is a third distinction inside the draft+verdict
intersection: a clean-verdict draft and a flagged-verdict draft have **different owners** - the first
is owed a free CLI run, the second is owed a human. Merging them overstated a person's workload by
2.2x, which is the same magnitude and the same shape as the 870-vs-427 error this schema already
produced once.

**The authoritative split is one free command, and it is not recomputed in the status script:**

```
node --env-file=.env src/cli/auto-publish-glossary.js --dry-run
# counts.eligible                  = clean, needs the free publish step
# counts.flaggedOrUnverifiedSkipped = Lance's real queue
```

Eligibility is derived by `glossVerificationBadge` in `src/review/server.js`. A second copy of that
derivation living in a reporting tool would eventually disagree with the one the publisher actually
uses, and then neither number would mean anything - so `data-status.js` names this command instead
of guessing.

### EXPIRED ASSERTION, corrected here rather than left standing

This document states, of the draft summaries, *"nothing clean is sitting unpublished"* (and §4 says
the same of the 98 drafts in its 2026-08-02 pass). **That was true when written and is NOT a standing
property of the system.** It holds only while the auto-publish step has been run more recently than
the last authoring batch.

On 2026-10-20 the glossary batch left **737 clean terms unpublished for hours** with no error
anywhere, because the drain is TWO steps and only the first was run. The run's own field name is most
of the trap: `glossed_clean: 737` means "the verifier cleared it", **not** "it is live".

**Read it as: nothing clean should REMAIN unpublished after `auto-publish-glossary` runs. Between an
authoring batch and that run, clean items are expected to be sitting unpublished** - and the right
response is to run the free step, not to investigate a defect.
