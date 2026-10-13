"""SessionAuthentication must come after the header-based authenticators.

The frontend is served from the same origin as the API, so the browser sends
the sessionid cookie (set by the token login) along with the JWT. If
SessionAuthentication matched first, DRF would enforce CSRF and reject every
POST/PATCH ("CSRF Failed: CSRF token missing.") - which logs the user out.
"""
import importlib
import inspect
import pkgutil

from django.conf import settings
from rest_framework.authentication import SessionAuthentication

import progeo.v1.viewsets as viewsets_package


def _auth_class_lists():
    for module_info in pkgutil.iter_modules(viewsets_package.__path__):
        module = importlib.import_module(f"{viewsets_package.__name__}.{module_info.name}")
        for name, cls in inspect.getmembers(module, inspect.isclass):
            if cls.__module__ != module.__name__:
                continue
            if "authentication_classes" in vars(cls):
                yield f"{module.__name__}.{name}", list(cls.authentication_classes)
            for attr_name, attr in vars(cls).items():
                kwargs = getattr(attr, "kwargs", None)
                if isinstance(kwargs, dict) and "authentication_classes" in kwargs:
                    yield f"{module.__name__}.{name}.{attr_name}", list(kwargs["authentication_classes"])


def test_session_authentication_is_last_on_viewsets():
    offenders = [
        where for where, classes in _auth_class_lists()
        if SessionAuthentication in classes and classes[-1] is not SessionAuthentication
    ]
    assert not offenders, f"SessionAuthentication must be last: {offenders}"


def test_session_authentication_is_last_by_default():
    classes = settings.REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"]
    assert classes[-1] == "rest_framework.authentication.SessionAuthentication"
