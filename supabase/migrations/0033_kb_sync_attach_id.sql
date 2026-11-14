-- applied-when: select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'kb_attachments' and column_name = 'attach_id')
-- Connector folder sync, second step (0032 is applied in production; the app side is app/ee/kbSync.js).
--
-- 1. Idempotent attach. The app names each attach with an id it makes (attach_id). kb_sync_attach with an id it has
--    seen answers the attachment that id made and changes nothing, so an attach the relay received but whose answer
--    timed out can be sent again, and the app can find it in the list by that id. kb_sync_attachment_by_attach_id lets
--    the relay answer a retry before it touches the token again (a GitHub refresh token works once).
-- 2. The relay's own grants, for the person who holds them. A GitHub sign-in for synced folders is a grant only the
--    relay holds (the GitHub App rotates refresh tokens, so the Mac cannot share it), so Settings, Connections lists it
--    as "GitHub (synced folders)" with Disconnect. kb_sync_my_grants lists the caller's live grants with the
--    attachments that use them, never a token; kb_sync_grant_disconnect ends one (the worker revokes the relay's token
--    with GitHub) and pauses or removes its attachments.

alter table public.kb_attachments add column attach_id text check (attach_id is null or char_length(attach_id) between 8 and 80);
create unique index kb_attachments_attach_id on public.kb_attachments (attach_id) where attach_id is not null;
grant select (attach_id) on public.kb_attachments to authenticated;

