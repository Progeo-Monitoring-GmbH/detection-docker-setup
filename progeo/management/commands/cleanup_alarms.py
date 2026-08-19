import datetime

from django.core.management.base import BaseCommand
from django.utils import timezone

from progeo.helper.basics import elog, ilog
from progeo.settings import DATABASES
from progeo.v1.creator import _alarm_start, _alarm_window_end, merge_alarm_into
from progeo.v1.models import ProgeoAlarm


class Command(BaseCommand):
    help = (
        "Merge overlapping ProgeoAlarm rows per device and delete the duplicates. "
        "An alarm is considered overlapping when its active window "
        "[triggered_at, normalized_at] intersects another alarm of the same device "
        "(still-active alarms have an open end). The earliest alarm of the group "
        "survives and absorbs the merged history; all merged duplicates are deleted. "
        "Idempotent and safe to re-run."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            default=None,
            help="Only process a single database (defaults to all configured databases).",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Only report what would be merged/deleted without changing anything.",
        )

    def handle(self, *args, **options):
        db_names = [options["db"]] if options.get("db") else list(DATABASES.keys())
        dry_run = options["dry_run"]

        total_merged = 0
        total_deleted = 0

        for db_name in db_names:
            try:
                merged, deleted = self._cleanup_db(db_name, dry_run=dry_run)
            except Exception as exc:
                elog(f"[cleanup_alarms] db={db_name} failed: {exc}")
                continue

            total_merged += merged
            total_deleted += deleted
            ilog(f"[cleanup_alarms] db={db_name} merged={merged} deleted={deleted}")

        ilog(f"[cleanup_alarms] total merged={total_merged} deleted={total_deleted}")
        self.stdout.write(
            self.style.SUCCESS(
                f"Merged {total_merged} overlapping alarms, deleted {total_deleted} duplicate rows."
                + (" (dry run, nothing changed)" if dry_run else "")
            )
        )

    def _cleanup_db(self, db: str, dry_run: bool = False) -> tuple[int, int]:
        """Merge overlapping alarms of one database. Returns (merged, deleted)."""
        alarms = list(
            ProgeoAlarm.objects.using(db)
            .select_related("measurement__device")
            .order_by("measurement__device_id", "triggered_at", "id")
        )

        # Group by device (alarms with a missing device land in their own group and
        # are only merged when their windows overlap by timestamp).
        groups: dict = {}
        for alarm in alarms:
            device_id = alarm.measurement.device_id if alarm.measurement_id else None
            groups.setdefault(device_id, []).append(alarm)

        merged = 0
        deleted = 0
        for device_id, rows in groups.items():
            # Sort by effective start time so overlaps can be merged in one pass.
            rows.sort(key=lambda a: (_alarm_start(a) or datetime.datetime.min.replace(tzinfo=timezone.utc), a.pk))

            current = None
            for alarm in rows:
                if current is None:
                    current = alarm
                    continue

                alarm_start = _alarm_start(alarm)
                current_end = _alarm_window_end(current)
                if alarm_start is not None and current_end is not None and alarm_start <= current_end:
                    if dry_run:
                        self.stdout.write(
                            f"[dry-run] would merge alarm {alarm.pk} "
                            f"(start={_alarm_start(alarm)}) into {current.pk} "
                            f"(end={_alarm_window_end(current)}) [device {device_id}]"
                        )
                    else:
                        merge_alarm_into(current, alarm, db)
                    merged += 1
                    deleted += 1
                    # `current` may have been extended (still-active / later end),
                    # so keep merging subsequent rows into it.
                else:
                    current = alarm

        return merged, deleted
