# VisibleGov Slice 2: Facts-Only Summarization + Review Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Federal bills already in the DB get facts-only plain-language summaries (Claude Opus 5, structured JSON, every bullet tied to a bill section), reviewed and published by Lance through a local-only web review page — plus an honest investigation of machine-readable Missouri sources.

**Architecture:** `bill_texts` fetcher (Congress.gov text endpoint, fixture-first TDD) → `summarize` CLI (Anthropic SDK, JSON-schema-constrained output, hash-tied to the exact text version, full provenance) → drafts in `summaries` → local review server (plain node:http, service key never leaves the machine, binds 127.0.0.1) → approve/edit/reject/publish. Editor notes move to a staff-only table (fixes the RLS finding). Fail-loud chamber parsing lands first (final-review Important #4).

**Tech Stack:** existing Node ESM project + `@anthropic-ai/sdk` (the one new dependency, approved via this plan). Claude model: `claude-opus-5` (Lance's choice, 2026-07-27). No new test frameworks.

## Global Constraints

- Node >= 22; ESM; tests via `npm test` (bare `node --test`); node:test + node:assert/strict only.
- New runtime dependency allowed by this plan: `@anthropic-ai/sdk` ONLY. Review server uses built-in node:http — no Express, no frameworks.
- **Facts-only rule (spec, Lance's directive):** every summary bullet traceable to a bill section; stated purpose only from the bill's own language; no adjectives about merit, no party framing, no impact characterization beyond the text; anything reading as opinion/emphasis/emotion gets rejected in review.
- **Provenance:** every summary row carries model, prompt_version, bill_text_hash (sha256 of the exact text summarized), and run_id.
- **Skip ≠ empty / no silent truncation:** oversized bill text throws a typed error (never silently truncated before sending to the model); fetch failures throw; `stop_reason` checked before reading content.
- **Neutrality:** identical treatment regardless of party; no editorial fields.
- **Secrets:** ANTHROPIC_API_KEY and SUPABASE_SERVICE_ROLE_KEY live in `.env` only; the review server binds 127.0.0.1 only; keys never appear in committed files, client-side code, or error messages (redactUrl discipline continues).
- Draft-then-apply: migration 0003 is written + committed; Lance applies it in the Supabase SQL editor (NOT via GitHub integration — manual history means auto-apply would conflict).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- **Lance-provided before Task 4 live steps:** `ANTHROPIC_API_KEY` in `.env` (from console.anthropic.com → API keys; requires billing enabled). Tasks 1-3 and all fixture/unit work proceed without it.

---

### Task 1: Fail-loud chamber parsing (final-review carryover)

**Files:**
- Modify: `src/adapters/us-congress.js` (parseMemberList chamber default), `src/adapters/mo-legislature.js` (mapChamber fallback chain)
- Test: `tests/us-congress.test.js`, `tests/mo-legislature.test.js` (add cases)

**Interfaces:**
- Produces: both adapters THROW `new Error('unknown chamber: <raw>')` (us-congress: when a member's terms yield no chamber signal; mo: when neither v.organization.classification nor b.from_organization.classification maps) instead of silently guessing 'house'/'senate'. Existing passing behavior on real fixtures unchanged.

- [ ] **Step 1: Add failing tests** — in `tests/us-congress.test.js`:

```js
test('parseMemberList throws on a member with no chamber signal', () => {
  const bad = { members: [{ bioguideId: 'X000000', name: 'Test', partyName: 'I', terms: { item: [] } }] };
  assert.throws(() => parseMemberList(bad), /unknown chamber/);
});
```

in `tests/mo-legislature.test.js`:

```js
test('parseBillsWithVotes throws on a vote with no chamber classification', () => {
  const bad = { results: [{ identifier: 'SB 1', title: 't', openstates_url: 'https://x', votes: [{ id: 'v1', motion_text: 'm', start_date: '2022-01-01', result: 'pass', organization: {}, votes: [], counts: [] }], from_organization: {} }] };
  assert.throws(() => parseBillsWithVotes(bad), /unknown chamber/);
});
```

- [ ] **Step 2: Run to confirm both fail** (current code silently defaults). `npm test` → 2 failures.
- [ ] **Step 3: Implement** — us-congress.js: in parseMemberList, when `items.length === 0` or the latest term's chamber matches neither /senate/i nor /house/i, `throw new Error(\`unknown chamber for member ${m.bioguideId}\`)` (message must contain 'unknown chamber'). mo-legislature.js: replace `?? 'senate'` with a check that throws `new Error(\`unknown chamber on vote ${v.id}\`)`. Keep `mapChamber` returning null for unknown input (tested behavior); the THROW lives at the call sites.
- [ ] **Step 4: `npm test`** → all pass (23 existing + 2 new = 25).
- [ ] **Step 5: Commit** `fix: fail loud on unknown chamber instead of guessing (final-review #4)`

---

### Task 2: Migration 0003 — staff-only editor notes + freshness view

**Files:**
- Create: `supabase/migrations/0003_summary_notes_freshness.sql`

**Interfaces:**
- Produces: table `summary_notes` (staff-only, no anon read); `summaries.editor_notes` dropped; view `ingestion_freshness` exposing only per-source last-success timestamps; `ingestion_runs` anon policy removed. Task 6's server writes `summary_notes`; Plan 3's footer reads `ingestion_freshness`.

- [ ] **Step 1: Write the SQL**

```sql
-- 0003: editor notes become staff-only (facts-only directive: nothing editorial is public),
-- and ingestion_runs.detail (operational strings) leaves the anon surface.

create table summary_notes (
  id         uuid primary key default gen_random_uuid(),
  summary_id uuid not null references summaries(id),
  note       text not null,
  action     text not null check (action in ('approved','edited','rejected','published')),
  created_at timestamptz default now()
);
alter table summary_notes enable row level security;
-- deliberately NO anon policy: service role only.

alter table summaries drop column editor_notes;

drop policy anon_read on ingestion_runs;
-- Owner-defined view (bypasses RLS by design — it exposes ONLY safe aggregate columns).
create view ingestion_freshness as
  select source, max(finished_at) as last_success
  from ingestion_runs
  where status in ('succeeded','partial')
  group by source;
grant select on ingestion_freshness to anon;
```

- [ ] **Step 2: Commit** `feat: migration 0003 - staff-only summary notes, freshness view (draft; Lance applies)`
- [ ] **Step 3: GATE — Lance runs 0003 in the Supabase SQL editor** (manual, same as 0001/0002). Tasks 3-5 proceed without it; Tasks 6+ live steps need it.

---

### Task 3: Bill text fetching (fixture-first)

**Files:**
- Create: `tests/fixtures/us-congress/bill-text-versions.json` (real captured payload), `tests/fixtures/us-congress/bill-text.htm` (real captured text), `src/adapters/us-congress-text.js`
- Modify: `slice.config.json` (add fixture_text: {type_slug, number, version_type})
- Test: `tests/us-congress-text.test.js`

**Interfaces:**
- Consumes: CONGRESS_API_KEY (already in .env), fetchWithLimit/congressLimiter, slice.config.json fixture_bill (HR 498).
- Produces (Task 4/5 consume): `parseTextVersions(json) → [{ version_type, date, formats: [{type, url}] }]` (newest first as the API returns them); `pickTextUrl(versions) → { version_type, url }` (first version having a 'Formatted Text' (htm) or 'Formatted XML' format — throws `new Error('no fetchable text format')` if none); `stripHtml(htm) → string` (tag-stripped, entity-decoded, whitespace-normalized plain text); `fetchBillTextVersions(congress, typeSlug, number) → Promise<json>`; `sha256(text) → hex string` (node:crypto).
- Capture commands (implementer runs, ~1s apart):

```powershell
curl.exe -s -H "X-Api-Key: $env:CONGRESS_API_KEY" "https://api.congress.gov/v3/bill/119/hr/498/text" -o tests/fixtures/us-congress/bill-text-versions.json
# open the JSON, take the first version's 'Formatted Text' URL, then:
curl.exe -s "<that url>" -o tests/fixtures/us-congress/bill-text.htm
```

- [ ] **Step 1: Capture both fixtures** with the commands above; verify the JSON has `textVersions` and the .htm contains recognizable bill language; grep both for the API key (must be absent); record version_type in slice.config.json.
- [ ] **Step 2: Write failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTextVersions, pickTextUrl, stripHtml, sha256 } from '../src/adapters/us-congress-text.js';

const versionsJson = JSON.parse(readFileSync('tests/fixtures/us-congress/bill-text-versions.json', 'utf8'));
const htm = readFileSync('tests/fixtures/us-congress/bill-text.htm', 'utf8');

test('parseTextVersions yields versions with formats', () => {
  const versions = parseTextVersions(versionsJson);
  assert.ok(versions.length > 0);
  for (const v of versions) { assert.ok(v.version_type); assert.ok(Array.isArray(v.formats)); }
});

test('pickTextUrl finds a fetchable format', () => {
  const picked = pickTextUrl(parseTextVersions(versionsJson));
  assert.ok(picked.url.startsWith('https://www.congress.gov/'));
});

test('stripHtml produces substantial plain text without tags', () => {
  const text = stripHtml(htm);
  assert.ok(text.length > 500);
  assert.ok(!/<[a-z]+[\s>]/i.test(text), 'no residual tags');
  assert.match(text, /SECTION|Sec\./); // bills reference their own sections
});

test('sha256 is stable and hex', () => {
  assert.equal(sha256('a'), sha256('a'));
  assert.match(sha256('a'), /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 3: Confirm failure, implement** `src/adapters/us-congress-text.js`:

```js
import { createHash } from 'node:crypto';
import { fetchWithLimit } from '../lib/http.js';
import { congressLimiter, SOURCE } from './us-congress.js';

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function parseTextVersions(json) {
  return (json.textVersions ?? []).map((v) => ({
    version_type: v.type ?? 'unknown',
    date: v.date ?? null,
    formats: (v.formats ?? []).map((f) => ({ type: f.type, url: f.url })),
  }));
}

export function pickTextUrl(versions) {
  for (const v of versions) {
    const fmt = v.formats.find((f) => /formatted text/i.test(f.type)) ?? v.formats.find((f) => /formatted xml/i.test(f.type));
    if (fmt) return { version_type: v.version_type, url: fmt.url };
  }
  throw new Error('no fetchable text format in text versions');
}

export function stripHtml(htm) {
  return htm
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export function fetchBillTextVersions(congress, typeSlug, number) {
  const url = `https://api.congress.gov/v3/bill/${congress}/${typeSlug}/${number}/text`;
  return fetchWithLimit(url, { source: SOURCE, limiter: congressLimiter, headers: { 'X-Api-Key': process.env.CONGRESS_API_KEY }, as: 'json' });
}

export function fetchTextBody(url) {
  return fetchWithLimit(url, { source: SOURCE, limiter: congressLimiter, as: 'text' });
}
```

- [ ] **Step 4: `npm test`** → all pass. Fixture wins over this sketch if field paths differ.
- [ ] **Step 5: Commit** `feat: bill text versions parser + fetcher (fixture-backed)`

---

### Task 4: Summarizer core (prompt v1, JSON-constrained, Opus 5)

**Files:**
- Create: `src/lib/summarizer.js`
- Modify: `package.json` (add `@anthropic-ai/sdk`)
- Test: `tests/summarizer.test.js`

**Interfaces:**
- Produces (Task 5/7 consume): `PROMPT_VERSION = 'v1'`; `MODEL = 'claude-opus-5'`; `MAX_TEXT_CHARS = 400000`; `SUMMARY_SCHEMA` (JSON schema); `buildUserMessage(identifier, title, text) → string`; `SYSTEM_PROMPT` (exported const); `renderMarkdown(summaryJson) → string`; `summarizeBill(client, {identifier, title, text}) → Promise<{json, markdown}>` — throws `OversizeTextError` when text.length > MAX_TEXT_CHARS (never truncates silently); throws `SummaryRefusedError` on stop_reason 'refusal'.
- The prompt encodes the spec's facts-only rules VERBATIM as system instructions. Structured output via `output_config.format` json_schema guarantees parseable JSON.

- [ ] **Step 1: `npm install @anthropic-ai/sdk`** (the plan-approved dependency).
- [ ] **Step 2: Write failing tests** (pure parts only — no API calls in unit tests):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_SCHEMA, SYSTEM_PROMPT, buildUserMessage, renderMarkdown, MAX_TEXT_CHARS, PROMPT_VERSION, MODEL } from '../src/lib/summarizer.js';

test('schema requires section citations on every bullet', () => {
  const item = SUMMARY_SCHEMA.properties.what_it_does.items;
  assert.deepEqual(item.required.sort(), ['point', 'section']);
  assert.equal(item.additionalProperties, false);
});

test('system prompt encodes the facts-only rules', () => {
  for (const marker of ['traceable', 'stated purpose', 'no adjectives', 'party']) {
    assert.ok(SYSTEM_PROMPT.toLowerCase().includes(marker), `missing rule marker: ${marker}`);
  }
});

test('buildUserMessage embeds identifier, title, and text', () => {
  const msg = buildUserMessage('HR 498', 'Do No Harm', 'SECTION 1. Text.');
  assert.ok(msg.includes('HR 498') && msg.includes('Do No Harm') && msg.includes('SECTION 1.'));
});

test('renderMarkdown produces neutral markdown with citations', () => {
  const md = renderMarkdown({ what_it_does: [{ point: 'Prohibits X payments', section: 'Sec. 2' }], stated_purpose: 'To prohibit X.', classification: 'amends_existing_law' });
  assert.ok(md.includes('Prohibits X payments'));
  assert.ok(md.includes('(Sec. 2)'));
  assert.ok(md.includes('To prohibit X.'));
});

test('constants pinned', () => {
  assert.equal(MODEL, 'claude-opus-5');
  assert.equal(PROMPT_VERSION, 'v1');
  assert.ok(MAX_TEXT_CHARS >= 100000);
});
```

- [ ] **Step 3: Implement** `src/lib/summarizer.js`:

```js
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-opus-5';
export const PROMPT_VERSION = 'v1';
export const MAX_TEXT_CHARS = 400000; // ~100k tokens; larger bills error loudly, never truncate silently

export class OversizeTextError extends Error {}
export class SummaryRefusedError extends Error {}

export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['what_it_does', 'stated_purpose', 'classification'],
  properties: {
    what_it_does: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['point', 'section'],
        properties: {
          point: { type: 'string', description: 'One plain-language factual statement of what the bill text does' },
          section: { type: 'string', description: "The bill section this point comes from, e.g. 'Sec. 2' or 'Title III'" },
        },
      },
    },
    stated_purpose: { type: 'string', description: "The bill's purpose in plain language, ONLY from the bill's own stated-purpose/findings language; empty string if the bill states none" },
    classification: { type: 'string', enum: ['amends_existing_law', 'new_program', 'appropriation', 'resolution', 'other'] },
  },
};

export const SYSTEM_PROMPT = [
  'You translate United States and state legislative bill text into plain language for a neutral civic-transparency site.',
  'Hard rules — violating any of these makes the output unusable:',
  '- Every point must be traceable to a specific section of the provided bill text; cite that section.',
  '- Restate only what the text does. No adjectives about merit, no characterization of impact beyond the text, no speculation about intent or consequences.',
  '- The stated purpose comes ONLY from the bill\'s own purpose/findings language; if the bill states none, return an empty string. Never infer purpose.',
  '- No party framing of any kind. Never mention parties, politics, or sponsors.',
  '- Plain language: an average adult with no legal training should understand every point. Spell out programs and acts by name on first mention.',
  '- Omit boilerplate (short title sections, severability, effective-date mechanics) unless it is the substance of the bill.',
].join('\n');

export function buildUserMessage(identifier, title, text) {
  return `Bill ${identifier} — ${title}\n\n<bill_text>\n${text}\n</bill_text>\n\nSummarize per your rules.`;
}

export function renderMarkdown(s) {
  const bullets = s.what_it_does.map((b) => `- ${b.point} (${b.section})`).join('\n');
  const purpose = s.stated_purpose ? `\n\n**Stated purpose (from the bill):** ${s.stated_purpose}` : '';
  return `**What it does:**\n${bullets}${purpose}`;
}

export function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null; // caller treats as blocked, not empty
  return new Anthropic();
}

export async function summarizeBill(client, { identifier, title, text }) {
  if (text.length > MAX_TEXT_CHARS) {
    throw new OversizeTextError(`bill text ${text.length} chars exceeds ${MAX_TEXT_CHARS}; will not truncate silently`);
  }
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
    messages: [{ role: 'user', content: buildUserMessage(identifier, title, text) }],
  });
  if (response.stop_reason === 'refusal') {
    throw new SummaryRefusedError(`model declined to summarize ${identifier}`);
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  const json = JSON.parse(textBlock.text);
  return { json, markdown: renderMarkdown(json) };
}
```

- [ ] **Step 4: `npm test`** → all pass.
- [ ] **Step 5: Commit** `feat: facts-only summarizer core (opus-5, JSON-constrained, oversize/refusal typed errors)`

---

### Task 5: summarize CLI (triggers, staleness, provenance)

**Files:**
- Create: `src/cli/summarize.js`
- Modify: `package.json` (script `"summarize": "node --env-file=.env src/cli/summarize.js"`)
- Test: `tests/summarize-cli.test.js`

**Interfaces:**
- Consumes: db.js (getClient, openRun, closeRun, insertIfAbsent), us-congress-text.js, summarizer.js.
- Produces: `npm run summarize -- [--bill "HR 498"] [--dry-run]`. Behavior: (1) select federal bills having ≥1 vote (the trigger rule; join votes on bill_id) — or the one named bill; (2) for each, ensure bill_texts has the latest version (fetch via Task 3 if absent; store content+hash+source_url+retrieved_at+run_id); (3) skip bills whose current text hash already has a non-stale draft/published summary; (4) mark summaries stale where bill_text_hash no longer matches the stored text hash; (5) create draft summaries (status 'draft', body_md, model, prompt_version, bill_text_hash, run_id); (6) per-bill failures (OversizeTextError, SummaryRefusedError, SourceFetchError) recorded in failures[] and run detail — never abort the batch, never silently skip; exit 0/2/1 as in ingest. `--dry-run` prints the work plan (which bills need text, which need summaries, which are stale) without calling the model or writing.
- Pure function exported for tests: `planWork(bills, texts, summaries) → { needText: [], needSummary: [], stale: [] }` where inputs are arrays of {id, identifier}, {bill_id, content_hash}, {bill_id, bill_text_hash, status}.

- [ ] **Step 1: Write failing tests for planWork** (pure logic: a bill with no text row → needText; text but no summary → needSummary; summary whose bill_text_hash ≠ current text hash → stale + needSummary; published summary with matching hash → nothing).

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWork } from '../src/cli/summarize.js';

const bills = [{ id: 'b1', identifier: 'HR 1' }, { id: 'b2', identifier: 'HR 2' }, { id: 'b3', identifier: 'HR 3' }];
const texts = [{ bill_id: 'b2', content_hash: 'h2' }, { bill_id: 'b3', content_hash: 'h3-new' }];
const summaries = [{ bill_id: 'b3', bill_text_hash: 'h3-old', status: 'published' }];

test('planWork routes bills correctly', () => {
  const plan = planWork(bills, texts, summaries);
  assert.deepEqual(plan.needText.map((b) => b.id), ['b1']);
  assert.deepEqual(plan.needSummary.map((b) => b.id), ['b2', 'b3']);
  assert.deepEqual(plan.stale.map((s) => s.bill_id), ['b3']);
});

test('planWork skips bills already summarized at current hash', () => {
  const plan = planWork([bills[2]], [{ bill_id: 'b3', content_hash: 'h3-old' }], summaries);
  assert.equal(plan.needSummary.length, 0);
  assert.equal(plan.stale.length, 0);
});
```

- [ ] **Step 2: Confirm failure, implement.** planWork is pure; main() flow: openRun('summarize') → query federal bills with votes (`bills` joined via `votes.bill_id`, jurisdiction us-congress) → load bill_texts hashes + summaries → planWork → fetch missing texts (Task 3 fns; store) → mark stale (update status='stale' where matched) → for needSummary call summarizeBill and insert draft rows → closeRun with counts+failures. `--dry-run` stops after printing planWork output as JSON. Client null (no ANTHROPIC_API_KEY) → print BLOCKED message naming the missing key and exit 1 (unless --dry-run).
- [ ] **Step 3: `npm test`** → pass. **Step 4: Live smoke:** `npm run summarize -- --dry-run` → prints the real work plan for the DB's federal bills (expect ~5-6 needing text+summary). No writes.
- [ ] **Step 5: Commit** `feat: summarize CLI - trigger query, staleness, provenance, dry-run planning`

---

### Task 6: Local review server

**Files:**
- Create: `src/review/server.js`, `src/review/page.html`
- Modify: `package.json` (script `"review": "node --env-file=.env src/review/server.js"`)
- Test: `tests/review-logic.test.js`

**Interfaces:**
- Consumes: db.js getClient; migration 0003 applied (summary_notes exists, editor_notes gone).
- Produces: `npm run review` → serves http://127.0.0.1:8991 (hard-bound to 127.0.0.1; the service key stays server-side; page JS calls same-origin /api only). Endpoints: `GET /` (page.html); `GET /api/queue` → drafts+stale with bill identifier/title; `GET /api/item/:id` → {summary, bill:{identifier,title,canonical_url}, text: bill_texts.content}; `POST /api/decision` body {summary_id, action: 'approve'|'reject'|'publish'|'edit', body_md?, note?} → status transitions draft→approved→published / draft→rejected; edited body_md updates the row before approval; every decision writes a summary_notes row with action+note; publish sets published_at. Page: two-pane layout — left: raw bill text (scrollable, from bill_texts); right: rendered draft markdown + edit textarea + Approve/Reject/Publish buttons + note field, and above the draft a **vote strip** (Lance's two-fold directive, 2026-07-27): the bill's roll-call result (question, result, yea-nay tally from votes/vote_casts) so the reviewer sees the summary in the same summary+votes frame users will. `GET /api/item/:id` therefore also returns `vote: {question, result, yeas, nays} | null` (counted from vote_casts positions). Plain HTML+vanilla JS, no CDN, no build step.
- Pure function exported for tests: `nextStatus(current, action) → string|Error` encoding the legal transitions: draft→(approve→approved | reject→rejected | edit→draft); approved→(publish→published | reject→rejected); stale→(approve→approved | reject→rejected | edit→draft); anything else throws `new Error('illegal transition')`. Publishing requires status 'approved' — a draft cannot jump straight to published (the review gate is the product).

- [ ] **Step 1: Write failing tests for nextStatus** (cover: draft+approve→approved; approved+publish→published; draft+publish→throws /illegal/; published+approve→throws; stale+edit→draft; rejected+publish→throws).
- [ ] **Step 2: Confirm failure, implement nextStatus + server.** Server: node:http, `server.listen(8991, '127.0.0.1')`; route by url+method; JSON body parsing with a size cap (1MB); all Supabase access via the service-role client server-side; errors → 500 with generic message (no key material, no stack traces to the page). page.html: fetch('/api/queue') → list; select → fetch('/api/item/:id') → panes; buttons POST /api/decision then refresh. Render markdown with a ~20-line minimal renderer (bold/bullets/paragraphs only — the body_md we generate uses nothing else).
- [ ] **Step 3: `npm test`** → pass. **Step 4: Manual smoke** (blocked until 0003 applied + drafts exist — defer to Task 7 E2E if not yet unblocked; note honestly in report which smoke was possible).
- [ ] **Step 5: Commit** `feat: local review server - queue, side-by-side, gated status transitions, staff notes`

---

### Task 7: E2E — summarize real bills, Lance reviews, publish one

**Files:**
- Modify: `CHATLOG.md`, `TODO.md` (checkpoint)

**Interfaces:**
- Consumes: ANTHROPIC_API_KEY in .env (Lance), migration 0003 applied (Lance), Tasks 3-6.

- [ ] **Step 1: Confirm gates** — ANTHROPIC_API_KEY present (shape-check only, never print); `summary_notes` exists via REST probe. If either missing: report BLOCKED naming exactly what Lance must do.
- [ ] **Step 2: `npm run summarize -- --dry-run`** → verify plan matches expectation (~5-6 federal bills).
- [ ] **Step 3: `npm run summarize`** (live) → texts fetched+stored, drafts created. Report verbatim counts + failures. Expected cost ≈ $0.11 × bills.
- [ ] **Step 4: Verify provenance via REST** — every new summary row has model='claude-opus-5', prompt_version='v1', 64-hex bill_text_hash matching its bill's bill_texts.content_hash, non-null run_id; every draft's body_md contains at least one '(Sec.'-style citation. Spot-check one summary's bullets against the stored bill text for traceability (read both; report the check honestly).
- [ ] **Step 5: HAND TO LANCE** — `npm run review`, open http://127.0.0.1:8991, review each draft against the bill text (facts-only bar: reject anything with a whiff of opinion), approve+publish at least one. This step is Lance's by design; the implementer stops and reports READY_FOR_REVIEW rather than approving anything itself.
- [ ] **Step 6 (after Lance's review): Verify** published row (status='published', published_at set, summary_notes trail) via REST; anon-key probe confirms: published summary readable, draft summaries NOT, summary_notes NOT.
- [ ] **Step 7: Update CHATLOG.md + TODO.md** (checkpoint: what shipped, verbatim counts, Lance's review outcomes, honest gaps), commit + push.

---

### Task 8: Golden set mechanism

**Files:**
- Create: `src/cli/golden.js`, `goldens/` (committed JSON snapshots)
- Modify: `package.json` (script `"golden": "node --env-file=.env src/cli/golden.js"`)
- Test: `tests/golden.test.js`

**Interfaces:**
- Consumes: summarizer.js, db.js; at least one Lance-approved summary (Task 7).
- Produces: `npm run golden -- --snapshot` (writes goldens/<identifier>.json for every approved/published summary: {identifier, bill_text_hash, prompt_version, json}); `npm run golden -- --check` (re-runs the CURRENT prompt against each golden's stored bill text from bill_texts, compares structurally, prints per-bill PASS/DRIFT and exits 2 on any DRIFT). Structural comparison (pure, exported): `compareSummaries(golden, fresh) → {classificationChanged, purposeChanged, bulletCountDelta, missingSections: []}` — DRIFT when classification changed, stated_purpose changed beyond whitespace, or >30% of golden section citations no longer appear. Never auto-updates goldens; snapshot is explicit.

- [ ] **Step 1: Failing tests for compareSummaries** (identical → no drift flags; changed classification → flagged; dropped sections beyond threshold → flagged with the missing list).
- [ ] **Step 2: Implement** compareSummaries + CLI (snapshot reads DB; check calls summarizeBill per golden — rate/cost note printed first: N bills × ~$0.11).
- [ ] **Step 3: `npm test`** → pass. **Step 4: Live:** run `--snapshot` against the Task-7 approved summaries; commit the goldens.
- [ ] **Step 5: Commit** `feat: golden-set snapshot + drift check for prompt changes`

---

### Task 9: Missouri machine-readable source investigation (research, no integration)

**Files:**
- Create: `docs/research/2026-07-27-mo-data-sources.md`, `tests/fixtures/research/` (captured sample payloads)

**Interfaces:**
- Consumes: web access; OPENSTATES_API_KEY (for comparison probes); a free LegiScan API key IF obtainable non-interactively — otherwise document the signup step for Lance and capture what's public.
- Produces: a findings doc answering, with captured evidence (saved payloads, not assertions): (1) does LegiScan's API provide MO bill FULL TEXT in machine-readable form (their getBillText returns base64 docs — which mime types for MO: HTML? PDF?); (2) does LegiScan carry MO roll calls WITH individual legislator votes (getRollCall) — this could obsolete the journal scraper; (3) what are LegiScan free-tier limits (30k queries/month claimed) and terms-of-use constraints for our use; (4) do house.mo.gov/senate.mo.gov expose any JSON/XML endpoints themselves; (5) recommendation with a proposed adapter shape. Honest-status rules apply: what was actually verified vs read-on-a-docs-page is labeled.

- [ ] **Step 1: Research + capture** (WebFetch/WebSearch the docs; register free key if possible; capture 1-2 real MO responses if a key is obtained; save everything under tests/fixtures/research/).
- [ ] **Step 2: Write the findings doc** (structure above; every claim labeled VERIFIED-BY-PAYLOAD / DOCUMENTED-UNVERIFIED / UNKNOWN).
- [ ] **Step 3: Update TODO.md** build queue items 9/10e with the findings' implications.
- [ ] **Step 4: Commit** `docs: MO machine-readable source investigation (LegiScan et al)`

---

### Task 10: Adversarial verification pass (trust-model update, Lance 2026-07-27)

**Files:**
- Create: `supabase/migrations/0004_summary_verifications.sql`, `src/lib/verifier.js`, `src/cli/verify.js`
- Modify: `src/review/server.js`, `src/review/page.html`, `package.json` (script `"verify": "node --env-file=.env src/cli/verify.js"`)
- Test: `tests/verifier.test.js`, `tests/review-logic.test.js` (additions)

**Interfaces:**
- Consumes: summarizer.js patterns (client factory, typed errors, JSON-schema output), db.js, review server internals.
- Migration 0004 (draft-then-apply, Lance runs it): `create table summary_verifications (id uuid primary key default gen_random_uuid(), summary_id uuid not null references summaries(id), verdicts jsonb not null, overall text not null check (overall in ('clean','flagged')), model text not null, prompt_version text not null, created_at timestamptz default now()); alter table summary_verifications enable row level security;` — NO anon policy (staff-only).
- `src/lib/verifier.js` produces: `VERIFIER_MODEL = 'claude-sonnet-5'` (deliberately different weights than the opus-5 author — do not "upgrade" it to opus); `VERIFY_PROMPT_VERSION = 'v1'`; `VERIFY_SCHEMA` — {verdicts: [{bullet_index int, section string, supported bool, reason string, evidence_quote string}] (all required, additionalProperties false), overall enum clean|flagged}; `VERIFY_SYSTEM_PROMPT` — adversarial stance, must contain the markers 'refute', 'cited section', 'fully supported', 'quote'; `buildVerifyMessage(identifier, bulletsJson, text)`; `verifyBill(client, {identifier, bullets, text}) → {json}` — reuses the oversize/refusal/truncation typed-error pattern (import OversizeTextError etc. from summarizer.js or re-declare minimally); max_tokens MAX_OUTPUT_TOKENS from summarizer.
- `src/cli/verify.js` produces: `npm run verify -- [--dry-run]` — selects summaries with status in (draft, stale) having NO summary_verifications row yet, loads each bill's current text + parses bullets from the summary's body_md (pure exported `parseBullets(body_md) → [{index, point, section}]` — the renderer's inverse, tested), calls verifyBill per summary, inserts summary_verifications row with provenance; per-summary typed failures recorded, batch continues; exit 0/2/1; --dry-run lists what would verify with zero model calls; missing ANTHROPIC_API_KEY → BLOCKED exit 1.
- Review server additions: `/api/item/:id` response gains `verification: {overall, verdicts, model, created_at} | null` (latest row for that summary); `/api/queue` items gain `verified: 'clean'|'flagged'|'unverified'`. Page: verification strip above the draft — green "verifier found all N bullets supported" / amber per-bullet flags showing reason + evidence_quote (escaped!) / grey "unverified". Pure exported `verificationBadge(verification|null) → {state, label}` tested.
- LIVE verify runs are gated by Lance's standing per-run API approval policy — the implementer does NOT run `npm run verify` live; tests are pure, dry-run against DB is allowed.

- [ ] **Step 1:** failing tests (schema shape incl. required fields + additionalProperties; prompt markers; parseBullets round-trips renderMarkdown output incl. multiple bullets and the no-purpose case; verificationBadge states; server logic additions).
- [ ] **Step 2:** implement migration + verifier + CLI + server/page additions.
- [ ] **Step 3:** `npm test` all pass; `npm run verify -- --dry-run` against live DB (expect 3 unverified drafts listed).
- [ ] **Step 4:** commit `feat: adversarial verification pass - sonnet refutes opus, flags to review page`.
- [ ] **Step 5:** GATE — Lance applies 0004, then approves the live verify run (3 sonnet calls, ~$0.20).

---

## Self-review notes (done at write time)

- **Spec coverage:** implements the spec's summarization pipeline (facts-only rule verbatim in the prompt), review-queue trust model (Lance approves each; publish gated through approved), staleness (hash mismatch → stale), prompt versioning + golden set (§4.3), editor_notes internal-only fix, and the freshness footer's data source (view). Deferred to Plan 3: public site, static pre-render on publish, address lookup. MO summarization deferred pending Task 9 findings (Lance's federal-first call).
- **Placeholder scan:** clean; Task 9 is research and its unknowns are the deliverable, labeled as such.
- **Type consistency:** summaries.status values (draft/approved/rejected/published/stale) — NOTE: 'approved' is NEW vs migration 0001's check constraint (draft/published/rejected/stale). Migration 0003 must ALTER the constraint: add `alter table summaries drop constraint summaries_status_check; alter table summaries add constraint summaries_status_check check (status in ('draft','approved','published','rejected','stale'));` — INCLUDED as a required addition to Task 2's SQL (implementer: append these two lines to 0003 before the drop column statement).
- **Dependency honesty:** one new runtime dep (@anthropic-ai/sdk); review server deliberately framework-free.
