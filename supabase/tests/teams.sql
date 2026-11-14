-- Teams and cross-team knowledge base permissions (migration 0035): team reads, team-owned KBs, grants to other teams
-- by a lead, meeting note routing by team, and what leaving the workspace or deleting a team does. Needs a database
-- with every migration applied (supabase start, or supabase db reset on a local stack). Everything runs in one
-- transaction that is rolled back, so it leaves the database as it found it:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/teams.sql
-- A failed check stops the script with the check's message; the last line printed on success is "teams: ok".
begin;

-- fixtures. d1 owns the workspace; d2 leads Alpha; d3 is in Alpha; d4 is in Beta; d5 is in no team; d6 is elsewhere
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000d1', 'owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000d2', 'lead@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000d3', 'alpha@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000d4', 'beta@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000d5', 'loose@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000d6', 'outsider@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name) values ('01TM00000000000000000000WA', '00000000-0000-4000-8000-0000000000d1', 'Team Works');
update public.workspaces set plan = 'paid', seats = 5 where id = '01TM00000000000000000000WA';
insert into public.workspaces (id, user_id, name) values ('01TM00000000000000000000WB', '00000000-0000-4000-8000-0000000000d6', 'Elsewhere');
insert into public.members (id, user_id, workspace_id, role) values
  ('01TM00000000000000000000M2', '00000000-0000-4000-8000-0000000000d2', '01TM00000000000000000000WA', 'member'),
  ('01TM00000000000000000000M3', '00000000-0000-4000-8000-0000000000d3', '01TM00000000000000000000WA', 'member'),
  ('01TM00000000000000000000M4', '00000000-0000-4000-8000-0000000000d4', '01TM00000000000000000000WA', 'member'),
  ('01TM00000000000000000000M5', '00000000-0000-4000-8000-0000000000d5', '01TM00000000000000000000WA', 'member');

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
create function pg_temp.reads(kb text) returns boolean language sql as $$ select exists (select 1 from public.knowledge_bases where id = pg_temp.id(kb)) $$;
create function pg_temp.reads_note(note text) returns boolean language sql as $$ select exists (select 1 from public.notes where id = note) $$;

-- 1. teams need the team switch, and only owners and admins create them
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select pg_temp.expect_error($$ select public.team_create('01TM00000000000000000000WA', 'Alpha') $$, 'Turn on the team');
select public.workspace_set_team_enabled('01TM00000000000000000000WA', true);
insert into ids select 'ws-meetings', id from public.knowledge_bases where workspace_id = '01TM00000000000000000000WA' and kind = 'meetings';
insert into ids select 'alpha', public.team_create('01TM00000000000000000000WA', ' Alpha ') ->> 'id';
insert into ids select 'beta', public.team_create('01TM00000000000000000000WA', 'Beta') ->> 'id';
select pg_temp.expect_error($$ select public.team_create('01TM00000000000000000000WA', 'alpha') $$, 'already exists');
select pg_temp.expect_error($$ select public.team_create('01TM00000000000000000000WA', '  ') $$, 'needs a name');
insert into ids select 'alpha-meetings', id from public.knowledge_bases where team_id = pg_temp.id('alpha') and kind = 'meetings';
insert into ids select 'beta-meetings', id from public.knowledge_bases where team_id = pg_temp.id('beta') and kind = 'meetings';
do $$ begin
  assert (select name from public.teams where id = pg_temp.id('alpha')) = 'Alpha', 'the name is trimmed';
  assert (select name from public.knowledge_bases where id = pg_temp.id('alpha-meetings')) = 'Alpha meetings', 'each team gets a meetings KB';
  assert (select count(*) from public.knowledge_bases where workspace_id = '01TM00000000000000000000WA' and kind = 'meetings') = 3, 'one per team plus the workspace one';
  assert (select jsonb_agg(jsonb_build_object('p', principal, 't', team_id)) from public.kb_access where kb_id = pg_temp.id('alpha-meetings')) = jsonb_build_array(jsonb_build_object('p', 'team', 't', pg_temp.id('alpha'))), 'a team meetings KB is readable by its team only';
