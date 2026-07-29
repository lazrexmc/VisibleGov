-- Draft (Lance applies). Final whole-branch review (2026-07-29), Finding 6 —
-- vote_reconciliation_flags had no idempotency key. Under the documented hash-unchanged re-run
-- cadence, every persistent discrepancy (especially a quarantined-class roll call, re-detected on
-- every re-run) inserted a fresh duplicate row each time, and a human-resolved (resolved=true)
-- discrepancy could reappear as a new resolved=false duplicate on the very next run — silently
-- negating the review that already happened. Execution-confirmed: 3 identical re-runs -> 3 rows;
-- resolving one, then re-running, produced a second unresolved row.
--
-- CONTROLLER AMENDMENT: app-level check-then-insert keyed on (vote_id, source_a, source_b,
-- roll_call_id, reason) is the PRIMARY defense NOW (src/adapters/legiscan-votes.js's
-- findExistingReconciliationFlag/writeReconciliationFlag — single-process driver, race-safe enough
-- per the glossary-persistence idempotency precedent this codebase already accepted). This
-- migration adds the durable DB-level backstop.
--
-- No new columns: roll_call_id/reason are already written into the existing `discrepancy` jsonb
-- payload (present since migration 0010) by every writeReconciliationFlag call site as of the
-- application-layer fix landing alongside this draft — an EXPRESSION index over those two jsonb
-- fields is sufficient and avoids a backfill-and-two-shape-insert-path problem a new physical
-- column would otherwise create (the app can always write `discrepancy`, migrated or not).
--
-- Deliberately does NOT include `resolved` in the index — a resolved discrepancy for the exact same
-- (vote, source, roll call, reason) must keep blocking a fresh un-resolved duplicate from ever being
-- inserted again; that IS the point (a resolved flag reappearing as resolved=false is exactly the
-- bug this closes). NULLs (any row this migration wasn't around to see written with roll_call_id/
-- reason already embedded, or a future write that genuinely can't determine one) are never compared
-- equal by a Postgres unique index, so such rows can never spuriously collide with anything.
--
-- The application (writeReconciliationFlag) already checks-then-inserts BEFORE this index exists,
-- so this is a backstop for a genuine concurrent-write race, not the only line of defense — its own
-- 23505 (unique_violation) handling re-selects and returns the row that won rather than surfacing a
-- duplicate-key error, so this index is safe to apply at any time without a driver code change.
create unique index if not exists vote_reconciliation_flags_dedup_key
  on vote_reconciliation_flags (
    vote_id,
    source_a,
    source_b,
    ((discrepancy->>'roll_call_id')::integer),
    (discrepancy->>'reason')
  );
