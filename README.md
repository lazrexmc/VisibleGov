# VisibleGov

A civic-transparency platform: break down the bills and laws politicians propose into plain
language so anyone can quickly understand what a bill actually does and why, and surface how
legislators voted on it - so constituents can hold their representatives accountable with real
information.

**Status (2026-08-04): back end live and accurate.** Three rounds of work landed 2026-08-03 →
2026-08-04: a comprehensive 8-domain accuracy audit (4 critical findings fixed and verified live),
a senior-engineering-lens audit (21 findings confirmed, 19 fixed live the same day, 2 deliberately
deferred as minor), and a 3-layer `refresh_vote_aggregates()` timeout saga (a Supabase gateway
timeout, a Postgres `statement_timeout` arm-timing trap, then a query-planner anti-join
misestimation) root-caused and fixed via migrations `0027`-`0029` — a manual refresh now completes
in ~19s and real scheduled `pg_cron` ticks are succeeding. Migrations `0001`-`0029` (plus `0018a`)
are applied and live. The cross-adapter vote-duplicate fix (migration 0022) is applied and live;
its backfill correctly yields ~0 matches for MO House specifically, because a separate, deeper gap
(a one-legislator test-fixture roster in the MO House roll-call-PDF pipeline) leaves most MO House
per-legislator vote data structurally incomplete — a real, disclosed, still-open item, not a
regression in the dedup fix itself. Political neutrality and facts-only, the project's one
non-negotiable, came back genuinely clean under the accuracy audit's dedicated domain — zero
violations found. The Cloudflare Pages deploy has not happened yet — spec brainstorming was in
progress as of 2026-08-03 (two sub-decisions still open) and hasn't been resumed or re-confirmed
since the timeout saga above took priority; see `TODO.md`'s NOW section for the live state. Full
trail: `docs/audits/2026-08-03-comprehensive-accuracy-audit.md`,
`docs/audits/2026-08-03-senior-engineering-audit.md`, and `TODO.md`'s NOW section.
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
- **Plain-language pipeline live under trust model v3, with two independent trust axes**: opus-5
  authors facts-only summaries from official text only; sonnet-5 adversarially refutes each claim
  (*nothing false*); a second checker independently lists the bill's key provisions **before seeing
  the summary** and verifies coverage (*nothing important missing*). Both axes must pass
  mechanically for auto-publish; anything short of that goes to the owner. Runs on the flat-rate
  subagent path — $0 in API spend. **115 summaries published, 98 held in the review queue by the
  mechanical trust gate** out of ~3,300 eligible bills — each held-back item failed a specific,
  named check (a missing citation, an omitted provision), not a backlog nobody looked at. The votes
  are still the strong part; the plain-language layer is still early relative to the ~3,300
  eligible, but no longer thin in absolute terms.
- **The public site is built and merged** (`site/`): directory with address lookup, legislator
  profiles with vote records and mechanical vote-aggregate charts, bill pages, and a trust page
  whose prose was fact-checked against the code. Independently verified end-to-end in a real
  browser against live data (2026-08-03): a visitor can browse the directory, open a legislator
  from any of US Senate/US House/MO Senate/MO House, see their real recorded votes, and click
  through to the actual bill. Not deployed yet — Cloudflare Pages spec brainstorming was in
  progress as of 2026-08-03 (two sub-decisions still open) and hasn't been resumed since a separate
  migration/timeout debugging saga took priority; see `TODO.md`'s NOW section for the live
  gameplan and current status.
- **Standing policy: every model-calling run is mechanically gated on explicit per-run owner
  approval with cost stated** — currently under Lance's own explicit, active suspension (2026-08-03,
  "temporarily remove the usage and credit usage restrictions... until I reinstate them"; the rule
  text stays in place in `CLAUDE.md` so reinstating it is a one-line revert, not a rewrite). Treat
  the suspension as still in effect until Lance says otherwise. See `TODO.md` and `CHATLOG.md` for
  the live trail.

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
status (`PLAYBOOK_DELTA.md` lesson 14).

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
- `docs/CONTROLLER_BRIEFING.md` - deep catch-up doc for a fresh session, compiled from the full
  project history (SDD ledgers, specs, plans, research docs, live code) - the fastest way to get
  oriented beyond what CLAUDE.md/TODO.md/CHATLOG.md alone give you.
- `docs/DATA_INVENTORY.md` - what each live number *means* and how the tables relate; `npm run
  status` is the only source of truth for what they *are*.
- `supabase/migrations/` - canonical schema + RLS migrations.
- `docs/superpowers/specs/`, `docs/superpowers/plans/` - specs and plans for each build slice.
