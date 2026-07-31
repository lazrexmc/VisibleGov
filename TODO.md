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
- [x] ~~Glossary implementation (item 14)~~ **CODE-COMPLETE + REVIEW-CLEAN 2026-07-28** on
  branch `glossary-implementation` (12 commits, 424/424 tests, final whole-branch review clean
  after 2 fix rounds; zero LLM spend). Live E2E gated on Lance, in order: apply amended 0007 →
  top up credits → golden drift check ($0.35, pre-approved) → extraction backfill (~$0.75) →
  gloss batch (count+cost stated at gate) → adjudicate glossary terms in the review page →
  anon probes → merge decision. Full trail: CHATLOG 2026-07-28 afternoon +
  `.superpowers/sdd/2026-07-28-glossary-implementation/progress.md`.
- [ ] **Deprioritized (Lance, 2026-07-28): the 22 summary drafts** (17 clean, 5 flagged) were
  pipeline-proving test artifacts — important later when publishing that batch matters, not a
  central focus now. No dependency: glossary extraction reads summaries in any status.
- [x] ~~Profile-completeness plan~~ **COMPLETE + MERGED TO MAIN 2026-07-30** (522bd40, 1220/1220,
  final whole-branch review clean after 2 verified fix waves). Live: 46,268 bill_sponsors
  (45,792 MO exact + federal), 476/478 federal statuses, 465 bill_texts, attach-to-existing
  hardened (origin-marked flags, all-member vetoes, keep-separate binding on every path),
  summary queue + record gate proven at $0 (8 bills: 4 published / 4 flagged). Trail:
  `.superpowers/sdd/2026-07-29-profile-completeness/progress.md` + CHATLOG 2026-07-30.
- [x] ~~Plan 3 — the public site~~ **COMPLETE + MERGED TO MAIN 2026-07-30** (c4e7320, 1726/1726,
  final whole-branch adversarial review clean after a 6-finding fix wave, all closures
  execution-verified). Five pages live in `site/`: directory + address lookup, person profiles
  (identity, votes with receipts + one-liners, sponsorships, vote-aggregate charts, freshness),
  legislator forwarding, bill pages (printed result beside recorded tallies, verified summaries,
  inline glossary, flag badges), trust page (pipeline prose fact-checked against the code, metric
  definitions single-sourced, full attribution). Migrations 0016–0019 applied; four data backfills
  run live. Trail: `.superpowers/sdd/2026-07-30-public-site/progress.md` + CHATLOG 2026-07-30.

