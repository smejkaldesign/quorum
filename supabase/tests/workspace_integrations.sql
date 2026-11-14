-- Workspace connectors (migration 0030): the secret never comes back to a client, a member cannot write, a member reads
-- only enabled rows, the approved-connectors switch belongs to owners and admins, and member_integrations stays per
-- person. Needs a database with every migration applied (supabase start, or supabase db reset on a local stack).
-- Everything runs in one transaction that is rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/workspace_integrations.sql
-- On a stack that has migrations up to 0029 only, put the migration inside the same transaction:
--   { echo 'begin;'; cat supabase/migrations/0030_workspace_integrations.sql; grep -v '^begin;$' supabase/tests/workspace_integrations.sql; } | docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- A failed check stops the script with the check's message; the last line printed on success is "workspace integrations: ok".
begin;

-- fixtures. i1 owns the team workspace; i2 is an admin; i3 is a member; i4 belongs to another workspace
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000e1', 'int-owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e2', 'int-admin@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e3', 'int-member@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000e4', 'int-outsider@example.com', 'authenticated', 'authenticated');
insert into public.workspaces (id, user_id, name, team_enabled) values
  ('01KE00000000000000000000WA', '00000000-0000-4000-8000-0000000000e1', 'Integrations Team', true),
  ('01KE00000000000000000000WB', '00000000-0000-4000-8000-0000000000e4', 'Other Team', false);
insert into public.members (id, user_id, workspace_id, role) values
  ('01KE00000000000000000000M2', '00000000-0000-4000-8000-0000000000e2', '01KE00000000000000000000WA', 'admin'),
  ('01KE00000000000000000000M3', '00000000-0000-4000-8000-0000000000e3', '01KE00000000000000000000WA', 'member');

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u::text, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);
$$;
create function pg_temp.as_admin_role() returns void language sql as $$ select set_config('role', 'postgres', true); $$;
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
create temp table out (k text primary key, v jsonb);
grant all on out to authenticated;

-- 1. the switch starts on for every workspace, so a team has it on by default
select pg_temp.check((select approved_connectors_only from public.workspaces where id = '01KE00000000000000000000WA'), 'approved_connectors_only defaults to true');

-- 2. the owner enables Notion in org mode with a key, and Google Drive in personal mode
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
insert into out values ('notion', public.workspace_integration_save('01KE00000000000000000000WA', 'notion', 'org',
  '{"scopes": ["read", "read", " "], "custom_scopes": true, "owner_id": "00000000-0000-4000-8000-0000000000e2", "mock": false, "auth": "api_key", "junk": 1}', 'secret_ABCDEFGH1234'));
insert into out values ('drive', public.workspace_integration_save('01KE00000000000000000000WA', 'google-drive', 'personal', '{}', null));
select pg_temp.check((select v ->> 'secret_set' from out where k = 'notion') = 'true', 'the org row reports a secret set');
select pg_temp.check((select v ->> 'secret_last4' from out where k = 'notion') = '1234', 'the org row reports the last four characters');
select pg_temp.check(not (select v ? 'secret_id' from out where k = 'notion'), 'the RPC never returns secret_id');
select pg_temp.check((select v::text from out where k = 'notion') !~ 'secret_ABCDEFGH', 'the RPC never returns the secret');
select pg_temp.check((select v -> 'config' -> 'scopes' from out where k = 'notion') = '["read"]'::jsonb, 'scopes are trimmed and deduplicated');
select pg_temp.check(not (select v -> 'config' ? 'junk' from out where k = 'notion'), 'unknown config keys are dropped');
select pg_temp.check((select v ->> 'secret_set' from out where k = 'drive') = 'false', 'a personal row has no secret');

-- 3. no client reads the Vault id or the last four characters, the owner included
select pg_temp.expect_error($$select secret_id from public.workspace_integrations$$, 'permission denied');
select pg_temp.expect_error($$select secret_last4 from public.workspace_integrations$$, 'permission denied');
select pg_temp.expect_error($$select * from public.workspace_integrations$$, 'permission denied');
select pg_temp.expect_error($$select * from vault.decrypted_secrets$$, 'permission denied');
select pg_temp.expect_error($$select public.workspace_integration_admin_row(i) from public.workspace_integrations i$$, 'permission denied');
-- the secret did reach Vault
select pg_temp.as_admin_role();
select pg_temp.check((select s.decrypted_secret from vault.decrypted_secrets s join public.workspace_integrations i on i.secret_id = s.id where i.provider = 'notion') = 'secret_ABCDEFGH1234', 'the secret is stored in Vault');

