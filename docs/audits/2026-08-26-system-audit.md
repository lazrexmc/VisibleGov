# Full system audit — 2026-08-26

Requested by Lance ("audit the system in full detail, provide feedback and generate a gameplan to
make corrections if needed"), run directly against the live database, the live site, and the
repo — not from documentation. Every number below was measured on 2026-08-26; re-measure with
`npm run status` and the queries named here rather than trusting these figures later.

Scale at audit time: 10,878 roll calls, 1,503,954 casts, 1,112 published summaries, 382 open
reconciliation flags, 33 migrations (all applied), 2,630 tests passing.

> **Two findings below were substantially wrong and are corrected in place:** D2's premise (the
> classifier already existed — it just never reached the durable run row) and D1's measurement,
> method, cited example, and claimed flag relief. Both corrections are recorded inside their own
> entries rather than quietly edited away. Suite is 2,668 passing as of the D1 build.

---

## Verdict

**The data and trust layers are sound. The defects are in signal quality, a duplicate-row class,
and product coverage — not in correctness of what is published.** Nothing found here justifies
holding the site back; the two items that touch what a visitor sees (D1, D4) are small and
contained.

One methodological note that shaped this audit: the first pass of the trust-model check reported
708 of 1,112 published summaries as unverified. That was **wrong** — a `.limit(20000)` read was
silently capped at 1,000 rows by PostgREST. Re-run through `selectAll` (paginated), the real
answer is zero. This is the project's own recurring trap (PLAYBOOK lesson 20, the 2026-08-03
audit's finding 1) and it very nearly produced a false catastrophe in this document. **Any count
in an audit that came from a single unpaginated read is not evidence.**

---

## What is healthy (verified, not assumed)

| Area | Check | Result |
|---|---|---|
| Trust model | published summaries lacking a `support` verification | **0** of 1,112 |
| Trust model | lacking a `completeness` verification | **10**, all published 2026-07-28→30 before that axis existed — already disclosed on the trust page |
| Trust model | published glossary entries lacking quote or source | **0** of 1,858 |
| Integrity | orphan casts, NULL `vote_date`, NULL `session_id`, published summaries with NULL body | **0** each |
| Security | drafts readable by anon | **0 rows** — unpublished work never leaks |
| Security | unlisted columns on `summaries` readable by anon | **denied** (0025 column scoping holds) |
| Security | secrets in tracked files | none; `.env` ignored. `SUPABASE_ANON_KEY` in `site/config.js` is public **by design** — RLS is the wall |
| Tests | `node --test` | **2,630 pass / 0 fail / 0 skipped** |
| Ingestion | MO sources, 7 days | mo-house-xml 162 ok / 0 failed; mo-senate-web 163 ok / 0 failed |
| Federal data | is the 121-run "partial" streak hiding a break? | **No.** `clerk.house.gov/evs/2026/roll283.xml` → 200 (stored), `roll284.xml` → 404 (does not exist). The House has not voted since 2026-07-23; the Senate since 2026-08-08. Ingestion is complete and current. |
| Site | `https://visiblegov.us` | 11/11 checks; live browser shows real data (730 serving / 837 past) |

`selectAll` also refused to return a truncated read of the 1.5M-row `vote_casts` table during this
audit — the fail-loud guard from the 2026-08-03 audit working as designed.

---

## Defects found, ranked by what they cost

### D1 — Same-source duplicate vote rows — **RESOLVED 2026-08-26; three claims below were wrong**
One vote stored more than once by ONE adapter. Migration 0022's dedup is structurally blind to it —
it pairs LegiScan against a *primary* source, and both rows here are the same source. That much
held up. Almost nothing else in this entry's original text did, and the corrections are the
substance of the finding:

- **The count was wrong.** The original said 171 groups / 195 rows, "measured by comparing cast
  lists (the only honest test)". Re-measured properly (loose grouping on family+bill+chamber+date,
  then byte-identical cast lists): **217 groups / 278 rows**. The first pass had under-counted.
- **"The only honest test" was not a test at all.** Identical cast lists do not establish identity.
  On 2025-06-30 the US Senate cast **ten** roll calls on one bill in one day — 119-1-332 through
  119-1-353 — every senator voting the party line every time: ten byte-identical 100-cast lists,
  identical question ("On the Motion"), identical result ("Motion Rejected"). Ten real votes. The
  cast-list rule would have hidden nine of them. Three further confounders turned up the same way:
  a MO journal PDF URL with no `#` fragment covers a whole sitting (mo-senate-web numbers several
  distinct votes against one such URL); one anchor can still carry two roll calls (#521 on
  2019-03-14 holds both a 29-4 and a 33-0); and mo-house-xml's one-legislator roster makes any
  single-cast row match any other.
- **The flag-relief claim was wrong.** The original said this defect *causes* the
  `ambiguous_tally_match` flags and that fixing it would drain a subset. Measured: **zero** of the
  382 open flags sit on a confirmed pair, and zero sit on the same bill+date+chamber as one. Fixing
  D1 relieves no flags at all.
