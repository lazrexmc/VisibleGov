# Task 6 report: review-server glossary queue

Status: **DONE**

## What was built

### `src/review/server.js`

Extended the existing summary review server with a parallel glossary review queue, reusing every
shared piece of logic rather than duplicating it (controller ruling 2: "same TRANSITIONS-table
pattern"):

- **Reused unchanged**: `nextStatus`/`TRANSITIONS`, `mapNoteAction`/`NOTE_ACTION`,
  `resolveVerificationRows` (already took a `table` param — passed `'glossary_verifications'`),
  `isAllowedDecisionRequest` (header-based CSRF guard, route-agnostic), `QUEUE_STATUSES`.
- **New pure functions** (exported, unit-tested):
  - `validateGlossaryDecisionInput({action, gloss_md, note})` — mirrors `validateDecisionInput`'s
    rules (edit requires content, reject requires note) with `gloss_md` in place of `body_md`.
    Kept as a distinct function rather than genericizing the field name, so
    `validateDecisionInput`'s existing contract/tests/error text stay untouched.
  - `glossVerificationBadge(verification)` and `verificationBadge(verification)` now both call a
    shared private `deriveVerificationBadge(verification, noun)` — same mechanical
    clean/flagged/unverified derivation, but the glossary variant says "sentences" (glosser.js's
    verdicts index gloss sentences, not summary bullets) instead of "bullets", keeping the label
    domain-honest.
  - `latestVerificationByTerm(rows)` and `latestVerificationBySummary(rows)` now both call a
    shared private `latestVerificationByKey(rows, keyField)` — same "latest wins" pattern, keyed
    by `term_id` vs `summary_id`.
  - `isPublishCompletenessViolation(error)` — recognizes Postgres SQLSTATE 23514 naming the
    `glossary_terms_published_complete` constraint specifically (not any other CHECK on the
    table), so the decision handler can respond with its own safe, clear message instead of
    either swallowing the error or letting the raw Postgres text leak past the
    no-upstream-error-strings-reach-the-page discipline that `sendServerError` already enforces.
- **New route handlers**: `handleGlossaryQueue`, `handleGlossaryItem`, `handleGlossaryDecision` —
  structurally identical to `handleQueue`/`handleItem`/`handleDecision`, with one addition each
  doesn't have: a top-level `isMissingRelationError(err, 'glossary_terms')` catch, since
  (unlike `summaries`, which has existed since migration 0001) `glossary_terms` itself may not
  exist yet. On that specific error:
  - `GET /api/glossary/queue` → `200 {available:false, reason:"migration 0007 not applied", items:[]}`
  - `GET /api/glossary/item/:id` → `200 {available:false, reason:"migration 0007 not applied"}`
  - `POST /api/glossary/decision` → `503 {error:"migration 0007 not applied"}`
  All three never 500 on a missing-migration state, and any *other* DB error still throws through
  to the generic 500 funnel (no blanket swallowing).
  `handleGlossaryDecision`'s publish path: if the `glossary_terms` update fails with
  `isPublishCompletenessViolation`, responds `400 {error:"cannot publish: term is missing
  gloss_md, source_url, or source_hash"}` instead of falling into the generic 500 — the DB CHECK
  fires honestly rather than being pre-filtered away silently (ruling 2's explicit requirement).
- **New routes** in `requestListener`: `GET /api/glossary/queue`, `GET
  /api/glossary/item/:id`, `POST /api/glossary/decision` — the POST route is gated by the exact
  same `isAllowedDecisionRequest(req.headers)` CSRF check as `/api/decision` (that function is
  header-based, not route-specific; "extending the route allowlist" meant adding this new
  pathname to the router's own gated-route list, which is what happened).

Response shapes:
- Queue item: `{id, status, term, kind, citation, needs_mapping, has_gloss, created_at, verified}`
- Item detail: `{available, term: {id,term,kind,citation,gloss_md,supported_by_quote,source_url,
  status,needs_mapping,created_at,published_at}, verification}`
- Decision payload: `{term_id, action, gloss_md?, note?}` → `{status}` on success.

### `src/review/page.html`

Added a second tab ("Glossary") alongside the existing "Summaries" tab, sharing the header and
`#status-msg` line. Structure mirrors the summary pane's two-pane layout exactly:

- Left pane: term heading (term + kind), the **exact** background label string from ruling 4
  ("Background — from the referenced law's official text"), citation (or a `[needs mapping]`
  badge when `citation` is null and `needs_mapping` is true), and the `source_url` as a real
  `<a target="_blank" rel="noopener noreferrer">` link (or "No source on file yet.").
- Right pane: a verification strip (`glossVerificationBadge`, "sentences" wording, mirrored
  client-side the same way `verificationBadge` already was for summaries), the gloss text, the
  author model's claimed supporting quote (labeled "Author model's claimed supporting quote:"),
  an editable gloss textarea, a note textarea, and Save Edit / Approve / Reject / Publish
  buttons.
- Escaping discipline (ruling 5): every model-authored or DB-sourced string — `term`, `kind`,
  `citation`, `gloss_md`, `supported_by_quote`, `source_url`, verifier `reason`/`evidence_quote`
  — is set via `.textContent` or `document.createElement` + `.textContent`, never
  `.innerHTML`. Unlike the summary pane's `body_md` (which goes through a small
  bold/bullet-to-HTML markdown renderer, itself HTML-escaping first), `gloss_md` is always plain
  text per the brief, so it renders via `.textContent` directly — no markdown path.
- Button visibility: `updateGlossaryActionButtons(status, hasGloss)` mirrors
  `updateActionButtons(status)`'s status-gating (draft/stale → edit/approve/reject; approved →
  publish/reject) and additionally hides Publish when `hasGloss` is false — the client-side half
  of ruling 2's "queue SHOULD only offer publish on glossed+verified terms"; the server's CHECK
  constraint is the actual enforcement backstop if this filter is ever wrong.
- Graceful degradation: `showGlossaryUnavailable(reason)` renders the `{available:false}` state
  plainly (heading "Glossary unavailable", the reason text, empty verify strip, all action
  buttons hidden) instead of a blank or broken pane.
- Title changed from "VisibleGov — Summary Review" to "VisibleGov — Review" (still matches the
  existing test's `/<title>VisibleGov/` regex).

## Tests

`tests/review-logic.test.js`: added 31 new tests (imports extended with
`validateGlossaryDecisionInput, glossVerificationBadge, latestVerificationByTerm,
isPublishCompletenessViolation`). Also extended the file's shared `fakeQuery`/`fakeClient` test
helper with `update`/`insert` chain methods (previously only reads were exercised by any test in
this file; the new happy-path decision tests needed writes).

Coverage:
- `validateGlossaryDecisionInput`: 6 cases (edit without/with gloss_md, reject without/with note,
  approve/publish don't require note, unknown action).
- `glossVerificationBadge`: null/clean/flagged, same 3-case shape as `verificationBadge`'s tests.
- `latestVerificationByTerm`: latest-wins + empty/absent input, mirrors
  `latestVerificationBySummary`'s tests.
- `isPublishCompletenessViolation`: true for the exact constraint, false for a different CHECK
  violation, false for an unrelated error, false for null/undefined.
- CSRF route allowlist: `/api/glossary/decision` 403s on `text/plain` and foreign Origin, passes
  through on `application/json` + no Origin — same three cases as the existing `/api/decision`
  tests.
- Degradation (ruling 6): queue/item/decision all verified non-500 with an honest
  `available:false`/`error` payload when `glossary_terms` is missing; a dedicated regression test
  confirms `GET /api/item/:id` (the *summary* route) still returns 200 when `glossary_terms` is
  missing, proving the two queues don't interfere.
- Happy path: queue returns `term/kind/citation/needs_mapping/has_gloss/verified` correctly,
  including the missing-`glossary_verifications`-degrades-to-unverified case; item returns the
  full term + latest verification, and 404s for an unknown id; decision does approve
  (draft→approved) with a correctly-mapped `glossary_notes` insert, edit (patches `gloss_md`, not
  `body_md` — asserted explicitly), illegal-transition 400, unknown-id 404, and the
  publish-completeness-CHECK-surfaced-as-400 case (built a bespoke chainable fake client for this
  one test, since it needed the `update().eq()` call specifically to return the constraint-error
  shape while `select().eq().maybeSingle()` on the same table returns a normal row).

Full suite: **392/392 passing** (361 baseline + 31 new). Verified with bare `node --test`
(no directory arg, per this repo's own Node 24/Windows PLAYBOOK_DELTA lesson) before and after
every edit — confirmed the new tests genuinely failed pre-implementation (`SyntaxError: ... does
not provide an export named 'glossVerificationBadge'`) before writing the server code that makes
them pass.

## Smoke test (live, against the real Supabase DB, migration 0007 NOT applied)

Started the server with `node --env-file=.env src/review/server.js` against the actual `.env`
(real `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, same DB the project has been live-verifying
against all along). All checks below are read-only or CSRF/degradation probes — nothing was
approved, edited, rejected, or published on live data during this smoke test.

**(a) Summary queue still works:**
```
GET /api/queue -> 200, returned the live queue (HR 8884, HCONRES 89, SJRES 180, HR 7008, ... 20+
  draft summaries with bill identifiers/titles and verified:"clean" badges)
GET /api/item/fe4cab8e-... -> 200
```
Confirmed visually in a real browser (Playwright): the Summaries tab loaded HR 8884, rendered the
bill text, vote strip ("On Passage — Passed — Yea 232, Nay 188"), the "Verifier found all 7
bullets supported" clean verification strip, the rendered draft with all 7 bullets, and the
Save Edit/Approve/Reject buttons — unchanged from pre-Task-6 behavior.

**(b) Glossary tab renders the honest pre-0007 degradation state:**
```
GET /api/glossary/queue -> 200 {"available":false,"reason":"migration 0007 not applied","items":[]}
GET /api/glossary/item/nonexistent -> 200 {"available":false,"reason":"migration 0007 not applied"}
POST /api/glossary/decision {term_id:"nonexistent",action:"approve"} -> 503 {"error":"migration 0007 not applied"}
```
Confirmed visually in the browser (screenshot at
`C:\Users\lance\AppData\Local\Temp\claude\f--VisibleGov\8ecd5d8c-3ac4-4f57-a519-cc6433ecd495\scratchpad\smoke-glossary-tab-degraded.png`):
clicking the Glossary tab shows heading "Glossary unavailable", the exact background label
"Background — from the referenced law's official text", the reason text "migration 0007 not
applied" in place of the citation, a grey "Unverified" strip, and all four action buttons
correctly hidden (no way to attempt a decision on nothing). Switched back to the Summaries tab
afterward — round-tripped cleanly, no new console errors (only a pre-existing, unrelated
`favicon.ico 404`, present both before and after the tab switch).

**(c) No 500s observed anywhere** — every glossary-route probe returned 200/403/503 as designed;
zero 500s across the whole smoke session (summary routes included).

CSRF guard live-verified on both routes without mutating anything: `POST /api/decision` and
`POST /api/glossary/decision` with `Origin: https://evil.example` both returned `403`.

## Concerns

- **No live `glossary_terms` data existed to smoke-test the happy path (queue with real terms,
  approve/reject/publish transitions, the publish-completeness CHECK actually firing).**
  Migration 0007 is deliberately not applied yet per the task's own instructions ("this is your
  live smoke case" for the degraded state) — the happy-path server logic is covered by the fake-
  client unit tests above, but has not been exercised against a real Postgres CHECK constraint or
  real `glossary_verifications` rows. This is expected and matches the task's design (Task 6 ships
  before 0007 is applied), not a defect — flagging so Lance knows the happy path's *first* real
  exercise will be after he applies 0007 and Task 5's `gloss` CLI populates some rows.
- **`503` for `POST /api/glossary/decision` when `glossary_terms` is missing is a status-code
  choice I made** (not specified verbatim in the brief/rulings — ruling 6 only requires "never a
  500"). Chose 503 (Service Unavailable) over the queue/item routes' `200 {available:false}`
  shape because a POST that could not act on anything shouldn't read as a 200 success; happy to
  change if Lance prefers a different convention once he sees it live.
- Two IDE lint warnings ("CSS inline styles should not be used") on the two new
  `style="display:none"` attributes in `page.html` — matches the existing codebase's convention of
  JS-driven `style.display` toggling (no external CSS file exists in this project); not treated as
  a real issue.

## Files touched

- `F:\VisibleGov\src\review\server.js` — glossary route handlers + shared pure-function refactors
- `F:\VisibleGov\src\review\page.html` — glossary tab UI
- `F:\VisibleGov\tests\review-logic.test.js` — 31 new tests + `fakeQuery` update/insert support
