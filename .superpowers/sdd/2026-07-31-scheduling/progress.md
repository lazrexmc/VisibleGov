# SDD ledger — plan: .superpowers/sdd/2026-07-31-scheduling/brief.md (brief-driven, no separate plan file)

Controller: session 8ecd5d8c. Both tasks approved by Lance 2026-07-31 ("add the spend gate /
build the schedule ingestion"). BASE de2bf54.

## Implementer report (sonnet, single serialized dispatch)
- Task 1 commit 41936f0 (spend gates SUMMARIZE_RUN_APPROVED / VERIFY_RUN_APPROVED)
- Task 2 commit 3e12a1e (scripts/scheduled-ingest.js + docs/SCHEDULED_INGESTION.md + npm run schedule:ingest)
- Suite: 2025 pass / 0 fail (baseline 1975 + 50 new). Live-DB verification via --dry-run only.
- schtasks NOT run (correct — registration is Lance's draft-then-apply step).

## Implementer concerns + controller verification
1. ~~"TODO 25 feeder is not in this scheduler's registry"~~ — **WRONG, controller-corrected.**
   The feeder is `mo-senate-web`: ingest-mo-senate.js:472 insertIfAbsent's its OWN session row
   ("2026 Regular Session (MO Senate journals)", legiscan_session_id NULL) and keys its bills to
   it. Verified live: both 2026 rows exist, NULL one is the senate-journal one. The scheduler
   invokes that same CLI, so registration CONTINUES feeding the split until TODO 25's merge fix.
   Neutral vs today (the manual loop does the same), but docs must not claim otherwise.
2. legiscan --session resolved from sessions.legiscan_session_id (currently 2239), skip-on-fail.
   REVIEW QUESTION: with two 2026-named rows (one NULL), is the resolution deterministic and
   NULL-proof?
3. us-congress delta = scheduler-computed forward window (max known roll + 10) — implementer's
   own inference, flagged by them as most-uncertain. Review hard: boundedness, idempotency,
   404 handling, limiter use, interval floor.
4. "Wrote anything" gating the aggregate refresh is a deliberate over-refresh proxy. Acceptable
   direction (stale charts were a real user-visible defect); reviewer sanity-check only.

## Task review (opus, adversarial; full text: task-review.md)
- Task 1 spec ✅ (ships as-is). Task 2 spec ❌ (C2 docs-honesty) + quality ❌ (C1).
- Mechanical: reviewer ran suite itself (ℹ fail 0, 2025 pass), dry-run exit 0 with byte-identical
  before/after count-headers on 6 tables, commit hashes match diff.
- C1 (Critical): ingest.js networks BEFORE openRun → persistent congress.gov failure writes no run
  row → us-congress stays most-overdue → picked EVERY tick forever, starving MO+legiscan. Live on
  day one (us-congress 91h overdue at review time).
- C2 (Critical): SCHEDULED_INGESTION.md claimed scheduler unrelated to TODO-25 split — false
  (controller-proven; reviewer independently re-proved).
- I1 lock release without ownership check; I2 no spawnSync/fetch timeouts; I3 Promise.all kills
  tick on one lookup rejection; I4 tail-404 'partial' = permanent noise + unconditional hourly
  aggregate refresh; I5 us-senate source missing from registry entirely.
- M1 UTC log naming vs doc; M2 1MB maxBuffer misreport; M3 lookups run under --only/--dry-run;
  M4 gate messages lack gloss.js's cost-estimate line.
- Review answers: A) LegiScan resolver NULL-proof by unique(jurisdiction_id,identifier) +
  identifier='261' predicate — cannot pick the TODO-25 row. B) forward-window inference sound,
  selectAll-paginated (not 1000-capped), bounded/idempotent/404-tolerant/limiter'd/1h-floored.
  C) failed — doc overclaims; code comments clean.

## Fix round 1 — dispatched (resumed original implementer)
All of C1, C2, I1-I5, M1-M4 with controller rulings: C1 = scheduler-side honest attempt row
(status 'failed', scheduler_attempt detail) advancing the shared durable cooldown signal;
C2 = neutral-vs-today rewrite; I1 = nonce ownership check; I2 = spawnSync ≤10min +
AbortSignal.timeout, http.js untouched; I3 = allSettled + skip-with-reason; I4 = read child's run
row → tail-404 partial logged healthy + refresh only on >0 written; I5 = add us-senate mirroring
its 4 prior runs. Red-first tests required for C1/I1/I3/I4-gate. M4 is the only permitted Task-1
touch.

