-- Draft (Lance applies — draft-then-apply). The profile page's vote feed filters
-- public_vote_feed by legislator_id over 1.46M vote_casts rows; the only existing index is
-- unique(vote_id, legislator_id), which cannot serve a legislator-first lookup, so the anon
-- role's statement timeout kills the query (57014 — observed live on the Onder smoke,
-- 2026-07-30; 1.6s even under the service role). One index turns it into an index scan of a
-- legislator's own ~1-2k casts.
create index vote_casts_legislator_id_idx on vote_casts (legislator_id);
