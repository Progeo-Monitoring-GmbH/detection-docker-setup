# ProgeoDevice.notify_on_measurements: mail every staff user when the device's
# next measurement arrives, then clear the flag (helper/measurement_notice.py).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0061_progeodevice_sensor_count'),
    ]

    operations = [
        migrations.AddField(
            model_name='progeodevice',
            name='notify_on_measurements',
            field=models.BooleanField(default=False),
        ),
    ]
