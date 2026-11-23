"""Agent report: the server's current state as report.json, with PROMPT.md.

The button "Generate Agent-Report" in Grafana opens /agent-report/ (nginx,
Django superusers only). This service asks Prometheus, Loki and Alertmanager
and answers with a zip: agent-report/report.json + agent-report/PROMPT.md.
A coding agent reads PROMPT.md and works through report.json in the repo.

Standard library only - runs in a plain python image.

  python server.py                         serve on AGENT_REPORT_PORT (8080)
  python server.py --write DIR [--hours N] write both files into DIR

Environment:
  PROMETHEUS_URL, LOKI_URL, ALERTMANAGER_URL   base URLs of the three services
  AGENT_REPORT_AUTH    optional Authorization header for them, e.g. over the
                       SSH tunnel through Grafana's data source proxy:
                       PROMETHEUS_URL=http://localhost:3000/grafana/api/datasources/proxy/uid/prometheus
                       (likewise .../uid/loki and .../uid/alertmanager),
                       AGENT_REPORT_AUTH="Bearer <service account token>"
  AGENT_REPORT_SERVER_NAME   shown in the report and the file name
"""
import argparse
import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROMETHEUS_URL = os.environ.get("PROMETHEUS_URL", "http://progeo-prometheus:9090").rstrip("/")
LOKI_URL = os.environ.get("LOKI_URL", "http://progeo-loki:3100").rstrip("/")
ALERTMANAGER_URL = os.environ.get("ALERTMANAGER_URL", "http://progeo-alertmanager:9093").rstrip("/")
AUTH = os.environ.get("AGENT_REPORT_AUTH", "")
SERVER_NAME = os.environ.get("AGENT_REPORT_SERVER_NAME", "") or "progeo"
PORT = int(os.environ.get("AGENT_REPORT_PORT", "8080"))
HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_HOURS = 24
MAX_HOURS = 168
MAX_MESSAGES = 40  # per level, most frequent first
MAX_EXCEPTION_CHARS = 6000
MAX_MESSAGE_CHARS = 2000


# --- HTTP ------------------------------------------------------------------

def get_json(url, params=None, timeout=60):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Authorization": AUTH} if AUTH else {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError("{}: HTTP {} {}".format(url.split("?")[0], error.code, error.read(300).decode("utf-8", "replace")))


def prom(query):
    """Instant query -> [(labels, value)]; NaN and Inf values are dropped."""
    data = get_json(PROMETHEUS_URL + "/api/v1/query", {"query": query})
    rows = []
    for series in data["data"]["result"]:
        value = float(series["value"][1])
        if math.isfinite(value):
            rows.append((series["metric"], value))
    return rows


def prom_scalar(query):
    rows = prom(query)
    return round(rows[0][1], 4) if rows else None


def prom_by(query, label, digits=3):
    return {labels.get(label, ""): round(value, digits) for labels, value in prom(query)}


def loki(query):
    data = get_json(LOKI_URL + "/loki/api/v1/query", {"query": query})
    return [(series["metric"], float(series["value"][1])) for series in data["data"]["result"]]


def loki_lines(query, hours, limit):
    start = int((time.time() - hours * 3600) * 1e9)
    data = get_json(LOKI_URL + "/loki/api/v1/query_range",
                    {"query": query, "limit": limit, "start": start, "direction": "backward"})
    return [value[1] for stream in data["data"]["result"] for value in stream["values"]]


def iso(seconds):
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- log messages (same selection and grouping as the dashboard "Errors and warnings") ---

# errors.jsonl holds every WARNING+ record of the Python loggers; these two
# filters drop the copies of the same records in backend.err.log, celery*.log
# and the cron logs.
DUP = ('!~ "^[[][0-9-]+ [0-9:]+[]] [[][A-Za-z_.]+[]] [[]" '
       '!~ "^ ?[0-9:.]+ +[[][A-Z]+[]]"')
