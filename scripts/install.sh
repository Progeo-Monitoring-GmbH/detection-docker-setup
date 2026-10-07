#!/usr/bin/env bash
# One-liner installer: fetches this repository into the current directory,
# prepares the system (scripts/setup_system.sh) and starts all containers.
#
#   curl -fsSL https://raw.githubusercontent.com/Progeo-Monitoring-GmbH/detection-docker-setup/main/scripts/install.sh | sudo bash
#
# Optional environment variables (pass them after sudo, e.g. `| sudo BRANCH=dev bash`):
#   REPO_URL    git repository to clone (default: Progeo-Monitoring-GmbH/detection-docker-setup)
#   BRANCH      branch to check out (default: main)
#   SKIP_START  set to 1 to only install/configure, without building and starting containers
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Progeo-Monitoring-GmbH/detection-docker-setup.git}"
BRANCH="${BRANCH:-main}"
SKIP_START="${SKIP_START:-0}"

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

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return 0
  fi
  log_info "Installing git..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y git ca-certificates
  log_success "git installed"
}

fetch_repository() {
  local target_dir="$1"

  if [[ -d "${target_dir}/.git" ]]; then
    log_info "Existing checkout found in ${target_dir}, updating..."
    git -C "${target_dir}" fetch origin "${BRANCH}"
    git -C "${target_dir}" checkout "${BRANCH}"
    git -C "${target_dir}" pull --ff-only origin "${BRANCH}"
  elif [[ -z "$(ls -A "${target_dir}")" ]]; then
    log_info "Cloning ${REPO_URL} (${BRANCH}) into ${target_dir}..."
    git clone --branch "${BRANCH}" "${REPO_URL}" "${target_dir}"
  else
    fatal "Error: ${target_dir} is not empty and not a git checkout. Run the installer in an empty directory."
  fi

  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    chown -R "${SUDO_USER}:" "${target_dir}"
  fi
  log_success "Repository ready in ${target_dir}"
}

start_containers() {
  local target_dir="$1"
  local compose=(docker compose)

  if ! docker compose version >/dev/null 2>&1; then
    compose=(docker-compose)
  fi

  log_info "Building and starting containers..."
  (cd "${target_dir}" && "${compose[@]}" build && "${compose[@]}" up -d)
  log_success "Containers started"
}

main() {
  if [[ "${EUID}" -ne 0 ]]; then
    fatal "Error: run this installer as root (e.g. curl ... | sudo bash)."
  fi

  local target_dir
  target_dir="$(pwd)"

  ensure_git
  fetch_repository "${target_dir}"

  bash "${target_dir}/scripts/setup_system.sh"

  if [[ "${SKIP_START}" == "1" ]]; then
    log_info "SKIP_START=1, not building/starting containers."
    log_info "Start them later with: docker compose build && docker compose up -d"
  else
    start_containers "${target_dir}"
  fi

  log_success "Installation finished in ${target_dir}"
}

# Wrapped in main and called last so a partially downloaded script never runs.
main "$@" </dev/null
