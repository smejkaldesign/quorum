-- The meetings knowledge base (migration 0029): one per workspace, made by the team switch, month folders for members,
-- members placing their own meeting notes, and keep private taking a note out. Needs a database with every migration
-- applied (supabase start, or supabase db reset on a local stack). Everything runs in one transaction that is rolled
-- back, so it leaves the database as it found it:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/meetings_kb.sql
-- A failed check stops the script with the check's message; the last line printed on success is "meetings kb: ok".
begin;

-- fixtures. c1 owns the workspace, c3 and c4 are members, c5 is in another workspace
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000c1', 'owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000c3', 'member@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000c4', 'other@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000c5', 'outsider@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name) values ('01MK00000000000000000000WA', '00000000-0000-4000-8000-0000000000c1', 'Meeting Team');
insert into public.workspaces (id, user_id, name) values ('01MK00000000000000000000WB', '00000000-0000-4000-8000-0000000000c5', 'Elsewhere');
insert into public.members (id, user_id, workspace_id, role) values
  ('01MK00000000000000000000M3', '00000000-0000-4000-8000-0000000000c3', '01MK00000000000000000000WA', 'member'),
  ('01MK00000000000000000000M4', '00000000-0000-4000-8000-0000000000c4', '01MK00000000000000000000WA', 'member');

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);
$$;
create function pg_temp.expect_error(stmt text, pattern text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then
    if sqlerrm !~* pattern then raise exception 'expected an error like "%" from %, got "%"', pattern, stmt, sqlerrm; end if;
    return;
  end;
  raise exception 'expected an error like "%" from %, it ran', pattern, stmt;
end $$;
create temp table ids (k text primary key, v text);
grant all on ids to authenticated;
create function pg_temp.id(name text) returns text language sql as $$ select v from ids where k = name $$;

-- 1. a solo workspace has no meetings KB, and a member asking gets null
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
do $$ begin
  assert public.kb_meetings_folder('01MK00000000000000000000WA', '2026-11') is null, 'no meetings KB before the team switch is on';
end $$;

-- 2. the team switch makes one, named Meetings and readable by the whole workspace
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
select public.workspace_set_team_enabled('01MK00000000000000000000WA', true);
insert into ids select 'kb', id from public.knowledge_bases where workspace_id = '01MK00000000000000000000WA' and kind = 'meetings';
do $$ begin
  assert (select count(*) from public.knowledge_bases where workspace_id = '01MK00000000000000000000WA' and kind = 'meetings') = 1, 'turning the team switch on makes the meetings KB';
  assert (select name from public.knowledge_bases where id = pg_temp.id('kb')) = 'Meetings', 'named Meetings';
  assert exists (select 1 from public.kb_access where kb_id = pg_temp.id('kb') and principal = 'workspace' and role = 'reader'), 'the whole workspace reads it';
end $$;
-- turning it off and on again makes no second one, and an admin cannot create one by hand
select public.workspace_set_team_enabled('01MK00000000000000000000WA', false);
select public.workspace_set_team_enabled('01MK00000000000000000000WA', true);
do $$ begin
  assert (select count(*) from public.knowledge_bases where workspace_id = '01MK00000000000000000000WA' and kind = 'meetings') = 1, 'still one meetings KB';
end $$;
select pg_temp.expect_error($$ select public.kb_create('01MK00000000000000000000WA', 'Calls', 'meetings') $$, 'already has a meetings knowledge base');
select pg_temp.expect_error($$ select public.kb_ensure_meetings('01MK00000000000000000000WA') $$, 'permission denied');
do $$ begin
  assert public.kb_create('01MK00000000000000000000WA', 'Handbook', 'general') ->> 'kind' = 'general', 'a general KB is still made';
end $$;
insert into ids select 'handbook', id from public.knowledge_bases where workspace_id = '01MK00000000000000000000WA' and name = 'Handbook';

-- 3. month folders: made once on first use, by any member, named by month only
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
insert into ids select 'nov', public.kb_meetings_folder('01MK00000000000000000000WA', '2026-11') ->> 'folder_id';
do $$ declare r jsonb; begin
  r := public.kb_meetings_folder('01MK00000000000000000000WA', '2026-11');
  assert r ->> 'folder_id' = pg_temp.id('nov') and r ->> 'kb_id' = pg_temp.id('kb') and r ->> 'month' = '2026-11', 'the same folder comes back';
  assert (select count(*) from public.kb_folders where kb_id = pg_temp.id('kb') and name = '2026-11' and parent_id is null) = 1, 'one top-level folder per month';
  assert public.kb_meetings_info('01MK00000000000000000000WA') @> jsonb_build_object('kb_id', pg_temp.id('kb'), 'name', 'Meetings'), 'a member reads the meetings KB id and name';
end $$;
select pg_temp.expect_error($$ select public.kb_meetings_folder('01MK00000000000000000000WA', '2026-13') $$, 'named like 2026-11');
select pg_temp.expect_error($$ select public.kb_meetings_folder('01MK00000000000000000000WA', '../x') $$, 'named like 2026-11');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c5');
select pg_temp.expect_error($$ select public.kb_meetings_folder('01MK00000000000000000000WA', '2026-11') $$, 'not one of yours');
do $$ begin
  assert public.kb_meetings_info('01MK00000000000000000000WA') is null, 'someone outside the workspace gets null';
end $$;

-- 4. a member's shared meeting note goes into the meetings KB the way the app's push writes it, included at once
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id, folder_id)
  select '01MK000000000000000000NM01', '00000000-0000-4000-8000-0000000000c3', '01MK00000000000000000000WA', 'meetings/granola/standup.md', '{"visibility": "public", "keep_private": "false"}', '# Standup', pg_temp.id('kb'), pg_temp.id('nov');
