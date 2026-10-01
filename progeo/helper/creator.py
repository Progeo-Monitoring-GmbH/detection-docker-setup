import os.path

from django.utils import timezone

from progeo.helper.basics import elog, okaylog
from progeo.v1.models import Durations, LimitedToken, MfSLog


def get_file_type(filename):
    _, file_extension = os.path.splitext(filename)
    return file_extension


def get_or_create_limited_token(account, user, duration: Durations, data: dict, purpose: str = ""):
    token, created = LimitedToken.objects.using(account.db_name).get_or_create(account=account, raw_data=data,
                                                                               purpose=purpose)
    if created:
        token.user_id = user.pk if user else None  # by id - see the database router
        okaylog(f"LimitedToken={token}", tag="[CREATED]")

    token.valid_until = timezone.now() + duration.value
    token.renew()
    token.generate_raw_hash_and_save(using=account.db_name)

    return token


def create_MfS_log(request):
    try:
        db = request.account.db_name
        url = request.get_full_path()
        files = []
        for file in request.FILES:
            _file = request.FILES.get(file)
            files.append({"name": str(_file)})

        if len(files):
            data = {"files": files}
        else:
            # A plain copy: request.data may be an immutable QueryDict.
            data = dict(request.data.items()) if hasattr(request.data, "items") else {}
        # Never store credentials in the audit log.
        data.pop("password", None)

        user = getattr(request, "user", None)
        MfSLog.objects.using(db).create(
            account=request.account,
            # By id: the router forbids assigning a User instance (default
            # DB) to a model of an account database.
            user_id=user.pk if user is not None and user.is_authenticated else None,
            url=url,
            data=data,
        )
    except Exception as e:
        elog("Failed Creating MfS-Log")
        elog(e)
