-- applied-when: select exists(select 1 from pg_proc where proname = 'kb_hosted_note_save')
-- Knowledge bases hosted by Quorum (docs/specs/workspace-knowledge.md, Decisions 1, "Quorum-hosted storage is a later
-- Cloud option"; the app side is app/ee/kbHosted.js). A hosted KB has no upstream source: its notes are written in the
-- Knowledge tab, straight into this table, and live nowhere else first. Its source column reads { "kind": "hosted" }.
--
-- 1. An editor role in kb_access (reader, editor, admin). Editors create, edit, rename, move and delete notes and
--    folders in a hosted KB; they do not change who reads it, rename it or delete it. The role is accepted on hosted KBs
--    only, since the notes of every other KB come from its source. can_edit_kb_as is the one definition of write
--    rights: a KB admin (can_admin_kb_as, 0032) or an editor grant.
-- 2. kb_create_hosted makes an empty hosted KB (owners and admins, on a paid plan), optionally a team's. kb_source_set,
--    kb_note_assign and the table API cannot move a note into or out of a hosted KB or change one: a trigger refuses
--    every write to a hosted KB's notes from a signed-in session unless it comes through the functions here
--    (quorum.kb_system). Hosted notes stay out of the review queue (no contribution row), so a delete keeps the note in
--    its KB and reaches every reader's pull. Deleting an account hands its hosted notes to the workspace's owner;
--    created_by and edited_by say who wrote them and never cascade.
-- 3. Saving a note takes the hash the editor opened (expected_hash). When the note changed or was deleted since,
--    nothing is written and the save answers with the newer version, so the app can offer a merge or "keep mine". The
--    server builds the stored text (a frontmatter block with title, visibility public and kb_hosted, then the content)
--    and its hash, so pull sync and the editor agree on the version. A note's path follows its KB, folders and title;
--    renaming the KB or a folder, moving or deleting a folder moves the notes in the same transaction. Two notes of
--    one folder cannot share a title.
-- 4. Attachments (images and PDFs) live in the private Storage bucket kb-files, one folder per workspace, under
--    <workspace>/<kb>/<note>/<file id>.<ext>, the extension taken from the checked type; the name people see stays in
--    kb_files. A note links to a file as quorum://kb-file/<file id>, which the app resolves to a signed URL. 25 MB per
--    file; the workspace's quota is 2 GB per seat on a paid plan (100 GB on internal, none on free). An upload needs a
--    row begun with kb_file_begin, which checks rights and quota first, and kb_file_done checks the size Storage
--    reports. Objects of removed files go through kb_files_trash: the app deletes them at once, and the relay's sweep
--    (kb_files_cleanup) deletes what is left, with uploads that never finished.
-- 5. Plans. Hosted KBs are Cloud only. When the workspace's plan is free, every hosted KB is read-only: no note,
--    folder or file is written or deleted. Renaming it and changing who reads it stay open, and a workspace owner or
--    admin may still delete the whole KB. Nothing is removed because a plan ended; renewing makes the KB writable.
-- 6. No connector folder or file syncs into a hosted KB (kb_attachments refuses one).

-- 1. the editor role -------------------------------------------------------------------------------------------------
alter table public.kb_access drop constraint if exists kb_access_role_check;
alter table public.kb_access add constraint kb_access_role_check check (role in ('admin', 'editor', 'reader'));

create or replace function public.kb_role_rank(role text) returns integer
language sql immutable set search_path = public as $$
  select case kb_role_rank.role when 'admin' then 3 when 'editor' then 2 when 'reader' then 1 else 0 end;
$$;

create or replace function public.kb_is_hosted(kb_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.knowledge_bases k where k.id = kb_is_hosted.kb_id and k.source ->> 'kind' = 'hosted');
$$;

-- a paid plan: the same rule 0032 uses for KB attachments (free is the only plan without Cloud features)
create or replace function public.kb_plan_active(ws public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select w.plan <> 'free' from public.workspaces w where w.id = kb_plan_active.ws), false);
$$;

create or replace function public.can_edit_kb_as(kb_id public.ulid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_admin_kb_as(can_edit_kb_as.kb_id, can_edit_kb_as.uid) or (uid is not null and exists (
    select 1 from public.knowledge_bases k
    join public.members m on m.workspace_id = k.workspace_id and m.user_id = uid and m.deleted_at is null
    join public.kb_access a on a.kb_id = k.id and a.role = 'editor' and (a.principal = 'workspace' or (a.principal = 'user' and a.user_id = uid))
    where k.id = can_edit_kb_as.kb_id
  ));
$$;
create or replace function public.can_edit_kb(kb_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_edit_kb_as(can_edit_kb.kb_id, auth.uid());
$$;

-- the caller may write the hosted KB now, or a plain refusal
create or replace function public.kb_hosted_write_check(kb_id public.ulid) returns public.knowledge_bases
language plpgsql stable security definer set search_path = public as $$
declare k public.knowledge_bases;
begin
  select * into k from public.knowledge_bases x where x.id = kb_hosted_write_check.kb_id;
  if k.id is null or not public.can_read_kb(k.id) then raise exception 'That knowledge base no longer exists'; end if;
  if coalesce(k.source ->> 'kind', '') <> 'hosted' then raise exception 'That knowledge base is not hosted by Quorum'; end if;
  if not public.can_edit_kb(k.id) then raise exception 'Only the knowledge base''s editors and admins can change it'; end if;
  if not public.kb_plan_active(k.workspace_id) then raise exception 'The workspace''s plan ended, so this knowledge base is read-only. Renew Quorum Cloud to change it again'; end if;
  return k;
end $$;

-- the folder RPCs' rights: on a hosted KB its editors and admins while the plan is active, elsewhere its admins
create or replace function public.kb_arrange_check(kb_id public.ulid, refusal text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if public.kb_is_hosted(kb_arrange_check.kb_id) then perform public.kb_hosted_write_check(kb_arrange_check.kb_id);
  elsif not public.can_admin_kb(kb_arrange_check.kb_id) then raise exception '%', refusal;
  end if;
end $$;

-- 0024's kb_shape with the editor role and two keys: hosted, and writable (the caller may write it now)
create or replace function public.kb_shape(kb_id public.ulid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', k.id, 'workspace_id', k.workspace_id, 'name', k.name, 'kind', k.kind, 'team_id', k.team_id, 'is_default', k.is_default,
    'source', k.source, 'created_by', k.created_by, 'created_at', k.created_at, 'updated_at', k.updated_at,
    'role', case when public.can_admin_kb(k.id) then 'admin' when public.can_edit_kb(k.id) then 'editor' else 'reader' end,
    'hosted', coalesce(k.source ->> 'kind', '') = 'hosted',
    'writable', coalesce(k.source ->> 'kind', '') = 'hosted' and public.can_edit_kb(k.id) and public.kb_plan_active(k.workspace_id),
    'folders', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'parent_id', f.parent_id, 'name', f.name, 'position', f.position) order by f.position, lower(f.name))
                         from public.kb_folders f where f.kb_id = k.id), '[]'::jsonb),
    'access', case when public.can_admin_kb(k.id) then coalesce((
      select jsonb_agg(jsonb_build_object('principal', a.principal, 'user_id', a.user_id, 'team_id', a.team_id, 'role', a.role, 'email', p.email, 'name', p.name) order by a.principal desc, p.email)
      from public.kb_access a left join public.profiles p on p.user_id = a.user_id where a.kb_id = k.id), '[]'::jsonb) else null end
  )
  from public.knowledge_bases k where k.id = kb_shape.kb_id and public.can_read_kb(k.id);
