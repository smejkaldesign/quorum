-- Delete my data and the admin app's Reset user (migration 0047): what goes, what stays, who may. A pgTAP file, so
-- `supabase test db` runs it; plain psql runs it too, inside one transaction that is rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/delete_my_data.sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

-- fixtures. d1 owns Solo alone and is a member of Team, which d2 owns with d3 as a member; d4 runs Quorum; d5 owns
-- Paying alone, which has a live subscription; d6 owns Crowd, which d3 also belongs to
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
-- the passkey session is the admin app's header; this file stands in for it
create or replace function public.platform_passkey_ok() returns boolean language sql as $$ select true $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000d1', 'solo@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000d2', 'teamowner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000d3', 'teammate@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000d4', 'operator@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000d5', 'payer@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000d6', 'crowd@example.com', 'authenticated', 'authenticated');
insert into public.platform_owners (user_id) values ('00000000-0000-4000-8000-0000000000d4');
insert into public.workspaces (id, user_id, name, plan) values
  ('01DD00000000000000000000WS', '00000000-0000-4000-8000-0000000000d1', 'Solo', 'cloud'),
  ('01DD00000000000000000000WT', '00000000-0000-4000-8000-0000000000d2', 'Team', 'free'),
  ('01DD00000000000000000000WP', '00000000-0000-4000-8000-0000000000d5', 'Paying', 'paid'),
  ('01DD00000000000000000000WC', '00000000-0000-4000-8000-0000000000d6', 'Crowd', 'free');
update public.workspaces set stripe_subscription_id = 'sub_' || id, billing_status = 'active' where id in ('01DD00000000000000000000WS', '01DD00000000000000000000WP');
insert into public.members (id, user_id, workspace_id, role) values
  ('01DD00000000000000000000M1', '00000000-0000-4000-8000-0000000000d1', '01DD00000000000000000000WT', 'member'),
  ('01DD00000000000000000000M3', '00000000-0000-4000-8000-0000000000d3', '01DD00000000000000000000WT', 'member'),
  ('01DD00000000000000000000M4', '00000000-0000-4000-8000-0000000000d3', '01DD00000000000000000000WC', 'member')
  on conflict do nothing;
-- d1's notes: S1 in Solo; T1 private and T2 shared in Team. d3's own note T3 in Team must stay
insert into public.notes (id, user_id, workspace_id, path, frontmatter) values
  ('01DD00000000000000000000S1', '00000000-0000-4000-8000-0000000000d1', '01DD00000000000000000000WS', 'solo.md', '{}'),
  ('01DD00000000000000000000T1', '00000000-0000-4000-8000-0000000000d1', '01DD00000000000000000000WT', 'private.md', '{}'),
  ('01DD00000000000000000000T2', '00000000-0000-4000-8000-0000000000d1', '01DD00000000000000000000WT', 'shared.md', '{"visibility": "public"}'),
  ('01DD00000000000000000000T3', '00000000-0000-4000-8000-0000000000d3', '01DD00000000000000000000WT', 'theirs.md', '{}');
insert into public.knowledge_bases (id, workspace_id, name) values ('01DD00000000000000000000KS', '01DD00000000000000000000WS', 'Solo handbook');
insert into public.knowledge_bases (id, workspace_id, name, personal_user_id) values ('01DD00000000000000000000KP', '01DD00000000000000000000WT', 'Mine', '00000000-0000-4000-8000-0000000000d1');
insert into public.chats (id, user_id, workspace_id) values
  ('01DD00000000000000000000C1', '00000000-0000-4000-8000-0000000000d1', '01DD00000000000000000000WT'),
  ('01DD00000000000000000000C3', '00000000-0000-4000-8000-0000000000d3', '01DD00000000000000000000WT');
insert into public.meetings (id, user_id, workspace_id, title) values
  ('01DD00000000000000000000E1', '00000000-0000-4000-8000-0000000000d1', '01DD00000000000000000000WT', 'Standup'),
  ('01DD00000000000000000000E2', '00000000-0000-4000-8000-0000000000d1', '01DD00000000000000000000WS', 'Planning');
insert into public.attachments (id, user_id, workspace_id, object_path, name, note_id) values
  ('01DD00000000000000000000A1', '00000000-0000-4000-8000-0000000000d1', '01DD00000000000000000000WT', '01DD00000000000000000000WT/a1/mine.png', 'mine.png', '01DD00000000000000000000T1'),
  ('01DD00000000000000000000A2', '00000000-0000-4000-8000-0000000000d1', '01DD00000000000000000000WT', '01DD00000000000000000000WT/a2/shared.png', 'shared.png', '01DD00000000000000000000T2');

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);
$$;
create function pg_temp.as_postgres() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;

-- 1. who may call what
select ok(not has_function_privilege('anon', 'public.delete_my_data()', 'execute'), 'anon cannot delete data');
select ok(not has_function_privilege('anon', 'public.platform_reset_user(uuid, boolean, text)', 'execute'), 'anon cannot reset an account');
select ok(has_function_privilege('anon', 'public.account_gone(uuid)', 'execute'), 'a signed-out Mac can ask whether its account is gone');
select ok(not has_function_privilege('authenticated', 'public.account_hand_over(uuid)', 'execute'), 'the helpers stay internal');
select ok(not public.account_gone('00000000-0000-4000-8000-0000000000d1'), 'an account that exists is not gone');

