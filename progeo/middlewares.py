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