end $$;
select pg_temp.expect_error($$ select public.kb_create('01TM00000000000000000000WA', 'Second', 'meetings', pg_temp.id('alpha')) $$, 'already has a meetings');
select pg_temp.expect_error($$ select public.kb_create('01TM00000000000000000000WA', 'Workspace calls', 'meetings') $$, 'already has a meetings');
-- members read teams but cannot create one, and the table API takes no writes
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d5');
select pg_temp.expect_error($$ select public.team_create('01TM00000000000000000000WA', 'Gamma') $$, 'Only owners and admins');
select pg_temp.expect_error($$ insert into public.teams (workspace_id, name) values ('01TM00000000000000000000WA', 'Direct') $$, 'row-level security');
select pg_temp.expect_error($$ insert into public.team_members (team_id, workspace_id, user_id) select v, '01TM00000000000000000000WA', '00000000-0000-4000-8000-0000000000d5' from ids where k = 'alpha' $$, 'row-level security');
do $$ begin
  assert (select count(*) from public.teams where workspace_id = '01TM00000000000000000000WA') = 2, 'a member reads the teams';
  assert jsonb_array_length(public.team_list('01TM00000000000000000000WA')) = 2, 'team_list for a member';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d6');
do $$ begin
  assert not exists (select 1 from public.teams where workspace_id = '01TM00000000000000000000WA'), 'an outsider reads no teams';
  assert public.team_list('01TM00000000000000000000WA') = '[]'::jsonb, 'nor through team_list';
end $$;

-- 2. memberships are for owners and admins: a lead cannot add a member or a lead, or remove anyone but themselves,
-- since the team's grants reach whoever is in it; a lead can rename the team; a plain member can do neither
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select public.team_member_set(pg_temp.id('alpha'), '00000000-0000-4000-8000-0000000000d2', 'lead');
select public.team_member_set(pg_temp.id('beta'), '00000000-0000-4000-8000-0000000000d4');
select pg_temp.expect_error($$ select public.team_member_set(pg_temp.id('alpha'), '00000000-0000-4000-8000-0000000000d6') $$, 'not a member of this workspace');
select pg_temp.expect_error($$ select public.team_member_set(pg_temp.id('alpha'), '00000000-0000-4000-8000-0000000000d5', 'owner') $$, 'lead or member');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d2');
select pg_temp.expect_error($$ select public.team_member_set(pg_temp.id('alpha'), '00000000-0000-4000-8000-0000000000d3') $$, 'Only owners and admins can change who is in a team');
select pg_temp.expect_error($$ select public.team_member_set(pg_temp.id('alpha'), '00000000-0000-4000-8000-0000000000d5', 'lead') $$, 'Only owners and admins can change who is in a team');
select pg_temp.expect_error($$ select public.team_member_set(pg_temp.id('beta'), '00000000-0000-4000-8000-0000000000d5') $$, 'Only owners and admins');
select pg_temp.expect_error($$ select public.team_member_remove(pg_temp.id('beta'), '00000000-0000-4000-8000-0000000000d4') $$, 'Only owners and admins');
do $$ begin
  assert (public.team_rename(pg_temp.id('alpha'), 'Alpha') ->> 'name') = 'Alpha', 'a lead can rename the team';
  assert (public.team_shape(pg_temp.id('alpha')) ->> 'can_manage')::boolean and not (public.team_shape(pg_temp.id('alpha')) ->> 'can_manage_members')::boolean, 'a lead manages the team but not its members';
  assert not exists (select 1 from public.team_members where team_id = pg_temp.id('alpha') and user_id = '00000000-0000-4000-8000-0000000000d3'), 'the lead added nobody';
end $$;
-- the owner adds the member; the new member gets a resync request, and nobody else's notes are touched
reset role;
create temp table touched as select id, updated_at from public.notes;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select public.team_member_set(pg_temp.id('alpha'), '00000000-0000-4000-8000-0000000000d3');
reset role;
do $$ begin
  assert (select count(*) from public.kb_resync where workspace_id = '01TM00000000000000000000WA' and user_id = '00000000-0000-4000-8000-0000000000d3') = 1, 'the new member has a resync request';
  assert (select count(*) from public.kb_resync where workspace_id = '01TM00000000000000000000WA') = 3, 'one request for each person added so far';
end $$;
do $$ begin
  assert not exists (select 1 from public.notes n join touched t on t.id = n.id where n.updated_at <> t.updated_at), 'joining a team touches no note';
end $$;
-- each person reads only their own request, and clears it after a full pull
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d3');
do $$ declare at timestamptz; begin
  assert (select count(*) from public.kb_resync) = 1, 'a person reads only their own resync request';
  at := public.kb_resync_pending('01TM00000000000000000000WA');
  assert at is not null, 'kb_resync_pending answers with its time';
  perform public.kb_resync_done('01TM00000000000000000000WA', at - interval '1 second');
  assert public.kb_resync_pending('01TM00000000000000000000WA') is not null, 'a request newer than the pull stays';
  perform public.kb_resync_done('01TM00000000000000000000WA', at);
  assert public.kb_resync_pending('01TM00000000000000000000WA') is null, 'kb_resync_done clears it';
