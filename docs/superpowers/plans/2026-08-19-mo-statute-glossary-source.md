# MO Statute Glossary Source (revisor.mo.gov) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unlock the ~2,164 RSMo-citation glossary terms stuck at `needs_mapping` by adding a revisor.mo.gov source adapter, jurisdiction-aware citation dispatch, and a re-mapping backfill — ending at "mapped and gloss-ready" (Option A: zero gloss runs, zero spend).

**Architecture:** New adapter `src/adapters/mo-statutes.js` mirrors `src/adapters/uscode.js` exactly (pure parse/extract functions carry the test weight; thin fetch wrappers are structurally reviewed). Stored citations are prefix-discriminated (`RSMo 536.010` / `RSMo chapter 536` vs `42 U.S.C. 1396b`) so both dispatch points route on string shape — **no schema migration**. A backfill CLI re-maps existing unmapped rows with deterministic merge semantics.

**Tech Stack:** Node 22+ ESM, node:test, supabase-js via `src/lib/db.js`, existing `src/lib/http.js` fetchWithLimit + `src/lib/rate-limiter.js` createLimiter.

**Spec:** `docs/superpowers/specs/2026-08-19-mo-statute-glossary-source-design.md` — read it first; §4 (binding access constraints) and §5 (response-identity) are non-negotiable.

## Global Constraints

- **revisor.mo.gov access (spec §4):** sequential requests only, ≥5,000 ms apart (their enforced threshold is 1s; we run 5×inside it). Fetches only at gloss time and fixture capture. Receiving the bot page is a typed hard stop, never a retry.
- **No schema migration.** `glossary_terms.citation` is text; `(kind, citation)` unique + `(kind, term) where citation is null` partial index (migration 0007) work unchanged.
- **No gloss runs, no billed calls, no spend anywhere in this plan.**
- Run tests with `node --test` in a **clean shell** — never `source .env` first (PLAYBOOK lesson 30). Gate every commit on the extracted `ℹ fail` count, never exit status (lesson 14).
- Unbounded reads use `selectAll` (src/lib/db.js) — `tests/select-pagination-enforcement.test.js` scans for violations.
- Never hand-type UUIDs or hashes; read them from files/queries and pass verbatim.
- Reuse, never copy: `OversizeExcerptError`, `MAX_EXCERPT_CHARS`, `sha256` come from `src/adapters/uscode.js`.

---

### Task 1: Capture real revisor.mo.gov fixtures (live, polite)

**Files:**
- Create: `tests/fixtures/mo-statutes/section-536.010.html`
- Create: `tests/fixtures/mo-statutes/chapter-536.html`
- Create: `tests/fixtures/mo-statutes/bot-page.html`
- Create: `tests/fixtures/mo-statutes/section-repealed.html`
- Modify: `tests/fixtures/research/SOURCES.md` (append a `#mo-statutes` entry)

**Interfaces:**
- Produces: the four fixture files Tasks 3–4 test against. Later tasks read them with `readFileSync(new URL('./fixtures/mo-statutes/<name>.html', import.meta.url), 'utf8')`.

- [ ] **Step 1: Find one real repealed/transferred section number** (browser or single curl, counts toward budget): open `https://revisor.mo.gov/main/Info.aspx` → the "Repeal & Transfer" publication linked from it lists repealed sections; pick ONE section number from it and write it down. If that page is unreachable within budget, fall back to fetching `https://revisor.mo.gov/main/OneChapter.aspx?chapter=620` and picking an entry annotated as repealed; if none is findable in ≤2 fetches, skip `section-repealed.html`, note the gap honestly in SOURCES.md, and continue — the identity check (Task 3) covers the risk.

- [ ] **Step 2: Write the capture script** to the scratchpad (NOT the repo), with 5s spacing:

```js
// scratchpad/capture-mo-fixtures.mjs — one-time polite fixture capture
import { writeFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = [
  ['section-536.010.html', 'https://revisor.mo.gov/main/OneSection.aspx?section=536.010'],
  ['chapter-536.html', 'https://revisor.mo.gov/main/OneChapter.aspx?chapter=536'],
  ['bot-page.html', 'https://revisor.mo.gov/main/OneSection.aspx?section=999.999'],
  ['section-repealed.html', 'https://revisor.mo.gov/main/OneSection.aspx?section=<FROM STEP 1>'],
];
for (const [name, url] of targets) {
  const res = await fetch(url, { redirect: 'follow' });
  const html = await res.text();
  writeFileSync(new URL(`file:///F:/VisibleGov/tests/fixtures/mo-statutes/${name}`), html);
  console.log(name, res.status, html.length);
  await sleep(5000);
}
```

- [ ] **Step 3: Run it and verify each capture by inspection**
  - `section-536.010.html` must contain `536.010` and the phrase `For the purpose of this chapter` (verified live 2026-08-19).
  - `chapter-536.html` must contain `Administrative Procedure and Review` and `536.010`.
  - `bot-page.html` must contain `Are you double clicking links?` (the bot page's distinctive fixed text, captured verbatim 2026-08-19).
  - `section-repealed.html` must contain its own section number and repeal/transfer language.

- [ ] **Step 4: Append a `#mo-statutes` entry to `tests/fixtures/research/SOURCES.md`**: capture date, the four URLs, and the bot-policy quote verbatim: "Recent accesses are tracked over a thirty second interval. If the time between accesses is shorter than one second multiple times in that thirty second interval you might see this page." / "The system tracks cumulative accesses by IP address, as well as recent accesses." Contact: WebMaster@LR.mo.gov.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/mo-statutes tests/fixtures/research/SOURCES.md
git commit -m "test(fixtures): capture real revisor.mo.gov pages (section, chapter, bot page, repealed)"
```

---

### Task 2: RSMo citation parser

**Files:**
- Create: `src/adapters/mo-statutes.js` (parser portion)
- Test: `tests/mo-statutes.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseMoCitation(raw) -> {kind:'section', section:'536.010'} | {kind:'chapter', chapter:'536'} | null`; `normalizeMoCitation(parsed) -> 'RSMo 536.010' | 'RSMo chapter 536'`; `isMoCitation(citation) -> boolean` (true iff the string starts with `RSMo `). Tasks 5–7 import all three.

- [ ] **Step 1: Write the failing tests** (`tests/mo-statutes.test.js`):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoCitation, normalizeMoCitation, isMoCitation } from '../src/adapters/mo-statutes.js';

test('parseMoCitation accepts every v1 section shape', () => {
  for (const raw of [
    'section 536.010', 'Section 478.007', '§ 536.010', '302.309',
    'sections 302.309, RSMo', 'section 302.015, RSMo', 'RSMo 536.010',
    'section 620.2020', 'section 33.080',
  ]) {
    const p = parseMoCitation(raw);
    assert.equal(p?.kind, 'section', raw);
  }
  assert.deepEqual(parseMoCitation('section 536.010'), { kind: 'section', section: '536.010' });
});

test('parseMoCitation normalizes a subdivision tail to the parent section', () => {
  assert.deepEqual(parseMoCitation('section 536.010.2'), { kind: 'section', section: '536.010' });
  assert.deepEqual(parseMoCitation('section 536.010(1)'), { kind: 'section', section: '536.010' });
});

test('parseMoCitation accepts chapter shapes including the stored format', () => {
  assert.deepEqual(parseMoCitation('chapter 303'), { kind: 'chapter', chapter: '303' });
  assert.deepEqual(parseMoCitation('chapter 536, RSMo'), { kind: 'chapter', chapter: '536' });
  assert.deepEqual(parseMoCitation('RSMo chapter 536'), { kind: 'chapter', chapter: '536' });
});

test('parseMoCitation reparses its own normalized output (gloss-time round trip)', () => {
  assert.deepEqual(parseMoCitation('RSMo 536.010'), { kind: 'section', section: '536.010' });
});

test('parseMoCitation refuses ranges, lists, specials, and federal markers', () => {
  for (const raw of [
    'sections 302.302 to 302.309', 'sections 302.309 and 302.341, RSMo',
    'RSMo', 'Constitution of Missouri', 'chapter 8 of title 5, United States Code',
    '1 U.S.C. Section 8(b)', '42 CFR Part 418', 'Public Law 118-42',
    'section 1903 of the Social Security Act', '', '   ', null, undefined, 42,
  ]) {
    assert.equal(parseMoCitation(raw), null, String(raw));
  }
});

test('normalizeMoCitation produces the stored prefix-discriminated format', () => {
  assert.equal(normalizeMoCitation({ kind: 'section', section: '536.010' }), 'RSMo 536.010');
  assert.equal(normalizeMoCitation({ kind: 'chapter', chapter: '536' }), 'RSMo chapter 536');
});

test('isMoCitation discriminates stored citation strings', () => {
  assert.equal(isMoCitation('RSMo 536.010'), true);
  assert.equal(isMoCitation('RSMo chapter 536'), true);
  assert.equal(isMoCitation('42 U.S.C. 1396b'), false);
  assert.equal(isMoCitation(null), false);
});
```

