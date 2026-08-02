# Review package — mo-senate session dedup root-cause fix (289a57c..01cc276)

01cc276 fix: mo-senate ensureSessionRow ports LegiScan's year+name session resolution (TODO 25 root cause)

## Stat
 .../2026-08-02-mo-senate-session-dedup/brief.md    | 109 ++++++++++++++++
 src/cli/ingest-mo-senate.js                        |  58 ++++++++-
 tests/ingest-mo-senate-cli.test.js                 | 140 +++++++++++++++++----
 3 files changed, 279 insertions(+), 28 deletions(-)

## Full diff (-U10)
diff --git a/.superpowers/sdd/2026-08-02-mo-senate-session-dedup/brief.md b/.superpowers/sdd/2026-08-02-mo-senate-session-dedup/brief.md
new file mode 100644
index 0000000..d06e874
--- /dev/null
+++ b/.superpowers/sdd/2026-08-02-mo-senate-session-dedup/brief.md
@@ -0,0 +1,109 @@
+# Task brief — TODO 25 root cause: mo-senate-web's session dedup misses non-bare-year rows
+
+Approved by Lance (2026-08-02: "proceed with non-usage items if you can" — this is the root-cause
+half of TODO 25, explicitly left open after yesterday's live merge: "the code that keeps creating
+the duplicate session row is unchanged and will make a fresh one on the next Senate-journal
+ingest"). Zero model calls, zero network calls — this is a pure code fix to session resolution.
+
+## The defect (confirmed live yesterday, now fixed at the data level, NOT at the code level)
+
+`ensureSessionRow(client, runId, year)` (`src/cli/ingest-mo-senate.js:470`) is called every time
+`ingest-mo-senate.js` processes a journal day. It does exactly ONE dedup check:
+
+```js
+const identifier = String(year);
+await insertIfAbsent(client, 'sessions', [{
+  jurisdiction_id: 'mo-legislature', identifier, name: `${year} Regular Session (MO Senate journals)`,
+}], 'jurisdiction_id,identifier');
+```
+
+That correctly dedupes against OpenStates' own bare-year rows (`'2018'`, `'2022'`, etc.) — but MO's
+CURRENT session is identified `'261'` (LegiScan's own scheme, `legiscan_session_id=2239`), not
+`'2026'`. `ensureSessionRow` has no way to discover that `'261'` already covers 2026, so it mints
+its own `'2026'` row every time — exactly what happened, verified live, and what a live correction
+(TODO 25, committed 2026-08-01) just cleaned up. **That cleanup is a one-time fix. This code is
+unchanged, so the very next `mo-senate-web` run that processes a 2026 journal day will recreate the
+duplicate.**
+
+## The fix already exists for a sibling problem — reuse it, do not reinvent
+
+`ensureLegiscanSessionRow` (`src/cli/ingest-legiscan.js:202-260`) solves the identical shape of
+problem (a Regular Session that may already have a row under a DIFFERENT identifier convention) via
+a proven, reviewed three-step resolution. Its "Step 2" is exactly the piece missing here:
+
+```js
+// Step 2: year+name mapping (CONTROLLER RULING 4, literal) — a Regular Session that already has
+// a row under a DIFFERENT pre-existing identifier convention (the real '261' case). Not a
+// single-row lookup, so selectAll (Ruling 10), never a bare .select().
+const { data: candidateRows, error: candErr } = await selectAll(client, 'sessions', 'id,identifier,name,legiscan_session_id', {
+  filter: (q) => q.eq('jurisdiction_id', 'mo-legislature'),
+});
+const yearNameCandidates = (candidateRows ?? []).filter((row) => (
+  row.identifier !== bareYear
+  && !SPECIAL_IDENTIFIER_PATTERN.test(row.identifier)
+  && typeof row.name === 'string'
+  && row.name.trim().startsWith(bareYear)
+));
+if (yearNameCandidates.length > 1) throw new AmbiguousLegiscanSessionMatchError(...);
+if (yearNameCandidates.length === 1) return patchSessionRow(client, yearNameCandidates[0], legiscanSessionId);
+```
+
+`ensureSessionRow` needs the SAME year+name-prefix resolution step, adapted (it has no
+`legiscan_session_id` to patch — mo-senate-web doesn't carry that field, so on a match it just
+resolves onto the existing row's id and returns, no patch write needed). It does NOT need
+`SPECIAL_IDENTIFIER_PATTERN` — confirmed by reading the file: mo-senate-web has no special-session
+identifier concept, `ensureSessionRow`'s `year` param is always a bare calendar year. Skip that
+guard; do not port a concept this file has no analog for.
+
+## Task
+
+Modify `ensureSessionRow` in `src/cli/ingest-mo-senate.js`:
+
+1. **Step 1 (unchanged):** exact bare-year match — if a row with `identifier = String(year)` already
+   exists, use it (current behavior, still correct, still the common case for older sessions where
+   no LegiScan session row was ever created under a different identifier).
+2. **Step 2 (new):** if no bare-year row exists, `selectAll` every `mo-legislature` session row and
+   look for one whose `identifier !== bareYear` AND whose `name` (trimmed) starts with the bare
+   year string. Mirror `ensureLegiscanSessionRow`'s own ambiguity guard EXACTLY: zero matches falls
+   through to step 3; exactly one match resolves onto that row (return its `{id}`, no write); MORE
+   THAN ONE match must throw a typed error naming every candidate — never guess between them, same
+   as the LegiScan sibling function does. Add a new typed error class (or reuse
+   `AmbiguousLegiscanSessionMatchError` if it's generic enough to import — check whether its
+   message/fields are LegiScan-specific before deciding; if they are, add a small analogous typed
+   error for this file instead of stretching an ill-fitting one).
+3. **Step 3 (existing behavior, now the true fallback):** the current `insertIfAbsent` + select path
+   — mint a new bare-year row. Only reached when steps 1 and 2 both found nothing.
+
+**Verify this actually closes the loop**, live and read-only (no writes): call the new resolution
+logic (or trace it manually via query) against the CURRENT real live DB state for `year=2026` and
+confirm it now resolves onto the canonical `'261'` session id — the exact session id the live
+TODO-25 correction merged everything into yesterday. This is the concrete proof the root cause is
+closed, not just that the code compiles.
+
+## Constraints
+
+- TDD red-first. Fixture/mock-client tests: (a) bare-year match still works (regression, existing
+  behavior preserved); (b) no bare-year row, but a differently-identified row's name starts with
+  the year → resolves onto it, zero writes; (c) two differently-identified candidate rows both
+  matching → throws, names both candidates, zero writes; (d) neither bare-year nor any name-prefix
+  match → falls through to creating a new bare-year row (existing step-3 behavior, still correct).
+  No live DB writes from tests.
+- `selectAll` for the candidate scan (never a bare `.select()` — this repo has been bitten by the
+  1000-row cap repeatedly; `sessions` is small today but the pattern must be right regardless).
+- Typed errors matching this repo's conventions (see `AmbiguousLegiscanSessionMatchError` for the
+  shape to match, even if you end up writing a new, smaller analog rather than reusing it directly).
+- Bare `node --test` from repo root; baseline currently ~2144+ (title-backfill's live run may have
+  changed nothing test-relevant, but re-check the actual current baseline before claiming a delta).
+- Extract the literal `ℹ fail` line yourself; commit ONLY at 0 (lesson 14 — never gate on a
+  pipeline's exit status).
+- This function is called by `ingest-mo-senate.js`'s live write path, which runs unattended forever
+  via the scheduler (`scripts/scheduled-ingest.js`, 30-min cadence). Do NOT touch the scheduler
+  file. Do NOT change `ensureSessionRow`'s signature or call sites beyond its own body — every
+  existing caller must keep working identically for every OTHER year this function has ever
+  resolved correctly (2015-2025 all still going through step 1 unchanged).
+- Commit message explains the defect and the fix, ends with:
+
+Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
+
+Return: status, commit hash, fail-count line verbatim, the live-verification result for year=2026
+(does it now resolve onto session '261'?), and concerns.
diff --git a/src/cli/ingest-mo-senate.js b/src/cli/ingest-mo-senate.js
index a0d6fdb..229eac5 100644
--- a/src/cli/ingest-mo-senate.js
+++ b/src/cli/ingest-mo-senate.js
@@ -1,15 +1,15 @@
 import {
   existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
 } from 'node:fs';
 import {
-  getClient, openRun, closeRun, insertIfAbsent, isMissingColumnError, isMissingRelationError,
+  getClient, openRun, closeRun, insertIfAbsent, selectAll, isMissingColumnError, isMissingRelationError,
 } from '../lib/db.js';
 import { fetchWithLimit } from '../lib/http.js';
 import { SourceFetchError } from '../lib/errors.js';
 import * as senateWeb from '../adapters/mo-senate-web.js';
 import * as journalPdf from '../adapters/mo-senate-journal-pdf.js';
 
 // Journals-first MO Senate driver: roster ensure -> journal-day worklist -> per-day PDF
 // extraction/parsing -> votes + gated casts. Separate small CLI (same rationale as
 // ingest-mo-house.js's own module comment: a 30-minute mechanically-enforced cadence and a
 // fetch-list-then-loop-per-item shape that doesn't fit ingest.js's one-collect-call-per-source
@@ -458,24 +458,78 @@ export async function enforceDurableCooldown(
   }
   throw new CooldownConvergenceError(
     `mo-senate cooldown did not converge after ${maxIterations} fresh re-checks — this should be `
       + 'impossible in normal operation; failing loud rather than looping forever',
     { maxIterations, minIntervalMs },
   );
 }
 
 // ---- session + roster persistence ----
 
+// TODO 25 root cause (.superpowers/sdd/2026-08-02-mo-senate-session-dedup/brief.md): MO's CURRENT
+// session is identified '261' (LegiScan's own scheme), not a bare calendar year — a bare-year-only
+// dedup has no way to discover that, so it re-minted a duplicate '2026' row on every journal-day
+// ingest (confirmed live; cleaned up once by TODO 25's live correction, but that cleanup is
+// one-time data surgery, not a code fix — this function was unchanged and would recreate the
+// duplicate on the very next run). Thrown here, never guessed.
+export class AmbiguousMoSenateSessionMatchError extends Error {
+  constructor(message, meta = {}) {
+    super(message);
+    this.name = 'AmbiguousMoSenateSessionMatchError';
+    Object.assign(this, meta);
+  }
+}
+
 // task-5-brief.md step 2, exact row shape: identifier deliberately collides with OpenStates' own
-// year-keyed session rows so both sources dedupe to one row.
+// year-keyed session rows so both sources dedupe to one row. EXTENDED (TODO 25 root cause, see
+// AmbiguousMoSenateSessionMatchError's own comment above): step 2 below ports
+// ensureLegiscanSessionRow's own year+name resolution (src/cli/ingest-legiscan.js) — the proven,
+// reviewed fix for the identical problem shape (a Regular Session that may already have a row
+// under a DIFFERENT pre-existing identifier convention) — adapted for this file: no
+// legiscan_session_id to patch here (mo-senate-web carries no such column), so a match just
+// resolves onto the existing row's id, no write. No SPECIAL_IDENTIFIER_PATTERN guard ported —
+// this driver's `year` param is always a bare calendar year; it has no special-session identifier
+// concept of its own for that guard to protect against (confirmed by reading this whole file).
 export async function ensureSessionRow(client, runId, year) {
   const identifier = String(year);
+
+  // Step 1 (unchanged): exact bare-year match — still the common case for older sessions where no
+  // LegiScan session row was ever created under a different identifier.
+  const { data: bareYearRow, error: bareYearErr } = await client.from('sessions').select('id')
+    .eq('jurisdiction_id', 'mo-legislature').eq('identifier', identifier).maybeSingle();
+  if (bareYearErr) throw new Error(`mo-senate bare-year session lookup failed: ${bareYearErr.message}`);
+  if (bareYearRow) return { id: bareYearRow.id };
+
+  // Step 2 (new): year+name mapping — a Regular Session that already has a row under a DIFFERENT
+  // pre-existing identifier convention (the real '261' case). selectAll, never a bare .select()
+  // (this repo has been bitten by the 1000-row cap repeatedly) — sessions is small today but the
+  // pattern must be right regardless.
+  const { data: candidateRows, error: candErr } = await selectAll(client, 'sessions', 'id,identifier,name', {
+    filter: (q) => q.eq('jurisdiction_id', 'mo-legislature'),
+  });
+  if (candErr) throw new Error(`mo-senate session year/name candidate lookup failed: ${candErr.message}`);
+  const yearNameCandidates = (candidateRows ?? []).filter((row) => (
+    row.identifier !== identifier
+    && typeof row.name === 'string'
+    && row.name.trim().startsWith(identifier)
+  ));
+  if (yearNameCandidates.length > 1) {
+    throw new AmbiguousMoSenateSessionMatchError(
+      `mo-senate: year ${identifier} matches ${yearNameCandidates.length} existing sessions rows by `
+        + `year+name — never guessed between them: ${yearNameCandidates.map((r) => `${r.identifier} (${r.name})`).join(', ')}`,
+      { year: identifier, candidates: yearNameCandidates },
+    );
+  }
+  if (yearNameCandidates.length === 1) return { id: yearNameCandidates[0].id };
+
+  // Step 3 (existing behavior, now the true fallback): only reached when steps 1 and 2 both found
+  // nothing — mint a new bare-year row.
   await insertIfAbsent(client, 'sessions', [{
     jurisdiction_id: 'mo-legislature', identifier, name: `${year} Regular Session (MO Senate journals)`,
   }], 'jurisdiction_id,identifier');
   const { data, error } = await client.from('sessions').select('id')
     .eq('jurisdiction_id', 'mo-legislature').eq('identifier', identifier).single();
   if (error) throw new Error(`mo-senate session lookup failed: ${error.message}`);
   return data;
 }
 
 // ---- roster identity (FIX ROUND 1, CRITICAL — cross-era mo_senate_id collision) ----
diff --git a/tests/ingest-mo-senate-cli.test.js b/tests/ingest-mo-senate-cli.test.js
index 08ad2c3..133c398 100644
--- a/tests/ingest-mo-senate-cli.test.js
+++ b/tests/ingest-mo-senate-cli.test.js
@@ -8,21 +8,21 @@ import assert from 'node:assert/strict';
 import { parseJournalIndex } from '../src/adapters/mo-senate-web.js';
 import { extractJournalText, parseJournalVotes, resolveMoSenator } from '../src/adapters/mo-senate-journal-pdf.js';
 import {
   parseMoSenateArgs, journalPdfBasename, buildVoteSourceKey, buildVoteRow, buildCastTokens,
   pickRosterSource, RosterSourceUnavailableError, buildJournalIndexUrl, shouldRefetch, effectiveMaxAge,
   MO_SENATE_ROSTER_MAX_AGE_MS, MO_SENATE_INDEX_MAX_AGE_MS,
   readDayFailureArtifact, writeDayFailureArtifact, excludeQuarantinedDays, listQuarantinedDays, JOURNAL_DAY_MAX_FAILED_ATTEMPTS,
   hasDoneMarker, writeDoneMarker,
   selectJournalDayWorklist,
   remainingCooldownMs, formatCooldownWait, enforceDurableCooldown, CooldownConvergenceError,
-  ensureSessionRow, ensureRosterIdentities,
+  ensureSessionRow, AmbiguousMoSenateSessionMatchError, ensureRosterIdentities,
   ensureRosterForRun, ensureIndexForRun,
   processJournalDay, replayJournalArtifacts, dryRunReport,
   runMoSenate,
 } from '../src/cli/ingest-mo-senate.js';
 import { SourceFetchError } from '../src/lib/errors.js';
 
 const FIXTURES = 'tests/fixtures/research/mo-senate';
 const day37Pdf = readFileSync(`${FIXTURES}/2018-day37-journal-onder-era.pdf`);
 const day39Pdf = readFileSync(`${FIXTURES}/2026-day39-journal.pdf`);
 const journalList2018Html = readFileSync(`${FIXTURES}/journallist-2018.html`, 'utf8');
@@ -507,57 +507,133 @@ test('enforceDurableCooldown: a lookup failure is a hard error, never silently s
     () => enforceDurableCooldown(client, 30 * 60 * 1000, { sleep: async () => {} }),
     /mo-senate cooldown lookup failed: connection refused/,
   );
 });
 
 test('remainingCooldownMs / formatCooldownWait: pure helpers', () => {
   assert.equal(remainingCooldownMs(null, 1000), 0);
   assert.equal(formatCooldownWait(65000), '1m 5s');
 });
 
