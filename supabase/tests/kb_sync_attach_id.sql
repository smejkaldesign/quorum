-- Connector folder sync, second step (migration 0033): an attach sent twice with the same attach id makes one
-- attachment and does not touch the token again; the relay's own grants are listed for the person who holds them,
-- with no token; Disconnect for such a grant pauses or removes its attachments and queues the provider revoke. Needs a
-- database with every migration applied. Everything runs in one transaction that is rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/kb_sync_attach_id.sql
-- On a stack that has migrations up to 0032 only, put the migration inside the same transaction:
--   { echo 'begin;'; cat supabase/migrations/0033_kb_sync_attach_id.sql; grep -v '^begin;$' supabase/tests/kb_sync_attach_id.sql; } | docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- A failed check stops the script with the check's message; the last line printed on success is "kb sync attach id: ok".
begin;

-- fixtures. s1 owns the workspace; s2 is a member made admin of the KB; s3 is a member who reads it; s4 is outside
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000f1', 'sync-owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000f2', 'sync-admin@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000f3', 'sync-reader@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000f4', 'sync-outsider@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name, team_enabled, plan) values ('01KF00000000000000000000WS', '00000000-0000-4000-8000-0000000000f1', 'Sync Team', true, 'paid');
insert into public.members (id, user_id, workspace_id, role) values
  ('01KF00000000000000000000M2', '00000000-0000-4000-8000-0000000000f2', '01KF00000000000000000000WS', 'member'),
  ('01KF00000000000000000000M3', '00000000-0000-4000-8000-0000000000f3', '01KF00000000000000000000WS', 'member');

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);
$$;
create function pg_temp.as_service() returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true), set_config('role', 'service_role', true);
$$;
create function pg_temp.as_admin_role() returns void language sql as $$ select set_config('request.jwt.claims', '', true), set_config('role', 'postgres', true); $$;
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

-- 1. the owner makes a KB, gives s2 admin and s3 reader, and approves Google Drive and GitHub for the workspace
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');

select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'kb', public.kb_create('01KF00000000000000000000WS', 'Handbook') ->> 'id';
select public.workspace_integration_save('01KF00000000000000000000WS', 'github', 'personal', '{}', null);

-- 1. the same attach twice: one attachment, the stored token untouched by the retry
select pg_temp.as_service();
insert into ids select 'a1', public.kb_sync_attach('00000000-0000-4000-8000-0000000000f1', pg_temp.id('kb'), null, 'github', 'octo/handbook', 'folder', '{}', 'octo/handbook', null, 'gh-rt-first', 'quorum', false, null, 'attach-0001-aaaa') ->> 'id';
select pg_temp.check((public.kb_sync_attach('00000000-0000-4000-8000-0000000000f1', pg_temp.id('kb'), null, 'github', 'octo/handbook', 'folder', '{}', 'octo/handbook', null, 'gh-rt-retry', 'quorum', false, null, 'attach-0001-aaaa') ->> 'id') = pg_temp.id('a1'), 'a retry answers the same attachment');
select pg_temp.check((select refresh_token from public.kb_sync_token(pg_temp.id('a1'))) = 'gh-rt-first', 'the retry does not replace the token');
select pg_temp.check((select count(*) from public.kb_attachments where attach_id = 'attach-0001-aaaa') = 1, 'one attachment');
select pg_temp.check((public.kb_sync_attachment_by_attach_id('00000000-0000-4000-8000-0000000000f1', 'attach-0001-aaaa') ->> 'id') = pg_temp.id('a1'), 'the relay finds it by its attach id');
select pg_temp.check(public.kb_sync_attachment_by_attach_id('00000000-0000-4000-8000-0000000000f2', 'attach-0001-aaaa') is null, 'only for the person who attached');
select pg_temp.expect_error($$select public.kb_sync_attach('00000000-0000-4000-8000-0000000000f2', (select v from ids where k = 'kb'), null, 'github', 'octo/other', 'folder', '{}', 'x', null, 'gh-x', 'quorum', false, null, 'attach-0001-aaaa')$$, 'taken|only the knowledge base');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select pg_temp.check((public.kb_attachments_list(pg_temp.id('kb')) -> 0 ->> 'attach_id') = 'attach-0001-aaaa', 'the admin list carries the attach id');
select pg_temp.expect_error($$select public.kb_sync_attachment_by_attach_id('00000000-0000-4000-8000-0000000000f1', 'attach-0001-aaaa')$$, 'permission denied|only the relay');

