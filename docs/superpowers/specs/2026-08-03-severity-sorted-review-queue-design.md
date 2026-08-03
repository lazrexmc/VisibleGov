# Severity-sorted review queue — design

**Status:** approved (Lance, 2026-08-03: "Move forward with the project and complete it from spec
to implementation").

## Why

Lance's 98-item summary review queue (`src/review/server.js`, local staff review page) is currently
a plain `<select>` dropdown, ordered by `created_at`, showing nothing about WHY an item is flagged
or how much work it needs. Two real gaps, not just a missing sort:

1. **Completeness data is completely unreachable from this server.** `handleQueue` and `handleItem`
   both filter verification rows through `isSupportShapedVerification` — deliberately, so a
   completeness row's `{key_provisions, coverage}` shape never gets fed to
   `deriveVerificationBadge`, which expects an array of bullet verdicts. But nothing on the OTHER
   side ever reads the completeness row either. A summary flagged only for a missing provision (the
   single-issue case this whole feature exists to surface first) shows up in this server with no
   indication of what's actually wrong — Lance would have to go find the raw DB row himself.
2. **No severity signal at all.** The queue is one flat list in `created_at` order. A summary with
   one missing citation and a summary with five unsupported bullets look identical until opened.

This closes both: expose completeness data for the first time, and sort/label the queue by how much
work each item actually needs, so the single-issue ones (a citation-lookup-sized task) surface
first.

## Design

### 1. Pure logic additions (`src/review/server.js`)

**`isCompletenessShapedVerification(row)`** — the missing counterpart to the existing
`isSupportShapedVerification`, same shape-not-schema discrimination style already established in
this file (that function's own comment explains why: draft-then-apply migrations mean this code
must work whether or not a schema-level `kind` column exists yet, so rows are told apart by their
own data shape, not trusted metadata). A completeness row's `verdicts` is
`{key_provisions: [...], coverage: [...]}` — never an array itself (a support row's `verdicts` IS an
array). Definition:

```javascript
export function isCompletenessShapedVerification(row) {
  const verdicts = row?.verdicts;
  if (!verdicts || Array.isArray(verdicts)) return false;
  return Array.isArray(verdicts.coverage);
}
```

**`computeIssueCount(supportVerification, completenessVerification)`** — pure, returns a number or
`null`:

- `null` when NEITHER verification exists (nothing to count — an honestly-unverified item, distinct
  from zero issues).
- Otherwise: `(unsupported bullet count from supportVerification, 0 if absent) + (missing provision
  count from completenessVerification, 0 if absent)`.

Sorting rule: items with a numeric issue count sort ascending (fewest issues first — the stated
goal). Items with `null` (unverified) sort **after every numeric item**, never first — an unverified
item needs a full check run, not a quick fix, so surfacing it first would contradict the feature's
own purpose (fastest wins first).

**`describeMissingProvisions(completenessVerification)`** — pure, returns an array of
`{section, provision}` objects (empty array if no completeness row, or if none are missing) by
reading `completenessVerification.verdicts.coverage`, filtering `covered === false`, and mapping to
`{section: coverage_entry's provision.section, provision: ...provision text}` via the matching
`key_provisions[provision_index]` entry (same indexing `assessCompleteness` in `src/lib/verifier.js`
already uses — reused conceptually, not imported, since this is display logic over already-verified
data, not a fresh trust judgment).

### 2. `handleQueue` — fetch completeness rows, compute severity, sort

Currently fetches only support-shaped verification rows via `selectAll` + an in-JS
`isSupportShapedVerification` filter (`server.js:347-351`). Add a second pass over the SAME
`selectAll` result (no new DB round-trip — one `summary_verifications` read already covers both
kinds) filtered through `isCompletenessShapedVerification`, build a second
`latestVerificationBySummary`-keyed map for it (the existing generic `latestVerificationByKey` /
`latestVerificationBySummary` helpers already handle any row shape — no changes needed there).

For each queued summary, compute `issueCount = computeIssueCount(supportMap.get(id),
completenessMap.get(id))` and `missing = describeMissingProvisions(completenessMap.get(id))`. Sort
the response array: numeric issue counts ascending, `null` last (stable sort — ties keep their
existing `created_at` order, so this is a refinement of the current order, not a replacement for
it). Response payload per item gains `issue_count` (number or `null`) and `missing_provisions`
(array, possibly empty) alongside the existing `id/status/created_at/bill/verified` fields —
additive, nothing existing removed or renamed.

### 3. `handleItem` — surface completeness detail for the opened item

Currently fetches the item's verification rows already (`server.js:406-410`, no `.limit(1)`,
deliberately — see that code's own comment about completeness rows sorting first by `created_at`)
but discards everything through `isSupportShapedVerification` (`:414`). Add the same
`isCompletenessShapedVerification` filter to get the latest completeness row too (first match, since
rows are already `created_at` descending), and include it in the response as a new
`completeness_verification` field (whole row: `overall, verdicts, model, created_at` — the
`page.html` template renders exactly the fields it needs, same pattern as the existing
`verification` field) plus a pre-computed `missing_provisions` array (same
`describeMissingProvisions` function, reused, not re-implemented client-side).

### 4. Client (`src/review/page.html`)

**Queue dropdown population** (currently renders each option as roughly the bill identifier —
`page.html:295-319`): extend the label to include severity when known:
`"HR 1234 — 1 issue: missing 'judicial review' provision"` for a single-issue item (named directly,
since naming the ONE thing wrong is exactly what makes a single-issue item fast to act on),
`"HR 1234 — 3 issues"` for multi-issue (no attempt to cram three named issues into one line — open
the item for detail), `"HR 1234 — unverified"` for the `null` case. Options render in the order the
server already sent them (no client-side re-sort — the server did that in step 2).

**Item detail pane**: alongside the existing per-bullet verdict rendering (`page.html:277-290`), add
a "Missing provisions" section that renders when `missing_provisions` is non-empty — each entry
shown as its section + provision text, matching the plain, factual, no-editorializing rendering
style the bullet-verdict section already uses. Renders nothing (not an empty heading) when there's
nothing missing, matching this page's existing "don't show empty sections" convention.

### 5. Non-goals

- No change to the decision/action model. `approve`/`reject`/`edit`/`publish` and their legal
  transitions (`TRANSITIONS`, `server.js:45-49`) are untouched — this is visibility and ordering
  only.
- No change to `QUEUE_STATUSES` or which summaries appear in the queue at all.
- No rebuild of the queue UI into a table (considered and explicitly declined — the stated need is a
  fixed severity order, not interactive re-sorting; a table is more than this need requires).
- No LLM/API calls — this is pure display of data already computed and stored during verification.

## Testing

`tests/review-logic.test.js` already has exactly the right harness for this: `withServer`/
`fakeClient`/`fakeQuery` drive `handleQueue`/`handleItem` through a real HTTP round trip against a
fake Supabase-shaped client (no live DB), and `SUPPORT_ROW`/`COMPLETENESS_ROW` fixtures already
exist for the exact "both kinds share one table, completeness sorts newer" scenario this feature
extends. Reuse both — extend the fixtures (an unsupported-bullet variant, an incomplete-coverage
variant), don't reinvent the harness.

- **Pure functions**, unit-tested directly (same style as the existing `verificationBadge`/
  `latestVerificationBySummary` tests just above them in the file):
  - `computeIssueCount`: no verification at all → `null`; support-only with N unsupported → N;
    completeness-only with M missing → M; both present → sum; both present, zero issues on either
    axis → correct partial sum (e.g. support clean + completeness incomplete → just the
    completeness count, not a false zero).
  - `isCompletenessShapedVerification`: a real completeness row → true; a real support row → false
    (array `verdicts`); malformed/absent → false, never throws.
  - `describeMissingProvisions`: no completeness row → `[]`; a complete (nothing missing) row →
    `[]`; an incomplete row → the correct subset of `key_provisions`, matched via `coverage`'s
    `provision_index`, never mismatched by array position alone (mirrors `assessCompleteness`'s own
    indexing discipline in `src/lib/verifier.js`).
- **HTTP-level, via `withServer`/`fakeClient`** (extending the existing test block around
  `SUPPORT_ROW`/`COMPLETENESS_ROW`, `review-logic.test.js:415-476`):
  - `GET /api/queue` with three summaries whose fixture rows carry 0, 1, and 3 issues respectively
    (mixed order in the fake `summary_verifications` data) → response array comes back sorted
    ascending by issue count, each item carrying its own `issue_count`.
  - `GET /api/queue` with one summary that has no verification row at all, alongside summaries that
    do → the unverified one sorts LAST, `issue_count: null`.
  - `GET /api/queue`: ties (equal issue counts) preserve their existing `created_at` order — this is
    a stable refinement of the current order, not a replacement.
  - `GET /api/item/:id` with a completeness-incomplete fixture → response includes
    `missing_provisions` naming the correct section/provision text.
  - `GET /api/item/:id` with a completeness-complete (or absent) fixture → `missing_provisions` is
    `[]`, not omitted (consistent field shape regardless of state).
  - Regression: the existing "later completeness row never wins the badge" tests
    (`review-logic.test.js:434-476`) must still pass unmodified — this feature adds fields, it does
    not change `verified`/`verification` behavior.
