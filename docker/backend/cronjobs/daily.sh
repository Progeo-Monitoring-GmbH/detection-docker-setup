#!/bin/sh

PROJECT_ROOT="${PROJECT_ROOT:-/usr/src/app}"
VENV_ROOT="${VENV_ROOT:-/opt/venv}"

cd "$PROJECT_ROOT" || exit 1

if [ -f "$PROJECT_ROOT/django.env" ]; then
	set -a
	# shellcheck disable=SC1091
	. "$PROJECT_ROOT/django.env"
	set +a
fi

# shellcheck disable=SC1091
. "$VENV_ROOT/bin/activate"

python manage.py handle_all_dbs --command=dbbackup

echo "DONE!"
