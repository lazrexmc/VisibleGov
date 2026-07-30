-- Draft (Lance applies — draft-then-apply). Widen bill_sponsors.sponsor_type to LegiScan's
-- actual printed sponsor-type vocabulary. The first live dry-run (2026-07-29) found 8,124 of
-- 45,792 MO sponsorships (~18%) carry types beyond primary/cosponsor — LegiScan's own
-- ls_sponsor_type lookup includes Joint Sponsor and an unspecified/generic type. Facts-only:
-- store what the source printed, mapped mechanically; never discard real sponsorship data
-- because our enum guessed too narrow.
alter table bill_sponsors drop constraint bill_sponsors_sponsor_type_check;
alter table bill_sponsors add constraint bill_sponsors_sponsor_type_check
  check (sponsor_type in ('primary','cosponsor','joint','unspecified'));
