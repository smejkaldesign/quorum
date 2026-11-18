-- Personal knowledge bases (migration 0041): any member makes one, only its owner reads and manages it (workspace
-- owners and admins included), it fills from a synced GitHub repository like a workspace KB, its notes stay out of the
-- review queue, and it goes when its owner leaves or deletes it. Needs a database with every migration applied and
-- the private object check (private_object.sql) loaded first. Runs in one transaction that is rolled back:
--   { echo 'begin;'; cat supabase/tests/private_object.sql; grep -v '^begin;$' supabase/tests/personal_kbs.sql; } | docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- On a stack that has migrations up to 0040 only, put the migration inside the same transaction too:
--   { echo 'begin;'; cat supabase/migrations/0041_personal_knowledge_bases.sql supabase/tests/private_object.sql; grep -v '^begin;$' supabase/tests/personal_kbs.sql; } | docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- A failed check stops the script with the check's message; the last line printed on success is "personal kbs: ok".
begin;

-- fixtures. p1 owns the workspace; p2 is a workspace admin; p3 and p4 are members; p5 is outside
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000a1', 'pk-owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a2', 'pk-admin@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a3', 'pk-member@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a4', 'pk-other@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a5', 'pk-outsider@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000a6', 'pk-third@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name, team_enabled, plan) values ('01KF0000000000000000000PWS', '00000000-0000-4000-8000-0000000000a1', 'Personal KB Team', true, 'paid');
insert into public.members (id, user_id, workspace_id, role) values
  ('01KF0000000000000000000PM2', '00000000-0000-4000-8000-0000000000a2', '01KF0000000000000000000PWS', 'admin'),
  ('01KF0000000000000000000PM3', '00000000-0000-4000-8000-0000000000a3', '01KF0000000000000000000PWS', 'member'),
  ('01KF0000000000000000000PM4', '00000000-0000-4000-8000-0000000000a4', '01KF0000000000000000000PWS', 'member'),
  ('01KF0000000000000000000PM6', '00000000-0000-4000-8000-0000000000a6', '01KF0000000000000000000PWS', 'member');

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);
$$;
create function pg_temp.as_service() returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true), set_config('role', 'service_role', true);
$$;
create function pg_temp.as_admin_role() returns void language sql as $$ select set_config('request.jwt.claims', '', true), set_config('role', 'postgres', true); $$;
create function pg_temp.expect_error(stmt text, pattern text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then
    if sqlerrm !~* pattern then raise exception 'expected an error like "%" from %, got "%"', pattern, stmt, sqlerrm; end if;
    return;
  end;
  raise exception 'expected an error like "%" from %, it ran', pattern, stmt;
end $$;
create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'check failed: %', what; end if; end $$;
create temp table ids (k text primary key, v text);
grant all on ids to authenticated, service_role;
create function pg_temp.id(name text) returns text language sql as $$ select v from ids where k = name $$;

-- 1. a member makes a personal KB: they are its only admin, with no workspace row
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
insert into ids select 'mine', public.kb_create('01KF0000000000000000000PWS', 'QA', personal => true)::text;
insert into ids select 'kb3', pg_temp.id('mine')::jsonb ->> 'id';
select pg_temp.check((pg_temp.id('mine')::jsonb ->> 'personal')::boolean, 'the KB says it is personal');
select pg_temp.check(pg_temp.id('mine')::jsonb ->> 'role' = 'admin', 'its maker is its admin');
select pg_temp.check(jsonb_array_length(pg_temp.id('mine')::jsonb -> 'access') = 1
  and (pg_temp.id('mine')::jsonb -> 'access' -> 0) @> '{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a3", "role": "admin"}', 'the access list is the maker alone');
select pg_temp.expect_error($$select public.kb_create('01KF0000000000000000000PWS', 'Team wiki')$$, 'only owners and admins');
select pg_temp.expect_error($$select public.kb_create('01KF0000000000000000000PWS', 'qa', personal => true)$$, 'already exists');
select pg_temp.expect_error($$select public.kb_create('01KF0000000000000000000PWS', 'Calls', 'meetings', personal => true)$$, 'general');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a5');
select pg_temp.expect_error($$select public.kb_create('01KF0000000000000000000PWS', 'Mine', personal => true)$$, 'not a member');

-- 2. names are per person: another member and the workspace can both use the same name
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
insert into ids select 'kb4', public.kb_create('01KF0000000000000000000PWS', 'QA', personal => true) ->> 'id';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
insert into ids select 'team', public.kb_create('01KF0000000000000000000PWS', 'QA') ->> 'id';
select pg_temp.check(not (public.kb_shape(pg_temp.id('team')::text) ->> 'personal')::boolean, 'a workspace KB is not personal');

-- 2b. three members sync the same repository file into personal KBs of the same name: each keeps the same path, a
-- person's own notes still never share a path, and a workspace note may use it too
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a6');
insert into ids select 'kb6', public.kb_create('01KF0000000000000000000PWS', 'QA', personal => true) ->> 'id';
select pg_temp.as_admin_role();
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id) values
  ('01KF000000000000000000PR03', '00000000-0000-4000-8000-0000000000a3', '01KF0000000000000000000PWS', 'Knowledge bases/QA/Guide.md', '{"visibility": "public", "kb_source": "github:octo/shared-app:Guide.md"}', '# Guide', 'r3', pg_temp.id('kb3')),
  ('01KF000000000000000000PR04', '00000000-0000-4000-8000-0000000000a4', '01KF0000000000000000000PWS', 'Knowledge bases/QA/Guide.md', '{"visibility": "public", "kb_source": "github:octo/shared-app:Guide.md"}', '# Guide', 'r4', pg_temp.id('kb4')),
  ('01KF000000000000000000PR06', '00000000-0000-4000-8000-0000000000a6', '01KF0000000000000000000PWS', 'Knowledge bases/QA/Guide.md', '{"visibility": "public", "kb_source": "github:octo/shared-app:Guide.md"}', '# Guide', 'r6', pg_temp.id('kb6'));
