-- Knowledge bases (migrations 0024 and 0025): row level security and the RPCs, run as the people who would call them.
-- Needs a database with every migration applied (supabase start, or supabase db reset on a local stack). Everything
-- runs in one transaction that is rolled back, so it leaves the database as it found it:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/knowledge_bases.sql
-- A failed check stops the script with the check's message; the last line printed on success is "knowledge bases: ok".
begin;

-- fixtures. The sign-up gate (0009) is replaced for this transaction only, so test accounts can be made directly.
-- a1 owns the workspace, a2 is an admin, a3 and a4 are members, a5 belongs to another workspace
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
-- shared notes open a pending contribution (0012); N002 stays private
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body) values
  ('01KB000000000000000000N001', '00000000-0000-4000-8000-0000000000a2', '01KB00000000000000000000WA', 'admin/plan.md', '{"visibility": "public"}', '# Plan'),
  ('01KB000000000000000000N002', '00000000-0000-4000-8000-0000000000a4', '01KB00000000000000000000WA', 'member/diary.md', '{}', '# Diary'),
  ('01KB000000000000000000N003', '00000000-0000-4000-8000-0000000000a4', '01KB00000000000000000000WA', 'member/shared.md', '{"visibility": "public"}', '# Shared'),
  ('01KB000000000000000000N004', '00000000-0000-4000-8000-0000000000a3', '01KB00000000000000000000WA', 'reader/notes.md', '{"visibility": "public"}', '# Reader'),
  ('01KB000000000000000000N005', '00000000-0000-4000-8000-0000000000a4', '01KB00000000000000000000WA', 'member/draft.md', '{"visibility": "public"}', '# Draft'),
  ('01KB000000000000000000N006', '00000000-0000-4000-8000-0000000000a4', '01KB00000000000000000000WA', 'member/approved.md', '{"visibility": "public"}', '# Approved');

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
create function pg_temp.kb(name text) returns text language sql as $$ select v from ids where k = name $$;

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
select pg_temp.expect_error($$ select public.kb_create('01KB00000000000000000000WA', 'Ops', 'meetings', '01KB00000000000000000000T1') $$, 'not in this workspace');
do $$ begin
  assert public.kb_shape(pg_temp.kb('handbook')) ->> 'name' = 'Handbook', 'the name is trimmed';
  assert public.kb_shape(pg_temp.kb('handbook')) -> 'access' = '[{"principal": "workspace", "user_id": null, "team_id": null, "role": "reader", "email": null, "name": null}]'::jsonb, 'a new KB is readable by the workspace';
end $$;
-- kb_next_position is internal
select pg_temp.expect_error($$ select public.kb_next_position(pg_temp.kb('handbook'), null) $$, 'permission denied');

-- 2. the table API refuses every write, even for admins
select pg_temp.expect_error($$ insert into public.knowledge_bases (workspace_id, name) values ('01KB00000000000000000000WA', 'Direct') $$, 'row-level security');
select pg_temp.expect_error($$ insert into public.kb_access (kb_id, principal) select v, 'workspace' from ids where k = 'restricted' $$, 'row-level security');
do $$ begin
  update public.knowledge_bases set name = 'Changed';
  assert not exists (select 1 from public.knowledge_bases where name = 'Changed'), 'an update through the table changes nothing';
  delete from public.kb_access;
  assert exists (select 1 from public.kb_access), 'a delete through the table removes nothing';
end $$;

