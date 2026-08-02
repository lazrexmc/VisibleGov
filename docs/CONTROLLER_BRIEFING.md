# VisibleGov — Controller Catch-Up Briefing
*Compiled 2026-07-31 from 105 SDD ledgers, 5 specs, 9 plans, 4 research docs, 21 migrations, the 925-line CHATLOG, PLAYBOOK_DELTA (17 lessons), TODO.md, DATA_INVENTORY.md, and live code verification.*

*Refresh pass 2026-08-02: sections 3 and 5 rewritten below to reflect what actually happened to*
*TODO 25-29 (and 33, 35) since compile — all closed or corrected, verified against CHATLOG.md's*
*2026-08-01/02 entries and TODO.md's own struck-through items, not assumed. Live-reverified counts*
*this pass: test suite 2,192/2,192 green (`node --test` from repo root); migrations still 21 files*
*(0001-0020 + 0018a, unchanged); PLAYBOOK_DELTA now has 22 lessons (`grep '^## Lesson'`), up from*
*17 at compile — lessons 18-22 landed 2026-08-01/02; CHATLOG.md is now 1,293 lines (was 925).*
*Sections 2 and 4 below are an unaltered historical record and were NOT touched by this pass.*

---

## 1. Standing rules I must not violate

### Lance's directives (his words)

**API spend is gated, and the hold is still on.**
> "API calls using Claude should be approved by me so they do not get excess in this build" (CHATLOG.md:315)
> "no more spending credits. Figure out how to do it otherwise for a bit or just hold the items that need spending approval back for a bit." (memory/no-api-spend-hold.md, 2026-07-28)

All volume work runs the $0 subagent path (`summary-queue.js record`). ~$6 credits are earmarked for exactly two named cases: the parked golden drift check (~$0.35, pre-approved) and the 11 over-400k bills.
**RESOLVED 2026-07-31** (commit 41936f0): `npm run summarize`, `npm run verify`, `npm run gloss`, `npm run extract-terms`, `npm run golden` all still exist in package.json, but every one now carries a mechanical env gate (`SUMMARIZE_RUN_APPROVED`, `VERIFY_RUN_APPROVED`, `GLOSS_RUN_APPROVED`, `GOLDEN_CHECK_APPROVED`) firing before any Anthropic client is constructed; `--dry-run` stays freely runnable on all of them. This section originally flagged `summarize.js`/`verify.js` as the two ungated holdouts — that gap is closed; leaving this paragraph in place (rather than deleting it) so the historical trap is still legible to a reader who encounters the old framing elsewhere.

**Cloudflare deploy is a MILESTONE, not a task.**
> "I'm only interested in starting the cloudflare portion once the entire backend is locked in and accurate, otherwise I'm troubleshooting two systems back and forth and each change takes 3 steps instead of 1." (CHATLOG.md:794)

Do not propose deploying until he says the backend feels solid. **TRAP:** the site is built, merged to main, and `site/config.js` already holds the real URL + anon key — it *looks* ready, which is exactly when an agent proposes it.

**Facts-only is the product's soul.**
> "There should be no editorial summaries here, people put their emotions into their summaries, we are only looking for facts. Bills proposed, votes made, votes missed, etc." (CHATLOG.md:267)

Scorecards, ratings, grades are **"permanently out, not deferred"** (public-site design spec, Non-negotiables). The vote-aggregate carve-out Lance granted 2026-07-30 is arithmetic-only: **member-vs-own-party-aggregate is allowed; member-vs-member never is.** Thin data renders as honestly thin — never hidden, never padded.

**Backend correctness outranks UI.**
> "I'm not entirely overly concerned about the front end web page and UI yet, I am laser focused on the back end information being correct, available, and up to date" (CHATLOG.md:410)

**The legislator profile page IS the product.** Bills/summaries are its feedstock (CHATLOG.md:345). Profile-completeness work outranks standalone bill-page work.

**Draft-then-apply, always.** Every migration 0001-0020 was written by an agent and applied by Lance in the Supabase SQL editor. The service key is in `.env` and every CLI writes production — it is *mechanically possible* for an agent to apply schema/bulk corrections itself. It has never been done. Don't start.

**New runtime dependencies require Lance's explicit per-dependency approval.** Exactly three exist: `pdfjs-dist` (pinned 6.1.200), `yauzl` 3.4.0, `jsdom` (dev). The plans say it flatly: *"the controller's recommendation is NOT the approval."*

### External terms — suspension-level

