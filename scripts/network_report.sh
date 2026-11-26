#!/usr/bin/env bash
set -uo pipefail

# Network diagnostics report for the wired uplink of the Raspberry Pi.
#
# Collects everything a network admin needs to see why the device is not
# reachable (by IP or by hostname): link, addresses, DHCP, DNS registration,
# name services (mDNS/LLMNR/NetBIOS), firewall, IP conflicts and - if the
# switch announces it via LLDP/CDP - the switch port the cable is plugged in.
# The automated findings are listed at the top of the report, the raw command
# output follows below.
#
# Nothing on the host is reconfigured; the DHCP probe does not take a lease.
# No `set -e`: a failing check must never stop the report.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"
PROBE_SCRIPT="${SCRIPT_DIR}/dhcp_probe.py"
REPORT_DIR="${PROJECT_ROOT}/logs/network_report"
# Copy on the FAT boot partition: readable on any Windows PC from the SD card.
BOOT_COPY_NAME="network_report.txt"
KEEP_REPORTS=20
SERVICE_NAME="progeo-network-report"
# LLDP is sent every 30 s, CDP every 60 s - listen a bit longer than that.
CAPTURE_SECONDS=65
CMD_TIMEOUT=20
OPTIONAL_PACKAGES=(ethtool tcpdump iputils-arping dnsutils avahi-utils)

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/network_report.sh               Write a report now (takes ~2 min)
  sudo bash scripts/network_report.sh --install     Run once after every boot (systemd timer)
  sudo bash scripts/network_report.sh --uninstall   Remove the timer

Reports are written to logs/network_report/ (latest.txt = newest) and, on a
Raspberry Pi, copied to the boot partition as network_report.txt, so they can
be read by putting the SD card into any PC.

The interface and the expected static address come from .env
(UPLINK_INTERFACE, UPLINK_STATIC_IP, UPLINK_STATIC_NETMASK, UPLINK_STATIC_GATEWAY).
The site hosts to search for come from NET_REPORT_TARGETS, NET_REPORT_TARGET_GATEWAY,
NET_REPORT_TARGET_DNS and NET_REPORT_TARGET_PORTS (see .env.template).
EOF
}

fatal() {
  echo "Error: $1" >&2
  exit 1
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || fatal "run this script as root (use sudo)."
}

