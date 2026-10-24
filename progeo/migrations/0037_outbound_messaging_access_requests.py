# Hand-written (outbound mail/SMS log, bounce suppression, login links, access requests)

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0036_rename_resistance_vdc_progeomeasurement_battery_v_and_more'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='OutboundMessage',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('channel', models.CharField(choices=[('mail', 'E-Mail'), ('sms', 'SMS')], max_length=8)),
                ('status', models.CharField(choices=[('sent', 'Versendet'), ('redirected', 'Umgeleitet (Testmodus)'), ('dry_run', 'Nicht versendet (Testmodus)'), ('rate_limited', 'Limit erreicht'), ('suppressed', 'Adresse gesperrt (Bounce)'), ('blocked', 'Blockiert'), ('failed', 'Fehlgeschlagen'), ('bounced', 'Unzustellbar')], max_length=16)),
                ('created', models.DateTimeField(default=django.utils.timezone.now)),
                ('recipient', models.CharField(max_length=255)),
                ('actual_recipient', models.CharField(blank=True, default='', max_length=255)),
                ('category', models.CharField(blank=True, default='system', max_length=32)),
                ('subject', models.CharField(blank=True, default='', max_length=255)),
                ('message_id', models.CharField(blank=True, db_index=True, default='', max_length=255)),
                ('location_id', models.IntegerField(blank=True, null=True)),
                ('error', models.TextField(blank=True, null=True)),
                ('bounced_at', models.DateTimeField(blank=True, null=True)),
                ('bounce_reason', models.TextField(blank=True, null=True)),
            ],
            options={
                'ordering': ['-created'],
                'indexes': [
                    models.Index(fields=['channel', 'recipient', 'created'], name='progeo_outb_channel_1f0c4e_idx'),
                    models.Index(fields=['channel', 'created'], name='progeo_outb_channel_8a2d17_idx'),
                    models.Index(fields=['category', 'location_id', 'created'], name='progeo_outb_categor_5b9e30_idx'),
                ],
            },
        ),
        migrations.CreateModel(
            name='EmailSuppression',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('address', models.CharField(max_length=255, unique=True)),
                ('reason', models.TextField(blank=True, default='')),
                ('soft_bounces', models.IntegerField(default=0)),
                ('hard', models.BooleanField(default=False)),
                ('active', models.BooleanField(default=False)),
                ('created', models.DateTimeField(default=django.utils.timezone.now)),
                ('last_bounce_at', models.DateTimeField(blank=True, null=True)),
            ],
        ),
        migrations.CreateModel(
            name='LoginLink',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('purpose', models.CharField(choices=[('login', 'Anmeldelink'), ('invite', 'Einladung')], max_length=16)),
                ('token_hash', models.CharField(max_length=64, unique=True)),
                ('created', models.DateTimeField(default=django.utils.timezone.now)),
                ('expires_at', models.DateTimeField()),
                ('used_at', models.DateTimeField(blank=True, null=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='login_links', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name='AccessRequest',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('status', models.CharField(choices=[('unverified', 'E-Mail nicht bestätigt'), ('pending', 'In Prüfung'), ('approved', 'Freigegeben'), ('rejected', 'Abgelehnt')], db_index=True, default='unverified', max_length=16)),
                ('first_name', models.CharField(max_length=100)),
                ('last_name', models.CharField(max_length=100)),
                ('company', models.CharField(blank=True, default='', max_length=200)),
                ('email', models.CharField(db_index=True, max_length=255)),
                ('phone', models.CharField(blank=True, default='', max_length=50)),
                ('project', models.CharField(blank=True, default='', max_length=200)),
                ('message', models.TextField(blank=True, default='')),
                ('privacy_accepted_at', models.DateTimeField()),
                ('created', models.DateTimeField(default=django.utils.timezone.now)),
                ('verify_token_hash', models.CharField(blank=True, db_index=True, default='', max_length=64)),
                ('verify_expires_at', models.DateTimeField(blank=True, null=True)),
                ('verified_at', models.DateTimeField(blank=True, null=True)),
                ('reviewed_at', models.DateTimeField(blank=True, null=True)),
                ('review_note', models.TextField(blank=True, default='')),
                ('reviewed_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('user', models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='access_request', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created'],
            },
        ),
    ]
