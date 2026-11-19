-- applied-when: select exists(select 1 from pg_proc where proname = 'delete_my_data')
-- Quorum hosted edition, step 47: a person deletes their hosted data and keeps the account, and the platform owner
-- resets an account from the admin app.
--   * delete_my_data() removes the caller's private notes, chats, meetings and personal knowledge bases, and keeps the
--     account, its email, its memberships and every workspace's plan and billing. In a workspace where the caller is
--     the only member, everything under it goes and the workspace row stays. In a shared workspace the caller's shared
--     notes go to the workspace's heir exactly as delete_my_account (0039, 0041) hands them over, and no other
--     member's row is touched.
--   * platform_reset_user(uid, reinvite, plan) deletes an account the way delete_my_account does, together with the
--     workspaces it is the only member of, so the person can start again. It refuses while the account owns a
--     workspace with other members or a workspace of its own still pays through Stripe, and answers which. With
--     reinvite, the same email gets a new access request and code on the chosen plan, as the Access page issues them.
--   * account_gone(uid) tells a signed-out Mac whether the account it last held still exists, so the app can say the
--     account was deleted instead of only asking for a sign-in. A user id is not guessable, so it reveals nothing.
-- The platform owner (platform_owners, 0008) is refused both deletes, as in 0039. Storage objects of the removed rows
-- go to kb_files_trash for the relay's sweep (relay/kbFilesCleanup.js).

