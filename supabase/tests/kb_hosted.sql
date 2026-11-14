-- Knowledge bases hosted by Quorum (migration 0034): the editor role, hosted notes with the expected-version save, the
-- guard on direct note writes, the kb-files Storage rules, the per-file cap and the workspace quota, and read-only
-- hosted KBs on a lapsed plan. The file has no begin or rollback of its own: run it inside one transaction that is
-- rolled back, after 0034 when the database does not have it yet:
--   { echo 'begin;'; cat supabase/migrations/0034_kb_hosted.sql supabase/tests/kb_hosted.sql; echo 'rollback;'; } | docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- On a database with 0034 applied, leave the migration out of that list. A failed check stops the script with the
-- check's message; the last line printed on success is "kb hosted: ok".

-- fixtures. f1 owns the workspace (paid plan); f2 is made an editor of Wiki; f3 a reader of Wiki; f4 a member with no
-- grant on Wiki; f5 owns a second workspace on the free plan and is not in the first
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000f1', 'hosted-owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000f2', 'hosted-editor@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000f3', 'hosted-reader@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000f4', 'hosted-member@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000f5', 'hosted-outsider@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name) values
  ('01KF00000000000000000000WS', '00000000-0000-4000-8000-0000000000f1', 'Hosted Team'),
  ('01KF00000000000000000000W2', '00000000-0000-4000-8000-0000000000f5', 'Free Team');
update public.workspaces set plan = 'paid', seats = 1 where id = '01KF00000000000000000000WS';
insert into public.members (id, user_id, workspace_id, role) values
  ('01KF00000000000000000000M2', '00000000-0000-4000-8000-0000000000f2', '01KF00000000000000000000WS', 'member'),
  ('01KF00000000000000000000M3', '00000000-0000-4000-8000-0000000000f3', '01KF00000000000000000000WS', 'member'),
  ('01KF00000000000000000000M4', '00000000-0000-4000-8000-0000000000f4', '01KF00000000000000000000WS', 'member');

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);
$$;
create function pg_temp.as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;
create function pg_temp.expect_error(stmt text, pattern text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then
    if sqlerrm !~* pattern then raise exception 'expected an error like "%" from %, got "%"', pattern, stmt, sqlerrm; end if;
    return;
  end;
  raise exception 'expected an error like "%" from %, it ran', pattern, stmt;
end $$;
create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if not coalesce(ok, false) then raise exception 'check failed: %', what; end if; end $$;
create temp table ids (k text primary key, v text);
grant all on ids to authenticated;
create function pg_temp.id(name text) returns text language sql as $$ select v from ids where k = name $$;
create function pg_temp.put(name text, value text) returns void language sql as $$ insert into ids values (name, value) on conflict (k) do update set v = excluded.v $$;
-- a storage object as an upload makes it, run as the current role; true when the row went in
create function pg_temp.upload(path text, size bigint) returns boolean language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, owner, metadata) values ('kb-files', path, auth.uid(), jsonb_build_object('size', size, 'mimetype', 'image/png'));
  return true;
exception when others then return false;
end $$;
create function pg_temp.remove(path text) returns bigint language plpgsql as $$
declare c bigint;
begin
  perform set_config('storage.allow_delete_query', 'true', true);
  with d as (delete from storage.objects o where o.bucket_id = 'kb-files' and o.name = path returning 1) select count(*) into c from d;
  return c;
end $$;

-- 1. creating: the owner makes a hosted KB on the paid plan; a free workspace cannot; a member cannot
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select pg_temp.put('wiki', public.kb_create_hosted('01KF00000000000000000000WS', 'Wiki') ->> 'id');
select pg_temp.put('docs', public.kb_create('01KF00000000000000000000WS', 'Docs') ->> 'id');
select pg_temp.check((select source ->> 'kind' from public.knowledge_bases where id = pg_temp.id('wiki')) = 'hosted', 'the new KB is hosted');
select pg_temp.check((public.kb_shape(pg_temp.id('wiki')) ->> 'writable')::boolean, 'the owner may write it');
select pg_temp.expect_error($$select public.kb_source_set(pg_temp.id('wiki'), '{"kind": "github", "url": "https://github.com/o/r"}')$$, 'written in Quorum');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f5');
select pg_temp.expect_error($$select public.kb_create_hosted('01KF00000000000000000000W2', 'Free wiki')$$, 'part of Quorum Cloud');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.expect_error($$select public.kb_create_hosted('01KF00000000000000000000WS', 'Mine')$$, 'Only owners and admins');

