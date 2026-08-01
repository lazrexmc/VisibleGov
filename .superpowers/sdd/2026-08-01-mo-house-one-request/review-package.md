# Review package — mo-house one-request-per-run (b7e423c..f692b34)

f692b34 fix: ingest-mo-house makes at most one live request per run (was ETIMEDOUT 3-for-3)

## Stat
 TODO.md                      |  25 +++
 src/adapters/mo-house-xml.js |  14 ++
 src/cli/ingest-mo-house.js   | 323 +++++++++++++++++++++++++++------------
 tests/mo-house-xml.test.js   | 352 ++++++++++++++++++++++++++++++++++++++++++-
 4 files changed, 618 insertions(+), 96 deletions(-)

## Full diff (-U10)
diff --git a/TODO.md b/TODO.md
index 5c49e20..ce312f5 100644
--- a/TODO.md
+++ b/TODO.md
@@ -270,20 +270,45 @@
     (surfaced by the 2026-07-31 scheduler review, reviewer-confirmed out-of-scope-but-ledger).
     `ingest-legiscan.js` (votes/bills) and `ingest-legiscan-texts.js` (doc blobs,
     `ingest-legiscan-texts.js:781`, deliberate per its own comment) both write the same source
     key, so any latest-row read — scheduler due-ness, `public_freshness` — sees whichever ran
     last. Every current consequence is fail-safe (a manual texts run can only *delay* the next
     scheduled legiscan tick, never advance it; the scheduler's refresh gate fails open on the
     texts shape). Real fix = split the source key (schema + CLI + historical-row migration
     touching `public_freshness`) — **draft-then-apply, Lance runs it**. Not urgent; recorded so
     the shared key stops being a surprise.
 
+34. [x] ~~MO House driver silently slept ~30 minutes mid-run, wedged behind its own rate
+    limiter — every scheduled run ETIMEDOUT.~~ **FIXED 2026-08-01.** `mo-house-xml.js:12`'s
+    `moHouseLimiter` (30 min/request, per house.mo.gov's own ToU) is correctly *strict*, but
+    `ingest-mo-house.js`'s old shape could need TWO live requests in one invocation — a stale
+    `BillList.XML` refresh, then a per-bill XML fetch — both through that SAME shared limiter, so
+    the second request just slept out the first request's ~30-minute interval in-process (zero
+    connections, zero CPU, zero log output — invisible unless you caught the process alive).
+    Under the scheduler's 480s child timeout every such run was killed first: mo-house-xml was
+    3-for-3 ETIMEDOUT, effectively down. **The round-2 reviewer's "every historical run took an
+    exact multiple of 1800 seconds" observation was THIS defect — misattributed at the time to
+    MO-side slowness rather than an in-process double-fetch.** An earlier partial fix (caching the
+    list at a 60-minute max-age) only reduced how *often* both fetches landed in one run; it
+    didn't stop the combination once the cache aged out. Real fix: `runMoHouse`
+    (`src/cli/ingest-mo-house.js`) now makes **at most one live house.mo.gov request per
+    invocation**, mirroring `ingest-mo-senate.js`'s `runMoSenate` slot-priority shape — pending
+    roll-call PDF, then a stale-list-refresh slot (spends the request, persists stubs, stops), then
+    a fresh-list bill-detail slot (reads cache, no network, spends the request on one bill). The
+    limiter itself is untouched (still 30 min, per ToU) and now doubles as a tripwire: a future bug
+    making a second live request in one run would sleep and get killed LOUDLY by the scheduler
+    instead of silently violating the ToU. `MO_BILL_LIST_MAX_AGE_MS` raised 60min → 24h (fewer
+    whole runs spent on list housekeeping under the new one-slot-per-run shape). `--limit` > 1 is
+    now a typed `LiveRequestLimitError` (there is only ever one live fetch to give a limit to); the
+    scheduler's frozen `--limit 1` is unaffected. 9 new tests
+    (`tests/mo-house-xml.test.js`), 2101/2101 green.
+
 ---
 
 ### Defects found by the 2026-07-31 data audit (docs vs live DB) — none were previously recorded
 
 25. **⚠️ The MO 2026 session is SPLIT IN TWO and the split is actively growing.** Session identifier
     `'2026'` carries `legiscan_session_id = NULL` — the only MO session missing one — and duplicates
     session `'261'` (legiscan 2239). All 16 of `'2026'`'s bill identifiers also exist under `'261'`,
     carrying 17 roll calls / 561 casts, and it grew 15→16 bills *during* the audit: the cron is
     feeding the duplicate. Contrast MO 2018, where the same adapter's row was correctly merged.
     **Highest-priority data defect** — it splits one session's record across two sessions on the
diff --git a/src/adapters/mo-house-xml.js b/src/adapters/mo-house-xml.js
index 301f809..b10f4f2 100644
--- a/src/adapters/mo-house-xml.js
+++ b/src/adapters/mo-house-xml.js
@@ -1,20 +1,34 @@
 import { XMLParser } from 'fast-xml-parser';
 import { fetchWithLimit } from '../lib/http.js';
 import { createLimiter } from '../lib/rate-limiter.js';
 
 export const SOURCE = 'mo-house-xml';
 
 // house.mo.gov's own published ToU (tests/fixtures/research/mo-house-xml/
 // xml-bill-list-instructions-doc.html, quoted verbatim): "Do not automate scripts to pull down
 // information more often than once every half hour." Mechanically enforced, not just
 // documented — every fetch* function below defaults to this shared limiter.
+//
+// TRIPWIRE ROLE (2026-08-01 fix — see src/cli/ingest-mo-house.js's runMoHouse module comment for
+// the full defect this closes): ingest-mo-house.js now makes AT MOST ONE live request through this
+// limiter per process invocation (a stale-list refresh OR one bill/roll-call detail fetch, never
+// both in the same run) — so under that architecture this limiter should never actually have to
+// wait out its own interval; `.take()` returns immediately every time. It stays at the full
+// 30-minute interval anyway, ON PURPOSE, as a mechanical tripwire: if a code path is ever added
+// (or a bug reintroduces one) that makes a SECOND live request within the same run, that second
+// `.take()` call sleeps out the remaining ~30 minutes — which the scheduler's per-source
+// child-process timeout (8 min, scripts/scheduled-ingest.js's CHILD_TIMEOUT_MS) then kills LOUDLY
+// (a visible ETIMEDOUT/killed run, alerting) long before the sleep could ever complete. A silent
+// ToU violation is structurally impossible this way — the failure mode is a loud, logged timeout,
+// never a quiet double-fetch. This is exactly how the original defect was diagnosed: real scheduler
+// runs killed at their timeout, root-caused to this limiter blocking on a second in-run fetch.
 export const MO_HOUSE_MIN_INTERVAL_MS = 30 * 60 * 1000;
 export const moHouseLimiter = createLimiter({ minIntervalMs: MO_HOUSE_MIN_INTERVAL_MS });
 
 // SessionSet.js (tests/fixtures/research/mo-house-xml/session-set.js) hardcodes the current
 // session's URL-path code as '261'. Per docs/research/2026-07-27-mo-data-sources.md (Q4,
 // VERIFIED-BY-PAYLOAD): session 261 = "2026 2nd Regular, 103rd General Assembly". This is the
 // House XML export's OWN session-naming scheme — a different identifier space from OpenStates'
 // session keys already used by src/adapters/mo-legislature.js (e.g. '2022', '2022S1'). Both are
 // stored as separate `sessions` rows under jurisdiction_id='mo-legislature' (keyed on
 // (jurisdiction_id, identifier)) since they represent different source systems' naming for the
