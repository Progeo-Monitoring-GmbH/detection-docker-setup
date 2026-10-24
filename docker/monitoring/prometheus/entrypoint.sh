#!/bin/sh
# progeo-prometheus: Prometheus reads no environment variables in its config,
# so the secrets from .env become files (credentials_file / password_file) and
# the node exporter address is filled into prometheus.yml before it starts.
set -eu

secrets=/prometheus/secrets
mkdir -p "$secrets"
umask 077
printf '%s' "${METRICS_TOKEN:-}" > "$secrets/metrics_token"
printf '%s' "${FLOWER_PASSWORD:-}" > "$secrets/flower_password"

sed -e "s|__NODE_EXPORTER_TARGET__|${NODE_EXPORTER_TARGET}|g" \
    -e "s|__FLOWER_USER__|${FLOWER_USER:-flower}|g" \
    /etc/prometheus/prometheus.yml > /prometheus/prometheus.yml

exec /bin/prometheus \
  --config.file=/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --storage.tsdb.retention.time="${PROMETHEUS_RETENTION_TIME:-30d}" \
  --storage.tsdb.retention.size="${PROMETHEUS_RETENTION_SIZE:-5GB}" \
  "$@"
