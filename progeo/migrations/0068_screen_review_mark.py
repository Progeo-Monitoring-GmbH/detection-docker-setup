# Hand-written: screenshots marked as reviewed (ScreenReviewMark,
# helper/screen_review.py).
import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('progeo', '0067_progeoreadinesssnapshot_progeoescalation_view_state_and_more'),
    ]

    operations = [
        migrations.CreateModel(
            name='ScreenReviewMark',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('run', models.CharField(db_index=True, max_length=32)),
                ('image', models.CharField(max_length=200)),
                ('created', models.DateTimeField(default=django.utils.timezone.now)),
                ('reviewed_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                                                  related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('run', 'image'),
                                                        name='progeo_screen_review_mark_once')],
            },
        ),
    ]
