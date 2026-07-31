### Task 2: terms.state backfill (federal, additive, $0)

**Files:**
- Create: `src/cli/backfill-term-states.js`
- Test: `tests/backfill-term-states.test.js`
- Read (do not modify): `src/adapters/us-congress.js` (member parsing + polite limiter), `src/lib/db.js` (selectAll)

**Interfaces:**
- Consumes: the existing member-metadata parsing in `src/adapters/us-congress.js` (the Task-3-of-profile-completeness code that yielded "429 parties + 437 terms") — reuse its member-list fetch + parse, which already surfaces each member's `state`; do NOT write a parallel parser. Inspect its exports first and reuse the exact function the enrich pass uses.
- Produces: `terms.state` filled (fills-null only) for `jurisdiction_id='us-congress'` rows: house terms get the member's two-letter state code via bioguide exact match; senate terms ALSO get `state` = their existing `district` value (mechanical copy of the state code already stored there). MO terms: `state='MO'` (constant fill for `jurisdiction_id='mo-legislature'`, no fetch).
- CLI: `node --env-file=.env src/cli/backfill-term-states.js [--dry-run]`. Honest counts: `{termsSeen, filled, alreadySet, memberNotFound, gatedMissingColumn}`. Gated on 0016 via the existing `isMissingColumnError`-style detection (fail to honest `gatedMissingColumn` count, exactly like the 0014 gating pattern in `backfill-mo-bill-meta.js`).

- [ ] **Step 1: TDD** — write failing tests off the existing member fixtures (`tests/fixtures/us-congress/` already carries member payloads): state extracted per bioguide; senate term state copied from district; MO constant fill; fills-null (a term with state already set → alreadySet, never overwritten); dry-run writes nothing. Run: `node --test` — new tests FAIL, baseline stays green.
- [ ] **Step 2: Implement** minimal code to green. All reads via `selectAll`; updates only `state` where `state is null` (`.is('state', null)` guard on the update, same TOCTOU discipline as additivePatch call sites).
- [ ] **Step 3: Full suite green, commit** — `git commit -m "feat: terms.state backfill (federal via member metadata, MO constant)"`
- [ ] **Step 4 (controller, after 0016 applied):** dry-run → review counts → live run → verify: Wagner's house term shows `state='MO'`; Pelosi's shows `state='CA'`; a MO senate term shows `state='MO'`.

