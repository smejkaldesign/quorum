-- The Guardrails flags (migration 0040): both rows seeded, guardrails on, guardrails-custom off and needing guardrails,
-- and the public view the relay serves lists both. Needs a database with every migration applied (supabase db reset on
-- a local stack). Runs in one transaction that is rolled back:
--   docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/guardrails_flags.sql
-- A failed check stops the script with the check's message; the last line printed on success is "guardrails flags: ok".
begin;

do $$
begin
  if not exists (select 1 from public.feature_flags where key = 'guardrails' and enabled and requires is null) then
    raise exception 'guardrails should be seeded on with no parent';
  end if;
  if not exists (select 1 from public.feature_flags where key = 'guardrails-custom' and not enabled and requires = 'guardrails') then
    raise exception 'guardrails-custom should be seeded off and need guardrails';
  end if;
  if (select count(*) from public.public_flags() f where f.key in ('guardrails', 'guardrails-custom')) <> 2 then
    raise exception 'the public flags should list both guardrails flags';
  end if;
end $$;

select 'guardrails flags: ok';
rollback;
