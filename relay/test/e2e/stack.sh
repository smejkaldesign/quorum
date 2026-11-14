#!/bin/bash
# The throwaway database and PostgREST that kbSync.e2e.mjs runs against, on the local Supabase stack.
#   bash test/e2e/stack.sh up     copy the local database into quorum_e2e, apply 0032 to the copy, and start a second
#                                 PostgREST on the stack's network for it at http://127.0.0.1:54399
#   bash test/e2e/stack.sh down   stop that PostgREST and drop quorum_e2e; the shared local database is never changed
# The PostgREST settings are copied from the stack's own container into a private file (E2E_JWT_ENV, mode 600) and are
# never printed; kbSync.e2e.mjs reads the JWT secret from it to sign the admin's token for Remove.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
db=supabase_db_quorum
envf="${E2E_JWT_ENV:-${TMPDIR:-/tmp}/quorum-e2e-pgrst.env}"
case "${1:-}" in
  up)
    docker exec "$db" psql -U supabase_admin -d postgres -qc 'drop database if exists quorum_e2e' -c 'create database quorum_e2e owner postgres'
    docker exec "$db" bash -c 'pg_dump -U supabase_admin -d postgres > /tmp/quorum_e2e.sql && psql -U supabase_admin -d quorum_e2e -q -v ON_ERROR_STOP=1 -f /tmp/quorum_e2e.sql > /dev/null && rm /tmp/quorum_e2e.sql'
    docker exec -i "$db" psql -U postgres -d quorum_e2e -q -v ON_ERROR_STOP=1 -f - < "$repo/supabase/migrations/0032_kb_attachments.sql"
    (umask 077; docker inspect supabase_rest_quorum --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^PGRST_' | grep -v ADMIN_SERVER | sed -E 's#^(PGRST_DB_URI=.*)/postgres$#\1/quorum_e2e#' > "$envf")
    net=$(docker inspect supabase_rest_quorum --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
    image=$(docker inspect supabase_rest_quorum --format '{{.Config.Image}}')
    docker rm -f quorum_e2e_rest > /dev/null 2>&1 || true
    docker run -d --name quorum_e2e_rest --network "$net" --env-file "$envf" -p 54399:3000 "$image" > /dev/null
    sleep 3
    echo "quorum_e2e is up at http://127.0.0.1:54399; run: E2E_JWT_ENV=$envf node test/e2e/kbSync.e2e.mjs"
    ;;
  down)
    docker rm -f quorum_e2e_rest > /dev/null 2>&1 || true
    docker exec "$db" psql -U supabase_admin -d postgres -qc 'drop database if exists quorum_e2e'
    rm -f "$envf"
    echo "quorum_e2e is gone"
    ;;
  *) echo "usage: stack.sh up|down" >&2; exit 2 ;;
esac
