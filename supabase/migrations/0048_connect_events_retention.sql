-- applied-when: select exists(select 1 from pg_proc where proname = 'connect_events_purge' and pronamespace = 'public'::regnamespace)
-- Quorum hosted edition, step 48: platform webhook events (connect_events, migration 0014) hold routing data only and
-- do not outlive their delivery. The relay now stores an event's ids, host or operator and start time (relay/connect.js
-- eventRoute) and drops the rest: an AI Companion summary's text, a recording's download links, a meeting's password,
-- its topic and the host's email. This migration
--   1. reduces every row already stored to that same set of fields;
--   2. adds connect_events_purge, which the relay runs hourly: it deletes events the app has acknowledged and any
--      event older than seven days, delivered or not;
--   3. indexes the pending lookup by meeting_host_id, the host field of meeting.summary_completed.

update public.connect_events set payload = jsonb_strip_nulls(jsonb_build_object(
  'account_id', payload -> 'account_id',
  'operator_id', payload -> 'operator_id',
  'object', jsonb_strip_nulls(jsonb_build_object(
    'id', payload -> 'object' -> 'id',
    'uuid', payload -> 'object' -> 'uuid',
    'host_id', payload -> 'object' -> 'host_id',
    'start_time', payload -> 'object' -> 'start_time',
    'meeting_uuid', payload -> 'object' -> 'meeting_uuid',
    'meeting_id', payload -> 'object' -> 'meeting_id',
    'meeting_host_id', payload -> 'object' -> 'meeting_host_id',
    'meeting_start_time', payload -> 'object' -> 'meeting_start_time',
    'note_id', payload -> 'object' -> 'note_id'
  ))
));

create or replace function public.connect_events_purge()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.connect_events where delivered_at is not null or received_at < now() - interval '7 days';
  get diagnostics n = row_count;
  return jsonb_build_object('deleted', n);
end;
$$;
revoke all on function public.connect_events_purge() from public, anon, authenticated;
grant execute on function public.connect_events_purge() to service_role;

create index if not exists connect_events_pending_meeting_host on public.connect_events (provider, account_id, (payload -> 'object' ->> 'meeting_host_id')) where delivered_at is null;