# msg: the message without time stamp, level, numbers and ids. rx: a regex that
# finds the lines of that message again. No backslashes - Loki's template
# parser rejects them.
NORM = (
    '| json jmsg="message" | drop __error__, __error_details__ '
    '| label_format msg=`{{ or .jmsg __line__ }}` '
    '| label_format msg=`{{ regexReplaceAll "(?s)[[:space:]]*[|]?[[:space:]]*[[:cntrl:]].*" .msg "" }}` '
    '| label_format msg=`{{ regexReplaceAll "^[[:space:]]*[[]?[0-9][0-9:., -]+(UTC)?[]]?[[:space:]]*([[](WARNING|ERROR|CRITICAL)[]] )?" .msg "" }}` '
    '| label_format msg=`{{ regexReplaceAll "^([[]django[.a-zA-Z]*[]]) [^ ]+ " .msg "${1} " }}` '
    '| label_format msg=`{{ regexReplaceAll "[0-9a-f]{8}-[0-9a-f-]{27}|0x[0-9a-f]+|[0-9]+" .msg "N" | trunc 160 }}` '
    '| label_format rx=`{{ regexReplaceAll "[^a-zA-Z0-9 ]+" .msg ".+?" }}` '
    '| label_format rx=`{{ regexReplaceAll "N" .rx ".+?" }}`'
)
BY = "by (level, msg, rx)"
TS = "| label_format ts=`{{ __timestamp__ | unixEpoch }}` | unwrap ts"
CLIENT_ERRORS = ('{job="progeo-backend", file="backend.err.log", level=~"WARNING|ERROR|CRITICAL"} '
                 '|~ "^[[][0-9-]+ [0-9:]+[]] [[][A-Z]+[]] [[]django[.](request|security)" '
                 '!~ "Internal Server Error"')


def selector(levels):
    return f'{{job="progeo-backend", level=~"{levels}"}} {DUP}'


def example_line(levels, rx, hours):
    """The newest line of a message, with the fields of errors.jsonl where it came from there."""
    lines = loki_lines(f'{{job="progeo-backend", level=~"{levels}"}} {DUP} |~ "{rx}"', hours, 1)
    if not lines:
        return None
    line = lines[0]
    try:
        record = json.loads(line)
    except ValueError:
        return {"line": line[:MAX_MESSAGE_CHARS + MAX_EXCEPTION_CHARS]}
    if not isinstance(record, dict):
        return {"line": line[:MAX_MESSAGE_CHARS]}
    example = {key: record[key] for key in ("time", "logger", "location", "function", "process", "path") if key in record}
    example["message"] = str(record.get("message", ""))[:MAX_MESSAGE_CHARS]
    for key in ("exception", "stack"):
        if record.get(key):
            # The end of a traceback names the exception and the innermost frames.
            example[key] = str(record[key])[-MAX_EXCEPTION_CHARS:]
    return example


def log_messages(levels, hours, with_projects=False):
    rng = f"{hours}h"
    sel = selector(levels)
    counts = loki(f"sum {BY} (count_over_time({sel} {NORM} [{rng}]))")
    first = {m.get("msg"): v for m, v in loki(f"min {BY} (min_over_time({sel} {NORM} {TS} [{rng}]) {BY})")}
    last = {m.get("msg"): v for m, v in loki(f"max {BY} (max_over_time({sel} {NORM} {TS} [{rng}]) {BY})")}
    new = {m.get("msg") for m, _ in loki(
        f"sum {BY} (count_over_time({sel} {NORM} [{rng}])) unless sum {BY} (count_over_time({sel} {NORM} [7d] offset {rng}))")}
    projects = {}
    if with_projects:
        projects = {m.get("msg"): int(v) for m, v in loki(
            f"count {BY} (sum by (level, msg, rx, project) (count_over_time({sel} {NORM} "
            f'| regexp `project (?P<project>[0-9]+)` | project != "" [{rng}])))')}
    messages = []
    for labels, value in sorted(counts, key=lambda row: -row[1])[:MAX_MESSAGES]:
        msg = labels.get("msg", "")
        entry = {
            "level": labels.get("level"),
            "message": msg,
            "lines": int(value),
            "first_seen": iso(first[msg]) if msg in first else None,
            "last_seen": iso(last[msg]) if msg in last else None,
            "new": msg in new,
        }
        if msg in projects:
            entry["projects_affected"] = projects[msg]
        if labels.get("rx"):
            try:
                entry["example"] = example_line(levels, labels["rx"], hours)
            except Exception as error:  # noqa: BLE001 - one example must not cost the section
                entry["example_error"] = str(error)
        messages.append(entry)
    return {"different_messages": len(counts), "listed": len(messages), "messages": messages}


