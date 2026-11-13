# The order of a location's Lageplans (ProgeoLageplan.position / ORDER), set in
# the Lageplan wizard. 0 everywhere keeps the previous order (active first,
# newest first) until a location's plans are reordered.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0053_remote_firmware_update'),
    ]

    operations = [
        migrations.AddField(
            model_name='progeolageplan',
            name='position',
            field=models.PositiveIntegerField(
                db_default=0, default=0, help_text="Order among the location's lageplans"
            ),
        ),
    ]
