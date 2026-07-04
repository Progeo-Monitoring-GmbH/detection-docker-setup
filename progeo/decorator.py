import time
from functools import wraps
from rest_framework import status
from rest_framework.response import Response
from progeo.helper.basics import ilog


def has_test_coverage(wrapped_function):
    def _wrapper(*args, **kwargs):
        result = wrapped_function(*args, **kwargs)
        return result

    return _wrapper


def calc_runtime(func):
    @wraps(func)
    def _wrapper(*args, **kwargs):
        start_time = time.perf_counter()
        result = func(*args, **kwargs)
        end_time = time.perf_counter()
        total_time = end_time - start_time
        ilog(f"{total_time:.4f}s\t\trequest='{func.__name__}{args}' kwargs={kwargs}", tag="[RUNTIME]")
        return result

    return _wrapper


def _extract_request(args):
    if not args:
        return None

    candidate = args[0]
    if hasattr(candidate, "method") and hasattr(candidate, "user"):
        return candidate

    if len(args) > 1:
        candidate = args[1]
        if hasattr(candidate, "method") and hasattr(candidate, "user"):
            return candidate

    return None


def require_module_permissions(*permission_codes):
    def _decorator(wrapped_function):
        @wraps(wrapped_function)
        def _wrapper(*args, **kwargs):
            request = _extract_request(args)
            if request is None:
                raise RuntimeError("require_module_permissions could not resolve request argument")

            user = getattr(request, "user", None)
            if not getattr(user, "is_authenticated", False):
                return Response(
                    {"success": False, "reason": "Authentication required"},
                    status=status.HTTP_401_UNAUTHORIZED,
                )

            if getattr(user, "is_staff", False) or getattr(user, "is_superuser", False):
                return wrapped_function(*args, **kwargs)

            missing_permissions = [
                code for code in permission_codes if not user.has_perm(f"progeo.{code}")
            ]
            if missing_permissions:
                return Response(
                    {
                        "success": False,
                        "reason": "Missing required permissions",
                        "missing_permissions": missing_permissions,
                    },
                    status=status.HTTP_403_FORBIDDEN,
                )

            return wrapped_function(*args, **kwargs)

        _wrapper.required_module_permissions = permission_codes
        return _wrapper

    return _decorator
