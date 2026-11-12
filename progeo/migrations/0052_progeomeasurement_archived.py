# Archived measurements (ProgeoMeasurement.archived) are only shown to staff,
# who can hide them as well (UserProfile.hide_archived_measurements) - see
# ProgeoMeasurement.shows_archived.
#
# The column has a database default (db_default): adding it to the
# partitioned measurement table of a project database reaches every yearly
# partition, needs no rewrite of the rows (a constant default), and partitions
# created later (CREATE TABLE ... LIKE ... INCLUDING DEFAULTS) get it as well.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0051_progeorainevent'),
    ]

    operations = [
        migrations.AddField(
            model_name='progeomeasurement',
            name='archived',
            field=models.BooleanField(db_default=False, default=False),
        ),
        migrations.AddField(
            model_name='userprofile',
            name='hide_archived_measurements',
            field=models.BooleanField(default=False),
        ),
    ]