- [ ] **Step 2: Run to verify failure**: `node --test tests/mo-statutes.test.js` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement the parser** in `src/adapters/mo-statutes.js`:

```js
// Missouri Revised Statutes (revisor.mo.gov) adapter — spec:
// docs/superpowers/specs/2026-08-19-mo-statute-glossary-source-design.md
// BINDING ACCESS CONSTRAINTS in spec §4: sequential, >=5s spacing, gloss-time fetches only,
// bot page = typed hard stop. Read the spec before changing any fetch behavior.
import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';
import { OversizeExcerptError, MAX_EXCERPT_CHARS, sha256 } from './uscode.js';

export { sha256 };
export const SOURCE = 'mo-statutes';

// Their bot page (captured 2026-08-19) states the enforced threshold: accesses tracked over 30s
// windows, faster than 1s repeatedly -> blocked, cumulative per-IP tracking. 5s = 5x inside it.
export const moStatutesLimiter = createLimiter({ minIntervalMs: 5000 });

// A federal marker anywhere means this can never be an RSMo cite — refuse outright so the MO
// parser can never claim a federal citation (spec §3).
const FEDERAL_MARKER_RE = /U\.?\s*S\.?\s*C\.?|C\.?F\.?R\.?|public law|united states code|\bstat\.|P\.L\./i;
// Ranges and lists have no single official text (spec §3) — belt over the anchored regexes below.
const MULTI_RE = /\b(?:to|through|and)\b/i;
// RSMo's dotted \d{1,3}\.\d{3,4} section shape is its signature; USC sections are never dotted.
// A trailing subdivision (".2", "(1)") parses but normalizes to the parent section (spec §3).
const MO_SECTION_RE = /^(?:RSMo\.?\s+)?(?:§+\s*)?(?:sections?\s+)?(\d{1,3}\.\d{3,4})(?:\.\d+)?(?:\([\w()]+\))?(?:,?\s*RSMo\.?)?$/i;
const MO_CHAPTER_RE = /^(?:RSMo\.?\s+)?chapter\s+(\d{1,3})(?:,?\s*RSMo\.?)?$/i;

export function parseMoCitation(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const t = raw.trim();
  if (FEDERAL_MARKER_RE.test(t) || MULTI_RE.test(t)) return null;
  const sec = t.match(MO_SECTION_RE);
  if (sec) return { kind: 'section', section: sec[1] };
  const ch = t.match(MO_CHAPTER_RE);
  if (ch) return { kind: 'chapter', chapter: ch[1] };
  return null;
}

export function normalizeMoCitation(parsed) {
  return parsed.kind === 'chapter' ? `RSMo chapter ${parsed.chapter}` : `RSMo ${parsed.section}`;
}

export function isMoCitation(citation) {
  return typeof citation === 'string' && citation.startsWith('RSMo ');
}
```

- [ ] **Step 4: Run to verify pass**: `node --test tests/mo-statutes.test.js` — Expected: PASS, fail 0.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/mo-statutes.js tests/mo-statutes.test.js
git commit -m "feat(mo-statutes): RSMo citation parser with federal-marker and range refusals"
```

---

### Task 3: Section + chapter extraction with response-identity and bot-page detection

**Files:**
- Modify: `src/adapters/mo-statutes.js` (extraction portion)
- Test: `tests/mo-statutes.test.js` (append)

**Interfaces:**
- Consumes: Task 1 fixtures; `OversizeExcerptError`/`MAX_EXCERPT_CHARS` from uscode.js.
- Produces: `extractMoSectionText(html, {section, url}) -> string`; `extractMoChapterText(html, {chapter, url}) -> string`; `MoBotPageError`; `MoPageIdentityError`. Both extractors throw `MoBotPageError` on the bot page, `MoPageIdentityError` when the page does not carry the requested section/chapter's own marker, `OversizeExcerptError` on oversize. Task 4's fetch wrappers call these.

- [ ] **Step 1: Write the failing tests** (append to `tests/mo-statutes.test.js`):

```js
import { readFileSync } from 'node:fs';
import {
  extractMoSectionText, extractMoChapterText, MoBotPageError, MoPageIdentityError,
} from '../src/adapters/mo-statutes.js';
import { OversizeExcerptError } from '../src/adapters/uscode.js';

