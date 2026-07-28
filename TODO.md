# VisibleGov — TODO / Backlog

*How to use: dump raw ideas in INBOX anytime. We triage from there into real work.*

---

## NOW

- [x] ~~Lance reviews the MVP design draft~~ (approved as working draft 2026-07-27)
- [x] ~~Execute Plan 1: foundation + ingestion (Onder slice)~~ — **COMPLETE 2026-07-27.** All
  10 tasks done + review-approved on branch `slice1-foundation-ingestion` (pushed): scaffold,
  typed errors + rate limiter, additive-merge DB layer, schema migration SQL (Lance applied),
  Congress.gov adapter, OpenStates/MO adapter, dry-run-capable ingest CLI, live end-to-end
  ingest + verification. Live run: `us-congress` rolls 358-362/2025 (5 votes, 2165 casts, 0
  failures) + `mo-legislature` session 2022 page 1 (95 votes, 20 bills, 0 casts — confirmed
  OpenStates gap, 0 failures); both `status: "succeeded"`. Onder verified end-to-end in the
  live DB via Supabase REST: federal row (bioguide_id `O000177`) with 5 vote_casts (one per
  ingested roll), separate MO row (openstates_id) with 1 synthesized senate/district-2 term;
  re-ran the MO ingest to confirm idempotency (no duplicate terms or votes). Full detail in
  CHATLOG. Next: Plan 2 (summarization + review queue).
- [x] ~~Decision: editor_notes public readability~~ **RESOLVED 2026-07-27** — internal-only,
  never publicly readable (Lance's facts-only directive; fix ships in Plan 2's first migration).
- [x] ~~Plan 2 — summarization + review queue~~ **COMPLETE + MERGED 2026-07-28.** Full pipeline
  live: 3 federal bills summarized by opus-5 (facts-only, section-cited), adversarially verified
  by sonnet-5 (22/22 bullets, 0 flags, mechanically completeness-gated), Lance-approved and
  **published** via the local review page (full audit trail); goldens committed; anon-key RLS
  probes prove the public sees exactly the published rows. 149/149 tests. Trust model v2 +
  per-run API approval policy both operative.
- [ ] **Next: Plan 3 — the public site, profile-first** (Lance: "the politician profile is the
  product"). Onder's page = who he is + votes cast/missed with plain-language bill one-liners +
  sponsored bills + MO history; bill pages as click-through support; directory + address lookup;
  static pre-render on publish; freshness footer (filter view to ingestion sources). Pre-work
  carried from slice-2 final review: id-based markStale, "current published summary per bill"
  convention, published-goes-stale UX treatment, run_id on summary_verifications (next
  migration), sponsored-bills ingestion.

## 🛠 BUILD QUEUE

1. [x] ~~First vertical slice: Bob Onder end-to-end — ingestion half~~ **DONE 2026-07-27.**
   Ingested live from both jurisdictions and verified end-to-end (see TODO NOW + CHATLOG). The
   remaining half of this slice (summarize the triggered bills → review queue → published
   legislator page) is items 5-7 below, deferred to Plans 2-3.
2. [x] ~~Schema migration draft (canonical tables + RLS)~~ **DONE** — applied by Lance,
   confirmed live via Supabase REST probe (jurisdictions + sessions seed present).
3. [x] ~~Congress.gov adapter (bills, actions, calendars, roll-call XML)~~ **DONE** —
   live-verified (Tasks 6 and 10).
4. [x] ~~OpenStates/MO adapter~~ **DONE** — live-verified (Tasks 8 and 10). Known gap:
   OpenStates MO vote events carry no per-voter casts (confirmed 0/95 twice, in fixture and
   live) — see item 9.
5. Summarization CLI (versioned prompt, hash-tied to bill text version, review queue).
6. Public site: directory, legislator page, bill page, address lookup (Census Geocoder).
7. Staff `/admin` review queue.
8. Identity merge: link federal+MO legislator rows (Onder currently = 2 rows — one keyed by
   `bioguide_id`, one by `openstates_id` — confirmed live 2026-07-27; expected until this is
   built, not a bug).
9. MO individual roll-call votes (OpenStates has none) — confirmed across 4 sessions/305 sampled
   vote events (2022/2021/2019/2017: exactly 1 event with voter data). **Investigated 2026-07-27
   (Task 9, full findings in `docs/research/2026-07-27-mo-data-sources.md`).** Narrower than
   "scrape the journal": house.mo.gov runs its own no-auth, live, hourly XML export
   (`documents.house.mo.gov/xml/...`) that gives clean per-bill action history, but its `RollCall`
   element is aggregate tallies only — individual votes live one hop away in a linked
   `RollCallPDF`, confirmed real and text-layer (not scanned — extracts cleanly, no OCR needed) via
   a live fetch. Build a `mo-house-xml` adapter against that XML + PDF pair (see the research doc's
   proposed adapter shape) — no signup, no ToU ambiguity ("made available for public use"). Separately,
   LegiScan's `getRollCall` operation is confirmed (via its own official client source, not a live
   MO payload — no key was registered) to return individual `people_id`/`vote_id` votes in general;
   whether MO's data is actually populated is the one open question a real key would settle in one
   call, and could replace the PDF-parsing step if so. Bill full text is PDF-only at the MO primary
   source either way (confirmed) — either path needs a new PDF-text-extraction dependency before
   `summarizeBill()` can run on MO text, which isn't built yet.
10. Plan-2 first commits (from final whole-branch review, 2026-07-27): (a) fail-loud chamber
    parsing in both adapters (kill the silent 'house'/'senate' fallback guesses); (b) wire an
    enrichment pass so placeholder rows (null bills, id-as-name legislators) can be filled —
    additivePatch exists but nothing calls it; (c) resolve the editor_notes RLS decision (NOW)
    before anything writes summaries; (d) consider a freshness view narrowing ingestion_runs
    anon exposure to source/status/finished_at; (e) generalize or remove the Onder-specific
    MO-term config fallback before MO ingestion widens.

11. **On-demand ingestion (launch architecture, Lance 2026-07-27):** capture the verified Onder
    end-to-end process as an executable runbook; when a user looks up a legislator with a
    thin/missing record, the system enqueues that process (automated identity verification
    against source APIs → vote ingestion → summary triggers) instead of pre-filling everyone.
    UX: "record queued — filling now" (live fills take minutes under rate limits). Depends on:
    identity merge (8), generalized MO-term handling (10e), automating the Task-5/7 manual
    identity-verification steps. Design in Plan 3/4.

## 📥 INBOX (raw idea capture, 2026-07-27, Lance's own words)

> "I'd like to expose all the politicians by breaking down the bills and laws they propose into
> layman terms so that everyone can easily read them and their purpose and then we can all see how
> our constituents voted on said bills so we can hold them accountable as they are CLEARLY running
> amuck these days"

Multi-faceted per Lance: (1) plain-language bill/law breakdowns, (2) purpose/intent surfaced
clearly, (3) voting-record tracking tied to individual legislators, (4) accountability - making the
above easy enough that regular people actually use it. Decomposed 2026-07-27 into the MVP design
draft — see NOW.
