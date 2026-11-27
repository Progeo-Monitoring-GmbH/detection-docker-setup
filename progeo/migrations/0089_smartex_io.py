from django.db import migrations, models

# Project type 6 "LoRaWan" and device type "lorawan" are smartex io now: the
# LoRaWAN radio sensors and the RS485 sensors of an M5 (both reporting to
# /v1/device/lorawan/<project_id>/) are one product.
LORAWAN_PROJECT = 6
SMARTEX_IO_PROJECT = 10
LORAWAN_DEVICE = "lorawan"
SMARTEX_IO_DEVICE = "smartex io"


def lorawan_to_smartex_io(apps, schema_editor):
    """Every database (default, project databases, template, demo) holds its
    own copy of the locations and devices - each is converted where it runs."""
    db = schema_editor.connection.alias
    ProgeoLocation = apps.get_model("progeo", "ProgeoLocation")
    ProgeoDevice = apps.get_model("progeo", "ProgeoDevice")
    ProgeoLocation.objects.using(db).filter(project_type=LORAWAN_PROJECT).update(project_type=SMARTEX_IO_PROJECT)
    ProgeoDevice.objects.using(db).filter(type=LORAWAN_DEVICE).update(type=SMARTEX_IO_DEVICE)


def smartex_io_to_lorawan(apps, schema_editor):
    """Back: only the devices - which smartex io projects were LoRaWan before is not known."""
    db = schema_editor.connection.alias
    ProgeoDevice = apps.get_model("progeo", "ProgeoDevice")
    ProgeoDevice.objects.using(db).filter(type=SMARTEX_IO_DEVICE).update(type=LORAWAN_DEVICE)


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0077_delete_sms'),
    ]

    operations = [
        migrations.AlterField(
            model_name='progeodevice',
            name='type',
            field=models.CharField(blank=True, choices=[('imei', 'imei'), ('smartbox', 'smartbox'), ('node', 'node'), ('relay', 'relay'), ('root', 'root'), ('legacy', 'legacy'), ('smartex io', 'smartex io')], max_length=20, null=True),
        ),
        migrations.AlterField(
            model_name='progeolocation',
            name='project_type',
            field=models.IntegerField(blank=True, choices=[(0, 'Unknown'), (1, 'smartex® dm'), (2, 'geologger'), (3, 'smartex® is'), (4, 'Development'), (5, 'Versuchsprojekte'), (7, 'smartex® mx-PEEL'), (8, 'smartex® mx-va'), (9, 'smartex® mx-al'), (10, 'smartex® io'), (11, 'smartex® vt'), (99, 'Sonstige')], default=0, null=True),
        ),
        migrations.RunPython(lorawan_to_smartex_io, smartex_io_to_lorawan),
    ]