- [x] ~~Data-correction batch~~ **COMPLETE + VERIFIED LIVE 2026-07-31.** (a) 37,662 MO bills'
  numeric LegiScan status codes → their printed words, mapping SOURCED from LegiScan's own API
  manual p.42 (extracted via the repo's own PDF extractor, not from memory); 36 code-`0` bills
  correctly left untouched; 0 numeric codes remain. (b) 10 votes carrying the `1969-12-31`
  sentinel → re-dated from their primary journal filenames; 0 deletions, 0 sentinels remain.
  Both writers fixed in the same change so re-ingestion can't reintroduce either defect. Review
  caught (and the fix closed) a false-positive delete path in (b) before it ran. Trail:
  `.superpowers/sdd/2026-07-31-data-corrections/progress.md`.
- [x] ~~Identity merge pass~~ **COMPLETE 2026-07-31.** persons 7 → 37 (30 real merges, 0 wrong
  merges). Caught the **Menendez Sr./Jr. dynasty trap** before any write (concurrent service,
  identical names, different chambers; distinct bioguide IDs M000639/M001226 settle it) and wrote
  a keep-separate ruling recorded as `controller_automated`. Trail:
  `.superpowers/sdd/2026-07-31-identity-merge-pass/progress.md`.

- [ ] **NOW — the only thing gating Cloudflare is Lance's review queue.** Lance's standing rule
  (2026-07-31): *"I'm only interested in starting the cloudflare portion once the entire backend
  is locked in and accurate, otherwise I'm troubleshooting two systems back and forth."* Cloudflare
  is a MILESTONE, not a task — do not propose it until Lance says the backend feels solid.
  Remaining operator decisions, none blocking each other:
  - **4 unresolved identity flags** — Hank vs. Speaker Mike Johnson; Barry vs. Blake Moore; Dan vs.
    Justin Brown (likely: link Justin's two rows, keep Dan separate — Lance's read, not assumed);
    plus the Menendez informational flag. Local review server, one decision each.
  - **35 draft/flagged summaries** — the two-axis gate caught real gaps; each needs Lance's read or
    a re-author. 2 of these failed shape validation on a stray line break (newline-injection guard)
    and just need re-authoring.
  - **9 open vote-reconciliation flags** — source discrepancies held out of the clean record.
  - **Cloudflare Pages (deferred, steps preserved for when Lance calls it):** connect
    `lazrexmc/VisibleGov`, production branch `main`, build command EMPTY, **Root directory `site`**
    (required, or `_headers` + the geocode Function are not discovered). Verify at deploy:
    `/geocode` responds, `_redirects` rewrites survive a hard refresh, CSP headers present (open
    question: whether `_headers` covers Pages Function responses).

## 🛠 BUILD QUEUE

0. **NEXT PLAN — LegiScan bulk adapter (unblocked 2026-07-28: Lance registered a key; probe
   CONFIRMED MO individual votes populated — 161 {people_id, vote_id, vote_text} entries on a
   real 2018 roll call; 31 MO sessions 2010-2026 available as weekly dataset ZIPs, ~tens of
   queries for the whole backfill).** Supersedes the 30-min-cadence grind as the PRIMARY MO
   ingestion path for both chambers; the mo-house/mo-senate primary-source parsers become the
   reconciliation/audit layer (LegiScan casts must reconcile against official printed tallies
   before storage). Binding operating terms: `docs/research/2026-07-28-legiscan-terms.md`
   (dataset_hash gating is suspension-level mandatory). Known design task: substitute-vehicle
   attribution (SB 894's Senate vote lives under the combined 'SBs 894 & 921' record, not
   SB 894's own). Start AFTER the mo-senate-adapter branch merges.

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

14. [x] ~~Referenced-context glossary~~ **DESIGNED + BUILT 2026-07-28** (see NOW). Remaining
    product decisions parked for Lance: (a) re-gloss path for a rejected-with-gloss term
    (currently: edit the text directly; summaries re-draft on reject, glossary does not);
    (b) subsection-cited terms under the 100k cap gloss from the whole section (as-designed);
    (c) "(e.g. X)" mid-sentence over-splits into an extra verifier fragment (accepted
    residual — noisy-but-honest beats silent merge; prompt discourages dotted abbreviations).

13. **Freshness machinery (Lance priority, 2026-07-28): scheduled incremental ingestion** - daily delta runs (new House rolls via ceiling probe, new Senate votes via menu diff, MO XML on its half-hour ToU), plus a summary-candidate report Lance approves as batches. Design after Plan 3a lands.

12. [x] ~~US Senate roll-call adapter~~ **DONE 2026-07-28** — senate.gov LIS XML adapter live:
    869 Senate votes, every senator's cast, 0 unresolved (Hawley/Schmitt 869/869; historical
    seat successions handled). Hawley's MO-era executive record remains a Plan-3 labeling note.

15. **Giant-bill summarization policy (Lance decision):** 3 bills exceeded the 400k-char oversize gate (HR 8800 1.97M, S 4784 1.88M, HR 9237 567k). Options: raise cap toward opus-5 1M-token context (~$4/giant bill full-text) or chunked summarization design. Gate behaved correctly - nothing truncated silently.
16. [x] ~~Verifier output cap fix~~ **DONE 2026-07-28** (32k via streaming; the 2 stalled drafts
    re-verified — both came back flagged; extraction later got the same treatment).
17. [x] ~~MO Senate adapter build~~ **BUILT + MERGED 2026-07-28** (`c731450`): journals-first
    pipeline, 5 fix rounds closing a cross-era misattribution class at four channels, final
    16-agent adversarial review clean, 626/626 tests. 2018 backfill cycling live on the
    House-conservative cadence. Migrations 0008/0009 applied.
18. **Hygiene: unbounded-select sweep (from the final review's grep ledger, in
    `.superpowers/sdd/2026-07-28-mo-senate-adapter/final-fix-wave-report.md`).** Glossary trust
    surface is fully paginated via `selectAll`; the ingestion/summary paths are not.
    **URGENT-WHEN-SUMMARIES-RESUME: `summarize.js:96` selects the whole votes table (~1,627
    rows live, already past the 1000 cap) — its candidate picker is silently incomplete TODAY;
    fix via selectAll before the next summarize run.** Others (verify/extract/golden/ingest
    paths) are sub-1000 today.

19. **Summary volume — wave 2+ ($0 subagent path, spends Lance's plan usage not credits).**
    3,281 passage-vote bills still unsummarized, all with text on hand. Proven wave-1 shape: batches
    of 5 bills per agent through author (opus) → adversarial verify (sonnet) → two-phase
    completeness (sonnet), pipelined via a workflow, then `summary-queue.js record`. Canonical
    prompts/schemas export from `src/lib/summarizer.js` + `src/lib/verifier.js`; **never** paraphrase
    them into a dispatch. Wave-1 yield: 26 published / 12 flagged / 2 shape failures per 40.

20. **Prompt v3 — summary polish (designed 2026-07-31, not built).** Lance asked "how do we get more
    polished summaries?" and chose the completeness axis FIRST (built). Remaining, in value order:
    (a) an authored `headline` field — one sentence, the thing a reader remembers — replacing the
    heuristic one-liner extraction (`extractOneLiner` currently takes stated purpose or the first
    bullet, so a vote row can be labeled by whichever provision happens to be first); (b) order
    bullets by consequence, not section order (HR 845's most consequential clause — "bars courts
    from reviewing" — renders last because it's Sec. 3); (c) tiered depth (HR 845 got 2 bullets,
    S 2 got 31; neither reflects a policy); (d) move stated purpose ABOVE the bullets — orientation
    currently renders after the detail; (e) juxtapose short title with content where they diverge
    (the *Pet and Livestock Protection Act* delists gray wolves — two sourced facts side by side is
    not editorializing). Requires a golden re-snapshot; ledgered stated_purpose long-title
    inconsistency rules one way here.

21. **Identity matcher: state-qualify federal House districts (latent gap, found 2026-07-31).**
    `terms.state` exists (added by T8c for address lookup) but was never threaded into
    `buildEvidenceRows`/`seatEvidencePairStatus`, so US House "district 1" in Alabama and Utah read
    as the same seat. Surfaced by the Barry Moore / Blake Moore flag. **Cannot cause a wrong merge**
    (a name mismatch downgrades to `ambiguous` unconditionally) — it can only ever ADD flags, unless
    two genuinely different people someday share both a full name AND a same-numbered district in
    different states. Non-blocking; fix when touching the matcher anyway.

22. **Federal history is current-Congress only.** 365,730 federal casts all come from the 119th
    (2025→). A senator's pre-2025 federal record simply isn't in the DB — e.g. McCaskill's Senate
    votes. Not wrong, just thin; the site labels dates honestly. Widening means more Congress.gov
    roll-call ingestion (free, polite, slow).

23. **The 275 undated 2024 MO House roll calls (accepted, ledgered).** Refused at ingest because
    they carry LegiScan's `0000-00-00` sentinel and their real dates are NOT honestly derivable
    (sample: a 104-45 perfection vote whose bill history prints no matching tally). All 275 are
    House roll calls the primary house.mo.gov pipeline supplies WITH real dates — so they arrive on
    that source's own 30-min-ToU timeline. Decision if ever revisited: leave refused (recommended)
    vs. store with a null date + honest "date unrecorded" display.

24. **Giant bills (11 over the 400k-char gate).** HRB 2467 (561k), HRB 1 (550k), SRB 975 (751k) and
    8 others refused rather than truncated during the text run. Options unchanged: raise toward the
    1M-token context (~$2-4/bill against Lance's ~$6 credits) or design chunked summarization.

## 📥 INBOX (raw idea capture, 2026-07-27, Lance's own words)

> "I'd like to expose all the politicians by breaking down the bills and laws they propose into
> layman terms so that everyone can easily read them and their purpose and then we can all see how
> our constituents voted on said bills so we can hold them accountable as they are CLEARLY running
> amuck these days"

Multi-faceted per Lance: (1) plain-language bill/law breakdowns, (2) purpose/intent surfaced
clearly, (3) voting-record tracking tied to individual legislators, (4) accountability - making the
above easy enough that regular people actually use it. Decomposed 2026-07-27 into the MVP design
draft — see NOW.