`docs/research/2026-07-28-legiscan-terms.md` marks three rules ⛔ (they enforce with suspension):
- **dataset_hash comparison is MANDATORY before any getDataset download** — "failure to do so will result in suspended access." The stored hash lives in the `legiscan_datasets` table (0010), *not* in cached files.
- **Never scrape legiscan.com's front end. API only.** TRAP: when a field is missing from the API, fetching their HTML page is the obvious fallback and it risks the key the whole MO backfill depends on.
- **One key. Never create additional Public API keys.** "The cap hit, I'll register another" is an account-suspension move.

Plus: 30,000 queries/month (repo self-imposes a HARD refusal at 5,000), doc blobs downloaded at most once per doc_id, CC-BY attribution on every public surface.

**MO 30-minute cadence.** house.mo.gov ToU, verbatim: *"Do not automate scripts to pull down information more often than once every half hour."* The Senate has **no ToU at all**, and the research doc rules on it explicitly: *"UNKNOWN, not 'no restrictions exist'... treat the Senate exactly as strictly as the House's documented half-hour cadence."* `docs/ARTIFACTS.md`: **"Do not raise that interval."** TRAP: a crawling backfill makes the limiter look like a perf bug.

### Project law

| Law | Where |
|---|---|
| **Zero fuzzy matching, anywhere, ever.** Full-name(+source-printed-variant) match is a NECESSARY condition for any automated identity link, forever. Ambiguity NEVER resolves toward a merge. | PLAYBOOK lesson 13 (Symington father/son live mis-merge); CHATLOG:729 |
| **Reconcile-or-throw.** A vote block whose parsed surnames ≠ the printed `—<count>` is NEVER stored. Typed `JournalParseError`. | mo-senate-adapter plan, Global Constraints |
| **skip ≠ empty.** A rate-limit/failure is a distinct typed error state, never an empty result — in ingestion *and* in the UI (loading / failed-with-retry / honestly-empty are three states; a failed fetch must never render as "no recorded votes"). | PLAYBOOK §3.1; public-site plan |
| **Fail-loud identity.** `resolveMoSenator` returns an id on exactly 1 match else `null`; unresolved casts recorded and skipped, never guessed. | mo-senate plan |
| **Additive writes only.** `insertIfAbsent`/`additivePatch`; a non-null value is never overwritten; `run_id` on every row. | PLAYBOOK §3.5 |
| **Never trust a model's self-report.** `verify.js:~109` DERIVES `overall` mechanically. Under trust-model v3, clean items **auto-publish unattended** — this gate is the entire wall between "looks fine to me" and the public site. A refactor reading the model's own `overall` removes the wall with every test still green. | PLAYBOOK lesson 2 + 15; trust-model-v3 spec |
| **Glossary/summary content comes from fetched official text only — never model knowledge.** Enforced by `glossary_terms_published_complete` CHECK. | 0007 header; glossary design |
| **Identity merge is VIRTUAL and permanent.** Source rows never rewritten; votes stay keyed by `legislator_id` forever; `person_id` is a read-time grouping. Wrong-merge = unacceptable; missed-merge = benign. | identity-merge design; 0012 |
| **DESIGN FREEZE: no new per-state identity columns, ever.** `mo_senate_id`/`mo_house_id` "are the LAST of their kind"; new states ride `legiscan_people_id` + terms. | 0014 header |
| **The MO Senate journals pipeline is COMPLETENESS-CRITICAL, permanently — NOT demotable to audit cadence.** LegiScan's `ls_bill_vote.bill_id` is a scalar FK, so combined-vehicle floor votes (how most major MO bills pass) structurally cannot exist there. Proven: SBs 894 & 921, a real 31-0 vote LegiScan has zero record of. | legiscan plan Task 8 revision |
| **Never synthesize a second votes/vote_casts row for a sibling bill.** It double-weights one real floor action in every aggregate. Sibling display is solved by matching `votes.question` text, never by writing a row. | legiscan-substitute-vehicles research |
| **Geocoder: nothing stored or logged, ever — "a review-blocking requirement, not a comment."** And it must stay **POST, not GET**: Cloudflare logs `ClientRequestURI` at the edge regardless of what the function does, so `?address=` would put home addresses in our own edge logs. | public-site spec §5; `site/functions/geocode.js` |
| **Implementers are STRICTLY SERIALIZED. No exceptions, regardless of file disjointness.** Two incidents (a mid-edit red test file swept into another agent's whole-tree run; `git commit -a` sweeping another task's uncommitted files). | profile-completeness ledger |
| **Gate commits on the extracted fail count, never a filter's exit status.** `... \| grep "^ℹ (tests\|pass\|fail)" && git commit` succeeds because grep *finds* `fail 15`. Shipped a red suite twice. | PLAYBOOK lesson 14; CLAUDE.md |
| **`node --test` from repo root, NEVER with a directory argument** (Node 24 / Windows). | public-site plan |
| **`scripts/refresh-aggregates.js` at the end of every controller loop batch**, and **only one ingestion loop at a time.** | public-site ledger |
| **MO bill PDFs are "not official copies and should not be quoted or cited."** Provenance rule, shipped as `MO_DISCLAIMER_TEXT`. | mo-senate-sources research |

