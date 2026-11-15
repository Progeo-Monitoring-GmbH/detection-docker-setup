# One-time migration campaign (helper/migration_invites.py): MigrationInvite
# per invited user of the old platform, and the LoginLink purpose "migration"
# (the set-password link of the info mail).

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('progeo', '0059_accessrequest_language'),
    ]

    operations = [
        migrations.AlterField(
            model_name='loginlink',
            name='purpose',
            field=models.CharField(choices=[('login', 'Anmeldelink'), ('invite', 'Einladung'), ('reset', 'Passwort zurücksetzen'), ('matrix', 'Chat-Anmeldung (QR-Code)'), ('migration', 'Umzug: Passwort festlegen')], max_length=16),
        ),
        migrations.CreateModel(
            name='MigrationInvite',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('status', models.CharField(choices=[('queued', 'Wartet auf Versand'), ('sent', 'Versendet'), ('failed', 'Nicht versendet'), ('completed', 'Passwort festgelegt'), ('skipped', 'Übersprungen')], db_index=True, default='queued', max_length=16)),
                ('queued_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('sent_at', models.DateTimeField(blank=True, null=True)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('attempts', models.IntegerField(default=0)),
                ('error', models.TextField(blank=True, default='')),
                ('user', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='migration_invite', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['queued_at', 'id'],
            },
        ),
    ]