const fx = (name) => readFileSync(new URL(`./fixtures/mo-statutes/${name}`, import.meta.url), 'utf8');

test('extractMoSectionText extracts the real statute body for 536.010', () => {
  const text = extractMoSectionText(fx('section-536.010.html'), { section: '536.010', url: 'x' });
  assert.ok(text.includes('536.010'));
  assert.ok(text.includes('For the purpose of this chapter'));
  assert.ok(!text.includes('<'), 'no HTML tags survive');
  assert.ok(!/double clicking/i.test(text), 'no bot-page text');
});

test('extractMoSectionText throws MoBotPageError on the bot page — never extracts it as statute text', () => {
  assert.throws(() => extractMoSectionText(fx('bot-page.html'), { section: '999.999', url: 'x' }), MoBotPageError);
});

test('extractMoSectionText throws MoPageIdentityError when the page is not the requested section', () => {
  // A real page for a DIFFERENT section must fail the identity check for 111.111.
  assert.throws(() => extractMoSectionText(fx('section-536.010.html'), { section: '111.111', url: 'x' }), MoPageIdentityError);
});

test('extractMoSectionText throws OversizeExcerptError instead of truncating', () => {
  // Splice an oversize body into the REAL fixture between its real markers so the identity
  // check passes and only the size gate fires.
  const real = fx('section-536.010.html');
  const padded = real.replace('For the purpose of this chapter', 'For the purpose of this chapter ' + 'x'.repeat(100001));
  assert.throws(() => extractMoSectionText(padded, { section: '536.010', url: 'x' }), OversizeExcerptError);
});

test('extractMoSectionText extracts a repealed section honestly (repeal notice IS official text)', () => {
  // Skip cleanly if Task 1 could not capture a repealed fixture (documented in SOURCES.md).
  let html;
  try { html = fx('section-repealed.html'); } catch { return; }
  const section = '<SECTION NUMBER FROM TASK 1 STEP 1>';
  const text = extractMoSectionText(html, { section, url: 'x' });
  assert.ok(text.includes(section));
});

test('extractMoChapterText extracts the chapter title and section list', () => {
  const text = extractMoChapterText(fx('chapter-536.html'), { chapter: '536', url: 'x' });
  assert.ok(text.includes('Administrative Procedure and Review'));
  assert.ok(text.includes('536.010'));
  assert.ok(!text.includes('<'));
});

test('extractMoChapterText identity check: wrong chapter fails typed', () => {
  assert.throws(() => extractMoChapterText(fx('chapter-536.html'), { chapter: '999', url: 'x' }), MoPageIdentityError);
});

test('extractMoChapterText bot page fails typed', () => {
  assert.throws(() => extractMoChapterText(fx('bot-page.html'), { chapter: '536', url: 'x' }), MoBotPageError);
});
```

Replace `<SECTION NUMBER FROM TASK 1 STEP 1>` with the real captured number before running.

- [ ] **Step 2: Run to verify failure**: `node --test tests/mo-statutes.test.js` — Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement extraction.** Open `tests/fixtures/mo-statutes/section-536.010.html` and find the real container around the statute body (inspect the raw HTML — do NOT guess; the page prints `536.010. Definitions. —` inside the content area). Implementation shape (adjust the body-isolation slice to what the fixture actually shows, keeping the ORDER: bot check → identity check → isolate → strip → size gate):

```js
// Verbatim fixed text from their bot-detection page (captured 2026-08-19, Task 1 fixture).
// A nonexistent section 302-redirects HERE with HTTP 200 — same class as uscode.js's
// docnotfound finding. This text must be checked BEFORE anything else is trusted.
const MO_BOT_PAGE_MARKER = 'Are you double clicking links?';

export class MoBotPageError extends Error {
  constructor(message, meta = {}) { super(message); this.name = 'MoBotPageError'; Object.assign(this, meta); }
}
export class MoPageIdentityError extends Error {
  constructor(message, meta = {}) { super(message); this.name = 'MoPageIdentityError'; Object.assign(this, meta); }
}

function stripMoHtml(raw) {
  return raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&sect;/gi, 'section ')
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '—')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function assertNotBotPage(html, meta) {
  if (html.includes(MO_BOT_PAGE_MARKER)) {
    throw new MoBotPageError(
      'revisor.mo.gov returned its bot-detection page — nonexistent citation OR rate limiting. '
      + 'HARD STOP per spec §4: do not retry; if this recurs on valid citations, slow down further.',
      meta,
    );
  }
}

export function extractMoSectionText(html, meta = {}) {
  assertNotBotPage(html, meta);
  // Response-identity (spec §5): the page must print the requested section's own number
  // marker before ANY text is trusted — a wrong or generic page must never become a gloss source.
  const escaped = meta.section.replace(/\./g, '\\.');
  if (!new RegExp(`\\b${escaped}\\.?\\s`).test(html.replace(/<[^>]+>/g, ' '))) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response does not carry section ${meta.section}'s own marker — refusing to extract`,
      meta,
    );
  }
  // Body isolation: derive from the REAL fixture (Task 1) — slice from the section-number
  // heading to the page's own end-of-content boundary, then strip. Keep the effective-date line.
  const text = stripMoHtml(/* the isolated body slice */);
  if (text.length > MAX_EXCERPT_CHARS) {
    throw new OversizeExcerptError(
      `excerpt for RSMo ${meta.section} is ${text.length} chars, exceeds MAX_EXCERPT_CHARS=${MAX_EXCERPT_CHARS}; will not truncate silently`,
      { ...meta, length: text.length },
    );
  }
  return text;
}

export function extractMoChapterText(html, meta = {}) {
  assertNotBotPage(html, meta);
  const stripped = html.replace(/<[^>]+>/g, ' ');
  if (!new RegExp(`\\bChapter\\s+${meta.chapter}\\b`, 'i').test(stripped)
      && !new RegExp(`\\b${meta.chapter}\\.\\d{3}`).test(stripped)) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response does not carry chapter ${meta.chapter}'s own marker — refusing to extract`,
      meta,
    );
  }
  const text = stripMoHtml(/* the isolated title + section-list slice */);
  if (text.length > MAX_EXCERPT_CHARS) {
    throw new OversizeExcerptError(
      `excerpt for RSMo chapter ${meta.chapter} is ${text.length} chars, exceeds MAX_EXCERPT_CHARS=${MAX_EXCERPT_CHARS}; will not truncate silently`,
      { ...meta, length: text.length },
    );
  }
  return text;
}
```

The two `/* isolated ... slice */` bodies are the only fixture-dependent part: read the captured HTML, find the real stable boundaries (uscode.js used OLRC's own `field-start/field-end` comments; find revisor's equivalent container), and slice between them. If no clean inner boundary exists, stripping the whole page and then slicing the TEXT from the section-number heading to the footer boundary is acceptable — but the extracted text must contain the statute body and must not contain navigation/search boilerplate (the tests assert both).

- [ ] **Step 4: Run to verify pass**: `node --test tests/mo-statutes.test.js` — Expected: PASS, fail 0.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/mo-statutes.js tests/mo-statutes.test.js
git commit -m "feat(mo-statutes): fixture-tested extraction with bot-page and response-identity guards"
```

