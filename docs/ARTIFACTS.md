# Cached artifacts - what's on disk, what it costs to lose

`.superpowers/artifacts/` holds ~1.1 GB (2026-08-23; `du -sh .superpowers/artifacts` for the live
figure - it was ~969 MB when this file was written) of cached source payloads **plus the
scheduler's park/checkpoint state, two Batch-API run ledgers and the summary-wave working files**
- since early August (`openstates-people/` 2026-08-06, `wave3/` 2026-08-07) it no longer holds
only source caches. It is **gitignored and lives on one local disk**. This file exists so that
if it is ever lost, the next person knows exactly what they're rebuilding, what it costs, and
what rules bind the rebuild.

Written 2026-07-31 (Lance: *"Preserve all info"*). Nothing here is irreplaceable - the synthesized
reasoning is in `.superpowers/sdd/**/*.md`, which IS in git. This is all re-fetchable. Some of it is
just expensive or rule-bound to re-fetch.

*(Re-stated 2026-08-23, when the second table below was added: "all re-fetchable" is still true of
the SOURCE caches in the first table. The directories that arrived since - scheduler park state and
paid per-stage checkpoints, the glossary Batch-API run ledgers, the summary-wave working files -
are not fetched from anyone. Most are rebuilt from the database or from committed scripts at $0;
the ones that are not (`scheduled-summaries/parked.json`, `scheduled-summaries/stages/`,
`wave3/api-stages/`, a `gloss-batch-*/state.json` while a run is in flight) cost **money or
re-work, never data**, to lose - the published record is in Supabase either way.)*

*(File/size counts in the first table are a 2026-07-31 snapshot and grow continuously as the
scheduler ingests - treat them as "about this many," never as current fact. Spot-checked
2026-08-06, several have grown, e.g. `mo-senate-journals/` ~92, `scheduler-logs/` one file per day
since; spot-checked again 2026-08-23: `legiscan-datasets/` ~111 MB / 34 files (see its section for
why files outnumber sessions). The second table was measured 2026-08-23. `ls` the directory for
the real number.)*

| Cache | Size | Files | Replaceable? |
|---|---|---|---|
| `legiscan-texts/` | 859 MB | 3,177 | **Costly + rule-bound** - see below |
| `legiscan-datasets/` | 94 MB | 32 | Rule-bound (suspension-level) |
| `congress-legislators/` | 15 MB | 2 | Free - public CC0 download |
| `mo-senate-journals/` | 93 KB | 81 | Free, but slow (30-min ToU) |
| `mo-bills/`, `mo-bill-list/`, `mo-rollcalls/` | 771 KB | 153 | Free, but slow (30-min ToU) - mo-rollcalls' rebuild ceiling is capped by a roster gap, not by cost; see note below |
| `mo-senate-journal-index/`, `mo-senate-roster/` | 44 KB | 4 | Free |
| `scheduler-logs/` | ~700 KB | 3 | Free, but not a source cache - see note below |

**Added 2026-08-23 - scheduler, batch-run and wave state (not source caches; measured 2026-08-23;
notes in the section of the same name below):**

| Directory / file | Size | Files | Replaceable? / what losing it costs |
|---|---|---|---|
| `wave3/` | ~69 MB | ~1,800 | Mostly $0 working files rebuilt from the DB - except `api-stages/`, ~310 paid author/check checkpoints (a few dollars of banked stages) |
| `scheduled-summaries/` | ~880 KB | ~70 | **Cost-bearing:** `parked.json` (park list - loss = paid re-attempts under the ledger) and `stages/` (paid per-stage checkpoints); `records-*.json` are already recorded |
| `summary-scheduler-logs/` | ~10 KB | 7 | Free - evidence trail only; spend and run rows live in Postgres |
| `gloss-batch-mo/`, `gloss-batch-usc/` | ~14 MB | 10 | $0 today (both runs finished 2026-08-21) - `state.json` is cost-bearing only while a run is in flight; `excerpts.json` is free but slow to re-bank |
| `openstates-people/` | ~850 KB | 193 | Free - CC0 copy of `openstates/people` `data/mo/legislature/` |
| `scheduled-summaries-task.xml` | 3 KB | 1 | Free - the registered Windows task is the live copy; re-export with `schtasks /query /xml` |

