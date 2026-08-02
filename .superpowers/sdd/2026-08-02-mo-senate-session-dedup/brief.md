# Task brief — TODO 25 root cause: mo-senate-web's session dedup misses non-bare-year rows

Approved by Lance (2026-08-02: "proceed with non-usage items if you can" — this is the root-cause
half of TODO 25, explicitly left open after yesterday's live merge: "the code that keeps creating
the duplicate session row is unchanged and will make a fresh one on the next Senate-journal
ingest"). Zero model calls, zero network calls — this is a pure code fix to session resolution.

## The defect (confirmed live yesterday, now fixed at the data level, NOT at the code level)

`ensureSessionRow(client, runId, year)` (`src/cli/ingest-mo-senate.js:470`) is called every time
`ingest-mo-senate.js` processes a journal day. It does exactly ONE dedup check:

```js
const identifier = String(year);
await insertIfAbsent(client, 'sessions', [{
  jurisdiction_id: 'mo-legislature', identifier, name: `${year} Regular Session (MO Senate journals)`,
}], 'jurisdiction_id,identifier');
```

That correctly dedupes against OpenStates' own bare-year rows (`'2018'`, `'2022'`, etc.) — but MO's
CURRENT session is identified `'261'` (LegiScan's own scheme, `legiscan_session_id=2239`), not
`'2026'`. `ensureSessionRow` has no way to discover that `'261'` already covers 2026, so it mints
its own `'2026'` row every time — exactly what happened, verified live, and what a live correction
(TODO 25, committed 2026-08-01) just cleaned up. **That cleanup is a one-time fix. This code is
unchanged, so the very next `mo-senate-web` run that processes a 2026 journal day will recreate the
duplicate.**

## The fix already exists for a sibling problem — reuse it, do not reinvent

`ensureLegiscanSessionRow` (`src/cli/ingest-legiscan.js:202-260`) solves the identical shape of
problem (a Regular Session that may already have a row under a DIFFERENT identifier convention) via
a proven, reviewed three-step resolution. Its "Step 2" is exactly the piece missing here:

```js
// Step 2: year+name mapping (CONTROLLER RULING 4, literal) — a Regular Session that already has
// a row under a DIFFERENT pre-existing identifier convention (the real '261' case). Not a
// single-row lookup, so selectAll (Ruling 10), never a bare .select().
const { data: candidateRows, error: candErr } = await selectAll(client, 'sessions', 'id,identifier,name,legiscan_session_id', {
  filter: (q) => q.eq('jurisdiction_id', 'mo-legislature'),
});
const yearNameCandidates = (candidateRows ?? []).filter((row) => (
  row.identifier !== bareYear
  && !SPECIAL_IDENTIFIER_PATTERN.test(row.identifier)
  && typeof row.name === 'string'
  && row.name.trim().startsWith(bareYear)
));
if (yearNameCandidates.length > 1) throw new AmbiguousLegiscanSessionMatchError(...);
if (yearNameCandidates.length === 1) return patchSessionRow(client, yearNameCandidates[0], legiscanSessionId);
```

`ensureSessionRow` needs the SAME year+name-prefix resolution step, adapted (it has no
`legiscan_session_id` to patch — mo-senate-web doesn't carry that field, so on a match it just
resolves onto the existing row's id and returns, no patch write needed). It does NOT need
`SPECIAL_IDENTIFIER_PATTERN` — confirmed by reading the file: mo-senate-web has no special-session
identifier concept, `ensureSessionRow`'s `year` param is always a bare calendar year. Skip that
guard; do not port a concept this file has no analog for.

## Task

Modify `ensureSessionRow` in `src/cli/ingest-mo-senate.js`:

1. **Step 1 (unchanged):** exact bare-year match — if a row with `identifier = String(year)` already
   exists, use it (current behavior, still correct, still the common case for older sessions where
   no LegiScan session row was ever created under a different identifier).
2. **Step 2 (new):** if no bare-year row exists, `selectAll` every `mo-legislature` session row and
   look for one whose `identifier !== bareYear` AND whose `name` (trimmed) starts with the bare
   year string. Mirror `ensureLegiscanSessionRow`'s own ambiguity guard EXACTLY: zero matches falls
   through to step 3; exactly one match resolves onto that row (return its `{id}`, no write); MORE
   THAN ONE match must throw a typed error naming every candidate — never guess between them, same
   as the LegiScan sibling function does. Add a new typed error class (or reuse
   `AmbiguousLegiscanSessionMatchError` if it's generic enough to import — check whether its
   message/fields are LegiScan-specific before deciding; if they are, add a small analogous typed
   error for this file instead of stretching an ill-fitting one).
3. **Step 3 (existing behavior, now the true fallback):** the current `insertIfAbsent` + select path
   — mint a new bare-year row. Only reached when steps 1 and 2 both found nothing.

**Verify this actually closes the loop**, live and read-only (no writes): call the new resolution
logic (or trace it manually via query) against the CURRENT real live DB state for `year=2026` and
confirm it now resolves onto the canonical `'261'` session id — the exact session id the live
TODO-25 correction merged everything into yesterday. This is the concrete proof the root cause is
closed, not just that the code compiles.

## Constraints

- TDD red-first. Fixture/mock-client tests: (a) bare-year match still works (regression, existing
  behavior preserved); (b) no bare-year row, but a differently-identified row's name starts with
  the year → resolves onto it, zero writes; (c) two differently-identified candidate rows both
  matching → throws, names both candidates, zero writes; (d) neither bare-year nor any name-prefix
  match → falls through to creating a new bare-year row (existing step-3 behavior, still correct).
  No live DB writes from tests.
- `selectAll` for the candidate scan (never a bare `.select()` — this repo has been bitten by the
  1000-row cap repeatedly; `sessions` is small today but the pattern must be right regardless).
- Typed errors matching this repo's conventions (see `AmbiguousLegiscanSessionMatchError` for the
  shape to match, even if you end up writing a new, smaller analog rather than reusing it directly).
- Bare `node --test` from repo root; baseline currently ~2144+ (title-backfill's live run may have
  changed nothing test-relevant, but re-check the actual current baseline before claiming a delta).
- Extract the literal `ℹ fail` line yourself; commit ONLY at 0 (lesson 14 — never gate on a
  pipeline's exit status).
- This function is called by `ingest-mo-senate.js`'s live write path, which runs unattended forever
  via the scheduler (`scripts/scheduled-ingest.js`, 30-min cadence). Do NOT touch the scheduler
  file. Do NOT change `ensureSessionRow`'s signature or call sites beyond its own body — every
  existing caller must keep working identically for every OTHER year this function has ever
  resolved correctly (2015-2025 all still going through step 1 unchanged).
- Commit message explains the defect and the fix, ends with:

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

Return: status, commit hash, fail-count line verbatim, the live-verification result for year=2026
(does it now resolve onto session '261'?), and concerns.

---

## Ledger

Review 1: SHIP, but Important-1 found the brief's own reasoning for skipping
SPECIAL_IDENTIFIER_PATTERN was wrong — the risk isn't whether mo-senate-web has a special-session
concept (it doesn't), it's that the shared `sessions` table already contains LegiScan-minted
special-session rows this scan doesn't exclude. Fails loud (never silently wrong), dormant today
(2026 is a Regular session), but a real gap, not a hypothetical one.

Closed directly (small, well-scoped, high context already loaded): exported
SPECIAL_IDENTIFIER_PATTERN from ingest-legiscan.js (additive), added the same exclusion to
ensureSessionRow's candidate filter. Proven genuinely load-bearing by reverting the src fix and
confirming the new test (e) throws the exact false-ambiguity error the review predicted, then
restoring and confirming green. Full suite 2148/0.

Also, independently, before this: found and removed a fresh EMPTY duplicate '2026' session row
(0 bills attached) that the OLD code minted during the gap between yesterday's TODO-25 cleanup and
this fix landing — verified empty before deleting, then traced the fixed resolution logic against
live post-delete data and confirmed year=2026 now resolves onto session '261' (the canonical row)
with zero ambiguity. TODO 25 root cause is closed: mechanically, verified, and battle-tested
against the exact false-positive scenario a reviewer found.
