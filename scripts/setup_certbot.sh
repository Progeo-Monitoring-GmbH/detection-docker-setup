#!/usr/bin/env bash

set -e

if [[ "$(id -u)" -ne 0 ]]; then
  echo "This script must be run as root/admin."
  exit 1
fi

# ===== CONFIGURATION =====
EMAIL=""
DOMAINS=()
WEB_SERVER="nginx"

if [[ "$#" -lt 2 ]]; then
  echo "Usage: $0 <email> <domain1> [domain2 ...]"
  echo "   or: $0 <domain1> <email> [domain2 ...]"
  exit 1
fi

if [[ "$1" == *"@"* ]]; then
  EMAIL="$1"
  shift
  DOMAINS=("$@")
elif [[ "$2" == *"@"* ]]; then
  EMAIL="$2"
  FIRST_DOMAIN="$1"
  shift 2
  DOMAINS=("$FIRST_DOMAIN" "$@")
else
  echo "Could not detect email address in arguments."
  echo "Usage: $0 <email> <domain1> [domain2 ...]"
  echo "   or: $0 <domain1> <email> [domain2 ...]"
  exit 1
fi

if [[ -z "$EMAIL" || "${#DOMAINS[@]}" -eq 0 ]]; then
  echo "At least one domain and a valid email are required."
  exit 1
fi

echo "=== Starting Let's Encrypt setup for domains: ${DOMAINS[*]} ==="

# ===== UPDATE SYSTEM =====
echo "[1/6] Updating system..."
apt update -y
apt upgrade -y

# ===== INSTALL SNAPD =====
echo "[2/6] Installing snapd..."
apt install -y snapd
snap install core
snap refresh core

# ===== INSTALL CERTBOT =====
echo "[3/6] Installing Certbot..."
snap install --classic certbot

# Ensure certbot command is available
ln -sf /snap/bin/certbot /usr/bin/certbot

# ===== OBTAIN CERTIFICATE =====
echo "[5/6] Requesting certificate..."

CERTBOT_DOMAIN_ARGS=()
for domain in "${DOMAINS[@]}"; do
  CERTBOT_DOMAIN_ARGS+=("-d" "$domain")
done

certbot --nginx "${CERTBOT_DOMAIN_ARGS[@]}" \
  --non-interactive --agree-tos -m "$EMAIL" --redirect


# ===== AUTO-RENEWAL TEST =====
echo "[6/6] Testing auto-renewal..."
certbot renew --dry-run

# ===== INSTALL AUTO-RENEW CRONJOB =====
echo "=== Configuring auto-renew cronjob ==="

CRON_FILE="/etc/cron.d/certbot_renew"
tee "$CRON_FILE" >/dev/null <<EOF
SHELL=/bin/bash
PATH=/sbin:/bin:/usr/sbin:/usr/bin:/snap/bin

# Renew certificates every day at 03:17. Certbot renews only when needed.
17 3 * * * root certbot renew --quiet --deploy-hook "docker exec progeo-nginx nginx -s reload"
EOF

chmod 644 "$CRON_FILE"
echo "[OK] Auto-renew cronjob installed at $CRON_FILE"

echo "=== DONE! SSL is configured for domains: ${DOMAINS[*]} ==="