# --- sections --------------------------------------------------------------

def section_alerts(hours):
    alerts = get_json(ALERTMANAGER_URL + "/api/v2/alerts", {"active": "true", "silenced": "false", "inhibited": "false"})
    return [{
        "name": alert["labels"].get("alertname"),
        "severity": alert["labels"].get("severity"),
        "since": alert.get("startsAt"),
        "labels": {k: v for k, v in alert["labels"].items() if k not in ("alertname", "severity")},
        "summary": alert.get("annotations", {}).get("summary"),
        "description": alert.get("annotations", {}).get("description"),
    } for alert in alerts]


def section_targets(hours):
    return {
        "down": [labels for labels, value in prom("up == 0")],
        "up": len(prom("up == 1")),
    }


def section_errors(hours):
    return log_messages("ERROR|CRITICAL", hours)


def section_warnings(hours):
    return log_messages("WARNING", hours, with_projects=True)


def section_client_errors(hours):
    rows = loki(f"sum {BY} (count_over_time({CLIENT_ERRORS} {NORM} [{hours}h]))")
    rows.sort(key=lambda row: -row[1])
    return {
        "note": "4xx answers and rejected Host headers from backend.err.log. Mostly scanners and expired "
                "tokens; they are kept out of errors.jsonl on purpose.",
        "different_messages": len(rows),
        "messages": [{"level": m.get("level"), "message": m.get("msg"), "lines": int(v)} for m, v in rows[:20]],
    }


def section_celery(hours):
    rng = f"{hours}h"
    run_sum = 'sum by (task) (increase(flower_task_runtime_seconds_sum[%s]))'
    run_count = 'sum by (task) (increase(flower_task_runtime_seconds_count[%s]))'
    quantile = 'histogram_quantile(%s, sum by (le, task) (rate(flower_task_runtime_seconds_bucket[%s])))'
    succeeded = prom_by(f'sum by (task) (increase(flower_events_total{{type="task-succeeded"}}[{rng}])) > 0', "task", 0)
    # Flower creates the failure counter on a task's first failure, which
    # increase() does not see - the "unless ... offset" part catches those.
    failed = prom_by(
        f'(sum by (task) (increase(flower_events_total{{type="task-failed"}}[{rng}])) > 0 '
        'or (sum by (task) (flower_events_total{type="task-failed"}) '
        f'unless sum by (task) (flower_events_total{{type="task-failed"}} offset {rng})))', "task", 0)
    avg = prom_by(f'{run_sum % rng} / ({run_count % rng} > 0)', "task")
    avg_week = prom_by('{} / ({} > 0)'.format(run_sum % "7d", run_count % "7d"), "task")
    median = prom_by(quantile % (0.5, rng), "task")
    p95 = prom_by(quantile % (0.95, rng), "task")
    total = prom_by(run_sum % rng, "task", 1)
    wait = prom_by(f'max by (task) (max_over_time(flower_task_prefetch_time_seconds[{rng}]))', "task")
    tasks = []
    for task in sorted(set(succeeded) | set(failed), key=lambda name: -total.get(name, 0)):
        tasks.append({
            "task": task,
            "succeeded": int(succeeded.get(task, 0)),
            "failed": int(failed.get(task, 0)),
            "avg_runtime_seconds": avg.get(task),
            "avg_runtime_seconds_7d": avg_week.get(task),
            "median_runtime_seconds": median.get(task),
            "p95_runtime_seconds": p95.get(task),
            "total_runtime_seconds": total.get(task),
            "max_wait_seconds": wait.get(task),
        })
    return {
        "note": "From Flower's worker events. Its counters start when Flower starts, so a recent restart "
                "shortens the period. median and p95 are estimates between the histogram's bucket limits. "
                "total_runtime_seconds = worker time the task used in the period.",
        "workers_online": prom_scalar("sum(flower_worker_online) or vector(0)"),
        "queue_backlog": prom_scalar('sum(redis_key_size{key="celery"})'),
        "executing_now": prom_scalar("sum(flower_worker_number_of_currently_executing_tasks)"),
        "period_seconds": hours * 3600,
        "tasks": tasks,
    }


