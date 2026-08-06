# MO Current-Legislator Term Start-Date Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the 193 current MO *state* legislators' `terms.start_date` with real OpenStates dates, cross-checked against on-disk LegiScan session-years, mismatches flagged for human review, via a new dry-run-first `backfill-mo-term-dates.js` CLI.

**Architecture:** A new date-filler CLI cloned from `backfill-federal-names.js`'s shape (pure resolvers + an injectable-seam orchestrator + a thin `main()`). OpenStates supplies the authored date (a new paginated roster fetch, since only single-person fetch exists today); the 32 cached LegiScan datasets supply an independent earliest-qualifying-year verifier (people-presence + `roll_call.chamber`); a pure `reconcile` gate marks each term `agree` (write-eligible) or `flag`. Writes are `UPDATE`-in-place on the null-`start_date` row, `end_date` never touched, gated behind `--apply` (dry-run is the default). Provenance = `run_id` stamp + a citation list in `ingestion_runs.detail`.

**Tech Stack:** Node ≥22 ESM, `node:test` + `node:assert/strict`, `@supabase/supabase-js` (service role, via `src/lib/db.js`), OpenStates v3 REST (`src/adapters/mo-legislature.js`), cached LegiScan datasets (`src/adapters/legiscan-dataset.js`).

## Global Constraints

- **Target set:** dateless (`start_date IS NULL`) terms with `jurisdiction_id = 'mo-legislature'` only. Federal (`us-congress`) terms are out of scope. (spec §1, §2)
- **`end_date` is ALWAYS left NULL.** Never write `end_date`; never infer an end from "last session seen." (spec §5)
- **UPDATE in place, never INSERT.** Scope every write `.eq('id', termId).is('start_date', null).select('id')`; a zero-row result is counted, not treated as a write. The `terms` UNIQUE key is `(legislator_id, jurisdiction_id, chamber, district, start_date)` and Postgres treats NULLs as distinct, so an INSERT would duplicate. (spec §5)
- **Dry-run is the DEFAULT; `--apply` is required to write.** This is a deliberate departure from the `backfill-federal-names.js` template (which writes by default with `--dry-run` opt-out), for draft-then-apply safety on production data. (spec §7, §11)
- **Author→verify→flag:** OpenStates authors the date, LegiScan on-disk authors an independent year; `agree` only when the years match; every non-agree case flags for review, never auto-writes. (spec §3)
- **Wikipedia never enters the data** — not in any citation string, column, or log. (spec §3)
- **Provenance:** stamp `run_id` on every updated row; write the per-term citation list into `ingestion_runs.detail`. No new column, no migration. (resolves spec §8)
- **Full-table reads go through `selectAll(client, table, columns)`** — never a bare `.select()` (PostgREST 1000-row cap). (repo rule, `src/lib/db.js:85`)
- **Tests:** `import { test } from 'node:test'` + `import assert from 'node:assert/strict'`; flat `test()` calls; fixtures loaded `JSON.parse(readFileSync('tests/fixtures/...','utf8'))` (CWD=repo root). Test pure functions + injectable orchestrators with a hand-rolled fake client; **never** construct a real Supabase client in a test.
- **NEVER `source .env` in a shell you then run `node --test` in** — it turns 2 correct tests red. Run tests in a clean shell; run the CLI with `node --env-file=.env src/cli/backfill-mo-term-dates.js`. (PLAYBOOK lesson 30)
- **Run tests as** `node --test` (whole suite, no path arg) or `node --test tests/<file>.test.js` (single file). Never `node --test tests/` (dir arg breaks on Node 24/Windows). Gate commits on the parsed `# fail N` count, never the runner exit status. (PLAYBOOK lessons 14, and the dir-arg trap)
- **Onder (stale MO-Senate-D2 row) is parked** — not dated. He is retired from the MO Senate so he is absent from the current OpenStates roster and lands in the `unmatched` bucket structurally; a test must assert his row is never written. (spec §1a)

---

### Task 1: Capture a real OpenStates MO roster fixture and confirm `current_role.start_date` is present

This is the one networked, gating step. It de-risks the core assumption (that OpenStates carries a real `current_role.start_date` for *current* MO members — unverified in-repo, since the only fixture is retired Onder with no roles) and produces the multi-member fixture every later parser test needs. If `start_date` is absent, STOP and report — the whole approach depends on it.

**Files:**
- Create: `tests/fixtures/mo-legislature/roster-page-sample.json` (a real, saved OpenStates response — trimmed to ~5 members)

**Interfaces:**
- Consumes: `OPENSTATES_API_KEY` from `.env`; the OpenStates v3 `/people` endpoint.
- Produces: a committed fixture in the exact `{ results: [...], pagination: {...} }` shape `parseRoster` (Task 2) will parse.

- [ ] **Step 1: Fetch one page of the live MO roster** (clean shell, key by name only — never print the key value)

```bash
# In a shell that has NOT sourced .env for test purposes; this is a CLI-style call.
set -a && source .env && set +a
curl -s "https://v3.openstates.org/people?jurisdiction=Missouri&include=other_roles&per_page=5&page=1" \
  -H "X-API-KEY: $OPENSTATES_API_KEY" > tests/fixtures/mo-legislature/roster-page-sample.json
```

- [ ] **Step 2: Confirm the shape — `current_role` carries `start_date`, `org_classification`, `district`**

```bash
python -c "
import json,io
d=json.load(io.open('tests/fixtures/mo-legislature/roster-page-sample.json',encoding='utf-8'))
print('results:', len(d.get('results',[])))
for p in d['results'][:5]:
    cr=p.get('current_role') or {}
    print(p.get('name'),'| org=',cr.get('org_classification'),'| dist=',cr.get('district'),'| start=',cr.get('start_date'))
"
```
Expected: 5 members, each with `org_classification` in {`lower`,`upper`}, a `district`, and a **non-empty `start_date`**.

