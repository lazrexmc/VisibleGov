# VisibleGov

A civic-transparency platform: break down the bills and laws politicians propose into plain
language so anyone can quickly understand what a bill actually does and why, and surface how
legislators voted on it - so constituents can hold their representatives accountable with real
information.

**Status: concept validated, slice 1 built and live-verified (2026-07-27).** Slice 1 (foundation
+ dual-jurisdiction ingestion) is complete on branch `slice1-foundation-ingestion`: one legislator
(Bob Onder) ingested end-to-end from both Congress.gov and OpenStates into Supabase. Summarization
and the public site are next (Plans 2-3) - see `TODO.md` and `CHATLOG.md`.

## The one non-negotiable

This only works if it's mechanically neutral: same treatment regardless of party, everything
traceable to the actual bill text and the actual recorded vote, no editorializing in a summary.
See `PLAYBOOK_DELTA.md` §2.

## Docs

- `CLAUDE.md` - working rules for this project, pointers to sibling projects for deeper reference.
- `PLAYBOOK_DELTA.md` - lessons inherited from prior projects, read before building anything.
- `TODO.md` - backlog, currently just the raw idea capture and the next step.
- `CHATLOG.md` - decision trail, kept from day one.
- `supabase/migrations/` - canonical schema + RLS migrations.
- `docs/superpowers/specs/`, `docs/superpowers/plans/` - specs and plans for each build slice.
