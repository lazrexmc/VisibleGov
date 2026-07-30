-- Draft (Lance applies — draft-then-apply). Apply-time finding (2026-07-30): calling
-- refresh_vote_aggregates() through the REST rpc endpoint dies at ~8s with 57014 — the
-- role-level statement timeout PostgREST requests run under — while a full CONCURRENTLY
-- refresh of three matviews over 1.46M vote_casts legitimately needs longer. A function-level
-- setting overrides the role timeout for this function's execution only; nothing else changes.
-- (The CONCURRENTLY-in-function concern from review did NOT fire — the function executes.)
alter function refresh_vote_aggregates() set statement_timeout = '600s';
