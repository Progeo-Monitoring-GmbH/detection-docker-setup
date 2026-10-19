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

  log_info "Building and starting containers in ${project_root}..."
  (cd "${project_root}" && "${compose[@]}" build && "${compose[@]}" up -d)
  log_success "Containers started"
}

main "$@"
