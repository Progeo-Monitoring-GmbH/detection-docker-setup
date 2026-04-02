import inspect
import os

from django.contrib.auth.models import User
from playwright.sync_api import expect

from progeo.v1.models import Account
from progeo.tests.settings import BASE_DIR


def called_from_function():
    return inspect.stack()[1][3]


def get_assert_file(_file):
    _path = os.path.join(BASE_DIR, "progeo", "tests", "asserts", _file)
    return os.path.exists(_path), _path


def get_expected_result(func, index) -> [bool, str]:
    return get_assert_file(f"{func}-{index}.json")


def check_for_loading(page):
    expect(page.get_by_test_id("rotating-lines-svg")).to_be_visible()
    expect(page.get_by_test_id("rotating-lines-svg")).not_to_be_visible()


def get_auth():
    return os.path.join("progeo", "tests", "auth.json")


def get_unit_tests_account_and_user():
    value = "unit_tests"
    account = Account.objects.get(db_name=value)
    user = User.objects.get(username=value)
    return account, user
