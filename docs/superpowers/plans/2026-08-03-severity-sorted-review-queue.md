# Severity-Sorted Review Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local staff review queue (`src/review/server.js` + `src/review/page.html`) show
each flagged summary's issue count and, for completeness-incomplete summaries, which provision is
missing — sorted so single-issue items surface first.

**Architecture:** Three pure functions added to `server.js` (`isCompletenessShapedVerification`,
`computeIssueCount`, `describeMissingProvisions`), wired into the existing `handleQueue`/`handleItem`
handlers to add `issue_count`/`missing_provisions` fields and sort the queue response. The client
(`page.html`'s inline script) renders the new fields — extending the existing dropdown-label and
verification-strip rendering, not rebuilding either.

**Tech Stack:** Vanilla Node.js HTTP server, no framework. `node --test` for tests, using the
existing `withServer`/`fakeClient` HTTP-level test harness in `tests/review-logic.test.js`.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-03-severity-sorted-review-queue-design.md`.
- No changes to the decision/action model — `TRANSITIONS`, `approve`/`reject`/`edit`/`publish` stay exactly as they are.
- No changes to `QUEUE_STATUSES` or which summaries appear in the queue.
- Unverified items (`issue_count: null`) always sort LAST, never first.
- `isCompletenessShapedVerification` must discriminate by DATA SHAPE, not a `kind` column — same convention `isSupportShapedVerification` already uses in this file, for the same reason (draft-then-apply migration ordering is never assumed).
- Gate every commit on the extracted `node --test` fail-count (`ℹ fail N` line), never a pipeline's exit status.
- `node --test` runs from the repo root, never with a directory argument.
- No LLM/API calls anywhere in this feature.

---

### Task 1: Pure functions — `isCompletenessShapedVerification`, `computeIssueCount`, `describeMissingProvisions`

**Files:**
- Modify: `src/review/server.js`
- Test: `tests/review-logic.test.js`

**Interfaces:**
- Produces:
  - `export function isCompletenessShapedVerification(row) -> boolean`
  - `export function computeIssueCount(supportVerification, completenessVerification) -> number | null`
  - `export function describeMissingProvisions(completenessVerification) -> Array<{section: string, provision: string}>`
- Consumes: nothing new — these are pure functions over plain objects shaped like `summary_verifications` rows (`{overall, verdicts, model, created_at}`), where a completeness row's `verdicts` is `{key_provisions: [{section, provision}], coverage: [{provision_index, covered, bullet_index, note}]}` and a support row's `verdicts` is `[{bullet_index, section, supported, reason, evidence_quote}]` (both shapes already used elsewhere in this file — see `isSupportShapedVerification`, `server.js:212-217`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/review-logic.test.js`, right after the existing `isSupportShapedVerification` tests
(search for that name to find them) or after the `SUPPORT_ROW`/`COMPLETENESS_ROW` fixture
declarations (`review-logic.test.js:422-432`) — put these new tests near those fixtures since they
reuse them:

```javascript
// ---- isCompletenessShapedVerification / computeIssueCount / describeMissingProvisions ----
// (severity-sorted review queue, 2026-08-03)

const INCOMPLETE_COMPLETENESS_ROW = {
  summary_id: 's1',
  overall: 'incomplete',
  model: 'subagent:claude-sonnet-5',
  created_at: '2026-01-01T00:00:01.000Z',
  verdicts: {
    key_provisions: [
      { section: 'SEC. 1.', provision: 'Does X.' },
      { section: 'SEC. 2.', provision: 'Does Y.' },
    ],
    coverage: [
      { provision_index: 0, covered: true, bullet_index: 0, note: 'covered' },
      { provision_index: 1, covered: false, bullet_index: null, note: 'missing' },
    ],
  },
};

const FLAGGED_SUPPORT_ROW = {
  summary_id: 's1',
  overall: 'flagged',
  model: 'subagent:claude-sonnet-5',
  created_at: '2026-01-01T00:00:00.000Z',
  verdicts: [
    { bullet_index: 0, section: 'Sec. 1', supported: false, reason: 'not found', evidence_quote: 'q1' },
    { bullet_index: 1, section: 'Sec. 2', supported: true, reason: 'ok', evidence_quote: 'q2' },
  ],
};

test('isCompletenessShapedVerification: a real completeness row -> true', () => {
  assert.equal(isCompletenessShapedVerification(COMPLETENESS_ROW), true);
  assert.equal(isCompletenessShapedVerification(INCOMPLETE_COMPLETENESS_ROW), true);
});

test('isCompletenessShapedVerification: a real support row -> false (array verdicts)', () => {
  assert.equal(isCompletenessShapedVerification(SUPPORT_ROW), false);
  assert.equal(isCompletenessShapedVerification(FLAGGED_SUPPORT_ROW), false);
});

test('isCompletenessShapedVerification: malformed/absent -> false, never throws', () => {
  assert.equal(isCompletenessShapedVerification(null), false);
  assert.equal(isCompletenessShapedVerification(undefined), false);
  assert.equal(isCompletenessShapedVerification({}), false);
  assert.equal(isCompletenessShapedVerification({ verdicts: null }), false);
  assert.equal(isCompletenessShapedVerification({ verdicts: 'not an object' }), false);
});

test('computeIssueCount: no verification at all -> null (unranked, not zero)', () => {
  assert.equal(computeIssueCount(null, null), null);
  assert.equal(computeIssueCount(undefined, undefined), null);
});

test('computeIssueCount: support-only with N unsupported -> N', () => {
  assert.equal(computeIssueCount(FLAGGED_SUPPORT_ROW, null), 1);
  assert.equal(computeIssueCount(SUPPORT_ROW, null), 0);
});

test('computeIssueCount: completeness-only with M missing -> M', () => {
  assert.equal(computeIssueCount(null, INCOMPLETE_COMPLETENESS_ROW), 1);
  assert.equal(computeIssueCount(null, COMPLETENESS_ROW), 0);
});

test('computeIssueCount: both present -> sum, including the case where one axis is clean (no false zero)', () => {
  assert.equal(computeIssueCount(SUPPORT_ROW, INCOMPLETE_COMPLETENESS_ROW), 1, 'support clean (0) + completeness incomplete (1) = 1, not 0');
  assert.equal(computeIssueCount(FLAGGED_SUPPORT_ROW, INCOMPLETE_COMPLETENESS_ROW), 2);
  assert.equal(computeIssueCount(SUPPORT_ROW, COMPLETENESS_ROW), 0);
});

test('describeMissingProvisions: no completeness row -> []', () => {
  assert.deepEqual(describeMissingProvisions(null), []);
  assert.deepEqual(describeMissingProvisions(undefined), []);
});

test('describeMissingProvisions: a complete (nothing missing) row -> []', () => {
  assert.deepEqual(describeMissingProvisions(COMPLETENESS_ROW), []);
});

test('describeMissingProvisions: an incomplete row -> the correct subset of key_provisions, matched by provision_index, not array position', () => {
  const result = describeMissingProvisions(INCOMPLETE_COMPLETENESS_ROW);
  assert.deepEqual(result, [{ section: 'SEC. 2.', provision: 'Does Y.' }]);
});

test('describeMissingProvisions: multiple missing provisions are all returned, in provision_index order', () => {
  const row = {
    ...INCOMPLETE_COMPLETENESS_ROW,
    verdicts: {
      key_provisions: [
        { section: 'SEC. 1.', provision: 'Does X.' },
        { section: 'SEC. 2.', provision: 'Does Y.' },
        { section: 'SEC. 3.', provision: 'Does Z.' },
      ],
      coverage: [
        { provision_index: 2, covered: false, bullet_index: null, note: 'missing' },
        { provision_index: 0, covered: true, bullet_index: 0, note: 'covered' },
        { provision_index: 1, covered: false, bullet_index: null, note: 'missing' },
      ],
    },
  };
  assert.deepEqual(describeMissingProvisions(row), [
    { section: 'SEC. 2.', provision: 'Does Y.' },
    { section: 'SEC. 3.', provision: 'Does Z.' },
  ]);
});
```

Also add the three new names to the existing import block at the top of the file
(`review-logic.test.js:5-14`):

```javascript
import {
  nextStatus, mapNoteAction, validateDecisionInput, countVoteCasts, pickLatestVote,
  pickBillText, readBody, BodyTooLargeError, requestListener, isAllowedDecisionRequest,
  verificationBadge, latestVerificationBySummary, resolveVerificationRows,
  validateGlossaryDecisionInput, glossVerificationBadge, latestVerificationByTerm,
  isPublishCompletenessViolation, isSupportShapedVerification,
  isCompletenessShapedVerification, computeIssueCount, describeMissingProvisions,
  formatCandidateDistrict, formatCandidateEraSpan, findCandidateEvidence,
  buildLanceLinkEvidence, buildLanceAttachEvidence, appendResolution, validateIdentityDecisionInput,
  HOST, PORT,
} from '../src/review/server.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/review-logic.test.js`
Expected: FAIL — import error, `isCompletenessShapedVerification` (and the other two) are not
exported from `src/review/server.js` yet.

- [ ] **Step 3: Implement the three functions in `src/review/server.js`**

Add immediately after `isSupportShapedVerification` (ends at `server.js:217`):

```javascript
// isCompletenessShapedVerification — the missing counterpart to isSupportShapedVerification above,
// same shape-not-schema discrimination style (see that function's own comment for why: this file
// must work whether or not migration 0020's `kind` column exists on the database it's talking to,
// so rows are told apart by their own data shape, never by trusted metadata). A completeness row's
// `verdicts` is {key_provisions, coverage} — an OBJECT, never an array (a support row's verdicts IS
// an array). Severity-sorted review queue, 2026-08-03.
export function isCompletenessShapedVerification(row) {
  const verdicts = row?.verdicts;
  if (!verdicts || Array.isArray(verdicts)) return false;
  return Array.isArray(verdicts.coverage);
}

// computeIssueCount(supportVerification, completenessVerification) -> number | null. Severity-
// sorted review queue, 2026-08-03: the whole point of this feature is surfacing "how much work does
// this item need" so single-issue flags sort first. null (not 0) when NEITHER verification exists —
// an honestly-unverified item needs a full check run, not a quick fix, and must sort AFTER every
// numeric item, never before (never conflate "unranked" with "zero issues"). Otherwise: unsupported
// bullet count (0 if no support row) + missing provision count (0 if no completeness row) — a
// summary clean on one axis but flagged on the other must show the OTHER axis's real count, never a
// false zero from only checking one side.
export function computeIssueCount(supportVerification, completenessVerification) {
  if (!supportVerification && !completenessVerification) return null;
  const unsupported = supportVerification
    ? (supportVerification.verdicts || []).filter((v) => !v.supported).length
    : 0;
  const missing = completenessVerification
    ? (completenessVerification.verdicts?.coverage || []).filter((c) => !c.covered).length
    : 0;
  return unsupported + missing;
}

// describeMissingProvisions(completenessVerification) -> Array<{section, provision}>. Severity-
// sorted review queue, 2026-08-03: this data has existed in summary_verifications since the
// completeness axis shipped (migration 0020) but was NEVER reachable from this review server before
// this feature — isSupportShapedVerification's filter discarded every completeness row outright.
// Matched via coverage's own provision_index, never by array position alone (mirrors
// assessCompleteness's own indexing discipline in src/lib/verifier.js) — coverage entries are not
// guaranteed to arrive in provision_index order (see the multi-missing test case).
export function describeMissingProvisions(completenessVerification) {
  if (!completenessVerification) return [];
  const keyProvisions = completenessVerification.verdicts?.key_provisions || [];
  const coverage = completenessVerification.verdicts?.coverage || [];
  return coverage
    .filter((c) => !c.covered)
    .map((c) => keyProvisions[c.provision_index])
    .filter(Boolean)
    .map((p) => ({ section: p.section, provision: p.provision }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/review-logic.test.js`
Expected: PASS, all new tests plus every pre-existing test in this file.

- [ ] **Step 5: Commit**

```bash
git add src/review/server.js tests/review-logic.test.js
git commit -m "feat: isCompletenessShapedVerification/computeIssueCount/describeMissingProvisions for the review queue"
```

---

### Task 2: Wire severity into `handleQueue` and `handleItem`

**Files:**
- Modify: `src/review/server.js`
- Test: `tests/review-logic.test.js`

**Interfaces:**
- Consumes: `isCompletenessShapedVerification`, `computeIssueCount`, `describeMissingProvisions` from Task 1; the existing `selectAll`, `resolveVerificationRows`, `latestVerificationBySummary`, `isSupportShapedVerification` (all already used in `handleQueue`/`handleItem` today).
- Produces: `handleQueue`'s JSON response array gains `issue_count` (number or `null`) per item and is sorted ascending by that value (null last); `handleItem`'s JSON response gains `completeness_verification` (the raw row or `null`) and `missing_provisions` (array, possibly empty).

- [ ] **Step 1: Write the failing HTTP-level tests**

Add to `tests/review-logic.test.js`, after the existing completeness-badge tests
(`review-logic.test.js:434-476` — right after the "the response carries the support row" test):

```javascript
// ---- severity-sorted review queue (2026-08-03): issue_count sorting + missing_provisions ----

test('GET /api/queue: sorts ascending by issue_count — fewest issues first', () => {
  const client = fakeClient({
    summaries: {
      data: [
        { id: 's-three', status: 'draft', created_at: '2026-01-01T00:00:00Z', bills: { identifier: 'HR 3', title: 'Three issues' } },
        { id: 's-zero', status: 'draft', created_at: '2026-01-02T00:00:00Z', bills: { identifier: 'HR 0', title: 'Clean' } },
        { id: 's-one', status: 'draft', created_at: '2026-01-03T00:00:00Z', bills: { identifier: 'HR 1', title: 'One issue' } },
      ],
      error: null,
    },
    summary_verifications: {
      data: [
        { summary_id: 's-zero', overall: 'clean', model: 'm', created_at: '2026-01-02T00:00:00Z', verdicts: [{ bullet_index: 0, section: 'Sec. 1', supported: true, reason: 'ok', evidence_quote: 'q' }] },
        {
          summary_id: 's-three',
          overall: 'flagged',
          model: 'm',
          created_at: '2026-01-01T00:00:00Z',
          verdicts: [
            { bullet_index: 0, section: 'Sec. 1', supported: false, reason: 'x', evidence_quote: 'q' },
            { bullet_index: 1, section: 'Sec. 2', supported: false, reason: 'x', evidence_quote: 'q' },
            { bullet_index: 2, section: 'Sec. 3', supported: false, reason: 'x', evidence_quote: 'q' },
          ],
        },
        {
          summary_id: 's-one',
          overall: 'flagged',
          model: 'm',
          created_at: '2026-01-03T00:00:00Z',
          verdicts: [{ bullet_index: 0, section: 'Sec. 1', supported: false, reason: 'x', evidence_quote: 'q' }],
        },
      ],
      error: null,
    },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/queue`);
    const body = await res.json();
    assert.deepEqual(body.map((r) => r.id), ['s-zero', 's-one', 's-three']);
    assert.deepEqual(body.map((r) => r.issue_count), [0, 1, 3]);
  }, client);
});

