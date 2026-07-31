Built (e8b917e, 1973/1973): status map sourced byte-exact from LegiScan manual p.42 (extracted via
the repo's own pdf-text.js, not memory); update guard is .eq('status',code) on the write itself;
BOTH writers (ingest-legiscan.js, backfill-mo-bill-meta.js) traced and fixed via one shared
mapMoStatusCode constant. Journal-filename date parser checked against ALL 88 cached 2018 index
entries + 70 of 2026's + 67 raw files (not just the brief's one example); found+handled two real
deviations (special-session T1Day/S1Day filenames, a lowercase-d typo variant).
Review 1: correction A GO as-is. Correction B NO-GO — proved by execution a false-positive delete
path (two DIFFERENT roll calls sharing a coincidental TALLY on the same bill/chamber -> wrong row
deleted). MEDIUM: --limit live branch discarded the update's real count, reporting the stale
pre-update selection instead.
Fix (0bc1485, 1975/1975): implementer REJECTED the reviewer-suggested question-text signal as
violating this project's zero-fuzzy-matching identity policy; instead used exact-SET-equality on
legislator_ids who voted yea and nay (schema-guaranteed canonical FK regardless of source pipeline)
-- strictly stronger than a tally count, still exact not fuzzy. Added matches[] human-review detail
array (sentinel+primary vote ids, tallies, signal) to both dry-run and live output. Fixed --limit to
read the update's real returned count.
Re-review 2: GO, 31 independent assertions incl. a fresh test harness -- false-positive fixed,
true-positive still catches, three new edge cases (same-size-different-membership, asymmetric sets,
multiple-candidates-one-exact-match) all resolve correctly with no guessing, matches[] populated
correctly in both modes, --limit race fixed.
LIVE DRY-RUN (both corrections, final numbers for Lance):
  mo-status: 37,662 corrected (1:33068 Introduced, 2:2542 Engrossed, 3:111 Enrolled, 4:1849 Passed,
    5:92 Vetoed, 6:0 Failed); 36 left untouched (code 0, no honest word); 0 unexpected codes.
  mo-1969-dates: 10 seen, 0 deleted (no primary duplicates existed), 10 redated from journal
    filenames, 0 unresolvable. Every row resolves cleanly with zero ambiguity.
AWAITING LANCE APPROVAL for the live pass (both corrections).
echo ledgered
LIVE RUN COMPLETE (2026-07-31, Lance: "proceed as you see best fit"). Correction A: 37,662 bills
corrected, verified exact match to dry-run (Introduced 33068, Engrossed 2542, Enrolled 111, Passed
1849, Vetoed 92, Failed 0; 36 code-0 untouched; 0 numeric codes remain anywhere in bills.status).
Correction B: 10/10 votes redated from their primary journal filenames, 0 deletions (no primary
duplicates existed for any of the 10), 0 unresolvable; 0 rows remain at the 1969 sentinel. Both
writers already fixed so re-ingestion can't reintroduce either defect. Aggregates refreshed. Full
suite 1975/1975 (0 fail, verified with the explicit fail-count gate). Both corrections: COMPLETE.
