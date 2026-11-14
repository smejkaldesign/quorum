-- applied-when: select exists(select 1 from pg_proc where proname = 'kb_drive_note_write')
-- Google Drive files attached to a knowledge base folder (docs/specs/workspace-knowledge.md, "Sources inside a KB";
-- the app side is app/ee/kbDrive.js). An attached file is a shared note whose kb_source is google-drive:<file id>,
-- written as the row of the admin who added it. Any admin of the KB may sync or remove any attached file, including
-- one added by an admin who has since left, and notes_update (0012) lets a person update only their own rows. These
-- three functions do that one job each, for Drive notes only:
--
-- 1. kb_drive_note_write replaces an attached note's text after a sync. The note keeps its id, path, author, KB and
--    folder, its source must stay the same file, and it must still be shared (visibility public, not confidential).
-- 2. kb_drive_note_checked records when a sync found the file unchanged in Drive. Only the row's frontmatter gains
--    kb_checked_at; the note text and its hash stay as they are, so no Mac downloads the note again for it.
-- 3. kb_drive_note_remove takes an attached note out: it is soft deleted, as kbImport removes notes a source no
--    longer has, and pull sync removes it from every vault.

create or replace function public.kb_drive_note_target(note_id public.ulid) returns public.notes
language plpgsql stable security definer set search_path = public as $$
declare n public.notes;
begin
  select * into n from public.notes x where x.id = kb_drive_note_target.note_id and x.deleted_at is null;
  if n.id is null or n.kb_id is null or coalesce(n.frontmatter ->> 'kb_source', '') not like 'google-drive:%' then
    raise exception 'That file is no longer attached to this knowledge base';
  end if;
  if not public.can_admin_kb(n.kb_id) then raise exception 'Only the knowledge base''s admins can manage its Google Drive files'; end if;
  return n;
end $$;
revoke all on function public.kb_drive_note_target(public.ulid) from public, anon, authenticated;

create or replace function public.kb_drive_note_write(note_id public.ulid, body text, frontmatter jsonb, hash text, mtime timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare n public.notes := public.kb_drive_note_target(kb_drive_note_write.note_id);
begin
  if coalesce(kb_drive_note_write.frontmatter ->> 'kb_source', '') is distinct from n.frontmatter ->> 'kb_source' then
    raise exception 'A synced note keeps the Google Drive file it came from';
  end if;
  if not public.note_shared(kb_drive_note_write.frontmatter) then raise exception 'A note in a knowledge base must stay shared with the workspace'; end if;
  if char_length(kb_drive_note_write.body) > 6 * 1024 * 1024 then raise exception 'The note is too large'; end if;
  update public.notes x set body = kb_drive_note_write.body, frontmatter = kb_drive_note_write.frontmatter, hash = coalesce(kb_drive_note_write.hash, ''),
    mtime = kb_drive_note_write.mtime, updated_at = now()
  where x.id = n.id;
end $$;
revoke all on function public.kb_drive_note_write(public.ulid, text, jsonb, text, timestamptz) from public, anon;
grant execute on function public.kb_drive_note_write(public.ulid, text, jsonb, text, timestamptz) to authenticated, service_role;

create or replace function public.kb_drive_note_checked(note_id public.ulid, checked_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare n public.notes := public.kb_drive_note_target(kb_drive_note_checked.note_id);
begin
  update public.notes x set frontmatter = x.frontmatter || jsonb_build_object('kb_checked_at', to_char(kb_drive_note_checked.checked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  where x.id = n.id;
end $$;
revoke all on function public.kb_drive_note_checked(public.ulid, timestamptz) from public, anon;
grant execute on function public.kb_drive_note_checked(public.ulid, timestamptz) to authenticated, service_role;

create or replace function public.kb_drive_note_remove(note_id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
declare n public.notes := public.kb_drive_note_target(kb_drive_note_remove.note_id);
begin
  update public.notes x set deleted_at = now(), updated_at = now() where x.id = n.id;
end $$;
revoke all on function public.kb_drive_note_remove(public.ulid) from public, anon;
grant execute on function public.kb_drive_note_remove(public.ulid) to authenticated, service_role;
