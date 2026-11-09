-- Quorum hosted edition, step 4: pull sync. Clients ask each table for rows with updated_at after their last pull,
-- soft-deleted rows included, so meetings gets the same (workspace_id, updated_at) index notes and chats already have.
create index if not exists meetings_workspace_updated on public.meetings (workspace_id, updated_at);
create index if not exists chat_turns_workspace_updated on public.chat_turns (workspace_id, updated_at);

-- attachments: a private bucket, one folder per workspace (<workspace ulid>/<attachment ulid>/<file name>). The
-- metadata row is public.attachments; members of the workspace read and write the objects under its folder.
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 26214400)
on conflict (id) do nothing;

create or replace function public.object_workspace(name text) returns public.ulid
language sql immutable as $$
  select case when split_part(name, '/', 1) ~ '^[0-9A-HJKMNP-TV-Z]{26}$' then split_part(name, '/', 1)::public.ulid else null end;
$$;

create policy attachments_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and public.is_member(public.object_workspace(name)));
create policy attachments_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and public.is_member(public.object_workspace(name)));
create policy attachments_objects_update on storage.objects for update to authenticated
  using (bucket_id = 'attachments' and public.is_member(public.object_workspace(name)));
create policy attachments_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and public.is_member(public.object_workspace(name)));
