-- applied-when: select exists(select 1 from pg_proc where proname = 'kb_default_source_set')
-- The team source on the default knowledge base (docs/specs/workspace-knowledge.md, "Migration from 0020"). Since
-- 0025 the default KB carries the folder or git source and workspace_team_source_set (0020) writes both places. This
-- migration:
--
-- 1. adds kb_default_source_set, the RPC the app uses from 0.4.0 on. Until migration 0037 drops the 0020 column it
--    also writes workspaces.team_source, so an app from 0.3.x that still reads the column sees the same source.
-- 2. makes workspace_team_source_set call kb_default_source_set, keeping its signature and return value for 0.3.x,
--    so both apps save through the same checks.
-- 3. gives a default KB to every workspace that has a folder or git source in the column and no default KB yet
--    (one the team switch never made), carrying the source over.
--
-- A default KB imported from GitHub or a zip (kb_source_set, 0026) keeps its import source: the team source is not
-- changed on it, and its admins change it under Settings › Admin › Knowledge. Safe to run again.

-- 1. the Mac-side source of the workspace's default KB: the notes Quorum sync pulls (no source), a folder every
-- member has on their Mac, or a git repository each Mac clones. Owners and admins only; the value keeps who set it
-- and when, and the app compares set_at to drop a per-Mac folder choice when an admin changes the source. A
-- workspace without a default KB gets one for a folder or git source; Quorum sync needs none
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
  v := case when src_kind = 'sync' then null else jsonb_build_object('kind', src_kind, 'url', case when src_kind = 'git' then src_url end, 'path', case when src_kind = 'folder' then src_path end, 'set_by', auth.uid(), 'set_at', now()) end;
  -- the 0020 column, for apps from 0.3.x; 0037 removes this line with the column. Written first, so a default KB
  -- made below starts with the same value
  update public.workspaces w set team_source = v where w.id = kb_default_source_set.workspace_id;
  if k is null and v is null then return jsonb_build_object('id', null, 'is_default', true, 'source', null); end if;
  if k is null then k := public.kb_ensure_default(kb_default_source_set.workspace_id); end if;
  update public.knowledge_bases x set source = v where x.id = k;
  return public.kb_shape(k);
end $$;
revoke all on function public.kb_default_source_set(public.ulid, jsonb) from public, anon;
grant execute on function public.kb_default_source_set(public.ulid, jsonb) to authenticated;

-- 2. the 0020 RPC for apps from 0.3.x: the same arguments and the source it always returned
create or replace function public.workspace_team_source_set(workspace_id public.ulid, source jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return public.kb_default_source_set(workspace_team_source_set.workspace_id, workspace_team_source_set.source) -> 'source';
end $$;
revoke all on function public.workspace_team_source_set(public.ulid, jsonb) from public, anon;
grant execute on function public.workspace_team_source_set(public.ulid, jsonb) to authenticated;

-- 3. the default KB for a workspace whose folder or git source has none yet; kb_ensure_default (0025) copies the
-- column into the new KB, and a KB that already exists is left as it is
do $$
declare w record; k public.ulid;
begin
  for w in select x.id, x.team_source from public.workspaces x
           where x.deleted_at is null and x.team_source ->> 'kind' in ('folder', 'git')
             and not exists (select 1 from public.knowledge_bases b where b.workspace_id = x.id and b.is_default) loop
    k := public.kb_ensure_default(w.id);
    update public.knowledge_bases b set source = w.team_source where b.id = k and b.source is null;
  end loop;
end $$;
