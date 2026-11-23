# Written by hand: the sensor mapping per device (helper/sensor_mapping.py).

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0075_progeolocation_merged_at'),
    ]

    operations = [
        migrations.CreateModel(
            name='ProgeoSensorMapping',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('valid_from', models.DateTimeField(default=django.utils.timezone.now)),
                ('positions', models.JSONField(blank=True, null=True)),
                ('manual', models.JSONField(blank=True, default=list)),
                ('origin', models.CharField(choices=[('klemmliste', 'Klemmliste'), ('manual', 'Von Hand'), ('formula', 'Formel (erster Sensor + Eingang)'), ('merge', 'Zusammenführung')], max_length=16)),
                ('source_name', models.CharField(blank=True, default='', max_length=255)),
                ('created_by_id', models.IntegerField(blank=True, null=True)),
                ('created', models.DateTimeField(auto_now_add=True)),
                ('device', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='sensor_mappings', to='progeo.progeodevice')),
            ],
            options={
                'ordering': ['device_id', 'valid_from', 'id'],
                'indexes': [models.Index(fields=['device', 'valid_from'], name='progeo_sensormap_device_from')],
            },
        ),
    ]
