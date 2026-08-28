# VisibleGov — TODO / Backlog

*How to use: dump raw ideas in INBOX anytime. We triage from there into real work.*

---

## ⏱ RESUME HERE — verified live 2026-08-27, read this block first

**Lance is AFK for an extended break. This block is written so a cold session can resume without
reading anything else first.** Everything below was measured against the live database at the end
of 2026-08-26, not remembered.

### Live state

| | |
|---|---|
| `votes` | **10,180** |
| `vote_casts` | **1,389,890** |
| published summaries | **1,228** (38 drafts, 670 retired) — +17 on 08-27, see below |
| published glossary | **1,850** — the OTHER glossary numbers were being misreported; see below |
| glossary: Lance's actual review queue | **427** flagged (NOT the 870 status used to print) |
| glossary: needs a gloss run, not a human | **527** unauthored + **5,557** unmappable |
| `vote_duplicates` (hidden, not deleted) | **213** |
| `retracted_votes` (deleted, tombstoned) | **714** (114,066 casts preserved) |
| open reconciliation flags | **382** |
| migrations | **35 on disk (0001-0034 + 0018a), ALL APPLIED** |
| tests | **2,714 pass / 0 fail** |
| site | https://visiblegov.us (apex 200, `www` 301) |

`npm run status` now prints a **REPAIR LEDGER** section with the superseded/retracted counts —
added 2026-08-26 because `votes` alone stopped telling the whole truth once rows began being
hidden and removed.

### What 2026-08-26 was: an adversarial audit, and the repairs it forced

An 8-dimension Workflow audit (66 agents; **28 findings raised, 19 refuted by skeptics, 9
survived**) found one genuinely critical live defect, plus several smaller ones. All are now fixed.

1. **713 vote rows retracted as misattributed.** LegiScan's 2023 MO dataset mints a SEPARATE
   `roll_call_id` per bill for ONE physical House floor vote — three HB 10 roll calls were stored
   **232 times each, against 232 different bills**, with full cast lists. The ingest had no bug:
   `source_key` IS the provider's roll_call_id and each was unique, so `insertIfAbsent` stored every
   copy silently. **196 bills displayed ONLY votes never cast on them; 47 had published summaries.**
   A further **20** were votes dated before their own session began (special-session datasets
   carrying regular-session roll calls), and **1** was resolved by Lance reading the source PDF.
2. **Signal death fixed.** `us-congress` and `us-senate` had closed 121 of 121 runs `partial` while
   perfectly healthy, because a probe window that deliberately overshoots counted every 404 as a
   failure. Absence is now distinguished from failure, and the window re-probes the last known roll
   call as a CANARY so a URL-structure change cannot masquerade as a quiet week.
3. **126 thin `mo-house-xml` rows superseded** — stubs resolving 1 cast beside a complete 158-cast
   LegiScan copy of the same roll-call document. 0022 could not pair them because it compares cast
   lists and one cast never matches 158.
4. **Profile pages were unreadable.** `renderVoteRow` never rendered the date or tally, and rendered
   the question only for bill-less votes — so **369,063 rows across 1,048 legislators** looked like
   repeats (one profile showed the same row 25 times for SB 724). Now renders question, date, tally,
   and the source's own roll-call number. **Verified in a browser: 50/50 distinct rows, zero
   duplicated.**
5. **Two indexes** (`0034`) behind every bill page — both reads were sequential scans.

### 2026-08-27 — PAUSED MID-LOOP by Lance. What was running, and how to restart it.

**Nothing is running now.** Two background jobs were stopped deliberately at his "pause" (a drain
wave W12, and a $0 statute fetch). Neither had written anything half-finished — W12 never reached
its record step, and the fetch is checkpointed and resumes cleanly.

**The loop he asked for ("keep draining… continue draining waves on repeat") and why it is shaped
this way:** fresh waves alone yield ~50% and add one draft to Lance's review queue for every summary
they publish. The drain lane re-authors a flagged draft while SHOWING it the prior draft's recorded
objections, and converts far better. **Run them as a pair and the queue stops growing:**

| Cycle | Fresh | Drain | Net |
|---|---|---|---|
| 1 (08-27) | 12 bills → 6 published, 6 drafts | 7 → 4 published, 3 drafts | **10 published from 12; queue +3, not +6** |
| 2 (08-27) | 12 bills → 5 published, 7 drafts (1 gated on completeness) | *W12 stopped mid-run* | — |

**To restart the loop, this exact sequence:**
```
node --env-file=.env scripts/export-summary-wave.mjs 12          # fresh manifest
Workflow scriptPath=.claude/workflows/summary-wave.js  args={"manifest_file":".superpowers/artifacts/wave3/manifest.json"}
node --env-file=.env src/cli/summary-queue.js record --file .superpowers/artifacts/wave3/records-wave.json
node --env-file=.env scripts/build-drain-wave.mjs W13 10 --pointer
Workflow scriptPath=.claude/workflows/summary-wave.js  args={"manifest_file":".superpowers/artifacts/wave3/wave-W13-args.json"}
node --env-file=.env src/cli/summary-queue.js record --file ... --replace-drafts   # NOTE the flag
```
**`--replace-drafts` on the DRAIN record only.** Without it the record step mints a SECOND draft
beside the first and doubles the queue it exists to drain. Launch workflows by `scriptPath`, never
by name (PLAYBOOK 47). Each 12-bill wave runs ~65 min, 50 agents, $0.

### Where the project actually stands, end to end (measured 2026-08-27, not quoted)

| Link | State | Complete |
|---|---|---|
| Votes downloaded | 10,180 roll calls / 1,389,890 casts | ✅ |
| Cast → politician | 1,389,890 of 1,389,890, 1,052 distinct voters | **100%** |
| Vote → bill | 9,729 of 10,180 (the other 451 are procedural votes with no bill — a different record type, not a failure) | **95.6%** |
| Bill → plain language | 1,228 published | **~28%** of the accountability set |
| Plain language → gloss | 758 of 1,219 summaries show ≥1 published gloss | **62%** |

**The honest "% complete" is ~28%** — 760 of 2,697 bills that got a passage vote AND have text on
hand. Against all 38,256 bills it is 3.2%, but that denominator is misleading: most bills never got
a floor vote, so there is no accountability story to tell about them. **The spine is done; plain-
language coverage is the only real constraint.** 2,224 bills have text and no summary, so the
current corpus supports ~3,400 summaries with no new ingestion.

### THREE reporting/structure defects found 2026-08-27 — read before trusting any glossary number

1. **`npm run status` overstated Lance's glossary review queue by 443 (870 → really 427).** The
   figure was DERIVED (`total − published − needs_mapping`) instead of counted, so 47 REJECTED terms
   were reported as work awaiting him; and "mappable draft" is really two unrelated queues — 427
   authored-and-flagged (his) vs 396 with no gloss text at all (needs a gloss run, not a human).
   Fixed: each queue is now counted with the predicate that defines it. **A queue number must be
   COUNTED — derive it by subtraction and every status you did not think of lands in it silently.**
2. **The 5,328 `needs_mapping` "curation backlog" is mostly ungossable by design.** 52% are agency
   and program names ("Office of the Attorney General") with NO citation — trust model v3 needs a
   verbatim quote from official text, so there is nothing to quote. `parseMoCitation` rejects 5,305
   of 5,328. Only ~1,030 are recoverable by code (831 compound/range/chapter cites + 199 U.S.C.),
   and recovering them only makes them ELIGIBLE for a billed run. Full table in
   `docs/DATA_INVENTORY.md`. **Do not quote 5,328 as a backlog anyone can drain.**
3. **A term citing a section its OWN bill creates can never be fetched.** RSMo holds enacted law
   only. "Authorizes the Missouri Child Tax Credit Act" → `RSMo 135.320`, which does not exist until
   the bill passes. revisor.mo.gov serves its bot page; the pipeline correctly reads that as
   "no such section" and parks. **Each one costs a 10-minute cooldown plus a retry** — 19 parked
   this way on 08-27. Correct behaviour, not a fetch failure.

### Also done 2026-08-27

- **Scheduler false alarm CLEARED.** The 08-26 note said it had not ticked since 11:00 UTC. It had —
  the check simply ran BEFORE that day's tick. Healthy: $1.50 of $5.00 this ISO week, 6 published.
  **A one-shot "has X happened yet" reading is a timestamp, not a verdict.**
- **MO citation normalizer applied** ($0, no model calls): 10 stubs mapped, 13 duplicate stubs merged.
- **PLAYBOOK lesson 14 gained a THIRD occurrence** — and this one is nastier: a background task
  reported **"completed (exit code 0)"** when the program had died on an ECONNRESET, because the
  command was piped into `tail` and the status belonged to `tail`. **Never pipe a long-running
  command whose success you intend to believe; redirect instead.**

### Superseded — the overnight run (2026-08-26 into 08-27): +99 published, and WHICH LANE to use

Lance authorized billed spend "until I'm out of credits" and went AFK. Published **1,112 -> 1,211**;
his review queue **40 -> 31** (it went UP to 80 first, then came back down — that swing is the
finding). Trust model intact throughout: 0 published summaries carry a flagged support verdict,
0 lack a verification, 0 bills have duplicate drafts.

**MEASURED CONVERSION, same night, same models, same gates — the obvious lane was the wrong one:**

| Lane | Published / attempted | Rate |
|---|---|---|
| Billed API chain | 10 / 32 | 31% ($0.368 per published) |
| Fresh opus waves (x5) | 38 / 60 | 75%, 75%, 67%, **50%, 50%** — decaying |
| **Re-author drain (x6)** | **51 / 61** | **84%**, and 92% on the LARGEST bills |

**Fresh-wave yield decays** because recency-first hands out the easy bills first. Cause measured,
not guessed: of 34 new drafts, **23 carried a flagged SUPPORT verdict** (bullets the source text
does not back), only 11 were held by completeness.

**At a 50% floor a fresh wave is not progress** — it adds ~6 published summaries AND ~6 drafts to
Lance's queue. The drain lane converts because the author is TOLD what failed (each prior draft's
recorded objections ship as a `reAuthor_file` pointer) instead of re-rolling blind.

**Standing rule now in `docs/RUNBOOK_SUMMARY_WAVES.md`: below ~60% fresh-wave yield, stop exporting
fresh waves and drain the draft queue instead.** Re-authored records MUST be recorded with
`--replace-drafts` or the record step mints a SECOND draft beside the first, doubling the queue it
is meant to drain. (Verified after every wave: 0 bills with multiple drafts.)

**The drain pool is now EXHAUSTED — 46 -> 3 re-authorable.** Stopped there deliberately rather than
falling back to fresh waves, which would rebuild the review queue overnight. Restarting is a
judgement call, not an obvious continuation.

**Two wave defects fixed, both the same shape — completed work failing to survive TRANSIT, neither
a data problem, neither surfacing as an error:** (1) the manifest had no pointer form, so every
launch hand-retyped a dozen uuids and sha256 hashes; (2) the wave RETURNED ~250KB of envelopes into
a notification channel that truncates at ~250k, so wave 1 ran perfectly and handed back a blob with
no `envelopes` key, stranding 12 bills in the journal. Workflow scripts have no filesystem access
but agents do — the wave now writes `records-wave.json` itself. Left unfixed this would have
silently eaten every future wave.

**~$1.17 of API credit deliberately NOT spent.** Billed converts at $0.368/published; the daily
scheduler at $0.107. The remainder is worth ~11 summaries there against ~3 here.

~~**⚠ CHECK WHEN BACK: the scheduler had not ticked since 2026-08-26 11:00 UTC.**~~ **FALSE ALARM,
resolved 2026-08-27:** it ticked normally at 11:00:34 UTC — the check above simply ran BEFORE that
tick fired, so "last tick yesterday" was true at the time and stale within hours. Scheduler is
healthy: $1.50 of $5.00 this ISO week, 6 published, balance not depleted. A one-shot "has X happened
yet" reading is a timestamp, not a verdict.

### ⚠ Read `PLAYBOOK_DELTA.md` lessons 51-55 before touching vote data

They are all from this one day and they are all about the same failure shape — a confident claim
that measurement then contradicted:

- **51** — a status word that never varies carries zero bits; probe a record you already hold.
- **52** — identical payloads are not identical identity. A legislature voting the party line twice
  emits byte-identical records.
- **53** — writing the lesson does not mean obeying it. Lesson 52's own rule shipped an hour later
  and **hid 17 real votes**, because "has a `#fragment`" was tested but "the fragment means
  something" was not.
- **54** — a provider's record id is not an identity.
- **55** — a missing capability is a blocker to RAISE, not a fork to quietly take.

**The single most useful habit for the next session: measure, THEN claim.** Three times this day a
stated estimate was wrong by orders of magnitude and the measurement corrected it — "~49,900
duplicate rows" was really **117**; "126 casts would be lost" was really **0** (compared by
`legislator_id` instead of `person_id`); "identical cast lists prove duplication" was really ten
real Senate votes. The measurements converged; the predictions did not.

### Tooling that changed today (a fresh session inherits all of it)

- **Supabase MCP is authorized and is the fastest path to the database.** Raw SQL, atomic guarded
  transactions, and `get_advisors` — which is NOT reachable over REST and found the unindexed
  `votes.bill_id`. See `docs/MCP_REQUIREMENTS.md`. **Standing rule in CLAUDE.md: an unauthorized MCP
  is a blocker to raise, never a detour to take.**
- **`scripts/preflight.mjs`** runs at SessionStart (`.claude/settings.json`) — checks required MCP
  servers AND plugin binaries.
- **`typescript-lsp`** + `typescript-language-server` 6.0.0 + `typescript@5` (workspace devDep, NOT
  v7 — the Go rewrite ships no `tsserver.js`) + `jsconfig.json`. Caveat: `findReferences`
  under-reports on a cold index; warm it or cross-check with grep.
- **Permission allowlist** in `.claude/settings.json` (42 entries) for read-only MCP + routine git.
  Deliberately excludes `node --env-file`, `python`, `execute_sql`, `apply_migration`.
- **`src/lib/pg.js`** — an INERT direct-Postgres fallback. No `SUPABASE_DB_URL` and no database
  password has ever been created, so it cannot connect. Kept because MCP auth drops.

### OPEN — pick up here

**▶ LANCE — one migration drafted and awaiting you: `0036_revoke_internal_tables_from_anon.sql`.**
Found by `npm run verify:migrations` on its first run. Three tables their own migrations call
internal (`legiscan_datasets`, `vote_reconciliation_flags`, `ingestion_runs`) return `200 []` to
anon — the grant is still there and only the absent RLS policy is holding the door, which is the
exact `200 []` signature the Glizzness playbook §8.7 warns about. **Nothing is exposed today**;
this is defence-in-depth, and 0024 dropped the policy in 2026-08-03 but never revoked 0010's grant.
Three `revoke select` statements, no consumer breaks. After applying, re-run
`npm run verify:migrations` — the 0036 row must flip from MISSING to OK and 0024 from POLICY-ONLY.


**Lance's decisions (nothing blocked on code):**
1. **Cloudflare Web Analytics.** The only console error on the live site is the CSP blocking
   Cloudflare's auto-injected `beacon.min.js`. Two paths, both fully specced 2026-08-26:
   **(A) disable** — dashboard toggle, 2 minutes, no code; **(B) enable** — add
   `https://static.cloudflareinsights.com/beacon.min.js` to `script-src` in `site/_headers`
   (`connect-src 'self'` is already sufficient for automatic injection), update the CSP assertion in
   `tests/site-modules.test.js` (it pins the header), and add a disclosure line to the trust page.
   *Context: the audit's standing recommendation is that whether 23% summary coverage matters
   CANNOT be answered from the database — it needs contact with readers.*
2. **Summary coverage (audit D5)** — a decision, not a build. 1,112 published.

