# Directory "Serving now / Past members" Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the directory into a default "Serving now" view and a "Past members" view (toggle + per-view name search + honest tenure fragments), per the approved spec `docs/superpowers/specs/2026-08-06-directory-serving-now-split-design.md`.

**Architecture:** Extend `site/js/directory-page.js`'s existing pure-model → DOM split: `buildDirectoryEntries` gains two derived fields (`servingNow`, `sinceYear`), a new pure `partitionDirectory` splits entries, and a small `wireDirectoryView` controller (toggle buttons + the existing search input) renders the active partition through the existing `renderDirectoryList`/`sectionState` machinery. Markup in `site/index.html`, styles appended to `site/css/site.css`. No new fetches, no new deps.

**Tech Stack:** vanilla ES modules (no build step), `node:test` + `node:assert/strict` for the pure model.

## Global Constraints

- **The word "current" never appears in any UI string.** Labels are exactly `Serving now` and `Past members`; the footnote is exactly: `ⓘ no recorded end date — the honest signal a term is still open`. (spec §2, §5; currency-honesty law)
- **Partition rule:** `servingNow` = any of the group's terms has `end_date == null`; all-ended → past; **zero terms → past**. (spec §2)
- **`sinceYear`** comes only from the group's dated anchor (`mostRecentDatedTerm`) and only when that anchor is itself open (`end_date == null`); anything else → `null`, and a null `sinceYear` renders NO fragment. Never guessed. (spec §2, §5)
- **Badges show full partition counts; search filters rows, never badges.** (spec §2)
- **No new network calls, no new dependencies, no schema changes** — `loadDirectoryData` already fetches `start_date`/`end_date`. (spec §5)
- The existing surname sort (`localeCompare(…, 'en', {sensitivity:'base'})`) and `filterDirectory` behavior are untouched; partition preserves order.
- Tests: `node:test` + `node:assert/strict`, flat `test()` calls in `tests/directory-model.test.js`, pure functions only (no DOM, no network, no Supabase client).
- **NEVER `source .env` (or set SUPABASE_* env vars) in a shell that runs `node --test`.** Run tests in a clean shell; parse the runner's `pass/fail` summary lines, never trust exit status. Whole suite = `node --test` (no path arg); single file = `node --test tests/directory-model.test.js`. Never pass a directory to `node --test`.
- ENVIRONMENT NOTE (this session): the Bash tool has a broken PATH — use the **PowerShell tool** for all commands (node/git work there; PowerShell 5.1: no `&&`, chain with `;`).
- Branch: `directory-serving-now-split` off `main`. Commit per task; do NOT push until integration is decided.

---

### Task 1: Model — `servingNow` + `sinceYear` on `buildDirectoryEntries`

**Files:**
- Modify: `site/js/directory-page.js:88-128` (the entry-building loop)
- Test: `tests/directory-model.test.js` (extend; it already imports `buildDirectoryEntries`, `filterDirectory`)

**Interfaces:**
- Consumes: the existing private `mostRecentDatedTerm(terms)` (same file, line 31).
- Produces: every entry gains `servingNow: boolean` and `sinceYear: number|null`. Task 2's `partitionDirectory` and Task 3's meta rendering rely on exactly these names.

- [ ] **Step 1: Write the failing tests** (append to `tests/directory-model.test.js`)

