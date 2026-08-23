# VisibleGov

A civic-transparency platform: break down the bills and laws politicians propose into plain
language so anyone can quickly understand what a bill actually does and why, and surface how
legislators voted on it - so constituents can hold their representatives accountable with real
information.

**Status (2026-08-23): DEPLOYED and live at https://visiblegov.pages.dev — ~1,100 plain-language
summaries published (1,090 when the $0 drain lane ran to empty on 2026-08-22; `npm run status`
for the live count): the open drafts are parked bills with written reasons (reasons in
`.superpowers/artifacts/scheduled-summaries/parked.json`; `npm run status` prints the live count
as "parked (structural failures)" — a few dozen) plus whatever the latest scheduler tick refused
(2026-08-23: 32 open drafts = 28 parked + 4 fresh refusals); every future summary flows through the
registered daily scheduler (Windows Task Scheduler job "VisibleGov Scheduled Summaries", daily
06:00 since 2026-08-17, running `scripts/scheduled-summaries.js`) under code-enforced caps, and
the drain lane reopens only when the scheduler's own refusals give it candidates — re-enter it
with `node --env-file=.env scripts/build-drain-wave.mjs <WAVE> 6 --pointer`, which reports 0
candidates while there is nothing to drain (the 2026-08-23 tick's 4 refusals are the first
candidates since the lane emptied — `TODO.md` RESUME HERE). NEW (2026-08-21): the Missouri statute
glossary is LIVE — 1,217 RSMo section glosses published through the Batch-API runner for
$12.45, each with a verbatim statute quote and a revisor.mo.gov source link (glossary
published 116 → 1,333), and every linked gloss now renders on the bill page — inline or in a
"Referenced laws and terms" list. The same evening the **federal (U.S.C.) glossary drain
completed too: 525 glosses published (glossary published → 1,858; 649 of 1,045 summaries now
show a gloss) — at $8.31, over both the $8 cap and the remaining balance, so the API balance hit
$0 — Lance then loaded $7 more the same evening; the scheduler resumes under its ledger, every
other billed call still needs per-run approval** (the runner now projects each batch's cost from the banked
text before submitting; `PLAYBOOK_DELTA.md` lesson 44); see `TODO.md` RESUME HERE for what is
next.** IN-FLIGHT (2026-08-23, three threads, all in `TODO.md` RESUME HERE): the MO Senate
journal parser's `bill_refs` quarantine was root-caused and fixed (commit 5ced4eb) and the
quarantined days are being replayed — that quarantine is behind about half of the open
reconciliation flags (see the Runbook); and the 2024 MO House roll calls are now dated from
LegiScan's own printed bill history (commit 2e420d9 + migration `0032`, applied 2026-08-23 — see
the votes bullet below). *(Fresh
session? Read the RESUME HERE block at the top of `TODO.md` — it is verified against the live
database and outranks this paragraph, which is a dated snapshot.)* The
site is deployed to Cloudflare Pages and was verified end-to-end in a real browser (2026-08-05,
zero console errors): directory → legislator profile with real recorded votes and mechanical
vote-aggregate charts → click through to a bill page with sponsors, plain-language summary, and the
roll-call tally. Only the custom domain remains — DECIDED 2026-08-22 as the apex `visiblegov.us`
(Lance owns it; this supersedes the 2026-07-28 `visiblegov.helpingpeoplehelpingpeople.com`
subdomain plan), with Phases 3-4 of `docs/CLOUDFLARE_DEPLOY.md` rewritten for it — console/DNS
work that is his. Getting here: a comprehensive 8-domain
accuracy audit (4 critical findings fixed live), a senior-engineering-lens audit (21 confirmed, 19
fixed same-day), a two-phase deep audit (Fable 5, zero criticals across both), a 3-layer
`refresh_vote_aggregates()` timeout saga root-caused and fixed via migrations `0027`-`0029`, and
two bugs found and fixed *during the deploy's own verification* — the `_redirects` targets had to
be extensionless (Pages 308-canonicalizes `.html`), and migration `0031` rewrote the public views'
anti-join to `NOT EXISTS` after an anon `statement_timeout` broke every profile's vote list on
deploy night. Migrations `0001`-`0031` (plus `0018a`) are all applied and live; `0032`
(`votes.vote_date_provenance` — the receipt for a 2024 MO House roll-call date derived from the
bill's printed history) is DRAFTED and committed but NOT applied as of 2026-08-23 — verify with a
live column check before trusting either state (Runbook, "Apply a database migration"). The MO House
per-legislator vote gap was investigated 2026-08-05 and resolved: LegiScan already covers 96.9% of
MO House votes and all 159 current members show real votes on their profiles — the gap was specific
to the `mo-house-xml` adapter, not the page, and needs no site caveat. Political neutrality and
facts-only, the project's one non-negotiable, came back genuinely clean under every audit's
dedicated domain — zero violations found. Full trail:
`docs/audits/2026-08-03-comprehensive-accuracy-audit.md`,
`docs/audits/2026-08-03-senior-engineering-audit.md`, `docs/CLOUDFLARE_DEPLOY.md`, and `TODO.md`'s
RESUME HERE block.
> **Live numbers: run `npm run status`.** A registered Task Scheduler job ("VisibleGov Scheduled
> Ingestion", `scripts/scheduled-ingest.js`, every 15 minutes since 2026-07-31, with per-source
> ToU cooldowns — 30 minutes for the two Missouri sources, ≥1 hour federal, ≥24 hours
> LegiScan — `docs/SCHEDULED_INGESTION.md`) writes continuously, so any count
> typed into a document is stale within the hour — that staleness is exactly what made the project's
> own data state confusing. `docs/DATA_INVENTORY.md` explains what each number *means* and how they
> relate; the script is the only source of truth for what they *are*. Two of its lines are easy to
> misread: "summaries retired (superseded)" is the audit trail of drafts replaced by a later
> attempt, not failures, and "summaries awaiting review" counts open drafts only (as of 2026-08-23
> nearly all of those are parked bills).

- **~1.47 million recorded vote casts** across ~10,000 roll calls — every one traceable to a clerk's
  XML, a journal PDF, or an official dataset, and every one attached to a real legislator and a real
  roll call by database constraint (verified: zero orphans). Missouri **votes** run 2015→2026 (bills
  go back to 2010); federal covers the current Congress only (US House via Clerk EVS, US Senate via
  LIS XML) — a senator's pre-2025 federal record is not yet ingested. **2024 MO House is a known
  hole** (~2,500 MO casts that year against 205k in 2023 and 64k in 2025 — `npm run status`
  "casts by year"): LegiScan prints every 2024 House roll call with a `0000-00-00` date, the
  ingest refuses to invent one, and the House's own XML export serves only the current General
  Assembly (verified in a browser 2026-08-23), so the `mo-house-xml` adapter cannot fill it either.
  RECOVERED 2026-08-23 (commits 2e420d9 + migration 0032, applied by Lance): 185 of the 275 are now stored under a date derived from the one dated, tallied action in the bill's own history printing their exact AYES/NOES, each carrying that action as its receipt; the other 90 stay refused by design.
  `docs/DATA_INVENTORY.md` GAP 1 has the breakdown.
- **~38k bills · 3,630 official bill texts · 46,268 sponsorships · 1,607 legislator rows.** Text
  coverage is deliberately targeted, not broad: **99.3% of the bills that got a passage vote**
  (3,319 of 3,341 as of 2026-08-05; the ratio still held on 2026-08-23 — `npm run status` BILL
  FUNNEL) have their official text — that passage-vote set is itself only ~9% of all bills,
  because most bills die in committee without a recorded vote.
- **Plain-language pipeline live under trust model v3, with two independent trust axes**: an
  author model writes facts-only summaries from official text only; sonnet-5 adversarially refutes
  each claim (*nothing false*); a second checker independently lists the bill's key provisions
  **before seeing the summary** and verifies coverage (*nothing important missing*). Both axes
  must pass mechanically for auto-publish; anything short of that goes to the owner. Two proven
  lanes: the flat-rate subagent path ($0 API spend, opus-5 authors) and a budget-capped billed
  path (`scripts/summary-probe-api.mjs`, Haiku authors + Sonnet checks — measured **$0.041 per
  published summary** on 2026-08-09). **~1,100 summaries published; the review queue was drained to
  empty on 2026-08-22** (`npm run status` for live counts — the remaining drafts are parked
  bills with written reasons plus the latest tick's fresh refusals (4 on 2026-08-23), and ~600
  retired attempts keep the audit trail). *(Superseded
  snapshot, kept for the arc: 710 published / 359 held in the review queue by the mechanical trust
  gate, live-counted 2026-08-10 at the close of the 2025-session manifest campaign; up from 115 on
  2026-08-06 via wave campaigns, a draft-conversion drain, the billed runs, and a verdict-binding
  gate fix.)* Each held-back item failed a specific, named check (a missing citation, an omitted
  provision), not a backlog nobody looked at; a held draft is re-authored against its recorded
  objections, and a bill whose attempts are exhausted is parked with a written reason. Roughly
  2,500 eligible bills with text remain for future campaigns; a few dozen bills are parked as
  structurally unpublishable under the completeness floor (the original 6 on 2026-08-10 were
  single-provision list documents; the set had grown to 31 by 2026-08-23 — reasons in
  `.superpowers/artifacts/scheduled-summaries/parked.json`, live count under `npm run status`
  "parked (structural failures)"). **The owner's review surface is `npm run review`**
  (`src/review/server.js`): it shows the summaries and glossary terms the pipeline could not
  auto-handle, flagged items first — the queue waiting there as of 2026-08-23 is mostly the 419
  glosses flagged by the two 2026-08-21 glossary drains (279 MO + 140 USC — `TODO.md` RESUME
  HERE); `npm run status` "glossary awaiting review" prints the whole mappable-draft pile (522 on
  2026-08-23), which also counts the drafts the drains could not author (nonexistent or oversize
  sections, author failures) and ~30 structural leftovers.
- **The public site is built and merged** (`site/`): directory with address lookup, legislator
  profiles with vote records and mechanical vote-aggregate charts, bill pages, and a trust page
  whose prose was fact-checked against the code. Independently verified end-to-end in a real
  browser against live data (2026-08-03): a visitor can browse the directory, open a legislator
  from any of US Senate/US House/MO Senate/MO House, see their real recorded votes, and click
  through to the actual bill. **Deployed 2026-08-05 to https://visiblegov.pages.dev** and
  re-verified live end-to-end there (same loop, zero console errors); custom domain
  (`visiblegov.us`, decided 2026-08-22) still pending.
  See `docs/CLOUDFLARE_DEPLOY.md` for the runbook and `TODO.md`'s RESUME HERE block for current
  status.
- **Standing policy: every model-calling run is mechanically gated on explicit per-run owner
  approval with cost stated** — with ONE carve-out: the registered daily scheduler
  (`scripts/scheduled-summaries.js`, Task Scheduler job "VisibleGov Scheduled Summaries",
  registered 2026-08-17) bills on its own under a code-enforced $1/tick + $5/ISO-week ledger,
  and that ledger IS its approval; every other billed call still needs Lance's explicit go.
  Spend state (2026-08-21): the $20 loaded 2026-08-17 was consumed by 2026-08-21 evening — the
  scheduler ($1.96), a gloss probe ($0.10), the MO glossary drain ($12.45), and the USC glossary
  drain ($8.31, which overran its $8 cap — disclosed in `CHATLOG.md` 2026-08-21; the runner now
  projects each batch from the banked text before submitting) — so the balance hit $0; Lance
  reloaded $7 the same evening, from which only the scheduler draws (~$0.35-0.70 per tick; the
  2026-08-22 drain spent $0 — subagent path only). Never assume a further reload; the console
  is the truth. The glossary Batch-API runner is `scripts/gloss-batch-mo.mjs --source mo|usc
  --budget-usd N` (per-run approval; `--resume` picks up from its checkpoints; stop or check a
  running one by PID, never by command-line grep — `PLAYBOOK_DELTA.md` lesson 43). History
  (superseded 2026-08-17 by the scheduler's registration; kept because the instruction still
  governs every non-scheduler lane): the previous balance was spent 2026-08-09 — Lance
  authorized the final ~$2 ($1.98 across three budget-capped runs) with the instruction *"Once
  depleted, pause waves as I do not auto reload credits"*, the billed path was CLOSED, and the
  subagent wave lane ran its authorized campaign to completion on 2026-08-10 and went idle;
  "nothing new runs, and no new funds get spent, without Lance's explicit go" described that
  state and still describes everything outside the scheduler's ledger. See `TODO.md`'s RESUME
  HERE block and `CHATLOG.md` 2026-08-09 / 2026-08-21 for the live trail.

## The one non-negotiable

This only works if it's mechanically neutral: same treatment regardless of party, everything
traceable to the actual bill text and the actual recorded vote, no editorializing in a summary.
See `PLAYBOOK_DELTA.md` §2.

## Runbook

*(Added 2026-08-03, senior engineering audit finding 18: no single canonical setup/runbook existed
— the migration-apply procedure was scattered across 4+ docs, and `scripts/serve-site.js` wasn't
referenced anywhere in `package.json` or here.)*

**Prerequisites:** Node >=22 (`engines` in `package.json`). Copy the real `SUPABASE_URL` /
`SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` (plus any source API keys — Congress.gov,
LegiScan, Anthropic — that a given CLI needs) into a repo-root `.env` file; every script that
touches the network or the DB is invoked as `node --env-file=.env <path>` (see the `scripts` block
in `package.json` for the ones with an `npm run` shortcut already wired up).

**Run the tests:** `npm test` (equivalently `node --test`) — the whole suite, zero live network/DB
calls anywhere in it. Gate any commit on the extracted `ℹ fail N` line, never the process's exit
status (`PLAYBOOK_DELTA.md` lesson 14). **Run it in a clean shell — never one where you have
`source`d `.env`**: that exports the Supabase credentials into the test process and turns 2
CORRECT tests red (`review-logic.test.js` asserts the review server degrades when no DB client is
configured; with credentials present it correctly returns 200 where the test correctly expects
500). Verified deterministically 2026-08-05 — see `PLAYBOOK_DELTA.md` lesson 30. Every CLI takes
`--env-file=.env` specifically so credentials never leak into the shell.

**Run the site locally:** `node scripts/serve-site.js` — a zero-dependency static server (port
8990) mirroring Cloudflare Pages' own `site/_redirects` rewrites and geocode Function passthrough,
so local dev behaves the same as production. Never used in production itself; Cloudflare Pages
serves `site/` directly from the repo.

**Adjudicate a cross-source vote-reconciliation flag** (`npm run status` OPERATOR QUEUE prints the
open count — 107 on 2026-08-05, a few hundred on 2026-08-23): two of this project's independent
sources recorded the same roll call differently, and deciding which is right is deliberately a
human call, never automated. **Many open flags are NOT human-adjudication cases, though**
(live 2026-08-23: 364 open, 187 of them `legiscan vs mo-senate-web`, and 176 carrying the reason
`no_tally_corresponding_primary` — 68 Senate, 108 `mo-house-xml`): the Senate ones were minted
when a LegiScan 2026 roll call had no MO Senate journal twin yet, because the journal parser's
`bill_refs` failure class was quarantining whole days — root-caused and fixed 2026-08-23 (commit
5ced4eb); the quarantined days are being replayed (the 14 2026-session days drain through the
ingestion scheduler's `mo-senate-web` slot — measured at one day per ~1.5-1.75 h on 2026-08-23,
not one per 15-minute tick; a 52-day 2018 journal backlog surfaced alongside and is Lance's call).
Flags are additive and nothing in the ingest path closes one when its twin later arrives, so once
the replay and the next LegiScan cross-check have landed,
`node --env-file=.env scripts/resolve-matched-reconciliation-flags.mjs` (dry-run by default;
`--apply` on Lance's go; records the resolution inside the flag, never deletes) closes in bulk
every `no_tally_corresponding_primary` flag whose LegiScan vote has since been paired to a
primary-source twin in `vote_duplicates`. What is left after that is the human call below. Dry-run first, always:
```
node --env-file=.env src/cli/correct-data.js reconcile-flag --flag-id <uuid>   --ruling "<short ruling>" --rationale "<why>"   [--canonical-vote <uuid> --superseded-vote <uuid>] [--dry-run]
```
Supply the vote-id pair to mark the losing row superseded (it drops out of every public surface via
the existing `vote_duplicates` mechanism; neither row is ever deleted). Omit both to close the flag
with a recorded ruling and no dedup write. One supplied id must belong to the flag being
adjudicated — the tool refuses unrelated ids rather than superseding an innocent vote row.

**Keep session start dates filled (recency-first ordering depends on them):** both the wave
exporter and the daily scheduler order "newest session first" on `sessions.start_date`, and the
drivers that mint session rows write no date — 30 of 31 Missouri sessions were silently undated
until 2026-08-22. Dry-run first, always: `node --env-file=.env src/cli/sync-session-dates.js`
prints every row it would date with its source (Mo. Const. art. III §20 for regular sessions;
the earlier of OpenStates and the LegiScan dataset's first recorded bill action for specials);
`--apply` fills NULLs only and records a run naming each source. If `export-summary-wave.mjs` or
a scheduler tick logs `WARNING: ... no start_date`, re-run it.

**Check live data state:** `npm run status` (`scripts/data-status.js`) prints the current real
counts and per-source freshness — the only source of truth for "what's true right now"; see
`docs/DATA_INVENTORY.md` for what each number *means*.

**Apply a database migration (the ONE canonical description — every other doc that mentions this
procedure should point here, not restate it):** migrations in `supabase/migrations/*.sql` are
**draft-then-apply**: an agent writes and commits the `.sql` file, but only Lance ever runs it,
pasted directly into the Supabase project's SQL Editor. There is no CLI/local Supabase setup in
this repo and no automated apply step. After Lance confirms a migration ran, verify it landed
correctly with a live, read-only check — `node --env-file=.env scripts/probe-public-surface.js`
covers the public read-surface shape/grants; a targeted REST call or `data-status.js` covers
anything else. Never assume "drafted" means "applied," and never assume a migration file's
committed text is still what's live — always confirm. **Nothing is pending as of 2026-08-23:**
`0032_vote_date_provenance.sql` was applied that day and the re-ingest ran against
the cached 2024 dataset (`--dataset-file <envelope>`, $0, no API query — the envelope is the cached
`.superpowers/artifacts/legiscan-datasets/2122-*.json` wrapped as `{ "status": "OK", "dataset": <that
file> }`; `TODO.md` RESUME HERE names a session-scratchpad copy, which may need re-wrapping) to
store them.

## Docs

- `CLAUDE.md` - working rules for this project, pointers to sibling projects for deeper reference.
- `PLAYBOOK_DELTA.md` - lessons inherited from prior projects, read before building anything.
- `TODO.md` - backlog: current state, build queue, and raw idea inbox.
- `CHATLOG.md` - decision trail, kept from day one.
- `docs/CLOUDFLARE_DEPLOY.md` - the deploy runbook: four phases, exact Pages project settings,
  copy-paste verification commands, and the inherited traps written beside the steps that trigger
  them. All code-side pre-deploy work is done; what remains is console work (Phases 3-4,
  rewritten 2026-08-22 for `visiblegov.us`).
- `docs/SCHEDULED_SUMMARIES.md` - the autonomous bill-summarization runner: registration command,
  budget model ($5/ISO-week, $1/tick code-enforced caps), reading logs and ledger, recovery
  properties, and dry-run usage. REGISTERED 2026-08-17 as the Task Scheduler job "VisibleGov
  Scheduled Summaries" (daily 06:00); the doc's registration note carried a "NOT YET REGISTERED"
  line from the build until it was corrected 2026-08-23 — trust `Get-ScheduledTask`, not prose.
- `docs/SCHEDULED_INGESTION.md` - the unattended ingestion runner (`scripts/scheduled-ingest.js`):
  registered 2026-07-31 as the Task Scheduler job "VisibleGov Scheduled Ingestion" (every 15
  minutes; per-source ToU cooldowns do the real gating), its source registry, logs, and the
  registration command kept for reference.
- `docs/RUNBOOK_SUMMARY_WAVES.md` - the $0 subagent summary lane, step by step (Lance's 2026-08-07
  ruling); `scripts/build-drain-wave.mjs` builds its re-author waves from the live draft pile.
- `docs/DISASTER_RECOVERY.md` - full rebuild from a bare `git clone` for a session with no prior
  context: schema, infrastructure, and re-ingestion from the original public sources.
- `docs/ARTIFACTS.md` - what the ~1 GB gitignored `.superpowers/artifacts/` cache holds (969 MB when
  that doc was written, 1,075 MB on 2026-08-23), what it costs to re-fetch, and the rules that bind
  a rebuild.
- `docs/VOTERTABLES_JOIN_GAMEPLAN.md` - PROPOSAL (written 2026-08-17) for joining VisibleGov
  with Lance's VoterTables project — its Phase 1 ("Find my legislators" address lookup) had already
  shipped 2026-07-30; Phases 2-3 are not built.
- `docs/audits/` - the two 2026-08-03 audits cited in the status paragraph. `docs/adjudications/`
  holds recorded human rulings on data flags; `docs/research/` holds the source investigations
  (MO data sources, MO Senate sources, LegiScan terms and substitute vehicles).
- `docs/CONTROLLER_BRIEFING.md` - deep catch-up doc for a fresh session, compiled from the full
  project history (SDD ledgers, specs, plans, research docs, live code) - the fastest way to get
  oriented beyond what CLAUDE.md/TODO.md/CHATLOG.md alone give you.
- `docs/DATA_INVENTORY.md` - what each live number *means* and how the tables relate; `npm run
  status` is the only source of truth for what they *are*.
- `supabase/migrations/` - canonical schema + RLS migrations.
- `docs/superpowers/specs/`, `docs/superpowers/plans/` - specs and plans for each build slice.
