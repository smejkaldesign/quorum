-- applied-when: select exists(select 1 from pg_proc where proname = 'kb_source_set')
-- Importing a knowledge base from a GitHub repository or a zip (docs/specs/workspace-knowledge.md, "Filling a KB in
-- the MVP"; the app side is app/ee/kbImport.js). Two changes:
--
-- 1. kb_source_set records where a KB was imported from, so a later import can refresh it. Only import sources
--    (github, zip) are written here. A KB that carries a Mac-side folder or git source (the default KB from 0025)
--    keeps it, since every member's Mac reads that source.
-- 2. A shared note written straight into a KB is included in the review queue at once. Only a KB admin can place a
--    note in a KB (notes_kb_check, 0024), so the admin has already chosen it; without this an import of a large
--    repository would open one pending contribution per file in the admin queue.

create or replace function public.kb_source_set(kb_id public.ulid, source jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare src_kind text := coalesce(kb_source_set.source ->> 'kind', '');
        src_url text := nullif(btrim(coalesce(kb_source_set.source ->> 'url', '')), '');
        current_kind text;
begin
  if not public.can_read_kb(kb_source_set.kb_id) then raise exception 'That knowledge base no longer exists'; end if;
  if not public.can_admin_kb(kb_source_set.kb_id) then raise exception 'Only the knowledge base''s admins can change where it is imported from'; end if;
  if src_kind not in ('github', 'zip') then raise exception 'A knowledge base is imported from a GitHub repository or a zip'; end if;
  if src_kind = 'github' and (src_url is null or src_url !~ '^https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+$') then raise exception 'Enter a GitHub repository address'; end if;
  select k.source ->> 'kind' into current_kind from public.knowledge_bases k where k.id = kb_source_set.kb_id;
  if coalesce(current_kind, '') not in ('folder', 'git') then
    update public.knowledge_bases k set source = jsonb_build_object(
      'kind', src_kind,
      'url', case when src_kind = 'github' then src_url else null end,
      'branch', case when src_kind = 'github' then nullif(left(btrim(coalesce(kb_source_set.source ->> 'branch', '')), 200), '') else null end,
      'name', nullif(left(btrim(coalesce(kb_source_set.source ->> 'name', '')), 200), ''),
      'path', null,
      'set_by', auth.uid(), 'imported_at', now())
    where k.id = kb_source_set.kb_id;
  end if;
  return public.kb_shape(kb_source_set.kb_id);
end $$;
revoke all on function public.kb_source_set(public.ulid, jsonb) from public, anon;
grant execute on function public.kb_source_set(public.ulid, jsonb) to authenticated, service_role;

-- 0012's trigger with one change: a shared note that sits in a KB opens its contribution as included
create or replace function public.note_contribution_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare pub boolean := coalesce(new.frontmatter ->> 'visibility', 'private') = 'public' and new.deleted_at is null;
        conf boolean := coalesce(new.frontmatter ->> 'confidential', '') <> '';
        auto boolean;
begin
  if pub and not conf then
    select w.auto_include into auto from public.workspaces w where w.id = new.workspace_id;
    auto := coalesce(auto, false) or new.kb_id is not null;
    insert into public.contributions (workspace_id, note_id, author_id, status, reviewed_at)
      values (new.workspace_id, new.id, new.user_id, case when auto then 'included' else 'pending' end, case when auto then now() else null end)
    on conflict (note_id) do update set status = case when contributions.status in ('included', 'declined') then contributions.status when excluded.status = 'included' then 'included' else 'pending' end,
                                       reviewed_at = case when contributions.status in ('included', 'declined') then contributions.reviewed_at else excluded.reviewed_at end
      where contributions.status = 'withdrawn' or contributions.status = 'pending';
  else
    update public.contributions c set status = 'withdrawn' where c.note_id = new.id and c.status <> 'withdrawn';
  end if;
  return new;
end $$;
