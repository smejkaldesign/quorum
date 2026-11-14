-- applied-when: select exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = 'kb_attachments')
-- Connector folder sync into knowledge bases, and the server-side tokens it runs on (docs/specs/workspace-knowledge.md,
-- "Sources inside a KB", "Data model" and "Where sync runs"; the relay side is relay/kbSync/, the app side
-- app/ee/kbSync.js). Numbered 0032 because 0031 is reserved for KB suggestions.
--
-- kb_attachments: a KB admin attaches a remote folder or file (a Google Drive folder or file, a GitHub repository or a
-- folder in one) to a KB folder for background sync. The relay's sync worker reads it on a schedule and writes one
-- shared note per file into the KB, as the attaching admin's row, the same way app/ee/kbImport.js and app/ee/kbDrive.js
-- write notes (visibility public, kb_source naming the file, kb_id and folder_id set). Members' Macs receive the notes
-- through pull sync.
--
-- kb_sync_grants: the attaching admin's provider grant, held for the worker. The app sends the refresh token to the
-- relay once over TLS; the relay stores it here through kb_sync_attach, in Supabase Vault, and only secret_id is kept on
-- the row. No client role can read this table at all, and no function a client can call returns a token. The worker
-- reads the token with the service role through kb_sync_token.
--
-- Ending a grant. A grant ends when its admin disconnects the provider (kb_sync_disconnect), when the last attachment
-- using it is removed, when the admin leaves the workspace, or when the provider refuses it. An ended grant whose token
-- must also be revoked with the provider waits in the table with revoke_pending until the worker revokes it
-- (kb_sync_revocations, kb_sync_revoked); every other ended grant is deleted at once. Deleting a grant deletes its Vault
-- secret. A grant that is the same grant the admin's Mac holds (Google issues one grant per person and client, so
-- revoking it signs the Mac out of Google Drive and Calendar too) is revoked only when the admin disconnects.
--
-- Access. KB admins read their KB's attachments (every column but the worker's cursor and lease) and manage them through
-- the RPCs below. Attaching goes through the relay (it carries the token), so kb_sync_attach is for the service role.

create table public.kb_sync_grants (
  id public.ulid primary key default public.gen_ulid(),
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('google-drive', 'github')),
  -- which OAuth client issued the grant: Quorum's own app (the relay holds its client pair) or the workspace's own
  -- client from an org-mode workspace connector with auth oauth_client (0030; client id in config, secret in Vault)
  client text not null default 'quorum' check (client in ('quorum', 'workspace')),
  integration_id public.ulid references public.workspace_integrations (id) on delete set null,
  secret_id uuid,
  shared_with_mac boolean not null default false,
  account text check (account is null or char_length(account) <= 320),
  ended_at timestamptz,
  ended_reason text check (ended_reason is null or ended_reason in ('removed', 'disconnected', 'left', 'refused')),
  revoke_pending boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index kb_sync_grants_live on public.kb_sync_grants (workspace_id, user_id, provider) where ended_at is null;
create index kb_sync_grants_revoke on public.kb_sync_grants (ended_at) where revoke_pending;
create trigger kb_sync_grants_updated_at before update on public.kb_sync_grants for each row execute function public.set_updated_at();
alter table public.kb_sync_grants enable row level security;
-- no policy and no grant: a client reads nothing here, not even its own row
revoke all on public.kb_sync_grants from anon, authenticated;
grant select, insert, update, delete on public.kb_sync_grants to service_role;

create table public.kb_attachments (
  id public.ulid primary key default public.gen_ulid(),
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  kb_id public.ulid not null references public.knowledge_bases (id) on delete cascade,
  -- the KB folder the remote content lands in; null is the KB's top level
  folder_id public.ulid references public.kb_folders (id) on delete cascade,
  provider text not null check (provider in ('google-drive', 'github')),
  integration_id public.ulid references public.workspace_integrations (id) on delete set null,
  grant_id public.ulid references public.kb_sync_grants (id) on delete set null,
  -- Google Drive: the file or folder id. GitHub: owner/repository, with the branch and folder in options
  remote_id text not null check (char_length(remote_id) between 1 and 300),
  remote_kind text not null check (remote_kind in ('folder', 'file')),
  options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  url text check (url is null or char_length(url) <= 2000),
  attached_by uuid references auth.users (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'active', 'paused', 'error', 'needs_auth')),
  error text check (error is null or char_length(error) <= 500),
  note_count integer not null default 0,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  -- the worker's own state: the provider's change marker (a commit, a listing time) and the lease on a run
  cursor jsonb not null default '{}'::jsonb check (jsonb_typeof(cursor) = 'object'),
  next_run_at timestamptz not null default now(),
  failures integer not null default 0,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index kb_attachments_remote on public.kb_attachments (kb_id, provider, remote_id, coalesce(options ->> 'branch', ''), coalesce(options ->> 'path', ''));
