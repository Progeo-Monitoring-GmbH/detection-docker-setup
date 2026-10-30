from django.db import DEFAULT_DB_ALIAS, connections
from django.utils.functional import SimpleLazyObject

from progeo.decorator import calc_runtime
from progeo.helper.basics import dlog
from progeo.settings import DEBUG
from progeo.v1.models import Account

ADMIN_DB_SESSION_KEY = "admin_db"
# Query parameters that pick the admin's database: ?db=<alias> (the header
# dropdown, progeo/templates/admin/base_site.html); using_db / using_account
# are the older names.
ADMIN_DB_PARAMS = ("db", "using_db", "using_account")


def admin_databases():
    """Databases the admin can switch to: "default", the configured ones and
    every existing project database - not the project template (CREATE
    DATABASE ... TEMPLATE refuses while anyone is connected to it)."""
    from progeo.helper.project_dbs import (
        existing_project_aliases,
        is_project_alias,
        template_alias,
    )

    configured = [alias for alias in connections.settings if alias != template_alias() and not is_project_alias(alias)]
    return [DEFAULT_DB_ALIAS, *(alias for alias in configured if alias != DEFAULT_DB_ALIAS), *existing_project_aliases()]


class AdminGetParamMiddleware:
    """The database the Django admin works on, per request (request.using_db):
    chosen with ?db=<alias>, remembered in the session so it survives the
    admin's own links, "default" otherwise. Nothing is kept on the
    middleware or the ModelAdmins - they are shared by every request."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith("/aadmin/"):
            request.using_db = self._admin_db(request)
            dlog(f"AdminGetParamMiddleware using_db={request.using_db}", tag="[MIDDLE]", active=DEBUG)
        return self.get_response(request)

    @staticmethod
    def _admin_db(request):
        from progeo.helper.project_dbs import is_project_alias, register_project_db

        user = getattr(request, "user", None)
        if not (user and user.is_authenticated and (user.is_staff or user.is_superuser)):
            return DEFAULT_DB_ALIAS

        chosen = None
        if any(param in request.GET for param in ADMIN_DB_PARAMS):
            chosen = request.GET.get("db") or request.GET.get("using_db")
            if not chosen and request.GET.get("using_account"):
                account = Account.objects.using(DEFAULT_DB_ALIAS).filter(pk=request.GET.get("using_account")).first()
                chosen = account.db_name if account else None
            # The admin's change lists treat unknown parameters as filters (and refuse them).
            cleaned = request.GET.copy()
            for param in ADMIN_DB_PARAMS:
                cleaned.pop(param, None)
            request.GET = cleaned
            request.META["QUERY_STRING"] = cleaned.urlencode()

        allowed = admin_databases()
        if chosen is not None:
            alias = chosen if chosen in allowed else DEFAULT_DB_ALIAS
            request.session[ADMIN_DB_SESSION_KEY] = alias
        else:
            alias = request.session.get(ADMIN_DB_SESSION_KEY, DEFAULT_DB_ALIAS)
            if alias not in allowed:  # e.g. a project database dropped since
                alias = DEFAULT_DB_ALIAS
        if is_project_alias(alias):
            register_project_db(alias)
        return alias


class AccountMiddleware:
    """Binds every request to the default account (request.account). It is
    loaded lazily, on first access: requests that never read it - bot scans
    answered with a 404, static files - cost no database access."""

    def __init__(self, get_response):
        self.get_response = get_response

    @calc_runtime
    def __call__(self, request):
        '''
        _path = request.path
        if _path.startswith("/v1/device/"):
            #TODO
            pass
        elif _path.startswith("/v1/status/"):
            #TODO
            pass
        elif _path.startswith("/v1/"):
            account_id = get_account_id_from_url(_path)
            if account_id is None:
                return HttpResponse(f"Invalid Account-ID: {account_id}", status=403)
            try:
                account = Account.objects.get(id=account_id)
            except Account.DoesNotExist:
                return self.get_response(request)

            setattr(request, "account", account)
        '''
        db_name = "default" #TODO
        request.account = SimpleLazyObject(lambda: Account.objects.using(db_name).get(pk=1))
        return self.get_response(request)


class DemoReadOnlyMiddleware:
    """The public demo user (helper/demo.py) may look at everything the portal
    shows it, but never change anything: every non-GET request of that user
    is refused here, before any view runs - including the ones with side
    effects (request a measurement, test notifications, PDF report mails).
    The SPA authenticates with a JWT, which DRF only resolves inside the view,
    so the token is checked here as well. The response carries
    "demo_read_only", so the frontend shows a hint instead of a login page.

    Every demo request is also logged ("[DEMO]") with its duration and the
    queries per database of this thread - the demo must only touch "default"
    and the demo database; a slow one (> SLOW_MS) is logged as a warning.
    Fan-outs over the project databases run in worker threads (map_databases)
    and show up as time without queries here."""

    SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
    SLOW_MS = 1000
    # Session handling stays possible - also opening a demo link again while
    # the browser still sends the JWT of an earlier demo visit.
    ALLOWED_PATHS = ("/api/token/", "/v1/demo/login/")

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.method not in self.SAFE_METHODS and not request.path.startswith(self.ALLOWED_PATHS):
            from progeo.helper.demo import DEMO_WRITE_PATHS, is_demo_user

            if request.path not in DEMO_WRITE_PATHS and is_demo_user(self._user(request)):
                from django.http import JsonResponse

                return JsonResponse(
                    {"success": False, "reason": "Demo: changes are not saved", "demo_read_only": True},
                    status=403,
                )
        claims = self._demo_claims(request)
        if claims is not None:
            from progeo.helper.demo import (
                DEMO_HEARTBEAT_PATH,
                DEMO_SESSION_CLAIM,
                record_demo_request,
            )

            response = self._timed(request)
            if request.path != DEMO_HEARTBEAT_PATH:  # the heartbeat records itself
                record_demo_request(claims.get(DEMO_SESSION_CLAIM))
            return response
        return self.get_response(request)

    @staticmethod
    def _demo_claims(request):
        """The JWT's claims if it carries the signed `is_demo` claim, else
        None - no database access, so every other request pays nothing for
        the demo log and session."""
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header.startswith("Bearer "):
            return None
        from rest_framework_simplejwt.exceptions import TokenError
        from rest_framework_simplejwt.tokens import AccessToken

        try:
            token = AccessToken(header[len("Bearer "):])
        except TokenError:
            return None
        return token if token.get("is_demo") else None

    def _timed(self, request):
        import time
        from contextlib import ExitStack

        from progeo.helper.basics import ilog, wlog
        from progeo.helper.project_dbs import demo_alias

        stats = {}

        def counting(alias):
            def wrapper(execute, sql, params, many, context):
                started = time.perf_counter()
                try:
                    return execute(sql, params, many, context)
                finally:
                    count, seconds = stats.get(alias, (0, 0.0))
                    stats[alias] = (count + 1, seconds + time.perf_counter() - started)
            return wrapper

        started = time.perf_counter()
        with ExitStack() as stack:
            for alias in dict.fromkeys((DEFAULT_DB_ALIAS, demo_alias())):
                if alias in connections.settings:
                    stack.enter_context(connections[alias].execute_wrapper(counting(alias)))
            response = self.get_response(request)
        elapsed_ms = (time.perf_counter() - started) * 1000

        queries = ", ".join(
            f"{alias}={count} ({seconds * 1000:.0f} ms)" for alias, (count, seconds) in stats.items()
        ) or "none"
        message = (
            f"{request.method} {request.get_full_path()} -> {response.status_code} "
            f"in {elapsed_ms:.0f} ms | queries: {queries}"
        )
        (wlog if elapsed_ms > self.SLOW_MS else ilog)(message, tag="[DEMO]")
        return response

    @staticmethod
    def _user(request):
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated:
            return user
        from rest_framework.exceptions import AuthenticationFailed
        from rest_framework_simplejwt.authentication import JWTAuthentication
        from rest_framework_simplejwt.exceptions import InvalidToken, TokenError

        try:
            result = JWTAuthentication().authenticate(request)
        except (AuthenticationFailed, InvalidToken, TokenError):
            return None
        return result[0] if result else None


class PendingAccessMiddleware:
    """A user whose access request waits for staff review (helper/
    access_requests.py) sees nothing but the "being checked" panel: every
    request with such a JWT is refused here, except session handling and the
    own request's status. The JWT carries the signed `is_pending` claim, so
    other requests pay no database access; a claim that is outdated because
    the request was approved meanwhile is re-checked and let through.
    Pending users get no session and no Basic/DRF-token login (see
    CaseInsensitiveUsernameOrEmailBackend), so the JWT is the only way in."""

    # /v1/demo/login/: the panel offers the public demo (a separate demo user).
    ALLOWED_PATHS = ("/api/token/", "/api/auth-support/access-requests/", "/api/auth-support/login-link/",
                     "/auth/logout/", "/v1/demo/login/")

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if not request.path.startswith(self.ALLOWED_PATHS):
            user_id = self._pending_claim(request)
            if user_id is not None:
                from progeo.helper.access_requests import is_pending_user

                if is_pending_user(user_id):
                    from django.http import JsonResponse

                    return JsonResponse(
                        {"success": False, "reason": "Account pending review", "pending_review": True},
                        status=403,
                    )
        return self.get_response(request)

    @staticmethod
    def _pending_claim(request):
        """The user id of a valid JWT with `is_pending`, else None."""
        return PendingAccessMiddleware._claim(request, "is_pending")

    @staticmethod
    def _claim(request, claim):
        """The user id of a valid JWT whose `claim` is set, else None."""
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header.startswith("Bearer "):
            return None
        from rest_framework_simplejwt.exceptions import TokenError
        from rest_framework_simplejwt.tokens import AccessToken

        try:
            token = AccessToken(header[len("Bearer "):])
        except TokenError:
            return None
        return token.get("user_id") if token.get(claim) else None


class ImpersonationMiddleware:
    """JWTs a superuser got via "log in as" (StaffUserImpersonateView, signed
    claim `impersonator_id`) count only while that superuser still is an
    active one, may not change the target's credentials (password, 2FA,
    email) or administer users, and every change made with one is logged
    with both names. Here, not in an authentication class: many viewsets
    list simplejwt's JWTAuthentication themselves."""

    # Unsafe methods only - reading these stays possible.
    BLOCKED_PATHS = ("/v1/user/password/", "/v1/user/2fa/", "/v1/user/settings/", "/api/auth-support/staff/")
    SAFE_METHODS = ("GET", "HEAD", "OPTIONS")

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        claims = self._impersonation(request)
        if claims is not None:
            from django.contrib.auth.models import User
            from django.http import JsonResponse

            user_id, impersonator_id = claims
            impersonator = User.objects.using(DEFAULT_DB_ALIAS).filter(
                pk=impersonator_id, is_active=True, is_superuser=True,
            ).first()
            if impersonator is None:
                return JsonResponse({"success": False, "reason": "Impersonation ended"}, status=401)
            if request.method not in self.SAFE_METHODS:
                if request.path.startswith(self.BLOCKED_PATHS):
                    return JsonResponse(
                        {"success": False, "reason": "Not allowed while logged in as another user",
                         "impersonation": True},
                        status=403,
                    )
                from progeo.helper.basics import ilog

                ilog(f"{impersonator.username} as user {user_id}: {request.method} {request.path}",
                     tag="[IMPERSONATION]")
        return self.get_response(request)

    @staticmethod
    def _impersonation(request):
        """(user id, impersonator id) of a valid "log in as" JWT, else None."""
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header.startswith("Bearer "):
            return None
        from rest_framework_simplejwt.exceptions import TokenError
        from rest_framework_simplejwt.tokens import AccessToken

        try:
            token = AccessToken(header[len("Bearer "):])
        except TokenError:
            return None
        impersonator_id = token.get("impersonator_id")
        return (token.get("user_id"), impersonator_id) if impersonator_id is not None else None


class TwoFactorRequiredMiddleware:
    """With TWO_FACTOR_REQUIRED_FOR_STAFF, a staff member/superuser without
    2FA may only set it up: every request with a JWT carrying the signed
    `two_factor_setup_required` claim is refused, except session handling
    and the profile (/v1/user/ - where 2FA is set up). Like
    PendingAccessMiddleware, the claim spares other requests a database
    access and an outdated one (2FA set up meanwhile) is re-checked. The
    Django admin login refuses them itself (progeo/admin_login.py)."""

    ALLOWED_PATHS = ("/api/token/", "/v1/user/", "/auth/logout/")

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if not request.path.startswith(self.ALLOWED_PATHS):
            user_id = PendingAccessMiddleware._claim(request, "two_factor_setup_required")
            if user_id is not None:
                from django.contrib.auth.models import User

                from progeo.helper.two_factor import is_required

                if is_required(User.objects.using(DEFAULT_DB_ALIAS).filter(pk=user_id).first()):
                    from django.http import JsonResponse

                    return JsonResponse(
                        {"success": False, "reason": "Two-factor setup required", "two_factor_setup_required": True},
                        status=403,
                    )
        return self.get_response(request)
