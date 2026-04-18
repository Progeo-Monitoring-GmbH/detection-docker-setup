#!/bin/sh

PROJECT_ROOT="${PROJECT_ROOT:-/usr/src/app}"
VIRTUAL_ENV="${VIRTUAL_ENV:-/opt/venv}"

cd "$PROJECT_ROOT" || exit 1

if [ -f "$PROJECT_ROOT/django.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_ROOT/django.env"
  set +a
fi

# shellcheck disable=SC1091
. "$VIRTUAL_ENV/bin/activate"

python manage.py scan_devices

echo "DONE!"