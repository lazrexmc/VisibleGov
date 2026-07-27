insert into jurisdictions (id, name) values
  ('us-congress',    'United States Congress'),
  ('mo-legislature', 'Missouri General Assembly');

insert into sessions (jurisdiction_id, identifier, name, start_date) values
  ('us-congress', '119', '119th Congress', '2025-01-03');
-- MO sessions are inserted by the ingest CLI from OpenStates session data (Task 8/9),
-- so their identifiers exactly match the source of record.
