# Hand-written (messenger notifications: Signal / WhatsApp / Matrix)

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0045_progeodevice_first_sensor_order'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='messenger',
            field=models.CharField(blank=True, choices=[('signal', 'Signal'), ('whatsapp', 'WhatsApp'), ('matrix', 'Matrix')], max_length=16, null=True),
        ),
        migrations.AddField(
            model_name='userprofile',
            name='messenger_id',
            field=models.CharField(blank=True, max_length=255, null=True),
        ),
        migrations.AlterField(
            model_name='progeoaccess',
            name='transport',
            field=models.IntegerField(blank=True, choices=[(0, 'Silent'), (1, 'Email'), (2, 'Sms'), (4, 'Email And Sms'), (8, 'Messenger')], null=True),
        ),
        migrations.AddField(
            model_name='sms',
            name='channel',
            field=models.CharField(choices=[('sms', 'SMS'), ('signal', 'Signal'), ('whatsapp', 'WhatsApp'), ('matrix', 'Matrix')], default='sms', max_length=16),
        ),
        migrations.AlterField(
            model_name='outboundmessage',
            name='channel',
            field=models.CharField(choices=[('mail', 'E-Mail'), ('sms', 'SMS'), ('messenger', 'Messenger')], max_length=16),
        ),
    ]