def section_cron(hours):
    exit_codes = prom_by("progeo_cron_job_last_exit_code", "job", 0)
    since_success = prom_by("time() - progeo_cron_job_last_success_timestamp_seconds", "job", 0)
    duration = prom_by("progeo_cron_job_last_duration_seconds", "job", 1)
    interval = prom_by("progeo_cron_job_interval_seconds", "job", 0)
    running = prom_by("progeo_cron_job_running", "job", 0)
    return [{
        "job": job,
        "last_exit_code": int(exit_codes[job]) if job in exit_codes else None,
        "seconds_since_last_success": since_success.get(job),
        "last_duration_seconds": duration.get(job),
        "interval_seconds": interval.get(job),
        "running": bool(running.get(job)),
    } for job in sorted(set(exit_codes) | set(since_success) | set(duration))]


def section_api(hours):
    rng = f"{hours}h"
    return {
        "requests_per_second": prom_scalar(f"sum(rate(progeo_http_requests_total[{rng}]))"),
        "share_5xx": prom_scalar(f'sum(rate(progeo_http_requests_total{{status=~"5.."}}[{rng}])) '
                                 f'/ sum(rate(progeo_http_requests_total[{rng}]))') or 0,
        "p95_seconds": prom_scalar("histogram_quantile(0.95, sum by (le) "
                                   f"(rate(progeo_http_request_duration_seconds_bucket[{rng}])))"),
        "responses_5xx_by_view": [
            {"view": m.get("view"), "status": m.get("status"), "responses": round(v)}
            for m, v in sorted(prom(f'sum by (view, status) (increase(progeo_http_requests_total{{status=~"5.."}}[{rng}])) > 0'),
                               key=lambda row: -row[1])],
        "slowest_views_p95_seconds": dict(sorted(prom_by(
            "topk(15, histogram_quantile(0.95, sum by (le, view) "
            f"(rate(progeo_http_request_duration_seconds_bucket[{rng}]))))", "view").items(), key=lambda kv: -kv[1])),
        "busiest_views_requests": dict(sorted(prom_by(
            f"topk(15, sum by (view) (increase(progeo_http_requests_total[{rng}])))", "view", 0).items(),
            key=lambda kv: -kv[1])),
    }


def statements(query):
    return [{"database": m.get("datname"), "query": m.get("query"), "seconds": round(v, 3)}
            for m, v in sorted(prom(query), key=lambda row: -row[1])]


def section_database(hours):
    rng = f"{hours}h"
    join = " * on (queryid) group_left(query) max by (queryid, query) (pg_stat_statements_query_id)"
    total = f"sum by (datname, queryid) (increase(pg_stat_statements_seconds_total[{rng}]))"
    calls = f"sum by (datname, queryid) (increase(pg_stat_statements_calls_total[{rng}]))"
    return {
        "connections_used_share": prom_scalar("sum(pg_stat_database_numbackends) / max(pg_settings_max_connections)"),
        "deadlocks": prom_scalar(f"sum(increase(pg_stat_database_deadlocks[{rng}]))"),
        "oldest_open_transaction_seconds": prom_scalar("max(pg_stat_activity_max_tx_duration)"),
        "statements_by_total_seconds": statements(f"topk(15, {total}){join}"),
        "statements_by_mean_seconds_per_call": statements(f"topk(15, {total} / ({calls} > 0)){join}"),
    }


