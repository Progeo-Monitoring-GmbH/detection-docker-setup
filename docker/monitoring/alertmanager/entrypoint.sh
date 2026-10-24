#!/bin/sh
# progeo-alertmanager: writes alertmanager.yml from the ALERT_* variables of
# .env (Alertmanager reads no environment variables itself). Without
# ALERT_EMAIL nothing is mailed - alerts still show in Grafana and Prometheus.
set -eu

config=/alertmanager/alertmanager.yml
mkdir -p /alertmanager/secrets
umask 077
printf '%s' "${ALERT_SMTP_PASSWORD:-}" > /alertmanager/secrets/smtp_password

cat > "$config" <<EOF
global:
  smtp_smarthost: '${ALERT_SMTP_HOST:-smtp.progeo.com:587}'
  smtp_from: '${ALERT_SMTP_FROM:-no-reply@progeo.com}'
  smtp_auth_username: '${ALERT_SMTP_USER:-no-reply@progeo.com}'
  smtp_auth_password_file: /alertmanager/secrets/smtp_password
  smtp_require_tls: true

route:
  receiver: mail
  group_by: [alertname, job]
  group_wait: 30s
  group_interval: 5m
  # The same unresolved alert is mailed again after this time.
  repeat_interval: 6h

inhibit_rules:
  # A dead service makes its own alerts redundant.
  - source_matchers: [alertname="ScrapeTargetDown"]
    target_matchers: [severity="warning"]
    equal: [job]

receivers:
  - name: mail
EOF

if [ -n "${ALERT_EMAIL:-}" ]; then
  cat >> "$config" <<EOF
    email_configs:
      - to: '${ALERT_EMAIL}'
        send_resolved: true
        headers:
          Subject: '[progeo ${ALERT_SERVER_NAME:-monitoring}] {{ .Status | toUpper }} {{ .CommonLabels.alertname }}'
EOF
else
  echo "ALERT_EMAIL is empty - alerts are not mailed"
fi

exec /bin/alertmanager \
  --config.file="$config" \
  --storage.path=/alertmanager \
  "$@"
