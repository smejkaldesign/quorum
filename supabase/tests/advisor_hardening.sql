-- The advisor fixes (migration 0043): anon and authenticated lost EXECUTE on trigger functions and internal helpers,
-- anon lost it on the policy helpers while authenticated kept it, the five functions have a fixed search_path, the
-- rewritten policies exist and call auth.uid() once per statement, and every public foreign key has a covering index.
-- Needs a database with every migration applied (supabase db reset on a local stack). Runs in one transaction that is
-- rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/advisor_hardening.sql
-- A failed check stops the script with the check's message; the last line printed on success is "advisor hardening: ok".
begin;

do $$
declare f text;
begin
  foreach f in array array[
    'public.add_workspace_owner()', 'public.auth_user_gate()', 'public.sync_profile()', 'public.kb_note_upstream_follow()',
    'public.workspace_connector_clear_overrides()', 'public.workspace_connector_drop_secret()', 'public.invites_daily_limit()',
    'public.kb_is_hosted(public.ulid)',
    'public.is_public_mail_domain(text)',
    'public.platform_passkey_ok()', 'public.platform_issue_access_code(text, text, integer, text)', 'public.platform_access_codes()'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% should not be executable by anon or authenticated', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then raise exception '% should stay executable by service_role', f; end if;
  end loop;

  foreach f in array array[
    'public.is_member(public.ulid)', 'public.is_admin(public.ulid)', 'public.is_owner(public.ulid)', 'public.shares_workspace(uuid)',
    'public.workspace_guardrails_set(public.ulid, jsonb)', 'public.platform_revoke_access_code(public.ulid)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% should not be executable by anon', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception '% should stay executable by authenticated', f; end if;
  end loop;

  foreach f in array array['public.access_code_needed(text)', 'public.access_code_claim(text, text)', 'public.public_flags()'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception '% is called before sign-in and must stay executable by anon', f; end if;
  end loop;

  -- no security definer function in public is left executable by anon apart from the three pre-sign-in ones
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
               and has_function_privilege('anon', p.oid, 'execute') and p.proname not in ('access_code_needed', 'access_code_claim', 'public_flags')) then
    raise exception 'a security definer function other than the pre-sign-in ones is executable by anon';
  end if;

  foreach f in array array['public.set_updated_at()', 'public.object_workspace(text)', 'public.connector_roles(text)',
                           'public.workspace_connector_public(public.workspace_connectors)', 'public.gen_access_code()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.proconfig @> array['search_path=""']) then
      raise exception '% should have an empty search_path', f;
    end if;
  end loop;
  if public.object_workspace('01J0000000000000000000000A/x.png')::text <> '01J0000000000000000000000A' then
    raise exception 'object_workspace should still read the workspace id from an object path';
  end if;
  if public.connector_roles('openai') <> array['speech', 'summary', 'notes', 'agent', 'voice'] then
    raise exception 'connector_roles should still list the roles of a provider';
  end if;
  if length(public.gen_access_code()) <> 8 then raise exception 'gen_access_code should still make an 8 character code'; end if;

  if (select count(*) from pg_policies where (schemaname, tablename, policyname) in (
        ('public', 'notes', 'notes_select'), ('public', 'notes', 'notes_update'), ('public', 'invites', 'invites_select'),
        ('public', 'chat_turns', 'chat_turns_insert'), ('public', 'connect_accounts', 'connect_accounts_own'),
        ('public', 'workspaces', 'workspaces_insert'), ('storage', 'objects', 'attachments_objects_select'))) <> 7 then
    raise exception 'a rewritten policy is missing';
  end if;
  if exists (select 1 from pg_policies
             where regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''), 'SELECT auth\.[a-z_]+\(\) AS [a-z_]+', '', 'g') ~ 'auth\.[a-z_]+\(\)') then
    raise exception 'a policy still calls an auth function once per row';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'invites' and policyname = 'invites_select' and qual ~ 'SELECT auth\.email\(\) AS email') then
    raise exception 'invites_select should read the email once per statement';
  end if;

  if exists (
    select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid
    where c.contype = 'f' and r.relnamespace = 'public'::regnamespace
      and not exists (select 1 from pg_index i where i.indrelid = c.conrelid
                        and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey and c.conkey @> (i.indkey::int2[])[0:cardinality(c.conkey) - 1])) then
    raise exception 'a foreign key in public has no covering index';
  end if;
end $$;

-- the rewritten notes policies still scope rows to the signed-in user, and anon gets a permission error from is_member
create function pg_temp.as_user(u uuid, email text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated', 'email', email)::text, true), set_config('role', 'authenticated', true);
$$;
create function pg_temp.as_admin_role() returns void language sql as $$ select set_config('request.jwt.claims', '', true), set_config('role', 'postgres', true); $$;
create temp table ids (k text primary key, v text);
grant all on ids to authenticated;
insert into public.access_codes (email, code, claimed_at, plan) values ('advisor-a@example.com', 'ADVSRKA2', now(), 'free'), ('advisor-b@example.com', 'ADVSRKB3', now(), 'free');
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000a1', 'advisor-a@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000b2', 'advisor-b@example.com', 'authenticated', 'authenticated');
update public.access_codes a set redeemed_at = now(), redeemed_by = u.id from auth.users u where u.email = a.email and a.redeemed_by is null;

select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1', 'advisor-a@example.com');
insert into ids select 'ws', w.id from public.create_workspace('Advisor', null, false) w;
insert into public.notes (id, user_id, workspace_id, path) select '01J0000000000000000000ADV1', '00000000-0000-4000-8000-0000000000a1', v, 'a.md' from ids where k = 'ws';
do $$
begin
  if (select count(*) from public.notes where id = '01J0000000000000000000ADV1') <> 1 then raise exception 'the author should read their own note'; end if;
end $$;

select pg_temp.as_user('00000000-0000-4000-8000-0000000000b2', 'advisor-b@example.com');
do $$
begin
  if exists (select 1 from public.notes where id = '01J0000000000000000000ADV1') then raise exception 'a non-member should not read the note'; end if;
  update public.notes set body = 'x' where id = '01J0000000000000000000ADV1';
  if found then raise exception 'a non-member should not update the note'; end if;
  begin
    insert into public.notes (id, user_id, workspace_id, path) select '01J0000000000000000000ADV2', '00000000-0000-4000-8000-0000000000b2', v, 'b.md' from ids where k = 'ws';
    raise exception 'a non-member insert should be refused';
  exception when insufficient_privilege then null;
  end;
end $$;

select pg_temp.as_admin_role();
set local role anon;
do $$
begin
  begin
    perform public.is_member('01J0000000000000000000ADV1');
    raise exception 'anon should not be able to call is_member';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select 'advisor hardening: ok';
rollback;
