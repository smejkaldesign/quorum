-- applied-when: select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspace_settings' and column_name = 'guardrails')
-- Workspace guardrails (app/guardrails.js, Settings › Admin › Guardrails): rules an admin sets for the whole workspace.
-- Each member's app merges them with its own rules and cannot turn them off; every rule only ever denies, so the
-- most restrictive combination is what applies. Members read the column through the existing select policy.
alter table public.workspace_settings add column if not exists guardrails jsonb not null default '[]'::jsonb;

create or replace function public.workspace_guardrails_set(workspace_id public.ulid, rules jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare clean jsonb := '[]'::jsonb; r jsonb;
begin
  if not public.is_admin(workspace_guardrails_set.workspace_id) then raise exception 'Only owners and admins can change workspace guardrails'; end if;
  if jsonb_typeof(coalesce(workspace_guardrails_set.rules, '[]'::jsonb)) <> 'array' then raise exception 'Guardrails must be a list'; end if;
  for r in select * from jsonb_array_elements(workspace_guardrails_set.rules) loop
    if jsonb_typeof(r) <> 'object' or not ((r ->> 'kind') in ('path', 'frontmatter', 'term', 'secret')) then raise exception 'Each guardrail needs a kind of path, frontmatter, term or secret'; end if;
    if length(coalesce(r ->> 'value', '')) = 0 or length(r ->> 'value') > 500 then raise exception 'Each guardrail needs a value under 500 characters'; end if;
    clean := clean || jsonb_build_array(jsonb_build_object(
      'id', coalesce(nullif(r ->> 'id', ''), 'ws:' || gen_random_uuid()::text),
      'kind', r ->> 'kind',
      'value', r ->> 'value',
      'label', left(coalesce(r ->> 'label', ''), 120),
      'enabled', coalesce((r ->> 'enabled')::boolean, true)));
  end loop;
  if jsonb_array_length(clean) > 200 then raise exception 'At most 200 workspace guardrails'; end if;
  insert into public.workspace_settings (workspace_id, guardrails) values (workspace_guardrails_set.workspace_id, clean)
  on conflict (workspace_id) do update set guardrails = excluded.guardrails;
  return clean;
end $$;
revoke all on function public.workspace_guardrails_set(public.ulid, jsonb) from public;
grant execute on function public.workspace_guardrails_set(public.ulid, jsonb) to authenticated;
