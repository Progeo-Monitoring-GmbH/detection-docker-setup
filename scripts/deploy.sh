#!/usr/bin/env bash
# Deploys the checked-out code on a live server with minimal downtime:
#
#   1. builds all images - the old containers keep serving meanwhile
#   2. runs the database steps of run-server.sh (prepare_databases = migrations,
#      sync_default, access_index, ...) in a one-off container of the NEW image,
#      still while the old backend serves - a failure stops the deploy here,
#      with the old version still running
#   3. recreates the changed containers; the new backend skips the steps
#      done in 2 (marker logs/backend/deploy-prepared, see run-server.sh)
#   4. waits until the backend accepts connections, then follows its log
#
#   bash scripts/deploy.sh                 # deploy, then follow the backend log
#   bash scripts/deploy.sh --no-follow     # deploy only (e.g. from CI or cron)
#   bash scripts/deploy.sh --skip-prepare  # staging: skip step 2 AND the steps
#                                          # [3]-[8] of the new backend's start
#
# --skip-prepare is for servers whose data did not change since the last deploy
# (staging): prepare_databases, sync_default, access_index, ... are not run at
# all. If the pull brought new migrations, the full step 2 runs anyway.
#
# Migrations run while the OLD code still serves: they must stay compatible
# with it (add columns/tables first, drop or rename in a later release).
set -euo pipefail

if [[ -t 1 ]]; then
  COLOR_RED='\033[0;31m'
  COLOR_GREEN='\033[0;32m'
  COLOR_YELLOW='\033[1;33m'
  COLOR_RESET='\033[0m'
else
  COLOR_RED=''
  COLOR_GREEN=''
  COLOR_YELLOW=''
  COLOR_RESET=''
fi

log_info() {
  echo -e "${COLOR_YELLOW}[$(date '+%H:%M:%S')] $1${COLOR_RESET}"
}

log_success() {
  echo -e "${COLOR_GREEN}[$(date '+%H:%M:%S')] $1${COLOR_RESET}"
}

fatal() {
  echo -e "${COLOR_RED}[$(date '+%H:%M:%S')] $1${COLOR_RESET}" >&2
  exit 1
}

# Seconds the new backend may take until it accepts connections.
READY_TIMEOUT="${READY_TIMEOUT:-300}"

main() {
  local follow=1
  local skip_prepare=0

  local arg
  for arg in "$@"; do
    case "${arg}" in
      --no-follow) follow=0 ;;
      --skip-prepare) skip_prepare=1 ;;
      *) fatal "Usage: bash scripts/deploy.sh [--no-follow] [--skip-prepare]" ;;
    esac
  done

  local head_before
  head_before=$(git rev-parse HEAD)
  git pull

  # New migrations need the full step 2, whatever the flag says.
  if (( skip_prepare )) && [[ -n "$(git diff --name-only "${head_before}" HEAD -- '*/migrations/*.py')" ]]; then
    skip_prepare=0
    local new_migrations=1
  fi

  local project_root
  project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "${project_root}"

  compose=(docker compose)
  if ! docker compose version >/dev/null 2>&1; then
    compose=(docker-compose)
  fi

  # Everything also goes to logs/deploy.log - the backend logs are rotated on its start.
  # 3/4 keep the terminal for following the backend log at the end.
  mkdir -p logs
  exec 3>&1 4>&2
  exec > >(tee -a logs/deploy.log) 2>&1
  local started
  started=$(date +%s)
  log_info "=== Deploy $(date '+%Y-%m-%d %H:%M:%S') in ${project_root}"

  log_info "[1/4] Building images (the old containers keep running)..."
  "${compose[@]}" build

  if [[ -n "${new_migrations:-}" ]]; then
    log_info "--skip-prepare ignored: the pull brought new migrations"
  fi

  if (( skip_prepare )); then
    log_info "[2/4] Skipped (--skip-prepare) - the new backend skips steps [3]-[8] as well"
    # The marker run-server.sh checks - as if step 2 had just run.
    mkdir -p logs/backend
    touch logs/backend/deploy-prepared
  else
    log_info "[2/4] Migrating + syncing with the new image (the old backend keeps serving)..."
    ensure_database
    rm -f logs/backend/deploy-prepared
    local prepare_started
    prepare_started=$(date +%s)
    if ! "${compose[@]}" run --rm --no-deps -T progeo-backend \
        /bin/bash /home/progeo/detection-docker-setup/start-supervisord.sh prepare; then
      fatal "Preparing the databases failed - nothing restarted, the old version is still running."
    fi
    log_success "Databases prepared in $(( $(date +%s) - prepare_started ))s"
  fi

  log_info "[3/4] Recreating the changed containers..."
  local downtime_started
  downtime_started=$(date +%s)
  "${compose[@]}" up -d

  log_info "[4/4] Waiting for the backend..."
  wait_for_backend
  log_success "Backend up $(( $(date +%s) - downtime_started ))s after the restart (deploy took $(( $(date +%s) - started ))s)"
  # Unused if the backend image did not change (its container was not recreated).
  rm -f logs/backend/deploy-prepared 2>/dev/null || true

  # The images replaced by this build, now untagged - can fill up small devices.
  docker image prune -f >/dev/null || true

  if (( follow )); then
    exec tail -n +1 -F logs/backend/backend.log logs/backend/backend.err.log >&3 2>&4
  fi
}

# The prepare container needs the database (and redis for the signals) -
# started if needed, never recreated here: that is up to "up -d" in step 3.
ensure_database() {
  "${compose[@]}" up -d --no-recreate progeo-database progeo-redis

  local tries=0
  until "${compose[@]}" exec -T progeo-database pg_isready -q; do
    tries=$((tries + 1))
    if (( tries > 15 )); then
      fatal "The database did not become ready - nothing restarted."
    fi
    sleep 2
  done
}

# Ready = daphne accepts connections inside the container (independent of
# LIMITED_ACCESS / the published port).
wait_for_backend() {
  local deadline=$(( $(date +%s) + READY_TIMEOUT ))
  local probe='"${VENV_ROOT:-/opt/venv}/bin/python" -c "import socket; socket.create_connection((\"127.0.0.1\", ${PORT:-8383}), 2)"'
  until "${compose[@]}" exec -T progeo-backend sh -c "${probe}" >/dev/null 2>&1; do
    if (( $(date +%s) > deadline )); then
      echo "--- last lines of logs/backend/backend.log:" >&2
      tail -n 40 logs/backend/backend.log >&2 || true
      fatal "The backend did not come up within ${READY_TIMEOUT}s - see logs/backend/backend.log and backend.err.log"
    fi
    sleep 2
  done
}

main "$@"
