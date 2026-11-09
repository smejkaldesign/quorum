-- Quorum hosted edition, step 6: workspace connectors (Settings › Admin › Connectors). A connector is a provider key an
-- owner or admin adds once for the whole workspace, with the roles it may serve: speech, summary, notes, agent, voice.
--
-- Secrets. The key goes to Supabase Vault (vault.secrets) through workspace_connector_set and never returns to a
-- client: the row carries the Vault id only, the RPC returns the row without it, and the column is readable by no
-- client role. The decrypted value is read only by the relay service, with the service role, when it runs a speech,
-- summary, notes, agent or voice call on the organization's behalf. secret_id is not a foreign key: the vault schema
-- grants no REFERENCES on vault.secrets, so the RPCs and the delete trigger keep the two in step.
--
-- Access. Members read rows (without secret_id); owners and admins write them. Inserts happen only through the RPC,
-- since a row without a Vault secret is useless; label, base_url and roles may be edited in place by admins.

create or replace function public.connector_roles(provider text) returns text[]
language sql immutable as $$
  select case provider
    when 'assemblyai' then array['speech']
    when 'deepgram' then array['speech']
    when 'elevenlabs' then array['speech', 'voice']
    when 'openai' then array['speech', 'summary', 'notes', 'agent', 'voice']
    when 'anthropic' then array['summary', 'notes', 'agent']
    when 'google' then array['speech', 'summary', 'notes', 'agent']
    when 'openai_compatible' then array['summary', 'notes', 'agent']
    else array[]::text[]
  end;
$$;
grant execute on function public.connector_roles(text) to authenticated, service_role;

create table public.workspace_connectors (
  id public.ulid primary key,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  provider text not null check (provider in ('assemblyai', 'deepgram', 'elevenlabs', 'openai', 'anthropic', 'google', 'openai_compatible')),
  label text not null check (length(trim(label)) between 1 and 80),
  base_url text check (base_url is null or base_url ~ '^https?://'),
  secret_id uuid not null,
  roles text[] not null check (cardinality(roles) > 0 and roles <@ public.connector_roles(provider)),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_connectors_base_url check (provider <> 'openai_compatible' or base_url is not null)
);
create unique index workspace_connectors_label on public.workspace_connectors (workspace_id, provider, lower(label));
create index workspace_connectors_workspace on public.workspace_connectors (workspace_id);
create trigger workspace_connectors_updated_at before update on public.workspace_connectors for each row execute function public.set_updated_at();

alter table public.workspace_connectors enable row level security;
create policy workspace_connectors_select on public.workspace_connectors for select to authenticated using (public.is_member(workspace_id));
create policy workspace_connectors_update on public.workspace_connectors for update to authenticated using (public.is_admin(workspace_id)) with check (public.is_admin(workspace_id));
create policy workspace_connectors_delete on public.workspace_connectors for delete to authenticated using (public.is_admin(workspace_id));
-- the Vault id stays out of every client read and write
revoke all on public.workspace_connectors from anon, authenticated;
grant select (id, workspace_id, provider, label, base_url, roles, created_by, created_at, updated_at), update (label, base_url, roles), delete on public.workspace_connectors to authenticated;

-- removing a connector, by RPC or by a direct delete, removes its Vault secret with it
create or replace function public.workspace_connector_drop_secret() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from vault.secrets s where s.id = old.secret_id;
  return old;
end $$;
create trigger workspace_connectors_drop_secret after delete on public.workspace_connectors for each row execute function public.workspace_connector_drop_secret();

-- the row as clients see it: every column but secret_id
create or replace function public.workspace_connector_public(c public.workspace_connectors) returns jsonb
language sql immutable as $$
  select to_jsonb(c) - 'secret_id';
$$;

-- adds a connector, or replaces the key, base URL and roles of the one with the same provider and label. Returns the
-- row without the Vault id.
create or replace function public.workspace_connector_set(workspace_id public.ulid, provider text, label text, base_url text, roles text[], secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c public.workspace_connectors;
  l text := trim(coalesce(workspace_connector_set.label, ''));
  u text := nullif(trim(coalesce(workspace_connector_set.base_url, '')), '');
  k text := trim(coalesce(workspace_connector_set.secret, ''));
  r text[] := coalesce(workspace_connector_set.roles, array[]::text[]);
  nid public.ulid;
begin
  if not public.is_admin(workspace_connector_set.workspace_id) then raise exception 'Only owners and admins can manage connectors'; end if;
  if public.connector_roles(workspace_connector_set.provider) = array[]::text[] then raise exception 'That provider is not supported'; end if;
  if l = '' then raise exception 'Give the connector a label'; end if;
  if length(k) < 8 then raise exception 'Paste the provider key'; end if;
  if cardinality(r) = 0 or not (r <@ public.connector_roles(workspace_connector_set.provider)) then raise exception 'Pick at least one role this provider can serve'; end if;
  if workspace_connector_set.provider = 'openai_compatible' and u is null then raise exception 'An OpenAI-compatible provider needs a base URL'; end if;
  if workspace_connector_set.provider <> 'openai_compatible' then u := null; end if;
  select * into c from public.workspace_connectors x
    where x.workspace_id = workspace_connector_set.workspace_id and x.provider = workspace_connector_set.provider and lower(x.label) = lower(l);
  if c.id is null then
    nid := public.gen_ulid();
    insert into public.workspace_connectors (id, workspace_id, provider, label, base_url, secret_id, roles, created_by)
    values (nid, workspace_connector_set.workspace_id, workspace_connector_set.provider, l, u,
      vault.create_secret(k, 'workspace_connector:' || nid, workspace_connector_set.provider || ' ' || l), r, auth.uid())
    returning * into c;
  else
    perform vault.update_secret(c.secret_id, k);
    update public.workspace_connectors x set base_url = u, roles = r where x.id = c.id returning * into c;
  end if;
  return public.workspace_connector_public(c);
end $$;

create or replace function public.workspace_connector_remove(id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.workspace_connectors;
begin
  select * into c from public.workspace_connectors x where x.id = workspace_connector_remove.id;
  if c.id is null then raise exception 'That connector no longer exists'; end if;
  if not public.is_admin(c.workspace_id) then raise exception 'Only owners and admins can manage connectors'; end if;
  delete from public.workspace_connectors x where x.id = c.id;
end $$;

do $$
declare f text;
begin
  foreach f in array array['workspace_connector_set(public.ulid, text, text, text, text[], text)', 'workspace_connector_remove(public.ulid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  revoke all on function public.workspace_connector_public(public.workspace_connectors) from public, anon;
  grant execute on function public.workspace_connector_public(public.workspace_connectors) to authenticated, service_role;
end $$;
