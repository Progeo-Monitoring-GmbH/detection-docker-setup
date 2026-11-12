# Remote firmware updates (helper/firmware_update.py): the flash bundle a
# controller reports it runs, the "upgrade" command, and the files the server
# made for an upgrade (the migrated device_config.lua, encrypted), kept until
# the controller downloaded them.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0052_progeomeasurement_archived'),
    ]

    operations = [
        migrations.AddField(
            model_name='progeodevice',
            name='firmware_bundle',
            field=models.CharField(blank=True, max_length=100, null=True),
        ),
        migrations.AddField(
            model_name='progeodevicecommand',
            name='files_encrypted',
            field=models.TextField(blank=True, default=''),
        ),
        migrations.AlterField(
            model_name='progeodevicecommand',
            name='command',
            field=models.CharField(choices=[('measure', 'measure'), ('identify', 'identify'), ('restart', 'restart'), ('update', 'update'), ('get_config', 'get_config'), ('set_params', 'set_params'), ('maintenance', 'maintenance'), ('normal', 'normal'), ('logs', 'logs'), ('upgrade', 'upgrade')], max_length=20),
        ),
    ]
