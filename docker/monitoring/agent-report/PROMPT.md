# Agent report: find and fix the backend's actual problems

You are working in the repository of the Progeo backend (Django, Celery, cron jobs; code in `progeo/`, containers in `docker/`). Next to this file is `report.json`, a snapshot of the production server taken from its monitoring (Prometheus, Loki, Alertmanager). Your job is to find the real problems in it, fix the ones whose cause is in this repository, and report the rest.

The report shows symptoms. Treat every entry as a lead to check in the code, not as a diagnosis.

## What is in report.json

`generated_at`, `server` and `period_hours` say when and over which period the data was collected. `summary` gives the counts. `failed_sections` lists sections that could not be read; missing data there means "unknown", not "fine".

| Section | Content |
|---|---|
| `firing_alerts` | Alerts firing right now, with summary and start time. The rules are in `docker/monitoring/prometheus/rules/alerts.yml` and `docker/monitoring/loki/rules/alerts.yml`. |
| `log_errors` | ERROR and CRITICAL log records, grouped by message. Numbers and ids in `message` are replaced by `N`. |
| `log_warnings` | WARNING records, grouped the same way. `projects_affected` counts the project numbers a message named. |
| `client_errors` | 4xx answers and rejected Host headers. Mostly scanners and expired tokens. |
| `celery` | Per task: runs, failures, runtimes, worker time used. |
| `cron_jobs` | Per job: last exit code, time since last success, duration, interval. |
| `api` | Request rate, 5xx responses by view, slowest and busiest views. |
| `database` | Connections, deadlocks, and the statements PostgreSQL spent the most time on. |
| `host` | CPU, memory and disk of the host, and CPU, memory and restarts per container. `backend_process_groups` splits the backend container into `api`, `celery worker`, `celery beat`, `manage.py <command>` and `cron <job>`. |
| `notifications`, `backups` | Open notification cases, outbound mail/SMS, state of the backup transfer. |

Each log message has `lines`, `first_seen`, `last_seen` and `new` (true = it did not occur in the 7 days before the period). `example` is its newest record: `logger`, `message`, `location` (file and line), `function`, `process`, and `exception` with the end of the traceback where one was recorded.

`location` and traceback paths are paths inside the container. The part from `progeo/` on is the path in this repository. Paths under `/opt/venv/` are third-party packages: look further up the traceback for the last frame in `progeo/`.

## Order of work

1. **Firing alerts.** Each one is a confirmed problem. Find out what it measures from its rule, then why it fires.
2. **Errors with a traceback** (`log_errors`). Start with those that are `new` or have many `lines`. Open the file and line, read the surrounding code, and work out which input or state causes the exception.
3. **Failing Celery tasks and cron jobs.** A task with `failed` > 0 usually has a matching entry in `log_errors` that names the task. A cron job with a non-zero `last_exit_code`, or whose `seconds_since_last_success` is several times its `interval_seconds`, is broken or stuck.
4. **Views with 5xx responses** (`api.responses_5xx_by_view`). Match them to errors in `log_errors` through the `path` in the example.
5. **Performance.** Look for these patterns:
   - A Celery task whose `avg_runtime_seconds` is longer than the interval it is scheduled at (schedules: `CELERY_BEAT_SCHEDULE` in `progeo/settings.py` or `progeo/celery.py`). Its runs overlap or queue up.
   - A task whose `avg_runtime_seconds` is far above `avg_runtime_seconds_7d`: it got slower.
   - The tasks at the top of `total_runtime_seconds` (the list is sorted by it): they use the most worker time, so an improvement there pays the most.
   - Views at the top of `slowest_views_p95_seconds` that are also in `busiest_views_requests`.
   - Statements in `database.statements_by_total_seconds`. Find the ORM query that produces each one. Look for missing indexes, queries inside loops, and columns or rows fetched and then not used.
   - Containers in `host.containers` with a `cpu_cores_max` near the number of cores, a `memory_bytes_max` far above `memory_bytes_now`, or `restarts` > 0.
6. **Warnings** (`log_warnings`). A warning that occurs thousands of times is either a real defect in the data path or a message at the wrong level. Decide which by reading the code that emits it, and say so. Warnings that are `new` deserve a look even with few lines.

`client_errors` needs no fix unless one message points at our own frontend or devices calling a route wrongly (for example a device endpoint answering "Bad Request" many times).

## Rules for a fix

- **Confirm the cause in the code first.** Reproduce it with a test where you can. If you cannot tell why something happens, say what you would need to know. Do not guess a fix.
- **Fix the cause, not the message.** Catching an exception to hide it, lowering a log level to quiet a real defect, or raising a timeout or limit so an alert stops firing is not a fix.
- **One problem per change.** Keep each fix small and separate, with a test that fails without it.
- **Leave what is not a code problem.** File permissions, missing keys, DNS, server settings and environment variables are fixed on the server. Describe the finding and the step for the operator.
- **Do not change alert rules or dashboards** to make a finding go away.
- **Follow the repository's own instructions** (CLAUDE.md, memory, test settings) for how to run tests and which commands are yours to run.

## What to hand back

A list of the findings, most important first. For each one give:

- what the report showed (section and entry),
- the cause you found, with file and line,
- what you changed, or why you changed nothing,
- how you checked it (test name and result),
- anything the operator has to do on the server.

Then list the entries you looked at and judged harmless, with one line of reason each, and the entries you could not explain.
