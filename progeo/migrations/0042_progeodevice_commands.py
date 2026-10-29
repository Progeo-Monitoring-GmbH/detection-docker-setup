from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0041_progeomeasurepoint_device'),
    ]

    operations = [
        migrations.AddField(
            model_name='progeodevice',
            name='pending_commands',
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name='progeodevice',
            name='last_command_poll',
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
