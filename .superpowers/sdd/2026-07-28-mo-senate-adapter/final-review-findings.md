# Final whole-branch review findings (workflow wf_a41a3805-e7b, 16 agents, adversarially verified)

Six confirmed issues, ALL outside per-task-review coverage; 3 of 6 live in the un-reviewed
hotfix commits 530be8b/1af1741 (controller lesson: hotfixes bypassed SDD task review).

1. CRITICAL — unbounded selects truncate at Supabase's 1000-row cap (live-verified on THIS
   instance per ingest-mo-house.js:829-836's own comment): auto-publish-glossary.js:106-120
   loadLatestVerifications + review server.js:296-298/442-446/462-467. Past 1000 rows, "latest
   verification" computes over an arbitrary subset → newest FLAGGED row can be invisible →
   auto-publish publishes a flagged gloss claiming clean; created_at-ASC queue select drops the
   NEWEST terms. FIX: .range() pagination loops (the ingest-mo-house pattern), assert-loud if a
   page returns full at the end without terminating.
2. CRITICAL (latent) — pickRosterSource (ingest-mo-senate.js:126-135) falls back to TODAY's
   live roster for every year except 2018 → a --year 2020 run would resolve 2020 casts against
   2026 members (4th cross-era misattribution channel) and poison the closed-year cache. FIX:
   HARD REFUSAL for any historical year absent from SENATE_ROSTER_ARCHIVE_URLS, honest message.
3. IMPORTANT — auto-publish eligibility not bound to the verified TEXT: a post-verification
   gloss edit auto-publishes unverified text. RULING (no migration; 0007 is applied): exclude
   terms whose newest glossary_notes edit-action postdates the latest verification's created_at;
   content-hash binding can come later via migration if wanted.
4. IMPORTANT — driver main() dereferences result.attribution unconditionally; a day's fetch
   failure crashes the run with TypeError, masking the real error and dropping run detail;
   fetchFailure never counted. FIX: guard aggregation, fold fetchFailure into failures, test.
5. IMPORTANT — only parse failures quarantine; dead PDF link or corrupt PDF (extractJournalText
   throws outside the try) wedges the FIFO worklist forever. FIX: route fetch failures +
   extraction throws through the same attempts/quarantine artifact mechanism.
6. IMPORTANT — page.html computeGlossaryGroups drops clean-verified and unverified glossed
   drafts from every bucket and count (contradicts its own comment). FIX: exhaustive buckets
   (add 'clean — awaiting auto-publish' + fold unverified-glossed visibly), move bucketing to a
   testable module.
