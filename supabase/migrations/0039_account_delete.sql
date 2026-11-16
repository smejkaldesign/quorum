-- applied-when: select exists(select 1 from pg_proc where proname = 'delete_my_account')
-- Quorum hosted edition, step 39: a person deletes their own hosted account, and a workspace owner deletes their
-- workspace, from Settings in the app. Both run as security definer functions that check the caller themselves.
--   * delete_my_account() hands the caller's shared notes (in a knowledge base, visibility public, or contributed) to
--     the workspace owner, then removes the caller's auth user. What still names the user cascades from auth.users
--     (0001 onward): private notes, chats, meetings. An owner of a live workspace is refused, because workspaces.user_id
--     cascades too and would take the members' data with it.
--   * delete_workspace(ws) removes one workspace and every row under it. Only its owner may, and only once no Stripe
--     subscription is live, so nobody keeps paying for a workspace that is gone.
--   * The Quorum platform owner (platform_owners, 0008) is refused both: that account runs Quorum itself and is changed
--     by hand. Membership in the table decides it, without the passkey session the admin app adds (0017).
-- Storage objects cannot be deleted from SQL, so both functions put the objects of the rows they remove in
-- kb_files_trash, and the relay's sweep (relay/kbFilesCleanup.js) deletes them through the Storage API. The trash now
-- keeps its rows after the workspace is gone and names the bucket of each object.

alter table public.kb_files_trash drop constraint if exists kb_files_trash_workspace_id_fkey;
alter table public.kb_files_trash add column if not exists bucket text not null default 'kb-files' check (bucket in ('kb-files', 'attachments'));

-- the sweep's read now names the bucket of each object; the moves of lapsed uploads are as before
drop function if exists public.kb_files_cleanup(interval, integer);
create function public.kb_files_cleanup(max_age interval default interval '1 day', max_rows integer default 500) returns table (object_path text, bucket text)
language plpgsql security definer set search_path = public as $$
begin
  perform public.kb_sync_service_only();
  with gone as (delete from public.kb_files f where not f.uploaded and f.created_at < now() - kb_files_cleanup.max_age returning f.object_path, f.workspace_id, f.kb_id)
  insert into public.kb_files_trash (object_path, workspace_id, kb_id) select g.object_path, g.workspace_id, g.kb_id from gone g on conflict do nothing;
  return query select t.object_path, t.bucket from public.kb_files_trash t order by t.created_at, t.object_path limit greatest(1, least(coalesce(kb_files_cleanup.max_rows, 500), 1000));
end $$;
revoke all on function public.kb_files_cleanup(interval, integer) from public, anon, authenticated;
grant execute on function public.kb_files_cleanup(interval, integer) to service_role;

create or replace function public.account_is_platform_owner(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select uid is not null and exists (select 1 from public.platform_owners o where o.user_id = uid);
$$;
revoke all on function public.account_is_platform_owner(uuid) from public, anon, authenticated;

-- the live workspaces a person owns: an owner membership, or the workspace row's own user_id (which cascades)
create or replace function public.account_owned_workspaces(uid uuid) returns table (id public.ulid, name text)
language sql stable security definer set search_path = public as $$
  select w.id, w.name from public.workspaces w
  where w.deleted_at is null
    and (w.user_id = uid or exists (select 1 from public.members m where m.workspace_id = w.id and m.user_id = uid and m.role = 'owner' and m.deleted_at is null))
  order by w.name, w.id;
$$;
revoke all on function public.account_owned_workspaces(uuid) from public, anon, authenticated;

create or replace function public.account_is_owner(ws public.ulid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.account_owned_workspaces(uid) o where o.id = ws);
$$;
revoke all on function public.account_is_owner(public.ulid, uuid) from public, anon, authenticated;

-- what the Settings danger zone asks before it offers either delete: whether the caller runs Quorum, and which
-- workspaces they own (an owner deletes those first)
create or replace function public.account_delete_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'You need to sign in first'; end if;
  return jsonb_build_object(
    'platform_owner', public.account_is_platform_owner(uid),
    'owned', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name)) from public.account_owned_workspaces(uid) o), '[]'::jsonb));
