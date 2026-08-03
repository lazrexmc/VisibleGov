# Bullet Citation Exposure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `verifier.js`'s existing per-bullet `evidence_quote` on the public bill page as a
click-to-expand citation, mirroring the glossary-term quote pattern, so `trust.html`'s existing
receipt claim becomes true for bill summaries too.

**Architecture:** A migration (draft-then-apply — Lance applies it) adds a computed `citations`
column to `public_verification_notes`, stripped to `{bullet_index, section, evidence_quote}` and
gated on `overall='clean'` (not merely `status='published'`). A new pure validator in
`scripts/probe-public-surface.js` checks that shape mechanically after Lance applies it.
`site/js/bill-page.js` reads the column (already fetched, no new network call) and replaces the
static section-citation `<span>` with an accessible toggle when a citation is available, falling
back to today's plain span otherwise.

**Tech Stack:** Postgres/Supabase (view + RLS posture), vanilla JS ES modules (browser-native, no
build step), `node --test` for tests, jsdom for DOM regression tests.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-02-bullet-citation-exposure-design.md` — adversarially reviewed (Fable 5, 2026-08-02). Every task below implements exactly what it specifies; do not deviate without checking back against it.
- **The migration is draft-then-apply. Do not run it against any live database — write the file only.** Lance applies migrations himself, per this project's standing convention (`CLAUDE.md`, `PLAYBOOK_DELTA.md`).
- **Gate `citations` on `sv.overall = 'clean'`, never merely `sv.kind = 'support'` or `status='published'` alone.** This is the load-bearing fix from the Fable 5 review — the manual review-server publish path never checks verification, so `status='published'` alone does not imply every bullet was supported.
- **`citations` entries carry exactly three keys: `bullet_index`, `section`, `evidence_quote`.** Never `reason` or `supported` — those are stripped deliberately, at the database layer, not just hidden in the UI.
- **Bullet lookup keys strictly on `bullet_index`.** Never cross-check the parsed bullet's `section` text against the verdict's `section` text — two live published summaries already have small formatting differences between the two that would false-fail a real row.
- **Citations only render on the `formattingVerified` branch** of `renderSummary` in `site/js/bill-page.js` — never on the plain-text fallback branch.
- Gate every commit on the extracted `node --test` fail-count (`ℹ fail N` line), never a pipeline's exit status (PLAYBOOK lesson 14).
- `node --test` runs from the repo root, never with a directory argument.
- No LLM/API calls anywhere in this feature.

---

### Task 1: Migration file — `citations` column on `public_verification_notes`

**Files:**
- Create: `supabase/migrations/0021_bullet_citations.sql`

**Interfaces:**
- Produces: a `citations` column on `public_verification_notes`, type `jsonb | null`, computed as described below. Task 2's `checkCitationsShape` and Task 3's `bill-page.js` both consume this column by name once Lance applies the migration.

This task has no `node --test` coverage of its own (it's SQL, and this repo's test suite runs
offline — see `PLAYBOOK_DELTA.md`'s "never a live DB in tests" convention). Its correctness is
verified two ways: by Task 2's pure-function tests (which encode the exact shape this SQL must
produce) and, once Lance applies it live, by running `node scripts/probe-public-surface.js`
(anon-key check) — described in the "Handoff to Lance" section at the end of this plan.

- [ ] **Step 1: Write the migration file**

```sql
-- 0021 (draft — Lance applies). Bullet citation exposure (docs/superpowers/specs/
-- 2026-08-02-bullet-citation-exposure-design.md, adversarially reviewed by Claude Fable 5): exposes
-- verifier.js's own evidence_quote per what_it_does bullet so the public bill page can show a
-- reader the bill's exact words behind each bullet, not just a section citation. This is a
-- DELIBERATE REVERSAL of migration 0019's documented posture ("verification detail... is a staff
-- review tool, not a public-facing claim in its own right") — named explicitly here so it never
-- reads as an oversight to a future reader of that comment.
--
-- Recreates public_verification_notes (same posture as 0019/0020: deliberately NO security_invoker
-- — summary_verifications stays service-role-only per 0004, and this view's own WHERE clause,
-- scoped to summaries.status='published', is the entire access wall) adding one computed column:
--
--   citations: for a support-kind row whose overall is 'clean', a jsonb array of
--   {bullet_index, section, evidence_quote} stripped out of verdicts — deliberately never
--   `reason` (the verifier's own free-text commentary, not a fact from the bill) or `supported`
--   (redundant once gated, and itself the leak vector if handled carelessly). null for every
--   completeness-kind row (verdicts holds an unrelated {key_provisions, coverage} shape there) and
--   for any support-kind row whose overall isn't 'clean'.
--
-- THE GATE IS LOAD-BEARING, NOT DECORATION (Fable 5 adversarial review, 2026-08-02): gating only on
-- kind='support' and relying on "status='published' implies overall='clean'" is NOT mechanically
-- true — that invariant holds for the classifyRecordItem/autoPublishSummary auto-publish path
-- (src/cli/summary-queue.js) but is NEVER CHECKED by the staff review server's manual
-- approve/publish transition (src/review/server.js), which is the review queue's own designed exit
-- for the ~100 items sitting there flagged. The moment a human manually publishes a flagged summary,
-- its support row's verdicts can contain supported:false entries whose evidence_quote is a quote
-- that CONTRADICTS the bullet (VERIFY_SCHEMA allows this by design — the field exists to show what
-- the verifier checked, pass or fail) — stripping reason/supported from that row would present a
-- refuting quote as if it supports the claim. Gating citations on overall='clean' directly closes
-- this mechanically, independent of which publish path was used and independent of whether a future
-- publish path remembers to re-check verification at all.
drop view if exists public_verification_notes;
create view public_verification_notes as
select
  sv.summary_id,
  sv.kind,
  sv.model,
  sv.overall,
  sv.created_at,
  case
    when sv.kind = 'support' and sv.overall = 'clean' then (
      select jsonb_agg(jsonb_build_object(
        'bullet_index', (v->>'bullet_index')::int,
        'section', v->>'section',
        'evidence_quote', v->>'evidence_quote'
      ))
      from jsonb_array_elements(sv.verdicts) as v
    )
    else null
  end as citations
from summary_verifications sv
where exists (
  select 1 from summaries s
  where s.id = sv.summary_id
    and s.status = 'published'
);
grant select on public_verification_notes to anon, authenticated;
```

- [ ] **Step 2: Do NOT apply this migration.** Confirm no `psql`/Supabase CLI/REST DDL call was made
  as part of this task. The file existing in `supabase/migrations/` is the entire deliverable.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0021_bullet_citations.sql
git commit -m "feat: draft migration — expose per-bullet evidence_quote on public_verification_notes (Lance applies)"
```

---

### Task 2: `checkCitationsShape` — mechanical validator for the new column

**Files:**
- Modify: `scripts/probe-public-surface.js`
- Test: `tests/probe-public-surface.test.js`

**Interfaces:**
- Consumes: nothing new from other tasks — this is a pure function operating on plain row objects shaped like `{summary_id, kind, overall, citations}`.
- Produces: `export function checkCitationsShape(noteRows) -> {ok: boolean, violations: Array<{summary_id, reason}>}`, used by this task's own `main()` wiring and available for Task 3 or any future caller. Never throws.

- [ ] **Step 1: Write the failing tests**

Append to `tests/probe-public-surface.test.js` (after the existing `checkRowScoping` tests, before
the `main()` test):

```javascript
// ---- checkCitationsShape — migration 0021 (draft-then-apply, may not be applied yet) ----

test('checkCitationsShape: a completeness row has non-null citations -> violation', () => {
  const rows = [
    { summary_id: 's1', kind: 'completeness', overall: 'complete', citations: [{ bullet_index: 0, section: 'Sec. 1', evidence_quote: 'text' }] },
  ];
  const result = checkCitationsShape(rows);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].summary_id, 's1');
});

test('checkCitationsShape: a completeness row with null citations -> ok', () => {
  const rows = [{ summary_id: 's1', kind: 'completeness', overall: 'complete', citations: null }];
  assert.deepEqual(checkCitationsShape(rows), { ok: true, violations: [] });
});

test('checkCitationsShape: a support row with overall=flagged has non-null citations -> violation (the exact leak the gate exists to prevent)', () => {
  const rows = [
    {
      summary_id: 's-flagged',
      kind: 'support',
      overall: 'flagged',
      citations: [{ bullet_index: 0, section: 'Sec. 1', evidence_quote: 'a refuting quote' }],
    },
  ];
  const result = checkCitationsShape(rows);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].summary_id, 's-flagged');
});

test('checkCitationsShape: a support row with overall=flagged and null citations -> ok (the correct, gated shape)', () => {
  const rows = [{ summary_id: 's-flagged', kind: 'support', overall: 'flagged', citations: null }];
  assert.deepEqual(checkCitationsShape(rows), { ok: true, violations: [] });
});

test('checkCitationsShape: a clean support row with a well-shaped citations array -> ok', () => {
  const rows = [
    {
      summary_id: 's-clean',
      kind: 'support',
      overall: 'clean',
      citations: [
        { bullet_index: 0, section: 'Sec. 1', evidence_quote: 'quote one' },
        { bullet_index: 1, section: 'Sec. 2', evidence_quote: 'quote two' },
      ],
    },
  ];
  assert.deepEqual(checkCitationsShape(rows), { ok: true, violations: [] });
});

test('checkCitationsShape: a citation entry carrying `reason` or `supported` is a violation — those must never reach anon', () => {
  const withReason = [
    { summary_id: 's1', kind: 'support', overall: 'clean', citations: [{ bullet_index: 0, section: 'Sec. 1', evidence_quote: 'q', reason: 'because' }] },
  ];
  assert.equal(checkCitationsShape(withReason).ok, false);

  const withSupported = [
    { summary_id: 's2', kind: 'support', overall: 'clean', citations: [{ bullet_index: 0, section: 'Sec. 1', evidence_quote: 'q', supported: true }] },
  ];
  assert.equal(checkCitationsShape(withSupported).ok, false);
});

test('checkCitationsShape: a clean support row with null citations (e.g. zero verdicts) -> ok, not a violation', () => {
  const rows = [{ summary_id: 's-empty', kind: 'support', overall: 'clean', citations: null }];
  assert.deepEqual(checkCitationsShape(rows), { ok: true, violations: [] });
});

test('checkCitationsShape: rows with no `citations` key at all (pre-0021 DB) -> ok, never a violation — this check is additive, never fails a probe run before Lance applies the migration', () => {
  const rows = [
    { summary_id: 's1', kind: 'support', overall: 'clean' },
    { summary_id: 's2', kind: 'completeness', overall: 'complete' },
  ];
  assert.deepEqual(checkCitationsShape(rows), { ok: true, violations: [] });
});

test('checkCitationsShape: empty/null/undefined noteRows -> ok, never throws', () => {
  assert.deepEqual(checkCitationsShape([]), { ok: true, violations: [] });
  assert.deepEqual(checkCitationsShape(null), { ok: true, violations: [] });
  assert.deepEqual(checkCitationsShape(undefined), { ok: true, violations: [] });
});

test('checkCitationsShape: multiple violations across multiple rows are all reported, not just the first', () => {
  const rows = [
    { summary_id: 's1', kind: 'completeness', overall: 'complete', citations: [{ bullet_index: 0, section: 'x', evidence_quote: 'y' }] },
    { summary_id: 's2', kind: 'support', overall: 'flagged', citations: [{ bullet_index: 0, section: 'x', evidence_quote: 'y' }] },
  ];
  const result = checkCitationsShape(rows);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 2);
});
```

Also add `checkCitationsShape` to the existing import line at the top of the test file:

```javascript
import { checkRequiredColumnsPresent, checkRowScoping, checkCitationsShape, main } from '../scripts/probe-public-surface.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/probe-public-surface.test.js`
Expected: FAIL — `checkCitationsShape is not a function` (or similar import error), since it doesn't exist in `scripts/probe-public-surface.js` yet.

- [ ] **Step 3: Implement `checkCitationsShape` in `scripts/probe-public-surface.js`**

Add this function after `checkRowScoping` (which ends around line 80 of the current file):

```javascript
// checkCitationsShape(noteRows) -> {ok, violations} — migration 0021 (draft-then-apply, may not be
// applied yet) adds a computed `citations` column to public_verification_notes. Once present, its
// content must satisfy three rules, independent of whether 0021 has landed yet: (1) a
// completeness-kind row's citations is always null (its verdicts column holds an unrelated
// {key_provisions, coverage} shape, nothing to extract); (2) a support-kind row whose overall isn't
// 'clean' has citations null too — this is the exact gate the Fable 5 design review found missing;
// a flagged row's evidence_quote can CONTRADICT its bullet, and this check catches it leaking
// through as if it were a receipt; (3) a clean support row's citations, when non-null, is an array
// of objects with EXACTLY bullet_index/section/evidence_quote keys — never `reason` (the verifier's
// own commentary) or `supported` (redundant once gated, and the leak vector if handled carelessly).
// Tolerates `citations` being entirely absent from a row (pre-0021 shape) — this check is additive,
// never a replacement for checkRequiredColumnsPresent, and never fails a probe run against a
// database that hasn't had 0021 applied yet. Pure — no I/O, never throws.
const CITATION_ENTRY_KEYS = ['bullet_index', 'evidence_quote', 'section'];

export function checkCitationsShape(noteRows) {
  const rowsArr = Array.isArray(noteRows) ? noteRows : [];
  const violations = [];
  for (const row of rowsArr) {
    if (!row || !('citations' in row)) continue; // pre-0021 row shape — nothing to check yet
    const { kind, overall, citations } = row;
    if (kind === 'completeness') {
      if (citations !== null) violations.push({ summary_id: row.summary_id, reason: 'completeness row has non-null citations' });
      continue;
    }
    if (kind === 'support' && overall !== 'clean') {
      if (citations !== null) violations.push({ summary_id: row.summary_id, reason: `support row with overall=${overall} has non-null citations` });
      continue;
    }
    if (citations === null || citations === undefined) continue; // no citations extracted (e.g. empty verdicts) — fine
    if (!Array.isArray(citations)) {
      violations.push({ summary_id: row.summary_id, reason: 'citations is not an array' });
      continue;
    }
    for (const entry of citations) {
      const keys = Object.keys(entry || {}).sort();
      if (keys.join(',') !== CITATION_ENTRY_KEYS.join(',')) {
        violations.push({ summary_id: row.summary_id, reason: `citation entry has unexpected keys: ${keys.join(',')}` });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/probe-public-surface.test.js`
Expected: PASS, all `checkCitationsShape` tests plus every pre-existing test in this file.

- [ ] **Step 5: Wire `checkCitationsShape` into `main()`'s live probe**

In `scripts/probe-public-surface.js`, inside `main()`, immediately after the existing
`checkRowScoping` block (the `check('public_verification_notes is scoped to anon-visible PUBLISHED
summaries', ...)` call), add:

```javascript
    // Migration 0021 (draft-then-apply) may or may not have landed yet — request the expanded
    // shape and gracefully skip this check (not fail the probe) if the column doesn't exist.
    const notesWithCitations = await allRows(url, H, 'public_verification_notes?select=summary_id,kind,overall,citations');
    if (notesWithCitations.status === 200 && notesWithCitations.body) {
      const { ok: citationsOk, violations } = checkCitationsShape(notesWithCitations.body);
      check(
        'public_verification_notes.citations is correctly gated and shaped (migration 0021)',
        citationsOk,
        violations.length ? `${violations.length} violation(s): ${violations.map((v) => `${v.summary_id} — ${v.reason}`).join('; ')}` : `${notesWithCitations.body.length} row(s) checked`,
        state,
      );
    } else {
      console.log('INFO  public_verification_notes.citations check skipped — migration 0021 not applied yet (or the request failed for another reason)');
    }
```

- [ ] **Step 6: Run the full suite to verify nothing else broke**

Run: `node --test` (from repo root)
Extract the fail count: look for the line matching `^ℹ fail`.
Expected: `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add scripts/probe-public-surface.js tests/probe-public-surface.test.js
git commit -m "feat: checkCitationsShape validator for the new public_verification_notes.citations column"
```

---

### Task 3: Bill page — citation toggle UI

**Files:**
- Modify: `site/js/bill-page.js`
- Test: `tests/bill-page.test.js`

**Interfaces:**
- Consumes: `note.citations` — an array of `{bullet_index, section, evidence_quote}` or `null`/`undefined`, already present on the `note` object `loadSummarySection`/`renderSummary` already fetch and pass around (no new network call — `public_verification_notes` is fetched with no `select=` restriction, so a live column addition flows through automatically). Also consumes `el` from `./render.js` (already imported) and `bullet.index`/`bullet.section`/`bullet.point` from `parseBullets`'s existing output shape (already used elsewhere in this file).
- Produces: a new module-local function `buildCitationToggle(sectionText, quoteText) -> {toggle, detail}`, not exported (same visibility as `buildGlossDetail`/`buildMarkedTerm` in `glossary-inline.js`, which this mirrors) — nothing outside this file's own bullet-rendering loop calls it.

- [ ] **Step 1: Write the failing DOM regression tests**

Append to `tests/bill-page.test.js`, after the existing `loadSummarySection` tests (after the test
ending around line 867):

```javascript
// ============================================================================
// Bullet citation toggle — bullet-citation-exposure design (2026-08-02). The `citations` column on
// public_verification_notes is new (migration 0021, draft-then-apply); these tests reproduce both
// the "citation available" and "no citation available" cases, matching this file's own convention
// of DOM-wiring regression tests at the fetch -> select -> render level, not just pure-function
// tests.
// ============================================================================

test('loadSummarySection: a bullet WITH a matching citation renders an accessible toggle that reveals the exact quote on click', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/summaries?')) {
      return okResponse([{
        id: 'sum-cited', bill_id: 'bill-cited', model: 'claude-opus-5', body_md: '**What it does:**\n- Does X. (Sec. 1)\n- Does Y. (Sec. 2)',
      }]);
    }
    if (u.includes('/public_verification_notes?')) {
      return okResponse([
        {
          summary_id: 'sum-cited',
          kind: 'support',
          overall: 'clean',
          model: 'claude-sonnet-5',
          created_at: '2026-07-15T18:22:00.000Z',
          citations: [
            { bullet_index: 0, section: 'Sec. 1', evidence_quote: 'The exact bill text for point X.' },
          ],
        },
      ]);
    }
    if (u.includes('/summary_terms?')) return okResponse([]);
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadSummarySection(container, { billId: 'bill-cited' });

  const items = container.querySelectorAll('.bill-summary-bullets li');
  assert.equal(items.length, 2);

  // Bullet 0 has a citation: an accessible toggle, not the old plain span.
  const toggle0 = items[0].querySelector('.bill-citation-toggle');
  assert.notEqual(toggle0, null, 'bullet 0 should render an interactive citation toggle');
  assert.equal(toggle0.getAttribute('role'), 'button');
  assert.equal(toggle0.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle0.tabIndex, 0);
  assert.match(toggle0.textContent, /Sec\. 1/);

  const quote0 = items[0].querySelector('.bill-citation-quote');
  assert.notEqual(quote0, null);
  assert.equal(quote0.hidden, true, 'the quote is hidden until the toggle is activated');
  assert.equal(quote0.textContent, 'The exact bill text for point X.');

  toggle0.dispatchEvent(new dom.window.Event('click'));
  assert.equal(quote0.hidden, false, 'clicking the toggle reveals the quote');
  assert.equal(toggle0.getAttribute('aria-expanded'), 'true');

  // Bullet 1 has NO matching citation (bullet_index 1 not present in the citations array): falls
  // back to the old plain, non-interactive span — never a broken/empty toggle.
  const toggle1 = items[1].querySelector('.bill-citation-toggle');
  assert.equal(toggle1, null, 'bullet 1 has no citation — must not render a toggle at all');
  const span1 = items[1].querySelector('.bill-summary-bullet-section');
  assert.notEqual(span1, null);
  assert.match(span1.textContent, /Sec\. 2/);
});

test('loadSummarySection: citations is null (flagged/no-citation summary) -> every bullet falls back to the plain, non-interactive section span', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/summaries?')) {
      return okResponse([{
        id: 'sum-no-cite', bill_id: 'bill-no-cite', model: 'claude-opus-5', body_md: '**What it does:**\n- Does X. (Sec. 1)',
      }]);
    }
    if (u.includes('/public_verification_notes?')) {
      return okResponse([
        {
          summary_id: 'sum-no-cite', kind: 'support', overall: 'clean', model: 'claude-sonnet-5', created_at: '2026-07-15T18:22:00.000Z', citations: null,
        },
      ]);
    }
    if (u.includes('/summary_terms?')) return okResponse([]);
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadSummarySection(container, { billId: 'bill-no-cite' });

  assert.equal(container.querySelector('.bill-citation-toggle'), null);
  const span = container.querySelector('.bill-summary-bullet-section');
  assert.notEqual(span, null);
  assert.match(span.textContent, /Sec\. 1/);
});

test('loadSummarySection: a public_verification_notes row with no `citations` key at all (pre-0021 shape) -> falls back cleanly, same as null', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/summaries?')) {
      return okResponse([{
        id: 'sum-pre-0021', bill_id: 'bill-pre-0021', model: 'claude-opus-5', body_md: '**What it does:**\n- Does X. (Sec. 1)',
      }]);
    }
    if (u.includes('/public_verification_notes?')) {
      return okResponse([
        {
          summary_id: 'sum-pre-0021', overall: 'clean', model: 'claude-sonnet-5', created_at: '2026-07-15T18:22:00.000Z',
        },
      ]);
    }
    if (u.includes('/summary_terms?')) return okResponse([]);
    return okResponse([]);
  });

  const container = document.createElement('section');
  await loadSummarySection(container, { billId: 'bill-pre-0021' });

  assert.equal(container.querySelector('.bill-citation-toggle'), null);
  assert.notEqual(container.querySelector('.bill-summary-bullet-section'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/bill-page.test.js`
Expected: FAIL — the first new test fails because `.bill-citation-toggle` doesn't exist yet (every
bullet still renders the old plain span regardless of `citations`).

