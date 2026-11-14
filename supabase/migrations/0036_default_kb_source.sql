-- applied-when: select exists(select 1 from pg_proc where proname = 'kb_default_source_set')
-- The team source on the default knowledge base (docs/specs/workspace-knowledge.md, "Migration from 0020"). Since
-- 0025 the default KB carries the folder or git source and workspace_team_source_set (0020) writes both places. This
-- adds kb_default_source_set, the RPC the app uses from 0.4.0 on. Until migration 0037 drops the 0020 column, it
-- also writes workspaces.team_source, so an app from 0.3.x that still reads the column sees the same source.
-- kb_source_set (0026) stays the RPC for import sources (github, zip). Adds one function; safe to run again.

-- the Mac-side source of the workspace's default KB: the notes Quorum sync pulls (no source), a folder every member
-- has on their Mac, or a git repository each Mac clones. Owners and admins only; the value keeps who set it and when,
-- and the app compares set_at to drop a per-Mac folder choice when an admin changes the source
create or replace function public.kb_default_source_set(workspace_id public.ulid, source jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare src_kind text := coalesce(kb_default_source_set.source ->> 'kind', 'sync');
        src_url text := nullif(btrim(coalesce(kb_default_source_set.source ->> 'url', '')), '');
        src_path text := nullif(btrim(coalesce(kb_default_source_set.source ->> 'path', '')), '');
        k public.ulid;
        v jsonb;
begin
  if not public.is_admin(kb_default_source_set.workspace_id) then raise exception 'Only owners and admins can change the knowledge source'; end if;
  if src_kind not in ('sync', 'folder', 'git') then raise exception 'Unknown knowledge source'; end if;
  if src_kind = 'git' and src_url is null then raise exception 'A git source needs a repository URL'; end if;
  if src_kind = 'folder' and src_path is null then raise exception 'A folder source needs a path'; end if;
  select x.id into k from public.knowledge_bases x where x.workspace_id = kb_default_source_set.workspace_id and x.is_default;
  if k is null then raise exception 'Switch the team on first. The knowledge source belongs to the workspace''s default knowledge base'; end if;
  v := case when src_kind = 'sync' then null else jsonb_build_object('kind', src_kind, 'url', case when src_kind = 'git' then src_url end, 'path', case when src_kind = 'folder' then src_path end, 'set_by', auth.uid(), 'set_at', now()) end;
  update public.knowledge_bases x set source = v where x.id = k;
  -- the 0020 column, for apps from 0.3.x; 0037 removes this line with the column
  update public.workspaces w set team_source = v where w.id = kb_default_source_set.workspace_id;
  return public.kb_shape(k);
end $$;
revoke all on function public.kb_default_source_set(public.ulid, jsonb) from public, anon;
grant execute on function public.kb_default_source_set(public.ulid, jsonb) to authenticated;