-- 3. access: Leadership becomes the reader's alone; teams from elsewhere are refused, outsiders too
select pg_temp.expect_error($$ select public.kb_set_access(pg_temp.kb('restricted'), '[{"principal": "team", "team_id": "01KB00000000000000000000T1"}]') $$, 'not in this workspace');
select pg_temp.expect_error($$ select public.kb_set_access(pg_temp.kb('restricted'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a5"}]') $$, 'not a member');
select pg_temp.expect_error($$ select public.kb_set_access(pg_temp.kb('restricted'), '[{"principal": "user", "user_id": "nope"}]') $$, 'not a member');
select pg_temp.expect_error($$ select public.kb_set_access(pg_temp.kb('restricted'), '[{"principal": "workspace", "role": "owner"}]') $$, 'admin, editor or reader');
select public.kb_set_access(pg_temp.kb('restricted'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a3", "role": "reader"}]');

-- 4. folders: nested without limit, siblings named once, moves stay inside the KB and never into themselves
insert into ids select 'guides', public.kb_folder_create(pg_temp.kb('handbook'), null, 'Guides') ->> 'id';
insert into ids select 'onboarding', public.kb_folder_create(pg_temp.kb('handbook'), pg_temp.kb('guides'), 'Onboarding') ->> 'id';
insert into ids select 'week1', public.kb_folder_create(pg_temp.kb('handbook'), pg_temp.kb('onboarding'), 'Week 1') ->> 'id';
insert into ids select 'policies', public.kb_folder_create(pg_temp.kb('handbook'), null, 'Policies') ->> 'id';
insert into ids select 'board', public.kb_folder_create(pg_temp.kb('restricted'), null, 'Board') ->> 'id';
select pg_temp.expect_error($$ select public.kb_folder_create(pg_temp.kb('handbook'), null, 'guides') $$, 'already there');
select pg_temp.expect_error($$ select public.kb_folder_create(pg_temp.kb('handbook'), null, 'a/b') $$, 'without slashes');
select pg_temp.expect_error($$ select public.kb_folder_create(pg_temp.kb('handbook'), pg_temp.kb('board'), 'Mixed') $$, 'another knowledge base');
select pg_temp.expect_error($$ select public.kb_folder_move(pg_temp.kb('guides'), pg_temp.kb('week1')) $$, 'inside itself');
select pg_temp.expect_error($$ select public.kb_folder_move(pg_temp.kb('guides'), pg_temp.kb('guides')) $$, 'inside itself');
select pg_temp.expect_error($$ select public.kb_folder_move(pg_temp.kb('guides'), pg_temp.kb('board')) $$, 'another knowledge base');
do $$ begin
  assert (public.kb_folder_move(pg_temp.kb('week1'), pg_temp.kb('guides')) ->> 'position') = '1', 'a moved folder lands after its new siblings';
  assert (public.kb_folder_move(pg_temp.kb('week1'), null, 7, false) ->> 'parent_id') = pg_temp.kb('guides'), 'without reparent the parent stays';
  assert (select position from public.kb_folders where id = pg_temp.kb('week1')) = 7, 'and the position changes';
  assert (public.kb_folder_rename(pg_temp.kb('week1'), 'First week') ->> 'name') = 'First week', 'rename';
  assert (select position from public.kb_folders where id = pg_temp.kb('policies')) = 1, 'a new top-level folder lands last';
end $$;

-- 5. notes: admins add shared notes they can read; members cannot; the folder has to be in the KB
select public.kb_note_assign('01KB000000000000000000N001', pg_temp.kb('handbook'), pg_temp.kb('week1'));
select pg_temp.expect_error($$ select public.kb_note_assign('01KB000000000000000000N002', pg_temp.kb('handbook')) $$, 'no longer exists');
select pg_temp.expect_error($$ select public.kb_note_assign('01KB000000000000000000N001', pg_temp.kb('restricted'), pg_temp.kb('week1')) $$, 'not in this knowledge base');
select public.kb_note_assign('01KB000000000000000000N001', pg_temp.kb('restricted'), pg_temp.kb('board'));
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
select pg_temp.expect_error($$ select public.kb_note_assign('01KB000000000000000000N003', pg_temp.kb('handbook')) $$, 'Only the knowledge base''s admins');
-- the table route is checked as well: an author cannot move their own note into a KB by updating the row, and a
-- private note never joins one
select pg_temp.expect_error($$ update public.notes set kb_id = pg_temp.kb('handbook') where id = '01KB000000000000000000N003' $$, 'Only the knowledge base''s admins');
select pg_temp.expect_error($$ update public.notes set kb_id = pg_temp.kb('handbook') where id = '01KB000000000000000000N002' $$, 'Only notes shared');
select pg_temp.expect_error($$ select public.kb_folder_create(pg_temp.kb('handbook'), null, 'Mine') $$, 'Only the knowledge base''s admins');
select pg_temp.expect_error($$ select public.kb_rename(pg_temp.kb('handbook'), 'Mine') $$, 'Only the knowledge base''s admins');
select pg_temp.expect_error($$ select public.kb_set_access(pg_temp.kb('handbook'), '[]') $$, 'Only the knowledge base''s admins');

-- 6. reads: the member sees the Handbook and none of Leadership; the reader sees Leadership's note; the outsider nothing
do $$ begin
  assert (select count(*) from public.knowledge_bases) = 1, 'a member reads only KBs granted to them';
  assert (select count(*) from public.kb_folders) = 4, 'a member reads the folders of readable KBs';
  assert (select count(*) from public.kb_access) = 0, 'access rows are for KB admins and the person granted';
  assert jsonb_array_length(public.kb_list('01KB00000000000000000000WA')) = 1, 'kb_list returns readable KBs';
  assert public.kb_list('01KB00000000000000000000WA') -> 0 ->> 'role' = 'reader', 'the member reads';
  assert public.kb_list('01KB00000000000000000000WA') -> 0 -> 'access' = 'null'::jsonb, 'a reader does not see the access list';
  assert public.kb_shape(pg_temp.kb('restricted')) is null, 'kb_shape answers nothing for a KB the caller cannot read';
  assert not exists (select 1 from public.notes where id = '01KB000000000000000000N001'), 'a note in a KB the member cannot read stays hidden';
  assert not public.note_readable('01KB000000000000000000N001'), 'and so do its side doors';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
do $$ begin
  assert (select count(*) from public.knowledge_bases) = 2, 'the granted reader reads both KBs';
  assert public.kb_shape(pg_temp.kb('restricted')) ->> 'role' = 'reader', 'kb_shape answers a reader';
  assert exists (select 1 from public.notes where id = '01KB000000000000000000N001'), 'the granted reader reads the KB note';
  assert (select count(*) from public.kb_access) = 1, 'a person sees their own grant';
  assert not public.can_admin_kb(pg_temp.kb('restricted')), 'a reader is not an admin';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a5');
do $$ begin
  assert (select count(*) from public.knowledge_bases) = 0, 'an outsider reads no KB';
  assert jsonb_array_length(public.kb_list('01KB00000000000000000000WA')) = 0, 'kb_list returns nothing to an outsider';
  assert public.kb_shape(pg_temp.kb('handbook')) is null, 'kb_shape answers nothing to another workspace';
  assert not exists (select 1 from public.notes where workspace_id = '01KB00000000000000000000WA'), 'an outsider reads no note';
end $$;
select pg_temp.expect_error($$ select public.kb_delete(pg_temp.kb('handbook')) $$, 'no longer exists');

-- 7. access changes touch the KB's notes only when someone gains read access
reset role;
alter table public.notes disable trigger notes_updated_at;
update public.notes set updated_at = '2000-01-01' where id = '01KB000000000000000000N001';
alter table public.notes enable trigger notes_updated_at;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select public.kb_set_access(pg_temp.kb('restricted'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a3", "role": "admin"}]');
do $$ begin
  assert (select updated_at from public.notes where id = '01KB000000000000000000N001') = '2000-01-01', 'a role change leaves the notes alone';
  perform public.kb_set_access(pg_temp.kb('restricted'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a3"}, {"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a4"}]');
  assert (select updated_at from public.notes where id = '01KB000000000000000000N001') > '2000-01-01', 'a new reader touches the notes';
  perform public.kb_set_access(pg_temp.kb('restricted'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a3"}]');
end $$;

-- 8. a KB admin through kb_access manages the KB but cannot delete it, and moves only their own notes
select public.kb_set_access(pg_temp.kb('handbook'), '[{"principal": "workspace"}, {"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a4", "role": "admin"}]');
-- a workspace admin moves another member's shared note
select public.kb_note_assign('01KB000000000000000000N004', pg_temp.kb('handbook'), null);
select public.kb_note_assign('01KB000000000000000000N005', pg_temp.kb('handbook'), null);
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
do $$ begin
  assert public.can_admin_kb(pg_temp.kb('handbook')), 'the granted admin manages the KB';
  assert (select count(*) from public.kb_access) = 2, 'a KB admin reads the access list';
  perform public.kb_note_assign('01KB000000000000000000N003', pg_temp.kb('handbook'), pg_temp.kb('policies'));
end $$;
select pg_temp.expect_error($$ select public.kb_note_assign('01KB000000000000000000N004', pg_temp.kb('handbook'), pg_temp.kb('policies')) $$, 'Only the note''s author or a workspace admin');
select pg_temp.expect_error($$ select public.kb_delete(pg_temp.kb('handbook')) $$, 'Only owners and admins');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
do $$ begin
  assert exists (select 1 from public.notes where id = '01KB000000000000000000N003'), 'a workspace reader reads the note added to the Handbook';
  assert (select folder_id from public.notes where id = '01KB000000000000000000N004') is null, 'the KB admin did not move another member''s note';
end $$;

-- 9. leaving a KB: no visibility key, confidential, and a declined contribution each take a note out
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
update public.notes set frontmatter = '{}' where id = '01KB000000000000000000N003';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
update public.notes set frontmatter = '{"visibility": "public", "confidential": "hr"}' where id = '01KB000000000000000000N004';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select public.review_contribution((select id from public.contributions where note_id = '01KB000000000000000000N005'), 'decline');
reset role;
do $$ begin
  assert (select kb_id is null and folder_id is null from public.notes where id = '01KB000000000000000000N003'), 'a note without a visibility key leaves the KB';
  assert (select status from public.contributions where note_id = '01KB000000000000000000N003') = 'withdrawn', 'and its contribution is withdrawn';
  assert (select kb_id is null from public.notes where id = '01KB000000000000000000N004'), 'a confidential note leaves the KB';
  assert (select kb_id is null from public.notes where id = '01KB000000000000000000N005'), 'a declined note leaves the KB';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
do $$ begin
  assert not exists (select 1 from public.notes where id in ('01KB000000000000000000N003', '01KB000000000000000000N005')), 'readers stop reading the notes that left';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
update public.notes set frontmatter = '{"visibility": "public"}' where id = '01KB000000000000000000N003';
select pg_temp.expect_error($$ select public.kb_note_assign('01KB000000000000000000N002', pg_temp.kb('handbook')) $$, 'Only notes shared');
select public.kb_note_assign('01KB000000000000000000N003', pg_temp.kb('handbook'));
update public.notes set frontmatter = '{"visibility": "private"}' where id = '01KB000000000000000000N003';
do $$ begin
  assert (select kb_id is null from public.notes where id = '01KB000000000000000000N003'), 'visibility private takes it out too';
end $$;

-- 10. deleting a folder lifts its notes to the KB's top level; deleting a KB leaves its notes with their authors
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select public.kb_note_assign('01KB000000000000000000N001', pg_temp.kb('handbook'), pg_temp.kb('week1'));
select public.kb_folder_delete(pg_temp.kb('guides'));
do $$ begin
  assert (select count(*) from public.kb_folders where kb_id = pg_temp.kb('handbook')) = 1, 'the folders inside a deleted folder go with it';
  assert (select folder_id is null and kb_id is not null from public.notes where id = '01KB000000000000000000N001'), 'its note stays in the KB';
end $$;
select public.kb_delete(pg_temp.kb('handbook'));
do $$ begin
  assert (select kb_id is null from public.notes where id = '01KB000000000000000000N001'), 'a deleted KB leaves its notes personal';
  assert not exists (select 1 from public.knowledge_bases where id = pg_temp.kb('handbook')), 'the KB is gone';
end $$;

-- 11. the default KB (0025): none before the team switch, made when it turns on, named after the workspace and
-- readable by the workspace; the 0020 RPC writes its source; the review queue fills it
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select public.workspace_team_source_set('01KB00000000000000000000WA', '{"kind": "git", "url": "https://example.com/team/knowledge.git"}');
do $$ begin
  assert not exists (select 1 from public.knowledge_bases where is_default), 'no default KB before the team switch is on';
end $$;
select public.workspace_set_team_enabled('01KB00000000000000000000WA', true);
do $$ begin
  assert (select count(*) from public.knowledge_bases where is_default) = 1, 'turning the team switch on makes the default KB';
  assert (select name from public.knowledge_bases where is_default) = 'Example Team', 'named after the workspace';
  assert (select source ->> 'url' from public.knowledge_bases where is_default) = 'https://example.com/team/knowledge.git', 'it carries the team source';
  assert (select team_source ->> 'kind' from public.workspaces where id = '01KB00000000000000000000WA') = 'git', 'the workspace row keeps it too';
end $$;
select pg_temp.expect_error($$ select public.kb_ensure_default('01KB00000000000000000000WA') $$, 'permission denied');
select public.workspace_team_source_set('01KB00000000000000000000WA', '{"kind": "sync"}');
select public.review_contribution((select id from public.contributions where note_id = '01KB000000000000000000N006'), 'include');
do $$ begin
  assert (select source from public.knowledge_bases where is_default) is null, 'back to sync clears the KB source';
  assert (select kb_id from public.notes where id = '01KB000000000000000000N006') = (select id from public.knowledge_bases where is_default), 'an included note joins the default KB';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
do $$ begin
  assert exists (select 1 from public.notes where id = '01KB000000000000000000N006'), 'and every member reads it there';
end $$;

reset role;
select 'knowledge bases: ok';
rollback;
