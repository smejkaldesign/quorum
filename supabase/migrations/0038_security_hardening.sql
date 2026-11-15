-- applied-when: select exists(select 1 from pg_trigger where tgname = 'workspaces_billing_guard')
-- Security hardening from the hosted audit (part B). Each section names the finding it closes. Nothing here changes
-- what the app reads; the writes the app makes already go through the security definer functions redefined below.

-- ---------------------------------------------------------------------------------------------------------------
-- P0-1. Workspace billing columns. Before this, an owner could write plan, seats, hour packs and Stripe ids on their
-- own workspace through PostgREST. Now only three kinds of caller may change them:
--   1. the relay, which uses the service role key (Stripe webhook, hour packs);
--   2. a session with no end-user identity (migrations, the dashboard SQL editor, scheduled jobs);
--   3. a security definer function that sets quorum.billing_write to 'on' for its own transaction and resets it after
--      the write (platform_set_plan, platform_set_code_plan, create_workspace for a cloud access code).
-- Everyone else gets the defaults on insert and an error when an update touches a billing column.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.billing_write_trusted() returns boolean
language sql stable set search_path = public as $$
  select coalesce(current_setting('quorum.billing_write', true), '') = 'on'
      or coalesce(auth.role(), '') = 'service_role'
      or (auth.uid() is null and coalesce(auth.role(), '') not in ('authenticated', 'anon'));
$$;
revoke all on function public.billing_write_trusted() from public, anon;
grant execute on function public.billing_write_trusted() to authenticated, service_role;

create or replace function public.workspaces_billing_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if public.billing_write_trusted() then return new; end if;
  if tg_op = 'INSERT' then
    if new.plan is distinct from 'free' or new.seats is distinct from 1 or new.seats_included is distinct from 0 or new.hour_packs is distinct from 0
       or new.stripe_customer_id is not null or new.stripe_subscription_id is not null or new.billing_status is not null
       or new.current_period_end is not null or new.notes is not null then
      raise exception 'A new workspace starts on the free plan; billing fields are set by Quorum billing only' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.plan is distinct from old.plan or new.seats is distinct from old.seats or new.seats_included is distinct from old.seats_included
     or new.hour_packs is distinct from old.hour_packs or new.stripe_customer_id is distinct from old.stripe_customer_id
     or new.stripe_subscription_id is distinct from old.stripe_subscription_id or new.billing_status is distinct from old.billing_status
     or new.current_period_end is distinct from old.current_period_end or new.notes is distinct from old.notes then
    raise exception 'Billing fields on a workspace are set by Quorum billing only' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists workspaces_billing_guard on public.workspaces;
create trigger workspaces_billing_guard before insert or update on public.workspaces for each row execute function public.workspaces_billing_guard();

-- The app reads workspaces and writes them only through security definer functions (create_workspace and the
-- workspace_*_set functions), so signed-in clients lose direct insert and update. Select and delete stay as they were.
revoke insert, update on public.workspaces from anon, authenticated;