select pg_temp.check((select count(*) from public.notes where path = 'Knowledge bases/QA/Guide.md' and personal_kb) = 3, 'three personal KBs hold the same path');
select pg_temp.expect_error($$insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash) values ('01KF000000000000000000PR13', '00000000-0000-4000-8000-0000000000a3', '01KF0000000000000000000PWS', 'Knowledge bases/QA/Guide.md', '{}', 'x', 'x')$$, 'duplicate key');
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id)
  values ('01KF000000000000000000PR01', '00000000-0000-4000-8000-0000000000a1', '01KF0000000000000000000PWS', 'Knowledge bases/QA/Guide.md', '{"visibility": "public"}', '# Team guide', 'r1', pg_temp.id('team'));
select pg_temp.check((select not personal_kb from public.notes where id = '01KF000000000000000000PR01'), 'a workspace KB note may use the path too');
select pg_temp.expect_error($$insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash) values ('01KF000000000000000000PR12', '00000000-0000-4000-8000-0000000000a2', '01KF0000000000000000000PWS', 'Knowledge bases/QA/Guide.md', '{}', 'x', 'x')$$, 'duplicate key');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');

-- 3. nobody else reads it: not the workspace owner, not a workspace admin, not another member
select pg_temp.check(not exists (select 1 from jsonb_array_elements(public.kb_list('01KF0000000000000000000PWS')) e where (e ->> 'personal')::boolean), 'the owner lists no personal KB');
select pg_temp.check((select count(*) from public.knowledge_bases where personal_user_id is not null) = 0, 'the owner selects no personal KB');
select pg_temp.check(public.kb_shape(pg_temp.id('kb3')) is null, 'the owner gets no shape for it');
select pg_temp.check(not public.can_read_kb(pg_temp.id('kb3')) and not public.can_admin_kb(pg_temp.id('kb3')), 'the owner neither reads nor admins it');
select pg_temp.check(public.can_read_kb(pg_temp.id('team')), 'the owner still reads the workspace KB');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select pg_temp.check(not exists (select 1 from jsonb_array_elements(public.kb_list('01KF0000000000000000000PWS')) e where (e ->> 'personal')::boolean), 'a workspace admin lists no personal KB');
select pg_temp.check(not public.can_read_kb(pg_temp.id('kb3')), 'a workspace admin does not read it');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
select pg_temp.check((select count(*) from public.knowledge_bases where personal_user_id is not null) = 1, 'a member sees their own personal KB only');
select pg_temp.check(not public.can_read_kb(pg_temp.id('kb3')), 'another member does not read it');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
select pg_temp.check((select count(*) from jsonb_array_elements(public.kb_list('01KF0000000000000000000PWS')) e where e ->> 'id' = pg_temp.id('kb3')) = 1, 'its owner lists it');
select pg_temp.check(public.can_read_kb(pg_temp.id('team')), 'its owner reads the workspace KB as before');

