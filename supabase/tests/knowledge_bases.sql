-- Knowledge bases (migrations 0024 and 0025): row level security and the RPCs, run as the people who would call them.
-- Needs a database with every migration applied (supabase start, or supabase db reset on a local stack). Everything
-- runs in one transaction that is rolled back, so it leaves the database as it found it:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/knowledge_bases.sql
-- A failed check stops the script with the check's message; the last line printed on success is "knowledge bases: ok".
begin;

-- fixtures. The sign-up gate (0009) is replaced for this transaction only, so test accounts can be made directly
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a2', 'admin@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a3', 'reader@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a4', 'member@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a5', 'outsider@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name) values ('01KB00000000000000000000WA', '00000000-0000-4000-8000-0000000000a1', 'Example Team');
insert into public.workspaces (id, user_id, name) values ('01KB00000000000000000000WB', '00000000-0000-4000-8000-0000000000a5', 'Elsewhere');
insert into public.members (id, user_id, workspace_id, role) values
  ('01KB00000000000000000000M2', '00000000-0000-4000-8000-0000000000a2', '01KB00000000000000000000WA', 'admin'),
  ('01KB00000000000000000000M3', '00000000-0000-4000-8000-0000000000a3', '01KB00000000000000000000WA', 'member'),
  ('01KB00000000000000000000M4', '00000000-0000-4000-8000-0000000000a4', '01KB00000000000000000000WA', 'member');
-- a personal note and a public note per member
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body) values
  ('01KB000000000000000000N001', '00000000-0000-4000-8000-0000000000a2', '01KB00000000000000000000WA', 'admin/plan.md', '{}', '# Plan'),
  ('01KB000000000000000000N002', '00000000-0000-4000-8000-0000000000a4', '01KB00000000000000000000WA', 'member/diary.md', '{}', '# Diary'),
  ('01KB000000000000000000N003', '00000000-0000-4000-8000-0000000000a4', '01KB00000000000000000000WA', 'member/shared.md', '{"visibility": "public"}', '# Shared');

-- checks run as a signed-in person; pg_temp.expect_error runs a statement and requires a refusal matching a pattern
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

-- 1. only workspace owners and admins create a KB; names are unique per workspace; teams are not available yet
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
select pg_temp.expect_error($$ select public.kb_create('01KB00000000000000000000WA', 'Handbook') $$, 'Only owners and admins');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a5');
select pg_temp.expect_error($$ select public.kb_create('01KB00000000000000000000WA', 'Handbook') $$, 'Only owners and admins');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
insert into ids select 'handbook', public.kb_create('01KB00000000000000000000WA', ' Handbook ') ->> 'id';
insert into ids select 'restricted', public.kb_create('01KB00000000000000000000WA', 'Leadership') ->> 'id';
select pg_temp.expect_error($$ select public.kb_create('01KB00000000000000000000WA', 'handbook') $$, 'already exists');
select pg_temp.expect_error($$ select public.kb_create('01KB00000000000000000000WA', '   ') $$, 'needs a name');
select pg_temp.expect_error($$ select public.kb_create('01KB00000000000000000000WA', 'Ops', 'wiki') $$, 'general or meetings');
select pg_temp.expect_error($$ select public.kb_create('01KB00000000000000000000WA', 'Ops', 'meetings', '01KB00000000000000000000T1') $$, 'Teams are not available');
do $$ begin
  assert (select kb_shape ->> 'name' from (select public.kb_shape((select v from ids where k = 'handbook'))) s) = 'Handbook', 'the name is trimmed';
  assert (select public.kb_shape((select v from ids where k = 'handbook')) -> 'access') = '[{"principal": "workspace", "user_id": null, "team_id": null, "role": "reader", "email": null, "name": null}]'::jsonb, 'a new KB is readable by the workspace';
end $$;

-- 2. the table API refuses every write, even for admins
select pg_temp.expect_error($$ insert into public.knowledge_bases (workspace_id, name) values ('01KB00000000000000000000WA', 'Direct') $$, 'row-level security');
select pg_temp.expect_error($$ insert into public.kb_access (kb_id, principal) select v, 'workspace' from ids where k = 'restricted' $$, 'row-level security');
do $$ begin
  update public.knowledge_bases set name = 'Changed';
  assert not exists (select 1 from public.knowledge_bases where name = 'Changed'), 'an update through the table changes nothing';
  delete from public.kb_access;
  assert exists (select 1 from public.kb_access), 'a delete through the table removes nothing';
end $$;

