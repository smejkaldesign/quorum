-- applied-when: select exists(select 1 from pg_proc where proname = 'kb_meetings_folder')
-- The workspace's meetings knowledge base (docs/specs/workspace-knowledge.md, "Meeting notes" and Decisions 4; the app
-- side is app/ee/meetingsKb.js). A workspace has one team switch and no sub-teams yet, so it has at most one KB of kind
-- 'meetings'. Members' meeting notes are saved into it as shared notes, one top-level folder per month ("2026-11").
-- Five changes:
--
-- 1. One meetings KB per workspace: kb_create refuses a second one, and a partial unique index holds it.
-- 2. Turning the team switch on (0019) makes the meetings KB, readable by the whole workspace; its admins narrow the
--    readers with kb_set_access as for any KB. Workspaces whose switch is already on get one now.
-- 3. kb_meetings_folder gives a member the meetings KB and the folder for a month, making the folder on first use. A
--    member who cannot read the meetings KB (an admin narrowed its readers) gets null, and their notes stay where
--    they are.
-- 4. notes_kb_check (0024) lets a member place their own shared note in the meetings KB, at its top level or in a
--    month folder, without admin rights on the KB. Everything else about placing notes is as 0024 left it. The note
--    is shared (visibility public, not confidential), so 0026 opens its contribution as included with source 'kb'
--    and it skips the review queue the same way an admin's placement does.
-- 5. Keeping a note private is the author setting visibility to private: notes_kb_check already takes a note whose
--    frontmatter stops being shared out of its KB, and note_contribution_sync (0026) withdraws its contribution, so
--    the note is readable by its author only. Sharing it again puts it back through change 4.

-- 1. one meetings KB per workspace. A database that already holds two for one workspace keeps them (the oldest is
-- the one the app and kb_meetings_folder use) and goes without the index; kb_create still refuses a third
do $$
begin
  if exists (select 1 from public.knowledge_bases k where k.kind = 'meetings' group by k.workspace_id having count(*) > 1) then
    raise notice 'a workspace has more than one meetings knowledge base; knowledge_bases_meetings is not created';
  else
    create unique index if not exists knowledge_bases_meetings on public.knowledge_bases (workspace_id) where kind = 'meetings';
  end if;
end $$;

