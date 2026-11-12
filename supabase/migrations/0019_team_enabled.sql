-- applied-when: select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'team_enabled')
-- Teams are opt-in. A workspace starts as one person's; the Teams page's "Enable a team" switch turns on the team-level
-- pages (members, organization connectors and voice, organization guardrails, knowledge review) and the Knowledge tab's
-- team content. Owners and admins flip it; every member reads it with the workspace row.

alter table public.workspaces add column team_enabled boolean not null default false;

create or replace function public.workspace_set_team_enabled(ws public.ulid, enabled boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin(ws) then raise exception 'Only owners and admins can enable a team'; end if;
  update public.workspaces set team_enabled = coalesce(enabled, false), updated_at = now() where id = ws and deleted_at is null;
  if not found then raise exception 'That workspace does not exist'; end if;
  return coalesce(enabled, false);
end;
$$;
revoke all on function public.workspace_set_team_enabled(public.ulid, boolean) from public, anon;
grant execute on function public.workspace_set_team_enabled(public.ulid, boolean) to authenticated, service_role;