-- 4. it cannot be shared, and only its owner renames or deletes it
select pg_temp.expect_error(format($$select public.kb_set_access(%L, '[{"principal": "workspace", "role": "reader"}]')$$, pg_temp.id('kb3')), 'only for the person who made it');
select pg_temp.expect_error(format($$select public.kb_set_access(%L, '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a4", "role": "reader"}]')$$, pg_temp.id('kb3')), 'only for the person who made it');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
insert into ids select 'tm', public.team_create('01KF0000000000000000000PWS', 'QA team') ->> 'id';
select public.team_member_set(pg_temp.id('tm'), '00000000-0000-4000-8000-0000000000a3');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
select pg_temp.expect_error(format($$select public.kb_set_access(%L, jsonb_build_array(jsonb_build_object('principal', 'team', 'team_id', %L, 'role', 'reader')))$$, pg_temp.id('kb3'), pg_temp.id('tm')), 'only for the person who made it');
select pg_temp.check(not exists (select 1 from public.kb_access where kb_id = pg_temp.id('kb3') and principal <> 'user'), 'no team row joins it');
select pg_temp.check(public.kb_rename(pg_temp.id('kb3'), 'QA notes') ->> 'name' = 'QA notes', 'its owner renames it');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect_error(format($$select public.kb_set_access(%L, '[{"principal": "workspace", "role": "reader"}]')$$, pg_temp.id('kb3')), 'no longer exists');
select pg_temp.expect_error(format($$select public.kb_rename(%L, 'Mine now')$$, pg_temp.id('kb3')), 'no longer exists');
select pg_temp.expect_error(format($$select public.kb_delete(%L)$$, pg_temp.id('kb3')), 'no longer exists');
select pg_temp.expect_error(format($$select public.kb_folder_create(%L, null, 'Peek')$$, pg_temp.id('kb3')), 'no longer exists');
select pg_temp.expect_error($$select public.kb_create('01KF0000000000000000000PWS', 'qa')$$, 'already exists');

-- 5. its notes: only the owner reads them, and none reaches the review queue
select pg_temp.as_admin_role();
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash)
  values ('01KF000000000000000000PN01', '00000000-0000-4000-8000-0000000000a3', '01KF0000000000000000000PWS', 'Ideas/Flaky tests.md', '{"visibility": "public"}', '# Flaky', 'h1');
select pg_temp.check((select status from public.contributions where note_id = '01KF000000000000000000PN01') = 'pending', 'a shared note starts pending in the queue');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select pg_temp.check((select count(*) from public.notes where id = '01KF000000000000000000PN01') = 1, 'a workspace admin can open a pending note');
insert into ids select 'kb2', public.kb_create('01KF0000000000000000000PWS', 'Admin box', personal => true) ->> 'id';
select pg_temp.expect_error(format($$select public.kb_note_assign('01KF000000000000000000PN01', %L)$$, pg_temp.id('kb2')), 'only your own notes');
select pg_temp.check((select kb_id is null from public.notes where id = '01KF000000000000000000PN01'), 'a workspace admin cannot take a member''s note into their own personal KB');
select pg_temp.check((select status from public.contributions where note_id = '01KF000000000000000000PN01') = 'pending', 'and the author''s contribution stays');
select pg_temp.as_admin_role();
select pg_temp.expect_error(format($$update public.notes set kb_id = %L where id = '01KF000000000000000000PN01'$$, pg_temp.id('kb2')), 'only your own notes');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
select public.kb_note_assign('01KF000000000000000000PN01', pg_temp.id('kb3'));
select pg_temp.check(not exists (select 1 from public.contributions where note_id = '01KF000000000000000000PN01'), 'joining the personal KB takes it out of the queue');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select pg_temp.check((select count(*) from public.notes where id = '01KF000000000000000000PN01') = 0, 'a workspace admin no longer reads it');
select pg_temp.check((select count(*) from public.contributions where note_id = '01KF000000000000000000PN01') = 0, 'nor sees a contribution for it');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.check((select count(*) from public.notes where id = '01KF000000000000000000PN01') = 0, 'the workspace owner does not read it');
select pg_temp.as_admin_role();
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash)
  values ('01KF000000000000000000PN09', '00000000-0000-4000-8000-0000000000a1', '01KF0000000000000000000PWS', 'Owner/Plan.md', '{"visibility": "public"}', '# Plan', 'h9');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect_error(format($$select public.kb_note_assign('01KF000000000000000000PN09', %L)$$, pg_temp.id('kb3')), 'no longer exists');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