-- 3. access: Leadership becomes the reader's alone, with the admin's grant; teams are refused, outsiders too
select pg_temp.expect_error($$ select public.kb_set_access((select v from ids where k = 'restricted'), '[{"principal": "team", "team_id": "01KB00000000000000000000T1"}]') $$, 'Teams are not available');
select pg_temp.expect_error($$ select public.kb_set_access((select v from ids where k = 'restricted'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a5"}]') $$, 'not a member');
select pg_temp.expect_error($$ select public.kb_set_access((select v from ids where k = 'restricted'), '[{"principal": "user", "user_id": "nope"}]') $$, 'not a member');
select pg_temp.expect_error($$ select public.kb_set_access((select v from ids where k = 'restricted'), '[{"principal": "workspace", "role": "owner"}]') $$, 'admin or reader');
select public.kb_set_access((select v from ids where k = 'restricted'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a3", "role": "reader"}]');

-- 4. folders: nested without limit, siblings named once, moves stay inside the KB and never into themselves
insert into ids select 'guides', public.kb_folder_create((select v from ids where k = 'handbook'), null, 'Guides') ->> 'id';
insert into ids select 'onboarding', public.kb_folder_create((select v from ids where k = 'handbook'), (select v from ids where k = 'guides'), 'Onboarding') ->> 'id';
insert into ids select 'week1', public.kb_folder_create((select v from ids where k = 'handbook'), (select v from ids where k = 'onboarding'), 'Week 1') ->> 'id';
insert into ids select 'policies', public.kb_folder_create((select v from ids where k = 'handbook'), null, 'Policies') ->> 'id';
insert into ids select 'board', public.kb_folder_create((select v from ids where k = 'restricted'), null, 'Board') ->> 'id';
select pg_temp.expect_error($$ select public.kb_folder_create((select v from ids where k = 'handbook'), null, 'guides') $$, 'already there');
select pg_temp.expect_error($$ select public.kb_folder_create((select v from ids where k = 'handbook'), null, 'a/b') $$, 'without slashes');
select pg_temp.expect_error($$ select public.kb_folder_create((select v from ids where k = 'handbook'), (select v from ids where k = 'board'), 'Mixed') $$, 'another knowledge base');
select pg_temp.expect_error($$ select public.kb_folder_move((select v from ids where k = 'guides'), (select v from ids where k = 'week1')) $$, 'inside itself');
select pg_temp.expect_error($$ select public.kb_folder_move((select v from ids where k = 'guides'), (select v from ids where k = 'guides')) $$, 'inside itself');
select pg_temp.expect_error($$ select public.kb_folder_move((select v from ids where k = 'guides'), (select v from ids where k = 'board')) $$, 'another knowledge base');
do $$ begin
  assert (select (public.kb_folder_move((select v from ids where k = 'week1'), (select v from ids where k = 'guides'))) ->> 'position') = '1', 'a moved folder lands after its new siblings';
  assert (select (public.kb_folder_rename((select v from ids where k = 'week1'), 'First week')) ->> 'name') = 'First week', 'rename';
  assert (select position from public.kb_folders where id = (select v from ids where k = 'policies')) = 1, 'a new top-level folder lands last';
end $$;

-- 5. notes: admins add notes they can read; members cannot; the folder has to be in the KB
select public.kb_note_assign('01KB000000000000000000N001', (select v from ids where k = 'handbook'), (select v from ids where k = 'week1'));
select pg_temp.expect_error($$ select public.kb_note_assign('01KB000000000000000000N002', (select v from ids where k = 'handbook')) $$, 'no longer exists');
select pg_temp.expect_error($$ select public.kb_note_assign('01KB000000000000000000N001', (select v from ids where k = 'restricted'), (select v from ids where k = 'week1')) $$, 'not in this knowledge base');
select public.kb_note_assign('01KB000000000000000000N001', (select v from ids where k = 'restricted'), (select v from ids where k = 'board'));
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
select pg_temp.expect_error($$ select public.kb_note_assign('01KB000000000000000000N002', (select v from ids where k = 'handbook')) $$, 'Only the knowledge base''s admins');
-- the table route is checked as well: an author cannot move their own note into a KB by updating the row
select pg_temp.expect_error($$ update public.notes set kb_id = (select v from ids where k = 'handbook') where id = '01KB000000000000000000N002' $$, 'Only the knowledge base''s admins');
select pg_temp.expect_error($$ select public.kb_folder_create((select v from ids where k = 'handbook'), null, 'Mine') $$, 'Only the knowledge base''s admins');
select pg_temp.expect_error($$ select public.kb_rename((select v from ids where k = 'handbook'), 'Mine') $$, 'Only the knowledge base''s admins');
select pg_temp.expect_error($$ select public.kb_set_access((select v from ids where k = 'handbook'), '[]') $$, 'Only the knowledge base''s admins');

-- 6. reads: the member sees the Handbook and none of Leadership; the reader sees Leadership's note; the outsider nothing
do $$ begin
  assert (select count(*) from public.knowledge_bases) = 1, 'a member reads only KBs granted to them';
  assert (select count(*) from public.kb_folders) = 4, 'a member reads the folders of readable KBs';
  assert (select count(*) from public.kb_access) = 0, 'access rows are for KB admins and the person granted';
  assert jsonb_array_length(public.kb_list('01KB00000000000000000000WA')) = 1, 'kb_list returns readable KBs';
  assert public.kb_list('01KB00000000000000000000WA') -> 0 ->> 'role' = 'reader', 'the member reads';
  assert public.kb_list('01KB00000000000000000000WA') -> 0 -> 'access' = 'null'::jsonb, 'a reader does not see the access list';
  assert not exists (select 1 from public.notes where id = '01KB000000000000000000N001'), 'a note in a KB the member cannot read stays hidden';
  assert not public.note_readable('01KB000000000000000000N001'), 'and so do its side doors';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
do $$ begin
  assert (select count(*) from public.knowledge_bases) = 2, 'the granted reader reads both KBs';
  assert exists (select 1 from public.notes where id = '01KB000000000000000000N001'), 'the granted reader reads the KB note';
  assert (select count(*) from public.kb_access) = 1, 'a person sees their own grant';
  assert not public.can_admin_kb((select v from ids where k = 'restricted')), 'a reader is not an admin';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a5');
do $$ begin
  assert (select count(*) from public.knowledge_bases) = 0, 'an outsider reads no KB';
  assert jsonb_array_length(public.kb_list('01KB00000000000000000000WA')) = 0, 'kb_list returns nothing to an outsider';
  assert not exists (select 1 from public.notes where workspace_id = '01KB00000000000000000000WA'), 'an outsider reads no note';
end $$;
select pg_temp.expect_error($$ select public.kb_delete((select v from ids where k = 'handbook')) $$, 'no longer exists');

-- 7. a KB admin through kb_access manages the KB but cannot delete it; personal notes read as before
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select public.kb_set_access((select v from ids where k = 'handbook'), '[{"principal": "workspace"}, {"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a4", "role": "admin"}]');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
do $$ begin
  assert public.can_admin_kb((select v from ids where k = 'handbook')), 'the granted admin manages the KB';
  assert (select count(*) from public.kb_access) = 2, 'a KB admin reads the access list';
  perform public.kb_note_assign('01KB000000000000000000N002', (select v from ids where k = 'handbook'), (select v from ids where k = 'policies'));
end $$;
select pg_temp.expect_error($$ select public.kb_delete((select v from ids where k = 'handbook')) $$, 'Only owners and admins');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
do $$ begin
  assert exists (select 1 from public.notes where id = '01KB000000000000000000N002'), 'a workspace reader reads the note added to the Handbook';
end $$;

-- 8. the author takes the note back by making it private; a public note outside KBs still follows the review queue
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
update public.notes set frontmatter = '{"visibility": "public"}' where id = '01KB000000000000000000N002';
update public.notes set frontmatter = '{"visibility": "private"}' where id = '01KB000000000000000000N002';
do $$ begin
  assert (select kb_id from public.notes where id = '01KB000000000000000000N002') is null, 'marking a KB note private takes it out of the KB';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
do $$ begin
  assert not exists (select 1 from public.notes where id = '01KB000000000000000000N002'), 'and other members stop reading it';
  assert not exists (select 1 from public.notes where id = '01KB000000000000000000N003'), 'a public note that is still pending stays hidden';
end $$;

-- 9. deleting a folder lifts its notes to the KB's top level; deleting a KB leaves its notes with their authors
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select public.kb_note_assign('01KB000000000000000000N001', (select v from ids where k = 'handbook'), (select v from ids where k = 'week1'));
select public.kb_folder_delete((select v from ids where k = 'guides'));
do $$ begin
  assert (select count(*) from public.kb_folders where kb_id = (select v from ids where k = 'handbook')) = 1, 'the folders inside a deleted folder go with it';
  assert (select folder_id is null and kb_id is not null from public.notes where id = '01KB000000000000000000N001'), 'its note stays in the KB';
end $$;
select public.kb_delete((select v from ids where k = 'handbook'));
do $$ begin
  assert (select kb_id is null from public.notes where id = '01KB000000000000000000N001'), 'a deleted KB leaves its notes personal';
  assert not exists (select 1 from public.knowledge_bases where id = (select v from ids where k = 'handbook')), 'the KB is gone';
end $$;

-- 10. the default KB (0025): made on demand, named after the workspace, readable by the workspace, and the 0020 RPC
-- writes its source
reset role;
select public.kb_ensure_default('01KB00000000000000000000WA');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select public.workspace_team_source_set('01KB00000000000000000000WA', '{"kind": "git", "url": "https://example.com/team/knowledge.git"}');
do $$ begin
  assert (select count(*) from public.knowledge_bases where is_default) = 1, 'one default KB';
  assert (select name from public.knowledge_bases where is_default) = 'Example Team', 'named after the workspace';
  assert (select source ->> 'url' from public.knowledge_bases where is_default) = 'https://example.com/team/knowledge.git', 'the 0020 RPC mirrors the source';
  assert (select team_source ->> 'kind' from public.workspaces where id = '01KB00000000000000000000WA') = 'git', 'and still writes the workspace row';
end $$;
select pg_temp.expect_error($$ select public.kb_ensure_default('01KB00000000000000000000WA') $$, 'permission denied');
select public.workspace_team_source_set('01KB00000000000000000000WA', '{"kind": "sync"}');
do $$ begin
  assert (select source from public.knowledge_bases where is_default) is null, 'back to sync clears the KB source';
end $$;

reset role;
select 'knowledge bases: ok';
rollback;
