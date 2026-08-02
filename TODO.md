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
  - **35 unpublished summaries — but "flagged" ≠ "draft", and only ~20 are actual problems.**
    `status` lives on `summaries`; a *verdict* lives on `summary_verifications`. There is no
    "flagged" status. Of the 35: ~20 carry an adverse verdict (real gaps), ~14 are clean but simply
    never published, 1 was never verified. Each needs Lance's read or
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

13. ~~**Freshness machinery (Lance priority, 2026-07-28): scheduled incremental ingestion**~~
    **BUILT 2026-07-31, awaiting Lance's registration** (commits 3e12a1e→6cf47cf; survived a
    3-round adversarial review, final verdict SHIP). `scripts/scheduled-ingest.js` /
    `npm run schedule:ingest`: five sources (mo-senate-web, mo-house-xml, us-congress, us-senate,
    legiscan), self-computed due-ness off the durable `ingestion_runs` signal, single-instance
    lock with declared-duration staleness, per-source timeouts (legiscan 75 min, evidence-derived),
    honest failure self-recording, refresh-aggregates gated on real per-source write counters
    (fail-open), dated logs, incapable of calling a model. **Registration = Lance runs the
    `schtasks` command in `docs/SCHEDULED_INGESTION.md`** (draft-then-apply; it runs forever on
    his machine). On registration the session-bound manual loops retire. Note: mo-senate-web
    continues feeding the TODO-25 duplicate session at today's rate until that merge lands —
    registering before or after the TODO-25 fix is Lance's call, both are safe.

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
    ~3,283 passage-vote bills still unsummarized — but only ~3,261 have text; **22 do not**, so size
    a batch off the text-bearing set (`npm run status` prints it as "READY to summarize"), never off
    the passage-vote count, or those 22 fail on missing text. Proven wave-1 shape: batches
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

---

### Live landmines recovered from the ledgers 2026-07-31 — these had fallen OUT of TODO entirely

