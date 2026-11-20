-- applied-when: select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'issue_reports') and exists (select 1 from storage.buckets where id = 'issue-reports') and exists (select 1 from pg_proc where proname = 'admin_issue_report_set_status' and pronamespace = 'public'::regnamespace)
-- Issue reports a person sends from the app (Report issue in the avatar menu, or Report as issue on an error). The app
-- shows the person everything that goes out, then posts it to the relay (POST /v1/reports, relay/reports.js), which
-- checks it again, puts the screenshots in the private issue-reports bucket and writes the row here with the service
-- role through issue_report_record. Nothing goes to GitHub from here: the platform owner reads the reports on the admin
-- app's Reports page through the admin_issue_* functions below and files an issue by hand. The raw install id never
-- reaches the database: the relay stores a salted hash of it, the same way error reports do (migration 0045). A
-- signed-in Cloud person may attach their account; the relay takes the account from the session token, never from the
-- body.
--
-- Retention (the Privacy policy): every report is deleted within 90 days. Storage objects cannot be deleted from SQL,
-- so issue_reports_expired lists the expired rows and their screenshots, the relay deletes the objects through the
-- Storage API, and issue_reports_delete removes the rows. The same sweep deletes screenshots older than a day whose
-- folder has no row (a relay that stopped between upload and row), using issue_reports_missing. The relay runs it hourly.
-- platform_audit names a report by id only, so no report text outlives the purge there.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('issue-reports', 'issue-reports', false, 2097152, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;
-- no storage.objects policy for this bucket: only the service role (the relay) reads or writes it, and the admin app
-- gets short-lived signed links from the relay after the owner check

create table public.issue_reports (
  id uuid primary key,
  install_hash text not null check (install_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid references auth.users (id) on delete set null,
  workspace_id public.ulid references public.workspaces (id) on delete set null,
  edition text not null check (edition in ('local', 'cloud')),
  version text not null default '',
  os text not null default '',
  view text not null default '',
  title text not null default '',
  description text not null default '',
  -- the log lines the person kept, already masked in the app and checked again by the relay
  log_lines text[] not null default '{}',
  run_id text,
  -- object keys in the issue-reports bucket, "<id>/<n>.png" or ".jpg", at most 5
  screenshots text[] not null default '{}' check (cardinality(screenshots) <= 5),
  status text not null default 'new' check (status in ('new', 'filed', 'closed', 'ignored')),
  note text,
  at timestamptz not null,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index issue_reports_status_received on public.issue_reports (status, received_at desc);
create index issue_reports_received_at on public.issue_reports (received_at);
create index issue_reports_user_id_fk_idx on public.issue_reports (user_id);
create index issue_reports_workspace_id_fk_idx on public.issue_reports (workspace_id);
alter table public.issue_reports enable row level security;
revoke all on public.issue_reports from public, anon, authenticated;

-- one report from the relay, already validated and clamped there, with its screenshots already uploaded
create or replace function public.issue_report_record(report jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare rid uuid := (report->>'id')::uuid;
begin
  insert into public.issue_reports (id, install_hash, user_id, workspace_id, edition, version, os, view, title, description, log_lines, run_id, screenshots, at)
  values (rid, report->>'install_hash', nullif(report->>'user_id', '')::uuid, nullif(report->>'workspace_id', '')::public.ulid, report->>'edition',
          coalesce(report->>'version', ''), coalesce(report->>'os', ''), coalesce(report->>'view', ''), coalesce(report->>'title', ''),
          coalesce(report->>'description', ''),
          coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(report->'log_lines', '[]'::jsonb)) x), '{}'),
          nullif(report->>'run_id', ''),
          coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(report->'screenshots', '[]'::jsonb)) x), '{}'),
          coalesce((report->>'at')::timestamptz, now()));
  return jsonb_build_object('id', rid);
end $$;
revoke all on function public.issue_report_record(jsonb) from public, anon, authenticated;
grant execute on function public.issue_report_record(jsonb) to service_role;

-- the reports older than 90 days with their screenshot keys, oldest first; the relay deletes the objects, then the rows
create or replace function public.issue_reports_expired(max_rows integer default 200) returns table (id uuid, screenshots text[])
language sql stable security definer set search_path = '' as $$
  select r.id, r.screenshots from public.issue_reports r where r.received_at < now() - interval '90 days'
  order by r.received_at limit least(greatest(coalesce(max_rows, 200), 1), 1000);
$$;
revoke all on function public.issue_reports_expired(integer) from public, anon, authenticated;
grant execute on function public.issue_reports_expired(integer) to service_role;