test('GET /api/queue: an unverified item (no verification row at all) sorts LAST, issue_count null', () => {
  const client = fakeClient({
    summaries: {
      data: [
        { id: 's-unverified', status: 'draft', created_at: '2026-01-01T00:00:00Z', bills: { identifier: 'HR 9', title: 'Unverified' } },
        { id: 's-one', status: 'draft', created_at: '2026-01-02T00:00:00Z', bills: { identifier: 'HR 1', title: 'One issue' } },
      ],
      error: null,
    },
    summary_verifications: {
      data: [
        {
          summary_id: 's-one',
          overall: 'flagged',
          model: 'm',
          created_at: '2026-01-02T00:00:00Z',
          verdicts: [{ bullet_index: 0, section: 'Sec. 1', supported: false, reason: 'x', evidence_quote: 'q' }],
        },
      ],
      error: null,
    },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/queue`);
    const body = await res.json();
    assert.deepEqual(body.map((r) => r.id), ['s-one', 's-unverified']);
    assert.equal(body[1].issue_count, null);
  }, client);
});

test('GET /api/queue: ties (equal issue_count) preserve the existing created_at order', () => {
  const client = fakeClient({
    summaries: {
      data: [
        { id: 's-earlier', status: 'draft', created_at: '2026-01-01T00:00:00Z', bills: { identifier: 'HR 1', title: 'Earlier' } },
        { id: 's-later', status: 'draft', created_at: '2026-01-02T00:00:00Z', bills: { identifier: 'HR 2', title: 'Later' } },
      ],
      error: null,
    },
    summary_verifications: {
      data: [
        { summary_id: 's-earlier', overall: 'clean', model: 'm', created_at: '2026-01-01T00:00:00Z', verdicts: [] },
        { summary_id: 's-later', overall: 'clean', model: 'm', created_at: '2026-01-02T00:00:00Z', verdicts: [] },
      ],
      error: null,
    },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/queue`);
    const body = await res.json();
    assert.deepEqual(body.map((r) => r.id), ['s-earlier', 's-later']);
  }, client);
});

