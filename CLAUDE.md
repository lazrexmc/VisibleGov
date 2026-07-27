# VisibleGov

**Read `PLAYBOOK_DELTA.md` first.** It's the distilled, reusable lessons from Lance's other
projects (an ML/quant ingestion platform, a TCG deck-builder, a feature-film pipeline, a small-
business ops platform, a two-sided marketplace) - read before touching anything else.

## What this is

A civic-transparency platform, Lance's own idea (2026-07-27): break down bills and laws
politicians propose into plain language so anyone can quickly understand what a bill actually does
and why, and surface how legislators voted on it - so people can hold their own representatives
accountable with real information instead of spin.

**Status: pre-brainstorm.** Nothing has been built yet. This repo currently holds only the seeded
lessons doc, this file, and a starter TODO. The next real step is a proper brainstorm/scoping pass
(data sources, MVP scope, stack choice) before any code - see TODO.md.

## The one non-negotiable

See `PLAYBOOK_DELTA.md` §2. This only works if it's mechanically neutral - same treatment
regardless of party, everything traceable to the actual bill text and the actual recorded vote, no
editorializing in a summary. Check every design decision against this before it ships.

## Where to look for deeper reference (don't duplicate these into this repo - read in place)

- `C:\Users\lance\OneDrive\Desktop\MidMoConsultant\LinkedUmp\` - closest sibling in shape (public
  data presentation + a staff-managed backend + Cloudflare/Supabase stack). Its `PLAYBOOK_DELTA.md`
  is the direct parent of this one. Its `supabase/*.sql` migrations are a good reference for
  RLS-as-the-wall patterns if VisibleGov ends up on the same stack.
- `F:\league\` - the ingestion-pipeline/data-pipeline sibling. `AGENTS.md`, `PROJECT_LAYOUT.md`,
  and the promotion-gate/drift-detection docs referenced in this repo's PLAYBOOK_DELTA §3 are the
  deepest well if VisibleGov's bill/vote ingestion needs something more sophisticated than what's
  summarized here.
- `F:\Pokemon\` - the LLM-grounding sibling (`CLAUDE.md`'s "Critical domain gotchas" section, the
  `pokedb` grounding-database pattern) if the bill-summarization pipeline needs a closer look at
  how to keep an LLM from inventing content.
- `F:\Inoculated by the Phoenix\` - the canon/handoff sibling, if VisibleGov ever needs a
  paste-ready LLM_HANDOFF-style onboarding doc for a fresh session.

## Working conventions

Global conventions (chatlog discipline, TODO structure, draft-then-apply, etc.) live in
`~/.claude/CLAUDE.md` and apply here too. This file only holds what's specific to VisibleGov.