---

### Task 4: Fetch wrappers + gloss-time dispatch in the glosser

**Files:**
- Modify: `src/adapters/mo-statutes.js` (fetch wrappers)
- Modify: `src/lib/glosser.js` (`fetchGlossSource`, line ~302)
- Test: `tests/mo-statutes.test.js` (append one URL-builder test)

**Interfaces:**
- Consumes: Task 2 parser, Task 3 extractors, `fetchWithLimit` from `src/lib/http.js`.
- Produces: `buildMoSectionUrl(section)`, `buildMoChapterUrl(chapter)`, `fetchMoSection(section, limiter?)` / `fetchMoChapter(chapter, limiter?)` each returning `{url, excerptText}`; `fetchGlossSource(citation)` now routes `RSMo `-prefixed citations to them and returns the same `{url, excerptText, hash}` contract the USC path returns.

- [ ] **Step 1: Write the failing URL-builder test** (append to `tests/mo-statutes.test.js`):

```js
import { buildMoSectionUrl, buildMoChapterUrl } from '../src/adapters/mo-statutes.js';

test('MO URL builders produce the verified revisor.mo.gov shapes', () => {
  assert.equal(buildMoSectionUrl('536.010'), 'https://revisor.mo.gov/main/OneSection.aspx?section=536.010');
  assert.equal(buildMoChapterUrl('536'), 'https://revisor.mo.gov/main/OneChapter.aspx?chapter=536');
});
```

- [ ] **Step 2: Run to verify failure**: `node --test tests/mo-statutes.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement wrappers** (thin, structurally reviewed — the codebase convention for `fetch*` wrappers, per uscode.js's own comment):

```js
export function buildMoSectionUrl(section) {
  return `https://revisor.mo.gov/main/OneSection.aspx?section=${section}`;
}
export function buildMoChapterUrl(chapter) {
  return `https://revisor.mo.gov/main/OneChapter.aspx?chapter=${chapter}`;
}
export async function fetchMoSection(section, limiter = moStatutesLimiter) {
  const url = buildMoSectionUrl(section);
  const html = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
  return { url, excerptText: extractMoSectionText(html, { section, url }) };
}
export async function fetchMoChapter(chapter, limiter = moStatutesLimiter) {
  const url = buildMoChapterUrl(chapter);
  const html = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
  return { url, excerptText: extractMoChapterText(html, { chapter, url }) };
}
```

- [ ] **Step 4: Add the dispatch to `fetchGlossSource`** in `src/lib/glosser.js` — insert BEFORE the existing USC parse (keep every existing line of the USC path byte-identical):

```js
import { isMoCitation, parseMoCitation, fetchMoSection, fetchMoChapter } from '../adapters/mo-statutes.js';

export async function fetchGlossSource(citation) {
  if (isMoCitation(citation)) {
    const parsed = parseMoCitation(citation);
    if (!parsed) {
      throw new Error(`citation "${citation}" carries the RSMo prefix but is not a parseable RSMo citation — this term should have needs_mapping=true and never reach the glosser`);
    }
    // Whole-section/whole-chapter only in v1 (spec §3) — no subsection fallback for MO.
    const { url, excerptText } = parsed.kind === 'chapter'
      ? await fetchMoChapter(parsed.chapter)
      : await fetchMoSection(parsed.section);
    return { url, excerptText, hash: sha256(excerptText) };
  }
  // ---- existing USC path, unchanged ----
  ...
}
```

- [ ] **Step 5: Run the full suite in a clean shell**: `node --test` — Expected: fail 0 (extract the `ℹ fail` line; gloss.js's candidates bucket keys purely on `needs_mapping=false && gloss_md=null && status!='rejected'`, so no other gloss code changes are needed — verified 2026-08-19 against `gloss.js:58-114`).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/mo-statutes.js src/lib/glosser.js tests/mo-statutes.test.js
git commit -m "feat(glosser): dispatch RSMo-prefixed citations to the mo-statutes adapter"
```

---

### Task 5: Insert-time dispatch — jurisdiction-aware `upsertKeyFor` + the three call sites

