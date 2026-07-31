### Task 4: Attach-to-existing (identity; pre-rollover deadline)

**Files:** Modify `src/cli/link-persons.js`, `src/lib/person-identity.js` (only if a primitive is missing), `src/review/server.js` + `page.html`, tests.
- Linker gains an attach pass: unlinked rows are compared (same pairwise matcher, same evidence rules) against LINKED rows' name+evidence; a qualifying match emits an `attach_candidate` identity_flag (never auto-attaches — Lance decides; evidence carries the existing person_id + display_name).
- Review server: the identity decision route gains action 'attach' {flag_id, legislator_ids, person_id} — links selected rows into the EXISTING person (person_links decided_by 'lance', additivePatch person_id with the TOCTOU guard pattern), no new persons row. Keep-separate unchanged.
- The keep-separate-binding check (final-wave item 2) must also gate attach candidates.
- [ ] TDD: attach flag emitted for an Onder-shaped fifth row; attach decision links into the existing person (fake client, per-row assertions); TOCTOU-guarded; keep-separate-ruled pairs never attach-flag. Full suite green → commit.

## Global Constraints

- Zero metered-API model calls. The GOLDEN_CHECK/GLOSS gates stay closed. Congress.gov + cached-ZIP reads only; every fetch through the existing polite limiters.
- Additive writes only (insertIfAbsent/additivePatch); selectAll for every multi-row read (legislators 1,576; bills 38,250; votes 9,900+ — everything is past or near the 1,000 cap); provenance run_id everywhere; typed errors; skip≠empty; honest counts.
- DESIGN FREEZE (two-steps-ahead ruling): no new per-state identity columns, ever — future states ride legiscan_people_id + terms. 0014's comments state this.
- Draft-then-apply: 0014 written + committed; Lance applies; everything gated via isMissingRelationError until then.
- Identity invariants are law: full-name-variant necessity, asymmetric cost, writer BELT, pairwise name-sets. Attach-to-existing must reuse the same matcher primitives — no parallel matching logic.
- node:test bare invocation; 979 baseline stays green; fixtures-first (cached ZIPs and real Congress.gov captures are the fixtures). Commits end: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---
