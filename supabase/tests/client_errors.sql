-- Page crash reports (migration 0045): the relay's writer groups events by fingerprint, counts each install once,
-- keeps at most 50 events per group, drops events older than 90 days, and moves a fixed group back to new when an
-- event comes from the fixed version or a newer one. The tables are closed to anon and authenticated; the admin
-- functions answer the platform owner only, and every status change is audited.
-- Needs a database with every migration applied (supabase db reset on a local stack). Runs in one transaction that is
-- rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/client_errors.sql
-- A failed check stops the script with the check's message; the last line printed on success is "client errors: ok".
begin;

-- the sign-up gate wants an access code; the rolled-back fixtures skip it
create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-0000000000f1', 'owner@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000f2', 'member@example.com', 'authenticated', 'authenticated');
insert into public.platform_owners (user_id) values ('00000000-0000-4000-8000-0000000000f1');

create function pg_temp.report(fp text, install text, ver text, rep boolean default false) returns jsonb language sql as $$
  select public.error_report_record(jsonb_build_object(
    'fingerprint', fp, 'install_hash', encode(extensions.digest(install, 'sha256'), 'hex'), 'workspace_id', null,
    'edition', 'local', 'version', ver, 'os', 'macOS 26.4 arm64', 'view', 'settings/connectors', 'kind', 'render',
    'repeat', rep, 'message', 'Cannot read properties of undefined', 'stack', 'src/ConnectorsPage.tsx:120:14',
    'component_stack', 'at ConnectorsPage', 'at', '2026-11-19T10:00:00Z'));
$$;

do $$
declare fp text := repeat('a', 64); g public.error_groups; r jsonb;
begin
  -- the version key orders versions as numbers
  if public.error_version_key('0.10.0') <= public.error_version_key('0.9.9') then raise exception '0.10.0 should sort above 0.9.9'; end if;
  if public.error_version_key('v1.2') <> array[1, 2, 0] or public.error_version_key('junk') <> array[0, 0, 0] then raise exception 'the version key should read v1.2 and junk'; end if;
  if public.error_version_key('0.4.2-beta.1') <> array[0, 4, 2] then raise exception 'the version key should ignore a suffix'; end if;

  perform pg_temp.report(fp, 'install-1', '0.4.1');
  perform pg_temp.report(fp, 'install-1', '0.4.2', true);
  perform pg_temp.report(fp, 'install-2', '0.4.10');
  select * into g from public.error_groups where fingerprint = fp;
  if g.events <> 3 or g.installs <> 2 or g.repeats <> 1 then raise exception 'events 3, installs 2, repeats 1 expected, got %, %, %', g.events, g.installs, g.repeats; end if;
  if g.versions <> array['0.4.10', '0.4.2', '0.4.1'] then raise exception 'versions should be distinct and newest first, got %', g.versions; end if;
  if g.editions <> array['local'] or g.status <> 'new' then raise exception 'editions and status are wrong'; end if;
  if exists (select 1 from public.error_events where install_hash !~ '^[0-9a-f]{64}$') then raise exception 'an event holds something other than a hash'; end if;

  -- at most 50 events per group, the newest kept; the counters keep counting
  for i in 1..55 loop perform pg_temp.report(fp, 'install-1', '0.4.2'); end loop;
  if (select count(*) from public.error_events where fingerprint = fp) <> 50 then raise exception 'a group should keep 50 events'; end if;
  if (select events from public.error_groups where fingerprint = fp) <> 58 then raise exception 'the event counter should keep counting'; end if;

  -- events older than 90 days go on the next insert
  update public.error_events set received_at = now() - interval '91 days' where id = (select min(id) from public.error_events where fingerprint = fp);
  perform pg_temp.report(fp, 'install-1', '0.4.2');
  if exists (select 1 from public.error_events where received_at < now() - interval '90 days') then raise exception 'events older than 90 days should be dropped'; end if;

  -- a fixed group stays fixed for an older version and goes back to new for the fixed version or newer
  update public.error_groups set status = 'fixed', fixed_in = '0.4.3' where fingerprint = fp;
  r := pg_temp.report(fp, 'install-1', '0.4.2');
  if (r->>'reopened')::boolean or (select status from public.error_groups where fingerprint = fp) <> 'fixed' then raise exception 'an older version should not reopen a fixed group'; end if;
  r := pg_temp.report(fp, 'install-3', '0.4.3');
  if not (r->>'reopened')::boolean or (select status from public.error_groups where fingerprint = fp) <> 'new' then raise exception 'the fixed version should reopen the group'; end if;
  if (select fixed_in from public.error_groups where fingerprint = fp) <> '0.4.3' then raise exception 'a reopened group keeps the version it was fixed in'; end if;
  if not exists (select 1 from public.platform_audit where action = 'error_reopened' and detail->>'fingerprint' = fp) then raise exception 'the reopen should be audited'; end if;

  -- closed to the app's roles: no table grants, and the writer is the service role's alone
  if has_table_privilege('anon', 'public.error_groups', 'select') or has_table_privilege('authenticated', 'public.error_events', 'select')
     or has_table_privilege('authenticated', 'public.error_groups', 'update') or has_table_privilege('authenticated', 'public.error_group_installs', 'select') then
    raise exception 'the error tables should be closed to anon and authenticated';
  end if;
  if has_function_privilege('anon', 'public.error_report_record(jsonb)', 'execute') or has_function_privilege('authenticated', 'public.error_report_record(jsonb)', 'execute') then
    raise exception 'only the service role should record reports';
  end if;
  if has_function_privilege('anon', 'public.admin_error_groups(text, integer, integer, text)', 'execute') then raise exception 'anon should not list error groups'; end if;
