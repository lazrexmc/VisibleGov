-- 0038: codify the `ensure_rls` event trigger, and stop handing its function out to the public.
--
-- FOUND BY: the 2026-08-29 audit, via Supabase's security advisor —
--   "Function public.rls_auto_enable() can be executed by the anon role as a SECURITY DEFINER
--    function via /rest/v1/rpc/rls_auto_enable."
--
-- TWO SEPARATE PROBLEMS, one migration. The second is the more serious of the two.
--
-- ---------------------------------------------------------------------------
-- PROBLEM 1 (the advisor's): EXECUTE is granted to PUBLIC.
--
-- Measured ACL on 2026-08-29:
--   {=X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/postgres,
--    service_role=X/postgres}
-- The leading `=X/postgres` is the real cause: EXECUTE to PUBLIC, which every role inherits.
-- The explicit anon/authenticated entries are the same grant spelled out again.
--
-- NOT EXPLOITABLE TODAY, and that was verified rather than assumed. The function returns
-- `event_trigger`, a pseudo-type no ordinary call can produce, so PostgREST refuses it:
--
--   POST /rest/v1/rpc/rls_auto_enable
--   -> HTTP 400  {"code":"0A000","message":"cannot display a value of type event_trigger"}
--
-- It is still worth revoking, for the same reason 0036 and 0037 were: a SECURITY DEFINER function
-- that performs DDL should not be reachable by an anonymous role at all, and "the return type
-- happens to save us" is a property of PostgREST's serializer, not a decision this project made.
-- Defence belongs in the privilege layer, where it does not depend on somebody else's error path.
--
-- ---------------------------------------------------------------------------
-- PROBLEM 2 (found while checking problem 1, and the reason this migration CREATES anything):
-- THE TRIGGER IS NOT IN THIS REPO AT ALL.
--
--   grep -rl rls_auto_enable supabase/ src/ scripts/   ->   no matches
--   pg_event_trigger                                   ->   evtname 'ensure_rls', owner `postgres`
--
-- Every other event trigger on this database is owned by `supabase_admin` (pgrst_ddl_watch,
-- issue_pg_cron_access, ...) — platform-managed, not ours. `ensure_rls` is owned by `postgres`,
-- so it was created by hand against this project and never written down.
--
-- That matters because docs/DISASTER_RECOVERY.md rebuilds this database from `supabase/migrations`
-- alone. A rebuilt VisibleGov would come up WITHOUT this trigger, and the protection it provides —
-- automatically enabling RLS on every new public table — would be silently absent on exactly the
-- day everything else is being restored under pressure. An undocumented safety net is one nobody
-- knows has gone.
--
-- It also makes the revoke unsafe to ship on its own: `revoke ... on function rls_auto_enable()`
-- ERRORS if the function does not exist, so a revoke-only 0038 would break the cold-rebuild path
-- it is meant to protect. Hence create-then-revoke, both idempotent.
--
-- ---------------------------------------------------------------------------
-- FIDELITY: the function body below is `pg_get_functiondef()` output taken verbatim from the live
-- database on 2026-08-29, not a reconstruction from memory. Applying this to the CURRENT database
-- is therefore a no-op on behaviour — same body, same SECURITY DEFINER, same
-- `SET search_path = pg_catalog` (which is what stops a search_path attack on a definer function).
-- Its only effects here are the revokes. On a REBUILD it is what puts the trigger back.
--
-- SHAPE: `create or replace function` is idempotent on its own. `create event trigger` has no
-- OR REPLACE form, so it is guarded by a catalog check rather than drop+create — dropping and
-- recreating would leave a window, however brief, in which a concurrently-created table gets no
-- RLS, which is precisely the failure this trigger exists to prevent.
--
-- VERIFY AFTER APPLYING:
--   npm run verify:migrations          -- the 0038 row must read OK
--   -- and the advisor warning for rls_auto_enable should clear on its next refresh.
--
-- Draft-then-apply: Lance applies.

create or replace function public.rls_auto_enable()
 returns event_trigger
 language plpgsql
 security definer
 set search_path to 'pg_catalog'
as $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

-- Recreate the trigger only if it is genuinely absent (a cold rebuild). On the live database this
-- block does nothing, which is the point: no drop, no gap.
do $$
begin
  if not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    create event trigger ensure_rls
      on ddl_command_end
      execute function public.rls_auto_enable();
  end if;
end
$$;

-- The actual fix. PUBLIC first — it is the grant every role inherits; the named revokes below it
-- clear the explicit entries the ACL also carried. Revoking EXECUTE does NOT stop the event
-- trigger from firing: an event trigger is invoked by the DDL machinery as its owner, and never
-- through a caller's EXECUTE privilege. Nothing legitimate calls this function by name.
revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.rls_auto_enable() from anon;
revoke execute on function public.rls_auto_enable() from authenticated;
