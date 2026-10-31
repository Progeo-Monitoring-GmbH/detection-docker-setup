#!/bin/sh

# crond runs on Berlin time (supervisord.conf), so the crontab's times are local
# times. The job itself runs on UTC like the rest of the backend.
unset TZ

PROJECT_ROOT="${PROJECT_ROOT:-/home/progeo/detection-docker-setup}"
VENV_ROOT="${VENV_ROOT:-/opt/venv}"

cd "$PROJECT_ROOT" || exit 1

. "$VENV_ROOT/bin/activate"

echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] daily dbbackup started"
python manage.py handle_all_dbs --command=dbbackup
rc=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] daily dbbackup finished (exit $rc), sync backups started"
# Create the Backup rows for tonight's dumps, so the backup list is current before transfer.
python manage.py sync_backups
rc=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] daily sync_backups finished (exit $rc), transfer started"
# Tonight's dumps as one OpenPGP-encrypted tar to the backup server (BACKUP_REMOTE_* in .env; off while empty).
python manage.py transfer_backups
rc=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] daily transfer finished (exit $rc)"
# The same dumps, encrypted for the staging server's key, to the staging server (STAGING_REMOTE_* in .env; off while empty).
python manage.py transfer_backups --target staging
rc=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] daily staging transfer finished (exit $rc)"
