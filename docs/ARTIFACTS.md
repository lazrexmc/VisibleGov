# Cached artifacts — what's on disk, what it costs to lose

`.superpowers/artifacts/` holds ~959 MB of cached source payloads. It is **gitignored and lives on
one local disk**. This file exists so that if it is ever lost, the next person knows exactly what
they're rebuilding, what it costs, and what rules bind the rebuild.

Written 2026-07-31 (Lance: *"Preserve all info"*). Nothing here is irreplaceable — the synthesized
reasoning is in `.superpowers/sdd/**/*.md`, which IS in git. This is all re-fetchable. Some of it is
just expensive or rule-bound to re-fetch.

| Cache | Size | Files | Replaceable? |
|---|---|---|---|
| `legiscan-texts/` | 859 MB | 3,177 | ⚠️ **Costly + rule-bound** — see below |
| `legiscan-datasets/` | 85 MB | 31 | ⚠️ Rule-bound (suspension-level) |
| `congress-legislators/` | 15 MB | 2 | ✅ Free — public CC0 download |
| `mo-senate-journals/` | 81 KB | 69 | ✅ Free, but slow (30-min ToU) |
| `mo-bills/`, `mo-bill-list/`, `mo-rollcalls/` | ~720 KB | 115 | ✅ Free, but slow (30-min ToU) |
| `mo-senate-journal-index/`, `mo-senate-roster/` | 44 KB | 4 | ✅ Free |

---

## ⚠️ `legiscan-texts/` — 3,177 cached `getBillText` responses (859 MB)

**The extracted text is already safe** — it lives in the `bill_texts` table in Supabase (3,630
rows). Losing this cache does **not** lose any bill text the site serves.

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

## ⚠️ `legiscan-datasets/` — 31 weekly session ZIPs (85 MB)

Every MO session 2010–2026. These drive the bill/roll-call/person ingestion and the bill-text
planner (`state_link` and `doc_id` both come from here).

**Rule 2 is suspension-level:** *"dataset_hash comparison is MANDATORY before any getDataset
download — failure to do so will result in suspended access."* The stored hash lives in the
`legiscan_datasets` table, not in these files — so a rebuild must compare against the DB, exactly as
`src/cli/ingest-legiscan.js` already does. Do not shortcut this.

Rebuild cost: ~31 `getDataset` queries plus a `getDatasetList`, gated by the hash check.

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

---

## What is genuinely irreplaceable (and therefore IS in git)

- `.superpowers/sdd/**/*.md` — 105 ledgers, briefs and reports: every ruling, review finding, fix
  round and accepted residual, with the reasoning behind it. **Committed 2026-07-31.**
- `CHATLOG.md`, `TODO.md`, `PLAYBOOK_DELTA.md`, `README.md`, `CLAUDE.md` — the decision trail.
- `docs/superpowers/specs/`, `docs/superpowers/plans/` — the approved designs.
- `supabase/migrations/` — the schema, 0001–0020.
- `tests/fixtures/` — captured real payloads (incl. the LegiScan API manual PDF the status codebook
  was extracted from, and the congress-legislators excerpts).

## What is NOT on disk anywhere but Supabase

The live database is the system of record for all ingested data — roughly 1.47M vote casts, 38k
bills, 3.6k bill texts, 46k sponsorships and 1,607 legislator rows, plus the whole plain-language
layer. For exact current numbers run `npm run status`; do not trust counts written here, since an
ingestion cron writes every 30 minutes.

**The repo can rebuild the pipelines; it cannot rebuild the database.** Supabase's own backups are
the safety net — worth confirming they're enabled and retained.
