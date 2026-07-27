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
