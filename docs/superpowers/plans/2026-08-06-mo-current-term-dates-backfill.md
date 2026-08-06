# MO Current-Legislator Term Start-Date Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the 193 current MO *state* legislators' `terms.start_date` with real OpenStates dates, cross-checked against on-disk LegiScan session-years, mismatches flagged for human review, via a new dry-run-first `backfill-mo-term-dates.js` CLI.

**Architecture:** A new date-filler CLI cloned from `backfill-federal-names.js`'s shape (pure resolvers + an injectable-seam orchestrator + a thin `main()`). The `openstates/people` CC0 YAML data (cached locally, like `congress-legislators`) supplies the authored day-precision date — **amended 2026-08-06 after the original v3-API path was live-disproven (the API exposes no role dates)**; the 32 cached LegiScan datasets supply an independent earliest-qualifying-year verifier (people-presence + `roll_call.chamber`); a pure `reconcile` gate marks each term `agree` (write-eligible) or `flag`. Writes are `UPDATE`-in-place on the null-`start_date` row, `end_date` never touched, gated behind `--apply` (dry-run is the default). Provenance = `run_id` stamp + a citation list (incl. the source repo commit SHA) in `ingestion_runs.detail`.

**Tech Stack:** Node ≥22 ESM, `node:test` + `node:assert/strict`, `@supabase/supabase-js` (service role, via `src/lib/db.js`), `yaml` (new dep) for the cached `openstates/people` data, cached LegiScan datasets (`src/adapters/legiscan-dataset.js`).

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

### Task 1: Cache the `openstates/people` MO YAML data + commit fixtures + add the `yaml` dependency

> **AMENDED 2026-08-06 (Lance-approved):** the original Task 1 probed the OpenStates v3 API and its
> decision gate correctly FIRED — the API does not expose role dates at all (`include=other_roles`
> is rejected 422; `current_role` has no `start_date`). The author source is now the
> **`openstates/people` CC0-1.0 GitHub data repo**, whose `data/mo/legislature/*.yml` files carry
> full role history at day precision (verified live: Crossley `start_date: 2023-01-04`; Schnelting
> three dated roles incl. a House→Senate transition). This task caches that data locally, captures
> committed fixtures, and adds the `yaml` parser dependency.

**Files:**
- Create: `.superpowers/artifacts/openstates-people/mo-legislature/*.yml` (gitignored cache, ~192 files)
- Create: `.superpowers/artifacts/openstates-people/manifest.json` (gitignored: `{ source, commit, retrieved, count }`)
- Create: `tests/fixtures/openstates-people/Aaron-Crossley-ba6eb394-0402-49ba-9917-c5618d8a1589.yml` (committed, verbatim)
- Create: `tests/fixtures/openstates-people/Adam-Schnelting-f436aa10-c006-4128-9748-050bf50c4e21.yml` (committed, verbatim — the House→Senate transition case)
- Modify: `package.json` + `package-lock.json` (add `yaml`)

**Interfaces:**
- Produces: the cache dir + manifest every later task reads; two committed YAML fixtures; the `yaml` package importable as `import { parse } from 'yaml'`.

- [ ] **Step 1: Shallow sparse-clone the data repo and copy the MO legislature dir into the cache**

```bash
cd /tmp && rm -rf osp-clone && git clone --depth 1 --filter=blob:none --sparse https://github.com/openstates/people.git osp-clone
cd osp-clone && git sparse-checkout set data/mo/legislature && COMMIT=$(git rev-parse HEAD) && cd /f/VisibleGov
mkdir -p .superpowers/artifacts/openstates-people/mo-legislature
cp /tmp/osp-clone/data/mo/legislature/*.yml .superpowers/artifacts/openstates-people/mo-legislature/
COUNT=$(ls .superpowers/artifacts/openstates-people/mo-legislature/*.yml | wc -l)
python - "$COMMIT" "$COUNT" <<'PYEOF'
import json, sys, datetime
json.dump({"source": "https://github.com/openstates/people (CC0-1.0)", "path": "data/mo/legislature",
           "commit": sys.argv[1], "retrieved": datetime.date.today().isoformat(), "count": int(sys.argv[2])},
          open(".superpowers/artifacts/openstates-people/manifest.json", "w"), indent=2)
PYEOF
rm -rf /tmp/osp-clone
```
Expected: ~192 `.yml` files cached; manifest written with the source commit SHA.

- [ ] **Step 2: Verify the cached shape — roles carry `start_date`, `type` (lower/upper), `district`**