## Fix round 1 — complete (commit 9a4eb66, ℹ fail 0, 2057 tests = 2025 + 32)
All C1/C2/I1-I5/M1-M4 landed per rulings. Implementer's empirical self-check surfaced a real
follow-on: legiscan runs vs the target session took 449.3s/475.7s against the I2-ruled 480s
budget (1-7% margin), outlier 3168.5s; a timeout-kill strands the CLI's pre-opened 'running' row
AND repeats daily (24h interval) — weekly dataset could never land. mo-house 1800.0s-multiple
"outliers" adjudicated false alarm (enforceDurableCooldown sleeping out the old manual loop's
premature invocations; structurally prevented by the scheduler's due-ness gate).

## Fix round 2 — dispatched (same implementer; controller CONFIRMED the concern as a defect)
Rulings: per-source timeoutMs (legiscan 75 min = observed max +40%, default stays 480s); lock
carries maxDurationMs of the in-flight run and stale-reclaim reads IT (fixed 10-min fallback for
missing/corrupt field) — this is what keeps a 75-min child and the I1 single-instance guarantee
compatible; timeout-kill closes the child's orphaned 'running' rows honestly (scheduler_kill
detail, only rows started within the tick); doc gains per-source values + derivation + Windows
"stop task if longer than" must EXCEED 75 min (recommend do-not-stop; our timeouts are the real
enforcement). Red-first: 75-min lock not reclaimed at 15 min / 480s lock still is / corrupt lock
still is; orphan-closing. One scoped re-review will cover rounds 1+2 together.

## Fix round 2 — complete (commit a6d94bc, ℹ fail 0, 2073 tests = 2057 + 16)
Per-source timeoutMs (legiscan 75 min, default 480s), lock-declared maxDurationMs with corrupt/
missing-field fallback to fixed 10-min, orphan-'running'-row closing on kill (tick-scoped only),
doc gains derivations + Windows stop-if-longer-than must exceed 75 min. Implementer's residual
note (accepted): any fixed timeout can be outgrown by future data volume; the honest-recovery
path (orphan-close + self-record + loud log) makes that fail-loud-and-retry, not silent — accepted
as inherent, revisit the number if legiscan durations trend up.

## Scoped re-review (rounds 1+2 together) — dispatched (resumed original opus reviewer)
Package: re-review-package.md (3e12a1e..a6d94bc, -U10). Scope: per-finding verification of
C1/C2/I1-I5/M1-M4, round-2 soundness (75-min lock vs +15-min tick reclaim, corrupt-lock fallback,
tick-scoped orphan-close), new-defect sweep (C1 double-record risk, I4b refresh-gate row
selection), mechanical suite + dry-run re-verification. SHIP / DO-NOT-SHIP verdict requested for
the full 4-commit stack as unattended-forever code.

## Scoped re-review (rounds 1+2) — DO NOT SHIP; one new Critical, three new minors
All 11 original findings verified addressed; round-2 lock mechanics verified sound AT RUNTIME
(not stale through +76 min on a 76-min declaration, stale at +77; default lock unaffected; all 7
corrupt-field shapes fall back safely; orphan-close triple-scoped, history untouchable). Suite +
dry-run independently re-verified (ℹ fail 0, 2073; exit 0, byte-identical count-headers on 6
tables). Shared-blast-radius honored (zero diff on http.js/db.js/adapters/other CLIs).
- 🔴 NEW-1 (Critical, REGRESSION): refresh gate reads detail.counts.votes; legiscan spreads
  counters top-level with no vote key — measured 0/52 real runs trigger; legiscan owns 82.3% of
  votes → weekly dataset would land with NO aggregate refresh, silently, log claiming healthy.
- 🟡 NEW-2 no clamp on declared maxDurationMs; NEW-3 updateLockMaxDuration failure ignored
  (spawns under 10-min placeholder); NEW-4 orphan-close local-clock vs DB-clock skew no-op.
- NEW-5 (hard-crash strands 'running' row): controller-adjudicated ACCEPTED, documented scope.
- Task 1 (41936f0 + M4) independently shippable.

## Fix round 3 — dispatched (same implementer; final resume round per SDD)
Rulings: NEW-1 = per-registry-entry wroteSomething(detail) predicate, FAIL-OPEN on unknown shape
(over-refresh accepted, silent-never rejected), legiscan predicate derived from real close-detail
keys and verified vs the 52 live rows, fixture tests from real detail rows for all 5 sources,
fix the :378-388 comment. NEW-2 = 2h ceiling → default beyond. NEW-3 = can't-record → don't
spawn (log, release, exit 0). NEW-4 = 5-min skew grace + written safety argument (≥30-min
intervals make pre-tick capture impossible) or DB-derived now(). Next: scoped re-review round 3.
