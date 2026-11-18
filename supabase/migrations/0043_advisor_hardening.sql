-- applied-when: select exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'team_members_team_id_workspace_id_fk_idx') and not has_function_privilege('anon', 'public.is_member(public.ulid)', 'execute') and exists (select 1 from pg_proc where oid = 'public.set_updated_at()'::regprocedure and proconfig @> array['search_path=""'])
-- Fixes from the Supabase security and performance advisors. Nothing here changes what a signed-in user can read or
-- write: grants are removed only where no client calls the function, policies keep their exact logic, and the new
-- indexes only cover foreign keys.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Security definer functions that no client calls. Postgres grants EXECUTE to PUBLIC on every new function and
-- Supabase also grants it to anon and authenticated, so each one was callable through /rest/v1/rpc.
--
-- Trigger functions. A trigger fires without any EXECUTE check on its function, so the grant only exposed the
-- function to RPC. rls_auto_enable exists only on the hosted project (created from the dashboard), hence the guard.
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public.add_workspace_owner() from public, anon, authenticated;
revoke all on function public.auth_user_gate() from public, anon, authenticated;
revoke all on function public.sync_profile() from public, anon, authenticated;
revoke all on function public.kb_note_upstream_follow() from public, anon, authenticated;
revoke all on function public.workspace_connector_clear_overrides() from public, anon, authenticated;
revoke all on function public.workspace_connector_drop_secret() from public, anon, authenticated;
revoke all on function public.invites_daily_limit() from public, anon, authenticated;
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;

-- Internal helpers. Each is called only from inside other security definer functions, which run as the function
-- owner, so the caller's role never needs EXECUTE. None is used by a policy, a view or a security invoker function.
revoke all on function public.kb_is_hosted(public.ulid) from public, anon, authenticated;
revoke all on function public.is_public_mail_domain(text) from public, anon, authenticated;
revoke all on function public.platform_passkey_ok() from public, anon, authenticated;
revoke all on function public.platform_issue_access_code(text, text, integer, text) from public, anon, authenticated;
-- Kept for authenticated although no client calls them: kb_shape and team_shape check can_read_kb or is_member
-- themselves, and can_edit_kb and can_manage_team only answer for the caller, like can_read_kb and can_admin_kb that
-- policies use. The SQL tests read all four as a signed-in user.
-- No client calls platform_access_codes. It already checks is_platform_owner, so this only narrows what can be called.
revoke all on function public.platform_access_codes() from public, anon, authenticated;

