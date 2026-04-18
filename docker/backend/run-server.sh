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

#pprint "[0] sleep 15s"
#sleep 15

pprint "[1] collect static"
python manage.py collectstatic --noinput

pprint "[2] check database"
python manage.py check progeo --tag database

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

#if [ "$CELERY_ON_BOOT" = "1" ]; then
#  pprint "[8] celery worker"
#  celery -A progeo.celery worker --loglevel=info --logfile "${PROJECT_ROOT}/celery.log" -E -P eventlet &
#fi

pprint "### Starting Webserver: 0.0.0.0:${1}"
python -m daphne -b 0.0.0.0 -p "${1}" progeo.asgi:application
