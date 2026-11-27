"""The login QR code's DRF token stays valid until revoked:
UserProfile.qr_token_created marks it (helper/tokens.mark_qr_token)."""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0084_move_to_werk'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='qr_token_created',
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
