#!/bin/bash
function pprint() {
   printf "\n\033[0;36m "
   printf "${1}"
   printf " \033[0m\n"
}

# Left by "--prepare-only" (scripts/deploy.sh runs it with the new image while
# the old backend still serves): the start right after skips steps [3]-[8].
# Shared through the logs volume; older than PREPARED_MAX_AGE it counts no more.
PREPARED_MARKER=/var/log/progeo/deploy-prepared
PREPARED_MAX_AGE=1800

PREPARE_ONLY=""
if [ "${1}" = "--prepare-only" ]; then
  PREPARE_ONLY=1
  pprint "[INFO]  progeo-Backend: preparing the databases only (deploy)"
else
  pprint "[INFO]  progeo-Backend will be started!"

  if [ -z "${1}" ]; then
    pprint "[EXIT] No Backend-Port given..."
    exit 1
  fi
fi

pprint "### Running Django-Scripts for ${DOMAIN}"

. /etc/profile
. $VENV_ROOT/bin/activate
export PYTHONUNBUFFERED=1

# The static files live in the container: a one-off prepare container would collect them for nothing.
if [ -z "${PREPARE_ONLY}" ]; then
  pprint "[1] collect static"
  python manage.py collectstatic --noinput
fi

pprint "[2] check database"
python manage.py check progeo --tag database

pprint "[2.1] verify postgres authentication"
if ! PGPASSWORD="${POSTGRES_PASSWORD}" psql \
  -h "${POSTGRES_HOST}" \
  -p "${POSTGRES_PORT}" \
  -U "${POSTGRES_USER}" \
  -d "${POSTGRES_DB}" \
  -c "SELECT 1;" >/dev/null 2>&1; then
  pprint "[ERROR] PostgreSQL login failed for ${POSTGRES_USER}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
  pprint "[HINT] If POSTGRES_PASSWORD was changed after initial DB bootstrap, reset the postgres volume or set the DB user password inside Postgres to match the env."
  exit 1
fi

# Returns 2 if the databases are not ready (the server must not start),
# 1 if one of the later steps failed, 0 if all went through.
prepare() {
  local failed=0

  pprint "[3] prepare databases (default, DJANGO_DATABASES, project databases)"
  if ! bash "${PROJECT_ROOT}/wait-for-it.sh" "${DOMAIN}" -- python manage.py prepare_databases; then
    pprint "[ERROR] databases are not ready - not starting the server"
    return 2
  fi

  pprint "[4] creating account"
  python manage.py create_controller_account || failed=1

  pprint "[5] fix contenttypes"
  python manage.py fix_contenttypes || failed=1

  pprint "[6] create_admin"
  python manage.py create_admin || failed=1

  pprint "[7] sync default"
  python manage.py sync_default || failed=1

  pprint "[8] access index"
  # Fills ProgeoAccessIndex on the first start, repairs drift afterwards.
  python manage.py access_index --rebuild || failed=1

  return $failed
}

if [ -n "${PREPARE_ONLY}" ]; then
  rm -f "${PREPARED_MARKER}"
  prepare
  status=$?
  if [ $status -eq 2 ]; then
    exit 1
  fi
  if [ $status -eq 0 ]; then
    touch "${PREPARED_MARKER}"
    pprint "### Databases prepared - the next start skips steps [3]-[8]"
  else
    pprint "[WARN] steps [4]-[8] partly failed - the next start runs them again"
  fi
  exit 0
fi

prepared_age=-1
if [ -f "${PREPARED_MARKER}" ]; then
  prepared_age=$(( $(date +%s) - $(stat -c %Y "${PREPARED_MARKER}") ))
fi
# One start only: a later restart (crash, reboot) runs everything again.
rm -f "${PREPARED_MARKER}"

if [ $prepared_age -ge 0 ] && [ $prepared_age -le $PREPARED_MAX_AGE ]; then
  pprint "[3-8] skipped - done ${prepared_age}s ago by scripts/deploy.sh"
else
  prepare
  if [ $? -eq 2 ]; then
    exit 1
  fi
fi

pprint "### Starting Webserver: 0.0.0.0:${1}"
# Replace the shell with Daphne so Supervisor tracks and captures the real server process logs.
exec python -u -m daphne -b 0.0.0.0 -p "${1}" progeo.asgi:application
