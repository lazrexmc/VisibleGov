# Moving ingestion off the desktop, onto GitHub Actions

**Status: workflows are committed and will NOT run until you add the secrets below.** A scheduled
workflow in a private repo still needs its secrets to exist; without them the first tick fails fast
rather than doing anything half-right. Nothing has changed on your machine yet — the Windows tasks
are still the live scheduler until you turn them off in step 4.

## Why this migration exists

Ingestion ran on Windows Task Scheduler, every 15 minutes, in a process holding
`SUPABASE_SERVICE_ROLE_KEY` — the key that bypasses every RLS wall. That same process parses PDFs
fetched from external government sites, and `pdfjs-dist` 6.1.200 carried **GHSA-hq66-cqwq-w95j**,
"arbitrary JavaScript execution upon opening a malicious PDF."

Patching the CVE (2026-08-29) removed *that instance*. It did not change the **blast radius**: a
successful RCE would have executed on your personal machine, next to your browser profile and the
credentials of every other project in the workspace. That is a credential harvest, not a scoped
compromise of one Supabase project.

On Actions the same code runs in a container that is destroyed when the job ends, and the key lives
in GitHub Secrets instead of in a `.env` at rest on a desktop.

## Decisions already made, and why

**The repo stays PRIVATE.** Going public would have made Actions minutes free and unlimited, and the
git history was verified clean (692 commits, no `.env` ever tracked, no service-role JWT, no
Anthropic key). It was rejected on different grounds: publishing exposes **all history**, and this
repo carries `docs/VOTERTABLES_JOIN_GAMEPLAN.md` (an unshipped commercial product's roadmap),
client and project names throughout `CHATLOG.md`, and a personal email in
`tests/fixtures/research/SOURCES.md`. Deleting those today would not help — history is what gets
forked and indexed — so it would have required rewriting 692 commits and destroying the decision
trail. Not worth it for a benefit that hourly scheduling already buys.

**Cadence drops from every 15 minutes to hourly.** Private repos get 2,000 Actions minutes/month on
the Free plan. Measured over 30 days, real ingestion work is ~1,321 minutes; add runner start and
`npm ci` per job and `*/15` (2,880 jobs) would cost **$30-55/month** and break the project's
$0/month stack. Hourly (720 jobs) lands around **1,600-1,900 min/month** — inside the tier, with a
thin margin. Roll calls do not change every 15 minutes.

**Cron drift is safe**, which is what makes hourly viable at all. GitHub's scheduler is best-effort
and often fires late. `scheduled-ingest.js` decides per-source due-ness by reading `ingestion_runs`,
so a late tick just finds more work due and does it. There is no fixed-interval assumption to break.

## Step 1 — add the secrets

**Settings → Secrets and variables → Actions → New repository secret.** Copy each value from your
local `.env`.

| Secret | Needed by | Notes |
|---|---|---|
| `SUPABASE_URL` | both ingest workflows | |
| `SUPABASE_SERVICE_ROLE_KEY` | both | the RLS-bypassing key — this is the one we are getting off the desktop |
| `CONGRESS_API_KEY` | `ingest` | |
| `OPENSTATES_API_KEY` | `ingest` | |
| `LEGISCAN_API_KEY` | `ingest-legiscan` | |
| `HEALTHCHECK_PING_URL` | both | optional; the dead-man's switch. Omit and the ping is skipped. |

Optional **variable** (Settings → Variables, not Secrets — it is not sensitive):
`LEGISCAN_MONTHLY_QUERY_CAP`.

> Do not paste any of these into a commit, an issue, or a chat. Secrets are write-only in the GitHub
> UI by design — if you need to read one back, read your `.env`.

## Step 2 — prove it works before trusting it

Run each workflow by hand first. **Actions → ingest → Run workflow**, then the same for
`ingest-legiscan`. Both are `workflow_dispatch`-enabled precisely so you can do this.

A good first run:
- exits green;
- the log shows each source either ingesting or reporting it is not due;
- `npm run status` afterwards shows the source's `last finished` timestamp has moved.

**That last check is the real one.** A green job only proves the process exited 0; the freshness
timestamp proves it actually wrote to the database.

## Step 3 — let both run in parallel for a day

Leave the Windows tasks running while Actions ticks. They cannot corrupt each other: due-ness is
computed from `ingestion_runs`, so whichever runs first marks the source done and the other finds
nothing due. Overlap is wasteful, not dangerous. Watch for a day that Actions is genuinely keeping
up before you rely on it.

## Step 4 — disable the Windows tasks (YOUR step)

**An agent never runs `schtasks`** — registering, pausing, and removing these tasks is yours, by
standing rule in `docs/SCHEDULED_INGESTION.md`.

In Task Scheduler, **Disable** (not Delete) `VisibleGov Scheduled Ingestion`. Disable keeps the
task's configuration, so rollback is one click.

**Leave `VisibleGov Scheduled Summaries` alone** — see below.

## What did NOT move, and why it is your call

`scripts/scheduled-summaries.js` is still on Task Scheduler. It has the same problem — it holds
`ANTHROPIC_API_KEY` *and* the service-role key on your desktop — so the same argument applies.

It was not moved unilaterally because it is the **billed** path. Its `$1/tick + $5/ISO-week` ledger
is enforced in code and would work identically on Actions, but moving it means billed API calls fire
from CI, and your standing rule is that billed runs need explicit per-run approval. That is a
decision, not a refactor. Say the word and it is a near-copy of `ingest.yml` plus one secret.

## Rollback

Re-enable the Windows task in Task Scheduler, then disable the workflows (**Actions → ingest → ⋯ →
Disable workflow**). Nothing about the data changes; both paths run the same script against the same
tables.

## Watching the minute budget

**Settings → Billing → Plans and usage → Actions.** The margin is thin by design. If you approach
the cap, the lever is the `cron:` line in `.github/workflows/ingest.yml` — every-two-hours roughly
halves job overhead — **not** the code. Do not "fix" an overage by removing the `npm` cache or the
concurrency guard; both are load-bearing.
