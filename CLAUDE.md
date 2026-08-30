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
> It is at the very top of `TODO.md`, is re-verified against the live database continuously (its
> heading carries the date of the last full re-verification — 2026-08-23 at this writing — but
> trust the dates INSIDE the block over the heading), and is the ONLY place that states what is
> actually open: which lanes are running, what awaits Lance, what is in flight. Everything else in this file — including the dated
> snapshots kept further down — is history that goes stale; do not resume from it. Live numbers:
> `npm run status` (what each number means: `docs/DATA_INVENTORY.md`).
>
> **Two Windows Scheduled Tasks mutate the database while you work (both Ready, 2026-08-23):**
> `VisibleGov Scheduled Ingestion` (every 15 minutes since 2026-07-31; `scripts/scheduled-ingest.js`;
> `docs/SCHEDULED_INGESTION.md`) and `VisibleGov Scheduled Summaries` (daily 06:00;
> `scripts/scheduled-summaries.js`, billed under its $1/tick + $5/ISO-week ledger;
> `docs/SCHEDULED_SUMMARIES.md`). Both docs carry the same rule: **an agent never runs `schtasks`**
> — registering, pausing, and removing the tasks is Lance's step. Expect ingestion run records and
> freshness timestamps to move under you.
>
> **Two traps that will cost you a session if you hit them cold:**
> 1. **Never `source .env` in a shell where you then run `node --test`** — it makes 2 correct
>    tests fail (expected-500-got-200 in `review-logic.test.js`, which assert behavior when no DB
>    client is configured). Verified deterministically, and it fired AGAIN during the 2026-08-05
>    doc sync when a live-`curl` check and a test run got batched into one shell. Run tests in a
>    clean shell; every CLI takes `--env-file=.env` for this reason. (PLAYBOOK_DELTA lesson 30.)
> 2. **THIS PARAGRAPH NO LONGER STATES A MIGRATION COUNT OR AN APPLIED LIST. Run the script.**
>
>    It used to, and it was wrong five separate times — most recently a commit (`08f11ab`, 09:33)
>    saying "0035 is PENDING" that was true when written and false eight minutes later. A count in
>    prose is a claim about the database that nothing checks, and it rots the moment anyone applies
>    anything. Restating it here more carefully has been tried five times and failed five times, so
>    the number is now deliberately absent rather than accurate-for-now.
>
>    ```
>    npm run verify:migrations
>    ```
>
>    It pairs every migration with an artifact it must have created and probes the LIVE database.
>    Exit 0 means every probeable migration is applied; exit 1 names what is missing. An unprobed
>    `.sql` file FAILS the run, so adding a migration forces adding its probe — that is what stops
>    the manifest rotting the way this prose did. Migrations whose artifact is an index, a function
>    body or a grant report `unverifiable` unless `SUPABASE_DB_URL` is set (Tier 2); they are never
>    silently passed, because a checker that reports green on what it cannot see is worse than no
>    checker.
>    **Verify by artifact, never by recollection** — on 2026-08-28 the operator did not recall
>    running 0034; the two indexes were live with the migration's exact definitions.
>
>    **What the script found on its first two runs — BOTH now closed (applied 2026-08-29).**
>    `0036_revoke_internal_tables_from_anon.sql` (three tables their own migrations call internal —
>    `legiscan_datasets`, `vote_reconciliation_flags`, `ingestion_runs` — were returning `200 []` to
>    anon, meaning the GRANT survived and only an absent RLS policy held the door) and
>    `0037_revoke_bill_texts_from_anon.sql` (the same defect on `bill_texts`, which the rls-probe
>    found only AFTER 0036 closed the other three). Both verified live: anon now gets 401 on all
>    four, while every table the site actually reads still returns 200 — `bills`, `public_votes`,
>    `public_vote_feed`, `summaries`, `glossary_terms`, `legislators`. Revoking `bill_texts` is safe
>    precisely because the public surface serves the plain-language SUMMARY and never the raw text;
>    grep confirms no file under `site/` references it.
>    **Do not restate applied-state here. Run the script — that is the whole point of it.**
>
>    `0032`
>    landed 2026-08-23 with the LegiScan 2024 re-ingest: 185 MO House roll calls the source prints
>    with the `0000-00-00` date sentinel are stored under a date derived from the one dated, tallied
>    action in the bill's own history that prints their exact AYES/NOES, each carrying that action
>    in `votes.vote_date_provenance`; the other 90 stay refused. **`0033_retracted_votes.sql`**
>    (tombstone for votes attached to a bill that never held them — preserves the full cast list, so
>    a retraction replays backwards) and **`0034_bill_page_indexes.sql`** (the two indexes every bill
>    page needs; without them both reads were sequential scans) both landed 2026-08-26. Older text
>    stating a migration COUNT is stale by construction — see the top of this trap.
>    **Standing rule, replacing the old "edit the count in the same commit" caveat:** whoever adds
>    a migration adds its PROBE to `scripts/verify-migrations.mjs` in the same commit. The script
>    fails on an unprobed file, so this is enforced rather than remembered — which is the whole
>    difference from the caveat it replaces, which asked five times for care and got drift five
>    times.
>
> **Newer traps, pointers only — `PLAYBOOK_DELTA.md` lessons 43-50 (2026-08-21..23):** verify a
> background runner's liveness by PID, never by command-line grep (43); a spend cap that only gates
> BEFORE each submission cannot stop a single batch — project from the data on disk (44); a sort
> key that is NULL for most rows degrades silently — re-run `node --env-file=.env
> src/cli/sync-session-dates.js` (dry-run, then `--apply`) whenever a session is minted (45);
> anything retyped into a launch call is a transcription — bank it and send a pointer (46);
> `Workflow({name})` can serve a session-cached pre-edit script — launch edited workflows by
> `scriptPath` (47; `.claude/workflows/*.js` must stay LF — `.gitattributes` pins it); a grammar
> verified on two fixtures is a hypothesis about the corpus (48); a roll call with no bill is a
> different kind of record, not a failed parse (49); a documented fallback that was never exercised
> is a hope (50); and a status word that never varies carries zero bits — split "the source says no
> such record" from "we got no answer", and probe one record you already hold as a canary (51,
> 2026-08-26); and identical payloads are not identical identity — a legislature voting the party
> line twice emits byte-identical records, so make the SOURCE prove sameness via its own record
> pointer (52, 2026-08-26); and writing the lesson does not mean obeying it — lesson 52's own rule
> shipped an hour later and hid 17 real votes, because "has a #fragment" was tested but "the
> fragment means something" was not, and a measurement that contradicted the rule (31 of 57 pairs
> disagreed on question) was read and not acted on (53, 2026-08-26); and an upstream provider's
> record id is not an identity — LegiScan minted 232 roll_call_ids for ONE physical House vote,
> so `insertIfAbsent` stored it 232 times against 232 bills with no error at all (54, 2026-08-26);
> and a missing capability is a blocker to RAISE, not a fork to quietly take — an unauthorized MCP
> was routed around with a ~400-line Postgres client and a request to rotate a live credential, to
> reach something one click away (55, 2026-08-26; `scripts/preflight.mjs` + `docs/MCP_REQUIREMENTS.md`).