load_env() {
  if [[ -f "${ENV_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
  fi
  IFACE="${UPLINK_INTERFACE:-eth0}"
  STATIC_IP="${UPLINK_STATIC_IP:-}"
  STATIC_NETMASK="${UPLINK_STATIC_NETMASK:-}"
  STATIC_GATEWAY="${UPLINK_STATIC_GATEWAY:-}"
  # Known hosts of the site network the Pi should reach (space separated).
  TARGET_SERVERS="${NET_REPORT_TARGETS-192.168.11.211 192.168.11.9 10.35.252.13}"
  TARGET_GATEWAY="${NET_REPORT_TARGET_GATEWAY-10.35.252.1}"
  TARGET_DNS="${NET_REPORT_TARGET_DNS-10.174.0.8 10.174.0.40}"
  TARGET_PORTS="${NET_REPORT_TARGET_PORTS:-22 80 443 445 3389 5432 8080}"
}

# ---------------------------------------------------------------------------
# IPv4 helpers
# ---------------------------------------------------------------------------

is_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

ip_to_int() {
  local a b c d
  IFS=. read -r a b c d <<<"$1"
  echo $(( (10#$a << 24) | (10#$b << 16) | (10#$c << 8) | 10#$d ))
}

prefix_to_mask_int() {
  echo $(( (0xFFFFFFFF << (32 - $1)) & 0xFFFFFFFF ))
}

netmask_to_prefix() {
  local mask prefix=0
  mask="$(ip_to_int "$1")"
  while (( prefix < 32 && (mask >> (31 - prefix)) & 1 )); do
    prefix=$(( prefix + 1 ))
  done
  echo "${prefix}"
}

# same_subnet <ip> <ip> <prefix>
same_subnet() {
  local mask
  mask="$(prefix_to_mask_int "$3")"
  (( ($(ip_to_int "$1") & mask) == ($(ip_to_int "$2") & mask) ))
}

# ---------------------------------------------------------------------------
# Report building blocks
# ---------------------------------------------------------------------------

FINDINGS=()

# finding <OK|INFO|WARN|FAIL> <text>
finding() {
  FINDINGS+=("$(printf '[%-4s] %s' "$1" "$2")")
}

section() {
  printf '\n%s\n== %s\n%s\n\n' "${RULE}" "$1" "${RULE}" >>"${BODY}"
}

# run <command> [args...]: command line and its output (stdout + stderr).
run() {
  local rc
  echo "\$ $*" >>"${BODY}"
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '(%s is not installed)\n\n' "$1" >>"${BODY}"
    return 127
  fi
  timeout "${CMD_TIMEOUT}" "$@" >>"${BODY}" 2>&1
  rc=$?
  (( rc == 0 )) || echo "(exit code ${rc})" >>"${BODY}"
  echo >>"${BODY}"
  return "${rc}"
}

# run_sh '<pipeline>': like run, for shell pipelines.
run_sh() {
  local rc
  echo "\$ $1" >>"${BODY}"
  timeout "${CMD_TIMEOUT}" bash -c "$1" >>"${BODY}" 2>&1
  rc=$?
  (( rc == 0 )) || echo "(exit code ${rc})" >>"${BODY}"
  echo >>"${BODY}"
  return "${rc}"
}

show_file() {
  if [[ -f "$1" ]]; then
    printf -- '--- %s ---\n' "$1" >>"${BODY}"
    cat "$1" >>"${BODY}" 2>&1
    echo >>"${BODY}"
  else
    printf -- '--- %s (not present) ---\n\n' "$1" >>"${BODY}"
  fi
}

# dns_query <A|PTR> <name|ip> <server>: one answer per line, nothing on failure.
dns_query() {
  command -v dig >/dev/null 2>&1 || return 1
  if [[ "$1" == "PTR" ]]; then
    dig +short +time=3 +tries=1 -x "$2" @"$3" 2>/dev/null
  else
    dig +short +time=3 +tries=1 A "$2" @"$3" 2>/dev/null
  fi | grep -v '^;;' | grep -v '^$'
}

# ---------------------------------------------------------------------------
# Collection
# ---------------------------------------------------------------------------

start_capture() {
  CAPTURE_FILE="$(mktemp)"
  ARP_FILE="$(mktemp)"
  CAPTURE_PID=""
  ARP_PID=""
  if ! command -v tcpdump >/dev/null 2>&1; then
    echo "(tcpdump is not installed - no LLDP/CDP/DHCP capture)" >"${CAPTURE_FILE}"
    return
  fi
  # Separate ARP capture: shows which IP ranges live on this cable/VLAN,
  # without filling up the count limit of the capture below.
  timeout "${CAPTURE_SECONDS}" tcpdump -i "${IFACE}" -nn -l -c 5000 arp >"${ARP_FILE}" 2>/dev/null &
  ARP_PID=$!
  # LLDP, CDP, DHCP, mDNS, LLMNR, NetBIOS name service - all broadcast/multicast,
  # so they are seen without a mirror port.
  timeout "${CAPTURE_SECONDS}" tcpdump -i "${IFACE}" -nn -v -s 1500 -c 400 \
    'ether proto 0x88cc or ether dst 01:00:0c:cc:cc:cc or udp port 67 or udp port 68 or udp port 5353 or udp port 5355 or udp port 137' \
    >"${CAPTURE_FILE}" 2>&1 &
  CAPTURE_PID=$!
}

collect_identity() {
  HOST="$(hostname)"
  FQDN="$(hostname -f 2>/dev/null || echo "${HOST}")"
  MAC="$(cat "/sys/class/net/${IFACE}/address" 2>/dev/null || echo "unknown")"
  read -r CUR_IP CUR_PREFIX < <(ip -4 -o addr show dev "${IFACE}" scope global 2>/dev/null |
    awk 'NR==1 {split($4, a, "/"); print a[1], a[2]}')
  CUR_IP="${CUR_IP:-}"
  CUR_PREFIX="${CUR_PREFIX:-}"
  GATEWAY="$(ip -4 route show default dev "${IFACE}" 2>/dev/null | awk 'NR==1 {print $3}')"
  STACK="none"
  if systemctl --quiet is-active NetworkManager 2>/dev/null; then
    STACK="NetworkManager"
  elif systemctl --quiet is-active dhcpcd 2>/dev/null; then
    STACK="dhcpcd"
  elif systemctl --quiet is-active systemd-networkd 2>/dev/null; then
    STACK="systemd-networkd"
  fi
}

check_link() {
  if [[ ! -d "/sys/class/net/${IFACE}" ]]; then
    finding FAIL "Interface ${IFACE} does not exist (UPLINK_INTERFACE in .env)."
    return 1
  fi
  if [[ "$(cat "/sys/class/net/${IFACE}/carrier" 2>/dev/null)" != "1" ]]; then
    finding FAIL "No link on ${IFACE}: cable unplugged, broken, or switch port disabled."
    return 1
  fi
  local speed duplex rx_errors crc_errors
  speed="$(cat "/sys/class/net/${IFACE}/speed" 2>/dev/null)"
  duplex="$(cat "/sys/class/net/${IFACE}/duplex" 2>/dev/null)"
  finding OK "Link up on ${IFACE}: ${speed:-?} Mbit/s, ${duplex:-?} duplex."
  if [[ "${duplex}" == "half" || "${speed}" == "10" ]]; then
    finding WARN "Link negotiated only ${speed} Mbit/s ${duplex} duplex - check cable or switch port settings."
  fi
  rx_errors="$(cat "/sys/class/net/${IFACE}/statistics/rx_errors" 2>/dev/null || echo 0)"
  crc_errors="$(cat "/sys/class/net/${IFACE}/statistics/rx_crc_errors" 2>/dev/null || echo 0)"
  if (( rx_errors > 0 || crc_errors > 0 )); then
    finding WARN "${rx_errors} receive errors (${crc_errors} CRC) on ${IFACE} - possibly a bad cable."
  fi
}

check_address() {
  if [[ -z "${CUR_IP}" ]]; then
    finding FAIL "${IFACE} has no IPv4 address."
    return 1
  fi
  if [[ "${CUR_IP}" == 169.254.* ]]; then
    finding FAIL "${IFACE} only has a link-local address ${CUR_IP}/${CUR_PREFIX} (no DHCP and no static address)."
    return 1
  fi
  if [[ -n "${STATIC_IP}" && "${CUR_IP}" == "${STATIC_IP}" ]]; then
    finding WARN "${IFACE} uses the STATIC FALLBACK ${CUR_IP}/${CUR_PREFIX}: no DHCP lease was obtained."
  else
    finding INFO "${IFACE} has ${CUR_IP}/${CUR_PREFIX} (not the static fallback, so most likely from DHCP)."
  fi
}

check_dhcp() {
  local output rc offered
  if [[ ! -f "${PROBE_SCRIPT}" ]] || ! command -v python3 >/dev/null 2>&1; then
    finding INFO "DHCP probe skipped (python3 or ${PROBE_SCRIPT} missing)."
    return
  fi
  output="$(python3 "${PROBE_SCRIPT}" "${IFACE}" 8 2>&1)"
  rc=$?
  printf '$ python3 %s %s 8\n%s\n\n' "${PROBE_SCRIPT}" "${IFACE}" "${output}" >>"${BODY}"
  case "${rc}" in
    0)
      finding OK "DHCP server answers: ${output}"
      offered="$(sed -n 's/.*: \([0-9.]*\) from server.*/\1/p' <<<"${output}")"
      if [[ -n "${offered}" && -n "${STATIC_IP}" && -n "${STATIC_NETMASK}" ]] && is_ipv4 "${STATIC_IP}" &&
        ! same_subnet "${offered}" "${STATIC_IP}" "$(netmask_to_prefix "${STATIC_NETMASK}")"; then
        finding WARN "The offered address ${offered} is outside the configured fallback subnet ${STATIC_IP}/${STATIC_NETMASK} - the static values in .env do not match this network."
      fi
      ;;
    1) finding WARN "No DHCP server answered on ${IFACE} within 8 s (no DHCP on this network/VLAN, or the switch port blocks it)." ;;
    *) finding INFO "DHCP probe could not run: ${output}" ;;
  esac
}

check_ip_conflict() {
  local output
  [[ -n "${STATIC_IP}" ]] && is_ipv4 "${STATIC_IP}" || return
  if ! command -v arping >/dev/null 2>&1; then
    finding INFO "IP conflict check skipped (arping not installed)."
    return
  fi
  # Duplicate address detection: sender 0.0.0.0, so only OTHER devices answer.
  output="$(timeout 10 arping -D -I "${IFACE}" -c 3 -w 4 "${STATIC_IP}" 2>&1)"
  local rc=$?
  printf '$ arping -D -I %s -c 3 -w 4 %s\n%s\n\n' "${IFACE}" "${STATIC_IP}" "${output}" >>"${BODY}"
  if (( rc == 1 )) && grep -q 'reply from' <<<"${output}"; then
    finding FAIL "IP CONFLICT: another device answers for ${STATIC_IP}: $(grep -m1 'reply from' <<<"${output}" | sed 's/^ *//')"
  elif (( rc == 0 )); then
    finding OK "No other device uses ${STATIC_IP}."
  fi
}

check_gateway() {
  if [[ -z "${GATEWAY}" ]]; then
    finding FAIL "No default gateway on ${IFACE}."
    return
  fi
  if ping -c 3 -W 2 -I "${IFACE}" "${GATEWAY}" >/dev/null 2>&1; then
    finding OK "Gateway ${GATEWAY} answers ping."
  elif ip neigh show "${GATEWAY}" dev "${IFACE}" 2>/dev/null | grep -q lladdr; then
    finding WARN "Gateway ${GATEWAY} is present (ARP ok) but does not answer ping (ICMP filtered?)."
  else
    finding FAIL "Gateway ${GATEWAY} is not reachable (no ARP reply) - wrong gateway or wrong subnet/VLAN."
  fi
}

check_overlaps() {
  local line ifname cidr ip prefix
  [[ -n "${CUR_IP}" ]] || return
  while read -r ifname cidr; do
    [[ "${ifname}" == "${IFACE}" || "${ifname}" == "lo" ]] && continue
    ip="${cidr%/*}"
    prefix="${cidr#*/}"
    (( prefix < CUR_PREFIX )) || prefix="${CUR_PREFIX}"
    if same_subnet "${ip}" "${CUR_IP}" "${prefix}"; then
      finding FAIL "Subnet of ${ifname} (${cidr}) overlaps with the uplink ${CUR_IP}/${CUR_PREFIX} - replies to those addresses leave via ${ifname} instead of ${IFACE}."
    fi
  done < <(ip -4 -o addr show 2>/dev/null | awk '{print $2, $4}')
}

collect_dns_servers() {
  DNS_SERVERS=()
  SEARCH_DOMAINS=()
  if grep -q '^nameserver 127\.0\.0\.53' /etc/resolv.conf 2>/dev/null && command -v resolvectl >/dev/null 2>&1; then
    read -r -a DNS_SERVERS < <(resolvectl dns "${IFACE}" 2>/dev/null | sed 's/^[^:]*: *//')
    read -r -a SEARCH_DOMAINS < <(resolvectl domain "${IFACE}" 2>/dev/null | sed 's/^[^:]*: *//')
  else
    read -r -a DNS_SERVERS < <(awk '$1 == "nameserver" && $2 !~ /^127\./ {printf "%s ", $2}' /etc/resolv.conf 2>/dev/null)
    read -r -a SEARCH_DOMAINS < <(awk '$1 == "search" || $1 == "domain" {for (i = 2; i <= NF; i++) printf "%s ", $i}' /etc/resolv.conf 2>/dev/null)
  fi
}

check_dns() {
  local ns name answers found_self=0 found_other="" ptr
  collect_dns_servers

  if (( ${#DNS_SERVERS[@]} == 0 )); then
    finding FAIL "No DNS server configured - the device cannot resolve names and cannot check its own DNS record."
    return
  fi
  finding INFO "DNS servers: ${DNS_SERVERS[*]}; search domain(s): ${SEARCH_DOMAINS[*]:-none}."
  if ! command -v dig >/dev/null 2>&1; then
    finding INFO "DNS record checks skipped (dig not installed, package dnsutils)."
    return
  fi

  for ns in "${DNS_SERVERS[@]}"; do
    if [[ -n "$(dns_query A one.one.one.one "${ns}")" ]]; then
      finding OK "DNS server ${ns} answers queries."
    else
      finding FAIL "DNS server ${ns} does not answer."
      continue
    fi
    for name in "${HOST}" "${SEARCH_DOMAINS[@]/#/${HOST}.}"; do
      answers="$(dns_query A "${name}" "${ns}" | tr '\n' ' ')"
      printf 'dig A %s @%s -> %s\n' "${name}" "${ns}" "${answers:-(no record)}" >>"${BODY}"
      if [[ " ${answers} " == *" ${CUR_IP} "* ]]; then
        found_self=1
      elif [[ -n "${answers}" ]]; then
        found_other="${name} -> ${answers}"
      fi
    done
    if [[ -n "${CUR_IP}" ]]; then
      ptr="$(dns_query PTR "${CUR_IP}" "${ns}" | tr '\n' ' ')"
      printf 'dig PTR %s @%s -> %s\n' "${CUR_IP}" "${ns}" "${ptr:-(no record)}" >>"${BODY}"
    fi
  done
  echo >>"${BODY}"

  if (( found_self )); then
    finding OK "DNS resolves the hostname '${HOST}' to ${CUR_IP}."
  elif [[ -n "${found_other}" ]]; then
    finding FAIL "DNS has a WRONG/STALE record: ${found_other} (device is at ${CUR_IP})."
  else
    finding FAIL "The hostname '${HOST}' is NOT registered in DNS${SEARCH_DOMAINS[0]:+ (also not as ${HOST}.${SEARCH_DOMAINS[0]})}. Other devices can only find it via DNS if the DHCP server registers it (dynamic DNS) or the admin adds an A record for ${CUR_IP:-the device}."
  fi
  [[ -n "${ptr:-}" ]] && finding INFO "Reverse DNS of ${CUR_IP}: ${ptr}"
}

check_hostname() {
  if [[ "${HOST}" == "raspberrypi" ]]; then
    finding WARN "Hostname is the default 'raspberrypi' - very likely used by other devices on this network too."
  fi
  if [[ ! "${HOST}" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]]; then
    finding WARN "Hostname '${HOST}' is not a valid DNS name (only letters, digits and '-' allowed)."
  fi
  if [[ "${STACK}" == "NetworkManager" ]]; then
    local con send
    con="$(nmcli -g GENERAL.CONNECTION device show "${IFACE}" 2>/dev/null)"
    if [[ -n "${con}" ]]; then
      send="$(nmcli -g ipv4.dhcp-send-hostname connection show "${con}" 2>/dev/null)"
      if [[ "${send}" == "no" ]]; then
        finding WARN "Profile '${con}' does not send the hostname to the DHCP server, so it cannot be registered in DNS."
      else
        finding INFO "The hostname is sent to the DHCP server (profile '${con}'); registering it in DNS is up to the DHCP/DNS server."
      fi
    fi
  fi
}

ufw_allows_port() {
  ufw status 2>/dev/null | grep -Eq "^$1(/udp)?[[:space:]].*ALLOW"
}

check_name_services() {
  local ufw_active=0
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw_active=1
  fi

  if systemctl --quiet is-active avahi-daemon 2>/dev/null; then
    if (( ufw_active )) && ! ufw_allows_port 5353; then
      finding FAIL "mDNS responder (avahi) runs, but the firewall (ufw) blocks UDP 5353 - '${HOST}.local' cannot be resolved by other devices. Fix: sudo ufw allow 5353/udp"
    else
      finding OK "mDNS responder (avahi) runs - other devices can use '${HOST}.local'."
    fi
  else
    finding WARN "No mDNS responder (avahi-daemon not running) - '${HOST}.local' does not work."
  fi

  if command -v resolvectl >/dev/null 2>&1 && resolvectl status "${IFACE}" 2>/dev/null | grep -q '+LLMNR'; then
    if (( ufw_active )) && ! ufw_allows_port 5355; then
      finding WARN "LLMNR is enabled but ufw blocks UDP 5355 - Windows cannot find '${HOST}' via LLMNR."
    else
      finding INFO "LLMNR responder active (Windows can find '${HOST}' without DNS)."
    fi
  else
    finding INFO "No LLMNR responder - Windows can only find the plain name '${HOST}' via DNS (or '${HOST}.local' via mDNS)."
  fi

  if systemctl --quiet is-active nmbd 2>/dev/null; then
    finding INFO "NetBIOS name service (nmbd) runs."
  fi

  if [[ "$(sysctl -n net.ipv4.icmp_echo_ignore_all 2>/dev/null)" == "1" ]]; then
    finding FAIL "The device ignores ping (net.ipv4.icmp_echo_ignore_all=1)."
  fi
}

check_internet() {
  if ping -c 2 -W 3 8.8.8.8 >/dev/null 2>&1 || ping -c 2 -W 3 1.1.1.1 >/dev/null 2>&1; then
    finding OK "Internet reachable (ping 8.8.8.8 / 1.1.1.1)."
  elif command -v curl >/dev/null 2>&1 &&
    [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://connectivitycheck.gstatic.com/generate_204)" == "204" ]]; then
    finding OK "Internet reachable via HTTP (ICMP to the internet is blocked)."
  else
    finding WARN "No internet access (ping and HTTP failed) - may be intended on this network."
  fi
}

# l2_mac <ip>: prints the MAC if a device with that IP answers ARP on this
# cable/VLAN. The probe uses sender 0.0.0.0 (RFC 5227), so it works no matter
# which address or subnet the Pi itself has.
l2_mac() {
  timeout 6 arping -D -I "${IFACE}" -c 2 -w 3 "$1" 2>/dev/null |
    sed -n 's/.*reply from [0-9.]* \[\([0-9A-Fa-f:]*\)\].*/\1/p' | head -n 1
}

# tcp_probe <ip> <port>: open | closed (host answered with a reset) | filtered | unreachable
tcp_probe() {
  local err rc
  err="$(timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>&1)"
  rc=$?
  if (( rc == 0 )); then
    echo "open"
  elif (( rc == 124 )); then
    echo "filtered"
  elif [[ "${err}" == *"refused"* ]]; then
    echo "closed"
  else
    echo "unreachable"
  fi
}

# check_target <ip> <role>: finds one known host and prints a finding for it.
# Sets TARGET_FOUND_L2 / TARGET_REACHED when the host was seen.
check_target() {
  local ip="$1" role="$2" route path mac="" ping_state="no reply" port state open_ports="" level details
  route="$(ip -4 route get "${ip}" 2>/dev/null | head -n 1)"
  if [[ -z "${route}" ]]; then
    path="no route"
  elif [[ "${route}" == *" via "* ]]; then
    path="routed via $(sed -n 's/.* via \([0-9.]*\).*/\1/p' <<<"${route}")"
  else
    path="same subnet as ${IFACE}"
  fi

  if command -v arping >/dev/null 2>&1; then
    mac="$(l2_mac "${ip}")"
  fi
  if ping -c 2 -W 2 "${ip}" >/dev/null 2>&1; then
    ping_state="ok"
  fi

  if [[ "${role}" == "server" ]]; then
    for port in ${TARGET_PORTS}; do
      state="$(tcp_probe "${ip}" "${port}")"
      printf 'tcp %s:%s -> %s\n' "${ip}" "${port}" "${state}" >>"${BODY}"
      [[ "${state}" == "open" || "${state}" == "closed" ]] && open_ports+="${port}/${state} "
    done
  fi
  printf '%s %s: route "%s", arp %s, ping %s\n' "${role}" "${ip}" "${route:-none}" "${mac:-no reply}" "${ping_state}" >>"${BODY}"

  details="ARP on cable: ${mac:-no}; ping: ${ping_state}; ${path}"
  [[ "${role}" == "server" ]] && details+="; TCP: ${open_ports:-no answer on ${TARGET_PORTS// /,}}"

  if [[ -n "${mac}" ]]; then
    TARGET_FOUND_L2=1
    if [[ -n "${CUR_IP}" ]] && ! same_subnet "${ip}" "${CUR_IP}" "${CUR_PREFIX}"; then
      finding WARN "Site ${role} ${ip} is ON THIS CABLE (MAC ${mac}) but outside the Pi's subnet ${CUR_IP}/${CUR_PREFIX} - the Pi needs an address in the subnet of ${ip}."
    fi
  fi
  if [[ "${ping_state}" == "ok" || -n "${open_ports}" ]]; then
    TARGET_REACHED=1
    level="OK"
  elif [[ -n "${mac}" ]]; then
    level="WARN"
  else
    level="FAIL"
  fi
  finding "${level}" "Site ${role} ${ip}: ${details}."
}

check_targets() {
  local ip ns names answers
  TARGET_FOUND_L2=0
  TARGET_REACHED=0
  [[ -n "${TARGET_SERVERS}${TARGET_GATEWAY}${TARGET_DNS}" ]] || return
  echo "--- site servers (NET_REPORT_*) ---" >>"${BODY}"

  for ip in ${TARGET_SERVERS}; do check_target "${ip}" "server"; done
  for ip in ${TARGET_GATEWAY}; do check_target "${ip}" "gateway"; done
  for ip in ${TARGET_DNS}; do check_target "${ip}" "DNS"; done

  # The site DNS servers know the names of the servers and whether the Pi is registered.
  if command -v dig >/dev/null 2>&1; then
    for ns in ${TARGET_DNS}; do
      # Any DNS response (also NXDOMAIN/REFUSED) proves the server is reachable.
      if ! dig +time=3 +tries=1 @"${ns}" . SOA 2>/dev/null | grep -q 'status:'; then
        finding FAIL "Site DNS ${ns} does not answer DNS queries."
        continue
      fi
      names=""
      for ip in ${TARGET_SERVERS}; do
        answers="$(dns_query PTR "${ip}" "${ns}" | tr '\n' ' ')"
        printf 'dig PTR %s @%s -> %s\n' "${ip}" "${ns}" "${answers:-(no record)}" >>"${BODY}"
        [[ -n "${answers}" ]] && names+="${ip}=${answers% } "
      done
      answers="$(dns_query A "${HOST}" "${ns}" | tr '\n' ' ')"
      printf 'dig A %s @%s -> %s\n' "${HOST}" "${ns}" "${answers:-(no record)}" >>"${BODY}"
      finding INFO "Site DNS ${ns} answers. Server names: ${names:-none known}. Record for '${HOST}': ${answers:-none}."
    done
  fi
  echo >>"${BODY}"

  if (( TARGET_REACHED )); then
    return
  elif (( TARGET_FOUND_L2 )); then
    finding FAIL "Site hosts are on this cable but not reachable: the Pi's address/gateway do not match the site network - ask the admin for a free IP, mask and gateway in that subnet."
  else
    finding FAIL "None of the site hosts (${TARGET_SERVERS} ${TARGET_GATEWAY} ${TARGET_DNS}) answers, not even ARP on the cable - the switch port is most likely in another VLAN, or the hosts are only reachable via a router the Pi does not know."
  fi
}

# Prints the /24 ranges of all senders seen in the ARP capture, most active first.
summarize_arp() {
  [[ -s "${ARP_FILE}" ]] || return
  sed -nE -e 's/.* tell ([0-9.]+).*/\1/p' -e 's/.*Reply ([0-9.]+) is-at.*/\1/p' "${ARP_FILE}" |
    grep -vxF -e "0.0.0.0" -e "${CUR_IP:-0.0.0.0}" | sort -u >"${ARP_FILE}.hosts"
  ARP_RANGES="$(awk -F. '{print $1 "." $2 "." $3 ".x"}' "${ARP_FILE}.hosts" | sort | uniq -c | sort -rn |
    awk '{printf "%s (%s hosts), ", $2, $1}' | sed 's/, $//')"
  local ip
  for ip in ${TARGET_SERVERS} ${TARGET_GATEWAY} ${TARGET_DNS}; do
    if grep -qxF "${ip}" "${ARP_FILE}.hosts"; then
      finding OK "Site host ${ip} was seen talking on this cable (ARP capture)."
    fi
  done
  rm -f "${ARP_FILE}.hosts"
}

finish_capture() {
  if [[ -n "${CAPTURE_PID}" ]]; then
    wait "${CAPTURE_PID}" 2>/dev/null
  fi
  if [[ -n "${ARP_PID}" ]]; then
    wait "${ARP_PID}" 2>/dev/null
  fi
  ARP_RANGES=""
  summarize_arp
  if [[ -n "${ARP_RANGES}" ]]; then
    finding INFO "IP ranges active on this cable/VLAN (ARP, ${CAPTURE_SECONDS} s): ${ARP_RANGES}"
  elif command -v tcpdump >/dev/null 2>&1; then
    finding WARN "No ARP traffic from other devices seen in ${CAPTURE_SECONDS} s - the port may be isolated or an empty VLAN."
  fi
  local switch_info line
  # LLDP: "System Name TLV ... : sw01", "Port Description TLV ... : Gi1/0/12"; CDP: "Device-ID", "Port-ID".
  switch_info="$(grep -E 'System Name TLV|Port Description TLV|Port ID TLV|Device-ID|Port-ID|VLAN' "${CAPTURE_FILE}" |
    sed -e 's/^[[:space:]]*//' | sort -u | head -n 10)"
  if [[ -n "${switch_info}" ]]; then
    finding INFO "Switch announcement (LLDP/CDP) seen - see section 'Traffic capture':"
    while IFS= read -r line; do
      FINDINGS+=("         ${line}")
    done <<<"${switch_info}"
  elif command -v tcpdump >/dev/null 2>&1; then
    finding INFO "The switch did not announce itself (no LLDP/CDP within ${CAPTURE_SECONDS} s) - ask the admin which port MAC ${MAC} is on."
  fi
}

# ---------------------------------------------------------------------------

write_report() {
  RULE="$(printf '=%.0s' {1..78})"
  BODY="$(mktemp)"
  local report timestamp boot_dir
  timestamp="$(date '+%Y%m%d_%H%M%S')"

  collect_identity
  start_capture

  # Order matters: the checks fill the ARP table shown in the raw sections.
  section "Check details"
  if check_link; then
    if check_address; then
      check_gateway
      check_dhcp
      check_ip_conflict
      check_overlaps
      check_hostname
      check_dns
      check_name_services
      check_internet
    else
      check_dhcp
      check_hostname
    fi
    # Also without an address: the ARP probes work independent of the Pi's IP.
    check_targets
  else
    check_hostname
  fi

  section "System"
  run date
  run uptime
  run hostnamectl
  show_file /etc/hostname
  show_file /etc/hosts
  run_sh 'grep "^hosts:" /etc/nsswitch.conf'
  show_file /etc/os-release
  run uname -a

  section "Link (${IFACE})"
  run ip -d link show dev "${IFACE}"
  run ip -s link show dev "${IFACE}"
  run ethtool "${IFACE}"

  section "Addresses, routes, neighbours"
  run ip addr
  run ip route
  run ip -6 route
  run ip rule
  run ip neigh

  section "Network configuration (${STACK})"
  run nmcli general status
  run nmcli device status
  run nmcli connection show
  if [[ "${STACK}" == "NetworkManager" ]]; then
    run nmcli device show "${IFACE}"
    local con
    con="$(nmcli -g GENERAL.CONNECTION device show "${IFACE}" 2>/dev/null)"
    [[ -n "${con}" ]] && run_sh "nmcli connection show '${con}' | grep -E '^(connection|ipv4|ipv6)\\.'"
  fi
  run networkctl status "${IFACE}"
  show_file /etc/dhcpcd.conf
  show_file /etc/network/interfaces
  run_sh "ls -l /var/lib/NetworkManager/*.lease /var/lib/dhcpcd/*.lease 2>/dev/null"
  run_sh "cat /var/lib/NetworkManager/*${IFACE}*.lease 2>/dev/null"
  [[ "${STACK}" == "dhcpcd" ]] && run dhcpcd -U "${IFACE}"

  section "DNS"
  show_file /etc/resolv.conf
  run resolvectl status
  run getent hosts "${HOST}"
  run getent hosts "${FQDN}"
  run getent hosts one.one.one.one

  section "Name services and firewall"
  run systemctl --no-pager status avahi-daemon
  run_sh "ss -ulpn | grep -E ':(5353|5355|137|138) '"
  run ufw status verbose
  run iptables -S INPUT

  section "Reachability"
  [[ -n "${GATEWAY}" ]] && run ping -c 3 -W 2 "${GATEWAY}"
  run ping -c 3 -W 2 8.8.8.8
  run tracepath -n -m 8 8.8.8.8

  section "Logs (this boot)"
  run_sh "journalctl -b --no-pager -u NetworkManager -u dhcpcd -u systemd-networkd -u avahi-daemon | tail -n 150"
  run_sh "journalctl -b --no-pager -k | grep -iE '${IFACE}|link is|duplicate|conflict' | tail -n 50"
  run_sh "cat '${PROJECT_ROOT}/logs/backend/IP.txt' 2>/dev/null | tail -n 30"

  section "Traffic capture (${CAPTURE_SECONDS} s: LLDP, CDP, DHCP, mDNS, LLMNR, NetBIOS)"
  finish_capture
  cat "${CAPTURE_FILE}" >>"${BODY}"
  printf '\n--- ARP (first 200 of %s packets) ---\n' "$(wc -l <"${ARP_FILE}")" >>"${BODY}"
  head -n 200 "${ARP_FILE}" >>"${BODY}"
  rm -f "${CAPTURE_FILE}" "${ARP_FILE}"

  mkdir -p "${REPORT_DIR}"
  report="${REPORT_DIR}/report_${timestamp}.txt"
  {
    echo "NETWORK DIAGNOSTICS REPORT"
    echo "Created: $(date '+%Y-%m-%d %H:%M:%S %z'), uptime $(uptime -p 2>/dev/null)"
    echo
    echo "Device identity (for the network admin)"
    echo "  Hostname:        ${HOST} (FQDN: ${FQDN})"
    echo "  Interface:       ${IFACE}"
    echo "  MAC address:     ${MAC}"
    echo "  Current IPv4:    ${CUR_IP:-none}${CUR_PREFIX:+/${CUR_PREFIX}}"
    echo "  Default gateway: ${GATEWAY:-none}"
    echo "  Network stack:   ${STACK}"
    echo "  Static fallback: ${STATIC_IP:-not configured}${STATIC_NETMASK:+ mask ${STATIC_NETMASK}}${STATIC_GATEWAY:+ gw ${STATIC_GATEWAY}} (from .env)"
    echo "  Looking for:     servers ${TARGET_SERVERS:-none}, gateway ${TARGET_GATEWAY:-none}, DNS ${TARGET_DNS:-none}"
    echo
    echo "Findings"
    printf '  %s\n' "${FINDINGS[@]}"
    echo
    echo "Legend: FAIL = cause of a problem, WARN = suspicious, OK = checked and fine."
    echo "Note: other devices find '${HOST}' via DNS (plain name / FQDN), via mDNS ('${HOST}.local')"
    echo "or, on Windows, via LLMNR/NetBIOS. Raw data for all checks follows."
    cat "${BODY}"
  } >"${report}"
  rm -f "${BODY}"

  cp "${report}" "${REPORT_DIR}/latest.txt"
  ls -1t "${REPORT_DIR}"/report_*.txt 2>/dev/null | tail -n +$(( KEEP_REPORTS + 1 )) | xargs -r rm -f
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    chown -R "${SUDO_USER}:" "${REPORT_DIR}"
  fi

  for boot_dir in /boot/firmware /boot; do
    if [[ "$(findmnt -no FSTYPE "${boot_dir}" 2>/dev/null)" == "vfat" ]]; then
      cp "${report}" "${boot_dir}/${BOOT_COPY_NAME}" && echo "Copied to ${boot_dir}/${BOOT_COPY_NAME}"
      break
    fi
  done

  echo "Report written to ${report}"
  printf '%s\n' "${FINDINGS[@]}"
}

install_service() {
  local missing=() package
  for package in "${OPTIONAL_PACKAGES[@]}"; do
    dpkg -s "${package}" >/dev/null 2>&1 || missing+=("${package}")
  done
  if (( ${#missing[@]} > 0 )); then
    echo "Installing diagnostic tools: ${missing[*]}..."
    if ! { apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"; }; then
      echo "Warning: could not install ${missing[*]} (offline?); the report skips checks that need them."
    fi
  fi

  cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=ProGeo network diagnostics report (${REPORT_DIR}/latest.txt)
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash ${SCRIPT_DIR}/network_report.sh
TimeoutStartSec=5min
EOF

  # A timer instead of WantedBy=multi-user.target: starts once the boot is
  # finished and the uplink had time for DHCP or the static fallback.
  cat >"/etc/systemd/system/${SERVICE_NAME}.timer" <<EOF
[Unit]
Description=Write a network diagnostics report after every boot

[Timer]
OnBootSec=3min

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}.timer" >/dev/null
  systemctl start --no-block "${SERVICE_NAME}.service"
  echo "Installed ${SERVICE_NAME}.timer: a report is written 3 min after every boot."
  echo "A first report is being written now (~2 min): ${REPORT_DIR}/latest.txt"
  echo "Progress: journalctl -fu ${SERVICE_NAME}"
}

uninstall_service() {
  systemctl disable --now "${SERVICE_NAME}.timer" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}.timer"
  systemctl daemon-reload
  echo "Removed ${SERVICE_NAME} timer (existing reports are kept)."
}

MODE="report"
case "${1:-}" in
  "") ;;
  --install) MODE="install" ;;
  --uninstall) MODE="uninstall" ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; fatal "unknown argument: $1" ;;
esac

require_root
case "${MODE}" in
  report)
    load_env
    write_report
    ;;
  install) install_service ;;
  uninstall) uninstall_service ;;
esac