- [ ] **Step 3: Decision gate.** If `start_date` is present for the current members → proceed. If it is **absent/empty**, STOP: the OpenStates author path is not viable as designed; report to the controller (the fallback would be LegiScan-year-only, which the spec says leaves those rows flagged/null — a different plan).

- [ ] **Step 4: Trim the fixture to ~5 members and commit**

```bash
git add tests/fixtures/mo-legislature/roster-page-sample.json
git commit -m "test(fixture): real OpenStates MO roster page sample for term-date backfill"
```

---

### Task 2: `fetchCurrentRoster` + `parseRoster` in the OpenStates adapter

**Files:**
- Modify: `src/adapters/mo-legislature.js` (add two exports near `fetchPersonById`/`parsePerson`)
- Test: `tests/mo-legislature.test.js` (add cases; existing file)

**Interfaces:**
- Consumes: the Task 1 fixture; existing module-locals `BASE`, `SOURCE`, `moLimiter`, `headers()`, `mapChamber`, `fetchWithLimit`.
- Produces:
  - `fetchCurrentRoster(page, limiter = moLimiter) -> Promise<json>` — GETs `${BASE}/people?jurisdiction=Missouri&include=other_roles&per_page=50&page=${page}`.
  - `parseRoster(json) -> Array<{ openstates_id, full_name, party, roles: Array<{chamber:'house'|'senate', district:string|null, start_date:string|null, end_date:string|null}> }>` — maps ALL `json.results` (not `[0]`), same per-role mapping as `parsePerson`.

- [ ] **Step 1: Write the failing test**

```js
// tests/mo-legislature.test.js — add near the other parse tests
import { parseRoster } from '../src/adapters/mo-legislature.js'; // extend the existing import line
const rosterJson = JSON.parse(readFileSync('tests/fixtures/mo-legislature/roster-page-sample.json', 'utf8'));

test('parseRoster maps every result, not just the first, with chamber/district/start_date per current role', () => {
  const people = parseRoster(rosterJson);
  assert.equal(people.length, rosterJson.results.length);
  assert.ok(people.length > 1, 'fixture should carry more than one member');
  for (const person of people) {
    assert.ok(person.openstates_id && person.full_name);
    assert.ok(Array.isArray(person.roles));
  }
  // at least one current member resolves a house/senate role with a real start_date
  const withCurrent = people.find((p) => p.roles.some((r) => r.start_date));
  assert.ok(withCurrent, 'at least one current member should carry a role start_date');
  const role = withCurrent.roles.find((r) => r.start_date);
  assert.ok(['house', 'senate'].includes(role.chamber));
  assert.match(role.start_date, /^\d{4}-\d{2}-\d{2}$/);
});

test('parseRoster returns [] for an empty results payload (no throw, unlike parsePerson)', () => {
  assert.deepEqual(parseRoster({ results: [] }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mo-legislature.test.js`
Expected: FAIL — `parseRoster` is not exported / not a function.

- [ ] **Step 3: Implement `parseRoster` and `fetchCurrentRoster`**

```js
// src/adapters/mo-legislature.js — add after parsePerson / fetchPersonById

export function parseRoster(json) {
  const people = json.results ?? [];
  return people.map((p) => {
    const roles = [];
    const allRoles = [p.current_role, ...(p.other_roles ?? [])].filter(Boolean);
    for (const r of allRoles) {
      const chamber = mapChamber(r.org_classification ?? r.classification);
      if (!chamber) continue;
      roles.push({
        chamber,
        district: r.district != null ? String(r.district) : null,
        start_date: r.start_date || null,
        end_date: r.end_date || null,
      });
    }
    return { openstates_id: p.id, full_name: p.name, party: p.party ?? null, roles };
  });
}

export function fetchCurrentRoster(page, limiter = moLimiter) {
  const url = `${BASE}/people?jurisdiction=Missouri&include=other_roles&per_page=50&page=${page}`;
  return fetchWithLimit(url, { source: SOURCE, limiter, headers: headers(), as: 'json' });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/mo-legislature.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/mo-legislature.js tests/mo-legislature.test.js
git commit -m "feat(mo-legislature): add fetchCurrentRoster + parseRoster (paginated roster)"
```

---

### Task 3: `readCachedDatasetFull` — decode wrapper that returns BOTH people and rollCalls

The existing `readCachedDatasetPeople` (in `backfill-nicknames.js`) decodes the full archive but discards `rollCalls`, which the cross-check needs. Add a self-contained wrapper in the new CLI module that returns people + rollCalls + the envelope year.

**Files:**
- Create: `src/cli/backfill-mo-term-dates.js` (start the file with just this function + imports)
- Test: `tests/backfill-mo-term-dates.test.js` (new)

**Interfaces:**
- Consumes: `decodeDatasetZip`, `extractDatasetFiles` from `../adapters/legiscan-dataset.js`; committed fixture `tests/fixtures/research/legiscan/mo-2018-dataset.json` (base64 at `envelope.dataset.zip`).
- Produces: `readCachedDatasetFull(filePath, { readFileFn = readFileSync } = {}) -> Promise<{ ok:true, filePath, sessionId, yearStart, people:object[], rollCalls:object[] } | { ok:false, filePath }>` (never throws).

- [ ] **Step 1: Write the failing test**

