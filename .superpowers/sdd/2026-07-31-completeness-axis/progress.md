Implemented 6e8d672 (1917/1917, TDD red-first). COMPLETENESS_SYSTEM_PROMPT with the two-phase
unanchored contract (phase 1 = bill text only via buildProvisionsMessage; phase 2 = fed-back
provisions + summary bullets via buildCoverageMessage), COMPLETENESS_SCHEMA (3-7 bounded
provisions), assessCompleteness (pure, never throws, re-derives malformed/incomplete/complete and
never reads a self-reported overall, with the same collapse-whitespace-substring grounding
discipline checkStatedPurposeGrounding uses — so a checker that invents a section is caught).
Record gate: completeness REQUIRED for publish (absent -> flagged 'completeness_check_absent';
malformed -> reject, zero writes; incomplete -> flagged naming the missing provisions; complete +
support-clean -> publish). Completeness stored as its OWN summary_verifications row (kind
'completeness'), never merged with the support row.
0020 DRAFTED but NOT handed to Lance yet — the implementer honestly flagged three consumers it
would break: bill-page.js takes rows[0] blindly (would render 'complete' into a clean/flagged
sentence template AND drop the support receipt); review/server.js reads verifications with no kind
filter in two places (deriveVerificationBadge would misread coverage entries, which carry .covered
not .supported); probe-public-surface.js asserts an exact column set and would false-flag on the new
column. CONTROLLER RULING: fix consumers FIRST, and discriminate by SHAPE not by a kind filter — a
kind=eq.support filter would 400 pre-0020, and 0020 is draft-then-apply so both states must work.
Follow-up dispatched incl. surfacing the coverage clause on the public receipt (the visible payoff)
with the honest no-completeness-row fallback for every summary published before this ships.
