#!/bin/sh

PROJECT_ROOT="${PROJECT_ROOT:-/usr/src/app}"
VIRTUAL_ENV="${VIRTUAL_ENV:-/opt/venv}"

. "$VIRTUAL_ENV/bin/activate"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] weekly job started"

cd "$PROJECT_ROOT" || exit 1

# TODO

echo "[$(date '+%Y-%m-%d %H:%M:%S')] weekly job finished"
