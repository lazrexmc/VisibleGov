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
