# VisibleGov Slice 1: Foundation + Ingestion (Bob Onder) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `ingest` CLI that pulls Bob Onder's legislative record from both sources — US House roll-call votes (Congress.gov + House Clerk XML) and Missouri General Assembly votes (OpenStates) — into the canonical Supabase schema, with provenance, fixture-backed tests, and skip≠empty discipline.

**Architecture:** Node CLI with two source adapters behind one canonical shape. Adapters are pure parsers (fetch payload → canonical objects) unit-tested against committed real fixtures; a thin DB layer does additive, provenance-tagged writes to Supabase. `--dry-run` prints canonical rows as JSON so everything is testable before the DB exists.

**Tech Stack:** Node 20.6+ (ESM, built-in `node:test`, `--env-file`), `@supabase/supabase-js`, `fast-xml-parser`. Supabase Postgres (migration SQL, draft-then-apply — Lance runs it).

## Global Constraints

- Node ≥ 20.6; `"type": "module"`; tests use built-in `node:test` + `node:assert/strict` only.
- Runtime deps limited to: `@supabase/supabase-js`, `fast-xml-parser`. No others without Lance's OK.
- Never commit `.env` (already gitignored). Fixtures ARE committed (public data).
- **Skip ≠ empty (PLAYBOOK §3.1):** a failed/rate-limited fetch must throw a typed error, never return `[]`/null.
- **Additive writes (§3.5):** never overwrite an already-set (non-null) DB field; insert-if-absent for immutable records.
- **Provenance (§3.3):** every written row carries the `ingestion_runs.id` that produced it.
- **Neutrality (§2):** no editorial/score/rating fields anywhere in schema or code.
- **Draft-then-apply:** SQL migrations are written + committed; Lance creates the Supabase project and applies them himself.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- **Before Tasks 5/7:** Lance must supply free API keys in `.env`: `CONGRESS_API_KEY` (https://api.congress.gov/sign-up/), `OPENSTATES_API_KEY` (https://open.pluralpolicy.com/accounts/signup/). Before Task 10: Supabase project + applied migration + `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` in `.env`.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `.env.example`, `tests/smoke.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Produces: npm scripts `npm test` (runs `node --test tests/`) and `npm run ingest` (runs `node --env-file=.env src/cli/ingest.js`). All later tasks rely on these.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "visiblegov",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.6" },
  "scripts": {
    "test": "node --test tests/",
    "ingest": "node --env-file=.env src/cli/ingest.js"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "fast-xml-parser": "^4.4.0"
  }
}
```

- [ ] **Step 2: Write `.env.example`** (real keys go in `.env`, never committed)

```
CONGRESS_API_KEY=get-free-at-api.congress.gov/sign-up
OPENSTATES_API_KEY=get-free-at-open.pluralpolicy.com
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

- [ ] **Step 3: Append to `.gitignore`**

```
node_modules/
```

- [ ] **Step 4: Write failing smoke test** `tests/smoke.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test runner works', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 5: Install and run**

Run: `npm install && npm test`
Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .env.example .gitignore tests/smoke.test.js
git commit -m "chore: scaffold Node project (ESM, node:test, env template)"
```

---

### Task 2: Typed errors + shared rate limiter

**Files:**
- Create: `src/lib/errors.js`, `src/lib/rate-limiter.js`, `src/lib/http.js`
- Test: `tests/lib.test.js`

**Interfaces:**
- Produces: `SourceFetchError`, `RateLimitedError` (both with `.source`, `.url`, `.status`); `createLimiter({ minIntervalMs }) → { take(): Promise<void> }`; `fetchWithLimit(url, { source, limiter, headers?, as: 'json'|'text' }) → Promise<object|string>`. Both adapters and the CLI consume these; nothing in this codebase may ever catch a fetch failure and return an empty result.

- [ ] **Step 1: Write failing tests** `tests/lib.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceFetchError, RateLimitedError } from '../src/lib/errors.js';
import { createLimiter } from '../src/lib/rate-limiter.js';

test('RateLimitedError is a SourceFetchError with metadata', () => {
  const err = new RateLimitedError('slow down', { source: 'us-congress', url: 'https://x', status: 429 });
  assert.ok(err instanceof SourceFetchError);
  assert.ok(err instanceof Error);
  assert.equal(err.source, 'us-congress');
  assert.equal(err.status, 429);
  assert.equal(err.name, 'RateLimitedError');
});

test('limiter spaces out calls by minIntervalMs', async () => {
  const limiter = createLimiter({ minIntervalMs: 30 });
  const t0 = Date.now();
  await limiter.take();
  await limiter.take();
  await limiter.take();
  assert.ok(Date.now() - t0 >= 60, 'three takes must span at least 2 intervals');
});

test('first take is immediate', async () => {
  const limiter = createLimiter({ minIntervalMs: 5000 });
  const t0 = Date.now();
  await limiter.take();
  assert.ok(Date.now() - t0 < 100);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — cannot find module `errors.js`.

- [ ] **Step 3: Implement** `src/lib/errors.js`

```js
export class SourceFetchError extends Error {
  constructor(message, { source, url, status, cause } = {}) {
    super(message, { cause });
    this.name = 'SourceFetchError';
    this.source = source;
    this.url = url;
    this.status = status;
  }
}

export class RateLimitedError extends SourceFetchError {
  constructor(message, meta = {}) {
    super(message, meta);
    this.name = 'RateLimitedError';
  }
}
```

- [ ] **Step 4: Implement** `src/lib/rate-limiter.js`

```js
// One limiter instance per source, shared by every caller in the process (PLAYBOOK §3.2).
export function createLimiter({ minIntervalMs }) {
  let nextSlot = 0;
  return {
    async take() {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + minIntervalMs;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    },
  };
}
```

- [ ] **Step 5: Implement** `src/lib/http.js`

```js
import { SourceFetchError, RateLimitedError } from './errors.js';

