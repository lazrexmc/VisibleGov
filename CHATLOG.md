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
