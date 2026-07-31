### Task 8: Coexistence policy — demote primary-source drivers to reconciliation cadence

**Files:** Modify `src/cli/ingest-mo-house.js`, `src/cli/ingest-mo-senate.js` (cadence/role
comments + a `--reconcile-only` mode flag); no new adapter files — **deliberately right-sized**:
this task lands the POLICY and the LEDGER WIRING (Task 1's `vote_reconciliation_flags` table +
Task 6's `crossCheckAgainstPrimarySource`), not a full new automated comparison engine. **Ruled**
(`.superpowers/sdd/legiscan-plan-draft-notes.md` Q7, APPROVED — ship the small version now): a
fuller reconciliation-review CLI/UI is legitimate follow-on work, explicit and deferred, not built
here — it's premature before `vote_reconciliation_flags` has ever had real rows to review.

**Concrete changes:**
1. Both drivers' module-header comments updated: role changes from "primary MO vote ingestion"
   to "primary-source audit/reconciliation layer, LegiScan (`src/cli/ingest-legiscan.js`, Task 9)
   is now PRIMARY for MO backfill." No functional behavior change required in THIS task beyond
   what's below — the drivers keep working exactly as they do today (they still write votes rows
   when run; nothing about their parsing/reconcile-or-throw internals changes).
2. `crossCheckAgainstPrimarySource` (Task 6) is the actual mechanism: it runs from the LegiScan
   ingestion side and looks up whatever the primary-source drivers have ALREADY written — meaning
   the coexistence check happens automatically whenever LegiScan ingestion runs, with zero new
   scheduled job needed for the backfill period. `mo-house-xml`/`mo-senate-web`'s own cadence
   (30-min, ToU-driven) is UNCHANGED by this plan — they were already slow/rare by ToU necessity;
   "demote to audit cadence" in practice means "their future runs matter for cross-checking
   already-LegiScan-covered bills more than for being the first writer," a framing change more
   than a code change for the backfill window.
3. Bill/vote coexistence itself is guaranteed by the identifier-normalization + session-mapping
   Global Constraints already specified (Tasks 1/4) — a LegiScan-sourced bill for a session/
   identifier a primary-source driver already created lands on the SAME `bills` row (unique
   constraint dedupe), not a duplicate.

- [ ] Update both drivers' header comments (documented policy, per above).
- [ ] `crossCheckAgainstPrimarySource` (already built in Task 6) is exercised end-to-end here
      against a synthetic scenario: a `mo-house-xml`-sourced vote row exists for a bill LegiScan
      also covers, tallies deliberately mismatched → flag row lands in
      `vote_reconciliation_flags` with both sources' tallies and the Task-6 caveat note.
- [ ] Commit `docs+feat: coexistence policy - primary-source drivers demote to reconciliation
      role; cross-check wiring exercised end-to-end`.


## CONTROLLER RULINGS (binding, appended)

1. COEXISTENCE REVISED (Task 7's finding, journal-verified): LegiScan structurally lacks combined-vehicle floor votes (scalar bill FK; the SBs 894&921 case proven). The MO Senate journals-first pipeline is COMPLETENESS-CRITICAL — sole source for that vote class — and keeps its full ingestion cadence permanently; it is NOT demoted to audit-only. The House XML pipeline's exposure to the same gap is UNKNOWN (document as such; Task 10 gathers first evidence via per-chamber count comparison).
2. Scope stays SMALL per the original Q7 ruling: policy/comment updates in the two MO drivers + the plan-level doc statement + exercising the cross-check wiring Task 6 built. NO new reconciliation CLI, NO UI.
3. source_key dedup discipline: the same real-world floor vote may now legitimately exist twice (a LegiScan row AND a journal row with different source_keys). Task 8 DOCUMENTS the dedup rule for consumers (Plan 3): journal/primary rows win for display when both exist for the same (chamber, date, bill, tallies) — write this as a comment + a short docs section, not code (the cross-check flags already make the correspondence visible).
