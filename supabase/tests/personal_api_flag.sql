-- The personal-api flag (migration 0042): seeded off with no parent, and listed by the public view the relay serves.
-- Needs a database with every migration applied (supabase db reset on a local stack). Runs in one transaction that is
-- rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/personal_api_flag.sql
-- A failed check stops the script with the check's message; the last line printed on success is "personal-api flag: ok".
begin;

do $$
begin
  if not exists (select 1 from public.feature_flags where key = 'personal-api' and not enabled and requires is null) then
    raise exception 'personal-api should be seeded off with no parent';
  end if;
  if not exists (select 1 from public.public_flags() f where f.key = 'personal-api') then
    raise exception 'the public flags should list personal-api';
  end if;
end $$;

select 'personal-api flag: ok';
rollback;