-- 2. the platform owner is refused
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d4');
select throws_ok('select public.delete_my_data()', 'P0001', 'The account that runs Quorum cannot delete its data from the app', 'the platform owner is refused');

-- 3. d1 deletes their data
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select is((public.delete_my_data() ->> 'workspaces')::int, 1, 'one workspace had d1 alone');
select pg_temp.as_postgres();
select ok(exists (select 1 from auth.users where id = '00000000-0000-4000-8000-0000000000d1'), 'the account stays');
select ok(exists (select 1 from public.workspaces where id = '01DD00000000000000000000WS' and plan = 'cloud' and stripe_subscription_id is not null), 'the solo workspace stays with its plan and billing');
select ok(exists (select 1 from public.members where workspace_id = '01DD00000000000000000000WT' and user_id = '00000000-0000-4000-8000-0000000000d1'), 'the membership in Team stays');
select ok(not exists (select 1 from public.notes where workspace_id = '01DD00000000000000000000WS'), 'the solo workspace has no notes left');
select ok(not exists (select 1 from public.knowledge_bases where id = '01DD00000000000000000000KS'), 'the solo workspace knowledge base is gone');
select ok(not exists (select 1 from public.meetings where user_id = '00000000-0000-4000-8000-0000000000d1'), 'every meeting of d1 is gone');
select ok(not exists (select 1 from public.chats where user_id = '00000000-0000-4000-8000-0000000000d1'), 'every chat of d1 is gone');
select ok(not exists (select 1 from public.notes where id = '01DD00000000000000000000T1'), 'the private note is gone');
select is((select user_id from public.notes where id = '01DD00000000000000000000T2'), '00000000-0000-4000-8000-0000000000d2'::uuid, 'the shared note went to the owner');
select is((select user_id from public.attachments where id = '01DD00000000000000000000A2'), '00000000-0000-4000-8000-0000000000d2'::uuid, 'its attachment went with it');
select ok(not exists (select 1 from public.knowledge_bases where id = '01DD00000000000000000000KP'), 'the personal KB is gone');
select ok(exists (select 1 from public.notes where id = '01DD00000000000000000000T3') and exists (select 1 from public.chats where id = '01DD00000000000000000000C3'), 'another member keeps every row');
select ok(exists (select 1 from public.kb_files_trash where object_path = '01DD00000000000000000000WT/a1/mine.png' and bucket = 'attachments'), 'the private attachment object is in the trash');
select ok(not exists (select 1 from public.kb_files_trash where object_path = '01DD00000000000000000000WT/a2/shared.png'), 'the handed-over attachment object is not');

-- 4. Reset user, as the platform owner: refusals name the workspaces
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d4');
select is(public.platform_reset_user('00000000-0000-4000-8000-0000000000d2'), jsonb_build_object('ok', false, 'reason', 'shared', 'workspaces', jsonb_build_array('Team')), 'an owner of a shared workspace is refused with its name');
select is(public.platform_reset_user('00000000-0000-4000-8000-0000000000d5'), jsonb_build_object('ok', false, 'reason', 'billing', 'workspaces', jsonb_build_array('Paying')), 'a paying solo workspace is refused with its name');
select throws_ok($$select public.platform_reset_user('00000000-0000-4000-8000-0000000000d4')$$, 'P0001', 'The account that runs Quorum cannot be reset', 'the platform owner cannot be reset');
select throws_ok($$select public.platform_reset_user('00000000-0000-4000-8000-0000000000d3', true, 'gold')$$, 'P0001', 'A code grants the free or the cloud plan', 'an unknown plan is refused');

-- 5. Reset user d3: a member of two workspaces, owner of none; the reinvite issues a cloud code
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d4');
select ok((public.platform_reset_user('00000000-0000-4000-8000-0000000000d3', true, 'cloud') -> 'invite' ->> 'code') is not null, 'the reset answers with the new code');
select pg_temp.as_postgres();
select ok(public.account_gone('00000000-0000-4000-8000-0000000000d3'), 'the account is gone');
select ok(exists (select 1 from public.workspaces where id = '01DD00000000000000000000WC'), 'a workspace d3 only belonged to stays');
select ok(exists (select 1 from public.access_codes where email = 'teammate@example.com' and plan = 'cloud' and revoked_at is null), 'a cloud code waits for the same email');
select ok(exists (select 1 from public.platform_audit where action = 'reset_user' and detail ->> 'email' = 'teammate@example.com'), 'the reset is in the audit log');

-- 6. Reset user d1: Solo still has its subscription, so it is refused until billing ends; then Solo goes too
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d4');
select is(public.platform_reset_user('00000000-0000-4000-8000-0000000000d1') -> 'reason', '"billing"'::jsonb, 'a solo workspace that still pays holds the reset');
select pg_temp.as_postgres();
update public.workspaces set billing_status = 'canceled' where id = '01DD00000000000000000000WS';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d4');
select is(public.platform_reset_user('00000000-0000-4000-8000-0000000000d1') -> 'workspaces', jsonb_build_array('Solo'), 'the solo workspace goes with the account');
select pg_temp.as_postgres();
select ok(not exists (select 1 from public.workspaces where id = '01DD00000000000000000000WS') and public.account_gone('00000000-0000-4000-8000-0000000000d1'), 'both are gone');

select * from finish();
rollback;
