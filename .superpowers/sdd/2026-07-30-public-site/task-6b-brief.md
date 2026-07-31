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

