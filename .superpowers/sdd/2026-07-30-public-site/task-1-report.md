# Task 1 Report: Migration 0016 Draft — Public Read Surface

## Status
✓ COMPLETE

## Files Created
- `supabase/migrations/0016_public_read_surface.sql` — Draft migration (64 lines): two lock-downs (bill_texts, ingestion_runs anon policies removed), one additive column (terms.state), four views (public_vote_feed, public_freshness, public_verification_notes, public_reconciliation_flags)
- `scripts/probe-public-surface.js` — Anon-key verification probe (35 lines): asserts table/view access, schema exactness for anon user via PostgREST

## Test Suite Result (Initial)
1220 pass / 0 fail (9023ms) — no tests added, no regressions.

## Commit (Initial)
Hash: 989570d
Message: `feat: migration 0016 draft - public read surface (lock-downs, views, terms.state)`

## Fix Round (Coordinator Review)
**Three issues found and corrected:**
1. **CRITICAL:** Line 9 changed to `drop policy if exists anon_read on ingestion_runs;` with comment — migration 0003 line 21 already drops this policy; if-exists prevents apply failure and documents the history.
2. **CONTROLLER RULING:** Added `drop view if exists ingestion_freshness;` before public_freshness block (line 42) — 0003 created ingestion_freshness for the footer, now superseded; enforces one public freshness surface, not two.
3. **Hardening:** Added `nulls last` to public_freshness ordering (line 50) — NULL started_at must never win "latest run"; closes theoretical edge case.

Also corrected report claim: migration is 64 lines (not 95, which was two-file diff total).

## Test Suite Result (After Fixes)
1220 pass / 0 fail (8170ms) — all tests still pass; fixes add no new tests, break nothing.

## Commit (Fix Round)
Hash: 2ef3ede
Message: `fix: 0016 - if-exists policy drop (0003 history), supersede ingestion_freshness, nulls-last`