-- 4. a plain member cannot write, by RPC or directly, and cannot list the admin view
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3');
select pg_temp.expect_error($$select public.workspace_integration_save('01KE00000000000000000000WA', 'slack', 'personal', '{}', null)$$, 'only owners and admins');
select pg_temp.expect_error($$select public.workspace_integration_set_enabled((select id from public.workspace_integrations where provider = 'notion'), false)$$, 'no longer exists');
select pg_temp.expect_error($$select public.workspace_integration_remove((select id from public.workspace_integrations where provider = 'notion'))$$, 'no longer exists');
select pg_temp.expect_error($$select public.workspace_integrations_admin('01KE00000000000000000000WA')$$, 'only owners and admins');
select pg_temp.expect_error($$select public.workspace_set_approved_connectors_only('01KE00000000000000000000WA', false)$$, 'only owners and admins');
select pg_temp.expect_error($$insert into public.workspace_integrations (workspace_id, provider, mode) values ('01KE00000000000000000000WA', 'slack', 'personal')$$, 'permission denied');
select pg_temp.expect_error($$update public.workspace_integrations set enabled = false$$, 'permission denied');
select pg_temp.expect_error($$delete from public.workspace_integrations$$, 'permission denied');

-- 5. the admin turns Notion off: the member reads only the enabled row, the admin still reads both
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select public.workspace_integration_set_enabled((select id from public.workspace_integrations where provider = 'notion'), false);
select pg_temp.check((select count(*) from public.workspace_integrations) = 2, 'an admin reads disabled rows too');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3');
select pg_temp.check((select array_agg(provider) from public.workspace_integrations) = array['google-drive'], 'a member reads enabled rows only');
select pg_temp.check((select public.workspace_connector_policy('01KE00000000000000000000WA') -> 'enabled') @> '[{"provider": "google-drive", "mode": "personal"}]'::jsonb
  and jsonb_array_length(public.workspace_connector_policy('01KE00000000000000000000WA') -> 'enabled') = 1, 'the policy lists enabled connectors only');
select pg_temp.check((public.workspace_connector_policy('01KE00000000000000000000WA') ->> 'approved_only')::boolean, 'approved only applies on a team');

-- 6. an outsider reads nothing and cannot read the policy
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e4');
select pg_temp.check((select count(*) from public.workspace_integrations) = 0, 'an outsider reads no rows');
select pg_temp.expect_error($$select public.workspace_connector_policy('01KE00000000000000000000WA')$$, 'not a member');
select pg_temp.expect_error($$select public.workspace_integration_save('01KE00000000000000000000WA', 'slack', 'personal', '{}', null)$$, 'only owners and admins');
-- a solo workspace: the switch is stored on, but applies only with the team switch on
select pg_temp.check(not (public.workspace_connector_policy('01KE00000000000000000000WB') ->> 'approved_only')::boolean, 'approved only does not apply without a team');

-- 7. member connections: the member reports Google Drive and Notion; only the enabled personal one counts
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3');
select pg_temp.check(public.member_integrations_sync('01KE00000000000000000000WA', array['google-drive', 'notion']) = 1, 'one connection recorded');
select pg_temp.check((select count(*) from public.member_integrations) = 1, 'the member reads their own row');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2');
select pg_temp.check((select count(*) from public.member_integrations) = 0, 'an admin does not read another member''s rows');
select pg_temp.check((select (r ->> 'connections')::int from jsonb_array_elements(public.workspace_integrations_admin('01KE00000000000000000000WA')) r where r ->> 'provider' = 'google-drive') = 1, 'the admin list counts connections');
select pg_temp.expect_error($$insert into public.member_integrations (user_id, integration_id) select auth.uid(), id from public.workspace_integrations limit 1$$, 'permission denied');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3');
select pg_temp.check(public.member_integrations_sync('01KE00000000000000000000WA', array[]::text[]) = 0, 'disconnecting clears the connection');

