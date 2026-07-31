### Task 7: Substitute-vehicle attribution — bounded investigation, then implement

**Files:** Modify `src/adapters/legiscan-votes.js` (or a small sibling module); tests

`tests/fixtures/research/SOURCES.md` already flags this open: SB894's real `getBill` fixture
carries exactly ONE roll call (747209, House, described `"House: SB 894  SBs 3rd READ -
INFORMAL"` — note the plural "SBs", confirming this vote covers the combined `SS for SCS for SBs
894 & 921` vehicle from the MO Senate journal fixture). Crucially, **none of SB894's own recorded
Senate-passage actions** (`S Third Read and Passed`, `Truly Agreed To and Finally Passed`, both
2018-05-03) **have a corresponding roll call in SB894's `votes[]` array at all** — meaning either
(a) that Senate passage was a voice vote with no individually-recorded tally, or (b) LegiScan
attributes the Senate roll call for a combined vehicle to a DIFFERENT bill's record (SB921's, per
the working hypothesis already noted in SOURCES.md) rather than duplicating it onto SB894 too.
This must be settled with real payloads before an attribution rule is coded, not assumed either
way.

**Bounded to ≤3 live LegiScan queries** (stated up front, per Global Constraints): `getBill` for
SB921 in the 2018 session (1 — check whether IT carries a Senate-chamber roll call around
2018-03-01/2018-05-03 that SB894 lacks); if found, `getRollCall` for that roll call (1, confirm
whether its `bill_id` points at SB921 only or is somehow shared); 1 query held in reserve.

- [ ] Run the bounded live investigation; document the REAL finding (which of (a)/(b) above, or a
      third shape neither anticipated) in this task's commit message and in
      `tests/fixtures/research/SOURCES.md`.
- [ ] Implement the attribution rule the real finding actually supports. **Schema implication,
      ruled in advance** (`.superpowers/sdd/legiscan-plan-draft-notes.md` Q6, APPROVED): if the
      finding shows LegiScan attributing ONE roll call to MULTIPLE sibling bills, `votes.bill_id`
      (a single nullable FK) cannot represent that without either (i) picking one bill as primary
      (mirrors `mo-senate-journal-pdf.js`'s own precedent: `bill_refs[0]` is primary, siblings are
      traceable via the verbatim motion/desc text) — no schema change needed — or (ii) a new
      bill↔vote join table if per-bill attribution genuinely matters for both siblings
      independently. **Ruled: do NOT build (ii) speculatively** — ship (i) unless the real finding
      demonstrates it's needed, and even then only if Plan 3's bill-page scoping actually demands
      it, not preemptively here.
- [ ] TDD the implemented rule against whatever real fixture the investigation produced.
- [ ] Commit `feat: legiscan substitute-vehicle attribution (investigated, not assumed)`.


## CONTROLLER RULINGS (binding, appended)

1. HARD BUDGET ≤3 live queries, logged verbatim-redacted in report + SOURCES.md; save every response as a committed fixture. The question to settle with evidence: where does LegiScan put the Senate vote on the combined vehicle 'SS for SCS for SBs 894 & 921' (our Day 37 journal fixture holds the real Senate vote; LegiScan's SB894 record shows only a House roll call)? Likely probes: getBill for SB 921 (2018 Regular, masterlist fixture already holds its bill_id — NO list re-query), and if needed ONE more targeted getBill/getRollCall.
2. Deliverable = EVIDENCE + RULING RECOMMENDATION, not code: a findings section (docs/research addendum or report — put durable findings in docs/research/2026-07-28-legiscan-terms.md's sibling file docs/research/2026-07-29-legiscan-substitute-vehicles.md, committed) answering: (a) does the combined vehicle's roll call appear under one sibling bill, both, or neither; (b) do the two siblings' records cross-reference each other (sasts/same_as/substitute fields — the dataset bill payloads carry sasts arrays, check the real fixtures first before spending queries); (c) what attribution rule should Task 9 implement so a vote on a combined vehicle lands correctly for EVERY sibling bill's profile without double-counting a legislator's cast. Recommend concretely; the controller rules on it before Task 9's brief.
3. Check the ALREADY-HELD fixtures first (mo-2018-masterlist has both bill_ids; the dataset ZIPs' bill payloads have sasts/committee fields) — a query spent on something the fixtures already answer is a budget violation.
4. Cross-reference our own Day 37 journal ground truth (tests/fixtures/research/mo-senate/2018-day37-journal-onder-era.pdf parse: the SS-for-SCS-for-SBs-894&921 block, yeas/nays) — if LegiScan's roll call for that vote exists, its tallies must reconcile against the journal's printed counts; report the comparison.
