-- The default KB's team source (migration 0036): kb_default_source_set, the 0020 RPC calling it, the 0020 column kept
-- in step for apps from 0.3.x, and the default KB made for a workspace that had a source and none. The script applies
-- 0036 inside its own transaction, which is rolled back, so it runs on a stack before or after 0036 is applied:
--   sed '/^-- 0036 runs here$/r supabase/migrations/0036_default_kb_source.sql' supabase/tests/default_kb_source.sql | docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- A failed check stops the script with the check's message; the last line printed on success is "default kb source: ok".
begin;

-- fixtures. c1 owns every workspace, c2 is an admin of WA, c3 a member of WA. WA has its team on (so a default KB);
-- WC never turned it on; WS set a folder source with the team off, so it has no default KB; WG's default KB was
-- imported from GitHub
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000c1', 'owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000c2', 'admin@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000c3', 'member@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name, team_enabled) values
  ('01DS00000000000000000000WA', '00000000-0000-4000-8000-0000000000c1', 'Team', true),
  ('01DS00000000000000000000WG', '00000000-0000-4000-8000-0000000000c1', 'Imported', true);
insert into public.workspaces (id, user_id, name) values
  ('01DS00000000000000000000WC', '00000000-0000-4000-8000-0000000000c1', 'Solo'),
  ('01DS00000000000000000000WS', '00000000-0000-4000-8000-0000000000c1', 'Source only');
insert into public.members (id, user_id, workspace_id, role) values
  ('01DS00000000000000000000M2', '00000000-0000-4000-8000-0000000000c2', '01DS00000000000000000000WA', 'admin'),
  ('01DS00000000000000000000M3', '00000000-0000-4000-8000-0000000000c3', '01DS00000000000000000000WA', 'member');
update public.workspaces set team_source = '{"kind": "folder", "url": null, "path": "/Volumes/Team/Only", "set_at": "2026-10-05T00:00:00Z"}' where id = '01DS00000000000000000000WS';
update public.knowledge_bases set source = '{"kind": "github", "url": "https://github.com/example/handbook", "name": "handbook"}'
  where workspace_id = '01DS00000000000000000000WG' and is_default;

-- 0036 runs here

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
-- the source as the 0.4.0 app reads it (the default KB row, through row level security) and as a 0.3.x app reads it
-- (the 0020 column), for the caller
create function pg_temp.kb_source(ws public.ulid) returns jsonb language sql as $$
  select source from public.knowledge_bases where workspace_id = ws and is_default;
$$;
create function pg_temp.column_source(ws public.ulid) returns jsonb language sql as $$
  select team_source from public.workspaces where id = ws;
$$;

-- 1. the migration gave WS a default KB carrying its folder source, and touched nothing else
do $$ begin
  assert pg_temp.kb_source('01DS00000000000000000000WS') ->> 'path' = '/Volumes/Team/Only', 'a workspace with a source and no default KB gets one carrying it';
  assert (select count(*) from public.knowledge_bases where workspace_id = '01DS00000000000000000000WS' and is_default) = 1, 'exactly one';
  assert not exists (select 1 from public.knowledge_bases where workspace_id = '01DS00000000000000000000WC'), 'a workspace with no source gets no KB';
  assert pg_temp.kb_source('01DS00000000000000000000WG') ->> 'kind' = 'github', 'an import source is unchanged';
end $$;

-- 2. the same checks as the 0020 RPC, and owners and admins only, through both RPCs
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c2');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "drive"}') $$, 'Unknown knowledge source');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "git"}') $$, 'needs a repository URL');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "folder", "path": " "}') $$, 'needs a path');
select pg_temp.expect_error($$ select public.workspace_team_source_set('01DS00000000000000000000WA', '{"kind": "folder", "path": " "}') $$, 'needs a path');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "sync"}') $$, 'Only owners and admins');
select pg_temp.expect_error($$ select public.workspace_team_source_set('01DS00000000000000000000WA', '{"kind": "sync"}') $$, 'Only owners and admins');

