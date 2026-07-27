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
