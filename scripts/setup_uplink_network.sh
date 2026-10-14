#!/usr/bin/env bash
set -euo pipefail

# Uplink (wired) network for the Raspberry Pi: DHCP first, static fallback.
#
# The interface always tries DHCP first. When no DHCP server answers, the
# static address from .env is used instead. A systemd timer keeps checking
# for a DHCP server while the static address is active and switches back to
# DHCP as soon as one answers (e.g. the router booted after the Pi).
#
# Supported network stacks: NetworkManager (Raspberry Pi OS Bookworm and
# newer) and dhcpcd (Bullseye and older).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"
PROBE_SCRIPT="${SCRIPT_DIR}/dhcp_probe.py"

SERVICE_NAME="progeo-uplink-fallback"
NM_DHCP_PROFILE="progeo-uplink-dhcp"
NM_STATIC_PROFILE="progeo-uplink-static"
DHCPCD_CONF="/etc/dhcpcd.conf"
DHCPCD_BEGIN="# BEGIN progeo-uplink-fallback"
DHCPCD_END="# END progeo-uplink-fallback"
# Seconds to wait for a DHCP lease before falling back to the static address.
DHCP_TIMEOUT="30"
CHECK_INTERVAL="5min"

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/setup_uplink_network.sh             Configure and apply
  sudo bash scripts/setup_uplink_network.sh --check     Switch back to DHCP if a server answers
  sudo bash scripts/setup_uplink_network.sh --uninstall Remove the configuration (plain DHCP again)

Values are read from .env (missing keys are added with their defaults):
  UPLINK_INTERFACE        wired interface, e.g. eth0
  UPLINK_STATIC_IP        fallback address when no DHCP server answers
  UPLINK_STATIC_NETMASK   e.g. 255.255.240.0
  UPLINK_STATIC_GATEWAY   must be inside the fallback subnet
  UPLINK_STATIC_DNS       optional, space separated; empty = no DNS server
EOF
}

fatal() {
  echo "Error: $1" >&2
  exit 1
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || fatal "run this script as root (use sudo)."
}

has_service() {
  systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$1.service"
}

network_stack() {
  if systemctl --quiet is-active NetworkManager 2>/dev/null; then
    echo "networkmanager"
  elif has_service "dhcpcd" && [[ -f "${DHCPCD_CONF}" ]]; then
    echo "dhcpcd"
  else
    echo "unsupported"
  fi
}

# ---------------------------------------------------------------------------
# .env
# ---------------------------------------------------------------------------

ensure_env_defaults() {
  [[ -f "${ENV_FILE}" ]] || fatal "${ENV_FILE} not found (run scripts/setup_system.sh first)."
  local added=0 entry key
  for entry in \
    "UPLINK_INTERFACE=eth0" \
    "UPLINK_STATIC_IP=192.168.14.85" \
    "UPLINK_STATIC_NETMASK=255.255.240.0" \
    "UPLINK_STATIC_GATEWAY=255.255.0.1" \
    "UPLINK_STATIC_DNS="; do
    key="${entry%%=*}"
    if ! grep -q "^${key}=" "${ENV_FILE}"; then
      if (( added == 0 )); then
        printf '\n# Uplink network: DHCP first, static fallback (scripts/setup_uplink_network.sh)\n' >>"${ENV_FILE}"
      fi
      echo "${entry}" >>"${ENV_FILE}"
      echo "Added ${entry} to ${ENV_FILE}"
      added=1
    fi
  done
}

load_env() {
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
  IFACE="${UPLINK_INTERFACE:-eth0}"
  STATIC_IP="${UPLINK_STATIC_IP:-}"
  NETMASK="${UPLINK_STATIC_NETMASK:-}"
  GATEWAY="${UPLINK_STATIC_GATEWAY:-}"
  DNS="${UPLINK_STATIC_DNS:-}"
}

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