-- the platform owner's plan change, as in 0008, with the billing flag set around the write
create or replace function public.platform_set_plan(workspace_id public.ulid, plan text, seats_included integer default 0, notes text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare before jsonb; after jsonb;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  if platform_set_plan.plan not in ('free', 'paid', 'cloud', 'internal') then raise exception 'A plan is free, paid, cloud or internal'; end if;
  if coalesce(platform_set_plan.seats_included, 0) < 0 then raise exception 'Seats included cannot be negative'; end if;
  select jsonb_build_object('plan', w.plan, 'seats_included', w.seats_included, 'notes', w.notes) into before
    from public.workspaces w where w.id = platform_set_plan.workspace_id and w.deleted_at is null;
  if before is null then raise exception 'That workspace no longer exists'; end if;
  perform set_config('quorum.billing_write', 'on', true);
  update public.workspaces w
    set plan = platform_set_plan.plan, seats_included = coalesce(platform_set_plan.seats_included, 0), notes = nullif(trim(coalesce(platform_set_plan.notes, '')), '')
    where w.id = platform_set_plan.workspace_id
    returning jsonb_build_object('plan', w.plan, 'seats_included', w.seats_included, 'notes', w.notes) into after;
  perform set_config('quorum.billing_write', 'off', true);
  insert into public.platform_audit (actor, action, target_workspace, detail)
    values (auth.uid(), 'set_plan', platform_set_plan.workspace_id, jsonb_build_object('before', before, 'after', after));
  return after;
end $$;

-- moving an approved person between free and cloud, as in 0018, with the billing flag set around the write
create or replace function public.platform_set_code_plan(code_id public.ulid, plan text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.access_codes; p text; ws public.ulid;
begin
  if not public.is_platform_owner() then raise exception 'Only the platform owner can do that'; end if;
  p := coalesce(nullif(lower(trim(platform_set_code_plan.plan)), ''), 'free');
  if p not in ('free', 'cloud') then raise exception 'A code grants the free or the cloud plan'; end if;
  select * into c from public.access_codes a where a.id = platform_set_code_plan.code_id;
  if not found then raise exception 'That code no longer exists'; end if;
  if c.revoked_at is not null then raise exception 'That code was revoked; approve the request again'; end if;
  update public.access_codes a set plan = p where a.id = c.id;
  ws := c.granted_workspace_id;
  if ws is not null and (select w.plan from public.workspaces w where w.id = ws) in ('free', 'cloud') then
    perform set_config('quorum.billing_write', 'on', true);
    update public.workspaces w set plan = case when p = 'cloud' then 'cloud' else 'free' end, seats_included = case when p = 'cloud' then greatest(w.seats_included, 1) else w.seats_included end where w.id = ws;
    perform set_config('quorum.billing_write', 'off', true);
  end if;
  insert into public.platform_audit (actor, action, target_workspace, detail) values (auth.uid(), 'set_code_plan', ws, jsonb_build_object('email', c.email, 'plan', p));
  return jsonb_build_object('id', c.id, 'plan', p, 'workspace', ws);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- P1-4. Workspace domains. Before this, a workspace could claim any company's email domain and be offered to every
-- person signing up with that domain. Now a domain is accepted only when it equals the acting user's own email domain.
-- create_workspace checks it with a readable message; the trigger covers every other insert or update of the column.
-- The service role and sessions with no end-user identity are exempt, so the platform owner can still fix a row by hand.
-- create_workspace also carries the P0-1 billing flag for the cloud access code grant.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.create_workspace(name text, domain text default null, domain_join boolean default true) returns public.workspaces
language plpgsql security definer set search_path = public as $$
declare ws public.workspaces; d text; c public.access_codes; mine text;
begin
  if auth.uid() is null then raise exception 'You need to sign in first'; end if;
  d := nullif(lower(trim(create_workspace.domain)), '');
  if d is not null and public.is_public_mail_domain(d) then d := null; end if;
  mine := lower(split_part(coalesce(auth.email(), ''), '@', 2));
  if d is not null and d <> mine then raise exception 'A workspace can only use the domain of your own email address (%)', coalesce(nullif(mine, ''), 'none'); end if;
  insert into public.workspaces (id, user_id, name, domain, domain_join)
  values (public.gen_ulid(), auth.uid(), coalesce(nullif(trim(create_workspace.name), ''), 'My workspace'), d, d is not null and coalesce(create_workspace.domain_join, true))
  returning * into ws;
  select * into c from public.access_codes a where a.redeemed_by = auth.uid() and a.plan = 'cloud' and a.granted_workspace_id is null order by a.redeemed_at desc limit 1;
  if found then
    perform set_config('quorum.billing_write', 'on', true);
    update public.workspaces w set plan = 'cloud', seats_included = greatest(w.seats_included, 1) where w.id = ws.id returning * into ws;
    perform set_config('quorum.billing_write', 'off', true);
    update public.access_codes a set granted_workspace_id = ws.id where a.id = c.id;
  end if;
  return ws;
end $$;

create or replace function public.workspaces_domain_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.domain is null then return new; end if;
  if tg_op = 'UPDATE' and new.domain is not distinct from old.domain then return new; end if;
  if coalesce(auth.role(), '') = 'service_role' or (auth.uid() is null and coalesce(auth.role(), '') not in ('authenticated', 'anon')) then return new; end if;
  if new.domain <> lower(split_part(coalesce(auth.email(), ''), '@', 2)) then
    raise exception 'A workspace can only use the domain of your own email address' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists workspaces_domain_guard on public.workspaces;
create trigger workspaces_domain_guard before insert or update of domain on public.workspaces for each row execute function public.workspaces_domain_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- P1-3. Invite-based sign-up. Before this, any approved user could create a workspace and invite unlimited new
-- emails, and each invite admitted a sign-up without an access code. Now an invite admits a sign-up only when its
-- workspace is on a live plan (paid, cloud or internal), and one workspace can create at most 50 invites a day.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.auth_user_gate() returns trigger
language plpgsql security definer set search_path = public as $$
declare c public.access_codes; invited boolean;
begin
  invited := exists (
    select 1 from public.invites i join public.workspaces w on w.id = i.workspace_id
    where i.email = lower(new.email) and i.accepted_at is null and i.deleted_at is null and i.expires_at > now()
      and w.deleted_at is null and w.plan in ('paid', 'cloud', 'internal'));
  update public.access_codes a set redeemed_at = now(), redeemed_by = new.id
    where a.email = lower(new.email) and a.redeemed_at is null and a.revoked_at is null and a.expires_at > now() and (invited or a.claimed_at > now() - interval '1 hour')
    returning * into c;
  if not found and not invited then raise exception 'An access code is needed to sign up for Quorum Cloud'; end if;
  if c.id is not null then update public.access_requests r set user_id = new.id, signed_in_at = now() where r.code_id = c.id; end if;
  return new;
end $$;

create or replace function public.invites_daily_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;
  if (select count(*) from public.invites i where i.workspace_id = new.workspace_id and i.created_at > now() - interval '1 day') >= 50 then
    raise exception 'This workspace has sent 50 invites today. Try again tomorrow.' using errcode = '54000';
  end if;
  return new;
end $$;
drop trigger if exists invites_daily_limit on public.invites;
create trigger invites_daily_limit before insert on public.invites for each row execute function public.invites_daily_limit();

-- ---------------------------------------------------------------------------------------------------------------
-- P1-5. Chats, chat turns and personal settings. Before this, every member could read, change and delete every other
-- member's AI chats and per-user settings. Now chats and turns belong to their author only, a turn can be added only
-- to the author's own chat, and settings split by scope: a user row is its owner's only; the workspace row is read by
-- members and written by owners and admins.
-- ---------------------------------------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['chats', 'chat_turns', 'settings'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
  end loop;
end $$;

create policy chats_select on public.chats for select to authenticated using (user_id = auth.uid() and public.is_member(workspace_id));
create policy chats_insert on public.chats for insert to authenticated with check (user_id = auth.uid() and public.is_member(workspace_id));
create policy chats_update on public.chats for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(workspace_id));
create policy chats_delete on public.chats for delete to authenticated using (user_id = auth.uid());

create policy chat_turns_select on public.chat_turns for select to authenticated using (user_id = auth.uid() and public.is_member(workspace_id));
create policy chat_turns_insert on public.chat_turns for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(workspace_id) and exists (select 1 from public.chats c where c.id = chat_turns.chat_id and c.user_id = auth.uid() and c.workspace_id = chat_turns.workspace_id));
create policy chat_turns_update on public.chat_turns for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_member(workspace_id) and exists (select 1 from public.chats c where c.id = chat_turns.chat_id and c.user_id = auth.uid() and c.workspace_id = chat_turns.workspace_id));
create policy chat_turns_delete on public.chat_turns for delete to authenticated using (user_id = auth.uid());

