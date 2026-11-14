-- applied-when: select exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = 'workspace_integrations')
-- Workspace connectors (docs/specs/workspace-knowledge.md, "Two connector modes" and "Data model"; the app side is
-- app/ee/integrations.js and app/ee/src/WorkspaceIntegrations.tsx). An owner or admin enables a connector from the
-- library for the whole workspace, in one of two identity modes:
--   org       one shared identity the organization provisions: an API key or the organization's own OAuth client
--             secret, held in Supabase Vault. Members never see or authorize it.
--   personal  each member authorizes their own account through Quorum's personal OAuth flow (sources/accounts.js).
-- The 0006 workspace_connectors table stays as it is, for model provider keys.
--
-- Secrets. The secret goes into Vault through workspace_integration_save and never returns to a client: secret_id and
-- secret_last4 are readable by no client role, and the admin list RPC reports only whether a secret is set and its last
-- four characters. Nothing in this migration reads a decrypted secret; the sync worker that needs it comes later and
-- will read it with the service role.
--
-- Access. Members read the non-secret columns of enabled rows; owners and admins read every row of their workspace.
-- Every write goes through a security definer RPC that checks the caller is an owner or admin.
--
-- member_integrations records which members connected an enabled connector with their own account (status and the
-- last sync time). It holds no tokens yet; server-side tokens for background sync arrive with the sync worker.
--
-- approved_connectors_only on workspaces is the "Members may only use approved connectors" switch. It applies while
-- the team switch (0019) is on, and it starts on for every workspace, so every team, existing or new, has it on by
-- default (Decisions 3).

create table public.workspace_integrations (
  id public.ulid primary key default public.gen_ulid(),
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  provider text not null check (provider ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  mode text not null check (mode in ('org', 'personal')),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  secret_id uuid,
  secret_last4 text check (secret_last4 is null or length(secret_last4) <= 4),
  enabled boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_integrations_personal_no_secret check (mode = 'org' or secret_id is null)
);
create unique index workspace_integrations_provider on public.workspace_integrations (workspace_id, provider);
create trigger workspace_integrations_updated_at before update on public.workspace_integrations for each row execute function public.set_updated_at();

alter table public.workspace_integrations enable row level security;
create policy workspace_integrations_select on public.workspace_integrations for select to authenticated
  using ((enabled and public.is_member(workspace_id)) or public.is_admin(workspace_id));
-- the Vault id and the last four characters stay out of every client read; there is no client write
revoke all on public.workspace_integrations from anon, authenticated;
grant select (id, workspace_id, provider, mode, config, enabled, created_by, created_at, updated_at) on public.workspace_integrations to authenticated;

-- removing a connector, or switching it to personal mode, removes its Vault secret with it
create or replace function public.workspace_integration_drop_secret() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.secret_id is not null then delete from vault.secrets s where s.id = old.secret_id; end if;
    return old;
  end if;
  if old.secret_id is not null and new.secret_id is distinct from old.secret_id then delete from vault.secrets s where s.id = old.secret_id; end if;
  return new;
end $$;
create trigger workspace_integrations_drop_secret after delete or update of secret_id on public.workspace_integrations for each row execute function public.workspace_integration_drop_secret();
revoke all on function public.workspace_integration_drop_secret() from public, anon, authenticated;

create table public.member_integrations (
  user_id uuid not null references auth.users (id) on delete cascade,
  integration_id public.ulid not null references public.workspace_integrations (id) on delete cascade,
  status text not null default 'connected' check (status in ('connected', 'disconnected', 'error')),
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, integration_id)
);
create index member_integrations_integration on public.member_integrations (integration_id);
create trigger member_integrations_updated_at before update on public.member_integrations for each row execute function public.set_updated_at();
alter table public.member_integrations enable row level security;
create policy member_integrations_select on public.member_integrations for select to authenticated using (user_id = auth.uid());
revoke all on public.member_integrations from anon, authenticated;
grant select on public.member_integrations to authenticated;

-- members' connections end when the connector is turned off or switched to org mode (removing it deletes the rows), and
-- when a member leaves the workspace
create or replace function public.workspace_integration_end_connections() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (old.enabled and not new.enabled) or (old.mode = 'personal' and new.mode = 'org') then
    update public.member_integrations m set status = 'disconnected' where m.integration_id = new.id and m.status = 'connected';
  end if;
  return new;
