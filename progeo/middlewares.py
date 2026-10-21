from django.db import DEFAULT_DB_ALIAS, connections

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
    using_db = "default"

    def __init__(self, get_response):
        self.get_response = get_response

    def process_view(self, request, view_func, view_args, view_kwargs):
        if hasattr(request, "account"):
            self.using_db = request.account.db_name
            print("process_view_pre_1", request.account, request.user, self.using_db)
            # print("process_view_pre_2", request.__dict__)

    def process_template_response(self, request, response):
        if hasattr(request, "account"):
            if request.user not in request.account.users.all():
                if request.get_full_path() != "/v1/0/account/":
                    pass
                    #elog("ERROR", request.user, request.account.users.all())
                    # return HttpResponse("Nice try...", status=406)

            print("process_template_response", request.account, request.user, self.using_db)
            # print("process_template_response", request.__dict__)

        return response

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
        account = Account.objects.using(db_name).get(pk=1)
        request.account = account
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