-// ---- session ensure ----
+// ---- session ensure (TODO 25 root cause fix, 2026-08-02 —
+// .superpowers/sdd/2026-08-02-mo-senate-session-dedup/brief.md) ----
+//
+// A fuller in-memory 'sessions' table fake, wide enough to drive ensureSessionRow's three-step
+// resolution (bare-year exact match -> selectAll year+name candidate scan -> insertIfAbsent mint)
+// — same query shapes (select/eq/order/range/maybeSingle/single/upsert) as
+// ensureLegiscanSessionRow's own test fake (tests/ingest-legiscan-cli.test.js's makeQueryBuilder/
+// makeFakeLegiscanClient), scoped to just this one table since that's all this file's session
+// tests touch.
+function applyMoSessionFilters(rows, filters) {
+  return rows.filter((row) => filters.every((f) => row[f.col] === f.val));
+}
 
-function fakeSessionClient(existingRows = []) {
+function makeFakeSessionsClient(seedRows = []) {
+  const rows = seedRows.map((r) => ({ ...r }));
   const upserts = [];
-  const rows = [...existingRows];
-  return {
-    upserts,
-    client: {
-      from(table) {
-        assert.equal(table, 'sessions');
-        return {
-          upsert: async (r, opts) => { upserts.push({ rows: r, opts }); rows.push(...r.map((x) => ({ id: 'sess-1', ...x }))); return { error: null }; },
-          select: () => ({
-            eq: (c1, v1) => ({
-              eq: (c2, v2) => ({
-                single: async () => {
-                  const found = rows.find((r) => r[c1] === v1 && r[c2] === v2);
-                  return found ? { data: { id: found.id }, error: null } : { data: null, error: { message: 'not found' } };
-                },
-              }),
-            }),
-          }),
-        };
-      },
+  let counter = 0;
+  const client = {
+    from(table) {
+      assert.equal(table, 'sessions');
+      const buildQuery = (filters) => ({
+        eq: (col, val) => buildQuery([...filters, { col, val }]),
+        order: () => buildQuery(filters),
+        range: (from, to) => {
+          const matched = applyMoSessionFilters(rows, filters);
+          return Promise.resolve({ data: matched.slice(from, to + 1).map((r) => ({ ...r })), error: null });
+        },
+        maybeSingle: async () => {
+          const matched = applyMoSessionFilters(rows, filters);
+          return { data: matched[0] ? { ...matched[0] } : null, error: null };
+        },
+        single: async () => {
+          const matched = applyMoSessionFilters(rows, filters);
+          if (matched.length !== 1) return { data: null, error: { message: `fake sessions db: expected 1 row, got ${matched.length}` } };
+          return { data: { ...matched[0] }, error: null };
+        },
+      });
+      return {
+        select: () => buildQuery([]),
+        upsert: async (newRows, opts) => {
+          upserts.push({ rows: newRows, opts });
+          const conflictCols = (opts?.onConflict || '').split(',').filter(Boolean);
+          for (const r of newRows) {
+            const existing = conflictCols.length > 0 ? rows.find((row) => conflictCols.every((c) => row[c] === r[c])) : null;
+            if (!existing) {
+              counter += 1;
+              rows.push({ id: `sess-${counter}`, ...r });
+            }
+          }
+          return { error: null };
+        },
+      };
     },
   };
+  return { client, rows, upserts };
 }
 
-test('ensureSessionRow: inserts the exact row shape (task-5-brief.md step 2) and selects it back', async () => {
-  const { client, upserts } = fakeSessionClient();
+// (a) regression: a pre-existing bare-year row still resolves via step 1, zero writes.
+test('ensureSessionRow: (a) an existing bare-year row still resolves onto it directly (step 1, regression) — zero writes', async () => {
+  const { client, rows, upserts } = makeFakeSessionsClient([
+    { id: 'sess-2018', jurisdiction_id: 'mo-legislature', identifier: '2018', name: '2018 Regular Session' },
+  ]);
+  const row = await ensureSessionRow(client, 'run-1', 2018);
+  assert.equal(row.id, 'sess-2018');
+  assert.equal(upserts.length, 0, 'step 1 match must never fall through to an insert');
+  assert.equal(rows.length, 1, 'no new row created');
+});
+
+// (b) the real TODO-25 shape: no bare-year '2026' row, but '261' already exists and its name
+// starts with '2026' — resolves onto it via step 2, zero writes, never mints a duplicate '2026'.
+test('ensureSessionRow: (b) no bare-year row, but a differently-identified row\'s name starts with the year (the real \'261\' case) — resolves onto it via step 2, zero writes', async () => {
+  const { client, rows, upserts } = makeFakeSessionsClient([
+    { id: 'sess-261', jurisdiction_id: 'mo-legislature', identifier: '261', name: '2026 2nd Regular, 103rd General Assembly' },
+  ]);
+  const row = await ensureSessionRow(client, 'run-1', 2026);
+  assert.equal(row.id, 'sess-261');
+  assert.equal(upserts.length, 0, 'step 2 match must never fall through to an insert');
+  assert.equal(rows.length, 1, 'no duplicate \'2026\' row created');
+  assert.equal(rows.some((r) => r.identifier === '2026'), false);
+});
+
+// (c) two differently-identified candidates both matching by year+name is genuinely ambiguous —
+// never guess between them, name both candidates in the thrown error, zero writes.
+test('ensureSessionRow: (c) two differently-identified year+name candidates is genuinely ambiguous — throws naming both, zero writes', async () => {
+  const { client, rows, upserts } = makeFakeSessionsClient([
+    { id: 'sess-261', jurisdiction_id: 'mo-legislature', identifier: '261', name: '2026 2nd Regular, 103rd General Assembly' },
+    { id: 'sess-extra', jurisdiction_id: 'mo-legislature', identifier: 'extra-2026-row', name: '2026 Special Legislative Something' },
+  ]);
+  await assert.rejects(
+    () => ensureSessionRow(client, 'run-1', 2026),
+    (err) => {
+      assert.ok(err instanceof AmbiguousMoSenateSessionMatchError);
+      assert.match(err.message, /261/);
+      assert.match(err.message, /extra-2026-row/);
+      return true;
+    },
+  );
+  assert.equal(upserts.length, 0, 'an ambiguous match must never fall through to an insert');
+  assert.equal(rows.length, 2, 'no row was created or mutated');
+});
+
+// (d) existing step-3 behavior, now the true fallback: neither a bare-year nor a name-prefix
+// match exists — mints a new bare-year row (task-5-brief.md step 2's original row shape).
+test('ensureSessionRow: (d) neither a bare-year nor any name-prefix match — falls through to creating a new bare-year row (step 3)', async () => {
+  const { client, rows, upserts } = makeFakeSessionsClient();
   const row = await ensureSessionRow(client, 'run-1', 2018);
   assert.equal(upserts.length, 1);
   assert.deepEqual(upserts[0].rows, [{
     jurisdiction_id: 'mo-legislature', identifier: '2018', name: '2018 Regular Session (MO Senate journals)',
   }]);
   assert.equal(upserts[0].opts.onConflict, 'jurisdiction_id,identifier');
-  assert.equal(row.id, 'sess-1');
+  assert.equal(rows.length, 1);
+  assert.equal(row.id, rows[0].id);
 });
 
 // ---- roster identity (FIX ROUND 1, CRITICAL — cross-era mo_senate_id collision) ----
 //
 // In-memory fake modeling the real legislators table across the fix. `uniqueMoSenateId: true`
 // simulates the world BEFORE migration 0009 is applied (0008's still-live unique index on
 // mo_senate_id rejects a second row for an already-claimed district with Postgres 23505, the
 // reviewer's exact repro); `uniqueMoSenateId: false` simulates the world AFTER 0009 (a plain
 // non-unique index — multiple eras' occupants of the same district can each get their own row).
 // `missingColumn: true` simulates 0008 itself not being applied at all (PGRST204) — orthogonal to
@@ -1446,20 +1522,32 @@ function makeGenericTable(store, idPrefix) {
         const exists = conflictCols.length > 0
           && store.some((r) => conflictCols.every((c) => r[c] === row[c]));
         if (!exists) { counter += 1; store.push({ id: `${idPrefix}-${counter}`, ...row }); }
       }
       return { error: null };
     },
     select() {
       const filters = [];
       const builder = {
         eq(col, val) { filters.push([col, val]); return builder; },
+        // order/range: ensureSessionRow's step-2 selectAll scan (src/lib/db.js) issues these on
+        // this same table — order is a no-op here (single-page fixtures, ordering doesn't matter
+        // for correctness), range resolves the paginated read.
+        order() { return builder; },
+        range: async (from, to) => {
+          const found = store.filter((r) => filters.every(([c, v]) => r[c] === v));
+          return { data: found.slice(from, to + 1), error: null };
+        },
+        maybeSingle: async () => {
+          const found = store.filter((r) => filters.every(([c, v]) => r[c] === v));
+          return { data: found[0] ?? null, error: null };
+        },
         single: async () => {
           const found = store.filter((r) => filters.every(([c, v]) => r[c] === v));
           if (found.length !== 1) return { data: null, error: { message: `expected 1 row for a fake table, got ${found.length}` } };
           return { data: found[0], error: null };
         },
       };
       return builder;
     },
   };
 }
