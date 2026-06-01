#!/bin/bash
function pprint() {
   printf "\n\033[0;36m "
   printf "${1}"
   printf " \033[0m\n"
}

pprint "[INFO]  progeo-Backend will be started!"

if [ -z "${1}" ]; then
  pprint "[EXIT] No Backend-Port given..."
  exit 1
fi

pprint "### Running Django-Scripts for ${DOMAIN}"

. /etc/profile
. $VENV_ROOT/bin/activate

pprint "[1] collect static"
python manage.py collectstatic --noinput

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

pprint "[3] advanced migration"
bash "${PROJECT_ROOT}/wait-for-it.sh" "${DOMAIN}" -- python manage.py adv_migrate

if [ $? -ne 0 ]; then
  pprint "[ERROR] advanced migration"
  exit 1
fi

pprint "[4] creating account"
python manage.py create_controller_account

pprint "[5] fix contenttypes"
python manage.py fix_contenttypes

pprint "[6] create_admin"
python manage.py create_admin

pprint "[7] sync default"
python manage.py sync_default

pprint "### Starting Webserver: 0.0.0.0:${1}"
python -m daphne -b 0.0.0.0 -p "${1}" progeo.asgi:application
