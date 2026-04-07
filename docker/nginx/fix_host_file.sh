#!/bin/sh
set -eu

line="`ip route | awk '/default/ { print $3 }'`   docker.host.internal"

{ echo "";
  echo "${line}";
  echo "127.0.0.1       api.progeo.local";
  echo "127.0.0.1       dashboard.progeo.local";
  echo "";
} >> /etc/hosts
echo "Added: ${line}"

# ######################################################################

if [ -f /etc/nginx/conf.d/progeo.conf.template ]; then
  # Substitute environment variables in the NGINX configuration template
  envsubst '\$DNS_BACK_NAMES \$DNS_FRONT_NAMES \$CERT_FILE \$CERT_KEY \$CERT_PASS \$CERT_PATH' < /etc/nginx/conf.d/progeo.conf.template > /etc/nginx/conf.d/progeo.conf
  rm /etc/nginx/conf.d/progeo.conf.template
  if [ ! -f /etc/nginx/ssl/${CERT_PASS} ] || [ ! -f ${CERT_PATH}${CERT_KEY} ]; then
      echo "SSL certificate or key file does not exist. | CERT_FILE=${CERT_FILE} | CERT_KEY=${CERT_KEY} | CERT_PATH=${CERT_PATH}"
      exit 1
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
