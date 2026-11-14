-- The default KB's team source (migration 0036): kb_default_source_set, and the 0020 column kept in step for apps from
-- 0.3.x. Needs a database with every migration applied (supabase start, or supabase db reset on a local stack).
-- Everything runs in one transaction that is rolled back, so it leaves the database as it found it:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/default_kb_source.sql
-- A failed check stops the script with the check's message; the last line printed on success is "default kb source: ok".
begin;

-- fixtures. c1 owns both workspaces, c2 is an admin of WA, c3 a member of WA. WA has its team on (so a default KB);
-- WC never turned it on
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000c1', 'owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000c2', 'admin@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000c3', 'member@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name, team_enabled) values ('01DS00000000000000000000WA', '00000000-0000-4000-8000-0000000000c1', 'Team', true);
insert into public.workspaces (id, user_id, name) values ('01DS00000000000000000000WC', '00000000-0000-4000-8000-0000000000c1', 'Solo');
insert into public.members (id, user_id, workspace_id, role) values
  ('01DS00000000000000000000M2', '00000000-0000-4000-8000-0000000000c2', '01DS00000000000000000000WA', 'admin'),
  ('01DS00000000000000000000M3', '00000000-0000-4000-8000-0000000000c3', '01DS00000000000000000000WA', 'member');

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
-- the source as the 0.4.0 app reads it (kb_list) and as a 0.3.x app reads it (the 0020 column), for the caller
create function pg_temp.kb_source(ws public.ulid) returns jsonb language sql as $$
  select k -> 'source' from jsonb_array_elements(public.kb_list(ws)) k where (k ->> 'is_default')::boolean;
$$;
create function pg_temp.column_source(ws public.ulid) returns jsonb language sql as $$
  select team_source from public.workspaces where id = ws;
$$;

-- 1. the same checks as the 0020 RPC, and owners and admins only
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c2');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "drive"}') $$, 'Unknown knowledge source');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "git"}') $$, 'needs a repository URL');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "folder", "path": " "}') $$, 'needs a path');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "sync"}') $$, 'Only owners and admins');

-- 2. a workspace with no default KB is told to switch the team on, and nothing is written
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WC', '{"kind": "git", "url": "https://example.com/solo.git"}') $$, 'Switch the team on first');
do $$ begin
  assert pg_temp.column_source('01DS00000000000000000000WC') is null, 'a refused call leaves the column alone';
end $$;

-- 3. a folder source: the KB and the 0020 column carry the same value, and a member reads it both ways
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c2');
do $$
declare r jsonb := public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "folder", "path": "/Volumes/Team/Knowledge", "url": "https://ignored.example"}');
begin
  assert r ->> 'is_default' = 'true' and r -> 'source' ->> 'kind' = 'folder', 'it returns the default KB with its new source';
  assert r -> 'source' ->> 'url' is null and r -> 'source' ->> 'set_by' = '00000000-0000-4000-8000-0000000000c2' and r -> 'source' ->> 'set_at' is not null, 'a folder keeps only its path, with who set it and when';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
do $$ begin
  assert pg_temp.kb_source('01DS00000000000000000000WA') ->> 'path' = '/Volumes/Team/Knowledge', 'a member reads the source from kb_list';
  assert pg_temp.column_source('01DS00000000000000000000WA') = pg_temp.kb_source('01DS00000000000000000000WA'), 'a 0.3.x app reading the column sees the same source';
end $$;

-- 4. a git source replaces it in both places; the 0020 RPC a 0.3.x admin calls still writes both too
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c2');
select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "git", "url": "https://example.com/team/knowledge.git"}');
do $$ begin
  assert pg_temp.kb_source('01DS00000000000000000000WA') ->> 'url' = 'https://example.com/team/knowledge.git', 'the KB carries the git source';
  assert pg_temp.column_source('01DS00000000000000000000WA') = pg_temp.kb_source('01DS00000000000000000000WA'), 'the column carries it too';
end $$;
select public.workspace_team_source_set('01DS00000000000000000000WA', '{"kind": "folder", "path": "/Volumes/Old/App"}');
do $$ begin
  assert pg_temp.kb_source('01DS00000000000000000000WA') ->> 'path' = '/Volumes/Old/App', 'a 0.3.x admin saving through the 0020 RPC reaches the KB the new app reads';
  assert pg_temp.column_source('01DS00000000000000000000WA') = pg_temp.kb_source('01DS00000000000000000000WA'), 'and the two still agree';
end $$;

-- 5. Quorum sync clears both
select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "sync"}');
do $$ begin
  assert pg_temp.kb_source('01DS00000000000000000000WA') = 'null'::jsonb or pg_temp.kb_source('01DS00000000000000000000WA') is null, 'sync clears the KB source';
  assert pg_temp.column_source('01DS00000000000000000000WA') is null, 'and the column';
end $$;

reset role;
select 'default kb source: ok';
rollback;
