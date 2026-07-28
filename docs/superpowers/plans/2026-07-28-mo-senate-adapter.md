# MO Senate Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Individual MO Senate roll-call votes (Onder's 2015-2023 Senate era and any senator since) ingested from senate.mo.gov journal day-PDFs into the canonical votes/vote_casts tables, with the same reconcile-or-throw integrity gate and fail-loud identity resolution as the MO House pipeline.

**Architecture:** **Journals-first.** Each day's journal PDF is self-contained — every vote block names its own bill in the motion text — so the vote pipeline never touches the fragile HTML-fragment billId scrape at all. Discovery enumerates day-journal URLs, one fetch yields ~a dozen votes, each block reconciles against its printed per-category `—N` tallies or is never stored. A senate.mo.gov roster page (per session year) supplies the surname→identity mapping (34 seats). HTML-fragment bill endpoints (`BillTracking/.../handler=Actions` etc.) are explicitly OUT OF SCOPE for this plan — they serve later metadata enrichment, not votes.

**Tech Stack:** existing Node ESM project; NO new dependencies (pdfjs-dist 6.1.200 legacy build already pinned; fetchWithLimit/createLimiter/insertIfAbsent/additivePatch as-is). Reference doc (binding evidence): `docs/research/2026-07-28-mo-senate-sources.md`.

## Global Constraints

- **Fixture-first; THE FIXTURE IS THE SOURCE OF TRUTH.** URL shapes and page structures written below are research-derived guesses until a real captured payload confirms them; when they disagree, follow the payload and document the correction. Existing real fixtures: `tests/fixtures/research/mo-senate/2018-day37-journal-onder-era.pdf` (13 votes, Onder-era, text-layer), `find-voting-records.html`, action-fragment HTMLs.
- **Politeness:** one-time capture sessions use the research precedent (self-identifying User-Agent, ≥2s spacing, stated request budget, log every URL). The ONGOING pipeline uses the House-conservative cadence: `createLimiter({ minIntervalMs: 30*60*1000 })` shared per-process + the durable cross-process cooldown pattern keyed on `ingestion_runs.source='mo-senate-web'` (research Q4: no Senate ToU found; do not assume silence means faster).
- **Reconcile-or-throw (non-negotiable):** a vote block whose parsed surnames-per-category don't equal that category's printed `—<count>` is NEVER stored — typed `JournalParseError`, honest failure counts. Never store what you can't reconcile.
- **Fail-loud identity:** `resolveMoSenator` returns `legislator_id` on exactly 1 roster match else `null`; unresolved casts are recorded in run detail and skipped, never guessed, never placeholder-inserted.
- **Skip≠empty; typed errors; no silent fallbacks.** Additive DB writes only (`insertIfAbsent` / `additivePatch`); provenance `run_id` on every row; API keys never in URLs.
- **Draft-then-apply:** migration 0008 is written + committed; Lance applies it. Everything gated on it degrades gracefully (`isMissingColumnError` / artifact-and-replay pattern from `ingest-mo-house.js`).
- **No LLM calls anywhere in this plan.** Plain ingestion needs no per-run approval; model-calling summarization of MO bills stays out of scope.
- node:test via bare `node --test` (Node 24 Windows: never pass a dir arg); full suite (424 baseline) stays green every task. Commits end: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Live capture — roster pages, journal index, second journal day (bounded, ≤14 requests)

**Files:**
- Create: `tests/fixtures/research/mo-senate/` additions (see below)
- Modify: `tests/fixtures/research/SOURCES.md` (append exact URLs + dates + request count)