select pg_temp.check((select count(*) from public.notes where id = '01KF000000000000000000PN01') = 1, 'its owner reads it');
-- moved out to a workspace KB it admins and back: it is queued again when it leaves, and leaves the queue when it returns
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select public.kb_set_access(pg_temp.id('team'), '[{"principal": "workspace", "role": "reader"}, {"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000a3", "role": "admin"}]');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
select public.kb_note_assign('01KF000000000000000000PN01', pg_temp.id('team'));
select pg_temp.check((select status = 'included' and source = 'kb' from public.contributions where note_id = '01KF000000000000000000PN01'), 'moved to a workspace KB it is included as a KB note');
select public.kb_note_assign('01KF000000000000000000PN01', null);
select pg_temp.check((select status from public.contributions where note_id = '01KF000000000000000000PN01') = 'pending', 'taken out of every KB it waits for review');
select public.kb_note_assign('01KF000000000000000000PN01', pg_temp.id('kb3'));
select pg_temp.check(not exists (select 1 from public.contributions where note_id = '01KF000000000000000000PN01'), 'back in the personal KB it is out of the queue');

-- 6. GitHub sync: each member attaches the same shared repository into their own KB; nobody attaches into another's
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select public.workspace_integration_save('01KF0000000000000000000PWS', 'github', 'personal', '{}', null);
select pg_temp.as_service();
insert into ids select 'att3', public.kb_sync_attach('00000000-0000-4000-8000-0000000000a3', pg_temp.id('kb3'), null, 'github', 'octo/shared-app', 'folder', '{}', 'octo/shared-app', 'https://github.com/octo/shared-app', 'gh-rt-p3', 'quorum', false) ->> 'id';
insert into ids select 'att4', public.kb_sync_attach('00000000-0000-4000-8000-0000000000a4', pg_temp.id('kb4'), null, 'github', 'octo/shared-app', 'folder', '{}', 'octo/shared-app', 'https://github.com/octo/shared-app', 'gh-rt-p4', 'quorum', false) ->> 'id';
select pg_temp.check(pg_temp.id('att3') is not null and pg_temp.id('att4') is not null and pg_temp.id('att3') <> pg_temp.id('att4'), 'two personal KBs sync one repository');
select pg_temp.expect_error(format($$select public.kb_sync_attach('00000000-0000-4000-8000-0000000000a4', %L, null, 'github', 'octo/other', 'folder', '{}', 'x', null, 'gh-rt-x')$$, pg_temp.id('kb3')), 'no longer exists');
select pg_temp.expect_error(format($$select public.kb_sync_attach('00000000-0000-4000-8000-0000000000a1', %L, null, 'github', 'octo/other', 'folder', '{}', 'x', null, 'gh-rt-x')$$, pg_temp.id('kb3')), 'no longer exists');
select pg_temp.as_admin_role();
update public.kb_attachments set next_run_at = now() - interval '1 minute' where id in (pg_temp.id('att3'), pg_temp.id('att4'));
select pg_temp.as_service();
insert into ids select 'claim', public.kb_sync_claim(10, 600, 5, 'w1')::text;
select pg_temp.check((select count(*) from jsonb_array_elements(pg_temp.id('claim')::jsonb) e where e ->> 'id' in (pg_temp.id('att3'), pg_temp.id('att4'))) = 2, 'the worker claims both');
-- the worker's note in p3's KB, as kb_sync_notes_write writes it
select pg_temp.as_admin_role();
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id)
  values ('01KF000000000000000000PN02', '00000000-0000-4000-8000-0000000000a3', '01KF0000000000000000000PWS', 'Knowledge bases/QA notes/README.md',
    jsonb_build_object('visibility', 'public', 'kb_source', 'github:octo/shared-app:README.md', 'kb_attachment', pg_temp.id('att3')), '# Shared app', 'h2', pg_temp.id('kb3'));
select pg_temp.check(not exists (select 1 from public.contributions where note_id = '01KF000000000000000000PN02'), 'a synced note opens no contribution');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.check((select count(*) from public.kb_attachments where kb_id = pg_temp.id('kb3')) = 0, 'the workspace owner sees no attachment of it');
select pg_temp.expect_error(format($$select public.kb_attachments_list(%L)$$, pg_temp.id('kb3')), 'no longer exists');
select pg_temp.check((select count(*) from public.notes where id = '01KF000000000000000000PN02') = 0, 'nor its synced note');
select pg_temp.check((select count(*) from public.kb_note_search where kb_id = pg_temp.id('kb3')) = 0, 'nor its search rows');
select pg_temp.check(not exists (select 1 from public.kb_search('01KF0000000000000000000PWS', 'Shared app') where kb_id = pg_temp.id('kb3')), 'the workspace owner''s search does not return it');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select pg_temp.check(not exists (select 1 from public.kb_search('01KF0000000000000000000PWS', 'Shared app') where kb_id = pg_temp.id('kb3')), 'a workspace admin''s search does not return it');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
select pg_temp.check(exists (select 1 from public.kb_search('01KF0000000000000000000PWS', 'Shared app') where kb_id = pg_temp.id('kb3')), 'its owner''s search returns it');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
select pg_temp.check((select count(*) from public.notes where id = '01KF000000000000000000PN02') = 0, 'another member reads none of it');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
select pg_temp.check(jsonb_array_length(public.kb_attachments_list(pg_temp.id('kb3'))) = 1, 'its owner lists the attachment');

