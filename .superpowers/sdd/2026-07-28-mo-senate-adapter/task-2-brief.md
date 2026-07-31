### Task 2: Migration 0008 — `mo_senate_id` identity column (draft; Lance applies)

**Files:**
- Create: `supabase/migrations/0008_mo_senate_id.sql`
- Test: extend `tests/` migration-shape test conventions if present for 0005 (mirror them; else skip test)

Mirror migration 0005's `mo_house_id` exactly:

```sql
-- MO Senate identity key: the senator's district number as text ('1'..'34'), the stable
-- per-session identity the senate.mo.gov roster page prints. Same pattern as 0005's
-- mo_house_id. Identity merge across source systems (bioguide/openstates/mo_house/mo_senate
-- rows for the same person, e.g. Onder) remains TODO item 8 - this column does NOT attempt it.
alter table legislators add column mo_senate_id text;
create unique index legislators_mo_senate_id_uidx on legislators (mo_senate_id) where mo_senate_id is not null;
```

- [ ] Write SQL exactly as above (adjust only if 0005's actual file uses a different naming convention — read it first and mirror it) → commit `feat: migration 0008 - mo_senate_id identity column (draft; Lance applies)`.

**Produces:** the identity column every cast write gates on. NOT applied until Lance runs it — Task 5's driver must behave honestly without it.