- [ ] **Step 3: Implement the citation toggle in `site/js/bill-page.js`**

Add this new function near the top of the "Small rendering helpers" section (after
`personHref`, before the bullet-rendering code that will call it — around where
`renderSummary` is defined):

```javascript
// buildCitationToggle(sectionText, quoteText) -> {toggle, detail}. Bullet-citation-exposure design
// (2026-08-02, docs/superpowers/specs/2026-08-02-bullet-citation-exposure-design.md) — mirrors
// glossary-inline.js's buildMarkedTerm/buildGlossDetail accessible-toggle shape (tabIndex, role=
// button, aria-expanded, click + Enter/Space), not shared code with it, since the data and call
// site differ (one citation per bullet, never a grouped array of rows). `toggle` keeps the same
// text and class the old non-interactive span used, so it drops into the same spot; `detail` is a
// hidden sibling <blockquote>, appended by the caller AFTER the bullet's inline content — never
// nested inside it, same rule this file already documents for the glossary details it renders
// alongside.
function buildCitationToggle(sectionText, quoteText) {
  const toggle = el('span', { class: 'bill-summary-bullet-section bill-citation-toggle' }, ` (${sectionText})`);
  toggle.tabIndex = 0;
  toggle.setAttribute('role', 'button');
  toggle.setAttribute('aria-expanded', 'false');

  const detail = el('blockquote', { class: 'bill-citation-quote' }, quoteText);
  detail.hidden = true;

  const flip = () => {
    detail.hidden = !detail.hidden;
    toggle.setAttribute('aria-expanded', String(!detail.hidden));
  };
  toggle.addEventListener('click', flip);
  toggle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      flip();
    }
  });

  return { toggle, detail };
}
```