-- 6c. the private object check (private_object.sql): the workspace owner and a workspace admin cannot read, list,
-- search, edit or infer p3's personal KB, its synced folder or its notes
select pg_temp.as_admin_role();
select pg_temp.assert_private(array['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2']::uuid[], jsonb_build_array(
  jsonb_build_object('what', 'read the KB row', 'sql', format('select 1 from public.knowledge_bases where id = %L', pg_temp.id('kb3'))),
  jsonb_build_object('what', 'list the KB', 'sql', format('select 1 from jsonb_array_elements(public.kb_list(%L)) e where e ->> ''id'' = %L', '01KF0000000000000000000PWS', pg_temp.id('kb3'))),
  jsonb_build_object('what', 'read its shape', 'sql', format('select 1 where public.kb_shape(%L) is not null', pg_temp.id('kb3'))),
  jsonb_build_object('what', 'read its folders', 'sql', format('select 1 from public.kb_folders where kb_id = %L', pg_temp.id('kb3'))),
  jsonb_build_object('what', 'read its access list', 'sql', format('select 1 from public.kb_access where kb_id = %L', pg_temp.id('kb3'))),
  jsonb_build_object('what', 'read its notes', 'sql', format('select 1 from public.notes where kb_id = %L or id = %L', pg_temp.id('kb3'), '01KF000000000000000000PN02')),
  jsonb_build_object('what', 'read its search rows', 'sql', format('select 1 from public.kb_note_search where kb_id = %L', pg_temp.id('kb3'))),
  jsonb_build_object('what', 'search it', 'sql', format('select 1 from public.kb_search(%L, ''Shared app'') where kb_id = %L', '01KF0000000000000000000PWS', pg_temp.id('kb3'))),
  jsonb_build_object('what', 'read its synced folder', 'sql', format('select 1 from public.kb_attachments where kb_id = %L', pg_temp.id('kb3'))),
  jsonb_build_object('what', 'read its kept suggestions', 'sql', format('select 1 from public.kb_note_upstream where note_id = %L', '01KF000000000000000000PN02')),
  jsonb_build_object('what', 'see its notes in the review queue', 'sql', format('select 1 from public.contributions where note_id = %L', '01KF000000000000000000PN02')),
  jsonb_build_object('what', 'edit its note through the table', 'sql', format('update public.notes set body = ''x'' where id = %L', '01KF000000000000000000PN02')),
  jsonb_build_object('what', 'rename the KB through the table', 'sql', format('update public.knowledge_bases set name = ''x'' where id = %L', pg_temp.id('kb3'))),
  jsonb_build_object('what', 'rename the KB', 'sql', format('select public.kb_rename(%L, ''Mine'')', pg_temp.id('kb3')), 'expect', 'error', 'pattern', 'no longer exists'),
  jsonb_build_object('what', 'share the KB', 'sql', format('select public.kb_set_access(%L, ''[{"principal": "workspace", "role": "reader"}]'')', pg_temp.id('kb3')), 'expect', 'error', 'pattern', 'no longer exists'),
  jsonb_build_object('what', 'add a folder', 'sql', format('select public.kb_folder_create(%L, null, ''Peek'')', pg_temp.id('kb3')), 'expect', 'error', 'pattern', 'no longer exists'),
  jsonb_build_object('what', 'list its synced folders', 'sql', format('select public.kb_attachments_list(%L)', pg_temp.id('kb3')), 'expect', 'error', 'pattern', 'no longer exists'),
  jsonb_build_object('what', 'delete the KB', 'sql', format('select public.kb_delete(%L)', pg_temp.id('kb3')), 'expect', 'error', 'pattern', 'no longer exists'),
  jsonb_build_object('what', 'make a workspace KB with its name', 'sql', format('select public.kb_create(%L, ''QA notes'')', '01KF0000000000000000000PWS'), 'expect', 'ok'),
  jsonb_build_object('what', 'make a personal KB with its name', 'sql', format('select public.kb_create(%L, ''QA notes'', personal => true)', '01KF0000000000000000000PWS'), 'expect', 'ok')));