> **Historical status snapshots — SUPERSEDED 2026-08-23, kept for the record only; resume from
> `TODO.md`'s RESUME HERE, never from here.** **The site is DEPLOYED and
> verified live at https://visiblegov.pages.dev** (2026-08-05); the full product loop — directory →
> profile → real votes → bill → tally — was confirmed working in a real browser with zero console
> errors. **710 plain-language summaries are published (2026-08-10, up from 115 on 2026-08-06)**
> — the 400-bill 2025-session recency manifest campaign is **COMPLETE** (394 attempted, 6
> class-parked with documented structural reasons). What remains: the custom-domain phases
> (nameservers + attach ~~`visiblegov.helpingpeoplehelpingpeople.com`~~ — superseded 2026-08-22:
> the apex `visiblegov.us`, which Lance owns, with `www` as a redirect/alias (wiring still his call); his console
> work — see `docs/CLOUDFLARE_DEPLOY.md`), ~~the 359-draft drain lane~~ (drained: COMPLETE
> 2026-08-18/19, and the $0 lane ran to empty again 2026-08-22), the next recency-first export (~2,500
> eligible bills with text — still ~2,500 ready on 2026-08-23; the daily scheduler now works that
> queue recency-first), and ~~the parked autonomy build~~ (built 2026-08-15
> as `scripts/scheduled-summaries.js`, registered as the daily task). **Lane state (2026-08-10 evening):
> NO summary lane is running — the campaign finished; the BILLED path stays CLOSED — the API
> balance is spent ($1.98, 2026-08-09) and Lance's standing instruction is "Once depleted, pause
> waves as I do not auto reload credits" — no billed call without new funds AND his explicit
> go.** *(superseded 2026-08-21: Lance loaded $7; the scheduler bills under its ledger, everything
> else still needs per-run approval — see the policy bullets under Working conventions.)*
> **Update 2026-08-19:** the drain is COMPLETE (live 1,037; the registered daily 6 AM scheduler
> owns all future summaries under its $1/tick + $5/wk ledger carve-out), and the **Missouri
> statute glossary is LIVE** (2026-08-21: 1,217 RSMo glosses published for $12.45 via the
> Batch-API runner — `scripts/gloss-batch-mo.mjs --source mo|usc`, checkpoints under
> `.superpowers/artifacts/gloss-batch-<source>/`, resumed with `--resume`, stopped by the PID the
> launcher wrote to `runner.pid` there (the script itself has no PID handling — lesson 43);
> glossary 116 → 1,333;
> PLAYBOOK lessons 41-43 record what the audit and the
> run taught — incl. lesson 43: stop background runners by PID, never by command-line grep).
> **Update 2026-08-21 (evening):** the **federal (U.S.C.) glossary drain is LIVE too** — 525
> glosses published (glossary published 1,858; 649 of 1,045 summaries show a gloss) — but the run
> spent **$8.31 against an $8 cap and a $5.62 balance** (USC excerpts are 2.5x MO's; the cap only
> gated before each submission). **The balance hit $0 ("out of api credits"); Lance then loaded
> $7 more the same evening — the scheduler resumes under its ledger carve-out; every other billed
> call still needs explicit per-run approval with a cost stated.** The runner now
> projects each batch from the banked text before submitting (lesson 44). 419 flagged glosses
> await Lance's review. *(Everything after this date lives in `TODO.md`'s RESUME HERE — the $0
> drain lane running to empty 2026-08-22, the session-date fix, the MO Senate journal fix and
> replay, the 2024 MO House dating behind migration 0032 — and is deliberately NOT mirrored here.)*

