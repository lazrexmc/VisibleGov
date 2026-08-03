# Cached artifacts — what's on disk, what it costs to lose

`.superpowers/artifacts/` holds ~969 MB of cached source payloads. It is **gitignored and lives on
one local disk**. This file exists so that if it is ever lost, the next person knows exactly what
they're rebuilding, what it costs, and what rules bind the rebuild.

Written 2026-07-31 (Lance: *"Preserve all info"*). Nothing here is irreplaceable — the synthesized
reasoning is in `.superpowers/sdd/**/*.md`, which IS in git. This is all re-fetchable. Some of it is
just expensive or rule-bound to re-fetch.

| Cache | Size | Files | Replaceable? |
|---|---|---|---|
| `legiscan-texts/` | 859 MB | 3,177 | ⚠️ **Costly + rule-bound** — see below |
| `legiscan-datasets/` | 94 MB | 32 | ⚠️ Rule-bound (suspension-level) |
| `congress-legislators/` | 15 MB | 2 | ✅ Free — public CC0 download |
| `mo-senate-journals/` | 93 KB | 81 | ✅ Free, but slow (30-min ToU) |
| `mo-bills/`, `mo-bill-list/`, `mo-rollcalls/` | 771 KB | 153 | ✅ Free, but slow (30-min ToU) — mo-rollcalls' rebuild ceiling is capped by a roster gap, not by cost; see note below |
| `mo-senate-journal-index/`, `mo-senate-roster/` | 44 KB | 4 | ✅ Free |
| `scheduler-logs/` | ~700 KB | 3 | ✅ Free, but not a source cache — see note below |

---

## ⚠️ `legiscan-texts/` — 3,177 cached `getBillText` responses (859 MB)

**The extracted text is already safe** — it lives in the `bill_texts` table in Supabase already.
Losing this cache does **not** lose any bill text the site serves. (Run `npm run status` for the
current row count — do not hand-type it here; see the note at the bottom of this file for why.)

What the cache protects is **LegiScan's Rule 7**: *"Document blobs (getBillText etc.) are downloaded
at most once per doc_id."* The cache is the mechanism that enforces it —
`src/cli/ingest-legiscan-texts.js` checks `existsSync(docCachePath(docId))` before every query, and
a cached doc is never re-fetched.

**If this cache is lost**, re-running the text ingest would re-query up to 3,177 doc_ids: ~10.6% of
the 30,000/month quota, and a second download of documents the terms say are downloaded once. It
would not be a *deliberate* violation, but it is exactly the outcome the rule exists to prevent.

**If you must rebuild:** don't, unless you actually need texts the DB lacks. Query `bill_texts`
first — a bill whose text is already stored needs nothing. If a rebuild is genuinely required, run
with `--limit` in small batches and watch `queries_used` in `ingestion_runs`.

## ⚠️ `legiscan-datasets/` — 32 weekly session ZIPs (94 MB)

Every MO session 2010–2026. These drive the bill/roll-call/person ingestion and the bill-text
planner (`state_link` and `doc_id` both come from here).

**Rule 2 is suspension-level:** *"dataset_hash comparison is MANDATORY before any getDataset
download — failure to do so will result in suspended access."* The stored hash lives in the
`legiscan_datasets` table, not in these files — so a rebuild must compare against the DB, exactly as
`src/cli/ingest-legiscan.js` already does. Do not shortcut this.

Rebuild cost: ~32 `getDataset` queries plus a `getDatasetList`, gated by the hash check. (A new
session dataset landed 2026-08-02, growing this cache from 31 files to 32 — the count is live, not
a typo carried from an earlier version of this doc.)

## ✅ `congress-legislators/` — the CC0 real-dates dataset (15 MB)

`legislators-current.json` + `legislators-historical.json` from
<https://unitedstates.github.io/congress-legislators/>. Public domain, no key, no rate limit.
Powers real federal term dates (the source that replaced a synthesized-date approach proven wrong —
see `PLAYBOOK_DELTA.md` and the 2026-07-31 CHATLOG entry). Just re-download.

## ✅ MO primary-source caches (~900 KB total)

