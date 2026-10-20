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
CERT_PATH="${CERT_PATH:-/etc/nginx/ssl}"
CERT_KEY="${CERT_KEY:-localhost-key.pem}"

if [ "${CERT_MODE}" = "existing" ]; then
  : "${CERT_PATH:=/etc/nginx/ssl}"
  : "${CERT_FILE:=localhost-bundle.pem}"
  : "${CERT_KEY:=${CERT_FILE}}"
else
  : "${CERT_PATH:=/etc/letsencrypt/live/api.progeo.com}"
  : "${CERT_FILE:=fullchain.pem}"
  : "${CERT_KEY:=privkey.pem}"
fi

export CERT_MODE CERT_PATH CERT_FILE CERT_KEY ENABLE_SSL

# ######################################################################
# server_name lists of the two 443 blocks. nginx keeps a name listed twice on
# one port only in the FIRST block ("conflicting server name ... ignored") -
# the api block - so a host in both lists never reached the frontend. A name
# in both goes to the frontend block (it proxies the backend paths too), each
# name once, "localhost" always on the frontend.

unique_names() {
  echo "$*" | awk '{ for (i = 1; i <= NF; i++) if (!seen[$i]++) out = out (out == "" ? "" : " ") $i; print out }'
}

DNS_FRONT_SERVER_NAMES="$(unique_names ${DNS_FRONT_NAMES:-} localhost)"
back_names=""
for name in ${DNS_BACK_NAMES:-}; do
  case " ${DNS_FRONT_SERVER_NAMES} " in
    *" ${name} "*) echo "server name ${name} is in DNS_BACK_NAMES and DNS_FRONT_NAMES - served by the frontend block" ;;
    *) back_names="${back_names} ${name}" ;;
  esac
done
DNS_BACK_SERVER_NAMES="$(unique_names ${back_names})"
# server_name needs a value; ".invalid" never matches a request.
DNS_BACK_SERVER_NAMES="${DNS_BACK_SERVER_NAMES:-api.invalid}"
export DNS_FRONT_SERVER_NAMES DNS_BACK_SERVER_NAMES
echo "server names: api block '${DNS_BACK_SERVER_NAMES}', frontend block '${DNS_FRONT_SERVER_NAMES}'"

if [ -f /etc/nginx/conf.d/progeo.conf.template ]; then
  envsubst '\$DNS_BACK_SERVER_NAMES \$DNS_FRONT_SERVER_NAMES \$CERT_FILE \$CERT_KEY \$CERT_PATH' < /etc/nginx/conf.d/progeo.conf.template > /etc/nginx/conf.d/progeo.conf
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
