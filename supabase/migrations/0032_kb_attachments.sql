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
-- revoking it signs the Mac out of Google Drive and Calendar too) is deleted without a revoke; the Mac's Disconnect
-- revokes it with Google when nothing else on the Mac uses it.
--
-- Access. KB admins read their KB's attachments (every column but the worker's cursor and lease) and manage them through
-- the RPCs below. Attaching goes through the relay (it carries the token), so kb_sync_attach is for the service role.
--
-- Plans. When a workspace's plan ends (back to free) its attachments are paused with the reason "The workspace's plan
-- ended"; when the plan is active again the ones the plan paused resume. A pause an admin made stays.
--
-- Suggestions. The worker writes synced notes and their upstream bases through 0031 (kb_synced_notes_write,
-- kb_upstream_save), run as the attaching admin by kb_sync_notes_write and kb_sync_upstream_save, so an edit Quorum made
-- to a worker-synced note is kept as a suggestion the same way kbImport and kbDrive keep one.

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
  -- the provider revoke of an ended grant: tries so far, when the next try is due, and when the worker gave up (the
  -- Vault secret is deleted then anyway, and the row stays as the record that the provider revoke failed)
  revoke_attempts integer not null default 0,
  revoke_after timestamptz,
  revoke_failed_at timestamptz,
  -- one refresh at a time per grant across relay processes: a rotated refresh token works once
  refresh_owner text,
  refresh_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index kb_sync_grants_live on public.kb_sync_grants (workspace_id, user_id, provider) where ended_at is null;