-- 2. the caller's own grants, with their attachments and no token
select pg_temp.check(jsonb_array_length(public.kb_sync_my_grants('01KF00000000000000000000WS')) = 1, 'the owner sees one grant');
select pg_temp.check((public.kb_sync_my_grants('01KF00000000000000000000WS') -> 0 ->> 'provider') = 'github', 'the GitHub grant');
select pg_temp.check((public.kb_sync_my_grants('01KF00000000000000000000WS') -> 0 -> 'attachments' -> 0 ->> 'kb_name') = 'Handbook', 'with its attachment and KB');
select pg_temp.check(public.kb_sync_my_grants('01KF00000000000000000000WS')::text !~ 'gh-rt', 'never the token');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f3');
select pg_temp.check(jsonb_array_length(public.kb_sync_my_grants('01KF00000000000000000000WS')) = 0, 'another member sees none of it');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f4');
select pg_temp.expect_error($$select public.kb_sync_my_grants('01KF00000000000000000000WS')$$, 'not a member');

-- 3. Disconnect with pause: the attachment pauses with a sentence, its note stays, the grant waits for its revoke
select pg_temp.as_admin_role();
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id)
  values ('01KF000000000000000000NG01', '00000000-0000-4000-8000-0000000000f1', '01KF00000000000000000000WS', 'Knowledge bases/Handbook/intro.md',
    jsonb_build_object('visibility', 'public', 'kb_source', 'https://github.com/octo/handbook/blob/main/intro.md', 'kb_attachment', pg_temp.id('a1')), '# Intro', 'h', pg_temp.id('kb'));
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select pg_temp.check((public.kb_sync_grant_disconnect('01KF00000000000000000000WS', 'github', 'pause') ->> 'paused') = '1', 'one attachment paused');
select pg_temp.as_admin_role();
select pg_temp.check((select status = 'paused' and grant_id is not null and error like 'Paused because its sign-in%' from public.kb_attachments where id = pg_temp.id('a1')), 'paused with the reason');
select pg_temp.check((select deleted_at is null from public.notes where id = '01KF000000000000000000NG01'), 'its note stays');
select pg_temp.check((select revoke_pending and ended_reason = 'disconnected' from public.kb_sync_grants where user_id = '00000000-0000-4000-8000-0000000000f1' and provider = 'github'), 'the grant waits for its revoke');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select pg_temp.check(jsonb_array_length(public.kb_sync_my_grants('01KF00000000000000000000WS')) = 0, 'an ended grant is no longer listed');
select pg_temp.expect_error($$select public.kb_sync_grant_disconnect('01KF00000000000000000000WS', 'github', 'pause')$$, 'no longer there');

-- 4. Disconnect with remove: a new grant and attachment; removing takes the note out of the KB
select pg_temp.as_service();
insert into ids select 'a2', public.kb_sync_attach('00000000-0000-4000-8000-0000000000f1', pg_temp.id('kb'), null, 'github', 'octo/guides', 'folder', '{}', 'octo/guides', null, 'gh-rt-two', 'quorum', false, null, 'attach-0002-bbbb') ->> 'id';
select pg_temp.as_admin_role();
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id)
  values ('01KF000000000000000000NG02', '00000000-0000-4000-8000-0000000000f1', '01KF00000000000000000000WS', 'Knowledge bases/Handbook/guide.md',
    jsonb_build_object('visibility', 'public', 'kb_source', 'https://github.com/octo/guides/blob/main/guide.md', 'kb_attachment', pg_temp.id('a2')), '# Guide', 'h2', pg_temp.id('kb'));
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select pg_temp.expect_error($$select public.kb_sync_grant_disconnect('01KF00000000000000000000WS', 'github', 'delete')$$, 'pause or remove');
select pg_temp.check((public.kb_sync_grant_disconnect('01KF00000000000000000000WS', 'github', 'remove') ->> 'removed') = '1', 'one attachment removed');
select pg_temp.as_admin_role();
select pg_temp.check(not exists (select 1 from public.kb_attachments where id = pg_temp.id('a2')), 'the attachment is gone');
select pg_temp.check((select deleted_at is not null from public.notes where id = '01KF000000000000000000NG02'), 'its note left the KB');
select pg_temp.check((select count(*) from public.kb_sync_grants where user_id = '00000000-0000-4000-8000-0000000000f1' and provider = 'github' and revoke_pending) = 2, 'both grants wait for their revoke');

select pg_temp.as_admin_role();
select 'kb sync attach id: ok';
rollback;
