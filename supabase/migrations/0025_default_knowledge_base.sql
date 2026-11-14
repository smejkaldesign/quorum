-- applied-when: select exists(select 1 from pg_trigger where tgname = 'workspaces_default_kb')
-- The 0020 team source becomes a default knowledge base (docs/specs/workspace-knowledge.md, "Migration from 0020").
-- A workspace with its team switched on (0019) has one default KB named after the workspace and readable by every
-- member. Notes the review queue has included join it; later inclusions join it through contribution_kb_sync (0024).
-- A folder or git source stays a Mac-side source: the KB's source column carries the same value as
-- workspaces.team_source. A one-person workspace gets no default KB until its team switch is turned on, and
-- turning the switch on makes it. workspace_team_source_set (0020) keeps working for one release and now writes both
-- places.

-- the workspace's default KB, made on first use with the workspace's included notes in it; called by this migration,
-- the team switch trigger and nothing a client can reach
create or replace function public.kb_ensure_default(ws public.ulid) returns public.ulid
language plpgsql security definer set search_path = public as $$
declare k public.ulid; w public.workspaces; n text;
begin
  select x.id into k from public.knowledge_bases x where x.workspace_id = ws and x.is_default;
  if k is not null then return k; end if;
  select * into w from public.workspaces x where x.id = ws and x.deleted_at is null;
  if w.id is null then return null; end if;
  n := left(coalesce(nullif(btrim(w.name), ''), 'Workspace'), 120);
  if exists (select 1 from public.knowledge_bases x where x.workspace_id = ws and lower(btrim(x.name)) = lower(n)) then n := left(n, 108) || ' (workspace)'; end if;
  insert into public.knowledge_bases (workspace_id, name, kind, is_default, source, created_by)
    values (ws, n, 'general', true, w.team_source, w.user_id) returning id into k;
  insert into public.kb_access (kb_id, principal, role, created_by) values (k, 'workspace', 'reader', w.user_id);
  -- setting kb_id moves updated_at, so every member's next pull carries the KB on these notes
  perform set_config('quorum.kb_system', 'on', true);
  update public.notes n2 set kb_id = k, folder_id = null
    where n2.workspace_id = ws and n2.kb_id is null and n2.deleted_at is null and public.note_shared(n2.frontmatter) and public.note_included(n2.id);
  perform set_config('quorum.kb_system', '', true);
  return k;
end $$;
revoke all on function public.kb_ensure_default(public.ulid) from public, anon, authenticated;
grant execute on function public.kb_ensure_default(public.ulid) to service_role;

-- turning the team switch on makes the default KB
create or replace function public.workspace_default_kb() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.kb_ensure_default(new.id);
  return new;
end $$;
revoke all on function public.workspace_default_kb() from public, anon, authenticated;
create trigger workspaces_default_kb after insert or update of team_enabled on public.workspaces
  for each row when (new.team_enabled and new.deleted_at is null) execute function public.workspace_default_kb();

-- backfill: every workspace whose team switch is already on
do $$
declare w record;
begin
  for w in select x.id from public.workspaces x where x.deleted_at is null and x.team_enabled loop
    perform public.kb_ensure_default(w.id);
  end loop;
end $$;

-- the 0020 RPC as before, plus the default KB's source when the workspace has one, so an app that still calls it and
-- one that reads KBs agree
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
    where k.workspace_id = workspace_team_source_set.workspace_id and k.is_default;
  return (select w.team_source from public.workspaces w where w.id = workspace_team_source_set.workspace_id);
end $$;
revoke all on function public.workspace_team_source_set(public.ulid, jsonb) from public, anon;
grant execute on function public.workspace_team_source_set(public.ulid, jsonb) to authenticated;