create policy settings_select on public.settings for select to authenticated
  using (public.is_member(workspace_id) and (case when scope = 'user' then user_id = auth.uid() else true end));
create policy settings_insert on public.settings for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(workspace_id) and (scope = 'user' or public.is_admin(workspace_id)));
create policy settings_update on public.settings for update to authenticated
  using (case when scope = 'user' then user_id = auth.uid() else public.is_admin(workspace_id) end)
  with check (public.is_member(workspace_id) and (case when scope = 'user' then user_id = auth.uid() else public.is_admin(workspace_id) end));
create policy settings_delete on public.settings for delete to authenticated
  using (case when scope = 'user' then user_id = auth.uid() else public.is_admin(workspace_id) end);

-- ---------------------------------------------------------------------------------------------------------------
-- P1-6. Attachment objects in Storage. Before this, every member could list, download, overwrite and delete every
-- object under the workspace folder, including attachments on private notes and chats. Now an object is readable by
-- the person who uploaded it, by the owner of its public.attachments row, or by anyone who can read the note the row
-- points at (note_readable, the same rule 0013 uses for the rows). Overwrite and delete are for the uploader or the
-- row owner. Upload keeps the workspace folder check, since the app uploads the object before it writes the row.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.attachment_object_readable(object_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.attachments a
    where a.bucket = 'attachments' and a.object_path = attachment_object_readable.object_name and a.deleted_at is null
      and (a.user_id = auth.uid() or (a.note_id is not null and public.note_readable(a.note_id)))
  );
