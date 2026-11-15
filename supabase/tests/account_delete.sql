-- Deleting a hosted account and a workspace from the app (migration 0039): who may, what goes, what stays. A pgTAP
-- file, so `supabase test db` runs it; plain psql runs it too, inside one transaction that is rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/account_delete.sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- fixtures. e1 owns Works and e2 is a member there; e3 runs Quorum and owns Ops; e4 owns Paying, which has a live
-- subscription; e5 is in no workspace
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000e1', 'owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e2', 'member@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e3', 'operator@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e4', 'payer@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e5', 'loose@example.com', 'authenticated', 'authenticated');
insert into public.platform_owners (user_id) values ('00000000-0000-4000-8000-0000000000e3');
insert into public.workspaces (id, user_id, name) values
  ('01AD00000000000000000000WA', '00000000-0000-4000-8000-0000000000e1', 'Works'),
  ('01AD00000000000000000000WC', '00000000-0000-4000-8000-0000000000e3', 'Ops'),
  ('01AD00000000000000000000WD', '00000000-0000-4000-8000-0000000000e4', 'Paying');
update public.workspaces set stripe_subscription_id = 'sub_test', billing_status = 'active', plan = 'paid' where id = '01AD00000000000000000000WD';
insert into public.members (id, user_id, workspace_id, role) values
  ('01AD00000000000000000000M2', '00000000-0000-4000-8000-0000000000e2', '01AD00000000000000000000WA', 'member');
insert into public.notes (id, user_id, workspace_id, path) values
  ('01AD00000000000000000000N1', '00000000-0000-4000-8000-0000000000e1', '01AD00000000000000000000WA', 'owner.md'),
  ('01AD00000000000000000000N2', '00000000-0000-4000-8000-0000000000e2', '01AD00000000000000000000WA', 'member.md');
insert into public.chats (id, user_id, workspace_id) values
  ('01AD00000000000000000000C2', '00000000-0000-4000-8000-0000000000e2', '01AD00000000000000000000WA');
insert into public.attachments (id, user_id, workspace_id, object_path, name) values
  ('01AD00000000000000000000A1', '00000000-0000-4000-8000-0000000000e1', '01AD00000000000000000000WA', '01AD00000000000000000000WA/a1/owner.png', 'owner.png'),
  ('01AD00000000000000000000A2', '00000000-0000-4000-8000-0000000000e2', '01AD00000000000000000000WA', '01AD00000000000000000000WA/a2/member.png', 'member.png');

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);
$$;
create function pg_temp.as_postgres() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;

-- 1. nobody signed out may call them
select ok(not has_function_privilege('anon', 'public.delete_my_account()', 'execute'), 'anon cannot delete an account');
select ok(not has_function_privilege('anon', 'public.delete_workspace(public.ulid)', 'execute'), 'anon cannot delete a workspace');
select ok(not has_function_privilege('anon', 'public.account_delete_status()', 'execute'), 'anon cannot read the delete status');
select ok(not has_function_privilege('authenticated', 'public.account_is_platform_owner(uuid)', 'execute'), 'the helpers stay internal');

-- 2. the status the danger zone reads
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select is(public.account_delete_status(), jsonb_build_object('platform_owner', false, 'owned', jsonb_build_array(jsonb_build_object('id', '01AD00000000000000000000WA', 'name', 'Works'))), 'an owner sees the workspace they own');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select is(public.account_delete_status(), jsonb_build_object('platform_owner', false, 'owned', '[]'::jsonb), 'a member owns nothing');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3');
select is((public.account_delete_status() ->> 'platform_owner')::boolean, true, 'the platform owner is told so');

-- 3. the refusals
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select throws_like($$ select public.delete_my_account() $$, '%Delete the organization first%', 'an owner cannot delete their account');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select throws_like($$ select public.delete_workspace('01AD00000000000000000000WA') $$, '%Only the workspace owner%', 'a member cannot delete the workspace');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e5');
select throws_like($$ select public.delete_workspace('01AD00000000000000000000WA') $$, '%no longer exists%', 'an outsider learns nothing');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3');
select throws_like($$ select public.delete_my_account() $$, '%runs Quorum%', 'the platform owner cannot delete their account');
select throws_like($$ select public.delete_workspace('01AD00000000000000000000WC') $$, '%runs Quorum%', 'the platform owner cannot delete their workspace');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e4');
select throws_like($$ select public.delete_workspace('01AD00000000000000000000WD') $$, '%Cancel the subscription%', 'a live subscription is cancelled first');
select pg_temp.as_postgres();
select set_config('request.jwt.claims', '', true);
select throws_like($$ select public.delete_my_account() $$, '%sign in first%', 'a call without a user is refused');

-- 4. a member deletes their account: their rows go, the workspace and the owner's rows stay
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select is(public.delete_my_account() ->> 'ok', 'true', 'a member deletes their account');
select pg_temp.as_postgres();
select ok(not exists (select 1 from auth.users where id = '00000000-0000-4000-8000-0000000000e2'), 'the auth user is gone');
select ok(not exists (select 1 from public.members where user_id = '00000000-0000-4000-8000-0000000000e2'), 'and the membership');
select ok(not exists (select 1 from public.notes where id = '01AD00000000000000000000N2') and not exists (select 1 from public.chats where id = '01AD00000000000000000000C2'), 'and their notes and chats');
select is((select bucket from public.kb_files_trash where object_path = '01AD00000000000000000000WA/a2/member.png'), 'attachments', 'their attachment waits in the trash for the sweep');
select ok(exists (select 1 from public.workspaces where id = '01AD00000000000000000000WA') and exists (select 1 from public.notes where id = '01AD00000000000000000000N1'), 'the workspace and the owner''s notes stay');

-- 5. the owner deletes the workspace, then their account
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select is(public.delete_workspace('01AD00000000000000000000WA') ->> 'ok', 'true', 'the owner deletes the workspace');
select pg_temp.as_postgres();
select ok(not exists (select 1 from public.workspaces where id = '01AD00000000000000000000WA'), 'the workspace is gone');
select ok(not exists (select 1 from public.notes where workspace_id = '01AD00000000000000000000WA') and not exists (select 1 from public.knowledge_bases where workspace_id = '01AD00000000000000000000WA'), 'and its notes and knowledge bases');
select ok(exists (select 1 from public.kb_files_trash where object_path = '01AD00000000000000000000WA/a1/owner.png'), 'the trash outlives the workspace');
select ok(exists (select 1 from public.platform_audit where action = 'workspace_deleted' and detail ->> 'workspace' = '01AD00000000000000000000WA'), 'the delete is in the platform audit');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select is(public.delete_my_account() ->> 'ok', 'true', 'with no workspace left, the owner deletes their account');
select pg_temp.as_postgres();
select ok(not exists (select 1 from auth.users where id = '00000000-0000-4000-8000-0000000000e1'), 'and the auth user is gone');

select * from finish();
rollback;
