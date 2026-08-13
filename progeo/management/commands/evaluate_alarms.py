from django.core.management.base import BaseCommand
from progeo.helper.basics import dlog
from progeo.v1.models import ProgeoAlarm, ProgeoMeasurement


class Command(BaseCommand):
    help = 'iterates over all models and resets the id if existing'

    def handle(self, *args, **options):
        db = "default"
        alarms = ProgeoAlarm.objects.using(db).filter(normalized_at__isnull=True).all()
        for alarm in alarms:
            first_measurement = alarm.measurement
            device = first_measurement.device
            last_measurement = ProgeoMeasurement.objects.using(db).filter(device=device).order_by('-id').first()

            if last_measurement and last_measurement.last_updated > alarm.still_active_at:
                sensor_id, max_value = last_measurement.evaluate(alarm.threshold)
                if sensor_id is not None and max_value is not None:
                    alarm.still_active_at = last_measurement.last_updated
                    alarm.save(using=db)
                else:
                    alarm.normalized_at = last_measurement.last_updated
                    alarm.save(using=db)


        dlog("DONE!")
