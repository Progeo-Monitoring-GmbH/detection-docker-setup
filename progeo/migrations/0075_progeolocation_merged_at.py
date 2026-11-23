# Written by hand: merged projects move their devices (helper/location_merge.py).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0074_alter_progeoactivity_kind'),
    ]

    operations = [
        migrations.AddField(
            model_name='progeolocation',
            name='merged_at',
            field=models.DateTimeField(blank=True, null=True, help_text='Merged into its parent_location (devices moved there) - hidden from customers'),
        ),
        migrations.AddField(
            model_name='progeolocation',
            name='merge_shift',
            field=models.IntegerField(blank=True, null=True, help_text='Sensor numbers in the main project = own + merge_shift'),
        ),
    ]
