-- Knowledge base search (migration 0027): kb_search and kb_folder_path, run as the people who would call them.
-- Needs a database with every migration applied (supabase start, or supabase db reset on a local stack). Everything
-- runs in one transaction that is rolled back, so it leaves the database as it found it:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/kb_search.sql
-- A failed check stops the script with the check's message; the last line printed on success is "kb search: ok".
begin;

-- fixtures, written without a session so the KB rights checks (notes_kb_check) do not apply. The sign-up gate (0009)
-- is replaced for this transaction only. a1 owns the workspace, a3 reads Leadership, a4 is a member, a5 is elsewhere
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000b1', 'owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000b3', 'reader@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000b4', 'member@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000b5', 'outsider@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name) values ('01KS00000000000000000000WA', '00000000-0000-4000-8000-0000000000b1', 'Example Team');
insert into public.workspaces (id, user_id, name) values ('01KS00000000000000000000WB', '00000000-0000-4000-8000-0000000000b5', 'Elsewhere');
insert into public.members (id, user_id, workspace_id, role) values
  ('01KS00000000000000000000M3', '00000000-0000-4000-8000-0000000000b3', '01KS00000000000000000000WA', 'member'),
  ('01KS00000000000000000000M4', '00000000-0000-4000-8000-0000000000b4', '01KS00000000000000000000WA', 'member');
insert into public.knowledge_bases (id, workspace_id, name) values
  ('01KS00000000000000000000KH', '01KS00000000000000000000WA', 'Handbook'),
  ('01KS00000000000000000000KR', '01KS00000000000000000000WA', 'Leadership');
insert into public.kb_access (kb_id, principal, role) values ('01KS00000000000000000000KH', 'workspace', 'reader');
insert into public.kb_access (kb_id, principal, user_id, role) values ('01KS00000000000000000000KR', 'user', '00000000-0000-4000-8000-0000000000b3', 'reader');
insert into public.kb_folders (id, kb_id, parent_id, name) values
  ('01KS00000000000000000000FP', '01KS00000000000000000000KH', null, 'Policies'),
  ('01KS00000000000000000000FT', '01KS00000000000000000000KH', '01KS00000000000000000000FP', 'Travel');
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id, folder_id, deleted_at) values
  ('01KS000000000000000000N001', '00000000-0000-4000-8000-0000000000b1', '01KS00000000000000000000WA', 'handbook/travel.md', '{"visibility": "public", "title": "Travel policy"}',
   '# Travel policy' || chr(10) || 'Book trains for short trips. The per diem covers meals, and reimbursement takes one week.', '01KS00000000000000000000KH', '01KS00000000000000000000FT', null),
  ('01KS000000000000000000N002', '00000000-0000-4000-8000-0000000000b1', '01KS00000000000000000000WA', 'leadership/board.md', '{"visibility": "public"}',
   '# Board plan' || chr(10) || 'Reimbursement limits rise next quarter.', '01KS00000000000000000000KR', null, null),
  ('01KS000000000000000000N003', '00000000-0000-4000-8000-0000000000b4', '01KS00000000000000000000WA', 'member/expenses.md', '{"visibility": "public"}',
   'My reimbursement notes, a personal note outside every KB.', null, null, null),
  ('01KS000000000000000000N004', '00000000-0000-4000-8000-0000000000b1', '01KS00000000000000000000WA', 'handbook/old-travel.md', '{"visibility": "public"}',
   'The old reimbursement rules.', '01KS00000000000000000000KH', null, now()),
  ('01KS000000000000000000N005', '00000000-0000-4000-8000-0000000000b5', '01KS00000000000000000000WB', 'elsewhere/expenses.md', '{"visibility": "public"}',
   'Reimbursement at another company.', null, null, null),
  ('01KS000000000000000000N007', '00000000-0000-4000-8000-0000000000b1', '01KS00000000000000000000WA', 'handbook/band.md', '{"visibility": "public", "title": "The Who"}',
   'Tour dates for the band.', '01KS00000000000000000000KH', null, null);
insert into public.knowledge_bases (id, workspace_id, name) values ('01KS00000000000000000000KE', '01KS00000000000000000000WB', 'Their handbook');
insert into public.kb_access (kb_id, principal, role) values ('01KS00000000000000000000KE', 'workspace', 'reader');
update public.notes set kb_id = '01KS00000000000000000000KE' where id = '01KS000000000000000000N005';

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);
$$;
-- the note ids a search returns, best first
create function pg_temp.found(ws text, q text, only_kb text default null, mode text default 'all') returns text language sql as $$
  select coalesce(string_agg(note_id::text, ',' order by rank desc, note_id), '') from public.kb_search(ws::public.ulid, q, only_kb::public.ulid, 8, mode);