def section_host(hours):
    rng = f"{hours}h"
    busy = '1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))'
    memory = "1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes"
    disks = 'fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs"'
    cpu = 'sum by (name) (rate(container_cpu_usage_seconds_total{name=~"progeo-.+"}[5m]))'
    mem = 'sum by (name) (container_memory_working_set_bytes{name=~"progeo-.+"})'
    cpu_avg = prom_by(f"avg_over_time(({cpu})[{rng}:5m])", "name")
    cpu_max = prom_by(f"max_over_time(({cpu})[{rng}:5m])", "name")
    mem_now = prom_by(mem, "name", 0)
    mem_max = prom_by(f"max_over_time(({mem})[{rng}:5m])", "name", 0)
    restarts = prom_by(f'sum by (name) (changes(container_start_time_seconds{{name=~"progeo-.+"}}[{rng}])) > 0', "name", 0)
    # progeo-process-exporter: the process groups inside progeo-backend.
    group_cpu = "sum by (groupname) (rate(namedprocess_namegroup_cpu_seconds_total[5m]))"
    group_mem = 'sum by (groupname) (namedprocess_namegroup_memory_bytes{memtype="proportionalResident"})'
    group_cpu_avg = prom_by(f"avg_over_time(({group_cpu})[{rng}:5m])", "groupname")
    group_cpu_max = prom_by(f"max_over_time(({group_cpu})[{rng}:5m])", "groupname")
    group_mem_max = prom_by(f"max_over_time(({group_mem})[{rng}:5m])", "groupname", 0)
    return {
        "backend_process_groups": [{
            "group": group,
            "cpu_cores_avg": group_cpu_avg.get(group),
            "cpu_cores_max": group_cpu_max.get(group),
            "memory_bytes_max": group_mem_max.get(group),
        } for group in sorted(set(group_cpu_max) | set(group_mem_max), key=lambda g: -(group_cpu_max.get(g) or 0))],
        "cpu_busy_share_now": prom_scalar(busy),
        "cpu_busy_share_max": prom_scalar(f"max_over_time(({busy})[{rng}:5m])"),
        "cpu_cores": prom_scalar('count(node_cpu_seconds_total{mode="idle"})'),
        "load_1m": prom_scalar("node_load1"),
        "memory_used_share_now": prom_scalar(memory),
        "memory_used_share_max": prom_scalar(f"max_over_time(({memory})[{rng}:5m])"),
        "fullest_disk_used_share": prom_scalar(
            f"max(1 - node_filesystem_avail_bytes{{{disks}}} / node_filesystem_size_bytes{{{disks}}})"),
        "containers": [{
            "name": name,
            "cpu_cores_avg": cpu_avg.get(name),
            "cpu_cores_max": cpu_max.get(name),
            "memory_bytes_now": mem_now.get(name),
            "memory_bytes_max": mem_max.get(name),
            "restarts": int(restarts.get(name, 0)),
        } for name in sorted(set(cpu_avg) | set(mem_now), key=lambda n: -(cpu_avg.get(n) or 0))],
    }


def section_notifications(hours):
    rng = f"{hours}h"
    return {
        "open_cases": prom_by("sum by (kind) (progeo_notification_cases_open)", "kind", 0),
        "open_cases_reaching_nobody": prom_by("sum by (kind) (progeo_notification_cases_unreachable)", "kind", 0),
        "seconds_since_last_processing": prom_scalar("time() - max(progeo_notification_process_last_run_timestamp_seconds)"),
        "outbound_messages": [
            {"channel": m.get("channel"), "status": m.get("status"), "messages": round(v)}
            for m, v in prom(f"sum by (channel, status) (increase(progeo_outbound_messages_total[{rng}])) > 0")],
    }


def section_backups(hours):
    return {
        "last_run_ok": prom_scalar("max(progeo_backup_transfer_last_run_ok)"),
        "seconds_since_last_success": prom_scalar("time() - max(progeo_backup_transfer_last_success_timestamp_seconds)"),
        "databases_without_fresh_dump": prom_scalar("max(progeo_backup_transfer_last_success_stale_databases)"),
    }


