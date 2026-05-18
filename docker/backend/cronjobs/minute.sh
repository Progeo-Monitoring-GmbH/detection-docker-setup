#!/bin/sh

PROJECT_ROOT="${PROJECT_ROOT:-/usr/src/app}"
VIRTUAL_ENV="${VIRTUAL_ENV:-/opt/venv}"

. "$VIRTUAL_ENV/bin/activate"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] minute task started"

cd "$PROJECT_ROOT" || exit 1
python manage.py ping
echo "[$(date '+%Y-%m-%d %H:%M:%S')] minute task finished"