end $$;
select pg_temp.expect_error($$ insert into public.kb_resync (workspace_id, user_id) values ('01TM00000000000000000000WA', '00000000-0000-4000-8000-0000000000d3') $$, 'row-level security');
select pg_temp.expect_error($$ select public.kb_resync_request('01TM00000000000000000000WA', '00000000-0000-4000-8000-0000000000d3') $$, 'permission denied');
select pg_temp.expect_error($$ select public.team_member_set(pg_temp.id('alpha'), '00000000-0000-4000-8000-0000000000d5') $$, 'Only owners and admins');
select pg_temp.expect_error($$ select public.team_rename(pg_temp.id('alpha'), 'Mine') $$, 'leads can rename');
select pg_temp.expect_error($$ select public.team_delete(pg_temp.id('alpha')) $$, 'Only owners and admins');
do $$ begin
  assert (public.team_shape(pg_temp.id('alpha')) ->> 'my_role') = 'member', 'the caller''s role';
  assert (public.team_shape(pg_temp.id('alpha')) ->> 'can_manage')::boolean = false, 'a member does not manage the team';
  assert jsonb_array_length(public.team_shape(pg_temp.id('alpha')) -> 'members') = 2, 'two people in Alpha';
end $$;

-- 3. a team-owned KB: its team reads it and its notes; another team and a member in no team do not
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
insert into ids select 'docs', public.kb_create('01TM00000000000000000000WA', 'Alpha docs', 'general', pg_temp.id('alpha')) ->> 'id';
select pg_temp.expect_error($$ select public.kb_create('01TM00000000000000000000WA', 'Stray', 'general', '01TM00000000000000000000T9') $$, 'not in this workspace');
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body)
  values ('01TM000000000000000000N001', '00000000-0000-4000-8000-0000000000d1', '01TM00000000000000000000WA', 'docs/plan.md', '{"visibility": "public"}', '# Plan');
select public.kb_note_assign('01TM000000000000000000N001', pg_temp.id('docs'));
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d3');
do $$ begin
  assert pg_temp.reads('docs') and pg_temp.reads_note('01TM000000000000000000N001'), 'a team member reads the team KB and its notes';
  assert public.kb_shape(pg_temp.id('docs')) ->> 'role' = 'reader', 'as a reader';
  assert pg_temp.id('docs') = any (public.kb_readable_ids()), 'and search covers it';
end $$;
select pg_temp.expect_error($$ select public.kb_set_access(pg_temp.id('docs'), '[]') $$, 'Only the knowledge base''s admins');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d4');
do $$ begin
  assert not pg_temp.reads('docs') and not pg_temp.reads_note('01TM000000000000000000N001'), 'another team does not read it';
  assert not pg_temp.reads('alpha-meetings'), 'nor the team''s meetings';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d5');
do $$ begin
  assert not pg_temp.reads('docs') and not pg_temp.reads('alpha-meetings') and not pg_temp.reads('beta-meetings'), 'a member in no team reads no team KB';
  assert pg_temp.reads('ws-meetings'), 'and still reads the workspace meetings KB';
end $$;

-- 4. the lead grants Beta read on Alpha's meetings; the grant keeps Alpha on the list even when the lead leaves it out
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d2');
do $$ begin
  assert public.kb_shape(pg_temp.id('alpha-meetings')) ->> 'role' = 'admin', 'a lead is the admin of the team''s KBs';
end $$;
select pg_temp.expect_error($$ select public.kb_set_access(pg_temp.id('alpha-meetings'), '[{"principal": "team", "team_id": "nope"}]') $$, 'not in this workspace');
select public.kb_set_access(pg_temp.id('alpha-meetings'), jsonb_build_array(jsonb_build_object('principal', 'team', 'team_id', pg_temp.id('beta'), 'role', 'reader')));
do $$ begin
  assert (select count(*) from public.kb_access where kb_id = pg_temp.id('alpha-meetings') and principal = 'team') = 2, 'Beta is added and Alpha stays';
end $$;
-- a lead of Alpha is no admin of Beta's KBs
select pg_temp.expect_error($$ select public.kb_set_access(pg_temp.id('beta-meetings'), '[]') $$, 'no longer exists');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d4');
do $$ begin
  assert pg_temp.reads('alpha-meetings'), 'Beta reads Alpha''s meetings after the grant';
  assert not pg_temp.reads('docs'), 'and still not Alpha''s other KB';
  assert public.kb_shape(pg_temp.id('alpha-meetings')) ->> 'role' = 'reader', 'as a reader';