```bash
grep -A3 "^roles:" ".superpowers/artifacts/openstates-people/mo-legislature/Aaron-Crossley-ba6eb394-0402-49ba-9917-c5618d8a1589.yml"
```
Expected: a `- start_date: 2023-01-04` line with `type: lower` and `district: '29'`.

- [ ] **Step 3: Copy the two fixtures verbatim and install the `yaml` package**

```bash
mkdir -p tests/fixtures/openstates-people
cp ".superpowers/artifacts/openstates-people/mo-legislature/Aaron-Crossley-ba6eb394-0402-49ba-9917-c5618d8a1589.yml" tests/fixtures/openstates-people/
cp ".superpowers/artifacts/openstates-people/mo-legislature/Adam-Schnelting-f436aa10-c006-4128-9748-050bf50c4e21.yml" tests/fixtures/openstates-people/
npm install yaml
```

- [ ] **Step 4: Whole suite still green in a clean shell** — `node --test`, expect `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/openstates-people/ package.json package-lock.json
git commit -m "test(fixture): openstates/people MO YAML fixtures + yaml dep for term-date backfill"
```

---

### Task 2: `parsePersonYaml` + `loadCachedRoster` in the backfill CLI module

Parses one `openstates/people` YAML into the roster-person shape the rest of the pipeline consumes, and loads the whole cache dir. Lives in the new CLI module (the API adapter `mo-legislature.js` is untouched — this data comes from files, not the API).

**Files:**
- Create: `src/cli/backfill-mo-term-dates.js` (module start: imports + these two functions; Task 3 extends the same file)
- Test: `tests/backfill-mo-term-dates.test.js` (new)

**Interfaces:**
- Consumes: the Task 1 fixtures; `parse` from `yaml`; `readFileSync`/`readdirSync` from `node:fs`.
- Produces:
  - `parsePersonYaml(text) -> { openstates_id, full_name, family_name, party, roles: Array<{chamber:'house'|'senate', district:string|null, start_date:string|null, end_date:string|null}> }` — maps `type: lower->house / upper->senate` (any other type skipped), coerces district/dates to strings (YAML parses bare dates as strings here; guard with `String()`), `party` = first `party[].name` or null.
  - `loadCachedRoster(cacheDir, { readdirFn, readFileFn } = {}) -> Array<person>` — parses every `*.yml` in the dir, sorted by filename; throws if the dir is missing/empty (the cache is required input, not optional).

- [ ] **Step 1: Write the failing test**

```js
// tests/backfill-mo-term-dates.test.js
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePersonYaml, loadCachedRoster } from '../src/cli/backfill-mo-term-dates.js';

const crossleyYaml = readFileSync('tests/fixtures/openstates-people/Aaron-Crossley-ba6eb394-0402-49ba-9917-c5618d8a1589.yml', 'utf8');
const schneltingYaml = readFileSync('tests/fixtures/openstates-people/Adam-Schnelting-f436aa10-c006-4128-9748-050bf50c4e21.yml', 'utf8');

test('parsePersonYaml maps a current House member with a day-precision start_date', () => {
  const p = parsePersonYaml(crossleyYaml);
  assert.equal(p.full_name, 'Aaron Crossley');
  assert.equal(p.family_name, 'Crossley');
  assert.match(p.openstates_id, /^ocd-person\//);
  const role = p.roles.find((r) => r.chamber === 'house');
  assert.equal(role.district, '29');
  assert.equal(role.start_date, '2023-01-04');
  assert.equal(role.end_date, null);
});

test('parsePersonYaml keeps full role history for a House→Senate transition member', () => {
  const p = parsePersonYaml(schneltingYaml);
  const senate = p.roles.find((r) => r.chamber === 'senate');
  assert.equal(senate.district, '23');
  assert.equal(senate.start_date, '2025-01-08');
  assert.equal(senate.end_date, null);
  const endedHouse = p.roles.filter((r) => r.chamber === 'house' && r.end_date);
  assert.ok(endedHouse.length >= 1, 'prior house roles carry end dates');
});

test('loadCachedRoster parses every yml in a dir and throws on a missing/empty dir', () => {
  const people = loadCachedRoster('tests/fixtures/openstates-people');
  assert.equal(people.length, 2);
  assert.ok(people.every((p) => p.openstates_id && Array.isArray(p.roles)));
  assert.throws(() => loadCachedRoster('tests/fixtures/does-not-exist'), /openstates-people cache/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: FAIL — module/functions do not exist.

- [ ] **Step 3: Implement**

```js
// src/cli/backfill-mo-term-dates.js
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getClient, openRun, closeRun, selectAll } from '../lib/db.js';
import { decodeDatasetZip, extractDatasetFiles } from '../adapters/legiscan-dataset.js';
import { mapLegiscanChamber } from '../adapters/legiscan-votes.js';
import { listCachedDatasetFiles } from './backfill-nicknames.js';

const CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';
const ROSTER_CACHE_DIR = '.superpowers/artifacts/openstates-people/mo-legislature';
const SOURCE = 'backfill-mo-term-dates';
const MO_JURISDICTION = 'mo-legislature';

const TYPE_CHAMBER = { lower: 'house', upper: 'senate' };

export function parsePersonYaml(text) {
  const p = parseYaml(text);
  const roles = [];
  for (const r of p.roles ?? []) {
    const chamber = TYPE_CHAMBER[r.type];
    if (!chamber) continue;
    roles.push({
      chamber,
      district: r.district != null ? String(r.district) : null,
      start_date: r.start_date != null ? String(r.start_date) : null,
      end_date: r.end_date != null ? String(r.end_date) : null,
    });
  }
  return {
    openstates_id: p.id,
    full_name: p.name,
    family_name: p.family_name ?? null,
    party: p.party?.[0]?.name ?? null,
    roles,
  };
}

export function loadCachedRoster(cacheDir = ROSTER_CACHE_DIR, {
  readdirFn = readdirSync, readFileFn = readFileSync,
} = {}) {
  let files;
  try { files = readdirFn(cacheDir); } catch {
    throw new Error(`backfill-mo-term-dates: openstates-people cache missing at ${cacheDir} — run the Task 1 cache step first`);
  }
  const ymls = files.filter((f) => f.endsWith('.yml')).sort();
  if (ymls.length === 0) {
    throw new Error(`backfill-mo-term-dates: openstates-people cache empty at ${cacheDir}`);
  }
  return ymls.map((f) => parsePersonYaml(readFileFn(join(cacheDir, f), 'utf8')));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/backfill-mo-term-dates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/backfill-mo-term-dates.js tests/backfill-mo-term-dates.test.js
git commit -m "feat(backfill-mo-term-dates): parse openstates/people YAML + load cached roster"
```

---

### Task 3: `readCachedDatasetFull` — decode wrapper that returns BOTH people and rollCalls

The existing `readCachedDatasetPeople` (in `backfill-nicknames.js`) decodes the full archive but discards `rollCalls`, which the cross-check needs. Add a self-contained wrapper in the CLI module (created in Task 2; its import block already carries everything this needs).

**Files:**
- Modify: `src/cli/backfill-mo-term-dates.js` (add this function)
- Test: `tests/backfill-mo-term-dates.test.js` (extend)

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

- [ ] **Step 3: Implement `readCachedDatasetFull`** (append to the existing module — imports/constants already there from Task 2)

```js
// src/cli/backfill-mo-term-dates.js — add

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
    - each roster person is a `parsePersonYaml` element `{ openstates_id, full_name, family_name, roles:[{chamber, district, start_date, end_date}] }`.
    - Match key: a roster role whose `chamber` and `String(district)` equal the term's, **and whose `end_date` is null** (only a person's *current* role identifies their current seat — Schnelting's ended House-69 role must not match today's House-69 term). `surnameOk` = the term surname equals the person's `family_name` (falling back to `lastNameOf(full_name)`), case-insensitive. No match → the term goes to `unmatchedTerms`.

- [ ] **Step 1: Write the failing test**

