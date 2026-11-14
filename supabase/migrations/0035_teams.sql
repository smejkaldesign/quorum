-- applied-when: select exists(select 1 from pg_tables where schemaname = 'public' and tablename = 'teams')
-- Teams inside a workspace and cross-team knowledge base permissions (docs/specs/workspace-knowledge.md, "Access" and
-- Decisions 4). A workspace with no teams reads and routes exactly as 0024 to 0034 left it. Needs 0034 (hosted KB
-- storage and the editor role): kb_set_access and can_edit_kb_as below start from its bodies.
--
-- 1. teams and team_members. A member can be in many teams, as lead or member. Workspace members read every team and
--    membership in their workspace; owners, admins and the team's leads change them through the RPCs below. Leaving
--    the workspace (members.deleted_at set, or the row deleted) removes the person's team memberships.
-- 2. kb_access principal 'team' is accepted. One helper, kb_access_applies(kb, uid, roles), says whether an access row
--    covers a person: the workspace row, their own user row, or a team row for a team they are in. can_read_kb,
--    can_admin_kb_as and can_edit_kb_as (0034) all use it, so a team grant carries every role: admin, editor, reader.
-- 3. knowledge_bases.team_id is a team-owned KB. Its own team always reads it, and the team's leads are its admins,
--    alongside the workspace owners and admins. A new team-owned KB starts readable by its team only.
-- 4. One meetings KB per team plus the workspace one. Each team gets a meetings KB when it is made. A member's meeting
--    notes go to the meetings KB of their meeting team: their only team, the team they chose when they are in several,
--    or the team they joined first when they have not chosen; a member in no team uses the workspace meetings KB as
--    before. The per-source share choice (0029, app side) still decides whether a note is shared at all.
-- 5. Deleting a team keeps its knowledge: its KBs become workspace KBs (a meetings KB becomes general), its team rows
--    leave every access list, and nobody gains read access they did not have.

create table public.teams (
  id public.ulid primary key default public.gen_ulid(),
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create unique index teams_name on public.teams (workspace_id, lower(btrim(name)));

create table public.team_members (
  team_id public.ulid not null,
  workspace_id public.ulid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('lead', 'member')),
  -- the team whose meetings KB receives this person's meeting notes, when they are in several
  meetings_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (team_id, user_id),
  foreign key (team_id, workspace_id) references public.teams (id, workspace_id) on delete cascade
);
create index team_members_user on public.team_members (user_id, workspace_id);
create unique index team_members_meetings_default on public.team_members (workspace_id, user_id) where meetings_default;

create trigger teams_updated_at before update on public.teams for each row execute function public.set_updated_at();
create trigger team_members_updated_at before update on public.team_members for each row execute function public.set_updated_at();
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
create policy teams_select on public.teams for select to authenticated using (public.is_member(workspace_id));
create policy team_members_select on public.team_members for select to authenticated using (public.is_member(workspace_id));
-- writes go through the RPCs below; with no insert, update or delete policy the table API refuses them

-- a KB's team is a team of the KB's workspace; deleting the team is handled by teams_before_delete below
alter table public.knowledge_bases add constraint knowledge_bases_team foreign key (team_id, workspace_id) references public.teams (id, workspace_id);
create index knowledge_bases_team on public.knowledge_bases (team_id) where team_id is not null;
alter table public.kb_access add constraint kb_access_team foreign key (team_id) references public.teams (id) on delete cascade;
create index kb_access_team on public.kb_access (team_id) where team_id is not null;

-- one meetings KB for the workspace (team_id null) and one per team. 0029 held one per workspace; a database that
-- already holds two for one workspace keeps them and goes without the workspace index, as 0029 did
drop index if exists public.knowledge_bases_meetings;
do $$
begin
  if exists (select 1 from public.knowledge_bases k where k.kind = 'meetings' and k.team_id is null group by k.workspace_id having count(*) > 1) then
    raise notice 'a workspace has more than one meetings knowledge base; knowledge_bases_meetings is not created';
  else
    create unique index knowledge_bases_meetings on public.knowledge_bases (workspace_id) where kind = 'meetings' and team_id is null;
  end if;
end $$;
create unique index knowledge_bases_team_meetings on public.knowledge_bases (team_id) where kind = 'meetings' and team_id is not null;