-- 2. roles: an editor and a reader on Wiki; the editor role is refused on a KB with no hosted storage
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select public.kb_set_access(pg_temp.id('wiki'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000f2", "role": "editor"}, {"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000f3", "role": "reader"}, {"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000f3", "role": "editor"}, {"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000f3", "role": "reader"}]');
select pg_temp.check((select role from public.kb_access where kb_id = pg_temp.id('wiki') and user_id = '00000000-0000-4000-8000-0000000000f3') = 'editor', 'a person named twice keeps the higher role');
select public.kb_set_access(pg_temp.id('wiki'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000f2", "role": "editor"}, {"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000f3", "role": "reader"}]');
select pg_temp.expect_error($$select public.kb_set_access(pg_temp.id('docs'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000f2", "role": "editor"}]')$$, 'Editors are for knowledge bases hosted');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.check(public.kb_shape(pg_temp.id('wiki')) ->> 'role' = 'editor', 'the editor reads as editor');
select pg_temp.check((public.kb_shape(pg_temp.id('wiki')) ->> 'writable')::boolean, 'the editor may write');
select pg_temp.check(public.kb_shape(pg_temp.id('wiki')) -> 'access' = 'null'::jsonb, 'the editor does not see the access list');
select pg_temp.expect_error($$select public.kb_set_access(pg_temp.id('wiki'), '[{"principal": "workspace", "role": "editor"}]')$$, 'Only the knowledge base''s admins can change who reads it');
select pg_temp.expect_error($$select public.kb_delete(pg_temp.id('wiki'))$$, 'Only owners and admins can delete');
select pg_temp.expect_error($$select public.kb_rename(pg_temp.id('wiki'), 'Editor wiki')$$, 'Only the knowledge base''s admins can rename');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f3');
select pg_temp.check(public.kb_shape(pg_temp.id('wiki')) ->> 'role' = 'reader', 'the reader reads as reader');
select pg_temp.check(not (public.kb_shape(pg_temp.id('wiki')) ->> 'writable')::boolean, 'the reader may not write');

-- 3. the editor makes a folder and two notes; the server owns the stored text and its hash
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.put('guides', public.kb_folder_create(pg_temp.id('wiki'), null, 'Guides') ->> 'id');
select pg_temp.put('n1', '01KF000000000000000000NH01');
select pg_temp.put('h1', public.kb_hosted_note_save(pg_temp.id('wiki'), pg_temp.id('n1'), pg_temp.id('guides'), 'Setup', E'# Setup\nStep one.', null) -> 'note' ->> 'hash');
select pg_temp.put('n2', '01KF000000000000000000NH02');
select public.kb_hosted_note_save(pg_temp.id('wiki'), pg_temp.id('n2'), null, 'Policies', 'Read these.', null);
select pg_temp.check((select path from public.notes where id = pg_temp.id('n1')) = 'Knowledge bases/Wiki/Guides/Setup.md', 'the path follows the KB and folder');
select pg_temp.check((select hash = encode(sha256(convert_to(body, 'UTF8')), 'hex') and body like E'---\ntitle: "Setup"\nvisibility: public\nkb_hosted: %' from public.notes where id = pg_temp.id('n1')), 'the hash is the stored text''s');
select pg_temp.check((select frontmatter ->> 'kb_hosted' = pg_temp.id('wiki') and kb_id = pg_temp.id('wiki') from public.notes where id = pg_temp.id('n1')), 'the note carries kb_hosted');
select pg_temp.expect_error($$select public.kb_hosted_note_save(pg_temp.id('wiki'), '01KF000000000000000000NH03', pg_temp.id('guides'), 'setup', 'again', null)$$, 'already in this folder');
select pg_temp.check((public.kb_hosted_note_move(pg_temp.id('n2'), pg_temp.id('guides')) -> 'note' ->> 'path') = 'Knowledge bases/Wiki/Guides/Policies.md', 'a move follows the folder');

-- 4. the reader reads and cannot write anything
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f3');
select pg_temp.check((select count(*) from public.notes where kb_id = pg_temp.id('wiki')) = 2, 'the reader reads both notes');
select pg_temp.expect_error($$select public.kb_hosted_note_save(pg_temp.id('wiki'), pg_temp.id('n1'), null, 'Setup', 'mine', pg_temp.id('h1'))$$, 'editors and admins can change it');
select pg_temp.expect_error($$select public.kb_hosted_note_save(pg_temp.id('wiki'), '01KF000000000000000000NH09', null, 'New', 'mine', null)$$, 'editors and admins can change it');
select pg_temp.expect_error($$select public.kb_hosted_note_delete(pg_temp.id('n1'), pg_temp.id('h1'))$$, 'editors and admins can change it');
select pg_temp.expect_error($$select public.kb_hosted_note_move(pg_temp.id('n1'), null)$$, 'editors and admins can change it');
select pg_temp.expect_error($$select public.kb_folder_create(pg_temp.id('wiki'), null, 'Mine')$$, 'editors and admins can change it');
select pg_temp.expect_error($$select public.kb_folder_rename(pg_temp.id('guides'), 'Mine')$$, 'editors and admins can change it');
select pg_temp.expect_error($$select public.kb_folder_delete(pg_temp.id('guides'))$$, 'editors and admins can change it');
select pg_temp.expect_error($$select public.kb_file_begin(pg_temp.id('n1'), 'a.png', 'image/png', 10)$$, 'editors and admins can change it');
select pg_temp.expect_error($$insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, kb_id) values ('01KF000000000000000000NH08', '00000000-0000-4000-8000-0000000000f3', '01KF00000000000000000000WS', 'x.md', '{"visibility": "public"}', 'x', pg_temp.id('wiki'))$$, 'changed from the Knowledge tab|admins can add notes');

-- 5. the outsider (a member with no grant, and someone from another workspace) gets nothing
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f4');
select pg_temp.check(public.kb_shape(pg_temp.id('wiki')) is null, 'no shape for the member without a grant');
select pg_temp.check(not exists (select 1 from jsonb_array_elements(public.kb_list('01KF00000000000000000000WS')) k where k ->> 'id' = pg_temp.id('wiki')), 'the list leaves Wiki out');
select pg_temp.check((select count(*) from public.notes where kb_id = pg_temp.id('wiki')) = 0, 'no notes for the member without a grant');
select pg_temp.expect_error($$select public.kb_hosted_note_save(pg_temp.id('wiki'), '01KF000000000000000000NH09', null, 'New', 'x', null)$$, 'no longer exists');
select pg_temp.expect_error($$select public.kb_folder_create(pg_temp.id('wiki'), null, 'Mine')$$, 'no longer exists');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f5');
select pg_temp.check((select count(*) from public.notes where kb_id = pg_temp.id('wiki')) = 0, 'no notes for someone outside the workspace');
select pg_temp.expect_error($$select public.kb_hosted_note_move(pg_temp.id('n1'), null)$$, 'no longer exists');

-- 6. concurrent edits: the owner saves on top of the version the editor already replaced and gets the newer one back
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.put('h2', public.kb_hosted_note_save(pg_temp.id('wiki'), pg_temp.id('n1'), pg_temp.id('guides'), 'Setup', E'# Setup\nStep one.\nStep two.', pg_temp.id('h1')) -> 'note' ->> 'hash');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select pg_temp.put('c', public.kb_hosted_note_save(pg_temp.id('wiki'), pg_temp.id('n1'), pg_temp.id('guides'), 'Setup', E'# Setup\nStep one, owner.', pg_temp.id('h1'))::text);
select pg_temp.check((pg_temp.id('c')::jsonb ->> 'conflict')::boolean, 'a stale save is a conflict');
select pg_temp.check(pg_temp.id('c')::jsonb -> 'note' ->> 'hash' = pg_temp.id('h2'), 'the conflict carries the newer version');
select pg_temp.check(pg_temp.id('c')::jsonb -> 'note' ->> 'body' like '%Step two.', 'the conflict carries the newer text');
select pg_temp.check(pg_temp.id('c')::jsonb -> 'note' ->> 'edited_by_name' = 'hosted-editor@example.com', 'the conflict names who saved it');
select pg_temp.check((select hash from public.notes where id = pg_temp.id('n1')) = pg_temp.id('h2'), 'nothing was written');
select pg_temp.check((public.kb_hosted_note_delete(pg_temp.id('n1'), pg_temp.id('h1')) ->> 'conflict')::boolean, 'a stale delete is a conflict');
select pg_temp.check((public.kb_hosted_note_save(pg_temp.id('wiki'), pg_temp.id('n1'), pg_temp.id('guides'), 'Setup', 'Merged.', pg_temp.id('h2')) ->> 'ok')::boolean, 'a save on the newer version goes in');

-- 7. the guard: the author cannot change a hosted note through the table API, and a personal note cannot be placed in a
-- hosted KB or taken out of one
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.expect_error($$update public.notes set body = 'direct' where id = pg_temp.id('n2')$$, 'changed from the Knowledge tab');
select pg_temp.expect_error($$update public.notes set kb_id = null where id = pg_temp.id('n2')$$, 'changed from the Knowledge tab');
select pg_temp.expect_error($$delete from public.notes where id = pg_temp.id('n2')$$, 'changed from the Knowledge tab');
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body) values ('01KF000000000000000000NP01', '00000000-0000-4000-8000-0000000000f2', '01KF00000000000000000000WS', 'Mine.md', '{"visibility": "public"}', 'mine');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select pg_temp.expect_error($$select public.kb_note_assign('01KF000000000000000000NP01', pg_temp.id('wiki'), null)$$, 'changed from the Knowledge tab');

-- 8. files: the editor begins a file and uploads it; the reader reads it; others cannot read, upload or delete
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.put('file', public.kb_file_begin(pg_temp.id('n2'), 'Diagram.png', 'image/png', 2048)::text);
select pg_temp.put('obj', pg_temp.id('file')::jsonb ->> 'object_path');
select pg_temp.check(pg_temp.id('obj') like '01KF00000000000000000000WS/' || pg_temp.id('wiki') || '/' || pg_temp.id('n2') || '/%/Diagram.png', 'the object sits under workspace, KB and note');
select pg_temp.check(pg_temp.id('file')::jsonb ->> 'link' = 'quorum://kb-file/' || (pg_temp.id('file')::jsonb ->> 'id'), 'the link is the stable quorum link');
select pg_temp.expect_error($$select public.kb_file_begin(pg_temp.id('n2'), 'big.pdf', 'application/pdf', 26214401)$$, 'up to 25 MB');
select pg_temp.expect_error($$select public.kb_file_begin(pg_temp.id('n2'), 'run.sh', 'text/x-shellscript', 10)$$, 'image or a PDF');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f3');
select pg_temp.check(not pg_temp.upload(pg_temp.id('obj'), 2048), 'the reader cannot upload to a begun file');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.check(not pg_temp.upload('01KF00000000000000000000WS/' || pg_temp.id('wiki') || '/' || pg_temp.id('n2') || '/01KF0000000000000000000XXX/other.png', 10), 'an upload needs a begun file');
select pg_temp.check(pg_temp.upload(pg_temp.id('obj'), 2048), 'the editor uploads the begun file');
select pg_temp.check((public.kb_file_done((pg_temp.id('file')::jsonb ->> 'id')) ->> 'uploaded')::boolean, 'the upload is recorded');
select pg_temp.check(not pg_temp.upload(pg_temp.id('obj'), 2048), 'a finished file is not uploaded again');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f3');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'kb-files' and name = pg_temp.id('obj')) = 1, 'the reader reads the object');
select pg_temp.check((select count(*) from public.kb_files where note_id = pg_temp.id('n2')) = 1, 'the reader reads the file row');
select pg_temp.check(pg_temp.remove(pg_temp.id('obj')) = 0, 'the reader cannot delete the object');
select pg_temp.expect_error($$select public.kb_file_remove((pg_temp.id('file')::jsonb ->> 'id'))$$, 'editors and admins can change it');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f4');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'kb-files' and name = pg_temp.id('obj')) = 0, 'the member without a grant cannot read the object');
select pg_temp.check((select count(*) from public.kb_files) = 0, 'the member without a grant reads no file rows');
select pg_temp.check(pg_temp.remove(pg_temp.id('obj')) = 0, 'the member without a grant cannot delete the object');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f5');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'kb-files') = 0, 'someone outside the workspace reads no object');

-- 9. the quota: 2 GB for the one seat; files already stored count, and a file that would pass it is refused
select pg_temp.as_admin();
insert into public.kb_files (workspace_id, kb_id, note_id, name, mime, size, object_path, uploaded)
  select '01KF00000000000000000000WS', pg_temp.id('wiki'), pg_temp.id('n2'), 'fill.pdf', 'application/pdf', 26214400, 'fill/' || g, true from generate_series(1, 81) g;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.check((public.kb_files_usage('01KF00000000000000000000WS') ->> 'quota')::bigint = 2147483648, 'the quota is 2 GB per seat');
select pg_temp.expect_error($$select public.kb_file_begin(pg_temp.id('n2'), 'one-more.pdf', 'application/pdf', 26214400)$$, 'used its 2 GB');
select pg_temp.as_admin();
delete from public.kb_files where object_path like 'fill/%';

-- 10. a lapsed plan: the hosted KB is read-only for everyone, and nothing in it is deleted
update public.workspaces set plan = 'free' where id = '01KF00000000000000000000WS';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.put('h3', (select hash from public.notes where id = pg_temp.id('n1')));
select pg_temp.check(not (public.kb_shape(pg_temp.id('wiki')) ->> 'writable')::boolean, 'a lapsed plan is not writable');
select pg_temp.expect_error($$select public.kb_hosted_note_save(pg_temp.id('wiki'), pg_temp.id('n1'), pg_temp.id('guides'), 'Setup', 'late', pg_temp.id('h3'))$$, 'plan ended');
select pg_temp.expect_error($$select public.kb_hosted_note_delete(pg_temp.id('n1'), pg_temp.id('h3'))$$, 'plan ended');
select pg_temp.expect_error($$select public.kb_folder_delete(pg_temp.id('guides'))$$, 'plan ended');
select pg_temp.expect_error($$select public.kb_file_begin(pg_temp.id('n2'), 'a.png', 'image/png', 10)$$, 'plan ended');
select pg_temp.expect_error($$select public.kb_file_remove((pg_temp.id('file')::jsonb ->> 'id'))$$, 'plan ended');
select pg_temp.check(pg_temp.remove(pg_temp.id('obj')) = 0, 'a lapsed plan keeps the object');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select pg_temp.expect_error($$select public.kb_hosted_note_save(pg_temp.id('wiki'), pg_temp.id('n1'), pg_temp.id('guides'), 'Setup', 'late', pg_temp.id('h3'))$$, 'plan ended');
select pg_temp.expect_error($$select public.kb_delete(pg_temp.id('wiki'))$$, 'plan ended');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f3');
select pg_temp.check((select count(*) from public.notes where kb_id = pg_temp.id('wiki') and deleted_at is null) = 2, 'the reader still reads every note');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'kb-files' and name = pg_temp.id('obj')) = 1, 'the reader still reads the object');
select pg_temp.as_admin();
update public.workspaces set plan = 'paid' where id = '01KF00000000000000000000WS';

-- 11. back on a paid plan: the editor removes the file and deletes a note; the owner deletes the KB, and its notes are
-- soft deleted with it so every Mac removes its copy
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.check(public.kb_file_remove((pg_temp.id('file')::jsonb ->> 'id')) = pg_temp.id('obj'), 'removing a file names its object');
select pg_temp.check(pg_temp.remove(pg_temp.id('obj')) = 1, 'the editor deletes the object');
select pg_temp.check((public.kb_hosted_note_delete(pg_temp.id('n2'), (select hash from public.notes where id = pg_temp.id('n2'))) ->> 'ok')::boolean, 'the editor deletes a note');
select pg_temp.check((select deleted_at is not null from public.notes where id = pg_temp.id('n2')), 'the deleted note is soft deleted');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select public.kb_delete(pg_temp.id('wiki'));
select pg_temp.as_admin();
select pg_temp.check((select deleted_at is not null and kb_id is null from public.notes where id = pg_temp.id('n1')), 'the KB''s notes are soft deleted with it');

select 'kb hosted: ok';
