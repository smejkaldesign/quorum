-- applied-when: select pg_get_functiondef('public.workspace_voice_set(public.ulid, jsonb)'::regprocedure) like '%required%'
-- Voice settings gain `required`: when true, every member's calls run through the managed pipeline and the on-device
-- choice in their own Settings is ignored (app/ee/relay.js speechPlan). Same function as 0006, one more key kept.
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
  if jsonb_typeof(workspace_voice_set.voice -> 'required') = 'boolean' and (workspace_voice_set.voice ->> 'required')::boolean then
    clean := clean || '{"required": true}'::jsonb;
  end if;
  insert into public.workspace_settings (workspace_id, voice) values (workspace_voice_set.workspace_id, clean)
  on conflict (workspace_id) do update set voice = excluded.voice;
  return clean;
end $$;