**Buildable without a decision:**
3. ~~**`vote_date_provenance` is not exposed publicly** (audit D6).~~ **BUILT 2026-08-28 — one
   action left, and it is yours.** Code is committed; the SQL is draft-then-apply.
   - **▶ LANCE: run `supabase/migrations/0035_expose_vote_date_provenance.sql` in the Supabase SQL
     editor.** It appends `vote_date_provenance` to `public_vote_feed` and `public_votes` via
     `create or replace` — metadata-only, instant, no data touched, grants preserved (unlike 0031's
     drop+create). Verify commands are in the migration header.
   - Site side is already written and **safe to deploy either side of the migration**: the renderer
     returns null when the field is absent, and the profile page sends no `select=` list so it
     cannot 400. New `voteDateDerivedNote()` in `receipts.js`, rendered by `person-page.js` under
     the meta line, styled `.vote-date-derived`.
   - **Correction to the old note above:** the gap was on the PROFILE page, not the bill page — the
     bill page renders no vote date at all, only orders by it. 0032's note said "the view and bill
     page"; that was wrong and is now recorded in CHATLOG.
   - Found and fixed en route: `tests/vote-duplicates-antijoin-migration.test.js` matched only
     `create view`, so it could not see a `create or replace view` migration and reported green
     while asserting against a superseded file. **A valid form the checker cannot see is worse than
     no checker.** Candidate `PLAYBOOK_DELTA.md` lesson.
   - Full suite after: **2,720 pass, 0 fail.**
4. **One `correct-data` run row stuck at `status=running` since 2026-08-03.** Cosmetic, one row.
5. **382 reconciliation flags** — a human adjudication queue BY DESIGN. Do NOT run
   `resolve-matched-reconciliation-flags.mjs` expecting a drain: measured, it resolves **0**.
6. **`pyright-lsp` is installed and this repo has zero Python files.** Lance's call.

**Known and deliberately NOT fixed:**
- **535 thin vote rows stay public.** 383 are the SOLE record of their vote, and 375 of those are
  committee actions where the tally is known but the per-member roster was never published. Hiding
  them would delete real information.
- **50,070 rendered rows share a bill+day+position with another** — every one a genuinely DIFFERENT
  vote (measured: zero are the same vote twice). They now carry the source's own roll-call number,
  which is what separates them. Cross-source pairing was investigated and is **impossible**: by
  person, every LegiScan row matches every journal row with zero contradictions, which is exactly
  the `ambiguous_tally_match` case the ingest already refuses.

---

## ⏱ Superseded — the mid-day 2026-08-26 block (kept for its detail; the block at the top of
this file supersedes it)

### 2026-08-26 (mid-day) — the day the adversarial audit ran.

**Live numbers right now:** votes **10,166** · casts **1,390,051** · published summaries **1,112** ·
`vote_duplicates` **87** · `retracted_votes` **713** · open reconciliation flags **382** ·
migrations **35 files, 0001-0034 + 0018a, ALL APPLIED** · suite **2,704 pass / 0 fail**.
(`npm run status` is still the only live figure; these are a dated snapshot.)

**THE BIG ONE — 713 vote rows retracted, all misattributed to bills that never held them.**
Found by an 8-dimension adversarial audit (66 agents; 28 findings raised, **19 refuted by
skeptics, 9 survived**), then independently re-verified before any code was written.
LegiScan's 2023 MO dataset mints a SEPARATE `roll_call_id` per bill for ONE physical House floor
vote — three HB 10 roll calls were stored **232 times each, against 232 different bills**, with
full cast lists. The ingest had no bug: `source_key` IS the provider's roll_call_id and each was
genuinely unique, so `insertIfAbsent` stored every copy with no error, warning, or failed parse.
**196 bills displayed ONLY votes never cast on them; 47 of those had published summaries in the
public `/bills` index.** HB 114, "Reduces the tax on diapers and feminine hygiene products,"
publicly showed a 155-2 conference-committee vote on an appropriations bill.
Retracted in two passes (693 + 20) behind migration **0033 `retracted_votes`** — a tombstone
carrying the COMPLETE cast list, so every retraction replays backwards. Verified after:
**0 orphan casts, 0 votes dated before their own session's start anywhere, 0 missing survivors**,
aggregates refreshed. Rep. Louis Riggs's 2023 record went 1,182 yea → **489 yea / 37 nay**, exactly
the real record the audit predicted. `docs/audits/2026-08-26-system-audit.md` has the full trail.

**Guards now in place so it cannot re-enter:** `src/lib/source-url-granularity.js` declares, per URL
shape, whether a `source_url` names ONE vote or a CONTAINER of many — and `ingest-legiscan.js`
refuses any roll call whose per-vote document already belongs to a different bill. The scoping IS
the job: a naive "same URL + different bill" rule flags 1,101 live votes of which only 693 are
real (**408 false positives**), because a MO Senate journal PDF legitimately prints every roll call
of a sitting.

**⚠️ THREE OF MY OWN ERRORS TODAY — read these, they are the reusable part:**
1. The same-source dedup was applied and **17 of its 38 pairs were FALSE — they hid real votes.**
   Caught by reading the apply output, reversed with a new `--prune` mode. Live: 21 correct pairs.
2. A retraction plan was about to **delete the correct row and keep the misattributed one** for
   SB 1/3/4, because both bills are literally named "SB 4" (Missouri renumbers each session) and
   `rows.find()` picked arbitrarily. Caught by reading the plan before running it.
3. A session opened with a notice that the Supabase MCP needed auth. I never surfaced it and
   instead built a ~400-line Postgres client and asked Lance to rotate his DB password — for a
   capability one click away. **New standing rule in CLAUDE.md.**
PLAYBOOK lessons **51-55** carry all of it.

**Tooling changed today:**
- **Supabase MCP is authorized** and is now the fastest path to the database (raw SQL, atomic
  guarded transactions, and `get_advisors` — which is NOT reachable over REST and found the
  unindexed `votes.bill_id` behind every bill page, fixed by migration 0034). See
  `docs/MCP_REQUIREMENTS.md`.
- **`scripts/preflight.mjs`** runs at SessionStart (`.claude/settings.json`), checking MCP
  availability AND plugin binaries.
- **`typescript-lsp` installed** + `typescript-language-server` 6.0.0 + `jsconfig.json`.
  **Needs a session restart to activate.**
- `src/lib/pg.js` is a deliberately-kept, currently INERT fallback (no DB password exists).

### OPEN — what a fresh session should pick up

1. ~~**150 thin-cast rows**~~ **DONE 2026-08-26: 126 marked superseded** (`vote_duplicates` 87 ->
   213; nothing deleted, votes/casts unchanged). Re-measured in SQL rather than trusting the
   earlier JS figure: of 661 thin rows, only **126** have DECISIVE evidence — an identical
   `source_url`, meaning both rows cite the SAME roll-call document. These are CROSS-source
   duplicates that migration 0022 missed because the primary row resolved just 1 cast (the
   one-legislator mo-house-xml roster), so 0022's cast comparison could not match them.
   **535 thin rows remain public and must stay:** 24 whose thin row has no source_url, 2 citing a
   different document, and the sole-record majority — 375 of which are committee actions where the
   tally is known but the per-member roster was never published. Those are a display question, not
   a dedup one.
   *Trap worth remembering:* the safety check "would any cast lose its only record?" first answered
   **126 — all of them**, because it compared `legislator_id`. This project unifies humans by
   `person_id`, and Mark Matthiesen has two legislator rows (mo-house-xml and LegiScan). Compared
   by person: 126/126 represented on the survivor with the SAME position. Third time in one day a
   raw-id comparison gave a false reading where the identity model was the right lens.
