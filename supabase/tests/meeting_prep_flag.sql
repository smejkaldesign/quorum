-- The meeting-prep flag (migration 0044): seeded off with no parent, and listed by the public view the relay serves.
-- Needs a database with every migration applied (supabase db reset on a local stack). Runs in one transaction that is
-- rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/meeting_prep_flag.sql
-- A failed check stops the script with the check's message; the last line printed on success is "meeting-prep flag: ok".
begin;

do $$
begin
  if not exists (select 1 from public.feature_flags where key = 'meeting-prep' and not enabled and requires is null) then
    raise exception 'meeting-prep should be seeded off with no parent';
  end if;
  if not exists (select 1 from public.public_flags() f where f.key = 'meeting-prep') then
    raise exception 'the public flags should list meeting-prep';
  end if;
end $$;

select 'meeting-prep flag: ok';
rollback;
