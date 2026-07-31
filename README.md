# VisibleGov

A civic-transparency platform: break down the bills and laws politicians propose into plain
language so anyone can quickly understand what a bill actually does and why, and surface how
legislators voted on it - so constituents can hold their representatives accountable with real
information.

**Status (2026-07-31): back end live and accurate; public site built and merged, deploy deliberately
deferred until the backend is locked in.**
- **1,465,102 recorded vote casts** across 9,974 roll calls — every one traceable to a clerk's XML,
  a journal PDF, or an official dataset. Missouri 2015→2026 (both chambers); federal covers the
  current Congress (both chambers, US House via Clerk EVS, US Senate via LIS XML).
- **38,260 bills · 3,630 official bill texts · 46,268 sponsorships · 1,607 legislators** (37 unified
  into cross-source persons). 99.3% of accountability-relevant Missouri bills (3,319 of 3,341 with a
  passage vote) now have their official text on hand.
- **Plain-language pipeline live under trust model v3, with two independent trust axes**: opus-5
  authors facts-only summaries from official text only; sonnet-5 adversarially refutes each claim
  (*nothing false*); a second checker independently lists the bill's key provisions **before seeing
  the summary** and verifies coverage (*nothing important missing*). Both axes must pass
  mechanically for auto-publish; flagged items go to the owner. 37 bills published, 116 glossary
  entries. Runs on the flat-rate subagent path — $0 in API spend.
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
- `supabase/migrations/` - canonical schema + RLS migrations.
- `docs/superpowers/specs/`, `docs/superpowers/plans/` - specs and plans for each build slice.