end $$;
-- a team can hold 0034's editor role on a hosted KB, and only there
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
insert into ids select 'hosted', public.kb_create_hosted('01TM00000000000000000000WA', 'Handbook') ->> 'id';
select public.kb_set_access(pg_temp.id('hosted'), jsonb_build_array(jsonb_build_object('principal', 'team', 'team_id', pg_temp.id('beta'), 'role', 'editor')));
select pg_temp.expect_error($$ select public.kb_set_access(pg_temp.id('docs'), jsonb_build_array(jsonb_build_object('principal', 'team', 'team_id', pg_temp.id('beta'), 'role', 'editor'))) $$, 'Editors are for knowledge bases hosted');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d4');
do $$ begin
  assert public.can_edit_kb(pg_temp.id('hosted')) and not public.can_admin_kb(pg_temp.id('hosted')), 'Beta edits the hosted KB through its team grant';
  assert public.kb_shape(pg_temp.id('hosted')) ->> 'role' = 'editor', 'and reads as an editor';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d3');
do $$ begin
  assert not pg_temp.reads('hosted') and not public.can_edit_kb(pg_temp.id('hosted')), 'Alpha neither reads nor edits it';
end $$;

-- 5. meeting notes route by team
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d3');
do $$ declare r jsonb; begin
  r := public.kb_meetings_folder('01TM00000000000000000000WA', '2026-11');
  assert r ->> 'kb_id' = pg_temp.id('alpha-meetings') and r ->> 'team_id' = pg_temp.id('alpha'), 'a member of one team routes to its meetings KB';
  assert public.kb_meetings_info('01TM00000000000000000000WA') ->> 'kb_id' = pg_temp.id('alpha-meetings'), 'and the info says so';
  insert into ids values ('alpha-nov', r ->> 'folder_id');
end $$;
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id, folder_id)
  select '01TM000000000000000000N002', '00000000-0000-4000-8000-0000000000d3', '01TM00000000000000000000WA', 'meetings/granola/sync.md', '{"visibility": "public", "keep_private": "false"}', '# Sync', pg_temp.id('alpha-meetings'), pg_temp.id('alpha-nov');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d5');
do $$ begin
  assert public.kb_meetings_folder('01TM00000000000000000000WA', '2026-11') ->> 'kb_id' = pg_temp.id('ws-meetings'), 'a member in no team routes to the workspace meetings KB';
  assert public.kb_meetings_info('01TM00000000000000000000WA') ->> 'team_id' is null, 'with no team';
end $$;
-- Beta reads Alpha's meetings but cannot put its own notes there
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d4');
select pg_temp.expect_error($$ insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id, folder_id) values ('01TM000000000000000000N003', '00000000-0000-4000-8000-0000000000d4', '01TM00000000000000000000WA', 'meetings/b.md', '{"visibility": "public"}', '# B', pg_temp.id('alpha-meetings'), pg_temp.id('alpha-nov')) $$, 'admins can add notes');
do $$ begin
  assert pg_temp.reads_note('01TM000000000000000000N002'), 'but reads Alpha''s meeting notes';
end $$;
-- in two teams: the team joined first until the person picks one
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select public.team_member_set(pg_temp.id('beta'), '00000000-0000-4000-8000-0000000000d3');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d3');
do $$ begin
  assert public.kb_meetings_folder('01TM00000000000000000000WA', '2026-11') ->> 'kb_id' = pg_temp.id('alpha-meetings'), 'the first team until a choice';
  assert jsonb_array_length(public.kb_meetings_info('01TM00000000000000000000WA') -> 'teams') = 2, 'the info lists both teams';
  perform public.team_meetings_default_set('01TM00000000000000000000WA', pg_temp.id('beta'));
  assert public.kb_meetings_folder('01TM00000000000000000000WA', '2026-12') ->> 'kb_id' = pg_temp.id('beta-meetings'), 'the chosen team after a choice';
  perform public.team_meetings_default_set('01TM00000000000000000000WA', null);
  assert public.kb_meetings_folder('01TM00000000000000000000WA', '2026-12') ->> 'kb_id' = pg_temp.id('alpha-meetings'), 'clearing it goes back to the first team';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d5');
select pg_temp.expect_error($$ select public.team_meetings_default_set('01TM00000000000000000000WA', pg_temp.id('alpha')) $$, 'not in that team');
-- a person may leave a team themselves
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d3');
select public.team_member_remove(pg_temp.id('beta'), '00000000-0000-4000-8000-0000000000d3');
do $$ begin
  assert not exists (select 1 from public.team_members where team_id = pg_temp.id('beta') and user_id = '00000000-0000-4000-8000-0000000000d3'), 'left Beta';
