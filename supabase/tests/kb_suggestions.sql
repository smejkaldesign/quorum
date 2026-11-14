-- Quorum's edits kept as suggestions on synced KB notes (migration 0031): KB admins write synced notes with their
-- bases, record bases, read, apply and dismiss suggestions, including on a note another admin synced; readers see no
-- row and are refused every write; a row follows its note (soft delete, a move to another KB, made private); a
-- hand-written note and a base that does not match its note are passed over. Needs a database with every migration
-- applied (supabase start, or supabase db reset on a local stack). Everything runs in one transaction that is rolled
-- back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/kb_suggestions.sql
-- A failed check stops the script with the check's message; the last line printed on success is "kb suggestions: ok".
begin;

-- fixtures. s1 owns the workspace and imports the notes; s2 is a member made admin of Docs; s3 is a member who reads
-- Docs; s4 is a member made admin of Other only
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000e1', 'sugg-owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e2', 'sugg-admin@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e3', 'sugg-reader@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e4', 'sugg-other@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name) values ('01KE00000000000000000000WS', '00000000-0000-4000-8000-0000000000e1', 'Suggest Team');
insert into public.members (id, user_id, workspace_id, role) values
  ('01KE00000000000000000000M2', '00000000-0000-4000-8000-0000000000e2', '01KE00000000000000000000WS', 'member'),
  ('01KE00000000000000000000M3', '00000000-0000-4000-8000-0000000000e3', '01KE00000000000000000000WS', 'member'),
  ('01KE00000000000000000000M4', '00000000-0000-4000-8000-0000000000e4', '01KE00000000000000000000WS', 'member');

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
create function pg_temp.visible(note text) returns bigint language sql as $$ select count(*) from public.kb_note_upstream where note_id = note $$;

