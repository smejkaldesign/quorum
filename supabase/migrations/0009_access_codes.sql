-- applied-when: select exists(select 1 from pg_trigger where tgname = 'access_code_gate')
-- Access codes: Cloud sign-up is closed. The platform owner issues one code per email from Settings › Admin › Platform;
-- the app checks the code before it asks Supabase for a sign-in email, and a trigger on auth.users refuses a new account
-- whose email has no claimed code (a pending workspace invite counts too). Existing accounts are untouched.

create table public.access_codes (
  id public.ulid primary key default public.gen_ulid(),
  email text not null check (email = lower(email)),
  code text not null check (code ~ '^[A-Z2-9]{8}$'),
  note text,
  issued_by uuid references auth.users (id) on delete set null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  claimed_at timestamptz,
  redeemed_at timestamptz,
  redeemed_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz
);
-- one open code per email; a new one revokes the old
create unique index access_codes_open_email on public.access_codes (email) where redeemed_at is null and revoked_at is null;
create index access_codes_issued on public.access_codes (issued_at desc);
alter table public.access_codes enable row level security;
-- no policies on purpose: only the security-definer functions below read or write the table

-- 8 characters from an alphabet without 0/O and 1/I, shown to people as XXXX-XXXX
create or replace function public.gen_access_code() returns text
language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 8);
$$;

create or replace function public.platform_issue_access_code(email text, note text default null, days integer default 30) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e text; row_out jsonb;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  e := lower(trim(coalesce(platform_issue_access_code.email, '')));
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a full email address'; end if;
  if coalesce(platform_issue_access_code.days, 30) not between 1 and 365 then raise exception 'A code lasts between 1 and 365 days'; end if;
  update public.access_codes a set revoked_at = now() where a.email = e and a.redeemed_at is null and a.revoked_at is null;
  insert into public.access_codes (email, code, note, issued_by, expires_at)
    values (e, public.gen_access_code(), nullif(trim(coalesce(platform_issue_access_code.note, '')), ''), auth.uid(), now() + make_interval(days => coalesce(platform_issue_access_code.days, 30)))
    returning jsonb_build_object('id', id, 'email', access_codes.email, 'code', code, 'note', access_codes.note, 'issued_at', issued_at, 'expires_at', expires_at) into row_out;
  insert into public.platform_audit (actor, action, detail) values (auth.uid(), 'issue_access_code', jsonb_build_object('email', e));
  return row_out;
end $$;

create or replace function public.platform_access_codes()
returns table (id public.ulid, email text, code text, note text, issued_at timestamptz, expires_at timestamptz, claimed_at timestamptz, redeemed_at timestamptz, revoked_at timestamptz, redeemed_email text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return query select a.id, a.email, a.code, a.note, a.issued_at, a.expires_at, a.claimed_at, a.redeemed_at, a.revoked_at, u.email::text
    from public.access_codes a left join auth.users u on u.id = a.redeemed_by
    order by a.issued_at desc limit 500;
end $$;

create or replace function public.platform_revoke_access_code(id public.ulid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  update public.access_codes a set revoked_at = now() where a.id = platform_revoke_access_code.id and a.redeemed_at is null and a.revoked_at is null;
  if not found then raise exception 'That code is already used or revoked'; end if;
  insert into public.platform_audit (actor, action, detail) values (auth.uid(), 'revoke_access_code', jsonb_build_object('id', platform_revoke_access_code.id));
  return true;
end $$;

-- the app asks this before Send code: an email with an account or a pending invite needs no access code
create or replace function public.access_code_needed(email text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare e text := lower(trim(coalesce(access_code_needed.email, '')));
begin
  if exists (select 1 from auth.users u where lower(u.email) = e) then return false; end if;
  if exists (select 1 from public.invites i where i.email = e and i.accepted_at is null and i.deleted_at is null and i.expires_at > now()) then return false; end if;
  return true;
end $$;

-- the code typed in the app; a claim is good for an hour, long enough to receive and enter the sign-in email
create or replace function public.access_code_claim(email text, code text) returns boolean
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(coalesce(access_code_claim.email, ''))); c text := upper(regexp_replace(coalesce(access_code_claim.code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  update public.access_codes a set claimed_at = now()
    where a.email = e and a.code = c and a.redeemed_at is null and a.revoked_at is null and a.expires_at > now();
  if not found then raise exception 'That access code is not valid for this email'; end if;
  return true;
end $$;

-- the gate itself: a new auth user needs a code claimed within the hour, or a pending invite to a workspace
create or replace function public.auth_user_gate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.invites i where i.email = lower(new.email) and i.accepted_at is null and i.deleted_at is null and i.expires_at > now()) then return new; end if;
  update public.access_codes a set redeemed_at = now(), redeemed_by = new.id
    where a.email = lower(new.email) and a.redeemed_at is null and a.revoked_at is null and a.expires_at > now() and a.claimed_at > now() - interval '1 hour';
  if not found then raise exception 'An access code is needed to sign up for Quorum Cloud'; end if;
  return new;
end $$;
drop trigger if exists access_code_gate on auth.users;
-- after insert, so redeemed_by can reference the new row; the exception still aborts the sign-up
create trigger access_code_gate after insert on auth.users for each row execute function public.auth_user_gate();

do $$ declare f text; begin
  foreach f in array array['platform_issue_access_code(text, text, integer)', 'platform_access_codes()', 'platform_revoke_access_code(public.ulid)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['access_code_needed(text)', 'access_code_claim(text, text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', f);
  end loop;
  revoke all on function public.gen_access_code() from public;
end $$;
