# Summary waves — ledger

CHAIN PROVEN then WAVE 1 (2026-07-31, $0 subagent path, both trust axes live post-0020):
- HRES 1175: published through author -> adversarial verify (7/7 supported) -> two-phase unanchored
  completeness (7/7 provisions covered). First summary through BOTH axes.
- Wave 1: 40 MO passage-vote bills, 8 batches x (author opus / verify sonnet / completeness sonnet),
  pipelined via workflow. 21/24 agents finished before Lance's Fable-5 weekly limit hit; batches 5
  and 7's tail (coverage/verify) errored on the limit -> 9 bills left partial (artifacts on disk,
  finish after reset).
- 31 fully-complete bills assembled and run through the record gate:
  - 20 PUBLISHED (both axes clean) — published summaries 11 -> 31
  - 10 flagged/unverified drafts (real gate flags: a support verdict or a coverage gap) -> review queue
  - 1 FAILED shape validation: SCR 21 — stated_purpose contains a line break (the newline-injection
    guard from the public-site final review firing correctly; re-author single-line to recover)
  - draft/flagged queue 23 -> 33
- The gate held back everything that didn't cleanly pass BOTH axes. Working exactly as designed.
DEFERRED to next usage window: the 9 partial bills' missing checks; wave 2 (3,281 bills still in pool).

WAVE 1 FULLY CLOSED (2026-07-31, second pass after usage reset): the 9 partial bills' completeness
phase run to completion (2 batches, phase-1-then-phase-2 sequencing preserved — provisions formed
before the summary was shown, per doctrine). All 9 well-formed, all covered 0 uncovered. Recorded:
6 published, 2 flagged, 1 failed shape (SB 977, same newline-injection class as SCR 21).
WAVE 1 TOTAL: 40/40 bills processed through both trust axes. 26 published (11->31... final: see
live count), 12 flagged to review queue, 2 failed shape validation (recoverable via re-author).

WAVE 1 SHAPE-FAILURE RECOVERY (2026-07-31, during the pre-restart preservation pass): the 2 bills
that failed shape validation were recovered rather than abandoned — 40/40 of wave 1 is now recorded,
nothing left unrecorded in scratchpad (which is temp and does not survive a system wipe).
- SCR 21: stated_purpose was a verbatim quote that WRAPPED LINES in the source PDF, tripping the
  newline-injection guard. Fixed by collapsing whitespace runs in the structural single-line fields
  only — wording untouched, and still grounds because checkStatedPurposeGrounding normalizes
  whitespace on BOTH sides. PUBLISHED.
- SB 977: a DIFFERENT failure, and the gate was catching a CHECKER error, not a summary error —
  the completeness checker emitted coverage with bullet_index 8 for an 8-bullet summary (valid
  0..7, an off-by-one). Deliberately NOT papered over by editing the index (that would fabricate a
  coverage claim the checker never correctly made); the completeness check was RE-RUN from phase 1,
  returned 7 provisions / 7 covered with all indices in range. PUBLISHED.
LESSON: the shape guards catch producer errors in BOTH the author and the checker. A "failure" in
this pipeline is frequently recoverable at near-zero cost by re-running the specific stage that
produced the bad artifact — worth checking the exact message before discarding an authored summary
(the authoring is the expensive part; the checks are cheap to redo).
