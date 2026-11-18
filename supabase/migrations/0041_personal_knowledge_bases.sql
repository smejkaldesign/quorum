-- applied-when: select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'knowledge_bases' and column_name = 'personal_user_id')
-- Personal knowledge bases (docs/specs/workspace-knowledge.md, "Team knowledge bases"; the app side is
-- app/ee/knowledgeBases.js). Any member of a workspace can make a knowledge base (KB) that only they read and manage,
-- and fill it the ways a workspace KB is filled: an import, Google Drive, or a GitHub repository the relay keeps in
-- sync (0032). Several people can each sync the same repository into their own personal KB.
--
-- 1. knowledge_bases.personal_user_id names the one person a personal KB belongs to; null is a workspace KB as before.
--    A personal KB is general, belongs to no team and is never the default KB. kb_create takes personal true to make
--    one: any member may, and its access list is the maker alone, as admin, with no workspace row.
-- 2. Who reads it. can_read_kb_as, can_admin_kb_as and can_edit_kb_as answer true for a personal KB only when the
--    person is its owner and still a member of the workspace. Workspace owners and admins read every workspace KB
--    without a row (0024), and that rule does not reach a personal KB: they cannot read it, list it, search it or see
--    its synced folders. Its access list cannot gain a row for anyone else, so it cannot be shared.
-- 3. Names stay unique among the workspace's KBs, and among one person's personal KBs, so two people can each have a
--    personal KB with the same name and no one learns a name from a refusal.
-- 4. The review queue never sees a personal KB's notes: a note in one has no contribution row (a contribution an
--    admin could read, or a pending one an admin could open, is deleted when the note joins), the same way hosted KB
--    notes stay out of it (0034).
-- 5. The owner deletes a personal KB; workspace owners and admins cannot. Deleting it soft deletes the notes its own
--    synced folders wrote and the notes imported from its source, so each Mac removes them; every other note the owner
--    placed in it goes back to being the owner's own note. A member who leaves the workspace takes their personal KBs with them the same
--    way, after 0032 ended their sync grants. Deleting an account (0039) no longer hands the notes of the person's
--    personal KBs to the workspace owner; they go with the account.

alter table public.knowledge_bases add column personal_user_id uuid references auth.users (id) on delete cascade;
alter table public.knowledge_bases add constraint knowledge_bases_personal_check
  check (personal_user_id is null or (team_id is null and not is_default and kind = 'general'));
create index knowledge_bases_personal on public.knowledge_bases (personal_user_id) where personal_user_id is not null;

drop index public.knowledge_bases_name;
create unique index knowledge_bases_name on public.knowledge_bases (workspace_id, lower(btrim(name))) where personal_user_id is null;
create unique index knowledge_bases_personal_name on public.knowledge_bases (workspace_id, personal_user_id, lower(btrim(name))) where personal_user_id is not null;

create or replace function public.kb_is_personal(kb_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.knowledge_bases k where k.id = kb_is_personal.kb_id and k.personal_user_id is not null);
$$;

-- whether a name is free for a new or renamed KB: among the workspace's KBs, or among the owner's personal KBs
create or replace function public.kb_name_taken(ws public.ulid, owner uuid, name text, except_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.knowledge_bases x
    where x.workspace_id = ws and x.personal_user_id is not distinct from owner and x.id is distinct from except_id and lower(btrim(x.name)) = lower(btrim(kb_name_taken.name)));
$$;

