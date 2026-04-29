#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Error: run as root (sudo)." >&2
  exit 1
fi

SERVER=""
REMOTE_PORT=""
SSH_PORT="22"
LOCAL_PORT="22"
REMOTE_BIND_ADDRESS="127.0.0.1"
KEY_PATH="/root/.ssh/id_reverse_shell"
SERVICE_NAME="reverse-ssh-shell"
INSTALL_KEY="0"

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/setup_reverse_ssh_shell.sh \
    --server <user@host> \
    --remote-port <port> \
    [--ssh-port <port>] \
    [--local-port <port>] \
    [--remote-bind-address <ip>] \
    [--key-path <path>] \
    [--service-name <name>] \
    [--install-key]

Description:
  Creates a persistent reverse SSH tunnel with autossh and systemd.
  The tunnel forwards <remote-bind-address>:<remote-port> on the remote host
  to localhost:<local-port> on this machine.

Examples:
  sudo bash scripts/setup_reverse_ssh_shell.sh \
    --server ubuntu@example.com \
    --remote-port 22022

  sudo bash scripts/setup_reverse_ssh_shell.sh \
    --server ubuntu@example.com \
    --remote-port 22022 \
    --local-port 22 \
    --remote-bind-address 127.0.0.1 \
    --install-key
EOF
}

fatal() {
  echo "Error: $1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)
      SERVER="${2:-}"
      shift 2
      ;;
    --remote-port)
      REMOTE_PORT="${2:-}"
      shift 2
      ;;
    --ssh-port)
      SSH_PORT="${2:-}"
      shift 2
      ;;
    --local-port)
      LOCAL_PORT="${2:-}"
      shift 2
      ;;
    --remote-bind-address)
      REMOTE_BIND_ADDRESS="${2:-}"
      shift 2
      ;;
    --key-path)
      KEY_PATH="${2:-}"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="${2:-}"
      shift 2
      ;;
    --install-key)
      INSTALL_KEY="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fatal "Unknown argument: $1"
      ;;
  esac
done

[[ -n "${SERVER}" ]] || fatal "--server is required"
[[ -n "${REMOTE_PORT}" ]] || fatal "--remote-port is required"

[[ "${REMOTE_PORT}" =~ ^[0-9]+$ ]] || fatal "--remote-port must be numeric"
[[ "${SSH_PORT}" =~ ^[0-9]+$ ]] || fatal "--ssh-port must be numeric"
[[ "${LOCAL_PORT}" =~ ^[0-9]+$ ]] || fatal "--local-port must be numeric"

if (( REMOTE_PORT < 1 || REMOTE_PORT > 65535 )); then
  fatal "--remote-port must be between 1 and 65535"
fi
if (( SSH_PORT < 1 || SSH_PORT > 65535 )); then
  fatal "--ssh-port must be between 1 and 65535"
fi
if (( LOCAL_PORT < 1 || LOCAL_PORT > 65535 )); then
  fatal "--local-port must be between 1 and 65535"
fi

if ! command -v autossh >/dev/null 2>&1; then
  echo "autossh not found. Installing..."
  apt-get update -y
  apt-get install -y autossh
fi

if ! command -v ssh >/dev/null 2>&1; then
  fatal "ssh client is not installed"
fi

KEY_DIR="$(dirname "${KEY_PATH}")"
mkdir -p "${KEY_DIR}"
chmod 700 "${KEY_DIR}"

if [[ ! -f "${KEY_PATH}" ]]; then
  ssh-keygen -t ed25519 -N "" -f "${KEY_PATH}" -C "${SERVICE_NAME}@$(hostname)"
  echo "Created SSH key: ${KEY_PATH}"
fi

chmod 600 "${KEY_PATH}"

if [[ "${INSTALL_KEY}" == "1" ]]; then
  if command -v ssh-copy-id >/dev/null 2>&1; then
    ssh-copy-id -i "${KEY_PATH}.pub" -p "${SSH_PORT}" "${SERVER}"
  else
    echo "ssh-copy-id not found. Install openssh-client or add this key manually on remote host:"
    cat "${KEY_PATH}.pub"
    exit 1
  fi
fi

ssh -i "${KEY_PATH}" -p "${SSH_PORT}" \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=accept-new \
  "${SERVER}" "echo 'SSH connectivity OK'" >/dev/null

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

cat >"${SERVICE_FILE}" <<EOF
[Unit]
Description=Persistent reverse SSH shell tunnel (${SERVICE_NAME})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=AUTOSSH_GATETIME=0
Environment=AUTOSSH_PORT=0
ExecStart=/usr/bin/autossh -M 0 -N \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=accept-new \
  -i ${KEY_PATH} \
  -p ${SSH_PORT} \
  -R ${REMOTE_BIND_ADDRESS}:${REMOTE_PORT}:localhost:${LOCAL_PORT} \
  ${SERVER}
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

chmod 644 "${SERVICE_FILE}"

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

echo "Reverse SSH service configured and started."
echo "Service: ${SERVICE_NAME}.service"
echo "Remote access endpoint: ${REMOTE_BIND_ADDRESS}:${REMOTE_PORT} on host from --server"
echo "View logs: journalctl -u ${SERVICE_NAME}.service -f"
