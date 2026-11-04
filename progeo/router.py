import os

from rest_framework.routers import DynamicRoute, Route, SimpleRouter

from progeo.helper.basics import wlog
from progeo.settings import DEBUG


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


ACTIVE = DEBUG


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
    to the database an instance was loaded from. While PROJECT_DB_SPLIT is
    off it only does the latter (a row read from a project database, e.g.
    in the admin); everything else returns None, i.e. AccountRouter decides.

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

        if not is_project_model(model):
            return None

        split = split_enabled()
        alias = current_project_db() if split else None
        if alias:
            return alias

        # A row loaded from a project database finds its relations there even
        # with the split off (e.g. a wrong PROJECT_DB_SPLIT): "default" doesn't
        # hold them - the admin's ?db=<project> pages crashed with DoesNotExist.
        instance = hints.get("instance")
        instance_db = getattr(getattr(instance, "_state", None), "db", None)
        if is_project_alias(instance_db):
            return instance_db

        if not split:
            return None

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

    # Apps only "default" uses: the portal's OpenID Connect provider (chat
    # login, progeo/oidc.py). Their migrations in every project database (and
    # the template they are cloned from, and the demo) made adv_migrate crawl
    # - there they are recorded without running.
    DEFAULT_ONLY_APPS = {"oauth2_provider"}

    def db_for_read(self, model, **hints):
        return self._route(model, hints)

    def db_for_write(self, model, **hints):
        return self._route(model, hints)

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if app_label not in self.DEFAULT_ONLY_APPS:
            return None
        from django.conf import settings

        from progeo.helper.project_dbs import is_project_alias, template_alias

        # Not db == "default": the tests migrate their database as "unit_tests".
        if is_project_alias(db) or db in (template_alias(), getattr(settings, "DEMO_DATABASE", None)):
            return False
        return None


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
