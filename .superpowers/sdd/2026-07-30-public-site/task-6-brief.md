### Task 6: profile page — person.html, person.js, legislator.html

**Files:**
- Create: `site/person.html`, `site/js/person-page.js`, `site/legislator.html`, `site/js/legislator-page.js`
- Test: `tests/person-page.test.js` (pure helpers: id-from-path, one-liner attach, flag-badge join)

**Interfaces:**
- Consumes: everything from Tasks 3–5 by the exact names above.
- URL contract: `/person/<uuid>[/<slug-ignored>]`; `idFromPath(pathname, prefix)` → uuid | null (exported pure, tested).
- Data flow (each section independently three-stated):
  1. `legislators?person_id=eq.<id>` via `fetchAllRows` + `persons?id=eq.<id>`; empty legislators AND no person → 'failed'-style not-found state ("no such profile in our data").
  2. `terms?legislator_id=in.(...)` → `buildIdentity`.
  3. Votes: `pagedFetch(voteFilterQuery(...))`; filter controls re-query the SERVER (never client-sort partial pages); each row: position as stored, bill identifier+title (linked to `/bill/<bill_id>/<identifier-slug>`), receipt link from `voteReceiptUrl` labeled "source", one-liner (step 4), flag badge (step 5). Missed-votes toggle = `position=in.(not_voting,absent)` server filter.
  4. One-liners: for the CURRENT page's distinct bill_ids: `summaries?bill_id=in.(...)&status=eq.published&select=bill_id,body_md,published_at&order=published_at.desc` → keep first per bill_id (current published) → `extractOneLiner`. Null → title only.
  5. Flags: `public_reconciliation_flags?vote_id=in.(current page's vote_ids)` → badge "⚑ reconciliation flag" linking `/trust#flags` on matching rows.
  6. Sponsorships: `bill_sponsors?legislator_id=in.(...)&select=sponsor_type,bills(id,identifier,title,status)` via `fetchAllRows` → `groupSponsorships` → four labeled sections (empty groups render nothing — absence of a section is honest here since the labels are exhaustive).
  7. Freshness box: `public_freshness` rows for the sources relevant to this profile's jurisdictions (map: us-congress → sources starting `us-`; mo-legislature → `mo-` + `legiscan`), quarantined_days > 0 renders "N journal days pending human review".
- `legislator.html`/`legislator-page.js`: fetch the row; `person_id` set → `location.replace('/person/<person_id>')`; else render the same profile sections with `legislators=[row]`, `person=null`.

- [ ] **Step 1: TDD the pure helpers** (`idFromPath`, one-liner-attach map, flag-badge join) — failing first, then green.
- [ ] **Step 2: Build the pages.** Every DB string through `el(...)` text nodes. Photo: `photoUrl` result or the no-photo block.
- [ ] **Step 3: Full suite green, commit** — `git commit -m "feat: profile page (person + legislator forwarding) wired to live anon surface"`
- [ ] **Step 4 (controller smoke, needs Tasks 1+3 gates done):** `node scripts/serve-site.js` → load Onder's person URL → verify against the review server's known truth: identity header, ~1,650 casts paginated, 179 sponsored bills, receipts click through to real roll-call/journal URLs, filters re-query, throttled-network loading states visible, one flagged-vote badge if any of his votes carry flags. Record findings in the ledger.

### Task 6b: vote aggregate charts (Lance direction 2026-07-30 — spec §3 amendment "Vote aggregates")

**Files:**
- Create: `supabase/migrations/0018_vote_aggregates.sql`, `site/js/vote-charts.js`
- Modify: `site/js/person-page.js` (chart section above the vote list, same filter state)
- Test: `tests/vote-charts.test.js`

**Interfaces:**
- Migration 0018 (drafted by implementer, Lance applies; both views `security_invoker=true` over public bases, granted anon+authenticated):
  - `public_position_totals`: `select vc.legislator_id, v.jurisdiction_id, v.chamber, date_part('year', v.vote_date)::int as year, vc.position, count(*)::int as casts from vote_casts vc join votes v on v.id = vc.vote_id group by 1,2,3,4,5;` — the profile sums/filters client-side (rows per legislator ≈ years × positions × chambers — tiny).
  - `public_party_alignment`: per (legislator_id, year): `matched` and `comparable` counts — a roll call is comparable when the member cast yea/nay AND their party (legislators.party of each caster, as recorded) has a strict yea/nay majority among its own casts on that roll call; matched when the member's cast equals that majority. Ties/no-majority excluded. Written as a plain view; CONTROLLER MEASURES anon latency after apply — if it breaches the anon statement timeout, escalate to a materialized view + refresh in the ingest CLIs (0019, new task).
- `vote-charts.js` (pure + render, zero deps): `summarizeTotals(rows, filters)` → `{yea, nay, not_voting, absent, other, total, shares}` (shares as exact "62.1%" strings from a documented rounding rule — one decimal, half-up); `cohesionFromAlignment(rows, filters)` → `{matched, comparable, pct}` | null when comparable=0 (renders "not computable for this view" — never 0%); `partyComparisonModel(memberTotals, partyTotals)`; `renderChartSection(container, models, onBarClick)` — CSS bar divs via el(), raw numbers always in text nodes, each bar wired to the existing filter reducer (nextVoteFilters) so a click filters the vote list.
- Party aggregate for comparison: the member's party's own `public_position_totals` rows filtered by (jurisdiction, chamber, year-range of the current view) — fetched via fetchAllRows with a `legislators!inner(party)` embed if practical, else a third tiny view; implementer verifies which works against the live surface and documents the choice.
- Definitions copy: one exported `METRIC_DEFINITIONS` object (the exact trust-page sentences); Task 10 renders it on `/trust#metrics` — single source, no drift.

- [ ] **Step 1: TDD** the pure math: distribution totals/shares incl. rounding rule; cohesion null-when-zero-comparable; a party-majority edge fixture (tie → excluded); filter-scoping (year filter narrows both member and party rows identically). FAIL first.
- [ ] **Step 2: implement + wire; migration drafted. Step 3: full suite green, commit `feat: vote aggregate charts (distribution, party comparison, cohesion) + 0018 draft`.**
- [ ] **Step 4 (LANCE GATE): apply 0018 → controller measures anon latency, live-smokes the chart section on Onder, verifies chart numbers against a hand-computed spot-check (one year, one chamber), and the bar-click filter round-trip.**