diff --git a/src/cli/ingest-mo-house.js b/src/cli/ingest-mo-house.js
index 3e41b66..91239be 100644
--- a/src/cli/ingest-mo-house.js
+++ b/src/cli/ingest-mo-house.js
@@ -1,17 +1,17 @@
 import {
   existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
 } from 'node:fs';
 import {
   getClient, openRun, closeRun, insertIfAbsent, additivePatch, isMissingColumnError, isMissingRelationError,
 } from '../lib/db.js';
-import { SourceFetchError } from '../lib/errors.js';
+import { SourceFetchError, parsePositiveIntegerFlag } from '../lib/errors.js';
 import * as mo from '../adapters/mo-house-xml.js';
 import * as pdf from '../adapters/mo-rollcall-pdf.js';
 
 // Separate small CLI per task-4-brief.md ("Driver: a separate small CLI ... implementer's call,
 // document it") rather than extending src/cli/ingest.js: this source has a fundamentally
 // different cadence (30-minute mechanically-enforced limiter vs. the other adapters' sub-10s
 // limiters) and a fetch-list-then-loop-per-item shape that doesn't fit ingest.js's existing
 // one-collect-call-per-source pattern without complicating it for every other source.
 //
 // COEXISTENCE POLICY (Task 8 of docs/superpowers/plans/2026-07-29-legiscan-bulk-adapter.md,
@@ -56,21 +56,27 @@ const MO_BILL_LIST_ARTIFACT_DIR = '.superpowers/artifacts/mo-bill-list';
 export function parseMoHouseArgs(argv) {
   const out = {
     session: mo.DEFAULT_MO_HOUSE_SESSION, limit: 1, dryRun: false, billIdentifier: null, billXmlFile: null, rollcallPdfFile: null,
   };
   let i = 0;
   while (i < argv.length) {
     const key = argv[i];
     if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
     const val = argv[i + 1];
     if (key === '--session') out.session = val;
-    else if (key === '--limit') out.limit = Number(val);
+    // Typed validation (project law) — matches enrich-federal-bills.js/backfill-mo-bill-texts.js's
+    // own --limit handling. This only validates SHAPE (a positive integer). The separate
+    // ARCHITECTURAL constraint — --limit may not exceed 1, since runMoHouse makes at most one live
+    // request per invocation — is enforced in runMoHouse itself, not here, so a --dry-run
+    // invocation (which never calls runMoHouse and never even looks at args.limit) is never
+    // affected by a --limit value it doesn't use. See runMoHouse's own module comment.
+    else if (key === '--limit') out.limit = parsePositiveIntegerFlag(val, '--limit');
     // Normalized (case/space-insensitive) so '--bill hb1800', '--bill HB1800', and
     // '--bill "HB 1800"' all resolve identically — matches entries[].identifier, which is
     // always produced via the same normalizeMoBillIdentifier call (parseMoBillList).
     else if (key === '--bill') out.billIdentifier = mo.normalizeMoBillIdentifier(val);
     else if (key === '--bill-xml-file') out.billXmlFile = val;
     // Same fixture-testing convention as --bill-xml-file (Task 4): reads a LOCAL PDF file instead
     // of live-fetching whatever pending roll-call PDF this invocation would otherwise process
     // (selectPendingPdf still runs — a real DB read, not a house.mo.gov request — this flag only
     // substitutes the byte source). Used this task to prove the full extract -> reconcile ->
     // resolve -> persist-or-gate cycle against the real fixture without spending a live PDF fetch.
@@ -178,20 +184,28 @@ export function selectTargets(entries, args, dir = MO_BILLS_ARTIFACT_DIR) {
   }
   // No documented way to PRIORITIZE among not-yet-enriched bills (BillList.XML carries no
   // "has RollCall elements" signal) — list-order is still the honest default ordering. What
   // changed (the actual fix): bills that have ALREADY completed an enrichment cycle
   // (hasEnrichedMarker) are excluded before slicing to --limit, so this driver advances through
   // the backlog instead of reselecting the same already-done bill(s) forever.
   const pending = entries.filter((e) => !hasEnrichedMarker(e.identifier, dir));
   return pending.slice(0, args.limit).map((e) => ({ identifier: e.identifier, bill_xml_url: e.bill_xml_url }));
 }
 
+// Mirrors selectTargets's own "not yet enriched" filter exactly (same signal, same dir
+// convention) — pulled out separately so runMoHouse can report total_pending_bills (mirrors
+// ingest-mo-senate.js's selectJournalDayWorklist -> worklist.totalPending) without changing
+// selectTargets's own return shape, which many existing tests already pin as a bare array.
+export function countPendingBills(entries, dir = MO_BILLS_ARTIFACT_DIR) {
+  return entries.filter((e) => !hasEnrichedMarker(e.identifier, dir)).length;
+}
+
 // ---- durable, cross-process ToU cooldown ----
 //
 // moHouseLimiter (src/adapters/mo-house-xml.js) is an IN-MEMORY limiter: it only sequences
 // fetches within a single process's lifetime. Bug found in review: a real double-fetch
 // (~4 minutes apart) occurred when a second process (the controller's overnight driver) started
 // shortly after this process had already exited — the new process's limiter had zero memory of
 // the first process's fetch, so it fetched immediately, violating house.mo.gov's <=1 req/30min
 // ToU. ingestion_runs is the durable, cross-process-visible record of "was a fetch recently
 // made (or attempted)" — these two pure helpers plus enforceDurableCooldown below close that gap.
 
@@ -282,40 +296,55 @@ export async function enforceDurableCooldown(
     await sleep(remaining);
   }
   throw new CooldownConvergenceError(
     `mo-house cooldown did not converge after ${maxIterations} fresh re-checks — this should be `
       + 'impossible in normal operation (see enforceDurableCooldown\'s own comment); failing loud '
       + 'rather than looping forever',
     { maxIterations, minIntervalMs },
   );
 }
 
-// ---- Task fix-mo-enrichment: bill-list refetch cadence ----
+// ---- bill-list refetch cadence + slot priority (task fix-mo-enrichment, then the 2026-08-01
+// one-request-per-run rebuild — see runMoHouse's own module comment, near main(), for the full
+// current architecture) ----
+//
+// BUG FOUND LIVE (fix-mo-enrichment, 2026-07-29): main() used to unconditionally re-fetch the
+// entire BillList.XML on every invocation before ever reaching the per-bill fetch. Both fetches
+// share the SAME in-process moHouseLimiter instance (house.mo.gov's <=1 req/30min ToU,
+// mechanically enforced) — so the second (per-bill) fetch of every single invocation had to wait
+// out a FULL second 30-minute interval after the first (list) fetch completed. Live proof
+// (ingestion_runs, this source): every started_at/finished_at pair was exactly 30 minutes apart
+// (e.g. 10:24:22 -> 10:54:22) — each invocation spent its ENTIRE cooldown slot sleeping inside
+// that second fetch, roughly HALVING how many bills this driver could process per hour.
 //