---

## `legiscan-texts/` - 3,177 cached `getBillText` responses (859 MB)

**The extracted text is already safe** - it lives in the `bill_texts` table in Supabase already.
Losing this cache does **not** lose any bill text the site serves. (Run `npm run status` for the
current row count - do not hand-type it here; see the note at the bottom of this file for why.)

What the cache protects is **LegiScan's Rule 7**: *"Document blobs (getBillText etc.) are downloaded
at most once per doc_id."* The cache is the mechanism that enforces it -
`src/cli/ingest-legiscan-texts.js` checks `existsSync(docCachePath(docId))` before every query, and
a cached doc is never re-fetched.

**If this cache is lost**, re-running the text ingest would re-query up to 3,177 doc_ids: ~10.6% of
the 30,000/month quota, and a second download of documents the terms say are downloaded once. It
would not be a *deliberate* violation, but it is exactly the outcome the rule exists to prevent.

**If you must rebuild:** don't, unless you actually need texts the DB lacks. Query `bill_texts`
first - a bill whose text is already stored needs nothing. If a rebuild is genuinely required, run
with `--limit` in small batches and watch `queries_used` in `ingestion_runs`.

## `legiscan-datasets/` - one decoded dataset per MO session, 31 sessions (~111 MB / 34 files on 2026-08-23)

Every MO session 2010-2026. These drive the bill/roll-call/person ingestion and the bill-text
planner (`state_link` and `doc_id` both come from here).

**Rule 2 is suspension-level:** *"dataset_hash comparison is MANDATORY before any getDataset
download - failure to do so will result in suspended access."* The stored hash lives in the
`legiscan_datasets` table, not in these files - so a rebuild must compare against the DB, exactly as
`src/cli/ingest-legiscan.js` already does. Do not shortcut this.

Rebuild cost: one `getDataset` per session - 31 ledger rows in `legiscan_datasets` (2010 Regular ->
2026, live-counted 2026-08-23) - plus a `getDatasetList`, gated by the hash check.

The directory holds more FILES than sessions, and that is normal: each weekly re-fetch of the
current session lands under a new `<session>-<dataset_hash>.json` name (four `2239-*.json` files
on 2026-08-23, one per hash change since 2026-07-29; every other session has exactly one file), and
**only the file named in `legiscan_datasets.local_cache_path` is live** - `src/cli/ingest-legiscan.js`
reads that path and re-verifies the file's own `hash.md5` against the ledger row before trusting
it. Older hash files are safe to delete and do not count toward rebuild cost. *(Superseded
2026-08-23: the earlier note here - "a new session dataset landed 2026-08-02, growing this cache
from 31 files to 32 - the count is live, not a typo" - misread this effect: the 32nd file was a
re-hashed copy of the current session 2239, not a 32nd session; the ledger has had 31 rows
throughout. The first table's row above still carries that 32-file count - it was edited into
the 2026-07-31 snapshot on 2026-08-03, commit 482c1bd.)*

## `congress-legislators/` - the CC0 real-dates dataset (15 MB)

`legislators-current.json` + `legislators-historical.json` from
<https://unitedstates.github.io/congress-legislators/>. Public domain, no key, no rate limit.
Powers real federal term dates (the source that replaced a synthesized-date approach proven wrong -
see the `CHATLOG.md` entry "2026-07-30 (evening) - the public site, built end-to-end in a day",
where the Jan-3 date synthesis was proven false against Payne's real service; corrected 2026-08-23:
this sentence used to cite `PLAYBOOK_DELTA.md` and "the 2026-07-31 CHATLOG entry" - the PLAYBOOK
never carried that lesson, and the entry is dated 07-30). Just re-download.

## MO primary-source caches (~900 KB total)

