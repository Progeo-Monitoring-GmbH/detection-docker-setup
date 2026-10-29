import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0040_progeoaccessindex'),
    ]

    operations = [
        migrations.AddField(
            model_name='progeomeasurepoint',
            name='device',
            field=models.ForeignKey(blank=True, db_constraint=False, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='measure_points', to='progeo.progeodevice'),
        ),
    ]
