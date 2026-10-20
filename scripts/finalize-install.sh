#!/usr/bin/env bash
# Second installation step: builds and starts all containers.
# Run it after install.sh, once .env and django.env have been edited.
#
#   sudo bash scripts/finalize-install.sh
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
  echo -e "${COLOR_YELLOW}$1${COLOR_RESET}"
}

log_success() {
  echo -e "${COLOR_GREEN}$1${COLOR_RESET}"
}

fatal() {
  echo -e "${COLOR_RED}$1${COLOR_RESET}" >&2
  exit 1
}

main() {
  local project_root
  project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  local env_file
  for env_file in "${project_root}/.env" "${project_root}/django.env"; do
    if [[ ! -f "${env_file}" ]]; then
      fatal "Error: ${env_file} not found. Run install.sh (or scripts/setup_system.sh) first."
    fi
  done

  if ! docker info >/dev/null 2>&1; then
    fatal "Error: cannot talk to the Docker daemon. Run this script with sudo."
  fi

  local compose=(docker compose)
  if ! docker compose version >/dev/null 2>&1; then
    compose=(docker-compose)
  fi

  log_info "Building containers in ${project_root}..."
  (cd "${project_root}" && "${compose[@]}" build)

  import_legacy_backup "${project_root}"

  log_info "Starting containers..."
  (cd "${project_root}" && "${compose[@]}" up -d)
  log_success "Containers started"
}

# A large default-*.psql[.gz] in media/backup is the old server's database:
# restore it and split it into the per-project databases BEFORE the backend
# starts, so no ingestion runs against a half-imported database
# (progeo/management/commands/import_legacy_backup.py). Runs only once - the
# command leaves a marker next to the backup and refuses a non-empty default.
import_legacy_backup() {
  local project_root="$1"

  log_info "Starting the database to check for a legacy backup..."
  (cd "${project_root}" && "${compose[@]}" up -d progeo-database progeo-redis)

  # Up to 30s: the very first start runs initdb, which can exceed 10s.
  local tries=0
  until (cd "${project_root}" && "${compose[@]}" exec -T progeo-database pg_isready -q); do
    tries=$((tries + 1))
    if (( tries > 15 )); then
      fatal "Error: the database did not become ready."
    fi
    sleep 2
  done

  local manage=("${compose[@]}" run --rm --no-deps progeo-backend python manage.py)
  if ! (cd "${project_root}" && "${manage[@]}" import_legacy_backup --check); then
    log_info "No legacy backup to import."
    return
  fi

  log_info "Importing the legacy backup - this takes a while (restore + split into project databases)..."
  (cd "${project_root}" && "${manage[@]}" import_legacy_backup --noinput)
  log_success "Legacy backup imported"
}

main "$@"
