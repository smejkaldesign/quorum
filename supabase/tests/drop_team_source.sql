-- Dropping the 0020 team source (migration 0037): the copy into the default KB, the RPC and column gone, and
-- kb_default_source_set working without the column. The script applies 0037 inside its own transaction, which is
-- rolled back, so it runs on a stack before or after 0037 is applied (after, it checks that a second run changes
-- nothing):
--   sed '/^-- 0037 runs here$/r supabase/migrations/0037_drop_team_source.sql' supabase/tests/drop_team_source.sql | docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- A failed check stops the script with the check's message; the last line printed on success is "drop team source: ok".
begin;

-- fixtures. c1 owns every workspace, c2 is an admin of WA, c3 a member of WA
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000c1', 'owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000c2', 'admin@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000c3', 'member@example.com', 'authenticated', 'authenticated');
-- WA and WB have their team on (so a default KB), WC never turned it on, WD's default KB was imported from GitHub
insert into public.workspaces (id, user_id, name, team_enabled) values
  ('01TS00000000000000000000WA', '00000000-0000-4000-8000-0000000000c1', 'Agreed', true),
  ('01TS00000000000000000000WB', '00000000-0000-4000-8000-0000000000c1', 'Behind', true),
  ('01TS00000000000000000000WD', '00000000-0000-4000-8000-0000000000c1', 'Imported', true);
insert into public.workspaces (id, user_id, name) values ('01TS00000000000000000000WC', '00000000-0000-4000-8000-0000000000c1', 'Solo');
insert into public.members (id, user_id, workspace_id, role) values
  ('01TS00000000000000000000M2', '00000000-0000-4000-8000-0000000000c2', '01TS00000000000000000000WA', 'admin'),
  ('01TS00000000000000000000M3', '00000000-0000-4000-8000-0000000000c3', '01TS00000000000000000000WA', 'member');
update public.knowledge_bases set source = '{"kind": "git", "url": "https://example.com/agreed.git", "path": null, "set_at": "2026-10-01T00:00:00Z"}'
  where workspace_id = '01TS00000000000000000000WA' and is_default;
update public.knowledge_bases set source = '{"kind": "github", "url": "https://github.com/example/handbook", "name": "handbook"}'
  where workspace_id = '01TS00000000000000000000WD' and is_default;
-- the 0020 column, while it is still there: WA matches its KB, WB's KB never got its folder, WC has no KB at all
create temp table had_column as
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'team_source') as v;
do $$ begin
  if not (select v from had_column) then return; end if;
  execute $s$update public.workspaces set team_source = '{"kind": "git", "url": "https://example.com/agreed.git", "path": null, "set_at": "2026-10-01T00:00:00Z"}' where id = '01TS00000000000000000000WA'$s$;
  execute $s$update public.workspaces set team_source = '{"kind": "folder", "url": null, "path": "/Volumes/Team/Behind", "set_at": "2026-10-02T00:00:00Z"}' where id = '01TS00000000000000000000WB'$s$;
  execute $s$update public.workspaces set team_source = '{"kind": "git", "url": "https://example.com/solo.git", "path": null, "set_at": "2026-10-03T00:00:00Z"}' where id = '01TS00000000000000000000WC'$s$;
end $$;
create temp table before as select workspace_id, source from public.knowledge_bases where is_default;

-- 0037 runs here

-- 1. the copy: sources the default KB already carried are unchanged, the missing ones arrive
do $$
declare src jsonb;
begin
  assert (select source from public.knowledge_bases where workspace_id = '01TS00000000000000000000WA' and is_default)
    = (select source from before where workspace_id = '01TS00000000000000000000WA'), 'a default KB source that matched the column is unchanged';
  assert (select source from public.knowledge_bases where workspace_id = '01TS00000000000000000000WD' and is_default) ->> 'kind' = 'github', 'an import source is unchanged';
  if (select v from had_column) then
    src := (select source from public.knowledge_bases where workspace_id = '01TS00000000000000000000WB' and is_default);
    assert src ->> 'kind' = 'folder' and src ->> 'path' = '/Volumes/Team/Behind' and src ->> 'set_at' = '2026-10-02T00:00:00Z', 'a source only the column had is copied to the default KB';
    src := (select source from public.knowledge_bases where workspace_id = '01TS00000000000000000000WC' and is_default);
    assert src ->> 'url' = 'https://example.com/solo.git', 'a workspace with a source and no default KB gets one carrying it';
  else
    assert (select source from public.knowledge_bases where workspace_id = '01TS00000000000000000000WB' and is_default) is null, 'a second run copies nothing';
  end if;
end $$;

-- 2. the 0020 RPC and column are gone, and a new default KB starts without a source
do $$ begin
  assert to_regprocedure('public.workspace_team_source_set(public.ulid, jsonb)') is null, 'the 0020 RPC is dropped';
  assert not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'team_source'), 'the column is dropped';
end $$;
insert into public.workspaces (id, user_id, name, team_enabled) values ('01TS00000000000000000000WE', '00000000-0000-4000-8000-0000000000c1', 'Fresh', true);
do $$ begin
  assert (select source from public.knowledge_bases where workspace_id = '01TS00000000000000000000WE' and is_default) is null, 'a new default KB has no source';
end $$;

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

-- 3. what an app from 0.3.x calls now fails
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c2');
select pg_temp.expect_error($$ select public.workspace_team_source_set('01TS00000000000000000000WA', '{"kind": "sync"}') $$, 'does not exist');
select pg_temp.expect_error($$ select team_source from public.workspaces where id = '01TS00000000000000000000WA' $$, 'does not exist');

-- 4. kb_default_source_set without the column: admins only, the same checks, and every reader sees it in kb_list
select pg_temp.expect_error($$ select public.kb_default_source_set('01TS00000000000000000000WA', '{"kind": "drive"}') $$, 'Unknown knowledge source');
select pg_temp.expect_error($$ select public.kb_default_source_set('01TS00000000000000000000WA', '{"kind": "git"}') $$, 'needs a repository URL');
select pg_temp.expect_error($$ select public.kb_default_source_set('01TS00000000000000000000WA', '{"kind": "folder", "path": " "}') $$, 'needs a path');
do $$
declare r jsonb := public.kb_default_source_set('01TS00000000000000000000WA', '{"kind": "folder", "path": "/Volumes/Team/Knowledge", "url": "https://ignored.example"}');
begin
  assert r ->> 'is_default' = 'true' and r -> 'source' ->> 'kind' = 'folder', 'it returns the default KB with its new source';
  assert r -> 'source' ->> 'url' is null and r -> 'source' ->> 'set_by' = '00000000-0000-4000-8000-0000000000c2' and r -> 'source' ->> 'set_at' is not null, 'a folder keeps only its path, with who set it and when';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c3');
select pg_temp.expect_error($$ select public.kb_default_source_set('01TS00000000000000000000WA', '{"kind": "sync"}') $$, 'Only owners and admins');
do $$ begin
  assert (select k -> 'source' ->> 'path' from jsonb_array_elements(public.kb_list('01TS00000000000000000000WA')) k where (k ->> 'is_default')::boolean) = '/Volumes/Team/Knowledge', 'a member reads the source from kb_list';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000c2');
select public.kb_default_source_set('01TS00000000000000000000WA', '{"kind": "sync"}');
do $$ begin
  assert (select source from public.knowledge_bases where workspace_id = '01TS00000000000000000000WA' and is_default) is null, 'Quorum sync clears the source';
end $$;

reset role;
select 'drop team source: ok';
rollback;
