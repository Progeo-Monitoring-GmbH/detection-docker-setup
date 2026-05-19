#!/bin/sh

PROJECT_ROOT="${PROJECT_ROOT:-/home/progeo/detection-docker-setup}"
VENV_ROOT="${VENV_ROOT:-/opt/venv}"

cd "$PROJECT_ROOT" || exit 1

. "$VENV_ROOT/bin/activate"

python manage.py handle_all_dbs --command=dbbackup