select pg_temp.check(not exists (select 1 from public.knowledge_bases where name = 'QA notes' and id <> pg_temp.id('kb3')), 'the probes changed nothing');
select pg_temp.check((select body from public.notes where id = '01KF000000000000000000PN02') = '# Shared app', 'the probes left the note as it was');

-- 6b. the workspace's policy for members' personal KBs: only owners and admins set it; a source it drops pauses
-- members' synced folders of that source, which cannot be resumed or attached again; an admin's own personal KB is exempt
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
select pg_temp.check(public.workspace_personal_kbs('01KF0000000000000000000PWS') = '{"enabled": true, "sources": ["github", "google-drive"], "exempt": false}'::jsonb, 'personal KBs start on with both sources');
select pg_temp.expect_error($$select public.workspace_personal_kbs_set('01KF0000000000000000000PWS', false, '{}')$$, 'only owners and admins');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a5');
select pg_temp.check(public.workspace_personal_kbs('01KF0000000000000000000PWS') is null, 'an outsider reads no policy');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect_error($$select public.workspace_personal_kbs_set('01KF0000000000000000000PWS', true, '{dropbox}')$$, 'GitHub or Google Drive');
select pg_temp.check(public.workspace_personal_kbs_set('01KF0000000000000000000PWS', true, '{google-drive}') -> 'sources' = '["google-drive"]'::jsonb, 'an owner limits the sources');
select pg_temp.as_admin_role();
select pg_temp.check((select status = 'paused' and paused_by = 'policy' and error ~ 'GitHub' from public.kb_attachments where id = pg_temp.id('att4')), 'a member''s GitHub sync is paused for the policy');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
select pg_temp.check(public.can_read_kb(pg_temp.id('kb4')), 'the member still reads their KB');
select pg_temp.expect_error(format($$select public.kb_attachment_pause(%L, false)$$, pg_temp.id('att4')), 'does not allow GitHub');
select pg_temp.as_service();
select pg_temp.expect_error(format($$select public.kb_sync_attach('00000000-0000-4000-8000-0000000000a4', %L, null, 'github', 'octo/more', 'folder', '{}', 'x', null, 'gh-rt-y')$$, pg_temp.id('kb4')), 'does not allow GitHub');
insert into ids select 'att2', public.kb_sync_attach('00000000-0000-4000-8000-0000000000a2', pg_temp.id('kb2'), null, 'github', 'octo/shared-app', 'folder', '{}', 'octo/shared-app', null, 'gh-rt-p2', 'quorum', false) ->> 'id';
select pg_temp.check(pg_temp.id('att2') is not null, 'a workspace admin syncs GitHub into their own personal KB');
select pg_temp.as_admin_role();
select pg_temp.expect_error(format($$insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id) values ('01KF000000000000000000PN10', '00000000-0000-4000-8000-0000000000a4', '01KF0000000000000000000PWS', 'Knowledge bases/QA/i.md', '{"visibility": "public", "kb_source": "https://github.com/octo/x/blob/main/i.md"}', '# i', 'h10', %L)$$, pg_temp.id('kb4')), 'does not allow GitHub');
-- an existing note cannot take in a refused source either: a re-import of its text, or a new source, is refused;
-- a change that leaves the source and the text alone goes through
select pg_temp.expect_error($$update public.notes set body = '# Guide v2' where id = '01KF000000000000000000PR04'$$, 'does not allow GitHub');
select pg_temp.expect_error($$update public.notes set frontmatter = frontmatter || '{"kb_source": "https://github.com/octo/x/blob/main/Guide.md"}' where id = '01KF000000000000000000PR04'$$, 'does not allow GitHub');
update public.notes set frontmatter = frontmatter || '{"kb_checked_at": "2026-11-17T00:00:00Z"}' where id = '01KF000000000000000000PR04';
select pg_temp.check((select frontmatter ->> 'kb_checked_at' is not null and body = '# Guide' from public.notes where id = '01KF000000000000000000PR04'), 'a change that keeps its source and text goes through');
-- a plan that ends and comes back leaves the policy pause in place
update public.workspaces set plan = 'free' where id = '01KF0000000000000000000PWS';
update public.workspaces set plan = 'paid' where id = '01KF0000000000000000000PWS';
select pg_temp.check((select status = 'paused' and paused_by = 'policy' from public.kb_attachments where id = pg_temp.id('att4')), 'the plan coming back does not lift the policy pause');
select pg_temp.check((select status <> 'paused' from public.kb_attachments where id = pg_temp.id('att2')), 'the admin''s sync resumes with the plan');
-- members off: no new personal KB for a member, an admin still makes one, and nothing is deleted
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select public.workspace_personal_kbs_set('01KF0000000000000000000PWS', false, '{github,google-drive}');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
select pg_temp.expect_error($$select public.kb_create('01KF0000000000000000000PWS', 'More', personal => true)$$, 'does not allow members');
select pg_temp.check(public.can_read_kb(pg_temp.id('kb4')), 'the member still reads their KB while it is off');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select pg_temp.check((public.kb_create('01KF0000000000000000000PWS', 'Admin two', personal => true) ->> 'personal')::boolean, 'a workspace admin still makes one');
select pg_temp.check(public.workspace_personal_kbs('01KF0000000000000000000PWS') ->> 'exempt' = 'true', 'an admin reads that they are exempt');
select pg_temp.as_admin_role();
select pg_temp.check((select status = 'paused' and paused_by = 'policy' from public.kb_attachments where id = pg_temp.id('att3')), 'every member''s sync is paused');
select pg_temp.check((select status <> 'paused' from public.kb_attachments where id = pg_temp.id('att2')), 'the admin''s sync keeps running');
-- a demoted admin is a member: their sync pauses for the policy at once, and resumes when they are an admin again
update public.members set role = 'member' where id = '01KF0000000000000000000PM2';
select pg_temp.check((select status = 'paused' and paused_by = 'policy' from public.kb_attachments where id = pg_temp.id('att2')), 'a demoted admin''s sync pauses');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select pg_temp.expect_error(format($$select public.kb_attachment_pause(%L, false)$$, pg_temp.id('att2')), 'does not allow members');
select pg_temp.as_admin_role();
update public.members set role = 'admin' where id = '01KF0000000000000000000PM2';
select pg_temp.check((select status = 'pending' and paused_by is null from public.kb_attachments where id = pg_temp.id('att2')), 'promoted again, the sync resumes');
select pg_temp.check((select status = 'paused' and paused_by = 'policy' from public.kb_attachments where id = pg_temp.id('att3')), 'a member''s sync stays paused through another person''s role change');
select pg_temp.check(exists (select 1 from public.knowledge_bases where id = pg_temp.id('kb4')) and exists (select 1 from public.kb_attachments where id = pg_temp.id('att4')), 'nothing is deleted');
-- back on with both sources: the policy pauses lift
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a1');
select public.workspace_personal_kbs_set('01KF0000000000000000000PWS', true, '{github,google-drive}');
select pg_temp.as_admin_role();
select pg_temp.check((select status = 'pending' and paused_by is null and error is null from public.kb_attachments where id = pg_temp.id('att4')), 'a member''s sync resumes');
select pg_temp.check((select status = 'pending' and paused_by is null from public.kb_attachments where id = pg_temp.id('att3')), 'and the other member''s');