-- 0024's kb_create with one more refusal
create or replace function public.kb_create(workspace_id public.ulid, name text, kind text default 'general', team_id public.ulid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n text := btrim(coalesce(kb_create.name, '')); k public.ulid;
begin
  if not public.is_admin(kb_create.workspace_id) then raise exception 'Only owners and admins can create a knowledge base'; end if;
  if n = '' then raise exception 'A knowledge base needs a name'; end if;
  if char_length(n) > 120 then raise exception 'That name is too long'; end if;
  if coalesce(kb_create.kind, 'general') not in ('general', 'meetings') then raise exception 'A knowledge base is general or meetings'; end if;
  if kb_create.team_id is not null then raise exception 'Teams are not available yet'; end if;
  if kb_create.kind = 'meetings' and exists (select 1 from public.knowledge_bases x where x.workspace_id = kb_create.workspace_id and x.kind = 'meetings') then
    raise exception 'This workspace already has a meetings knowledge base';
  end if;
  if exists (select 1 from public.knowledge_bases x where x.workspace_id = kb_create.workspace_id and lower(btrim(x.name)) = lower(n)) then raise exception 'A knowledge base with that name already exists'; end if;
  insert into public.knowledge_bases (workspace_id, name, kind, created_by) values (kb_create.workspace_id, n, coalesce(kb_create.kind, 'general'), auth.uid()) returning id into k;
  -- a new KB starts readable by the whole workspace; its admins narrow it with kb_set_access
  insert into public.kb_access (kb_id, principal, role, created_by) values (k, 'workspace', 'reader', auth.uid());
  return public.kb_shape(k);
end $$;

-- the workspace's meetings KB, the oldest when there are two
create or replace function public.kb_meetings_of(ws public.ulid) returns public.ulid
language sql stable security definer set search_path = public as $$
  select k.id from public.knowledge_bases k where k.workspace_id = kb_meetings_of.ws and k.kind = 'meetings' order by k.created_at, k.id limit 1;
$$;
revoke all on function public.kb_meetings_of(public.ulid) from public, anon, authenticated;

-- 2. the meetings KB, made on first use and readable by every member; called by the team switch trigger, the backfill
-- below and nothing a client can reach
create or replace function public.kb_ensure_meetings(ws public.ulid) returns public.ulid
language plpgsql security definer set search_path = public as $$
declare k public.ulid := public.kb_meetings_of(ws); w public.workspaces; n text;
begin
  if k is not null then return k; end if;
  select * into w from public.workspaces x where x.id = ws and x.deleted_at is null;
  if w.id is null then return null; end if;
  foreach n in array array['Meetings', 'Meeting notes', 'Team meetings', 'Meetings ' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS')] loop
    exit when not exists (select 1 from public.knowledge_bases x where x.workspace_id = ws and lower(btrim(x.name)) = lower(n));
  end loop;
  begin
    insert into public.knowledge_bases (workspace_id, name, kind, created_by) values (ws, n, 'meetings', w.user_id) returning id into k;
  exception when unique_violation then
    -- another transaction made it first
    return public.kb_meetings_of(ws);
  end;
  insert into public.kb_access (kb_id, principal, role, created_by) values (k, 'workspace', 'reader', w.user_id);
  return k;
end $$;
revoke all on function public.kb_ensure_meetings(public.ulid) from public, anon, authenticated;
grant execute on function public.kb_ensure_meetings(public.ulid) to service_role;

create or replace function public.workspace_meetings_kb() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.kb_ensure_meetings(new.id);
  return new;
end $$;
revoke all on function public.workspace_meetings_kb() from public, anon, authenticated;
create trigger workspaces_meetings_kb after insert or update of team_enabled on public.workspaces
  for each row when (new.team_enabled and new.deleted_at is null) execute function public.workspace_meetings_kb();

do $$
declare w record;
begin
  for w in select x.id from public.workspaces x where x.deleted_at is null and x.team_enabled loop
    perform public.kb_ensure_meetings(w.id);
  end loop;
end $$;

-- 3. the meetings KB and the month's folder for the caller: { kb_id, folder_id, month }, or null when the workspace
-- has no meetings KB or the caller cannot read it
create or replace function public.kb_meetings_folder(workspace_id public.ulid, month text) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare m text := btrim(coalesce(kb_meetings_folder.month, '')); k public.ulid; f public.ulid;
begin
  if not public.is_member(kb_meetings_folder.workspace_id) then raise exception 'That workspace is not one of yours'; end if;
  if m !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'A month folder is named like 2026-11'; end if;
  k := public.kb_meetings_of(kb_meetings_folder.workspace_id);
  if k is null or not public.can_read_kb(k) then return null; end if;
  select x.id into f from public.kb_folders x where x.kb_id = k and x.parent_id is null and lower(btrim(x.name)) = m;
  if f is null then
    begin
      insert into public.kb_folders (kb_id, parent_id, name, position, created_by) values (k, null, m, public.kb_next_position(k, null), auth.uid()) returning id into f;
    exception when unique_violation then
      select x.id into f from public.kb_folders x where x.kb_id = k and x.parent_id is null and lower(btrim(x.name)) = m;
    end;
  end if;
  return jsonb_build_object('kb_id', k, 'folder_id', f, 'month', m);
end $$;
revoke all on function public.kb_meetings_folder(public.ulid, text) from public, anon;
grant execute on function public.kb_meetings_folder(public.ulid, text) to authenticated, service_role;

-- 4. a place a member may put their own note without admin rights: the meetings KB they can read, at its top level or
-- in a month folder
create or replace function public.kb_meetings_open(kb_id public.ulid, folder_id public.ulid, author uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select kb_meetings_open.author = auth.uid()
    and exists (select 1 from public.knowledge_bases k where k.id = kb_meetings_open.kb_id and k.kind = 'meetings')
    and public.can_read_kb(kb_meetings_open.kb_id)
    and (kb_meetings_open.folder_id is null or exists (
      select 1 from public.kb_folders f where f.id = kb_meetings_open.folder_id and f.kb_id = kb_meetings_open.kb_id and f.parent_id is null and f.name ~ '^\d{4}-(0[1-9]|1[0-2])$'));
$$;
revoke all on function public.kb_meetings_open(public.ulid, public.ulid, uuid) from public, anon, authenticated;

-- 0024's notes_kb_check with the meetings KB open to its readers' own notes
create or replace function public.notes_kb_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare was_kb public.ulid := case when tg_op = 'UPDATE' then old.kb_id else null end;
        was_folder public.ulid := case when tg_op = 'UPDATE' then old.folder_id else null end;
        kb_ws public.ulid;
        checked boolean := auth.uid() is not null and coalesce(current_setting('quorum.kb_system', true), '') <> 'on';
begin
  if new.kb_id is not null and not public.note_shared(new.frontmatter) then
    if new.kb_id is not distinct from was_kb then new.kb_id := null;
    else raise exception 'Only notes shared with the workspace can join a knowledge base';
    end if;
  end if;
  if new.kb_id is null then new.folder_id := null; end if;
  if new.kb_id is not distinct from was_kb and new.folder_id is not distinct from was_folder then return new; end if;
  if new.kb_id is not null then
    select k.workspace_id into kb_ws from public.knowledge_bases k where k.id = new.kb_id;
    -- the KB is gone: a delete is clearing its notes, and the foreign key settles the rest
    if kb_ws is null then return new; end if;
    if kb_ws <> new.workspace_id then raise exception 'That knowledge base is in another workspace'; end if;
    if new.folder_id is not null and not exists (select 1 from public.kb_folders f where f.id = new.folder_id and f.kb_id = new.kb_id) then raise exception 'That folder is not in this knowledge base'; end if;
    if checked and not public.can_admin_kb(new.kb_id) and not public.kb_meetings_open(new.kb_id, new.folder_id, new.user_id) then
      raise exception 'Only the knowledge base''s admins can add notes to it';
    end if;
    if checked and new.user_id <> auth.uid() and not public.is_admin(new.workspace_id) then raise exception 'Only the note''s author or a workspace admin can move this note'; end if;
  end if;
  if checked and was_kb is not null and new.kb_id is distinct from was_kb
     and exists (select 1 from public.knowledge_bases k where k.id = was_kb)
     and not (public.can_admin_kb(was_kb) or new.user_id = auth.uid()) then
    raise exception 'Only the knowledge base''s admins or the note''s author can take a note out of it';
  end if;
  return new;
end $$;
revoke all on function public.notes_kb_check() from public, anon, authenticated;
