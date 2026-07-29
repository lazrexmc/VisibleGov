# VisibleGov

A civic-transparency platform: break down the bills and laws politicians propose into plain
language so anyone can quickly understand what a bill actually does and why, and surface how
legislators voted on it - so constituents can hold their representatives accountable with real
information.

**Status (2026-07-28): back end substantially live; public site (Plan 3) not yet started.**
- **Federal voting records complete for the current Congress**: every recorded roll call, every
  member's individual position, both chambers (US House via Clerk EVS, US Senate via LIS XML).
- **Missouri both chambers in progress**: MO House XML/roll-call-PDF pipeline enriching on the
  source's own 30-minute cadence; MO Senate journals-first pipeline (day-journal PDF parsing
  with printed-tally reconciliation) merged and backfilling 2018 forward. A LegiScan bulk
  adapter (individual MO votes confirmed populated, sessions to 2010) is being built to become
  the primary MO path, with the primary-source parsers as the reconciliation/audit layer.
- **Plain-language pipeline live under trust model v3**: opus-5 authors facts-only summaries and
  referenced-law glosses from official text only; sonnet-5 adversarially refutes; verified-clean
  items auto-publish with per-item audit logs; the owner reviews flagged items only. 104
  glossary Background entries published; 25 bills summarized.
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