-- 1. the owner makes two KBs and imports three notes into Docs; a hand-written note sits beside them
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
insert into ids select 'docs', public.kb_create('01KE00000000000000000000WS', 'Docs') ->> 'id';
insert into ids select 'other', public.kb_create('01KE00000000000000000000WS', 'Other') ->> 'id';
select public.kb_set_access(pg_temp.kb('docs'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000e2", "role": "admin"}, {"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000e3", "role": "reader"}]');
select public.kb_set_access(pg_temp.kb('other'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000e4", "role": "admin"}]');
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id)
  select x.id, '00000000-0000-4000-8000-0000000000e1', '01KE00000000000000000000WS', x.path, x.fm::jsonb, x.body, x.hash, pg_temp.kb('docs')
  from (values
    ('01KE000000000000000000NS01', 'Knowledge bases/Docs/Plan.md', '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/main/Plan.md"}', '# Plan', 'h1'),
    ('01KE000000000000000000NS03', 'Knowledge bases/Docs/Moved.md', '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/main/Moved.md"}', '# Moved', 'm1'),
    ('01KE000000000000000000NS04', 'Knowledge bases/Docs/Private.md', '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/main/Private.md"}', '# Private', 'p1'),
    ('01KE000000000000000000NS05', 'Knowledge bases/Docs/Gone.md', '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/main/Gone.md"}', '# Gone', 'g1'),
    ('01KE000000000000000000NS02', 'Knowledge bases/Docs/Hand.md', '{"visibility": "public"}', '# Hand', 'x1')
  ) as x(id, path, fm, body, hash);
select public.kb_upstream_save(pg_temp.kb('docs'), '[
  {"note_id": "01KE000000000000000000NS01", "base_hash": "h1", "base_norm": "n1", "base_body": "# Plan"},
  {"note_id": "01KE000000000000000000NS03", "base_hash": "m1", "base_body": "# Moved"},
  {"note_id": "01KE000000000000000000NS04", "base_hash": "p1", "base_body": "# Private"},
  {"note_id": "01KE000000000000000000NS05", "base_hash": "g1", "base_body": "# Gone"},
  {"note_id": "01KE000000000000000000NS02", "base_hash": "x1", "base_body": "# Hand"}]');
do $$ begin
  assert public.kb_upstream_save(pg_temp.kb('docs'), '[{"note_id": "01KE000000000000000000NS01", "base_hash": "not-the-note", "base_body": "x"}]') = 0, 'a base that does not match its note is not saved';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.kb_note_upstream) = 4, 'only the synced notes get a base; the hand-written one is passed over';
  assert (select base_body from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') = '# Plan', 'a base whose hash does not match its note is passed over';
end $$;

-- 2. s2, a KB admin who did not import the notes, writes a synced note with its base and two suggestions in one call
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select public.kb_synced_notes_write(pg_temp.kb('docs'), '[{"note_id": "01KE000000000000000000NS01", "body": "# Plan v2", "hash": "h2", "mtime": "2026-11-13T10:00:00Z",
  "frontmatter": {"visibility": "public", "kb_source": "https://github.com/o/r/blob/dev/Plan.md"},
  "upstream": {"base_hash": "h2", "base_norm": "n2", "base_body": "# Plan v2", "suggestions": [
    {"id": "s-ready", "state": "ready", "body": "# Plan v2\n\n- [[Ana]]", "agent": "# Plan\n\n- [[Ana]]", "base": "# Plan", "at": "2026-11-13T10:00:00Z"},
    {"id": "s-stale", "state": "stale", "body": "# Plan, Bo", "agent": "# Plan, Bo", "base": "# Plan", "at": "2026-11-13T10:00:00Z"}]}}]');
select pg_temp.expect_error($$ select public.kb_synced_notes_write(pg_temp.kb('docs'), '[{"note_id": "01KE000000000000000000NS01", "body": "x", "hash": "h", "mtime": "2026-11-13T10:00:00Z", "frontmatter": {"visibility": "public", "kb_source": "https://github.com/o/r/blob/main/Plan.md"}, "upstream": {"suggestions": [{"id": "a", "state": "maybe", "body": "x"}]}}]') $$, 'ready or stale');
select pg_temp.expect_error($$ select public.kb_synced_notes_write(pg_temp.kb('docs'), '[{"note_id": "01KE000000000000000000NS01", "body": "x", "hash": "h", "mtime": "2026-11-13T10:00:00Z", "frontmatter": {"visibility": "public"}}]') $$, 'keeps the source');
select pg_temp.expect_error($$ select public.kb_synced_notes_write(pg_temp.kb('docs'), '[{"note_id": "01KE000000000000000000NS02", "body": "x", "hash": "h", "mtime": "2026-11-13T10:00:00Z", "frontmatter": {"visibility": "public", "kb_source": "a"}}]') $$, 'no longer synced');
select pg_temp.expect_error($$ insert into public.kb_note_upstream (note_id, workspace_id, kb_id) values ('01KE000000000000000000NS02', '01KE00000000000000000000WS', pg_temp.kb('docs')) $$, 'row-level security|permission denied');
do $$ begin
  assert (select body from public.notes where id = '01KE000000000000000000NS01') = '# Plan v2', 'the note took the source''s text';
  assert (select hash from public.notes where id = '01KE000000000000000000NS01') = (select base_hash from public.kb_note_upstream where note_id = '01KE000000000000000000NS01'), 'note and base moved together';
  assert (select jsonb_array_length(suggestions) from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') = 2, 'both suggestions are kept';
end $$;

-- 3. a reader sees no row and is refused every write
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3');
do $$ begin
  assert (select count(*) from public.kb_note_upstream) = 0, 'a reader sees no upstream rows';
  assert (select count(*) from public.notes where id = '01KE000000000000000000NS01') = 1, 'a reader still reads the note';
end $$;
select pg_temp.expect_error($$ select public.kb_upstream_save(pg_temp.kb('docs'), '[]') $$, 'admins can sync');
select pg_temp.expect_error($$ select public.kb_synced_notes_write(pg_temp.kb('docs'), '[]') $$, 'admins can sync');
select pg_temp.expect_error($$ select public.kb_suggestion_dismiss('01KE000000000000000000NS01', 's-stale') $$, 'admins can manage');
select pg_temp.expect_error($$ select public.kb_suggestion_apply('01KE000000000000000000NS01', 's-ready', 'x', '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/dev/Plan.md"}', 'h', now(), 'h2') $$, 'admins can manage');

-- 4. s2 applies the ready one: refused with the wrong hash, a changed source or a private note; then Quorum's copy
--    takes the text, that suggestion leaves the list, the base stays (the note reads as edited), the stale one stays
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select pg_temp.expect_error($$ select public.kb_suggestion_apply('01KE000000000000000000NS01', 's-ready', 'x', '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/dev/Plan.md"}', 'h', now(), 'h1') $$, 'changed since you opened it');
select pg_temp.expect_error($$ select public.kb_suggestion_apply('01KE000000000000000000NS01', 's-stale', 'x', '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/dev/Plan.md"}', 'h', now(), 'h2') $$, 'no longer there');
select pg_temp.expect_error($$ select public.kb_suggestion_apply('01KE000000000000000000NS01', 's-ready', 'x', '{"visibility": "public", "kb_source": "other"}', 'h', now(), 'h2') $$, 'keeps the source');
select pg_temp.expect_error($$ select public.kb_suggestion_apply('01KE000000000000000000NS01', 's-ready', 'x', '{"visibility": "private", "kb_source": "https://github.com/o/r/blob/dev/Plan.md"}', 'h', now(), 'h2') $$, 'must stay shared');
select public.kb_suggestion_apply('01KE000000000000000000NS01', 's-ready', E'# Plan v2\n\n- [[Ana]]', '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/dev/Plan.md"}', 'h3', now(), 'h2');
reset role;
do $$ begin
  assert (select body from public.notes where id = '01KE000000000000000000NS01') = E'# Plan v2\n\n- [[Ana]]', 'the suggestion is in Quorum''s copy';
  assert (select user_id from public.notes where id = '01KE000000000000000000NS01') = '00000000-0000-4000-8000-0000000000e1', 'the note stays its author''s';
  assert (select suggestions -> 0 ->> 'id' from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') = 's-stale', 'only the applied suggestion left the list';
  assert (select jsonb_array_length(suggestions) from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') = 1, 'one suggestion is left';
  assert (select base_body from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') = '# Plan v2', 'the base stays the source''s text';
end $$;

-- 5. the stale one is dismissed by its id; a second dismiss, or one on a note without a row, says so
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select public.kb_suggestion_dismiss('01KE000000000000000000NS01', 's-stale');
select pg_temp.expect_error($$ select public.kb_suggestion_dismiss('01KE000000000000000000NS01', 's-stale') $$, 'no longer there');
select pg_temp.expect_error($$ select public.kb_suggestion_dismiss('01KE000000000000000000NS02', 'x') $$, 'no longer there');
do $$ begin
  assert (select suggestions from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') = '[]'::jsonb, 'the list is empty';
  assert (select body from public.notes where id = '01KE000000000000000000NS01') = E'# Plan v2\n\n- [[Ana]]', 'dismissing leaves the note as it is';
end $$;

-- 6. a row follows its note. A soft-deleted note takes its row along; a note made private leaves the KB and takes its
--    row along; a note moved to Other is read by Other's admin and no longer by Docs' admins
reset role;
select set_config('quorum.kb_system', 'on', true), set_config('request.jwt.claims', '', true);
update public.notes set deleted_at = now() where id = '01KE000000000000000000NS05';
update public.notes set frontmatter = '{"visibility": "private", "kb_source": "https://github.com/o/r/blob/main/Private.md"}' where id = '01KE000000000000000000NS04';
update public.notes set kb_id = pg_temp.kb('other'), folder_id = null where id = '01KE000000000000000000NS03';
do $$ begin
  assert (select count(*) from public.kb_note_upstream where note_id = '01KE000000000000000000NS05') = 0, 'a soft-deleted note takes its row along';
  assert (select kb_id from public.notes where id = '01KE000000000000000000NS04') is null, 'a private note left the KB';
  assert (select count(*) from public.kb_note_upstream where note_id = '01KE000000000000000000NS04') = 0, 'a private note takes its row along';
  assert (select kb_id from public.kb_note_upstream where note_id = '01KE000000000000000000NS03') = pg_temp.kb('other'), 'a moved note''s row moves with it';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
do $$ begin
  assert pg_temp.visible('01KE000000000000000000NS03') = 0, 'Docs'' admin no longer reads the moved note''s row';
  assert pg_temp.visible('01KE000000000000000000NS01') = 1, 'Docs'' admin still reads the row of a note in Docs';
end $$;
select pg_temp.expect_error($$ select public.kb_synced_notes_write(pg_temp.kb('docs'), '[{"note_id": "01KE000000000000000000NS03", "body": "x", "hash": "h", "mtime": "2026-11-13T10:00:00Z", "frontmatter": {"visibility": "public", "kb_source": "a"}}]') $$, 'no longer synced');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e4');
do $$ begin
  assert pg_temp.visible('01KE000000000000000000NS03') = 1, 'Other''s admin reads the moved note''s row';
  assert pg_temp.visible('01KE000000000000000000NS01') = 0, 'Other''s admin reads no row of Docs';
end $$;
-- the policy itself follows the note, so a row the trigger has not touched yet stays hidden once the note is deleted
reset role;
alter table public.notes disable trigger notes_kb_upstream;
update public.notes set deleted_at = now() where id = '01KE000000000000000000NS03';
alter table public.notes enable trigger notes_kb_upstream;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e4');
do $$ begin
  assert pg_temp.visible('01KE000000000000000000NS03') = 0, 'a row of a soft-deleted note is hidden by the policy';
end $$;

-- 7. a hard-deleted note takes its row with it
reset role;
delete from public.notes where id = '01KE000000000000000000NS01';
do $$ begin
  assert (select count(*) from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') = 0, 'the row goes with its note';
end $$;

select 'kb suggestions: ok';
rollback;
