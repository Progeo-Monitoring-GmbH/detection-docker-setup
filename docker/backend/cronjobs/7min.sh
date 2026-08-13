#!/bin/sh

PROJECT_ROOT="${PROJECT_ROOT:-/home/progeo/detection-docker-setup}"
VIRTUAL_ENV="${VIRTUAL_ENV:-/opt/venv}"

. "$VIRTUAL_ENV/bin/activate"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] weekly job started"

cd "$PROJECT_ROOT" || exit 1

pyhton manage.py evaluate_alarms

echo "[$(date '+%Y-%m-%d %H:%M:%S')] weekly job finished"
    