-- 3. a workspace without a default KB: Quorum sync needs none, a git source makes one, and both places agree
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
do $$ begin
  assert public.kb_default_source_set('01DS00000000000000000000WC', '{"kind": "sync"}') -> 'source' = 'null'::jsonb, 'sync on a workspace without a default KB answers no source';
  assert not exists (select 1 from public.knowledge_bases where workspace_id = '01DS00000000000000000000WC'), 'and makes no KB';
  assert public.kb_default_source_set('01DS00000000000000000000WC', '{"kind": "git", "url": " https://example.com/solo.git "}') -> 'source' ->> 'url' = 'https://example.com/solo.git', 'a git source makes the default KB, trimmed';
  assert pg_temp.column_source('01DS00000000000000000000WC') = pg_temp.kb_source('01DS00000000000000000000WC'), 'the column carries the same value';
end $$;

-- 4. a folder source: the KB and the 0020 column carry the same value, and a member reads it both ways
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
  assert pg_temp.column_source('01DS00000000000000000000WA') = pg_temp.kb_source('01DS00000000000000000000WA'), 'a 0.3.x app reading the column sees the same source';
end $$;

-- 5. the 0020 RPC a 0.3.x admin calls goes through kb_default_source_set, trims the same way, and still returns the
-- source itself
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c2');
do $$
declare r jsonb := public.workspace_team_source_set('01DS00000000000000000000WA', '{"kind": "folder", "path": " /Volumes/Old/App "}');
begin
  assert r ->> 'kind' = 'folder' and r ->> 'path' = '/Volumes/Old/App', 'the 0020 RPC returns the trimmed source';
  assert pg_temp.kb_source('01DS00000000000000000000WA') = r and pg_temp.column_source('01DS00000000000000000000WA') = r, 'and writes it to both places';
end $$;

-- 6. an imported default KB keeps its import source, through either RPC
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WG', '{"kind": "folder", "path": "/Volumes/Other"}') $$, 'imported from GitHub. Change its source in Settings › Admin › Knowledge');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WG', '{"kind": "sync"}') $$, 'imported from GitHub');
select pg_temp.expect_error($$ select public.workspace_team_source_set('01DS00000000000000000000WG', '{"kind": "git", "url": "https://example.com/x.git"}') $$, 'imported from GitHub');
reset role;
update public.knowledge_bases set source = '{"kind": "zip", "name": "export.zip"}' where workspace_id = '01DS00000000000000000000WG' and is_default;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WG', '{"kind": "folder", "path": "/Volumes/Other"}') $$, 'imported from a zip');
do $$ begin
  assert pg_temp.kb_source('01DS00000000000000000000WG') ->> 'kind' = 'zip', 'the import source is still there';
  assert pg_temp.column_source('01DS00000000000000000000WG') is null, 'and the refused calls left the column alone';
end $$;

-- a hosted default KB (0034) keeps its hosted source
reset role;
update public.knowledge_bases set source = '{"kind": "hosted"}' where workspace_id = '01DS00000000000000000000WG' and is_default;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c1');
select pg_temp.expect_error($$ select public.kb_default_source_set('01DS00000000000000000000WG', '{"kind": "sync"}') $$, 'hosted by Quorum');
do $$ begin
  assert pg_temp.kb_source('01DS00000000000000000000WG') ->> 'kind' = 'hosted', 'the hosted source is still there';
end $$;

-- 7. Quorum sync clears both
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c2');
select public.kb_default_source_set('01DS00000000000000000000WA', '{"kind": "sync"}');
do $$ begin
  assert pg_temp.kb_source('01DS00000000000000000000WA') is null, 'sync clears the KB source';
  assert pg_temp.column_source('01DS00000000000000000000WA') is null, 'and the column';
end $$;

reset role;
select 'default kb source: ok';
rollback;
