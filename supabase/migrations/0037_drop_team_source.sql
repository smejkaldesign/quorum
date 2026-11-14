-- applied-when: select exists(select 1 from pg_proc where proname = 'kb_default_source_set') and not exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'team_source')
-- The 0020 team source ends (docs/specs/workspace-knowledge.md, "Migration from 0020"). Since 0025 the default
-- knowledge base carries the folder or git source; from 0.4.0 the app reads it from the default KB row and saves it
-- with kb_default_source_set (0036), which kept workspaces.team_source in step for 0.3.x. This migration:
--
-- 1. copies every workspaces.team_source that its default KB does not carry yet. A workspace that set a source but
--    never had a default KB gets one now, the same KB the team switch would make (kb_ensure_default, 0025).
-- 2. makes kb_ensure_default and kb_default_source_set stop touching workspaces.team_source.
-- 3. drops workspace_team_source_set and the workspaces.team_source column.
--
-- An app from 0.3.x fails to read or change the team source once this is applied (its Knowledge tab shows "The
-- knowledge source could not be read."), so apply it only once every Mac runs 0.4.0 or later. Safe to run again.

-- 1. the copy, skipped once the column is gone
do $$
declare w record; k public.ulid;
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'team_source') then return; end if;
  for w in execute 'select x.id, x.team_source from public.workspaces x where x.deleted_at is null and x.team_source is not null' loop
    k := public.kb_ensure_default(w.id);
    update public.knowledge_bases b set source = w.team_source where b.id = k and b.source is null;
  end loop;
end $$;

-- 2. 0025's function with the source left empty
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
  insert into public.knowledge_bases (workspace_id, name, kind, is_default, created_by)
    values (ws, n, 'general', true, w.user_id) returning id into k;
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

-- 0036's function without the write to the 0020 column: the same checks, an import source kept, and a default KB
-- made for a folder or git source on a workspace without one
create or replace function public.kb_default_source_set(workspace_id public.ulid, source jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare src_kind text := coalesce(kb_default_source_set.source ->> 'kind', 'sync');
        src_url text := nullif(btrim(coalesce(kb_default_source_set.source ->> 'url', '')), '');
        src_path text := nullif(btrim(coalesce(kb_default_source_set.source ->> 'path', '')), '');
        current_kind text;
        k public.ulid;
        v jsonb;
begin
  if not public.is_admin(kb_default_source_set.workspace_id) then raise exception 'Only owners and admins can change the knowledge source'; end if;
  if src_kind not in ('sync', 'folder', 'git') then raise exception 'Unknown knowledge source'; end if;
  if src_kind = 'git' and src_url is null then raise exception 'A git source needs a repository URL'; end if;
  if src_kind = 'folder' and src_path is null then raise exception 'A folder source needs a path'; end if;
  select x.id, x.source ->> 'kind' into k, current_kind from public.knowledge_bases x where x.workspace_id = kb_default_source_set.workspace_id and x.is_default;
  if current_kind = 'github' and src_kind <> current_kind then raise exception 'This knowledge base was imported from GitHub. Change its source in Settings › Admin › Knowledge'; end if;
  if current_kind = 'zip' and src_kind <> current_kind then raise exception 'This knowledge base was imported from a zip. Change its source in Settings › Admin › Knowledge'; end if;
  if current_kind = 'hosted' then raise exception 'This knowledge base is hosted by Quorum and has no source to change'; end if;
  v := case when src_kind = 'sync' then null else jsonb_build_object('kind', src_kind, 'url', case when src_kind = 'git' then src_url end, 'path', case when src_kind = 'folder' then src_path end, 'set_by', auth.uid(), 'set_at', now()) end;
  if k is null and v is null then return jsonb_build_object('id', null, 'is_default', true, 'source', null); end if;
  if k is null then k := public.kb_ensure_default(kb_default_source_set.workspace_id); end if;
  update public.knowledge_bases x set source = v where x.id = k;
  return public.kb_shape(k);
end $$;
revoke all on function public.kb_default_source_set(public.ulid, jsonb) from public, anon;
grant execute on function public.kb_default_source_set(public.ulid, jsonb) to authenticated;

-- 3. nothing reads the 0020 RPC or column any more
drop function if exists public.workspace_team_source_set(public.ulid, jsonb);
alter table public.workspaces drop column if exists team_source;
