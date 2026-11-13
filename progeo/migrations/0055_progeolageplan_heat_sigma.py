# The heatmap's kernel width (σ) per Lageplan (ProgeoLageplan.heat_sigma),
# set by staff on the heatmap. Empty: "Auto σ" - every plan starts with it.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0054_progeolageplan_position'),
    ]

    operations = [
        migrations.AddField(
            model_name='progeolageplan',
            name='heat_sigma',
            field=models.FloatField(blank=True, help_text='Heatmap kernel width; empty: automatic', null=True),
        ),
    ]