- **The cited example was wrong in its details.** SB 68's duplicate is the **2019-05-13** vote
  (25-8), not a 2025 29-5 vote.

**What is actually true, and now shipped:** of the 217 fingerprint-matched groups, **38** survive a
rule that requires the source itself to point at one specific vote — same adapter, same bill,
chamber and day, byte-identical cast list of at least 5 casts, identical non-null result, and an
identical `source_url` *carrying a fragment* (`…RDay250220426-442.pdf#430.2`). Every one of the 38
is a pair of LegiScan `roll_call` records on one anchored MO Senate journal location; 25 of the 38
pairs differ only by `http://` vs `https://`. The other 179 groups are left untouched, with the
reason recorded: 147 point at genuinely different source URLs, 19 share only a whole-document URL,
13 rest on a cast list too small to prove anything.

### D2 — Signal death on always-partial sources — **FIXED 2026-08-26, live-verified**
`us-congress` 121/121 runs `partial`, `us-senate` 121/121, `scheduled-summaries` 6/6. Every
us-congress failure across 121 runs collapses to a single message shape, `HTTP N from us-congress:
.../rollN.xml` — the template renders 404 and 500 identically. The sources are healthy today
(verified above), but the status word and the message both carry zero information, so an actual
outage — the Clerk changing URL structure, sustained 500s, an auth change — would look exactly
like a quiet week. This was the most dangerous finding in the audit: not a defect now, but a
guarantee that the next real defect goes unnoticed.

**Fixed the same day** (gameplan item 1 below; PLAYBOOK lesson 51). Three things, and the audit's
own stated plan was wrong about the first and incomplete about the third:

1. **The classifier already existed.** `scripts/scheduled-ingest.js`'s `isExpectedTailProbeOutcome()`
   was written, commented, and unit-tested months ago, and returned the right verdict. It fed only
   the scheduler's in-memory `healthy` flag — a log line and an optional healthcheck ping. The
   `ingestion_runs` row still said `partial`, and `public_freshness` (what `npm run status` prints)
   renders that row. The gap was never classification; it was that the verdict never reached the
   durable record.
2. **Absence is now separated from failure at the ingest layer.** `isAbsentRecordError()`
   (`src/lib/errors.js`) calls a 404, and senate.gov's HTTP-200 "Roll Call Vote Unavailable" stub,
   an *answer*; a 5xx, a rate limit, a network error, a body-read failure or a parse error remains
   a failure. `recordMiss()` (`src/cli/ingest.js`) files them into `detail.absent` vs
   `detail.failures`, each entry now carrying `status` and `url` as their own fields so a 404 and a
   500 are distinguishable from a stored row alone. Only failures decide the status word.
3. **The window now probes a canary.** This hole was found while implementing, not during the
   audit: a forward-only window would 404 on *every* roll if the Clerk changed its URL structure —
   indistinguishable from a recess, and after change 2 it would have closed `succeeded` with
   confidence. `computeRollWindow` now starts AT the last roll already on file rather than one past
   it, and `findRegressedAbsences()` forces the tick unhealthy if that record comes back absent.
   One extra request per tick; re-ingest is idempotent.

Live verification, 2026-08-26: `us-congress` and `us-senate` both ran with the new window and
closed **`succeeded`, failures 0, absent 10**, exit 0 — the canary returning 431 casts (House roll
283, 2026-07-23) and 100 casts (Senate vote 231). `npm run status` INGESTION FRESHNESS now reads
`us-congress succeeded` / `us-senate succeeded` where it read `partial` an hour earlier. Suite
2,645 pass / 0 fail (15 new tests, incl. one asserting a break is caught *despite* a `succeeded`
row).

### D3 — 382 reconciliation flags will not self-drain — **expectation corrected**
Documented until 2026-08-26 as something the next LegiScan tick would clear in bulk. Measured: the
2026-08-25T22:15 tick ran after the journal replay, processed all 604 roll calls, produced
`tally_unique_match: 3`; `vote_duplicates` unchanged at 66; open flags rose 368 → 382; the resolver
reports 0 resolvable. Composition: `no_tally_corresponding_primary` 184, `hard_mismatch` 102,
`primary_cast_data_not_comparable` 77, `soft_mismatch` 15, `ambiguous_tally_match` 4; by
counterpart source mo-senate-web 192 / mo-house-xml 190 — an even split, so not a one-source
defect. These are a **human adjudication queue by design** plus a subset D1 would unblock.

### D4 — One phantom "currently serving" legislator — **visitor-visible, tiny**
Bob Onder has four `legislators` rows (correctly unified under one `person_id`). One is empty: no
votes, no `start_date`, no `end_date`, MO Senate district 2 — so the directory shows him as a
**currently serving Missouri senator** when he left that seat and now serves in the **US House**
(bioguide O000177, term 2025-01-03→open, 645 casts). Blast radius measured: of 731 open-ended
terms, only 2 also lack a start date and exactly **1** has zero votes. So: one wrong row, not a
broken directory. 194 MO terms render as current against 197 real seats (163 House + 34 Senate),
which is consistent with vacancies.