create index kb_attachments_due on public.kb_attachments (next_run_at) where status in ('pending', 'active', 'error');
create index kb_attachments_grant on public.kb_attachments (grant_id);
create trigger kb_attachments_updated_at before update on public.kb_attachments for each row execute function public.set_updated_at();
alter table public.kb_attachments enable row level security;
create policy kb_attachments_select on public.kb_attachments for select to authenticated using (public.can_admin_kb(kb_id));
revoke all on public.kb_attachments from anon, authenticated;
grant select (id, workspace_id, kb_id, folder_id, provider, integration_id, remote_id, remote_kind, options, name, url, attached_by, status, error,
  note_count, last_synced_at, last_attempt_at, next_run_at, created_at, updated_at) on public.kb_attachments to authenticated;
grant select, insert, update, delete on public.kb_attachments to service_role;

-- the one check every service-role function makes: the API sets the claims; a direct database session (migrations,
-- tests) has none and is trusted when it is the superuser (the same rule as relay_connector_secret, 0007)
create or replace function public.kb_sync_service_only() returns void
language plpgsql stable security definer set search_path = public as $$
declare jwt_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
begin
  if jwt_role is distinct from 'service_role' and not (jwt_role is null and session_user in ('postgres', 'supabase_admin')) then
    raise exception 'Only the relay may do this';
  end if;
end $$;
revoke all on function public.kb_sync_service_only() from public, anon, authenticated;

