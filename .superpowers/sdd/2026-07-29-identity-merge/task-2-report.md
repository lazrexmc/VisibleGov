# Task 2 report — review-server identity tab + glossary save-before-decide fix

Commit: `78b7d56` — feat: identity review tab + glossary save-before-decide fix (Task 2)
Branch: `identity-merge`

## Files changed

- `src/review/server.js` (+342/-1): new Task 2 section — routes, pure helpers, route handlers.
- `src/review/page.html` (+330): identity tab (markup/CSS/JS) + glossary save-before-decide fix.
- `tests/review-logic.test.js` (+707): pure-function tests + fake-client route tests for both.

No migration/schema changes (ruling 2 is explicit: "no schema change"). No changes to
`src/lib/person-identity.js`, `src/cli/link-persons.js`, or `src/lib/db.js` — all three were
studied and imported from, not modified.

## src/review/server.js

**Imports added:** `additivePatch` (from `../lib/db.js`, alongside the existing `getClient`/
`isMissingRelationError`/`selectAll`), `pickDisplayName` (from `../lib/person-identity.js`),
`PersonLinkConflictError` (from `../cli/link-persons.js` — verified safe: link-persons.js only
imports from `db.js`/`person-identity.js`, no circularity, and its own `invokedDirectly` guard
means importing it here never runs its CLI `main()`).

