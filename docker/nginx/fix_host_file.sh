#!/bin/sh
set -eu

line="`ip route | awk '/default/ { print $3 }'`   docker.host.internal"

{ echo "";
  echo "${line}";
  for host_name in ${DNS_BACK_NAMES:-} ${DNS_FRONT_NAMES:-}; do
    if [ -n "${host_name}" ] && [ "${host_name}" != "localhost" ]; then
      echo "127.0.0.1       ${host_name}";
    fi
  done
  echo "";
} >> /etc/hosts
echo "Added: ${line}"

# ######################################################################

CERT_MODE="${CERT_MODE:-local}"
ENABLE_SSL="${ENABLE_SSL:-true}"
if [ "${CERT_MODE}" = "existing" ]; then
  : "${CERT_PATH:=/etc/nginx/ssl/}"
  : "${CERT_FILE:=localhost-bundle.pem}"
  : "${CERT_KEY:=${CERT_FILE}}"
else
  : "${CERT_PATH:=/etc/nginx/ssl/}"
  : "${CERT_FILE:=progeo-local.crt}"
  : "${CERT_KEY:=progeo-local.key}"
fi

export CERT_MODE CERT_PATH CERT_FILE CERT_KEY ENABLE_SSL

if [ -f /etc/nginx/conf.d/progeo.conf.template ]; then
  envsubst '\$DNS_BACK_NAMES \$DNS_FRONT_NAMES \$CERT_FILE \$CERT_KEY \$CERT_PATH' < /etc/nginx/conf.d/progeo.conf.template > /etc/nginx/conf.d/progeo.conf
  rm /etc/nginx/conf.d/progeo.conf.template
fi

if [ "${ENABLE_SSL}" = "false" ] || [ "${CERT_MODE}" = "none" ]; then
  if [ -f /etc/nginx/conf.d/progeo.conf ]; then
    # HTTP-only mode: remove TLS directives and listen on 80 only.
    sed -i 's/listen 443 ssl;/listen 80;/g' /etc/nginx/conf.d/progeo.conf
    sed -i 's/listen \[::\]:443 ssl;/listen [::]:80;/g' /etc/nginx/conf.d/progeo.conf
    sed -i '/^\s*ssl_certificate\b/d' /etc/nginx/conf.d/progeo.conf
    sed -i '/^\s*ssl_certificate_key\b/d' /etc/nginx/conf.d/progeo.conf
    sed -i '/^\s*add_header Strict-Transport-Security\b/d' /etc/nginx/conf.d/progeo.conf
    echo "SSL disabled: generated HTTP-only nginx config."
  fi
fi

#if [ ! -f "${CERT_PATH}${CERT_FILE}" ] || [ ! -f "${CERT_PATH}${CERT_KEY}" ]; then
#    echo "SSL certificate or key file does not exist. | CERT_MODE=${CERT_MODE} | CERT_FILE=${CERT_FILE} | CERT_KEY=${CERT_KEY} | CERT_PATH=${CERT_PATH}"
#    exit 1
#fi

# ######################################################################

FILE=/etc/nginx/conf.d/default.conf
if [ -f "$FILE" ]; then
    rm "$FILE"
    echo "File '$FILE' deleted."
else
    echo "File '$FILE' does not exist."
fi

# ######################################################################

echo "[DONE]"
