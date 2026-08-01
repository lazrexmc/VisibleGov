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