2. ~~**Profile vote rows discard date and question**~~ **FIXED 2026-08-26.** Confirmed by reading
   `renderVoteRow`: it rendered `question` ONLY for bill-less procedural votes, and never rendered
   `vote_date` or `result` at all. Measured before fixing: **369,063 feed rows across 1,048
   legislators** looked like repeats, and **225,025 of those groups were genuinely DIFFERENT votes**
   — the data was always in `public_vote_feed`, only the render dropped it. Worst real case: Rusty
   Black's profile showed **25 identical rows** for SB 724 (2022-05-10), which are 25 separate
   amendment votes with tallies from 0-124 to 128-6. Now renders the question for bill-linked votes
   plus a `date · tally` line, both printed exactly as stored. 4 new tests.
   **VERIFIED LIVE in a browser 2026-08-26** (playwright, visiblegov.us, two profiles): every row
   now carries `.vote-question` and `.vote-meta`, and each profile's first page renders 48 of 50
   rows distinctly. Row shape confirmed: `MO Senate / HB 3080 — <title> / Senate: Emergency Clause /
   2026-05-15 · 24-4 / Position: absent | source`. Measured effect: rows rendering as repeats
   **369,063 -> 50,070 (86% resolved)**.
   **RESIDUAL, newly characterized — a DEDUP problem, not a render one.** Of the 50,070 left,
   **49,908 have a DISTINCT `source_url`** and only **162** are genuinely indistinguishable from
   what we hold. The pattern, from SB 1019 / SB 953 on 2026-05-15: LegiScan labels BOTH the adoption
   motion and the third reading `"Senate: Third Reading"`, separating them only by journal anchor
   (`#1876.2` vs `#1876.3`) — and the SAME two votes also exist as `mo-senate-web` rows carrying the
   narrative text that actually distinguishes them ("Senator Crawford moved that HCS for SB 1019 be
   adopted..." vs "...read the 3rd time and passed"). So the page shows FOUR rows for TWO physical
   votes: two unpaired cross-source duplicates that migration 0022 never matched. Rendering the raw
   anchor would be meaningless to a visitor; pairing the cross-source rows would remove them
   outright. That is the next move here, and it is non-destructive (`vote_duplicates` marking).
   **RESOLVED 2026-08-26 — and the plan in the sentence above was WRONG on both counts.** Measuring
   before acting killed it: (a) only **146** bill/date groups contain both sources at all, 117 of
   them 1:1 — the "~49,900 rows" estimate was off by ~400x; and (b) the residual contains **no
   duplicates whatsoever** — `distinct_votes_rendering_alike` = 50,070, `same_vote_appearing_twice`
   = 0. Every one is a genuinely different vote. Pairing was also checked and is impossible: for
   SB 1019, comparing BY PERSON (legislator_id is useless across sources), every LegiScan row agrees
   with every journal row at 31 casts with ZERO contradictions — all four combinations match equally
   well, which is exactly the `ambiguous_tally_match` case `crossCheckAgainstPrimarySource` already
   refuses, correctly.
   **The actual fix was additive:** `rollCallLabel()` in `site/js/receipts.js` renders the SOURCE's
   own roll-call identifier, parsed from the url already linked as "source" — `Roll call 283`
   (US House), `Roll call 332` (US Senate), `Roll call 046.022` (MO House, verbatim so it matches
   the PDF), `Journal p. 1876.2` (MO Senate). Covers 49,737 of 50,070 rows; returns null for the
   333 with nothing derivable rather than guessing. **Verified live in a browser: Schnelting's page
   went 48/50 distinct -> 50/50, zero duplicated**, with the two formerly-identical SB 1019 rows now
   reading `Journal p. 1876.2` and `Journal p. 1876.3`.
   *Operational note:* Pages serves JS with `Cache-Control: public, max-age=14400, must-revalidate`
   + ETag, so a returning visitor can see the previous render for up to 4 hours before revalidating.
   Bounded and self-healing, not a defect — but browser verification needs a cache-bust or it will
   show the OLD build and look like the fix failed. That is what happened on the first check here.
3. ~~**`006.004.pdf`**~~ **RESOLVED 2026-08-26 by Lance reading the source PDF.** The document
   names **HB 1979** explicitly (Session Day 6, Roll Call 4, 1/14/2016, "HBs FOR THIRD READING",
   sponsor ROWDEN (044), draft 5624H.02P) and **SB 903 appears nowhere on it**; its printed tally
   (Yes 141 / No 16 / Absent 6) matches the stored result 141-16 exactly. The SB 903 row was
   retracted with the PDF's own wording recorded in the tombstone's `evidence`. This is the
   detector working as designed: it refused to guess between two rows that each claimed their own
   bill, and a human settled it in one reading.
4. **Cloudflare Web Analytics (audit D8)** — still Lance's call: disable the beacon, or allow it in
   the CSP and add a line to the trust page saying what is collected.
5. **Summary coverage (audit D5)** — a decision, not a build. 1,112 published; the honest
   recommendation is still to get the site in front of real readers first.
6. **382 reconciliation flags** — a human adjudication queue by design. `resolve-matched-
   reconciliation-flags.mjs` resolves **0**; do not run it expecting a drain.
7. **`pyright-lsp`** is installed and this repo has zero Python. Lance's call whether to remove it.

---

## ⏱ Superseded resume block — verified live 2026-08-23

**✅ USC GLOSSARY DRAIN COMPLETE AND LIVE (2026-08-21 evening) — API balance went to $0 (Lance:
"out of api credits"), then Lance loaded **$7 more** the same evening (console is the truth; if
the overspend left a negative balance the net is lower). BILLED PATH: the scheduler resumes on
its own under its ledger ($3.04 of $5.00 left this ISO week — 08-21 figure; $2.30 left on
08-23 after the 08-22/23 ticks — resets Mon 2026-08-24; ~$0.16 per
published summary this week, so ~2 weeks of ticks); EVERYTHING ELSE still needs per-run
approval. Gloss backlog is effectively empty (30 structural leftovers, nothing newly minted) —
no gloss run warranted. Summary coverage (as of 2026-08-21): 744 of the 3,343 accountability-set bills
(22%) have a published summary; 2,518 are ready (text, no summary); 1,045 published overall
(2026-08-23 `npm run status`: 793 / 2,498 ready / 1,094 published — every scheduler tick moves
these, so `npm run status` is the only live figure; the numbers here are dated snapshots).
$0 PROJECTION of that backlog from its actual texts (CHATLOG 2026-08-21 late): 2,521 ready,
2,517 Missouri, 319 monsters; the 2026 session alone is 194 bills ≈ $24 realistic per
attempt-pass (gate ceiling $145); everything ≈ $291 realistic ($1,855 ceiling); this week's
scheduler measured $0.063/attempt, $0.163/published, 39% first-pass yield. The $7 ≈ two weeks
of scheduler ticks, not a drain. ✅ **Session dates FIXED (2026-08-22, run 0fb39207):** it was 30
of 31 MO sessions with a NULL `start_date` (not 19), and BOTH recency-first consumers — the
exporter AND the daily scheduler's `sortQueueRecencyFirst` — had silently degraded; all 30 now
carry a sourced date (constitution / OpenStates / LegiScan recorded actions, each named in the
run record), both consumers fall back to the name-year and report it, and the next scheduler
tick takes 2026-session bills first. Re-run `node --env-file=.env
src/cli/sync-session-dates.js` (dry-run, then `--apply`) whenever a new session is minted — the
session-minting drivers still write no date (build queue).** 525 federal statute glosses published (641 USC
published in total with the pre-existing 116); glossary published 1,333 → **1,858**; 140 USC
glosses flagged for Lance's review (with the 279 MO ones = **419 awaiting his flag review**);
4 author failures + 23 fetch failures (14 nonexistent sections, 9 oversize) stay drafts with
reasons. Live-verified: 665/665 quotes verbatim, anon probe PASS, HR 6644 renders 35 inline +
26 referenced with zero console errors. **Visible gloss coverage: 649 of 1,045 published
summaries.** **The run spent $8.31 against an $8 cap and a $5.62 balance** — my estimate reused
the MO per-term rate while USC excerpts average 2.5x the length, and the cap only gated before
each submission (one $5.24 verify batch landed after the last check). Fixed same pass (TDD):
the runner now projects every batch from the bank on disk before submitting, with a calibration
test pinned to today's actuals (PLAYBOOK lesson 44). **The scheduler's next tick will log
`BALANCE DEPLETED` and skip — designed; nothing bills until Lance reloads AND says go.**
*(Superseded the same evening by the $7 reload: the 08-22 and 08-23 ticks billed normally —
$0.39 / 6 published and $0.35 / 4 published, `balance_depleted:false` on both; the scheduler is
the one lane that bills without a per-run go, under its $1/tick + $5/ISO-week ledger.)*
Next-work menu, Lance's call: (b) flag review (419 glosses); (d) periodic gloss runs as the
scheduler mints MO terms (per-run approval, needs funds); (e) **custom domain DECIDED 2026-08-22:
`visiblegov.us` (Lance owns it) — Phases 3-4 in docs/CLOUDFLARE_DEPLOY.md rewritten for the apex;
his console work after his AFK.** ✅ 2026-08-22 morning tick confirmed the $7 reload took and the
recency fix is live: all 12 lane bills were 2026-session, 6 published for $0.39 (week $2.35/$5).
⚠️ NEW 2026-08-22 (INBOX; FIXED 2026-08-23 — see the ✅ `bill_refs` quarantine FIXED entry below): the MO Senate journal parser is quarantining 2026-session days on a
`bill_refs` failure class (14 of 20 quarantined days are 26info) — the +249 reconciliation flags
since the 08-05 count of 107 (87 of them minted 08-18..22; 170 date from 08-06..08-17) are mostly
LegiScan 2026 Senate roll calls with no journal counterpart (187 of the 364 open are
`legiscan vs mo-senate-web`). Real gap in
the completeness-critical pipeline; captured, not chased. ✅ **DRAIN LANE RAN TO EMPTY
2026-08-22 on Lance's "drain any items that are drainable" (AFK): live 1,090 published /
28 drafts / 600 retired (1,067 → 1,090 today, all $0 subagent path).** Ledger: the 18
"no-objection" drafts were the old verdict-binding flag class — re-recorded through today's
gates, 11 published; DY 4/5; DZ (fresh mode + corroboration) 5/7 — the four bills unparked
08-18 are all published; EA 1/1; EB 1/2; HB 1607 PUBLISHED on its final attempt (EC). re-authorable pool = 0; the
remaining 28 drafts are exactly the 28 PARKED bills (every one with a written reason) — NOTHING is
drainable at $0 until the scheduler mints new refusals. **08-23: that condition fired — the 6 AM
tick minted 4 refusals (HB 1906, HB 3004, HB 1786, HB 1855; live 1,094 published / 32 drafts /
600 retired) — run `node --env-file=.env scripts/build-drain-wave.mjs <WAVE> 6 --pointer` to see
whether they are re-authorable.** Two process fixes shipped on the way:
`reAuthor_file` pointer mode (`build-drain-wave.mjs --pointer`; a retyped 14KB inline prior
lost one character and killed a launch — PLAYBOOK 46) and "launch edited workflows by
scriptPath, never by name" (a session-cached pre-edit script authored on the wrong lane
silently — PLAYBOOK 47; the fallthrough guard is an INBOX item). Resume the lane only when
`node --env-file=.env scripts/build-drain-wave.mjs <WAVE> 6 --pointer` reports candidates.
✅ **MO Senate journal `bill_refs` quarantine FIXED 2026-08-23 (commit 5ced4eb):** root-caused
(the parser knew one motion grammar; the journal prints the bill outside the motion for four
families + non-bill roll calls), 20/20 days parse 137/137 blocks against agent-verified ground
truth, adversarial review's 23 findings addressed, suite 2,611/0. **Replay COMPLETE 2026-08-24 11:30Z:** all 15 days re-read through the scheduler (14 2026-session
+ 1 manual 2018 run) — **103 votes, 3,391 casts, 5 non-bill roll calls, ZERO failures, zero
quarantined days**, `total_pending_days` 0. Biggest single recovery: the 2026-05-06 FY2027
appropriations day, 31 votes (23 of them the CCR/third-reading pairs the old grammar could not
attribute at all). The 2018 backlog (52 days) is untouched and remains Lance's call (INBOX).
**Next:** the LegiScan tick at ~16:45Z daily re-cross-checks all 604 roll calls against the primary
sources; yesterday's ran when only 6 of 15 days had replayed and paired just 3. After today's,
~~run `node --env-file=.env scripts/resolve-matched-reconciliation-flags.mjs`~~ **SUPERSEDED
2026-08-26 — do NOT run this expecting a drain: measured, it resolves 0.** The expectation that the
journal replay would let it close these in bulk was wrong (see the CORRECTION entry in the INBOX);
the resolver reports `resolvable: 0` against 184 open `no_tally_corresponding_primary` flags. The
command still exists and is still correct, it simply has nothing to do. Original text: (dry-run; `--apply`
on Lance's go) to close the `no_tally_corresponding_primary` flags whose journal twin now exists
(177 open at 11:30Z; 368 flags open overall).
✅ **2024 MO House votes RECOVERED (2026-08-23): migration 0032 applied by Lance, re-ingest done
— 185 votes + 30,105 casts live.** LegiScan prints all 275 as `0000-00-00` (source defect,
confirmed via getRollCall); the House XML export does not serve 2024 (current GA only, verified in
Lance's browser); 185 are dated by an exact printed AYES/NOES match against the bill history
(Tier 1), each with its receipt in `votes.vote_date_provenance`. Run: `--dataset-file` on the
cached session-2122 envelope, **0 LegiScan queries, $0**, status `partial` (exit 2) because the 90
undatable roll calls are refused by design. Live: MO 2024 casts 2,500 → 32,470; public_votes
carries all 185, public_vote_feed all 32,470. The 90 refused = 79 with no action printing that
tally, 10 whose tally a sibling roll call shares, 1 whose only tallied action is the other
chamber's.

**✅ MO GLOSSARY DRAIN COMPLETE AND LIVE (2026-08-21): 1,217 Missouri statute glosses
published ($12.45 of the $15 cap); glossary published 116 → 1,333; verified live.** ✅ **Rendering
fallback SHIPPED the same day (d02e83c):** every linked published gloss now renders — inline where
the term text appears, otherwise in a collapsed "Referenced laws and terms (N)" list under the
summary with the same receipt (gloss + verbatim quote + Source); live-verified on HB 2336 (68
entries, zero console errors). **Visible gloss coverage: 486 of 1,045 published summaries** (was
87 before the MO build). **Next-work menu, Lance's call:** (b) **279 flagged MO glosses** await
his flag review (review page, trust-model process-auditor role) — 47 parked nonexistent
sections carry their evidence in glossary_notes; (c) ~~692 USC mappable drafts~~ **DONE the same evening — see the block above** ($8.31,
not the ~$5 estimated here: the USC excerpts are 2.5x longer); (d) the daily
scheduler mints gloss-ready MO drafts at insert time — a periodic gloss run will be needed (not
scheduled; per-run approval); (e) the custom domain (Lance's console work, docs/CLOUDFLARE_DEPLOY.md).
Runner: `scripts/gloss-batch-mo.mjs`; stop/resume and PID conventions in PLAYBOOK lesson 43. API
balance: **~$7 as of 2026-08-21 late evening** (went to $0 after the USC drain — "out of api
credits" — then "I loaded $7 more"; the scheduler draws ~$0.35–0.70/tick from it) — never
assume a further reload.

**✅ STANDING STATE (updated 2026-08-10 evening; drain COMPLETE 2026-08-18 — live 1,037, see
CHATLOG) — HISTORICAL, superseded 2026-08-23 by the block above: the billed scheduler IS the
running lane (registered Windows task, daily 6 AM, ticking since 08-17 under its ledger), the
drain lane ran to empty 08-22, and the counts below are the 08-10 close. THE 2025-SESSION
MANIFEST CAMPAIGN IS COMPLETE.** All 400 manifest bills consumed: 394 attempted (0 fresh remain) + 6 class-parked
with documented structural reasons (HR 3095 ZIP-code list + 5 SRES en-bloc nomination lists —
single-provision structures the completeness floor rightly refuses; park set lives in the
session build script, reasons in CHATLOG 2026-08-10). **Live: 710 published / 359 drafts / 119
retired** (counted directly at close). Day arc 442 -> 710; grand arc 115 (08-06) -> 710.
**No lane is currently running.** BILLED PATH REMAINS CLOSED (balance spent 2026-08-09; no
billed call without new funds AND Lance's explicit go — never assume a reload). *(Both sentences
describe 2026-08-10; superseded — the scheduler has billed daily since 08-17, $2.70 of $5.00
this ISO week as of 08-23, and every OTHER billed call still needs a per-run go.)* Next-work menu,
Lance's call: (a) **draft drain** — 359 verified-flagged drafts, historically ~80% convert via
re-author-with-objections ("keep draining drafts" resumes it; the 103-no-envelope-drafts
DB-objections upgrade is still owed) *(superseded: drain ran to empty 2026-08-22 — see above)*;
(b) **next manifest export** — ~2,100 eligible bills with
text beyond this manifest, exporter is recency-first (`scripts/export-summary-wave.mjs`)
*(08-10 estimate; the dated figure is 2,498 READY as of 2026-08-23 per `npm run status`)*;
(c) **scheduled-summaries BUILT (2026-08-15), awaiting Lance: load credits + register the task
per docs/SCHEDULED_SUMMARIES.md** — the autonomous daily runner, code-enforced $5/ISO-week
cap, unregistered but ready to go *(superseded: REGISTERED and running — `schtasks` shows the
`VisibleGov Scheduled Summaries` task Daily 6:00 AM, last run 2026-08-23 06:00:01, next 08-24;
`ingestion_runs` carries a billed tick every day 08-18..08-23)*; (d) 34 old-manifest monster bills + ~23 passage bills missing
text (ingestion) remain from earlier inventories. Waves are built from LIVE unattempted state
(zero summaries rows = fresh), never manifest slices.

**State, verified live 2026-08-10 evening (not copied from another doc):**
- **🌐 SITE IS DEPLOYED AND LIVE: https://visiblegov.pages.dev** — full product loop verified
  in a real browser 2026-08-05 (directory → profile → bill → tallies), zero console errors.
- **Summaries: 710 published · 359 open drafts · 119 retired-superseded ('rejected').** Counted
  directly from the `summaries` table at campaign close. Arc: 115 published (2026-08-06) → 442
  (2026-08-10 morning) → 710 (evening, +268 in the final day). Of the 3,343-bill accountability
  set (passage vote + text), 473 now carry a published summary; the other published summaries
  are 'other'-priority resolutions from the 2025-session manifest. 2,549 eligible bills with
  text remain unsummarized overall (08-10; 2,498 READY on 2026-08-23). ⚠️ `npm run status`'s "draft/flagged" line reads 478 — it
  counts `neq.published`, which includes the 119 retirees (INBOX note — FIXED 2026-08-16,
  commit c9b3560: the gauge now counts `eq.draft` and prints retirees on their own line).
- Glossary: 116 published of 6,743 terms (extraction backlog grew with ingest: 5,995
  needs_mapping, 632 draft-mappable; the campaign has been summaries-only). *(08-10; after the
  MO + USC gloss drains, 2026-08-23 reads 1,858 published of 7,344, 522 draft-mappable, 4,964
  needs_mapping — `npm run status`.)*
- Git clean on `main`, everything pushed (run `git log -1` for the exact HEAD — a doc cannot
  contain its own latest commit hash). Suite 2,300+ green (`node --test` in a clean shell for
  the exact count — see the `.env` trap below; last full run 2,389/0 after the parens-gate fix,
  commit 92816ff).
- Migrations: **34 files on disk (0001-0033 + 0018a), ALL applied live** (`0033_retracted_votes.sql` applied by Lance 2026-08-26; the 693-row retraction ran the same hour).
- ~~Migrations: 33 files on disk (0001-0032 + 0018a), ALL applied live.~~ Nothing is awaiting an
  apply (0030/0031 verified live 2026-08-05; `0032_vote_date_provenance.sql` applied by Lance
  2026-08-23, and the 2024 MO House re-ingest ran the same hour — 185 votes + 30,105 casts).
  CLAUDE.md trap #2 carries the same statement.
- Data (2026-08-10 `npm run status`): votes 10,266 · vote_casts 1,470,602 · bills 38,256 ·
  legislators 1,607.
- Scheduler healthy: sources ticking through 2026-08-08+ (us-congress and mo-legislature both
  show current coverage); `refresh-aggregates` on pg_cron. The 3-layer timeout saga stays closed.
- ⚠️ **Before running the suite: do NOT `source .env` in the same shell.** It makes 2 correct
  tests in `review-logic.test.js` fail (expected-500-got-200) because they assert behavior when NO
  DB client is configured. Verified deterministically 2026-08-05 — and it caught me AGAIN mid-sync
  when a live `curl` check and `node --test` shared one shell. Use `node --test` in a clean shell.
  Every CLI takes `--env-file=.env` for exactly this reason. (PLAYBOOK_DELTA lesson 30.)

✅ **Migration 0031 APPLIED and VERIFIED LIVE 2026-08-05 (deploy night).** The anon 500 on
profile vote lists is fixed: the exact failing query returns 200 in 0.27s as anon (was 500 timeout
at 3.2s), dedup semantics preserved (a superseded vote with 33 base-table casts shows 0 rows in
public_vote_feed; 2,045 casts correctly excluded overall). Confirmed in a real browser end-to-end,
zero console errors: profile renders 162 vote rows with bill links + populated aggregate charts;
click-through to a bill page (HB 3080) shows sponsors, plain-language summary, and roll-call
tallies. **The full product loop works on the live site.**

**~~THE NEXT THING~~ (2026-08-05 framing — since 2026-08-22 this is ONE ITEM of the next-work
menu in RESUME HERE, item (e)): finish the Cloudflare deploy — Phases 3 & 4 (custom domain), all Lance's console
work.** Phase 1 (create Pages project) and Phase 2 (verify on `.pages.dev`) are DONE and the site
is live and verified. Remaining, per `docs/CLOUDFLARE_DEPLOY.md`: Phase 3 (move nameservers to
Cloudflare — a clean sweep, no email to preserve) and Phase 4 (attach
`visiblegov.helpingpeoplehelpingpeople.com`, then re-run the curl checks against the custom domain,
since headers/redirects/Functions are host-sensitive). **(Superseded 2026-08-22: the custom domain
is the apex `visiblegov.us` — Lance owns it. Phase 3 is now a FRESH zone for `visiblegov.us`
(add site → delete registrar cruft → nameservers at the registrar), NOT a sweep of the HPHP zone,
which is no longer involved and stays where it is; Phase 4 attaches `visiblegov.us` with `www`
as an alias. `docs/CLOUDFLARE_DEPLOY.md` Phases 3-4 were rewritten for the apex, commit 1f44a2d.)**
The pre-deploy list below is fully done and
kept as the record of what had to be true:
1. ✅ **`geocode.js` security headers — BUILT 2026-08-05.** All five response paths (incl. the
   400/502 error paths) now set them from `site/js/security-headers.js`, a shared constant the
   Function can statically import (Pages Functions have no filesystem, so they cannot read
   `_headers` the way `serve-site.js` does). That constant is a genuine second copy of the values,
   so drift is caught mechanically: a test asserts it equals `_headers`' `/*` block key-for-key —
   **verified red-then-green** by injecting a deliberate mismatch.
2. ✅ **`site/404.html` — BUILT 2026-08-05.** Deliberately zero JavaScript (it has to render when
   the thing that broke IS the site). `serve-site.js` now serves it on a miss too, so local dev
   mirrors what Pages does in production instead of hiding the difference behind a text/plain body.
3. ✅ **`0030_revoke_refresh_aggregates_from_authenticated.sql` — APPLIED AND VERIFIED LIVE
   2026-08-05.** `information_schema.role_routine_grants` now shows only `service_role` and
   `postgres` with EXECUTE; `authenticated` is gone. Verified the revoke did not break either
   legitimate caller (pg_cron runs as `postgres`, the scheduler as `service_role` — both observed
   succeeding after the apply). A migration test asserts the revoke exists AND sorts after the
   newest definition of the function — `CREATE OR REPLACE` preserves privileges, but a
   `DROP`+`CREATE` would silently restore `authenticated`'s EXECUTE.
4. ✅ **Both open questions ANSWERED 2026-08-05.** (3a) Lance has an existing Cloudflare account,
   and owns `helpingpeoplehelpingpeople.com` — which currently serves only a disposable caard.io
   one-pager he is fine losing, and he explicitly confirmed the zone has **no email functions at
   all** — so the nameserver move is a clean sweep: every imported record gets deleted, no judgment
   call, nothing to preserve. *(Superseded 2026-08-22: the HPHP zone is not part of the plan any
   more — `visiblegov.us` gets its own zone; see the note above.)*
   (3d) Preview builds: recommended **leave the default on** — this is a public-transparency site,
   the anon key is public by design, RLS is the wall, and there is no auth session to confuse
   across origins. Not yet formally ruled by Lance; nothing blocks on it.
   **➡️ The whole deploy is now a runbook: `docs/CLOUDFLARE_DEPLOY.md`** (reviewed and tightened
   2026-08-05 — added the project-name field, a called-out highest-risk item, live attribution
   verification, and rollback guidance; every factual claim in it re-verified against the code) — four phases
   (`.pages.dev` first → verify with curl at the origin → nameservers → custom domain), exact
   project-creation values, copy-paste verification commands, and the LinkedUmp traps written next
   to the steps that trigger them. All code-side work is DONE; what remains is console work in
   Lance's own account.

- **MO term-date backfill — COMPLETE 2026-08-06 (both applies ran + live-verified):** 192/194 MO
  terms dated. 171 via the dual-source auto-agree apply; 21 via Lance's adjudication ruling
  (*"start date = start of the current term they are serving"* → OpenStates open-role date wins;
  record: `docs/adjudications/2026-08-06-mo-term-date-flag-adjudication.json`, applied with
  `--apply-overrides`, ruling + citations in `ingestion_runs.detail`). The 2 remaining NULLs are
  deliberate: Brown H-149 (no authored date in openstates/people — seat absent from their current
  roster) and Onder's parked stale D2 row (TODO 31). 0 end_dates written.

- **Directory "Serving now / Past members" split — SHIPPED 2026-08-06 (same evening), live-verified:**
  the homepage now opens on "Serving now (730)" with a "Past members (837)" toggle, per-view name
  search, byte-exact honesty footnote, and `since YYYY` tenure fragments (powered by the backfill
  above). Verified in a real browser post-deploy: Onder renders only as U.S. House D3 · since 2025,
  Schroer alone holds MO Senate D2 · since 2023, zero console errors, suite 2367/0. Spec:
  `docs/superpowers/specs/2026-08-06-directory-serving-now-split-design.md`. This CLOSES the
  2026-08-05 "filter the long ass list" request end-to-end. Known pre-existing nit logged for later
  (not a regression): federal `Last, First "Nick"` name shapes make the surname-fallback sort put
  quoted nicknames first within each view.

**Genuinely open, NOT blocking the deploy** (details further down / in the audit sections; the
counts on this list are dated — `npm run status` OPERATOR QUEUE is the live figure):
- 107 open `vote_reconciliation_flags` (61 hard_mismatch) *(2026-08-05 count; 2026-08-23: 364
  open — 101 hard_mismatch, 176 `no_tally_corresponding_primary` (expected to close via
  `scripts/resolve-matched-reconciliation-flags.mjs` once the journal replay lands their twins),
  69 `primary_cast_data_not_comparable`, 14 soft, 4 ambiguous; 187 legiscan-vs-mo-senate-web,
  177 legiscan-vs-mo-house-xml)*. Now drainable with
  `correct-data.js reconcile-flag` instead of one code change per flag — but each is a real human
  ruling about a real legislator's record, so it is Lance's work, not an agent's.
- 359 draft summaries (see the RESUME HERE block for what they are — verified-flagged,
  drain-lane fodder) + 632 draft-mappable glossary terms (plus 5,995 needs_mapping) in the
  review queue *(2026-08-10 figures; 2026-08-23: 32 drafts = 28 parked with written reasons + 4
  fresh scheduler refusals; glossary 522 draft-mappable / 4,964 needs_mapping / 1,858 published of
  7,344, plus 419 flagged glosses awaiting Lance's flag review)*.
- ~~**Migration `0032_vote_date_provenance.sql` — DRAFTED, NOT applied**~~ **DONE 2026-08-23:**
  Lance applied it and the $0 re-ingest of session 2122 from the cached dataset stored the 185
  tally-dated 2024 MO House roll calls with their receipts (0 LegiScan queries; status `partial`
  by design — the 90 undatable roll calls stay refused). `npm run status` now shows 2024 MO casts
  at 32,470, up from ~2,500.
- **MO House XML export serves only the CURRENT General Assembly** (verified 2026-08-23 in
  Lance's browser: 241 of 242 prior-GA loads are the HTTP-200 error page) — there is no
  prior-GA backfill path through `mo-house-xml`; LegiScan is the only source for earlier years.
  Recorded in ledger item 23; listed here so a fresh session does not go looking for one.
- **Sen. Travis Fitzwater (MO Senate D10, term since 2023-01-04) has 0 casts on ANY
  `mo-senate-web` journal vote** (234 journal votes live, 168 of them 2026 — counted 2026-08-23
  ~15:00Z; the replay adds more each day-writing slot) while carrying
  5,073 LegiScan casts — the journal pipeline, the completeness-critical one, resolves 33 of
  the 34 roster seats and drops his. Captured 2026-08-23 (INBOX entry with the mechanism);
  pre-existing (the 08-02 session-merge note below already saw the symptom), not caused by the
  replay.
- ~19 known unbounded-`.select()` sites across 8 files, grandfathered in
  `tests/select-pagination-enforcement.test.js`'s dated allowlist. `ingest.js` is closest to
  actually tripping (legislators at ~940 of the 1,000 cap on a live-scheduled path).
- MO House per-legislator vote coverage: investigated 2026-08-05, roster fix **deliberately
  deprioritized** as redundant with LegiScan. Site renders honestly. Do not re-investigate — read
  the entry below first.
- Deep-audit **phases 3 and 4 never ran** (paused on budget). Phase 4 was the adversarial
  verification pass; phase-1/phase-2 findings have NOT been through it, and this project's history
  says that pass routinely refutes real-looking findings. Treat them as leads, not confirmed bugs.

---

## NOW

- **PostgREST 1000-row-cap: mechanical enforcement added 2026-08-05; ~19 pre-existing violations
  found and cataloged, not yet fixed.** A 4-workflow deep audit (code architecture, logical
  process/pipeline integrity, intent/mission alignment, synthesis+adversarial verify — Fable 5, max
  effort, per Lance's request) re-found the single most recurring bug class in this project's
  history: a bare `.from(table).select(...)` silently truncated at PostgREST's 1,000-row cap. This
  exact bug shipped live at least five times before (the vote-duplicates truncation, senior
  engineering audit finding 1; the glossary-queue trio; a hotfix-path recurrence, PLAYBOOK_DELTA's
  own delta item 12) — asked Lance whether a different backend would fix the *pattern* itself;
  answer was no (PostgREST isn't the bug, inconsistent enforcement of an already-correct fix is) —
  he approved two remedies: (1) check/raise Supabase's dashboard `db-max-rows` setting (Dashboard →
  Integrations → Data API → Settings, default 1000) — **still needs Lance himself, no dashboard
  access from here; known issue as of March 2026, dashboard changes may not take effect
  immediately/may need a propagation delay** — and (2) a mechanical test,
  `tests/select-pagination-enforcement.test.js`, now committed and green, that fails loud on any
  NEW unbounded multi-row select in `src/`/`scripts/`/`site/js/` while grandfathering today's known
  debt via a dated, file-scoped allowlist (shrinks as each file gets fixed, never meant to grow).
  **Currently-allowlisted files, real debt not yet fixed:** `src/cli/ingest.js` (3 lookups,
  legislators already at 940/1000 on the actively-scheduled us-congress path — closest to actually
  tripping), `src/cli/ingest-mo-house.js` (`listPendingRollCallPdfs`), `src/cli/correct-data.js`
  (`runCorrectMoHouseChamber`), `src/cli/golden.js` (`loadGoldenCandidates`),
  `src/cli/summarize.js` (**already tracked as TODO 18/32, `votes` already past the cap**),
  `src/cli/verify.js`, `src/cli/extract-terms.js`, `src/review/server.js` (`handleQueue`'s
  summaries select — the parallel glossary-queue query was already fixed under a prior CRITICAL
  finding, this one was missed at the time). Each file's exact functions/finding are named in the
  test's own `ALLOWLISTED_UNSAFE_FILES` map. Fixing each is mechanical (route through `selectAll`)
  but is real, separate work — not done as part of adding the enforcement itself, per Lance's
  explicit scope ("proceed with 1 and 2" — the guard and the config check, not the cleanup).
  **Full audit found 25 subsystem reviews' worth of findings beyond this pattern too** (phase 1 of
  the 4-workflow pass, 3.25M tokens, zero critical, 31 important — see CHATLOG 2026-08-05 for the
  synthesized top-6, including a real security gap on `refresh_vote_aggregates()`'s grants, the
  `mo_house_id` unique-constraint landmine matching the already-fixed `mo_senate_id` bug, and a
  fresh-rebuild blocker in migration 0027's `pg_cron` extension clause).
- **Phase 2 of the deep audit — logical-process/pipeline integrity, 6 pipelines traced end-to-end,
  1.23M tokens, 6 agents. THREE of six pipelines came back verdict FALSE (documented guarantee not
  actually delivered) — a materially worse result than phase 1's file-level pass.** Full raw
  findings: workflow output referenced in CHATLOG 2026-08-05 (continued) entry. Not yet fixed —
  found and cataloged only, per the same "read/report first" scope as phase 1. Ranked by real
  consequence:
  1. 🔴 **The Pierson wrong-merge guard (2026-08-03 audit, `person-identity.js`'s
     `sourceKeyPairStatus`) does not generalize — TODO.md/CONTROLLER_BRIEFING's "permanently
     prevents this class of wrong merge" claim is FALSE for the general case.** The guard only
     fires when both legislator rows populate the SAME per-source identity column (e.g. two
     LegiScan rows, both carrying `legiscan_people_id`). The dominant real case — merging rows
     ACROSS different sources, the whole point of this system — stamps a DIFFERENT column per
     source, so the guard never sees it. The exact Pierson input shape (identical name, empty/
     dateless seat evidence) still auto-merges silently whenever the two rows come from different
     sources. Needs its own fix: this is a documentation/safety-claim correction plus a real code
     gap, not just a doc fix.
  2. ✅ **FIXED 2026-08-05 — `correct-data.js reconcile-flag`, the general adjudication tool.**
     *(Original finding: "quarantine is dead code — the module header's claim that
     possibly-contradicted data is never publicly reachable is stale and unmet; the only way to
     resolve a flag is a bespoke one-off correction per flag, like `sb914-reconcile`'s hardcoded
     UUID.")* **Half of that finding was a misread and is worth recording as such:**
     quarantine's unreachability is NOT a defect — it's a deliberate, fuzz-confirmed doctrine
     (CHATLOG 2026-07-29 final review, 200k inputs: *"machine-proven quarantine is a null set at
     this data granularity — correspondence proof requires tally agreement, contradiction requires
     disagreement; cross-source disputes are permanently human-review flags with primary-wins
     display"*). Quarantine was correctly RETIRED in favor of store-and-flag. Phase 2 flagged a
     superseded design as a broken guarantee — a good example of why phase 4's adversarial pass
     matters. **What WAS real and is now fixed:** (a) the module header in `legiscan-votes.js`
     genuinely asserted a safety property the code deliberately abandoned — corrected in place with
     the doctrine and its date, rather than deleted, since the `quarantine` return value it
     documents still exists in the function's contract; (b) there was no general adjudication path.
     `reconcile-flag` now generalizes exactly what `sb914-reconcile` did for one hardcoded UUID:
     `--flag-id`, a required `--ruling` + `--rationale`, and either a `--canonical-vote` /
     `--superseded-vote` pair (supersede mode — writes the `vote_duplicates` exclusion, same
     non-destructive mechanism as migration 0022) or neither (resolve-only mode — closes the flag
     with a recorded ruling and no dedup write, the honest outcome for "both rows are genuinely
     real," "no counterpart exists after all," or "not actionable until the MO House roster gap is
     fixed"). It never guesses a winner — the operator names both rows, deliberately, because
     attributing a legislator's public vote record is a human call (CLAUDE.md's one non-negotiable).
     Mechanical guards, all tested: one supplied vote id MUST match the flag's own `vote_id` (typo
     guard — verified live that it refuses two real-but-unrelated vote ids), both vote rows must
     exist, a half-specified dedup is refused rather than silently downgraded, re-supersession under
     a different canonical row is refused, ruling and rationale are both mandatory, and re-running is
     a clean no-op. 10 new tests; dry-run verified against a real live flag; nothing written live.
     **Live queue is 107 open flags, not the ~48 the older audit cited** — 61 `hard_mismatch`,
     22 `no_tally_corresponding_primary`, 20 `primary_cast_data_not_comparable`, 4
     `ambiguous_tally_match`. Draining it is now operator work rather than a code change per flag,
     and is Lance's own call (each one is a real ruling about a real legislator's record).
  3. A silent wrong-*split* class in identity-linking: era-blind district-contradiction logic can
     silently split one real person's record into two persons with ZERO flags raised (not even a
     flag for review) when their districts differ across eras (redistricting). Same trigger
     profile as the already-known TODO 31 (fires on multi-era backfill), opposite direction
     (split, not merge), previously undocumented.
  4. Two `votes` rows for the same real floor vote can coexist, both fully counted, with **zero
     flag and zero record**, if they disagree on the match key itself (bill_id/date/chamber)
     rather than the tally — already happened live 3 separate times (the 2026 session split, the
     MO House chamber mislabels, the 1969 sentinel dates), each fixed as a one-off; the *class*
     still has no detector.
  5. Public "receipt" quotes (`evidence_quote` for summary bullets, `supported_by_quote` for
     glossary terms — the exact bill/statute text shown to back a claim) are never mechanically
     checked to actually be a verbatim substring of the source. This is the one place in the whole
     trust-model-v3 pipeline where a model's self-report is trusted verbatim, despite
     `trust.html`'s public claim of "the exact quoted excerpt." A hallucinated quote could pass
     every other gate and auto-publish.
  6. `src/cli/ingest.js` (the live `npm run ingest` write path) has almost no test coverage on its
     actual database-writing functions (`collectUsCongress`/`collectMoLegislature`/
     `persistUsCongress`/etc.) — only arg-parsing is tested. The untested code also contains 4
     more unbounded `legislators` selects beyond what phase 1/the enforcement test already found
     (byBioguide/byOsId map misses → silent cast misresolution once the table crosses 1000 rows).
  7. `scripts/data-status.js` — the tool `CLAUDE.md` itself designates as "the only source of
     truth for live numbers" — has zero test coverage and is structurally untestable as written
     (no exports, top-level side effects). Its passage-question regex has already silently
     drifted from what it claims to mirror (`summary-queue.js`'s canonical, tested version:
     `\s*` vs `\s+`) — currently benign-direction, but proves the seam is real and unguarded.
  8. The documented scheduler freshness bound ("~15 min late at most") isn't actually met — the
     5-source registry is structurally oversubscribed (~6/hr demand vs 4/hr capacity), so sources
     converge to an ~hourly rotation in steady state, not every ~30 min as `docs/
     SCHEDULED_INGESTION.md` claims. Safe direction (nothing lost, provably bounded ~75 min worst
     case), but the doc's own claim is wrong and should be corrected.
  9. Reconfirms/sharpens an already-known item: 0027's pg_cron exception handler can never record
     a failure (PL/pgSQL savepoint semantics — TODO already tracked this as "purely an
     observability gap"), but phase 2's framing is sharper: the pipeline's stated PRIMARY
     freshness guarantee currently has NO working automated failure signal at all, and its one
     honest residual (an aging `finished_at`) is displayed with no staleness threshold anywhere.
  **Phases 3-4 (intent/mission alignment, final synthesis) remain paused on Lance's own budget
  call — not resumed, resume is his decision.**
- [x] ✅ **Migrations `0023`, `0025`, `0026` applied and verified live 2026-08-03 (Lance: "all have
  been ran in supabase").** `0026` (aggregate-refresh timeout fix) confirmed by actually running
  `npm run refresh:aggregates` — completed clean in ~19s (`mode: "refreshed"`), no timeout;
  outage over, charts current again. `0023` confirmed via live planner-cost check (`public_votes`
  anon-planned count 52, matches the owner-bypass control, not the deny-shape one) plus a direct
  `vote_duplicates` anon read (`200 []`). `0025` (column-scoping) mostly confirmed clean —
  **except it broke a real site query in production**, caught immediately by re-verifying every
  actual `site/js/` call site live rather than assuming the migration alone was the whole story:
  `bill-page.js`'s summary fetch had no explicit `select=` (defaulted to all columns), and Postgres
  denies a bare `select=*` outright when a role only holds column-level grants — it does not
  silently narrow to the granted columns. That query started 401ing the instant `0025` landed.
  **Fixed same pass** (`site/js/bill-page.js`, commit `9884b18`): added the explicit `select=`
  listing exactly the columns `0025` grants. Confirmed via direct anon REST calls against all 5
  real `summaries`/`glossary_terms` query sites in `site/js/`, AND a real Playwright browser load
  of an actual bill page (summary rendered correctly, zero console errors). Every other query site
  already had an explicit `select=` and needed no change.
- [x] ✅ **Senior engineering audit, 2026-08-03 — 21/21 findings confirmed (0 refuted); 19 of 21
  fixed live same-day (the 2 demoted to minor by the audit's own verifier were deliberately deferred
  — see the audit doc's own "next real change to that file" framing).** Full report:
  `docs/audits/2026-08-03-senior-engineering-audit.md`. Fixed in 8 commits, full suite green
  throughout (2,290/2,290, `ℹ fail 0` at every step):
  1. ✅ **The live data defect** — `runCorrectVoteDuplicates`'s bare `.select()` (truncated at 1,000
     of 8,221 legiscan votes) routed through `selectAll`; regression test seeds 1,200 pairs and
     fails against the old code. **Live correction run: 59/59 matched** (26 written by an earlier
     attempt that hit a client-side timeout mid-run, 33 more by the completed run — fully additive/
     idempotent, verified via a direct REST count: `vote_duplicates` now has exactly 59 rows).
     `trust-page.js`'s own cast count switched to `public_vote_feed` (was reading raw `vote_casts`,
     which would have kept including exactly what this fix now excludes).
  2. ✅ Scheduler ops resilience: optional dead-man's-switch ping (`HEALTHCHECK_PING_URL`, inert
     until Lance sets it), `aggregatesAttempted`/`aggregatesHealthy` split (the old field only ever
     meant "attempted," and all 13 real 0026-outage ticks logged `healthy:true` throughout),
     `refresh-aggregates.js` now writes a durable `ingestion_runs` row (existing freshness surface
     catches staleness for free), new `all-lookups-failed` scheduler mode (a revoked key was
     mechanically reproduced to degrade into an indefinite healthy-looking "nothing-due" state).
  3. ✅ `probe-public-surface.js` extended for 0024/0025 (column-denial + real site-query replay,
     ran live — all pass); a migration-text test dynamically pins whichever migration currently
     redefines `refresh_vote_aggregates()` to still fold `statement_timeout` into its own
     declaration, so a future redefinition can't silently drop it again unnoticed.
  4. ✅ Ingest-boundary hardening: unguarded XML root access in `us-congress.js`/`us-senate.js`
     (200-status non-roll-call bodies used to crash the whole run) now fails loud with a typed
     guard; `http.js`'s body-read step (not just the connection) now wraps into `SourceFetchError`;
     `mo-house-xml.js`'s `parseMoBillList` no longer silently returns `[]` on a malformed
     BillList.XML; `ingest-mo-house.js` gets the same roll-call-PDF quarantine pattern for
     bill-detail parses (a single permanently-bad bill used to wedge the entire 1,946-bill backlog
     behind it forever).
  5. ✅ `SUPERSEDED-BY` headers on migrations 0016/0018/0018a/0019/0020/0022 — every dead-but-present
     view/function definition now names what replaced it, right at the block someone would copy
     from.
  6. ✅ Static, offline site-query/grant contract test (parses 0025's own GRANT list, scans every
     real `site/js/` query — proven to fail against the exact pre-fix `bill-page.js` shape); the 4
     backfill test files that read the real, gitignored, weekly-mutating `legiscan-datasets` cache
     now skip honestly on a fresh clone (verified: hiding the real cache produces exactly 12 clean
     skips, matching the audit's own citation, restoring it goes back to 0 skips/all real) instead
     of failing confusingly; a hardcoded `datasetDate` pin (a live time-bomb) floored instead.
  7. ✅ Docs: README runbook section (prerequisites, tests, local dev server, the one canonical
     migration-apply description); the API-spend-approval sentence now states the active suspension
     explicitly; `CLAUDE.md`'s exact test count switched to magnitude language; `CONTROLLER_BRIEFING.md`
     gets a top-of-file banner — migration-applied-state claims anywhere in that dated, sequentially-
     refreshed doc are not authoritative, several were already stale (0023/0025 both landed after its
     last refresh pass; 0026 isn't in it at all).
  8. ✅ Architecture: the genuine 3-node `src/cli` import cycle (`ingest-legiscan.js` →
     `correct-data.js` → `ingest-mo-senate.js` → back) dissolved by promoting `mapMoStatusCode`
     (+ vocabulary) and `journalPdfBasename` to `src/lib`; the byte-identical ToU-cooldown trio and
     JSON-cache mechanism duplicated across `ingest-mo-house.js`/`ingest-mo-senate.js` extracted to
     `src/lib` too — `scripts/scheduled-ingest.js` now imports the cooldown trio from `src/lib`
     directly instead of from a 1,322-line CLI file (it had been depending on the senate copy for
     ALL FIVE registry sources' due-ness, undeclared).
  **Deliberately deferred (both demoted to minor by the audit's own adversarial verifier):**
  `handleIdentityDecision`'s 378-line/71-branch size (exhaustively test-pinned already; extract on
  the next real change to that file) and the README policy-sentence/count issue (fixed above
  anyway, folded into item 7).
  **Follow-up, root-caused in 3 layers (2026-08-04), 2 fixed live, 1 still open:**
  **Layer 1 (fixed):** the manual `npm run refresh:aggregates` call was hitting a hard ~120-125s
  Supabase edge-gateway timeout on synchronous REST/RPC requests — confirmed via a raw fetch
  bypassing the SDK (HTTP 504, `server: cloudflare`, body "upstream request timeout"). **Fix
  applied: migration `0027_pg_cron_refresh_aggregates.sql`** — schedules the refresh as a native
  `pg_cron` job every 30 min directly inside Postgres (no HTTP/gateway involved for the routine
  case). Applied and confirmed live (Lance).
  **Layer 2 (fixed):** even via pg_cron, the job still failed at ~120s with Postgres's own native
  `canceling statement due to statement timeout` — a separate semantics trap: `statement_timeout` is
  armed ONCE at the start of the top-level statement using whatever is ambient at that instant, so
  the function's own `set statement_timeout = '600s'` (folded in by 0026/0027) can never retroactively
  extend a deadline already fixed before the function body runs. Root-caused against real Postgres
  core-developer mailing-list threads (not guessed); Supabase's own `postgres` database carries a
  built-in 2-minute database-level default that was the actual ambient value. **Fix applied: migration
  `0028_fix_statement_timeout_arm_timing.sql`** (`alter database postgres set statement_timeout =
  '600s'`) — confirmed working live via `cron.job_run_details`: failures shifted from exactly 120s to
  exactly 600s (proving the 600s ceiling is now the one actually in effect).
  **Layer 3 (FIXED, 2026-08-04, migration `0029_fix_vote_duplicates_antijoin_planner_misestimate.sql`,
  applied + verified live):** with both timeout layers fixed, `pg_cron`'s ticks were STILL failing —
  hitting the real 600s ceiling on genuine query duration, always on the exact same statement
  (`refresh materialized view concurrently public_party_alignment`). Confirmed reproducible across 5
  consecutive real ticks. Ran `ANALYZE` on `vote_casts`/`votes`/`legislators`/`vote_duplicates` as a
  first hypothesis — confirmed it did NOT fix it. A live debug run (bypassing pg_cron's own ceiling
  via a temporarily-raised database default) showed the query was still genuinely, actively running
  (not stuck) past 40 minutes for ~1.47M rows.
  **Root cause, found via a plain `EXPLAIN` (no ANALYZE — returns instantly regardless of true
  execution time, and should have been the first diagnostic reached for, not the last after ~2 hours
  of empirical timing attempts):** all three vote-aggregate matviews exclude superseded votes via
  `left join vote_duplicates vd on vd.superseded_vote_id = v.id ... where vd.id is null` (added by
  0022). Postgres's planner catastrophically misestimated this anti-join's selectivity as **1 row**
  when the honest answer (given ~10,103 votes vs. 59 duplicates) is ~10,044 — a known Postgres
  planner limitation where a post-LEFT-JOIN `IS NULL` filter gets estimated from the joined column's
  own null-fraction (0%, since `vote_duplicates.id` is a PK) instead of the join's real match rate.
  That single misestimate cascaded into Nested Loop joins for the entire downstream plan instead of
  Hash Joins — catastrophic once the true cardinality reaches ~1.34M rows. Confirmed via a second
  `EXPLAIN`: rewriting as `not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id
  = v.id)` gives a correct ~10,044-row estimate and Hash Joins throughout — same semantics, correct
  plan. `public_party_alignment` hit the wall first (its extra CTEs/self-join amplify nested-loop
  damage most); `public_position_totals`/`public_party_position_totals` carried the identical latent
  risk and are fixed in the same migration before they failed the same way as data kept growing.
  **Verified live, 2026-08-04 23:00-23:02 UTC:** three consecutive clean `succeeded` rows in
  `ingestion_runs` — two real pg_cron scheduled ticks (22:30:00, 23:00:00, both exactly on the
  `*/30` boundary) AND a manual `npm run refresh:aggregates` test (~19.4s wall-clock, matching the
  pre-outage healthy baseline exactly). Both the automated and manual paths confirmed working, not
  just one. Regression test added: `tests/vote-duplicates-antijoin-migration.test.js` (dynamic,
  same pattern as `refresh-vote-aggregates-migration.test.js`) fails loudly if a future migration
  ever reintroduces the LEFT JOIN + IS NULL idiom for any of the three matviews. Debug scaffolding
  from the investigation (`debug-timeout-check`/`debug_long_running_timeout()`,
  `debug-party-alignment-timing`/`debug_time_party_alignment_refresh()`, both pg_cron jobs, both
  functions, all their `ingestion_runs` rows) cleaned up live. Database `statement_timeout` restored
  to `600s` (matches migration 0028; a live `45min` bump made mid-investigation for diagnostics only
  was reverted, not left diverged from git).
  **Separately found, NOT yet fixed (real but now low-priority — the routine case completes in ~19s,
  nowhere near any timeout, so this is purely an observability gap for a genuinely rare future
  failure, not a live issue):** migration 0027's own exception handler (`update ... set
  status='failed' ...; raise;`) can never actually leave a 'failed' row in `ingestion_runs` —
  PL/pgSQL implicitly savepoints a `BEGIN...EXCEPTION` block *before* its first statement (the
  `insert ... 'running'`), so any exception rolls back that insert first, the `update` becomes a
  no-op against a now-nonexistent row, and the trailing `raise;` then aborts the whole outer
  transaction anyway (rolling back even that no-op). If genuinely worth fixing later: drop the
  exception handler entirely per 0027's own header's stated fallback plan, rely on
  `cron.job_run_details` for observability (already proven reliable throughout this investigation).
  A real process miss surfaced and fixed along the way: this exact class of problem (this same
  function's RPC call timing out) had already happened once, earlier the same session, with an
  already-proven workaround on record in CHATLOG.md — five retries and a full diagnostic
  investigation happened before that was found. PLAYBOOK_DELTA lesson 26 + this project's own
  `investigate-then-report-dont-spiral` memory both updated to make "grep CHATLOG for a prior
  occurrence first" the actual first step next time, not an afterthought.
- [ ] **Comprehensive accuracy audit, 2026-08-03 — all 4 criticals fixed live, 2 items left for
  Lance's own call.** Full report: `docs/audits/2026-08-03-comprehensive-accuracy-audit.md`.
  **Fixed and verified live, all via tested `correct-data.js` corrections (dry-run then live) plus
  their root-cause code fixes:**
  1. ~~SB 914 tally contradiction — root-caused, not yet adjudicated~~ **✅ RESOLVED 2026-08-05 (Lance: "trust senate journals"; sb914-reconcile ran live, flag resolved — see the SB 914 entry higher in NOW).**
  2. ✅ FECA/BBEDCA glossary terms no longer say what their own verification refuted
     (`correct-data.js glossary-refuted-claims`, live).
  3. ✅ All 7 corrupted glossary terms repaired, verified byte-clean (`correct-data.js
     glossary-corrupted-text`, live); a text-integrity gate now blocks this class going forward
     (`auto-publish-glossary.js`'s `hasTextCorruption`).
  4. ✅ Tommie Pierson Sr./Jr. split back into two unlinked legislator rows (`correct-data.js
     pierson-split`, live) — a same-source-key contradiction guard (`person-identity.js`'s
     `finalPairStatus`) now prevents this class of wrong merge **for same-source pairs only —
     see the phase-2 audit finding in NOW above; the original "permanently prevents this class"
     claim was corrected 2026-08-05 as overstated.** The guard needs BOTH rows to populate the
     same per-source identity column, so cross-source pairs (the dominant case) are still
     unguarded.
  **Also fixed (important findings, root causes):** `buildMoVoteRows` chamber-hardcoding bug fixed
  + the 3 live mislabeled Senate votes corrected (`correct-data.js mo-house-chamber`, live);
  migration `0023_vote_duplicates_rls_and_view_drift.sql` (enables RLS on `vote_duplicates` for any
  future rebuild + corrects the committed 0022 file's view definitions to match what's actually
  live) — **applied and verified live 2026-08-03** (see the top NOW entry).
  **Items deliberately left for Lance, not resolved by an agent (✅ = since closed):**
  - ✅ **MO House per-legislator vote coverage — RESOLVED, effectively 2026-08-05: not the profile-
    blanking problem this was framed as.** "~162 of ~163 MO House members show ZERO MO House votes
    on their own profile page, forever, with no caveat" was WRONG as stated and is corrected here —
    it specifically meant zero votes sourced *from the `mo-house-xml` adapter*, not zero votes
    overall, and reading it as "the page is blank" was a real, load-bearing misstatement carried
    across four docs. **Live-verified directly, 2026-08-05: all 159 of the CURRENT MO House
    legislators have at least one real MO House `vote_cast` on their profile**, via LegiScan's own
    comprehensive, independently-working coverage (confirmed via `site/js/person-page.js`: votes
    render generically by chamber, with no source/adapter-based filtering that would exclude
    LegiScan-sourced MO House rows). The one fixture legislator (Matthiesen) isn't uniquely "fully
    tracked" — everyone is, just not via this one narrow adapter. The real residual gap is narrow:
    a handful of the MOST RECENT roll calls that exist ONLY via `mo-house-xml` (the ~40 bills not
    yet also in LegiScan) may be briefly missing from a profile until LegiScan's own periodic
    refresh catches up — not a systemic or permanent blank section. **Decision: ship as-is, no site
    caveat needed** — a caveat would warn users about a problem that doesn't actually exist on the
    rendered page for virtually any legislator or vote. Root cause of the underlying `mo-house-xml`
    resolution gap itself (still real, just much lower-stakes than believed): `persistRoster`
    (`ingest-mo-house.js:844-878`) hardcodes a single test fixture
    (`tests/fixtures/research/mo-house-xml/representative-107.xml`) and `insertIfAbsent`s the same
    one row every call — a true no-op after the first run. The live per-district roster fetch
    (`fetchMoMemberList`/`fetchMoRepresentative`, `mo-house-xml.js:124-149,314-321`) already exists
    in the adapter but is called nowhere — deferred work that was never wired up. Compounding bug:
    `listPendingRollCallPdfs` marks a roll call "done" the moment it resolves even 1 cast, so
    already-processed roll calls would stay frozen even after a roster fix, without a separate
    replay pass.
    **Investigated end-to-end 2026-08-05 (parallel investigate → synthesize → adversarially verify;
    verdict CONFIRMED on independent re-check) — scope is much narrower than "most... structurally
    incomplete" implied.** The dominant `legiscan` pipeline already covers 96.9% of ALL MO House
    votes (6,447/6,652, full 2015-2026 span, 0% zero-cast, 424 legislators correctly resolved,
    155-163 casts/vote). `mo-house-xml` itself only produced 130-134 votes (all 2026), of which the
    ~22-24 that resolve ANY real cast are, verified live, **100% bill-level-overlapping with an
    existing LegiScan vote on the same bill** — i.e., every piece of currently-useful output this
    source has ever produced already has a LegiScan counterpart. (Can't get a dedup-certified
    floor-vote match — `vote_duplicates` shows zero hits here — but that's the *same* 1-person-roster
    gap starving the certifier of enough individual casts, the identical limitation already found on
    `HB1623-3` during the vote-dedup work; bill-level overlap is strong circumstantial evidence, not
    a certified match, and is reported as such.) Whole-dataset, only 2.7% of MO House votes (181 of
    6,652) are zero-cast — 75 from a separate, dead, no-longer-scheduled `mo-ocd-vote` pipeline
    (2022 only), 106 from `mo-house-xml` (2026 only). Bonus, unrelated finding: **zero MO House
    votes exist for 2024 at all** — a separate gap, not investigated further.
    **Decision: deliberately deprioritized the roster-ingest-loop fix (2026-08-05), not building
    it.** Cost (~3.4 days of cooldown budget for a live per-district roster fetch, plus a new
    replay-pass mechanism, plus careful navigation of the separate "MO House cross-era
    misattribution trap" — `mo_house_id` is `unique` with no collision handling, TODO 31, still
    open) clearly outweighs the payoff given the confirmed 100% redundancy of everything it
    currently *can* resolve. The pipeline itself keeps running as-is — its bill/action tracking and
    PDF integrity-gated tally extraction are correct, independent work, not affected by this
    decision. Out of scope for the Cloudflare deploy spec regardless (Lance's own 2026-08-03
    scoping call) — but per the correction above, it was never actually a deploy-relevant gap in
    the first place once "zero votes on the page" is replaced with the real, verified picture.
  - ✅ **SB 914 adjudication — RESOLVED and applied live, 2026-08-05.** Lance's ruling: "trust
    senate journals." Applied via a new `correct-data.js sb914-reconcile` correction (dry-run then
    live, 7 new tests, full suite green throughout): inserted a `vote_duplicates` exclusion marking
    the LegiScan row (`1adec486...`, incomplete 32-of-34 "29-0") superseded by the mo-senate-web
    primary-source row (`adf5aa8a...`, complete 28-1, Moon's NAY) — implementing CONTROLLER RULING
    3 via the existing dedup mechanism, non-destructively (neither `votes` row touched or deleted).
    Flag `214a2be0` marked resolved, with the full adjudication (who/what/why) appended into its
    own `discrepancy` JSON alongside the original evidence — verified live. This also fixed a
    second, previously-unnoticed problem found while applying it: this vote had been double-counted
    in the public aggregates (both the LegiScan and primary-source rows were live and uncounted-out
    simultaneously) — now correctly excluded to one canonical row, same as every other deduped
    cross-source vote.
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

- [x] ~~**NOW — the only thing gating Cloudflare is Lance's review queue.**~~ **(SUPERSEDED 2026-08-05: site is DEPLOYED and live at visiblegov.pages.dev — see RESUME HERE at top. This entry is dated history.)** Lance's standing rule
  (2026-07-31): *"I'm only interested in starting the cloudflare portion once the entire backend
  is locked in and accurate, otherwise I'm troubleshooting two systems back and forth."* Cloudflare
  is a MILESTONE, not a task — do not propose it until Lance says the backend feels solid.
  Remaining operator decisions, none blocking each other:
  - ✅ **4 identity flags — resolved by Lance, confirmed live.** Hank vs. Speaker Mike Johnson; Barry
    vs. Blake Moore; Dan vs. Justin Brown; the Menendez informational flag. Verified via direct REST
    read: `identity_flags?resolved=eq.false` now returns zero rows.
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
  - **Cloudflare Pages — spec brainstorming IN PROGRESS as of 2026-08-03 (Lance AFK, resume here).**
    Supersedes every earlier gameplan note below (kept, in order, for history — do not re-read them
    as current). Using `superpowers:brainstorming`; NOT yet at "write the spec doc" — sections
    presented and approved so far, two small open sub-decisions, two sections not yet presented.
    **Live product claim independently verified first** (2026-08-03, real browser via
    `scripts/serve-site.js` + Playwright, live production data, zero console errors/warnings): a
    real visitor CAN browse the directory, click into a US Senate/US House/MO Senate/MO House
    legislator, see their real recorded votes, click a bill from one of those votes, and land on
    that bill's page showing the real roll-call tally. Full loop confirmed end-to-end, not just
    code-reviewed — this was also the first-ever full walkthrough of the actual public site (closes
    the testing gap the gameplan review flagged). One non-bug found along the way: `/person/<id>`
    is for legislators merged across sources, `/legislator/<id>` is for standalone ones — mixing
    them up looks like a dead page but every real link on the site already gets this right.
    **Scope agreed:** this spec covers ONLY the two small pre-deploy fixes below + the actual
    Cloudflare Pages connection + verification. Explicitly OUT: migration `0025` (drafted
    separately, see below — independent of this spec, not blocking it), the MO House vote-coverage
    caveat (a site-content decision, not deploy mechanics — still open, still Lance's call, tracked
    on its own further down this list, not part of this spec).
    **Section 1 (scope/sequencing) — approved.** Order: (1) fix `geocode.js` headers, (2) build
    `site/404.html`, (3) connect Cloudflare Pages, (4) post-deploy verification.
    **The two small fixes — both decided, fold into the implementation plan:**
    - `geocode.js` will get its own explicit security headers (currently returns a bare
      `Response.json` with none — Cloudflare Pages Functions do NOT inherit `_headers`, confirmed
      via Cloudflare's own docs, so production `/geocode` responses carry zero CSP/security headers
      today). Real design nuance already resolved: Pages Functions can't read the filesystem at
      runtime the way `scripts/serve-site.js` does (that script live-parses `site/_headers`), so
      `geocode.js` needs its header VALUES some other way — plan is a small shared constants module
      both `geocode.js` (static import, bundled at deploy) and ideally a test can reference, to
      avoid a silent third hand-copied source of truth alongside `_headers` and `serve-site.js`'s
      own parser. Not yet built — this is the plan, section 2 of the design hasn't been formally
      presented/approved yet.
    - `site/404.html` will be built — a minimal static page, same header/nav shell, plain "page not
      found" message, link back to the directory. Not yet built.
    **Section 3 (connecting Cloudflare Pages) — presented in depth, not yet fully approved: two
    sub-decisions still open, needed before this section is done:**
    - **3a.** Does Lance already have a Cloudflare account with `helpingpeoplehelpingpeople.com` on
      it, or is this a fresh account? (Affects whether GitHub authorization is a first-time flow —
      doesn't block anything else.)
    - **3d.** Cloudflare Pages auto-builds a public preview deployment for every branch/PR by
      default. Since `site/config.js` hardcodes the real production anon key (not swapped per
      environment), every preview is a fully live copy of the real site with real data — not a
      security hole (RLS is still the actual wall), but worth a deliberate yes/no: leave default
      preview-on-every-branch behavior, or restrict preview builds to specific branches only?
    **Concrete settings already confirmed for section 3c (the actual project-creation values):**
    project name → determines the default `<name>.pages.dev` URL, pick deliberately (e.g.
    `visiblegov`); production branch `main`; **framework preset: None** (a framework preset injects
    an assumed build command that would need clearing); build command empty; build output directory
    `site`; root directory `site`; Functions auto-detected, no toggle; zero environment variables
    needed. First deploy fires automatically the moment the project is created (not a separate
    step). Custom-domain attachment is documented as a later, separate phase, not executed as part
    of this plan — domain sequencing was already decided 2026-07-28 (CHATLOG): `.pages.dev` first,
    `visiblegov.helpingpeoplehelpingpeople.com` later via the Custom Domains screen.
    **Sections not yet presented:** section 2 (the two fixes' actual implementation detail),
    section 4 (post-deploy verification checklist — a first draft already exists from the gameplan
    review, below, but hasn't gone through this design conversation yet).
    **Next step when Lance is back:** answer 3a/3d, then continue the brainstorming conversation
    (sections 2 and 4) to a full design, write `docs/superpowers/specs/2026-08-03-cloudflare-pages-
    deploy-design.md`, self-review, get his sign-off, then `superpowers:writing-plans`.
    ---
    **Migration `0025` drafted 2026-08-03 (independent of the spec above, ready whenever applied):**
    column-scopes anon access to `summaries`/`glossary_terms` (RLS already correctly restricts anon
    to published ROWS; nothing ever restricted COLUMNS — a bare `select=*` returned internal
    pipeline metadata: `model`/`prompt_version`/`bill_text_hash`/`run_id` on `summaries`, similar
    plus `source_hash`/`needs_mapping` on `glossary_terms`). Column-level `GRANT`, not a view
    rename — site/js already queries these table names directly in three files; a rename would
    require updating and re-testing all three for no added benefit. `model` deliberately stays
    public on `summaries` (bill-page.js displays it as attribution, not an internal id). ~~No
    site-code changes needed. Draft-then-apply, awaiting Lance's apply.~~ **APPLIED AND VERIFIED
    LIVE 2026-08-03** (stale "awaiting apply" wording corrected 2026-08-05). It also turned out to
    need one site-code change after all: `bill-page.js`'s summary fetch had no explicit `select=`,
    and Postgres denies a bare `select=*` outright when a role holds only column-level grants —
    that query started 401ing the moment 0025 landed, and was fixed the same pass (commit
    `9884b18`).
    ---
    **Prior gameplan review, 2026-08-03 (6-angle workflow + direct live verification) — findings
    folded into the current status above, kept here for the supporting detail:** `site/` confirmed
    current with everything shipped since Plan 3 (0021/0022/0023/0024) — no stale code, no genuine
    TODO/stub found. RLS genuinely scopes anon to published rows (live-verified pre-audit). No
    secrets/PII anywhere in `site/`. `_headers`/`_redirects` syntax valid. Zero build step, zero
    env vars needed pre-0025. Migration 0023's view-fix half confirmed functionally live already
    (re-ran the planner-cost discrimination technique the accuracy audit used — `public_votes`
    anon-planned count 52, not `votes`' full 10,355; matches the owner-bypass control, not the
    RLS-denied one) — 0023 is a documentation/reproducibility fix for the committed file, not a
    functional blocker.
    ---
    **Original 2026-07-30 gameplan, fully superseded, preserved only for history:** connect
    `lazrexmc/VisibleGov`, production branch `main`, build command EMPTY, **Root directory `site`**
    (required, or `_headers` + the geocode Function are not discovered). Verify at deploy:
    `/geocode` responds, `_redirects` rewrites survive a hard refresh, CSP headers present.

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
   1,607 rows → 37 merged persons; ~~4 identity flags remain open~~ **(all 4 resolved 2026-08-05; 0 open now)** (Lance's own decisions, not a
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

23. **The 275 undated 2024 MO House roll calls — 185 RECOVERED 2026-08-23 by a printed tally
    match, 90 stay refused.** Refused at ingest because they carry LegiScan's `0000-00-00`
    sentinel (the per-roll-call API prints it too — spot-checked live). CORRECTION of the 07-30
    premise: the House XML export serves only the current General Assembly (251 loads, 241/242
    are the HTTP-200 error page — verified in Lance's browser), so they were NEVER going to
    "arrive via house.mo.gov." The 07-30 "not derivable" check tested a perfection action, which
    prints no tally; floor passage actions in the bill history DO ("Third Read and Passed (H) -
    AYES: 108 NOES: 46", dated). Tier 1 rule (Lance, 2026-08-23): exactly one dated same-chamber
    action with the roll call's own AYES/NOES → that date, receipt stored in
    `votes.vote_date_provenance` (migration 0032). 185 match (measured by running the shipped
    rule over the cached dataset, 2026-08-23); the other 90 are refused — 79 with no action
    printing that tally anywhere in the bill's history, 10 whose tally is shared by a sibling roll
    call on the same bill and chamber, 1 whose only tallied action belongs to the other chamber.
    A stage-day inference would have reached ~84 of the 79-class; declined — "never a guess".
    **DONE 2026-08-23: Lance applied migration 0032 and the $0 session-2122 re-ingest stored all
    185 with their receipts — 30,105 casts, 0 gated, 0 conflicts, 0 unresolved casts.**

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
    ~~**Highest-priority data defect**~~ **(RESOLVED 2026-08-02: the TODO-25 session merge ran live — see NOW section; kept here as dated history.)** — it splits one session's record across two sessions on the
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

- **(2026-08-26) TOPIC TAGS on bills — idea, not a commitment.** Prompted by Lance finding
  keepinglawsimple.org/states/missouri, which does plain-English Missouri bill summaries
  (3,143 bills for 2026, sourced from MO House + Senate) and — unlike VisibleGov — appears to
  carry **no vote data at all**: no legislator profiles, no roll calls. So it answers "what does
  this bill do?" while VisibleGov answers that *and* "who voted for it, here is the receipt."
  The vote layer is the hard part and is the differentiator, not the summary.
  **NOT a data source:** no API, no download, no license stated — and ingesting someone else's
  summaries would break the one non-negotiable, since another site's prose carries no receipt
  traceable to official text.
  **The idea worth taking, legitimately and independently:** they tag bills by topic (Education,
  Healthcare, Taxes). VisibleGov does not. That unlocks a question the data can already answer but
  the UI cannot ask — *"every education bill my representative voted on."* Derivable from bill text
  we already hold, so no borrowing required. Would need: a tag vocabulary, a way to assign tags
  that respects the trust model (facts-only, receipt-bearing — a tag is an editorial act unless it
  is defensible from the text), and UI on both the bill and profile pages. Parked as an idea; the
  trust-model question is the real design work, not the tagging.


- **(2026-08-26) FULL SYSTEM AUDIT — `docs/audits/2026-08-26-system-audit.md`.** Run against the
  live DB, live site and repo on Lance's request. **Verdict: data and trust layers are sound; the
  defects are signal quality, a duplicate class, and coverage — not correctness of what is
  published.** Verified healthy: 0 of 1,112 published summaries lack a support verification (10
  lack completeness, all pre-migration-0020 and already disclosed), 0 published glossary entries
  lack quote+source, 0 orphan casts / NULL vote_dates / NULL session_ids, drafts invisible to
  anon, column scoping holds, no secrets tracked, 2,630 tests green, MO ingestion 162-163 clean
  runs in 7 days with 0 failures, and the federal "121 partial runs" streak is NOT a break
  (roll283 → 200 stored, roll284 → 404 absent: the House simply has not voted since 07-23).
  **Method warning worth keeping:** the audit's first trust-model pass reported 708 unverified
  summaries — false, caused by a `.limit(20000)` read PostgREST capped at 1,000. Paginated, the
  answer is 0. A count from a single unpaginated read is not evidence (PLAYBOOK lesson 20).
  **Gameplan, in order — item 1 DONE 2026-08-26, items 2-7 open:** ~~(1) fix signal death on
  always-partial sources~~ **DONE, live-verified.** Both stated changes shipped, and the plan was
  wrong about one thing and short by another. Wrong: the classifier ALREADY existed —
  `isExpectedTailProbeOutcome()` had been correct for months but fed only the scheduler's in-memory
  `healthy` flag, never the `ingestion_runs` row that `public_freshness` and `npm run status` show.
  Short by: a window that only probes PAST the known edge cannot tell "nothing new" from "the source
  moved" — if the Clerk changed its URL structure every probe would 404, and the new absent/failure
  split would have closed that `succeeded` with confidence. So `computeRollWindow` now starts AT the
  last roll already on file (a canary that must come back) and `findRegressedAbsences()` forces the
  tick unhealthy if it does not. Live: both federal sources ran and closed **succeeded / failures 0
  / absent 10**, canaries returning 431 and 100 casts; `npm run status` reads `us-congress
  succeeded` / `us-senate succeeded` where it read `partial` an hour before. Suite 2,645/0 (15 new
  tests). PLAYBOOK lesson 51. ~~(2) the same-source dedup~~ **BUILT 2026-08-26, dry-run verified — the `--apply` is Lance's
  one step:** `node --env-file=.env scripts/dedup-same-source-votes.mjs` (add `--apply` to write).
  Re-measuring corrected the finding badly: 217 groups / 278 rows, not 171/195, and "identical cast
  lists" is not a test of identity at all — on 2025-06-30 the US Senate cast TEN roll calls on one
  bill with byte-identical 100-cast lists, identical question and identical result, because everyone
  voted the party line every time. A cast-list rule would have hidden nine real votes. The shipped
  rule makes the SOURCE prove sameness: identical `source_url` **carrying a #fragment** (one
  anchored journal location), plus same bill/chamber/day, identical non-null result, and >=5 casts.
  38 pairs survive, all LegiScan-vs-LegiScan on MO Senate journal anchors; 179 groups are refused
  with the reason recorded. Rulings I made since they were left open: canonical = **lowest source
  record id** (not "earliest ingested" — ingestion order is not reproducible and a rebuild could
  swap which vote displays), and **auto-pair this class, flag nothing** (the refused groups are
  judged distinct, so flagging them would add 179 false items to a 382-item queue). Nothing is
  deleted; no legislator loses a vote (the cast lists are identical, so the canonical row carries
  every cast). Also corrected: this relieves **zero** reconciliation flags — the earlier "one job,
  two payoffs" claim was wrong. **APPLIED by Lance 2026-08-26 — then CORRECTED the same hour: 17 of
  the 38 pairs were FALSE and had hidden real votes.** Two causes, one error (trusting a
  discriminator without checking it discriminates): `#0` is what LegiScan emits when it has NO page
  location, so it satisfied "has a #fragment" while pinning nothing (4 pairs); and a journal anchor
  is a PAGE pointer covering several roll calls, so "Senate: Adopt Substitute" and "Senate: Third
  Reading" — two real votes, identical tally, identical members, same day — shared an anchor and the
  rule never compared `question` (13 pairs). Fixed by adding both conditions plus a `--prune` mode
  that re-derives the rule and deletes any pairing it no longer confirms; ran `--apply --prune`,
  which removed the 17 and restored those votes to public view. **Live now: `vote_duplicates` = 87
  (66 cross-source + 21 same-source), re-run is a clean no-op, 0 suspect pairs.** Suite 2,672/0.
  PLAYBOOK lesson 53. (3) Bob Onder's
  phantom MO Senate term row (no start_date, no end_date, 0 votes) renders him as a currently
  serving MO senator though he now serves in the US House — fix via a `correct-data` correction
  with a written reason, then guard: no start_date AND no votes must never read as "serving now"
  (blast radius measured: exactly 1 row of 731 open-ended terms). (4) decide the Cloudflare
  Web Analytics question, and if allowed add a line to the trust page saying what is collected.
  (5) expose `vote_date_provenance` on `public_votes` + render it (the 185 derived dates currently
  ship without their receipt). (6) coverage is a DECISION not a build — $0 waves cannot close
  2,481 bills (~526M tokens, ~35 h) vs ~$306 billed. (7) accept the 382 flags as a human queue;
  close the one orphaned `correct-data` run row stuck at `running` since 08-03.

- **(2026-08-26) CORRECTION: the reconciliation flags will NOT drain on their own — the earlier
  expectation was wrong.** After the MO Senate journal replay completed (2026-08-24), the standing
  expectation recorded in TODO/CHATLOG was that the next LegiScan tick would re-cross-check against
  the now-complete journal record, mark matched pairs in `vote_duplicates`, and let
  `scripts/resolve-matched-reconciliation-flags.mjs` close the `no_tally_corresponding_primary`
  flags in bulk. **Measured 2026-08-26, it did not happen.** The 2026-08-25T22:15 LegiScan tick ran
  AFTER the replay, processed all 604 roll calls, and produced `tally_unique_match: 3` —
  `vote_duplicates` is unchanged at 66 and open flags went UP, 368 -> 382. The resolver still
  reports 0 resolvable.
  **Open-flag composition (live 2026-08-26, 382 open):** `no_tally_corresponding_primary` 184,
  `hard_mismatch` 102, `primary_cast_data_not_comparable` 77, `soft_mismatch` 15,
  `ambiguous_tally_match` 4; by counterpart source, mo-senate-web 192 / mo-house-xml 190 — an even
  split, so this is not a one-source defect.
  **What this means:** these flags are a HUMAN ADJUDICATION queue by design (that is what the
  trust model says a flag is), plus a mechanical subset that the same-source dedup above would
  unblock. They are not a backlog that clears itself, and no future ingest tick will drain them.
  Anything that says otherwise (including the older RESUME HERE wording) is superseded by this
  entry. Do not re-run ingest expecting a different number.

- **(2026-08-24) SAME-SOURCE duplicate vote rows — 195 redundant rows, measured. A visitor sees
  one vote listed twice.** Found by answering a plain question ("what is Missouri SB 68?"): the
  2025 SB 68 page shows two Senate roll calls, both 2025-02-27, both 29-5, both
  `legiscan-2169-rollcall-*` (1501776, 1501777). Their **cast lists are byte-identical — 34 casts,
  all 34 positions the same** — and their source URLs are the same journal page and anchor
  (`RDay0227489-511.pdf#496.3` vs `RDay290227489-511.pdf#496.3`, one with a malformed day prefix).
  It is one vote the source issued two roll-call ids for. **Migration 0022's dedup cannot catch
  this class:** it pairs LegiScan against a PRIMARY source and marks the pair in `vote_duplicates`;
  both rows here are the same source, so there is no flag, no pairing, and both render.
  **Measured blast radius (whole DB, 2026-08-24):** grouping every vote by
  (bill, chamber, date, result, source) gives 368 candidate groups; comparing CAST LISTS —
  the only honest test — **171 groups are the same vote stored more than once (195 redundant
  rows: legiscan 171, mo-* 19, us-* 5)**, 185 groups are genuinely distinct votes that merely
  share a tally (correctly stored — e.g. 14 US Senate roll calls on 2026-06-04 all "Motion
  Rejected"), and 12 were skipped because a row has no casts to compare. By year: 2025 (58) and
  2026 (34) are the worst, so the CURRENT session is the most affected. Note the grouping key
  alone is NOT sufficient evidence — federal `result` is a word, not a tally — which is exactly
  why the cast-list comparison has to be the test.
  **RAISED IN VALUE 2026-08-26 — this is also a CAUSE of unresolvable reconciliation flags, not
  just a display defect.** Traced while diagnosing why the flags did not drain after the journal
  replay: for HCR 50 (MO Senate, 2018-01-08) the journal has ONE vote and LegiScan has TWO roll
  calls (684182, 684527) both printing 31-0. `crossCheckAgainstPrimarySource` cannot tell which
  LegiScan roll call the journal vote corresponds to, so it correctly refuses to pair and raises
  `ambiguous_tally_match`. All 4 open `ambiguous_tally_match` flags were checked and all 4 have
  this shape. So the same-source duplicates BLOCK pairings that would otherwise close flags —
  fixing them removes the ambiguity, not only the double render.
  **Fix shape (not built, needs Lance's go):** extend the dedup to same-source pairs that share
  bill + chamber + date + tally AND have identical cast lists, marking the later row superseded
  in `vote_duplicates` (the public views already exclude superseded rows, so the display fixes
  itself and nothing is deleted — the audit trail stays). Open questions for the design: which
  row is canonical (lowest roll_call_id? earliest ingested?), and whether a same-source pair
  should mint a reconciliation flag for review instead of auto-pairing, since unlike the
  cross-source case there is no second source corroborating that they are the same event.

- **(2026-08-23) `ingest-mo-senate.js --year 2026 --dry-run` reports "no sessions row yet for
  identifier=2026"** while the live path dedups onto the `261` session row (TODO 25 fix) — the
  dry-run report looks the session up by bare year and so reports zero votes/pending for the
  current session. Cosmetic but misleading for an operator; align dryRunReport with
  ensureSession's lookup.

- **(2026-08-23) Store non-bill roll calls.** The journal parser now classifies quorum calls,
  simple-resolution adoptions/amendments, journal amendments, and appointment confirmations as
  `nonBillVotes` (reported in run detail, never stored). `votes.bill_id` is nullable (0001: "some
  votes are procedural") but every consumer joins on bills. Decision needed: store them with
  bill_id NULL + a `kind` so legislator profiles can show confirmation/resolution votes (real
  accountability signal: SR 640 was a 23-11 contested roll call), or keep them out. Needs the
  profile/aggregate consumers audited first.
- **(2026-08-23) Scheduler: prior-year journal backlog has no automatic drain path — and the
  2018 backlog is 52 DAYS, not 6.** The ingest registry runs `ingest-mo-senate.js --year
  <current>` only. The first manual `--year 2018 --limit 1` replay (2026-08-23 05:30Z,
  RDay160131222-234: 0 votes / 3 non-bill / 0 failures, done) reported `total_pending_days: 52`
  — the 2018 session's journal days were never processed beyond the July backfill sample, so
  the five remaining quarantined 2018 days sit inside a 52-day chronological worklist that
  `--limit 1` walks in index order (a day per 30-min ToU slot ≈ 26 hours of runs). The parser
  is verified on all six offline (137/137 harness). Decision for Lance: drain 2018 fully (a
  second registry entry for the prior year that runs when it has pending days — ~2 days of
  ticks), or leave 2018 Senate floor votes to LegiScan's coverage. Not a regression; the gap
  predates today.
- **(2026-08-23) Run `scripts/resolve-matched-reconciliation-flags.mjs --apply` after the journal
  replay completes AND the next LegiScan tick has re-cross-checked** (it re-processes all 604
  roll calls daily from the cached dataset and writes new vote_duplicates pairs). Dry-run first;
  176 `no_tally_corresponding_primary` flags open at build time, 0 resolvable until then.
- **(2026-08-23) Journal parser follow-ups the fan-out surfaced but did not fix:** a two-word
  surname gap (known, carried); the 'Was taken up on a standing division vote.' taken-up
  variant (handled by the window rule, not by the EC scan); `nonBillVotes` kinds should be
  surfaced in `npm run status` / data-status.

- **(2026-08-22) Drain workflow: unknown manifest fields should THROW, not fall through to fresh
  authoring.** `summary-wave.js` picks the author branch by `preAuthored` → `reAuthor ||
  reAuthor_file` → `checkpoint_file` → fresh; an item that carries a field the running script
  does not recognise (what happened when a cached pre-edit copy received `reAuthor_file` stubs,
  PLAYBOOK lesson 47) silently authors fresh. Add a guard at the top of the author stage: if an
  item has any key outside the known set, throw with the key name. Small, TDD-able against the
  manifest shape; do it the next time the workflow is touched.

- ~~**(2026-08-22) MO Senate journal parser quarantines 2026-session days on `bill_refs` — the
  completeness-critical pipeline has a live gap.**~~ **RESOLVED 2026-08-23 (commit 5ced4eb):
  parser fixed TDD against all 20 quarantined days (137/137 blocks), every `*.failed.json` marker
  removed (0 on disk), replay in progress through the scheduler — see RESUME HERE; the flag
  re-match (`resolve-matched-reconciliation-flags.mjs`) runs after the replay.** Original
  capture: 20 days quarantined (was 12 on 08-03): 14 are
  2026 session (`26info`), 6 are 2018. Every failure record reads `category: bill_refs — "block N:
  no bill reference found in motion - needs human review"` after 3 attempts (e.g.
  `RDay6805151864-1889.failed.json`, 2026-05-15). Consequence, measured: open
  `vote_reconciliation_flags` jumped 107 → 356 (30/20/27 minted on 08-18/19/20), now 168
  `no_tally_corresponding_primary` + 101 `hard_mismatch` + 69 `primary_cast_data_not_comparable`
  + 14 soft + 4 ambiguous; 187 are `legiscan vs mo-senate-web` — LegiScan's 2026 Senate roll calls
  with no journal vote to match because the day is quarantined. Next step (its own build, on
  Lance's go): pull two quarantined 2026 journals, find the motion phrasing the
  `bill_refs` extractor misses (likely a 2026 wording change — conference reports / emergency
  clauses / "the bill" without a number), fix the parser TDD with those days as fixtures, and
  replay the quarantined days (`*.failed.json` markers hold them out; replay = delete the marker
  or use the adapter's replay path). The flags will then re-match or become genuine rulings.

- **(2026-08-23) Journal pipeline drops one senator entirely: Sen. Travis Fitzwater (MO Senate
  D10, term 2023-01-04 → open) has 0 casts on any `mo-senate-web` vote** — 234 journal votes are
  live (168 from 2026; counted 2026-08-23 ~15:00Z, the replay adds more each slot) and he
  carries 5,073 LegiScan casts, so every journal-sourced roll call
  is missing one real senator's position. Observed live during the 08-23 replay, pre-existing
  (the 08-02 session-merge note in NOW already saw "Fitzwater's yea vote present in every
  LegiScan roll call, absent from every Senate-journal-sourced one"): each replayed 2026 day's
  run record lists his casts in `unresolvedSample` as `{surname:'Fitzwater', district:null}`,
  the run's `resolutionRoster` carries 33 seats with no District 10 entry, his `legislators` row
  has `mo_senate_id: null` (the district-number identity key the adapter resolves on, migration
  0008), and a second `legislators` row `Paul Fitzwater` (no terms, 1,639 casts) shares the
  surname, so a surname-only fallback cannot pick him. Not caused by the parser fix. Next step
  (its own small build, on Lance's go): find why the roster parse yields no D10 entry, set the
  identity key, and replay — the dropped casts then resolve and the matching LegiScan
  `hard_mismatch` flags should re-match. Capture only.

- **(2026-08-22) Post-tick aggregate refresh collides with pg_cron — real, benign, UNRECORDED
  until now.** The ingest scheduler's `scripts/refresh-aggregates.js` call after a write-tick
  fails with `canceling statement due to lock timeout` on ~half its attempts (16/29, 12/28, 16/26
  per day, 08-19..21; parsed from the scheduler's own logs), always after the `mo-house-xml` tick
  at :00 — when pg_cron's `*/30` refresh holds the matview locks. Data is fine (pg_cron's refresh
  succeeded on all 184 `refresh-aggregates` rows in 3 days) but `ingestion_runs` shows NO
  failure (0027's handler gap) and `aggregatesHealthy:false` fires on half of write-ticks, so the
  flag is noisy for any future alerting. Cheap fix options: classify a lock-timeout within ~60s
  of a :00/:30 boundary as the benign "pg_cron owns this refresh" class (log, not unhealthy), or
  skip the post-tick call when a pg_cron `refresh-aggregates` row finished in the last N minutes.
  Capture only — not built.
- **(2026-08-22) docs/ refresh debt (from the full catch-up read + a 14-reader workflow; each
  verified against live state):** DISASTER_RECOVERY knows only ONE Windows task — add the
  `VisibleGov Scheduled Summaries` task, MO text ingest (`ingest-legiscan-texts.js`), the
  `backfill-*.js` family, `sync-session-dates.js`, the gloss runner, and correct "`correct-data.js
  all` runs six"; SCHEDULED_SUMMARIES lines 132/170 still say never-billed/not-registered, and it
  lacks the 08-18 corroboration stage and the 08-22 recency-first fallback + WARNING line;
  ~~CLOUDFLARE_DEPLOY Phase 4 says the subdomain is decided (it is UNDECIDED: .us / .net /
  subdomain)~~ *(struck 2026-08-23: decided `visiblegov.us` the same day this was written and
  the doc was rewritten for the apex — commit 1f44a2d)*; ARTIFACTS' cache table omits seven dirs incl. `scheduled-summaries/parked.json`
  (cost-bearing), `summary-scheduler-logs/`, `wave3/`, `gloss-batch-{mo,usc}/`,
  `openstates-people/`; RUNBOOK_SUMMARY_WAVES needs a "lane CLOSED 2026-08-18, scheduler owns
  summaries" banner; VOTERTABLES_JOIN_GAMEPLAN Phase 1 (address lookup) already shipped
  2026-08-05 — strike before Lance reviews; CONTROLLER_BRIEFING §1 still states the 08-03
  API-approval suspension as in effect (inverted by depletion + the scheduler carve-out);
  DATA_INVENTORY banner point 3 (gauge over-count) is fixed and its glossary section is
  pre-drain; both 2026-08-03 audits need a disposition table (what was fixed/refused/remains);
  no operator runbook exists for the Batch-API gloss runner or the bills catalog page. One
  bounded docs pass on Lance's go; nothing here changes code.

- ~~**(2026-08-21) `sessions.start_date` is NULL for 19 Missouri sessions**~~ **RESOLVED
  2026-08-22 (CHATLOG): it was 30 of 31, and the claim "the scheduler is unaffected (it sorts by
  text size)" was WRONG — `scheduled-summaries.js` also orders recency-first on
  `sessions.start_date`. Fixed by `src/cli/sync-session-dates.js` (30 rows written from named
  sources, run 0fb39207) plus a name-year fallback + undated-count reporting in both consumers.**
- **(2026-08-22) Session-minting drivers still write no `start_date`** — `ingest-legiscan`
  (`ensureAndPatchSessionRow`), `ingest-mo-house` (explicit `start_date: null`), `ingest-mo-senate`
  mint session rows with only identifier + name, so the next new session (January 2027 regular,
  any special) will be undated until `sync-session-dates.js --apply` is re-run. Cheapest honest
  wiring: a `scheduled-ingest.js` registry entry that runs the CLI's dry-run weekly and logs when
  it has patches, or a note in its runbook to re-run after any session-minting ingest. Until
  then both consumers fall back to the session's name/identifier year and say so.

> "I'd like to expose all the politicians by breaking down the bills and laws they propose into
> layman terms so that everyone can easily read them and their purpose and then we can all see how
> our constituents voted on said bills so we can hold them accountable as they are CLEARLY running
> amuck these days"

**2026-08-16 (Lance, next-project idea drop — cross-project, bigger than VisibleGov):**

> "my next project is to examine all of my current projects on the PC and my github repos and
> create a tool/system/process/agent that takes ideas and turns them into softwares"

Captured, not chased (per the capture-don't-chase convention). Notes for whenever it's picked
up: the raw material is the project folders on this PC (F:\VisibleGov, F:\league, F:\Pokemon,
F:\jobboard, F:\NBA2K, F:\Inoculated by the Phoenix, the MidMoConsultant folders, C4TT, the
Duarte-izer window) plus the GitHub repos; each carries a PLAYBOOK_DELTA.md / CLAUDE.md /
CHATLOG.md trail that is exactly the "how ideas became software here" evidence an
idea-to-software system would distill. The superpowers flow already used in this repo
(brainstorm → spec → plan → subagent-driven build with reviews) is a working prototype of the
process half.

**2026-08-18 (Lance, elaboration on the same idea — the modularization half):**

> "we should look at each of the items I've built and identify the 'modules' in each software
> then similar to how python has libraries and packages that can be installed, we need to turn
> our modules in to identifiable libraries or packages or inserts (whatever you want to call
> them) so that future builds would just call a package or possible a UI allowing people to
> pick up and drop packages onto a pallet/canvas and link them together to create outcomes.
> Regardless our goal is to look at the current items I have and create modulated items for
> future reference and ease of use. My own 'programming' language if you will...."

Capture notes: two deliverables hiding in this — (1) a **module inventory pass** over the
existing projects (candidate modules already visible from this repo alone: Supabase+RLS schema
patterns, ingestion adapters/CLIs, the trust-model author→verify→gate pipeline, scheduled-task
runners with ledger caps, static-site-on-Pages frontends, review-queue servers, drain-wave
orchestration; siblings add promotion gates/drift detection (league), LLM grounding DBs
(Pokemon), two-sided marketplace and ops patterns (MidMoConsultant)); and (2) a **composition
layer** — packages callable by future builds, possibly a drag-and-drop palette/canvas UI
linking them into outcomes ("my own programming language"). Inventory (1) is the prerequisite
and is cheap to start; the canvas UI (2) is a product decision for its own
brainstorm → spec cycle when this project gets picked up.

**2026-08-17 (Lance: "Look into joining VisibleGov and VoterTables and make a gameplan"):**

Gameplan written to `docs/VOTERTABLES_JOIN_GAMEPLAN.md` — PROPOSAL, awaiting Lance's review.
*(2026-08-23 note: Phase 1 is already LIVE — built 2026-07-30 (commit 9252d6c) and live since the
2026-08-05 deploy, as `site/index.html` `#address-lookup` + `site/functions/geocode.js`; the gameplan doc still proposes it, so strike
it there before Lance reviews, per the 08-22 docs-debt entry.)*
Short form: join on (chamber, district). Phase 1 = "Find my legislators" page via the free
Census geocoder (address → MO House/Senate district → existing profiles; needs NO VoterTables
data). Phase 2 = pivot VoterTables' data channel from stalled clerk outreach (43/116 counties)
to SoS precinct-level results files; port its working aggregate tables into Supabase. Phase 3 =
neutral seat-election panels (candidates, raw votes, margin, turnout) on legislator profiles.
Hard rules: voters/address PII never crosses over; mechanical neutrality on every number;
$0/month. Three open questions for Lance sit at the bottom of the doc.

Multi-faceted per Lance: (1) plain-language bill/law breakdowns, (2) purpose/intent surfaced
clearly, (3) voting-record tracking tied to individual legislators, (4) accountability - making the
above easy enough that regular people actually use it. Decomposed 2026-07-27 into the MVP design
draft — see NOW.

- **Scheduler run-row skip-list bloat (found 2026-08-17, first manual tick):** the tick's
  `ingestion_runs` detail records one skip entry per considered bill — tick c1b8fa2a carried
  2,269 of them (~800KB of JSON) because the estimate guard skipped the whole queue. Every
  daily live tick will do the same once its budget is spent (everything after the first few
  funded bills gets an entry). Not a correctness bug — the tick closes honestly — but ~250MB/yr
  of near-duplicate skip reasons into the DB. Candidate fix: collapse the skipped[] detail to
  first-N entries + a per-reason count. Captured, not chased.
- ~~**Completeness-floor catch-22 (found 2026-08-08, wave C; NOW COSTING MONEY 2026-08-17)**~~ bills with fewer than 3 substantive provisions can NEVER publish - MIN_KEY_PROVISIONS=3 forces checkers to pad with enactment boilerplate the author contract rightly omits, so every tiny bill flags on 'omitted' boilerplate. 20 support-clean tiny bills sit flagged from wave C (reviewable/approvable by hand meanwhile). **Escalation: the live billed scheduler's fresh lane is smallest-first, so its queue head is dense with 1-provision resolutions — tick d744297c paid ~$0.02-0.05 each for SRES 377/690/520/412, all record-failed on this exact floor and auto-parked; daily ticks will keep paying discovery pennies with near-zero publish yield until the tiny-bill head clears or this fix lands.** Proper fix: length-scaled mechanical floor in verifier.js assessCompleteness (e.g. <2.5k chars -> min 1; <5k -> min 2; else 3) + tests; a spec-level trust-machinery change - do it TDD with review, not inline. **DESIGN CAVEAT for that fix (learned 2026-08-17): pure length-scaling is falsified for the simple-resolution class — SRES 412 hard-failed the floor at 16,163 chars (1 provision) while SRES 532 passed at 14,354; ceremonial "whereas" bulk hides single-provision substance, so the fix needs a class-aware lens (or scale by the checker's honest yield), not raw length alone.** **STOPGAP EXECUTED 2026-08-17 (Lance: "two now, three later"): scripts/park-tiny-fresh-bills.mjs parked 688 fresh-queue bills (all sub-5k-char bills + all SRES/HRES simple resolutions) into the scheduler's parked.json with source=tiny-bill-stopgap-2026-08-17; dry-run verified lanes 2,261 -> 1,568, zero leaks, next-tick head now substantive (HB 1954 5.3k+). When the floor fix lands, unpark the whole class by deleting parked.json entries with that source value.** **RESOLVED 2026-08-18 (Tasks 1-4, commits b93a6f8..27afe0b; Task 5 rollout, this entry): the corroborated-honest-yield completeness gate lands — see
  `docs/superpowers/specs/2026-08-18-completeness-floor-corroboration-design.md`. A sub-floor
  honest yield on a >=5k-char bill now triggers an independent corroboration pass instead of an
  automatic Malformed reject; genuinely malformed (3-strike) parks are untouched. Rollout:
  drain-side `scripts/build-drain-wave.mjs` PARKED set dropped HB 606, HB 64, SB 626, HB 1607;
  scheduler-side `parked.json` dropped the same 4 plus the 4 scheduler self-parks (SRES
  377/690/520/412) and the mispremised HRES 1299 stopgap park (9 removed, 23 remaining);
  `seed-scheduler-parks.mjs` reconciled clean (`parsed_from_source: 23, added: 0`); dry-run
  confirmed zero of the 23 remaining parked ids in scheduler lanes. Full suite `# fail 0`
  (2,444 tests) before and after. No manual ticks — the unparked bills ride the normal
  smallest-first lane ordering starting with the next scheduled 6 AM tick. (The struck historical
  text above floats a class-aware lens; the spec explicitly rejected class-aware floors — the
  shipped resolution is the corroborated-honest-yield gate.)
- ~~**Verdict-binding parens mismatch class (found 2026-08-09, wave AN)**~~ **RESOLVED
  2026-08-10, commit 92816ff:** `validateVerdictBinding` now strips ONE complete surrounding
  paren pair from each side before comparing (4 TDD tests incl. real-mismatch and
  unbalanced-paren guards; suite 2,389/0). All 13 accumulated parens-class flags were
  re-recorded with --replace-drafts: 8 published (both Laken Rileys, Rescissions, DETERRENT
  among them), 5 re-flagged on real second issues the parens failure had masked. Zero
  gate-mechanics flags in the 9 waves after the fix.
- **`npm run status` "summaries draft/flagged" gauge misleading since drain campaign (2026-08-09, ~~STILL OPEN~~ RESOLVED 2026-08-16, commit c9b3560 — `scripts/data-status.js` now counts `status=eq.draft` and prints "summaries retired (superseded)" on its own line):** it counts `summaries?status=neq.published`, which includes the drafts retired to 'rejected' by --replace-drafts — reads 478 when actual open drafts are 359 (as of 2026-08-10). Fix: count `status=eq.draft` (and maybe show rejected separately). One-line change in scripts/data-status.js; PLAYBOOK lesson 36 documents the class.

- **(2026-08-26) RESOLVED — 693 misattributed vote rows retracted; the single worst public-trust
  defect the project has had.** Found by an 8-dimension adversarial audit (66 agents; 28 findings
  raised, **19 refuted by skeptics, 9 survived**), independently re-verified before any code was
  written. **LegiScan's 2023 MO dataset mints a separate `roll_call_id` per bill for ONE physical
  House floor vote** — three HB 10 roll calls each stored 232 times against 232 different bills with
  full cast lists. Our ingest was working as designed: `source_key` is the provider's roll_call_id,
  genuinely unique, so `insertIfAbsent` wrote all 232 with no error, warning, or failed parse.
  **196 bills displayed ONLY votes never cast on them, 47 with published summaries in the public
  `/bills` index**; per-legislator 2023 totals inflated ~2.3x. A visitor reading HB 114 ("Reduces
  the tax on diapers and feminine hygiene products") saw a 155-2 conference committee vote on an
  appropriations bill. **Fixed:** migration `0033_retracted_votes` (tombstone preserving the COMPLETE
  cast list, so any retraction replays backwards) + `scripts/find-misattributed-votes.mjs` (read-only
  manifest with per-group confidence) + `scripts/retract-misattributed-votes.mjs` (tombstone written
  and VERIFIED before any delete; `--limit 1` proved end to end first). Live: votes 10,879 -> **10,186**,
  casts 1,503,954 -> **1,391,226**, bills showing only phantom votes 196 -> **0**, each fan-out
  document now 1 row on HB 10, Rep. Riggs 2023 1,182 yea -> **489 yea / 37 nay**, 0 orphan casts,
  aggregates refreshed. **The guard is source-family scoped and that scoping IS the job** — the naive
  "same source_url + different bill_id" rule flags 1,101 votes of which only 693 are real (408 false
  positives, 37%), because a MO Senate journal PDF legitimately prints every roll call of a sitting;
  granularity is DECLARED per URL shape in `src/lib/source-url-granularity.js`, unknown shapes
  defaulting to permissive. PLAYBOOK lesson 54.
  **STILL OPEN, deliberately not retracted:** 4 groups where one roll call hangs off two `bills` rows
  with the SAME identifier (TODO 25's duplicate-session defect — merging the bill rows is the right
  repair, not retracting a vote), and 1 ambiguous case (`006.004.pdf`, claimed by both HB 1979 and
  SB 903 with different questions) needing review against the source PDF.
