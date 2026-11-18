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
-- 5. Every refusal for a KB the caller cannot read says it no longer exists, so a refusal does not confirm that a
--    personal KB exists. The owner deletes a personal KB; workspace owners and admins cannot. Deleting it soft deletes the notes its own
--    synced folders wrote and the notes imported from its source, so each Mac removes them; every other note the owner
--    placed in it goes back to being the owner's own note. A member who leaves the workspace takes their personal KBs with them the same
--    way, after 0032 ended their sync grants. Deleting an account (0039) no longer hands the notes of the person's
--    personal KBs to the workspace owner; they go with the account.
-- 6. The workspace decides what members do with personal KBs: workspaces.personal_kbs (on by default) lets members
--    make them, and workspaces.personal_kb_sources (GitHub and Google Drive by default) names the sources members may
--    sync or import into them. Workspace owners and admins keep their own personal KBs either way. kb_create,
--    kb_sync_attach, a note joining a member's personal KB, and a note in one whose source or text a refused source
--    would change check it. Turning either off pauses the affected synced
--    folders with paused_by 'policy' and keeps every KB and note; turning it back on resumes them. A role change
--    applies it at once: a demoted admin's synced folders pause, and a promoted member's resume.
-- 7. Note paths. A path was unique in its workspace (0001), so two people syncing one repository into personal KBs of
--    the same name collided. A note in a personal KB now carries notes.personal_kb, and its path is unique among its
--    author's notes only; every other note keeps the workspace-wide rule, and a person's own notes never share a path.
--    Each Mac writes its person's own notes into the vault at their path and everyone else's under the team folder,
--    so no vault gets two files at one path.

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

-- notes.personal_kb follows the note's KB on every write, after notes_kb_check (0024, 0029) settled kb_id
create or replace function public.notes_personal_kb_flag() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.personal_kb := new.kb_id is not null and public.kb_is_personal(new.kb_id);
  return new;
end $$;
create trigger notes_personal_kb_flag before insert or update on public.notes for each row execute function public.notes_personal_kb_flag();

-- a path for a note leaving a personal KB that no other live workspace note holds: the same path, or "name (2).md"
-- and on
create or replace function public.kb_free_path(ws public.ulid, note_id public.ulid, path text) returns text
language plpgsql stable security definer set search_path = public as $$
declare base text := regexp_replace(kb_free_path.path, '\.md$', ''); cand text := kb_free_path.path; i integer := 1;
begin
  while exists (select 1 from public.notes n where n.workspace_id = ws and n.path = cand and n.deleted_at is null and not n.personal_kb and n.id <> note_id)
     or exists (select 1 from public.notes n where n.workspace_id = ws and n.path = cand and n.deleted_at is null and n.id <> note_id
                and n.user_id = (select x.user_id from public.notes x where x.id = note_id)) loop
    i := i + 1;
    cand := base || ' (' || i || ').md';
  end loop;
  return cand;
end $$;

-- whether a name is free for a new or renamed KB: among the workspace's KBs, or among the owner's personal KBs
create or replace function public.kb_name_taken(ws public.ulid, owner uuid, name text, except_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.knowledge_bases x
    where x.workspace_id = ws and x.personal_user_id is not distinct from owner and x.id is distinct from except_id and lower(btrim(x.name)) = lower(btrim(kb_name_taken.name)));
$$;

-- 7. paths unique per author inside personal KBs
alter table public.notes add column personal_kb boolean not null default false;
drop index public.notes_workspace_path;
create unique index notes_workspace_path on public.notes (workspace_id, path) where deleted_at is null and not personal_kb;
create unique index notes_author_path on public.notes (workspace_id, user_id, path) where deleted_at is null;

-- 6. the workspace's policy for members' personal KBs
alter table public.workspaces add column personal_kbs boolean not null default true;
alter table public.workspaces add column personal_kb_sources text[] not null default '{github,google-drive}'
  check (personal_kb_sources <@ array['github', 'google-drive']);
