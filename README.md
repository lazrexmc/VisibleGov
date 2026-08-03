# VisibleGov

A civic-transparency platform: break down the bills and laws politicians propose into plain
language so anyone can quickly understand what a bill actually does and why, and surface how
legislators voted on it - so constituents can hold their representatives accountable with real
information.

**Status (2026-08-03): back end live and accurate; a comprehensive 8-domain accuracy audit ran, all
4 critical findings fixed and verified live; the Cloudflare Pages deploy is now actively being
spec'd (in progress, see `TODO.md`).** The cross-adapter vote-duplicate fix (migration 0022) is
applied and live; its backfill correctly yields ~0 matches for MO House specifically, because a
separate, deeper gap (a one-legislator test-fixture roster in the MO House roll-call-PDF pipeline)
leaves most MO House per-legislator vote data structurally incomplete — a real, disclosed,
still-open item, not a regression in the dedup fix itself. Political neutrality and facts-only,
the project's one non-negotiable, came back genuinely clean under the audit's dedicated domain —
zero violations found. Full trail: `docs/audits/2026-08-03-comprehensive-accuracy-audit.md` and
`TODO.md`'s NOW section.
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
  through to the actual bill. Not deployed yet — the Cloudflare Pages deploy is being actively
  spec'd now that the owner considers the backend locked in; see `TODO.md`'s Cloudflare Pages entry
  for the live gameplan.
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
