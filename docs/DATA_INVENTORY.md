# What VisibleGov Actually Has

**Status of this document:** source of truth for **structure and meaning**.
**Not** the source of truth for live numbers — see the box below.

---

## READ THIS FIRST: counts go stale, structure does not

The database is **actively written to by a cron job every 30 minutes** (`mo-senate-web`). During a 15-minute audit on 2026-07-31, the bill count, roll-call count and vote-cast count all changed underneath the auditor. Any count typed into a document is wrong within half an hour.

So there are two kinds of truth here, and they live in two different places:

| Question | Answer lives in |
|---|---|
| "How many bills / votes / vote casts do we have **right now**?" | `node --env-file=.env scripts/data-status.js` |
| "What *is* a bill row? Why is that number different from this one? What's missing and why?" | **This document.** |

**The counts printed below are a snapshot from 2026-07-31 and exist only to show you the shape and the ratios.** Treat them as "about this many," never as current fact. Do not copy them into other docs — that is exactly how the confusion started.

Three counts move constantly and must **never** be hardcoded anywhere: `bills`, `votes`, `vote_casts`.

---

## The 30-second version

VisibleGov holds **a very strong voting record and a very small explanation layer.**

- We have **every recorded roll-call vote** for the Missouri legislature back to 2015 and the US Congress back to 2025 — about **1.47 million individual legislator votes** across roughly **9,980 roll calls**. Within the years covered, this is essentially complete: on an average roll call we have a position recorded for ~158 of Missouri's 163 House members and 99.99 of the Senate's 100.
- We have **~38,266 bills**, but most bills never get a floor vote. About **3,341** got a passage vote — those are the ones that matter for holding someone accountable.
- We have the **official text** of about **3,630** bills.
- We have a **plain-language summary published for 39 bills.** That is the product's core promise and it is the thinnest part by far — 0.10% of all bills, and all 39 come from just 2 of our 33 legislative sessions.
- We can identify **~1,568 distinct legislators**, but **555 of them have no votes on file** (mostly historical US senators whose service predates our federal coverage window), and **none of them have a photo or contact info**.

The short version of the honest gap: **if you look up a legislator, you'll almost certainly see a real voting record. If you click one of those votes hoping for a plain-language explanation, you almost certainly won't find one yet.**

---

## The relationships — why so many different numbers all mean "how much data do we have"

This section is the reason this document exists. None of these numbers contradict each other. They count **different things**.

### 1. The bill funnel

Each layer is a subset of the layer above it *except where noted*. Percentages are of all bills.

```
 38,266   bills in the database                      100%
          ↓  (−34,392)  most bills are introduced and die without a recorded floor vote
  3,874   bills with ≥1 recorded roll call of any kind  10.1%
          ↓  (−533)     these only ever got procedural votes, not a vote on passage
  3,341   bills with a PASSAGE / third-reading vote      8.7%   ← the accountability universe
          ↓  (−3,283)   the summarization pipeline simply hasn't been run on them yet
     58   passage bills with any summary                 0.15%
          ↓
     39   bills with a PUBLISHED plain-language summary   0.10%
```

And running alongside, not inside, that funnel:

```
  3,630   bills whose official text we have stored        9.5%
```

**The four traps in that funnel:**

- **"Bills with text" is not a stage of the funnel.** Text is only ever fetched for a bill that *already has a vote* — verified: zero text-bearing bills lack a vote. So text ⊂ voted. But text is **not** a subset of *passage*: 311 text-bearing bills have a vote that isn't a passage vote. Text (3,630) and passage (3,341) **overlap**; neither contains the other.
- **The famous "99.3%" figure has a small denominator.** 3,319 of 3,341 passage-vote bills have text = 99.3%. That is *not* 99.3% of bills. Text coverage across all bills is **9.5%**.
- **3,341 is not a Missouri number.** It is Missouri 3,177 + federal 164. (An earlier README labelled it "Missouri" — wrong.)
- **74 summary rows, 39 published.** There is exactly one summary row per bill, so "summaries" and "bills with a summary" are the same number. The other 35 are drafts (see §"draft ≠ flagged" below).

**Why federal and Missouri sit at opposite ends of the funnel:**

