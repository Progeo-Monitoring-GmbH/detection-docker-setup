# Hand-written (Mein Konto confirms the connection to the ProGeo chat)

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0046_messenger_notifications'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='matrix_connected_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
