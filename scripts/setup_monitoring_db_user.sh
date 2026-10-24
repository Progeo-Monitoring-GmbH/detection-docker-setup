#!/bin/bash
# Creates (or updates the password of) the read-only PostgreSQL role that
# progeo-postgres-exporter logs in with: POSTGRES_MONITOR_USER /
# POSTGRES_MONITOR_PASSWORD from .env, member of pg_monitor only - it can read
# statistics and sizes of every database, but no table data.
#
# Also enables pg_stat_statements (query statistics of the "PostgreSQL"
# dashboard): the extension is created here, but the library is only loaded
# after a restart of progeo-database - the script asks before restarting.
#
#   bash scripts/setup_monitoring_db_user.sh
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./.env
set +a

monitor_user="${POSTGRES_MONITOR_USER:-progeo_monitor}"
if [ -z "${POSTGRES_MONITOR_PASSWORD:-}" ]; then
  echo "POSTGRES_MONITOR_PASSWORD is empty in .env - set it first." >&2
  exit 1
fi
# postgres-exporter builds a DSN from it and fails on quotes, spaces etc.
if [[ ! "${POSTGRES_MONITOR_PASSWORD}" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  echo "POSTGRES_MONITOR_PASSWORD may only contain A-Z a-z 0-9 . _ ~ - (e.g. openssl rand -hex 24)." >&2
  exit 1
fi

psql_db() {
  docker exec -i progeo-database psql -v ON_ERROR_STOP=1 -q -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" "$@"
}

psql_db -v user="${monitor_user}" -v password="${POSTGRES_MONITOR_PASSWORD}" <<'SQL'
SELECT format('CREATE ROLE %I', :'user') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'user') \gexec
ALTER ROLE :"user" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 5 PASSWORD :'password';
GRANT pg_monitor TO :"user";
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SQL
echo "Role ${monitor_user} is ready (pg_monitor)."

preload="$(psql_db -At -c 'SHOW shared_preload_libraries')"
case ",${preload// /}," in
  *,pg_stat_statements,*)
    echo "pg_stat_statements is already loaded."
    ;;
  *)
    # psql only expands :'libs' in its input, not in -c.
    psql_db -v libs="${preload:+${preload},}pg_stat_statements" <<'SQL'
ALTER SYSTEM SET shared_preload_libraries = :'libs';
SQL
    echo "pg_stat_statements takes effect after a restart of progeo-database (a few seconds of downtime)."
    read -r -p "Restart progeo-database now? [y/N] " answer
    if [ "${answer}" = "y" ]; then
      docker restart progeo-database
    else
      echo "Later: docker restart progeo-database - until then the exporter logs stat_statements errors."
    fi
    ;;
esac
