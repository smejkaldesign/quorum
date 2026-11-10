-- applied-when: select exists(select 1 from pg_tables where schemaname = 'public' and tablename = 'connect_events')
-- Platform connections (Zoom first, relay/connect.js): which platform accounts belong to a user, and the events the
-- platform sends the relay (recording.completed) until that user's app has fetched and acknowledged them. Only the
-- relay writes either table with the service role; a member can read their own account rows.
create table if not exists public.connect_accounts (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('zoom', 'google', 'microsoft')),
  account_id text not null,
  external_user_id text,
  created_at timestamptz not null default now(),
  primary key (provider, account_id, user_id)
);
create index if not exists connect_accounts_user on public.connect_accounts (user_id);
alter table public.connect_accounts enable row level security;
drop policy if exists connect_accounts_own on public.connect_accounts;
create policy connect_accounts_own on public.connect_accounts for select using (user_id = auth.uid());

create table if not exists public.connect_events (
  id bigserial primary key,
  provider text not null,
  account_id text not null,
  event text not null,
  external_id text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  delivered_at timestamptz
);
-- the platform retries a delivery it did not get a 2xx for; the same recording lands once
create unique index if not exists connect_events_once on public.connect_events (provider, event, external_id) where external_id is not null;
create index if not exists connect_events_pending on public.connect_events (provider, account_id) where delivered_at is null;
alter table public.connect_events enable row level security;
