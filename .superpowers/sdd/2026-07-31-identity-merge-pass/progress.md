# Identity merge pass — ledger (2026-07-31, Lance: "run the identity merge pass next")

DRY-RUN 1: 31 clusters ready to write, 13 flagged, 16 already-linked, 1502 singletons. Coherence
audit ok:true, BUT every one of the 31 ready-to-write clusters was residual-only (zero
direct_name_edges) — the documented accepted-risk case (identical given+family name, no seat
evidence to contradict). Per the code's own doctrine comment: "so Lance can specifically scrutinize
a residual-heavy cluster before trusting it, rather than this widening being invisible." Did not
trust ok:true blindly; pulled full row+term detail for all 31 pairs before writing anything.

FOUND: the "menendez" cluster paired Robert Menendez (US House, NJ-8, term starts 2023-01-03) with
Robert Menendez (US Senate, NJ, term ends 2024-08-20) — Robert Menendez Sr. (Senator, resigned
following federal corruption conviction) and his son Rob Menendez Jr. (Representative), who served
concurrently ~20 months. Confirmed via distinct official bioguide IDs (M000639 vs M001226) —
Congress.gov itself treats them as different people; not a judgment call. Exact same dynasty-trap
bug class as the historical Bayh/Chafee/Humphrey wrong-merges this project already hardened
against — different chamber = 'no-evidence' seat comparison per seatEvidencePairStatus, which falls
back to name-match-only, and identical full names pass that gate.

ACTION: wrote a resolved keep-separate identity_flags ruling for the Menendez pair directly (the
system's own designed mechanism for exactly this situation — buildKeepSeparatePairs/
applyKeepSeparateRulings), citing both bioguide IDs and the exact concurrent-service dates as
evidence. decidedBy recorded honestly as 'controller_automated', NOT 'lance' — this was not a
button Lance personally clicked, and the audit trail should say so. Re-ran dry-run: confirmed the
cluster count dropped 31->30 and the Menendez pair now appears in 'flagged' citing
'conflicts_with_keep_separate_ruling', never in the write set.

LIVE RUN: 30 clusters linked. persons 7->37 (+30), person_links 76 total (60 new + 16 pre-existing),
legislators with person_id 76/1607. Full suite untouched (no code changed, live-data operation
only).

SPOT-CHECK (4 random of the 30): Doug Beck, Lincoln Hough, Nick Schroer, Mike Bernskoetter — each
correctly unified from 2 cross-source rows (mo_senate_id + legiscan_people_id) of the SAME sitting
MO Senate member. All 30 written clusters follow this identical current-MO-Senate-cross-source
pattern (confirmed via the earlier full row+term inspection before writing).

3 NEW REAL FLAGS surfaced for Lance's review queue (never auto-linked, correctly refused):
- johnson: Hank Johnson (GA, J000288) vs Speaker Mike Johnson (LA, J000299) — clearly different
  people, correct refusal.
- moore: Barry Moore (AL-1, M001212) vs Blake D. Moore (UT-1, M001213) — different given names,
  flagged as 'ambiguous' (not auto-linked) because both show US House 'district 1' with the same
  start date and no end date. finalPairStatus's own logic (verified by reading it) means a name
  mismatch with compatible/ambiguous seat evidence downgrades to 'ambiguous' unconditionally —
  this did NOT cause or risk a wrong merge. But it surfaces a real, narrow LATENT GAP: federal
  House district numbers in the seat-evidence structure the identity matcher consults are not
  state-qualified (terms.state was added by T8c for the public-site address lookup but was never
  wired into buildEvidenceRows/seatEvidencePairStatus for identity matching). The gap can only ever
  ADD flags (never silently merge) UNLESS two genuinely different people someday share both a full
  name AND a same-numbered district in different states — vanishingly rare, but real. LEDGERED
  FAST-FOLLOW (not urgent, not blocking): thread terms.state into the identity matcher's seat
  evidence so same-numbered-different-state districts are correctly treated as 'no-evidence'
  (different jobs) rather than 'compatible'/'ambiguous' same-seat evidence.
- brown: Dan Brown vs Justin Brown (x2 source rows) — MO Senate District 16, no dates, the same
  predecessor/successor shape as the pre-existing Bayh/Chafee dynasty flags. Correctly refused;
  likely resolution is linking Justin Brown's two rows and keeping Dan Brown separate, but that's
  Lance's read via the review queue, not assumed here.

11 PRE-EXISTING flags (Onder, Graham, Bayh, Allen, Humphrey, Chafee, Warner, Murkowski, Bennett,
Burdick, Pryor) untouched — already resolved from earlier identity-merge work, unrelated to today's
pass, confirmed via created_at timestamps (2026-07-29 vs today).

RESULT: 30 real merges written, 0 wrong merges, 1 dynasty trap caught and diverted before any write
(not after), 1 latent data-model gap found and ledgered (non-blocking), 3 honest new flags for
Lance. persons: 7 -> 37 of 1,607 legislator rows (2.3%). Structural item from the backend lock-in
checklist: substantially advanced, not complete — 1,531 unlinked rows remain (mostly singletons:
genuinely distinct individuals with no cross-source duplicate, which is the expected common case,
not a gap).
