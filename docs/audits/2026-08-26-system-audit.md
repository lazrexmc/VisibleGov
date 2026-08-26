# Full system audit — 2026-08-26

Requested by Lance ("audit the system in full detail, provide feedback and generate a gameplan to
make corrections if needed"), run directly against the live database, the live site, and the
repo — not from documentation. Every number below was measured on 2026-08-26; re-measure with
`npm run status` and the queries named here rather than trusting these figures later.

Scale at audit time: 10,878 roll calls, 1,503,954 casts, 1,112 published summaries, 382 open
reconciliation flags, 33 migrations (all applied), 2,630 tests passing.

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

### D1 — Same-source duplicate vote rows (195 rows) — **visitor-visible AND blocking**
One vote stored more than once, byte-identical cast lists, same source. Measured by comparing cast
lists (the only honest test): 171 groups / 195 redundant rows — legiscan 171, mo-* 19, us-* 5;
worst in the sessions people actually read, 2025 (58) and 2026 (34). A visitor to MO SB 68 (2025)
sees the same 29-5 Senate vote listed twice.

**Raised in value 2026-08-26:** it is also a *cause* of unresolvable reconciliation flags. For
HCR 50 (MO Senate, 2018-01-08) the journal has one vote and LegiScan has two roll calls both
printing 31-0, so `crossCheckAgainstPrimarySource` cannot say which is which, correctly refuses to
pair, and raises `ambiguous_tally_match`. All 4 open flags of that reason have this shape.
Migration 0022's dedup is structurally blind to it — it pairs LegiScan against a *primary* source,
and both rows here are the same source.

### D2 — Signal death on always-partial sources — **a real break would be invisible**
`us-congress` 121/121 runs `partial`, `us-senate` 121/121, `scheduled-summaries` 6/6. Every
us-congress failure across 121 runs collapses to a single message shape, `HTTP N from us-congress:
.../rollN.xml` — the template renders 404 and 500 identically. The sources are healthy today
(verified above), but the status word and the message both carry zero information, so an actual
outage — the Clerk changing URL structure, sustained 500s, an auth change — would look exactly
like a quiet week. This is the most dangerous finding in the audit: not a defect now, but a
guarantee that the next real defect goes unnoticed.

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

**1. Fix D2 (signal death) — smallest effort, highest protective value.**
Make "partial" mean something. Two changes: (a) classify an expected miss separately from a real
failure — a 404 on the *next* roll-call number is the source saying "no more votes yet" and should
close the run `succeeded` with a counter, while a 5xx, a timeout, a changed URL shape, or a 404 on
a roll call we already hold is a genuine failure; (b) make the failure message carry the status
code and URL distinctly instead of collapsing to `HTTP N`. Until this lands, no one can tell a
healthy recess from a broken adapter. *Touches `src/adapters/us-congress.js`, `us-senate.js`, and
their CLIs; TDD against the real fixtures.*

**2. Fix D1 (duplicates) — one job, two payoffs.**
Extend dedup to same-source pairs sharing bill + chamber + date + tally **and** identical cast
lists; mark the later row superseded in `vote_duplicates`. The public views already exclude
superseded rows, so the display self-corrects and nothing is deleted. Two design questions need
Lance's ruling first: **which row is canonical** (lowest roll-call id? earliest ingested?), and
**whether a same-source pair should auto-pair or mint a review flag** — unlike the cross-source
case, no second source corroborates that they are the same event. Expect a measurable drop in
`ambiguous_tally_match` flags as a side effect.

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