-- 7. the owner leaves the workspace: the KB goes, its synced note is soft deleted, the note they placed there goes back
-- to being theirs, and the grant waits for its revoke
select pg_temp.as_admin_role();
update public.members set deleted_at = now() where id = '01KF0000000000000000000PM3';
select pg_temp.check(not exists (select 1 from public.knowledge_bases where id = pg_temp.id('kb3')), 'the personal KB is gone');
select pg_temp.check(not exists (select 1 from public.kb_attachments where id = pg_temp.id('att3')), 'with its attachment');
select pg_temp.check((select deleted_at is not null from public.notes where id = '01KF000000000000000000PN02'), 'the synced note is soft deleted');
select pg_temp.check((select deleted_at is null and kb_id is null from public.notes where id = '01KF000000000000000000PN01'), 'the placed note stays with its author');
select pg_temp.check((select path = 'Knowledge bases/QA/Guide (2).md' and not personal_kb from public.notes where id = '01KF000000000000000000PR03'), 'a note that stays moves off a path a workspace note holds');
select pg_temp.check(not exists (select 1 from public.contributions where note_id = '01KF000000000000000000PN01'), 'and is not back in the queue');
select pg_temp.check((select revoke_pending and ended_reason = 'left' from public.kb_sync_grants where user_id = '00000000-0000-4000-8000-0000000000a3'), 'the grant waits for its revoke');
select pg_temp.check(exists (select 1 from public.kb_attachments where id = pg_temp.id('att4')), 'the other member''s sync of the same repository stays');