$$;

-- 1. a member reads Handbook only: the Leadership note, the personal note and the deleted note stay out
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b4');
do $$
declare r record;
begin
  assert pg_temp.found('01KS00000000000000000000WA', 'reimbursement') = '01KS000000000000000000N001', 'a member finds only the Handbook note, got ' || pg_temp.found('01KS00000000000000000000WA', 'reimbursement');
  select * into r from public.kb_search('01KS00000000000000000000WA', 'per diem');
  assert r.kb_name = 'Handbook', 'the KB name comes back';
  assert r.folder_path = array['Policies', 'Travel'], 'the folder path runs from the top level down';
  assert r.title = 'Travel policy', 'the title comes from the frontmatter';
  assert r.snippet ilike '%per diem%', 'the snippet shows the match';
  assert r.kb_id = '01KS00000000000000000000KH' and r.folder_id = '01KS00000000000000000000FT', 'the ids come back';
  assert pg_temp.found('01KS00000000000000000000WA', 'reimbursement', '01KS00000000000000000000KR') = '', 'naming a KB the member cannot read finds nothing';
  assert (select string_agg(note_id::text, ',') from public.kb_search_match(array['01KS00000000000000000000KH', '01KS00000000000000000000KR'], to_tsquery('english', 'reimbursement'), false, 50)) = '01KS000000000000000000N001', 'handed both KB ids, the match helper keeps the readable one';
end $$;

-- 2. a reader of Leadership finds both KB notes; one KB narrows it; a title without frontmatter comes from the path
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b3');
do $$ begin
  assert pg_temp.found('01KS00000000000000000000WA', 'reimbursement') in ('01KS000000000000000000N001,01KS000000000000000000N002', '01KS000000000000000000N002,01KS000000000000000000N001'), 'a Leadership reader finds both';
  assert pg_temp.found('01KS00000000000000000000WA', 'reimbursement', '01KS00000000000000000000KR') = '01KS000000000000000000N002', 'only_kb narrows the search';
  assert (select title from public.kb_search('01KS00000000000000000000WA', 'board', '01KS00000000000000000000KR')) = 'board', 'the title falls back to the file name';
  assert (select folder_path from public.kb_search('01KS00000000000000000000WA', 'board')) = '{}'::text[], 'a note at the top of its KB has no folder path';
end $$;

-- 3. modes: all needs every word, any takes one; an empty query finds nothing
do $$ begin
  assert pg_temp.found('01KS00000000000000000000WA', 'reimbursement unicorn') = '', 'all needs every word';
  assert pg_temp.found('01KS00000000000000000000WA', 'reimbursement unicorn', null, 'any') <> '', 'any takes one of the words';
  assert pg_temp.found('01KS00000000000000000000WA', 'what is the travel policy?', null, 'any') like '01KS000000000000000000N001%', 'a chat question ranks the travel note first';
  assert pg_temp.found('01KS00000000000000000000WA', '') = '', 'an empty query finds nothing';
  assert pg_temp.found('01KS00000000000000000000WA', 'of', null, 'any') = '', 'a word too short for the simple fallback finds nothing';
  assert pg_temp.found('01KS00000000000000000000WA', 'reimbursement -board') = '01KS000000000000000000N001', 'a minus leaves a word out';
end $$;

-- 4. someone outside the workspace gets nothing from it, by workspace or by KB, and no folder names
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b5');
do $$ begin
  assert pg_temp.found('01KS00000000000000000000WA', 'reimbursement') = '', 'an outsider finds nothing';
  assert pg_temp.found('01KS00000000000000000000WA', 'reimbursement', '01KS00000000000000000000KH') = '', 'an outsider finds nothing in a named KB';
  assert public.kb_folder_path('01KS00000000000000000000FT') = '{}'::text[], 'an outsider reads no folder names';
  assert pg_temp.found('01KS00000000000000000000WB', 'reimbursement') = '01KS000000000000000000N005', 'their own workspace still answers';
  assert not exists (select 1 from public.kb_search_match(array['01KS00000000000000000000KH', '01KS00000000000000000000KR'], to_tsquery('english', 'reimbursement'), false, 50)), 'the match helper checks every KB id it is handed';
  assert not exists (select 1 from public.kb_note_search where workspace_id = '01KS00000000000000000000WA'), 'and the search rows stay hidden';
