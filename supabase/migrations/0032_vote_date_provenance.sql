-- 0032: votes.vote_date_provenance — the receipt for a vote date that was NOT printed on the roll
-- call itself but derived from the same source's own dated, tallied history action.
--
-- Why: LegiScan prints every 2024 Missouri House floor roll call (275 of the session's 351) with
-- the missing-date sentinel 0000-00-00 — in the bulk dataset and from getRollCall alike (verified
-- live 2026-08-23) — and the date guard (legiscan-votes.js, assertRollCallDateWithinSession)
-- refused them all rather than invent a date. The bill's history in the same dataset prints the
-- floor actions with dates AND tallies ("2024-03-27 Third Read and Passed (H) - AYES: 108
-- NOES: 46"). Rule (Lance, 2026-08-23, Tier 1 only — never a stage-day guess): a sentinel-dated
-- roll call takes that action's date when EXACTLY ONE tallied action in the bill's whole history
-- prints its yea/nay, that action's acting chamber (the "(H)"/"(S)" suffix in the action text,
-- not LegiScan's unreliable history tag) is the roll call's chamber, and NO other roll call of the
-- same bill and chamber prints the same tally. The driver additionally refuses any derived date
-- that contradicts another derived date on the same House legislative day (the day number is
-- printed in the roll-call PDF link) or breaks legislative-day order.
--
-- Residual risk, measured (known-truth replay over every cached session with printed dates
-- blanked — CHATLOG 2026-08-23): the surviving disagreement class is a ONE-DAY journal skew
-- between the history action's date and the roll call's own date in a fraction of a percent of
-- replays; the legislative-day gate is the defense, and the receipt makes every derived date
-- auditable. A later dataset that prints a real date supersedes the derived one (the driver
-- updates vote_date and nulls this column).
--
-- Column: { source: 'legiscan_history_tally_match', printed_date: '0000-00-00',
--   legislative_day: 47 | null, action: { date, action, chamber, chamber_source } } verbatim.
-- NULL for every vote whose date was printed on the roll call (the overwhelming majority).
-- ingest-legiscan.js refuses to store a derived-date vote at all until this column exists
-- (isMissingColumnError gate, counted datesDerivedGated and closing the run 'partial'), so a
-- derived date can never land without its receipt.
--
-- Visibility: anon holds a TABLE-level select on votes (0001's anon_read policy; 0025 scoped only
-- summaries/glossary_terms), so this column is anon-readable on apply — acceptable, it is public
-- source text. The public views (public_votes / public_vote_feed, 0023/0031) list columns
-- explicitly and do NOT include it, so the site will serve the 185 derived dates without an
-- inline receipt until the view and bill page carry it — a captured TODO, not an oversight.
-- Draft-then-apply: Lance applies.

alter table votes add column if not exists vote_date_provenance jsonb;

comment on column votes.vote_date_provenance is
  'NULL when vote_date was printed on the roll call itself. Otherwise the receipt for a derived date: { source, printed_date, legislative_day, action: { date, action, chamber, chamber_source } } — see migration 0032 and src/adapters/legiscan-votes.js deriveDateFromHistory.';
