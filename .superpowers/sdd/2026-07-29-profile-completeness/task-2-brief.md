### Task 2: MO sponsors + bill status backfill (cached ZIPs, $0, 0 queries)

**Files:** Create `src/cli/backfill-mo-bill-meta.js`, tests.
- Reads the 31 cached dataset ZIPs (skip-with-count if missing, NEVER fetch); per bill payload: sponsors[] (people_id + sponsor_type/primary flag — verify the REAL field names against the fixtures first) → bill_sponsors rows via legiscan_people_id → legislator lookup (exact key only; unmatched → honest count, never guessed); status/status_date + last history entry → additivePatch bills.status (fills null only — never overwrites; bills.status semantics: LegiScan's own printed status string, source-labeled).
- Gated on 0014 for sponsor writes (isMissingRelationError → honest gated count); status writes ungated (column exists).
- [ ] TDD off the two committed dataset fixtures (1579/1608 — real sponsor shapes) → implement → full suite green → dry-run → commit. Live run controller-operated.

## Global Constraints

- Zero metered-API model calls. The GOLDEN_CHECK/GLOSS gates stay closed. Congress.gov + cached-ZIP reads only; every fetch through the existing polite limiters.
- Additive writes only (insertIfAbsent/additivePatch); selectAll for every multi-row read (legislators 1,576; bills 38,250; votes 9,900+ — everything is past or near the 1,000 cap); provenance run_id everywhere; typed errors; skip≠empty; honest counts.
- DESIGN FREEZE (two-steps-ahead ruling): no new per-state identity columns, ever — future states ride legiscan_people_id + terms. 0014's comments state this.
- Draft-then-apply: 0014 written + committed; Lance applies; everything gated via isMissingRelationError until then.
- Identity invariants are law: full-name-variant necessity, asymmetric cost, writer BELT, pairwise name-sets. Attach-to-existing must reuse the same matcher primitives — no parallel matching logic.
- node:test bare invocation; 979 baseline stays green; fixtures-first (cached ZIPs and real Congress.gov captures are the fixtures). Commits end: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---
