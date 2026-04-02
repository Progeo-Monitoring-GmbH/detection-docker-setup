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

pprint "[0] start cron daemon"
if command -v crond >/dev/null 2>&1; then
  crond -b -l 8 -L /tmp/cron.log -c /etc/crontabs
  pprint "[OK] cron daemon started (crontab: /etc/crontabs/progeo)"
else
  pprint "[WARN] crond not found, scheduled jobs are disabled"
fi

#pprint "[0] sleep 15s"
#sleep 15

pprint "[1] collect static"
python manage.py collectstatic --noinput

pprint "[2] check database"
python manage.py check progeo --tag database

pprint "[3] advanced migration"
bash "${PROJECT_ROOT}/wait-for-it.sh" "${DOMAIN}" -- python manage.py adv_migrate &

pid=$!
wait $pid
exit_status=$?

if [ $exit_status -ne 0 ]; then
  pprint "[ERROR] advanced migration"
  tail -f /dev/null
fi

pprint "[4] fix contenttypes"
python manage.py fix_contenttypes

pprint "[5] create_admin"
python manage.py create_admin

pprint "[6] sync default"
python manage.py sync_default

#if [ "$CELERY_ON_BOOT" = "1" ]; then
#  pprint "[7] celery worker"
#  celery -A progeo.celery worker --loglevel=info --logfile "${PROJECT_ROOT}/celery.log" -E -P eventlet &
#fi

pprint "### Starting Webserver: 0.0.0.0:${1}"
python -m daphne -b 0.0.0.0 -p "${1}" progeo.asgi:application
