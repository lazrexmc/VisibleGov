# VisibleGov — Disaster Recovery / Full Rebuild Runbook

**Audience:** a fresh Claude session or a fresh human developer with NO prior context on this
project, starting from nothing but this file plus a `git clone` of the repository. Follow the
numbered steps in order. Every command is exact and literal — copy/paste, don't paraphrase.

**When to use this doc:** the Supabase project is gone, the local machine is gone, or you are
setting up VisibleGov from scratch on a new machine and need it back to a working state — code,
schema, infrastructure, and live data re-ingested from the original public sources.

---

## 1. Scope — what this rebuild does and does NOT do

**This guide rebuilds:**
- The **code** (this git repository — CLIs, adapters, site, tests).
- The **schema** (every Supabase/Postgres migration in `supabase/migrations/`, applied in order to
  a brand-new Supabase project).
- The **infrastructure** (the two Windows Task Scheduler jobs — the 15-minute ingestion tick and,
  since 2026-08-17, the daily 6 AM billed-summary runner — and the `pg_cron` job inside Postgres
  that keeps vote-aggregate charts fresh; all three are in Section 9).
- The **live data**, by **re-ingesting it fresh from the original government/API sources**
  (Congress.gov, senate.gov LIS, house.mo.gov XML/PDF, senate.mo.gov journals, LegiScan, the
  statute text the glossary quotes — revisor.mo.gov and uscode.house.gov, fetched politely by
  `src/adapters/mo-statutes.js` / `src/adapters/uscode.js` under the glossary runner in Section
  6.8 — and optionally Anthropic's API for plain-language summaries/glossary).

**This guide does NOT do:**
- **Restore a point-in-time database backup.** This project has no backup/snapshot mechanism of
  its own — no `pg_dump` archive, no Supabase backup restore procedure documented or relied upon
  anywhere in this repo. There is nothing to restore from; the recovery path IS re-ingestion.
- **Reproduce the exact prior database state bit-for-bit.** Re-ingested data will be **current as
  of the rebuild's run time**, not identical to whatever snapshot existed when the original
  instance was lost. Source APIs' current contents (bill statuses, vote tallies for votes that
  have since been amended/corrected upstream, roster composition) may differ from what was true on
  the day the original instance stopped. Some artifacts are also genuinely session-bound and
  cannot be mechanically re-derived at all: the exact set of Lance's own manual review-queue
  decisions (glossary/summary approvals, identity-flag adjudications) made through
  `npm run review`, and any one-off, hand-adjudicated calls recorded only in `CHATLOG.md`/`TODO.md`
  prose. (The SB 914 vote-reconciliation-flag adjudication that used to be the example here was
  itself adjudicated 2026-08-05 — "trust senate journals" — and IS now replayable via
  `correct-data.js sb914-reconcile`; but the general point stands for any FUTURE flag ruling that
  hasn't yet been mechanized, and for the human review-queue decisions above.)
- **Guarantee exact parity even with the corrections re-applied.** Section 7 below lists the known
  historical data corrections (`correct-data.js`) that can be re-run against the freshly re-ingested
  data to bring it closer to the state the original instance was in. This closes real, known gaps
  (bad status codes, sentinel dates, mis-attributed chambers, known duplicate-session merges, wrong
  legislator-identity merges, corrupted glossary text) but is a **best-effort parity step, not a
  guarantee of an identical result** — new data has accumulated since these corrections were last
  applied, and the corrections themselves only cover defects that were actually found and fixed
  historically, not any defect that might exist in data ingested for the first time during this
  rebuild.

If exact historical parity is a hard requirement, stop and reconsider: this repo's design
deliberately treats the live government sources as the source of truth and everything else as a
re-derivable layer (see `PLAYBOOK_DELTA.md` §0, the IBTP "canon" lineage) — there was never a
promise of point-in-time snapshotting, and building one is out of scope for this document.

---

## 2. Prerequisites

Create these accounts and gather these credentials **before** starting. All of the below are free
tiers unless noted.

1. **A Supabase account and a new Supabase project.** Sign up at
   [supabase.com](https://supabase.com) if you don't have an account, then create a **new**
   project (do not reuse/assume an existing one still exists — this rebuild targets a fresh
   project). Note the project's **Project URL** and its **service_role key** and **anon
   (publishable) key** (Project Settings → API) — you will need all three later.
2. **A free LegiScan API key.** Register at LegiScan's developer/API signup page. LegiScan is the
   **primary** source for Missouri bulk bill/vote data in this project. Note: LegiScan's terms are
   non-commercial, CC BY 4.0 attribution required on every public surface showing LegiScan-derived
   data — see `docs/research/2026-07-28-legiscan-terms.md` in this repo for the binding operating
   terms once you've cloned it.
3. **A free congress.gov API key.** Sign up at `api.congress.gov/sign-up`. Used by the federal
   (`us-congress`) adapter for bill/member detail.
4. **A free OpenStates API key.** Sign up at `open.pluralpolicy.com`. Used by the legacy
   `mo-legislature` (OpenStates) adapter — LegiScan has since become the primary MO path, but this
   key is still read from the environment and the adapter still exists.
5. **An Anthropic API key** — only if you intend to run the summarization/glossary pipeline
   (plain-language bill summaries, glossary term authoring). Skip this if you only want the
   ingestion/vote-data half working; the site and vote data function without it. Get one at
   [console.anthropic.com](https://console.anthropic.com). **Read `CLAUDE.md`'s "Standing
   policies" section in the freshly-cloned repo before spending anything against this key** — this
   project has a per-run spend-approval policy that may or may not be suspended at the time you're
   reading this; the repo's own `CLAUDE.md` is the current source of truth, not this paragraph.
6. **Node.js 22 or newer.** `package.json`'s `engines` field pins `"node": ">=22"`. Install the
   current Node 22+ LTS from [nodejs.org](https://nodejs.org) if you don't have it. Verify with
   `node --version` before continuing.
7. **git.** Any recent version; used only for `clone`.

---

## 3. Clone and install

```bash
git clone <YOUR_REPO_URL> VisibleGov
cd VisibleGov
npm install
```

This installs the runtime dependencies (`@anthropic-ai/sdk`, `@supabase/supabase-js`,
`fast-xml-parser`, `pdfjs-dist`, `yaml`, `yauzl` — the six in `package.json`; `yaml` serves
`backfill-mo-term-dates.js`'s overrides file) and the one dev dependency (`jsdom`, used only by
the test suite). There is no build step — the site (`site/`) is plain HTML/CSS/vanilla JS served
as-is.

---

## 4. Environment configuration

Copy the example env file and fill it in:

```bash
cp .env.example .env
```

Open `.env` and fill in each key. The real `.env.example` in this repo, as of this writing,
contains:

```
CONGRESS_API_KEY=get-free-at-api.congress.gov/sign-up
OPENSTATES_API_KEY=get-free-at-open.pluralpolicy.com
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=
# LegiScan API (registered 2026-07-28; non-commercial, CC BY 4.0 attribution required on
# every public surface showing LegiScan-derived data; binding operating terms in
# docs/research/2026-07-28-legiscan-terms.md)
LEGISCAN_API_KEY=your-legiscan-api-key
# Anthropic API (optional — only needed for the summarization/glossary pipeline; ingestion and
# vote data work without it. See CLAUDE.md "Standing policies" before spending against this key.)
ANTHROPIC_API_KEY=get-a-key-at-console.anthropic.com
```

Fill each in as follows (never paste a real secret into this doc or any doc — the placeholders
below are exactly what should sit in `.env`, with `<...>` replaced by your own real value only
inside your local, gitignored `.env` file):

| Key | Where to get it | Notes |
|---|---|---|
| `CONGRESS_API_KEY` | `api.congress.gov/sign-up` (prerequisite 3) | `<YOUR_CONGRESS_API_KEY>` |
| `OPENSTATES_API_KEY` | `open.pluralpolicy.com` (prerequisite 4) | `<YOUR_OPENSTATES_API_KEY>` |
| `SUPABASE_URL` | Your new Supabase project's Settings → API → Project URL (prerequisite 1) | `<YOUR_SUPABASE_URL>`, e.g. `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page, "service_role" secret key | `<YOUR_SUPABASE_SERVICE_ROLE_KEY>` — this bypasses RLS; every ingestion/write CLI in this repo uses it; never expose it publicly (it must never appear in `site/`) |
| `LEGISCAN_API_KEY` | LegiScan's own developer signup (prerequisite 2) | `<YOUR_LEGISCAN_API_KEY>` |

`ANTHROPIC_API_KEY` (listed in `.env.example` as of 2026-08-05) is only needed if you plan to run
the summarization/glossary pipeline — `summarize.js`, `verify.js`, `extract-terms.js`, `gloss.js`,
`golden.js` all check for it and print `{"mode":"blocked","reason":"ANTHROPIC_API_KEY not set"}` and
exit cleanly if it's missing (they do not crash, but they also do nothing). The CURRENT billed
runners (Section 6.8) need it too: `scripts/scheduled-summaries.js` logs `ANTHROPIC_API_KEY not
set — exiting without a tick` and exits 0 with no spend; `scripts/gloss-batch-mo.mjs` needs it for
every batch it submits. A key alone is not enough — the account must also carry funds; the
scheduler logs `BALANCE DEPLETED — reload required` and closes its tick `partial` when it does
not. The ingestion and vote-data half of the project works without it.

Every script that touches the network or the database in this repo is invoked as
`node --env-file=.env <path>` — `package.json`'s `scripts` block already wires this in for every
command that has an `npm run` shortcut.

---

## 5. Provision the database

Every schema change in this project lives in `supabase/migrations/*.sql` and is
**draft-then-apply**: there is no CLI/local Supabase setup and no automated apply step anywhere in
this repo. You paste each file's contents into your new Supabase project's **SQL Editor** and run
it, **in order**, one at a time, confirming each succeeds before moving to the next.

Apply **every file in `supabase/migrations/`, in filename order.** The table below is a snapshot
(as of 2026-08-23: 33 files on disk — the 32 below are applied to the original instance, and
`0032` is drafted, awaiting Lance's apply); if the directory holds a file this table does not
list, the directory wins — apply it in its filename position and update this table.

| # | File | What it does |
|---|---|---|
| 1 | `0001_core_schema.sql` | Core schema — jurisdictions, sessions, legislators, terms, bills, votes, vote_casts, summaries, ingestion_runs. RLS enabled from the start: anon reads public rows only, the service role writes and bypasses RLS. |
| 2 | `0002_seed_jurisdictions.sql` | Seeds the two jurisdiction rows (US Congress, MO Legislature) that every other table hangs off of. |
| 3 | `0003_summary_notes_freshness.sql` | Makes `editor_notes` staff-only (never publicly readable, per the facts-only directive) and moves `ingestion_runs.detail` off the anon surface; adds an `'approved'` summary status. |
| 4 | `0004_summary_verifications.sql` | Adds the adversarial-verification table (trust model v2): a sonnet-5 pass that tries to refute each bullet of an opus-5-authored summary. |
| 5 | `0005_mo_house_id.sql` | Adds `legislators.mo_house_id` so the MO House roster adapter (`mo-house-xml`) has an identity key to persist against. |
| 6 | `0006_legislators_surname.sql` | Adds a dedicated `surname` column so MO House roll-call PDF parsing can match real printed surnames instead of guessing from `full_name`. |
| 7 | `0007_glossary.sql` | Adds the referenced-context glossary schema (`glossary_terms`, related tables) — one gloss per statute/act/agency/program a bill references. |
| 8 | `0008_mo_senate_id.sql` | Adds `legislators.mo_senate_id`, the MO Senate roster adapter's identity key. |
| 9 | `0009_mo_senate_id_nonunique.sql` | Fixes a real bug in migration 8: makes `mo_senate_id` non-unique table-wide, because a district number is per-era seat metadata (gets reused by a new person each election), not a stable person identity. |
| 10 | `0010_legiscan_identity_and_ledger.sql` | Adds LegiScan's own permanent per-person key (`legiscan_people_id`, safely table-wide unique, unlike a seat number) plus the operational ledger tables the LegiScan bulk adapter needs. |
| 11 | `0011_flag_idempotency.sql` | Adds an idempotency key to `vote_reconciliation_flags` so a persistent discrepancy doesn't insert a fresh duplicate row on every re-run, and so a human-resolved flag can't silently reappear as unresolved. |
| 12 | `0012_identity_merge.sql` | Adds the identity-merge schema (`persons`, `person_links`, `identity_flags`) — a VIRTUAL merge model: source legislator rows are never deleted or rewritten, a `person` row groups them at read time. |
| 13 | `0013_nickname.sql` | Identity-merge amendment: accounts for LegiScan's own printed nickname field so a full-name-variant match (e.g. "Bob" vs. "Robert") doesn't wrongly split one real person into two. |
| 14 | `0014_bill_sponsors.sql` | Adds `bill_sponsors` (one row per bill/legislator sponsorship pair), distinguishing introducing sponsor from cosponsor. |
| 15 | `0015_sponsor_types.sql` | Widens `bill_sponsors.sponsor_type` to LegiScan's actual printed sponsor-type vocabulary (adds Joint Sponsor and an unspecified/generic type beyond primary/cosponsor). |
| 16 | `0016_public_read_surface.sql` | Defines the public read surface for the site: locks down two tables, adds one column, adds four public-facing views (`public_vote_feed`, `public_freshness`, `public_verification_notes`, `public_reconciliation_flags`) that expose only named columns to `anon`. (`public_votes` does not exist until 0022.) |
| 17 | `0017_vote_casts_legislator_index.sql` | Adds an index so a legislator-first vote-feed lookup over 1.4M+ `vote_casts` rows doesn't blow the anon role's statement timeout. |
| 18 | `0018_vote_aggregates.sql` | Adds the three vote-aggregate **materialized** views (`public_position_totals`, `public_party_alignment`, `public_party_position_totals`) and the `refresh_vote_aggregates()` function that refreshes them. |
| 19 | `0018a_refresh_timeout.sql` | Sets a function-level `statement_timeout` override on `refresh_vote_aggregates()` so a full `REFRESH ... CONCURRENTLY` pass over 1.4M+ rows doesn't die at PostgREST's ~8s role-level default. |
| 20 | `0019_view_scoping_and_freshness.sql` | Whole-branch-review fix round: recreates the public views with correct owner-bypass posture and freshness scoping. |
| 21 | `0020_completeness_checks.sql` | Adds the second verification axis (trust model v3): a `kind='completeness'` row alongside the existing adversarial-verification rows — proves a summary *covers* the bill, not just that each claim is true. |
| 22 | `0021_bullet_citations.sql` | Exposes each summary bullet's exact supporting quote (`citations`) to the public bill page, so a reader can see the bill's literal words behind each claim. |
| 23 | `0022_vote_duplicates.sql` | Adds `vote_duplicates` — a non-destructive grouping table marking which of two adapters' rows for the *same real floor vote* is the primary-source one, so vote-aggregate percentages don't silently double-count. Also redefines `refresh_vote_aggregates()` to exclude superseded votes, and creates the `public_votes` view (first defined here, not in 0016). **Note:** the version of this file as originally applied by Lance had two stray `drop view ... cascade` lines that errored (`42809`) because the targets are materialized views, not plain views — the corrected file (with those two lines removed) is what's committed and what you should apply; the failed original attempt rolled back cleanly as one transaction, so there is nothing to clean up either way. |
| 24 | `0023_vote_duplicates_rls_and_view_drift.sql` | Two fixes found by a comprehensive accuracy audit: enables RLS on `vote_duplicates` (0022 had created it with none — the only table in the schema missing it), and corrects the committed 0022 view definitions to match what was actually applied live. |
| 25 | `0024_lock_down_legiscan_datasets.sql` | Drops the `anon_read` RLS policy on `legiscan_datasets` — its only statement is `drop policy if exists anon_read on legiscan_datasets;`, a policy drop, not a `REVOKE`, so verify it by checking policies, not grants (an earlier migration had opened it unnecessarily — this is operational ledger data, not public-facing). |
| 26 | `0025_scope_summaries_glossary_columns.sql` | Column-scopes anon access to `summaries` and `glossary_terms`: RLS already correctly restricted anon to *published rows*, but nothing restricted *columns* — a bare `select=*` was leaking internal pipeline metadata (`model`, `prompt_version`, `bill_text_hash`, `run_id`, `source_hash`, `needs_mapping`). Grants anon a named column list instead. **`model` deliberately stays public on `summaries`** — the site displays it as attribution. |
| 27 | `0026_fix_refresh_aggregates_timeout_regression.sql` | Restores the `statement_timeout` override that 0022's `CREATE OR REPLACE FUNCTION` had silently dropped (Postgres resets a function's declared config on replace unless the replacing statement re-declares it) — folds it directly into the function body this time so a future replace can't drop it the same way again. |
| 28 | `0027_pg_cron_refresh_aggregates.sql` | Moves the routine, scheduled aggregate refresh off the synchronous HTTP/RPC path entirely — schedules `refresh_vote_aggregates()` as a native `pg_cron` job every 30 minutes, directly inside Postgres (no gateway/HTTP timeout risk for the routine case). **⚠️ FRESH-REBUILD TRAP:** this file's own text reads `create extension if not exists pg_cron with schema cron;`, which **errors on a database where pg_cron is not already enabled** — pg_cron is a non-relocatable extension pinned to `pg_catalog`, so the `with schema cron` clause is rejected. It only worked on the original apply because the extension had already been toggled on via the Supabase dashboard (`IF NOT EXISTS` then skipped the clause). On a genuine rebuild: **enable pg_cron first** in Dashboard → Database → Extensions (search `pg_cron`, toggle on), *then* apply this migration and the `IF NOT EXISTS` is a harmless no-op. If applying cold via SQL instead, use `create extension if not exists pg_cron with schema pg_catalog;` (or drop the schema clause). |
| 29 | `0028_fix_statement_timeout_arm_timing.sql` | Fixes a Postgres semantics trap 0027 alone didn't solve: `statement_timeout` is armed once, at the start of the top-level statement, using whatever is ambient at that instant — a function's own `SET` can never retroactively extend an already-armed deadline. Fix: `alter database postgres set statement_timeout = '600s';`, raising the *ambient* default itself (Supabase's own `postgres` database ships a built-in 2-minute default that was silently capping every attempt at 120s). |
| 30 | `0029_fix_vote_duplicates_antijoin_planner_misestimate.sql` | Fixes a Postgres query-planner misestimation in the three vote-aggregate MATVIEWS' anti-join (`LEFT JOIN vote_duplicates ... WHERE vd.id IS NULL`, which the planner catastrophically misestimated as excluding ~1 row instead of the true ~10,000+) by rewriting it as `NOT EXISTS (...)` — identical semantics, correct plan (Hash Join instead of a cascading Nested Loop). Without this, `refresh_vote_aggregates()` hangs past any reasonable timeout once `vote_casts` grows into the millions. |
| 31 | `0030_revoke_refresh_aggregates_from_authenticated.sql` | Revokes `EXECUTE` on `refresh_vote_aggregates()` from the `authenticated` role. Every prior definition (0018/0022/0026/0027) revoked PUBLIC and `anon` but never `authenticated`, so Supabase's default function grant survived on this `SECURITY DEFINER` function despite 0018's comment claiming service-role-only. One statement, safe to re-run. |
| 32 | `0031_fix_public_views_antijoin_planner_misestimate.sql` | The SAME anti-join fix as 0029, applied to the two plain VIEWS 0029's sweep missed — `public_vote_feed` and `public_votes` (live def from 0023) still carried `LEFT JOIN vote_duplicates ... WHERE vd.id IS NULL`. Once `vote_duplicates` had rows and `vote_casts` reached ~1.47M, the misplanned query crossed the **anon role's 3s `statement_timeout`** and every anonymous profile's vote list returned HTTP 500 — found on the first production browser walk. Rewrites both to `NOT EXISTS`, identical semantics. Without this, the deployed site's profile vote lists are broken for visitors. |
| 33 | `0032_vote_date_provenance.sql` | **DRAFTED, NOT YET APPLIED as of 2026-08-23** — confirm it has been applied on the original instance (`CLAUDE.md` migration trap #2 and `TODO.md` RESUME HERE track it) before treating it as part of the applied set. Adds `votes.vote_date_provenance jsonb`, the receipt for a vote date that was NOT printed on the roll call but derived from the bill's own dated, tallied LegiScan history action (LegiScan prints every 2024 MO House roll call as `0000-00-00`; 185 of 275 are datable by an exact printed AYES/NOES match — Tier 1 only, never a guess; commit 2e420d9's pre-commit review raised the count from 184 to 185, and sibling docs written earlier that day still say 184). **Rebuild consequence:** `ingest-legiscan.js` refuses to store a derived-date vote until this column exists (counted `datesDerivedGated`, the run closes `partial`) — a rebuild without 0032 silently lacks those 2024 House votes; re-running the LegiScan ingest after the apply stores them. |

**No manual/live-only SQL exists outside these files.** Every operational fix this project ever
needed against its own schema (the `pg_cron` extension enable, the `statement_timeout` fixes, the
anti-join rewrite) is captured in the numbered migration files above — apply them in order and
nothing further is required at the schema-provisioning stage. (There is one genuinely
**non-schema** manual step worth knowing about, covered in Section 8 below: the very first
`refresh_vote_aggregates()` run after applying migration 0027 is worth triggering manually once,
either via `npm run refresh:aggregates` or by running `select refresh_vote_aggregates();` directly
in the SQL editor, to confirm the `pg_cron`-plus-`PL/pgSQL`-exception-handling combination actually
works on your project before waiting for the first real cron tick.)

After applying all of them, run a quick sanity check with:

```bash
node --env-file=.env scripts/probe-public-surface.js
```

This is read-only and checks the public read surface's shape and grants against what the
migrations above declare — it should report clean (no violations) with an empty database, since
there's no data yet for RLS to filter.

---

## 6. Bootstrap data

Every ingestion CLI is invoked as `node --env-file=.env <path>`, and several have an `npm run`
shortcut already wired in `package.json`. Run these in the following order. **Replace every
placeholder in `< >` with the current real value at the time you run this** — years, session
numbers, and roll-call ranges are all time-dependent; check the live source (congress.gov,
senate.gov, house.mo.gov, LegiScan) for the current values rather than assuming last year's.

**6.1 — Federal, US House roll calls (Congress.gov + Clerk EVS):**

```bash
node --env-file=.env src/cli/ingest.js --source us-congress --year <current-year> --rolls <lo>-<hi>
```

`--rolls` is a roll-call-number range (e.g. `1-50`). Start with a small window and widen once you
confirm it works — every roll number that doesn't exist yet 404s harmlessly and is recorded as a
non-fatal, expected miss.

**6.2 — Federal, US Senate roll calls (senate.gov LIS XML):**

```bash
node --env-file=.env src/cli/ingest.js --source us-senate --session <current-congress-number> --votes <lo>-<hi>
```

`<current-congress-number>` is the numbered Congress (e.g. `119`). `--votes` is a roll-call-number
range, same shape as `--rolls` above.

**6.3 — MO Senate (senate.mo.gov journals — 30-minute published rate limit, do not shorten):**

```bash
node --env-file=.env src/cli/ingest-mo-senate.js --year <current-year>
```

`--year` is required and one invocation covers ONE calendar year; every prior year you want needs
its own invocation at the same 30-minute limit, so a multi-year historical backfill is a multi-day
affair, not a flag. Journal days that fail to parse are quarantined per day on disk
(`.superpowers/artifacts/mo-senate-journals/<journal-pdf-basename>.failed.json` once the attempt
cap is reached; `listQuarantinedDays` in the CLI reports the standing set) and replayed by deleting
the marker —
the scheduler's `mo-senate-web` ticks then pick a released day up one per tick. (In flight
2026-08-23: a 2026-session `bill_refs` parse-failure class was root-caused and fixed in commit
5ced4eb, its 20 quarantined days were released for replay, and a 52-day 2018 backlog was
discovered and captured in `TODO.md` — Lance's call whether to replay it.)

**6.4 — MO House (house.mo.gov XML/PDF — 30-minute published rate limit, do not shorten):**

```bash
node --env-file=.env src/cli/ingest-mo-house.js
```

Add `--session <session-id>` only if you need a specific non-default MO session; omit it for the
current session. **Never pass a historical/prior-era session to this CLI** — `mo_house_id` is a
table-wide unique constraint against the *current* roster only (the "MO House cross-era
misattribution trap," a known open gap tracked as TODO 31; migration 0009 fixed the identical bug
for `mo_senate_id` but it was never applied to the house column), and a historical backfill would
silently misattribute a successor's votes to their predecessor. Independently of that trap,
house.mo.gov's XML export serves **only the current General Assembly** (verified 2026-08-23 — it
does not serve the 2024 session at all), so `--session` could not backfill a prior GA from this
source even if the `mo_house_id` collision were fixed; prior MO House sessions come from LegiScan
(6.5), and the 2024 House roll calls specifically depend on migration 0032 (Section 5, row 33).

**6.5 — LegiScan (the primary bulk MO source for bills, sponsors, and votes):**

```bash
node --env-file=.env src/cli/ingest-legiscan.js --session <legiscan-session-id>
```

`<legiscan-session-id>` is LegiScan's own internal numeric session id for the current MO General
Assembly session — not the same number as the MO session year. Look this up via LegiScan's own
`getSessionList` API operation for state `MO` (your `LEGISCAN_API_KEY` from Section 4 authenticates
this) if you don't already know it; this project's own scheduler resolves it from a
`sessions.legiscan_session_id` column populated by a prior successful ingest, so on a truly fresh
database you must supply it explicitly the first time.

**6.5b — MO bill text (required before any MO bill can be summarized):**

```bash
node --env-file=.env src/cli/ingest-legiscan-texts.js --dry-run
node --env-file=.env src/cli/ingest-legiscan-texts.js
node --env-file=.env src/cli/backfill-mo-bill-texts.js --dry-run
node --env-file=.env src/cli/backfill-mo-bill-texts.js
```

`ingest-legiscan.js` (6.5) writes bills, sponsors, and votes but **never `bill_texts`** — without
this step `npm run status`'s `bill texts stored` count stays near zero for MO (federal text arrives
via 6.6), the READY-to-summarize funnel is empty, and 6.8 has nothing to do.
`ingest-legiscan-texts.js` pulls text through LegiScan's `getBillText` (counted against the same
monthly query budget as 6.5; `--limit N` paces it);
`backfill-mo-bill-texts.js` fetches the state's own PDFs (documents.house.mo.gov / senate.mo.gov)
with zero LegiScan queries, under the same 30-minute limiters as 6.3/6.4. Both read the gitignored
LegiScan dataset cache that 6.5 creates (see 6.7b), so run them after 6.5. Federal bill text comes
from `enrich-federal-bills.js` (6.6), not from here.

**6.6 — Federal bill enrichment (sponsors, status, text, current roster metadata):**

```bash
node --env-file=.env src/cli/enrich-federal-bills.js
```

Run this after 6.1/6.2 — it enriches every already-ingested federal bill that has at least one
recorded vote, so it has nothing to do on an empty `bills` table.

**6.7 — Identity linking (merge the same real person's rows across sources):**

```bash
node --env-file=.env src/cli/link-persons.js
```

Run this after all the ingestion steps above (6.1–6.6) — it links legislator rows across all
sources present in the database at the time it runs; running it earlier just means running it
again later picks up whatever's new.

**6.7b — Backfills (fill the site-facing columns the drivers leave empty):**

Each is invoked as `node --env-file=.env src/cli/<name>.js`. Every one records an `ingestion_runs`
row, and all but the last are additive (fill NULLs or a known synthetic placeholder, never overwrite
a real source-printed value); `backfill-mo-glossary-citations.js` is the one that deletes — it merges
duplicate term rows into one deterministic survivor after repointing their links, which is why it is
dry-run by default. **Convention: dry-run first, read the plan, then run live.** Most take
`--dry-run`; `backfill-mo-term-dates.js` and
`backfill-mo-glossary-citations.js` are dry-run BY DEFAULT and write only with `--apply`.

| CLI | Fills | Reads |
|---|---|---|
| `backfill-mo-terms.js` | MO `terms` rows (seat/chamber/district per legislator) from the latest MO session's roster — without it the site's address lookup can never find a MO seat | LegiScan dataset cache |
| `backfill-term-states.js` | `terms.state` for US House terms (Senate terms copy their own `district`) | congress.gov member roster |
| `backfill-mo-term-dates.js` (`--apply`, `--apply-overrides <yaml>`) | MO term start/end dates; a human-adjudicated overrides YAML resolves the terms the automatic gate refuses (the one `yaml`-dependency consumer) | LegiScan dataset cache + `.superpowers/artifacts/openstates-people/` |
| `backfill-nicknames.js` | `legislators.nickname` from LegiScan's printed nickname field (identity-merge input) | LegiScan dataset cache |
| `backfill-federal-names.js` | real printed names for federal rows whose `full_name` is still the bioguide-id placeholder | congress.gov API (`/member/congress/{n}` — every member who ever served in that Congress) |
| `backfill-bill-titles.js` | `bills.title` where NULL | LegiScan dataset cache |
| `backfill-mo-bill-meta.js` | `bill_sponsors` rows and LegiScan's printed `bills.status` for MO bills the primary-source drivers created first | LegiScan dataset cache |
| `backfill-mo-glossary-citations.js` (`--apply`) | re-keys the glossary's Missouri statute citations into the parseable RSMo shape the MO glossary runner (6.8) needs, merging duplicates deterministically | live DB only |

**The gitignored `.superpowers/artifacts/` cache is load-bearing here.** `legiscan-datasets/`
holds the dataset ZIPs 6.5 downloads (on the order of 100 MB; the whole artifacts tree is ~1 GB
of re-fetchable source payloads), and every "LegiScan dataset cache" row above reads it — none of
them makes a LegiScan API query of its own — so a fresh clone has nothing for them to read until
6.5 has run live at least once, and a live LegiScan ingest is what regenerates it after a disk
loss. The same directory holds the MO journal and roll-call artifacts (6.3/6.4), the glossary
runner's checkpoints (6.8), the scheduler lock files and logs (Section 9), and the tests' skip
condition (Section 11). Never commit it; never hand-edit it.

**6.7c — Session start dates (recency-first ordering depends on them):**

```bash
node --env-file=.env src/cli/sync-session-dates.js
node --env-file=.env src/cli/sync-session-dates.js --apply
```

The drivers that mint `sessions` rows (6.3, 6.4, 6.5) write no `start_date`, and both
recency-first consumers — `scripts/export-summary-wave.mjs` and the daily scheduler's
`sortQueueRecencyFirst` — silently degrade to name-year order without it (found 2026-08-21: 30 of
31 MO sessions were undated). The dry-run prints every row it would date with its source
(constitutional convening date for regular sessions; the earlier of OpenStates and the cached
LegiScan dataset's first recorded action for specials); `--apply` fills NULLs only and records a
run naming each source. **Re-run it after any ingest that mints a new session row** — every
January, and after any historical 6.3 backfill year.

**6.8 — Plain-language summaries and glossary (optional — the billed paths require
`ANTHROPIC_API_KEY` AND funds on the account; confirm the current spend-approval policy in the
freshly-cloned repo's `CLAUDE.md` before running any of these):**

*(Rewritten 2026-08-23. The five-CLI chain this section used to list — kept as the footnote at the
end — is the superseded v1/v2 path; production last ran it 2026-07-28/29. The three paths below
are what produce summaries and glosses today.)*

**Spend rule, stated once:** every billed call needs Lance's explicit per-run approval with a call
count and dollar estimate up front — EXCEPT `scripts/scheduled-summaries.js`, whose code-enforced
ledger ($1.00 per tick, $5.00 per ISO week, computed from `ingestion_runs`) IS its standing
approval. Never assume the account has been reloaded; the scheduler logs `BALANCE DEPLETED —
reload required` and stops the tick when it has not.

**(a) Billed summaries — the daily scheduler** (`docs/SCHEDULED_SUMMARIES.md`). Registered as a
Task Scheduler job in Section 9; it owns all routine summary production. One manual tick, identical
to a scheduled one:

```bash
node --env-file=.env scripts/scheduled-summaries.js --dry-run
node --env-file=.env scripts/scheduled-summaries.js
```

Per bill it runs the billed trust-model-v3 chain (`src/lib/billed-summary-chain.js`: Haiku authors
from the official text → Sonnet adversarially verifies → blind provisions → a conditional
provisions-corroboration when the yield is under the length-scaled floor → coverage; every paid
stage is checkpointed, so a crashed tick's re-run skips the stages already completed), records
through the same mechanical gates as every other path (`src/cli/summary-queue.js record`), and
auto-publishes only
a mechanically CLEAN result — everything else lands as a flagged draft. Queue order is
recency-first, which is why 6.7c must have run. `SUMMARY_TICK_CAP_USD` / `SUMMARY_WEEKLY_CAP_USD`
in the environment can only LOWER the caps, never raise them.

**(b) $0 summaries — the subagent wave path** (`docs/RUNBOOK_SUMMARY_WAVES.md`; needs a Claude
Code session, not the API key). Export a code-generated batch, run the `summary-wave` workflow
(`.claude/workflows/summary-wave.js`) on it, record through the gates:

```bash
node --env-file=.env scripts/export-summary-wave.mjs 12
#   -> .superpowers/artifacts/wave3/manifest.json + per-bill hash-pinned text files
#   -> run the summary-wave workflow with the manifest contents as args (see the runbook)
node --env-file=.env src/cli/summary-queue.js record --file <records.json> --dry-run
node --env-file=.env src/cli/summary-queue.js record --file <records.json>
node --env-file=.env scripts/build-drain-wave.mjs <WAVE> 6 --pointer   # re-author flagged drafts
```

Never hand-type a manifest (two waves proved a hand-typed one fabricates ids/hashes); `--pointer`
banks each draft's prior to disk instead of inlining it (PLAYBOOK lessons 40 and 46).

**(c) Glossary — the Batch-API runner** (`scripts/gloss-batch-mo.mjs`; the MO statute and U.S.
Code drains that published the live glossary, 2026-08-20/22):

```bash
node --env-file=.env src/cli/backfill-mo-glossary-citations.js            # dry-run, then --apply (6.7b)
node --env-file=.env scripts/gloss-batch-mo.mjs --source mo  --budget-usd <N> [--max-terms N] [--resume]
node --env-file=.env scripts/gloss-batch-mo.mjs --source usc --budget-usd <N> [--max-terms N] [--resume]
```

`--budget-usd` is mandatory and is the hard cap. The runner fetches each cited section from
revisor.mo.gov (`src/adapters/mo-statutes.js`: strictly sequential, 5 s spacing; a bot page = a
10-minute cooldown and one retry) or uscode.house.gov (`src/adapters/uscode.js`, 2 s spacing),
banks the excerpts under `.superpowers/artifacts/gloss-batch-<source>/` (so `--resume` never mixes
the two drains), and **projects every batch's cost from that bank on disk before submitting it** —
refusing the submission if spent + projected would pass the cap (PLAYBOOK lesson 44: the first USC
run spent $8.31 against an $8 cap because the cap only gated between submissions, and USC
excerpts average ~2.5x MO's). Haiku authors → mechanical gates (verbatim quote, non-empty) → one
warned retry → Sonnet escalation → Sonnet adversarial verification; the runner writes the gloss and
its verdicts but never a `published` status — `auto-publish-glossary.js` (footnote below) is the
separate $0 pass that publishes the mechanically CLEAN ones, and flagged glosses wait for Lance's
review. Author and verifier calls go through the Message Batches API (50% of interactive prices). It is a long-running background job — read the lesson-43 note in
Section 9 before stopping one.

*Footnote — the superseded v1/v2 chain (still present, still gated on `ANTHROPIC_API_KEY`, still
bills if run; not the production path since 2026-07-29):*
`src/cli/summarize.js` → `verify.js` → `extract-terms.js` → `gloss.js` → `auto-publish-glossary.js`
(draft → adversarial refutation → glossary-term extraction → per-term gloss → auto-publish CLEAN).
Each prints `{"mode":"blocked","reason":"ANTHROPIC_API_KEY not set"}` and exits cleanly (not an
error) if the key is missing, rather than partially running. Two of them still matter on the side:
new glossary-term drafts now arrive with each recorded summary's `referenced_terms` (so the
scheduler mints them as it publishes), and `auto-publish-glossary.js` still runs as the publish
step after a gloss drain (last ran 2026-08-22 per `npm run status`). Do not delete the chain; just
do not treat it as the production path.

---

## 7. Reapply known data corrections (optional but recommended)

`src/cli/correct-data.js` is the repo's historical-correction tool — a set of targeted, guarded
fixes for defects that were found and fixed against the *original* live instance. Re-running them
against your freshly re-ingested data closes the same known gaps and gets you closer to parity with
the original instance, but **this is a best-effort parity step, not a guarantee** — see Section 1.

Each correction supports `--dry-run` first (always do this before the live run) and takes exactly
one `<which>` positional argument — never a default, so you can't accidentally run every correction
at once. Invoke as:

```bash
node --env-file=.env src/cli/correct-data.js <which> --dry-run
node --env-file=.env src/cli/correct-data.js <which>
```

Run these, in this order, replacing `<which>` each time:

1. `mo-status` — maps MO bills' raw numeric LegiScan status codes to their printed words (sourced
   from LegiScan's own API manual, not guessed).
2. `mo-1969-dates` — re-dates votes carrying LegiScan's `1969-12-31` sentinel date from their
   primary journal filenames.
3. `party-normalize` — normalizes inconsistent party-label spellings/casing.
4. `mo-2026-session-merge` — merges duplicate-session MO bills created by a since-fixed session-
   resolution bug (only relevant if your re-ingest happens to reproduce the same duplicate-session
   condition; harmless no-op otherwise).
5. `mo-2026-vote-reconcile` — redirects votes orphaned by the same session-merge defect above.
6. `legiscan-source-split` — corrects a MO source-attribution defect from an earlier ingest bug.
7. `mo-house-chamber` — fixes MO House votes that were mislabeled as Senate votes by a chamber-
   hardcoding bug in `buildMoVoteRows` (root-caused and fixed in the ingest code itself, so a fresh
   ingest shouldn't reproduce new instances of this — this corrects any that still get created by
   data already ingested before you apply the fix).
8. `vote-duplicates` — the one-time backfill for the cross-adapter vote-duplicate dedup (migration
   0022): finds pairs where both a primary-source adapter (MO House/Senate) and LegiScan wrote a
   row for the same real floor vote, and marks LegiScan's as superseded so vote-aggregate
   percentages don't double-count. Reimplements the matching locally rather than calling the live
   ingest-time matcher (`crossCheckAgainstPrimarySource`) directly — that function has its own side
   effects (writing reconciliation flags) that a backfill against already-published data has no
   business triggering.
9. `pierson-split` — splits the specific known wrong-merge (Tommie Pierson Sr./Jr., two different
   humans wrongly auto-merged into one `persons` row) back into two separate legislator rows. Only
   relevant if `link-persons.js` (Section 6.7) reproduces the same wrong merge against your fresh
   data — a same-source-key contradiction guard added after this was found should prevent it from
   recurring, but this correction exists as a safety net.
10. `glossary-refuted-claims` — fixes specific glossary terms (FECA, BBEDCA) whose text made a
    claim their own adversarial verification had already refuted.
11. `glossary-corrupted-text` — repairs glossary entries with known text-corruption artifacts
    (undecoded unicode escapes, stray control characters) from an earlier extraction bug.

Two more `<which>` values exist beyond the numbered replay list, both for adjudicated
vote-reconciliation flags (they encode a specific human ruling, so they are NOT part of the routine
replay and each must be named explicitly — they are excluded from the `all` sweep, as are five of
the numbered corrections; see the `all` note below):
- `sb914-reconcile` — the one-off SB 914 adjudication (Lance ruled "trust senate journals" 2026-08-05).
- `reconcile-flag` — the GENERAL adjudication tool: `reconcile-flag --flag-id <uuid> --ruling "..."
  --rationale "..." [--canonical-vote <uuid> --superseded-vote <uuid>]`. Supersede a losing vote
  row (writes a `vote_duplicates` exclusion) or resolve-only (close the flag with a recorded ruling,
  no dedup write). These are Lance's human calls, not mechanical replay — on a rebuild, the specific
  rulings would need to be re-made, not blindly re-run.
- Not a `correct-data.js` value, but the same family (added 2026-08-23):
  `scripts/resolve-matched-reconciliation-flags.mjs` (dry-run by default; `--apply` on Lance's go)
  closes `no_tally_corresponding_primary` flags whose LegiScan roll call has SINCE been paired with
  a journal vote in `vote_duplicates` — the ingest path never resolves an already-minted flag when
  its missing primary later arrives. Mechanical and additive (the resolution is recorded inside the
  flag's `discrepancy`; nothing is deleted). Run it after a MO Senate journal replay (6.3) and the
  next LegiScan tick.

`correct-data.js` takes exactly one `<which>` positional (no default, so you can't accidentally run
everything at once). The full set of accepted values is the 11 numbered corrections above, plus
`sb914-reconcile`, `reconcile-flag`, and `all`. **`all` runs ONLY items 1, 2, 3, 6, 7, 8**
(`mo-status`, `mo-1969-dates`, `party-normalize`, `legiscan-source-split`, `vote-duplicates`,
`mo-house-chamber` — the in-place, no-delete, no-FK-redirect class); **items 4, 5, 9, 10, 11**
(`mo-2026-session-merge`, `mo-2026-vote-reconcile`, `pierson-split`, `glossary-refuted-claims`,
`glossary-corrupted-text`) **and the two adjudication tools are deliberately excluded and must each
be named** — running `all` and believing the numbered list is covered skips five of the eleven (the
`|| which === 'all'` branches in `src/cli/correct-data.js` are the authority). Skip any correction
whose target condition doesn't exist in your freshly re-ingested data — most will report a clean
`matched: 0` and do nothing, which is expected and safe.

---

## 8. Refresh aggregates

```bash
npm run refresh:aggregates
```

This runs `scripts/refresh-aggregates.js`, which calls the `refresh_vote_aggregates()` Postgres
function (defined by migrations 0018/0022/0026/0027; its function-level timeout set by 0018a; the
ambient `statement_timeout` it runs under raised by 0028; the matviews it refreshes rebuilt by
0029 — the function itself is untouched there; its grants by 0030) to rebuild the three public
vote-aggregate materialized views (`public_position_totals`, `public_party_alignment`,
`public_party_position_totals`) that the site's profile/party-alignment charts read.

**Expected completion time: on the order of ~19 seconds** for a healthy database at this project's
current scale (~1.47M `vote_casts` rows) — this is the actual timing recorded live after all of
migrations 26/27/28/29 (the timeout-and-planner-misestimate fix chain) were applied and confirmed.
If your rebuilt database is much larger than that by the time you run this, expect it to take
longer, but it should not hang or time out — that's exactly what migration 29's `NOT EXISTS`
rewrite exists to prevent.

A healthy result looks like:

```json
{
  "mode": "refreshed",
  "startedAt": "2026-08-04T...",
  "finishedAt": "2026-08-04T..."
}
```

If you instead see `"mode": "failed"` with a timeout-shaped reason, that does **not** necessarily
mean the refresh itself failed — as of migration 0027, `refresh_vote_aggregates()` keeps its own
durable `ingestion_runs` record (`source: 'refresh-aggregates'`), written inside the same
transaction as the refresh, before Postgres ever sends the HTTP response back. `npm run status`
(Section 11) is the authoritative signal for whether it actually succeeded, not this script's own
exit code — Supabase's edge/gateway infrastructure has its own separate ~120s ceiling on
synchronous REST/RPC calls that this script's own call can still occasionally hit even when the
underlying refresh completed fine server-side.

---

## 9. Set up scheduled automation

Three independent pieces of automation keep this project's data fresh without a human watching every
invocation (two until 2026-08-17, when the daily summary runner — the third block below — was
registered). **`pg_cron` should already exist and be scheduled** once you applied migration
`0027_pg_cron_refresh_aggregates.sql` in Section 5 — *provided you enabled the pg_cron extension
first* (see that migration's fresh-rebuild trap note in Section 5: enable it via Dashboard →
Database → Extensions, or the `with schema cron` clause errors on a cold database). Its trailing
`select cron.schedule(...)` statement does the rest on the database side. Verify it took effect:

```sql
select * from cron.job where jobname = 'refresh-vote-aggregates';
select * from cron.job_run_details order by start_time desc limit 5;
```

The first query should show one row (`schedule: '*/30 * * * *'`, `command: 'select
refresh_vote_aggregates();'`); the second shows actual run history once the first tick fires (every
30 minutes). If the first query returns no rows, migration 0027 was not applied — go back to
Section 5 and apply it.

**The Windows Task Scheduler job (`scripts/scheduled-ingest.js`) is a separate piece — it drives
ongoing *ingestion* from the five government sources, not the aggregate refresh above.** Register
it yourself (this is a machine-owner step, deliberately never run by an agent):

**Use Command Prompt, not PowerShell** — this command's quoting is known to break silently under
PowerShell's default parsing. Adjust the `node.exe` path only if `where node` prints something
different; every path in this command is absolute so Task Scheduler's own working directory doesn't
matter.

```
schtasks /create /tn "VisibleGov Scheduled Ingestion" /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-ingest.js" /sc minute /mo 15 /st 00:00 /f
```

Expected output: `SUCCESS: The scheduled task "VisibleGov Scheduled Ingestion" has successfully
been created.`

This registers a tick every 15 minutes — deliberately shorter than any of the five sources' own
real minimum interval, so a tick is never more than ~15 minutes late; each source's own cooldown
(computed from the durable `ingestion_runs` table, not from wall-clock scheduling) does the real
gating, so an over-frequent tick is harmless (it just finds nothing due and exits 0).

**After creating the task**, switch it to run whether logged on or not (survives logouts/reboots):
open Task Scheduler → find "VisibleGov Scheduled Ingestion" → Properties → General tab → "Run
whether user is logged on or not" (this will prompt once for your account password).

**Also check, same Properties dialog, Settings tab: "Stop the task if it runs longer than" must
exceed 75 minutes** (the `legiscan` source's own per-tick budget) — recommended: uncheck it
entirely, or set it to at least 2 hours. If this Windows-level limit is shorter than 75 minutes, it
can force-kill the whole scheduler process mid-`legiscan`-run from outside the script's own
recovery logic, leaving a stranded `'running'` row in `ingestion_runs`.

Full detail on this scheduler's design, cadence table, and how to verify it's alive:
`docs/SCHEDULED_INGESTION.md`.

**The daily summary runner (`scripts/scheduled-summaries.js`) is the THIRD piece — registered
2026-08-17, it owns ALL routine plain-language-summary production under a code-enforced ledger
($1.00 per tick, $5.00 per ISO week, computed from `ingestion_runs`, never from wall-clock run
count).** A rebuild that stops at the two jobs above gets fresh votes but no new summaries. Same
machine-owner rule, same Command Prompt caveat, same absolute paths:

```
schtasks /create /tn "VisibleGov Scheduled Summaries" /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=F:\VisibleGov\.env F:\VisibleGov\scripts\scheduled-summaries.js" /sc daily /st 06:00 /f
```

Expected output: `SUCCESS: The scheduled task "VisibleGov Scheduled Summaries" has successfully
been created.` Then, in Task Scheduler → Properties:
- **General tab:** "Run whether user is logged on or not" (prompts once for the password), as with
  the ingestion job.
- **Settings tab: check "Run task as soon as possible after a scheduled start is missed."**
  `schtasks /create` leaves this OFF; with it off, any day the machine is powered down at 6 AM
  silently gets no tick. A catch-up tick is just a normal tick — the lock file prevents overlap and
  the ledger binds regardless of when it fires (it fires immediately when the setting is turned on
  if that day's 6 AM has already passed).
- **Settings tab: "Stop the task if it runs longer than" must EXCEED 30 minutes** (the script's own
  stale-lock window); a fresh registration's default (72 h) is fine — the check matters only if the
  task is later edited in the GUI.

On the original machine the Properties dialog could not SAVE this task (OK fails with "One or more
of the specified arguments are not valid" — it chokes on what `schtasks /create` wrote — and
`Set-ScheduledTask` fails the same way), so both settings above actually went in by exporting the
task XML, editing it, and re-creating with `schtasks /create /tn "VisibleGov Scheduled Summaries"
/xml <file> /f` (add `/ru <account> /rp *` for run-whether-logged-on). Expect the same on a rebuild
that uses the same command; the exact procedure is in `docs/SCHEDULED_SUMMARIES.md`.

Its first real tick needs **`ANTHROPIC_API_KEY` in `.env` AND funds on the account**: without the
key it logs `ANTHROPIC_API_KEY not set — exiting without a tick` and exits 0; with the key but no
balance it logs `BALANCE DEPLETED — reload required` and closes the tick `partial`.
`SUMMARY_WEEKLY_CAP_USD` / `SUMMARY_TICK_CAP_USD` in the environment can only lower the caps.
Verify it is alive with `npm run status` (the `SUMMARY SCHEDULER` block and the
`scheduled-summaries` freshness row) and the daily log under
`.superpowers/artifacts/summary-scheduler-logs/`. Full detail — including the throttled first
manual tick and the XML re-create procedure for editing the task on this machine (the GUI and
`Set-ScheduledTask` both fail there): `docs/SCHEDULED_SUMMARIES.md`.

**Stopping any long-running runner (a scheduler tick, `gloss-batch-mo.mjs`, a journal replay) —
PLAYBOOK lesson 43:** stop it by PID (launch with the PID written to a file; `Stop-Process` on that
PID tree; confirm the PID is gone), **never by grepping command lines** — Windows returns a NULL
command line for processes the querying session no longer owns, so a grep-based "0 runners" check
once missed an orphan that went on to submit a billed batch. After a stop, re-read the job's own
state files a few minutes later: a file that keeps changing is a process that is still alive. A
killed runner leaves its lock behind — `.superpowers/artifacts/scheduler.lock.json` (ingestion) and
`.superpowers/artifacts/summary-scheduler.lock.json` (summaries); both self-heal once a later tick
finds the lock older than its own declared max duration, and a tick that finds a live lock logs
`already running ... — skipping this tick` and exits 0, which is the designed behavior, not a
fault.

---

## 10. Serve and verify the site locally

**Deploy status as of 2026-08-05: the ORIGINAL instance is deployed to Cloudflare Pages** at
`https://visiblegov.pages.dev` (custom domain still pending — decided 2026-08-22: `visiblegov.us`,
which Lance owns; attaching it is Phases 3-4 of `docs/CLOUDFLARE_DEPLOY.md`, his console work). A
rebuild does NOT inherit that — a fresh rebuild produces working *code and data*, and getting it
onto Cloudflare is a separate step (the runbook for it is `docs/CLOUDFLARE_DEPLOY.md`, and the two deploy-time gotchas it documents are
real and will bite a rebuild too: Pages Functions do not inherit `site/_headers` — `site/functions/
geocode.js` sets its own headers from `site/js/security-headers.js`; and `site/_redirects` targets
MUST be extensionless — `/person/* → /person`, never `/person.html` — because Pages
308-canonicalizes `.html` and a `.html` target produces redirect loops / stripped path segments).
Until you complete that step, the rebuilt site is verifiable locally (below) but not on the public
internet — do not report the rebuild as "live" before it actually is (Section 12).

**Configure `site/config.js` first.** This file holds the Supabase **anon (publishable)** key and
project URL the browser-side JS uses — it is committed to the repo and designed to be public (the
anon key is meant to be public; RLS is the actual security wall, not secrecy of this value). Since
this rebuild targets a **new** Supabase project, update it to point at yours:

```js
// site/config.js
export const SUPABASE_URL = '<YOUR_SUPABASE_URL>';
export const SUPABASE_ANON_KEY = '<YOUR_SUPABASE_ANON_KEY>';
```

Use the **anon** key here, never the service-role key — the anon key is the only one safe to ship
to a browser.

Then serve the site locally:

```bash
node scripts/serve-site.js
```

This starts a zero-dependency static server on `http://127.0.0.1:8990`, mirroring Cloudflare
Pages' own `site/_redirects` rewrites and the `/geocode` Pages Function passthrough (used by the
directory's address-lookup feature), so local dev behaves the same as production would. This
server is dev-only — it is never used in production; Cloudflare Pages would serve `site/` directly
from the repo once deployed.

Open `http://127.0.0.1:8990` in a browser and confirm: the directory page loads, you can open a
legislator profile (try one from each of US Senate / US House / MO Senate / MO House if your
bootstrap data covers all four), see their recorded votes, and click through to a bill page showing
the recorded tally. Check the browser console for errors — there should be none.

---

## 11. Run verification

1. **Unit/integration test suite** (zero live network or DB calls — safe to run any time, requires
   no `.env`):

   ```bash
   npm test
   ```

   Equivalently `node --test`. **Do not pass a directory argument** (`node --test tests/` breaks
   under this project's Node/Windows combination with `MODULE_NOT_FOUND` — bare `node --test` does
   the right default discovery). **Gate any decision on the extracted `ℹ fail N` line, never the
   process's plain exit status** — a `grep` filtering the output still exits 0 even when the run it
   filtered was red (`PLAYBOOK_DELTA.md` lesson 14). This project's suite runs on the order of
   2,300+ tests; a healthy run ends with something like:

   ```
   ℹ tests 2300+
   ℹ pass 2300+
   ℹ fail 0
   ```

   `ℹ fail 0` is the only line that matters for a go/no-go decision. Four backfill-related test
   files intentionally skip cleanly on a fresh clone (they read the real, gitignored, weekly-mutating
   LegiScan dataset cache at `.superpowers/artifacts/legiscan-datasets/` — the same cache the
   6.5b/6.7b backfill CLIs read — which won't exist until you've run live LegiScan ingestion at
   least once) — seeing a handful of honest skips there is expected, not a failure.

2. **Live data status:**

   ```bash
   npm run status
   ```

   Equivalently `node --env-file=.env scripts/data-status.js`. Prints real counts (vote casts, roll
   calls, bills, legislator rows, summary/glossary publication counts) and per-source ingestion
   freshness, straight from your rebuilt database. This is the only authoritative source for "what
   do we actually have right now" — see `docs/DATA_INVENTORY.md` for what each number *means*, not
   just what it is.

3. **Public read-surface probe** (confirms RLS/grants match what the migrations declare):

   ```bash
   node --env-file=.env scripts/probe-public-surface.js
   ```

4. **A real browser check of the site** — Section 10 above.

---

## 12. Known limitations to be aware of post-rebuild

These are real, disclosed, structural gaps in the project as it stands — this rebuild does not fix
them, and you should not expect it to:

- **`mo-house-xml`'s own vote-cast resolution is structurally capped to one legislator — but this
  is NOT the same as "MO House profile pages are incomplete."** The MO House roll-call-PDF
  ingestion pipeline (`ingest-mo-house.js`) resolves individual vote casts against a roster
  (`persistRoster`) that seeds exactly **one real legislator row** — a leftover test fixture — so
  this one narrow adapter's own contribution never grows past that one person. Investigated
  end-to-end 2026-08-05 and confirmed live: LegiScan's own independent, comprehensive MO House
  coverage means all 159 CURRENT MO House legislators actually have real MO House votes visible on
  their profile page regardless — the "162 of 163 show zero" figure some earlier docs cited was
  specifically about votes sourced *from `mo-house-xml`*, not the profile page as a whole, and a
  fresh rebuild will exhibit the identical (narrow, LegiScan-covered) picture, not a broadly blank
  one. A roster-ingest-loop fix for `mo-house-xml` specifically was deliberately deprioritized
  (~3.4-day cost for confirmed-redundant output — every bill it resolves any cast for already has a
  LegiScan vote for the same bill). Decision made: ship as-is, no site caveat needed. See `TODO.md`
  NOW ("MO House per-legislator vote coverage") for the full evidence trail.
- **Cloudflare Pages deployment: the ORIGINAL instance IS deployed (2026-08-05) at
  `https://visiblegov.pages.dev` — custom domain `visiblegov.us` decided 2026-08-22, not yet
  attached; a rebuild starts from un-deployed and must redo it.** The full,
  authoritative runbook is `docs/CLOUDFLARE_DEPLOY.md` in the cloned repo — follow that, not a
  summary. The Pages project settings that matter: production branch `main`, framework preset
  **None**, empty build command, **root directory `site`**, and **build output directory LEFT
  EMPTY** (it is resolved *relative to* the root directory, so `site` there would look for
  `site/site/` and fail — root `site` + output empty is the working config, and root `site` is what
  makes Pages discover `functions/` at all). Zero environment variables (the site's only "config" is
  the committed `site/config.js` anon key). Completing this rebuild through Section 11 gets you a
  working local instance; the Cloudflare step is what puts it on the public internet.
- **Federal vote history is current-Congress only.** All federal vote casts come from the most
  recently ingested Congress — a legislator's pre-that-Congress federal record (e.g. a senator's
  earlier terms) is not in the database. Not wrong, just thin; the site labels dates honestly
  rather than implying completeness.
- **Missouri House 2024 is absent until migration 0032 is applied and the LegiScan ingest re-run**
  (added 2026-08-23): LegiScan prints all 275 of that session's House roll calls with a
  `0000-00-00` date, house.mo.gov's XML serves only the current General Assembly, and the ingest
  refuses a derived date without the 0032 receipt column — see Section 5 row 33 and
  `docs/DATA_INVENTORY.md` GAP 1. Even after 0032, 90 of the 275 stay refused by design (Tier 1
  dates 185 per commit 2e420d9).
- **Some open, human-adjudication-only items will not be resolved by this rebuild:** cross-source
  vote-tally contradictions and legislator-identity ambiguity flags are, by design, left for the
  project owner's own judgment rather than auto-resolved (`vote_reconciliation_flags` and
  `identity_flags` tables, worked through the local `npm run review` staff page). Their count is
  neither small nor stable — `npm run status` OPERATOR QUEUE is the only honest number (as of
  2026-08-23: reconciliation flags open in the hundreds, identity flags 0; most of the recent
  growth was LegiScan 2026 MO Senate roll calls whose journal counterpart sat in the quarantine
  fixed 2026-08-23, see 6.3). One class IS mechanically closable:
  `scripts/resolve-matched-reconciliation-flags.mjs` (Section 7) resolves
  `no_tally_corresponding_primary` flags whose journal twin has since arrived — run it after a
  journal replay and the next LegiScan tick. A freshly rebuilt instance will surface its own fresh
  set of these — expect some, they are a normal, expected part of this project's operation, not a
  defect.

---

## 13. Where to go for deeper context

If anything in this guide is unclear, stale, or conflicts with what you find in the repo, consult
these in priority order — **`TODO.md` is the freshest source of truth and wins any conflict with
this document**, since this guide is a point-in-time snapshot and `TODO.md` is updated continuously:

1. **`PLAYBOOK_DELTA.md`** — reusable lessons, traps, and gotchas accumulated across this project
   and its siblings; read this before touching anything you're unsure about.
2. **`CHATLOG.md`** — the full, word-for-word decision trail: why things are built the way they
   are, appended after every substantive exchange since the project's first day.
3. **`TODO.md`** — the current, live state: what's actually open right now (its NOW section), the
   backlog, and raw idea notes. **This is the freshest source of truth in the repo — if it
   disagrees with this document, trust `TODO.md`.**
4. **`docs/CONTROLLER_BRIEFING.md`** — a deep catch-up document compiled from the project's full
   history (specs, plans, research docs, live code), meant to onboard a fresh session faster than
   reading everything else from scratch. It carries its own staleness banner — defer to `TODO.md`
   and live checks (`npm run status`, `probe-public-surface.js`) for anything migration-applied-state
   related.

Also useful, not required reading to complete this rebuild: `README.md` (short project overview
and the canonical short-form runbook this document expands on), `docs/DATA_INVENTORY.md` (what
each live number means and how the tables relate to each other), `docs/SCHEDULED_INGESTION.md` and
`docs/SCHEDULED_SUMMARIES.md` (full detail on the two Task Scheduler automations from Section 9),
`docs/RUNBOOK_SUMMARY_WAVES.md` (the $0 summary path from Section 6.8), and `CLAUDE.md` (this
project's own working rules, including the current, possibly-changed status of the
API-spend-approval policy referenced in Section 2).
