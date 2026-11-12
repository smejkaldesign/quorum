-- applied-when: select exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = 'feature_flags')
-- Feature flags: one table of named switches the platform owner flips from the admin app. Every install, both
-- editions, reads the public view of it through the relay (GET /v1/flags: key and enabled only) on launch and every
-- hour, so a feature can be put away or brought back without a release. The rows themselves are owner-only; the
-- public function hides everything but the switch and the parent it needs. The seeded keys hold the notetaker
-- features of 0.3.0 so the code stays while the product leans on connected notetakers: meeting capture and live
-- assistance start off; manual listening and screen context (which needs it) stay on.
create table public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  name text not null,
  description text not null default '',
  enabled boolean not null default false,
  tags text[] not null default '{}',
  -- the key of a parent flag this one needs: while the parent is off, an install reads this one as off too
  requires text references public.feature_flags (key) on update cascade on delete set null check (requires is null or requires <> key),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.feature_flags enable row level security;
revoke all on public.feature_flags from public, anon, authenticated;

-- the owner's full list, newest first; anyone else gets the same refusal the write functions give
create or replace function public.platform_flags() returns setof public.feature_flags
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return query select * from public.feature_flags order by created_at desc;
end $$;

-- the limits the admin app also checks: a name of 80 characters, a description of 500, at most 20 tags of 40
create or replace function public.flag_fields_check(name text, description text, tags text[]) returns void
language plpgsql immutable set search_path = public as $$
begin
  if nullif(trim(coalesce(flag_fields_check.name, '')), '') is null then raise exception 'A flag needs a name'; end if;
  if length(trim(flag_fields_check.name)) > 80 then raise exception 'The name is at most 80 characters'; end if;
  if length(coalesce(flag_fields_check.description, '')) > 500 then raise exception 'The description is at most 500 characters'; end if;
  if coalesce(cardinality(flag_fields_check.tags), 0) > 20 then raise exception 'A flag has at most 20 tags'; end if;
  if exists (select 1 from unnest(coalesce(flag_fields_check.tags, '{}')) t where length(t) > 40 or length(trim(t)) = 0) then raise exception 'Each tag is 1 to 40 characters'; end if;
end $$;
revoke all on function public.flag_fields_check(text, text, text[]) from public, anon, authenticated;
revoke all on function public.platform_flags() from public, anon;
grant execute on function public.platform_flags() to authenticated, service_role;

create or replace function public.platform_flag_set(key text, enabled boolean) returns public.feature_flags
language plpgsql security definer set search_path = public as $$
declare f public.feature_flags;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  update public.feature_flags ff set enabled = coalesce(platform_flag_set.enabled, false), updated_at = now() where ff.key = platform_flag_set.key returning * into f;
  if not found then raise exception 'That flag does not exist'; end if;
  insert into public.platform_audit (actor, action, detail) values (auth.uid(), 'flag_set', jsonb_build_object('key', f.key, 'enabled', f.enabled));
  return f;
end $$;
revoke all on function public.platform_flag_set(text, boolean) from public, anon;
grant execute on function public.platform_flag_set(text, boolean) to authenticated, service_role;

create or replace function public.platform_flag_create(key text, name text, description text default '', tags text[] default '{}') returns public.feature_flags
language plpgsql security definer set search_path = public as $$
declare f public.feature_flags; k text;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  k := lower(trim(coalesce(platform_flag_create.key, '')));
  if k !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' or length(k) > 60 then raise exception 'A key is up to 60 lowercase letters, digits and hyphens, like dark-mode'; end if;
  perform public.flag_fields_check(platform_flag_create.name, platform_flag_create.description, platform_flag_create.tags);
  if exists (select 1 from public.feature_flags ff where ff.key = k) then raise exception 'A flag with that key already exists'; end if;
  insert into public.feature_flags (key, name, description, tags)
    values (k, trim(platform_flag_create.name), coalesce(platform_flag_create.description, ''), coalesce(platform_flag_create.tags, '{}'))
    returning * into f;
  insert into public.platform_audit (actor, action, detail) values (auth.uid(), 'flag_create', jsonb_build_object('key', f.key, 'name', f.name));
  return f;
