#!/bin/bash
set -euo pipefail

fix_volume_permissions() {
  local target_dir="$1"

  mkdir -p "$target_dir"

  # Best-effort ownership fix for bind mounts (may fail on some hosts).
  chown -R progeo:progeo "$target_dir" 2>/dev/null || true

  # Ensure app user can read/write even if files are root-owned.
  chmod -R u+rwX,g+rwX,o+rwX "$target_dir" 2>/dev/null || true
}

fix_volume_permissions "/var/log/progeo"
fix_volume_permissions "/home/progeo/detection-docker-setup/media"

fix_docker_socket_permissions() {
  local socket_path="/var/run/docker.sock"
  if [ ! -S "$socket_path" ]; then
    return
  fi

  local socket_gid
  socket_gid="$(stat -c '%g' "$socket_path" 2>/dev/null || true)"
  if [ -z "$socket_gid" ]; then
    return
  fi

  local group_name
  group_name="$(awk -F: -v gid="$socket_gid" '$3==gid {print $1; exit}' /etc/group)"
  if [ -z "$group_name" ]; then
    group_name="dockersock"
    addgroup -g "$socket_gid" -S "$group_name" 2>/dev/null || true
  fi

  addgroup progeo "$group_name" 2>/dev/null || true
  chmod g+rw "$socket_path" 2>/dev/null || true
}

fix_docker_socket_permissions

# Django, celery and the cron jobs (which get no container environment) read
# their settings from ${PROJECT_ROOT}/django.env. The file is not part of the
# image - the images are public on Docker Hub - but built here on every start
# from the host's .env and django.env, mounted read-only to /etc/progeo
# (docker-compose.yml). .env comes first: for a key in both, its value wins.
build_django_env() {
  local target="${PROJECT_ROOT:-/home/progeo/detection-docker-setup}/django.env"
  local source
  for source in /etc/progeo/.env /etc/progeo/django.env; do
    if [ ! -f "$source" ]; then
      echo "Missing ${source}: mount the host's .env and django.env (see docker-compose.yml)" >&2
      exit 1
    fi
  done

  (
    umask 077
    { cat /etc/progeo/.env; echo; cat /etc/progeo/django.env; } \
      | sed -e "s|@PROTOCOL|${PROTOCOL:-}|g" \
            -e "s|@FRONTEND_PORT|${FRONTEND_PORT:-}|g" \
            -e "s|@BACKEND_PORT|${PORT:-}|g" \
      > "$target"
  )
  chown progeo:progeo "$target"
}

build_django_env

# "prepare" (scripts/deploy.sh): only the database steps of run-server.sh -
# migrations, sync_default, ... - in a one-off container of the new image,
# while the old backend keeps serving. No crond, supervisord or log rotation:
# the logs belong to the running backend.
if [ "${1:-}" = "prepare" ]; then
  cd "${PROJECT_ROOT:-/home/progeo/detection-docker-setup}"
  exec su progeo -s /bin/bash -c "bash run-server.sh --prepare-only"
fi

# CRON_DISABLED_JOBS (comma separated): cron jobs that must not run, by script
# name - half-hour, measure, daily, weekly - or "all", e.g. while
# split_project_dbs runs. Applied here, before crond starts: the jobs are
# commented out of the crontab, rebuilt from the image's original on every
# start, so an emptied variable brings them back with the next restart.
apply_cron_disabled_jobs() {
  local crontab_file="/etc/crontabs/root"
  local original="${crontab_file}.orig"
  local marker="# disabled by CRON_DISABLED_JOBS: "

  [ -f "$crontab_file" ] || return 0
  [ -f "$original" ] || cp -p "$crontab_file" "$original"
  cp -p "$original" "$crontab_file"

  local job
  for job in $(echo "${CRON_DISABLED_JOBS:-}" | tr ',' ' '); do
    case "$job" in
      all)
        sed -i "/^[^#].*cronjobs\//s/^/${marker}/" "$crontab_file" ;;
      half-hour|measure|daily|weekly)
        sed -i "/^[^#].*cronjobs\/${job}\.sh/s/^/${marker}/" "$crontab_file" ;;
      *)
        echo "CRON_DISABLED_JOBS: unknown job '${job}' ignored (half-hour, measure, daily, weekly, all)" ;;
    esac
  done
  if grep -q "^${marker}" "$crontab_file"; then
    echo "CRON_DISABLED_JOBS: not scheduled:"
    grep "^${marker}" "$crontab_file" | sed "s/^${marker}/  /"
  fi
}

apply_cron_disabled_jobs

# Logs of the nightly/weekly cron jobs survive restarts: they run once a day or
# week, so a deploy in between must not erase the last run. They only move to
# <name>.log.prev once they grow beyond 5 MB.
PERSISTENT_LOGS="daily.log weekly.log"
PERSISTENT_LOG_MAX_BYTES=5242880

# Keep the previous run's logs as <name>.log.prev so a crash/restart doesn't wipe the evidence.
# (.log.1, .log.2, ... are taken by supervisord's own size rotation; errors.jsonl rotates itself.)
for log_file in /var/log/progeo/*.log; do
  [ -f "$log_file" ] || continue
  case " ${PERSISTENT_LOGS} " in
    *" $(basename "$log_file") "*)
      if [ "$(stat -c %s "$log_file" 2>/dev/null || echo 0)" -gt "$PERSISTENT_LOG_MAX_BYTES" ]; then
        mv -f "$log_file" "$log_file.prev" 2>/dev/null || true
      fi
      continue
      ;;
  esac
  mv -f "$log_file" "$log_file.prev" 2>/dev/null || true
done

for log_name in $PERSISTENT_LOGS; do
  log_file="/var/log/progeo/${log_name}"
  touch "$log_file" 2>/dev/null || true
  chown progeo:progeo "$log_file" 2>/dev/null || true
  chmod 666 "$log_file" 2>/dev/null || true
done

for log_file in \
  /var/log/progeo/supervisord.log \
  /var/log/progeo/cron.log \
  /var/log/progeo/cron-supervisor.log \
  /var/log/progeo/cron-supervisor.err.log \
  /var/log/progeo/backend.log \
  /var/log/progeo/backend.err.log \
  /var/log/progeo/celery-worker.log \
  /var/log/progeo/celery-beat.log \
  /var/log/progeo/half-hour.log
do
  # Recreate/truncate logs on every container start (not PERSISTENT_LOGS).
  : > "$log_file" 2>/dev/null || true
  chown progeo:progeo "$log_file" 2>/dev/null || true
  chmod 666 "$log_file" 2>/dev/null || true
done

exec /usr/bin/supervisord -c /home/progeo/detection-docker-setup/supervisord.conf