import datetime

from django.core.management.base import BaseCommand
from django.utils import timezone

from progeo.helper.basics import dlog, elog, ilog
from progeo.settings import DATABASES
from progeo.v1.creator import create_progeo_alarm_safe
from progeo.v1.models import ProgeoLocation, ProgeoMeasurement

LOOKBACK = datetime.timedelta(hours=1)

class Command(BaseCommand):
    help = (
        "Iterates over all locations and evaluates every ProgeoMeasurement of the last hour. "
        "Measurements above the location threshold raise an alarm via create_progeo_alarm_safe; "
        "subsequent measurements prolong the still-active alarm instead of creating a new one."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            default=None,
            help="Only evaluate a single database (defaults to all configured databases).",
        )

    def handle(self, *args, **options):
        db_names = [options["db"]] if options.get("db") else list(DATABASES.keys())
        cutoff = timezone.now() - LOOKBACK

        total_locations = 0
        total_triggered = 0

        for db in db_names:
            try:
                locations, triggered = self._evaluate_db(db, cutoff)
            except Exception as exc:
                elog(f"[evaluate_measurements] db={db} failed: {exc}")
                continue

            total_locations += locations
            total_triggered += triggered
            ilog(f"[evaluate_measurements] db={db} locations={locations} alarms_triggered={triggered}")

        ilog(f"[evaluate_measurements] total locations={total_locations} alarms_triggered={total_triggered}")
        dlog("DONE!")

    def _evaluate_db(self, db: str, cutoff) -> tuple[int, int]:
        """Evaluate every last-hour measurement of every location in one pass."""

        # One query for all locations: every measurement of the last hour with its
        # device+location already joined. `last_fetched` is set on every save and is
        # the reliable "when did the measurement arrive" field.
        measurements = (
            ProgeoMeasurement.objects.using(db)
            .filter(last_fetched__gte=cutoff)
            .select_related("device__location")
            .order_by("device__location__pk","last_fetched")
        )

        triggered = 0
        location_ids = 0
        location_id = None
        dlog(f"Found Measurements: {measurements.count()}")
        for measurement in measurements:
            location = measurement.device.location
            if location is None:
                if measurement.device:
                    location, created = ProgeoLocation.objects.using(db).get_or_create(project_id=measurement.device.project_id)
                    if created:
                        ilog(f"Created new Location {location} for device {measurement.device}!")
                        location.save(using=db)
                    device = measurement.device
                    device.location = location
                    device.save(using=db)
                else:
                    elog(f"No Location found for measurement {measurement} | device={measurement.device}!")
                    continue

            if location_id != location.project_id:
                location_ids += 1
            location_id = location.project_id

            threshold = location.alarm_threshold
            sensor_id, max_value = measurement.evaluate(threshold)
            if sensor_id is None or max_value is None:
                continue

            triggered += 1
            dlog(f"ALARM TRIGGERED: location={location.project_id} at={measurement.last_fetched}")
            create_progeo_alarm_safe(
                measurement=measurement,
                sensor_id=sensor_id + 1,  # 1-based sensor index, matches sensor_order
                max_value=max_value,
                threshold=threshold,
                triggered_at=measurement.last_fetched,
                db=db,
            )

        return location_ids, triggered
