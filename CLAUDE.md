# VisibleGov

**Read `PLAYBOOK_DELTA.md` first.** It's the distilled, reusable lessons from Lance's other
projects (an ML/quant ingestion platform, a TCG deck-builder, a feature-film pipeline, a small-
business ops platform, a two-sided marketplace) - read before touching anything else.

## What this is

A civic-transparency platform, Lance's own idea (2026-07-27): break down bills and laws
politicians propose into plain language so anyone can quickly understand what a bill actually does
and why, and surface how legislators voted on it - so people can hold their own representatives
accountable with real information instead of spin.

**Status (2026-08-03): backend live and accurate — an 8-domain accuracy audit ran end-to-end, all
4 critical findings fixed and verified live; public site built, merged, and independently verified
in a real browser against live data; the Cloudflare Pages deploy is now actively being spec'd (in
progress — see `TODO.md` NOW).** The repo holds the ingestion CLIs and adapters (`src/`), the
public site (`site/`), schema migrations (`supabase/migrations/`, 0001-0026 all applied — the
newest three, 0023/0025/0026, all landed and verified live 2026-08-03; 0025's column-scoping had
one real fallout, a `site/js/bill-page.js` query missing an explicit `select=`, fixed same pass —
see TODO.md), and fixture-backed tests (`tests/`, 2,300+ green — run `node --test` for the exact
current count; a senior engineering audit, 2026-08-03, flagged exact test-count citations in docs
as needless churn — prefer magnitude language like this one). **Live numbers: run `npm run
status`** — any count typed into a doc goes stale within the hour.

**If you are a fresh session, read these first, in order:** `PLAYBOOK_DELTA.md` (reusable traps —
25 lessons, several earned the hard way in THIS repo), `TODO.md` NOW (what's actually open —
currently mid-brainstorm on the Cloudflare deploy spec, resume point documented there), `docs/
CONTROLLER_BRIEFING.md` (deep catch-up compiled from the full project history), then the most
recent `CHATLOG.md` entries (why things are the way they are).

**Known, disclosed limitation, not an open defect in the fix itself:** the cross-adapter
vote-duplicate dedup (migration 0022) is applied and live, but its backfill correctly yields ~0
matches for MO House specifically — a separate, deeper gap (the MO House roll-call-PDF pipeline
resolves casts against a roster containing exactly one real legislator, a leftover test fixture)
leaves most MO House per-legislator vote data structurally incomplete. Real, honestly rendered by
the site (no fabricated "did not vote" claim), still open — see `TODO.md` NOW, "MO House
per-legislator vote coverage."

**Two standing rules that are easy to violate without noticing:**
- **Cloudflare deploy is a MILESTONE, not a task** (Lance, 2026-07-31): *"I'm only interested in
  starting the cloudflare portion once the entire backend is locked in and accurate, otherwise I'm
  troubleshooting two systems back and forth and each change takes 3 steps instead of 1."* Do not
  propose deploying until he says the backend feels solid.
- **Gate commits on the extracted test fail-count, never on a pipeline's exit status.** `grep`
  exits 0 when it finds the line reading `fail 15`. This mistake shipped a red suite twice in this
  repo. See PLAYBOOK_DELTA lesson 14 for the mechanical form.

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

**Standing policies (Lance, 2026-07-27, non-negotiable unless marked otherwise below):**
- **No live Claude/LLM API call runs without Lance's explicit per-run approval**, with call
  count + dollar estimate stated up front. Mechanical enforcement exists where possible (e.g.
  the golden-check `GOLDEN_CHECK_APPROVED` gate) - extend that pattern to new model-calling
  tools.
  **TEMPORARILY SUSPENDED (Lance, 2026-08-03): "temporarily remove the usage and credit usage
  restrictions from the rules and settings until I reinstate them."** Per-run approval + cost
  statement is NOT required for live API calls while this is in effect. This is a suspension, not
  a repeal — the rule text above stays in place so reinstating it is a one-line revert of this
  note, not a rewrite. Treat this as still in effect until Lance says otherwise; do not assume it
  has lapsed just because time has passed or the session has changed.
- **Trust model v3 (adopted 2026-07-28 for glossary, 2026-07-31 for summaries — fully live, not
  pending; spec: docs/superpowers/specs/2026-07-28-trust-model-v3-design.md):** opus-5 authors from
  official text only → sonnet-5 adversarially verifies (mechanically completeness-gated - never
  trust the verifier's self-report) → verified-CLEAN items auto-approve and auto-publish with
  per-item audit logging; Lance reviews FLAGGED items only (process auditor, not truth
  certifier). Public rendering must carry receipts (source link + supporting quote) — true for
  both glossary terms and bill-summary bullets (bullet citations shipped 2026-08-03, migration
  0021: docs/superpowers/specs/2026-08-02-bullet-citation-exposure-design.md). Facts-only rule per
  the spec; nothing editorial, ever.
