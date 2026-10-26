"""AccountMiddleware loads request.account only on first access: bot scans
(/wallet.txt, /.env, ...) answered with a 404 must not touch the database."""
import pytest
from django.db import connections
from django.test import Client
from django.test.utils import CaptureQueriesContext

from progeo.v1.models import Account


@pytest.mark.django_db
def test_unknown_path_runs_no_query():
    with CaptureQueriesContext(connections["default"]) as queries:
        response = Client().get("/wallet-export.json")
    assert response.status_code == 404
    assert [q["sql"] for q in queries] == []


@pytest.mark.django_db
def test_request_account_is_the_default_account(rf):
    from progeo.middlewares import AccountMiddleware

    seen = {}
    AccountMiddleware(lambda request: seen.setdefault("account", request.account))(rf.get("/"))
    assert seen["account"].pk == 1
    assert seen["account"].db_name == Account.objects.using("default").get(pk=1).db_name