drop function public.kb_sync_attach(uuid, public.ulid, public.ulid, text, text, text, jsonb, text, text, text, text, boolean, text);
create or replace function public.kb_sync_attach(uid uuid, kb_id public.ulid, folder_id public.ulid, provider text, remote_id text, remote_kind text,
  options jsonb, name text, url text, token text default null, client text default 'quorum', shared_with_mac boolean default false, account text default null,
  attach_id text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  k public.knowledge_bases;
  w public.workspaces;
  integ public.workspace_integrations;
  g public.kb_sync_grants;
  a public.kb_attachments;
  p text := lower(trim(coalesce(kb_sync_attach.provider, '')));
  rid text := trim(coalesce(kb_sync_attach.remote_id, ''));
  tok text := coalesce(kb_sync_attach.token, '');
  opts jsonb := coalesce(kb_sync_attach.options, '{}'::jsonb);
  sid uuid;
  old_grant public.kb_sync_grants;
begin
  perform public.kb_sync_service_only();
  -- the same attach sent again (a retry after a timeout) answers the attachment it made, and changes nothing
  if kb_sync_attach.attach_id is not null then
    if char_length(kb_sync_attach.attach_id) > 80 then raise exception 'That attach id is too long'; end if;
    select * into a from public.kb_attachments x where x.attach_id = kb_sync_attach.attach_id;
    if a.id is not null then
      if a.attached_by is distinct from uid then raise exception 'That attach id is taken'; end if;
      return public.kb_attachment_row(a);
    end if;
  end if;
  select * into k from public.knowledge_bases x where x.id = kb_sync_attach.kb_id;
  if k.id is null then raise exception 'That knowledge base no longer exists'; end if;
  if not public.can_admin_kb_as(k.id, uid) then raise exception 'Only the knowledge base''s admins can sync folders into it'; end if;
  if kb_sync_attach.folder_id is not null and not exists (select 1 from public.kb_folders f where f.id = kb_sync_attach.folder_id and f.kb_id = k.id) then
    raise exception 'That folder is not in this knowledge base';
  end if;
  if p not in ('google-drive', 'github') then raise exception 'That connector cannot sync folders yet'; end if;
  if kb_sync_attach.remote_kind not in ('folder', 'file') then raise exception 'Pick a folder or a file'; end if;
  if p = 'github' and kb_sync_attach.remote_kind <> 'folder' then raise exception 'A GitHub repository syncs as a folder'; end if;
  if rid = '' or char_length(rid) > 300 then raise exception 'That item could not be read'; end if;
  if p = 'github' and rid !~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$' then raise exception 'That repository address is not valid'; end if;
  if jsonb_typeof(opts) <> 'object' then raise exception 'The sync options must be an object'; end if;
  opts := jsonb_strip_nulls(jsonb_build_object('branch', nullif(trim(coalesce(opts ->> 'branch', '')), ''), 'path', nullif(trim(both '/' from coalesce(opts ->> 'path', '')), '')));
  if coalesce(kb_sync_attach.client, 'quorum') not in ('quorum', 'workspace') then raise exception 'Unknown OAuth client'; end if;
  if char_length(tok) > 4096 then raise exception 'That token is too long'; end if;

  select * into w from public.workspaces x where x.id = k.workspace_id and x.deleted_at is null;
  if w.id is null then raise exception 'That workspace no longer exists'; end if;
  select * into integ from public.workspace_integrations x where x.workspace_id = w.id and x.provider = p;
  if integ.id is not null and not integ.enabled then raise exception 'This connector is turned off for the workspace'; end if;
  if integ.id is null and w.team_enabled and w.approved_connectors_only then
    raise exception 'Your workspace allows only connectors an admin approved. Ask an owner or admin to enable this one.';
  end if;
  if kb_sync_attach.client = 'workspace' and (integ.id is null or integ.mode <> 'org' or coalesce(integ.config ->> 'auth', '') <> 'oauth_client' or integ.secret_id is null) then
    raise exception 'The workspace has no OAuth client for this connector';
  end if;

  select * into g from public.kb_sync_grants x where x.workspace_id = w.id and x.user_id = uid and x.provider = p and x.ended_at is null for update;
  if tok = '' and g.id is null then raise exception 'Sign in to the provider first'; end if;
  if tok <> '' and g.id is not null and (g.client <> kb_sync_attach.client) then
    -- a token from another client cannot refresh under the stored one: a new grant starts, the admin's other
    -- attachments move to it, and the old grant then ends (revoked when it is a grant of its own)
    old_grant := g;
    update public.kb_sync_grants x set ended_at = now(), ended_reason = 'removed' where x.id = g.id;
    g := null;
  end if;
  if tok <> '' and g.id is not null then
    perform vault.update_secret(g.secret_id, tok);
    update public.kb_sync_grants x set account = coalesce(kb_sync_attach.account, x.account), shared_with_mac = coalesce(kb_sync_attach.shared_with_mac, x.shared_with_mac),
      integration_id = integ.id where x.id = g.id returning * into g;
    update public.kb_attachments x set status = 'pending', error = null, next_run_at = now(), failures = 0 where x.grant_id = g.id and x.status = 'needs_auth';
  elsif tok <> '' then
    insert into public.kb_sync_grants (workspace_id, user_id, provider, client, integration_id, shared_with_mac, account)
      values (w.id, uid, p, coalesce(kb_sync_attach.client, 'quorum'), integ.id, coalesce(kb_sync_attach.shared_with_mac, false), kb_sync_attach.account)
      returning * into g;
    sid := vault.create_secret(tok, 'kb_sync_grant:' || g.id, p || ' sync grant in workspace ' || w.id);
    update public.kb_sync_grants x set secret_id = sid where x.id = g.id returning * into g;
  end if;
  if old_grant.id is not null then
    update public.kb_attachments x set grant_id = g.id, status = case when x.status = 'paused' then x.status else 'pending' end, next_run_at = now(), failures = 0
      where x.grant_id = old_grant.id;
    if public.kb_sync_revokes(old_grant, 'removed') and old_grant.secret_id is not null then
      update public.kb_sync_grants x set revoke_pending = true, revoke_after = now() where x.id = old_grant.id;
    else
      delete from public.kb_sync_grants x where x.id = old_grant.id;
    end if;
  end if;

  select * into a from public.kb_attachments x where x.kb_id = k.id and x.provider = p and x.remote_id = rid
    and coalesce(x.options ->> 'branch', '') = coalesce(opts ->> 'branch', '') and coalesce(x.options ->> 'path', '') = coalesce(opts ->> 'path', '');
  if a.id is not null then
    -- attaching the same item again moves it under this admin's grant and runs it now
    update public.kb_attachments x set grant_id = g.id, attached_by = uid, integration_id = integ.id, status = 'pending', error = null, next_run_at = now(), failures = 0,
      attach_id = coalesce(kb_sync_attach.attach_id, x.attach_id),
      name = coalesce(nullif(btrim(kb_sync_attach.name), ''), x.name), url = coalesce(kb_sync_attach.url, x.url)
      where x.id = a.id returning * into a;
  else
    insert into public.kb_attachments (workspace_id, kb_id, folder_id, provider, integration_id, grant_id, remote_id, remote_kind, options, name, url, attached_by, attach_id)
      values (w.id, k.id, kb_sync_attach.folder_id, p, integ.id, g.id, rid, kb_sync_attach.remote_kind, opts, left(coalesce(nullif(btrim(kb_sync_attach.name), ''), rid), 200), kb_sync_attach.url, uid, kb_sync_attach.attach_id)
      returning * into a;
  end if;
  return public.kb_attachment_row(a);
end $$;
revoke all on function public.kb_sync_attach(uuid, public.ulid, public.ulid, text, text, text, jsonb, text, text, text, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.kb_sync_attach(uuid, public.ulid, public.ulid, text, text, text, jsonb, text, text, text, text, boolean, text, text) to service_role;

create or replace function public.kb_sync_attachment_by_attach_id(uid uuid, attach_id text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a public.kb_attachments;
begin
  perform public.kb_sync_service_only();
  select * into a from public.kb_attachments x where x.attach_id = kb_sync_attachment_by_attach_id.attach_id and x.attached_by = uid;
  return case when a.id is null then null else public.kb_attachment_row(a) end;
end $$;
revoke all on function public.kb_sync_attachment_by_attach_id(uuid, text) from public, anon, authenticated;
grant execute on function public.kb_sync_attachment_by_attach_id(uuid, text) to service_role;

-- the caller's live grants in a workspace: provider, account label, when it was made, whether the Mac shares it, and the
-- attachments using it (with their KB). Never a token
create or replace function public.kb_sync_my_grants(workspace_id public.ulid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_member(kb_sync_my_grants.workspace_id) then raise exception 'You are not a member of that workspace'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'provider', g.provider, 'account', g.account, 'created_at', g.created_at, 'shared_with_mac', g.shared_with_mac,
      'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kb_id', a.kb_id, 'kb_name', k.name, 'status', a.status) order by k.name, a.name)
        from public.kb_attachments a join public.knowledge_bases k on k.id = a.kb_id where a.grant_id = g.id), '[]'::jsonb)) order by g.provider)
    from public.kb_sync_grants g
    where g.workspace_id = kb_sync_my_grants.workspace_id and g.user_id = auth.uid() and g.ended_at is null), '[]'::jsonb);