create index kb_sync_grants_revoke on public.kb_sync_grants (revoke_after, ended_at) where revoke_pending;
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
  -- who paused it: an admin, or the plan ending (the workspace's plan went back to free); a plan pause ends on its own
  paused_by text check (paused_by is null or paused_by in ('admin', 'plan')),
  error text check (error is null or char_length(error) <= 500),
  note_count integer not null default 0,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  -- the worker's own state: the provider's change marker (a commit, a listing time) and the lease on a run
  cursor jsonb not null default '{}'::jsonb check (jsonb_typeof(cursor) = 'object'),
  next_run_at timestamptz not null default now(),
  failures integer not null default 0,
  lease_until timestamptz,
  -- the worker process holding the lease; renewals and the end of a run apply only for that owner
  lease_owner text,
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
grant select (id, workspace_id, kb_id, folder_id, provider, integration_id, remote_id, remote_kind, options, name, url, attached_by, status, paused_by, error,
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
create or replace function public.kb_sync_service_check() returns boolean
language plpgsql stable security definer set search_path = public as $$ begin perform public.kb_sync_service_only(); return true; end $$;
revoke all on function public.kb_sync_service_check() from public, anon, authenticated;

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
-- the caller's check (0024) is the same rule for the signed-in person, so there is one definition of a KB admin
create or replace function public.can_admin_kb(kb_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_admin_kb_as(can_admin_kb.kb_id, auth.uid());
$$;

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
    update public.kb_sync_grants x set ended_at = now(), ended_reason = reason, revoke_pending = true, revoke_after = now() where x.id = g.id;
  else
    delete from public.kb_sync_grants x where x.id = g.id;
  end if;
end $$;
revoke all on function public.kb_sync_grant_end(public.ulid, text, boolean) from public, anon, authenticated;

-- whether ending a grant also revokes it with the provider: a grant of its own always. A grant the Mac shares never:
-- the Mac's own Disconnect revokes it, and only when no other Google connector on the Mac still uses it
-- (sources/accounts.js), so the relay revoking it would sign the Mac out of Google Calendar as well
create or replace function public.kb_sync_revokes(g public.kb_sync_grants, reason text) returns boolean
language sql immutable set search_path = public as $$
  select not g.shared_with_mac and reason is not null;
$$;
revoke all on function public.kb_sync_revokes(public.kb_sync_grants, text) from public, anon, authenticated;

-- removing the last attachment on a grant ends the grant, and so does moving the last one to another grant (an
-- attach again under a new sign-in)
create or replace function public.kb_attachment_gone() returns trigger
language plpgsql security definer set search_path = public as $$
declare g public.kb_sync_grants;
begin
  if old.grant_id is null or (tg_op = 'UPDATE' and new.grant_id is not distinct from old.grant_id) then return null; end if;
  if exists (select 1 from public.kb_attachments a where a.grant_id = old.grant_id and a.id <> old.id) then return null; end if;
  select * into g from public.kb_sync_grants x where x.id = old.grant_id;
  if g.id is not null then perform public.kb_sync_grant_end(g.id, 'removed', public.kb_sync_revokes(g, 'removed')); end if;
  return null;
end $$;
create trigger kb_attachments_gone after delete or update of grant_id on public.kb_attachments for each row execute function public.kb_attachment_gone();
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

-- a workspace whose plan ends (back to free) has its attachments paused, and a plan that is active again resumes the
-- ones the plan paused. An admin's own pause stays
create or replace function public.kb_sync_plan_ended() returns text
language sql immutable set search_path = public as $$ select 'The workspace''s plan ended'::text; $$;

create or replace function public.kb_sync_plan_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.plan = 'free' and old.plan is distinct from 'free' then
    update public.kb_attachments a set status = 'paused', paused_by = 'plan', error = public.kb_sync_plan_ended(), lease_until = null
      where a.workspace_id = new.id and a.status <> 'paused';
  elsif old.plan = 'free' and new.plan is distinct from 'free' then
    update public.kb_attachments a set status = case when a.grant_id is null then 'needs_auth' else 'pending' end, paused_by = null, error = null,
      next_run_at = now(), failures = 0
      where a.workspace_id = new.id and a.status = 'paused' and a.paused_by = 'plan';
  end if;
  return new;
end $$;
create trigger workspaces_kb_sync_plan after update of plan on public.workspaces for each row execute function public.kb_sync_plan_changed();
revoke all on function public.kb_sync_plan_changed() from public, anon, authenticated;

-- an attachment as an admin sees it
create or replace function public.kb_attachment_row(a public.kb_attachments) returns jsonb
language sql stable security definer set search_path = public as $$
  select (to_jsonb(a) - 'cursor' - 'lease_until' - 'lease_owner' - 'failures' - 'grant_id') || jsonb_build_object(
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

-- Pause stops the schedule and keeps the notes; Resume runs it again now. While the workspace's plan has ended the
-- attachment stays paused (kb_sync_plan_changed resumes it when the plan is active again)
create or replace function public.kb_attachment_pause(id public.ulid, paused boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.kb_attachments := public.kb_attachment_of(kb_attachment_pause.id);
begin
  if coalesce(kb_attachment_pause.paused, true) then
    update public.kb_attachments x set status = 'paused', paused_by = 'admin', error = case when x.paused_by = 'plan' then null else x.error end, lease_until = null
      where x.id = a.id returning * into a;
  elsif a.status = 'paused' then
    if exists (select 1 from public.workspaces w where w.id = a.workspace_id and w.plan = 'free') then raise exception '%. Syncing resumes when the plan is active again.', public.kb_sync_plan_ended(); end if;
    update public.kb_attachments x set status = case when x.grant_id is null then 'needs_auth' else 'pending' end, paused_by = null,
      error = case when x.paused_by = 'plan' then null else x.error end, next_run_at = now(), failures = 0
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

-- the caller disconnected the provider on their Mac: their grants for it end, and a grant of its own is revoked
create or replace function public.kb_sync_disconnect(workspace_id public.ulid, provider text) returns integer
language plpgsql security definer set search_path = public as $$
declare g public.kb_sync_grants; n integer := 0;
begin
  if auth.uid() is null or not public.is_member(kb_sync_disconnect.workspace_id) then raise exception 'You are not a member of that workspace'; end if;
  for g in select * from public.kb_sync_grants x where x.workspace_id = kb_sync_disconnect.workspace_id and x.user_id = auth.uid()
      and x.provider = kb_sync_disconnect.provider and x.ended_at is null loop
    perform public.kb_sync_grant_end(g.id, 'disconnected', public.kb_sync_revokes(g, 'disconnected'));
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
  old_grant public.kb_sync_grants;
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
create or replace function public.kb_sync_claim(max_rows integer default 20, lease_seconds integer default 600, per_workspace integer default 2, owner text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare out jsonb := '[]'::jsonb; a public.kb_attachments;
begin
  perform public.kb_sync_service_only();
  if coalesce(kb_sync_claim.owner, '') = '' then raise exception 'A claim names its owner'; end if;
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
      update public.kb_attachments x set status = 'paused', paused_by = 'plan', error = public.kb_sync_plan_ended(), lease_until = null where x.id = a.id;
      continue;
    end if;
    -- the per-workspace cap counts runs under a lease right now, on every relay instance, this claim included
    if (select count(*) from public.kb_attachments y where y.workspace_id = a.workspace_id and y.lease_until > now()) >= greatest(1, coalesce(per_workspace, 2)) then continue; end if;
    update public.kb_attachments x set lease_until = now() + make_interval(secs => greatest(60, coalesce(lease_seconds, 600))), lease_owner = kb_sync_claim.owner, last_attempt_at = now()
      where x.id = a.id and (x.lease_until is null or x.lease_until < now()) returning * into a;
    if a.id is null then continue; end if;
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
-- Returns false when the run no longer holds the lease (the row was removed, or another owner took it): nothing changes
create or replace function public.kb_sync_finish(attachment_id public.ulid, ok boolean, message text default null, cur jsonb default null,
  note_count integer default null, retry_seconds integer default 900, needs_auth boolean default false, owner text default null) returns boolean
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
    lease_until = null, lease_owner = null
  where x.id = kb_sync_finish.attachment_id and x.lease_owner is not distinct from kb_sync_finish.owner;
  return found;
end $$;

-- the lease, renewed during a run. false: the attachment is gone, paused or ended, or another owner holds it, and the
-- run stops writing
create or replace function public.kb_sync_renew(attachment_id public.ulid, owner text, lease_seconds integer default 900) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public.kb_sync_service_only();
  update public.kb_attachments x set lease_until = now() + make_interval(secs => greatest(60, coalesce(kb_sync_renew.lease_seconds, 900)))
    where x.id = kb_sync_renew.attachment_id and x.lease_owner = kb_sync_renew.owner and x.lease_until > now() and x.status <> 'paused';
  return found;
end $$;

-- one refresh of a grant at a time, across relay processes and the attach route: a rotated refresh token works once,
-- so a second refresh with the same token would fail and end the grant. The holder refreshes, stores the rotated
-- token, then unlocks; an unlock never comes from a process that died, so the lock also ends after lock_seconds
create or replace function public.kb_sync_refresh_lock(grant_id public.ulid, owner text, lock_seconds integer default 120) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public.kb_sync_service_only();
  if coalesce(kb_sync_refresh_lock.owner, '') = '' then raise exception 'A lock names its owner'; end if;
  update public.kb_sync_grants x set refresh_owner = kb_sync_refresh_lock.owner, refresh_until = now() + make_interval(secs => greatest(10, coalesce(kb_sync_refresh_lock.lock_seconds, 120)))
    where x.id = kb_sync_refresh_lock.grant_id and (x.refresh_until is null or x.refresh_until < now() or x.refresh_owner = kb_sync_refresh_lock.owner);
  return found;
end $$;

create or replace function public.kb_sync_refresh_unlock(grant_id public.ulid, owner text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.kb_sync_service_only();
  update public.kb_sync_grants x set refresh_owner = null, refresh_until = null where x.id = kb_sync_refresh_unlock.grant_id and x.refresh_owner = kb_sync_refresh_unlock.owner;
end $$;

-- the caller's live grant for a provider in the KB's workspace, for the attach route to lock before it replaces the token
create or replace function public.kb_sync_grant_of(uid uuid, kb_id public.ulid, provider text) returns public.ulid
language sql stable security definer set search_path = public as $$
  select g.id from public.kb_sync_grants g join public.knowledge_bases k on k.workspace_id = g.workspace_id
  where k.id = kb_sync_grant_of.kb_id and g.user_id = kb_sync_grant_of.uid and g.provider = kb_sync_grant_of.provider and g.ended_at is null
    and public.kb_sync_service_check();
$$;

-- notes a removed attachment left behind (a run that wrote while the attachment was being removed) leave the KB. With
-- an attachment id, the notes of that attachment when its row is gone; without, every stray note changed in the last
-- two days, for the worker's periodic sweep
create or replace function public.kb_sync_strays(attachment_id public.ulid default null) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform public.kb_sync_service_only();
  if kb_sync_strays.attachment_id is not null then
    if exists (select 1 from public.kb_attachments a where a.id = kb_sync_strays.attachment_id) then return 0; end if;
    update public.notes x set deleted_at = now(), updated_at = now()
      where x.deleted_at is null and x.kb_id is not null and x.frontmatter ->> 'kb_attachment' = kb_sync_strays.attachment_id::text;
  else
    update public.notes x set deleted_at = now(), updated_at = now()
      where x.deleted_at is null and x.kb_id is not null and x.updated_at > now() - interval '2 days' and x.frontmatter ? 'kb_attachment'
        and not exists (select 1 from public.kb_attachments a where a.id::text = x.frontmatter ->> 'kb_attachment');
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- the 0031 writes for synced notes and their upstream rows (kb_synced_notes_write, kb_upstream_save), for the worker.
-- Those functions check that the caller is an admin of the KB, and the worker has no session, so these two run them as
-- the attachment's admin, after checking that person is still an admin of the KB. app/ee/kbUpstream.js plans the
-- notes on the relay the same way it does on the Mac, so an edit Quorum made to a synced note becomes a suggestion
create or replace function public.kb_sync_as_attacher(attachment_id public.ulid) returns public.kb_attachments
language plpgsql security definer set search_path = public as $$
declare a public.kb_attachments;
begin
  perform public.kb_sync_service_only();
  select * into a from public.kb_attachments x where x.id = kb_sync_as_attacher.attachment_id;
  if a.id is null or not public.can_admin_kb_as(a.kb_id, a.attached_by) then raise exception 'That synced folder no longer exists'; end if;
  -- for the rest of this transaction (one API call) the 0031 checks see the attaching admin
  perform set_config('request.jwt.claims', json_build_object('sub', a.attached_by::text, 'role', 'authenticated')::text, true);
  return a;
end $$;
revoke all on function public.kb_sync_as_attacher(public.ulid) from public, anon, authenticated;

create or replace function public.kb_sync_notes_write(attachment_id public.ulid, rows jsonb) returns setof public.ulid
language plpgsql security definer set search_path = public as $$
declare a public.kb_attachments := public.kb_sync_as_attacher(kb_sync_notes_write.attachment_id);
begin
  return query select * from public.kb_synced_notes_write(a.kb_id, kb_sync_notes_write.rows);
end $$;

create or replace function public.kb_sync_upstream_save(attachment_id public.ulid, rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare a public.kb_attachments := public.kb_sync_as_attacher(kb_sync_upstream_save.attachment_id);
begin
  return public.kb_upstream_save(a.kb_id, kb_sync_upstream_save.rows);
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
    where g.revoke_pending and (g.revoke_after is null or g.revoke_after <= now())
    order by g.revoke_after nulls first, g.ended_at limit greatest(1, least(coalesce(max_rows, 20), 200));
end $$;

-- a revoke the provider did not confirm: tried again later, with backoff. After max_attempts the worker gives up: the
-- Vault secret is deleted anyway and the row stays, with revoke_failed_at, as the record that the provider revoke failed
create or replace function public.kb_sync_revoke_failed(grant_id public.ulid, max_attempts integer default 5) returns boolean
language plpgsql security definer set search_path = public as $$
declare g public.kb_sync_grants;
begin
  perform public.kb_sync_service_only();
  update public.kb_sync_grants x set revoke_attempts = x.revoke_attempts + 1,
    revoke_after = now() + make_interval(secs => least(86400, 300 * power(2, x.revoke_attempts)::integer))
    where x.id = kb_sync_revoke_failed.grant_id and x.revoke_pending returning * into g;
  if g.id is null then return false; end if;
  if g.revoke_attempts >= greatest(1, coalesce(max_attempts, 5)) then
    update public.kb_sync_grants x set revoke_pending = false, revoke_failed_at = now(), secret_id = null where x.id = g.id;
    return true;
  end if;
  return false;
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
    'kb_sync_claim(integer, integer, integer, text)',
    'kb_sync_renew(public.ulid, text, integer)',
    'kb_sync_refresh_lock(public.ulid, text, integer)',
    'kb_sync_refresh_unlock(public.ulid, text)',
    'kb_sync_grant_of(uuid, public.ulid, text)',
    'kb_sync_strays(public.ulid)',
    'kb_sync_revoke_failed(public.ulid, integer)',
    'kb_sync_token(public.ulid)',
    'kb_sync_token_store(public.ulid, text)',
    'kb_sync_grant_refused(public.ulid)',
    'kb_sync_finish(public.ulid, boolean, text, jsonb, integer, integer, boolean, text)',
    'kb_sync_revocations(integer)',
    'kb_sync_revoked(public.ulid)',
    'relay_workspace_oauth_client(public.ulid, text)',
    'kb_sync_notes_write(public.ulid, jsonb)',
    'kb_sync_upstream_save(public.ulid, jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