end $$;
revoke all on function public.platform_flag_create(text, text, text, text[]) from public, anon;
grant execute on function public.platform_flag_create(text, text, text, text[]) to authenticated, service_role;

create or replace function public.platform_flag_update(key text, name text, description text default '', tags text[] default '{}') returns public.feature_flags
language plpgsql security definer set search_path = public as $$
declare f public.feature_flags;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  perform public.flag_fields_check(platform_flag_update.name, platform_flag_update.description, platform_flag_update.tags);
  update public.feature_flags ff
    set name = trim(platform_flag_update.name), description = coalesce(platform_flag_update.description, ''), tags = coalesce(platform_flag_update.tags, '{}'), updated_at = now()
    where ff.key = platform_flag_update.key returning * into f;
  if not found then raise exception 'That flag does not exist'; end if;
  insert into public.platform_audit (actor, action, detail) values (auth.uid(), 'flag_update', jsonb_build_object('key', f.key, 'name', f.name));
  return f;
end $$;
revoke all on function public.platform_flag_update(text, text, text, text[]) from public, anon;
grant execute on function public.platform_flag_update(text, text, text, text[]) to authenticated, service_role;

-- the parent a flag needs, set or cleared by the owner; a flag cannot need itself or one that needs it back
create or replace function public.platform_flag_requires(key text, requires text) returns public.feature_flags
language plpgsql security definer set search_path = public as $$
declare f public.feature_flags; parent text := nullif(trim(coalesce(platform_flag_requires.requires, '')), '');
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  if parent is not null and not exists (select 1 from public.feature_flags ff where ff.key = parent) then raise exception 'That parent flag does not exist'; end if;
  if parent = platform_flag_requires.key then raise exception 'A flag cannot need itself'; end if;
  if parent is not null and exists (select 1 from public.feature_flags ff where ff.key = parent and ff.requires = platform_flag_requires.key) then raise exception 'That parent already needs this flag'; end if;
  update public.feature_flags ff set requires = parent, updated_at = now() where ff.key = platform_flag_requires.key returning * into f;
  if not found then raise exception 'That flag does not exist'; end if;
  insert into public.platform_audit (actor, action, detail) values (auth.uid(), 'flag_requires', jsonb_build_object('key', f.key, 'requires', f.requires));
  return f;
end $$;
revoke all on function public.platform_flag_requires(text, text) from public, anon;
grant execute on function public.platform_flag_requires(text, text) to authenticated, service_role;

-- what every install may read: the switch per key and the parent it needs, nothing else
create or replace function public.public_flags() returns table (key text, enabled boolean, requires text)
language sql stable security definer set search_path = public as $$
  select ff.key, ff.enabled, ff.requires from public.feature_flags ff order by ff.key;
$$;
revoke all on function public.public_flags() from public;
grant execute on function public.public_flags() to anon, authenticated, service_role;

insert into public.feature_flags (key, name, description, enabled, tags) values
  ('meeting-capture', 'Meeting capture', 'Quorum detects Zoom, Google Meet and Teams calls and offers to listen', false, '{notetaker}'),
  ('live-assist', 'Live assistance', 'Suggestion cards and speaker naming during a session', false, '{notetaker}'),
  ('manual-listen', 'Manual listening', 'Start listening, dictation, the live transcript, the running summary and the note a session writes', true, '{notetaker,listening}')
on conflict (key) do nothing;
insert into public.feature_flags (key, name, description, enabled, tags, requires) values
  ('screen-context', 'Screen context', 'Screen vocabulary that feeds the running summary while listening. Needs manual-listen.', true, '{listening}', 'manual-listen')
on conflict (key) do nothing;
