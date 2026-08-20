# VisibleGov

A civic-transparency platform: break down the bills and laws politicians propose into plain
language so anyone can quickly understand what a bill actually does and why, and surface how
legislators voted on it - so constituents can hold their representatives accountable with real
information.

**Status (2026-08-19): DEPLOYED and live at https://visiblegov.pages.dev — 1,037 plain-language
summaries published (the draft drain completed 2026-08-18; every future summary flows through
the autonomous daily scheduler under code-enforced caps). NEW: a Missouri statute glossary
source (revisor.mo.gov) is merged — adapter + jurisdiction-aware citation mapping +
re-mapping backfill, triple-audited; the backfill `--apply` and the gloss-run spend decision
await Lance (see `TODO.md` RESUME HERE).** *(Fresh
session? Read the RESUME HERE block at the top of `TODO.md` — it is verified against the live
database and outranks this paragraph, which is a dated snapshot.)* The
site is deployed to Cloudflare Pages and was verified end-to-end in a real browser (2026-08-05,
zero console errors): directory → legislator profile with real recorded votes and mechanical
vote-aggregate charts → click through to a bill page with sponsors, plain-language summary, and the
roll-call tally. Only the custom domain (`visiblegov.helpingpeoplehelpingpeople.com`) remains, and
that is console/DNS work — see `docs/CLOUDFLARE_DEPLOY.md`. Getting here: a comprehensive 8-domain
accuracy audit (4 critical findings fixed live), a senior-engineering-lens audit (21 confirmed, 19
fixed same-day), a two-phase deep audit (Fable 5, zero criticals across both), a 3-layer
`refresh_vote_aggregates()` timeout saga root-caused and fixed via migrations `0027`-`0029`, and
two bugs found and fixed *during the deploy's own verification* — the `_redirects` targets had to
be extensionless (Pages 308-canonicalizes `.html`), and migration `0031` rewrote the public views'
anti-join to `NOT EXISTS` after an anon `statement_timeout` broke every profile's vote list on
deploy night. Migrations `0001`-`0031` (plus `0018a`) are all applied and live. The MO House
per-legislator vote gap was investigated 2026-08-05 and resolved: LegiScan already covers 96.9% of
MO House votes and all 159 current members show real votes on their profiles — the gap was specific
to the `mo-house-xml` adapter, not the page, and needs no site caveat. Political neutrality and
facts-only, the project's one non-negotiable, came back genuinely clean under every audit's
dedicated domain — zero violations found. Full trail:
`docs/audits/2026-08-03-comprehensive-accuracy-audit.md`,
`docs/audits/2026-08-03-senior-engineering-audit.md`, `docs/CLOUDFLARE_DEPLOY.md`, and `TODO.md`'s
RESUME HERE block.
> **Live numbers: run `npm run status`.** An ingestion cron writes every 30 minutes, so any count
> typed into a document is stale within the hour — that staleness is exactly what made the project's
> own data state confusing. `docs/DATA_INVENTORY.md` explains what each number *means* and how they
> relate; the script is the only source of truth for what they *are*.

- **~1.47 million recorded vote casts** across ~10,000 roll calls — every one traceable to a clerk's
  XML, a journal PDF, or an official dataset, and every one attached to a real legislator and a real
  roll call by database constraint (verified: zero orphans). Missouri **votes** run 2015→2026 (bills
  go back to 2010); federal covers the current Congress only (US House via Clerk EVS, US Senate via
  LIS XML) — a senator's pre-2025 federal record is not yet ingested.
- **~38k bills · 3,630 official bill texts · 46,268 sponsorships · 1,607 legislator rows.** Text
  coverage is deliberately targeted, not broad: **99.3% of the bills that got a passage vote**
  (3,319 of 3,341) have their official text — that passage-vote set is itself only ~9% of all bills,
  because most bills die in committee without a recorded vote.
