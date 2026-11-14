-- Knowledge base import (migration 0026): kb_source_set and the review queue for notes written straight into a KB.
-- Needs a database with every migration applied (supabase start, or supabase db reset on a local stack). Everything
-- runs in one transaction that is rolled back, so it leaves the database as it found it:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/kb_import.sql
-- A failed check stops the script with the check's message; the last line printed on success is "kb import: ok".
begin;

-- fixtures. a1 owns the workspace, a3 is a member who reads every KB through the workspace grant
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000b1', 'owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000b3', 'member@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name) values ('01KB00000000000000000000WC', '00000000-0000-4000-8000-0000000000b1', 'Import Team');
insert into public.members (id, user_id, workspace_id, role) values ('01KB00000000000000000000M9', '00000000-0000-4000-8000-0000000000b3', '01KB00000000000000000000WC', 'member');

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

-- 1. the owner imports: a KB, a folder, and notes written with kb_id the way the app's upsert writes them
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
insert into ids select 'docs', public.kb_create('01KB00000000000000000000WC', 'Docs') ->> 'id';
insert into ids select 'guides', public.kb_folder_create(pg_temp.kb('docs'), null, 'guides') ->> 'id';
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id, folder_id)
  select '01KB000000000000000000NC01', '00000000-0000-4000-8000-0000000000b1', '01KB00000000000000000000WC', 'Knowledge bases/Docs/guides/a.md', '{"visibility": "public"}', '# A', pg_temp.kb('docs'), pg_temp.kb('guides');
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body)
  values ('01KB000000000000000000NC02', '00000000-0000-4000-8000-0000000000b1', '01KB00000000000000000000WC', 'mine/personal.md', '{"visibility": "public"}', '# Mine');
do $$ begin
  assert (select status from public.contributions where note_id = '01KB000000000000000000NC01') = 'included', 'a note written into a KB is included at once';
  assert (select status from public.contributions where note_id = '01KB000000000000000000NC02') = 'pending', 'a shared note outside any KB still waits for review';
  assert (select kb_id from public.notes where id = '01KB000000000000000000NC01') = pg_temp.kb('docs'), 'the note sits in the KB';
end $$;
-- a second import updates the same row; the contribution stays included
update public.notes set body = '# A2', frontmatter = '{"visibility": "public", "kb_source": "x"}' where id = '01KB000000000000000000NC01';
do $$ begin
  assert (select status from public.contributions where note_id = '01KB000000000000000000NC01') = 'included', 'an updated KB note stays included';
end $$;

-- 2. kb_source_set: github and zip only, a GitHub address checked, admins only
do $$ declare s jsonb; begin
  s := public.kb_source_set(pg_temp.kb('docs'), '{"kind": "github", "url": "https://github.com/example-org/handbook", "branch": "main", "name": "handbook"}') -> 'source';
  assert s ->> 'kind' = 'github' and s ->> 'url' = 'https://github.com/example-org/handbook' and s ->> 'branch' = 'main', 'the GitHub source is stored';
  assert s ->> 'imported_at' is not null and s ->> 'set_by' = '00000000-0000-4000-8000-0000000000b1', 'with when and who';
  s := public.kb_source_set(pg_temp.kb('docs'), '{"kind": "zip", "name": "Team docs.zip", "url": "https://example.com/x", "branch": "x"}') -> 'source';
  assert s ->> 'kind' = 'zip' and s ->> 'name' = 'Team docs.zip' and s ->> 'url' is null and s ->> 'branch' is null, 'a zip source keeps its name only';
end $$;
select pg_temp.expect_error($$ select public.kb_source_set(pg_temp.kb('docs'), '{"kind": "git", "url": "https://github.com/a/b"}') $$, 'GitHub repository or a zip');
select pg_temp.expect_error($$ select public.kb_source_set(pg_temp.kb('docs'), '{"kind": "github", "url": "https://example.com/a/b"}') $$, 'GitHub repository address');
select pg_temp.expect_error($$ select public.kb_source_set(pg_temp.kb('docs'), '{"kind": "github", "url": "https://github.com/a/b/tree/main"}') $$, 'GitHub repository address');
select pg_temp.expect_error($$ select public.kb_source_set('01KB00000000000000000000XX', '{"kind": "zip"}') $$, 'no longer exists');

-- 3. a member who reads the KB cannot set its source or write notes into it
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b3');
select pg_temp.expect_error($$ select public.kb_source_set(pg_temp.kb('docs'), '{"kind": "zip", "name": "x.zip"}') $$, 'admins can change');
select pg_temp.expect_error($$ insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id) select '01KB000000000000000000NC03', '00000000-0000-4000-8000-0000000000b3', '01KB00000000000000000000WC', 'Knowledge bases/Docs/b.md', '{"visibility": "public"}', '# B', pg_temp.kb('docs') $$, 'admins can add notes');

-- 4. a KB with a Mac-side source keeps it
reset role;
update public.knowledge_bases set source = '{"kind": "folder", "path": "/Shared/Docs"}' where id = (select v from ids where k = 'docs');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
do $$ begin
  assert public.kb_source_set(pg_temp.kb('docs'), '{"kind": "zip", "name": "x.zip"}') -> 'source' ->> 'kind' = 'folder', 'a folder source stays';
end $$;

reset role;
select 'kb import: ok';
rollback;