**Status (2026-08-04): backend live and accurate — two independent audits ran end-to-end 2026-08-03
(an 8-domain accuracy audit, then a senior-engineering-lens audit), 4 + 19 findings fixed and
verified live respectively; public site built, merged, and independently verified in a real browser
against live data; a 3-layer `refresh_vote_aggregates()` timeout saga (a Supabase edge-gateway
timeout, then a Postgres `statement_timeout` arm-timing trap, then a query-planner anti-join
misestimation) was root-caused and fixed live 2026-08-04 — manual refresh now completes in ~19s and
real scheduled `pg_cron` ticks are succeeding; the site is now DEPLOYED and verified live at
https://visiblegov.pages.dev (2026-08-05); **the custom domain `visiblegov.us` went LIVE
2026-08-24** (apex 200, `www` 301 to apex — re-verified 2026-08-26) and is the primary address —
see `TODO.md` RESUME HERE.** The repo holds the ingestion CLIs and adapters (`src/`),
the public site (`site/`), schema migrations (`supabase/migrations/`, **count and applied-state deliberately
not stated here — run `npm run verify:migrations`, which reads the live database** — `0032_vote_date_provenance.sql` was
applied 2026-08-23; `0033_retracted_votes.sql` (the retraction tombstone) and
`0034_bill_page_indexes.sql` (the two indexes every bill page needs) both on 2026-08-26, both
re-verified live by their artifacts 2026-08-28; `0035_expose_vote_date_provenance.sql` (the
derived-date receipt on the two public views) applied by Lance 2026-08-28 and verified live the
same morning — see trap 2 above; 0030 revoked a stray `authenticated` EXECUTE grant, 0031 fixed a live
anon vote-list timeout found on deploy night, both verified live 2026-08-05; 0025's column-scoping had one real fallout, a `site/js/bill-page.js` query
missing an explicit `select=`, fixed same pass — see TODO.md), and fixture-backed tests (`tests/`,
2,200+ green — run `node --test` for the exact current count; a senior engineering audit,
2026-08-03, flagged exact test-count citations in docs as needless churn — prefer magnitude language
like this one). **Live numbers: run `npm run status`** — any count typed into a doc goes stale
within the hour.

