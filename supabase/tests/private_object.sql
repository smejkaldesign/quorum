-- A reusable check that a private object stays private: each viewer (typically the workspace owner and a workspace
-- admin, who read most things) runs every probe as themselves, and each probe must give them nothing. Load it once
-- per session, after begin and before the test that calls it:
--   { echo 'begin;'; cat supabase/tests/private_object.sql; grep -v '^begin;$' supabase/tests/<test>.sql; } | docker exec -i supabase_db_quorum psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- Then, in the test, while the object exists:
--   select pg_temp.assert_private(array['<owner uuid>', '<admin uuid>']::uuid[], jsonb_build_array(
--     jsonb_build_object('what', 'read the row', 'sql', format('select 1 from public.<table> where id = %L', <id>)),
--     jsonb_build_object('what', 'rename it', 'sql', format('select public.<rename rpc>(%L, ''x'')', <id>), 'expect', 'error', 'pattern', 'no longer exists'),
--     jsonb_build_object('what', 'reuse its name', 'sql', '<a statement that must succeed>', 'expect', 'ok')));
-- A probe's expect is one of:
--   none   (the default) the statement returns or changes no row, or is refused for permission: reads, lists,
--          searches, and table writes that row level security must hide
--   error  the statement raises an error matching pattern: an RPC that must answer as if the object did not exist
--   ok     the statement runs: a step whose refusal would let the viewer infer the object, such as taking its name
-- Every probe runs in its own subtransaction that is rolled back, so probes change nothing, and the session returns
-- to the postgres role afterwards. A failure names the viewer and the probe.
create function pg_temp.assert_private(viewers uuid[], probes jsonb) returns void language plpgsql as $$
declare v uuid; p jsonb; n bigint; err text; mode text;
begin
  foreach v in array viewers loop
    perform set_config('request.jwt.claims', json_build_object('sub', v::text, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);
    for p in select * from jsonb_array_elements(probes) loop
      err := null; n := null; mode := coalesce(p ->> 'expect', 'none');
      begin
        -- a read counts the rows it returns; a write counts the rows it changed
        if mode = 'none' and (p ->> 'sql') ~* '^\s*(select|with)\s' then execute format('select count(*) from (%s) q', p ->> 'sql') into n;
        else execute p ->> 'sql'; get diagnostics n = row_count;
        end if;
        raise exception 'private_probe_done';
      exception when others then
        if sqlerrm <> 'private_probe_done' then err := sqlerrm; end if;
      end;
      if mode = 'none' and not ((err is null and n = 0) or coalesce(err ~* 'permission denied', false)) then
        raise exception 'private: % could %: %', v, p ->> 'what', coalesce(err, n || ' rows');
      elsif mode = 'error' and (err is null or err !~* (p ->> 'pattern')) then
        raise exception 'private: % could %: expected an error like "%", got %', v, p ->> 'what', p ->> 'pattern', coalesce(err, 'none');
      elsif mode = 'ok' and err is not null then
        raise exception 'private: % could not %, which tells them something: %', v, p ->> 'what', err;
      end if;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', '', true), set_config('role', 'postgres', true);
end $$;
