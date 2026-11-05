# Störungsprofile (noise masks of a device's EP / WP) - see helper/noise_profiles.py.

import django.contrib.postgres.fields
import django.db.models.deletion
import django.db.models.manager
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0048_remove_progeodevice_pending_commands_and_more'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='ProgeoNoiseProfile',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=100)),
                ('mask_e', django.contrib.postgres.fields.ArrayField(base_field=models.IntegerField(), blank=True, default=list, size=None)),
                ('mask_w', django.contrib.postgres.fields.ArrayField(base_field=models.IntegerField(), blank=True, default=list, size=None)),
                ('sum_e', models.BigIntegerField(default=0)),
                ('sum_w', models.BigIntegerField(default=0)),
                ('source_from', models.DateTimeField(blank=True, null=True)),
                ('source_to', models.DateTimeField(blank=True, null=True)),
                ('source_count', models.IntegerField(default=0)),
                ('is_active', models.BooleanField(default=False)),
                ('activated_at', models.DateTimeField(blank=True, null=True)),
                ('created', models.DateTimeField(auto_now_add=True)),
                ('updated', models.DateTimeField(auto_now=True)),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('device', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='noise_profiles', to='progeo.progeodevice')),
            ],
            options={
                'base_manager_name': 'prefetch_manager',
                'indexes': [models.Index(fields=['device', 'is_active'], name='progeo_noise_device_active')],
                'constraints': [models.UniqueConstraint(condition=models.Q(('is_active', True)), fields=('device',), name='progeo_noise_one_active_per_device')],
            },
            managers=[
                ('objects', django.db.models.manager.Manager()),
                ('prefetch_manager', django.db.models.manager.Manager()),
            ],
        ),
    ]
