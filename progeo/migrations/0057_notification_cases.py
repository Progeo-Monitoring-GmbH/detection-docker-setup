# Staged notifications (helper/notification_cases.py, docs/notifications.md):
# NotificationCase per location and problem (offline / alarm) with its
# protocol, the acknowledge/unsubscribe links of the mails, the unsubscribes,
# and OutboundMessage.case_id so a bounce reaches its case.

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0056_progeoactivity'),
    ]

    operations = [
        migrations.AddField(
            model_name='outboundmessage',
            name='case_id',
            field=models.IntegerField(blank=True, db_index=True, null=True),
        ),
        migrations.CreateModel(
            name='NotificationCase',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('kind', models.CharField(choices=[('offline', 'Offline'), ('alarm', 'Alarm')], max_length=16)),
                ('state', models.CharField(choices=[('open', 'Offen'), ('resolved', 'Erledigt')], db_index=True, default='open', max_length=16)),
                ('db', models.CharField(default='default', max_length=100)),
                ('location_id', models.IntegerField(db_index=True)),
                ('project_id', models.IntegerField(blank=True, null=True)),
                ('location_name', models.CharField(blank=True, default='', max_length=255)),
                ('stage', models.IntegerField(default=0)),
                ('opened_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('last_contact_at', models.DateTimeField(blank=True, null=True)),
                ('next_contact_at', models.DateTimeField(blank=True, db_index=True, null=True)),
                ('devices', models.JSONField(blank=True, default=dict)),
                ('alarm_ids', models.JSONField(blank=True, default=list)),
                ('notified', models.JSONField(blank=True, default=list)),
                ('back_since', models.DateTimeField(blank=True, null=True)),
                ('muted_until', models.DateTimeField(blank=True, null=True)),
                ('unreachable_since', models.DateTimeField(blank=True, null=True)),
                ('acknowledged_at', models.DateTimeField(blank=True, null=True)),
                ('acknowledged_by_id', models.IntegerField(blank=True, null=True)),
                ('acknowledged_via', models.CharField(blank=True, default='', max_length=16)),
                ('escalation_id', models.IntegerField(blank=True, null=True)),
                ('resolved_at', models.DateTimeField(blank=True, null=True)),
                ('resolution', models.CharField(blank=True, choices=[('back_online', 'Wieder online'), ('acknowledged', 'Quittiert'), ('alarms_gone', 'Alarme entfernt'), ('manual', 'Manuell geschlossen')], default='', max_length=16)),
                ('online_mail_due', models.BooleanField(default=False)),
                ('online_mail_sent_at', models.DateTimeField(blank=True, null=True)),
                ('updated', models.DateTimeField(default=django.utils.timezone.now)),
            ],
            options={
                'ordering': ['-opened_at'],
                'constraints': [
                    models.UniqueConstraint(condition=models.Q(('state', 'open')), fields=('kind', 'db', 'location_id'), name='progeo_notifcase_one_open'),
                ],
                'indexes': [
                    models.Index(fields=['kind', 'db', 'location_id', 'resolved_at'], name='progeo_notifcase_reopen'),
                ],
            },
        ),
        migrations.CreateModel(
            name='NotificationCaseEvent',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('kind', models.CharField(choices=[('opened', 'Erkannt'), ('reopened', 'Wieder geöffnet'), ('devices', 'Geräte geändert'), ('alarms', 'Alarme hinzugekommen'), ('stage', 'Stufe versendet'), ('escalated', 'Eskaliert'), ('unreachable', 'Niemand erreicht'), ('bounce', 'Unzustellbar'), ('acknowledged', 'Kenntnisnahme'), ('unsubscribed', 'Abgemeldet'), ('muted', 'Stumm geschaltet'), ('unmuted', 'Stummschaltung aufgehoben'), ('online_mail', 'Wieder-online-Mail'), ('resolved', 'Erledigt')], max_length=16)),
                ('created', models.DateTimeField(default=django.utils.timezone.now)),
                ('text', models.TextField(blank=True, default='')),
                ('data', models.JSONField(blank=True, default=dict)),
                ('author_id', models.IntegerField(blank=True, null=True)),
                ('case', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='events', to='progeo.notificationcase')),
            ],
            options={
                'ordering': ['created', 'id'],
            },
        ),
        migrations.CreateModel(
            name='NotificationToken',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('token_hash', models.CharField(max_length=64, unique=True)),
                ('user_id', models.IntegerField(blank=True, null=True)),
                ('address', models.CharField(max_length=255)),
                ('created', models.DateTimeField(default=django.utils.timezone.now)),
                ('expires_at', models.DateTimeField()),
                ('acknowledged_at', models.DateTimeField(blank=True, null=True)),
                ('unsubscribed_at', models.DateTimeField(blank=True, null=True)),
                ('case', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='tokens', to='progeo.notificationcase')),
            ],
        ),
        migrations.CreateModel(
            name='NotificationOptOut',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('address', models.CharField(max_length=255)),
                ('location_id', models.IntegerField()),
                ('kind', models.CharField(choices=[('offline', 'Offline'), ('alarm', 'Alarm')], max_length=16)),
                ('user_id', models.IntegerField(blank=True, null=True)),
                ('created', models.DateTimeField(default=django.utils.timezone.now)),
                ('via', models.CharField(blank=True, default='', max_length=16)),
            ],
            options={
                'constraints': [
                    models.UniqueConstraint(fields=('address', 'location_id', 'kind'), name='progeo_notif_optout_unique'),
                ],
            },
        ),
    ]
