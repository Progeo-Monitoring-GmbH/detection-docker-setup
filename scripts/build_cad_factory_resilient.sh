#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${ROOT_DIR}/.build-state"
PID_FILE="${STATE_DIR}/cad_factory_build.pid"
LOG_FILE="${STATE_DIR}/cad_factory_build.log"

mkdir -p "${STATE_DIR}"

is_running() {
  if [[ ! -f "${PID_FILE}" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "${PID_FILE}")"
  if [[ -z "${pid}" ]]; then
    return 1
  fi

  kill -0 "${pid}" >/dev/null 2>&1
}

start_build() {
  if is_running; then
    echo "progeo-cad_factory build is already running with PID $(cat "${PID_FILE}")."
    echo "Log file: ${LOG_FILE}"
    exit 0
  fi

  : > "${LOG_FILE}"

  # Build in a detached process so it survives SSH disconnects.
  nohup bash -lc "cd '${ROOT_DIR}' && DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1 docker compose build --progress=plain progeo-cad_factory" \
    >"${LOG_FILE}" 2>&1 &

  echo "$!" > "${PID_FILE}"

  echo "Started progeo-cad_factory build in background."
  echo "PID: $(cat "${PID_FILE}")"
  echo "Log file: ${LOG_FILE}"
  echo "Use: $0 status"
  echo "Use: $0 logs"
}

status_build() {
  if is_running; then
    echo "progeo-cad_factory build is running (PID $(cat "${PID_FILE}"))."
    echo "Log file: ${LOG_FILE}"
    exit 0
  fi

  if [[ -f "${PID_FILE}" ]]; then
    echo "progeo-cad_factory build is not running (stale PID file found)."
    rm -f "${PID_FILE}"
  else
    echo "progeo-cad_factory build is not running."
  fi

  if [[ -f "${LOG_FILE}" ]]; then
    echo "Last 20 log lines:"
    tail -n 20 "${LOG_FILE}"
  fi
}

logs_build() {
  if [[ ! -f "${LOG_FILE}" ]]; then
    echo "No log file yet: ${LOG_FILE}"
    exit 1
  fi

  tail -f "${LOG_FILE}"
}

stop_build() {
  if ! is_running; then
    echo "No running cad_factory build found."
    rm -f "${PID_FILE}"
    exit 0
  fi

  local pid
  pid="$(cat "${PID_FILE}")"
  kill "${pid}"
  rm -f "${PID_FILE}"
  echo "Stopped progeo-cad_factory build (PID ${pid})."
}

usage() {
  cat <<'EOF'
Usage:
  bash scripts/build_cad_factory_resilient.sh start
  bash scripts/build_cad_factory_resilient.sh status
  bash scripts/build_cad_factory_resilient.sh logs
  bash scripts/build_cad_factory_resilient.sh stop

Commands:
  start   Start docker compose build progeo-cad_factory in background (SSH-safe).
  status  Show whether the build process is still running.
  logs    Follow build logs.
  stop    Stop a running background build.
EOF
}

cmd="${1:-}"
case "${cmd}" in
  start)
    start_build
    ;;
  status)
    status_build
    ;;
  logs)
    logs_build
    ;;
  stop)
    stop_build
    ;;
  *)
    usage
    exit 1
    ;;
esac
