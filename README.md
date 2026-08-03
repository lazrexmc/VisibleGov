# VisibleGov

A civic-transparency platform: break down the bills and laws politicians propose into plain
language so anyone can quickly understand what a bill actually does and why, and surface how
legislators voted on it - so constituents can hold their representatives accountable with real
information.

**Status (2026-08-03): back end live and accurate; public site built and merged, deploy deliberately
deferred until the backend is locked in.** One open accuracy item: cross-adapter vote duplicates
are double-counted in the vote-aggregate percentages until a drafted-but-unapplied migration lands
(code complete, tested; see `TODO.md`).
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
  whose prose was fact-checked against the code. Not deployed yet — by the owner's call, deploying
  before the backend is locked means troubleshooting two intertwined systems at once.
- Every model-calling run is mechanically gated on explicit per-run owner approval with cost
  stated. See `TODO.md` and `CHATLOG.md` for the live trail.

## The one non-negotiable

This only works if it's mechanically neutral: same treatment regardless of party, everything
traceable to the actual bill text and the actual recorded vote, no editorializing in a summary.
See `PLAYBOOK_DELTA.md` §2.

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