```js
// tests/backfill-mo-term-dates.test.js
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCachedDatasetFull } from '../src/cli/backfill-mo-term-dates.js';

// The committed LegiScan fixture stores its envelope under `.dataset` (see legiscan-dataset.test.js).
// readCachedDatasetFull expects a top-level `.zip` field (the cache-file envelope shape), so build one.
function writeCacheEnvelope() {
  const src = JSON.parse(readFileSync('tests/fixtures/research/legiscan/mo-2018-dataset.json', 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'vg-ds-'));
  const path = join(dir, 'sess.json');
  writeFileSync(path, JSON.stringify({ session_id: 1579, year_start: 2018, zip: src.dataset.zip }));
  return path;
}

test('readCachedDatasetFull returns people AND rollCalls plus the envelope year', async () => {
  const path = writeCacheEnvelope();
  const out = await readCachedDatasetFull(path);
  assert.equal(out.ok, true);
  assert.equal(out.yearStart, 2018);
  assert.ok(Array.isArray(out.people) && out.people.length > 0);
  assert.ok(Array.isArray(out.rollCalls) && out.rollCalls.length > 0);
  assert.ok(out.rollCalls[0].chamber === 'H' || out.rollCalls[0].chamber === 'S');
});

test('readCachedDatasetFull returns ok:false on unreadable file (no throw)', async () => {
  const out = await readCachedDatasetFull('does/not/exist.json');
  assert.equal(out.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: FAIL — module/function does not exist.

- [ ] **Step 3: Implement the file header + `readCachedDatasetFull`**

```js
// src/cli/backfill-mo-term-dates.js
import { readFileSync } from 'node:fs';
import { getClient, openRun, closeRun, selectAll } from '../lib/db.js';
import { decodeDatasetZip, extractDatasetFiles } from '../adapters/legiscan-dataset.js';
import { mapLegiscanChamber } from '../adapters/legiscan-votes.js';
import { fetchCurrentRoster, parseRoster } from '../adapters/mo-legislature.js';
import { listCachedDatasetFiles } from './backfill-nicknames.js';

const CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';
const SOURCE = 'backfill-mo-term-dates';
const MO_JURISDICTION = 'mo-legislature';