- **Federal bills only exist in our database because a roll call referenced them.** All 478 federal bills have a vote. This is *not* a corpus of the 119th Congress — it is "bills that were voted on."
- **Missouri is the inverse.** ~37,787 Missouri bills came from LegiScan's bulk datasets, and only 3,396 of them (9.0%) ever got a recorded roll call.

Those two facts are why a single "% of bills with a vote" number is meaningless without saying which jurisdiction.

### 2. `votes` vs `vote_casts` — the 9,980 vs 1.47-million confusion

- **`votes` (~9,981)** = **roll calls**. The *event*: "the Missouri House voted on HB 1234 on 2026-03-04."
- **`vote_casts` (~1,465,333)** = **one legislator's position on one roll call**. Rep. Smith voted Yea.

A doc saying "9,980 votes" and a doc saying "1.46 million votes" are both correct and are describing different things. Use the words **roll calls** and **vote casts** and the ambiguity disappears.

Note also: 444 roll calls have no bill attached at all (nominations, cloture, adjournment — mostly US Senate). They are legitimate votes with nothing to link to.

### 3. Legislator ROWS vs PERSONS — the one that caused the most confusion

**Every legislator in the database is fully identified. `persons` is not a roster.**

Here is the actual model:

- **`legislators` (~1,607 rows)** — one row per legislator **per source system**. Every single row carries a real identity key from its source: a `bioguide_id` (Congress), a `legiscan_people_id`, an `mo_senate_id`, an `mo_house_id` or an `openstates_id`. **Zero rows are unidentified.** This is the roster.
- **`persons` (37 rows)** — a person row is created **only when two or more legislator rows are proven to be the same human**. It is a *merge record*, not a profile.
- **`person_links` (76 rows)** — the edges connecting merged rows to their person.

