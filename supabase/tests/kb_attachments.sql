-- Connector folder sync (migration 0032): no client reads a sync token or the grants table, only a KB's admins see and
-- manage its attachments, attaching is for the relay alone, and ending a grant (remove, disconnect, leaving) deletes or
-- queues its Vault secret. Needs a database with every migration applied (supabase start, or supabase db reset on a
-- local stack). Everything runs in one transaction that is rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/kb_attachments.sql
-- On a stack that has migrations up to 0030 or 0031 only, put the migration inside the same transaction:
--   { echo 'begin;'; cat supabase/migrations/0032_kb_attachments.sql; grep -v '^begin;$' supabase/tests/kb_attachments.sql; } | docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- A failed check stops the script with the check's message; the last line printed on success is "kb attachments: ok".
begin;

-- fixtures. s1 owns the workspace; s2 is a member made admin of the KB; s3 is a member who reads it; s4 is outside
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000f1', 'sync-owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000f2', 'sync-admin@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000f3', 'sync-reader@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000f4', 'sync-outsider@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name, team_enabled, plan) values ('01KF00000000000000000000WS', '00000000-0000-4000-8000-0000000000f1', 'Sync Team', true, 'paid');
insert into public.members (id, user_id, workspace_id, role) values
  ('01KF00000000000000000000M2', '00000000-0000-4000-8000-0000000000f2', '01KF00000000000000000000WS', 'member'),
  ('01KF00000000000000000000M3', '00000000-0000-4000-8000-0000000000f3', '01KF00000000000000000000WS', 'member');

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