-- removes rows by id: the expired ones after their objects are gone, or one whose upload failed half way
create or replace function public.issue_reports_delete(ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.issue_reports r where r.id = any(ids);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.issue_reports_delete(uuid[]) from public, anon, authenticated;
grant execute on function public.issue_reports_delete(uuid[]) to service_role;

-- the ids from a list of bucket folders that have no row, for the orphan sweep
create or replace function public.issue_reports_missing(ids uuid[]) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select x.id from unnest(ids) x (id) where not exists (select 1 from public.issue_reports r where r.id = x.id);
$$;
revoke all on function public.issue_reports_missing(uuid[]) from public, anon, authenticated;
grant execute on function public.issue_reports_missing(uuid[]) to service_role;

-- the owner's list: one status or all (null), newest first, a page at a time. The list leaves out the log lines.
create or replace function public.admin_issue_reports(status_filter text default null, page_size integer default 50, page_offset integer default 0)
returns table (id uuid, edition text, version text, os text, view text, title text, description text, screenshots integer, signed_in boolean, status text, note text, at timestamptz, received_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  if status_filter is not null and status_filter not in ('new', 'filed', 'closed', 'ignored') then raise exception 'A status is new, filed, closed or ignored'; end if;
  return query
    select r.id, r.edition, r.version, r.os, r.view, r.title, r.description, cardinality(r.screenshots), r.user_id is not null, r.status, r.note, r.at, r.received_at, r.updated_at
    from public.issue_reports r
    where status_filter is null or r.status = status_filter
    order by r.received_at desc, r.id
    limit least(greatest(coalesce(page_size, 50), 1), 200) offset greatest(coalesce(page_offset, 0), 0);
end $$;
revoke all on function public.admin_issue_reports(text, integer, integer) from public, anon;
grant execute on function public.admin_issue_reports(text, integer, integer) to authenticated, service_role;

-- how many reports hold each status, for the nav count and the filter chips
create or replace function public.admin_issue_report_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  return jsonb_build_object(
    'new', (select count(*) from public.issue_reports r where r.status = 'new'),
    'filed', (select count(*) from public.issue_reports r where r.status = 'filed'),
    'closed', (select count(*) from public.issue_reports r where r.status = 'closed'),
    'ignored', (select count(*) from public.issue_reports r where r.status = 'ignored'));
end $$;
revoke all on function public.admin_issue_report_counts() from public, anon;
grant execute on function public.admin_issue_report_counts() to authenticated, service_role;

-- one report in full, with the reporter's email when they attached their account. The screenshot keys come back so the
-- relay can sign them for the owner (POST /v1/platform/report-screenshots calls this as the owner); no install hash.
create or replace function public.admin_issue_report(report_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.issue_reports;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  select * into r from public.issue_reports x where x.id = report_id;
  if not found then raise exception 'That report does not exist'; end if;
  return (to_jsonb(r) - 'install_hash') || jsonb_build_object('email', (select u.email from auth.users u where u.id = r.user_id));
end $$;
revoke all on function public.admin_issue_report(uuid) from public, anon;
grant execute on function public.admin_issue_report(uuid) to authenticated, service_role;

-- the owner's triage: new, filed (an issue exists on GitHub), closed or ignored, with an optional note such as the
-- issue link. Every change is written to platform_audit by id only.
create or replace function public.admin_issue_report_set_status(report_id uuid, status text, note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare before text; n text := nullif(trim(coalesce(admin_issue_report_set_status.note, '')), ''); r public.issue_reports;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  if admin_issue_report_set_status.status not in ('new', 'filed', 'closed', 'ignored') then raise exception 'A status is new, filed, closed or ignored'; end if;
  if length(coalesce(n, '')) > 2000 then raise exception 'The note is at most 2000 characters'; end if;
  select x.status into before from public.issue_reports x where x.id = report_id for update;
  if not found then raise exception 'That report does not exist'; end if;
  update public.issue_reports x set status = admin_issue_report_set_status.status, note = n, updated_at = now() where x.id = report_id returning * into r;
  insert into public.platform_audit (actor, action, detail)
    values (auth.uid(), 'report_status', jsonb_build_object('report', r.id, 'before', before, 'status', r.status));
  return (to_jsonb(r) - 'install_hash') || jsonb_build_object('email', (select u.email from auth.users u where u.id = r.user_id));
end $$;
revoke all on function public.admin_issue_report_set_status(uuid, text, text) from public, anon;
grant execute on function public.admin_issue_report_set_status(uuid, text, text) to authenticated, service_role;
