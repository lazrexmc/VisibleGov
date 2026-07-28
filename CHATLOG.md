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
