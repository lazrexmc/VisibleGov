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
- The **infrastructure** (the Windows Task Scheduler job that drives ongoing ingestion, the
  `pg_cron` job inside Postgres that keeps vote-aggregate charts fresh).
- The **live data**, by **re-ingesting it fresh from the original government/API sources**
  (Congress.gov, senate.gov LIS, house.mo.gov XML/PDF, senate.mo.gov journals, LegiScan, and
  optionally Anthropic's API for plain-language summaries/glossary).

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
  prose (e.g. the SB 914 vote-reconciliation-flag adjudication, still open as of this writing) will
  need to be re-made by a human, not replayed by a script.
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
`fast-xml-parser`, `pdfjs-dist`, `yauzl`) and the one dev dependency (`jsdom`, used only by the
test suite). There is no build step — the site (`site/`) is plain HTML/CSS/vanilla JS served
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
# LegiScan API (registered 2026-07-28; non-commercial, CC BY 4.0 attribution required on
# every public surface showing LegiScan-derived data; binding operating terms in
# docs/research/2026-07-28-legiscan-terms.md)
LEGISCAN_API_KEY=your-legiscan-api-key
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

**One key `.env.example` does NOT currently list, but that several CLIs require and will fail
without:** `ANTHROPIC_API_KEY`. Add this line yourself if you plan to run the summarization/glossary
pipeline (`summarize.js`, `verify.js`, `extract-terms.js`, `gloss.js`, `golden.js` all check for it
and print `{"mode":"blocked","reason":"ANTHROPIC_API_KEY not set"}` and exit cleanly if it's
missing — they do not crash, but they also do nothing):

```
ANTHROPIC_API_KEY=<YOUR_ANTHROPIC_API_KEY>
```

Every script that touches the network or the database in this repo is invoked as
`node --env-file=.env <path>` — `package.json`'s `scripts` block already wires this in for every
command that has an `npm run` shortcut.

---

## 5. Provision the database

Every schema change in this project lives in `supabase/migrations/*.sql` and is
**draft-then-apply**: there is no CLI/local Supabase setup and no automated apply step anywhere in
this repo. You paste each file's contents into your new Supabase project's **SQL Editor** and run
it, **in order**, one at a time, confirming each succeeds before moving to the next.

