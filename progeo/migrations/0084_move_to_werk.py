"""The factory models move to the Werk app (progeo/werk): out of progeo's
state - werk/migrations/0001_initial.py takes them over with their tables.

In "default" (and the tests' "unit_tests") the tables stay with their data;
werk 0002 renames them. Everywhere else - the project databases, their
template and the demo - they were only empty copies (every migration ran in
every database, the rows were always written to "default"): dropped here when
empty, and the Werk app's migrations no longer run there (progeo/router.py
ProjectRouter.DEFAULT_ONLY_APPS)."""

from django.db import migrations

# Children first (the foreign keys point at the later ones).
TABLES = [
    "progeo_progeorollphoto",
    "progeo_progeoroll",
    "progeo_progeoproductionentry",
    "progeo_progeoproductionsheet",
    "progeo_progeoproductionprogress",
    "progeo_progeowerkuser",
    "progeo_progeositemeasurement",
    "progeo_progeofactorysensor",
]


def drop_outside_default(apps, schema_editor):
    from progeo.router import ProjectRouter

    connection = schema_editor.connection
    if ProjectRouter.default_only_db(connection.alias):
        return
    existing = set(connection.introspection.table_names())
    for table in TABLES:
        if table not in existing:
            continue
        name = schema_editor.quote_name(table)
        with connection.cursor() as cursor:
            cursor.execute(f"SELECT EXISTS (SELECT 1 FROM {name})")
            has_rows = cursor.fetchone()[0]
        if has_rows:
            # Never expected (the rows live in "default") - kept, not lost.
            print(f"\n  {connection.alias}: {table} has rows - kept, drop it by hand once checked")
            continue
        schema_editor.execute(f"DROP TABLE {name} CASCADE")


class Migration(migrations.Migration):

    dependencies = [
        ('progeo', '0083_production_entry_qs'),
        ('werk', '0001_initial'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.DeleteModel(name='ProgeoRollPhoto'),
                migrations.DeleteModel(name='ProgeoRoll'),
                migrations.DeleteModel(name='ProgeoProductionEntry'),
                migrations.DeleteModel(name='ProgeoProductionSheet'),
                migrations.DeleteModel(name='ProgeoProductionProgress'),
                migrations.DeleteModel(name='ProgeoWerkUser'),
                migrations.DeleteModel(name='ProgeoSiteMeasurement'),
                migrations.DeleteModel(name='ProgeoFactorySensor'),
            ],
            database_operations=[
                # Not undone outside "default": the dropped copies were empty.
                migrations.RunPython(drop_outside_default, migrations.RunPython.noop),
            ],
        ),
    ]
