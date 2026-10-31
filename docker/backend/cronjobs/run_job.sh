#!/bin/sh
# Run one cron job and leave a status file for progeo.metrics.CronJobCollector.
#
# Usage: run_job.sh <job-name> <command> [args...]
# The wrapper keeps the job's output/exit code unchanged; status files are
# written atomically so a Prometheus scrape never reads a half-written JSON.
set -u

job="${1:?run_job.sh needs a job name}"
shift
[ "$#" -gt 0 ] || { echo "run_job.sh needs a command" >&2; exit 2; }

status_dir="${CRON_STATUS_DIR:-/var/log/progeo/cron}"
mkdir -p "$status_dir" 2>/dev/null || true
status_file="$status_dir/${job}.json"
success_file="$status_dir/${job}.success"
tmp_file="$status_dir/.${job}.tmp"
success_tmp="$status_dir/.${job}.success.tmp"

started="$(date +%s)"
if printf '{"job":"%s","state":"running","started_at":%s,"finished_at":null,"duration_seconds":null,"exit_code":null}\n' \
    "$job" "$started" > "$tmp_file" 2>/dev/null; then
    mv "$tmp_file" "$status_file" 2>/dev/null || true
fi

"$@"
rc=$?

finished="$(date +%s)"
duration=$((finished - started))
if printf '{"job":"%s","state":"finished","started_at":%s,"finished_at":%s,"duration_seconds":%s,"exit_code":%s}\n' \
    "$job" "$started" "$finished" "$duration" "$rc" > "$tmp_file" 2>/dev/null; then
    mv "$tmp_file" "$status_file" 2>/dev/null || true
fi
if [ "$rc" -eq 0 ]; then
    if printf '%s %s\n' "$finished" "$duration" > "$success_tmp" 2>/dev/null; then
        mv "$success_tmp" "$success_file" 2>/dev/null || true
    fi
fi

exit "$rc"
