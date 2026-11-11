-- applied-when: select exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = 'access_requests')
-- Quorum hosted edition, step 16: beta access requests and the admin app's reads (docs/open-source-strategy.md,
-- "Environments and administration"). A visitor asks for access on quorum.watch; the relay writes the request with the
-- service role; the platform owner sees it in the admin app and turns it into an access code (migration 0009) or
-- declines it. The owner-only RPCs below also give the admin app the users list and the overview counts.

create table public.access_requests (
  id public.ulid primary key default public.gen_ulid(),
  email text not null check (email = lower(email)),
  name text,
  note text,
  source text not null default 'site',
  status text not null default 'pending' check (status in ('pending', 'invited', 'declined')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null,
  code_id public.ulid references public.access_codes (id) on delete set null,
  admin_note text
);
-- one open request per email; a second ask while one is pending returns the first
create unique index access_requests_open_email on public.access_requests (email) where status = 'pending';
create index access_requests_created on public.access_requests (created_at desc);
alter table public.access_requests enable row level security;
-- no policies on purpose: the relay writes with the service role, the owner reads through the RPCs below
revoke all on public.access_requests from public, anon, authenticated;

-- the relay's write. Bounded fields, lowercased email, and a pending request for the same email is returned as is
create or replace function public.access_request_create(email text, name text default null, note text default null, source text default 'site') returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text; existing public.access_requests; row_out public.access_requests;
begin
  e := lower(trim(coalesce(access_request_create.email, '')));
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(e) > 254 then raise exception 'Enter a full email address'; end if;
  select * into existing from public.access_requests r where r.email = e and r.status = 'pending';
  if found then return jsonb_build_object('id', existing.id, 'status', existing.status, 'already', true); end if;
  insert into public.access_requests (email, name, note, source)
    values (e, nullif(left(trim(coalesce(access_request_create.name, '')), 120), ''), nullif(left(trim(coalesce(access_request_create.note, '')), 1000), ''), coalesce(nullif(left(trim(coalesce(access_request_create.source, '')), 40), ''), 'site'))
    returning * into row_out;
  return jsonb_build_object('id', row_out.id, 'status', row_out.status, 'already', false);
end $$;
revoke all on function public.access_request_create(text, text, text, text) from public, anon, authenticated;
grant execute on function public.access_request_create(text, text, text, text) to service_role;

-- the owner's list, newest first, with the code a request turned into
create or replace function public.platform_access_requests()
returns table (id public.ulid, email text, name text, note text, source text, status text, created_at timestamptz, decided_at timestamptz, admin_note text, code_id public.ulid, code text, code_expires_at timestamptz, code_redeemed_at timestamptz, code_revoked_at timestamptz, has_account boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return query
    select r.id, r.email, r.name, r.note, r.source, r.status, r.created_at, r.decided_at, r.admin_note, r.code_id, c.code, c.expires_at, c.redeemed_at, c.revoked_at,
      exists (select 1 from auth.users u where lower(u.email) = r.email)
    from public.access_requests r left join public.access_codes c on c.id = r.code_id
    order by (r.status = 'pending') desc, r.created_at desc;
end $$;

-- a request becomes an access code for its email (platform_issue_access_code revokes any older open code and writes the audit row)
create or replace function public.platform_invite_request(id public.ulid, days integer default 30, note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.access_requests; issued jsonb;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  select * into r from public.access_requests a where a.id = platform_invite_request.id;
  if not found then raise exception 'That request no longer exists'; end if;
  issued := public.platform_issue_access_code(r.email, coalesce(nullif(trim(coalesce(platform_invite_request.note, '')), ''), r.name), coalesce(platform_invite_request.days, 30));
  update public.access_requests a set status = 'invited', decided_at = now(), decided_by = auth.uid(), code_id = (issued->>'id')::public.ulid, admin_note = nullif(trim(coalesce(platform_invite_request.note, '')), '')
    where a.id = platform_invite_request.id;
  insert into public.platform_audit (actor, action, detail) values (auth.uid(), 'invite_request', jsonb_build_object('email', r.email, 'request', r.id));
  return issued || jsonb_build_object('request_id', r.id, 'name', r.name);
end $$;

-- the owner adds a person who never asked (source admin); the admin app approves it in the same step
create or replace function public.platform_add_request(email text, name text default null, note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return public.access_request_create(platform_add_request.email, platform_add_request.name, platform_add_request.note, 'admin');
end $$;

create or replace function public.platform_decline_request(id public.ulid, note text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare r public.access_requests;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  update public.access_requests a set status = 'declined', decided_at = now(), decided_by = auth.uid(), admin_note = nullif(trim(coalesce(platform_decline_request.note, '')), '')
    where a.id = platform_decline_request.id and a.status = 'pending' returning * into r;
  if not found then raise exception 'That request is not pending'; end if;
  insert into public.platform_audit (actor, action, detail) values (auth.uid(), 'decline_request', jsonb_build_object('email', r.email, 'request', r.id));
  return true;
end $$;

-- every account on this Quorum: when it was made, when it last signed in, how many workspaces it belongs to
create or replace function public.platform_users()
returns table (user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz, workspaces bigint, owner boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return query
    select u.id, u.email::text, u.created_at, u.last_sign_in_at,
      (select count(*) from public.members m where m.user_id = u.id and m.deleted_at is null),
      exists (select 1 from public.platform_owners o where o.user_id = u.id)
    from auth.users u
    order by u.created_at desc;
end $$;

-- the admin app's first screen: counts, and the managed hours used on Quorum's keys this calendar month
create or replace function public.platform_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare month_start timestamptz := date_trunc('month', now());
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return jsonb_build_object(
    'users', (select count(*) from auth.users),
    'workspaces', (select count(*) from public.workspaces w where w.deleted_at is null),
    'paid_workspaces', (select count(*) from public.workspaces w where w.deleted_at is null and w.plan in ('paid', 'cloud')),
    'members', (select count(*) from public.members m where m.deleted_at is null),
    'codes_open', (select count(*) from public.access_codes c where c.redeemed_at is null and c.revoked_at is null and c.expires_at > now()),
    'requests_pending', (select count(*) from public.access_requests r where r.status = 'pending'),
    'managed_hours_month', (select round(coalesce(sum(e.seconds) filter (where e.connector_id is null), 0) / 3600.0, 2) from public.workspace_usage_events e where e.created_at >= month_start),
    'month_start', month_start
  );
end $$;

do $$ declare f text; begin
  foreach f in array array['platform_access_requests()', 'platform_invite_request(public.ulid, integer, text)', 'platform_add_request(text, text, text)', 'platform_decline_request(public.ulid, text)', 'platform_users()', 'platform_overview()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
