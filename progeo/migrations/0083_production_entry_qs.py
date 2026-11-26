import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0082_production_record_dm'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name='progeoproductionentry',
            name='laenge_m',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=8, null=True),
        ),
        migrations.AddField(
            model_name='progeoproductionentry',
            name='vorlauf_m',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=8, null=True),
        ),
        migrations.AddField(
            model_name='progeoproductionentry',
            name='qs_status',
            field=models.CharField(blank=True, max_length=12, null=True),
        ),
        migrations.AddField(
            model_name='progeoproductionentry',
            name='qs_manuell',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='progeoproductionentry',
            name='qs_von',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                                    related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(
            model_name='progeoproductionentry',
            name='qs_am',
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
