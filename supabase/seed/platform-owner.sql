-- Grants the platform owner role (migration 0008) to one existing account. This is not a migration: run it once per
-- environment, after that account has signed in at least once so it exists in auth.users. The email comes in as a
-- psql variable, quoted as a string literal:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v email="'owner@example.com'" -f supabase/seed/platform-owner.sql
--
-- Local stack: cd app && EMAIL=owner@example.com npm run db:seed-owner (docs/self-hosting.md, Platform owner).
-- Running it again for the same email changes nothing. Revoke with: delete from public.platform_owners where user_id = ...
insert into public.platform_owners (user_id, granted_by)
select u.id, 'bootstrap' from auth.users u where lower(u.email) = lower(:email)
on conflict (user_id) do nothing;

-- what the role table holds for that email now; no row means the account has not signed in yet
select o.user_id, u.email, o.granted_by, o.created_at
from public.platform_owners o join auth.users u on u.id = o.user_id
where lower(u.email) = lower(:email);