-- 8. the owner deletes their own KB
select pg_temp.as_admin_role();
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id)
  values ('01KF000000000000000000PN03', '00000000-0000-4000-8000-0000000000a4', '01KF0000000000000000000PWS', 'Knowledge bases/QA/README.md',
    jsonb_build_object('visibility', 'public', 'kb_source', 'github:octo/shared-app:README.md', 'kb_attachment', pg_temp.id('att4')), '# Shared app', 'h3', pg_temp.id('kb4'));
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id) values
  ('01KF000000000000000000PN06', '00000000-0000-4000-8000-0000000000a4', '01KF0000000000000000000PWS', 'Elsewhere/a.md',
    '{"visibility": "public", "kb_source": "https://github.com/octo/elsewhere/blob/main/a.md"}', '# Elsewhere', 'h6', pg_temp.id('kb4')),
  ('01KF000000000000000000PN07', '00000000-0000-4000-8000-0000000000a4', '01KF0000000000000000000PWS', 'Elsewhere/b.md',
    '{"visibility": "public", "kb_source": "github:octo/other:b.md", "kb_attachment": "01KF0000000000000000000OTH"}', '# Other sync', 'h7', pg_temp.id('kb4')),
  ('01KF000000000000000000PN08', '00000000-0000-4000-8000-0000000000a4', '01KF0000000000000000000PWS', 'Knowledge bases/QA/docs/c.md',
    '{"visibility": "public", "kb_source": "https://github.com/octo/shared-app/blob/main/docs/c.md"}', '# Imported', 'h8', pg_temp.id('kb4'));
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
select public.kb_source_set(pg_temp.id('kb4'), '{"kind": "github", "url": "https://github.com/octo/shared-app"}');
select pg_temp.check((public.kb_delete(pg_temp.id('kb4')) ->> 'ok')::boolean, 'its owner deletes it');
select pg_temp.as_admin_role();
select pg_temp.check(not exists (select 1 from public.knowledge_bases where id = pg_temp.id('kb4')), 'the KB is gone');
select pg_temp.check((select deleted_at is not null from public.notes where id = '01KF000000000000000000PN03'), 'its synced note is soft deleted');
select pg_temp.check((select body from public.notes where id = '01KF000000000000000000PN03') = '', 'and its text is cleared');
select pg_temp.check((select deleted_at is not null and body = '' from public.notes where id = '01KF000000000000000000PN08'), 'a note imported from its source is soft deleted');
select pg_temp.check((select path = 'Knowledge bases/QA/Guide (3).md' from public.notes where id = '01KF000000000000000000PR04'), 'the next one takes the next free path');
select pg_temp.check((select deleted_at is null and body = '# Elsewhere' and kb_id is null from public.notes where id = '01KF000000000000000000PN06'), 'a note imported elsewhere and moved in stays');
select pg_temp.check((select deleted_at is null and body = '# Other sync' from public.notes where id = '01KF000000000000000000PN07'), 'a note another KB''s sync wrote stays');

-- 9. deleting an account keeps a personal KB's notes out of the hand-over to the workspace owner
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
insert into ids select 'kb4b', public.kb_create('01KF0000000000000000000PWS', 'Scratch', personal => true) ->> 'id';
select pg_temp.as_admin_role();
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id)
  values ('01KF000000000000000000PN04', '00000000-0000-4000-8000-0000000000a4', '01KF0000000000000000000PWS', 'Knowledge bases/Scratch/Plan.md', '{"visibility": "public"}', '# Plan', 'h4', pg_temp.id('kb4b'));
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash)
  values ('01KF000000000000000000PN05', '00000000-0000-4000-8000-0000000000a4', '01KF0000000000000000000PWS', 'Shared/Runbook.md', '{"visibility": "public"}', '# Runbook', 'h5');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a4');
select public.delete_my_account();
select pg_temp.as_admin_role();
select pg_temp.check(not exists (select 1 from public.notes where id = '01KF000000000000000000PN04'), 'the personal KB note goes with the account');
select pg_temp.check((select user_id from public.notes where id = '01KF000000000000000000PN05') = '00000000-0000-4000-8000-0000000000a1', 'a shared note is still handed to the owner');
select pg_temp.check(not exists (select 1 from public.knowledge_bases where id = pg_temp.id('kb4b')), 'the personal KB goes with the account');

-- 10. deleting the workspace with a personal KB in it goes through
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a2');
select public.kb_create('01KF0000000000000000000PWS', 'Admin notes', personal => true);
select pg_temp.as_admin_role();
delete from public.workspaces where id = '01KF0000000000000000000PWS';
select pg_temp.check(not exists (select 1 from public.knowledge_bases where workspace_id = '01KF0000000000000000000PWS'), 'the workspace takes its personal KBs');

select 'personal kbs: ok';
rollback;
