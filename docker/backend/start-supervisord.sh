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

# Clean up legacy/unused celery log files so troubleshooting uses only active files.
rm -rf /var/log/progeo/*.log || true

for log_file in \
  /var/log/progeo/supervisord.log \
  /var/log/progeo/cron.log \
  /var/log/progeo/cron-supervisor.log \
  /var/log/progeo/cron-supervisor.err.log \
  /var/log/progeo/backend.log \
  /var/log/progeo/backend.err.log \
  /var/log/progeo/celery-worker.log \
  /var/log/progeo/celery-beat.log \
  /var/log/progeo/half-hour.log \
  /var/log/progeo/daily.log \
  /var/log/progeo/weekly.log
do
  # Recreate/truncate logs on every container start.
  : > "$log_file" 2>/dev/null || true
  chown progeo:progeo "$log_file" 2>/dev/null || true
  chmod 666 "$log_file" 2>/dev/null || true
done

exec /usr/bin/supervisord -c /home/progeo/detection-docker-setup/supervisord.conf