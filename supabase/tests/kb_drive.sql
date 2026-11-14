-- Google Drive files in a knowledge base (migration 0028): any KB admin syncs, marks as checked and removes a Drive
-- note another admin added; readers and non-Drive notes are refused. Needs a database with every migration applied
-- (supabase start, or supabase db reset on a local stack). Everything runs in one transaction that is rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/kb_drive.sql
-- A failed check stops the script with the check's message; the last line printed on success is "kb drive: ok".
begin;

-- fixtures. d1 owns the workspace and adds the file; d2 is a member made admin of the KB; d3 is a member who reads it
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000d1', 'drive-owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000d2', 'drive-admin@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000d3', 'drive-reader@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name) values ('01KD00000000000000000000WD', '00000000-0000-4000-8000-0000000000d1', 'Drive Team');
insert into public.members (id, user_id, workspace_id, role) values
  ('01KD00000000000000000000M2', '00000000-0000-4000-8000-0000000000d2', '01KD00000000000000000000WD', 'member'),
  ('01KD00000000000000000000M3', '00000000-0000-4000-8000-0000000000d3', '01KD00000000000000000000WD', 'member');

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

-- 1. the owner makes a KB, gives d2 admin and d3 reader, and adds a Drive file the way the app writes it
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
insert into ids select 'docs', public.kb_create('01KD00000000000000000000WD', 'Docs') ->> 'id';
select public.kb_set_access(pg_temp.kb('docs'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000d2", "role": "admin"}, {"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000d3", "role": "reader"}]');
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id)
  select '01KD000000000000000000ND01', '00000000-0000-4000-8000-0000000000d1', '01KD00000000000000000000WD', 'Knowledge bases/Docs/Plan.md',
    '{"visibility": "public", "kb_source": "google-drive:1AbCdEfGhIjK", "title": "Plan"}', '# Plan', 'h1', pg_temp.kb('docs');
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id)
  select '01KD000000000000000000ND02', '00000000-0000-4000-8000-0000000000d1', '01KD00000000000000000000WD', 'Knowledge bases/Docs/Hand.md',
    '{"visibility": "public"}', '# Hand', pg_temp.kb('docs');

-- 2. d2, a KB admin who did not add the file, syncs it: the text changes, the author, path and KB stay
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d2');
select public.kb_drive_note_write('01KD000000000000000000ND01', '# Plan v2', '{"visibility": "public", "kb_source": "google-drive:1AbCdEfGhIjK", "title": "Plan"}', 'h2', now());
select pg_temp.expect_error($$ select public.kb_drive_note_write('01KD000000000000000000ND01', 'x', '{"visibility": "public", "kb_source": "google-drive:other"}', 'h', now()) $$, 'keeps the Google Drive file');
select pg_temp.expect_error($$ select public.kb_drive_note_write('01KD000000000000000000ND01', 'x', '{"visibility": "public", "kb_source": "google-drive:1AbCdEfGhIjK", "confidential": "true"}', 'h', now()) $$, 'must stay shared');
select pg_temp.expect_error($$ select public.kb_drive_note_write('01KD000000000000000000ND02', 'x', '{"visibility": "public"}', 'h', now()) $$, 'no longer attached');
select public.kb_drive_note_checked('01KD000000000000000000ND01', '2026-11-13T10:00:00Z');
reset role;
do $$ begin
  assert (select body from public.notes where id = '01KD000000000000000000ND01') = '# Plan v2', 'the KB admin''s sync wrote the new text';
  assert (select hash from public.notes where id = '01KD000000000000000000ND01') = 'h2', 'the hash is the synced one';
  assert (select user_id from public.notes where id = '01KD000000000000000000ND01') = '00000000-0000-4000-8000-0000000000d1', 'the note stays its author''s';
  assert (select kb_id from public.notes where id = '01KD000000000000000000ND01') = pg_temp.kb('docs'), 'the note stays in the KB';
  assert (select frontmatter ->> 'kb_checked_at' from public.notes where id = '01KD000000000000000000ND01') = '2026-11-13T10:00:00.000Z', 'the check time is in the frontmatter';
end $$;

-- 3. a reader cannot sync or remove it
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d3');
select pg_temp.expect_error($$ select public.kb_drive_note_write('01KD000000000000000000ND01', 'x', '{"visibility": "public", "kb_source": "google-drive:1AbCdEfGhIjK"}', 'h', now()) $$, 'admins can manage');
select pg_temp.expect_error($$ select public.kb_drive_note_remove('01KD000000000000000000ND01') $$, 'admins can manage');

-- 4. d2 removes it; the note is gone for everyone and a second remove says so
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d2');
select public.kb_drive_note_remove('01KD000000000000000000ND01');
select pg_temp.expect_error($$ select public.kb_drive_note_remove('01KD000000000000000000ND01') $$, 'no longer attached');
reset role;
do $$ begin
  assert (select deleted_at from public.notes where id = '01KD000000000000000000ND01') is not null, 'the removed note is soft deleted';
end $$;

select 'kb drive: ok';
rollback;
