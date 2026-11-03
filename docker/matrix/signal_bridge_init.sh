#!/bin/bash
# progeo-signal-bridge-init: prepares mautrix-signal (the Signal <-> Matrix
# bridge) once per `docker compose up`, in the bridge image (yq is there):
#   - /data/config.yaml: the bridge's own example config on the first run,
#     then our values set on every run,
#   - /data/registration.yaml: the appservice registration Synapse loads
#     (progeo-matrix mounts this volume read-only), generated once.
# Only the ProGeo bot may use the bridge: it is logged in to ProGeo's Signal
# number and sends the Signal notifications (progeo/helper/messenger.py).
set -euo pipefail

for name in MATRIX_DOMAIN MATRIX_SIGNAL_PROVISIONING_SECRET; do
  if [ -z "${!name:-}" ]; then
    echo "${name} is empty - set it in .env (docker/matrix/README.md)" >&2
    exit 1
  fi
done

config=/data/config.yaml
bin=/usr/bin/mautrix-signal
umask 077

if [ ! -f "$config" ]; then
  "$bin" -c "$config" -e
fi

export BOT="@progeo-bot:${MATRIX_DOMAIN}"
yq -i '
  .homeserver.address = "http://progeo-matrix:8008" |
  .homeserver.domain = strenv(MATRIX_DOMAIN) |
  .appservice.address = "http://progeo-signal-bridge:29328" |
  .appservice.public_address = "" |
  .appservice.hostname = "0.0.0.0" |
  .appservice.port = 29328 |
  .database.type = "sqlite3-fk-wal" |
  .database.uri = "file:/data/mautrix-signal.db?_txlock=immediate" |
  .bridge.permissions = {strenv(BOT): "admin"} |
  .bridge.relay.enabled = false |
  .provisioning.shared_secret = strenv(MATRIX_SIGNAL_PROVISIONING_SECRET) |
  .provisioning.allow_matrix_auth = false |
  .provisioning.debug_endpoints = false |
  .matrix.federate_rooms = false |
  .network.device_name = "ProGeo" |
  .backfill.enabled = false |
  .logging.min_level = "info" |
  .logging.writers = [{"type": "stdout", "format": "json"}]
' "$config"

if [ ! -f /data/registration.yaml ]; then
  "$bin" -g -c "$config" -r /data/registration.yaml
  echo "generated the appservice registration"
fi

# The bridge runs as UID/GID 1337 (docker-run.sh); Synapse (991) reads the
# registration through its read-only mount.
chown -R 1337:1337 /data
chmod 711 /data
chmod 644 /data/registration.yaml
echo "mautrix-signal config written"
