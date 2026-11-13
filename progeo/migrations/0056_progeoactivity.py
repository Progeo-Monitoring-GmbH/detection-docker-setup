# Usage analysis of normal users (ProgeoActivity, helper/activity.py): logins,
# page views with their visible time and clicks - only with
# ACTIVITY_TRACKING_ENABLED and the user's consent, deleted after
# ACTIVITY_RETENTION_DAYS.

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('progeo', '0055_progeolageplan_heat_sigma'),
    ]

    operations = [
        migrations.CreateModel(
            name='ProgeoActivity',
            fields=[
                ('id', models.BigAutoField(primary_key=True, serialize=False)),
                ('session', models.CharField(max_length=64)),
                ('kind', models.CharField(choices=[('login', 'Login'), ('page', 'Page view'), ('click', 'Click')], max_length=8)),
                ('path', models.CharField(max_length=255)),
                ('target', models.CharField(blank=True, default='', max_length=100)),
                ('duration_ms', models.PositiveIntegerField(blank=True, null=True)),
                ('created_at', models.DateTimeField(db_index=True, default=django.utils.timezone.now)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name_plural': 'Progeo activities',
                'ordering': ['-created_at', '-id'],
                'indexes': [
                    models.Index(fields=['kind', 'created_at'], name='progeo_activity_kind_created'),
                    models.Index(fields=['user', 'created_at'], name='progeo_activity_user_created'),
                ],
            },
        ),
    ]