Journals, bill lists, roll-call PDFs and rosters from house.mo.gov / senate.mo.gov. All free and
public - but **house.mo.gov's published ToU caps automated pulls at once per 30 minutes**, which is
mechanically enforced by `MO_HOUSE_MIN_INTERVAL_MS` / `MO_SENATE_MIN_INTERVAL_MS`. A full rebuild is
therefore slow by design, not by accident. **Do not lower that interval** - both constants are a
MINIMUM gap between fetches (`createLimiter({ minIntervalMs })`, 30 min); raising one only makes
pulls rarer, lowering one is the ToU violation. *(Corrected 2026-08-23: from 2026-07-31 this line
read "Do not raise that interval," which inverted the rule; `docs/CONTROLLER_BRIEFING.md`'s "MO
30-minute cadence" paragraph still quotes that old wording verbatim.)*

Note: `mo-senate-journals/*.failed.json` files carry the quarantine state (a day that failed parsing
3+ times is held out of the published record). Losing them resets the quarantine count that
`public_freshness` reports - the data isn't wrong, but the "N days pending human review" number the
trust page shows would restart from zero until those days fail again.

Note on `mo-rollcalls/`: despite the name, this is **not** a cache of raw PDF bytes - it holds JSON
artifacts of already-extracted, already-reconciled roll-call casts, kept on disk by
`persistRollCallCasts` / `replayArtifacts` (`src/cli/ingest-mo-house.js`) whenever a roll call's
casts can't be fully resolved against the legislator roster, plus (same convention as
`mo-senate-journals`) `*.failed.json` quarantine markers for a PDF that fails parsing
`ROLLCALL_MAX_FAILED_ATTEMPTS` (3) times. Losing a file here loses replay-queue state, never
committed `vote_casts` rows (those are already in Supabase) - but rebuilding it (re-fetch the PDF,
30-min ToU, re-extract) does **not** buy back more data than before: the 2026-08-03 accuracy audit
found the real bottleneck is structural, not a cache problem. `persistRoster` seeds exactly one real
legislator (a leftover test fixture) against which every roll-call PDF resolves, so this adapter
specifically resolves casts for only that one legislator regardless of how many times this cache is
rebuilt - directly visible in the one artifact on disk here as of this writing (157 of ~163 casts
still unresolved on last replay). **Correction, 2026-08-05:** this does NOT mean ~162 of 163 MO
House members show zero MO House votes on their profile - live-verified all 159 current members
have real MO House votes via LegiScan's independent, comprehensive coverage of the same bills; only
this one narrow adapter's own contribution is capped. Investigated end-to-end and resolved - see
`TODO.md` NOW ("MO House per-legislator vote coverage") for the full evidence; decision was ship
as-is, no site caveat needed.

Note on `scheduler-logs/`: also lives under `.superpowers/artifacts/` but isn't a source cache in
the sense the rest of this file describes - it's the background scheduler's own daily tick log
(gitignored, one entry per invocation), not a rate-limited or ToU-bound fetch. Nothing here is
rule-bound to preserve; losing it only loses the tick-history evidence trail. See
`docs/SCHEDULED_INGESTION.md` for what it records and why.

---

## Added 2026-08-23 - scheduler, batch-run and wave state (the second table)

None of these is a rate-limited or ToU-bound fetch. The question for each is different from the
source caches above: not "what does re-fetching cost" but "what does the next tick or the next run
do if this is gone." The published record - summaries, verifications, glosses, run rows, spend -
is in Supabase in every case.

### `scheduled-summaries/` - the daily 6 AM scheduler's own state (`scripts/scheduled-summaries.js`)

- **`overflow-parks.json` - cost-bearing, added 2026-11-06.** `bill_id@texthash16` -> the stage, the
  token limit it hit, and when. Losing it costs one paid re-attempt per entry, because each bill is
  re-authored and discarded once before being re-recorded. Never merge-write it after a failed read:
  the scheduler refuses and logs instead, because clobbering it silently re-enables paid retries of
  every bill in it. Distinct from `parked.json` in meaning - self-expiring and machine-managed, not
  a human judgement; `src/lib/overflow-parks.js` has the reasoning.
