### Task 2: Review-server identity tab

**Files:** Modify `src/review/server.js`, `src/review/page.html`; tests.

- Routes: GET /api/identity/queue (unresolved identity_flags, each with candidate rows' full display data: full_name, source key columns, district, era span, cast count via selectAll-safe count queries); POST /api/identity/decision {flag_id, action:'link'|'keep-separate'} — link creates person + person_links (decided_by 'lance', evidence from the flag) + person_id patches, then resolved=true; keep-separate just resolves. CSRF via the existing isAllowedDecisionRequest allowlist; graceful pre-0012 degradation (isMissingRelationError → honest unavailable state); escaping discipline (all DB text via textContent).
- [ ] TDD route logic with fakes (link path writes all three artifacts; keep-separate resolves only; CSRF 403; degradation) → implement → smoke against live DB (queue renders; zero flags is fine pre-linker) → commit.


## CONTROLLER RULINGS (binding, appended)

1. QUEUE SHAPE (live reality): 21 flags — 12 internal_contradiction (incl. two 14-member brown/smith blobs) + 9 ambiguous_era (real dynastic same-seat pairs: bayh, chafee, humphrey, graham, warner, murkowski, bennett, burdick, pryor). The tab must render LARGE clusters reviewably: candidates as a sortable table (name, source keys present, district, era span, cast count), with PER-SUBSET linking — Lance selects 2+ rows within a flag and links just those as one person (a 14-blob may contain several real people plus noise); remaining candidates stay in the flag until it's fully resolved or ruled keep-separate.
2. cluster_key drift (ledgered): a re-run with changed membership creates a NEW flag and orphans the old — the decision route must mark the flag resolved AND the queue must hide flags whose candidate set is entirely person_id-linked already (self-healing display); no schema change.
3. SAVE-BEFORE-DECIDE UX FIX (promised to Lance, glossary tab, same file): decision buttons (approve/reject/publish) must either auto-save a dirty gloss editor first (preferred: one click = save+decide, logged as both actions) or hard-refuse with 'unsaved edits' — pick auto-save; it's what Lance expected twice. Applies to the glossary tab in this same page.html surgery.
4. Link decisions write persons (display-name precedence via pickDisplayName — import it), person_links (decided_by 'lance', evidence from the flag + Lance's selection), person_id patches (conflict-throw path intact); keep-separate resolves the flag with a note. All via the existing CSRF-guarded decision conventions; per-decision audit rows.
5. Graceful pre-0012 degradation (isMissingRelationError → honest unavailable); escaping discipline absolute (all DB text via textContent); selectAll for every multi-row read.
