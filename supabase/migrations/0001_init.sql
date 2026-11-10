-- Quorum hosted edition, first schema (docs/backend-plan.md). Local-first ids: every primary key is a ULID the
-- client already made, so a row keeps its id when it syncs. Nothing here is readable without a session.

-- Crockford base32, 26 characters, as text so Postgres never has to parse it
create domain public.ulid as text check (value ~ '^[0-9A-HJKMNP-TV-Z]{26}$');

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- workspaces: the unit of sharing and billing. workspace_id mirrors id so every table carries the same five columns
create table public.workspaces (
  id public.ulid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id public.ulid generated always as (id) stored,
  name text not null default 'My workspace',
  plan text not null default 'free' check (plan in ('free', 'paid')),
  seats integer not null default 1 check (seats >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.members (
  id public.ulid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (workspace_id, user_id)
);

-- security definer so the policies below can ask about membership without recursing into members' own policy
create or replace function public.is_member(ws public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m where m.workspace_id = ws and m.user_id = auth.uid() and m.deleted_at is null);
$$;

create or replace function public.is_owner(ws public.ulid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m where m.workspace_id = ws and m.user_id = auth.uid() and m.role = 'owner' and m.deleted_at is null);
$$;

-- whoever creates a workspace is its first owner
create or replace function public.add_workspace_owner() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.members (id, user_id, workspace_id, role) values (new.id, new.user_id, new.id, 'owner');
  return new;
end $$;
create trigger workspaces_owner after insert on public.workspaces for each row execute function public.add_workspace_owner();

-- notes: one row per markdown file in the vault, body kept whole; links are rebuilt server side from it
create table public.notes (
  id public.ulid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  path text not null,
  frontmatter jsonb not null default '{}'::jsonb,
  body text not null default '',
  hash text not null default '',
  mtime timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index notes_workspace_path on public.notes (workspace_id, path) where deleted_at is null;
create index notes_workspace_updated on public.notes (workspace_id, updated_at);

create table public.links (
  id public.ulid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  from_note public.ulid not null references public.notes (id) on delete cascade,
  to_note public.ulid references public.notes (id) on delete set null,
  anchor text not null,
  unresolved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index links_from on public.links (from_note);
create index links_to on public.links (to_note);

create table public.meetings (
  id public.ulid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  title text not null default '',
  started_at timestamptz,
  ended_at timestamptz,
  participants jsonb not null default '[]'::jsonb,
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  note_id public.ulid references public.notes (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index meetings_workspace_started on public.meetings (workspace_id, started_at desc);

-- retention: a scheduled job (pg_cron, added with pull sync in step 4 of the plan) deletes segments whose meeting
-- ended more than 180 days ago. Segments of meetings with visibility 'private' never reach this table; the client
-- store does not push them, so the local-only promise for private calls holds without a server rule.
create table public.transcript_segments (
  id public.ulid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  meeting_id public.ulid not null references public.meetings (id) on delete cascade,
  channel text not null check (channel in ('me', 'them')),
  t double precision not null default 0,
  text text not null,
  who text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index transcript_segments_meeting on public.transcript_segments (meeting_id, t);
comment on table public.transcript_segments is 'Retention: rows are deleted 180 days after meetings.ended_at by a scheduled job. Private meetings are never pushed here.';

create table public.chats (
  id public.ulid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  title text not null default '',
  meeting_id public.ulid references public.meetings (id) on delete set null,
  note_id public.ulid references public.notes (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index chats_workspace_updated on public.chats (workspace_id, updated_at desc);

create table public.chat_turns (
  id public.ulid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  chat_id public.ulid not null references public.chats (id) on delete cascade,
  question text not null,
  answer text not null default '',
  sources jsonb not null default '[]'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index chat_turns_chat on public.chat_turns (chat_id, created_at);

-- settings: one workspace row (stop and go words, opt-outs) and one row per user (model, profile)
create table public.settings (
  id public.ulid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  scope text not null check (scope in ('workspace', 'user')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index settings_workspace on public.settings (workspace_id) where scope = 'workspace' and deleted_at is null;
create unique index settings_user on public.settings (workspace_id, user_id) where scope = 'user' and deleted_at is null;

-- attachments live in Storage; this is the metadata row the chat or note points at
create table public.attachments (
  id public.ulid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  bucket text not null default 'attachments',
  object_path text not null,
  name text not null,
  size bigint not null default 0 check (size >= 0),
  mime text,
  chat_id public.ulid references public.chats (id) on delete set null,
  note_id public.ulid references public.notes (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- updated_at and row level security on every table
do $$
declare t text;
begin
  foreach t in array array['workspaces', 'members', 'notes', 'links', 'meetings', 'transcript_segments', 'chats', 'chat_turns', 'settings', 'attachments'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', t || '_updated_at', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- workspaces: anyone signed in can create one for themselves; members read it; owners change or delete it
create policy workspaces_select on public.workspaces for select to authenticated using (public.is_member(id));
create policy workspaces_insert on public.workspaces for insert to authenticated with check (user_id = auth.uid());
create policy workspaces_update on public.workspaces for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));
create policy workspaces_delete on public.workspaces for delete to authenticated using (public.is_owner(id));

-- members: members see who else is in; owners manage the list
create policy members_select on public.members for select to authenticated using (public.is_member(workspace_id));
create policy members_insert on public.members for insert to authenticated with check (public.is_owner(workspace_id));
create policy members_update on public.members for update to authenticated using (public.is_owner(workspace_id)) with check (public.is_owner(workspace_id));
create policy members_delete on public.members for delete to authenticated using (public.is_owner(workspace_id));

-- everything else: readable and writable by workspace members, and a row is always written as yourself
do $$
declare t text;
begin
  foreach t in array array['notes', 'links', 'meetings', 'transcript_segments', 'chats', 'chat_turns', 'settings', 'attachments'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member(workspace_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_member(workspace_id) and user_id = auth.uid())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_member(workspace_id)) with check (public.is_member(workspace_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_member(workspace_id))', t || '_delete', t);
  end loop;
end $$;
