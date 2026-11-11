-- applied-when: select exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = 'platform_passkeys')
-- Quorum hosted edition, step 17: the platform owner's passkey. Signing in with the email code proves the inbox; the
-- admin app then asks for a passkey (WebAuthn, verified by the relay: relay/passkeys.js), and the relay writes a
-- short-lived session whose token the admin app sends on every request as the x-quorum-passkey header. From the
-- moment the owner has registered one passkey, is_platform_owner() is true only while such a session is live, so the
-- owner-only RPCs refuse a bare email-code session even if it is the owner's. A deployment whose owner never
-- registered a passkey keeps working as before.
create extension if not exists pgcrypto with schema extensions;

create table public.platform_passkeys (
  id public.ulid primary key default public.gen_ulid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index platform_passkeys_user on public.platform_passkeys (user_id);
alter table public.platform_passkeys enable row level security;
revoke all on public.platform_passkeys from public, anon, authenticated;

create table public.platform_sessions (
  id public.ulid primary key default public.gen_ulid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz
);
create index platform_sessions_user on public.platform_sessions (user_id, expires_at desc);
alter table public.platform_sessions enable row level security;
revoke all on public.platform_sessions from public, anon, authenticated;

-- true when the caller has no passkey yet, or presented a live session token in the x-quorum-passkey header
create or replace function public.platform_passkey_ok() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); hdr text;
begin
  if uid is null then return false; end if;
  if not exists (select 1 from public.platform_passkeys p where p.user_id = uid) then return true; end if;
  hdr := nullif(trim(coalesce(current_setting('request.headers', true), '{}')::json->>'x-quorum-passkey'), '');
  if hdr is null then return false; end if;
  return exists (select 1 from public.platform_sessions s where s.user_id = uid and s.token_hash = encode(extensions.digest(hdr, 'sha256'), 'hex') and s.expires_at > now());
end $$;
revoke all on function public.platform_passkey_ok() from public, anon;
grant execute on function public.platform_passkey_ok() to authenticated, service_role;

create or replace function public.is_platform_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_owners o where o.user_id = auth.uid()) and public.platform_passkey_ok();
$$;

-- what the admin app asks before anything else: is this account the owner, and does it have a passkey to present
create or replace function public.platform_owner_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  return jsonb_build_object(
    'owner', uid is not null and exists (select 1 from public.platform_owners o where o.user_id = uid),
    'passkeys', (select count(*) from public.platform_passkeys p where p.user_id = uid),
    'session', public.platform_passkey_ok() and exists (select 1 from public.platform_passkeys p where p.user_id = uid)
  );
end $$;
revoke all on function public.platform_owner_status() from public, anon;
grant execute on function public.platform_owner_status() to authenticated, service_role;

-- sessions older than their expiry are of no use; the relay removes them when it writes a new one
create or replace function public.platform_sessions_sweep() returns void
language sql security definer set search_path = public as $$
  delete from public.platform_sessions where expires_at < now() - interval '1 day';
$$;
revoke all on function public.platform_sessions_sweep() from public, anon, authenticated;
grant execute on function public.platform_sessions_sweep() to service_role;
