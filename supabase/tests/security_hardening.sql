-- Security hardening (migration 0038): the workspace billing guard, domain claims, the invite gate and its daily
-- limit, per-user chats and settings, and attachment objects in Storage. Needs a database with every migration
-- applied (supabase db reset on a local stack). Everything runs in one transaction that is rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/security_hardening.sql
-- A failed check stops the script with the check's message; the last line printed on success is "security hardening: ok".
begin;

create function pg_temp.as_user(u uuid, email text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated', 'email', email)::text, true), set_config('role', 'authenticated', true);
$$;
create function pg_temp.as_service() returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true), set_config('role', 'service_role', true);
$$;
create function pg_temp.as_admin_role() returns void language sql as $$ select set_config('request.jwt.claims', '', true), set_config('role', 'postgres', true); $$;
-- a security definer function runs as postgres with the caller's claims; this is that state, for the trigger checks
create function pg_temp.as_definer_for(u uuid, email text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated', 'email', email)::text, true), set_config('role', 'postgres', true);
$$;
create function pg_temp.expect_error(stmt text, pattern text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then
    if sqlerrm !~* pattern then raise exception 'expected an error like "%" from %, got "%"', pattern, stmt, sqlerrm; end if;
    return;
  end;
  raise exception 'expected an error like "%" from %, it ran', pattern, stmt;
end $$;
create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'check failed: %', what; end if; end $$;
create temp table ids (k text primary key, v text);
grant all on ids to authenticated, service_role;
create function pg_temp.id(name text) returns text language sql as $$ select v from ids where k = name $$;

-- fixtures. Every sign-up goes through the real gate with a claimed access code. e1 owns Acme; e2 is a member of
-- Acme; e3 is the platform owner; e4 holds a cloud code. All addresses are on acme.test except e3.
insert into public.access_codes (email, code, claimed_at, plan) values
  ('owner@acme.test', 'AAAAAAA2', now(), 'free'),
  ('member@acme.test', 'AAAAAAA3', now(), 'free'),
  ('platform@quorum.test', 'AAAAAAA4', now(), 'free'),
  ('cloud@acme.test', 'AAAAAAA5', now(), 'cloud');
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000e1', 'owner@acme.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e2', 'member@acme.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e3', 'platform@quorum.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e4', 'cloud@acme.test', 'authenticated', 'authenticated');
insert into public.platform_owners (user_id) values ('00000000-0000-4000-8000-0000000000e3');

-- 1. create_workspace still works, and a domain that is not the caller's email domain is refused (P1-4)
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', 'owner@acme.test');
insert into ids select 'ws', w.id from public.create_workspace('Acme', 'acme.test', true) w;
select pg_temp.check((select plan = 'free' and domain = 'acme.test' and domain_join from public.workspaces where id = pg_temp.id('ws')), 'create_workspace makes a free workspace with the caller''s domain');
select pg_temp.expect_error($$select public.create_workspace('Other Co', 'other.test', true)$$, 'domain of your own email');

-- 2. an owner cannot set the plan, seats or a Stripe id on their own workspace, directly or by inserting one (P0-1)
select pg_temp.expect_error(format($$update public.workspaces set plan = 'internal' where id = %L$$, pg_temp.id('ws')), 'permission denied');
select pg_temp.expect_error(format($$update public.workspaces set stripe_customer_id = 'cus_victim' where id = %L$$, pg_temp.id('ws')), 'permission denied');
select pg_temp.expect_error($$insert into public.workspaces (id, user_id, name, plan, seats) values (public.gen_ulid(), '00000000-0000-4000-8000-0000000000e1', 'Free hours', 'internal', 10000)$$, 'permission denied');
-- the trigger holds even inside a security definer path that did not set the billing flag
select pg_temp.as_definer_for('00000000-0000-4000-8000-0000000000e1', 'owner@acme.test');
select pg_temp.expect_error(format($$update public.workspaces set plan = 'internal' where id = %L$$, pg_temp.id('ws')), 'billing');
select pg_temp.expect_error(format($$update public.workspaces set stripe_subscription_id = 'sub_victim' where id = %L$$, pg_temp.id('ws')), 'billing');
select pg_temp.expect_error($$insert into public.workspaces (id, user_id, name, hour_packs) values (public.gen_ulid(), '00000000-0000-4000-8000-0000000000e1', 'Packs', 100)$$, 'billing');
select pg_temp.expect_error(format($$update public.workspaces set domain = 'other.test' where id = %L$$, pg_temp.id('ws')), 'domain of your own email');
-- other columns still change on that path
update public.workspaces set team_enabled = true where id = pg_temp.id('ws');
select pg_temp.check((select team_enabled and plan = 'free' and stripe_customer_id is null from public.workspaces where id = pg_temp.id('ws')), 'a non-billing column still updates');

-- 3. the relay's service role still writes billing columns
select pg_temp.as_service();
update public.workspaces set seats = 3, hour_packs = 1, stripe_customer_id = 'cus_test' where id = pg_temp.id('ws');
select pg_temp.check((select seats = 3 and hour_packs = 1 and stripe_customer_id = 'cus_test' from public.workspaces where id = pg_temp.id('ws')), 'the service role sets billing columns');

-- 4. the cloud access-code grant still puts the new workspace on the cloud plan
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e4', 'cloud@acme.test');
insert into ids select 'cloud-ws', w.id from public.create_workspace('Cloud', null, true) w;
select pg_temp.as_admin_role();
select pg_temp.check((select plan = 'cloud' and seats_included = 1 from public.workspaces where id = pg_temp.id('cloud-ws')), 'a cloud code grants the cloud plan');
select pg_temp.check((select granted_workspace_id::text = pg_temp.id('cloud-ws') from public.access_codes where email = 'cloud@acme.test'), 'the code records the workspace it granted');
select pg_temp.check(current_setting('quorum.billing_write', true) is distinct from 'on', 'the billing flag is off again after the grant');

-- 5. the platform owner's plan functions still write the plan
insert into ids select 'cloud-code', id from public.access_codes where email = 'cloud@acme.test';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3', 'platform@quorum.test');
select public.platform_set_code_plan(pg_temp.id('cloud-code')::public.ulid, 'free');
select public.platform_set_plan(pg_temp.id('ws')::public.ulid, 'paid', 2, 'pilot');
select pg_temp.as_admin_role();
select pg_temp.check((select plan = 'free' from public.workspaces where id = pg_temp.id('cloud-ws')), 'platform_set_code_plan moves the granted workspace');
select pg_temp.check((select plan = 'paid' and seats_included = 2 and notes = 'pilot' from public.workspaces where id = pg_temp.id('ws')), 'platform_set_plan sets plan, seats included and notes');

-- 6. a member cannot read, change or extend another member's chats; personal settings are their owner's only (P1-5)
insert into public.members (id, user_id, workspace_id, role) values (public.gen_ulid(), '00000000-0000-4000-8000-0000000000e2', pg_temp.id('ws'), 'member');
insert into ids values ('chat', public.gen_ulid()), ('turn', public.gen_ulid()), ('set-user', public.gen_ulid()), ('set-ws', public.gen_ulid());
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2', 'member@acme.test');
insert into public.chats (id, user_id, workspace_id, title) values (pg_temp.id('chat'), auth.uid(), pg_temp.id('ws'), 'Private question');
insert into public.chat_turns (id, user_id, workspace_id, chat_id, question, answer) values (pg_temp.id('turn'), auth.uid(), pg_temp.id('ws'), pg_temp.id('chat'), 'What did the board say?', 'Quote from a private note');
insert into public.settings (id, user_id, workspace_id, scope, data) values (pg_temp.id('set-user'), auth.uid(), pg_temp.id('ws'), 'user', '{"model":"mine"}');
select pg_temp.check((select count(*) from public.chats where workspace_id = pg_temp.id('ws')) = 1, 'the author reads their chat');
select pg_temp.expect_error(format($$insert into public.settings (id, user_id, workspace_id, scope) values (public.gen_ulid(), auth.uid(), %L, 'workspace')$$, pg_temp.id('ws')), 'row-level security');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', 'owner@acme.test');
select pg_temp.check((select count(*) from public.chats where workspace_id = pg_temp.id('ws')) = 0, 'another member reads no chat');
select pg_temp.check((select count(*) from public.chat_turns where workspace_id = pg_temp.id('ws')) = 0, 'another member reads no chat turn');
select pg_temp.check((select count(*) from public.settings where workspace_id = pg_temp.id('ws') and scope = 'user') = 0, 'another member reads no personal settings');
update public.chats set title = 'changed' where id = pg_temp.id('chat');
delete from public.chat_turns where id = pg_temp.id('turn');
select pg_temp.expect_error(format($$insert into public.chat_turns (id, user_id, workspace_id, chat_id, question) values (public.gen_ulid(), auth.uid(), %L, %L, 'mine now')$$, pg_temp.id('ws'), pg_temp.id('chat')), 'row-level security');
insert into public.settings (id, user_id, workspace_id, scope, data) values (pg_temp.id('set-ws'), auth.uid(), pg_temp.id('ws'), 'workspace', '{"stop":["x"]}');
select pg_temp.as_admin_role();
select pg_temp.check((select title = 'Private question' from public.chats where id = pg_temp.id('chat')), 'another member cannot change the chat');
select pg_temp.check((select count(*) from public.chat_turns where id = pg_temp.id('turn')) = 1, 'another member cannot delete the turn');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2', 'member@acme.test');
select pg_temp.check((select count(*) from public.settings where workspace_id = pg_temp.id('ws') and scope = 'workspace') = 1, 'members read the workspace settings row');
update public.settings set data = '{"stop":[]}' where id = pg_temp.id('set-ws');
select pg_temp.as_admin_role();
select pg_temp.check((select data = '{"stop":["x"]}'::jsonb from public.settings where id = pg_temp.id('set-ws')), 'a plain member cannot change the workspace settings row');

-- 7. attachment objects are the uploader's, the row owner's, or a reader's of the note (P1-6)
insert into ids values ('att', public.gen_ulid());
insert into ids select 'obj', pg_temp.id('ws') || '/' || pg_temp.id('att') || '/board.pdf';
insert into storage.objects (bucket_id, name, owner, owner_id) values ('attachments', pg_temp.id('obj'), '00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000e2');
insert into public.attachments (id, user_id, workspace_id, object_path, name, chat_id) values (pg_temp.id('att'), '00000000-0000-4000-8000-0000000000e2', pg_temp.id('ws'), pg_temp.id('obj'), 'board.pdf', pg_temp.id('chat'));
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2', 'member@acme.test');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'attachments' and name = pg_temp.id('obj')) = 1, 'the uploader reads the object');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', 'owner@acme.test');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'attachments') = 0, 'another member lists no attachment object');
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'attachments' and name = pg_temp.id('obj');
select pg_temp.as_admin_role();
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'attachments' and name = pg_temp.id('obj')) = 1, 'another member cannot delete the object');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2', 'member@acme.test');
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'attachments' and name = pg_temp.id('obj');
select pg_temp.as_admin_role();
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'attachments' and name = pg_temp.id('obj')) = 0, 'the uploader deletes the object');

