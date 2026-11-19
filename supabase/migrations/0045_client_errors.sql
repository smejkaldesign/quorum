-- applied-when: select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'error_groups') and exists (select 1 from pg_proc where proname = 'admin_error_set_status' and pronamespace = 'public'::regnamespace) and exists (select 1 from pg_proc where proname = 'error_reports_purge' and pronamespace = 'public'::regnamespace)
-- Page crash reports from every install, both editions. The app catches a page that fails to render, scrubs the
-- report and posts it to the relay (POST /v1/errors, relay/errors.js), which writes it here with the service role
-- through error_report_record. Reports with the same fingerprint (the message with numbers and quoted strings
-- normalized, the top five stack frames and the view) form one group. The platform owner reads and triages the
-- groups on the admin app's Errors page through the admin_error_* functions below. The raw install id never reaches
-- the database: the relay stores a salted hash of it, so installs can be counted and nothing else.
--
-- Retention (the Privacy policy): every stored report is deleted within 90 days. error_reports_purge deletes events
-- older than 90 days and any group not seen for 90 days, except a fixed or ignored group, which keeps its row and
-- counters but loses its message and stacks. It runs on every report and hourly from the relay. platform_audit names
-- a group by fingerprint only, so no report text outlives the purge there.

create table public.error_groups (
  fingerprint text primary key check (fingerprint ~ '^[0-9a-f]{64}$'),
  -- message and the two stacks are null once the purge has cleared a stale fixed or ignored group
  message text default '',
  view text not null default '',
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  events integer not null default 0,
  installs integer not null default 0,
  repeats integer not null default 0,
  -- distinct, newest version first, at most 20
  versions text[] not null default '{}',
  editions text[] not null default '{}',
  latest_stack text default '',
  latest_component_stack text default '',
  status text not null default 'new' check (status in ('new', 'fixing', 'fixed', 'ignored')),
  -- the version the fix shipped in; an event from this version or a newer one moves a fixed group back to new
  fixed_in text,
  note text,
  updated_at timestamptz not null default now()
);
create index error_groups_status_last_seen on public.error_groups (status, last_seen desc);
create index error_groups_last_seen on public.error_groups (last_seen);
alter table public.error_groups enable row level security;
revoke all on public.error_groups from public, anon, authenticated;

-- at most 50 per group, none older than 90 days; error_report_record keeps the first and error_reports_purge the second
create table public.error_events (
  id bigint generated always as identity primary key,
  fingerprint text not null references public.error_groups (fingerprint) on delete cascade,
  install_hash text not null check (install_hash ~ '^[0-9a-f]{64}$'),
  workspace_id public.ulid references public.workspaces (id) on delete set null,
  edition text not null check (edition in ('local', 'cloud')),
  version text not null default '',
  os text not null default '',
  view text not null default '',
  kind text not null check (kind in ('render', 'main', 'renderer-gone')),
  repeat boolean not null default false,
  message text not null default '',
  stack text not null default '',
  component_stack text not null default '',
  at timestamptz not null,
  received_at timestamptz not null default now()
);
create index error_events_fingerprint_id on public.error_events (fingerprint, id desc);
create index error_events_received_at on public.error_events (received_at);
create index error_events_workspace_id_fk_idx on public.error_events (workspace_id);
alter table public.error_events enable row level security;
revoke all on public.error_events from public, anon, authenticated;

-- each install hash a group has seen, so error_groups.installs stays a distinct count after old events are trimmed
create table public.error_group_installs (
  fingerprint text not null references public.error_groups (fingerprint) on delete cascade,
  install_hash text not null check (install_hash ~ '^[0-9a-f]{64}$'),
  first_seen timestamptz not null default now(),
  primary key (fingerprint, install_hash)
);
alter table public.error_group_installs enable row level security;
revoke all on public.error_group_installs from public, anon, authenticated;

-- a version as three integers for comparing: "0.4.2" is {0,4,2}, "v1.2" is {1,2,0}, a suffix such as "-beta.1" is
-- ignored, and text with no leading number is {0,0,0}
create or replace function public.error_version_key(v text) returns integer[]
language sql immutable set search_path = '' as $$
  select coalesce(
    (select array[coalesce(m[1], '0')::integer, coalesce(m[2], '0')::integer, coalesce(m[3], '0')::integer]
       from regexp_match(coalesce(v, ''), '^\s*v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?') m where m is not null),
    array[0, 0, 0]);
$$;
revoke all on function public.error_version_key(text) from public, anon, authenticated;
grant execute on function public.error_version_key(text) to service_role;

