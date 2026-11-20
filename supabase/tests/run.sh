#!/usr/bin/env bash
# Runs every database test in supabase/tests against a local stack, each in its own rolled-back transaction, and exits
# non-zero when any of them fails. psql stops on the first error (ON_ERROR_STOP), but a pgTAP check that fails only
# prints "not ok" and a plan that does not add up only prints "# Looks like ...", so the output is read as well.
#   supabase/tests/run.sh                 every test
#   supabase/tests/run.sh teams.sql ...   only these
# DB_CONTAINER picks the database container (default supabase_db_quorum); PRELUDE is SQL run first inside each
# transaction, for a stack that lacks migrations the tests need.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
container=${DB_CONTAINER:-supabase_db_quorum}
prelude=${PRELUDE:-}
if [ $# -gt 0 ]; then files=("$@"); else files=("$here"/*.sql); fi
failed=0
for t in "${files[@]}"; do
  [ -f "$t" ] || t="$here/$t"
  name=$(basename "$t")
  # private_object.sql is a helper the tests that call pg_temp.assert_private load first
  [ "$name" = private_object.sql ] && continue
  out=$( {
    echo 'begin;'
    [ -n "$prelude" ] && cat "$prelude"
    grep -q assert_private "$t" && grep -v '^begin;$' "$here/private_object.sql"
    grep -v '^begin;$' "$t"
  } | docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -t -f - 2>&1 )
  code=$?
  if [ $code -ne 0 ] || grep -Eq '^[[:space:]]*not ok|ERROR:|# Looks like' <<<"$out"; then
    echo "FAIL $name (psql exit $code)"
    grep -E '^[[:space:]]*not ok|ERROR:|# Looks like|CONTEXT:' <<<"$out" | head -20
    failed=1
  else
    echo "ok   $name"
  fi
done
exit $failed
