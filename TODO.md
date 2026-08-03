# VisibleGov — TODO / Backlog

*How to use: dump raw ideas in INBOX anytime. We triage from there into real work.*

---

## NOW

- [ ] **Comprehensive accuracy audit, 2026-08-03 — all 4 criticals fixed live, 2 items left for
  Lance's own call.** Full report: `docs/audits/2026-08-03-comprehensive-accuracy-audit.md`.
  **Fixed and verified live, all via tested `correct-data.js` corrections (dry-run then live) plus
  their root-cause code fixes:**
  1. ~~SB 914 tally contradiction~~ — root-caused, not yet adjudicated (see below — needs Lance).
  2. ✅ FECA/BBEDCA glossary terms no longer say what their own verification refuted
     (`correct-data.js glossary-refuted-claims`, live).
  3. ✅ All 7 corrupted glossary terms repaired, verified byte-clean (`correct-data.js
     glossary-corrupted-text`, live); a text-integrity gate now blocks this class going forward
     (`auto-publish-glossary.js`'s `hasTextCorruption`).
  4. ✅ Tommie Pierson Sr./Jr. split back into two unlinked legislator rows (`correct-data.js
     pierson-split`, live) — a same-source-key contradiction guard (`person-identity.js`'s
     `finalPairStatus`) now permanently prevents this class of wrong merge.
  **Also fixed (important findings, root causes):** `buildMoVoteRows` chamber-hardcoding bug fixed
  + the 3 live mislabeled Senate votes corrected (`correct-data.js mo-house-chamber`, live);
  migration `0023_vote_duplicates_rls_and_view_drift.sql` drafted (enables RLS on `vote_duplicates`
  for any future rebuild + corrects the committed 0022 file's view definitions to match what's
  actually live) — **awaiting Lance's apply**, same draft-then-apply pattern as every migration.
  **Two items left, deliberately not resolved by an agent:**
  - **SB 914 adjudication** (`vote_reconciliation_flags` id `214a2be0`) — checked the ALREADY-
    CACHED LegiScan dataset directly (zero new API calls): **Sen. Mike Moon and Sen. Steven Roberts
    are entirely absent from LegiScan's own roll-call vote data for this roll call** — not counted
    as yea/nay/absent, just missing (LegiScan's own total field says 32, not the Senate's real 34).
    The MO Senate journal (primary source, 28-1, Moon's NAY) is the more complete record; LegiScan's
    "29-0" reflects an incomplete 32-of-34 tally, not genuine unanimity. Strong evidence, but
    attributing a specific senator's public vote record is Lance's call, not an agent's to make
    silently — needs his adjudication of the flag.
  - ✅ **`legiscan_datasets` locked down — applied and verified live 2026-08-03.** Migration `0024`
    (dropped the `anon_read` policy) ran clean. Verified with both keys: anon now gets `200 []`
    (RLS default-deny, matching `vote_reconciliation_flags`' posture), service-role still sees all
    31 rows intact — no data touched, only public reachability.
  **Verdict on the one non-negotiable:** political neutrality and facts-only were genuinely clean —
  zero violations found across the dedicated audit domain. Every defect found and fixed was a
  mechanical accident, none partisan.
  **Also from this audit:** two verification subagents materialized the live Supabase service-role
  key in plaintext (one bash command, one scratchpad file) — the harness auto-flagged both, the
  on-disk file was found and deleted immediately. Never touched the repo/git. Lance's call whether
  to rotate the key as a precaution.
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
  - **98 unpublished summaries remaining (2026-08-02, corrected count — was 106 before today's
    backfill).** `status` lives on `summaries`; a *verdict* lives on `summary_verifications`. There
    is no "flagged" status. 15 of the original 106 needed zero judgment — they only ever had ONE
    verification axis run (14 completeness-only, pre-dating the completeness axis; 1 fully
    unverified). Ran the missing axis via the $0 subagent path, mechanically re-derived (never
    trusting subagent self-report): **8 auto-published outright**, 7 joined the queue with a named,
    specific missing-provision reason. Full trail: CHATLOG 2026-08-02 "the review queue backfill".
    **Severity-sorted review queue — SHIPPED 2026-08-03.** `npm run review`'s summaries queue now
    sorts single-issue items first (a citation-lookup-sized task) and shows each item's issue count
    plus, for a completeness-incomplete item, the actual missing provision — data that existed since
    the completeness axis shipped but was never reachable from this server before. Spec:
    `docs/superpowers/specs/2026-08-03-severity-sorted-review-queue-design.md`; plan:
    `docs/superpowers/plans/2026-08-03-severity-sorted-review-queue.md`. No schema change, live the
    moment the code landed. Verified live via Playwright against the real 98-item queue: sort order
    correct (0 → 6 issues), single-issue labels name the right provision, item detail matches the
    queue. Suite 2221/2221 green.
  - **49 open vote-reconciliation flags (2026-08-02, up from 9)** — grew during the TODO-25
    session-merge live run, which surfaced 29 real cross-source discrepancies (Sen. Fitzwater's
    yea vote present in every LegiScan roll call, absent from every Senate-journal-sourced one — one
    root cause, not 29 separate mysteries) rather than hiding them. Source discrepancies held out of
    the clean record by design; not a backlog to auto-clear.
  - **Bullet-citation exposure — SHIPPED AND LIVE 2026-08-03.** Migration 0021 applied by Lance;
    `node scripts/probe-public-surface.js` confirmed the `citations` column present and correctly
    gated/shaped against 220 real live rows, 0 violations; a live anon-key spot-check showed real
    verbatim quotes flowing through with only the three intended fields. `trust.html`'s receipt
    claim ("the exact quoted excerpt it came from") is now true for bill summaries, not just
    glossary terms. Fully closed, nothing left.
  - **Cross-adapter vote duplicate dedup — SHIPPED AND APPLIED LIVE 2026-08-03.** Migration applied
    by Lance in the SQL editor. `npm run refresh:aggregates` hit a PostgREST statement timeout
    (~8s, consistent across two attempts) — the RPC does three `REFRESH MATERIALIZED VIEW
    CONCURRENTLY` passes over 1.46M+ `vote_casts` rows in one call, longer than the REST API's
    timeout allows. Worked around by running `select refresh_vote_aggregates();` directly in the
    SQL editor (bypasses PostgREST, same as the migration itself) — succeeded, matview counts
    confirmed unchanged (11,466 / 3,042 / 198, as expected with zero duplicates marked yet).
    **The backfill correction found ZERO clean matches (dry-run and live both), and this is
    correct, not a bug** — traced one real candidate pair (LegiScan roll call 1673444 vs.
    `mo-house-xml-HB1623-3`, same bill/chamber/date, LegiScan tally 103-48) through the actual
    matching code: MO's own `vote_casts` table has only 1 individual legislator position stored
    for that vote despite the "103-48" printed aggregate, so `isPrimaryCastDataComparable`
    correctly declines to certify a match it can't verify. Checked more broadly: 0 of 92 sampled
    primary-source votes with a parseable aggregate result had enough `vote_casts` rows to pass
    this same check. **This is a larger-scale version of an already-documented condition**
    (`docs/DATA_INVENTORY.md`'s "169 roll calls with zero individual casts," MO House rows "with
    individual casts arriving later on the same row") — the real scope of "not caught up yet" is
    much bigger than the documented 169/74 figures suggested, but it predates tonight's work and
    isn't a defect in it. Practical effect: the feature is live and correctly wired end-to-end
    (both the live-ingest write path and the backfill), it just has ~0 real-world yield right now
    given the current state of `mo-house-xml`'s per-legislator cast data — it will pick up real
    duplicates automatically once/if that data catches up on a given vote. **Separate, bigger
    question worth its own look, not chased further tonight:** is `mo-house-xml`'s roll-call-PDF
    cast-parsing pipeline (`ingest-mo-house.js`) actually keeping up, or effectively stalled for
    most votes? That's a distinct investigation from vote-duplicate dedup.
  - Implements CONTROLLER RULING 3 (decided 2026-07-29, never built): "the primary-source
    (journal/PDF) row wins for display whenever both exist for the same real floor vote." Both
    LegiScan and MO's own primary-source adapters (`mo-house-xml`, `mo-senate-web`) can legitimately
    each write their own `votes` row for the same real vote — nothing deduped this before, so every
    duplicated vote was counted TWICE in the vote-aggregate matview percentages, not just shown
    twice in a list. Non-destructive (mirrors the `persons`/`person_links` precedent — a new
    `vote_duplicates` grouping table, neither row ever deleted or rewritten), detection reuses the
    existing `crossCheckAgainstPrimarySource` matching logic, wired into live LegiScan ingest going
    forward plus a one-time backfill correction (`correct-data.js vote-duplicates`) for the existing
    backlog. Spec: `docs/superpowers/specs/2026-08-03-vote-duplicate-dedup-design.md`; plan:
    `docs/superpowers/plans/2026-08-03-vote-duplicate-dedup.md`. Suite 2192 → 2235 (43 new tests),
    0 fail. **Two things found live during implementation, both fixed and both worth knowing about:**
    (1) `crossCheckAgainstPrimarySource` has a THIRD clean-match branch beyond the two the original
    design found (a plain singleton/singleton match with no `reason` string at all) — a
    `reason`-based gate silently missed it; fixed by gating on `matched` instead, which every
    clean-match branch sets. (2) `correct-data.js` has its own tested rule that it must NEVER call
    `crossCheckAgainstPrimarySource` directly (that function writes reconciliation flags as a side
    effect, which a backfill against already-published data has no business triggering) — the
    backfill correction reimplements the matching locally using only the pure comparison helpers,
    mirroring this file's own existing 1969-sentinel-date correction's established pattern.
    **Migration 0022 SQL bug found+fixed 2026-08-03:** Lance's first live run errored (`42809:
    "public_position_totals" is not a view`) — two stray `drop view if exists ... cascade;` lines
    tried to drop objects that are actually materialized views (Postgres's `DROP VIEW` refuses that
    even with `IF EXISTS`). Fixed (commit `1858195`) by removing both stray lines, keeping the
    correct `drop materialized view` lines already present on the next line down. Confirmed live via
    REST probe that the failed attempt rolled back cleanly as one transaction — nothing partial,
    nothing to clean up. The corrected file is what's in the repo now; safe to run as-is.
  - **`legiscan` production bug — root-caused and confirmed already fixed, 2026-08-03.** A live
    ingestion run failed (`vote_reconciliation_flags_dedup_key` duplicate-key violation, run
    `d56bf115`, 2026-08-02T07:30:03Z) — a real application bug, not just the 24h retry interval
    doing its job (an earlier same-day claim in conversation that it was "just waiting it out" was
    incomplete). Investigated via three independent blind angles (live-data forensics, code-path
    audit, git-history audit) then adversarially reviewed. Confirmed: already fixed on `main`
    (commit `b1adbfa`, same day, ~3h after the failure) — a recurrence of PLAYBOOK_DELTA Lesson 21
    (a `roll_call_id` JS string-vs-number type mismatch let a pre-existing flag row slip past the
    in-memory idempotency check in `findExistingReconciliationFlag`). Verdict: SHIP, high confidence
    for the next scheduled retry (~2026-08-03T07:30Z). Two non-blocking follow-ups noted, not acted
    on: an `ORDER BY`-less candidate query at `legiscan-votes.js:628-634` (latent nondeterminism,
    unrelated to this bug) and an unresolved "which exact row supplied the colliding partner"
    question (doesn't affect the fix's correctness — it's structural/symmetric). Full writeup in
    `docs/CONTROLLER_BRIEFING.md`'s 2026-08-03 addendum.
  - **Documentation refresh pass — complete 2026-08-03.** `README.md`, `CLAUDE.md`,
    `PLAYBOOK_DELTA.md` (Lessons 23-24 added), `docs/DATA_INVENTORY.md`, `docs/CONTROLLER_BRIEFING.md`,
    `docs/ARTIFACTS.md`, `docs/SCHEDULED_INGESTION.md`, and three memory files all refreshed. The two
    background doc-refresh diffs were independently re-verified against live reality before being
    trusted (this project's own "never trust a self-report" discipline) — one real error was caught
    and fixed before commit: `CONTROLLER_BRIEFING.md` claimed PLAYBOOK_DELTA was "still 22 lessons,
    unchanged since 08-02," actually 24 (Lessons 23-24 landed the same day). Everything else in both
    diffs held up under direct re-verification.
  - **Cloudflare Pages (deferred, steps preserved for when Lance calls it):** connect
    `lazrexmc/VisibleGov`, production branch `main`, build command EMPTY, **Root directory `site`**
    (required, or `_headers` + the geocode Function are not discovered). Verify at deploy:
    `/geocode` responds, `_redirects` rewrites survive a hard refresh, CSP headers present (open
    question: whether `_headers` covers Pages Function responses).

## 🛠 BUILD QUEUE

**Housekeeping note (2026-08-03): items 0 and 5-9 below were flagged as stale in an earlier
review ("TODO build-queue items 5 and 6 are open... both completed and merged; the checkboxes are
stale," `docs/CONTROLLER_BRIEFING.md`'s "Things I might wrongly believe" table) and never actually
fixed until now. All are genuinely done — cross-checked against the NOW section above and this
session's own direct work, not assumed.**

0. [x] ~~NEXT PLAN — LegiScan bulk adapter~~ **DONE 2026-07-29, further refined 2026-08-02
   (TODO-33 source split).** Live and is the primary MO ingestion path today, registered in
   `scripts/scheduled-ingest.js`. Substitute-vehicle attribution (SB 894/SBs 894 & 921) resolved
   per `docs/research/2026-07-29-legiscan-substitute-vehicles.md`.

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
5. [x] ~~Summarization CLI (versioned prompt, hash-tied to bill text version, review queue)~~
   **DONE — Plan 2, complete 2026-07-28, trust model v3 fully live since 2026-07-31.**
6. [x] ~~Public site: directory, legislator page, bill page, address lookup (Census Geocoder)~~
   **DONE — Plan 3, complete 2026-07-30, merged to main.** Deploy itself is the separate,
   deliberately-deferred Cloudflare milestone (see NOW above).
7. [x] ~~Staff `/admin` review queue~~ **DONE** — `src/review/server.js` / `npm run review`,
   severity-sorted as of 2026-08-03. Local-only (127.0.0.1) by design; no public-facing
   `/admin` route exists or is planned.
8. [x] ~~Identity merge: link federal+MO legislator rows~~ **DONE — complete 2026-07-31.**
   1,607 rows → 37 merged persons; 4 identity flags remain open (Lance's own decisions, not a
   build item).
9. [x] ~~MO individual roll-call votes (OpenStates has none)~~ **DONE — the `mo-house-xml`
   adapter this item specified was built exactly as researched** (XML action-history + linked
   `RollCallPDF`, no OCR needed) and is one of the five sources `scripts/scheduled-ingest.js`
   runs on its own registered schedule. The original item's text is kept below as the research
   trail, not because the work is still open.

   <details><summary>Original research (2026-07-27), preserved for context</summary>

   MO individual roll-call votes (OpenStates has none) — confirmed across 4 sessions/305 sampled
   vote events (2022/2021/2019/2017: exactly 1 event with voter data). **Investigated 2026-07-27
   (Task 9, full findings in `docs/research/2026-07-27-mo-data-sources.md`).** Narrower than
   "scrape the journal": house.mo.gov runs its own no-auth, live, hourly XML export
   (`documents.house.mo.gov/xml/...`) that gives clean per-bill action history, but its `RollCall`
   element is aggregate tallies only — individual votes live one hop away in a linked
   `RollCallPDF`, confirmed real and text-layer (not scanned — extracts cleanly, no OCR needed) via
   a live fetch. Build a `mo-house-xml` adapter against that XML + PDF pair (see the research doc's
   proposed adapter shape) — no signup, no ToU ambiguity ("made available for public use").
   Separately, LegiScan's `getRollCall` operation is confirmed (via its own official client source,
   not a live MO payload — no key was registered) to return individual `people_id`/`vote_id` votes
   in general; whether MO's data is actually populated is the one open question a real key would
   settle in one call, and could replace the PDF-parsing step if so. Bill full text is PDF-only at
   the MO primary source either way (confirmed) — either path needs a new PDF-text-extraction
   dependency before `summarizeBill()` can run on MO text, which isn't built yet.

   </details>
10. [x] ~~Plan-2 first commits~~ **(b), (c), (d) confirmed DONE 2026-08-03**: (b) `additivePatch`
    is now called from `legiscan-identity.js`, `backfill-mo-bill-meta.js`, `backfill-nicknames.js`,
    `enrich-federal-bills.js`, `ingest-legiscan.js` (grep-verified — it was genuinely unwired at the
    time this item was written); (c) editor_notes RLS resolved 2026-07-27, see NOW section above;
    (d) `public_freshness` (migration 0016) is exactly this — source/status/finished_at only, no
    `ingestion_runs` internals. **(a) and (e) NOT re-verified this pass — genuinely unknown status,
    don't assume either way without checking.** Original text, for whoever checks next:
    (a) fail-loud chamber parsing in both adapters (kill the silent 'house'/'senate' fallback
    guesses); (e) generalize or remove the Onder-specific MO-term config fallback before MO
    ingestion widens.

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
    **BUILT 2026-07-31, REGISTERED AND RUNNING** (commits 3e12a1e→6cf47cf; survived a 3-round
    adversarial review, final verdict SHIP). Lance ran the `schtasks` registration 2026-07-31 late
    night (S4U logon); confirmed live via scheduler logs and `ingestion_runs` tick spacing —
    ~15-minute cadence, still ticking as of 2026-08-02. `scripts/scheduled-ingest.js` /
    `npm run schedule:ingest`: five sources (mo-senate-web, mo-house-xml, us-congress, us-senate,
    legiscan), self-computed due-ness off the durable `ingestion_runs` signal, single-instance
    lock with declared-duration staleness, per-source timeouts (legiscan 75 min, evidence-derived),
    honest failure self-recording, refresh-aggregates gated on real per-source write counters
    (fail-open), dated logs, incapable of calling a model. The session-bound manual ingestion loops
    have retired. **Open concern (2026-08-02): `legiscan` source shows `status: failed`, last
    finished 2026-08-02T07:34:46 — the root cause (roll_call_id type mismatch) was fixed in code
    the same day, but the source hasn't ticked again since to confirm the fix took. legiscan's
    due-ness interval is long (query-budget-conserving), so this may simply not be due yet — worth
    checking `npm run status`'s INGESTION FRESHNESS section, or running `node --env-file=.env
    src/cli/ingest-legiscan.js` manually, next session.**

31. **MO House cross-era misattribution trap — verified still open 2026-08-02.**
    `0005_mo_house_id.sql:11`'s `mo_house_id` unique column was never dropped (0009 dropped only
    the Senate equivalent, after this exact bug reproduced as CRITICAL there); `ingest-mo-house.js`
    still calls `insertIfAbsent(..., 'mo_house_id')` against a current-only roster with no
    unique-violation handling (the Senate driver has `isMoSenateIdUniqueViolation`; the House
    driver has no equivalent). Dormant only because House ingestion has been single-session so far
    — **fires silently the first time anyone backfills a prior MO General Assembly.** Put on the
    record here specifically so a future multi-era House backfill doesn't rediscover it live.
32. **`summarize.js`'s candidate-picker `.select()` calls are still uncapped — verified still open
    2026-08-02.** `src/cli/summarize.js`'s `loadFederalBills` reads `sessions`/`bills`/`votes` via
    bare `.select()` (no `selectAll`, no `.range()`/`.limit()`) against 38k+ bills and 10k+ votes,
    both past Supabase's 1,000-row default cap — returns success with a silently wrong candidate
    list. Both summary waves since this was first flagged (2026-08-01 wave 2, 2026-08-02 review-
    queue backfill) routed around this CLI via `summary-queue.js`/dedicated scripts, so it hasn't
    fired again — but it's still armed for the next person who calls `summarize.js` directly.

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

33. [x] ~~Two CLIs share `source='legiscan'` in `ingestion_runs` with different detail shapes~~
    **CODE FIX SHIPPED 2026-08-02** (`.superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/
    brief.md). `ingest-legiscan-texts.js` now writes its own `RUN_SOURCE='legiscan-texts'`
    (`src/cli/ingest-legiscan-texts.js`), never the shared `SOURCE`. This entry's own original
    text understated the risk: splitting the key naively (no other change) would have let each
    CLI's own pre-flight budget check see only ITS half of the real spend against the ONE real
    LegiScan account's 30,000/month cap — a genuine terms-violation risk, not just a display bug.
    Fixed alongside the split: `getMonthlyQueryUsage`/`assertRunUnderBudget`
    (`src/adapters/legiscan.js`, `src/cli/ingest-legiscan.js`) now accept an array of sources and
    sum them; BOTH CLIs' own budget checks pass `ALL_LEGISCAN_SOURCES` (the combined pair), proven
    by an explicit cross-CLI refusal test in each direction. No schema migration was needed
    (`ingestion_runs.source` is unconstrained `text`) — `correct-data.js`'s new
    `legiscan-source-split` correction (`runCorrectLegiscanSourceSplit`) is the historical-row
    fix, **built ready, `--dry-run` verified against the real live DB (54 rows: 2 relabel to
    `legiscan-texts`, 52 stay `legiscan`, 0 unclassified) — Lance runs the live pass himself**,
    same draft-then-apply convention as every other correction in that file. **Independent
    adversarial review: SHIP.** The reviewer hand-traced the actual production budget-check call
    sites (not just the pure helpers) and hand-computed both refusal directions with real numbers,
    and independently re-derived the 54-row classification from a from-scratch script against the
    live DB — exact match, same 2 row ids. Live command whenever Lance wants it:
    `node --env-file=.env src/cli/correct-data.js legiscan-source-split`.

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

35. ~~**MO Senate roster is duplicated in `legislators`.**~~ **RE-INVESTIGATED 2026-08-02, NOT A
    DEFECT — closing with a corrected record.** The original 2026-08-01 finding was based on an
    incomplete read. Live check: 30 of 34 MO senate seats DO show two rows per `mo_senate_id`, but
    they're two DIFFERENT real people, not duplicates — normal district succession across eras
    (e.g. senate seat 1: Scott Sifton, an earlier occupant, vs Doug Beck, the current one).
    Confirmed directly: Sifton carries ZERO `terms` rows, so the identity matcher correctly leaves
    him unlinked — there's no era data to safely match against, exactly the right call, not a
    missed merge. The Mary Coleman / Mary Elizabeth Coleman pair — TODO 35's own cited example —
    is **already merged to the same person_id**, disproving the "not unified" claim outright. The
    one genuine ambiguity in this roster (Dan Brown / Justin Brown, senate seat 16) was ALREADY a
    known, open identity flag before this investigation — untouched, still awaiting Lance's read,
    exactly where it belongs. Building an automated "MO Senate roster merge" as originally proposed
    would have risked the exact cross-era mis-merge class this project has been hurt by before
    (the Symington father/son near-miss); verifying first caught that a fix wasn't needed at all.

36. [x] ~~A live LegiScan run failed with an unhandled duplicate-key error on
    `vote_reconciliation_flags`.~~ **FIXED 2026-08-02**, found by a post-TODO-27 verification
    sweep, not by the failure itself surfacing loudly. Root cause: TODO 25's vote-reconciliation
    correction parsed `roll_call_id` out of a `source_key` via regex (always a string); LegiScan's
    own live path reads the same logical field straight out of JSON (a number). The idempotency
    pre-check compared them with strict `===`, missed the match the DB's own type-coercing unique
    index correctly caught, and the resulting duplicate-key error propagated because the
    race-recovery recheck used the identical broken comparison. Fixed at both ends: the comparison
    now coerces both sides to `Number` (`legiscan-votes.js`), and the parser now returns a real
    number instead of a raw capture group (`correct-data.js`) — see PLAYBOOK_DELTA lesson 21. One
    live legiscan run failed on this (2026-08-02T07:30, `queries_used:1`) — self-healing on the
    next scheduled tick, no data lost (the flag rows themselves were written correctly, only a
    LATER re-check of them failed) — not manually re-triggered here to avoid spending LegiScan
    query budget confirming something a red-then-green unit test already proves precisely.

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

27. ~~**Party vocabulary is unnormalized at the source table.**~~ **DONE 2026-08-02.**
    `correct-data.js party-normalize` ran live: 391 `R`→Republican, 209 `D`→Democratic, 1 empty
    string→NULL (a LegiScan-sourced blank, not a valid party value). Independently verified against
    the live DB (860 Republican, 672 Democratic, 66 NULL — exact expected deltas). `Independent`
    (already a word) and `Independent Democrat` (Joseph Lieberman's real, historically accurate
    affiliation, bioguide L000304) deliberately left untouched — checked both by hand before
    writing any code, never guessed. Mapping sourced from migration 0018's own already-reviewed
    CASE expression, not invented.
    - **Found along the way (real, unrelated, worth its own entry): this project's Supabase
      endpoint never populates `count` on `.update().select()`.** Silently broke the REPORTED
      counts (not the data) on two shipped corrections (`mo-status`, `party-normalize` itself) and
      a concurrent-write safety check in `backfill-bill-titles.js` — all fixed same-day, see
      PLAYBOOK_DELTA lesson 20 for the full mechanism and the fake-test-client fix that had been
      masking it.

28. ~~**152 roll calls show a result with no member positions.**~~ **DONE 2026-08-02.** Live
    investigation found the original framing conflated two structurally different causes needing
    different treatment (167 rows / 60 bills by the time this ran, up from 152/52 — ongoing
    ingestion, not drift): `mo-ocd` (OpenStates, 95 rows) are permanent bill-action-log stubs — a
    bare "pass," never a real tally, several per bill, zero reader value once real data exists
    elsewhere on the bill. `mo-house-xml` (72 rows) carry real specific tallies already ("93-42")
    with casts landing later from a separately-polled PDF that updates the SAME `vote_id` in place
    — never a duplicate, never safe to suppress. Fix (display-only, `site/js/bill-page.js`, no data
    touched): OpenStates zero-cast rows are hidden ONLY when the bill has a real cast-bearing vote
    elsewhere (bill-level, never a row-to-row pairing — the sampled data proved no honest 1:1
    correspondence exists to find); any zero-cast row that still renders gets honest wording
    ("no individual member votes recorded for this record") instead of a bare all-zero line that
    reads as a real, strange outcome. Verified live via dev server + Playwright: HR 3737 went from
    4 rows (2 real + 2 misleading stubs) to 2; a mo-house-only bill still shows both pending rows,
    correctly never suppressed, with the new honest wording.

29. **Hygiene, re-verified 2026-08-02, no action needed:** `districts` table still empty (0 rows,
    never populated — the site never reads it); 0 rows have `image_url`/`contact` (photos derive
    from bioguide at render time, by design). Both confirmed by design, not decay.

## 📥 INBOX (raw idea capture, 2026-07-27, Lance's own words)

> "I'd like to expose all the politicians by breaking down the bills and laws they propose into
> layman terms so that everyone can easily read them and their purpose and then we can all see how
> our constituents voted on said bills so we can hold them accountable as they are CLEARLY running
> amuck these days"

Multi-faceted per Lance: (1) plain-language bill/law breakdowns, (2) purpose/intent surfaced
clearly, (3) voting-record tracking tied to individual legislators, (4) accountability - making the
above easy enough that regular people actually use it. Decomposed 2026-07-27 into the MVP design
draft — see NOW.