end $$;
create trigger workspace_integrations_end_connections after update of enabled, mode on public.workspace_integrations for each row execute function public.workspace_integration_end_connections();
revoke all on function public.workspace_integration_end_connections() from public, anon, authenticated;

create or replace function public.member_left_end_connections() returns trigger
language plpgsql security definer set search_path = public as $$
declare u uuid; ws public.ulid;
begin
  if tg_op = 'DELETE' then u := old.user_id; ws := old.workspace_id;
  elsif old.deleted_at is null and new.deleted_at is not null then u := new.user_id; ws := new.workspace_id;
  else return new;
  end if;
  update public.member_integrations m set status = 'disconnected'
    from public.workspace_integrations i
    where m.integration_id = i.id and i.workspace_id = ws and m.user_id = u and m.status = 'connected';
  return coalesce(new, old);
end $$;
create trigger members_end_connections after update of deleted_at or delete on public.members for each row execute function public.member_left_end_connections();
revoke all on function public.member_left_end_connections() from public, anon, authenticated;

alter table public.workspaces add column approved_connectors_only boolean not null default true;

-- the config as stored: only the known keys, each cleaned. scopes are the provider scopes the organization picked,
-- custom_scopes turns on that scope list, owner_id is the accountable owner (a member of this workspace), mock serves
-- fixture data instead of a live connection, auth says what the secret is, client_id goes with an OAuth client
create or replace function public.workspace_integration_config(ws public.ulid, cfg jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c jsonb := coalesce(cfg, '{}'::jsonb);
  out jsonb;
  scopes text[] := array[]::text[];
  s text;
  owner text;
  dom text;
  auth_kind text;
  cid text;
begin
  if jsonb_typeof(c) <> 'object' then raise exception 'The connector settings must be an object'; end if;
  if c ? 'scopes' then
    if jsonb_typeof(c -> 'scopes') <> 'array' then raise exception 'Scopes must be a list'; end if;
    for s in select trim(v) from jsonb_array_elements_text(c -> 'scopes') as v loop
      if s = '' then continue; end if;
      if s !~ '^[A-Za-z0-9._:/+-]{1,200}$' then raise exception 'That scope has characters a scope cannot have: %', s; end if;
      if not s = any (scopes) then scopes := scopes || s; end if;
    end loop;
    if cardinality(scopes) > 50 then raise exception 'Keep it to 50 scopes or fewer'; end if;
  end if;
  out := jsonb_build_object('scopes', to_jsonb(scopes), 'custom_scopes', coalesce(c ->> 'custom_scopes', '') = 'true', 'mock', coalesce(c ->> 'mock', '') = 'true');
  owner := nullif(trim(coalesce(c ->> 'owner_id', '')), '');
  if owner is not null then
    if not exists (select 1 from public.members m where m.workspace_id = ws and m.user_id::text = owner and m.deleted_at is null) then
      raise exception 'The accountable owner has to be a member of this workspace';
    end if;
    out := out || jsonb_build_object('owner_id', owner);
  end if;
  dom := nullif(lower(trim(coalesce(c ->> 'domain', ''))), '');
  if dom is not null then
    if dom !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then raise exception 'That domain does not look right'; end if;
    out := out || jsonb_build_object('domain', dom);
  end if;
  auth_kind := coalesce(nullif(c ->> 'auth', ''), 'api_key');
  if auth_kind not in ('api_key', 'oauth_client') then raise exception 'Pick an API key or an OAuth client'; end if;
  out := out || jsonb_build_object('auth', auth_kind);
  cid := nullif(trim(coalesce(c ->> 'client_id', '')), '');
  if cid is not null then
    if length(cid) > 300 then raise exception 'That client id is too long'; end if;
    out := out || jsonb_build_object('client_id', cid);
  end if;
  return out;
end $$;

-- the row as an admin sees it: every non-secret column, whether a secret is set, its last four characters, and how many
-- connections it has. A turned-off connector has none. An org connector has one shared connection once a secret is set
-- (or mock mode is on, which no screen offers yet). A personal connector counts the current members who are connected.
create or replace function public.workspace_integration_admin_row(i public.workspace_integrations) returns jsonb
language sql stable security definer set search_path = public as $$
  select (to_jsonb(i) - 'secret_id' - 'secret_last4') || jsonb_build_object(
    'secret_set', i.secret_id is not null,
    'secret_last4', i.secret_last4,
    'connections', case
      when not i.enabled then 0
      when i.mode = 'org' then (case when i.secret_id is not null or coalesce(i.config ->> 'mock', '') = 'true' then 1 else 0 end)
      else (select count(*) from public.member_integrations m
        join public.members w on w.user_id = m.user_id and w.workspace_id = i.workspace_id and w.deleted_at is null
        where m.integration_id = i.id and m.status = 'connected') end);
$$;

-- enables or updates the workspace's connector for one provider. secret: a new API key or client secret for org mode;
-- null or empty keeps the stored one. Switching to personal mode drops the stored secret. enabled: null keeps the
-- current state, and a new row starts enabled.
create or replace function public.workspace_integration_save(workspace_id public.ulid, provider text, mode text, config jsonb, secret text default null, enabled boolean default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ws public.ulid := workspace_integration_save.workspace_id;
  p text := lower(trim(coalesce(workspace_integration_save.provider, '')));
  m text := workspace_integration_save.mode;
  k text := trim(coalesce(workspace_integration_save.secret, ''));
  on_now boolean := workspace_integration_save.enabled;
  cfg jsonb;
  i public.workspace_integrations;
  sid uuid;
  nid public.ulid;
begin
  if not public.is_admin(ws) then raise exception 'Only owners and admins can manage workspace connectors'; end if;
  if p !~ '^[a-z0-9][a-z0-9-]{0,39}$' then raise exception 'That connector is not supported'; end if;
  if m is null or m not in ('org', 'personal') then raise exception 'Pick org or personal identity'; end if;
  if k <> '' and m <> 'org' then raise exception 'A personal connector has no shared secret; each member signs in with their own account'; end if;
  if k <> '' and length(k) < 8 then raise exception 'Paste the whole key or client secret'; end if;
  if length(k) > 4000 then raise exception 'That secret is too long'; end if;
  cfg := public.workspace_integration_config(ws, workspace_integration_save.config);
  select * into i from public.workspace_integrations x where x.workspace_id = ws and x.provider = p;
  -- a blank secret keeps the stored one only under the auth method it was saved for: an API key is no client secret
  if m = 'org' and k = '' and not (cfg ->> 'mock')::boolean then
    if i.id is null or i.secret_id is null then raise exception 'An org connector needs an API key or client secret'; end if;
    if coalesce(i.config ->> 'auth', 'api_key') <> cfg ->> 'auth' then raise exception 'A new auth method needs a new secret'; end if;
  end if;
  if i.id is null then
    nid := public.gen_ulid();
    if k <> '' then sid := vault.create_secret(k, 'workspace_integration:' || nid, p || ' for workspace ' || ws); end if;
    insert into public.workspace_integrations (id, workspace_id, provider, mode, config, secret_id, secret_last4, enabled, created_by)
    values (nid, ws, p, m, cfg, sid, case when k <> '' then right(k, 4) end, coalesce(on_now, true), auth.uid())
    returning * into i;
  elsif m = 'personal' then
    update public.workspace_integrations x set mode = m, config = cfg, secret_id = null, secret_last4 = null, enabled = coalesce(on_now, x.enabled)
      where x.id = i.id returning * into i;
  elsif k <> '' and i.secret_id is not null then
    perform vault.update_secret(i.secret_id, k);
    update public.workspace_integrations x set mode = m, config = cfg, secret_last4 = right(k, 4), enabled = coalesce(on_now, x.enabled)
      where x.id = i.id returning * into i;
  elsif k <> '' then
    sid := vault.create_secret(k, 'workspace_integration:' || i.id, p || ' for workspace ' || ws);
    update public.workspace_integrations x set mode = m, config = cfg, secret_id = sid, secret_last4 = right(k, 4), enabled = coalesce(on_now, x.enabled)
      where x.id = i.id returning * into i;
  else
    update public.workspace_integrations x set mode = m, config = cfg, enabled = coalesce(on_now, x.enabled)
      where x.id = i.id returning * into i;
  end if;
  return public.workspace_integration_admin_row(i);
end $$;

create or replace function public.workspace_integration_set_enabled(id public.ulid, enabled boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i public.workspace_integrations;
begin
  select * into i from public.workspace_integrations x where x.id = workspace_integration_set_enabled.id;
  if i.id is null or not public.is_admin(i.workspace_id) then raise exception 'That connector no longer exists'; end if;
  update public.workspace_integrations x set enabled = coalesce(workspace_integration_set_enabled.enabled, false) where x.id = i.id returning * into i;
  return public.workspace_integration_admin_row(i);
end $$;

create or replace function public.workspace_integration_remove(id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
declare i public.workspace_integrations;
begin
  select * into i from public.workspace_integrations x where x.id = workspace_integration_remove.id;
  if i.id is null or not public.is_admin(i.workspace_id) then raise exception 'That connector no longer exists'; end if;
  delete from public.workspace_integrations x where x.id = i.id;
end $$;

-- Admin > Workspace > Connectors: every connector row of the workspace, with secret status and connection counts
create or replace function public.workspace_integrations_admin(workspace_id public.ulid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin(workspace_integrations_admin.workspace_id) then raise exception 'Only owners and admins can manage workspace connectors'; end if;
  return coalesce((select jsonb_agg(public.workspace_integration_admin_row(i) order by i.created_at) from public.workspace_integrations i
    where i.workspace_id = workspace_integrations_admin.workspace_id), '[]'::jsonb);
end $$;

-- what a member's Connections page needs: whether only approved connectors may be used (the switch, applied while the
-- team switch is on) and the providers the workspace enabled, with their mode
create or replace function public.workspace_connector_policy(workspace_id public.ulid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare w public.workspaces;
begin
  if not public.is_member(workspace_connector_policy.workspace_id) then raise exception 'You are not a member of that workspace'; end if;
  select * into w from public.workspaces x where x.id = workspace_connector_policy.workspace_id and x.deleted_at is null;
  if w.id is null then raise exception 'That workspace does not exist'; end if;
  return jsonb_build_object(
    'team_enabled', w.team_enabled,
    'approved_connectors_only', w.approved_connectors_only,
    'approved_only', w.team_enabled and w.approved_connectors_only,
    'enabled', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'provider', i.provider, 'mode', i.mode) order by i.provider)
      from public.workspace_integrations i where i.workspace_id = w.id and i.enabled), '[]'::jsonb));
end $$;

create or replace function public.workspace_set_approved_connectors_only(ws public.ulid, enabled boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin(ws) then raise exception 'Only owners and admins can change which connectors members may use'; end if;
  update public.workspaces set approved_connectors_only = coalesce(enabled, true), updated_at = now() where id = ws and deleted_at is null;
  if not found then raise exception 'That workspace does not exist'; end if;
  return coalesce(enabled, true);
end $$;

-- a member reports which providers they have connected on their Mac. Their rows for the workspace's enabled personal
-- connectors in that list become connected; their other connected rows in this workspace become disconnected.
-- Returns how many of their rows are connected.
create or replace function public.member_integrations_sync(workspace_id public.ulid, connected text[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  ids text[] := coalesce(member_integrations_sync.connected, array[]::text[]);
  n integer;
begin
  if auth.uid() is null or not public.is_member(member_integrations_sync.workspace_id) then raise exception 'You are not a member of that workspace'; end if;
  insert into public.member_integrations as mi (user_id, integration_id, status)
    select auth.uid(), i.id, 'connected' from public.workspace_integrations i
    where i.workspace_id = member_integrations_sync.workspace_id and i.enabled and i.mode = 'personal' and i.provider = any (ids)
  on conflict (user_id, integration_id) do update set status = 'connected' where mi.status <> 'connected';
  update public.member_integrations mi set status = 'disconnected'
    from public.workspace_integrations i
    where mi.integration_id = i.id and mi.user_id = auth.uid() and i.workspace_id = member_integrations_sync.workspace_id
      and mi.status = 'connected' and not (i.provider = any (ids) and i.enabled and i.mode = 'personal');
  select count(*) into n from public.member_integrations mi join public.workspace_integrations i on i.id = mi.integration_id
    where mi.user_id = auth.uid() and i.workspace_id = member_integrations_sync.workspace_id and mi.status = 'connected';
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'workspace_integration_save(public.ulid, text, text, jsonb, text, boolean)',
    'workspace_integration_set_enabled(public.ulid, boolean)',
    'workspace_integration_remove(public.ulid)',
    'workspace_integrations_admin(public.ulid)',
    'workspace_connector_policy(public.ulid)',
    'workspace_set_approved_connectors_only(public.ulid, boolean)',
    'member_integrations_sync(public.ulid, text[])'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  -- helpers the RPCs call; no client calls them directly
  revoke all on function public.workspace_integration_config(public.ulid, jsonb) from public, anon, authenticated;
  revoke all on function public.workspace_integration_admin_row(public.workspace_integrations) from public, anon, authenticated;
end $$;
