-- Draft (Lance applies — draft-then-apply). Adds the MO Senate identity key so the mo-senate
-- adapter's roster ingestion can persist legislators, mirroring the existing per-source
-- identity-key pattern (bioguide_id for us-congress, openstates_id for mo-legislature,
-- mo_house_id for mo-house).
--
-- The senator's district number as text ('1'..'34') is the stable per-session identity
-- the senate.mo.gov roster page prints. Identity merge across source systems (bioguide/
-- openstates/mo_house/mo_senate rows for the same person, e.g. Onder) remains TODO item 8 —
-- this column does NOT attempt it.
--
-- Until this is applied, the mo-senate adapter detects the resulting PostgREST
-- "column not found" error (PGRST204) via isMissingColumnError (src/lib/db.js) and skips
-- member persistence with an honest note in run detail. bills/actions/votes persistence is
-- unaffected — those tables need no new columns.
alter table legislators add column mo_senate_id text;
create unique index legislators_mo_senate_id_uidx on legislators (mo_senate_id) where mo_senate_id is not null;