end $$;

-- a signed-in account that is not the owner is refused
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000000f2', 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);
do $$
begin
  begin perform public.admin_error_groups(); raise exception 'not refused'; exception when others then if sqlerrm <> 'Only the platform owner can do that' then raise exception 'a member should be refused the list, got: %', sqlerrm; end if; end;
  begin perform public.admin_error_set_status(repeat('a', 64), 'ignored'); raise exception 'not refused'; exception when others then if sqlerrm <> 'Only the platform owner can do that' then raise exception 'a member should be refused a status change, got: %', sqlerrm; end if; end;
end $$;

-- the owner lists, reads and triages
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000000f1', 'role', 'authenticated')::text, true);
do $$
declare fp text := repeat('a', 64); d jsonb; g public.error_groups;
begin
  if (select count(*) from public.admin_error_groups('new')) <> 1 or (select count(*) from public.admin_error_groups('ignored')) <> 0 then raise exception 'the status filter is wrong'; end if;
  if (public.admin_error_counts()->>'new')::integer <> 1 then raise exception 'the counts should show one new group'; end if;
  d := public.admin_error_group(fp);
  if jsonb_array_length(d->'events') <> 20 or d->'oses' <> '["macOS 26.4 arm64"]'::jsonb or (d->'group'->>'events')::integer < 50 then raise exception 'the detail should carry 20 events and the OS list'; end if;
  if (d->'events'->0) ? 'install_hash' then raise exception 'the detail should not carry install hashes'; end if;

  begin perform public.admin_error_set_status(fp, 'fixed'); raise exception 'not refused'; exception when others then if sqlerrm not like 'Fixed needs the version%' then raise exception 'fixed without a version should be refused, got: %', sqlerrm; end if; end;
  g := public.admin_error_set_status(fp, 'fixed', ' 0.4.4 ', ' Guarded the empty connector list ');
  if g.status <> 'fixed' or g.fixed_in <> '0.4.4' or g.note <> 'Guarded the empty connector list' then raise exception 'the status change did not land'; end if;
  g := public.admin_error_set_status(fp, 'ignored');
  if g.fixed_in is not null or g.note is not null then raise exception 'the version is kept with fixed only'; end if;
  if (select count(*) from public.platform_audit where action = 'error_status' and detail->>'fingerprint' = fp) <> 2 then raise exception 'each status change should be audited'; end if;
end $$;

select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
select 'client errors: ok';
rollback;
