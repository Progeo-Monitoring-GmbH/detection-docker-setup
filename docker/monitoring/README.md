# Monitoring

Prometheus, Grafana and the exporters run as the compose profile `monitoring`.
Without that profile, nothing here is pulled or started.

| Container | Image | What it does |
|---|---|---|
| progeo-prometheus | prom/prometheus | Scrapes all targets and evaluates [alert rules](prometheus/rules/alerts.yml) |
| progeo-alertmanager | prom/alertmanager | Mails alerts to `ALERT_EMAIL` |
| progeo-grafana | grafana/grafana-oss | Dashboards in folder "Progeo"; firing alerts and silences under Alerting |
| progeo-flower | mher/flower | Celery tasks and workers (from the `-E` worker events) |
| progeo-postgres-exporter | prometheuscommunity/postgres-exporter | Connections, transactions, locks, sizes, `pg_stat_statements` |
| progeo-redis-exporter | oliver006/redis_exporter | Redis health and length of the celery queue |
| progeo-cadvisor | ghcr.io/google/cadvisor | CPU, memory and restarts per container |
| progeo-node-exporter | prom/node-exporter | Host CPU, memory, disk and network |

The backend exposes its own metrics at `/metrics` ([progeo/metrics.py](../../progeo/metrics.py)):

- request count by view, method and status
- latency histogram by view
- requests in progress
- open WebSocket connections by route

## Setup

1. In `.env`, fill in the "Monitoring" block (see `.env.template`):
   - Add `monitoring` to `COMPOSE_PROFILES`.
   - Generate every secret with `openssl rand -hex 24`.
2. Rebuild the backend for `prometheus-client`. It reads `METRICS_TOKEN` from `.env` when the container starts.
3. Restart nginx so it blocks `/metrics`:
   ```bash
   docker compose build progeo-backend progeo-nginx && docker compose up -d
   ```
4. Create the read-only database role and enable `pg_stat_statements`:
   ```bash
   bash scripts/setup_monitoring_db_user.sh
   ```
   The script asks before restarting progeo-database, which takes a few seconds.
   The restart is needed only once, so that `shared_preload_libraries` takes effect.
   Until then the exporter logs `stat_statements` errors, and the query tables stay empty.
5. Open the UIs. They listen on `MONITORING_BIND` (default `127.0.0.1`), so connect through an SSH tunnel:
   ```bash
   ssh -L 3000:127.0.0.1:3000 -L 9090:127.0.0.1:9090 -L 5555:127.0.0.1:5555 <server>
   ```
   - Grafana: http://localhost:3000. Log in with `GRAFANA_ADMIN_*`; the password applies only on the first start.
   - Prometheus: http://localhost:9090/targets. Every target should be `UP`.
   - Flower: http://localhost:5555
   
   With `docker-compose.prod.yml`, add `-f docker-compose.prod.yml` to the compose commands.

## Checking it works

```bash
# All targets up?
curl -s localhost:9090/api/v1/targets | grep -o '"health":"[a-z]*"' | sort | uniq -c

# Rules valid after editing alerts.yml, then reload
docker exec progeo-prometheus promtool check rules /etc/prometheus/rules/alerts.yml
curl -X POST localhost:9090/-/reload

# Test mail: an alert that fires immediately, sent to the Alertmanager API
docker exec progeo-prometheus wget -qO- --header 'Content-Type: application/json' \
  --post-data '[{"labels":{"alertname":"TestAlert","severity":"warning"}}]' \
  http://progeo-alertmanager:9093/api/v2/alerts
```

## Security

- **`/metrics`** needs `Authorization: Bearer $METRICS_TOKEN` and answers 404 while the token is empty.
  - nginx refuses the path, but `BACKEND_PORT` may still be published without `LIMITED_ACCESS`.
  - The middleware answers `/metrics` before the `ALLOWED_HOSTS` check and `SECURE_SSL_REDIRECT`, because Prometheus calls `http://progeo-backend:8383` directly.
- **Exporters** publish no ports; only Prometheus reaches them, over `monitoring_net`.
- **Node exporter** runs in the host network, for the real network interfaces. It listens only on the gateway of `monitoring_net` (`MONITORING_GATEWAY`, bridge `br-progeo-mon`).
  - If a host firewall (ufw) blocks it, allow it: `ufw allow in on br-progeo-mon to any port 9100 proto tcp`.
- **Database:** the postgres exporter logs in as a `pg_monitor` member. That role can read statistics and sizes, but no table data.
  - `pg_stat_statements` texts are normalized (`$1`, `$2`) and contain no values.
- **Flower** needs basic auth (`FLOWER_USER` / `FLOWER_PASSWORD`).
- **Grafana:** sign-up and anonymous access are off, and so are update checks and the news feed, so it runs offline.

## Notes

- **Retention:** `PROMETHEUS_RETENTION_TIME` (30d) and `PROMETHEUS_RETENTION_SIZE` (5GB), whichever limit is hit first.
- **~1000 project databases:** the postgres job is scraped every 60s with a 45s timeout, because the stats of every database take a few seconds.
  - Its dashboard panels use a minimum interval of 2m.
  - Database sizes come from a second exporter (`progeo-postgres-sizes-exporter`, job `postgres-sizes`), scraped only every 15 minutes: `pg_database_size()` of every database costs the server about 3s of work.
- **Dashboards** are generated JSON in [grafana/dashboards](grafana/dashboards). Grafana re-reads them every 30s.
  - Changes made in the UI can't be saved over them. Use "Save as" for your own copy, or edit the JSON.
- **Celery queue backlog** is the length of the redis list `celery` in db 0.
  - Flower only knows tasks it has seen since its own start, so task counters reset when it restarts.
- **Alerts:** a dead target (`ScrapeTargetDown`) suppresses the warnings of the same job.
  - The same unresolved alert is mailed again every 6h.
- **Raspberry Pi:** cAdvisor needs the memory cgroup (`cgroup_enable=memory` in `/boot/firmware/cmdline.txt`).
  - Its expensive metrics are disabled (`--disable_metrics`).
