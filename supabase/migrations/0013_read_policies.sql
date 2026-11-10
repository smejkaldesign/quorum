-- applied-when: select pg_get_expr(polqual, polrelid) like '%note_included%' from pg_policy where polname = 'meetings_select'
-- The review queue (0012) gates notes; this closes the side doors. A meeting, its transcript segments, its note's links
-- and attachments are readable by another member only when the meeting's note is public and included, by an admin
-- while it is pending, and always by their owner.
create or replace function public.note_readable(note_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.notes n where n.id = note_readable.note_id and n.deleted_at is null and (
      n.user_id = auth.uid()
      or (public.is_member(n.workspace_id) and coalesce(n.frontmatter ->> 'visibility', 'private') = 'public' and public.note_included(n.id))
      or (public.is_admin(n.workspace_id) and public.note_pending(n.id))
    )
  );
$$;
revoke all on function public.note_readable(public.ulid) from public, anon;
grant execute on function public.note_readable(public.ulid) to authenticated, service_role;

drop policy if exists meetings_select on public.meetings;
create policy meetings_select on public.meetings for select to authenticated
  using (user_id = auth.uid() or (visibility = 'public' and note_id is not null and public.note_readable(note_id)));

drop policy if exists transcript_segments_select on public.transcript_segments;
create policy transcript_segments_select on public.transcript_segments for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.meetings m where m.id = transcript_segments.meeting_id and m.visibility = 'public' and m.note_id is not null and public.note_readable(m.note_id)));

drop policy if exists links_select on public.links;
create policy links_select on public.links for select to authenticated
  using (user_id = auth.uid() or public.note_readable(from_note));

drop policy if exists attachments_select on public.attachments;
create policy attachments_select on public.attachments for select to authenticated
  using (user_id = auth.uid() or (note_id is not null and public.note_readable(note_id)));
