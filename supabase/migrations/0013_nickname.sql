-- Draft (Lance applies — draft-then-apply, same precedent as 0008-0012). Identity-merge amendment
-- (.superpowers/sdd/2026-07-29-identity-merge/progress.md, last entry, controller ruling on fix
-- round 2's cost): the unconditional full-name-variant gate correctly stops surname-only merges
-- but split the real four-Onder rows into TWO persons (Robert-form vs Bob-form) because LegiScan's
-- own printed `person.nickname` field ('Bob' on people_id 16351) was resolved at INGEST time
-- (src/adapters/legiscan-identity.js's buildLegiscanNameVariants, used only for the single-
-- candidate DB lookup) but never PERSISTED onto the `legislators` row itself — so the whole-table
-- cluster pass (src/lib/person-identity.js's clusterLegislators) has no way to see it.
--
-- nickname: the SOURCE-PRINTED nickname only (e.g. LegiScan's own `person.nickname` field, verified
-- real: people_id 16351 carries `nickname:"Bob"` alongside `name:"Robert Onder"`) — NEVER inferred,
-- NEVER a nickname table this codebase invents or looks up (CONTROLLER RULING 3 stands: still zero
-- fuzzy/edit-distance matching anywhere). Backfilled by src/cli/backfill-nicknames.js from the
-- cached LegiScan dataset ZIPs, additive-patch only (never overwrites an existing value). Consumed
-- by clusterLegislators as an additional exact-match given-name variant, scoped to rows that already
-- cleared the surname-derived candidate gate — this fixes the whole Onder-shaped class (any source
-- row printing a nickname bridges to its own given-name form) without ever becoming a generic
-- cross-surname nickname lookup.
alter table legislators add column nickname text;
comment on column legislators.nickname is
  'Source-printed nickname only (e.g. LegiScan person.nickname) — never inferred. Used by identity clustering (src/lib/person-identity.js) as an exact-match given-name variant, never fuzzy-matched.';