-- 8. an invite admits a sign-up only from a workspace on a live plan (P1-3)
insert into ids select 'free-ws', (select id from public.workspaces where id = pg_temp.id('cloud-ws'));
insert into public.invites (id, user_id, workspace_id, email) values (public.gen_ulid(), '00000000-0000-4000-8000-0000000000e4', pg_temp.id('free-ws'), 'alt1@acme.test');
select pg_temp.expect_error($$insert into auth.users (id, email, aud, role) values ('00000000-0000-4000-8000-0000000000e5', 'alt1@acme.test', 'authenticated', 'authenticated')$$, 'access code is needed');
insert into public.invites (id, user_id, workspace_id, email) values (public.gen_ulid(), '00000000-0000-4000-8000-0000000000e1', pg_temp.id('ws'), 'colleague@acme.test');
insert into auth.users (id, email, aud, role) values ('00000000-0000-4000-8000-0000000000e6', 'colleague@acme.test', 'authenticated', 'authenticated');
select pg_temp.check((select count(*) from auth.users where email = 'colleague@acme.test') = 1, 'an invite from a paid workspace admits the sign-up');

-- 9. one workspace sends at most 50 invites a day (P1-3)
insert into public.invites (id, user_id, workspace_id, email)
  select public.gen_ulid(), '00000000-0000-4000-8000-0000000000e1', pg_temp.id('ws'), 'bulk' || n || '@acme.test' from generate_series(1, 49) n;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', 'owner@acme.test');
select pg_temp.expect_error(format($$select public.invite_member(%L, 'one-more@acme.test')$$, pg_temp.id('ws')), '50 invites today');

select pg_temp.as_admin_role();
select 'security hardening: ok';
rollback;
