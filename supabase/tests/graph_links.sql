-- Cloud graph sync (migration 0049): who can publish memory graph edges on links, who reads them, and what happens when
-- a note leaves its knowledge base. Needs a database with every migration applied (supabase start, or supabase db reset
-- on a local stack). Everything runs in one transaction that is rolled back, so it leaves the database as it found it:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/graph_links.sql
-- A failed check stops the script with the check's message; the last line printed on success is "graph links: ok".
begin;

-- fixtures. g1 owns the workspace; g2 writes the notes; g3 reads the Handbook only; g4 is a member with no extra
-- grant; g5 is elsewhere. Handbook is readable by the workspace, Leadership by g2 alone (and the owner)
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000e1', 'owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e2', 'author@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e3', 'reader@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e4', 'member@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e5', 'outsider@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name) values ('01GR00000000000000000000WA', '00000000-0000-4000-8000-0000000000e1', 'Graph Works');
insert into public.workspaces (id, user_id, name) values ('01GR00000000000000000000WB', '00000000-0000-4000-8000-0000000000e5', 'Elsewhere');
insert into public.members (id, user_id, workspace_id, role) values
  ('01GR00000000000000000000M2', '00000000-0000-4000-8000-0000000000e2', '01GR00000000000000000000WA', 'member'),
  ('01GR00000000000000000000M3', '00000000-0000-4000-8000-0000000000e3', '01GR00000000000000000000WA', 'member'),
  ('01GR00000000000000000000M4', '00000000-0000-4000-8000-0000000000e4', '01GR00000000000000000000WA', 'member');
insert into public.knowledge_bases (id, workspace_id, name) values
  ('01GR00000000000000000000KH', '01GR00000000000000000000WA', 'Handbook'),
  ('01GR00000000000000000000KM', '01GR00000000000000000000WA', 'Leadership');
insert into public.kb_access (kb_id, principal, role) values ('01GR00000000000000000000KH', 'workspace', 'reader');
insert into public.kb_access (kb_id, principal, user_id, role) values ('01GR00000000000000000000KM', 'user', '00000000-0000-4000-8000-0000000000e2', 'admin');
-- N1 and N4 in the Handbook, N2 in Leadership, N3 private, N5 public but in no knowledge base
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id) values
  ('01GR000000000000000000N001', '00000000-0000-4000-8000-0000000000e2', '01GR00000000000000000000WA', 'projects/Heron.md', '{"visibility": "public"}', '# Heron', '01GR00000000000000000000KH'),
  ('01GR000000000000000000N002', '00000000-0000-4000-8000-0000000000e2', '01GR00000000000000000000WA', 'leads/Plan.md', '{"visibility": "public"}', '# Plan', '01GR00000000000000000000KM'),
  ('01GR000000000000000000N003', '00000000-0000-4000-8000-0000000000e2', '01GR00000000000000000000WA', 'diary/Today.md', '{}', '# Today', null),
  ('01GR000000000000000000N004', '00000000-0000-4000-8000-0000000000e3', '01GR00000000000000000000WA', 'meetings/Kickoff.md', '{"visibility": "public"}', '# Kickoff', '01GR00000000000000000000KH'),
  ('01GR000000000000000000N005', '00000000-0000-4000-8000-0000000000e2', '01GR00000000000000000000WA', 'notes/Open.md', '{"visibility": "public"}', '# Open', null);

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
-- one published edge as the app sends it; k picks the edge key and the id
create function pg_temp.edge(k int, kind text default 'mentions', prov text default 'explicit', conf real default 1, props jsonb default null) returns jsonb language sql as $$
  select jsonb_build_object('id', '01GR0000000000000000E' || lpad(k::text, 5, '0'), 'kind', kind, 'provenance', prov, 'src', 'note:projects/Heron.md',
    'src_kind', 'note', 'src_name', 'Heron', 'dst', 'person:ada-lovelace', 'dst_kind', 'person', 'dst_name', 'Ada Lovelace', 'source_line', 3,
    'confidence', conf, 'valid_from', '2026-03-05T00:00:00Z', 'edge_key', encode(sha256(convert_to('edge' || k, 'utf8')), 'hex'),
    'note_hash', encode(sha256(convert_to('note', 'utf8')), 'hex'), 'props', props, 'ends', '{"src": {"rel": "projects/Heron.md"}}'::jsonb)