-- 1. the owner makes a KB, gives s2 admin and s3 reader, and approves Google Drive and GitHub for the workspace
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'kb', public.kb_create('01KF00000000000000000000WS', 'Handbook') ->> 'id';
insert into ids select 'folder', public.kb_folder_create(pg_temp.id('kb'), null, 'Policies') ->> 'id';
select public.kb_set_access(pg_temp.id('kb'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000f2", "role": "admin"}, {"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000f3", "role": "reader"}]');
select public.workspace_integration_save('01KF00000000000000000000WS', 'google-drive', 'personal', '{}', null);

-- 2. attaching is for the relay: a client session, even a KB admin's, is refused
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.expect_error(format($$select public.kb_sync_attach('00000000-0000-4000-8000-0000000000f2', %L, null, 'google-drive', 'drive-folder-1', 'folder', '{}', 'Policies', null, 'rt-sync-AAAA')$$, pg_temp.id('kb')), 'permission denied|only the relay');

-- 3. the relay attaches a Drive folder for s2 with their refresh token; GitHub is not approved, so it is refused
select pg_temp.as_service();
insert into ids select 'att', public.kb_sync_attach('00000000-0000-4000-8000-0000000000f2', pg_temp.id('kb'), pg_temp.id('folder'), 'google-drive', 'drive-folder-1', 'folder', '{}', 'Policies', 'https://drive.google.com/drive/folders/drive-folder-1', 'rt-sync-AAAA', 'quorum', true, 'sync-admin@example.com') ->> 'id';
select pg_temp.expect_error(format($$select public.kb_sync_attach('00000000-0000-4000-8000-0000000000f2', %L, null, 'github', 'octo/handbook', 'folder', '{}', 'handbook', null, 'gh-rt-1')$$, pg_temp.id('kb')), 'only connectors an admin approved');
select pg_temp.expect_error(format($$select public.kb_sync_attach('00000000-0000-4000-8000-0000000000f3', %L, null, 'google-drive', 'drive-folder-2', 'folder', '{}', 'X', null, 'rt-sync-BBBB')$$, pg_temp.id('kb')), 'only the knowledge base''s admins');
select pg_temp.check((select count(*) from vault.secrets s join public.kb_sync_grants g on g.secret_id = s.id where g.user_id = '00000000-0000-4000-8000-0000000000f2') = 1, 'the token is in Vault');
select pg_temp.check((select refresh_token from public.kb_sync_token(pg_temp.id('att'))) = 'rt-sync-AAAA', 'the service role reads the token back');
select public.kb_sync_token_store((select grant_id from public.kb_sync_token(pg_temp.id('att'))), 'rt-sync-ROTATED');
select pg_temp.check((select refresh_token from public.kb_sync_token(pg_temp.id('att'))) = 'rt-sync-ROTATED', 'a rotated token replaces the stored one');

-- 4. no client reads a token or the grants table: not the admin who attached, not the owner
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.expect_error($$select * from public.kb_sync_grants$$, 'permission denied');
select pg_temp.expect_error(format($$select * from public.kb_sync_token(%L)$$, pg_temp.id('att')), 'permission denied|only the relay');
select pg_temp.expect_error($$select * from public.kb_sync_revocations(10)$$, 'permission denied|only the relay');
select pg_temp.expect_error($$select * from public.relay_workspace_oauth_client('01KF00000000000000000000WS', 'google-drive')$$, 'permission denied|only the relay');
select pg_temp.expect_error($$select public.kb_sync_claim(10, 600, 2)$$, 'permission denied|only the relay');
select pg_temp.expect_error($$select cursor from public.kb_attachments$$, 'permission denied');
select pg_temp.expect_error($$select lease_until from public.kb_attachments$$, 'permission denied');
select pg_temp.check(public.kb_attachments_list(pg_temp.id('kb'))::text !~ 'rt-sync', 'the admin list never carries the token');
select pg_temp.check(not (public.kb_attachments_list(pg_temp.id('kb')) -> 0 ? 'grant_id'), 'the admin list leaves out the grant id');
select pg_temp.check((public.kb_attachments_list(pg_temp.id('kb')) -> 0 ->> 'connected')::boolean, 'the admin list says it is connected');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select pg_temp.expect_error($$select secret_id from public.kb_sync_grants$$, 'permission denied');
select pg_temp.check((select count(*) from public.kb_attachments) = 1, 'a workspace owner sees the attachment');

-- 5. only KB admins see and manage attachments: the reader and the outsider see none and are refused
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f3');
select pg_temp.check((select count(*) from public.kb_attachments) = 0, 'a reader sees no attachments');
select pg_temp.expect_error(format($$select public.kb_attachments_list(%L)$$, pg_temp.id('kb')), 'only the knowledge base''s admins');
select pg_temp.expect_error(format($$select public.kb_attachment_pause(%L, true)$$, pg_temp.id('att')), 'no longer exists');
select pg_temp.expect_error(format($$select public.kb_attachment_remove(%L)$$, pg_temp.id('att')), 'no longer exists');
select pg_temp.expect_error(format($$update public.kb_attachments set status = 'paused' where id = %L$$, pg_temp.id('att')), 'permission denied');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f4');
select pg_temp.check((select count(*) from public.kb_attachments) = 0, 'an outsider sees no attachments');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.expect_error(format($$update public.kb_attachments set status = 'paused' where id = %L$$, pg_temp.id('att')), 'permission denied');
select pg_temp.expect_error(format($$delete from public.kb_attachments where id = %L$$, pg_temp.id('att')), 'permission denied');

-- 6. pause keeps it off the schedule; resume puts it back; the claim leases it once
select pg_temp.check((public.kb_attachment_pause(pg_temp.id('att'), true) ->> 'status') = 'paused', 'an admin pauses');
select pg_temp.as_service();
select pg_temp.check(jsonb_array_length(public.kb_sync_claim(10, 600)) = 0, 'a paused attachment is not claimed');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.check((public.kb_attachment_pause(pg_temp.id('att'), false) ->> 'status') = 'pending', 'an admin resumes');
select pg_temp.as_service();
insert into ids select 'claim', public.kb_sync_claim(10, 600)::text;
select pg_temp.check(jsonb_array_length(pg_temp.id('claim')::jsonb) = 1, 'the worker claims the due attachment');
select pg_temp.check(pg_temp.id('claim') !~ 'rt-sync', 'a claim carries no token');
select pg_temp.check((pg_temp.id('claim')::jsonb -> 0 ->> 'kb_name') = 'Handbook', 'a claim carries the KB name');
select pg_temp.check(jsonb_array_length(public.kb_sync_claim(10, 600)) = 0, 'a leased attachment is not claimed twice');
select public.kb_sync_finish(pg_temp.id('att'), true, null, '{"listed_at": "2026-11-13T00:00:00Z"}', 3, 900);
select pg_temp.check((select status = 'active' and note_count = 3 and lease_until is null and last_synced_at is not null from public.kb_attachments where id = pg_temp.id('att')), 'a finished run is active with its count');
select public.kb_sync_finish(pg_temp.id('att'), false, 'Google Drive is limiting requests.', null, null, 120);
select pg_temp.check((select status = 'error' and failures = 1 and error like 'Google Drive%' from public.kb_attachments where id = pg_temp.id('att')), 'a failed run shows the error to admins');

-- 7. a KB admin who loses admin rights stops the sync at the next claim
select pg_temp.as_admin_role();
update public.kb_attachments set next_run_at = now() - interval '1 minute' where id = pg_temp.id('att');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select public.kb_set_access(pg_temp.id('kb'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000f2", "role": "reader"}]');
select pg_temp.as_service();
select pg_temp.check(jsonb_array_length(public.kb_sync_claim(10, 600)) = 0, 'an attachment by a former KB admin is not claimed');
select pg_temp.check((select status from public.kb_attachments where id = pg_temp.id('att')) = 'needs_auth', 'it waits for another admin');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select public.kb_set_access(pg_temp.id('kb'), '[{"principal": "user", "user_id": "00000000-0000-4000-8000-0000000000f2", "role": "admin"}]');

-- 8. removing the attachment takes its notes out and ends the grant. The grant is the one s2's Mac shares, so it is
-- deleted with its Vault secret and not queued for a provider revoke
select pg_temp.as_admin_role();
insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, kb_id, folder_id)
  values ('01KF000000000000000000NT01', '00000000-0000-4000-8000-0000000000f2', '01KF00000000000000000000WS', 'Knowledge bases/Handbook/Policies/Leave.md',
    jsonb_build_object('visibility', 'public', 'kb_source', 'google-drive:file-1', 'kb_attachment', pg_temp.id('att')), '# Leave', 'h1', pg_temp.id('kb'), pg_temp.id('folder'));
insert into ids select 'secret', secret_id::text from public.kb_sync_grants where user_id = '00000000-0000-4000-8000-0000000000f2';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f2');
select pg_temp.check(public.kb_attachment_remove(pg_temp.id('att')) = 1, 'removing takes its note out');
select pg_temp.as_admin_role();
select pg_temp.check((select deleted_at is not null from public.notes where id = '01KF000000000000000000NT01'), 'the note is soft deleted');
select pg_temp.check(not exists (select 1 from public.kb_sync_grants where user_id = '00000000-0000-4000-8000-0000000000f2'), 'the last attachment gone ends the grant');
select pg_temp.check(not exists (select 1 from vault.secrets where id = pg_temp.id('secret')::uuid), 'the Vault secret is deleted');

-- 9. a grant of its own (GitHub, approved now) is queued for a provider revoke when its admin leaves the workspace
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select public.workspace_integration_save('01KF00000000000000000000WS', 'github', 'personal', '{}', null);
select pg_temp.as_service();
insert into ids select 'gh', public.kb_sync_attach('00000000-0000-4000-8000-0000000000f2', pg_temp.id('kb'), null, 'github', 'octo/handbook', 'folder', '{"branch": "main", "path": "/docs/"}', 'octo/handbook', 'https://github.com/octo/handbook', 'gh-rt-1', 'quorum', false) ->> 'id';
select pg_temp.check((select options from public.kb_attachments where id = pg_temp.id('gh')) = '{"branch": "main", "path": "docs"}'::jsonb, 'the options are cleaned');
select pg_temp.as_admin_role();
update public.members set deleted_at = now() where id = '01KF00000000000000000000M2';
select pg_temp.check((select status from public.kb_attachments where id = pg_temp.id('gh')) = 'needs_auth', 'the attachment waits for another admin');
select pg_temp.check((select revoke_pending and ended_reason = 'left' from public.kb_sync_grants where user_id = '00000000-0000-4000-8000-0000000000f2'), 'the grant waits for its revoke');
select pg_temp.as_service();
select pg_temp.check((select count(*) from public.kb_sync_revocations(10) where refresh_token = 'gh-rt-1') = 1, 'the worker reads the token to revoke');
select pg_temp.check((select count(*) from public.kb_sync_token(pg_temp.id('gh'))) = 0, 'an ended grant no longer serves a sync');
select public.kb_sync_revoked((select grant_id from public.kb_sync_revocations(10) limit 1));
select pg_temp.check(not exists (select 1 from public.kb_sync_grants where user_id = '00000000-0000-4000-8000-0000000000f2'), 'a revoked grant is deleted');
select pg_temp.check((select grant_id is null from public.kb_attachments where id = pg_temp.id('gh')), 'the attachment no longer points at it');

-- 10. disconnect on the Mac ends the caller's grants and queues the revoke, even for a grant the Mac shares
select pg_temp.as_service();
insert into ids select 'own', public.kb_sync_attach('00000000-0000-4000-8000-0000000000f1', pg_temp.id('kb'), null, 'google-drive', 'drive-file-9', 'file', '{}', 'Roadmap', null, 'rt-owner-1', 'quorum', true) ->> 'id';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000f1');
select pg_temp.check(public.kb_sync_disconnect('01KF00000000000000000000WS', 'google-drive') = 1, 'disconnect ends one grant');
select pg_temp.as_admin_role();
select pg_temp.check((select revoke_pending and ended_reason = 'disconnected' from public.kb_sync_grants where user_id = '00000000-0000-4000-8000-0000000000f1'), 'a disconnect queues the revoke');
select pg_temp.check((select status from public.kb_attachments where id = pg_temp.id('own')) = 'needs_auth', 'its attachments wait for a sign-in');

-- 11. the per-workspace cap: with one run allowed, two due attachments in one workspace are claimed one at a time
select pg_temp.as_service();
select public.kb_sync_attach('00000000-0000-4000-8000-0000000000f1', pg_temp.id('kb'), null, 'google-drive', 'drive-file-10', 'file', '{}', 'A', null, 'rt-owner-2', 'quorum', true);
select public.kb_sync_attach('00000000-0000-4000-8000-0000000000f1', pg_temp.id('kb'), null, 'google-drive', 'drive-file-11', 'file', '{}', 'B', null, null, 'quorum', true);
select pg_temp.check(jsonb_array_length(public.kb_sync_claim(10, 600, 1)) = 1, 'one run at a time in the workspace');
select pg_temp.check(jsonb_array_length(public.kb_sync_claim(10, 600, 1)) = 0, 'the second waits for the first');
select pg_temp.check(jsonb_array_length(public.kb_sync_claim(10, 600, 2)) = 1, 'a higher cap lets the second run');

select pg_temp.as_admin_role();
select 'kb attachments: ok';
rollback;