**Files:**
- Modify: `src/lib/glossary-terms.js` (`upsertKeyFor` line 36, `upsertGlossaryTerm` line 89, `persistReferencedTerms` line 128; add `resolveBillJurisdiction`)
- Modify: `src/cli/summarize.js:207` (`persistReferencedTermsGracefully` signature) — its own call at line 249 needs NO change (it already passes the full `bill` object; the wrapper derives `bill.id`)
- Modify: `src/cli/summary-queue.js:737-739` (pass `billId` — already in scope from line 727)
- Modify: `src/cli/extract-terms.js:173` (pass `billId: summary.bill_id` — already selected at line 131)
- Test: `tests/glossary-terms.test.js` (existing file — append; if exact-shape `deepEqual` assertions on `upsertKeyFor`'s return exist, update them for the additive `citation` field and say so in the commit message)

**Interfaces:**
- Consumes: `parseMoCitation`/`normalizeMoCitation` from Task 2.
- Produces: `upsertKeyFor(rawTerm, jurisdictionId = null) -> {by:'citation', needs_mapping:false, citation:<normalized>} | {by:'term', needs_mapping:true}` (the `citation` field is NEW and carries the normalized string for BOTH sources); `upsertGlossaryTerm(client, runId, rawTerm, jurisdictionId = null)`; `persistReferencedTerms(client, runId, {summaryId, referencedTerms, billId = null})`; `resolveBillJurisdiction(client, billId) -> string|null`. Task 7's backfill uses the same parser but NOT these functions (it re-maps existing rows; these mint new ones).

- [ ] **Step 1: Write the failing tests** (append to `tests/glossary-terms.test.js`, matching that file's existing fake-client conventions):

```js
test('upsertKeyFor maps an RSMo citation ONLY in mo-legislature context', () => {
  const rawTerm = { term: 'section 536.010', kind: 'statute', citation_raw: 'section 536.010' };
  assert.deepEqual(upsertKeyFor(rawTerm, 'mo-legislature'),
    { by: 'citation', needs_mapping: false, citation: 'RSMo 536.010' });
  // No context (today's callers) and federal context both stay unmapped — never guess.
  assert.deepEqual(upsertKeyFor(rawTerm), { by: 'term', needs_mapping: true });
  assert.deepEqual(upsertKeyFor(rawTerm, 'us-congress'), { by: 'term', needs_mapping: true });
});

test('upsertKeyFor: USC parse wins regardless of jurisdiction, and carries its citation', () => {
  const usc = { term: 'x', kind: 'statute', citation_raw: '42 U.S.C. 1396b' };
  assert.deepEqual(upsertKeyFor(usc, 'mo-legislature'),
    { by: 'citation', needs_mapping: false, citation: '42 U.S.C. 1396b' });
});

test('upsertKeyFor: a chapter maps in MO context', () => {
  const ch = { term: 'chapter 536', kind: 'statute', citation_raw: 'chapter 536' };
  assert.deepEqual(upsertKeyFor(ch, 'mo-legislature'),
    { by: 'citation', needs_mapping: false, citation: 'RSMo chapter 536' });
});

test('resolveBillJurisdiction walks bills -> sessions and is null-safe', async () => {
  // Use this file's existing fake-client helper; seed bills {id:'b1', session_id:'s1'} and
  // sessions {id:'s1', jurisdiction_id:'mo-legislature'}.
  assert.equal(await resolveBillJurisdiction(fake, 'b1'), 'mo-legislature');
  assert.equal(await resolveBillJurisdiction(fake, 'missing'), null);
  assert.equal(await resolveBillJurisdiction(fake, null), null);
});

test('persistReferencedTerms threads billId jurisdiction into term mapping', async () => {
  // Seed the fake as above; persist a referenced term whose citation_raw is 'section 536.010'
  // with billId 'b1'; assert the glossary_terms row was written with citation 'RSMo 536.010'
  // and needs_mapping false. Then persist the same shape with billId null; assert it lands
  // needs_mapping true with citation null.
});
```

- [ ] **Step 2: Run to verify failure**: `node --test tests/glossary-terms.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement in `src/lib/glossary-terms.js`:**

```js
import { parseMoCitation, normalizeMoCitation } from '../adapters/mo-statutes.js';

export function upsertKeyFor(term, jurisdictionId = null) {
  const parsed = parseCitation(term.citation_raw);
  if (parsed) return { by: 'citation', needs_mapping: false, citation: normalizeCitation(term.citation_raw) };
  if (jurisdictionId === 'mo-legislature') {
    const mo = parseMoCitation(term.citation_raw);
    if (mo) return { by: 'citation', needs_mapping: false, citation: normalizeMoCitation(mo) };
  }
  return { by: 'term', needs_mapping: true };
}

// resolveBillJurisdiction: bills carries NO jurisdiction column — it is two hops away
// (bills.session_id -> sessions.jurisdiction_id; audit finding, 2026-08-19). Null-safe on
// missing rows (-> USC-only mapping, today's exact behavior); real DB errors propagate typed —
// summarize.js's graceful wrapper catches them, extract-terms.js prefers the loud crash.
export async function resolveBillJurisdiction(client, billId) {
  if (!billId) return null;
  const { data: bill, error: billErr } = await client.from('bills').select('session_id').eq('id', billId).maybeSingle();
  if (billErr) throw new Error(`bills lookup failed for ${billId}: ${billErr.message}`);
  if (!bill?.session_id) return null;
  const { data: session, error: sessErr } = await client.from('sessions').select('jurisdiction_id').eq('id', bill.session_id).maybeSingle();
  if (sessErr) throw new Error(`sessions lookup failed for ${bill.session_id}: ${sessErr.message}`);
  return session?.jurisdiction_id ?? null;
}
```

In `upsertGlossaryTerm(client, runId, rawTerm, jurisdictionId = null)`: pass `jurisdictionId` to `upsertKeyFor` and replace the `normalizeCitation(rawTerm.citation_raw)` line with `const citation = key.citation;` (the key now carries it for both sources).

In `persistReferencedTerms(client, runId, { summaryId, referencedTerms, billId = null })`: resolve once before the loop —

```js
const jurisdictionId = await resolveBillJurisdiction(client, billId);
```

— and pass `jurisdictionId` as the 4th argument to `upsertGlossaryTerm`.

- [ ] **Step 4: Update the three call sites:**
  - `src/cli/summarize.js:207`: `persistReferencedTermsGracefully(client, runId, { bill, summaryId, referencedTerms })` → derive `const billId = bill?.id ?? null;` inside and pass `{ summaryId, referencedTerms, billId }` to `persistReferencedTerms`. First READ `createDraftSummary` (same file, ~line 226) to confirm `bill.id` is populated there (it inserts `bill_id`); it is — but confirm, don't assume.
  - `src/cli/summary-queue.js:737-739`: `bill: { identifier }, summaryId, referencedTerms` → add `billId` (in scope from line 727): `bill: { identifier, id: billId }, summaryId, referencedTerms`.
  - `src/cli/extract-terms.js:173`: add `billId: summary.bill_id`.

- [ ] **Step 5: Run the FULL suite in a clean shell**: `node --test` — Expected: fail 0. If any pre-existing exact-`deepEqual` test on `upsertKeyFor`'s return shape fails on the additive `citation` field, update that assertion (additive field, not a regression) and name it in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/lib/glossary-terms.js src/cli/summarize.js src/cli/summary-queue.js src/cli/extract-terms.js tests/glossary-terms.test.js
git commit -m "feat(glossary): jurisdiction-aware RSMo citation mapping at insert time (all three call sites)"
```

---

### Task 6: Backfill planning core (pure)

**Files:**
- Create: `src/cli/backfill-mo-glossary-citations.js` (pure core only this task)
- Test: `tests/backfill-mo-glossary-citations.test.js`

**Interfaces:**
- Consumes: `parseMoCitation`/`normalizeMoCitation` from Task 2.
- Produces: `planMoCitationBackfill({ terms, linksByTermId, jurisdictionBySummaryId }) -> { updates, merges, skips }` where:
  - `terms`: array of `{id, term, kind, citation, needs_mapping, gloss_md, created_at, hasVerifications, hasNotes}` (ALL glossary rows, mapped and unmapped — mapped rows participate as collision survivors);
  - `linksByTermId`: `Map<termId, string[] of summaryIds>`;
  - `jurisdictionBySummaryId`: `Map<summaryId, jurisdictionId>`;
  - `updates`: `[{id, term, citation}]` — rows to update in place;
  - `merges`: `[{survivorId, loserId, citation, linkMoves: [summaryIds]}]`;
  - `skips`: `{parseFailed, guardBlocked, zeroLinks, stubViolations: [{id, term, reason}]}` (counts except stubViolations).
  Task 7's CLI is a thin fetch-plan-execute wrapper around this.

- [ ] **Step 1: Write the failing tests:**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMoCitationBackfill } from '../src/cli/backfill-mo-glossary-citations.js';

const T = (id, term, extra = {}) => ({
  id, term, kind: 'statute', citation: null, needs_mapping: true, gloss_md: null,
  created_at: '2026-08-01T00:00:00Z', hasVerifications: false, hasNotes: false, ...extra,
});
const MO = 'mo-legislature'; const FED = 'us-congress';

test('update in place: a clean MO-referenced section term maps', () => {
  const plan = planMoCitationBackfill({
    terms: [T('t1', 'section 536.010')],
    linksByTermId: new Map([['t1', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.deepEqual(plan.updates, [{ id: 't1', term: 'section 536.010', citation: 'RSMo 536.010' }]);
  assert.deepEqual(plan.merges, []);
});

test('jurisdiction guard: mixed or federal references never map; zero links never map', () => {
  const plan = planMoCitationBackfill({
    terms: [T('t1', 'chapter 303'), T('t2', 'section 33.080'), T('t3', '302.309')],
    linksByTermId: new Map([['t1', ['s1', 's2']], ['t2', ['s2']]]),
    jurisdictionBySummaryId: new Map([['s1', MO], ['s2', FED]]),
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.skips.guardBlocked, 2);
  assert.equal(plan.skips.zeroLinks, 1);
});

test('intra-batch collision: most-linked row survives; tie -> earliest created_at -> smallest id', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('t1', 'section 536.010'),
      T('t2', '536.010, RSMo', { created_at: '2026-07-01T00:00:00Z' }),
    ],
    linksByTermId: new Map([['t1', ['s1', 's2']], ['t2', ['s3']]]),
    jurisdictionBySummaryId: new Map([['s1', MO], ['s2', MO], ['s3', MO]]),
  });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, 't1'); // most links wins despite t2 being older
  assert.deepEqual(plan.merges, [{ survivorId: 't1', loserId: 't2', citation: 'RSMo 536.010', linkMoves: ['s3'] }]);
});

test('collision with an existing mapped row: the mapped row always survives', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('m1', 'ignored', { citation: 'RSMo 536.010', needs_mapping: false }),
      T('t1', 'section 536.010'),
    ],
    linksByTermId: new Map([['t1', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.equal(plan.updates.length, 0);
  assert.deepEqual(plan.merges, [{ survivorId: 'm1', loserId: 't1', citation: 'RSMo 536.010', linkMoves: ['s1'] }]);
});

test('stub assertion: a merge loser with gloss content/verifications/notes is skipped, never merged', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('t1', 'section 536.010'),
      T('t2', '536.010', { hasVerifications: true }),
    ],
    linksByTermId: new Map([['t1', ['s1', 's2']], ['t2', ['s3']]]),
    jurisdictionBySummaryId: new Map([['s1', MO], ['s2', MO], ['s3', MO]]),
  });
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.skips.stubViolations.length, 1);
  assert.equal(plan.skips.stubViolations[0].id, 't2');
  assert.equal(plan.updates.length, 1); // the survivor still updates
});

