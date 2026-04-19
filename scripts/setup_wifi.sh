#!/bin/bash

# Open Wi-Fi Hotspot Setup Script for Raspberry Pi
# SSID and password are read from .env when available

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Error: run this script as root (use sudo)."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

CONTROLLER_IP="${CONTROLLER_IP:-192.168.161.1}"
SSID="${CONTROLLER_SSID:-"ProGeoController"}"
PASSWORD="${CONTROLLER_PASSWORD:-}"
WIFI_COUNTRY="${CONTROLLER_COUNTRY_CODE:-DE}"
WIFI_COUNTRY="$(printf '%s' "${WIFI_COUNTRY}" | tr '[:lower:]' '[:upper:]')"
CONTROLLER_NET_PREFIX="${CONTROLLER_IP%.*}"
CONTROLLER_DHCP_START="${CONTROLLER_DHCP_START:-${CONTROLLER_NET_PREFIX}.10}"
CONTROLLER_DHCP_END="${CONTROLLER_DHCP_END:-${CONTROLLER_NET_PREFIX}.200}"

if [[ -z "${SSID}" ]]; then
  echo "Error: CONTROLLER_SSID cannot be empty."
  exit 1
fi

if [[ -n "${PASSWORD}" ]] && (( ${#PASSWORD} < 8 || ${#PASSWORD} > 63 )); then
  echo "Error: CONTROLLER_PASSWORD must be 8-63 characters for WPA2."
  exit 1
fi

if [[ ! "${WIFI_COUNTRY}" =~ ^[A-Z]{2}$ ]]; then
  echo "Error: CONTROLLER_COUNTRY_CODE must be a 2-letter ISO country code (for example: DE, US, FR)."
  exit 1
fi

if [[ ! "${CONTROLLER_IP}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "Error: CONTROLLER_IP must be a valid IPv4 address."
  exit 1
fi

has_service() {
  systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$1.service"
}

stop_service_if_exists() {
  systemctl stop "$1" >/dev/null 2>&1 || true
}

allow_hotspot_firewall() {
  if command -v ufw >/dev/null 2>&1; then
    ufw allow in on wlan0 to any port 53 proto tcp >/dev/null 2>&1 || true
    ufw allow in on wlan0 to any port 53 proto udp >/dev/null 2>&1 || true
    ufw allow in on wlan0 to any port 67 proto udp >/dev/null 2>&1 || true
  fi
}

configure_manager_conflicts() {
  stop_service_if_exists hostapd
  stop_service_if_exists dnsmasq
  stop_service_if_exists wpa_supplicant
  stop_service_if_exists wpa_supplicant@wlan0

  systemctl disable wpa_supplicant >/dev/null 2>&1 || true
  systemctl disable wpa_supplicant@wlan0 >/dev/null 2>&1 || true

  if has_service "NetworkManager"; then
    mkdir -p /etc/NetworkManager/conf.d
    cat > /etc/NetworkManager/conf.d/99-unmanaged-wlan0.conf <<'EOF'
[keyfile]
unmanaged-devices=interface-name:wlan0
EOF
    systemctl restart NetworkManager >/dev/null 2>&1 || true
  fi
}

configure_service_restart_policy() {
  mkdir -p /etc/systemd/system/hostapd.service.d /etc/systemd/system/dnsmasq.service.d

  cat > /etc/systemd/system/hostapd.service.d/override.conf <<'EOF'
[Service]
Restart=always
RestartSec=2
EOF

  cat > /etc/systemd/system/dnsmasq.service.d/override.conf <<'EOF'
[Service]
Restart=always
RestartSec=2
EOF

  systemctl daemon-reload
}

disable_wifi_power_save() {
  if command -v iw >/dev/null 2>&1; then
    mkdir -p /etc/systemd/system
    cat > /etc/systemd/system/wlan0-power-save-off.service <<'EOF'
[Unit]
Description=Disable Wi-Fi power saving on wlan0
After=network-pre.target
Before=hostapd.service
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'command -v iw >/dev/null 2>&1 && iw dev wlan0 set power_save off || true'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

    systemctl enable wlan0-power-save-off.service >/dev/null 2>&1 || true
    iw dev wlan0 set power_save off >/dev/null 2>&1 || true
  fi
}

configure_static_ip() {
  echo "Configuring static IP for wlan0..."

  if has_service "dhcpcd" && [[ -f /etc/dhcpcd.conf ]]; then
    if ! grep -q "^interface wlan0$" /etc/dhcpcd.conf; then
        cat >> /etc/dhcpcd.conf <<EOF

interface wlan0
    static ip_address=${CONTROLLER_IP}/24
    nohook wpa_supplicant
EOF
    fi

    systemctl restart dhcpcd
    return
  fi

  if has_service "systemd-networkd"; then
    mkdir -p /etc/systemd/network
    cat > /etc/systemd/network/08-wlan0.network <<EOF
[Match]
Name=wlan0

[Network]
Address=${CONTROLLER_IP}/24
ConfigureWithoutCarrier=yes
EOF

    systemctl enable systemd-networkd >/dev/null 2>&1 || true
    systemctl restart systemd-networkd
    return
  fi

  echo "Warning: no supported network management service was found."
  echo "Applying a temporary IP address to wlan0 for this session only."
  ip addr flush dev wlan0 || true
  ip addr add ${CONTROLLER_IP}/24 dev wlan0
  ip link set wlan0 up
}

echo "Updating packages..."
apt update
apt install -y hostapd dnsmasq iw

echo "Stopping services for configuration..."
configure_service_restart_policy
configure_manager_conflicts
disable_wifi_power_save

if command -v rfkill >/dev/null 2>&1; then
  rfkill unblock wlan || true
fi

ip link set wlan0 down || true
ip addr flush dev wlan0 || true
ip link set wlan0 up || true

configure_static_ip
allow_hotspot_firewall

echo "Configuring dnsmasq..."
if [[ -f /etc/dnsmasq.conf ]] && [[ ! -f /etc/dnsmasq.conf.orig ]]; then
  mv /etc/dnsmasq.conf /etc/dnsmasq.conf.orig
fi

cat > /etc/dnsmasq.conf <<'EOF'
interface=wlan0
bind-dynamic
listen-address=${CONTROLLER_IP}
domain-needed
bogus-priv
dhcp-authoritative
clear-on-reload
dhcp-leasefile=/var/lib/misc/dnsmasq.leases
dhcp-range=${CONTROLLER_DHCP_START},${CONTROLLER_DHCP_END},255.255.255.0,24h
dhcp-option=3,${CONTROLLER_IP}
dhcp-option=6,${CONTROLLER_IP}
EOF

mkdir -p /var/lib/misc
if ! dnsmasq --test; then
  echo "Error: dnsmasq configuration is invalid."
  exit 1
fi

echo "Configuring hostapd..."
cat > /etc/hostapd/hostapd.conf <<EOF
interface=wlan0
driver=nl80211
ssid=${SSID}
hw_mode=g
channel=6
country_code=${WIFI_COUNTRY}
ieee80211d=1
ieee80211n=1
ieee80211w=0
wmm_enabled=1
ap_max_inactivity=60
skip_inactivity_poll=1
disassoc_low_ack=1
max_num_sta=32
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
EOF

if [[ -n "${PASSWORD}" ]]; then
  cat >> /etc/hostapd/hostapd.conf <<EOF
wpa=2
wpa_passphrase=${PASSWORD}
wpa_key_mgmt=WPA-PSK
wpa_pairwise=TKIP
rsn_pairwise=CCMP
EOF
fi

if [[ -f /etc/default/hostapd ]]; then
  if grep -q '^#\?DAEMON_CONF=' /etc/default/hostapd; then
    sed -i 's|^#\?DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd
  else
    echo 'DAEMON_CONF="/etc/hostapd/hostapd.conf"' >> /etc/default/hostapd
  fi
else
  echo 'DAEMON_CONF="/etc/hostapd/hostapd.conf"' > /etc/default/hostapd
fi

echo "Enabling services..."
systemctl unmask hostapd
systemctl enable hostapd
systemctl enable dnsmasq

systemctl restart dnsmasq
systemctl restart hostapd

if ! systemctl --quiet is-active dnsmasq; then
  echo "Error: dnsmasq failed to start. Recent logs:"
  journalctl -u dnsmasq -n 50 --no-pager || true
  exit 1
fi

if ! systemctl --quiet is-active hostapd; then
  echo "Error: hostapd failed to start. Recent logs:"
  journalctl -u hostapd -n 50 --no-pager || true
  exit 1
fi

echo "Hotspot setup complete!"
if [[ -n "${PASSWORD}" ]]; then
  echo "SSID: ${SSID} (password protected)"
else
  echo "SSID: ${SSID} (open, no password)"
fi

echo "Hotspot IP: ${CONTROLLER_IP}"