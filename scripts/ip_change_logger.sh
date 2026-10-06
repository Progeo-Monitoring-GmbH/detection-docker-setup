#!/usr/bin/env bash
set -euo pipefail

# Logs the Raspberry Pi's uplink IP to logs/backend/IP.txt whenever it changes,
# together with a timestamp and an internet connectivity check.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_FILE="${PROJECT_ROOT}/logs/backend/IP.txt"
SERVICE_NAME="progeo-ip-logger"
INTERVAL="30"
PING_HOSTS=("8.8.8.8" "1.1.1.1")
HTTP_CHECK_URL="http://connectivitycheck.gstatic.com/generate_204"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/ip_change_logger.sh [--interval <seconds>] [--once]
  sudo bash scripts/ip_change_logger.sh --install [--interval <seconds>]
  sudo bash scripts/ip_change_logger.sh --uninstall

Description:
  Watches the IP of the interface that carries the default route (the uplink,
  so the Pi's own Wi-Fi hotspot address is ignored). On start and on every
  change a line is appended to logs/backend/IP.txt:

    2026-10-06 07:40:12 +0200  ip=192.168.1.23  iface=eth0  internet=ok (ping 8.8.8.8, 18 ms)

Options:
  --interval <seconds>  Poll interval (default: 30).
  --once                Log the current state once and exit.
  --install             Install and start a systemd service (runs at boot).
  --uninstall           Stop and remove the systemd service.
EOF
}

fatal() {
  echo "Error: $1" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fatal "run as root (sudo) to $1 the service."
  fi
}

# Prints "<ip> <iface>" of the default route, or "none -" without uplink.
current_uplink() {
  local route
  route="$(ip -4 route get 8.8.8.8 2>/dev/null | head -n 1 || true)"
  local ip iface
  ip="$(sed -n 's/.* src \([0-9.]*\).*/\1/p' <<<"${route}")"
  iface="$(sed -n 's/.* dev \([^ ]*\).*/\1/p' <<<"${route}")"
  echo "${ip:-none} ${iface:--}"
}

# Prints "ok (...)" or "FAILED (...)". Ping first; some mobile/corporate
# networks block ICMP, so fall back to an HTTP request before giving up.
internet_status() {
  local host output rtt
  for host in "${PING_HOSTS[@]}"; do
    if output="$(ping -c 1 -W 3 "${host}" 2>/dev/null)"; then
      rtt="$(sed -n 's/.*time=\([0-9.]*\) ms.*/\1/p' <<<"${output}")"
      echo "ok (ping ${host}, ${rtt:-?} ms)"
      return
    fi
  done

  if command -v curl >/dev/null 2>&1 &&
    [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${HTTP_CHECK_URL}" || true)" == "204" ]]; then
    echo "ok (http, ping blocked)"
    return
  fi

  if getent hosts google.com >/dev/null 2>&1; then
    echo "FAILED (dns ok, no ping/http)"
  else
    echo "FAILED (no dns, no ping)"
  fi
}

log_line() {
  local ip="$1" iface="$2"
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S %z')  ip=${ip}  iface=${iface}  internet=$(internet_status)"
  mkdir -p "$(dirname "${LOG_FILE}")"
  echo "${line}" >>"${LOG_FILE}"
  echo "${line}"
}

watch_loop() {
  local last="" ip iface
  while true; do
    read -r ip iface < <(current_uplink)
    if [[ "${ip} ${iface}" != "${last}" ]]; then
      log_line "${ip}" "${iface}"
      last="${ip} ${iface}"
    fi
    sleep "${INTERVAL}"
  done
}

install_service() {
  require_root "install"
  local unit="/etc/systemd/system/${SERVICE_NAME}.service"
  cat >"${unit}" <<EOF
[Unit]
Description=ProGeo IP change logger (writes ${LOG_FILE})
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env bash ${SCRIPT_DIR}/ip_change_logger.sh --interval ${INTERVAL}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}.service"
  echo "Installed ${unit}; logging to ${LOG_FILE}"
  echo "Status: systemctl status ${SERVICE_NAME}"
}

uninstall_service() {
  require_root "uninstall"
  systemctl disable --now "${SERVICE_NAME}.service" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  echo "Removed ${SERVICE_NAME} service."
}

MODE="watch"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)
      INTERVAL="${2:-}"
      shift 2
      ;;
    --once)
      MODE="once"
      shift
      ;;
    --install)
      MODE="install"
      shift
      ;;
    --uninstall)
      MODE="uninstall"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fatal "unknown argument: $1"
      ;;
  esac
done

[[ "${INTERVAL}" =~ ^[1-9][0-9]*$ ]] || fatal "--interval must be a positive integer."

case "${MODE}" in
  install) install_service ;;
  uninstall) uninstall_service ;;
  once)
    read -r ip iface < <(current_uplink)
    log_line "${ip}" "${iface}"
    ;;
  watch) watch_loop ;;
esac