```js
// ---- servingNow / sinceYear (Serving now / Past members split, 2026-08-06 spec) ----

test('buildDirectoryEntries: an open term (end_date null) -> servingNow true, sinceYear from its dated start', () => {
  const entries = buildDirectoryEntries({
    legislators: [{ id: 'L1', full_name: 'Jane Adams', surname: 'Adams', person_id: null }],
    persons: [],
    terms: [{ legislator_id: 'L1', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '29', start_date: '2023-01-04', end_date: null }],
  });
  assert.equal(entries[0].servingNow, true);
  assert.equal(entries[0].sinceYear, 2023);
});

test('buildDirectoryEntries: every term ended -> servingNow false, sinceYear null (ended anchor never yields a fragment)', () => {
  const entries = buildDirectoryEntries({
    legislators: [{ id: 'L1', full_name: 'Old Timer', surname: 'Timer', person_id: null }],
    persons: [],
    terms: [{ legislator_id: 'L1', jurisdiction_id: 'us-congress', chamber: 'house', district: '3', start_date: '2017-01-03', end_date: '2021-01-03' }],
  });
  assert.equal(entries[0].servingNow, false);
  assert.equal(entries[0].sinceYear, null);
});

test('buildDirectoryEntries: zero terms -> servingNow false (service unprovable is never promoted), sinceYear null', () => {
  const entries = buildDirectoryEntries({
    legislators: [{ id: 'L1', full_name: 'No Terms', surname: 'Terms', person_id: null }],
    persons: [],
    terms: [],
  });
  assert.equal(entries[0].servingNow, false);
  assert.equal(entries[0].sinceYear, null);
});

test('buildDirectoryEntries: the Brown case — open but completely undated term -> servingNow true, sinceYear null', () => {
  const entries = buildDirectoryEntries({
    legislators: [{ id: 'L1', full_name: 'Galen Brown', surname: 'Brown', person_id: null }],
    persons: [],
    terms: [{ legislator_id: 'L1', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '149', start_date: null, end_date: null }],
  });
  assert.equal(entries[0].servingNow, true);
  assert.equal(entries[0].sinceYear, null);
});

test('buildDirectoryEntries: the Onder construction (live-verified 2026-08-06) — merged person, open dated federal term + open undated MO row -> ONE serving entry anchored on the federal seat', () => {
  const entries = buildDirectoryEntries({
    legislators: [
      { id: 'L-fed', full_name: 'Onder, Robert F.', surname: null, person_id: 'P1' },
      { id: 'L-mo', full_name: 'Bob Onder', surname: 'Onder', person_id: 'P1' },
    ],
    persons: [{ id: 'P1', display_name: 'Bob Onder' }],
    terms: [
      { legislator_id: 'L-fed', jurisdiction_id: 'us-congress', chamber: 'house', district: '3', start_date: '2025-01-03', end_date: null },
      { legislator_id: 'L-mo', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: null, end_date: null },
    ],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].servingNow, true);
  assert.equal(entries[0].sinceYear, 2025);
  assert.equal(entries[0].chamber, 'US House'); // anchor is the dated federal term, never the undated MO row
});

test('buildDirectoryEntries: merged person with one ended dated term + a DIFFERENT open undated term -> servingNow true but sinceYear null (fragment only describes the anchor)', () => {
  const entries = buildDirectoryEntries({
    legislators: [{ id: 'L1', full_name: 'Mixed Case', surname: 'Case', person_id: null }],
    persons: [],
    terms: [
      { legislator_id: 'L1', jurisdiction_id: 'us-congress', chamber: 'house', district: '5', start_date: '2015-01-03', end_date: '2019-01-03' },
      { legislator_id: 'L1', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '12', start_date: null, end_date: null },
    ],
  });
  assert.equal(entries[0].servingNow, true);
  assert.equal(entries[0].sinceYear, null); // dated anchor (the federal term) is ENDED
});
```

Note: `chamberLabel('us-congress','house')` renders `US House` — if the existing tests use a different exact label string for federal house, copy THAT exact string into the Onder assertion (read a neighboring test; do not guess).

- [ ] **Step 2: Run to verify failure** — `node --test tests/directory-model.test.js` → new tests FAIL (`servingNow` undefined).

- [ ] **Step 3: Implement** — in `buildDirectoryEntries`, replace the anchor line and extend the pushed entry:

```js
    const datedAnchor = mostRecentDatedTerm(groupTerms);
    const anchorTerm = datedAnchor ?? groupTerms[0] ?? null;
```

and after the `district` computation:

