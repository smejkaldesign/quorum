-- The default KB's team source (migrations 0036 and 0037): kb_default_source_set once 0037 dropped the 0020 column and
-- RPC (supabase/tests/drop_team_source.sql covers the drop itself). Needs a database with every migration applied
-- (supabase start, or supabase db reset on a local stack). Everything runs in one transaction that is rolled back, so
-- it leaves the database as it found it:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/default_kb_source.sql
-- A failed check stops the script with the check's message; the last line printed on success is "default kb source: ok".
begin;

-- fixtures. c1 owns every workspace, c2 is an admin of WA, c3 a member of WA. WA has its team on (so a default KB);
-- WC never turned it on; WG's default KB was imported from GitHub
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000c1', 'owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000c2', 'admin@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000c3', 'member@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name, team_enabled) values
  ('01DS00000000000000000000WA', '00000000-0000-4000-8000-0000000000c1', 'Team', true),
  ('01DS00000000000000000000WG', '00000000-0000-4000-8000-0000000000c1', 'Imported', true);
insert into public.workspaces (id, user_id, name) values ('01DS00000000000000000000WC', '00000000-0000-4000-8000-0000000000c1', 'Solo');
insert into public.members (id, user_id, workspace_id, role) values
  ('01DS00000000000000000000M2', '00000000-0000-4000-8000-0000000000c2', '01DS00000000000000000000WA', 'admin'),
  ('01DS00000000000000000000M3', '00000000-0000-4000-8000-0000000000c3', '01DS00000000000000000000WA', 'member');
update public.knowledge_bases set source = '{"kind": "github", "url": "https://github.com/example/handbook", "name": "handbook"}'
  where workspace_id = '01DS00000000000000000000WG' and is_default;

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
-- the source as the app reads it: the default KB row, through row level security, for the caller
create function pg_temp.kb_source(ws public.ulid) returns jsonb language sql as $$
  select source from public.knowledge_bases where workspace_id = ws and is_default;
$$;

-- 1. the checks, owners and admins only
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c2');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "drive"}') $$, 'Unknown knowledge source');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "git"}') $$, 'needs a repository URL');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "folder", "path": " "}') $$, 'needs a path');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "sync"}') $$, 'Only owners and admins');

-- 2. a workspace without a default KB: Quorum sync needs none, a git source makes one
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
do $$ begin
  assert public.kb_default_source_set('01DS00000000000000000000WC', '{"kind": "sync"}') -> 'source' = 'null'::jsonb, 'sync on a workspace without a default KB answers no source';
  assert not exists (select 1 from public.knowledge_bases where workspace_id = '01DS00000000000000000000WC'), 'and makes no KB';
  assert public.kb_default_source_set('01DS00000000000000000000WC', '{"kind": "git", "url": " https://example.com/solo.git "}') -> 'source' ->> 'url' = 'https://example.com/solo.git', 'a git source makes the default KB, trimmed';
  assert pg_temp.kb_source('01DS00000000000000000000WC') ->> 'url' = 'https://example.com/solo.git', 'and the KB carries it';
end $$;

-- 3. a folder source, read by a member
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c2');
do $$
declare r jsonb := public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "folder", "path": "/Volumes/Team/Knowledge", "url": "https://ignored.example"}');
begin
  assert r ->> 'is_default' = 'true' and r -> 'source' ->> 'kind' = 'folder', 'it returns the default KB with its new source';
  assert r -> 'source' ->> 'url' is null and r -> 'source' ->> 'set_by' = '00000000-0000-4000-8000-0000000000c2' and r -> 'source' ->> 'set_at' is not null, 'a folder keeps only its path, with who set it and when';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
do $$ begin
  assert pg_temp.kb_source('01DS00000000000000000000WA') ->> 'path' = '/Volumes/Team/Knowledge', 'a member reads the default KB row';
end $$;

-- 4. an imported default KB keeps its import source
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WG', '{"kind": "folder", "path": "/Volumes/Other"}') $$, 'imported from GitHub. Change its source in Settings › Admin › Knowledge');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WG', '{"kind": "sync"}') $$, 'imported from GitHub');
reset role;
update public.knowledge_bases set source = '{"kind": "zip", "name": "export.zip"}' where workspace_id = '01DS00000000000000000000WG' and is_default;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WG', '{"kind": "folder", "path": "/Volumes/Other"}') $$, 'imported from a zip');
do $$ begin
  assert pg_temp.kb_source('01DS00000000000000000000WG') ->> 'kind' = 'zip', 'the import source is still there';
end $$;

-- a hosted default KB (0034) keeps its hosted source
reset role;
update public.knowledge_bases set source = '{"kind": "hosted"}' where workspace_id = '01DS00000000000000000000WG' and is_default;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WG', '{"kind": "sync"}') $$, 'hosted by Quorum');
do $$ begin
  assert pg_temp.kb_source('01DS00000000000000000000WG') ->> 'kind' = 'hosted', 'the hosted source is still there';
end $$;

-- 5. Quorum sync clears it
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c2');
select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "sync"}');
do $$ begin
  assert pg_temp.kb_source('01DS00000000000000000000WA') is null, 'sync clears the KB source';
end $$;

reset role;
select 'default kb source: ok';
rollback;