---

## 2. Recurring defect classes (each has bitten ≥2×)

**A. Cross-era / identity conflation — 7 counted appearances, 9 distinct channels, re-fired 2026-07-31.**
Channels so far: district-as-permanent-key unique index; roster fallback to *today's* roster for historical years; era-blind replay; stale current-year cache; dateless same-seat pairs defaulting to "compatible"; surname-only auto-linking (rolled-back live run: Symington, Adams, Walker); comma-suffix defeat through all three layers; terms-evidence query unscoped by jurisdiction; "ambiguous" qualifying for attach suggestions (the Bayh trap). Latest: Menendez Sr./Jr., concurrent service, identical names, different chambers.
**Guard:** every new roster ingest / matching predicate / evidence source / replay path must be explicitly attacked against this class before going live. And: **do not trust `auditClusterCoherence`'s `ok:true`** — read `residualOnlyClusters` and hand-inspect full row+term detail for each before any write. On 2026-07-31 all 31 ready-to-write clusters were residual-only.

**B. Run-ledger counts wiped or omitted on close/abort paths — 5 instances, one shipped to production.**
`closeRun` replacing `detail` wholesale erased the write-ahead `queries_used` (cap enforcement silently neutralized, undercount direction). Early-return and catch paths in `ingest-mo-senate.js` omitted `quarantined_days` → `public_freshness`'s `coalesce(...,0)` rendered the affirmative **"zero days pending human review" while 7 were quarantined**, live, ~30 min of every hour. 20 of 94 finished runs omitted the key.
**Guard:** *every* close path — success, early-return, catch, abort — carries the FULL standing counts, not just what that invocation computed. Absence must never coalesce to an affirmative zero.

**C. Empty-set vacuous truth — 4th appearance counted.**
Zero bullets + zero verdicts auto-published with a "verified clean" receipt. A hollow `[{bullet_index:0, supported:true}]` was stored as a permanent trust-model-v3 receipt. The completeness axis declared `minItems:3` in schema *and* prompt and enforced neither — "a checker naming one trivial provision would have earned the same receipt."
**Guard:** every gate needs an explicit non-vacuity check. Anything declared in a schema or asked for in a prompt must be **re-verified mechanically at the gate** if a downstream public claim depends on it.

**D. Order-dependent "pick one of N" resolvers — 5 instances.**
`resolveParty` caller-order-dependent (party is the neutrality-critical fact); the same class reappeared on the public directory (Curls renders no-party on the directory, D on her profile); identity header showed one arbitrary term (MO Senate d2 for a sitting US House member); `pickLatestTextEntry` on malformed dates; duplicate term glosses (War Powers Resolution ×3).
**Guard:** mirror an explicit documented precedence constant (`DISPLAY_NAME_PRIORITY`), or **refuse to pick and show all candidates.** Invisible in tests because fixtures return in fixed order.

**E. Wiring/seam bugs that pure-function tests structurally cannot see.**
Flag badges could *never* render: `joinFlagBadges` keys `vote_id`, raw votes rows carry `id`. Zero tests covered the join, so the suite stayed green. Worse: `makeFakeWriteClient` was missing `.maybeSingle()`, swallowed by a try/catch — "every prior `queries_used` re-read in those tests had been asserting a FALSE ZERO. Tests were lying."
**Guard:** DOM/integration regression test *at the wiring point*, mutation-verified (exactly one test red on revert, positive control green). A green suite is evidence about units, not joins — and the fakes themselves can be the liar.

