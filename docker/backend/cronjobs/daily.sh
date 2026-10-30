#!/bin/sh

PROJECT_ROOT="${PROJECT_ROOT:-/home/progeo/detection-docker-setup}"
VENV_ROOT="${VENV_ROOT:-/opt/venv}"

cd "$PROJECT_ROOT" || exit 1

. "$VENV_ROOT/bin/activate"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] daily dbbackup started"
python manage.py handle_all_dbs --command=dbbackup
rc=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S')] daily dbbackup finished (exit $rc), transfer started"
# Tonight's dumps as one OpenPGP-encrypted tar to the backup server (BACKUP_REMOTE_* in .env; off while empty).
python manage.py transfer_backups
rc=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S')] daily transfer finished (exit $rc)"
# The same dumps, encrypted for the staging server's key, to the staging server (STAGING_REMOTE_* in .env; off while empty).
python manage.py transfer_backups --target staging
rc=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S')] daily staging transfer finished (exit $rc)"