-- the 90-day retention. Events older than 90 days go. A group not seen for 90 days goes too, with its events and
-- install hashes, unless it is fixed or ignored: then the row stays so the triage and the regression rule survive, and
-- its message, stacks and install hashes are cleared. Every step uses the received_at or last_seen index.
create or replace function public.error_reports_purge() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cutoff timestamptz := now() - interval '90 days'; ev integer; gone integer; cleared integer;
begin
  delete from public.error_events e where e.received_at < cutoff;
  get diagnostics ev = row_count;
  delete from public.error_groups g where g.last_seen < cutoff and g.status not in ('fixed', 'ignored');
  get diagnostics gone = row_count;
  delete from public.error_group_installs i using public.error_groups g where i.fingerprint = g.fingerprint and g.last_seen < cutoff;
  update public.error_groups g set message = null, latest_stack = null, latest_component_stack = null
    where g.last_seen < cutoff and (g.message is not null or g.latest_stack is not null or g.latest_component_stack is not null);
  get diagnostics cleared = row_count;
  return jsonb_build_object('events', ev, 'groups', gone, 'cleared', cleared);
end $$;
revoke all on function public.error_reports_purge() from public, anon, authenticated;
grant execute on function public.error_reports_purge() to service_role;

-- one report from the relay, already validated and clamped there: the group is created or updated, the install
-- counted once, the event kept, and the trims applied. The purge runs first, so a stale group that shows up again
-- starts over with no old report text. A fixed group goes back to new when the event comes from the
-- version it was fixed in or a newer one, and that change is written to platform_audit with no actor.
create or replace function public.error_report_record(report jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  fp text := report->>'fingerprint';
  ih text := report->>'install_hash';
  ver text := coalesce(report->>'version', '');
  ed text := report->>'edition';
  rep boolean := coalesce((report->>'repeat')::boolean, false);
  g public.error_groups;
  counted integer;
  reopened boolean;
begin
  perform public.error_reports_purge();
  insert into public.error_groups (fingerprint) values (fp) on conflict (fingerprint) do nothing;
  select * into g from public.error_groups eg where eg.fingerprint = fp for update;
  insert into public.error_group_installs (fingerprint, install_hash) values (fp, ih) on conflict do nothing;
  get diagnostics counted = row_count;
  reopened := g.status = 'fixed' and public.error_version_key(ver) >= public.error_version_key(g.fixed_in);
  update public.error_groups eg set
    message = coalesce(report->>'message', ''),
    view = coalesce(report->>'view', ''),
    last_seen = now(),
    events = eg.events + 1,
    installs = eg.installs + counted,
    repeats = eg.repeats + (case when rep then 1 else 0 end),
    versions = (select coalesce(array_agg(x.v order by public.error_version_key(x.v) desc, x.v desc), '{}')
                  from (select d.v from (select distinct u.v from unnest(eg.versions || ver) u (v) where u.v <> '') d
                        order by public.error_version_key(d.v) desc, d.v desc limit 20) x),
    editions = (select coalesce(array_agg(distinct u.e order by u.e), '{}') from unnest(eg.editions || ed) u (e)),
    latest_stack = coalesce(report->>'stack', ''),
    latest_component_stack = coalesce(report->>'component_stack', ''),
    status = case when reopened then 'new' else eg.status end,
    updated_at = now()
  where eg.fingerprint = fp;
  insert into public.error_events (fingerprint, install_hash, workspace_id, edition, version, os, view, kind, repeat, message, stack, component_stack, at)
    values (fp, ih, nullif(report->>'workspace_id', '')::public.ulid, ed, ver, coalesce(report->>'os', ''), coalesce(report->>'view', ''),
            report->>'kind', rep, coalesce(report->>'message', ''), coalesce(report->>'stack', ''), coalesce(report->>'component_stack', ''),
            coalesce((report->>'at')::timestamptz, now()));
  delete from public.error_events e where e.fingerprint = fp
    and e.id < (select k.id from public.error_events k where k.fingerprint = fp order by k.id desc offset 49 limit 1);
  if reopened then
    insert into public.platform_audit (actor, action, detail)
      values (null, 'error_reopened', jsonb_build_object('fingerprint', fp, 'version', ver, 'fixed_in', g.fixed_in));
  end if;
  return jsonb_build_object('fingerprint', fp, 'reopened', reopened, 'new_install', counted > 0);
end $$;
revoke all on function public.error_report_record(jsonb) from public, anon, authenticated;
grant execute on function public.error_report_record(jsonb) to service_role;

-- the owner's list: one status or all (null), newest activity first or most installs first, a page at a time
create or replace function public.admin_error_groups(status_filter text default null, page_size integer default 50, page_offset integer default 0, sort_by text default 'last_seen')
returns setof public.error_groups
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  if status_filter is not null and status_filter not in ('new', 'fixing', 'fixed', 'ignored') then raise exception 'A status is new, fixing, fixed or ignored'; end if;
  return query
    select * from public.error_groups g
    where status_filter is null or g.status = status_filter
    order by case when sort_by = 'installs' then g.installs end desc nulls last, g.last_seen desc, g.fingerprint
    limit least(greatest(coalesce(page_size, 50), 1), 200) offset greatest(coalesce(page_offset, 0), 0);
end $$;
revoke all on function public.admin_error_groups(text, integer, integer, text) from public, anon;
grant execute on function public.admin_error_groups(text, integer, integer, text) to authenticated, service_role;

-- how many groups hold each status, for the nav count and the filter chips
create or replace function public.admin_error_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return jsonb_build_object(
    'new', (select count(*) from public.error_groups g where g.status = 'new'),
    'fixing', (select count(*) from public.error_groups g where g.status = 'fixing'),
    'fixed', (select count(*) from public.error_groups g where g.status = 'fixed'),
    'ignored', (select count(*) from public.error_groups g where g.status = 'ignored'));
end $$;
revoke all on function public.admin_error_counts() from public, anon;
grant execute on function public.admin_error_counts() to authenticated, service_role;

-- one group with its latest 20 events and every OS its kept events came from. Events carry no install hash here:
-- the owner sees how many installs hit a group, never which.
create or replace function public.admin_error_group(fingerprint text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare g public.error_groups;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  select * into g from public.error_groups eg where eg.fingerprint = admin_error_group.fingerprint;
  if not found then raise exception 'That error group does not exist'; end if;
  return jsonb_build_object(
    'group', to_jsonb(g),
    'oses', coalesce((select jsonb_agg(distinct e.os order by e.os) from public.error_events e where e.fingerprint = g.fingerprint and e.os <> ''), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(to_jsonb(x) order by x.id desc) from (
      select e.id, e.workspace_id, e.edition, e.version, e.os, e.view, e.kind, e.repeat, e.message, e.stack, e.component_stack, e.at, e.received_at
      from public.error_events e where e.fingerprint = g.fingerprint order by e.id desc limit 20) x), '[]'::jsonb));
end $$;
revoke all on function public.admin_error_group(text) from public, anon;
grant execute on function public.admin_error_group(text) to authenticated, service_role;

-- the owner's triage: new, fixing, fixed (with the version the fix ships in) or ignored, with an optional note. The
-- version is kept only with fixed. Every change is written to platform_audit.
create or replace function public.admin_error_set_status(fingerprint text, status text, fixed_in text default null, note text default null) returns public.error_groups
language plpgsql security definer set search_path = '' as $$
declare g public.error_groups; before text; ver text := nullif(trim(coalesce(admin_error_set_status.fixed_in, '')), ''); n text := nullif(trim(coalesce(admin_error_set_status.note, '')), '');
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  if admin_error_set_status.status not in ('new', 'fixing', 'fixed', 'ignored') then raise exception 'A status is new, fixing, fixed or ignored'; end if;
  if admin_error_set_status.status = 'fixed' and (ver is null or ver !~ '^v?\d{1,9}(\.\d{1,9}){0,2}([-+][0-9A-Za-z.-]{1,30})?$') then raise exception 'Fixed needs the version the fix ships in, like 0.4.3'; end if;
  if length(coalesce(n, '')) > 2000 then raise exception 'The note is at most 2000 characters'; end if;
  select eg.status into before from public.error_groups eg where eg.fingerprint = admin_error_set_status.fingerprint for update;
  if not found then raise exception 'That error group does not exist'; end if;
  update public.error_groups eg
    set status = admin_error_set_status.status, fixed_in = case when admin_error_set_status.status = 'fixed' then ver end, note = n, updated_at = now()
    where eg.fingerprint = admin_error_set_status.fingerprint returning * into g;
  insert into public.platform_audit (actor, action, detail)
    values (auth.uid(), 'error_status', jsonb_build_object('fingerprint', g.fingerprint, 'before', before, 'status', g.status, 'fixed_in', g.fixed_in, 'note', g.note));
  return g;
end $$;
revoke all on function public.admin_error_set_status(text, text, text, text) from public, anon;
grant execute on function public.admin_error_set_status(text, text, text, text) to authenticated, service_role;