end $$;
revoke all on function public.account_delete_status() from public, anon;
grant execute on function public.account_delete_status() to authenticated;

-- the member who takes over a leaving person's shared notes in one workspace: the owner, else the longest-standing
-- admin, else the longest-standing member, so the team keeps the notes even in a workspace left without an owner
create or replace function public.account_heir(ws public.ulid, leaving uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select m.user_id from public.members m where m.workspace_id = ws and m.user_id <> leaving and m.deleted_at is null
      order by (m.role = 'owner') desc, (m.role = 'admin') desc, m.created_at limit 1),
    (select w.user_id from public.workspaces w where w.id = ws and w.user_id <> leaving));
$$;
revoke all on function public.account_heir(public.ulid, uuid) from public, anon, authenticated;

-- deletes the caller's hosted account. In order:
--   1. refuse a signed-out caller, the platform owner and the owner of a live workspace;
--   2. hand every shared note to the workspace's heir (account_heir). A note is shared when anyone besides its author
--      can read it (notes_select, 0024): it sits in a knowledge base (kb_id, team KBs included), its frontmatter says
--      visibility: public, or it has a pending or included contribution. The note's links, attachments and contribution
--      move with it, since their rows also cascade from the author;
--   3. put the attachments that stay with the person (the ones not on a handed-over note) in the storage trash;
--   4. delete the auth user. What still names the person cascades: private notes, chats, meetings, memberships.
-- A shared note with no heir (the person was the workspace's last member) goes with the account.
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
    and (n.kb_id is not null
         or coalesce(n.frontmatter ->> 'visibility', 'private') = 'public'
         or exists (select 1 from public.contributions c where c.note_id = n.id and c.status in ('pending', 'included')))
    and public.account_heir(n.workspace_id, uid) is not null;
  get diagnostics kept = row_count;

  -- hosted KB notes and KB membership checks refuse signed-in edits (0029, 0034); this hand-over is the system path
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
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- deletes a workspace the caller owns, with everything under it. Members lose access; their own accounts stay
create or replace function public.delete_workspace(ws public.ulid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); w public.workspaces; objects integer := 0; n integer;
begin
  if uid is null then raise exception 'You need to sign in first'; end if;
  if public.account_is_platform_owner(uid) then raise exception 'The account that runs Quorum cannot delete a workspace from the app'; end if;
  select * into w from public.workspaces x where x.id = delete_workspace.ws and x.deleted_at is null;
  if not found or not (public.is_member(w.id) or public.account_is_owner(w.id, uid)) then raise exception 'That workspace no longer exists'; end if;
  if not public.account_is_owner(w.id, uid) then raise exception 'Only the workspace owner can delete it'; end if;
  if w.stripe_subscription_id is not null and coalesce(w.billing_status, '') in ('active', 'trialing', 'past_due', 'unpaid', 'incomplete') then
    raise exception 'Cancel the subscription under Billing first, then delete the workspace';
  end if;
  insert into public.kb_files_trash (object_path, workspace_id, kb_id, bucket)
  select f.object_path, f.workspace_id, f.kb_id, 'kb-files' from public.kb_files f where f.workspace_id = w.id
  on conflict (object_path) do nothing;
  get diagnostics n = row_count; objects := objects + n;
  insert into public.kb_files_trash (object_path, workspace_id, kb_id, bucket)
  select a.object_path, a.workspace_id, null, 'attachments' from public.attachments a where a.workspace_id = w.id and a.bucket = 'attachments'
  on conflict (object_path) do nothing;
  get diagnostics n = row_count; objects := objects + n;
  -- hosted KB notes are guarded against signed-in deletes (0034); this delete is the system path
  perform set_config('quorum.kb_system', 'on', true);
  delete from public.workspaces x where x.id = w.id;
  perform set_config('quorum.kb_system', '', true);
  insert into public.platform_audit (actor, action, target_workspace, detail)
  values (uid, 'workspace_deleted', null, jsonb_build_object('workspace', w.id, 'name', w.name, 'plan', w.plan));
  return jsonb_build_object('ok', true, 'objects', objects);
end $$;
revoke all on function public.delete_workspace(public.ulid) from public, anon;
grant execute on function public.delete_workspace(public.ulid) to authenticated;
