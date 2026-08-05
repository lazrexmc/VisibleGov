# VisibleGov

**Read `PLAYBOOK_DELTA.md` first.** It's the distilled, reusable lessons from Lance's other
projects (an ML/quant ingestion platform, a TCG deck-builder, a feature-film pipeline, a small-
business ops platform, a two-sided marketplace) - read before touching anything else.

## What this is

A civic-transparency platform, Lance's own idea (2026-07-27): break down bills and laws
politicians propose into plain language so anyone can quickly understand what a bill actually does
and why, and surface how legislators voted on it - so people can hold their own representatives
accountable with real information instead of spin.

> ## ⏱ FRESH SESSION: READ `TODO.md`'s "RESUME HERE" BLOCK FIRST
> It is at the very top of `TODO.md`, was verified against the live database on 2026-08-05, and is
> the ONLY place that states what is actually open. Everything else — including the status
> paragraph directly below — is a historical snapshot that goes stale. **The next thing to do is
> the Cloudflare Pages deploy**; Lance's "backend first" gate is MET (he raised the deploy himself
> 2026-08-05, after four audit passes produced zero criticals). Do not defer it or re-litigate it.
>
> **Two traps that will cost you a session if you hit them cold:**
> 1. **Never `source .env` in a shell where you then run `node --test`** — it makes 2 correct
>    tests fail (expected-500-got-200 in `review-logic.test.js`, which assert behavior when no DB
>    client is configured). Verified deterministically. Run tests in a clean shell; every CLI takes
>    `--env-file=.env` for this reason.
> 2. **All 30 migrations (0001-0029 + 0018a) are APPLIED.** Nothing awaits an apply. Older text
>    anywhere in this repo saying a migration is "drafted, awaiting Lance" is stale.

**Status (2026-08-04): backend live and accurate — two independent audits ran end-to-end 2026-08-03
(an 8-domain accuracy audit, then a senior-engineering-lens audit), 4 + 19 findings fixed and
verified live respectively; public site built, merged, and independently verified in a real browser
against live data; a 3-layer `refresh_vote_aggregates()` timeout saga (a Supabase edge-gateway
timeout, then a Postgres `statement_timeout` arm-timing trap, then a query-planner anti-join
misestimation) was root-caused and fixed live 2026-08-04 — manual refresh now completes in ~19s and
real scheduled `pg_cron` ticks are succeeding; the Cloudflare Pages deploy is now actively being
spec'd (in progress — see `TODO.md` NOW).** The repo holds the ingestion CLIs and adapters (`src/`),
the public site (`site/`), schema migrations (`supabase/migrations/`, 0001-0029 all applied — 30
files total including 0018a; the newest three, 0027/0028/0029, are the timeout-saga fix above, all
verified live 2026-08-04; 0025's column-scoping had one real fallout, a `site/js/bill-page.js` query
missing an explicit `select=`, fixed same pass — see TODO.md), and fixture-backed tests (`tests/`,
2,200+ green — run `node --test` for the exact current count; a senior engineering audit,
2026-08-03, flagged exact test-count citations in docs as needless churn — prefer magnitude language
like this one). **Live numbers: run `npm run status`** — any count typed into a doc goes stale
within the hour.

**If you are a fresh session, read these first, in order** (but the RESUME HERE block at the top of
`TODO.md` outranks all of them — it is the only live-verified one): `PLAYBOOK_DELTA.md` (reusable traps —
27 lessons as of 2026-08-05, several earned the hard way in THIS repo; lessons 26/27 are the two
most recent and most expensive), `TODO.md` (the RESUME HERE block at the very top first — the NOW
section below it is a long historical record where most entries are already resolved, so do NOT
read the top NOW entry as "the current focus"),
`docs/CONTROLLER_BRIEFING.md` (deep catch-up compiled from the full project history — carries its
own staleness banner as of 2026-08-03, defer to `TODO.md`/live checks for migration-applied state),
then the most recent `CHATLOG.md` entries (why things are the way they are).

**Known, disclosed, RESOLVED limitation (2026-08-05) — narrower than earlier framing suggested, not
an open defect in the fix itself:** the cross-adapter vote-duplicate dedup (migration 0022) is
applied and live; its backfill was itself found and fixed 2026-08-03 (a bare `.select()` had
silently truncated the scan to 12% of its target — see
`docs/audits/2026-08-03-senior-engineering-audit.md` finding 1) and now correctly carries 59 real
matched pairs, all 2018 MO Senate. The `mo-house-xml` roll-call-PDF adapter resolves casts against
a roster containing exactly one real legislator, a leftover test fixture — investigated end-to-end
2026-08-05: the dominant `legiscan` pipeline already covers 96.9% of all MO House votes with 0%
zero-cast, and every bill `mo-house-xml` currently resolves any real cast for already has a
LegiScan vote for the same bill (100% overlap, live-verified) — so a roster-ingest-loop fix was
deliberately deprioritized as low-value (plus a separate, still-open `mo_house_id`
cross-era-collision risk, TODO 31, any such fix would need to navigate). **Prior "most MO House
per-legislator vote data structurally incomplete" framing was itself wrong and is corrected here:**
live-verified directly that all 159 CURRENT MO House legislators have at least one real MO House
vote on their profile page via LegiScan's own coverage — the gap was specifically "zero votes *from
`mo-house-xml` specifically*," not "zero votes on the page," and reading it as the latter was a real
misstatement. **Site-content decision: ship as-is, no caveat needed** — resolved, not open;
verified there's no meaningful gap for a caveat to warn about. See `TODO.md` NOW, "MO House
per-legislator vote coverage," for the full evidence trail.

**Three standing rules that are easy to violate without noticing:**
- ~~**Cloudflare deploy is a MILESTONE, not a task**~~ **— GATE MET 2026-08-05, this rule is now
  SATISFIED, not waived.** Lance's original ruling (2026-07-31) was: *"I'm only interested in
  starting the cloudflare portion once the entire backend is locked in and accurate, otherwise I'm
  troubleshooting two systems back and forth and each change takes 3 steps instead of 1."* He
  raised the deploy himself on 2026-08-05 after four audit passes produced zero criticals, and it
  was recommended yes. **The deploy is now the active next task** — see `TODO.md`'s RESUME HERE
  block. Do not use the old wording to defer it. (If he ever says the backend feels shaky again,
  believe him over this note — the instinct behind the rule is still sound.)
- **Gate commits on the extracted test fail-count, never on a pipeline's exit status.** `grep`
  exits 0 when it finds the line reading `fail 15`. This mistake shipped a red suite twice in this
  repo. See PLAYBOOK_DELTA lesson 14 for the mechanical form.
- **Never `source .env` in a shell you then run `node --test` in.** It exports the Supabase
  credentials into the test process, so `review-logic.test.js`'s "no DB client configured" tests
  get a real client and 2 CORRECT tests go red (expected 500, got 200). Verified deterministically
  2026-08-05. Run tests in a clean shell; batching a live `curl` check and a test run into one
  shell invocation is how this happens. See PLAYBOOK_DELTA lesson 27.

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