-- 0035's rules with personal KBs: the owner alone, while still a member
create or replace function public.can_read_kb_as(kb_id public.ulid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select uid is not null and exists (
    select 1 from public.knowledge_bases k
    join public.members m on m.workspace_id = k.workspace_id and m.user_id = uid and m.deleted_at is null
    where k.id = can_read_kb_as.kb_id and case when k.personal_user_id is not null then k.personal_user_id = uid else (
      m.role in ('owner', 'admin')
      or (k.team_id is not null and public.is_team_member_as(k.team_id, uid))
      or public.kb_access_applies(k.id, uid, null)) end);
$$;

create or replace function public.can_admin_kb_as(kb_id public.ulid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select uid is not null and exists (
    select 1 from public.knowledge_bases k
    join public.members m on m.workspace_id = k.workspace_id and m.user_id = uid and m.deleted_at is null
    where k.id = can_admin_kb_as.kb_id and case when k.personal_user_id is not null then k.personal_user_id = uid else (
      m.role in ('owner', 'admin')
      or (k.team_id is not null and public.is_team_lead_as(k.team_id, uid))
      or public.kb_access_applies(k.id, uid, array['admin'])) end);
$$;

create or replace function public.can_edit_kb_as(kb_id public.ulid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_admin_kb_as(can_edit_kb_as.kb_id, can_edit_kb_as.uid) or (uid is not null and exists (
    select 1 from public.knowledge_bases k
    join public.members m on m.workspace_id = k.workspace_id and m.user_id = uid and m.deleted_at is null
    where k.id = can_edit_kb_as.kb_id and k.personal_user_id is null and public.kb_access_applies(k.id, uid, array['editor'])));
$$;

-- a personal KB's access list holds its owner as admin and nobody else, whatever path writes it
create or replace function public.kb_access_personal_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.knowledge_bases k where k.id = new.kb_id and k.personal_user_id is not null
             and not (new.principal = 'user' and new.user_id = k.personal_user_id and new.role = 'admin')) then
    raise exception 'A personal knowledge base is only for the person who made it';
  end if;
  return new;
end $$;
create trigger kb_access_personal before insert or update on public.kb_access for each row execute function public.kb_access_personal_check();

-- a personal KB holds its owner's notes only: nobody, a workspace owner or admin included, puts another person's note in
-- one, and no hand-over gives one of its notes to someone else
create or replace function public.notes_personal_kb_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kb_id is not null and exists (select 1 from public.knowledge_bases k where k.id = new.kb_id and k.personal_user_id is not null and k.personal_user_id <> new.user_id) then
    raise exception 'Only your own notes can go in a personal knowledge base';
  end if;
  return new;
end $$;
create trigger notes_personal_kb_owner before insert or update of kb_id, user_id on public.notes for each row execute function public.notes_personal_kb_owner();

-- 0034's kb_shape with one key: personal, true for a personal KB (only its owner ever reads one)
create or replace function public.kb_shape(kb_id public.ulid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', k.id, 'workspace_id', k.workspace_id, 'name', k.name, 'kind', k.kind, 'team_id', k.team_id, 'is_default', k.is_default,
    'source', k.source, 'created_by', k.created_by, 'created_at', k.created_at, 'updated_at', k.updated_at,
    'personal', k.personal_user_id is not null,
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

-- 0035's kb_create with personal: any member makes a personal KB, readable and managed by them alone. A workspace or
-- team KB stays for owners and admins
drop function public.kb_create(public.ulid, text, text, public.ulid);
create function public.kb_create(workspace_id public.ulid, name text, kind text default 'general', team_id public.ulid default null, personal boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n text := btrim(coalesce(kb_create.name, '')); k public.ulid; mine boolean := coalesce(kb_create.personal, false);
begin
  if mine then
    if auth.uid() is null or not public.is_member(kb_create.workspace_id) then raise exception 'You are not a member of that workspace'; end if;
    if coalesce(kb_create.kind, 'general') <> 'general' then raise exception 'A personal knowledge base is a general one'; end if;
    if kb_create.team_id is not null then raise exception 'A personal knowledge base belongs to you, not a team'; end if;
  elsif not public.is_admin(kb_create.workspace_id) then raise exception 'Only owners and admins can create a knowledge base for the workspace';
  end if;
  if n = '' then raise exception 'A knowledge base needs a name'; end if;
  if char_length(n) > 120 then raise exception 'That name is too long'; end if;
  if coalesce(kb_create.kind, 'general') not in ('general', 'meetings') then raise exception 'A knowledge base is general or meetings'; end if;
  if kb_create.team_id is not null and not exists (select 1 from public.teams t where t.id = kb_create.team_id and t.workspace_id = kb_create.workspace_id) then
    raise exception 'That team is not in this workspace';
  end if;
  if kb_create.kind = 'meetings' and kb_create.team_id is null and exists (select 1 from public.knowledge_bases x where x.workspace_id = kb_create.workspace_id and x.kind = 'meetings' and x.team_id is null) then
    raise exception 'This workspace already has a meetings knowledge base';
  end if;
  if kb_create.kind = 'meetings' and kb_create.team_id is not null and exists (select 1 from public.knowledge_bases x where x.team_id = kb_create.team_id and x.kind = 'meetings') then
    raise exception 'That team already has a meetings knowledge base';
  end if;
  if public.kb_name_taken(kb_create.workspace_id, case when mine then auth.uid() end, n, null) then raise exception 'A knowledge base with that name already exists'; end if;
  insert into public.knowledge_bases (workspace_id, name, kind, team_id, created_by, personal_user_id)
    values (kb_create.workspace_id, n, coalesce(kb_create.kind, 'general'), kb_create.team_id, auth.uid(), case when mine then auth.uid() end) returning id into k;
  if mine then insert into public.kb_access (kb_id, principal, user_id, role, created_by) values (k, 'user', auth.uid(), 'admin', auth.uid());
  elsif kb_create.team_id is null then insert into public.kb_access (kb_id, principal, role, created_by) values (k, 'workspace', 'reader', auth.uid());
  else insert into public.kb_access (kb_id, principal, team_id, role, created_by) values (k, 'team', kb_create.team_id, 'reader', auth.uid());
  end if;
  return public.kb_shape(k);
end $$;

-- 0034's kb_rename with names checked among the KB's own kind (the workspace's KBs, or the owner's personal KBs)
create or replace function public.kb_rename(kb_id public.ulid, name text) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n text := btrim(coalesce(kb_rename.name, '')); ws public.ulid; owner uuid;
begin
  select k.workspace_id, k.personal_user_id into ws, owner from public.knowledge_bases k where k.id = kb_rename.kb_id;
  if ws is null or not public.can_read_kb(kb_rename.kb_id) then raise exception 'That knowledge base no longer exists'; end if;
  if not public.can_admin_kb(kb_rename.kb_id) then raise exception 'Only the knowledge base''s admins can rename it'; end if;
  if n = '' then raise exception 'A knowledge base needs a name'; end if;
  if char_length(n) > 120 then raise exception 'That name is too long'; end if;
  if public.kb_name_taken(ws, owner, n, kb_rename.kb_id) then raise exception 'A knowledge base with that name already exists'; end if;
  update public.knowledge_bases k set name = n where k.id = kb_rename.kb_id;
  perform public.kb_hosted_repath(kb_rename.kb_id);
  return public.kb_shape(kb_rename.kb_id);
end $$;

-- a personal KB goes. The notes Quorum copied into it are soft deleted so every copy goes, and their text is cleared so
-- no one who later holds the row reads it: the notes of its own synced folders, and the notes imported from its
-- source (the same repository and folder, or the same zip, as app/ee/kbImport.js matches them). Every other note the
-- owner placed in it stays theirs. The KB's delete takes its folders, access list and attachments, which ends their
-- grants (0032)
create or replace function public.kb_personal_drop(kb_id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
declare k public.knowledge_bases;
begin
  select * into k from public.knowledge_bases x where x.id = kb_personal_drop.kb_id and x.personal_user_id is not null;
  if k.id is null then return; end if;
  perform set_config('quorum.kb_system', 'on', true);
  update public.notes n set deleted_at = now(), updated_at = now(), body = ''
    where n.kb_id = k.id and n.deleted_at is null and n.user_id = k.personal_user_id and (
      (n.frontmatter ->> 'kb_attachment') in (select a.id::text from public.kb_attachments a where a.kb_id = k.id)
      or (not (n.frontmatter ? 'kb_attachment') and (
        (k.source ->> 'kind' = 'github' and starts_with(coalesce(n.frontmatter ->> 'kb_source', ''), (k.source ->> 'url') || '/blob/')
          and (k.source ->> 'subpath' is null or strpos(n.frontmatter ->> 'kb_source', '/' || (k.source ->> 'subpath') || '/') > 0))
        or (k.source ->> 'kind' = 'zip' and k.source ->> 'name' is not null and starts_with(coalesce(n.frontmatter ->> 'kb_source', ''), (k.source ->> 'name') || '.zip/')))));
  delete from public.knowledge_bases x where x.id = k.id;
  perform set_config('quorum.kb_system', '', true);
end $$;

-- 0034's kb_delete, with personal KBs: only the owner deletes one, and a KB the caller cannot read reads as gone
create or replace function public.kb_delete(kb_id public.ulid) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare ws public.ulid; hosted boolean; owner uuid; objects text[];
begin
  select k.workspace_id, coalesce(k.source ->> 'kind', '') = 'hosted', k.personal_user_id into ws, hosted, owner from public.knowledge_bases k where k.id = kb_delete.kb_id;
  if ws is null or not public.is_member(ws) or (owner is not null and owner is distinct from auth.uid()) then raise exception 'That knowledge base no longer exists'; end if;
  if owner is null and not public.is_admin(ws) then raise exception 'Only owners and admins can delete a knowledge base'; end if;
  objects := array(select f.object_path from public.kb_files f where f.kb_id = kb_delete.kb_id order by f.id);
  perform public.kb_files_trash_put(objects, ws, kb_delete.kb_id);
  if owner is not null then
    perform public.kb_personal_drop(kb_delete.kb_id);
    return jsonb_build_object('ok', true, 'objects', to_jsonb(objects));
  end if;
  if hosted then
    perform set_config('quorum.kb_system', 'on', true);
    update public.notes n set deleted_at = now(), updated_at = now() where n.kb_id = kb_delete.kb_id and n.deleted_at is null;
  end if;
  delete from public.knowledge_bases k where k.id = kb_delete.kb_id;
  perform set_config('quorum.kb_system', '', true);
  return jsonb_build_object('ok', true, 'objects', to_jsonb(objects));
end $$;

-- 0034's note_contribution_sync, split in two: the queue rule for one note (note_contribution_apply), and the trigger,
-- which keeps a hosted KB's notes and a personal KB's notes out of the queue
create or replace function public.note_contribution_apply(n public.notes) returns void
language plpgsql security definer set search_path = public as $$
declare pub boolean := coalesce(n.frontmatter ->> 'visibility', 'private') = 'public' and n.deleted_at is null;
        conf boolean := coalesce(n.frontmatter ->> 'confidential', '') <> '';
        ws_auto boolean;
        by_kb boolean;
begin
  if pub and not conf then
    select coalesce(w.auto_include, false) into ws_auto from public.workspaces w where w.id = n.workspace_id;
    by_kb := not coalesce(ws_auto, false) and n.kb_id is not null;
    insert into public.contributions (workspace_id, note_id, author_id, status, reviewed_at, source)
      values (n.workspace_id, n.id, n.user_id, case when ws_auto or by_kb then 'included' else 'pending' end, case when ws_auto or by_kb then now() else null end, case when by_kb then 'kb' else 'review' end)
    on conflict (note_id) do update set status = case when contributions.status in ('included', 'declined') then contributions.status when excluded.status = 'included' then 'included' else 'pending' end,
                                       reviewed_at = case when contributions.status in ('included', 'declined') then contributions.reviewed_at else excluded.reviewed_at end,
                                       source = case when contributions.status in ('included', 'declined') then contributions.source else excluded.source end
      where contributions.status = 'withdrawn' or contributions.status = 'pending';
  else
    update public.contributions c set status = 'withdrawn' where c.note_id = n.id and c.status <> 'withdrawn';
  end if;
end $$;

create or replace function public.note_contribution_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kb_id is not null and public.kb_is_hosted(new.kb_id) then return new; end if;
  if new.kb_id is not null and public.kb_is_personal(new.kb_id) then
    delete from public.contributions c where c.note_id = new.id;
    return new;
  end if;
  perform public.note_contribution_apply(new);
  return new;
end $$;

-- a note moved into a personal KB (kb_note_assign) loses its contribution, so no admin reads it through the queue; a
-- note its owner moves out to a workspace KB or to no KB is queued again the way any shared note is
create or replace function public.note_personal_kb_moved() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kb_id is not null and public.kb_is_personal(new.kb_id) then delete from public.contributions c where c.note_id = new.id;
  elsif old.kb_id is not null and public.kb_is_personal(old.kb_id) and not (new.kb_id is not null and public.kb_is_hosted(new.kb_id)) then perform public.note_contribution_apply(new);
  end if;
  return new;
end $$;
create trigger notes_personal_kb after update of kb_id on public.notes for each row
  when (new.kb_id is distinct from old.kb_id) execute function public.note_personal_kb_moved();

-- a member who leaves the workspace takes their personal KBs with them. A workspace or an account being deleted
-- removes them through the foreign keys instead
create or replace function public.member_left_end_personal_kbs() returns trigger
language plpgsql security definer set search_path = public as $$
declare u uuid := old.user_id; ws public.ulid := old.workspace_id; k public.ulid;
begin
  if not (tg_op = 'DELETE' or (old.deleted_at is null and new.deleted_at is not null)) then return null; end if;
  if not exists (select 1 from public.workspaces w where w.id = ws) or not exists (select 1 from auth.users x where x.id = u) then return null; end if;
  for k in select x.id from public.knowledge_bases x where x.workspace_id = ws and x.personal_user_id = u loop
    perform public.kb_personal_drop(k);
  end loop;
  return null;
end $$;
create trigger members_end_personal_kbs after update of deleted_at or delete on public.members for each row execute function public.member_left_end_personal_kbs();

-- 0039's delete_my_account, keeping the notes of the caller's personal KBs out of the hand-over to the workspace owner
create or replace function public.delete_my_account() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := auth.uid(); objects integer; kept integer;
begin
  if uid is null then raise exception 'You need to sign in first'; end if;
  if public.account_is_platform_owner(uid) then raise exception 'The account that runs Quorum cannot be deleted from the app'; end if;
  if exists (select 1 from public.account_owned_workspaces(uid)) then raise exception 'You own a workspace. Delete the organization first'; end if;

  create temp table if not exists pg_temp.account_handover (note_id public.ulid primary key, heir uuid not null) on commit drop;
  delete from pg_temp.account_handover;
  insert into pg_temp.account_handover (note_id, heir)
  select n.id, public.account_heir(n.workspace_id, uid) from public.notes n
  where n.user_id = uid
    and not (n.kb_id is not null and public.kb_is_personal(n.kb_id))
    and (n.kb_id is not null
         or coalesce(n.frontmatter ->> 'visibility', 'private') = 'public'
         or exists (select 1 from public.contributions c where c.note_id = n.id and c.status in ('pending', 'included')))
    and public.account_heir(n.workspace_id, uid) is not null;
  get diagnostics kept = row_count;

  perform set_config('quorum.kb_system', 'on', true);
  update public.notes n set user_id = h.heir from pg_temp.account_handover h where n.id = h.note_id;
  update public.links l set user_id = h.heir from pg_temp.account_handover h where l.from_note = h.note_id and l.user_id = uid;
  update public.attachments a set user_id = h.heir from pg_temp.account_handover h where a.note_id = h.note_id and a.user_id = uid;
  update public.contributions c set author_id = h.heir from pg_temp.account_handover h where c.note_id = h.note_id and c.author_id = uid;
  perform set_config('quorum.kb_system', '', true);

  insert into public.kb_files_trash (object_path, workspace_id, kb_id, bucket)
  select a.object_path, a.workspace_id, null, 'attachments' from public.attachments a where a.user_id = uid and a.bucket = 'attachments'
  on conflict (object_path) do nothing;
  get diagnostics objects = row_count;
  delete from auth.users u where u.id = uid;
  return jsonb_build_object('ok', true, 'kept', kept, 'objects', objects);
end $$;

do $$ declare f text; begin
  foreach f in array array['kb_create(public.ulid, text, text, public.ulid, boolean)', 'kb_rename(public.ulid, text)', 'kb_delete(public.ulid)', 'kb_shape(public.ulid)', 'delete_my_account()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'kb_is_personal(public.ulid)', 'kb_name_taken(public.ulid, uuid, text, public.ulid)', 'can_read_kb_as(public.ulid, uuid)', 'can_admin_kb_as(public.ulid, uuid)',
    'can_edit_kb_as(public.ulid, uuid)', 'kb_access_personal_check()', 'notes_personal_kb_owner()', 'kb_personal_drop(public.ulid)', 'note_contribution_apply(public.notes)', 'note_contribution_sync()', 'note_personal_kb_moved()',
    'member_left_end_personal_kbs()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