**If you are a fresh session, read these first, in order** (but the RESUME HERE block at the top of
`TODO.md` outranks all of them — it is the only live-verified one): `PLAYBOOK_DELTA.md` (reusable traps —
lessons 1-13 are list items under §7 and only 14+ are `## Lesson N`
H2s, so `grep -c '^## Lesson'` UNDERCOUNTS; the "Index of lessons" table at the top of the
file is the live count, and no number is repeated here because one typed into prose rots — several
earned the hard way in THIS repo; lessons 37-38 were the newest as of 2026-08-10 — diagnose a
silently-dead background task from its on-disk artifacts and resume from journaled state, and park
a failing structural CLASS with written reasons rather than paying per-instance retries — and
lessons 51-55 (2026-08-26) are the newest now, summarized in the banner above), `TODO.md` (the RESUME HERE block at the very top first — the NOW
section below it is a long historical record where most entries are already resolved, so do NOT
read the top NOW entry as "the current focus"),
`docs/CONTROLLER_BRIEFING.md` (deep catch-up compiled from the full project history — carries its
own staleness banner — trust the date printed in that banner, not one quoted here — and defer to
`TODO.md`/live checks for migration-applied state),
then the most recent `CHATLOG.md` entries (why things are the way they are). The operating docs
that now carry standing truth, read when the work touches them: `docs/DATA_INVENTORY.md` (what
every `npm run status` number means, and the known coverage gaps), `docs/SCHEDULED_INGESTION.md`
and `docs/SCHEDULED_SUMMARIES.md` (the two registered Windows tasks — pausing, resuming, the
ledger), `docs/RUNBOOK_SUMMARY_WAVES.md` (the $0 subagent summary lane; drain waves come from
`node --env-file=.env scripts/build-drain-wave.mjs <WAVE> 6 --pointer` and are launched by
`scriptPath`), and `docs/DISASTER_RECOVERY.md` (full rebuild from a bare clone when the Supabase
project or the machine is gone). Last, `F:\RapidForge\docs\PROJECT_STANDARD.md` - the
machine-wide standard this project declares against; what VisibleGov does differently, and why, is
the "Deviations from the standard" section at the end of THIS file.

**Known, disclosed, RESOLVED limitation (2026-08-05) — narrower than earlier framing suggested, not
an open defect in the fix itself:** the cross-adapter vote-duplicate dedup (migration 0022) is
applied and live; its backfill was itself found and fixed 2026-08-03 (a bare `.select()` had
silently truncated the scan to 12% of its target — see
`docs/audits/2026-08-03-senior-engineering-audit.md` finding 1) and now correctly carries real
matched pairs — 59 from the backfill, all 2018 MO Senate, plus a handful marked since by live ingest
(62 when this was written 2026-08-05; 66 as of 2026-08-23 — the table is the truth). The `mo-house-xml` roll-call-PDF adapter resolves casts against
a roster containing exactly one real legislator, a leftover test fixture — investigated end-to-end
2026-08-05: the dominant `legiscan` pipeline already covers 96.9% of all MO House votes with 0%
zero-cast (the 2026-08-05 measurement; ~92% as of 2026-08-23 because `mo-house-xml` rows have grown
since — the one-legislator roster finding is unchanged), and every bill `mo-house-xml` currently resolves any real cast for already has a
LegiScan vote for the same bill (100% overlap, live-verified) — so a roster-ingest-loop fix was
deliberately deprioritized as low-value (plus a separate, still-open `mo_house_id`
cross-era-collision risk, TODO 31, any such fix would need to navigate). Also (verified in Lance's
browser 2026-08-23): the House XML export serves only the current General Assembly, so earlier
sessions cannot be backfilled from it — the undated 2024 House roll calls are instead dated from
LegiScan's own printed history, stored 2026-08-23 with a receipt per vote (migration 0032,
trap 2 above). **Prior "most MO House
per-legislator vote data structurally incomplete" framing was itself wrong and is corrected here:**
live-verified directly that all 159 CURRENT MO House legislators have at least one real MO House
vote on their profile page via LegiScan's own coverage — the gap was specifically "zero votes *from
`mo-house-xml` specifically*," not "zero votes on the page," and reading it as the latter was a real
misstatement. **Site-content decision: ship as-is, no caveat needed** — resolved, not open;
verified there's no meaningful gap for a caveat to warn about. See `TODO.md` NOW, "MO House
per-legislator vote coverage," for the full evidence trail.

