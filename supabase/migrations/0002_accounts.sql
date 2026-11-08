-- Quorum hosted edition, accounts (step 3 of docs/backend-plan.md): workspace domains, invites, profiles and the RPCs
-- the app's account layer calls. The RPCs run as security definer so table policies stay simple; each one checks
-- the caller itself. Member and invite ids are ULIDs made here, so they match the client's ids everywhere else.

create extension if not exists pgcrypto with schema extensions;

-- a ULID in Crockford base32: 10 characters of milliseconds, 16 of randomness
create or replace function public.gen_ulid() returns public.ulid
language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  rnd bytea := extensions.gen_random_bytes(16);
  s text := '';
  i int;
begin
  for i in 0..9 loop s := s || substr(alphabet, ((ms >> (45 - 5 * i)) & 31)::int + 1, 1); end loop;
  for i in 0..15 loop s := s || substr(alphabet, (get_byte(rnd, i) & 31) + 1, 1); end loop;
  return s;
end $$;

-- a workspace can let anyone with a matching email domain join on their own
alter table public.workspaces add column domain text check (domain is null or domain = lower(domain)), add column domain_join boolean not null default true;
create index workspaces_domain on public.workspaces (domain) where domain is not null and deleted_at is null;

create or replace function public.is_admin(ws public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m where m.workspace_id = ws and m.user_id = auth.uid() and m.role in ('owner', 'admin') and m.deleted_at is null);
$$;

-- invites: user_id is the inviter; the invited person sees the row by email before they are a member
create table public.invites (
  id public.ulid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(email)),
  role text not null default 'member' check (role in ('admin', 'member')),
  token text,
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index invites_email on public.invites (email) where accepted_at is null and deleted_at is null;
create index invites_workspace on public.invites (workspace_id) where accepted_at is null and deleted_at is null;
create trigger invites_updated_at before update on public.invites for each row execute function public.set_updated_at();
alter table public.invites enable row level security;
create policy invites_select on public.invites for select to authenticated using (public.is_member(workspace_id) or email = lower(coalesce(auth.email(), '')));
create policy invites_insert on public.invites for insert to authenticated with check (public.is_admin(workspace_id) and user_id = auth.uid());
create policy invites_update on public.invites for update to authenticated using (public.is_admin(workspace_id)) with check (public.is_admin(workspace_id));
create policy invites_delete on public.invites for delete to authenticated using (public.is_admin(workspace_id));

-- profiles: the email and name behind a user id, since auth.users is never readable from the client
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
alter table public.profiles enable row level security;

create or replace function public.sync_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email, name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'full_name'))
  on conflict (user_id) do update set email = excluded.email, name = coalesce(excluded.name, public.profiles.name);
  return new;
end $$;
create trigger auth_users_profile after insert or update of email, raw_user_meta_data on auth.users for each row execute function public.sync_profile();
insert into public.profiles (user_id, email, name)
  select id, lower(email), coalesce(raw_user_meta_data ->> 'name', raw_user_meta_data ->> 'full_name') from auth.users
  on conflict (user_id) do nothing;