30. ~~**⚠️ `npm run summarize` and `npm run verify` SPEND MONEY WITH NO GATE.**~~ **DONE
    2026-07-31** (commit 41936f0 + M4 cost-estimate lines in 6cf47cf): both now carry the same
    mechanical gate as gloss.js — `SUMMARIZE_RUN_APPROVED=yes` / `VERIFY_RUN_APPROVED=yes` —
    firing before any client construction; `--dry-run` stays freely runnable. Passed adversarial
    review. Original finding, for the record: `gloss.js`,
    `extract-terms.js` and `golden.js` all carry mechanical env gates
    (`GLOSS_RUN_APPROVED` / `GOLDEN_CHECK_APPROVED`), but `src/cli/summarize.js` and
    `src/cli/verify.js` have none and both default `dryRun: false` — they call
    `getAnthropicClient()` and bill straight through. This is the unfinished half of CLAUDE.md's
    own stated policy ("Mechanical enforcement exists where possible — extend that pattern to new
    model-calling tools") and it sits directly against Lance's standing spend hold. Fix = add the
    same guard clause both files, mirroring gloss.js:234.

31. **⚠️ MO HOUSE cross-era misattribution trap is STILL LIVE.** `0005_mo_house_id.sql` declares
    `mo_house_id text unique` — table-wide unique, never dropped (0009 dropped only the *senate*
    equivalent) — and `ingest-mo-house.js:794` still does `insertIfAbsent(..., 'mo_house_id')`
    against a current-only roster. This is the EXACT defect that was a reproduced CRITICAL on the
    Senate side: the unique index freezes each district to its first-ingested person, so a
    same-surname successor's votes silently attribute to the WRONG person. Dormant only because
    House ingestion has been single-era. **It fires the moment anyone runs a MO House
    historical/multi-era backfill** — a natural next step. Fix BEFORE any such backfill.

32. **`summarize.js` unbounded selects — the ledger said URGENT-WHEN-SUMMARIES-RESUME, and
    summaries HAVE resumed.** `src/cli/summarize.js:89` (bills), `:96` (`votes`), `:117`
    (summaries) are bare `.select()` with no `selectAll`, no `.range()`, no `.limit()`; `votes` is
    now ~10,000 rows, well past the 1,000 cap, so its candidate picker silently returns an
    arbitrary truncated subset. Wave 1 was safe only because it used `summary-queue.js` instead.
    Fix before anyone reaches for `summarize.js` again. (TODO 18 tracks this as "hygiene" — the
    ledger's own word was URGENT.)

33. **Two CLIs share `source='legiscan'` in `ingestion_runs` with different detail shapes**
    (surfaced by the 2026-07-31 scheduler review, reviewer-confirmed out-of-scope-but-ledger).
    `ingest-legiscan.js` (votes/bills) and `ingest-legiscan-texts.js` (doc blobs,
    `ingest-legiscan-texts.js:781`, deliberate per its own comment) both write the same source
    key, so any latest-row read — scheduler due-ness, `public_freshness` — sees whichever ran
    last. Every current consequence is fail-safe (a manual texts run can only *delay* the next
    scheduled legiscan tick, never advance it; the scheduler's refresh gate fails open on the
    texts shape). Real fix = split the source key (schema + CLI + historical-row migration
    touching `public_freshness`) — **draft-then-apply, Lance runs it**. Not urgent; recorded so
    the shared key stops being a surprise.

34. [x] ~~MO House driver silently slept ~30 minutes mid-run, wedged behind its own rate
    limiter — every scheduled run ETIMEDOUT.~~ **FIXED 2026-08-01.** `mo-house-xml.js:12`'s
    `moHouseLimiter` (30 min/request, per house.mo.gov's own ToU) is correctly *strict*, but
    `ingest-mo-house.js`'s old shape could need TWO live requests in one invocation — a stale
    `BillList.XML` refresh, then a per-bill XML fetch — both through that SAME shared limiter, so
    the second request just slept out the first request's ~30-minute interval in-process (zero
    connections, zero CPU, zero log output — invisible unless you caught the process alive).
    Under the scheduler's 480s child timeout every such run was killed first: mo-house-xml was
    3-for-3 ETIMEDOUT, effectively down. **The round-2 reviewer's "every historical run took an
    exact multiple of 1800 seconds" observation was THIS defect — misattributed at the time to
    MO-side slowness rather than an in-process double-fetch.** An earlier partial fix (caching the
    list at a 60-minute max-age) only reduced how *often* both fetches landed in one run; it
    didn't stop the combination once the cache aged out. Real fix: `runMoHouse`
    (`src/cli/ingest-mo-house.js`) now makes **at most one live house.mo.gov request per
    invocation**, mirroring `ingest-mo-senate.js`'s `runMoSenate` slot-priority shape — pending
    roll-call PDF, then a stale-list-refresh slot (spends the request, persists stubs, stops), then
    a fresh-list bill-detail slot (reads cache, no network, spends the request on one bill). The
    limiter itself is untouched (still 30 min, per ToU) and now doubles as a tripwire: a future bug
    making a second live request in one run would sleep and get killed LOUDLY by the scheduler
    instead of silently violating the ToU. `MO_BILL_LIST_MAX_AGE_MS` raised 60min → 24h (fewer
    whole runs spent on list housekeeping under the new one-slot-per-run shape). `--limit` > 1 is
    now a typed `LiveRequestLimitError` (there is only ever one live fetch to give a limit to); the
    scheduler's frozen `--limit 1` is unaffected. 9 new tests
    (`tests/mo-house-xml.test.js`), 2101/2101 green.

35. **MO Senate roster is duplicated in `legislators`** (found 2026-08-01, investigating TODO 25's
    vote-reconciliation flags). Every current senator has TWO rows — one LegiScan-sourced (party
    set), one mo-senate-web-sourced (party NULL) — plus at least one name-variant pair not
    unified (Mary Coleman / Mary Elizabeth Coleman). Currently harmless for tally comparisons (the
    duplication cancels out), but it's a live identity defect: casts and sponsorships could split
    across the two rows for the same real person, undercounting either row's activity on their
    profile page. Fix = identity merge pass scoped to the MO Senate roster (same exact-match
    machinery as the existing person-identity merger, not new logic) — not urgent, not blocking,
    but real and worth a dedicated pass.

---

### Defects found by the 2026-07-31 data audit (docs vs live DB) — none were previously recorded

25. **⚠️ The MO 2026 session is SPLIT IN TWO and the split is actively growing.** Session identifier
    `'2026'` carries `legiscan_session_id = NULL` — the only MO session missing one — and duplicates
    session `'261'` (legiscan 2239). All 16 of `'2026'`'s bill identifiers also exist under `'261'`,
    carrying 17 roll calls / 561 casts, and it grew 15→16 bills *during* the audit: the cron is
    feeding the duplicate. Contrast MO 2018, where the same adapter's row was correctly merged.
    **Highest-priority data defect** — it splits one session's record across two sessions on the
    public site. Fix = merge `'2026'` into `'261'` (draft-then-apply, Lance runs it).

26. ~~**2,005 bills have NULL title AND NULL canonical_url**~~ **DONE 2026-08-02.**
    `backfill-bill-titles.js` (commit 5ecd938) ran live: 1,972 of 1,975 NULL-title bills resolved
    from the cached LegiScan datasets, 0 failures. 3 remain (all `SRM` remonstrance resolutions
    LegiScan's own cache also has no title for — left untouched, never guessed). Independently
    verified against the live DB post-run. `canonical_url` NULL rows may still exist where
    LegiScan's cache carries no state link; not re-checked here, may be worth a follow-up count.

27. **Party vocabulary is unnormalized at the source table.** `legislators.party` holds `R` 391 /
    `Republican` 469 / `D` 209 / `Democratic` 463 / NULL 65 / `Independent Democrat` 1 / `''` 1.
    Migration 0018's matviews normalize R/D/I *for the aggregates*, but ~41.5k casts still fall out
    of party comparisons silently, and any consumer reading `legislators.party` directly sees the
    raw mess. Fix = normalize the column itself (same sourced-mapping discipline as the MO status
    correction), or make every consumer use the documented CASE.

28. **152 roll calls show a result with no member positions** (95 OpenStates 2022, 57 mo-house-xml
    2026). Affects **52 bills**: 23 also have a real cast-bearing row for the same event (so a bill
    page shows the same vote twice, e.g. HB 1800 "82-61 / 1 cast" beside "82-61 / 158 casts"), and
    29 show a printed result with zero names. Not data loss — LegiScan supplies the real casts — but
    it reads as broken. Fix = suppress or merge stub rows on the bill page.

29. **Hygiene:** 555 of 1,607 legislator rows have zero votes; `districts` table is empty (0 rows,
    never populated — the site never reads it); 0 rows have `image_url`/`contact` (photos derive
    from bioguide at render time, by design).

## 📥 INBOX (raw idea capture, 2026-07-27, Lance's own words)

> "I'd like to expose all the politicians by breaking down the bills and laws they propose into
> layman terms so that everyone can easily read them and their purpose and then we can all see how
> our constituents voted on said bills so we can hold them accountable as they are CLEARLY running
> amuck these days"

Multi-faceted per Lance: (1) plain-language bill/law breakdowns, (2) purpose/intent surfaced
clearly, (3) voting-record tracking tied to individual legislators, (4) accountability - making the
above easy enough that regular people actually use it. Decomposed 2026-07-27 into the MVP design
draft — see NOW.