**Four standing rules that are easy to violate without noticing:**
- **A REQUIRED MCP CONNECTION THAT IS NOT AUTHORIZED IS A BLOCKER TO RAISE, NEVER A FORK IN THE
  ROAD TO QUIETLY TAKE.** At session start `scripts/preflight.mjs` runs (SessionStart hook in
  `.claude/settings.json`) and prints which MCP servers this project depends on. It cannot check
  OAuth state — that is per-session runtime — so **you** must: if a system notice says a server
  needs authentication, or an MCP call fails as unauthorized, **stop and tell Lance, and help him
  authorize it before doing the work another way.** Do not silently build or use an alternative
  route to the same capability.
  *Why this rule exists (2026-08-26):* a session opened with a notice that
  `plugin:supabase:supabase` needed authentication. It was not surfaced. The session instead added
  a `pg` dependency, wrote a ~400-line direct Postgres client plus tests and a verify script, and
  asked Lance to rotate his database password — to reach a capability that was one `/mcp` click
  away. Once authorized, the MCP immediately found two real defects nothing else could reach (an
  unindexed `votes.bill_id` behind every bill-page query, and the security advisor set) and turned
  a 20-row retraction into one atomic guarded transaction instead of 20 separate writes. The
  detour cost hours and nearly cost a credential rotation. `docs/MCP_REQUIREMENTS.md` lists what is
  required and why; PLAYBOOK lesson 55 has the general form.
- ~~**Cloudflare deploy is a MILESTONE, not a task**~~ **— DONE 2026-08-05: the site is deployed to
  https://visiblegov.pages.dev and verified live end-to-end.** Lance's original ruling (2026-07-31,
  *"I'm only interested in starting the cloudflare portion once the entire backend is locked in and
  accurate"*) was satisfied — he raised the deploy himself after four audit passes produced zero
  criticals. Only the custom-domain phases remain (his console work; `docs/CLOUDFLARE_DEPLOY.md`;
  target decided 2026-08-22: the apex `visiblegov.us`, superseding the earlier
  `helpingpeoplehelpingpeople.com` subdomain plan).
  Two real bugs were found and fixed DURING the deploy's own verification (the browser walk earned
  its cost): `_redirects` targets had to become extensionless (Pages 308-canonicalizes `.html`),
  and migration 0031 fixed a live anon `statement_timeout` on profile vote lists — see
  `CHATLOG.md` 2026-08-05 deploy-night entries.
- **Gate commits on the extracted test fail-count, never on a pipeline's exit status.** `grep`
  exits 0 when it finds the line reading `fail 15`. This mistake shipped a red suite twice in this
  repo. See PLAYBOOK_DELTA lesson 14 for the mechanical form.
