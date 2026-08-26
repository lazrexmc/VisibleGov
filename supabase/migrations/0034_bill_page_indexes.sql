-- 0034 (draft — Lance applies). Index the two lookups every bill page performs.
--
-- Found 2026-08-26 by Supabase's own performance advisor (reachable for the first time via the
-- newly-authorized Supabase MCP), then confirmed with EXPLAIN ANALYZE against the live database
-- rather than taken on the advisor's word.
--
-- WHAT IS WRONG. site/js/bill-page.js issues exactly two filtered reads per page view:
--
--   public_votes?bill_id=eq.<id>&order=vote_date.desc.nullslast
--   summaries?bill_id=eq.<id>&status=eq.published&order=published_at...
--
-- `votes` carries only votes_pkey and votes_source_key_key. `summaries` carries only summaries_pkey.
-- Neither has an index on bill_id, so both reads are sequential scans. Measured live:
--
--   Seq Scan on votes v  (actual time=0.058..3.022 rows=2 loops=1)
--     Filter: (bill_id = ...)
--     Rows Removed by Filter: 10184
--
-- Ten thousand rows examined to return two, on every bill page, for every visitor.
--
-- WHY IT IS WORTH FIXING NOW RATHER THAN "WHEN IT HURTS". Execution is only ~3.6ms today because
-- the table is small and fully cached, so this is not an outage. But the cost grows linearly with
-- `votes`, which grows on every scheduler tick, and this project has already had one production
-- incident of exactly this shape: migration 0031 fixed a live anon statement_timeout on a profile
-- vote list found on deploy night. The same class of defect, caught before a visitor meets it.
--
-- WHY THESE TWO AND NOT THE OTHER TWELVE THE ADVISOR LISTED. The advisor reports every unindexed
-- foreign key; most are on internal tables nothing hot reads (glossary_notes.term_id,
-- summary_verifications.summary_id, person_links.person_id). Adding an index costs write throughput
-- and storage forever, so only the ones on the public read path are taken here. votes.jurisdiction_id
-- is deliberately skipped too: it has ~4 distinct values, so an index on it would be ignored by the
-- planner in favour of a scan.

-- Every bill page's vote list. Includes vote_date so the ORDER BY is satisfied from the index and
-- the planner never needs a separate sort for the common case.
create index if not exists votes_bill_id_vote_date_idx
  on votes (bill_id, vote_date desc nulls last);

-- Every bill page's summary lookup. Composite in the order the query filters: bill_id then status.
-- A plain (bill_id) index would work; this one also serves the status filter without a recheck.
create index if not exists summaries_bill_id_status_idx
  on summaries (bill_id, status);

-- Verification after applying (both should report an Index Scan, not a Seq Scan):
--
--   explain analyze select * from public_votes
--     where bill_id = (select bill_id from votes where bill_id is not null limit 1);
--
--   explain analyze select id from summaries
--     where bill_id = (select bill_id from summaries limit 1) and status = 'published';
--
-- Reversal, if either turns out unwanted — index creation is one of the few genuinely cheap
-- migrations to undo, and nothing depends on these existing:
--
--   drop index if exists votes_bill_id_vote_date_idx;
--   drop index if exists summaries_bill_id_status_idx;