end $$;

-- 5. a workspace owner reads every KB in it, and nothing from another workspace
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
do $$ begin
  assert (select count(*) from public.kb_search('01KS00000000000000000000WA', 'reimbursement')) = 2, 'the owner finds both KB notes';
  assert pg_temp.found('01KS00000000000000000000WB', 'reimbursement') = '', 'the owner finds nothing in another workspace';
  assert (select count(*) from public.kb_search('01KS00000000000000000000WA', 'reimbursement', null, 1)) = 1, 'max_results caps the answer';
end $$;

-- 6. the any query: stop words out, at most the eight longest terms, longest first
do $$ declare q text := public.kb_any_query('english', 'what is the policy on reimbursement for a conference abroad with partners and spouses travelling internationally overnight')::text;
begin
  assert q !~ '''the''|''is''|''what''', 'stop words are dropped: ' || q;
  assert array_length(string_to_array(q, ' | '), 1) = 8, 'eight terms are kept: ' || q;
  assert q like '''overnight''%', 'the longest term comes first: ' || q;
  assert public.kb_any_query('english', 'the and of') is null, 'stop words alone make no query';
  assert public.kb_any_query('simple', 'the and of')::text = '''and'' | ''the''', 'the simple query keeps words of three letters or more';
end $$;

-- 7. the simple configuration answers when english has nothing to search for
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b4');
do $$ begin
  assert pg_temp.found('01KS00000000000000000000WA', 'the who') = '01KS000000000000000000N007', 'stop words in english still match through simple, got ' || pg_temp.found('01KS00000000000000000000WA', 'the who');
  assert pg_temp.found('01KS00000000000000000000WA', 'the who', null, 'any') like '01KS000000000000000000N007%', 'in any mode too, ranked first';
end $$;

-- 8. the limit applies after the readable KBs: the Leadership note ranks first for this query, the member still gets one result
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
do $$ begin
  assert (select string_agg(note_id::text, ',' order by rank desc) from public.kb_search('01KS00000000000000000000WA', 'reimbursement limits', null, 1, 'any')) = '01KS000000000000000000N002', 'the owner''s top result is the Leadership note';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b4');
do $$ begin
  assert pg_temp.found('01KS00000000000000000000WA', 'reimbursement limits', null, 'any') = '01KS000000000000000000N001', 'the member gets the Handbook note';
  assert (select count(*) from public.kb_search('01KS00000000000000000000WA', 'reimbursement limits', null, 1, 'any')) = 1, 'and one result with a limit of one';
end $$;

-- 9. the search rows follow the notes: an edit is searchable, a note taken out of its KB or deleted is gone, and the
-- rows read under the KB's rights
reset role;
select set_config('request.jwt.claims', '', true);
update public.notes set body = body || ' Quokka sightings are expensed.' where id = '01KS000000000000000000N001';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b4');
do $$ begin
  assert pg_temp.found('01KS00000000000000000000WA', 'quokka') = '01KS000000000000000000N001', 'an edited body is searchable';
  assert (select count(*) from public.kb_note_search) = 2, 'a member reads the search rows of Handbook only';
  assert not exists (select 1 from public.kb_note_search where kb_id = '01KS00000000000000000000KR'), 'and none of Leadership';
end $$;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b5');
do $$ begin
  assert not exists (select 1 from public.kb_note_search where workspace_id = '01KS00000000000000000000WA'), 'an outsider reads no search rows';
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
update public.notes set kb_id = null where id = '01KS000000000000000000N007';
update public.notes set deleted_at = now() where id = '01KS000000000000000000N001';
do $$ begin
  assert not exists (select 1 from public.kb_note_search where note_id in ('01KS000000000000000000N001', '01KS000000000000000000N007')), 'notes out of a KB or deleted leave the index';
  assert exists (select 1 from public.kb_note_search where note_id = '01KS000000000000000000N002'), 'the others stay';
end $$;

-- 10. signed out: no execute right
reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
do $$ begin
  begin
    perform public.kb_search('01KS00000000000000000000WA', 'reimbursement');
    raise exception 'anon ran kb_search';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
select 'kb search: ok';
rollback;