- **Plain-language pipeline live under trust model v3, with two independent trust axes**: an
  author model writes facts-only summaries from official text only; sonnet-5 adversarially refutes
  each claim (*nothing false*); a second checker independently lists the bill's key provisions
  **before seeing the summary** and verifies coverage (*nothing important missing*). Both axes
  must pass mechanically for auto-publish; anything short of that goes to the owner. Two proven
  lanes: the flat-rate subagent path ($0 API spend, opus-5 authors) and a budget-capped billed
  path (`scripts/summary-probe-api.mjs`, Haiku authors + Sonnet checks — measured **$0.041 per
  published summary** on 2026-08-09). **710 summaries published, 359 held in the review queue by
  the mechanical trust gate** (live-counted 2026-08-10 at the close of the 2025-session manifest
  campaign; up from 115 on 2026-08-06 via wave campaigns, a draft-conversion drain, the billed
  runs, and a verdict-binding gate fix) — each held-back item failed a specific, named check (a
  missing citation, an omitted provision), not a backlog nobody looked at. Roughly 2,500 eligible
  bills with text remain for future campaigns; 6 bills are parked as structurally unpublishable
  under the completeness floor (single-provision list documents), each with its reason recorded.
- **The public site is built and merged** (`site/`): directory with address lookup, legislator
  profiles with vote records and mechanical vote-aggregate charts, bill pages, and a trust page
  whose prose was fact-checked against the code. Independently verified end-to-end in a real
  browser against live data (2026-08-03): a visitor can browse the directory, open a legislator
  from any of US Senate/US House/MO Senate/MO House, see their real recorded votes, and click
  through to the actual bill. **Deployed 2026-08-05 to https://visiblegov.pages.dev** and
  re-verified live end-to-end there (same loop, zero console errors); custom domain still pending.
  See `docs/CLOUDFLARE_DEPLOY.md` for the runbook and `TODO.md`'s RESUME HERE block for current
  status.
- **Standing policy: every model-calling run is mechanically gated on explicit per-run owner
  approval with cost stated.** Current spend state (2026-08-10): the platform API balance is
  **depleted** — Lance authorized spending the final ~$2 on 2026-08-09 ($1.98 across three
  budget-capped runs) with the instruction *"Once depleted, pause waves as I do not auto reload
  credits"* — so the billed path is CLOSED. The subagent wave lane ran its authorized campaign
  to completion on 2026-08-10 and is now idle; nothing new runs, and no new funds get spent,
  without Lance's explicit go. See `TODO.md`'s RESUME HERE block
  and `CHATLOG.md` 2026-08-09 for the live trail.

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

**Adjudicate a cross-source vote-reconciliation flag** (107 open as of 2026-08-05): two of this
project's independent sources recorded the same roll call differently, and deciding which is right
is deliberately a human call, never automated. Dry-run first, always:
```
node --env-file=.env src/cli/correct-data.js reconcile-flag --flag-id <uuid>   --ruling "<short ruling>" --rationale "<why>"   [--canonical-vote <uuid> --superseded-vote <uuid>] [--dry-run]
```
Supply the vote-id pair to mark the losing row superseded (it drops out of every public surface via
the existing `vote_duplicates` mechanism; neither row is ever deleted). Omit both to close the flag
with a recorded ruling and no dedup write. One supplied id must belong to the flag being
adjudicated — the tool refuses unrelated ids rather than superseding an innocent vote row.

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
committed text is still what's live — always confirm.

## Docs

- `CLAUDE.md` - working rules for this project, pointers to sibling projects for deeper reference.
- `PLAYBOOK_DELTA.md` - lessons inherited from prior projects, read before building anything.
- `TODO.md` - backlog: current state, build queue, and raw idea inbox.
- `CHATLOG.md` - decision trail, kept from day one.
- `docs/CLOUDFLARE_DEPLOY.md` - the deploy runbook: four phases, exact Pages project settings,
  copy-paste verification commands, and the inherited traps written beside the steps that trigger
  them. All code-side pre-deploy work is done; what remains is console work.
- `docs/SCHEDULED_SUMMARIES.md` - the autonomous bill-summarization runner: registration command,
  budget model ($5/ISO-week, $1/tick code-enforced caps), reading logs and ledger, recovery
  properties, and dry-run usage.
- `docs/CONTROLLER_BRIEFING.md` - deep catch-up doc for a fresh session, compiled from the full
  project history (SDD ledgers, specs, plans, research docs, live code) - the fastest way to get
  oriented beyond what CLAUDE.md/TODO.md/CHATLOG.md alone give you.
- `docs/DATA_INVENTORY.md` - what each live number *means* and how the tables relate; `npm run
  status` is the only source of truth for what they *are*.
- `supabase/migrations/` - canonical schema + RLS migrations.
- `docs/superpowers/specs/`, `docs/superpowers/plans/` - specs and plans for each build slice.