**Design decision — where the display data comes from.** `identity_flags.evidence`, as written by
`link-persons.js`'s `writeIdentityFlag`, is already `{ reason, candidates: [{ legislatorId,
fullName, surnameKeyUsed, sourceKeys, chamberDistrictEra }, ...] }` — a full snapshot of exactly
the evidence that caused the flag. The queue route uses that frozen snapshot as the source of
truth for full_name/source-keys/district/era-span (it IS the audit trail Lance is meant to
adjudicate against), rather than re-deriving from a live `terms`/`legislators` join, which could
silently disagree with the evidence that actually triggered the flag. The ONE thing fetched live
is `person_id` — the one field that legitimately changes between flag-creation and review (an
earlier partial link, or a flag going fully resolved).

**Pure helpers (all exported, all unit-tested):**
- `formatCandidateDistrict(evidenceEntries)` / `formatCandidateEraSpan(evidenceEntries)` — table-
  column-ready summaries over one candidate's `chamberDistrictEra` array. Dedupes identical
  `chamber district` labels but never collapses genuinely different entries into one (that
  inconsistency is the reviewable signal). Missing date bounds render as `?`, never guessed.
- `findCandidateEvidence(flagEvidence, legislatorId)` — pulls one member's frozen evidence out of
  the flag's evidence blob; null-safe, never throws.
- `buildLanceLinkEvidence(candidateEvidence, {flagId, clusterKey, linkedLegislatorIds, note})` —
  ruling 4's "evidence from the flag + Lance's selection": layers `flagId`/`clusterKey`/
  `linkedWith` (excludes the row's own id) / `note` onto that candidate's frozen flag evidence.
- `appendResolution(evidence, resolution, nowIso)` — since `identity_flags` has no notes table and
  ruling 2 forbids a schema change, every decision (link-subset or keep-separate) appends one entry
  to an `evidence.resolutions` array, layered on top of the original `{reason, candidates}` — this
  IS the audit trail for keep-separate (which writes no `person_links` row of its own).
- `validateIdentityDecisionInput({action, legislator_ids, note})` — `link` requires 2+ unique ids
  (ruling 1); `keep-separate` requires a non-empty `note` (ruling 4's "resolves with a note",
  mirroring `validateDecisionInput`'s reject-requires-note convention — keep-separate is the one
  decision with no `person_links` row to explain itself).

**`GET /api/identity/queue`:** `selectAll`s `identity_flags` where `resolved=false`; degrades to
`{available:false, reason:'migration 0012 not applied', items:[]}` (200) via
`isMissingRelationError`, mirroring the glossary tab's ruling-6 pattern. Zero flags returns
`{available:true, items:[]}` — a valid, non-error render. For each flag, `selectAll`s the whole
`legislators` table for `id,person_id` (fetch-all-then-filter-in-JS — the same convention the
glossary queue's own verification lookup uses, deliberately never `.in()` over a possibly-large id
list per that route's own comment on the undici 16KB header cap). A flag is hidden entirely once
every one of its candidates already carries a `person_id` (ruling 2's self-healing display — purely
a read-time filter, the row is never mutated on a read). Per surviving candidate, one
`vote_casts` count query via `.select('id', {count:'exact', head:true}).eq('legislator_id', id)` —
an exact `COUNT` that never fetches a cast row, so it can't hit the 1000-row page cap `selectAll`
guards against ("selectAll-safe" without literally being `selectAll` — chosen over one big
`selectAll`+group-by over what could be a much larger `vote_casts` table, given the brief's plural
"count queries" wording). Response candidates carry `already_linked`/`linked_person_id` so the UI
can show (but disable selection on) already-resolved rows within a still-open flag.

**`POST /api/identity/decision`:** CSRF-guarded via the existing `isAllowedDecisionRequest`
allowlist (same header check every other decision route uses). Body: `{flag_id, action:'link'|
'keep-separate', legislator_ids?, note?}`.

- **`keep-separate`** (whole-flag terminal action): appends a resolution entry, sets
  `resolved:true` on the flag in one `update`. Writes nothing to `persons`/`person_links` —
  verified by a test asserting neither table is touched.
- **`link`** (controller ruling 1, PER-SUBSET): `legislator_ids` is Lance's selection *within* the
  flag, never assumed to be the full candidate set. Validates every id belongs to
  `flag.candidate_legislator_ids` (400 otherwise). Fetches the selected rows live via
  `.in('id', legislator_ids)`, then validates **every** selected row's `person_id` is null
  *before any write happens* (the "conflict-throw path intact" ruling 4 calls for — mirrors
  `writeAutoCluster`'s own all-or-nothing pre-check exactly) — a conflict throws
  `PersonLinkConflictError` (imported from link-persons.js), caught and reported as 409, with zero
  writes performed, verified by a dedicated test. On success: `pickDisplayName(rows)` picks
  `persons.display_name`/`display_name_source` (bioguide > mo_senate > mo_house > legiscan >
  openstates, exactly link-persons.js's precedence); one `persons` insert; per selected row,
  `additivePatch` fills `legislators.person_id` and one `person_links` row is inserted with
  `decided_by:'lance'` and evidence from `buildLanceLinkEvidence`. **Then** — the per-subset
  semantics — it re-fetches `person_id` for the flag's **entire** original
  `candidate_legislator_ids` set (not just this decision's subset) and only sets
  `identity_flags.resolved=true` if literally every original candidate is now linked; otherwise the
  flag stays `resolved:false` with its `evidence.resolutions` audit trail grown by one entry, and
  the untouched candidates remain visible in the queue on the next load. Verified end-to-end by a
  3-candidate-flag test: linking 2 of 3 leaves `resolved:false`, the third candidate's `person_id`
  untouched, and the flag row itself unresolved.

Both routes registered in `requestListener` alongside the existing summary/glossary routes, same
CSRF gate placement.

## src/review/page.html

**Identity tab:** new nav button + `<select id="identity-queue">` + a single full-width pane
(`.pane-identity { flex: 1 1 100%; }` — not the text/draft two-column split the other tabs use,
since there's no single "item," a flag is a cluster reviewed as a table). Renders: heading
(cluster_key) + meta line (`[reason] N candidate(s)`), a sortable `<table>` (checkbox column +
Name/Source keys present/District/Era span/Cast count, click-header-to-sort with a ▲/▼ indicator,
client-side `Array.sort` over the in-memory candidate list — no extra round trips), a note textarea,
and Link/Keep-separate buttons. Already-linked candidates render dimmed (`.already-linked`) with a
disabled checkbox and an "(already linked)" suffix, but stay visible for context. "Link selected"
is disabled until 2+ checkboxes are checked; "Keep separate" client-side-refuses an empty note
before even hitting the network (server still enforces it independently). Every cell is built via
`document.createElement` + `textContent` — no `innerHTML` anywhere in the new code, matching the
escaping discipline the other two tabs already follow. Handles the `available:false` (pre-0012)
and empty-queue (zero flags) states as distinct, honest placeholder renders, not errors.

**Glossary save-before-decide fix (controller ruling 3):** added `lastLoadedGlossMd` (the last
value actually loaded from or saved to the server) and `currentGlossaryStatus`, both set in
`loadGlossaryItem`/reset in `showGlossaryUnavailable`. New `glossaryEditIsLegal(status)` checks
whether `'edit'` is in `GLOSSARY_STATUS_ACTIONS[status]` (true only for draft/stale) — used to (a)
set `glossary-edit`'s `readOnly` attribute in `updateGlossaryActionButtons` so a term in a
non-editable state (approved/rejected/published) can never go "dirty" with nowhere legal to save,
and (b) gate the new `autoSaveGlossaryEditIfDirty()` helper. `postGlossaryDecision(action)` now
calls that helper before any non-`edit` action: if the textarea's live value differs from
`lastLoadedGlossMd` and editing is still legal, it fires its own `action:'edit'` POST first (its
own `glossary_notes` audit row), updates `lastLoadedGlossMd` on success, and only then proceeds
with the originally-requested decision — "one click = save+decide, logged as both actions," the
preferred fix per ruling 3. If the auto-save itself fails (network error or a rejected edit), the
function returns `false` and `postGlossaryDecision` bails out entirely rather than deciding against
a value that was never actually persisted — the dirty edit is left exactly as Lance typed it, never
silently discarded and never silently applied without being saved. The summary tab (which has the
identical `draft-edit`/`btn-save-edit` shape) was deliberately left untouched — ruling 3 scopes this
fix to "the glossary tab in this same page.html surgery" only.

## Tests (tests/review-logic.test.js)

Added under a new `Task 2` banner section, following the file's existing TDD-with-fakes convention
(no live DB writes from tests, per the hard rule):
- Pure-function unit tests for all six new exports (`formatCandidateDistrict`,
  `formatCandidateEraSpan`, `findCandidateEvidence`, `buildLanceLinkEvidence`, `appendResolution`,
  `validateIdentityDecisionInput`).
- A purpose-built `identityFakeClient` (distinct from the file's existing generic `fakeClient` —
  the identity routes need per-id variation from the same table within one request: a cast count
  per candidate, a live `person_id` per candidate, a targeted `legislators` lookup by a specific id
  subset — the existing fixed-canned-result fake can't express that) covering `identity_flags`
  (selectAll + targeted `maybeSingle` + `update`), `legislators` (whole-table selectAll + targeted
  `.in()` + `update`), `vote_casts` (per-id `count:exact,head:true`), `persons` (`insert().select()
  .single()`), `person_links` (`insert`).
- Route tests: queue degradation (pre-0012), empty queue, no-client 500, happy path (asserts every
  field: full_name/source_keys/district/era_span/cast_count), self-healing hide (fully-linked flag
  vanishes), partial-link display (some-linked flag stays, per-candidate `already_linked` correct);
  decision CSRF (text/plain + foreign Origin → 403), degradation, validation (missing flag_id,
  link<2 ids, keep-separate without note), 404 (unknown flag, ghost legislator id), 400
  (already-resolved flag, already-resolved flag, outsider legislator_id); keep-separate happy path
  (resolves + note in `evidence.resolutions`, zero persons/person_links writes — asserted via call
  recorder); link happy path (persons insert with correct display-name precedence — bioguide beats
  mo_senate on the real Onder-shaped fixture, legislators.person_id patches, person_links rows with
  `decided_by:'lance'` and the right `linkedWith` exclusion, flag resolves); **per-subset link**
  (3-candidate flag, link 2 → `resolved:false`, third candidate's `person_id` stays null, flag row
  stays unresolved — the ruling-1 semantics' own dedicated test); conflict-throw (a selected
  legislator already linked elsewhere → 409, zero writes to persons/person_links, and the OTHER
  selected (non-conflicting) row is also never written — proving the whole decision aborts before
  any write, not a partial one).

127 tests in this file (up from ~90 before); 891/891 full suite.

## Smoke evidence (live, read-only)

Started `node --env-file=.env src/review/server.js` against the real Supabase instance (had to kill
a stale process already holding port 8991 from earlier work first).

- `GET /` → 200; response body confirmed to contain `tab-identity` and `identity-btn-link` (the new
  tab markup is actually served).
- `GET /api/glossary/queue` → unrelated-tab regression check, still 200 with real data (unaffected).
- `GET /api/identity/queue` → `200 {"available":true,"items":[]}`.

Verified this is the correct, expected state — not a bug — with a direct read-only count query
against `identity_flags` (`select('id,resolved', {count:'exact'})`): **0 total rows**. Every Task 1
run against the live DB so far was `--dry-run` (per progress.md's own words, "live dry-run"), so
nothing was ever actually written to `identity_flags`/`persons`/`person_links` live yet. `available:
true` with `items: []` correctly proves migration 0012 is applied (a missing-relation error would
have produced `available:false` instead) and the route's full selectAll/degradation/self-healing
logic ran cleanly end-to-end with zero live rows to process — exactly the "queue may be empty —
zero flags is a valid render" case the task anticipated. Server was stopped afterward; port 8991
confirmed clear (no lingering process).

## Concerns

1. **Untested against a real 21-flag live queue.** The route logic is proven correct against fakes
   (including the exact per-subset/self-healing/conflict semantics) and confirmed reachable live,
   but since `identity_flags` is currently empty, the happy-path queue rendering has never been
   exercised against real data shaped like the two 14-member brown/smith blobs or the 9 real
   dynastic ambiguous_era pairs. Once Lance runs `link:persons` for real (writes, not `--dry-run`),
   the queue and its self-healing/cast-count behavior should get one live look before he starts
   adjudicating in earnest.
2. **Per-candidate `vote_casts` count queries are sequential and could be ~70-90 round trips** on
   the documented live queue shape (2×14-member blobs + the rest). Fine for a single-operator
   admin page loaded occasionally; would need batching (e.g. an RPC or a full-table selectAll+
   group-by) if this ever needs to feel snappier or the candidate pool grows much larger.
3. **`note` is optional on `link`** (only required for `keep-separate`) — a deliberate choice
   (link's real audit is the `person_links` row itself), but worth Lance's explicit sign-off since
   ruling 4 only explicitly named keep-separate's note as required.
4. The summary tab has the same save-before-decide gap the glossary tab had; left untouched per
   ruling 3's explicit scoping to "the glossary tab in this same page.html surgery" — flagging in
   case that scoping was meant narrower than intended.

## Fix round 1

Commit: `9aad0f9`. Addresses one IMPORTANT finding, one ruled scope extension, and two minors from
review.

**IMPORTANT — no test at documented real scale.** Added a single, comprehensive test in
`tests/review-logic.test.js` ("14-candidate flag: queue render ... -> link 2 -> link 2 more ->
keep-separate the other 10 -> flag fully resolved") matching controller ruling 1's documented live
shape (a 14-member brown/smith blob). It drives the full multi-decision lifecycle against one
`identityFakeClient` instance across four sequential requests and asserts non-vacuously at every
step: (1) queue render — all 14 candidates present, with three individually spot-checked
(`full_name`/`source_keys`/`district`/`era_span`/`cast_count` — distinct, varied values per
candidate, not a repeated fixture); (2) first subset link (leg-01, leg-02) — exactly those two
`legislators.person_id` patches happen (`persons.insert` x1, `legislators.update` x2,
`person_links.insert` x2), the other 12 individually confirmed still null, `resolved:false`; (3) a
second, independent subset link (leg-03, leg-04) — a genuinely different `person_id` from the
first (this caught a real bug — see below), the first subset's link left untouched, the remaining
10 still null, flag still unresolved with 2 resolutions logged; (4) terminal `keep-separate` on the
remainder — flag becomes `resolved:true`, the audit entry names exactly the 10 still-unlinked ids
(not the original 14), zero `persons`/`person_links` writes; (5) the now-fully-resolved flag is
gone from a fresh queue fetch. Building this test caught a real bug in the test fixture itself:
`identityFakeClient`'s `persons.insert` returned a single fixed canned id regardless of how many
times it was called, so two independent link decisions within one test would have silently
collapsed onto the same "person" — fixed by scoping an insert counter at the client level (persists
across the whole client's lifetime, generating a fresh id per actual insert call), the way real
Supabase would.

**RULED SCOPE EXTENSION — summary tab auto-save port.** `src/review/page.html`'s `postDecision`
(the summary tab's approve/reject/publish handler) now mirrors `postGlossaryDecision` exactly:
`lastLoadedBodyMd`/`currentSummaryStatus` tracked from `loadItem`; `summaryEditIsLegal(status)`
mirrors `glossaryEditIsLegal`; `draft-edit`'s `readOnly` toggles with it; a new
`autoSaveSummaryEditIfDirty()` auto-saves a dirty draft as its own `edit` decision before any
non-edit action, aborting the whole decision (leaving the edit untouched) if the auto-save itself
fails. To actually prove this (and the original glossary fix, which had no dedicated test of its
own either) works end-to-end rather than just reading as mechanical, added `jsdom` as this
project's first devDependency and `tests/review-page-decisions.test.js`: it loads the REAL
`page.html` file into a jsdom window (`runScripts:'dangerously'`, so the actual inline `<script>`
executes) with a mocked `fetch`, reaching into the script via a small, explicit, inert-in-production
test hook added at the very end of the script
(`if (typeof window.__registerTestHooks === 'function') window.__registerTestHooks({...})`) that
exposes `loadQueue`/`postDecision`/`loadGlossaryQueue`/`postGlossaryDecision` and two state getters.
Eight tests (four per tab, deliberately mirrored): dirty edit auto-saves first (two ordered POSTs,
tracked state advances); clean edit fires only the requested decision (no auto-save call); a
rejected auto-save aborts the whole decision (the requested action is never sent, the edit stays
exactly as typed, tracked state does not advance); a dirty edit on a non-editable status
(`approved`) never attempts an auto-save and the textarea is confirmed `readOnly` (with a
deliberate readOnly-bypass to prove `postDecision`'s own status gate — not just the UI affordance —
is what actually protects this). One real gotcha surfaced building this: `getSummaryState()`/
`getGlossaryState()`'s returned objects are constructed inside jsdom's own vm realm, so
`assert.deepEqual` against a plain object literal false-fails on cross-realm prototype identity
("same structure but are not reference-equal") even though the values are correct — fixed by
comparing fields individually with `assert.equal` (primitive string comparison, realm-agnostic).

**MINOR 1 — keep-separate audit precision.** `identity_flags.evidence.resolutions[].legislatorIds`
for a `keep-separate` decision now records the ACTUAL still-unlinked candidate ids (a live
`legislators.person_id` lookup at decision time, factored into a new shared
`fetchPersonIdsForCandidates(client, candidateIds)` helper — also now used by the `link` path's own
"is the whole flag resolved yet" check, replacing its previous inline duplicate of the same query)
rather than the literal string `'all'`. Matters when an earlier partial link already closed out
some of the flag's candidates before a later keep-separate closes out the rest — the audit trail
now says precisely which ids THIS decision covered. Updated the existing keep-separate happy-path
test to a 3-candidate flag with one pre-linked candidate, asserting the recorded ids are exactly the
two still-open ones, not all three; the new 14-candidate test exercises the same precision at real
scale (10 recorded, not 14).

**MINOR 2 — literal 503.** The `POST /api/identity/decision` pre-0012 degradation test now asserts
`res.status === 503` (the actual, deliberate status this route returns for a missing-relation error
— distinct from the GET queue route's own 200-by-design degradation) instead of the looser
"not 500, not 403".

**Note-optional-on-link:** no change — the controller accepted the original reading (`person_links`
rows are themselves the audit trail for `link`; only `keep-separate` has no other record of why).

Verification: `node --test` full suite 900/900 (853 original baseline + 38 from the first Task 2
round + 1 fourteen-candidate lifecycle test + 8 new jsdom decision-flow tests). Live read-only
smoke re-run after these changes: server boots clean, `GET /` still serves the identity tab markup,
`GET /api/identity/queue` still returns `{"available":true,"items":[]}` against the real (still-
empty) `identity_flags` table — no regression from the `fetchPersonIdsForCandidates` refactor or
the keep-separate query addition. `npm audit` shows one pre-existing moderate advisory in
`fast-xml-parser` (a production dependency, unrelated to this change); `jsdom` itself added none.
