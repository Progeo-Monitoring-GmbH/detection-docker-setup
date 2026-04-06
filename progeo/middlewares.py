from django.contrib import admin
from django.contrib.auth.models import User
from django.contrib.sessions.models import Session
from django.http import HttpResponse
from django.utils import timezone

from progeo.v1.admin import MultiDBModelAdmin
from progeo.v1.helper import get_account_id_from_url
from progeo.v1.models import Account
from progeo.decorator import calc_runtime
from progeo.helper.basics import elog, dlog
from progeo.settings import DEBUG


class AdminGetParamMiddleware:
    using_db = "dev_null"

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith("/aadmin/"):

            using_account = request.GET.get("using_account")
            user = None

            _session_key = request.session.session_key

            try:
                session = Session.objects.get(session_key=_session_key, expire_date__gt=timezone.now())
                _user_id = session.get_decoded().get("_auth_user_id")
                user = User.objects.get(pk=_user_id)
            except Session.DoesNotExist:
                pass

            dlog(f"user={user}, using_account={using_account}, session={_session_key}", active=DEBUG)

            if using_account:
                _filter = {"pk": using_account}
            else:
                _filter = {"db_name": request.GET.get("using_db", self.using_db)}

            accounts = Account.objects.filter(users=user, **_filter)
            if len(accounts):
                using_db = accounts[0].db_name
                if using_db == "db_name":
                    return HttpResponse("Account has default db_name!", status=403)
            else:
                using_db = "default"

            if using_db and using_db != "default":
                self.using_db = using_db
                admin.site.site_header = f'Admin | Database="{self.using_db}"'
                MultiDBModelAdmin.handle_register_custom(using_db)

            dlog(f"AdminGetParamMiddleware using_db={self.using_db}", tag="[MIDDLE]")

            setattr(request, "using_db", self.using_db)

        return self.get_response(request)


class AccountMiddleware:
    using_db = "dev_null"

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
                if request.get_full_path() != "/api/v1/0/account/":
                    elog("ERROR", request.user, request.account.users.all())
                    # return HttpResponse("Nice try...", status=406)

            print("process_template_response", request.account, request.user, self.using_db)
            # print("process_template_response", request.__dict__)

        return response

    @calc_runtime
    def __call__(self, request):
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
                account = Account.objects.get(id=0)

            setattr(request, "account", account)

        return self.get_response(request)
