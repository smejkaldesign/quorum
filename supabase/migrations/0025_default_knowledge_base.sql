-- applied-when: select pg_get_functiondef('public.workspace_team_source_set(public.ulid, jsonb)'::regprocedure) like '%kb_ensure_default%'
-- The 0020 team source becomes a default knowledge base (docs/specs/workspace-knowledge.md, "Migration from 0020").
-- Every workspace that has a team switched on, a team source set, or included team notes gets one KB named after the
-- workspace, readable by every member, and its included team notes join it. A folder or git source stays a Mac-side
-- source: the KB's source column carries the same value as workspaces.team_source. workspace_team_source_set (0020)
-- keeps working for one release and now writes both places.

-- the workspace's default KB, made on first use; for this migration and the 0020 RPC, never called by clients
create or replace function public.kb_ensure_default(ws public.ulid) returns public.ulid
language plpgsql security definer set search_path = public as $$
declare k public.ulid; w public.workspaces; n text;
begin
  select x.id into k from public.knowledge_bases x where x.workspace_id = ws and x.is_default;
  if k is not null then return k; end if;
  select * into w from public.workspaces x where x.id = ws;
  if w.id is null then return null; end if;
  n := left(coalesce(nullif(btrim(w.name), ''), 'Workspace'), 120);
  if exists (select 1 from public.knowledge_bases x where x.workspace_id = ws and lower(btrim(x.name)) = lower(n)) then n := left(n, 108) || ' (workspace)'; end if;
  insert into public.knowledge_bases (workspace_id, name, kind, is_default, source, created_by)
    values (ws, n, 'general', true, w.team_source, w.user_id) returning id into k;
  insert into public.kb_access (kb_id, principal, role, created_by) values (k, 'workspace', 'reader', w.user_id);
  return k;
end $$;
revoke all on function public.kb_ensure_default(public.ulid) from public, anon, authenticated;
grant execute on function public.kb_ensure_default(public.ulid) to service_role;

-- backfill: the default KB per team workspace, and the notes other members read today (public and included) join it.
-- Setting kb_id moves updated_at, so every member's next pull carries the KB on those notes
do $$
declare w record; k public.ulid;
begin
  for w in
    select x.id from public.workspaces x
    where x.deleted_at is null and (x.team_enabled or x.team_source is not null
      or exists (select 1 from public.contributions c where c.workspace_id = x.id and c.status = 'included'))
  loop
    k := public.kb_ensure_default(w.id);
    update public.notes n set kb_id = k, folder_id = null
      where n.workspace_id = w.id and n.kb_id is null and n.deleted_at is null
        and coalesce(n.frontmatter ->> 'visibility', 'private') = 'public' and public.note_included(n.id);
  end loop;
end $$;

-- the 0020 RPC as before, plus the default KB's source, so an app that still calls it and one that reads KBs agree
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
  update public.knowledge_bases k set source = (select w.team_source from public.workspaces w where w.id = workspace_team_source_set.workspace_id)
    where k.id = public.kb_ensure_default(workspace_team_source_set.workspace_id);
  return (select w.team_source from public.workspaces w where w.id = workspace_team_source_set.workspace_id);
end $$;
revoke all on function public.workspace_team_source_set(public.ulid, jsonb) from public, anon;
grant execute on function public.workspace_team_source_set(public.ulid, jsonb) to authenticated;