Apply these 29 files, in this exact order, by filename:

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
| 16 | `0016_public_read_surface.sql` | Defines the public read surface for the site: locks down two tables, adds one column, adds four public-facing views (`public_freshness`, `public_votes`, `public_vote_feed`, and a bill-facing view) that expose only named columns to `anon`. |
| 17 | `0017_vote_casts_legislator_index.sql` | Adds an index so a legislator-first vote-feed lookup over 1.4M+ `vote_casts` rows doesn't blow the anon role's statement timeout. |
| 18 | `0018_vote_aggregates.sql` | Adds the vote-aggregate **materialized** views (`public_position_totals`, `public_party_alignment`) and the `refresh_vote_aggregates()` function that refreshes them. |
| 19 | `0018a_refresh_timeout.sql` | Sets a function-level `statement_timeout` override on `refresh_vote_aggregates()` so a full `REFRESH ... CONCURRENTLY` pass over 1.4M+ rows doesn't die at PostgREST's ~8s role-level default. |
| 20 | `0019_view_scoping_and_freshness.sql` | Whole-branch-review fix round: recreates the public views with correct owner-bypass posture and freshness scoping. |
| 21 | `0020_completeness_checks.sql` | Adds the second verification axis (trust model v3): a `kind='completeness'` row alongside the existing adversarial-verification rows — proves a summary *covers* the bill, not just that each claim is true. |
| 22 | `0021_bullet_citations.sql` | Exposes each summary bullet's exact supporting quote (`citations`) to the public bill page, so a reader can see the bill's literal words behind each claim. |
| 23 | `0022_vote_duplicates.sql` | Adds `vote_duplicates` — a non-destructive grouping table marking which of two adapters' rows for the *same real floor vote* is the primary-source one, so vote-aggregate percentages don't silently double-count. Also redefines `refresh_vote_aggregates()` to exclude superseded votes. **Note:** the version of this file as originally applied by Lance had two stray `drop view ... cascade` lines that errored (`42809`) because the targets are materialized views, not plain views — the corrected file (with those two lines removed) is what's committed and what you should apply; the failed original attempt rolled back cleanly as one transaction, so there is nothing to clean up either way. |
| 24 | `0023_vote_duplicates_rls_and_view_drift.sql` | Two fixes found by a comprehensive accuracy audit: enables RLS on `vote_duplicates` (0022 had created it with none — the only table in the schema missing it), and corrects the committed 0022 view definitions to match what was actually applied live. |
| 25 | `0024_lock_down_legiscan_datasets.sql` | Revokes anon's `SELECT` on `legiscan_datasets` (an earlier migration had granted it unnecessarily — this is operational ledger data, not public-facing). |
| 26 | `0025_scope_summaries_glossary_columns.sql` | Column-scopes anon access to `summaries` and `glossary_terms`: RLS already correctly restricted anon to *published rows*, but nothing restricted *columns* — a bare `select=*` was leaking internal pipeline metadata (`model`, `prompt_version`, `bill_text_hash`, `run_id`, `source_hash`, `needs_mapping`). Grants anon a named column list instead. **`model` deliberately stays public on `summaries`** — the site displays it as attribution. |
| 27 | `0026_fix_refresh_aggregates_timeout_regression.sql` | Restores the `statement_timeout` override that 0022's `CREATE OR REPLACE FUNCTION` had silently dropped (Postgres resets a function's declared config on replace unless the replacing statement re-declares it) — folds it directly into the function body this time so a future replace can't drop it the same way again. |
| 28 | `0027_pg_cron_refresh_aggregates.sql` | Moves the routine, scheduled aggregate refresh off the synchronous HTTP/RPC path entirely — schedules `refresh_vote_aggregates()` as a native `pg_cron` job every 30 minutes, directly inside Postgres (no gateway/HTTP timeout risk for the routine case). Also enables the `pg_cron` extension (`create extension if not exists pg_cron with schema cron;` — idempotent, harmless if already enabled via the dashboard). |
| 29 | `0028_fix_statement_timeout_arm_timing.sql` | Fixes a Postgres semantics trap 0027 alone didn't solve: `statement_timeout` is armed once, at the start of the top-level statement, using whatever is ambient at that instant — a function's own `SET` can never retroactively extend an already-armed deadline. Fix: `alter database postgres set statement_timeout = '600s';`, raising the *ambient* default itself (Supabase's own `postgres` database ships a built-in 2-minute default that was silently capping every attempt at 120s). |
| — | `0029_fix_vote_duplicates_antijoin_planner_misestimate.sql` | Fixes a Postgres query-planner misestimation in the three vote-aggregate matviews' anti-join (`LEFT JOIN vote_duplicates ... WHERE vd.id IS NULL`, which the planner catastrophically misestimated as excluding ~1 row instead of the true ~10,000+) by rewriting it as `NOT EXISTS (...)` — identical semantics, correct plan (Hash Join instead of a cascading Nested Loop). Without this, `refresh_vote_aggregates()` hangs past any reasonable timeout once `vote_casts` grows into the millions. |

**No manual/live-only SQL exists outside these files.** Every operational fix this project ever
needed against its own schema (the `pg_cron` extension enable, the `statement_timeout` fixes, the
anti-join rewrite) is captured in the numbered migration files above — apply them in order and
nothing further is required at the schema-provisioning stage. (There is one genuinely
**non-schema** manual step worth knowing about, covered in Section 8 below: the very first
`refresh_vote_aggregates()` run after applying migration 0027 is worth triggering manually once,
either via `npm run refresh:aggregates` or by running `select refresh_vote_aggregates();` directly
in the SQL editor, to confirm the `pg_cron`-plus-`PL/pgSQL`-exception-handling combination actually
works on your project before waiting for the first real cron tick.)

After applying all 29, run a quick sanity check with:

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

**6.4 — MO House (house.mo.gov XML/PDF — 30-minute published rate limit, do not shorten):**

```bash
node --env-file=.env src/cli/ingest-mo-house.js
```

Add `--session <session-id>` only if you need a specific non-default MO session; omit it for the
current session. **Never pass a historical/prior-era session to this CLI** — `mo_house_id` is a
table-wide unique constraint against the *current* roster only (a known, documented gap, see
Section 12), and a historical backfill would silently misattribute a successor's votes to their
predecessor.

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

**6.8 — Plain-language summarization pipeline (optional — requires `ANTHROPIC_API_KEY`, costs
real API spend; confirm current spend-approval policy in the freshly-cloned repo's `CLAUDE.md`
before running any of these):**

```bash
node --env-file=.env src/cli/summarize.js
node --env-file=.env src/cli/verify.js
node --env-file=.env src/cli/extract-terms.js
node --env-file=.env src/cli/gloss.js
node --env-file=.env src/cli/auto-publish-glossary.js
```

In order: `summarize.js` drafts a plain-language summary for eligible bills (text on hand, no
existing summary at the current text hash); `verify.js` runs the adversarial refutation pass;
`extract-terms.js` pulls glossary-term candidates out of summarized bill text;
`gloss.js` authors + verifies a 1-2 sentence gloss for each extracted term; `auto-publish-glossary.js`
auto-publishes any glossary term whose verification came back mechanically clean. Each of these
CLIs prints `{"mode":"blocked","reason":"ANTHROPIC_API_KEY not set"}` and exits cleanly (not an
error) if the key is missing, rather than partially running.

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

Skip any correction whose target condition doesn't exist in your freshly re-ingested data — most
will report a clean `matched: 0` and do nothing, which is expected and safe.

---

## 8. Refresh aggregates

```bash
npm run refresh:aggregates
```

This runs `scripts/refresh-aggregates.js`, which calls the `refresh_vote_aggregates()` Postgres
function (defined by migrations 18/19/23/26/27/28/29 above) to rebuild the three public
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

Two independent pieces of automation keep this project's data fresh without a human watching every
invocation. **`pg_cron` should already exist and be scheduled** once you applied migration
`0027_pg_cron_refresh_aggregates.sql` in Section 5 — that migration's `create extension if not
exists pg_cron with schema cron;` plus its trailing `select cron.schedule(...)` statement is all
that's needed on the database side. Verify it took effect:

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

---

## 10. Serve and verify the site locally

**Real deploy status as of this writing: Cloudflare Pages has NOT been deployed.** The public site
(`site/`) exists as code in this repo and has been verified working end-to-end in a local browser
against live data, but it is not live on the public internet under any domain. Do not assume or
imply otherwise when reporting on this rebuild's completeness — see Section 12.

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
   files intentionally skip cleanly on a fresh clone (they read a real, gitignored, weekly-mutating
   LegiScan dataset cache that won't exist until you've run live LegiScan ingestion at least once) —
   seeing a handful of honest skips there is expected, not a failure.

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

- **MO House per-legislator vote coverage is structurally incomplete.** The MO House
  roll-call-PDF ingestion pipeline (`ingest-mo-house.js`) resolves individual vote casts against a
  roster (`persistRoster`) that seeds exactly **one real legislator row** — a leftover test
  fixture. The practical effect: roughly 162 of ~163 MO House members show **zero** MO House votes
  on their own profile page, forever, with no caveat currently shown to the visitor, while the one
  fixture legislator looks fully tracked on the exact same roll calls. This is a real, disclosed,
  open gap — not something a fresh rebuild fixes on its own, since the underlying roster-seeding
  code is what would need to change. It is a deliberate, honest limitation (the site never
  fabricates a "did not vote" claim to paper over the gap) but it is a real content-completeness
  problem a visitor to a MO House member's page will notice.
- **Cloudflare Pages deployment has not happened.** This is a deliberate future milestone, not an
  oversight — the project's own standing rule (Lance, project owner) is that Cloudflare deployment
  only starts once the backend is fully locked in and accurate, specifically to avoid
  troubleshooting two systems (backend + deploy) at once. Completing this rebuild through Section
  11 gets you a working local instance; it does not put anything on the public internet. If/when
  deployment resumes, the current plan (see `TODO.md`'s NOW section, "Cloudflare Pages" entry, in
  the cloned repo) targets: project name deliberately chosen, production branch `main`, framework
  preset **None**, empty build command, build output directory `site`, root directory `site`, zero
  environment variables (the site's only "config" is the committed `site/config.js` anon key).
- **Federal vote history is current-Congress only.** All federal vote casts come from the most
  recently ingested Congress — a legislator's pre-that-Congress federal record (e.g. a senator's
  earlier terms) is not in the database. Not wrong, just thin; the site labels dates honestly
  rather than implying completeness.
- **Some open, human-adjudication-only items will not be resolved by this rebuild:** a small number
  of cross-source vote-tally contradictions and legislator-identity ambiguity flags are, by design,
  left for the project owner's own judgment rather than auto-resolved (`vote_reconciliation_flags`
  and `identity_flags` tables, worked through the local `npm run review` staff page). A freshly
  rebuilt instance will surface its own fresh set of these — expect some, they are a normal,
  expected part of this project's operation, not a defect.

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
each live number means and how the tables relate to each other), `docs/SCHEDULED_INGESTION.md`
(full detail on the Task Scheduler automation from Section 9), and `CLAUDE.md` (this project's own
working rules, including the current, possibly-changed status of the API-spend-approval policy
referenced in Section 2).
