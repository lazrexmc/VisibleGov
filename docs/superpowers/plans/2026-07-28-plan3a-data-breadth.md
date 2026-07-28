# Plan 3a: Missouri Data Breadth (Overnight) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete federal voting records for every Missouri member of Congress — House (backfill already running) and Senate (new adapter + backfill) — plus the polite XML-side groundwork for the Missouri House, executed overnight under Lance's directive with zero Claude-API spend and zero new runtime dependencies.

**Architecture:** A `us-senate` adapter mirroring the existing `us-congress` House pattern (fixture-first parsers over senate.gov's official LIS roll-call XML; casts resolved to existing bioguide-keyed legislator rows by state+surname matching with fail-loud ambiguity handling); ingest CLI extension; a `mo-house-xml` adapter covering ONLY what the XML natively provides (bills, actions, aggregate tallies, roll-call PDF links stored for later), throttled to the site's published half-hour automation cadence.

**Tech Stack:** existing Node ESM project; fast-xml-parser (already installed); NO new dependencies; NO Anthropic API calls anywhere in this plan.

## Global Constraints

- **Zero Claude/LLM API calls** (Lance's per-run approval policy; he is asleep). Ingestion only.
- **One Lance-approved new dependency (2026-07-28, before bed): `pdfjs-dist`, version-pinned.** Nothing else. MO individual-vote PDF extraction is therefore IN SCOPE (Task 4b).
- **Migration 0005 (draft-then-apply):** `alter table legislators add column mo_house_id text unique;` — SQL given to Lance; Task 4b's PERSISTENCE gates on it being applied (extraction + tests proceed regardless; if unapplied by the time persistence runs, hold extracted casts as committed JSON artifacts under a gitignored scratch dir and report — never guess a key).
- Skip ≠ empty; additive writes; provenance run_id on every row; fail-loud on ambiguity (never guess a member match).
- **Shared-limiter discipline (§3.2): no live congress.gov-hitting ingest runs while the House backfill process is still running.** Fixture captures (a handful of requests) are permitted; the Senate BACKFILL waits for the House backfill to finish.
- **house.mo.gov ToU: one automated request per 30 minutes** (their published limit, conservatively read as per-request). The MO fetcher enforces this mechanically with a 30-minute limiter.
- Draft-then-apply for any SQL (none expected — 'senate' chamber and session '119' already exist; MO sessions are CLI-inserted like slice 1).
- Tests: node:test + node:assert/strict via `npm test` (149 green at start). Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: US Senate roll-call adapter (fixture-first)

**Files:**
- Create: `tests/fixtures/us-senate/vote-menu.xml`, `tests/fixtures/us-senate/roll-call.xml`, `src/adapters/us-senate.js`
- Modify: `slice.config.json` (add us_senate fixture identifiers)
- Test: `tests/us-senate.test.js`

**Interfaces:**
- Capture (real payloads, ~1s apart, no auth needed): the 119th Congress session-1 vote menu `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_1.xml` and one full-chamber vote `https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_NNNNN.xml` (pick a recent On-Passage vote from the menu; NNNNN is zero-padded 5-digit). THE FIXTURE IS THE SOURCE OF TRUTH — the URL patterns and element names above are documented-from-research; verify against reality and adapt, documenting deviations.
- Produces (Task 2 consumes):
  - `parseSenateVoteMenu(xml) → [{ vote_number int, date, question, result, issue (bill identifier string like 'S. 123'|'H.R. 22'|null) }]`
  - `parseSenateRollCall(xml) → { vote: { source_key: 'us-senate-<congress>-<session>-<number>', chamber: 'senate', vote_date, question, result, bill_identifier (normalized via existing normalizeBillIdentifier — 'S. 123'→'S 123', 'H.R. 22'→'HR 22'), source_url }, casts: [{ last_name, first_name, party, state, position }] }` — Senate XML identifies members by LIS id + name/party/state, NOT bioguide; the adapter emits identity fields and Task 2 resolves them.
  - Position mapping: Yea/Guilty→yea, Nay/Not Guilty→nay, Present→present, Not Voting→not_voting, else→other.
  - `fetchSenateVoteMenu(congress, session, limiter)`, `fetchSenateRollCall(congress, session, number, limiter)` via fetchWithLimit + a senate limiter (minIntervalMs 1000).
- Tests (against real fixtures): menu yields >100 votes with ints/dates; roll call yields 98-100 casts, all positions in enum, at least one MO senator present by state 'MO'; source_key format; bill_identifier normalization on a menu entry that has one.

- [ ] **Step 1:** capture fixtures (grep for anything key-shaped — none expected, no-auth source); record chosen vote number in slice.config.json.
- [ ] **Step 2:** failing tests → **Step 3:** implement → **Step 4:** `npm test` green → **Step 5:** commit `feat: us-senate adapter (LIS vote menu + roll-call XML)`.

---

### Task 2: Senate ingest wiring + member resolution

**Files:**
- Modify: `src/cli/ingest.js` (new source 'us-senate'), `src/adapters/us-senate.js` (resolution helper if cleaner there)
- Test: `tests/ingest-senate.test.js` (pure resolution logic)

**Interfaces:**
- `parseArgs` accepts `--source us-senate --session 1|2 [--votes 1-600]`; omitting --votes means: fetch the menu, ingest every vote number it lists (the normal backfill mode).
- **Member resolution (pure, tested): `resolveSenator(cast, senators) → legislator_id`** where senators = rows from our legislators table having a senate-chamber affiliation. Match by (state, last_name case-insensitive); if 0 matches or >1 matches → collect into an `unresolved[]` list recorded in run detail and SKIP that cast (recorded, never guessed, never silently dropped — the counts must show resolved vs unresolved). Do NOT insert placeholder senators keyed by name (unlike House bioguide placeholders — names are not stable keys); unresolved casts are a data-quality signal for the morning.
  - Reality note: our legislators table currently holds only MO members with senate terms from the delegation ingest + possibly name-only rows. The resolver therefore needs the full Senate membership: ingest step fetches congress.gov `/member?congress=119¤tMember=true`-style pages... SIMPLER SANCTIONED PATH: fetch `/member/<state>` per state ONCE for the states appearing in unresolved casts? That's 50 requests. Cheaper: fetch the two-page full member list via congress.gov `/member?limit=250&offset=...` filtered to Senate in code, insertIfAbsent by bioguide (additive, reuses parseMemberList semantics). Implement as `ensureSenateMembers(client, runId)` run once per ingest.
- Bills: menu/vote `issue` values that normalize to bill identifiers get bill rows via existing fetchBillDetail (congress.gov, shared limiter, run AFTER the House backfill completes per Global Constraints); non-bill issues (nominations 'PN...', treaties) → votes stored with null bill_id and the raw issue string preserved in question context. Nominations are votes too — they belong on profiles.
- Casts insert via existing insertIfAbsent('vote_casts', ..., 'vote_id,legislator_id').

- [ ] **Step 1:** failing tests for resolveSenator (exact match; case-insensitivity; ambiguity → unresolved; missing → unresolved) and the arg parsing.
- [ ] **Step 2:** implement; **Step 3:** `npm test` green; **Step 4:** `npm run ingest -- --source us-senate --session 1 --votes 1-3 --dry-run` (menu+3 votes, senate.gov only, prints canonical rows + resolution stats, zero DB writes) — verify resolution rate ≈ 100/100 after ensureSenateMembers logic is exercised (dry-run may show unresolved until members exist; report honestly).
- [ ] **Step 5:** commit `feat: senate ingest - menu-driven backfill, fail-loud member resolution`.

---

### Task 3: Senate live backfill (GATED on House backfill completion)

**Files:** none new (operational task; CHATLOG/TODO updated at checkpoint)

- [ ] **Step 1:** CONFIRM the House backfill process has exited and record its final counts (partial failures listed verbatim in the ledger; re-run failed roll ranges once if transient).
- [ ] **Step 2:** `npm run ingest -- --source us-senate --session 1` (2025: full menu backfill), then `--session 2` (2026). Sequential, never parallel. Expect ~600-700 + ~250-350 votes; hours under the 1s senate limiter + congress.gov bill details at 3.6s.
- [ ] **Step 3:** REST verification: Hawley (H001089) and Schmitt (bioguide from live member data — verify, don't assume) cast counts equal the ingested vote totals minus recorded absences; unresolved-cast count reported honestly; spot-check 2 votes against the raw XML.
- [ ] **Step 4:** ledger + counts; commit any doc updates.

---

### Task 4: MO House XML groundwork (polite cadence)

**Files:**
- Create: `src/adapters/mo-house-xml.js`, `src/cli/ingest-mo-house.js` (or extend ingest.js — implementer's call, document it), `tests/fixtures/mo-house/` (captures), `tests/mo-house-xml.test.js`

**Interfaces:**
- A dedicated limiter: `moHouseLimiter = createLimiter({ minIntervalMs: 30 * 60 * 1000 })` — thirty minutes, mechanically enforced, per the site's published ToU. The overnight run therefore fetches AT MOST ~2 documents per hour; scope accordingly: (1) the current-session bill-list XML (one request — it is a bulk export listing all bills); (2) as many per-bill XML documents as the cadence allows before morning, prioritized by bills having RollCall elements per the research fixtures.
- Parser (fixture-first against the ALREADY-CAPTURED research fixtures in tests/fixtures/research/mo-house-xml/ — reuse them; capture at most ONE fresh bill-list document live): `parseMoBillList(xml) → [{ bill_number, title, sponsor, last_action_date, bill_xml_url }]`; `parseMoBillXml(xml) → { bill: {identifier, title, canonical_url}, actions: [...], rollcalls: [{ date, motion, yes, no, present, absent, pdf_url }] }` — aggregate tallies + PDF URLs stored (a new lightweight table is NOT needed: store rollcall aggregates as votes rows with null bill-level casts? NO — votes rows imply roll-call events; store them as votes with source_key 'mo-house-xml-<bill>-<n>' + result, question=motion, and keep pdf_url in... votes has no spare column; put pdf_url in source_url. Individual casts remain absent (honest).
- DB: MO sessions row for the current session (CLI-inserted, additive); bills/actions/votes additive with run_id.

- [ ] **Step 1:** failing tests against the existing research fixtures → **Step 2:** implement parsers → **Step 3:** green → commit `feat: mo-house-xml adapter (bills, actions, aggregate tallies, PDF links)`.
- [ ] **Step 4:** live: ONE bill-list fetch; ingest its metadata; then per-bill fetches on the 30-min cadence in the background until morning (a driver loop that logs each fetch + sleeps via the limiter; graceful stop on completion). Report exactly how many documents were fetched and what remains.

### Task 4b: MO individual votes from roll-call PDFs (Lance-approved pdfjs-dist)

**Files:**
- Create: `src/adapters/mo-rollcall-pdf.js`
- Modify: `package.json` (add pdfjs-dist, PINNED exact version), the MO driver (fetch each bill's rollcall PDFs on the same 30-min cadence)
- Test: `tests/mo-rollcall-pdf.test.js` (fixture: the ALREADY-CAPTURED text-layer PDF at tests/fixtures/research/mo-house-xml/rollcall-034.008.pdf — known ground truth: 82 yes / 61 no / 2 present / 13 absent / 5 vacancies; MATTHIESEN=Y; duplicate-surname suffixes SMITH 46/68/74, TAYLOR 48/84, JONES 12/88)

**Interfaces:**
- `extractRollCallText(pdfBuffer) → string` (pdfjs-dist text content, page-ordered);
- `parseMoRollCall(text) → { tallies: {yes,no,present,absent,vacancies}, casts: [{surname, district|null, position}] }` — surnames uppercase as printed; duplicate-surname entries carry the printed district number; **cross-check: parsed cast counts MUST equal the printed tallies or throw (typed RollCallParseError — never store a roll call that doesn't reconcile)**;
- `resolveMoRep(cast, roster) → legislator_id` — roster from the mo-house member XML (Task 4's roster ingestion keyed by mo_house_id = district number); surname+district exact where district present, unique-surname otherwise; ambiguity/miss → unresolved[] recorded, cast skipped (same fail-loud pattern as the Senate resolver).
- Persistence gates on migration 0005 (see Global Constraints).

- [ ] **Step 1:** `npm install pdfjs-dist@<current-exact-version> --save-exact`; failing tests against the research PDF (tallies reconcile; MATTHIESEN=yea; a SMITH resolves only with district).
- [ ] **Step 2:** implement → **Step 3:** green → commit `feat: MO individual votes - PDF extraction with tally reconciliation (pdfjs-dist approved by Lance)`.
- [ ] **Step 4:** wire into the MO driver's cadence; persistence per the 0005 gate; report extraction/resolution rates honestly.

---

## Self-review notes (write time)

- Zero-spend + zero-new-deps constraints hold across all tasks; MO individual votes and MO Senate explicitly out of scope (morning decisions).
- The Senate member-resolution design refuses to guess (unlike House bioguide placeholders, name keys aren't stable) — unresolved casts surface in run detail, matching skip≠empty.
- Nominations/treaties handled as first-class votes with null bill_id — profiles need them; nothing editorial about including them.
- Sequencing: Tasks 1-2 build while the House backfill runs (fixture capture only touches senate.gov + at most 2 congress.gov requests); Task 3 is hard-gated on the House process exiting; Task 4's cadence makes it a background trickle by design.
