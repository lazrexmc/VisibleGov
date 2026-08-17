# VisibleGov — CHATLOG

Word-for-word decision trail, kept from day one. This project was scaffolded from within a
LinkedUmp session (the conversation that created this repo lives in that project's own history) -
this log picks up from the point the folder was actually created.

### [Lance]
> I'd like to create another folder that will be for my next project but I want to have all the
> info from previous projects so it can quickly reference them and quickly build the next project,
> what's the best method to do so? I have projects at
> C:\Users\lance\OneDrive\Desktop\MidMoConsultant and F:\

**[Claude]** Proposed a layered method: (1) a global `~/.claude/CLAUDE.md` for domain-agnostic
personal conventions, auto-loaded into every project - created, since it didn't exist yet. (2) A
`PLAYBOOK_DELTA.md` carried forward into the new project, seeded from the lessons already
distilled in prior projects, rather than re-reading old codebases each time. (3) Leave old projects
where they are; reference specific files by path when actually needed, don't duplicate code in.

### [Lance]
> The next project I am going to build is multi-facited, I'd like to expose all the politicians by
> breaking down the bills and laws they propose into layman terms so that everyone can easily read
> them and their purpsose and then we can all see how our constituents voted on said bills so we
> can hold them accountable as they are CLEARLY running amuck these days
>
> we'll put this in the F: drive in a folder called VisibleGov
>
> The projects in the F: drive to review are Pokemon, League, Inoculated by the Phoenix,
> MidMoConsultant; NBA2K (this is an old version of League, mostly just as a backup that I'm
> probably going to delete soon as it's pretty old)

**[Claude]** Created `F:\VisibleGov`. Reviewed all five named projects: `F:\Pokemon` (TCG deck-
builder - grounding-against-a-real-database discipline), `F:\league` + `F:\NBA2K` (sports-
prediction/ingestion platform - promotion gates, drift detection, three-layer durable memory,
adversarial cross-model audits, concrete ingestion-pipeline lessons), `F:\Inoculated by the
Phoenix` (feature-film pipeline - canon + LLM_HANDOFF pattern, already partially captured via
LinkedUmp's own PLAYBOOK_DELTA lineage section), `F:\MidMoConsultant` (F: drive copy - just the
Glizzness paperwork folder, nothing new beyond what's already known from the C: copy).

Seeded `PLAYBOOK_DELTA.md` - extends LinkedUmp's existing 5-project lineage chain
(NBA2K/league → IBTP → Glizzness → LinkedUmp) by merging in Pokemon (previously a separate,
unmerged branch) and framing everything specifically for VisibleGov's actual shape: an ingestion
pipeline (bill/vote data, league's domain) that generates LLM summaries of real source text
(Pokemon's domain) with one canonical source of truth per bill (IBTP's domain). Added a
non-negotiable neutrality principle (§2) as VisibleGov's own "soul" section, given the whole
product's value depends on being trusted more than the politicians/media it's covering.

Also wrote `CLAUDE.md` (project rules + pointers to siblings for deeper reference), `README.md`
(honest concept-stage status), and `TODO.md` (raw idea captured verbatim in INBOX per
compile-don't-extrapolate; NOW = a real brainstorm/scoping pass before any code, not started yet).

git-initialized the repo and made the first commit. Nothing pushed to a remote - no remote
configured yet, that's Lance's call whenever he wants one.

---

## 2026-07-27 — Brainstorm/scoping session (the TODO "NOW" item)

### [Lance]
> proceed

**[Claude]** Ran the brainstorm via structured questions. Decisions, with Lance's answers:

1. **The gap vs existing tools** (GovTrack/OpenStates/BillTrack50) - Lance selected three:
   *bills are unreadable*, *no plain accountability view*, *nobody actually uses them*.
   Explicitly NOT selected: coverage level. Product bet = readability + one-tap accountability +
   built for regular people.
2. **Jurisdiction** - offered US-Congress-first (recommended), Missouri-first, or both.
   Lance chose **both from day one**, aware of the two-pipeline risk. Mitigation: one canonical
   jurisdiction-agnostic schema + per-source adapters.
3. **Front door:**
   > "combonation of who represents me and a legislator directory. They can look at anyone but
   > alos enter an address to see who is there reps"
4. **Trust model** - Lance chose: **he approves every summary** before publish (review queue;
   nothing auto-publishes). Second-model adversarial pre-screen deferred until volume demands.
5. **Bill scope:**
   > "I like the idea of bills with votes but we also need to see items that are in the works
   > that are upcoming that may come to vote soon"
   → mechanical trigger: recorded floor vote OR reported out of committee OR on a floor calendar.
   Everything else gets bare listings with official links.
6. **Architecture** - chose **Approach A**: Supabase + Cloudflare Pages + Node ingestion/
   summarization CLI (manual first, GitHub Actions cron later), static pre-render on publish.
   Over B (Cloudflare-native Workers cron) and C (framework SSR).
7. On the design draft, Lance's framing correction:
   > "I'd say this is a good start for an overall rough draft/overview, but there are many more
   > details inside that we'll get to eventually so don't say this is 'the exact right model so
   > far' it's a work in progress still"
   → spec explicitly marked WORKING DRAFT throughout.

### [Lance] (mid-task, while spec was being written)
> The first person we are going to check out is Bob Onder's political career

**[Claude]** Captured (not chased, per capture-don't-chase): Onder becomes the **first vertical
slice** - he spans both jurisdictions (MO General Assembly → US House MO-3 since 2025), so one
legislator page exercises both adapters end-to-end. Added to spec + TODO build queue; career
dates flagged for verification against official records during the build.

Spec written to `docs/superpowers/specs/2026-07-27-visiblegov-mvp-design.md`, self-reviewed
(fixed a trigger-rule inconsistency between two sections), committed. Awaiting Lance's review of
the spec file before writing the implementation plan.

### [Lance]
> That looks like a fair starting point, I'm sure there will be many changes in the future.
> Proceed forward.

**[Claude]** Spec approved as working draft. Scope check split the MVP into three plans
(1: foundation + ingestion, 2: summarization + review queue, 3: public site + admin). Wrote
Plan 1 to `docs/superpowers/plans/2026-07-27-slice1-foundation-ingestion.md`: 10 TDD tasks -
scaffold, typed errors + rate limiter (skip≠empty), additive-merge DB layer, full schema
migration with RLS (draft-then-apply, Lance runs it), fixture capture with Onder identity
verification against the real APIs (no memory-derived facts allowed to survive), both adapters,
dry-run-capable ingest CLI, live end-to-end verification. Blockers flagged for Lance: free
Congress.gov + OpenStates API keys, and Supabase project creation + migration apply before the
live tasks.

### [Lance]
> We need to create a git repo for this project

**[Claude]** Local repo already existed; what was missing was the remote. Renamed `master` →
`main` (flagged earlier as free-before-a-remote-exists), created **private** GitHub repo
`https://github.com/lazrexmc/VisibleGov` via `gh`, pushed. Private by default - flipping it
public later is one setting whenever Lance decides the project should be visible; going public
was not assumed. This also unlocks the Cloudflare Pages auto-deploy-on-push pattern when the
site exists.

---

## 2026-07-27 — Plan 1 execution session (Tasks 1-4 of 10)

Subagent-driven execution of the slice-1 plan. Lance chose a **feature branch in place**
(`slice1-foundation-ingestion`) over a full worktree or committing to main.

**Completed, each with an independent review pass:**
1. **Task 1 - scaffold.** ESM Node project, node:test, env template. Notable: the plan's
   `node --test tests/` fails on Node 24/Windows (MODULE_NOT_FOUND on the dir arg). The
   implementer subagent first shipped an index.js shim; the controller challenged it with a
   flawed verification (ran the suite with the shim still present), the implementer re-tested
   with the file actually absent and proved the failure was real; final fix = bare `node --test`
   default discovery (no shim, no silent-skip trap). Both lessons added to PLAYBOOK_DELTA §7.
2. **Task 2 - typed errors + shared rate limiter.** skip≠empty enforced: all fetch failures
   throw SourceFetchError/RateLimitedError.
3. **Task 3 - DB layer.** additivePatch (never overwrites set fields) + provenance run
   open/close + insertIfAbsent. 7 tests green.
4. **Task 4 - schema migration SQL.** 12 tables + RLS + seed, byte-verified against the plan by
   the reviewer, Postgres-syntax sanity-checked. NOT applied anywhere yet - that's Lance's
   draft-then-apply gate.

**Review findings deferred as minors** (tracked in the git-ignored SDD ledger at
`.superpowers/sdd/2026-07-27-slice1-foundation-ingestion/progress.md` for the final
whole-branch review): engines.node floor vs supabase-js's node>=22; untyped JSON-parse
errors in http.js; no direct fetchWithLimit tests; and one **product decision for Lance**:
`summaries.editor_notes` would be publicly readable on published rows under current RLS.

**Paused BLOCKED at Task 5:** no `.env` exists. Lance to supply Congress.gov + OpenStates API
keys (Tasks 5-9) and create the Supabase project + apply migrations (Task 10). Branch pushed.

### [Lance]
> update all documentation, commit and push. I need to restart

**[Claude]** This entry, TODO NOW-section rewrite (exact resume state + Lance's three unblock
steps), and PLAYBOOK_DELTA §7 (VisibleGov's first two own-delta lessons) - committed and pushed
on the feature branch.

---

## 2026-07-27 — Plan 1 execution session (Tasks 5-10: live keys applied, both adapters, live ingest)

Lance supplied `.env` (Congress.gov key, OpenStates key, Supabase project URL + service role
key) and applied both migration files in `supabase/migrations/` via the Supabase SQL editor,
unblocking the rest of Plan 1. Tasks 5-9 (fixture capture + Onder identity verification against
the real APIs, Congress.gov adapter, OpenStates/MO adapter, dry-run-capable ingest CLI) ran
subagent-driven with an independent review pass each; full detail is in
`.superpowers/sdd/2026-07-27-slice1-foundation-ingestion/progress.md` and the per-task reports
in that folder. Carried-forward finding from Task 7, **verified twice** (fixture, then live in
this session): OpenStates' MO 2022-session vote events have zero per-voter casts - a real
upstream data gap, not a bug anywhere in this pipeline.

### Task 10 - live ingest + end-to-end verification

Controller rulings adjusted the written plan: federal rolls **358-362/2025** instead of
120-124 (this range includes the fixture-verified roll 362; 2025 Clerk rolls top out at 362),
and Step 3 verification done **directly via Supabase REST** (service role key from `.env`,
headers `apikey` + `Authorization: Bearer`) instead of handed to Lance as SQL to run manually.

**Live run 1 - `us-congress`, rolls 358-362, year 2025:**
```json
{
  "mode": "live", "run_id": "75e71b16-07db-4b52-9c7a-912d6716d9f5", "status": "succeeded",
  "counts": { "legislators": 53, "bills": 3, "votes": 5, "casts": 2165, "failures": 0 },
  "failures": []
}
```

**Live run 2 - `mo-legislature`, session 2022, page 1:**
```json
{
  "mode": "live", "run_id": "ffe4a890-f6b8-4c68-923b-bca87383c73e", "status": "succeeded",
  "counts": { "legislators": 1, "bills": 20, "votes": 95, "casts": 0, "failures": 0 },
  "failures": []
}
```
MO casts: 0, confirmed (again, now live) as the real OpenStates gap - not a pipeline defect.
stderr logged `note: derived:slice.config` - Onder's MO record has no `current_role`/
`other_roles` upstream (retired member), so his senate/district-2 term is synthesized from
`slice.config.json`'s verified value, exactly as designed in Task 9.

**Verification via Supabase REST (a-e), all passed:**
- **(a)** `legislators?bioguide_id=eq.O000177` -> 1 row, `full_name: "Onder, Robert F."`.
- **(b)** `legislators?openstates_id=eq.ocd-person/e29b57a2-c2e7-4b5a-b299-bb734104f0d7` -> 1
  row, `full_name: "Bob Onder"` - confirmed a **separate row** from (a). This is the expected,
  known state (identity merge is queued, item 8 below), not a defect.
- **(c)** `vote_casts` joined to (a)'s legislator id -> 5 casts, one per ingested roll: 358
  yea, 359 nay, 360 yea, 361 nay, 362 yea.
- **(d)** `votes?jurisdiction_id=eq.mo-legislature` -> 95 rows; `vote_casts` inner-joined to
  those same votes -> 0 rows. Confirms the OpenStates gap end-to-end in the live database, not
  just in adapter-layer parsing.
- **(e)** `terms` for the MO legislator row -> exactly 1 row: `chamber: "senate"`,
  `district: "2"`, `start_date: null` (the synthesized term).

**Idempotency check (controller-required, closes a reviewer concern from Task 9's report):**
re-ran the MO ingest a second time (same session/page). `terms` for the MO legislator id is
still exactly 1 row, **same row id** as before the re-run - the null-`start_date`
select-then-insert path in `upsertTerm`/`findExistingTerm` does not duplicate on re-run, as
designed. `votes` for `mo-legislature` is still exactly 95 rows, no duplicates.

**Honest state going into Plan 2:** Onder is 2 `legislators` rows (federal + MO, unmerged by
design - see item 8 below). Federal roll-call accountability data is real and complete for the
5 ingested rolls (2165 individual casts). MO per-legislator voting record is **not** yet
populated for any legislator, Onder included - `vote_casts` for MO is 0 across all 95 vote
events ingested so far, a genuine upstream OpenStates gap, until either OpenStates fixes it or
a MO official-journal scraper is built (added to BUILD QUEUE, item 9).

Updated `TODO.md`: NOW section marks Plan 1 complete with the live-run summary; BUILD QUEUE
marks items 1 (ingestion half), 2, 3, 4 done and adds items 8 (identity merge) and 9 (MO
journal scraper). `PLAYBOOK_DELTA.md` untouched this session - no new time-cost lesson beyond
what Tasks 1-9 already recorded there.

---

## 2026-07-27 — Final whole-branch review + fix wave (slice 1 closed)

Final review (most capable model, full 13-commit branch diff + live-DB spot checks): verdict
**"Ready to merge - with fixes."** Every live claim re-verified against the production DB
independently. Neutrality check: clean.

**The one Critical it caught:** the Congress.gov API key rode in request URLs; a failed fetch
embeds the URL in the typed error message, which the CLI persists into `ingestion_runs.detail` -
a table our own RLS makes publicly readable. Only zero-failure runs had kept the DB clean. Fixed
at both ends (key moved to X-Api-Key header; redactUrl() strips key params from all error
messages/fields, with tests) plus two more: engines.node now truthfully >=22, and README/CLAUDE
status paragraphs updated from "nothing built yet" to slice-1 reality. Scoped re-review traced
the full leak path closed: **ALL CLEAR**, 23/23 tests, pushed (de4f7ae).

Deferred findings triaged by the final review (all OK TO DEFER) are queued as TODO build-queue
item 10; MO journal-scraper evidence strengthened to 4 sessions/305 events sampled (item 9).

Lance's mid-session question - "why 2022, and is the missing Onder MO data our fault?" -
answered with evidence: 2022 was his last full MO Senate session (payload-verified via his
sponsorships); the missing individual votes are an upstream OpenStates gap affecting all MO
legislators (raw pre-code payloads empty; same pipeline gets 433/433 federal casts; 4-session
probe). Not our bug - and the journal scraper grounds MO votes in the primary record anyway.

---

## 2026-07-27 — Summaries scope decision (post-merge)

### [Lance]
> There should be no editorial summaries here, people put their emotions into their summaries,
> we are only looking for facts. Bills proposed, votes made, votes missed, etc.

**[Claude]** Clarified which of two products this means; Lance chose **factual plain-language**:
the layman's translation stays (it was gap #1 - "bills are unreadable"), held to a hard
facts-only rule now written into the spec: every bullet traceable to a bill section, no
intent-guessing beyond the bill's own stated-purpose text, no impact characterization beyond the
text, review queue rejects anything reading as opinion/emphasis/emotion. Two additions from his
words: (1) editor_notes resolved - internal-only, never publicly readable (fixes the Task-4 RLS
finding as part of Plan 2's first migration); (2) "votes missed" is now a spec'd legislator-page
feature - bills sponsored / votes cast / votes missed as bare counts, identical treatment for
every legislator (the data already exists in vote_casts positions).

### [Lance] (mid-task, during Plan 2 scoping)
> Now that we are working on Onder's end to end line we will be able to do this with any
> representative if we capture this current process and ensure it is 100% accurate. This will
> allow us to launch the system without having to fill every single constituents information
> beforehand and the system can fill it for us as the politician is looked up for on the
> website/app by users.

**[Claude]** Captured as the launch architecture: **on-demand ingestion**. The Onder slice
becomes the verified runbook; a user lookup of a thin/missing legislator enqueues that same
process (identity verification against source APIs → vote ingestion → summary triggers) as a
background job with "record queued - filling now" UX (live fills take minutes under source
rate limits). Prerequisites queued: identity merge (item 8), generalize the Onder-specific
config fallback (item 10e), and an automated per-legislator identity-verification step
replacing the manual Task-5/7 capture. Targeted for Plan 3/4 design, not Plan 2. Also this
session: Lance chose Claude Opus 5 for the summarizer (~$0.11/bill) and a minimal local web
page for the review queue; MO bill-text path = federal-first while hunting a machine-readable
MO source (LegiScan API is the lead candidate - may also fix the MO individual-votes gap).

### [Lance] (mid-task)
> The process is two fold here, we want to be able to read the bills, but we also want to
> quickly be able to see how our representation voted on it

**[Claude]** Confirmed the two halves are structurally welded: the summarization trigger only
fires on bills WITH recorded votes, so every published summary already has its vote data linked.
Plan-2 delta from this: the review page gains a vote strip (roll-call question/result/tally
above the draft) so review happens in the same summary+votes frame the public site will show.
Plan 3's bill page pairs them for users. Plan 2 written and committed:
`docs/superpowers/plans/2026-07-27-slice2-summarization-review.md` - 9 tasks (fail-loud chamber
fix, migration 0003 incl. status-constraint update + staff-only notes + freshness view, bill-text
fetcher, Opus-5 JSON-constrained summarizer with oversize/refusal typed errors, summarize CLI
with staleness, local review server (127.0.0.1, gated transitions), E2E with Lance's live review,
golden-set drift check, MO source investigation with LegiScan as lead). New Lance gates:
ANTHROPIC_API_KEY into .env, and migration 0003 apply.

### [Lance] (mid-task)
> API calls using Claude should be approved by me so they do not get excess in this build

**[Claude]** Adopted as standing build policy, effective immediately: **no live Claude API call
runs without Lance's explicit go-ahead**, and every request for approval states the expected
call count and dollar estimate up front. The first live summarize run (3 Opus calls, ~$0.33)
had already failed harmlessly on "credit balance too low" (no spend occurred, texts were
fetched and stored, re-run skips straight to the model calls) - it will not be retried until
Lance both adds credits AND approves the run. Also recommended the mechanical version of this
policy: set a monthly spend limit in console.anthropic.com -> Billing -> Limits.

### [Lance] (at the first review gate, 3 drafts in queue)
> Fuck, I'm not sure if I'm the guy to be reviewing these. I understand what it says but I still
> have to run it through a few LLMs to get it to give me the details, pros, cons, conclusion and
> other information without a biased angle. Maybe a system from a foreign entity would be the
> best option to review the work, but it's not me. My best option is to just trust claude...

**[Claude]** Pushed back on "just trust claude" (single-model output isn't verification -
PLAYBOOK §6, and the author model reviewing itself is a conflict of interest), reframed the
human role (bullet-vs-cited-section lookup, not policy analysis), and offered three trust
models. **Lance chose: adversarial verify + he adjudicates.** Every draft now gets an
independent adversarial refutation pass (verifier model = claude-sonnet-5, deliberately
different weights than the opus-5 author; prompt instructs it to try to REFUTE each bullet
against its cited section) before human review; flags surface in the review page with reasons
and evidence quotes; Lance adjudicates flags rather than cold-reading everything; unflagged
summaries he can approve on a skim. Different-vendor verification remains a future upgrade for
stronger independence. Spec trust-model section updated; slice-2 plan amended with Task 10
(verifier + migration 0004 + review-page verification strip). Verify runs remain subject to
Lance's per-run API approval policy.

### [Lance] (mid-task, during slice-2 publish flow)
> We're really utilizing this solely so we can build a profile for each politician but we have
> to know what they are voting on and then beable to transalte that the regular person

**[Claude]** Locked in as the Plan-3 center of gravity: the **legislator profile page is the
product**; bills and summaries are its feedstock. Concretely: the profile = who they are + what
they voted on (casts incl. missed votes) + what each of those bills does in one plain-language
line (the summary pipeline's output) + bills they sponsored. The bill page exists to support
the profile (click-through from a vote row), not the reverse. This also validates the
vote-triggered summarization rule: we translate exactly the bills that appear on profiles,
nothing else. Onder's profile is already assemblable from live data: 5 federal casts + 3
verified summaries of the bills behind them + his MO term.

---

## 2026-07-27/28 — Slice 2 execution complete (summarization + review queue, live)

All 10 tasks done + review-clean on branch slice2-summarization-review (136/136 tests). The
day's live milestones, in order: 3 federal bill texts fetched from Congress.gov and stored
hash-tied; 3 facts-only summaries generated by claude-opus-5 (~$0.33, Lance-approved run);
Sonnet-5 adversarial verification of all 22 bullets — 0 flags (~$0.20, Lance-approved);
**Lance approved and PUBLISHED all 3** through the local review page (full audit trail:
3 approved + 3 published notes); goldens snapshotted and committed. Anon-key RLS probes passed:
public sees exactly the 3 published summaries + bills/votes/freshness; zero staff rows.

Review process caught and fixed 5 real defects mid-slice: stripHtml silent truncation, opus-5
thinking headroom + untyped truncation crash, approved-status duplicate-summarization gap +
batch-abort on odd text formats, review-page 500 when 0004 unapplied, CSRF on the decision
endpoint, and a Set-vs-multiset drift-check blind spot matching the real goldens' shape.
Trust-model v2 (adversarial verify + adjudicate) and the per-run API approval policy both
born this session from Lance's own calls. MO research: house.mo.gov official XML + text-layer
roll-call PDFs = primary-source path to MO individual votes (no auth, ToU-clean).

---

## 2026-07-28 — Plan 3 brainstorm (in progress, paused for the night)

Decisions so far:
1. **Launch scope: "site with votes only"** - backfill ALL remaining House rolls (free,
   rate-limited) so profiles show complete voting records with bill titles; plain-language
   summaries grow incrementally via Lance-approved batch runs (no big upfront spend).
2. **Hosting: free .pages.dev first**, then attach **visiblegov.helpingpeoplehelpingpeople.com**
   (subdomain of Lance's owned domain - one CNAME; a /path was ruled out: Pages serves
   hostnames, paths need a proxy worker + base-path rewrites everywhere).
3. **Visual companion accepted but deferred** - next session opens with profile-page mockups
   in the browser tab (Lance: "yea, we'll do that later, I'm going to bed for now").

RESUME POINT: brainstorming skill mid-flight, at the visual/layout questions for the
profile-first site. Remaining to settle: profile page layout + visual direction (mockups),
address-lookup empty-state behavior, pre-render/deploy mechanics, then spec → plan → SDD.

### [Lance] (overnight directive, 2026-07-28)
> Finish the backfill on Onder and if it is complete before I come back, move to the next
> Missouri based politician and gather their data, continuing on with US Senators and Reps from
> Missouri then onto Missouri General Assembly Members, is that agreeable while I sleep?

**[Claude]** Agreed with two boundary adjustments (zero Claude-API spend overnight per the
standing approval policy - new bills stay unsummarized until Lance approves a batch; no new
runtime deps, so MO individual-vote PDFs wait for morning). Noted that House roll calls carry
every member's votes, so the running backfill completes ALL 8 MO Reps at once, not just Onder.
Overnight sequence: (1) finish+verify House backfill; (2) build US Senate roll-call adapter
via full SDD (fixture-first from senate.gov XML, free) + backfill both 119th sessions -
unlocks Hawley + Schmitt; (3) mo-house-xml adapter XML side only, honoring the half-hour ToU
cadence; MO Senate = investigation only. Everything through the normal review gates.

### [Lance] (mid-task, during overnight P3a execution)
> I'm not entirely overly concerned about the front end web page and UI yet, I am laser focused
> on the back end information being correct, available, and up to date so that when the front
> end is finalized, the information displayed is what we want users to see.

**[Claude]** Priorities confirmed/reordered: Plan 3 (site/UI) stays parked; data correctness,
availability, and FRESHNESS are the mainline. "Up to date" adds a queued item: steady-state
incremental machinery (PLAYBOOK §3.4 startup-vs-poll discipline) - scheduled delta ingestion
(new House rolls, new Senate votes, MO cadence-respecting refresh), new-summary-candidate
detection surfaced as batches for Lance's per-run approval. Ingestion cron is free; only the
summarize/verify steps ever cost money and stay approval-gated.

### [Lance] (final messages before bed, 2026-07-28)
> I've noticed that the golden jsons reference other bills, departments or offices that aren't
> exactly clearly defined in the text when we read it, it's as if readers should know every
> single previous bill, we need a way to relay the important information from those referenced
> items to the reader so that the context is available to the reader otherwise we aren't fully
> getting to "layman's terms"

> continue that backfill, I'm really going to bed now

**[Claude]** Captured as the next summarizer evolution (prompt v2 + schema + spec change - a
MORNING design conversation, not an overnight one, because it touches the trust model): readers
need referenced-item context (what the Social Security Act sec. 1903 IS, what an agency does),
but that context is NOT in the bill text, so the facts-only rule as written forbids it. Design
space sketched for morning: (a) a separate, visually-distinct "background" content class,
clearly labeled as context-not-bill-text; (b) grounding options for it (model knowledge with
adversarial verification vs fetching referenced statute text from govinfo/US Code sources);
(c) verifier treatment for background claims. Overnight execution continues per the standing
directive: Senate wiring done (171/171), Senate backfill next once the House backfill exits,
then MO XML + PDFs.

---

## 2026-07-28 (overnight) — Plan 3a executed while Lance slept

Directive fulfilled with both promised boundaries held (zero LLM-API spend; one approved
dependency). The numbers at dawn: **365,730 individual vote positions** in the live DB.

- **US House: COMPLETE.** 645 roll calls (all of the 119th Congress to date), ~276k casts —
  every MO Representative wall-to-wall; Onder 645/645. Six "failures" = QUORUM/ADJOURN
  procedural non-bills (hygiene item).
- **US Senate: COMPLETE.** New adapter (real senate.gov LIS XML fixtures) + menu-driven ingest;
  869 votes, ~87k casts, 0 unresolved after two review-driven resolver fix rounds (diacritic
  folding for Luján; first-name tiebreak; endYear-based historical filtering that cut roster
  pollution by 2,157). Hawley 869/869, Schmitt 869/869. The Graham/SC "ambiguity" turned out to
  be a REAL mid-July seat succession (Lindsey→Darline, two-vote vacancy) — forensically
  confirmed in the final review; the resolver handled it correctly on first encounter.
- **Missouri House: pipeline proven live end-to-end.** XML adapter (bills/actions/tallies/PDF
  links) + PDF individual-vote extraction (pdfjs-dist 6.1.200 pinned, Lance-approved) with a
  hard tally-reconciliation gate — nothing unreconciled is ever stored. A real roll call
  (HB 1800, 82-61-2-13-5, 158 casts, duplicate surnames district-disambiguated) was fetched,
  extracted, reconciled, and gated into a replay artifact awaiting migrations. Durable
  cross-process 30-min ToU cooldown (fixed after a real double-fetch the controller caused and
  owned); failing-PDF quarantine; 2,099 bill stubs ingested, enrichment continuing on cadence.
- **Process:** 11 commits, every task independently reviewed, 5 fix rounds, 2 controller
  overrulings-with-evidence (both forensically confirmed by the final reviewer), final
  whole-branch review verdict YES + hardening wave + one wave-introduced regression caught by
  re-review and killed before it could ever fire. 258/258 tests.

### [Lance] (2026-07-28)
> Currently we use an API call to translate the Bills for us, why can't we use the native
> Claude/Opus I have on this machine rather than reaching out to an API?

**[Claude]** Explained and Lance affirmed ("Good call, I like it"): there is no local Claude -
the "native" one is the same hosted models via subscription billing. The pipeline stays on the
API deliberately: (1) author/verifier separation (opus writes, sonnet refutes) requires
independent pinned calls - in-session summarization would be self-grading; (2) JSON-schema mode
structurally forces section citations; (3) provenance + golden-set reproducibility need
versioned identical calls; (4) the per-run approval policy works because metered spend is
visible and gateable. Costs to date: ~$0.53 total; steady-state projection ~$100-150/yr;
**Batch API (50% off identical calls) noted as the cost lever for future bulk runs.**

### [Lance] (2026-07-28, going AFK)
> Gerat progress Claude, I have to afk for a long period of time, continue the process

**[Claude]** Autonomous continuation plan (boundaries held: no publishing without Lance, no
model spend beyond the already-approved 25-bill batch, no destructive data ops): (1) finish +
verify the summarize/verify batch, stage drafts in the review queue for his return; (2) review
the MO Senate research when it lands and — per the standing overnight directive's "then onto
Missouri General Assembly Members" — build the MO Senate adapter through full SDD if the source
supports it (zero-spend ingestion); (3) keep the MO House enrichment driver cycling on its ToU
cadence, verify the roster+HB1800 replay when its slot fires; (4) keep docs/ledger current.
Deferred to his return: publish adjudication, QUORUM/ADJOURN data hygiene (touches prod rows),
glossary design, Plan 3 mockups.

---

## 2026-07-28 (Lance AFK) — batch, MO Senate research, glossary design

Directives executed ("continue the process"; "once completed, update all documentation and move
to the glossary project"):

1. **Approved 25-bill batch: complete.** 22 new facts-only drafts in the review queue (~$4 as
   approved). Sonnet verification: 17 CLEAN, **3 FLAGGED for Lance's adjudication** (the trust
   model catching real questions), 2 pending verification (verifier output hit its 16k cap on
   many-bullet bills - one-line cap raise queued as next code item). 3 bills correctly REFUSED
   by the oversize gate (appropriations-class, up to 1.97M chars vs the 400k cap - "will not
   truncate silently"; chunking-vs-higher-cap is a queued Lance decision, ~$4/giant bill at
   full text). One controller scripting bug (trailing newline dropped the 25th bill) was
   caught, disclosed, and the missed bill run within the approved batch (verified clean).
2. **MO Senate research: complete + review-corrected.** Verdict: partial machine-readability
   (HTML-fragment endpoints + text-layer journal day-PDFs; NO XML like the House); Onder-era
   coverage VERIFIED by live 2018 payload (his name in attendance + YEAS lists, 13 votes that
   day, printed per-vote tallies usable as the reconciliation gate). Review caught a real
   accuracy defect (doc claimed full names; fixture shows bare surnames like the House) -
   corrected. Adapter build queued: harder than the House (scraped discovery, journal-block
   parsing) but no unknowns left except effort.
3. **Glossary design drafted, decision-ready** (docs/superpowers/specs/2026-07-28-glossary-design.md):
   recommended A+C hybrid - glosses generated FROM fetched official statute text (uscode.house.gov
   / govinfo, free), adversarially verified, Lance-adjudicated once, reused everywhere; model
   knowledge never a factual source. Four decisions await Lance.
4. MO House driver continues on cadence (enrichment advancing post-fix).

**Awaiting Lance:** glossary decisions; review-queue session (22 drafts, 3 flagged); giant-bill
policy; verifier-cap fix approval to re-verify 2 drafts; Plan 3 mockups.

### [Lance] (2026-07-28, returning)
> Approved to make the API calls again / What info do you need from me for the glossary

**[Claude]** Verifier-cap fix built+reviewed+merged (32k via streaming); the 2 stalled drafts
re-verified under the approved ~$0.10 — BOTH came back FLAGGED (truncation had been hiding real
findings). Queue now: 22 drafts, all verified — 17 clean, 5 flagged. Glossary: Lance resolved
all four design decisions — A+C hybrid approved; uscode.house.gov + govinfo.gov approved;
label "Background — from the referenced law's official text"; federal-first. Design doc marked
APPROVED; implementation plan next.

---

## 2026-07-28 (afternoon) — glossary implementation: code-complete, review-clean

Executed the approved glossary plan via SDD on branch `glossary-implementation` (12 commits,
922bd34..7ea596d, 424/424 tests). All six code tasks done + final whole-branch review (fable)
clean after two fix rounds. Zero LLM spend (credits exhausted anyway; every model CLI stops at
its GLOSS_RUN_APPROVED gate with cost printed first).

What shipped:
1. **Migration 0007** (draft — Lance applies): glossary_terms / summary_terms /
   glossary_verifications / glossary_notes, RLS (anon reads published only), published-
   completeness CHECK (a bare or empty-string gloss can never publish), supported_by_quote
   column, needs_mapping for unparseable citations, as-cited citation granularity.
2. **US Code adapter**: parseCitation (incl. subsection capture), official-text fetch from
   uscode.house.gov, fixture-first against the real 169,882-char 42 U.S.C. 1396b; oversize
   sections slice at the cited subsection via OLRC anchors — or typed-skip honestly.
3. **Summarizer prompt v2**: additive referenced_terms extraction; goldens unchanged by design
   (drift check still gated on credits). summarize.js now PERSISTS extracted terms at draft
   time (final review caught it discarding paid output); glossary persistence can never fail a
   summary draft — any glossary-side error becomes an honest recorded warning (backfill
   self-heals).
4. **extract-terms backfill CLI** (for pre-v2 summaries) + **glosser/gloss verifier**
   (opus-5 authors from the fetched excerpt alone; sonnet-5 refutes; completeness derived
   mechanically; verification row written BEFORE gloss so partial failures self-heal;
   rejected terms never re-enter the billable queue).
5. **Review-page glossary tab**: verification strips, needs_mapping list, CSRF-guarded
   draft→approved→published transitions, honest "0007 not applied" state pre-migration
   (live-smoked; summary queue untouched).

Notable controller rulings (full trail in .superpowers/sdd ledger): citation granularity is
AS-CITED (1396b(i) ≠ 1396b — reader-relevant, dedup only splits on real difference);
sentence-splitter ambiguity biases to over-split (noisy but honest) never silent merge;
glossary rejection means "not a real term" (skip forever) unlike summary rejection (re-draft).

### [Lance] (2026-07-28)
> The 22 summary drafts are a bit moot right now, they were part of the testing and will be
> important later but shouldn't be a central focus to move forward unless your feedback
> suggests different

**[Claude]** Agreed, no dependency: extraction reads summaries in any status, so the glossary
seed run works on the drafts as-is; gloss adjudication is its own small queue of unique terms.
Drafts demoted to "later, when publishing that batch matters."

**Awaiting Lance (in order):** apply amended 0007 → top up credits → golden drift check
($0.35, pre-approved) → extraction backfill (~$0.75) → gloss batch (count+cost stated at the
gate) → adjudicate glossary terms → merge decision on `glossary-implementation`. Product
decisions parked: re-gloss path for a rejected-with-gloss term; "(e.g. X)" over-split noise
accepted-residual; giant-bill policy; Plan 3 mockups.

---

## 2026-07-28 (evening) — MO Senate adapter complete; trust model v3; LegiScan pivot

**MO Senate adapter (branch mo-senate-adapter, 30 commits, 626/626 tests, final review clean):**
journals-first pipeline — day-journal PDFs parsed into individual votes (13/13 and 11/11 blocks
on the two real fixtures, every category reconciled against printed tallies), 2018 roster
rescued from the Internet Archive (Onder district 2 verified), emergency-clause votes attributed
mechanically from the printed taken-up line with a mandatory cross-check. THE catch of the
build: a cross-era misattribution class (district numbers reused across eras could assign a
successor's votes to a predecessor) found by an adversarial reviewer via empirical repro and
closed at FOUR channels across five fix rounds (live path, replay path, stale-cache, roster
fallback — the last found by the 16-agent final-review workflow). Migrations 0008+0009 applied
by Lance. Live backfill cycling on the 30-min-conservative cadence (closed-year caches now
never expire — half the slots had been wasted re-fetching an immutable 2018 index). CORRECTION
logged: an earlier status wrongly attributed 20 old OpenStates aggregate rows to this driver;
the driver's real vote total at that moment was zero.

**Trust model v3 adopted** (Lance: "I'm not a lawyer or a judge... that's too much time and
work for a human"): Lance is a process auditor, not a truth certifier. Verified-clean items
auto-approve AND auto-publish with per-item audit logging; he reviews FLAGGED items only.
Glossary corpus completed same day: 116 glossed across two batches (~$21 total), 104
auto-published, 8 flags in his queue, 282 popular-name terms in the honest curation queue,
4 dead citations typed-skipped. Spend hold in force since; the 1000-row-cap Critical found by
the final review (unbounded selects; 3 of 6 findings lived in two hotfix commits that skipped
task review — playbook lesson 12) was fixed before any table crossed the cap: no wrong publish
ever occurred (verified: 116/401/25 rows vs the 1000 cap).

**LegiScan pivot:** Lance registered a key; the settling probe CONFIRMED MO individual votes
populated (161 real per-person entries on a 2018 roll call; 31 sessions 2010-2026). Bulk
adapter plan drafted (11 tasks) — LegiScan becomes the PRIMARY MO path (whole backfill ≈ tens
of queries), the primary-source parsers become the reconciliation/audit layer. 6/7 design
questions ruled; Q1 (yauzl ZIP dependency) awaits Lance. Binding terms encoded in
docs/research/2026-07-28-legiscan-terms.md.

### 2026-07-28 (late) — merge + LegiScan build start

Lance chose merge option 1: `mo-senate-adapter` merged to main (`c731450`, 626/626 on the
merged result, branch deleted). LegiScan plan finalized (`419e524`, all rulings folded, Task 3
mechanically gated on Lance's yauzl-dependency approval) and SDD execution started on branch
`legiscan-bulk-adapter`: Task 1 done (migration 0010 draft — legiscan_people_id /
legiscan_session_id / legiscan_datasets / vote_reconciliation_flags; pre-flight probe found the
sessions table already carries TWO MO identifier schemes in prod ('2018' bare-year + mo-house's
'261' with 2,099 bills) → binding Task 9 ruling: resolve onto the existing row, never mint a
duplicate). Task 2 (API client core) in flight. Docs refreshed this checkpoint: README status
rewritten (was still slice-1-era), TODO items 12/16/17 closed, .env.example gains
LEGISCAN_API_KEY placeholder.

**Awaiting Lance (all non-blocking):** yauzl dependency approval (gates LegiScan Task 3);
apply 0010 when the driver tasks near; 8 flagged glosses in the review page.

---

## 2026-07-29 — LegiScan bulk adapter complete; first live slice landed

Branch legiscan-bulk-adapter, Tasks 1-10 complete (787/787 tests), every task adversarially
reviewed; Criticals caught pre-live at three layers (cross-jurisdiction identity merge,
collateral quarantine, plus the earlier 1000-row class). Key evidence findings along the way:
LegiScan structurally lacks combined-vehicle floor votes (SBs 894&921 proven; scalar FK) — the
journals-first Senate pipeline is therefore PERMANENTLY completeness-critical, not an audit
layer; LegiScan prints nicknames (Robert/'Bob' Onder), which the identity matcher uses as
exact-match variants, never fuzzily.

FIRST LIVE SLICE (session 1608, 2018 2nd Extraordinary): 8 roll calls, 1,002 individual casts
written live through every gate — 0 reconciliation failures, 0 quarantines, 0 unresolved casts,
2 API queries of 30,000. 30 people converged onto existing legislator rows (the first real
cross-source identity merges); Onder himself went AMBIGUOUS — he already had 3 rows
(bioguide/openstates/mo_senate), the matcher found two candidates and refused to guess, so a
4th (LegiScan) row was created with honest logging. Identity merge (TODO 8) is now the
highest-leverage data-quality item and gets its own plan next.

Remaining: final whole-branch review → merge menu to Lance → post-merge full 31-session sweep
(~60-70 queries, an afternoon).

### 2026-07-29 (cont.) — final review clean; gloss re-adjudication reset

Final whole-branch review (20-agent workflow): 7 confirmed cross-task-seam defects (3 Critical
— budget-ledger self-erasure, unretractable quarantines, false quarantines on partially-
ingested primaries), all execution-proven, all fixed in one wave (808/808) with the seam tests
the suite lacked. Doctrine established and fuzz-confirmed (200k inputs): machine-proven
quarantine is a null set at this data granularity — correspondence proof requires tally
agreement, contradiction requires disagreement; cross-source disputes are permanently human-
review flags with primary-wins display; retraction machinery retained as defense-in-depth.
Migration 0011 (flag idempotency) drafted for Lance. Separately: Lance's first gloss
adjudication session hit a UX trap (edits not saved before decisions) — all 8 flagged glosses
administratively reverted to draft with full audit notes for a proper second pass; reject-
confirmation UX queued.

---

## 2026-07-29 (identity merge complete)

The hardest design problem of the project — one person across five key systems — converged
after real iteration: two matcher fix rounds (dateless-same-seat gate; then the unconditional
full-name requirement after a live run wrongly merged the Symingtons/Adams/Walkers on surname
alone — caught by the mandatory post-run spot-check, fully rolled back in minutes thanks to the
virtual-merge design), a nickname-persistence amendment (0013 + 52 source-printed nicknames
backfilled from cached LegiScan archives at zero query cost) with its own two fix rounds
(pairwise printed-name-set semantics replacing transitive token bridging; writer belt aligned
to the identical function), and an audit that now shows per-cluster edge bases. Final
convergence: 6 auto-clusters (every one exhaustively human-verified same-person), 11 flags to
Lance. His adjudication: Onder LINKED (all four rows — one person, ~1,650 casts, the plan's
whole point, decided by the human as designed); 10 dynasties kept separate (one initial
mis-link of Evan+Birch Bayh, corrected on the spot and reverted — Lance's verbatim correction
is the ledgered ruling; fittingly, Evan's legal name is Birch Evans Bayh III). Controller also
logged its own error: briefly misread flag timestamps as evidence of test pollution.
Playbook lesson 13 (surname is not identity; plans state MUST conditions) came out of this.
Live state: 7 persons, 16 links, 0 open flags. Migrations 0012/0013 applied. jsdom approved
(dev-only, third approved dependency). Final review + merge menu next.

---

## 2026-07-30 (overnight) — profile completeness: the $0 night

While Lance slept: Missouri sponsorship landed in full (45,792 rows, exact dry-run match; Onder:
179 sponsored bills), the federal enrichment pass began (sponsors/status/texts + 429 parties,
437 terms in the member sweep; 428 bills continuing in background), attach-to-existing shipped
with three execution-proven Criticals fixed (incl. the machine-endorsed-Bayh-trap), and the
summary system went live on the subscription path: 8 bills authored by opus subagents, refuted
by sonnet subagents, mechanically gated — 4 published with receipts, 4 flagged on genuine
citation-precision catches, zero API dollars. The record gate rejected nothing incorrectly and
published nothing unverified. Migrations 0014/0015 applied. Final whole-branch review next;
merge menu awaits Lance's morning.

## 2026-07-30 (morning) — profile completeness: final review, two fix waves, CLEAN

Lance woke to "hows progress?"; this is the trail of what the machines did about it.

**Federal pass finished.** 476/478 federal bills have status (2 honest detail-fetch failures,
retryable), 426 federal sponsors (0 unresolved), 396 texts fetched + 11 oversize refused. The
suspicious statusPatched:0 in the relaunch was honest — an earlier partial run had already filled
statuses. DB now: 46,268 bill_sponsors, 465 bill_texts.

**Final whole-branch review (workflow, 3 dimensions → adversarial verify → synthesize): FIX
FIRST, 7 confirmed findings.** 2 Critical, both in the attach demotion path (no contradiction
veto; keep-separate rulings not threaded); 5 Important (attach keep-separate recorded no durable
fact; record gate bound verdicts by count only; stated_purpose had zero verification coverage;
--limit failed open; newline injection minted unverified public bullets). All gate-hardening —
zero live decisions had flowed through any of the holes.

**Fix round 1** (abf53e7/8b11785/1e5de42, 1180→1208 tests): all 7 closed. The scoped re-review
confirmed each closure by re-running the original attack constructions — then found 2 NEW
Importants the wave itself introduced: keep-separate on a demoted flag silently un-blocked the
cluster's own merge (next run auto-created a person, no review), and both vetoes were
surname-scoped so a Bono/Bono-Mack-shaped person couldn't veto. Controller ruling per the
asymmetric-cost law: ambiguity never resolves toward a merge — demoted-origin flags record the
candidate×candidate pairs too, keeping the cluster in Lance's queue.

**Fix round 2** (83dec75/e2eb637, 1220/1220): origin markers distinguish the two attach-flag
producers; vetoes iterate every person member; missing-row lookups throw typed; BOMs stripped.
Verification re-executed the repros end-to-end through the real HTTP route: the silent merge is
gone (clusters:0, flagged:1, Lance's own note cited), Bono Mack vetoes both paths, un-marked
legacy flags default toward blocking (recoverable) never toward merging (not). ALL CLEAR.

**Where that leaves it:** branch profile-completeness, 16 commits, suite 1220/0, final review
clean, every residual ledgered with rationale. Merge menu goes to Lance next — his decision.

## 2026-07-30 — Lance: "1" — profile-completeness MERGED to main

Menu presented after the clean final review; Lance chose local merge. Fast-forward to 522bd40,
full suite re-run on the merged tree (1220/1220), pushed, branch deleted. TODO NOW advanced to
Plan 3 (public site, profile-first) — interactive brainstorm with Lance is the next step, no
code before it.

## 2026-07-30 (evening) — the public site, built end-to-end in a day

Plan 3 executed: eleven tasks (10 build + data completeness), all through the serialized
implementer→reviewer→fix-round machinery. The site is feature-complete on branch public-site:

- **Profile pages** — identity with all affiliations, 1,850-cast paginated vote lists with
  plain-language one-liners and receipts, sponsorships, freshness boxes, and Lance's
  vote-aggregate charts (distribution + party comparison + party-line cohesion), every number
  hand-verified against the raw views.
- **Directory + address lookup** — "who represents me" works: the Capitol address returns the
  real Jefferson City legislators, the privacy contract renders verbatim, the geocode call is a
  no-logging POST pass-through.
- **Bill pages** — printed results beside recorded tallies (never reconciled), verified
  summaries with per-bullet citations and verification receipts, deterministic multi-citation
  glossary, reconciliation-flag badges.
- **Trust page** — the pipeline explained in sentences fact-checked against the code (one
  overclaim caught and rewritten), metric definitions single-sourced from the chart module,
  full attribution incl. LegiScan CC-BY and congress-legislators CC0.

Review machinery highlights: a fabricated 100% party-cohesion score caught before it ever
rendered (party-string normalization); the controller's own ruling corrected twice by reviewers
(Democratic vs Democrat; the Jan-3 date synthesis proven false against Payne's real service and
replaced, at Lance's direction, with the congress-legislators real-dates source); an address-leak
path through a *failure* branch; an XSS bypass via embedded tab; and a flag badge that could
never render, caught only because the re-reviewer executed the construction instead of trusting
a green suite. Suite: 1220 → 1686 tests.

Data landed along the way: 193 MO terms (address lookup's backbone), 441 real names replacing
bioguide codes, 893 federal terms with real service dates, at-large districts, three applied
migrations (0016/0017/0018+a). Remaining Lance items: Cloudflare console (T7), the MO
status-code correction approval, and the merge menu after the final whole-branch review.

## 2026-07-30 (late) — Lance: "I like option 1 to merge" — public site MERGED to main

0019 applied first; the extended probe went exit 1 → exit 0 (23 unpublished verification records
exposed to anon → 0; freshness reporting real finish times instead of "(never)"). Merge was a
fast-forward to c4e7320, full suite re-run green on the merged tree (1726/1726), pushed, branch
deleted local + remote. VisibleGov now holds the ingestion platform AND its public site on main.

Open for Lance: Cloudflare Pages console (root directory must be `site`); the two-item data
correction batch (MO status codes, the ten 1969-sentinel dates); the review queue.

## 2026-07-31 — after the merge: text unlock, summary volume, corrections, identity

Lance's framing for the day: **"I'm only interested in starting the cloudflare portion once the
entire backend is locked in and accurate"** — deploying earlier means troubleshooting two
intertwined systems and every change costs three steps instead of one. Cloudflare is therefore a
*milestone*, not a pending task. The rest of the day was spent earning that milestone.

**The live-site honesty bug (found by prediction, confirmed by observation).** The post-0019
verification workflow caught the freshness box oscillating: every ~30 minutes the MO Senate ingest
runs a lightweight "journal-index" slot that closed successfully but omitted the quarantine count,
and a *missing* count rendered as the affirmative "0 days pending review" while 7 were genuinely
held out. The verifier predicted the exact flip time from two TTLs, then caught it live at 01:09
with ground truth beside it. Fixed at the source (every close path — including the failure path —
now reports the standing set) and **confirmed in production at 06:09:24** on the exact run type
that used to manufacture the zero.

**MO 2024 recovered.** Root cause was operator omission, not a bug: `ingest-legiscan` takes one
`--session` per invocation and session 2122 was never invoked while its dataset sat cached with 351
roll calls. Swept all 31 cached sessions to confirm it was the only miss. 76 votes / 2,500 casts
recovered for $0. The other 275 were **refused by the date guard shipped hours earlier** — they
carry `0000-00-00`, a *second* LegiScan missing-date sentinel. Verified the real dates aren't
honestly recoverable (the sample is a 104-45 perfection vote whose bill history prints no matching
tally), and all 275 are House roll calls the primary house.mo.gov pipeline supplies *with* dates.

**The text unlock — the day's biggest single move.** Summaries were gated on bill text: 154 of
3,341 accountability-relevant bills had any. house.mo.gov's published ToU caps automated pulls at
once per 30 minutes (18,336 House bills ⇒ ~382 days), so direct fetching was never a volume
strategy. Lance chose LegiScan's `getBillText`. Binding rule 6 turned out already satisfied — an
earlier task had fetched and read the full 43-page API manual and established no per-request rate
value exists. The pre-flight review caught three blockers before a single query: a Rule-7
double-download path, a response-identity hole where a document could be stored against the **wrong
bill** *and* permanently poison the cache, and a 429 that would have kept hammering 500 more times.
All closed, then: **bill_texts 465 → 3,630; passage-vote bills with text 154 → 3,319 of 3,341
(99.3%)**, 3,177 queries (~10.6% of the monthly cap), zero wrong-fact events. The 11 oversize
refusals (HRB 2467 at 561k chars, SRB 975 at 751k) and 1 image-only PDF are the entire gap.

**The completeness axis — "nothing false" was only half the trust story.** Lance chose it over
prompt rewrites because it protects every summary written afterward. The existing gate proved every
claim *supported*; nothing proved the summary *covered* the bill. Now a checker forms its list of
key provisions from the bill text **alone, before it ever sees the summary** (the controller sends
the bill first and the summary only in a second message), the gate re-derives the verdict rather
than believing the checker, and every cited section must actually exist in the bill. Migration 0020
stores it as its own verification row; the public receipt now says a summary was checked for
accuracy *and* coverage. A review then caught that the declared 3-7 provision bound was never
*enforced* — a checker naming one trivial provision would have earned the same receipt as a real
check. Closed mechanically.

**Summary volume at $0.** Chain proven end-to-end on HRES 1175 (7/7 supported, 7/7 covered), then
wave 1: 40 MO passage-vote bills through author → adversarial verify → two-phase completeness.
**Published summaries 11 → 37.** 12 landed in the review queue on genuine flags, 2 failed shape
validation (a stray line break tripping the newline-injection guard from the site's final review).
The gate held back everything that didn't cleanly pass both axes.

**Both data corrections, live.** The status mapping was *sourced, not remembered* — extracted from
LegiScan's own manual page 42 via the repo's own PDF extractor. Review 1 passed correction A but
proved by execution that correction B could **delete the wrong vote** on a coincidental tally match.
The fix rejected my own suggested fuzzy question-text signal (it violates this project's
zero-fuzzy-matching identity policy) and used exact set-equality on the legislator IDs who voted
yea/nay instead — strictly stronger, still exact. Live: **37,662 bills** now show real words, **10
votes** re-dated from their primary journal filenames, 0 deletions, 0 numeric codes or sentinel
dates left anywhere.

**Identity merge pass — one dynasty trap caught before writing.** All 31 proposed clusters were
"residual-only" (identical names, no contradicting seat evidence) — the exact case the code's own
comments say an operator must scrutinize. Pulled every row before trusting the audit's `ok: true`,
and found a cluster pairing **Robert Menendez Sr.** (Senator, resigned 2024-08-20) with his son
**Rob Menendez Jr.** (Representative, NJ-8) — concurrent service, same name, different chambers.
Congress.gov assigns them different bioguide IDs, so it wasn't a judgment call. Wrote a
keep-separate ruling (recorded honestly as `controller_automated`, not as Lance clicking a button
he never saw), re-ran the dry-run to *prove* the downgrade, then ran live: **persons 7 → 37**, 30
real merges, 0 wrong merges. Three honest new flags for review (Hank vs. Speaker Mike Johnson;
Barry vs. Blake Moore; Dan vs. Justin Brown). The Moore flag surfaced a ledgered latent gap:
federal House district numbers aren't state-qualified in the identity matcher's seat evidence, so
"district 1" in two states reads as one seat. It can only ever *add* flags, never silently merge.

**A mistake I own:** I pushed a red suite by chaining a commit on `grep` succeeding — and `grep`
succeeds when it finds the line reading `fail 15`. Second occurrence of the identical error in this
project. Caught it on the next command, fixed and re-pushed green within minutes, and wrote
PLAYBOOK_DELTA lesson 14 with the mechanical rule rather than an intention.

**Where it stands:** 1,465,102 vote casts · 3,630 bill texts · 37 published summaries · 37 persons ·
1,975 tests green · zero known data inaccuracies. What's left before Cloudflare is Lance's review
queue — 4 identity flags, 35 flagged summaries, 9 reconciliation flags — the one category of work
that is structurally his.

## 2026-07-31 (evening) — "I'm baffled": the data audit, and why the numbers kept moving

Lance, after a string of status reports quoting different figures: *"review the documentation to
determine if we have all of this information already and then review database and clarify what we
have then document it so we don't get confused again."*

**Root cause, and it wasn't carelessness.** An ingestion cron writes every 30 minutes. During the
15-minute audit itself, bills went 38,265 → 38,266, roll calls 9,980 → 9,981, casts
1,465,300 → 1,465,333. Every count ever typed into a doc was stale within the hour. The fix is
structural: `scripts/data-status.js` (`npm run status`) is now the single source of truth for
NUMBERS, and `docs/DATA_INVENTORY.md` is the source of truth for STRUCTURE AND MEANING — what each
number is and how they relate. Hardcoded counts were stripped from README and ARTIFACTS.

**The denominator traps** — why the same project looked like several different projects:
- "38k bills" and "39 summaries" are both true and not comparable. Most bills die in committee: only
  ~10% ever get a recorded vote, ~9% get a passage vote. Text is fetched only for voted bills, so
  text ⊂ voted — but text is NOT a subset of the passage set (311 text-bearing bills have a vote
  that isn't a passage vote). Neither set contains the other.
- "1,607 legislators / 37 persons" read as "37 identified." Wrong. Three numbers all legitimately
  mean "legislators": 1,607 source ROWS · ~1,568 distinct PEOPLE · 37 MERGE CLUSTERS. Every
  legislator is identified; a `person` exists only where 2+ source rows are the same human.
- "35 draft/flagged summaries" collapsed two axes. `status` is on `summaries`; `flagged` is a
  *verdict* on `summary_verifications`. There is no "flagged" status — of the 35, ~20 have an
  adverse verdict, ~14 are clean but unpublished, 1 unverified.
- "847 glossary terms" vs "116 published": all 731 drafts have NULL gloss_md AND NULL source_url —
  bare stubs, not unreviewed writing. 704 are blocked on an unresolvable citation.

**Vote integrity — asked directly, verified directly.** Every one of ~1.47M casts is attached to a
real legislator and a real roll call by DATABASE CONSTRAINT (NOT NULL + FK), verified zero orphans,
with a unique(vote_id, legislator_id) making double-recording impossible. 98.5% of roll calls carry
full member positions. I first reported "31% have zero casts" from a query whose 1.4M-row pagination
came back incomplete — corrected to **1.5%** via an embedded-count pass, and the 152 are two known
cases (OpenStates publishes vote events without member data; the superseded house-XML pipeline's
action stubs).

**Live defect found and fixed mid-audit:** the aggregate matviews had drifted 231 casts behind, so
33 MO senators' profile charts were under-reporting their own activity versus the vote list rendered
beside them. `npm run refresh:aggregates` closed it to zero.

**Real defects found that NOTHING had recorded** (now TODO items 25-29): the MO 2026 session is
split across two session rows and the cron is actively feeding the duplicate; 2,005 bills have NULL
title AND canonical_url (~63% of the current MO session, 3 of them already carrying a published
summary under a blank title); `legislators.party` is unnormalized at the source table so ~41.5k
casts fall out of party comparisons; 152 roll calls render a result with no names across 52 bills.

**Honest one-line summary the audit produced, and I agree with it:** the vote record is genuinely
strong and internally consistent; the plain-language layer covers a few dozen bills from 2 of 33
sessions; and the docs' numbers were stale because a cron writes every 30 minutes while docs sit
still.

## 2026-07-31 (night) — spend gates + the scheduler: three review rounds to unattended-safe

Lance: *"add the spend gate / build the schedule ingestion"* — the two quick approvals from the
operator-queue rundown. The first is 20 minutes of protection; the second is the difference
between "fresh while a chat session happens to be running" and actually fresh.

**Spend gates (commit 41936f0):** `npm run summarize` and `npm run verify` could bill the
Anthropic account with nothing in the way — the unfinished half of CLAUDE.md's own "extend that
pattern" policy. Both now carry the same mechanical gate as gloss.js
(`SUMMARIZE_RUN_APPROVED=yes` / `VERIFY_RUN_APPROVED=yes`), firing before any client is
constructed, with `--dry-run` untouched and a cost estimate printed at the gate. Passed review
round 1 untouched.

**The scheduler (3e12a1e + three fix rounds → 6cf47cf):** `scripts/scheduled-ingest.js`, the
first code in this repo built to run forever unattended. Five sources with self-computed
due-ness off the durable ingestion_runs signal. It took the full adversarial loop to make it
actually safe, and the loop earned its cost each round:

- **Round 1 (9a4eb66)** fixed the reviewer's two Criticals: a starvation spiral (a persistently
  unreachable congress.gov writes no run row → us-congress stays "most overdue" → picked every
  tick forever, starving MO and hammering congress.gov — live on day one, since federal was the
  most-overdue source at review time; fixed by honest self-recorded failure rows) and a doc that
  denied the scheduler feeds the TODO-25 session split (it does — mo-senate-web is the feeder
  and is in the registry; now stated plainly). Plus lock-ownership, timeout, lookup-isolation,
  tail-404-classification, and missing-us-senate findings.
- **Round 2 (a6d94bc)** came from the implementer's own empirical check: real legiscan runs took
  449-476s against a 480s kill budget (outlier: 53 min). Fixed with evidence-derived per-source
  timeouts (legiscan 75 min) and a lock that declares its run's allowed duration so the
  stale-reclaim can't fire mid-run.
- **Round 3 (6cf47cf)** fixed the regression MY round-1 ruling introduced: the refresh gate read
  a counts field legiscan's run records don't have — measured 0 of 52 real runs would trigger,
  on the source that writes 82% of the vote corpus. The weekly dataset would have landed with no
  aggregate refresh, silently recreating this morning's chart-drift defect every week. Fix:
  per-source predicates fixture-tested from real rows, failing OPEN. The dig also surfaced that
  two CLIs deliberately share source='legiscan' with different record shapes → TODO 33.

**Final re-review verdict: SHIP** — every finding verified against live data or runtime
execution (the reviewer ran the predicates against all 339 real ingestion_runs rows and walked
the lock staleness function through every boundary), not against the implementer's report.

**What this hands Lance:** the one-line `schtasks` registration in `docs/SCHEDULED_INGESTION.md`
(draft-then-apply — it runs forever on his machine, so he runs the command). On registration:
freshness stops depending on a chat session, the ~42-day senate journal backlog drains on its
own, federal votes get scheduled ingestion for the first time, and the manual loops retire.
Honest caveat, stated in the doc: mo-senate-web keeps feeding the TODO-25 duplicate session at
today's rate until that merge fix lands — registering before or after is his call, both safe.

## 2026-07-31 (late night) — registered: VisibleGov now keeps itself fresh

Lance registered the scheduler (his step, per draft-then-apply): `schtasks` one-liner (the doc's
original multi-line form broke silently in PowerShell — Windows 11's default terminal; doc fixed
to a single cmd-safe line), then switched the task to S4U logon ("run whether logged on or not,
no stored password") so it runs invisibly and survives reboots without login.

First live tick (22:00 local) demonstrated the whole review-hardened build at once: reclaimed the
stale lock left by a killed test run (logged pid+nonce), picked us-congress as most overdue
(unchecked for 3.5 days), probed rolls 284-293, got clean tail 404s past roll 283 — the House
hasn't voted since (August recess) — classified it HEALTHY rather than failure noise, and
correctly skipped the aggregate refresh on zero writes. Freshness no longer depends on a chat
session being open. The manual senate-journal loop drains its backlog until it exhausts, then the
scheduler owns all five sources.

## 2026-08-01 (early) — wave 2: 60 bills through the two-axis chain; published 39 → 70

Lance: *"summary wave 2, go."* Ran 60 bills (the plan queue's top 60, all passage-priority) through
the full trust chain on the $0 subagent path: opus authors from official text; sonnet adversarially
refutes each bullet; a second sonnet lists key provisions WITHOUT seeing the summary; a third
checks coverage; `summary-queue.js record` re-validates everything mechanically and decides
publish/flag itself.

**Result: 31 auto-published (both axes clean), 29 flagged into Lance's review queue, 0 rejects in
the final state, 0 bills lost.** Published total: 39 → 70. Every flagged item carries its specific
gaps (e.g. "3 covered / 4 uncovered" on HB 744), so review is a targeted read, not an audit.

Two defect classes surfaced and were fixed mid-wave, both caught by designed layers:
- **Controller hand-transcription:** I typed 10 directory names from memory into the batch-1 args
  and got all 10 wrong. The author agents each REFUSED to substitute a different bill and wrote
  nothing — "no bill text means every point would be fabricated." Fix: bill lists are now
  generated from the manifest by code, never typed. (Lesson candidate for PLAYBOOK_DELTA.)
- **Checker citation invention:** 6 completeness checkers synthesized dotted statute ranges
  ("233.295.2-3") that don't appear verbatim in the text. The grounding gate rejected all six
  whole — "the checker invented a section it never read" — before any DB write. Fix: the
  verbatim-substring rule is now stated mechanically in every stage prompt; batches 2-3 ran with
  it from the start and produced ZERO grounding rejects.

The model-label dry-run reject (envelope wants bare ids; record applies the 'subagent:' prefix
itself) was the third catch — that's what `--dry-run` is for.

Batch shape: 3 × 20 bills, ~210 subagents total, all four stages green on every completed bill.
Batch flag rates: 9/20, 11/20, 9/20 — the completeness axis is doing real work.

## 2026-08-01 (08:15Z) — the hotfix's first live run: 7 new Senate votes, 700 casts, every gate green

The post-fix us-senate probe ran on schedule: **votes 211-217 ingested** (they'd been cast since
July 28 and were sitting unfetched behind the crash), 700 casts all resolved to members, 4 bills
linked, and votes 218-220 classified with the new typed expected-miss — log reads *"3 tail 404(s)
past vote 210 — expected from the probe window, not a failure"*, healthy:true. The per-source
write-detection then fired refresh-aggregates automatically (15s), so senators' charts include the
new casts. Every layer the three review rounds built — honest failure records, healthy-partial
classification, per-source refresh gating — plus the overnight hotfix, all working together
unattended. First scheduler-driven federal Senate ingestion in the project's history.

## 2026-08-01 (afternoon) — MO House un-wedged: the 30-minute sleep was ours, not theirs

The scheduler's honest failure records showed mo-house-xml ETIMEDOUT 3-for-3. Live diagnosis
(connection table + CPU + a caught-in-the-act process) found the truth: house.mo.gov answers in
0.23s — but any run needing TWO requests slept ~30 minutes between them behind our own
per-request ToU limiter, silently. The round-2 reviewer's "historical runs took exact 1800-second
multiples" observation was this same defect, misattributed then. Fix (f692b34 + test fast-follow
84f180e, task review: SHIP): the Senate model — at most ONE live request per invocation
(pending-PDF slot → stale-list-refresh slot → single-bill slot → honest no-op), runs finish in
seconds, the durable 30-min run cooldown does all pacing. Missouri sees an identical-or-slower
request rate; the limiter stays as a tripwire that makes any future double-fetch bug fail LOUD.
Reviewer structurally proved the invariant (all three live fetchers in mutually-exclusive
early-return branches) and byte-verified the ToU machinery unchanged; the fast-follow pinned the
scheduler's write-detection predicate against the literal new run shapes. TODO 34 closed.

## 2026-08-01 (mid-afternoon) — TODO-25 closed: the actively-growing session split, fixed and verified

Lance: *"make the corrections"* → deep investigation found the fix split into two real questions
(a mechanical bill merge, and a genuine cross-source vote discrepancy this codebase already had
tested machinery to detect) → *"Run it for me."*

Two review rounds (SHIP both times — the second one forced a mid-loop failure and measured the
recovery rather than trusting the fix) preceded the live run. Result: **34 duplicate bills merged
into their canonical twins, 31 votes redirected, the duplicate session deleted, 29 real
cross-source discrepancies flagged for review, 0 failures.** Independently re-verified against
the live database after the run (not just the CLI's own report): 0 duplicate bills remain, 0
orphaned votes, 31/31 redirected votes land correctly, casts total unchanged.

The 29 flags trace to one root cause, found and confirmed during review: Sen. Travis Fitzwater's
yea vote is present in every LegiScan roll call and absent from every Senate-journal-sourced one —
a known undercount in that pipeline, not a new mystery. A second, unrelated identity defect
surfaced along the way (the MO Senate roster duplicated in `legislators`) and is now TODO 35.

Two things intentionally left open, surfaced not resolved: 29 bill pages will show disagreeing
vote pairs until the flag queue clears; and the code that created the duplicate session is
unchanged, so this is a cleanup, not yet a prevention.

## 2026-08-02 — TODO-26 closed: 1,972 blank bill titles filled, $0

Lance: *"proceed with non-usage items if you can."* Ran `backfill-bill-titles.js` live (built and
dry-run-verified 2026-08-01): **1,972 of 1,975 NULL-title bills backfilled from the cached LegiScan
datasets, 0 failures.** 3 remain — LegiScan's own cache has no title for any of them either (all
`SRM` remonstrance resolutions), correctly left untouched rather than guessed. Independently
verified against the live database post-run (NULL count 3, exact titles spot-checked correct).
Zero model calls, zero network calls, zero live-API spend — pure cached-data extraction.

## 2026-08-02 — TODO-25 root cause closed; TODO-27 closed; a real reporting bug found and fixed in 3 places

Lance: *"proceed with non-usage items if you can."* Three things landed, one of them a genuine
surprise.

**TODO-25's root cause is now closed, not just cleaned up.** `ensureSessionRow` (mo-senate-web)
ported the same year+name session resolution `ensureLegiscanSessionRow` already proved correct.
Caught the old buggy code mid-fix — it had already minted a fresh EMPTY duplicate `'2026'` session
during the gap between yesterday's cleanup and this fix landing; verified it was genuinely empty
(0 bills) before deleting it, then confirmed live that year=2026 now resolves cleanly onto the
canonical session. A review then caught that the brief's own reasoning for skipping a guard
(`SPECIAL_IDENTIFIER_PATTERN`) was actually wrong — the shared `sessions` table already holds
LegiScan-minted special-session rows this new scan didn't exclude, which would have manufactured a
false ambiguity the moment MO called an extraordinary session. Closed the same day: reverted the
fix, watched the new test throw the exact predicted false ambiguity, restored, confirmed green.

**TODO-27 (unnormalized party vocabulary) closed live: 391 `R`→Republican, 209 `D`→Democratic, 1
LegiScan blank→NULL.** Checked both edge cases by hand before writing anything — the one
`Independent Democrat` row is Joseph Lieberman's real, historically accurate affiliation
(bioguide L000304), never touched.

**The surprise: running this live exposed a real, previously-shipped bug.** The correction reported
`updated: 0` while the actual data changed correctly (independently verified: 860 Republican, exact
+391). Traced it to a hard fact about this project's Supabase endpoint — `.update().select()` never
populates the `count` metadata field, confirmed by direct probe. Two branches of the ALREADY-SHIPPED
`mo-status` correction (37,662 bills, live 2026-07-31) read this same broken field — meaning that
correction's reported per-code counts were likely always zero too, and an earlier CHATLOG entry
("the counters read post-write state") had misdiagnosed the real cause. The data itself was fine
both times (independently verified at the time and again today) — only the reporting was silently
wrong. Also found and fixed a genuinely dead concurrent-write safety check in
`backfill-bill-titles.js` (`count === 0` can never be true against `null`) — the underlying database
guard still protected the data, but the intended race detection never actually fired. Root cause of
it staying hidden for so long: the shared test fake client computed `count` MORE accurately than the
real backend does, silently proving code against a fantasy. Fixed the fake to mirror reality first —
immediately turned 6 previously-green tests red, then fixed the production code genuinely. Playbook
lesson 20 records the mechanism.

## 2026-08-02 (continued) — the requested verification pass: clean sweep, two real finds, one active production fix

Lance: *"Should we continue on or stop and perform a full audit before we continue?"* → a scoped
three-part check, not a full re-audit, before resuming TODO-28.

**Part 1 (broader count-bug sweep): clean.** Every other `count`-reading call site in the codebase
uses the reliable plain-SELECT pattern; the three sites fixed earlier today were the only real
instances.

**Part 2 (live health check of today's shipped fixes): confirmed, then found a second real gap.**
The mo-senate session-dedup fix has been exercised on 12 real scheduler ticks with zero duplicates
recreated — solid, not just test-proven. But checking whether anything could re-dirty the party
column just normalized found a genuine live risk: **LegiScan's own dataset — the primary MO bulk
source — prints bare `R`/`D` codes**, confirmed directly against the cache, while every other
active source already writes full words. Fixed at the point of insertion (`legiscan-identity.js`),
not just the historical correction, so a future LegiScan-introduced legislator can never re-dirty
the column. `correct-data.js` now imports the same mapping rather than keeping a second copy.

**Part 3 (docs-vs-DB sanity check): surfaced an ACTIVE PRODUCTION FAILURE.** `legiscan` showed
`status: failed` at 07:30 this morning — the primary MO ingestion source, not a minor path. Root
cause: yesterday's TODO-25 vote-reconciliation correction parsed a roll-call id out of a source_key
via regex (always a string); LegiScan's own live path reads the same field from JSON (a number).
An idempotency pre-check compared them with strict equality, missed a real match the database's
own type-coercing unique index correctly caught, and the race-recovery path meant to catch exactly
this failure mode used the identical broken comparison — so the error propagated instead of being
absorbed. Fixed at both ends (the comparison now coerces types; the parser now returns a real
number) and proven with a test that reproduces the exact live failure: red without the fix
(2 flags instead of 1), green with it. PLAYBOOK_DELTA lessons 20 and 21 record both findings from
this pass. Not manually re-triggered against live LegiScan to confirm — the next scheduled tick
will self-heal, and spending query budget to re-prove what a precise unit test already proves
would be wasteful.

Verdict on the original question: the scoped pass was worth exactly what it cost — found two real
issues a full README read wouldn't have surfaced, one of them actively blocking production.
Resuming TODO-28 next, as agreed.

## 2026-08-02 (continued) — TODO-28 closed: the "duplicate vote" bug was actually two different bugs

Investigating live data before writing any fix found the original framing was too simple. 167
zero-cast roll calls (up from 152 — ongoing ingestion) split into two structurally different causes:
**OpenStates contributes generic "pass"-only bill-action-log stubs** — sampled bills show as many as
16 of these against 7 real votes, no real tally, a genuinely permanent upstream gap, not pending —
while **MO House's own pipeline shows real, specific tallies already** ("93-42") with individual
casts landing later from a separately-polled PDF that updates the SAME vote row in place, confirmed
directly in the code — never a duplicate, ever.

That distinction is what the fix is built on: OpenStates noise gets hidden, but only at the whole-
bill level (never inventing a row-to-row pairing the data doesn't honestly support — the sampled
tallies never matched), and only when real data exists elsewhere on the bill to justify hiding it.
MO House's pending rows are never touched — they're real, just incomplete, and get honest wording
instead of a bare "yea 0, nay 0" line that reads as an actual outcome. Verified live via dev server
+ Playwright, not just unit tests: HR 3737 went from 4 rendered rows to 2; a mo-house-only bill kept
both its pending rows, correctly, with the new wording. Pure display fix — nothing in `votes` or
`vote_casts` was touched.

**Where the day's non-usage queue stands: TODO 25, 26, 27, and 28 all closed**, plus two real
production issues found and fixed along the way that weren't on anyone's list (lessons 20 and 21).

## 2026-08-02 (continued) — TODO 29 confirmed clean; TODO 35 was never a real defect

Working down the low-cost backlog. TODO 29 (hygiene) re-verified accurate, no action needed.

**TODO 35 (MO Senate roster "duplication") turned out to be a false alarm, and worth documenting
why.** Live investigation found 30 of 34 senate seats really do show two `legislators` rows per
`mo_senate_id` — but they're two DIFFERENT real senators, not duplicates: normal district
succession across eras (an earlier occupant's LegiScan-only row alongside the current occupant's
linked one). Scott Sifton, cited as an example of the "problem," carries zero `terms` rows — the
identity matcher correctly refuses to link him to anyone, because there's nothing to safely match
against. The Mary Coleman / Mary Elizabeth Coleman pair, TODO 35's own headline example of a
"missed unification," was already merged to one person. The one real ambiguity in this roster (Dan
Brown / Justin Brown) was already a known, open flag — untouched, exactly where it should stay.

Building the "identity merge pass" TODO 35 called for would have meant writing new automated
merge logic for a same-seat pattern that is, by design, mostly DIFFERENT people — precisely the
class of mistake (the Symington father/son near-miss) this project has been burned by before.
Verifying against live data before writing any code caught that no fix was needed at all — the
existing identity system was already right.

## 2026-08-02 (continued) — TODO-33 closed: split the `source='legiscan'` key without breaking
budget enforcement (Lance approved real Fable5 usage on this one for accuracy)

TODO-33's own original text ("split the source key") was itself incomplete, same lesson as TODO-35
above but with real stakes this time: `ingest-legiscan.js` (votes/bills) and
`ingest-legiscan-texts.js` (doc-blob text fetches) share `ingestion_runs.source='legiscan'`
specifically because both CLIs spend queries against the SAME real LegiScan account and its ONE
real 30,000/month cap. Giving them distinct labels without ALSO fixing the budget-summing math
would have been actively dangerous — each CLI's own pre-flight `getMonthlyQueryUsage`/
`assertRunUnderBudget` check would only ever see its own half of the real spend, silently letting
the combined total exceed the real cap without either CLI's own refusal ever noticing. Re-read
`docs/research/2026-07-28-legiscan-terms.md` Rule 1 before touching the budget code, per the
brief's own explicit instruction.

The fix, in order: (1) `ingest-legiscan-texts.js` writes its own `RUN_SOURCE='legiscan-texts'`
going forward; (2) `getMonthlyQueryUsage` (`src/adapters/legiscan.js`) now accepts either a bare
source string (existing callers, byte-for-byte unchanged — still `.eq()`) or an array of sources,
summed via `.in()`; both CLIs' own budget checks now pass `ALL_LEGISCAN_SOURCES` (the combined
pair), including `ingest-legiscan.js`'s own main()-only call site, extracted into a new
`runLegiscanBudgetGate` purely so it could be unit-tested directly (this repo's own established
"extract for testability" precedent). Proved the load-bearing direction explicitly, twice, in both
files: CLI A's own check refuses because of CLI B's spend, and vice versa, with a negative-control
assertion showing an own-source-only check would have wrongly let the run proceed — the exact bug
this fix closes. (3) No schema migration needed — `ingestion_runs.source` is unconstrained `text`,
confirmed against all 21 migrations. The historical-row backfill is a new `correct-data.js`
correction (`legiscan-source-split`), same draft-then-apply convention as every other correction in
that file: built ready, `--dry-run` verified against the real live DB, Lance runs the live pass.
Live-classified all 54 real `source='legiscan'` rows by detail shape (votes-number vs. counts-object)
with two exact, sourced error-string markers as a fallback for the 4 rows whose failure detail is
too generic to distinguish by shape alone — 48 stay `legiscan`, 2 relabel to `legiscan-texts`, 4
stay `legiscan` (genuine `ingest-legiscan.js` failures), 0 unclassified. (4) The scheduler's own
stale comment about a manual texts run polluting its due-ness read is corrected — that scenario
can no longer happen once the historical rows are relabeled — `SOURCE_KEYS` and the scheduler's
own registry are untouched, exactly as the brief required. (5) `public_freshness` needed no code
change, confirmed by reading the view definition directly: a plain `distinct on (source)` with no
hardcoded source enumeration.

2170 → 2192 tests (22 new, all TDD red-first), 0 fail. Full suite green before committing.

## 2026-08-02 (continued) — TODO-33 closed: the one where getting it wrong would have mattered

Lance: *"feel free to spend real Fable5 usage on this one to ensure accuracy."* Worth it — the
investigation found the TODO's own proposed fix was itself dangerous. "Split the shared source key"
sounds like a harmless naming cleanup, but that shared key exists specifically because two CLIs
spend queries against ONE real LegiScan account with a 30,000/month cap, and the budget check sums
usage per source. Splitting the label without also fixing the summing logic would have let each
CLI's own pre-flight check see only half the real spend — a real path to exceeding a suspension-
level term without either side noticing.

Built with that fully understood: the split happens for freshness/scheduling accuracy, the budget
check now sums across both labels, proven in both refusal directions with an explicit adversarial
test. A 54-row historical backfill (built ready, not run live) correctly classifies every single
row — including four ambiguous failures resolved by reading their actual error text for markers
only one of the two CLIs' code paths could ever produce.

Independent review didn't take any of that on faith: hand-traced the real production call sites,
hand-computed both budget scenarios with real numbers, and independently re-derived the historical
classification from a script written from scratch against the live database — exact match. SHIP.

**The day's full tally: TODO-25, 26, 27, 28, 29, 33, 35 all closed or corrected, two unlisted
production issues found and fixed, zero data ever at risk.** The backlog from yesterday's audit is
clear.

## 2026-08-02 (later) — Lance: "I cannot process 106 summaries" — the review queue backfill

Lance's honest pushback: *"i cannot process 106 summaries, I don't have the time or knowledge. All
I can viably do is click accept and publish but that violates my program's intent."* Correctly
diagnosed, not dismissed — 106 real items is not a meaningful human-review workload, and rubber-
stamping would violate the project's own facts-only/verified principle. Investigated the actual
composition rather than answering in the abstract: of the 106, 15 needed zero judgment at all —
summaries that only ever went through ONE verification axis (14 completeness-only, pre-dating the
completeness axis; 1 fully unverified) because the axis literally never ran, not because it failed.
Running the missing check is mechanical, not a review decision — Lance approved running it ("yes").

Built a backfill: reused `parseBullets` (`site/js/summary-parse.js`) to extract `{point, section}`
bullets from each summary's real rendered `body_md` (a wrong assumption that `body_md` was raw JSON
was caught before anything ran — a live row showed it's markdown). Dispatched the completeness
axis's own two-phase contract (`src/lib/verifier.js`) via the $0 subagent path: phase 1 (key
provisions, bill text only, zero summary knowledge) then phase 2 (coverage, given phase 1's own
list back) — plus a support-verify dispatch for the one fully-unverified summary (SB 1019). Every
phase-1 output was mechanically grounding-checked (the same whitespace-collapsed substring rule
`assessCompleteness` enforces) before being trusted: 4 of 15 failed on the first pass, all the same
defect — a checker concatenating a section heading and a subsection label with a `" -- "` separator
it invented, never a real bill-text bytes. Retried those 4 with an explicit warning against that
exact mistake; all 4 passed clean on retry. This is the same citation-invention class documented
earlier in this file (six checkers synthesizing statute ranges) — the grounding gate keeps catching
it, which is the point of having it.

`summary-queue.js`'s own `record`/`classifyRecordItem` couldn't be reused directly — its
`alreadySummarized` short-circuit exists specifically to refuse re-recording a summary that already
has a live draft, which is exactly what every one of these 15 already is. Wrote a small adapter
script that reuses every trust-critical primitive UNCHANGED — `assessVerdicts`, `assessCompleteness`,
`validateVerdictBinding`, `checkStatedPurposeGrounding`, `autoPublishSummary`, and the project's own
`getClient()` (real supabase-js, not a hand-rolled REST stub, so `autoPublishSummary`'s
`.from().update().eq()` chain behaves exactly as it does in production) — and never re-derives or
paraphrases their logic. `--dry-run` first, live run second, byte-for-byte matching output.

Result, mechanically derived, never taken on the subagents' own "DONE, N/M covered" word: **8 of 15
published outright** (both axes independently clean/complete), **7 joined the review queue with a
named, specific reason** (which key provision the summary omits — a citation-lookup-sized task, not
a re-analysis), **0 malformed, 0 gate failures**. Verified post-write against the live DB: 8
`status=published` with both `support:clean` and `completeness:complete` rows; 7 still `draft` with
an honest `completeness:incomplete` row naming what's missing. Review queue: 106 → 98 real items
left, all now the genuinely-judgment-requiring kind trust-model v3 was actually designed for.

## 2026-08-02 (later still) — bullet citation exposure: designed, reviewed, built, migration awaits Lance

Lance: *"I'd really like to create a system where humans are not presenting the information but
also a system where the information is always accurate and humans can not refute it as stated."*
Real tension surfaced immediately: quote-only display is maximally unrefutable but fights the
project's actual mission (plain language for people who can't parse a bill's own prose). Lance's
call: *"It is more important for people to be able to understand the bill."* Resolution: keep the
paraphrase primary, put the exact quote one click away — the receipt `trust.html` already claims
every published fact carries, but which the bill page never actually rendered for `what_it_does`
bullets (only glossary terms had it). Checked before proposing anything: not built, not even on the
internal staff review page — `evidence_quote` (verifier.js's own per-bullet field) sat in
`summary_verifications` unused since the day the completeness axis shipped.

Brainstormed to a written spec (`docs/superpowers/specs/2026-08-02-bullet-citation-exposure-
design.md`), then Lance asked for a Fable 5 adversarial pass before proceeding — found two real
holes in the first draft, not stylistic nits. (1) The safety claim "published implies clean" isn't
mechanically true: the staff review server's manual publish button — the review queue's own only
exit for ~100 flagged items — never checks verification at all, so gating public exposure on
`status='published'` alone would let a manually-published flagged summary's *contradicting* quote
render as if it supported the bullet. Fixed by gating the new `citations` column on
`overall='clean'` directly, in the view itself. (2) Two live published summaries already have small
formatting drift between `parseBullets`' extracted section text and the verifier's own recorded
`section` string — confirms the lookup must key strictly on `bullet_index`, never cross-check
section text. Logged as PLAYBOOK Lesson 22: gate on the actual invariant, never a status flag more
than one writer can set.

Lance: "make the implementation." Plan written (`docs/superpowers/plans/2026-08-02-bullet-citation-
exposure.md`), executed inline, TDD throughout: migration 0021 (draft file only — never applied,
per standing convention), a new `checkCitationsShape` pure validator in
`scripts/probe-public-surface.js` encoding all three Fable-5-reviewed gating rules (11 new tests),
the `buildCitationToggle` UI in `bill-page.js` mirroring the glossary quote-toggle pattern exactly
(accessible: tabIndex, role=button, aria-expanded, click + Enter/Space) with a defensive fallback
to today's plain span for any bullet with no matching citation, and matching CSS. 2192 → 2205 tests,
0 fail, gated on the extracted `ℹ fail` line at every commit. **Nothing left but Lance's own step:**
apply the migration, run the probe script to confirm it live, done.

## 2026-08-03 — "0021 has ran in supabase"; then: review the folder and decide what's next

Migration confirmed live — probe script green (220 rows, 0 shape/gating violations), a live spot
check via the anon key showed real verbatim quotes flowing through with only the three intended
fields (no `reason`, no `supported`). Bullet-citation-exposure closed for real, not just "code
complete."

Lance: "review the folder, the chatlog, the context and playbook and determine what should be
next." Fresh live check (`npm run status`, `scripts/scheduled-ingest.js`'s own due-ness constants)
rather than trusting memory: the `legiscan` source that looked "stuck" in yesterday's report turned
out not to be — its due interval is a deliberate 24h (datasets refresh weekly; LEGISCAN_MIN_INTERVAL_MS),
so 17 hours since the last failure was well inside normal, not a stall; the roll_call_id fix from
2026-08-02 will take effect on its own next tick with no intervention needed. Everything else open
turned out to be either Lance's own judgment (identity flags, 98 summaries, 31 glossary terms) or
dormant technical debt (TODO-31 MO House cross-era trap, TODO-32 `summarize.js`'s uncapped
`.select()` — both filed into `TODO.md` for the first time, verified still open by direct code
read, not assumed). One genuinely un-filed accuracy defect surfaced and confirmed by grep: the
"primary-source row wins for display" dedup ruling was decided but never built — 106+ roll calls
duplicated across adapters, inflating vote-aggregate percentages on live pages.

Lance chose to build the severity-sorted review view (offered twice before, now approved) over
fixing the dedup defect. Investigated `src/review/server.js` before designing anything: the
summaries queue was a bare `<select>` in `created_at` order with no severity signal at all, and —
more importantly — completeness data (which provision is missing) was **completely unreachable**
from this server, even after opening an item; `isSupportShapedVerification`'s own filter discarded
every completeness row outright. Two clarifying questions settled the shape (show the count
directly, enhance the existing dropdown rather than rebuild it as a table) before writing the spec.

Spec written, self-reviewed — caught and fixed my own wrong claim mid-review that no HTTP-level
test harness existed for this server; `tests/review-logic.test.js` already has exactly the right
one (`withServer`/`fakeClient`, existing `SUPPORT_ROW`/`COMPLETENESS_ROW` fixtures) and the plan was
rewritten to use it instead of proposing a weaker pure-function-only test story. Lance: "Move
forward with the project and complete it from spec to implementation" — spec → plan → all three
tasks executed inline, TDD throughout (2205 → 2221 tests). Two pre-existing exact-`deepEqual` tests
needed their expected shape updated for the new additive fields (`issue_count`,
`missing_provisions`) — not a regression, just what adding fields to a strictly-asserted response
does.

Manual smoke test caught a real process-hygiene issue before it could mislead anyone: a stale
review-server process from earlier in the session was still holding port 8991, so the first
Playwright/curl checks against "the new code" were actually hitting old code and showed
`issue_count` missing entirely. Killed the stale PID, restarted clean, re-verified against the real
live 98-item queue via Playwright: sort order correct (0 issues first, 6 last), single-issue items
correctly name their missing provision inline, item detail view matches the queue's own data. No
schema change — live the moment the code shipped, no migration, no handoff step for Lance at all.

## 2026-08-03 (continued) — "0021 has ran in supabase"; the dedup defect, from spec to implementation

Migration 0021 confirmed live: probe green (220 rows, 0 violations), a live anon-key spot-check
showed real verbatim quotes flowing through with only the three intended fields. Bullet-citation
exposure fully closed.

Lance: "review the folder... determine what should be next." Fresh check (not memory): git HEAD
unchanged since last review, live data healthy, `legiscan`'s apparent stall was confirmed to be
inside its own deliberate 24h retry interval, not a real problem. The one un-filed accuracy gap
from the prior review — the display-time dedup ruling, decided 2026-07-29, never built — was still
sitting there. Lance chose to fix it.

Research before design (a dedicated agent, since this touches SQL schema, live ingest code, and a
carefully-reviewed cross-check function): the `votes` table carries no direct source/adapter
column, only an unenforced `source_key` prefix convention; the ~100+ duplicate-group figure from
the last review turned out to be an unpreserved estimate, not a documented fact — flagged rather
than restated as certain. More importantly: the vote-aggregate matviews join `votes`/`vote_casts`
with zero source discrimination, so a duplicated real vote is counted TWICE in every percentage —
not just shown twice in a list, an actual accuracy defect in the numbers themselves. Lance: fix
both the display and the aggregates, not just one.

Design mirrors this codebase's own non-destructive precedent (`persons`/`person_links`, migration
0012) rather than the one sanctioned delete (`retractLegiscanVoteIfStored`, scoped to genuine
LegiScan-vs-primary CONTRADICTIONS, a different case entirely): a new `vote_duplicates` grouping
table, neither row ever touched, detection reusing `crossCheckAgainstPrimarySource`'s existing
matching logic rather than a hand-rolled second comparison.

Two real bugs found live, caught by TDD rather than assumed away:

1. **A third clean-match branch, missed by grep.** The original design found `crossCheck.reason ===
   'tally_unique_match'` via a literal string search — but `crossCheckAgainstPrimarySource` has a
   THIRD `matched: true` return site (the plain singleton/singleton clean match, the most common
   case in practice) that has never set a `reason` at all. A reason-string gate silently skipped it
   entirely. Caught by a real ingest-level test against real fixture data (roll call 774411, HB3
   senate) — the LegiScan vote stored correctly but zero `vote_duplicates` rows appeared. Fixed by
   gating on `matched` (set on every clean branch) instead of `reason`, and by adding a direct unit
   test for this specific branch so it can never silently regress again.
2. **`correct-data.js` has its own tested architectural boundary this design initially violated.**
   An existing test asserts, unconditionally, that this file never imports or calls
   `crossCheckAgainstPrimarySource` — that function is a live pre-store gate that writes
   `vote_reconciliation_flags` as a side effect, which a backfill against already-published data has
   no business triggering. This file's own existing 1969-sentinel-date correction already
   established the correct pattern for exactly this situation (reuse the pure comparison
   primitives, reimplement the orchestration locally) — the backfill correction was redesigned to
   match it. Found two further shape bugs while rebuilding: `compareTalliesForCrossCheck`'s
   LegiScan-side tallies need all four cast buckets or the soft-comparison silently produces `NaN`;
   its primary-side tallies need `summarizePrimaryCastPositions`'s own distinct field shape, not the
   same four buckets as the LegiScan side.

Plan document corrected in place after each finding — not left describing what was originally
assumed rather than what was actually built. 2192 → 2235 tests (43 new), 0 fail throughout, gated
on the extracted `ℹ fail` line at every commit. Migration 0022 is draft-then-apply, same as every
schema change in this repo — Lance applies, runs the probe, runs the backfill, refreshes the
aggregates twice (before and after the backfill).

## 2026-08-03 (continued) — 0022 errors live, doc-refresh verification, legiscan bug root-caused

Lance ran migration 0022 and it errored: `42809: "public_position_totals" is not a view. HINT: Use
DROP MATERIALIZED VIEW to remove a materialized view`. Then, mid-turn: "I'm going afk, make the
needed corrections and provide me with the updated sql's to run."

Root cause: two stray `drop view if exists ... cascade;` lines (for `public_position_totals` and
`public_party_alignment`) right before the correct `drop materialized view if exists ... cascade;`
line — both objects are materialized views (created by migration 0018), and Postgres's `DROP VIEW`
refuses that even with `IF EXISTS` since the object exists but is the wrong kind.
`public_party_position_totals` never had this bug — it only ever had the single correct line, which
is why the error stopped exactly where it did (first bad statement, first matview, alphabetically
first in the file). Fixed by deleting both stray lines; the `drop materialized view` lines already
present one line below each did not need to change. Before handing back the corrected file,
queried the live database directly (Supabase REST, service-role key) to confirm the failed run
rolled back cleanly as a single transaction: `vote_duplicates` and `public_votes` don't exist
(404), `public_vote_feed` and all three matviews are sitting untouched at their pre-0022
definitions. Nothing partial — the corrected file (committed `1858195`) is safe to run as-is, no
cleanup needed first.

While Lance was away, two background agents (dispatched earlier for "update all documentation... "
had finished refreshing `docs/DATA_INVENTORY.md`/`docs/CONTROLLER_BRIEFING.md` and
`docs/ARTIFACTS.md`/`docs/SCHEDULED_INGESTION.md`, but neither diff had been personally reviewed
yet — this project's own "never trust a subagent self-report" rule. Ultracode is on this session
("optimize for the most exhaustive, correct answer... use the Workflow tool on every substantive
task"), so both verifications plus a from-scratch investigation into an open legiscan production
bug ran as one 8-agent Workflow: two independent reviewers re-verified each doc diff against live
ground truth (re-running `data-status.js`, `probe-public-surface.js`, `node --test`, raw Supabase
REST queries, and the scheduler's own logs rather than trusting the diffs' prose); in parallel,
three independent investigators attacked the legiscan bug from different angles (live-data
forensics, static code-path audit, git-history audit), blind to each other; a synthesis agent
reconciled their reports into one root cause; a fix agent verified it; an adversarial reviewer
independently re-checked everything before a SHIP verdict.

**Doc verification result: one real, concrete error caught.** `CONTROLLER_BRIEFING.md`'s
2026-08-03 refresh-pass note claimed PLAYBOOK_DELTA was "still 22 lessons, unchanged since the
2026-08-02 pass, checked directly" — false. Live `grep '^## Lesson'` plus the unnumbered §7 items
gives 24: Lessons 23-24 landed the *same day* as this refresh pass via a sibling commit (`ebb07a3`,
the vote-dedup work's own doc pass), directly contradicting a claim explicitly labeled as
independently verified. Corrected before commit. Everything else in both diffs (funnel counts,
matview row counts, migration list, SDD ledger count, file sizes, the API-spend-suspension note,
the legiscan-failure description itself) held up exactly against direct live re-verification — no
other fabrications, no placeholders.

**Legiscan bug: root-caused, and it turned out to already be fixed.** The production failure
(`vote_reconciliation_flags_dedup_key` duplicate-key violation, run `d56bf115`,
2026-08-02T07:30:03Z) was a real application bug, not the scheduler doing its job — an earlier
same-day assurance in conversation that legiscan was "just waiting out its 24h interval, no action
needed" was incomplete, and that gap is what triggered this investigation rather than trusting the
earlier reassurance. Triangulated root cause: a type-blind `roll_call_id` comparison (JS string vs.
number) in `findExistingReconciliationFlag` (`src/adapters/legiscan-votes.js`) let a pre-existing
string-typed flag row slip past the in-memory idempotency pre-check; the INSERT proceeded and hit
the database's own type-tolerant unique index (`(discrepancy->>'roll_call_id')::integer`), which
the JS-level check didn't mirror. This is a recurrence of PLAYBOOK_DELTA Lesson 21 surfacing in a
spot the original fix didn't cover, not a new bug class. The fix agent found the fix had *already*
landed on `main` same-day, ~3 hours after the crash (commit `b1adbfa`) — reverted just the
`Number()` coercion, reran `tests/legiscan-votes.test.js`, watched it genuinely fail (`2 !== 1`,
the exact bug), restored it, watched it pass again; no new commit needed. The adversarial reviewer
independently re-derived the same mechanism from the raw code and the DB migration, re-ran the
red/green check itself, queried live production directly and confirmed the fix holds against all
29 currently-live string-typed rows in `vote_reconciliation_flags`, confirmed `writeReconciliationFlag`
is the only insert path into that table (no bypass), and reproduced the full suite (2235/2235)
twice. Verdict: **SHIP**, high confidence for the next scheduled retry (~2026-08-03T07:30Z). Two
non-blocking follow-ups surfaced and were deliberately left untouched pending a separate decision:
an `ORDER BY`-less candidate query at `legiscan-votes.js:628-634` (latent nondeterminism, unrelated
to this bug), and disagreement between two investigators on which specific row supplied the
colliding string-typed partner in the actual crash (doesn't affect the fix's correctness — it's
structural/symmetric — but the attribution itself is an open loose thread, not asserted as solved).

All four doc files committed together (`c2ab5a5`) after the correction. `TODO.md` NOW and this
entry record both fixes. Nothing here required Lance's input or unblocks anything new for him
beyond what was already pending (apply 0022, the corrected SQL already in hand) — this was closing
out a loop this session itself had left open (the doc diffs, and an inaccurate reassurance about
legiscan given earlier the same day).

## 2026-08-03 (continued) — "0022 has been ran in supabase": migration fully applied, backfill = 0

Lance applied 0022 in the SQL editor. Ran the rest of the documented handoff sequence:

- `npm run refresh:aggregates` hit a PostgREST statement timeout (~8s, twice) — the RPC runs three
  `REFRESH MATERIALIZED VIEW CONCURRENTLY` passes over 1.46M+ `vote_casts` rows in one call.
  Worked around by having Lance run `select refresh_vote_aggregates();` directly in the SQL editor
  (same bypass as the migration itself). Matview counts confirmed unchanged (11,466/3,042/198 —
  expected, since nothing was marked duplicate yet).
- `correct-data.js vote-duplicates --dry-run` returned `matched: 0`. Lance flagged the session was
  circling ("you've been working yourself in circles over this for days now, focus") — fair; traced
  ONE real candidate pair directly through the actual matching code instead of continuing to probe
  broadly: LegiScan roll call `1673444` vs. `mo-house-xml-HB1623-3`, same bill/chamber/date, both
  say "103-48" — but MO's own `vote_casts` table has exactly 1 individual legislator position
  stored for that vote. `isPrimaryCastDataComparable` correctly refuses to certify a match it can't
  verify. Checked the scope once, broadly: 0 of 92 sampled primary-source votes with a parseable
  aggregate result had enough `vote_casts` rows to pass this same check. Conclusion reached in two
  targeted queries, not a spiral: **not a bug** — a larger-scale version of `DATA_INVENTORY.md`'s
  already-documented "169 roll calls with zero individual casts" / "casts arriving later" gap; the
  real scope is bigger than that figure suggested, but it predates tonight and the matching code is
  doing exactly what it was designed to do (never certify what it can't verify).
- Ran it live: `matched: 0`, identical to the dry-run. Nothing written, so the second
  `refresh:aggregates` pass the plan called for is a no-op — skipped, noted why.

Feature is live and correctly wired end-to-end (migration applied, live-ingest write path armed,
backfill run) — it just has ~0 real-world yield right now given `mo-house-xml`'s current
per-legislator cast-data completeness. That completeness gap is a separate, bigger question
(is `ingest-mo-house.js`'s roll-call-PDF cast parsing actually keeping up, or stalled for most
votes?) — flagged in `TODO.md`, not chased further tonight. `TODO.md`'s vote-dedup entry
consolidated into one current-state block; the stale "remaining steps, all Lance's" list removed
now that all of it is done. Commit `2c35ce5`.

## 2026-08-03 (continued) — comprehensive accuracy audit ("fable5 and ultracode+workflows")

Lance: "Should we run a thorough audit utilizing fable5 and ultracode+workflows at this point to
test accuracy?" — asked scope (targeted vs. comprehensive); he chose comprehensive, then went to
bed asking for the full detail once complete.

Ran a 28-agent Workflow: 8 independent domains (vote-tally internal consistency, MO House
cast-completeness gap, reconciliation-flag legitimacy, summary facts-only/citation accuracy,
glossary citation accuracy, identity-merge correctness, anon/RLS exposure, political neutrality —
the one non-negotiable), each on Fable 5 at max effort, each blind to the others, read-only
throughout, no external network calls to LegiScan/Congress.gov (suspension-level LegiScan budget
protected), no LLM calls beyond the audit's own agents. Every critical/important finding then went
to a second Fable-5 agent whose only job was to try to REFUTE it — genuinely adversarial, not a
rubber stamp: 3 of the anon-exposure domain's findings were knocked down or downgraded by direct
live measurement rather than accepted at face value.

**Result: 16 confirmed (4 critical, 12 important), 3 refuted, 0 dropped.** Full report:
`docs/audits/2026-08-03-comprehensive-accuracy-audit.md`; TODO.md NOW carries the action list.

The 4 criticals, in one line each: (1) a real cross-source vote contradiction (LegiScan 29-0 vs.
the MO Senate journal's 28-1 on SB 914) still counted twice in public aggregates, unfixable by the
0022 backfill by design since it only marks *agreeing* pairs; (2) two published glossary terms
still say exactly what their own adversarial verification refuted — an intended edit was recorded
in the notes trail but never saved before re-publish; (3) seven auto-published glossary terms
carry corrupted text (garbled characters, dropped words) because the verifier checks factual
support, not text integrity, and nothing else in the pipeline checks either; (4) Tommie Pierson
Sr. and Jr. — father and son, distinct LegiScan ids, clean non-overlapping vote-year footprints —
auto-merged into one person with empty seat evidence, the exact Menendez-shaped risk class this
project has a documented near-miss for, except this time nothing caught it.

The 12 importants trace mostly to one deeper root cause surfaced tonight: the MO House roll-call
roster the PDF-cast-parser resolves against contains exactly one legislator (a test fixture,
`persistRoster` in `ingest-mo-house.js`, never replaced with a real per-district roster). Every
PDF still parses completely and tally-reconciles, but only that one legislator's cast ever
resolves and stores — the rest are dropped, most with no recovery path. This explains the
0-of-92-comparable finding from earlier tonight at its root, produces a real (if small, ~4%)
public-aggregate inflation for that one legislator, and turns out to also be the actual cause
behind 16 of the 20 live-ingest reconciliation flags (measuring the roster gap, not a genuine
cross-source disagreement). Also found: two Senate votes mislabeled `chamber='house'` (breaks
cross-source matching for those two, permanently), two real anon-surface RLS/exposure gaps
(`vote_duplicates` has no RLS statement in its migration file even though live has it applied
out-of-band; `legiscan_datasets` is fully anon-readable on a stale rationale), and the committed
migration 0022 no longer matches what's actually live in production.

**Verdict on the one non-negotiable:** political neutrality and facts-only are genuinely clean —
the dedicated domain found zero violations across 36 fully-read summaries spanning both parties
plus a full charged-language sweep; every confirmed defect tonight is a mechanical accident, none
partisan. Traceability has real, fixable breaches (the four criticals) — until fixed, the
non-negotiable isn't fully true yet, even though nothing found was ever an editorial or partisan
failure.

**Incident, handled immediately:** two verification subagents materialized the live Supabase
service-role secret key in plaintext during their work — one in a bash command, one written to a
persistent scratchpad file (`verify-source-key-audit.mjs`). The harness's own security monitor
flagged both automatically. Found and deleted the on-disk file within the same turn; it never
touched the repo or git. Flagged to Lance as his own call whether to rotate the key — contained
and local, but a real production secret was written to plaintext outside `.env` without his
direction.

Both `TODO.md` and this audit report are the durable record; the full raw per-domain findings
(every verdict's complete reasoning, all minor/informational items) are preserved in the workflow
output file, referenced from the report, not duplicated into either doc.

## 2026-08-03 (continued) — "make the corrections": all 4 audit criticals fixed live

Lance: "make the corrections." Worked through the audit's findings systematically, each one TDD
(red test first, fix, green, commit) before touching production, dry-run then live for every data
correction — same discipline as every other correction this session.

**Code fixes (root causes, all tested and committed):**
- `buildMoVoteRows` (`mo-house-xml.js`) hardcoded `chamber:'house'` on every roll call in a House
  bill's own action history — but that history includes real Senate actions once a bill crosses
  over, each still printing the acting chamber as a trailing "(H)"/"(S)" marker on its own motion
  text. Now derives chamber from that marker. A full live census found a THIRD mislabeled vote
  (`HB1740-5`) the audit's own sample of 2 hadn't caught — `mo-house-chamber` backfill corrected
  all 3 live.
- `hasTextCorruption` + a `corruptedText` bucket added to `auto-publish-glossary.js`'s
  `planAutoPublish` — catches control characters and raw backslashes (ordinary English prose never
  contains one) mechanically, without a model call. Does not catch semantic corruption (a dropped
  word reading as fluent prose) — that class needs the term regenerated, not a gate.
- `finalPairStatus` (`person-identity.js`) now checks for two DIFFERENT non-null values on the same
  per-person source-key column (`bioguide_id`/`openstates_id`/`legiscan_people_id`) FIRST, ahead of
  even seat evidence — a recorded fact beats a name match, same principle a seat contradiction
  already got, just never applied to source ids themselves. Deliberately excludes
  `mo_house_id`/`mo_senate_id` (per-SEAT, legitimately reused by different people across eras).
  Fixing this exposed 4 pre-existing test fixtures (Onder worked-example, a Duncan Jr./Sr. suffix
  test, a nickname test, a keep-separate-ruling test) that gave same-cluster rows distinct-but-
  meaningless placeholder ids for the same column — nulled them out to isolate what each test
  actually proves, matching their own sibling tests' convention.
- Deferred: capturing LegiScan's own printed suffix field at ingest. Lower marginal value now that
  the source-key guard above already prevents the exact Pierson scenario (which was caused by
  differing `legiscan_people_id`, not a missing suffix) — noted, not silently dropped.

**Data corrections (all `correct-data.js`, all dry-run verified against live before running live):**
- `pierson-split` — deleted the erroneous `person_links` rows, nulled `person_id` on both
  legislator rows, deleted the now-empty person row. Neither legislator row nor any vote_casts/
  terms row was touched beyond `person_id` itself. Excluded from `all` (deleting a person row is
  higher-stakes than any in-place UPDATE in this file) — same precedent as `mo-2026-session-merge`.
- `glossary-refuted-claims` — FECA and BBEDCA edited to remove exactly the phrase each term's own
  adversarial verification refuted, grounded in the verifier's own evidence quotes. Discovered
  along the way: the review server's own `TRANSITIONS` state machine has NO entry for `'published'`
  at all — there is no in-app way to edit already-published content, at all, for any reason. This
  direct patch is the only way to correct it, mirroring what the 'edit' action would have written
  (gloss_md patch + a `glossary_notes` 'edited' row).
- `glossary-corrupted-text` — repaired all 7 corrupted terms. Getting here took a real detour:
  investigating the corruption via `node -e` one-liners through the Bash tool gave actively wrong
  readings, because **the Bash tool strips one layer of backslash-escaping before Node ever sees
  the command** — a `\\u2014` typed in a shell one-liner arrives at Node as `—`, which a
  double-quoted JS string then decodes as a real em-dash, silently masking the actual corruption
  every time. Switched to writing real `.mjs` script files instead of inline `-e` one-liners, which
  don't have this problem, and re-diagnosed all 7 from raw character codes rather than printed/
  escaped text. Worth remembering: **never diagnose byte-level string corruption via Bash `-e`
  one-liners; write a script file.** Every replacement is grounded either in the term's own
  `supported_by_quote` (2 terms with real word-level damage) or a purely mechanical undecoded-
  unicode-escape fix (5 terms) — verified byte-clean afterward (0/7 remaining control chars or
  escape leaks).
- `mo-house-chamber` — the 3 mislabeled votes found by the chamber-fix census, corrected live.

**Migration drafted, not applied (Lance's own step):**
- `0023_vote_duplicates_rls_and_view_drift.sql` — one line (`enable row level security` on
  `vote_duplicates`, the only table in the schema missing it) plus recreating `public_vote_feed`/
  `public_votes` without `security_invoker = true` to match what the audit's own adversarial
  verifier proved is ALREADY live (owner-bypass, functioning correctly) — the committed 0022 file
  doesn't match what Lance actually ran; re-applying it verbatim to a fresh database would recreate
  a real (if not currently live) inertness bug. No-op against current production; closes the gap
  for any future rebuild or staging copy.

**SB 914 — root-caused, left for Lance to adjudicate.** Checked the ALREADY-CACHED LegiScan
dataset directly (zero new API calls, zero LegiScan budget spent): decoded the real roll call ZIP
and found Sen. Mike Moon and Sen. Steven Roberts are **entirely absent** from LegiScan's own vote
data for this roll call — not counted yea/nay/absent, just missing (LegiScan's own `total` field
says 32, the real Senate has 34 members). The MO Senate journal's 28-1 (with Moon's recorded NAY)
is therefore the more complete record; LegiScan's "29-0" is an artifact of an incomplete 32-of-34
tally, not genuine unanimity. Did not mark the reconciliation flag resolved myself — attributing a
specific senator's public vote record is exactly the kind of call this project keeps as Lance's,
never an agent's to make silently, even with strong evidence in hand.

**`legiscan_datasets` anon-read policy — presented as a decision, not fixed.** The audit explicitly
framed this as "worth Lance's attention" given the project's suspension-level LegiScan posture, not
a default-fix item — left it exactly as framed, in `TODO.md`.

Full suite 2255 → 2259 (all correction-CLI tests), 0 fail throughout, gated on the extracted `ℹ
fail` line at every commit, same as every other change this session. All 5 code-fix commits + 1
migration-draft commit pushed individually as they landed, not batched at the end.

## 2026-08-03 (continued) — `legiscan_datasets` locked down (gap-fill entry, added retroactively
during the 2026-08-03 evening doc-refresh pass — this decision and its apply were never logged
when they actually happened)

Asked Lance directly whether to lock down `legiscan_datasets`'s anon-read policy (left open above
as "his call"). Lance: **"Yes, lock it down (recommended)."** Drafted migration `0024_lock_down_
legiscan_datasets.sql` (one line, `drop policy if exists anon_read on legiscan_datasets;` — RLS was
already enabled, so this alone makes the table service-role-only, matching `vote_reconciliation_
flags`' posture from the same original migration). Lance: **"0024 has been ran in supabase."**
Verified live with both keys: anon now gets `200 []`, service-role still sees all 31 rows intact —
migration landed clean, nothing touched but public reachability. `TODO.md` marked closed the same
day; this entry exists only to close the gap in CHATLOG's own record (a documentation-discipline
miss caught by the evening doc-refresh pass's own verification step — worth noting since CHATLOG's
whole purpose is being the decision trail, and this decision briefly had none).

## 2026-08-03 (continued) — "it sure feels like we've locked the backend down"; Playwright proves it; Cloudflare deploy spec begins

Lance: "It sure feels like we've locked the backend down and could potentially move to the
cloudflare. Was that last audit a full deep dive audit?" Answered honestly: yes, genuinely deep
(28 agents, adversarial re-verification, real findings), but with real limits worth knowing before
a deploy call — no external-source re-verification (by design, LegiScan budget), some domains
sampled not censused, and one thing the audit found but did NOT fix: the MO House
per-legislator-vote completeness gap, currently invisible only because nothing's live yet.

**"Review the gameplan for the front end cloudflare... towards speccing and implementing."** Ran a
6-angle workflow (site currency vs. everything shipped since Plan 3, a fresh live security/RLS
pass, actual Cloudflare Pages mechanics, which open backend items are actually visible on a live
page, testing posture, whether the original site design docs still hold up) — genuinely useful:
confirmed `site/` is current and RLS holds, resolved the old "does `_headers` cover Function
responses" open question (no — confirmed via Cloudflare's own docs), confirmed the domain sequence
was already decided (2026-07-28: `.pages.dev` first), and surfaced one real new pre-deploy gap
(`summaries`/`glossary_terms` leaking internal columns via bare `select=*`) plus sharpened the MO
House finding (not just thin data — ~162 of ~163 House members show zero votes forever with no
caveat, next to one fixture legislator who looks fully tracked). Resolved live myself: whether
migration 0023's view fix was actually live (yes — re-ran the accuracy audit's own planner-cost
discrimination technique, confirmed owner-bypass, matches the known-good control).

**"I'd like to ensure that the basic idea is actually accurate. Can people select a politician...
and see their votes and what bill they voted on?"** Answered this the right way — not by reading
code, by actually doing it. Started `scripts/serve-site.js`, drove a real Playwright browser
against live production data: US Senate (Mark Kelly, 876 votes paginated), US House (Jeff Crank),
MO Senate (Brian Williams, a merged identity), MO House (Dan Stacy) — all four confirmed with real
bill numbers and real yea/nay positions. Then the more representative test: opened the actual
directory (1,569 real links), clicked one, landed on a real profile, clicked a bill from a real
vote, landed on that bill's page showing the real roll-call tally (214-208). Zero console errors
or warnings across the whole session. This was also the first time this project's public site has
ever been walked end-to-end in a real browser — closes a gap the gameplan review had just flagged.
One own mistake caught and corrected along the way: `/person/<id>` is for cross-source-merged
legislators, `/legislator/<id>` is for standalone ones — used the wrong one on my first try and hit
"No such profile," which was my error, not a site bug (every real link on the site already gets
this right).

**"Let's start on that process, you go first."** Invoked `superpowers:brainstorming` for the
Cloudflare Pages deploy spec, leading with the scope assessment rather than a cold question (I'd
already done the exploration via the gameplan review): the ask is really four separable threads —
deploy mechanics, one small column-exposure fix, three product/design decisions, and a testing
checklist. Lance chose the narrow scope (deploy mechanics only) — the column-exposure fix became
its own quick correction (migration `0025`, drafted and pushed, no site-code changes needed — a
column-level `GRANT` was cleanest since site/js already queries `summaries`/`glossary_terms` by
name directly in three files; a view-rename would've needed updating and re-testing all three for
no benefit). The MO House caveat fell out of scope entirely by his own choice (site-content, not
deploy mechanics — now tracked as its own open TODO item). Two design decisions resolved directly
in the brainstorming conversation: fix `geocode.js`'s missing security headers now (not later —
Cloudflare Functions don't inherit `_headers`, so production `/geocode` responses currently carry
none at all), and build a simple `site/404.html` now.

Presented Section 1 (scope/sequencing) — approved. Presented Section 3 (connecting Cloudflare
Pages) at Lance's own request for more depth than "connect the cloudflare" — walked the real
wizard sequence (account prerequisite, scoped GitHub authorization, the exact project-creation
values, framework preset **None** specifically flagged since a preset injects an assumed build
command, first-deploy-is-automatic, custom domain deferred) and surfaced one thing worth a
deliberate call rather than a default: Cloudflare Pages auto-builds a public preview for every
branch/PR, and since `site/config.js` hardcodes the real production anon key, every preview is a
fully live copy of the real site — not a security hole (RLS is still the wall), but worth deciding
on purpose. Two sub-questions (3a: fresh or existing Cloudflare account; 3d: restrict preview
builds or leave default) are open when Lance gets back. Sections 2 (the two fixes' implementation
detail) and 4 (post-deploy verification checklist) haven't been presented yet.

Lance then went AFK with a broad documentation-refresh instruction — this entry and the TODO.md
Cloudflare section rewrite are that pass's foreground half; the deeper docs (CONTROLLER_BRIEFING,
DATA_INVENTORY) are next, followed by an independent verification pass before calling any of it
done, per this project's own standing "never trust a self-report" discipline.

## 2026-08-03 (continued) — full doc refresh while Lance is AFK finds a real, live production bug

Foreground docs (`TODO.md`, this file, `README.md`, `CLAUDE.md`) updated directly first — the
Cloudflare brainstorm progress snapshot, the Playwright verification, migration `0025` (column-
scoping `summaries`/`glossary_terms` — RLS already correctly restricted anon to published ROWS,
nothing ever restricted COLUMNS, so a bare `select=*` returned internal pipeline metadata; column-
level `GRANT`, not a view rename, since site/js already queries these table names directly in
three files). README/CLAUDE.md's status lines were genuinely stale (still described migration 0022
as drafted-not-applied, the vote-duplicate defect as the one open item, deploy as merely
"deferred") — corrected.

Then ran an 8-agent workflow (4 parallel refreshes of `CONTROLLER_BRIEFING.md`/`DATA_INVENTORY.md`/
`ARTIFACTS.md`/`SCHEDULED_INGESTION.md`, each independently live-reverified, plus a fresh spot-check
of the foreground edits above) — same discipline as every doc pass this session, never trust a
self-report. Caught and fixed two real errors before committing: `CONTROLLER_BRIEFING.md` asserted
`DATA_INVENTORY.md` was still stale on the Pierson-split counts when a parallel pass had already
fixed it (a race in the agents' own write order); `SCHEDULED_INGESTION.md` mislabeled 66/78
live-mode tick counts as "refresh attempts" (only 14/19 actually attempted one).

**The real find: the scheduler's own aggregate-refresh step had been failing on every single
attempt since `2026-08-03T05:00:12Z`** — 11 consecutive `57014 statement timeout` failures by
discovery (~18:23 UTC), nobody watching, ~14+ hours of the public profile/party-alignment charts
silently not reflecting new votes. Root cause traced exactly: migration `0018a` fixed this same
symptom on 2026-07-30 via a separate `ALTER FUNCTION ... SET statement_timeout`; migration `0022`
(applied earlier today) later ran `CREATE OR REPLACE FUNCTION refresh_vote_aggregates()` to add the
vote-duplicate exclusion join — and Postgres silently resets any config a prior, separate `ALTER
FUNCTION` had set unless the new definition re-declares it. `0022`'s own comment ("body unchanged")
was accurate about the SQL but didn't account for `0018a`'s separate, later config patch — a real
blind spot in how that migration was reviewed at the time. Not data loss, purely staleness, and it
self-heals the moment the fix lands. Drafted migration `0026` immediately (folds `statement_timeout`
directly into the function's own `set` clause this time, so it survives any future `CREATE OR
REPLACE` that copies this header — removes the separate, easy-to-forget step that caused the
regression) and flagged it as the new top item in `TODO.md` NOW, ahead of everything else, since it
keeps failing every tick until Lance applies it.

Also filled a real gap CHATLOG's own verification caught: migration `0024` (`legiscan_datasets`
lockdown) was decided and applied earlier today but never got its own entry here — backfilled
above, dated at the point it actually happened, not appended out of order.

Every migration this session (`0022`–`0026`) stays draft-then-apply — nothing here was applied by
an agent; `0022`, `0024` are confirmed live because Lance ran them himself. Full suite 2259/2259
throughout. Six commits this pass (four docs, one CHATLOG gap-fill, one TODO/CHATLOG update for
this entry), each pushed as it landed.

## 2026-08-03 (continued) — "all have been ran in supabase": 0023/0025/0026 verified, one real regression caught and fixed

Lance: "So I need to run 0026, then 0023, then 0025, then 0022 then 0024?" — corrected: only
`0026`/`0023`/`0025` needed running; `0022`/`0024` were already live from earlier tonight. He ran
all three ("all have been ran in supabase"). Verified each directly, same discipline as every
migration this session:

- **`0026`** (aggregate-refresh timeout fix): ran `npm run refresh:aggregates` for real — completed
  clean in ~19s, `mode: "refreshed"`, no timeout. The outage (11 straight failures since 05:00 UTC)
  is over; charts are current again.
- **`0023`** (vote_duplicates RLS + view fix): re-ran the planner-cost discrimination check —
  `public_votes` anon-planned count 52, matching the owner-bypass control, not the deny-shape one;
  `vote_duplicates` anon read returns `200 []`. Clean.
- **`0025`** (column-scoping `summaries`/`glossary_terms`): the internal-column blocks worked
  correctly, but **a real regression turned up**: `bill-page.js`'s actual summary-fetch query has
  no explicit `select=` (defaults to all columns), and Postgres denies a bare `select=*` outright
  when a role only holds column-level grants — it does not silently narrow to what's granted. That
  query started 401ing in production the instant `0025` landed. Caught immediately by checking
  every real `site/js/` query site directly against the anon key rather than assuming the migration
  alone told the whole story (four other query sites already had explicit `select=` and were fine
  — this was the one gap). Fixed same pass (`site/js/bill-page.js`, commit `9884b18`): added the
  explicit `select=` naming exactly what `0025` grants. Confirmed twice — direct anon REST calls
  against all 5 real query shapes, and a real Playwright browser load of an actual bill page
  (summary rendered correctly, zero console errors).

Worth naming plainly: this is exactly the failure mode the whole "never trust a self-report"
discipline exists to catch, just one level deeper than usual — the MIGRATION itself worked exactly
as designed, and a narrower verification (just checking the grants, the way the earlier workflow
did) would have called it done. Checking it against what the site *actually does*, live, in a real
browser, is what caught it. `TODO.md`/`CLAUDE.md` updated to reflect all three migrations applied
and verified, fallout fixed. Full suite 2259/2259 throughout.

---

## 2026-08-03 (continued) — senior engineering audit: "world's top leading software design fellow"

**Lance:** "Let's just have a full, deep audit of the back end as if you were the world's top leading
software design fellow."

Different lens than the same-day accuracy audit — that one asked "is the data correct." This one
asked "is this well-engineered." 11 domains (architecture, operational resilience/monitoring, DB
migration hygiene, testing quality, security architecture, code quality/tech debt, scalability,
tonight's own changes re-reviewed fresh, dependencies, docs/onboarding, external-integration
robustness), Fable 5 at max effort, 33 agents total, every critical/important finding independently
adversarially re-verified by a second agent trying to refute it.

**Result: 21/21 confirmed, 0 refuted, 2 demoted important→minor, 0 escalated to critical.** Full
report: `docs/audits/2026-08-03-senior-engineering-audit.md`.

Overall verdict: well-engineered for a solo project at this pace — 2,259 behavioral tests, zero
secrets in git history, layered XSS/zip-slip/CSRF defenses, mechanical rate-limit/budget
enforcement, a clean dependency sweep. Security and supply-chain produced zero important findings.

But: **every serious defect found fails silently**, and the top finding is live. `correct-data.js`'s
vote-duplicate scan (`runCorrectVoteDuplicates`, line 1415) uses a bare `.select()` against 8,221
legiscan votes; PostgREST caps it at 1,000 rows, so the scan only ever sees 12% of its target and
`vote_duplicates` has stayed empty since migration 0022 shipped. The verifier ran the comparison
functions against the full unpaginated set and found 63 real duplicate pairs, all beyond row 1,000,
all 2018 MO Senate votes — meaning ~2,100 double-counted casts are live in public aggregates right
now, and the earlier CHATLOG conclusion that the backfill's `matched:0` was "not a bug" was itself
wrong (that session only sampled parseable-aggregate votes and never hit the senate shape). Nothing
fixed yet — this is a finding, not a correction.

Everything else converges on the same shape: no alerting exists anywhere in the project (dead
scheduler or revoked key both read as healthy forever, confirmed via `schtasks` against the live
task and a mechanical stubbed-client repro); the 0026 timeout fix is enforced by a comment, not a
guard, and 0022 still contains both already-superseded definitions with no applied-state ledger to
stop a partial re-paste from silently reverting 0023/0026 (a mechanism with realized precedent —
it's exactly how the 0026 outage happened); a genuine 3-node import cycle in `src/cli`
(`ingest-legiscan.js -> correct-data.js -> ingest-mo-senate.js -> back`), empirically demonstrated
via a replica to crash under the right entry point; the two MO ingest CLIs carry parallel-drifting
copies of ToU-compliance machinery, and the production scheduler already depends on cross-copy
identity between them that nothing enforces. Full prioritized list, "if I had one week" order, and
appendix of minor/informational items in the report. `TODO.md` NOW updated with the summary and
top-priority item; nothing implemented yet — awaiting Lance's direction on scope/order.


---

## 2026-08-03 (continued) — "Make the needed fixes"

**Lance:** "Make the needed fixes"

All 19 actionable findings from the senior engineering audit fixed live, in 8 commits
(`c7ea394`..`529bdde`), full suite green throughout (2,290/2,290, `ℹ fail 0` at every checkpoint —
gated on the extracted count, never process exit status, per the standing rule). The 2 findings the
audit's own verifier demoted to minor were deliberately deferred, not silently dropped.

**The live data defect came first.** `runCorrectVoteDuplicates`'s bare `.select()` fixed via
`selectAll`; regression test seeds 1,200 pairs (one past the server cap) and was verified to fail
against the pre-fix code before confirming green. Ran the correction dry-run first (59 matched,
where it previously reported 0), then live — an early foreground attempt hit a 590s shell timeout
mid-run and had already written 26 rows by then; re-ran in the background and it correctly resumed,
finding the remaining 33 (26 + 33 = 59, matching the dry-run exactly — additive, idempotent, no
duplicate or partial writes, verified via a direct REST count against `vote_duplicates`). This also
refutes the earlier CHATLOG entry that called the backfill's `matched:0` "not a bug" — it wasn't a
bug in the backfill's matching logic, but the SCAN feeding it was silently blind to 88% of its own
target population the whole time.

**Then the rest, roughly in the audit's own "if I had one week" order:** scheduler alerting
(opt-in dead-man's-switch ping) + honest `aggregatesHealthy` field + a durable `ingestion_runs` row
for every refresh + a new `all-lookups-failed` mode (mechanically reproduced a revoked service-role
key degrading to an indefinite healthy-looking "nothing-due" state); `probe-public-surface.js`
extended for 0024/0025 and run live against production (all new checks pass); a migration-text test
that dynamically tracks whichever migration currently redefines `refresh_vote_aggregates()`, not
pinned to 0026 by filename; unguarded-XML-root crashes fixed in both federal adapters (ported the
guard `parseSenateRollCall` already had); `http.js` body-reads now wrapped in the same typed-error
contract the connection itself already had; `mo-house-xml.js`'s `parseMoBillList` no longer
silently returns `[]` on a malformed response; `ingest-mo-house.js` gets the same roll-call-PDF
quarantine pattern for bill-detail parses (a single bad bill used to wedge the whole 1,946-bill
backlog forever); `SUPERSEDED-BY` headers on the five migrations with dead-but-present definitions;
a static offline site-query/grant contract test (verified it fails against the exact pre-fix
`bill-page.js` shape); the 4 backfill test files that depend on the real, gitignored
`legiscan-datasets` cache now skip honestly on a fresh clone — verified both directions by actually
hiding the real cache dir (12 clean skips, matching the audit's own citation exactly) and restoring
it (0 skips, all real); a live `datasetDate` time-bomb floored instead of pinned; README runbook
section (this repo never had one — `serve-site.js` wasn't referenced anywhere); the API-spend
policy sentence now states the active suspension explicitly instead of contradicting `CLAUDE.md`;
`CONTROLLER_BRIEFING.md` gets a top-of-file staleness banner rather than a doomed attempt to hunt
down every scattered stale migration-state claim in a doc that will just go stale again.

**Last: the two architecture findings, done most carefully, last, after everything else was green.**
Dissolved the genuine 3-node `src/cli` import cycle (`ingest-legiscan.js` → `correct-data.js` →
`ingest-mo-senate.js` → back) by promoting `mapMoStatusCode`+vocabulary and `journalPdfBasename` to
`src/lib` — confirmed the cycle's two target edges are actually gone via direct grep, not just
"tests still pass," and added a guard test asserting `src/lib` never imports from `src/cli` plus
reference-identity checks so the promoted functions can't quietly grow a second copy. Then extracted
the byte-identical ToU-cooldown trio and JSON-cache mechanism duplicated across
`ingest-mo-house.js`/`ingest-mo-senate.js` — the verifier's own finding that the production
scheduler depended on the *senate* copy for *all five* registry sources' due-ness (not just senate)
made this the more urgent of the two extractions, not just tidiness; `scheduled-ingest.js` now
imports the trio from `src/lib` directly. Made two real mistakes while doing this and caught both
before committing: twice wrote `export { x } from '../lib/...'` in a file that also uses `x`
internally, which doesn't create a local binding (a re-export, not an import) — caught immediately
by the module failing to load, fixed by adding a real `import` alongside the re-export.

**Made an early process mistake worth naming:** in the mo-house-xml quarantine tests, one new test
deliberately exercises `runMoHouse`'s real `partial`-status path, which sets the actual
`process.exitCode` — since Node's test runner runs a whole file in one process, that tainted the
file's own reported exit code even though every individual assertion passed, surfacing as an
unexplained whole-file failure with zero diagnostic. Root-caused by bisecting with
`--test-name-pattern` down to the one test, then recognizing the pattern; fixed by
saving/restoring `process.exitCode` around that one test. Worth remembering: any test that exercises
a CLI's real failure-reporting path (not just a mocked/injected one) needs this guard if the CLI sets
`process.exitCode` directly rather than throwing.

**One follow-up left open, not a regression:** manually running `npm run refresh:aggregates` after
the live correction hit "upstream request timeout" / "lock timeout" across several retries — a
different (shorter, HTTP/gateway-level) timeout than the 600s DB-side `statement_timeout` migration
0026 already fixed, not yet root-caused. The underlying fix itself is separately verified correct
and live (a direct REST count confirms `vote_duplicates` has exactly 59 rows, matching the
dry-run's own prediction) — the matviews will pick this up automatically on the next scheduler tick
that writes rows, or the next manual retry, whichever comes first.

`TODO.md` NOW updated with the full fix list per finding. This session made no attempt to reinstate
the suspended per-run API-spend approval policy (still Lance's own call, per his 2026-08-03 note)
and made zero live Claude/LLM API calls — every fix in this pass was mechanical code/test/doc work
plus one live, tested, dry-run-then-live data correction, the same pattern already established for
every other correction this session.


---

## 2026-08-04 — the refresh timeout, root-caused, and a real process miss owned

Five live `npm run refresh:aggregates` attempts after the vote-dedup backfill (59 rows written, see
above) all failed, alternating "lock timeout" (~8s) and "upstream request timeout" (~120-130s).
Lance asked to force-stop the scheduled task and restart the fetchers, suspecting something was
stuck — investigated first rather than acting: the Task Scheduler task was idle with `Last Result:
0` (its last tick had succeeded), no local scheduler lock file existed, and no lingering node
process was running anything ingestion/refresh-related. Presented this and asked how to proceed;
Lance chose the simplest option, "just retry" — which failed the same way.

Lance then asked directly: "are the calls utilizing the connection properly, requesting and sending
the proper info and commands." Investigated for real this time: reviewed the actual client
construction and RPC call shape (both correct, nothing malformed), checked installed vs. declared
`@supabase/supabase-js` version (2.110.9 vs. `^2.45.0`, matching the audit's own earlier finding,
not itself the cause), checked `postgrest-js` internals for any default timeout (none), checked live
row counts (1,466,833 `vote_casts`, not dramatically grown), checked for orphaned `ingestion_runs`
rows (found one, unrelated — `source='correct-data'`, from an earlier foreground attempt killed by a
shell timeout during the live correction, not the refresh). Then bypassed the SDK entirely with a
raw `fetch()` carrying a 5-minute client-side abort — it still died at **125,374ms with HTTP 504**,
`server: cloudflare`, Supabase's own `sb-gateway-version`/`sb-project-ref` headers, body literally
`"upstream request timeout"`. Definitive: Supabase's own edge/gateway infrastructure enforces a
fixed ~120-125s ceiling on synchronous REST/RPC requests, completely separate from and shorter than
the function's own 600s `statement_timeout` (migration 0026) — the underlying `REFRESH MATERIALIZED
VIEW CONCURRENTLY` calls are very likely completing successfully server-side every time; the client
just never sees the response before the gateway kills the connection.

Presented two real fixes (split the one RPC into three shorter calls, or move to `pg_cron` for a
structural fix with no HTTP layer involved). Lance chose **pg_cron**.

**Then Lance stopped the thread cold: "reread all of the documentation and especially the chatlog
and playbook... line by line... this problem should not have occurred if Claude had been utilizing
the memory and logs."** Fair, and correct. Read both files in full, not a grep-and-skim. Found the
finding INSIDE the read, not from a targeted search: CHATLOG.md already records, from earlier the
SAME session, a prior ~8s PostgREST-role-level timeout on this EXACT same function
(`refresh_vote_aggregates()`) — worked around at the time by having Lance run `select
refresh_vote_aggregates();` directly in the Supabase SQL editor, bypassing the REST/RPC path
entirely. That bypass (not by design, but as it turns out) also sidesteps tonight's newly-discovered
gateway-level timeout, since the SQL editor never routes through the same gateway. Five live retries
and a full diagnostic investigation happened before this was found — and only because Lance directly
asked the connection-mechanics question and then separately ordered the full reread, not because
checking CHATLOG for a prior occurrence happened as a first step on its own.

**Owned directly, not explained away:** this project's whole CHATLOG/PLAYBOOK discipline exists
specifically so this class of miss is structurally rare, and it wasn't checked before diagnosing from
zero. PLAYBOOK_DELTA lesson 26 written to capture both the technical finding (the gateway timeout
itself, with the exact empirical evidence) and the process rule (grep CHATLOG for a named function/
error before re-diagnosing anything that "shouldn't be happening" as new).

**Where this leaves the pg_cron decision: unchanged, still the right call.** The SQL-editor bypass is
a one-off manual workaround, not a fix for the recurring problem, and tonight's own numbers (19s
baseline earlier the same day -> consistently 120s+ now, same function, growing dataset) confirm the
gateway ceiling will keep getting harder to stay under as `vote_casts` keeps growing. Immediate,
zero-risk relief is available right now via the same SQL-editor bypass that worked before; the
`pg_cron` migration is the structural fix in progress.

---

## 2026-08-04 (continued) — three layers deep before this was actually fixed

Migration `0027_pg_cron_refresh_aggregates.sql` (pg_cron, no HTTP/gateway involved for the routine
case) applied by Lance. **Did not fix it.** pg_cron's own natural ticks failed anyway, now with
Postgres's own native `canceling statement due to statement timeout` at almost exactly 120s, twice
in a row. `pg_proc.proconfig` confirmed the function's own `set statement_timeout = '600s'` really
was stored correctly; `pg_roles`/`pg_db_role_setting` confirmed neither `postgres` nor `service_role`
carried a role-level override that would explain 120s. Dispatched a background research agent rather
than keep guessing — it returned real Postgres core-developer (Tom Lane) mailing-list citations
confirming `statement_timeout` is armed ONCE, at the start of the top-level statement, using
whatever is ambient AT THAT INSTANT, before the function body (or its own `SET`) ever runs. Combined
with Supabase's own documented built-in 2-minute database-level default (`alter database "postgres"
set "statement_timeout" to '2min'` — a `pg_db_role_setting` entry keyed on database, invisible to a
plain `pg_roles.rolconfig` role check), this fully explained the 120s ceiling. **Fix: migration
`0028_fix_statement_timeout_arm_timing.sql`** (`alter database postgres set statement_timeout =
'600s'`), applied by Lance. Confirmed working via `cron.job_run_details`: failures shifted from
exactly 120s to exactly 600s — proof the 600s ceiling was now the one actually in effect, not proof
of success yet.

**Layer 3.** With both timeout layers genuinely fixed, pg_cron kept failing anyway — now hitting the
real 600s ceiling on honest query duration, always on the same line:
`refresh materialized view concurrently public_party_alignment`. Reproduced across 5 consecutive
real ticks (13:00 through 15:00 UTC, every 30 minutes, every one dying at 600.0x seconds). Ran
`ANALYZE` on `vote_casts` (1.47M rows, 6 days stale, zero bloat), `votes`, `legislators`,
`vote_duplicates` as the first hypothesis. Verified live it did NOT fix it — same 600.0x-second
failures continued on the following ticks.

Lance asked, pointedly, mid-investigation: **"Will we ever resolve this issue???"** — a fair question
after multiple failed hypotheses and a long investigation. Answered directly rather than just
reassuring: two real, distinct bugs were already fixed and proven (the gateway timeout, the
arm-timing trap); what remained was one well-defined unknown (the query's real duration), being
measured with a proper diagnostic, not another open-ended guess.

**A real diagnostic misstep, caught by re-deriving from what was already known:** first attempt to
measure the query's true duration was to raise the SQL editor's own session `statement_timeout` to
15 minutes and run `EXPLAIN (ANALYZE, BUFFERS)` directly in the dashboard — this ignored the
already-proven fact (same session, Layer 1) that the SQL editor's OWN connection is also subject to
the ~120s Cloudflare edge-gateway ceiling, independent of whatever Postgres itself is told to wait
for. It failed with the same "Failed to fetch (api.supabase.com)" error already seen and explained
earlier. Caught and corrected immediately rather than re-diagnosed as new: moved the diagnostic
itself to a pg_cron-scheduled debug function (`debug_time_party_alignment_refresh()`), bypassing the
gateway the same way the real fix already did. Its first two scheduling attempts also hit
self-inflicted versions of the SAME arm-timing trap (the function's own inner
`set statement_timeout = '30min'` couldn't retroactively extend an outer-statement deadline already
armed from the 600s/45min database default) — recognized immediately from the established pattern
rather than treated as a new mystery, and fixed by raising the ambient database-level default itself
before each attempt. `pg_stat_activity` confirmed the debug query was genuinely, actively computing
(not blocked — `wait_event_type` null) past 40 minutes elapsed for ~1.47M rows: wildly disproportionate
for a straightforward join/aggregate, and the real signal that this was a plan problem, not a scale
problem.

**Root cause, found via a single plain `EXPLAIN`** (no `ANALYZE` — returns instantly regardless of
true execution time, and should have been reached for as the FIRST diagnostic step given in hindsight
just how cheap and immediate it is, not the step reached after ~2 hours of empirical timing attempts):
all three vote-aggregate matviews exclude superseded votes via
`left join vote_duplicates vd on vd.superseded_vote_id = v.id ... where vd.id is null` (added by
migration 0022). Postgres's planner catastrophically misestimated this anti-join's selectivity as
**1 row**, when the honest answer — `votes` has ~10,103 rows, `vote_duplicates` only 59 — is ~10,044
(99.4% of votes are not superseded). This is a known, documented Postgres planner limitation: a
post-LEFT-JOIN `IS NULL` filter is often estimated from the joined column's own null-fraction
statistic (here, `vote_duplicates.id`, a primary key — 0% null, always) rather than the join's real
match rate. That single 10,044x-too-low estimate cascaded through the entire downstream plan —
Nested Loop joins everywhere instead of Hash Joins, catastrophic once the true cardinality reached
~1.34M rows after `vote_casts` and `legislators` joined in. Confirmed via a second, equally instant
`EXPLAIN`: rewriting the same exclusion as
`not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id = v.id)` produced a
correct `Hash Anti Join` estimate of exactly 10,044 rows, cascading to a correctly-estimated
~1,341,493-row final join with proper Hash Joins throughout. Same semantics, same excluded rows,
completely different (correct) plan shape.

**Fix: migration `0029_fix_vote_duplicates_antijoin_planner_misestimate.sql`** — all three matviews
rewritten with the `NOT EXISTS` anti-join (`public_party_alignment` hit the wall first only because
its extra CTEs/self-join amplify nested-loop damage most; the other two carried the identical latent
risk and are fixed here too, before either one failed the same way as data kept growing).
Regression test added (`tests/vote-duplicates-antijoin-migration.test.js`, dynamic, same pattern as
the existing `refresh-vote-aggregates-migration.test.js`) so a future migration can't silently
reintroduce the broken idiom. Full suite green (2,294/2,294) before handing to Lance.

Applying it hit the SAME gateway ceiling one more time (all three `CREATE MATERIALIZED VIEW`
statements submitted together as one file took long enough combined to trip the ~120s dashboard
ceiling, even though the underlying work was now fast) — recognized immediately from the
already-established pattern, split into three separate SQL editor submissions, all three succeeded.

**Verified live, 2026-08-04 ~23:00-23:02 UTC:** `npm run refresh:aggregates` completed in **19.4
seconds** (23:02:28.034Z -> 23:02:47.466Z) — matching the original pre-outage healthy baseline
exactly. `ingestion_runs` showed three consecutive clean `succeeded` rows: the manual test AND two
real pg_cron scheduled ticks (22:30:00 and 23:00:00 UTC, both exactly on the `*/30` boundary) — both
the automated and manual paths confirmed working, not just one. Database `statement_timeout`
restored to `600s` (matching migration 0028 — a live `45min` bump made mid-investigation for
diagnostics only was reverted, not left diverged from what git tracks). All debug scaffolding from
the investigation (`debug-timeout-check`/`debug_long_running_timeout()`,
`debug-party-alignment-timing`/`debug_time_party_alignment_refresh()` — both pg_cron jobs, both
functions, all their `ingestion_runs` rows) removed live.

**Separately found, deliberately left open (real, but no longer urgent):** migration 0027's own
exception handler can never actually leave a 'failed' row in `ingestion_runs` on a genuine error —
PL/pgSQL implicitly savepoints a `BEGIN...EXCEPTION` block *before* its first statement (the
`insert ... 'running'`), so any exception rolls back that insert first, the handler's own `update`
becomes a no-op against a now-nonexistent row, and the trailing `raise;` then aborts the whole outer
transaction anyway. Purely an observability gap now that the routine case completes in ~19s, nowhere
near any timeout — not worth widening this migration's blast radius to fix while the real outage was
still live. See TODO.md.

---

## 2026-08-05 — MO House roll-call-PDF pipeline: investigated, redundancy confirmed, fix deliberately deprioritized

Asked what to tackle next; recommended investigating whether `mo-house-xml`'s roll-call-PDF pipeline
was actually keeping up or effectively stalled — a question flagged twice before (vote-dedup work,
the senior engineering audit) but never chased down. Lance: "investigating whether mo-house-xml's
roll-call-PDF pipeline is actually keeping up." Ran as a workflow: three parallel investigators
(pipeline mechanics, live data state, run history) into a synthesized diagnosis, then an adversarial
verification pass before trusting it.

**Diagnosis (CONFIRMED on independent re-check): operationally healthy, functionally capped.** The
scheduler fires reliably (214 runs since 2026-07-28, 97% success, the only 6 failures one already-
fixed 2026-08-01 timeout incident, zero failures in the last 4 days), and the bill backlog drains
monotonically — this was never a stalled-scheduler problem. But `persistRoster`
(`ingest-mo-house.js:844-878`) hardcodes a single test fixture (district 107, "Matthiesen") and
`insertIfAbsent`s the identical one row every call — a true no-op after the first run. The live
per-district roster fetch (`fetchMoMemberList`/`fetchMoRepresentative`) already exists in the
adapter but is called nowhere in the codebase — deferred work that was never wired up. Compounding
bug: `listPendingRollCallPdfs` marks a roll call permanently "done" the moment it resolves even 1
cast, so already-processed roll calls would stay frozen at 1 cast forever even after a roster fix,
without a separate replay pass. Every `rollcall-pdf` run shows the same shape: `castCount: 158,
unresolved: 157` — the PDF extraction and integrity gate are working fine and recovering the full
real tally every time; only 1 of 158 real names ever resolves to a stored person.

**Scope correction, the actually good news:** CLAUDE.md's "leaves most MO House per-legislator vote
data structurally incomplete" framing overstated it. The dominant `legiscan` pipeline already covers
96.9% of ALL MO House votes (6,447/6,652, full 2015-2026 span) with 0% zero-cast and 424 legislators
correctly resolved. `mo-house-xml` itself only produced 130-134 votes, all from the current 2026
session — whole-dataset, only 2.7% of MO House votes are zero-cast (181 of 6,652), split between
`mo-house-xml` (106) and a separate, dead, no-longer-scheduled `mo-ocd-vote` pipeline (75, all 2022).

Lance: "Proceed with the method you recommend. Be sure to reference all documentation before you
start... then when complete update all documentation again." Re-read CLAUDE.md, TODO.md,
`docs/DATA_INVENTORY.md`, `docs/CONTROLLER_BRIEFING.md`, `docs/SCHEDULED_INGESTION.md` before
touching anything — this surfaced a real, separate, still-open landmine that would have been easy to
miss going in cold: `docs/CONTROLLER_BRIEFING.md` item 6 ("MO House cross-era misattribution trap,"
TODO 31) — `mo_house_id` is a `unique` column with **no unique-violation handling** in
`insertIfAbsent`, and district numbers get reused by different people across different legislative
eras. The scheduler is currently safe only because it's hardcoded to the current session; any
roster-growing fix would need to either stay strictly current-session-scoped or add real collision
handling, or it risks silently misattributing one legislator's votes to a different person who once
held the same district number.

**The recommended method: check redundancy with LegiScan before investing in the fix, since LegiScan
already delivers complete correct MO House coverage.** Verified live, directly (not assumed from
`docs/DATA_INVENTORY.md`'s own pre-existing "LegiScan twin" phrasing): **100% of the ~22-24 bills
where `mo-house-xml` currently resolves ANY real cast already have a LegiScan vote for the same
bill.** Honesty caveat, stated plainly rather than overclaimed: this is bill-level overlap, not a
dedup-*certified* same-floor-vote match — `vote_duplicates` shows zero hits for these vote ids,
because the identical 1-person-roster gap that cripples `mo-house-xml` also starves
`isPrimaryCastDataComparable`'s certifier of enough individual casts to certify anything (the same
limitation already found on `HB1623-3` during the original vote-dedup design work). Bill-level
overlap is strong circumstantial evidence, not certainty, and was reported as such.

**Decision: deliberately deprioritized the roster-ingest-loop fix, not building it.** Given (a)
confirmed redundancy for 100% of everything this source currently *can* produce, (b) a real
build cost (~3.4 days of cooldown budget to wire up the already-defined fetch functions, plus a new
replay pass, plus careful navigation of the cross-era collision risk above), and (c) uncertain
payoff even for the 40 non-overlapping bills (their date ranges are interleaved with, not
systematically newer than, the overlapping ones, so "LegiScan just hasn't caught up yet" isn't a
clean explanation either way) — the fix isn't worth building right now. The pipeline itself keeps
running unchanged; its bill/action tracking and PDF-integrity-gated tally extraction are correct,
independent work, unaffected by this decision. The separate site-content decision (ship the MO
House vote gaps as-is vs. add an explicit caveat) remains open and remains Lance's call — this
investigation sharpened the evidence behind it, didn't resolve it.

Unrelated finding surfaced along the way, not investigated further: **zero MO House votes exist for
2024 at all** in the live dataset.

All four docs (`TODO.md`, `CLAUDE.md`, `docs/DATA_INVENTORY.md`, `docs/CONTROLLER_BRIEFING.md`)
updated with this finding and decision, each in its own established style (append-dated for the
docs/ files, direct correction for the two top-level status paragraphs that had overstated the
scope).

---

## 2026-08-05 (same day, continued) — the "162 of 163 show zero MO House votes" framing itself was wrong

Lance asked directly: "which is recommended: ship the MO House profile gaps as-is, or add a
completeness caveat to the site." Before answering, reconciled a tension noticed while re-reading
the evidence: the "~162 of 163 MO House members show zero MO House votes, forever" framing (carried
across CLAUDE.md, TODO.md, `docs/CONTROLLER_BRIEFING.md`, and to a lesser extent
`docs/DATA_INVENTORY.md`) sat awkwardly next to the SAME DAY's own earlier finding that LegiScan
alone resolves 424 distinct MO House legislators. Checked directly rather than propagate the
existing framing: for all 159 CURRENT MO House `terms` rows, does the legislator have ANY MO House
`vote_cast` at all (any source, not just `mo-house-xml`)? Ran as 159 individual per-legislator
existence checks (necessary — a single combined query hit PostgREST's 1,000-row cap and silently
returned a wrong, tiny-looking result on the first attempt, caught before it was reported).

**Result: all 159 of 159 current MO House legislators have at least one real MO House vote on
their profile, via LegiScan's own independent coverage.** Confirmed this is what actually renders,
not just what's in the database, by reading `site/js/person-page.js`: votes display generically by
chamber, with no adapter/source-based filtering that would exclude LegiScan-sourced MO House rows.
The "162 of 163 show zero" claim was correct only as "zero votes sourced from `mo-house-xml`
specifically" — reading it as "the profile page is blank" was wrong, and several docs (including
this project's own) had drifted into stating it that way without the qualifier.

**Recommendation given: ship as-is, no caveat.** A completeness caveat would warn users about a gap
that doesn't actually exist on the rendered page for virtually any legislator or vote — the real
residual gap is narrow (a handful of the most recent roll calls existing only via `mo-house-xml`
might be briefly missing until LegiScan's own periodic refresh catches up), not the systemic,
permanent blank section the prior framing implied. Lance: "fix it." All four docs corrected with
the verified numbers and the corrected decision (ship as-is, resolved rather than open).

**Process note:** this is exactly the kind of thing "reference all documentation first" is meant to
catch, and in this case the docs THEMSELVES were the thing that needed re-checking against live
data rather than trusted at face value — a useful reminder that this project's own accumulated
documentation is not automatically ground truth just because it was carefully written once; it
still needs re-verification against current live state before being relied on for a real decision.

---

## 2026-08-05 (continued) — a full deep audit, a budget call mid-flight, and a mechanical fix for the project's most recurring bug

Lance: "Now we need to run a full deep audit on the system using Fable5 and max effort with
multiple workflows... nothing should be left out... take as long as needed." Structured as four
sequential workflows so findings from each phase could be reviewed before committing the next
phase's scope: (1) code & architecture, every subsystem; (2) logical process/pipeline integrity +
test coverage; (3) intent/mission alignment; (4) synthesis + adversarial verification.

**Phase 1 launched: 25 parallel subsystem reviewers, Fable 5, max effort, full-file reads.**
Mid-run, Lance asked directly: "I have about 20% usage left for the week before reset in 2 days,
will this audit be able to complete?" Answered honestly rather than reassuringly — no tool exposes
exact account-usage percentage, but the two workflows already run this session (16 agents/1.49M
tokens; 5 agents/434K tokens) gave a real basis for comparison, and this phase's design (more
agents, full multi-file reads, the most expensive model at the most expensive effort tier) was
very plausibly several times larger than either. Presented four real options rather than picking
one silently. Lance: "let 1 run and we'll determine what to do when it finishes."

**Phase 1 result: 3.25M tokens, 679 tool calls, 25 agents, zero critical findings, 31 important.**
More than double the largest prior workflow this session, confirming the cost concern was real.
Read the full output (2,593 lines) rather than trusting the truncated notification preview, and
found several of the "important" findings were actually independent re-confirmations of ALREADY-
tracked TODO items (18/32's `summarize.js` unbounded selects; 31's `mo_house_id` cross-era trap) —
worth naming plainly rather than presenting known debt as fresh discovery. Synthesized the raw
findings into a ranked top-6 for Lance: a real security gap (`authenticated` retains EXECUTE on
`refresh_vote_aggregates()` across four migrations' worth of redefinitions, despite stated
service-role-only intent), the `mo_house_id` unique-constraint landmine (the exact bug already
fixed for `mo_senate_id` via migration 0009, never applied to the house column — sits directly on
the path of the open MO House vote-coverage TODO), a fresh-rebuild blocker in THIS SESSION'S OWN
`docs/DISASTER_RECOVERY.md` (migration 0027's `create extension pg_cron with schema cron` is
wrong — pg_cron is non-relocatable, pinned to `pg_catalog`; only worked live because the extension
was already enabled), a silent vote-misattribution path in the MO House PDF/action tally-tie
matcher, a wrong assumption baked into a test fixture (`FOUNTAIN HENDERS` treated as a genuine
2-word surname; almost certainly a print-truncated `Fountain Henderson`), and a race in
`person-page.js` that can poison the neutrality-critical "group of one" party-comparison guard.
The dominant PATTERN across the whole audit, not any single finding: the PostgREST 1,000-row cap
— already fixed once, with a shared `selectAll` helper built specifically to prevent recurrence —
kept resurfacing anyway, bypassed at roughly a dozen NEW call sites beyond the ones already known.

**Lance asked the harder, more useful question: "would another route [than PostgREST] be better,
or would that be a massive overtaking?"** Answered directly: no — the recurring bug isn't a
technology problem, it's an enforcement problem. `selectAll` already exists, is correct, and is
simply not consistently used; a different backend would relocate the same discipline gap, not
close it. Gave three ranked options (raise Supabase's `db-max-rows` setting as a free stopgap; a
mechanical enforcement test, matching this project's own established pattern of migration-text
tests and gate checks; a deeper direct-Postgres-connection swap for server-side-only code, real
but not proportionate to the actual problem) and recommended against the full-migration option
explicitly. Lance: "proceed with 1 and 2."

**Option 1 — db-max-rows: informational only, no dashboard access from here.** Verified current
Supabase guidance via live web search rather than trusting training-data memory (the supabase
skill's own core principle): Dashboard → Integrations → Data API → Settings, default 1000,
Supabase's own recommendation is to keep it LOW (payload-size protection against accidental/
malicious requests, a real tradeoff, not a pure win), and a known propagation-delay bug as of
March 2026 where dashboard changes may not take effect immediately. Documented for Lance; nothing
here was or could be changed by an agent.

**Before writing option 2, Lance: "be sure to read all of the lines in all of our documentation
prior to starting this as well."** Read every top-level doc in full (`CLAUDE.md`, `TODO.md` — all
852 lines, `PLAYBOOK_DELTA.md` — all 588 lines including sections 0-13 never read this session,
`README.md`, both `docs/audits/*.md` reports in full, all 2,243 lines of `CHATLOG.md` from the
very first entry through the point this session's own visible history begins) plus a targeted
sweep of the remaining 18 spec/plan/research docs for anything relevant. This surfaced two things
that materially changed the design before any code was written: (1) `docs/CONTROLLER_BRIEFING.md`
already documents a SEPARATE, still-open landmine — `mo_house_id` is `unique` with no
unique-violation handling (TODO 31) — that a naive roster-growing fix could trip; noted as a
constraint for any future fix, not touched here. (2) `docs/superpowers/specs/2026-07-30-public-
site-design.md` revealed the SITE side of the codebase has its own, separate pagination
convention — `fetchAllRows` in `site/js/rest.js`, the "browser's own selectAll" — distinct from
`src/lib/db.js`'s server-side helper. Missing this would have shipped an enforcement test that
only covered half the codebase's actual convention.

**Option 2 — built, tested, self-corrected before landing.** `tests/select-pagination-
enforcement.test.js`: a static scan for `.from(table).select(...)` not routed through `selectAll`
and not otherwise bounded, plus a parallel site-side check that no file importing Supabase
credentials calls the raw `fetch()` global directly (bypassing `rest.js`). First run surfaced 8
matches beyond the 19 already known from phase 1's audit — investigated each rather than assumed
real: all 8 turned out to be legitimate, already-documented exceptions (an `.eq()` filter on a
specific parent id — `vote_id`, `bill_id`, a seat's district column — inherently bounds the result
to that one entity's rows; this codebase's own comments already say so in multiple places, e.g.
legiscan-identity.js's "the chamber+district filter alone already bounds each query's result set
nowhere near the 1000-row page default"). Refined the detector to recognize `.eq()` as a bounding
signal (verified this doesn't clear any of the 19 real violations — none of them use a plain
`.eq()`, they use `.not()`/`.in()`/`.like()`/no filter, categorically broader operations) rather
than papering over the false positives with an allowlist entry that would have mischaracterized
reviewed, correct code as debt. One more false positive caught the same way: `directory-page.js`'s
`fetch('/geocode', ...)` is a legitimate, already-reviewed ("CONTROLLER RULING") same-origin
Cloudflare Function call, not a Supabase bypass — the site-side check was narrowed to only flag
files that import Supabase credentials AND call `fetch()` directly, not every direct fetch in
`site/js/` categorically.

Full suite 2,301 → 2,306 (5 new tests, including two sanity tests that lock in the `.eq()`
distinction so a future edit to the detector can't silently regress it). `TODO.md` NOW updated
with the real, dated debt list (8 files) the allowlist documents — not buried only in a test-file
comment. Phases 2-4 of the original audit plan remain paused on Lance's own budget call; resuming
is his decision, not assumed.

---

## 2026-08-05 (continued) — phase 2 of the deep audit: three of six pipelines fail their own documented guarantee

Phase 2 (logical-process/pipeline integrity — 6 pipelines traced end-to-end across file boundaries,
Fable 5 at max effort, 1.23M tokens) had already been launched before the budget conversation and
completed in the background while the option-1/option-2 work above was being done. Where phase 1
asked "is each FILE correct," phase 2 asked "does each PIPELINE actually deliver what it claims,
end to end" — deliberately hunting bugs that live in the SEAMS between files, which per-file review
structurally cannot see.

**Result: 21 important findings, and — the headline — three of six pipelines returned
`pipelineWorksAsIntended: false`.** Not isolated defects: three pipelines do not fully deliver
guarantees this project's own docs state as fact. Lance, seeing the budget running down: "add
everything to the todo.md/chatlog and update all documentation as we are about to hit limits on
usage." Captured rather than investigated further — no new agent spend, no fixes attempted.

**The two that matter most, both of which change what this project believes about itself:**

**1. The Pierson wrong-merge fix does not generalize, and the docs claiming it does are wrong.**
The 2026-08-03 accuracy audit found father/son Tommie Pierson Sr./Jr. auto-merged into one person;
the fix added a same-source-key contradiction guard to `finalPairStatus`, and `TODO.md` +
`docs/CONTROLLER_BRIEFING.md` both recorded that it "permanently prevents this class of wrong
merge." Phase 2 executed the shape through the real code and found the guard only fires when BOTH
rows populate the SAME per-person column (`bioguide_id`/`openstates_id`/`legiscan_people_id`) — so
it covers LegiScan-vs-LegiScan pairs and essentially nothing else. The dominant real case, and the
entire reason this subsystem exists, is merging rows ACROSS five different sources, each of which
stamps a DIFFERENT column — those pairs can never trigger the guard at all. The exact Pierson input
shape (identical printed name, empty/dateless seat evidence) still auto-merges silently today when
the two rows come from different sources. The code's own inline comment is honest about this
("ACCEPTED RESIDUAL"); the audit-trail docs are what overstated it. Worth naming plainly: this
project's discipline of writing down what was fixed is exactly what let a too-broad claim harden
into believed fact across two documents — the corrective is that a fix's SCOPE has to be recorded
as carefully as the fix itself.

**2. Quarantine — the mechanism that's supposed to stop contradicted vote data reaching the public
— is dead code, and today's SB 914 fix was the accidental proof.** `legiscan-votes.js`'s module
header still states "possibly-contradicted data must never be publicly reachable." Phase 2 traced
every production branch of `crossCheckAgainstPrimarySource` and found quarantine unreachable from
all of them (hardcoded `quarantine: false` in Branch B; structurally impossible on both
tally-unique paths after the IMPORTANT-5 change). `retractLegiscanVoteIfStored` can only fire via
injected test fakes. Net: a hard-mismatch pair stays fully double-counted on every public surface —
all three matviews, `public_votes`, `public_vote_feed`, the bill page — from detection until a
human writes a bespoke, hardcoded, one-flag-at-a-time correction. That is *precisely* what
happened earlier today with SB 914: a new `correct-data.js sb914-reconcile` correction hardcoded to
one flag UUID. At the time that read as "implementing Lance's ruling"; phase 2 shows it was also
the only mechanism that exists, and ~48 other open reconciliation flags each need the same
treatment. The gap isn't SB 914 — it's that there's no general "adjudicate flag N" tool and the
module documents a safety property it no longer has.

**The rest, all real, all cataloged in `TODO.md` NOW rather than restated here:** a silent
wrong-SPLIT class in identity linking (era-blind district contradictions split one real person into
two with zero flags — same multi-era-backfill trigger as TODO 31, opposite direction, previously
undocumented); a duplicate-vote invisibility class where two rows for the same real vote coexist
fully counted with no flag AND no record if they disagree on bill/date/chamber rather than tally
(already happened live three separate ways — the 2026 session split, the MO House chamber
mislabels, the 1969 sentinel dates — each fixed as a one-off, the class still undetected); public
receipt quotes (`evidence_quote`, `supported_by_quote`) never mechanically verified as verbatim
substrings of their cited source, the single point where a model's self-report is trusted straight
into public output despite `trust.html` claiming "the exact quoted excerpt"; `src/cli/ingest.js`'s
production write path (the live `npm run ingest`) having essentially no test coverage on its
database-writing functions plus 4 more unbounded selects inside that untested code; and
`scripts/data-status.js` — the tool `CLAUDE.md` designates as the authoritative source for live
numbers — having zero coverage, being structurally untestable as written, and having already
silently drifted from the regex it claims to mirror.

One correction to a doc claim worth noting separately because it's about the scheduler's own
advertised behavior: `docs/SCHEDULED_INGESTION.md` says a tick is "never more than ~15 minutes
late," but the 5-source registry is structurally oversubscribed (~6 runs/hour of demand against 4
runs/hour of capacity — one source per 15-minute tick), so in steady state every source converges
to an ~hourly rotation, with the two MO sources running at roughly 2x their own 30-minute cooldown.
The doc's own quoted live data (02:00/02:15/02:45/03:01) is that hourly rotation, not the
cooldown-edge service it describes. Safe direction — nothing is lost, ToU is never violated,
worst-case service latency is provably bounded around 75 minutes — but the documented bound is only
true when at most one source is due at a time, which live logs show is not the normal state.

**Phases 3 (intent/mission alignment) and 4 (final synthesis + adversarial verification of every
phase-1/phase-2 finding) were never run** — paused on Lance's budget call and still paused. Worth
stating honestly for whoever picks this up: every phase-2 finding above is a SINGLE-agent finding
that has NOT been through the adversarial re-verification step both prior audits used, and this
project's own history (the 2026-08-03 accuracy audit refuted 3 of its own findings under
adversarial pressure) says that step routinely kills or reshapes real-looking findings. Treat the
list as high-quality leads, not as confirmed defects, until phase 4 or an equivalent pass runs.

---

## 2026-08-05 (continued) — "can we fix #1?": the general flag-adjudication tool, and half a finding retracted

**Lance:** "can we fix #1?" — the phase-2 headline finding: reconciliation-flag quarantine is dead
code, and ~48 open flags each need a bespoke one-off correction like the `sb914-reconcile` written
earlier the same day.

**Checked the premise before building anything, and half of it did not survive.** Grepped CHATLOG
for the quarantine design history: the 2026-07-29 final whole-branch review established, and
fuzz-confirmed over 200k inputs, that *"machine-proven quarantine is a null set at this data
granularity — correspondence proof requires tally agreement, contradiction requires disagreement;
cross-source disputes are permanently human-review flags with primary-wins display."* Quarantine
being unreachable from production is therefore a **deliberate, reviewed, evidence-backed retirement**
— not the accidental breakage phase 2 read it as. Building "make quarantine work again" would have
re-litigated a settled ruling using a single unverified agent's framing as the reason. This is
exactly the failure mode phase 4 (the adversarial pass that never ran) exists to catch, and exactly
what this project's own history predicts: the 2026-08-03 accuracy audit refuted 3 of its own 16
findings under adversarial pressure.

**What was genuinely real, and got fixed:**

1. **A false safety claim in the code.** `legiscan-votes.js`'s module header still asserted
   "possibly-contradicted data must never be publicly reachable" — a property the code deliberately
   abandoned. Corrected in place (marked SUPERSEDED with the doctrine, its date, and the reason)
   rather than deleted, since the `quarantine` return value that paragraph documents still exists in
   the function's contract and its tests. A code comment claiming a safety guarantee the code does
   not have is worse than no comment.

2. **No general adjudication path — the actual gap.** `sb914-reconcile` was hardcoded to one flag
   UUID; there was no way to resolve flag N without writing new code. Built
   `correct-data.js reconcile-flag`, generalizing exactly what that one-off did.

**Design, and what it deliberately refuses to do.** It never inspects tallies, never picks a winner,
never infers which source is right — the operator names both vote rows and supplies a mandatory
`--ruling` and `--rationale`. That is load-bearing, not laziness: attributing a specific
legislator's public vote record is a human call (CLAUDE.md's one non-negotiable, and the same
reason SB 914 waited on Lance's own "trust senate journals" ruling despite strong evidence already
being in hand). Two modes, because the four flag reasons need different outcomes: **supersede**
(names canonical + superseded, writes the `vote_duplicates` exclusion — the SB 914 / `hard_mismatch`
shape, non-destructive, neither `votes` row ever touched) and **resolve-only** (no vote ids — closes
the flag with a recorded ruling and no dedup write; the honest outcome for "both rows are genuinely
distinct real votes," "no counterpart exists after all," or "not actionable until the MO House
roster gap is fixed," which covers most of the 20 `primary_cast_data_not_comparable` flags).

**Mechanical guards, every one tested:** one of the two supplied vote ids MUST equal the flag's own
`vote_id` — the typo guard against superseding an innocent, unrelated vote row, which is the single
worst thing this tool could do and the cheapest to prevent (**verified live**: fed it two real,
valid, but unrelated vote uuids from the SB 914 pair and it correctly refused with
`vote_ids_unrelated_to_flag`); both vote rows must actually exist; a half-specified dedup is refused
outright rather than silently downgraded to resolve-only (silently not doing what was asked is worse
than failing); re-superseding under a different canonical row is refused; ruling and rationale are
both mandatory; re-running is a clean, honest no-op. The full adjudication is appended INTO the
flag's own `discrepancy` JSON alongside the original evidence, never replacing it — the ruling and
the evidence it rested on stay together permanently.

**Live queue is 107 open flags, not the ~48 the older audit cited** — 61 `hard_mismatch`, 22
`no_tally_corresponding_primary`, 20 `primary_cast_data_not_comparable`, 4 `ambiguous_tally_match`.
Draining it is now operator work instead of one code change per flag. Nothing was written live this
pass: 10 new tests, a dry-run against a real open flag, and the refusal path verified against real
data. Full suite 2,306 → 2,316, `ℹ fail 0`, gated on the extracted count as always.

---

## 2026-08-05 (end of session) — pre-restart documentation sync, and a phantom regression caught in the act

**Lance:** "update all documentation, chatlogs, readmes, manuals, todos, claude.md and any other
important items... I've had to do this before but the resume wasn't what Claude said it would be
because it simply wasn't in sync with the previous session no matter how hard we tried to restore
the memory. I need to update VS code and restart the machine."

The ask is not "write more docs" — it is "make the resume actually work." The failure mode he
named is specific and this project has a documented history of it: docs assert a state, the live
system has moved on, a fresh session trusts the docs, and the session is spent reconciling the two.
So the method was inverted from the usual: **verify live reality FIRST, then write docs against
what was verified**, never against what the existing docs claimed.

**Live state confirmed before writing anything** (all re-derived, none copied): git clean at
`9fcc555`, everything pushed; 30 migration files on disk, **all applied** — nothing awaiting an
apply; suite 2,316 pass / 0 fail; votes 10,119 · vote_casts 1,467,896 · bills 38,254 · legislators
1,607 · vote_duplicates **62**; 115 published summaries, 116 published glossary terms; open queues
107 reconciliation flags / 0 identity flags / 98 draft summaries / 2,103 draft glossary terms; all
five scheduled sources ticked today and `refresh-aggregates` succeeded at 15:00 UTC via pg_cron.
Two of those numbers are worth reading as signals rather than trivia: `vote_duplicates` moved 59 →
62 on its own, which is the live ingest path marking new cross-source duplicates unaided — the
dedup feature working end-to-end, not drift; and the healthy pg_cron tick is the 3-layer timeout
saga staying closed a day later.

**A red suite appeared mid-verification, and it was not real.** The batched health-check command
sourced `.env` into the shell and then ran `node --test` in that same shell — the suite came back
with `review-logic.test.js` failing `expected: 500, actual: 200`. Two subsequent clean runs were
green, which made it look like a flake. It is not a flake: sourcing `.env` exports the Supabase
credentials into the test process, so the two tests that assert the review server degrades cleanly
when **no** DB client is configured get a real client and correctly return 200 where they correctly
expect 500. Proven deterministically in both directions (clean shell 181/0; `.env` sourced 179/**2
fail**) rather than left as a shrug. Both the tests and the code are right; the shell was
contaminated — by my own convenience batching. Captured as PLAYBOOK_DELTA **lesson 27**, a standing
rule in `CLAUDE.md`, a README runbook warning, and its own auto-loaded memory, because the symptom
(a red suite immediately before a machine restart) reads exactly like "we broke something" and
would have cost a future session a bisect hunt for a break that never happened.

**What was written, ordered by what a resuming session actually reads first:**

1. **Auto-loaded memory** (`~/.claude/projects/f--VisibleGov/memory/`) — highest leverage, since it
   loads into every session without anyone asking. `deploy-last-backend-first` was actively
   dangerous as written: it said "no Cloudflare until the backend is locked," which would have made
   a fresh session **refuse or defer the very deploy Lance just green-lit**. Rewritten to record
   that the gate is MET, that he raised it himself, and what the short remaining pre-deploy list
   is. Added `never-source-env-before-node-test`. Index updated.
2. **`TODO.md` — a new `⏱ RESUME HERE` block at the very top.** The structural problem was that
   NOW had grown to ~500 lines with resolved items at the top, so "read TODO.md NOW" pointed a
   fresh session at finished work and buried the open items. The new block states live-verified
   state, names the Cloudflare deploy as THE next thing, lists the four pre-deploy items, separates
   genuinely-open work from noise, and says plainly that everything below it is historical.
3. **`CLAUDE.md`** — a fresh-session banner at the top pointing at RESUME HERE and naming the two
   traps that cost a session cold (the `.env` one, and "all 30 migrations are applied, any text
   saying otherwise is stale"). The Cloudflare standing rule was rewritten from "do not propose
   deploying" to "GATE MET, this is the active task" — left visible with its history rather than
   deleted, so the reasoning survives. Stale PLAYBOOK lesson count corrected.
4. **`PLAYBOOK_DELTA.md`** — lesson 27.
5. **`README.md`** — status banner moved to 2026-08-05 with the deploy named as active, plus the
   test-shell warning in the runbook where someone would actually hit it.

**The honest caveat, recorded because overclaiming here is what caused the original problem:** this
sync makes the *state* trustworthy — what is applied, what is open, what is next, what will bite
you. It cannot make a resumed session remember the *reasoning* behind every past decision; that
still lives in this CHATLOG, and the audit passes proved that reading it in full is what separates
a real finding from a superseded design being re-litigated (the quarantine finding earlier today is
the clean example). A future session that skips the log will still make that class of mistake.

---

## 2026-08-05 (continued) — pre-deploy items 1-3 built

Lance, after the resume-path check came back clean: "yes" — knock out the three buildable
pre-deploy items while he decides 3a/3d (Cloudflare account, preview-build policy).

**1. `geocode.js` security headers.** Cloudflare Pages Functions do NOT inherit `site/_headers` —
that file governs static assets, and a Function's `Response` is returned as-is. So production
`/geocode` shipped with zero CSP, zero nosniff, zero Referrer-Policy while every static page
carried the full set. Local dev hid it completely: `serve-site.js` parses `_headers` at runtime and
applies it to every response *including* `/geocode`, so dev looked correct and only production was
bare — a dev/prod divergence is exactly why this survived until a deploy review.

The design problem was avoiding a third source of truth. Today there are two consumers with one
source (`_headers`, and `serve-site.js` which parses that same file). A Function can't read the
filesystem at runtime, so it genuinely needs the values as a static import — a real second copy.
Made safe the only honest way: `site/js/security-headers.js` holds the constant, and a test asserts
it equals `_headers`' `/*` block key-for-key and value-for-value. **Proved the guard red-then-green**
by injecting a deliberate mismatch (`Referrer-Policy: origin`) and watching the suite fail, then
restoring — per this project's own lesson 15, a guard nobody has seen fail is not yet a guard. All
five response paths were covered, error paths included; a second test walks every `Response.json`
call in the file and fails if any lacks the headers, so a future edit can't quietly add a bare one.
Follows the `copy.js` precedent (one string, two consumers, pinned by a test).

**2. `site/404.html`.** Built with zero JavaScript, deliberately: every other page boots a
`/js/boot-*.js` module that reads Supabase, but a 404 page has to render when the thing that broke
IS the site (partial deploy, bad path, CSP problem). A 404 that depends on a working data layer can
show a blank screen at the exact moment someone needs an explanation. No footer either — rather
than hand-copy a static lookalike of what `mountFooter` renders at runtime and create another
drifting copy. Also updated `serve-site.js` to serve it on a miss (it returned `text/plain "Not
found"`), so dev exercises the real 404 page instead of hiding the difference — the same
dev-mirrors-production principle whose absence caused item 1.

**3. `0030_revoke_refresh_aggregates_from_authenticated.sql` — drafted, awaiting Lance's apply.**
All four definitions of the function (0018/0022/0026/0027) revoke PUBLIC and `anon` but never
`authenticated`, so Supabase's stock default EXECUTE grant on public-schema functions survived every
pass — while 0018's own comment claimed it was "executable only by service_role." Scoped honestly in
the migration header: not anon-reachable, the public site never authenticates, so exploiting it
needs a real signup; with one, a caller could invoke a SECURITY DEFINER function that writes
`ingestion_runs` rows feeding the public freshness signal, contending locks with the legitimate
pg_cron tick. A nuisance/contention vector, not data integrity — and trivially closed. Timing is
deliberate: deploying publishes `site/config.js` with the real project URL, so the gap doesn't
change but its discoverability does.

The accompanying test asserts the revoke exists **and sorts after the newest definition** of the
function. That ordering is the real guard: `CREATE OR REPLACE` preserves privileges, but a
`DROP`+`CREATE` resets them to schema defaults and would silently hand `authenticated` its EXECUTE
back — so a future redefinition is forced to re-assert the revoke.

Suite 2,316 → **2,321**, `ℹ fail 0`, run in a clean shell per lesson 27. Items 1 and 2 need nothing
from Lance; item 3 is the only outstanding apply in the repo, and 3a/3d remain his calls.

---

## 2026-08-05 (continued) — 0030 applied and verified; Cloudflare domain question opened

**Lance:** "0030 has been ran and as for cloudflare, I have an account already but I already own the
domain helpingpeoplehelpingpeople.com so I'll just have cloudflare take over for namechange if that
works?"

**0030 verified, not assumed.** Role privileges are not queryable over PostgREST, so this needed a
read-only query in the SQL editor rather than an agent-side check — handed Lance the
`information_schema.role_routine_grants` one-liner instead of declaring it done. Result:
`service_role` and `postgres` hold EXECUTE, **`authenticated` absent**, `anon`/PUBLIC absent. The
gap is closed.

Then checked the thing that actually could have gone wrong: whether revoking a privilege on a
`SECURITY DEFINER` function broke its legitimate callers. It did not — `ingestion_runs` shows
`refresh-aggregates` succeeding at 19:30/19:00/18:30 (pg_cron, running as `postgres`) plus an
off-boundary 19:15 (the scheduler's own `scripts/refresh-aggregates.js` call, running as
`service_role`). Both paths confirmed alive after the revoke. This is the check worth doing every
time a grant changes: proving the thing you removed access from is the ONLY thing that lost access.

**On the domain — surfaced a real risk rather than just saying yes.** Read the LinkedUmp
PLAYBOOK_DELTA in place first, because this project's own §7 lesson 5 explicitly says to do that at
deploy time. It paid: LinkedUmp documents a four-phase deploy runbook (Pages deploy → verify on
pages.dev → zone/NS → custom domain → auth config) and a specific trap — *"Registrar cruft fights
your DNS. Fresh domains carry a parking A record, a parking `www` CNAME, five `eforward` MX and an
SPF TXT — all dead weight after moving nameservers (the forwarding only works on Namecheap DNS).
Delete all imported records before attaching the Pages custom domain."*

Three points made back to Lance: (1) "Cloudflare takes over" conflates two separate things — moving
NAMESERVERS (free, keeps the registrar, all he needs) versus TRANSFERRING REGISTRATION (optional,
unrelated); (2) an NS move affects the **entire zone**, not just the `visiblegov.` subdomain he
plans to use, so if that domain carries email forwarding the move breaks it unless MX records are
recreated in Cloudflare — the one mistake here with off-project consequences; (3) a lower-risk
alternative exists for a subdomain deploy: leave DNS where it is and add a single CNAME, touching
nothing else on the domain. **Asked him directly whether that domain currently carries email**
before recommending one over the other — the answer changes the recommendation.

Also reiterated his own 2026-07-28 sequencing ruling, which LinkedUmp's runbook independently
agrees with: **`.pages.dev` first, verify, custom domain as a separate later phase.** Doing the
deploy and the DNS at once means a broken result is ambiguous between the two. One LinkedUmp lesson
checked and explicitly ruled NOT applicable: "different origins = different sessions" concerns
logins, and this site has no auth at all (anon key only).

Awaiting his answer on the email question before any DNS work.

**Lance:** "I have nothing at helpingpeoplehelpingpeople.com it is just a one pager I made with
caard.io, it is garbage anyways, no hard feelings if it's gone."

That answers the risk question — no email to preserve, the zone is disposable, so moving nameservers
to Cloudflare is the clean path and the caard.io page disappearing is expected (its DNS records do
not survive the move). Kept one small caveat rather than dropping it entirely: he answered about the
*website*, and the thing that breaks silently is *email* — registrars often add default forwarding
nobody set up on purpose. So the runbook says to glance at the imported record list for `MX` before
deleting the parking cruft, rather than assuming.

**Wrote `docs/CLOUDFLARE_DEPLOY.md` instead of finishing the deploy spec.** The paused brainstorm
had sections 2 and 4 outstanding — but section 2 was "implementation detail of the two fixes," and
those are now built and pushed, so a spec for them would be describing existing code. What was
actually still missing was the runbook and the verification checklist. Four phases, matching both
LinkedUmp's own runbook and Lance's 2026-07-28 sequencing ruling: create the Pages project
(`.pages.dev` only) → verify with curl **at the origin** → move nameservers → attach the custom
domain, re-running every check because headers/redirects/Functions are host-sensitive and passing on
`.pages.dev` does not prove them on the custom domain.

The inherited traps are written next to the step that triggers them rather than in a preamble
nobody re-reads: Cloudflare's UI funnels to Workers (it is Pages tab → Connect to Git — LinkedUmp
hit this twice, a year apart); framework preset must be **None** or a build command gets injected;
root directory must be `site` or `_headers`/`_redirects`/`functions/` are never discovered; verify
with curl not a browser screenshot because Pages ignores `Cache-Control` overrides for assets and a
browser will show a cached lie; and delete the registrar's parking A/`www` CNAME/SPF/eforward
records before attaching the custom domain.

Ruled 3d (preview builds) with a recommendation rather than leaving it hanging: **leave the default
on**. The data is meant to be world-readable, the anon key is public by design, RLS is the wall, and
there is no auth session to confuse across origins — the concerns that make preview deployments
risky elsewhere do not exist on a public-transparency site. Flagged as recommended-not-ruled.

Closed with LinkedUmp §4.2's status ladder, because this project has over-claimed before: **built →
deployed/viewable → live**. A URL that resolves is *viewable*. Until someone other than Lance has
looked up their own representative and gotten a useful answer, the honest phrasing is "deployed, in
owner testing."

**Lance:** "HPHP (helpingpeoplehelpingpeople.com) does not have any email fucntions" — explicit
confirmation, which collapses the one genuine risk in Phase 3. The runbook's DNS step changes from
a judgment call ("if MX records appear, stop and decide") to a clean sweep ("delete all imported
records, nothing here needs preserving"). Worth noting *why* the caution existed rather than just
deleting it: the failure mode is silently killing email a registrar added by default that nobody
remembers setting up — it does not announce itself, it just stops arriving. With the zone confirmed
empty of email, that failure mode is off the table entirely and a clean zone is strictly better
anyway, since leftover records fight the Pages custom-domain attachment (LinkedUmp §4.3).

Every open question on the deploy is now answered. Nothing code-side remains; the next action is
Lance's, at the Cloudflare console, following `docs/CLOUDFLARE_DEPLOY.md` Phase 1.

---

## 2026-08-05 (continued) — deploy runbook reviewed against the code, four gaps closed

**Lance:** "Review the cloudflare_deploy document and ensure it still matches our intent. make
changes if needed and document in other documents if needed then provide feedback on those changes
and the next steps needed to deploy."

Reviewed it the way this project has learned to review its own docs — by checking claims against
the code rather than re-reading the prose. Four real gaps, one of which was a genuine risk nobody
had named:

**1. The highest-risk item in the deploy was not called out anywhere.**
`site/functions/geocode.js` imports `../js/security-headers.js` — a module OUTSIDE the `functions/`
directory. That import was written today and has never run in Cloudflare's environment; it works
locally only because Node resolves it directly. Pages bundles Functions with esbuild and normally
follows relative imports fine, so it is *expected* to work — but expected is not verified, and this
is the only piece of the deploy with zero prior production evidence. Added a callout with the blast
radius stated honestly (if it fails, `/geocode` 500s and address lookup breaks; everything else —
directory, profiles, votes, bills — is unaffected) and two concrete fixes (move the constant inside
`functions/`, or inline the three values and re-point the drift test). Explicitly framed as "run
this check first," NOT as a reason to delay.

**2. Project name was missing from the settings table** — it is the first field in the wizard and
permanently determines the `<name>.pages.dev` URL. It was in TODO.md's older notes but never made it
into the runbook.

**3. LegiScan attribution was not in the verification checklist.** This is a binding ToU term
(`docs/research/2026-07-28-legiscan-terms.md` rule 10: CC BY 4.0 attribution *with link* on every
public surface displaying their data) and deploying is the exact moment it starts applying. Traced
the implementation before writing the check: `trust.html` carries the full notice with its license
link, and `mountFooter` puts an "Attribution" link to `/trust#attribution` on every page. CC BY 4.0
§3(a)(2) explicitly permits satisfying attribution via a hyperlink to a page carrying the notice, so
the site is compliant as built — the added step confirms it survived the deploy, it does not
redesign anything. Also added a browser check that address lookup actually returns representatives,
since the curl check only proves the Function's plumbing, not the feature.

**4. No failure/rollback guidance.** Added: Pages keeps every deployment and can roll back to any
prior build, a failed *build* publishes nothing at all, and — the part worth saying plainly —
**nothing in this deploy touches the database**, so a bad deploy is cosmetic and fully reversible
while the scheduler and all ingestion keep running untouched.

Re-verified every factual claim the runbook makes against the actual code (the import path, the
`#attribution` anchor, the footer link, the `_redirects` rule) rather than trusting the document it
was describing. Suite still 2,321/0.

---

## 2026-08-05 (continued) — Lance catches a real error in my own runbook, mid-wizard

**Lance**, at the Cloudflare Pages "Set up builds and deployments" screen, screenshot attached:
"Do I need any changes to this?"

His config: project name `visiblegov` → `visiblegov.pages.dev`, production branch `main`, framework
preset **None**, build command empty, **build output directory EMPTY**, root directory `site`, no
environment variables.

**Answer: no changes — and the runbook I wrote for him was WRONG on one field.** `docs/
CLOUDFLARE_DEPLOY.md`'s settings table said *Build output directory: `site`*. Combined with *Root
directory: `site`* — which the same table also (correctly) requires — that resolves to
`<repo>/site/site/`, a path that does not exist. Build output directory is measured **relative to**
root directory. He had it right by leaving it empty; following my table literally would have failed
the build.

The reasoning error, named precisely because it is the reusable part: I derived each field
independently from the repo layout ("the site lives in `site/`" — true for either field in
isolation) instead of asking what each field is measured FROM. Two values that are each correct
against the filesystem can be wrong against each other the moment one is relative to the other. And
a table listing `Root: site` / `Output: site` on adjacent rows *looks* internally consistent — the
composition is exactly what a consistency check cannot see.

Corrected the table, and documented both valid configurations plus why we need this one
specifically: **root `site` + output empty** is required because Pages discovers `functions/`
relative to the ROOT directory, so it is what makes `/geocode` deploy at all. The alternative (root
empty + output `site`) would serve the static files perfectly well while silently NOT deploying the
Functions directory — a failure that would have looked like a bug in `geocode.js` and been debugged
in entirely the wrong place.

**PLAYBOOK_DELTA lesson 28** written from it: for every path field in a deploy console, write down
what it is relative to before writing its value, and when two path fields share a form, state their
relationship in the doc rather than just their values. Also recorded the meta-point — this is the
second time in this project that a human comparing a document against live reality caught something
no amount of internal consistency-checking would have (the first being the resume docs drifting from
live DB state). Runbooks should be built to be *checkable* — exact field names, one value per row —
so that comparison stays cheap enough to actually happen.

Nothing was deployed yet; he asked before clicking Save and Deploy.

---

## 2026-08-05 (evening) — FIRST DEPLOY: visiblegov.pages.dev, one real bug found live, root-caused, fixed

**Lance:** "https://visiblegov.pages.dev/" — Phase 1 done, first deploy live.

**Phase 2 verification, in the runbook's order.** The called-out highest-risk item passed first:
the geocode Function's cross-directory import (`../js/security-headers.js`) bundles fine in
Cloudflare's environment — `/geocode` returned 200 with real Census data (5,085 bytes) AND all
three security headers on the response, today's header fix working in production on its first
exposure. The 400 error path carries the headers too. Static pages serve the full `_headers` CSP.
The 404 page works.

**Check 4 failed, and it was real: every `_redirects` rule was broken in production.** `/trust`
returned 308 → `/trust` — an infinite redirect loop, trust page unreachable. `/person/<uuid>`
returned 308 → `/person` — the uuid STRIPPED from the URL, breaking every deep link to a
legislator or bill. That is the core of the product.

**Root cause, diagnosed against the live deploy rather than guessed:** Cloudflare Pages
automatically canonicalizes `.html` paths to extensionless with a 308 (`/person.html` → `/person`,
`/index.html` → `/` — all verified live). Our `_redirects` targets pointed AT `.html` files, so
Pages immediately redirected away from every rewrite target. Local dev never caught it because
`scripts/serve-site.js` resolved rewrites straight to files on disk and never emulated the
canonicalization — the SECOND dev/prod divergence found on this one deploy (first: Functions not
inheriting `_headers`).

**Fix, both halves:** `_redirects` targets are now extensionless (`/person/*` → `/person` etc.),
which is what Pages actually serves, so the rewrite lands with no redirect and the uuid survives in
`location.pathname` where the page's JS reads it. `/trust` needs no rule at all — Pages serves
`trust.html` at `/trust` natively; the rule that used to exist is precisely what looped it. And the
dev server now mirrors both behaviors (308 canonicalization + extensionless serving) so this
divergence class is closed, not just this instance.

**A wrong first implementation, caught by existing tests and corrected against production
evidence:** the first pass canonicalized every `.html` unconditionally — two existing tests went
red on `/does-not-exist.html` becoming a 308. Before "fixing" the tests, checked what production
actually does: it returns 404 for a nonexistent `.html` — Pages only redirects what it can serve.
The tests were right, the implementation was wrong; corrected to canonicalize only when the target
file exists. Every new test's expectation was verified against the real visiblegov.pages.dev
response first, not inferred from docs.

Suite 2,321 → 2,325. The push auto-deploys; re-verification of the failed checks runs against the
new build next.

---

## 2026-08-05 (deploy night, continued) — first real-browser walk on prod finds a live 500; a THIRD instance of the 0029 planner trap

Lance moved to Fable 5 / max effort for the deploy verification: "ensure they are correct, document
as you go so we can troubleshoot easier."

**The redirect fix verified clean first.** Polled until the new build went live (signal: /trust
flips 308 -> 200, ~30s), then ran 21 mechanical curl checks against visiblegov.pages.dev — all 21
pass: every rewrite serves the right shell at the original URL with the uuid intact, /trust loads,
existing .html still 308s, missing .html 404s, geocode returns real Census data with headers on
both success and error paths, the 404 page renders, root serves the directory.

**Then a real browser walk — and it caught what curl could not.** The directory rendered 1,567 real
legislator/person links, zero console errors, privacy contract present. Clicked into a merged-person
profile (Jason Bean) and hit a console error: `public_vote_feed` fetch -> **HTTP 500**. This is why
the runbook insists on a browser pass beyond the curl checks: curl proved every ENDPOINT resolves;
only actually loading a profile exercised the specific query that fails.

**Root-caused against live data, not guessed.** Reproduced the exact failing query directly: as anon
(the browser's role) it returns `57014 canceling statement due to statement timeout` after ~3.2s; as
service_role, the identical query returns 200 in ~2.2s. anon's role-level statement_timeout is 3s
(0028's inventory). So the query genuinely costs ~2-3s and only anon has a budget tight enough to
cut it — every anonymous profile loses its vote list, the core surface of the product.

**It is the SAME planner trap 0029 fixed, in the two objects 0029's sweep missed.** The live
`public_vote_feed`/`public_votes` (definitions from 0023) still exclude superseded votes via
`left join vote_duplicates vd on ... where vd.id is null` — the exact idiom 0029 proved (via EXPLAIN
against the live DB) that Postgres misestimates as 1 row vs. ~10,044, cascading into nested loops
over ~1.4M rows. 0029 rewrote the three MATVIEWS to NOT EXISTS; the two plain VIEWS carrying the
identical idiom were never touched, and the regression test written with 0029 covered only the
matviews. A scoping gap in the fix AND its test.

**Why it stayed hidden until deploy night, in honest order:** when the site was browser-verified
locally on 2026-08-03, `vote_duplicates` held 0 rows — nothing to anti-join, nothing to misplan
slowly. The 59-pair backfill landed later that day; live ingest has since marked 3 more (62); casts
grew to ~1.468M. Somewhere in there the query crossed anon's 3s budget. The Cloudflare deploy did not
cause this — it was simply the first check ever run as anon against current data volume. This is the
THIRD live surfacing of this one idiom (matview refresh timeout -> 0029; now anon view timeout ->
0031), which is exactly why the fix this time is the idiom class, not just the instance.

**Fix + the gap that let it through, both closed:**
- `0031_fix_public_views_antijoin_planner_misestimate.sql` — byte-identical view definitions to
  0023 (same columns, same owner-bypass no-security_invoker posture, same grants) with ONLY the
  anti-join rewritten to NOT EXISTS. Semantically identical (`superseded_vote_id` is UNIQUE). Draft;
  Lance applies; the migration header carries the exact anon curl to verify with.
- The regression test now covers `public_vote_feed`/`public_votes` too, not just the matviews. Proved
  it red-green properly: hid 0031 -> 3 fail (the views' latest def reverts to 0023's LEFT JOIN);
  restored -> 7 pass. Along the way the test's own `create view ${name}\b` regex had a real bug — `\b`
  in a JS template literal is a BACKSPACE escape, so the pattern matched nothing and the test was
  vacuously green; caught it because the red-green proof did NOT flip as it should have, fixed it via
  a script file per lesson 25 (never diagnose backslash bugs through a shell one-liner), byte-checked
  the fix, and only then got a genuine 7/0 <-> 4-fail flip.

Suite 2,325 -> 2,328. **Everything else on the deployed site is correct** — this is one broken query
behind one fetch, not a broad failure. TODO.md RESUME HERE now leads with "apply 0031 first."

**Lance: "0031 has ran"** — verified on both axes, not just speed. (1) The exact query that 500'd
returns 200 in 0.27s as anon (~12x under the old 3.2s timeout); public_votes 0.13s. (2) Dedup
semantics intact — a known superseded vote with 33 real base-table casts shows 0 rows in
public_vote_feed, and the feed excludes 2,045 casts overall (real arithmetic, not an accidental
empty set). Then the definitive check: the real-browser walk that originally caught the bug.
Profile (Jason Bean) now loads with ZERO console errors — 162 vote rows with bill links, plus
populated aggregate charts (Position distribution "Yea 846 96.5%, Nay 8 0.9%"). Clicked a vote
through to its bill page (HB 3080): sponsors, plain-language summary, roll-call tallies all render,
zero errors. The full product loop — directory -> profile -> real votes -> bill -> tally — works on
the deployed site. The deploy-night regression is fully closed; TODO RESUME HERE updated to drop
the blocker and point at the custom-domain phases as next.

---

## 2026-08-05 (late) — milestone documentation sync: deployed, and every doc reconciled to live state

**Lance:** "Update all documentation" / "And update them all in full detail." The site is deployed
and verified; time to make every doc match reality before the state drifts out of anyone's memory.

Method, deliberately inverted from the usual (and from the exact failure mode this project has
been burned by): **verified live state FIRST, wrote docs against what was verified, never against
what the docs already claimed.** Authoritative snapshot: git clean @ 6c85bd0 all pushed; 32
migrations (0001-0031 + 0018a) ALL applied; votes 10,128 / vote_casts 1,468,297 / bills 38,255 /
legislators 1,607 / vote_duplicates 62; 115 published summaries; 107 open recon flags; site LIVE at
visiblegov.pages.dev (200); suite 2,328/0 in a clean shell.

**Lesson 27 fired on me AGAIN, mid-sync, and I caught it in the act** — the live-count checks ran
in a shell with `.env` sourced, and when I appended `node --test` to that same shell the suite
reported 2 fail (the review-logic "no DB client" tests seeing a real client). Re-ran clean: 2,328/0.
A live re-demonstration that the trap and its documentation are correct, and exactly why "run tests
in a clean shell" is now a top-of-CLAUDE.md banner item. Left a note about this recurrence IN the
banner.

**Updated, myself, with full session context (not delegated — a context-free subagent is a worse
writer for reasoning-dense docs, and this session's whole theme is that context-free findings
drift):**
- **CLAUDE.md** — fresh-session banner now leads with "site is DEPLOYED and verified live," 32
  migrations applied, custom-domain-only remaining; the Cloudflare standing rule flipped from
  "active next task" to "DONE," with the two deploy-night bugs named; counts corrected throughout.
- **TODO.md RESUME HERE** — leads with the live URL and the verified product loop; migration count
  32; "THE NEXT THING" narrowed to Phases 3 & 4 (Phase 1-2 done).
- **README.md** — status banner rewritten to "DEPLOYED and live," including the deploy-verification
  finding-and-fix of the redirects bug and 0031.
- **PLAYBOOK_DELTA.md** — lessons 29 (a static host imposes its own URL semantics — `.html`
  canonicalization — before your rules run; a dev server that skips them passes configs prod breaks
  on) and 30 (fix EVERY object carrying a bad idiom and pin the guard to the whole class, not just
  the objects failing today — the anti-join surfaced live three times because 0029's fix and test
  were scoped to the matviews only).
- **docs/DISASTER_RECOVERY.md** — added 0030/0031 to the migration table, renumbered, and — the one
  genuinely actionable find of this pass — **fixed the fresh-rebuild pg_cron trap**: the guide (and
  0027 itself) says `create extension pg_cron with schema cron`, which ERRORS on a cold database
  (pg_cron is non-relocatable, pinned to pg_catalog; it only worked originally because the extension
  was pre-enabled via the dashboard). Corrected to "enable via dashboard first, or use
  `with schema pg_catalog`." Also corrected a stale build-output-directory instruction (it repeated
  the `site`/`site` bug from lesson 28) and updated the deploy-status section.
- **docs/CONTROLLER_BRIEFING.md** — staleness banner: 32 migrations, site deployed.
- **docs/CLOUDFLARE_DEPLOY.md** — status header flipped to DEPLOYED/VERIFIED with Phases 1-2 done
  and the two Phase-2 bugs recorded as "the verification earned its cost."
- **docs/SCHEDULED_INGESTION.md** — struck one stale "0026 awaiting Lance" line (0026 applied
  2026-08-03; superseded by 0027-0029).
- **Memory** — `deploy-last-backend-first` rewritten from "gate met, active next step" to "DONE,
  deployed; only custom domain remains"; MEMORY.md index line updated.

Then an independent verification pass (below) to catch any drift or cross-doc contradiction the
writes introduced — the same never-trust-a-self-report discipline applied to my own doc edits.

---

## 2026-08-05 (late, continued) — the doc sync gets adversarially audited; 10 critical + 26 minor inaccuracies found and fixed

**Lance:** "Systemwide documentation being 100% accurate is the goal before website filters."

Ran a 9-agent Fable-5 accuracy audit: eight per-doc auditors + one cross-doc consistency check, each
given an authoritative live-state fact sheet AND told to verify every concrete claim against the
real repo (not the doc's own prose). This is the never-trust-a-self-report discipline applied to my
OWN doc edits — and it earned its cost: **10 critical + 26 minor** real inaccuracies, several in
docs I'd just "finished."

**Verified each against the current files before acting — several "criticals" were false positives**
from a subagent whose context predated my edits (the cross-doc agent flagged CLAUDE.md as saying "30
migrations" and MEMORY.md as "deploy pending"; both were already correct on disk — that agent had
stale context, exactly the failure mode this whole session is about). Fixing what was genuinely
wrong:

- **The root critical: PLAYBOOK_DELTA had DUPLICATE lesson numbers.** My 2026-08-05 deploy-night
  batch was appended as "Lesson 27/28/29/30" on top of the existing 2026-08-04 "26/27/28/29" — so
  there were two Lesson 27s, two 28s, two 29s, and every "see lesson 27" cross-reference resolved to
  the wrong lesson. Renumbered the new batch to 30-33 (highest is now 33), then remapped every
  external citation (CLAUDE.md ×2, README, memory, CLOUDFLARE_DEPLOY ×2) — the ".env trap" is now
  uniformly lesson 30, the deploy-night pair lessons 32-33. Byte-verified no duplicate numbers
  remain.
- **DISASTER_RECOVERY (a rebuild runbook, so every literal must be right):** "apply these 29 files"
  → 32; the quoted `.env.example` block and its "does NOT list ANTHROPIC_API_KEY" paragraph were
  stale (the real file now lists both SUPABASE_ANON_KEY and ANTHROPIC_API_KEY — I'd added them
  earlier this session); the correct-data.js correction list (11 values, "exactly one <which>") was
  missing the 3 new values (sb914-reconcile, reconcile-flag, all); the SB-914 "still open" example;
  a wrong function-def migration list (0019/0023 never touch refresh_vote_aggregates()); 0018
  "creates two matviews" → three; the mo_house_id "see Section 12" dangling ref.
- **ARTIFACTS.md:** "0001-0025 ... not all applied yet" → 0001-0031, all 32 applied; added an
  approximate-count caveat to the volatile cache table.
- **DATA_INVENTORY.md:** SB 914 described as "will NEVER resolve, needs adjudication, both rows still
  count" — it was adjudicated 2026-08-05 (I did that reconcile-flag work this session); added a
  dated correction line to the snapshot banner (identity flags 0 now, recon ~107, SB 914 resolved).
- **CLOUDFLARE_DEPLOY.md:** a blockquote I'd inserted had SEVERED the settings table (orphaned the
  Environment-variables row) — moved it above the blockquote; the "one genuinely unproven thing"
  (cross-directory import) is now VERIFIED (Phase 2 passed) so reframed from risk to cleared;
  suite count 2,321→2,328; noted /trust was fixed by deleting its rule, not an extensionless target.
- **CLAUDE.md:** "59 pairs, all 2018 MO Senate" → 62 (59 backfill + 3 live); CONTROLLER_BRIEFING
  banner date 2026-08-03 → refreshed-2026-08-05; the "30 lessons, 26/27 newest" line → "33 lessons,
  30-33 newest."
- **TODO.md:** strikethrough/correction markers on the three worst stale-history NOW/build-queue
  items (the superseded "do not propose Cloudflare" entry, "4 identity flags open" now 0, the MO
  2026 split "highest-priority open defect" that actually ran 2026-08-02); softened the RESUME hash
  line (a doc can't contain its own latest commit hash) and marked the SB-914 sub-item resolved.
- **SCHEDULED_INGESTION.md:** reconciled two differently-severe descriptions of the same 0027
  exception-handler defect, deferring to the phase-2 audit's harsher (and correct) framing.

Lesson 25 discipline held: the PLAYBOOK renumber and the escaping-sensitive edits went through
byte-verified script files, and the one script that hit a bad anchor failed atomically (wrote
nothing) — caught the un-applied "29 files" edit on the final consistency re-grep and fixed it.
Suite 2,328/0 in a clean shell throughout. The docs now match live reality to the line.

## 2026-08-06 — Directory filtering → "fill the dateless MO term dates first" (backfill spec written)

Started on the requested legislator-directory filtering (by last name / date / currently-serving).
Brainstorming surfaced the real tension: a "currently serving" filter fights the currency-honesty law
(the code deliberately never asserts "current"). Lance reshaped it twice: first **filters → two lists
("Current" vs "Past")**, then chose a **toggle defaulting to a short "Serving now" list** (solves the
"long ass list" complaint), **dropped the date filter**, and picked honest labels **"Serving now" /
"Past members"** (not "Current" — the one word the honesty law forbids). Then he redirected: **"We
should fill all the unknown members dates in first, even wiki has them."**

I held the line on sourcing (Wikipedia is fine to *find* a date, never to *cite* one on a transparency
platform) and ran a 4-agent investigation workflow (`wf_9eeed494-93d`) — DB census + code-provenance
trace + authoritative-source inventory + synthesis. Findings that reshaped the task:

- The gap is **not 194, it's 193**: all 194 dateless terms are current MO **state** legislators (159
  house + 35 senate, `end_date` NULL is *correct* for them), EXCEPT **Bob Onder** — a stale
  MO-Senate-D2 duplicate (0 votes, party spelled "Republican", duplicates real current D2 senator Nick
  Schroer). He's a former senator now in **US House D3**; the `terms` table holds both his rows.
- Dateless-ness is **by design**: `backfill-mo-terms.js` hardcodes null dates under a `DATES STAY
  NULL` guard ("session-derived dates would invent term boundaries the source does not assert").
- The cleanest authoritative fill already exists 90%: `mo-legislature.js` parses real OpenStates
  `current_role.start_date`; it's just scoped to fetch one person today.

Decisions (Lance): **fill = OpenStates real dates + LegiScan on-disk year cross-check, mismatches FLAG
for review, never auto-apply** (the project's own author→verify→flag pattern); **Onder = parked**
(backfill skips him; the UI must keep him out of "Serving now" via an "open term AND has votes" rule).

Lance's mid-turn correction — **"Missouri's congressional map changed in 2026, use it, this could be
why you see zeros."** Verified and answered: the `terms` table conflates `chamber='house'+state='MO'`
across BOTH the state house and the 8-member federal delegation; only `jurisdiction_id` separates them
(159 `mo-legislature` + 8 `us-congress`). The 2026 remap moved only the **congressional** map — MO
**state** districts (2022 map) are unchanged — so the state backfill is immune; the remap is a
checkpoint for the federal delegation + the eventual UI. Onder's zero is a stale *state* row, not a
map artifact. Captured as **PLAYBOOK Lesson 34**.

Wrote the backfill design spec: `docs/superpowers/specs/2026-08-06-mo-current-term-dates-backfill-design.md`
(new CLI `backfill-mo-term-dates.js`, UPDATE-in-place, `end_date` always NULL, dry-run-first
draft-then-apply, OpenStates-sparse-date → flag). Awaiting Lance's review of the spec before
writing-plans.

## 2026-08-06 (later) — term-date backfill built end-to-end on branch `backfill-mo-term-dates`

Lance approved the plan and chose subagent-driven execution ("1"). Execution history, all on the
branch (main untouched):

- **Task 1's probe gate FIRED — and it was right to.** The OpenStates v3 REST API carries NO role
  dates at all (`include=other_roles` → 422; permitted includes are only names/identifiers/links/
  sources/offices; `current_role` has no start_date). The spec's author source was unviable as
  designed. Verified fix live: the **`openstates/people` CC0-1.0 GitHub data repo** (the dataset
  that FEEDS the API) carries full day-precision role history. Lance approved the source swap + the
  `yaml` dep ("Approve swap"). Spec §3 + plan amended; 192 MO YAMLs cached to
  `.superpowers/artifacts/openstates-people/` with a commit-SHA manifest.
- **Mid-execution a power outage killed the session.** Recovery was clean off the SDD ledger +
  git (nothing lost; the outage landed between Task 4's commit and its review). Post-reboot the
  Bash tool's PATH came back un-converted (raw Windows form) — all commands were routed through
  PowerShell for the rest of the run.
- Tasks 1-8: TDD'd `parsePersonYaml`/`loadCachedRoster` (yaml cache), `readCachedDatasetFull`
  (LegiScan decode keeping rollCalls), `buildLegiscanPresenceIndex`/`earliestLegiscanYear`
  (chamber signal from roll_call.chamber, never person.role), `matchRoster` (OPEN roles only — an
  ended role can never claim a seat), `reconcile` (agree/flag gate), then the `--apply`-gated
  orchestrator (dry-run default; single UPDATE `.eq(id).is(start_date,null).select(id)`; end_date
  structurally unwritable; citations with source commit SHA into `ingestion_runs.detail`).
  Per-task adversarial reviews all clean; two real catches along the way (a plan fixture that
  decodes to 0 rollCalls; a misleading test title).
- **Task 9, the read-only dry-run against live data: 194 seen / 193 matched / 171 AGREE /
  23 flagged / 0 written.** Flags: 1 unmatched (Brown H-149 — seat genuinely absent from the
  current roster), 17 year-mismatch (mostly "current role starts 2023" vs "first seen in LegiScan
  earlier" — a semantic question for Lance: current-stint start vs first service; plus Crawford's
  2017-09-13 special election vs LegiScan's 2018 floor), 5 surname-mismatch (4 multi-word-surname
  artifacts: Van Schoiack/Walsh Moore/Bunting Parker/Fountain Henderson; 1 REAL: Onder's stale D2
  row seat-matching Schroer — flagged, never written, exactly as designed). Table:
  `.superpowers/sdd/2026-08-06-mo-current-term-dates-backfill/dryrun-resolution-table.json`.
- Final whole-branch review (most capable model): **MERGE-READY**, no Criticals; its 1 Important +
  4 doc findings closed in one fix wave (direct test of the real writer; `--apply` now hard-fails
  without a source commit SHA; spec/plan drift reconciled) and re-review confirmed all addressed.
  Suite: 2354/2354, fail 0, clean shell.

Open: integration decision (merge/PR/keep) is Lance's; then his adjudication of the 23 flags and
the `--apply` run (draft-then-apply — agent never applies).

**Apply ran (Lance, 2026-08-06 ~22:00 UTC)** — before flag adjudication, which is safe by design
(flags are never write-eligible). Live-verified immediately after: 171/194 MO terms dated (exactly
the dual-source-agreed set), 23 still NULL awaiting adjudication, 0 end_dates written, Onder's
stale D2 row untouched, ingestion_runs row `succeeded` with all 171 commit-SHA citations + 23
flags recorded. Remaining: adjudicate the 23 flags (17 year-mismatch = the current-stint vs
first-service policy question; 4 multi-word-surname artifacts; Brown H-149 + Onder stay null),
then a second idempotent --apply for whatever is approved.

**Overrides apply ran (Lance, 2026-08-06 ~22:50 UTC)** — the 21 adjudicated flags written per his
ruling ("start date = start of the current term they are serving"); run recorded with ruling text +
21 commit-SHA citations in ingestion_runs.detail. Lance ran the command twice; the second run
skipped all 21 as already-dated (idempotency verified in production). Live end-state: **192/194 MO
terms dated; Brown H-149 (no authored date) + Onder (parked) remain NULL by design; 0 end_dates
written.** The term-date backfill sub-project is COMPLETE — the Current/Past directory UI
(its parent project) is now unblocked with day-precision tenure display available.

## 2026-08-06 (evening) — "Serving now / Past members" directory split: built, deployed, live-verified

Lance: "Yes, proceed with the full build." Spec + plan written and committed (the spec bakes in
live-verified data facts: Onder groups to one person entry anchored on his real federal seat;
Brown H-149 serves undated). Subagent-driven execution on branch directory-serving-now-split,
3 tasks + final Fable review (MERGE-READY; 1 spec-coverage gap fixed + re-reviewed, 3 minors
parked with rulings). Merged fast-forward to main, pushed; Pages deployed in ~15s.

Live browser walk on visiblegov.pages.dev, all green: opens on "Serving now (730)" (default,
aria-pressed), "Past members (837)" swaps the list, byte-exact footnote, tenure fragments render
("since 1993"... "since 2025") on serving entries only, search narrows within the active view with
immutable badges, Onder appears ONLY as U.S. House D3 since 2025, Schroer alone holds MO Senate
D2 since 2023, zero console errors. Suite 2367/0.

This closes the original 2026-08-05 request ("filter the long ass list of names") end-to-end:
term-date backfill (prerequisite) + the two-view directory, both live. Observed pre-existing nit
(not a regression, logged for later): federal "Last, First 'Nick'" name formats make the surname
fallback sort quoted nicknames first in each view.

## 2026-08-07 — "The Voting Board" site-wide redesign: designed, built, deployed, live-verified

Lance: current look "absolutely elementary... geocities" -> brainstormed via the visual companion
(browser tab, 3 direction mockups on the real directory page). Lance chose "A — The Voting Board"
(chamber tally-board identity: dark housing, lit rows, amber rostrum-light accent, mono numerals)
and "Auto" light mode (dark = identity, light = "gallery"). Spec + plan committed; 3 SDD tasks on
branch voting-board-redesign; suite 2367/0 throughout.

Notable catches by the review machinery: (1) Task 3 shipped the lit-green serving treatment on
EVERY profile career span — a past member (Huddleston, gone since 1985) glowed like a sitting one;
fixed with the hasOpenTerm gate (the fix agent died mid-write on the WEEKLY API LIMIT; the
controller completed it under documented duress, independently re-reviewed post-reset, all four
theme/status combos verified). (2) Final Fable review found mobile horizontal overflow from chart
legend nowrap — fixed by stacking chart rows under 480px. (3) Lance's live mid-build report ("site
doesn't always fill the display") root-caused to unpainted canvas beyond body's content box —
fixed with html+body backgrounds and min-height 100vh/100dvh, measured at 1600px viewport.

Deployed (fast-forward 3bdbb94..1ac2cc2, Pages built in ~15s) and live-walked both themes:
directory, serving + past profiles, bill, trust, 404 — zero console errors. Honesty audit: party
neutral everywhere, green/red confined to Yea/Nay facts, lit treatment only on open-term facts,
"current" appears nowhere, all strings byte-identical (one adjudicated dangling-middot drop).
OPEN ITEM for Lance: Task 1 moved failure/quarantine indicators from red to AMBER under the
spec's "red = Yea/Nay facts only" rule — consistently applied, trivially reversible if
conventional error-red is preferred.

## 2026-08-07 (late) — summary wave 3: 12 bills, 7 published, the wave is now a repeatable one-liner

Lance: "I need to figure out how to have more plain-language summaries without me doing work on
them." Live census: 3,414 bills queued (3,121 passage-priority), 213 summaries existing. Presented
engine options with real costs; Lance chose "$0 sessions only" (subagent waves on plan tokens,
no API dollars) + passage-first scope. The billed autopilot (~$470 for the whole backlog) remains
a standing offer, not assumed.

Wave 3 ran: 12 bills x 4 stages (opus author / sonnet adversarial verify / blind provisions /
coverage), 48 agents, 0 errors, ~2.8M tokens. record gates: 7 auto-published (115->122 live), 5
flagged drafts (2 via the completeness axis, each naming the exact omitted provision - e.g. SB
799's new military-spouse LLC-fee definitions), 0 rejects, 0 failures.

**Process near-miss, owned:** the first launch attempt hand-typed the manifest from a partial read
and FABRICATED ids/hashes for 6 bills (SB 27 "health care" - actually political subdivisions) -
the EXACT wave-2 lesson ("bill lists generated by code, never typed"). Two layers caught it at
zero cost: workflow args validation killed the run instantly (0 agents, 0 tokens), and the record
gates would have rejected every fabricated write regardless. Relaunched with the manifest read in
full and passed verbatim. Also found: the Workflow harness delivers args as a JSON STRING despite
a JSON-array parameter - the script now tolerates both.

**Made repeatable:** .claude/workflows/summary-wave.js (named workflow),
scripts/export-summary-wave.mjs (code-generated batches), docs/RUNBOOK_SUMMARY_WAVES.md. Any
future session runs a wave from Lance's one line ("run a summary wave of N"); his only role ever
is the optional flag reading he has explicitly declined.

## 2026-08-07 (night) — the $2 Haiku probe: authoring holds, checking does not; per-bill floor found at $0.026

Lance: "I think you can do a lot more for a lot less and aren't trying hard enough" -> revised cost
model (Batch API 50%, Sonnet intro pricing, Haiku on mechanical stages, monster-bill routing) ->
Lance: "Proceed with a $2 haiku probe."

Built: record's provenance channel (api:/subagent: labels, typed rejects on unknown values —
TDD'd, suite 2371/0) + scripts/summary-probe-api.mjs (budget-capped, spend-tracked, per-stage
checkpointing, smallest-first). Three paid lessons, each now encoded in the driver: (1) the SDK
REQUIRES streaming at 16k-32k max_tokens ($0.29 learned); (2) API structured outputs reject array
minItems>1 — and stage-3 400s were discarding PAID author+verify outputs before checkpointing
existed ($1.43 learned, the expensive one); (3) smallest-first probing: 9 bills through all 4
stages for $0.24 (avg $0.026/bill).

**The quality verdict ($1.96 total):** Haiku AUTHORING survived — 9/9 schema-valid, and the one
bill whose checker output was well-formed sailed through sonnet's adversarial support check
(flagged only for a genuinely-omitted provision). Haiku CHECKING failed 8/9 — invented normalized
citations ("115.295(2)" where the text prints none; wave-2's exact checker-invention class),
under-count provisions, coverage/provision count mismatch. Every failure was caught by the
mechanical gates pre-write; zero bad content touched the DB. The 8 bills' paid author+verify
outputs are CHECKPOINTED on disk — salvageable by re-running only the two checker stages on
sonnet (~$0.10).

**Proven config for the billed path:** Haiku authors / Sonnet verifies / Sonnet checks ->
~$0.04-0.06 small bills, ~$0.08-0.10 queue average with batch pricing -> whole queue ~$200-250,
$7 ~ 80-100 bills. Awaiting Lance's next move (salvage the 8 + production runs vs plan-token
waves only).

## 2026-08-08 (overnight) — the two-lane engine: 115 -> 166 published; colorblind fix; exhaust-everything mode

Lance (AFK, sequential directives): use subscription + API until exhausted -> dollars frugally,
subscription for setup -> and the disclosure that he is red/green colorblind. Executed:

- **API lane:** run 1 (full-chain, stopped mid-flight when frugality directive landed - but it had
  already fully processed 112 bills): 28 published, 74 flagged, 10 checker-rejects banked. The $2
  Haiku probe's lessons held: Haiku authors pass gates at ~27% publish; sonnet-authored waves at
  ~75%. Author-only banking run launched on the remaining balance (in flight).
- **Subscription lane:** wave A (20 bills, opus-authored): 15 published, 5 flagged, 0 failures.
  Wave B (the 10 banked rejects via the new bank-load transcription stage): 1 published, 9 flagged
  - fresh sonnet verification caught real Haiku section-binding errors (HCR 58: facts pulled from
  adjacent clauses). The hybrid per-stage provenance labels each stage truthfully
  (api:claude-haiku-4-5 author / subagent:claude-sonnet-5 verifier).
- **Colorblind accessibility (Lance: "colorblind AF... red/green/brown"):** the amber-vs-red
  question self-resolved (amber IS the colorblind-safe choice); bigger: the site's yea/nay was
  pure red/green. Shipped color-independence: Nay = hollow dot, Yea = filled; Nay chart segments
  hatched. Deployed + live-verified. Suite 2373/0 throughout.

Totals since 2026-08-06 morning: published 115 -> 166 (+51), drafts 98 -> 191 (flags are Lance's
optional reading, never a backlog). All spend authorized: $2 probe + $7.50 run + author banking.

**Banking run complete (2026-08-08):** $1.96 spent, 124 bills newly authored at $0.0158/bill —
**239 total author checkpoints now banked** awaiting subscription verification (3 subagents/bill,
no authoring cost, ~12-20 per wave session). 36 oversize monsters (>100k chars) deliberately left
for future full-subagent waves. The API balance is effectively exhausted; billed path closed per
the standing policy. The machine for future sessions: run waves against the bank
(docs/RUNBOOK_SUMMARY_WAVES.md, bank-load mode) until it drains, then author new waves on
subscription.

## 2026-08-08 — bank-drain yield data (waves C+D): the economics inverted, pausing for Lance

Draining the Haiku-authored bank on subscription: wave C (20 tiny bills): 0 published, 20 flagged
(the completeness-floor catch-22, now TODO'd); wave D (20 mid-size): 1 published, 19 flagged
(real Haiku completeness gaps - the gates naming exact omitted provisions each time). Bank drain
yield: ~1 publish per ~3M subscription tokens. Fresh opus-authored waves yield ~15 publishes per
~3.6M (wave A). The Haiku bank's real value is now the flagged drafts' precise gap lists (a
future re-author-with-objections pass), not direct publishes. Live: 167 published, 230 drafts.
Paused the drain to put the numbers in front of Lance rather than burn his weekly tokens at 1/15th
efficiency against his own stated goal.

## 2026-08-08 — pause point after wave G: 211 published (115 -> 211 in three days)

Wave G (40 fresh bills, 160 agents, 7.2M tokens): 23 published, 17 flagged, 0 failures — the
largest single wave yet. Cumulative fresh-opus waves E+F+G: 44 published of 80 attempted (55%).
Live: 211 published, 266 drafts. Lance called a pause to survey. Session total across all engines
(waves 3/A-G + API runs): 96 net new published summaries; every one adversarially verified,
completeness-checked, hash-pinned, and publicly bylined with its true author/verifier models.

## 2026-08-08 — wave H proves the completeness-floor fix live: 12/12 tiny bills published, a first

Lance picked "1" from the survey (fix the tiny-bill catch-22) then "proceed with small wave over
fresh tiny bills." The fix (shipped earlier today, TDD + independent review): the completeness
gate's provision floor is now length-scaled — 1 provision for bills under 2,500 chars, 2 under
5,000, 3 otherwise — derived from the hash-pinned stored text, with all three checker dispatch
prompts realigned to say "list only the real provisions; never pad with enactment boilerplate."

Wave H: 12 fresh sub-1,200-char bills (memorial-highway designations, Jackie Robinson Day, powdered
alcohol ban, World Cup ticket tax exemption, three federal CRA disapproval resolutions...), 48
agents, 0 errors, ~1.9M tokens, ~4 minutes. Result: **12/12 published, 0 flagged, 0 rejects — the
first perfect wave.** Live: 211 -> 223 published. The floor fix did exactly what it was built for:
checkers emitted 1-2 honest provisions on genuinely tiny bills (HB 1552's checker listed exactly ONE
provision — the military-spouse licensure priority — and the gate accepted it; under the old fixed
floor of 3 that same envelope was structurally unpublishable, which is why wave C went 0-for-20 on
this exact class). ~24 fresh tiny bills remain in the current manifest for future waves.

## 2026-08-08 — wave I clears the fresh-tiny class: 19/24 published, live at 242

Lance: "next wave please." Wave I took ALL 24 remaining fresh sub-2,500-char bills (1,240-2,496
chars — awareness-month designations, Senate concurrent resolutions, small substantive bills like
animal-abuse penalties and inmate medical copays, two tiny appropriations, the Gulf of America Act):
96 agents, 0 errors, ~4.0M tokens, ~9 minutes. Gates: **19 published, 5 flagged, 0 rejects.** Live:
223 -> 242 published, 271 drafts. Combined tiny-bill record since the floor fix: 31/36 published
(86%) vs 0% for this class before it.

All 5 flags came from the adversarial verifier's section-binding rule, not completeness — e.g.
SB 227's bullet cited "Section A" for a claim Section A alone doesn't prove (it only
repeals-and-replaces 565.003), and SCR 37's bullet said "Army Corps of Engineers" where the cited
clause prints only "the Corps." The verifier holding that line on 2,000-char bills is the trust
model working, not friction. The fresh-tiny manifest class is now EMPTY — next waves draw from the
mid-size fresh pool (~55-75% measured publish rate).

## 2026-08-08 — wave J (minimal batch, first read on the mid-size pool): 5/8 published, live at 247

Lance: "Proceed with a minimal sized batch of the next wave." The fresh pool jumps straight from
2.5k to ~9k chars (everything between was already summarized or banked), so wave J = the 8 smallest
mid-size bills (8,895-9,922 chars: Article V convention commissioners, trust instruments,
promoting-prostitution penalties, speed limits, orders-of-protection age change, a facilities
appropriation, whistle-blower protection, water-district dissolution). 32 agents, 0 errors, ~1.5M
tokens, ~11.5 min. Gates: **5 published, 3 flagged, 0 rejects** (62% — inside the measured 55-75%
band). Live: 242 -> 247 published, 274 drafts.

The three flags, each naming its exact defect: HB 736 failed COMPLETENESS — the summary omitted 3
real provisions (the new "abusing a pet" / "pet" definitions in 455.010 and pet-danger as ex parte
good cause in 455.513 — the pet-protection half of the bill); HB 18's bullet 0 over-paraphrased the
appropriation's AN ACT paragraph; SB 786's bullet 11 said "the employer's action" where the cited
text prints "the agency's action" — a single-word substitution the adversarial verifier caught and
refused. 189 fresh bills remain in the manifest (~9.9k chars and up).

## 2026-08-08 — wave K: 5/8 published, live at 252; the gates keep earning their keep

Lance: "Continue." Wave K = the next 8 smallest fresh bills (10.3-13.2k chars: a supplemental
facilities appropriation, residency-requirement preemption, school-board recall elections, a health
care omnibus, the Missouri ABLE Program, fuel-tax increases, pharmacist vaccine administration,
FRA extensions). 32 agents, 0 errors, ~1.7M tokens, ~15 min. Gates: **5 published, 3 flagged,
0 rejects** — 62% again, matching wave J exactly. Live: 247 -> 252 published, 277 drafts.

The flags: SB 41 failed COMPLETENESS (summary omitted the vaccine-authority core of the bill — the
FDA-approved-vaccine list with its enumerated exclusions and the ShowMeVax notification/report
duty); SB 275's bullet called a "premium tax" an "insurance tax" (a word the section never prints)
and miscounted a 13-paragraph membership list; SB 623's bullet dropped an explicit carve-out on the
out-of-state decal fee. Two-day identifier-collision note verified pre-launch: this wave's "HB 18"
is a DIFFERENT bill (different bill_id/hash) than wave J's flagged HB 18 — MO reuses bill numbers
across sessions; bill_id is the only key. 181 fresh bills remain (~13.2k chars and up).

## 2026-08-08 — wave L: 5/8 published, live at 257; 62% holds for the third straight wave

Lance: "Continue." Wave L = next 8 (13.2-15.8k chars: license-office bidding, civil proceedings,
lobbyists, student transportation, LAGERS retirement coverage, trust companies, lagoon wastewater,
protective orders). 32 agents, 0 errors, ~1.6M tokens, ~13 min. Gates: **5 published, 3 flagged,
0 rejects** — 62% for the third consecutive mid-size wave. Live: 252 -> 257 published, 280 drafts.

Flags: HB 1098 and HB 1713 both failed COMPLETENESS by exactly one omitted provision each (the
certificate-of-reciprocity fiduciary-authorization statement; the Clean Water Commission
re-establishment tucked into the lagoon bill — the completeness checker catching a rider the title
never mentions is precisely the mechanism working); HB 137's bullet 5 dropped a precondition on
when negotiated contracts are allowed. Day total: 46 published (211 -> 257). 173 fresh bills remain
(~15.9k chars and up).

## 2026-08-08 — the 18M-token campaign (Lance: "Spend 18,000,000 tokens... then shut down safely")

Autonomous wave campaign, batches of 12, recording each wave through the gates as it lands;
shutdown = everything recorded, counts live-verified, CHATLOG'd, pushed.

- **Wave M** (12 bills, 15.9-19.3k chars): 48 agents, 0 errors, 2.40M tokens. **9 published,
  2 flagged, 1 rejected** — the reject is HB 2465, whose checker honestly listed only 2 provisions
  on a full-size (15.9k) definitions-rewrite bill; the >=5k floor of 3 bound, envelope refused,
  bill stays fresh for a future retry. Flags: HB 112 omitted boards' rulemaking authority; one
  verifier catch. Live: 257 -> 266 published. Budget: 2.40M / 18M.
- **Wave N** (12 bills, 15.9-22.7k chars): 48 agents, 0 errors, 2.52M tokens. **7 published,
  4 flagged, 1 rejected** — HB 2465's RETRY failed identically (fresh checker, same honest
  2-provision count): the bill is a repeal-and-re-enact where length >> substance, so it
  structurally cannot pass the full-size floor; EXCLUDED from further waves this campaign (a
  known-limitation class: re-enactment bills whose new matter is under 3 provisions). Flags incl.
  SB 655's summary omitting fertilizer-deficiency penalties and a verdict-binding parenthesis
  mismatch. Live: 266 -> 273 published. Budget: 4.92M / 18M.
- **Wave O** (12 bills, 23-27.6k chars): 48 agents, 0 errors, 2.53M tokens. **6 published,
  6 flagged, 0 rejects** (50% — bigger bills flag more, as expected). Completeness caught another
  buried rename (the "Missouri public services fund"); one more verifier parenthesis-binding
  catch. Live: 273 -> 279 published. Budget: 7.45M / 18M.
- **Wave P** (12 bills, 27.7-31.9k chars): 48 agents, 0 errors, 2.61M tokens. **6 published,
  6 flagged, 0 rejects.** Completeness flags incl. the Address Confidentiality Program expansion
  bill omitting 2 provisions. Live: 279 -> 285 published. Budget: 10.06M / 18M.
- **Wave Q** (12 bills, 32.1-36.4k chars): 48 agents, 0 errors, 2.70M tokens. **5 published,
  7 flagged, 0 rejects** (42% — flag rate keeps climbing with bill size; 4 of 7 were completeness
  omissions). Live: 285 -> 290 published. Budget: 12.76M / 18M.
- **Wave R** (12 bills, 36.5-41k chars: sunshine law, employment security, vaccine
  discrimination/workers' comp, education choice, child protection): 48 agents, 0 errors, 2.73M
  tokens. **6 published, 6 flagged, 0 rejects.** Live: 290 -> 296 published. Budget: 15.49M / 18M.
- **Wave S** (FINAL — 9 bills sized to the remaining budget, 41.7-45.6k chars: two education
  appropriations, Uniform Powers of Appointment, an abortion-law bill, banks/trust companies, the
  nursing licensure compact): 36 agents, 0 errors, 2.16M tokens. **5 published, 4 flagged,
  0 rejects.** Live: 296 -> 301 published.

**CAMPAIGN 1 CLOSED at 17.65M / 18M tokens.** Seven waves (M-S), 81 envelopes through the gates,
**44 published / 35 flagged / 2 rejects (both the HB 2465 re-enactment edge case), 0 failures,
0 agent errors across 328 agents.** Publish rate fell with bill size exactly as the earlier
measurements predicted (75% at 16-19k chars down to ~45% at 36-46k) — the flags are almost all
completeness omissions on many-provision bills, each one carrying its exact gap list for the
future re-author-with-objections pass. Full-day total (2026-08-08): **211 -> 301 published (+90)**,
drafts 266 -> 315. Fresh manifest remaining: 93 bills (45.6k chars and up). Shutdown was clean:
every wave recorded, live counts verified after each, all artifacts on disk
(records-wave-{h..s}.json), CHATLOG current, everything pushed.

## 2026-08-08 — campaign 2 (Lance: "we can use another 18M credits, proceed")

Same machine, second 18M budget. Also noted mid-campaign: Lance has a parallel VS Code window
building "Duarte-izer" with Claude (folder linked here; this window stays on VisibleGov —
memory written).

- **Wave T** (12 bills, 46.5-53.7k chars: prevailing-wage repeal, PT scope of practice,
  judiciary/public-defender appropriation, abortion-facility funding/MO HealthNet, student
  transfers): 48 agents, 0 errors, 2.93M tokens. **7 published, 5 flagged, 0 rejects.** Live:
  301 -> 308 published. Budget: 2.93M / 18M.
- **Wave U** (12 bills, 55.8-76k chars: bank filing modernization, video lottery terminals, the
  marriage-age/sex-offender bill, Fiduciary Access to Digital Assets, a 71k transportation/public-
  safety appropriation): 48 agents, 0 errors, 3.10M tokens. **4 published, 8 flagged, 0 rejects**
  (33% — the size trend continues; 3 of 8 were completeness). Live: 308 -> 312 published.
  Budget: 6.03M / 18M.
- **Wave V** (12 bills, 76.8-101.6k chars: two transportation omnibuses, an abortion-law bill,
  three appropriations, ballot summary language, veterans): 48 agents, 0 errors, 3.55M tokens.
  **3 published, 9 flagged, 0 rejects** (25% — reported the worsening tokens-per-publish economics
  to Lance mid-campaign with a pivot offer; continuing per his standing directive unless he
  redirects). Live: 312 -> 315 published. Budget: 9.58M / 18M.
- **Wave W** (12 bills, 104-125k chars: congressional redistricting, three taxation omnibuses,
  911 services, workplace retirement plans): 48 agents, 0 errors, 3.74M tokens. **4 published,
  8 flagged, 0 rejects.** Live: 315 -> 319 published. Budget: 13.32M / 18M.
- **Wave X** (FINAL — 11 bills, 125.5-141k chars: controlled substances/medical marijuana,
  insurance, criminal offenses, workforce development, notaries): 44 agents, 0 errors, 3.88M
  tokens. **3 published, 8 flagged, 0 rejects.** Live: 319 -> 322 published.

**CAMPAIGN 2 CLOSED at 17.20M / 18M tokens.** Five waves (T-X), 59 envelopes, **21 published /
38 flagged / 0 rejects, 0 failures, 0 agent errors across 236 agents.** The size-vs-publish-rate
curve completed its arc: 58% at 46-54k chars down to 27% at 125-141k — flags on big omnibuses are
overwhelmingly completeness omissions, each carrying its exact gap list. Combined two-campaign day
(2026-08-08, campaigns 1+2 plus waves H-L before them): **211 -> 322 published (+111), drafts
266 -> 353.** Fresh manifest remaining: 34 bills (141k+ chars — the true monster tail). The
highest-value next engine move is no longer bigger fresh bills; it is the re-author-with-objections
pass over the 353 drafts, whose flags now hold precise, mechanical gap lists (standing backlog
item). Shutdown clean: all waves recorded, counts live-verified after each, artifacts on disk
(records-wave-{h..x}.json), pushed.

## 2026-08-08 — efficiency mode (Lance: "minimum tokens, maximum productive"): the draft re-check lane

Built and proven in one pass, all on subscription:
- **`--replace-drafts`** shipped in `summary-queue record` (TDD, suite 2,385/0): record can now
  supersede a bill's existing DRAFT at the same hash — old draft retires to 'rejected' with an
  audit note AFTER the replacement lands; approved/published rows are never replaceable.
- **`preVerified`** added to the wave workflow: reuse a prior wave's sonnet verdicts for the same
  summary+hash (the gates re-derive overall mechanically regardless), so a re-check spends agents
  ONLY on the two completeness stages.
- **Wave Y** (the 11 support-clean tiny drafts from wave C — blocked originally by the
  completeness-floor bug, since fixed): 22 agents, 0 errors, **0.93M tokens -> 8 published,
  3 flagged** (~116k tokens/publish vs ~0.8-1.3M/publish at campaign 2's tail — ~7x). Live:
  322 -> 330 published; drafts 353 -> 345; the 11 superseded wave-C drafts retired. The 3
  remaining flags are Haiku-invented stated_purpose strings — an authoring flaw, the re-AUTHOR
  lane's job, not the re-check lane's.
- **The re-author lane (`reAuthor` workflow mode)**: opus authors FRESH from the official text
  with the prior draft as reference and the gates' exact objections as must-fixes; full
  verify/provisions/coverage always re-runs (a changed summary never reuses old verification).
  **Wave Z pilot** (12 tiny drafts, 1 named objection each — 9 wave-C refuted-verdict bills + 3
  wave-Y stated_purpose flaws): 48 agents, 0 errors, 2.10M tokens -> **8 published, 4 flagged,
  0 rejects** (~262k/publish — the objections got FIXED; the 4 new flags are fresh completeness
  catches on other provisions, e.g. an omitted Section B effective date). Live: 330 -> 338
  published; drafts 345 -> 337; rejected (retired drafts) now 23.

Day grand total 2026-08-08 across all engines: **211 -> 338 published (+127)**. The efficiency
lanes are now permanent machinery: any future session can convert flagged drafts via
`preVerified`/`reAuthor` wave items + `record --replace-drafts` (see the runbook + this entry).
Session paused here per Lance ("take a break once this wave finish") — nothing mid-flight.

## 2026-08-09 — drain-drafts campaign (Lance: "Keep draining drafts")

Built the general drainer (scratchpad `build-drain-wave.mjs`): scans the LIVE draft pile, pairs
each draft-only bill with its latest stored envelope, reconstructs the gates' objections in code
(refuted verdicts + coverage-missed provisions + ungrounded stated_purpose), batches smallest-first
for the reAuthor lane. Census at start: 337 drafts; **232 re-authorable** (103 lack envelopes on
disk — pre-records-file waves; 2 no computable objection).

- **Wave AA** (12 smallest, 960-1,449 chars): 48 agents, 0 errors, 1.91M tokens. **8 published,
  4 flagged, 0 rejects.** Live: 338 -> 346 published; drafts 337 -> 329. (Two agents carried a
  "safety classifier unavailable" platform note — outputs verified by the mechanical gates like
  every envelope, which is the design.)
- **Wave AB** (12, 1.3-2k chars, incl. 3 wave-AA re-flags on attempt 2): 48 agents, 0 errors,
  1.95M tokens. **10 published, 2 flagged, 0 rejects** — best drain rate yet (83%); all three
  second-attempt bills PUBLISHED (the sharper objections converged). Live: 346 -> 356; drafts
  329 -> 319. The 2 new flags (HB 751, HR 4593) are first-attempt, queued for one retry.
- **Wave AC** (12, 1.5-2.6k chars, incl. both AB retries + two 5-objection bills): 48 agents,
  0 errors, 2.02M tokens. **12 published, 0 flagged, 0 rejects — a PERFECT drain wave.** Live:
  356 -> 368; drafts 319 -> 307. Campaign: 30/36 converted (83%).
- **Wave AD** (12, 2.6-3.1k chars): 48 agents, 0 errors, 2.01M tokens. **8 published, 4 flagged,
  0 rejects.** Live: 368 -> 376; drafts 307 -> 299. (A duplicate re-delivery of wave AC's
  completion notification was identified by run-id and skipped — DB arithmetic confirmed nothing
  was double-recorded.) Campaign: 38/48 (79%).
- **Wave AE** (12, 2.7-3.6k chars, incl. all 4 AD re-flags on attempt 2): 48 agents, 0 errors,
  2.03M tokens. **11 published, 1 flagged, 0 rejects** (92%) — every second-attempt bill
  converged again. Live: 376 -> 387; drafts 299 -> 288. Campaign: 49/60 (82%).
- **Wave AF** (12, 3.1-4k chars): 48 agents, 0 errors, 2.11M tokens. **8 published, 3 flagged,
  1 rejected** (SB 396's checker emitted 1 provision where the >=2.5k floor requires 2 — a lazy
  checker, retryable). Live: 387 -> 395; drafts 288 -> 280. Campaign: 57/72 (79%).
  Mid-campaign census for Lance ("how many bills are left?"): 2,949 unpublished with text —
  288 drafts + 2,661 never-attempted; published 11.6% of the 3,343-bill accountability set,
  up from 3.4% three days ago.
- **Wave AG** (12, 3.7-4.5k chars, incl. AF re-flags on attempt 2 + HJR 59's 6-objection bingo
  amendment): 48 agents, 0 errors, 2.12M tokens. **10 published, 2 flagged, 0 rejects.** Live:
  395 -> 405; drafts 280 -> 270.

**DRAIN CAMPAIGN PAUSED per Lance ("pause runs after AG finishes").** Session totals for the
2026-08-09 drain: waves AA-AG, 84 attempts, **67 published (80%)**, live 338 -> 405 (+67 today),
drafts 337 -> 270, 106 superseded drafts retired with audit notes, ~14.2M subscription tokens
(~212k/publish). Remaining inventory: 270 drafts (163 immediately re-authorable; 103 need the
drainer's DB-objections upgrade to unlock; ~4 parked/no-objections), 2,661 fresh never-attempted.
The drain machine resumes with one line; nothing mid-flight.

## 2026-08-09 — current-session campaign (Lance: "I like the recency idea and hitting the current session bills first")

Shipped the recency-first exporter (newest legislative session first; planner passage-priority as
tiebreak; smallest-within-session): `scripts/export-summary-wave.mjs`, commit 3db07ad. The
400-bill export came back ENTIRELY from the 2025-01-03 session — the current 119th Congress —
proving the sort. Waves now walk the current session smallest-first.

- **Wave AI** (12 smallest, 937-1,296 chars: EO 14193 national-emergency termination, CRA
  disapprovals of CFPB digital-payments, IRS digital-asset-broker, EPA tire-emissions, DOE
  appliance standards, ANWR leasing; Protecting American Energy Production Act): 48 agents,
  0 errors, 1.99M tokens. **9 published, 3 flagged, 0 rejects.** Live: 405 -> 414.
- **Wave AJ** (12, 1.3-1.8k chars: NPR-A and Central Yukon BLM disapprovals, DC noncitizen-voting
  prohibition, Haiti TPS, CA clean-trucks waiver disapproval, CEASE Act, Cashless Bail Reporting
  Act): 48 agents, 0 errors, 1.95M tokens. **11 published, 1 flagged, 0 rejects (92%).** Live:
  414 -> 425.
- **Wave AK** (12, 1.8-2.7k chars: DC juvenile prosecution age, pregnancy-center TANF funds,
  working-animal protection, Miccosukee amendments, REFINER Act, service-weapon purchases,
  Arkansas Valley Conduit): 48 agents, 0 errors, 1.97M tokens. **8 published, 4 flagged,
  0 rejects.** Live: 425 -> 433. Campaign: 28/36 (78%).
- **Wave AL** (12, 2.8-3.8k chars: Affordable HOMES Act, Special Interest Alien Reporting,
  Women and Girls in Sports Act, DC Policing Protection, DUMP Red Tape Act): 48 agents, 0 errors,
  2.03M tokens. **9 published, 3 flagged, 0 rejects.** Live: 433 -> 442. Campaign: 37/48 (77%).
- **Wave AM** (12, 3.8-5.4k chars: Anti-CBDC Surveillance State Act, Veterans 2nd Amendment
  Protection, LNG export permitting, Pregnant Students' Rights, critical minerals, LEOSA Reform):
  48 agents, 0 errors, 2.10M tokens. **9 published, 3 flagged, 0 rejects.** Live: 442 -> 451.
  Campaign: 46/60 (77%).
- **Wave AN** (12, 5.5-8.5k chars: GRID Power Act, Born-Alive Abortion Survivors Protection,
  both Laken Riley Act versions (S 5 + HR 29), Rescissions Act of 2025, Faster Labor Contracts):
  48 agents, 0 errors, 2.12M tokens. **7 published, 5 flagged, 0 rejects.** Live: 451 -> 458
  (draft 284 -> 289). Campaign: 53/72 (74%). Notable: 4 of the 5 flags are ONE trivial gate
  class — the verifier wrote the section citation as "(SEC. 2)" with parentheses while the
  bullet says "SEC. 2", so the verdict-binding check refused to bind (HR 3628, S 5, HR 4,
  HR 29 — i.e. both Laken Riley versions and the Rescissions Act, content otherwise verified).
  Prime re-check-lane conversions next drain pass. **Paused here per Lance ("Pause after this
  wave completes") — no wave AO launched.** Bookkeeping note found while reconciling counts:
  `npm run status`'s "summaries draft/flagged" line counts `status=neq.published`, which since
  the drain campaign includes the 106 superseded drafts retired to 'rejected' — it reads 395
  when actual open drafts are 289. Logged to TODO inbox, not chased.

**2026-08-09 — billed-lane pivot (Lance):** *"I have a $1 or $2 left in the platform to use API
calls, let's save tokens and use the dollars for now. Once depleted, pause waves as I do not
auto reload credits."* Subagent wave lane stays paused; the remaining API balance runs through
`scripts/summary-probe-api.mjs` (proven 08-07 config: Haiku authors, Sonnet verify/check, per-stage
checkpoints, budget guard) with a skip-file over the 72 wave-owned manifest bills so dollars never
touch the AI-AN slices. Depletion signal = credit errors → PAUSE ALL waves. Memory updated.
- **Billed run 1** ($1.00 cap): **$0.9336 real spend, 39 bills full-chain (156 calls, 0 API
  errors) → 29 published, 8 flagged, 2 rejects (MalformedSummaryError).** Live: 458 -> 487
  published, drafts 289 -> 297. ~$0.024/bill, **~$0.032/publish** — ~4x cheaper than estimated
  (Haiku authoring is ~$0.002/bill; Sonnet check stages dominate). Only non-budget skips: 11
  oversize (>100k chars) monsters that belong to the $0 lane. Records preserved at
  records-api-2026-08-09-run1.json. Run 2 launched with the remaining authorized budget.
- **Billed run 2** ($1.00 cap): **$0.9111, 28 new bills (112 calls, 0 credit errors) → 17
  published, 11 flagged.** Live: 487 -> 504 — **the site crossed 500 published summaries.**
- **Billed run 3, tail** ($0.20 cap): **$0.1351, 5 new bills (20 calls, 0 credit errors) → 2
  published, 3 flagged** (both non-publishes are coverage-miss gates, honestly flagged). Live:
  504 -> 506 published, 311 drafts. Records preserved per-run (run2/run3 audit copies).
- **CAMPAIGN CLOSE + FULL PAUSE (2026-08-09):** total **$1.9798 of the ~$2 balance spent — 72
  bills full-chain, 48 published, 22 flagged, 2 Malformed rejects, $0.041/publish, zero API/credit
  errors across 288 calls.** The balance is functionally depleted; per Lance ("Once depleted,
  pause waves as I do not auto reload credits") **ALL lanes are now paused** — no wave AO, no
  further billed runs, nothing in flight. Session arc today: 442 -> 506 published (+64: waves
  AM/AN +16, billed +48). Manifest remaining: ~250 unattempted 2025-session bills (mostly mid-to-
  large) + 11 oversize monsters; drafts at 311 (22 fresh billed flags are prime re-check fodder,
  4 of the AN flags are the trivial parens-binding class). Resume options when Lance is ready:
  subscription waves ("continue" -> wave AO), draft drain ("keep draining drafts"), or new API
  funds (his call only).

**2026-08-09 — pre-shutdown full doc sync (Lance):** *"Update all documentation, readme, todo,
playbook, manual, all documents in the system as I need to shutdown the PC again."* then mid-sync:
*"ensure all chatlogs and context are part of the docu-update-sync."* Synced in this pass, all
against the live DB numbers verified above (506 published / 311 drafts / 106 retired):
- `TODO.md` — RESUME HERE block rewritten to 2026-08-09: the ALL-LANES-PAUSED standing state up
  top with the three resume options, live counts, campaign ledger (manifest slices consumed by
  waves vs billed lane), stale 115/98 numbers replaced; the "genuinely open" drafts line updated.
- `README.md` — status line, trust-model bullet (both lanes + $0.041/publish + 506/311), and the
  spend-policy bullet (balance depleted, all paused) updated.
- `PLAYBOOK_DELTA.md` — lessons 35 (quote-bearing text for native exes goes through a FILE —
  `git commit -F`; PS5.1 native-arg marshalling mangles embedded quotes even from here-strings)
  and 36 (negative-predicate gauges silently absorb later-invented status values — the
  `neq.published` drift) added; 36 lessons total.
- `CLAUDE.md` — fresh-session banner (506 published, all lanes paused, custom domain still open),
  read-first list (36 lessons, briefing refreshed 2026-08-09), and the API-spend standing policy
  (depletion supersedes the 2026-08-03 suspension in practice) updated.
- `docs/CONTROLLER_BRIEFING.md` — staleness banner refreshed 2026-08-09 (now names the whole
  summary-campaign era it predates).
- Memory (`no-api-spend-hold.md` + `MEMORY.md`) — already updated at campaign close: depleted,
  all paused, never assume a reload.
- `CHATLOG.md` — this entry; today's decision trail (wave AM close, wave AN + pause, billed runs
  1-3 + campaign close) was already committed as it happened (1514175, a62354c, 0ef7bf8, f390755).
Shutdown-safe: nothing in flight, git clean after this commit, everything pushed.

**2026-08-10 — wave lane RESUMED (Lance):** *"Proceed with wave AO"*, then *"review all
documentation we left for ourselves prior to starting the run."* Doc review ran clean: the
RESUME HERE block, CLAUDE.md banner, memory, and README all matched live state and the resume
followed the documented option (a); the three "ALL LANES PAUSED" standing-state texts were
updated to the new truth (wave lane ACTIVE, billed path still CLOSED without funds + explicit
go, drain lane parked). One material process change discovered while building the wave: **the
billed lane consumed manifest bills smallest-first across the whole remaining pool, so
manifest-slice wave building is DEAD** — wave AO was built from live state instead (a manifest
bill is fresh iff it has zero `summaries` rows; live-verified 142 attempted / 258 fresh, which
also tightened the ledger's "~77 smallest" billed figure to the exact 72 attempted). Wave AO
launched: 12 bills, 8.8-13.7k chars (Veterans Benefits Expansion, DC Safe and Beautiful, Cash
Bail Reform, Protect Children's Innocence, Kayla Hamilton Act, Illegitimate Court Counteraction,
Smithsonian Women's History Museum).
- **Wave AO** (12, 8.8-13.7k chars): 48 agents, 0 errors, 2.20M tokens. **9 published, 3
  flagged, 0 rejects.** Live: 506 -> 515 published, drafts 314. 2 of the 3 flags are the
  parens-binding class AGAIN (HR 23 Illegitimate Court Counteraction, HR 8464 Stopping
  Fraudulent Payments) — that class has now flagged 6 bills across two waves; the TODO-inbox fix
  (normalize surrounding parens in the binding comparison) is earning its priority. Manifest
  after AO: 154 attempted, 246 fresh. Wave AP built from live state (14.4-57.7k chars — the
  size ramp begins: S 1318, HR 3668, HR 2988, HR 4626, HR 27, S 331, HR 22, HR 4776, S 1383,
  HR 33, HR 3898, HR 1048) and launched.
- **Wave AP** (12, 14.4-57.7k chars): 48 agents, 0 errors, 2.44M tokens. **2 published, 10
  flagged, 0 rejects** — but 7 of the 10 flags were the parens-binding class in ONE wave (the
  verifier cohort systematically wrote "(Sec. X)"), which forced the queued TODO-inbox fix.

**2026-08-10 — autonomy design session (Lance):** *"I'd like to move away from the system and
let it become more autonomous and get real OS-level scheduling like the ingest does."* Ran the
brainstorming flow; Lance chose each fork explicitly: billed-API engine (not headless/cloud),
**$5/ISO-week hard cap**, all three lanes (fresh backlog recency-first, draft conversion from
DB objections, ≤1 monster/tick). Design approved; spec written to
`docs/superpowers/specs/2026-08-10-scheduled-summaries-design.md`. Then Lance, before
implementation: *"But our focus right now is what we've been doing, I have no credits loaded at
the moment so we should proceed how have been after the spec is written."* → **spec PARKED with
his words in its status block; no implementation, campaign continues.** Wave AQ (monsters) was
already in flight throughout.
- **Wave AQ** (12 monsters, 58.5-125k chars: five appropriations bills, Ukraine Support Act,
  SUPPORT Act reauth, Fix Our Forests): 48 agents, 0 errors, 3.70M tokens (biggest wave yet;
  S 2882 alone drew 113 verdicts). **4 published, 8 flagged, 0 rejects** — 33%, inside the
  historical monster band, and ZERO gate-mechanics flags (parens fix holding; all 8 are genuine
  verifier refutations on giant bills — drain-lane material). Live: 525 -> 529 published,
  drafts 324. **Wave AR launched** — the passage-priority tail: the 4 final mega-monsters
  (175k/200k/324k/377k chars — HR 3944 and HR 6644 are the biggest bills ever attempted here)
  plus the first 8 'other'-priority tinies (1.1-2.2k), including the billed campaign's two
  Malformed rejects (HRES 518, HRES 436 — never wrote rows, legitimately fresh; opus may
  succeed where Haiku's structure failed). 222 manifest bills remain fresh after AR.
- **Wave AR interruption + resume:** the original AR run died silently ~09:20 (PC sleep or
  harness restart — task vanished from the tracker, no notification; found when Lance asked "is
  AR running?"). 45/48 agents had journaled results; **resumed via resumeFromRunId with
  identical args** — 45 replayed from cache, 3 ran live (the mega tails, 2.18M fresh tokens),
  0 errors. The resume machinery works exactly as designed after a mid-wave death.
- **Wave AR** (4 mega-monsters 175k-377k + 8 tinies 1.1-2.2k): **7 published, 5 flagged, 0
  rejects.** All 4 megas flagged honestly (3 on single-provision coverage misses — e.g. DoD
  approps omitting Sec. 8124 — 1 on unsupported verdicts; drain-lane material, and expected at
  these sizes). **Both former billed-lane Malformed rejects PUBLISHED (HRES 518, HRES 436)** —
  the opus author cleared the structure Haiku couldn't, validating the reject class as
  author-strength-dependent rather than unpublishable. 7 of 8 tinies published (HR 5348 flagged
  on an effective-date coverage miss). Live: 529 -> 536 published, drafts 329. Manifest: 222
  fresh remain, all 'other'-priority small/mid bills from here.
- **Wave AS** (12 tiny resolutions, 2.2-2.3k chars: CRA disapprovals — EPA emissions/NESHAP,
  USCIS EAD extension, BLM Coastal Plain, CFPB withdrawals, VA Reproductive Health Services —
  plus the Israel arms-sale disapproval and Lower Health Care Costs Act): 48 agents, 0 errors,
  1.92M tokens. **9 published, 3 flagged, 0 rejects** (flags are unsupported-verdict class, no
  gate mechanics). Live: 536 -> 545 published, drafts 332. **Wave AT launched** (12 more
  small 'other'-priority, 2.4-2.6k chars: American Cargo for American Ships, Barred Owl CRA,
  wind/solar credit-termination CRA, hydropower deadline extension). 198 fresh remain.
- **Wave AT** (12 small, 2.4-2.6k chars): 48 agents, 0 errors, 1.93M tokens. **11 published, 1
  flagged, 0 rejects — the campaign's best rate (92%).** Live: 545 -> 556 published, drafts
  333. **Wave AU launched** (12 more, 2.6-2.9k chars: S 9 Women and Girls in Sports Senate
  version, CMS Marketplace Integrity CRA, Tipped Employee Protection, AI for Main Street,
  two condemnation resolutions incl. the Minnesota lawmaker attacks). 186 fresh remain.
- **Wave AU** (12, 2.6-2.9k chars): 48 agents, 0 errors, 1.94M tokens. **9 published, 3
  flagged.** Notable flag: S 9 (Women and Girls in Sports, Senate version) — the verifier
  correctly refused a bullet characterizing Title IX with background not in the cited section
  (cited-section-alone discipline working as designed; House version HR 28 already published).
  Live: 556 -> 565 published, drafts 336. **Wave AV launched** (12 more, 2.9-3.0k chars:
  balanced-budget constitutional amendment HJRES 139, PROTECT Taiwan Act, ZIP Code
  designations, sodium nitrite sale ban, Boulder attack resolution). 174 fresh remain.
- **Wave AV** (12, 2.9-3.0k chars): 48 agents, 0 errors, 2.00M tokens. **11 published, 0
  flagged, 1 structural reject** — HR 3095 (ZIP Codes) hit MalformedSummaryError: the checker
  found 1 provision (the bill is genuinely a list of 66 communities) vs the size-2 floor.
  No row written, so it stays fresh; retrying ONCE in wave AW, park if it repeats. Live:
  565 -> 576 published, drafts 336. **Wave AW launched** (12, 2.9-3.4k chars: HR 3095 retry,
  McIver censure, Cuba + Iran war-powers resolutions, Medal of Honor Act, veterans-claims
  bills, "Denouncing the horrors of socialism"). 163 fresh remain (151 after AW).
- **Wave AW** (12, 2.9-3.4k chars): 48 agents, 0 errors, 1.98M tokens. **10 published, 1
  flagged, 1 reject — HR 3095 Malformed a SECOND time, now PARKED** (builder skip set; the
  bill's one-list structure genuinely cannot meet the size-2 completeness floor — HB 2465
  class; unparking documented in the builder). Live: 576 -> 586 published, drafts 337.
  **Wave AX launched** (12, 3.4-3.6k chars: three more Iran war-powers resolutions + the
  HCONRES 38 War Powers directive, UAE arms-sale disapproval, Honduras human-rights request,
  Vietnam Veterans Liver Fluke study, both Emergency Conservation Program versions). 151
  fresh remain (139 after AX).
- **Wave AX** (12, 3.4-3.6k chars): 48 agents, 0 errors, 1.96M tokens. **12/12 PUBLISHED — the
  campaign's first perfect wave since wave H.** Live: 586 -> 598 published, drafts 337 (two shy
  of 600). **Wave AY launched** (12, 3.7-3.9k chars: Venezuela war-powers pair SJRES 90/98,
  another Iran SJRES 114, LA riots condemnation, several multi-measure rule resolutions).
  139 fresh remain (127 after AY).
- **Wave AY** (12, 3.7-3.9k chars): 48 agents, 0 errors, 1.96M tokens. **12/12 PUBLISHED —
  SECOND consecutive perfect wave, and the site crossed 600.** Live: 598 -> 610 published,
  drafts 337. **Wave AZ launched** (12, 3.9-4.2k chars: Omar censure, Ethics-records
  resolution, Clergy Act, Pregnant Students' Rights Senate version, two more Iran war-powers,
  antisemitism-education resolution). 127 fresh remain (115 after AZ).
- **Wave AZ** (12, 3.9-4.2k chars): 48 agents, 0 errors, 1.95M tokens. **11 published, 1
  flagged.** Live: 610 -> 621 published, drafts 338. **Wave BA launched** (12, 4.2-4.6k chars:
  Wounded Knee Memorial, Charlie Kirk memorial resolution, Shutdown Fairness Act, China
  Exchange Rate Transparency, Qatar arms-sale disapproval, lithium-ion battery standards).
  115 fresh remain (103 after BA).
- **Wave BA** (12, 4.2-4.6k chars): 48 agents, 0 errors, 2.00M tokens. **10 published, 2
  flagged** (one is the Charlie Kirk memorial resolution HRES 719, gated on an omitted
  provision — honest coverage miss). Live: 621 -> 631 published, drafts 340. **Wave BB
  launched** (12, 4.7-5.1k chars: Trump impeachment resolution HRES 537, El Salvador
  human-rights request, China-detainees resolution, Made-in-America Defense Act, Haiti
  Economic Lift extension, Communications Security Act). 103 fresh remain (91 after BB).
- **Wave BB** (12, 4.7-5.1k chars, incl. the Trump impeachment resolution HRES 537 — same
  mechanical treatment as every other bill): 48 agents, 0 errors, 1.97M tokens. **11 published,
  1 flagged.** Live: 631 -> 642 published, drafts 341. **Wave BC launched** (12, 5.2-5.4k
  chars: Plaskett censure, Epstein Files Transparency Act, four more Iran war-powers
  resolutions, Alaska Native lands, smart-device disclosure). 91 fresh remain (79 after BC).
- **Wave BC** (12, 5.2-5.4k chars): 48 agents, 0 errors, 2.03M tokens. **9 published, 3
  flagged** (Plaskett censure + Epstein Files Transparency both published with receipts).
  Live: 642 -> 651 published, drafts 344. **Wave BD launched** (12, 5.4-5.9k chars: Secure
  Rural Schools reauth, TRIA reauth, ARTIST Act, another Iran SJRES, DHS-support resolution,
  fraud-prevention workforce). 79 fresh remain (67 after BD).
- **Wave BD** (12, 5.4-5.9k chars): 48 agents, 0 errors, 2.05M tokens. **11 published, 1
  flagged** (HR 8428 fraud-workforce, coverage miss). Live: 651 -> 662 published, drafts 345.
  **Wave BE launched** (12, 6.0-7.2k chars: IRS Whistleblower Program, Stop Chinese Fentanyl,
  DOE/USDA research, general war-powers SJRES 83, several dense multi-measure rule
  resolutions). 67 fresh remain (55 after BE).
- **Wave BE** (12, 6.0-7.2k chars): 48 agents, 0 errors, 2.04M tokens. **10 published, 1
  flagged, 1 Malformed** (HRES 1182 rural-communities sense-of-House — long whereas preamble,
  checker under-split; gets its one retry in BF). Live: 662 -> 672 published, drafts 346.
  **Wave BF launched** (12, 6.4-7.9k chars: HRES 1182 retry, a SECOND Trump impeachment
  resolution HRES 939, S 6 Born-Alive Senate version, ANCHOR Act, Sanction Sea Pirates,
  TRUE Accountability, dense rule resolutions). 56 fresh remain (44 after BF).
- **Wave BF** (12, 6.4-7.9k chars): 48 agents, 0 errors, 2.10M tokens. **11 published, 0
  flagged, 1 Malformed** — the HRES 1182 retry PUBLISHED (retry lane works), HRES 939 (second
  impeachment resolution) and S 6 published; SRES 377 Malformed (an en-bloc nominations LIST,
  single-provision class like HR 3095 — one retry in BG, then park). Live: 672 -> 683
  published, drafts 346. **Wave BG launched** (12, 7.6-9.2k chars: SRES 377 retry + its twin
  SRES 690, Remote Access Security, American Access to Banking, MAPWaters, 9/11 commemorative
  coin, border tech). 45 fresh remain (33 after BG).
- **Wave BG** (12, 7.6-9.2k chars): 48 agents, 0 errors, 2.00M tokens. **7 published, 3
  flagged, 2 Malformed — both en-bloc nomination lists (SRES 377 second failure, SRES 690
  identical first): CLASS-PARKED** in the builder (a 48-item nominations list is one provision;
  the floor cannot be met honestly). Live: 683 -> 690 published, drafts 349. **Wave BH
  launched** (12, 9.3-10.9k chars: Mills censure, Stop Forced Organ Harvesting, Eliminate
  Shutdowns, Strengthening the Quad, fallen-officers memorial resolution, dense rule
  resolutions). 33 fresh remain (21 after BH).
- **Wave BH** (12, 9.3-10.9k chars): 48 agents, 0 errors, 2.12M tokens. **9 published, 3
  flagged** (Eliminate Shutdowns among the flags, coverage miss). Live: 690 -> 699 published,
  drafts 352. Building BI surfaced THREE more SRES en-bloc nomination lists (520, 532, 412) —
  **proactively class-parked** (park set now 6: HR 3095 + 5 SRES). **Wave BI launched** — the
  FINAL 12 fresh manifest bills (11.0-31.2k chars: TICKET Act, TAKE IT DOWN Act, MEGOBARI Act,
  Combating Organized Retail Crime, Tribal Trust Land Homeownership, Cyber Resilience). After
  BI: manifest EXHAUSTED except 6 parked.
- **Wave BI** (12, 11.0-31.2k chars): 48 agents, 0 errors, 2.23M tokens. **9 published, 3
  flagged.** Live: 699 -> 708 published, drafts 355. "Final wave" was one early — the SRES
  parking shrank BI's slice, leaving a true tail of 6. **Wave BJ launched — the ACTUAL final
  fresh wave**: 6 bills, 36.9-49.4k chars (S 3971 small-business, HRES 5 House Rules adoption,
  ROTOR Act, and all THREE Senate budget concurrent resolutions SCONRES 7/22/33). After BJ the
  400-bill manifest is fully consumed: every bill published, flagged, or parked-with-reason.
- **Wave BJ** (6, 36.9-49.4k chars): 24 agents, 0 errors, 1.37M tokens. **2 published, 4
  flagged** (monster-class rate, all honest verifier/coverage flags). Live: 708 -> 710
  published, drafts 359.

**2026-08-10 — 2025-SESSION MANIFEST CAMPAIGN COMPLETE.** The 400-bill recency-first manifest
is fully consumed: **394 attempted (0 fresh remaining) + 6 class-parked with documented
structural reasons** (HR 3095 ZIP-code list + 5 SRES en-bloc nomination lists — single-provision
structures the completeness floor rightly refuses). Day totals: **442 -> 710 published (+268 in
one day)** across the billed campaign close ($1.98 -> 48), the parens gate fix + re-record
(+8), and 22 subagent waves AO-BJ. Grand arc: 115 published (2026-08-06) -> 710. Drafts stand
at 359 (all verified-flagged with receipts, drain-lane fodder); retired-superseded 119. Zero
agent errors across ~1,050 subagents today; the parens fix held from wave AQ onward (zero
gate-mechanics flags after it). What remains for the summary product: the 359-draft drain,
the next recency-first export (~2,100 eligible bills with text beyond this manifest), and the
parked autonomy build (spec ready, needs credits + Lance's go).

**2026-08-10 — post-campaign full doc sync (Lance: "review all documentation in detail, update
all documentation, commit and push").** Fresh `data-status.js` run taken first (710 published;
the gauge's 478 "draft/flagged" = 359 drafts + 119 retirees, lesson-36 bug still open; glossary
backlog grew to 6,743 terms with ingest — 5,995 needs_mapping / 632 mappable; accountability-set
coverage now 473 of 3,343). Synced against it:
- `TODO.md` — RESUME HERE state bullets rewritten to the 2026-08-10-evening close (710/359/119,
  campaign-complete ledger, fresh data-status numbers); INBOX parens-binding item marked
  RESOLVED (92816ff) with its outcome; the status-gauge item updated to current numbers and
  STILL OPEN; "genuinely open" drafts line 311→359 + real glossary breakdown.
- `README.md` — status line (710, campaign complete, no lane running), trust-model bullet
  (710/359, ~2,500 remaining, 6 parked with reasons), spend-policy bullet (campaign ran to
  completion and is idle; billed path closed).
- `CLAUDE.md` — fresh-session banner (campaign COMPLETE, lane state: nothing running) and
  read-first list (38 lessons, briefing refreshed 2026-08-10).
- `PLAYBOOK_DELTA.md` — lessons 37 (silently-dead background task: diagnose liveness from
  on-disk artifacts, resume from journaled state — the wave-AR death/resume) and 38 (park a
  failing structural CLASS with written reasons and sweep for siblings on the second instance —
  the en-bloc-list saga) added; 38 total.
- `docs/CONTROLLER_BRIEFING.md` — staleness banner refreshed to the campaign-complete state.
- `docs/DATA_INVENTORY.md` — NEW semantics-drift banner correcting three now-false structural
  claims from the 115-published era: one-row-per-bill (superseded rows exist), the
  draft/published-only status enum (rejected + approved exist), and the gauge over-count.
- Memory (`no-api-spend-hold.md` + `MEMORY.md`) — campaign-complete, no lane running, billed
  closed, next work on Lance's pick only.
Docs deliberately NOT rewritten: CHATLOG history (append-only trail), dated audit/spec/plan
docs (historical records under their own dates), `docs/CLOUDFLARE_DEPLOY.md` and
`docs/SCHEDULED_INGESTION.md` (still-accurate runbooks in their domains).

**2026-08-11 — drain lane resumed, one small batch (Lance: "drain a small batch").** Drainer
census over the 359 drafts: **244 immediately re-authorable** (envelopes on disk — the manifest
campaign's records files grew the pool from 163), 103 still need the DB-objections upgrade, 12
no computable objections. **Drain wave BK** (8 smallest, 957-1,378 chars, exactly 1 objection
each): 32 agents, 0 errors, 1.29M tokens; recorded with --replace-drafts. **7 published, 1
re-flagged** (HRES 878 García disapproval — new honest coverage miss on a Whereas recital;
second attempt, parks on a third). Live: **710 -> 717 published**, drafts 359 -> 352, retired
119 -> 127 (8 superseded drafts retired with audit notes). Single batch per instruction;
stopped after recording. One platform note: the safety classifier was unavailable for the
S 4465 re-author agent — proceeded per established practice, since the record gates verify
every claim against the hash-pinned text mechanically (S 4465 published clean through them).

**2026-08-11 — CONTINUOUS DRAIN (Lance: "keep draining, start with the lowest token usage items
first than move towards the expensive items").** Drainer already orders by text_length (≈ token
cost); waves proceed 12-at-a-time up the size ladder until the pool dries or Lance pauses.
- **Drain wave BL** (12, 1.2-2.0k chars): 48 agents, 0 errors, 1.93M tokens. **11 published, 1
  re-flagged** (HRES 405 — new coverage miss, 2nd attempt). HRES 878 PUBLISHED on its 3rd
  attempt; both Israel arms disapprovals, HCONRES 40, the fentanyl rule resolution, and SRES 526
  (with the disburse-and-hold contradiction fixed) all converted. Live: 717 -> 728 published,
  drafts 341, retired 139.
- **Drain wave BM** (12, 1.7-2.6k chars): 48 agents, 0 errors, 1.97M tokens. **11 published, 1
  re-flagged** (HR 915 — re-author still missed the Rule of Construction; 2nd attempt). HRES
  405 converted on its 3rd attempt; TVA Salary Transparency, the DUI
  inadmissibility/deportability bill (clause asymmetry fixed), all three CRA disapprovals
  (CFPB x2, VA Reproductive Health), Kari's Law Reporting, and the FERC hydropower extension
  all published. Live: 728 -> 739 published, drafts 330, retired 151.
- **Drain wave BN** (12, 2.1-4.3k chars): 48 agents, 0 errors, 1.97M tokens. **9 published, 3
  re-flagged** (HR 2966 American Entrepreneurs First — coverage again; HR 1919 Anti-CBDC; HB
  746 MO mortgage brokers). Converted: HR 915 (3rd attempt), S 9 Women and Girls in Sports
  Senate version, HRES 519 Minnesota lawmakers, SJRES 84 CMS Marketplace CRA, HR 2262, HR 1039,
  HRES 1131, HRES 988, and the FIRST MO drain publish (HJR 59 bingo amendment). Live: 739 ->
  748 published, drafts 321, retired 163. Drain running total: 38/44 (86%). *(Correction note:
  this entry initially listed HR 1919 and HB 746 as converted — the next wave's builder showed
  them still draft-only; corrected same pass before launching BO.)*
- **Drain wave BO** (12, 3.6-5.0k chars, MO-heavy): 48 agents, 0 errors, 2.07M tokens. **8
  published, 4 re-flagged** (SB 856, HCR 26, HB 443, HB 636 — all on 2nd attempt, 3rd in BP).
  Converted: the whole 3rd-attempt cluster — HR 1919 Anti-CBDC, HR 2966, HB 746 — plus HRES
  719 Charlie Kirk memorial, HB 1251 foreclosure surplus, HB 493 jury age, SB 213 settlement
  demands, HR 1717 Communications Security. Live: 748 -> 756 published, drafts 313, retired
  175. Drain total: 46/56 (82%).
- **Drain wave BP** (12, 4.5-5.3k chars): 48 agents, 0 errors, 2.06M tokens. **9 published, 3
  re-flagged** (HCR 4 Dred Scott, HB 958 min-wage, HB 606 529s — all to 3rd attempts in BQ).
  Converted: ALL FOUR 3rd-attempt bills (SB 856 ESOP, HCR 26 Women Veterans Month, HB 443
  cemetery trusts, HB 636 Senior Savings), plus HB 825 telehealth, HB 1542 PBM, HR 6500 AGOA,
  SJRES 172, HRES 672. Live: 756 -> 765 published, drafts 304, retired 187. Drain total:
  55/68 (81%).
- **Drain wave BQ** (2026-08-11; 12, 5.0-5.9k chars): 48 agents, 0 errors, 2.12M tokens. **11
  published, 1 failed.** Converted: FOUR of five 3rd-attempt bills — HCR 4 Dred Scott
  renunciation, HB 958 min-wage exemptions, HB 471 incentive pay, HB 50 GIS fees — plus HRES
  1032 rule, HR 1958 Deporting Fraudsters, HB 1856 Extended Learning, HR 3486 reentry
  penalties, HB 210 college police, SB 725 ambulance districts, HR 8428 fraud training. The
  one failure: **HB 606 (529 loan definitions), 3rd attempt, MalformedSummaryError** — the
  completeness checker found only 2 key provisions (the bill genuinely only changes two
  definitions), below the mechanical 3-7 floor. Same structural Malformed class as HR 3095;
  **PARKED** in the drain builder with a written reason (no 4th attempt; its draft stays for
  human review). Live: 765 -> 776 published, drafts 293, retired 198. Drain total: 66/80
  (83%).
- **Drain wave BR** (2026-08-11; 12, 5.9-6.5k chars): 48 agents, 0 errors, 2.15M tokens. **8
  published, 3 re-flagged, 1 failed.** Converted: HB 1646 brush control, HB 994 petition
  audits, SB 938 recording fees, HB 2102 sawmill zoning, HB 486 self-defense/stand-your-
  ground, SB 1388 nuclear-enterprise sales tax, HR 2189 less-than-lethal devices, SB 293
  explosives fees. Re-flagged to 3rd attempts: HB 1137 (independent contractor), HB 2163
  (right of sepulcher), HB 569 (gated: omitted the Section B emergency clause). SB 973 (KC
  police salaries) failed MalformedSummaryError — checker returned 1 key provision on a
  many-provision bill, a checker fluke NOT the structural class; old draft intact, still
  retryable. Live: 776 -> 784 published, drafts 285, retired 209. Drain total: 74/92 (80%).
- **Drain wave BS — FINAL wave of this run (Lance: "make this the last wave, we will hit usage
  limit"), killed by the weekly limit 2026-08-11, recovered and completed 2026-08-14:** the
  original launch died mid-flight when the Claude weekly usage limit hit (23/48 agents done, 15
  limit-errored, 0 envelopes, nothing recorded) — second real-world save by the
  resume-from-journal pattern (PLAYBOOK lesson 37): after the Aug 14 noon reset, relaunched with
  resumeFromRunId + identical verbatim args; 23 agents replayed from cache, 25 ran live, 48/48,
  0 errors, 12 envelopes. (A separate partial retry by another LLM session the morning of
  2026-08-14 left 2 bills of stage checkpoints in bs-stages/ — correct shape, honest verdicts,
  never recorded, harmless.) **Recorded: 9 published, 1 re-flagged, 2 failed.** Converted: 3rd-
  attempts HB 1137 (independent contractor) and HB 2163 (right of sepulcher), plus HB 1214
  filing dates, HR 1326 DOE/USDA, HB 9 abortion preemption, HR 21 Born-Alive, SB 264 arts
  council transfer, HCR 7 Falun Gong, HR 3632 power-plant reliability. HB 569 flagged on its
  3rd attempt with a NEW honest miss (short-title provision) — per the retry discipline no 4th
  attempt; it joins the human-review bucket. HB 64 and HB 1588 failed MalformedSummaryError
  (completeness checker returned 1 and 2 key provisions — the same checker-fluke mode as SB
  973, NOT the structural class; old drafts intact, all three retryable via a fresh-mode
  re-run whenever a lane reopens). Live verified: **784 -> 793 published**, drafts 276,
  retired 219. Continuous-drain final ledger: **83/104 drafts converted (80%)** across waves
  BK-BS; published grew 710 -> 793 in the drain run. **ALL SUMMARY LANES NOW PAUSED per
  Lance's instruction — next wave only on his explicit go.**
- **Lane REOPENED same day (Lance: "proceed as you see best fit") — drain wave BT**
  (2026-08-14; 9 re-author 7.0-7.7k + 3 FRESH-mode checker-fluke retries): 48 agents, 0
  errors, 2.14M tokens. **8 published, 1 re-flagged, 3 failed.** The fresh-mode retry lane
  works: SB 973 (KC police salaries) and HB 1588 (farm corp registration) both PUBLISHED on
  their fresh re-runs — the prior Malformed failures were checker flukes as diagnosed. Also
  converted: HB 134 nonprofit-security task force, HB 3308 sales-tax exemptions, HJR 44
  veterans-home bonds, HB 2384 permit deadlines, SB 235 elections sovereignty, HB 1867 Joplin
  guest tax. HB 1558 (nonconsensual images) re-flagged: omitted the 513.600-513.660
  forfeiture cross-reference (2nd attempt; 3rd allowed). New Malformed failures: HB 651 and
  SB 626 (1st occurrence each, retryable fresh next wave) and **HB 64 — second identical
  Malformed in a row (key_provisions=1 in both BS and the BT fresh run) → PARKED per the
  2-strikes rule**, joining HB 606/HB 569 in human review. Live: 793 -> 801 published,
  drafts 268, retired 228. Fresh-retry mechanics: `append-fresh-retries.mjs` (scratchpad)
  strips reAuthor from a bill's latest args entry so the wave runs it fresh — the wave script
  already branches per-bill.
- **Drain wave BU** (2026-08-14; 10 bills 7.3-8.6k): 40 agents, 0 errors, 1.79M tokens. **8
  published, 1 re-flagged, 1 parked.** Converted: HB 651 video-service definitions (the
  drainer had re-queued it with an honest objection mined from its failed-BT envelope — that
  path works), **HB 1558 nonconsensual-images on its 3rd attempt**, HB 161 school calendar,
  HB 183 credit transfer, HB 269 boat safety, HR 5200 FCC outage reporting, HB 1473 license
  plates, HB 1086 short-term rentals. HR 2683 (Remote Access Security Act) re-flagged
  honestly (2nd attempt; 3rd allowed). **SB 626 PARKED** — second identical Malformed
  (key_provisions=1 in both BT and BU; the checker keeps collapsing this single-section fee
  rewrite to one provision); joins HB 606/HB 569/HB 64 in human review. Live: 801 -> 809
  published, drafts 260, retired 237.
- **Drain wave BV + section-word binding gate fix** (2026-08-14; 6 bills 8.0-9.2k — waves
  dropped from 12 to 6 bills because the args files hit the single-Read token limit at these
  draft sizes): 24 agents, 0 errors, 1.07M tokens. **4 published** — HB 19 capital-improvement
  appropriations, HB 1413 ethanol incentive, HR 187 MAPWaters, HB 1953 rare-disease council.
  **HR 2683 PARKED** — 3 attempts exhausted; each re-author fixed the prior refutation and the
  verifier honestly found a different overstatement in the amendment-mapping bullets. **HB 689
  exposed a SECOND binding-echo gate class** (sibling of the parens class, commit 92816ff): the
  verifier cited "135.690" for a bullet citing "section 135.690" — same reference, bare
  leading section-word difference. Fixed TDD in `validateVerdictBinding`: new
  `stripLeadingSectionWord` drops repeated leading "section"/"sec." tokens from BOTH sides
  (mid-string "subsection" untouched; real cross-section mismatches still fail); 4 new tests,
  full suite 2,393/0 clean-shell. Re-recorded HB 689 through the fixed gate: the binding
  false-positive is gone and it now flags honestly on a masked second issue (omits the
  135.690.1 definitions provision) — same masked-issue pattern as the parens re-records; it
  re-enters the drainer pool with that objection. Live: 809 -> 813 published, drafts 256,
  retired 244.
- **Drain wave BW — first PERFECT drain wave** (2026-08-14; 6 bills 9.1-9.6k): 24 agents, 0
  errors, 1.05M tokens. **6/6 published, zero flags**: HB 689 preceptor tax credit on its 3rd
  attempt (the section-word gate fix cleared its path), HB 736 protection-orders age, HRES
  893 Cory Mills censure, HB 1905 abandoned aircraft, SB 363 elder-abuse reporting, HB 18
  facilities appropriations. Live: 813 -> 819 published, drafts 250, retired 250.
- **Drain wave BX** (2026-08-14; 6 bills 9.7-10.2k): 24 agents, 0 errors, 1.10M tokens. **4
  published, 2 re-flagged.** Converted: HB 1797 nuclear-plant guards, HB 2150 Death Master
  File checks, HR 5214 DC cash-bail reform, HB 2216 private water rights. Re-flagged on
  honest 2nd-attempt refutations (3rd allowed): SB 786 whistleblower (an "agency's action"
  clause the bill text never actually reworded) and SB 650 A+ Schools (coverage misses on the
  retained program-framework provisions). Live: 819 -> 823 published, drafts 246, retired
  256.
- **Drain wave BY** (2026-08-14; 6 bills 9.9-10.8k): 24 agents, 0 errors, 1.15M tokens. **3
  published, 3 re-flagged.** Converted: **SB 650 A+ Schools on its 3rd attempt**, S 2806
  Eliminate Shutdowns Act, HB 258 animal trespass. **SB 786 whistleblower PARKED** — 3
  attempts exhausted; the redline's unbracketed civil-action language keeps defeating every
  characterization of the terminology swap's reach. SB 644 service dogs and HRES 936
  six-bill rule re-flagged honestly (2nd attempts; 3rd allowed). Live: 823 -> 826 published,
  drafts 243, retired 262.
- **Drain wave BZ — final wave of this run (Lance: "take a break and pause after this wave
  completes")** (2026-08-14; 6 bills 10.3-11.4k): 24 agents, 0 errors, 1.06M tokens. **4
  published, 1 parked, 1 re-flagged.** Converted: **HRES 936 six-bill rule on its 3rd
  attempt**, HB 1859 ballot naming, SB 54 county right-to-work option, HR 4294 MAWS
  blue-catfish pilot. **SB 644 service dogs PARKED** — 3 attempts exhausted, each fixing the
  prior miss while the checker honestly found a different one. HB 452 damages caps
  re-flagged (2nd attempt; stays in the pool). Live: 826 -> 830 published, drafts 239,
  retired 268. **Reopened-lane ledger (BT-BZ, all 2026-08-14 afternoon): 7 waves, 37
  published (793 -> 830), 5 bills parked with written reasons (HB 64, SB 626, HR 2683, SB
  786, SB 644), one gate-mechanics fix landed (section-word binding, e4f4915), 0 agent
  errors in ~230 subagents.** Full-day total including the BS morning recovery: 784 -> 830
  (+46). Remaining pool: ~116 re-authorable drafts (next sizes ~10.5k+), 103 no-envelope
  drafts (need the DB-objections drainer upgrade), 12 no-objection drafts, 9 parked bills
  for human review. **ALL SUMMARY LANES PAUSED per Lance — next wave only on his explicit
  go.**
- **DB-objections drainer upgrade (2026-08-15, Lance: "proceed with the DB-objections drainer
  upgrade that would unlock 103"):** the drain-wave builder was promoted from the session
  scratchpad into the repo as `scripts/build-drain-wave.mjs` and taught a second objection
  source — THE DATABASE. Drafts with no on-disk records-file envelope (the 103 leftovers from
  waves that predate the records-file convention) carry the same evidence in Supabase: the
  draft row's `body_md` is parsed back to {what_it_does, stated_purpose} (a balanced-paren
  inverse of renderMarkdown, since points and sections both contain parens),
  `summary_verifications` supplies refuted verdicts (kind='support') and coverage misses
  (kind='completeness'), and the hash-pinned text comes from `bill_texts` and is materialized
  into the artifacts bills/ dir for the wave agents. Both sources feed one shared
  computeObjections that mirrors record's gates exactly. **Validated end-to-end: pool jumped
  117 -> 220 re-authorable (all 103 unlocked — zero db-path skips: every one had
  verifications, a matching hash, and computable objections), reconstruction spot-checked on
  SJRES 18 / HR 1118 / SCR 8 (paren-in-point parsing correct, objections mirror the gate
  messages), and a materialized text file sha256-matches its draft's pinned hash.** The
  unlocked bills are SMALL (the ladder restarts at ~950 chars). The 7-bill PARKED set is
  encoded in the script with per-bill reasons. Lanes remain PAUSED — no wave launched; the
  next wave on Lance's go picks up the new pool smallest-first.
- **Draining RESUMED (Lance, 2026-08-15: "resume draining") — wave CA, first over the unlocked
  DB pool** (12 bills 953-2,636 chars): 48 agents, 0 errors, 1.94M tokens. **11/12 published**
  — SJRES 18 overdraft-rule disapproval, HR 1118 Value Over Cost, SCR 8 Peach Capital, SR 640
  Senate rules, HB 75 religious freedom, HCR 48 voter ID, SCR 26 auditor audit, HR 8823 FECA
  fraud, SB 573 terror-state divestment, HB 665 elemental formulas, HR 1526 NORRA. HB 935
  (Patients First) re-flagged honestly on a nonseverability omission (2nd attempt, leads CB).
  The DB-objections reconstruction held up end-to-end: prior summaries parsed from body_md
  re-authored cleanly and passed fresh verification. Live: 830 -> 841 published, drafts 228,
  retired 280.
- **Drain wave CB — 12/12 PUBLISHED, first clean sweep of the drain lane** (2026-08-15, 12
  bills 2.5-4.0k chars, 48 agents 0 errors, 2.06M tokens): HB 935 Patients First (published on
  3rd attempt — the CA re-flag's nonseverability omission was fixed by covering the clause under
  its true home 376.1583), HCR 53 Ghost Army gold medal, HR 261 Undersea Cable Protection,
  SCR 11 American History and Founders Month, HR 139 Sunshine Protection, HB 1606 First
  Informer Broadcasters, SJRES 198 WISeR-model disapproval (added the 802(c) discharge-petition
  provision the checker had found), HCR 4 salary-commission disapproval 2016, HCR 49 California
  egg-law repeal urging, SJR 50 income-tax-cap ballot measure, HR 3106 WINTER Act, HB 1 Fund
  Commissioners appropriation. record run e08955eb: published 12, gated 0, failures 0. Live
  verified: **853 published**, 508 draft/flagged (228 real drafts + 280 retired under the
  known neq.published gauge, lesson 36). Meanwhile the autonomy build started: plan committed
  759df01, Task 1 (billed-summary-chain lib) implementer dispatched subagent-driven.
- **Drain wave CC — 8/12 published** (2026-08-15, 12 bills 4.0-8.6k chars, 48 agents 0 errors,
  2.17M tokens, record run 7537ceb5 "partial"): HCR 66 meningococcal-info urging (2nd att),
  HR 4541 breast-health reauthorization, HJR 154 MO HealthNet work requirements (2nd att),
  HB 72 sports-official special victim, HJR 173 income-tax-elimination amendment, HB 1983
  paid-political-consultant ban, HCR 21 radioactive-waste compensation urging, HB 2587 drone
  interception. 3 re-flagged honestly: HR 5362 Boyce clinic (gated: omitted the findings
  provision), SJR 87 sheriffs amendment (voting-threshold overstatement), and **HRES 1423
  (4-bill House rule) on its 3rd attempt — PARKED** with reason in the drainer's PARKED set
  (completeness checker demands per-bill Sec. 2/7/8 bullets; author kept condensing; now 10
  parked total). HB 930 reverse-auction failed Malformed (checker returned 2 key_provisions,
  the known fluke class — attempt 2 stays in pool). Live: 853 -> 861 published. Autonomy build:
  Task 1 complete + reviewed clean (bb0969a); Task 2 draft-objections lib complete (a8fe1d0,
  drainer verified byte-identical pre/post refactor), review in flight.
- **Drain wave CD — 5/5 recordable published, clean sweep** (2026-08-15, run 13db0f7e): the
  12-bill build's args file (81.7KB) exceeded the single-Read cap so the wave was rebuilt at
  the proven 6-bill size. HR 5362 Boyce clinic (published on reattempt), SJR 87 sheriffs
  (reattempt), SB 1119 Article V convention commissioners, HRES 1438 six-bill House rule
  (reattempt), HB 204 animal confiscation (reattempt). **HB 19 (capital-improvements
  appropriation) was the wave's only casualty — its re-author agent died on an expired OAuth
  session** ("could not be refreshed", 1 of 21 agents; infrastructure, not content), envelope
  stripped before record, bill stays in pool for the next wave. Wave ran 4.7h wall-clock (the
  OAuth stall). Live: 861 -> 866 published, drafts 511 (gauge counts rejected, lesson 36).
  Autonomy build: Task 3 pure core complete after 1 fix round (54ac3af + b3b2fee header);
  Task 4 runTick orchestration implemented (da71760, 2419/0), review in flight.
- **Drain wave CE — 6/6 PUBLISHED, clean sweep** (2026-08-15, 24 agents 0 errors, 1.11M tokens,
  record run a1652e63): HB 19 capital-improvements appropriation (published on retry after the
  OAuth casualty — the wave's deepest verification yet at 21-26 verdicts/bill), HB 1945 animal
  confiscation, HB 385 real-estate correspondence definitions, HB 2180 road-district
  consolidation, SB 1135 Bentley and Mason's Law, HB 188 Narcotics Control Act. Live: 866 ->
  872 published. Autonomy build: Task 4 review verified all money paths correct (allowance ->
  openRun -> first-paid-call ordering, balance-depleted break, lock release, exact helper
  signatures); 2 Important test-coverage gaps (monster-gate untested, billing-error test can't
  catch a loop-didn't-break regression) in fix round 1. Controller ruling: the ~2.25x effective
  monster margin (1.5x gate atop 1.5x-padded worstBillUsd) stands — brief-literal, errs toward
  spending less.
- **Drain wave CF — 4/6 published** (2026-08-15, 24 agents 0 errors, 1.11M tokens, record run
  4a3f723c "partial"): **HB 1605 Capitol Commission published on its 3rd and final allowed
  attempt**, plus HB 1044 PSC/nuclear-power, HB 336 election challengers/e-signatures (41
  verdicts — deepest single-bill verification to date), HB 1934 school-retirement governance.
  HB 452 tort-caps re-flagged honestly (gated: omitted the new "equitable share" definition — a
  DIFFERENT omission than its prior flag; attempt 2 next). HB 1607 natural-resources funds
  failed Malformed (checker returned 2 key_provisions — 1st Malformed strike; its wave-d
  attempt had a valid 5-provision check, so no 2-strikes park yet). Live: 872 -> 876
  published, ~170 re-authorable remain.
- **Drain wave CG — 5/6 published** (2026-08-15, 24 agents 0 errors, 1.07M tokens, record run
  36ee21fe "partial"): HB 452 tort-caps (published on retry — picked up the equitable-share
  definition), HB 2018 facilities-maintenance appropriation, HB 571 CCR/explosives, SB 275
  health-care omnibus (32 verdicts), SB 623 fuel taxes/decals. **HB 1607 natural-resources
  funds failed Malformed IDENTICALLY a second time (key_provisions=2 in both CF and CG) —
  PARKED per the 2-strikes rule** (now 11 parked total). Live: 876 -> 881 published, ~165
  re-authorable remain.
- **Autonomy build PAUSED after Task 4 (Lance, 2026-08-15: "pause the autonomous build once
  this task completes").** Tasks 1-4 of 7 are complete, reviewed, and pushed (through 372afa2):
  billed-summary-chain lib (bb0969a), draft-objections lib (a8fe1d0), scheduler pure core
  (54ac3af + b3b2fee), runTick orchestration (da71760 + 372afa2 — fix round added monster-gate
  headroom tests both sides of the threshold and pinned the billing-error break with a
  chainCalls===1 assertion; re-review clean, suite 2420/0). The scheduler is now functionally
  buildable end-to-end but NOT registered and NOT documented — remaining on resume: Task 5
  (data-status scheduler block + lesson-36 gauge fix), Task 6 (runbook + CLAUDE.md carve-out),
  Task 7 (full-suite gate + memory), final whole-branch review. Resume point recorded in
  .superpowers/sdd/2026-08-15-scheduled-summaries/progress.md. Zero billed calls were made at
  any point — building was $0; the billed path stays CLOSED. Drain lane continues (wave CH in
  flight).
- **Drain wave CH — 5/6 published** (2026-08-15, "continue draining" per Lance; 24 agents 0
  errors, 1.12M tokens, record run cf1c5356): SB 41 pharmacist medications (28 verdicts),
  HB 137 license-office bidding (34), HB 2387 presidential-preference primary (35 — new
  deepest single-bill verification), **HB 2436 animal offenses published on its 3rd and final
  allowed attempt**, S 723 Tribal Trust Land Homeownership. HB 1014 child-tax-credit
  re-flagged honestly (rulemaking-subsection miscitation; attempt 2 next). Live: 881 -> 886
  published, ~160 re-authorable remain.
- **Drain wave CI — 5/6 published, then ALL LANES PAUSED (Lance, 2026-08-15: "pause after this
  wave")** (24 agents 0 errors, 1.11M tokens, record run 42101b5d): HB 1014 Missouri Child Tax
  Credit (published on retry — picked up the bear-a-relationship qualifier), SB 30 street
  lighting/road districts, S 1318 FISA-accountability/Anti-CBDC House amendment, SB 981
  workers' comp notices/surcharges, HR 1346 Clean Air Act ethanol RVP. HB 656 ballot-photo
  offenses failed Malformed (checker returned 2 key_provisions — 1st Malformed strike; its
  prior attempt was a regular content flag, so no 2-strikes park; stays in pool). **Live
  verified: 891 published** (up from 830 at this session's "resume draining" — waves CA-CI:
  61 published, 3 parked with written reasons, ~155 re-authorable remain, 11 parked total).
  State at pause: drain lane IDLE (next wave CJ builds from the 155-bill pool on Lance's go);
  autonomy build parked after Task 4 (resume at Task 5, see the SDD ledger); billed path
  CLOSED as always.
- **Drain wave CJ — 4/6 published, resumed per Lance ("resume draining", 2026-08-16), and a new
  trap found: the 6-bill launch's ~52KB args string was TRUNCATED IN TRANSPORT** — the workflow
  reported a normal launch then died in 9ms on "Unterminated string" with 0 agents run
  (PLAYBOOK lesson 39; the launch ack is an enqueue receipt, not a delivery receipt). Re-run
  as two 3-bill halves (CJ-a wf_86e6a469, CJ-b wf_dad83d70; 24 agents, 0 errors, 1.26M tokens
  combined; record run 4f29e012): HJR 169 Taxpayer Protection Act amendment published on
  reattempt (28 verdicts), HB 655 pregnancy-center tax credits, HB 1713 wastewater/water
  omnibus (reattempt), HB 743 crime-victims fund (40 verdicts — new single-bill depth record).
  HB 1098 trust companies + HB 2885 boating registrations re-flagged honestly. Waves stay
  split (2x3) from here — per-bill drafts only get bigger. Live: 891 -> 895 published, ~151
  re-authorable remain.
- **Drain wave CK — 6/6 PUBLISHED, clean sweep, and LIVE CROSSES 900** (2026-08-16, 2x3 split,
  24 agents 0 errors, 1.14M tokens, record run 60161c3e): HB 1098 trust companies (published
  on retry — the Section-A citation fix took), HB 2885 boating registrations (retry, 32
  verdicts), HR 1534 IMPACT Act cement/concrete research, HB 112 health-workforce data
  (31 verdicts), HR 9770 FY2027 continuing appropriations (34 verdicts), HB 937
  antisemitism/CROWN Act protections (38 verdicts). **Live: 895 -> 901 published** — the
  grand arc reads 115 (08-06) -> 442 -> 710 -> 830 -> 901. ~145 re-authorable remain.
- **Drain wave CL — 4/6 published** (2026-08-16, 2x3 split, 24 agents 0 errors, 1.22M tokens,
  record run c655d147): HB 1102 prescription labeling/physician assistants (28 verdicts),
  SB 1087 driver's licenses (27 — its (4) attempt counter proved to be stale campaign-era
  artifacts, zero real strikes), HR 4626 Home Appliance Protection (34), HB 1530 unemployment
  compensation (33). HB 925 biodiesel credits + HB 2203 campaign finance (42 verdicts — the
  new depth record, but a severability-clause omission flagged it) re-flagged honestly;
  attempt 2 next for both. Live: 901 -> 905 published, ~141 re-authorable remain.
- **SB 655 PARKED under the 3-attempts rule + a fabricated-UUID near-miss** (2026-08-16, during
  the wave CM build): SB 655 surfaced with counter (4); history check found 3 REAL flagged
  attempts (records-wave-l: 27 verdicts/keyProv 7; wave-n: 31/3 unsupported; wave-u: 45 verdicts
  and still missed) — parked in `build-drain-wave.mjs` PARKED set (13 entries now). While writing
  the park entry I typed a UUID from nowhere — caught it immediately, pulled the real bill_id
  (`27c2552e...`) from the args file, corrected the entry, and verified the rebuilt wave excluded
  SB 655. Standing rule held: never hand-type UUIDs; Read files and pass verbatim.
- **Drain wave CM — 6/6 PUBLISHED, clean sweep** (2026-08-16, 2x3 split, 24 agents 0 errors,
  1.18M tokens, record run 145e9d3c): both wave-CL re-flags converted on attempt 2 — HB 925
  biodiesel credits (31 verdicts; the metered-pumps qualifier now tied to retail-dealer sales
  only) and HB 2203 campaign finance (45 verdicts — NEW depth record; dropped the uncited
  candidate-committee gloss). Plus SB 190 senior tax relief (31; added the omitted 143.125
  rulemaking/nonseverability bullet), S 331 HALT Fentanyl Act (29; dropped the unverifiable
  "quantity-based" characterizations — this was one of the 5 parens-masked re-flags from the
  gate-fix pass), SB 780 political subdivisions (41; discharge-vs-refund fixed), HB 828 tax
  credits (17; sixty-day conditional qualifier restored). Live: 905 -> 911 published,
  ~135 re-authorable remain.
- **Drain wave CN — 5/6 published** (2026-08-16, 2x3 split, 24 agents 0 errors, 1.28M tokens,
  record run 59cea029): HR 22 SAVE Act converted on attempt 2 (34 verdicts; the INA catch-all
  clause restored, the refusal-to-register overreach dropped — another of the 5 parens-masked
  re-flags now cleared), SB 54 insurance group-wide supervision (37), SB 222 political
  subdivisions (30; stated_purpose now verbatim findings), HB 692 party committees (47 verdicts)
  and HB 557 child protection (48 verdicts — NEW depth record, one wave after CM set 45), both
  converting their stated_purpose/tier objections. HB 589 public health re-flagged honestly: the
  completeness checker found the new draft still omitted part of the 578.005 definitions
  (farm animal); next attempt carries that objection. Live: 911 -> 916 published,
  ~129 re-authorable remain.
- **Drain wave CO — 4/6 published, HB 589 PARKED** (2026-08-16, 2x3 split, 24 agents 0 errors,
  1.26M tokens, record run 2b202cbf): HB 158 county recall (34 verdicts; may-vs-requires modality
  fixed), HB 461 right of sepulcher (26; fund-rename bullet added), SB 90 employment security
  (50 verdicts) and HB 919 privacy protections (53 verdicts — the depth record climbs again,
  CN's 48 stood one wave), both converting their objections. Two honest flags: HR 4776 SPEED Act
  re-flagged (completeness found 3 omissions — certainty/deadlines/judicial-review provisions;
  attempt 3 next), and **HB 589 flagged a 3rd time and PARKED** — attempt 3 hit 43/44 supported
  but one refuted bullet (described a pre-existing bond-timing clause as newly added); ladder was
  578.012/578.030 omissions -> 578.005 omission (CN) -> adds-vs-kept (CO). 14 parks total.
  Live: 916 -> 920 published, ~123 re-authorable remain.
- **Drain wave CP — 2/6 published, the roughest wave of the drain; HR 4776 PARKED** (2026-08-16,
  2x3 split, 24 agents 0 errors, 1.37M tokens, record run f3f4fb5b, exit "partial"): SB 975
  ambulance districts (38 verdicts) and SB 403 health care omnibus (56 verdicts — NEW depth
  record, third consecutive wave to raise it) published. **HR 4776 SPEED Act flagged a 3rd time
  and PARKED (15 parks)** — attempt 3 added every previously-demanded bullet, but the blind
  completeness checker demanded 2 DIFFERENT condensed subsections this round
  (limitations-on-claims, programmatic documents); ladder was short-title -> 3 omissions -> 2
  different omissions — the HRES 1423 condensing class on an omnibus NEPA rewrite. HB 369 land
  management re-flagged (270.400 feral-swine/Animal Health Fund coverage; attempt 3 next). Two
  first-strike Malformed checker failures (record refused, drafts untouched): SB 794 (checker
  key_provisions=2, below the 3-7 floor) and HB 827 (checker invented two section labels not in
  the bill text). Both reappear next wave; identical 2nd strikes would park them.
  Live: 920 -> 922 published, ~121 re-authorable remain.
- **Drain wave CQ — 4/6 published; HB 369 PARKED as a CHECKER-LIMITATION case** (2026-08-16,
  2x3 split, 24 agents 0 errors, 1.48M tokens, record run 7a5176fd): HB 827 virtual schools
  converted on its Malformed retry (54 verdicts — the CP checker failure did not repeat),
  HB 1780 teacher retirement (26; stated_purpose emptied per the verbatim rule), HB 130
  transportation network companies (47; rate-ban scope fixed), HB 2003 higher-ed appropriation
  (51 verdicts; AN ACT purpose + 3.255 fund breakdown added). **HB 369 land management flagged
  a 3rd time and PARKED (16 parks) — a NEW park class:** the blind completeness checker twice
  demanded a bullet claiming the bill "creates the Animal Health Fund," but that language is
  bracketed (repealed) in the printed text; the author correctly refused to assert it both
  rounds. The park note explicitly asks human review to confirm the checker, not the author,
  was wrong. SB 794 sales tax re-flagged by the verifier (2nd real content flag; final attempt
  remains — its CP Malformed strike also did not repeat). Live: 922 -> 926 published,
  ~117 re-authorable remain. Note: on-disk campaign envelopes go stale after a re-record —
  fresh gate objections must be carried into retry args by hand (done for HR 4776 in CP and
  HB 369 in CQ); the build script's disk path only knows the campaign-era objections.
- **Drain wave CR — 2/6 published; SB 794 PARKED (checker-vs-verifier crossfire)** (2026-08-16,
  2x3 split, 24 agents 0 errors, 1.33M tokens, record run bfdec527): HB 188
  employment/immigration verification (51 verdicts; ICE-counterparty scope fixed) and HB 2013
  leases appropriation (15; preamble citation fixed) published. **SB 794 sales tax flagged a 3rd
  time and PARKED (17 parks) — a SECOND checker-limitation class:** the completeness checker had
  demanded a bullet on the bracketed-'or' deletion, the author wrote it, and the verifier then
  refuted that bullet because the EXPLANATION note it relies on is bill-wide boilerplate near
  Section A, not part of subdivision (19) — under cited-section-alone discipline the demanded
  bullet is unwritable; park note asks human review to confirm. Also flagged honestly: HB 1461
  address confidentiality (5 refuted bullets + a completeness omission — enumeration-completeness
  errors), HB 1466 occupational regulation (written-report omission), S 1383 SAVE America
  (defendant-scope inference); each at attempt 2 with one remaining. Live: 926 -> 928 published,
  ~112 re-authorable remain.
- **Drain wave CS — 4/6 published, three final-attempt conversions; HB 1466 PARKED** (2026-08-16,
  2x3 split, 24 agents 0 errors, 1.37M tokens, record run 7fb531dc): the final-attempt trio
  mostly converted — HB 1461 address confidentiality (21 verdicts; all 8 carried objections
  resolved, the enumeration-completeness class beaten by writing exhaustive lists), S 1383
  SAVE America (49 verdicts — the LAST of the 5 parens-masked re-flags from the gate-fix pass
  is now published), plus HB 2017 capital appropriation (53 verdicts; per-item authorization
  citations instead of the sweeping claim) and HB 744 orders of protection (25; its (5) counter
  was stale campaign artifacts — checked against records files before running, zero real
  strikes, published on effectively attempt 2). **HB 1466 occupational regulation PARKED on its
  3rd attempt (18 parks)** — the checker's defined-terms demands shift each round on a
  20-definition section (written-report -> "Department" -> "Certification"); HRES 1423 class.
  HB 1561 St. Louis sales tax re-flagged (refund-retention omission; final attempt remains).
  Live: 928 -> 932 published, ~108 re-authorable remain.
- **Drain wave CT — 4/6 published; HB 1561 PARKED; LANE PAUSED on Lance's "pass after this wave
  finalizes"** (2026-08-16, 2x3 split, 24 agents 0 errors, 1.30M tokens, record run 6196437f):
  HB 2375 workers' compensation (21 verdicts; commuting-exclusion + paid-leave bullets added),
  HB 1745 semitrailer registration (25; water-patrol/emergency-vehicle coverage added),
  HR 8312 Fraud Prevention and Accountability Act (48; law-enforcement-activities bullet added),
  SB 769 public-entity financial transactions (57 verdicts — NEW depth record) published.
  **HB 1561 PARKED on its 3rd attempt (19 parks)** — Section-A characterization -> CS
  refund-retention omission -> CT redistribution-formula logarithm precision refutation; each
  round fixed the prior flag and 37-verdict verification found a new precision error in this
  dense tax-formula bill. HB 685 public-office requirements re-flagged honestly ("school
  district" not in 162.291's own text; final attempt remains when the lane resumes).
  **Live: 932 -> 936 published — this drain window ran 905 -> 936 (+31) across waves CM-CT,
  with 7 parks (SB 655, HB 589, HR 4776, HB 369, SB 794, HB 1466, HB 1561; 19 total) and the
  verification-depth record climbing 45 -> 57 verdicts.** ~104 re-authorable remain
  (~36.6k+ chars each). NO summary lane is running; the drain resumes only on Lance's go.
- **Drain wave CU — 3/6 published; HB 685 PARKED; lane RESUMED on Lance's "now, back to
  draining" then "I'm taking an extended AFK, continue the drain"** (2026-08-16, 2x3 split,
  24 agents 0 errors, ~1.37M tokens, runs wf_1a787604/wf_4211da77): HR 33 Taiwan double-tax
  relief published (29 verdicts — the last of the old parens-masked re-flags, converted by
  citing SEC. 202 for the committee definitions instead of SEC. 204), HB 145 sunshine law
  (36; the 59.005-definitions attribution fixed and the 610.021 closed-records omission
  added), and HB 2002 education appropriation (**75 verdicts — NEW depth record, up from
  57**; the Section 2.285 three-percent-flexibility inference dropped and stated_purpose
  made verbatim). **HB 685 public-office requirements PARKED on its 3rd attempt (20 parks)**
  — a different single-bullet refutation each round (campaign wave-q flag -> CT's 162.291
  "school district" refutation -> CU's b15: attributing "creates a new provision" to
  105.035 when only Section A's repeal/enact lists show newness); each re-author fixed the
  prior objection and 37-verdict verification found a new attribution-precision error.
  Flagged honestly at strike 2 (one attempt remains, fresh objections to hand-carry):
  S 3971 strategic-breakthrough defense (b8/b9 both drop the same "as a result of an award
  using funds made available under a strategic breakthrough allocation" causal qualifier)
  and SB 672 state-government reorganization (b26 overstates appointment authority —
  minority leaders, not the presiding officers, appoint minority members). Live:
  936 -> 939 published, ~101 re-authorable remain.
- **Drain wave CV — 5/6 published, BOTH final-attempt retries converted, zero parks**
  (2026-08-16, ran as THREE 2-bill launches — the hand-carried objections plus full latest
  prior-summaries pushed a 2x3 half to 67.9KB, over the ~50KB transport-truncation threshold
  (PLAYBOOK lesson 39), so the wave was rebalanced 2+2+2 at 42.6/40/23.3KB; 24 agents 0
  errors, ~1.36M tokens, runs wf_05840ca1/wf_387995af/wf_2c4643a4): **S 3971
  strategic-breakthrough defense (37 verdicts) and SB 672 workforce development (58
  verdicts, deepest MO-bill verification yet) both converted on their FINAL content
  attempts** — the fix in each case was writing the previously-dropped qualifier in full
  (S 3971's "as a result of an award using funds made available under a strategic
  breakthrough allocation" causal clause; SB 672's split appointment authority with
  minority leaders appointing minority members). Also published: HB 3 higher-education
  appropriation (56 verdicts; the Section 3.130 three-percent-flexibility inference
  dropped, the University of Missouri fund-split bullet added), HB 1732 workplace
  retirement savings (35; the liability-shield proviso correctly scoped to item (4) only),
  HB 624 Show Me Success Diploma (32; the demanded adult-high-school bid-process bullet
  added). HB 2381 emergency medical dispatchers gated at strike 1 (28 verdicts; checker
  demands a 650.320 definitions bullet — Board/medical director/MOU/PSAP + the
  telecommunicator rename; fresh gate reason to hand-carry into its retry). **Process
  note: a one-character hand-typo in HB 2381's bill_text_hash was caught by diffing the
  launch against the args file before the run finished — the third launch was stopped
  ~1 min in and relaunched with the exact hash, avoiding a guaranteed hashDrift failure
  at record time.** Live: 939 -> 944 published, ~95 re-authorable remain.
- **Drain wave CW — 5/6 published; HB 2 sets a 79-verdict depth record** (2026-08-16, three
  2-bill launches again — cw-b would have been 65KB as a 2x3 half; 24 agents 0 errors,
  ~1.38M tokens, runs wf_60dd32b8/wf_541e8edb/wf_c678b164): HB 2381 emergency medical
  dispatchers converted on attempt 2 (31 verdicts; the 650.320 definitions bullet added and
  the dispatch-agency renumbering correctly described as kept-and-renumbered, not added —
  both fresh objections had flowed through the build script's DB path automatically, no
  hand-carry needed), SB 953 environmental programs (47; "vehicle" descriptor dropped from
  the emissions-inspection fee bullet), HB 326 tax credits (24; the chapter-148/153 diaper
  bank expansion added), HB 2 education appropriation (**79 verdicts — NEW depth record, up
  from 75**; the Section 2.325 flexibility inference dropped, the third appropriation bill
  fixed for that same 3-percent-shift class), and HB 2455 veteran suicide prevention (61;
  "the commission" left unidentified per cited-section-alone, stated_purpose emptied; its
  (2) counter was a stale campaign artifact — zero records hits). SB 623 child protection
  flagged at strike 2 (26 verdicts; the checker-demanded "Adds a new ground" grandparent
  bullet was refuted on the word "Adds" — brackets mark deletions only, so novelty is
  unprovable from the text; final attempt can state the provision without the novelty
  claim). Live: 944 -> 949 published, ~89 re-authorable remain.
- **Drain wave CX — 2/6 published; SB 623 PARKED (shifting-demands, 21 parks)** (2026-08-16,
  2x3 split at ~44KB per half, 24 agents 0 errors, ~1.43M tokens, runs
  wf_7505b420/wf_81481161): HB 1800 property assessment (20 verdicts; all four demanded
  definition/levy/complaint bullets added — its (4) counter was a stale artifact, zero real
  prior strikes) and HB 9 corrections appropriation (63 verdicts; the 9.080
  into-but-not-out contradiction and the AN-ACT-heading attribution both fixed) published.
  **SB 623 child protection PARKED on its 3rd attempt** — the cleanest shifting-demands
  case yet: the final draft carried ZERO verifier refutations at 26 verdicts (the
  hand-carried guidance to state the 452.402 residency ground without claiming novelty
  worked), but the blind checker then demanded a brand-new 210.566 foster-parent-rights
  bullet it had never mentioned in two prior rounds; HRES 1423 class, park note asks human
  review to confirm. Flagged honestly at strike 2 (one attempt remains each): HB 3 FY2022
  higher-ed appropriation (62 verdicts, gated — checker wants an AN ACT purpose bullet),
  HB 1696 firearms (31; b22 overbroadens the suspended-imposition bar from subsection 1 to
  the whole section), SB 982 insurance (45; b15 understates 376.427 — misses the new
  "health care services" definition). Live: 949 -> 951 published, ~85 re-authorable
  remain.
- **Drain wave CY — 5/6 published, TWO final-attempt conversions; HB 1696 PARKED (22 parks)**
  (2026-08-16, three 2-bill launches — the hand-carried HB 3 payload pushed both 2x3 halves
  to ~60KB; 24 agents 0 errors, ~1.51M tokens, runs wf_9d07014c/wf_3eb33982/wf_ea1e2254):
  **HB 3 FY2022 higher-ed appropriation converted on its FINAL attempt (63 verdicts)** — the
  hand-carried AN-ACT purpose bullet + the CX draft as prior_summary did it (the bill's
  disk-envelope path had been serving stale campaign objections), and **SB 982 insurance
  converted on its FINAL attempt (45 verdicts)** — the missed "health care services"
  definition added. Also published: HB 194 abortion laws (36; the parental-consent bullet
  correctly scoped as one of four alternative paths), SB 572 municipalities/municipal courts
  (63; the 479.368 schools-distribution claim properly attributed to the 479.359
  cross-reference), SB 296 home-improvement licensing (33; the 324.1222 carve-out added).
  **HB 1696 firearms/Blair's Law PARKED on its 3rd attempt** — rotating single-refutation
  class (HB 685/HB 1561): campaign special-prosecutor attachment -> CX subsection-1-only
  suspended-imposition scope -> CY's dropped "while actually engaged in assisting" qualifier
  at 32 verdicts; each re-author fixed the prior flag and deep verification found a new
  precision error. Live: 951 -> 956 published, ~79 re-authorable remain.
- **Drain wave CZ — 4/6 published; LANE PAUSED on Lance's "Finish this run and pause after
  completion"** (2026-08-16, three 2-bill launches, 24 agents 0 errors, ~1.45M tokens, runs
  wf_146121f5/wf_4f81552d/wf_dd79ef24): HB 9 FY2024 corrections appropriation published
  (66 verdicts; stated_purpose made verbatim), S 2503 ROTOR Act (44; the 180-day briefings
  correctly attributed to the Inspector General of the Army, not the Secretary), HB 1729
  prevailing wages (46; the department gloss dropped from 290.095 per its own
  definitions-scope clause), and SCONRES 22 FY2026 federal budget resolution (31; the
  "rising outlays" framing and the "another Senator" addition both fixed). Flagged honestly
  at strike 2, one attempt each remaining: SB 1351 education/screen-time (24 verdicts; b22
  — the FOCUS Council has 16 non-chair members, not fourteen: subdivisions (6) and (7) each
  name TWO education professionals) and HB 3 FY2024 higher-ed appropriation (61; b59 adds
  "otherwise than" to Section 3.310's grant-guidelines clause, a negation the text doesn't
  contain — both fresh refutations flow through the DB path on resume). **THE AFK DRAIN
  WINDOW CLOSES: 936 -> 960 published (+24) across waves CU-CZ, 3 parks added (HB 685,
  SB 623, HB 1696; 22 total), verification-depth record 57 -> 79 (HB 2, wave CW), ~75
  re-authorable drafts remain (all ~45k+ chars now). NO summary lane is running; resume =
  wave DA on Lance's go.**
- **Drain wave DA — 4/6 published, lane RESUMED on Lance's "resume the drain, automation is
  not needed"; HB 3 FY2024 PARKED (23 parks)** (2026-08-16, 2x3 split at ~45/48KB, 24
  agents 0 errors, ~1.49M tokens, runs wf_c0b375c7/wf_89f7fbe5): **SB 1351
  education/screen-time converted on its FINAL attempt (37 verdicts)** — the FOCUS
  Council's sixteen non-chair members finally counted right — plus SB 282 human-remains
  disposition (33; the 333.072 board-name gloss dropped), HB 1389 autocycles (16; the
  Section A scope claim fixed and the demanded 301.130 registration bullet added), and
  HB 2012 statewide-officials/judiciary appropriation (66 verdicts; the fund count
  corrected to nineteen). **HB 3 FY2024 higher-ed appropriation PARKED on its 3rd
  attempt** — rotating single-refutation class: campaign 3.005-flexibility scoping ->
  CZ's "otherwise than" negation in 3.310 -> DA's b31 mis-scoping the
  discrete-accounts/no-DWD proviso beyond the $8M DOL/TAA item at 64 verdicts. SB 51
  physical therapists flagged honestly at strike 2 (19 verdicts; b11 places 334.506's
  delegation rule under a 334.100 citation — wrong-section class, one attempt remains).
  Live: 960 -> 964 published, ~71 re-authorable remain.
- **Drain wave DB — 5/6 published, NEW verification-depth record 104 (HB 2014), SB 51
  converted on its FINAL attempt** (2026-08-16, 2+2+2 split at ~38/33/35KB, 24 agents 0
  errors, ~1.55M tokens, runs wf_390451bc/wf_54f4fd8e/wf_4dc25693): **HB 2014 FY2020
  COVID supplemental appropriation published CLEAN at 104 verdicts — the deepest
  verification run of the entire drain** (verbatim stated_purpose fixed; $6.27B across
  CARES Act school/local-government/nursing-home distributions). **SB 51 physical
  therapists SAVED on strike 3** (20 verdicts; b11's delegation rule finally cited to
  334.506 instead of 334.100 — wrong-section class conversion). Also clean: HR 3898
  PERMIT Act (63 verdicts, its deepest run; both Sec. 15 remand-exception and Sec. 16
  dual-notification refutations fixed), SCONRES 7 FY2025 budget resolution (28; the
  added definitional claim dropped and SEC. 4001's shall-vs-may split stated), and SB 71
  electrical/broadband (32; verbatim stated_purpose fixed). HB 711 open enrollment
  flagged honestly at strike 2 (76 verdicts — fixed BOTH prior objections, the
  calendar-days qualifier and the demanded 167.151 property-tax bullet, then deep
  verification found b0's homeless-child definition omits subdivision (2)'s
  primary-nighttime-residence category — rotating class, one attempt remains, fresh
  objection flows via DB path). Live: 964 -> 969 published, ~65 re-authorable remain.
- **Drain wave DC — 2/6 published, HB 711 SAVED on its FINAL attempt; ladder PAUSED on
  Lance's "Pause on those big ol Ds"** (2026-08-16, HB 711 solo at 43KB + 2+3 split at
  ~39/45KB, 24 agents 0 errors, ~1.50M tokens, runs wf_72b12531/wf_fab1b710/wf_38156139):
  **HB 711 open enrollment converted at 77 verdicts, zero refutations** — the b0
  homeless-child definition now carries subdivision (2)'s primary-nighttime-residence
  category, and both earlier fixes (calendar-days qualifier, 167.151 property-tax
  bullet) were preserved via a hand-carried [GUIDANCE] note; the stale-objection trap
  fired on the build (disk path re-served the two already-fixed wave-t objections —
  identical to the CY HB 3 case) and was caught by comparing objection text to the DB
  records before launch. SB 179 bank-filings also published CLEAN (22 verdicts; the
  Section A characterization objection resolved by moving the statutes' subject-matter
  description out of the Section A bullet). Flagged honestly, one attempt each remaining
  (ladder paused before it could be used): SB 909 trusts/digital-assets (52 verdicts; b11
  called the trust-protector definition "added" when bracket notation shows it renumbered
  from (29) to (30)), HB 970 video lottery (49; b9 extended the cross-license bar to
  handlers the text never mentions + b14 stated the discretionary "may impose" fee as
  mandatory), SB 861 transportation/tax incentives (56; b31 under-scoped the
  machinery-exclusion to related-party placements only), and HB 2057 concealed carry
  (60; b59 read an all-bill effective-date rule into Section B + checker demanded a
  Section B emergency-clause bullet). Live: 969 -> 971 published, 23 parks, ~63
  re-authorable remain. **NO summary lane is running; the drain resumes only on Lance's
  go (resume = build wave DD — note SB 909/HB 970/SB 861/HB 2057 are all disk-path
  bills whose fresh DC objections will need the hand-carry check).**
- **Drain wave DD — 3/6 published, THREE final-attempt saves (SB 861, HB 970 + HB 1991
  clean), TWO parks (HB 2057, SB 909; 25 total); lane RESUMED on Lance's "We need to
  finish this drain"** (2026-08-16, 2+2+2 split at ~45/41/47KB, 24 agents 0 errors,
  ~1.65M tokens, runs wf_26e29027/wf_08b5e173/wf_7645dc03): the predicted stale-objection
  trap fired for three of the four strike-2 retries (HB 970, SB 861, SB 909 re-served
  their already-fixed DC-build objections; HB 2057 alone came through fresh) — all three
  hand-carried fresh DC refutations + [GUIDANCE] preserve-notes, with prior_summary
  swapped to the DC drafts. **SB 861 transportation/tax incentives SAVED on strike 3**
  (58 verdicts; the 143.2115 machinery-exclusion scope finally stated in full) and
  **HB 970 video lottery SAVED on strike 3** (50 verdicts; the cross-license bar restated
  per-role without handlers and the fee stated as "may impose"). HB 1991 small-wireless
  also published CLEAN (48 verdicts; the Section A enacting-clause attribution fixed).
  **HB 2057 concealed carry PARKED on its 3rd attempt** — rotating class: stated_purpose
  gate -> DC's Section B pair -> DD fixed both and deep verification found b4
  (deadly-force "only when" omitting the third private-property condition) and b13
  (exemption missing the chapeau's "except as otherwise provided" qualifier) at 60
  verdicts. **SB 909 trusts/digital-assets PARKED on its 3rd attempt — the
  shifting-demands/checker-limitation class (HRES 1423/SB 623): its DD re-author fixed
  the added-vs-renumbered b11 and passed 53 verdicts with ZERO refutations, but the
  completeness gate demanded 456.8-808/456.1-103 bullets the draft already covers split
  across multiple bullets — the checker's compound items don't map onto the draft's
  bullet granularity; human review should confirm.** SB 799 business fees flagged
  honestly at strike 2 (45 verdicts; b20 director-title elaboration drawn from 354.010
  rather than the cited 354.150 + b33 deposit-destination overreach on the
  withdrawal-notice fee — one attempt remains). Live: 971 -> 974 published, ~58
  re-authorable remain.
- **Drain wave DE — 4/6 published, SB 799 SAVED on its FINAL attempt; the
  mechanical-prefix pattern goes 6-for-6 on refuted clauses** (2026-08-16, 2+2+2 split at
  ~36/35/31KB, 24 agents 0 errors, ~1.62M tokens, runs wf_d55c94b9/wf_359950bf/wf_dac21a40):
  all six bills carried fresh objections (SB 799 via DB path; the rest from their single
  prior attempt), and each refuted clause was mechanically pre-fixed in the prior_summary
  with a preserve-NOTE before launch — every one of the six held through re-verification.
  **SB 799 business fees converted on strike 3** (49 verdicts; the director-title and
  fee-destination scoping fixes held). Also clean: HR 3383 INVEST Act (86 verdicts — the
  second-deepest run of the drain; the six-condition sponsor list completed), SB 66
  workers' compensation (38; both demanded 287.120/287.170 bullets added), and SB 869
  political subdivisions (50; the commission-vote rule correctly scoped to subsection 3).
  SB 655 marriage-age/sex-offender-registry flagged at strike 2 DESPITE 51 verdicts and
  zero refutations — the completeness gate demanded 589.404's "adjudicated" definition
  spelled out where the draft's definitions bullet lists the term without its content
  (the SB 909 granularity class; one attempt remains). HB 2005 FY2019 appropriation
  flagged honestly at strike 2 (37 verdicts; b7 read Section 5.030's single $19.9M total
  as excluding the new-projects component — one attempt remains). Live: 974 -> 978
  published, ~52 re-authorable remain.
- **Parens-binding gate fix (2026-08-10, TDD, commit 92816ff):** `validateVerdictBinding` now
  strips ONE complete surrounding paren pair from each side before comparing (the section value
  is the verifier's echo of WHICH bullet it verified, not bill content — facts-only verbatim
  discipline doesn't apply to it). 4 new tests: bind, symmetric, real-mismatch-still-fails,
  unbalanced-paren-still-fails. Full suite 2,389/0 in a clean shell (one unrelated documented
  periodic bump rode along: the weekly-growing legiscan cache snapshot 32 -> 33, new 2239
  dataset landed 2026-08-09). **Re-recorded all 13 parens-class flags (AN:4, AO:2, AP:7) with
  --replace-drafts: 8 PUBLISHED** — S 5 + HR 29 (both Laken Riley versions), HR 4 (Rescissions),
  HR 3628, HR 23, HR 8464, HR 2988, HR 1048 (DETERRENT) — **5 re-flagged honestly** (HR 4626,
  S 331, HR 22 SAVE, S 1383, HR 33: the parens failure had short-circuited the gate and masked a
  second, real issue on each; drain-lane work). Live verified: **published 525**, drafts 316,
  retired 119. Old flagged drafts retired with audit notes via the existing supersede path.
- **Scheduled-summaries documentation + policy carve-out (2026-08-16, Task 6): docs only, zero
  code changes.** Created `docs/SCHEDULED_SUMMARIES.md` (registration command, budget model,
  reading logs/ledger, recovery properties, dry-run). Added standing-policy carve-out to
  `CLAUDE.md`: `scripts/scheduled-summaries.js` runs unattended under code-enforced $5/ISO-week
  cap; this ledger+cap IS the per-run approval for this runner only. Updated `README.md` with
  runbook pointer, `TODO.md` RESUME HERE block (replaced "autonomy build parked" with
  "scheduled-summaries BUILT, awaiting Lance: load credits + register"). Full suite 2,420/0 in
  clean shell. State: scheduler built (Tasks 1-4 complete + reviewed), documented (Task 6),
  unregistered (awaiting Lance's `schtasks` command after crediting API account); Task 5 complete
  (data-status block exists), Task 7 remains (full-suite gate + memory). Zero billed calls; $0
  build cost.
- **Scheduled-summaries: all 7 build tasks + final whole-branch review + its fix wave, complete
  (2026-08-16).** Task 5 (data-status scheduler block), Task 6 (runbook), and Task 7 (full-suite
  gate + memory) finished after the build resumed; the final whole-branch review (opus) then
  returned 2 Critical + 7 Important findings plus a must-fix triage list, all addressed in one fix
  wave (commit e92d93d for code+tests, this entry's own commit for docs): **money-safety** — an
  additive pre-bill cost-estimate guard (`estimateBillCostUsd`, keyed off a bill's own text length)
  now runs before every paid call, atop the existing 1.5x-observed monster gate (kept, not
  replaced) — the old gate alone could let a ~$0.99 monster through on as little as $0.075 of
  nominal tick-start headroom, and a crashed/stranded tick is now charged
  `Math.max(this tick's cap, the $1.00 code default)` against the weekly ledger so a throttled
  manual tick can never under-charge a prior crash. **Crash hardening** — both the plan-CLI call
  and the record-CLI call (`recordLane`) are now try/caught: a throwing plan call returns a clean
  `plan-failed` outcome before `openRun` ever runs (15-min timeout, was inheriting the 8-min
  ingestion default); a throwing record call is logged into the run's own `skipped` list instead of
  leaving the row stranded at `running` with no diagnostic trail. **Conversion lane capped +
  tested** — `MAX_CONVERSIONS_EXAMINED=50` bounds how many draft-only bills get examined per tick
  (was unbounded: hundreds of routine, expected no-verifications-yet skips every tick, each costing
  a real DB read), those routine skips no longer force tick status to `partial`, and the conversion
  lane's happy path (reAuthor args, records file, published count) has a test at all for the first
  time — previously the only unattended spending path with zero coverage. **Runbook rewritten from
  code, not patched again** — `docs/SCHEDULED_SUMMARIES.md` went through a full section-by-section
  re-verification against `scripts/scheduled-summaries.js`/`src/lib/billed-summary-chain.js`,
  eliminating roughly a dozen false claims (a nonexistent `billing-ledger.json` replaced everywhere
  with the real `ingestion_runs` + `npm run status` ledger; the `schtasks` command's `--env-file`
  and script path are now absolute, not just `node.exe`'s; "mid-chain budget check" and
  "per-call token budget derived from remaining cap" corrected — the caps gate whether a bill
  STARTS, never a call's own fixed `max_tokens`; `TICK_MAX_DURATION_MS` reframed as the lock's own
  stale-reclaim window, not a self-enforced deadline — Windows' own "Stop the task if it runs longer
  than" setting is the actual kill; the checkpoint/retry claim was INVERTED — a crashed bill IS
  retried on the next tick, cheaply, paying only for missing stages, never "starts fresh on the next
  bill instead"; a missing first-live-tick procedure was added, `SUMMARY_TICK_CAP_USD=0.10` for one
  manual throttled tick before registering). Fix-in-passing: run-detail field names
  `flagged`/`rejected` renamed to `gate_refusals`/`record_failures`; `readParkedReal` now
  distinguishes ENOENT from an abnormal read failure (never merge-writes over a parked.json it
  couldn't actually read — closes a real, if narrow, money-leak path); `data-status.js`'s scheduler
  block now uses a real 10-day window and `envCapUsd` instead of raw constants; the log line's own
  timestamp is tick-finish, not tick-start. Full suite 2,429/2,429 in a clean shell (2,420 baseline
  + 9 new tests), fail 0. **Scheduler remains UNREGISTERED** — still pending Lance's own two steps
  (reload Anthropic credits, then the `schtasks` command; an agent never runs it) exactly as before
  this fix wave; nothing in this pass changed that state or spent a cent (zero billed calls, all
  fakeDeps-driven).
