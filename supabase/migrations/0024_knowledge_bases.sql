-- applied-when: select exists(select 1 from pg_tables where schemaname = 'public' and tablename = 'knowledge_bases')
-- Team knowledge bases (docs/specs/workspace-knowledge.md, "Team knowledge bases" and "Data model"). Each knowledge
-- base (KB) is a top-level folder in a workspace with its own admins and readers; folders inside it nest without limit.
-- A note joins a KB through kb_id and folder_id; a note without kb_id is a personal note and reads as before (0012,
-- 0013). Clients read the three tables under row level security and change them only through the RPCs below, which
-- check the caller themselves and raise a plain sentence on refusal.
--
-- Who reads a KB: every member when a 'workspace' principal is granted, chosen people through 'user' principals, and
-- workspace owners and admins always. 'team' principals are part of the schema for the teams sprint; until a teams
-- table exists the RPCs refuse them, so no grant is stored that reads as access but grants none.
-- Who manages a KB: workspace owners and admins, and anyone granted the admin role on it. Creating and deleting a KB
-- is for workspace owners and admins only.

create table public.knowledge_bases (
  id public.ulid primary key default public.gen_ulid(),
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  kind text not null default 'general' check (kind in ('general', 'meetings')),
  team_id public.ulid,
  -- the KB migrated from the workspace's 0020 team source (0025); one per workspace
  is_default boolean not null default false,
  -- a Mac-side source attached to the KB (a folder on each Mac or a git repository each Mac clones), as 0020 stored it
  source jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index knowledge_bases_workspace on public.knowledge_bases (workspace_id);
create unique index knowledge_bases_name on public.knowledge_bases (workspace_id, lower(btrim(name)));
create unique index knowledge_bases_default on public.knowledge_bases (workspace_id) where is_default;

create table public.kb_access (
  id public.ulid primary key default public.gen_ulid(),
  kb_id public.ulid not null references public.knowledge_bases (id) on delete cascade,
  principal text not null check (principal in ('workspace', 'team', 'user')),
  user_id uuid references auth.users (id) on delete cascade,
  team_id public.ulid,
  role text not null default 'reader' check (role in ('admin', 'reader')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((principal = 'workspace' and user_id is null and team_id is null)
      or (principal = 'user' and user_id is not null and team_id is null)
      or (principal = 'team' and team_id is not null and user_id is null))
);
create unique index kb_access_principal on public.kb_access (kb_id, principal, coalesce(user_id::text, team_id::text, ''));
create index kb_access_user on public.kb_access (user_id) where user_id is not null;

create table public.kb_folders (
  id public.ulid primary key default public.gen_ulid(),
  kb_id public.ulid not null references public.knowledge_bases (id) on delete cascade,
  parent_id public.ulid references public.kb_folders (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120 and name !~ '[/\\]'),
  position integer not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index kb_folders_tree on public.kb_folders (kb_id, parent_id, position);
create unique index kb_folders_name on public.kb_folders (kb_id, coalesce(parent_id::text, ''), lower(btrim(name)));

alter table public.notes
  add column kb_id public.ulid references public.knowledge_bases (id) on delete set null,
  add column folder_id public.ulid references public.kb_folders (id) on delete set null;
create index notes_kb on public.notes (kb_id, folder_id) where kb_id is not null;

do $$
declare t text;
begin
  foreach t in array array['knowledge_bases', 'kb_access', 'kb_folders'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', t || '_updated_at', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

create or replace function public.can_read_kb(kb_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.knowledge_bases k
    where k.id = can_read_kb.kb_id and public.is_member(k.workspace_id) and (
      public.is_admin(k.workspace_id)
      or exists (select 1 from public.kb_access a where a.kb_id = k.id and (a.principal = 'workspace' or (a.principal = 'user' and a.user_id = auth.uid())))
    )
  );
$$;

create or replace function public.can_admin_kb(kb_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.knowledge_bases k
    where k.id = can_admin_kb.kb_id and public.is_member(k.workspace_id) and (
      public.is_admin(k.workspace_id)
      or exists (select 1 from public.kb_access a where a.kb_id = k.id and a.role = 'admin' and (a.principal = 'workspace' or (a.principal = 'user' and a.user_id = auth.uid())))
    )
  );
$$;

-- reads: the KB rows and folders a person can read; access rows for the KB's admins, and a person's own grant
create policy knowledge_bases_select on public.knowledge_bases for select to authenticated using (public.can_read_kb(id));
create policy kb_folders_select on public.kb_folders for select to authenticated using (public.can_read_kb(kb_id));
create policy kb_access_select on public.kb_access for select to authenticated using (user_id = auth.uid() or public.can_admin_kb(kb_id));
-- writes go through the RPCs below; with no insert, update or delete policy the table API refuses them

-- a folder's parent sits in the same KB, and a move never puts a folder inside itself
create or replace function public.kb_folders_check() returns trigger
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  if new.parent_id is not null then
    if not exists (select 1 from public.kb_folders f where f.id = new.parent_id and f.kb_id = new.kb_id) then raise exception 'That folder is in another knowledge base'; end if;
    if tg_op = 'UPDATE' and exists (
      with recursive up as (
        select f.id, f.parent_id from public.kb_folders f where f.id = new.parent_id
        union all
        select f.id, f.parent_id from public.kb_folders f join up on f.id = up.parent_id
      ) select 1 from up where up.id = new.id
    ) then raise exception 'A folder cannot move inside itself'; end if;
  end if;
  return new;
end $$;
create trigger kb_folders_check before insert or update of parent_id, kb_id on public.kb_folders for each row execute function public.kb_folders_check();

-- a note's KB and folder: the folder belongs to the KB, the KB to the note's workspace. Putting a note into a KB takes
-- admin rights on that KB; taking it out takes admin rights on it or being the note's author. An author who marks a
-- KB note private (frontmatter visibility from public to private) takes it out of the KB, so the change keeps its
-- 0012 meaning. Session-less writes (migrations, the service role) and the cleanup after a KB or folder is deleted
-- skip the rights check.
create or replace function public.notes_kb_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare was_kb public.ulid := case when tg_op = 'UPDATE' then old.kb_id else null end;
        was_folder public.ulid := case when tg_op = 'UPDATE' then old.folder_id else null end;
        kb_ws public.ulid;
begin
  if tg_op = 'UPDATE' and new.kb_id is not null and new.kb_id is not distinct from old.kb_id
     and coalesce(old.frontmatter ->> 'visibility', '') = 'public' and coalesce(new.frontmatter ->> 'visibility', '') = 'private' then
    new.kb_id := null;
  end if;
  if new.kb_id is null then new.folder_id := null; end if;
  if new.kb_id is not distinct from was_kb and new.folder_id is not distinct from was_folder then return new; end if;
  if new.kb_id is not null then
    select k.workspace_id into kb_ws from public.knowledge_bases k where k.id = new.kb_id;
    -- the KB is gone: a delete is clearing its notes, and the foreign key settles the rest
    if kb_ws is null then return new; end if;
    if kb_ws <> new.workspace_id then raise exception 'That knowledge base is in another workspace'; end if;
    if new.folder_id is not null and not exists (select 1 from public.kb_folders f where f.id = new.folder_id and f.kb_id = new.kb_id) then raise exception 'That folder is not in this knowledge base'; end if;
    if auth.uid() is not null and not public.can_admin_kb(new.kb_id) then raise exception 'Only the knowledge base''s admins can add notes to it'; end if;
  end if;
  if auth.uid() is not null and was_kb is not null and new.kb_id is distinct from was_kb
     and exists (select 1 from public.knowledge_bases k where k.id = was_kb)
     and not (public.can_admin_kb(was_kb) or new.user_id = auth.uid()) then
    raise exception 'Only the knowledge base''s admins or the note''s author can take a note out of it';
  end if;
  return new;
end $$;
create trigger notes_kb_check before insert or update of kb_id, folder_id, frontmatter on public.notes for each row execute function public.notes_kb_check();

-- note reads: personal notes as 0012 and 0013 left them; a KB note for anyone who can read its KB. A note in a KB is
-- never readable through the workspace-wide "public and included" rule, so a restricted KB stays restricted
drop policy if exists notes_select on public.notes;
create policy notes_select on public.notes for select to authenticated using (
  user_id = auth.uid()
  or (kb_id is not null and public.can_read_kb(kb_id))
  or (kb_id is null and public.is_member(workspace_id) and coalesce(frontmatter ->> 'visibility', 'private') = 'public' and public.note_included(id))
  or (public.is_admin(workspace_id) and public.note_pending(id))
);

create or replace function public.note_readable(note_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.notes n where n.id = note_readable.note_id and n.deleted_at is null and (
      n.user_id = auth.uid()
      or (n.kb_id is not null and public.can_read_kb(n.kb_id))
      or (n.kb_id is null and public.is_member(n.workspace_id) and coalesce(n.frontmatter ->> 'visibility', 'private') = 'public' and public.note_included(n.id))
      or (public.is_admin(n.workspace_id) and public.note_pending(n.id))
    )
  );
$$;

-- a KB as the app reads it: the caller's role, its folders flat (the app builds the tree), and its access list for
-- the KB's admins with each person's email and name
create or replace function public.kb_shape(kb_id public.ulid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', k.id, 'workspace_id', k.workspace_id, 'name', k.name, 'kind', k.kind, 'team_id', k.team_id, 'is_default', k.is_default,
    'source', k.source, 'created_by', k.created_by, 'created_at', k.created_at, 'updated_at', k.updated_at,
    'role', case when public.can_admin_kb(k.id) then 'admin' else 'reader' end,
    'folders', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'parent_id', f.parent_id, 'name', f.name, 'position', f.position) order by f.position, lower(f.name))
                         from public.kb_folders f where f.kb_id = k.id), '[]'::jsonb),
    'access', case when public.can_admin_kb(k.id) then coalesce((
      select jsonb_agg(jsonb_build_object('principal', a.principal, 'user_id', a.user_id, 'team_id', a.team_id, 'role', a.role, 'email', p.email, 'name', p.name) order by a.principal desc, p.email)
      from public.kb_access a left join public.profiles p on p.user_id = a.user_id where a.kb_id = k.id), '[]'::jsonb) else null end
  )
  from public.knowledge_bases k where k.id = kb_shape.kb_id;
