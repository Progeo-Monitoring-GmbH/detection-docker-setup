# Generated manually: creates the auth.Permission rows behind the module
# permission codes of the UserModulePermissions proxy model. AlterModelOptions
# migrations never create those rows automatically; the staff admin / API
# grant paths need them to exist.

from django.db import migrations

# Must mirror MODULE_PERMISSION_DEFINITIONS in progeo/v1/models.py.
MODULE_PERMISSIONS = (
    ('module_navbar_enabled', 'Can access navbar module'),
    ('module_locations_enabled', 'Can access locations module'),
    ('module_locations_edit', 'Can edit locations module'),
    ('module_locations_delete', 'Can delete locations module'),
    ('module_devices_enabled', 'Can access devices module'),
    ('module_devices_edit', 'Can edit devices module'),
    ('module_devices_delete', 'Can delete devices module'),
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
)


def create_module_permission_rows(apps, schema_editor):
    Permission = apps.get_model("auth", "Permission")
    ContentType = apps.get_model("contenttypes", "ContentType")

    content_type, _ = ContentType.objects.get_or_create(
        app_label="progeo",
        model="usermodulepermissions",
        defaults={"name": "user module permissions"},
    )

    existing = set(
        Permission.objects.filter(content_type=content_type)
        .values_list("codename", flat=True)
    )
    new_rows = [
        Permission(content_type=content_type, codename=code, name=label)
        for code, label in MODULE_PERMISSIONS
        if code not in existing
    ]
    Permission.objects.bulk_create(new_rows)


def remove_module_permission_rows(apps, schema_editor):
    # Reverse is intentionally a no-op: removing permissions could break
    # grants made while this migration was applied.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('auth', '0012_alter_user_first_name_max_length'),
        ('contenttypes', '0002_remove_content_type_name'),
        ('progeo', '0024_alter_usermodulepermissions_options'),
    ]

    operations = [
        migrations.RunPython(
            create_module_permission_rows,
            remove_module_permission_rows,
        ),
    ]