alter table public.kb_attachments drop constraint kb_attachments_paused_by_check;
alter table public.kb_attachments add constraint kb_attachments_paused_by_check check (paused_by is null or paused_by in ('admin', 'plan', 'policy'));

-- why the workspace refuses a member's personal KB this source (null: the source does not matter), or null when it
-- allows it. A KB that is not personal, and the personal KB of a workspace owner or admin, is never refused
create or replace function public.kb_personal_refusal(kb_id public.ulid, provider text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when not w.personal_kbs then 'Your workspace does not allow members to use personal knowledge bases'
    when kb_personal_refusal.provider is not null and not (kb_personal_refusal.provider = any (w.personal_kb_sources))
      then 'Your workspace does not allow ' || case kb_personal_refusal.provider when 'github' then 'GitHub' when 'google-drive' then 'Google Drive' else kb_personal_refusal.provider end || ' in personal knowledge bases'
    end
  from public.knowledge_bases k join public.workspaces w on w.id = k.workspace_id
  where k.id = kb_personal_refusal.kb_id and k.personal_user_id is not null
    and not exists (select 1 from public.members m where m.workspace_id = k.workspace_id and m.user_id = k.personal_user_id and m.role in ('owner', 'admin') and m.deleted_at is null);
$$;

-- the source a note came from, as kbImport, kbDrive and the sync worker write kb_source
create or replace function public.kb_source_provider(kb_source text) returns text
language sql immutable set search_path = public as $$
  select case when kb_source like 'google-drive:%' then 'google-drive' when kb_source like 'github:%' or kb_source like 'https://github.com/%' then 'github' end;
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
declare why text;
begin
  if new.kb_id is not null and exists (select 1 from public.knowledge_bases k where k.id = new.kb_id and k.personal_user_id is not null and k.personal_user_id <> new.user_id) then
    raise exception 'Only your own notes can go in a personal knowledge base';
  end if;
  -- a member's personal KB follows the workspace's policy (6): for a note joining it, and for a live note in it whose
  -- source changes or whose text changes while its source is refused (a re-import or a new copy of a refused source)
  if new.kb_id is not null and new.deleted_at is null then
    if tg_op = 'INSERT' or new.kb_id is distinct from old.kb_id then
      why := public.kb_personal_refusal(new.kb_id, public.kb_source_provider(new.frontmatter ->> 'kb_source'));
    elsif public.kb_source_provider(new.frontmatter ->> 'kb_source') is not null
      and (new.frontmatter ->> 'kb_source' is distinct from old.frontmatter ->> 'kb_source' or new.body is distinct from old.body) then
      why := public.kb_personal_refusal(new.kb_id, public.kb_source_provider(new.frontmatter ->> 'kb_source'));
    end if;
    if why is not null then raise exception '%', why; end if;
  end if;
  return new;
end $$;
create trigger notes_personal_kb_owner before insert or update of kb_id, user_id, frontmatter, body on public.notes for each row execute function public.notes_personal_kb_owner();

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
    if not public.is_admin(kb_create.workspace_id) and not exists (select 1 from public.workspaces w where w.id = kb_create.workspace_id and w.personal_kbs) then
      raise exception 'Your workspace does not allow members to use personal knowledge bases';
    end if;
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

-- a KB the caller cannot read answers as gone, so no refusal says that someone's personal KB exists: 0034's
-- kb_arrange_check (folder writes), 0024's kb_note_assign, 0032's kb_attachments_list and 0033's kb_sync_attach check
-- reading before managing
create or replace function public.kb_arrange_check(kb_id public.ulid, refusal text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_read_kb(kb_arrange_check.kb_id) then raise exception 'That knowledge base no longer exists'; end if;
  if public.kb_is_hosted(kb_arrange_check.kb_id) then perform public.kb_hosted_write_check(kb_arrange_check.kb_id);
  elsif not public.can_admin_kb(kb_arrange_check.kb_id) then raise exception '%', refusal;
  end if;
end $$;

create or replace function public.kb_note_assign(note_id public.ulid, kb_id public.ulid, folder_id public.ulid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n public.notes;
begin
  select * into n from public.notes x where x.id = kb_note_assign.note_id and x.deleted_at is null;
  if n.id is null or not public.note_readable(n.id) then raise exception 'That note no longer exists'; end if;
  if kb_note_assign.kb_id is not null and not public.can_read_kb(kb_note_assign.kb_id) then raise exception 'That knowledge base no longer exists'; end if;
  if kb_note_assign.kb_id is not null and not public.can_admin_kb(kb_note_assign.kb_id) then raise exception 'Only the knowledge base''s admins can add notes to it'; end if;
  if kb_note_assign.kb_id is null and kb_note_assign.folder_id is not null then raise exception 'Pick a knowledge base for that folder'; end if;
  if kb_note_assign.kb_id is not null and n.user_id <> auth.uid() and not public.is_admin(n.workspace_id) then raise exception 'Only the note''s author or a workspace admin can move this note'; end if;
  update public.notes x set kb_id = kb_note_assign.kb_id, folder_id = kb_note_assign.folder_id where x.id = n.id returning * into n;
  return jsonb_build_object('note_id', n.id, 'kb_id', n.kb_id, 'folder_id', n.folder_id, 'updated_at', n.updated_at);
end $$;

create or replace function public.kb_sync_attach(uid uuid, kb_id public.ulid, folder_id public.ulid, provider text, remote_id text, remote_kind text,
  options jsonb, name text, url text, token text default null, client text default 'quorum', shared_with_mac boolean default false, account text default null,
  attach_id text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  k public.knowledge_bases;
  w public.workspaces;
  integ public.workspace_integrations;
  g public.kb_sync_grants;
  a public.kb_attachments;
  p text := lower(trim(coalesce(kb_sync_attach.provider, '')));
  rid text := trim(coalesce(kb_sync_attach.remote_id, ''));
  tok text := coalesce(kb_sync_attach.token, '');
  opts jsonb := coalesce(kb_sync_attach.options, '{}'::jsonb);
  sid uuid;
  old_grant public.kb_sync_grants;
begin
  perform public.kb_sync_service_only();
  -- the same attach sent again (a retry after a timeout) answers the attachment it made, and changes nothing
  if kb_sync_attach.attach_id is not null then
    if char_length(kb_sync_attach.attach_id) > 80 then raise exception 'That attach id is too long'; end if;
    select * into a from public.kb_attachments x where x.attach_id = kb_sync_attach.attach_id;
    if a.id is not null then
      if a.attached_by is distinct from uid then raise exception 'That attach id is taken'; end if;
      return public.kb_attachment_row(a);
    end if;
  end if;
  select * into k from public.knowledge_bases x where x.id = kb_sync_attach.kb_id;
  if k.id is null then raise exception 'That knowledge base no longer exists'; end if;
  if not public.can_read_kb_as(k.id, uid) then raise exception 'That knowledge base no longer exists'; end if;
  if not public.can_admin_kb_as(k.id, uid) then raise exception 'Only the knowledge base''s admins can sync folders into it'; end if;
  if public.kb_personal_refusal(k.id, p) is not null then raise exception '%', public.kb_personal_refusal(k.id, p); end if;
  if kb_sync_attach.folder_id is not null and not exists (select 1 from public.kb_folders f where f.id = kb_sync_attach.folder_id and f.kb_id = k.id) then
    raise exception 'That folder is not in this knowledge base';
  end if;
  if p not in ('google-drive', 'github') then raise exception 'That connector cannot sync folders yet'; end if;
  if kb_sync_attach.remote_kind not in ('folder', 'file') then raise exception 'Pick a folder or a file'; end if;
  if p = 'github' and kb_sync_attach.remote_kind <> 'folder' then raise exception 'A GitHub repository syncs as a folder'; end if;
  if rid = '' or char_length(rid) > 300 then raise exception 'That item could not be read'; end if;
  if p = 'github' and rid !~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$' then raise exception 'That repository address is not valid'; end if;
  if jsonb_typeof(opts) <> 'object' then raise exception 'The sync options must be an object'; end if;
  opts := jsonb_strip_nulls(jsonb_build_object('branch', nullif(trim(coalesce(opts ->> 'branch', '')), ''), 'path', nullif(trim(both '/' from coalesce(opts ->> 'path', '')), '')));
  if coalesce(kb_sync_attach.client, 'quorum') not in ('quorum', 'workspace') then raise exception 'Unknown OAuth client'; end if;
  if char_length(tok) > 4096 then raise exception 'That token is too long'; end if;

  select * into w from public.workspaces x where x.id = k.workspace_id and x.deleted_at is null;
  if w.id is null then raise exception 'That workspace no longer exists'; end if;
  select * into integ from public.workspace_integrations x where x.workspace_id = w.id and x.provider = p;
  if integ.id is not null and not integ.enabled then raise exception 'This connector is turned off for the workspace'; end if;
  if integ.id is null and w.team_enabled and w.approved_connectors_only then
    raise exception 'Your workspace allows only connectors an admin approved. Ask an owner or admin to enable this one.';
  end if;
  if kb_sync_attach.client = 'workspace' and (integ.id is null or integ.mode <> 'org' or coalesce(integ.config ->> 'auth', '') <> 'oauth_client' or integ.secret_id is null) then
    raise exception 'The workspace has no OAuth client for this connector';
  end if;

  select * into g from public.kb_sync_grants x where x.workspace_id = w.id and x.user_id = uid and x.provider = p and x.ended_at is null for update;
  if tok = '' and g.id is null then raise exception 'Sign in to the provider first'; end if;
  if tok <> '' and g.id is not null and (g.client <> kb_sync_attach.client) then
    -- a token from another client cannot refresh under the stored one: a new grant starts, the admin's other
    -- attachments move to it, and the old grant then ends (revoked when it is a grant of its own)
    old_grant := g;
    update public.kb_sync_grants x set ended_at = now(), ended_reason = 'removed' where x.id = g.id;
    g := null;
  end if;
  if tok <> '' and g.id is not null then
    perform vault.update_secret(g.secret_id, tok);
    update public.kb_sync_grants x set account = coalesce(kb_sync_attach.account, x.account), shared_with_mac = coalesce(kb_sync_attach.shared_with_mac, x.shared_with_mac),
      integration_id = integ.id where x.id = g.id returning * into g;
    update public.kb_attachments x set status = 'pending', error = null, next_run_at = now(), failures = 0 where x.grant_id = g.id and x.status = 'needs_auth';
  elsif tok <> '' then
    insert into public.kb_sync_grants (workspace_id, user_id, provider, client, integration_id, shared_with_mac, account)
      values (w.id, uid, p, coalesce(kb_sync_attach.client, 'quorum'), integ.id, coalesce(kb_sync_attach.shared_with_mac, false), kb_sync_attach.account)
      returning * into g;
    sid := vault.create_secret(tok, 'kb_sync_grant:' || g.id, p || ' sync grant in workspace ' || w.id);
    update public.kb_sync_grants x set secret_id = sid where x.id = g.id returning * into g;
  end if;
  if old_grant.id is not null then
    update public.kb_attachments x set grant_id = g.id, status = case when x.status = 'paused' then x.status else 'pending' end, next_run_at = now(), failures = 0
      where x.grant_id = old_grant.id;
    if public.kb_sync_revokes(old_grant, 'removed') and old_grant.secret_id is not null then
      update public.kb_sync_grants x set revoke_pending = true, revoke_after = now() where x.id = old_grant.id;
    else
      delete from public.kb_sync_grants x where x.id = old_grant.id;
    end if;
  end if;

  select * into a from public.kb_attachments x where x.kb_id = k.id and x.provider = p and x.remote_id = rid
    and coalesce(x.options ->> 'branch', '') = coalesce(opts ->> 'branch', '') and coalesce(x.options ->> 'path', '') = coalesce(opts ->> 'path', '');
  if a.id is not null then
    -- attaching the same item again moves it under this admin's grant and runs it now
    update public.kb_attachments x set grant_id = g.id, attached_by = uid, integration_id = integ.id, status = 'pending', error = null, next_run_at = now(), failures = 0,
      attach_id = coalesce(kb_sync_attach.attach_id, x.attach_id),
      name = coalesce(nullif(btrim(kb_sync_attach.name), ''), x.name), url = coalesce(kb_sync_attach.url, x.url)
      where x.id = a.id returning * into a;
  else
    insert into public.kb_attachments (workspace_id, kb_id, folder_id, provider, integration_id, grant_id, remote_id, remote_kind, options, name, url, attached_by, attach_id)
      values (w.id, k.id, kb_sync_attach.folder_id, p, integ.id, g.id, rid, kb_sync_attach.remote_kind, opts, left(coalesce(nullif(btrim(kb_sync_attach.name), ''), rid), 200), kb_sync_attach.url, uid, kb_sync_attach.attach_id)
      returning * into a;
  end if;
  return public.kb_attachment_row(a);
end $$;

create or replace function public.kb_attachments_list(kb_id public.ulid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_read_kb(kb_attachments_list.kb_id) then raise exception 'That knowledge base no longer exists'; end if;
  if not public.can_admin_kb(kb_attachments_list.kb_id) then raise exception 'Only the knowledge base''s admins can see its synced folders'; end if;
  return coalesce((select jsonb_agg(public.kb_attachment_row(a) order by a.created_at) from public.kb_attachments a where a.kb_id = kb_attachments_list.kb_id), '[]'::jsonb);
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
  -- the notes that stay become workspace notes again; one whose path another note took meanwhile moves to a free one
  update public.notes n set path = public.kb_free_path(n.workspace_id, n.id, n.path)
    where n.kb_id = k.id and n.deleted_at is null
      and exists (select 1 from public.notes o where o.workspace_id = n.workspace_id and o.path = n.path and o.deleted_at is null and not o.personal_kb and o.id <> n.id);
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

-- 6. the policy as the app reads it: whether members may use personal KBs, the sources they may sync or import, and
-- whether the caller is exempt (a workspace owner or admin)
create or replace function public.workspace_personal_kbs(workspace_id public.ulid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('enabled', w.personal_kbs, 'sources', to_jsonb(w.personal_kb_sources), 'exempt', public.is_admin(w.id))
  from public.workspaces w where w.id = workspace_personal_kbs.workspace_id and public.is_member(w.id);
$$;

-- puts each synced folder of a member's personal KB in line with the policy: one the policy refuses is paused with
-- paused_by 'policy', and one the policy paused that it allows again resumes (or waits for the plan, when it ended)
create or replace function public.kb_personal_policy_apply(ws public.ulid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.kb_attachments a set status = 'paused', paused_by = 'policy', error = public.kb_personal_refusal(a.kb_id, a.provider), lease_until = null
    where a.workspace_id = ws and a.status <> 'paused' and public.kb_personal_refusal(a.kb_id, a.provider) is not null;
  update public.kb_attachments a set
      status = case when w.plan = 'free' then 'paused' when a.grant_id is null then 'needs_auth' else 'pending' end,
      paused_by = case when w.plan = 'free' then 'plan' else null end,
      error = case when w.plan = 'free' then public.kb_sync_plan_ended() else null end,
      next_run_at = now(), failures = 0
    from public.workspaces w
    where w.id = a.workspace_id and a.workspace_id = ws and a.status = 'paused' and a.paused_by = 'policy' and public.kb_personal_refusal(a.kb_id, a.provider) is null;
end $$;

-- a role change moves a person in or out of the policy: a demoted admin's personal KB syncs pause when the policy
-- refuses them, and they resume when the person is an owner or admin again
create or replace function public.member_role_personal_policy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.kb_personal_policy_apply(new.workspace_id);
  return null;
end $$;
create trigger members_personal_policy after update of role on public.members for each row
  when (new.role is distinct from old.role) execute function public.member_role_personal_policy();

create or replace function public.workspace_personal_kbs_set(workspace_id public.ulid, enabled boolean, sources text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare src text[] := array(select distinct x from unnest(coalesce(workspace_personal_kbs_set.sources, '{}')) x order by x);
begin
  if not public.is_admin(workspace_personal_kbs_set.workspace_id) then raise exception 'Only owners and admins can change what members do with personal knowledge bases'; end if;
  if not src <@ array['github', 'google-drive'] then raise exception 'A source is GitHub or Google Drive'; end if;
  update public.workspaces w set personal_kbs = coalesce(workspace_personal_kbs_set.enabled, true), personal_kb_sources = src
    where w.id = workspace_personal_kbs_set.workspace_id and w.deleted_at is null;
  if not found then raise exception 'That workspace does not exist'; end if;
  perform public.kb_personal_policy_apply(workspace_personal_kbs_set.workspace_id);
  return public.workspace_personal_kbs(workspace_personal_kbs_set.workspace_id);
end $$;

-- 0032's kb_attachment_pause: Resume refuses a synced folder the workspace's policy refuses
create or replace function public.kb_attachment_pause(id public.ulid, paused boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.kb_attachments := public.kb_attachment_of(kb_attachment_pause.id); why text;
begin
  if coalesce(kb_attachment_pause.paused, true) then
    update public.kb_attachments x set status = 'paused', paused_by = 'admin', error = case when x.paused_by in ('plan', 'policy') then null else x.error end, lease_until = null
      where x.id = a.id returning * into a;
  elsif a.status = 'paused' then
    if exists (select 1 from public.workspaces w where w.id = a.workspace_id and w.plan = 'free') then raise exception '%. Syncing resumes when the plan is active again.', public.kb_sync_plan_ended(); end if;
    why := public.kb_personal_refusal(a.kb_id, a.provider);
    if why is not null then raise exception '%', why; end if;
    update public.kb_attachments x set status = case when x.grant_id is null then 'needs_auth' else 'pending' end, paused_by = null,
      error = case when x.paused_by in ('plan', 'policy') then null else x.error end, next_run_at = now(), failures = 0
      where x.id = a.id returning * into a;
  end if;
  return public.kb_attachment_row(a);
end $$;

-- 0032's kb_sync_plan_changed: a plan that is active again resumes what the plan paused, except what the policy refuses,
-- which stays paused for the policy
create or replace function public.kb_sync_plan_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.plan = 'free' and old.plan is distinct from 'free' then
    update public.kb_attachments a set status = 'paused', paused_by = 'plan', error = public.kb_sync_plan_ended(), lease_until = null
      where a.workspace_id = new.id and a.status <> 'paused';
  elsif old.plan = 'free' and new.plan is distinct from 'free' then
    update public.kb_attachments a set status = case when a.grant_id is null then 'needs_auth' else 'pending' end, paused_by = null, error = null,
      next_run_at = now(), failures = 0
      where a.workspace_id = new.id and a.status = 'paused' and a.paused_by = 'plan';
    perform public.kb_personal_policy_apply(new.id);
  end if;
  return new;
end $$;

do $$ declare f text; begin
  foreach f in array array['kb_create(public.ulid, text, text, public.ulid, boolean)', 'workspace_personal_kbs(public.ulid)', 'workspace_personal_kbs_set(public.ulid, boolean, text[])', 'kb_rename(public.ulid, text)', 'kb_delete(public.ulid)', 'kb_shape(public.ulid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'kb_is_personal(public.ulid)', 'kb_name_taken(public.ulid, uuid, text, public.ulid)', 'kb_personal_refusal(public.ulid, text)', 'kb_source_provider(text)', 'kb_personal_policy_apply(public.ulid)', 'member_role_personal_policy()', 'can_read_kb_as(public.ulid, uuid)', 'can_admin_kb_as(public.ulid, uuid)',
    'can_edit_kb_as(public.ulid, uuid)', 'kb_access_personal_check()', 'notes_personal_kb_owner()', 'notes_personal_kb_flag()', 'kb_free_path(public.ulid, public.ulid, text)', 'kb_personal_drop(public.ulid)', 'note_contribution_apply(public.notes)', 'note_contribution_sync()', 'note_personal_kb_moved()',
    'member_left_end_personal_kbs()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