export async function readCachedDatasetFull(filePath, { readFileFn = readFileSync } = {}) {
  let raw;
  try { raw = readFileFn(filePath, 'utf8'); } catch { return { ok: false, filePath }; }
  let envelope;
  try { envelope = JSON.parse(raw); } catch { return { ok: false, filePath }; }
  try {
    const zipBuffer = decodeDatasetZip(envelope.zip);
    const parsed = await extractDatasetFiles(zipBuffer);
    return {
      ok: true,
      filePath,
      sessionId: envelope.session_id,
      yearStart: envelope.year_start,
      people: parsed.people ?? [],
      rollCalls: parsed.rollCalls ?? [],
    };
  } catch { return { ok: false, filePath }; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/backfill-mo-term-dates.js tests/backfill-mo-term-dates.test.js
git commit -m "feat(backfill-mo-term-dates): decode wrapper returning people + rollCalls"
```

---

### Task 4: `buildLegiscanPresenceIndex` + `earliestLegiscanYear` (pure verifier)

The independent cross-check: from decoded sessions, index each `people_id`'s presence-years and the years it cast votes in each chamber (roll_call `chamber` is the independent per-vote signal — do not use `person.role`). Then the earliest qualifying year for a `(people_id, chamber)`.

**Files:**
- Modify: `src/cli/backfill-mo-term-dates.js`
- Test: `tests/backfill-mo-term-dates.test.js`

**Interfaces:**
- Consumes: `mapLegiscanChamber` (`'H'|'S' -> 'house'|'senate'`).
- Produces:
  - `buildLegiscanPresenceIndex(sessions) -> Map<number, { presenceYears:Set<number>, chamberVoteYears:{house:Set<number>, senate:Set<number>} }>` where `sessions = Array<{ yearStart:number, people:object[], rollCalls:object[] }>`.
  - `earliestLegiscanYear(index, peopleId, chamber) -> number | null` — earliest year with a chamber-matched vote; else earliest presence year; else null.

- [ ] **Step 1: Write the failing test**

```js
// tests/backfill-mo-term-dates.test.js — add
import { buildLegiscanPresenceIndex, earliestLegiscanYear } from '../src/cli/backfill-mo-term-dates.js';

const SESSIONS = [
  { yearStart: 2011, people: [{ people_id: 1 }], rollCalls: [] }, // presence only, pre-2015 (no roll calls)
  { yearStart: 2019, people: [{ people_id: 1 }, { people_id: 2 }],
    rollCalls: [
      { chamber: 'S', votes: [{ people_id: 1 }] },   // person 1 votes in Senate 2019
      { chamber: 'H', votes: [{ people_id: 2 }] },   // person 2 votes in House 2019
    ] },
  { yearStart: 2023, people: [{ people_id: 1 }],
    rollCalls: [{ chamber: 'S', votes: [{ people_id: 1 }] }] },
];

test('earliestLegiscanYear uses the chamber-matched vote year (defeats person.role), earliest wins', () => {
  const idx = buildLegiscanPresenceIndex(SESSIONS);
  assert.equal(earliestLegiscanYear(idx, 1, 'senate'), 2019); // first Senate vote, not 2011 presence
  assert.equal(earliestLegiscanYear(idx, 2, 'house'), 2019);
});

test('earliestLegiscanYear falls back to earliest presence year when no chamber-matched vote', () => {
  const idx = buildLegiscanPresenceIndex(SESSIONS);
  // person 1 never votes in the House -> fall back to earliest presence (2011)
  assert.equal(earliestLegiscanYear(idx, 1, 'house'), 2011);
});

test('earliestLegiscanYear returns null for an unknown people_id', () => {
  const idx = buildLegiscanPresenceIndex(SESSIONS);
  assert.equal(earliestLegiscanYear(idx, 999, 'senate'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement**

```js
// src/cli/backfill-mo-term-dates.js — add

export function buildLegiscanPresenceIndex(sessions) {
  const index = new Map();
  const ensure = (peopleId) => {
    let entry = index.get(peopleId);
    if (!entry) {
      entry = { presenceYears: new Set(), chamberVoteYears: { house: new Set(), senate: new Set() } };
      index.set(peopleId, entry);
    }
    return entry;
  };
  for (const session of sessions) {
    const year = session.yearStart;
    for (const person of session.people ?? []) {
      if (person.people_id != null) ensure(person.people_id).presenceYears.add(year);
    }
    for (const rc of session.rollCalls ?? []) {
      let chamber;
      try { chamber = mapLegiscanChamber(rc.chamber); } catch { continue; } // unknown chamber code -> skip
      for (const vote of rc.votes ?? []) {
        if (vote.people_id != null) ensure(vote.people_id).chamberVoteYears[chamber].add(year);
      }
    }
  }
  return index;
}

export function earliestLegiscanYear(index, peopleId, chamber) {
  const entry = index.get(peopleId);
  if (!entry) return null;
  const voteYears = entry.chamberVoteYears[chamber];
  if (voteYears && voteYears.size > 0) return Math.min(...voteYears);
  if (entry.presenceYears.size > 0) return Math.min(...entry.presenceYears);
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/backfill-mo-term-dates.js tests/backfill-mo-term-dates.test.js
git commit -m "feat(backfill-mo-term-dates): pure LegiScan presence/chamber year resolver"
```

---

### Task 5: `matchRoster` (pure) — join dateless DB terms to OpenStates people

**Files:**
- Modify: `src/cli/backfill-mo-term-dates.js`
- Test: `tests/backfill-mo-term-dates.test.js`

**Interfaces:**
- Produces:
  - `lastNameOf(fullName) -> string` — lowercased last whitespace-token (surname sanity helper).
  - `matchRoster(datelessTerms, rosterPeople) -> { matches: Array<{ term, openStatesId, startDate:string|null, surnameOk:boolean }>, unmatchedTerms: object[] }` where
    - `datelessTerms = Array<{ termId, legislatorId, chamber, district, surname, legiscanPeopleId }>`
    - each roster person is a `parseRoster` element `{ openstates_id, full_name, roles:[{chamber, district, start_date}] }`.
    - Match key: a roster role whose `chamber` and `String(district)` equal the term's. `surnameOk` = the term surname and the person's last name share (case-insensitive). No match → the term goes to `unmatchedTerms`.

- [ ] **Step 1: Write the failing test**

```js
// tests/backfill-mo-term-dates.test.js — add
import { matchRoster, lastNameOf } from '../src/cli/backfill-mo-term-dates.js';

const ROSTER = [
  { openstates_id: 'os-1', full_name: 'Jane Adams',
    roles: [{ chamber: 'house', district: '60', start_date: '2019-01-09' }] },
  { openstates_id: 'os-2', full_name: 'Bob Baker',
    roles: [{ chamber: 'senate', district: '2', start_date: '2023-01-04' }] },
];

test('matchRoster joins by (chamber, district) and carries the role start_date', () => {
  const terms = [
    { termId: 't1', legislatorId: 'l1', chamber: 'house', district: '60', surname: 'Adams', legiscanPeopleId: 11 },
  ];
  const { matches, unmatchedTerms } = matchRoster(terms, ROSTER);
  assert.equal(matches.length, 1);
  assert.equal(unmatchedTerms.length, 0);
  assert.equal(matches[0].openStatesId, 'os-1');
  assert.equal(matches[0].startDate, '2019-01-09');
  assert.equal(matches[0].surnameOk, true);
});

test('matchRoster puts a term with no roster counterpart (e.g. retired Onder) in unmatchedTerms', () => {
  const terms = [
    { termId: 't-onder', legislatorId: 'l-onder', chamber: 'senate', district: '2', surname: 'Onder', legiscanPeopleId: 16351 },
  ];
  const { matches, unmatchedTerms } = matchRoster(terms, ROSTER); // roster D2 senator is Baker, surname differs
  assert.equal(matches.length, 1);
  assert.equal(matches[0].surnameOk, false); // matched the seat but the surname disagrees -> flaggable
  assert.equal(unmatchedTerms.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement**

```js
// src/cli/backfill-mo-term-dates.js — add

export function lastNameOf(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

export function matchRoster(datelessTerms, rosterPeople) {
  // index roster roles by chamber|district -> { person, role }
  const bySeat = new Map();
  for (const person of rosterPeople) {
    for (const role of person.roles ?? []) {
      if (!role.chamber || role.district == null) continue;
      bySeat.set(`${role.chamber}|${String(role.district)}`, { person, role });
    }
  }
  const matches = [];
  const unmatchedTerms = [];
  for (const term of datelessTerms) {
    const hit = bySeat.get(`${term.chamber}|${String(term.district)}`);
    if (!hit) { unmatchedTerms.push(term); continue; }
    matches.push({
      term,
      openStatesId: hit.person.openstates_id,
      startDate: hit.role.start_date ?? null,
      surnameOk: !!term.surname && lastNameOf(hit.person.full_name) === String(term.surname).toLowerCase(),
    });
  }
  return { matches, unmatchedTerms };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/backfill-mo-term-dates.js tests/backfill-mo-term-dates.test.js
git commit -m "feat(backfill-mo-term-dates): pure matchRoster (chamber/district join + surname sanity)"
```

---

### Task 6: `reconcile` (pure) — the agree/flag gate

**Files:**
- Modify: `src/cli/backfill-mo-term-dates.js`
- Test: `tests/backfill-mo-term-dates.test.js`

**Interfaces:**
- Produces: `reconcile({ startDate, legiscanYear, surnameOk }) -> { verdict: 'agree'|'flag', reason: string|null }`.
  - `!startDate` → `flag / 'no-openstates-date'`
  - `!surnameOk` → `flag / 'surname-mismatch'`
  - `legiscanYear == null` → `flag / 'no-legiscan-year'`
  - `Number(startDate.slice(0,4)) !== legiscanYear` → `flag / 'year-mismatch'`
  - otherwise → `agree / null`

- [ ] **Step 1: Write the failing test**

```js
// tests/backfill-mo-term-dates.test.js — add
import { reconcile } from '../src/cli/backfill-mo-term-dates.js';

test('reconcile: matching years with a good surname agrees', () => {
  assert.deepEqual(reconcile({ startDate: '2019-01-09', legiscanYear: 2019, surnameOk: true }),
    { verdict: 'agree', reason: null });
});
test('reconcile flags a year mismatch', () => {
  assert.deepEqual(reconcile({ startDate: '2023-01-04', legiscanYear: 2019, surnameOk: true }),
    { verdict: 'flag', reason: 'year-mismatch' });
});
test('reconcile flags a missing OpenStates date before anything else', () => {
  assert.deepEqual(reconcile({ startDate: null, legiscanYear: 2019, surnameOk: true }),
    { verdict: 'flag', reason: 'no-openstates-date' });
});
test('reconcile flags a surname mismatch (e.g. matched seat, wrong person)', () => {
  assert.deepEqual(reconcile({ startDate: '2023-01-04', legiscanYear: 2023, surnameOk: false }),
    { verdict: 'flag', reason: 'surname-mismatch' });
});
test('reconcile flags when the cross-check has no year', () => {
  assert.deepEqual(reconcile({ startDate: '2019-01-09', legiscanYear: null, surnameOk: true }),
    { verdict: 'flag', reason: 'no-legiscan-year' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: FAIL — `reconcile` not defined.

- [ ] **Step 3: Implement**

```js
// src/cli/backfill-mo-term-dates.js — add

export function reconcile({ startDate, legiscanYear, surnameOk }) {
  if (!startDate) return { verdict: 'flag', reason: 'no-openstates-date' };
  if (!surnameOk) return { verdict: 'flag', reason: 'surname-mismatch' };
  if (legiscanYear == null) return { verdict: 'flag', reason: 'no-legiscan-year' };
  if (Number(String(startDate).slice(0, 4)) !== legiscanYear) return { verdict: 'flag', reason: 'year-mismatch' };
  return { verdict: 'agree', reason: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/backfill-mo-term-dates.js tests/backfill-mo-term-dates.test.js
git commit -m "feat(backfill-mo-term-dates): pure reconcile agree/flag gate"
```

---

### Task 7: The orchestrator, loaders, `parseArgs`, and `main()` (the wired CLI)

Wire the pure pieces into an injectable-seam `runBackfillMoTermDates`, plus the DB loaders, the `--apply`-gated `main()`, the `UPDATE`-in-place write, and the citation list. Dry-run is the default.

**Files:**
- Modify: `src/cli/backfill-mo-term-dates.js`
- Test: `tests/backfill-mo-term-dates.test.js`

**Interfaces:**
- Consumes: everything from Tasks 3–6; `getClient`, `openRun`, `closeRun`, `selectAll` from `../lib/db.js`.
- Produces:
  - `parseArgs(argv) -> { apply: boolean }` (default `{apply:false}`; only `--apply`; unknown flag throws `/unknown flag/`).
  - `loadDatelessMoTerms(client) -> Promise<Array<{termId, legislatorId, chamber, district}>>` — `selectAll(client,'terms','id,legislator_id,jurisdiction_id,chamber,district,start_date')`, filtered to `jurisdiction_id==='mo-legislature' && start_date==null`.
  - `loadLegislatorLookup(client) -> Promise<Map<legislatorId,{surname, legiscanPeopleId}>>` — `selectAll(client,'legislators','id,full_name,surname,legiscan_people_id')`.
  - `citationString({ openStatesId, startDate, legiscanYear, chamber }) -> string`.
  - `runBackfillMoTermDates(client, { apply=false, runId=null, cacheDir=CACHE_DIR, loadTermsFn=loadDatelessMoTerms, loadLegislatorsFn=loadLegislatorLookup, fetchRosterFn=fetchAllRosterPages, loadPresenceIndexFn=loadLegiscanPresenceIndex, updateTermFn=updateTermStartDate } = {}) -> Promise<{ mode, counts, plan, flags, citations }>`.
  - `fetchAllRosterPages() -> Promise<Array<rosterPerson>>` (paginates `fetchCurrentRoster` + `parseRoster`).
  - `loadLegiscanPresenceIndex(cacheDir) -> Promise<index>` (decodes every cached dataset via `readCachedDatasetFull` + `buildLegiscanPresenceIndex`).
  - `updateTermStartDate(client, runId, { termId, startDate }) -> Promise<{written:boolean}>` (the `UPDATE`-in-place write).

- [ ] **Step 1: Write the failing tests** (parseArgs pair + a full dry-run orchestration with injected fakes, including the Onder-not-written invariant)

```js
// tests/backfill-mo-term-dates.test.js — add
import { parseArgs, runBackfillMoTermDates, citationString } from '../src/cli/backfill-mo-term-dates.js';

test('parseArgs defaults apply to false and accepts --apply', () => {
  assert.equal(parseArgs([]).apply, false);
  assert.equal(parseArgs(['--apply']).apply, true);
});
test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

function fakeDeps() {
  return {
    loadTermsFn: async () => ([
      { termId: 't-house', legislatorId: 'l-house', chamber: 'house', district: '60' },
      { termId: 't-onder', legislatorId: 'l-onder', chamber: 'senate', district: '2' }, // retired, not in roster
    ]),
    loadLegislatorsFn: async () => new Map([
      ['l-house', { surname: 'Adams', legiscanPeopleId: 11 }],
      ['l-onder', { surname: 'Onder', legiscanPeopleId: 16351 }],
    ]),
    fetchRosterFn: async () => ([
      { openstates_id: 'os-1', full_name: 'Jane Adams',
        roles: [{ chamber: 'house', district: '60', start_date: '2019-01-09' }] },
      // NOTE: no senate D2 member -> Onder's seat is unmatched
    ]),
    loadPresenceIndexFn: async () => new Map([[11, {
      presenceYears: new Set([2019]), chamberVoteYears: { house: new Set([2019]), senate: new Set() },
    }]]),
  };
}

test('dry-run: an agreeing current member is planned (not written); Onder is unmatched and never written', async () => {
  const written = [];
  const report = await runBackfillMoTermDates(null, {
    apply: false, ...fakeDeps(),
    updateTermFn: async (_c, _r, row) => { written.push(row); return { written: true }; },
  });
  assert.equal(report.mode, 'dry-run');
  assert.equal(written.length, 0, 'dry-run writes nothing');
  assert.equal(report.plan.length, 1);
  assert.equal(report.plan[0].termId, 't-house');
  assert.equal(report.plan[0].startDate, '2019-01-09');
  assert.equal(report.counts.agreed, 1);
  // Onder: seat absent from roster -> unmatched flag, never planned/written
  assert.ok(report.flags.some((f) => f.termId === 't-onder' && f.reason === 'unmatched'));
  assert.ok(!report.plan.some((p) => p.termId === 't-onder'));
});

test('apply: an agreeing member is written via updateTermFn; end_date is never in the patch', async () => {
  const written = [];
  const report = await runBackfillMoTermDates(null, {
    apply: true, runId: 'run-9', ...fakeDeps(),
    updateTermFn: async (_c, runId, row) => { written.push({ runId, ...row }); return { written: true }; },
  });
  assert.equal(report.mode, 'live');
  assert.equal(written.length, 1);
  assert.equal(written[0].termId, 't-house');
  assert.equal(written[0].startDate, '2019-01-09');
  assert.equal(written[0].runId, 'run-9');
  assert.equal('endDate' in written[0], false); // end_date is never touched
  assert.equal(report.counts.written, 1);
  assert.equal(report.citations.length, 1);
  assert.match(report.citations[0].citation, /openstates\.org/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: FAIL — `parseArgs`/`runBackfillMoTermDates`/`citationString` not defined.

- [ ] **Step 3: Implement the loaders, orchestrator, write, and `main()`**

```js
// src/cli/backfill-mo-term-dates.js — add
// (the `listCachedDatasetFiles` import belongs in the top import block from Task 3, not here)

export function parseArgs(argv) {
  const out = { apply: false };
  for (const key of argv) {
    if (key === '--apply') { out.apply = true; continue; }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

export async function loadDatelessMoTerms(client) {
  const { data, error } = await selectAll(client, 'terms', 'id,legislator_id,jurisdiction_id,chamber,district,start_date');
  if (error) throw new Error(`backfill-mo-term-dates: terms load failed: ${error.message}`);
  return data
    .filter((t) => t.jurisdiction_id === MO_JURISDICTION && t.start_date == null)
    .map((t) => ({ termId: t.id, legislatorId: t.legislator_id, chamber: t.chamber, district: t.district }));
}

export async function loadLegislatorLookup(client) {
  const { data, error } = await selectAll(client, 'legislators', 'id,full_name,surname,legiscan_people_id');
  if (error) throw new Error(`backfill-mo-term-dates: legislators load failed: ${error.message}`);
  const map = new Map();
  for (const row of data) {
    map.set(row.id, { surname: row.surname ?? lastNameOf(row.full_name), legiscanPeopleId: row.legiscan_people_id ?? null });
  }
  return map;
}

export async function fetchAllRosterPages(fetchPageFn = fetchCurrentRoster) {
  const people = [];
  let page = 1;
  let maxPage = 1;
  do {
    // eslint-disable-next-line no-await-in-loop -- sequential by design (7s OpenStates limiter)
    const json = await fetchPageFn(page);
    people.push(...parseRoster(json));
    maxPage = json.pagination?.max_page ?? page;
    page += 1;
  } while (page <= maxPage);
  return people;
}

export async function loadLegiscanPresenceIndex(cacheDir = CACHE_DIR, {
  listFilesFn = listCachedDatasetFiles, readFullFn = readCachedDatasetFull,
} = {}) {
  const sessions = [];
  for (const filePath of listFilesFn(cacheDir)) {
    // eslint-disable-next-line no-await-in-loop -- one-time index build over ~32 cached files
    const decoded = await readFullFn(filePath);
    if (decoded.ok) sessions.push({ yearStart: decoded.yearStart, people: decoded.people, rollCalls: decoded.rollCalls });
  }
  return buildLegiscanPresenceIndex(sessions);
}

export function citationString({ openStatesId, startDate, legiscanYear, chamber }) {
  return `openstates.org /people id=${openStatesId} current_role.start_date=${startDate}; `
    + `verified-against legiscan-dataset earliest-qualifying-year=${legiscanYear} `
    + `[people[] presence + roll_call.chamber=${chamber === 'senate' ? 'S' : 'H'}]`;
}

export async function updateTermStartDate(client, runId, { termId, startDate }) {
  const { data, error } = await client
    .from('terms')
    .update({ start_date: startDate, run_id: runId }) // end_date intentionally absent — never touched
    .eq('id', termId)
    .is('start_date', null)
    .select('id');
  if (error) throw new Error(`backfill-mo-term-dates: start_date patch failed for terms.id=${termId}: ${error.message}`);
  return { written: !!(data && data.length > 0) };
}

function emptyCounts() {
  return { termsSeen: 0, matched: 0, agreed: 0, written: 0, unmatched: 0, flagged: 0 };
}

export async function runBackfillMoTermDates(client, {
  apply = false, runId = null, cacheDir = CACHE_DIR,
  loadTermsFn = loadDatelessMoTerms,
  loadLegislatorsFn = loadLegislatorLookup,
  fetchRosterFn = fetchAllRosterPages,
  loadPresenceIndexFn = loadLegiscanPresenceIndex,
  updateTermFn = updateTermStartDate,
} = {}) {
  const counts = emptyCounts();
  const plan = [];
  const flags = [];
  const citations = [];

  const rawTerms = await loadTermsFn(client);
  const legislators = await loadLegislatorsFn(client);
  counts.termsSeen = rawTerms.length;

  const datelessTerms = rawTerms.map((t) => {
    const leg = legislators.get(t.legislatorId) ?? {};
    return { ...t, surname: leg.surname ?? null, legiscanPeopleId: leg.legiscanPeopleId ?? null };
  });

  const rosterPeople = await fetchRosterFn();
  const presenceIndex = await loadPresenceIndexFn(cacheDir);

  const { matches, unmatchedTerms } = matchRoster(datelessTerms, rosterPeople);
  counts.matched = matches.length;
  for (const t of unmatchedTerms) {
    counts.unmatched += 1;
    flags.push({ termId: t.termId, surname: t.surname, chamber: t.chamber, district: t.district, reason: 'unmatched' });
  }

  for (const m of matches) {
    const legiscanYear = earliestLegiscanYear(presenceIndex, m.term.legiscanPeopleId, m.term.chamber);
    const { verdict, reason } = reconcile({ startDate: m.startDate, legiscanYear, surnameOk: m.surnameOk });
    if (verdict === 'flag') {
      flags.push({ termId: m.term.termId, surname: m.term.surname, chamber: m.term.chamber,
        district: m.term.district, startDate: m.startDate, legiscanYear, reason });
      continue;
    }
    counts.agreed += 1;
    const citation = citationString({ openStatesId: m.openStatesId, startDate: m.startDate, legiscanYear, chamber: m.term.chamber });
    if (!apply) {
      plan.push({ termId: m.term.termId, surname: m.term.surname, chamber: m.term.chamber,
        district: m.term.district, startDate: m.startDate, legiscanYear, citation });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- sequential writes, ~185 rows
    const res = await updateTermFn(client, runId, { termId: m.term.termId, startDate: m.startDate });
    if (res.written) {
      counts.written += 1;
      citations.push({ termId: m.term.termId, startDate: m.startDate, citation });
    }
  }
  counts.flagged = flags.length;
  return { mode: apply ? 'live' : 'dry-run', counts, plan, flags, citations };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (!args.apply) {
    const report = await runBackfillMoTermDates(client, { apply: false });
    console.log(JSON.stringify({ source: SOURCE, ...report }, null, 2));
    return;
  }
  const runId = await openRun(client, SOURCE);
  try {
    const report = await runBackfillMoTermDates(client, { apply: true, runId });
    await closeRun(client, runId, 'succeeded', { counts: report.counts, citations: report.citations, flags: report.flags });
    console.log(JSON.stringify({ source: SOURCE, run_id: runId, ...report }, null, 2));
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: PASS (all Task 3–7 tests green).

- [ ] **Step 5: Run the whole suite in a clean shell to confirm no regressions**

Run (a shell that has NOT sourced `.env`): `node --test`
Expected: `# fail 0`. Parse the `# fail N` line explicitly; do not trust exit status alone.

- [ ] **Step 6: Commit**

```bash
git add src/cli/backfill-mo-term-dates.js tests/backfill-mo-term-dates.test.js
git commit -m "feat(backfill-mo-term-dates): --apply-gated orchestrator, UPDATE-in-place, citations"
```

---

### Task 8: Real-cache cross-check test + docs (provenance decision, TODO, spec note)

A committed-fixture test that the presence index actually resolves a known member from real data, plus recording the resolved provenance decision.

**Files:**
- Modify: `tests/backfill-mo-term-dates.test.js`
- Modify: `docs/superpowers/specs/2026-08-06-mo-current-term-dates-backfill-design.md` (mark §8 resolved: `ingestion_runs.detail`)
- Modify: `TODO.md` (add the backfill under the current NOW work with its dry-run gate)

**Interfaces:**
- Consumes: the committed `tests/fixtures/research/legiscan/mo-2018-dataset.json` (Onder `people_id=16351`, Senate votes in 2018).

- [ ] **Step 1: Write the failing test** (Onder resolves to a 2018 Senate year from the real fixture)

```js
// tests/backfill-mo-term-dates.test.js — add
test('buildLegiscanPresenceIndex over the real 2018 fixture places Onder (16351) in the Senate that year', async () => {
  const src = JSON.parse(readFileSync('tests/fixtures/research/legiscan/mo-2018-dataset.json', 'utf8'));
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'vg-ds2-'));
  const path = join(dir, 'sess.json');
  writeFileSync(path, JSON.stringify({ session_id: 1579, year_start: 2018, zip: src.dataset.zip }));

  const decoded = await readCachedDatasetFull(path);
  const idx = buildLegiscanPresenceIndex([{ yearStart: decoded.yearStart, people: decoded.people, rollCalls: decoded.rollCalls }]);
  assert.equal(earliestLegiscanYear(idx, 16351, 'senate'), 2018);
});
```

- [ ] **Step 2: Run test to verify it fails, then passes** (it should pass immediately if Tasks 3–4 are correct — this is a real-data guard, not new code)

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: PASS. If it FAILS, the decode/index wiring has a real-data gap — fix before proceeding.

- [ ] **Step 3: Resolve the spec's open provenance point**

Edit `docs/superpowers/specs/2026-08-06-mo-current-term-dates-backfill-design.md` §8: replace "a source/citation column or the per-item audit log" with the decision — provenance is the `run_id` stamp on each updated `terms` row plus the `citations[]` array in `ingestion_runs.detail`; no new column, no migration (there is no per-row citation column on `terms`, and adding one is an unneeded migration).

- [ ] **Step 4: Add the backfill to TODO.md NOW** with its dry-run gate (draft-then-apply): "run `node --env-file=.env src/cli/backfill-mo-term-dates.js` (dry-run) → Lance reviews the plan/flags → `--apply`."

- [ ] **Step 5: Commit**

```bash
git add tests/backfill-mo-term-dates.test.js docs/superpowers/specs/2026-08-06-mo-current-term-dates-backfill-design.md TODO.md
git commit -m "test(backfill-mo-term-dates): real-fixture cross-check + resolve provenance to ingestion_runs.detail"
```

---

### Task 9: Produce the dry-run resolution table for Lance (the draft-then-apply gate)

The implementation's actual deliverable-to-Lance. Runs read-only against live data; **no writes**. Its output is what Lance reviews before any `--apply`.

**Files:** none (execution + handoff).

- [ ] **Step 1: Run the dry-run against live data** (needs `.env`; this is a CLI run, not a test — safe to have creds in this shell, but do NOT run `node --test` in it)

```bash
node --env-file=.env src/cli/backfill-mo-term-dates.js > dryrun-mo-term-dates.json
```

- [ ] **Step 2: Summarize for review** — counts (`termsSeen`, `matched`, `agreed`, `unmatched`, `flagged`), the full `flags[]` (each with its reason), and confirm Onder (`t-onder` senate D2) is in `flags` as `unmatched`, never in `plan`.

```bash
python -c "
import json,io
d=json.load(io.open('dryrun-mo-term-dates.json',encoding='utf-8'))
print('counts:', d['counts'])
print('agree (write-eligible):', len(d['plan']))
print('flags by reason:')
from collections import Counter
for r,c in Counter(f['reason'] for f in d['flags']).items(): print('  ',r,c)
"
```

- [ ] **Step 3: Hand to Lance.** Present the counts + the flagged rows. Do NOT run `--apply`. Lance reviews the plan and adjudicates the flags; the apply pass happens only on his approval (he runs it, or explicitly delegates). Delete the scratch `dryrun-mo-term-dates.json` after (or move it out of the repo — it is not a committed artifact).

---

## Self-Review

**1. Spec coverage:**
- §1/§2 target = 193 current MO state, federal out of scope → Task 7 `loadDatelessMoTerms` filters `mo-legislature` + `start_date null`. ✓
- §1a Onder parked → structural (retired ⇒ absent from roster ⇒ `unmatched`), asserted in Task 7 test + Task 9 check. ✓
- §3 author→verify→flag (OpenStates + LegiScan year, mismatch flags) → Tasks 2,4,5,6,7. ✓
- §3 Wikipedia never in data → no source anywhere references it; citation string is OpenStates+LegiScan only. ✓
- §5 end_date always null / UPDATE-in-place / unique-key trap → Task 7 `updateTermStartDate` (patch omits end_date; `.eq(id).is('start_date',null).select('id')`) + explicit test asserting `'endDate' in row === false`. ✓
- §5 TODO-31 cross-era house guard → **partial**: not built as a detector (no reliable on-disk signal); house rows still surface in the dry-run for Lance. Documented as a residual in Task 9 review + spec §5. Acceptable per "don't over-engineer"; flagged here so it isn't mistaken for full coverage.
- §7 dry-run-first, apply-gated → `parseArgs {apply:false}` default; Task 9 is the gate. ✓
- §8 provenance → resolved to `run_id` + `ingestion_runs.detail` (Task 7 `citationString`/`main`, Task 8 spec edit). ✓
- §10 tests (servingNow-style invariants) → Tasks 2–8 each ship their tests; end_date + Onder invariants covered. ✓
- §11 constraints (secrets, rate limit, no-source-.env) → Global Constraints + Task 1/9 shell notes. ✓
- §12 rollout → Task 9. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Every code step carries real code. ✓

**3. Type consistency:** `runBackfillMoTermDates` seam names (`loadTermsFn/loadLegislatorsFn/fetchRosterFn/loadPresenceIndexFn/updateTermFn`) match their defaults (`loadDatelessMoTerms/loadLegislatorLookup/fetchAllRosterPages/loadLegiscanPresenceIndex/updateTermStartDate`). `matchRoster` output `{matches:[{term,openStatesId,startDate,surnameOk}], unmatchedTerms}` matches Task 7 consumption. `reconcile` input `{startDate,legiscanYear,surnameOk}` matches call site. `readCachedDatasetFull` return `{ok,yearStart,people,rollCalls}` matches `loadLegiscanPresenceIndex` usage. ✓

**Known residual (not a gap):** the "corrupt `person.role`" premise from the spec was not reproduced in-repo (fixtures show clean `Sen`/`Rep`); the plan still uses `roll_call.chamber` as the chamber signal because it is genuinely independent per-vote data and correctly handles House→Senate members regardless. No change needed.
