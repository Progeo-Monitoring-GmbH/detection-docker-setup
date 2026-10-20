#!/usr/bin/env bash
# One-liner installer: fetches this repository into the current directory and
# prepares the system (scripts/setup_system.sh). Containers are not started here,
# because .env / django.env must be edited first; scripts/finalize-install.sh does that.
#
#   curl -fsSL https://raw.githubusercontent.com/Progeo-Monitoring-GmbH/detection-docker-setup/main/scripts/install.sh | sudo bash
#
# Optional environment variables (pass them after sudo, e.g. `| sudo BRANCH=dev bash`):
#   REPO_URL    git repository to clone (default: Progeo-Monitoring-GmbH/detection-docker-setup)
#   BRANCH      branch to check out (default: main)
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Progeo-Monitoring-GmbH/detection-docker-setup.git}"
BRANCH="${BRANCH:-main}"

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
    # As the checkout's owner: root has no deploy key and git rejects repos owned by others.
    local owner
    owner="$(stat -c %U "${target_dir}/.git")"
    log_info "Existing checkout found in ${target_dir}, updating as ${owner}..."
    sudo -u "${owner}" -H git -C "${target_dir}" fetch origin "${BRANCH}"
    sudo -u "${owner}" -H git -C "${target_dir}" checkout "${BRANCH}"
    sudo -u "${owner}" -H git -C "${target_dir}" pull --ff-only origin "${BRANCH}"
  elif [[ -z "$(ls -A "${target_dir}")" ]]; then
    log_info "Cloning ${REPO_URL} (${BRANCH}) into ${target_dir}..."
    git clone --branch "${BRANCH}" "${REPO_URL}" "${target_dir}"
  else
    fatal "Error: ${target_dir} is not empty and not a git checkout. Run the installer in an empty directory."
  fi

  log_success "Repository ready in ${target_dir}"
}

# The checkout belongs to progeo (created by setup_system.sh), so `git pull` works as progeo.
# media/ and logs/ are bind-mounted into the containers, which own what they write there.
own_checkout() {
  local target_dir="$1"

  find "${target_dir}" \( -path "${target_dir}/media" -o -path "${target_dir}/logs" \) -prune \
    -o -exec chown progeo:progeo {} +
  log_success "${target_dir} is owned by progeo"
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
  own_checkout "${target_dir}"

  log_success "Installation prepared in ${target_dir}"
  echo
  log_info "Next steps:"
  log_info "  1. Edit ${target_dir}/.env and ${target_dir}/django.env"
  log_info "  2. Build and start the containers:"
  echo "       sudo bash ${target_dir}/scripts/finalize-install.sh"
}

# Wrapped in main and called last so a partially downloaded script never runs.
main "$@" </dev/null
