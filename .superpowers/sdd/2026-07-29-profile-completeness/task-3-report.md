# Task 3 report — federal fetch pass (sponsors + status + texts + member metadata)

**Status:** complete (code + fixtures + dry-run). Live pass is controller-operated (Task 6), per
the brief's own framing — no live write was performed by this task.

**Commit SHA(s):** `ddd500e` (branch `profile-completeness`)

**Test summary:** 1110/1110 green, bare `node --test` (1070 baseline + 40 new: 4 in
`tests/us-congress.test.js` [sponsor parsing + the new unfiltered member-page fixture], 36 in
`tests/enrich-federal-bills-cli.test.js`). Zero live DB writes and zero live network calls from
tests — every DB-facing function is exercised via a fake client + injected loader/fetch functions
(mirrors `backfill-mo-bill-meta-cli.test.js`'s convention exactly); one test bug during
development did let a real `us.fetchBillDetail` call slip through (caught by the resulting live
403 in the test output, fixed before commit by pre-satisfying the sponsor index in that test's
deps — noted here for the honesty record, not hidden).

## Fixture capture log

2 live, polite requests to `api.congress.gov` (existing `X-Api-Key` header discipline, spaced
~4s apart, well under the existing `congressLimiter`'s 3.6s floor):

1. `GET /v3/bill/119/hr/845` — a second real bill detail (HR 845, already referenced elsewhere in
   this repo's `goldens/HR-845.json`), to prove `parseBillDetail`'s new `sponsors` extraction
   generalizes beyond the single already-committed `bill-detail.json` (HR 498) fixture. Saved as
   `tests/fixtures/us-congress/bill-detail-hr845.json`.
2. `GET /v3/member?limit=20&offset=0` — the actual unfiltered-roster endpoint
   `enrich-federal-bills.js`'s member-metadata step pages through (distinct from the existing
   state-filtered `members-mo.json` fixture), to prove `parseMemberList` against its real shape
   and to get real edge-case coverage (freshly-elected 2026 members with no `endYear`, several
   fully-historical members). Saved as `tests/fixtures/us-congress/member-page-unfiltered.json`.

Both files grepped clean of key-shaped material (`api_key`/`token`/`secret`/`bearer`) before
committing — Congress.gov never echoes the key back in a response body.

## Design decisions worth flagging

- **Sponsors, not cosponsors.** Congress.gov's bill-detail response embeds `sponsors[]` (the
  official introducing sponsor(s)) directly, but only a *count+url* for `cosponsors` (a separate
  sub-resource, its own per-bill request). Fetching cosponsors was out of scope — it would double
  this pass's request volume for a field the brief doesn't ask for — so every federal sponsor
  written by this pass has `sponsor_type: 'primary'`; no `'cosponsor'` rows will ever come from
  this source. (MO's LegiScan sponsors, from Task 2, already cover the cosponsor case for that
  jurisdiction.)
- **Text-already-exists check is bill-level, not version-level.** `loadTextIndex` treats "this
  bill has at least one `bill_texts` row" as "done" — coarser than `summarize.js`'s own
  `ensureText` (which tracks per-`version_type` existence). Deliberate: this pass's job is making
  sure a bill has *some* text on file at all; per-version-type bookkeeping over time stays
  `summarize.js`'s concern, not duplicated here.
- **Photo URL — confirmed settled, nothing written.** Per the brief's own ruling, a bioguide photo
  URL is derivable from `bioguide_id` at render time; no column added, nothing written to
  `legislators.image_url`. Worth noting for whoever builds the render layer: the live member-page
  fixture capture found the derivation is **not perfectly uniform** — most members'
  `imageUrl` is exactly `{bioguide_id.toLowerCase()}_200.jpg`, but Bob Onder's (in the
  already-committed `members-mo.json`) is a non-bioguide-shaped asset id. A pure mechanical
  formula will occasionally miss; that's a render-time best-effort concern, consistent with the
  decision to keep it out of the DB.
