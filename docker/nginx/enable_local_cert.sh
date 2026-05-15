#!/bin/sh
set -eu

SSL_DIR="${CERT_PATH:-/etc/nginx/ssl}"
CERT_FILE="${CERT_FILE:-progeo-local.crt}"
CERT_KEY="${CERT_KEY:-progeo-local.key}"
ROOT_CA_FILE="${SSL_DIR}/.mkcert/rootCA.pem"

CERT_PATH_FILE="${SSL_DIR}/${CERT_FILE}"
KEY_PATH_FILE="${SSL_DIR}/${CERT_KEY}"

if [ -f "${ROOT_CA_FILE}" ]; then
  cp "${ROOT_CA_FILE}" "/usr/local/share/ca-certificates/progeo-local-rootCA.crt"
  update-ca-certificates
  chmod 644 "${ROOT_CA_FILE}" "${CERT_PATH_FILE}"
  echo "Enabled local CA certificate: ${ROOT_CA_FILE}"
fi

echo "[mkcert] Root CA exported to ${ROOT_CA_FILE}"
