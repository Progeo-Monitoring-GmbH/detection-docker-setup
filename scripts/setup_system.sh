#!/usr/bin/env bash
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

FAILED=0

log_info() {
  echo -e "${COLOR_YELLOW}$1${COLOR_RESET}"
}

log_success() {
  echo -e "${COLOR_GREEN}$1${COLOR_RESET}"
}

log_error() {
  echo -e "${COLOR_RED}$1${COLOR_RESET}" >&2
}

fatal() {
  FAILED=1
  log_error "$1"
  exit 1
}

on_error() {
  FAILED=1
  log_error "Error: command failed at line $1: $2"
}

print_summary() {
  if [[ "${FAILED}" -eq 0 ]]; then
    log_success "Summary: setup completed successfully."
  else
    log_error "Summary: setup failed. Check the error output above."
  fi
}

trap 'on_error ${LINENO} "${BASH_COMMAND}"' ERR
trap print_summary EXIT

if [[ "${EUID}" -ne 0 ]]; then
  fatal "Error: run this script as root (use sudo)."
fi

if [[ ! -f /etc/os-release ]]; then
  fatal "Error: cannot detect operating system."
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" && "${ID:-}" != "debian" ]]; then
  fatal "Error: this script is intended for Ubuntu or Debian only."
fi

export DEBIAN_FRONTEND=noninteractive

replace_tildes_with_random_chars() {
  local target_file="$1"

  if [[ ! -f "${target_file}" ]]; then
    fatal "Error: file not found: ${target_file}"
  fi

  if ! grep -q '~' "${target_file}"; then
    log_info "No '~' characters found in ${target_file}"
    return 0
  fi

  local tmp_file
  tmp_file="$(mktemp)"

  awk '
    BEGIN {
      chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!§%&()=?-_.:,;#+*"
      n = length(chars)
      srand()
    }
    {
      out = ""
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c == "~") {
          idx = int(rand() * n) + 1
          out = out substr(chars, idx, 1)
        } else {
          out = out c
        }
      }
      print out
    }
  ' "${target_file}" >"${tmp_file}"

  mv "${tmp_file}" "${target_file}"
  log_success "Replaced all '~' characters in ${target_file} with random characters"
}

ensure_file_from_template() {
  local target_file="$1"
  local template_file="$2"

  if [[ ! -f "${target_file}" ]]; then
    if [[ -f "${template_file}" ]]; then
      cp "${template_file}" "${target_file}"
      log_success "Created ${target_file} from ${template_file}"
    else
      fatal "Error: ${template_file} not found, cannot create ${target_file}"
    fi
  else
    log_info "${target_file} already exists, keeping existing file"
  fi
}

configure_non_root_docker() {
  local target_user="${SUDO_USER:-}"

  if [[ -z "${target_user}" || "${target_user}" == "root" ]]; then
    log_info "Skipping non-root Docker setup (no sudo user detected)."
    log_info "Run: sudo usermod -aG docker <your-user>"
    return 0
  fi

  if ! getent group docker >/dev/null 2>&1; then
    groupadd docker
    log_success "Created docker group"
  fi

  usermod -aG docker "${target_user}"
  log_success "Added ${target_user} to docker group"

  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi

  log_info "${target_user} must log out/in (or reboot) before running docker without sudo."
}

log_info "Updating package index..."
apt-get update -y
log_success "Package index updated"

log_info "Installing Git and Docker Compose..."
if apt-cache show docker-compose >/dev/null 2>&1; then
  apt-get install -y git docker-compose
else
  apt-get install -y git docker-compose-plugin

  # Optional compatibility wrapper for environments that expect `docker-compose`.
  if ! command -v docker-compose >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
    cat >/usr/local/bin/docker-compose <<'EOF'
#!/usr/bin/env bash
exec docker compose "$@"
EOF
    chmod +x /usr/local/bin/docker-compose
  fi
fi

#chmod 660 /var/run/docker.sock
log_success "Git and Docker Compose installed"

configure_non_root_docker


log_info "Installing and configuring UFW..."
apt-get install -y ufw
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
log_success "UFW enabled with allowed ports: 22, 80, 443"


SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_TEMPLATE="${PROJECT_ROOT}/.env.template"
ENV_FILE="${PROJECT_ROOT}/.env"

DJANGO_ENV_TEMPLATE="${PROJECT_ROOT}/django.env.template"
DJANGO_ENV_FILE="${PROJECT_ROOT}/django.env"

ensure_file_from_template "${ENV_FILE}" "${ENV_TEMPLATE}"
ensure_file_from_template "${DJANGO_ENV_FILE}" "${DJANGO_ENV_TEMPLATE}"

replace_tildes_with_random_chars "${ENV_FILE}"
replace_tildes_with_random_chars "${DJANGO_ENV_FILE}"

chown progeo:progeo "${ENV_FILE}" "${DJANGO_ENV_FILE}"

log_success "Done. Installed Git, Docker Compose, configured non-root Docker access, and set UFW (22, 80, 443)."