-- membership checks for a given person; a person who left the workspace is in none of its teams
create or replace function public.is_team_member_as(team_id public.ulid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select uid is not null and exists (
    select 1 from public.team_members t join public.members m on m.workspace_id = t.workspace_id and m.user_id = t.user_id and m.deleted_at is null
    where t.team_id = is_team_member_as.team_id and t.user_id = uid);
$$;
create or replace function public.is_team_lead_as(team_id public.ulid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select uid is not null and exists (
    select 1 from public.team_members t join public.members m on m.workspace_id = t.workspace_id and m.user_id = t.user_id and m.deleted_at is null
    where t.team_id = is_team_lead_as.team_id and t.user_id = uid and t.role = 'lead');
$$;
-- who manages a team: the workspace's owners and admins and the team's leads
create or replace function public.can_manage_team(team_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.teams t where t.id = can_manage_team.team_id and (public.is_admin(t.workspace_id) or public.is_team_lead_as(t.id, auth.uid())));
$$;

-- whether an access row on the KB covers the person, for any of the given roles (null: any role). Every rights check
-- below goes through this, so 0034's editor role matches teams the same way as admin and reader
create or replace function public.kb_access_applies(kb_id public.ulid, uid uuid, roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select uid is not null and exists (
    select 1 from public.kb_access a
    where a.kb_id = kb_access_applies.kb_id and (roles is null or a.role = any (roles)) and (
      a.principal = 'workspace'
      or (a.principal = 'user' and a.user_id = uid)
      or (a.principal = 'team' and public.is_team_member_as(a.team_id, uid))));
$$;

create or replace function public.can_read_kb_as(kb_id public.ulid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select uid is not null and exists (
    select 1 from public.knowledge_bases k
    join public.members m on m.workspace_id = k.workspace_id and m.user_id = uid and m.deleted_at is null
    where k.id = can_read_kb_as.kb_id and (
      m.role in ('owner', 'admin')
      or (k.team_id is not null and public.is_team_member_as(k.team_id, uid))
      or public.kb_access_applies(k.id, uid, null)));
$$;
create or replace function public.can_read_kb(kb_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_read_kb_as(can_read_kb.kb_id, auth.uid());
$$;

-- 0032's can_admin_kb_as with team grants and the owning team's leads; can_admin_kb (0032) calls it unchanged
create or replace function public.can_admin_kb_as(kb_id public.ulid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select uid is not null and exists (
    select 1 from public.knowledge_bases k
    join public.members m on m.workspace_id = k.workspace_id and m.user_id = uid and m.deleted_at is null
    where k.id = can_admin_kb_as.kb_id and (
      m.role in ('owner', 'admin')
      or (k.team_id is not null and public.is_team_lead_as(k.team_id, uid))
      or public.kb_access_applies(k.id, uid, array['admin'])));
$$;

-- 0034's can_edit_kb_as with team grants: a KB admin, or an editor grant that covers the person; can_edit_kb (0034)
-- calls it unchanged
create or replace function public.can_edit_kb_as(kb_id public.ulid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_admin_kb_as(can_edit_kb_as.kb_id, can_edit_kb_as.uid) or (uid is not null and exists (
    select 1 from public.knowledge_bases k
    join public.members m on m.workspace_id = k.workspace_id and m.user_id = uid and m.deleted_at is null
    where k.id = can_edit_kb_as.kb_id and public.kb_access_applies(k.id, uid, array['editor'])));
$$;

-- touches the notes of every KB a team reads, so a person who just joined it fetches them on their next pull (pull
-- sync reads updated_at), as kb_set_access does for a new reader. It is a system write, as in 0034's kb_set_access,
-- so 0034's guard on hosted KB notes lets it through
create or replace function public.team_touch_kbs(team_id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('quorum.kb_system', 'on', true);
  update public.notes n set updated_at = now()
  where n.deleted_at is null and n.kb_id in (
    select k.id from public.knowledge_bases k where k.team_id = team_touch_kbs.team_id
    union select a.kb_id from public.kb_access a where a.principal = 'team' and a.team_id = team_touch_kbs.team_id);
  perform set_config('quorum.kb_system', '', true);
end $$;

-- the meetings KB of the person's meeting team: their only team, the one they chose among several, or the team they
-- joined first. Null when they are in no team, so the workspace meetings KB is used
create or replace function public.kb_meetings_team(ws public.ulid, uid uuid) returns public.ulid
language sql stable security definer set search_path = public as $$
  select t.team_id from public.team_members t
  join public.members m on m.workspace_id = t.workspace_id and m.user_id = t.user_id and m.deleted_at is null
  where t.workspace_id = kb_meetings_team.ws and t.user_id = uid
  order by t.meetings_default desc, t.created_at, t.team_id limit 1;
$$;

-- a team's meetings KB, made on first use and readable by that team only; called by team_create, the meetings routing
-- and nothing a client can reach
create or replace function public.kb_ensure_team_meetings(team_id public.ulid) returns public.ulid
language plpgsql security definer set search_path = public as $$
declare t public.teams; k public.ulid; n text; who uuid;
begin
  select * into t from public.teams x where x.id = kb_ensure_team_meetings.team_id;
  if t.id is null then return null; end if;
  select x.id into k from public.knowledge_bases x where x.team_id = t.id and x.kind = 'meetings';
  if k is not null then return k; end if;
  who := coalesce(t.created_by, (select w.user_id from public.workspaces w where w.id = t.workspace_id));
  foreach n in array array[t.name || ' meetings', t.name || ' meeting notes', t.name || ' meetings ' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS')] loop
    exit when not exists (select 1 from public.knowledge_bases x where x.workspace_id = t.workspace_id and lower(btrim(x.name)) = lower(btrim(n)));
  end loop;
  begin
    insert into public.knowledge_bases (workspace_id, name, kind, team_id, created_by) values (t.workspace_id, left(n, 120), 'meetings', t.id, who) returning id into k;
  exception when unique_violation then
    select x.id into k from public.knowledge_bases x where x.team_id = t.id and x.kind = 'meetings';
    return k;
  end;
  insert into public.kb_access (kb_id, principal, team_id, role, created_by) values (k, 'team', t.id, 'reader', who);
  return k;
end $$;

-- 0029's kb_meetings_of: the workspace's own meetings KB, the oldest when there are two; team meetings KBs are not it
create or replace function public.kb_meetings_of(ws public.ulid) returns public.ulid
language sql stable security definer set search_path = public as $$
  select k.id from public.knowledge_bases k where k.workspace_id = kb_meetings_of.ws and k.kind = 'meetings' and k.team_id is null order by k.created_at, k.id limit 1;
$$;

-- the meetings KB a member's notes go to: their meeting team's, else the workspace's
create or replace function public.kb_meetings_target(ws public.ulid, uid uuid) returns public.ulid
language plpgsql security definer set search_path = public as $$
declare t public.ulid := public.kb_meetings_team(ws, uid);
begin
  if t is not null then return public.kb_ensure_team_meetings(t); end if;
  return public.kb_meetings_of(ws);
end $$;

-- 0029's kb_meetings_folder, routed by team: { kb_id, folder_id, month, team_id }, or null when there is no meetings
-- KB for the caller or they cannot read it
create or replace function public.kb_meetings_folder(workspace_id public.ulid, month text) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare m text := btrim(coalesce(kb_meetings_folder.month, '')); k public.ulid; f public.ulid; tid public.ulid;
begin
  if not public.is_member(kb_meetings_folder.workspace_id) then raise exception 'That workspace is not one of yours'; end if;
  if m !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'A month folder is named like 2026-11'; end if;
  k := public.kb_meetings_target(kb_meetings_folder.workspace_id, auth.uid());
  if k is null or not public.can_read_kb(k) then return null; end if;
  select x.team_id into tid from public.knowledge_bases x where x.id = k;
  select x.id into f from public.kb_folders x where x.kb_id = k and x.parent_id is null and lower(btrim(x.name)) = m;
  if f is null then
    begin
      insert into public.kb_folders (kb_id, parent_id, name, position, created_by) values (k, null, m, public.kb_next_position(k, null), auth.uid()) returning id into f;
    exception when unique_violation then
      select x.id into f from public.kb_folders x where x.kb_id = k and x.parent_id is null and lower(btrim(x.name)) = m;
    end;
  end if;
  return jsonb_build_object('kb_id', k, 'folder_id', f, 'month', m, 'team_id', tid);
end $$;

-- 0029's kb_meetings_info with the team: { kb_id, name, team_id, teams: [{ id, name, meetings_default }] } for the
-- caller's meeting KB, so Settings > Meetings can offer the default team. Null when the caller reads no meetings KB.
-- It does not make a team meetings KB; kb_meetings_folder does that when the first note arrives
create or replace function public.kb_meetings_info(workspace_id public.ulid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare tid public.ulid; k public.knowledge_bases; mine jsonb;
begin
  if not public.is_member(kb_meetings_info.workspace_id) then return null; end if;
  tid := public.kb_meetings_team(kb_meetings_info.workspace_id, auth.uid());
  if tid is not null then select * into k from public.knowledge_bases x where x.team_id = tid and x.kind = 'meetings';
  else select * into k from public.knowledge_bases x where x.id = public.kb_meetings_of(kb_meetings_info.workspace_id);
  end if;
  if k.id is null and tid is null then return null; end if;
  if k.id is not null and not public.can_read_kb(k.id) then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'meetings_default', tm.meetings_default) order by tm.created_at, t.id), '[]'::jsonb) into mine
  from public.team_members tm join public.teams t on t.id = tm.team_id
  where tm.workspace_id = kb_meetings_info.workspace_id and tm.user_id = auth.uid();
  return jsonb_build_object('kb_id', k.id, 'name', coalesce(k.name, (select t.name || ' meetings' from public.teams t where t.id = tid)), 'team_id', tid, 'teams', mine);
end $$;

-- 0029's kb_meetings_open: a team's meetings KB takes its own members' notes only, so a team granted read cannot
-- place notes in another team's meetings
create or replace function public.kb_meetings_open(kb_id public.ulid, folder_id public.ulid, author uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select kb_meetings_open.author = auth.uid()
    and exists (select 1 from public.knowledge_bases k where k.id = kb_meetings_open.kb_id and k.kind = 'meetings'
                and (k.team_id is null or public.is_team_member_as(k.team_id, kb_meetings_open.author)))
    and public.can_read_kb(kb_meetings_open.kb_id)
    and (kb_meetings_open.folder_id is null or exists (
      select 1 from public.kb_folders f where f.id = kb_meetings_open.folder_id and f.kb_id = kb_meetings_open.kb_id and f.parent_id is null and f.name ~ '^\d{4}-(0[1-9]|1[0-2])$'));
$$;

-- 0029's kb_create with team-owned KBs: the team is one of the workspace's, a team KB starts readable by that team
-- only, and there is one meetings KB per team and one for the workspace
create or replace function public.kb_create(workspace_id public.ulid, name text, kind text default 'general', team_id public.ulid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n text := btrim(coalesce(kb_create.name, '')); k public.ulid;
begin
  if not public.is_admin(kb_create.workspace_id) then raise exception 'Only owners and admins can create a knowledge base'; end if;
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
  if exists (select 1 from public.knowledge_bases x where x.workspace_id = kb_create.workspace_id and lower(btrim(x.name)) = lower(n)) then raise exception 'A knowledge base with that name already exists'; end if;
  insert into public.knowledge_bases (workspace_id, name, kind, team_id, created_by) values (kb_create.workspace_id, n, coalesce(kb_create.kind, 'general'), kb_create.team_id, auth.uid()) returning id into k;
  -- a workspace KB starts readable by the whole workspace and a team KB by its team; admins narrow or widen it with kb_set_access
  if kb_create.team_id is null then insert into public.kb_access (kb_id, principal, role, created_by) values (k, 'workspace', 'reader', auth.uid());
  else insert into public.kb_access (kb_id, principal, team_id, role, created_by) values (k, 'team', kb_create.team_id, 'reader', auth.uid());
  end if;
  return public.kb_shape(k);
end $$;

-- 0034's kb_set_access with team readers: a team must be one of the KB's workspace, and a team-owned KB always keeps
-- its own team on the list. The KB's admins (workspace owners and admins, the owning team's leads, and admin grants)
-- change it; a reader cannot. As in 0034, editors are for hosted KBs, a principal named twice keeps its highest role,
-- and the touch of the KB's notes runs as a system write
create or replace function public.kb_set_access(kb_id public.ulid, access jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare ws public.ulid; owner_team public.ulid; e jsonb; p text; r text; u uuid; t public.ulid; before text[]; hosted boolean;
begin
  select k.workspace_id, k.team_id, coalesce(k.source ->> 'kind', '') = 'hosted' into ws, owner_team, hosted from public.knowledge_bases k where k.id = kb_set_access.kb_id;
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
    if p = 'workspace' then
      insert into public.kb_access (kb_id, principal, role, created_by) values (kb_set_access.kb_id, 'workspace', r, auth.uid())
        on conflict (kb_id, principal, coalesce(user_id::text, team_id::text, '')) do update set role = case when public.kb_role_rank(excluded.role) > public.kb_role_rank(public.kb_access.role) then excluded.role else public.kb_access.role end;
    elsif p = 'user' then
      begin u := (e ->> 'user_id')::uuid; exception when others then raise exception 'That person is not a member of this workspace'; end;
      if u is null or not exists (select 1 from public.members m where m.workspace_id = ws and m.user_id = u and m.deleted_at is null) then raise exception 'That person is not a member of this workspace'; end if;
      insert into public.kb_access (kb_id, principal, user_id, role, created_by) values (kb_set_access.kb_id, 'user', u, r, auth.uid())
        on conflict (kb_id, principal, coalesce(user_id::text, team_id::text, '')) do update set role = case when public.kb_role_rank(excluded.role) > public.kb_role_rank(public.kb_access.role) then excluded.role else public.kb_access.role end;
    elsif p = 'team' then
      select x.id into t from public.teams x where x.id::text = btrim(coalesce(e ->> 'team_id', '')) and x.workspace_id = ws;
      if t is null then raise exception 'That team is not in this workspace'; end if;
      insert into public.kb_access (kb_id, principal, team_id, role, created_by) values (kb_set_access.kb_id, 'team', t, r, auth.uid())
        on conflict (kb_id, principal, coalesce(user_id::text, team_id::text, '')) do update set role = case when public.kb_role_rank(excluded.role) > public.kb_role_rank(public.kb_access.role) then excluded.role else public.kb_access.role end;
    else raise exception 'A reader is the workspace, a team or a person';
    end if;
  end loop;
  if owner_team is not null then
    insert into public.kb_access (kb_id, principal, team_id, role, created_by) values (kb_set_access.kb_id, 'team', owner_team, 'reader', auth.uid())
      on conflict (kb_id, principal, coalesce(user_id::text, team_id::text, '')) do nothing;
  end if;
  if exists (select 1 from public.kb_access a where a.kb_id = kb_set_access.kb_id and not (a.principal || ':' || coalesce(a.user_id::text, a.team_id::text, '')) = any (before)) then
    perform set_config('quorum.kb_system', 'on', true);
    update public.notes n set updated_at = now() where n.kb_id = kb_set_access.kb_id and n.deleted_at is null;
    perform set_config('quorum.kb_system', '', true);
  end if;
  return public.kb_shape(kb_set_access.kb_id) -> 'access';
end $$;

-- a team as the app reads it: its members with email, name and role, the caller's role in it, and whether the caller
-- may manage it
create or replace function public.team_shape(team_id public.ulid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', t.id, 'workspace_id', t.workspace_id, 'name', t.name, 'created_at', t.created_at,
    'my_role', (select tm.role from public.team_members tm where tm.team_id = t.id and tm.user_id = auth.uid()),
    'can_manage', public.can_manage_team(t.id),
    'meetings_kb_id', (select k.id from public.knowledge_bases k where k.team_id = t.id and k.kind = 'meetings'),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', tm.user_id, 'role', tm.role, 'email', p.email, 'name', p.name) order by tm.role, lower(coalesce(p.name, p.email, '')))
      from public.team_members tm
      join public.members m on m.workspace_id = tm.workspace_id and m.user_id = tm.user_id and m.deleted_at is null
      left join public.profiles p on p.user_id = tm.user_id
      where tm.team_id = t.id), '[]'::jsonb))
  from public.teams t where t.id = team_shape.team_id and public.is_member(t.workspace_id);
$$;

create or replace function public.team_list(workspace_id public.ulid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.team_shape(t.id) order by lower(t.name)), '[]'::jsonb)
  from public.teams t where t.workspace_id = team_list.workspace_id and public.is_member(t.workspace_id);
$$;

create or replace function public.team_name_check(ws public.ulid, name text, except_id public.ulid) returns text
language plpgsql stable security definer set search_path = public as $$
declare n text := btrim(coalesce(name, ''));
begin
  if n = '' then raise exception 'A team needs a name'; end if;
  if char_length(n) > 80 then raise exception 'That name is too long'; end if;
  if exists (select 1 from public.teams t where t.workspace_id = ws and t.id is distinct from except_id and lower(btrim(t.name)) = lower(n)) then raise exception 'A team with that name already exists'; end if;
  return n;
end $$;

-- a new team, empty, with its meetings KB. Owners and admins only, with the team switch (0019) on
create or replace function public.team_create(workspace_id public.ulid, name text) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n text; t public.ulid;
begin
  if not public.is_admin(team_create.workspace_id) then raise exception 'Only owners and admins can create a team'; end if;
  if not exists (select 1 from public.workspaces w where w.id = team_create.workspace_id and w.team_enabled and w.deleted_at is null) then raise exception 'Turn on the team for this workspace first'; end if;
  n := public.team_name_check(team_create.workspace_id, team_create.name, null);
  insert into public.teams (workspace_id, name, created_by) values (team_create.workspace_id, n, auth.uid()) returning id into t;
  perform public.kb_ensure_team_meetings(t);
  return public.team_shape(t);
end $$;

-- renaming a team renames its meetings KB too while that KB still has the name the team gave it
create or replace function public.team_rename(team_id public.ulid, name text) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare t public.teams; n text;
begin
  select * into t from public.teams x where x.id = team_rename.team_id;
  if t.id is null or not public.is_member(t.workspace_id) then raise exception 'That team no longer exists'; end if;
  if not public.can_manage_team(t.id) then raise exception 'Only owners, admins and the team''s leads can rename it'; end if;
  n := public.team_name_check(t.workspace_id, team_rename.name, t.id);
  update public.teams x set name = n where x.id = t.id;
  if not exists (select 1 from public.knowledge_bases x where x.workspace_id = t.workspace_id and lower(btrim(x.name)) = lower(n || ' meetings')) then
    update public.knowledge_bases k set name = left(n || ' meetings', 120) where k.team_id = t.id and k.kind = 'meetings' and lower(k.name) = lower(t.name || ' meetings');
  end if;
  return public.team_shape(t.id);
end $$;

create or replace function public.team_delete(team_id public.ulid) returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare t public.teams;
begin
  select * into t from public.teams x where x.id = team_delete.team_id;
  if t.id is null or not public.is_member(t.workspace_id) then raise exception 'That team no longer exists'; end if;
  if not public.is_admin(t.workspace_id) then raise exception 'Only owners and admins can delete a team'; end if;
  delete from public.teams x where x.id = t.id;
end $$;

-- before a team goes: its KBs become workspace KBs (a meetings KB becomes general, so the workspace's own meetings KB
-- stays the only one without a team) and its rows leave every access list by the foreign key
create or replace function public.teams_before_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.knowledge_bases k set team_id = null, kind = 'general' where k.team_id = old.id;
  return old;
end $$;
create trigger teams_before_delete before delete on public.teams for each row execute function public.teams_before_delete();

-- adds a workspace member to a team, or changes their role in it. The team's leads, owners and admins only
create or replace function public.team_member_set(team_id public.ulid, user_id uuid, role text default 'member') returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare t public.teams; r text := coalesce(team_member_set.role, 'member'); added boolean;
begin
  select * into t from public.teams x where x.id = team_member_set.team_id;
  if t.id is null or not public.is_member(t.workspace_id) then raise exception 'That team no longer exists'; end if;
  if not public.can_manage_team(t.id) then raise exception 'Only owners, admins and the team''s leads can change its members'; end if;
  if r not in ('lead', 'member') then raise exception 'A team role is lead or member'; end if;
  if team_member_set.user_id is null or not exists (select 1 from public.members m where m.workspace_id = t.workspace_id and m.user_id = team_member_set.user_id and m.deleted_at is null) then
    raise exception 'That person is not a member of this workspace';
  end if;
  added := not exists (select 1 from public.team_members x where x.team_id = t.id and x.user_id = team_member_set.user_id);
  insert into public.team_members (team_id, workspace_id, user_id, role) values (t.id, t.workspace_id, team_member_set.user_id, r)
    on conflict (team_id, user_id) do update set role = excluded.role;
  if added then perform public.team_touch_kbs(t.id); end if;
  return public.team_shape(t.id);
end $$;

-- takes a person out of a team. The team's leads, owners and admins, and the person themselves
create or replace function public.team_member_remove(team_id public.ulid, user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare t public.teams;
begin
  select * into t from public.teams x where x.id = team_member_remove.team_id;
  if t.id is null or not public.is_member(t.workspace_id) then raise exception 'That team no longer exists'; end if;
  if team_member_remove.user_id is distinct from auth.uid() and not public.can_manage_team(t.id) then raise exception 'Only owners, admins and the team''s leads can change its members'; end if;
  delete from public.team_members x where x.team_id = t.id and x.user_id = team_member_remove.user_id;
  return public.team_shape(t.id);
end $$;

-- the caller's meeting team when they are in several; null clears the choice (the team joined first is used)
create or replace function public.team_meetings_default_set(workspace_id public.ulid, team_id public.ulid) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_member(team_meetings_default_set.workspace_id) then raise exception 'That workspace is not one of yours'; end if;
  if team_meetings_default_set.team_id is not null and not exists (
    select 1 from public.team_members x where x.team_id = team_meetings_default_set.team_id and x.user_id = auth.uid() and x.workspace_id = team_meetings_default_set.workspace_id) then
    raise exception 'You are not in that team';
  end if;
  update public.team_members x set meetings_default = false where x.workspace_id = team_meetings_default_set.workspace_id and x.user_id = auth.uid() and x.meetings_default;
  if team_meetings_default_set.team_id is not null then
    update public.team_members x set meetings_default = true where x.team_id = team_meetings_default_set.team_id and x.user_id = auth.uid();
  end if;
  return public.kb_meetings_info(team_meetings_default_set.workspace_id);
end $$;

-- leaving the workspace removes the person's team memberships
create or replace function public.member_left_end_teams() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' or (old.deleted_at is null and new.deleted_at is not null) then
    delete from public.team_members t where t.workspace_id = old.workspace_id and t.user_id = old.user_id;
  end if;
  return null;
end $$;
create trigger members_end_teams after update of deleted_at or delete on public.members for each row execute function public.member_left_end_teams();

do $$ declare f text; begin
  foreach f in array array[
    'team_list(public.ulid)', 'team_shape(public.ulid)', 'team_create(public.ulid, text)', 'team_rename(public.ulid, text)', 'team_delete(public.ulid)',
    'team_member_set(public.ulid, uuid, text)', 'team_member_remove(public.ulid, uuid)', 'team_meetings_default_set(public.ulid, public.ulid)',
    'can_read_kb(public.ulid)', 'can_manage_team(public.ulid)', 'kb_create(public.ulid, text, text, public.ulid)', 'kb_set_access(public.ulid, jsonb)',
    'kb_meetings_folder(public.ulid, text)', 'kb_meetings_info(public.ulid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'is_team_member_as(public.ulid, uuid)', 'is_team_lead_as(public.ulid, uuid)', 'kb_access_applies(public.ulid, uuid, text[])', 'can_read_kb_as(public.ulid, uuid)',
    'can_admin_kb_as(public.ulid, uuid)', 'can_edit_kb_as(public.ulid, uuid)', 'team_touch_kbs(public.ulid)', 'kb_meetings_team(public.ulid, uuid)',
    'kb_ensure_team_meetings(public.ulid)', 'kb_meetings_of(public.ulid)', 'kb_meetings_target(public.ulid, uuid)', 'kb_meetings_open(public.ulid, public.ulid, uuid)',
    'team_name_check(public.ulid, text, public.ulid)', 'teams_before_delete()', 'member_left_end_teams()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function public.kb_ensure_team_meetings(public.ulid) to service_role;