SECTIONS = [
    ("firing_alerts", section_alerts),
    ("scrape_targets", section_targets),
    ("log_errors", section_errors),
    ("log_warnings", section_warnings),
    ("client_errors", section_client_errors),
    ("celery", section_celery),
    ("cron_jobs", section_cron),
    ("api", section_api),
    ("database", section_database),
    ("host", section_host),
    ("notifications", section_notifications),
    ("backups", section_backups),
]


def build_report(hours):
    report = {
        "generated_at": iso(time.time()),
        "server": SERVER_NAME,
        "period_hours": hours,
        "summary": {},
        "failed_sections": {},
    }
    for name, collect in SECTIONS:
        try:
            report[name] = collect(hours)
        except Exception as error:  # noqa: BLE001 - a missing exporter must not cost the rest
            report["failed_sections"][name] = f"{type(error).__name__}: {error}"
    celery_tasks = (report.get("celery") or {}).get("tasks", [])
    report["summary"] = {
        "firing_alerts": len(report.get("firing_alerts") or []),
        "different_error_messages": (report.get("log_errors") or {}).get("different_messages"),
        "different_warning_messages": (report.get("log_warnings") or {}).get("different_messages"),
        "new_messages": sum(1 for key in ("log_errors", "log_warnings")
                            for m in (report.get(key) or {}).get("messages", []) if m.get("new")),
        "celery_tasks_with_failures": sum(1 for task in celery_tasks if task["failed"]),
        "cron_jobs_failed": sum(1 for job in report.get("cron_jobs") or [] if job["last_exit_code"]),
        "views_with_5xx": len((report.get("api") or {}).get("responses_5xx_by_view", [])),
        "sections_that_could_not_be_read": sorted(report["failed_sections"]),
    }
    return report


def read_prompt():
    with open(os.path.join(HERE, "PROMPT.md"), encoding="utf-8") as fh:
        return fh.read()


def report_json(hours):
    return json.dumps(build_report(hours), indent=2, ensure_ascii=False) + "\n"


# --- server ----------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "progeo-agent-report"

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        path = url.path.rstrip("/")
        if path == "/healthz":
            return self.answer(200, "text/plain", b"ok\n")
        if not path.endswith("/agent-report"):
            return self.answer(404, "text/plain", b"not found\n")
        try:
            hours = int(urllib.parse.parse_qs(url.query).get("hours", [DEFAULT_HOURS])[0])
        except ValueError:
            hours = DEFAULT_HOURS
        hours = max(1, min(MAX_HOURS, hours))
        try:
            body = io.BytesIO()
            with zipfile.ZipFile(body, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("agent-report/PROMPT.md", read_prompt())
                archive.writestr("agent-report/report.json", report_json(hours))
        except Exception as error:  # noqa: BLE001 - the browser gets the reason, not a dropped connection
            return self.answer(500, "text/plain", (f"agent report failed: {error}\n").encode())
        name = "agent-report-{}-{}.zip".format(re.sub(r"[^A-Za-z0-9_.-]+", "-", SERVER_NAME),
                                           datetime.now(UTC).strftime("%Y%m%d-%H%M"))
        self.answer(200, "application/zip", body.getvalue(),
                    {"Content-Disposition": f'attachment; filename="{name}"'})

    def answer(self, status, content_type, body, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if "/healthz" not in (args[0] if args else ""):
            sys.stderr.write(f"{self.log_date_time_string()} {fmt % args}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--write", metavar="DIR", help="write report.json and PROMPT.md into DIR instead of serving")
    parser.add_argument("--hours", type=int, default=DEFAULT_HOURS, help="period the report covers (default 24)")
    args = parser.parse_args()
    if args.write:
        hours = max(1, min(MAX_HOURS, args.hours))
        os.makedirs(args.write, exist_ok=True)
        with open(os.path.join(args.write, "report.json"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(report_json(hours))
        with open(os.path.join(args.write, "PROMPT.md"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(read_prompt())
        print("wrote report.json and PROMPT.md to", args.write)
        return
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
