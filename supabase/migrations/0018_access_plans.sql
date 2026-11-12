-- applied-when: select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'access_codes' and column_name = 'plan')
-- Quorum hosted edition, step 18: beta installs and the plan an access code carries. During the beta every install is
-- gated by a code, the open-source edition included: the app asks the relay to check its code (POST /v1/beta/check)
-- and reports a heartbeat (POST /v1/beta/heartbeat), both written here with the service role. Approving a request
-- picks the plan the person lands on (free or cloud); a cloud code puts the workspace the person creates on the cloud
-- plan, the same comped service the owner can set by hand (migration 0008). The request row learns when its email
-- signed in, so the admin app can show who is in and who installed.

alter table public.access_codes
  add column plan text not null default 'free' check (plan in ('free', 'cloud')),
  add column granted_workspace_id public.ulid references public.workspaces (id) on delete set null,
  -- a free code is used up by the first Mac that enters it; the relay records that Mac here
  add column redeemed_machine_id text;

alter table public.access_requests
  add column user_id uuid references auth.users (id) on delete set null,
  add column signed_in_at timestamptz;

create table public.beta_installs (
  id uuid primary key default gen_random_uuid(),
  code_id public.ulid not null references public.access_codes (id) on delete cascade,
  email text,
  machine_id text not null,
  edition text not null check (edition in ('local', 'cloud')),
  app_version text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique (code_id, machine_id)
);
create index beta_installs_last_seen on public.beta_installs (last_seen desc);
alter table public.beta_installs enable row level security;
-- no policies on purpose: the relay writes and reads with the service role, the owner reads through platform_installs
revoke all on public.beta_installs from public, anon, authenticated;

-- issuing a code takes the plan it grants; the three-argument form goes so a named call stays unambiguous
drop function if exists public.platform_issue_access_code(text, text, integer);
create or replace function public.platform_issue_access_code(email text, note text default null, days integer default 30, plan text default 'free') returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text; p text; row_out jsonb;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  e := lower(trim(coalesce(platform_issue_access_code.email, '')));
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a full email address'; end if;
  if coalesce(platform_issue_access_code.days, 30) not between 1 and 365 then raise exception 'A code lasts between 1 and 365 days'; end if;
  p := coalesce(nullif(lower(trim(platform_issue_access_code.plan)), ''), 'free');
  if p not in ('free', 'cloud') then raise exception 'A code grants the free or the cloud plan'; end if;
  update public.access_codes a set revoked_at = now() where a.email = e and a.redeemed_at is null and a.revoked_at is null;
  insert into public.access_codes (email, code, note, issued_by, expires_at, plan)
    values (e, public.gen_access_code(), nullif(trim(coalesce(platform_issue_access_code.note, '')), ''), auth.uid(), now() + make_interval(days => coalesce(platform_issue_access_code.days, 30)), p)
    returning jsonb_build_object('id', id, 'email', access_codes.email, 'code', code, 'note', access_codes.note, 'issued_at', issued_at, 'expires_at', expires_at, 'plan', access_codes.plan) into row_out;
  insert into public.platform_audit (actor, action, detail) values (auth.uid(), 'issue_access_code', jsonb_build_object('email', e, 'plan', p));
  return row_out;
end $$;

