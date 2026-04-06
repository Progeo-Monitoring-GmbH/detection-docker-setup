#!/bin/bash

# Open Wi-Fi Hotspot Setup Script for Raspberry Pi
# SSID: ProGeoController
# No password (open network)

set -e

if [[ "${EUID}" -ne 0 ]]; then
  echo "Error: run this script as root (use sudo)."
  exit 1
fi


echo "Updating packages..."
apt update
apt install -y hostapd dnsmasq

echo "Stopping services for configuration..."
systemctl stop hostapd
systemctl stop dnsmasq

echo "Configuring static IP for wlan0..."
bash -c 'cat >> /etc/dhcpcd.conf <<EOF

interface wlan0
    static ip_address=192.168.1.1/24
    nohook wpa_supplicant
EOF'

service dhcpcd restart

echo "Configuring dnsmasq..."
mv /etc/dnsmasq.conf /etc/dnsmasq.conf.orig
bash -c 'cat > /etc/dnsmasq.conf <<EOF
interface=wlan0
dhcp-range=192.168.1.10,192.168.1.100,255.255.255.0,24h
EOF'

echo "Configuring hostapd..."
bash -c 'cat > /etc/hostapd/hostapd.conf <<EOF
interface=wlan0
driver=nl80211
ssid=ProGeoController
hw_mode=g
channel=6
auth_algs=1
ignore_broadcast_ssid=0
EOF'

sed -i 's|#DAEMON_CONF=""|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd

echo "Enabling services..."
systemctl unmask hostapd
systemctl enable hostapd
systemctl enable dnsmasq

systemctl start hostapd
systemctl start dnsmasq

echo "Hotspot setup complete!"
echo "SSID: ProGeoController (open, no password)"