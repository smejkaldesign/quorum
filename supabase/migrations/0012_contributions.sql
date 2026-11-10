-- applied-when: select exists(select 1 from pg_tables where schemaname = 'public' and tablename = 'contributions')
-- Company knowledge review queue (docs/specs/team-knowledge.md). A note a member marks public becomes a contribution:
-- pending in the admin queue, or included at once when the workspace has auto_include on. Only included public notes
-- reach other members; a member's own rows always do. Admins see pending notes so they can review them.

alter table public.workspaces add column auto_include boolean not null default false;

create table public.contributions (
  id public.ulid primary key default public.gen_ulid(),
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  note_id public.ulid not null references public.notes (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'included', 'declined', 'withdrawn')),
  guard_result jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index contributions_note on public.contributions (note_id);
create index contributions_queue on public.contributions (workspace_id, status, created_at);
create trigger contributions_updated_at before update on public.contributions for each row execute function public.set_updated_at();
alter table public.contributions enable row level security;
create policy contributions_select on public.contributions for select to authenticated using (author_id = auth.uid() or public.is_admin(workspace_id));
-- inserts and status changes go through the trigger and the RPCs below

-- a note's visibility is frontmatter; public opens a contribution (included at once with auto_include), private withdraws it
create or replace function public.note_contribution_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare pub boolean := coalesce(new.frontmatter ->> 'visibility', 'private') = 'public' and new.deleted_at is null;
        conf boolean := coalesce(new.frontmatter ->> 'confidential', '') <> '';
        auto boolean;
begin
  if pub and not conf then
    select w.auto_include into auto from public.workspaces w where w.id = new.workspace_id;
    insert into public.contributions (workspace_id, note_id, author_id, status, reviewed_at)
      values (new.workspace_id, new.id, new.user_id, case when auto then 'included' else 'pending' end, case when auto then now() else null end)
    on conflict (note_id) do update set status = case when contributions.status in ('included', 'declined') then contributions.status when excluded.status = 'included' then 'included' else 'pending' end,
                                       reviewed_at = case when contributions.status in ('included', 'declined') then contributions.reviewed_at else excluded.reviewed_at end
      where contributions.status = 'withdrawn' or contributions.status = 'pending';
  else
    update public.contributions c set status = 'withdrawn' where c.note_id = new.id and c.status <> 'withdrawn';
  end if;
  return new;
end $$;
create trigger notes_contribution after insert or update of frontmatter, deleted_at on public.notes for each row execute function public.note_contribution_sync();

create or replace function public.note_included(note_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.contributions c where c.note_id = note_included.note_id and c.status = 'included');
$$;
create or replace function public.note_pending(note_id public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.contributions c where c.note_id = note_pending.note_id and c.status = 'pending');
$$;

-- what members read: their own rows; other members' notes only when public and included; admins also see pending ones
drop policy if exists notes_select on public.notes;
create policy notes_select on public.notes for select to authenticated using (
  user_id = auth.uid()
  or (public.is_member(workspace_id) and coalesce(frontmatter ->> 'visibility', 'private') = 'public' and public.note_included(id))
  or (public.is_admin(workspace_id) and public.note_pending(id))
);
drop policy if exists meetings_select on public.meetings;
create policy meetings_select on public.meetings for select to authenticated using (user_id = auth.uid() or (public.is_member(workspace_id) and visibility = 'public'));
drop policy if exists notes_update on public.notes;
create policy notes_update on public.notes for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists notes_delete on public.notes;
create policy notes_delete on public.notes for delete to authenticated using (user_id = auth.uid());

-- the admin queue: pending contributions with the note's title, path and author
create or replace function public.review_queue(workspace_id public.ulid)
returns table (id public.ulid, note_id public.ulid, path text, title text, author_email text, author_name text, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin(review_queue.workspace_id) then raise exception 'Only owners and admins can review contributions'; end if;
  return query select c.id, c.note_id, n.path, coalesce(n.frontmatter ->> 'title', regexp_replace(n.path, '^.*/|\.md$', '', 'g')), p.email, p.name, c.created_at, n.updated_at
    from public.contributions c join public.notes n on n.id = c.note_id left join public.profiles p on p.user_id = c.author_id
    where c.workspace_id = review_queue.workspace_id and c.status = 'pending' and n.deleted_at is null
    order by c.created_at;
end $$;

create or replace function public.review_contribution(id public.ulid, decision text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.contributions;
begin
  select * into c from public.contributions x where x.id = review_contribution.id;
  if c is null then raise exception 'That contribution no longer exists'; end if;
  if not public.is_admin(c.workspace_id) then raise exception 'Only owners and admins can review contributions'; end if;
  if review_contribution.decision not in ('include', 'decline') then raise exception 'A decision is include or decline'; end if;
  if c.status <> 'pending' then raise exception 'That contribution was already reviewed'; end if;
  update public.contributions x set status = case when review_contribution.decision = 'include' then 'included' else 'declined' end, reviewed_by = auth.uid(), reviewed_at = now()
    where x.id = review_contribution.id returning * into c;
  -- an included note has to reach other members' pulls, which read updated_at
  update public.notes n set updated_at = now() where n.id = c.note_id;
  return jsonb_build_object('id', c.id, 'status', c.status, 'reviewed_at', c.reviewed_at);
end $$;

create or replace function public.workspace_auto_include_set(workspace_id public.ulid, on_ boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin(workspace_auto_include_set.workspace_id) then raise exception 'Only owners and admins can change this'; end if;
  update public.workspaces w set auto_include = coalesce(workspace_auto_include_set.on_, false) where w.id = workspace_auto_include_set.workspace_id;
  return coalesce(workspace_auto_include_set.on_, false);
end $$;

-- a member's own contributions, so the app can say pending, included or declined next to the note
create or replace function public.my_contributions(workspace_id public.ulid)
returns table (note_id public.ulid, path text, status text, reviewed_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.note_id, n.path, c.status, c.reviewed_at, c.created_at
  from public.contributions c join public.notes n on n.id = c.note_id
  where c.workspace_id = my_contributions.workspace_id and c.author_id = auth.uid() and c.status <> 'withdrawn' and public.is_member(my_contributions.workspace_id)
  order by c.created_at desc;
$$;

do $$ declare f text; begin
  foreach f in array array['review_queue(public.ulid)', 'review_contribution(public.ulid, text)', 'workspace_auto_include_set(public.ulid, boolean)', 'my_contributions(public.ulid)', 'note_included(public.ulid)', 'note_pending(public.ulid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