end $$;

-- Disconnect for a grant the relay holds: the caller's live grant for the provider ends (revoked with the provider when
-- it is a grant of its own), and its attachments are paused (their notes stay) or removed (their notes leave the KB;
-- only in KBs the caller still administers, the rest are paused). Returns how many attachments were paused and removed
create or replace function public.kb_sync_grant_disconnect(workspace_id public.ulid, provider text, mode text default 'pause') returns jsonb
language plpgsql security definer set search_path = public as $$
declare g public.kb_sync_grants; a public.kb_attachments; paused integer := 0; removed integer := 0;
begin
  if auth.uid() is null or not public.is_member(kb_sync_grant_disconnect.workspace_id) then raise exception 'You are not a member of that workspace'; end if;
  if coalesce(kb_sync_grant_disconnect.mode, '') not in ('pause', 'remove') then raise exception 'Pick pause or remove'; end if;
  select * into g from public.kb_sync_grants x where x.workspace_id = kb_sync_grant_disconnect.workspace_id and x.user_id = auth.uid()
    and x.provider = kb_sync_grant_disconnect.provider and x.ended_at is null for update;
  if g.id is null then raise exception 'That connection is no longer there'; end if;
  for a in select * from public.kb_attachments x where x.grant_id = g.id loop
    if kb_sync_grant_disconnect.mode = 'remove' and public.can_admin_kb(a.kb_id) then
      update public.notes n set deleted_at = now(), updated_at = now()
        where n.kb_id = a.kb_id and n.deleted_at is null and n.frontmatter ? 'kb_attachment' and n.frontmatter ->> 'kb_attachment' = a.id::text;
      delete from public.kb_attachments x where x.id = a.id;
      removed := removed + 1;
    else
      update public.kb_attachments x set status = 'paused', paused_by = 'admin', lease_until = null,
        error = 'Paused because its sign-in was disconnected. Attach it again to keep it in sync.' where x.id = a.id;
      paused := paused + 1;
    end if;
  end loop;
  -- the last removal may have ended the grant already; otherwise it ends here
  if exists (select 1 from public.kb_sync_grants x where x.id = g.id and x.ended_at is null) then
    perform public.kb_sync_grant_end(g.id, 'disconnected', public.kb_sync_revokes(g, 'disconnected'));
  end if;
  return jsonb_build_object('paused', paused, 'removed', removed);
end $$;

do $$
declare f text;
begin
  foreach f in array array['kb_sync_my_grants(public.ulid)', 'kb_sync_grant_disconnect(public.ulid, text, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