is_ipv4() {
  local ip="$1" octet
  [[ "${ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  for octet in ${ip//./ }; do
    (( 10#${octet} <= 255 )) || return 1
  done
}

ip_to_int() {
  local a b c d
  IFS=. read -r a b c d <<<"$1"
  echo $(( (10#$a << 24) | (10#$b << 16) | (10#$c << 8) | 10#$d ))
}

int_to_ip() {
  local n="$1"
  echo "$(( (n >> 24) & 255 )).$(( (n >> 16) & 255 )).$(( (n >> 8) & 255 )).$(( n & 255 ))"
}

# Prints the prefix length of a netmask, fails for non-contiguous masks.
netmask_to_prefix() {
  local mask prefix=0
  mask="$(ip_to_int "$1")"
  while (( prefix < 32 && (mask >> (31 - prefix)) & 1 )); do
    prefix=$(( prefix + 1 ))
  done
  (( mask == ((0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF) )) || return 1
  echo "${prefix}"
}

validate_config() {
  [[ -d "/sys/class/net/${IFACE}" ]] || fatal "interface ${IFACE} not found (UPLINK_INTERFACE)."
  is_ipv4 "${STATIC_IP}" || fatal "UPLINK_STATIC_IP is not a valid IPv4 address: '${STATIC_IP}'."
  is_ipv4 "${NETMASK}" || fatal "UPLINK_STATIC_NETMASK is not a valid IPv4 netmask: '${NETMASK}'."
  is_ipv4 "${GATEWAY}" || fatal "UPLINK_STATIC_GATEWAY is not a valid IPv4 address: '${GATEWAY}'."
  PREFIX="$(netmask_to_prefix "${NETMASK}")" || fatal "UPLINK_STATIC_NETMASK is not a contiguous netmask: '${NETMASK}'."

  local dns
  for dns in ${DNS}; do
    is_ipv4 "${dns}" || fatal "UPLINK_STATIC_DNS contains an invalid address: '${dns}'."
  done

  local mask network broadcast gateway
  mask="$(ip_to_int "${NETMASK}")"
  network=$(( $(ip_to_int "${STATIC_IP}") & mask ))
  broadcast=$(( network | (~mask & 0xFFFFFFFF) ))
  gateway="$(ip_to_int "${GATEWAY}")"
  if (( (gateway & mask) != network || gateway == network || gateway == broadcast )); then
    fatal "UPLINK_STATIC_GATEWAY ${GATEWAY} is not reachable from ${STATIC_IP}/${PREFIX} (usable range $(int_to_ip $(( network + 1 ))) - $(int_to_ip $(( broadcast - 1 ))))."
  fi
}

# ---------------------------------------------------------------------------
# NetworkManager: two profiles on the interface. The DHCP profile has the
# higher autoconnect priority and gives up after one failed attempt, so NM
# then activates the static profile.
# ---------------------------------------------------------------------------

nm_profile_exists() {
  nmcli -t -f NAME connection show | grep -qx "$1"
}

nm_disable_other_profiles() {
  local uuid type name ifname
  while IFS=: read -r uuid type; do
    [[ "${type}" == "802-3-ethernet" ]] || continue
    name="$(nmcli -g connection.id connection show "${uuid}")"
    [[ "${name}" == "${NM_DHCP_PROFILE}" || "${name}" == "${NM_STATIC_PROFILE}" ]] && continue
    ifname="$(nmcli -g connection.interface-name connection show "${uuid}")"
    if [[ -z "${ifname}" || "${ifname}" == "${IFACE}" ]]; then
      nmcli connection modify "${uuid}" connection.autoconnect no
      echo "Disabled autoconnect of existing profile '${name}' (replaced by ${NM_DHCP_PROFILE})"
    fi
  done < <(nmcli -t -f UUID,TYPE connection show)
}

# Creates the profile or updates it in place: nm_upsert <name> <setting value>...
nm_upsert() {
  local name="$1"
  shift
  if nm_profile_exists "${name}"; then
    nmcli connection modify "${name}" "$@"
  else
    nmcli connection add type ethernet con-name "${name}" "$@"
  fi
}

nm_configure() {
  nm_upsert "${NM_DHCP_PROFILE}" \
    connection.interface-name "${IFACE}" \
    connection.autoconnect yes \
    connection.autoconnect-priority 100 \
    connection.autoconnect-retries 1 \
    ipv4.method auto \
    ipv4.dhcp-timeout "${DHCP_TIMEOUT}" \
    ipv4.may-fail no

  nm_upsert "${NM_STATIC_PROFILE}" \
    connection.interface-name "${IFACE}" \
    connection.autoconnect yes \
    connection.autoconnect-priority 50 \
    ipv4.method manual \
    ipv4.addresses "${STATIC_IP}/${PREFIX}" \
    ipv4.gateway "${GATEWAY}" \
    ipv4.dns "${DNS}"

  nm_disable_other_profiles

  echo "Activating ${NM_DHCP_PROFILE} (waiting up to ${DHCP_TIMEOUT}s for DHCP)..."
  if ! nmcli --wait $(( DHCP_TIMEOUT + 15 )) connection up "${NM_DHCP_PROFILE}"; then
    echo "No DHCP lease, activating static fallback ${STATIC_IP}/${PREFIX}..."
    nmcli connection up "${NM_STATIC_PROFILE}"
  fi
}

nm_switch_to_dhcp() {
  if ! nmcli --wait $(( DHCP_TIMEOUT + 15 )) connection up "${NM_DHCP_PROFILE}"; then
    echo "DHCP activation failed, staying on the static fallback."
    nmcli connection up "${NM_STATIC_PROFILE}"
    return 1
  fi
}

nm_uninstall() {
  local profile uuid type
  for profile in "${NM_DHCP_PROFILE}" "${NM_STATIC_PROFILE}"; do
    if nm_profile_exists "${profile}"; then
      nmcli connection delete "${profile}"
    fi
  done
  while IFS=: read -r uuid type; do
    [[ "${type}" == "802-3-ethernet" ]] && nmcli connection modify "${uuid}" connection.autoconnect yes
  done < <(nmcli -t -f UUID,TYPE connection show)
  if ! nmcli -t -f DEVICE,STATE device status | grep -qx "${IFACE}:connected"; then
    nmcli device connect "${IFACE}" || true
  fi
}

# ---------------------------------------------------------------------------
# dhcpcd: native "fallback" profile. dhcpcd stops asking for DHCP once the
# fallback is active, so the timer rebinds when a server shows up.
# ---------------------------------------------------------------------------

dhcpcd_remove_block() {
  sed -i "/^${DHCPCD_BEGIN}\$/,/^${DHCPCD_END}\$/d" "${DHCPCD_CONF}"
}

dhcpcd_configure() {
  [[ -f "${DHCPCD_CONF}.progeo.orig" ]] || cp "${DHCPCD_CONF}" "${DHCPCD_CONF}.progeo.orig"
  dhcpcd_remove_block
  {
    echo "${DHCPCD_BEGIN}"
    echo "profile progeo_static_${IFACE}"
    echo "static ip_address=${STATIC_IP}/${PREFIX}"
    echo "static routers=${GATEWAY}"
    [[ -n "${DNS}" ]] && echo "static domain_name_servers=${DNS}"
    echo ""
    echo "interface ${IFACE}"
    echo "fallback progeo_static_${IFACE}"
    echo "timeout ${DHCP_TIMEOUT}"
    echo "${DHCPCD_END}"
  } >>"${DHCPCD_CONF}"

  echo "Restarting dhcpcd (DHCP first, static fallback after ${DHCP_TIMEOUT}s)..."
  systemctl restart dhcpcd
}

dhcpcd_switch_to_dhcp() {
  dhcpcd --rebind "${IFACE}"
}

dhcpcd_uninstall() {
  dhcpcd_remove_block
  systemctl restart dhcpcd
}

# ---------------------------------------------------------------------------
# Timer that switches back to DHCP when a server appears
# ---------------------------------------------------------------------------

install_timer() {
  cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=ProGeo uplink: switch from static fallback back to DHCP when available
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash ${SCRIPT_DIR}/setup_uplink_network.sh --check
EOF

  cat >"/etc/systemd/system/${SERVICE_NAME}.timer" <<EOF
[Unit]
Description=Periodically look for a DHCP server while the static fallback is active

[Timer]
OnBootSec=2min
OnUnitActiveSec=${CHECK_INTERVAL}

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}.timer" >/dev/null
}

uninstall_timer() {
  systemctl disable --now "${SERVICE_NAME}.timer" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}.timer"
  systemctl daemon-reload
}

# ---------------------------------------------------------------------------

static_fallback_active() {
  ip -4 -o addr show dev "${IFACE}" | grep -q " inet ${STATIC_IP}/"
}

run_check() {
  if ! static_fallback_active; then
    echo "${IFACE} is not on the static fallback, nothing to do."
    return 0
  fi
  if ! python3 "${PROBE_SCRIPT}" "${IFACE}" 5; then
    echo "Staying on static fallback ${STATIC_IP}."
    return 0
  fi
  echo "DHCP server found, switching ${IFACE} back to DHCP..."
  case "$1" in
    networkmanager) nm_switch_to_dhcp ;;
    dhcpcd) dhcpcd_switch_to_dhcp ;;
  esac
}

print_state() {
  echo ""
  ip -4 -o addr show dev "${IFACE}" | awk '{print "Current address on " $2 ": " $4}' || true
  if static_fallback_active; then
    echo "Mode: static fallback (no DHCP server answered)"
  else
    echo "Mode: DHCP"
  fi
}

MODE="setup"
case "${1:-}" in
  "") ;;
  --check) MODE="check" ;;
  --uninstall) MODE="uninstall" ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; fatal "unknown argument: $1" ;;
esac

require_root
STACK="$(network_stack)"
[[ "${STACK}" != "unsupported" ]] || fatal "neither NetworkManager nor dhcpcd is in use, cannot configure ${IFACE:-the uplink}."

case "${MODE}" in
  setup)
    ensure_env_defaults
    load_env
    validate_config
    echo "Configuring ${IFACE} via ${STACK}: DHCP first, fallback ${STATIC_IP}/${PREFIX} gw ${GATEWAY}${DNS:+ dns ${DNS}}"
    case "${STACK}" in
      networkmanager) nm_configure ;;
      dhcpcd) dhcpcd_configure ;;
    esac
    install_timer
    print_state
    echo "A DHCP server is checked for every ${CHECK_INTERVAL} while the fallback is active (${SERVICE_NAME}.timer)."
    ;;
  check)
    load_env
    run_check "${STACK}"
    ;;
  uninstall)
    load_env
    uninstall_timer
    case "${STACK}" in
      networkmanager) nm_uninstall ;;
      dhcpcd) dhcpcd_uninstall ;;
    esac
    echo "Removed static fallback; ${IFACE} uses plain DHCP again."
    ;;
esac