$$;

create or replace function public.kb_list(workspace_id public.ulid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.kb_shape(k.id) order by k.is_default desc, lower(k.name)), '[]'::jsonb)
  from public.knowledge_bases k where k.workspace_id = kb_list.workspace_id and public.can_read_kb(k.id);
$$;

-- the next position among a folder's siblings, so a new or moved folder lands last
create or replace function public.kb_next_position(kb_id public.ulid, parent_id public.ulid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(max(f.position) + 1, 0) from public.kb_folders f where f.kb_id = kb_next_position.kb_id and f.parent_id is not distinct from kb_next_position.parent_id;
$$;

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
  if exists (select 1 from public.knowledge_bases x where x.workspace_id = kb_create.workspace_id and lower(btrim(x.name)) = lower(n)) then raise exception 'A knowledge base with that name already exists'; end if;
  insert into public.knowledge_bases (workspace_id, name, kind, created_by) values (kb_create.workspace_id, n, coalesce(kb_create.kind, 'general'), auth.uid()) returning id into k;
  -- a new KB starts readable by the whole workspace; its admins narrow it with kb_set_access
  insert into public.kb_access (kb_id, principal, role, created_by) values (k, 'workspace', 'reader', auth.uid());
  return public.kb_shape(k);
end $$;

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
  return public.kb_shape(kb_rename.kb_id);
end $$;

-- deleting a KB deletes its folders and access rows; its notes stay with their authors as personal notes
create or replace function public.kb_delete(kb_id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare ws public.ulid;
begin
  select k.workspace_id into ws from public.knowledge_bases k where k.id = kb_delete.kb_id;
  if ws is null or not public.is_member(ws) then raise exception 'That knowledge base no longer exists'; end if;
  if not public.is_admin(ws) then raise exception 'Only owners and admins can delete a knowledge base'; end if;
  delete from public.knowledge_bases k where k.id = kb_delete.kb_id;
end $$;

create or replace function public.kb_folder_create(kb_id public.ulid, parent_id public.ulid, name text, "position" integer default null) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n text := btrim(coalesce(kb_folder_create.name, '')); f public.kb_folders;
begin
  if not public.can_admin_kb(kb_folder_create.kb_id) then raise exception 'Only the knowledge base''s admins can add folders'; end if;
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
  if not public.can_admin_kb(f.kb_id) then raise exception 'Only the knowledge base''s admins can rename folders'; end if;
  if n = '' then raise exception 'A folder needs a name'; end if;
  if char_length(n) > 120 or n ~ '[/\\]' then raise exception 'A folder name is up to 120 characters without slashes'; end if;
  if exists (select 1 from public.kb_folders x where x.kb_id = f.kb_id and x.parent_id is not distinct from f.parent_id and x.id <> f.id and lower(btrim(x.name)) = lower(n)) then raise exception 'A folder with that name is already there'; end if;
  update public.kb_folders x set name = n where x.id = f.id returning * into f;
  return jsonb_build_object('id', f.id, 'kb_id', f.kb_id, 'parent_id', f.parent_id, 'name', f.name, 'position', f.position);
end $$;

-- a move within the same KB: a new parent (null for the KB's top level) and a position among the new siblings
create or replace function public.kb_folder_move(folder_id public.ulid, parent_id public.ulid, "position" integer default null) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare f public.kb_folders;
begin
  select * into f from public.kb_folders x where x.id = kb_folder_move.folder_id;
  if f.id is null or not public.can_read_kb(f.kb_id) then raise exception 'That folder no longer exists'; end if;
  if not public.can_admin_kb(f.kb_id) then raise exception 'Only the knowledge base''s admins can move folders'; end if;
  if kb_folder_move.parent_id = f.id then raise exception 'A folder cannot move inside itself'; end if;
  if exists (select 1 from public.kb_folders x where x.kb_id = f.kb_id and x.parent_id is not distinct from kb_folder_move.parent_id and x.id <> f.id and lower(btrim(x.name)) = lower(btrim(f.name))) then raise exception 'A folder with that name is already there'; end if;
  update public.kb_folders x
    set parent_id = kb_folder_move.parent_id,
        position = coalesce(kb_folder_move."position", case when x.parent_id is not distinct from kb_folder_move.parent_id then x.position else public.kb_next_position(f.kb_id, kb_folder_move.parent_id) end)
    where x.id = f.id returning * into f;
  return jsonb_build_object('id', f.id, 'kb_id', f.kb_id, 'parent_id', f.parent_id, 'name', f.name, 'position', f.position);
end $$;

-- deleting a folder deletes the folders inside it; its notes move to the KB's top level
create or replace function public.kb_folder_delete(folder_id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare f public.kb_folders;
begin
  select * into f from public.kb_folders x where x.id = kb_folder_delete.folder_id;
  if f.id is null or not public.can_read_kb(f.kb_id) then raise exception 'That folder no longer exists'; end if;
  if not public.can_admin_kb(f.kb_id) then raise exception 'Only the knowledge base''s admins can delete folders'; end if;
  delete from public.kb_folders x where x.id = f.id;
end $$;

-- the whole access list at once: [{ "principal": "workspace" | "user" | "team", "user_id": uuid, "team_id": ulid,
-- "role": "admin" | "reader" }]. People must be members of the workspace. The KB's notes are touched so the pulls of
-- people who just gained access fetch them (pull sync reads updated_at)
create or replace function public.kb_set_access(kb_id public.ulid, access jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare ws public.ulid; e jsonb; p text; r text; u uuid;
begin
  select k.workspace_id into ws from public.knowledge_bases k where k.id = kb_set_access.kb_id;
  if ws is null or not public.can_read_kb(kb_set_access.kb_id) then raise exception 'That knowledge base no longer exists'; end if;
  if not public.can_admin_kb(kb_set_access.kb_id) then raise exception 'Only the knowledge base''s admins can change who reads it'; end if;
  if jsonb_typeof(coalesce(kb_set_access.access, '[]'::jsonb)) <> 'array' then raise exception 'Access is a list of readers and admins'; end if;
  delete from public.kb_access a where a.kb_id = kb_set_access.kb_id;
  for e in select * from jsonb_array_elements(coalesce(kb_set_access.access, '[]'::jsonb)) loop
    p := coalesce(e ->> 'principal', '');
    r := coalesce(e ->> 'role', 'reader');
    if r not in ('admin', 'reader') then raise exception 'A role is admin or reader'; end if;
    if p = 'team' then raise exception 'Teams are not available yet'; end if;
    if p = 'workspace' then
      insert into public.kb_access (kb_id, principal, role, created_by) values (kb_set_access.kb_id, 'workspace', r, auth.uid())
        on conflict (kb_id, principal, coalesce(user_id::text, team_id::text, '')) do update set role = case when excluded.role = 'admin' then 'admin' else public.kb_access.role end;
    elsif p = 'user' then
      begin u := (e ->> 'user_id')::uuid; exception when others then raise exception 'That person is not a member of this workspace'; end;
      if u is null or not exists (select 1 from public.members m where m.workspace_id = ws and m.user_id = u and m.deleted_at is null) then raise exception 'That person is not a member of this workspace'; end if;
      insert into public.kb_access (kb_id, principal, user_id, role, created_by) values (kb_set_access.kb_id, 'user', u, r, auth.uid())
        on conflict (kb_id, principal, coalesce(user_id::text, team_id::text, '')) do update set role = case when excluded.role = 'admin' then 'admin' else public.kb_access.role end;
    else raise exception 'A reader is the workspace, a team or a person';
    end if;
  end loop;
  update public.notes n set updated_at = now() where n.kb_id = kb_set_access.kb_id and n.deleted_at is null;
  return public.kb_shape(kb_set_access.kb_id) -> 'access';
end $$;

-- puts a note into a KB folder (folder_id null for the KB's top level), or takes it out with kb_id null. Adding takes
-- admin rights on the KB and a note the caller can already read; the notes_kb_check trigger repeats the rights check
create or replace function public.kb_note_assign(note_id public.ulid, kb_id public.ulid, folder_id public.ulid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n public.notes;
begin
  select * into n from public.notes x where x.id = kb_note_assign.note_id and x.deleted_at is null;
  if n.id is null or not public.note_readable(n.id) then raise exception 'That note no longer exists'; end if;
  if kb_note_assign.kb_id is not null and not public.can_admin_kb(kb_note_assign.kb_id) then raise exception 'Only the knowledge base''s admins can add notes to it'; end if;
  if kb_note_assign.kb_id is null and kb_note_assign.folder_id is not null then raise exception 'Pick a knowledge base for that folder'; end if;
  update public.notes x set kb_id = kb_note_assign.kb_id, folder_id = kb_note_assign.folder_id where x.id = n.id returning * into n;
  return jsonb_build_object('note_id', n.id, 'kb_id', n.kb_id, 'folder_id', n.folder_id, 'updated_at', n.updated_at);
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'can_read_kb(public.ulid)', 'can_admin_kb(public.ulid)', 'kb_shape(public.ulid)', 'kb_list(public.ulid)', 'kb_next_position(public.ulid, public.ulid)',
    'kb_create(public.ulid, text, text, public.ulid)', 'kb_rename(public.ulid, text)', 'kb_delete(public.ulid)',
    'kb_folder_create(public.ulid, public.ulid, text, integer)', 'kb_folder_rename(public.ulid, text)', 'kb_folder_move(public.ulid, public.ulid, integer)', 'kb_folder_delete(public.ulid)',
    'kb_set_access(public.ulid, jsonb)', 'kb_note_assign(public.ulid, public.ulid, public.ulid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
revoke all on function public.kb_folders_check() from public, anon, authenticated;
revoke all on function public.notes_kb_check() from public, anon, authenticated;
