# AccessRequest.language: the language the access request form was filled in.
# It preselects the language staff choose when approving / rejecting, and that
# choice becomes the user's mail language (UserProfile.language).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0058_userprofile_language_loginlink_matrix'),
    ]

    operations = [
        migrations.AddField(
            model_name='accessrequest',
            name='language',
            field=models.CharField(blank=True, default='', max_length=8),
        ),
    ]
