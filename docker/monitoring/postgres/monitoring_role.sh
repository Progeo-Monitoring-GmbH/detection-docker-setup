#!/bin/sh
# progeo-monitoring-db-init (monitoring profile): creates - or updates the
# password of - the read-only role the postgres exporters log in with, on
# every `docker compose up`. Idempotent; member of pg_monitor only (statistics
# and sizes of every database, no table data). Also creates the
# pg_stat_statements extension - loading its library still needs one restart
# of progeo-database: scripts/setup_monitoring_db_user.sh asks for it.
#
# Connects as POSTGRES_USER over the database network (PGHOST/PGPORT/PGUSER/
# PGPASSWORD/PGDATABASE from compose).
set -eu

user="${MONITOR_USER:-progeo_monitor}"
if [ -z "${MONITOR_PASSWORD:-}" ]; then
  echo "POSTGRES_MONITOR_PASSWORD is empty in .env - the exporters cannot log in." >&2
  echo "Set it (openssl rand -hex 24) and run: docker compose up -d" >&2
  exit 1
fi
# postgres-exporter builds a DSN from it and fails on quotes, spaces etc.
case "${MONITOR_PASSWORD}" in
  *[!A-Za-z0-9._~-]*)
    echo "POSTGRES_MONITOR_PASSWORD may only contain A-Z a-z 0-9 . _ ~ - (e.g. openssl rand -hex 24)." >&2
    exit 1
    ;;
esac

# progeo-database may still be starting.
tries=0
until pg_isready -q; do
  tries=$((tries + 1))
  if [ "${tries}" -ge 60 ]; then
    echo "progeo-database (${PGHOST}:${PGPORT}) not reachable after 2 minutes." >&2
    exit 1
  fi
  sleep 2
done

psql -v ON_ERROR_STOP=1 -q -v user="${user}" -v password="${MONITOR_PASSWORD}" <<'SQL'
SELECT format('CREATE ROLE %I', :'user') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'user') \gexec
ALTER ROLE :"user" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 5 PASSWORD :'password';
GRANT pg_monitor TO :"user";
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SQL
echo "Role ${user} is ready (pg_monitor)."