-// BUG FOUND LIVE: main() used to unconditionally re-fetch the entire BillList.XML on every
-// invocation before ever reaching the per-bill fetch. Both fetches share the SAME in-process
-// moHouseLimiter instance (house.mo.gov's <=1 req/30min ToU, mechanically enforced) — so the
-// second (per-bill) fetch of every single invocation had to wait out a FULL second 30-minute
-// interval after the first (list) fetch completed. Live proof (ingestion_runs, this source): every
-// started_at/finished_at pair is exactly 30 minutes apart (e.g. 10:24:22 -> 10:54:22) — each
-// invocation spent its ENTIRE cooldown slot on this one redundant list re-fetch, roughly HALVING
-// how many bills this driver can process per hour. The list only regenerates upstream on its own
-// schedule (LastTimeRun timestamps in the research fixture cluster around :01 and :30 past the
-// hour) — re-fetching it every 30 minutes was never buying freshness, only burning budget.
+// THAT FIX WAS INCOMPLETE (root-caused 2026-08-01, controller-verified live on pid-level evidence
+// — the round-2 reviewer's "every run took an exact multiple of 1800s" observation was THIS
+// defect, misattributed at the time to MO-side slowness): caching the list at a 60-minute max-age
+// reduced how OFTEN both fetches happened in the same run, but did not stop it — any invocation
+// that happened to land after the cache aged past 60 minutes still made BOTH a live list fetch AND
+// a live per-bill fetch in that same process, hitting the exact same limiter collision above. Under
+// the scheduler's 480s per-source child timeout (scripts/scheduled-ingest.js's CHILD_TIMEOUT_MS),
+// every such run was killed long before the ~30-minute in-process sleep could ever complete —
+// mo-house-xml was 3-for-3 ETIMEDOUT, effectively down.
 //
-// FIX: cache the parsed list to a local artifact with a fetch timestamp; only re-fetch live once
-// that cache is >= MO_BILL_LIST_MAX_AGE_MS old (60 min — comfortably covers the upstream refresh
-// cadence with margin, without needing to introspect house.mo.gov's own regeneration schedule
-// precisely). A stale-by-up-to-an-hour list is harmless here: persistBillStubs's writes are
-// purely additive (insertIfAbsent), and any bill genuinely new since the last live fetch is picked
-// up on the next refresh, at most an hour later.
-export const MO_BILL_LIST_MAX_AGE_MS = 60 * 60 * 1000;
+// THE ACTUAL FIX (2026-08-01): runMoHouse now makes AT MOST ONE live house.mo.gov request per
+// invocation, full stop (see its own module comment for the slot-priority architecture). This
+// constant's role changes accordingly: it no longer exists to avoid burning a cooldown slot on a
+// redundant SECOND fetch (that combination is now structurally impossible — a list-refresh run
+// never reaches the per-bill code in the same invocation); it now purely controls how often a
+// WHOLE run gets spent refreshing the list instead of detailing a bill. Raised from 60 minutes to
+// 24 hours: out of session the list changes rarely (no new bills filed), so checking hourly bought
+// nothing but spent whole runs on housekeeping; in session, a once-a-day refresh is still frequent
+// enough to keep stub discovery current (a bill filed this morning is picked up by tonight's
+// refresh at the latest) while leaving nearly every 30-minute cooldown slot free for actual
+// bill-detail progress instead.
+export const MO_BILL_LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
 
 function billListCachePath(session, dir) {
   return `${dir}/${session}.json`;
 }
 
 // Pure + testable without touching the filesystem or mocking a clock in the caller: given the ISO
 // timestamp of the last cached list fetch (or null/undefined if none exists yet), is a fresh live
 // fetch required this invocation? Mirrors remainingCooldownMs's own "no prior => must proceed"
 // convention.
 export function shouldRefetchBillList(lastFetchIso, maxAgeMs = MO_BILL_LIST_MAX_AGE_MS, now = Date.now()) {
@@ -879,168 +908,274 @@ export async function dryRunReport(client, session) {
     },
     // NOTE: sorted by DB identifier (alphabetical), NOT the true BillList.XML document order
     // selectTargets uses live/from cache — a sensible preview of what's still pending, not a
     // promise of the exact next fetch order (that requires an actual list fetch/cache, which
     // --dry-run deliberately never does).
     next_targets_preview: pendingByMarker.slice(0, 10),
     note: 'counts computed from DB state + local .enriched marker artifacts only — zero live fetches made this invocation, per --dry-run',
   };
 }
 
