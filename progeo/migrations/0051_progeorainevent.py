# Rain events move from the alarms (ProgeoAlarm.rain_events, a JSON list per
# alarm) to their own model per location (ProgeoRainEvent), fetched hourly for
# locations with rain_check_enabled - see helper/weather.py. The events the
# alarms carry are copied over (once per location and start) before the alarm
# fields are dropped; this runs in every database, so each project database
# copies its own alarms' events.

import datetime
import json

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.utils import dateparse, timezone


def _parse_start(raw):
    start = dateparse.parse_datetime(raw) if isinstance(raw, str) else None
    if start is None:
        return None
    if settings.USE_TZ and timezone.is_naive(start):
        return timezone.make_aware(start)
    if not settings.USE_TZ and timezone.is_aware(start):
        return timezone.make_naive(start)
    return start


def copy_alarm_rain_events(apps, schema_editor):
    db = schema_editor.connection.alias
    ProgeoAlarm = apps.get_model("progeo", "ProgeoAlarm")
    ProgeoRainEvent = apps.get_model("progeo", "ProgeoRainEvent")

    events = {}
    rows = (
        ProgeoAlarm.objects.using(db)
        .filter(rain_checked=True, measurement__device__location__isnull=False)
        .values_list("measurement__device__location_id", "rain_events")
    )
    for location_id, raw_events in rows.iterator():
        if isinstance(raw_events, str):
            try:
                raw_events = json.loads(raw_events)
            except ValueError:
                continue
        for event in raw_events or []:
            if not isinstance(event, dict):
                continue
            start = _parse_start(event.get("start"))
            try:
                hours = float(event.get("duration") or 0)
                amount = float(event.get("amount") or 0)
            except (TypeError, ValueError):
                continue
            if start is None or hours <= 0:
                continue
            key = (location_id, start)
            end = start + datetime.timedelta(hours=hours)
            # The same rain caught by several alarms: keep the longest reading.
            if key not in events or end > events[key][0]:
                events[key] = (end, amount)

    ProgeoRainEvent.objects.using(db).bulk_create(
        [
            ProgeoRainEvent(location_id=location_id, start=start, end=end, amount=amount)
            for (location_id, start), (end, amount) in events.items()
        ],
        batch_size=1000,
        ignore_conflicts=True,
    )


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0050_alter_usermodulepermissions_options_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='progeolocation',
            name='rain_check_enabled',
            field=models.BooleanField(blank=True, default=False),
        ),
        migrations.CreateModel(
            name='ProgeoRainEvent',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('start', models.DateTimeField()),
                ('end', models.DateTimeField()),
                ('amount', models.FloatField(help_text='Precipitation over the event in mm')),
                ('created', models.DateTimeField(auto_now_add=True)),
                ('updated', models.DateTimeField(auto_now=True)),
                ('location', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='rain_events', to='progeo.progeolocation')),
            ],
            options={
                'ordering': ['location', 'start'],
                'constraints': [models.UniqueConstraint(fields=('location', 'start'), name='progeo_rain_event_location_start')],
            },
        ),
        migrations.RunPython(copy_alarm_rain_events, migrations.RunPython.noop),
        migrations.RemoveField(
            model_name='progeoalarm',
            name='rain_checked',
        ),
        migrations.RemoveField(
            model_name='progeoalarm',
            name='rain_events',
        ),
    ]