do $$ begin
  assert (select kb_id from public.notes where id = '01MK000000000000000000NM01') = pg_temp.id('kb'), 'the note sits in the meetings KB';
  assert (select status || ':' || source from public.contributions where note_id = '01MK000000000000000000NM01') = 'included:kb', 'included because it sits in the KB, skipping the review queue';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c4');
do $$ begin
  assert exists (select 1 from public.notes where id = '01MK000000000000000000NM01'), 'another member reads it';
end $$;
-- a member still cannot place a note in a general KB, someone else's note, a private note, or a folder that is no month
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
select pg_temp.expect_error($$ insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id) values ('01MK000000000000000000NM02', '00000000-0000-4000-8000-0000000000c3', '01MK00000000000000000000WA', 'x/a.md', '{"visibility": "public"}', '# A', pg_temp.id('handbook')) $$, 'admins can add notes');
select pg_temp.expect_error($$ insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id) values ('01MK000000000000000000NM03', '00000000-0000-4000-8000-0000000000c3', '01MK00000000000000000000WA', 'x/b.md', '{}', '# B', pg_temp.id('kb')) $$, 'Only notes shared');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
insert into ids select 'odd', public.kb_folder_create(pg_temp.id('kb'), null, 'Decisions') ->> 'id';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
select pg_temp.expect_error($$ insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id, folder_id) values ('01MK000000000000000000NM04', '00000000-0000-4000-8000-0000000000c3', '01MK00000000000000000000WA', 'x/c.md', '{"visibility": "public"}', '# C', pg_temp.id('kb'), pg_temp.id('odd')) $$, 'admins can add notes');
-- someone else's note: c4's, written as the service would
reset role;
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body) values ('01MK000000000000000000NM06', '00000000-0000-4000-8000-0000000000c4', '01MK00000000000000000000WA', 'x/theirs.md', '{"visibility": "public"}', '# Theirs');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
select pg_temp.expect_error($$ select public.kb_note_assign('01MK000000000000000000NM06', pg_temp.id('kb'), pg_temp.id('nov')) $$, 'admins can add notes|no longer exists');

-- 5. keep private: the author sets visibility private; the note leaves the KB and only its author reads it
update public.notes set frontmatter = '{"visibility": "private", "keep_private": "true"}' where id = '01MK000000000000000000NM01';
do $$ begin
  assert (select kb_id from public.notes where id = '01MK000000000000000000NM01') is null, 'a kept private note leaves the meetings KB';
  assert (select folder_id from public.notes where id = '01MK000000000000000000NM01') is null, 'and its month folder';
  assert (select status from public.contributions where note_id = '01MK000000000000000000NM01') = 'withdrawn', 'its contribution is withdrawn';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c4');
do $$ begin
  assert not exists (select 1 from public.notes where id = '01MK000000000000000000NM01'), 'another member no longer reads it';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
do $$ begin
  assert not exists (select 1 from public.notes where id = '01MK000000000000000000NM01'), 'nor does the owner';
end $$;
-- turning keep private off puts it back, included again
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
update public.notes set frontmatter = '{"visibility": "public", "keep_private": "false"}', kb_id = pg_temp.id('kb'), folder_id = pg_temp.id('nov') where id = '01MK000000000000000000NM01';
do $$ begin
  assert (select kb_id from public.notes where id = '01MK000000000000000000NM01') = pg_temp.id('kb'), 'back in the meetings KB';
  assert (select status || ':' || source from public.contributions where note_id = '01MK000000000000000000NM01') = 'included:kb', 'included again';
end $$;
-- a note marked confidential leaves the KB, and cannot join again while it stays confidential
update public.notes set frontmatter = '{"visibility": "public", "confidential": "true"}' where id = '01MK000000000000000000NM01';
do $$ begin
  assert (select kb_id from public.notes where id = '01MK000000000000000000NM01') is null, 'a confidential note leaves the meetings KB';
end $$;
select pg_temp.expect_error($$ update public.notes set kb_id = pg_temp.id('kb') where id = '01MK000000000000000000NM01' $$, 'Only notes shared');
update public.notes set frontmatter = '{"visibility": "public", "keep_private": "false"}', kb_id = pg_temp.id('kb'), folder_id = pg_temp.id('nov') where id = '01MK000000000000000000NM01';

-- 6. readers narrowed by an admin: someone left out gets null and cannot place notes
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
select public.kb_set_access(pg_temp.id('kb'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000c3"}]'::jsonb);
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c4');
do $$ begin
  assert public.kb_meetings_folder('01MK00000000000000000000WA', '2026-11') is null, 'a member left out of the readers gets null';
  assert public.kb_meetings_info('01MK00000000000000000000WA') is null, 'and no meetings KB to show';
  assert not exists (select 1 from public.notes where id = '01MK000000000000000000NM01'), 'and no longer reads the KB';
end $$;
select pg_temp.expect_error($$ update public.notes set kb_id = pg_temp.id('kb') where id = '01MK000000000000000000NM06' $$, 'admins can add notes');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
do $$ begin
  assert public.kb_meetings_folder('01MK00000000000000000000WA', '2026-12') ->> 'month' = '2026-12', 'a reader still gets month folders';
end $$;

reset role;
select 'meetings kb: ok';
rollback;
