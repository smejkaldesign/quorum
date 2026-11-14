-- Quorum's edits kept as suggestions on synced KB notes (migration 0031): KB admins record bases, read, apply and
-- dismiss suggestions, including on a note another admin synced; readers see no row and are refused every write; a
-- note written by hand is passed over. Needs a database with every migration applied (supabase start, or supabase db
-- reset on a local stack). Everything runs in one transaction that is rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/kb_suggestions.sql
-- A failed check stops the script with the check's message; the last line printed on success is "kb suggestions: ok".
begin;

-- fixtures. s1 owns the workspace and imports the note; s2 is a member made admin of the KB; s3 is a member who reads it
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000e1', 'sugg-owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e2', 'sugg-admin@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e3', 'sugg-reader@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name) values ('01KE00000000000000000000WS', '00000000-0000-4000-8000-0000000000e1', 'Suggest Team');
insert into public.members (id, user_id, workspace_id, role) values
  ('01KE00000000000000000000M2', '00000000-0000-4000-8000-0000000000e2', '01KE00000000000000000000WS', 'member'),
  ('01KE00000000000000000000M3', '00000000-0000-4000-8000-0000000000e3', '01KE00000000000000000000WS', 'member');

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

-- 1. the owner makes a KB, gives s2 admin and s3 reader, and imports a note; a hand-written note sits beside it
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
insert into ids select 'docs', public.kb_create('01KE00000000000000000000WS', 'Docs') ->> 'id';
select public.kb_set_access(pg_temp.kb('docs'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000e2", "role": "admin"}, {"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000e3", "role": "reader"}]');
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id)
  select '01KE000000000000000000NS01', '00000000-0000-4000-8000-0000000000e1', '01KE00000000000000000000WS', 'Knowledge bases/Docs/Plan.md',
    '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/main/Plan.md"}', '# Plan v2', 'h2', pg_temp.kb('docs');
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id)
  select '01KE000000000000000000NS02', '00000000-0000-4000-8000-0000000000e1', '01KE00000000000000000000WS', 'Knowledge bases/Docs/Hand.md',
    '{"visibility": "public"}', '# Hand', pg_temp.kb('docs');