-- you can see the profile of anyone who shares a workspace with you, and your own
create or replace function public.shares_workspace(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select other = auth.uid() or exists (
    select 1 from public.members a join public.members b on a.workspace_id = b.workspace_id
    where a.user_id = auth.uid() and b.user_id = other and a.deleted_at is null and b.deleted_at is null);
$$;
create policy profiles_select on public.profiles for select to authenticated using (public.shares_workspace(user_id));

-- RPCs. Each raises a plain sentence on refusal; the app shows that sentence as is.

create or replace function public.create_workspace(name text, domain text default null, domain_join boolean default true) returns public.workspaces
language plpgsql security definer set search_path = public as $$
declare ws public.workspaces;
begin
  if auth.uid() is null then raise exception 'You need to sign in first'; end if;
  insert into public.workspaces (id, user_id, name, domain, domain_join)
  values (public.gen_ulid(), auth.uid(), coalesce(nullif(trim(create_workspace.name), ''), 'My workspace'), nullif(lower(trim(create_workspace.domain)), ''), coalesce(create_workspace.domain_join, true))
  returning * into ws;
  return ws;
end $$;

create or replace function public.pending_invites() returns table (invite_id public.ulid, workspace_id public.ulid, workspace_name text, role text, invited_by_email text, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.id, i.workspace_id, w.name, i.role, p.email, i.expires_at
  from public.invites i
  join public.workspaces w on w.id = i.workspace_id and w.deleted_at is null
  left join public.profiles p on p.user_id = i.user_id
  where i.email = lower(coalesce(auth.email(), '')) and i.accepted_at is null and i.deleted_at is null and i.expires_at > now()
    and not exists (select 1 from public.members m where m.workspace_id = i.workspace_id and m.user_id = auth.uid() and m.deleted_at is null)
  order by i.created_at desc;
$$;

create or replace function public.domain_workspaces() returns table (workspace_id public.ulid, name text)
language sql stable security definer set search_path = public as $$
  select w.id, w.name from public.workspaces w
  where w.domain is not null and w.domain_join and w.deleted_at is null
    and w.domain = lower(split_part(coalesce(auth.email(), ''), '@', 2)) and w.domain <> ''
    and not exists (select 1 from public.members m where m.workspace_id = w.id and m.user_id = auth.uid() and m.deleted_at is null)
  order by w.name;
$$;

create or replace function public.accept_invite(invite_id public.ulid) returns public.ulid
language plpgsql security definer set search_path = public as $$
declare inv public.invites;
begin
  select * into inv from public.invites i where i.id = accept_invite.invite_id and i.deleted_at is null for update;
  if inv.id is null then raise exception 'That invite no longer exists'; end if;
  if inv.email <> lower(coalesce(auth.email(), '')) then raise exception 'That invite was sent to a different email address'; end if;
  if inv.accepted_at is not null then raise exception 'That invite was already used'; end if;
  if inv.expires_at <= now() then raise exception 'That invite has expired'; end if;
  -- a removed member comes back with the invite's role; a current member keeps theirs
  insert into public.members (id, user_id, workspace_id, role) values (public.gen_ulid(), auth.uid(), inv.workspace_id, inv.role)
  on conflict (workspace_id, user_id) do update set deleted_at = null, role = case when public.members.deleted_at is null then public.members.role else excluded.role end;
  update public.invites i set accepted_at = now() where i.id = inv.id;
  return inv.workspace_id;
end $$;

create or replace function public.join_by_domain(ws public.ulid) returns public.ulid
language plpgsql security definer set search_path = public as $$
declare w public.workspaces;
begin
  select * into w from public.workspaces x where x.id = ws and x.deleted_at is null;
  if w.id is null then raise exception 'That workspace no longer exists'; end if;
  if w.domain is null or not w.domain_join or w.domain <> lower(split_part(coalesce(auth.email(), ''), '@', 2)) then raise exception 'Your email domain does not match this workspace'; end if;
  insert into public.members (id, user_id, workspace_id, role) values (public.gen_ulid(), auth.uid(), w.id, 'member')
  on conflict (workspace_id, user_id) do update set deleted_at = null;
  return w.id;
end $$;

create or replace function public.workspace_members(ws public.ulid) returns table (user_id uuid, email text, name text, role text, joined_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, p.email, p.name, m.role, m.created_at
  from public.members m left join public.profiles p on p.user_id = m.user_id
  where m.workspace_id = ws and m.deleted_at is null and public.is_member(ws)
  order by m.created_at;
$$;

create or replace function public.invite_member(ws public.ulid, email text, role text default 'member') returns public.invites
language plpgsql security definer set search_path = public as $$
declare inv public.invites; e text := lower(trim(invite_member.email));
begin
  if not public.is_admin(ws) then raise exception 'Only owners and admins can invite people'; end if;
  if e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'That does not look like an email address'; end if;
  if invite_member.role not in ('admin', 'member') then raise exception 'A role is admin or member'; end if;
  if exists (select 1 from public.members m join public.profiles p on p.user_id = m.user_id where m.workspace_id = ws and m.deleted_at is null and p.email = e) then raise exception 'That person is already a member'; end if;
  -- one open invite per email and workspace; inviting again refreshes it
  update public.invites i set role = invite_member.role, expires_at = now() + interval '14 days', user_id = auth.uid()
    where i.workspace_id = ws and i.email = e and i.accepted_at is null and i.deleted_at is null returning * into inv;
  if inv.id is null then
    insert into public.invites (id, user_id, workspace_id, email, role) values (public.gen_ulid(), auth.uid(), ws, e, invite_member.role) returning * into inv;
  end if;
  return inv;
end $$;

create or replace function public.revoke_invite(invite_id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
declare inv public.invites;
begin
  select * into inv from public.invites i where i.id = revoke_invite.invite_id and i.deleted_at is null;
  if inv.id is null then raise exception 'That invite no longer exists'; end if;
  if not public.is_admin(inv.workspace_id) then raise exception 'Only owners and admins can revoke invites'; end if;
  update public.invites i set deleted_at = now() where i.id = inv.id;
end $$;

create or replace function public.remove_member(ws public.ulid, user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare target public.members;
begin
  if not public.is_owner(ws) then raise exception 'Only owners can remove members'; end if;
  select * into target from public.members m where m.workspace_id = ws and m.user_id = remove_member.user_id and m.deleted_at is null;
  if target.id is null then raise exception 'That person is not a member'; end if;
  if target.role = 'owner' and (select count(*) from public.members m where m.workspace_id = ws and m.role = 'owner' and m.deleted_at is null) <= 1 then raise exception 'A workspace keeps at least one owner'; end if;
  update public.members m set deleted_at = now() where m.id = target.id;
end $$;

-- the RPCs are for signed-in users only
do $$
declare f text;
begin
  foreach f in array array[
    'create_workspace(text, text, boolean)', 'pending_invites()', 'domain_workspaces()', 'accept_invite(public.ulid)', 'join_by_domain(public.ulid)',
    'workspace_members(public.ulid)', 'invite_member(public.ulid, text, text)', 'revoke_invite(public.ulid)', 'remove_member(public.ulid, uuid)', 'gen_ulid()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