$$;
grant execute on function pg_temp.edge(int, text, text, real, jsonb) to authenticated;
create function pg_temp.h(s text) returns text language sql as $$ select encode(sha256(convert_to(s, 'utf8')), 'hex') $$;
grant execute on function pg_temp.h(text) to authenticated;
create function pg_temp.graph_rows(note text) returns int language sql security definer as $$ select count(*)::int from public.links where from_note = note and kind is not null $$;
grant execute on function pg_temp.graph_rows(text) to authenticated;

-- 1. the author publishes edge sets on their knowledge base notes, one transaction per note
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
do $$ begin
  assert public.graph_put('01GR000000000000000000N001', pg_temp.h('set1'), jsonb_build_array(pg_temp.edge(1), pg_temp.edge(2))) = 2, 'two edges on the Handbook note';
  assert public.graph_put('01GR000000000000000000N002', pg_temp.h('set2'), jsonb_build_array(pg_temp.edge(3))) = 1, 'one edge on the Leadership note';
end $$;

-- 2. never on a note outside a knowledge base, never on someone else's note, never as someone else
select pg_temp.expect_error($$ select public.graph_put('01GR000000000000000000N003', pg_temp.h('x'), jsonb_build_array(pg_temp.edge(4))) $$, 'row-level security');
select pg_temp.expect_error($$ select public.graph_put('01GR000000000000000000N005', pg_temp.h('x'), jsonb_build_array(pg_temp.edge(4))) $$, 'row-level security');
select pg_temp.expect_error($$ select public.graph_put('01GR000000000000000000N004', pg_temp.h('x'), jsonb_build_array(pg_temp.edge(4))) $$, 'not yours');
select pg_temp.expect_error($$ select public.graph_put('01GR000000000000000000N001', pg_temp.h('x'), '{}'::jsonb) $$, 'must be a list');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3');
select pg_temp.expect_error($$ insert into public.links (id, user_id, workspace_id, from_note, anchor, kind, provenance, src, dst, edge_key, graph_hash)
  values ('01GR0000000000000000F00001', '00000000-0000-4000-8000-0000000000e3', '01GR00000000000000000000WA', '01GR000000000000000000N001', 'x', 'mentions', 'explicit', 'a', 'b', pg_temp.h('f'), pg_temp.h('f')) $$, 'row-level security');
select pg_temp.expect_error($$ insert into public.links (id, user_id, workspace_id, from_note, anchor, kind, provenance, src, dst, edge_key, graph_hash)
  values ('01GR0000000000000000F00002', '00000000-0000-4000-8000-0000000000e2', '01GR00000000000000000000WA', '01GR000000000000000000N001', 'x', 'mentions', 'explicit', 'a', 'b', pg_temp.h('f'), pg_temp.h('f')) $$, 'row-level security');

-- 3. a reader sees the edges of notes they can read and nothing else
do $$ begin
  assert (select array_agg(note_id order by note_id) from public.graph_heads('01GR00000000000000000000WA')) = array['01GR000000000000000000N001'], 'the reader sees the Handbook note only';
  assert (select edges from public.graph_heads('01GR00000000000000000000WA') where note_id = '01GR000000000000000000N001') = 2, 'with its two edges';
  assert (select graph_hash from public.graph_heads('01GR00000000000000000000WA')) = pg_temp.h('set1'), 'and the set hash';
  assert (select count(*) from public.links where from_note = '01GR000000000000000000N001') = 2, 'the rows read through the table too';
  assert (select count(*) from public.links where from_note = '01GR000000000000000000N002') = 0, 'not the Leadership rows';
end $$;

-- 4. a teammate cannot change or remove the author's rows (0001 let every member do both)
update public.links set dst_name = 'Forged' where from_note = '01GR000000000000000000N001';
delete from public.links where from_note = '01GR000000000000000000N001';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e4');
update public.links set dst_name = 'Forged' where from_note = '01GR000000000000000000N001';
delete from public.links where from_note = '01GR000000000000000000N001';
do $$ begin
  assert (select count(*) from public.graph_heads('01GR00000000000000000000WA')) = 1, 'a plain member reads the workspace Handbook too';
  assert pg_temp.graph_rows('01GR000000000000000000N001') = 2, 'both rows are still there';
  assert not exists (select 1 from public.links where dst_name = 'Forged'), 'and unchanged';