### D5 — Summary coverage 23% — **the product gap**
806 of 3,438 accountability-set bills have a published summary; 2,481 are READY (text on hand, no
summary). At the scheduler's measured rate this is ~450 days. Note the scheduler's cost is **flat
at ~$0.355/tick regardless of output** (last five ticks: $0.36/$0.36/$0.36/$0.35/$0.39 for
1/4/1/4/6 published), so "$0.12 per summary" is a cross-tick average, not a per-bill price; the
~$306 whole-backlog estimate is unaffected.

### D6 — The 185 derived vote dates have no public receipt
`public_votes` lists columns explicitly and does not include `vote_date_provenance`, so the site
serves dates derived from LegiScan's bill history without the action they were derived from. The
trust model says a fact carries its receipt where the reader can see it. Captured when 0032 was
written; still open.

### D7 — One orphaned run row
`correct-data` has sat at `status=running` since 2026-08-03. Cosmetic, but it is noise in the
ledger the freshness surface reads, and `closeOrphanedRunningRows` evidently does not cover it.

### D8 — Console error on the live site
`https://visiblegov.us` throws one console error: the site's own CSP (`script-src 'self'`) blocking
Cloudflare Web Analytics' auto-injected `beacon.min.js`. The CSP is working correctly and nothing
is tracking anyone. Awaiting Lance's decision (disable the beacon, or allow it and gain the usage
feedback loop the project currently lacks).

---

## Gameplan

Ordered by value per unit of effort. Nothing here is started; each is a discrete piece of work.

**1. ~~Fix D2 (signal death)~~ — DONE 2026-08-26, live-verified.**
Both stated changes shipped, plus a third the plan had missed. See D2 above for what was actually
found (the classifier already existed and simply never reached the run row) and the canary the
forward-only probe window needed. *Touched `src/lib/errors.js`, `src/cli/ingest.js`,
`scripts/scheduled-ingest.js`; `tests/absent-vs-failure.test.js` is new.*

**2. ~~Fix D1 (duplicates)~~ — BUILT 2026-08-26, dry-run verified; the `--apply` is Lance's step.**
`src/lib/same-source-dedup.js` (the rule, 23 tests) and `scripts/dedup-same-source-votes.mjs`
(dry-run by default). See D1 above for what re-measurement corrected. The two open design questions
were ruled on rather than left blocking:

- **Which row is canonical: the lowest source record id** (for LegiScan, the numeric `roll_call_id`
  in the source_key) — explicitly *not* "earliest ingested", because ingestion order is not
  reproducible and a rebuild from scratch could silently swap which vote the public site displays.
  The source's own record id is a property of the data and identical on every rebuild.
- **Auto-pair or flag: auto-pair this class only, and flag nothing.** The evidence here is
  decisive — the source is pointing at one anchored location — so a review flag would add no
  information. The 179 refused groups are *not* suspected duplicates that need adjudication; they
  are groups the rule actively judged to be distinct votes, so flagging them would put 179 false
  items into a queue that already holds 382 real ones.

Nothing is deleted: both rows stay in `votes` forever and the public views exclude the superseded
side, exactly as 0022 does. Because the two rows carry byte-identical cast lists, no legislator
loses a vote from their record — the canonical row carries every cast the superseded one did.

**3. Fix D4 (phantom row) — minutes, and it removes a factually wrong claim.**
Bob Onder's empty MO Senate term row needs an `end_date` (he left the seat) or removal. Do it as a
`correct-data` correction with a written reason, not an ad-hoc UPDATE, so it lands in the audit
trail like every other correction. Then add a guard: a term with no `start_date` **and** no votes
should never render as "currently serving".

**4. Decide D8 (analytics) — one toggle, unblocks the feedback loop.**
Lance's call between disabling the beacon and allowing it in the CSP. If allowed, the trust page
needs a line saying what is collected — the page is currently silent on it, and silence on a site
built around disclosure is itself a defect.

**5. Fix D6 (derived-date receipts) — small, and it closes a trust-model gap.**
Add `vote_date_provenance` to `public_votes` and render it on the bill page beside the date.

**6. D5 (coverage) — needs a decision, not a build.**
The $0 subagent lane cannot close 2,481 bills (~526M subscription tokens, ~35 h). The billed path
is ~$306 at measured rates. The honest recommendation stands: get the site in front of real people
first and let their behaviour say whether coverage is the binding constraint, because right now
nobody is using it and the question is unanswerable.

**7. D3 (flags) and D7 (orphan row) — accept and tidy.**
D3 is a human queue by design; the only mechanical relief is item 2. D7 is a one-row cleanup.

---

## Standing recommendation

The engineering discipline here is the project's real asset and it keeps paying: within this
session alone, ground-truthing caught a journal grammar that had quarantined 20 days, adversarial
review caught a chamber-attribution bug before it stored a wrong date, and this audit's own
headline number was a false alarm caught by re-reading with pagination. Keep that.

What the project does **not** have is contact with a reader. Every defect above is small; the
largest open question — whether 23% summary coverage matters — cannot be answered from the
database. That answer comes from putting `visiblegov.us` in front of five people and watching
where they stall.
