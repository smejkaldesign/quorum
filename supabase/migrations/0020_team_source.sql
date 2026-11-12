-- applied-when: select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'team_source')
-- Team knowledge source (docs/specs/team-knowledge.md, "Company knowledge source"). An admin points the workspace at
-- the place its knowledge lives: the notes Quorum sync pulls (the default), a folder every member has on their Mac,
-- or a git repository each Mac clones. The choice is one row value every member reads; the folder or clone itself
-- stays on each Mac. Only owners and admins change it; the row keeps who set it and when.

alter table public.workspaces add column team_source jsonb;

create or replace function public.workspace_team_source_set(workspace_id public.ulid, source jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare kind text := coalesce(source ->> 'kind', 'sync');
begin
  if not public.is_admin(workspace_team_source_set.workspace_id) then raise exception 'Only owners and admins can change the knowledge source'; end if;
  if kind not in ('sync', 'folder', 'git') then raise exception 'Unknown knowledge source'; end if;
  if kind = 'git' and coalesce(source ->> 'url', '') = '' then raise exception 'A git source needs a repository URL'; end if;
  if kind = 'folder' and coalesce(source ->> 'path', '') = '' then raise exception 'A folder source needs a path'; end if;
  update public.workspaces w
    set team_source = case when kind = 'sync' then null else jsonb_build_object('kind', kind, 'url', source ->> 'url', 'path', source ->> 'path', 'set_by', auth.uid(), 'set_at', now()) end
    where w.id = workspace_team_source_set.workspace_id;
  return (select w.team_source from public.workspaces w where w.id = workspace_team_source_set.workspace_id);
end $$;
revoke all on function public.workspace_team_source_set(public.ulid, jsonb) from public, anon;
grant execute on function public.workspace_team_source_set(public.ulid, jsonb) to authenticated;