-- can_admin_kb for a given person instead of the caller: the worker runs with no session
create or replace function public.can_admin_kb_as(kb_id public.ulid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select uid is not null and exists (
    select 1 from public.knowledge_bases k
    join public.members m on m.workspace_id = k.workspace_id and m.user_id = uid and m.deleted_at is null
    where k.id = can_admin_kb_as.kb_id and (
      m.role in ('owner', 'admin')
      or exists (select 1 from public.kb_access a where a.kb_id = k.id and a.role = 'admin' and (a.principal = 'workspace' or (a.principal = 'user' and a.user_id = uid)))
    )
  );
$$;
revoke all on function public.can_admin_kb_as(public.ulid, uuid) from public, anon, authenticated;

-- a deleted grant takes its Vault secret with it, and so does a replaced secret
create or replace function public.kb_sync_grant_drop_secret() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.secret_id is not null then delete from vault.secrets s where s.id = old.secret_id; end if;
    return old;
  end if;
  if old.secret_id is not null and new.secret_id is distinct from old.secret_id then delete from vault.secrets s where s.id = old.secret_id; end if;
  return new;
end $$;
create trigger kb_sync_grants_drop_secret after delete or update of secret_id on public.kb_sync_grants for each row execute function public.kb_sync_grant_drop_secret();
revoke all on function public.kb_sync_grant_drop_secret() from public, anon, authenticated;

-- ends a grant: deleted at once, or kept with revoke_pending until the worker has revoked it with the provider. Its
-- attachments wait for an admin to attach them again
create or replace function public.kb_sync_grant_end(gid public.ulid, reason text, do_revoke boolean) returns void
language plpgsql security definer set search_path = public as $$
declare g public.kb_sync_grants;
begin
  select * into g from public.kb_sync_grants x where x.id = gid and x.ended_at is null for update;
  if g.id is null then return; end if;
  update public.kb_attachments a set status = 'needs_auth', lease_until = null,
    error = case reason
      when 'left' then 'The admin who attached this left the workspace. Another admin can attach it again.'
      when 'disconnected' then 'The admin who attached this disconnected the account. Attach it again to keep it in sync.'
      when 'refused' then 'The provider no longer accepts this connection. Attach it again to keep it in sync.'
      else a.error end
    where a.grant_id = g.id and a.status <> 'paused';
  if do_revoke and g.secret_id is not null then
    update public.kb_sync_grants x set ended_at = now(), ended_reason = reason, revoke_pending = true where x.id = g.id;
  else
    delete from public.kb_sync_grants x where x.id = g.id;
  end if;
end $$;
revoke all on function public.kb_sync_grant_end(public.ulid, text, boolean) from public, anon, authenticated;

-- whether ending a grant for this reason also revokes it: a grant of its own always; a grant the Mac shares only when
-- the admin disconnects (the Mac revokes it then as well)
create or replace function public.kb_sync_revokes(g public.kb_sync_grants, reason text) returns boolean
language sql immutable set search_path = public as $$
  select not g.shared_with_mac or reason = 'disconnected';
$$;
revoke all on function public.kb_sync_revokes(public.kb_sync_grants, text) from public, anon, authenticated;

-- removing the last attachment on a grant ends the grant
create or replace function public.kb_attachment_gone() returns trigger
language plpgsql security definer set search_path = public as $$
declare g public.kb_sync_grants;
begin
  if old.grant_id is null then return old; end if;
  if exists (select 1 from public.kb_attachments a where a.grant_id = old.grant_id and a.id <> old.id) then return old; end if;
  select * into g from public.kb_sync_grants x where x.id = old.grant_id;
  if g.id is not null then perform public.kb_sync_grant_end(g.id, 'removed', public.kb_sync_revokes(g, 'removed')); end if;
  return old;
end $$;
create trigger kb_attachments_gone after delete on public.kb_attachments for each row execute function public.kb_attachment_gone();
revoke all on function public.kb_attachment_gone() from public, anon, authenticated;

-- a member who leaves the workspace takes their grants with them
create or replace function public.member_left_end_kb_grants() returns trigger
language plpgsql security definer set search_path = public as $$
declare u uuid; ws public.ulid; g public.kb_sync_grants;
begin
  if tg_op = 'DELETE' then u := old.user_id; ws := old.workspace_id;
  elsif old.deleted_at is null and new.deleted_at is not null then u := new.user_id; ws := new.workspace_id;
  else return new;
  end if;
  for g in select * from public.kb_sync_grants x where x.workspace_id = ws and x.user_id = u and x.ended_at is null loop
    perform public.kb_sync_grant_end(g.id, 'left', public.kb_sync_revokes(g, 'left'));
  end loop;
  return coalesce(new, old);
end $$;
create trigger members_end_kb_grants after update of deleted_at or delete on public.members for each row execute function public.member_left_end_kb_grants();
revoke all on function public.member_left_end_kb_grants() from public, anon, authenticated;

-- an attachment as an admin sees it
create or replace function public.kb_attachment_row(a public.kb_attachments) returns jsonb
language sql stable security definer set search_path = public as $$
  select (to_jsonb(a) - 'cursor' - 'lease_until' - 'failures' - 'grant_id') || jsonb_build_object(
    'connected', a.grant_id is not null,
    'attached_by_email', (select p.email from public.profiles p where p.user_id = a.attached_by),
    'account', (select g.account from public.kb_sync_grants g where g.id = a.grant_id));
$$;
revoke all on function public.kb_attachment_row(public.kb_attachments) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- RPCs for KB admins (authenticated)

create or replace function public.kb_attachments_list(kb_id public.ulid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_admin_kb(kb_attachments_list.kb_id) then raise exception 'Only the knowledge base''s admins can see its synced folders'; end if;
  return coalesce((select jsonb_agg(public.kb_attachment_row(a) order by a.created_at) from public.kb_attachments a where a.kb_id = kb_attachments_list.kb_id), '[]'::jsonb);
end $$;

create or replace function public.kb_attachment_of(id public.ulid) returns public.kb_attachments
language plpgsql stable security definer set search_path = public as $$
declare a public.kb_attachments;
begin
  select * into a from public.kb_attachments x where x.id = kb_attachment_of.id;
  if a.id is null or not public.can_admin_kb(a.kb_id) then raise exception 'That synced folder no longer exists'; end if;
  return a;
end $$;
revoke all on function public.kb_attachment_of(public.ulid) from public, anon, authenticated;

-- Pause stops the schedule and keeps the notes; Resume runs it again now
create or replace function public.kb_attachment_pause(id public.ulid, paused boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.kb_attachments := public.kb_attachment_of(kb_attachment_pause.id);
begin
  if coalesce(kb_attachment_pause.paused, true) then
    update public.kb_attachments x set status = 'paused', lease_until = null where x.id = a.id returning * into a;
  elsif a.status = 'paused' then
    update public.kb_attachments x set status = case when x.grant_id is null then 'needs_auth' else 'pending' end, next_run_at = now(), failures = 0
      where x.id = a.id returning * into a;
  end if;
  return public.kb_attachment_row(a);
end $$;

create or replace function public.kb_attachment_sync_now(id public.ulid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.kb_attachments := public.kb_attachment_of(kb_attachment_sync_now.id);
begin
  if a.status = 'paused' then raise exception 'Resume it first'; end if;
  if a.grant_id is null then raise exception 'Attach it again to keep it in sync'; end if;
  update public.kb_attachments x set next_run_at = now(), failures = 0, status = case when x.status = 'error' then 'pending' else x.status end
    where x.id = a.id returning * into a;
  return public.kb_attachment_row(a);
end $$;

-- Remove: the attachment goes, and its notes leave the KB and every vault (soft deleted, as kbImport removes notes a
-- source no longer has). The last attachment on a grant ends the grant.
create or replace function public.kb_attachment_remove(id public.ulid) returns integer
language plpgsql security definer set search_path = public as $$
declare a public.kb_attachments := public.kb_attachment_of(kb_attachment_remove.id); n integer;
begin
  update public.notes x set deleted_at = now(), updated_at = now()
    where x.kb_id = a.kb_id and x.deleted_at is null and x.frontmatter ->> 'kb_attachment' = a.id::text;
  get diagnostics n = row_count;
  delete from public.kb_attachments x where x.id = a.id;
  return n;
end $$;

-- the caller disconnected the provider on their Mac: their grants for it end and are revoked
create or replace function public.kb_sync_disconnect(workspace_id public.ulid, provider text) returns integer
language plpgsql security definer set search_path = public as $$
declare g public.kb_sync_grants; n integer := 0;
begin
  if auth.uid() is null or not public.is_member(kb_sync_disconnect.workspace_id) then raise exception 'You are not a member of that workspace'; end if;
  for g in select * from public.kb_sync_grants x where x.workspace_id = kb_sync_disconnect.workspace_id and x.user_id = auth.uid()
      and x.provider = kb_sync_disconnect.provider and x.ended_at is null loop
    perform public.kb_sync_grant_end(g.id, 'disconnected', true);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- service-role functions for the relay

-- attach: called by the relay after it checked the caller's session and refreshed the token once with the provider.
-- token: the refresh token to hold (null keeps the caller's live grant for the provider, which must exist). A new token
-- replaces the one stored on the caller's live grant, and that grant's attachments waiting for a sign-in run again.
create or replace function public.kb_sync_attach(uid uuid, kb_id public.ulid, folder_id public.ulid, provider text, remote_id text, remote_kind text,
  options jsonb, name text, url text, token text default null, client text default 'quorum', shared_with_mac boolean default false, account text default null) returns jsonb
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
begin
  perform public.kb_sync_service_only();
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
    -- a token from another client cannot refresh under the stored one: the old grant ends and a new one starts
    perform public.kb_sync_grant_end(g.id, 'removed', public.kb_sync_revokes(g, 'removed'));
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

  select * into a from public.kb_attachments x where x.kb_id = k.id and x.provider = p and x.remote_id = rid
    and coalesce(x.options ->> 'branch', '') = coalesce(opts ->> 'branch', '') and coalesce(x.options ->> 'path', '') = coalesce(opts ->> 'path', '');
  if a.id is not null then
    -- attaching the same item again moves it under this admin's grant and runs it now
    update public.kb_attachments x set grant_id = g.id, attached_by = uid, integration_id = integ.id, status = 'pending', error = null, next_run_at = now(), failures = 0,
      name = coalesce(nullif(btrim(kb_sync_attach.name), ''), x.name), url = coalesce(kb_sync_attach.url, x.url)
      where x.id = a.id returning * into a;
  else
    insert into public.kb_attachments (workspace_id, kb_id, folder_id, provider, integration_id, grant_id, remote_id, remote_kind, options, name, url, attached_by)
      values (w.id, k.id, kb_sync_attach.folder_id, p, integ.id, g.id, rid, kb_sync_attach.remote_kind, opts, left(coalesce(nullif(btrim(kb_sync_attach.name), ''), rid), 200), kb_sync_attach.url, uid)
      returning * into a;
  end if;
  return public.kb_attachment_row(a);
end $$;

-- the worker takes up to max_rows attachments that are due, each under a lease so a second relay instance skips them.
-- per_workspace caps how many run at once in one workspace. An attachment whose admin is no longer an admin of the KB,
-- or whose connector the workspace turned off, is set aside with a sentence instead. Each row carries what a run needs:
-- the KB name and its folders and the attaching admin (never the token)
create or replace function public.kb_sync_claim(max_rows integer default 20, lease_seconds integer default 600, per_workspace integer default 2) returns jsonb
language plpgsql security definer set search_path = public as $$
declare out jsonb := '[]'::jsonb; a public.kb_attachments;
begin
  perform public.kb_sync_service_only();
  for a in
    select x.* from public.kb_attachments x
    where x.status in ('pending', 'active', 'error') and x.next_run_at <= now() and (x.lease_until is null or x.lease_until < now())
    order by x.next_run_at limit greatest(1, least(coalesce(max_rows, 20), 200))
    for update skip locked
  loop
    if a.grant_id is null then
      update public.kb_attachments x set status = 'needs_auth', error = coalesce(x.error, 'Attach it again to keep it in sync.') where x.id = a.id;
      continue;
    end if;
    if not public.can_admin_kb_as(a.kb_id, a.attached_by) then
      update public.kb_attachments x set status = 'needs_auth', error = 'The admin who attached this is no longer an admin of the knowledge base. Another admin can attach it again.' where x.id = a.id;
      continue;
    end if;
    if exists (select 1 from public.workspace_integrations i where i.workspace_id = a.workspace_id and i.provider = a.provider and not i.enabled) then
      update public.kb_attachments x set status = 'error', error = 'This connector is turned off for the workspace.', next_run_at = now() + interval '1 hour' where x.id = a.id;
      continue;
    end if;
    if exists (select 1 from public.workspaces w where w.id = a.workspace_id and (w.deleted_at is not null or w.plan = 'free')) then
      update public.kb_attachments x set status = 'error', error = 'This workspace has no Quorum Cloud subscription, so syncing is paused.', next_run_at = now() + interval '6 hours' where x.id = a.id;
      continue;
    end if;
    -- the per-workspace cap counts runs under a lease right now, on every relay instance, this claim included
    if (select count(*) from public.kb_attachments y where y.workspace_id = a.workspace_id and y.lease_until > now()) >= greatest(1, coalesce(per_workspace, 2)) then continue; end if;
    update public.kb_attachments x set lease_until = now() + make_interval(secs => greatest(60, coalesce(lease_seconds, 600))), last_attempt_at = now()
      where x.id = a.id returning * into a;
    out := out || jsonb_build_array(to_jsonb(a) || jsonb_build_object(
      'kb_name', (select k.name from public.knowledge_bases k where k.id = a.kb_id),
      'folders', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'parent_id', f.parent_id, 'name', f.name)) from public.kb_folders f where f.kb_id = a.kb_id), '[]'::jsonb)));
  end loop;
  return out;
end $$;

-- the token behind an attachment's grant, and the client pair when the workspace's own client issued it. The relay
-- passes it to the provider and nowhere else
create or replace function public.kb_sync_token(attachment_id public.ulid) returns table (grant_id public.ulid, provider text, client text, refresh_token text, client_id text, client_secret text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.kb_sync_service_only();
  return query
    select g.id, g.provider, g.client, s.decrypted_secret,
      case when g.client = 'workspace' then i.config ->> 'client_id' end,
      case when g.client = 'workspace' then (select v.decrypted_secret from vault.decrypted_secrets v where v.id = i.secret_id) end
    from public.kb_attachments a
    join public.kb_sync_grants g on g.id = a.grant_id and g.ended_at is null
    join vault.decrypted_secrets s on s.id = g.secret_id
    left join public.workspace_integrations i on i.id = g.integration_id
    where a.id = kb_sync_token.attachment_id;
end $$;

-- the workspace's own OAuth client for a provider, for the relay to check a token before an attach stores it
create or replace function public.relay_workspace_oauth_client(workspace_id public.ulid, provider text) returns table (client_id text, client_secret text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.kb_sync_service_only();
  return query
    select i.config ->> 'client_id', v.decrypted_secret
    from public.workspace_integrations i join vault.decrypted_secrets v on v.id = i.secret_id
    where i.workspace_id = relay_workspace_oauth_client.workspace_id and i.provider = relay_workspace_oauth_client.provider
      and i.enabled and i.mode = 'org' and i.config ->> 'auth' = 'oauth_client';
end $$;

-- a provider that rotates refresh tokens (GitHub) hands out a new one on each refresh; it replaces the stored one
create or replace function public.kb_sync_token_store(grant_id public.ulid, token text) returns void
language plpgsql security definer set search_path = public as $$
declare g public.kb_sync_grants;
begin
  perform public.kb_sync_service_only();
  select * into g from public.kb_sync_grants x where x.id = kb_sync_token_store.grant_id and x.ended_at is null;
  if g.id is null or g.secret_id is null then raise exception 'That grant has ended'; end if;
  if coalesce(token, '') = '' or char_length(token) > 4096 then raise exception 'That token is not valid'; end if;
  perform vault.update_secret(g.secret_id, token);
end $$;

-- the provider refused the grant: it ends (with no revoke, as the provider already dropped it)
create or replace function public.kb_sync_grant_refused(grant_id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.kb_sync_service_only();
  perform public.kb_sync_grant_end(kb_sync_grant_refused.grant_id, 'refused', false);
end $$;

-- the end of one run. ok: synced, so status active, the cursor stored and the failure count reset. Otherwise status
-- error with the sentence, and the next try after retry_seconds. needs_auth marks a sign-in problem instead
create or replace function public.kb_sync_finish(attachment_id public.ulid, ok boolean, message text default null, cur jsonb default null,
  note_count integer default null, retry_seconds integer default 900, needs_auth boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.kb_sync_service_only();
  update public.kb_attachments x set
    status = case when x.status = 'paused' then 'paused' when kb_sync_finish.needs_auth then 'needs_auth' when kb_sync_finish.ok then 'active' else 'error' end,
    error = case when kb_sync_finish.ok then nullif(left(coalesce(kb_sync_finish.message, ''), 500), '') else left(coalesce(kb_sync_finish.message, 'The sync failed.'), 500) end,
    cursor = coalesce(kb_sync_finish.cur, x.cursor),
    note_count = coalesce(kb_sync_finish.note_count, x.note_count),
    last_synced_at = case when kb_sync_finish.ok then now() else x.last_synced_at end,
    failures = case when kb_sync_finish.ok then 0 else x.failures + 1 end,
    next_run_at = now() + make_interval(secs => greatest(30, coalesce(kb_sync_finish.retry_seconds, 900))),
    lease_until = null
  where x.id = kb_sync_finish.attachment_id;
end $$;

-- ended grants waiting to be revoked with the provider, with their tokens; kb_sync_revoked deletes one after the revoke
create or replace function public.kb_sync_revocations(max_rows integer default 20) returns table (grant_id public.ulid, provider text, client text, refresh_token text, client_id text, client_secret text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.kb_sync_service_only();
  return query
    select g.id, g.provider, g.client, s.decrypted_secret,
      case when g.client = 'workspace' then i.config ->> 'client_id' end,
      case when g.client = 'workspace' then (select v.decrypted_secret from vault.decrypted_secrets v where v.id = i.secret_id) end
    from public.kb_sync_grants g
    join vault.decrypted_secrets s on s.id = g.secret_id
    left join public.workspace_integrations i on i.id = g.integration_id
    where g.revoke_pending order by g.ended_at limit greatest(1, least(coalesce(max_rows, 20), 200));
end $$;

create or replace function public.kb_sync_revoked(grant_id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.kb_sync_service_only();
  delete from public.kb_sync_grants x where x.id = kb_sync_revoked.grant_id and x.revoke_pending;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'kb_attachments_list(public.ulid)',
    'kb_attachment_pause(public.ulid, boolean)',
    'kb_attachment_sync_now(public.ulid)',
    'kb_attachment_remove(public.ulid)',
    'kb_sync_disconnect(public.ulid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'kb_sync_attach(uuid, public.ulid, public.ulid, text, text, text, jsonb, text, text, text, text, boolean, text)',
    'kb_sync_claim(integer, integer, integer)',
    'kb_sync_token(public.ulid)',
    'kb_sync_token_store(public.ulid, text)',
    'kb_sync_grant_refused(public.ulid)',
    'kb_sync_finish(public.ulid, boolean, text, jsonb, integer, integer, boolean)',
    'kb_sync_revocations(integer)',
    'kb_sync_revoked(public.ulid)',
    'relay_workspace_oauth_client(public.ulid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