-- 8. validation: org without a secret, a short secret, a personal secret, an owner who is not a member, a bad scope
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select pg_temp.expect_error($$select public.workspace_integration_save('01KE00000000000000000000WA', 'slack', 'org', '{}', null)$$, 'needs an API key');
select pg_temp.expect_error($$select public.workspace_integration_save('01KE00000000000000000000WA', 'slack', 'org', '{}', 'short')$$, 'whole key');
select pg_temp.expect_error($$select public.workspace_integration_save('01KE00000000000000000000WA', 'slack', 'personal', '{}', 'secret_12345678')$$, 'no shared secret');
select pg_temp.expect_error($$select public.workspace_integration_save('01KE00000000000000000000WA', 'slack', 'org', '{"owner_id": "00000000-0000-4000-8000-0000000000e4"}', 'secret_12345678')$$, 'has to be a member');
select pg_temp.expect_error($$select public.workspace_integration_save('01KE00000000000000000000WA', 'slack', 'org', '{"scopes": ["chat write"]}', 'secret_12345678')$$, 'characters a scope');
select pg_temp.expect_error($$select public.workspace_integration_save('01KE00000000000000000000WA', 'Not Real!', 'personal', '{}', null)$$, 'not supported');
-- mock mode needs no secret
select pg_temp.check((public.workspace_integration_save('01KE00000000000000000000WA', 'slack', 'org', '{"mock": true}', null) ->> 'connections')::int = 1, 'mock mode counts as one shared connection');

-- 9. editing keeps the secret when none is given and keeps a disabled row disabled; switching to personal drops the
-- secret from Vault; removing drops the row
select pg_temp.check((public.workspace_integration_save('01KE00000000000000000000WA', 'notion', 'org', '{}', null) ->> 'enabled') = 'false', 'an edit keeps a disabled connector disabled');
select pg_temp.check((public.workspace_integration_save('01KE00000000000000000000WA', 'notion', 'org', '{"scopes": ["read", "write"]}', '') ->> 'secret_last4') = '1234', 'a blank secret keeps the stored one');
insert into out values ('notion2', public.workspace_integration_save('01KE00000000000000000000WA', 'notion', 'org', '{}', 'secret_NEWVALUE9876'));
select pg_temp.check((select v ->> 'secret_last4' from out where k = 'notion2') = '9876', 'a new secret replaces the stored one');
select pg_temp.as_admin_role();
create temp table old_secret as select secret_id from public.workspace_integrations where provider = 'notion';
select pg_temp.check((select s.decrypted_secret from vault.decrypted_secrets s where s.id = (select secret_id from old_secret)) = 'secret_NEWVALUE9876', 'Vault holds the new secret');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select public.workspace_integration_save('01KE00000000000000000000WA', 'notion', 'personal', '{}', null);
select pg_temp.as_admin_role();
select pg_temp.check(not exists (select 1 from vault.secrets where id = (select secret_id from old_secret)), 'switching to personal removes the Vault secret');
select pg_temp.check((select secret_id from public.workspace_integrations where provider = 'notion') is null, 'a personal row keeps no secret id');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
insert into out values ('slack', public.workspace_integration_save('01KE00000000000000000000WA', 'slack', 'org', '{}', 'secret_SLACKKEY5555'));
select pg_temp.as_admin_role();
truncate old_secret; insert into old_secret select secret_id from public.workspace_integrations where provider = 'slack';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select public.workspace_integration_remove((select (v ->> 'id') from out where k = 'slack'));
select pg_temp.as_admin_role();
select pg_temp.check(not exists (select 1 from vault.secrets where id = (select secret_id from old_secret)), 'removing a connector removes its Vault secret');

-- 10. the owner turns the switch off and on
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1');
select public.workspace_set_approved_connectors_only('01KE00000000000000000000WA', false);
select pg_temp.check(not (public.workspace_connector_policy('01KE00000000000000000000WA') ->> 'approved_only')::boolean, 'the owner turns the switch off');
select public.workspace_set_approved_connectors_only('01KE00000000000000000000WA', true);

select pg_temp.as_admin_role();
select 'workspace integrations: ok';
rollback;