test('kinds are separate namespaces: same citation under different kinds never merges', () => {
  const plan = planMoCitationBackfill({
    terms: [T('t1', 'section 536.010'), T('t2', 'section 536.010', { kind: 'program' })],
    linksByTermId: new Map([['t1', ['s1']], ['t2', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.equal(plan.updates.length, 2);
  assert.equal(plan.merges.length, 0);
});

test('already-mapped rows and unparseable terms are never updates', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('m1', 'x', { citation: '42 U.S.C. 1396b', needs_mapping: false }),
      T('t1', 'sections 302.302 to 302.309'),
      T('t2', 'RSMo'),
    ],
    linksByTermId: new Map([['t1', ['s1']], ['t2', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.skips.parseFailed, 2);
});
```

- [ ] **Step 2: Run to verify failure**: `node --test tests/backfill-mo-glossary-citations.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement `planMoCitationBackfill`:**

```js
import { parseMoCitation, normalizeMoCitation } from '../adapters/mo-statutes.js';

const isStub = (t) => t.gloss_md == null && !t.hasVerifications && !t.hasNotes;

export function planMoCitationBackfill({ terms, linksByTermId, jurisdictionBySummaryId }) {
  const skips = { parseFailed: 0, guardBlocked: 0, zeroLinks: 0, stubViolations: [] };
  // Group candidates by (kind, normalized citation); pre-seed groups with existing mapped rows
  // so a collision with a mapped row always keeps the mapped row as survivor.
  const groups = new Map(); // key -> {mapped: row|null, candidates: [{row, links}]}
  const keyOf = (kind, citation) => `${kind}|${citation}`;
  for (const t of terms) {
    if (!t.needs_mapping && t.citation) {
      const key = keyOf(t.kind, t.citation);
      if (!groups.has(key)) groups.set(key, { mapped: t, candidates: [] });
      else groups.get(key).mapped = t;
    }
  }
  for (const t of terms) {
    if (!t.needs_mapping) continue;
    const parsed = parseMoCitation(t.term);
    if (!parsed) { skips.parseFailed += 1; continue; }
    const links = linksByTermId.get(t.id) ?? [];
    if (links.length === 0) { skips.zeroLinks += 1; continue; }
    const juris = new Set(links.map((sid) => jurisdictionBySummaryId.get(sid)));
    if (juris.size !== 1 || !juris.has('mo-legislature')) { skips.guardBlocked += 1; continue; }
    const key = keyOf(t.kind, normalizeMoCitation(parsed));
    if (!groups.has(key)) groups.set(key, { mapped: null, candidates: [] });
    groups.get(key).candidates.push({ row: t, links });
  }

  const updates = [];
  const merges = [];
  for (const [key, group] of groups) {
    if (group.candidates.length === 0) continue;
    const citation = key.slice(key.indexOf('|') + 1);
    // Deterministic survivor (spec §6): existing mapped row wins outright; otherwise most
    // links, tie -> earliest created_at, tie -> lexicographically smallest id.
    const ranked = [...group.candidates].sort((a, b) =>
      (b.links.length - a.links.length)
      || a.row.created_at.localeCompare(b.row.created_at)
      || a.row.id.localeCompare(b.row.id));
    let survivor;
    if (group.mapped) survivor = group.mapped;
    else {
      survivor = ranked.shift().row;
      updates.push({ id: survivor.id, term: survivor.term, citation });
    }
    for (const { row, links } of ranked) {
      if (!isStub(row)) {
        skips.stubViolations.push({ id: row.id, term: row.term, reason: 'loser row is not a bare stub (has gloss/verifications/notes) — never merged' });
        continue;
      }
      merges.push({ survivorId: survivor.id, loserId: row.id, citation, linkMoves: links });
    }
  }
  return { updates, merges, skips };
}
```

- [ ] **Step 4: Run to verify pass**: `node --test tests/backfill-mo-glossary-citations.test.js` — Expected: PASS, fail 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli/backfill-mo-glossary-citations.js tests/backfill-mo-glossary-citations.test.js
git commit -m "feat(backfill): pure planning core for MO glossary citation re-mapping"
```

---

### Task 7: Backfill CLI — fetch, dry-run, apply

**Files:**
- Modify: `src/cli/backfill-mo-glossary-citations.js` (add fetch + execute + main)
- Test: `tests/backfill-mo-glossary-citations.test.js` (append fake-client execution tests)

**Interfaces:**
- Consumes: Task 6's `planMoCitationBackfill`; `getClient`, `selectAll`, `openRun`, `closeRun`, `insertIfAbsent` from `src/lib/db.js` (follow `backfill-mo-term-dates.js`'s structure for arg handling and run records; `selectAll` usage pattern per `gloss.js:114`).
- Produces: `npm`-runnable CLI: `node --env-file=.env src/cli/backfill-mo-glossary-citations.js` (dry-run default) / `--apply`. Exports `executeBackfillPlan(client, runId, plan)` for tests.

- [ ] **Step 1: Write the failing execution tests** (fake client, this repo's established fake conventions — remember PLAYBOOK lesson 20: the fake must mirror the real backend's `.update().select()` count behavior, so assert on returned `data.length`, never `count`):

```js
test('executeBackfillPlan updates in place with a needs_mapping=true write guard', async () => {
  // Seed fake glossary_terms with t1 (needs_mapping true, citation null).
  // Execute a plan with one update. Assert the row now carries citation 'RSMo 536.010',
  // needs_mapping false — and that the update was issued with .eq('id','t1').is('citation', null)
  // so a concurrently-mapped row can never be clobbered.
});

test('executeBackfillPlan merges: link repointed insert-if-absent, old links deleted, loser deleted with a citation-null guard', async () => {
  // Seed t1 (survivor, already updated), t2 (loser, needs_mapping true), summary_terms link s3->t2.
  // Execute one merge. Assert: summary_terms now has s3->t1 and no s3->t2; glossary_terms has no t2;
  // the loser delete was issued with .is('citation', null) (a mapped row can never be deleted).
});

test('executeBackfillPlan re-verifies the loser stub live before deleting; a non-stub aborts that merge only', async () => {
  // Seed the loser WITH gloss_md set (simulating a concurrent write after planning).
  // Assert the merge is skipped, recorded in the result's skipped list, and the loser row survives.
});

test('idempotency: executing the same plan twice writes nothing the second time', async () => {
  // Run executeBackfillPlan twice on the same fake; assert second-run update/merge counts are 0
  // (updates find no citation-null row; merges find no loser row).
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement fetch + execute + main:**

```js
import { getClient, selectAll, openRun, closeRun, insertIfAbsent } from '../lib/db.js';

export async function fetchBackfillInputs(client) {
  // All unbounded reads via selectAll (pagination-enforcement test scans this file).
  const terms = await selectAll(client, 'glossary_terms', 'id,term,kind,citation,needs_mapping,gloss_md,created_at');
  const links = await selectAll(client, 'summary_terms', 'summary_id,term_id');
  const summaries = await selectAll(client, 'summaries', 'id,bill_id');
  const bills = await selectAll(client, 'bills', 'id,session_id');
  const sessions = await selectAll(client, 'sessions', 'id,jurisdiction_id');
  const verifs = await selectAll(client, 'glossary_verifications', 'term_id');
  const notes = await selectAll(client, 'glossary_notes', 'term_id');

  const verifSet = new Set(verifs.map((v) => v.term_id));
  const noteSet = new Set(notes.map((n) => n.term_id));
  const decorated = terms.map((t) => ({ ...t, hasVerifications: verifSet.has(t.id), hasNotes: noteSet.has(t.id) }));

  const juriBySession = new Map(sessions.map((s) => [s.id, s.jurisdiction_id]));
  const juriByBill = new Map(bills.map((b) => [b.id, juriBySession.get(b.session_id)]));
  const jurisdictionBySummaryId = new Map(summaries.map((s) => [s.id, juriByBill.get(s.bill_id)]));

  const linksByTermId = new Map();
  for (const l of links) {
    if (!linksByTermId.has(l.term_id)) linksByTermId.set(l.term_id, []);
    linksByTermId.get(l.term_id).push(l.summary_id);
  }
  return { terms: decorated, linksByTermId, jurisdictionBySummaryId };
}

export async function executeBackfillPlan(client, runId, plan) {
  const result = { updated: 0, merged: 0, skipped: [] };
  for (const u of plan.updates) {
    // .is('citation', null) is the concurrent-write guard: a row someone else already mapped
    // is silently skipped, not clobbered. Count via returned rows, never `count` (lesson 20).
    const { data, error } = await client.from('glossary_terms')
      .update({ citation: u.citation, needs_mapping: false })
      .eq('id', u.id).is('citation', null).select('id');
    if (error) throw new Error(`update failed for ${u.id} (${u.citation}): ${error.message}`);
    if ((data ?? []).length === 1) result.updated += 1;
    else result.skipped.push({ id: u.id, reason: 'update matched no citation-null row (already mapped?)' });
  }
  for (const m of plan.merges) {
    // Live stub re-verification before the deletion (spec §6) — planning data may be stale.
    const { data: loser, error: loserErr } = await client.from('glossary_terms')
      .select('id,gloss_md').eq('id', m.loserId).is('citation', null).maybeSingle();
    if (loserErr) throw new Error(`loser lookup failed for ${m.loserId}: ${loserErr.message}`);
    if (!loser) { result.skipped.push({ id: m.loserId, reason: 'loser row gone or already mapped' }); continue; }
    const { data: vRows, error: vErr } = await client.from('glossary_verifications').select('id').eq('term_id', m.loserId);
    if (vErr) throw new Error(`verification check failed for ${m.loserId}: ${vErr.message}`);
    if (loser.gloss_md != null || (vRows ?? []).length > 0) {
      result.skipped.push({ id: m.loserId, reason: 'loser is not a bare stub at execute time — merge aborted' });
      continue;
    }
    for (const summaryId of m.linkMoves) {
      await insertIfAbsent(client, 'summary_terms', [{ summary_id: summaryId, term_id: m.survivorId }], 'summary_id,term_id');
    }
    const { error: linkDelErr } = await client.from('summary_terms').delete().eq('term_id', m.loserId);
    if (linkDelErr) throw new Error(`link delete failed for ${m.loserId}: ${linkDelErr.message}`);
    const { error: delErr } = await client.from('glossary_terms').delete().eq('id', m.loserId).is('citation', null);
    if (delErr) throw new Error(`loser delete failed for ${m.loserId}: ${delErr.message}`);
    result.merged += 1;
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const client = getClient();
  const inputs = await fetchBackfillInputs(client);
  const plan = planMoCitationBackfill(inputs);
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    updates: plan.updates.length,
    merges: plan.merges.length,
    skips: { ...plan.skips, stubViolations: plan.skips.stubViolations.length },
  };
  if (!apply) {
    console.log(JSON.stringify({ ...summary, updateList: plan.updates, mergeList: plan.merges, stubViolations: plan.skips.stubViolations }, null, 2));
    return;
  }
  const runId = await openRun(client, 'backfill-mo-glossary-citations');
  try {
    const result = await executeBackfillPlan(client, runId, plan);
    await closeRun(client, runId, 'succeeded', { ...summary, ...result, skipped: result.skipped });
    console.log(JSON.stringify({ ...summary, ...result }, null, 2));
  } catch (err) {
    await closeRun(client, runId, 'failed', { ...summary, error: err.message });
    throw err;
  }
}
```

Match `main()` invocation/guard conventions to `backfill-mo-term-dates.js` (read it first — same `import.meta.url` entry check, same error exit shape). Order of operations is updates THEN merges: a crash between them re-plans cleanly on the next run (updated survivors leave the `needs_mapping=true` scan; stranded losers re-plan as collisions with the now-mapped survivor).

- [ ] **Step 4: Run to verify pass**, then the FULL suite in a clean shell: `node --test` — Expected: fail 0. The pagination-enforcement test must show zero new violations.

- [ ] **Step 5: Commit**

```bash
git add src/cli/backfill-mo-glossary-citations.js tests/backfill-mo-glossary-citations.test.js
git commit -m "feat(backfill): MO glossary citation re-mapping CLI (dry-run default, guarded apply)"
```

---

### Task 8: Attribution line, full-suite gate, live dry-run, handoff report

**Files:**
- Modify: `site/trust.html` (the `#attribution` list, ~line 119)
- Modify: `TODO.md`, `CHATLOG.md` (records)

**Interfaces:**
- Consumes: everything above.
- Produces: the Option-A deliverable — a live dry-run report with the real mapped count and a gloss-run cost estimate, handed to Lance. **The `--apply` run is NOT part of this plan's execution — Lance reviews the dry-run first (spec §8).**

- [ ] **Step 1: Add the attribution line.** In `site/trust.html`'s `ul.attribution-list`, add one static `<li>` matching the existing items' markup style: glossary "Background" excerpts quote the official statute text of the United States Code (Office of the Law Revision Counsel, uscode.house.gov) and the Revised Statutes of Missouri (Missouri Revisor of Statutes, revisor.mo.gov), each linked. The audit (2026-08-19) found NEITHER source was previously listed — this line covers both.

- [ ] **Step 2: Full suite in a clean shell**: `node --test` — Expected: fail 0 (extract the `ℹ fail` line).

- [ ] **Step 3: Run the live dry-run**: `node --env-file=.env src/cli/backfill-mo-glossary-citations.js` (NO `--apply`). Expected shape (2026-08-19 audit snapshot — numbers WILL have drifted upward): ~1,725 updates, ~439 merges, ~0 guard-blocked, ~0 stub violations. If guard-blocked or stub violations are unexpectedly large (>50), STOP and investigate before reporting — that shape contradicts the audit.

- [ ] **Step 4: Write the handoff report** (chat + CHATLOG entry): exact update/merge/skip counts from the dry-run; the distinct section/chapter fetch counts; a gloss-run cost estimate derived from the real historical rate (the 2026-07-28 glossary batches: ~$21 for ~120 terms authored+verified ≈ $0.17–0.18/term on opus+sonnet → state both the full-drain estimate at that rate AND that a Haiku/Sonnet-config estimate would need its own probe); the reminder that the scheduler's ledger carve-out is summaries-only, so any gloss run needs Lance's explicit per-run approval. Update `TODO.md` RESUME HERE with the new state (adapter built, backfill dry-run ready, apply awaiting Lance).

- [ ] **Step 5: Commit and push**

```bash
git add site/trust.html TODO.md CHATLOG.md
git commit -m "feat(trust): attribute both statute-text glossary sources; MO glossary backfill ready for review"
git push
```

---

## Self-Review (performed at plan-writing time)

- **Spec coverage:** §2 source facts → Task 1 fixtures; §3 scope → Task 2 parser (accepts/refusals); §4 binding constraints → Global Constraints + Task 1 spacing + Task 3 bot hard-stop + 5s limiter in Task 2's module header; §5 architecture → Tasks 2–5; §6 backfill → Tasks 6–7 (update guard, merge order, stub re-verification, idempotency); §7 attribution → Task 8; §8 testing → every task's test steps + live dry-run; §9 non-goals → no task runs gloss.js, no spend, apply excluded from plan scope.
- **Placeholder scan:** Task 3's two `/* isolated ... slice */` bodies are deliberately fixture-dependent (the fixture doesn't exist until Task 1 runs) with explicit derivation instructions and tests that pin the outcome; Task 1's `<FROM STEP 1>` is filled by its own Step 1. No other placeholders.
- **Type consistency:** `parseMoCitation` returns `{kind:'section', section}` / `{kind:'chapter', chapter}` everywhere; `normalizeMoCitation(parsed)` takes the parsed object (not raw string) in Tasks 2/5/6 consistently; `upsertKeyFor`'s new `citation` field consumed in Task 5's `upsertGlossaryTerm`; `{url, excerptText, hash}` contract identical across Task 4 and the existing USC path.
