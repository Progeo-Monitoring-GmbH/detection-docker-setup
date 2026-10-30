#!/bin/sh

# crond runs on Berlin time (supervisord.conf), so the crontab's times are local
# times. The job itself runs on UTC like the rest of the backend.
unset TZ

PROJECT_ROOT="${PROJECT_ROOT:-/home/progeo/detection-docker-setup}"
VIRTUAL_ENV="${VIRTUAL_ENV:-/opt/venv}"

. "$VIRTUAL_ENV/bin/activate"


cd "$PROJECT_ROOT" || exit 1
python manage.py scan_devices
