# Hand-written: the mini admin permission (module_mini_admin_enabled).
from django.db import migrations

PERMISSIONS = (
    ('module_navbar_enabled', 'Can access navbar module'),
    ('module_locations_enabled', 'Can access locations module'),
    ('module_locations_edit', 'Can edit locations module'),
    ('module_locations_delete', 'Can delete locations module'),
    ('module_devices_enabled', 'Can access devices module'),
    ('module_devices_edit', 'Can edit devices module'),
    ('module_devices_delete', 'Can delete devices module'),
    ('module_devices_provision', 'Can provision new devices'),
    ('module_devices_commands', 'Can send device commands and read device configs'),
    ('module_measurements_enabled', 'Can access measurements module'),
    ('module_imei_enabled', 'Can access IMEI module'),
    ('module_backup_enabled', 'Can access backup module'),
    ('module_backup_delete', 'Can delete backup module'),
    ('module_docker_enabled', 'Can access Docker module'),
    ('module_admin_enabled', 'Can access admin module'),
    ('module_testsuite_enabled', 'Can access testsuite module'),
    ('module_profile_mail_edit', 'Can edit profile mail module'),
    ('module_notifications_enabled', 'Can access notifications module'),
    ('module_notifications_edit', 'Can edit notifications module'),
    ('module_notifications_add', 'Can add notifications module'),
    ('module_interface_enabled', 'Can access interface module'),
    ('module_interface_smtp_enabled', 'Can access SMTP interface module'),
    ('module_interface_modbus_enabled', 'Can access Modbus interface module'),
    ('module_interface_sms_enabled', 'Can access SMS interface module'),
    ('module_interface_smtp_edit', 'Can edit smtp interface module'),
    ('module_interface_modbus_edit', 'Can edit modbus interface module'),
    ('module_interface_sms_edit', 'Can edit sms interface module'),
    ('module_demo_enabled', 'Can access demo view'),
    ('module_mini_admin_enabled', 'Can manage the users of their own account (mini admin)'),
)


def create_mini_admin_permission_row(apps, schema_editor):
    Permission = apps.get_model("auth", "Permission")
    ContentType = apps.get_model("contenttypes", "ContentType")
    content_type, _ = ContentType.objects.get_or_create(app_label="progeo", model="usermodulepermissions")
    Permission.objects.get_or_create(
        content_type=content_type,
        codename="module_mini_admin_enabled",
        defaults={"name": "Can manage the users of their own account (mini admin)"},
    )


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0065_progeolocation_language'),
    ]

    operations = [
        migrations.AlterModelOptions(
            name='usermodulepermissions',
            options={'permissions': PERMISSIONS},
        ),
        migrations.RunPython(create_mini_admin_permission_row, migrations.RunPython.noop, elidable=True),
    ]
