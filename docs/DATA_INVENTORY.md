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

**The counts printed below are a snapshot from 2026-08-03 (re-verified against the live database via `node --env-file=.env scripts/data-status.js` plus direct Supabase REST count queries for everything that script doesn't print; supersedes the 2026-08-02 snapshot) and exist only to show you the shape and the ratios.** Treat them as "about this many," never as current fact. Do not copy them into other docs — that is exactly how the confusion started.

Three counts move constantly and must **never** be hardcoded anywhere: `bills`, `votes`, `vote_casts`.

---

## The 30-second version

VisibleGov holds **a very strong voting record and a small but rapidly-growing explanation layer.**

- We have **every recorded roll-call vote** for the Missouri legislature back to 2015 and the US Congress back to 2025 — about **1.47 million individual legislator votes** across roughly **10,032 roll calls** (was ~10,022 at 08-02 — MO ingestion is the only thing still moving this number; US House and US Senate roll-call counts are byte-for-byte unchanged again this pass, same as 08-02). Within the years covered, this is essentially complete: on an average roll call we have a position recorded for ~157 of Missouri's 163 House members and 100 of the US Senate's 100.
- We have **~38,254 bills**, but most bills never get a floor vote. About **3,341** got a passage vote — those are the ones that matter for holding someone accountable. This number, and the entire bill/summary funnel below it, is **byte-for-byte unchanged from the 08-02 snapshot** — re-verified live, every stage matched exactly (38,254 → 3,870 → 3,341 → 3,319 → 197 → 107/115). Growth since 08-02 is entirely in vote-volume tables (`votes`, `vote_casts`, `bill_actions`, `ingestion_runs`), not in bills or summaries.
- We have the **official text** of about **3,630** bills.
- We have a **plain-language summary published for 115 bills** (out of 213 summary rows total). That is the product's core promise, and while it is still a small slice of all bills — 0.30% — it has grown nearly 3× since the 2026-07-31 snapshot (was 39) and is **no longer concentrated in just 2 sessions**: published summaries now span 12 of our 32 legislative sessions (see "The concentration problem" below for the honest remaining skew).
- **New this pass: every published bullet now carries a clickable exact-quote citation back to the bill text.** Migration 0021 (bullet-citation exposure) is confirmed fully live — re-verified live via `node --env-file=.env scripts/probe-public-surface.js`: the `citations` column on `public_verification_notes` is present, correctly gated on `overall='clean'`, and shape-checked against all 220 real rows with **0 violations**. `trust.html`'s receipt claim ("the exact quoted excerpt it came from") is now literally true for bill-summary bullets, not just glossary terms.
- We can identify **~1,568 distinct legislators**, but **555 of them have no votes on file** (386 carry a federal `bioguide_id`, mostly historical US senators/House members whose service predates our federal coverage window; 169 are Missouri-sourced), and **none of them have a photo or contact info** (by design — see the structural-defects note below). All of these figures re-verified live, exact match to 08-02.

The short version of the honest gap: **if you look up a legislator, you'll almost certainly see a real voting record, and if you click one of those votes hoping for a plain-language explanation with a receipt, the odds are much better than they were a few days ago — but it's still a minority of votes, and until migration 0022 lands (see structural defect #2 below), a meaningful slice of the vote-aggregate percentages behind those charts are quietly double-counting cross-adapter duplicate votes.**

---

## The relationships — why so many different numbers all mean "how much data do we have"

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

- **"Bills with text" is not a stage of the funnel.** Text is only ever fetched for a bill that *already has a vote* — verified: zero text-bearing bills lack a vote. So text ⊂ voted. But text is **not** a subset of *passage*: 311 text-bearing bills have a vote that isn't a passage vote. Text (3,630) and passage (3,341) **overlap**; neither contains the other.
- **The famous "99.3%" figure has a small denominator.** 3,319 of 3,341 passage-vote bills have text = 99.3%. That is *not* 99.3% of bills. Text coverage across all bills is **9.5%**.
- **3,341 is not a Missouri number.** It is Missouri 3,177 + federal 164 — unchanged from the 2026-07-31 snapshot, re-verified live. (An earlier README labelled it "Missouri" — wrong.)
- **213 summary rows, 115 published.** There is exactly one summary row per bill, so "summaries" and "bills with a summary" are the same number. The other 98 are drafts (see §"draft ≠ flagged" below — as of this pass, every one of those 98 carries an adverse verdict; nothing clean is sitting unpublished).

**Why federal and Missouri sit at opposite ends of the funnel:**

- **Federal bills only exist in our database because a roll call referenced them.** All 482 federal bills have a vote (up from 478 — 4 more federal bills entered the database since 07-31, all via a roll call, same pattern). This is *not* a corpus of the 119th Congress — it is "bills that were voted on."
- **Missouri is the inverse.** ~37,772 Missouri bills came from LegiScan's bulk datasets, and only 3,388 of them (9.0%) ever got a recorded roll call.

Those two facts are why a single "% of bills with a vote" number is meaningless without saying which jurisdiction.

### 2. `votes` vs `vote_casts` — the 10,022 vs 1.47-million confusion

- **`votes` (~10,032)** = **roll calls**. The *event*: "the Missouri House voted on HB 1234 on 2026-03-04."
- **`vote_casts` (~1,466,730)** = **one legislator's position on one roll call**. Rep. Smith voted Yea.

A doc saying "10,022 votes" and a doc saying "1.47 million votes" are both correct and are describing different things. Use the words **roll calls** and **vote casts** and the ambiguity disappears.

Note also: 445 roll calls have no bill attached at all (444 US Senate, 1 US House — nominations, cloture, adjournment). They are legitimate votes with nothing to link to.

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

**There is no "flagged" status.** A phrase like "98 draft/flagged summaries" collapses two axes. The real breakdown of the 98 drafts, re-verified live 2026-08-02:

| | Count | Meaning |
|---|---|---|
| Adverse verdict | **98** | 67 support-flagged only + 27 completeness-incomplete only + 4 flagged on both axes. Genuinely needs review. |
| Clean, not yet published | **0** | — |
| Never verified | **0** | — |

**This is a change in kind, not just in scale.** The 2026-07-31 snapshot had 14 clean-but-unpublished drafts and 1 never-verified draft — a real backlog. That backlog was cleared in a 2026-08-02 review-queue pass (see `TODO.md` NOW section): every draft with a clean verdict on both axes auto-published, and the trust model's auto-publish gate now runs to completion instead of leaving clean items sitting in draft. **The result: every summary still in draft status carries an adverse verdict, and every published summary carries zero adverse verdicts — nothing sits in an ambiguous middle state.** The gate held, and now it's also caught up.

The glossary is the one asymmetric case: **8 of 116 published glossary terms carry a flagged verdict.** Those were hand-adjudicated (19 `edited` + 2 `rejected` actions are recorded) rather than auto-published — consistent with the trust model, but it is a real difference from the summary pipeline and should not be assumed away.

### 5. Glossary terms vs glossary *entries*

- **2,219 `glossary_terms` rows** (was 847 in the 2026-07-31 snapshot) — statutes, acts, agencies and programs that bills reference. The growth tracks the summary-volume growth directly: `extract-terms` mints a term row for every distinct citation a new summary references, and summary volume went from 74 to 213 rows over the same window.
- **116 of them are actually written** — unchanged from 07-31, no new glossing has run. The other **2,103 are bare stubs**: verified, every single one has `gloss_md` NULL *and* `source_url` NULL. They are placeholders naming a term, not unreviewed writing.
- **2,072 of the 2,103 are blocked on an unresolvable citation** — there is no official source URL to gloss *from*. That is blocked on a human mapping decision, not on review or on API spend. (98.5% of the stubs, up slightly from 96.3% at 07-31 — the backlog is growing in step with summary volume, not shrinking.)

"2,219 glossary terms" overstates real content roughly 19× (was ~7× at 847). Say **116 entries** — that number itself hasn't moved.

### 6. Materialized views are snapshots, not tables

`public_position_totals`, `public_party_alignment` and `public_party_position_totals` are **materialized views** — frozen aggregates that only match the live tables immediately after `npm run refresh:aggregates` runs.

**This is where the stale docs came from.** The figure "1,465,102 vote casts" that appeared in `README.md` and `docs/ARTIFACTS.md` is *exactly* the sum of `public_position_totals` — a stale snapshot, not the vote_casts table. The gap grows with every cron tick (measured at 198, then 231, within one audit).

Nothing in the database records *when* the matviews were last refreshed. Any number sourced from them is "as of an unknown time."

---

## Every table, with plain-language descriptions

Counts are the 2026-08-03 snapshot (re-verified live; supersedes 2026-08-02). **★ = moves constantly; never hardcode.**

### Core civic data

| Table | Rows | What it is |
|---|---:|---|
| `jurisdictions` | 2 | The only two governments covered: `us-congress`, `mo-legislature`. |
| `sessions` | 32 (was 33) | Legislative sessions. 1 federal (119th Congress) + 31 Missouri. **Down by one: the duplicate MO 2026 session (`'2026'`) was merged into `'261'` and deleted — see structural defect #1, now RESOLVED.** |
| `bills` | ★ ~38,254 | One row per bill per session. Most were never voted on. |
| `bill_texts` | 3,630 | Stored official bill text with a SHA-256 hash and source URL. Exactly one version per bill. |
| `bill_actions` | 1,051 (was 1,020) | Legislative history / action steps. **Covers only 142 bills (0.4%)** — see gaps. Grew but the coverage ratio barely moved. |
| `bill_sponsors` | 46,268 | Sponsor and cosponsor links. Covers 38,232 bills (99.9%) — unchanged. |
| `votes` | ★ ~10,032 | **Roll calls** — the vote *event*. 445 have no bill attached (unchanged). |
| `vote_casts` | ★ ~1,466,730 | **One legislator's position on one roll call.** The largest table. |

### People

| Table | Rows | What it is |
|---|---:|---|
| `legislators` | 1,607 | One row **per source system** per legislator. Every row is identified. Unchanged from 07-31. |
| `terms` | 1,087 | Service records: chamber, district, party, dates. One per legislator row that has one. Unchanged from 07-31. |
| `persons` | 37 | **Merge records only** — created when ≥2 legislator rows are the same human. Not a roster. Unchanged from 07-31. |
| `person_links` | 76 | The edges: legislator row → person. 1,531 rows correctly have none. Unchanged from 07-31. |
| `identity_flags` | 16 | Same-surname clusters the auto-merger refused to decide. **4 open**, 12 resolved — unchanged from 07-31, re-verified live. |
| `districts` | **0** | **Empty. Never populated, by design** — re-confirmed 2026-08-02, the site never reads it. Address lookup runs off `terms.district` instead. |

### Plain-language layer

| Table | Rows | What it is |
|---|---:|---|
| `summaries` | 213 (was 74) | Plain-language bill summaries. One per bill. **115 published, 98 draft.** |
| `summary_verifications` | 378 (was 113) | Adversarial verification results on two axes: accuracy (support) and coverage (completeness). |
| `summary_notes` | 230 (was 78) | Adjudication trail: 115 `approved` + 115 `published`. |
| `summary_terms` | 3,228 (was 974) | Summary → glossary-term links, across 211 of the 213 summaries. |
| `glossary_terms` | 2,219 (was 847) | Statutes/acts/agencies bills reference. **116 written, 2,103 bare stubs.** |
| `glossary_verifications` | 116 | One per published term: 108 clean, 8 flagged. Unchanged from 07-31. |
| `glossary_notes` | 266 | Adjudication trail: 123 approved, 122 published, 19 edited, 2 rejected. Unchanged from 07-31 — no new hand-adjudication has run. |

### Operations and provenance

| Table | Rows | What it is |
|---|---:|---|
| `ingestion_runs` | 581 (was 563) | Every pipeline run, with status and JSON detail, across 21 sources (unchanged — see freshness table). |
| `legiscan_datasets` | 31 | LegiScan bulk-dataset cache ledger — one per Missouri session. Unchanged since 07-31, genuinely one-per-session (the 2026 duplicate that shared this count is gone; see structural defect #1). |
| `vote_reconciliation_flags` | 49 (unchanged since 08-02) | Cross-source vote-tally discrepancies. **All 49 open**, 0 resolved, covering 45 distinct roll calls (unchanged) — 16 LegiScan-vs-MO-House-XML, 33 LegiScan-vs-MO-Senate-web, both counts re-verified live this pass. No new flags surfaced since 08-02 — see structural defect #2. |

### Views and materialized views

| Object | Rows | What it is |
|---|---:|---|
| `public_vote_feed` | ★ = `vote_casts` (~1,466,730) | Plain view joining casts → roll calls → bills. Row count always equals `vote_casts`. **Does not yet exclude cross-adapter duplicate votes** — that exclusion is written into migration 0022 but the migration isn't applied; see structural defect #2. |
| `public_position_totals` | 11,466 (was 11,463) | **MATVIEW** — casts per legislator / chamber / year / position. Stale until refreshed. **Currently double-counts cross-adapter duplicate votes in every percentage** — unfixed until migration 0022 lands; see structural defect #2. |
| `public_party_alignment` | 3,042 | **MATVIEW** — how often a legislator votes with their party's majority. Unchanged since 07-31. Same double-counting exposure as above. |
| `public_party_position_totals` | 198 | **MATVIEW** — casts per party / chamber / year / position. Unchanged since 07-31. Same double-counting exposure as above. |
| `public_freshness` | 21 | Latest run status per ingestion source. Unchanged since 08-02. |
| `public_verification_notes` | 220 (was 68) | Verification metadata, scoped to published summaries only. **As of migration 0021 (confirmed live this pass), also carries the `citations` column** — per-bullet exact-quote text, gated on `overall='clean'`, live-checked against all 220 rows with 0 shape/gating violations. |
| `public_reconciliation_flags` | 49 (unchanged since 08-02) | Reconciliation flags exposed publicly — tracks `vote_reconciliation_flags` above exactly. |

> **Gone:** migration 0003's `ingestion_freshness` view no longer exists — 0016 dropped it and replaced it with `public_freshness`. Don't go looking for it.

### One provenance warning

`run_id` on a row is the **last run that wrote it, not the run that created it.** Grouping bills by `run_id` today attributes 37,662 of them to a data-correction run that merely patched their status field. Never read `run_id` as origin.

---

## Coverage and honest gaps

### Date ranges — what years we actually cover

| Chamber | First roll call | Last roll call | Roll calls | Casts | Avg members per roll call |
|---|---|---|---:|---:|---|
| Missouri House | 2015-01-15 | 2026-05-15 | 6,613 | 1,038,741 | 157.1 of 163 |
| Missouri Senate | 2016-01-07 | 2026-05-15 | 1,898 | 61,559 | 32.4 of 34 |
| US House | 2025-01-03 | 2026-07-23 | 645 | 278,842 | 432.3 of 435 |
| US Senate | 2025-01-09 | 2026-07-30 | 876 | 87,588 | 100.0 of 100 |

(All four rows re-verified live 2026-08-03. Missouri House and Senate both grew a little further — expected, that ingestion is on a live cadence. **US House and US Senate are byte-for-byte unchanged, for the second refresh pass in a row** — both sources have been quiet since 07-31. Per-roll-call averages are unchanged in every chamber.)

Every roll call carries a real date — zero NULLs, and the old `1969-12-31` sentinel dates are fully cleared.

**The per-member averages are the honest completeness signal:** within the years covered, every chamber lands within a couple of members of its full roster. The vote record is not thin where it exists.

### The year gaps

**GAP 1 — Missouri House 2024 is entirely absent.** LegiScan's 2024 session held 351 roll calls. We stored 76 (all Senate) — re-verified live 2026-08-02, still exactly 0 House / 76 Senate roll calls for 2024. The other **275 (all House) were refused** because LegiScan prints their date as `0000-00-00`; the decision was to refuse rather than invent dates. **The "275" figure itself is unverified this pass** — refused rows are never written to the database (that's the whole point of "refused"), so there is no live table to re-query for a refusal count; it comes from the original 2026-07-31 ingest-run audit and was accurate then. Result: Missouri 2024 shows ~2,500 casts against ~100,000 in neighbouring years, confirmed still true. It is *absent*, not thin.

**GAP 2 — Missouri 2010–2014 has bills but zero votes.** ~8,985 bills exist across the 2010–2014 regular sessions — re-verified live, exact match. **Correction to the 07-31 snapshot: including special sessions the total is 9,021, not "~9,079 including six special sessions."** Live query finds only **three** MO special sessions fall in the 2010–2014 window (`2010-special-497`, `2011-special-498`, `2013-special-1094`), not six, and 8,985 + 3 specials' bills = 9,021. All 9,021 of these bills — regular and special alike — still have **zero recorded votes**, confirmed live. This is a **source** gap, not an ingestion miss: all 31 LegiScan datasets were fetched, and every one of those sessions' ingest runs reports `rollCallsPlanned = 0`. Nothing to recover without a different source. **The Missouri bill record starts in 2010; the Missouri vote record starts in 2015.**

**GAP 3 — federal history does not exist.** All 366,430 federal casts (was 365,730) are 119th Congress (2025→) — re-verified: the per-year breakdown shows exactly zero federal casts in every year before 2025. A senator's pre-2025 record simply is not here. Widening it means more Congress.gov / senate.gov ingestion — free, polite, slow.

**GAP 4 — Missouri Senate has no 2015.** The journals-first pipeline starts in 2016.

### The summary funnel and the reason for each drop

| Stage | Count | Why we lose the ones we lose |
|---|---:|---|
| Bills in the database | ~38,254 | — |
| ↓ have any recorded roll call | 3,870 | **−34,384.** Introduced and died without a floor vote. This bucket also swallows all of Missouri 2010–2014, where no source has roll calls. |
| ↓ have a passage / third-reading vote | 3,341 | **−529.** Only ever got procedural votes, so they are not accountability-relevant under the pool definition. |
| ↓ have official text on hand | 3,319 | **−22.** 21 refused by the 400,000-character oversize gate + 1 image-only PDF that extracted zero characters. Nothing was ever silently truncated. |
| ↓ have any summary row | 197 | **−3,144.** Pure volume — the pipeline hasn't reached the rest yet. 3,122 passage-vote bills already have text and are ready to go. |
| ↓ **published** (within the passage-vote pool) | **107** | **−90.** 98 rows sit in draft awaiting review, and every one of them carries an adverse verdict (see "draft ≠ flagged" above) — none are clean-and-waiting. (Total published across the whole database is 115 — 8 more sit on bills outside the passage-vote pool by this funnel's own text-matching definition.) |

**The concentration problem has substantially improved, but is not solved.** At 07-31, all 39 published summaries came from 2 of 33 sessions. Re-verified live 2026-08-02: **115 published summaries now span 12 of 32 sessions** — the 119th Congress plus 11 Missouri sessions (2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2025, and 261/2026). Per-session counts: 261 (2026) 38, 2023 15, 119th Congress 19, 2018 11, 2019 6, 2016 6, 2015 5, 2022 5, 2017 4, 2021 2, 2025 3, 2020 1. **It is still lopsided** — MO 2026 alone accounts for a third of all published summaries — but a legislator's 2016–2023 record is no longer guaranteed to be explanation-free the way it was at 07-31. The sessions still at zero are structurally expected to be: all of Missouri 2010–2014 (zero votes exist there at all — GAP 2), every MO special session in the window, and 2024 (GAP 1, the refused-House-dates year).

Also: **0 of the 115 published-summary bills have a NULL title** (was 3 of 39) — **RESOLVED**. The 2026-08-02 title backfill (`backfill-bill-titles.js`, 1,972 of 1,975 NULL titles filled from cached LegiScan data) closed this gap as a side effect.

### Quarantined, refused and flagged items

| Item | Count | Status |
|---|---:|---|
| Missouri House 2024 roll calls refused | **275** (unverified this pass — refused rows are never stored, so there is no live table to re-count; was accurate as of 2026-07-31, and the resulting gap — 0 MO House roll calls in 2024 — is independently re-confirmed live) | Refused on `0000-00-00` source dates. Deliberate. |
| MO Senate journal days quarantined | **12** (was 11) | Failed to parse 3+ times; held out of the published record by design. |
| Passage bills with no text | **22** | 21 oversize refusals + 1 image-only PDF. Unchanged from 07-31. |
| Vote-reconciliation flags | **49 open / 0 resolved** (was 9 open / 0 resolved) | Cross-source tally discrepancies over **45** distinct roll calls (was 7): 16 LegiScan-vs-MO-House-XML, 33 LegiScan-vs-MO-Senate-web. A real, material jump — see structural defect #2. |
| Identity flags | **4 open / 12 resolved** | Clusters: Brown (3 rows), Moore (2), Johnson (2), Menendez (2 — an informational keep-separate ruling). Unchanged from 07-31, re-verified live. |
| Roll calls with zero individual casts | **169** (was 152) | 95 OpenStates events (source has no per-voter data) + 74 MO House XML rows where only the aggregate tally was captured. Growth is ongoing ingestion, not drift. **A 2026-08-02 display fix (`site/js/bill-page.js`, TODO 28) now hides the OpenStates rows on a bill page whenever real cast-bearing data exists elsewhere on that same bill** — so a visitor sees fewer misleading zero-cast rows than this raw count implies; the MO House XML rows are never hidden (they carry a real, specific tally already, with individual casts arriving later on the same row). No underlying data was touched — this is display-only. |

### Structural defects worth knowing about

These are real problems, not design choices:

1. ~~**The Missouri 2026 session is split across two session rows.**~~ **RESOLVED 2026-08-02.** Session `'261'` (LegiScan) and session `'2026'` (MO Senate journals) used to both cover 2026, with `'2026'` carrying no `legiscan_session_id`. Live-verified: `sessions` now holds exactly **one** MO-2026 row (`'261'`) — the duplicate was merged and deleted (34 duplicate bills merged into their canonical twins, 31 votes redirected, 0 orphaned votes independently re-verified) — see `CHATLOG.md` 2026-08-02. The fix landed twice: the first pass closed the existing duplicate, then a still-buggy `ensureSessionRow` re-minted a fresh *empty* `'2026'` row before the root cause was patched; that empty row was confirmed empty and deleted, and the underlying resolver was rewritten to reuse the same year+name logic already proven correct for LegiScan sessions. 12 real scheduler ticks since have created zero duplicates.
2. **Cross-source roll-call duplication beyond that split — the DATA defect is still live, but a fix now exists and is code complete, awaiting Lance's apply step.** This is the same defect tracked as `docs/CONTROLLER_BRIEFING.md` §3 item 5 ("display-time dedup ruled binding, never built") — as of 2026-08-03 it moved from "not started" to "code complete, migration 0022 drafted." **Independently confirmed live this pass** (`node --env-file=.env scripts/probe-public-surface.js`): the probe's own `public_votes` check reports "migration 0022 not applied yet" — so as of this snapshot, the defect described below is still 100% live in production.
   - **What's built, not yet live:** a non-destructive `vote_duplicates` grouping table (migration 0022, draft file only, mirrors the `persons`/`person_links` precedent — neither `votes` row is ever deleted or rewritten), a `public_votes` view and an updated `public_vote_feed` that both exclude the superseded row, and the same exclusion rewritten into the join chain of all three vote-aggregate matviews. A one-time backfill (`correct-data.js vote-duplicates`) targets the existing backlog; live LegiScan ingest going forward marks new duplicates automatically. 43 new tests, 2192→2235, 0 fail. Full sequence Lance still needs to run: apply `supabase/migrations/0022_vote_duplicates.sql` → `node scripts/probe-public-surface.js` → `npm run refresh:aggregates` → `node --env-file=.env src/cli/correct-data.js vote-duplicates --dry-run` then live → `npm run refresh:aggregates` again (full detail: `docs/superpowers/plans/2026-08-03-vote-duplicate-dedup.md`, "Handoff to Lance").
   - **Why it matters more than a display glitch:** until the migration lands, this isn't just "the same vote shown twice in a list" — LegiScan and MO's own primary-source adapters (`mo-house-xml`, `mo-senate-web`) can each legitimately write their own `votes` row for the same real floor vote, and **all three public vote-aggregate matviews (`public_position_totals`, `public_party_alignment`, `public_party_position_totals`) currently double-count every such pair in their percentages.** That is a wrong number on a legislator's public chart today, not a cosmetic issue.
   - **Approximate re-run of the last live count (2026-08-02's methodology: `(bill_id, date, chamber)` groups spanning more than one adapter prefix in `source_key`), done this pass for directional confirmation only:** ~**147** multi-adapter groups (was 139) carrying ~**211** extra roll-call rows (was 202) — both up modestly, consistent with ongoing MO ingestion, not a step change. **The "36 of them passage votes" sub-figure could NOT be confidently reproduced this pass** — re-running the codebase's own passage-vote classifier (the `/passage|third\s*read|3rd\s*read/i` regex `scripts/data-status.js` itself uses) against the same duplicate groups returned 137, an order of magnitude higher than 36, which means either the original count used a narrower definition of "passage" than this regex, or scoped to only the *canonical* row per group rather than "any row in the group." Flagging this explicitly rather than guessing which — **the group/row-count figures (147/211) are the trustworthy re-verification; the passage-vote sub-count is not.** Once migration 0022's backfill runs, `correct-data.js vote-duplicates`'s own `matched` count will be the first mechanically-derived, unambiguous figure for this defect's true size — treat that as the number to cite going forward, not this section's estimate.
3. ~~**2,005 bills have both a NULL title and a NULL canonical URL.**~~ **RESOLVED 2026-08-02, still resolved — re-verified live 2026-08-03, exact match, still 3.** `backfill-bill-titles.js` filled 1,972 of 1,975 NULL-title bills from cached LegiScan datasets (0 failures; the 3 left untitled are `SRM` remonstrance resolutions LegiScan's own cache has no title for either — correctly left untouched, never guessed). Bills with **both** a NULL title and a NULL `canonical_url`: **3** database-wide, unchanged since 08-02.
4. **`bill_actions` is effectively empty** — grew but the coverage ratio barely moved: 1,051 rows (was 1,020) over 142 of 38,254 bills (0.4%, was 139/38,254 = 0.4%), all Missouri — re-verified live this pass. There is still no "what happened to this bill" timeline for 99.6% of bills.
5. **Legislator profiles have no photos and no contact info** — re-confirmed live 2026-08-02: `image_url` and `contact` are NULL on all 1,607 rows, by design (`TODO.md` item 29 — photos derive from bioguide at render time, not stored). `districts` is still empty. One row still displays a raw bioguide code (`G000578`) as its name — unchanged, still open.
6. **555 of 1,607 legislator rows have zero votes** — re-verified live 2026-08-03, exact match to 08-02 and 07-31. Breakdown re-verified live this pass via `public_position_totals` (386 carry a federal `bioguide_id`, mostly historical members whose service predates our federal coverage window; 169 are Missouri-sourced) — exact match. (The 07-31 snapshot's finer claim, "352 of those are historical US senators" specifically — a chamber-level sub-cut of the federal group — remains **unverified**; it needs a join against each row's own term chamber that wasn't run this pass either.) The distinct-person-level breakdown (1,015 of 1,568 show a voting record, 553 render empty, "two known empty-shell duplicates" — Bob Onder, Jason Smith) was not independently re-run this pass; carried forward from 08-02 unchanged.
7. **318 legislator rows have votes but no term row** — unchanged, exact match to 07-31. Live-verified this pass, exact match again: **520 of 1,607 legislator rows** have no term row at all (the 07-31 snapshot phrased this as "482 of 1,568 entries," using the person-deduplicated denominator rather than the raw row count this figure is actually computed against — the row-level number itself moved 482→520, then held steady 08-02→08-03).
8. ~~**Party vocabulary is unnormalized.**~~ **LARGELY RESOLVED 2026-08-02 — on the column the public aggregates actually read — and confirmed still holding, re-verified live 2026-08-03, exact match on every figure.** `legislators.party` (the column `public_position_totals`/`public_party_alignment`/`public_party_position_totals` all join against) remains fully normalized — **Republican 860, Democratic 672, Independent 8, Independent Democrat 1, NULL 66** — zero bare `R`/`D` codes, confirmed live this pass. The insertion-point fix (`legiscan-identity.js` writes full words directly) is holding: a freshly-ingested LegiScan legislator has not re-dirtied the column since 08-02. **Casts falling out of every party total** (NULL or `Independent Democrat` party, 67 legislators — confirmed the same 67 this pass) was **42,207** as of 08-02; not independently re-summed this pass (the underlying legislator-level party breakdown is unchanged, so this figure has very likely only grown with vote volume, same as before — not re-verified to the exact number, flagging rather than restating as current fact). **`terms.party` — the second, still-unnormalized column — re-verified live this pass, exact match:** bare `R` (131) and `D` (62) codes alongside `Republican` (450), `Democratic` (435), `Independent` (8) and `Independent Democrat` (1). Still untouched by the fix, still not read by any public matview.
9. **Current-seat coverage is nearly complete but not perfectly — re-verified live, essentially unchanged.** US Senate 100/100 (unchanged). US House 437 current-term rows, of which **6** (was 5) have a null district, so address lookup cannot match them. Missouri House 159 of 163 seats — districts 95, 110, 114, 160 still have no current-term row, exact match to 07-31. Missouri Senate covers all 34 districts but has 35 rows — district 2 still carries two overlapping current terms. 194 terms have no start date, 731 no end date — both exact matches to 07-31 — so "current" is still partly inferred rather than proven.
10. **`legiscan_datasets` is still publicly readable including its `local_cache_path` column** — re-confirmed live against the migration: `create policy anon_read on legiscan_datasets for select using (true)` (migration 0010) is unchanged, and the `local_cache_path` column still exists on the table. Not civic-data leakage, but it should not be there. Still open.

### What the public can actually see

**Update 2026-08-03: the RLS/grant surface itself DID move since 07-31 — migration 0021 (bullet citations) is now applied and live**, confirmed via `node scripts/probe-public-surface.js` (the `citations` column shape-checked against all 220 live rows, 0 violations). Migration 0022 (vote-duplicates) is drafted but **not** applied — same probe script's `public_votes` check reports "migration 0022 not applied yet," so that migration's new views/exclusions are not yet part of the live public surface. Migrations 0001-0021 are live; 0022 is not.

- **Fully public:** bills, sponsors, actions, roll calls, vote casts, the vote feed, legislators, terms, persons, sessions, jurisdictions, summary→term links, and all three aggregate matviews.
- **Gated to zero rows:** `bill_texts`, `ingestion_runs`, all notes and verifications, `identity_flags`, `person_links`, `vote_reconciliation_flags`.
- **New since 08-02:** `public_verification_notes.citations` — per-bullet exact-quote text, gated on `overall='clean'` in the view definition itself (not application code), live and probe-verified.
- **Filtered:** `summaries` shows 115 of 213 (published only) — was 39 of 74; `glossary_terms` shows 116 of 2,219 (published only) — was 116 of 847.
- **Two deliberate view bypasses:** `public_freshness` (21 rows, was 20) and `public_reconciliation_flags` (49 rows, was 9) expose data whose *base tables* are anon-gated. Documented design choices, but the two places where "the base table is private" does not mean the data is private.

---

## Numbers that look alarming but are fine

Several counts in the ledgers read like data loss and are not. Checking these once, here, should stop the recurring panic.

**"275 Missouri House 2024 roll calls refused"** (unverified this pass, was accurate as of 2026-07-31 — refused rows are never stored, so there is no live table to re-derive the count from; the resulting gap it describes — 0 MO House roll calls stored for 2024 — is independently re-confirmed live). LegiScan prints those roll calls with the date `0000-00-00`. There is no honest way to derive a real date. Storing them with a fabricated or sentinel date would put wrong dates on the public record. **Refusing is the correct behavior.** The gap is real and is documented above; the refusal is not a bug.

**"21 bills refused for oversize text."** A 400,000-character ceiling on stored text. Missouri's SRB 975 is 751,225 characters; the federal S 1071 is 3,492,102. The alternative to refusing is silently truncating, which would mean summarizing half a bill and calling it the bill. **Nothing was ever truncated.** Correct by design.

**"12 MO Senate journal days quarantined"** (was 11 at 07-31, re-verified live via `public_freshness.quarantined_days`). Days whose journal PDF failed to parse cleanly three or more times, deliberately held out rather than published as a partial or garbled vote record. Correct by design, and each quarantined day is named in the run record.

**"1,813 LegiScan roll calls refused over an unknown `NV` vote code."** This was a first-contact fail-loud on an unrecognized vote value — the pipeline stopped rather than guessing what `NV` meant. **It was fixed and every affected session re-ingested to `succeeded` with zero reconciliation failures.** Not missing today.

**"3,474 unresolved US Senate cast entries."** Resolved. The final us-senate run reports 20,997 resolved / **0 unresolved**, and the live average is now a clean 100.0 of 100 senators per roll call (up from 99.99), which confirms it.

**"17,585 unresolved casts in mo-house-xml."** An artifact of re-counting. This is a **single stuck artifact** (~158 surname-only casts with null districts, source key `mo-house-xml-HB1800-4`) being retried on every run, and the 17,585 figure is that same ~158 counted across 122 runs. Roughly 158 casts are genuinely not stored — not 17,585.

**"1969-12-31 dates" and "numeric bill status codes."** Both cleaned up. Zero sentinel dates and zero NULL vote dates remain. 37,662 bills had numeric LegiScan status codes converted to words; **36 bills still show status `0` deliberately**, because LegiScan's codebook has no word for code 0 and inventing one would be editorializing. 18 have a NULL status.

**"`enrich-federal-bills` status: partial"** and **"`gloss` has never succeeded."** These pipelines record per-item failures and continue by design, so `partial` is their normal healthy outcome, not a failure. 480 of 482 federal bills have a status (was 476 of 478 — the federal bill count grew by 4, and the same 2 exceptions remain uncovered); the 2 without are the fake `QUORUM` / `ADJOURN` pseudo-bills that Congress.gov returns 404 for.

**"445 roll calls have no bill"** (was 444). Nominations, cloture motions, adjournment — 444 US Senate and 1 US House (was 443/1). Real votes that genuinely have no bill to attach to.

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