select public.kb_upstream_save(pg_temp.kb('docs'), '[{"note_id": "01KE000000000000000000NS01", "base_hash": "h2", "base_body": "# Plan v2"}, {"note_id": "01KE000000000000000000NS02", "base_hash": "x", "base_body": "# Hand"}]');
do $$ begin
  assert (select count(*) from public.kb_note_upstream) = 1, 'only the synced note gets a base; the hand-written one is passed over';
  assert (select suggestion_state from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') is null, 'no suggestion yet';
end $$;

-- 2. s2, a KB admin who did not import the note, records a suggestion and reads it; the time is set once and kept
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select public.kb_upstream_save(pg_temp.kb('docs'), '[{"note_id": "01KE000000000000000000NS01", "base_hash": "h2", "base_body": "# Plan v2", "suggestion_state": "ready", "suggestion_body": "# Plan v2\n\n- [[Ana]]", "suggestion_agent": "# Plan\n\n- [[Ana]]", "suggestion_base": "# Plan"}]');
insert into ids select 'at', suggested_at::text from public.kb_note_upstream where note_id = '01KE000000000000000000NS01';
select public.kb_upstream_save(pg_temp.kb('docs'), '[{"note_id": "01KE000000000000000000NS01", "base_hash": "h2", "base_body": "# Plan v2", "suggestion_state": "ready", "suggestion_body": "# Plan v2\n\n- [[Ana]]", "suggestion_agent": "# Plan\n\n- [[Ana]]", "suggestion_base": "# Plan"}]');
do $$ begin
  assert (select suggestion_state from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') = 'ready', 'the admin reads the suggestion';
  assert (select suggested_at::text from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') = pg_temp.kb('at'), 'the same suggestion keeps its time';
end $$;
select pg_temp.expect_error($$ select public.kb_upstream_save(pg_temp.kb('docs'), '[{"note_id": "01KE000000000000000000NS01", "suggestion_state": "maybe", "suggestion_body": "x"}]') $$, 'ready or stale');
select pg_temp.expect_error($$ insert into public.kb_note_upstream (note_id, workspace_id, kb_id) values ('01KE000000000000000000NS02', '01KE00000000000000000000WS', pg_temp.kb('docs')) $$, 'row-level security');

-- 3. a reader sees no row and is refused every write
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3');
do $$ begin
  assert (select count(*) from public.kb_note_upstream) = 0, 'a reader sees no upstream rows';
  assert (select count(*) from public.notes where id = '01KE000000000000000000NS01') = 1, 'a reader still reads the note';
end $$;
select pg_temp.expect_error($$ select public.kb_upstream_save(pg_temp.kb('docs'), '[]') $$, 'admins can sync');
select pg_temp.expect_error($$ select public.kb_suggestion_dismiss('01KE000000000000000000NS01') $$, 'admins can manage');
select pg_temp.expect_error($$ select public.kb_suggestion_apply('01KE000000000000000000NS01', 'x', '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/main/Plan.md"}', 'h', now(), now()) $$, 'admins can manage');

-- 4. s2 applies it: Quorum's copy takes the text, the suggestion clears, the base stays (the note reads as edited)
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select pg_temp.expect_error($$ select public.kb_suggestion_apply('01KE000000000000000000NS01', 'x', '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/main/Plan.md"}', 'h', now(), '2000-01-01') $$, 'no longer there');
select pg_temp.expect_error(format($f$ select public.kb_suggestion_apply('01KE000000000000000000NS01', 'x', '{"visibility": "public", "kb_source": "other"}', 'h', now(), %L) $f$, pg_temp.kb('at')), 'keeps the source');
select pg_temp.expect_error(format($f$ select public.kb_suggestion_apply('01KE000000000000000000NS01', 'x', '{"visibility": "private", "kb_source": "https://github.com/o/r/blob/main/Plan.md"}', 'h', now(), %L) $f$, pg_temp.kb('at')), 'must stay shared');
select public.kb_suggestion_apply('01KE000000000000000000NS01', E'# Plan v2\n\n- [[Ana]]', '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/main/Plan.md"}', 'h3', now(), pg_temp.kb('at')::timestamptz);
reset role;
do $$ begin
  assert (select body from public.notes where id = '01KE000000000000000000NS01') = E'# Plan v2\n\n- [[Ana]]', 'the suggestion is in Quorum''s copy';
  assert (select user_id from public.notes where id = '01KE000000000000000000NS01') = '00000000-0000-4000-8000-0000000000e1', 'the note stays its author''s';
  assert (select suggestion_state from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') is null, 'the suggestion is cleared';
  assert (select base_body from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') = '# Plan v2', 'the base stays the source''s text';
end $$;

-- 5. a stale suggestion is dismissed; a second dismiss on a note without a row says so
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select public.kb_upstream_save(pg_temp.kb('docs'), '[{"note_id": "01KE000000000000000000NS01", "base_hash": "h2", "base_body": "# Plan v2", "suggestion_state": "stale", "suggestion_body": "# Plan\n\n- [[Bo]]", "suggestion_agent": "# Plan\n\n- [[Bo]]", "suggestion_base": "# Plan"}]');
select pg_temp.expect_error(format($f$ select public.kb_suggestion_apply('01KE000000000000000000NS01', 'x', '{"visibility": "public", "kb_source": "https://github.com/o/r/blob/main/Plan.md"}', 'h', now(), %L) $f$, (select suggested_at::text from public.kb_note_upstream where note_id = '01KE000000000000000000NS01')), 'no longer there');
select public.kb_suggestion_dismiss('01KE000000000000000000NS01');
select pg_temp.expect_error($$ select public.kb_suggestion_dismiss('01KE000000000000000000NS02') $$, 'no longer there');
reset role;
do $$ begin
  assert (select suggestion_state from public.kb_note_upstream where note_id = '01KE000000000000000000NS01') is null, 'the stale suggestion is dismissed';
  assert (select body from public.notes where id = '01KE000000000000000000NS01') = E'# Plan v2\n\n- [[Ana]]', 'dismissing leaves the note as it is';
end $$;

-- 6. a deleted note takes its row with it
delete from public.notes where id = '01KE000000000000000000NS01';
do $$ begin
  assert (select count(*) from public.kb_note_upstream) = 0, 'the row goes with its note';
end $$;

select 'kb suggestions: ok';
rollback;