```js
    // Serving now / Past members split (2026-08-06 spec §2): an open term is the data literally
    // saying "not ended" — that, and only that, is the serving signal. Zero terms can't prove
    // service, so they stay out of "Serving now."
    const servingNow = groupTerms.some((t) => t.end_date == null);
    // The tenure fragment only ever describes the anchor term the entry displays, and only when
    // that anchor is itself open and genuinely dated.
    const sinceRaw = datedAnchor && datedAnchor.end_date == null
      ? Number(String(datedAnchor.start_date).slice(0, 4))
      : null;
    const sinceYear = Number.isFinite(sinceRaw) ? sinceRaw : null;
```

and add `servingNow, sinceYear,` to the `entries.push({ … })` object (after `district`).

- [ ] **Step 4: Run to verify pass** — `node --test tests/directory-model.test.js` → all pass.

- [ ] **Step 5: Commit**

```
git add site/js/directory-page.js tests/directory-model.test.js
git commit -m "feat(directory): derive servingNow + sinceYear per entry (split model, part 1)"
```

---

### Task 2: Model — `partitionDirectory`

**Files:**
- Modify: `site/js/directory-page.js` (new export directly after `filterDirectory`)
- Test: `tests/directory-model.test.js`

**Interfaces:**
- Consumes: entries carrying `servingNow` (Task 1).
- Produces: `partitionDirectory(entries) -> { servingNow: Entry[], past: Entry[] }` — order-preserving, malformed-safe. Task 3 consumes exactly this shape.

- [ ] **Step 1: Write the failing tests**

```js
import { buildDirectoryEntries, filterDirectory, partitionDirectory } from '../site/js/directory-page.js'; // extend the existing import

test('partitionDirectory: splits by servingNow, preserving the surname-sorted order within each view', () => {
  const entries = [
    { key: 'a', surname: 'Adams', servingNow: true },
    { key: 'b', surname: 'Baker', servingNow: false },
    { key: 'c', surname: 'Cook', servingNow: true },
  ];
  const { servingNow, past } = partitionDirectory(entries);
  assert.deepEqual(servingNow.map((e) => e.key), ['a', 'c']);
  assert.deepEqual(past.map((e) => e.key), ['b']);
});

test('partitionDirectory: an entry with no servingNow field lands in past (never promoted), and malformed input never throws', () => {
  const { servingNow, past } = partitionDirectory([{ key: 'x' }, null]);
  assert.equal(servingNow.length, 0);
  assert.deepEqual(past.map((e) => e.key), ['x']);
  assert.deepEqual(partitionDirectory(undefined), { servingNow: [], past: [] });
});
```

- [ ] **Step 2: Run to verify failure** — `partitionDirectory` not exported.

- [ ] **Step 3: Implement** (after `filterDirectory` in `site/js/directory-page.js`)

```js
// Splits the already-sorted entry list into the two directory views (2026-08-06 spec §2). Pure,
// order-preserving; an entry that cannot prove service (servingNow falsy/absent) is never
// promoted into "Serving now." Never throws on malformed input.
export function partitionDirectory(entries) {
  const servingNow = [];
  const past = [];
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    if (!entry) continue;
    (entry.servingNow ? servingNow : past).push(entry);
  }
  return { servingNow, past };
}
```

- [ ] **Step 4: Run to verify pass**, then whole suite `node --test` (clean shell) → `fail 0`.

- [ ] **Step 5: Commit**

```
git add site/js/directory-page.js tests/directory-model.test.js
git commit -m "feat(directory): pure partitionDirectory (split model, part 2)"
```

---

### Task 3: DOM — toggle markup, tenure fragment, `wireDirectoryView`, styles