Then, inside `renderSummary`, replace the bullet-rendering loop (currently):

```javascript
    if (structured.bullets.length > 0) {
      const ul = el('ul', { class: 'bill-summary-bullets' });
      for (const bullet of structured.bullets) {
        const li = el('li', {});
        const { inline, details } = renderMarkedText(bullet.point, glossaryTerms);
        li.appendChild(inline);
        li.appendChild(el('span', { class: 'bill-summary-bullet-section' }, ` (${bullet.section})`));
        for (const detail of details) li.appendChild(detail);
        ul.appendChild(li);
      }
      container.appendChild(ul);
    }
```

with:

```javascript
    if (structured.bullets.length > 0) {
      // Keyed strictly on bullet_index, never cross-checked against parsed section text — two live
      // published summaries have small formatting differences between parseBullets' extraction and
      // the verifier's own recorded section string (design spec §2); position is the reliable key.
      const citationsByIndex = new Map(
        (Array.isArray(note?.citations) ? note.citations : [])
          .filter((c) => c && Number.isInteger(c.bullet_index))
          .map((c) => [c.bullet_index, c]),
      );
      const ul = el('ul', { class: 'bill-summary-bullets' });
      for (const bullet of structured.bullets) {
        const li = el('li', {});
        const { inline, details } = renderMarkedText(bullet.point, glossaryTerms);
        li.appendChild(inline);
        const citation = citationsByIndex.get(bullet.index);
        const hasQuote = citation && typeof citation.evidence_quote === 'string' && citation.evidence_quote.trim() !== '';
        if (hasQuote) {
          const { toggle, detail: citationDetail } = buildCitationToggle(bullet.section, citation.evidence_quote);
          li.appendChild(toggle);
          li.appendChild(citationDetail);
        } else {
          li.appendChild(el('span', { class: 'bill-summary-bullet-section' }, ` (${bullet.section})`));
        }
        for (const detail of details) li.appendChild(detail);
        ul.appendChild(li);
      }
      container.appendChild(ul);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/bill-page.test.js`
Expected: PASS, all three new tests plus every pre-existing test in this file.

- [ ] **Step 5: Run the full suite**

Run: `node --test` (from repo root)
Extract the fail count from the `^ℹ fail` line.
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add site/js/bill-page.js tests/bill-page.test.js
git commit -m "feat: click-to-expand bullet citations on the bill page (evidence_quote, gated on overall=clean)"
```

---

## Handoff to Lance (not a task — nothing left for an agent to do)

1. Review `supabase/migrations/0021_bullet_citations.sql` and apply it via the Supabase SQL editor (same process as every prior migration).
2. Run `node scripts/probe-public-surface.js` (needs `SUPABASE_URL`/`SUPABASE_ANON_KEY` in the environment) — confirms the new `citations` column is present, correctly gated, and correctly shaped against the live, now-migrated database.
3. Spot-check a published bill page in a browser: a bullet with a citation should show a clickable "(Section X)" that reveals the exact quote; a bullet without one renders exactly as it does today.
4. No `trust.html` copy change needed — the existing receipt claim becomes true once step 1 lands.