- **`parked.json` - cost-bearing.** The park list (`bill_id` -> reason, kept as an editable file on
  purpose; `docs/SCHEDULED_SUMMARIES.md` "Unparking a bill"). A parked bill is never attempted
  again. If the file is lost, the parked bills re-enter the lanes on the next tick - a
  drain-parked bill has a draft + verifications on file, so it lands in the conversion lane,
  whose oldest-flagged-first order puts it at the FRONT of the paid queue (on the 2026-08-17
  seeding dry-run, 8 of the 27 then-parked bills were already sitting in the next tick's lanes:
  2,269 -> 2,261 - CHATLOG 2026-08-17). So the loss is paid re-attempts of bills that already
  failed three supervised attempts each, bounded by the $1/tick + $5/ISO-week ledger and, per
  tick, by the lane's own limits (`assembleTick` skips a conversion with ≥2 recorded rejections;
  at most 50 oldest drafts are examined per tick). Recovery: 28 of the 31 entries (2026-08-23)
  are the drain lane's PARKED set (28 ids in `scripts/build-drain-wave.mjs`), re-seeded at $0 by
  `node scripts/seed-scheduler-parks.mjs` (merge-safe, idempotent; the script and the set it
  reads are both committed). The other 3 were parked by the scheduler's own 2026-08-19 tick
  (`MalformedSummaryError`: "completeness check ... is malformed - the checker's own output
  cannot be trusted") and exist ONLY here - that day's `summary-scheduler-logs/` line carries no
  park information at all, the tick's `ingestion_runs` row only the COUNT (`parked: 3`), and
  `CHATLOG.md` names none of them - so if the file is lost, let the ledger absorb one more
  attempt each.
- **`stages/` - cost-bearing, bounded.** Per-bill, per-stage checkpoints keyed
  `<bill_id>-<hash8>` (`src/lib/billed-summary-chain.js`: *"every completed (paid) stage persists
  immediately; a re-run loads the checkpoint and never re-pays for a stage it already has"*). A
  bill whose chain completed is already recorded in the DB, so its checkpoint is residue; a bill
  interrupted mid-chain (billing error, timeout) would re-pay its completed stages on the next
  attempt if its checkpoint is gone. The hash in the key means a text revision invalidates the
  checkpoint by design.
- **`records-*.json` - paper trail.** One file per lane per tick that had results to record
  (`records-<run_id>-fresh.json`; a `-drafts` suffix for the conversion lane): the envelopes
  handed to `src/cli/summary-queue.js record`. Once recorded, `summaries` /
  `summary_verifications` hold the outcome and `ingestion_runs` holds the run row.

### `summary-scheduler-logs/` - free

One file per day since 2026-08-17, one line per tick - the same role `scheduler-logs/` plays for
the ingestion scheduler. Weekly spend, tick status and published counts are answered from Postgres
by `npm run status`, not from these files; losing them loses only the human-readable trail (a
tick line carries counts and spend, never bill ids - the 3 scheduler-added park ids above live
nowhere but `parked.json`).

### `gloss-batch-mo/`, `gloss-batch-usc/` - the glossary Batch-API drains (`scripts/gloss-batch-mo.mjs`)

**A THIRD MO RUN COMPLETED 2026-10-20** (2026-08-21: MO 1,217 glosses for $12.45; USC 525 for
$8.31 - PLAYBOOK 41-44). The 2026-10-20 MO run: **958 candidates, 919 fetched free, 930 authored,
737 verified clean, $7.682 of a $15 cap, 0 author failures, 1 verify failure.** Then
`src/cli/auto-publish-glossary.js` published **737 of 737, 0 failed**, taking the glossary from
1,850 to 2,587 of 5,096 glossable (36.3% -> 50.8%). Rate **$0.0104 per published gloss**, against
the 2026-08-21 run's $0.0102 - the economics are stable across two months.

**THE DRAIN IS TWO STEPS AND ONLY THE FIRST IS THIS RUNNER.** It authors, verifies and persists
DRAFTS; it publishes nothing. Forgetting `auto-publish-glossary` is silent - on 2026-10-20 the run
reported `glossed_clean: 737` while `npm run status` still showed `glossary published 1,850`, with
no error anywhere. `glossed_clean` means "the verifier cleared it", not "it is live". PLAYBOOK 75.

**The 10-minute bot-page cooldown is GONE from the MO path, replaced by a control probe
(2026-10-20).** revisor.mo.gov serves the same bot page for an unpublished section and for a
throttled client; the old code slept 10 minutes per section to tell them apart, measured at ~110
minutes to rule out TEN sections. A known-good control section (`RSMo 1.010`, TTL 60s) settles it in
one 5s request. First sweep: **31 parks, all no-cooldown, zero fallbacks, ~5.2 hours of sleeping
avoided.** Parking requires a CLEAN control fetch as positive proof of service; every ambiguous
outcome falls back to the old cooldown path. **USC runs deliberately keep the old behaviour** - those
citations resolve against a different host, so an RSMo control would be meaningless. PLAYBOOK 68.

The published glosses are in the DB; each run has its `ingestion_runs` row with `spent_usd` in the
detail. What is on disk:

- **`excerpts.json`** - the bank of fetched statute excerpts (revisor.mo.gov at 5-second pacing
  with a bot-page cooldown; uscode.house.gov for USC). Free to re-fetch, slow to re-bank (the MO
  sweep was ~1,500 pages over ~2 hours), and it is the input lesson 44's cost projection reads
  before any batch is submitted - a reopened drain should project from this file, never from a
  per-term rate.
- **`state.json`'s `parked` array is NOT the authoritative park record** (learned 2026-10-20). It
  is a PER-PASS list and it resets whenever `--resume` is omitted: one pass reported 15 parks where
  the database held 109. **The database is the truth** - `glossary_notes` rows whose note begins
  `parked by gloss-batch`, counted as distinct `term_id`. Parked terms are excluded from candidates
  by their `glossary_terms.status` regardless, so the array is belt-and-braces, not a ledger.
- **`state.json` - cost-bearing only while a run is in flight.** The run ledger: Batch API batch
  ids per phase, parked terms, fetch failures, `spentUsd`. `--resume` reads the batch ids from
  it; the runner's `loadJson` falls back to an EMPTY ledger if the file is missing, so a resumed
  run with no `state.json` would submit every phase again as a new billed batch while the original
  batches keep running and keep being charged. With no run in flight (the case today) losing it
  costs nothing but a local copy of the spend record.
- **`runner.pid`, `run.log`, `run.err`** - the PID written at launch (lesson 43: stop by PID,
  confirm liveness by whether `state.json` keeps moving) and the runner's console output.

### `wave3/` - the summary-wave working directory (`docs/RUNBOOK_SUMMARY_WAVES.md`)

The drain lane ran to empty 2026-08-22 and the scheduler owns summaries now, so this is mostly
historical working state:

- `manifest.json` + `bills/*.txt` (~1,100 files, ~32 MB) - per-bill texts exported from
  `bill_texts` by `scripts/export-summary-wave.mjs`, hash-pinned at export. $0 to re-export.
- `records-*.json` (~110) - wave result envelopes fed to `src/cli/summary-queue.js record`; recorded
  outcomes are in the DB.
- `reauthor-<WAVE>-<bill_id>.json` - pointer-mode priors (the lesson-40 file-pointer pattern),
  rebuilt at $0 by `scripts/build-drain-wave.mjs --pointer` from `summaries` +
  `summary_verifications`.
- **`api-stages/<bill_id>.json` (~310) - the only money here.** Author/check checkpoints banked
  by the billed `scripts/summary-probe-api.mjs` runs of 2026-08-07 (night, the $2 Haiku probe -
  239 files) and 2026-08-09 (the current-session campaign - 72 files); a few dollars in total,
  the exact spend is in `CHATLOG.md`. Losing them means that authoring would have to be bought
  again if those bills were ever drained via the hybrid path - and the runbook's measured yield
  for that path was 1 of 40 (wave C 0/20, wave D 1/20), so the practical loss is small.
- `bs-stages/` - 4 stage checkpoints of the same author/provisions/verify shape for two bills
  (three stages of one, one of the other), left by a partial retry of drain wave BS on the
  morning of 2026-08-14 (`CHATLOG.md`: "correct shape, honest verdicts, never recorded,
  harmless"); no script references this directory today. Plus assorted one-off working files
  (`export-batch.mjs`, `api-skip-owned.json`, `db-summary-billids.json`, ...).

### `openstates-people/` - free (CC0)

`mo-legislature/*.yml` (192 files) + `manifest.json` (`{ source, path, commit, retrieved, count }`): a
copy of `data/mo/legislature/` from the `openstates/people` GitHub repo (CC0-1.0), read by
`src/cli/backfill-mo-term-dates.js`, which refuses to apply without the manifest's commit SHA
because the SHA goes into each term's citation. Re-fetch is a `git clone` - no key, no rate
limit; the exact commands are in
`docs/superpowers/plans/2026-08-06-mo-current-term-dates-backfill.md`. A fresh clone is a NEWER
commit, so a re-run would cite a different SHA; the term dates already applied keep the citation
they were applied with.

### `scheduled-summaries-task.xml` - free

The exported Windows Task Scheduler definition (UTF-16) for **"VisibleGov Scheduled Summaries"**.
It exists because re-creating from exact XML (`schtasks /create /xml ... /f`) was the only route
that turned `StartWhenAvailable` on (2026-08-17 - the GUI and `Set-ScheduledTask` both fail
re-validating the task as stored, the cmdlet's error naming the raw-SID `UserId`;
`docs/SCHEDULED_SUMMARIES.md` "Registering it"). The registered task is
the live copy: re-export it with `schtasks /query /tn "VisibleGov Scheduled Summaries" /xml`.
Re-registration is Lance's step - an agent never runs `schtasks`. The ingestion task
("VisibleGov Scheduled Ingestion") has no XML on disk; it was registered with `schtasks /create
/tr ...` per `docs/SCHEDULED_INGESTION.md`.

### Reconstructible from where - the short version

- **From git + the DB at $0:** `parked.json`'s seeded entries (`seed-scheduler-parks.mjs`),
  `wave3/` except `api-stages/`, `openstates-people/` (re-clone), the task XML (re-export).
- **From `ingestion_runs` / Postgres:** every run row and every dollar spent (scheduler ticks and
  gloss runs alike) - the logs under `*-logs/` are a convenience copy.
- **Not reconstructible - re-paid or re-done instead:** `scheduled-summaries/stages/` and
  `wave3/api-stages/` (paid checkpoints), the 3 scheduler-added park entries (only their count
  survives, in the run row), and a `gloss-batch-*/state.json` lost mid-run (re-submission risk;
  none in flight as of 2026-08-23).

---

## What is genuinely irreplaceable (and therefore IS in git)

- `.superpowers/sdd/**/*.md` - 128 ledgers, briefs and reports (grown from the 105 on hand at the
  2026-07-31 commit; all still git-tracked, most recently as of 2026-08-02): every ruling, review
  finding, fix round and accepted residual, with the reasoning behind it. **First committed
  2026-07-31**, additions since have kept landing in the same commits as the work they document.
- `CHATLOG.md`, `TODO.md`, `PLAYBOOK_DELTA.md`, `README.md`, `CLAUDE.md` - the decision trail.
- `docs/superpowers/specs/`, `docs/superpowers/plans/` - the approved designs.
- `supabase/migrations/` - the schema, 0001-0034 (plus the out-of-sequence `0018a_refresh_timeout.sql`),
  **35 files total, all applied live** (0001-0031 +0018a verified 2026-08-05; `0032` applied
  2026-08-23; `0033_retracted_votes.sql` and `0034_bill_page_indexes.sql` applied 2026-08-26).
  `TODO.md`'s RESUME HERE block is the live source of truth if this drifts again.
- **Vote-integrity toolchain (built 2026-08-26, after the adversarial audit).** Read
  `src/lib/source-url-granularity.js` FIRST - it is the shared judgement about what a `source_url`
  proves, and both the detector and the guard depend on it:
  - `src/lib/source-url-granularity.js` - declares, per URL shape, whether a url names ONE vote or
    is a CONTAINER holding many. Unknown shapes default to CONTAINER (the permissive answer).
    Also holds `assessSessionDateViolation` (a vote cannot predate its own session) and
    `identifierFromQuestion`.
  - `src/lib/same-source-dedup.js` - when two rows from the SAME adapter are one vote. Deliberately
    strict; its comments argue each condition against the real case that defeated the weaker rule.
  - `scripts/find-misattributed-votes.mjs` - READ ONLY. Emits a full retraction manifest with a
    per-group confidence rating. `--plan-json` prints the exact rows for another tool to execute.
  - `scripts/retract-misattributed-votes.mjs` - dry-run by default; refuses unless 0033 is applied;
    tombstones and VERIFIES before deleting anything.
  - `scripts/dedup-same-source-votes.mjs` - dry-run by default; `--prune` re-derives the rule and
    removes pairings it no longer confirms (this exists because an earlier version of the rule was
    applied and 17 of its 38 pairs were false).
  - `scripts/preflight.mjs` - SessionStart hook; checks required MCP servers AND the out-of-process
    binaries plugins need. See `docs/MCP_REQUIREMENTS.md`.
  - `src/lib/pg.js` + `scripts/verify-pg.mjs` - a direct-Postgres READ-ONLY fallback, currently
    INERT (no `SUPABASE_DB_URL`, and no database password has ever been created). Kept because MCP
    auth drops; never for writes, never in `site/`.
- `tests/fixtures/` - captured real payloads (incl. the LegiScan API manual PDF the status codebook
  was extracted from, and the congress-legislators excerpts).

## What is NOT on disk anywhere but Supabase

The live database is the system of record for all ingested data - vote casts, bills, bill texts,
sponsorships, legislator rows, and the whole plain-language layer.

> **Live numbers: run `npm run status`.** No count is hand-typed into this file - a prior version
> of this doc (and of `README.md`) carried "1,465,102 vote casts," which turned out to be the sum
> of a stale materialized view (`public_position_totals`), not the live `vote_casts` table; the gap
> grew with every cron tick and nobody could trace where the number came from. `docs/DATA_INVENTORY.md`
> is the source of truth for what each number *means* and how the tables relate; `scripts/data-status.js`
> (via `npm run status`) is the only source of truth for what they currently *are*.

**The repo can rebuild the pipelines; it cannot rebuild the database.** Supabase's own backups are
the safety net - worth confirming they're enabled and retained. *(2026-08-23: the Supabase
organization is on the **Pro** plan - live-verified through the management API - the tier Supabase
documents as carrying daily automated backups; retention has NOT been confirmed in the dashboard,
so that half of the item stays open. The written recovery path is `docs/DISASTER_RECOVERY.md`,
which rebuilds from the public sources and deliberately relies on no backup restore - read the two
together: a restore, if one exists, is the fast path; re-ingestion is the documented one.)*

## Who quotes this file (update them when this changes)

- `docs/CONTROLLER_BRIEFING.md`, "MO 30-minute cadence" paragraph - quotes the interval directive
  verbatim (still the old inverted "Do not raise" wording as of 2026-08-23).
- `TODO.md`, the 2026-08-22 "docs/ refresh debt" inbox item - tracked this doc's table-omission
  debt (the second table above closes it, 2026-08-23).
- `.gitignore` header comment - carries its own size figure ("~959M") and points here for the
  cost of re-fetching.
- `docs/DISASTER_RECOVERY.md` - the rebuild-from-sources runbook; it does not link here yet.
