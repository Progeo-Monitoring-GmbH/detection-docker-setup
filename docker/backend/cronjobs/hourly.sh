#!/bin/sh

PROJECT_ROOT="${PROJECT_ROOT:-/home/progeo/detection-docker-setup}"
VIRTUAL_ENV="${VIRTUAL_ENV:-/opt/venv}"

. "$VIRTUAL_ENV/bin/activate"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] hourly job started"

cd "$PROJECT_ROOT" || exit 1

python manage.py evaluate_measurements

echo "[$(date '+%Y-%m-%d %H:%M:%S')] hourly job finished"