end $$;

-- 6. leaving the workspace removes the person's team memberships, and with them their team reads
reset role;
update public.members set deleted_at = now() where id = '01TM00000000000000000000M3';
do $$ begin
  assert not exists (select 1 from public.team_members where user_id = '00000000-0000-4000-8000-0000000000d3'), 'team memberships go with the workspace membership';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d3');
do $$ begin
  assert not pg_temp.reads('docs'), 'a person who left reads no team KB';
end $$;

-- 7. renaming a team renames its meetings KB; deleting it keeps its KBs as workspace KBs and grants nobody new reads
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d2');
select public.team_rename(pg_temp.id('alpha'), 'Platform');
do $$ begin
  assert (select name from public.knowledge_bases where id = pg_temp.id('alpha-meetings')) = 'Platform meetings', 'the meetings KB follows the team name';
  -- a change of case only: the team's own meetings KB does not count as a name already taken
  perform public.team_rename(pg_temp.id('alpha'), 'PLATFORM');
  assert (select name from public.knowledge_bases where id = pg_temp.id('alpha-meetings')) = 'PLATFORM meetings', 'its own meetings KB is no collision';
  perform public.team_rename(pg_temp.id('alpha'), 'Platform');
end $$;
-- a new team whose meetings name is taken gets a suffixed name instead of no meetings KB
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select public.kb_create('01TM00000000000000000000WA', 'Gamma meetings');
insert into ids select 'gamma', public.team_create('01TM00000000000000000000WA', 'Gamma') ->> 'id';
do $$ declare n text; begin
  select name into n from public.knowledge_bases where team_id = pg_temp.id('gamma') and kind = 'meetings';
  assert n ~ '^Gamma meetings [0-9a-f]{4}$', format('a taken name gets a suffix, got %s', n);
  assert public.team_shape(pg_temp.id('gamma')) ->> 'meetings_kb_id' is not null, 'the team has its meetings KB';
end $$;
-- a team-owned general KB for Gamma, so the workspace delete below removes team KBs of more than one kind
insert into ids select 'gamma-docs', public.kb_create('01TM00000000000000000000WA', 'Gamma docs', 'general', pg_temp.id('gamma')) ->> 'id';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d2');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select public.team_delete(pg_temp.id('alpha'));
do $$ begin
  assert (select team_id is null and kind = 'general' from public.knowledge_bases where id = pg_temp.id('alpha-meetings')), 'the meetings KB becomes a workspace general KB';
  assert (select team_id is null from public.knowledge_bases where id = pg_temp.id('docs')), 'and so does the team KB';
  assert not exists (select 1 from public.kb_access where team_id = pg_temp.id('alpha')), 'the team leaves every access list';
  assert (select kb_id from public.notes where id = '01TM000000000000000000N001') = pg_temp.id('docs'), 'the notes stay in the KB';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d2');
do $$ begin
  assert not pg_temp.reads('docs'), 'the former lead no longer reads it';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d4');
do $$ begin
  assert pg_temp.reads('alpha-meetings'), 'Beta keeps the read it was granted';
  assert not pg_temp.reads('docs'), 'and gains no other';
end $$;

-- 8. a workspace that is removed takes its teams, their memberships, their KBs and access rows with it
reset role;
do $$ begin
  assert (select count(*) from public.knowledge_bases where workspace_id = '01TM00000000000000000000WA' and team_id is not null) >= 3, 'team KBs exist before the delete';
  assert exists (select 1 from public.kb_access where principal = 'team' and team_id = pg_temp.id('beta')), 'and team grants';
end $$;
delete from public.workspaces where id = '01TM00000000000000000000WA';
do $$ begin
  assert not exists (select 1 from public.teams where workspace_id = '01TM00000000000000000000WA'), 'teams go with the workspace';
  assert not exists (select 1 from public.team_members where workspace_id = '01TM00000000000000000000WA'), 'and memberships';
  assert not exists (select 1 from public.knowledge_bases where workspace_id = '01TM00000000000000000000WA'), 'and their KBs';
  assert not exists (select 1 from public.kb_access where team_id in (pg_temp.id('beta'), pg_temp.id('gamma'))), 'and team grants';
  assert not exists (select 1 from public.kb_resync where workspace_id = '01TM00000000000000000000WA'), 'and resync requests';
end $$;

select 'teams: ok';
rollback;