DOM-orchestration task (per this file's convention, DOM helpers are not unit-tested — smoke-tested live in Task 4). Everything below is exact code.

**Files:**
- Modify: `site/index.html:42-47` (the directory section)
- Modify: `site/js/directory-page.js` — `renderDirectoryList` (line 174), replace `wireDirectoryFilter` (line 447) with `wireDirectoryView`, rewire `loadAndRenderDirectory` (line 464) + `bootstrapDirectoryPage` (line 502)
- Modify: `site/css/site.css` (append)

**Interfaces:**
- Consumes: `partitionDirectory` (Task 2), entry `servingNow`/`sinceYear` (Task 1), existing `renderDirectoryList`, `sectionState`, `filterDirectory`.
- Produces: the live two-view directory. No exports change except `wireDirectoryFilter` (private) being replaced by the private `wireDirectoryView`.

- [ ] **Step 1: `site/index.html` — replace the directory section** (lines 42-47) with:

```html
    <section id="directory" aria-label="Directory">
      <h2>All legislators</h2>
      <div class="directory-toggle" role="group" aria-label="Directory view">
        <button id="directory-view-serving" type="button" aria-pressed="true">Serving now</button>
        <button id="directory-view-past" type="button" aria-pressed="false">Past members</button>
      </div>
      <p class="directory-footnote">ⓘ no recorded end date — the honest signal a term is still open</p>
      <label for="directory-filter">Filter by name, chamber, or party</label>
      <input id="directory-filter" type="text" name="filter" />
      <div id="directory-list" aria-live="polite"></div>
    </section>
```

- [ ] **Step 2: `renderDirectoryList` — add the tenure fragment** (exact replacement of the `meta` construction):

```js
    const meta = [
      entry.chamber,
      entry.district ? `district ${entry.district}` : null,
      entry.party,
      // Tenure fragment (2026-08-06 spec §2): only for a serving entry whose displayed anchor
      // term is open AND dated — absent data renders nothing, never a guess.
      entry.servingNow && entry.sinceYear ? `since ${entry.sinceYear}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
```

- [ ] **Step 3: replace `wireDirectoryFilter` with `wireDirectoryView`** (exact code; delete the old function):

```js
// The two-view controller (2026-08-06 spec §2/§4): tracks the active view + re-renders on toggle
// or search input. The search filters rows WITHIN the active view; the toggle badges always carry
// the FULL partition counts. Per-view empty messages keep "no matches" distinguishable from a
// broken fetch (sectionState discipline). The word "current" appears nowhere.
const VIEW_EMPTY_MESSAGE = {
  serving: 'No legislators match this filter among members serving now.',
  past: 'No legislators match this filter among past members.',
};

function wireDirectoryView({
  servingButton, pastButton, filterInput, container, partitions,
}) {
  if (!container) return;
  const state = { activeView: 'serving' };

  if (servingButton) servingButton.textContent = `Serving now (${partitions.servingNow.length})`;
  if (pastButton) pastButton.textContent = `Past members (${partitions.past.length})`;

  const render = () => {
    if (servingButton) servingButton.setAttribute('aria-pressed', String(state.activeView === 'serving'));
    if (pastButton) pastButton.setAttribute('aria-pressed', String(state.activeView === 'past'));
    const activeEntries = state.activeView === 'serving' ? partitions.servingNow : partitions.past;
    const filtered = filterDirectory(activeEntries, filterInput ? filterInput.value : '');
    if (filtered.length === 0) {
      sectionState(container, { state: 'empty', message: VIEW_EMPTY_MESSAGE[state.activeView] });
    } else {
      sectionState(container, { state: 'ready' });
      renderDirectoryList(container, filtered);
    }
  };

  if (servingButton) servingButton.addEventListener('click', () => { state.activeView = 'serving'; render(); });
  if (pastButton) pastButton.addEventListener('click', () => { state.activeView = 'past'; render(); });
  if (filterInput) filterInput.addEventListener('input', render);
  render();
}
```

- [ ] **Step 4: rewire `loadAndRenderDirectory` + `bootstrapDirectoryPage`.** In `loadAndRenderDirectory`, the signature gains the two buttons and the success path hands everything to `wireDirectoryView` (which performs the initial render — delete the old direct `renderDirectoryList` + `wireDirectoryFilter` calls):

```js
async function loadAndRenderDirectory(dataState, {
  directoryListContainer, filterInput, servingButton, pastButton,
}) {
  sectionState(directoryListContainer, { state: 'loading' });
  let entries;
  try {
    entries = buildDirectoryEntries(await dataState.promise);
  } catch {
    sectionState(directoryListContainer, {
      state: 'failed',
      message: "Couldn't load the directory — retry",
      onRetry: () => {
        dataState.promise = loadDirectoryData();
        loadAndRenderDirectory(dataState, {
          directoryListContainer, filterInput, servingButton, pastButton,
        }).catch(() => {});
      },
    });
    return;
  }

  if (entries.length === 0) {
    sectionState(directoryListContainer, { state: 'empty', message: 'No legislators recorded.' });
    return;
  }
  wireDirectoryView({
    servingButton, pastButton, filterInput, container: directoryListContainer, partitions: partitionDirectory(entries),
  });
}
```

and in `bootstrapDirectoryPage`, add the two lookups and thread them through:

```js
  const servingButton = document.getElementById('directory-view-serving');
  const pastButton = document.getElementById('directory-view-past');
```
…and the final call becomes:
```js
  await loadAndRenderDirectory(dataState, {
    directoryListContainer, filterInput, servingButton, pastButton,
  });
```

- [ ] **Step 5: append to `site/css/site.css`:**

```css
/* Directory "Serving now / Past members" toggle (2026-08-06 spec). */

.directory-toggle {
  display: inline-flex;
  border: 1px solid var(--muted);
  border-radius: 6px;
  overflow: hidden;
  margin: 0.5rem 0 0.25rem;
}

.directory-toggle button {
  border: 0;
  background: transparent;
  color: var(--fg);
  padding: 0.4rem 0.9rem;
  font: inherit;
  cursor: pointer;
}

.directory-toggle button + button {
  border-left: 1px solid var(--muted);
}

.directory-toggle button[aria-pressed="true"] {
  background: var(--link);
  color: var(--bg);
}

.directory-footnote {
  color: var(--muted);
  font-size: 0.85em;
  margin: 0.25rem 0 0.75rem;
}
```

- [ ] **Step 6: whole suite in a clean shell** — `node --test` → `fail 0` (the site-modules import-safety tests cover this file; a syntax/import regression would surface here).

- [ ] **Step 7: local smoke** — `node scripts/serve-site.js` in the background, load `http://localhost:<its port>/`, verify: toggle renders with counts, defaults to Serving now, clicking Past members swaps the list, search narrows within the active view only, a `since YYYY` fragment appears on dated serving entries, footnote wording exact. Then stop the server.

- [ ] **Step 8: Commit**

```
git add site/index.html site/js/directory-page.js site/css/site.css
git commit -m "feat(directory): Serving now / Past members toggle with tenure fragments"
```

---

### Task 4: Live verification after merge + deploy (controller/Lance step — no code)

- [ ] After merge to `main` + push, Cloudflare Pages auto-deploys. In a real browser on https://visiblegov.pages.dev/: (a) page opens on **Serving now (N)** with the short list; (b) **Past members (N)** shows the historical bulk; (c) search within each view; (d) Onder appears in Serving now as **US House · district 3 · since 2025** (never MO Senate D2 — Schroer alone holds that); (e) dated serving entries show `since YYYY`, Brown H-149 shows none; (f) footnote text exact; (g) zero console errors.

---

## Self-Review

**Spec coverage:** §2 toggle/default/labels/badges/footnote → Task 3; §2 partition rule + tenure fragment → Tasks 1–3; §3 Onder/Brown facts → Task 1 regression tests + Task 4(d); §4 architecture → matches file layout; §5 honesty rules → constraint block + exact strings in code; §6 tests → Tasks 1–2 (model), site-modules import safety (Task 3 Step 6); §7 rollout → Task 4. No gaps.

**Placeholder scan:** none — every step carries exact code/markup/CSS.

**Type consistency:** `servingNow`/`sinceYear` (Task 1) consumed by `partitionDirectory` (Task 2) and `renderDirectoryList`/`wireDirectoryView` (Task 3) under the same names; `partitions.servingNow`/`partitions.past` shape consistent between Tasks 2 and 3; `wireDirectoryView` option names match `bootstrapDirectoryPage`'s threading.
