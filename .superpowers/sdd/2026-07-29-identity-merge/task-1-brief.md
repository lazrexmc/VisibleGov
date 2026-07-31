### Task 1: Cluster pass + linker CLI

**Files:** Modify `src/lib/person-identity.js` (cluster logic — keep zero-import purity); Create `src/cli/link-persons.js`, `tests/link-persons-cli.test.js`; package.json script `link:persons`.

**Interfaces:**
- Produces: `clusterLegislators(rows) -> { clusters: [{key, memberIds, evidence}], flagged: [{clusterKey, candidateIds, evidence, reason}], singletons: [id] }` (pure, in person-identity.js); `link-persons` CLI `[--dry-run]` — dry-run prints full proposed clustering + counts, zero writes.
- Cluster rule (from the spec + ledgered rulings): candidate pairing on surname/name-variant equality (incl. 'Last, First' reordering and source-printed nicknames) AND compatible chamber/district/era evidence (terms rows and identity columns both count; bioguide federal rows pair with state rows ONLY on name-variant match + non-contradictory era — federal-vs-state chamber difference is NOT a contradiction, it's a career). Anything short of a single coherent cluster → flagged.
- Writes per unambiguous cluster: persons insert (display-name precedence), person_links per member (evidence, decided_by 'auto', run_id), additivePatch person_id per member. Flags: identity_flags via check-then-insert on cluster_key (23505-tolerant). Already-linked rows skipped with honest count.

- [ ] TDD pure parts: the real four-Onder cluster (one person, display_name 'Onder, Robert F.'?? — NO: precedence says bioguide wins but the STORED form is 'Last, First'; normalize display to 'Robert F. Onder' word-reorder ONLY when the bioguide form contains a comma — mechanical reordering of its own printed parts, not invention; test asserts exactly this); Brown(16)+Brown(26) → two singletons never clustered; same-name cross-era senate pair → flagged; already-linked skip; dry-run zero-write.
- [ ] Implement → full suite green → commit `feat: person clustering + linker CLI (auto + flags)`.

## Global Constraints

- Wrong-merge is the unacceptable error class; missed-merge is benign. ANY ambiguity → flag, link nothing, never guess (the ledgered asymmetric-cost rule).
- display_name is mechanical: bioguide > mo_senate > mo_house > legiscan > openstates printed names, source recorded in display_name_source. Never invented, never edited.
- Additive only: additivePatch for person_id (fills null; a non-null person_id is NEVER overwritten — conflict throws typed); insertIfAbsent/check-then-insert per established patterns; all reads via selectAll (the 1000-row lesson — legislators is at 1,576).
- person_links.evidence carries the matched facts verbatim (names, variant used, chamber/district/era, source key columns present) — the audit IS the product's trust story.
- Typed errors; skip≠empty; honest counts {clusters, personsCreated, linked, flagged, alreadyLinked, singletons}; provenance run_id.
- node:test via bare `node --test` (full suite 809 baseline stays green); fixture-first: the REAL four-Onder shape is the canonical cluster fixture (bioguide 'Onder, Robert F.' — note 'Last, First' form; openstates 'Bob Onder'; mo_senate 'Bob Onder' d2; legiscan 'Robert Onder' nickname 'Bob'); Brown(16)/Brown(26) same-surname-different-people must stay unlinked.
- Commits end: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---
