-- applied-when: select exists(select 1 from pg_tables where schemaname = 'public' and tablename = 'kb_note_upstream')
-- Quorum's edits to synced KB notes, kept as suggestions when the source changes (docs/specs/workspace-knowledge.md,
-- "Maintenance" and Decision 5; the app side is app/ee/kbUpstream.js). A note synced from GitHub, a zip or Google Drive
-- carries kb_source in its frontmatter. Quorum's maintenance and agents may change Quorum's copy; nothing is written
-- back to the source tool.
--
-- 1. kb_note_upstream holds one row per synced note: the upstream base (the text and hash the last sync wrote from the
--    source) and, after a sync that found both the source and Quorum's copy changed, the suggestion: Quorum's edit put
--    onto the new text ('ready'), or Quorum's edit with the old base it was made against ('stale'). Only the KB's admins
--    read it; readers of the KB see none of it. Writes go through the functions below, as for the other KB tables.
-- 2. kb_upstream_save records the base and the suggestion for a batch of notes after a sync. The caller must be an admin
--    of the KB, and each note must be a live synced note in that KB; any other note in the batch is passed over.
-- 3. kb_suggestion_apply writes a ready suggestion into the note (Quorum's copy) and clears it. The base stays, so the
--    note reads as edited by Quorum again. The note may be another admin's row, so the function writes it with the same
--    checks kb_drive_note_write (0028) makes: same source, still shared, under the size cap.
-- 4. kb_suggestion_dismiss clears a suggestion and leaves the note as it is.

create table public.kb_note_upstream (
  note_id public.ulid primary key references public.notes (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  kb_id public.ulid not null references public.knowledge_bases (id) on delete cascade,
  base_hash text not null default '',
  base_body text not null default '',
  suggestion_state text check (suggestion_state in ('ready', 'stale')),
  suggestion_body text,
  suggestion_agent text,
  suggestion_base text,
  suggested_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((suggestion_state is null) = (suggestion_body is null))
);
create index kb_note_upstream_kb on public.kb_note_upstream (kb_id);
alter table public.kb_note_upstream enable row level security;
create policy kb_note_upstream_select on public.kb_note_upstream for select to authenticated using (public.can_admin_kb(kb_id));
-- writes go through the functions below; with no insert, update or delete policy the table API refuses them

create or replace function public.kb_upstream_save(kb_id public.ulid, rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  n public.notes;
  saved integer := 0;
  cap constant integer := 6 * 1024 * 1024;
begin
  if not public.can_admin_kb(kb_upstream_save.kb_id) then raise exception 'Only the knowledge base''s admins can sync it'; end if;
  if jsonb_typeof(coalesce(kb_upstream_save.rows, '[]')) <> 'array' then raise exception 'The rows are not a list'; end if;
  for r in select value from jsonb_array_elements(coalesce(kb_upstream_save.rows, '[]')) loop
    select * into n from public.notes x where x.id = (r ->> 'note_id') and x.kb_id = kb_upstream_save.kb_id and x.deleted_at is null;
    if n.id is null or coalesce(n.frontmatter ->> 'kb_source', '') = '' then continue; end if;
    if r ->> 'suggestion_state' is not null and (r ->> 'suggestion_state' not in ('ready', 'stale') or r ->> 'suggestion_body' is null) then
      raise exception 'A suggestion is ready or stale and has a text';
    end if;
    if greatest(char_length(coalesce(r ->> 'base_body', '')), char_length(coalesce(r ->> 'suggestion_body', '')),
        char_length(coalesce(r ->> 'suggestion_agent', '')), char_length(coalesce(r ->> 'suggestion_base', ''))) > cap then
      raise exception 'The note is too large';
    end if;
    insert into public.kb_note_upstream as u (note_id, workspace_id, kb_id, base_hash, base_body, suggestion_state, suggestion_body, suggestion_agent, suggestion_base, suggested_at, updated_at)
    values (n.id, n.workspace_id, n.kb_id, coalesce(r ->> 'base_hash', ''), coalesce(r ->> 'base_body', ''), r ->> 'suggestion_state', r ->> 'suggestion_body',
      r ->> 'suggestion_agent', r ->> 'suggestion_base', case when r ->> 'suggestion_state' is null then null else now() end, now())
    on conflict (note_id) do update set
      workspace_id = excluded.workspace_id, kb_id = excluded.kb_id, base_hash = excluded.base_hash, base_body = excluded.base_body,
      suggestion_state = excluded.suggestion_state, suggestion_body = excluded.suggestion_body,
      suggestion_agent = excluded.suggestion_agent, suggestion_base = excluded.suggestion_base,
      -- a suggestion carried over unchanged keeps the time it was first made
      suggested_at = case when excluded.suggestion_state is null then null
        when u.suggestion_body is not distinct from excluded.suggestion_body and u.suggestion_state is not distinct from excluded.suggestion_state then u.suggested_at
        else now() end,
      updated_at = now();
    saved := saved + 1;
  end loop;
  return saved;
end $$;
revoke all on function public.kb_upstream_save(public.ulid, jsonb) from public, anon;
grant execute on function public.kb_upstream_save(public.ulid, jsonb) to authenticated, service_role;

-- the note and its upstream row for an admin of the note's KB, or a plain refusal
create or replace function public.kb_suggestion_target(note_id public.ulid) returns public.kb_note_upstream
language plpgsql stable security definer set search_path = public as $$
declare
  n public.notes;
  u public.kb_note_upstream;
begin
  select * into n from public.notes x where x.id = kb_suggestion_target.note_id and x.deleted_at is null;
  select * into u from public.kb_note_upstream y where y.note_id = kb_suggestion_target.note_id;
  if n.id is null or n.kb_id is null or u.note_id is null or u.kb_id is distinct from n.kb_id then raise exception 'That suggestion is no longer there'; end if;
  if not public.can_admin_kb(n.kb_id) then raise exception 'Only the knowledge base''s admins can manage its suggestions'; end if;
  return u;
end $$;
revoke all on function public.kb_suggestion_target(public.ulid) from public, anon, authenticated;

create or replace function public.kb_suggestion_apply(note_id public.ulid, body text, frontmatter jsonb, hash text, mtime timestamptz, suggested_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare
  u public.kb_note_upstream := public.kb_suggestion_target(kb_suggestion_apply.note_id);
  n public.notes;
begin
  if u.suggestion_state is distinct from 'ready' or u.suggested_at is distinct from kb_suggestion_apply.suggested_at then
    raise exception 'That suggestion is no longer there';
  end if;
  select * into n from public.notes x where x.id = u.note_id;
  if coalesce(kb_suggestion_apply.frontmatter ->> 'kb_source', '') is distinct from coalesce(n.frontmatter ->> 'kb_source', '') then
    raise exception 'A synced note keeps the source it came from';
  end if;
  if not public.note_shared(kb_suggestion_apply.frontmatter) then raise exception 'A note in a knowledge base must stay shared with the workspace'; end if;
  if char_length(kb_suggestion_apply.body) > 6 * 1024 * 1024 then raise exception 'The note is too large'; end if;
  update public.notes x set body = kb_suggestion_apply.body, frontmatter = kb_suggestion_apply.frontmatter, hash = coalesce(kb_suggestion_apply.hash, ''),
    mtime = kb_suggestion_apply.mtime, updated_at = now()
  where x.id = n.id;
  update public.kb_note_upstream y set suggestion_state = null, suggestion_body = null, suggestion_agent = null, suggestion_base = null,
    suggested_at = null, updated_at = now()
  where y.note_id = u.note_id;
end $$;
revoke all on function public.kb_suggestion_apply(public.ulid, text, jsonb, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.kb_suggestion_apply(public.ulid, text, jsonb, text, timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.kb_suggestion_dismiss(note_id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
declare u public.kb_note_upstream := public.kb_suggestion_target(kb_suggestion_dismiss.note_id);
begin
  update public.kb_note_upstream y set suggestion_state = null, suggestion_body = null, suggestion_agent = null, suggestion_base = null,
    suggested_at = null, updated_at = now()
  where y.note_id = u.note_id;
end $$;
revoke all on function public.kb_suggestion_dismiss(public.ulid) from public, anon;
grant execute on function public.kb_suggestion_dismiss(public.ulid) to authenticated, service_role;