grant execute on function public.add_workspace_owner() to service_role;
grant execute on function public.auth_user_gate() to service_role;
grant execute on function public.sync_profile() to service_role;
grant execute on function public.kb_note_upstream_follow() to service_role;
grant execute on function public.workspace_connector_clear_overrides() to service_role;
grant execute on function public.workspace_connector_drop_secret() to service_role;
grant execute on function public.invites_daily_limit() to service_role;
grant execute on function public.kb_is_hosted(public.ulid) to service_role;
grant execute on function public.is_public_mail_domain(text) to service_role;
grant execute on function public.platform_passkey_ok() to service_role;
grant execute on function public.platform_issue_access_code(text, text, integer, text) to service_role;
grant execute on function public.platform_access_codes() to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Security definer functions that signed-in users call or that policies call, but anon never does. Every policy
-- that uses these is for authenticated only, so anon never evaluates them. authenticated keeps EXECUTE: policy
-- expressions run as the querying role.
-- Kept for anon on purpose: access_code_needed and access_code_claim (the sign-in screen calls them before there is a
-- session) and public_flags (the relay reads it with the anon key).
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public.is_member(public.ulid) from public, anon;
revoke all on function public.is_admin(public.ulid) from public, anon;
revoke all on function public.is_owner(public.ulid) from public, anon;
revoke all on function public.shares_workspace(uuid) from public, anon;
revoke all on function public.workspace_guardrails_set(public.ulid, jsonb) from public, anon;
revoke all on function public.platform_revoke_access_code(public.ulid) from public, anon;
grant execute on function public.is_member(public.ulid) to authenticated, service_role;
grant execute on function public.is_admin(public.ulid) to authenticated, service_role;
grant execute on function public.is_owner(public.ulid) to authenticated, service_role;
grant execute on function public.shares_workspace(uuid) to authenticated, service_role;
grant execute on function public.workspace_guardrails_set(public.ulid, jsonb) to authenticated, service_role;
grant execute on function public.platform_revoke_access_code(public.ulid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Fixed search_path on the five functions that had none. Their bodies use only pg_catalog functions and operators
-- or names that are already schema-qualified, so an empty search_path changes nothing they resolve.
-- ---------------------------------------------------------------------------------------------------------------
alter function public.set_updated_at() set search_path = '';
alter function public.object_workspace(text) set search_path = '';
alter function public.connector_roles(text) set search_path = '';
alter function public.workspace_connector_public(public.workspace_connectors) set search_path = '';
alter function public.gen_access_code() set search_path = '';

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Policies that called auth.uid() or auth.email() once per row. Wrapping the call in a scalar subquery lets
-- Postgres evaluate it once per statement. Each policy is recreated with the same command, roles, USING and WITH
-- CHECK; the only change is auth.<fn>() becoming (select auth.<fn>()).
-- ---------------------------------------------------------------------------------------------------------------
drop policy if exists attachments_objects_delete on storage.objects;
create policy attachments_objects_delete on storage.objects for delete to authenticated
  using ((bucket_id = 'attachments'::text) and public.is_member(public.object_workspace(name)) and ((coalesce(owner_id, (owner)::text) = ((select auth.uid()))::text) or public.attachment_object_owned(name)));
drop policy if exists attachments_objects_select on storage.objects;
create policy attachments_objects_select on storage.objects for select to authenticated
  using ((bucket_id = 'attachments'::text) and public.is_member(public.object_workspace(name)) and ((coalesce(owner_id, (owner)::text) = ((select auth.uid()))::text) or public.attachment_object_readable(name)));
drop policy if exists attachments_objects_update on storage.objects;
create policy attachments_objects_update on storage.objects for update to authenticated
  using ((bucket_id = 'attachments'::text) and public.is_member(public.object_workspace(name)) and ((coalesce(owner_id, (owner)::text) = ((select auth.uid()))::text) or public.attachment_object_owned(name)));
drop policy if exists attachments_insert on public.attachments;
create policy attachments_insert on public.attachments for insert to authenticated
  with check (public.is_member(workspace_id) and (user_id = (select auth.uid())));
drop policy if exists attachments_select on public.attachments;
create policy attachments_select on public.attachments for select to authenticated
  using ((user_id = (select auth.uid())) or ((note_id is not null) and public.note_readable(note_id)));
drop policy if exists chat_turns_delete on public.chat_turns;
create policy chat_turns_delete on public.chat_turns for delete to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists chat_turns_insert on public.chat_turns;
create policy chat_turns_insert on public.chat_turns for insert to authenticated
  with check ((user_id = (select auth.uid())) and public.is_member(workspace_id) and (exists (select 1 from public.chats c where (((c.id)::text = (chat_turns.chat_id)::text) and (c.user_id = (select auth.uid())) and ((c.workspace_id)::text = (chat_turns.workspace_id)::text)))));
drop policy if exists chat_turns_select on public.chat_turns;
create policy chat_turns_select on public.chat_turns for select to authenticated
  using ((user_id = (select auth.uid())) and public.is_member(workspace_id));
drop policy if exists chat_turns_update on public.chat_turns;
create policy chat_turns_update on public.chat_turns for update to authenticated
  using (user_id = (select auth.uid()))
  with check ((user_id = (select auth.uid())) and public.is_member(workspace_id) and (exists (select 1 from public.chats c where (((c.id)::text = (chat_turns.chat_id)::text) and (c.user_id = (select auth.uid())) and ((c.workspace_id)::text = (chat_turns.workspace_id)::text)))));
drop policy if exists chats_delete on public.chats;
create policy chats_delete on public.chats for delete to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists chats_insert on public.chats;
create policy chats_insert on public.chats for insert to authenticated
  with check ((user_id = (select auth.uid())) and public.is_member(workspace_id));
drop policy if exists chats_select on public.chats;
create policy chats_select on public.chats for select to authenticated
  using ((user_id = (select auth.uid())) and public.is_member(workspace_id));
drop policy if exists chats_update on public.chats;
create policy chats_update on public.chats for update to authenticated
  using (user_id = (select auth.uid()))
  with check ((user_id = (select auth.uid())) and public.is_member(workspace_id));
drop policy if exists connect_accounts_own on public.connect_accounts;
create policy connect_accounts_own on public.connect_accounts for select to public
  using (user_id = (select auth.uid()));
drop policy if exists contributions_select on public.contributions;
create policy contributions_select on public.contributions for select to authenticated
  using ((author_id = (select auth.uid())) or public.is_admin(workspace_id));
drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites for insert to authenticated
  with check (public.is_admin(workspace_id) and (user_id = (select auth.uid())));
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select to authenticated
  using (public.is_member(workspace_id) or (email = lower(coalesce((select auth.email()), ''::text))));
drop policy if exists kb_access_select on public.kb_access;
create policy kb_access_select on public.kb_access for select to authenticated
  using ((user_id = (select auth.uid())) or public.can_admin_kb(kb_id));
drop policy if exists kb_resync_select on public.kb_resync;
create policy kb_resync_select on public.kb_resync for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists links_insert on public.links;
create policy links_insert on public.links for insert to authenticated
  with check (public.is_member(workspace_id) and (user_id = (select auth.uid())));
drop policy if exists links_select on public.links;
create policy links_select on public.links for select to authenticated
  using ((user_id = (select auth.uid())) or public.note_readable(from_note));
drop policy if exists meetings_insert on public.meetings;
create policy meetings_insert on public.meetings for insert to authenticated
  with check (public.is_member(workspace_id) and (user_id = (select auth.uid())));
drop policy if exists meetings_select on public.meetings;
create policy meetings_select on public.meetings for select to authenticated
  using ((user_id = (select auth.uid())) or ((visibility = 'public'::text) and (note_id is not null) and public.note_readable(note_id)));
drop policy if exists member_integrations_select on public.member_integrations;
create policy member_integrations_select on public.member_integrations for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists notes_delete on public.notes;
create policy notes_delete on public.notes for delete to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists notes_insert on public.notes;
create policy notes_insert on public.notes for insert to authenticated
  with check (public.is_member(workspace_id) and (user_id = (select auth.uid())));
drop policy if exists notes_select on public.notes;
create policy notes_select on public.notes for select to authenticated
  using ((user_id = (select auth.uid())) or ((kb_id is not null) and public.can_read_kb(kb_id)) or ((kb_id is null) and public.is_member(workspace_id) and (coalesce((frontmatter ->> 'visibility'::text), 'private'::text) = 'public'::text) and public.note_included(id)) or (public.is_admin(workspace_id) and public.note_pending(id)));
drop policy if exists notes_update on public.notes;
create policy notes_update on public.notes for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
drop policy if exists settings_delete on public.settings;
create policy settings_delete on public.settings for delete to authenticated
  using ( case when (scope = 'user'::text) then (user_id = (select auth.uid())) else public.is_admin(workspace_id) end);
drop policy if exists settings_insert on public.settings;
create policy settings_insert on public.settings for insert to authenticated
  with check ((user_id = (select auth.uid())) and public.is_member(workspace_id) and ((scope = 'user'::text) or public.is_admin(workspace_id)));
drop policy if exists settings_select on public.settings;
create policy settings_select on public.settings for select to authenticated
  using (public.is_member(workspace_id) and case when (scope = 'user'::text) then (user_id = (select auth.uid())) else true end);
drop policy if exists settings_update on public.settings;
create policy settings_update on public.settings for update to authenticated
  using ( case when (scope = 'user'::text) then (user_id = (select auth.uid())) else public.is_admin(workspace_id) end)
  with check (public.is_member(workspace_id) and case when (scope = 'user'::text) then (user_id = (select auth.uid())) else public.is_admin(workspace_id) end);
drop policy if exists transcript_segments_insert on public.transcript_segments;
create policy transcript_segments_insert on public.transcript_segments for insert to authenticated
  with check (public.is_member(workspace_id) and (user_id = (select auth.uid())));
drop policy if exists transcript_segments_select on public.transcript_segments;
create policy transcript_segments_select on public.transcript_segments for select to authenticated
  using ((user_id = (select auth.uid())) or (exists (select 1 from public.meetings m where (((m.id)::text = (transcript_segments.meeting_id)::text) and (m.visibility = 'public'::text) and (m.note_id is not null) and public.note_readable(m.note_id)))));
drop policy if exists workspaces_insert on public.workspaces;
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Indexes for foreign keys that had no covering index. They speed up the joins and filters on these columns and
-- the cascades when a parent row (a user, a workspace, a note) is deleted. Unused indexes the advisor lists are kept.
-- ---------------------------------------------------------------------------------------------------------------
create index if not exists workspaces_user_id_fk_idx on public.workspaces (user_id);
create index if not exists members_user_id_fk_idx on public.members (user_id);
create index if not exists notes_created_by_fk_idx on public.notes (created_by);
create index if not exists notes_edited_by_fk_idx on public.notes (edited_by);
create index if not exists notes_folder_id_fk_idx on public.notes (folder_id);
create index if not exists notes_user_id_fk_idx on public.notes (user_id);
create index if not exists links_user_id_fk_idx on public.links (user_id);
create index if not exists links_workspace_id_fk_idx on public.links (workspace_id);
create index if not exists meetings_note_id_fk_idx on public.meetings (note_id);
create index if not exists meetings_user_id_fk_idx on public.meetings (user_id);
create index if not exists transcript_segments_user_id_fk_idx on public.transcript_segments (user_id);
create index if not exists transcript_segments_workspace_id_fk_idx on public.transcript_segments (workspace_id);
create index if not exists chats_meeting_id_fk_idx on public.chats (meeting_id);
create index if not exists chats_note_id_fk_idx on public.chats (note_id);
create index if not exists chats_user_id_fk_idx on public.chats (user_id);
create index if not exists chat_turns_user_id_fk_idx on public.chat_turns (user_id);
create index if not exists settings_user_id_fk_idx on public.settings (user_id);
create index if not exists attachments_chat_id_fk_idx on public.attachments (chat_id);
create index if not exists attachments_note_id_fk_idx on public.attachments (note_id);
create index if not exists attachments_user_id_fk_idx on public.attachments (user_id);
create index if not exists attachments_workspace_id_fk_idx on public.attachments (workspace_id);
create index if not exists invites_user_id_fk_idx on public.invites (user_id);
create index if not exists workspace_connectors_created_by_fk_idx on public.workspace_connectors (created_by);
create index if not exists workspace_usage_events_connector_id_fk_idx on public.workspace_usage_events (connector_id);
create index if not exists workspace_usage_events_meeting_id_fk_idx on public.workspace_usage_events (meeting_id);
create index if not exists workspace_usage_events_user_id_fk_idx on public.workspace_usage_events (user_id);
create index if not exists platform_audit_actor_fk_idx on public.platform_audit (actor);
create index if not exists platform_audit_target_workspace_fk_idx on public.platform_audit (target_workspace);
create index if not exists access_codes_granted_workspace_id_fk_idx on public.access_codes (granted_workspace_id);
create index if not exists access_codes_issued_by_fk_idx on public.access_codes (issued_by);
create index if not exists access_codes_redeemed_by_fk_idx on public.access_codes (redeemed_by);
create index if not exists contributions_author_id_fk_idx on public.contributions (author_id);
create index if not exists contributions_reviewed_by_fk_idx on public.contributions (reviewed_by);
create index if not exists access_requests_code_id_fk_idx on public.access_requests (code_id);
create index if not exists access_requests_decided_by_fk_idx on public.access_requests (decided_by);
create index if not exists access_requests_user_id_fk_idx on public.access_requests (user_id);
create index if not exists feature_flags_requires_fk_idx on public.feature_flags (requires);
create index if not exists knowledge_bases_created_by_fk_idx on public.knowledge_bases (created_by);
create index if not exists knowledge_bases_team_id_workspace_id_fk_idx on public.knowledge_bases (team_id, workspace_id);
create index if not exists kb_access_created_by_fk_idx on public.kb_access (created_by);
create index if not exists kb_folders_created_by_fk_idx on public.kb_folders (created_by);
create index if not exists kb_folders_parent_id_fk_idx on public.kb_folders (parent_id);
create index if not exists kb_note_search_kb_id_fk_idx on public.kb_note_search (kb_id);
create index if not exists kb_note_search_workspace_id_fk_idx on public.kb_note_search (workspace_id);
create index if not exists workspace_integrations_created_by_fk_idx on public.workspace_integrations (created_by);
create index if not exists kb_note_upstream_workspace_id_fk_idx on public.kb_note_upstream (workspace_id);
create index if not exists kb_sync_grants_integration_id_fk_idx on public.kb_sync_grants (integration_id);
create index if not exists kb_sync_grants_user_id_fk_idx on public.kb_sync_grants (user_id);
create index if not exists kb_attachments_attached_by_fk_idx on public.kb_attachments (attached_by);
create index if not exists kb_attachments_folder_id_fk_idx on public.kb_attachments (folder_id);
create index if not exists kb_attachments_integration_id_fk_idx on public.kb_attachments (integration_id);
create index if not exists kb_attachments_workspace_id_fk_idx on public.kb_attachments (workspace_id);
create index if not exists kb_files_created_by_fk_idx on public.kb_files (created_by);
create index if not exists teams_created_by_fk_idx on public.teams (created_by);
create index if not exists team_members_team_id_workspace_id_fk_idx on public.team_members (team_id, workspace_id);
create index if not exists kb_resync_user_id_fk_idx on public.kb_resync (user_id);