So, in plain language: **most legislators appear in exactly one source, so they need no unification and correctly have no `persons` row.** A `persons` row is the exception, created for the ~76 rows where one human showed up in more than one source system — e.g. Robert F. Onder appears four times (LegiScan, MO Senate, Congress's bioguide, OpenStates) and is unified into a single person carrying all 1,850 of his casts.

**"37 legislators identified" is a misreading. The correct count of distinct humans is:**

```
1,531  legislator rows with no person link (each = one distinct human, fully identified)
+  37  merged persons (each covering 2–4 rows, = one distinct human)
─────
 1,568  distinct people you can look up
```

1,568 is an **upper bound** — 4 identity clusters are still unresolved, so a few of those 1,531 may turn out to be duplicates. It is never 37, and 1,607 overcounts by at least 39.

### 4. `status` vs `verdict` — "draft" ≠ "flagged"

These live in **different tables** and mean different things:

- **`status`** is on the content row (`summaries`, `glossary_terms`): `draft` or `published`.
- **`clean` / `flagged` / `complete` / `incomplete`** are **verdicts** on a *verification* row (`summary_verifications`, `glossary_verifications`).

**There is no "flagged" status.** A phrase like "35 draft/flagged summaries" collapses two axes and makes 35 problems out of 20. The real breakdown of the 35 drafts:

| | Count | Meaning |
|---|---|---|
| Adverse verdict | **20** | 19 support-flagged + 1 completeness-incomplete. Genuinely needs review. |
| Clean, not yet published | **14** | Passed accuracy; would likely publish. |
| Never verified | **1** | No verification row exists. |

**The integrity result, stated plainly: all 20 adverse-verdict summaries are drafts. Zero published summaries carry an adverse verdict. The gate held.**

The glossary is the one asymmetric case: **8 of 116 published glossary terms carry a flagged verdict.** Those were hand-adjudicated (19 `edited` + 2 `rejected` actions are recorded) rather than auto-published — consistent with the trust model, but it is a real difference from the summary pipeline and should not be assumed away.

### 5. Glossary terms vs glossary *entries*

- **847 `glossary_terms` rows** — statutes, acts, agencies and programs that bills reference.
- **116 of them are actually written.** The other **731 are bare stubs**: verified, every single one has `gloss_md` NULL *and* `source_url` NULL. They are placeholders naming a term, not unreviewed writing.
- **704 of the 731 are blocked on an unresolvable citation** — there is no official source URL to gloss *from*. That is blocked on a human mapping decision, not on review or on API spend.

"847 glossary terms" overstates real content roughly 7×. Say **116 entries**.

### 6. Materialized views are snapshots, not tables

`public_position_totals`, `public_party_alignment` and `public_party_position_totals` are **materialized views** — frozen aggregates that only match the live tables immediately after `npm run refresh:aggregates` runs.

**This is where the stale docs came from.** The figure "1,465,102 vote casts" that appeared in `README.md` and `docs/ARTIFACTS.md` is *exactly* the sum of `public_position_totals` — a stale snapshot, not the vote_casts table. The gap grows with every cron tick (measured at 198, then 231, within one audit).

Nothing in the database records *when* the matviews were last refreshed. Any number sourced from them is "as of an unknown time."

---

## Every table, with plain-language descriptions

Counts are the 2026-07-31 snapshot. **★ = moves constantly; never hardcode.**

### Core civic data

| Table | Rows | What it is |
|---|---:|---|
| `jurisdictions` | 2 | The only two governments covered: `us-congress`, `mo-legislature`. |
| `sessions` | 33 | Legislative sessions. 1 federal (119th Congress) + 32 Missouri (2010–2026 regular and special). |
| `bills` | ★ ~38,266 | One row per bill per session. Most were never voted on. |
| `bill_texts` | 3,630 | Stored official bill text with a SHA-256 hash and source URL. Exactly one version per bill. |
| `bill_actions` | 780 | Legislative history / action steps. **Covers only 113 bills** — see gaps. |
| `bill_sponsors` | 46,268 | Sponsor and cosponsor links. Covers 38,232 bills (99.9%). |
| `votes` | ★ ~9,981 | **Roll calls** — the vote *event*. 444 have no bill attached. |
| `vote_casts` | ★ ~1,465,333 | **One legislator's position on one roll call.** The largest table. |

### People

| Table | Rows | What it is |
|---|---:|---|
| `legislators` | 1,607 | One row **per source system** per legislator. Every row is identified. |
| `terms` | 1,087 | Service records: chamber, district, party, state, dates. One per legislator row that has one. |
| `persons` | 37 | **Merge records only** — created when ≥2 legislator rows are the same human. Not a roster. |
| `person_links` | 76 | The edges: legislator row → person. 1,531 rows correctly have none. |
| `identity_flags` | 16 | Same-surname clusters the auto-merger refused to decide. **4 open**, 12 resolved. |
| `districts` | **0** | **Empty. Never populated.** Address lookup runs off `terms.state` / `terms.district` instead. |

### Plain-language layer

| Table | Rows | What it is |
|---|---:|---|
| `summaries` | 74 | Plain-language bill summaries. One per bill. **39 published, 35 draft.** |
| `summary_verifications` | 113 | Adversarial verification results on two axes: accuracy (support) and coverage (completeness). |
| `summary_notes` | 78 | Adjudication trail: 39 `approved` + 39 `published`. |
| `summary_terms` | 974 | Summary → glossary-term links, across 72 of the 74 summaries. |
| `glossary_terms` | 847 | Statutes/acts/agencies bills reference. **116 written, 731 bare stubs.** |
| `glossary_verifications` | 116 | One per published term: 108 clean, 8 flagged. |
| `glossary_notes` | 266 | Adjudication trail: 123 approved, 122 published, 19 edited, 2 rejected. |

### Operations and provenance

| Table | Rows | What it is |
|---|---:|---|
| `ingestion_runs` | 397 | Every pipeline run, with status and JSON detail, across 20 sources. |
| `legiscan_datasets` | 31 | LegiScan bulk-dataset cache ledger — one per Missouri session. |
| `vote_reconciliation_flags` | 9 | Cross-source vote-tally discrepancies. **All 9 open**, 0 resolved, covering 7 distinct roll calls. |

### Views and materialized views

| Object | Rows | What it is |
|---|---:|---|
| `public_vote_feed` | ★ = `vote_casts` | Plain view joining casts → roll calls → bills. Row count always equals `vote_casts`. |
| `public_position_totals` | 11,444 | **MATVIEW** — casts per legislator / chamber / year / position. Stale until refreshed. |
| `public_party_alignment` | 3,042 | **MATVIEW** — how often a legislator votes with their party's majority. |
| `public_party_position_totals` | 198 | **MATVIEW** — casts per party / chamber / year / position. |
| `public_freshness` | 20 | Latest run status per ingestion source. |
| `public_verification_notes` | 68 | Verification metadata, scoped to published summaries only. |
| `public_reconciliation_flags` | 9 | Reconciliation flags exposed publicly. |

> **Gone:** migration 0003's `ingestion_freshness` view no longer exists — 0016 dropped it and replaced it with `public_freshness`. Don't go looking for it.

### One provenance warning

`run_id` on a row is the **last run that wrote it, not the run that created it.** Grouping bills by `run_id` today attributes 37,662 of them to a data-correction run that merely patched their status field. Never read `run_id` as origin.

---

## Coverage and honest gaps

### Date ranges — what years we actually cover

| Chamber | First roll call | Last roll call | Roll calls | Casts | Avg members per roll call |
|---|---|---|---:|---:|---|
| Missouri House | 2015-01-15 | 2026-05-15 | 6,590 | 1,038,737 | 157.6 of 163 |
| Missouri Senate | 2016-01-07 | 2026-05-15 | 1,876 | ~60,833 | 32.3 of 34 |
| US House | 2025-01-03 | 2026-07-23 | 645 | 278,842 | 432.3 of 435 |
| US Senate | 2025-01-09 | 2026-07-27 | 869 | 86,888 | 99.99 of 100 |

Every roll call carries a real date — zero NULLs, and the old `1969-12-31` sentinel dates are fully cleared.

**The per-member averages are the honest completeness signal:** within the years covered, every chamber lands within a couple of members of its full roster. The vote record is not thin where it exists.

### The year gaps

**GAP 1 — Missouri House 2024 is entirely absent.** LegiScan's 2024 session held 351 roll calls. We stored 76 (all Senate). The other **275 (all House) were refused** because LegiScan prints their date as `0000-00-00`. The decision was to refuse rather than invent dates. Result: Missouri 2024 shows ~2,500 casts against ~100,000 in neighbouring years. It is *absent*, not thin.

**GAP 2 — Missouri 2010–2014 has bills but zero votes.** ~8,985 bills exist across the 2010–2014 regular sessions (and ~9,079 including six special sessions) with **no roll calls at all**. This is a **source** gap, not an ingestion miss: all 31 LegiScan datasets were fetched, and every one of those sessions' ingest runs reports `rollCallsPlanned = 0`. Nothing to recover without a different source. **The Missouri bill record starts in 2010; the Missouri vote record starts in 2015.**

**GAP 3 — federal history does not exist.** All 365,730 federal casts are 119th Congress (2025→). A senator's pre-2025 record simply is not here. Widening it means more Congress.gov / senate.gov ingestion — free, polite, slow.

**GAP 4 — Missouri Senate has no 2015.** The journals-first pipeline starts in 2016.

### The summary funnel and the reason for each drop

| Stage | Count | Why we lose the ones we lose |
|---|---:|---|
| Bills in the database | ~38,266 | — |
| ↓ have any recorded roll call | 3,874 | **−34,392.** Introduced and died without a floor vote. This bucket also swallows all of Missouri 2010–2014, where no source has roll calls. |
| ↓ have a passage / third-reading vote | 3,341 | **−533.** Only ever got procedural votes, so they are not accountability-relevant under the pool definition. |
| ↓ have official text on hand | 3,319 | **−22.** 21 refused by the 400,000-character oversize gate + 1 image-only PDF that extracted zero characters. Nothing was ever silently truncated. |
| ↓ have any summary row | 58 | **−3,283.** Pure volume — the pipeline just hasn't been run. 3,261 of these already have text and are ready to go. |
| ↓ **published** | **39** | **−19.** 35 rows sit in draft awaiting review (20 with an adverse verdict, 14 clean, 1 unverified). |

**The concentration problem is worse than the count suggests.** All 39 published summaries come from **2 of 33 sessions**: 28 from Missouri's 2026 session and 11 from the 119th Congress. **Every other session — all of Missouri 2010 through 2025, roughly 1,090,000 vote casts — has zero published summaries.** Someone reading a Missouri legislator's 2019 record sees real votes on bills with no explanation whatsoever. That is the single largest gap between the product promise and what exists.

Also: **3 of the 39 published-summary bills have a NULL title**, so the page renders a summary under a bare bill number.

### Quarantined, refused and flagged items

| Item | Count | Status |
|---|---:|---|
| Missouri House 2024 roll calls refused | **275** | Refused on `0000-00-00` source dates. Deliberate. |
| MO Senate journal days quarantined | **11** | Failed to parse 3+ times; held out of the published record by design. |
| Passage bills with no text | **22** | 21 oversize refusals + 1 image-only PDF. |
| Vote-reconciliation flags | **9 open / 0 resolved** | Cross-source tally discrepancies over 7 roll calls (LegiScan vs MO House XML ×5, vs MO Senate web ×4). |
| Identity flags | **4 open / 12 resolved** | Clusters: Brown (3 rows), Moore (2), Johnson (2), Menendez (2 — an informational keep-separate ruling). |
| Roll calls with zero individual casts | **152** | 95 OpenStates 2022 events (source has no per-voter data) + 57 MO House XML 2026 where only the aggregate tally was captured. A user opening these sees a result with no names. |

### Structural defects worth knowing about

These are real problems, not design choices:

1. **The Missouri 2026 session is split across two session rows, and the split is growing.** Session `'261'` (LegiScan) and session `'2026'` (MO Senate journals) both cover 2026. `'2026'` is the **only** Missouri session with no `legiscan_session_id` — that is the tell. It duplicates 16 bills, 17 roll calls and ~561 casts already present under `'261'`, and the cron is actively feeding it. (Missouri 2018 had the same adapter collision and *was* merged correctly, which is the model for the fix.)
2. **Cross-source roll-call duplication beyond that split.** 106 `(bill, date, chamber)` groups span multiple adapters and carry **166 extra roll-call rows**, 33 of them passage votes. `vote_reconciliation_flags` exists to catch exactly this class and has flagged only 9 — roughly 4% of the overlap. Not a claim that all 166 are wrong (some may be genuinely distinct motions), but "every row traceable to an official source" does not currently guarantee "exactly one row per real roll call."
3. **2,005 bills have both a NULL title and a NULL canonical URL** — 1,986 of them in Missouri session `'261'`, which is **62.8% of the current 2026 session**. 209 are already reachable from a roll call, 190 have stored text, and 3 already carry a published summary. They render as a bare bill number with no "read the official bill" link.
4. **`bill_actions` is effectively empty** — 780 rows over 113 of ~38,266 bills (0.3%), all Missouri, all 2025–2026. There is no "what happened to this bill" timeline for 99.7% of bills.
5. **Legislator profiles have no photos and no contact info** — `image_url` and `contact` are NULL on all 1,607 rows. `districts` is empty. One row still displays a raw bioguide code (`G000578`) as its name.
6. **555 of 1,607 legislator rows have zero votes** (1,015 of 1,568 lookup-able people have a record; 553 render empty). **352 of those are historical US senators** — the senate.gov adapter created rows for members named in historical rosters, but we only ingested 119th-Congress roll calls. Exactly one *currently serving* legislator has an empty shell, and it is a duplicate row already merged into a person with 1,850 casts.
7. **318 legislator rows have votes but no term row** — their profile shows a voting record with no office, chamber or district attached. 482 of 1,568 entries have no term at all.
8. **Party vocabulary is unnormalized** — `R` (391) and `Republican` (469) and `D` (209) and `Democratic` (463) coexist, plus 65 NULLs, one `Independent Democrat` and one empty string. The party aggregates map R→Republican and D→Democratic but **41,514 casts fall out of every party total silently.**
9. **Current-seat coverage is nearly complete but not perfectly.** US Senate 100/100. US House 437, of which 5 non-voting delegates have null state *and* district, so address lookup cannot match them. Missouri House 159 of 163 seats (districts 95, 110, 114, 160 have no current-term row). Missouri Senate covers all 34 districts but has 35 rows — district 2 carries two overlapping current terms. And 194 terms have no start date, 731 no end date, so "current" is partly inferred rather than proven.
10. **`legiscan_datasets` is publicly readable including its `local_cache_path` column** — a filesystem path on the operator's own machine, exposed on the public API. Not civic-data leakage, but it should not be there.

### What the public can actually see

Measured with the anonymous key, not assumed:

- **Fully public:** bills, sponsors, actions, roll calls, vote casts, the vote feed, legislators, terms, persons, sessions, jurisdictions, summary→term links, and all three aggregate matviews.
- **Gated to zero rows:** `bill_texts`, `ingestion_runs`, all notes and verifications, `identity_flags`, `person_links`, `vote_reconciliation_flags`.
- **Filtered:** `summaries` shows 39 of 74 (published only); `glossary_terms` shows 116 of 847 (published only).
- **Two deliberate view bypasses:** `public_freshness` (20 rows) and `public_reconciliation_flags` (9 rows) expose data whose *base tables* are anon-gated. Documented design choices, but the two places where "the base table is private" does not mean the data is private.

---

## Numbers that look alarming but are fine

Several counts in the ledgers read like data loss and are not. Checking these once, here, should stop the recurring panic.

**"275 Missouri House 2024 roll calls refused."** LegiScan prints those roll calls with the date `0000-00-00`. There is no honest way to derive a real date. Storing them with a fabricated or sentinel date would put wrong dates on the public record. **Refusing is the correct behavior.** The gap is real and is documented above; the refusal is not a bug.

**"21 bills refused for oversize text."** A 400,000-character ceiling on stored text. Missouri's SRB 975 is 751,225 characters; the federal S 1071 is 3,492,102. The alternative to refusing is silently truncating, which would mean summarizing half a bill and calling it the bill. **Nothing was ever truncated.** Correct by design.

**"11 MO Senate journal days quarantined."** Days whose journal PDF failed to parse cleanly three or more times, deliberately held out rather than published as a partial or garbled vote record. Correct by design, and each quarantined day is named in the run record.

**"1,813 LegiScan roll calls refused over an unknown `NV` vote code."** This was a first-contact fail-loud on an unrecognized vote value — the pipeline stopped rather than guessing what `NV` meant. **It was fixed and every affected session re-ingested to `succeeded` with zero reconciliation failures.** Not missing today.

**"3,474 unresolved US Senate cast entries."** Resolved. The final us-senate run reports 20,997 resolved / **0 unresolved**, and the live average of 99.99 senators per roll call confirms it.

**"17,585 unresolved casts in mo-house-xml."** An artifact of re-counting. This is a **single stuck artifact** (~158 surname-only casts with null districts, source key `mo-house-xml-HB1800-4`) being retried on every run, and the 17,585 figure is that same ~158 counted across 122 runs. Roughly 158 casts are genuinely not stored — not 17,585.

**"1969-12-31 dates" and "numeric bill status codes."** Both cleaned up. Zero sentinel dates and zero NULL vote dates remain. 37,662 bills had numeric LegiScan status codes converted to words; **36 bills still show status `0` deliberately**, because LegiScan's codebook has no word for code 0 and inventing one would be editorializing. 18 have a NULL status.

**"`enrich-federal-bills` status: partial"** and **"`gloss` has never succeeded."** These pipelines record per-item failures and continue by design, so `partial` is their normal healthy outcome, not a failure. 476 of 478 federal bills have a status; the 2 without are the fake `QUORUM` / `ADJOURN` pseudo-bills that Congress.gov returns 404 for.

**"444 roll calls have no bill."** Nominations, cloture motions, adjournment — 443 US Senate and 1 US House. Real votes that genuinely have no bill to attach to.

**"Only 8 of 116 published glossary terms are flagged, but zero published summaries are."** Not an inconsistency. Glossary terms were hand-adjudicated (19 edited, 2 rejected on the way through) under the review model; summaries auto-publish only on a clean verdict. Different pipelines, both intentional — but state it rather than assume it.

---

## How to check this yourself

```bash
node --env-file=.env scripts/data-status.js
```

That script queries the live database and prints the current counts, the funnel, and the open-flag totals. **It is the source of truth for any number.** This document is the source of truth for what those numbers *mean*.

Two rules that keep this from breaking again:

1. **Do not hand-edit counts into `README.md`, `docs/ARTIFACTS.md`, `TODO.md`, or anywhere else.** Those files should link here and to the script. Every count previously written into prose went stale within a day, and the "1,465,102 vote casts" figure that appeared in two files was a stale materialized-view sum that nobody could trace.
2. **If the aggregate matviews and the tables disagree, run `npm run refresh:aggregates`.** The matviews back the profile charts, so when they lag, a legislator's chart under-reports activity that the vote list beside it displays correctly — a visible self-contradiction on the public site.

Anything that restates a count in prose will be wrong again within 30 minutes. Only two things should ever be trusted for live numbers: the status script, and `site/js/trust-page.js`, which counts from the database at page load and is the one number source in the repo that cannot go stale.