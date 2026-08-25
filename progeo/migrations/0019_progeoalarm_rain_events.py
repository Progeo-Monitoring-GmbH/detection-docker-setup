import jsonfield.fields
from django.db import migrations, models


def forward_rain_to_events(apps, schema_editor):
    """Convert the single (rain_start, rain_duration, rain_amount) triple into a rain_events list."""
    ProgeoAlarm = apps.get_model("progeo", "ProgeoAlarm")
    db_alias = schema_editor.connection.alias
    for alarm in ProgeoAlarm.objects.using(db_alias).all().iterator():
        if alarm.rain_start is None:
            continue
        alarm.rain_events = [{
            "start": alarm.rain_start.isoformat(),
            "duration": alarm.rain_duration,
            "amount": alarm.rain_amount,
        }]
        alarm.save(using=db_alias, update_fields=["rain_events"])


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0018_email_error_email_location_email_sent'),
    ]

    operations = [
        migrations.AddField(
            model_name='progeoalarm',
            name='rain_events',
            field=jsonfield.fields.JSONField(blank=True, default=list),
        ),
        migrations.RunPython(forward_rain_to_events, migrations.RunPython.noop),
        migrations.RemoveField(
            model_name='progeoalarm',
            name='rain_start',
        ),
        migrations.RemoveField(
            model_name='progeoalarm',
            name='rain_duration',
        ),
        migrations.RemoveField(
            model_name='progeoalarm',
            name='rain_amount',
        ),
    ]
