import os
import re

import pytest
from playwright.sync_api import expect, Page

from progeo.v1.helper import get_frontend_url
from progeo.helper.basics import check_raise_config, read_json
from progeo.tests.helper import get_auth

test_credentials = [
    {"username": "demo", "password": "demo"},
    {"username": "", "password": "demo"},  # Empty username
    {"username": "demo", "password": ""},  # Empty password
    {"username": "a" * 256, "password": "demo"},  # Excessively long username
    {"username": "demo", "password": "a" * 256},  # Excessively long password
    {"username": "demo';--", "password": "demo"},  # SQL injection in username
    {"username": "demo", "password": "' OR '1'='1"},  # SQL injection in password
    {"username": "X" * 65000, "password": "X"},
    {"username": "<script>alert('XSS')</script>", "password": "demo"},  # XSS attempt in username
    {"username": "demo", "password": "<script>alert('XSS')</script>"},  # XSS attempt in password
]

BASE_URL = get_frontend_url()


def run_login(context, config, url) -> Page:
    page = context.new_page()
    page.goto(url)
    page.get_by_placeholder("Enter User").click()
    page.get_by_placeholder("Enter User").fill(config.get("username"))
    page.get_by_placeholder("Password").click()
    page.get_by_placeholder("Password").fill(config.get("password"))
    page.get_by_text("Login").click()
    return page


@pytest.mark.login
def test_login(playwright, reset_db):
    config = read_json(os.path.join("progeo", "tests", "config.json"))
    check_raise_config(["username", "password"], config)

    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(ignore_https_errors=True)

    page = run_login(context, config, BASE_URL)
    # check_for_loading(page)
    # page.screenshot(path="screenshot.png")

    expect(page.get_by_text(f"User: {config.get('username')}")).to_be_visible()
    context.storage_state(path=get_auth())

    # ---------------------
    page.close()
    context.close()
    browser.close()


@pytest.mark.parametrize("config", test_credentials)
def test_login_failed(config, playwright):
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(ignore_https_errors=True)

    page = run_login(context, config, BASE_URL)
    expect(page.get_by_text("Login failed!")).to_be_visible()

    # ---------------------
    page.close()
    context.close()
    browser.close()


# @pytest.mark.dev
@pytest.mark.django_db(transaction=True, databases=["unit_tests", "default"])
def test_only_admin_can_change_pw(playwright, admin_client, admin_user):
    url = "/api/v1/5/setup/change_pw/"
    user = "unit_tests"

    resp = admin_client.get(url)
    assert resp.status_code == 405

    resp = admin_client.post(url)
    assert resp.status_code == 400

    admin_user.is_admin = True
    admin_user.save()
    resp = admin_client.post(url)
    assert resp.status_code == 400
    assert resp.json().get("reason") == 'No user'

    resp = admin_client.post(url, {"user": user})
    assert resp.status_code == 200
    pw = resp.json().get("pw")
    assert pw

    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(ignore_https_errors=True)
    config = {"username": user, "password": pw}
    page = run_login(context, config, BASE_URL)

    expect(page.get_by_text(f"User: {config.get('username')}")).to_be_visible()

    # ---------------------
    page.close()
    context.close()
    browser.close()


@pytest.mark.django_db
def test_login_out(playwright):
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(ignore_https_errors=True, storage_state=get_auth())
    page = context.new_page()
    page.goto(BASE_URL)
    expect(page).to_have_url(re.compile(r".*/v1/5/overview"))
    page.get_by_text("Logout", exact=True).click()
    expect(page.get_by_text("Login")).to_be_visible()

    # ---------------------
    page.close()
    context.close()
    browser.close()