create or replace function public.account_gone(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select account_gone.uid is not null and not exists (select 1 from auth.users u where u.id = account_gone.uid);
$$;
revoke all on function public.account_gone(uuid) from public;
grant execute on function public.account_gone(uuid) to anon, authenticated;

-- the workspaces a person owns where nobody else is an active member
create or replace function public.account_solo_workspaces(uid uuid) returns table (id public.ulid, name text)
language sql stable security definer set search_path = public as $$
  select o.id, o.name from public.account_owned_workspaces(uid) o
  where not exists (select 1 from public.members m where m.workspace_id = o.id and m.user_id <> uid and m.deleted_at is null);
$$;
revoke all on function public.account_solo_workspaces(uuid) from public, anon, authenticated;

-- 0041's hand-over from delete_my_account, on its own: every shared note of the person (in a workspace KB, visibility
-- public, or a pending or included contribution), outside their personal KBs, moves to the workspace's heir with its
-- links, attachments and contribution. Returns how many notes moved. A note with no heir stays with the person
create or replace function public.account_hand_over(uid uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare kept integer;
begin
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
  return kept;
end $$;
revoke all on function public.account_hand_over(uuid) from public, anon, authenticated;

-- puts the Storage objects that go with a person's data in the trash: the files and attachments of the given
-- workspaces, the files of the person's personal KBs, and the attachments still in the person's name. Returns how many
create or replace function public.account_trash_objects(uid uuid, workspaces public.ulid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare objects integer := 0; n integer;
begin
  insert into public.kb_files_trash (object_path, workspace_id, kb_id, bucket)
  select f.object_path, f.workspace_id, f.kb_id, 'kb-files' from public.kb_files f
  where f.workspace_id = any(workspaces) or f.kb_id in (select k.id from public.knowledge_bases k where k.personal_user_id = uid)
  on conflict (object_path) do nothing;
  get diagnostics n = row_count; objects := objects + n;
  insert into public.kb_files_trash (object_path, workspace_id, kb_id, bucket)
  select a.object_path, a.workspace_id, null, 'attachments' from public.attachments a
  where a.bucket = 'attachments' and (a.workspace_id = any(workspaces) or a.user_id = uid)
  on conflict (object_path) do nothing;
  get diagnostics n = row_count; objects := objects + n;
  return objects;
end $$;
revoke all on function public.account_trash_objects(uuid, public.ulid[]) from public, anon, authenticated;

-- deletes the caller's hosted data and keeps the account. In order:
--   1. refuse a signed-out caller and the platform owner;
--   2. hand the shared notes over (account_hand_over), so the teams keep them;
--   3. trash the Storage objects of what goes;
--   4. in each workspace the caller is alone in, delete its notes, meetings, chats, attachments and knowledge bases;
--      the workspace row, its membership, plan, billing, teams and settings stay;
--   5. everywhere else, delete the caller's personal KBs and the notes, meetings, chats and attachments still in the
--      caller's name.
-- Rows are deleted, never marked deleted, so a pull on another Mac renames nothing in a vault there.
create or replace function public.delete_my_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); solo public.ulid[]; objects integer; kept integer;
begin
  if uid is null then raise exception 'You need to sign in first'; end if;
  if public.account_is_platform_owner(uid) then raise exception 'The account that runs Quorum cannot delete its data from the app'; end if;
  solo := array(select s.id from public.account_solo_workspaces(uid) s);
  kept := public.account_hand_over(uid);
  objects := public.account_trash_objects(uid, solo);

  -- hosted KB notes and KB rows refuse signed-in deletes (0029, 0034); this delete is the system path
  perform set_config('quorum.kb_system', 'on', true);
  delete from public.chats c where c.workspace_id = any(solo);
  delete from public.meetings m where m.workspace_id = any(solo);
  delete from public.attachments a where a.workspace_id = any(solo);
  delete from public.notes n where n.workspace_id = any(solo);
  delete from public.knowledge_bases k where k.workspace_id = any(solo);

  delete from public.knowledge_bases k where k.personal_user_id = uid;
  delete from public.chats c where c.user_id = uid;
  delete from public.chat_turns t where t.user_id = uid;
  delete from public.meetings m where m.user_id = uid;
  delete from public.transcript_segments s where s.user_id = uid;
  delete from public.attachments a where a.user_id = uid;
  delete from public.notes n where n.user_id = uid;
  perform set_config('quorum.kb_system', '', true);

  insert into public.platform_audit (actor, action, target_workspace, detail)
  values (uid, 'data_deleted', null, jsonb_build_object('workspaces', coalesce(array_length(solo, 1), 0), 'kept', kept, 'objects', objects));
  return jsonb_build_object('ok', true, 'kept', kept, 'objects', objects, 'workspaces', coalesce(array_length(solo, 1), 0));
end $$;
revoke all on function public.delete_my_data() from public, anon;
grant execute on function public.delete_my_data() to authenticated;

-- the admin app's Reset user. Needs the platform owner's passkey session like every platform_* function. Answers
-- { ok: false, reason, workspaces } for the two refusals the page explains with names: 'shared' (the account owns a
-- workspace with other active members; its owner hands it on or deletes it first) and 'billing' (a workspace of its
-- own has a live Stripe subscription; cancel it first). Otherwise the account goes with its solo workspaces, shared
-- notes handed over as in 0039, and with reinvite the answer carries the new code under invite
create or replace function public.platform_reset_user(uid uuid, reinvite boolean default false, plan text default 'free') returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare e text; p text; shared jsonb; billed jsonb; solo public.ulid[]; names jsonb; objects integer; kept integer; req jsonb; issued jsonb;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  select lower(u.email::text) into e from auth.users u where u.id = platform_reset_user.uid;
  if not found then raise exception 'That account no longer exists'; end if;
  if public.account_is_platform_owner(platform_reset_user.uid) then raise exception 'The account that runs Quorum cannot be reset'; end if;
  p := coalesce(nullif(lower(trim(platform_reset_user.plan)), ''), 'free');
  if p not in ('free', 'cloud') then raise exception 'A code grants the free or the cloud plan'; end if;
  if platform_reset_user.reinvite and coalesce(e, '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That account has no email to invite again'; end if;

  select jsonb_agg(o.name order by o.name) into shared from public.account_owned_workspaces(platform_reset_user.uid) o
  where o.id not in (select s.id from public.account_solo_workspaces(platform_reset_user.uid) s);
  if shared is not null then return jsonb_build_object('ok', false, 'reason', 'shared', 'workspaces', shared); end if;
  select jsonb_agg(w.name order by w.name) into billed from public.workspaces w
  where w.id in (select s.id from public.account_solo_workspaces(platform_reset_user.uid) s)
    and w.stripe_subscription_id is not null and coalesce(w.billing_status, '') in ('active', 'trialing', 'past_due', 'unpaid', 'incomplete');
  if billed is not null then return jsonb_build_object('ok', false, 'reason', 'billing', 'workspaces', billed); end if;

  solo := array(select s.id from public.account_solo_workspaces(platform_reset_user.uid) s);
  names := coalesce((select jsonb_agg(w.name order by w.name) from public.workspaces w where w.id = any(solo)), '[]'::jsonb);
  kept := public.account_hand_over(platform_reset_user.uid);
  objects := public.account_trash_objects(platform_reset_user.uid, solo);
  perform set_config('quorum.kb_system', 'on', true);
  delete from public.workspaces w where w.id = any(solo);
  perform set_config('quorum.kb_system', '', true);
  delete from auth.users u where u.id = platform_reset_user.uid;
  insert into public.platform_audit (actor, action, target_workspace, detail)
  values (auth.uid(), 'reset_user', null, jsonb_build_object('email', e, 'workspaces', names, 'kept', kept, 'objects', objects, 'reinvite', platform_reset_user.reinvite, 'plan', p));

  if platform_reset_user.reinvite then
    req := public.platform_add_request(e, null, 'Invited again after a reset');
    issued := public.platform_invite_request((req ->> 'id')::public.ulid, 30, null, p);
  end if;
  return jsonb_build_object('ok', true, 'email', e, 'workspaces', names, 'kept', kept, 'objects', objects, 'invite', issued);
end $$;
revoke all on function public.platform_reset_user(uuid, boolean, text) from public, anon;
grant execute on function public.platform_reset_user(uuid, boolean, text) to authenticated, service_role;
