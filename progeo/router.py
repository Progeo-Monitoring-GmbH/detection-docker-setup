import os

from django.contrib.auth.models import User
from rest_framework.routers import Route, DynamicRoute, SimpleRouter

from progeo.v1.models import Account
from progeo.helper.basics import wlog, okaylog, elog


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
