# Identity Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every legislator row linked to a person (auto where unambiguous, Lance-adjudicated where not), so profiles aggregate one human's whole career — per the approved spec `docs/superpowers/specs/2026-07-29-identity-merge-design.md` (Lance's two decisions: virtual merge; auto + flags v3-style).

**Architecture:** cluster pass over all 1,576 legislator rows using src/lib/person-identity.js's proven matcher (both evidence paths: terms rows AND per-source identity columns) → unambiguous clusters create persons + person_links (evidence + decided_by 'auto') and stamp legislators.person_id → ANY ambiguity writes identity_flags and links nothing → Lance's review-tab queue resolves flags (decided_by 'lance') → profiles read by person_id with unlinked rows as single-row persons.

**Tech stack:** existing Node ESM; NO new dependencies; migration 0012 APPLIED live (verified); zero model calls anywhere.

## Global Constraints

- Wrong-merge is the unacceptable error class; missed-merge is benign. ANY ambiguity → flag, link nothing, never guess (the ledgered asymmetric-cost rule).
- display_name is mechanical: bioguide > mo_senate > mo_house > legiscan > openstates printed names, source recorded in display_name_source. Never invented, never edited.
- Additive only: additivePatch for person_id (fills null; a non-null person_id is NEVER overwritten — conflict throws typed); insertIfAbsent/check-then-insert per established patterns; all reads via selectAll (the 1000-row lesson — legislators is at 1,576).
- person_links.evidence carries the matched facts verbatim (names, variant used, chamber/district/era, source key columns present) — the audit IS the product's trust story.
- Typed errors; skip≠empty; honest counts {clusters, personsCreated, linked, flagged, alreadyLinked, singletons}; provenance run_id.
- node:test via bare `node --test` (full suite 809 baseline stays green); fixture-first: the REAL four-Onder shape is the canonical cluster fixture (bioguide 'Onder, Robert F.' — note 'Last, First' form; openstates 'Bob Onder'; mo_senate 'Bob Onder' d2; legiscan 'Robert Onder' nickname 'Bob'); Brown(16)/Brown(26) same-surname-different-people must stay unlinked.
- Commits end: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: Cluster pass + linker CLI

**Files:** Modify `src/lib/person-identity.js` (cluster logic — keep zero-import purity); Create `src/cli/link-persons.js`, `tests/link-persons-cli.test.js`; package.json script `link:persons`.

**Interfaces:**
- Produces: `clusterLegislators(rows) -> { clusters: [{key, memberIds, evidence}], flagged: [{clusterKey, candidateIds, evidence, reason}], singletons: [id] }` (pure, in person-identity.js); `link-persons` CLI `[--dry-run]` — dry-run prints full proposed clustering + counts, zero writes.
- Cluster rule (from the spec + ledgered rulings): candidate pairing on surname/name-variant equality (incl. 'Last, First' reordering and source-printed nicknames) AND compatible chamber/district/era evidence (terms rows and identity columns both count; bioguide federal rows pair with state rows ONLY on name-variant match + non-contradictory era — federal-vs-state chamber difference is NOT a contradiction, it's a career). Anything short of a single coherent cluster → flagged.
- Writes per unambiguous cluster: persons insert (display-name precedence), person_links per member (evidence, decided_by 'auto', run_id), additivePatch person_id per member. Flags: identity_flags via check-then-insert on cluster_key (23505-tolerant). Already-linked rows skipped with honest count.

- [ ] TDD pure parts: the real four-Onder cluster (one person, display_name 'Onder, Robert F.'?? — NO: precedence says bioguide wins but the STORED form is 'Last, First'; normalize display to 'Robert F. Onder' word-reorder ONLY when the bioguide form contains a comma — mechanical reordering of its own printed parts, not invention; test asserts exactly this); Brown(16)+Brown(26) → two singletons never clustered; same-name cross-era senate pair → flagged; already-linked skip; dry-run zero-write.
- [ ] Implement → full suite green → commit `feat: person clustering + linker CLI (auto + flags)`.

### Task 2: Review-server identity tab

**Files:** Modify `src/review/server.js`, `src/review/page.html`; tests.

- Routes: GET /api/identity/queue (unresolved identity_flags, each with candidate rows' full display data: full_name, source key columns, district, era span, cast count via selectAll-safe count queries); POST /api/identity/decision {flag_id, action:'link'|'keep-separate'} — link creates person + person_links (decided_by 'lance', evidence from the flag) + person_id patches, then resolved=true; keep-separate just resolves. CSRF via the existing isAllowedDecisionRequest allowlist; graceful pre-0012 degradation (isMissingRelationError → honest unavailable state); escaping discipline (all DB text via textContent).
- [ ] TDD route logic with fakes (link path writes all three artifacts; keep-separate resolves only; CSRF 403; degradation) → implement → smoke against live DB (queue renders; zero flags is fine pre-linker) → commit.

### Task 3: Live link run + adjudication handoff + docs

- [ ] Live dry-run → REVIEW ITS OUTPUT (clusters/flags/singletons counts sane; Onder cluster present and unambiguous?) → live run → verify: Onder rows share one person_id (or his cluster is in Lance's queue — report which honestly); spot-check 5 random persons' groupings; counts in run detail.
- [ ] Docs checkpoint (TODO 8 closed→adjudication-pending, CHATLOG entry) → commit, push.

### Task 4: Final review + merge menu

- [ ] Whole-branch review (most capable model) → fix wave if needed → merge menu to Lance.

## Self-review notes (write time)

- The four-Onder fixture is REAL live data — Task 1's tests use its exact printed forms (fetched shapes recorded in the test file as literals, not live queries).
- The bioguide 'Last, First' display question is settled IN this plan (mechanical comma-reorder of the printed form) so no task invents policy.
- Cross-state generality (non-MO states' future rows) is out of scope per the spec's YAGNI line; the cluster rule as written doesn't preclude it later.