end $$;

-- 5. outside the workspace nothing comes back; the owner reads every knowledge base, Leadership included
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e5');
do $$ begin
  assert not exists (select 1 from public.graph_heads('01GR00000000000000000000WA')), 'an outsider sees no heads';
  assert not exists (select 1 from public.links where workspace_id = '01GR00000000000000000000WA'), 'and no rows';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
do $$ begin
  assert (select count(*) from public.graph_heads('01GR00000000000000000000WA')) = 2, 'the owner sees both notes';
end $$;

-- 6. a low-confidence model edge needs a person's approval
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select pg_temp.expect_error($$ select public.graph_put('01GR000000000000000000N001', pg_temp.h('m'), jsonb_build_array(pg_temp.edge(5, 'works_on', 'model', 0.5))) $$, 'links_model_reviewed');
do $$ begin
  assert pg_temp.graph_rows('01GR000000000000000000N001') = 2, 'a refused set leaves the old one in place';
  assert public.graph_put('01GR000000000000000000N001', pg_temp.h('m'), jsonb_build_array(pg_temp.edge(5, 'works_on', 'model', 0.5, '{"approved": true}'::jsonb))) = 1, 'an approved one goes';
  assert public.graph_put('01GR000000000000000000N001', pg_temp.h('m2'), jsonb_build_array(pg_temp.edge(6, 'works_on', 'model', 0.9), pg_temp.edge(7))) = 2, 'and a confident one';
end $$;
select pg_temp.expect_error($$ select public.graph_put('01GR000000000000000000N001', 'nothex', jsonb_build_array(pg_temp.edge(8))) $$, 'links_graph_shape');

-- 7. a new set replaces the old one; an empty set withdraws it
do $$ begin
  assert (select graph_hash from public.graph_heads('01GR00000000000000000000WA') where note_id = '01GR000000000000000000N001') = pg_temp.h('m2'), 'the head moves to the new set';
  assert public.graph_put('01GR000000000000000000N002', pg_temp.h('empty'), '[]'::jsonb) = 0, 'an empty set';
  assert pg_temp.graph_rows('01GR000000000000000000N002') = 0, 'clears the note';
end $$;

-- 8. plain links (no kind) keep working on the author's own notes, knowledge base or not
insert into public.links (id, user_id, workspace_id, from_note, anchor) values ('01GR0000000000000000P00001', '00000000-0000-4000-8000-0000000000e2', '01GR00000000000000000000WA', '01GR000000000000000000N003', 'Today');

-- 9. a note that leaves its knowledge base takes its graph rows along: made private by its author, deleted by its
-- author, or moved out of the KB by the workspace owner
update public.notes set frontmatter = '{}' where id = '01GR000000000000000000N001';
do $$ begin
  assert (select kb_id from public.notes where id = '01GR000000000000000000N001') is null, 'a private note leaves the KB';
  assert pg_temp.graph_rows('01GR000000000000000000N001') = 0, 'and its rows go';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3');
do $$ begin assert public.graph_put('01GR000000000000000000N004', pg_temp.h('k'), jsonb_build_array(pg_temp.edge(9))) = 1, 'the reader publishes their own note'; end $$;
update public.notes set deleted_at = now() where id = '01GR000000000000000000N004';
do $$ begin assert pg_temp.graph_rows('01GR000000000000000000N004') = 0, 'a deleted note takes its rows'; end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
do $$ begin assert public.graph_put('01GR000000000000000000N002', pg_temp.h('again'), jsonb_build_array(pg_temp.edge(10))) = 1, 'Leadership again'; end $$;
reset role;
select set_config('request.jwt.claims', '', true);
update public.notes set kb_id = null where id = '01GR000000000000000000N002';
do $$ begin assert pg_temp.graph_rows('01GR000000000000000000N002') = 0, 'moved out of the KB by someone else, the rows still go'; end $$;

-- 10. signed out, the functions are not there
set local role anon;
select pg_temp.expect_error($$ select public.graph_put('01GR000000000000000000N001', pg_temp.h('x'), '[]'::jsonb) $$, 'permission denied');
select pg_temp.expect_error($$ select * from public.graph_heads('01GR00000000000000000000WA') $$, 'permission denied');
reset role;

select 'graph links: ok';
rollback;
