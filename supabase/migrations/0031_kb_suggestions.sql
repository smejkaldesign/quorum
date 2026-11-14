-- applied-when: select exists(select 1 from pg_tables where schemaname = 'public' and tablename = 'kb_note_upstream')
-- Quorum's edits to synced KB notes, kept as suggestions when the source changes (docs/specs/workspace-knowledge.md,
-- "Maintenance" and Decision 5; the app side is app/ee/kbUpstream.js). A note synced from GitHub, a zip or Google Drive
-- carries kb_source in its frontmatter. Quorum's maintenance, agents and the person may change Quorum's copy; nothing
-- is written back to the source tool.
--
-- 1. kb_note_upstream holds one row per synced note: the upstream base (the text the last sync wrote from the source,
--    its hash, and the hash of its text without the keys sync sets on its own) and the suggestions, a list of
--    { id, state: ready | stale, body, agent, base, at }. A row is read only by the admins of the KB its note is in
--    now, and only while the note is live and shared. A trigger on notes deletes the row when the note is soft
--    deleted, stops being shared, leaves its KB or loses its kb_source, and moves it along when the note changes KB.
--    Writes go through the functions below, as for the other KB tables.
-- 2. kb_note_write_check holds the checks a write to a synced note makes; kb_drive_note_write (0028, replaced here
--    with the same signature) and the functions below share it.
-- 3. kb_synced_notes_write writes synced notes and their upstream rows in one call, so a note and its base always
--    change together. Any admin of the KB may write any synced note in it, as kb_drive_note_write allows.
-- 4. kb_upstream_save records the base of notes already written (a new import, a Drive note found unedited). A row
--    whose hash does not match its note is passed over. Suggestions already stored are kept.
-- 5. kb_suggestion_apply writes a ready suggestion into the note (Quorum's copy) and takes it off the list, when the
--    note still has the hash the page saw. The base stays, so the note reads as edited again.
-- 6. kb_suggestion_dismiss takes one suggestion off the list and leaves the note as it is.

create table public.kb_note_upstream (
  note_id public.ulid primary key references public.notes (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  kb_id public.ulid not null references public.knowledge_bases (id) on delete cascade,
  base_hash text not null default '',
  base_norm text not null default '',
  base_body text not null default '',
  suggestions jsonb not null default '[]' check (jsonb_typeof(suggestions) = 'array'),
  updated_at timestamptz not null default now()
);
create index kb_note_upstream_kb on public.kb_note_upstream (kb_id);
alter table public.kb_note_upstream enable row level security;
-- reads follow the note: live, shared, in a KB, and the reader an admin of that KB now
create policy kb_note_upstream_select on public.kb_note_upstream for select to authenticated using (
  exists (select 1 from public.notes n where n.id = kb_note_upstream.note_id and n.deleted_at is null and n.kb_id is not null
    and public.note_shared(n.frontmatter) and public.can_admin_kb(n.kb_id))
);
-- writes go through the functions below; with no insert, update or delete policy the table API refuses them

-- a note that leaves its KB, stops being shared, is deleted or is no longer synced takes its row with it
create or replace function public.kb_note_upstream_follow() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is not null or new.kb_id is null or not public.note_shared(new.frontmatter) or coalesce(new.frontmatter ->> 'kb_source', '') = '' then
    delete from public.kb_note_upstream u where u.note_id = new.id;
  elsif new.kb_id is distinct from old.kb_id then
    update public.kb_note_upstream u set kb_id = new.kb_id, updated_at = now() where u.note_id = new.id;
  end if;
  return null;
end $$;
create trigger notes_kb_upstream after update of deleted_at, kb_id, frontmatter on public.notes for each row execute function public.kb_note_upstream_follow();

-- the checks for a new text in a synced note: a Google Drive note keeps its file and every synced note keeps a source
-- (exact: the very same source line), the note stays shared, and it stays under the size cap
create or replace function public.kb_note_write_check(n public.notes, frontmatter jsonb, body text, exact boolean) returns void
language plpgsql stable set search_path = public as $$
declare was text := coalesce(n.frontmatter ->> 'kb_source', '');
        next_source text := coalesce(kb_note_write_check.frontmatter ->> 'kb_source', '');
begin
  if was like 'google-drive:%' and next_source is distinct from was then raise exception 'A synced note keeps the Google Drive file it came from'; end if;
  if next_source = '' or (kb_note_write_check.exact and next_source is distinct from was) then raise exception 'A synced note keeps the source it came from'; end if;
  if not public.note_shared(kb_note_write_check.frontmatter) then raise exception 'A note in a knowledge base must stay shared with the workspace'; end if;
  if char_length(kb_note_write_check.body) > 6 * 1024 * 1024 then raise exception 'The note is too large'; end if;
end $$;
revoke all on function public.kb_note_write_check(public.notes, jsonb, text, boolean) from public, anon, authenticated;

-- 0028's write for a Drive note, now with the shared checks
create or replace function public.kb_drive_note_write(note_id public.ulid, body text, frontmatter jsonb, hash text, mtime timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare n public.notes := public.kb_drive_note_target(kb_drive_note_write.note_id);
begin
  perform public.kb_note_write_check(n, kb_drive_note_write.frontmatter, kb_drive_note_write.body, true);
  update public.notes x set body = kb_drive_note_write.body, frontmatter = kb_drive_note_write.frontmatter, hash = coalesce(kb_drive_note_write.hash, ''),
    mtime = kb_drive_note_write.mtime, updated_at = now()
  where x.id = n.id;
end $$;

-- a suggestion list as the app sends it: each entry has an id, a state of ready or stale, and a text
create or replace function public.kb_suggestions_valid(list jsonb) returns boolean
language sql immutable set search_path = public as $$
  select jsonb_typeof(coalesce(list, '[]')) = 'array' and not exists (
    select 1 from jsonb_array_elements(coalesce(list, '[]')) s
    where jsonb_typeof(s) <> 'object' or coalesce(s ->> 'id', '') = '' or coalesce(s ->> 'state', '') not in ('ready', 'stale') or jsonb_typeof(s -> 'body') is distinct from 'string'
  );
$$;
revoke all on function public.kb_suggestions_valid(jsonb) from public, anon, authenticated;

-- rows: [{ note_id, body, frontmatter, hash, mtime, upstream?: { base_hash, base_norm, base_body, suggestions } }].
-- Returns the ids written. One refused note refuses the whole call, so nothing is half written
create or replace function public.kb_synced_notes_write(kb_id public.ulid, rows jsonb) returns setof public.ulid
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  u jsonb;
  n public.notes;
  cap constant integer := 6 * 1024 * 1024;
begin
  if not public.can_admin_kb(kb_synced_notes_write.kb_id) then raise exception 'Only the knowledge base''s admins can sync it'; end if;
  if jsonb_typeof(coalesce(kb_synced_notes_write.rows, '[]')) <> 'array' then raise exception 'The rows are not a list'; end if;
  for r in select value from jsonb_array_elements(coalesce(kb_synced_notes_write.rows, '[]')) loop
    select * into n from public.notes x where x.id = (r ->> 'note_id') and x.kb_id = kb_synced_notes_write.kb_id and x.deleted_at is null;
    if n.id is null or coalesce(n.frontmatter ->> 'kb_source', '') = '' then raise exception 'That note is no longer synced into this knowledge base'; end if;
    perform public.kb_note_write_check(n, r -> 'frontmatter', r ->> 'body', false);
    update public.notes x set body = r ->> 'body', frontmatter = r -> 'frontmatter', hash = coalesce(r ->> 'hash', ''),
      mtime = (r ->> 'mtime')::timestamptz, updated_at = now()
    where x.id = n.id;
    u := r -> 'upstream';
    if u is not null and jsonb_typeof(u) = 'object' then
      if not public.kb_suggestions_valid(u -> 'suggestions') then raise exception 'A suggestion is ready or stale and has a text'; end if;
      if char_length(coalesce(u ->> 'base_body', '')) > cap or char_length(coalesce(u ->> 'suggestions', '')) > 3 * cap then raise exception 'The note is too large'; end if;
      insert into public.kb_note_upstream as y (note_id, workspace_id, kb_id, base_hash, base_norm, base_body, suggestions, updated_at)
      values (n.id, n.workspace_id, n.kb_id, coalesce(u ->> 'base_hash', ''), coalesce(u ->> 'base_norm', ''), coalesce(u ->> 'base_body', ''), coalesce(u -> 'suggestions', '[]'), now())
      on conflict (note_id) do update set workspace_id = excluded.workspace_id, kb_id = excluded.kb_id, base_hash = excluded.base_hash,
        base_norm = excluded.base_norm, base_body = excluded.base_body, suggestions = excluded.suggestions, updated_at = now();
    end if;
    return next n.id;
  end loop;
end $$;
revoke all on function public.kb_synced_notes_write(public.ulid, jsonb) from public, anon;
grant execute on function public.kb_synced_notes_write(public.ulid, jsonb) to authenticated, service_role;

-- rows: [{ note_id, base_hash, base_norm, base_body }]. Returns how many bases were recorded
create or replace function public.kb_upstream_save(kb_id public.ulid, rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  n public.notes;
  saved integer := 0;
begin
  if not public.can_admin_kb(kb_upstream_save.kb_id) then raise exception 'Only the knowledge base''s admins can sync it'; end if;
  if jsonb_typeof(coalesce(kb_upstream_save.rows, '[]')) <> 'array' then raise exception 'The rows are not a list'; end if;
  for r in select value from jsonb_array_elements(coalesce(kb_upstream_save.rows, '[]')) loop
    select * into n from public.notes x where x.id = (r ->> 'note_id') and x.kb_id = kb_upstream_save.kb_id and x.deleted_at is null;
    if n.id is null or coalesce(n.frontmatter ->> 'kb_source', '') = '' or not public.note_shared(n.frontmatter) then continue; end if;
    -- the base must be the note's text as it is
    if coalesce(r ->> 'base_hash', '') is distinct from n.hash then continue; end if;
    if char_length(coalesce(r ->> 'base_body', '')) > 6 * 1024 * 1024 then raise exception 'The note is too large'; end if;
    insert into public.kb_note_upstream as y (note_id, workspace_id, kb_id, base_hash, base_norm, base_body, updated_at)
    values (n.id, n.workspace_id, n.kb_id, n.hash, coalesce(r ->> 'base_norm', ''), coalesce(r ->> 'base_body', ''), now())
    on conflict (note_id) do update set workspace_id = excluded.workspace_id, kb_id = excluded.kb_id, base_hash = excluded.base_hash,
      base_norm = excluded.base_norm, base_body = excluded.base_body, updated_at = now();
    saved := saved + 1;
  end loop;
  return saved;
end $$;
revoke all on function public.kb_upstream_save(public.ulid, jsonb) from public, anon;
grant execute on function public.kb_upstream_save(public.ulid, jsonb) to authenticated, service_role;

-- the note with an upstream row, for an admin of the KB the note is in now, or a plain refusal
create or replace function public.kb_suggestion_target(note_id public.ulid) returns public.notes
language plpgsql stable security definer set search_path = public as $$
declare n public.notes;
begin
  select * into n from public.notes x where x.id = kb_suggestion_target.note_id and x.deleted_at is null;
  if n.id is null or n.kb_id is null or not exists (select 1 from public.kb_note_upstream y where y.note_id = n.id) then raise exception 'That suggestion is no longer there'; end if;
  if not public.can_admin_kb(n.kb_id) then raise exception 'Only the knowledge base''s admins can manage its suggestions'; end if;
  return n;
end $$;
revoke all on function public.kb_suggestion_target(public.ulid) from public, anon, authenticated;

create or replace function public.kb_suggestion_apply(note_id public.ulid, suggestion_id text, body text, frontmatter jsonb, hash text, mtime timestamptz, expected_hash text) returns void
language plpgsql security definer set search_path = public as $$
declare
  n public.notes := public.kb_suggestion_target(kb_suggestion_apply.note_id);
  list jsonb;
begin
  select y.suggestions into list from public.kb_note_upstream y where y.note_id = n.id for update;
  if not exists (select 1 from jsonb_array_elements(list) s where s ->> 'id' = kb_suggestion_apply.suggestion_id and s ->> 'state' = 'ready') then
    raise exception 'That suggestion is no longer there';
  end if;
  if n.hash is distinct from kb_suggestion_apply.expected_hash then raise exception 'This note changed since you opened it. Open it again to see the suggestion against the new text'; end if;
  perform public.kb_note_write_check(n, kb_suggestion_apply.frontmatter, kb_suggestion_apply.body, true);
  update public.notes x set body = kb_suggestion_apply.body, frontmatter = kb_suggestion_apply.frontmatter, hash = coalesce(kb_suggestion_apply.hash, ''),
    mtime = kb_suggestion_apply.mtime, updated_at = now()
  where x.id = n.id;
  update public.kb_note_upstream y set suggestions = coalesce((select jsonb_agg(s) from jsonb_array_elements(list) s where s ->> 'id' <> kb_suggestion_apply.suggestion_id), '[]'),
    updated_at = now()
  where y.note_id = n.id;
end $$;
revoke all on function public.kb_suggestion_apply(public.ulid, text, text, jsonb, text, timestamptz, text) from public, anon;
grant execute on function public.kb_suggestion_apply(public.ulid, text, text, jsonb, text, timestamptz, text) to authenticated, service_role;

create or replace function public.kb_suggestion_dismiss(note_id public.ulid, suggestion_id text) returns void
language plpgsql security definer set search_path = public as $$
declare
  n public.notes := public.kb_suggestion_target(kb_suggestion_dismiss.note_id);
  list jsonb;
begin
  select y.suggestions into list from public.kb_note_upstream y where y.note_id = n.id for update;
  if not exists (select 1 from jsonb_array_elements(list) s where s ->> 'id' = kb_suggestion_dismiss.suggestion_id) then raise exception 'That suggestion is no longer there'; end if;
  update public.kb_note_upstream y set suggestions = coalesce((select jsonb_agg(s) from jsonb_array_elements(list) s where s ->> 'id' <> kb_suggestion_dismiss.suggestion_id), '[]'),
    updated_at = now()
  where y.note_id = n.id;
end $$;
revoke all on function public.kb_suggestion_dismiss(public.ulid, text) from public, anon;
grant execute on function public.kb_suggestion_dismiss(public.ulid, text) to authenticated, service_role;
