# Hand-written: the location's language (mails to invited users).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0064_progeolocation_readiness_at_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='progeolocation',
            name='language',
            field=models.CharField(blank=True, choices=[('de', 'Deutsch'), ('en', 'English')], default='', max_length=8),
        ),
    ]