$$;

-- 0024's kb_set_access with the editor role: accepted on hosted KBs only, and a person or the workspace named twice
-- keeps the highest role (admin, then editor, then reader). The touch of the KB's notes runs as a system write
create or replace function public.kb_set_access(kb_id public.ulid, access jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare ws public.ulid; e jsonb; p text; r text; u uuid; before text[]; hosted boolean;
begin
  select k.workspace_id, coalesce(k.source ->> 'kind', '') = 'hosted' into ws, hosted from public.knowledge_bases k where k.id = kb_set_access.kb_id;
  if ws is null or not public.can_read_kb(kb_set_access.kb_id) then raise exception 'That knowledge base no longer exists'; end if;
  if not public.can_admin_kb(kb_set_access.kb_id) then raise exception 'Only the knowledge base''s admins can change who reads it'; end if;
  if jsonb_typeof(coalesce(kb_set_access.access, '[]'::jsonb)) <> 'array' then raise exception 'Access is a list of readers and admins'; end if;
  before := array(select a.principal || ':' || coalesce(a.user_id::text, a.team_id::text, '') from public.kb_access a where a.kb_id = kb_set_access.kb_id);
  delete from public.kb_access a where a.kb_id = kb_set_access.kb_id;
  for e in select * from jsonb_array_elements(coalesce(kb_set_access.access, '[]'::jsonb)) loop
    p := coalesce(e ->> 'principal', '');
    r := coalesce(e ->> 'role', 'reader');
    if r not in ('admin', 'editor', 'reader') then raise exception 'A role is admin, editor or reader'; end if;
    if r = 'editor' and not hosted then raise exception 'Editors are for knowledge bases hosted by Quorum'; end if;
    if p = 'team' then raise exception 'Teams are not available yet'; end if;
    if p = 'workspace' then
      insert into public.kb_access (kb_id, principal, role, created_by) values (kb_set_access.kb_id, 'workspace', r, auth.uid())
        on conflict (kb_id, principal, coalesce(user_id::text, team_id::text, '')) do update set role = case when public.kb_role_rank(excluded.role) > public.kb_role_rank(public.kb_access.role) then excluded.role else public.kb_access.role end;
    elsif p = 'user' then
      begin u := (e ->> 'user_id')::uuid; exception when others then raise exception 'That person is not a member of this workspace'; end;
      if u is null or not exists (select 1 from public.members m where m.workspace_id = ws and m.user_id = u and m.deleted_at is null) then raise exception 'That person is not a member of this workspace'; end if;
      insert into public.kb_access (kb_id, principal, user_id, role, created_by) values (kb_set_access.kb_id, 'user', u, r, auth.uid())
        on conflict (kb_id, principal, coalesce(user_id::text, team_id::text, '')) do update set role = case when public.kb_role_rank(excluded.role) > public.kb_role_rank(public.kb_access.role) then excluded.role else public.kb_access.role end;
    else raise exception 'A reader is the workspace, a team or a person';
    end if;
  end loop;
  if exists (select 1 from public.kb_access a where a.kb_id = kb_set_access.kb_id and not (a.principal || ':' || coalesce(a.user_id::text, a.team_id::text, '')) = any (before)) then
    perform set_config('quorum.kb_system', 'on', true);
    update public.notes n set updated_at = now() where n.kb_id = kb_set_access.kb_id and n.deleted_at is null;
    perform set_config('quorum.kb_system', '', true);
  end if;
  return public.kb_shape(kb_set_access.kb_id) -> 'access';
end $$;

-- 2. hosted KBs and their notes ---------------------------------------------------------------------------------------
-- team_id makes the hosted KB a team's KB. kb_create checks it: with no teams table yet (0024) it refuses any team,
-- and once teams exist (0035) it takes a team of this workspace, whose members read the KB and whose leads manage it
create or replace function public.kb_create_hosted(workspace_id public.ulid, name text, team_id public.ulid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare k public.ulid;
begin
  if not public.is_admin(kb_create_hosted.workspace_id) then raise exception 'Only owners and admins can create a knowledge base'; end if;
  if not public.kb_plan_active(kb_create_hosted.workspace_id) then raise exception 'Knowledge bases hosted by Quorum are part of Quorum Cloud'; end if;
  k := (public.kb_create(kb_create_hosted.workspace_id, kb_create_hosted.name, 'general', kb_create_hosted.team_id)) ->> 'id';
  update public.knowledge_bases x set source = jsonb_build_object('kind', 'hosted', 'set_by', auth.uid(), 'created_at', now()) where x.id = k;
  return public.kb_shape(k);
end $$;

-- 0026's kb_source_set, refusing a hosted KB: its notes are written in Quorum and have no source to import from
create or replace function public.kb_source_set(kb_id public.ulid, source jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare src_kind text := coalesce(kb_source_set.source ->> 'kind', '');
        src_url text := nullif(btrim(coalesce(kb_source_set.source ->> 'url', '')), '');
        src_subpath text := nullif(btrim(coalesce(kb_source_set.source ->> 'subpath', ''), ' /'), '');
        current_kind text;
begin
  if not public.can_read_kb(kb_source_set.kb_id) then raise exception 'That knowledge base no longer exists'; end if;
  if not public.can_admin_kb(kb_source_set.kb_id) then raise exception 'Only the knowledge base''s admins can change where it is imported from'; end if;
  select k.source ->> 'kind' into current_kind from public.knowledge_bases k where k.id = kb_source_set.kb_id;
  if current_kind = 'hosted' then raise exception 'A knowledge base hosted by Quorum is written in Quorum and is not imported from a source'; end if;
  if src_kind not in ('github', 'zip') then raise exception 'A knowledge base is imported from a GitHub repository or a zip'; end if;
  if src_kind = 'github' and (src_url is null or src_url !~ '^https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+$') then raise exception 'Enter a GitHub repository address'; end if;
  if src_subpath is not null and (char_length(src_subpath) > 500 or src_subpath ~ '(^|/)\.\.?(/|$)') then raise exception 'That folder path is not valid'; end if;
  if coalesce(current_kind, '') not in ('folder', 'git') then
    update public.knowledge_bases k set source = jsonb_build_object(
      'kind', src_kind,
      'url', case when src_kind = 'github' then src_url else null end,
      'branch', case when src_kind = 'github' then nullif(left(btrim(coalesce(kb_source_set.source ->> 'branch', '')), 200), '') else null end,
      'subpath', case when src_kind = 'github' then src_subpath else null end,
      'name', nullif(left(btrim(coalesce(kb_source_set.source ->> 'name', '')), 200), ''),
      'path', null,
      'set_by', auth.uid(), 'imported_at', now())
    where k.id = kb_source_set.kb_id;
  end if;
  return public.kb_shape(kb_source_set.kb_id);
end $$;

-- who made a hosted note and who saved it last. These never cascade: deleting an account keeps the note (below)
alter table public.notes
  add column created_by uuid references auth.users (id) on delete set null,
  add column edited_by uuid references auth.users (id) on delete set null;

-- a hosted KB's notes change only through the functions below. A signed-in write that would add a note to a hosted
-- KB, change or delete one, or take one out is refused; session-less writes (migrations, the service role) and the
-- system paths that set quorum.kb_system pass
create or replace function public.kb_hosted_notes_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or coalesce(current_setting('quorum.kb_system', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if (tg_op <> 'INSERT' and old.kb_id is not null and public.kb_is_hosted(old.kb_id))
     or (tg_op <> 'DELETE' and new.kb_id is not null and public.kb_is_hosted(new.kb_id)) then
    raise exception 'Notes in a knowledge base hosted by Quorum are changed from the Knowledge tab';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.kb_hosted_notes_guard() from public, anon, authenticated;
create trigger notes_kb_hosted_guard before insert or update or delete on public.notes for each row execute function public.kb_hosted_notes_guard();

-- the review queue (0012, 0026) is for notes people share from their vaults. A hosted note has no contribution row:
-- 0026's note_contribution_sync skips it, so a soft delete never withdraws a contribution, and 0024's
-- contribution_kb_sync never takes a hosted note out of its KB. The deleted note keeps its kb_id, so every reader's
-- pull still receives the deletion
create or replace function public.note_contribution_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare pub boolean := coalesce(new.frontmatter ->> 'visibility', 'private') = 'public' and new.deleted_at is null;
        conf boolean := coalesce(new.frontmatter ->> 'confidential', '') <> '';
        ws_auto boolean;
        by_kb boolean;
begin
  if new.kb_id is not null and public.kb_is_hosted(new.kb_id) then return new; end if;
  if pub and not conf then
    select coalesce(w.auto_include, false) into ws_auto from public.workspaces w where w.id = new.workspace_id;
    by_kb := not coalesce(ws_auto, false) and new.kb_id is not null;
    insert into public.contributions (workspace_id, note_id, author_id, status, reviewed_at, source)
      values (new.workspace_id, new.id, new.user_id, case when ws_auto or by_kb then 'included' else 'pending' end, case when ws_auto or by_kb then now() else null end, case when by_kb then 'kb' else 'review' end)
    on conflict (note_id) do update set status = case when contributions.status in ('included', 'declined') then contributions.status when excluded.status = 'included' then 'included' else 'pending' end,
                                       reviewed_at = case when contributions.status in ('included', 'declined') then contributions.reviewed_at else excluded.reviewed_at end,
                                       source = case when contributions.status in ('included', 'declined') then contributions.source else excluded.source end
      where contributions.status = 'withdrawn' or contributions.status = 'pending';
  else
    update public.contributions c set status = 'withdrawn' where c.note_id = new.id and c.status <> 'withdrawn';
  end if;
  return new;
end $$;

create or replace function public.contribution_kb_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare k public.ulid;
begin
  if new.status in ('declined', 'withdrawn') then
    perform set_config('quorum.kb_system', 'on', true);
    update public.notes n set kb_id = null, folder_id = null where n.id = new.note_id and n.kb_id is not null and not public.kb_is_hosted(n.kb_id);
    perform set_config('quorum.kb_system', '', true);
  elsif new.status = 'included' then
    select x.id into k from public.knowledge_bases x where x.workspace_id = new.workspace_id and x.is_default;
    if k is not null then
      perform set_config('quorum.kb_system', 'on', true);
      update public.notes n set kb_id = k, folder_id = null where n.id = new.note_id and n.kb_id is null and n.deleted_at is null and public.note_shared(n.frontmatter);
      perform set_config('quorum.kb_system', '', true);
    end if;
  end if;
  return new;
end $$;

-- deleting an account never deletes a hosted note. notes.user_id cascades (0001), so before the account goes its
-- hosted notes, deleted ones included (pull reads their tombstones), pass to the workspace's owner, or else to its
-- longest-standing owner, admin or member. A workspace whose owner is the account goes with it (0001), notes and all
create or replace function public.kb_hosted_keep_notes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('quorum.kb_system', 'on', true);
  update public.notes n set user_id = heir.uid
  from (
    select x.id, coalesce(
      (select w.user_id from public.workspaces w where w.id = x.workspace_id and w.user_id <> old.id),
      (select m.user_id from public.members m where m.workspace_id = x.workspace_id and m.user_id <> old.id and m.deleted_at is null
        order by (m.role = 'owner') desc, (m.role = 'admin') desc, m.created_at limit 1)) as uid
    from public.notes x
    where x.user_id = old.id and x.kb_id is not null and x.frontmatter ? 'kb_hosted' and public.kb_is_hosted(x.kb_id)
  ) heir
  where n.id = heir.id and heir.uid is not null;
  perform set_config('quorum.kb_system', '', true);
  return old;
end $$;
revoke all on function public.kb_hosted_keep_notes() from public, anon, authenticated;
create trigger auth_users_kb_hosted_keep before delete on auth.users for each row execute function public.kb_hosted_keep_notes();

-- one path segment as the app writes it (safeSeg in app/ee/kbImport.js): no slashes or characters a file name cannot
-- hold, spaces collapsed, at most 80 characters
create or replace function public.kb_path_seg(s text, fallback text) returns text
language sql immutable set search_path = public as $$
  select coalesce(nullif(btrim(left(btrim(regexp_replace(regexp_replace(coalesce(s, ''), '[\\/:*?"<>|]+', ' ', 'g'), '\s+', ' ', 'g')), 80)), ''), fallback);
$$;

-- where a hosted note sits on members' Macs: Knowledge bases/<KB>/<folders>/<title>.md, as imported notes do
create or replace function public.kb_hosted_path(kb_id public.ulid, folder_id public.ulid, title text) returns text
language sql stable security definer set search_path = public as $$
  select 'Knowledge bases/' || public.kb_path_seg(k.name, 'Knowledge base') || '/'
    || coalesce((select string_agg(public.kb_path_seg(s, 'Folder'), '/') || '/' from unnest(case when kb_hosted_path.folder_id is null then '{}'::text[] else public.kb_folder_path(kb_hosted_path.folder_id) end) s), '')
    || public.kb_path_seg(kb_hosted_path.title, 'Untitled') || '.md'
  from public.knowledge_bases k where k.id = kb_hosted_path.kb_id;
$$;

-- the path for one note: its place, or, when another live note of the workspace already holds that path (two names
-- that read the same once cleaned, or a note of another KB), the same with the end of the note's id added
create or replace function public.kb_hosted_free_path(note_id public.ulid, workspace_id public.ulid, kb_id public.ulid, folder_id public.ulid, title text) returns text
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare p text := public.kb_hosted_path(kb_hosted_free_path.kb_id, kb_hosted_free_path.folder_id, kb_hosted_free_path.title);
begin
  if exists (select 1 from public.notes x where x.workspace_id = kb_hosted_free_path.workspace_id and lower(x.path) = lower(p) and x.deleted_at is null and x.id <> kb_hosted_free_path.note_id) then
    p := left(p, -3) || ' (' || right(kb_hosted_free_path.note_id::text, 6) || ').md';
  end if;
  return p;
end $$;

-- every live note of a hosted KB at the path its folders and title give now; run in the same transaction as a KB or
-- folder rename, a folder move and a folder delete, so pull sync moves each copy
create or replace function public.kb_hosted_repath(kb_id public.ulid) returns integer
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n record; p text; moved integer := 0;
begin
  if not public.kb_is_hosted(kb_hosted_repath.kb_id) then return 0; end if;
  perform set_config('quorum.kb_system', 'on', true);
  for n in select x.id, x.workspace_id, x.folder_id, x.path, x.frontmatter ->> 'title' as title from public.notes x
           where x.kb_id = kb_hosted_repath.kb_id and x.deleted_at is null order by x.id loop
    p := public.kb_hosted_free_path(n.id, n.workspace_id, kb_hosted_repath.kb_id, n.folder_id, coalesce(n.title, 'Untitled'));
    if p is distinct from n.path then
      update public.notes x set path = p, updated_at = now() where x.id = n.id;
      moved := moved + 1;
    end if;
  end loop;
  perform set_config('quorum.kb_system', '', true);
  return moved;
end $$;

-- a title is taken when another live note in the same folder of the KB has it, compared without case
create or replace function public.kb_hosted_title_taken(kb_id public.ulid, folder_id public.ulid, title text, note_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.notes x where x.kb_id = kb_hosted_title_taken.kb_id and x.folder_id is not distinct from kb_hosted_title_taken.folder_id
    and x.deleted_at is null and x.id <> kb_hosted_title_taken.note_id and lower(btrim(x.frontmatter ->> 'title')) = lower(btrim(kb_hosted_title_taken.title)));
$$;

-- the stored text: a frontmatter block the server owns, then the content as the editor wrote it
create or replace function public.kb_hosted_text(kb_id public.ulid, title text, content text) returns text
language sql immutable set search_path = public as $$
  select '---' || E'\n' || 'title: ' || to_json(kb_hosted_text.title)::text || E'\n' || 'visibility: public' || E'\n' || 'kb_hosted: ' || kb_hosted_text.kb_id || E'\n' || '---' || E'\n'
    || replace(replace(coalesce(kb_hosted_text.content, ''), E'\r\n', E'\n'), E'\r', E'\n');
$$;

create or replace function public.kb_text_hash(t text) returns text
language sql immutable set search_path = public as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex'); $$;

-- a note as the editor and a conflict answer carry it
create or replace function public.kb_hosted_note_row(n public.notes) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', n.id, 'kb_id', n.kb_id, 'folder_id', n.folder_id, 'path', n.path, 'title', n.frontmatter ->> 'title', 'body', n.body, 'hash', n.hash,
    'updated_at', n.updated_at, 'deleted', n.deleted_at is not null, 'edited_by', n.edited_by,
    'edited_by_name', (select coalesce(nullif(p.name, ''), p.email) from public.profiles p where p.user_id = n.edited_by));
$$;

-- creates a note (note_id not used yet, expected_hash null) or saves one the caller opened at expected_hash. A note
-- that was deleted or changed since is left as it is, and the answer is { conflict: true, note } with the newer
-- version (note.deleted true when it was deleted). Otherwise { ok: true, note }
create or replace function public.kb_hosted_note_save(kb_id public.ulid, note_id public.ulid, folder_id public.ulid, title text, content text, expected_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare k public.knowledge_bases := public.kb_hosted_write_check(kb_hosted_note_save.kb_id);
        t text := btrim(coalesce(kb_hosted_note_save.title, ''));
        n public.notes;
        p text; txt text; fm jsonb;
begin
  if t = '' then raise exception 'A note needs a title'; end if;
  if char_length(t) > 200 then raise exception 'That title is too long'; end if;
  if char_length(coalesce(kb_hosted_note_save.content, '')) > 6 * 1024 * 1024 then raise exception 'The note is too large'; end if;
  if kb_hosted_note_save.folder_id is not null and not exists (select 1 from public.kb_folders f where f.id = kb_hosted_note_save.folder_id and f.kb_id = k.id) then
    raise exception 'That folder is not in this knowledge base';
  end if;
  if kb_hosted_note_save.note_id is null then raise exception 'Pick the note first'; end if;
  select * into n from public.notes x where x.id = kb_hosted_note_save.note_id for update;
  if n.id is not null and n.workspace_id <> k.workspace_id then raise exception 'That note is not in this knowledge base'; end if;
  -- deleted first: a deleted note may have left its KB on the way
  if n.id is not null and n.deleted_at is not null then
    return jsonb_build_object('conflict', true, 'note', jsonb_build_object('id', n.id, 'deleted', true));
  end if;
  if n.id is not null and n.kb_id is distinct from k.id then raise exception 'That note is not in this knowledge base'; end if;
  if n.id is null and kb_hosted_note_save.expected_hash is not null then
    return jsonb_build_object('conflict', true, 'note', jsonb_build_object('id', kb_hosted_note_save.note_id, 'deleted', true));
  end if;
  if n.id is not null and n.hash is distinct from kb_hosted_note_save.expected_hash then return jsonb_build_object('conflict', true, 'note', public.kb_hosted_note_row(n)); end if;
  if public.kb_hosted_title_taken(k.id, kb_hosted_note_save.folder_id, t, kb_hosted_note_save.note_id) then
    raise exception 'A note with that title is already in this folder';
  end if;
  p := public.kb_hosted_free_path(kb_hosted_note_save.note_id, k.workspace_id, k.id, kb_hosted_note_save.folder_id, t);
  txt := public.kb_hosted_text(k.id, t, kb_hosted_note_save.content);
  fm := jsonb_build_object('title', t, 'visibility', 'public', 'kb_hosted', k.id::text);
  perform set_config('quorum.kb_system', 'on', true);
  if n.id is null then
    insert into public.notes (id, user_id, workspace_id, path, frontmatter, body, hash, mtime, kb_id, folder_id, created_by, edited_by)
      values (kb_hosted_note_save.note_id, auth.uid(), k.workspace_id, p, fm, txt, public.kb_text_hash(txt), now(), k.id, kb_hosted_note_save.folder_id, auth.uid(), auth.uid())
      returning * into n;
  else
    update public.notes x set path = p, frontmatter = fm, body = txt, hash = public.kb_text_hash(txt), mtime = now(),
      folder_id = kb_hosted_note_save.folder_id, edited_by = auth.uid(), updated_at = now()
      where x.id = n.id returning * into n;
  end if;
  perform set_config('quorum.kb_system', '', true);
  return jsonb_build_object('ok', true, 'note', public.kb_hosted_note_row(n));
end $$;

-- the live note of a hosted KB the caller may write, locked for the change
create or replace function public.kb_hosted_note_target(note_id public.ulid) returns public.notes
language plpgsql security definer set search_path = public as $$
declare n public.notes;
begin
  select * into n from public.notes x where x.id = kb_hosted_note_target.note_id and x.deleted_at is null for update;
  if n.id is null or n.kb_id is null or not public.can_read_kb(n.kb_id) then raise exception 'That note no longer exists'; end if;
  perform public.kb_hosted_write_check(n.kb_id);
  return n;
end $$;
revoke all on function public.kb_hosted_note_target(public.ulid) from public, anon, authenticated;

-- a move to another folder of the same KB (null: the top level); the text and its hash stay, the path follows
create or replace function public.kb_hosted_note_move(note_id public.ulid, folder_id public.ulid) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n public.notes := public.kb_hosted_note_target(kb_hosted_note_move.note_id);
        t text := coalesce(n.frontmatter ->> 'title', 'Untitled');
begin
  if kb_hosted_note_move.folder_id is not null and not exists (select 1 from public.kb_folders f where f.id = kb_hosted_note_move.folder_id and f.kb_id = n.kb_id) then
    raise exception 'That folder is not in this knowledge base';
  end if;
  if public.kb_hosted_title_taken(n.kb_id, kb_hosted_note_move.folder_id, t, n.id) then raise exception 'A note with that title is already in that folder'; end if;
  perform set_config('quorum.kb_system', 'on', true);
  update public.notes x set folder_id = kb_hosted_note_move.folder_id, path = public.kb_hosted_free_path(n.id, n.workspace_id, n.kb_id, kb_hosted_note_move.folder_id, t), updated_at = now()
    where x.id = n.id returning * into n;
  perform set_config('quorum.kb_system', '', true);
  return jsonb_build_object('ok', true, 'note', public.kb_hosted_note_row(n));
end $$;

-- 0024's kb_rename, moving a hosted KB's notes to the new name's folder in the same transaction. Renaming stays open
-- on a lapsed plan (it changes no note's text)
create or replace function public.kb_rename(kb_id public.ulid, name text) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n text := btrim(coalesce(kb_rename.name, '')); ws public.ulid;
begin
  select k.workspace_id into ws from public.knowledge_bases k where k.id = kb_rename.kb_id;
  if ws is null or not public.can_read_kb(kb_rename.kb_id) then raise exception 'That knowledge base no longer exists'; end if;
  if not public.can_admin_kb(kb_rename.kb_id) then raise exception 'Only the knowledge base''s admins can rename it'; end if;
  if n = '' then raise exception 'A knowledge base needs a name'; end if;
  if char_length(n) > 120 then raise exception 'That name is too long'; end if;
  if exists (select 1 from public.knowledge_bases x where x.workspace_id = ws and x.id <> kb_rename.kb_id and lower(btrim(x.name)) = lower(n)) then raise exception 'A knowledge base with that name already exists'; end if;
  update public.knowledge_bases k set name = n where k.id = kb_rename.kb_id;
  perform public.kb_hosted_repath(kb_rename.kb_id);
  return public.kb_shape(kb_rename.kb_id);
end $$;

-- 0024's folder RPCs with the hosted rights (kb_arrange_check). On a hosted KB a rename, move or delete moves the
-- notes under the folder to their new paths in the same transaction; a delete moves its notes to the KB's top level
-- through the foreign key, which runs as a system write so the hosted guard lets it through
create or replace function public.kb_folder_create(kb_id public.ulid, parent_id public.ulid, name text, "position" integer default null) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n text := btrim(coalesce(kb_folder_create.name, '')); f public.kb_folders;
begin
  perform public.kb_arrange_check(kb_folder_create.kb_id, 'Only the knowledge base''s admins can add folders');
  if n = '' then raise exception 'A folder needs a name'; end if;
  if char_length(n) > 120 or n ~ '[/\\]' then raise exception 'A folder name is up to 120 characters without slashes'; end if;
  if exists (select 1 from public.kb_folders x where x.kb_id = kb_folder_create.kb_id and x.parent_id is not distinct from kb_folder_create.parent_id and lower(btrim(x.name)) = lower(n)) then raise exception 'A folder with that name is already there'; end if;
  insert into public.kb_folders (kb_id, parent_id, name, position, created_by)
    values (kb_folder_create.kb_id, kb_folder_create.parent_id, n, coalesce(kb_folder_create."position", public.kb_next_position(kb_folder_create.kb_id, kb_folder_create.parent_id)), auth.uid())
    returning * into f;
  return jsonb_build_object('id', f.id, 'kb_id', f.kb_id, 'parent_id', f.parent_id, 'name', f.name, 'position', f.position);
end $$;

create or replace function public.kb_folder_rename(folder_id public.ulid, name text) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n text := btrim(coalesce(kb_folder_rename.name, '')); f public.kb_folders;
begin
  select * into f from public.kb_folders x where x.id = kb_folder_rename.folder_id;
  if f.id is null or not public.can_read_kb(f.kb_id) then raise exception 'That folder no longer exists'; end if;
  perform public.kb_arrange_check(f.kb_id, 'Only the knowledge base''s admins can rename folders');
  if n = '' then raise exception 'A folder needs a name'; end if;
  if char_length(n) > 120 or n ~ '[/\\]' then raise exception 'A folder name is up to 120 characters without slashes'; end if;
  if exists (select 1 from public.kb_folders x where x.kb_id = f.kb_id and x.parent_id is not distinct from f.parent_id and x.id <> f.id and lower(btrim(x.name)) = lower(n)) then raise exception 'A folder with that name is already there'; end if;
  update public.kb_folders x set name = n where x.id = f.id returning * into f;
  perform public.kb_hosted_repath(f.kb_id);
  return jsonb_build_object('id', f.id, 'kb_id', f.kb_id, 'parent_id', f.parent_id, 'name', f.name, 'position', f.position);
end $$;

create or replace function public.kb_folder_move(folder_id public.ulid, parent_id public.ulid, "position" integer default null, reparent boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare f public.kb_folders; target public.ulid;
begin
  select * into f from public.kb_folders x where x.id = kb_folder_move.folder_id;
  if f.id is null or not public.can_read_kb(f.kb_id) then raise exception 'That folder no longer exists'; end if;
  perform public.kb_arrange_check(f.kb_id, 'Only the knowledge base''s admins can move folders');
  target := case when coalesce(kb_folder_move.reparent, true) then kb_folder_move.parent_id else f.parent_id end;
  if target = f.id then raise exception 'A folder cannot move inside itself'; end if;
  if exists (select 1 from public.kb_folders x where x.kb_id = f.kb_id and x.parent_id is not distinct from target and x.id <> f.id and lower(btrim(x.name)) = lower(btrim(f.name))) then raise exception 'A folder with that name is already there'; end if;
  update public.kb_folders x
    set parent_id = target,
        position = coalesce(kb_folder_move."position", case when x.parent_id is not distinct from target then x.position else public.kb_next_position(f.kb_id, target) end)
    where x.id = f.id returning * into f;
  perform public.kb_hosted_repath(f.kb_id);
  return jsonb_build_object('id', f.id, 'kb_id', f.kb_id, 'parent_id', f.parent_id, 'name', f.name, 'position', f.position);
end $$;

create or replace function public.kb_folder_delete(folder_id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare f public.kb_folders;
begin
  select * into f from public.kb_folders x where x.id = kb_folder_delete.folder_id;
  if f.id is null or not public.can_read_kb(f.kb_id) then raise exception 'That folder no longer exists'; end if;
  perform public.kb_arrange_check(f.kb_id, 'Only the knowledge base''s admins can delete folders');
  if public.kb_is_hosted(f.kb_id) then perform set_config('quorum.kb_system', 'on', true); end if;
  delete from public.kb_folders x where x.id = f.id;
  perform set_config('quorum.kb_system', '', true);
  perform public.kb_hosted_repath(f.kb_id);
end $$;

-- a KB hosted by Quorum is written in Quorum, so no connector folder syncs into it (0032, relay/kbSync)
create or replace function public.kb_attachments_not_hosted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.kb_is_hosted(new.kb_id) then raise exception 'A knowledge base hosted by Quorum is written in Quorum and takes no synced folders or files'; end if;
  return new;
end $$;
revoke all on function public.kb_attachments_not_hosted() from public, anon, authenticated;
create trigger kb_attachments_not_hosted before insert or update of kb_id on public.kb_attachments for each row execute function public.kb_attachments_not_hosted();

-- 4. attachments ------------------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kb-files', 'kb-files', false, 26214400, array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do nothing;

create table public.kb_files (
  id public.ulid primary key default public.gen_ulid(),
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  kb_id public.ulid not null references public.knowledge_bases (id) on delete cascade,
  note_id public.ulid not null references public.notes (id) on delete cascade,
  -- the name people see; the object key never holds it (kb_file_begin)
  name text not null check (char_length(btrim(name)) between 1 and 200 and name !~ '[/\\[:cntrl:]]'),
  mime text not null,
  size bigint not null check (size between 1 and 26214400),
  object_path text not null unique,
  -- false until the upload finished (kb_file_done); a row that never finishes stops counting toward the quota after an
  -- hour, and kb_files_cleanup takes it away after a day
  uploaded boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index kb_files_note on public.kb_files (note_id);
create index kb_files_kb on public.kb_files (kb_id);
create index kb_files_workspace on public.kb_files (workspace_id);
create index kb_files_pending on public.kb_files (created_at) where not uploaded;
alter table public.kb_files enable row level security;
create policy kb_files_select on public.kb_files for select to authenticated using (uploaded and public.can_read_kb(kb_id));
-- writes go through the functions below

-- objects whose rows are gone (a removed file, a deleted note or KB, an upload refused at kb_file_done, a pending
-- upload swept by kb_files_cleanup). The app deletes them from Storage right after the call that put them here; the
-- relay's cleanup deletes what is left and clears the rows. No client role reads this table
create table public.kb_files_trash (
  object_path text primary key,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  kb_id public.ulid,
  created_at timestamptz not null default now()
);
alter table public.kb_files_trash enable row level security;
revoke all on public.kb_files_trash from anon, authenticated;
grant select, insert, update, delete on public.kb_files_trash to service_role;

create or replace function public.kb_files_trash_put(paths text[], ws public.ulid, kb public.ulid) returns jsonb
language sql security definer set search_path = public as $$
  with put as (
    insert into public.kb_files_trash (object_path, workspace_id, kb_id)
    select p, kb_files_trash_put.ws, kb_files_trash_put.kb from unnest(coalesce(kb_files_trash_put.paths, '{}'::text[])) p where p is not null
    on conflict (object_path) do nothing returning 1
  ) select coalesce(to_jsonb(kb_files_trash_put.paths), '[]'::jsonb);
$$;

-- 0024's kb_delete, now with an answer: { objects } lists the Storage objects of the KB's files (pending uploads
-- included) for the app to remove once the delete went through. A hosted KB's notes have no other home, so they are
-- soft deleted with it, and every Mac removes its copies (the deleted rows leave the KB with it; pull sync drops a
-- copy whose note it no longer reads). A workspace owner or admin may delete a hosted KB on a lapsed plan too
drop function if exists public.kb_delete(public.ulid);
create function public.kb_delete(kb_id public.ulid) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare ws public.ulid; hosted boolean; objects text[];
begin
  select k.workspace_id, coalesce(k.source ->> 'kind', '') = 'hosted' into ws, hosted from public.knowledge_bases k where k.id = kb_delete.kb_id;
  if ws is null or not public.is_member(ws) then raise exception 'That knowledge base no longer exists'; end if;
  if not public.is_admin(ws) then raise exception 'Only owners and admins can delete a knowledge base'; end if;
  objects := array(select f.object_path from public.kb_files f where f.kb_id = kb_delete.kb_id order by f.id);
  perform public.kb_files_trash_put(objects, ws, kb_delete.kb_id);
  if hosted then
    perform set_config('quorum.kb_system', 'on', true);
    update public.notes n set deleted_at = now(), updated_at = now() where n.kb_id = kb_delete.kb_id and n.deleted_at is null;
  end if;
  delete from public.knowledge_bases k where k.id = kb_delete.kb_id;
  perform set_config('quorum.kb_system', '', true);
  return jsonb_build_object('ok', true, 'objects', to_jsonb(objects));
end $$;

-- a delete of the version the caller opened: soft deleted, keeping its KB, so every reader's pull receives the
-- deletion. Its files' rows go (pending uploads too), and the answer lists their objects for the app to remove from
-- Storage. A note that changed since answers as a save does
create or replace function public.kb_hosted_note_delete(note_id public.ulid, expected_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n public.notes := public.kb_hosted_note_target(kb_hosted_note_delete.note_id);
        objects text[];
begin
  if n.hash is distinct from kb_hosted_note_delete.expected_hash then return jsonb_build_object('conflict', true, 'note', public.kb_hosted_note_row(n)); end if;
  with gone as (delete from public.kb_files f where f.note_id = n.id returning f.object_path)
  select array_agg(object_path) into objects from gone;
  perform public.kb_files_trash_put(objects, n.workspace_id, n.kb_id);
  perform set_config('quorum.kb_system', 'on', true);
  update public.notes x set deleted_at = now(), updated_at = now(), edited_by = auth.uid() where x.id = n.id;
  perform set_config('quorum.kb_system', '', true);
  return jsonb_build_object('ok', true, 'objects', coalesce(to_jsonb(objects), '[]'::jsonb));
end $$;

create or replace function public.kb_files_quota(ws public.ulid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce((select case when w.plan = 'free' then 0::bigint when w.plan = 'internal' then 107374182400::bigint else greatest(w.seats, 1)::bigint * 2147483648::bigint end
    from public.workspaces w where w.id = kb_files_quota.ws), 0);
$$;
-- what counts: finished files, and uploads begun in the last hour; but one file left out (kb_file_done counts its own
-- file by the size Storage reports)
create or replace function public.kb_files_used(ws public.ulid, but public.ulid default null) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(f.size), 0)::bigint from public.kb_files f
  where f.workspace_id = kb_files_used.ws and (f.uploaded or f.created_at > now() - interval '1 hour') and f.id is distinct from kb_files_used.but;
$$;
create or replace function public.kb_files_usage(workspace_id public.ulid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(kb_files_usage.workspace_id) then raise exception 'Pick a workspace first'; end if;
  return jsonb_build_object('used', public.kb_files_used(kb_files_usage.workspace_id), 'quota', public.kb_files_quota(kb_files_usage.workspace_id));
end $$;

create or replace function public.kb_file_row(f public.kb_files) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('id', f.id, 'kb_id', f.kb_id, 'note_id', f.note_id, 'name', f.name, 'mime', f.mime, 'size', f.size, 'object_path', f.object_path,
    'uploaded', f.uploaded, 'created_at', f.created_at, 'link', 'quorum://kb-file/' || f.id);
$$;

-- the object key's extension, from the checked type: plain ASCII whatever the file was called
create or replace function public.kb_file_ext(mime text) returns text
language sql immutable set search_path = public as $$
  select case kb_file_ext.mime when 'image/png' then 'png' when 'image/jpeg' then 'jpg' when 'image/gif' then 'gif' when 'image/webp' then 'webp'
    when 'image/heic' then 'heic' when 'application/pdf' then 'pdf' else null end;
$$;

-- a file for a note the caller may write: checks the type, the 25 MB cap and the workspace quota, and makes the row the
-- upload is tied to. The object key is <workspace>/<kb>/<note>/<file id>.<ext>; the name people see stays in the row.
-- The app uploads to object_path, then calls kb_file_done
create or replace function public.kb_file_begin(note_id public.ulid, name text, mime text, size bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n public.notes := public.kb_hosted_note_target(kb_file_begin.note_id);
        nm text := btrim(regexp_replace(regexp_replace(coalesce(kb_file_begin.name, ''), '[[:cntrl:]]+', '', 'g'), '[\\/]+', ' ', 'g'));
        ext text := public.kb_file_ext(kb_file_begin.mime);
        f public.kb_files;
        id public.ulid := public.gen_ulid();
begin
  if nm = '' then raise exception 'The file needs a name'; end if;
  nm := btrim(left(nm, 200));
  if ext is null then raise exception 'Attach an image or a PDF'; end if;
  if coalesce(kb_file_begin.size, 0) < 1 then raise exception 'That file is empty'; end if;
  if kb_file_begin.size > 26214400 then raise exception 'A file can be up to 25 MB'; end if;
  if public.kb_files_used(n.workspace_id) + kb_file_begin.size > public.kb_files_quota(n.workspace_id) then
    raise exception 'This workspace has used its % GB of hosted file storage', round(public.kb_files_quota(n.workspace_id) / 1073741824.0);
  end if;
  insert into public.kb_files (id, workspace_id, kb_id, note_id, name, mime, size, object_path, created_by)
    values (id, n.workspace_id, n.kb_id, n.id, nm, kb_file_begin.mime, kb_file_begin.size, n.workspace_id || '/' || n.kb_id || '/' || n.id || '/' || id || '.' || ext, auth.uid())
    returning * into f;
  return public.kb_file_row(f);
end $$;

-- the upload landed: the row counts and readers see it. The size Storage reports is the one that counts: an object
-- larger than the size begun, or one the quota no longer holds, is refused. Its row goes and the answer is
-- { rejected: true, reason, object_path } for the app to remove the object
create or replace function public.kb_file_done(id public.ulid) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare f public.kb_files; sz bigint;
begin
  select * into f from public.kb_files x where x.id = kb_file_done.id and x.created_by = auth.uid() for update;
  if f.id is null then raise exception 'That file is no longer attached'; end if;
  select coalesce((o.metadata ->> 'size')::bigint, 0) into sz from storage.objects o where o.bucket_id = 'kb-files' and o.name = f.object_path;
  if not found then raise exception 'The upload did not finish. Attach the file again'; end if;
  if sz > f.size or public.kb_files_used(f.workspace_id, f.id) + greatest(sz, f.size) > public.kb_files_quota(f.workspace_id) then
    delete from public.kb_files x where x.id = f.id;
    perform public.kb_files_trash_put(array[f.object_path], f.workspace_id, f.kb_id);
    return jsonb_build_object('rejected', true, 'object_path', f.object_path,
      'reason', case when sz > f.size then 'The file is larger than it was when the upload began. Attach it again' else 'This workspace has used its hosted file storage' end);
  end if;
  update public.kb_files x set uploaded = true, size = greatest(sz, 1) where x.id = f.id returning * into f;
  return public.kb_file_row(f);
end $$;

-- takes a file off its note; the answer is the object for the app to remove from Storage
create or replace function public.kb_file_remove(id public.ulid) returns text
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare f public.kb_files;
begin
  select * into f from public.kb_files x where x.id = kb_file_remove.id;
  if f.id is null or not public.can_read_kb(f.kb_id) then raise exception 'That file is no longer attached'; end if;
  perform public.kb_hosted_write_check(f.kb_id);
  delete from public.kb_files x where x.id = f.id;
  perform public.kb_files_trash_put(array[f.object_path], f.workspace_id, f.kb_id);
  return f.object_path;
end $$;

-- the relay's sweep (service role): pending uploads older than max_age leave kb_files for the trash, and the trash is
-- listed oldest first for the relay to delete through the Storage API, then cleared with kb_files_trash_done
create or replace function public.kb_files_cleanup(max_age interval default interval '1 day', max_rows integer default 500) returns table (object_path text)
language plpgsql security definer set search_path = public as $$
begin
  perform public.kb_sync_service_only();
  with gone as (delete from public.kb_files f where not f.uploaded and f.created_at < now() - kb_files_cleanup.max_age returning f.object_path, f.workspace_id, f.kb_id)
  insert into public.kb_files_trash (object_path, workspace_id, kb_id) select g.object_path, g.workspace_id, g.kb_id from gone g on conflict do nothing;
  return query select t.object_path from public.kb_files_trash t order by t.created_at, t.object_path limit greatest(1, least(coalesce(kb_files_cleanup.max_rows, 500), 1000));
end $$;
create or replace function public.kb_files_trash_done(paths text[]) returns integer
language plpgsql security definer set search_path = public as $$
declare c integer;
begin
  perform public.kb_sync_service_only();
  delete from public.kb_files_trash t where t.object_path = any (coalesce(kb_files_trash_done.paths, '{}'::text[]));
  get diagnostics c = row_count;
  return c;
end $$;

-- Storage rules for kb-files. The KB is the second path segment. A reader of the KB reads an object its row names. An
-- upload must match a row the uploader began in the last hour on a KB they may write now. A delete is for an object
-- in the trash: by an editor or admin of its KB, or by a workspace owner or admin (the KB may be gone). An object is
-- deleted only after its row is gone, so a file still on a note cannot be pulled out from under it. No update
-- policy, so an object is never overwritten
create or replace function public.kb_file_kb(name text) returns public.ulid
language sql immutable set search_path = public as $$
  select case when split_part(name, '/', 2) ~ '^[0-9A-HJKMNP-TV-Z]{26}$' then split_part(name, '/', 2)::public.ulid else null end;
$$;
create or replace function public.kb_file_readable(name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.kb_files f where f.object_path = kb_file_readable.name and f.kb_id = public.kb_file_kb(kb_file_readable.name) and public.can_read_kb(f.kb_id));
$$;
create or replace function public.kb_file_uploadable(name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.kb_files f join public.knowledge_bases k on k.id = f.kb_id
    where f.object_path = kb_file_uploadable.name and f.kb_id = public.kb_file_kb(kb_file_uploadable.name) and not f.uploaded and f.created_by = auth.uid()
      and f.created_at > now() - interval '1 hour' and k.source ->> 'kind' = 'hosted' and public.can_edit_kb(k.id) and public.kb_plan_active(k.workspace_id));
$$;
create or replace function public.kb_file_deletable(name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.kb_files_trash t where t.object_path = kb_file_deletable.name and split_part(kb_file_deletable.name, '/', 1) = t.workspace_id::text
      and (public.is_admin(t.workspace_id) or (t.kb_id is not null and public.can_edit_kb(t.kb_id))));
$$;
create policy kb_files_objects_select on storage.objects for select to authenticated using (bucket_id = 'kb-files' and (public.kb_file_readable(name) or public.kb_file_deletable(name)));
create policy kb_files_objects_insert on storage.objects for insert to authenticated with check (bucket_id = 'kb-files' and public.kb_file_uploadable(name));
create policy kb_files_objects_delete on storage.objects for delete to authenticated using (bucket_id = 'kb-files' and public.kb_file_deletable(name));

-- grants --------------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array[
    'can_edit_kb(public.ulid)', 'kb_shape(public.ulid)', 'kb_set_access(public.ulid, jsonb)', 'kb_create_hosted(public.ulid, text, public.ulid)', 'kb_source_set(public.ulid, jsonb)',
    'kb_hosted_note_save(public.ulid, public.ulid, public.ulid, text, text, text)', 'kb_hosted_note_move(public.ulid, public.ulid)', 'kb_hosted_note_delete(public.ulid, text)',
    'kb_rename(public.ulid, text)', 'kb_folder_create(public.ulid, public.ulid, text, integer)', 'kb_folder_rename(public.ulid, text)', 'kb_folder_move(public.ulid, public.ulid, integer, boolean)',
    'kb_folder_delete(public.ulid)', 'kb_delete(public.ulid)', 'kb_files_usage(public.ulid)', 'kb_file_begin(public.ulid, text, text, bigint)', 'kb_file_done(public.ulid)',
    'kb_file_remove(public.ulid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  -- helpers the policies and functions above call; storage policies run as the caller, so those keep execute
  foreach f in array array['kb_file_readable(text)', 'kb_file_uploadable(text)', 'kb_file_deletable(text)', 'kb_file_kb(text)', 'kb_is_hosted(public.ulid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  -- the relay's sweep
  foreach f in array array['kb_files_cleanup(interval, integer)', 'kb_files_trash_done(text[])'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'kb_role_rank(text)', 'kb_plan_active(public.ulid)', 'can_edit_kb_as(public.ulid, uuid)', 'kb_hosted_write_check(public.ulid)', 'kb_arrange_check(public.ulid, text)',
    'kb_path_seg(text, text)', 'kb_hosted_path(public.ulid, public.ulid, text)', 'kb_hosted_free_path(public.ulid, public.ulid, public.ulid, public.ulid, text)',
    'kb_hosted_repath(public.ulid)', 'kb_hosted_title_taken(public.ulid, public.ulid, text, public.ulid)', 'kb_hosted_text(public.ulid, text, text)', 'kb_text_hash(text)',
    'kb_hosted_note_row(public.notes)', 'kb_files_quota(public.ulid)', 'kb_files_used(public.ulid, public.ulid)', 'kb_file_row(public.kb_files)', 'kb_file_ext(text)',
    'kb_files_trash_put(text[], public.ulid, public.ulid)', 'note_contribution_sync()', 'contribution_kb_sync()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
grant select on public.kb_files to authenticated;
