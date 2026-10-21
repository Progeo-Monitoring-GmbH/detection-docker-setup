"""Baseline rows the test suite relies on, so a freshly created unit_tests
database works without restoring a dump (`manage.py recreate_test_db`):

- Account pk=1 (db_name "default"): AccountMiddleware binds every request to it.
- A superuser as the first user, and the "unit_tests" account/user
  (api_client_with_credentials in conftest.py).
- The controller account named by CONTROLLER_DEFAULT_ACCOUNT, which legacy
  ingestion files new devices under.
- The progeo content types (see seed_content_types).

Idempotent - existing rows are left alone.
"""
import os

from django.apps import apps
from django.contrib.auth.models import User
from django.contrib.contenttypes.models import ContentType
from django.core.management.color import no_style
from django.db import connections

from progeo.v1.models import Account

UNIT_TESTS = "unit_tests"


def seed_content_types(db_alias="default"):
    """The progeo content types. migrate never creates them: the app has no
    models.py, so Django sends it no post_migrate (production gets them from
    fix_contenttypes). Without them the first LimitedToken creates its
    polymorphic content type inside a rolled-back test transaction, and the
    ContentType cache then hands the vanished id to every later test."""
    for model in apps.get_app_config("progeo").get_models():
        ContentType.objects.using(db_alias).get_or_create(
            app_label=model._meta.app_label, model=model._meta.model_name
        )
    ContentType.objects.clear_cache()


def seed_baseline(db_alias="default"):
    seed_content_types(db_alias)
    accounts = Account.objects.using(db_alias)

    # The request account (AccountMiddleware), bound to the default database
    # like in production - e.g. backup download tokens carry "default:<pk>".
    if not accounts.filter(pk=1).exists():
        accounts.create(pk=1, name="default", raw_hash="default-account", db_name="default")
        # An explicit pk doesn't advance the sequence - the next create would get 1 too.
        connection = connections[db_alias]
        with connection.cursor() as cursor:
            for statement in connection.ops.sequence_reset_sql(no_style(), [Account]):
                cursor.execute(statement)

    # Created first, so on a fresh database it is the lowest id:
    # test_device_legacy_query authenticates as User...order_by("id").first().
    User.objects.db_manager(db_alias).get_or_create(
        username=f"{UNIT_TESTS}_admin", defaults={"is_staff": True, "is_superuser": True}
    )
    user, _ = User.objects.db_manager(db_alias).get_or_create(username=UNIT_TESTS)
    account, _ = accounts.get_or_create(raw_hash=UNIT_TESTS, defaults={"name": UNIT_TESTS, "db_name": UNIT_TESTS})
    account.users.add(user)

    controller_name = (os.getenv("CONTROLLER_DEFAULT_ACCOUNT") or "").strip()
    if controller_name and not accounts.filter(name=controller_name).exists():
        accounts.create(name=controller_name, raw_hash=f"controller-{controller_name}", db_name="default")
