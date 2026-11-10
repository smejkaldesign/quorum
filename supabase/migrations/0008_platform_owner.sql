-- Quorum hosted edition, step 8: the platform owner (docs/open-source-strategy.md, "Environments and administration").
-- One account per environment carries this role, outside any workspace. It lists workspaces and members, sets plans by
-- hand and reads audit rows, all through the RPCs below. Table policies stay as they were: the owner has no direct
-- read on anyone's rows. Nothing here grants the role; supabase/seed/platform-owner.sql does that for one email.

create table public.platform_owners (
  user_id uuid primary key references auth.users (id) on delete cascade,
  granted_by text not null default 'bootstrap',
  created_at timestamptz not null default now()
);
alter table public.platform_owners enable row level security;
revoke all on public.platform_owners from public, anon, authenticated;

create or replace function public.is_platform_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_owners o where o.user_id = auth.uid());
$$;

-- plans. workspaces.plan already exists (free or paid); the owner may also mark a workspace cloud (paying) or internal
-- (Quorum's own). seats_included is what the plan covers; notes is for the owner's own record. workspaces.seats and
-- hour_packs, which the relay pools, are unchanged.
alter table public.workspaces drop constraint workspaces_plan_check;
alter table public.workspaces add constraint workspaces_plan_check check (plan in ('free', 'paid', 'cloud', 'internal'));
alter table public.workspaces add column seats_included integer not null default 0 check (seats_included >= 0), add column notes text;

create table public.platform_audit (
  id public.ulid primary key default public.gen_ulid(),
  actor uuid references auth.users (id) on delete set null,
  action text not null,
  target_workspace public.ulid references public.workspaces (id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index platform_audit_created on public.platform_audit (created_at desc);
alter table public.platform_audit enable row level security;
create policy platform_audit_select on public.platform_audit for select to authenticated using (public.is_platform_owner());
revoke all on public.platform_audit from public, anon, authenticated;
grant select on public.platform_audit to authenticated;

-- RPCs. Each refuses anyone but a platform owner with the same plain sentence.

create or replace function public.platform_workspaces()
returns table (id public.ulid, name text, domain text, plan text, seats_included integer, notes text, members bigint, created_at timestamptz, last_activity timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return query
    select w.id, w.name, w.domain, w.plan, w.seats_included, w.notes,
      (select count(*) from public.members m where m.workspace_id = w.id and m.deleted_at is null),
      w.created_at,
      greatest((select max(n.updated_at) from public.notes n where n.workspace_id = w.id), (select max(g.updated_at) from public.meetings g where g.workspace_id = w.id))
    from public.workspaces w
    where w.deleted_at is null
    order by w.created_at;
end $$;

create or replace function public.platform_workspace_members(workspace_id public.ulid)
returns table (user_id uuid, email text, name text, role text, joined_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return query
    select m.user_id, p.email, p.name, m.role, m.created_at
    from public.members m left join public.profiles p on p.user_id = m.user_id
    where m.workspace_id = platform_workspace_members.workspace_id and m.deleted_at is null
    order by m.created_at;
end $$;

create or replace function public.platform_set_plan(workspace_id public.ulid, plan text, seats_included integer default 0, notes text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare before jsonb; after jsonb;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  if platform_set_plan.plan not in ('free', 'paid', 'cloud', 'internal') then raise exception 'A plan is free, paid, cloud or internal'; end if;
  if coalesce(platform_set_plan.seats_included, 0) < 0 then raise exception 'Seats included cannot be negative'; end if;
  select jsonb_build_object('plan', w.plan, 'seats_included', w.seats_included, 'notes', w.notes) into before
    from public.workspaces w where w.id = platform_set_plan.workspace_id and w.deleted_at is null;
  if before is null then raise exception 'That workspace no longer exists'; end if;
  update public.workspaces w
    set plan = platform_set_plan.plan, seats_included = coalesce(platform_set_plan.seats_included, 0), notes = nullif(trim(coalesce(platform_set_plan.notes, '')), '')
    where w.id = platform_set_plan.workspace_id
    returning jsonb_build_object('plan', w.plan, 'seats_included', w.seats_included, 'notes', w.notes) into after;
  insert into public.platform_audit (actor, action, target_workspace, detail)
    values (auth.uid(), 'set_plan', platform_set_plan.workspace_id, jsonb_build_object('before', before, 'after', after));
  return after;
end $$;

-- usage for one calendar period, grouped by step: speech rows carry seconds, summary and notes rows are model calls
-- (seconds 0). managed is the part on Quorum's keys, the part that counts against the allowance.
create or replace function public.platform_usage(workspace_id public.ulid, period_start timestamptz default date_trunc('month', now()))
returns table (role text, calls bigint, hours numeric, managed_hours numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return query
    select e.role, count(*), round(sum(e.seconds) / 3600.0, 2), round(coalesce(sum(e.seconds) filter (where e.connector_id is null), 0) / 3600.0, 2)
    from public.workspace_usage_events e
    where e.workspace_id = platform_usage.workspace_id and e.created_at >= platform_usage.period_start and e.created_at < platform_usage.period_start + interval '1 month'
    group by e.role
    order by e.role;
end $$;

do $$
declare f text;
begin
  foreach f in array array['is_platform_owner()', 'platform_workspaces()', 'platform_workspace_members(public.ulid)', 'platform_set_plan(public.ulid, text, integer, text)', 'platform_usage(public.ulid, timestamptz)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