-// ---- main ----
-
-async function main() {
-  const args = parseMoHouseArgs(process.argv.slice(2));
-  // Fetched even under --dry-run's early-return branch is now GONE (fix): the client is needed
-  // either way (dry-run reads DB state; live reads+writes), but no live fetch happens before we
-  // know which branch we're in.
-  const client = getClient();
-
-  if (args.dryRun) {
-    if (!client) {
-      console.log(JSON.stringify({
-        mode: 'dry-run', source: 'mo-house-xml', counts: null,
-        note: 'no DB client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset) — cannot report DB state; zero live fetches made',
-      }, null, 2));
-      return;
-    }
-    const report = await dryRunReport(client, args.session);
-    console.log(JSON.stringify({ mode: 'dry-run', source: 'mo-house-xml', ...report }, null, 2));
-    return;
+// ---- runMoHouse (main orchestration) ----
+//
+// ARCHITECTURE (2026-08-01 fix — the diagnosed defect this closes): house.mo.gov's ToU allows at
+// most one request per 30 minutes (moHouseLimiter, mo-house-xml.js), the scheduler invokes this
+// CLI on that same ~30-minute durable cooldown (enforceDurableCooldown below), and each invocation
+// is a fresh child process killed if it runs past CHILD_TIMEOUT_MS (8 min,
+// scripts/scheduled-ingest.js). Before this fix, a single invocation could need TWO live requests —
+// a stale BillList.XML refresh, THEN a per-bill XML fetch, in the SAME run — both routed through
+// the one shared in-process moHouseLimiter, so the second request simply slept out the ~30-minute
+// interval the first request had just started. The scheduler killed the process long before that
+// sleep could ever finish: mo-house-xml was 3-for-3 ETIMEDOUT, effectively down (see
+// MO_BILL_LIST_MAX_AGE_MS's own comment for the full history, including the incomplete first fix).
+//
+// THE FIX: runMoHouse makes AT MOST ONE live house.mo.gov request per invocation, chosen by
+// priority — the same shape as ingest-mo-senate.js's runMoSenate (roster/index/day slots), applied
+// to this driver's own document types (roll-call PDF / bill list / bill detail):
+//   1. A pending roll-call PDF (selectPendingPdf) — UNCHANGED by this fix; this branch already
+//      made exactly one live request (the PDF) and returned immediately below, never falling
+//      through to the bill-list code — preserved as the highest-priority slot.
+//   2. An explicit --bill-xml-file — ZERO live requests (a local fixture read); bypasses the slot
+//      decision entirely rather than being subject to slot 3/4's staleness check, since
+//      selectTargets's billXmlFile branch never needs the bill list to find a bill_xml_url.
+//   3. SLOT (a), list-refresh — the cached BillList for this session is missing or older than
+//      MO_BILL_LIST_MAX_AGE_MS: spend this run's one request on fetchMoBillList, persist stubs,
+//      and STOP. This run never also fetches a bill's detail XML — that combination is the exact
+//      defect above.
+//   4. SLOT (b), bill-detail — the cache is fresh: read it (no network), select the single next
+//      target exactly as selectTargets already did (an explicit --bill still goes through this
+//      same slot, honored by selectTargets's own explicit-identifier branch — if the list happens
+//      to be stale, slot (a) fires instead and the explicit bill is deferred to the next
+//      invocation, never a second live request in this one), and spend this run's one request on
+//      that target's bill XML.
+export class LiveRequestLimitError extends Error {
+  constructor(message, meta = {}) {
+    super(message);
+    this.name = 'LiveRequestLimitError';
+    Object.assign(this, meta);
   }
+}
 
-  if (!client) {
-    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
-    process.exitCode = 1;
-    return;
+// deps default to the real artifact directories / live fetchers (unchanged runtime behavior);
+// overridable purely for testability, same convention as ingest-mo-senate.js's runMoSenate.
+export async function runMoHouse(client, args, {
+  billsDir = MO_BILLS_ARTIFACT_DIR,
+  billListDir = MO_BILL_LIST_ARTIFACT_DIR,
+  rollcallDir = ROLLCALL_ARTIFACT_DIR,
+  fetchBillList = mo.fetchMoBillList,
+  fetchBillXml = mo.fetchMoBillXml,
+} = {}) {
+  // --limit: with one live request per run, N>1 can no longer mean "N live fetches in one run" —
+  // there is no other live-fetch-multiplying behavior left in this driver to reinterpret N against
+  // (unlike, say, a batch of independently cache-only work), so this rejects rather than silently
+  // reinterpreting or capping. Checked FIRST, before any DB/network activity at all (fail fast, zero
+  // side effects) — a --dry-run invocation never reaches runMoHouse at all (see main() below) and
+  // never even looks at args.limit, so it is entirely unaffected by this restriction. The
+  // scheduler's own frozen invocation (scripts/scheduled-ingest.js, cliArgs: ['--limit', '1']) is
+  // exactly the boundary case this allows through unchanged.
+  if (args.limit > 1) {
+    throw new LiveRequestLimitError(
+      `--limit ${args.limit} is not supported: this run makes at most ONE live house.mo.gov `
+        + 'request per invocation (see this file\'s own module comment above runMoHouse, and the '
+        + 'tripwire comment on MO_HOUSE_MIN_INTERVAL_MS in src/adapters/mo-house-xml.js) — pass '
+        + '--limit 1 (the default) or omit the flag, and invoke the CLI again for each additional '
+        + 'target; the scheduler\'s 30-minute durable cooldown (enforceDurableCooldown) is the '
+        + 'intended pacing mechanism for processing more than one target over time.',
+      { limit: args.limit },
+    );
   }
 
   // Cross-process durable cooldown check happens BEFORE we even open our own run row — see
   // enforceDurableCooldown's own comment block for why (an in-flight row must be visible).
   await enforceDurableCooldown(client);
 
-  // openRun is now called BEFORE the bill-list fetch (previously it was called AFTER — the bug
-  // the review caught: a run row that only appears once a fetch already happened is invisible
-  // to another process's cooldown check for as long as the fetch takes). Its started_at
-  // (schema default now() at INSERT time) is therefore a close proxy for "when this process's
-  // first house.mo.gov request happened" — safe because: (1) it's durable and
-  // cross-process-visible, unlike moHouseLimiter's in-memory state; (2) if anything fails between
-  // this insert and the actual fetch, the cooldown still counts it — conservative, better to
-  // over-wait than risk violating the ToU; (3) it reflects FETCH time, not run-CLOSE time —
-  // using finished_at instead would be wrong, since a run that loops over several per-bill
-  // fetches can stay open far longer than any single fetch, which would make a next run's
-  // cooldown check under-wait if it referenced finished_at.
-  //
-  // KNOWN RESIDUAL GAP: within a single process making MULTIPLE live fetches (--limit > 1, no
-  // --bill-xml-file), only the FIRST fetch's timing is captured by started_at — a third process
-  // starting mid-loop would see a stale started_at and could under-wait relative to that
-  // process's most recent (not first) fetch. In practice this driver has so far only ever made
-  // one live document fetch per invocation (see task-4-report.md); running it as short-lived,
-  // --limit 1 invocations spaced externally (e.g. a scheduler re-launching the process every
-  // ~30 min) sidesteps the gap entirely and is the recommended operational pattern.
+  // openRun is called BEFORE any live fetch. Its started_at (schema default now() at INSERT time)
+  // is therefore a close proxy for "when this process's live house.mo.gov request happened" —
+  // durable and cross-process-visible, unlike moHouseLimiter's in-memory state. With this fix, a
+  // process makes AT MOST ONE live fetch, so the "which fetch does started_at reflect" ambiguity
+  // the old code's KNOWN RESIDUAL GAP note described no longer applies — there is only ever one.
   const runId = await openRun(client, 'mo-house-xml');
   try {
     // Pure DB + filesystem — no house.mo.gov request — safe to attempt every invocation
-    // regardless of which branch below actually runs this slot (see replayArtifacts's own
-    // comment for why this is what makes "apply 0005, next run just works" literally true).
-    const artifactReplay = await replayArtifacts(client, runId);
+    // regardless of which slot below actually runs (see replayArtifacts's own comment for why
+    // this is what makes "apply 0005, next run just works" literally true).
+    const artifactReplay = await replayArtifacts(client, runId, rollcallDir);
 
     // Task 4b queue priority: an explicit --bill/--bill-xml-file targets a specific bill directly
     // (bypasses the PDF queue — the operator asked for that bill, honor it). Otherwise, a pending
     // roll-call PDF (a votes row with a pdf_url and no casts yet) takes priority over fetching a
     // NEW bill this slot — see listPendingRollCallPdfs's own comment for the FIFO/priority
     // rationale. This invocation processes exactly ONE document either way: one roll-call PDF, or
-    // (only when zero are pending) the existing bill-list + selectTargets bill-XML path below.
+    // (only when zero are pending) the bill-list-or-bill-detail slot decision below.
     const wantsExplicitBill = Boolean(args.billIdentifier || args.billXmlFile);
-    // FINDING 2 fix: the pending-PDF queue check (and its skippedFailed/quarantine count+keys)
-    // runs whenever no explicit --bill/--bill-xml-file was given, regardless of whether this slot
-    // ends up processing a PDF or falls through to the bill-xml path below — surfaced into run
-    // detail either way (both counts objects below).
     const pdfQueue = wantsExplicitBill ? { next: null, skippedFailed: 0, skippedKeys: [] } : await selectPendingPdf(client);
     const { next: pendingPdf, skippedFailed: skippedFailedPdfs, skippedKeys: skippedFailedPdfKeys } = pdfQueue;
     if (pendingPdf) {
       const result = await processRollCallPdf(client, runId, pendingPdf, args);
       const failures = result.failure ? [result.failure] : [];
       const counts = {
         document_type: 'rollcall-pdf', artifact_replay: artifactReplay, failures: failures.length, skipped_failed_pdfs: skippedFailedPdfs, skipped_failed_pdf_keys: skippedFailedPdfKeys,
       };
       const status = failures.length === 0 ? 'succeeded' : 'partial';
       await closeRun(client, runId, status, { counts, rollCallResult: result, failures });
       console.log(JSON.stringify({
         mode: 'live', run_id: runId, status, counts, rollCallResult: result, failures,
       }, null, 2));
       if (failures.length > 0) process.exitCode = 2;
-      return;
+      return {
+        runId, status, counts,
+      };
     }
 
-    // Task fix-mo-enrichment: only re-fetch BillList.XML live when the cache is stale (or absent)
-    // — see shouldRefetchBillList's own comment for the live-verified bug this closes (every
-    // invocation used to spend its entire cooldown slot on a redundant list re-fetch).
-    const cachedList = readCachedBillList(args.session);
-    let entries;
-    let listFetchMode;
-    if (shouldRefetchBillList(cachedList?.fetched_at ?? null)) {
-      const listXml = await mo.fetchMoBillList(args.session);
-      console.error(`[${new Date().toISOString()}] fetched bill-list XML (live, session ${args.session})`);
-      entries = mo.parseMoBillList(listXml);
-      writeCachedBillList(args.session, entries);
-      listFetchMode = 'live';
+    let entries = null;
+    let listFetchMode = null;
+    let sessionRow;
+    let roster;
+
+    if (args.billXmlFile) {
+      // Point 6 of the fix: zero live requests, unaffected by the slot decision below —
+      // selectTargets's billXmlFile branch never reads `entries` at all, so there is nothing to
+      // fetch or cache here.
+      sessionRow = await ensureSessionRow(client, runId, args.session);
+      roster = await persistRoster(client, runId);
     } else {
+      // ---- slot decision: at most ONE live house.mo.gov request from here on ----
+      const cachedList = readCachedBillList(args.session, billListDir);
+      if (shouldRefetchBillList(cachedList?.fetched_at ?? null)) {
+        // SLOT (a) — list-refresh. Spend this run's one request here and STOP: this run never
+        // also attempts a bill-detail fetch (that combination is the defect this fix closes).
+        const listXml = await fetchBillList(args.session);
+        console.error(`[${new Date().toISOString()}] fetched bill-list XML (live, session ${args.session})`);
+        entries = mo.parseMoBillList(listXml);
+        writeCachedBillList(args.session, entries, billListDir);
+        sessionRow = await ensureSessionRow(client, runId, args.session);
+        await persistBillStubs(client, runId, sessionRow, entries);
+        roster = await persistRoster(client, runId);
+        const counts = {
+          document_type: 'bill-xml',
+          slot: 'list-refresh',
+          bills_listed: entries.length,
+          bills_detailed: 0,
+          list_fetch_mode: 'live',
+          total_pending_bills: countPendingBills(entries, billsDir),
+          failures: 0,
+          roster,
+          artifact_replay: artifactReplay,
+          skipped_failed_pdfs: skippedFailedPdfs,
+          skipped_failed_pdf_keys: skippedFailedPdfKeys,
+        };
+        await closeRun(client, runId, 'succeeded', { counts, roster });
+        console.log(JSON.stringify({
+          mode: 'live', run_id: runId, status: 'succeeded', counts,
+        }, null, 2));
+        return { runId, status: 'succeeded', counts };
+      }
+      // SLOT (b) — bill-detail. The cache is fresh: read it (no network) — the only branch that
+      // reuses a prior fetch instead of spending this run's request on a refresh.
       entries = cachedList.entries;
       listFetchMode = 'cached';
-      console.error(`[${new Date().toISOString()}] reusing cached bill-list XML from ${cachedList.fetched_at} (< ${MO_BILL_LIST_MAX_AGE_MS / 60000}min old; skipping live list fetch this slot)`);
+      console.error(`[${new Date().toISOString()}] reusing cached bill-list XML from ${cachedList.fetched_at} (< ${MO_BILL_LIST_MAX_AGE_MS / (60 * 60 * 1000)}h old; skipping live list fetch this slot)`);
+      sessionRow = await ensureSessionRow(client, runId, args.session);
+      await persistBillStubs(client, runId, sessionRow, entries);
+      roster = await persistRoster(client, runId);
     }
-    const targets = selectTargets(entries, args);
 
-    const sessionRow = await ensureSessionRow(client, runId, args.session);
-    await persistBillStubs(client, runId, sessionRow, entries);
-    const roster = await persistRoster(client, runId);
+    // selectTargets's own --limit slicing is effectively moot now (args.limit is <= 1 by
+    // construction — checked above) but is left unchanged rather than special-cased to "just take
+    // index 0": it remains the single source of truth for SELECTION PRIORITY (an explicit --bill/
+    // --bill-xml-file bypasses the enriched-marker filter; the automatic path excludes
+    // already-enriched bills) — only the COUNT it ever gets sliced to has changed.
+    const targets = selectTargets(entries ?? [], args, billsDir);
+    // Captured BEFORE the fetch loop below (which, on success, immediately marks its one target
+    // enriched) so this reports the backlog size THIS RUN STARTED WITH, mirroring
+    // ingest-mo-senate.js's worklist.totalPending/total_pending_days semantics exactly.
+    const totalPendingBills = entries ? countPendingBills(entries, billsDir) : null;
 
     const billResults = [];
     const failures = [];
     for (const target of targets) {
       let xmlText;
       let mode;
       try {
         if (target.localFile) {
           xmlText = readFileSync(target.localFile, 'utf8');
           mode = 'fixture';
           console.error(`[${new Date().toISOString()}] read bill XML ${target.identifier} from local fixture (not a live request): ${target.localFile}`);
         } else {
-          xmlText = await mo.fetchMoBillXml(target.bill_xml_url);
+          xmlText = await fetchBillXml(target.bill_xml_url);
           mode = 'live';
           console.error(`[${new Date().toISOString()}] fetched bill XML ${target.identifier} (live)`);
         }
       } catch (err) {
         if (!(err instanceof SourceFetchError)) throw err;
         failures.push({ step: `bill xml ${target.identifier}`, message: err.message });
         continue;
       }
       const parsed = mo.parseMoBillXml(xmlText);
       const result = await persistBillDetail(client, runId, sessionRow, parsed);
       billResults.push({ identifier: target.identifier, mode, ...result });
       // Task fix-mo-enrichment: the bill LEAVES the needs-enrichment set here, unconditionally,
       // now that its fetch+parse+persist cycle has completed — see selectTargets/
       // hasEnrichedMarker's own comment for why this is file-presence-driven rather than derived
       // from any DB column.
-      writeEnrichedMarker(target.identifier, { run_id: runId, bill_id: result.bill_id });
+      writeEnrichedMarker(target.identifier, { run_id: runId, bill_id: result.bill_id }, billsDir);
     }
 
     const counts = {
-      document_type: 'bill-xml', bills_listed: entries.length, bills_detailed: billResults.length,
-      list_fetch_mode: listFetchMode,
-      failures: failures.length, roster, artifact_replay: artifactReplay, skipped_failed_pdfs: skippedFailedPdfs, skipped_failed_pdf_keys: skippedFailedPdfKeys,
+      document_type: 'bill-xml',
+      slot: 'bill-detail',
+      bills_listed: entries ? entries.length : null,
+      bills_detailed: billResults.length,
+      list_fetch_mode: listFetchMode ?? 'fixture',
+      total_pending_bills: totalPendingBills,
+      failures: failures.length,
+      roster,
+      artifact_replay: artifactReplay,
+      skipped_failed_pdfs: skippedFailedPdfs,
+      skipped_failed_pdf_keys: skippedFailedPdfKeys,
     };
     const status = failures.length === 0 ? 'succeeded' : 'partial';
     await closeRun(client, runId, status, { counts, billResults, failures, roster });
     console.log(JSON.stringify({ mode: 'live', run_id: runId, status, counts, billResults, failures }, null, 2));
     if (failures.length > 0) process.exitCode = 2;
+    return { runId, status, counts };
   } catch (err) {
     await closeRun(client, runId, 'failed', { error: String(err) });
     throw err;
   }
 }
 
+// ---- main ----
+
+async function main() {
+  const args = parseMoHouseArgs(process.argv.slice(2));
+  // Fetched even under --dry-run's early-return branch is now GONE (fix): the client is needed
+  // either way (dry-run reads DB state; live reads+writes), but no live fetch happens before we
+  // know which branch we're in.
+  const client = getClient();
+
+  if (args.dryRun) {
+    if (!client) {
+      console.log(JSON.stringify({
+        mode: 'dry-run', source: 'mo-house-xml', counts: null,
+        note: 'no DB client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset) — cannot report DB state; zero live fetches made',
+      }, null, 2));
+      return;
+    }
+    const report = await dryRunReport(client, args.session);
+    console.log(JSON.stringify({ mode: 'dry-run', source: 'mo-house-xml', ...report }, null, 2));
+    return;
+  }
+
+  if (!client) {
+    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
+    process.exitCode = 1;
+    return;
+  }
+
+  await runMoHouse(client, args);
+}
+
 const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
 if (invokedDirectly) {
   main().catch((err) => { console.error(err); process.exitCode = 1; });
 }
diff --git a/tests/mo-house-xml.test.js b/tests/mo-house-xml.test.js
index 4ef5059..26a88c9 100644
--- a/tests/mo-house-xml.test.js
+++ b/tests/mo-house-xml.test.js
@@ -10,20 +10,21 @@ import {
   normalizeMoBillIdentifier, parseMoBillList, parseMoMemberList, parseMoRepresentative,
   parseMoBillXml, joinRollcalls, buildMoVoteRows,
 } from '../src/adapters/mo-house-xml.js';
 import {
   parseMoHouseArgs, remainingCooldownMs, formatCooldownWait, selectTargets, reconstructSurnameHeuristic,
   enforceDurableCooldown, CooldownConvergenceError,
   writeFailureArtifact, readFailureArtifact, excludeQuarantinedPdfs, ROLLCALL_MAX_FAILED_ATTEMPTS,
   replayArtifacts,
   persistBillDetail, hasEnrichedMarker, writeEnrichedMarker, backfillEnrichedMarkers,
   shouldRefetchBillList, readCachedBillList, writeCachedBillList, MO_BILL_LIST_MAX_AGE_MS,
+  countPendingBills, runMoHouse, LiveRequestLimitError,
 } from '../src/cli/ingest-mo-house.js';
 
 const FIXTURES = 'tests/fixtures/research/mo-house-xml';
 const billListXml = readFileSync(`${FIXTURES}/bill-list-sample-truncated.xml`, 'utf8');
 const memberListXml = readFileSync(`${FIXTURES}/member-list-sample-truncated.xml`, 'utf8');
 const representativeXml = readFileSync(`${FIXTURES}/representative-107.xml`, 'utf8');
 const hb1800Xml = readFileSync(`${FIXTURES}/HB1800-with-rollcall-tallies.xml`, 'utf8');
 const hb2Xml = readFileSync(`${FIXTURES}/HB2-bill-text-pdf-only.xml`, 'utf8');
 
 // ---- constants ----
@@ -885,13 +886,360 @@ test('writeCachedBillList then readCachedBillList: round-trips session, entries,
     const entries = [{ identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' }];
     writeCachedBillList('261', entries, dir);
     const cached = readCachedBillList('261', dir);
     assert.equal(cached.session, '261');
     assert.deepEqual(cached.entries, entries);
     assert.ok(cached.fetched_at);
     assert.equal(shouldRefetchBillList(cached.fetched_at), false, 'a cache just written must not be considered stale');
   });
 });
 
-test('MO_BILL_LIST_MAX_AGE_MS is 60 minutes', () => {
-  assert.equal(MO_BILL_LIST_MAX_AGE_MS, 60 * 60 * 1000);
+test('MO_BILL_LIST_MAX_AGE_MS is 24 hours (2026-08-01 one-request-per-run fix — raised from 60 minutes; see the constant\'s own comment in src/cli/ingest-mo-house.js for why)', () => {
+  assert.equal(MO_BILL_LIST_MAX_AGE_MS, 24 * 60 * 60 * 1000);
+});
+
+// ---- countPendingBills ----
+
+test('countPendingBills: counts entries without an enriched marker, excludes those with one', () => {
+  withScratchArtifactDir((dir) => {
+    const entries = [{ identifier: 'HB 2' }, { identifier: 'HB 3' }, { identifier: 'HB 4' }];
+    writeEnrichedMarker('HB 3', {}, dir);
+    assert.equal(countPendingBills(entries, dir), 2);
+  });
+});
+
+// ---- runMoHouse (2026-08-01 one-request-per-run rebuild) ----
+//
+// THE DIAGNOSED DEFECT: a single invocation could need TWO live requests (a stale BillList.XML
+// refresh, then a per-bill XML fetch) — both routed through the SAME shared moHouseLimiter, so the
+// second request slept out ~30 minutes and the scheduler killed the process before it could ever
+// finish (3-for-3 ETIMEDOUT). These tests pin the fix: runMoHouse makes at most one live request
+// per invocation, chosen by a stale-list-vs-fresh-list slot decision, and never both in one run —
+// using injected fetchBillList/fetchBillXml spies (never the real network) plus a minimal
+// generic in-memory fake DB client (same style as ingest-mo-senate.js's runMoSenate test suite).
+
+const threeBillListXml = `<ROOT>
+<BillXML><BillType>HB</BillType><BillNumber>2</BillNumber><BillXMLLink>https://x/HB2.xml</BillXMLLink></BillXML>
+<BillXML><BillType>HB</BillType><BillNumber>3</BillNumber><BillXMLLink>https://x/HB3.xml</BillXMLLink></BillXML>
+<BillXML><BillType>HB</BillType><BillNumber>4</BillNumber><BillXMLLink>https://x/HB4.xml</BillXMLLink></BillXML>
+</ROOT>`;
+
+// Generic upsert/select/insert/update table — same shape/rationale as ingest-mo-senate.js's own
+// makeGenericTable (generalized across table name so one fake client can cover
+// sessions/bills/bill_actions/votes/legislators without five near-identical copies), extended with
+// maybeSingle/update/insert().select().single()/like()/not() since persistBillDetail and the
+// pending-roll-call-PDF query (listPendingRollCallPdfs) need those shapes too. `.order()` is a
+// TERMINAL call here (resolves directly) — the only table this generic builder serves where
+// `.order()` is used at all is `votes`' pending-PDF query, where it genuinely IS the last call in
+// the chain; ingestion_runs (whose OWN `.order()` is followed by `.limit().maybeSingle()`) gets its
+// own dedicated stub below instead, exactly like ingest-mo-senate.js's
+// makeFakeMoSenateRunClient does.
+function makeMoHouseTable(store, idPrefix) {
+  let counter = 0;
+  const builderFor = (rows) => {
+    const filters = [];
+    const builder = {
+      eq(col, val) { filters.push([col, val]); return builder; },
+      like() { return builder; },
+      not() { return builder; },
+      maybeSingle: async () => {
+        const found = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
+        return { data: found[0] ?? null, error: null };
+      },
+      single: async () => {
+        const found = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
+        if (found.length !== 1) return { data: null, error: { message: `expected 1 row for a fake table, got ${found.length}` } };
+        return { data: found[0], error: null };
+      },
+      order: async () => ({ data: rows.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null }),
+    };
+    return builder;
+  };
+  return {
+    upsert: async (rows, opts) => {
+      const conflictCols = (opts?.onConflict || '').split(',').filter(Boolean);
+      for (const row of rows) {
+        const exists = conflictCols.length > 0
+          && store.some((r) => conflictCols.every((c) => r[c] === row[c]));
+        if (!exists) { counter += 1; store.push({ id: `${idPrefix}-${counter}`, ...row }); }
+      }
+      return { error: null };
+    },
+    insert: (row) => ({
+      select: () => ({
+        single: async () => {
+          counter += 1;
+          const inserted = { id: `${idPrefix}-${counter}`, ...row };
+          store.push(inserted);
+          return { data: inserted, error: null };
+        },
+      }),
+    }),
+    update: (patch) => ({
+      eq: async (col, val) => {
+        const row = store.find((r) => r[col] === val);
+        if (row) Object.assign(row, patch);
+        return { error: null };
+      },
+    }),
+    select: () => builderFor(store),
+  };
+}
+
+// Covers exactly the tables runMoHouse's own steps touch: sessions (ensureSessionRow), bills
+// (persistBillStubs/persistBillDetail), bill_actions (persistBillDetail), votes (persistBillDetail
+// + selectPendingPdf's pending-roll-call-PDF query — always empty in these tests, so the PDF-queue
+// branch never short-circuits a scenario meant to exercise the list/bill-detail slot decision),
+// legislators (persistRoster). ingestion_runs gets its own dedicated stub (insert/select-cooldown/
+// update), same convention as ingest-mo-senate.js's makeFakeMoSenateRunClient.
+function makeFakeMoHouseRunClient() {
+  const store = {
+    sessions: [], bills: [], bill_actions: [], votes: [], legislators: [],
+  };
+  const closeCalls = [];
+  let runCounter = 0;
+  return {
+    store,
+    closeCalls,
+    client: {
+      from(table) {
+        if (table === 'ingestion_runs') {
+          return {
+            insert: () => ({
+              select: () => ({
+                single: async () => {
+                  runCounter += 1;
+                  return { data: { id: `run-${runCounter}` }, error: null };
+                },
+              }),
+            }),
+            select: () => {
+              const builder = {
+                eq: () => builder,
+                order: () => builder,
+                limit: () => builder,
+                maybeSingle: async () => ({ data: null, error: null }), // no prior run -> zero cooldown wait
+              };
+              return builder;
+            },
+            update: (detail) => ({
+              eq: async (col, val) => {
+                closeCalls.push({ id: val, ...detail });
+                return { error: null };
+              },
+            }),
+          };
+        }
+        if (table in store) return makeMoHouseTable(store[table], table);
+        throw new Error(`fake mo-house run client: unexpected table ${table}`);
+      },
+    },
+  };
+}
+
+// ---- --limit semantics ----
+
+test('runMoHouse: --limit > 1 throws a typed LiveRequestLimitError before touching the DB at all', async () => {
+  const client = { from: () => { throw new Error('must not touch the DB when --limit > 1'); } };
+  const args = parseMoHouseArgs(['--limit', '2']);
+  await assert.rejects(
+    () => runMoHouse(client, args),
+    (err) => {
+      assert.ok(err instanceof LiveRequestLimitError);
+      assert.equal(err.limit, 2);
+      assert.match(err.message, /ONE live house\.mo\.gov/);
+      return true;
+    },
+  );
+});
+
+test('runMoHouse: --limit 1 (the scheduler\'s own frozen invocation) is unaffected', async () => {
+  await withScratchArtifactDirAsync(async (base) => {
+    const { client } = makeFakeMoHouseRunClient();
+    const args = parseMoHouseArgs(['--limit', '1']);
+    const result = await runMoHouse(client, args, {
+      billsDir: join(base, 'bills'),
+      billListDir: join(base, 'bill-list'),
+      rollcallDir: join(base, 'rollcalls'),
+      fetchBillList: async () => threeBillListXml,
+      fetchBillXml: async () => hb2Xml,
+    });
+    assert.equal(result.status, 'succeeded');
+  });
+});
+
+// ---- slot decision: stale/missing list -> list slot ----
+
+test('runMoHouse: SLOT (a) — a missing bill-list cache spends this run\'s one request on fetchMoBillList and STOPS (never reaches fetchMoBillXml)', async () => {
+  await withScratchArtifactDirAsync(async (base) => {
+    const billsDir = join(base, 'bills');
+    const billListDir = join(base, 'bill-list'); // empty -> no cache at all
+    const rollcallDir = join(base, 'rollcalls');
+    const { client } = makeFakeMoHouseRunClient();
+
+    let listCalls = 0;
+    let xmlCalls = 0;
+    const fetchBillList = async (session) => { listCalls += 1; assert.equal(session, '261'); return threeBillListXml; };
+    const fetchBillXml = async () => { xmlCalls += 1; return hb2Xml; };
+
+    const args = parseMoHouseArgs(['--limit', '1']);
+    const result = await runMoHouse(client, args, {
+      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml,
+    });
+
+    assert.equal(listCalls, 1);
+    assert.equal(xmlCalls, 0, 'slot (a) must never also fetch a bill this same run — the exact defect this fix closes');
+    assert.equal(result.status, 'succeeded');
+    assert.equal(result.counts.slot, 'list-refresh');
+    assert.equal(result.counts.list_fetch_mode, 'live');
+    assert.equal(result.counts.bills_detailed, 0);
+    assert.equal(result.counts.bills_listed, 3);
+    assert.equal(result.counts.total_pending_bills, 3);
+    assert.ok(existsSync(join(billListDir, '261.json')), 'the freshly-fetched list must be cached for the NEXT invocation to read');
+  });
+});
+
+test('runMoHouse: SLOT (a) — a bill-list cache older than MO_BILL_LIST_MAX_AGE_MS is treated the same as missing', async () => {
+  await withScratchArtifactDirAsync(async (base) => {
+    const billsDir = join(base, 'bills');
+    const billListDir = join(base, 'bill-list');
+    const rollcallDir = join(base, 'rollcalls');
+    writeCachedBillList('261', [{ identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' }], billListDir);
+    // Back-date the cache file's fetched_at past the 24h threshold directly (writeCachedBillList
+    // always stamps "now").
+    const cachePath = join(billListDir, '261.json');
+    const stale = JSON.parse(readFileSync(cachePath, 'utf8'));
+    stale.fetched_at = new Date(Date.now() - (MO_BILL_LIST_MAX_AGE_MS + 60000)).toISOString();
+    writeFileSync(cachePath, JSON.stringify(stale, null, 2));
+
+    const { client } = makeFakeMoHouseRunClient();
+    let listCalls = 0;
+    const fetchBillList = async () => { listCalls += 1; return threeBillListXml; };
+    const fetchBillXml = async () => { throw new Error('must not fetch a bill this run'); };
+
+    const args = parseMoHouseArgs(['--limit', '1']);
+    const result = await runMoHouse(client, args, {
+      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml,
+    });
+
+    assert.equal(listCalls, 1);
+    assert.equal(result.counts.slot, 'list-refresh');
+  });
+});
+
+// ---- slot decision: fresh list -> bill slot ----
+
+test('runMoHouse: SLOT (b) — a fresh cached list reads it (zero live list fetches) and spends this run\'s one request on exactly ONE pending bill, not all pending bills', async () => {
+  await withScratchArtifactDirAsync(async (base) => {
+    const billsDir = join(base, 'bills');
+    const billListDir = join(base, 'bill-list');
+    const rollcallDir = join(base, 'rollcalls');
+    const entries = [
+      { identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' },
+      { identifier: 'HB 3', bill_xml_url: 'https://x/HB3.xml' },
+      { identifier: 'HB 4', bill_xml_url: 'https://x/HB4.xml' },
+    ];
+    writeCachedBillList('261', entries, billListDir); // fresh -> shouldRefetchBillList is false
+    const { client } = makeFakeMoHouseRunClient();
+
+    let listCalls = 0;
+    let xmlCalls = 0;
+    const fetchBillList = async () => { listCalls += 1; throw new Error('must not fetch the list live — the cache is fresh'); };
+    const fetchBillXml = async () => { xmlCalls += 1; return hb2Xml; };
+
+    const args = parseMoHouseArgs(['--limit', '1']);
+    const result = await runMoHouse(client, args, {
+      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml,
+    });
+
+    assert.equal(listCalls, 0);
+    assert.equal(xmlCalls, 1, 'exactly one bill fetched, not 3 — the one-live-request-per-run invariant');
+    assert.equal(result.status, 'succeeded');
+    assert.equal(result.counts.slot, 'bill-detail');
+    assert.equal(result.counts.list_fetch_mode, 'cached');
+    assert.equal(result.counts.bills_detailed, 1);
+    assert.equal(result.counts.total_pending_bills, 3, 'reports the backlog size BEFORE this run\'s own selection, mirroring ingest-mo-senate.js\'s total_pending_days');
+  });
+});
+
+// ---- slot decision: nothing pending -> honest no-op ----
+
+test('runMoHouse: SLOT (b) — nothing pending (every entry already enriched) is an honest no-op: zero live requests at all, status succeeded, bills_detailed 0', async () => {
+  await withScratchArtifactDirAsync(async (base) => {
+    const billsDir = join(base, 'bills');
+    const billListDir = join(base, 'bill-list');
+    const rollcallDir = join(base, 'rollcalls');
+    const entries = [{ identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' }];
+    writeCachedBillList('261', entries, billListDir);
+    writeEnrichedMarker('HB 2', {}, billsDir);
+    const { client } = makeFakeMoHouseRunClient();
+
+    let listCalls = 0;
+    let xmlCalls = 0;
+    const fetchBillList = async () => { listCalls += 1; throw new Error('must not fetch live'); };
+    const fetchBillXml = async () => { xmlCalls += 1; throw new Error('must not fetch live'); };
+
+    const args = parseMoHouseArgs(['--limit', '1']);
+    const result = await runMoHouse(client, args, {
+      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml,
+    });
+
+    assert.equal(listCalls, 0);
+    assert.equal(xmlCalls, 0);
+    assert.equal(result.status, 'succeeded');
+    assert.equal(result.counts.slot, 'bill-detail');
+    assert.equal(result.counts.bills_detailed, 0);
+    assert.equal(result.counts.total_pending_bills, 0);
+  });
+});
+
+// ---- explicit-file modes stay unaffected (point 6 of the fix) ----
+
+test('runMoHouse: --bill-xml-file makes ZERO live requests regardless of a missing bill-list cache — unaffected by the slot decision', async () => {
+  await withScratchArtifactDirAsync(async (base) => {
+    const billsDir = join(base, 'bills');
+    const billListDir = join(base, 'bill-list'); // empty -> would normally force slot (a)
+    const rollcallDir = join(base, 'rollcalls');
+    const { client } = makeFakeMoHouseRunClient();
+
+    let listCalls = 0;
+    let xmlCalls = 0;
+    const fetchBillList = async () => { listCalls += 1; throw new Error('must not fetch the list live — --bill-xml-file needs no list at all'); };
+    const fetchBillXml = async () => { xmlCalls += 1; throw new Error('must not fetch live — --bill-xml-file is a local fixture read'); };
+
+    const args = parseMoHouseArgs(['--bill', 'HB 2', '--bill-xml-file', `${FIXTURES}/HB2-bill-text-pdf-only.xml`]);
+    const result = await runMoHouse(client, args, {
+      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml,
+    });
+
+    assert.equal(listCalls, 0);
+    assert.equal(xmlCalls, 0);
+    assert.equal(result.status, 'succeeded');
+    assert.equal(result.counts.bills_detailed, 1);
+    assert.equal(result.counts.list_fetch_mode, 'fixture');
+    assert.equal(result.counts.bills_listed, null);
+    assert.equal(result.counts.total_pending_bills, null);
+  });
+});
+
+// ---- the one-live-request-per-run invariant, named explicitly ----
+
+test('runMoHouse: the one-live-request-per-run invariant — a multi-target scenario with a missing/stale list would have needed 2 live fetches under the old shape (list + bill); this run makes exactly 1', async () => {
+  await withScratchArtifactDirAsync(async (base) => {
+    const billsDir = join(base, 'bills');
+    const billListDir = join(base, 'bill-list'); // no cache at all -> stale/missing
+    const rollcallDir = join(base, 'rollcalls');
+    const { client } = makeFakeMoHouseRunClient();
+
+    let liveFetchCount = 0; // combined counter across BOTH fetch types — the actual invariant
+    const fetchBillList = async () => { liveFetchCount += 1; return threeBillListXml; };
+    const fetchBillXml = async () => { liveFetchCount += 1; return hb2Xml; };
+
+    const args = parseMoHouseArgs(['--limit', '1']);
+    const result = await runMoHouse(client, args, {
+      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml,
+    });
+
+    assert.equal(liveFetchCount, 1, 'exactly one live house.mo.gov request this run, regardless of how many bills are pending or whether the list was also stale');
+    assert.equal(result.status, 'succeeded');
+  });
 });