test('GET /api/item/:id: an incomplete completeness row -> missing_provisions names the correct section/provision', () => {
  const client = fakeClient({
    summaries: {
      data: {
        id: 'sum1', bill_id: 'b1', status: 'draft', body_md: '- x (Sec 1)', model: 'claude-opus-5',
        prompt_version: 'v1', bill_text_hash: 'h1', created_at: '2026-01-01T00:00:00Z', published_at: null,
      },
      error: null,
    },
    bills: { data: { identifier: 'HR 1', title: 'A Bill', canonical_url: 'https://example.test/hr1' }, error: null },
    bill_texts: { data: [], error: null },
    votes: { data: [], error: null },
    summary_verifications: {
      data: [
        { ...SUPPORT_ROW, summary_id: 'sum1' },
        { ...INCOMPLETE_COMPLETENESS_ROW, summary_id: 'sum1' },
      ],
      error: null,
    },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/item/sum1`);
    const body = await res.json();
    assert.deepEqual(body.missing_provisions, [{ section: 'SEC. 2.', provision: 'Does Y.' }]);
    assert.equal(body.completeness_verification.overall, 'incomplete');
  }, client);
});

test('GET /api/item/:id: a complete (nothing missing) or absent completeness row -> missing_provisions is [], not omitted', () => {
  const client = fakeClient({
    summaries: {
      data: {
        id: 'sum1', bill_id: 'b1', status: 'draft', body_md: '- x (Sec 1)', model: 'claude-opus-5',
        prompt_version: 'v1', bill_text_hash: 'h1', created_at: '2026-01-01T00:00:00Z', published_at: null,
      },
      error: null,
    },
    bills: { data: { identifier: 'HR 1', title: 'A Bill', canonical_url: 'https://example.test/hr1' }, error: null },
    bill_texts: { data: [], error: null },
    votes: { data: [], error: null },
    summary_verifications: { data: [{ ...SUPPORT_ROW, summary_id: 'sum1' }], error: null },
  });
  return withServer(async (base) => {
    const res = await fetch(`${base}/api/item/sum1`);
    const body = await res.json();
    assert.deepEqual(body.missing_provisions, []);
    assert.equal(body.completeness_verification, null);
  }, client);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/review-logic.test.js`
Expected: FAIL — `issue_count`/`missing_provisions`/`completeness_verification` are `undefined` in
the responses; the sort-order assertions fail (queue still comes back in plain `created_at` order).

- [ ] **Step 3: Implement in `handleQueue`** (`src/review/server.js:327-365`)

Replace the whole function body from the `idSet`/`latestVerification` section onward:

```javascript
async function handleQueue(client, res) {
  if (!client) { sendJson(res, 500, { error: 'internal error' }); return; }
  try {
    const { data, error } = await client
      .from('summaries')
      .select('id,status,created_at,bills(identifier,title)')
      .in('status', QUEUE_STATUSES)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const idSet = new Set((data ?? []).map((row) => row.id));
    let latestSupport = new Map();
    let latestCompleteness = new Map();
    if (idSet.size > 0) {
      const verResult = await selectAll(client, 'summary_verifications', 'summary_id,overall,verdicts,created_at');
      const rows = resolveVerificationRows(verResult).filter((r) => idSet.has(r.summary_id));
      latestSupport = latestVerificationBySummary(rows.filter(isSupportShapedVerification));
      // Severity-sorted review queue (2026-08-03): completeness rows share this same table/query —
      // one read already covers both kinds, no second DB round-trip needed.
      latestCompleteness = latestVerificationBySummary(rows.filter(isCompletenessShapedVerification));
    }

    const items = (data ?? []).map((row) => {
      const support = latestSupport.get(row.id) ?? null;
      const completeness = latestCompleteness.get(row.id) ?? null;
      return {
        id: row.id,
        status: row.status,
        created_at: row.created_at,
        bill: row.bills ? { identifier: row.bills.identifier, title: row.bills.title } : null,
        verified: verificationBadge(support).state,
        issue_count: computeIssueCount(support, completeness),
        missing_provisions: describeMissingProvisions(completeness),
      };
    });

    // Severity-sorted review queue (2026-08-03): ascending by issue_count, null (unverified) LAST —
    // an unverified item needs a full check, not a quick fix, so surfacing it first would contradict
    // this feature's own purpose. A stable sort preserves the existing created_at tie-break.
    items.sort((a, b) => {
      if (a.issue_count === b.issue_count) return 0;
      if (a.issue_count === null) return 1;
      if (b.issue_count === null) return -1;
      return a.issue_count - b.issue_count;
    });

    sendJson(res, 200, items);
  } catch (err) {
    sendServerError(res, 'queue', err);
  }
}
```

- [ ] **Step 4: Implement in `handleItem`** (`src/review/server.js:367-430`)

Replace the verification-fetching section (from the `// No .limit(1) here` comment through the
`sendJson` call):

```javascript
    // No .limit(1) here (deliberately, completeness-axis follow-up 2026-07-31): applyRecordDecision
    // (src/cli/summary-queue.js) inserts the completeness row immediately AFTER the support row, so
    // the completeness row's created_at is typically the LATER of the two — a DB-side
    // order+limit(1) would very often hand this endpoint the completeness row, not the support one.
    // A single summary_id's verification history is small (never anywhere near the pagination cap
    // selectAll exists for), so fetching all of it and filtering/picking in JS is cheap and correct.
    const verResult = await client
      .from('summary_verifications')
      .select('overall,verdicts,model,created_at')
      .eq('summary_id', id)
      .order('created_at', { ascending: false });
    const allVerRows = resolveVerificationRows(verResult);
    // isSupportShapedVerification/isCompletenessShapedVerification: same shape-not-schema
    // discrimination as handleQueue above. Rows are already newest-first, so the first match of
    // each shape is that kind's latest verification.
    const verification = allVerRows.find(isSupportShapedVerification) ?? null;
    // Severity-sorted review queue (2026-08-03): this data has existed in summary_verifications
    // since the completeness axis shipped but was never reachable from this endpoint before —
    // isSupportShapedVerification's own filter discarded it outright.
    const completenessVerification = allVerRows.find(isCompletenessShapedVerification) ?? null;

    sendJson(res, 200, {
      summary: {
        id: summary.id, status: summary.status, body_md: summary.body_md, model: summary.model,
        prompt_version: summary.prompt_version, created_at: summary.created_at, published_at: summary.published_at,
      },
      bill: bill ? { identifier: bill.identifier, title: bill.title, canonical_url: bill.canonical_url } : null,
      text: text ? text.content : null,
      vote,
      verification,
      completeness_verification: completenessVerification,
      missing_provisions: describeMissingProvisions(completenessVerification),
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/review-logic.test.js`
Expected: PASS, all new tests plus every pre-existing test in this file (including the two existing
completeness-badge regression tests at `review-logic.test.js:434-476` — this step must not change
`verified`/`verification` behavior, only add fields).

- [ ] **Step 6: Run the full suite**

Run: `node --test` (from repo root)
Extract the fail count from the `^ℹ fail` line.
Expected: `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/review/server.js tests/review-logic.test.js
git commit -m "feat: sort the review queue by issue_count, surface missing_provisions on item detail"
```

---

### Task 3: Client — render severity in the queue dropdown and item detail

**Files:**
- Modify: `src/review/page.html`

**Interfaces:**
- Consumes: `issue_count`/`missing_provisions` fields on each `/api/queue` item (Task 2); `completeness_verification`/`missing_provisions` fields on the `/api/item/:id` response (Task 2).
- Produces: no new exports (this is inline `<script>` in an HTML file, not a module) — purely a rendering change, verified by manual smoke test (this file has no existing automated test coverage for its inline script; `tests/review-logic.test.js` covers the server side only).

- [ ] **Step 1: Add a `describeIssueCount` label helper and use it in `loadQueue`**

In `page.html`'s inline `<script>`, find `loadQueue` (around line 295). Add this helper function
directly above it:

```javascript
  // describeIssueCount(item) -> a short label suffix. Severity-sorted review queue (2026-08-03):
  // a single-issue item names the ONE thing wrong (a citation-lookup-sized task — knowing what it
  // is is most of the fix); a multi-issue item just gives the count (naming three things in one
  // dropdown line is unreadable — open the item for detail).
  function describeIssueCount(item) {
    if (item.issue_count === null || item.issue_count === undefined) return 'unverified';
    if (item.issue_count === 0) return 'clean';
    if (item.issue_count === 1) {
      const missing = item.missing_provisions && item.missing_provisions[0];
      return missing ? '1 issue: missing "' + missing.section + '"' : '1 issue';
    }
    return item.issue_count + ' issues';
  }
```

Then change the option-label line inside `loadQueue` from:

```javascript
      const label = '[' + it.status + '] ' + (it.bill ? it.bill.identifier : '?') + ' — ' + (it.bill && it.bill.title ? it.bill.title : '');
```

to:

```javascript
      const label = '[' + it.status + '] ' + (it.bill ? it.bill.identifier : '?') + ' — ' + (it.bill && it.bill.title ? it.bill.title : '') + ' (' + describeIssueCount(it) + ')';
```

- [ ] **Step 2: Add a `renderMissingProvisions` function and a container element**

In the HTML skeleton, find `<div id="verification-strip" class="verify-strip verify-unverified"></div>`
(`page.html:107`). Add a sibling element immediately after it:

```html
    <div id="verification-strip" class="verify-strip verify-unverified"></div>
    <div id="missing-provisions"></div>
```

In the inline `<script>`, add this function immediately after `renderVerification` (which ends at
`page.html:293`):

```javascript
  // renderMissingProvisions(missing) — severity-sorted review queue (2026-08-03). This data has
  // existed since the completeness axis shipped but was never rendered by this server before.
  // Renders nothing (not an empty heading) when there's nothing missing — same "don't show empty
  // sections" convention renderVerification already follows for the flagged-bullets list above.
  // Provision/section text is model output and MUST be rendered via textContent, never innerHTML,
  // same rule renderVerification's own comment states for verifier-provided strings.
  function renderMissingProvisions(missing) {
    var container = document.getElementById('missing-provisions');
    container.textContent = '';
    if (!missing || missing.length === 0) return;

    var heading = document.createElement('div');
    heading.className = 'verify-label';
    heading.textContent = 'Missing provisions';
    container.appendChild(heading);

    var list = document.createElement('ul');
    list.className = 'verify-flags';
    for (var i = 0; i < missing.length; i++) {
      var li = document.createElement('li');
      li.textContent = missing[i].section + ': ' + missing[i].provision;
      list.appendChild(li);
    }
    container.appendChild(list);
  }
```

- [ ] **Step 3: Call `renderMissingProvisions` from `loadItem`**

In `loadItem` (`page.html:321-346`), find the line `renderVerification(data.verification || null);`
(`page.html:336`) and add immediately after it:

```javascript
      renderMissingProvisions(data.missing_provisions || []);
```

- [ ] **Step 4: Manual smoke test**

This file has no automated test coverage for its inline script (confirmed in Task 2's own scope —
`tests/review-logic.test.js` covers `server.js` only). Verify by running the review server against
a real (or the dry-run/local) database and confirming in a browser:

Run: `npm run review`
Then open `http://127.0.0.1:8991/` and confirm:
- Queue dropdown options show `(clean)`, `(N issues)`, `(1 issue: missing "...")`, or `(unverified)`
  suffixes, and single-issue items appear before multi-issue ones.
- Opening a completeness-incomplete item shows a "Missing provisions" section under the existing
  verification strip, naming the actual missing section/provision.
- Opening a clean item shows no "Missing provisions" section at all (not an empty one).

- [ ] **Step 5: Run the full automated suite one more time (confirm the HTML edit broke nothing server-side)**

Run: `node --test` (from repo root)
Extract the fail count from the `^ℹ fail` line.
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/review/page.html
git commit -m "feat: render issue severity and missing provisions in the review queue UI"
```

---

## Handoff to Lance (not a task — nothing left for an agent to do)

Nothing. Unlike the bullet-citation-exposure feature, this touches no database schema — it's a pure
application-layer change to the local review server, safe to use immediately after Task 3 lands.
Run `npm run review` and the sorted, labeled queue is live.
