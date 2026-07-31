### Task 3: Federal fetch pass — sponsors + status + texts + member metadata (Congress.gov, free)

**Files:** Extend `src/adapters/us-congress.js` (bill-detail + member-detail parsing, fixture-first — capture 2-3 real payloads politely); Create `src/cli/enrich-federal-bills.js`, tests.
- Worklist: distinct voted-on federal bills (selectAll over votes → bill ids). Per bill (existing polite limiter, X-Api-Key header discipline): bill detail → sponsors (bioguide → legislator exact match) + latestAction/status (additivePatch bills.status) + text-version URL → fetch text (existing bill_texts conventions, content_hash; oversize gate honored).
- Member metadata: current members endpoint → party/state/district (additivePatch legislators fills-null; bioguide photo URL constructed mechanically from bioguide_id, stored... legislators needs no new column: photo URL is DERIVABLE from bioguide_id at render time — DO NOT add a column; note this in the report).
- Durable progress (artifact or DB-keyed) so the pass resumes across restarts; --limit for chunking; honest per-category counts.
- [ ] TDD parsers off captured fixtures → implement → suite green → dry-run → commit. Live pass controller-operated in background chunks.

## Global Constraints

- Zero metered-API model calls. The GOLDEN_CHECK/GLOSS gates stay closed. Congress.gov + cached-ZIP reads only; every fetch through the existing polite limiters.
- Additive writes only (insertIfAbsent/additivePatch); selectAll for every multi-row read (legislators 1,576; bills 38,250; votes 9,900+ — everything is past or near the 1,000 cap); provenance run_id everywhere; typed errors; skip≠empty; honest counts.
- DESIGN FREEZE (two-steps-ahead ruling): no new per-state identity columns, ever — future states ride legiscan_people_id + terms. 0014's comments state this.
- Draft-then-apply: 0014 written + committed; Lance applies; everything gated via isMissingRelationError until then.
- Identity invariants are law: full-name-variant necessity, asymmetric cost, writer BELT, pairwise name-sets. Attach-to-existing must reuse the same matcher primitives — no parallel matching logic.
- node:test bare invocation; 979 baseline stays green; fixtures-first (cached ZIPs and real Congress.gov captures are the fixtures). Commits end: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---