**What to capture** (2s spacing, self-identifying UA `VisibleGov research (contact: repo owner)`, log each URL; budget ≤14 requests including misses; STOP at budget and report if the shapes can't be found — do not brute-force):
1. **Journal index/list page** for 2018 and for the current year — start at `https://www.senate.mo.gov/journallist/` (research-verified to exist with a year selector); capture the HTML that enumerates day-journal links for a chosen year. Save as `journallist-2018.html`, `journallist-current.html`.
2. **Senate roster page** for 2018 and current year — the `<yy>info` archive tree is verified real (`/18info/pdf-jrnl/DAY37.pdf` works); look for the roster/member listing linked from the journal-list or `senate.mo.gov` nav (candidates to try, in order: `/18info/SenateRoster.htm`, `/18info/senalpha.htm`, the members page linked from the year's archive landing page). MUST contain, per senator: name (at minimum surname), district number, party if printed. Save as `roster-2018.html`, `roster-current.html`.
3. **One more journal day PDF from a different year than 2018** (any small/quiet day from the current year's list) — to confirm the vote-block format is stable across sessions before the parser hard-codes it. Save as `<year>-day<NN>-journal.pdf`.

- [ ] Capture per above; append every URL + date + total request count to SOURCES.md; note any shape corrections vs this plan's guesses.
- [ ] Commit: `chore: capture MO Senate roster/journal-index fixtures (research-budgeted)`

**Produces (for later tasks):** real HTML/PDF fixtures anchoring every parser test; the confirmed roster-page URL pattern and journal-index URL pattern, documented in SOURCES.md.

### Task 2: Migration 0008 — `mo_senate_id` identity column (draft; Lance applies)

**Files:**
- Create: `supabase/migrations/0008_mo_senate_id.sql`
- Test: extend `tests/` migration-shape test conventions if present for 0005 (mirror them; else skip test)

Mirror migration 0005's `mo_house_id` exactly:

```sql
-- MO Senate identity key: the senator's district number as text ('1'..'34'), the stable
-- per-session identity the senate.mo.gov roster page prints. Same pattern as 0005's
-- mo_house_id. Identity merge across source systems (bioguide/openstates/mo_house/mo_senate
-- rows for the same person, e.g. Onder) remains TODO item 8 - this column does NOT attempt it.
alter table legislators add column mo_senate_id text;
create unique index legislators_mo_senate_id_uidx on legislators (mo_senate_id) where mo_senate_id is not null;
```

- [ ] Write SQL exactly as above (adjust only if 0005's actual file uses a different naming convention — read it first and mirror it) → commit `feat: migration 0008 - mo_senate_id identity column (draft; Lance applies)`.

**Produces:** the identity column every cast write gates on. NOT applied until Lance runs it — Task 5's driver must behave honestly without it.

### Task 3: `src/adapters/mo-senate-web.js` — roster + journal-index parsing, shared limiter

**Files:**
- Create: `src/adapters/mo-senate-web.js`, `tests/mo-senate-web.test.js`
- Fixtures: from Task 1

**Interfaces (Produces):**
```js
export const SOURCE = 'mo-senate-web';
export const MO_SENATE_MIN_INTERVAL_MS = 30 * 60 * 1000;   // House-conservative cadence (research Q4)
export const moSenateLimiter = createLimiter({ minIntervalMs: MO_SENATE_MIN_INTERVAL_MS });
export function parseSenateRoster(html) -> [{ mo_senate_id, surname, full_name, party|null }]
export function parseJournalIndex(html) -> [{ day_label, journal_url }]   // absolute URLs
export function fetchSenateRoster(url, limiter = moSenateLimiter)         // as:'text'
export function fetchJournalIndex(url, limiter = moSenateLimiter)         // as:'text'
export function fetchSenateJournalPdf(url, limiter = moSenateLimiter)     // as:'arrayBuffer'
```

- [ ] TDD off the real fixtures: roster parse yields 34 rows for 2018 (or the fixture's true count — assert the REAL number, plus spot-assert Onder: surname `Onder`, district `2`); journal index yields Day 37's URL among 2018 entries; both parsers throw a typed error (plain `Error` with a clear message is fine here, matching `parseMoRepresentative`'s precedent) on structurally-unrecognizable HTML rather than returning [].
- [ ] Implement minimal (regex/string extraction driven by the fixture's actual CSS/markup — no new HTML-parsing dependency), green, commit `feat: mo-senate-web adapter - roster + journal index (fixture-backed)`.

### Task 4: `src/adapters/mo-senate-journal-pdf.js` — multi-vote journal parser + reconcile gate + resolution

**Files:**
- Create: `src/adapters/mo-senate-journal-pdf.js`, `tests/mo-senate-journal-pdf.test.js`

**Interfaces (Produces):**
```js
export class JournalParseError extends Error   // meta-carrying, mirrors RollCallParseError
export async function extractJournalText(pdfBuffer) -> string
export function parseJournalVotes(text) -> [{
  ordinal,            // 1-based order within the day (stable: the PDF is immutable)
  motion,             // verbatim motion sentence, e.g. 'On motion of Senator X, SS for SCS for SBs 894 & 921 ... was read the 3rd time and passed by the following vote:'
  bill_refs,          // mechanically extracted, normalized: ['SB 894', 'SB 921'] (first = primary)
  yeas, nays, absent, absentWithLeave,   // arrays of bare surnames as printed
  vacancies,          // number
  tallies             // { yeas: N, nays: N, absent: N|0 } — the printed —N per category
}]
export function resolveMoSenator(surname, roster) -> legislator_id | null
  // roster rows: { legislator_id, surname, mo_senate_id } — fail-loud like resolveMoRep
```

**Implementation notes (from the verified fixture format, research Q2):**
- `extractJournalText`: reuse `mo-rollcall-pdf.js`'s exact pdfjs-dist legacy-build pattern (Uint8Array conversion, sequential pages). The Senate journal is justified flowing text, not a grid — VERIFY against the real Day 37 fixture whether the coordinate-based row reconstruction or plain stream order is correct, and write down which in a comment (research flags this as needs-reverifying, not assumable).
- Vote blocks anchor on `by the following vote:` (covers 'passed by the following vote:', 'adopted by the following vote:', etc.); each block's categories are `YEAS—Senators`, `NAYS—Senators`, `Absent—Senators`, `Absent with leave—Senators`, `Vacancies—<N>`; a category's surname run terminates at the next category header; the last surname in a run carries `—<count>`. Categories can print `—None`. Em-dash vs hyphen: match what the extracted text ACTUALLY contains (check both `—` and `-`), assert from the fixture.
- Surnames may be hyphenated (`Chappelle-Nadal` is IN the real 2018 fixture — the House parser's known hyphen gap does NOT carry over; the surname token pattern must accept hyphens from day one).
- **Reconcile gate per category per block:** parsed surname count must equal that category's printed `—<count>` (Absent-with-leave and Vacancies have counts too where printed; reconcile every category that prints one) else `JournalParseError` naming the block ordinal and category. One bad block fails THAT block (typed, counted); other blocks in the same day still parse — return shape must make per-block failure recordable (throwing from parseJournalVotes kills the whole day; instead return `{ votes, failures }` — deviation from the single-vote House parser, justified: one day = many independent votes).
- `bill_refs`: from the motion text, match bill tokens `((?:SS|SCS|HS|HCS|CCS)\s+for\s+)*(SB|HB|SJR|HJR|SCR|HCR)s?\s*\d+(\s*&\s*\d+)*` and normalize each number to `'<TYPE> <NNN>'` (combined vehicles like 'SBs 894 & 921' expand to ['SB 894','SB 921']). Substitute prefixes (SS/SCS/...) are NOT part of the bill identifier — the motion string preserves them verbatim for traceability.
- Position mapping to `vote_casts.position`: yeas→`yea`, nays→`nay`, absent→`absent`, absentWithLeave→`absent` (it is an absence; the verbatim category survives in nothing — acceptable: position enum has no finer value, and the House maps `@`→absent identically). Vacancies are seats, never casts (House precedent).

- [ ] TDD against the REAL Day 37 fixture: assert 13 vote blocks parse (research-verified count); assert the SBs 894&921 block's bill_refs = ['SB 894','SB 921']; assert Onder appears in that block's yeas; assert every block's categories reconcile; assert a deliberately corrupted copy (drop one surname) yields a per-block failure naming the category, with the other 12 blocks still returned.
- [ ] Also test against the Task 1 second-year journal fixture (format stability across sessions — at minimum: block count > 0 and all blocks reconcile).
- [ ] `resolveMoSenator` tests: unique match → id; 0 matches → null; 2 same-surname rosters → null (no district disambiguation exists in journal text — that's WHY it must fail loud); case/whitespace-insensitive; hyphenated surname exact-match.
- [ ] Implement, green, commit `feat: mo-senate journal PDF parser - multi-vote blocks + reconcile gate`.

### Task 5: `src/cli/ingest-mo-senate.js` — driver (roster ensure → journal days → votes + gated casts)

**Files:**
- Create: `src/cli/ingest-mo-senate.js`; add `package.json` script `"ingest:mo-senate"`
- Test: `tests/ingest-mo-senate-cli.test.js` (pure parts: planning, source_key construction, gating logic — fake client, fixture-driven; no network in tests)

**Interfaces (Consumes):** everything from Tasks 3-4; `getClient/openRun/closeRun/insertIfAbsent/additivePatch/isMissingColumnError` from `src/lib/db.js`; the durable-cooldown + artifact/replay patterns from `src/cli/ingest-mo-house.js` (read it; port, don't import its internals).

**Flow (per run, `--year <Y> [--limit N] [--dry-run] [--journal-pdf-file <path>]`):**
1. `openRun(client,'mo-senate-web')`; enforce the durable cross-process cooldown exactly like `enforceDurableCooldown` (keyed `ingestion_runs.source='mo-senate-web'`, 30-min).
2. Ensure session row: `insertIfAbsent('sessions', [{ jurisdiction_id:'mo-legislature', identifier:String(year), name:'<year> Regular Session (MO Senate journals)' }], 'jurisdiction_id,identifier')` — identifier deliberately collides with OpenStates' own year-keyed session rows so both sources dedupe to one row.
3. Ensure roster: fetch+parse roster page for the year; `insertIfAbsent('legislators', rosterRows.map(r => ({ full_name, party, surname, mo_senate_id })), 'mo_senate_id')`; then select back `{id,surname,mo_senate_id}` where `mo_senate_id` in the roster's districts → in-memory roster for resolution. If `isMissingColumnError(err,'mo_senate_id')` → roster unavailable: journals still parse and votes rows still store; CASTS go to the gated-artifact path (step 6), exactly the 0005/0006 replay pattern.
4. Journal-day worklist: parse journal index for the year; select already-ingested day URLs (votes where `source_key like 'mo-senate-web-<year>-day%'`) and skip completed days; take `--limit` days per run (default 1 — one 30-min slot = one day PDF = ~a dozen votes).
5. Per day: fetch PDF (or `--journal-pdf-file` for a local no-network run) → `extractJournalText` → `parseJournalVotes` → for each parsed vote: ensure bill stubs `insertIfAbsent('bills', refs.map(identifier => ({ jurisdiction_id:'mo-legislature', session_identifier..., identifier, title:null })), ...)` matching ingest-mo-house's exact bill-stub column shape (READ it first); insert vote row `{ bill_id: <primary ref's id>, jurisdiction_id:'mo-legislature', chamber:'senate', vote_date:<the day's date if the index/journal provides it, else null — never guessed>, question: motion, result: null, source_url:<journal url>, source_key:'mo-senate-web-<year>-day<NN>-vote<ordinal>', run_id }` via `insertIfAbsent(...,'source_key')`.
   - `result` stays **null**: the journal block does not print an outcome word, and deriving pass/fail from tallies would bake in chamber rules (simple majority vs 2/3 overrides) — mechanical-neutrality says store only what's printed. The motion+tallies are the facts.
6. Casts: resolve each surname via `resolveMoSenator`; resolved → `insertIfAbsent('vote_casts', rows, 'vote_id,legislator_id')`; unresolved → run-detail sample (cap 10) + honest counts. If the roster was gated (step 3), write `<source_key>.journal-day.json` artifacts (parsed votes + casts) to the same artifacts dir convention as ingest-mo-house and replay them once the column exists (port `replayArtifacts`' shape; exclude `.failed.json`).
7. Per-block parse failures from `parseJournalVotes` → `failures[]` with day + ordinal + category; day still counts as attempted; a day with ≥1 failure is NOT marked complete (its skip-check in step 4 must key on something that distinguishes fully-stored days — key on: all parsed ordinals present as votes rows AND zero recorded failures for that day in the last run… simplest honest rule: a day is complete when every vote block parsed clean AND every vote row exists; otherwise it stays in the worklist and failures repeat visibly each run).
8. `closeRun` succeeded/failed with full counts `{ days, votes, casts, unresolved, failures, gated }`.

- [ ] TDD the pure parts (worklist planning incl. the day-completeness rule, source_key format, result-null rule, roster-gating branch) with fakes; implement; green.
- [ ] Local end-to-end smoke with NO network: `node src/cli/ingest-mo-senate.js --year 2018 --dry-run --journal-pdf-file tests/fixtures/research/mo-senate/2018-day37-journal-onder-era.pdf` → prints plan incl. 13 votes, 0 writes. Report actual output.
- [ ] Commit `feat: mo-senate ingest driver - journals-first votes + gated casts`.

### Task 6: Live Onder-era slice + docs

- [ ] Live run (no approval needed — zero LLM calls; politeness enforced by limiter+cooldown): `--year 2018 --limit 1` → expect Day 37 or the worklist's first day to land real votes rows; verify via service-role REST: 13 votes for the day, casts count if 0008 applied (else gated artifacts written + honest log). Report the REAL numbers.
- [ ] Start the background cadence loop only if the smoke run is clean (mirror the mo-house driver loop invocation).
- [ ] Docs: TODO item 17 marked done→in-progress-live; CHATLOG entry; PLAYBOOK addition only if something cost real time. Commit `docs: MO Senate adapter live - journals-first pipeline`.

## Self-review notes (write time)

- Spec coverage: research Q5's two "genuinely new work" parser problems are Tasks 3-4; its high-reuse list is consumed as-is; Q4's cadence recommendation is a Global Constraint. The HTML bill/actions endpoints are consciously out of scope (journals-first makes them unnecessary for votes — recorded as an architecture deviation from Q5's sketch, justified in the header).
- The roster-page URL is the plan's one genuine unknown → Task 1 exists solely to convert it into fixtures before any parser is written; Task 3+ must follow the payload.
- Type consistency: roster rows `{legislator_id, surname, mo_senate_id}` used identically in Task 4's resolveMoSenator and Task 5's step 3; `parseJournalVotes` returns `{votes, failures}` (Task 4) and Task 5's steps 5-7 consume exactly that.
- vote_date: journal index may carry the calendar date per day; if only the PDF's own header prints it, extract from the journal text's dateline — if neither is mechanically certain, null (never guessed) and note for enrichment.
