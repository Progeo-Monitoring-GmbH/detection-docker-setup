# UserProfile.language: the language of a user's mails and messenger messages
# (emails/<language>/ templates). LoginLink purpose "matrix": the chat login by
# QR code (helper/matrix_accounts.create_qr_login).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0057_notification_cases'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='language',
            field=models.CharField(blank=True, max_length=8, null=True),
        ),
        migrations.AlterField(
            model_name='loginlink',
            name='purpose',
            field=models.CharField(choices=[('login', 'Anmeldelink'), ('invite', 'Einladung'), ('reset', 'Passwort zurücksetzen'), ('matrix', 'Chat-Anmeldung (QR-Code)')], max_length=16),
        ),
    ]
