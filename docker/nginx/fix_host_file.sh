#!/bin/sh
set -eu

line="`ip route | awk '/default/ { print $3 }'`   docker.host.internal"

{ echo "";
  echo "${line}";
  echo "";
} >> /etc/hosts
echo "Added: ${line}"

# ######################################################################

if [ -f /etc/nginx/conf.d/progeo.conf.template ]; then
  # Substitute environment variables in the NGINX configuration template
  envsubst '\$DNS_BACK_NAMES \$DNS_FRONT_NAMES \$CERT_FILE \$CERT_KEY \$CERT_PASS' < /etc/nginx/conf.d/progeo.conf.template > /etc/nginx/conf.d/progeo.conf
  if [ ! -f /etc/nginx/ssl/${CERT_PASS} ] || [ ! -f /etc/nginx/ssl/${CERT_KEY} ]; then
      echo "SSL certificate or key file does not exist."
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
