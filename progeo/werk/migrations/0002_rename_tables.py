"""The moved tables get the Werk app's names (werk_factorysensor, ...) - a
rename in place, the rows stay. Their content types (admin history,
permissions) follow from progeo to werk. Only in "default": the router skips
the Werk app's migrations everywhere else (progeo/router.py)."""

from django.db import migrations

# progeo model name -> werk model name
MOVED = {
    "progeofactorysensor": "factorysensor",
    "progeositemeasurement": "sitemeasurement",
    "progeowerkuser": "werkuser",
    "progeoproductionsheet": "productionsheet",
    "progeoproductionentry": "productionentry",
    "progeoproductionprogress": "productionprogress",
    "progeoroll": "roll",
    "progeorollphoto": "rollphoto",
}


def move_content_types(apps, schema_editor):
    ContentType = apps.get_model("contenttypes", "ContentType")
    Permission = apps.get_model("auth", "Permission")
    db = schema_editor.connection.alias
    for old, new in MOVED.items():
        if ContentType.objects.using(db).filter(app_label="werk", model=new).exists():
            continue
        content_type = ContentType.objects.using(db).filter(app_label="progeo", model=old).first()
        if content_type is None:
            continue
        content_type.app_label, content_type.model = "werk", new
        content_type.save(using=db, update_fields=["app_label", "model"])
        for permission in Permission.objects.using(db).filter(content_type=content_type):
            action, _, _model = permission.codename.partition("_")
            permission.codename = f"{action}_{new}"
            permission.save(using=db, update_fields=["codename"])


def move_content_types_back(apps, schema_editor):
    ContentType = apps.get_model("contenttypes", "ContentType")
    Permission = apps.get_model("auth", "Permission")
    db = schema_editor.connection.alias
    for old, new in MOVED.items():
        content_type = ContentType.objects.using(db).filter(app_label="werk", model=new).first()
        if content_type is None or ContentType.objects.using(db).filter(app_label="progeo", model=old).exists():
            continue
        content_type.app_label, content_type.model = "progeo", old
        content_type.save(using=db, update_fields=["app_label", "model"])
        for permission in Permission.objects.using(db).filter(content_type=content_type):
            action, _, _model = permission.codename.partition("_")
            permission.codename = f"{action}_{old}"
            permission.save(using=db, update_fields=["codename"])


class Migration(migrations.Migration):

    dependencies = [
        ('werk', '0001_initial'),
        ('progeo', '0084_move_to_werk'),
        ('contenttypes', '0002_remove_content_type_name'),
        ('auth', '0012_alter_user_first_name_max_length'),
    ]

    operations = [
        migrations.AlterModelTable(name='factorysensor', table=None),
        migrations.AlterModelTable(name='sitemeasurement', table=None),
        migrations.AlterModelTable(name='werkuser', table=None),
        migrations.AlterModelTable(name='productionsheet', table=None),
        migrations.AlterModelTable(name='productionentry', table=None),
        migrations.AlterModelTable(name='productionprogress', table=None),
        migrations.AlterModelTable(name='roll', table=None),
        migrations.AlterModelTable(name='rollphoto', table=None),
        migrations.RunPython(move_content_types, move_content_types_back),
    ]
