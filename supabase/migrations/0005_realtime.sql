-- Quorum hosted edition, step 5: live pull. The app subscribes to postgres_changes on notes and meetings for its
-- workspace (app/ee/sync.js live()). Realtime streams only the tables in the supabase_realtime publication, so both
-- join it here; without this the channel subscribes and no event ever arrives. The subscription filter and the RLS
-- check read workspace_id from the new row, which every insert and update carries, and deletes are soft (updates
-- to deleted_at), so the default replica identity (primary key) is enough and replica identity full stays off.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notes') then
    alter publication supabase_realtime add table public.notes;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'meetings') then
    alter publication supabase_realtime add table public.meetings;
  end if;
end $$;
