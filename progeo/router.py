import os

from django.contrib.auth.models import User
from rest_framework.routers import DynamicRoute, Route, SimpleRouter

from progeo.helper.basics import elog, okaylog, wlog
from progeo.v1.models import Account


class CoreRouter(SimpleRouter):
    """
    A router for read-only APIs, which doesn't use trailing slashes.
    """
    routes = [

        Route(
            url=r'^{prefix}$',
            mapping={'get': 'list'},
            name='{basename}-list',
            detail=False,
            initkwargs={'suffix': 'List'}
        ),

        Route(
            url=r'^{prefix}/create$',
            mapping={'post': 'create'},
            name='{basename}-create',
            detail=True,
            initkwargs={'suffix': 'Create'}
        ),

        Route(
            url=r'^{prefix}/{lookup}$',
            mapping={'get': 'retrieve'},
            name='{basename}-detail',
            detail=True,
            initkwargs={'suffix': 'Detail'}
        ),

        DynamicRoute(
            url=r'^{prefix}/{lookup}/{url_path}$',
            name='{basename}-{url_name}',
            detail=True,
            initkwargs={}
        )
    ]


ACTIVE = False  # or DEBUG


class DjangoRouter:

    @staticmethod
    def _is_default_model(model):
        if model == Account:
            return True

        if model == User:
            return True

        return model._meta.app_label != "progeo"

    @staticmethod
    def _is_default_instance(obj):
        return DjangoRouter._is_default_model(obj.__class__)

    @staticmethod
    def db_for_read(model, **hints):
        if model == Account:
            return "default"

        if model == User:
            return "default"

        if model._meta.app_label != "progeo":
            return "default"

    @staticmethod
    def db_for_write(model, **hints):
        if model == Account:
            return "default"

        if model == User:
            return "default"

        if model._meta.app_label != "progeo" or isinstance(model, Account):
            return "default"

    @staticmethod
    def allow_relation(obj1, obj2, **hints):
        obj1_default = DjangoRouter._is_default_instance(obj1)
        obj2_default = DjangoRouter._is_default_instance(obj2)

        obj1_is_account = isinstance(obj1, Account)
        obj2_is_account = isinstance(obj2, Account)

        if obj1_default and obj2_default:
            okaylog(
                f"DR | allow_relation=yes\t| obj1={obj1._meta.object_name}, obj2={obj2._meta.object_name}, hints={list(hints.keys())}",
                tag="[ROUTER]", active=ACTIVE)
            return True

        if obj1_default != obj2_default:
            if obj1_is_account or obj2_is_account:
                # Account metadata lives on default DB while related progeo models
                # are stored on account-specific DBs. Let AccountRouter decide.
                elog(
                    f"DR | allow_relation=may\t| obj1={obj1._meta.object_name}, obj2={obj2._meta.object_name}, hints={list(hints.keys())}",
                    tag="[ROUTER]", active=ACTIVE)
                return None

            wlog(
                f"DR | allow_relation=no\t| obj1={obj1._meta.object_name}, obj2={obj2._meta.object_name}, hints={list(hints.keys())}",
                tag="[ROUTER]", active=ACTIVE)
            return False

        # Both objects belong to non-default progeo models.
        # Let AccountRouter decide relation handling for account-specific DBs.
        else:
            elog(
                f"DR | allow_relation=may\t| obj1={obj1._meta.object_name}, obj2={obj2._meta.object_name}, hints={list(hints.keys())}",
                tag="[ROUTER]", active=ACTIVE)

        return None

    @staticmethod
    def allow_migrate(db, app_label, model_name=None, **hints):
        if db != "default":
            return None

        if app_label != "progeo":
            okaylog(
                f"DR | allow_migrate=yes\t| db={db}, app_label={app_label},\tmodel_name={model_name}, hints={list(hints.keys())}",
                tag="[ROUTER]", active=ACTIVE)
            return True

        resolved_model_name = model_name
        hinted_model = hints.get("model")
        if not resolved_model_name and hinted_model is not None:
            resolved_model_name = hinted_model._meta.model_name

        # Keep only account metadata on default DB.
        # Support both current and legacy naming.
        allowed_default_progeo_models = {"account", "progeoaccount"}
        allow_default = resolved_model_name in allowed_default_progeo_models

        if allow_default:
            okaylog(
                f"DR | allow_migrate=yes\t| db={db}, app_label={app_label},\tmodel_name={resolved_model_name}, hints={list(hints.keys())}",
                tag="[ROUTER]", active=ACTIVE)
        else:
            wlog(
                f"DR | allow_migrate=no\t| db={db}, app_label={app_label},\tmodel_name={resolved_model_name}, hints={list(hints.keys())}",
                tag="[ROUTER]", active=ACTIVE)

        return allow_default


def check_class_module(model, module):
    return getattr(model, "__module__", "").startswith(module)


class DemoRouter:
    """Rows loaded from the demo database (settings.DEMO_DATABASE) keep their
    related lookups there - location.lageplans, measurement.device,
    location.account, ... AccountRouter would send them to "default", where
    the demo rows don't exist."""

    @staticmethod
    def _route(hints):
        from django.conf import settings

        instance_db = getattr(getattr(hints.get("instance"), "_state", None), "db", None)
        demo_db = getattr(settings, "DEMO_DATABASE", None)
        return instance_db if demo_db and instance_db == demo_db else None

    def db_for_read(self, model, **hints):
        return self._route(hints)

    def db_for_write(self, model, **hints):
        return self._route(hints)


class ProjectRouter:
    """Routes the per-project models (helper/project_dbs.py: project_models)
    to the project database of the current `use_project_db(...)` block, or
    to the database an instance was loaded from. Inactive (returns None,
    i.e. AccountRouter decides) while PROJECT_DB_SPLIT is off.

    Explicit `.using(db)` calls bypass routers - those call sites have to
    pick the project database themselves (project_db_for)."""

    def _route(self, model, hints):
        from progeo.helper.project_dbs import (
            current_project_db,
            is_project_alias,
            is_project_model,
            split_enabled,
            strict_enabled,
        )

        if not split_enabled() or not is_project_model(model):
            return None

        alias = current_project_db()
        if alias:
            return alias

        instance = hints.get("instance")
        instance_db = getattr(getattr(instance, "_state", None), "db", None)
        if is_project_alias(instance_db):
            return instance_db

        if strict_enabled():
            raise RuntimeError(
                f"{model.__name__} query without project database - wrap it in use_project_db(...) "
                "or pass .using(project_db_for(...))"
            )
        if model not in self._warned:
            self._warned.add(model)
            wlog(f"{model.__name__} query without project database, using default", tag="[ROUTER]")
        return None

    _warned = set()

    def db_for_read(self, model, **hints):
        return self._route(model, hints)

    def db_for_write(self, model, **hints):
        return self._route(model, hints)


class AccountRouter:
    def db_for_read(self, model, **hints):
        return "default"

    def db_for_write(self, model, **hints):
        if os.getenv("TESTS_ACTIVE"):
            return "unit_tests"
        return "default"

    def allow_relation(self, obj1, obj2, **hints):
        return True

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        return True