Journals, bill lists, roll-call PDFs and rosters from house.mo.gov / senate.mo.gov. All free and
public — but **house.mo.gov's published ToU caps automated pulls at once per 30 minutes**, which is
mechanically enforced by `MO_HOUSE_MIN_INTERVAL_MS` / `MO_SENATE_MIN_INTERVAL_MS`. A full rebuild is
therefore slow by design, not by accident. Do not raise that interval.

Note: `mo-senate-journals/*.failed.json` files carry the quarantine state (a day that failed parsing
3+ times is held out of the published record). Losing them resets the quarantine count that
`public_freshness` reports — the data isn't wrong, but the "N days pending human review" number the
trust page shows would restart from zero until those days fail again.

Note on `mo-rollcalls/`: despite the name, this is **not** a cache of raw PDF bytes — it holds JSON
artifacts of already-extracted, already-reconciled roll-call casts, kept on disk by
`persistRollCallCasts` / `replayArtifacts` (`src/cli/ingest-mo-house.js`) whenever a roll call's
casts can't be fully resolved against the legislator roster, plus (same convention as
`mo-senate-journals`) `*.failed.json` quarantine markers for a PDF that fails parsing
`ROLLCALL_MAX_FAILED_ATTEMPTS` (3) times. Losing a file here loses replay-queue state, never
committed `vote_casts` rows (those are already in Supabase) — but rebuilding it (re-fetch the PDF,
30-min ToU, re-extract) does **not** buy back more data than before: the 2026-08-03 accuracy audit
found the real bottleneck is structural, not a cache problem. `persistRoster` seeds exactly one real
legislator (a leftover test fixture) against which every roll-call PDF resolves, so ~162 of ~163 MO
House members permanently show zero MO House votes regardless of how many times this cache is
rebuilt — directly visible in the one artifact on disk here as of this writing (157 of ~163 casts
still unresolved on last replay). Still open, deliberately left for Lance's call — see `TODO.md` NOW
("MO House per-legislator vote coverage").

Note on `scheduler-logs/`: also lives under `.superpowers/artifacts/` but isn't a source cache in
the sense the rest of this file describes — it's the background scheduler's own daily tick log
(gitignored, one entry per invocation), not a rate-limited or ToU-bound fetch. Nothing here is
rule-bound to preserve; losing it only loses the tick-history evidence trail. See
`docs/SCHEDULED_INGESTION.md` for what it records and why.

---

## What is genuinely irreplaceable (and therefore IS in git)

- `.superpowers/sdd/**/*.md` — 128 ledgers, briefs and reports (grown from the 105 on hand at the
  2026-07-31 commit; all still git-tracked, most recently as of 2026-08-02): every ruling, review
  finding, fix round and accepted residual, with the reasoning behind it. **First committed
  2026-07-31**, additions since have kept landing in the same commits as the work they document.
- `CHATLOG.md`, `TODO.md`, `PLAYBOOK_DELTA.md`, `README.md`, `CLAUDE.md` — the decision trail.
- `docs/superpowers/specs/`, `docs/superpowers/plans/` — the approved designs.
- `supabase/migrations/` — the schema, 0001–0025 (plus the out-of-sequence `0018a_refresh_timeout.sql`).
  Not all are applied to the live DB yet — file presence in git tracks the design, not deploy state;
  `TODO.md` NOW is the source of truth for which migrations are actually live.
- `tests/fixtures/` — captured real payloads (incl. the LegiScan API manual PDF the status codebook
  was extracted from, and the congress-legislators excerpts).

## What is NOT on disk anywhere but Supabase

The live database is the system of record for all ingested data — vote casts, bills, bill texts,
sponsorships, legislator rows, and the whole plain-language layer.

> **Live numbers: run `npm run status`.** No count is hand-typed into this file — a prior version
> of this doc (and of `README.md`) carried "1,465,102 vote casts," which turned out to be the sum
> of a stale materialized view (`public_position_totals`), not the live `vote_casts` table; the gap
> grew with every cron tick and nobody could trace where the number came from. `docs/DATA_INVENTORY.md`
> is the source of truth for what each number *means* and how the tables relate; `scripts/data-status.js`
> (via `npm run status`) is the only source of truth for what they currently *are*.

**The repo can rebuild the pipelines; it cannot rebuild the database.** Supabase's own backups are
the safety net — worth confirming they're enabled and retained.