```js
// tests/backfill-mo-term-dates.test.js — add
import { matchRoster, lastNameOf } from '../src/cli/backfill-mo-term-dates.js';

const ROSTER = [
  { openstates_id: 'os-1', full_name: 'Jane Adams', family_name: 'Adams',
    roles: [{ chamber: 'house', district: '60', start_date: '2019-01-09', end_date: null }] },
  { openstates_id: 'os-2', full_name: 'Bob Baker', family_name: 'Baker',
    roles: [
      { chamber: 'senate', district: '2', start_date: '2023-01-04', end_date: null },
      { chamber: 'house', district: '60', start_date: '2017-01-04', end_date: '2023-01-03' }, // ended — must NOT steal seat house|60
    ] },
];

test('matchRoster joins by (chamber, district) on OPEN roles only and carries the role start_date', () => {
  const terms = [
    { termId: 't1', legislatorId: 'l1', chamber: 'house', district: '60', surname: 'Adams', legiscanPeopleId: 11 },
  ];
  const { matches, unmatchedTerms } = matchRoster(terms, ROSTER);
  assert.equal(matches.length, 1);
  assert.equal(unmatchedTerms.length, 0);
  assert.equal(matches[0].openStatesId, 'os-1'); // Adams, not Baker's ended house-60 role
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

test('matchRoster: a term whose seat has no OPEN roster role goes to unmatchedTerms', () => {
  const terms = [
    { termId: 't-gone', legislatorId: 'l-gone', chamber: 'house', district: '99', surname: 'Ghost', legiscanPeopleId: 12 },
  ];
  const { matches, unmatchedTerms } = matchRoster(terms, ROSTER);
  assert.equal(matches.length, 0);
  assert.equal(unmatchedTerms.length, 1);
  assert.equal(unmatchedTerms[0].termId, 't-gone');
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
  // index roster roles by chamber|district -> { person, role } — OPEN roles only:
  // an ended role (Schnelting's old House seat) must never claim the seat's current term
  const bySeat = new Map();
  for (const person of rosterPeople) {
    for (const role of person.roles ?? []) {
      if (!role.chamber || role.district == null) continue;
      if (role.end_date != null) continue;
      bySeat.set(`${role.chamber}|${String(role.district)}`, { person, role });
    }
  }
  const matches = [];
  const unmatchedTerms = [];
  for (const term of datelessTerms) {
    const hit = bySeat.get(`${term.chamber}|${String(term.district)}`);
    if (!hit) { unmatchedTerms.push(term); continue; }
    const personSurname = (hit.person.family_name ?? lastNameOf(hit.person.full_name) ?? '').toLowerCase();
    matches.push({
      term,
      openStatesId: hit.person.openstates_id,
      startDate: hit.role.start_date ?? null,
      surnameOk: !!term.surname && personSurname === String(term.surname).toLowerCase(),
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
  - `citationString({ openStatesId, startDate, legiscanYear, chamber, sourceCommit }) -> string`.
  - `runBackfillMoTermDates(client, { apply=false, runId=null, cacheDir=CACHE_DIR, rosterCacheDir=ROSTER_CACHE_DIR, loadTermsFn=loadDatelessMoTerms, loadLegislatorsFn=loadLegislatorLookup, loadRosterFn=loadCachedRoster, loadManifestFn=loadRosterManifest, loadPresenceIndexFn=loadLegiscanPresenceIndex, updateTermFn=updateTermStartDate } = {}) -> Promise<{ mode, counts, plan, flags, citations }>`.
  - `loadRosterManifest() -> { commit:string|null, retrieved:string|null }` — reads `.superpowers/artifacts/openstates-people/manifest.json`; `{commit:null, retrieved:null}` if unreadable.
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
    loadRosterFn: () => ([
      { openstates_id: 'os-1', full_name: 'Jane Adams', family_name: 'Adams',
        roles: [{ chamber: 'house', district: '60', start_date: '2019-01-09', end_date: null }] },
      // NOTE: no senate D2 member -> Onder's seat is unmatched
    ]),
    loadManifestFn: () => ({ commit: 'abc1234def', retrieved: '2026-08-06' }),
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
  assert.match(report.citations[0].citation, /openstates\/people@abc1234def/);
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

export function loadRosterManifest({ readFileFn = readFileSync } = {}) {
  try {
    const m = JSON.parse(readFileFn('.superpowers/artifacts/openstates-people/manifest.json', 'utf8'));
    return { commit: m.commit ?? null, retrieved: m.retrieved ?? null };
  } catch {
    return { commit: null, retrieved: null };
  }
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

export function citationString({ openStatesId, startDate, legiscanYear, chamber, sourceCommit }) {
  return `openstates/people@${sourceCommit ?? 'unknown'} (CC0-1.0) data/mo/legislature `
    + `id=${openStatesId} roles[open].start_date=${startDate}; `
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
  apply = false, runId = null, cacheDir = CACHE_DIR, rosterCacheDir = ROSTER_CACHE_DIR,
  loadTermsFn = loadDatelessMoTerms,
  loadLegislatorsFn = loadLegislatorLookup,
  loadRosterFn = loadCachedRoster,
  loadManifestFn = loadRosterManifest,
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

  const rosterPeople = await loadRosterFn(rosterCacheDir);
  const { commit: sourceCommit } = loadManifestFn();
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
    const citation = citationString({ openStatesId: m.openStatesId, startDate: m.startDate, legiscanYear, chamber: m.term.chamber, sourceCommit });
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
  // Use the 1608 fixture: 189 people + 8 rollCalls (the 1579 fixture decodes to 0 rollCalls —
  // same trap Task 3's review caught).
  const src = JSON.parse(readFileSync('tests/fixtures/research/legiscan/mo-2018-dataset-1608.json', 'utf8'));
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'vg-ds2-'));
  const path = join(dir, 'sess.json');
  writeFileSync(path, JSON.stringify({ session_id: 1608, year_start: 2018, zip: src.dataset.zip }));

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