$$;
create or replace function public.attachment_object_owned(object_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.attachments a where a.bucket = 'attachments' and a.object_path = attachment_object_owned.object_name and a.user_id = auth.uid());
$$;
revoke all on function public.attachment_object_readable(text) from public, anon;
revoke all on function public.attachment_object_owned(text) from public, anon;
grant execute on function public.attachment_object_readable(text) to authenticated, service_role;
grant execute on function public.attachment_object_owned(text) to authenticated, service_role;

drop policy if exists attachments_objects_select on storage.objects;
drop policy if exists attachments_objects_update on storage.objects;
drop policy if exists attachments_objects_delete on storage.objects;
create policy attachments_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and public.is_member(public.object_workspace(name))
         and (coalesce(owner_id, owner::text) = auth.uid()::text or public.attachment_object_readable(name)));
create policy attachments_objects_update on storage.objects for update to authenticated
  using (bucket_id = 'attachments' and public.is_member(public.object_workspace(name))
         and (coalesce(owner_id, owner::text) = auth.uid()::text or public.attachment_object_owned(name)));
create policy attachments_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and public.is_member(public.object_workspace(name))
         and (coalesce(owner_id, owner::text) = auth.uid()::text or public.attachment_object_owned(name)));

-- ---------------------------------------------------------------------------------------------------------------
-- P0-2 (database part). Zoom events are now delivered by host as well as by account (relay/connect.js). A Zoom
-- account row has to carry the Zoom user id the relay verified, and the pending-events lookup by host has an index.
-- The constraint is NOT VALID so rows saved before this migration stay; new and changed rows are checked.
-- ---------------------------------------------------------------------------------------------------------------
alter table public.connect_accounts drop constraint if exists connect_accounts_zoom_user;
alter table public.connect_accounts add constraint connect_accounts_zoom_user check (provider <> 'zoom' or external_user_id is not null) not valid;
create index if not exists connect_events_pending_host on public.connect_events (provider, account_id, (payload -> 'object' ->> 'host_id')) where delivered_at is null;
