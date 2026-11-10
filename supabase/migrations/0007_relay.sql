-- Quorum hosted edition, step 7: what the transcription relay (relay/) needs. The relay runs with the service role
-- and never with a user's session, so everything here is granted to service_role alone.
--
-- Allowance. Each seat includes 20 managed hours a calendar month; hour_packs adds 20 hours each on top, for the
-- whole workspace. The relay pools both: (seats + hour_packs) * 20 hours, less the month's managed_hours across the
-- workspace (workspace_usage). Hours on an organization connector never count.
alter table public.workspaces add column hour_packs integer not null default 0 check (hour_packs >= 0);

-- which engine or model handled the step, for the admin page and for cost checks: assemblyai, deepgram, a model id
alter table public.workspace_usage_events add column engine text;

-- the one read of a connector's key. Only the relay (service role) may call it; a session token gets a plain refusal.
create or replace function public.relay_connector_secret(connector_id public.ulid) returns table (workspace_id public.ulid, provider text, base_url text, roles text[], secret text)
language plpgsql stable security definer set search_path = public as $$
declare jwt_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
begin
  -- the API sets the claims; a direct database session (migrations, tests) has none and is trusted when it is the superuser
  if jwt_role is distinct from 'service_role' and not (jwt_role is null and session_user in ('postgres', 'supabase_admin')) then
    raise exception 'Only the relay may read connector keys';
  end if;
  return query
    select c.workspace_id, c.provider, c.base_url, c.roles, s.decrypted_secret
    from public.workspace_connectors c join vault.decrypted_secrets s on s.id = c.secret_id
    where c.id = relay_connector_secret.connector_id;
end $$;
revoke all on function public.relay_connector_secret(public.ulid) from public, anon, authenticated;
grant execute on function public.relay_connector_secret(public.ulid) to service_role;

-- the relay's own writes and reads: usage rows, membership, settings, the workspace's seats and packs
grant insert on public.workspace_usage_events to service_role;
grant select on public.workspace_usage_events, public.workspace_settings, public.workspace_connectors, public.members, public.workspaces, public.meetings to service_role;

-- voice settings gain one boolean: required, which makes every member's calls go through managed transcription
-- while hours remain. The three step overrides are unchanged.
create or replace function public.workspace_voice_set(workspace_id public.ulid, voice jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare clean jsonb := '{}'::jsonb; r text; cid text;
begin
  if not public.is_admin(workspace_voice_set.workspace_id) then raise exception 'Only owners and admins can change organization voice settings'; end if;
  if jsonb_typeof(coalesce(workspace_voice_set.voice, '{}'::jsonb)) <> 'object' then raise exception 'Voice settings must be an object'; end if;
  foreach r in array array['speech', 'summary', 'notes'] loop
    cid := nullif(trim(coalesce(workspace_voice_set.voice ->> r, '')), '');
    if cid is not null then
      if not exists (select 1 from public.workspace_connectors c where c.id = cid and c.workspace_id = workspace_voice_set.workspace_id and r = any (c.roles)) then
        raise exception 'That connector cannot handle %', r;
      end if;
      clean := clean || jsonb_build_object(r, cid);
    end if;
  end loop;
  if (workspace_voice_set.voice -> 'required') = 'true'::jsonb then clean := clean || '{"required": true}'::jsonb; end if;
  insert into public.workspace_settings (workspace_id, voice) values (workspace_voice_set.workspace_id, clean)
  on conflict (workspace_id) do update set voice = excluded.voice;
  return clean;
end $$;