- **Durable resumable progress is DB-keyed, not a separate artifact file.** Every invocation
  recomputes its worklist from current DB state via `selectAll`; all writes are additive
  (`insertIfAbsent` / `additivePatch` / fills-null UPDATE), so a bill or member already fully
  enriched costs zero further fetches on the next run. This mirrors every other bulk CLI already
  in this codebase (`backfill-mo-bill-meta.js`, `ingest-legiscan.js`'s hash-gated re-processing)
  rather than inventing a parallel checkpoint file, per the brief's own "(artifact or DB-keyed)"
  wording.
- **`--dry-run` makes zero live fetches, stricter than the `us-senate` dry-run precedent** (which
  still hits senate.gov for its vote menu). Member-metadata ensure is therefore LIVE-ONLY and
  reported as "not evaluated" in dry-run mode; only the bill-worklist side (computed purely from
  bulk DB reads) is planned.

## Live dry-run (read-only, `node --env-file=.env src/cli/enrich-federal-bills.js --dry-run`, 2026-07-29)

```
billsInWorklist:    478   (distinct federal bills with >=1 recorded vote)
billRowNotFound:      0
billsNeedingWork:   478
billsSkippedComplete: 0
needingSponsors:    478   (100% — this is the first-ever federal sponsor-writing pass)
needingStatus:        2
needingText:        450
sponsorTableGated: false  (migration 0014 IS already applied live — confirmed by this probe)
```

`--limit 3` correctly slices `billsWouldProcess` to 3 while leaving the honest totals unchanged
— confirmed by a second live invocation.

## Concerns

- The live run (Task 6) will be a substantial first pass: 478 bill-detail fetches, ~450 text
  fetches, plus a full current-member roster page (House+Senate). Chunking via `--limit` and the
  existing shared `congressLimiter` (3.6s/request) means this is genuinely an afternoon-scale
  operation, not a single invocation — worth planning the chunking cadence explicitly at Task 6
  time, same as the LegiScan bulk backfill's own chunked live rollout.
- `needingSponsors: 478` (every bill) means the live run's very first pass will write a large
  number of `bill_sponsors` rows in one sweep — worth a spot-check of a handful of sponsor rows
  after the first live chunk, same PLAYBOOK_DELTA lesson 13 discipline Task 2's own report flagged
  for its MO sponsor writes.
- Sponsors unmatched against `legislators` (a bioguide not yet in the DB — e.g. a historical
  sponsor who never appeared in an ingested roll call) are an honest, counted skip
  (`sponsorLegislatorNotFound`), never guessed or created. The member-metadata ensure step running
  first each live invocation should keep this bucket small for *current* members, but historical
  sponsors on older bills may still land there — expected, not a bug.
- No live write was performed by this task, per its own scope ("your job ends at code + fixtures
  + dry-run").

---

## Fix round 1

**Status:** complete — 1 Important (bounded) + 2 actionable minors addressed; MINOR 1 (DRY nit)
skipped per the review's own disposition.

**Commit SHA:** `948957a` (branch `profile-completeness`)

**Test summary:** 1114/1114 green, bare `node --test` (1110 baseline at commit time + 4 new, all
in `tests/enrich-federal-bills-cli.test.js`). Zero live DB writes/network calls from tests.

**1. IMPORTANT (adjudicated document+count) — the per-bill sponsor completion gate silently
abandoned unwritten sponsors on multi-sponsor bills.** `planBillWork`'s `needsSponsors` is an "AT
LEAST ONE sponsor recorded" gate, not "ALL sponsors recorded" — once a single sponsor write lands
for a bill, no future run ever re-fetches its detail for sponsors again. On a bill with multiple
sponsors where some resolve/write and others don't in the same run, the unwritten ones were
silently lost forever with zero trace. Fixed two ways, per the review's own split:
- **(a) Documented** — a `KNOWN TRADEOFF` comment block directly on `planBillWork` (same
  code-comment + report-entry style as the already-disclosed "Sponsors, not cosponsors" and
  "text-already-exists is bill-level" decisions above), explicitly naming the abandonment risk and
  noting both real captured fixtures (HR 498, HR 845) carry exactly one sponsor — believed rare in
  practice, not proven absent.
- **(b) Honest failure path** — `processBillLive`'s sponsor loop now collects every bioguide that
  fails to resolve (`sponsorLegislatorNotFound`) or fails to write (`sponsorGated`, including the
  live-discovered 0014-missing-relation case) into a per-bill list; if non-empty, ONE grouped
  `failures[]` entry names the bill's identifier and every unresolved bioguide, and a new counted
  bucket `sponsorsUnresolved` totals them across the run. This does not make the gate retry
  automatically (that's still the documented tradeoff) — it makes the abandonment *findable* for a
  future manual pass or a later design fix. Tested directly: a 2-sponsor bill where one resolves
  and writes normally while the other is a ghost bioguide — the write still succeeds, the ghost is
  named alone in one `failures[]` entry, `sponsorsUnresolved` is 1 (not 2 — the successful write
  never counts as unresolved). Also extended the existing 0014-gate test and the existing
  unmatched-sponsor test with the same assertions.

**2. MINOR 2 — party fill silently dropped the null-source/null-existing case from every count.**
The prior hand-rolled `if (m.party != null && existing.party == null) {...} else if
(existing.party != null) {...}` had a real gap: when BOTH `m.party` and `existing.party` were
null, neither branch ran, and that member vanished from `partyPatched`/`partyAlreadySet` entirely
— not visible anywhere in the counts. Rewritten to mirror the `bills.status` pattern in the same
file exactly: `m.party == null` is now its own bucket (`partyMissingInSource`), otherwise
`additivePatch(existing, {party: m.party})` decides patched-vs-already-set the same way status
does. New `emptyMemberCounts()` field `partyMissingInSource`. Tested: both-null case now counts
`partyMissingInSource: 1`, `partyPatched`/`partyAlreadySet` stay 0, and no DB write is attempted.

**3. MINOR 3 — `ensureFederalMemberMetadata` re-pages the full ~2,694-member roster (~11
congress.gov requests) on EVERY invocation, regardless of `--limit`** (`--limit` only slices the
bill worklist). A Task-6 operator chunking bill work across many invocations would otherwise
redundantly re-page the roster every single chunk (~11 requests × N chunks, ~40s × N chunks
against the shared 3.6s/request `congressLimiter`). Added: (a) a header comment on
`ensureFederalMemberMetadata` documenting this cost and pointing at the new flag; (b) a
`--skip-members` CLI flag (`parseArgs`, threaded through `runEnrichFederalBills` as
`skipMembers`) — when set, `ensureFederalMemberMetadataFn` is never called at all, and the run
reports `memberMetadataSkipped: true` / `memberMetadata: null` honestly rather than silently
zeroing out fields that look like real (zero) results. Intended Task-6 usage: run the first chunk
of a live pass normally, pass `--skip-members` on every subsequent chunk. Tested: a spy proves the
member-metadata function is never invoked when `skipMembers: true`.

**4. MINOR 1 (DRY nit) — skipped**, per the review's own disposition (no action requested).

**Concerns (fix round 1):** none new. The IMPORTANT finding's fix is a detection/visibility
improvement, not a full close — a bill that already accumulated a partial sponsor set before this
fix round shipped will still need its `failures[]`-named bioguides investigated manually on a
future pass (the bill-level gate genuinely does not retry on its own); this is the documented,
believed-rare tradeoff, not a residual bug.