// Skip ≠ empty: every failure path here THROWS. No caller may map a catch to [].
export async function fetchWithLimit(url, { source, limiter, headers = {}, as = 'json' }) {
  await limiter.take();
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (cause) {
    throw new SourceFetchError(`network failure fetching ${url}`, { source, url, cause });
  }
  if (res.status === 429) {
    throw new RateLimitedError(`rate limited by ${source}`, { source, url, status: 429 });
  }
  if (!res.ok) {
    throw new SourceFetchError(`HTTP ${res.status} from ${source}: ${url}`, { source, url, status: res.status });
  }
  return as === 'json' ? res.json() : res.text();
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/errors.js src/lib/rate-limiter.js src/lib/http.js tests/lib.test.js
git commit -m "feat: typed fetch errors (skip!=empty), shared per-source rate limiter"
```

---

### Task 3: Additive-merge helper + DB layer

**Files:**
- Create: `src/lib/db.js`
- Test: `tests/db.test.js`

**Interfaces:**
- Produces: `additivePatch(existing, incoming) → object` (pure); `getClient() → SupabaseClient|null` (null when `SUPABASE_URL` unset → CLI runs dry); `openRun(client, source) → Promise<string>` (run id); `closeRun(client, runId, status, detail) → Promise<void>` where status ∈ `'succeeded'|'partial'|'failed'`; `insertIfAbsent(client, table, rows, onConflict) → Promise<void>` (uses upsert with `ignoreDuplicates: true` — write-once). Task 9's CLI consumes all of these.

- [ ] **Step 1: Write failing tests for the pure part** `tests/db.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { additivePatch } from '../src/lib/db.js';

test('additivePatch never overwrites a set field, even when values differ', () => {
  const patch = additivePatch({ title: 'Original', status: null }, { title: 'Different', status: 'passed' });
  assert.deepEqual(patch, { status: 'passed' });
});

test('additivePatch ignores null/undefined incoming values', () => {
  const patch = additivePatch({ title: null }, { title: null, status: undefined });
  assert.deepEqual(patch, {});
});

test('additivePatch fills only null/undefined existing fields', () => {
  const patch = additivePatch({ a: undefined, b: 'kept', c: null }, { a: 1, b: 2, c: 3 });
  assert.deepEqual(patch, { a: 1, c: 3 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — cannot find module `db.js`.

- [ ] **Step 3: Implement** `src/lib/db.js`

```js
import { createClient } from '@supabase/supabase-js';

// Additive writes (PLAYBOOK §3.5): only fields that are currently null/undefined may be filled.
export function additivePatch(existing, incoming) {
  const patch = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === undefined) continue;
    if (existing[key] === null || existing[key] === undefined) patch[key] = value;
  }
  return patch;
}

export function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // callers treat null as dry-run
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function openRun(client, source) {
  const { data, error } = await client
    .from('ingestion_runs')
    .insert({ source, status: 'running' })
    .select('id')
    .single();
  if (error) throw new Error(`could not open ingestion run: ${error.message}`);
  return data.id;
}

export async function closeRun(client, runId, status, detail = {}) {
  const { error } = await client
    .from('ingestion_runs')
    .update({ status, detail, finished_at: new Date().toISOString() })
    .eq('id', runId);
  if (error) throw new Error(`could not close ingestion run ${runId}: ${error.message}`);
}

export async function insertIfAbsent(client, table, rows, onConflict) {
  if (rows.length === 0) return;
  const { error } = await client.from(table).upsert(rows, { onConflict, ignoreDuplicates: true });
  if (error) throw new Error(`insertIfAbsent(${table}) failed: ${error.message}`);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: all pass (only `additivePatch` is unit-tested; client functions get exercised live in Task 10).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.js tests/db.test.js
git commit -m "feat: additive-merge helper and provenance-tagged DB layer"
```

---

### Task 4: Canonical schema migration (draft-then-apply)

**Files:**
- Create: `supabase/migrations/0001_core_schema.sql`, `supabase/migrations/0002_seed_jurisdictions.sql`

**Interfaces:**
- Produces: the table/column names every later task writes to (exactly as in the SQL below). Applying the migration is **Lance's step**, not the implementer's.

- [ ] **Step 1: Write** `supabase/migrations/0001_core_schema.sql`

```sql
-- VisibleGov core schema. RLS is the wall: anon may read public rows only;
-- the ingestion CLI writes with the service role (bypasses RLS by design).

create table jurisdictions (
  id   text primary key,          -- 'us-congress' | 'mo-legislature'
  name text not null
);

create table sessions (
  id              uuid primary key default gen_random_uuid(),
  jurisdiction_id text not null references jurisdictions(id),
  identifier      text not null,  -- '119' for Congress; OpenStates session key for MO
  name            text,
  start_date      date,
  end_date        date,
  unique (jurisdiction_id, identifier)
);

create table legislators (
  id            uuid primary key default gen_random_uuid(),
  full_name     text not null,
  bioguide_id   text unique,      -- federal identity key
  openstates_id text unique,      -- MO identity key
  party         text,
  image_url     text,
  contact       jsonb,
  run_id        uuid
);

create table terms (
  id              uuid primary key default gen_random_uuid(),
  legislator_id   uuid not null references legislators(id),
  jurisdiction_id text not null references jurisdictions(id),
  chamber         text not null check (chamber in ('house','senate')),
  district        text,
  party           text,
  start_date      date,
  end_date        date,
  run_id          uuid,
  unique (legislator_id, jurisdiction_id, chamber, district, start_date)
);

create table bills (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references sessions(id),
  identifier    text not null,    -- 'HR 22', 'SB 4'
  title         text,
  status        text,             -- lifecycle stage; refined in later slices
  canonical_url text,             -- official record link
  run_id        uuid,
  unique (session_id, identifier)
);

create table bill_actions (
  id             uuid primary key default gen_random_uuid(),
  bill_id        uuid not null references bills(id),
  action_date    date not null,
  description    text not null,
  classification text,
  run_id         uuid,
  unique (bill_id, action_date, description)
);

create table bill_texts (
  id           uuid primary key default gen_random_uuid(),
  bill_id      uuid not null references bills(id),
  version      text not null,
  content      text,
  content_hash text,
  source_url   text,
  retrieved_at timestamptz,
  run_id       uuid,
  unique (bill_id, version)
);

create table votes (
  id              uuid primary key default gen_random_uuid(),
  bill_id         uuid references bills(id),   -- nullable: some votes are procedural
  jurisdiction_id text not null references jurisdictions(id),
  chamber         text not null check (chamber in ('house','senate')),
  vote_date       timestamptz,
  question        text,
  result          text,
  source_url      text,
  source_key      text not null unique,        -- dedupe key, e.g. 'us-house-119-2025-123'
  run_id          uuid
);

create table vote_casts (
  id            uuid primary key default gen_random_uuid(),
  vote_id       uuid not null references votes(id),
  legislator_id uuid not null references legislators(id),
  position      text not null check (position in ('yea','nay','present','not_voting','absent','other')),
  run_id        uuid,
  unique (vote_id, legislator_id)
);

create table summaries (
  id             uuid primary key default gen_random_uuid(),
  bill_id        uuid not null references bills(id),
  status         text not null default 'draft' check (status in ('draft','published','rejected','stale')),
  body_md        text,
  model          text,
  prompt_version text,
  bill_text_hash text,
  editor_notes   text,
  run_id         uuid,
  created_at     timestamptz default now(),
  published_at   timestamptz
);

create table ingestion_runs (
  id          uuid primary key default gen_random_uuid(),
  source      text not null,
  status      text not null check (status in ('running','succeeded','partial','failed')),
  detail      jsonb,
  started_at  timestamptz default now(),
  finished_at timestamptz
);

create table districts (
  id              uuid primary key default gen_random_uuid(),
  jurisdiction_id text not null references jurisdictions(id),
  chamber         text not null check (chamber in ('house','senate')),
  district        text not null,
  legislator_id   uuid references legislators(id),
  unique (jurisdiction_id, chamber, district)
);

-- RLS: everything readable EXCEPT unpublished summaries; nothing writable by anon.
alter table jurisdictions  enable row level security;
alter table sessions       enable row level security;
alter table legislators    enable row level security;
alter table terms          enable row level security;
alter table bills          enable row level security;
alter table bill_actions   enable row level security;
alter table bill_texts     enable row level security;
alter table votes          enable row level security;
alter table vote_casts     enable row level security;
alter table summaries      enable row level security;
alter table ingestion_runs enable row level security;
alter table districts      enable row level security;

create policy anon_read on jurisdictions  for select using (true);
create policy anon_read on sessions       for select using (true);
create policy anon_read on legislators    for select using (true);
create policy anon_read on terms          for select using (true);
create policy anon_read on bills          for select using (true);
create policy anon_read on bill_actions   for select using (true);
create policy anon_read on bill_texts     for select using (true);
create policy anon_read on votes          for select using (true);
create policy anon_read on vote_casts     for select using (true);
create policy anon_read on districts      for select using (true);
create policy anon_read_published on summaries for select using (status = 'published');
create policy anon_read on ingestion_runs for select using (true); -- powers the freshness footer
```

- [ ] **Step 2: Write** `supabase/migrations/0002_seed_jurisdictions.sql`

```sql
insert into jurisdictions (id, name) values
  ('us-congress',    'United States Congress'),
  ('mo-legislature', 'Missouri General Assembly');

insert into sessions (jurisdiction_id, identifier, name, start_date) values
  ('us-congress', '119', '119th Congress', '2025-01-03');
-- MO sessions are inserted by the ingest CLI from OpenStates session data (Task 8/9),
-- so their identifiers exactly match the source of record.
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/
git commit -m "feat: canonical schema migration + RLS + jurisdiction seed (draft; Lance applies)"
```

- [ ] **Step 4: GATE — hand to Lance**

Lance: create the Supabase project (free tier), run both files in the SQL editor in order, put `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `.env`. Tasks 1–9 proceed without this; Task 10 is blocked until done.

---

### Task 5: Verify Onder's identifiers + capture federal fixtures

**Files:**
- Create: `slice.config.json`, `tests/fixtures/us-congress/members-mo.json`, `tests/fixtures/us-congress/roll-call.xml`, `tests/fixtures/us-congress/bill-detail.json`

**Interfaces:**
- Consumes: `CONGRESS_API_KEY` in `.env` (Lance-provided).
- Produces: `slice.config.json` with the **verified** shape below — Tasks 6–10 import it. Career facts come from these API responses, never from memory.

- [ ] **Step 1: Capture MO congressional delegation**

Run (PowerShell; `$env:CONGRESS_API_KEY` from `.env`):
```powershell
curl.exe -s "https://api.congress.gov/v3/member/MO?api_key=$env:CONGRESS_API_KEY&limit=250" -o tests/fixtures/us-congress/members-mo.json
```
Expected: JSON with a `members` array. Open it; find the entry whose name contains "Onder". Record his real `bioguideId`, district, and party. If no Onder entry exists, STOP — report to Lance rather than guessing (the MO-3 assumption came from memory and must not survive contact with the source unverified).

- [ ] **Step 2: Capture one House roll-call XML that includes Onder**

Pick a recent 2025 roll number from https://clerk.house.gov/Votes (any full-chamber vote), then:
```powershell
curl.exe -s "https://clerk.house.gov/evs/2025/roll123.xml" -o tests/fixtures/us-congress/roll-call.xml
```
(Replace `123` with the chosen roll, zero-padded exactly as the site shows it.) Open the file; confirm a `<recorded-vote>` whose `<legislator name-id="...">` equals the bioguideId from Step 1. If not present (absence happens), pick a different roll until one contains him.

- [ ] **Step 3: Capture the matching bill detail**

From the XML's `<legis-num>` (e.g. `H R 22` → type slug `hr`, number `22`):
```powershell
curl.exe -s "https://api.congress.gov/v3/bill/119/hr/22?api_key=$env:CONGRESS_API_KEY" -o tests/fixtures/us-congress/bill-detail.json
```
Expected: JSON with a `bill` object containing `title` and `latestAction`.

- [ ] **Step 4: Write `slice.config.json`** with the VERIFIED values (no memory-derived facts):

```json
{
  "onder": {
    "bioguide_id": "<from Step 1>",
    "us_house_district": "<from Step 1>",
    "party": "<from Step 1>",
    "openstates_id": "<filled in Task 7>",
    "mo_senate_district": "<filled in Task 7>"
  },
  "fixture_roll_number": "<from Step 2>",
  "fixture_bill": { "congress": 119, "type_slug": "<from Step 3>", "number": "<from Step 3>" }
}
```

- [ ] **Step 5: Commit**

```bash
git add slice.config.json tests/fixtures/us-congress/
git commit -m "chore: verified Onder federal identifiers + captured real API fixtures"
```

---

### Task 6: us-congress adapter

**Files:**
- Create: `src/adapters/us-congress.js`
- Test: `tests/us-congress.test.js`

**Interfaces:**
- Consumes: `fetchWithLimit`, `createLimiter`, errors (Task 2); fixtures + `slice.config.json` (Task 5).
- Produces (Task 9 consumes):
  - `normalizeBillIdentifier(legisNum: string) → string` (`"H R 22"` → `"HR 22"`)
  - `billTypeSlug(identifier: string) → string` (`"HR 22"` → `"hr"`)
  - `parseMemberList(json) → [{ bioguide_id, full_name, party, chamber: 'house'|'senate', district: string|null }]`
  - `parseHouseRollCall(xml: string, { year }) → { vote: { source_key, chamber:'house', vote_date, question, result, bill_identifier: string|null, source_url }, casts: [{ bioguide_id, position }] }`
  - `parseBillDetail(json) → { identifier, title, status, canonical_url }`
  - `fetchHouseRollCall(rollNumber, year, limiter) → Promise<string>` and `fetchBillDetail(congress, typeSlug, number, limiter) → Promise<object>` (thin fetch wrappers)
- Position mapping: `Yea`/`Aye` → `yea`, `Nay`/`No` → `nay`, `Present` → `present`, `Not Voting` → `not_voting`, anything else → `other`.

- [ ] **Step 1: Write failing tests** `tests/us-congress.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeBillIdentifier, billTypeSlug, parseMemberList, parseHouseRollCall, parseBillDetail,
} from '../src/adapters/us-congress.js';

const cfg = JSON.parse(readFileSync('slice.config.json', 'utf8'));
const membersJson = JSON.parse(readFileSync('tests/fixtures/us-congress/members-mo.json', 'utf8'));
const rollXml = readFileSync('tests/fixtures/us-congress/roll-call.xml', 'utf8');
const billJson = JSON.parse(readFileSync('tests/fixtures/us-congress/bill-detail.json', 'utf8'));

const POSITIONS = new Set(['yea', 'nay', 'present', 'not_voting', 'absent', 'other']);

test('normalizeBillIdentifier collapses Clerk spacing', () => {
  assert.equal(normalizeBillIdentifier('H R 22'), 'HR 22');
  assert.equal(normalizeBillIdentifier('S 5'), 'S 5');
  assert.equal(normalizeBillIdentifier('H J RES 7'), 'HJRES 7');
  assert.equal(normalizeBillIdentifier('H CON RES 14'), 'HCONRES 14');
});

test('billTypeSlug lowers the type part', () => {
  assert.equal(billTypeSlug('HR 22'), 'hr');
  assert.equal(billTypeSlug('SJRES 3'), 'sjres');
});

test('parseMemberList finds Onder with verified identity', () => {
  const members = parseMemberList(membersJson);
  assert.ok(members.length > 0);
  const onder = members.find((m) => m.bioguide_id === cfg.onder.bioguide_id);
  assert.ok(onder, 'Onder must be present in the MO delegation fixture');
  assert.match(onder.full_name, /Onder/);
  for (const m of members) assert.ok(['house', 'senate'].includes(m.chamber));
});

test('parseHouseRollCall yields a full-chamber cast list including Onder', () => {
  const { vote, casts } = parseHouseRollCall(rollXml, { year: 2025 });
  assert.equal(vote.chamber, 'house');
  assert.ok(vote.source_key.startsWith('us-house-'));
  assert.ok(vote.question.length > 0);
  assert.ok(vote.result.length > 0);
  // self-consistency: one cast per <recorded-vote> element in the raw XML
  const rawCount = (rollXml.match(/<recorded-vote>/g) || []).length;
  assert.equal(casts.length, rawCount);
  assert.ok(casts.length > 300, 'a full House roll call has 400+ voting members');
  for (const c of casts) assert.ok(POSITIONS.has(c.position), `bad position: ${c.position}`);
  assert.ok(casts.some((c) => c.bioguide_id === cfg.onder.bioguide_id));
});

test('parseBillDetail extracts canonical bill fields', () => {
  const bill = parseBillDetail(billJson);
  assert.match(bill.identifier, /^(HR|S|HRES|SRES|HJRES|SJRES|HCONRES|SCONRES) \d+$/);
  assert.ok(bill.title.length > 0);
  assert.ok(bill.canonical_url.startsWith('https://www.congress.gov/'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — cannot find module `us-congress.js`.

- [ ] **Step 3: Implement** `src/adapters/us-congress.js`

```js
import { XMLParser } from 'fast-xml-parser';
import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';

export const SOURCE = 'us-congress';
// Congress.gov allows 1000 req/hr => 1 per 3.6s; Clerk XML is separate but be polite anyway.
export const congressLimiter = createLimiter({ minIntervalMs: 3600 });
export const clerkLimiter = createLimiter({ minIntervalMs: 1000 });

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export function normalizeBillIdentifier(legisNum) {
  const s = String(legisNum).trim().toUpperCase();
  const m = s.match(/^([A-Z .]+?)\s+(\d+)$/);
  if (!m) return s;
  return `${m[1].replace(/[ .]/g, '')} ${m[2]}`;
}

export function billTypeSlug(identifier) {
  return identifier.split(' ')[0].toLowerCase();
}

const POSITION_MAP = new Map([
  ['yea', 'yea'], ['aye', 'yea'],
  ['nay', 'nay'], ['no', 'nay'],
  ['present', 'present'],
  ['not voting', 'not_voting'],
]);

export function mapHousePosition(raw) {
  return POSITION_MAP.get(String(raw).trim().toLowerCase()) ?? 'other';
}

export function parseMemberList(json) {
  return (json.members ?? []).map((m) => {
    const items = m.terms?.item ?? [];
    const latest = items[items.length - 1] ?? {};
    return {
      bioguide_id: m.bioguideId,
      full_name: m.name,
      party: m.partyName ?? null,
      chamber: /senate/i.test(latest.chamber ?? '') ? 'senate' : 'house',
      district: m.district != null ? String(m.district) : null,
    };
  });
}

function parseClerkDate(s) {
  // e.g. "10-Apr-2025"
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const m = String(s).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${months[m[2]]}-${m[1].padStart(2, '0')}`;
}

export function parseHouseRollCall(xmlString, { year }) {
  const doc = xml.parse(xmlString);
  const root = doc['rollcall-vote'];
  const meta = root['vote-metadata'];
  const roll = Number(meta['rollcall-num']);
  const legisNum = meta['legis-num'] ? normalizeBillIdentifier(meta['legis-num']) : null;
  let recorded = root['vote-data']['recorded-vote'] ?? [];
  if (!Array.isArray(recorded)) recorded = [recorded];
  return {
    vote: {
      source_key: `us-house-${meta.congress}-${year}-${roll}`,
      chamber: 'house',
      vote_date: parseClerkDate(meta['action-date']),
      question: String(meta['vote-question'] ?? ''),
      result: String(meta['vote-result'] ?? ''),
      bill_identifier: legisNum,
      source_url: `https://clerk.house.gov/evs/${year}/roll${String(roll).padStart(3, '0')}.xml`,
    },
    casts: recorded.map((rv) => ({
      bioguide_id: rv.legislator['@_name-id'],
      position: mapHousePosition(rv.vote),
    })),
  };
}

export function parseBillDetail(json) {
  const b = json.bill;
  const identifier = normalizeBillIdentifier(`${b.type} ${b.number}`);
  return {
    identifier,
    title: b.title ?? '',
    status: b.latestAction?.text ?? null,
    canonical_url: `https://www.congress.gov/bill/${b.congress}th-congress/${slugToPath(b.type)}/${b.number}`,
  };
}

function slugToPath(type) {
  const paths = {
    HR: 'house-bill', S: 'senate-bill', HRES: 'house-resolution', SRES: 'senate-resolution',
    HJRES: 'house-joint-resolution', SJRES: 'senate-joint-resolution',
    HCONRES: 'house-concurrent-resolution', SCONRES: 'senate-concurrent-resolution',
  };
  return paths[String(type).toUpperCase()] ?? 'bill';
}

export function fetchHouseRollCall(rollNumber, year, limiter = clerkLimiter) {
  const url = `https://clerk.house.gov/evs/${year}/roll${String(rollNumber).padStart(3, '0')}.xml`;
  return fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
}

export function fetchBillDetail(congress, typeSlug, number, limiter = congressLimiter) {
  const url = `https://api.congress.gov/v3/bill/${congress}/${typeSlug}/${number}?api_key=${process.env.CONGRESS_API_KEY}`;
  return fetchWithLimit(url, { source: SOURCE, limiter, as: 'json' });
}

export function fetchMemberList(stateCode, limiter = congressLimiter) {
  const url = `https://api.congress.gov/v3/member/${stateCode}?api_key=${process.env.CONGRESS_API_KEY}&limit=250`;
  return fetchWithLimit(url, { source: SOURCE, limiter, as: 'json' });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: all pass. If a parse test fails on a field path, the FIXTURE is the source of truth — fix the parser to match the real payload, never edit the fixture.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/us-congress.js tests/us-congress.test.js
git commit -m "feat: us-congress adapter (member list, Clerk roll-call XML, bill detail)"
```

---

### Task 7: Capture Missouri fixtures + Onder's OpenStates identity

**Files:**
- Create: `tests/fixtures/mo-legislature/sessions.json`, `tests/fixtures/mo-legislature/people-onder.json`, `tests/fixtures/mo-legislature/bills-with-votes.json`
- Modify: `slice.config.json` (fill `openstates_id`, `mo_senate_district`, add `mo_sessions`)

**Interfaces:**
- Consumes: `OPENSTATES_API_KEY` in `.env` (Lance-provided).
- Produces: verified MO identifiers in `slice.config.json`; fixtures for Task 8.

- [ ] **Step 1: Capture MO session list**

```powershell
curl.exe -s -H "X-API-KEY: $env:OPENSTATES_API_KEY" "https://v3.openstates.org/jurisdictions/ocd-jurisdiction/country:us/state:mo/government?include=legislative_sessions" -o tests/fixtures/mo-legislature/sessions.json
```
Open it; note the session `identifier` values covering Onder's Senate years (target 2022 first — his final full year). Record the chosen identifiers as `mo_sessions` in `slice.config.json`.

- [ ] **Step 2: Find Onder's OpenStates person id**

```powershell
curl.exe -s -H "X-API-KEY: $env:OPENSTATES_API_KEY" "https://v3.openstates.org/people?jurisdiction=mo&name=Onder" -o tests/fixtures/mo-legislature/people-onder.json
```
If `results` is non-empty, record `id` (an `ocd-person/...` UUID) and his district from `current_role`/roles. If empty (the API may only search current members and he left in 2023): open https://openstates.org and search "Bob Onder" — his person page URL contains the same UUID; put THAT in the fixture check by re-fetching `https://v3.openstates.org/people?id=<uuid>` into the same file. If neither path yields him, STOP and report to Lance with what was tried — do not fabricate an id.

- [ ] **Step 3: Capture a bills-with-votes page from his era**

```powershell
curl.exe -s -H "X-API-KEY: $env:OPENSTATES_API_KEY" "https://v3.openstates.org/bills?jurisdiction=Missouri&session=2022&include=votes&per_page=20&page=1" -o tests/fixtures/mo-legislature/bills-with-votes.json
```
(Use the real session identifier from Step 1 if it differs from `2022`.) Open it and confirm at least one bill has a non-empty `votes` array with individual voter records. OpenStates MO vote coverage is a known risk (spec flags it) — if several pages show vote objects with counts but NO individual voter arrays, record that honestly in the chatlog as "MO individual votes may need the journal-scraping fallback" and continue; Task 8's parser still handles the shape, and the fallback becomes a build-queue item rather than a silent gap.

- [ ] **Step 4: Update `slice.config.json`** with verified `openstates_id`, `mo_senate_district`, `mo_sessions`.

- [ ] **Step 5: Commit**

```bash
git add slice.config.json tests/fixtures/mo-legislature/
git commit -m "chore: verified Onder MO identifiers + captured OpenStates fixtures"
```

---

### Task 8: mo-legislature adapter

**Files:**
- Create: `src/adapters/mo-legislature.js`
- Test: `tests/mo-legislature.test.js`

**Interfaces:**
- Consumes: Task 2 lib, Task 7 fixtures/config.
- Produces (Task 9 consumes):
  - `parseSessions(json) → [{ identifier, name, start_date, end_date }]`
  - `parsePerson(json) → { openstates_id, full_name, party, roles: [{ chamber:'house'|'senate', district, start_date, end_date }] }` (from a people response's first result)
  - `parseBillsWithVotes(json) → [{ bill: { identifier, title, canonical_url, status }, votes: [{ vote: { source_key, chamber, vote_date, question, result, source_url }, casts: [{ openstates_id: string|null, voter_name: string, position }] }] }]`
  - `fetchBillsWithVotes(session, page, limiter) → Promise<object>`, `fetchSessions(limiter) → Promise<object>`
- Option mapping: `yes` → `yea`, `no` → `nay`, `absent` → `absent`, `not voting` → `not_voting`, `excused`/other → `other`. OpenStates chamber classification: `upper` → `senate`, `lower` → `house`.

- [ ] **Step 1: Write failing tests** `tests/mo-legislature.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSessions, parsePerson, parseBillsWithVotes } from '../src/adapters/mo-legislature.js';

const cfg = JSON.parse(readFileSync('slice.config.json', 'utf8'));
const sessionsJson = JSON.parse(readFileSync('tests/fixtures/mo-legislature/sessions.json', 'utf8'));
const peopleJson = JSON.parse(readFileSync('tests/fixtures/mo-legislature/people-onder.json', 'utf8'));
const billsJson = JSON.parse(readFileSync('tests/fixtures/mo-legislature/bills-with-votes.json', 'utf8'));

const POSITIONS = new Set(['yea', 'nay', 'present', 'not_voting', 'absent', 'other']);

test('parseSessions returns identified sessions', () => {
  const sessions = parseSessions(sessionsJson);
  assert.ok(sessions.length > 0);
  for (const s of sessions) assert.ok(s.identifier.length > 0);
  const wanted = new Set(cfg.mo_sessions);
  assert.ok(sessions.some((s) => wanted.has(s.identifier)), 'config sessions must exist upstream');
});

test('parsePerson extracts Onder with a senate role', () => {
  const person = parsePerson(peopleJson);
  assert.equal(person.openstates_id, cfg.onder.openstates_id);
  assert.match(person.full_name, /Onder/);
  assert.ok(person.roles.some((r) => r.chamber === 'senate'), 'Onder served in the MO Senate');
});

test('parseBillsWithVotes yields canonical bills and enum-safe casts', () => {
  const items = parseBillsWithVotes(billsJson);
  assert.ok(items.length > 0);
  for (const { bill, votes } of items) {
    assert.ok(bill.identifier.length > 0);
    assert.ok(bill.canonical_url.startsWith('https://'));
    for (const { vote, casts } of votes) {
      assert.ok(['house', 'senate'].includes(vote.chamber));
      assert.ok(vote.source_key.startsWith('mo-'));
      for (const c of casts) {
        assert.ok(POSITIONS.has(c.position), `bad position: ${c.position}`);
        assert.ok(c.voter_name.length > 0);
      }
    }
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — cannot find module `mo-legislature.js`.

- [ ] **Step 3: Implement** `src/adapters/mo-legislature.js`

```js
import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';

export const SOURCE = 'mo-legislature';
// OpenStates free tier is tight (per-minute + daily caps): stay well inside it.
export const moLimiter = createLimiter({ minIntervalMs: 7000 });

const BASE = 'https://v3.openstates.org';

function headers() {
  return { 'X-API-KEY': process.env.OPENSTATES_API_KEY };
}

const OPTION_MAP = new Map([
  ['yes', 'yea'], ['no', 'nay'], ['absent', 'absent'], ['not voting', 'not_voting'],
]);

export function mapOpenstatesOption(raw) {
  return OPTION_MAP.get(String(raw).trim().toLowerCase()) ?? 'other';
}

export function mapChamber(classification) {
  if (classification === 'upper') return 'senate';
  if (classification === 'lower') return 'house';
  return null;
}

export function parseSessions(json) {
  return (json.legislative_sessions ?? []).map((s) => ({
    identifier: String(s.identifier),
    name: s.name ?? null,
    start_date: s.start_date || null,
    end_date: s.end_date || null,
  }));
}

export function parsePerson(json) {
  const p = (json.results ?? [])[0];
  if (!p) throw new Error('people fixture/response has no results');
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
}

export function parseBillsWithVotes(json) {
  return (json.results ?? []).map((b) => ({
    bill: {
      identifier: String(b.identifier),
      title: b.title ?? '',
      status: null, // lifecycle stage mapping is a later-slice concern
      canonical_url: b.openstates_url ?? '',
    },
    votes: (b.votes ?? []).map((v) => ({
      vote: {
        source_key: `mo-${v.id}`,
        chamber: mapChamber(v.organization?.classification) ?? mapChamber(b.from_organization?.classification) ?? 'senate',
        vote_date: v.start_date || null,
        question: v.motion_text ?? '',
        result: v.result ?? '',
        source_url: b.openstates_url ?? '',
      },
      casts: (v.votes ?? []).map((pv) => ({
        openstates_id: pv.voter?.id ?? null,
        voter_name: pv.voter_name ?? pv.voter?.name ?? '',
        position: mapOpenstatesOption(pv.option),
      })),
    })),
  }));
}

export function fetchSessions(limiter = moLimiter) {
  const url = `${BASE}/jurisdictions/ocd-jurisdiction/country:us/state:mo/government?include=legislative_sessions`;
  return fetchWithLimit(url, { source: SOURCE, limiter, headers: headers(), as: 'json' });
}

export function fetchBillsWithVotes(session, page, limiter = moLimiter) {
  const url = `${BASE}/bills?jurisdiction=Missouri&session=${encodeURIComponent(session)}&include=votes&per_page=20&page=${page}`;
  return fetchWithLimit(url, { source: SOURCE, limiter, headers: headers(), as: 'json' });
}

export function fetchPersonById(id, limiter = moLimiter) {
  const url = `${BASE}/people?id=${encodeURIComponent(id)}`;
  return fetchWithLimit(url, { source: SOURCE, limiter, headers: headers(), as: 'json' });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: all pass. Same rule as Task 6: the fixture wins; fix the parser, never the fixture.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/mo-legislature.js tests/mo-legislature.test.js
git commit -m "feat: mo-legislature adapter (sessions, person roles, bills-with-votes)"
```

---

### Task 9: Ingest CLI with dry-run

**Files:**
- Create: `src/cli/ingest.js`
- Test: `tests/cli.test.js`

**Interfaces:**
- Consumes: everything produced by Tasks 2, 3, 6, 8.
- Produces: `npm run ingest -- --source us-congress --rolls 120-124` and `npm run ingest -- --source mo-legislature --session 2022 --pages 1`. With no `SUPABASE_URL` set it runs **dry**: prints `{ legislators, bills, votes, casts }` counts + sample rows as JSON to stdout and writes nothing. Exit code 0 = succeeded, 2 = partial (some fetches failed; failures listed), 1 = failed. Also exports `parseArgs(argv) → { source, rolls: [n,...], session, pages }` and `parseRollRange('120-124') → [120,121,122,123,124]` for testing.

- [ ] **Step 1: Write failing tests for arg parsing** `tests/cli.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseRollRange } from '../src/cli/ingest.js';

test('parseRollRange expands inclusive ranges and singles', () => {
  assert.deepEqual(parseRollRange('120-124'), [120, 121, 122, 123, 124]);
  assert.deepEqual(parseRollRange('7'), [7]);
});

test('parseArgs reads source-specific options', () => {
  const us = parseArgs(['--source', 'us-congress', '--rolls', '120-121', '--year', '2025']);
  assert.equal(us.source, 'us-congress');
  assert.deepEqual(us.rolls, [120, 121]);
  assert.equal(us.year, 2025);
  const mo = parseArgs(['--source', 'mo-legislature', '--session', '2022', '--pages', '2']);
  assert.equal(mo.source, 'mo-legislature');
  assert.equal(mo.session, '2022');
  assert.equal(mo.pages, 2);
});

test('parseArgs rejects unknown source', () => {
  assert.throws(() => parseArgs(['--source', 'mars']), /unknown source/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — cannot find module `ingest.js`.

- [ ] **Step 3: Implement** `src/cli/ingest.js`

```js
import { readFileSync } from 'node:fs';
import { getClient, openRun, closeRun, insertIfAbsent, additivePatch } from '../lib/db.js';
import { SourceFetchError } from '../lib/errors.js';
import * as us from '../adapters/us-congress.js';
import * as mo from '../adapters/mo-legislature.js';

export function parseRollRange(spec) {
  const m = String(spec).match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new Error(`bad roll range: ${spec}`);
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

export function parseArgs(argv) {
  const out = { pages: 1, year: new Date().getFullYear() };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--source') out.source = val;
    else if (key === '--rolls') out.rolls = parseRollRange(val);
    else if (key === '--year') out.year = Number(val);
    else if (key === '--session') out.session = val;
    else if (key === '--pages') out.pages = Number(val);
    else throw new Error(`unknown flag: ${key}`);
  }
  if (!['us-congress', 'mo-legislature'].includes(out.source)) {
    throw new Error(`unknown source: ${out.source}`);
  }
  return out;
}

// ---- collection (pure of DB: returns canonical rows + failures, never swallows into []) ----

export async function collectUsCongress({ rolls, year }) {
  const failures = [];
  const memberJson = await us.fetchMemberList('MO'); // throws on failure: fatal, nothing to reconcile
  const legislators = us.parseMemberList(memberJson);
  const bills = new Map();
  const votes = [];
  for (const roll of rolls) {
    try {
      const xmlText = await us.fetchHouseRollCall(roll, year);
      const { vote, casts } = us.parseHouseRollCall(xmlText, { year });
      if (vote.bill_identifier) {
        const slug = us.billTypeSlug(vote.bill_identifier);
        const num = vote.bill_identifier.split(' ')[1];
        try {
          const billJson = await us.fetchBillDetail(119, slug, num);
          bills.set(vote.bill_identifier, us.parseBillDetail(billJson));
        } catch (err) {
          if (!(err instanceof SourceFetchError)) throw err;
          failures.push({ step: `bill ${vote.bill_identifier}`, message: err.message });
          bills.set(vote.bill_identifier, { identifier: vote.bill_identifier, title: null, status: null, canonical_url: null });
        }
      }
      votes.push({ vote, casts });
    } catch (err) {
      if (!(err instanceof SourceFetchError)) throw err;
      failures.push({ step: `roll ${roll}`, message: err.message }); // skip != empty: recorded, not silent
    }
  }
  return { legislators, bills: [...bills.values()], votes, failures, sessionIdentifier: '119' };
}

export async function collectMoLegislature({ session, pages }) {
  const failures = [];
  const sessionsJson = await mo.fetchSessions();
  const sessions = mo.parseSessions(sessionsJson);
  const cfg = JSON.parse(readFileSync('slice.config.json', 'utf8'));
  const personJson = await mo.fetchPersonById(cfg.onder.openstates_id);
  const person = mo.parsePerson(personJson);
  const bills = [];
  const votes = [];
  for (let page = 1; page <= pages; page += 1) {
    try {
      const pageJson = await mo.fetchBillsWithVotes(session, page);
      for (const item of mo.parseBillsWithVotes(pageJson)) {
        bills.push(item.bill);
        for (const v of item.votes) votes.push({ ...v, bill_identifier: item.bill.identifier });
      }
    } catch (err) {
      if (!(err instanceof SourceFetchError)) throw err;
      failures.push({ step: `bills page ${page}`, message: err.message });
    }
  }
  return {
    legislators: [{ openstates_id: person.openstates_id, full_name: person.full_name, party: person.party, roles: person.roles }],
    bills, votes, failures,
    sessionIdentifier: session, sessionMeta: sessions.find((s) => s.identifier === session) ?? null,
  };
}

// ---- persistence ----

async function persistUsCongress(client, runId, data) {
  await insertIfAbsent(client, 'legislators',
    data.legislators.map((l) => ({ full_name: l.full_name, bioguide_id: l.bioguide_id, party: l.party, run_id: runId })),
    'bioguide_id');
  const { data: sessionRow } = await client.from('sessions').select('id')
    .eq('jurisdiction_id', 'us-congress').eq('identifier', data.sessionIdentifier).single();
  await insertIfAbsent(client, 'bills',
    data.bills.map((b) => ({ session_id: sessionRow.id, identifier: b.identifier, title: b.title, status: b.status, canonical_url: b.canonical_url, run_id: runId })),
    'session_id,identifier');
  const { data: legRows } = await client.from('legislators').select('id,bioguide_id').not('bioguide_id', 'is', null);
  const byBioguide = new Map(legRows.map((r) => [r.bioguide_id, r.id]));
  const { data: billRows } = await client.from('bills').select('id,identifier').eq('session_id', sessionRow.id);
  const byIdentifier = new Map(billRows.map((r) => [r.identifier, r.id]));
  for (const { vote, casts } of data.votes) {
    await insertIfAbsent(client, 'votes', [{
      bill_id: vote.bill_identifier ? byIdentifier.get(vote.bill_identifier) ?? null : null,
      jurisdiction_id: 'us-congress', chamber: vote.chamber, vote_date: vote.vote_date,
      question: vote.question, result: vote.result, source_url: vote.source_url,
      source_key: vote.source_key, run_id: runId,
    }], 'source_key');
    const { data: voteRow } = await client.from('votes').select('id').eq('source_key', vote.source_key).single();
    const unknown = casts.filter((c) => !byBioguide.has(c.bioguide_id));
    await insertIfAbsent(client, 'legislators',
      unknown.map((c) => ({ full_name: c.bioguide_id, bioguide_id: c.bioguide_id, run_id: runId })), 'bioguide_id');
    if (unknown.length > 0) {
      const { data: refreshed } = await client.from('legislators').select('id,bioguide_id').not('bioguide_id', 'is', null);
      for (const r of refreshed) byBioguide.set(r.bioguide_id, r.id);
    }
    await insertIfAbsent(client, 'vote_casts',
      casts.map((c) => ({ vote_id: voteRow.id, legislator_id: byBioguide.get(c.bioguide_id), position: c.position, run_id: runId })),
      'vote_id,legislator_id');
  }
}

async function persistMoLegislature(client, runId, data) {
  await insertIfAbsent(client, 'sessions', [{
    jurisdiction_id: 'mo-legislature', identifier: data.sessionIdentifier,
    name: data.sessionMeta?.name ?? null, start_date: data.sessionMeta?.start_date ?? null,
    end_date: data.sessionMeta?.end_date ?? null,
  }], 'jurisdiction_id,identifier');
  const { data: sessionRow } = await client.from('sessions').select('id')
    .eq('jurisdiction_id', 'mo-legislature').eq('identifier', data.sessionIdentifier).single();
  for (const l of data.legislators) {
    await insertIfAbsent(client, 'legislators',
      [{ full_name: l.full_name, openstates_id: l.openstates_id, party: l.party, run_id: runId }], 'openstates_id');
    const { data: legRow } = await client.from('legislators').select('id').eq('openstates_id', l.openstates_id).single();
    await insertIfAbsent(client, 'terms',
      (l.roles ?? []).map((r) => ({
        legislator_id: legRow.id, jurisdiction_id: 'mo-legislature', chamber: r.chamber,
        district: r.district, party: l.party, start_date: r.start_date, end_date: r.end_date, run_id: runId,
      })),
      'legislator_id,jurisdiction_id,chamber,district,start_date');
  }
  await insertIfAbsent(client, 'bills',
    data.bills.map((b) => ({ session_id: sessionRow.id, identifier: b.identifier, title: b.title, status: b.status, canonical_url: b.canonical_url, run_id: runId })),
    'session_id,identifier');
  const { data: billRows } = await client.from('bills').select('id,identifier').eq('session_id', sessionRow.id);
  const byIdentifier = new Map(billRows.map((r) => [r.identifier, r.id]));
  const { data: legRows } = await client.from('legislators').select('id,openstates_id').not('openstates_id', 'is', null);
  const byOsId = new Map(legRows.map((r) => [r.openstates_id, r.id]));
  for (const { vote, casts, bill_identifier } of data.votes) {
    await insertIfAbsent(client, 'votes', [{
      bill_id: byIdentifier.get(bill_identifier) ?? null,
      jurisdiction_id: 'mo-legislature', chamber: vote.chamber, vote_date: vote.vote_date,
      question: vote.question, result: vote.result, source_url: vote.source_url,
      source_key: vote.source_key, run_id: runId,
    }], 'source_key');
    const { data: voteRow } = await client.from('votes').select('id').eq('source_key', vote.source_key).single();
    const resolvable = casts.filter((c) => c.openstates_id);
    const unknown = resolvable.filter((c) => !byOsId.has(c.openstates_id));
    await insertIfAbsent(client, 'legislators',
      unknown.map((c) => ({ full_name: c.voter_name, openstates_id: c.openstates_id, run_id: runId })), 'openstates_id');
    if (unknown.length > 0) {
      const { data: refreshed } = await client.from('legislators').select('id,openstates_id').not('openstates_id', 'is', null);
      for (const r of refreshed) byOsId.set(r.openstates_id, r.id);
    }
    await insertIfAbsent(client, 'vote_casts',
      resolvable.map((c) => ({ vote_id: voteRow.id, legislator_id: byOsId.get(c.openstates_id), position: c.position, run_id: runId })),
      'vote_id,legislator_id');
    const dropped = casts.length - resolvable.length;
    if (dropped > 0) console.error(`note: ${dropped} cast(s) on ${vote.source_key} had no voter id (name-only); not written`);
  }
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const collect = args.source === 'us-congress' ? collectUsCongress : collectMoLegislature;
  const data = await collect(args);
  const counts = {
    legislators: data.legislators.length,
    bills: data.bills.length,
    votes: data.votes.length,
    casts: data.votes.reduce((n, v) => n + v.casts.length, 0),
    failures: data.failures.length,
  };
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'dry-run', source: args.source, counts, sample: { bill: data.bills[0] ?? null, vote: data.votes[0]?.vote ?? null }, failures: data.failures }, null, 2));
  } else {
    const runId = await openRun(client, args.source);
    try {
      if (args.source === 'us-congress') await persistUsCongress(client, runId, data);
      else await persistMoLegislature(client, runId, data);
      const status = data.failures.length === 0 ? 'succeeded' : 'partial';
      await closeRun(client, runId, status, { counts, failures: data.failures });
      console.log(JSON.stringify({ mode: 'live', run_id: runId, status, counts, failures: data.failures }, null, 2));
    } catch (err) {
      await closeRun(client, runId, 'failed', { counts, error: String(err) });
      throw err;
    }
  }
  if (data.failures.length > 0) process.exitCode = 2;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
```

- [ ] **Step 4: Run unit tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Dry-run both sources against live APIs** (no DB needed; keys required)

Run: `npm run ingest -- --source us-congress --rolls <fixture_roll_number from slice.config.json> --year 2025`
Expected: dry-run JSON with `casts` > 300 and Onder derivable; `failures: []`.

Run: `npm run ingest -- --source mo-legislature --session 2022 --pages 1`
Expected: dry-run JSON with bills > 0; note honestly in output review whether individual casts appeared (see Task 7 Step 3 risk).

- [ ] **Step 6: Commit**

```bash
git add src/cli/ingest.js tests/cli.test.js
git commit -m "feat: ingest CLI - both sources, dry-run mode, partial/failed run statuses"
```

---

### Task 10: Live ingest + end-to-end verification + docs

**Files:**
- Modify: `CHATLOG.md`, `TODO.md`, `PLAYBOOK_DELTA.md` (only if something cost real time)

**Interfaces:**
- Consumes: applied migration + `.env` DB credentials (Task 4 gate — confirm with Lance before starting).

- [ ] **Step 1: Live ingest, small federal batch**

Run: `npm run ingest -- --source us-congress --rolls 120-124 --year 2025`
Expected: `mode: "live"`, `status: "succeeded"` (or `partial` with listed failures — report them, don't hide them).

- [ ] **Step 2: Live ingest, one MO page**

Run: `npm run ingest -- --source mo-legislature --session 2022 --pages 1`
Expected: same standards.

- [ ] **Step 3: Verify Onder end-to-end with SQL** (Lance runs in Supabase SQL editor, or via a `psql` connection if configured)

```sql
-- One person, both jurisdictions:
select l.full_name, l.bioguide_id, l.openstates_id from legislators l
where l.bioguide_id is not null and l.openstates_id is not null;
-- (Expect 0 rows for now: federal and MO rows are separate until identity-merge, which is a
--  known later step — see Step 4. What must exist: one row WITH bioguide_id matching
--  slice.config.json, and one row WITH openstates_id matching it.)

select v.source_key, v.question, v.result, vc.position
from vote_casts vc
join votes v on v.id = vc.vote_id
join legislators l on l.id = vc.legislator_id
where l.bioguide_id = '<cfg bioguide_id>' or l.openstates_id = '<cfg openstates_id>'
order by v.vote_date;
```
Expected: his federal casts appear; MO casts appear if OpenStates carried individual votes (record the actual result honestly).

- [ ] **Step 4: Update TODO.md** — add to BUILD QUEUE: "Identity merge: link a person's federal + MO legislator rows (Onder currently = 2 rows)" and, if Task 7 found sparse MO votes, "MO journal-scraping fallback for individual roll calls". Mark slice-1 items done in NOW/queue.

- [ ] **Step 5: Update CHATLOG.md** — append a dated section: what was built, live-run counts, verified vs still-open (identity merge, MO vote coverage findings), any deviation from this plan.

- [ ] **Step 6: Commit and push**

```bash
git add -A
git commit -m "feat: slice 1 complete - Onder ingested from both jurisdictions, verified live"
git push
```

---

## Self-review notes (done at write time)

- **Spec coverage:** this plan implements the spec's schema, ingestion pipeline, and provenance/skip≠empty/additive rules for the Onder slice. Deliberately deferred to Plans 2–3: summarization, review queue, public site, address lookup, static pre-render, freshness footer. `bill_texts`/`summaries`/`districts` tables are created now (schema pre-pays the roadmap) but unwritten until those plans.
- **Known simplification:** Onder's federal and MO records land as two `legislators` rows (different identity keys). Merging is explicitly queued in Task 10 Step 4 rather than hidden.
- **Type consistency check:** position enum (`yea/nay/present/not_voting/absent/other`), `source_key` formats (`us-house-<congress>-<year>-<roll>`, `mo-<vote-id>`), and canonical field names (`identifier`, `canonical_url`, `vote_date`) are identical across Tasks 4, 6, 8, 9.
- **External-API honesty:** fixture-first order (capture in Tasks 5/7 BEFORE parser code in 6/8) exists because payload shapes from memory are unverified; the fixture always wins over the plan's code sketch.