-- the owner's list, with the plan each code grants, whether the person installed, and when the email signed in
drop function if exists public.platform_access_requests();
create or replace function public.platform_access_requests()
returns table (id public.ulid, email text, name text, note text, source text, status text, created_at timestamptz, decided_at timestamptz, admin_note text, code_id public.ulid, code text, code_plan text, code_expires_at timestamptz, code_redeemed_at timestamptz, code_revoked_at timestamptz, has_account boolean, signed_in_at timestamptz, installed boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return query
    select r.id, r.email, r.name, r.note, r.source, r.status, r.created_at, r.decided_at, r.admin_note, r.code_id, c.code, c.plan, c.expires_at, c.redeemed_at, c.revoked_at,
      exists (select 1 from auth.users u where lower(u.email) = r.email),
      coalesce(r.signed_in_at, (select u.last_sign_in_at from auth.users u where lower(u.email) = r.email limit 1)),
      exists (select 1 from public.beta_installs i where i.code_id = r.code_id)
    from public.access_requests r left join public.access_codes c on c.id = r.code_id
    order by (r.status = 'pending') desc, r.created_at desc;
end $$;

-- approving a request issues its code with the plan the owner picked
drop function if exists public.platform_invite_request(public.ulid, integer, text);
create or replace function public.platform_invite_request(id public.ulid, days integer default 30, note text default null, plan text default 'free') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.access_requests; issued jsonb;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  select * into r from public.access_requests a where a.id = platform_invite_request.id;
  if not found then raise exception 'That request no longer exists'; end if;
  issued := public.platform_issue_access_code(r.email, coalesce(nullif(trim(coalesce(platform_invite_request.note, '')), ''), r.name), coalesce(platform_invite_request.days, 30), platform_invite_request.plan);
  -- approving the same email again (a fresh request after a revoke or an expiry) carries the installs its earlier
  -- codes recorded onto the new code, so the row still says Installed and the Mac's next check finds its install
  update public.beta_installs i set code_id = (issued->>'id')::public.ulid where i.code_id in (select a.id from public.access_codes a where a.email = r.email and a.id <> (issued->>'id')::public.ulid);
  update public.access_requests a set status = 'invited', decided_at = now(), decided_by = auth.uid(), code_id = (issued->>'id')::public.ulid, admin_note = nullif(trim(coalesce(platform_invite_request.note, '')), '')
    where a.id = platform_invite_request.id;
  insert into public.platform_audit (actor, action, detail) values (auth.uid(), 'invite_request', jsonb_build_object('email', r.email, 'request', r.id, 'plan', issued->>'plan'));
  return issued || jsonb_build_object('request_id', r.id, 'name', r.name);
end $$;

-- an approved person moves between free and cloud in place: the code's plan changes, and the one workspace the code
-- itself put on a plan follows. A code that granted no workspace yet only changes what the next sign-up gets; no
-- other workspace is guessed at. Nothing is reissued.
create or replace function public.platform_set_code_plan(code_id public.ulid, plan text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.access_codes; p text; ws public.ulid;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  p := coalesce(nullif(lower(trim(platform_set_code_plan.plan)), ''), 'free');
  if p not in ('free', 'cloud') then raise exception 'A code grants the free or the cloud plan'; end if;
  select * into c from public.access_codes a where a.id = platform_set_code_plan.code_id;
  if not found then raise exception 'That code no longer exists'; end if;
  if c.revoked_at is not null then raise exception 'That code was revoked; approve the request again'; end if;
  update public.access_codes a set plan = p where a.id = c.id;
  ws := c.granted_workspace_id;
  if ws is not null and (select w.plan from public.workspaces w where w.id = ws) in ('free', 'cloud') then
    update public.workspaces w set plan = case when p = 'cloud' then 'cloud' else 'free' end, seats_included = case when p = 'cloud' then greatest(w.seats_included, 1) else w.seats_included end where w.id = ws;
  end if;
  insert into public.platform_audit (actor, action, target_workspace, detail) values (auth.uid(), 'set_code_plan', ws, jsonb_build_object('email', c.email, 'plan', p));
  return jsonb_build_object('id', c.id, 'plan', p, 'workspace', ws);
end $$;

-- the owner's view of every install: who (by the code's email), which edition and version, and when it was last seen
create or replace function public.platform_installs()
returns table (id uuid, code_id public.ulid, email text, plan text, machine_id text, edition text, app_version text, first_seen timestamptz, last_seen timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return query
    select i.id, i.code_id, coalesce(i.email, c.email), c.plan, i.machine_id, i.edition, i.app_version, i.first_seen, i.last_seen
    from public.beta_installs i join public.access_codes c on c.id = i.code_id
    order by i.last_seen desc;
end $$;

-- sign-up redeems the code as before and marks the request the code came from. A pending workspace invite still
-- admits an email without a code; when that email also holds a claimed code, the code is redeemed all the same, so a
-- cloud code's plan reaches the workspace the person creates and the request row shows them signed in.
create or replace function public.auth_user_gate() returns trigger
language plpgsql security definer set search_path = public as $$
declare c public.access_codes; invited boolean;
begin
  invited := exists (select 1 from public.invites i where i.email = lower(new.email) and i.accepted_at is null and i.deleted_at is null and i.expires_at > now());
  update public.access_codes a set redeemed_at = now(), redeemed_by = new.id
    where a.email = lower(new.email) and a.redeemed_at is null and a.revoked_at is null and a.expires_at > now() and (invited or a.claimed_at > now() - interval '1 hour')
    returning * into c;
  if not found and not invited then raise exception 'An access code is needed to sign up for Quorum Cloud'; end if;
  if c.id is not null then update public.access_requests r set user_id = new.id, signed_in_at = now() where r.code_id = c.id; end if;
  return new;
end $$;

-- a workspace created by a person whose code grants cloud starts on the cloud plan with one seat included
create or replace function public.create_workspace(name text, domain text default null, domain_join boolean default true) returns public.workspaces
language plpgsql security definer set search_path = public as $$
declare ws public.workspaces; d text; c public.access_codes;
begin
  if auth.uid() is null then raise exception 'You need to sign in first'; end if;
  d := nullif(lower(trim(create_workspace.domain)), '');
  if d is not null and public.is_public_mail_domain(d) then d := null; end if;
  insert into public.workspaces (id, user_id, name, domain, domain_join)
  values (public.gen_ulid(), auth.uid(), coalesce(nullif(trim(create_workspace.name), ''), 'My workspace'), d, d is not null and coalesce(create_workspace.domain_join, true))
  returning * into ws;
  select * into c from public.access_codes a where a.redeemed_by = auth.uid() and a.plan = 'cloud' and a.granted_workspace_id is null order by a.redeemed_at desc limit 1;
  if found then
    update public.workspaces w set plan = 'cloud', seats_included = greatest(w.seats_included, 1) where w.id = ws.id returning * into ws;
    update public.access_codes a set granted_workspace_id = ws.id where a.id = c.id;
  end if;
  return ws;
end $$;

do $$ declare f text; begin
  foreach f in array array['platform_issue_access_code(text, text, integer, text)', 'platform_access_requests()', 'platform_invite_request(public.ulid, integer, text, text)', 'platform_set_code_plan(public.ulid, text)', 'platform_installs()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