**F. The controller's own ruling being the defect — 6 instances.** ← the subtlest
Examples: "THE CONTROLLER RULING ITSELF WAS WRONG — live full form is 'Democratic' (456 rows), not 'Democrat' (0 rows)"; a Jan-3 date convention that would have written FALSE personal dates (Payne died in office 2024-04-24); plan SQL that would have aborted on apply; a plan spec that mirrored 0005's district-as-permanent-key design; plan wording "culpably ambiguous" enough to cause the rolled-back live link run.
**Guard:** tell reviewers to attack the *ruling*, not just the implementation — a wrong ruling passes review while appearing fixed. **Verify any controller factual claim against live data before encoding it in SQL or a prompt.** (T8c's implementer did exactly this and corrected me from the fetched primary source.)

**G. Async "last-wins" rescope races — fixed, then reintroduced in the very next task.**
Worst shape: concurrent-submit rendering the WRONG address's representatives (KS-under-MO reproduced) — on the page whose entire design goal is privacy.
**Guard:** generation token per fetch scope, applied at write time, not discovered in review.

**H. Source sentinel values stored verbatim as facts — 2 distinct LegiScan date sentinels in one week.**
`1969-12-31` (10 MO roll calls → a live 1969 chart bucket on Onder's profile) and `0000-00-00` (275 of 351 roll calls in session 2122). Same class non-date: numeric status codes rendered as a bare `[1]` on 37,662 MO bills.
**Guard:** validate printed dates against the dataset's own session years and **refuse rather than store**. Expect more sentinels.

---

## 3. Open / unfixed items that are real

### Genuinely blocking (accuracy defects on the public record)

**Status as of 2026-08-02: items 1-4 below are all CLOSED.** Verified against CHATLOG.md's
2026-08-01/02 entries and TODO.md's own items 25-28 (all struck through as done). Item 5 has no
TODO number and is the one genuinely still-open item in this list — verified open by grep, not
assumed closed just because 1-4 were.

1. ~~MO 2026 session split across two rows, actively growing~~ **CLOSED.** The 2026-08-01 live run
   merged 34 duplicate bills into their canonical twins, redirected 31 votes, and deleted the
   duplicate session — independently re-verified against the live DB afterward: 0 duplicate bills,
   0 orphaned votes, 31/31 redirected votes correct, casts total unchanged. The ROOT CAUSE (not
   just the cleanup) closed 2026-08-02: `ensureSessionRow` (mo-senate-web) now uses the same
   year+name session resolution `ensureLegiscanSessionRow` already proved correct, so a fresh
   `'2026'` duplicate can no longer be minted — including a same-day self-correction after review
   caught that the first cut would have manufactured a false ambiguity the moment MO calls a
   special session. 29 real cross-source vote discrepancies surfaced during the merge (all trace to
   one root cause: Sen. Fitzwater's yea vote present in every LegiScan roll call, absent from every
   Senate-journal-sourced one — a known pipeline undercount, not a new mystery) and were flagged for
   review rather than hidden; they now sit in the reconciliation-flag queue (49 open, up from 9 —
   see "Accepted residuals" below), not on this accuracy-defect list. (TODO 25)
2. ~~2,005 bills with NULL title AND NULL canonical_url~~ **CLOSED 2026-08-02.**
   `backfill-bill-titles.js` ran live: 1,972 of 1,975 NULL-title bills backfilled from cached
   LegiScan datasets, 0 failures. 3 remain — LegiScan's own cache has no title for them either (all
   `SRM` remonstrance resolutions), correctly left untouched rather than guessed. Independently
   verified against the live DB post-run. `canonical_url` NULLs were not separately re-counted this
   pass. (TODO 26)
3. ~~`legislators.party` unnormalized~~ **CLOSED 2026-08-02.** `correct-data.js party-normalize` ran
   live: 391 `R`→Republican, 209 `D`→Democratic, 1 blank→NULL; independently verified against the
   live DB (860 Republican, 672 Democratic, 66 NULL — exact expected deltas). `Independent` and
   Lieberman's real `Independent Democrat` deliberately left untouched. Fixed AT THE INSERTION
   POINT too (`legiscan-identity.js`), after a same-day follow-up check found LegiScan's own dataset
   prints bare `R`/`D` codes — a future LegiScan-sourced legislator can no longer re-dirty the
   column. (TODO 27)
4. ~~152 stub roll calls with no member positions~~ **CLOSED 2026-08-02.** Live investigation found
   the original framing conflated two structurally different causes (167 rows/60 bills by the time
   this ran — ongoing ingestion, not drift, not decay): OpenStates rows are permanent zero-cast
   bill-action-log stubs (hidden at display time ONLY when the same bill has real cast-bearing data
   elsewhere — never a row-to-row pairing the data doesn't support); MO House rows already carry
   real specific tallies with casts landing later from a separately-polled PDF that updates the SAME
   `vote_id` in place (never touched, never a duplicate, gets honest wording instead of a bare
   all-zero line). Display-only fix in `site/js/bill-page.js` — no data was touched. Verified live
   via dev server + Playwright. (TODO 28)
5. **Display-time dedup was RULED BINDING and is still NOT implemented — genuinely still open.**
   Re-verified 2026-08-02: no dedup logic exists anywhere in `site/js/` (the only "dedup" hit in
   `profile-model.js` is an unrelated affiliation-list dedup; grep confirmed). This is a DIFFERENT
   defect than items 1 and 4 above — cross-adapter duplication of the same real vote (LegiScan vs.
   mo-senate/mo-house rows), not a session split or a display-only stub-suppression problem — and
   none of today's fix passes touched it. Ruling: "the primary-source (journal/PDF) row wins for
   display whenever both exist for the same (chamber, date, bill, tallies)." Inflates every
   share/percentage in the 0018 matviews. (No TODO number — surfaced by the original audit, never
   filed as its own item.)

**TODO 29 (hygiene) was also re-verified 2026-08-02, no action needed** — empty `districts` table
and zero `image_url`/`contact` rows are both confirmed by design, not decay.

Items 1-4 above were all draft-then-apply corrections governed by PLAYBOOK lesson 17 (extract the
mapping from the source, put the `.eq()` guard on the UPDATE not in a JS pre-filter, establish
reversibility before approval) — all four ran live and were independently re-verified against the
database, not just the CLI's own report. Item 5 is still visible on the site and still sits inside
Lance's "locked in **and accurate**" gate.

### Live landmines not tracked in TODO.md at all

**Re-verified individually 2026-08-02 against current code and CHATLOG — not assumed closed or
open from this list's own age.** Result: 6, 7, 9, 11, 12 are STILL OPEN and unchanged; 8 is now
CLOSED; 10 is substantially mitigated by the scheduler's registration (see below).

6. **MO House cross-era misattribution trap — STILL OPEN, unchanged.** `0005_mo_house_id.sql:11`
   still reads `alter table legislators add column mo_house_id text unique;` (verified by direct
   read 2026-08-02 — never dropped). `src/cli/ingest-mo-house.js` still does
   `insertIfAbsent(client, 'legislators', rows, 'mo_house_id')` against a current-only roster with
   **no unique-violation handling** (grep confirms no `isMoHouseIdUniqueViolation`-equivalent
   anywhere in the file). Now explicitly on the record as TODO 31 (was "never made it" at compile
   time — it has since; still unchecked/open there). The now-registered scheduler's own registry
   entry for `mo-house-xml` hardcodes `--limit 1` with an explicit in-code comment never to add
   `--session`/a year flag, which prevents the SCHEDULER itself from tripping this — but a manual
   historical/multi-era backfill still would.
7. **`summarize.js` candidate picker is still silently truncating — STILL OPEN, unchanged.**
   Verified by direct read 2026-08-02: the `sessions`/`bills`/`votes` lookups inside
   `src/cli/summarize.js`'s `loadFederalBills` are all still bare `.select()` — no `selectAll`, no
   `.range()`, no `.limit()` — against 38,254 bills and roughly 10,000+ votes, both well past
   Supabase's 1,000-row default cap. Now on the record as TODO 32 (unchecked, still open). Both
   summary waves that ran
   since compile (wave 2: 60 bills, 2026-08-01; the review-queue backfill: 15 bills, 2026-08-02)
   continued to route around this CLI entirely (`summary-queue.js` / a small dedicated adapter
   script), so it has not actually fired again — but it is still armed for the next person who
   reaches for `summarize.js` directly.
8. ~~No `*_APPROVED` gate on `summarize.js` / `verify.js`~~ **CLOSED 2026-07-31** (commit 41936f0,
   TODO 30). Both now carry the same mechanical gate as `gloss.js`
   (`SUMMARIZE_RUN_APPROVED=yes` / `VERIFY_RUN_APPROVED=yes`), firing before any Anthropic client is
   constructed; `--dry-run` stays freely runnable. Passed adversarial review. (Note: §1 above still
   describes this as an open TRAP — that line is part of the untouched historical record and was
   not in scope for this refresh pass; flagging the inconsistency here rather than silently leaving
   it unexplained.)
9. **Two adjudicated fast-follows still never built — STILL OPEN, unchanged.** (a) transaction/RPC
   hardening of the non-transactional link sequence — the TOCTOU guard only shrinks the window; (b)
   **a proper unlink route.** Verified absent by direct read 2026-08-02; `person-identity.js:220`
   still says so explicitly in-code ("a scheduled fast-follow, not yet built"). The Bayh mis-link
   was corrected by controller-executed raw SQL against production because there is no in-app undo.
   With 4 open flags awaiting Lance, another wrong link is one click away.
10. **`refresh_vote_aggregates()` is still never called from any `src/` CLI — but the operational
    risk is now substantially mitigated.** Still literally true (grep confirms no `src/` file calls
    it). BUT: the scheduler (`scripts/scheduled-ingest.js`) is now **registered and running** — Lance
    ran the `schtasks` registration 2026-07-31 late night (switched to S4U logon, "run whether
    logged on or not"), confirmed live by its first tick at 22:00 local that night, and every
    ~15-minute tick since (`.superpowers/artifacts/scheduler-logs/`, most recently
    2026-08-02T21:45Z at the time of this pass). It calls `scripts/refresh-aggregates.js`
    automatically after every tick whose chosen source's own recorded counts show it actually wrote
    rows (fail-open on an unrecognized shape). As long as this keeps running, the "charts silently
    drift behind the vote list" failure mode this item describes should no longer recur — the
    underlying design gap (no CLI calls it directly) is unchanged, but the live exposure it created
    is closed. See `docs/SCHEDULED_INGESTION.md` (refreshed this same pass) for the full mechanism.

### Public-surface leaks (small, real, one-line fixes)

**Both re-verified 2026-08-02 by direct read of the current migrations — STILL OPEN, unchanged.**

11. **`legiscan_datasets` is anon-readable including `local_cache_path`** — a filesystem path on
    Lance's machine, on the public API. `0010_legiscan_identity_and_ledger.sql:63`'s `anon_read`
    policy is unchanged. The 0010 comment justified two columns ("hash + timestamp"); the policy
    exposes four. The rationale it mirrored (`ingestion_runs` is anon-readable) was itself later
    revoked by 0016.
12. **`public_reconciliation_flags` publishes the whole free-form `discrepancy` jsonb.**
    `0016_public_read_surface.sql:60-63` is unchanged: `select vote_id, source_a, source_b,
    discrepancy, resolved, created_at ... grant select on public_reconciliation_flags to anon,
    authenticated`. The column list is supposed to be the wall, but one exposed column is an
    unstructured bag — any future writer adding a diagnostic field publishes it with no code change
    and no review signal. Now covers more ground than at compile time: open reconciliation flags
    grew from 9 to 49 during TODO-25's fix (see "Accepted residuals" below) — more real rows now
    flow through this same unreviewed public column.

### Accepted residuals — do NOT "fix" or re-litigate these

- **Identical-full-name dateless same-seat pairs still auto-link** (`src/lib/person-identity.js:211`). This is the *current operating mode* of the merger, not an edge case — it's what let Menendez reach the write set. Durable fix is term-date backfill; T8c did 893 FEDERAL dates, MO terms still carry chamber/district with no dates. Nickname bridging *widened* it (line 225).
- **`identity_flags.cluster_key` drift:** membership change mints a new key; the old flag row sits orphaned/unresolved forever. Mitigation was display-side only. Relevant when reporting "the queue is down to N."
- **275 MO House 2024 roll calls refused** (`0000-00-00`) — they arrive later via house.mo.gov with real dates. **36 MO bills deliberately show status `0`** — LegiScan's codebook has no word for it. **21 bills refused by the 400k gate + 1 image-only PDF** — "nothing was ever truncated." **11 MO Senate journal days quarantined.** **444 roll calls have no bill** (nominations, cloture). **MO 2010-2014 has bills, zero votes** — a source gap (`rollCallsPlanned = 0`). **Federal history is 119th-Congress-only.** **OpenStates MO events carry no per-voter casts** (upstream).
- **Trust-layer residuals deferred to prompt v3:** `evidence_quote` content is unconstrained — a fabricated quote is storable as a public receipt; the sonnet verifier is the declared trust boundary. That acceptance must be restated if the verification model ever changes.
- **`quarantine:true` in the legiscan reconciler is unreachable from real evidence** — correspondence proof requires tally agreement, hard contradiction requires disagreement; they can't coexist. Cross-source disagreements are **permanently human-review flags by design.** The open vote-reconciliation flag count grew from 9 (compile time) to **49** (live-verified via `node --env-file=.env scripts/data-status.js`, 2026-08-02) — 29 of the increase is the Fitzwater undercount class TODO-25's session-merge fix surfaced (see §3 item 1), not new decay. They will not self-clear; that's not a backlog to automate.
- **Retraction is this codebase's ONE sanctioned delete** (FK order, `legiscan-` prefix-guarded). Any other row-deleting code is a violation.
- **Glossary: 731 of 847 terms are bare stubs**, 704 blocked on an unresolvable citation — a human mapping decision, not review backlog and not API spend. Real content ≈ 116 entries.

DATA_INVENTORY has a section literally titled *"Numbers that look alarming but are fine"* to stop recurring panic. Read it before flagging a count as a defect.

### Deferred with a gate chain still fully open

- **Glossary Task 7 live E2E was NEVER run.** Chain: 0007 applied ✅ → credits → golden drift ($0.35) → extraction backfill (~$0.75) → gloss batch → adjudicate → anon probes. Blocked on the spend hold since 2026-07-28. The site renders inline glossary terms from a pipeline that has never had a billed end-to-end run. Carries a MUST-REVISIT: `source_url` rendered as a clickable link without scheme validation in the **local review page** (the public `render.js` got a hardened allowlist) — confirm that gap is genuinely local-only.
- **Staff `/admin` review queue (TODO 7)** is genuinely not done — the review server is local-only at 127.0.0.1.
- **On-demand ingestion (TODO 11)** — Lance's stated *launch architecture*: "This will allow us to launch the system without having to fill every single constituents information beforehand and the system can fill it for us as the politician is looked up." **He does not expect a fully pre-filled DB before launch.** An agent optimizing for total coverage before go-live is working against his model.

---

## 4. Things I might wrongly believe

| Belief | Reality |
|---|---|
| **"The only thing gating Cloudflare is Lance's review queue"** (TODO.md:68) | Written *before* the 2026-07-31 evening audit that appended TODO 25-29: *"none were previously recorded."* Draining the queue does not finish the backend. |
| **"Backend live and accurate"** (CLAUDE.md status line, README.md:8) | Both predate the same audit. Five structural defects outstanding. |
| **`quarantine-microfix-report.md`: "0016's `public_freshness` already coalesces that absence to 0, so no fabricated value is ever written"** | **Disproven in production.** Caught live at 01:09:20 with ground truth = 7 quarantined days while the site said zero. The ledger says so explicitly: "the earlier micro-fix report wrongly concluded the 0016 coalesce was harmless." Fixed source-side 2026-07-31 06:09:24Z. |
| **public-site progress line 10: "WHATWG-mirroring strip verified"** | **False** — `\t\r\n` is not the full WHATWG C0 strip set; a leading `\x01` made `javascript:` execute in Chromium. Corrected by final review. |
| **legiscan `task-4-report.md`'s backslash rationale for `decodeStrings:false`** | Recorded as factually wrong. "Do not propagate the backslash rationale into future comments." |
| **MVP spec: "Nothing publishes without his click" + "static pre-render on publish"** | Both superseded. Trust-model v3 **auto-publishes** mechanically-verified-clean items; the shipped site is client-side JS over Supabase REST. The spec is a WORKING DRAFT but these lines aren't individually marked superseded — a fresh session could rebuild a gate v3 deliberately removed. |
| **LegiScan terms doc: primary-source parsers "become the reconciliation/audit layer"** | Later evidence overrides it. The MO Senate journals pipeline is **permanently completeness-critical.** Retiring the slow cron would silently lose an entire class of real floor votes. |
| **0018's comment: "the ingest/backfill CLIs' batch loops call it at batch end"** | They don't. `scripts/refresh-aggregates.js` says it was left as a follow-up. Grep: no `src/` file calls `refresh_vote_aggregates`. |
| **0010: "vote_reconciliation_flags deliberately NOT anon-readable"** and **"legiscan_datasets: harmless metadata (hash + timestamp)"** | 0016 built an anon view over the flags including the whole `discrepancy` jsonb; the datasets policy exposes 4 columns including `local_cache_path`. Both comments now mislead. |
| **Revoking anon on a base table locks it down** | **0018's three matviews FAIL OPEN** — they serve anon from their own independent grant off the last snapshot, indefinitely, after the base tables are revoked. 0016's `security_invoker` views fail CLOSED. Two opposite postures in one schema. 0018's header: *"Whoever touches base-table grants on these three tables in the future must read this comment first."* |
| **"Hardcoded counts were stripped from README and ARTIFACTS"** (CHATLOG) | Not done. README still carries 3,630 / 46,268 / 1,607 / "3,319 of 3,341"; ARTIFACTS still says "3,630 rows" and "1.47M vote casts." DATA_INVENTORY rule 1 forbids exactly this. |
| **TODO build-queue items 5 and 6 are open** | Both completed and merged; the checkboxes are stale. Item 7 (staff /admin) is genuinely still owed. |
| **"37 legislators identified"** | A misreading. Three numbers all legitimately mean "legislators": ~1,607 source ROWS · ~1,568 distinct PEOPLE · **37 merge CLUSTERS**. `persons` is not a roster — a row exists only where 2+ source rows are the same human. |
| **"bills with text" is a funnel stage under passage votes** | It isn't. Text ⊄ passage — 311 text-bearing bills have a non-passage vote. Text (3,630) and passage (3,341) **overlap**; neither contains the other. The 99.3% is 3,319/3,341, not 99.3% of bills (that's 9.5%). **TRAP:** sizing a summary batch off the passage count instead of the text-bearing set is what made 22 bills fail in wave 1. |
| **"draft" means "flagged"** | No such status. `status` lives on `summaries`; clean/flagged is a VERDICT on `summary_verifications`. Of 35 drafts: ~20 adverse, ~14 clean-unpublished, 1 unverified. **Zero published summaries carry an adverse verdict — the gate held.** (Glossary is a deliberate asymmetry: 8 of 116 published terms carry a flagged verdict because they were hand-adjudicated.) |
| **`run_id` tells you which run created a row** | It's the **last** run that wrote it. Grouping bills by `run_id` today attributes 37,662 to a status-patch run. |
| **Lance's "Upcoming bills" scope was descoped** | It was never recorded as deferred anywhere. His words: *"we also need to see items that are in the works that are upcoming that may come to vote soon"* (CHATLOG:75). Only the recorded-vote leg of the trigger was built; there's no upcoming page and `bill_actions` covers 113 of ~38,266 bills (0.3%), so there's no signal to trigger on. This is a **scope question for Lance**, not a silent fix. Same for static pre-rendering (moved to "Not in v1"). |

---

## 5. The 60-second orientation

*Rewritten 2026-08-02 — the original version of this section was built entirely around the TODO*
*25-29 framing, which is now stale (see §3): those five items, plus 33 and 35, are all closed or*
*corrected. This section no longer centers on them.*

**Where it stands.** Backend is live and broadly trustworthy; the site is built and merged but
**not deployed by design**. Suite: **2,192/2,192 green** (live-verified 2026-08-02, `node --test`
from repo root), tree clean, migrations 0001-0020 (+0018a) applied. Summary waves: wave 1
(2026-07-31, 40 bills: 26 published/12 flagged/2 shape failures, both recovered) → wave 2
(2026-08-01, 60 bills: 31 published/29 flagged) → a review-queue backfill (2026-08-02, 15 of the
106 stale-verdict drafts re-checked: 8 auto-published, 7 flagged with a named specific gap). Live
totals (`npm run status`, 2026-08-02): **115 summaries published, 98 still draft/flagged** awaiting
Lance's read. Identity merge sits at 37 clusters, 4 open flags awaiting Lance (unchanged). Glossary
has 116 real entries and a never-run billed E2E (unchanged — still blocked on the spend hold).

**What actually matters next, in order (revised 2026-08-02):**

1. **Display-time dedup (§3 item 5)** — the one item from the original 5-item blocking list that is
   genuinely still open. No dedup logic exists in `site/js/` for cross-adapter duplicate votes.
   This is a display-logic build, not a draft-then-apply SQL correction like items 1-4 were.
2. **The remaining open landmines (§3 items 6, 7, 9, 11, 12)** — re-verified still open 2026-08-02:
   the MO House cross-era `unique` trap (now on the record as TODO 31 — put it there before anyone
   proposes a House multi-era backfill), `summarize.js`'s still-truncating bare `.select()`s (TODO
   32 — dodged twice by routing around the CLI, still armed), no in-app unlink route (still
   controller-executed raw SQL only), and the two RLS over-exposures
   (`legiscan_datasets.local_cache_path`, `public_reconciliation_flags.discrepancy` — the latter now
   covers 49 rows, up from 9, after TODO-25's fix). Item 8 (the ungated `summarize.js`/`verify.js`
   spend risk) is CLOSED as of 2026-07-31 — no longer on this list.
3. **Lance's 4 identity flags** (Brown ×3, Moore ×2, Johnson ×2, Menendez informational) —
   structurally his decision, not an agent's. Unchanged.
4. **98 unpublished summaries** — all now genuinely judgment-requiring (the 15 that needed zero
   judgment were cleared 2026-08-02). Lance was explicit he can't hand-process 106: *"I cannot
   process 106 summaries, I don't have the time or knowledge."* A severity-sorted review view was
   offered but not built — his call whether it's worth building.
5. **49 open reconciliation flags** (up from 9 at compile time) — expected fallout of TODO-25's fix
   surfacing a real Fitzwater-undercount discrepancy class, not new decay. Will not self-clear.
6. **Two scope questions to surface, not solve:** "Upcoming bills" and static pre-rendering. Both
   were Lance's founding decisions that later work quietly narrowed without a recorded call.
   Unchanged from the original compile.

**Number discipline** (Lance: *"review the documentation... and clarify what we have then document it so we don't get confused again"*): `npm run status` is the **only** source of truth for numbers; `docs/DATA_INVENTORY.md` is the source of truth for structure and meaning. Never hardcode bills / votes / vote_casts counts into a doc. CLAUDE.md's fresh-session read-first list omits both of these — the two artifacts created specifically to stop that confusion.

**Operating reflexes for every batch:** one loop at a time · `npm run refresh:aggregates` at batch end · watch the `ingestion_runs` row, not stdout (and on a failed close read `counts.queriesSpent`, not `queries_used`) · implementers strictly serialized · gate commits on the extracted fail count · never paraphrase the canonical prompts out of `src/lib/summarizer.js` / `verifier.js` into a subagent brief · read the audit *detail*, never the `ok:true`.

**And the one that catches me specifically:** six times the defect was *my own ruling or plan text*, and each time it passed review while appearing fixed, because reviewers check implementations against rulings. Verify controller factual claims against live data before encoding them, and tell reviewers to attack the ruling itself.