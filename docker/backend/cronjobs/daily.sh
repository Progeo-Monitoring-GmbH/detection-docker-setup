#!/bin/sh

PROJECT_ROOT="${PROJECT_ROOT:-/usr/src/app}"
VENV_ROOT="${VENV_ROOT:-/opt/venv}"

cd "$PROJECT_ROOT" || exit 1

. "$VENV_ROOT/bin/activate"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] daily job started"
python manage.py handle_all_dbs --command=dbbackup
echo "[$(date '+%Y-%m-%d %H:%M:%S')] daily job finished"
