#!/bin/sh
set -eu

CERT_MODE="${CERT_MODE:-mkcert}"
if [ "${CERT_MODE}" != "mkcert" ]; then
  echo "[mkcert] CERT_MODE=${CERT_MODE}; skipping local CA certificate generation."
  exit 0
fi

SSL_DIR="${CERT_PATH:-/etc/nginx/ssl}"
CERT_FILE="${CERT_FILE:-progeo-local.crt}"
CERT_KEY="${CERT_KEY:-progeo-local.key}"
CAROOT_DIR="${MKCERT_CAROOT:-${SSL_DIR}/.mkcert}"
STATE_FILE="${SSL_DIR}/.mkcert-hosts"
ROOT_CA_FILE="${SSL_DIR}/rootCA.pem"

if ! command -v mkcert >/dev/null 2>&1; then
  echo "[mkcert] mkcert is not installed in the nginx image."
  exit 1
fi

mkdir -p "${SSL_DIR}" "${CAROOT_DIR}"
export CAROOT="${CAROOT_DIR}"

TMP_HOSTS_FILE="$(mktemp)"
cleanup() {
  rm -f "${TMP_HOSTS_FILE}"
}
trap cleanup EXIT

for item in localhost 127.0.0.1 host.docker.internal ${DNS_BACK_NAMES:-} ${DNS_FRONT_NAMES:-}; do
  [ -n "${item}" ] && echo "${item}" >> "${TMP_HOSTS_FILE}"
done

HOST_GATEWAY_IP="$(ip route | awk '/default/ { print $3; exit }' || true)"
if [ -n "${HOST_GATEWAY_IP}" ]; then
  echo "${HOST_GATEWAY_IP}" >> "${TMP_HOSTS_FILE}"
fi

if [ -n "${HOST_IP:-}" ]; then
  echo "${HOST_IP}" >> "${TMP_HOSTS_FILE}"
fi

if [ -n "${MKCERT_EXTRA_NAMES:-}" ]; then
  for item in ${MKCERT_EXTRA_NAMES}; do
    echo "${item}" >> "${TMP_HOSTS_FILE}"
  done
fi

sort -u "${TMP_HOSTS_FILE}" -o "${TMP_HOSTS_FILE}"
SAN_LIST="$(tr '\n' ' ' < "${TMP_HOSTS_FILE}" | xargs)"
CERT_PATH_FILE="${SSL_DIR}/${CERT_FILE}"
KEY_PATH_FILE="${SSL_DIR}/${CERT_KEY}"

if [ ! -f "${CERT_PATH_FILE}" ] || [ ! -f "${KEY_PATH_FILE}" ] || [ ! -f "${STATE_FILE}" ] || ! cmp -s "${TMP_HOSTS_FILE}" "${STATE_FILE}"; then
  echo "[mkcert] Generating certificate for: ${SAN_LIST}"
  mkcert -cert-file "${CERT_PATH_FILE}" -key-file "${KEY_PATH_FILE}" ${SAN_LIST}
  cp "${TMP_HOSTS_FILE}" "${STATE_FILE}"
else
  echo "[mkcert] Existing certificate matches requested host names."
fi

if [ -f "${CAROOT}/rootCA.pem" ]; then
  cp "${CAROOT}/rootCA.pem" "${ROOT_CA_FILE}"
  cp "${CAROOT}/rootCA.pem" "/usr/local/share/ca-certificates/progeo-local-rootCA.crt"
  update-ca-certificates >/dev/null
  chmod 644 "${ROOT_CA_FILE}" "${CERT_PATH_FILE}"
fi
chmod 600 "${KEY_PATH_FILE}"
rm -f "${SSL_DIR}/local.pass" "${SSL_DIR}/progeo-local.csr"

echo "[mkcert] Certificate ready at ${CERT_PATH_FILE}"
echo "[mkcert] Root CA exported to ${ROOT_CA_FILE}"