- **Never `source .env` in a shell you then run `node --test` in.** It exports the Supabase
  credentials into the test process, so `review-logic.test.js`'s "no DB client configured" tests
  get a real client and 2 CORRECT tests go red (expected 500, got 200). Verified deterministically
  2026-08-05. Run tests in a clean shell; batching a live `curl` check and a test run into one
  shell invocation is how this happens. See PLAYBOOK_DELTA lesson 30.

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
  note, not a rewrite. ~~Treat this as still in effect until Lance says otherwise; do not assume it
  has lapsed just because time has passed or the session has changed.~~ **ENDED in practice
  (marked 2026-08-23): depletion on 2026-08-09 overtook the suspension, and Lance's 2026-08-21
  reload ("I loaded $7 more") was a balance update, not a go — so the original rule above
  (per-run approval with a cost stated) governs every billed call except the scheduler's ledger
  carve-out in the next bullet. No new ruling from Lance re-suspended it; if he does, that is a
  new dated note here.**
  **SUPERSEDED IN PRACTICE by depletion (2026-08-09): the API balance is SPENT.** Lance's final
  authorization ("I have a $1 or $2 left... use the dollars... Once depleted, pause waves as I do
  not auto reload credits") was executed the same day — $1.98 across three budget-capped
  `scripts/summary-probe-api.mjs` runs, zero credit errors, then full stop. **All summary lanes
  (billed AND subagent) are paused; any new billed call now requires Lance to add funds AND give
  an explicit go.** See the memory file `no-api-spend-hold.md` and CHATLOG 2026-08-09.
  *(Superseded 2026-08-21/22: Lance loaded $7 on 2026-08-21 evening; the billed scheduler ticks
  daily under its $1/tick + $5/ISO-week ledger — the next bullet; the $0 subagent drain lane ran
  to empty on 2026-08-22 and resumes only when `node --env-file=.env
  scripts/build-drain-wave.mjs <WAVE> 6 --pointer` reports candidates; every OTHER billed call
  still needs funds on the balance AND Lance's explicit go with a cost stated — never assume a
  further reload.)*
- **Scheduled summaries — `scripts/scheduled-summaries.js` exception:** `scripts/scheduled-summaries.js`
  runs billed calls unattended under a code-enforced $5.00/ISO-week cap plus a $1.00/tick cap (Lance,
  2026-08-10; built 2026-08-15; registered as the Windows task `VisibleGov Scheduled Summaries`,
  daily 06:00, trigger dated 2026-08-17 — `docs/SCHEDULED_SUMMARIES.md`); this ledger+cap IS the
  per-run approval for this runner only. Every other billed
  call still requires explicit per-run approval.
- **Trust model v3 (adopted 2026-07-28 for glossary, 2026-07-31 for summaries — fully live, not
  pending; spec: docs/superpowers/specs/2026-07-28-trust-model-v3-design.md):** opus-5 authors from
  official text only → sonnet-5 adversarially verifies (mechanically completeness-gated - never
  trust the verifier's self-report) → verified-CLEAN items auto-approve and auto-publish with
  per-item audit logging; Lance reviews FLAGGED items only (process auditor, not truth
  certifier). Public rendering must carry receipts (source link + supporting quote) — true for
  both glossary terms and bill-summary bullets (bullet citations shipped 2026-08-03, migration
  0021: docs/superpowers/specs/2026-08-02-bullet-citation-exposure-design.md). Facts-only rule per
  the spec; nothing editorial, ever.

## Deviations from the standard

This project follows `F:\RapidForge\docs\PROJECT_STANDARD.md`, which lives there once and is never
copied here (its rule 11: pointers, never copies). What follows is only where VisibleGov departs
from it, and why. A deviation declared with its reason is compliance; an undeclared one is drift.
Verified against the standard and against this repo on 2026-08-30 at 14:13 CDT.

**1. Instruments live in `scripts/` and are Node, not `tools/*.py`.** The standard asks for a claim
checker at `tools/verify_claims.py`. Here the equivalents are `npm run verify:migrations`
(`scripts/verify-migrations.mjs`), `npm run check:ingest` and `npm run status`. The whole project is
Node with a `node --test` suite, so a Python instrument would be the only Python on the path and
could not share the adapters it needs to check. The standard's own section 1 already cites
`scripts/verify-migrations.mjs` as an instrument exemplar.

**2. `docs/DISASTER_RECOVERY.md` stands in for `REBUILD.md`.** The standard names these as synonyms
and says pick one. This one is picked, and it is a full rebuild-from-bare-clone procedure.

**3. `PLAYBOOK_DELTA.md` lessons 1 to 13 are list items under section 7; only 14 and up are
`## Lesson N` H2 headings.** Permitted explicitly by the standard's conflict table. The consequence
worth knowing: `grep -c '^## Lesson'` UNDERCOUNTS. The index table at the top of that file is the
live count, and adding a lesson means adding its index row in the same commit.

**4. Commit trailer, declared as the standard requires:**
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

**5. `verify:migrations` is deliberately excluded from push CI.** It is red by design under
draft-then-apply: it probes the LIVE database and reports MISSING for any migration Lance has not
yet applied, which is a correct report rather than a build failure. It runs by hand, and the
exclusion is documented in the workflow itself. The standard names this exclusion as its model.

**6. The test workflow deliberately carries NO Supabase secrets.** Supplying them makes two CORRECT
tests fail, because those tests assert behaviour when no database client is configured. This is the
mechanical form of the standing rule against `source .env` in a shell that then runs `node --test`.

### Owed under the standard, not yet built

**`AUDIT_LOG.md` does not exist here.** Three dated audit reports live under `docs/audits/`
(2026-08-03 accuracy, 2026-08-03 senior engineering, 2026-08-26 system) with their findings fixed
and verified live, but there is no append-only log carrying a per-finding verdict from Open /
Mitigated / Fixed / Accepted Risk / Obsolete. Per the standard's adoption rule this is added when
the project is next touched rather than in a sweep. Recorded here so it is a known gap rather than
an oversight.
