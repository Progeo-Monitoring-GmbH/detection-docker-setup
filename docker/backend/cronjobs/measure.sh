#!/bin/sh

PROJECT_ROOT="${PROJECT_ROOT:-/home/progeo/detection-docker-setup}"
VIRTUAL_ENV="${VIRTUAL_ENV:-/opt/venv}"

. "$VIRTUAL_ENV/bin/activate"


cd "$PROJECT_ROOT" || exit 1
python manage.py scan_devices
