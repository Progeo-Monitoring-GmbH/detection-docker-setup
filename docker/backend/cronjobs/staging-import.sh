#!/bin/sh

# STAGING server only (STAGING_AUTO_IMPORT=1): restores the newest bundle the
# live server sent (`import_live_backup --apply`). Does nothing while
# STAGING_AUTO_IMPORT is off, no new bundle arrived or the newest one is
# imported already. README.md, "Staging server".
#
# The backend and celery are stopped meanwhile: they keep connections open and
# write while the databases are replaced. Starting run-server again runs its
# prepare steps (migrations, sync_default, ...) - staging code may be newer.

# crond runs on Berlin time (supervisord.conf), so the crontab's times are local
# times. The job itself runs on UTC like the rest of the backend.
unset TZ

PROJECT_ROOT="${PROJECT_ROOT:-/home/progeo/detection-docker-setup}"
VENV_ROOT="${VENV_ROOT:-/opt/venv}"
SERVICES="celery-beat celery-worker run-server"

cd "$PROJECT_ROOT" || exit 1

. "$VENV_ROOT/bin/activate"

python manage.py import_live_backup --pending
step=$?
[ "$step" -eq 3 ] && exit 0  # nothing to import
[ "$step" -ne 0 ] && exit "$step"

SUPERVISORCTL="supervisorctl -c $PROJECT_ROOT/supervisord.conf"

echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] staging import started, stopping $SERVICES"
if $SUPERVISORCTL stop $SERVICES; then
  python manage.py import_live_backup --apply --noinput
  rc=$?
else
  echo "Stopping $SERVICES failed - nothing imported"
  rc=1
fi
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] staging import finished (exit $rc), starting $SERVICES"
# Started in any case: staging must not stay down
$SUPERVISORCTL start run-server celery-worker celery-beat || rc=1
exit "$rc"
